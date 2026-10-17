// The public usage chart: its statements are read-only and count what the dashboard counts,
// it shows totals only, and the token is sent to Cloudflare's API and nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAYS, STATEMENTS, fetchUsage, range, renderSvg, toUsage } from '../chart/usage-chart.mjs';
import { NOW, makeDb } from './helpers.mjs';

// Runs a statement the way the D1 HTTP API does: parameters as strings.
function run(db, stmt, values) {
  return db.raw.prepare(stmt.sql).all(...stmt.params.map((p) => String(values[p])));
}
function usageFrom(db, now = NOW) {
  const w = range(now);
  return toUsage(run(db, STATEMENTS.daily, w), run(db, STATEMENTS.totals, w)[0], now);
}
const ids = (db) => db.raw.prepare('SELECT uid AS id FROM env UNION SELECT uid FROM sessions UNION SELECT sid FROM sessions').all().map((r) => r.id);

test('the chart statements run on a read-only database and count distinct users', () => {
  const db = makeDb('busy');
  const u = usageFrom(db);
  assert.equal(u.days.length, DAYS);
  assert.equal(u.days.at(-1).day, new Date(NOW).toISOString().slice(0, 10));
  const w = range(NOW);
  const expect = (from) => db.raw.prepare('SELECT COUNT(DISTINCT uid) AS n FROM (SELECT uid, at FROM sessions UNION ALL SELECT uid, at FROM env) WHERE at >= ? AND at < ?').get(from, w.to).n;
  assert.equal(u.month, expect(w.month));
  assert.equal(u.ever, db.raw.prepare('SELECT COUNT(DISTINCT uid) AS n FROM (SELECT uid FROM sessions UNION SELECT uid FROM env)').get().n);
  assert.ok(u.month > 20 && u.days.some((d) => d.users > 0));
  // Each day counts each user once: never more than the users ever seen.
  for (const d of u.days) assert.ok(d.users <= u.ever);
});

test('the SVGs carry totals only, and handle no data', () => {
  const db = makeDb('busy');
  const u = usageFrom(db);
  for (const theme of ['light', 'dark']) {
    const svg = renderSvg(u, theme);
    assert.match(svg, /^<svg [^>]*role="img"/);
    assert.match(svg, new RegExp(u.month + ' users'));
    for (const id of ids(db)) assert.ok(!svg.includes(id), 'no uid or sid in the chart');
    assert.ok(!/NaN|undefined|Infinity/.test(svg));
  }
  const empty = usageFrom(makeDb('empty'));
  const svg = renderSvg(empty, 'light');
  assert.match(svg, /0 users/);
  assert.ok(!/NaN|undefined|Infinity/.test(svg));
  assert.ok(!svg.includes(' since '), 'no "since" date without data');
  const solo = renderSvg(usageFrom(makeDb('solo')), 'dark');
  assert.match(solo, />1 user</);
});

test('the token goes only to the D1 query endpoint, with the fixed statements', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const sql = JSON.parse(init.body).sql;
    const results = sql === STATEMENTS.daily.sql ? [{ day: '2026-10-16', users: 3 }] : [{ month: 4, ever: 9, first_at: NOW - 40 * 86400000 }];
    return new Response(JSON.stringify({ success: true, result: [{ results }] }), { status: 200 });
  };
  try {
    const u = await fetchUsage({ account: 'acc', db: 'dbid', token: 'tok-123', now: NOW });
    assert.equal(u.month, 4);
    assert.equal(u.days.find((d) => d.day === '2026-10-16').users, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 2);
  const sent = new Set([STATEMENTS.daily.sql, STATEMENTS.totals.sql]);
  for (const c of calls) {
    assert.equal(c.url, 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database/dbid/query');
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers.authorization, 'Bearer tok-123');
    const body = JSON.parse(c.init.body);
    assert.ok(sent.has(body.sql));
    assert.ok(body.params.every((p) => /^\d+$/.test(p)), 'only the time bounds as parameters');
  }
});

test('a failed query reports the API error without the token', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
  try {
    await assert.rejects(fetchUsage({ account: 'acc', db: 'dbid', token: 'tok-secret', now: NOW }), (e) => {
      assert.match(e.message, /10000 Authentication error/);
      assert.ok(!e.message.includes('tok-secret'));
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
