// Nobody but the allowed, signed-in owner gets anything: not the page, not the data, not even
// a 404 that would tell which paths exist. And a missing or broken configuration closes
// the dashboard instead of opening it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { handle } from '../src/index.js';
import { AUD, OWNER, TEAM, makeDb, makeEnv, makeKeys, req } from './helpers.mjs';

const PATHS = ['/', '/app.js', '/app.css', '/instrument-sans.woff2', '/api/summary', '/api/summary?range=7', '/nope', '/.env', '/wrangler.toml'];
const k = await makeKeys();
const db = makeDb('busy');
const env = makeEnv(db);
const deps = { keys: k.keys };

async function status(request, e = env, ctx = {}) {
  return (await handle(request, e, ctx, deps)).status;
}

test('without a token every path and method is refused, and the database is not touched', async () => {
  db.executed.length = 0;
  for (const p of PATHS) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
      const res = await handle(req(p, { method, body: method === 'POST' || method === 'PUT' ? '{}' : undefined }), env, {}, deps);
      assert.equal(res.status, 403, method + ' ' + p);
      const body = await res.text();
      assert.ok(!body.includes('<html') && !body.includes('{'), 'no content leaks: ' + p);
    }
  }
  assert.equal(db.executed.length, 0);
});

test('the owner with a valid token gets the page and the data', async () => {
  const t = await k.token();
  const page = await handle(req('/', { token: t }), env, {}, deps);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  const data = await handle(req('/api/summary?range=30', { token: t }), env, {}, deps);
  assert.equal(data.status, 200);
  assert.equal(typeof (await data.json()).overview.users, 'number');
  // The CF_Authorization cookie is checked the same way as the header.
  assert.equal(await status(req('/', { cookie: 'a=b; CF_Authorization=' + t })), 200);
  // Email comparison ignores case (Google addresses are case-insensitive).
  assert.equal(await status(req('/', { token: await k.token({ email: OWNER.toUpperCase() }) })), 200);
});

test('tokens that are not exactly right are refused', async () => {
  const bad = {
    'signed by another key': await k.token({ key: k.stranger.privateKey }),
    'another application (aud)': await k.token({ aud: 'e'.repeat(64) }),
    'another team (iss)': await k.token({ iss: 'https://other-team.cloudflareaccess.com' }),
    'no issuer': await k.token({ iss: null }),
    'no audience': await k.token({ aud: null }),
    'expired': await k.token({ exp: Math.floor(Date.now() / 1000) - 60, iat: Math.floor(Date.now() / 1000) - 3600 }),
    'no expiry': await k.token({ exp: null }),
    'someone else': await k.token({ email: 'someone@example.com' }),
    'owner as a suffix': await k.token({ email: 'x' + OWNER }),
    'no email (service token)': await k.token({ email: null }),
    'unknown key id': await k.token({ kid: 'other' }),
    'HS256 with a shared secret': await new SignJWT({ email: OWNER }).setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(TEAM).setAudience(AUD).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode('x'.repeat(32))),
    'alg none': [
      Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url'),
      Buffer.from(JSON.stringify({ email: OWNER, iss: TEAM, aud: AUD, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
      '',
    ].join('.'),
    'garbage': 'not.a.token',
    'too long': 'a'.repeat(9000),
  };
  for (const [name, t] of Object.entries(bad)) {
    assert.equal(await status(req('/api/summary', { token: t })), 403, name);
    assert.equal(await status(req('/', { cookie: 'CF_Authorization=' + t })), 403, name + ' (cookie)');
  }
});

test('a token for another application reported by the runtime is refused', async () => {
  const t = await k.token();
  assert.equal(await status(req('/', { token: t }), env, { access: { aud: 'e'.repeat(64) } }), 403);
  assert.equal(await status(req('/', { token: t }), env, { access: { aud: AUD } }), 200);
});

test('the runtime saying "signed in" is not enough without a valid token', async () => {
  assert.equal(await status(req('/'), env, { access: { aud: AUD, getIdentity: async () => ({ email: OWNER }) } }), 403);
});

test('a missing or malformed configuration serves nothing (503), even with a valid token', async () => {
  const t = await k.token();
  const broken = {
    'no team domain': { TEAM_DOMAIN: undefined },
    'team domain over http': { TEAM_DOMAIN: 'http://example-team.cloudflareaccess.com' },
    'team domain elsewhere': { TEAM_DOMAIN: 'https://example-team.evil.com' },
    'team domain with a path': { TEAM_DOMAIN: TEAM + '/x' },
    'no aud': { POLICY_AUD: undefined },
    'short aud': { POLICY_AUD: 'abc' },
    'no emails': { ALLOWED_EMAILS: undefined },
    'empty emails': { ALLOWED_EMAILS: ' , ' },
    'a wildcard email': { ALLOWED_EMAILS: '*' },
    'a malformed email among good ones': { ALLOWED_EMAILS: OWNER + ', @example.com' },
  };
  for (const [name, change] of Object.entries(broken)) {
    const e = { ...env, ...change };
    for (const p of ['/', '/api/summary']) assert.equal(await status(req(p, { token: t }), e), 503, name + ' ' + p);
  }
});

test('responses are not cacheable, not frameable and not readable cross-origin', async () => {
  const t = await k.token();
  for (const p of ['/', '/app.js', '/api/summary']) {
    const res = await handle(req(p, { token: t, headers: { origin: 'https://evil.example' } }), env, {}, deps);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
  const denied = await handle(req('/api/summary', { headers: { origin: 'https://evil.example' } }), env, {}, deps);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.match(denied.headers.get('cache-control'), /no-store/);
});
