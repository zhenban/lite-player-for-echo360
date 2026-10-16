// The dashboard cannot change the data: no method but GET/HEAD gets past the router, the
// filters take only fixed values (never SQL), and every statement it can run is a single
// SELECT that works on a read-only database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { handle } from '../src/index.js';
import { QUERIES, compile, run } from '../src/queries.js';
import { NOW, makeDb, makeEnv, makeKeys, req } from './helpers.mjs';

const k = await makeKeys();
const deps = { keys: k.keys, now: () => NOW };

function counts(db) {
  const out = {};
  for (const t of ['env', 'sessions', 'errors', 'fallbacks']) out[t] = db.raw.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
  return out;
}

test('the test database really refuses writes (so the next tests mean something)', () => {
  const db = makeDb('busy');
  assert.throws(() => db.raw.exec("DELETE FROM sessions"), /readonly|read-only/i);
  assert.throws(() => db.raw.exec("INSERT INTO errors (uid, at, version, feature) VALUES ('x', 1, '1.0.0', 'x')"), /readonly|read-only/i);
});

test('every statement in the list runs on a read-only database, for every filter combination', async () => {
  const db = makeDb('busy');
  const before = counts(db);
  for (const version of [null, '0.23.0', '9.9.9']) {
    for (const exclude of ['[]', JSON.stringify(['a'.repeat(63) + '1'])]) {
      const values = { from: NOW - 30 * 86400000, to: NOW, prev: NOW - 60 * 86400000, since: NOW - 90 * 86400000, version, exclude, tz: 600 };
      const out = await run(db, Object.keys(QUERIES), values);
      for (const name of Object.keys(QUERIES)) assert.ok(Array.isArray(out[name]), name);
    }
  }
  assert.deepEqual(counts(db), before);
});

test('every statement is a single SELECT with only bound parameters', () => {
  for (const q of Object.values(QUERIES)) {
    assert.match(q.sql, /^(WITH|SELECT)\b/, q.name);
    assert.ok(!q.sql.includes(';'), q.name);
    assert.ok(!/\$[a-z]/.test(q.sql), q.name + ': every $name became a ?N');
    assert.ok(Object.isFrozen(q), q.name);
  }
  assert.ok(Object.isFrozen(QUERIES));
});

test('a statement that could write is refused when the module loads', () => {
  for (const bad of [
    'DELETE FROM sessions',
    'SELECT 1; DELETE FROM sessions',
    'WITH x AS (SELECT 1) INSERT INTO errors SELECT * FROM x',
    'SELECT * FROM sessions -- comment',
    'UPDATE env SET version = 1',
    'PRAGMA query_only = OFF',
    'ATTACH DATABASE x AS y',
    'SELECT load_extension(1)',
    'REPLACE INTO env VALUES (1)',
    'select 1 /* x */',
  ]) assert.throws(() => compile('bad', bad), /Refusing/, bad);
});

test('run() accepts only statements from the list', async () => {
  const db = makeDb('empty');
  const values = { from: 0, to: 1, prev: 0, since: 0, version: null, exclude: '[]', tz: 0 };
  await assert.rejects(run(db, ['SELECT 1'], values), /Unknown statement/);
  await assert.rejects(run(db, ['toString'], values), /Unknown statement/);
  await assert.rejects(run(db, ['constructor'], values), /Unknown statement/);
});

test('signed in, every method other than GET and HEAD is refused before any query', async () => {
  const db = makeDb('busy');
  const env = makeEnv(db);
  const before = counts(db);
  const t = await k.token();
  for (const path of ['/', '/api/summary', '/api/summary?range=7', '/app.js', '/anything']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const body = ['POST', 'PUT', 'PATCH'].includes(method) ? JSON.stringify({ sql: 'DELETE FROM sessions' }) : undefined;
      const res = await handle(req(path, { method, token: t, body, headers: { 'content-type': 'application/json' } }), env, {}, deps);
      assert.equal(res.status, 405, method + ' ' + path);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
    }
  }
  assert.equal(db.executed.length, 0);
  assert.deepEqual(counts(db), before);
});

test('filters accept only fixed values: SQL or unknown keys in the query string are refused', async () => {
  const db = makeDb('busy');
  const env = makeEnv(db);
  const t = await k.token();
  for (const qs of [
    'range=30;DROP TABLE sessions', "range=30'", 'range=31', 'range=1e1',
    'version=0.23.0%27%20OR%201%3D1', 'version=0.23', 'version=x',
    'devices=mine', 'devices=all&devices=others', 'tz=10000', 'tz=1.5', 'tz=%2B60',
    'sql=SELECT%201', 'query=DELETE%20FROM%20sessions', 'uid=' + 'a'.repeat(64), 'table=env',
  ]) {
    const res = await handle(req('/api/summary?' + qs, { token: t }), env, {}, deps);
    assert.equal(res.status, 400, qs);
  }
  assert.equal(db.executed.length, 0);
  // Pages take no query string at all.
  assert.equal((await handle(req('/?x=1', { token: t }), env, {}, deps)).status, 404);
});

test('the Worker source has no other way to reach the database', () => {
  const dir = new URL('../src/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'assets.gen.js')) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    // Only queries.js prepares statements; only index.js names the binding, to hand it to summary().
    if (f !== 'queries.js') assert.ok(!/\.(prepare|batch|dump)\(/.test(src), f + ' uses the database directly');
    const uses = src.match(/\bDB\b/g) || [];
    if (f === 'index.js') assert.equal((src.match(/env\.DB\b/g) || []).length, uses.length, f);
    else assert.equal(uses.length, 0, f + ' names the database binding');
  }
});
