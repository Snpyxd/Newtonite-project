import { beforeAll, describe, expect, it } from 'vitest';
import { api, createItem, fixtures } from './helpers';
import { pool } from '../src/db';

let f: Awaited<ReturnType<typeof fixtures>>;
beforeAll(async () => {
  f = await fixtures();
  await pool.query(
    `INSERT INTO work_items(title, description, type, priority, status, team_id, assignee_id, created_by)
     SELECT 'Bulk item ' || g, CASE WHEN g % 10 = 0 THEN 'chargeback dispute' ELSE 'routine' END, 'task',
            (ARRAY['low','medium','high','urgent'])[1 + g % 4], (ARRAY['open','in_progress'])[1 + g % 2],
            $1, CASE WHEN g % 3 = 0 THEN $2::bigint END, $2
     FROM generate_series(1, 300) g`, [f.a, f.m1.id]);
  await createItem(f.outsider, f.b, { title: 'Other team secret' });
});

describe('server-side pagination, filtering and search', () => {
  it('cursor pagination walks every item exactly once, newest first', async () => {
    const seen: number[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const r: any = await api.get(f.m1, `/items?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((i: any) => i.id));
      cursor = r.body.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(300);
    expect(new Set(seen).size).toBe(300);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
  });

  it('filters happen on the server', async () => {
    const urgent = await api.get(f.m1, '/items?priority=urgent&limit=100');
    expect(urgent.body.items.length).toBe(75);
    expect(urgent.body.items.every((i: any) => i.priority === 'urgent')).toBe(true);
    const mine = await api.get(f.m1, '/items?assignee=me&limit=100');
    expect(mine.body.items.length).toBe(100);
    const unassigned = await api.get(f.m1, '/items?assignee=unassigned&priority=urgent&status=open&limit=100');
    expect(unassigned.body.items.every((i: any) => i.assignee_id === null && i.status === 'open')).toBe(true);
  });

  it('full-text search finds matches and respects team scope', async () => {
    const r = await api.get(f.m1, '/items?q=chargeback&limit=100');
    expect(r.body.items).toHaveLength(30);
    expect((await api.get(f.m1, '/items?q=secret')).body.items).toHaveLength(0); // other team's item is invisible
  });

  it('dashboard returns the three attention views', async () => {
    const d = await api.get(f.lead, '/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.unassigned_urgent.total).toBeGreaterThan(0);
    expect(d.body.unassigned_urgent.items.length).toBeLessThanOrEqual(10);
    expect(d.body.assigned_to_me.total).toBe(0);
    expect(d.body.awaiting_my_approval.total).toBe(0);
    const m = await api.get(f.m1, '/dashboard');
    expect(m.body.assigned_to_me.total).toBe(100);
  });

  it('rejects bad filter values with 400', async () => {
    expect((await api.get(f.m1, '/items?status=bogus')).status).toBe(400);
    expect((await api.get(f.m1, '/items?limit=9999')).status).toBe(400);
  });
});
