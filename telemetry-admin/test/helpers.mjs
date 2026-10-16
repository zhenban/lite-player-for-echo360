// Test helpers: a D1 stand-in over node:sqlite (with the telemetry Worker's real schema,
// switched to read-only after seeding, so any write fails), a stand-in for Access's keys,
// and signed tokens.
import { DatabaseSync } from 'node:sqlite';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { applySchema, seed } from '../dev/seed.mjs';

export const TEAM = 'https://example-team.cloudflareaccess.com';
export const AUD = 'f'.repeat(64);
export const OWNER = 'owner@example.com';
export const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);

// A D1-like object over SQLite. `writes` counts statements that changed anything.
export function makeDb(scenario = 'busy', now = NOW) {
  const raw = new DatabaseSync(':memory:');
  applySchema(raw);
  seed(raw, scenario, now);
  raw.exec('PRAGMA query_only = ON');
  const db = {
    raw,
    executed: [],
    prepare(sql) {
      return {
        sql, args: [],
        bind(...args) { return { ...this, args }; },
        async all() { db.executed.push(sql); return { results: raw.prepare(sql).all(...this.args) }; },
        async first() { db.executed.push(sql); return raw.prepare(sql).get(...this.args) ?? null; },
        async run() { db.executed.push(sql); return raw.prepare(sql).run(...this.args); },
      };
    },
    async batch(statements) {
      return statements.map((s) => { db.executed.push(s.sql); return { results: raw.prepare(s.sql).all(...s.args) }; });
    },
  };
  return db;
}

// Access's signing keys (one real key pair, one stranger's), and tokens signed with them.
export async function makeKeys() {
  const own = await generateKeyPair('RS256', { extractable: true });
  const stranger = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(own.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  async function token({ email = OWNER, aud = AUD, iss = TEAM, exp = '1h', key = own.privateKey, alg = 'RS256', kid = 'k1', iat } = {}) {
    let jwt = new SignJWT(email === null ? {} : { email }).setProtectedHeader({ alg, kid });
    jwt = iat === undefined ? jwt.setIssuedAt() : jwt.setIssuedAt(iat);
    if (iss) jwt = jwt.setIssuer(iss);
    if (aud) jwt = jwt.setAudience(aud);
    if (exp) jwt = jwt.setExpirationTime(exp);
    return jwt.sign(key);
  }
  return { keys, token, stranger };
}

export function makeEnv(db, extra = {}) {
  return { DB: db, TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ALLOWED_EMAILS: OWNER, OWNER_UIDS: 'a'.repeat(63) + '1', ...extra };
}

export function req(path, { method = 'GET', token, cookie, headers = {}, body } = {}) {
  const h = new Headers(headers);
  if (token) h.set('cf-access-jwt-assertion', token);
  if (cookie) h.set('cookie', cookie);
  return new Request('https://lite-player-dashboard.example.workers.dev' + path, { method, headers: h, body });
}
