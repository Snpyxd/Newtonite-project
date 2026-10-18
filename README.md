# Operations Desk (newtonite-ops-<rollno>)

An internal web app where teams create, assign, track and resolve operational work items (incidents, customer issues, payments, compliance, tasks). It enforces a server-side workflow with a Lead-only approval step, per-team roles, an append-only activity history, and a dashboard of what needs attention. It is built to stay correct under concurrency: two people claiming one item, stale edits, retried requests and background jobs that fail.

**Stack:** React + Vite + TanStack Query · Node.js + Express + TypeScript · PostgreSQL 16 · Vitest + Supertest · Docker Compose

## Run locally (without Docker)

### Prerequisites
- Node.js and npm
- PostgreSQL 16 or a compatible version

### 1. Configure the database

Ensure PostgreSQL is running and create the `ops` database. Configure your local `.env` file with the correct database credentials. Never commit `.env` to GitHub.

### 2. Start the backend API

Run in the first terminal from the project root:

```bash
cd backend
npm install
npm run migrate
npm run seed
npm start
```

### 3. Start the background worker

Run in a second terminal from the project root:

```bash
cd backend
npm run worker
```

### 4. Start the frontend

Run in a third terminal from the project root:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 to use the application.

- API health check: http://localhost:3000/health

### Docker alternative

If Docker Compose is available, you can start the application using:

```bash
docker compose up --build
```

### Demo logins (password for everyone: `password123`)

| Email | Role |
|---|---|
| alice.admin@demo.test | Admin in all 4 teams |
| liam.lead@demo.test | Lead in Payments Ops, Member in Customer Support |
| lena.lead@demo.test | Lead in Customer Support and Compliance |
| luke.lead@demo.test | Lead in Platform Incidents |
| mia.member@demo.test | Member in Payments Ops and Customer Support |
| mark.member@demo.test | Member in Payments Ops |
| sara.member@demo.test | Member in Customer Support and Platform Incidents |
| noah.member@demo.test | Member in Compliance and Platform Incidents |
| vera.viewer@demo.test | Viewer in Payments Ops and Customer Support |
| victor.viewer@demo.test | Viewer in Compliance |

**Try this:** sign in as `mia.member`, claim an unassigned urgent item, move it to *Awaiting approval*.
Sign in as `liam.lead` and approve it on the dashboard. Open the same item in two browsers and edit both to see the conflict message.

## Run the tests (one command)

```bash
docker compose run --rm api npm test
```

Without Docker: start Postgres, then `cd backend && npm install && npm test`
(uses `TEST_DATABASE_URL`, default `postgres://ops:ops@localhost:5432/ops_test`; the database is created automatically).

42 tests cover: concurrent claim, stale update, idempotency (including a 5-way simultaneous retry), workflow rules,
cross-team authorization, transactional rollback, append-only history, outbox retries and idempotent handlers,
and pagination, filtering and search.

## Run without Docker (development)

```bash
# terminal 1: Postgres reachable at DATABASE_URL, then
cd backend && npm install && npm run migrate && npm run seed && npm start
# terminal 2
cd backend && npm run worker
# terminal 3
cd frontend && npm install && npm run dev
```

## How it works

```mermaid
flowchart LR
  B[Browser<br/>React + TanStack Query] -->|/api, JWT, Idempotency-Key| A[Express API]
  A -->|one transaction per change:<br/>item + activity event + outbox row| P[(PostgreSQL)]
  W[Worker<br/>polls outbox, SKIP LOCKED] -->|claims jobs, writes notifications| P
  B -.->|refetch every 10s| A
```

```mermaid
stateDiagram-v2
  [*] --> open
  open --> in_progress
  in_progress --> open
  in_progress --> awaiting_approval
  awaiting_approval --> resolved: Lead only
  awaiting_approval --> in_progress: Lead only (send back)
  resolved --> closed
  resolved --> in_progress: reopen
  closed --> [*]
```

### Role x action matrix (enforced in `backend/src/permissions.ts`, scoped to the item's team)

| Action | Viewer | Member | Lead | Admin |
|---|:-:|:-:|:-:|:-:|
| Read items, activity | yes | yes | yes | yes |
| Create, edit, comment | | yes | yes | yes |
| Claim an unassigned item | | yes | yes | yes |
| Move through normal transitions | | yes | yes | yes |
| Assign or reassign to someone else | | | yes | yes |
| Approve (awaiting_approval to resolved) or send back | | | yes | yes |

A user's role is looked up **per team** on every request. A Lead in team A is only a Member in team B.

### Critical behaviours implemented (all seven, each with tests)

| Behaviour | Where | How |
|---|---|---|
| Concurrent claim | `routes/items.ts` claim | `UPDATE ... WHERE assignee_id IS NULL`; 0 rows updated gives 409 |
| Stale update | PATCH, transition | `version` check in the `WHERE`, incremented on write; 409 returns the latest item |
| Idempotency | `idempotency.ts` | `Idempotency-Key` header; key and response stored in the same transaction; replays return the stored result |
| Workflow rules | `workflow.ts` | transition map checked on the server; approval needs Lead |
| Resource-level authorization | `permissions.ts` | one `can()` function; every endpoint and every list query is team-scoped |
| Reliable async jobs | `worker.ts` | transactional outbox, `SKIP LOCKED`, exponential backoff, 5 attempts then `failed`, idempotent handler |
| Optimistic UI reconciliation | `ItemDetail.tsx` | claim/transition update instantly, roll back and show the server's reason on 409/403 |

Every change to an item and its activity event (and outbox row) is written in **one database transaction**.

## API summary

```
POST  /auth/login                     GET  /me          GET /notifications
GET   /items?status&priority&type&team_id&assignee=me|unassigned|<id>&q&cursor&limit
POST  /items                          (Idempotency-Key)
GET   /items/:id                      PATCH /items/:id  {version, ...}
POST  /items/:id/claim                POST  /items/:id/transition {to, version}
POST  /items/:id/comments             GET   /items/:id/activity?cursor
GET   /dashboard                      GET   /teams/:id/members
```

Errors are always `{ "error": "<code>", "message": "<plain words>" }`. 409 responses also include `current`.

## Known limitations

- No sign-up, password reset, token revocation, or rate limiting on login. JWTs last 12 hours.
- "Admin" has Lead powers; admin-only team and member management is not built.
- Real-time updates are polling (dashboard every 10s) and refetch on window focus, not websockets.
- Delivery is simulated: the worker writes a `notifications` row and logs it. No email or push.
- Lists are ordered by item id (creation order), not by priority or due date. The cursor is the item id.
- The worker holds a row lock while it runs a job. Fine for fast handlers; slow external calls would need a lease column.
- Idempotency keys are never purged. Production would delete rows older than 24h.
- The frontend runs the Vite dev server inside Docker. A production build would be served by nginx.
- Search uses Postgres full-text (English). Partial words like `charge` will not match `chargeback`.
- Frontend has no automated tests (backend behaviours are covered by API tests).

## Next week I would

1. Add a status-change comment requirement when sending back from approval, and due-date based sorting.
2. Admin screens for teams and memberships, with audit events.
3. Purge job for idempotency keys and old outbox rows; dead-letter view for `failed` jobs.
4. Playwright test for the optimistic-rollback flow and the 409 banner.
5. Replace polling with Server-Sent Events fed by the outbox.
