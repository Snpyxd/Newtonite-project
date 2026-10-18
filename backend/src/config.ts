import fs from 'fs';
import path from 'path';

for (const p of [path.resolve(process.cwd(), '.env'), path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env')]) {
  if (fs.existsSync(p)) {
    try {
      process.loadEnvFile(p);
      break;
    } catch {}
  }
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ops:ops@localhost:5432/ops',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  port: Number(process.env.PORT ?? 3000),
};

