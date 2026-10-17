// Every statement the dashboard can run. Nothing else reaches the database: there is no
// way to send SQL, and run() accepts only names from this list. Each statement is written
// here in full; `$name` marks a parameter, numbered ?1, ?2... below in the order of first
// use and always bound, never pasted in. On load, every statement is checked to be a
// single SELECT (or WITH ... SELECT) with no statement separator and no writing keyword;
// if one is not, the module throws and the Worker serves nothing.
// test/readonly.test.mjs also runs each one against a read-only SQLite copy of the schema.
//
// Parameters (validated in summary.js before they get here):
//   $from, $to     the range, ms since 1970 ($to exclusive)
//   $prev          start of the period before it, of the same length
//   $since         start of the version list's window (90 days)
//   $version       one script version, or NULL for all
//   $exclude       JSON array of uids left out ("exclude my devices"), '[]' for none
//   $verified      1: verified rows only (see `ok` below), 0: every row
//   $tz            the viewer's offset from UTC in minutes (days are local days)

// A verified row: it came in a batch signed by a registered user (auth = 1) whose
// registration carried a proof of work, and none of its values is implausible (flags = 0).
// While the telemetry Worker still accepts unsigned data, anyone can send rows under a
// made-up uid; those count in every total unless $verified is 1.
const ok = (t) => `(${t}.auth = 1 AND ${t}.flags = 0 AND ${t}.uid IN (SELECT k.uid FROM uid_keys k WHERE k.pow_ok = 1))`;
const trust = (t) => `($verified = 0 OR ${ok(t)})`;
// The rows of one table in the range, for the chosen version, without excluded devices.
const scope = (t) => `${t}.at >= $from AND ${t}.at < $to AND ($version IS NULL OR ${t}.version = $version) AND ${t}.uid NOT IN (SELECT value FROM json_each($exclude)) AND ${trust(t)}`;
const day = (t) => `date(${t}.at / 1000 + $tz * 60, 'unixepoch')`;
// A viewing in which something went wrong: an uncaught error, a feature turned off after an
// error, or a video stream error.
const PROBLEM = `(COALESCE(s.uncaught, 0) > 0 OR s.guard_off IS NOT NULL OR s.stream_errors IS NOT NULL)`;
// Pages the user sent to the original player on purpose (the button, polls and other parts
// only it has, a discussion attachment); every other reason is the script failing.
const CHOSEN = `f.reason IN ('user', 'extras', 'attachment')`;
// Share of time (percent) at serious or critical CPU pressure, from a pressure JSON column.
const cpu = (c) => `CASE WHEN ${c} IS NOT NULL THEN COALESCE(json_extract(${c}, '$.serious'), 0) + COALESCE(json_extract(${c}, '$.critical'), 0) END`;

// Measures of load and watching (viewings with at least a minute of playback).
export const PERF_METRICS = ['dropped_pct', 'input_ms90', 'long_tasks_pm', 'heap_mb', 'first_frame_ms', 'ready_ms',
  'seek_ms90', 'rebuffer_pct', 'sync_ms_max', 'boot_ms', 'cpu_bg', 'cpu_idle'];
const perfValue = `CASE m.value
      WHEN 'dropped_pct' THEN s.dropped_pct
      WHEN 'input_ms90' THEN s.input_ms90
      WHEN 'long_tasks_pm' THEN s.long_tasks_pm
      WHEN 'heap_mb' THEN s.heap_mb
      WHEN 'first_frame_ms' THEN s.first_frame_ms
      WHEN 'ready_ms' THEN s.ready_ms
      WHEN 'seek_ms90' THEN s.seek_ms90
      WHEN 'rebuffer_pct' THEN s.rebuffer_pct
      WHEN 'sync_ms_max' THEN s.sync_ms_max
      WHEN 'boot_ms' THEN s.boot_ms
      WHEN 'cpu_bg' THEN ${cpu('s.pressure_bg')}
      WHEN 'cpu_idle' THEN ${cpu('s.pressure_idle')}
    END`;
// Per version only the three that say whether the player is smooth.
const VERSION_METRICS = ['dropped_pct', 'input_ms90', 'long_tasks_pm'];

export const DEVICE_DIMS = ['browser', 'os', 'manager', 'form', 'screen', 'cores', 'memory', 'gpu', 'hwdecode', 'webgpu',
  'webcodecs', 'country', 'region', 'network'];

const SQL = {
  // Totals for the range and the period before it. verified_users: users in the range with
  // at least one verified row (equal to users when only verified rows are shown).
  overview: `
WITH s AS (
  SELECT s.uid, s.at, s.play_sec, s.keys, s.clicks, s.watched_pct, s.skip_silence_sec, ${ok('s')} AS ok FROM sessions s
  WHERE s.at >= $prev AND s.at < $to AND ($version IS NULL OR s.version = $version) AND s.uid NOT IN (SELECT value FROM json_each($exclude)) AND ${trust('s')}
),
a AS (
  SELECT uid, at, ok FROM s
  UNION ALL
  SELECT e.uid, e.at, ${ok('e')} FROM env e
  WHERE e.at >= $prev AND e.at < $to AND ($version IS NULL OR e.version = $version) AND e.uid NOT IN (SELECT value FROM json_each($exclude)) AND ${trust('e')}
),
firsts AS (
  SELECT e.uid, MIN(e.at) AS first_at FROM env e
  WHERE e.uid NOT IN (SELECT value FROM json_each($exclude)) AND ${trust('e')}
  GROUP BY e.uid
)
SELECT
  (SELECT COUNT(DISTINCT uid) FROM a WHERE at >= $from) AS users,
  (SELECT COUNT(DISTINCT uid) FROM a WHERE at >= $from AND ok) AS verified_users,
  (SELECT COUNT(DISTINCT uid) FROM a WHERE at < $from) AS prev_users,
  (SELECT COUNT(*) FROM firsts WHERE first_at >= $from AND first_at < $to) AS new_users,
  (SELECT COUNT(*) FROM s WHERE at >= $from) AS sessions,
  (SELECT COUNT(*) FROM s WHERE at < $from) AS prev_sessions,
  (SELECT COUNT(DISTINCT uid) FROM s WHERE at >= $from) AS session_users,
  (SELECT COALESCE(SUM(play_sec), 0) FROM s WHERE at >= $from) AS play_sec,
  (SELECT COALESCE(SUM(play_sec), 0) FROM s WHERE at < $from) AS prev_play_sec,
  (SELECT COALESCE(SUM(keys), 0) FROM s WHERE at >= $from) AS keys,
  (SELECT COALESCE(SUM(clicks), 0) FROM s WHERE at >= $from) AS clicks,
  (SELECT AVG(watched_pct) FROM s WHERE at >= $from) AS watched_pct,
  (SELECT COALESCE(SUM(skip_silence_sec), 0) FROM s WHERE at >= $from) AS silence_skipped_sec`,

  // Per local day: users (any row), viewings, playback, viewings with a problem, pages that
  // went to the original player not by the user's choice, and error reports.
  daily: `
WITH a AS (
  SELECT s.uid, s.at, s.play_sec, 1 AS viewing, CASE WHEN ${PROBLEM} THEN 1 ELSE 0 END AS problem, 0 AS fallback, 0 AS err
  FROM sessions s WHERE ${scope('s')}
  UNION ALL
  SELECT e.uid, e.at, 0, 0, 0, 0, 0 FROM env e WHERE ${scope('e')}
  UNION ALL
  SELECT f.uid, f.at, 0, 0, 0, CASE WHEN ${CHOSEN} THEN 0 ELSE 1 END, 0 FROM fallbacks f WHERE ${scope('f')}
  UNION ALL
  SELECT r.uid, r.at, 0, 0, 0, 0, COALESCE(r.n, 1) FROM errors r WHERE ${scope('r')}
)
SELECT ${day('a')} AS day, COUNT(DISTINCT a.uid) AS users, SUM(a.viewing) AS sessions,
       COALESCE(SUM(a.play_sec), 0) AS play_sec, SUM(a.problem) AS problems, SUM(a.fallback) AS fallbacks,
       SUM(a.err) AS errors
FROM a
GROUP BY day
ORDER BY day`,

  // Users per script version: the version of each user's newest row in the range (so each
  // user counts once, with what they run now).
  versions: `
WITH a AS (
  SELECT s.uid, s.version, s.at FROM sessions s WHERE ${scope('s')}
  UNION ALL
  SELECT e.uid, e.version, e.at FROM env e WHERE ${scope('e')}
),
l AS (SELECT uid, version, ROW_NUMBER() OVER (PARTITION BY uid ORDER BY at DESC) AS r FROM a)
SELECT version, COUNT(*) AS users FROM l WHERE r = 1 GROUP BY version ORDER BY users DESC LIMIT 12`,

  // Versions seen in the last 90 days, for the version filter (not limited by the filters).
  versionList: `
WITH a AS (
  SELECT s.version, s.uid, s.at FROM sessions s WHERE s.at >= $since AND s.uid NOT IN (SELECT value FROM json_each($exclude)) AND ${trust('s')}
  UNION ALL
  SELECT e.version, e.uid, e.at FROM env e WHERE e.at >= $since AND e.uid NOT IN (SELECT value FROM json_each($exclude)) AND ${trust('e')}
)
SELECT version, COUNT(DISTINCT uid) AS users, MAX(at) AS last_at FROM a GROUP BY version`,

  // The newest row of any kind ("data as of"). Not limited by the filters.
  latest: `
SELECT MAX(m) AS at FROM (
  SELECT MAX(at) AS m FROM sessions
  UNION ALL SELECT MAX(at) FROM env
  UNION ALL SELECT MAX(at) FROM fallbacks
  UNION ALL SELECT MAX(at) FROM errors
)`,

  // Devices: each user's newest environment row in the range, counted per dimension. (Not
// `value` as the alias: json_each has a column of that name, and GROUP BY would take it.)
  devices: `
WITH e AS (
  SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e.uid ORDER BY e.at DESC) AS r FROM env e WHERE ${scope('e')}
),
l AS (SELECT * FROM e WHERE r = 1)
SELECT d.value AS dim,
  CASE d.value
    WHEN 'browser' THEN l.browser
    WHEN 'os' THEN l.os
    WHEN 'manager' THEN l.manager
    WHEN 'form' THEN CASE WHEN l.mobile = 1 THEN 'phone' WHEN l.touch = 1 THEN 'touch' WHEN l.touch = 0 THEN 'desktop' END
    WHEN 'screen' THEN CASE WHEN l.screen_w IS NULL THEN NULL WHEN l.screen_w < 768 THEN 's' WHEN l.screen_w < 1280 THEN 'm'
                            WHEN l.screen_w < 1920 THEN 'l' ELSE 'xl' END
    WHEN 'cores' THEN CASE WHEN l.cores IS NULL THEN NULL WHEN l.cores <= 2 THEN '1-2' WHEN l.cores <= 4 THEN '3-4'
                           WHEN l.cores <= 8 THEN '5-8' WHEN l.cores <= 16 THEN '9-16' ELSE '17+' END
    WHEN 'memory' THEN CASE WHEN l.mem_gb IS NULL THEN NULL WHEN l.mem_gb < 4 THEN 'lt4' WHEN l.mem_gb < 8 THEN '4' ELSE '8' END
    WHEN 'gpu' THEN l.gpu_vendor
    WHEN 'hwdecode' THEN CASE l.hw1080 WHEN 1 THEN 'yes' WHEN 0 THEN 'no' END
    WHEN 'webgpu' THEN CASE l.webgpu WHEN 1 THEN 'yes' WHEN 0 THEN 'no' END
    WHEN 'webcodecs' THEN CASE l.webcodecs WHEN 1 THEN 'yes' WHEN 0 THEN 'no' END
    WHEN 'country' THEN l.country
    WHEN 'region' THEN CASE WHEN l.region IS NOT NULL THEN COALESCE(l.country, '?') || ' ' || l.region END
    WHEN 'network' THEN l.asorg
  END AS bucket,
  COUNT(*) AS users
FROM l, json_each('${JSON.stringify(DEVICE_DIMS)}') d
GROUP BY dim, bucket
ORDER BY dim, users DESC`,

  // Median, 90th percentile and range of each measure, over viewings with a minute of play.
  performance: `
WITH s AS (SELECT s.* FROM sessions s WHERE ${scope('s')} AND s.play_sec >= 60),
v AS (
  SELECT m.value AS metric, ${perfValue} AS value
  FROM s, json_each('${JSON.stringify(PERF_METRICS)}') m
),
r AS (
  SELECT metric, value, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY value) AS rn, COUNT(*) OVER (PARTITION BY metric) AS n
  FROM v WHERE value IS NOT NULL
)
SELECT metric, MAX(n) AS n,
       MAX(CASE WHEN rn = (n + 1) / 2 THEN value END) AS p50,
       MAX(CASE WHEN rn = MAX(1, (n * 9 + 9) / 10) THEN value END) AS p90,
       MIN(value) AS min, MAX(value) AS max
FROM r
GROUP BY metric`,

  // The same per version for the three smoothness measures (every version in the range,
  // whatever the version filter, so versions can be compared).
  perfByVersion: `
WITH s AS (
  SELECT s.* FROM sessions s
  WHERE s.at >= $from AND s.at < $to AND s.uid NOT IN (SELECT value FROM json_each($exclude)) AND ${trust('s')} AND s.play_sec >= 60
),
v AS (
  SELECT s.version, m.value AS metric, ${perfValue} AS value
  FROM s, json_each('${JSON.stringify(VERSION_METRICS)}') m
),
r AS (
  SELECT version, metric, value,
         ROW_NUMBER() OVER (PARTITION BY version, metric ORDER BY value) AS rn,
         COUNT(*) OVER (PARTITION BY version, metric) AS n
  FROM v WHERE value IS NOT NULL
)
SELECT version, metric, MAX(n) AS n, MAX(CASE WHEN rn = (n + 1) / 2 THEN value END) AS p50
FROM r
GROUP BY version, metric`,

  // Viewings, and how many had each kind of problem.
  stability: `
SELECT COUNT(*) AS sessions,
       COALESCE(SUM(CASE WHEN ${PROBLEM} THEN 1 ELSE 0 END), 0) AS with_problem,
       COALESCE(SUM(CASE WHEN COALESCE(s.uncaught, 0) > 0 THEN 1 ELSE 0 END), 0) AS with_uncaught,
       COALESCE(SUM(CASE WHEN s.guard_off IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_feature_off,
       COALESCE(SUM(CASE WHEN s.stream_errors IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_stream_error,
       COALESCE(SUM(CASE WHEN s.net_errors IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_request_error,
       COALESCE(SUM(s.renew_ok), 0) AS renew_ok, COALESCE(SUM(s.renew_fail), 0) AS renew_fail,
       COALESCE(SUM(s.send_fail), 0) AS send_fail, COALESCE(SUM(s.dropped), 0) AS dropped
FROM sessions s WHERE ${scope('s')}`,

  // What failed: features turned off, failed requests by kind, stream errors by name.
  problems: `
WITH s AS (SELECT s.* FROM sessions s WHERE ${scope('s')}),
items AS (
  SELECT 'feature_off' AS kind, j.key AS name, j.value AS n FROM s, json_each(s.guard_off) j
  UNION ALL SELECT 'request', j.key, j.value FROM s, json_each(s.net_errors) j
  UNION ALL SELECT 'stream', j.key, j.value FROM s, json_each(s.stream_errors) j
)
SELECT kind, name, COUNT(*) AS sessions, SUM(n) AS total FROM items GROUP BY kind, name ORDER BY total DESC LIMIT 30`,

  // The most frequent errors (messages are already stripped of anything identifying).
  errors: `
SELECT r.feature, r.type, r.msg, SUM(COALESCE(r.n, 1)) AS times, COUNT(DISTINCT r.uid) AS users,
       GROUP_CONCAT(DISTINCT r.version) AS versions, MAX(r.at) AS last_at
FROM errors r WHERE ${scope('r')}
GROUP BY r.feature, r.type, r.msg
ORDER BY users DESC, times DESC
LIMIT 25`,

  // Users who used each feature at least once, and uses in all.
  features: `
SELECT j.key AS feature, COUNT(DISTINCT s.uid) AS users, SUM(j.value) AS uses
FROM sessions s, json_each(s.features) j
WHERE ${scope('s')}
GROUP BY j.key`,

  // Settings changed from their default (each user's newest viewing in the range).
  changed: `
WITH l AS (
  SELECT s.uid, s.changed, ROW_NUMBER() OVER (PARTITION BY s.uid ORDER BY s.at DESC) AS r FROM sessions s WHERE ${scope('s')}
)
SELECT j.value AS setting, COUNT(*) AS users FROM l, json_each(l.changed) j WHERE l.r = 1 GROUP BY j.value ORDER BY users DESC`,

  // Seconds played at each speed.
  speeds: `
SELECT j.key AS speed, SUM(j.value * s.play_sec) / 100.0 AS sec
FROM sessions s, json_each(s.speeds) j
WHERE ${scope('s')} AND s.play_sec > 0
GROUP BY j.key`,

  // Where each viewing's slide chapters came from (frames: the video's keyframes; thumbs:
  // Echo360's per-minute preview pictures only; none), and why the keyframe scan stopped
  // early when it did. Viewings that did not report it (before 0.23.0) are left out.
  slides: `
SELECT 'src' AS kind, s.slide_src AS bucket, COUNT(*) AS sessions FROM sessions s
WHERE ${scope('s')} AND s.slide_src IS NOT NULL GROUP BY s.slide_src
UNION ALL
SELECT 'stop', s.slide_stop, COUNT(*) FROM sessions s
WHERE ${scope('s')} AND s.slide_stop IS NOT NULL GROUP BY s.slide_stop
ORDER BY kind, sessions DESC`,

  // Which form of the H.264 video gave pictures in the keyframe scan (avcc: as Echo360 sends
  // it; annexb: only after conversion to Annex B; neither), per system and browser version.
  // Viewings carry no device details, so each takes those of its device's report nearest
  // before it (or, failing that, nearest after). Viewings without a scan (NULL) are left out.
  slideForms: `
WITH s AS (SELECT s.rowid AS rid, s.uid, s.at, s.slide_form FROM sessions s WHERE ${scope('s')} AND s.slide_form IS NOT NULL),
x AS (
  SELECT s.uid, s.slide_form AS form, e.os, e.os_v, e.browser, e.browser_v,
         ROW_NUMBER() OVER (PARTITION BY s.rid ORDER BY e.at > s.at, ABS(e.at - s.at)) AS rn
  FROM s LEFT JOIN env e ON e.uid = s.uid AND ${trust('e')}
)
SELECT os, os_v, browser, browser_v,
       SUM(form = 'avcc') AS avcc, SUM(form = 'annexb') AS annexb, SUM(form = 'neither') AS neither,
       COUNT(DISTINCT uid) AS users
FROM x WHERE rn = 1
GROUP BY os, os_v, browser, browser_v
ORDER BY annexb + neither DESC, avcc DESC
LIMIT 40`,

  // The same forms in total: viewings and distinct users.
  slideFormTotals: `
SELECT s.slide_form AS form, COUNT(*) AS sessions, COUNT(DISTINCT s.uid) AS users FROM sessions s
WHERE ${scope('s')} AND s.slide_form IS NOT NULL
GROUP BY s.slide_form`,

  // Echo360's page code versions (its script file names): when each was first seen at all,
  // how many were seen before it (0: the first ever seen, so not a change), and in the range its viewings, pages that went to the original player, and users.
  frontends: `
WITH x AS (
  SELECT s.frontend, s.at, s.uid, 1 AS viewing, 0 AS fallback, 0 AS involuntary FROM sessions s
  WHERE ${scope('s')} AND s.frontend IS NOT NULL
  UNION ALL
  SELECT f.frontend, f.at, f.uid, 0, 1, CASE WHEN ${CHOSEN} THEN 0 ELSE 1 END FROM fallbacks f
  WHERE ${scope('f')} AND f.frontend IS NOT NULL
),
firsts AS (
  SELECT frontend, MIN(at) AS first_at FROM (
    SELECT frontend, at FROM sessions WHERE frontend IS NOT NULL AND ${trust('sessions')}
    UNION ALL SELECT frontend, at FROM fallbacks WHERE frontend IS NOT NULL AND ${trust('fallbacks')}
  ) GROUP BY frontend
)
SELECT x.frontend, firsts.first_at, (SELECT COUNT(*) FROM firsts older WHERE older.first_at < firsts.first_at) AS older, MAX(x.at) AS last_at, SUM(x.viewing) AS sessions, SUM(x.fallback) AS fallbacks,
       SUM(x.involuntary) AS involuntary, COUNT(DISTINCT x.uid) AS users
FROM x JOIN firsts ON firsts.frontend = x.frontend
GROUP BY x.frontend
ORDER BY firsts.first_at DESC
LIMIT 12`,

  // Why pages went to the original player.
  fallbackReasons: `
SELECT f.reason, COUNT(*) AS times, COUNT(DISTINCT f.uid) AS users FROM fallbacks f WHERE ${scope('f')}
GROUP BY f.reason ORDER BY times DESC`,

  // How the script started: the way in and the median time until the player was shown.
  boot: `
WITH s AS (SELECT s.boot_path, s.boot_ms FROM sessions s WHERE ${scope('s')} AND s.boot_path IS NOT NULL),
r AS (
  SELECT boot_path, boot_ms,
         ROW_NUMBER() OVER (PARTITION BY boot_path ORDER BY boot_ms IS NULL, boot_ms) AS rn,
         COUNT(boot_ms) OVER (PARTITION BY boot_path) AS n
  FROM s
)
SELECT boot_path, COUNT(*) AS sessions, MAX(CASE WHEN boot_ms IS NOT NULL AND rn = (n + 1) / 2 THEN boot_ms END) AS boot_ms_p50
FROM r
GROUP BY boot_path`,
};

// Writing or schema keywords that must never appear (as whole words) in a statement.
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|SAVEPOINT|RELEASE|BEGIN|COMMIT|ROLLBACK|TRANSACTION|RETURNING|load_extension)\b/i;

export function compile(name, text) {
  const sql = text.trim();
  if (!/^(WITH|SELECT)\b/i.test(sql) || sql.includes(';') || FORBIDDEN.test(sql) || /--|\/\*/.test(sql)) {
    throw new Error('Refusing statement ' + name + ': not a single read-only SELECT');
  }
  const params = [];
  const numbered = sql.replace(/\$([a-z]+)/g, (m, p) => {
    let i = params.indexOf(p);
    if (i < 0) { params.push(p); i = params.length - 1; }
    return '?' + (i + 1);
  });
  return Object.freeze({ name, sql: numbered, params: Object.freeze(params) });
}

export const QUERIES = Object.freeze(Object.fromEntries(Object.entries(SQL).map(([k, v]) => [k, compile(k, v)])));

const PARAMS = ['from', 'to', 'prev', 'since', 'version', 'exclude', 'verified', 'tz'];

// Runs the named statements in one batch and returns their rows, by name. `values` holds
// the validated parameters; a statement gets only the ones it uses.
export async function run(db, names, values) {
  for (const p of PARAMS) if (!Object.hasOwn(values, p)) throw new Error('Missing parameter ' + p);
  const list = names.map((n) => {
    if (!Object.hasOwn(QUERIES, n)) throw new Error('Unknown statement ' + n);
    return QUERIES[n];
  });
  const results = await db.batch(list.map((q) => db.prepare(q.sql).bind(...q.params.map((p) => values[p]))));
  const out = {};
  list.forEach((q, i) => { out[q.name] = results[i].results || []; });
  return out;
}
