import { pool, tx, Tx } from './db';

export const MAX_ATTEMPTS = 5;
export interface Job { id: number; type: string; payload: any; attempts: number }
export type Handler = (job: Job, c: Tx) => Promise<void>;

/**
 * Idempotent handler: notifications.job_id is UNIQUE, so running the same job twice
 * (crash after "send", manual re-queue, duplicate delivery) yields exactly one notification.
 */
export const deliverNotification: Handler = async (job, c) => {
  if (job.type !== 'notify_assignee') throw new Error(`unknown job type ${job.type}`);
  const { user_id, item_id, reason } = job.payload;
  const item = await c.query('SELECT title FROM work_items WHERE id=$1', [item_id]);
  const message = reason === 'assigned' || reason === 'claimed'
    ? `You were assigned: ${item.rows[0]?.title}`
    : `Item "${item.rows[0]?.title}" is now ${String(reason).replace('status:', '')}`;
  const ins = await c.query(
    `INSERT INTO notifications(job_id, user_id, item_id, message) VALUES($1,$2,$3,$4) ON CONFLICT (job_id) DO NOTHING`,
    [job.id, user_id, item_id, message],
  );
  if (ins.rowCount && process.env.NODE_ENV !== 'test') console.log(`[notify] user ${user_id}: ${message}`); // stand-in for email/push
};

/** Claim a batch with FOR UPDATE SKIP LOCKED so several workers never take the same job. */
export async function processBatch(handler: Handler = deliverNotification, batch = 10): Promise<number> {
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, type, payload, attempts FROM outbox
       WHERE status = 'pending' AND next_run_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    for (const job of rows as Job[]) {
      await c.query('SAVEPOINT job'); // a failing job must not poison the rest of the batch
      try {
        await handler(job, c);
        await c.query(
          `UPDATE outbox SET status='done', attempts=attempts+1, processed_at=now(), last_error=NULL WHERE id=$1`,
          [job.id],
        );
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT job');
        const attempts = job.attempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        await c.query(
          `UPDATE outbox SET attempts=$2, status=$3, last_error=$4, next_run_at = now() + make_interval(secs => $5) WHERE id=$1`,
          [job.id, attempts, failed ? 'failed' : 'pending', String((e as Error).message ?? e), 2 ** attempts], // 2s,4s,8s,16s backoff
        );
      }
      await c.query('RELEASE SAVEPOINT job');
    }
    return rows.length;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let running = true;
  process.on('SIGTERM', () => (running = false));
  console.log('worker started');
  while (running) {
    try {
      if ((await processBatch()) === 0) await sleep(1000);
    } catch (e) {
      console.error('worker error (will retry)', e); // e.g. database down: keep looping
      await sleep(3000);
    }
  }
  await pool.end();
}

if (require.main === module) main();
