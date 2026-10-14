// The whole userscript in a simulated lesson page (happy-dom): the page's own bootstrap
// call, the player taking over, and what is left after it goes (review T1 item 2).
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { assemble } from '../build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = assemble().out;
const boot = readFileSync(join(root, 'test', 'fixtures', 'boot-echo360-classroom.json'), 'utf8');

// A stand-in for hls.js: parses nothing, loads nothing, records what it was asked.
function fakeHls(log) {
  class FakeHls {
    constructor(cfg) { this.cfg = cfg; this.levels = []; this.handlers = {}; log.push('new'); }
    static isSupported() { return true; }
    on(e, fn) { (this.handlers[e] ||= []).push(fn); }
    once(e, fn) { this.on(e, fn); }
    loadSource(u) { this.uri = u; }
    attachMedia() {}
    startLoad() {}
    destroy() { log.push('destroy'); }
  }
  FakeHls.Events = { ERROR: 'e', MANIFEST_PARSED: 'm', LEVEL_SWITCHED: 'l', MEDIA_DETACHING: 'd', MEDIA_ATTACHED: 'a' };
  FakeHls.ErrorTypes = { NETWORK_ERROR: 'n', MEDIA_ERROR: 'x' };
  return FakeHls;
}

// A lesson page with the userscript loaded and debug on (so the player is reachable).
// Timers are counted: every interval and timeout set by the page and not yet cleared.
function page() {
  const w = new Window({ url: 'https://echo360.net.au/lesson/x/classroom', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  const hlsLog = [];
  w.Hls = fakeHls(hlsLog);
  w.localStorage.setItem('lite-player-for-echo360:debug', 'true');
  // No network: every request fails (the player must cope).
  w.fetch = () => Promise.reject(new Error('offline in tests'));
  const intervals = new Set();
  const realSetInterval = w.setInterval.bind(w);
  const realClearInterval = w.clearInterval.bind(w);
  w.setInterval = (fn, ms, ...a) => { const id = realSetInterval(fn, ms, ...a); intervals.add(id); return id; };
  w.clearInterval = (id) => { intervals.delete(id); realClearInterval(id); };
  w.navigator.mediaSession && (w.navigator.mediaSession.setActionHandler ||= () => {});
  w.document.body.innerHTML = '<div id="echo-player-root"></div>';
  w.eval(script);
  let originalArg = null;
  // The page's own player, as the page defines it, and its inline start-up call.
  const start = () => {
    w.Echo = w.Echo || {};
    w.Echo.echoPlayerV2FullApp = (arg) => { originalArg = arg; };
    w.eval('Echo["echoPlayerV2FullApp"](' + JSON.stringify(boot) + ')');
  };
  return { w, start, intervals, hlsLog, original: () => originalArg, player: () => w.__litePlayerForEcho360 };
}

test('T1.2: the player takes over the page, and leaves nothing behind when it is destroyed', async () => {
  const pg = page();
  const { w } = pg;
  const before = new Set(pg.intervals);
  pg.start();
  const p = pg.player();
  assert.ok(p, 'player created');
  assert.equal(pg.original(), null, 'the original player did not start');
  const host = w.document.querySelector('#lite-player-for-echo360-host, .lite-player-for-echo360-host') || p.host;
  assert.ok(host && host.isConnected, 'the player is on the page');
  assert.equal(w.document.documentElement.style.overflow || w.document.body.style.overflow, 'hidden');
  assert.ok(pg.hlsLog.includes('new'), 'a stream was set up');
  assert.ok(pg.intervals.size > before.size, 'it runs its timers');
  await new Promise((r) => setTimeout(r, 50));
  p.destroy();
  assert.equal(host.isConnected, false, 'the player is gone from the page');
  assert.equal(w.document.documentElement.style.overflow || '', '');
  assert.equal(w.document.body.style.overflow || '', '');
  assert.equal([...pg.intervals].filter((id) => !before.has(id)).length, 0, 'no interval left running');
  assert.ok(pg.hlsLog.includes('destroy'), 'the stream was released');
  await w.happyDOM.abort();
  w.close();
});

test('T1.2: handing over to the original player passes the position on and tears this one down', async () => {
  const pg = page();
  pg.start();
  const p = pg.player();
  p.video.currentTime = 321;
  p.opts.onFallback('user');
  const handed = JSON.parse(pg.original());
  assert.equal(handed.startTimeMillis, 321000);
  assert.equal(p.destroyed, true);
  await pg.w.happyDOM.abort();
  pg.w.close();
});

test('T1.2/E1: a broken lesson page goes to the original player untouched, with nothing built', async () => {
  const pg = page();
  const bad = JSON.parse(boot);
  delete bad.video.playableMedias;
  pg.w.Echo = { echoPlayerV2FullApp: (arg) => { pg.w.__orig = arg; } };
  pg.w.eval('Echo["echoPlayerV2FullApp"](' + JSON.stringify(JSON.stringify(bad)) + ')');
  assert.ok(pg.w.__orig, 'the original player started');
  assert.equal(pg.player(), undefined);
  assert.equal(pg.w.document.body.style.overflow || '', '');
  await pg.w.happyDOM.abort();
  pg.w.close();
});

test('touch release keeps controls visible so a second tap can pause; mouse leave still hides them', async () => {
  const pg = page();
  const { w } = pg;
  pg.start();
  const p = pg.player();
  let paused = false;
  let toggles = 0;
  Object.defineProperty(p.video, 'paused', { configurable: true, get: () => paused });
  p.togglePlay = () => { toggles++; paused = !paused; };
  const pointer = (type, pointerType) => new w.PointerEvent(type, { bubbles: type !== 'pointerleave', pointerType, button: 0 });
  const tap = () => {
    p.video.dispatchEvent(pointer('pointerdown', 'touch'));
    p.video.dispatchEvent(pointer('pointerup', 'touch'));
    p.stage.dispatchEvent(pointer('pointerleave', 'touch'));
    p.video.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  };
  try {
    p.stage.classList.add('idle');
    tap();
    assert.equal(p.stage.classList.contains('idle'), false, 'lifting a finger does not hide the controls');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(toggles, 0, 'the first tap only wakes the controls');
    tap();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(toggles, 1, 'the next tap toggles playback');
    assert.equal(paused, true, 'the recording is paused');
    paused = false;
    p.stage.dispatchEvent(pointer('pointerleave', 'mouse'));
    assert.equal(p.stage.classList.contains('idle'), true, 'a mouse leaving during playback still hides controls');
    p.stage.dispatchEvent(pointer('pointermove', 'mouse'));
    assert.equal(p.stage.classList.contains('idle'), false, 'mouse movement still wakes controls');
  } finally {
    p.destroy();
    await w.happyDOM.abort();
    w.close();
  }
});

test('review R2: the U key passes its key event on, so removing a mark is a user action', async () => {
  const pg = page();
  pg.start();
  const p = pg.player();
  const got = [];
  p.notesReady = true;
  p.notes = { canFlag: true, flagByKey: (e) => { got.push(e); return true; } };
  try {
    pg.w.document.body.dispatchEvent(new pg.w.KeyboardEvent('keydown', { key: 'u', bubbles: true, composed: true, cancelable: true }));
    assert.equal(got.length, 1);
    assert.equal(got[0] && got[0].key, 'u', 'the key event reaches the write');
  } finally {
    p.destroy();
    await pg.w.happyDOM.abort();
    pg.w.close();
  }
});

test('copy picture takes what the user is looking at: the PDF page when the PDF view is the larger picture', async () => {
  const pg = page();
  pg.start();
  const p = pg.player();
  try {
    const rendered = [];
    const canvas = { toBlob: (cb) => cb(new pg.w.Blob(['png'])) };
    const deck = { pages: [{ key: 'aaaaaaaaaaaa:3', num: 3, file: 'week1.pdf' }], files: [{ hash: 'a'.repeat(64), name: 'week1.pdf' }], render: async (i, w, once) => { rendered.push([i, w, once]); return canvas; } };
    p.deck = deck;
    p.reader = { deck, currentView: () => 0, label: () => 'Page 3 of 9' };
    p.prefs.pdfMain = true;
    const pdf = p.root.querySelector('.pdfview');
    const size = (e, w, h) => { Object.defineProperty(e, 'clientWidth', { value: w, configurable: true }); Object.defineProperty(e, 'clientHeight', { value: h, configurable: true }); };
    // The PDF large, the video small (picture in picture, or a wide PDF side).
    pdf.dataset.slot = 'primary';
    p.video.dataset.slot = 'secondary';
    p.fvideo.dataset.slot = 'off';
    size(pdf, 900, 500);
    size(p.video, 300, 170);
    const f = p.focusView();
    assert.equal(f.page && f.page.num, 3);
    await f.page.render(1920);
    assert.deepEqual(rendered[0], [0, 1920, true], 'a one-off size, not kept in place of the page on screen');
    // Swapped: the video is the larger picture.
    pdf.dataset.slot = 'secondary';
    p.video.dataset.slot = 'primary';
    size(pdf, 300, 170);
    size(p.video, 900, 500);
    assert.equal(p.focusView().video, p.video);
    // Side by side with the divider moved: the larger side wins even in the second place.
    size(pdf, 800, 450);
    size(p.video, 400, 225);
    assert.ok(p.focusView().page);
    // No PDF view open: a video.
    p.prefs.pdfMain = false;
    assert.ok(p.focusView().video);
  } finally {
    p.destroy();
    await pg.w.happyDOM.abort();
    pg.w.close();
  }
});

test('a reload the player makes (language, expired session) comes back where playback was, not at Echo360\'s older position', async () => {
  const pg = page();
  pg.start();
  const p = pg.player();
  try {
    p.lesson.resumeAt = 4139;           // Echo360's last position: only follows playing
    p.clock.position = () => 1800;      // the user moved here (paused)
    let reloads = 0;
    pg.w.location.reload = () => { reloads++; };
    p.reloadHere();
    assert.equal(reloads, 1);
    assert.equal(p.pickStart(), 1800, 'back where it was');
    assert.equal(p.pickStart(), 4139, 'only once: a later load uses the usual position');
    // Another recording, or much later: not used.
    p.clock.position = () => 900;
    p.reloadHere();
    const raw = JSON.parse(pg.w.localStorage.getItem('lite-player-for-echo360:reloadAt'));
    pg.w.localStorage.setItem('lite-player-for-echo360:reloadAt', JSON.stringify({ ...raw, at: raw.at - 10 * 60000 }));
    assert.equal(p.pickStart(), 4139);
  } finally {
    p.destroy();
    await pg.w.happyDOM.abort();
    pg.w.close();
  }
});
