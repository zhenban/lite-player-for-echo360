// The telemetry Worker against false data: registration, signed batches, replays, the clock,
// the proof of work, quotas, the daily budget, deleting, and the plausibility flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import worker, { QUOTA, WEIGHT } from '../telemetry-worker/src/index.js';
import { flagsOf, FLAGS } from '../telemetry-worker/src/plausibility.js';
import { cleanEvent } from '../telemetry-worker/src/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = join(root, 'telemetry-worker', 'migrations');
const migration = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(migrationDir, f), 'utf8')).join('\n');

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
const limiter = (allow = () => true) => ({ calls: [], async limit(o) { this.calls.push(o.key); return { success: allow(o.key) }; } });
const envOf = (over) => Object.assign({ DB: fakeD1(), EVENTS_LIMIT: limiter(), ME_LIMIT: limiter(), REG_LIMIT: limiter(), UID_LIMIT: limiter() }, over);

function post(path, body) {
  const req = new Request('https://telemetry.example' + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' } });
  Object.defineProperty(req, 'cf', { value: { country: 'AU' } });
  return req;
}
async function call(env, path, body) {
  const r = await worker.fetch(post(path, body), env);
  return { status: r.status, data: await r.json() };
}

// A user as the player makes one.
function user() {
  const secret = randomBytes(32).toString('base64url');
  const uid = createHash('sha256').update(secret).digest('hex');
  const kv = createHmac('sha256', secret).update('lp-ingest-v1').digest();
  return { secret, uid, kv };
}
const today = () => Math.floor(Date.now() / 86400000);
const zeroBits = (buf) => { let n = 0; for (const b of buf) { if (b) return n + Math.clz32(b) - 24; n += 8; } return n; };
function mint(uid, day, bits) {
  for (let n = 0; ; n++) {
    if (zeroBits(createHash('sha256').update('lp-mint-v1|' + uid + '|' + day + '|' + n).digest()) >= bits) return String(n);
  }
}
function signed(u, events, { ts = Date.now(), batch = randomBytes(12).toString('hex'), kv = u.kv } = {}) {
  const body = JSON.stringify({ events });
  const sig = createHmac('sha256', kv).update(ts + '.' + batch + '.' + createHash('sha256').update(body).digest('hex')).digest('hex');
  return { uid: u.uid, ts, batch, sig, body };
}
const fallback = (reason = 'user') => ({ k: 'fallback', v: '1.0.0', reason });
const session = (sid, extra) => Object.assign({ k: 'session', v: '1.0.0', sid }, extra);
const sid = (i) => i.toString(16).padStart(16, '0');
const count = (env, table, where = '') => env.DB.db.prepare('SELECT count(*) AS n FROM ' + table + ' ' + where).get().n;

async function registered(env, u, bits = 4) {
  const day = today();
  const r = await call(env, '/v1/register', { uid: u.uid, secret: u.secret, day, nonce: mint(u.uid, day, bits) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r;
}

test('anti-abuse: players before 0.25.0 still store (auth 0) until ENFORCE_AUTH', async () => {
  const env = envOf();
  const u = user();
  const r = await call(env, '/v1/events', { uid: u.uid, events: [fallback()] });
  assert.equal(r.status, 200);
  assert.equal(r.data.stored, 1);
  assert.equal(env.DB.db.prepare('SELECT auth FROM fallbacks').get().auth, 0);
  const strict = envOf({ ENFORCE_AUTH: '1' });
  const refused = await call(strict, '/v1/events', { uid: u.uid, events: [fallback()] });
  assert.equal(refused.status, 401);
  assert.equal(refused.data.register, true);
  assert.equal(count(strict, 'fallbacks'), 0);
});

test('anti-abuse: a registered player signs its batches and they are stored with auth 1; the secret is never kept', async () => {
  const env = envOf({ MINT_BITS: '4' });
  const u = user();
  const reg = await registered(env, u);
  assert.equal(reg.data.pow, true);
  assert.ok(Math.abs(reg.data.now - Date.now()) < 5000);
  const key = env.DB.db.prepare('SELECT * FROM uid_keys').get();
  assert.equal(Buffer.from(key.kv).toString('hex'), u.kv.toString('hex'));
  assert.equal(key.created_day, today());
  assert.equal(key.pow_ok, 1);
  const dump = JSON.stringify(env.DB.db.prepare('SELECT * FROM uid_keys').all(), (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64url') : v));
  assert.ok(!dump.includes(u.secret), 'secret not stored');
  const r = await call(env, '/v1/events', signed(u, [fallback(), session(sid(1), { playSec: 10, openSec: 20 })]));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.stored, 2);
  assert.equal(env.DB.db.prepare('SELECT auth FROM fallbacks').get().auth, 1);
  assert.equal(env.DB.db.prepare('SELECT auth FROM sessions').get().auth, 1);
  // Registering again keeps the first day and the proof; the wrong secret is refused.
  env.DB.db.exec('UPDATE uid_keys SET created_day = created_day - 9');
  await call(env, '/v1/register', { uid: u.uid, secret: u.secret, day: today(), nonce: 'x' });
  assert.deepEqual({ ...env.DB.db.prepare('SELECT created_day, pow_ok FROM uid_keys').get() }, { created_day: today() - 9, pow_ok: 1 });
  assert.equal((await call(env, '/v1/register', { uid: u.uid, secret: user().secret, day: today(), nonce: '1' })).status, 403);
  // Registering has its own limit by address.
  const blocked = envOf({ REG_LIMIT: limiter(() => false) });
  assert.equal((await call(blocked, '/v1/register', { uid: u.uid, secret: u.secret })).status, 429);
});

test('anti-abuse: the player\'s own HMAC and SHA-256 (src/84-sha256.js) produce signatures the Worker accepts', async () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'src', '84-sha256.js'), 'utf8') + '\n;globalThis.m = { sha256Sync, hmacSha256Sync, bytesHex, mintSearch };', ctx);
  const { sha256Sync, hmacSha256Sync, bytesHex, mintSearch } = ctx.m;
  const env = envOf({ MINT_BITS: '8', ENFORCE_MINT_POW: '1' });
  const u = user();
  const enc = (s) => new Uint8Array(Buffer.from(s));
  const day = today();
  const nonce = mintSearch('lp-mint-v1|' + u.uid + '|' + day + '|', 8, 0, 1 << 20);
  assert.equal((await call(env, '/v1/register', { uid: u.uid, secret: u.secret, day, nonce: String(nonce) })).status, 200);
  const kv = hmacSha256Sync(enc(u.secret), enc('lp-ingest-v1'));
  const body = JSON.stringify({ events: [fallback()] });
  const ts = Date.now(), batch = 'ab'.repeat(12);
  const sig = bytesHex(hmacSha256Sync(kv, enc(ts + '.' + batch + '.' + bytesHex(sha256Sync(enc(body))))));
  const r = await call(env, '/v1/events', { uid: u.uid, ts, batch, sig, body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.stored, 1);
});

test('anti-abuse: a forged or altered batch, an unknown user and a wrong clock are refused', async () => {
  const env = envOf({ MINT_BITS: '4' });
  const u = user();
  await registered(env, u);
  // Signed with another key.
  let r = await call(env, '/v1/events', signed(u, [fallback()], { kv: user().kv }));
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'signature');
  // Body changed after signing.
  const s = signed(u, [fallback()]);
  r = await call(env, '/v1/events', Object.assign({}, s, { body: JSON.stringify({ events: [fallback(), fallback()] }) }));
  assert.equal(r.status, 401);
  // Not registered.
  r = await call(env, '/v1/events', signed(user(), [fallback()]));
  assert.equal(r.status, 401);
  assert.equal(r.data.register, true);
  // More than ten minutes off: refused with the Worker's time, so the player can correct.
  for (const off of [-601000, 601000]) {
    r = await call(env, '/v1/events', signed(u, [fallback()], { ts: Date.now() + off }));
    assert.equal(r.status, 401);
    assert.equal(r.data.error, 'clock');
    assert.ok(Math.abs(r.data.now - Date.now()) < 5000);
  }
  assert.equal((await call(env, '/v1/events', signed(u, [fallback()], { ts: Date.now() - 590000 }))).status, 200);
  // Malformed signed forms.
  for (const bad of [{ ts: 'x' }, { batch: 'short' }, { sig: 'z'.repeat(64) }]) {
    assert.equal((await call(env, '/v1/events', Object.assign(signed(u, [fallback()]), bad))).status, 400);
  }
  assert.equal(count(env, 'fallbacks'), 1);
});

test('anti-abuse: a batch sent twice is stored once', async () => {
  const env = envOf({ MINT_BITS: '4' });
  const u = user();
  await registered(env, u);
  const s = signed(u, [fallback(), { k: 'error', v: '1.0.0', feature: 'zoom', type: 'TypeError', msg: 'x', n: 1 }]);
  assert.equal((await call(env, '/v1/events', s)).data.stored, 2);
  const again = await call(env, '/v1/events', s);
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal(count(env, 'fallbacks'), 1);
  assert.equal(count(env, 'errors'), 1);
  // The daily cron forgets old batch ids (not today's).
  env.DB.db.exec('INSERT INTO batches (uid, batch, day) VALUES (\'old\', \'b\', ' + (today() - 5) + ')');
  await worker.scheduled({ scheduledTime: Date.now() }, env);
  assert.deepEqual(env.DB.db.prepare('SELECT uid FROM batches').all().map((x) => x.uid), [u.uid]);
});

test('anti-abuse: the proof of work, when enforced, is checked with one hash; day within one of today', async () => {
  const env = envOf({ MINT_BITS: '10', ENFORCE_MINT_POW: '1' });
  const u = user();
  const day = today();
  let bad = 0;
  while (zeroBits(createHash('sha256').update('lp-mint-v1|' + u.uid + '|' + day + '|' + bad).digest()) >= 10) bad++;
  let r = await call(env, '/v1/register', { uid: u.uid, secret: u.secret, day, nonce: String(bad) });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'pow');
  assert.equal(r.data.bits, 10);
  for (const d of [day - 2, day + 2]) {
    r = await call(env, '/v1/register', { uid: u.uid, secret: u.secret, day: d, nonce: mint(u.uid, d, 10) });
    assert.equal(r.status, 403, 'day ' + (d - day));
  }
  assert.equal(count(env, 'uid_keys'), 0);
  r = await call(env, '/v1/register', { uid: u.uid, secret: u.secret, day: day - 1, nonce: mint(u.uid, day - 1, 10) });
  assert.equal(r.status, 200);
  assert.equal(r.data.pow, true);
  // Not enforced: registered without a proof, noted as such.
  const loose = envOf({ MINT_BITS: '10' });
  r = await call(loose, '/v1/register', { uid: u.uid, secret: u.secret });
  assert.equal(r.status, 200);
  assert.equal(r.data.pow, false);
  assert.equal(loose.DB.db.prepare('SELECT pow_ok FROM uid_keys').get().pow_ok, 0);
});

test('anti-abuse: daily quotas per user; a viewing already stored today may be updated; per-user rate limit', async () => {
  const env = envOf({ MINT_BITS: '4' });
  const u = user();
  await registered(env, u);
  for (let i = 0; i < 3; i++) await call(env, '/v1/events', signed(u, Array.from({ length: 20 }, () => fallback())));
  assert.equal(count(env, 'fallbacks'), QUOTA.fallback);
  for (let i = 0; i < 3; i++) await call(env, '/v1/events', signed(u, Array.from({ length: 20 }, (_, j) => session(sid(i * 20 + j), { playSec: 1 }))));
  assert.equal(count(env, 'sessions'), QUOTA.session);
  await call(env, '/v1/events', signed(u, [session(sid(0), { playSec: 99 }), session(sid(999), { playSec: 1 })]));
  assert.equal(env.DB.db.prepare('SELECT play_sec FROM sessions WHERE sid = ?').get(sid(0)).play_sec, 99);
  assert.equal(count(env, 'sessions'), QUOTA.session);
  // Another user has their own quota.
  await call(env, '/v1/events', { uid: user().uid, events: [fallback()] });
  assert.equal(count(env, 'fallbacks'), QUOTA.fallback + 1);
  // The per-user limit is keyed by the uid.
  const limited = envOf({ UID_LIMIT: limiter(() => false) });
  assert.equal((await call(limited, '/v1/events', { uid: u.uid, events: [fallback()] })).status, 429);
  assert.deepEqual(limited.UID_LIMIT.calls, ['uid:' + u.uid]);
});

test('anti-abuse: the daily budget stops new and unsigned writers, established users keep their environment row, deleting still works', async () => {
  const env = envOf({ MINT_BITS: '4', DAILY_WRITE_BUDGET: '30' });
  const old = user(), fresh = user();
  await registered(env, old);
  await registered(env, fresh);
  env.DB.db.prepare('UPDATE uid_keys SET created_day = ? WHERE uid = ?').run(today() - 3, old.uid);
  const envEv = { k: 'env', v: '1.0.0', cores: 4 };
  // Within budget: 2 fallbacks (4 each) + env (5) + batch id + budget row = 15.
  let r = await call(env, '/v1/events', signed(old, [fallback(), fallback(), envEv]));
  assert.equal(r.data.stored, 3);
  assert.equal(env.DB.db.prepare('SELECT n FROM budget').get().n, 2 * WEIGHT.fallback + WEIGHT.env + 2);
  // 15 + 4 sessions (28) + 2 > 30: over.
  const big = [session(sid(1)), session(sid(2)), session(sid(3)), session(sid(4)), envEv];
  r = await call(env, '/v1/events', signed(fresh, big));
  assert.equal(r.status, 503);
  r = await call(env, '/v1/events', { uid: old.uid, events: big });
  assert.equal(r.status, 503, 'unsigned');
  r = await call(env, '/v1/events', signed(old, big));
  assert.equal(r.status, 200);
  assert.equal(r.data.stored, 1, 'only the environment row');
  assert.equal(count(env, 'sessions'), 0);
  // Deleting is never refused for the budget, and removes the registration and batch ids.
  r = await call(env, '/v1/me/delete', { uid: old.uid, secret: old.secret });
  assert.equal(r.status, 200);
  assert.equal(r.data.deleted.registration, 1);
  assert.equal(count(env, 'uid_keys', "WHERE uid = '" + old.uid + "'"), 0);
  assert.equal(count(env, 'batches', "WHERE uid = '" + old.uid + "'"), 0);
  assert.equal(count(env, 'env'), 0);
  // "View my data" shows the registration, without the key.
  const mine = await call(env, '/v1/me', { uid: fresh.uid, secret: fresh.secret });
  assert.deepEqual(mine.data.registration.map((x) => Object.keys(x).sort()), [['created_day', 'pow_ok', 'status']]);
});

test('anti-abuse: the budget weights are one write for the row and one per index of its table', () => {
  const db = fakeD1().db;
  for (const [kind, table] of Object.entries({ env: 'env', session: 'sessions', error: 'errors', fallback: 'fallbacks' })) {
    assert.equal(WEIGHT[kind], 1 + db.prepare('SELECT count(*) AS n FROM pragma_index_list(?)').get(table).n, kind);
  }
});

test('anti-abuse: plausibility flags, one bit per rule; a real summary sets none', () => {
  const flags = (ev) => { const c = cleanEvent(Object.assign({ k: 'session', v: '1.0.0', sid: sid(1) }, ev)); return flagsOf('session', c ? Object.assign({ k: 'session' }, ev) : ev, c.row); };
  // A summary as the player sends it (0.24.0, a lecture watched for 40 minutes).
  const real = { playSec: 2400, openSec: 2600, firstFrameMs: 1548, scanMs: 6700, silenceMs: 30000, chaptersPerHour: 14.5, slideSrc: 'frames',
    streamMbPerHour: 560, seekMs50: 110, seekMs90: 190, syncMs50: 43, timerUs: 100, watchedPct: 92, bwKbps: 4100, scanFrameMs50: 11, lumaP10: 5.5 };
  assert.equal(flags(real), 0);
  const cases = [
    [{ playSec: 3000, openSec: 2600 }, FLAGS.playOverOpen],
    [{ playSec: 7, openSec: 5, scanMs: undefined, silenceMs: undefined }, 0],   // rounding of short times
    [{ scanMs: 3000000 }, FLAGS.workOverOpen],
    [{ silenceMs: 3000000 }, FLAGS.workOverOpen],
    [{ firstFrameMs: 130000 }, FLAGS.slowFirstFrame],
    [{ slideSrc: 'none' }, FLAGS.chaptersNoSlides],
    [{ streamMbPerHour: 5 }, FLAGS.streamRate],
    [{ streamMbPerHour: 9000 }, FLAGS.streamRate],
    [{ seekMs50: 112.37 }, FLAGS.precision],
    [{ lumaP10: 5.512 }, FLAGS.precision],
  ];
  for (const [change, bit] of cases) assert.equal(flags(Object.assign({}, real, change)), bit, JSON.stringify(change));
  assert.equal(flags(Object.assign({}, real, { playSec: 3000, streamMbPerHour: 5 })), FLAGS.playOverOpen | FLAGS.streamRate);
  assert.equal(new Set(Object.values(FLAGS)).size, Object.keys(FLAGS).length, 'distinct bits');
  // Other kinds are not judged.
  assert.equal(flagsOf('env', {}, {}), 0);
});

test('anti-abuse: flags are stored with the row', async () => {
  const env = envOf();
  const u = user();
  await call(env, '/v1/events', { uid: u.uid, events: [session(sid(5), { playSec: 900, openSec: 10 })] });
  assert.equal(env.DB.db.prepare('SELECT flags FROM sessions').get().flags, FLAGS.playOverOpen);
});
