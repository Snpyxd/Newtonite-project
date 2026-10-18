# Engineering decisions

Assumptions I made where the brief was open (I would confirm these with a product manager first):

- A work item belongs to exactly one team for its whole life (team cannot be changed).
- Anyone who is Member or above can claim, edit and move items in their team; they do not have to be the assignee.
- Only Leads (and Admins) approve, send back, or assign work to someone else.
- `closed` is terminal. `resolved` can be reopened to `in_progress`.
- Viewers can read everything in their teams, including activity and comments, but change nothing.
- An unassigned item can only be claimed while it is `open` or `in_progress`.

## 1. History is written in the same transaction as the change

**Context.** The activity log must never disagree with the item (for example "priority changed" shown, but the priority did not change).
**Options.** (a) Write the item, then write the event in a second step. (b) Database triggers write events. (c) Application code writes both inside one transaction.
**Choice.** (c). Each mutating endpoint runs inside `tx()`, and `logEvent()` takes the same client. `activity_events` also has a trigger that rejects `UPDATE` and `DELETE`, so it is append-only at the database level, not just by convention.
**Trade-off.** Every endpoint must remember to call `logEvent`; a trigger would make that automatic. I chose explicit code because I can store who acted and readable values (like the previous and new assignee name) which a trigger does not know. A test checks that a failed request leaves neither a half-update nor an orphan event.

## 2. Concurrency control: conditional UPDATE and a version column, not long-held locks

**Context.** Two users claiming one item, or editing from stale screens.
**Options.** (a) `SELECT ... FOR UPDATE` then update. (b) Serializable isolation with retries. (c) Single-statement conditional updates plus an optimistic `version`.
**Choice.** (c). Claim is `UPDATE ... WHERE assignee_id IS NULL`; edits and transitions are `UPDATE ... WHERE id=? AND version=?` with `version = version + 1`. Zero rows updated means 409, and the response carries the latest item so the UI can show what changed.
**Trade-off.** Losers must retry manually instead of the database queuing them. That is the right behaviour here: if someone else claimed the item, silently waiting and then overwriting would be wrong. Optimistic locking holds no locks while a user stares at a form, so it scales to many editors. Comments do not bump the version, so adding a comment never causes someone else's edit to conflict.

## 3. Authorization: one `can()` function, role per team, enforced on the server

**Context.** Permissions must be real, per team and per resource, not hidden buttons.
**Options.** (a) Check roles in each route. (b) Middleware by route path. (c) A single `can(user, action, teamId)` backed by one action-to-minimum-role table.
**Choice.** (c). Roles are loaded from the database on every request, so removing someone from a team takes effect immediately. List queries always filter by `team_id = ANY(user's teams)`. The item payload includes a `permissions` block computed by the server, so the UI shows buttons from the same rules instead of duplicating them. Users outside the team get 403.
**Trade-off.** One extra query per request for memberships (cheap, indexed). I return 403 rather than 404 for other teams' items because it gives a clearer error; the cost is that it confirms an id exists. For a more sensitive system I would switch to 404.

## 4. Sync vs async: transactional outbox with a polling worker

**Context.** Notifying a new assignee must not slow the request, must not be lost if the process crashes, and must not be sent for a change that rolled back.
**Options.** (a) Send inside the request. (b) Fire-and-forget after commit. (c) Message queue (Redis/BullMQ). (d) Outbox table written in the same transaction, polled by a worker.
**Choice.** (d). The job row commits with the change. The worker selects due jobs with `FOR UPDATE SKIP LOCKED` (several workers are safe), runs each in a savepoint so one bad job does not block the batch, retries with 2/4/8/16-second backoff, and marks `failed` after 5 attempts. The handler is idempotent because `notifications.job_id` is unique.
**Trade-off.** Polling adds up to one second of latency and a little constant database load, and I give up Redis features like priorities. In exchange there is one fewer system to run and the guarantee "change committed implies job exists" comes for free. Delivery is at-least-once, which is why the handler must be idempotent.

## 5. Pagination and search: cursor on id, filters and full-text in SQL

**Context.** Tens of thousands of items and a growing history.
**Options.** (a) Offset pagination. (b) Cursor on `(created_at, id)`. (c) Cursor on a monotonic `id`.
**Choice.** (c): `WHERE id < cursor ORDER BY id DESC LIMIT n+1`. It is stable while new items arrive (offset would skip or repeat rows) and its cost does not grow with page depth. Indexes match the real queries: `(team_id, id DESC)`, `(team_id, status, id DESC)`, a partial index for unassigned urgent items, an assignee index, and a GIN index on a generated `tsvector` column for search. Filters, search and scoping all run in SQL.
**Trade-off.** Ordering is by creation order only. Sorting by due date or priority needs a compound cursor and matching indexes; I did not build it. The same pattern is used for the activity timeline.

## 6. Idempotency: store the key and response in the same transaction

**Context.** Double-clicks and network retries must not create two items.
**Choice.** `INSERT ... ON CONFLICT DO NOTHING` on `(key, user_id)` as the first statement in the transaction. If another request with the same key is still running, Postgres makes this insert wait for it, so simultaneous duplicates serialize without any application locking. A repeated key returns the stored response with an `Idempotent-Replay` header. The same key with a different body is rejected with 422.
**Trade-off.** A failed attempt rolls back its key, so a retry after an error runs again (usually what you want). Keys accumulate until purged.

## What I chose not to build

Email delivery, attachments, SSO, websockets, sign-up, admin screens, and fancy styling. The brief rewards a smaller system with well-considered behaviour, so the time went into the seven behaviours above and their tests.
