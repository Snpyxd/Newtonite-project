import { beforeEach, describe, expect, it } from 'vitest';
import { api, createItem, events, fixtures } from './helpers';
import { pool } from '../src/db';

let f: Awaited<ReturnType<typeof fixtures>>;
beforeEach(async () => { f = await fixtures(); });

async function toAwaitingApproval() {
  let item = await createItem(f.m1, f.a);
  item = (await api.post(f.m1, `/items/${item.id}/transition`, { to: 'in_progress', version: item.version })).body;
  item = (await api.post(f.m1, `/items/${item.id}/transition`, { to: 'awaiting_approval', version: item.version })).body;
  return item;
}

describe('workflow rules', () => {
  it('rejects an invalid jump (open -> closed) and changes nothing', async () => {
    const item = await createItem(f.lead, f.a);
    const r = await api.post(f.lead, `/items/${item.id}/transition`, { to: 'closed', version: item.version });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('invalid_transition');
    const row = (await pool.query('SELECT status, version FROM work_items WHERE id=$1', [item.id])).rows[0];
    expect(row).toEqual({ status: 'open', version: 1 });
  });

  it('a Member cannot approve; a Lead of the team can', async () => {
    const item = await toAwaitingApproval();
    const denied = await api.post(f.m2, `/items/${item.id}/transition`, { to: 'resolved', version: item.version });
    expect(denied.status).toBe(403);
    const ok = await api.post(f.lead, `/items/${item.id}/transition`, { to: 'resolved', version: item.version });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('resolved');
  });

  it('a Lead of ANOTHER team cannot approve', async () => {
    const item = await toAwaitingApproval();
    const r = await api.post(f.outsider, `/items/${item.id}/transition`, { to: 'resolved', version: item.version });
    expect(r.status).toBe(403);
  });

  it('full happy path writes one history event per change, in order', async () => {
    const item = await toAwaitingApproval();
    const a = await api.post(f.lead, `/items/${item.id}/transition`, { to: 'resolved', version: item.version });
    await api.post(f.lead, `/items/${item.id}/transition`, { to: 'closed', version: a.body.version });
    const ev = await events(item.id);
    expect(ev.map((e) => `${e.kind}:${e.old_value ?? ''}>${e.new_value}`)).toEqual([
      'created:>Payment stuck',
      'status_changed:open>in_progress',
      'status_changed:in_progress>awaiting_approval',
      'status_changed:awaiting_approval>resolved',
      'status_changed:resolved>closed',
    ]);
  });

  it('closed items cannot be edited or transitioned', async () => {
    let item = await toAwaitingApproval();
    item = (await api.post(f.lead, `/items/${item.id}/transition`, { to: 'resolved', version: item.version })).body;
    item = (await api.post(f.lead, `/items/${item.id}/transition`, { to: 'closed', version: item.version })).body;
    expect((await api.patch(f.lead, `/items/${item.id}`, { version: item.version, title: 'x' })).status).toBe(422);
    expect((await api.post(f.lead, `/items/${item.id}/transition`, { to: 'open', version: item.version })).status).toBe(422);
  });

  it('the server tells each user which transitions they may take', async () => {
    const item = await toAwaitingApproval();
    expect((await api.get(f.m1, `/items/${item.id}`)).body.permissions.transitions).toEqual([]);
    expect((await api.get(f.lead, `/items/${item.id}`)).body.permissions.transitions.sort()).toEqual(['in_progress', 'resolved']);
  });

  it('item change and its history roll back together if anything fails', async () => {
    const item = await createItem(f.lead, f.a);
    // Reassign to a viewer: the update would succeed but validation fails -> nothing may be written.
    const r = await api.patch(f.lead, `/items/${item.id}`, { version: 1, priority: 'urgent', assignee_id: f.viewer.id });
    expect(r.status).toBe(422);
    const row = (await pool.query('SELECT priority, version FROM work_items WHERE id=$1', [item.id])).rows[0];
    expect(row).toEqual({ priority: 'high', version: 1 });
    expect(await events(item.id)).toHaveLength(1); // only 'created'
  });

  it('activity log is append-only at the database level', async () => {
    const item = await createItem(f.lead, f.a);
    await expect(pool.query('UPDATE activity_events SET kind=$1 WHERE item_id=$2', ['updated', item.id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM activity_events WHERE item_id=$1', [item.id])).rejects.toThrow(/append-only/);
  });

  it('comments are recorded in the activity log', async () => {
    const item = await createItem(f.lead, f.a);
    const r = await api.post(f.m1, `/items/${item.id}/comments`, { body: 'Looking into it' });
    expect(r.status).toBe(201);
    const act = await api.get(f.viewer, `/items/${item.id}/activity`); // viewers can read...
    expect(act.body.events[0]).toMatchObject({ kind: 'commented', new_value: 'Looking into it', actor_name: 'Member1' });
    expect((await api.post(f.viewer, `/items/${item.id}/comments`, { body: 'hi' })).status).toBe(403); // ...not write
  });
});
