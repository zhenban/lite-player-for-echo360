// The one data endpoint: GET /api/summary. Reads the filters from the query string (only
// known keys, each from a fixed set or a strict pattern), runs the fixed statements and
// returns totals only: no row ever carries a uid, and nothing is returned per user.
import { DEVICE_DIMS, PERF_METRICS, run } from './queries.js';

const DAY = 86400000;
export const RANGES = [7, 30, 90];
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const KEYS = ['range', 'version', 'devices', 'tz'];

// Fewer than this many users or viewings: shown, but marked as too few to judge.
export const LOW_SAMPLE = 5;

// Where a measure stops being fine (good below `warn`, a problem from `bad`). Interaction
// delay follows Web Vitals INP (good up to 200 ms, poor above 500 ms). Dropped frames, long
// tasks per minute, and the problem and fallback shares have no published standard: these
// are starting points (about one frame in 50 dropped is visible as stutter), to be tuned
// once there is real data. They are returned with the data so the page shows them.
export const LIMITS = {
  dropped_pct: { warn: 2, bad: 5 },
  input_ms90: { warn: 200, bad: 500 },
  long_tasks_pm: { warn: 2, bad: 6 },
  problemPct: { warn: 5, bad: 15 },
  fallbackPct: { warn: 2, bad: 10 },
};

// The filters, or null when the query string has anything unexpected.
export function parseFilters(url, now) {
  const q = url.searchParams;
  for (const k of q.keys()) if (!KEYS.includes(k)) return null;
  for (const k of KEYS) if (q.getAll(k).length > 1) return null;
  const range = q.has('range') ? Number(q.get('range')) : 30;
  if (!RANGES.includes(range)) return null;
  const version = q.has('version') ? q.get('version') : 'all';
  if (version !== 'all' && !VERSION.test(version)) return null;
  const devices = q.has('devices') ? q.get('devices') : 'all';
  if (devices !== 'all' && devices !== 'others') return null;
  const tzRaw = q.has('tz') ? q.get('tz') : '0';
  if (!/^-?\d{1,3}$/.test(tzRaw)) return null;
  const tz = Number(tzRaw);
  if (tz < -840 || tz > 840) return null;
  // Whole local days: the range ends at the end of today and covers `range` days.
  const localNow = now + tz * 60000;
  const to = Math.floor(localNow / DAY) * DAY + DAY - tz * 60000;
  const from = to - range * DAY;
  return { range, version: version === 'all' ? null : version, devices, tz, from, to, prev: from - range * DAY, since: to - 90 * DAY };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pct = (part, whole) => (whole > 0 ? Math.round((1000 * part) / whole) / 10 : null);
const round1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

function level(value, limit) {
  if (value == null) return 'none';
  return value >= limit.bad ? 'bad' : value >= limit.warn ? 'warn' : 'good';
}
const WORST = { none: 0, good: 1, warn: 2, bad: 3 };

// Compares dotted versions, newest first.
function byVersionDesc(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}

export async function summary(db, filters, owners, now) {
  const exclude = filters.devices === 'others' ? JSON.stringify(owners) : '[]';
  const values = { from: filters.from, to: filters.to, prev: filters.prev, since: filters.since, version: filters.version, exclude, tz: filters.tz };
  const r = await run(db, ['overview', 'daily', 'versions', 'versionList', 'latest', 'devices', 'performance', 'perfByVersion',
    'stability', 'problems', 'errors', 'features', 'changed', 'speeds', 'slides', 'frontends', 'fallbackReasons', 'boot'], values);

  const o = r.overview[0] || {};
  const st = r.stability[0] || {};
  const sessions = num(o.sessions);

  // Every local day of the range, with zeros where nothing happened.
  const byDay = new Map(r.daily.map((d) => [d.day, d]));
  const days = [];
  for (let t = filters.from; t < filters.to; t += DAY) {
    const key = new Date(t + filters.tz * 60000).toISOString().slice(0, 10);
    const d = byDay.get(key) || {};
    days.push({ day: key, users: num(d.users), sessions: num(d.sessions), playSec: num(d.play_sec), problems: num(d.problems), fallbacks: num(d.fallbacks), errors: num(d.errors) });
  }
  const fallbacks = days.reduce((a, d) => a + d.fallbacks, 0);

  const devices = {};
  for (const dim of DEVICE_DIMS) devices[dim] = [];
  for (const row of r.devices) if (devices[row.dim]) devices[row.dim].push({ value: row.bucket, users: num(row.users) });
  const deviceUsers = devices.browser.reduce((a, x) => a + x.users, 0);

  const perf = {};
  for (const m of PERF_METRICS) perf[m] = { n: 0, p50: null, p90: null, min: null, max: null };
  for (const row of r.performance) perf[row.metric] = { n: num(row.n), p50: row.p50, p90: row.p90, min: row.min, max: row.max };
  const perfByVersion = {};
  for (const row of r.perfByVersion) {
    (perfByVersion[row.version] ||= {})[row.metric] = { n: num(row.n), p50: row.p50 };
  }

  const problemPct = pct(num(st.with_problem), num(st.sessions));
  const fallbackPct = pct(fallbacks, sessions + fallbacks);

  // Status of each headline: good / warn / bad, 'none' when there is nothing to judge,
  // and `low` when it rests on fewer than LOW_SAMPLE viewings.
  const smoothParts = ['dropped_pct', 'input_ms90', 'long_tasks_pm'].map((m) => level(perf[m].p50, LIMITS[m]));
  const smooth = smoothParts.reduce((a, b) => (WORST[b] > WORST[a] ? b : a), 'none');
  const perfN = Math.max(perf.dropped_pct.n, perf.input_ms90.n, perf.long_tasks_pm.n);
  // A change: page code first seen in the last week that replaced older page code.
  const recentFrontends = r.frontends.filter((f) => f.first_at >= filters.to - 7 * DAY && f.older > 0).length;
  const compat = level(fallbackPct, LIMITS.fallbackPct);

  const versionList = r.versionList.map((v) => ({ version: v.version, users: num(v.users), lastAt: v.last_at }))
    .sort((a, b) => byVersionDesc(a.version, b.version));

  return {
    filters: { range: filters.range, version: filters.version || 'all', devices: filters.devices, tz: filters.tz, from: filters.from, to: filters.to },
    canExclude: owners.length > 0,
    generatedAt: now,
    latestAt: r.latest[0] ? r.latest[0].at : null,
    lowSample: LOW_SAMPLE,
    limits: LIMITS,
    status: {
      users: { level: num(o.users) ? 'info' : 'none', low: num(o.users) < LOW_SAMPLE },
      devices: { level: deviceUsers ? 'info' : 'none', low: deviceUsers < LOW_SAMPLE },
      smooth: { level: perfN ? smooth : 'none', low: perfN < LOW_SAMPLE },
      errors: { level: level(problemPct, LIMITS.problemPct), low: num(st.sessions) < LOW_SAMPLE },
      features: { level: num(o.session_users) ? 'info' : 'none', low: num(o.session_users) < LOW_SAMPLE },
      compat: { level: sessions + fallbacks ? (compat === 'good' && recentFrontends ? 'warn' : compat) : 'none', low: sessions + fallbacks < LOW_SAMPLE, newFrontends: recentFrontends },
    },
    overview: {
      users: num(o.users), prevUsers: num(o.prev_users), newUsers: num(o.new_users),
      sessions, prevSessions: num(o.prev_sessions), sessionUsers: num(o.session_users),
      playSec: num(o.play_sec), prevPlaySec: num(o.prev_play_sec),
      keys: num(o.keys), clicks: num(o.clicks), watchedPct: round1(o.watched_pct), silenceSkippedSec: num(o.silence_skipped_sec),
    },
    days,
    versions: r.versions.map((v) => ({ version: v.version, users: num(v.users) })),
    versionList,
    devices: { users: deviceUsers, dims: devices },
    performance: { metrics: perf, byVersion: perfByVersion },
    stability: {
      sessions: num(st.sessions), withProblem: num(st.with_problem), problemPct,
      withUncaught: num(st.with_uncaught), withFeatureOff: num(st.with_feature_off), withStreamError: num(st.with_stream_error),
      withRequestError: num(st.with_request_error), renewOk: num(st.renew_ok), renewFail: num(st.renew_fail),
      sendFail: num(st.send_fail), dropped: num(st.dropped),
      problems: r.problems.map((p) => ({ kind: p.kind, name: p.name, sessions: num(p.sessions), total: num(p.total) })),
      errors: r.errors.map((e) => ({ feature: e.feature, type: e.type, msg: e.msg, times: num(e.times), users: num(e.users),
        versions: e.versions ? String(e.versions).split(',').sort(byVersionDesc) : [], lastAt: e.last_at })),
    },
    features: {
      users: num(o.session_users),
      used: r.features.map((f) => ({ feature: f.feature, users: num(f.users), uses: num(f.uses) })),
      changed: r.changed.map((c) => ({ setting: c.setting, users: num(c.users) })),
      speeds: r.speeds.map((s) => ({ speed: s.speed, sec: Math.round(num(s.sec)) })),
      slideSources: r.slides.filter((x) => x.kind === 'src').map((x) => ({ source: x.bucket, sessions: num(x.sessions) })),
      slideStops: r.slides.filter((x) => x.kind === 'stop').map((x) => ({ reason: x.bucket, sessions: num(x.sessions) })),
    },
    compat: {
      fallbacks, fallbackPct,
      frontends: r.frontends.map((f) => ({ frontend: f.frontend, firstAt: f.first_at, replaced: num(f.older) > 0, lastAt: f.last_at, sessions: num(f.sessions),
        fallbacks: num(f.fallbacks), involuntary: num(f.involuntary), users: num(f.users) })),
      reasons: r.fallbackReasons.map((f) => ({ reason: f.reason, times: num(f.times), users: num(f.users) })),
      boot: r.boot.map((b) => ({ path: b.boot_path, sessions: num(b.sessions), bootMsP50: b.boot_ms_p50 })),
    },
  };
}
