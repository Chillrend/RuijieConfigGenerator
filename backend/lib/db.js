import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');
const dbPath = path.join(backendRoot, 'data', 'database.sqlite');

let activeDb = null;
let dbType = 'sqlite'; // 'postgres' | 'sqlite'

// ponytail: convert ? placeholders to $1, $2 for postgres if using postgres
function toPgSql(sql) {
  let paramIdx = 1;
  return sql.replace(/\?/g, () => `$${paramIdx++}`);
}

const COLUMN_ALIASES = {
  uplinkports: 'uplinkPorts',
  portprefix: 'portPrefix',
  totalports: 'totalPorts',
  uplinkprefix: 'uplinkPrefix',
  poemode: 'poeMode',
  poepriority: 'poePriority',
  poemaxpower: 'poeMaxPower'
};

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const [lower, camel] of Object.entries(COLUMN_ALIASES)) {
    if (lower in row && !(camel in row)) {
      row[camel] = row[lower];
    }
  }
  return row;
}

class PostgresWrapper {
  constructor(pool) {
    this.pool = pool;
  }

  async all(sql, params = []) {
    const res = await this.pool.query(toPgSql(sql), Array.isArray(params) ? params : [params]);
    return res.rows.map(normalizeRow);
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0] || null;
  }

  async run(sql, params = []) {
    // If insert with RETURNING id
    const res = await this.pool.query(toPgSql(sql), Array.isArray(params) ? params : [params]);
    return {
      lastID: res.rows?.[0]?.id || null,
      changes: res.rowCount
    };
  }

  async exec(sql) {
    return this.pool.query(sql);
  }

  async prepare(sql) {
    const pool = this.pool;
    return {
      async run(...params) {
        return pool.query(toPgSql(sql), params);
      },
      async finalize() {}
    };
  }
}

export async function initDatabase() {
  if (activeDb) return activeDb;

  const pgUrl = process.env.DATABASE_URL;
  if (pgUrl) {
    // Retry up to 5 times for container startup
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const pool = new pg.Pool({ connectionString: pgUrl, connectionTimeoutMillis: 3000 });
        await pool.query('SELECT 1');
        console.log('Connected to PostgreSQL database');
        activeDb = new PostgresWrapper(pool);
        dbType = 'postgres';
        await runSchema(activeDb, 'postgres');
        await migrateSqliteToPostgres(activeDb, dbPath);
        return activeDb;
      } catch (err) {
        if (attempt < 5) {
          console.log(`Waiting for PostgreSQL (attempt ${attempt}/5)...`);
          await new Promise(r => setTimeout(r, 1500));
        } else {
          console.warn('PostgreSQL connection failed, falling back to SQLite:', err.message);
        }
      }
    }
  }

  // Fallback to SQLite
  console.log('Using SQLite database at', dbPath);
  activeDb = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  dbType = 'sqlite';
  await runSchema(activeDb, 'sqlite');
  return activeDb;
}

async function migrateSqliteToPostgres(pgDb, sqliteFilePath) {
  if (!fs.existsSync(sqliteFilePath)) return;
  try {
    const depCount = await pgDb.get('SELECT COUNT(*) as count FROM deployments');
    if (Number(depCount?.count || 0) > 0) return; // already migrated

    console.log('Migrating existing records from SQLite to PostgreSQL...');
    const sqliteDb = await open({ filename: sqliteFilePath, driver: sqlite3.Database });

    const hwRows = await sqliteDb.all('SELECT * FROM hardware_templates');
    for (const h of hwRows) {
      await pgDb.run('INSERT INTO hardware_templates (id, portPrefix, totalPorts, uplinkPrefix, uplinkPorts) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING', [h.id, h.portPrefix, h.totalPorts, h.uplinkPrefix, h.uplinkPorts]);
    }

    const vlanRows = await sqliteDb.all('SELECT * FROM vlans');
    for (const v of vlanRows) {
      await pgDb.run('INSERT INTO vlans (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', [v.id, v.name]);
    }

    const profRows = await sqliteDb.all('SELECT * FROM port_profiles');
    for (const p of profRows) {
      await pgDb.run('INSERT INTO port_profiles (name, mode, vlan, allowed_vlans, native_vlan, description, poeMode, poePriority, poeMaxPower) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [p.name, p.mode, p.vlan, p.allowed_vlans, p.native_vlan, p.description, p.poeMode, p.poePriority, p.poeMaxPower]);
    }

    const depRows = await sqliteDb.all('SELECT * FROM deployments');
    for (const d of depRows) {
      await pgDb.run('INSERT INTO deployments (serial_number, mac_address, hostname, model_id, mgmt_ip, config_payload, generated_cli, inventory_tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (serial_number) DO NOTHING', [d.serial_number, d.mac_address, d.hostname, d.model_id, d.mgmt_ip, d.config_payload, d.generated_cli, d.inventory_tag, d.created_at]);
    }

    await sqliteDb.close();
    console.log(`Migrated ${depRows.length} deployments and templates to PostgreSQL.`);
    await syncSwitchesFromDeployments(pgDb);
  } catch (err) {
    console.warn('SQLite to PostgreSQL auto-migration notice:', err.message);
  }
}

export function getDB() {
  return activeDb;
}

export function getDBType() {
  return dbType;
}

async function runSchema(db, type) {
  const isPg = type === 'postgres';
  const autoInc = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const textType = 'TEXT';
  const timestampType = isPg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';

  await db.exec(`
    CREATE TABLE IF NOT EXISTS hardware_templates (
      id ${textType} PRIMARY KEY,
      portPrefix ${textType},
      totalPorts INTEGER,
      uplinkPrefix ${textType},
      uplinkPorts ${textType}
    );

    CREATE TABLE IF NOT EXISTS vlans (
      id INTEGER PRIMARY KEY,
      name ${textType}
    );

    CREATE TABLE IF NOT EXISTS port_profiles (
      id ${autoInc},
      name ${textType},
      mode ${textType},
      vlan ${textType},
      allowed_vlans ${textType},
      native_vlan ${textType},
      description ${textType},
      poeMode ${textType},
      poePriority ${textType},
      poeMaxPower ${textType}
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id ${autoInc},
      serial_number ${textType} UNIQUE,
      mac_address ${textType} UNIQUE,
      hostname ${textType},
      model_id ${textType},
      mgmt_ip ${textType},
      config_payload ${textType},
      generated_cli ${textType},
      inventory_tag ${textType},
      created_at ${timestampType}
    );

    CREATE TABLE IF NOT EXISTS switches (
      id ${autoInc},
      serial_number ${textType} UNIQUE,
      mac_address ${textType},
      hostname ${textType},
      model_id ${textType},
      mgmt_ip ${textType} UNIQUE,
      admin_username ${textType} DEFAULT 'admin',
      admin_password ${textType},
      enable_password ${textType},
      inventory_tag ${textType},
      status ${textType} DEFAULT 'unknown',
      last_seen ${timestampType},
      last_synced ${timestampType},
      uptime ${textType},
      software_version ${textType},
      raw_config ${textType},
      ports_json ${textType},
      lldp_json ${textType},
      optical_json ${textType},
      telemetry_mode ${textType} DEFAULT 'ssh',
      grpc_status ${textType} DEFAULT 'disabled',
      created_at ${timestampType},
      updated_at ${timestampType}
    );

    CREATE TABLE IF NOT EXISTS telemetry_history (
      id ${autoInc},
      switch_id INTEGER,
      port_name ${textType},
      rx_power REAL,
      tx_power REAL,
      temperature REAL,
      voltage REAL,
      status ${textType},
      created_at ${timestampType}
    );
  `);

  try {
    await db.exec('ALTER TABLE deployments ADD COLUMN inventory_tag TEXT');
  } catch (e) {
    // Column might already exist
  }

  try {
    await db.exec("ALTER TABLE switches ADD COLUMN telemetry_mode TEXT DEFAULT 'ssh'");
  } catch (e) {
    // Column might already exist
  }

  try {
    await db.exec("ALTER TABLE switches ADD COLUMN grpc_status TEXT DEFAULT 'disabled'");
  } catch (e) {
    // Column might already exist
  }

  // Seed/sync default hardware templates from json
  const jsonPath = path.join(backendRoot, 'data', 'db.json');
  if (fs.existsSync(jsonPath)) {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (data.hardware) {
      for (const hw of data.hardware) {
        const exists = await db.get('SELECT id FROM hardware_templates WHERE id = ?', [hw.id]);
        if (!exists) {
          await db.run(
            'INSERT INTO hardware_templates (id, portPrefix, totalPorts, uplinkPrefix, uplinkPorts) VALUES (?, ?, ?, ?, ?)',
            [hw.id, hw.portPrefix, hw.totalPorts, hw.uplinkPrefix, JSON.stringify(hw.uplinkPorts)]
          );
        }
      }
    }
    const vlanCount = await db.get('SELECT COUNT(*) as count FROM vlans');
    if (Number(vlanCount?.count || 0) === 0 && data.vlans) {
      for (const vlan of data.vlans) {
        await db.run('INSERT INTO vlans (id, name) VALUES (?, ?)', [vlan.id, vlan.name]);
      }
    }
    const profCount = await db.get('SELECT COUNT(*) as count FROM port_profiles');
    if (Number(profCount?.count || 0) === 0 && data.portProfiles) {
      for (const profile of data.portProfiles) {
        await db.run(
          'INSERT INTO port_profiles (name, mode, vlan, allowed_vlans, native_vlan, description, poeMode, poePriority, poeMaxPower) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [profile.name, profile.mode, profile.vlan, profile.allowed_vlans, profile.native_vlan, profile.description, profile.poeMode, profile.poePriority, profile.poeMaxPower]
        );
      }
    }
  }

  // Sync switches from deployments if switches table is empty
  const switchCount = await db.get('SELECT COUNT(*) as count FROM switches');
  if (Number(switchCount?.count || 0) === 0) {
    await syncSwitchesFromDeployments(db);
  }
}

export async function syncSwitchesFromDeployments(db) {
  const deployments = await db.all('SELECT * FROM deployments');
  for (const dep of deployments) {
    let payload = {};
    try {
      payload = typeof dep.config_payload === 'string' ? JSON.parse(dep.config_payload) : (dep.config_payload || {});
    } catch (e) {
      payload = {};
    }

    const adminUsername = payload.adminUsername || 'admin';
    const adminPassword = payload.adminPassword || '';
    const enablePassword = payload.enablePassword || '';

    // Check if switch already exists by serial_number or mgmt_ip
    const existing = await db.get('SELECT id FROM switches WHERE serial_number = ? OR mgmt_ip = ?', [dep.serial_number, dep.mgmt_ip]);
    if (!existing) {
      await db.run(
        `INSERT INTO switches (serial_number, mac_address, hostname, model_id, mgmt_ip, admin_username, admin_password, enable_password, inventory_tag, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')`,
        [dep.serial_number, dep.mac_address, dep.hostname, dep.model_id, dep.mgmt_ip, adminUsername, adminPassword, enablePassword, dep.inventory_tag || '']
      );
    }
  }
}
