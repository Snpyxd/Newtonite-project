import { beforeEach, describe, expect, it } from 'vitest';
import { api, createItem, fixtures, key } from './helpers';
import { pool } from '../src/db';

let f: Awaited<ReturnType<typeof fixtures>>;
beforeEach(async () => { f = await fixtures(); });
const body = () => ({ title: 'Double click', type: 'task', priority: 'low', team_id: f.a });
const count = async () => (await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n;

describe('idempotency keys', () => {
  it('same key sent twice creates one item and returns the same response', async () => {
    const k = key();
    const r1 = await api.post(f.m1, '/items', body(), k);
    const r2 = await api.post(f.m1, '/items', body(), k);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.headers['idempotent-replay']).toBe('true');
    expect(await count()).toBe(1);
  });

  it('five simultaneous requests with one key (double-click storm) create exactly one item', async () => {
    const k = key();
    const rs = await Promise.all(Array.from({ length: 5 }, () => api.post(f.m1, '/items', body(), k)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await count()).toBe(1);
  });

  it('without a key two requests create two items (the key is what makes it safe)', async () => {
    await api.post(f.m1, '/items', body());
    await api.post(f.m1, '/items', body());
    expect(await count()).toBe(2);
  });

  it('reusing a key for a DIFFERENT request is rejected with 422', async () => {
    const k = key();
    await api.post(f.m1, '/items', body(), k);
    const r = await api.post(f.m1, '/items', { ...body(), title: 'Something else' }, k);
    expect(r.status).toBe(422);
    expect(await count()).toBe(1);
  });

  it('keys are scoped per user', async () => {
    const k = key();
    await api.post(f.m1, '/items', body(), k);
    await api.post(f.m2, '/items', body(), k);
    expect(await count()).toBe(2);
  });

  it('a failed request does not burn the key: a retry runs again', async () => {
    const k = key();
    const bad = await api.post(f.m1, '/items', { ...body(), team_id: f.b }, k); // not in team B -> 403
    expect(bad.status).toBe(403);
    const ok = await api.post(f.m1, '/items', body(), k); // same key, different body, but first attempt left no trace
    expect(ok.status).toBe(201);
  });

  it('idempotent claim retry returns the stored success instead of a 409', async () => {
    const item = await createItem(f.lead, f.a);
    const k = key();
    const r1 = await api.post(f.m1, `/items/${item.id}/claim`, {}, k);
    const r2 = await api.post(f.m1, `/items/${item.id}/claim`, {}, k);
    expect([r1.status, r2.status]).toEqual([200, 200]);
  });
});
