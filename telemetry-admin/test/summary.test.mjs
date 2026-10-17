// What the data endpoint returns: totals only (no uid anywhere), sensible empty and small
// cases, the owner's devices left out on request, and an Echo360 change visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.js';
import { OWNER_UID } from '../dev/seed.mjs';
import { NOW, makeDb, makeEnv, makeKeys, req } from './helpers.mjs';

const k = await makeKeys();
const deps = { keys: k.keys, now: () => NOW };
const token = await k.token();

async function get(scenario, qs = '', extraEnv = {}) {
  const db = makeDb(scenario);
  const res = await handle(req('/api/summary' + (qs ? '?' + qs : ''), { token }), makeEnv(db, extraEnv), {}, deps);
  assert.equal(res.status, 200);
  const text = await res.text();
  const ids = db.raw.prepare('SELECT uid AS id FROM env UNION SELECT uid FROM sessions UNION SELECT sid FROM sessions UNION SELECT uid FROM errors UNION SELECT uid FROM fallbacks').all().map((r) => r.id);
  return { text, data: JSON.parse(text), ids };
}

test('no uid or other per-user id appears in any response', async () => {
  for (const scenario of ['solo', 'busy']) {
    for (const qs of ['range=7', 'range=90', 'range=90&devices=others', 'range=30&version=0.22.0', 'range=30&data=verified']) {
      const { text, ids } = await get(scenario, qs);
      assert.ok(ids.length > 0);
      assert.ok(!/[0-9a-f]{64}/.test(text), scenario + ' ' + qs + ': a 64-hex id leaked');
      for (const id of ids) assert.ok(!text.includes(id), scenario + ' ' + qs + ': ' + id + ' leaked');
      assert.ok(!/"uid"|"sid"/.test(text), scenario + ' ' + qs);
      assert.ok(!text.includes(OWNER_UID));
    }
  }
});

test('with no data everything is zero and judged "none", over every day of the range', async () => {
  const { data } = await get('empty', 'range=7&tz=600');
  assert.equal(data.overview.users, 0);
  assert.equal(data.overview.sessions, 0);
  assert.equal(data.days.length, 7);
  assert.ok(data.days.every((d) => d.users === 0));
  for (const s of Object.values(data.status)) assert.equal(s.level, 'none');
  assert.equal(data.stability.problemPct, null);
  assert.equal(data.latestAt, null);
});

test('one user: counted, marked as a low sample; leaving out my devices leaves nothing', async () => {
  const { data } = await get('solo', 'range=7');
  assert.equal(data.overview.users, 1);
  assert.equal(data.overview.sessions, 4);
  assert.equal(data.status.users.low, true);
  assert.equal(data.canExclude, true);
  // The short viewing is a viewing but not part of performance.
  assert.equal(data.performance.metrics.dropped_pct.n, 3);
  const others = (await get('solo', 'range=7&devices=others')).data;
  assert.equal(others.overview.users, 0);
  assert.equal(others.filters.devices, 'others');
  // The first page code ever seen is not a change of Echo360's page code.
  assert.equal(data.status.compat.newFrontends, 0);
  assert.ok(data.compat.frontends.every((f) => !f.replaced));
  // Without OWNER_UIDS there is nothing to leave out.
  assert.equal((await get('solo', 'range=7', { OWNER_UIDS: undefined })).data.canExclude, false);
});

test('busy: totals agree, versions compare, and the Echo360 change shows', async () => {
  const { data } = await get('busy', 'range=30&tz=600');
  assert.equal(data.days.length, 30);
  assert.equal(data.days.reduce((a, d) => a + d.sessions, 0), data.overview.sessions);
  assert.ok(data.overview.users > 20);
  assert.ok(data.versions.length >= 2);
  assert.deepEqual(data.versionList.map((v) => v.version), ['0.23.0', '0.22.0', '0.21.0']);
  assert.ok(Object.keys(data.performance.byVersion).length >= 2);
  assert.ok(data.compat.frontends.length >= 2, 'both Echo360 page versions in 30 days');
  const fresh = data.compat.frontends[0];
  assert.ok(fresh.involuntary > 0, 'the new page code came with fallbacks');
  assert.equal(fresh.replaced, true);
  assert.equal(data.compat.frontends[1].replaced, false);
  assert.ok(data.compat.reasons.some((x) => x.reason === 'noBootstrap'));
  assert.equal(data.devices.dims.browser.reduce((a, x) => a + x.users, 0), data.devices.users);
  // Each dimension is split by its values (a GROUP BY on json_each's own column once merged them).
  for (const dim of ['browser', 'os', 'manager', 'region']) assert.ok(data.devices.dims[dim].length > 1, dim);
  assert.equal(data.devices.dims.os.reduce((a, x) => a + x.users, 0), data.devices.users);
  // A version filter narrows everything to it.
  const v = (await get('busy', 'range=30&version=0.23.0')).data;
  assert.ok(v.overview.sessions < data.overview.sessions);
  assert.deepEqual(v.versions.map((x) => x.version), ['0.23.0']);
});

test('slide sources and why the keyframe scan stopped, from the viewings that report them', async () => {
  const STOPS = ['noWebCodecs', 'noFrame', 'decoder', 'playlist', 'network', 'other'];
  const { data } = await get('busy', 'range=30');
  const f = data.features;
  const total = f.slideSources.reduce((a, x) => a + x.sessions, 0);
  assert.ok(total > 0 && total < data.overview.sessions, 'only viewings from 0.23.0 report it');
  assert.ok(f.slideSources.find((x) => x.source === 'frames').sessions > total / 2);
  assert.ok(f.slideStops.length > 0);
  for (const x of f.slideStops) assert.ok(STOPS.includes(x.reason), x.reason);
  // A scan that stopped early leaves the preview pictures (seeded so), never keyframes.
  const thumbs = f.slideSources.find((x) => x.source === 'thumbs').sessions;
  assert.equal(f.slideStops.reduce((a, x) => a + x.sessions, 0), thumbs);
  // With the version filter: every 0.23.0 viewing reports it; 0.21.0 never did.
  const v23 = (await get('busy', 'range=30&version=0.23.0')).data;
  assert.equal(v23.features.slideSources.reduce((a, x) => a + x.sessions, 0), v23.overview.sessions);
  const v21 = (await get('busy', 'range=90&version=0.21.0')).data;
  assert.deepEqual([v21.features.slideSources, v21.features.slideStops], [[], []]);
  const empty = (await get('empty')).data;
  assert.deepEqual([empty.features.slideSources, empty.features.slideStops], [[], []]);
  // WebCodecs is one of the device dimensions, split into available or not.
  assert.equal(data.devices.dims.webcodecs.reduce((a, x) => a + x.users, 0), data.devices.users);
  for (const x of data.devices.dims.webcodecs) assert.ok(['yes', 'no'].includes(x.value));
});

test('video form of the keyframe scan: totals, and per system and browser version', async () => {
  const db = makeDb('busy');
  const res = await handle(req('/api/summary?range=30', { token }), makeEnv(db), {}, deps);
  const f = (await res.json()).features;
  const total = (form) => f.slideForms.find((x) => x.form === form);
  assert.ok(total('avcc').sessions > total('annexb').sessions && total('annexb').sessions > 0);
  // Each viewing counted once, though every device has many reports to match against.
  const sum = (form) => f.slideFormsBySystem.reduce((a, x) => a + x[form], 0);
  for (const form of ['avcc', 'annexb', 'neither']) assert.equal(sum(form), total(form)?.sessions ?? 0, form);
  // Conversion was needed only on iOS 17 (as seeded), and those rows come first.
  for (const x of f.slideFormsBySystem.filter((r) => r.annexb > 0)) assert.deepEqual([x.os, x.osV], ['iOS', 17]);
  assert.ok(f.slideFormsBySystem[0].annexb + f.slideFormsBySystem[0].neither > 0);
  assert.ok(f.slideFormsBySystem.some((x) => x.os === 'Windows' && x.osV === 11 && x.browser === 'Chrome'));
  const empty = (await get('empty')).data.features;
  assert.deepEqual([empty.slideForms, empty.slideFormsBySystem], [[], []]);
});

test('HEAD answers without a body', async () => {
  const db = makeDb('busy');
  const res = await handle(req('/api/summary', { method: 'HEAD', token }), makeEnv(db), {}, deps);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('verified data only: rows that are unsigned, flagged or from a user without a proof of work are left out', async () => {
  const all = await get('busy', 'range=7');
  const { data } = await get('busy', 'range=7&data=verified');
  assert.equal(data.filters.data, 'verified');
  assert.equal(all.data.filters.data, 'all');
  const db = makeDb('busy');
  const from = data.filters.from;
  const to = data.filters.to;
  const ok = 't.auth = 1 AND t.flags = 0 AND t.uid IN (SELECT uid FROM uid_keys WHERE pow_ok = 1)';
  const users = (where) => db.raw.prepare(`SELECT COUNT(DISTINCT uid) AS n FROM (SELECT uid, at, auth, flags FROM sessions UNION ALL SELECT uid, at, auth, flags FROM env) t
    WHERE t.at >= ? AND t.at < ? AND ${where}`).get(from, to).n;
  const verified = users(ok);
  // The seed's made-up uids, unregistered and powless devices make a difference.
  assert.ok(verified > 0 && verified < all.data.overview.users);
  assert.equal(all.data.overview.users, users('1'));
  assert.equal(all.data.overview.verifiedUsers, verified);
  assert.equal(data.overview.users, verified);
  assert.equal(data.overview.verifiedUsers, verified);
  const views = db.raw.prepare(`SELECT COUNT(*) AS n FROM sessions t WHERE t.at >= ? AND t.at < ? AND ${ok}`).get(from, to).n;
  assert.equal(data.overview.sessions, views);
  assert.ok(data.overview.sessions < all.data.overview.sessions);
  // Every other part counts only those rows too: never more than with all data.
  assert.ok(data.devices.users <= all.data.devices.users);
  assert.ok(data.stability.sessions === views);
  // With only verified rows in the data (solo: the owner, registered, every row signed and
  // none flagged except by chance), the figure is the same either way.
  const solo = (await get('solo', 'range=7')).data.overview;
  assert.equal(solo.verifiedUsers, solo.users);
});
