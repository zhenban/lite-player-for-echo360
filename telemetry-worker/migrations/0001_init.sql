-- Usage data of Lite Player for Echo360. Every row: uid (SHA-256 of the user's secret, hex),
-- at (when the Worker stored it, ms since 1970), and where the request came from as
-- Cloudflare reports it (country, region, network operator). No IP address, no other
-- request headers. Columns match src/schema.js.

CREATE TABLE env (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  browser TEXT, browser_v INTEGER, os TEXT, manager TEXT, manager_v TEXT,
  lang TEXT, browser_lang TEXT, touch INTEGER,
  screen_w INTEGER, screen_h INTEGER, dpr REAL, cores INTEGER, mem_gb REAL, gpu TEXT,
  webgpu INTEGER, webcodecs INTEGER, builtin_ai INTEGER, net_type TEXT, downlink REAL,
  country TEXT, region TEXT, asorg TEXT,
  UNIQUE (uid, day)
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL,
  at INTEGER NOT NULL,
  sid TEXT NOT NULL,
  version TEXT NOT NULL,
  play_sec INTEGER, open_sec INTEGER, long_tasks_pm REAL, dropped_pct REAL, heap_mb REAL,
  first_frame_ms INTEGER, rebuffer_n INTEGER, rebuffer_sec REAL,
  scan_ms INTEGER, ocr_frame_ms REAL, silence_ms INTEGER,
  speed REAL, layout TEXT, keys INTEGER, clicks INTEGER,
  features TEXT,          -- JSON object: feature -> times used
  changed TEXT,           -- JSON array: settings changed from their default (names only)
  screen TEXT, chapters_ph REAL, pdf_unrec_pct REAL, page_fixes INTEGER, layout_undos INTEGER,
  renew_ok INTEGER, renew_fail INTEGER, frontend TEXT,
  country TEXT, region TEXT, asorg TEXT,
  UNIQUE (uid, sid)
);

CREATE TABLE errors (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL,
  at INTEGER NOT NULL,
  version TEXT NOT NULL,
  feature TEXT NOT NULL, type TEXT, msg TEXT, n INTEGER,
  country TEXT, region TEXT, asorg TEXT
);

CREATE TABLE fallbacks (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL,
  at INTEGER NOT NULL,
  version TEXT NOT NULL,
  reason TEXT NOT NULL, frontend TEXT,
  country TEXT, region TEXT, asorg TEXT
);

CREATE INDEX env_uid ON env (uid);
CREATE INDEX env_at ON env (at);
CREATE INDEX env_version ON env (version);
CREATE INDEX sessions_uid ON sessions (uid);
CREATE INDEX sessions_at ON sessions (at);
CREATE INDEX sessions_version ON sessions (version);
CREATE INDEX errors_uid ON errors (uid);
CREATE INDEX errors_at ON errors (at);
CREATE INDEX errors_version ON errors (version);
CREATE INDEX fallbacks_uid ON fallbacks (uid);
CREATE INDEX fallbacks_at ON fallbacks (at);
CREATE INDEX fallbacks_version ON fallbacks (version);
