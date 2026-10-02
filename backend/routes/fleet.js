import express from 'express';
import { getDB, syncSwitchesFromDeployments } from '../lib/db.js';
import { pollSwitch } from '../lib/poller.js';
import { enqueueSwitchPoll, enqueueAllSwitches } from '../lib/queue.js';
import { generatePortDeltaCommands, normalizePortName, shortPortName } from '../lib/ruijie-parser.js';
import { runSshSession } from '../lib/ssh.js';
import { getOpticalHistory } from '../lib/influx.js';
import { getRedis } from '../lib/redis.js';

const router = express.Router();

// Helper to inspect gRPC configuration and detect collector IP mismatches
function inspectGrpcConfig(rawConfig) {
  const expectedIp = process.env.GRPC_COLLECTOR_IP || '10.23.9.10';
  const expectedPort = parseInt(process.env.GRPC_COLLECTOR_PORT || '50051', 10);
  if (!rawConfig || typeof rawConfig !== 'string') {
    return {
      configured: false,
      configuredIp: null,
      configuredPort: null,
      expectedIp,
      expectedPort,
      ipMismatch: false
    };
  }

  const hasGrpc = /(?:^|\n)\s*grpc\b[\s\S]*?(?:destination-group|subscription)\b/i.test(rawConfig);
  if (!hasGrpc) {
    return {
      configured: false,
      configuredIp: null,
      configuredPort: null,
      expectedIp,
      expectedPort,
      ipMismatch: false
    };
  }

  // Extract destination IP & port from destination-group
  const destMatch = rawConfig.match(/destination-group\s+\S+[\s\S]*?\bip\s+([0-9.]+)(?:\s+port\s+(\d+))?/i);
  const configuredIp = destMatch ? destMatch[1] : null;
  const configuredPort = destMatch && destMatch[2] ? parseInt(destMatch[2], 10) : 50051;
  const ipMismatch = !!(configuredIp && configuredIp !== expectedIp);

  return {
    configured: true,
    configuredIp,
    configuredPort,
    expectedIp,
    expectedPort,
    ipMismatch
  };
}

// Disable HTTP caching for all fleet API endpoints so browser always receives live data
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// List all switches with high-level stats (augmented by Redis real-time telemetry if available)
router.get('/', async (req, res) => {
  try {
    const db = getDB();
    const rows = await db.all('SELECT * FROM switches ORDER BY hostname ASC, mgmt_ip ASC');
    const redis = getRedis();

    const switches = await Promise.all(
      rows.map(async (sw) => {
        let ports = [];
        let lldp = [];
        let optical = [];
        try { ports = sw.ports_json ? JSON.parse(sw.ports_json) : []; } catch (e) {}
        try { lldp = sw.lldp_json ? JSON.parse(sw.lldp_json) : []; } catch (e) {}
        try { optical = sw.optical_json ? JSON.parse(sw.optical_json) : []; } catch (e) {}

        // Check if real-time telemetry exists in Redis
        let isLiveGrpc = false;
        let lastLiveSeen = null;
        let liveTelemetry = null;
        try {
          const liveRaw = await redis.get(`sw:${sw.mgmt_ip}:telemetry`);
          if (liveRaw) {
            liveTelemetry = JSON.parse(liveRaw);
            isLiveGrpc = true;
            lastLiveSeen = liveTelemetry.last_seen;
            if (Array.isArray(liveTelemetry.optical) && liveTelemetry.optical.length > 0) {
              optical = liveTelemetry.optical;
            }
            if (Array.isArray(liveTelemetry.lldp) && liveTelemetry.lldp.length > 0) {
              lldp = liveTelemetry.lldp;
            }
          }
        } catch (e) {}

        // Fallback: If optical array is empty, derive from configured ports with transceivers
        if (optical.length === 0 && ports.length > 0) {
          optical = ports.filter(p => p.optical && p.optical.status !== 'absent').map(p => p.optical);
        }

        const isPhysicalPort = (name) => /^(?:MTGigabitEthernet|MTGi|GigabitEthernet|Gi|TenGigabitEthernet|Te|TFGigabitEthernet|TF|TwentyFiveGigabitEthernet|25G|FortyGigabitEthernet|Fo|HundredGigabitEthernet|Hu|FastEthernet|Fa|AggregatePort|Ag)\s*\d/i.test(name || '');
        optical = optical.filter(o => o.port && (isPhysicalPort(o.port) || isPhysicalPort(o.portShort)));

        let activePorts = 0;
        let totalPorts = ports.length;

        if (isLiveGrpc && Array.isArray(liveTelemetry?.interfaces) && liveTelemetry.interfaces.length > 0) {
          const physicalInterfaces = liveTelemetry.interfaces.filter(i => isPhysicalPort(i.name) || isPhysicalPort(i.shortName));
          activePorts = physicalInterfaces.filter(i => (i.operStatus || '').toLowerCase() === 'up').length;
          totalPorts = ports.length > 0 ? ports.length : physicalInterfaces.length;
        } else {
          activePorts = ports.filter(p => (p.operStatus || '').toLowerCase() === 'up').length;
        }

        const uplinkCount = lldp.filter(l => l.isUplink).length;
        const opticalWarnings = optical.filter(o => o.status === 'warning' || o.status === 'critical').length;

        // Auto-check if gRPC was configured in running-config and inspect collector destination
        const grpcInfo = inspectGrpcConfig(sw.raw_config);

        return {
          id: sw.id,
          serial_number: sw.serial_number,
          mac_address: sw.mac_address,
          hostname: sw.hostname,
          model_id: sw.model_id,
          mgmt_ip: sw.mgmt_ip,
          inventory_tag: sw.inventory_tag,
          status: isLiveGrpc ? 'online' : (sw.status || 'unknown'),
          telemetry_mode: isLiveGrpc ? 'grpc' : (sw.telemetry_mode || 'ssh'),
          is_live_grpc: isLiveGrpc,
          grpc_configured: grpcInfo.configured,
          grpc_configured_ip: grpcInfo.configuredIp,
          grpc_configured_port: grpcInfo.configuredPort,
          grpc_expected_ip: grpcInfo.expectedIp,
          grpc_expected_port: grpcInfo.expectedPort,
          grpc_ip_mismatch: grpcInfo.ipMismatch,
          last_seen: lastLiveSeen || sw.last_seen,
          last_synced: sw.last_synced,
          uptime: sw.uptime,
          software_version: sw.software_version,
          total_ports: totalPorts,
          active_ports: activePorts,
          uplink_count: uplinkCount,
          optical_warnings: opticalWarnings
        };
      })
    );

    res.json({ switches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add switch directly to fleet (bypassing provisioner)
router.post('/', async (req, res) => {
  const { mgmt_ip, hostname, admin_username, admin_password, enable_password, inventory_tag, model_id } = req.body;
  if (!mgmt_ip || !mgmt_ip.trim()) {
    return res.status(400).json({ error: 'Management IP is required' });
  }

  const cleanIp = mgmt_ip.trim();
  const cleanHost = (hostname || '').trim() || cleanIp;
  const user = (admin_username || 'admin').trim();
  const pass = admin_password || '';
  const enablePass = enable_password || pass;
  const tag = (inventory_tag || '').trim();
  const model = (model_id || '').trim();

  try {
    const db = getDB();
    const existing = await db.get('SELECT id, hostname, mgmt_ip FROM switches WHERE mgmt_ip = ?', [cleanIp]);
    if (existing) {
      return res.status(409).json({ error: `Switch with IP ${cleanIp} already exists (${existing.hostname || 'ID: ' + existing.id})` });
    }

    const insertResult = await db.run(
      `INSERT INTO switches (hostname, mgmt_ip, admin_username, admin_password, enable_password, inventory_tag, model_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown')`,
      [cleanHost, cleanIp, user, pass, enablePass, tag, model]
    );

    const newId = insertResult.lastID;

    // Asynchronously trigger initial SSH poll
    pollSwitch(newId).catch(err => {
      console.warn(`[Fleet] Initial poll for added switch ${cleanIp} failed:`, err.message);
    });

    res.status(201).json({
      success: true,
      message: 'Switch added successfully. Background polling initiated.',
      id: newId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get detailed single switch info
router.get('/:id', async (req, res) => {
  try {
    const db = getDB();
    const sw = await db.get('SELECT * FROM switches WHERE id = ?', [req.params.id]);
    if (!sw) return res.status(404).json({ error: 'Switch not found' });

    let ports = [];
    let lldp = [];
    let optical = [];
    try { ports = sw.ports_json ? JSON.parse(sw.ports_json) : []; } catch (e) {}
    try { lldp = sw.lldp_json ? JSON.parse(sw.lldp_json) : []; } catch (e) {}
    try { optical = sw.optical_json ? JSON.parse(sw.optical_json) : []; } catch (e) {}

    // Get hardware template for faceplate visual geometry
    let hwTemplate = null;
    if (sw.model_id) {
      hwTemplate = await db.get('SELECT * FROM hardware_templates WHERE id = ?', [sw.model_id]);
      if (hwTemplate && typeof hwTemplate.uplinkPorts === 'string') {
        try { hwTemplate.uplinkPorts = JSON.parse(hwTemplate.uplinkPorts); } catch (e) {}
      }
    }

    const PORT_NAME_REGEX = /^(?:MTGigabitEthernet|MTGi|GigabitEthernet|Gi|TenGigabitEthernet|Te|TFGigabitEthernet|TF|TwentyFiveGigabitEthernet|TwentyFiveGigE|25G|FortyGigabitEthernet|Fo|HundredGigabitEthernet|HundredGigE|Hu|FastEthernet|Fa|AggregatePort|Ag)\s*\d/i;
    // Sanitize any malformed parsed port rows
    ports = ports.filter(p => p.name && (PORT_NAME_REGEX.test(p.name) || PORT_NAME_REGEX.test(p.shortName)));

    // Fallback: If ports is empty, load from deployment config_payload or hardware template
    if (ports.length === 0) {
      const dep = await db.get(
        'SELECT config_payload FROM deployments WHERE serial_number = ? OR mgmt_ip = ?',
        [sw.serial_number, sw.mgmt_ip]
      );
      if (dep && dep.config_payload) {
        try {
          const payload = typeof dep.config_payload === 'string' ? JSON.parse(dep.config_payload) : dep.config_payload;
          if (Array.isArray(payload.ports) && hwTemplate) {
            const uplinkSet = new Set(hwTemplate.uplinkPorts || []);
            ports = payload.ports.map(p => {
              const isUplink = p.isUplink || uplinkSet.has(p.id);
              const prefix = isUplink ? (hwTemplate.uplinkPrefix || 'TenGigabitEthernet 0/') : (hwTemplate.portPrefix || 'GigabitEthernet 0/');
              return {
                id: p.id,
                name: `${prefix}${p.id}`,
                shortName: `${prefix.startsWith('Ten') ? 'Te' : prefix.startsWith('MT') ? 'MTGi' : 'Gi'}0/${p.id}`,
                description: p.description || '',
                mode: p.mode || 'access',
                vlan: p.vlan || '1',
                allowed_vlans: p.allowed_vlans || 'all',
                native_vlan: p.native_vlan || '',
                poeMode: p.poeMode || 'default',
                poePriority: p.poePriority || 'default',
                poeMaxPower: p.poeMaxPower || '',
                operStatus: 'down',
                speed: 'Auto',
                duplex: 'Auto',
                isUplink
              };
            });
          }
        } catch (e) {}
      }
    }

    // 4. Check Redis for real-time telemetry (gRPC live cache)
    const redis = getRedis();
    let liveTelemetry = null;
    try {
      const rawRedis = await redis.get(`sw:${sw.mgmt_ip}:telemetry`);
      if (rawRedis) liveTelemetry = JSON.parse(rawRedis);
    } catch (e) {}

    const telemetrySource = liveTelemetry ? 'grpc' : (sw.telemetry_mode || 'ssh');
    const grpcInfo = inspectGrpcConfig(sw.raw_config);

    // If live telemetry from gRPC is available, overlay real-time states
    if (liveTelemetry) {
      if (Array.isArray(liveTelemetry.optical) && liveTelemetry.optical.length > 0) {
        optical = liveTelemetry.optical;
      }
      if (Array.isArray(liveTelemetry.lldp) && liveTelemetry.lldp.length > 0) {
        lldp = liveTelemetry.lldp;
      }

      const liveIfMap = new Map();
      for (const iface of (liveTelemetry.interfaces || [])) {
        liveIfMap.set(iface.name, iface);
        liveIfMap.set(iface.shortName, iface);
      }
      const livePoeMap = new Map();
      for (const p of (liveTelemetry.poe || [])) {
        livePoeMap.set(p.port, p);
        livePoeMap.set(p.portShort, p);
      }
      const liveOptMap = new Map();
      for (const opt of optical) {
        liveOptMap.set(opt.port, opt);
        liveOptMap.set(opt.portShort, opt);
      }
      const liveLldpMap = new Map();
      for (const l of lldp) {
        liveLldpMap.set(l.localPort, l);
        liveLldpMap.set(l.localPortShort, l);
      }

      // If ports is still empty, synthesize from live interfaces
      if (ports.length === 0 && Array.isArray(liveTelemetry.interfaces) && liveTelemetry.interfaces.length > 0) {
        ports = liveTelemetry.interfaces.map((iface, idx) => {
          const match = iface.name.match(/\/(\d+)$/);
          const portNum = match ? parseInt(match[1], 10) : idx + 1;
          const isUplink = hwTemplate?.uplinkPorts?.includes(portNum) || /Te|TF|25G|40G|100G/i.test(iface.name);
          return {
            id: portNum,
            name: iface.name,
            shortName: iface.shortName,
            description: iface.description || '',
            mode: iface.mode || 'access',
            vlan: iface.vlan || '1',
            allowed_vlans: iface.allowed_vlans || 'all',
            native_vlan: '',
            poeMode: 'default',
            poePriority: 'default',
            poeMaxPower: '',
            operStatus: iface.operStatus,
            speed: iface.speed,
            duplex: iface.duplex,
            isUplink
          };
        });
      }

      // Overlay live status onto existing configured ports
      for (const p of ports) {
        const liveIf = liveIfMap.get(p.name) || liveIfMap.get(p.shortName);
        if (liveIf) {
          p.operStatus = liveIf.operStatus || p.operStatus;
          if (liveIf.speed && liveIf.speed.toLowerCase() !== 'auto') {
            p.speed = liveIf.speed;
          }
          if (liveIf.duplex && liveIf.duplex.toLowerCase() !== 'auto') {
            p.duplex = liveIf.duplex;
          }
          if (liveIf.counters) p.counters = liveIf.counters;
        }

        const livePoe = livePoeMap.get(p.name) || livePoeMap.get(p.shortName);
        if (livePoe) {
          p.poeStatus = livePoe.powerStatus || p.poeStatus || 'off';
          p.poePower = livePoe.watt || 0;
          p.poePowerStr = livePoe.currPower || `${livePoe.watt || 0}W`;
        }

        const liveOpt = liveOptMap.get(p.name) || liveOptMap.get(p.shortName);
        if (liveOpt) {
          p.optical = liveOpt;
        }

        const livePeer = liveLldpMap.get(p.name) || liveLldpMap.get(p.shortName);
        if (livePeer) {
          p.uplinkNeighbor = livePeer.remoteDevice;
          p.uplinkNeighborPort = livePeer.remotePort;
          p.isUplink = livePeer.isUplink || p.isUplink;
        }
      }
    }

    // Attach numeric id for faceplate ordering if missing
    ports.forEach((p, idx) => {
      if (!p.id) {
        const match = p.name.match(/\/(\d+)$/);
        p.id = match ? parseInt(match[1], 10) : (idx + 1);
      }
      if (hwTemplate && hwTemplate.uplinkPorts && Array.isArray(hwTemplate.uplinkPorts)) {
        if (hwTemplate.uplinkPorts.includes(p.id)) {
          p.isUplink = true;
        }
      }
    });

    // Fallback: If optical array is empty, collect from ports that have optical transceivers
    if (optical.length === 0 && ports.length > 0) {
      optical = ports.filter(p => p.optical && p.optical.status !== 'absent').map(p => p.optical);
    }
    // Filter out non-port hardware components (e.g. Slot 0, Chassis)
    optical = optical.filter(o => o.port && (PORT_NAME_REGEX.test(o.port) || PORT_NAME_REGEX.test(o.portShort)));

    // Sanitize credentials
    const sanitized = {
      ...sw,
      admin_password: sw.admin_password ? '********' : '',
      enable_password: sw.enable_password ? '********' : '',
      ports,
      lldp,
      optical,
      hardware_template: hwTemplate,
      telemetry_source: telemetrySource,
      grpc_configured: grpcInfo.configured,
      grpc_configured_ip: grpcInfo.configuredIp,
      grpc_configured_port: grpcInfo.configuredPort,
      grpc_expected_ip: grpcInfo.expectedIp,
      grpc_expected_port: grpcInfo.expectedPort,
      grpc_ip_mismatch: grpcInfo.ipMismatch,
      status: liveTelemetry ? 'online' : (sw.status || 'unknown')
    };

    res.json({ switch: sanitized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger immediate sync for one switch
router.post('/:id/sync', async (req, res) => {
  try {
    const db = getDB();
    const sw = await db.get('SELECT id FROM switches WHERE id = ?', [req.params.id]);
    if (!sw) return res.status(404).json({ error: 'Switch not found' });

    // Poll directly for immediate response
    const result = await pollSwitch(req.params.id);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger sync for all switches
router.post('/sync-all', async (req, res) => {
  try {
    const result = await enqueueAllSwitches();
    res.json({ success: true, message: `Queued ${result.queued} switches for polling.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync/import switches from deployments table
router.post('/import-from-deployments', async (req, res) => {
  try {
    const db = getDB();
    await syncSwitchesFromDeployments(db);
    res.json({ success: true, message: 'Switches imported from deployments table' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply non-destructive targeted port configuration change
router.post('/:id/port-config', async (req, res) => {
  const { portName, mode, vlan, allowed_vlans, native_vlan, description, poeMode, poePriority, poeMaxPower, shutdown } = req.body;
  if (!portName) {
    return res.status(400).json({ error: 'portName is required' });
  }

  try {
    const db = getDB();
    const sw = await db.get('SELECT * FROM switches WHERE id = ?', [req.params.id]);
    if (!sw) return res.status(404).json({ error: 'Switch not found' });

    // Find current port state from ports_json
    let ports = [];
    try { ports = sw.ports_json ? JSON.parse(sw.ports_json) : []; } catch (e) {}

    const normName = normalizePortName(portName);
    const currentPort = ports.find(p => normalizePortName(p.name) === normName) || null;

    const desired = {
      mode,
      vlan,
      allowed_vlans,
      native_vlan,
      description,
      poeMode,
      poePriority,
      poeMaxPower,
      shutdown
    };

    // Generate targeted delta CLI commands (never touches unmanaged lines!)
    const deltaCommands = generatePortDeltaCommands(normName, currentPort, desired);

    if (deltaCommands.length === 0) {
      return res.json({ success: true, message: 'No changes detected', deltaCommands: [] });
    }

    console.log(`[ConfigDelta] Applying targeted commands to ${sw.hostname} (${sw.mgmt_ip}):`, deltaCommands);

    // Push commands via SSH
    const sshOutput = await runSshSession(
      sw.mgmt_ip,
      {
        username: sw.admin_username || 'admin',
        password: sw.admin_password || '',
        enablePassword: sw.enable_password || '',
        timeout: 15000
      },
      deltaCommands
    );

    // Re-poll the switch to update operational state and saved running-config
    try {
      await pollSwitch(sw.id);
    } catch (pollErr) {
      console.warn(`[ConfigDelta] Re-poll warning for ${sw.mgmt_ip}:`, pollErr.message);
    }

    res.json({
      success: true,
      deltaCommands,
      output: sshOutput
    });
  } catch (err) {
    console.error('Error applying port delta config:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get historical optical DDM telemetry
router.get('/:id/optical-history', async (req, res) => {
  try {
    const port = req.query.port || null;
    const hours = parseInt(req.query.hours || '24', 10);
    const history = await getOpticalHistory(req.params.id, port, hours);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change switch hostname via SSH and update in DB
router.post('/:id/hostname', async (req, res) => {
  const { hostname } = req.body;
  if (!hostname || !hostname.trim()) {
    return res.status(400).json({ error: 'Hostname cannot be empty' });
  }

  const cleanHostname = hostname.trim();
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(cleanHostname)) {
    return res.status(400).json({ error: 'Invalid hostname format (use letters, numbers, dashes, dots, underscores)' });
  }

  try {
    const db = getDB();
    const sw = await db.get('SELECT * FROM switches WHERE id = ?', [req.params.id]);
    if (!sw) return res.status(404).json({ error: 'Switch not found' });

    console.log(`[Hostname] Pushing new hostname "${cleanHostname}" to switch ${sw.mgmt_ip} via SSH...`);
    const sshCommands = [
      'configure terminal',
      `hostname ${cleanHostname}`,
      'end',
      'write'
    ];

    const output = await runSshSession(
      sw.mgmt_ip,
      {
        username: sw.admin_username || 'admin',
        password: sw.admin_password || '',
        enablePassword: sw.enable_password || sw.admin_password || '',
        timeout: 15000
      },
      sshCommands
    );

    await db.run(
      'UPDATE switches SET hostname = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [cleanHostname, req.params.id]
    );

    console.log(`[Hostname] Switch ${sw.mgmt_ip} hostname changed to "${cleanHostname}"`);
    res.json({
      success: true,
      hostname: cleanHostname,
      message: `Hostname changed to ${cleanHostname} on device and database.`,
      output
    });
  } catch (err) {
    console.error(`[Hostname] Failed to update hostname for switch ${req.params.id}:`, err.message);
    res.status(500).json({ error: `SSH failed: ${err.message}` });
  }
});

// Update switch metadata / credentials
router.put('/:id', async (req, res) => {
  const {
    hostname,
    mgmt_ip,
    admin_username,
    admin_password,
    enable_password,
    inventory_tag,
    model_id,
    serial_number,
    mac_address
  } = req.body;

  try {
    const db = getDB();
    const sw = await db.get('SELECT * FROM switches WHERE id = ?', [req.params.id]);
    if (!sw) return res.status(404).json({ error: 'Switch not found' });

    const newHostname = hostname !== undefined ? (hostname || '').trim() : sw.hostname;
    const newIp = mgmt_ip !== undefined ? (mgmt_ip || '').trim() : sw.mgmt_ip;
    if (!newIp) {
      return res.status(400).json({ error: 'Management IP is required' });
    }

    if (newIp !== sw.mgmt_ip) {
      const existing = await db.get('SELECT id, hostname FROM switches WHERE mgmt_ip = ? AND id != ?', [newIp, req.params.id]);
      if (existing) {
        return res.status(409).json({ error: `Switch with IP ${newIp} already exists (${existing.hostname || 'ID: ' + existing.id})` });
      }
    }

    const newAdminUser = admin_username !== undefined ? (admin_username || 'admin').trim() : sw.admin_username;
    const newAdminPass = admin_password && admin_password !== '********' ? admin_password : sw.admin_password;
    const newEnablePass = enable_password && enable_password !== '********' ? enable_password : sw.enable_password;
    const newTag = inventory_tag !== undefined ? (inventory_tag || '').trim() : sw.inventory_tag;
    const newModel = model_id !== undefined ? (model_id || '').trim() : sw.model_id;
    const newSn = serial_number !== undefined ? (serial_number || '').trim() : sw.serial_number;
    const newMac = mac_address !== undefined ? (mac_address || '').trim() : sw.mac_address;

    await db.run(
      `UPDATE switches SET
        hostname = ?,
        mgmt_ip = ?,
        admin_username = ?,
        admin_password = ?,
        enable_password = ?,
        inventory_tag = ?,
        model_id = ?,
        serial_number = ?,
        mac_address = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newHostname, newIp, newAdminUser, newAdminPass, newEnablePass, newTag, newModel, newSn, newMac, req.params.id]
    );

    res.json({
      success: true,
      message: 'Switch updated successfully',
      switch: {
        id: sw.id,
        hostname: newHostname,
        mgmt_ip: newIp,
        admin_username: newAdminUser,
        inventory_tag: newTag,
        model_id: newModel,
        serial_number: newSn,
        mac_address: newMac
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete switch from fleet
router.delete('/:id', async (req, res) => {
  try {
    const db = getDB();
    const sw = await db.get('SELECT mgmt_ip FROM switches WHERE id = ?', [req.params.id]);
    await db.run('DELETE FROM telemetry_history WHERE switch_id = ?', [req.params.id]);
    await db.run('DELETE FROM switches WHERE id = ?', [req.params.id]);
    if (sw?.mgmt_ip) {
      try {
        const redis = getRedis();
        await redis.del(`sw:${sw.mgmt_ip}:telemetry`);
      } catch (e) {}
    }
    res.json({ success: true, message: 'Switch deleted from fleet' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retrieve configured gRPC collector server info
router.get('/global-config/grpc-info', (req, res) => {
  res.json({
    collectorIp: process.env.GRPC_COLLECTOR_IP || '10.23.9.10',
    collectorPort: parseInt(process.env.GRPC_COLLECTOR_PORT || '50051', 10)
  });
});

// Deploy gRPC telemetry dial-out configuration preset to switches
router.post('/global-config/deploy-grpc', async (req, res) => {
  const defaultIp = process.env.GRPC_COLLECTOR_IP || '10.23.9.10';
  const defaultPort = parseInt(process.env.GRPC_COLLECTOR_PORT || '50051', 10);
  const { switchIds, serverIp = defaultIp, serverPort = defaultPort } = req.body;
  const redis = getRedis();
  try {
    const db = getDB();
    let switches = [];
    if (Array.isArray(switchIds) && switchIds.length > 0) {
      const placeholders = switchIds.map(() => '?').join(',');
      switches = await db.all(`SELECT * FROM switches WHERE id IN (${placeholders})`, switchIds);
    } else {
      // Only target switches that are currently online (skip offline devices)
      switches = await db.all("SELECT * FROM switches WHERE status = 'online'");
    }

    if (switches.length === 0) {
      return res.json({
        success: true,
        total: 0,
        successful: 0,
        failed: 0,
        message: 'No online switches found to configure.',
        results: []
      });
    }

    console.log(`[Deploy gRPC] >>> Initiating gRPC dial-out deployment for ${switches.length} online switches (collector: ${serverIp}:${serverPort})...`);

    const grpcCommands = [
      'configure terminal',
      'grpc',
      // Clean up previous telemetry blocks to prevent stale or duplicate paths
      ' no subscription FLEET_STREAM',
      ' no destination-group FLEET_BACKEND',
      ' no sensor-group FAST_METRICS',
      ' no sensor-group SLOW_METRICS',
      ' server port 50052',
      ' rpc gnmi enable',
      ' sensor-group FAST_METRICS',
      '  sensor-path openconfig-interfaces:interfaces',
      '  sensor-path rg-interfaces:interfaces',
      '  exit-sensor-group',
      ' sensor-group SLOW_METRICS',
      '  sensor-path openconfig-lldp:lldp',
      '  sensor-path /openconfig-platform:components',
      '  exit-sensor-group',
      ' destination-group FLEET_BACKEND',
      `  ip ${serverIp} port ${serverPort}`,
      '  exit-destination-group',
      ' subscription FLEET_STREAM',
      '  sensor-group FAST_METRICS sample-interval 5000',
      '  sensor-group SLOW_METRICS sample-interval 60000',
      '  destination-group FLEET_BACKEND',
      '  exit-grpc-subscription',
      'end',
      'write'
    ];

    const results = [];
    let completedCount = 0;

    // Run in parallel batches of 6 for speed without overwhelming switch/network
    const CONCURRENCY = 6;
    for (let i = 0; i < switches.length; i += CONCURRENCY) {
      const batch = switches.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (sw) => {
          const swName = sw.hostname || sw.mgmt_ip;
          if (/10GT/i.test(sw.model_id || '')) {
            console.log(`[Deploy gRPC] Skipping ${swName} (${sw.mgmt_ip}) - 10GT does not support gRPC`);
            results.push({
              id: sw.id,
              hostname: sw.hostname,
              mgmt_ip: sw.mgmt_ip,
              success: false,
              error: 'Model does not support gRPC (10GT series)'
            });
            completedCount++;
            return;
          }

          if (/11\.0/i.test(sw.software_version || '')) {
            console.log(`[Deploy gRPC] Skipping ${swName} (${sw.mgmt_ip}) - RGOS 11.0 does not support OpenConfig telemetry`);
            results.push({
              id: sw.id,
              hostname: sw.hostname,
              mgmt_ip: sw.mgmt_ip,
              success: false,
              error: 'RGOS 11.0 lacks OpenConfig telemetry support (firmware upgrade to 12.x required)'
            });
            completedCount++;
            return;
          }

          console.log(`[Deploy gRPC] [${completedCount + 1}/${switches.length}] Connecting via SSH to ${swName} (${sw.mgmt_ip})...`);
          try {
            await runSshSession(
              sw.mgmt_ip,
              {
                username: sw.admin_username || 'admin',
                password: sw.admin_password || '',
                enablePassword: sw.enable_password || sw.admin_password || '',
                timeout: 35000
              },
              grpcCommands
            );

            await db.run(
              "UPDATE switches SET grpc_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
              [sw.id]
            );

            console.log(`[Deploy gRPC] ✓ Successfully configured gRPC on ${swName} (${sw.mgmt_ip})`);
            results.push({
              id: sw.id,
              hostname: sw.hostname,
              mgmt_ip: sw.mgmt_ip,
              success: true
            });
          } catch (err) {
            console.warn(`[Deploy gRPC] ✗ Failed on ${swName} (${sw.mgmt_ip}): ${err.message}`);
            results.push({
              id: sw.id,
              hostname: sw.hostname,
              mgmt_ip: sw.mgmt_ip,
              success: false,
              error: err.message
            });
          } finally {
            completedCount++;
            try {
              if (redis) {
                await redis.publish('global-action:progress', JSON.stringify({
                  action: 'deploy-grpc',
                  completed: completedCount,
                  total: switches.length,
                  current: swName
                }));
              }
            } catch (e) {}
          }
        })
      );
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`[Deploy gRPC] >>> Finished deployment to ${switches.length} switches: ${successful} succeeded, ${failed} failed.`);

    res.json({
      success: true,
      total: switches.length,
      successful,
      failed,
      results
    });
  } catch (err) {
    console.error('[Deploy gRPC] Global deployment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sync running-config for all switches (daily-style backup)
router.post('/global-config/sync-config', async (req, res) => {
  try {
    const result = await enqueueAllSwitches(true);
    res.json({ success: true, message: `Queued ${result.queued} switches for running-config sync.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
