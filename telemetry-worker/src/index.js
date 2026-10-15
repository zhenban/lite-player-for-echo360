// The telemetry Worker of Lite Player for Echo360. Three endpoints, all POST with a JSON
// body:
//   /v1/events     { uid, events: [...] }   store usage data (schema.js says what is kept)
//   /v1/me         { uid, secret }          everything stored for this user
//   /v1/me/delete  { uid, secret }          delete everything stored for this user
// uid is SHA-256 of the user's secret (hex); reading and deleting need the secret itself, so
// knowing a uid is not enough. The secret is only hashed, never stored or logged.
//
// Nothing here logs: no console output, observability off (wrangler.toml). The address of
// the sender is used only as the key of the rate limits (Cloudflare's counters, kept for a
// minute) and never written; country, region and network operator (from Cloudflare's
// request.cf) are stored with each row.
import { cleanEvent, isSecret, isUid, TABLES } from './schema.js';

export const LIMITS = {
  bodyBytes: 16384,        // one request
  events: 25,              // events in one request
  rowsPerTable: 5000,      // rows returned per table by /v1/me (newest)
};
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
};

export async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return reply(request, 204, null);
  if (request.method !== 'POST') return reply(request, 405, { error: 'method' });
  const route = { '/v1/events': events, '/v1/me': me, '/v1/me/delete': forget }[url.pathname];
  if (!route) return reply(request, 404, { error: 'not found' });
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const limiter = url.pathname === '/v1/events' ? env.EVENTS_LIMIT : env.ME_LIMIT;
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
  if (!isUid(body.uid) || !Array.isArray(body.events) || !body.events.length || body.events.length > LIMITS.events) {
    return reply(request, 400, { error: 'format' });
  }
  const place = where(request);
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const statements = [];
  for (const ev of body.events) {
    const c = cleanEvent(ev);
    if (!c) continue;
    const row = Object.assign({ uid: body.uid, at: now }, c.row, place);
    if (c.kind === 'env') row.day = day;
    const cols = Object.keys(row);
    const table = TABLES[c.kind];
    // One environment row per user and day, one row per viewing (sent again as it goes on).
    const key = c.kind === 'env' ? ['uid', 'day'] : c.kind === 'session' ? ['uid', 'sid'] : null;
    const upsert = key ? ' ON CONFLICT(' + key.join(', ') + ') DO UPDATE SET ' + cols.filter((x) => !key.includes(x)).map((x) => x + ' = excluded.' + x).join(', ') : '';
    statements.push(env.DB.prepare('INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')' + upsert).bind(...cols.map((x) => row[x])));
  }
  if (statements.length) await env.DB.batch(statements);
  return reply(request, 200, { stored: statements.length });
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
  const results = await env.DB.batch(kinds.map((k) => env.DB.prepare('SELECT * FROM ' + TABLES[k] + ' WHERE uid = ? ORDER BY at DESC LIMIT ?').bind(uid, LIMITS.rowsPerTable)));
  // Without the row number and the uid (the user knows it; nothing else needs it).
  kinds.forEach((k, i) => {
    out[k] = results[i].results.map((r) => {
      const rest = Object.assign({}, r);
      delete rest.id;
      delete rest.uid;
      return rest;
    });
  });
  return reply(request, 200, out);
}

async function forget(request, env, body) {
  const uid = await proven(body);
  if (!uid) return reply(request, 403, { error: 'secret' });
  const kinds = Object.keys(TABLES);
  const results = await env.DB.batch(kinds.map((k) => env.DB.prepare('DELETE FROM ' + TABLES[k] + ' WHERE uid = ?').bind(uid)));
  const deleted = {};
  kinds.forEach((k, i) => { deleted[k] = results[i].meta.changes; });
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
