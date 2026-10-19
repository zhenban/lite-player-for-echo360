// Start-up paths (00-boot.js, 15-takeover.js, 90-main.js), with the whole userscript in a
// simulated lesson page: the script run before the page starts its player (intercept), after
// it did (takeover, as Stay on iPadOS did), and every way back to the original player.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { newWindow, closeWindow, patchProto, same } from './dom-guard.mjs';
import { assemble } from '../build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = assemble({ dev: true }).out;
const cfg = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'boot-echo360-classroom.json'), 'utf8'));
cfg.id = 'r00000000-test';
const bootText = JSON.stringify(cfg);
const REPORT = 'https://api.echo360.net.au/a/player/beacon';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function fakeHls() {
  class FakeHls {
    constructor() { this.levels = []; }
    static isSupported() { return true; }
    on() {}
    once() {}
    loadSource() {}
    attachMedia() {}
    startLoad() {}
    destroy() {}
  }
  FakeHls.Events = { ERROR: 'e', MANIFEST_PARSED: 'm', LEVEL_SWITCHED: 'l', MEDIA_DETACHING: 'd', MEDIA_ATTACHED: 'a' };
  FakeHls.ErrorTypes = { NETWORK_ERROR: 'n', MEDIA_ERROR: 'x' };
  return FakeHls;
}

// A lesson page.
//   state       document.readyState when the script runs
//   started     the page has started its own player already: Echo is set, its container holds
//               a playing video, and (react) a React root that can be unmounted
//   inline      the page's inline bootstrap script is there (the text it was started with)
//   hls         hls.js already on the page (else it is loaded, and fails: offline)
//   ua, setup   a user agent; changes to the page before the script runs
//   cdn         (url) => Promise of a Response: the CDN's answer for hls.js (default: offline)
//   src         the userscript (default: the build)
function page({ state = 'loading', started = false, react = true, inline = true, arg = bootText, hls = true, ua, setup, cdn, src = script } = {}) {
  const w = newWindow({ url: 'https://echo360.net.au/lesson/x/classroom', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, ...(ua ? { navigator: { userAgent: ua } } : {}) } });
  if (hls) w.Hls = fakeHls();
  w.localStorage.setItem('lite-player-for-echo360:debug', 'true');
  const sent = { fetch: [], xhr: [], beacon: [] };
  w.fetch = async (url, opts) => {
    sent.fetch.push([String(url), opts]);
    // Usage data is taken (a failed send would wait to retry after the test).
    if (String(url).endsWith('/v1/events')) return new w.Response('{"stored":1}', { status: 200 });
    if (cdn && /cdn\.jsdelivr\.net/.test(String(url))) return cdn(String(url), w);
    throw new Error('offline in tests');
  };
  patchProto(w.XMLHttpRequest.prototype, 'send', function send() { sent.xhr.push(this); });
  patchProto(w.Navigator.prototype, 'sendBeacon', function sendBeacon(url) { sent.beacon.push(String(url)); return true; });
  // The page's own timers of BOOT_CHECK_MS come at once.
  const setTimeout0 = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...a) => setTimeout0(fn, ms === 8000 ? 1 : ms, ...a);
  const calls = [];
  const original = function echoPlayerV2FullApp(a) { calls.push(a); };
  const t = { w, sent, calls, video: null, container: null, unmounts: 0 };
  if (inline) {
    const s = w.document.createElement('script');
    s.textContent = 'if (document.readyState === "complete") { Echo["echoPlayerV2FullApp"](' + JSON.stringify(arg) + ') }';
    w.document.head.append(s);
  }
  if (started) {
    w.Echo = { echoPlayerV2FullApp: original };
    const box = w.document.createElement('div');
    box.id = cfg.id;
    const v = w.document.createElement('video');
    let paused = false;
    Object.defineProperty(v, 'paused', { get: () => paused, configurable: true });
    Object.defineProperty(v, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(v, 'currentTime', { value: 4268.5, writable: true, configurable: true });
    v.pause = () => { paused = true; };
    v.play = () => { paused = false; return Promise.resolve(); };
    v.setAttribute('src', 'blob:https://echo360.net.au/0');
    box.append(v);
    if (react) box._reactRootContainer = { unmount: () => { t.unmounts++; box.textContent = ''; } };
    w.document.body.append(box);
    t.video = v;
    t.container = box;
  }
  Object.defineProperty(w.document, 'readyState', { value: state, configurable: true });
  if (setup) setup(w);
  w.eval(src);
  if (!started) {
    // The page's inline bootstrap, as at document complete.
    w.Echo = { echoPlayerV2FullApp: original };
    if (inline) w.eval('Echo["echoPlayerV2FullApp"](' + JSON.stringify(arg) + ')');
    w.dispatchEvent(new w.Event('load'));
  }
  t.boot = () => w.__litePlayerForEcho360Boot;
  t.player = () => w.__litePlayerForEcho360;
  t.dev = () => w.__litePlayerForEcho360Dev;
  t.notice = () => w.document.querySelector('.lite-player-for-echo360-notice');
  // happy-dom's abort() can wait on its own task queue for good (seen after a container was
  // taken out and put back): bounded, the window is closed anyway.
  t.close = async () => {
    try { if (t.player()) t.player().destroy(); } catch (e) { /* gone */ }
    await closeWindow(w);
  };
  return t;
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('start-up: run before the page started its player, the bootstrap is caught and the original never runs', async () => {
  const t = page();
  await settle(60);
  assert.equal(t.boot().path, 'intercept');
  assert.equal(t.boot().readyState, 'loading');
  assert.ok(t.boot().readyAt > 0);
  assert.equal(t.calls.length, 0);
  assert.ok(t.player());
  assert.equal(t.notice(), null, 'no notice, and the missed-bootstrap check does not fire');
  await t.close();
});

test('installed twice (the extension and the userscript): the first copy keeps the page, the second does nothing and says so', async () => {
  const warned = [];
  const t = page({
    setup: (w) => {
      w.console.warn = (...a) => { warned.push(a.map(String).join(' ')); };
      w.eval(script);   // the first copy
    },
  });
  await settle(60);
  assert.equal(t.boot().path, 'intercept');
  assert.equal(t.calls.length, 0, 'the original player never ran');
  // Two copies made two players (the second without the id).
  assert.equal([...t.w.document.querySelectorAll('*')].filter((e) => e.shadowRoot).length, 1, 'one player');
  assert.ok(warned.some((x) => /another copy \(.+\) already runs on this page/.test(x)), warned.join('\n'));
  await t.close();
});

test('start-up: run late on a page whose start-up data is not there: the original player with the reason (the check is not lost)', async () => {
  const t = page({ state: 'complete', started: true, inline: false });
  await settle(60);
  assert.equal(t.boot().path, 'fallback');
  assert.match(t.boot().reason, /^noBootData/);
  assert.ok(t.notice(), 'a notice says so');
  assert.equal(t.video.paused, false, 'the original player was left alone');
  assert.equal(t.unmounts, 0);
  assert.equal(t.player(), undefined);
  await t.close();
});

test('start-up: run early on a page that never calls its bootstrap: the check after load still says so', async () => {
  const t = page({ inline: false, setup: (w) => { w.document.body.append(w.document.createElement('video')); } });
  await settle(60);
  assert.equal(t.boot().path, 'fallback');
  assert.equal(t.boot().reason, 'noBootstrap');
  assert.ok(t.notice());
  await t.close();
});

test('start-up: run late on start-up data that cannot be read: the original player goes on, untouched', async () => {
  const t = page({ state: 'complete', started: true, arg: '{"id":"' + cfg.id + '","video":{}}' });
  await settle(60);
  assert.equal(t.boot().path, 'fallback');
  assert.match(t.boot().reason, /^startFailed: video\.playableMedias missing/);
  assert.equal(t.video.paused, false);
  assert.equal(t.unmounts, 0);
  assert.ok(t.notice());
  await t.close();
});

test('takeover: the original player is unmounted and emptied, ours goes on where it was, playing', async () => {
  const t = page({ state: 'complete', started: true });
  await settle(60);
  const b = t.boot();
  assert.equal(b.path, 'takeover');
  assert.equal(b.readyState, 'complete');
  assert.deepEqual({ ...b.took }, { at: 4268.5, playing: true, unmounted: true });
  assert.equal(t.unmounts, 1);
  assert.equal(t.video.paused, true);
  assert.equal(t.video.muted, true);
  assert.equal(t.video.getAttribute('src'), null, 'its video downloads nothing more');
  assert.equal(t.container.isConnected, true);
  assert.equal(t.calls.length, 0, 'the original bootstrap is not run again');
  assert.equal(t.player().opts.takeover.at, 4268.5);
  assert.equal(t.player().opts.takeover.playing, true);
  assert.equal(t.notice(), null);
  // Still loading (the element says paused), but it is going to play: the button says
  // Pause, and pressing it pauses (before, it said Play and the press paused it anyway).
  const p = t.player();
  const btn = p.root.querySelector('.play');
  assert.equal(p.clock.playing(), true);
  assert.equal(btn.getAttribute('aria-label'), 'Pause');
  btn.click();
  assert.equal(p.clock.playing(), false);
  assert.equal(btn.getAttribute('aria-label'), 'Play');
  btn.click();
  assert.equal(p.clock.playing(), true);
  assert.equal(btn.getAttribute('aria-label'), 'Pause');
  await t.close();
});

test('takeover of a playing original where the browser refuses to play: the button goes back to Play', async () => {
  const t = page({
    state: 'complete', started: true,
    setup: (w) => {
      // The stream arrives at once; the browser refuses playing without a press.
      class ReadyHls extends w.Hls { once(ev, fn) { if (ev === 'm') setTimeout(fn, 0); } }
      w.Hls = ReadyHls;
      patchProto(w.HTMLMediaElement.prototype, 'play', function play() { return Promise.reject(new w.DOMException('no autoplay', 'NotAllowedError')); });
    },
  });
  await settle(60);
  const p = t.player();
  assert.equal(t.boot().path, 'takeover');
  assert.equal(p.clock.playing(), false, 'no longer meant to play');
  assert.equal(p.root.querySelector('.play').getAttribute('aria-label'), 'Play');
  await t.close();
});

test('takeover: the original\'s watch reports are stopped however they are sent; ours pass; going back lifts the stop', async () => {
  const savedXhr = { ctor: null, nav: null };
  const t = page({ state: 'complete', started: true, setup: (w) => { savedXhr.ctor = w.XMLHttpRequest; savedXhr.nav = w.navigator; } });
  await settle(60);
  const w = t.w;
  const { OWN_REQUEST } = t.dev();
  const sentryFetch = (...a) => w.fetch(...a);   // a wrapper that looks fetch up at each call
  const out = () => t.sent.fetch.filter(([u]) => u.startsWith('https://api.echo360.net.au/a/')).length;
  const before = out();
  await w.fetch(REPORT, { method: 'POST', body: '{}' });
  await sentryFetch('https://api.echo360.net.au/a/player/session', { method: 'post' });
  await w.fetch(new w.Request(REPORT, { method: 'POST' }));
  const x = new savedXhr.ctor();
  x.open('POST', REPORT);
  x.send('{}');
  assert.equal(savedXhr.nav.sendBeacon(REPORT, '{}'), true);
  assert.equal(out(), before, 'no fetch went out');
  assert.equal(t.sent.xhr.length, 0);
  assert.equal(t.sent.beacon.length, 0);
  assert.equal(t.boot().blocked, 5);
  assert.ok(t.dev().telemetry, 'dev hooks there');
  // Not a report, or ours: sent.
  await w.fetch(REPORT, { method: 'GET' }).catch(() => {});
  await w.fetch(REPORT, { method: 'POST', [OWN_REQUEST]: true }).catch(() => {});
  await w.fetch('https://api.echo360.net.au/a/other', { method: 'POST' }).catch(() => {});
  assert.equal(out(), before + 3);
  assert.equal(t.boot().blocked, 5);
  // Back to the original player: started again where ours was, and its reports go out.
  t.player().opts.onFallback('user');
  assert.equal(t.calls.length, 1);
  assert.equal(JSON.parse(t.calls[0]).id, cfg.id);
  assert.equal(t.boot().path, 'fallback');
  assert.equal(savedXhr.nav.sendBeacon(REPORT, '{}'), true);
  await w.fetch(REPORT, { method: 'POST' }).catch(() => {});
  assert.equal(t.sent.beacon.length, 1);
  assert.equal(out(), before + 4);
  assert.equal(t.boot().blocked, 5);
  await t.close();
});

test('takeover without React: the container is taken out and its videos kept silent; going back puts it in again', async () => {
  const t = page({ state: 'complete', started: true, react: false });
  await settle(60);
  assert.equal(t.boot().path, 'takeover');
  assert.equal(t.boot().took.unmounted, false);
  assert.equal(t.container.isConnected, false);
  // A video of the original player that something tries to play again (the guard is on the
  // prototype; the fake video above has its own play()).
  const v2 = t.w.document.createElement('video');
  t.container.append(v2);
  v2.muted = false;
  t.w.HTMLMediaElement.prototype.play.call(v2);
  assert.equal(v2.muted, true, 'a video of the original player is kept silent');
  t.player().opts.onFallback('user');
  assert.equal(t.container.isConnected, true);
  assert.equal(t.calls.length, 1);
  await t.close();
});

test('start-up: a browser without what the player needs: the original player at once, with the reason; an iPhone that has it gets the player', async () => {
  const t = page({ setup: (w) => { delete w.ResizeObserver; } });
  await settle(60);
  assert.equal(t.boot().path, 'fallback');
  assert.equal(t.boot().reason, 'unsupported: browser too old (no ResizeObserver)');
  assert.equal(t.calls.length, 1, 'the original bootstrap ran');
  assert.ok(t.notice());
  await t.close();
  const p = page({ ua: IPHONE });
  await settle(60);
  assert.equal(p.boot().path, 'intercept');
  assert.equal(p.calls.length, 0);
  assert.ok(p.player());
  await p.close();
});

test('start-up: hls.js that cannot be loaded leaves the page to the original player, with the reason', async () => {
  const t = page({ hls: false });
  await settle(200);
  assert.equal(t.boot().path, 'fallback');
  assert.match(t.boot().reason, /^libFailed/);
  assert.equal(t.calls.length, 1);
  assert.ok(t.notice());
  await t.close();
});

const loading = (t) => t.w.document.getElementById('lite-player-for-echo360-loading');

test('start-up: while hls.js loads slowly, a loading screen shows the lesson; leaving it starts the original player and a late hls.js is not used', async () => {
  let arrive;
  const t = page({ hls: false, cdn: () => new Promise((r) => { arrive = r; }) });
  await settle(60);
  assert.equal(loading(t), null, 'not at once (from the cache it would only flash)');
  await settle(500);
  const scr = loading(t);
  assert.ok(scr, 'shown after a moment');
  assert.equal(scr.shadowRoot.querySelector('h1').textContent, cfg.title || cfg.lesson.name);
  assert.equal(t.calls.length, 0, 'the original player is not started meanwhile');
  assert.equal(t.w.document.documentElement.style.overflow, 'hidden');
  scr.shadowRoot.querySelector('button').click();
  assert.equal(loading(t), null);
  assert.equal(t.w.document.documentElement.style.overflow, '');
  assert.equal(t.boot().path, 'fallback');
  assert.match(t.boot().reason, /^user/);
  assert.equal(t.calls.length, 1, 'the original player starts');
  arrive(new t.w.Response('x', { status: 200 }));
  await settle(60);
  assert.equal(t.player(), undefined, 'a late hls.js builds nothing');
  assert.equal(t.calls.length, 1);
  await t.close();
});

test('start-up: the loading screen shows the download\'s progress and goes when hls.js fails (the original player, with the reason)', async () => {
  let push;
  let end;
  const t = page({
    hls: false,
    cdn: (url, w) => {
      const body = new w.ReadableStream({ start(c) { push = (n) => c.enqueue(new Uint8Array(n)); end = () => c.close(); } });
      return Promise.resolve(new w.Response(body, { status: 200 }));
    },
  });
  await settle(560);
  push(200 * 1024);
  await settle(30);
  const scr = loading(t);
  assert.ok(scr);
  assert.match(scr.shadowRoot.querySelector('.status').textContent, /200 KB of 605 KB/);
  assert.equal(scr.shadowRoot.querySelector('.bar').getAttribute('aria-valuenow'), '33');
  end();   // not the pinned file: refused
  await settle(60);
  assert.equal(loading(t), null);
  assert.equal(t.boot().path, 'fallback');
  assert.match(t.boot().reason, /^libFailed: library file changed/);
  assert.equal(t.calls.length, 1);
  assert.ok(t.notice());
  await t.close();
});

// A stand-in for hls.js, pinned in a copy of the userscript, and served as the CDN's file:
// the real download path (hash check, module import) runs. Blob URLs cannot be imported in
// Node, so the module's blob is handed over as a data: URL.
const FAKE_HLS = 'module.exports = ' + fakeHls.toString() + '\n();';
function withFakeHls() {
  const realHash = /'hls\.js@[^']+': '([0-9a-f]{64})'/.exec(script)[1];
  const realSize = /'hls\.js@[^']+': (\d+),/.exec(script)[1];
  const src = script.replace(realHash, createHash('sha256').update(FAKE_HLS).digest('hex')).replace("hls.min.js': " + realSize + ',', "hls.min.js': " + Buffer.byteLength(FAKE_HLS) + ',');
  const setup = (w) => {
    const parts = new WeakMap();
    const RealBlob = w.Blob;
    // happy-dom's Blob does not take an ArrayBuffer of another realm (the downloaded bytes).
    w.Blob = class extends RealBlob {
      constructor(bits, opts) {
        const list = (bits || []).map((x) => (typeof x === 'string' ? Buffer.from(x) : Buffer.from(x.buffer ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x))));
        super([], opts);
        parts.set(this, Buffer.concat(list));
      }
    };
    w.URL.createObjectURL = (b) => 'data:text/javascript;base64,' + parts.get(b).toString('base64');
    w.URL.revokeObjectURL = () => {};
  };
  return { src, setup };
}

test('review 2 F3: after the loading screen, the player and a later fallback leave the page scrollable', async () => {
  let arrive;
  const t = page({ hls: false, ...withFakeHls(), cdn: (url, w) => new Promise((r) => { arrive = () => r(new w.Response(FAKE_HLS, { status: 200 })); }) });
  await settle(560);
  assert.ok(loading(t), 'the loading screen is up');
  assert.equal(t.w.document.documentElement.style.overflow, 'hidden');
  arrive();
  await settle(200);
  assert.ok(t.player(), 'the player started with the downloaded hls.js: ' + JSON.stringify(t.boot()));
  assert.equal(loading(t), null);
  assert.equal(t.w.document.documentElement.style.overflow, 'hidden', 'the player keeps the page still');
  t.player().opts.onFallback('user');
  assert.equal(t.calls.length, 1, 'the original player started');
  assert.equal(t.w.document.documentElement.style.overflow, '', 'and the page scrolls again');
  await t.close();
});

test('start-up: with hls.js at hand no loading screen is shown', async () => {
  const t = page();
  await settle(600);
  assert.equal(t.boot().path, 'intercept');
  assert.equal(loading(t), null);
  await t.close();
});

// The helpers alone (00-util.js, 03-common.js), in a context of their own.
function helpers(globals) {
  const ctx = vm.createContext(Object.assign({ console, setTimeout, clearTimeout, AbortController, DOMException, URL, performance }, globals));
  vm.runInContext(['00-util.js', '03-common.js'].map((f) => readFileSync(join(root, 'src', f), 'utf8')).join('\n')
    + '\n;globalThis.__x = { timeoutSignal, readJsString };', ctx);
  return ctx.__x;
}

test('start-up: without AbortSignal.timeout (Safari 15), requests still get a time limit', async () => {
  const { timeoutSignal } = helpers({ AbortSignal: {} });
  const s = timeoutSignal(5);
  assert.equal(s.aborted, false);
  await settle(40);
  assert.equal(s.aborted, true);
  // And the whole script starts there.
  const t = page({ setup: (w) => { delete w.AbortSignal.timeout; } });
  await settle(60);
  assert.equal(t.boot().path, 'intercept');
  await t.close();
});

test('readJsString reads a JavaScript string literal as the page\'s engine would', () => {
  const { readJsString } = helpers({});
  const cases = ['"plain"', "'single \\' quote'", '"esc \\n\\t\\\\ \\" \\/ \\u00e9 \\u{1F600} \\x41"', '"line\\\ncontinued"', '"\\u2028 \\0"', JSON.stringify(bootText)];
  for (const c of cases) assert.equal(readJsString('x(' + c + ')', 2), eval(c), c.slice(0, 40));
  assert.equal(readJsString('x("open', 2), null);
  assert.equal(readJsString('x("bad\\u12")', 2), null);
  assert.equal(readJsString('x(1)', 2), null);
});

test('fullscreen: the prefixed API where there is no other (iPadOS 15)', async () => {
  // happy-dom has no fullscreen API: each case adds what that browser has.
  const t = page({ setup: (w) => { patchProto(w.Element.prototype, 'webkitRequestFullscreen', function () { w.document.webkitFullscreenElement = this; }); } });
  try {
    await settle(60);
    const p = t.player();
    p.toggleFullscreen();
    await settle(10);
    same(t.w.document.webkitFullscreenElement, p.host, 'the player is fullscreen');
  } finally { await t.close(); }
});

test('in another site\'s frame that does not allow fullscreen: the button says why and nothing is asked of the browser; no floating window', async () => {
  let asked = 0;
  const t = page({
    setup: (w) => {
      patchProto(w.Element.prototype, 'requestFullscreen', function () { asked++; return Promise.reject(new Error('not allowed')); });
      Object.defineProperty(w.document, 'fullscreenEnabled', { value: false, configurable: true });
      w.documentPictureInPicture = { requestWindow: async () => { throw new Error('not in a frame'); } };
      Object.defineProperty(w, 'top', { value: {}, configurable: true });
    },
  });
  try {
    await settle(60);
    const p = t.player();
    const fs = p.$('.fs');
    assert.equal(fs.getAttribute('aria-disabled'), 'true');
    assert.match(fs.dataset.tip, /not allowed by the site showing this recording/);
    p.toggleFullscreen();
    assert.equal(asked, 0);
    assert.equal(p.menuActions.popout, null, 'no floating window in a frame');
  } finally { await t.close(); }
});

test('fullscreen on an iPhone: the main video in the system player', async () => {
  const i = page({ ua: IPHONE, setup: (w) => { patchProto(w.HTMLVideoElement.prototype, 'webkitEnterFullscreen', function () { w.__entered = this; }); } });
  try {
    await settle(60);
    i.player().toggleFullscreen();
    same(i.w.__entered, i.player().video, 'the main video is in the system player');
  } finally { await i.close(); }
});
