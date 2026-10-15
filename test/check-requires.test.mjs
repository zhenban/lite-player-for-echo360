// The hash check tells a download that failed (network) from a file that changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkFile, checkAll, pinnedFiles } from './check-requires.mjs';

const body = Buffer.from('library');
const hex = createHash('sha256').update(body).digest('hex');
const file = { url: 'https://cdn.example/lib.js', want: hex, enc: 'hex' };
const answer = (status, buf = body) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => buf });
const noSleep = async () => {};
const quiet = { log() {}, error() {} };

test('check-requires: a download that fails is retried, then reported as a network problem', async () => {
  let calls = 0;
  const failing = async () => { calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
  const r = await checkFile(file, failing, noSleep, 3);
  assert.equal(calls, 3);
  assert.ok(r.network && /ECONNRESET/.test(r.network) && !r.mismatch);
  // A server error, then the file: passes.
  let n = 0;
  const flaky = async () => (++n === 1 ? answer(503) : answer(200));
  assert.deepEqual(await checkFile(file, flaky, noSleep, 3), { ok: true });
  // Only network problems: exit code 2, not 1.
  const lines = [];
  const code = await checkAll([{ url: 'https://cdn.example/x.js', want: 'AA==', enc: 'base64' }, file], failing, noSleep, { log() {}, error: (s) => lines.push(s) });
  assert.equal(code, 2);
  assert.ok(lines.some((s) => /NETWORK PROBLEM/.test(s)) && !lines.some((s) => /HASH CHECK FAILED/.test(s)));
});

test('check-requires: a changed or missing file fails the check without retrying', async () => {
  let calls = 0;
  const changed = async () => { calls++; return answer(200, Buffer.from('other')); };
  const r = await checkFile(file, changed, noSleep, 3);
  assert.equal(calls, 1);
  assert.ok(r.mismatch && !r.network);
  assert.ok((await checkFile(file, async () => answer(404), noSleep, 3)).mismatch);
  assert.equal(await checkAll([{ url: 'https://cdn.example/x.js', want: createHash('sha256').update(body).digest('base64'), enc: 'base64' }, file], changed, noSleep, quiet), 1);
  // The files are read from both places, and a @require without a hash is an error.
  const files = pinnedFiles('// @require      https://a/b.js#sha256-AA==\n// @require      https://a/c.js\n', "  'x@1/y.js': '" + hex + "',\n");
  assert.equal(files.length, 3);
  assert.ok(files[1].error);
  assert.equal(files[2].url, 'https://cdn.jsdelivr.net/npm/x@1/y.js');
});
