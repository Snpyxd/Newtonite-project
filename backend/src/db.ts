import pg from 'pg';
import { config } from './config';

// Return BIGINT as number and DATE as 'YYYY-MM-DD' (not a shifted JS Date).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
export type Tx = pg.PoolClient;

/** Run fn inside one transaction. Any throw rolls everything back. */
export async function tx<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
