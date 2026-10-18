import fs from 'fs';
import path from 'path';
import { afterAll } from 'vitest';

for (const p of [path.resolve(process.cwd(), '.env'), path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env')]) {
  if (fs.existsSync(p)) {
    try {
      process.loadEnvFile(p);
      break;
    } catch {}
  }
}

// Must run before src/db.ts is imported by any test file.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://ops:ops@localhost:5432/ops_test';

afterAll(async () => {
  const { pool } = await import('../src/db');
  await pool.end();
});
