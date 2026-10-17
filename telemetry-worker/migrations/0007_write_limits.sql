-- Limits checked in the same transaction as the writes (telemetry-worker/README.md, "Abuse").
--
-- uid_budget: rows written per user and UTC day (weighted as in budget), against the
-- per-user daily limit. Rows older than a day are deleted by the Worker's daily cron.
CREATE TABLE uid_budget (
  uid TEXT NOT NULL,
  day INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (uid, day)
) WITHOUT ROWID;

-- Never holds a row. The last statement of each write batch inserts one when the batch took
-- a limit (budget, per-user writes, quotas) past its value; the check then fails and the
-- whole batch is undone, so requests arriving together cannot all pass a limit read before.
CREATE TABLE overdraw (
  x INTEGER CONSTRAINT over_limit CHECK (x = 0)
);
