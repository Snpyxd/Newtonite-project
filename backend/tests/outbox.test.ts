import { beforeEach, describe, expect, it } from 'vitest';
import { api, createItem, fixtures } from './helpers';
import { pool } from '../src/db';
import { MAX_ATTEMPTS, deliverNotification, processBatch } from '../src/worker';

let f: Awaited<ReturnType<typeof fixtures>>;
beforeEach(async () => { f = await fixtures(); });
const outbox = async () => (await pool.query('SELECT * FROM outbox ORDER BY id')).rows;
const notes = async () => (await pool.query('SELECT * FROM notifications')).rows;

describe('transactional outbox + worker', () => {
  it('a claim writes the outbox row in the same transaction as the change', async () => {
    const item = await createItem(f.lead, f.a);
    await api.post(f.m1, `/items/${item.id}/claim`);
    const jobs = await outbox();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'notify_assignee', status: 'pending', attempts: 0 });
    expect(jobs[0].payload).toMatchObject({ item_id: item.id, user_id: f.m1.id });
  });

  it('a rolled-back request leaves no outbox row behind', async () => {
    const item = await createItem(f.lead, f.a);
    await api.patch(f.lead, `/items/${item.id}`, { version: 1, assignee_id: f.viewer.id }); // 422 after validation
    await api.post(f.outsider, `/items/${item.id}/claim`); // 403
    expect(await outbox()).toHaveLength(0);
  });

  it('worker delivers the notification and marks the job done', async () => {
    const item = await createItem(f.lead, f.a);
    await api.post(f.m1, `/items/${item.id}/claim`);
    expect(await processBatch()).toBe(1);
    expect((await outbox())[0]).toMatchObject({ status: 'done', attempts: 1 });
    expect(await notes()).toHaveLength(1);
    expect(await processBatch()).toBe(0); // nothing left
  });

  it('processing the same job twice produces ONE notification (idempotent handler)', async () => {
    const item = await createItem(f.lead, f.a);
    await api.post(f.m1, `/items/${item.id}/claim`);
    await processBatch();
    await pool.query(`UPDATE outbox SET status='pending'`); // simulate duplicate delivery / re-queue
    await processBatch();
    expect(await notes()).toHaveLength(1);
  });

  it('a failing job is retried with backoff, then marked failed after the attempt cap', async () => {
    const item = await createItem(f.lead, f.a);
    await api.post(f.m1, `/items/${item.id}/claim`);
    const boom = async () => { throw new Error('smtp down'); };

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await processBatch(boom);
      const job = (await outbox())[0];
      expect(job.attempts).toBe(i);
      expect(job.last_error).toContain('smtp down');
      if (i < MAX_ATTEMPTS) {
        expect(job.status).toBe('pending');
        expect(new Date(job.next_run_at).getTime()).toBeGreaterThan(Date.now()); // backoff: not due yet
        expect(await processBatch(boom)).toBe(0); // so the worker skips it for now
        await pool.query(`UPDATE outbox SET next_run_at = now()`); // fast-forward the clock
      }
    }
    expect((await outbox())[0].status).toBe('failed');
    await processBatch(deliverNotification);
    expect(await notes()).toHaveLength(0); // failed jobs are never picked up again
  });

  it('one bad job does not block the good ones in the same batch', async () => {
    const item = await createItem(f.lead, f.a);
    await api.post(f.m1, `/items/${item.id}/claim`);
    await pool.query(`INSERT INTO outbox(type, payload) VALUES('explode', '{}')`);
    await processBatch();
    const jobs = await outbox();
    expect(jobs.find((j) => j.type === 'notify_assignee')!.status).toBe('done');
    expect(jobs.find((j) => j.type === 'explode')!.status).toBe('pending');
    expect(await notes()).toHaveLength(1);
  });

  it('two workers running at once never double-process a job', async () => {
    const item = await createItem(f.lead, f.a);
    for (let i = 0; i < 6; i++) await api.patch(f.lead, `/items/${item.id}`, { version: i + 1, assignee_id: i % 2 ? f.m1.id : f.m2.id });
    const handled: number[] = [];
    const slow = async (job: any, c: any) => { handled.push(job.id); await new Promise((r) => setTimeout(r, 50)); await deliverNotification(job, c); };
    await Promise.all([processBatch(slow, 10), processBatch(slow, 10)]);
    expect(new Set(handled).size).toBe(handled.length); // SKIP LOCKED
    expect(await notes()).toHaveLength(6);
  });
});
