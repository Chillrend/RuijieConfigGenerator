import net from 'net';
import { getDB } from './db.js';
import { runSshSession } from './ssh.js';
import {
  parseRunningConfig,
  parseInterfacesStatus,
  parseTransceiverDDM,
  parseTransceiverManuinfo,
  parsePoeInterfacesStatus,
  parseLLDPNeighbors,
  parseShowVersion,
  extractCommandOutput,
  normalizePortName,
  shortPortName
} from './ruijie-parser.js';
import { recordOpticalMetrics } from './influx.js';
import { getRedis } from './redis.js';

// Fast TCP connectivity check before SSH
function checkTcpPort(host, port = 22, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let status = false;

    socket.setTimeout(timeout);
    socket.once('connect', () => {
      status = true;
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Poll a single switch by ID
 */
export async function pollSwitch(switchId) {
  const db = getDB();
  const sw = await db.get('SELECT * FROM switches WHERE id = ?', [switchId]);
  if (!sw) throw new Error(`Switch ID ${switchId} not found`);

  console.log(`[Poller] Polling switch ${sw.hostname || sw.mgmt_ip} (${sw.mgmt_ip})...`);

  // 1. Check TCP reachability
  const isPort22Open = await checkTcpPort(sw.mgmt_ip, 22, 3500);
  if (!isPort22Open) {
    console.log(`[Poller] Switch ${sw.mgmt_ip} is unreachable on port 22`);
    await db.run(
      'UPDATE switches SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['offline', switchId]
    );
    return { switchId, status: 'offline' };
  }

  // 2. Execute SSH inspection commands
  try {
    const redis = getRedis();
    let liveTelemetry = null;
    try {
      const liveRaw = await redis.get(`sw:${sw.mgmt_ip}:telemetry`);
      if (liveRaw) {
        liveTelemetry = JSON.parse(liveRaw);
      }
    } catch (e) {}

    const hasLiveTelemetry = !!(liveTelemetry && Array.isArray(liveTelemetry.interfaces) && liveTelemetry.interfaces.length > 0);
    const hasLiveOptical = !!(liveTelemetry && Array.isArray(liveTelemetry.optical) && liveTelemetry.optical.length > 0);
    const hasLivePoe = !!(liveTelemetry && Array.isArray(liveTelemetry.poe) && liveTelemetry.poe.length > 0);
    const hasLiveLldp = !!(liveTelemetry && Array.isArray(liveTelemetry.lldp) && liveTelemetry.lldp.length > 0);

    const isGrpcActive = sw.telemetry_mode === 'grpc' && hasLiveTelemetry;

    // Adaptive commands: minimize switch CPU & SSH encryption load
    // If gRPC actively delivers optical, PoE, or LLDP, skip their heavy SSH scraping!
    const commands = ['show version'];
    if (!isGrpcActive) {
      commands.push('show interfaces status');
    }
    if (!isGrpcActive || !hasLiveOptical) {
      commands.push('show interfaces transceiver', 'show interfaces transceiver manuinfo');
    }
    if (!isGrpcActive || !hasLivePoe) {
      commands.push('show poe interfaces status');
    }
    if (!isGrpcActive || !hasLiveLldp) {
      commands.push('show lldp neighbors detail');
    }
    commands.push('show running-config');

    const rawOutput = await runSshSession(
      sw.mgmt_ip,
      {
        username: sw.admin_username || 'admin',
        password: sw.admin_password || '',
        enablePassword: sw.enable_password || sw.admin_password || '',
        timeout: 25000
      },
      commands
    );

    // 3. Extract and parse isolated command outputs
    const rawVersion = extractCommandOutput(rawOutput, 'show version');
    const rawConfig = extractCommandOutput(rawOutput, 'show running-config');
    const rawStatus = !isGrpcActive ? extractCommandOutput(rawOutput, 'show interfaces status') : '';
    const rawTrans = (!isGrpcActive || !hasLiveOptical) ? extractCommandOutput(rawOutput, 'show interfaces transceiver') : '';
    const rawManu = (!isGrpcActive || !hasLiveOptical) ? extractCommandOutput(rawOutput, 'show interfaces transceiver manuinfo') : '';
    const rawPoe = (!isGrpcActive || !hasLivePoe) ? extractCommandOutput(rawOutput, 'show poe interfaces status') : '';
    const rawLldp = (!isGrpcActive || !hasLiveLldp) ? extractCommandOutput(rawOutput, 'show lldp neighbors detail') : '';

    const ver = parseShowVersion(rawVersion || rawOutput);
    const ifStatuses = !isGrpcActive ? parseInterfacesStatus(rawStatus || rawOutput) : [];
    const manuinfo = (!isGrpcActive || !hasLiveOptical) ? parseTransceiverManuinfo(rawManu || rawOutput) : new Map();
    const ddm = (!isGrpcActive || !hasLiveOptical) ? parseTransceiverDDM(rawTrans || rawOutput, manuinfo) : (liveTelemetry?.optical || []);
    const poeStatuses = (!isGrpcActive || !hasLivePoe) ? parsePoeInterfacesStatus(rawPoe || rawOutput) : (liveTelemetry?.poe || []);
    const lldp = (!isGrpcActive || !hasLiveLldp) ? parseLLDPNeighbors(rawLldp || rawOutput) : (liveTelemetry?.lldp || (sw.lldp_json ? JSON.parse(sw.lldp_json) : []));
    const configParsed = parseRunningConfig(rawConfig || rawOutput);

    // Switch is in gRPC mode only if live telemetry is confirmed active; otherwise falls back to SSH
    const finalTelemetryMode = hasLiveTelemetry ? 'grpc' : 'ssh';

    // Build map of interface status
    const statusMap = new Map();
    for (const st of ifStatuses) {
      statusMap.set(st.port, st);
      statusMap.set(st.portShort, st);
      const match = st.port.match(/\/(\d+)$/);
      if (match) statusMap.set(match[1], st);
    }

    // Build map of optical DDM
    const ddmMap = new Map();
    for (const d of ddm) {
      ddmMap.set(d.port, d);
      ddmMap.set(d.portShort, d);
    }

    // Build map of PoE operational status
    const poeMap = new Map();
    for (const p of poeStatuses) {
      poeMap.set(p.port, p);
      poeMap.set(p.portShort, p);
      const match = p.port.match(/\/(\d+)$/);
      if (match) poeMap.set(match[1], p);
    }

    // Build map of LLDP uplinks
    const lldpMap = new Map();
    for (const n of lldp) {
      lldpMap.set(n.localPort, n);
      lldpMap.set(n.localPortShort, n);
    }

    // Build map of previous port states to prevent transient empty scrapes from wiping data
    const prevPortMap = new Map();
    try {
      const prevPorts = sw.ports_json ? JSON.parse(sw.ports_json) : [];
      for (const p of prevPorts) {
        prevPortMap.set(p.name, p);
        prevPortMap.set(p.shortName, p);
      }
    } catch (e) {}

    // Combine configured interfaces with real-time operational status
    const combinedPorts = [];
    const configuredInterfaces = Object.keys(configParsed.interfaces).filter(name => !/^vlan/i.test(name));

    // If configured interfaces found in running config, merge with live telemetry
    if (configuredInterfaces.length > 0) {
      for (const name of configuredInterfaces) {
        const portConf = configParsed.interfaces[name];
        const shortName = shortPortName(name);
        const match = name.match(/\/(\d+)$/);
        const portNum = match ? parseInt(match[1], 10) : combinedPorts.length + 1;

        const prevP = prevPortMap.get(name) || prevPortMap.get(shortName);
        const liveStatus = statusMap.get(name) || statusMap.get(shortName) || statusMap.get(String(portNum)) || {};
        const liveDdm = ddmMap.get(name) || ddmMap.get(shortName) || prevP?.optical || null;
        const liveLldp = lldpMap.get(name) || lldpMap.get(shortName) || (prevP?.uplinkNeighbor ? { remoteDevice: prevP.uplinkNeighbor, remotePort: prevP.uplinkNeighborPort, isUplink: prevP.isUplink } : null);
        const livePoe = poeMap.get(name) || poeMap.get(shortName) || poeMap.get(String(portNum)) || (prevP?.poeStatus && prevP.poeStatus !== 'off' ? { powerStatus: prevP.poeStatus, watt: prevP.poePower, currPower: prevP.poePowerStr, pdClass: prevP.poePdClass, voltage: prevP.poeVoltage, powerControl: prevP.poeMode } : null);

        const isUplinkPort = liveLldp?.isUplink || /TenGigabit|TwentyFive|Forty|Hundred|TF/i.test(name);
        const effectivePoeMode = portConf.poeMode !== 'default'
          ? portConf.poeMode
          : (livePoe?.powerControl === 'disable' ? 'disabled' : 'default');

        combinedPorts.push({
          id: portNum,
          name,
          shortName,
          description: portConf.description || '',
          mode: portConf.mode || 'access',
          vlan: portConf.vlan || '1',
          allowed_vlans: portConf.allowed_vlans || 'all',
          native_vlan: portConf.native_vlan || '',
          poeMode: effectivePoeMode,
          poePriority: portConf.poePriority || 'default',
          poeMaxPower: portConf.poeMaxPower || '',
          poeStatus: livePoe ? livePoe.powerStatus : 'off',
          poePower: livePoe ? livePoe.watt : 0,
          poePowerStr: livePoe ? livePoe.currPower : '',
          poePdClass: livePoe ? livePoe.pdClass : '',
          poeVoltage: livePoe ? livePoe.voltage : '',
          aggregatePort: portConf.aggregatePort || null,
          aggregateGroupId: portConf.aggregateGroupId || null,
          shutdown: portConf.shutdown || false,
          unmanaged_lines: portConf.unmanaged_lines || [],
          // Live operational state
          operStatus: liveStatus.status || (portConf.shutdown ? 'disabled' : 'down'),
          speed: liveStatus.speed || 'Auto',
          duplex: liveStatus.duplex || 'Auto',
          mediaType: liveStatus.mediaType || '',
          isUplink: isUplinkPort,
          uplinkNeighbor: liveLldp ? liveLldp.remoteDevice : null,
          uplinkNeighborPort: liveLldp ? liveLldp.remotePort : null,
          optical: liveDdm
        });
      }
    } else {
      // Fallback: build from interface status table
      for (const st of ifStatuses) {
        const prevP = prevPortMap.get(st.port) || prevPortMap.get(st.portShort);
        const liveDdm = ddmMap.get(st.port) || ddmMap.get(st.portShort) || prevP?.optical || null;
        const liveLldp = lldpMap.get(st.port) || lldpMap.get(st.portShort) || (prevP?.uplinkNeighbor ? { remoteDevice: prevP.uplinkNeighbor, remotePort: prevP.uplinkNeighborPort, isUplink: prevP.isUplink } : null);
        const livePoe = poeMap.get(st.port) || poeMap.get(st.portShort) || (prevP?.poeStatus && prevP.poeStatus !== 'off' ? { powerStatus: prevP.poeStatus, watt: prevP.poePower, currPower: prevP.poePowerStr, pdClass: prevP.poePdClass, voltage: prevP.poeVoltage, powerControl: prevP.poeMode } : null);
        const match = st.port.match(/\/(\d+)$/);
        const portNum = match ? parseInt(match[1], 10) : combinedPorts.length + 1;
        const isUplinkPort = liveLldp?.isUplink || /TenGigabit|TwentyFive|Forty|Hundred|TF/i.test(st.port);

        combinedPorts.push({
          id: portNum,
          name: st.port,
          shortName: st.portShort,
          description: '',
          mode: st.vlan.toLowerCase().includes('trunk') ? 'trunk' : 'access',
          vlan: st.vlan,
          allowed_vlans: 'all',
          native_vlan: '',
          poeMode: livePoe?.powerControl === 'disable' ? 'disabled' : 'default',
          poePriority: 'default',
          poeMaxPower: '',
          poeStatus: livePoe ? livePoe.powerStatus : 'off',
          poePower: livePoe ? livePoe.watt : 0,
          poePowerStr: livePoe ? livePoe.currPower : '',
          poePdClass: livePoe ? livePoe.pdClass : '',
          poeVoltage: livePoe ? livePoe.voltage : '',
          aggregatePort: null,
          aggregateGroupId: null,
          operStatus: st.status,
          speed: st.speed,
          duplex: st.duplex,
          mediaType: st.mediaType,
          isUplink: isUplinkPort,
          uplinkNeighbor: liveLldp ? liveLldp.remoteDevice : null,
          uplinkNeighborPort: liveLldp ? liveLldp.remotePort : null,
          optical: liveDdm
        });
      }
    }

    // Sort combined ports by port ID
    combinedPorts.sort((a, b) => a.id - b.id);

    // 4. Update switch record in DB
    const finalHostname = (sw.hostname && sw.hostname !== sw.mgmt_ip) ? sw.hostname : (configParsed.hostname || sw.hostname || sw.mgmt_ip);
    const finalModel = sw.model_id || (ver.model ? (ver.model.startsWith('RG-') ? ver.model : 'RG-' + ver.model) : '');
    const finalSerial = sw.serial_number || ver.serial || '';
    const finalMac = sw.mac_address || ver.mac || '';

    const activeOptical = ddm.length > 0 ? ddm : (sw.optical_json ? JSON.parse(sw.optical_json) : []);
    const gatheredOptical = activeOptical.length > 0 ? activeOptical : combinedPorts.filter(p => p.optical && p.optical.status !== 'absent').map(p => p.optical);

    await db.run(
      `UPDATE switches SET
        status = 'online',
        hostname = ?,
        model_id = ?,
        serial_number = ?,
        mac_address = ?,
        last_seen = CURRENT_TIMESTAMP,
        last_synced = CURRENT_TIMESTAMP,
        uptime = ?,
        software_version = ?,
        ports_json = ?,
        lldp_json = ?,
        optical_json = ?,
        raw_config = ?,
        telemetry_mode = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        finalHostname,
        finalModel,
        finalSerial,
        finalMac,
        ver.uptime || sw.uptime || '',
        ver.version || sw.software_version || '',
        JSON.stringify(combinedPorts),
        JSON.stringify(lldp),
        JSON.stringify(gatheredOptical),
        rawConfig || rawOutput,
        finalTelemetryMode,
        switchId
      ]
    );

    // 5. Record optical DDM time-series metrics
    if (gatheredOptical.length > 0) {
      await recordOpticalMetrics(switchId, sw.hostname, gatheredOptical);
    }

    console.log(`[Poller] Switch ${sw.hostname || sw.mgmt_ip} synced successfully. Ports: ${combinedPorts.length}, Uplinks: ${lldp.filter(x => x.isUplink).length}, Optics: ${ddm.length}`);
    return { switchId, status: 'online', portCount: combinedPorts.length };
  } catch (err) {
    console.error(`[Poller] Error polling switch ${sw.mgmt_ip}:`, err.message);
    await db.run(
      'UPDATE switches SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['error', switchId]
    );
    throw err;
  }
}
