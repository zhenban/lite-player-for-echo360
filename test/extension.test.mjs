// The Chrome extension (build.mjs --target extension): its manifest and files, the libraries
// it ships, and how the player (page's world) and the bridge (extension's isolated world)
// meet and talk. Each world is simulated by its own VM context on one happy-dom window (the
// two share the DOM, as in Chrome). The real extension in Chrome: dev/extension-check.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { assemble, extensionFiles } from '../build.mjs';
import { newWindow } from './dom-guard.mjs';

const x = extensionFiles();
const src = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const HELLO = 'lite-player-for-echo360:hello';
const ACK = 'lite-player-for-echo360:ack';

test('manifest: the userscript\'s pages, the usage-data server, storage, nothing else', () => {
  const m = x.manifest;
  assert.equal(m.manifest_version, 3);
  assert.match(m.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(m.version_name, /^\d+\.\d+ beta \d+$/);
  assert.ok(m.description.length <= 132, 'the store allows 132 characters');
  const matches = [...src('meta.txt').matchAll(/^\/\/ @match\s+(\S+)$/gm)].map((r) => r[1]);
  assert.deepEqual(m.permissions, ['storage']);
  assert.deepEqual(m.host_permissions, [/const TELEMETRY_URL = '([^']+)'/.exec(src('87-telemetry.js'))[1] + '/*']);
  // In frames too: a learning system may show Echo360 in a frame (as the userscript does).
  assert.deepEqual(m.content_scripts.map((c) => [c.js[0], c.world, c.run_at, c.matches, c.all_frames]),
    [['bridge.js', 'ISOLATED', 'document_start', matches, true], ['player.js', 'MAIN', 'document_start', matches, true]]);
  const hosts = JSON.parse(/const SITE_HOSTS = (\[[^\]]*\]);/.exec(src('03-common.js'))[1].replace(/'/g, '"'));
  assert.deepEqual(m.web_accessible_resources, [{ resources: ['lib/*'], matches: hosts.map((h) => 'https://' + h + '/*') }]);
  for (const f of [m.background.service_worker, ...m.content_scripts.flatMap((c) => c.js)]) assert.ok(x.files[f], f);
  for (const f of Object.values(m.icons)) assert.ok(x.icons.includes(f), f);
  for (const text of Object.values(x.files)) assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, 'a placeholder left');
});

test('player.js: the same player with the extension\'s platform; the userscript without it', () => {
  assert.doesNotMatch(x.files['player.js'], /==UserScript==/);
  assert.match(x.files['player.js'], /const extBridge = /);
  assert.match(x.files['player.js'], /const DEV_HOOKS = false;/);
  new vm.Script(x.files['player.js']);
  const us = assemble().out;
  assert.match(us, /^\/\/ ==UserScript==/);
  assert.doesNotMatch(us, /extBridge/);
});

test('libraries: every pinned code file is shipped (no code from elsewhere); language data only English', () => {
  const pinned = Object.keys(Object.fromEntries([...src('04-libs.js').matchAll(/^\s+'([^']+)': '([0-9a-f]{64})',$/gm)].map((r) => [r[1], r[2]])));
  const code = pinned.filter((p) => !p.endsWith('.traineddata.gz'));
  assert.ok(code.length >= 7);
  for (const p of code) assert.ok(x.libs[p], 'not shipped: ' + p);
  assert.deepEqual(Object.keys(x.libs).filter((p) => p.endsWith('.traineddata.gz')).map((p) => p.split('/')[1]), ['eng@1.0.0']);
});

// ---- the two worlds ----
function fakeChrome() {
  const store = { 'private:telemetrySecret': 's'.repeat(43), 'someone else': 'x' };
  const sent = [];
  const chrome = {
    runtime: { id: 'ext', getURL: (p) => 'chrome-extension://ext/' + p, sendMessage: async (m) => { sent.push(m); return { status: 200, text: '{"ok":true}' }; } },
    storage: { local: { get: async () => Object.assign({}, store), set: async (o) => { Object.assign(store, o); } } },
  };
  return { chrome, store, sent };
}
function world(w, extra) {
  return vm.createContext(Object.assign({ window: w, document: w.document, CustomEvent: w.CustomEvent, MouseEvent: w.MouseEvent, setTimeout, clearTimeout, JSON, Promise, Object, Map }, extra));
}
const runBridge = (w, chrome) => vm.runInContext(x.files['bridge.js'], world(w, { chrome }));
function runPlayer(w) {
  const platform = { name: 'userscript' };
  const ctx = world(w, { platform, VERSION: '9.9.9' });
  vm.runInContext(src('06-platform-extension.js'), ctx);
  return platform;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
// Objects made in another VM context have that context's prototypes: compared as plain values.
const plain = (v) => JSON.parse(JSON.stringify(v));

for (const order of ['bridge first', 'player first']) {
  test('the player and the bridge meet (' + order + '): private values, posts, the package\'s URL', async () => {
    const w = newWindow();
    const { chrome, store, sent } = fakeChrome();
    let platform;
    if (order === 'bridge first') { runBridge(w, chrome); platform = runPlayer(w); } else { platform = runPlayer(w); runBridge(w, chrome); }
    assert.equal(platform.name, 'extension');
    assert.equal(platform.manager(), 'extension 9.9.9');
    // The package's URL is known at once (libraries may be needed before any await).
    assert.equal(platform.libUrl('hls.js@1.7.3/dist/hls.min.js'), 'chrome-extension://ext/lib/hls.js@1.7.3/dist/hls.min.js');
    assert.equal(platform.libUrl('@tesseract.js-data/eng@1.0.0/4.0.0_best_int'), 'chrome-extension://ext/lib/@tesseract.js-data/eng@1.0.0/4.0.0_best_int');
    assert.equal(platform.libUrl('@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz'), 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz');
    // Private values: read at start-up, only the player's own.
    assert.equal(platform.privateKv.get('telemetrySecret'), null, 'not read yet');
    await platform.privateReady;
    assert.equal(platform.privateKv.get('telemetrySecret'), 's'.repeat(43));
    assert.equal(platform.privateKv.get('someone else'), null);
    platform.privateKv.set('telemetryRegistered', 'u1');
    await tick();
    assert.equal(store['private:telemetryRegistered'], 'u1');
    assert.equal(platform.privateKv.get('telemetryRegistered'), 'u1');
    const r = await platform.post('https://server.test/v1/events', '{"a":1}', 1000);
    assert.deepEqual(plain(r), { status: 200, text: '{"ok":true}' });
    assert.deepEqual(plain(sent), [{ type: 'post', url: 'https://server.test/v1/events', body: '{"a":1}', timeoutMs: 1000 }]);
  });
}

test('after they met, a page script posing as either side is not heard', async () => {
  const w = newWindow();
  const { chrome } = fakeChrome();
  runBridge(w, chrome);
  runPlayer(w);
  const fake = w.document.createElement('span');
  let acked = 0;
  fake.addEventListener(ACK, () => acked++);
  w.dispatchEvent(new w.MouseEvent(HELLO, { relatedTarget: fake }));
  assert.equal(acked, 0);
});

test('without the bridge: nothing is sent, private values wait', async () => {
  const w = newWindow();
  const platform = runPlayer(w);
  assert.deepEqual(plain(await platform.post('https://server.test/v1/events', '{}', 1000)), { status: 0, text: '' });
  let ready = false;
  platform.privateReady.then(() => { ready = true; });
  await tick();
  assert.equal(ready, false);
  assert.equal(platform.libUrl('hls.js@1.7.3/dist/hls.min.js'), 'https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js');
});

test('service worker: posts only to the usage-data server, without cookies', async () => {
  let listener = null;
  const fetched = [];
  const ctx = vm.createContext({
    chrome: { runtime: { id: 'ext', onMessage: { addListener: (fn) => { listener = fn; } } } },
    fetch: async (url, init) => { fetched.push({ url, init }); return { status: 200, text: async () => 'ok' }; },
    AbortSignal: { timeout: () => undefined }, Math,
  });
  vm.runInContext(x.files['background.js'], ctx);
  const server = /const TELEMETRY_URL = '([^']+)'/.exec(src('87-telemetry.js'))[1];
  const ask = (msg, sender = { id: 'ext' }) => new Promise((resolve) => { if (!listener(msg, sender, resolve)) resolve('refused'); });
  assert.equal(await ask({ type: 'post', url: 'https://elsewhere.test/v1/events', body: '{}' }), 'refused');
  assert.equal(await ask({ type: 'post', url: server + '.elsewhere.test/x', body: '{}' }), 'refused');
  assert.equal(await ask({ type: 'post', url: server + '/v1/events', body: '{}' }, { id: 'other' }), 'refused');
  assert.equal(fetched.length, 0);
  assert.deepEqual(plain(await ask({ type: 'post', url: server + '/v1/events', body: '{"e":1}', timeoutMs: 5000 })), { status: 200, text: 'ok' });
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].init.credentials, 'omit');
  assert.equal(fetched[0].init.body, '{"e":1}');
});
