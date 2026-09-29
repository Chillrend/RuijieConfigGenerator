import express from 'express';
import { getDB, syncSwitchesFromDeployments } from '../lib/db.js';
import { pollSwitch } from '../lib/poller.js';
import { enqueueSwitchPoll, enqueueAllSwitches } from '../lib/queue.js';
import { generatePortDeltaCommands, normalizePortName } from '../lib/ruijie-parser.js';
import { runSshSession } from '../lib/ssh.js';
import { getOpticalHistory } from '../lib/influx.js';

const router = express.Router();

// List all switches with high-level stats
router.get('/', async (req, res) => {
  try {
    const db = getDB();
    const rows = await db.all('SELECT * FROM switches ORDER BY hostname ASC, mgmt_ip ASC');

    const switches = rows.map((sw) => {
      let ports = [];
      let lldp = [];
      let optical = [];
      try { ports = sw.ports_json ? JSON.parse(sw.ports_json) : []; } catch (e) {}
      try { lldp = sw.lldp_json ? JSON.parse(sw.lldp_json) : []; } catch (e) {}
      try { optical = sw.optical_json ? JSON.parse(sw.optical_json) : []; } catch (e) {}

      const activePorts = ports.filter(p => p.operStatus === 'up').length;
      const uplinkCount = lldp.filter(l => l.isUplink).length;
      const opticalWarnings = optical.filter(o => o.status === 'warning' || o.status === 'critical').length;

      return {
        id: sw.id,
        serial_number: sw.serial_number,
        mac_address: sw.mac_address,
        hostname: sw.hostname,
        model_id: sw.model_id,
        mgmt_ip: sw.mgmt_ip,
        inventory_tag: sw.inventory_tag,
        status: sw.status || 'unknown',
        last_seen: sw.last_seen,
        last_synced: sw.last_synced,
        uptime: sw.uptime,
        software_version: sw.software_version,
        total_ports: ports.length,
        active_ports: activePorts,
        uplink_count: uplinkCount,
        optical_warnings: opticalWarnings
      };
    });

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

    // Sanitize credentials
    const sanitized = {
      ...sw,
      admin_password: sw.admin_password ? '********' : '',
      enable_password: sw.enable_password ? '********' : '',
      ports,
      lldp,
      optical,
      hardware_template: hwTemplate
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

// Update switch metadata / credentials
router.put('/:id', async (req, res) => {
  const { hostname, mgmt_ip, admin_username, admin_password, enable_password, inventory_tag } = req.body;
  try {
    const db = getDB();
    const sw = await db.get('SELECT * FROM switches WHERE id = ?', [req.params.id]);
    if (!sw) return res.status(404).json({ error: 'Switch not found' });

    const newHostname = hostname || sw.hostname;
    const newIp = mgmt_ip || sw.mgmt_ip;
    const newAdminUser = admin_username !== undefined ? admin_username : sw.admin_username;
    const newAdminPass = admin_password && admin_password !== '********' ? admin_password : sw.admin_password;
    const newEnablePass = enable_password && enable_password !== '********' ? enable_password : sw.enable_password;
    const newTag = inventory_tag !== undefined ? inventory_tag : sw.inventory_tag;

    await db.run(
      `UPDATE switches SET
        hostname = ?, mgmt_ip = ?, admin_username = ?, admin_password = ?, enable_password = ?, inventory_tag = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newHostname, newIp, newAdminUser, newAdminPass, newEnablePass, newTag, req.params.id]
    );

    res.json({ success: true, message: 'Switch updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete switch from fleet
router.delete('/:id', async (req, res) => {
  try {
    const db = getDB();
    await db.run('DELETE FROM switches WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Switch deleted from fleet' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
