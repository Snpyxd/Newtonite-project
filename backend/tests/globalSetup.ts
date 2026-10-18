import fs from 'fs';
import path from 'path';
import pg from 'pg';

for (const p of [path.resolve(process.cwd(), '.env'), path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env')]) {
  if (fs.existsSync(p)) {
    try {
      process.loadEnvFile(p);
      break;
    } catch {}
  }
}

/** Creates the ops_test database if needed and applies migrations once per test run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://ops:ops@localhost:5432/ops_test';
  const u = new URL(url);
  const dbName = u.pathname.slice(1);
  u.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: u.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  process.env.DATABASE_URL = url;
  const { migrate } = await import('../src/migrate');
  const { pool } = await import('../src/db');
  await migrate();
  await pool.end();
}
