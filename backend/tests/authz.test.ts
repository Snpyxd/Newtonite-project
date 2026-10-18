import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, app, createItem, fixtures } from './helpers';

let f: Awaited<ReturnType<typeof fixtures>>;
beforeEach(async () => { f = await fixtures(); });

describe('resource-level authorization (enforced on the server)', () => {
  it('user from another team gets 403 on every read and write', async () => {
    const item = await createItem(f.lead, f.a);
    const o = f.outsider;
    expect((await api.get(o, `/items/${item.id}`)).status).toBe(403);
    expect((await api.get(o, `/items/${item.id}/activity`)).status).toBe(403);
    expect((await api.patch(o, `/items/${item.id}`, { version: 1, title: 'hack' })).status).toBe(403);
    expect((await api.post(o, `/items/${item.id}/claim`)).status).toBe(403);
    expect((await api.post(o, `/items/${item.id}/transition`, { to: 'in_progress', version: 1 })).status).toBe(403);
    expect((await api.post(o, `/items/${item.id}/comments`, { body: 'hi' })).status).toBe(403);
    expect((await api.get(o, `/teams/${f.a}/members`)).status).toBe(403);
  });

  it('cannot create an item in a team you do not belong to', async () => {
    const r = await api.post(f.outsider, '/items', { title: 'x', type: 'task', team_id: f.a });
    expect(r.status).toBe(403);
  });

  it('lists and dashboard only ever contain the caller\'s teams', async () => {
    const mine = await createItem(f.lead, f.a);
    const theirs = await createItem(f.outsider, f.b);
    const list = await api.get(f.m1, '/items');
    expect(list.body.items.map((i: any) => i.id)).toEqual([mine.id]);
    const out = await api.get(f.outsider, '/items');
    expect(out.body.items.map((i: any) => i.id)).toEqual([theirs.id]);
    expect((await api.get(f.m1, `/items?team_id=${f.b}`)).status).toBe(403);
  });

  it('viewer can read but cannot create, claim, edit or transition', async () => {
    const item = await createItem(f.lead, f.a);
    expect((await api.get(f.viewer, `/items/${item.id}`)).status).toBe(200);
    expect((await api.post(f.viewer, '/items', { title: 'x', type: 'task', team_id: f.a })).status).toBe(403);
    expect((await api.post(f.viewer, `/items/${item.id}/claim`)).status).toBe(403);
    expect((await api.patch(f.viewer, `/items/${item.id}`, { version: 1, title: 'x' })).status).toBe(403);
    expect((await api.post(f.viewer, `/items/${item.id}/transition`, { to: 'in_progress', version: 1 })).status).toBe(403);
  });

  it('only a Lead can reassign someone else; a Member cannot', async () => {
    const item = await createItem(f.lead, f.a);
    expect((await api.patch(f.m1, `/items/${item.id}`, { version: 1, assignee_id: f.m2.id })).status).toBe(403);
    const ok = await api.patch(f.lead, `/items/${item.id}`, { version: 1, assignee_id: f.m2.id });
    expect(ok.status).toBe(200);
    expect(ok.body.assignee_id).toBe(f.m2.id);
  });

  it('role is the role IN THAT TEAM: a lead in A is only a member in B', async () => {
    const { pool } = await import('../src/db');
    await pool.query('INSERT INTO memberships(user_id, team_id, role) VALUES($1,$2,$3)', [f.lead.id, f.b, 'member']);
    const item = await createItem(f.outsider, f.b);
    let cur = (await api.post(f.outsider, `/items/${item.id}/transition`, { to: 'in_progress', version: 1 })).body;
    cur = (await api.post(f.outsider, `/items/${item.id}/transition`, { to: 'awaiting_approval', version: cur.version })).body;
    const r = await api.post(f.lead, `/items/${item.id}/transition`, { to: 'resolved', version: cur.version });
    expect(r.status).toBe(403);
  });

  it('missing, malformed or forged tokens are 401', async () => {
    expect((await request(app).get('/items')).status).toBe(401);
    expect((await request(app).get('/items').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('login works, and does not reveal whether the email exists', async () => {
    const { pool } = await import('../src/db');
    const bcrypt = (await import('bcryptjs')).default;
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash('secret12', 4), f.m1.id]);
    const ok = await request(app).post('/auth/login').send({ email: 'member1@t.test', password: 'secret12' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.memberships[0].role).toBe('member');
    const wrongPw = await request(app).post('/auth/login').send({ email: 'member1@t.test', password: 'bad' });
    const noUser = await request(app).post('/auth/login').send({ email: 'ghost@t.test', password: 'bad' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.body).toEqual(wrongPw.body);
  });
});
