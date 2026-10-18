import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { pool } from './db';
import { unauthorized } from './errors';
import { AuthUser, Role } from './permissions';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const signToken = (userId: number) => jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: '12h' });

export async function loadUser(userId: number): Promise<AuthUser | null> {
  const u = await pool.query('SELECT id, name, email FROM users WHERE id=$1', [userId]);
  if (!u.rowCount) return null;
  const m = await pool.query('SELECT team_id, role FROM memberships WHERE user_id=$1', [userId]);
  return {
    ...u.rows[0],
    memberships: new Map<number, Role>(m.rows.map((r) => [r.team_id, r.role])),
  };
}

/** Roles are re-read from the DB on every request, so a role change takes effect immediately. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.header('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  let userId: number;
  try {
    userId = Number((jwt.verify(token, config.jwtSecret) as { sub: string }).sub);
  } catch {
    throw unauthorized();
  }
  const user = await loadUser(userId);
  if (!user) throw unauthorized();
  req.user = user;
  next();
}
