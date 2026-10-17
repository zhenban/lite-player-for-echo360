// Anonymous usage data: the Worker (telemetry-worker/, against SQLite standing in for D1) and
// what the player sends (the whole userscript in a simulated lesson page).
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { newWindow, closeWindow } from './dom-guard.mjs';
import { assemble } from '../build.mjs';
import worker, { LIMITS } from '../telemetry-worker/src/index.js';
import { KINDS, cleanEvent, plainMessage } from '../telemetry-worker/src/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Every migration, in order (as wrangler applies them).
const migrationDir = join(root, 'telemetry-worker', 'migrations');
const migration = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(migrationDir, f), 'utf8')).join('\n');

// ---- the Worker ----

test('D1: no table over 100 columns (D1\'s limit; SQLite here allows 2000)', () => {
  // Migration 0004 first failed on the live database with "too many columns": sessions had
  // 100 and it added two.
  const db = new DatabaseSync(':memory:');
  db.exec(migration);
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    const n = db.prepare('SELECT count(*) AS n FROM pragma_table_info(?)').get(name).n;
    assert.ok(n <= 100, name + ' has ' + n + ' columns');
  }
  // Every column the Worker writes exists.
  for (const [kind, fields] of Object.entries(KINDS)) {
    const table = { env: 'env', session: 'sessions', error: 'errors', fallback: 'fallbacks' }[kind];
    const have = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((r) => r.name));
    for (const f of fields) assert.ok(have.has(f[1].split('.')[0]), table + '.' + f[1]);
  }
});

test('D1 migration 0004: the old timing columns become the work and steps JSON, rows and indexes kept', () => {
  const files = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort();
  const before = files.filter((f) => f < '0004').map((f) => readFileSync(join(migrationDir, f), 'utf8')).join('\n');
  const db = new DatabaseSync(':memory:');
  db.exec(before);
  db.exec(`INSERT INTO sessions (uid, at, sid, version, play_sec, scan_frame_ms50, scan_frame_ms90, scan_frame_n, ocr_mpx_n, luma_v, luma_p10, luma_p50, luma_p90, luma_n, luma_cond)
    VALUES ('u1', 1, 's1', '0.22.0', 600, 12, 30, 40, 3, 1, 0.5, 0.6, 0.9, 9, '{"playing":5}')`);
  db.exec("INSERT INTO sessions (uid, at, sid, version, play_sec) VALUES ('u2', 2, 's2', '0.22.0', 60)");
  db.exec(readFileSync(join(migrationDir, files.find((f) => f.startsWith('0004'))), 'utf8'));
  const rows = db.prepare('SELECT uid, play_sec, work, steps, slide_src FROM sessions ORDER BY uid').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].play_sec, 600);
  assert.deepEqual(JSON.parse(rows[0].work), { scanFrame: { ms50: 12, ms90: 30, n: 40 }, ocrMpx: { n: 3 } });
  assert.deepEqual(JSON.parse(rows[0].steps), { luma: { v: 1, p10: 0.5, p50: 0.6, p90: 0.9, n: 9, cond: { playing: 5 } } });
  assert.equal(rows[1].work, null, 'nothing measured: NULL, not {}');
  assert.equal(rows[1].steps, null);
  assert.equal(rows[0].slide_src, null);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'").all().map((r) => r.name).sort();
  for (const name of ['sessions_at', 'sessions_loud', 'sessions_luma', 'sessions_uid', 'sessions_version']) assert.ok(idx.includes(name), name);
  // The upsert key survives: the same viewing again replaces its row.
  assert.throws(() => db.exec("INSERT INTO sessions (uid, at, sid, version) VALUES ('u1', 3, 's1', '0.24.0')"), /UNIQUE/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sessions_json'").get().n, 0);
});

test('Worker: timings sent as flat fields are stored nested in work and steps', () => {
  const c = cleanEvent({ k: 'session', sid: '0123456789abcdef', v: '1.0.0', scanFrameMs50: 12.34, scanFrameN: 40, ocrMpxMs90: 'x',
    lumaV: 1, lumaP10: 0.5, lumaCond: { playing: 5, bogus: 2 } });
  assert.deepEqual(JSON.parse(c.row.work), { scanFrame: { ms50: 12, n: 40 } });
  assert.deepEqual(JSON.parse(c.row.steps), { luma: { v: 1, p10: 0.5, cond: { playing: 5 } } });
  assert.equal(cleanEvent({ k: 'session', sid: '0123456789abcdef', v: '1.0.0' }).row.work, null);
});


// D1's prepare/bind/batch over an in-memory SQLite database.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(migration);
  return {
    db,
    prepare(sql) { return { sql, args: [], bind(...a) { return Object.assign({}, this, { args: a }); } }; },
    async batch(list) {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => {
          const st = db.prepare(s.sql);
          if (/^\s*SELECT/i.test(s.sql)) return { results: st.all(...s.args) };
          return { meta: { changes: Number(st.run(...s.args).changes) } };
        });
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

function limiter(allow) { return { calls: [], async limit(o) { this.calls.push(o.key); return { success: allow() }; } }; }

function envOf(over) {
  return Object.assign({ DB: fakeD1(), EVENTS_LIMIT: limiter(() => true), ME_LIMIT: limiter(() => true) }, over);
}

function post(path, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const req = new Request('https://telemetry.example' + path, { method: 'POST', body: text, headers: Object.assign({ 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, headers) });
  Object.defineProperty(req, 'cf', { value: { country: 'AU', region: 'New South Wales', asOrganization: 'Example Uni Network', city: 'Sydney', latitude: '-33.9' } });
  return req;
}

const secret = 'A'.repeat(42) + 'g';
const uid = createHash('sha256').update(secret).digest('hex');
const other = createHash('sha256').update('B'.repeat(43)).digest('hex');

test('telemetry worker: stores only the listed fields, with country, region and network, never the address', async () => {
  const env = envOf();
  const r = await worker.fetch(post('/v1/events', {
    uid, extra: 'dropped',
    events: [
      { k: 'env', v: '1.0.0', browser: 'Chrome', browserV: 155, os: 'Linux', webgpu: true, cores: 8, name: 'Jane', ip: '1.2.3.4' },
      { k: 'session', v: '1.0.0', sid: '0123456789abcdef', playSec: 600, features: { play: 3, nonsense: 9 }, changed: ['layout', 'password'], layout: 'side', speed: 1.5, lesson: 'G_abc' },
      { k: 'error', v: '1.0.0', feature: 'slide chapters', type: 'TypeError', msg: 'failed for "Jane Doe" at https://echo360.net.au/lesson/G_1/x id 123456', n: 2 },
      { k: 'fallback', v: '1.0.0', reason: 'noBootstrap' },
      { k: 'fallback', v: '1.0.0', reason: 'made up' },
      { k: 'secret', v: '1.0.0' },
      { k: 'session', v: '1.0.0', playSec: 1 },
    ],
  }), env);
  assert.equal(r.status, 200);
  const answer = await r.json();
  assert.equal(answer.stored, 4);
  assert.ok(Math.abs(answer.now - Date.now()) < 5000, 'the Worker\'s clock comes back');
  const db = env.DB.db;
  const envRow = db.prepare('SELECT * FROM env').get();
  assert.equal(envRow.uid, uid);
  assert.equal(envRow.webgpu, 1);
  assert.equal(envRow.country, 'AU');
  assert.equal(envRow.region, 'New South Wales');
  assert.equal(envRow.asorg, 'Example Uni Network');
  const s = db.prepare('SELECT * FROM sessions').get();
  assert.equal(s.features, '{"play":3}');
  assert.equal(s.changed, '["layout"]');
  const e = db.prepare('SELECT * FROM errors').get();
  assert.ok(!/Jane|http|echo360|\d/.test(e.msg), e.msg);
  // Nothing anywhere holds the address, the city or the coordinates.
  for (const t of ['env', 'sessions', 'errors', 'fallbacks']) {
    const dump = JSON.stringify(db.prepare('SELECT * FROM ' + t).all());
    assert.ok(!/203\.0\.113\.9|Sydney|-33\.9|Jane|G_abc|1\.2\.3\.4/.test(dump), t + ': ' + dump);
  }
  // The rate limit is keyed by the address (a counter, not stored).
  assert.deepEqual(env.EVENTS_LIMIT.calls, ['203.0.113.9']);
});

test('telemetry worker: one environment row a day and one row per viewing (the latest summary)', async () => {
  const env = envOf();
  const send = (events) => worker.fetch(post('/v1/events', { uid, events }), env);
  await send([{ k: 'env', v: '1.0.0', cores: 4 }, { k: 'session', v: '1.0.0', sid: 'aaaaaaaaaaaaaaaa', playSec: 10 }]);
  await send([{ k: 'env', v: '1.0.1', cores: 8 }, { k: 'session', v: '1.0.0', sid: 'aaaaaaaaaaaaaaaa', playSec: 70 }, { k: 'session', v: '1.0.0', sid: 'bbbbbbbbbbbbbbbb', playSec: 5 }]);
  const db = env.DB.db;
  assert.deepEqual(db.prepare('SELECT version, cores FROM env').all().map((r) => [r.version, r.cores]), [['1.0.1', 8]]);
  assert.deepEqual(db.prepare('SELECT sid, play_sec FROM sessions ORDER BY sid').all().map((r) => [r.sid, r.play_sec]), [['aaaaaaaaaaaaaaaa', 70], ['bbbbbbbbbbbbbbbb', 5]]);
});

test('telemetry worker: refuses what is malformed, too large, too many, or too often', async () => {
  const env = envOf();
  const status = async (req, e = env) => (await worker.fetch(req, e)).status;
  assert.equal(await status(post('/v1/events', { uid: 'nothex', events: [{ k: 'fallback', v: '1.0.0', reason: 'user' }] })), 400);
  assert.equal(await status(post('/v1/events', { uid, events: [] })), 400);
  assert.equal(await status(post('/v1/events', { uid, events: Array(LIMITS.events + 1).fill({ k: 'fallback', v: '1.0.0', reason: 'user' }) })), 400);
  assert.equal(await status(post('/v1/events', 'not json')), 400);
  assert.equal(await status(post('/v1/events', JSON.stringify({ uid, events: [{ k: 'error', v: '1.0.0', feature: 'x', msg: 'y'.repeat(LIMITS.bodyBytes) }] }))), 400);
  assert.equal(await status(new Request('https://telemetry.example/v1/events')), 405);
  assert.equal(await status(post('/v1/other', {})), 404);
  const blocked = envOf({ EVENTS_LIMIT: limiter(() => false) });
  assert.equal(await status(post('/v1/events', { uid, events: [{ k: 'fallback', v: '1.0.0', reason: 'user' }] }), blocked), 429);
  // Viewing and deleting have their own (stricter) limit.
  const meBlocked = envOf({ ME_LIMIT: limiter(() => false) });
  assert.equal(await status(post('/v1/me', { uid, secret }), meBlocked), 429);
  assert.equal(meBlocked.ME_LIMIT.calls.length, 1);
  // Only the lecture site may call it from a page.
  const r = await worker.fetch(post('/v1/events', { uid, events: [{ k: 'fallback', v: '1.0.0', reason: 'user' }] }, { origin: 'https://evil.example' }), env);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const ok = await worker.fetch(post('/v1/events', { uid, events: [{ k: 'fallback', v: '1.0.0', reason: 'user' }] }, { origin: 'https://echo360.net.au' }), env);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://echo360.net.au');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
});

test('telemetry worker: viewing and deleting need the secret; an id alone or a wrong secret gets nothing', async () => {
  const env = envOf();
  await worker.fetch(post('/v1/events', { uid, events: [{ k: 'fallback', v: '1.0.0', reason: 'user' }, { k: 'error', v: '1.0.0', feature: 'zoom' }] }), env);
  await worker.fetch(post('/v1/events', { uid: other, events: [{ k: 'fallback', v: '1.0.0', reason: 'auth' }] }), env);
  const ask = async (path, body) => { const r = await worker.fetch(post(path, body), env); return { status: r.status, data: await r.json() }; };
  assert.equal((await ask('/v1/me', { uid })).status, 403);
  assert.equal((await ask('/v1/me', { uid, secret: 'B'.repeat(43) })).status, 403);
  assert.equal((await ask('/v1/me', { uid: other, secret })).status, 403);
  assert.equal((await ask('/v1/me/delete', { uid, secret: 'B'.repeat(43) })).status, 403);
  assert.equal((await ask('/v1/me/delete', { uid: other, secret })).status, 403);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM fallbacks').get().n, 2);
  const mine = await ask('/v1/me', { uid, secret });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.fallback.map((r) => r.reason), ['user']);
  assert.equal(mine.data.error.length, 1);
  assert.ok(!('uid' in mine.data.fallback[0]) && !('id' in mine.data.fallback[0]));
  const gone = await ask('/v1/me/delete', { uid, secret });
  assert.deepEqual(gone.data.deleted, { env: 0, session: 0, error: 1, fallback: 1, registration: 0 });
  assert.deepEqual((await ask('/v1/me', { uid, secret })).data, { env: [], session: [], error: [], fallback: [], registration: [] });
  // Someone else's data stays.
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM fallbacks').get().n, 1);
});

test('telemetry worker: every column in the database is one the schema lists', () => {
  const db = fakeD1().db;
  const tables = { env: 'env', session: 'sessions', error: 'errors', fallback: 'fallbacks' };
  for (const [kind, table] of Object.entries(tables)) {
    const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((r) => r.name);
    const listed = ['id', 'uid', 'at', 'country', 'region', 'asorg', 'auth', 'flags', ...(kind === 'env' ? ['day'] : []), ...KINDS[kind].map((f) => f[1].split('.')[0])];
    assert.deepEqual(cols.slice().sort(), [...new Set(listed)].sort(), table);
  }
  assert.equal(plainMessage('Cannot read "x" of https://a.b/c?d=1 (id 9f8e7d6c5b4a) for me@x.edu'), 'Cannot read <text> of <url> (id <id>) for <email>');
});

test('telemetry queries: each runs on the stored tables within D1\'s limits, and the performance figures are right', () => {
  const db = fakeD1().db;
  const now = Date.now();
  const add = db.prepare("INSERT INTO sessions (uid, at, sid, version, play_sec, long_tasks_pm, rebuffer_n) VALUES ('u', ?, ?, '1.0.0', ?, ?, ?)");
  // Long tasks 1..5 per minute: median 3, 90th percentile 5; one short viewing is left out.
  [1, 2, 3, 4, 5].forEach((n, i) => add.run(now, 's' + i, 600, n, i === 0 ? 1 : 0));
  add.run(now, 'short', 30, 99, 0);
  const dir = join(root, 'telemetry-worker', 'queries');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const sql = readFileSync(join(dir, f), 'utf8');
    // D1 refuses a compound SELECT of more than five terms.
    assert.ok((sql.match(/\bUNION\b/gi) || []).length <= 4, f + ': at most four UNIONs');
    assert.doesNotThrow(() => db.prepare(sql).all(), f);
  }
  const rows = db.prepare(readFileSync(join(dir, 'performance.sql'), 'utf8')).all();
  const lt = rows.find((r) => r.metric === 'long_tasks_per_min');
  assert.deepEqual([lt.sessions, lt.median, lt.p90], [5, 3, 5]);
  const rb = rows.find((r) => r.metric === 'rebuffer_per_hour');
  assert.equal(rb.p90, 6, 'one rebuffer in ten minutes is six an hour');
});

// ---- the player ----

const script = assemble().out;
const boot = readFileSync(join(root, 'test', 'fixtures', 'boot-echo360-classroom.json'), 'utf8');
const WORKER = /const TELEMETRY_URL = '([^']+)'/.exec(script)[1];

function fakeHls() {
  class FakeHls {
    constructor() { this.levels = []; }
    static isSupported() { return true; }
    on() {}
    once() {}
    loadSource() {}
    attachMedia() {}
    startLoad() {}
    destroy() {}
  }
  FakeHls.Events = { ERROR: 'e', MANIFEST_PARSED: 'm', LEVEL_SWITCHED: 'l', MEDIA_DETACHING: 'd', MEDIA_ATTACHED: 'a' };
  FakeHls.ErrorTypes = { NETWORK_ERROR: 'n', MEDIA_ERROR: 'x' };
  return FakeHls;
}

// A lesson page whose requests to the Worker are recorded (everything else fails).
function page(prefs, setup, src = script) {
  const w = newWindow({ url: 'https://echo360.net.au/lesson/x/classroom', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  w.Hls = fakeHls();
  w.localStorage.setItem('lite-player-for-echo360:debug', 'true');
  if (prefs) w.localStorage.setItem('lite-player-for-echo360:prefs', JSON.stringify(prefs));
  const sent = [];
  w.fetch = async (url, opts) => {
    if (String(url).startsWith(WORKER)) {
      sent.push({ url: String(url), body: JSON.parse(opts.body), credentials: opts.credentials, keepalive: opts.keepalive });
      return new w.Response('{"stored":1}', { status: 200 });
    }
    throw new Error('offline in tests');
  };
  w.document.body.innerHTML = '<div id="echo-player-root"></div>';
  // The script runs at document start (the page has not started its own player yet).
  Object.defineProperty(w.document, 'readyState', { value: 'loading', configurable: true });
  if (setup) setup(w);
  w.eval(src);
  w.Echo = { echoPlayerV2FullApp: () => {} };
  w.eval('Echo["echoPlayerV2FullApp"](' + JSON.stringify(boot) + ')');
  return { w, sent, player: () => w.__litePlayerForEcho360, dev: () => w.__litePlayerForEcho360Dev };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

// Every field of every event is one the Worker keeps, and passes its check.
function assertAccepted(ev) {
  const fields = KINDS[ev.k];
  assert.ok(fields, 'kind ' + ev.k);
  const c = cleanEvent(ev);
  assert.ok(c, 'accepted: ' + JSON.stringify(ev));
  for (const [k, v] of Object.entries(ev)) {
    if (k === 'k' || v === undefined) continue;
    const f = fields.find((x) => x[0] === k);
    assert.ok(f, ev.k + '.' + k + ' is not a field the Worker keeps');
    // A dotted column is a key inside a JSON column.
    const [col, ...path] = f[1].split('.');
    const stored = path.reduce((o, key) => (o == null ? o : o[key]), path.length ? JSON.parse(c.row[col] || 'null') : c.row[col]);
    assert.notEqual(stored, null, ev.k + '.' + k + ' = ' + JSON.stringify(v) + ' fails the Worker check');
  }
}

test('telemetry: a viewing is summed up when the player goes, in fields the Worker keeps, under the hash of a private secret', async () => {
  const pg = page({ layout: 'pip', rate: 1.5 });
  const p = pg.player();
  await settle();
  p.usage.opened -= 60000;
  p.usage.use('play', 'key');
  p.usage.use('seekbar', 'click');
  p.$('.layout').dispatchEvent(new pg.w.MouseEvent('click', { bubbles: true }));
  p.destroy();
  await settle();
  assert.equal(pg.sent.length, 1);
  const { url, body, credentials } = pg.sent[0];
  assert.equal(url, WORKER + '/v1/events');
  assert.equal(credentials, 'omit');
  assert.match(body.uid, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(body).sort(), ['events', 'uid']);
  const s = body.events[0];
  assert.equal(s.k, 'session');
  assert.deepEqual(s.features, { play: 1, seekbar: 1, layout: 1 });
  assert.equal(s.keys, 1);
  assert.equal(s.clicks, 2);
  assert.deepEqual(s.changed.sort(), ['layout', 'rate']);
  assert.ok(s.openSec >= 60);
  for (const ev of body.events) assertAccepted(ev);
  // The secret: kept apart, its hash is the id, and it is in nothing the user copies or saves.
  const stored = pg.w.localStorage.getItem('lite-player-for-echo360:telemetrySecret');
  assert.match(stored, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(stored).digest('hex'), body.uid);
  assert.ok(!JSON.stringify(body).includes(stored));
  await closeWindow(pg.w);
});

test('telemetry: the environment and errors use fields the Worker keeps; error messages lose names, addresses and numbers', async () => {
  const pg = page();
  const t = pg.dev().telemetry;
  const env = await pg.dev().telemetryEnv();
  assertAccepted(JSON.parse(JSON.stringify(env)));
  t.error('slide chapters', new TypeError('could not read "Lecture 5 - Jane Doe.pdf" from https://echo360.net.au/media/G_77/x?sig=abc 404'));
  t.error('slide chapters', new TypeError('could not read "Other.pdf" from https://echo360.net.au/media/G_78/x?sig=abd 403'));
  t.flushErrors(true);
  await settle();
  const errs = pg.sent.flatMap((x) => x.body.events).filter((e) => e.k === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].n, 2);
  assert.equal(errs[0].msg, 'could not read <text> from <url> #');
  for (const ev of errs) assertAccepted(ev);
  await closeWindow(pg.w);
});

test('telemetry: an iPad (Safari says Macintosh) is iOS; slides from preview pictures only, and why, are in the session', async () => {
  // Field report: iPadOS 15.7 has no WebCodecs; its sessions were filed under macOS and did
  // not say the chapters were only the preview pictures' estimate.
  const pg = page(null, (w) => {
    Object.defineProperty(w.navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.4 Safari/605.1.15', configurable: true });
    Object.defineProperty(w.navigator, 'maxTouchPoints', { value: 5, configurable: true });
  });
  const env = await pg.dev().telemetryEnv();
  assert.equal(env.os, 'iOS');
  assert.equal(env.browser, 'Safari');
  assert.equal(env.webcodecs, false);
  assertAccepted(JSON.parse(JSON.stringify(env)));
  const p = pg.player();
  await settle();
  p.usage.opened -= 60000;
  p.slides = { source: 'thumbs', stopped: 'noWebCodecs', state: 'done', chapters: [{}, {}], screenIndex: 0, manualScreen: null };
  p.destroy();
  await settle();
  const s = pg.sent.flatMap((x) => x.body.events).find((e) => e.k === 'session');
  assert.equal(s.slideSrc, 'thumbs');
  assert.equal(s.slideStop, 'noWebCodecs');
  assert.equal(s.slideForm, undefined, 'no keyframe scan, no form');
  assertAccepted(s);
  await closeWindow(pg.w);
});

test('telemetry: the session says which form of the video gave pictures (Annex B: iPhone Safari)', async () => {
  for (const form of ['annexb', 'avcc', 'neither']) {
    const pg = page();
    const p = pg.player();
    await settle();
    p.usage.opened -= 60000;
    p.slides = { source: form === 'neither' ? 'thumbs' : 'frames', stopped: form === 'neither' ? 'noFrame' : null, state: 'done', chapters: [{}, {}], screenIndex: 0, manualScreen: null, reader: { form } };
    p.destroy();
    await settle();
    const s = pg.sent.flatMap((x) => x.body.events).find((e) => e.k === 'session');
    assert.equal(s.slideForm, form);
    assertAccepted(s);
    await closeWindow(pg.w);
  }
});

test('telemetry: a Mac without a touch screen stays macOS', async () => {
  const pg = page(null, (w) => {
    Object.defineProperty(w.navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', configurable: true });
    Object.defineProperty(w.navigator, 'maxTouchPoints', { value: 0, configurable: true });
  });
  assert.equal((await pg.dev().telemetryEnv()).os, 'macOS');
  pg.player().destroy();
  await closeWindow(pg.w);
});

test('telemetry: turned off in the settings, nothing more is sent, and the setting is kept', async () => {
  const pg = page();
  const p = pg.player();
  await settle();
  p.usage.opened -= 60000;
  const item = p.menus.telemetryItems()[0];
  assert.equal(item.on(), true, 'on by default');
  pg.dev().telemetry.error('zoom', new Error('x'));
  item.set(false);
  p.destroy();
  pg.dev().telemetry.fallback('user');
  await settle();
  assert.equal(pg.sent.length, 0);
  assert.equal(JSON.parse(pg.w.localStorage.getItem('lite-player-for-echo360:prefs')).telemetry, false);
  await closeWindow(pg.w);
  // A later page starts with it off.
  const again = page({ telemetry: false });
  await settle();
  again.player().usage.opened -= 60000;
  again.player().destroy();
  await settle();
  assert.equal(again.sent.length, 0);
  await closeWindow(again.w);
});

test('telemetry: viewing, deleting and resetting the id send the secret only in the body, to the Worker', async () => {
  const pg = page();
  const p = pg.player();
  await settle();
  const t = pg.dev().telemetry;
  await t.ask('/v1/me');
  const first = pg.sent[0];
  assert.equal(first.url, WORKER + '/v1/me');
  const secret1 = pg.w.localStorage.getItem('lite-player-for-echo360:telemetrySecret');
  assert.equal(first.body.secret, secret1);
  assert.ok(!first.url.includes(secret1));
  t.resetIdentity();
  await t.ask('/v1/me/delete');
  const second = pg.sent[1];
  assert.notEqual(second.body.secret, secret1);
  assert.equal(createHash('sha256').update(second.body.secret).digest('hex'), second.body.uid);
  // The diagnostics hold neither secret.
  const diag = p.menus.x.diagnostics();
  assert.ok(!diag.includes(secret1) && !diag.includes(second.body.secret));
  p.destroy();
  await closeWindow(pg.w);
});

test('telemetry: the summary goes out while the page closes, at once and with keepalive', async () => {
  const pg = page();
  const p = pg.player();
  await settle();
  p.usage.opened -= 60000;
  // Nothing is awaited between pagehide and the request (the page may be gone after it).
  pg.w.dispatchEvent(new pg.w.Event('pagehide'));
  assert.equal(pg.sent.length, 1, 'sent synchronously in the pagehide handler');
  assert.equal(pg.sent[0].keepalive, true);
  assert.equal(pg.sent[0].body.events[0].k, 'session');
  p.destroy();
  await closeWindow(pg.w);
});

test('telemetry worker: the newer fields keep only known keys and two significant digits', async () => {
  const env = envOf();
  const r = await worker.fetch(post('/v1/events', {
    uid,
    events: [
      { k: 'env', v: '1.0.0', gpuVendor: 'nvidia', gpuArch: 'ampere', hw720: true, arch: 'arm', bitness: 64, osV: 15, charging: false, timerUs: 100.4, gpuF16: true, model: 'SM-X710', manager: 'Stay' },
      {
        k: 'session', v: '1.0.0', sid: 'cccccccccccccccc', seekMs50: 123.456, inputMs90: 248.7,
        quality: { 720: 87.5, 360: 12.5, '<b>': 1 }, pressureBg: { nominal: 90, fair: 10, hot: 5 }, pressureIdle: { nominal: 100 }, power: 'mixed',
        bootPath: 'takeover', injectState: 'complete', bootMs: 412, blockedReports: 2,
        netErrors: { 403: 2, network: 1, 'G_abc': 3 }, streamErrors: { fragLoadError: 4, 'frag load': 1 },
        guardOff: { 'slide chapters': 1, 'Jane Doe': 1 },
        lumaV: 1, lumaP10: 0.8123, lumaP50: 1.234, lumaN: 3,
        lumaCond: { playing: 2, paused: 1, 'rate:1.5': 3, 'cpu:nominal': 3, 'power:ac': 3, 'lesson:x': 1 },
        scanFrameMs50: 7.8912, scanFrameN: 120,
      },
    ],
  }), env);
  assert.equal(r.status, 200);
  const db = env.DB.db;
  const e = db.prepare('SELECT * FROM env').get();
  assert.deepEqual([e.gpu_vendor, e.gpu_arch, e.hw720, e.arch, e.bitness, e.os_v, e.charging, e.timer_us, e.gpu_f16, e.model, e.manager], ['nvidia', 'ampere', 1, 'arm', 64, 15, 0, 100, 1, 'SM-X710', 'Stay']);
  const s = db.prepare('SELECT * FROM sessions').get();
  assert.equal(s.seek_ms50, 120);
  assert.equal(s.input_ms90, 250);
  assert.deepEqual(JSON.parse(s.quality), { 720: 88, 360: 13 });
  assert.deepEqual(JSON.parse(s.pressure_bg), { nominal: 90, fair: 10 });
  assert.deepEqual([JSON.parse(s.pressure_idle), s.power], [{ nominal: 100 }, 'mixed']);
  assert.deepEqual([s.boot_path, s.inject_state, s.boot_ms, s.blocked_reports], ['takeover', 'complete', 412, 2]);
  assert.deepEqual(JSON.parse(s.net_errors), { 403: 2, network: 1 });
  assert.deepEqual(JSON.parse(s.stream_errors), { fragLoadError: 4 });
  // "Jane Doe" fits the pattern of a feature name but not a known one... it is lower-case
  // letters only that pass: a capitalised name does not.
  assert.deepEqual(JSON.parse(s.guard_off), { 'slide chapters': 1 });
  assert.deepEqual(JSON.parse(s.steps), { luma: { v: 1, p10: 0.81, p50: 1.2, n: 3, cond: { playing: 2, paused: 1, 'rate:1.5': 3, 'cpu:nominal': 3, 'power:ac': 3 } } });
  assert.deepEqual(JSON.parse(s.work), { scanFrame: { ms50: 7.9, n: 120 } });
});

test('telemetry: percentiles, two significant digits, and a bounded sample of values', async () => {
  const pg = page();
  const { TelemetryValues, sig2 } = pg.dev();
  assert.deepEqual([sig2(0.012345), sig2(123.4), sig2(98765), sig2(0), sig2(NaN)], [0.012, 120, 99000, 0, undefined]);
  const v = new TelemetryValues();
  for (let i = 1; i <= 10; i++) v.add(i);
  assert.deepEqual([v.q(0.1), v.q(0.5), v.q(0.9), v.n, v.max], [1, 5, 9, 10, 10]);
  for (let i = 0; i < 5000; i++) v.add(i % 100);
  assert.ok(v.v.length <= 400, 'at most 400 values kept');
  assert.equal(v.n, 5010);
  const mid = v.q(0.5);
  assert.ok(mid >= 40 && mid <= 60, 'the sample keeps the distribution: median ' + mid);
  pg.player().destroy();
  await closeWindow(pg.w);
});

test('telemetry: fixed steps are timed in batches of 20 ms, with their version and conditions', async () => {
  const pg = page();
  const p = pg.player();
  await settle();
  const t = pg.dev().telemetry;
  // 0.5 ms for 14 400 pixels: 39 runs are 19.5 ms, not yet a batch.
  for (let i = 0; i < 39; i++) t.step('luma', 1, 14400, 0.5);
  const sum = () => JSON.parse(JSON.stringify(p.usage.summary()));
  assert.equal(sum().lumaN, undefined);
  t.step('luma', 1, 14400, 0.5);
  let s = sum();
  // 20 ms / 576 000 pixels = 34.7 ms per million pixels.
  assert.deepEqual([s.lumaV, s.lumaN, s.lumaP10, s.lumaP50, s.lumaP90], [1, 1, 35, 35, 35]);
  assert.deepEqual(s.lumaCond, { paused: 1, 'rate:1': 1, 'cpu:unknown': 1, 'power:unknown': 1 });
  // A batch of another version starts again (versions are never mixed).
  for (let i = 0; i < 10; i++) t.step('luma', 2, 1e6, 2);
  s = sum();
  assert.deepEqual([s.lumaV, s.lumaN, s.lumaP50], [2, 1, 2]);
  // Several batches: the percentiles are of the batches.
  for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) t.step('loud', 1, 1e6, 20 * k);
  s = sum();
  assert.deepEqual([s.loudN, s.loudP10, s.loudP50, s.loudP90], [10, 20, 100, 180]);
  assertAccepted(s);
  p.destroy();
  await closeWindow(pg.w);
});

test('telemetry: a viewing counts failures, downloads, skips, interactions and the work of the analyses', async () => {
  const pg = page();
  pg.w.localStorage.setItem('lite-player-for-echo360:telemetryPending', JSON.stringify({ sendFail: 2 }));
  const p = pg.player();
  await settle();
  const t = pg.dev().telemetry;
  // A viewing started after the page loaded takes the counts left by earlier pages.
  p.destroy();
  const p2 = new (p.constructor)(p.lesson, p.opts);
  await settle();
  const u = p2.usage;
  assert.equal(u.fromLoad, false, 'the second viewing on the page');
  // (The test page has no network: what the player itself tried is not counted here.)
  u.counts.net = {};
  u.cacheHit = 0;
  u.cacheMiss = 0;
  for (const k of [403, 403, 503, 404, 'network', 'timeout']) t.note('net', k);
  t.note('stream', 'fragLoadError');
  t.note('stream', 'not a name!');
  t.note('cache', 'hit');
  t.note('cache', 'miss');
  t.note('skip', 'silence', 12.4);
  t.note('skip', 'black', 30);
  t.note('bgBytes', null, 7.5e6);
  for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) t.note('work', 'scanFrame', ms);
  t.note('work', 'made up', 5);
  t.note('guardOff', 'slide chapters');
  t.selfCount('dropped');
  // Three presses; Event Timing reported one of them (the others took under 16 ms).
  for (let i = 0; i < 3; i++) pg.w.document.dispatchEvent(new pg.w.Event('pointerdown'));
  u.inputMs.set(7, 250);
  // A fourth whose answer was never drawn (a window behind others): left out entirely.
  pg.w.document.dispatchEvent(new pg.w.Event('pointerdown'));
  u.inputUndrawn.add(8);
  u.mark('chapters');
  u.mark('chapters');
  const s = JSON.parse(JSON.stringify(u.summary()));
  assert.deepEqual(s.netErrors, { 403: 2, '5xx': 1, '4xx': 1, network: 1, timeout: 1 });
  assert.deepEqual(s.streamErrors, { fragLoadError: 1 });
  assert.deepEqual([s.cacheHit, s.cacheMiss, s.skipSilenceSec, s.skipBlankSec], [1, 1, 12, 30]);
  assert.deepEqual([s.scanFrameN, s.scanFrameMs50, s.scanFrameMs90], [10, 50, 90]);
  assert.deepEqual(s.guardOff, { 'slide chapters': 1 });
  assert.deepEqual([s.inputN, s.inputMs50, s.inputMs90, s.inputSlow], [3, 16, 250, 1]);
  assert.deepEqual([s.sendFail, s.dropped], [2, 1]);
  assert.equal(pg.w.localStorage.getItem('lite-player-for-echo360:telemetryPending'), 'null', 'handed over once');
  assert.ok(s.bgMbPerHour > 0);
  assert.ok(s.chaptersMs >= 0);
  assert.equal(s.lang, 'en');
  assert.equal(s.theme, 'system');
  assertAccepted(s);
  p2.destroy();
  await closeWindow(pg.w);
});

test('telemetry: CPU pressure is watched only while playing in a visible tab, with and without background analyses; power over the time played', async () => {
  const observers = [];
  let battery = null;
  const pg = page(null, (w) => {
    w.PressureObserver = class {
      constructor(cb) { this.cb = cb; this.on = false; observers.push(this); }
      observe() { this.on = true; return Promise.resolve(); }
      disconnect() { this.on = false; }
    };
    battery = { charging: true, fns: [], addEventListener(t, f) { this.fns.push(f); }, removeEventListener() {} };
    Object.defineProperty(w.navigator, 'getBattery', { value: () => Promise.resolve(battery), configurable: true });
  });
  const p = pg.player();
  await settle();
  const u = p.usage;
  const bg = pg.dev().bgWork;
  const watching = () => observers.filter((o) => o.on);
  const play = (on) => {
    Object.defineProperty(p.video, 'paused', { value: !on, configurable: true });
    p.video.dispatchEvent(new pg.w.Event(on ? 'playing' : 'pause'));
  };
  const hide = (hidden) => {
    Object.defineProperty(pg.w.document, 'hidden', { value: hidden, configurable: true });
    pg.w.document.dispatchEvent(new pg.w.Event('visibilitychange'));
  };
  const played = (ms) => { u.lastTick = pg.w.performance.now() - ms; u.tick(); };
  assert.equal(watching().length, 0, 'not watched while paused');
  play(true);
  assert.equal(watching().length, 1, 'watched while playing');
  const running = bg.n;                           // the page's own analyses, set here instead
  bg.n = 0;
  watching()[0].cb([{ state: 'serious' }]);
  played(1000);                                   // no analysis running: serious
  bg.n = 1;
  watching()[0].cb([{ state: 'nominal' }]);
  played(1000);                                   // an analysis running: nominal
  bg.n = 0;
  battery.charging = false;
  for (const f of battery.fns) f();
  played(500);                                    // none running: nominal; on battery
  hide(true);
  assert.equal(watching().length, 0, 'not watched in a hidden tab');
  played(1000);                                   // hidden: no pressure counted (power is)
  hide(false);
  assert.equal(watching().length, 1, 'watched again when visible');
  play(false);
  assert.equal(watching().length, 0, 'not watched once paused');
  const s = JSON.parse(JSON.stringify(u.summary()));
  assert.deepEqual(s.pressureIdle, { serious: 67, nominal: 33 });
  assert.deepEqual(s.pressureBg, { nominal: 100 });
  assert.equal(s.power, 'mixed');
  assert.equal(s.pressure, undefined);
  assert.equal(s.batteryPct, undefined);
  bg.n = running;
  assertAccepted(s);
  p.destroy();
  await closeWindow(pg.w);
});

test('telemetry: a send that is given up is counted, and told with the viewing', async () => {
  const pg = page();
  const p = pg.player();
  await settle();
  const t = pg.dev().telemetry;
  pg.w.fetch = async () => new pg.w.Response('{"error":"format"}', { status: 400 });
  await t.send([{ k: 'fallback', v: '1.0.0', reason: 'user' }]);
  assert.equal(p.usage.summary().sendFail, 1);
  p.destroy();
  await closeWindow(pg.w);
});

test('telemetry queries: devices in tiers by their fixed-step time, and how well the steps follow the real work', () => {
  const db = fakeD1().db;
  const now = Date.now();
  // The timings as the Worker stores them (JSON; a NULL leaves the key out).
  const add = db.prepare(`INSERT INTO sessions (uid, at, sid, version, play_sec, steps, dropped_pct, input_ms90, work, pressure_bg, pressure_idle)
    VALUES (?1, ?2, ?3, '1.0.0', 600, json_patch('{}', json_object('luma', json_object('v', ?4, 'p10', ?5), 'loud', json_object('v', 1, 'p10', ?6))),
      ?7, ?8, json_patch('{}', json_object('scanFrame', json_object('ms50', ?9), 'ocrMpx', json_object('ms50', ?10))), ?11, ?12)`);
  // Eight devices, slower ones dropping more frames. Each has a viewing with the steps
  // timed and one without (the steps are sparse: it still counts for its device).
  for (let i = 1; i <= 8; i++) {
    const hot = i > 6 ? '{"nominal":50,"serious":30,"critical":20}' : '{"nominal":100}';
    add.run('d' + i, now, 'a' + i, 2, i, i * 10, i * 0.5, 20 * i, 3 * i, 100 / i, hot, '{"nominal":100}');
    add.run('d' + i, now, 'b' + i, null, null, null, i * 0.5, 20 * i, null, null, null, null);
  }
  // An older step version (left out), whose time would otherwise make d1 the slowest; and
  // a device's speed is its median: one odd viewing does not move it to another tier.
  add.run('d1', now, 'old', 1, 99, null, 1, 1, null, null, null, null);
  add.run('d2', now, 'odd', 2, 50, 20, 1, 40, null, null, null, null);
  add.run('d2', now, 'even', 2, 2, 20, 1, 40, null, null, null, null);
  const dir = join(root, 'telemetry-worker', 'queries');
  const tiers = db.prepare(readFileSync(join(dir, 'device-tiers.sql'), 'utf8')).all();
  const row = (tier, metric) => tiers.find((r) => r.tier === tier && r.metric === metric);
  const t1 = row(1, 'dropped_pct');
  assert.deepEqual([t1.devices, t1.sessions, t1.luma_p10_from, t1.luma_p10_to], [2, 7, 1, 2]);
  assert.equal(row(1, 'device_loud_p10').median, 10);
  assert.equal(row(4, 'dropped_pct').median, 3.5);
  assert.equal(row(4, 'cpu_serious_pct_bg').median, 50);
  assert.equal(row(4, 'cpu_serious_pct_idle').median, 0);
  assert.equal(row(1, 'cpu_serious_pct_bg').median, 0);
  const rho = Object.fromEntries(db.prepare(readFileSync(join(dir, 'work-vs-steps.sql'), 'utf8')).all().map((r) => [r.pair, [r.devices, r.spearman]]));
  assert.deepEqual(rho['luma~scan_frame'], [8, 1], 'same order');
  assert.deepEqual(rho['luma~ocr_mpx'], [8, -1], 'opposite order');
  assert.deepEqual(rho['loud~luma'], [8, 1]);
});

// ---- registration and signed batches (player and Worker together) ----

// A lesson page whose requests go to the real Worker code over an in-memory D1.
// bits: the player's proof-of-work bits (fewer than its 18 keeps the test quick).
function pageWithWorker(env, setup, bits) {
  const src = bits ? script.replace(/const TELEMETRY_MINT_BITS = \d+;/, 'const TELEMETRY_MINT_BITS = ' + bits + ';') : script;
  assert.ok(!bits || src.includes('const TELEMETRY_MINT_BITS = ' + bits + ';'));
  const pg = page(null, setup, src);
  pg.w.fetch = async (url, opts) => {
    if (!String(url).startsWith(WORKER)) throw new Error('offline in tests');
    const body = JSON.parse(opts.body);
    pg.sent.push({ url: String(url), body, keepalive: opts.keepalive });
    if (pg.fail && pg.fail(String(url), body)) return new pg.w.Response('', { status: 503 });
    const req = new Request(String(url).replace(WORKER, 'https://telemetry.example'), { method: 'POST', body: opts.body, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' } });
    const r = await worker.fetch(req, env);
    return new pg.w.Response(await r.text(), { status: r.status });
  };
  return pg;
}
async function until(cond, ms = 20000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const fallbackEv = { k: 'fallback', v: '1.0.0', reason: 'user' };

test('telemetry: the player registers once with a proof of work done in slices, then signs its batches (auth 1)', async () => {
  const env = envOf({ MINT_BITS: '18', ENFORCE_MINT_POW: '1' });
  const pg = pageWithWorker(env, null, 18);
  const p = pg.player();
  await settle();
  const t = pg.dev().telemetry;
  const id = await t.identity();
  await t.send([fallbackEv]);
  assert.equal(env.DB.db.prepare('SELECT auth FROM fallbacks').get().auth, 0, 'unsigned before registering');
  t.register(0);
  await until(() => t.registered(id));
  const reg = pg.sent.find((x) => x.url.endsWith('/v1/register'));
  assert.equal(reg.body.secret, id.secret);
  assert.equal(reg.body.day, Math.floor(Date.now() / 86400000));
  assert.equal(env.DB.db.prepare('SELECT pow_ok FROM uid_keys WHERE uid = ?').get(id.uid).pow_ok, 1);
  assert.equal(pg.w.localStorage.getItem('lite-player-for-echo360:telemetryRegistered'), id.uid);
  assert.equal(pg.w.localStorage.getItem('lite-player-for-echo360:telemetryMint'), '', 'progress cleared');
  await t.send([fallbackEv]);
  const last = pg.sent[pg.sent.length - 1].body;
  assert.deepEqual(Object.keys(last).sort(), ['batch', 'body', 'sig', 'ts', 'uid']);
  assert.ok(!JSON.stringify(last).includes(id.secret), 'the secret is not in a batch');
  assert.deepEqual(env.DB.db.prepare('SELECT auth FROM fallbacks ORDER BY id').all().map((r) => r.auth), [0, 1]);
  // Only one registration.
  t.register(0);
  await settle();
  assert.equal(pg.sent.filter((x) => x.url.endsWith('/v1/register')).length, 1);
  p.destroy();
  await closeWindow(pg.w);
});

test('telemetry: a signed summary still goes out at once while the page closes', async () => {
  const signedSecret = 'C'.repeat(43);
  const env = envOf();
  const pg = pageWithWorker(env, (w) => {
    w.localStorage.setItem('lite-player-for-echo360:telemetrySecret', signedSecret);
    w.localStorage.setItem('lite-player-for-echo360:telemetryRegistered', createHash('sha256').update(signedSecret).digest('hex'));
  });
  const p = pg.player();
  await settle();
  p.usage.opened -= 60000;
  pg.w.dispatchEvent(new pg.w.Event('pagehide'));
  assert.equal(pg.sent.length, 1, 'sent synchronously in the pagehide handler');
  assert.equal(pg.sent[0].keepalive, true);
  assert.match(pg.sent[0].body.sig, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(pg.sent[0].body.body).events[0].k, 'session');
  p.destroy();
  await closeWindow(pg.w);
});

test('telemetry: refused until registered (ENFORCE_AUTH), the batch waits and is sent signed afterwards; a wrong clock is corrected', async () => {
  const env = envOf({ ENFORCE_AUTH: '1', MINT_BITS: '8' });
  const pg = pageWithWorker(env, null, 8);
  const p = pg.player();
  await settle();
  const t = pg.dev().telemetry;
  await t.send([fallbackEv]);
  await until(() => env.DB.db.prepare('SELECT count(*) AS n FROM fallbacks').get().n === 1);
  assert.equal(env.DB.db.prepare('SELECT auth FROM fallbacks').get().auth, 1);
  // This computer's clock 20 minutes off: refused once, signed again with the server's.
  t.clockMs = -1200000;
  await t.send([fallbackEv]);
  await until(() => env.DB.db.prepare('SELECT count(*) AS n FROM fallbacks').get().n === 2);
  assert.ok(Math.abs(t.clockMs) < 5000);
  p.destroy();
  await closeWindow(pg.w);
});

test('telemetry: proof-of-work progress is kept when registering fails, and used next time', async () => {
  const env = envOf({ MINT_BITS: '8', ENFORCE_MINT_POW: '1' });
  const pg = pageWithWorker(env, null, 8);
  pg.fail = (url) => url.endsWith('/v1/register');
  const p = pg.player();
  await settle();
  const t = pg.dev().telemetry;
  const id = await t.identity();
  t.register(0);
  await until(() => pg.sent.some((x) => x.url.endsWith('/v1/register')) && !t.minting);
  const saved = JSON.parse(pg.w.localStorage.getItem('lite-player-for-echo360:telemetryMint'));
  assert.equal(saved.uid, id.uid);
  assert.ok(saved.nonce >= 0 && saved.bits === 8, JSON.stringify(saved));
  const tries = pg.sent.filter((x) => x.url.endsWith('/v1/register'));
  assert.equal(tries.length, 1);
  pg.fail = null;
  t.register(0);
  await until(() => t.registered(id));
  const again = pg.sent.filter((x) => x.url.endsWith('/v1/register'));
  assert.equal(again[1].body.nonce, String(saved.nonce), 'the same proof, not worked out again');
  // Deleting one's data removes the registration here too (registered again later).
  await t.ask('/v1/me/delete');
  assert.equal(t.registered(id), false);
  assert.equal(env.DB.db.prepare('SELECT count(*) AS n FROM uid_keys').get().n, 0);
  p.destroy();
  await closeWindow(pg.w);
});

test('telemetry: when the server asks for more bits than the player\'s, the proof is worked out again with them', async () => {
  const env = envOf({ MINT_BITS: '12', ENFORCE_MINT_POW: '1' });
  const pg = pageWithWorker(env, null, 8);
  const p = pg.player();
  await settle();
  const t = pg.dev().telemetry;
  const id = await t.identity();
  t.register(0);
  await until(() => t.registered(id));
  const regs = pg.sent.filter((x) => x.url.endsWith('/v1/register'));
  // Refused at 8 bits (unless that proof happened to have 12), then accepted at 12.
  assert.ok(regs.length >= 1 && regs.length <= 2, String(regs.length));
  const bits = (r) => { const h = createHash('sha256').update('lp-mint-v1|' + id.uid + '|' + r.body.day + '|' + r.body.nonce).digest(); let n = 0; for (const b of h) { if (b) return n + Math.clz32(b) - 24; n += 8; } return n; };
  assert.ok(bits(regs[regs.length - 1]) >= 12);
  assert.equal(env.DB.db.prepare('SELECT pow_ok FROM uid_keys').get().pow_ok, 1);
  p.destroy();
  await closeWindow(pg.w);
});

test('telemetry: registering belongs to the viewing: nothing is left planned or running after the player goes, and the work so far is kept', async () => {
  // Destroyed before the id is worked out: nothing is planned afterwards.
  const quick = pageWithWorker(envOf());
  quick.player().destroy();
  await settle();
  assert.equal(quick.dev().telemetry.mintTimer, 0);
  await closeWindow(quick.w);
  // Destroyed during the proof of work (24 bits: long enough to be caught running).
  const env = envOf({ MINT_BITS: '24' });
  const pg = pageWithWorker(env, null, 24);
  const p = pg.player();
  await settle();
  const t = pg.dev().telemetry;
  const id = await t.identity();
  assert.ok(t.mintTimer, 'planned with the viewing');
  t.register(0);
  await until(() => t.minting);
  await new Promise((r) => setTimeout(r, 200));
  p.destroy();
  await until(() => !t.minting);
  const saved = JSON.parse(pg.w.localStorage.getItem('lite-player-for-echo360:telemetryMint'));
  assert.equal(saved.uid, id.uid);
  assert.ok(saved.from > 0, 'progress saved: ' + JSON.stringify(saved));
  assert.equal(pg.sent.filter((x) => x.url.endsWith('/v1/register')).length, 0);
  await closeWindow(pg.w);
});

test('telemetry: the proof-of-work bits agree in the player, the Worker\'s default and wrangler.toml', () => {
  const player = Number(/const TELEMETRY_MINT_BITS = (\d+);/.exec(script)[1]);
  const workerBits = Number(/MINT_BITS: (\d+)/.exec(readFileSync(join(root, 'telemetry-worker', 'src', 'index.js'), 'utf8'))[1]);
  const toml = Number(/^MINT_BITS = "(\d+)"/m.exec(readFileSync(join(root, 'telemetry-worker', 'wrangler.toml'), 'utf8'))[1]);
  assert.deepEqual([player, workerBits, toml], [21, 21, 21]);
});
