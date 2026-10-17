-- Making false usage data costly (telemetry-worker/README.md, "Abuse").
--
-- uid_keys: one row per registered user. kv is HMAC-SHA-256(secret, "lp-ingest-v1"), the key
-- the player signs its batches with; the secret itself is never stored. created_day is the
-- day of registration (days since 1970-01-01, UTC). status: 'new' until promoted (later).
-- pow_ok: the registration carried a valid proof of work.
CREATE TABLE uid_keys (
  uid TEXT PRIMARY KEY,
  kv BLOB NOT NULL,
  created_day INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  pow_ok INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Signed batches already stored (a batch sent again is not stored twice). Rows older than a
-- day are deleted by the Worker's daily cron.
CREATE TABLE batches (
  uid TEXT NOT NULL,
  batch TEXT NOT NULL,
  day INTEGER NOT NULL,
  PRIMARY KEY (uid, batch)
) WITHOUT ROWID;

-- Rows written per day (weighted by the indexes each one updates), against DAILY_WRITE_BUDGET.
CREATE TABLE budget (
  day INTEGER PRIMARY KEY,
  n INTEGER NOT NULL
);

-- auth: 1 when the row came in a batch signed by a registered user. flags: one bit per
-- implausible value (telemetry-worker/src/plausibility.js), noted, not acted on.
ALTER TABLE env ADD COLUMN auth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE env ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN auth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE errors ADD COLUMN auth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE errors ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fallbacks ADD COLUMN auth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fallbacks ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
