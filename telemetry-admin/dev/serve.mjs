// Local preview with made-up data (dev/seed.mjs), on 127.0.0.1 only. It plays the part of
// Cloudflare Access: it makes its own key pair and signs a token for every request, so the
// Worker's real access check runs unchanged (the Worker has no bypass of any kind).
//   node dev/serve.mjs [empty|solo|busy] [port]
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { handle } from '../src/index.js';
import { OWNER_UID, applySchema, seed } from './seed.mjs';

const scenario = process.argv[2] || 'busy';
const port = Number(process.argv[3] || 8790);
const TEAM = 'https://local-preview.cloudflareaccess.com';
const AUD = '0'.repeat(64);
const EMAIL = 'owner@example.com';

const raw = new DatabaseSync(':memory:');
applySchema(raw);
seed(raw, scenario, Date.now());
raw.exec('PRAGMA query_only = ON');
const db = {
  prepare: (sql) => ({ sql, args: [], bind(...args) { return { ...this, args }; } }),
  batch: async (list) => list.map((s) => ({ results: raw.prepare(s.sql).all(...s.args) })),
};

const { publicKey, privateKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'local', alg: 'RS256' }] });
const env = { DB: db, TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ALLOWED_EMAILS: EMAIL, OWNER_UIDS: OWNER_UID };

createServer(async (req, res) => {
  const token = await new SignJWT({ email: EMAIL }).setProtectedHeader({ alg: 'RS256', kid: 'local' })
    .setIssuer(TEAM).setAudience(AUD).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const headers = new Headers({ 'cf-access-jwt-assertion': token });
  const request = new Request('http://127.0.0.1:' + port + req.url, { method: req.method, headers });
  const response = await handle(request, env, {}, { keys });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log('Preview (' + scenario + ') on http://127.0.0.1:' + port));
