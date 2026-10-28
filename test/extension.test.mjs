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

test('manifest: the userscript\'s pages, the usage-data server, storage, one page at a time for Add lecture moment, nothing else', () => {
  const m = x.manifest;
  assert.equal(m.manifest_version, 3);
  // The player's version, plain: the store already has 1.0.0.1 ("1.0 beta 1"), lower than 1.0.1.
  assert.equal(m.version, readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim());
  assert.equal(m.version_name, undefined);
  // Name and summary from _locales (the store listing in each language), English by default.
  assert.equal(m.name, '__MSG_name__');
  assert.equal(m.description, '__MSG_description__');
  assert.equal(m.default_locale, 'en');
  const langs = Object.keys(x.files).filter((f) => f.startsWith('_locales/')).map((f) => f.split('/')[1]).sort();
  assert.deepEqual(langs, ['en', 'zh_CN']);
  for (const lang of langs) {
    const msgs = JSON.parse(x.files['_locales/' + lang + '/messages.json']);
    assert.ok(msgs.name.message.length <= 45, lang + ': the store allows 45 characters in a name');
    assert.ok(msgs.description.message.length <= 132, lang + ': the store allows 132 characters in a summary');
  }
  const matches = [...src('meta.txt').matchAll(/^\/\/ @match\s+(\S+)$/gm)].map((r) => r[1]);
  // activeTab + scripting: "Add lecture moment" writes to the one page the user is on, when
  // they ask (toolbar or shortcut); no access to any AI site, and no install warning.
  assert.deepEqual(m.permissions, ['storage', 'activeTab', 'scripting']);
  assert.deepEqual(Object.keys(m.commands), ['add-lecture-moment']);
  assert.equal(m.commands['add-lecture-moment'].suggested_key.default, 'Alt+Shift+L');
  assert.deepEqual(m.host_permissions, [/const TELEMETRY_URL = '([^']+)'/.exec(src('87-telemetry.js'))[1] + '/*']);
  // In frames too: a learning system may show Echo360 in a frame (as the userscript does).
  assert.deepEqual(m.content_scripts.map((c) => [c.js.join(' '), c.world, c.run_at, c.matches, c.all_frames]),
    [['shared.js bridge.js', 'ISOLATED', 'document_start', matches, true], ['player.js', 'MAIN', 'document_start', matches, true]]);
  // The toolbar button opens the popup; its files are in the package.
  assert.equal(m.action.default_popup, 'popup.html');
  for (const f of ['popup.html', 'popup.js', 'popup.css', 'shared.js']) assert.ok(x.files[f], f);
  // The settings page, and the data store's frame (only Echo360's sites may load it).
  assert.equal(m.options_ui.page, 'options.html');
  for (const page of ['popup.html', 'options.html', 'store.html']) {
    for (const ref of x.files[page].matchAll(/(?:src|href)="([^"#]+)"/g)) assert.ok(x.files[ref[1]] || x.icons.includes(ref[1]), page + ' refers to a missing file: ' + ref[1]);
  }
  assert.match(x.files['core.js'], /window\.LitePlayerCore = \{/);
  assert.doesNotMatch(x.files['core.js'], /---- 90-main\.js ----|---- 06-platform-extension\.js ----/, 'the options page starts no player');
  const hosts = JSON.parse(/const SITE_HOSTS = (\[[^\]]*\]);/.exec(src('03-common.js'))[1].replace(/'/g, '"'));
  assert.deepEqual(m.web_accessible_resources, [{ resources: ['lib/*', 'store.html'], matches: hosts.map((h) => 'https://' + h + '/*') }]);
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
function fakeChrome(syncStore = {}) {
  const store = { 'private:telemetrySecret': 's'.repeat(43), 'someone else': 'x' };
  const sent = [];
  const syncWrites = [];
  const on = { message: [], changed: [] };
  const chrome = {
    runtime: { id: 'ext', getURL: (p) => 'chrome-extension://ext/' + p, sendMessage: async (m) => { sent.push(m); return { status: 200, text: '{"ok":true}' }; },
      onMessage: { addListener: (fn) => on.message.push(fn) } },
    storage: {
      onChanged: { addListener: (fn) => on.changed.push(fn) },
      local: { get: async () => Object.assign({}, store), set: async (o) => { Object.assign(store, o); }, remove: async (k) => { delete store[k]; } },
      sync: { get: async (k) => (k in syncStore ? { [k]: syncStore[k] } : {}), set: async (o) => { syncWrites.push(o); Object.assign(syncStore, o); } },
    },
  };
  return { chrome, store, sent, syncStore, syncWrites, on };
}
function world(w, extra) {
  return vm.createContext(Object.assign({ window: w, document: w.document, CustomEvent: w.CustomEvent, MouseEvent: w.MouseEvent, setTimeout, clearTimeout, JSON, Promise, Object, Map }, extra));
}
const runBridge = (w, chrome) => vm.runInContext(x.files['shared.js'] + '\n' + x.files['bridge.js'], world(w, { chrome }));
// The page's storage (localStorage in the userscript's platform).
function pageKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); }, remove: (k) => { m.delete(k); }, names: () => [...m.keys()] };
}
function runPlayer(w, page = pageKv()) {
  const platform = { name: 'userscript', kv: page };
  const ctx = world(w, { platform, VERSION: '9.9.9', NS: 'lite-player-for-echo360:', EXT_KV_WAIT_MS: 50, Set, TAG: 'test', console });
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

const P = 'lite-player-for-echo360:prefs';

test('settings: kept by the extension, the synced ones win, this device\'s layout and sound stay', async () => {
  const w = newWindow();
  const { chrome, store } = fakeChrome({ prefs: JSON.stringify({ rate: 1.5, lang: 'zh', layout: 'pip' }) });
  store['kv:' + P] = JSON.stringify({ rate: 1, layout: 'single', volume: 0.4, captions: true });
  store['kv:lite-player-for-echo360:pos:L1'] = '{"t":12,"at":1}';
  runBridge(w, chrome);
  const page = pageKv({ [P]: JSON.stringify({ rate: 2 }), 'lite-player-for-echo360:debug': 'true' });
  const platform = runPlayer(w, page);
  await new Promise((r) => platform.whenKv(r));
  // rate and lang from sync; layout (a device setting) not taken from it; the rest this device's.
  assert.deepEqual(JSON.parse(platform.kv.get(P)), { rate: 1.5, layout: 'single', volume: 0.4, captions: true, lang: 'zh' });
  assert.equal(platform.kv.get('lite-player-for-echo360:pos:L1'), '{"t":12,"at":1}');
  // Development switches stay in the page's storage.
  assert.equal(platform.kv.get('lite-player-for-echo360:debug'), 'true');
  assert.deepEqual(plain(platform.kv.names()).sort(), ['lite-player-for-echo360:debug', 'lite-player-for-echo360:pos:L1', P].sort());
});

test('settings: from before 1.1.0 (only in the page\'s storage) read there until written', async () => {
  const w = newWindow();
  const { chrome, store, syncStore } = fakeChrome();
  runBridge(w, chrome);
  const page = pageKv({ [P]: JSON.stringify({ rate: 2, layout: 'pip' }), 'lite-player-for-echo360:pos:L2': '{"t":5,"at":2}' });
  const platform = runPlayer(w, page);
  await new Promise((r) => platform.whenKv(r));
  assert.equal(platform.kv.get(P), JSON.stringify({ rate: 2, layout: 'pip' }));
  assert.equal(platform.kv.get('lite-player-for-echo360:pos:L2'), '{"t":5,"at":2}');
  platform.kv.set(P, JSON.stringify({ rate: 1.25, layout: 'side', volume: 0.5 }));
  platform.kv.set('lite-player-for-echo360:pos:L2', '{"t":9,"at":3}');
  platform.kv.set('lite-player-for-echo360:reloadAt', 'null');
  await tick();
  assert.equal(store['kv:' + P], JSON.stringify({ rate: 1.25, layout: 'side', volume: 0.5 }));
  assert.equal(store['kv:lite-player-for-echo360:pos:L2'], '{"t":9,"at":3}');
  // Synced: the settings without this device's.
  assert.deepEqual(JSON.parse(syncStore.prefs), { rate: 1.25 });
  assert.equal(platform.kv.get(P), JSON.stringify({ rate: 1.25, layout: 'side', volume: 0.5 }));
  // The page's storage is no longer written for these (only for the rest).
  assert.equal(page.get(P), JSON.stringify({ rate: 2, layout: 'pip' }));
  assert.equal(page.get('lite-player-for-echo360:reloadAt'), 'null');
  assert.equal(store['kv:lite-player-for-echo360:reloadAt'], undefined);
});

test('settings: a removed position goes from the extension and from the page\'s storage', async () => {
  const w = newWindow();
  const { chrome, store } = fakeChrome();
  store['kv:lite-player-for-echo360:pos:L3'] = '{"t":1,"at":1}';
  runBridge(w, chrome);
  const page = pageKv({ 'lite-player-for-echo360:pos:L3': '{"t":2,"at":1}' });
  const platform = runPlayer(w, page);
  await new Promise((r) => platform.whenKv(r));
  platform.kv.remove('lite-player-for-echo360:pos:L3');
  await tick();
  assert.equal(store['kv:lite-player-for-echo360:pos:L3'], undefined);
  assert.equal(page.get('lite-player-for-echo360:pos:L3'), null);
  assert.equal(platform.kv.get('lite-player-for-echo360:pos:L3'), null);
});

// The toolbar asks the tab: each frame's bridge hears it; only one with a player answers.
const askTab = (on, name) => new Promise((resolve) => {
  let open = false;
  for (const fn of on.message) if (fn({ type: 'ask', name }, { id: 'ext' }, resolve)) open = true;
  if (!open) resolve('nobody');
});

test('toolbar: a page the player handles answers status and diagnostics; others stay silent', async () => {
  const w = newWindow();
  const { chrome, on } = fakeChrome();
  runBridge(w, chrome);
  const platform = runPlayer(w);
  await new Promise((r) => platform.whenKv(r));
  assert.equal(await askTab(on, 'status'), 'nobody', 'not a page the player handles');
  platform.toolbar({ status: () => ({ state: 'running' }), diagnostics: async () => 'diag text' });
  await tick();
  assert.deepEqual(plain(await askTab(on, 'status')), { state: 'running' });
  assert.equal(await askTab(on, 'diagnostics'), 'diag text');
  assert.equal(await askTab(on, 'cookies'), 'nobody', 'only known questions');
  // Another extension's message is not answered.
  let answered = false;
  for (const fn of on.message) answered = fn({ type: 'ask', name: 'status' }, { id: 'other' }, () => {}) || answered;
  assert.equal(answered, false);
});

test('toolbar: answers offered before the bridge was there are still heard', async () => {
  const w = newWindow();
  const { chrome, on } = fakeChrome();
  const platform = runPlayer(w);
  platform.toolbar({ status: () => ({ state: 'waiting' }) });
  runBridge(w, chrome);
  await tick();
  assert.deepEqual(plain(await askTab(on, 'status')), { state: 'waiting' });
});

test('toolbar: turned off is read with the settings; settings changed elsewhere reach the page, its own writes are not echoed', async () => {
  const w = newWindow();
  const { chrome, store, on } = fakeChrome();
  store.off = true;
  runBridge(w, chrome);
  const platform = runPlayer(w);
  await new Promise((r) => platform.whenKv(r));
  assert.equal(platform.off(), true);
  platform.kv.set(P, '{"telemetry":true}');
  await tick();
  for (const fn of on.changed) fn({ ['kv:' + P]: { newValue: '{"telemetry":true}' } }, 'local');
  assert.equal(platform.kv.get(P), '{"telemetry":true}');
  for (const fn of on.changed) fn({ ['kv:' + P]: { newValue: '{"telemetry":false}' } }, 'local');
  assert.equal(platform.kv.get(P), '{"telemetry":false}');
});

test('settings: sync is written at most once per gap, and not when nothing synced changed', async () => {
  const w = newWindow();
  const { chrome, syncWrites } = fakeChrome();
  runBridge(w, chrome);
  const platform = runPlayer(w);
  await new Promise((r) => platform.whenKv(r));
  platform.kv.set(P, JSON.stringify({ rate: 1.5 }));
  platform.kv.set(P, JSON.stringify({ rate: 1.5, volume: 0.2 }));   // a device setting only
  platform.kv.set(P, JSON.stringify({ rate: 1.75, volume: 0.2 }));
  await tick();
  assert.deepEqual(syncWrites.map((o) => JSON.parse(o.prefs)), [{ rate: 1.5 }], 'the first at once, the next after the gap');
});

test('settings: without the bridge, the page\'s storage, and the player still starts', async () => {
  const w = newWindow();
  const page = pageKv({ [P]: '{"rate":2}' });
  const platform = runPlayer(w, page);
  await new Promise((r) => platform.whenKv(r));   // after EXT_KV_WAIT_MS
  assert.equal(platform.kv.get(P), '{"rate":2}');
  platform.kv.set(P, '{"rate":3}');
  assert.equal(page.get(P), '{"rate":3}');
});

test('service worker: posts only to the usage-data server, without cookies', async () => {
  let listener = null;
  const fetched = [];
  const ctx = vm.createContext({
    chrome: {
      runtime: { id: 'ext', onMessage: { addListener: (fn) => { listener = fn; } }, onInstalled: { addListener() {} } },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      commands: { onCommand: { addListener() {} } },
    },
    fetch: async (url, init) => { fetched.push({ url, init }); return { status: 200, text: async () => 'ok' }; },
    AbortSignal: { timeout: () => undefined }, Math,
  });
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(x.files[f], ctx); };
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

function runWorker(store, version) {
  const badge = [];
  const changed = [];
  const installed = [];
  const tabs = [];
  const ctx = vm.createContext({
    chrome: {
      runtime: { id: 'ext', getManifest: () => ({ version }), onMessage: { addListener() {} }, onInstalled: { addListener: (fn) => installed.push(fn) } },
      commands: { onCommand: { addListener() {} } },
      storage: { local: { get: async (k) => (k in store ? { [k]: store[k] } : {}), set: async (o) => { Object.assign(store, o); } }, onChanged: { addListener: (fn) => changed.push(fn) } },
      action: { setBadgeText: async (o) => { badge.push(o.text); }, setBadgeBackgroundColor: async () => {} },
      tabs: { create: async (o) => { tabs.push(o.url); } },
    },
    fetch: async () => ({}), AbortSignal: { timeout: () => undefined }, Math, Date, String, Number,
  });
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(x.files[f], ctx); };
  vm.runInContext(x.files['background.js'], ctx);
  return { badge, changed, tabs, install: (details) => { for (const fn of installed) fn(details); } };
}

test('service worker: "OFF" on the toolbar button while turned off; the install date noted once; the welcome page after an install', async () => {
  const store = { off: true };
  const w = runWorker(store, '1.1.0');
  await tick();
  assert.deepEqual(w.badge, ['OFF']);
  for (const fn of w.changed) fn({ off: { newValue: false } }, 'local');
  assert.deepEqual(w.badge, ['OFF', '']);
  w.install({ reason: 'install' });
  await tick();
  const at = store.installedAt;
  assert.ok(at > 0);
  assert.deepEqual(w.tabs, ['welcome.html']);
  assert.equal(store.news, undefined, 'a new install has nothing to tell');
  w.install({ reason: 'chrome_update' });
  await tick();
  assert.equal(store.installedAt, at, 'kept from the first install');
  assert.deepEqual(w.tabs, ['welcome.html'], 'opened after the install only');
});

test('the version told about is the one the welcome page lists', () => {
  const told = /const NEWS = '([\d.]+)';/.exec(x.files['background.js'])[1];
  assert.equal(/const NEWS = '([\d.]+)';/.exec(x.files['welcome.js'])[1], told);
});

test('service worker: an update to the version with news has the player tell it once; others do not', async () => {
  const cases = [['1.1.0', '1.0.1', '1.1'], ['1.1.2', '1.0.0.1', '1.1'], ['1.1.1', '1.1.0', undefined], ['1.2.0', '1.0.1', undefined], ['1.1.0', '1.1.0', undefined]];
  for (const [now, before, want] of cases) {
    const store = {};
    const w = runWorker(store, now);
    w.install({ reason: 'update', previousVersion: before });
    await tick();
    assert.equal(store.news, want, before + ' -> ' + now);
    assert.deepEqual(w.tabs, [], 'no tab opened on an update');
  }
});

// The data store's frame (store.js): it serves only a parent on one of Echo360's sites.
function runStore(parentOrigin) {
  const posted = [];
  const listeners = [];
  const parent = { postMessage: (data, origin) => posted.push([data, origin]) };
  const win = { parent, addEventListener: (type, fn) => listeners.push(type) };
  vm.runInNewContext(x.files['store.js'], { window: win, location: { ancestorOrigins: parentOrigin ? [parentOrigin] : [] }, indexedDB: {}, navigator: {}, setTimeout, clearTimeout, Promise, Map, Array, String, Object, Error });
  return { posted, listeners };
}

test('data store frame: serves an Echo360 site only', () => {
  const ok = runStore('https://echo360.org');
  assert.deepEqual(ok.posted, [['lite-player-for-echo360:store-ready', 'https://echo360.org']]);
  assert.deepEqual(ok.listeners, ['message']);
  for (const other of ['https://evil.example', 'https://lms.test', 'https://echo360.org.evil.example', '']) {
    const r = runStore(other);
    assert.equal(r.posted.length + r.listeners.length, 0, other);
  }
});

test('Add lecture moment takes the lecture playing, or else the one used last; never the tab it adds to', async () => {
  const answers = { 1: { lecture: { playing: false, usedAt: 300 } }, 2: { lecture: { playing: true, usedAt: 100 } }, 3: { lecture: { playing: false, usedAt: 500 } }, 4: null, 5: { state: 'courseList', lecture: null } };
  const ctx = vm.createContext({
    chrome: { tabs: { query: async () => [1, 2, 3, 4, 5].map((id) => ({ id })), sendMessage: async (id, msg) => (msg.name === 'status' ? answers[id] : null) } },
    Promise, Object, Array,
  });
  vm.runInContext(x.files['moment.js'], ctx);
  assert.deepEqual(plain(await vm.runInContext('lectureTabs(9)', ctx)).map((t) => t.id), [2, 3, 1]);
  assert.deepEqual(plain(await vm.runInContext('lectureTabs(2)', ctx)).map((t) => t.id), [3, 1]);
});
