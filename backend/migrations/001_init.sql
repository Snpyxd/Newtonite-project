CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id   BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- A user can belong to many teams, with one role per team.
CREATE TABLE memberships (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role    TEXT   NOT NULL CHECK (role IN ('viewer','member','lead','admin')),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX idx_memberships_team ON memberships (team_id);

CREATE TABLE work_items (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL CHECK (type IN ('incident','customer_issue','payment','compliance','task')),
  priority    TEXT NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  team_id     BIGINT NOT NULL REFERENCES teams(id),
  assignee_id BIGINT REFERENCES users(id),
  created_by  BIGINT NOT NULL REFERENCES users(id),
  due_date    DATE,
  version     INTEGER NOT NULL DEFAULT 1,   -- optimistic-locking counter
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  search      TSVECTOR GENERATED ALWAYS AS
              (to_tsvector('english', title || ' ' || description)) STORED
);

-- Indexes chosen for the real queries: list-per-team, "mine", "unassigned urgent", full-text.
CREATE INDEX idx_items_team_id        ON work_items (team_id, id DESC);
CREATE INDEX idx_items_team_status    ON work_items (team_id, status, id DESC);
CREATE INDEX idx_items_assignee       ON work_items (assignee_id, status) WHERE assignee_id IS NOT NULL;
CREATE INDEX idx_items_unassigned_urg ON work_items (team_id, id DESC) WHERE assignee_id IS NULL AND priority = 'urgent';
CREATE INDEX idx_items_search         ON work_items USING GIN (search);

-- Append-only history. Comments are events too (kind = 'commented').
CREATE TABLE activity_events (
  id         BIGSERIAL PRIMARY KEY,
  item_id    BIGINT NOT NULL REFERENCES work_items(id),
  actor_id   BIGINT REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('created','status_changed','priority_changed','assigned','unassigned','updated','commented')),
  old_value  TEXT,
  new_value  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_item ON activity_events (item_id, id DESC);

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER activity_append_only
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Stored response per (key, user) so retries replay the same result.
CREATE TABLE idempotency_keys (
  key             TEXT   NOT NULL,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  request_hash    TEXT   NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id)
);

-- Transactional outbox: written in the same transaction as the business change.
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  type         TEXT  NOT NULL,
  payload      JSONB NOT NULL,
  status       TEXT  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_run_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX idx_outbox_pending ON outbox (next_run_at) WHERE status = 'pending';

-- The "delivered" notification. UNIQUE(job_id) makes the handler idempotent.
CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  job_id     BIGINT NOT NULL UNIQUE,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  item_id    BIGINT NOT NULL REFERENCES work_items(id),
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications (user_id, id DESC);
