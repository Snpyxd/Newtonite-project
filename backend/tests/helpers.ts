import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import { signToken } from '../src/auth';

export const app = createApp();
export interface U { id: number; token: string; name: string }

export async function reset() {
  await pool.query(
    'TRUNCATE outbox, notifications, idempotency_keys, activity_events, work_items, memberships, users, teams RESTART IDENTITY CASCADE',
  );
}

async function addUser(name: string, memberships: [number, string][]): Promise<U> {
  const r = await pool.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id', [
    `${name.toLowerCase()}@t.test`, name, 'x',
  ]);
  const id = r.rows[0].id;
  for (const [team, role] of memberships) {
    await pool.query('INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,$3)', [id, team, role]);
  }
  return { id, name, token: signToken(id) };
}

/** Two teams. Team A: lead, two members, a viewer. Team B: one member (the "outsider" for A). */
export async function fixtures() {
  await reset();
  const a = (await pool.query(`INSERT INTO teams(name) VALUES('Team A') RETURNING id`)).rows[0].id as number;
  const b = (await pool.query(`INSERT INTO teams(name) VALUES('Team B') RETURNING id`)).rows[0].id as number;
  return {
    a, b,
    lead: await addUser('Lead', [[a, 'lead']]),
    m1: await addUser('Member1', [[a, 'member']]),
    m2: await addUser('Member2', [[a, 'member']]),
    viewer: await addUser('Viewer', [[a, 'viewer']]),
    outsider: await addUser('Outsider', [[b, 'member']]),
  };
}

export const authed = (u: U) => ({ Authorization: `Bearer ${u.token}` });
export const key = () => crypto.randomUUID();

export async function createItem(u: U, team_id: number, extra: Record<string, unknown> = {}) {
  const res = await request(app).post('/items').set(authed(u))
    .send({ title: 'Payment stuck', description: 'Refund pending', type: 'payment', priority: 'high', team_id, ...extra });
  if (res.status !== 201) throw new Error(`createItem failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export const api = {
  get: (u: U, path: string) => request(app).get(path).set(authed(u)),
  post: (u: U, path: string, body: object = {}, k?: string) => {
    const r = request(app).post(path).set(authed(u));
    return (k ? r.set('Idempotency-Key', k) : r).send(body);
  },
  patch: (u: U, path: string, body: object) => request(app).patch(path).set(authed(u)).send(body),
};

export const events = async (itemId: number) =>
  (await pool.query('SELECT kind, old_value, new_value FROM activity_events WHERE item_id=$1 ORDER BY id', [itemId])).rows;
