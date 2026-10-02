import { InfluxDB, Point } from '@influxdata/influxdb-client';
import { getDB } from './db.js';

let influxClient = null;
let writeApi = null;
let queryApi = null;
let isInfluxReady = false;

export function initInflux() {
  const url = process.env.INFLUX_URL || 'http://localhost:8086';
  const token = process.env.INFLUX_TOKEN || 'ruijie-secret-fleet-token-12345';
  const org = process.env.INFLUX_ORG || 'ruijie_fleet';
  const bucket = process.env.INFLUX_BUCKET || 'switch_metrics';

  try {
    influxClient = new InfluxDB({ url, token, timeout: 2000 });
    writeApi = influxClient.getWriteApi(org, bucket, 'ms');
    queryApi = influxClient.getQueryApi(org);
    isInfluxReady = true;
    console.log(`InfluxDB client configured for ${url} (org: ${org}, bucket: ${bucket})`);
  } catch (err) {
    console.warn('InfluxDB client initialization error:', err.message);
    isInfluxReady = false;
  }
}

export async function recordOpticalMetrics(switchId, hostname, opticalList = []) {
  const db = getDB();
  const timestamp = new Date().toISOString();

  for (const opt of opticalList) {
    if (opt.rxPower === null && opt.txPower === null && opt.temperature === null) continue;

    // 1. Write to InfluxDB if available
    if (isInfluxReady && writeApi) {
      try {
        const point = new Point('optical_ddm')
          .tag('switch_id', String(switchId))
          .tag('hostname', hostname || '')
          .tag('port', opt.portShort || opt.port)
          .floatField('rx_power', opt.rxPower ?? 0)
          .floatField('tx_power', opt.txPower ?? 0)
          .floatField('temperature', opt.temperature ?? 0)
          .floatField('voltage', opt.voltage ?? 0)
          .stringField('status', opt.status || 'normal');

        writeApi.writePoint(point);
      } catch (err) {
        // Non-blocking error
      }
    }

    // 2. Also record to SQL DB table for backup and direct querying
    if (db) {
      try {
        await db.run(
          `INSERT INTO telemetry_history (switch_id, port_name, rx_power, tx_power, temperature, voltage, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [switchId, opt.portShort || opt.port, opt.rxPower, opt.txPower, opt.temperature, opt.voltage, opt.status || 'normal']
        );
      } catch (err) {
        // Ignore DB insert errors
      }
    }
  }

  if (isInfluxReady && writeApi) {
    try {
      await writeApi.flush();
    } catch (e) {
      // Influx might not be running in local standalone dev
    }
  }
}

export async function getOpticalHistory(switchId, port = null, hours = 24) {
  const db = getDB();
  // Try querying DB table
  try {
    let sql = 'SELECT * FROM telemetry_history WHERE switch_id = ?';
    const params = [switchId];
    if (port) {
      sql += ' AND port_name = ?';
      params.push(port);
    }
    sql += ' ORDER BY created_at DESC LIMIT 100';
    const rows = await db.all(sql, params);
    return rows.reverse();
  } catch (e) {
    return [];
  }
}
