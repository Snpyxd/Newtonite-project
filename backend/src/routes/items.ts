import { Request, Router } from 'express';
import { z } from 'zod';
import { pool, Tx } from '../db';
import { authenticate } from '../auth';
import { HttpError, forbidden, notFound } from '../errors';
import { Action, AuthUser, assertCan, can, teamsWith } from '../permissions';
import { PRIORITIES, STATUSES, TRANSITIONS, TYPES, Status } from '../workflow';
import { enqueue, logEvent } from '../events';
import { mutation } from '../idempotency';

export const items = Router();
items.use(authenticate);

type Q = Pick<Tx, 'query'>;
const COLS = `w.id, w.title, w.description, w.type, w.priority, w.status, w.team_id, w.assignee_id,
  w.created_by, w.due_date, w.version, w.created_at, w.updated_at,
  t.name AS team_name, a.name AS assignee_name, cb.name AS created_by_name`;
const FROM = `FROM work_items w JOIN teams t ON t.id = w.team_id
  LEFT JOIN users a ON a.id = w.assignee_id JOIN users cb ON cb.id = w.created_by`;

const idOf = (req: Request, name = 'id') => z.coerce.number().int().positive().parse(req.params[name]);

async function fetchItem(c: Q, id: number) {
  const r = await c.query(`SELECT ${COLS} ${FROM} WHERE w.id = $1`, [id]);
  return r.rows[0];
}

/** Load a raw item and enforce a permission on its team. 404 if missing, 403 if not allowed. */
async function loadAuthorized(c: Q, id: number, user: AuthUser, action: Action) {
  const item = await fetchItem(c, id);
  if (!item) throw notFound('Work item not found.');
  assertCan(user, action, item.team_id);
  return item;
}

/** What THIS user may do with the item. Computed by the server, so the UI never guesses. */
function withPermissions(user: AuthUser, item: any) {
  const closed = item.status === 'closed';
  const transitions = (Object.entries(TRANSITIONS[item.status as Status]) as [Status, Action][])
    .filter(([, action]) => can(user, action, item.team_id))
    .map(([to]) => to);
  return {
    ...item,
    permissions: {
      can_edit: !closed && can(user, 'item:update', item.team_id),
      can_claim: !closed && item.status !== 'resolved' && !item.assignee_id && can(user, 'item:claim', item.team_id),
      can_assign: !closed && can(user, 'item:assign', item.team_id),
      can_comment: can(user, 'item:comment', item.team_id),
      transitions,
    },
  };
}

async function conflict(c: Q, id: number) {
  return new HttpError(409, 'version_conflict', 'This item was changed by someone else. Reload to see the latest version.', {
    current: await fetchItem(c, id),
  });
}

async function assertAssignable(c: Q, userId: number, teamId: number) {
  const r = await c.query(`SELECT role FROM memberships WHERE user_id=$1 AND team_id=$2`, [userId, teamId]);
  if (!r.rowCount || r.rows[0].role === 'viewer') {
    throw new HttpError(422, 'invalid_assignee', 'Assignee must be a non-viewer member of the item\'s team.');
  }
}

const nameOf = async (c: Q, userId: number | null) =>
  userId == null ? null : ((await c.query('SELECT name FROM users WHERE id=$1', [userId])).rows[0]?.name ?? null);

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

// ---------------------------------------------------------------- list (server-side filter/search/cursor)
const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(TYPES).optional(),
  team_id: z.coerce.number().int().optional(),
  assignee: z.string().regex(/^(me|unassigned|\d+)$/).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

async function queryItems(c: Q, where: string[], params: unknown[], limit: number, cursor?: number) {
  const w = [...where];
  const p = [...params];
  if (cursor) {
    p.push(cursor);
    w.push(`w.id < $${p.length}`);
  }
  p.push(limit + 1);
  const r = await c.query(`SELECT ${COLS} ${FROM} WHERE ${w.join(' AND ')} ORDER BY w.id DESC LIMIT $${p.length}`, p);
  const page = r.rows.slice(0, limit);
  return { items: page, next_cursor: r.rows.length > limit ? page[page.length - 1].id : null };
}

items.get('/items', async (req, res) => {
  const f = listSchema.parse(req.query);
  const user = req.user!;
  const teamIds = [...user.memberships.keys()]; // scope: only teams the caller belongs to
  const where = ['w.team_id = ANY($1)'];
  const params: unknown[] = [teamIds];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.team_id !== undefined) {
    if (!user.memberships.has(f.team_id)) throw forbidden();
    add('w.team_id = ?', f.team_id);
  }
  if (f.status) add('w.status = ?', f.status);
  if (f.priority) add('w.priority = ?', f.priority);
  if (f.type) add('w.type = ?', f.type);
  if (f.assignee === 'me') add('w.assignee_id = ?', user.id);
  else if (f.assignee === 'unassigned') where.push('w.assignee_id IS NULL');
  else if (f.assignee) add('w.assignee_id = ?', Number(f.assignee));
  if (f.q) add(`w.search @@ websearch_to_tsquery('english', ?)`, f.q);
  res.json(await queryItems(pool, where, params, f.limit, f.cursor));
});

// ---------------------------------------------------------------- dashboard
items.get('/dashboard', async (req, res) => {
  const user = req.user!;
  const teamIds = [...user.memberships.keys()];
  const approverTeams = teamsWith(user, 'item:approve');
  const open = `w.status NOT IN ('resolved','closed')`;
  const views = {
    assigned_to_me: { where: [`w.team_id = ANY($1)`, `w.assignee_id = $2`, open], params: [teamIds, user.id] },
    unassigned_urgent: { where: [`w.team_id = ANY($1)`, `w.assignee_id IS NULL`, `w.priority = 'urgent'`, open], params: [teamIds] },
    awaiting_my_approval: { where: [`w.team_id = ANY($1)`, `w.status = 'awaiting_approval'`], params: [approverTeams] },
  };
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(views)) {
    const [list, total] = await Promise.all([
      queryItems(pool, v.where, v.params, 10),
      pool.query(`SELECT count(*)::int AS n FROM work_items w WHERE ${v.where.join(' AND ')}`, v.params),
    ]);
    out[name] = { total: total.rows[0].n, items: list.items };
  }
  res.json(out);
});

// ---------------------------------------------------------------- create
const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  type: z.enum(TYPES),
  priority: z.enum(PRIORITIES).default('medium'),
  team_id: z.number().int(),
  assignee_id: z.number().int().nullable().optional(),
  due_date: date.nullable().optional(),
});

items.post('/items', mutation(async (req, c) => {
  const user = req.user!;
  const b = createSchema.parse(req.body);
  assertCan(user, 'item:create', b.team_id);
  if (b.assignee_id && b.assignee_id !== user.id) assertCan(user, 'item:assign', b.team_id);
  if (b.assignee_id) await assertAssignable(c, b.assignee_id, b.team_id);
  const ins = await c.query(
    `INSERT INTO work_items(title, description, type, priority, team_id, assignee_id, created_by, due_date)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [b.title, b.description, b.type, b.priority, b.team_id, b.assignee_id ?? null, user.id, b.due_date ?? null],
  );
  const id = ins.rows[0].id;
  await logEvent(c, id, user.id, 'created', null, b.title);
  if (b.assignee_id) {
    await logEvent(c, id, user.id, 'assigned', null, await nameOf(c, b.assignee_id));
    await enqueue(c, 'notify_assignee', { item_id: id, user_id: b.assignee_id, reason: 'assigned' });
  }
  return { status: 201, body: withPermissions(user, await fetchItem(c, id)) };
}));

// ---------------------------------------------------------------- detail
items.get('/items/:id', async (req, res) => {
  const item = await loadAuthorized(pool, idOf(req), req.user!, 'item:read');
  res.json(withPermissions(req.user!, item));
});

// ---------------------------------------------------------------- update (optimistic locking)
const patchSchema = z.object({
  version: z.number().int(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  type: z.enum(TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  due_date: date.nullable().optional(),
  assignee_id: z.number().int().nullable().optional(),
});

items.patch('/items/:id', mutation(async (req, c) => {
  const user = req.user!;
  const id = idOf(req);
  const b = patchSchema.parse(req.body);
  const item = await loadAuthorized(c, id, user, 'item:update');
  if (item.status === 'closed') throw new HttpError(422, 'item_closed', 'Closed items cannot be edited.');
  if (item.version !== b.version) throw await conflict(c, id);

  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  const changedFields: string[] = [];
  for (const f of ['title', 'description', 'type', 'due_date'] as const) {
    if (b[f] !== undefined && b[f] !== item[f]) {
      set(f, b[f]);
      changedFields.push(f);
    }
  }
  const priorityChanged = b.priority !== undefined && b.priority !== item.priority;
  if (priorityChanged) set('priority', b.priority);
  const assigneeChanged = b.assignee_id !== undefined && b.assignee_id !== item.assignee_id;
  if (assigneeChanged) {
    assertCan(user, 'item:assign', item.team_id); // reassigning is a Lead action
    if (b.assignee_id) await assertAssignable(c, b.assignee_id, item.team_id);
    set('assignee_id', b.assignee_id);
  }
  if (!sets.length) return { status: 200, body: withPermissions(user, item) }; // nothing changed: no version bump

  vals.push(id, b.version);
  const upd = await c.query(
    `UPDATE work_items SET ${sets.join(', ')}, version = version + 1, updated_at = now()
     WHERE id = $${vals.length - 1} AND version = $${vals.length} RETURNING id`,
    vals,
  );
  if (upd.rowCount === 0) throw await conflict(c, id); // someone slipped in between our read and write

  if (changedFields.length) await logEvent(c, id, user.id, 'updated', null, changedFields.join(', '));
  if (priorityChanged) await logEvent(c, id, user.id, 'priority_changed', item.priority, b.priority!);
  if (assigneeChanged) {
    const newName = await nameOf(c, b.assignee_id ?? null);
    await logEvent(c, id, user.id, b.assignee_id ? 'assigned' : 'unassigned', item.assignee_name, newName);
    if (b.assignee_id) await enqueue(c, 'notify_assignee', { item_id: id, user_id: b.assignee_id, reason: 'assigned' });
  }
  return { status: 200, body: withPermissions(user, await fetchItem(c, id)) };
}));

// ---------------------------------------------------------------- claim (atomic)
items.post('/items/:id/claim', mutation(async (req, c) => {
  const user = req.user!;
  const id = idOf(req);
  const item = await loadAuthorized(c, id, user, 'item:claim');
  // The conditional UPDATE is the lock: of N parallel claimers exactly one matches "assignee_id IS NULL".
  const upd = await c.query(
    `UPDATE work_items SET assignee_id = $1, version = version + 1, updated_at = now()
     WHERE id = $2 AND assignee_id IS NULL AND status IN ('open','in_progress') RETURNING id`,
    [user.id, id],
  );
  if (upd.rowCount === 0) {
    const latest = await fetchItem(c, id);
    throw new HttpError(409, 'already_claimed', latest.assignee_id
      ? `Already claimed by ${latest.assignee_name}.` : 'This item cannot be claimed in its current state.', { current: latest });
  }
  await logEvent(c, id, user.id, 'assigned', item.assignee_name, user.name);
  await enqueue(c, 'notify_assignee', { item_id: id, user_id: user.id, reason: 'claimed' });
  return { status: 200, body: withPermissions(user, await fetchItem(c, id)) };
}));

// ---------------------------------------------------------------- workflow transition
items.post('/items/:id/transition', mutation(async (req, c) => {
  const user = req.user!;
  const id = idOf(req);
  const b = z.object({ to: z.enum(STATUSES), version: z.number().int() }).parse(req.body);
  const item = await loadAuthorized(c, id, user, 'item:read');
  const needed = TRANSITIONS[item.status as Status][b.to];
  if (item.version !== b.version) throw await conflict(c, id);
  if (!needed) {
    throw new HttpError(422, 'invalid_transition', `Cannot move an item from ${item.status} to ${b.to}.`);
  }
  assertCan(user, needed, item.team_id); // e.g. only a Lead of THIS team can approve
  const upd = await c.query(
    `UPDATE work_items SET status = $1, version = version + 1, updated_at = now()
     WHERE id = $2 AND version = $3 AND status = $4 RETURNING id`,
    [b.to, id, b.version, item.status],
  );
  if (upd.rowCount === 0) throw await conflict(c, id);
  await logEvent(c, id, user.id, 'status_changed', item.status, b.to);
  if (item.assignee_id && item.assignee_id !== user.id) {
    await enqueue(c, 'notify_assignee', { item_id: id, user_id: item.assignee_id, reason: `status:${b.to}` });
  }
  return { status: 200, body: withPermissions(user, await fetchItem(c, id)) };
}));

// ---------------------------------------------------------------- comments + activity
items.post('/items/:id/comments', mutation(async (req, c) => {
  const user = req.user!;
  const id = idOf(req);
  const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
  await loadAuthorized(c, id, user, 'item:comment');
  await logEvent(c, id, user.id, 'commented', null, body);
  return { status: 201, body: { ok: true } };
}));

items.get('/items/:id/activity', async (req, res) => {
  const id = idOf(req);
  await loadAuthorized(pool, id, req.user!, 'item:read');
  const { cursor, limit } = z.object({
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }).parse(req.query);
  const params: unknown[] = [id];
  let cur = '';
  if (cursor) {
    params.push(cursor);
    cur = `AND e.id < $2`;
  }
  params.push(limit + 1);
  const r = await pool.query(
    `SELECT e.id, e.kind, e.old_value, e.new_value, e.created_at, e.actor_id, u.name AS actor_name
     FROM activity_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.item_id = $1 ${cur} ORDER BY e.id DESC LIMIT $${params.length}`,
    params,
  );
  const page = r.rows.slice(0, limit);
  res.json({ events: page, next_cursor: r.rows.length > limit ? page[page.length - 1].id : null });
});
