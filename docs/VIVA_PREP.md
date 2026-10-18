# Viva prep: answers in 30 seconds each

**Draw the architecture in 60 seconds.** Browser → Express API → Postgres. A separate worker process reads the outbox table in the same Postgres. Every change is one transaction: item row + activity event + (maybe) outbox row.

**What happens when things fail?**
- *Database down:* API returns 500 (the transaction never commits, so no partial writes); worker catches the error and retries every 3s.
- *Worker crashes mid-job:* the job runs in a transaction, so the crash rolls back and the row is still `pending`; another run picks it up. The handler is idempotent (`UNIQUE(job_id)`), so no double notification.
- *Network retry / double click:* same `Idempotency-Key` returns the stored response.
- *Two users collide:* claim and edits use conditional updates; loser gets 409 with the latest data.

**Which part matters most?** The transaction boundary. If item, history and job are not committed together, every other guarantee (audit trail, notifications, idempotent replay) breaks.

**Assumptions to check with a PM first:** who may approve (Lead only?), can members edit items they do not own, can closed items be reopened, should viewers see comments, should assignment require team membership.

**What changes at 10x scale?** Read replicas for list queries; partition `activity_events` by time; a search engine instead of Postgres FTS; a real queue instead of polling; SSE/websockets instead of 10s polling; purge idempotency keys.

**Be ready to modify live.**
- *Add a status:* add it to the CHECK in a new migration `002_*.sql`, to `STATUSES` and `TRANSITIONS` in `workflow.ts`, and to `STATUSES` in `frontend/src/api.ts`.
- *Let Leads reassign:* already built (`item:assign` in `permissions.ts`; PATCH with `assignee_id`). To let Members reassign too, change `MIN_ROLE['item:assign']` to `'member'`.
- *Change who can approve:* edit one line in `MIN_ROLE` (`item:approve`).
- *Add a field to items:* migration, `createSchema` and `patchSchema` in `routes/items.ts`, `COLS`, and the two forms.

**Where each test lives:** `tests/concurrency.test.ts` (claim, stale), `idempotency.test.ts`, `workflow.test.ts`, `authz.test.ts`, `outbox.test.ts`, `listing.test.ts`.
