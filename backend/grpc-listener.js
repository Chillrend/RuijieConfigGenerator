import http2 from 'http2';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import IORedis from 'ioredis';
import protobuf from 'protobufjs';
import { InfluxDB, Point } from '@influxdata/influxdb-client';
import { initDatabase, getDB } from './lib/db.js';
import { normalizePortName, shortPortName, getOpticalHealth } from './lib/ruijie-parser.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = parseInt(process.env.GRPC_PORT || '50051', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const INFLUX_URL = process.env.INFLUX_URL || 'http://localhost:8086';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN || 'ruijie-secret-fleet-token-12345';
const INFLUX_ORG = process.env.INFLUX_ORG || 'ruijie_fleet';
const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'switch_metrics';

// Binary path for gnmic dial-in helper
const GNMIC_PATH = process.env.GNMIC_PATH ||
  (fs.existsSync(path.join(__dirname, 'bin', 'gnmic'))
    ? path.join(__dirname, 'bin', 'gnmic')
    : (fs.existsSync('/home/chillrend/gnmic') ? '/home/chillrend/gnmic' : 'gnmic'));

let redis = null;
let writeApi = null;
let SubscribeResponse = null;

// In-memory switch telemetry states: ip -> state
const switchStates = new Map();
// Buffer for batch writing optical metrics to InfluxDB
let opticalBuffer = [];
// Throttle DB updates per switch
const lastDbUpdate = new Map();

function getSwitchState(ip) {
  if (!switchStates.has(ip)) {
    switchStates.set(ip, {
      mgmt_ip: ip,
      hostname: '',
      last_seen: new Date().toISOString(),
      interfaces: new Map(),
      optical: new Map(),
      lldp: new Map(),
      poe: new Map()
    });
  }
  return switchStates.get(ip);
}

function mapSpeedString(rawSpeed) {
  if (!rawSpeed) return 'Auto';
  const s = String(rawSpeed).toUpperCase();
  if (s.includes('10GB')) return '10G';
  if (s.includes('2500MB') || s.includes('2.5GB')) return '2.5G';
  if (s.includes('1GB') || s.includes('1000MB')) return '1000M';
  if (s.includes('100MB')) return '100M';
  if (s.includes('10MB')) return '10M';
  return rawSpeed;
}

/**
 * Flush batched optical telemetry to InfluxDB
 */
async function flushOpticalBuffer() {
  if (opticalBuffer.length === 0 || !writeApi) return;
  const pointsToWrite = opticalBuffer.splice(0, opticalBuffer.length);
  try {
    for (const item of pointsToWrite) {
      const point = new Point('optical_ddm')
        .tag('mgmt_ip', item.ip)
        .tag('hostname', item.hostname || item.ip)
        .tag('port', item.portShort || item.port)
        .floatField('rx_power', item.rxPower ?? 0)
        .floatField('tx_power', item.txPower ?? 0)
        .floatField('temperature', item.temperature ?? 0)
        .floatField('voltage', item.voltage ?? 0)
        .stringField('status', item.status || 'normal');

      writeApi.writePoint(point);
    }
    await writeApi.flush();
    console.log(`[InfluxDB] Batch flushed ${pointsToWrite.length} optical telemetry points.`);
  } catch (err) {
    console.warn('[InfluxDB] Flush error:', err.message);
  }
}

/**
 * Publish real-time state to Redis with short TTL to avoid OOM
 */
async function publishSwitchTelemetry(ip) {
  if (!redis) return;
  const state = switchStates.get(ip);
  if (!state) return;

  const telemetryPayload = {
    mgmt_ip: ip,
    hostname: state.hostname,
    last_seen: new Date().toISOString(),
    telemetry_source: 'grpc',
    interfaces: Array.from(state.interfaces.values()),
    optical: Array.from(state.optical.values()),
    lldp: Array.from(state.lldp.values()),
    poe: Array.from(state.poe.values())
  };

  try {
    // 3600-second TTL on telemetry snapshot: prevents Redis OOM while retaining live state across hiccups
    await redis.set(`sw:${ip}:telemetry`, JSON.stringify(telemetryPayload), 'EX', 3600);
    // Notify WebSocket subscribers via Redis Pub/Sub
    await redis.publish('switch:telemetry:update', JSON.stringify({ ip, timestamp: Date.now() }));
  } catch (err) {
    console.warn(`[Redis] Error saving telemetry for ${ip}:`, err.message);
  }

  // Throttle DB status update to at most once per 60s per switch (only once interfaces are known)
  const now = Date.now();
  const lastUpdate = lastDbUpdate.get(ip) || 0;
  if (state.interfaces.size > 0 && (!lastUpdate || now - lastUpdate > 60000)) {
    lastDbUpdate.set(ip, now);
    try {
      const db = getDB();
      if (db) {
        const sw = await db.get('SELECT ports_json, lldp_json, optical_json FROM switches WHERE mgmt_ip = ?', [ip]);
        let existingPorts = [];
        try { existingPorts = JSON.parse(sw?.ports_json || '[]'); } catch (e) {}

        // Overlay live operational state onto ports
        if (existingPorts.length > 0) {
          for (const p of existingPorts) {
            const liveIf = state.interfaces.get(p.name) || state.interfaces.get(p.shortName);
            if (liveIf) {
              p.operStatus = liveIf.operStatus || p.operStatus;
              if (liveIf.speed && liveIf.speed.toLowerCase() !== 'auto') {
                p.speed = liveIf.speed;
              }
              if (liveIf.duplex && liveIf.duplex.toLowerCase() !== 'auto') {
                p.duplex = liveIf.duplex;
              }
            }
            const livePoe = state.poe.get(p.name) || state.poe.get(p.shortName);
            if (livePoe) {
              p.poeStatus = livePoe.powerStatus || p.poeStatus;
              p.poePower = livePoe.watt || 0;
              p.poePowerStr = livePoe.currPower || `${livePoe.watt}W`;
            }
          }
        } else if (state.interfaces.size > 0) {
          existingPorts = Array.from(state.interfaces.values());
        }

        const finalLldp = state.lldp.size > 0 ? Array.from(state.lldp.values()) : (sw?.lldp_json ? JSON.parse(sw.lldp_json) : []);
        let finalOptical = state.optical.size > 0 ? Array.from(state.optical.values()) : (sw?.optical_json ? JSON.parse(sw.optical_json) : []);
        if (finalOptical.length === 0 && existingPorts.length > 0) {
          finalOptical = existingPorts.filter(p => p.optical && p.optical.status !== 'absent').map(p => p.optical);
        }

        await db.run(
          `UPDATE switches SET
            status = 'online',
            telemetry_mode = 'grpc',
            grpc_status = 'connected',
            ports_json = ?,
            lldp_json = ?,
            optical_json = ?,
            last_seen = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
           WHERE mgmt_ip = ?`,
          [
            JSON.stringify(existingPorts),
            JSON.stringify(finalLldp),
            JSON.stringify(finalOptical),
            ip
          ]
        );
      }
    } catch (e) {
      // Ignore DB write warning
    }
  }
}

/**
 * Process parsed JSON payload from OpenConfig gNMI stream
 */
function handleOpenConfigData(ip, pathName, json) {
  const state = getSwitchState(ip);
  state.last_seen = new Date().toISOString();

  // 1. Interfaces (supports both openconfig-interfaces and rg-interfaces with PoE & LLDP augmentations)
  const rawIfList = json['interface'] || json['rg-interfaces:interfaces']?.interface || json['interfaces']?.interface;
  if (pathName.includes('interfaces') && rawIfList && Array.isArray(rawIfList)) {
    for (const iface of rawIfList) {
      if (!iface.name || /^vlan|^vl\d+|^lo|^null/i.test(iface.name)) continue;
      const rawName = iface.name;
      const norm = normalizePortName(rawName);
      const short = shortPortName(norm);

      // Extract PoE augmentation if present (rg-poe inside rg-interfaces)
      const poeStateContainer = iface['rg-poe:poe-port-state'] || iface['poe-port-state'];
      if (poeStateContainer) {
        const poeState = Array.isArray(poeStateContainer.state) ? poeStateContainer.state[0] : (poeStateContainer.state || poeStateContainer);
        if (poeState) {
          const milliwatt = parseFloat(poeState['consumption-power']) || 0;
          const watt = Math.round(milliwatt / 100) / 10;
          const isEnabled = poeState.enable !== false;
          state.poe.set(norm, {
            port: norm,
            portShort: short,
            powerControl: isEnabled ? 'enable' : 'disable',
            powerStatus: watt > 0 ? 'on' : (isEnabled ? 'enable' : 'off'),
            currPower: `${watt}W`,
            watt,
            milliwatt
          });
        }
      }

      // Extract LLDP augmentation if present in rg-interfaces
      const lldpPort = iface['rg-lldp:lldp-port'] || iface['lldp-port'];
      if (lldpPort?.neighbors?.neighbor) {
        const nList = Array.isArray(lldpPort.neighbors.neighbor) ? lldpPort.neighbors.neighbor : [lldpPort.neighbors.neighbor];
        for (const n of nList) {
          const remoteDevice = (n['system-name'] || n['system-description'] || '').split('\n')[0].trim();
          const remotePort = n['port-id'] || n['port-description'] || '';
          const isUplink = /TenGigabit|TwentyFive|Forty|Hundred|TF|switch|core|agg/i.test(remoteDevice) ||
                           /Te|TF|25G|40G|100G/i.test(rawName);
          state.lldp.set(norm, {
            localPort: norm,
            localPortShort: short,
            remoteDevice: remoteDevice || 'Unknown Device',
            remotePort,
            remotePortDesc: n['port-description'] || '',
            managementIp: n['ip'] || '',
            isUplink
          });
        }
      }

      const existingIf = state.interfaces.get(norm);

      // Only openconfig-interfaces provides true link physical status in iface.state['oper-status'].
      // rg-interfaces has iface.enable (administrative status), which must NOT overwrite link oper-status!
      let operStatus = existingIf?.operStatus || 'down';
      if (iface.state?.['oper-status']) {
        operStatus = iface.state['oper-status'].toLowerCase();
      }

      const adminStatus = (iface.state?.['admin-status'] || (iface.enable !== false ? 'UP' : 'DOWN')).toUpperCase();

      // Negotiated link speed comes from openconfig-interfaces ethernet state.
      // rg-interfaces sends configured 'speed: auto', which must NEVER overwrite a negotiated link speed!
      let speed = existingIf?.speed || 'Auto';
      const ocSpeed = iface.ethernet?.state?.['port-speed'] || iface.ethernet?.config?.['port-speed'];
      if (ocSpeed) {
        speed = mapSpeedString(ocSpeed);
      } else if (iface.speed && iface.speed.toLowerCase() !== 'auto') {
        speed = mapSpeedString(iface.speed);
      }

      // Duplex: operational duplex from openconfig ethernet state/config; rg-interfaces sends 'auto'
      let duplex = existingIf?.duplex || 'Full';
      const ocDuplex = iface.ethernet?.config?.['duplex-mode'] || iface.ethernet?.state?.['duplex-mode'];
      if (ocDuplex) {
        duplex = ocDuplex;
      } else if (iface.duplex && iface.duplex.toLowerCase() !== 'auto') {
        duplex = iface.duplex;
      }

      const description = iface.config?.description || iface.state?.description || iface.description || existingIf?.description || '';
      const switchedVlan = iface.ethernet?.['switched-vlan']?.config || {};
      const mode = (switchedVlan['interface-mode'] || (iface['rg-bridge:swport']?.mode === 1 ? 'access' : (existingIf?.mode || 'access'))).toLowerCase();
      const vlan = String(switchedVlan['native-vlan'] || iface['rg-bridge:swport']?.pvid || existingIf?.vlan || '1');
      const allowed_vlans = Array.isArray(switchedVlan['trunk-vlans']) ? switchedVlan['trunk-vlans'].join(',') : (existingIf?.allowed_vlans || 'all');

      const counters = iface.state?.counters || existingIf?.counters || {};

      state.interfaces.set(norm, {
        name: norm,
        shortName: short,
        operStatus,
        adminStatus,
        speed,
        duplex,
        description,
        mode,
        vlan,
        allowed_vlans,
        counters: {
          inOctets: counters['in-octets'] || '0',
          outOctets: counters['out-octets'] || '0',
          inPkts: counters['in-unicast-pkts'] || '0',
          outPkts: counters['out-unicast-pkts'] || '0',
          inErrors: counters['in-errors'] || '0',
          outErrors: counters['out-errors'] || '0',
          inDiscards: counters['in-discards'] || '0',
          outDiscards: counters['out-discards'] || '0'
        }
      });
    }
    publishSwitchTelemetry(ip);
  }

  // 2. Optical transceiver components
  if (pathName.includes('components') || pathName.includes('transceiver')) {
    const rawComps = json['openconfig-platform:components']?.component ||
                     json['components']?.component ||
                     json['component'] ||
                     (json['state'] && [json]) ||
                     (json['name'] && [json]) || [];
    const components = Array.isArray(rawComps) ? rawComps : [rawComps];
    const PORT_NAME_REGEX = /^(?:MTGigabitEthernet|MTGi|GigabitEthernet|Gi|TenGigabitEthernet|Te|TFGigabitEthernet|TF|TwentyFiveGigabitEthernet|25G|FortyGigabitEthernet|Fo|HundredGigabitEthernet|Hu|FastEthernet|Fa|AggregatePort|Ag)\s*\d/i;

    for (const comp of components) {
      const portName = comp.name || (comp.config && comp.config.name);
      if (!portName) continue;

      const norm = normalizePortName(portName);
      const short = shortPortName(norm);

      // Only process physical port components; skip Slot 0, Chassis, FAN, Power Supply, etc.
      if (!PORT_NAME_REGEX.test(portName) && !PORT_NAME_REGEX.test(norm) && !PORT_NAME_REGEX.test(short)) {
        continue;
      }

      const trans = comp.transceiver?.state || comp.transceiver;
      const vendorStr = (trans?.vendor || '').trim();
      const partStr = (trans?.['vendor-part'] || trans?.partNumber || '').trim();
      const snStr = (trans?.['serial-no'] || trans?.serialNumber || '').trim();
      const formFactor = (trans?.['form-factor'] || '').trim();

      // Transceiver is only present if it has manufacturer identification (vendor/part/SN/form-factor)
      // or valid non-zero optical power readings. Otherwise it is an empty/unpopulated SFP cage.
      const hasModule = trans && (
        vendorStr !== '' ||
        partStr !== '' ||
        snStr !== '' ||
        (formFactor !== '' && formFactor !== 'UNKNOWN') ||
        (trans['input-power']?.instant !== undefined && trans['input-power'].instant !== null && !isNaN(parseFloat(trans['input-power'].instant)))
      );

      if (!hasModule) {
        // Module absent from cage
        state.optical.set(norm, {
          port: norm,
          portShort: short,
          vendor: '',
          partNumber: '',
          transceiverType: '',
          wavelength: '',
          serialNumber: '',
          temperature: null,
          voltage: null,
          biasCurrent: null,
          rxPower: null,
          txPower: null,
          status: 'absent'
        });
        continue;
      }

      const rx = trans['input-power']?.instant !== undefined ? parseFloat(trans['input-power'].instant) :
                 (trans['input-power'] !== undefined && typeof trans['input-power'] === 'number' ? trans['input-power'] : null);
      const tx = trans['output-power']?.instant !== undefined ? parseFloat(trans['output-power'].instant) :
                 (trans['output-power'] !== undefined && typeof trans['output-power'] === 'number' ? trans['output-power'] : null);
      const temp = comp.state?.temperature?.instant !== undefined ? parseFloat(comp.state.temperature.instant) :
                   (trans.temperature?.instant !== undefined ? parseFloat(trans.temperature.instant) : null);
      const volt = trans.voltage?.instant !== undefined ? parseFloat(trans.voltage.instant) : null;
      const bias = trans['laser-bias-current']?.instant !== undefined ? parseFloat(trans['laser-bias-current'].instant) : null;
      const vendor = (trans.vendor || '').trim();
      const partNumber = (trans['vendor-part'] || trans.partNumber || '').trim();
      const serialNumber = (trans['serial-no'] || trans.serialNumber || '').trim();

      // If module is inserted but provides no optical metrics (rx, tx, temp, volt), DDM is unsupported
      let status = 'normal';
      const hasDdmMetrics = (rx !== null && !isNaN(rx)) || (tx !== null && !isNaN(tx)) || (temp !== null && !isNaN(temp)) || (volt !== null && !isNaN(volt)) || (bias !== null && !isNaN(bias));

      if (!hasDdmMetrics) {
        status = 'no_ddm';
      } else if (rx === null || isNaN(rx)) {
        status = 'no_signal';
      } else {
        status = getOpticalHealth(rx);
      }

      const opticalItem = {
        port: norm,
        portShort: short,
        vendor,
        partNumber,
        serialNumber,
        rxPower: rx,
        txPower: tx,
        temperature: temp,
        voltage: volt,
        biasCurrent: bias,
        status
      };

      state.optical.set(norm, opticalItem);

      if (rx !== null || tx !== null || temp !== null) {
        opticalBuffer.push({
          ip,
          hostname: state.hostname,
          ...opticalItem
        });
      }
    }
    publishSwitchTelemetry(ip);
  }

  // 3. LLDP topology
  if (pathName.includes('lldp') && json.interfaces?.interface) {
    for (const iface of json.interfaces.interface) {
      const portName = iface.name;
      if (!portName) continue;
      const norm = normalizePortName(portName);
      const short = shortPortName(norm);

      const neighbors = iface.neighbors?.neighbor || [];
      for (const n of neighbors) {
        const nState = n.state || {};
        const remoteDevice = (nState['system-name'] || nState['system-description'] || '').split('\n')[0].trim();
        const remotePort = nState['port-id'] || '';
        const remotePortDesc = nState['port-description'] || '';
        const mgmtIp = nState['management-address'] || '';
        const isUplink = /TenGigabit|TwentyFive|Forty|Hundred|TF|switch|core|agg/i.test(remoteDevice) ||
                         /Te|TF|25G|40G|100G/i.test(portName);

        state.lldp.set(norm, {
          localPort: norm,
          localPortShort: short,
          remoteDevice: remoteDevice || 'Unknown Device',
          remotePort,
          remotePortDesc,
          managementIp: mgmtIp,
          isUplink
        });
      }
    }
    publishSwitchTelemetry(ip);
  }
}

/**
 * Periodically poll PoE status via gNMI dial-in since dial-out does not emit PoE
 */
async function pollPoeDialIn() {
  const db = getDB();
  if (!db || !fs.existsSync(GNMIC_PATH)) return;

  try {
    const switches = await db.all(
      "SELECT id, mgmt_ip, admin_username, admin_password, ports_json FROM switches WHERE telemetry_mode = 'grpc'"
    );

    await Promise.allSettled(
      switches.map(async (sw) => {
        const state = getSwitchState(sw.mgmt_ip);

        // Dynamically discover valid copper PoE ports (prevents querying invalid ports which causes Ruijie to abort the batch)
        const poePorts = [];
        if (state.interfaces.size > 0) {
          for (const iface of state.interfaces.values()) {
            if (/^Gi\d+\/\d+|^GigabitEthernet\s*\d+\/\d+/i.test(iface.name)) {
              poePorts.push(iface.shortName || iface.name);
            }
          }
        }

        if (poePorts.length === 0) {
          let ports = [];
          try { ports = JSON.parse(sw.ports_json || '[]'); } catch (e) {}
          for (const p of ports) {
            if (!p.isUplink && (/^Gi/i.test(p.shortName || p.name) || /^GigabitEthernet/i.test(p.name))) {
              poePorts.push(p.shortName || p.name);
            }
          }
        }

        // If no ports known yet, default safely to 1..12
        if (poePorts.length === 0) {
          for (let i = 1; i <= 12; i++) poePorts.push(`Gi0/${i}`);
        }

        const pathArgs = [];
        for (const p of poePorts) {
          const short = shortPortName(p);
          pathArgs.push('--path', `/rg-interfaces:interfaces/interface[name=${short}]/rg-poe:poe-port-state`);
        }

        const args = [
          '-a', `${sw.mgmt_ip}:50052`,
          '-u', sw.admin_username || 'admin',
          '-p', sw.admin_password || '',
          '--insecure',
          '--timeout', '4s',
          'get',
          ...pathArgs
        ];

        try {
          const { stdout } = await execFileAsync(GNMIC_PATH, args, { timeout: 6000 });
          const parsed = JSON.parse(stdout);

          for (const item of parsed) {
            const updates = item.updates || [];
            for (const upd of updates) {
              const pathStr = upd.Path || '';
              const portMatch = pathStr.match(/name=([^\]]+)/i);
              if (!portMatch) continue;
              const normPort = normalizePortName(portMatch[1].trim());
              const shortPort = shortPortName(normPort);

              const actualKey = Object.keys(upd.values || {}).find(k => k.includes('poe-port-state'));
              const poeContainer = upd.values?.[actualKey] || Object.values(upd.values || {})[0];
              const poeState = poeContainer?.state?.[0] || poeContainer?.state || poeContainer;

              if (poeState) {
                const milliwatt = poeState['consumption-power'] || 0;
                const watt = Math.round(milliwatt / 100) / 10;
                const powerStatus = poeState['power-status'] || 'off';
                const isEnabled = poeState.enable !== false;

                state.poe.set(normPort, {
                  port: normPort,
                  portShort: shortPort,
                  powerControl: isEnabled ? 'enable' : 'disable',
                  powerStatus,
                  currPower: `${watt}W`,
                  watt,
                  milliwatt
                });
              }
            }
          }
          await publishSwitchTelemetry(sw.mgmt_ip);
        } catch (gnmicErr) {
          // Switch gRPC server may not be up yet
        }
      })
    );
  } catch (err) {
    console.warn('[PoE Poller] Error in periodic PoE dial-in:', err.message);
  }
}

/**
 * Start the gRPC Dial-Out HTTP/2 Server
 */
export async function startGrpcListener() {
  console.log('[gRPC Listener] Initializing services...');
  await initDatabase();

  // Load Protobuf schema
  const protoFile = path.join(__dirname, 'proto', 'gnmi.proto');
  const root = await protobuf.load(protoFile);
  SubscribeResponse = root.lookupType('gnmi.SubscribeResponse');
  console.log('[gRPC Listener] Compiled gNMI protobuf definitions.');

  // Redis client
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  redis.on('connect', () => console.log(`[gRPC Listener] Connected to Redis at ${REDIS_URL}`));
  redis.on('error', (e) => console.warn('[gRPC Listener] Redis error:', e.message));

  // InfluxDB client
  try {
    const influx = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN, timeout: 3000 });
    writeApi = influx.getWriteApi(INFLUX_ORG, INFLUX_BUCKET, 'ms');
    console.log(`[gRPC Listener] InfluxDB client configured for ${INFLUX_URL}`);
  } catch (e) {
    console.warn('[gRPC Listener] InfluxDB configuration notice:', e.message);
  }

  // HTTP/2 Server for gRPC
  const server = http2.createServer();

  server.on('stream', (stream, headers) => {
    const rpcPath = headers[':path'];
    let clientIp = stream.session.socket.remoteAddress || '';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.substring(7);

    if (rpcPath !== '/gnmi.sonic.gNMIDialOut/Publish') {
      console.log(`[gRPC Listener] Unhandled RPC path: ${rpcPath} from ${clientIp}`);
      stream.respond({ ':status': 404 });
      stream.end();
      return;
    }

    console.log(`[gRPC Listener] Switch connected: ${clientIp} (${rpcPath})`);

    // Acknowledge gRPC call with HTTP 200
    stream.respond({
      ':status': 200,
      'content-type': 'application/grpc'
    });

    let pending = Buffer.alloc(0);

    stream.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      // gRPC framing: 1 byte compressed flag, 4 bytes message length
      while (pending.length >= 5) {
        const msgLen = pending.readUInt32BE(1);
        if (pending.length >= 5 + msgLen) {
          const frame = pending.subarray(5, 5 + msgLen);
          pending = pending.subarray(5 + msgLen);

          try {
            const decoded = SubscribeResponse.decode(frame);
            const update = decoded.update;
            if (update) {
              const prefix = update.prefix?.elem?.map((e) => e.name).join('/') || '';
              for (const u of update.update || []) {
                const subPath = u.path?.elem?.map((e) => e.name).join('/') || '';
                const fullPath = (prefix ? prefix + '/' : '') + subPath;

                const jsonBytes = u.val?.jsonVal || u.val?.jsonIetfVal;
                if (jsonBytes) {
                  try {
                    const parsedJson = JSON.parse(Buffer.from(jsonBytes).toString('utf8'));
                    handleOpenConfigData(clientIp, fullPath, parsedJson);
                  } catch (jsonErr) {
                    // Ignore non-json payload
                  }
                }
              }
            }
          } catch (decodeErr) {
            console.warn(`[gRPC Listener] Decode error from ${clientIp}:`, decodeErr.message);
          }
        } else {
          break;
        }
      }
    });

    stream.on('close', () => {
      console.log(`[gRPC Listener] Stream closed for switch ${clientIp}`);
    });

    stream.on('error', (err) => {
      console.warn(`[gRPC Listener] Stream error for switch ${clientIp}:`, err.message);
    });
  });

  server.on('error', (err) => {
    console.error('[gRPC Listener] Server error:', err.message);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(` gRPC Dial-Out Telemetry Listener running on :${PORT}`);
    console.log(` Listening for /gnmi.sonic.gNMIDialOut/Publish streams`);
    console.log(`=======================================================`);
  });

  // Background workers:
  // 1. InfluxDB batch flush every 15 seconds
  setInterval(flushOpticalBuffer, 15000);
  // 2. PoE dial-in query every 30 seconds
  setInterval(pollPoeDialIn, 30000);
  // Initial PoE poll after 5 seconds
  setTimeout(pollPoeDialIn, 5000);
}

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].endsWith('grpc-listener.js')) {
  startGrpcListener().catch((err) => {
    console.error('[gRPC Listener] Fatal startup error:', err);
    process.exit(1);
  });
}
