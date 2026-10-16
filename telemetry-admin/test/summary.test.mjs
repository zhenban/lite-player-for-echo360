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
    for (const qs of ['range=7', 'range=90', 'range=90&devices=others', 'range=30&version=0.22.0']) {
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

test('HEAD answers without a body', async () => {
  const db = makeDb('busy');
  const res = await handle(req('/api/summary', { method: 'HEAD', token }), makeEnv(db), {}, deps);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});
