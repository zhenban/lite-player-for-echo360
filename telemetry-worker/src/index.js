// The telemetry Worker of Lite Player for Echo360. Four endpoints, all POST with a JSON
// body:
//   /v1/register   { uid, secret, day, nonce }        once per user (auth.js)
//   /v1/events     { uid, ts, batch, sig, body }      store usage data (schema.js says what
//                                                     is kept); body is the JSON text of
//                                                     { events: [...] }, signed (auth.js)
//                  { uid, events: [...] }             the same unsigned, from players before
//                                                     0.25.0 (stored with auth = 0)
//   /v1/me         { uid, secret }                    everything stored for this user
//   /v1/me/delete  { uid, secret }                    delete everything stored for this user
// uid is SHA-256 of the user's secret (hex); reading and deleting need the secret itself, so
// knowing a uid is not enough. The secret is only hashed, never stored or logged.
//
// Against false data (README.md, "Abuse"): a proof of work per new user, rate limits by
// address and by user, a daily quota of rows per user, a daily budget of rows written in
// all (D1's free plan allows 100,000), and flags on implausible values (plausibility.js).
// What is enforced is set by the variables in wrangler.toml; flags are only noted.
//
// Nothing here logs: no console output, observability off (wrangler.toml). The address of
// the sender is used only as the key of the rate limits (Cloudflare's counters, kept for a
// minute) and never written; country, region and network operator (from Cloudflare's
// request.cf) are stored with each row.
import { cleanEvent, isSecret, isUid, TABLES } from './schema.js';
import { CLOCK_SKEW_MS, deriveKv, epochDay, mintBits, signatureOk } from './auth.js';
import { flagsOf } from './plausibility.js';

export const LIMITS = {
  bodyBytes: 24576,        // one request (a signed batch carries its events as escaped JSON text)
  events: 25,              // events in one request
  rowsPerTable: 5000,      // rows returned per table by /v1/me (newest)
};
// Rows one user may add a day (UTC); more are dropped. The environment has one row a day
// anyway (env is replaced, not added); a viewing already stored today may be updated.
export const QUOTA = { session: 40, error: 50, fallback: 50 };
// Rows written in D1's count for one row of each kind: the row and each index it updates.
export const WEIGHT = { env: 5, session: 7, error: 4, fallback: 4 };
// A user registered at least this many days ago, sending signed batches, still stores its
// daily environment row when the budget is spent.
const ESTABLISHED_DAYS = 3;
const BATCH_KEEP_DAYS = 1;   // replayed batches are recognised this long
// Defaults of the variables in wrangler.toml.
const DEFAULTS = { MINT_BITS: 21, DAILY_WRITE_BUDGET: 60000 };
// Pages that may call this from a page script (the player uses GM_xmlhttpRequest, which
// needs no CORS; a development build without it uses fetch from the lecture page).
const ORIGINS = ['https://echo360.net.au'];

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch {
      // Nothing about the request or the error goes back or into a log.
      return reply(request, 500, { error: 'server' });
    }
  },
  // Daily (wrangler.toml [triggers]): forget old batch ids and budgets.
  async scheduled(controller, env) {
    const today = epochDay(controller.scheduledTime || Date.now());
    await env.DB.batch([
      env.DB.prepare('DELETE FROM batches WHERE day < ?').bind(today - BATCH_KEEP_DAYS),
      env.DB.prepare('DELETE FROM budget WHERE day < ?').bind(today - 30),
    ]);
  },
};

const on = (v) => v === '1' || v === 'true' || v === true || v === 1;
const setting = (env, name) => {
  const v = Number(env[name]);
  return Number.isFinite(v) && env[name] !== undefined && env[name] !== '' ? v : DEFAULTS[name];
};

export async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return reply(request, 204, null);
  if (request.method !== 'POST') return reply(request, 405, { error: 'method' });
  const route = { '/v1/events': events, '/v1/register': register, '/v1/me': me, '/v1/me/delete': forget }[url.pathname];
  if (!route) return reply(request, 404, { error: 'not found' });
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const limiter = { '/v1/events': env.EVENTS_LIMIT, '/v1/register': env.REG_LIMIT }[url.pathname] || env.ME_LIMIT;
  if (limiter && !(await limiter.limit({ key: ip })).success) return reply(request, 429, { error: 'rate' });
  const body = await readJson(request);
  if (body === undefined) return reply(request, 400, { error: 'body' });
  return route(request, env, body);
}

// The body as JSON, or undefined when it is too large, not JSON or not an object.
async function readJson(request) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > LIMITS.bodyBytes) return undefined;
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMITS.bodyBytes) { reader.cancel().catch(() => {}); return undefined; }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  try {
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function where(request) {
  const cf = request.cf || {};
  const short = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  return { country: short(cf.country, 2), region: short(cf.region, 80), asorg: short(cf.asOrganization, 120) };
}

async function events(request, env, body) {
  const now = Date.now();
  const today = epochDay(now);
  const uid = body.uid;
  if (!isUid(uid)) return reply(request, 400, { error: 'format' });
  const signed = typeof body.body === 'string';
  if (signed && (!Number.isSafeInteger(body.ts) || !/^[0-9a-f]{24}$/.test(body.batch) || !/^[0-9a-f]{64}$/.test(body.sig))) {
    return reply(request, 400, { error: 'format' });
  }
  if (!signed && on(env.ENFORCE_AUTH)) return reply(request, 401, { error: 'register', register: true, now });
  if (env.UID_LIMIT && !(await env.UID_LIMIT.limit({ key: 'uid:' + uid })).success) return reply(request, 429, { error: 'rate' });

  // One read: the user's key, today's budget, and what the user stored today.
  const dayStart = today * 86400000;
  const [keys, spent, todaySessions, todayCounts] = await env.DB.batch([
    env.DB.prepare('SELECT kv, created_day FROM uid_keys WHERE uid = ?').bind(uid),
    env.DB.prepare('SELECT n FROM budget WHERE day = ?').bind(today),
    env.DB.prepare('SELECT sid FROM sessions WHERE uid = ? AND at >= ?').bind(uid, dayStart),
    env.DB.prepare('SELECT (SELECT count(*) FROM errors WHERE uid = ?1 AND at >= ?2) AS error, (SELECT count(*) FROM fallbacks WHERE uid = ?1 AND at >= ?2) AS fallback').bind(uid, dayStart),
  ]);
  const key = keys.results[0];

  let list = body.events;
  let auth = 0;
  if (signed) {
    if (Math.abs(now - body.ts) > CLOCK_SKEW_MS) return reply(request, 401, { error: 'clock', now });
    if (!key) return reply(request, 401, { error: 'register', register: true, now });
    if (!(await signatureOk(key.kv, body.ts, body.batch, body.body, body.sig))) return reply(request, 401, { error: 'signature', now });
    try { list = JSON.parse(body.body).events; } catch { list = undefined; }
    auth = 1;
  }
  if (!Array.isArray(list) || !list.length || list.length > LIMITS.events) return reply(request, 400, { error: 'format' });

  // Clean, flag and count against the user's quota.
  const sids = new Set(todaySessions.results.map((r) => r.sid));
  const used = { error: todayCounts.results[0].error, fallback: todayCounts.results[0].fallback };
  const place = where(request);
  let rows = [];
  for (const ev of list) {
    const c = cleanEvent(ev);
    if (!c) continue;
    if (c.kind === 'session' && !sids.has(c.row.sid)) {
      if (sids.size >= QUOTA.session) continue;
      sids.add(c.row.sid);
    }
    if (c.kind === 'error' || c.kind === 'fallback') {
      if (used[c.kind] >= QUOTA[c.kind]) continue;
      used[c.kind]++;
    }
    const row = Object.assign({ uid, at: now }, c.row, place, { auth, flags: flagsOf(c.kind, ev, c.row) });
    if (c.kind === 'env') row.day = new Date(now).toISOString().slice(0, 10);
    rows.push({ kind: c.kind, row });
  }

  // The day's budget. Spent: only established users' environment rows go on.
  const cost = (list2) => list2.reduce((n, r) => n + WEIGHT[r.kind], 0) + (signed ? 1 : 0) + 1;
  const budget = setting(env, 'DAILY_WRITE_BUDGET');
  const before = spent.results[0] ? spent.results[0].n : 0;
  if (rows.length && before + cost(rows) > budget) {
    const established = auth && key.created_day <= today - ESTABLISHED_DAYS;
    if (!established) return reply(request, 503, { error: 'budget', now });
    rows = rows.filter((r) => r.kind === 'env');
  }
  if (!rows.length) return reply(request, 200, { stored: 0, now });

  const statements = [];
  // A signed batch is stored once: sent again, this insert fails and nothing is written.
  if (signed) statements.push(env.DB.prepare('INSERT INTO batches (uid, batch, day) VALUES (?, ?, ?)').bind(uid, body.batch, today));
  for (const { kind, row } of rows) {
    const cols = Object.keys(row);
    const table = TABLES[kind];
    // One environment row per user and day, one row per viewing (sent again as it goes on).
    const unique = kind === 'env' ? ['uid', 'day'] : kind === 'session' ? ['uid', 'sid'] : null;
    const upsert = unique ? ' ON CONFLICT(' + unique.join(', ') + ') DO UPDATE SET ' + cols.filter((x) => !unique.includes(x)).map((x) => x + ' = excluded.' + x).join(', ') : '';
    statements.push(env.DB.prepare('INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')' + upsert).bind(...cols.map((x) => row[x])));
  }
  statements.push(env.DB.prepare('INSERT INTO budget (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = n + excluded.n').bind(today, cost(rows)));
  try {
    await env.DB.batch(statements);
  } catch (e) {
    if (signed && /UNIQUE/.test(String(e && e.message)) && /batches/.test(String(e && e.message))) return reply(request, 200, { stored: 0, duplicate: true, now });
    throw e;
  }
  return reply(request, 200, { stored: rows.length, now });
}

// Once per user: keeps the signing key, after checking the secret and the proof of work.
async function register(request, env, body) {
  const uid = await proven(body);
  if (!uid) return reply(request, 403, { error: 'secret' });
  const now = Date.now();
  const today = epochDay(now);
  const bits = setting(env, 'MINT_BITS');
  const pow = Number.isInteger(body.day) && Math.abs(body.day - today) <= 1 && typeof body.nonce === 'string' && /^\d{1,16}$/.test(body.nonce)
    && (await mintBits(uid, body.day, body.nonce)) >= bits ? 1 : 0;
  if (!pow && on(env.ENFORCE_MINT_POW)) return reply(request, 403, { error: 'pow', bits, now });
  const kv = await deriveKv(body.secret);
  // Registering again keeps the first day; a later proof of work is kept.
  await env.DB.batch([env.DB.prepare('INSERT INTO uid_keys (uid, kv, created_day, pow_ok) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET pow_ok = max(pow_ok, excluded.pow_ok)').bind(uid, kv, today, pow)]);
  return reply(request, 200, { registered: true, pow: pow === 1, bits, now });
}

// The uid the secret proves, or null.
async function proven(body) {
  if (!isUid(body.uid) || !isSecret(body.secret)) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.secret)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  // Compared without stopping at the first difference.
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= hex.charCodeAt(i) ^ body.uid.charCodeAt(i);
  return diff === 0 ? hex : null;
}

async function me(request, env, body) {
  const uid = await proven(body);
  if (!uid) return reply(request, 403, { error: 'secret' });
  const out = {};
  const kinds = Object.keys(TABLES);
  const results = await env.DB.batch([
    ...kinds.map((k) => env.DB.prepare('SELECT * FROM ' + TABLES[k] + ' WHERE uid = ? ORDER BY at DESC LIMIT ?').bind(uid, LIMITS.rowsPerTable)),
    // The signing key is left out: it is derived from the secret, which the user has.
    env.DB.prepare('SELECT created_day, status, pow_ok FROM uid_keys WHERE uid = ?').bind(uid),
  ]);
  // Without the row number and the uid (the user knows it; nothing else needs it).
  kinds.forEach((k, i) => {
    out[k] = results[i].results.map((r) => {
      const rest = Object.assign({}, r);
      delete rest.id;
      delete rest.uid;
      return rest;
    });
  });
  out.registration = results[kinds.length].results;
  return reply(request, 200, out);
}

async function forget(request, env, body) {
  const uid = await proven(body);
  if (!uid) return reply(request, 403, { error: 'secret' });
  const kinds = Object.keys(TABLES);
  const results = await env.DB.batch([
    ...kinds.map((k) => env.DB.prepare('DELETE FROM ' + TABLES[k] + ' WHERE uid = ?').bind(uid)),
    env.DB.prepare('DELETE FROM uid_keys WHERE uid = ?').bind(uid),
    env.DB.prepare('DELETE FROM batches WHERE uid = ?').bind(uid),
  ]);
  const deleted = {};
  kinds.forEach((k, i) => { deleted[k] = results[i].meta.changes; });
  deleted.registration = results[kinds.length].meta.changes;
  return reply(request, 200, { deleted });
}

function reply(request, status, data) {
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  const origin = request.headers.get('origin');
  if (origin && ORIGINS.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-methods'] = 'POST';
    headers['access-control-allow-headers'] = 'content-type';
    headers['access-control-max-age'] = '86400';
    headers.vary = 'origin';
  }
  if (data == null) return new Response(null, { status, headers });
  headers['content-type'] = 'application/json; charset=utf-8';
  return new Response(JSON.stringify(data), { status, headers });
}
