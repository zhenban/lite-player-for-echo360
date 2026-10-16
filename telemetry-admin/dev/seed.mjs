// Made-up usage data for tests and the local preview (never real users). Scenarios:
//   empty  no rows at all
//   solo   the owner alone, a handful of viewings in the last days (what the real data
//          looks like at first)
//   busy   about 40 devices over 90 days: three script versions rolling out, a change of
//          Echo360's page code 20 days ago that sent pages to the original player for two
//          days, a few recurring errors
// Deterministic: the same scenario and `now` give the same rows.
import { readFileSync, readdirSync } from 'node:fs';

export const OWNER_UID = 'a'.repeat(63) + '1';
const DAY = 86400000;

// Applies the telemetry Worker's migrations (the real schema) to an empty SQLite database,
// then any copy in dev/migrations/ of one the Worker has but this branch does not yet (a
// copy is skipped once the Worker's own file of the same name is here).
export function applySchema(db) {
  const dir = new URL('../../telemetry-worker/migrations/', import.meta.url);
  const own = readdirSync(dir).filter((x) => x.endsWith('.sql'));
  const local = new URL('./migrations/', import.meta.url);
  const files = [...own.map((f) => new URL(f, dir)),
    ...readdirSync(local).filter((x) => x.endsWith('.sql') && !own.includes(x)).map((f) => new URL(f, local))];
  files.sort((a, b) => a.pathname.split('/').pop().localeCompare(b.pathname.split('/').pop()));
  for (const f of files) db.exec(readFileSync(f, 'utf8'));
}

function rng(start) {
  let s = start >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function insert(db, table, row) {
  const cols = Object.keys(row);
  // One environment row per device and day, as the Worker keeps it.
  db.prepare((table === 'env' ? 'INSERT OR IGNORE INTO ' : 'INSERT INTO ') + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')')
    .run(...cols.map((c) => row[c]));
}

const hex = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
const pick = (r, list) => list[Math.floor(r() * list.length)];
// Weighted pick from [[value, weight], ...].
function weighted(r, list) {
  const total = list.reduce((a, x) => a + x[1], 0);
  let x = r() * total;
  for (const [v, w] of list) { x -= w; if (x < 0) return v; }
  return list[list.length - 1][0];
}
const two = (v) => Number(v.toPrecision(2));

const FEATURES = ['play', 'seek', 'seekbar', 'chapter', 'volume', 'mute', 'fullscreen', 'swap', 'layout', 'speed', 'captions',
  'transcript', 'bookmark', 'notes', 'slides', 'zoom', 'loop', 'popout', 'silenceSkip', 'quality', 'settings', 'theme'];
// Share of users who ever use a feature (the rest are never used in this data).
const FEATURE_USE = { play: 1, seek: 0.95, seekbar: 0.9, speed: 0.8, volume: 0.6, fullscreen: 0.55, captions: 0.35, transcript: 0.3,
  chapter: 0.45, layout: 0.4, swap: 0.3, settings: 0.5, silenceSkip: 0.25, slides: 0.2, notes: 0.12, bookmark: 0.1, zoom: 0.08,
  quality: 0.15, theme: 0.1, popout: 0.05, mute: 0.3, loop: 0.03 };
const PREFS = ['rate', 'volume', 'layout', 'captions', 'theme', 'silence.auto', 'panel', 'quality.screen'];

function device(r, uid, i) {
  const os = weighted(r, [['Windows', 52], ['macOS', 30], ['iOS', 6], ['Android', 4], ['Linux', 5], ['ChromeOS', 3]]);
  const mobile = os === 'iOS' || os === 'Android';
  const browser = os === 'iOS' ? 'Safari' : os === 'macOS' ? weighted(r, [['Chrome', 6], ['Safari', 3], ['Firefox', 1]]) :
    weighted(r, [['Chrome', 6], ['Edge', 3], ['Firefox', 2]]);
  const cores = mobile ? 6 : weighted(r, [[4, 2], [8, 5], [12, 2], [16, 1], [2, 1]]);
  return {
    uid, browser, browser_v: browser === 'Firefox' ? 142 : 140, os, mobile: mobile ? 1 : 0, touch: mobile || r() < 0.08 ? 1 : 0,
    manager: browser === 'Safari' ? 'Userscripts' : weighted(r, [['Tampermonkey', 6], ['Violentmonkey', 3], ['ScriptCat', 1]]),
    manager_v: '5.4', lang: 'en', browser_lang: weighted(r, [['en', 6], ['zh', 3], ['ko', 1]]),
    screen_w: mobile ? 390 : weighted(r, [[1280, 1], [1440, 3], [1536, 2], [1920, 4], [2560, 1]]), screen_h: mobile ? 844 : 900,
    dpr: mobile ? 3 : weighted(r, [[1, 2], [1.25, 1], [2, 3]]), cores, mem_gb: mobile ? 4 : weighted(r, [[8, 6], [4, 2], [2, 1]]),
    gpu_vendor: os === 'macOS' || os === 'iOS' ? 'apple' : weighted(r, [['intel', 4], ['nvidia', 3], ['amd', 2], ['qualcomm', 1]]),
    // Some iPads still on iPadOS 15 (no WebCodecs).
    webgpu: browser === 'Firefox' ? 0 : 1, webcodecs: os === 'iOS' && parseInt(uid.slice(-1), 16) % 3 === 0 ? 0 : 1, hw720: 1, hw1080: r() < 0.9 ? 1 : 0, arch: os === 'macOS' ? 'arm' : 'x86',
    country: 'AU', region: weighted(r, [['Queensland', 7], ['New South Wales', 2], ['Victoria', 1]]),
    asorg: weighted(r, [['University Network', 5], ['Telstra', 3], ['Optus', 2], ['TPG', 1]]),
    speed: mobile ? 1.6 : cores <= 4 ? 1.4 : 1, // how slow the device is (1 = typical)
    keen: 0.4 + r() * 1.2, start: i,
  };
}

function session(r, d, at, version, frontend, extra = {}) {
  const play = Math.round(300 + r() * 3000);
  const used = {};
  for (const f of FEATURES) if (r() < (FEATURE_USE[f] || 0) * 0.8) used[f] = 1 + Math.floor(r() * 12);
  const changed = PREFS.filter(() => r() < 0.25);
  const slow = d.speed;
  const problem = r() < 0.06;
  const sid = hex(r, 16);
  return {
    uid: d.uid, at, sid, version, play_sec: play, open_sec: play + Math.round(r() * 600),
    long_tasks_pm: two((0.3 + r() * 1.2) * slow), dropped_pct: two((0.2 + r() * 1.1) * slow * slow), heap_mb: two(90 + r() * 120),
    first_frame_ms: Math.round((500 + r() * 900) * slow), rebuffer_n: Math.floor(r() * 3), rebuffer_pct: two(r() * 0.8),
    seek_n: 5 + Math.floor(r() * 30), seek_ms50: two(180 + r() * 200), seek_ms90: two((400 + r() * 600) * slow),
    sync_ms50: two(10 + r() * 20), sync_ms_max: two(60 + r() * 140), ready_ms: Math.round((700 + r() * 900) * slow),
    input_n: 40 + Math.floor(r() * 200), input_ms50: two((40 + r() * 40) * slow), input_ms90: two((90 + r() * 130) * slow),
    input_slow: Math.floor(r() * 4 * slow), keys: Math.floor(r() * 40 * d.keen), clicks: Math.floor(r() * 60),
    features: JSON.stringify(used), changed: JSON.stringify(changed.sort()), speeds: JSON.stringify(weighted(r, [[{ 1: 100 }, 3], [{ 1.5: 70, 1: 30 }, 3], [{ 2: 80, 1.5: 20 }, 2], [{ 1.25: 100 }, 1]])),
    quality: JSON.stringify({ 1080: 80, 720: 20 }), watched_pct: two(30 + r() * 70), skip_silence_sec: Math.floor(r() * 300),
    layout: pick(r, ['side', 'pip', 'single']), theme: pick(r, ['system', 'dark', 'light']), lang: 'en', frontend,
    pressure_bg: d.speed > 1.3 ? JSON.stringify({ nominal: 70, fair: 20, serious: 10 }) : JSON.stringify({ nominal: 95, fair: 5 }),
    pressure_idle: JSON.stringify({ nominal: 100 }), power: pick(r, ['ac', 'battery', 'mixed']),
    boot_path: weighted(r, [['intercept', 8], ['takeover', 2]]), inject_state: 'loading', boot_ms: Math.round((300 + r() * 500) * slow),
    uncaught: problem && r() < 0.3 ? 1 : 0, guard_off: problem ? JSON.stringify({ [pick(r, ['slides', 'silence', 'transcript'])]: 1 }) : null,
    stream_errors: r() < 0.03 ? JSON.stringify({ bufferStalledError: 1 }) : null,
    net_errors: r() < 0.08 ? JSON.stringify({ [pick(r, ['timeout', '5xx', 'network'])]: 1 }) : null,
    renew_ok: Math.floor(play / 1800), renew_fail: r() < 0.02 ? 1 : 0, send_fail: r() < 0.03 ? 1 : 0,
    country: d.country, region: d.region, asorg: d.asorg,
    ...slides(d, version, sid),
    ...extra,
  };
}

// Where the slide chapters came from (reported from 0.23.0): keyframes, unless the browser
// cannot decode them (no WebCodecs; iPhone Safari's decoder giving no picture) or, now and
// then, the scan stops on a network or decoder failure.
function slides(d, version, sid) {
  if (version !== '0.23.0') return {};
  if (!d.webcodecs) return { slide_src: 'thumbs', slide_stop: 'noWebCodecs' };
  if (d.browser === 'Safari' && d.mobile) return { slide_src: 'thumbs', slide_stop: 'noFrame' };
  const k = parseInt(sid.slice(0, 4), 16) % 40;
  if (k === 0) return { slide_src: 'thumbs', slide_stop: 'network' };
  if (k === 1) return { slide_src: 'thumbs', slide_stop: 'decoder' };
  if (k === 2) return { slide_src: 'none' };
  return { slide_src: 'frames' };
}

function envRow(d, at, version) {
  const row = { at, day: new Date(at).toISOString().slice(0, 10), version };
  for (const k of ['uid', 'browser', 'browser_v', 'os', 'mobile', 'touch', 'manager', 'manager_v', 'lang', 'browser_lang', 'screen_w', 'screen_h',
    'dpr', 'cores', 'mem_gb', 'gpu_vendor', 'webgpu', 'webcodecs', 'hw720', 'hw1080', 'arch', 'country', 'region', 'asorg']) row[k] = d[k];
  return row;
}

const OLD_FRONTEND = 'app.4f1c2e,vendor.9a07b3';
const NEW_FRONTEND = 'app.d81e55,vendor.9a07b3';

export function seed(db, scenario, now) {
  if (scenario === 'empty') return;
  const r = rng(scenario === 'solo' ? 7 : 42);
  if (scenario === 'solo') {
    const d = device(r, OWNER_UID, 0);
    Object.assign(d, { os: 'Linux', browser: 'Chrome', manager: 'Violentmonkey' });
    const days = [3, 1, 0];
    for (const ago of days) {
      const at = now - ago * DAY - 3600000;
      insert(db, 'env', envRow(d, at, '0.23.0'));
      insert(db, 'sessions', session(r, d, at + 60000, '0.23.0', NEW_FRONTEND));
    }
    // A short look (under a minute: counted as a viewing, not in performance).
    insert(db, 'sessions', session(r, d, now - 1800000, '0.23.0', NEW_FRONTEND, { play_sec: 40 }));
    insert(db, 'errors', { uid: d.uid, at: now - DAY, version: '0.23.0', feature: 'slides', type: 'TypeError', msg: 'Cannot read properties of null (reading <text>)', n: 1 });
    return;
  }
  // busy
  const devices = [];
  for (let i = 0; i < 42; i++) devices.push(device(r, i === 0 ? OWNER_UID : hex(r, 64), i));
  const changeAt = now - 20 * DAY; // Echo360 changed its page code
  const fixAt = now - 18 * DAY;    // 0.22.0 handled it
  for (let ago = 90; ago >= 0; ago--) {
    const dayStart = now - ago * DAY;
    const version = dayStart < fixAt ? '0.21.0' : dayStart < now - 6 * DAY ? '0.22.0' : '0.23.0';
    const frontend = dayStart < changeAt ? OLD_FRONTEND : NEW_FRONTEND;
    const weekday = new Date(dayStart).getUTCDay();
    // More devices over time; quieter at weekends.
    const active = devices.filter((d) => d.start < 12 + (90 - ago) * 0.34);
    for (const d of active) {
      if (r() > (weekday === 0 || weekday === 6 ? 0.18 : 0.42)) continue;
      // Updates reach devices over a few days.
      const v = version !== '0.21.0' && r() < 0.15 ? (version === '0.23.0' ? '0.22.0' : '0.21.0') : version;
      // Earlier in the day, never in the future (a viewing may run on for a few hours).
      const at = Math.min(dayStart - Math.floor(r() * 10) * 3600000, now - 4 * 3700000);
      insert(db, 'env', envRow(d, at, v));
      const broken = frontend === NEW_FRONTEND && v === '0.21.0';
      if (broken && r() < 0.85) {
        insert(db, 'fallbacks', { uid: d.uid, at: at + 1000, version: v, reason: 'noBootstrap', frontend, inject_state: 'loading', country: d.country, region: d.region, asorg: d.asorg });
        insert(db, 'errors', { uid: d.uid, at: at + 1000, version: v, feature: 'boot', type: 'Error', msg: 'Bootstrap data not found', n: 1 });
        continue;
      }
      const n = 1 + Math.floor(r() * 2.2);
      for (let k = 0; k < n; k++) insert(db, 'sessions', session(r, d, at + k * 3700000, v, frontend));
      if (r() < 0.04) insert(db, 'fallbacks', { uid: d.uid, at: at + 2000, version: v, reason: 'user', frontend, inject_state: 'loading', country: d.country, region: d.region, asorg: d.asorg });
      if (r() < 0.015) insert(db, 'fallbacks', { uid: d.uid, at: at + 3000, version: v, reason: pick(r, ['playbackError', 'libFailed']), frontend, inject_state: 'interactive', country: d.country, region: d.region, asorg: d.asorg });
      if (r() < 0.05) insert(db, 'errors', { uid: d.uid, at, version: v, feature: 'slides', type: 'TypeError', msg: 'Cannot read properties of null (reading <text>)', n: 1 + Math.floor(r() * 3) });
      if (r() < 0.03) insert(db, 'errors', { uid: d.uid, at, version: v, feature: 'silence', type: 'RangeError', msg: 'Offset is outside the bounds of the DataView', n: 1 });
      if (r() < 0.02) insert(db, 'errors', { uid: d.uid, at, version: v, feature: 'transcript', type: 'AbortError', msg: 'The operation was aborted.', n: 1 });
    }
  }
}
