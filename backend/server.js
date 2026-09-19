import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import Handlebars from 'handlebars';
import { Server } from 'socket.io';
import http from 'http';

// --- ESM __dirname workaround ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ────────────────────────────────────────────────────────────
// 1. Initialize SQLite Database
// ────────────────────────────────────────────────────────────
const dbPath = path.join(__dirname, 'data', 'database.sqlite');
let db;

async function initDB() {
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS hardware_templates (
      id TEXT PRIMARY KEY,
      portPrefix TEXT,
      totalPorts INTEGER,
      uplinkPrefix TEXT,
      uplinkPorts TEXT
    );

    CREATE TABLE IF NOT EXISTS vlans (
      id INTEGER PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serial_number TEXT UNIQUE,
      mac_address TEXT UNIQUE,
      hostname TEXT,
      model_id TEXT,
      mgmt_ip TEXT,
      config_payload TEXT,
      generated_cli TEXT,
      inventory_tag TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration for existing table to add inventory_tag if missing
  try {
    await db.exec('ALTER TABLE deployments ADD COLUMN inventory_tag TEXT');
  } catch (e) {
    // Column might already exist, ignore
  }

  // Seed data from db.json if tables are empty
  const hwCount = await db.get('SELECT COUNT(*) as count FROM hardware_templates');
  if (hwCount.count === 0) {
    const jsonPath = path.join(__dirname, 'data', 'db.json');
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      if (data.hardware) {
        const stmt = await db.prepare('INSERT INTO hardware_templates (id, portPrefix, totalPorts, uplinkPrefix, uplinkPorts) VALUES (?, ?, ?, ?, ?)');
        for (const hw of data.hardware) {
          await stmt.run(hw.id, hw.portPrefix, hw.totalPorts, hw.uplinkPrefix, JSON.stringify(hw.uplinkPorts));
        }
        await stmt.finalize();
      }
      if (data.vlans) {
        const stmt = await db.prepare('INSERT INTO vlans (id, name) VALUES (?, ?)');
        for (const vlan of data.vlans) {
          await stmt.run(vlan.id, vlan.name);
        }
        await stmt.finalize();
      }
    }
  }
}

await initDB();

// ────────────────────────────────────────────────────────────
// 2. Handlebars Setup
// ────────────────────────────────────────────────────────────
Handlebars.registerHelper('eq', (a, b) => a === b);

const templateSource = fs.readFileSync(
  path.join(__dirname, 'templates', 'ruijie_base.hbs'),
  'utf-8'
);
const configTemplate = Handlebars.compile(templateSource);

// ────────────────────────────────────────────────────────────
// 3. Express App & Socket.IO
// ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

io.on('connection', (socket) => {
  // Mobile app can emit scanned codes to a specific session
  socket.on('scanned_data', (data) => {
    // data: { sessionId, type: 'serial' | 'mac', value }
    io.emit(`scan_result_${data.sessionId}`, data);
  });
});

// ── GET /api/setup ──────────────────────────────────────────
app.get('/api/setup', async (_req, res) => {
  const hardwareRows = await db.all('SELECT * FROM hardware_templates');
  const vlans = await db.all('SELECT * FROM vlans');
  
  const hardware = hardwareRows.map(hw => ({
    ...hw,
    uplinkPorts: JSON.parse(hw.uplinkPorts)
  }));

  res.json({ hardware, vlans });
});

// ── GET /api/deployments ────────────────────────────────────
app.get('/api/deployments', async (_req, res) => {
  const deployments = await db.all('SELECT id, serial_number, mac_address, hostname, model_id, mgmt_ip, inventory_tag, created_at FROM deployments ORDER BY created_at DESC');
  res.json(deployments);
});

// ── GET /api/deployments/:id ────────────────────────────────
app.get('/api/deployments/:id', async (req, res) => {
  const deployment = await db.get('SELECT * FROM deployments WHERE id = ?', req.params.id);
  if (deployment) {
    res.json(deployment);
  } else {
    res.status(404).json({ error: 'Deployment not found' });
  }
});

// ── DELETE /api/deployments/:id ─────────────────────────────
app.delete('/api/deployments/:id', async (req, res) => {
  try {
    const result = await db.run('DELETE FROM deployments WHERE id = ?', req.params.id);
    if (result.changes > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Deployment not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete deployment' });
  }
});

// ── POST /api/generate-config ───────────────────────────────
app.post('/api/generate-config', async (req, res) => {
  const {
    serialNumber,
    macAddress,
    hostname,
    modelId,
    vlans,
    ports,
    enablePassword,
    adminUsername,
    adminPassword,
    enableWeb,
    enableSsh,
    enableCwmp,
    mgmtVlan,
    mgmtIp,
    mgmtMask,
    mgmtGateway
  } = req.body;

  if (!serialNumber || !macAddress) {
    return res.status(400).json({ error: 'Missing required fields: serialNumber, macAddress' });
  }

  // Conflict checking
  const existingSNMac = await db.get('SELECT id FROM deployments WHERE serial_number = ? OR mac_address = ?', [serialNumber, macAddress]);
  if (existingSNMac) {
    return res.status(409).json({ error: 'A deployment with this Serial Number or MAC Address already exists.' });
  }

  if (mgmtIp) {
    const existingIP = await db.get('SELECT id FROM deployments WHERE mgmt_ip = ?', [mgmtIp]);
    if (existingIP) {
      return res.status(409).json({ error: 'A deployment with this Management IP already exists.' });
    }
  }

  // Find hardware model in the database
  const hwRow = await db.get('SELECT * FROM hardware_templates WHERE id = ?', [modelId]);
  if (!hwRow) {
    return res.status(404).json({ error: `Hardware model "${modelId}" not found` });
  }
  const model = {
    ...hwRow,
    uplinkPorts: JSON.parse(hwRow.uplinkPorts)
  };

  const uplinkSet = new Set(model.uplinkPorts);
  const mappedPorts = ports
    .filter((port) => port.configured)
    .map((port) => {
      const portNumber = port.id; 
      const isUplink = uplinkSet.has(portNumber);
      const prefix = isUplink ? model.uplinkPrefix : model.portPrefix;

      return {
        mappedName: `${prefix}${portNumber}`,
        mode: port.mode || 'access',
        vlan: port.vlan || 1,
        allowed_vlans: port.allowed_vlans || 'all',
        native_vlan: port.native_vlan || '',
        description: port.description || '',
        poeMode: port.poeMode || 'default',
        poePriority: port.poePriority || 'default',
        poeMaxPower: port.poeMaxPower || '',
      };
    });

  let configText = configTemplate({
    hostname,
    enablePassword: enablePassword || '',
    adminUsername: adminUsername || '',
    adminPassword: adminPassword || '',
    enableWeb: !!enableWeb,
    enableSsh: !!enableSsh,
    enableCwmp: !!enableCwmp,
    mgmtVlan: mgmtVlan || '',
    mgmtIp: mgmtIp || '',
    mgmtMask: mgmtMask || '',
    mgmtGateway: mgmtGateway || '',
    vlans: vlans || [],
    ports: mappedPorts,
  });

  configText = configText.split('\n').filter(line => line.trim() !== '').join('\n');

  // Generate random inventory tag (INV- + 8 random uppercase alphanumerics)
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomPart = '';
  for (let i = 0; i < 8; i++) {
    randomPart += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  const inventoryTag = `INV-${randomPart}`;

  try {
    await db.run(`
      INSERT INTO deployments (serial_number, mac_address, hostname, model_id, mgmt_ip, config_payload, generated_cli, inventory_tag)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [serialNumber, macAddress, hostname, modelId, mgmtIp || null, JSON.stringify(req.body), configText, inventoryTag]);
  } catch (err) {
    console.error('Error saving deployment:', err);
    return res.status(500).json({ error: 'Failed to save deployment to database' });
  }

  res.json({ configText, inventoryTag });
});

// ────────────────────────────────────────────────────────────
// 4. Start Server
// ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ Backend running → http://localhost:${PORT}`);
});
