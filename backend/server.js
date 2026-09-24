import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import Handlebars from 'handlebars';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

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
// 3. Express App
// ────────────────────────────────────────────────────────────
const app = express();
// Configure CORS to allow credentials from the frontend
app.use(cors({
  origin: 'http://localhost:5173', // Vite default port
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ────────────────────────────────────────────────────────────
// 3.5 Authentication Setup
// ────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_do_not_use_in_prod';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase());

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'dummy',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'dummy',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback'
  },
  function(accessToken, refreshToken, profile, cb) {
    const email = profile.emails?.[0]?.value?.toLowerCase();
    if (!email) {
      return cb(new Error('No email found in Google profile.'));
    }
    
    // Check if user is in the allowed list
    if (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(email) && process.env.ALLOWED_EMAILS) {
      return cb(null, false, { message: 'Unauthorized email' });
    }
    
    return cb(null, { id: profile.id, email: email, name: profile.displayName, avatar: profile.photos?.[0]?.value });
  }
));

app.use(passport.initialize());

// Authentication Middleware
const requireAuth = (req, res, next) => {
  const token = req.cookies.auth_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

// ── Auth Routes ─────────────────────────────────────────────
app.get('/api/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/api/auth/google/callback', (req, res, next) => {
  // Use FRONTEND_URL if specified in environment (e.g. for local Vite dev https://localhost:5173)
  // Fallback to empty string for relative paths in Docker where backend/frontend are on same port
  const frontendUrl = process.env.FRONTEND_URL || '';
  
  passport.authenticate('google', { 
    session: false, 
    failureRedirect: `${frontendUrl}/login?error=unauthorized` 
  })(req, res, () => {
    // Generate JWT
    const token = jwt.sign(req.user, JWT_SECRET, { expiresIn: '24h' });
    
    // Set HTTP-only cookie
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    
    res.redirect(`${frontendUrl}/`);
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

// ── GET /api/setup ──────────────────────────────────────────
app.get('/api/setup', requireAuth, async (_req, res) => {
  const hardwareRows = await db.all('SELECT * FROM hardware_templates');
  const vlans = await db.all('SELECT * FROM vlans');
  
  const hardware = hardwareRows.map(hw => ({
    ...hw,
    uplinkPorts: JSON.parse(hw.uplinkPorts)
  }));

  res.json({ hardware, vlans });
});

// ── GET /api/deployments ────────────────────────────────────
app.get('/api/deployments', requireAuth, async (_req, res) => {
  const deployments = await db.all('SELECT id, serial_number, mac_address, hostname, model_id, mgmt_ip, inventory_tag, created_at FROM deployments ORDER BY created_at DESC');
  res.json(deployments);
});

// ── GET /api/deployments/export/csv ─────────────────────────
app.get('/api/deployments/export/csv', requireAuth, async (_req, res) => {
  try {
    const deployments = await db.all('SELECT id, serial_number, mac_address, hostname, model_id, mgmt_ip, inventory_tag, created_at FROM deployments ORDER BY created_at DESC');
    
    let csv = 'ID,Date,Hostname,Model,Serial Number,MAC Address,Management IP,Inventory Tag\n';
    for (const dep of deployments) {
      csv += `"${dep.id}","${new Date(dep.created_at).toLocaleString()}","${dep.hostname || ''}","${dep.model_id || ''}","${dep.serial_number || ''}","${dep.mac_address || ''}","${dep.mgmt_ip || ''}","${dep.inventory_tag || ''}"\n`;
    }

    res.header('Content-Type', 'text/csv');
    res.attachment('deployments.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export deployments' });
  }
});

// ── GET /api/deployments/:id ────────────────────────────────
app.get('/api/deployments/:id', requireAuth, async (req, res) => {
  const deployment = await db.get('SELECT * FROM deployments WHERE id = ?', req.params.id);
  if (deployment) {
    res.json(deployment);
  } else {
    res.status(404).json({ error: 'Deployment not found' });
  }
});

// ── DELETE /api/deployments/:id ─────────────────────────────
app.delete('/api/deployments/:id', requireAuth, async (req, res) => {
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

// ── PUT /api/deployments/:id ────────────────────────────────
app.put('/api/deployments/:id', requireAuth, async (req, res) => {
  try {
    const deploymentId = req.params.id;
    const existing = await db.get('SELECT * FROM deployments WHERE id = ?', deploymentId);
    if (!existing) {
      return res.status(404).json({ error: 'Deployment not found' });
    }

    const {
      serialNumber,
      serial_number,
      macAddress,
      mac_address,
      hostname,
      mgmtIp,
      mgmt_ip,
      inventoryTag,
      inventory_tag,
      generated_cli,
      generatedCli,
    } = req.body;

    const newSN = (serialNumber !== undefined ? serialNumber : serial_number !== undefined ? serial_number : existing.serial_number)?.trim();
    const newMac = (macAddress !== undefined ? macAddress : mac_address !== undefined ? mac_address : existing.mac_address)?.trim() || null;
    const newHostname = (hostname !== undefined ? hostname : existing.hostname)?.trim();
    const newMgmtIp = (mgmtIp !== undefined ? mgmtIp : mgmt_ip !== undefined ? mgmt_ip : existing.mgmt_ip)?.trim() || null;
    const newInventoryTag = (inventoryTag !== undefined ? inventoryTag : inventory_tag !== undefined ? inventory_tag : existing.inventory_tag)?.trim() || null;

    if (!newSN) {
      return res.status(400).json({ error: 'Serial Number is required' });
    }

    // Check unique conflict for Serial Number
    if (newSN !== existing.serial_number) {
      const conflictSN = await db.get('SELECT id FROM deployments WHERE serial_number = ? AND id != ?', [newSN, deploymentId]);
      if (conflictSN) {
        return res.status(409).json({ error: 'A deployment with this Serial Number already exists.' });
      }
    }

    // Check unique conflict for MAC Address
    if (newMac && newMac !== existing.mac_address) {
      const conflictMac = await db.get('SELECT id FROM deployments WHERE mac_address = ? AND id != ?', [newMac, deploymentId]);
      if (conflictMac) {
        return res.status(409).json({ error: 'A deployment with this MAC Address already exists.' });
      }
    }

    // Check unique conflict for Management IP
    if (newMgmtIp && newMgmtIp !== existing.mgmt_ip) {
      const conflictIP = await db.get('SELECT id FROM deployments WHERE mgmt_ip = ? AND id != ?', [newMgmtIp, deploymentId]);
      if (conflictIP) {
        return res.status(409).json({ error: 'A deployment with this Management IP already exists.' });
      }
    }

    // Update config_payload and re-generate CLI if possible
    let updatedPayload = existing.config_payload;
    let updatedCli = (generated_cli !== undefined ? generated_cli : generatedCli !== undefined ? generatedCli : existing.generated_cli);

    try {
      const payloadObj = JSON.parse(existing.config_payload || '{}');
      payloadObj.hostname = newHostname;
      payloadObj.serialNumber = newSN;
      payloadObj.macAddress = newMac;
      payloadObj.mgmtIp = newMgmtIp;
      updatedPayload = JSON.stringify(payloadObj);

      // Only regenerate CLI if generated_cli was not explicitly provided by the user
      if (generated_cli === undefined && generatedCli === undefined) {
        const hwRow = await db.get('SELECT * FROM hardware_templates WHERE id = ?', [existing.model_id]);
        if (hwRow && Array.isArray(payloadObj.ports)) {
          const model = {
            ...hwRow,
            uplinkPorts: JSON.parse(hwRow.uplinkPorts)
          };
          const uplinkSet = new Set(model.uplinkPorts);
          const mappedPorts = payloadObj.ports
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

          let ntpList = [];
          if (Array.isArray(payloadObj.ntpServers)) {
            ntpList = payloadObj.ntpServers;
          } else if (typeof payloadObj.ntpServers === 'string') {
            ntpList = payloadObj.ntpServers.split(',').map(s => s.trim()).filter(Boolean);
          }

          let configText = configTemplate({
            hostname: newHostname,
            timezone: payloadObj.timezone || '',
            ntpServers: ntpList,
            enablePassword: payloadObj.enablePassword || '',
            adminUsername: payloadObj.adminUsername || '',
            adminPassword: payloadObj.adminPassword || '',
            enableWeb: !!payloadObj.enableWeb,
            enableSsh: !!payloadObj.enableSsh,
            enableCwmp: !!payloadObj.enableCwmp,
            mgmtVlan: payloadObj.mgmtVlan || '',
            mgmtIp: newMgmtIp || '',
            mgmtMask: payloadObj.mgmtMask || '',
            mgmtGateway: payloadObj.mgmtGateway || '',
            vlans: payloadObj.vlans || [],
            ports: mappedPorts,
          });

          updatedCli = configText.split('\n').filter(line => line.trim() !== '').join('\n');
        }
      }
    } catch (e) {
      console.error('Error re-generating config text on update:', e);
    }

    await db.run(`
      UPDATE deployments
      SET serial_number = ?, mac_address = ?, hostname = ?, mgmt_ip = ?, inventory_tag = ?, config_payload = ?, generated_cli = ?
      WHERE id = ?
    `, [newSN, newMac, newHostname, newMgmtIp, newInventoryTag, updatedPayload, updatedCli, deploymentId]);

    const updated = await db.get('SELECT * FROM deployments WHERE id = ?', deploymentId);
    res.json(updated);
  } catch (err) {
    console.error('Failed to update deployment:', err);
    res.status(500).json({ error: 'Failed to update deployment' });
  }
});

// ── POST /api/generate-config ───────────────────────────────
app.post('/api/generate-config', requireAuth, async (req, res) => {
  const {
    editingDeploymentId,
    serialNumber,
    macAddress,
    hostname,
    modelId,
    timezone,
    ntpServers,
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

  if (!serialNumber) {
    return res.status(400).json({ error: 'Missing required field: serialNumber' });
  }

  // Conflict checking
  if (editingDeploymentId) {
    const existingSN = await db.get('SELECT id FROM deployments WHERE serial_number = ? AND id != ?', [serialNumber, editingDeploymentId]);
    if (existingSN) {
      return res.status(409).json({ error: 'A deployment with this Serial Number already exists.' });
    }
    if (macAddress) {
      const existingMac = await db.get('SELECT id FROM deployments WHERE mac_address = ? AND id != ?', [macAddress, editingDeploymentId]);
      if (existingMac) {
        return res.status(409).json({ error: 'A deployment with this MAC Address already exists.' });
      }
    }
    if (mgmtIp) {
      const existingIP = await db.get('SELECT id FROM deployments WHERE mgmt_ip = ? AND id != ?', [mgmtIp, editingDeploymentId]);
      if (existingIP) {
        return res.status(409).json({ error: 'A deployment with this Management IP already exists.' });
      }
    }
  } else {
    const existingSN = await db.get('SELECT id FROM deployments WHERE serial_number = ?', [serialNumber]);
    if (existingSN) {
      return res.status(409).json({ error: 'A deployment with this Serial Number already exists.' });
    }
    if (macAddress) {
      const existingMac = await db.get('SELECT id FROM deployments WHERE mac_address = ?', [macAddress]);
      if (existingMac) {
        return res.status(409).json({ error: 'A deployment with this MAC Address already exists.' });
      }
    }
    if (mgmtIp) {
      const existingIP = await db.get('SELECT id FROM deployments WHERE mgmt_ip = ?', [mgmtIp]);
      if (existingIP) {
        return res.status(409).json({ error: 'A deployment with this Management IP already exists.' });
      }
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

  let ntpList = [];
  if (Array.isArray(ntpServers)) {
    ntpList = ntpServers;
  } else if (typeof ntpServers === 'string') {
    ntpList = ntpServers.split(',').map(s => s.trim()).filter(Boolean);
  }

  let configText = configTemplate({
    hostname,
    timezone: timezone || '',
    ntpServers: ntpList,
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

  if (editingDeploymentId) {
    const currentDep = await db.get('SELECT inventory_tag FROM deployments WHERE id = ?', editingDeploymentId);
    const existingTag = currentDep?.inventory_tag || `INV-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    try {
      await db.run(`
        UPDATE deployments
        SET serial_number = ?, mac_address = ?, hostname = ?, model_id = ?, mgmt_ip = ?, config_payload = ?, generated_cli = ?, inventory_tag = ?
        WHERE id = ?
      `, [serialNumber, macAddress || null, hostname, modelId, mgmtIp || null, JSON.stringify(req.body), configText, existingTag, editingDeploymentId]);
    } catch (err) {
      console.error('Error updating deployment:', err);
      return res.status(500).json({ error: 'Failed to update deployment in database' });
    }
    return res.json({ configText, inventoryTag: existingTag, updated: true });
  }

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
    `, [serialNumber, macAddress || null, hostname, modelId, mgmtIp || null, JSON.stringify(req.body), configText, inventoryTag]);
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
app.listen(PORT, () => {
  console.log(`✅ Backend running → http://localhost:${PORT}`);
});
