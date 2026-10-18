import { beforeEach, describe, expect, it } from 'vitest';
import { api, createItem, events, fixtures } from './helpers';
import { pool } from '../src/db';

let f: Awaited<ReturnType<typeof fixtures>>;
beforeEach(async () => { f = await fixtures(); });

describe('concurrent claim', () => {
  it('two users claim at the same time: exactly one wins, the other gets 409', async () => {
    const item = await createItem(f.lead, f.a);
    const [r1, r2] = await Promise.all([
      api.post(f.m1, `/items/${item.id}/claim`),
      api.post(f.m2, `/items/${item.id}/claim`),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const winner = r1.status === 200 ? f.m1 : f.m2;
    const row = (await pool.query('SELECT assignee_id, version FROM work_items WHERE id=$1', [item.id])).rows[0];
    expect(row.assignee_id).toBe(winner.id);
    expect(row.version).toBe(2);
    const assigned = (await events(item.id)).filter((e) => e.kind === 'assigned');
    expect(assigned).toHaveLength(1); // history agrees with the item
  });

  it('ten parallel claims: still exactly one winner', async () => {
    const item = await createItem(f.lead, f.a);
    const users = [f.m1, f.m2, f.lead, f.m1, f.m2, f.lead, f.m1, f.m2, f.lead, f.m1];
    const results = await Promise.all(users.map((u) => api.post(u, `/items/${item.id}/claim`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });

  it('409 body tells the loser who has it', async () => {
    const item = await createItem(f.lead, f.a);
    await api.post(f.m1, `/items/${item.id}/claim`);
    const r = await api.post(f.m2, `/items/${item.id}/claim`);
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('Member1');
  });
});

describe('stale update (optimistic locking)', () => {
  it('rejects an edit made against an old version and leaves data unchanged', async () => {
    const item = await createItem(f.lead, f.a);
    const first = await api.patch(f.m1, `/items/${item.id}`, { version: item.version, title: 'Edited by Member1' });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(2);

    const stale = await api.patch(f.m2, `/items/${item.id}`, { version: item.version, title: 'Edited by Member2' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('version_conflict');
    expect(stale.body.current.title).toBe('Edited by Member1'); // latest item is returned
    const row = (await pool.query('SELECT title, version FROM work_items WHERE id=$1', [item.id])).rows[0];
    expect(row).toEqual({ title: 'Edited by Member1', version: 2 });
  });

  it('two simultaneous edits from the same version: one wins, one 409', async () => {
    const item = await createItem(f.lead, f.a);
    const rs = await Promise.all([
      api.patch(f.m1, `/items/${item.id}`, { version: 1, priority: 'low' }),
      api.patch(f.m2, `/items/${item.id}`, { version: 1, priority: 'urgent' }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await events(item.id)).filter((e) => e.kind === 'priority_changed')).toHaveLength(1);
  });

  it('a stale transition is also rejected', async () => {
    const item = await createItem(f.lead, f.a);
    await api.patch(f.m1, `/items/${item.id}`, { version: 1, priority: 'low' });
    const r = await api.post(f.m2, `/items/${item.id}/transition`, { to: 'in_progress', version: 1 });
    expect(r.status).toBe(409);
  });
});
