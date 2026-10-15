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

// What Tampermonkey and Violentmonkey give a script with any @grant other than none: a
// `window` that reads through to the page but keeps what is written or defined on it to
// itself, and the page's own window as `unsafeWindow`.
function managerWindow(w) {
  return new Proxy({}, {
    get(t, k) {
      if (Reflect.has(t, k)) return t[k];
      const v = w[k];
      return typeof v === 'function' && typeof k === 'string' && /^[a-z]/.test(k) ? v.bind(w) : v;
    },
    set(t, k, v) { t[k] = v; return true; },
    has(t, k) { return Reflect.has(t, k) || k in w; },
  });
}

// A lesson page with the userscript loaded and debug on (so the player is reachable).
// Timers are counted: every interval and timeout set by the page and not yet cleared.
// granted: run as a userscript manager runs a script with @grant (managerWindow).
function page({ granted = false } = {}) {
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
  if (granted) {
    w.__managerWindow = managerWindow(w);
    w.eval('(function (window, unsafeWindow) {\n' + script + '\n})(__managerWindow, this);');
  } else {
    w.eval(script);
  }
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

test('a side-panel load that fails for now keeps its tab with "Retry"; one the lesson does not offer has no tab', async () => {
  const pg = page();
  const w = pg.w;
  // Echo360 for this test: notes fail with a server error once, discussion is refused
  // (not offered here), the transcript and captions fail with no connection until online.
  let notesCalls = 0;
  let online = false;
  const json = (status, body) => new w.Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  w.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/notes/content')) return ++notesCalls === 1 ? json(500, {}) : json(200, { status: 'ok', data: [] });
    if (u.includes('/questions')) return json(403, {});
    if (u.includes('/transcript') || u.includes('.vtt')) {
      if (!online) throw new TypeError('Failed to fetch');
      return u.includes('.vtt') ? new w.Response('') : json(200, { data: { contentJSON: { cues: [{ startMs: 0, endMs: 2000, content: 'Hello' }, { startMs: 2000, endMs: 4000, content: 'there' }] } } });
    }
    throw new Error('offline in tests');
  };
  pg.start();
  const p = pg.player();
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const pane = (t) => p.root.querySelector('.pane[data-pane=' + t + ']');
  try {
    await settle();
    assert.ok(p.sidebar.has('notes'), 'notes tab kept');
    assert.ok(pane('notes').classList.contains('loadfailed'));
    assert.match(pane('notes').querySelector('.loaderr').textContent, /HTTP 500/);
    assert.ok(!p.sidebar.has('discussion'), 'a refusal means not offered: no tab');
    assert.ok(p.sidebar.has('transcript'), 'transcript tab kept');
    // Shown before the cues arrive: an empty list, not an error.
    p.sidebar.open('transcript');
    assert.equal(p.sidebar.active, 'transcript');
    assert.equal(p.root.querySelector('.top [data-open=transcript]').getAttribute('aria-pressed'), 'true');

    pane('notes').querySelector('.loaderr button').click();
    await settle();
    assert.ok(!pane('notes').classList.contains('loadfailed'), 'Retry loaded the notes');
    assert.ok(p.notesReady);

    online = true;
    w.dispatchEvent(new w.Event('online'));
    await settle();
    assert.ok(!pane('transcript').classList.contains('loadfailed'), 'back online: loaded again');
    assert.equal(pane('transcript').querySelectorAll('.trow').length, 2, 'the open tab shows the new list');
  } finally {
    p.destroy();
    await w.happyDOM.abort();
    w.close();
  }
});

test('the open Notes and Discussion tabs say the playing moment, not the moment they were opened', async () => {
  const pg = page();
  const w = pg.w;
  const json = (body) => new w.Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  w.fetch = async (url) => {
    if (String(url).includes('/notes/content')) return json({ status: 'ok', data: [] });
    if (String(url).includes('/questions')) return json({ questions: [] });
    throw new Error('offline in tests');
  };
  pg.start();
  const p = pg.player();
  try {
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(p.notesReady);
    p.sidebar.open('notes');
    const box = p.root.querySelector('.pane[data-pane=notes] textarea');
    assert.match(box.placeholder, /0:00/);
    Object.defineProperty(p.video, 'currentTime', { configurable: true, get: () => 125, set() {} });
    p.video.dispatchEvent(new w.Event('seeked'));
    assert.match(box.placeholder, /2:05/, 'a seek while the tab is open moves the time');
    p.sidebar.open('discussion');
    const link = p.root.querySelector('.pane[data-pane=discussion] label.check');
    assert.match(link.textContent, /2:05/);
    Object.defineProperty(p.video, 'currentTime', { configurable: true, get: () => 200, set() {} });
    p.video.dispatchEvent(new w.Event('timeupdate'));
    assert.match(link.textContent, /3:20/, 'playing on moves "Link to" with it');
  } finally {
    p.destroy();
    await w.happyDOM.abort();
    w.close();
  }
});

test('an automatic message waits for the one shown, replaces its own, and is dropped once no longer true', async () => {
  const pg = page();
  pg.start();
  const p = pg.player();
  const box = p.root.querySelector('.toast');
  const text = () => (box.hidden ? null : box.querySelector('.msg').textContent);
  let on = true;
  try {
    p.toast('Resumed', 'Start over', () => {});
    p.toast('Camera only', 'Undo', () => {}, { later: true, from: 'empty', valid: () => on });
    assert.equal(text(), 'Resumed', '"Start over" stays available');
    box.querySelector('.act').click();
    assert.equal(text(), 'Camera only', 'shown when the other one closes');
    on = false;
    p.toast('Back', 'Undo', () => {}, { later: true, from: 'empty', valid: () => !on });
    assert.equal(text(), 'Back', 'replaces its own message at once');
    p.toast('Resumed', 'Start over', () => {});
    p.toast('Camera only', 'Undo', () => {}, { later: true, from: 'empty', valid: () => on });
    on = false;   // and back again before its turn came
    box.querySelector('.act').click();
    assert.equal(text(), null, 'a message that is no longer true is not shown');
  } finally {
    p.destroy();
    await pg.w.happyDOM.abort();
    pg.w.close();
  }
});

test('the camera is not shown for an empty screen at 0:00 while the player is on its way to the resume point', async () => {
  const pg = page();
  pg.start();
  const p = pg.player();
  try {
    assert.ok(p.dual && p.emptyScreen, 'two views');
    // Loading at the resume point (2000 s); the element still says 0. The recording starts
    // with five empty minutes.
    p.clock.starting = { at: 2000, play: false };
    p.slides.screenIndex = p.sources[0].index;
    p.slides.uniform = [{ start: 0, end: 300 }];
    p.onSlidesChange();
    p.video.dispatchEvent(new pg.w.Event('timeupdate'));
    assert.equal(p.emptyScreen.on, false, 'no switch for a moment that is not played');
    // Once playback is in the empty stretch, it switches.
    p.clock.starting = { at: 100, play: false };
    p.video.dispatchEvent(new pg.w.Event('timeupdate'));
    assert.equal(p.emptyScreen.on, true);
  } finally {
    p.destroy();
    await pg.w.happyDOM.abort();
    pg.w.close();
  }
});

test('a silence at 0:00 is not skipped automatically while the player is on its way to the resume point', async () => {
  const pg = page();
  pg.start();
  const p = pg.player();
  try {
    const seeks = [];
    p.seek = (t) => seeks.push(t);
    p.prefs.silence.auto = true;
    p.silence.skips = [{ start: 0, end: 100, kind: 'silence' }];
    p.silence.idx = -1;
    p.clock.starting = { at: 2000, play: true };
    p.video.dispatchEvent(new pg.w.Event('timeupdate'));
    assert.deepEqual(seeks, [], 'the resume point is kept');
  } finally {
    p.destroy();
    await pg.w.happyDOM.abort();
    pg.w.close();
  }
});

test('with @grant (a wrapped window), the player still catches the page\'s own start-up call', async () => {
  const pg = page({ granted: true });
  try {
    pg.start();
    assert.equal(pg.original(), null, 'the original player was not started');
    assert.ok(pg.player() && pg.player().video, 'the player took over');
    assert.ok(!Object.hasOwn(pg.w.__managerWindow, 'Echo'), 'the trap is on the page, not on the wrapper');
  } finally {
    if (pg.player()) pg.player().destroy();
    await pg.w.happyDOM.abort();
    pg.w.close();
  }
});
