import { Tx } from './db';

export type EventKind =
  | 'created' | 'status_changed' | 'priority_changed' | 'assigned' | 'unassigned' | 'updated' | 'commented';

/** Always called with the same Tx as the change it records, so history can never disagree with the item. */
export async function logEvent(
  c: Tx, itemId: number, actorId: number, kind: EventKind, oldValue: string | null, newValue: string | null,
) {
  await c.query(
    `INSERT INTO activity_events(item_id, actor_id, kind, old_value, new_value) VALUES($1,$2,$3,$4,$5)`,
    [itemId, actorId, kind, oldValue, newValue],
  );
}

/** Transactional outbox: the job row commits (or rolls back) together with the change. */
export async function enqueue(c: Tx, type: string, payload: Record<string, unknown>) {
  await c.query(`INSERT INTO outbox(type, payload) VALUES($1,$2)`, [type, JSON.stringify(payload)]);
}
