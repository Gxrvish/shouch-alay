-- Loo Queue schema. Bookings reference users only by an opaque random id; the email lives in
-- `users` and is never joined into booking queries.

CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub text NOT NULL UNIQUE,  -- stable Google account id (emails can be reassigned)
  email      text NOT NULL,         -- shown to its owner; used by the opt-in email fallback
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE toilets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  disabled          boolean NOT NULL DEFAULT false,
  -- Rolling average of finished visits, for wait estimates. The only history we keep.
  avg_occupancy_sec double precision NOT NULL DEFAULT 300
);

CREATE TABLE bookings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  toilet_id  uuid NOT NULL REFERENCES toilets (id),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('WAITING', 'NOTIFIED', 'ACTIVE', 'DONE', 'CANCELLED', 'EXPIRED', 'AUTO_RELEASED')),
  queued_at  timestamptz NOT NULL DEFAULT clock_timestamp(),  -- queue order
  deadline   timestamptz,  -- NOTIFIED: end of the claim window. ACTIVE: occupancy check, then auto-release
  started_at timestamptz,  -- when the user went in
  nudged_at  timestamptz,  -- when "Are you still there?" was sent
  ended_at   timestamptz,  -- when a final status was reached; purged 24 h later
  CHECK ((deadline IS NOT NULL) = (status IN ('NOTIFIED', 'ACTIVE'))),
  CHECK ((ended_at IS NOT NULL) = (status IN ('DONE', 'CANCELLED', 'EXPIRED', 'AUTO_RELEASED')))
);

-- A user holds at most one open booking across all toilets.
CREATE UNIQUE INDEX bookings_one_open_per_user ON bookings (user_id) WHERE status IN ('WAITING', 'NOTIFIED', 'ACTIVE');
-- A toilet has at most one holder: the person inside, or the one whose turn it is.
CREATE UNIQUE INDEX bookings_one_holder_per_toilet ON bookings (toilet_id) WHERE status IN ('NOTIFIED', 'ACTIVE');
CREATE INDEX bookings_queue ON bookings (toilet_id, queued_at, id) WHERE status = 'WAITING';
CREATE INDEX bookings_due ON bookings (deadline) WHERE status IN ('NOTIFIED', 'ACTIVE');
CREATE INDEX bookings_ended ON bookings (ended_at) WHERE ended_at IS NOT NULL;

CREATE TABLE push_subscriptions (
  endpoint text PRIMARY KEY,
  user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  p256dh   text NOT NULL,
  auth     text NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- Per-user request count for the current minute; older rows are deleted every minute.
CREATE TABLE rate_limits (
  user_id      uuid NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL,
  PRIMARY KEY (user_id, window_start)
);
