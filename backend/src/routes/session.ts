import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db';
import { authenticate, loadUser, signToken } from '../auth';
import { HttpError, forbidden } from '../errors';
import { AuthUser } from '../permissions';

export const session = Router();

async function profile(user: AuthUser) {
  const t = await pool.query(
    `SELECT m.team_id, m.role, t.name AS team_name FROM memberships m JOIN teams t ON t.id = m.team_id
     WHERE m.user_id = $1 ORDER BY t.name`,
    [user.id],
  );
  return { id: user.id, name: user.name, email: user.email, memberships: t.rows };
}

session.post('/auth/login', async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const r = await pool.query('SELECT id, password_hash FROM users WHERE lower(email)=lower($1)', [email]);
  const row = r.rows[0];
  // Same error for unknown user and wrong password: do not reveal which emails exist.
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw new HttpError(401, 'invalid_credentials', 'Wrong email or password.');
  }
  const user = (await loadUser(row.id))!;
  res.json({ token: signToken(user.id), user: await profile(user) });
});

session.get('/me', authenticate, async (req, res) => {
  res.json(await profile(req.user!));
});

// People who can be assigned work in a team (non-viewers). Only visible to team members.
session.get('/teams/:id/members', authenticate, async (req, res) => {
  const teamId = Number(req.params.id);
  if (!req.user!.memberships.has(teamId)) throw forbidden();
  const r = await pool.query(
    `SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1 AND m.role <> 'viewer' ORDER BY u.name`,
    [teamId],
  );
  res.json(r.rows);
});

session.get('/notifications', authenticate, async (req, res) => {
  const r = await pool.query(
    `SELECT id, item_id, message, created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 20`,
    [req.user!.id],
  );
  res.json(r.rows);
});
