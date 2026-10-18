import fs from 'fs';
import path from 'path';
import { pool } from './db';

export async function migrate() {
  const c = await pool.connect();
  try {
    // Advisory lock: api and worker may start together; only one migrates at a time.
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const done = await c.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (done.rowCount) continue;
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]);
        await c.query('COMMIT');
        console.log('applied', f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    c.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
