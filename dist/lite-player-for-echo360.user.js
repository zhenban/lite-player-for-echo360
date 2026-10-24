// ==UserScript==
// @name         Lite Player for Echo360
// @namespace    lite-player-for-echo360
// @version      1.0.1
// @updateURL    https://github.com/zhenban/lite-player-for-echo360/releases/latest/download/lite-player-for-echo360.user.js
// @downloadURL  https://github.com/zhenban/lite-player-for-echo360/releases/latest/download/lite-player-for-echo360.user.js
// @description  Unofficial, lightweight player for Echo360 lecture recordings: far lower CPU use, both views side by side, slide chapters, a PDF that follows the lecture. Falls back to the original player automatically if anything is not recognised.
// @license      GPL-3.0-or-later
// @match        https://echo360.net.au/lesson/*
// @match        https://echo360.net.au/section/*/home
// @match        https://echo360.org/lesson/*
// @match        https://echo360.org/section/*/home
// @match        https://echo360.org.uk/lesson/*
// @match        https://echo360.org.uk/section/*/home
// @match        https://echo360.ca/lesson/*
// @match        https://echo360.ca/section/*/home
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      lite-player-telemetry.zhenban.workers.dev
// @antifeature  tracking Anonymous usage data (performance, features used, errors; no names, recordings or content), on by default; Settings > Usage data turns it off, shows it or deletes it
// @inject-into  page
// @sandbox      raw
// ==/UserScript==

/* global Hls */
(function () {
  'use strict';

  const VERSION = '1.0.1';
  const DEV_HOOKS = false;

// ---- 00-boot.js ----
// ===================================================================================
// Start-up, before anything else: the trap for the page's player bootstrap is set first,
// using nothing else from this script (no library, no settings), so that the time the
// rest takes to set up can never make it late. 90-main.js decides what a trapped call
// does (boot.handler); until it has, and if it never does (the script failed to start),
// the call goes to the original player.
//
// A userscript manager can still run the script after the page has started its player
// (Stay on iPadOS did, even with @run-at document-start): 90-main.js then takes the page
// over (boot.path 'takeover'), see 15-takeover.js.
// ===================================================================================

const boot = {
  at: performance.now(),            // when this script started (ms since the page started)
  readyState: document.readyState,  // the page's state then: loading | interactive | complete
  path: '',                         // intercept | takeover | fallback (90-main.js)
  reason: '',                       // why the original player is used (fallback)
  readyAt: 0,                       // when our player was shown (performance.now())
  blocked: 0,                       // the original player's watch reports stopped (takeover)
  took: null,                       // takeover: { at (seconds or null), playing, unmounted } of the original player
  handler: null,                    // (arg, callOriginal) => void, set by 90-main.js
  called: false,                    // the page called its bootstrap after the trap was set
  original: () => null,             // the page's own bootstrap function, once known
  other: '',                        // another copy already runs on this page: its version
};

// The page's own window. With any @grant other than none, managers give the script a
// wrapper as `window`, whose properties the page's scripts do not see (platform.page is
// this same window).
function pageWindow() {
  return typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
}

// Installed twice (the userscript and the extension, or two script managers): the copy that
// runs first keeps the page, the other does nothing (90-main.js) and says so in the console.
// boot.other: the version of the copy already running ('' if this is the first).
const BOOT_MARK = '__litePlayerForEcho360Running';
boot.other = (() => {
  try {
    const page = pageWindow();
    if (page[BOOT_MARK]) return String(page[BOOT_MARK]);
    Object.defineProperty(page, BOOT_MARK, { value: VERSION, enumerable: false });
  } catch (e) { /* not marked: runs as if alone */ }
  return '';
})();

// Echo360 lesson pages bootstrap their React player with an inline call
//   Echo["echoPlayerV2FullApp"]("<json>")
// once the document is complete. The Echo object is wrapped in a Proxy, so the function is
// caught however it gets there: assigned, defined with defineProperty (as bundlers do), or
// already present when this runs; and so is an Echo object assigned later. Only a call
// made through a reference to the object kept from before it was assigned to window.Echo
// would pass by; the page's inline bootstrap uses the global.
(function trapEcho360() {
  if (boot.other || !/^\/lesson\//.test(location.pathname)) return;
  const NAME = 'echoPlayerV2FullApp';
  let original = null;
  boot.original = () => original;

  function launcher(arg) {
    const self = this;
    const callOriginal = (a) => (original ? original.call(self, a) : undefined);
    boot.called = true;
    if (!boot.handler) return callOriginal(arg);
    return boot.handler(arg, callOriginal);
  }
  function wrap(obj) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
    if (typeof obj[NAME] === 'function') original = obj[NAME];
    return new Proxy(obj, {
      get(target, key, receiver) {
        if (key === NAME) {
          // Defined on the object itself by code holding it directly: adopted now, when
          // the page calls it through the global Echo.
          const own = Reflect.get(target, key);
          if (typeof own === 'function' && own !== launcher) original = own;
          return original ? launcher : undefined;
        }
        return Reflect.get(target, key, receiver);
      },
      set(target, key, value) {
        if (key === NAME) { original = value; return true; }
        return Reflect.set(target, key, value);
      },
      defineProperty(target, key, desc) {
        if (key === NAME && ('value' in desc || desc.get)) {
          original = 'value' in desc ? desc.value : desc.get.call(target);
          return true;
        }
        return Reflect.defineProperty(target, key, desc);
      },
      has(target, key) { return key === NAME ? !!original : Reflect.has(target, key); },
      getOwnPropertyDescriptor(target, key) {
        if (key === NAME) return original ? { value: launcher, writable: true, enumerable: true, configurable: true } : undefined;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
  }

  // On the page's own window: the inline bootstrap reads the page's global.
  const page = pageWindow();
  let echo = wrap(page.Echo || {});
  try {
    Object.defineProperty(page, 'Echo', {
      configurable: true,
      enumerable: true,
      get() { return echo; },
      set(v) { echo = wrap(v); },
    });
  } catch (e) { /* not trapped: the page starts its own player, and 90-main.js says so */ }
})();

// ---- 00-util.js ----
// ===================================================================================
// Utilities
// ===================================================================================

const TAG = '[Lite Player for Echo360]';
const NS = 'lite-player-for-echo360:';

// After a backup has been restored, this page must not write its older data back over
// it (it reloads right away; until then writes are dropped).
const storageLock = { frozen: false };

const store = {
  get(key, fallback) {
    try {
      const v = platform.kv.get(NS + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    if (storageLock.frozen) return;
    try { platform.kv.set(NS + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  },
};

function fmtTime(sec, withHours) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0 || withHours) return h + ':' + String(m).padStart(2, '0') + ':' + ss;
  return m + ':' + ss;
}

function parseIsoDuration(s) {
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s || '');
  if (!m) return NaN;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

// A colour that is safe to put in a style: only "#rgb" or "#rrggbb" (stored or restored
// values could otherwise carry other CSS declarations or url() requests); else fallback.
const TAG_FALLBACK_COLOR = '#94a3b8';   // grey of the tag palette (56-tags.js)
function plainColor(c, fallback) {
  return typeof c === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : fallback;
}

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Errors in our own code come in two kinds.
//  - Core playback (the streams, the clock video's events, the layout): the page is handed
//    back to the original player (`unexpected.handler`, installed by the bootstrap, runs at
//    most once). Code reports these with reportUnexpected / guardCore.
//  - Everything else (menus, panels, tags, zoom, analyses, ...): logged, the user gets one
//    unobtrusive notice per feature, and the feature's own resources may be released
//    (Disposer.feature). Playback goes on. This is what guard() does by default.
// guard() also catches rejections of the Promise an async callback returns.
const unexpected = { handler: null };
const featureErrors = { notify: null, seen: new Set() };

// Usage data (87-telemetry.js) from code that knows nothing about it: never throws, and
// costs a call when usage data is off.
//   usageNote(kind, key, value)   something happened (a failed request, bytes loaded, ...)
//   usageStep(step, version, units, ms)
//                                 one run of a fixed amount of pure computation took ms
//                                 (see FIXED_STEPS in 87-telemetry.js)
function usageNote(kind, key, value) {
  try { telemetry.note(kind, key, value); } catch (e) { /* not counted */ }
}
function usageStep(step, version, units, ms) {
  try { telemetry.step(step, version, units, ms); } catch (e) { /* not counted */ }
}

function reportUnexpected(err) {
  console.error(TAG, 'unexpected error', err);
  try { telemetry.error('player core', err); } catch (e) { /* not counted */ }
  const h = unexpected.handler;
  unexpected.handler = null;
  if (h) { try { h(err); } catch (e) { /* ignore */ } }
}

function reportFeatureError(name, err) {
  const what = name || 'player';
  console.error(TAG, 'error in ' + what + ':', err);
  logEvent('error', what + ': ' + ((err && err.message) || err));
  try { telemetry.error(what, err); } catch (e) { /* not counted */ }
  if (featureErrors.seen.has(what)) return;
  featureErrors.seen.add(what);
  usageNote('guardOff', what);
  if (featureErrors.notify) { try { featureErrors.notify(what, err); } catch (e) { /* ignore */ } }
}

// fn wrapped so that an exception (or the rejection of the Promise it returns) goes to
// onError, by default a non-fatal feature error.
function guard(fn, onError) {
  const report = onError || ((e) => reportFeatureError(null, e));
  return function guarded() {
    try {
      const r = fn.apply(this, arguments);
      if (r && typeof r.then === 'function' && typeof r.catch === 'function') r.catch(report);
      return r;
    } catch (e) {
      report(e);
      return undefined;
    }
  };
}

// Core playback: an error hands the page back to the original player.
function guardCore(fn) {
  return guard(fn, reportUnexpected);
}

// Runs fn (a feature's setup) and turns the feature off instead of failing the player.
function featureGuard(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((e) => reportFeatureError(name, e));
    return r;
  } catch (e) {
    reportFeatureError(name, e);
    return undefined;
  }
}

// One log format: "[Lite Player for Echo360] ..." in the console. Warnings and errors always (and kept
// for diagnostics); information only with localStorage["lite-player-for-echo360:debug"] = true.
const log = {
  info(...a) { if (store.get('debug', false)) console.info(TAG, ...a); },
  warn(...a) { console.warn(TAG, ...a); logEvent('warn', a.map(logText).join(' ')); },
  error(...a) { console.error(TAG, ...a); logEvent('error', a.map(logText).join(' ')); },
};
function logText(x) { return x && x.message ? x.message : typeof x === 'string' ? x : String(x); }

// Recent warnings and errors (no content, no addresses), for "copy diagnostics".
const LOG_KEEP = 40;
const eventLog = [];
// An AbortSignal that aborts after ms (AbortSignal.timeout where there is one: Safari 16+).
function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new DOMException('timed out', 'TimeoutError')), ms);
  return ac.signal;
}

// The signal of a request to Echo360: aborted with `signal` (optional) or, with a
// TimeoutError, when no full answer came within REQUEST_TIMEOUT_MS (a hung request would
// otherwise keep a write busy or a renewal pending for good).
function requestSignal(signal) {
  const t = timeoutSignal(REQUEST_TIMEOUT_MS);
  if (!signal) return t;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, t]);
  const ac = new AbortController();
  const stop = (s) => () => ac.abort(s.reason);
  if (signal.aborted) stop(signal)();
  else { signal.addEventListener('abort', stop(signal), { once: true }); t.addEventListener('abort', stop(t), { once: true }); }
  return ac.signal;
}

function logEvent(level, text) {
  eventLog.push({ t: new Date().toISOString().slice(11, 19), level, text: String(text).slice(0, 300) });
  if (eventLog.length > LOG_KEEP) eventLog.shift();
}

// Owns every timer, listener, observer and child resource of a component so that one
// dispose() call releases all of them (used when switching recordings and when handing
// over to the original player). Listener and timer callbacks are wrapped with guard().
class Disposer {
  // opts: { onError } (where errors of its listeners and timers go; inherited by children)
  constructor(opts) {
    this.fns = [];
    this.disposed = false;
    this.onError = (opts && opts.onError) || null;
  }

  guarded(fn) {
    return guard(fn, this.onError);
  }

  add(fn) {
    if (this.disposed) { try { fn(); } catch (e) { /* ignore */ } return fn; }
    this.fns.push(fn);
    return fn;
  }

  listen(target, type, fn, opts) {
    const g = this.guarded(fn);
    target.addEventListener(type, g, opts);
    this.add(() => target.removeEventListener(type, g, opts));
    return g;
  }

  interval(fn, ms) {
    const id = setInterval(this.guarded(fn), ms);
    this.add(() => clearInterval(id));
    return id;
  }

  timeout(fn, ms) {
    const id = setTimeout(this.guarded(fn), ms);
    this.add(() => clearTimeout(id));
    return id;
  }

  observe(observer) {
    this.add(() => observer.disconnect());
    return observer;
  }

  child(opts) {
    const d = new Disposer(Object.assign({ onError: this.onError }, opts));
    this.add(() => d.dispose());
    return d;
  }

  // Resources of one optional feature: an error in its listeners or timers is reported
  // once, and the feature's resources are released (the feature stops; playback goes on).
  feature(name) {
    let d = null;
    d = this.child({ onError: (e) => { reportFeatureError(name, e); if (d) d.dispose(); } });
    return d;
  }

  // Resources of core playback: an error hands over to the original player.
  core() {
    return this.child({ onError: reportUnexpected });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const fns = this.fns.splice(0);
    for (let i = fns.length - 1; i >= 0; i--) {
      try { fns[i](); } catch (e) { console.warn(TAG, 'dispose failed', e); }
    }
  }
}

// Coalesces repeated render requests into at most one call per animation frame.
// Nothing is scheduled while the page is hidden; callers re-render on visibility change.
// nodeOf (optional): a node of what is drawn; its document and window are used (they
// change when the player moves into the floating window).
class FrameTask {
  constructor(fn, nodeOf) {
    this.fn = fn;
    this.nodeOf = nodeOf || (() => null);
    this.id = 0;
    this.win = null;
    this.run = () => { this.id = 0; this.fn(); };
  }

  request() {
    const node = this.nodeOf();
    if (hiddenFor(node)) return;
    const win = windowOf(node);
    // A frame asked for in another window (the floating window, since closed or left) may
    // never come: ask this one instead.
    if (this.id) { if (win === this.win) return; this.cancel(); }
    this.win = win;
    this.id = win.requestAnimationFrame(this.run);
  }

  cancel() {
    if (this.id && this.win) { try { this.win.cancelAnimationFrame(this.id); } catch (e) { /* a closed window */ } }
    this.id = 0;
  }
}

// ---- 01-i18n.js ----
// ===================================================================================
// User-facing strings: the English table here, other languages in their own files
// (01-lang-zh.js; the only files that may hold non-Latin text). The language is the
// user's choice in the settings menu (prefs.lang), else the browser's: Chinese for any
// "zh" language, English otherwise. A key missing from a table falls back to English.
// Diagnostics stay in English (they are read by the developer).
// ===================================================================================

const STRINGS = {
  en: {
    back: 'Back to course',
    seek: 'Playback position',
    play: 'Play',
    playKey: 'Play (Space)',
    pause: 'Pause',
    pauseKey: 'Pause (Space)',
    rewind: 'Back 10 seconds',
    rewindKey: 'Back 10 seconds (J)',
    forward: 'Forward 10 seconds',
    forwardKey: 'Forward 10 seconds (L)',
    mute: 'Mute',
    muteKey: 'Mute (M)',
    unmute: 'Unmute',
    unmuteKey: 'Unmute (M)',
    volume: 'Volume',
    volumeLevel: 'Volume {pct}%',
    muted: 'Muted',
    swapViews: 'Swap views',
    emptyScreenCamera: 'The screen shows nothing: showing the camera only.',
    emptyScreenBack: 'The screen shows a picture again: back to your layout.',
    emptyScreenAuto: 'Camera only while the screen is empty',
    telemetryMenu: 'Usage data',
    telemetrySend: 'Send anonymous usage data',
    telemetryDesc: 'How well the player runs on this computer, which features are used, and errors. No names, no recordings or courses, nothing you write. Kept on Cloudflare; only the country, region and network provider are kept, not the address.',
    telemetryView: 'View my data',
    telemetryDelete: 'Delete all my data',
    telemetryReset: 'Reset my ID',
    telemetryDataTitle: 'Your usage data',
    telemetryLoading: 'Loading…',
    telemetryNone: 'Nothing is stored for your ID.',
    telemetryFailed: 'Could not reach the server ({msg}). Try again later.',
    telemetryDownload: 'Download JSON',
    telemetryNoAnswer: 'no answer',
    telemetryRows: '{n} rows',
    telemetryRow: '1 row',
    telemetryKindEnv: 'Computer and browser',
    telemetryKindSession: 'Viewings',
    telemetryKindError: 'Errors',
    telemetryKindFallback: 'Switches to the original player',
    telemetryKindRegistration: 'Registration (once per ID)',
    telemetryDeleteTitle: 'Delete all your usage data?',
    telemetryDeleteText: 'Everything sent with your ID is deleted from the server now. This cannot be undone. Sending goes on unless you also turn it off.',
    telemetryDeleteConfirm: 'Delete',
    telemetryDeleted: 'Deleted from the server: {n} records.',
    telemetryResetTitle: 'Reset your ID?',
    telemetryResetText: 'A new ID is used from now on. Data sent with the old ID can then no longer be viewed or deleted from here.',
    telemetryResetDelete: 'Delete my data, then reset',
    telemetryResetOnly: 'Reset only',
    telemetryResetDone: 'New ID in use.',
    emptyScreenAutoDesc: 'Long stretches without a picture on the screen show the camera alone. Choosing a layout yourself turns this off for that recording.',
    swapViewsKey: 'Swap views (S)',
    layout: 'Layout',
    layoutNow: 'Layout: {layout}',
    layoutToSide: 'Switch to side by side',
    layoutToPip: 'Switch to picture in picture',
    layoutToSingle: 'Switch to single view',
    layoutSide: 'Side by side',
    layoutPip: 'Picture in picture',
    layoutSingle: 'Single view',
    resizeViews: 'Drag to resize the views',
    pipHint: 'Drag to move, click to swap views',
    resizePip: 'Drag to resize',
    secondViewLost: 'The second view could not be loaded and was hidden.',
    captions: 'Captions',
    captionsKey: 'Captions (C)',
    captionsLoading: 'Captions are loading',
    captionsNone: 'This recording has no captions',
    showCaptions: 'Show captions',
    hideCaptionsPaused: 'Hide while paused',
    copyFrame: 'Copy picture',
    copyFrameKey: 'Copy picture (P)',
    copyCaptions: 'Copy text',
    copyCaptionsKey: 'Copy text (A)',
    copyCaptionsSpan: 'Copy text length',
    copyCaptionsSpanDesc: 'Copy text copies what was said just before, in whole sentences, with the lecture name and times.',
    copySpanValue: 'Last {time}',
    copiedFrame: 'Picture copied ({w} × {h})',
    copiedPage: 'Copied page {n} of {file} as a picture',
    copiedCaptions: 'Copied {from}–{to} of the transcript',
    copyFailed: 'Could not copy ({msg})',
    copyNoCaptions: 'This recording has no transcript to copy.',
    pausedHint: 'Paused',
    captionSize: 'Text size',
    on: 'On',
    off: 'Off',
    transcript: 'Transcript',
    transcriptKey: 'Transcript (T)',
    closePanel: 'Close',
    resizePanel: 'Drag to resize',
    searchTranscript: 'Search transcript',
    prevMatch: 'Previous match (Shift+Enter)',
    nextMatch: 'Next match (Enter)',
    searchCount: '{n} found',
    searchPos: '{i} / {n}',
    backToCurrent: 'Back to current',
    notes: 'Notes',
    discussion: 'Discussion',
    sidebarTabs: 'Side panel',
    addNotePlaceholder: 'Write a private note at {time}',
    addNote: 'Add note',
    notesPrivate: 'Notes and bookmarks are private to you. Your instructor can see your "didn\'t understand" marks. Tags are only visible to you and stay on this device.',
    filterAll: 'All',
    filterNotes: 'Notes',
    filterBookmarks: 'Bookmarks',
    filterFlags: 'Didn\'t understand',
    noNotes: 'Nothing here yet. Add a note, a bookmark (B) or mark a part you didn\'t understand (U).',
    bookmark: 'Bookmark',
    bookmarkKey: 'Bookmark this moment (B)',
    bookmarkedAt: 'Bookmarked at {time}',
    removeBookmark: 'Remove bookmark',
    removeBookmarkKey: 'Remove the bookmark here (B)',
    bookmarkRemoved: 'Removed the bookmark at {time}',
    showFile: 'Show {name}',
    pdfFileNext: '{name}: show {next}',
    undo: 'Undo',
    flag: 'Didn\'t understand',
    flagRemoveLabel: 'Remove "Didn\'t understand" at {time}',
    flagVisible: 'Visible to your instructor',
    flagConfirm: 'Mark {time} as not understood? Your instructor will see it.',
    flagConfirmAction: 'Mark it',
    flagConfirmButton: 'Mark {time} for your instructor',
    flagAdded: 'Marked {time} as not understood',
    flagRemoved: 'Removed the mark at {time}',
    edit: 'Edit',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    confirmDelete: 'Delete?',
    remove: 'Remove',
    saveFailed: 'Could not save: {error}',
    loadFailed: 'Could not load: {error}',
    publicWarning: 'Posts and replies are visible to your instructors and classmates.',
    postPlaceholder: 'Ask a question or comment on this lecture',
    linkTime: 'Link to {time}',
    hideName: 'Hide my name',
    postPublic: 'Post',
    replyPublic: 'Reply',
    replyPlaceholder: 'Write a reply',
    replies: '{n} replies',
    oneReply: '1 reply',
    hideReplies: 'Hide replies',
    like: 'Like',
    unlike: 'Unlike',
    savePost: 'Save for later (only you see this)',
    unsavePost: 'Remove from saved',
    anonymous: 'Anonymous',
    you: 'You',
    youAnonymous: 'You (anonymous)',
    instructor: 'Instructor',
    ta: 'Teaching assistant',
    noPosts: 'No posts yet.',
    hiddenPosts: '{n} posts are hidden by your instructor.',
    attachment: 'Has an attachment',
    attachmentOpen: 'Has an attachment: switch to the original player to open it',
    refresh: 'Refresh',
    sortNewest: 'Newest first',
    sortVideoTime: 'By video time',
    charsLeft: '{n} characters left',
    tooLong: 'Too long by {n} characters',
    extrasNotice: 'This recording has {what}, which only the original player shows.',
    extraPolls: 'polls',
    extraSlides: 'slides',
    extraAudioDescription: 'an audio description track',
    markerNote: 'Note',
    markerBookmark: 'Bookmark',
    markerFlag: 'Didn\'t understand',
    markerComment: 'Post',
    audio: 'Audio',
    audioLevel: 'Even out volume',
    audioLevelDesc: 'Brings quiet speech up and keeps loud parts in check. Helps when the lecturer had no microphone.',
    audioVoice: 'Clearer voice',
    audioVoiceDesc: 'Cuts low hum from air conditioning and fans and lifts speech.',
    audioMono: 'Mono',
    audioMonoDesc: 'Plays both channels on both sides (for recordings that are only on one side).',
    quality: 'Quality',
    qualityAuto: 'Auto',
    qualityAutoBest: 'Auto (highest the network allows)',
    qualityScreen: 'Screen',
    qualityCamera: 'Camera',
    qualityNow: 'Playing {q}',
    slides: 'Slides',
    slideN: 'Slide {n}',
    slidesFinding: 'Finding slide changes: {pct}%',
    slidesRough: 'Approximate times from preview pictures. Finding exact changes: {pct}%',
    slidesFound: '{n} slides, found automatically from the screen recording.',
    slidesFromPreview: '{n} slides, estimated from Echo360\'s preview pictures (about one a minute), so the times are approximate.',
    slidesPreviewFinding: 'Estimating slide changes from Echo360\'s preview pictures…',
    slidesNone: 'No slide changes were found automatically in this recording.',
    slidesSaveData: 'Slide chapters are not looked for while the browser\'s Data Saver is on.',
    screenView: 'Screen:',
    viewN: 'View {n}',
    screenUse: 'Find the slides in view {n}',
    screenFound: 'found automatically',
    screenGuessed: 'best guess: choose the other view if the slides are wrong',
    screenChosen: 'chosen by you',
    screenAuto: 'Automatic',
    addSlides: 'Add the slide PDF…',
    addMoreSlides: 'Add another PDF…',
    slidesLocal: 'Add the lecturer\'s slide PDF to read along: it turns to the page being talked about. The file stays on this device.',
    removeFile: 'Remove {name}',
    deckLoading: 'Opening the slide files…',
    deckReading: 'Reading the slides on screen: {pct}%',
    deckWaiting: 'Waiting to find the screen view…',
    deckLangLoading: 'Getting text recognition for {lang} ({mb} MB, once)…',
    deckError: 'Could not read the slide file ({msg}).',
    deckTooBig: '{name} is too large for a slide file (at most {max} MB).',
    deckCapped: 'Only the first {n} pages are used to follow the lecture.',
    deckRemoveFailed: 'Could not remove {name} from this device ({msg}). It is still here.',
    deckSaveFailed: 'Could not store {name} on this device ({msg}). Is the disk full?',
    prevPage: 'Previous page',
    nextPage: 'Next page',
    pageOfN: 'Page {n} of {total}',
    following: 'Following the lecture',
    followingUnsure: 'Following the lecture (page not recognised here; showing the last one found)',
    followingStale: 'Following the lecture: the current page has not been recognised for a while',
    pageNotRecognised: 'Current page not recognised',
    followingShort: 'Following',
    followingUnsureShort: 'Following (last page found)',
    followingStaleShort: 'Page not recognised',
    backToLectureShort: 'Back to the lecture',
    pdfMainOpen: 'Show the PDF next to the video',
    pdfMainClose: 'Close the PDF view',
    pdfSwap: 'Swap the PDF and the video',
    backToLecture: 'Back to the page being talked about',
    shownAt: 'On screen at',
    notFoundInRecording: 'Not found in the recording.',
    wrongPage: 'Wrong page?',
    useThisPage: 'Show page {n} for the part playing now',
    markNotSlide: 'The part playing now is not a slide',
    undoCorrection: 'Undo my correction here',
    showChapters: 'Show the {n} chapters',
    hideChapters: 'Hide chapters',
    dropSlides: 'Drop the slide PDF here. It stays on this device.',
    dropNotPdf: 'Only PDF files can be added as slides.',
    silence: 'Silence',
    silenceAuto: 'Skip silence automatically',
    silenceAutoDesc: 'Jumps over long pauses (breaks, group work). Off: a button offers to skip.',
    silenceMin: 'Shortest silence to mark',
    silenceSensitivity: 'Sensitivity',
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    silenceFromTranscript: 'From the transcript: {n} silent stretches, {time} in total.',
    silenceFound: '{n} silent stretches, {time} in total.',
    silenceNone: 'No silence of {min} or longer.',
    silenceAnalysing: 'Analysing the audio: {pct}% done.',
    silenceWaiting: 'Looking for silence\u2026',
    silenceUnavailable: 'Silence detection is not available for this recording.',
    silenceSaveData: 'Silence detection is off while Data Saver is on.',
    silenceTip: 'Silence, {time}',
    blankTip: 'Black screen and silence, {time}',
    blackTip: 'Black screen, {time}',
    skipBlank: 'Skip empty part ({time})',
    skippedBlank: 'Skipped {time} of black screen and silence',
    contentEnded: 'The lecture has ended (black screen and silence from here).',
    contentEndSkip: 'Skip to the end',
    contentEndStop: 'Stop here',
    skipSilence: 'Skip silence ({time})',
    skippedSilence: 'Skipped {time} of silence',
    audioNoWebAudio: 'Audio processing is not available in this browser.',
    audioNativeHls: 'Audio processing needs Media Source Extensions, which this browser is not using for this video.',
    speed: 'Playback speed',
    speedKey: 'Playback speed ([ and ])',
    speedNow: 'Playback speed: {rate}',
    fullscreen: 'Full screen',
    fullscreenKey: 'Full screen (F)',
    exitFullscreen: 'Exit full screen',
    exitFullscreenKey: 'Exit full screen (F)',
    resumedAt: 'Resumed at {time}',
    startOver: 'Start over',
    authExpiredTitle: 'Playback access expired',
    authExpiredText: 'Echo360\'s video access has expired and could not be renewed. Reload the page to continue from where you are.',
    authLoginExpiredText: 'Your Echo360 sign-in has expired. Reload the page to sign in again; playback continues from where you are.',
    sessionRenewing: 'Refreshing the session…',
    featureFailed: 'Something went wrong in {name}; it is off for now. Playback is not affected.',
    tagExam: 'Exam',
    tagAssignment: 'Assignment',
    tagConfused: 'Didn\'t get it',
    tagsPrivate: 'Tags are only visible to you: they stay on this device and are never sent to Echo360. All recordings of this course share them.',
    tagsFor: 'Tags',
    newTag: 'New tag…',
    addTag: 'Add tag',
    addTagShort: '+ Tag',
    tagColor: 'Change colour',
    tagName: 'Tag name',
    manageTags: 'Tags…',
    filterTags: 'Filter by tag',
    allTags: 'All tags',
    untagged: 'No tag',
    done: 'Done',
    keysTitle: 'Keyboard shortcuts',
    keyPlay: 'Play / pause',
    keySeek5: 'Back / forward 5 s',
    keySeek10: 'Back / forward 10 s',
    keyVolume: 'Volume',
    keyMute: 'Mute',
    keyFullscreen: 'Full screen',
    keySwap: 'Swap views',
    keySpeed: 'Slower / faster',
    keyCaptions: 'Captions',
    keyTranscript: 'Transcript',
    keyBookmark: 'Bookmark this moment, or remove the bookmark here',
    keyTag: 'Tag the note or bookmark here (bookmarks this moment if there is none)',
    keyFlag: 'Didn\'t understand (visible to your instructor; asks first)',
    keySlide: 'Previous / next slide',
    keyCopyFrame: 'Copy picture',
    keyCopyCaptions: 'Copy text',
    keyZoom: 'Zoom in / out (main picture; or the mouse wheel over any picture, drag to move)',
    keyZoomReset: 'Whole picture again (or double-click)',
    keyLoop: 'Start loop here / end loop here (also in the settings menu, or right-click the progress bar)',
    keyLoopClear: 'End the loop',
    keyHelp: 'This list',
    moreMenu: 'Settings and more',
    cachesMeasuring: 'Analysis results on this device: measuring…',
    cachesSize: 'Analysis results on this device: {mb} MB ({n})',
    cachesUnknown: 'Analysis results on this device: unknown',
    cachesClear: 'Clear',
    cachesCleared: 'Cleared {n} results; they are made again when needed',
    cachesInfo: 'Slide chapters, silences and slide text found for each recording, so they are instant next time. Not your notes, tags or slide files. Unused results go after 60 days.',
    diagMenu: 'Copy diagnostics…',
    storageMenu: 'Storage and diagnostics',
    diagTitle: 'Diagnostics',
    diagInfo: 'For a bug report: versions, the state of each feature and recent warnings. Sign-in data is left out and web and email addresses are hidden; read it before you share it. This is exactly what will be copied:',
    diagCopy: 'Copy',
    diagCopied: 'Diagnostics copied',
    copyDiagnostics: 'Copy diagnostics',
    noticeReason: 'Reason: {why}',
    keyExport: 'Export notes and bookmarks, backup',
    exportNotes: 'Export notes and backup',
    exportMenu: 'Export…',
    exportInfo: 'Notes and bookmarks with their times and tags, as Markdown (for Obsidian and other notes apps). Each time links back to that moment. The video and its address are never included.',
    exportPictures: 'With the slide page shown at each note (as pictures in a zip)',
    exportPicturesNoPdf: 'Slide pictures need the slide PDF (Slides tab)',
    exportLecture: 'Export this recording',
    exportCourse: 'Export the whole course',
    exportCourseProgress: 'Reading {k} of {n}…',
    exportedLecture: 'Exported {n} notes and bookmarks ({p} slide pictures)',
    exportedCourse: 'Exported {n} recordings with notes',
    exportedNothing: 'No notes or bookmarks in this course yet',
    fullscreenPopout: 'Full screen is not available in the floating window. Make the window bigger, or go back to the page for full screen.',
    fullscreenBlocked: 'Fullscreen is not allowed by the site showing this recording. Open the recording in its own tab to use it.',
    exportedCoursePartial: 'Exported {n} recordings with notes. The notes of {m} could not be read: they are listed in "{file}" in the zip. Export again to include them.',
    exportCourseUnread: 'Could not read the notes of {n} recordings (signed out, or no connection?). Nothing was exported.',
    exportNotReadFile: 'Not exported',
    exportNotReadText: 'The notes of these recordings could not be read when the course was exported (signed out, or the connection failed). Export the course again to include them.',
    exportFailed: 'Export failed ({msg})',
    backupInfo: 'Tags, slide files and corrections, what you watched and your settings only exist in this browser. A backup file brings them to another browser (or back after clearing browser data).',
    backupPdfs: 'Include the PDF files (bigger file)',
    backupMake: 'Download backup',
    backupRestore: 'Restore from a backup…',
    backupMade: 'Backup saved ({n} items)',
    backupRestored: 'Restored {n} items. Reloading…',
    backupInvalid: 'This is not a Lite Player for Echo360 backup file',
    backupTooBig: 'This file is too large for a backup (at most {max} MB)',
    mdRecorded: 'Recorded {date}',
    mdOpen: 'Open in Echo360',
    mdNothing: 'No notes or bookmarks.',
    mdNoTime: '(no time)',
    mdFooter: 'Exported from Lite Player for Echo360 on {date}. Tags are your private local tags.',
    keyPopout: 'Floating window (keeps playing on top of other windows)',
    popout: 'Floating window',
    popoutHere: 'Playing in a floating window.',
    popoutBack: 'Back to this page',
    popoutFailed: 'Could not open a floating window ({msg})',
    listWatched: '{pct}% watched',
    listWatchedTitle: 'Watched {pct}% on this device',
    listLastAt: 'last at {time}',
    listLastAtTitle: 'last stopped at {time} (Echo360, any device)',
    lastStopped: 'You stopped here last time (Echo360)',
    loopStart: 'Loop start (drag)',
    loopEnd: 'Loop end (drag)',
    loopClear: 'End loop',
    loopFromHere: 'Start loop here',
    loopToHere: 'End loop here',
    loopMenu: 'Loop a section',
    loopNone: 'No loop',
    loopStartSet: 'Loop starts at {time}; press O at the end',
    loopSet: 'Looping {from}–{to}',
    loopCleared: 'Loop ended',
    loopOutside: 'Outside the loop {from}–{to}',
    keyEscape: 'Close menus',
    keysMenu: 'Keyboard shortcuts',
    reload: 'Reload',
    useOriginal: 'Switch to the original player',
    menuBack: 'Back',
    theme: 'Theme',
    themeSystem: 'Match system',
    themeDark: 'Dark',
    themeLight: 'Light',
    themeNote: 'The light theme changes the side panel, menus and dialogs. The picture and its controls stay dark.',
    language: 'Language',
    langAuto: 'Match browser',
    langNote: 'The page reloads to change the language; playback continues where it was.',
    // Punctuation used to join translated parts (Chinese uses full-width forms).
    sepSentence: '. ',
    sepLabel: ': ',
    sepList: ', ',
    kbdSpace: 'Space',
    appVersion: 'Lite Player for Echo360 {version}',
    noPictureYet: 'no picture yet',
    readerNoWebCodecs: 'This browser cannot read the video to follow the slides (it needs WebCodecs). You can still page through the PDF.',
    readerSaveData: 'Following the slides is off while the browser\'s Data Saver is on. You can still page through the PDF.',
    readerFailed: 'Following the slides stopped ({msg}). You can still page through the PDF.',
    // Feature names in featureFailed (diagnostics keep the English ids of FEATURE_NAMES).
    featurePlayer: 'the player',
    featureLoop: 'the A-B loop',
    featureDiscussion: 'the discussion',
    featurePopout: 'the floating window',
    featureAudio: 'the audio tools',
    featureCaptions: 'captions',
    featureNotesDiscussion: 'notes and discussion',
    featureSilence: 'silence detection',
    featureSlideChapters: 'slide chapters',
    featureEmptyCamera: 'the camera for an empty screen',
    featureUsage: 'usage data',
    featureSlideReader: 'the slide reader',
    featureNotes: 'notes',
    featureSession: 'session renewal',
    featureZoom: 'zoom',
    dryRunAll: 'Test mode: notes, posts and other changes are not sent to Echo360.',
    dryRunPublic: 'Test mode: posts, replies, likes and "didn\'t understand" marks are not sent to Echo360.',
    featureWatched: 'the watched parts',
    layoutPdfNote: 'With the PDF view open, the layout button switches between side by side and picture in picture.',
    captionsPage: 'Captions',
    silencePage: 'Skip silence',
    sizeS: 'Small',
    sizeM: 'Medium',
    sizeL: 'Large',
    sizeXL: 'Extra large',
    seconds: '{n} seconds',
    minute: '1 minute',
    minutes: '{n} minutes',
    playbackFailedTitle: 'Playback failed',
    playbackFailedText: 'The video could not be loaded: {detail}. You can retry or switch to the original player.',
    failMedia: 'the video data could not be read',
    failServer: 'the video server answered with error {code}',
    failMissing: 'the video file is not on the server ({code})',
    failRefused: 'the video server refused the request ({code})',
    failOffline: 'there is no network connection',
    failUnreachable: 'the video server could not be reached',
    netError: 'Echo360 could not be reached',
    offlineHint: 'No connection. Playback continues when you are back online.',
    notesLoadFailed: 'Could not load your notes ({error}).',
    discussionLoadFailed: 'Could not load the discussion ({error}).',
    transcriptLoadFailed: 'Could not load the transcript ({error}).',
    captionsLoadFailed: 'The transcript could not be loaded. You can try again in the Transcript tab.',
    retry: 'Retry',
    close: 'Close',
    errorNotice: 'Lite Player for Echo360 ran into an unexpected error and switched to the original player (with the CPU fix enabled).',
    loadingPlayer: 'Loading the player\u2026',
    loadingProgress: 'Loading the player: {done} KB of {total} KB',
    loadingSlow: 'The network is slow: {s} s so far. If the player has not loaded after {limit} s, the original player opens instead.',
    loadingUseOriginal: 'Use the original player now',
    loadingTipLabel: 'Tip',
    loadingTip1: 'Space plays and pauses. J and L jump 10 seconds, [ and ] change the speed.',
    loadingTip2: 'S swaps the two views. The layout button switches between side by side, picture in picture and one view.',
    loadingTip3: 'Add the lecturer\'s slide PDF in the Slides tab: it turns to the page being talked about. The file stays on this device.',
    loadingTip4: 'Chapters come from the slide changes. Shift with the arrow keys jumps between them.',
    loadingTip5: 'Long silences (breaks, group work) can be skipped automatically: Settings, Skip silence.',
    loadingTip6: 'Press ? for all the keyboard shortcuts.',
    fallbackNotice:'Lite Player for Echo360 could not take over this page, so the original player is being used (with the CPU fix enabled).',
  },
};

// The languages offered, each named in itself ("auto": the browser's).
const UI_LANGS = ['auto', 'en', 'zh'];
const LANG_NAMES = { en: 'English', zh: '\u4e2d\u6587' };

// The language of the interface, decided once per page (changing it reloads the page).
let uiLangCache = null;
function uiLang() {
  if (uiLangCache) return uiLangCache;
  const p = store.get('prefs', null);
  const chosen = p && typeof p === 'object' ? p.lang : null;
  let lang = chosen === 'en' || chosen === 'zh' ? chosen : null;
  if (!lang) {
    let nav = '';
    try { nav = String(navigator.language || ''); } catch (e) { /* no navigator */ }
    lang = /^zh\b/i.test(nav) ? 'zh' : 'en';
  }
  uiLangCache = STRINGS[lang] ? lang : 'en';
  return uiLangCache;
}

// The BCP 47 tag of the interface language (for lang attributes and Intl).
function uiLocale() {
  return uiLang() === 'zh' ? 'zh-CN' : 'en';
}

// English ids of the features (as in featureGuard / Disposer.feature) -> their names.
const FEATURE_NAMES = {
  player: 'featurePlayer', 'A-B loop': 'featureLoop', discussion: 'featureDiscussion', 'floating window': 'featurePopout',
  'audio tools': 'featureAudio', captions: 'featureCaptions', 'notes and discussion': 'featureNotesDiscussion',
  'silence detection': 'featureSilence', 'slide chapters': 'featureSlideChapters', 'camera for an empty screen': 'featureEmptyCamera', 'usage data': 'featureUsage', 'slide reader': 'featureSlideReader',
  notes: 'featureNotes', 'session renewal': 'featureSession', zoom: 'featureZoom', 'watched parts': 'featureWatched',
};
function featureName(id) {
  const k = FEATURE_NAMES[String(id).replace(/ \(display\)$/, '')];
  return k ? tr(k) : String(id);
}

function tr(key, vars) {
  const table = STRINGS[uiLang()];
  let s = (table && table[key]) || STRINGS.en[key] || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

// ---- 01-lang-zh.js ----
// ===================================================================================
// Chinese (simplified) strings, keyed as the English table in 01-i18n.js. The glossary and
// style rules are in dev/i18n/STRINGS-zh.md. This and the other language files are the
// only sources allowed to hold CJK text (build.mjs).
// ===================================================================================

STRINGS.zh = {
  back: '返回课程',
  seek: '播放位置',
  play: '播放',
  playKey: '播放（空格）',
  pause: '暂停',
  pauseKey: '暂停（空格）',
  rewind: '后退 10 秒',
  rewindKey: '后退 10 秒（J）',
  forward: '前进 10 秒',
  forwardKey: '前进 10 秒（L）',
  mute: '静音',
  muteKey: '静音（M）',
  unmute: '取消静音',
  unmuteKey: '取消静音（M）',
  volume: '音量',
  volumeLevel: '音量 {pct}%',
  muted: '已静音',
  swapViews: '交换画面',
  emptyScreenCamera: '屏幕没有画面，暂时只显示摄像机画面。',
  emptyScreenBack: '屏幕又有画面了，已恢复你的布局。',
  emptyScreenAuto: '屏幕没有画面时只显示摄像机',
  telemetryMenu: '使用数据',
  telemetrySend: '发送匿名使用数据',
  telemetryDesc: '播放器在这台电脑上运行得怎样、用了哪些功能、出过什么错误。不含姓名、录像和课程，也不含你写的任何内容。存放在 Cloudflare；只保存国家、地区和网络运营商，不保存 IP 地址。',
  telemetryView: '查看我的数据',
  telemetryDelete: '删除我的全部数据',
  telemetryReset: '重置 ID',
  telemetryDataTitle: '你的使用数据',
  telemetryLoading: '正在读取…',
  telemetryNone: '服务器上没有你的 ID 的数据。',
  telemetryFailed: '连不上服务器（{msg}），请稍后再试。',
  telemetryDownload: '下载 JSON',
  telemetryNoAnswer: '没有响应',
  telemetryRows: '{n} 条',
  telemetryRow: '1 条',
  telemetryKindEnv: '电脑和浏览器',
  telemetryKindSession: '观看记录',
  telemetryKindError: '错误',
  telemetryKindFallback: '切回原播放器',
  telemetryKindRegistration: '注册（每个 ID 一次）',
  telemetryDeleteTitle: '删除你的全部使用数据？',
  telemetryDeleteText: '用你的 ID 发送过的数据会立即从服务器删除，无法恢复。之后仍会继续发送，除非你同时关掉发送。',
  telemetryDeleteConfirm: '删除',
  telemetryDeleted: '已从服务器删除 {n} 条记录。',
  telemetryResetTitle: '重置 ID？',
  telemetryResetText: '之后使用新的 ID。用旧 ID 发送过的数据将无法再在这里查看或删除。',
  telemetryResetDelete: '先删除我的数据，再重置',
  telemetryResetOnly: '只重置',
  telemetryResetDone: '已使用新的 ID。',
  emptyScreenAutoDesc: '屏幕长时间没有画面时只显示摄像机画面。在一个录像里自己选过布局后，这个录像不再自动切换。',
  swapViewsKey: '交换画面（S）',
  layout: '布局',
  layoutNow: '布局：{layout}',
  layoutToSide: '切换到并排',
  layoutToPip: '切换到画中画',
  layoutToSingle: '切换到单画面',
  layoutSide: '并排',
  layoutPip: '画中画',
  layoutSingle: '单画面',
  resizeViews: '拖动调整两个画面的大小',
  pipHint: '拖动可移动，点击交换画面',
  resizePip: '拖动调整大小',
  secondViewLost: '第二个画面加载失败，已隐藏。',
  captions: '字幕',
  captionsKey: '字幕（C）',
  captionsLoading: '字幕加载中',
  captionsNone: '这个录像没有字幕',
  showCaptions: '显示字幕',
  hideCaptionsPaused: '暂停时隐藏',
  copyFrame: '复制画面',
  copyFrameKey: '复制画面（P）',
  copyCaptions: '复制文字',
  copyCaptionsKey: '复制文字（A）',
  copyCaptionsSpan: '“复制文字”的时长',
  copyCaptionsSpanDesc: '“复制文字”复制刚才讲的内容（整句），附带课名和时间。',
  copySpanValue: '最近 {time}',
  copiedFrame: '已复制画面（{w} × {h}）',
  copiedPage: '已把 {file} 第 {n} 页复制为图片',
  copiedCaptions: '已复制转录 {from}–{to}',
  copyFailed: '复制失败（{msg}）',
  copyNoCaptions: '这个录像没有可复制的转录。',
  pausedHint: '已暂停',
  captionSize: '字号',
  on: '开',
  off: '关',
  transcript: '转录',
  transcriptKey: '转录（T）',
  closePanel: '关闭',
  resizePanel: '拖动调整宽度',
  searchTranscript: '搜索转录',
  prevMatch: '上一个（Shift+Enter）',
  nextMatch: '下一个（Enter）',
  searchCount: '找到 {n} 处',
  searchPos: '{i} / {n}',
  backToCurrent: '回到当前位置',
  notes: '笔记',
  discussion: '讨论',
  sidebarTabs: '侧栏',
  addNotePlaceholder: '在 {time} 写一条私人笔记',
  addNote: '添加笔记',
  notesPrivate: '笔记和书签只有你自己能看到。老师能看到你的“没听懂”标记。标签只有你能看到，只存在本设备上。',
  filterAll: '全部',
  filterNotes: '笔记',
  filterBookmarks: '书签',
  filterFlags: '没听懂',
  noNotes: '还没有内容。可以写笔记、加书签（B），或标记没听懂的地方（U）。',
  bookmark: '书签',
  bookmarkKey: '给这里加书签（B）',
  bookmarkedAt: '已在 {time} 加书签',
  removeBookmark: '删除书签',
  removeBookmarkKey: '删除这里的书签（B）',
  bookmarkRemoved: '已删除 {time} 的书签',
  showFile: '显示 {name}',
  pdfFileNext: '{name}：切换到 {next}',
  undo: '撤销',
  flag: '没听懂',
  flagRemoveLabel: '取消 {time} 的“没听懂”',
  flagVisible: '老师可见',
  flagConfirm: '把 {time} 标记为没听懂？老师会看到。',
  flagConfirmAction: '标记',
  flagConfirmButton: '确认：向老师标记 {time}',
  flagAdded: '已把 {time} 标记为没听懂',
  flagRemoved: '已取消 {time} 的标记',
  edit: '编辑',
  save: '保存',
  cancel: '取消',
  delete: '删除',
  confirmDelete: '确定删除？',
  remove: '移除',
  saveFailed: '保存失败：{error}',
  loadFailed: '加载失败：{error}',
  publicWarning: '帖子和回复，老师和同学都能看到。',
  postPlaceholder: '对这节课提问或发表评论',
  linkTime: '关联到 {time}',
  hideName: '隐藏我的名字',
  postPublic: '发布',
  replyPublic: '回复',
  replyPlaceholder: '写回复',
  replies: '{n} 条回复',
  oneReply: '1 条回复',
  hideReplies: '收起回复',
  like: '赞',
  unlike: '取消赞',
  savePost: '收藏（只有你能看到）',
  unsavePost: '取消收藏',
  anonymous: '匿名',
  you: '你',
  youAnonymous: '你（匿名）',
  instructor: '老师',
  ta: '助教',
  noPosts: '还没有帖子。',
  hiddenPosts: '老师隐藏了 {n} 个帖子。',
  attachment: '有附件',
  attachmentOpen: '有附件：切换到原播放器才能打开',
  refresh: '刷新',
  sortNewest: '最新的在前',
  sortVideoTime: '按视频时间',
  charsLeft: '还能输入 {n} 字',
  tooLong: '超出 {n} 字',
  extrasNotice: '这个录像有{what}，只有原播放器能显示。',
  extraPolls: '投票',
  extraSlides: '幻灯片',
  extraAudioDescription: '口述影像音轨',
  markerNote: '笔记',
  markerBookmark: '书签',
  markerFlag: '没听懂',
  markerComment: '帖子',
  audio: '音频',
  audioLevel: '音量均衡',
  audioLevelDesc: '把小声的讲话调大，把大声的部分压住。适合老师没戴麦克风的录像。',
  audioVoice: '人声增强',
  audioVoiceDesc: '去掉空调和风扇的低频嗡嗡声，让讲话更清楚。',
  audioMono: '单声道',
  audioMonoDesc: '两个声道合并到两侧播放（适合声音只在一边的录像）。',
  quality: '画质',
  qualityAuto: '自动',
  qualityAutoBest: '自动（网络允许的最高画质）',
  qualityScreen: '屏幕',
  qualityCamera: '摄像机',
  qualityNow: '正在播放 {q}',
  slides: '幻灯片',
  slideN: '幻灯片 {n}',
  slidesFinding: '正在查找幻灯片切换：{pct}%',
  slidesRough: '时间是根据预览图估计的。正在查找准确的切换位置：{pct}%',
  slidesFromPreview: '共 {n} 张幻灯片，根据 Echo360 的预览图（约每分钟一张）推测，时间是大概的。',
  slidesPreviewFinding: '正在根据 Echo360 的预览图推测幻灯片切换…',
  slidesFound: '从屏幕画面中自动找到 {n} 张幻灯片。',
  slidesNone: '没有在这个录像里自动找到幻灯片切换。',
  slidesSaveData: '浏览器开着省流量模式，不查找幻灯片章节。',
  screenView: '屏幕画面：',
  viewN: '画面 {n}',
  screenUse: '在画面 {n} 里找幻灯片',
  screenFound: '自动找到',
  screenGuessed: '推测：如果幻灯片不对，请选另一个画面',
  screenChosen: '你选的',
  screenAuto: '自动',
  addSlides: '添加幻灯片 PDF…',
  addMoreSlides: '再添加一个 PDF…',
  slidesLocal: '添加老师的幻灯片 PDF，可以跟着讲课翻页：讲到哪一页就显示哪一页。文件只存在本设备上。',
  removeFile: '移除 {name}',
  deckLoading: '正在打开幻灯片文件…',
  deckReading: '正在识别屏幕上的幻灯片：{pct}%',
  deckWaiting: '正在查找屏幕画面…',
  deckLangLoading: '正在下载{lang}文字识别数据（{mb} MB，只需一次）…',
  deckError: '无法读取幻灯片文件（{msg}）。',
  deckTooBig: '{name} 太大，不能作为幻灯片文件（最多 {max} MB）。',
  deckCapped: '只用前 {n} 页跟随讲课。',
  deckRemoveFailed: '无法从本设备移除 {name}（{msg}），它仍然保留着。',
  deckSaveFailed: '无法把 {name} 存到本设备（{msg}）。磁盘满了吗？',
  prevPage: '上一页',
  nextPage: '下一页',
  pageOfN: '第 {n} 页，共 {total} 页',
  following: '正在跟随讲课',
  followingUnsure: '正在跟随讲课（这里没认出页码，显示上一次找到的页）',
  followingStale: '正在跟随讲课：已经有一段时间没认出当前页',
  pageNotRecognised: '没认出当前页',
  followingShort: '跟随中',
  followingUnsureShort: '跟随中（上一次找到的页）',
  followingStaleShort: '没认出页码',
  backToLectureShort: '回到讲课位置',
  pdfMainOpen: '在视频旁边显示 PDF',
  pdfMainClose: '关闭 PDF 视图',
  pdfSwap: '交换 PDF 和视频',
  backToLecture: '回到正在讲的那一页',
  shownAt: '出现在',
  notFoundInRecording: '录像里没有找到。',
  wrongPage: '页码不对？',
  useThisPage: '现在这一段改为显示第 {n} 页',
  markNotSlide: '现在这一段不是幻灯片',
  undoCorrection: '撤销我在这里的更正',
  showChapters: '显示 {n} 个章节',
  hideChapters: '隐藏章节',
  dropSlides: '把幻灯片 PDF 拖到这里。文件只存在本设备上。',
  dropNotPdf: '只能添加 PDF 文件作为幻灯片。',
  silence: '无声段',
  silenceAuto: '自动跳过无声段',
  silenceAutoDesc: '跳过较长的停顿（课间休息、小组讨论）。关闭时会出现一个按钮，由你决定是否跳过。',
  silenceMin: '无声段最短时长',
  silenceSensitivity: '灵敏度',
  low: '低',
  normal: '中',
  high: '高',
  silenceFromTranscript: '根据转录：{n} 处无声段，共 {time}。',
  silenceFound: '{n} 处无声段，共 {time}。',
  silenceNone: '没有 {min} 或更长的无声段。',
  silenceAnalysing: '正在分析音频：已完成 {pct}%。',
  silenceWaiting: '正在查找无声段…',
  silenceUnavailable: '这个录像不能检测无声段。',
  silenceSaveData: '开着省流量模式时不检测无声段。',
  silenceTip: '无声段，{time}',
  blankTip: '黑屏且无声，{time}',
  blackTip: '黑屏，{time}',
  skipBlank: '跳过空白部分（{time}）',
  skippedBlank: '已跳过 {time} 黑屏和无声段',
  contentEnded: '这节课已经讲完（后面是黑屏和无声）。',
  contentEndSkip: '跳到结尾',
  contentEndStop: '停在这里',
  skipSilence: '跳过无声段（{time}）',
  skippedSilence: '已跳过 {time} 无声段',
  audioNoWebAudio: '这个浏览器不支持音频处理。',
  audioNativeHls: '音频处理需要 Media Source Extensions，这个浏览器播放这个视频时没有使用它。',
  speed: '播放速度',
  speedKey: '播放速度（[ 和 ]）',
  speedNow: '播放速度：{rate}',
  fullscreen: '全屏',
  fullscreenKey: '全屏（F）',
  exitFullscreen: '退出全屏',
  exitFullscreenKey: '退出全屏（F）',
  resumedAt: '已从 {time} 继续',
  startOver: '从头开始',
  authExpiredTitle: '播放权限已过期',
  authExpiredText: 'Echo360 的视频访问权限已过期，无法续期。刷新页面后会从当前位置继续。',
  authLoginExpiredText: '你的 Echo360 登录已过期。刷新页面重新登录，播放会从当前位置继续。',
  sessionRenewing: '正在续期播放权限…',
  featureFailed: '{name}出错了，暂时关闭。播放不受影响。',
  tagExam: '考试',
  tagAssignment: '作业',
  tagConfused: '没懂',
  tagsPrivate: '标签只有你能看到：只存在本设备上，不会发送给 Echo360。同一门课程的所有录像共用这些标签。',
  tagsFor: '标签',
  newTag: '新建标签…',
  addTag: '添加标签',
  addTagShort: '+ 标签',
  tagColor: '更改颜色',
  tagName: '标签名',
  manageTags: '管理标签…',
  filterTags: '按标签筛选',
  allTags: '全部标签',
  untagged: '无标签',
  done: '完成',
  keysTitle: '快捷键',
  keyPlay: '播放 / 暂停',
  keySeek5: '后退 / 前进 5 秒',
  keySeek10: '后退 / 前进 10 秒',
  keyVolume: '音量',
  keyMute: '静音',
  keyFullscreen: '全屏',
  keySwap: '交换画面',
  keySpeed: '减速 / 加速',
  keyCaptions: '字幕',
  keyTranscript: '转录',
  keyBookmark: '给此刻加书签，或删除这里的书签',
  keyTag: '给这里的笔记或书签加标签（没有的话先加书签）',
  keyFlag: '没听懂（老师可见；会先确认）',
  keySlide: '上一张 / 下一张幻灯片',
  keyCopyFrame: '复制画面',
  keyCopyCaptions: '复制文字',
  keyZoom: '放大 / 缩小（主画面；也可以在任一画面上滚动滚轮，拖动可移动）',
  keyZoomReset: '恢复完整画面（或双击）',
  keyLoop: '从这里开始循环 / 在这里结束循环（也可以用设置菜单，或右键点进度条）',
  keyLoopClear: '结束循环',
  keyHelp: '这个列表',
  moreMenu: '设置和更多',
  cachesMeasuring: '本设备上的分析结果：正在计算…',
  cachesSize: '本设备上的分析结果：{mb} MB（{n} 个）',
  cachesUnknown: '本设备上的分析结果：未知',
  cachesClear: '清除',
  cachesCleared: '已清除 {n} 个结果，需要时会重新生成',
  cachesInfo: '每个录像的幻灯片章节、无声段和幻灯片文字，存下来下次就能直接用。不包括你的笔记、标签和幻灯片文件。60 天没用的会自动删除。',
  diagMenu: '复制诊断信息…',
  storageMenu: '存储和诊断',
  diagTitle: '诊断信息',
  diagInfo: '用于报告问题：版本、各功能的状态和最近的警告。不含登录信息，网址和邮箱地址已隐去；分享前请先看一遍。下面就是会被复制的全部内容：',
  diagCopy: '复制',
  diagCopied: '已复制诊断信息',
  copyDiagnostics: '复制诊断信息',
  noticeReason: '原因：{why}',
  keyExport: '导出笔记和书签、备份',
  exportNotes: '导出笔记和备份',
  exportMenu: '导出…',
  exportInfo: '把笔记和书签（带时间和标签）导出为 Markdown（可用于 Obsidian 等笔记软件）。每个时间都能链接回录像里的那一刻。不会包含视频和视频地址。',
  exportPictures: '附上每条笔记时显示的幻灯片页（图片，打包成 zip）',
  exportPicturesNoPdf: '幻灯片图片需要幻灯片 PDF（在“幻灯片”页添加）',
  exportLecture: '导出这个录像',
  exportCourse: '导出整门课程',
  exportCourseProgress: '正在读取第 {k} 个，共 {n} 个…',
  exportedLecture: '已导出 {n} 条笔记和书签（{p} 张幻灯片图片）',
  exportedCourse: '已导出 {n} 个有笔记的录像',
  exportedNothing: '这门课程还没有笔记或书签',
  fullscreenPopout: '悬浮窗里不能全屏。可以把悬浮窗拉大，或回到页面再全屏。',
  fullscreenBlocked: '嵌入这个录像的网站不允许全屏。在单独的标签页里打开录像就可以全屏。',
  exportedCoursePartial: '已导出 {n} 个有笔记的录像。有 {m} 个录像的笔记没能读取，列在 zip 里的“{file}”中。再导出一次可以补上。',
  exportCourseUnread: '没能读取 {n} 个录像的笔记（登录过期，或者没有网络？），没有导出任何内容。',
  exportNotReadFile: '未导出',
  exportNotReadText: '导出课程时，这些录像的笔记没能读取（登录过期，或者网络出错）。再导出一次课程可以补上。',
  exportFailed: '导出失败（{msg}）',
  backupInfo: '标签、幻灯片文件和更正、观看记录和设置只存在这个浏览器里。备份文件可以把它们带到另一个浏览器（或在清除浏览器数据后恢复）。',
  backupPdfs: '包含 PDF 文件（文件更大）',
  backupMake: '下载备份',
  backupRestore: '从备份恢复…',
  backupMade: '已保存备份（{n} 项）',
  backupRestored: '已恢复 {n} 项，正在刷新…',
  backupInvalid: '这不是 Echo360 轻量播放器的备份文件',
  backupTooBig: '这个文件太大，不能作为备份文件（最多 {max} MB）',
  mdRecorded: '录制于 {date}',
  mdOpen: '在 Echo360 中打开',
  mdNothing: '没有笔记或书签。',
  mdNoTime: '（无时间）',
  mdFooter: '{date} 从 Echo360 轻量播放器导出。标签是你在本地的私人标签。',
  keyPopout: '悬浮窗（在其他窗口上方继续播放）',
  popout: '悬浮窗',
  popoutHere: '正在悬浮窗中播放。',
  popoutBack: '回到这个页面',
  popoutFailed: '无法打开悬浮窗（{msg}）',
  listWatched: '已看 {pct}%',
  listWatchedTitle: '在本设备上看了 {pct}%',
  listLastAt: '上次停在 {time}',
  listLastAtTitle: '上次停在 {time}（Echo360，任意设备）',
  lastStopped: '你上次停在这里（Echo360）',
  loopStart: '循环起点（可拖动）',
  loopEnd: '循环终点（可拖动）',
  loopClear: '结束循环',
  loopFromHere: '从这里开始循环',
  loopToHere: '在这里结束循环',
  loopMenu: '循环播放一段',
  loopNone: '未循环',
  loopStartSet: '循环从 {time} 开始；到终点时按 O',
  loopSet: '正在循环 {from}–{to}',
  loopCleared: '已结束循环',
  loopOutside: '在循环 {from}–{to} 之外',
  keyEscape: '关闭菜单',
  keysMenu: '快捷键',
  reload: '刷新',
  useOriginal: '切换到原播放器',
  menuBack: '返回',
  theme: '主题',
  themeSystem: '跟随系统',
  themeDark: '深色',
  themeLight: '浅色',
  themeNote: '浅色主题只改变侧栏、菜单和对话框，画面和画面上的控件保持深色。',
  language: '语言',
  langAuto: '跟随浏览器',
  langNote: '切换语言后页面会重新加载，播放从原来的位置继续。',
  sepSentence: '。',
  sepLabel: '：',
  sepList: '、',
  kbdSpace: '空格',
  appVersion: 'Echo360 轻量播放器 {version}',
  noPictureYet: '还没有画面',
  readerNoWebCodecs: '这个浏览器不能读取视频，所以 PDF 不能自动翻页（需要 WebCodecs）。仍可手动翻页。',
  readerSaveData: '浏览器开着省流量模式，PDF 自动翻页已关闭。仍可手动翻页。',
  readerFailed: 'PDF 自动翻页停止了（{msg}）。仍可手动翻页。',
  featurePlayer: '播放器',
  featureLoop: 'A-B 循环',
  featureDiscussion: '讨论',
  featurePopout: '悬浮窗',
  featureAudio: '音频处理',
  featureCaptions: '字幕',
  featureNotesDiscussion: '笔记和讨论',
  featureSilence: '无声段检测',
  featureSlideChapters: '幻灯片章节',
  featureEmptyCamera: '屏幕无画面时显示摄像机',
  featureUsage: '使用数据',
  featureSlideReader: 'PDF 自动翻页',
  featureNotes: '笔记',
  featureSession: '播放权限续期',
  featureZoom: '缩放',
  dryRunAll: '测试模式：笔记、帖子等改动不会发送到 Echo360。',
  dryRunPublic: '测试模式：帖子、回复、点赞和“没听懂”不会发送到 Echo360。',
  featureWatched: '已看部分',
  layoutPdfNote: '打开 PDF 视图时，布局按钮在并排和画中画之间切换。',
  captionsPage: '字幕',
  silencePage: '跳过无声段',
  sizeS: '小',
  sizeM: '中',
  sizeL: '大',
  sizeXL: '特大',
  seconds: '{n} 秒',
  minute: '1 分钟',
  minutes: '{n} 分钟',
  playbackFailedTitle: '播放失败',
  playbackFailedText: '视频无法加载：{detail}。可以重试，或切换到原播放器。',
  failMedia: '视频数据无法读取',
  failServer: '视频服务器返回错误 {code}',
  failMissing: '服务器上没有这个视频文件（{code}）',
  failRefused: '视频服务器拒绝了请求（{code}）',
  failOffline: '没有网络连接',
  failUnreachable: '连不上视频服务器',
  netError: '连不上 Echo360',
  offlineHint: '网络已断开，恢复后会自动继续播放。',
  notesLoadFailed: '无法加载你的笔记（{error}）。',
  discussionLoadFailed: '无法加载讨论（{error}）。',
  transcriptLoadFailed: '无法加载转录（{error}）。',
  captionsLoadFailed: '转录没能加载，可以在“转录”标签页重试。',
  retry: '重试',
  close: '关闭',
  errorNotice: 'Echo360 轻量播放器遇到意外错误，已切换到原播放器（并开启了降低 CPU 占用的补丁）。',
  loadingPlayer: '正在加载播放器…',
  loadingProgress: '正在加载播放器：{done} KB / {total} KB',
  loadingSlow: '网络较慢，已等 {s} 秒。{limit} 秒内加载不完会自动打开原播放器。',
  loadingUseOriginal: '现在就用原播放器',
  loadingTipLabel: '小提示',
  loadingTip1: '空格播放和暂停，J 和 L 前后跳 10 秒，[ 和 ] 调整播放速度。',
  loadingTip2: 'S 交换两个画面。布局按钮在并排、画中画和单画面之间切换。',
  loadingTip3: '在“幻灯片”标签页添加老师的幻灯片 PDF，会自动翻到正在讲的那一页。文件只存在本设备上。',
  loadingTip4: '章节按幻灯片切换自动生成，Shift + 方向键在章节之间跳转。',
  loadingTip5: '长时间的无声段（课间休息、小组讨论）可以自动跳过：设置 → 跳过无声段。',
  loadingTip6: '按 ? 查看全部快捷键。',
  fallbackNotice: 'Echo360 轻量播放器无法接管这个页面，正在使用原播放器（并开启了降低 CPU 占用的补丁）。',
};

// ---- 02-tuning.js ----
// ===================================================================================
// Tuning: every number that sets how the analyses, playback and background work behave, in
// one place, with its unit, what it does and why it holds beyond the recordings it was
// checked on. Values that depend on the recording are not here: they are learnt from it
// (the chapter threshold, the silence threshold, the slide evidence model, the language
// of the slides). Product choices without a "right" value (speeds offered, caption sizes,
// tag colours) stay with their feature.
//
// Checked on: ELEC2134 (3 h, slides in a browser PDF viewer, circuit drawings), COMP2511
// (2 h, slides, code editor, video calls, black screen at the end), COMP1521 (2 h, slides
// and terminal), MATH1081 (2 h, printed notes under a camera with handwriting). The
// labelled ones are replayed by the unit tests (test/fixtures).
// ===================================================================================

// ---- background work (61-media-io.js BackgroundGate) ----
// Background downloads wait until playback has this much buffered ahead: two thirds of what
// the player itself keeps (STREAM_MAX_BUFFER_SEC), so they never take bandwidth playback
// is waiting for. Pauses between steps are in milliseconds, [while playing, while paused].
const BG_MIN_BUFFER_SEC = 20;
const BG_START_DELAY_MS = 5000;        // before an analysis starts its downloads: playback starts first

// ---- slide chapters (64-slides.js) ----
// Seconds between the keyframes compared. Echo360's segments are 10 s long, so this reads
// every keyframe there; with shorter segments the cost stays one keyframe per this many
// seconds, with longer ones every keyframe is read. A resolution choice: refinement pins
// each change to about a second anyway.
const CHAPTER_STEP_SEC = 10;
const CHAPTER_PACE_MS = [300, 120];    // between keyframes (about 20 KB each)
const CHAPTER_REFINE_PACE_MS = [1000, 300];   // between refinements (a whole segment each)
// Most samples one media fragment may list. A 10 s segment at 60 fps has 600; a server
// that claims more is refused before anything is allocated for it (a safety bound, not
// a measurement: ten times a minute of 60 fps video in one fragment).
const MP4_MAX_SAMPLES = 36000;
// Longest recording a media playlist may describe. Its length sizes what the analyses keep
// per recording (the silence envelope: one byte per 0.1 s), so a broken playlist claiming
// years is refused rather than believed. A safety bound, not a measurement: lectures run
// up to about 4 h, a whole-day capture 12 h; this is twice that.
const MEDIA_MAX_SEC = 24 * 3600;
// Frames are compared as brightness pictures this size: one pixel is a 2 x 2 block at
// 360p, 8 x 8 at 720p, so a changed line of slide text changes several pixels.
const THUMB_W = 160;
const THUMB_H = 90;
// A pixel has changed if its brightness moved by more than this (0-255). Re-encoding the
// same picture moves a pixel by a few levels; a letter of slide text drawn or removed by
// far more (dark on light or light on dark both differ by over 100). Sits well between.
const PIXEL_DIFF = 24;
// Fewer changed pixels than a short word of the smallest readable slide text covers (about
// 3 x 6 at 160 x 90) is the same picture: a mouse pointer, a blinking caret, the clock in a
// menu bar change fewer. Above it, how many changed pixels make a new picture is learnt
// per recording (learnThreshold).
const SAME_TEXT_MAX = 12;
// An (almost) one-coloured picture (black screen, "no signal", a blank slide): nearly every
// 5 x 5 block of the brightness picture within compression noise of the median. A small
// logo or a cursor may differ.
const UNIFORM_NOISE = 10;              // brightness levels of compression noise in a block mean
const UNIFORM_SHARE = 0.985;           // blocks that must be that close
// Which view is the screen (findScreen): the chosen view's values beat another view's in at
// least this share of pairs (a probability of superiority; 0.5 would be a coin toss) for
// the choice to count as clear. Not clear is not a failure: the most likely view is used
// and the user can choose another.
const SCREEN_CLEARLY = 0.75;
const SCREEN_PROBES = 6;               // keyframe pairs (or preview pictures) compared per view, spread over the recording
// Brightness levels a pixel of a still picture moves when it is encoded again (measured:
// 94-100% of a still screen's pixels within 2 between keyframes 10 s apart).
const STILL_LEVELS = 2;
const FLAT_LEVELS = 3;                 // brightness (sum of R, G, B) within which neighbours are "equal" (compression noise)
const CHAPTER_THUMB_W = 192;           // width of chapter pictures (the list shows them at about 96 CSS px)
// Segments (or chunks) in a row that cannot be read before an analysis stops (one is
// skipped: a dropped request or a damaged segment; several in a row is the network gone).
const ANALYSIS_MAX_FAILS = 5;

// ---- reading the screen (66-slide-ocr.js) ----
// Text recognition reads the smallest rendition at least this tall (or the tallest):
// slide text in 360p is not readable, 720p reads body text of slides shown full screen.
const OCR_HEIGHT = 720;
const OCR_PACE_MS = [200, 0];          // between samples; while playing a reading also rests as long as it took
const OCR_SAVE_EVERY = 10;             // readings between cache writes

// ---- which slide is on screen (67-slide-text.js) ----
// The evidence model (scoreModel) is fitted to each lecture. These only set its numerics:
// the grid its log-likelihood ratios are tabulated on (scores are 0-1, so a step of 0.01),
// the smallest spread a fitted distribution may have (one grid step, so a distribution is
// never narrower than the grid can show), the floor of a log-likelihood ratio (a page
// that cannot be right gets this instead of minus infinity, so that a forced correction
// can still choose it) and the most EM rounds (it converges in a few dozen).
const EVIDENCE_GRID = 101;
const EVIDENCE_MIN_SD = 1 / (EVIDENCE_GRID - 1);
const EVIDENCE_FLOOR = -25;
const EVIDENCE_EM_ROUNDS = 200;
// The share of right pictures the fitted "right" distribution does not describe: a slide
// mostly made of a photo or a screenshot (OCR noise, words the PDF does not have), a page
// with a few words. Lectures of clean slides fit a very narrow "right" distribution; without
// this, such a page reads as further from it than from a wrong page and is taken for "not
// a slide" (COMP1521 2026-06-01: two such pages, 70 s). Chosen on the labelled lectures and
// COMP1521 (PROGRESS.md, 2026-10-15): the same results from 0.02 to 0.1.
const EVIDENCE_OUTLIER = 0.05;
// How lecturers move through slides: prior chances for the sequence model, per step from
// one picture to the next different one (so independent of how often the screen is
// sampled). They describe lecturing, not a course: mostly staying or moving on,
// sometimes going back, rarely jumping or changing file. The evidence from the text on
// screen outweighs them wherever it is clear; they decide only where the screen says
// little (a page without text, a blurry camera picture).
const SLIDE_MOVES = {
  stay: Math.log(0.45),      // same page (ink, pointer, a build step)
  next: Math.log(0.30),      // next page
  back: Math.log(0.05),      // previous page
  jump: Math.log(0.04),      // any other page of the same file (spread over the file)
  file: Math.log(0.01),      // a page of another file (spread over that file)
  off: Math.log(0.15),       // something that is not a slide
  offStay: Math.log(0.60),   // still not a slide
  offBack: Math.log(0.20),   // back to the page shown before
  offNext: Math.log(0.10),   // back to the slides, one page on
  offJump: Math.log(0.07),   // back to the slides at another page of the same file
  offFile: Math.log(0.03),   // back to the slides in another file
};

// ---- following the slides (68-slide-deck.js) ----
// A look at another page shorter than this (one sample) between two stretches of the same
// page does not turn the page.
const FOLLOW_MIN_SEC = 1.5 * CHAPTER_STEP_SEC;
const FOLLOW_STALE_SEC = 120;          // after this long without a recognised page, the reader says so (a product choice)
const FOLLOW_UPDATE_MS = 15000;        // while reading, pages are decided again at most this often (each run takes 0.1-1 s)
// "Copy picture" on the PDF view: the page drawn this wide (a full HD screen's width:
// sharp when pasted into notes, a few hundred KB as PNG).
const PDF_COPY_WIDTH = 1920;
const DECK_RENDER_BUDGET = 40e6;       // rendered pages kept, in pixels (about 160 MB at 4 bytes a pixel)
// One rendered page at most: a page far taller or wider than a slide (a poster, a long
// scroll) is drawn smaller rather than as one huge canvas. 8192 px is within every
// browser's canvas limit; 16 M pixels is 64 MB, two 4096-wide 16:9 pages.
const PAGE_RENDER_MAX_SIDE = 8192;
// PDFs added to a recording: a lecture's slides are a few hundred pages and tens of MB at
// most, a page's text a few thousand characters. Past these a file is refused or reading
// stops, so a crafted file (a small PDF can declare a huge number of pages) cannot hold the
// matcher (time and memory grow with pages x pictures) or the page.
const DECK_MAX_FILE_BYTES = 300 * 1024 * 1024; // one file
const DECK_MAX_PAGES = 3000;                    // all files of a recording together
const DECK_MAX_PAGE_CHARS = 20000;              // text read from one page
const PAGE_RENDER_MAX_PX = 16e6;
const PAGE_TITLE_TOP = 0.4;            // a page's title is the largest text in this top share of the page
const PAGE_AR_DEFAULT = 9 / 16;        // height / width of a page not opened yet (slides are mostly 16:9)

// ---- silence (62-silence.js) ----
// Speech recognisers and loudness measures need nothing above 8 kHz: 16 kHz holds it.
const AUDIO_RATE = 16000;
const CHUNK_SEC = 60;                  // audio per request and decode (whole segments, about 350 KB)
const ENV_STEP = 0.1;                  // envelope resolution in seconds
const SPEECH_BAND_HZ = [150, 4000];    // the band of speech: rumble (air conditioning, projector fans) and hiss count as quiet
// The silence threshold is learnt per recording: a point between its noise floor and its
// speech level, taken as these percentiles of its levels (a lecture is mostly speech with
// pauses, so the 10th percentile is a pause and the 90th speech, whatever the volume).
const SILENCE_NOISE_PCT = 0.1;
const SILENCE_SPEECH_PCT = 0.9;
const SILENCE_SENSITIVITY = { low: 0.2, normal: 0.3, high: 0.4 };   // where between the two (user setting)
// With less than this between noise and speech (dB) there is no speech to tell apart: a
// muted microphone if it is all quieter than SILENCE_MUTED_DB, else nothing is silent.
const SILENCE_MIN_RANGE_DB = 6;
const SILENCE_MUTED_DB = -55;
const SILENCE_PAD = 0.5;               // seconds kept at each edge so skipping never clips speech
const SILENCE_BRIDGE = 1.5;            // a louder blip shorter than this (s) inside a pause stays silent
const SILENCE_MIN_CHOICES = [15, 30, 60, 120];   // shortest silence offered for skipping (s, user setting)
const SILENCE_START_DELAY_MS = 8000;   // before the first audio download: playback starts first
const SILENCE_PACE_MS = [2000, 400];   // between chunks (about 350 KB each)

// ---- audio processing (60-audio.js) ----
// Standard voice processing, set by ear on lecture recordings and checked by measurement:
// a recording 20 dB too quiet comes out at about -20 dBFS RMS without clipping, normal
// recordings are nearly unchanged, input above full scale is held about 4 dB below it.
const LEVEL_TARGET_DB = -20;           // target short-term RMS after levelling
const LEVEL_MAX_GAIN_DB = 18;          // never boost more than this
const LEVEL_TICK_MS = 500;             // how often the levelling gain is adjusted
const LEVEL_STEP_DB = [-1.5, 0.75];    // largest change per tick: down faster than up (no pumping)
const LEVEL_SMOOTHING = 0.85;          // weight of the past in the level average (about 3 s)
const LEVEL_SILENT_POW = 1e-8;         // below this mean power (-80 dBFS) the gain is left alone
const LIMIT_THRESHOLD_DB = -6;
const LIMIT_TRIM_DB = -3;              // offsets the compressor's built-in makeup gain
const VOICE_FILTERS = {
  highpassHz: 100, highpassQ: 0.7,     // below the voice: hum and handling noise
  presenceHz: 3000, presenceQ: 0.9, presenceDb: 4,   // consonants, for intelligibility
};
const LEVELLER = { threshold: -34, knee: 12, ratio: 3.5, attack: 0.02, release: 0.4 };
const LIMITER = { knee: 0, ratio: 20, attack: 0.001, release: 0.1 };

// ---- playback (35-stream.js, 38-sync.js, 40-player.js) ----
// Bandwidth assumed before hls.js has measured any: what the browser reports, else a
// broadband guess (the first segments of the top rendition are then fetched; hls.js steps
// down after a few seconds if that was too optimistic).
const STREAM_START_BPS = () => {
  const c = typeof navigator !== 'undefined' && navigator.connection;
  return c && c.downlink > 0 ? c.downlink * 1e6 : 5e6;
};
const STREAM_MAX_BUFFER_SEC = 30;      // ahead of the playhead (hls.js default)
// The most hls.js may buffer ahead. It buffers until maxBufferSize (60 MB) at the bitrate a
// playlist declares, and Echo360 declares far less than its streams use (29 kbps for 117,
// measured 2026-10-15 on six lectures): without this, its own cap of 600 s, so ten minutes of
// each view downloaded at the start and after every jump, and the browser's SourceBuffer
// limit reached (bufferFullError). Twice STREAM_MAX_BUFFER_SEC: room for a slow patch.
const STREAM_MAX_AHEAD_SEC = 60;
const STREAM_BACK_BUFFER_SEC = 60;     // kept behind it, for short jumps back
// Share of the measured bandwidth the quality may use (stay below, step up): hls.js'
// defaults for the main view; the second view leaves room for it.
const STREAM_BW_FACTOR = { main: [0.95, 0.85], low: [0.7, 0.6] };
const STREAM_NET_RETRIES = 4;          // network errors retried (1, 2, 3, 4 s apart) before giving up
const STREAM_MEDIA_RECOVERIES = 2;     // decoder errors recovered before giving up
const SYNC_TOLERANCE = 0.08;           // seconds of drift between the views that are ignored
const SYNC_SEEK_AT = 1.0;              // seconds of drift corrected by seeking instead of nudging
const SYNC_MAX_NUDGE = 0.1;            // max relative rate change while catching up
// ms the follower's picture stays in place while the clock reloads with its view (single
// view after a swap), at most: a load that takes longer shows the loading state (a product
// choice; the reload took 0.3 s with the demo lecture, dev/demo).
const HOLD_FOLLOWER_MAX_MS = 10000;
const STALL_CHECK_MS = 2000;           // how often the stall watchdog looks
const STALL_SEC = 12;                  // playing, not seeking, time unmoved this long: restart loading
const POSITION_SAVE_EVERY = 5;         // watchdog ticks between saves of the resume position (10 s)
const RENEW_REFUSAL_MS = 30000;        // a refusal this soon after a renewal is not fixed by renewing again
const CONTROLS_HIDE_MS = 2500;         // controls hide after this long without the pointer moving
const DOUBLE_CLICK_MS = 200;           // a click is single once no second one follows within this
const DRAG_SEEK_MS = 200;              // seeking at most this often while dragging the progress bar
// A reload the player makes itself (language change, expired session) comes back at the
// position it left, if the page is back within this long (a page load takes seconds).
const RELOAD_RESUME_MS = 60000;
const RESUME_END_SEC = 10;             // a resume point this close to the end starts over instead (nothing left to watch)

// ---- the camera alone while the screen is empty (43-empty-screen.js) ----
// Shortest empty-screen stretch that switches to the camera alone. An interface choice, not
// a measurement: each switch moves the pictures and loads a stream, so it should happen at
// most once a minute or so; an input being switched or a video starting on the screen ends
// sooner than the new layout would settle. Six sampling steps, so one sample that happened
// to catch a black frame never switches.
const EMPTY_SCREEN_MIN_SEC = 60;

// ---- menus and buttons (32-ui-kit.js, 48-speed.js, 49-volume.js, 55-notes.js) ----
const POP_GAP = 8;                     // px between a popover and its button
const POP_MARGIN = 8;                  // px kept free at the edges of the player
const SHEET_BELOW = 600;               // player narrower than this (px, a phone held upright): popovers are bottom sheets
const TIP_DELAY_MS = 500;              // hover time before a tooltip shows (a passing mouse shows none)
const SPEED_SNAP = 0.06;               // a speed this close to a stop takes the stop (so a finger can hit 1.5x)
// A bookmark this close to the playing moment (either side) is "here": the bookmark button
// shows it as on, and a press removes it instead of adding another at nearly the same time
// (a product choice: a bookmark marks a moment, two within seconds of each other are one).
const BOOKMARK_NEAR_SEC = 5;
const FLAG_CONFIRM_MS = 4000;          // "Didn't understand": time to press again to confirm
const VOLUME_STEP = 0.05;              // one arrow key press or wheel step (common players use 5%)
const VOLUME_WHEEL_PX = 50;            // wheel distance for one volume step; a single event counts at most this much, so
                                       // one mouse notch (53-120 px in Chromium by platform, 3 lines in Firefox) is one step
const VOLUME_OSD_MS = 1000;            // the level shown on the picture after a key or wheel change
const VOLUME_SLIDER_PX = 64;           // width of the volume slider when it is shown

// ---- backup files (85-export.js, 55-notes.js) ----
// A backup file may come from someone else: past these it is refused, or the record is
// skipped (a real backup is far below them; a crafted one could otherwise freeze a lecture
// or fill the site's storage).
const BACKUP_MAX_BYTES = 300 * 1024 * 1024;   // the file (PDFs included, as base64)
const BACKUP_MAX_ENTRIES = 50000;      // stored records in one file
const BACKUP_MAX_POSITIONS = 5000;     // remembered positions (one per recording)
const BACKUP_MAX_TAGS = 500;           // tags of one course
const BACKUP_MAX_TAGGED = 5000;        // tagged notes of one recording
const BACKUP_MAX_TAGS_EACH = 100;      // tags of one note
const BACKUP_MAX_RANGES = 2000;        // watched stretches of one recording (each saved visit adds them all again: quadratic)
const BACKUP_MAX_FILES = 100;          // PDF files of one recording
const BACKUP_MAX_FIXES = 5000;         // slide corrections of one recording
const BACKUP_MAX_USERS = 10000;        // recordings that use one PDF file

// ---- session (36-session.js) ----
const SESSION_RETRY_MS = [2000, 5000]; // waits before the two retries of a failed renewal
const SESSION_DEFAULT_RENEW_MS = 3600000;   // when Echo360 does not say (it says 1 h; access lasts about 2 h)
const SESSION_MIN_RENEW_MS = 60000;    // never renew more often than this
const SESSION_MAX_RENEW_MS = 7200000;  // nor less often (access lasts about 2 h; a longer wait is past what a timer can hold, 2^31 ms, and fired at once)
// A request to Echo360's pages and API (not media downloads) with no full answer by then
// is given up (its replies take well under a few seconds; a transcript is at most a few
// hundred KB, seconds on a slow mobile link).
const REQUEST_TIMEOUT_MS = 30000;

// ---- page and course list (10-adapter-echo360.js, 80-course-list.js, 90-main.js) ----
const CUE_MAX_CHARS = 5000;            // of one captions-file cue (a cue is a line or two, under 200; a longer one is cut)
const CUE_DEFAULT_MS = 3000;           // length of a transcript line without an end time
const LIST_CONCURRENT = 2;             // course page: player requests at a time
const LIST_GAP_MS = 150;               // and between them
const LIST_DEBOUNCE_MS = 300;          // redraws of the list waited for before labelling
const LIST_DONE_PCT = 99;              // watched share shown as complete
const HLS_LOAD_TIMEOUT_MS = 20000;    // hls.js (about 600 KB from jsDelivr, cached afterwards) not loaded by then: the original player is used (a slow mobile link of 0.3 Mbit/s still gets it in time)
const LOADING_SHOW_MS = 400;          // hls.js not there this long after the page's player was caught: the loading screen is shown (from the browser cache it takes tens of ms, and a screen shown that briefly would only flash)
const LOADING_SLOW_MS = 5000;          // from then on the loading screen says the network is slow, how long it has waited and what happens at HLS_LOAD_TIMEOUT_MS (the whole file takes about 0.5 s on a 10 Mbit/s link)
const LOADING_TIP_MS = 6000;           // the loading screen's tips change this often (time to read one sentence)
const BOOT_CHECK_MS = 8000;            // the page's own player not started this long after load: check why

// ---- anonymous usage data (87-telemetry.js) ----
// Product choices, not measurements: few small requests, nothing while the page is in the
// background or offline, nothing that waits long.
const TELEMETRY_SAMPLE_MS = 15000;     // dropped frames and memory read this often while visible (two property reads)
const TELEMETRY_ERROR_WAIT_MS = 60000; // errors are collected this long and sent together (one request, not one each)
const TELEMETRY_MAX_ERRORS = 20;       // different errors kept per page; more are not sent (a loop cannot flood)
const TELEMETRY_RETRY_MS = [30000, 120000];   // waits before the two retries of a request that got no answer or a server error
const TELEMETRY_TIMEOUT_MS = 15000;    // one request
const TELEMETRY_MIN_OPEN_SEC = 5;      // a viewing open shorter than this is not reported (a page passed through)
const TELEMETRY_ENV_DELAY_MS = 30000;  // the environment (once a day) is read this long after start, once playback has settled
const TELEMETRY_STEP_BATCH_MS = 20;    // fixed steps are timed in batches of at least this much computation: one run (about 0.02 ms) is shorter than the browser's timer step (0.1 ms in Chrome, up to 1 ms elsewhere); 20 ms is 200 of Chrome's steps (user requirement: about 20 ms)
const TELEMETRY_KEEP_VALUES = 400;     // values kept per measure of a viewing for its percentiles (a uniform random sample beyond that: memory stays small)
const TELEMETRY_TIMER_PROBE_MS = 3;    // longest the timer's step is measured for, once a page (in idle time)
const TELEMETRY_INPUT_MIN_MS = 16;     // Event Timing reports interactions from this long (the smallest durationThreshold the standard allows)
const TELEMETRY_SLOW_INPUT_MS = 200;   // a slow interaction: web.dev's INP "good" limit
const TELEMETRY_INPUT_MAX_MS = 10000;  // an interaction "answered" later than this was not drawn at all (window covered or not being drawn: Event Timing waits for the next frame shown; seen 181 s in a window behind others), not a delay anyone saw: left out
const TELEMETRY_WIDE_COLS = 12;        // "View my data": a kind of record with more columns is shown a record at a time (a field per line)
const TELEMETRY_PRESSURE_SAMPLE_MS = 2000;  // CPU pressure sampling asked of the browser (changes only are reported)
// Registration with the usage-data server (telemetry-worker/src/auth.js): one proof of work per id.
const TELEMETRY_MINT_BITS = 21;        // zero bits of the proof of work; the server's MINT_BITS (wrangler.toml) wins if higher. 2^21 hashes on average, measured 2026-10-17: iPad Pro 1st gen (iPadOS 15.7) 0.46 M/s = 4.5 s of work (~9 s in Safari's half-time slices, ~21 s one time in ten); desktop Chrome 2.1 M/s = 1 s
const TELEMETRY_MINT_DELAY_MS = 30000; // the work starts this long after a viewing starts, once playback has settled (as the environment)
const TELEMETRY_MINT_SLICE_MS = 20;    // one slice of the work, in idle time (user requirement for background computation: about 20 ms)
const TELEMETRY_MINT_SAVE_MS = 2000;   // the work done so far is saved at most this often (a page closed early carries on next time)
const TELEMETRY_WAIT_BATCHES = 10;     // batches the server refused until registered, kept (this page only) and sent once registered

// ---- 03-common.js ----
// ===================================================================================
// Small helpers shared by several parts (each used to be written out in two or more
// places): building elements, canvases, the site's hosts, Echo360 URLs, durations.
// ===================================================================================

// Pages this script runs on: Echo360's sites for Asia-Pacific, the US, the UK and Europe,
// and Canada (one application; only the first is tested with real recordings). Must list
// the same hosts as the @match lines in meta.txt (the build checks it): a page outside
// them never loads the script anyway.
const SITE_HOSTS = ['echo360.net.au', 'echo360.org', 'echo360.org.uk', 'echo360.ca'];
const SITE_REGIONS = ['au', 'us', 'uk', 'ca'];   // in the order of SITE_HOSTS

function isEcho360Host() {
  return SITE_HOSTS.includes(location.hostname);
}

// Which of Echo360's sites this is ('au', 'us', 'uk', 'ca'), for the usage data: whether
// the player works on each (never the address).
function siteRegion() {
  return SITE_REGIONS[SITE_HOSTS.indexOf(location.hostname)];
}

// Shown inside another page (a learning system embedding Echo360 in a frame).
function inFrame() {
  try { return window.top !== window.self; } catch (e) { return true; }
}

// An element: el('button.btn.primary', { title: 'x', onclick }, 'text', child, ...).
// on* functions are guarded (an error there is reported, not thrown into the page).
function el(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const elem = document.createElement(tag || 'div');
  if (classes.length) elem.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') elem.addEventListener(k.slice(2), guard(v));
      else if (k === 'text') elem.textContent = v;
      else if (k in elem && typeof v !== 'string') elem[k] = v;
      else elem.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c != null && c !== false) elem.append(c);
  return elem;
}

// A delete button that needs a second click within 3 s (it says "Click again to delete"
// in between). onConfirm(event) gets the second click, the user action for the write.
function confirmButton(label, onConfirm) {
  let armed = 0;
  const b = el('button.link.danger', { text: label });
  b.addEventListener('click', guard((e) => {
    if (!armed) {
      b.textContent = tr('confirmDelete');
      armed = setTimeout(() => { armed = 0; b.textContent = label; }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    b.textContent = label;
    onConfirm(e);
  }));
  return b;
}

// The value of the JavaScript string literal starting at text[at] (a quote), or null if
// there is none there. Every escape a string literal can hold is decoded.
function readJsString(text, at) {
  const q = text[at];
  if (q !== '"' && q !== "'") return null;
  let out = '';
  let i = at + 1;
  for (;;) {
    let j = i;
    while (j < text.length && text[j] !== q && text[j] !== '\\' && text[j] !== '\n' && text[j] !== '\r') j++;
    out += text.slice(i, j);
    if (j >= text.length || text[j] === '\n' || text[j] === '\r') return null;
    if (text[j] === q) return out;
    const c = text[j + 1];
    i = j + 2;
    const hex = (n) => {
      const h = text.slice(i, i + n);
      if (!new RegExp('^[0-9a-fA-F]{' + n + '}$').test(h)) return null;
      i += n;
      return parseInt(h, 16);
    };
    if (c === undefined) return null;
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' }[c];
    if (simple) { out += simple; continue; }
    if (c === 'x') { const n = hex(2); if (n == null) return null; out += String.fromCharCode(n); continue; }
    if (c === 'u') {
      if (text[i] === '{') {
        const end = text.indexOf('}', i);
        const n = end > i + 1 && /^[0-9a-fA-F]{1,6}$/.test(text.slice(i + 1, end)) ? parseInt(text.slice(i + 1, end), 16) : NaN;
        if (!(n <= 0x10ffff)) return null;
        out += String.fromCodePoint(n);
        i = end + 1;
        continue;
      }
      const n = hex(4);
      if (n == null) return null;
      out += String.fromCharCode(n);
      continue;
    }
    if (c === '0' && !/[0-9]/.test(text[i] || '')) { out += '\0'; continue; }
    if (c === '\r') { if (text[i] === '\n') i++; continue; }      // line continuation
    if (c === '\n' || c === '\u2028' || c === '\u2029') continue;
    if (/[0-9]/.test(c)) return null;                                  // octal escapes: not expected
    out += c;                                                          // \" \' \\ \/ and the like
  }
}

// A canvas to draw on off screen (an OffscreenCanvas where there is one).
function makeCanvas(w, h) {
  return typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

// A picture file of a canvas made by makeCanvas (OffscreenCanvas or a page canvas).
function canvasBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas could not be saved'))), type, quality));
}

// Path segment as the original player builds it: Echo360 ids are used verbatim (they
// contain ':' and '.'), only characters that would break the URL are escaped.
function seg(id) {
  return String(id).replace(/[^\w.:~-]/g, encodeURIComponent);
}

// URL of Echo360's preview picture at `t` (one of set.timesInSeconds) of a thumbnail set.
function thumbUrlOf(set, t) {
  return set.baseUri + '/' + t + '.' + set.extension;
}

// The recording's length: the video's once it knows it, else what the page said.
function mediaDuration(video, lesson) {
  const v = video.duration;
  if (isFinite(v) && v > 0) return v;
  return isFinite(lesson.duration) ? lesson.duration : 0;
}

// The user asked the browser to save data: no background downloads.
function saveDataOn() {
  return !!(navigator.connection && navigator.connection.saveData);
}

// A course's recordings as listed by Echo360 (the JSON `data` array). Rejects when the
// list cannot be had.
async function fetchSyllabus(section) {
  const r = await fetch('/section/' + encodeURIComponent(section) + '/syllabus', { credentials: 'include', headers: { Accept: 'application/json' }, signal: requestSignal() });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return j && Array.isArray(j.data) ? j.data : [];
}

// A drag by one pointer on `target`, owned by the Disposer d. h.start(e) begins it and
// returns its state (or null: not a drag); h.move(e, state) follows it; h.done(e, state)
// when that pointer is lifted normally; h.cancel(state) when the browser cancels it (a
// touch turned into scrolling, the capture lost), which must undo, not complete it.
// Other pointers (a second finger) are ignored until the first one is done.
// Pointer events: https://www.w3.org/TR/pointerevents/
function onDrag(d, target, h) {
  let cur = null;   // { id, state }
  d.listen(target, 'pointerdown', (e) => {
    if (cur) return;
    const state = h.start(e);
    if (state != null) cur = { id: e.pointerId, state };
  });
  d.listen(target, 'pointermove', (e) => { if (cur && e.pointerId === cur.id && h.move) h.move(e, cur.state); });
  d.listen(target, 'pointerup', (e) => {
    if (!cur || e.pointerId !== cur.id) return;
    const c = cur;
    cur = null;
    h.done(e, c.state);
  });
  const cancel = (e) => {
    if (!cur || e.pointerId !== cur.id) return;
    const c = cur;
    cur = null;
    h.cancel(c.state);
  };
  d.listen(target, 'pointercancel', cancel);
  d.listen(target, 'lostpointercapture', cancel);
}

// The window and visibility of the document a node is in now. The player can move into the
// floating window (46-popout.js): from then on its parts are drawn by that window, and the
// page it came from may be hidden (another tab) while the player is in plain view.
function windowOf(node) {
  return (node && node.ownerDocument && node.ownerDocument.defaultView) || window;
}
function hiddenFor(node) {
  return !!(node && node.ownerDocument ? node.ownerDocument : document).hidden;
}

// Fullscreen, also where only the prefixed API is there (Safari before 16.4: iPadOS 15).
// The prefixed calls return nothing (no Promise); a refusal is not an error worth reporting.
function fullscreenElement(doc) {
  const d = doc || document;
  return d.fullscreenElement || d.webkitFullscreenElement || null;
}
function exitFullscreen(doc) {
  const d = doc || document;
  const f = d.exitFullscreen || d.webkitExitFullscreen;
  return f ? Promise.resolve().then(() => f.call(d)).catch(() => {}) : Promise.resolve();
}
// false: elements cannot be made fullscreen here (iPhone: only a video, in the system's
// own player; a frame whose page does not allow fullscreen).
function fullscreenAllowed(d) {
  const on = d.fullscreenEnabled !== undefined ? d.fullscreenEnabled : d.webkitFullscreenEnabled;
  return on !== false;
}
function requestFullscreen(node) {
  const f = node.requestFullscreen || node.webkitRequestFullscreen;
  if (!f || !fullscreenAllowed(node.ownerDocument)) return false;
  Promise.resolve().then(() => f.call(node)).catch(() => {});
  return true;
}

// ---- 04-libs.js ----
// ===================================================================================
// The library files loaded when first needed, by npm path, with their SHA-256 (hex).
// platform.libBlobUrl / importLib refuse a file whose bytes differ, so a changed file on
// the CDN is never run; Tesseract's language data is checked in its Worker
// (tessWorkerGuard, 66-slide-ocr.js). hls.js is one of them: loaded when a player is about
// to start (platform.loadHls), never at start-up, so that the trap for the page's player
// (00-boot.js) never waits for a download.
//
// Each hash was taken from the CDN and matched against the package on registry.npmjs.org.
// `npm run check-requires` checks them against the CDN again (CI). A new version of a
// library means new paths and new hashes here.
// ===================================================================================

const HLS_LIB = 'hls.js@1.7.3/dist/hls.min.js';

// Sizes in bytes of the files whose download shows progress (the loading screen, 88-loading.js).
// The bytes are pinned by the hash below, so the size is too; the response's own length is no
// use for this (jsDelivr compresses: it gives the compressed size, and the body is counted
// after decompression). `npm run check-requires` checks them with the hashes.
const LIB_BYTES = {
  'hls.js@1.7.3/dist/hls.min.js': 619692,
};

const LIB_SHA256 = {
  'hls.js@1.7.3/dist/hls.min.js': 'a12e7ee1cd64a69dcdb314157e45dafcba705bfb0b1440b7935cb265d374423e',
  'pdfjs-dist@6.4.299/build/pdf.min.mjs': '57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2',
  'pdfjs-dist@6.4.299/build/pdf.worker.min.mjs': '9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18',
  'tesseract.js@7.0.0/dist/tesseract.esm.min.js': '64871d76c75609fd5413b88a8171e2ef40deedd77d5875ba23df104b2d05eb29',
  'tesseract.js@7.0.0/dist/worker.min.js': '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',
  'tesseract.js-core@7.0.0/tesseract-core-lstm.wasm.js': 'eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680',
  'tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js': 'c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38',
  '@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz': '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
  '@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz': 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c',
  '@tesseract.js-data/chi_tra@1.0.0/4.0.0_best_int/chi_tra.traineddata.gz': '11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743',
  '@tesseract.js-data/jpn@1.0.0/4.0.0_best_int/jpn.traineddata.gz': '2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88',
  '@tesseract.js-data/kor@1.0.0/4.0.0_best_int/kor.traineddata.gz': '78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126',
  '@tesseract.js-data/rus@1.0.0/4.0.0_best_int/rus.traineddata.gz': 'f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a',
  '@tesseract.js-data/ell@1.0.0/4.0.0_best_int/ell.traineddata.gz': 'e8a293abb398ec479176c1575aef24e2bacb0611c713f3fa996f97f0cd996fb3',
  '@tesseract.js-data/ara@1.0.0/4.0.0_best_int/ara.traineddata.gz': 'f4746c44b02342dd5b3d4f0198000f47d7c49f1a229e63e0f436c0592dcd9639',
  '@tesseract.js-data/heb@1.0.0/4.0.0_best_int/heb.traineddata.gz': '9c70b524200dae77fb25e3567566eee600ccbcae9aeb89722990ccae0e84e805',
  '@tesseract.js-data/tha@1.0.0/4.0.0_best_int/tha.traineddata.gz': '4550a5505184d1b79cf10416d5b19e643001d95411d5e717954dd26feef3ae74',
  '@tesseract.js-data/hin@1.0.0/4.0.0_best_int/hin.traineddata.gz': 'f3b6a0d320df38d886178cdd727b90dbf9df3db053adb32bd9cf73f0463cda07',
};

// ---- 04-types.js ----
// ===================================================================================
// The shapes of the data passed between the parts, for readers and for the type checker
// (npm run typecheck). Comments only: nothing here runs.
// ===================================================================================

/**
 * One view of the recording (screen or camera), from the page (10-adapter-echo360.js).
 * @typedef {object} Source
 * @property {number} index        Echo360's sourceIndex (1, 2...)
 * @property {number} n            position, from 1
 * @property {string|null} av      HLS master playlist with audio and video
 * @property {string|null} v       HLS master playlist with video only
 * @property {string|null} poster  picture shown before playback
 */

/**
 * Echo360's preview pictures of one view, one per minute.
 * @typedef {object} ThumbnailSet
 * @property {number} sourceIndex
 * @property {string} baseUri
 * @property {string} extension
 * @property {number[]} timesInSeconds
 */

/**
 * The recording, as the player sees it (echo360ClassroomAdapter.parse).
 * @typedef {object} Lesson
 * @property {string} id                 the media id (or lesson id, or the page path)
 * @property {string} [lessonId]
 * @property {string|null} sectionId     the course
 * @property {string} [mediaId]
 * @property {string|null} userId
 * @property {boolean} isAnonymousUser
 * @property {string|null} transcriptUrl
 * @property {string} title
 * @property {string} courseName
 * @property {number|null} sessionRenewMs   how often Echo360 renews video access
 * @property {string|null} backUrl
 * @property {number} duration           seconds (NaN if unknown)
 * @property {number|null} resumeAt      seconds: where Echo360 says playback stopped
 * @property {Source[]} sources
 * @property {string|null} captionsUrl
 * @property {ThumbnailSet[]} thumbnails
 * @property {{ polls: boolean, slides: boolean, audioDescription: boolean }} extras
 * @property {object|null} analytics     what watch reporting needs (20-reporter.js)
 */

/**
 * A line of the transcript or captions (seconds).
 * @typedef {object} Cue
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {string} speaker
 */

/**
 * A slide chapter found in the screen view (64-slides.js).
 * @typedef {object} Chapter
 * @property {number} start       seconds
 * @property {number} end         seconds
 * @property {boolean} precise    start pinned to about a second (else to a sample)
 * @property {number} repTime     the moment whose picture represents it
 * @property {string} thumb       picture URL (object URL or Echo360 preview)
 * @property {Blob|null} [blob]   the picture, when made from a keyframe
 * @property {number} [firstSample]
 */

/**
 * A stretch that can be skipped (62-silence.js skipStretches).
 * @typedef {object} SkipStretch
 * @property {number} start
 * @property {number} end
 * @property {'silence'|'blank'|'black'} kind
 */

/**
 * A page of the lecturer's slide files (68-slide-deck.js).
 * @typedef {object} DeckPage
 * @property {string} key     file hash (12 characters) + ':' + page number
 * @property {string} file    file name
 * @property {number} num     page number, from 1
 * @property {object} doc     the pdf.js document
 * @property {number} ar      height / width
 * @property {string} title
 * @property {string} text
 */

/**
 * A note, bookmark or "didn't understand" flag (11-echo360-api.js).
 * @typedef {object} Note
 * @property {string} id
 * @property {'note'|'bookmark'|'flag'} type
 * @property {number|null} time   seconds
 * @property {string} [text]
 * @property {string} createdAt
 */

/**
 * A discussion post or reply (11-echo360-api.js).
 * @typedef {object} DiscussionComment
 * @property {string} id
 * @property {string|null} questionId   null for a post, the post for a reply
 * @property {string} body
 * @property {number|null} time
 * @property {string} author
 * @property {boolean} mine
 * @property {number} likes
 * @property {boolean} liked
 * @property {boolean} saved
 * @property {boolean} hasAttachment
 * @property {DiscussionComment[]} replies
 */

// ---- stored in IndexedDB (61-media-io.js idbCache), by key prefix ----
// Analysis results (pruned, see 63-caches.js); user data (kept, in backups, 85-export.js).

/**
 * slides:<mediaId>  (analysis)
 * @typedef {object} SlidesRecord
 * @property {number} v           CACHE_KINDS.slides
 * @property {number} used        last use (ms)
 * @property {number|null} screen the screen view's index
 * @property {boolean} [sure]     the screen view was told clearly (not a guess)
 * @property {{ start: number, end: number }[]} uniform   empty-screen stretches
 * @property {Chapter[]} chapters
 */

/**
 * silence-env:<mediaId>  (analysis)
 * @typedef {object} SilenceEnvRecord
 * @property {number} v
 * @property {number} used
 * @property {number} step        seconds per value
 * @property {Uint8Array} data    0 = not analysed, 1..255 = -100..0 dBFS
 */

/**
 * ocr:<mediaId>:<view>[:<language>]  (analysis)
 * @typedef {object} OcrRecord
 * @property {number} v
 * @property {number} used
 * @property {number} screen
 * @property {number} height      rendition read
 * @property {string[]} texts     each distinct picture's text
 * @property {number[]} at        per sample: index into texts, -1 = not read
 * @property {object} stats
 */

/**
 * watched:<lessonId>  (user data)
 * @typedef {object} WatchedRecord
 * @property {number} d           duration (s)
 * @property {[number, number][]} r   watched stretches (s)
 * @property {number} [e]         where the content ends (an empty ending follows)
 * @property {number} at          last update (ms)
 */

// Other user data:
//   tags:<sectionId>     { tags: [{ id, name, color }] }
//   tagmap:<mediaId>     { <note or bookmark id>: [tag id] }
//   deck:<mediaId>       { files: [{ hash, name }], fixes: [{ a, b, page }] }
//   deckref:<hash>       [mediaId]   recordings using a slide file
//   deckfile:<hash>      Blob        the slide file
//   screenpick:<mediaId> { index }   the screen view chosen by hand
// localStorage (prefix lite-player-for-echo360:): prefs (39-prefs.js), pos:<lesson id> { t, at },
// debug, dryRun, forceOriginal, silenceFromAudio (development switches).

// ---- 05-platform.js ----
// ===================================================================================
// Platform: everything that depends on how the player is run: a userscript (Tampermonkey,
// Violentmonkey) running in the page, or the Chrome extension built from the same sources,
// which replaces some of these (06-platform-extension.js). The rest of the code uses only
// `platform` for these things (the build checks it):
//   - kv: small settings kept on this device (synchronous: settings are needed at start-up;
//     an extension reads a snapshot before it starts the player)
//   - openDb: the IndexedDB database for larger data (slide files, analyses, tags)
//   - libUrl / libBlobUrl / importLib: the libraries loaded when first needed (pdf.js,
//     Tesseract and its language data), named by their npm path ('pdfjs-dist@6.4.299/
//     build/...'). A userscript fetches them from a CDN and runs a file only after its
//     bytes match LIB_SHA256 (04-libs.js); an extension ships them (Manifest V3 does not
//     allow code from elsewhere).
//   - Hls / loadHls: hls.js, loaded when a player is about to start (a pinned file like the
//     others); a copy already on the page (development builds inject one) is used as is
//   - save: offer a file to the user
//   - manager: what runs the player, for diagnostics
//   - post: send JSON to the telemetry Worker (87-telemetry.js)
//   - privateKv: values kept out of the page's reach (the telemetry secret); read only after
//     privateReady (an extension reads them at start-up, asynchronously)
//   - page: the page's own window, for traps on the page's globals (window.Echo)
// ===================================================================================

const libBlobUrls = new Map();   // path -> Promise of a blob URL (platform.libBlobUrl)

// A response body read to the end as an ArrayBuffer, reporting the bytes so far (a failure in
// the report does not stop the download).
async function readCounting(reader, onProgress) {
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.byteLength;
    try { onProgress(n); } catch (e) { /* display only */ }
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out.buffer;
}

const platform = {
  name: 'userscript',
  // With any @grant other than none, Tampermonkey and Violentmonkey give the script a
  // wrapper as `window`: a property defined on it is not seen by the page's scripts.
  page: pageWindow(),
  kv: {
    get(name) { try { return localStorage.getItem(name); } catch (e) { return null; } },
    // Throws when storage is full or blocked; callers decide whether that matters.
    set(name, text) { localStorage.setItem(name, text); },
    names() {
      const out = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k != null) out.push(k); } } catch (e) { /* blocked */ }
      return out;
    },
  },
  openDb(name, version) {
    if (typeof indexedDB === 'undefined') return null;
    return indexedDB.open(name, version);
  },
  libUrl(path) { return 'https://cdn.jsdelivr.net/npm/' + path; },
  // A blob URL of the pinned file, made once per page from bytes that match its SHA-256
  // (a file that differs is refused). Kept for the page's life: workers are made from it
  // again, and it is a few files of 0.1 to 4 MB.
  libBlobUrl(path, prefix, suffix, onProgress) {
    const key = path + (prefix ? '\n' + prefix : '') + (suffix ? '\n' + suffix : '');
    let p = libBlobUrls.get(key);
    if (!p) {
      p = this.libBytes(path, onProgress).then((buf) => URL.createObjectURL(new Blob([prefix || '', buf, suffix || ''], { type: 'text/javascript' })));
      libBlobUrls.set(key, p);
      p.catch(() => libBlobUrls.delete(key));
    }
    return p;
  },
  // The bytes of a pinned file, refused unless they match its SHA-256. onProgress(bytes so
  // far): called as the body arrives, where the browser can stream it.
  async libBytes(path, onProgress) {
    const want = LIB_SHA256[path];
    if (!want) throw new Error('not a pinned library file: ' + path);
    const r = await fetch(this.libUrl(path), { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path);
    const buf = onProgress && r.body && r.body.getReader ? await readCounting(r.body.getReader(), onProgress) : await r.arrayBuffer();
    if (await sha256Hex(buf) !== want) throw new Error('library file changed on the CDN, not used: ' + path);
    return buf;
  },
  importLib(path) { return this.libBlobUrl(path).then((u) => import(u)); },
  Hls: typeof Hls !== 'undefined' ? Hls : window.Hls,
  hlsLoading: null,
  // Resolves to hls.js, or rejects (the file could not be had in timeoutMs, or differs).
  // hls.min.js is a UMD file: run as a module, it is given `module` and `exports` to fill
  // (so it sets no global on the page) and its export is passed on.
  // onProgress(bytes so far): see libBytes (only the call that starts the download gets it).
  loadHls(timeoutMs, onProgress) {
    if (this.Hls) return Promise.resolve(this.Hls);
    if (!this.hlsLoading) {
      this.hlsLoading = this.libBlobUrl(HLS_LIB, 'const module = { exports: {} }; const exports = module.exports;\n', '\n;export default module.exports;\n', onProgress)
        .then((u) => import(u))
        .then((m) => {
          const lib = m && m.default;
          if (!lib || typeof lib.isSupported !== 'function') throw new Error('hls.js did not load');
          this.Hls = lib;
          return lib;
        });
      this.hlsLoading.catch(() => { this.hlsLoading = null; });
    }
    let timer = 0;
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('hls.js not loaded in ' + Math.round(timeoutMs / 1000) + ' s')), timeoutMs); });
    return Promise.race([this.hlsLoading, late]).finally(() => clearTimeout(timer));
  },
  save(blob, fileName) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  },
  // POSTs a JSON text; resolves to { status, text } (status 0: no answer), never rejects.
  // keepalive: the page is closing (the request must outlive it; GM_xmlhttpRequest is made
  // by the extension and does anyway).
  // A userscript uses GM_xmlhttpRequest: no cookies are sent, and the page's content
  // security policy does not apply (it allows only the page's own servers); @connect in
  // meta.txt names the one host it may reach. Without it (a development build injected
  // into the page), fetch.
  post(url, body, timeoutMs, keepalive) {
    return new Promise((resolve) => {
      const done = (status, text) => resolve({ status, text: typeof text === 'string' ? text : '' });
      try {
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'POST', url, data: body, headers: { 'Content-Type': 'application/json' }, anonymous: true, timeout: timeoutMs,
            onload: (r) => done(r.status, r.responseText), onerror: () => done(0), ontimeout: () => done(0), onabort: () => done(0),
          });
          return;
        }
        fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: !!keepalive, signal: keepalive ? undefined : timeoutSignal(timeoutMs) })
          .then((r) => r.text().then((t) => done(r.status, t)), () => done(0));
      } catch (e) {
        done(0);
      }
    });
  },
  privateReady: Promise.resolve(),
  // Kept by the userscript manager (GM_getValue), where the page's own scripts cannot read
  // it; without one, the page's storage like the settings.
  privateKv: {
    get(name) {
      try { if (typeof GM_getValue === 'function') { const v = GM_getValue(name, null); return typeof v === 'string' ? v : null; } } catch (e) { return null; }
      try { return localStorage.getItem(NS + name); } catch (e) { return null; }
    },
    set(name, text) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(name, text); return; } } catch (e) { return; }
      try { localStorage.setItem(NS + name, text); } catch (e) { /* storage blocked: a new secret next time */ }
    },
  },
  manager() {
    try {
      if (typeof GM_info !== 'undefined' && GM_info) return (GM_info.scriptHandler || 'userscript manager') + ' ' + (GM_info.version || '');
    } catch (e) { /* not available */ }
    return 'unknown (or development)';
  },
};

// ---- 10-adapter-echo360.js ----
// ===================================================================================
// Site adapters. Everything that knows about a particular Echo360 deployment lives here;
// the player only sees the normalised "lesson" object returned by parse().
//
// Adapter interface:
//   id                       string
//   matches()                -> boolean, is this page handled by the adapter
//   intercept(onBoot)        call onBoot(arg, callOriginal) when the page would start its
//                            own player (the trap itself is set first, by 00-boot.js)
//   bootArg()                -> the bootstrap argument of a page that already started its
//                            player (taken over), or null
//   original()               -> a function starting the page's own player, or null
//   stopOriginal(arg)        stop the page's own player: -> { at, playing, unmounted, restore() }
//   isWatchReport(method, url)  a watch report of the original player (stopped while taken over)
//   parse(arg)               -> lesson (throws if the page is not understood)
//   withStartTime(arg, sec)  -> arg with the resume point moved (for handing over)
// ===================================================================================

const echo360ClassroomAdapter = {
  id: 'echo360-classroom',

  matches() {
    return isEcho360Host() && /^\/lesson\//.test(location.pathname);
  },

  // The page's bootstrap call is trapped by 00-boot.js, set before anything else; onBoot
  // receives it from there.
  intercept(onBoot) {
    boot.handler = onBoot;
  },

  // The bootstrap argument of a page that started its player before this script ran: the
  // same text the page passed, read from its inline script. null if it is not there.
  bootArg() {
    const call = /Echo\s*(?:\[\s*(["'])echoPlayerV2FullApp\1\s*\]|\.echoPlayerV2FullApp)\s*\(\s*(?=["'])/g;
    for (const s of document.scripts) {
      if (s.src) continue;
      const text = s.textContent || '';
      call.lastIndex = 0;
      const m = call.exec(text);
      if (!m) continue;
      const arg = readJsString(text, m.index + m[0].length);
      if (arg != null) return arg;
    }
    return null;
  },

  // A call to the page's own bootstrap function (for a page taken over: the trap was set
  // after the page had started, and found it on window.Echo).
  original() {
    const fn = boot.original();
    if (typeof fn !== 'function') return null;
    return (a) => fn.call(platform.page.Echo, a);
  },

  // Stops the original player of a page taken over: where it was and whether it was
  // playing, then its videos are paused and muted at once, its React tree is unmounted (as
  // its own bootstrap does before it renders again), and any video left is emptied, so
  // nothing plays, downloads or sends timeupdates. Where React cannot be reached, its
  // container is taken out of the page instead (put back by restore()).
  // -> { at (seconds, or null), playing, unmounted, container, restore() }
  stopOriginal(arg) {
    let id = null;
    try { id = (typeof arg === 'string' ? JSON.parse(arg) : arg).id; } catch (e) { id = null; }
    const container = typeof id === 'string' && id ? document.getElementById(id) : null;
    /** @type {HTMLMediaElement[]} */
    const media = [...document.querySelectorAll('video, audio')].map((m) => /** @type {HTMLMediaElement} */ (m));
    let at = null;
    let playing = false;
    for (const v of media) {
      if (at == null && v.readyState > 0 && v.currentTime > 0) at = v.currentTime;
      if (!v.paused && !v.ended) playing = true;
    }
    for (const v of media) { try { v.muted = true; v.pause(); } catch (e) { /* gone */ } }
    let unmounted = false;
    const root = container && /** @type {any} */ (container)._reactRootContainer;
    if (root && typeof root.unmount === 'function') {
      try {
        root.unmount();
        /** @type {any} */ (container)._reactRootContainer = null;
        unmounted = !container.querySelector('video, audio');
      } catch (e) { log.warn('the original player could not be unmounted:', e); }
    }
    for (const v of media) {
      try { v.removeAttribute('src'); v.load(); } catch (e) { /* gone */ }
    }
    let removed = null;
    if (!unmounted && container && container.parentNode) {
      removed = { parent: container.parentNode, next: container.nextSibling };
      container.remove();
    }
    return {
      at, playing, unmounted, container,
      restore() {
        if (!removed || container.isConnected) return;
        removed.parent.insertBefore(container, removed.next && removed.next.parentNode === removed.parent ? removed.next : null);
      },
    };
  },

  // The original player's watch reports (what 20-reporter.js sends for ours).
  isWatchReport(method, url) {
    return method === 'POST' && /^https:\/\/api\.[^/]+\/a\/player\/(session|beacon)(\?|$)/.test(url);
  },

  withStartTime(arg, sec) {
    const cfg = typeof arg === 'string' ? JSON.parse(arg) : Object.assign({}, arg);
    cfg.startTimeMillis = Math.max(0, Math.round(sec * 1000));
    return typeof arg === 'string' ? JSON.stringify(cfg) : cfg;
  },

  /** @returns {Lesson} */
  parse(arg) {
    const cfg = typeof arg === 'string' ? JSON.parse(arg) : arg;
    const video = cfg && cfg.video;
    if (!video || !Array.isArray(video.playableMedias)) throw new Error('video.playableMedias missing');
    if (video.playableMedias.some((m) => m && m.isLive)) throw new Error('live lessons are not supported');
    const cr = cfg.copyrightData;
    if (cr && cr.enforceCopyrightAcknowledgement && !cr.copyrightAcknowledged) {
      throw new Error('copyright acknowledgement required (handled by the original player)');
    }

    const bySource = new Map();
    for (const m of video.playableMedias) {
      if (!m || !m.isHls || typeof m.uri !== 'string') continue;
      const kind = (m.trackType || []).join('+');
      const s = bySource.get(m.sourceIndex) || {};
      if (kind === 'Audio+Video') s.av = m.uri;
      else if (kind === 'Video') s.v = m.uri;
      bySource.set(m.sourceIndex, s);
    }
    const posters = new Map((video.posterMedia || []).map((p) => [p.sourceIndex, p.uri]));
    const sources = [...bySource.entries()]
      .filter(([, s]) => s.av || s.v)
      .sort((a, b) => a[0] - b[0])
      .map(([index, s], i) => ({ index, n: i + 1, av: s.av || null, v: s.v || null, poster: posters.get(index) || null }));
    if (!sources.some((s) => s.av)) throw new Error('no audio+video HLS stream');

    const duration = parseIsoDuration(video.duration);
    const sectionId = cfg.sectionInfo && cfg.sectionInfo.section && cfg.sectionInfo.section.id;
    const ctx = cfg.context || {};
    const hostMatch = location.hostname.match(/echo360.+/);

    let analytics = null;
    if (cfg.sessionId && video.mediaId && hostMatch) {
      analytics = {
        gatewayUrl: location.protocol + '//api.' + hostMatch[0],
        appUrl: location.origin,
        sessionId: cfg.sessionId,
        mediaId: video.mediaId,
        context: {
          course_id: ctx.courseId, department_id: ctx.departmentId, group_id: ctx.groupId,
          lesson_id: ctx.lessonId, lti_id: ctx.ltiId, organization_id: ctx.organizationId,
          section_id: ctx.sectionId, term_id: ctx.termId,
        },
        link: { lti: ctx.ltiId, public: ctx.publicLinkId, secure: ctx.secureLinkId, secure_data: ctx.secureLinkAccessDataId },
        user: cfg.user ? { id: cfg.user.id, role: cfg.user.currentRole } : undefined,
      };
    }

    const lessonId = cfg.lesson && cfg.lesson.id;
    return {
      id: video.mediaId || lessonId || location.pathname,
      lessonId,
      sectionId: ctx.sectionId || sectionId || null,
      userId: cfg.user ? cfg.user.id : null,
      isAnonymousUser: !cfg.user || cfg.user.currentRole === 'Anonymous',
      mediaId: video.mediaId,
      transcriptUrl: lessonId && video.mediaId
        ? '/api/ui/echoplayer/lessons/' + encodeURIComponent(lessonId) + '/medias/' + encodeURIComponent(video.mediaId) + '/transcript'
        : null,
      title: cfg.title || (cfg.lesson && cfg.lesson.name) || document.title,
      courseName: (cfg.sectionInfo && cfg.sectionInfo.course && (cfg.sectionInfo.course.courseName || cfg.sectionInfo.course.courseIdentifier)) || '',
      // How often the page renews the video access cookies (see 36-session.js).
      sessionRenewMs: typeof cfg.cookieRenewalIntervalMillis === 'number' ? cfg.cookieRenewalIntervalMillis : null,
      backUrl: sectionId ? '/section/' + encodeURIComponent(sectionId) + '/home' : null,
      duration: isFinite(duration) ? duration : NaN,
      resumeAt: typeof cfg.startTimeMillis === 'number' ? cfg.startTimeMillis / 1000 : null,
      sources,
      captionsUrl: typeof cfg.captions === 'string' && cfg.captions ? cfg.captions : null,
      thumbnails: Array.isArray(video.thumbnailMedia) ? video.thumbnailMedia : [],
      // Content only the original player can show; we point users there instead.
      extras: {
        polls: Array.isArray(cfg.polls) && cfg.polls.length > 0,
        slides: !!(cfg.slides && cfg.slides.slideDeck),
        audioDescription: Array.isArray(video.audioDescriptions) && video.audioDescriptions.length > 0,
      },
      analytics,
    };
  },
};

// Transcript cues as [{ start, end, text, speaker }] (seconds), sorted by start. Uses the
// transcript API (same cues as the captions, with speaker labels) and falls back to the
// WebVTT captions file. Resolves to [] when the recording has neither; rejects when the
// transcript failed for now (isTransient: no connection, server error) and there is no
// captions file to fall back on, so the player can offer to try again.
echo360ClassroomAdapter.fetchCues = function (lesson) {
  const fromTranscript = () => {
    if (!lesson.transcriptUrl) return Promise.reject(new Error('no transcript url'));
    // As Echo360Api.request: a redirect only goes to the login page (sign-in expired).
    return fetch(lesson.transcriptUrl, { credentials: 'include', redirect: 'manual', headers: { Accept: 'application/json' }, signal: requestSignal() })
      .then((r) => {
        if (r.type === 'opaqueredirect') throw Object.assign(new Error('HTTP 401'), { status: 401, login: true });
        return r.ok ? r.json() : Promise.reject(Object.assign(new Error('HTTP ' + r.status), { status: r.status }));
      })
      .then((j) => {
        const raw = j && j.data && j.data.contentJSON && j.data.contentJSON.cues;
        if (!Array.isArray(raw) || !raw.length) throw new Error('empty transcript');
        return raw
          .filter((c) => typeof c.startMs === 'number' && typeof c.content === 'string' && c.content.trim())
          .map((c) => ({ start: c.startMs / 1000, end: (typeof c.endMs === 'number' ? c.endMs : c.startMs + CUE_DEFAULT_MS) / 1000, text: c.content.trim(), speaker: c.speaker || '' }));
      });
  };
  const fromVtt = () => {
    if (!lesson.captionsUrl) return [];
    return fetch(lesson.captionsUrl, { signal: requestSignal() })
      .then((r) => (r.ok ? r.text() : ''))
      .then(parseVtt);
  };
  let failed = null;
  return fromTranscript()
    .catch((e) => { failed = e; return fromVtt(); })
    .catch(() => [])
    .then((cues) => {
      if (!cues.length && failed && (isTransient(failed) || failed.login)) throw failed;
      return cues.sort((a, b) => a.start - b.start);
    });
};

// Only the start of each side of the arrow is looked at: a long run of digits would
// otherwise be tried from each of its characters (quadratic).
function parseVttTime(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(String(s).trim().slice(0, 32));
  if (!m) return NaN;
  return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

// Minimal WebVTT parser: cue timing lines plus text, NOTE blocks and tags removed.
/** @returns {Cue[]} */
function parseVtt(text) {
  const cues = [];
  const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseVttTime(a);
    const end = parseVttTime(b);
    if (!isFinite(start) || !isFinite(end)) continue;
    let speaker = '';
    const body = lines.slice(ti + 1).join(' ').slice(0, CUE_MAX_CHARS).replace(/<v\s+([^>]*)>/g, (m, who) => { speaker = who.trim(); return ''; })
      .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (body) cues.push({ start, end, text: decodeEntities(body), speaker });
  }
  return cues;
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&nbsp;/g, ' ');
}

// One implementation today; the list is where support for other sites would be added.
const ADAPTERS = [echo360ClassroomAdapter];

// ---- 11-echo360-api.js ----
// ===================================================================================
// Echo360 data API (notes, bookmarks, "didn't understand" flags, discussions).
//
// Reads return normalised objects:
//   Note    { id, type: 'note' | 'bookmark', time (s) | null, text, createdAt }
//   Flag    { id, type: 'flag', time (s, start of its 30 s scene), createdAt }
//   Comment { id, questionId | null, body, time (s) | null, authorId, author, nameHidden,
//             instructor, ta, mine, likes, liked, saved, hasAttachment, createdAt,
//             updatedAt, replies: Comment[] }
//
// Every write takes the user event that caused it and refuses to run without a trusted
// one, so nothing is ever written to Echo360 without an explicit user action.
//
// Dry run (development): localStorage "lite-player-for-echo360:dryRun" = "public" or "all". Matching
// writes are fully built but only recorded (console + window.__litePlayerForEcho360DryRun), never
// sent. Public = visible to the instructor or the class (discussion, likes, saves, flags).
// ===================================================================================

// The message is only the status, which is what logs and diagnostics keep. The server's
// own text can repeat what was sent (a note, a name), so it is kept apart and shown only
// on screen (errorText).
class ApiError extends Error {
  constructor(status, serverText) {
    super('HTTP ' + status);
    this.status = status;
    this.serverText = typeof serverText === 'string' ? serverText.slice(0, 200) : '';
  }
}

// A failure that may pass by itself: no connection (fetch rejects with a TypeError), a
// timeout, too many requests or a server error. Any other refusal (401, 403, 404, an
// answer saying "ko") means the feature is not offered here.
function isTransient(e) {
  if (e && (e.name === 'TypeError' || e.name === 'TimeoutError')) return true;
  const s = e && e.status;
  return s === 0 || s === 408 || s === 429 || s >= 500;
}

// What to tell the user about a failed request or operation.
function errorText(e) {
  if (e && e.login) return tr('authLoginExpiredText');
  return (e && (e.serverText || e.message)) || String(e);
}

// The same for a failed load: no connection in words instead of fetch's "Failed to fetch".
function loadErrorText(e) {
  if (e && e.name === 'TypeError') return tr(navigator.onLine === false ? 'failOffline' : 'netError');
  return errorText(e);
}

// Same thumbnail choice as the original player: first thumbnail set, the last image taken
// strictly before the referenced moment, else the first one; '' without thumbnails.
function thumbnailFor(thumbnails, ms) {
  const set = thumbnails && thumbnails[0];
  if (!set || !Array.isArray(set.timesInSeconds) || !set.timesInSeconds.length) return '';
  const r = Number(ms) / 1000;
  let pick = set.timesInSeconds.slice().reverse().find((x) => x < r);
  if (pick === undefined) pick = set.timesInSeconds[0];
  return thumbUrlOf(set, pick);
}

function requireGesture(ev) {
  if (!ev || ev.isTrusted !== true) throw new Error('write refused: not triggered by a user action');
}

const FLAG_SCENE_SECONDS = 30;

class Echo360Api {
  constructor(lesson) {
    this.l = lesson;
    const mode = store.get('dryRun', false);
    this.dryRun = mode === 'all' || mode === 'public' ? mode : false;
    if (this.dryRun) log.info('dry run (' + this.dryRun + '): writes to Echo360 are not sent');
  }

  async request(method, path, body) {
    /** @type {RequestInit & { headers: Record<string, string> }} */
    // A redirect is not followed: Echo360 only redirects to its login page, once the school
    // sign-in has expired (followed, it fails as "Failed to fetch", like no connection).
    const opts = { method, credentials: 'include', redirect: 'manual', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    opts.signal = requestSignal();
    let r;
    let j = null;
    try {
      r = await fetch(path, opts);
      if (r.type !== 'opaqueredirect') { try { j = await r.json(); } catch (e) { if (e && e.name === 'TimeoutError') throw e; /* empty body */ } }
    } catch (e) {
      // No answer in time: as a server that says so (transient, see isTransient).
      if (e && e.name === 'TimeoutError') throw new ApiError(408);
      throw e;
    }
    if (r.type === 'opaqueredirect') throw Object.assign(new ApiError(401), { login: true });
    if (!r.ok || (j && j.status === 'ko')) throw new ApiError(r.status, j && j.message);
    return j && 'data' in j ? j.data : j;
  }

  // visibility: 'private' (only the user) or 'public' (instructor and/or class).
  write(ev, visibility, method, path, body) {
    requireGesture(ev);
    if (this.dryRun === 'all' || (this.dryRun === 'public' && visibility === 'public')) {
      const rec = { method, url: new URL(path, location.origin).href, body: body === undefined ? null : JSON.stringify(body), visibility };
      (platform.page.__litePlayerForEcho360DryRun = platform.page.__litePlayerForEcho360DryRun || []).push(rec);
      log.info('DRY RUN (not sent):', method, rec.url, rec.body || '');
      return Promise.resolve(dryRunResult(method, path, body));
    }
    return this.request(method, path, body);
  }

  // ---- notes and bookmarks (private) ----

  async notes() {
    const data = await this.request('GET', '/api/ui/lesson/' + seg(this.l.lessonId) + '/notes/content');
    return (data || []).filter((x) => x && x.note).map((x) => {
      const ts = x.videoContentRef && x.videoContentRef.content && x.videoContentRef.content.timestamp;
      return {
        id: x.note.id,
        type: x.note.bookmark ? 'bookmark' : 'note',
        time: typeof ts === 'number' ? Math.floor(ts) / 1000 : null,
        text: x.note.bookmark ? '' : (x.note.text || ''),
        createdAt: x.note.createdAt,
      };
    });
  }

  async addNote(ev, { text, time, bookmark, num }) {
    const body = { bookmark: !!bookmark, lessonId: this.l.lessonId, num: num || 1, text: bookmark ? 'bookmark' : text };
    if (time != null && this.l.mediaId) body.videoRef = { timestamp: Math.trunc(time * 1000), type: 'Video', videoId: this.l.mediaId };
    const data = await this.write(ev, 'private', 'POST', '/notes', body);
    const created = Array.isArray(data) ? data[0] : data;
    return {
      id: created && created.id,
      type: bookmark ? 'bookmark' : 'note',
      time: time != null ? Math.trunc(time * 1000) / 1000 : null,
      text: bookmark ? '' : text,
      createdAt: (created && created.createdAt) || new Date().toISOString(),
    };
  }

  updateNote(ev, note, text) {
    return this.write(ev, 'private', 'PUT', '/notes/' + seg(note.id), { bookmark: note.type === 'bookmark', text });
  }

  deleteNote(ev, note) {
    return this.write(ev, 'private', 'DELETE', '/notes/' + seg(note.id));
  }

  // ---- "didn't understand" flags (seen by the instructor as counts per 30 s scene) ----

  async flags() {
    const data = await this.request('GET', '/lesson/' + seg(this.l.lessonId) + '/video/' + seg(this.l.mediaId) + '/confusedV2');
    return (data || []).filter((x) => x && typeof x.sceneId === 'number').map((x) => ({
      id: 'flag-' + x.sceneId,
      type: 'flag',
      time: x.sceneId * FLAG_SCENE_SECONDS,
      createdAt: x.createdAt,
    }));
  }

  addFlag(ev, time) {
    return this.write(ev, 'public', 'POST', '/section/' + seg(this.l.sectionId) + '/video_time_confused',
      { lessonId: this.l.lessonId, videoId: this.l.mediaId, time: Math.trunc(time) });
  }

  // Echo360 deletes a flag with a GET to this address (same as the original player).
  removeFlag(ev, flag) {
    return this.write(ev, 'public', 'GET', '/lesson/' + seg(this.l.lessonId) + '/video/' + seg(this.l.mediaId)
      + '/confused/' + Math.trunc(flag.time) + '/delete');
  }

  // ---- discussions (visible to the instructor and the class) ----

  discussionBase() {
    return '/api/ui/discussions/lessons/' + seg(this.l.lessonId);
  }

  async discussions() {
    const data = await this.request('GET', this.discussionBase() + '/questions');
    const qs = (data && data.questions) || [];
    return {
      hiddenCount: (data && data.hiddenCount) || 0,
      threads: qs.filter((x) => x && x.question).map((x) => {
        const q = this.mapComment(x.question, null);
        q.replies = (x.responses || []).map((r) => this.mapComment(r, q.id));
        return q;
      }),
    };
  }

  mapComment(c, questionId) {
    const first = c.authorFirstName;
    const last = c.authorLastName;
    const full = first && last ? (first + ' ' + last).trim() : '';
    const roles = Array.isArray(c.authorRoles) ? c.authorRoles : [];
    const ref = c.videoContentRef;
    const refMs = ref && (typeof ref.timestampMillis === 'number' ? ref.timestampMillis
      : ref.content && typeof ref.content.timestamp === 'number' ? ref.content.timestamp : null);
    return {
      id: c.id,
      questionId: questionId || c.questionId || null,
      body: typeof c.body === 'string' ? c.body : '',
      time: typeof refMs === 'number' ? refMs / 1000 : null,
      authorId: c.authorId,
      author: full && !c.isNameHidden ? full : '',
      nameHidden: !!c.isNameHidden || !full,
      instructor: roles.includes('Instructor'),
      ta: roles.includes('TeachingAssistant'),
      mine: !!this.l.userId && c.authorId === this.l.userId,
      likes: c.likeCount || 0,
      liked: !!c.liked,
      saved: !!c.bookmarked,
      hasAttachment: !!c.attachment,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      replies: [],
    };
  }

  postComment(ev, { body, anonymous, time }) {
    const payload = { anonymous: !!anonymous, body, contextType: 'lessons' };
    if (time != null && this.l.mediaId) {
      const ms = Math.trunc(time * 1000);
      payload.videoContentRef = { mediaId: this.l.mediaId, timestampMillis: ms, thumbnailUri: thumbnailFor(this.l.thumbnails, ms) };
    }
    return this.write(ev, 'public', 'POST', this.discussionBase() + '/questions', payload);
  }

  reply(ev, questionId, { body, anonymous }) {
    return this.write(ev, 'public', 'POST', this.discussionBase() + '/questions/' + seg(questionId) + '/responses',
      { anonymous: !!anonymous, body, contextType: 'lessons' });
  }

  commentPath(c) {
    return this.discussionBase() + '/questions/' + (c.questionId
      ? seg(c.questionId) + '/responses/' + seg(c.id)
      : seg(c.id));
  }

  like(ev, c, like) {
    return this.write(ev, 'public', 'PUT', this.commentPath(c) + '/' + (like ? 'like' : 'unlike'));
  }

  deleteComment(ev, c) {
    return this.write(ev, 'public', 'DELETE', this.commentPath(c));
  }

  // Private "save for later" on a post (only you see it).
  save(ev, c, save) {
    return this.write(ev, 'public', 'POST', '/questions/' + seg(c.id) + '/' + (save ? 'bookmark' : 'forget'));
  }
}

// Plausible responses for dry runs so the UI can continue.
function dryRunResult(method, path, body) {
  if (method === 'POST' && /\/notes$/.test(path)) return [{ id: 'dry-' + Date.now(), createdAt: new Date().toISOString() }];
  return {};
}

echo360ClassroomAdapter.api = (lesson) => new Echo360Api(lesson);

// ---- 15-takeover.js ----
// ===================================================================================
// Taking over a page whose original player started before this script ran (a manager
// that injects late; see 00-boot.js). The adapter stops the original player
// (stopOriginal); while ours plays, the original's watch reports are also stopped at the
// network layer, so a viewing is never reported twice, whatever the original still has
// running (a timer, a listener for the page closing):
//   - window.fetch is wrapped: Echo360 looks fetch up at every call;
//   - XMLHttpRequest.prototype.open/send and Navigator.prototype.sendBeacon are wrapped:
//     every request object and every call through navigator is covered, including those
//     of code that kept the constructor or the navigator object from before.
// The browser's own fetch, send or sendBeacon function itself, if code kept it from before
// this ran, cannot be reached by any script: that is why the original player is stopped
// at its source first (unmounted, its videos emptied).
// Our own reports pass: they carry OWN_REQUEST in their fetch options (20-reporter.js).
// When the original player could not be unmounted, its media elements are also kept from
// playing (HTMLMediaElement.prototype.play), so there is never a second sound.
// Each request stopped is counted (boot.blocked) and logged (diagnostics).
// Turned off when the user goes back to the original player; the wrappers then only pass
// calls on.
// ===================================================================================

const OWN_REQUEST = Symbol('lite-player-own-request');

const netGuard = {
  on: false,
  installed: false,
  isReport: (method, url) => false,
  isOriginalMedia: null,   // (element) => boolean while the original's media are held

  start(isReport, isOriginalMedia) {
    this.isReport = isReport;
    this.isOriginalMedia = isOriginalMedia || null;
    this.on = true;
    if (!this.installed) this.install(platform.page);
  },

  stop() {
    this.on = false;
    this.isOriginalMedia = null;
  },

  // A request of the original player that must not go out: counted and logged.
  blocks(method, input) {
    if (!this.on) return false;
    let url = '';
    try { url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), location.href).href; } catch (e) { return false; }
    let hit = false;
    try { hit = this.isReport(String(method || 'GET').toUpperCase(), url); } catch (e) { hit = false; }
    if (hit) {
      boot.blocked++;
      logEvent('info', 'stopped a watch report of the original player (' + boot.blocked + ')');
    }
    return hit;
  },

  install(page) {
    this.installed = true;
    const g = this;
    const fetch0 = page.fetch;
    if (typeof fetch0 === 'function') {
      page.fetch = function fetch(input, init) {
        const method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
        if (!(init && init[OWN_REQUEST]) && g.blocks(method, input)) return Promise.resolve(new page.Response(null, { status: 204 }));
        return fetch0.apply(this, arguments);
      };
    }
    const xhr = page.XMLHttpRequest && page.XMLHttpRequest.prototype;
    if (xhr) {
      const open0 = xhr.open;
      const send0 = xhr.send;
      const opened = new WeakMap();
      xhr.open = function open(method, url) {
        opened.set(this, [method, url]);
        return open0.apply(this, arguments);
      };
      xhr.send = function send() {
        const r = opened.get(this);
        if (r && g.blocks(r[0], r[1])) return undefined;
        return send0.apply(this, arguments);
      };
    }
    const nav = page.Navigator && page.Navigator.prototype;
    if (nav && typeof nav.sendBeacon === 'function') {
      const beacon0 = nav.sendBeacon;
      nav.sendBeacon = function sendBeacon(url) {
        if (g.blocks('POST', url)) return true;
        return beacon0.apply(this, arguments);
      };
    }
    const media = page.HTMLMediaElement && page.HTMLMediaElement.prototype;
    if (media) {
      const play0 = media.play;
      /** @this {HTMLMediaElement} */
      media.play = function play() {
        if (g.on && g.isOriginalMedia && g.isOriginalMedia(this)) {
          try { this.muted = true; this.pause(); } catch (e) { /* gone */ }
          logEvent('info', 'kept a video of the original player from playing');
          return Promise.resolve();
        }
        return play0.apply(this, arguments);
      };
    }
  },
};

// ---- 20-reporter.js ----
// ===================================================================================
// Watch reporting. Mirrors what the original player sends: a session record when playback
// first starts / the page unloads, and a heartbeat every 30 s while playing (plus one on
// pause). Position, rate, volume and the played ranges are read from the real <video>.
// ===================================================================================

class PlayedRanges {
  constructor() { this.ranges = []; }

  add(start, end) {
    if (!(end > start)) return;
    const out = [];
    let s = start;
    let e = end;
    for (const r of this.ranges) {
      if (r[1] < s || r[0] > e) out.push(r);
      else { s = Math.min(s, r[0]); e = Math.max(e, r[1]); }
    }
    out.push([s, e]);
    out.sort((a, b) => a[0] - b[0]);
    this.ranges = out;
  }

  absorb(timeRanges) {
    for (let i = 0; i < timeRanges.length; i++) this.add(timeRanges.start(i), timeRanges.end(i));
  }

  merged(timeRanges) {
    const copy = new PlayedRanges();
    copy.ranges = this.ranges.slice();
    if (timeRanges) copy.absorb(timeRanges);
    return copy.ranges;
  }
}

class Reporter {
  constructor(info, video, played, disposer) {
    this.info = info;
    this.video = video;
    this.played = played;
    this.begun = false;
    this.ended = false;
    this.lastSessionAt = 0;
    this.timer = 0;
    this.captionsAvailable = undefined;
    /** @type {null | (() => { captions: boolean, transcript: boolean })} what the user has on (set by the player) */
    this.stateFn = null;
    this.d = disposer;
    const onUnload = () => this.end();
    this.d.listen(window, 'pagehide', onUnload);
    this.d.add(() => this.detach());
    // The original player validates the session on load; the response may carry a fresh token.
    fetch(info.appUrl + '/api/ui/sessions/' + encodeURIComponent(info.sessionId), { credentials: 'include', headers: this.headers(false), signal: requestSignal() })
      .then((r) => this.saveToken(r))
      .catch((e) => log.info('watch report (session) failed:', e));
  }

  headers(withBody) {
    const h = { Accept: 'application/json' };
    if (withBody) h['Content-Type'] = 'application/json';
    let jwt = null;
    try { jwt = localStorage.getItem('authn-jwt'); } catch (e) { /* ignore */ }
    if (jwt) h.Authorization = 'Bearer ' + jwt;
    return h;
  }

  saveToken(response) {
    const tok = response && response.headers && response.headers.get('token');
    if (tok) { try { localStorage.setItem('authn-jwt', tok); } catch (e) { /* ignore */ } }
    return response;
  }

  post(path, body, retried) {
    // OWN_REQUEST: ours, let through while the original player's reports are stopped
    // (15-takeover.js).
    const sent = fetch(this.info.gatewayUrl + path, /** @type {RequestInit} */ ({
      method: 'POST', credentials: 'include', keepalive: true, headers: this.headers(true), body: JSON.stringify(body), signal: requestSignal(), [OWN_REQUEST]: true,
    }));
    return sent.then((r) => {
      if (r.status === 401 && !retried) {
        return fetch(this.info.gatewayUrl + '/authn/token/refresh-header', { method: 'POST', credentials: 'include', headers: this.headers(false), signal: requestSignal() })
          .then((rr) => this.saveToken(rr))
          .then(() => this.post(path, body, true));
      }
      return r;
    }).catch((e) => log.info('watch report failed:', e));
  }

  mediaState() {
    const v = this.video;
    const ms = (x) => Math.round(1000 * x);
    return {
      playback_rate: Math.round(100 * v.playbackRate),
      played: this.played.merged(v.played).map((r) => ({ start: ms(r[0]), end: ms(r[1]) })),
      position: ms(v.currentTime),
      volume: Math.round(100 * v.volume),
    };
  }

  // Reported as the user actually has them: captions shown, transcript panel open.
  playerState() {
    const s = this.stateFn ? this.stateFn() : {};
    return { caption_active: !!s.captions, caption_available: this.captionsAvailable, transcription_active: !!s.transcript };
  }

  sendSession(lifecycle) {
    const i = this.info;
    this.lastSessionAt = Date.now();
    return this.post('/a/player/session', {
      browser: { referrer: document.referrer, url: location.href },
      context: i.context,
      lifecycle,
      link: i.link,
      media_id: i.mediaId,
      media_state: this.mediaState(),
      player_state: this.playerState(),
      session_id: i.sessionId,
      user: i.user,
    });
  }

  heartbeat() {
    if (!this.begun || this.ended) return;
    if (Date.now() - this.lastSessionAt > 172800000) this.sendSession('SESSION_STALE');
    this.post('/a/player/beacon', {
      media_id: this.info.mediaId, media_state: this.mediaState(), player_state: this.playerState(), session_id: this.info.sessionId,
    });
  }

  onPlay() {
    if (this.ended) return;
    if (!this.begun) { this.begun = true; this.sendSession('SESSION_BEGIN'); }
    clearInterval(this.timer);
    this.timer = setInterval(() => this.heartbeat(), 30000);
  }

  onPause() {
    clearInterval(this.timer);
    this.timer = 0;
    this.heartbeat();
  }

  end() {
    if (!this.begun || this.ended) return;
    clearInterval(this.timer);
    this.sendSession('SESSION_END');
    this.ended = true;
  }

  // Called on dispose (handing over to the original player, which starts its own reporting).
  detach() {
    if (this.begun && !this.ended) this.onPause();
    this.ended = true;
    clearInterval(this.timer);
  }
}

// ---- 30-ui-assets.js ----
// ===================================================================================
// UI assets: inline SVG icons, the stylesheet (injected once into the shadow root) and
// the DOM template. The look follows docs/DESIGN.md: every colour, radius, spacing and
// duration is a token (a CSS custom property) defined at the top of the stylesheet.
// ===================================================================================

// One icon set on a 24px grid. The <svg> wrapper sets the stroke for all of them (see
// svg()), so an icon is only its shapes and cannot drift to another weight. Filled shapes
// mean "on" or "exists" (a bookmark here); small glyphs (the "10") are filled text.
const ICON = {
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M7.5 5.5h2.5v13H7.5zM14 5.5h2.5v13H14z"/>',
  back10: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4h4"/><text x="12.2" y="15.6" font-size="7.5" font-weight="600" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">10</text>',
  fwd10: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4h-4"/><text x="11.8" y="15.6" font-size="7.5" font-weight="600" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">10</text>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  volumeLow: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
  muted: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5m0-5l-5 5"/>',
  fullscreen: '<path d="M4 9V4.5h4.5M20 9V4.5h-4.5M4 15v4.5h4.5M20 15v4.5h-4.5"/>',
  exitFullscreen: '<path d="M8.5 4v4.5H4M15.5 4v4.5H20M8.5 20v-4.5H4M15.5 20v-4.5H20"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  next: '<path d="M9.5 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  swap: '<path d="M5 8h13l-3.5-3.5M19 16H6l3.5 3.5"/>',
  layoutSide: '<rect x="3" y="6" width="8" height="12" rx="1.5"/><rect x="13" y="6" width="8" height="12" rx="1.5"/>',
  layoutPip: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><rect x="12.5" y="11.5" width="5.5" height="4.5" rx="1"/>',
  layoutSingle: '<rect x="3" y="5" width="18" height="14" rx="1.5"/>',
  cc: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M16.5 10.2a2.2 2.2 0 1 0 0 3.6"/>',
  slides: '<rect x="3.5" y="5" width="17" height="11.5" rx="1.5"/><path d="M12 16.5v3M8.5 20h7"/>',
  transcript: '<path d="M5 6.5h14M5 10.5h14M5 14.5h9M5 18.5h6"/>',
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z"/>',
  bookmarkOn: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z" fill="currentColor"/>',
  flag: '<path d="M6 21V4.5M6 5h11l-2.5 4 2.5 4H6"/>',
  flagOn: '<path d="M6 21V4.5"/><path d="M6 5h11l-2.5 4 2.5 4H6z" fill="currentColor"/>',
  notes: '<path d="M6 3.5h9l3 3V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z"/><path d="M9 10h6M9 13.5h6M9 17h4"/>',
  discussion: '<path d="M4.5 5.5h15v10h-9l-4 3.5v-3.5h-2z"/>',
  copyPicture: '<path d="M15.5 5.5V5A1.5 1.5 0 0 0 14 3.5H6A1.5 1.5 0 0 0 4.5 5v8A1.5 1.5 0 0 0 6 14.5h.5"/><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M8.5 17l3.5-3.5 2.5 2.5 1.5-1.5 3.5 3.5"/>',
  copyText: '<path d="M15.5 5.5V5A1.5 1.5 0 0 0 14 3.5H6A1.5 1.5 0 0 0 4.5 5v8A1.5 1.5 0 0 0 6 14.5h.5"/><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M11.5 12.5h5M11.5 15.5h3.5"/>',
  more: '<circle cx="12" cy="5.5" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="12" cy="18.5" r=".9"/>',
  close: '<path d="M6.5 6.5l11 11m0-11l-11 11"/>',
  up: '<path d="M6.5 14.5l5.5-5.5 5.5 5.5"/>',
  down: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
};
const svg = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round">' + ICON[name] + '</svg>';

// Playback speed: the range of the speed control and the stops it snaps to ([ and ] step
// between the stops).
const SPEED_MIN = 0.5;
const SPEED_MAX = 3;
const SPEED_STOPS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SPEED_LABELS = [1, 1.5, 2, 2.5, 3];   // stops labelled under the track

// The light theme's tokens. Only the side panel, popovers and dialogs take them: the
// picture area and the controls over it always use the dark ones.
const LIGHT_TOKENS = `
  --s0: #F2F3F4; --s1: #E7E8EA; --s2: #F8F8F9; --s3: #DCDDE0;
  --line: rgba(0,0,0,.12); --fill: rgba(0,0,0,.06); --fill-2: rgba(0,0,0,.10);
  --text: #232529; --text-2: #555960; --text-3: #8A8D94;
  --accent: #076B75; --on-accent: #FFFFFF; --accent-soft: rgba(7,107,117,.12);
  --hl: rgba(255,186,0,.38); --warn-bg: rgba(181,120,0,.12); --warn-text: #6B4A00;
  --danger: #B3261E; --danger-bg: rgba(179,38,30,.10); --shadow: 0 8px 28px rgba(0,0,0,.16);
  color-scheme: light;`;
const THEMED = '.panel, .pop, .dialog';

const PLAYER_CSS = `
/* max-width, max-height: on a phone, a page wider than the screen (Echo360's root is 100vw
   plus the body's margin) enlarges the area that fixed boxes fill, and the player's right
   edge (the fullscreen button) and bottom ended off the screen. 100vw is the screen's width;
   100dvh the height between the browser's bars (100vh where dvh is unknown). */
:host { all: initial; position: fixed; inset: 0; max-width: 100vw; max-height: 100vh; max-height: 100dvh; z-index: 2147483000; display: block;
  --video: #000; --s0: #18191B; --s1: #222326; --s2: #2C2D31; --s3: #37383D;
  --line: rgba(255,255,255,.10); --fill: rgba(255,255,255,.10); --fill-2: rgba(255,255,255,.16);
  --text: #ECEDEF; --text-2: #A8ABB2; --text-3: #8A8D94;
  --accent: #3DBEC4; --on-accent: #0B2E30; --accent-soft: rgba(61,190,196,.16);
  --volw: ${VOLUME_SLIDER_PX}px; --scrim: rgba(0,0,0,.72); --overlay: rgba(24,25,27,.92); --cap-bg: rgba(0,0,0,.78); --backdrop: rgba(0,0,0,.6);
  --hl: rgba(255,196,0,.40); --warn-bg: rgba(255,170,0,.14); --warn-text: #FFD38A;
  --danger: #FF8A80; --danger-bg: rgba(255,82,82,.14); --shadow: 0 8px 28px rgba(0,0,0,.5);
  --mk-note: #7FA8FF; --mk-bookmark: #FF9F43; --mk-flag: #FF7A93; --mk-comment: #C3A1FF; --mk-last: #FFFFFF;
  --sp1: 4px; --sp2: 8px; --sp3: 12px; --sp4: 16px; --sp6: 24px;
  --r1: 4px; --r2: 8px; --r3: 12px;
  --t-fast: 120ms; --t: 180ms; --ease: cubic-bezier(.2,.8,.2,1);
  --btn: 40px; --panelw: 360px;
  background: var(--video); color: var(--text); color-scheme: dark;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; -webkit-font-smoothing: antialiased; }
@media (pointer: coarse) { :host { --btn: 44px; } }
@media (prefers-reduced-motion: reduce) { :host { --t-fast: 0ms; --t: 0ms; } }
.app[data-theme=light] :is(${THEMED}) { ${LIGHT_TOKENS} }
@media (prefers-color-scheme: light) { .app[data-theme=system] :is(${THEMED}) { ${LIGHT_TOKENS} } }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r2); }
svg { width: 24px; height: 24px; display: block; flex: none; }
.num { font-variant-numeric: tabular-nums; }
.app { position: absolute; inset: 0; }
.stage { position: absolute; inset: 0; overflow: hidden; container: stage / inline-size; --ratio: .5; --pipw: .26; }
.app.panel-open .stage { right: var(--panelw); }

/* ---- buttons: icon buttons and toggles (the same everywhere) ---- */
.btn { position: relative; width: var(--btn); height: var(--btn); display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--r2); flex: none; transition: background-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease); }
.btn:hover { background: var(--fill); }
.btn:active { background: var(--fill-2); }
/* A toggle that is on: the accent colour and a bar under the icon (the bar does not rely on colour). */
:is(.btn, .chip)[aria-pressed=true] { color: var(--accent); }
:is(.btn, .chip)[aria-pressed=true]::after { content: ""; position: absolute; left: 50%; bottom: 3px; width: 16px; height: 2px; margin-left: -8px;
  border-radius: 1px; background: currentColor; }
/* Not available now (the reason is in its tooltip and shown when pressed). */
.btn[aria-disabled=true] { color: var(--text-3); }
.btn[aria-disabled=true]:hover { background: none; }
.pbtn { height: 32px; padding: 0 var(--sp3); border-radius: var(--r2); background: var(--fill); font-size: 13px; }
.pbtn:hover { background: var(--fill-2); }
.pbtn.primary { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.pbtn:disabled { color: var(--text-3); cursor: default; }
@media (pointer: coarse) { .pbtn { min-height: 44px; min-width: 44px; } }
.link { font-size: 12px; color: var(--text-2); padding: 2px 0; }
.link:hover { color: var(--text); text-decoration: underline; }
.link.on { color: var(--accent); }
.link.danger:hover { color: var(--danger); }
@media (pointer: coarse) { .link { min-height: 44px; min-width: 44px; text-align: start; } }

/* ---- title bar and control bar over the picture ---- */
.top, .bottom { position: absolute; left: 0; right: 0; transition: opacity var(--t) var(--ease); }
.top { top: 0; z-index: 4; display: flex; align-items: center; gap: var(--sp2); padding: var(--sp2) var(--sp3) var(--sp6);
  background: linear-gradient(var(--scrim), transparent); }
/* The bar's background (a scrim over the picture) lets clicks through: only its buttons
   and title take them, so toolbars and windows near the top stay usable. */
.top { pointer-events: none; }
.top > * { pointer-events: auto; }
.bottom { bottom: 0; z-index: 4; padding: var(--sp6) var(--sp3) var(--sp1); background: linear-gradient(transparent, var(--scrim)); }
.idle .top, .idle .bottom { opacity: 0; pointer-events: none; }
.idle { cursor: none; }
.back { display: inline-flex; align-items: center; justify-content: center; width: var(--btn); height: var(--btn); border-radius: var(--r2);
  color: inherit; text-decoration: none; flex: none; }
.back:hover { background: var(--fill); }
.title { flex: 0 1 auto; margin-right: auto; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { position: relative; flex: none; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 var(--sp3) 0 var(--sp2);
  border-radius: var(--r2); background: var(--fill); font-size: 13px; }
.chip:hover { background: var(--fill-2); }
.chip svg { width: 18px; height: 18px; }
@media (pointer: coarse) { .chip { height: 44px; } }
.row { display: flex; align-items: center; gap: 2px; height: calc(var(--btn) + 4px); }
.spacer { flex: 1; min-width: 0; }
.row .out { display: none; }
.time { margin: 0 var(--sp2); font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.time .dur, .time .sep { color: var(--text-2); }
/* Narrow bar: the time moves above the progress bar, current time left, length right. */
.bottom.compact .time { position: absolute; left: var(--sp3); right: var(--sp3); top: 2px; margin: 0; display: flex; justify-content: space-between;
  font-size: 12px; pointer-events: none; }
.bottom.compact .time .sep { display: none; }
.vol { display: flex; align-items: center; }
/* The slider opens to the right of the speaker while a mouse is over the control or the
   keyboard focus is in it, and closes after a short pause; the time beside it slides along
   (width transition) instead of jumping. Touch screens never show it. The max-width too:
   Safari keeps about 130 px for a range input of width 0 when it sizes the bar, which on an
   iPhone pushed the layout and fullscreen buttons off the bar. */
.vol input { width: 0; max-width: 0; margin: 0; opacity: 0; visibility: hidden;
  transition: width var(--t) var(--ease) var(--t-fast), max-width var(--t) var(--ease) var(--t-fast), margin var(--t) var(--ease) var(--t-fast), opacity var(--t-fast) linear var(--t-fast), visibility 0s linear calc(var(--t) + var(--t-fast)); }
@media (hover: hover) {
  .vol:hover input, .vol:has(:focus-visible) input, .vol input:active {
    width: var(--volw); max-width: var(--volw); margin: 0 var(--sp2) 0 var(--sp1); opacity: 1; visibility: visible;
    transition: width var(--t) var(--ease), max-width var(--t) var(--ease), margin var(--t) var(--ease), opacity var(--t-fast) linear, visibility 0s; }
  /* MenuBar.fitBar measures the bar with the slider open, so opening it never overflows. */
  .row.measure .vol input { width: var(--volw); max-width: var(--volw); margin: 0 var(--sp2) 0 var(--sp1); transition: none; }
}
.volosd { position: absolute; z-index: 6; left: 50%; top: 18%; transform: translateX(-50%); white-space: nowrap; padding: var(--sp2) var(--sp4); border-radius: var(--r2);
  background: var(--overlay); color: var(--text); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; pointer-events: none;
  opacity: 0; transition: opacity var(--t) var(--ease); }
.volosd.on { opacity: 1; transition: none; }
input[type=range] { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; cursor: pointer;
  background: linear-gradient(to right, var(--text) var(--v, 100%), var(--fill-2) var(--v, 100%)); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: var(--text); }
input[type=range]::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: var(--text); }
.speed { flex: none; min-width: 52px; height: var(--btn); padding: 0 var(--sp2); border-radius: var(--r2); font-size: 14px; font-weight: 600;
  font-variant-numeric: tabular-nums; transition: background-color var(--t-fast) var(--ease); }
.speed:hover, .speed[aria-expanded=true] { background: var(--fill); }

/* ---- progress bar ---- */
.seek { position: relative; height: 20px; margin: 0 2px 2px; cursor: pointer; touch-action: none; --p: 0; --b: 0; --h: 0; }
.bottom.compact .seek { margin-top: 16px; }
.rail { position: absolute; left: 0; right: 0; top: 8px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.22); overflow: hidden;
  transition: transform var(--t-fast) var(--ease); }
.seek:hover .rail, .seek.dragging .rail { transform: scaleY(1.5); }
.bar { position: absolute; inset: 0; transform-origin: 0 50%; }
.buf { background: rgba(255,255,255,.32); transform: scaleX(var(--b)); }
.hov { background: rgba(255,255,255,.26); transform: scaleX(var(--h)); opacity: 0; }
.seek:hover .hov { opacity: 1; }
.fill { background: var(--accent); transform: scaleX(var(--p)); }
.knob-track { position: absolute; inset: 0; transform: translateX(calc(var(--p) * 100%)); pointer-events: none; }
.knob { position: absolute; left: -7px; top: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--accent);
  transform: scale(0); transition: transform var(--t-fast) var(--ease); }
.seek:hover .knob, .seek.dragging .knob, .seek:focus-visible .knob { transform: scale(1); }
@media (pointer: coarse) { .knob { transform: scale(1); } .seek { height: 28px; } .rail { top: 12px; } .knob { top: 7px; } }
.tip { position: absolute; bottom: 24px; left: 0; max-width: 260px; padding: var(--sp1) var(--sp2); border-radius: var(--r2); background: var(--overlay);
  font-size: 12px; transform: translateX(-50%); pointer-events: none; opacity: 0; }
.tip .tt { display: block; font-variant-numeric: tabular-nums; font-weight: 600; }
.tip .tl { display: block; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tip .tl:empty { display: none; }
.seek:hover .tip, .seek.dragging .tip { opacity: 1; }
.tip .pv { display: block; width: 176px; aspect-ratio: 16 / 9; object-fit: contain; margin: 2px 0 var(--sp1); border-radius: var(--r1); background: var(--video); }
.wat { position: absolute; inset: 0; pointer-events: none; }
.wat i { position: absolute; top: 0; bottom: 0; background: rgba(255,255,255,.16); }
.sils, .chaps { position: absolute; inset: 0; }
.chaps i { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--video); }
/* Skippable stretches: silences sparse diagonal lines, empty screens dense dots. */
.sils i { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(135deg, rgba(255,255,255,.6) 0 1.5px, transparent 1.5px 5px); }
.sils i.empty { background: radial-gradient(rgba(255,255,255,.7) .8px, transparent 1px) 0 0 / 3px 3px; }
.marks { position: absolute; left: 0; right: 0; top: 4px; height: 12px; pointer-events: none; }
.marks i { position: absolute; top: 0; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px; background: var(--mk-bookmark); }
/* Markers for timed items: a different shape for each kind as well as a colour. */
.imarks { position: absolute; left: 0; right: 0; top: 0; height: 20px; pointer-events: none; }
.mk { position: absolute; top: 1px; width: 7px; height: 7px; margin-left: -3.5px; background: var(--mk-note); }
.mk-note { border-radius: 50%; box-shadow: 0 0 0 1.5px var(--video); }
.mk-bookmark { width: 6px; height: 8px; margin-left: -3px; background: var(--mk-bookmark); clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 72%, 0 100%); }
.mk-flag { width: 8px; height: 8px; margin-left: -1px; background: var(--mk-flag); clip-path: polygon(0 0, 100% 50%, 0 100%); }
.mk-comment { background: var(--mk-comment); transform: rotate(45deg) scale(.85); }
.mk-laststop { top: 0; width: 2px; height: 14px; margin-left: -1px; border-radius: 1px; background: var(--mk-last); }
/* A-B loop band on the progress bar */
.loopband { position: absolute; top: 3px; height: 14px; z-index: 2; border-radius: var(--r1); pointer-events: none;
  background: rgba(255,255,255,.14); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,.9); min-width: 2px; }
.loopband.open { background: none; }
.loopband .lh { position: absolute; top: -3px; width: 8px; height: 20px; margin-left: -4px; border-radius: 3px; background: #fff;
  pointer-events: auto; cursor: ew-resize; touch-action: none; }
.loopband .la { left: 0; } .loopband .lb { left: 100%; }
.loopband.open .lb { display: none; }
.loopband .lx { position: absolute; right: -8px; top: -24px; width: 20px; height: 20px; padding: 0; border-radius: 50%; font-size: 11px; line-height: 20px;
  text-align: center; background: #fff; color: #000; pointer-events: auto; }

/* ---- the pictures ---- */
.views { position: absolute; inset: 0; }
video, .pdfview { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: contain; background: var(--video); }
[data-slot=off] { display: none !important; }
.l-single :is(video, .pdfview)[data-slot=secondary] { display: none; }
.l-side :is(video, .pdfview)[data-slot=primary] { width: calc(var(--ratio) * 100%); }
.l-side :is(video, .pdfview)[data-slot=secondary] { left: auto; right: 0; width: calc((1 - var(--ratio)) * 100%); }
/* The lecturer's PDF as a picture of its own (see SlideReader). */
.pdfview { background: var(--s1); overflow: hidden; }
.pstage { position: absolute; inset: 0; }
.rpages { position: absolute; inset: 0; }
.pstage .rpage { position: absolute; left: 50%; top: 50%; width: auto; height: auto; max-width: 100%; max-height: 100%; transform: translate(-50%, -50%); }
.pbar { position: absolute; left: 50%; top: 60px; z-index: 3; display: flex; align-items: center; gap: var(--sp1); padding: 2px var(--sp1); border-radius: var(--r3);
  width: max-content; max-width: calc(100% - 16px); overflow: hidden; transform: translateX(-50%); background: var(--overlay); font-size: 12px; white-space: nowrap;
  transition: opacity var(--t) var(--ease); }
.pfollow { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.idle .pbar { opacity: 0; pointer-events: none; }
.pbar .btn { width: 32px; height: 32px; }
.pbar .btn svg { width: 20px; height: 20px; }
.pbar .btn:disabled { color: var(--text-3); background: none; cursor: default; }
.plabel { padding: 0 var(--sp1); font-variant-numeric: tabular-nums; }
.pfile { max-width: 160px; overflow: hidden; text-overflow: ellipsis; padding: 3px 10px; border-radius: var(--r2); background: var(--fill); font-size: 12px; }
.pfile:hover { background: var(--fill-2); }
.pfollow .rback { padding: 3px 10px; font-size: 12px; }
.pfollow .rfollowing { color: var(--text-2); padding: 0 6px; }
.l-pip .pdfview[data-slot=secondary] .pbar { display: none; }
.divider { position: absolute; top: 0; bottom: 0; left: calc(var(--ratio) * 100%); width: 16px; margin-left: -8px; cursor: col-resize; z-index: 3; display: none; touch-action: none; }
.divider::after { content: ""; position: absolute; left: 7px; top: 50%; width: 2px; height: 48px; margin-top: -24px; border-radius: 1px; background: rgba(255,255,255,.35);
  transition: background-color var(--t-fast) var(--ease); }
.divider:hover::after, .divider.dragging::after { background: var(--accent); }
.l-side .divider { display: block; }
/* Swapping the two pictures, on the line between them. */
.swapdot { position: absolute; z-index: 4; left: calc(var(--ratio) * 100%); top: 50%; width: var(--btn); height: var(--btn); margin: -84px 0 0 calc(var(--btn) / -2);
  display: none; align-items: center; justify-content: center; border-radius: 50%; background: var(--overlay); transition: opacity var(--t) var(--ease); }
.swapdot svg { width: 20px; height: 20px; }
.swapdot:hover { background: var(--s3); }
.l-side .swapdot { display: inline-flex; }
.idle .swapdot { opacity: 0; pointer-events: none; }
.l-pip :is(video, .pdfview)[data-slot=secondary], .pipframe { left: auto; top: auto; width: calc(var(--pipw) * 100%); height: auto; aspect-ratio: 16 / 9; }
.l-pip :is(video, .pdfview)[data-slot=secondary] { z-index: 2; border-radius: var(--r2); box-shadow: var(--shadow); }
.pipframe { position: absolute; z-index: 3; display: none; border-radius: var(--r2); cursor: grab; touch-action: none; }
.pipframe.dragging { cursor: grabbing; }
.l-pip .pipframe { display: block; }
.pipframe:hover { box-shadow: inset 0 0 0 2px rgba(255,255,255,.5); }
.grip { position: absolute; width: 20px; height: 20px; opacity: 0; transition: opacity var(--t-fast) var(--ease); touch-action: none; }
.grip::before { content: ""; position: absolute; inset: 5px; border: 2px solid #fff; border-radius: 2px; }
.pipframe:hover .grip { opacity: .9; }
@media (pointer: coarse) { .grip { width: 32px; height: 32px; opacity: .9; } .grip::before { inset: 10px; } }
.l-pip.c-br :is(video, .pdfview)[data-slot=secondary], .l-pip.c-br .pipframe { right: 16px; bottom: 88px; }
.l-pip.c-bl :is(video, .pdfview)[data-slot=secondary], .l-pip.c-bl .pipframe { left: 16px; bottom: 88px; }
.l-pip.c-tr :is(video, .pdfview)[data-slot=secondary], .l-pip.c-tr .pipframe { right: 16px; top: 64px; }
.l-pip.c-tl :is(video, .pdfview)[data-slot=secondary], .l-pip.c-tl .pipframe { left: 16px; top: 64px; }
.c-br .grip { left: 0; top: 0; cursor: nwse-resize; }
.c-bl .grip { right: 0; top: 0; cursor: nesw-resize; }
.c-tr .grip { left: 0; bottom: 0; cursor: nesw-resize; }
.c-tl .grip { right: 0; bottom: 0; cursor: nwse-resize; }
.zmap { position: absolute; z-index: 3; border: 1px solid rgba(255,255,255,.75); border-radius: var(--r1); background: rgba(0,0,0,.4); pointer-events: none; }
.zmap i { position: absolute; border: 1.5px solid #fff; background: rgba(255,255,255,.2); border-radius: 2px; }
.views .zoomed { cursor: grab; }
.views .panning { cursor: grabbing; }

/* ---- things shown over the picture (always dark) ---- */
.captions { position: absolute; left: 50%; bottom: 100px; z-index: 4; transform: translateX(-50%); width: max-content; max-width: min(88%, 52em);
  text-align: center; pointer-events: none; transition: bottom var(--t) var(--ease); --capscale: 1; }
.captions.empty { display: none; }
.idle .captions { bottom: 28px; }
.captions span { padding: .12em .45em; border-radius: var(--r1); background: var(--cap-bg); color: #fff;
  font-size: calc(clamp(15px, 1.8vw, 30px) * var(--capscale)); line-height: 1.5; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.paused.hidecc-paused .captions { display: none; }
.center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none; }
.spinner { width: 44px; height: 44px; border-radius: 50%; border: 3px solid rgba(255,255,255,.2); border-top-color: #fff;
  animation: spin .9s linear infinite; display: none; }
.waiting .spinner { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
/* Paused: a small label in the title bar instead of a big icon over the picture. */
.pausehint { flex: none; display: none; align-items: center; gap: 6px; padding: var(--sp1) 10px var(--sp1) var(--sp2); margin-right: auto;
  border-radius: var(--r2); background: var(--fill); font-size: 12px; pointer-events: none; }
.pausehint svg { width: 14px; height: 14px; }
.paused:not(.waiting) .pausehint { display: inline-flex; }
.paused:not(.waiting) .title { margin-right: 0; }
/* Session renewal in progress, or offline: a small label in the corner, never over the controls. */
:is(.sessionhint, .nethint) { position: absolute; right: var(--sp3); top: 64px; z-index: 5; display: flex; align-items: center; gap: var(--sp2);
  padding: 6px var(--sp3) 6px 10px; border-radius: var(--r2); background: var(--overlay); font-size: 12px; pointer-events: none;
  max-width: calc(100% - 24px); }
/* Offline explains the renewal too (it waits for the network); show one label. */
.nethint:not([hidden]) ~ .sessionhint { display: none; }
.pane.loadfailed > :not(.loaderr) { display: none; }
.loaderr { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp3); padding: var(--sp4); color: var(--text-2); }
.sessionhint i { width: 10px; height: 10px; border-radius: 50%; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; animation: spin .9s linear infinite; }
.toast { position: absolute; z-index: 6; left: 50%; bottom: 100px; transform: translateX(-50%); display: flex; align-items: center; gap: var(--sp3);
  padding: var(--sp2) var(--sp2) var(--sp2) var(--sp4); border-radius: var(--r3); background: var(--overlay); font-size: 13px; box-shadow: var(--shadow);
  width: max-content; max-width: calc(100% - 24px); }
.toast button { flex: none; color: var(--accent); font-weight: 600; padding: 6px 10px; border-radius: var(--r2); }
.toast button:hover { background: var(--fill); }
.skipsil { position: absolute; z-index: 5; right: var(--sp4); bottom: 100px; height: 36px; padding: 0 var(--sp4); border-radius: var(--r2); background: var(--overlay);
  font-size: 13px; box-shadow: var(--shadow); transition: opacity var(--t) var(--ease); }
.skipsil:hover { background: var(--s3); }
.skipsil.fade { opacity: 0; pointer-events: none; }
.endnote { position: absolute; z-index: 5; right: var(--sp4); bottom: 100px; display: flex; align-items: center; gap: var(--sp2); padding: 6px var(--sp2) 6px var(--sp4);
  border-radius: var(--r3); background: var(--overlay); box-shadow: var(--shadow); font-size: 13px; }
.endnote button { height: 30px; padding: 0 var(--sp3); border-radius: var(--r2); background: var(--fill); }
.endnote .endclose { width: 30px; padding: 0; background: none; color: var(--text-2); }
.dropzone { position: absolute; inset: var(--sp3); z-index: 6; display: flex; align-items: center; justify-content: center; border: 2px dashed var(--accent);
  border-radius: var(--r3); background: rgba(0,0,0,.75); font-size: 16px; pointer-events: none; }

/* The time above the progress bar makes the bar taller: notices move up with it. */
.stage:has(.bottom.compact) :is(.toast, .skipsil, .endnote) { bottom: 132px; }
/* A message goes above the Skip button or the end-of-lecture notice, which sit at its height. */
.stage:has(:is(.skipsil, .endnote):not([hidden], .fade)) .toast { bottom: 148px; }
.stage:has(.bottom.compact):has(:is(.skipsil, .endnote):not([hidden], .fade)) .toast { bottom: 180px; }
.stage:has(.bottom.compact) .captions { bottom: 132px; }

/* ---- dialogs (shortcuts, diagnostics, errors) ---- */
.keyhelp, .diagbox, .tdbox, .error { position: absolute; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center; background: var(--backdrop); }
.dialog { max-width: min(640px, calc(100% - 32px)); max-height: calc(100% - 32px); overflow: auto; padding: 20px var(--sp6); border-radius: var(--r3);
  background: var(--s2); color: var(--text); box-shadow: var(--shadow); }
.dialog h2 { margin: 0 0 var(--sp3); font-size: 16px; font-weight: 600; }
.dialog p { margin: 0 0 var(--sp4); color: var(--text-2); }
.dialog .actions { display: flex; justify-content: flex-end; gap: var(--sp2); flex-wrap: wrap; }
.error .dialog { max-width: 440px; }
.khlist { display: grid; grid-template-columns: max-content 1fr; gap: 6px var(--sp4); font-size: 13px; margin-bottom: var(--sp4); }
.khlist kbd { display: inline-block; min-width: 1.6em; padding: 1px 6px; margin-right: var(--sp1); border-radius: var(--r1); text-align: center;
  background: var(--fill); box-shadow: inset 0 -1px 0 var(--line); font: 600 12px/1.6 inherit; font-family: inherit; }
.diaginfo { margin: 0 0 10px; font-size: 13px; }
/* Usage data: one table per kind, scrolling inside the dialog (never the page). */
.tdbody { margin-bottom: var(--sp4); font-size: 13px; color: var(--text-2); }
.tdbody h3 { margin: var(--sp4) 0 var(--sp2); font-size: 13px; font-weight: 600; color: var(--text); }
.tdbody h3:first-child { margin-top: 0; }
.tdscroll { max-height: 40vh; overflow: auto; border-radius: var(--r2); background: var(--s1); }
.tdscroll table { border-collapse: collapse; font: 12px/1.4 ui-monospace, monospace; color: var(--text); }
.tdscroll th, .tdscroll td { padding: 4px var(--sp2); text-align: left; white-space: nowrap; border-bottom: 1px solid var(--line); }
.tdscroll th { position: sticky; top: 0; background: var(--s1); font-weight: 600; }
.tdrec { margin-top: var(--sp2); }
.tdrec summary { padding: var(--sp1) 0; cursor: pointer; color: var(--text); font-variant-numeric: tabular-nums; }
.tdrec .tdscroll th { position: static; font-weight: 400; color: var(--text-2); }
@media (pointer: coarse) { .tdrec summary { min-height: 44px; display: flex; align-items: center; } }
.pbtn.danger { background: var(--danger-bg); color: var(--danger); font-weight: 600; }
.diagtext { max-height: 50vh; overflow: auto; margin: 0 0 var(--sp4); padding: 10px var(--sp3); border-radius: var(--r2); background: var(--s1);
  font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }

/* ---- popovers, menus and the settings menu (see 32-ui-kit.js) ---- */
.layer { position: absolute; inset: 0; z-index: 9; pointer-events: none; }
.layer > * { pointer-events: auto; }
.pop { position: absolute; left: 0; top: 0; min-width: 220px; max-width: min(360px, calc(100% - 16px)); overflow: auto; overscroll-behavior: contain;
  padding: 6px; border-radius: var(--r3); background: var(--s2); color: var(--text); box-shadow: var(--shadow), 0 0 0 1px var(--line);
  transition: opacity var(--t) var(--ease), transform var(--t) var(--ease); }
.pop:focus-visible { outline: none; }
.pop.entering { opacity: 0; transform: translateY(var(--from, 4px)); }
.pop.sheet { left: 0 !important; right: 0; top: auto !important; bottom: 0; max-width: none; width: auto !important; max-height: 75% !important;
  border-radius: var(--r3) var(--r3) 0 0; padding: var(--sp2) var(--sp2) calc(var(--sp4) + env(safe-area-inset-bottom, 0px)); }
.pop.sheet.entering { transform: translateY(24px); }
.mi { display: flex; align-items: center; gap: var(--sp3); width: 100%; min-height: 36px; padding: 6px 10px; border-radius: var(--r2); text-align: left; font-size: 13px; }
@media (pointer: coarse) { .mi { min-height: 44px; } }
.mi:hover:not([aria-disabled=true]), .mi:focus-visible { background: var(--s3); outline-offset: -2px; }
.mi .lbl { flex: 1; min-width: 0; }
.mi .desc { display: block; margin-top: 2px; font-size: 12px; color: var(--text-2); line-height: 1.35; }
.mi .val { color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.mi .key { color: var(--text-2); font-size: 12px; min-width: 1.2em; text-align: right; }
.mi svg { width: 20px; height: 20px; color: var(--text-2); }
.mi .tick { width: 20px; height: 20px; flex: none; color: var(--accent); }
.mi[aria-checked=false] .tick svg { visibility: hidden; }
.mi[aria-disabled=true] { color: var(--text-3); cursor: default; }
.mi[aria-disabled=true] .desc, .mi[aria-disabled=true] .val { color: var(--text-3); }
.mi .sw { position: relative; flex: none; width: 32px; height: 18px; border-radius: 9px; background: var(--fill-2); box-shadow: inset 0 0 0 1px var(--line);
  transition: background-color var(--t-fast) var(--ease); }
.mi .sw::after { content: ""; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--text-2);
  transition: transform var(--t-fast) var(--ease), background-color var(--t-fast) var(--ease); }
.mi[aria-checked=true] .sw { background: var(--accent); box-shadow: none; }
.mi[aria-checked=true] .sw::after { transform: translateX(14px); background: var(--on-accent); }
.mhead { display: flex; align-items: center; gap: var(--sp1); padding: 2px 2px 6px; margin-bottom: var(--sp1); border-bottom: 1px solid var(--line); font-size: 13px; font-weight: 600; }
.mhead .btn { width: 32px; height: 32px; }
.mhead .btn svg { width: 20px; height: 20px; }
@media (pointer: coarse) { .mhead .btn { width: 44px; height: 44px; } }
.mgroup { padding: var(--sp2) 10px var(--sp1); font-size: 12px; color: var(--text-2); }
.mtext { padding: var(--sp1) 10px var(--sp2); font-size: 12px; line-height: 1.4; color: var(--text-2); }
.mtext.warn { color: var(--warn-text); }
.msep { height: 1px; margin: 6px var(--sp1); background: var(--line); }
.mfoot { padding: var(--sp2) 10px 2px; font-size: 12px; color: var(--text-2); }
.mrow { display: flex; align-items: center; gap: var(--sp2); padding: var(--sp1) 10px; font-size: 13px; }
.mrow .grow { color: var(--text-2); }
.tooltip { position: absolute; left: 0; top: 0; max-width: 280px; padding: var(--sp1) var(--sp2); border-radius: var(--r1); background: var(--s3); color: var(--text);
  font-size: 12px; line-height: 1.35; pointer-events: none !important; box-shadow: var(--shadow); }
/* The speed control */
.spd { width: 320px; max-width: 100%; padding: var(--sp2) var(--sp3) var(--sp1); }
.pop.sheet .spd { width: auto; }
.spd-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp3); }
.spd-head span { font-size: 13px; color: var(--text-2); }
.spd-val { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.spd-track { position: relative; height: 44px; margin: 0 var(--sp2); cursor: pointer; touch-action: none; }
.spd-track:focus-visible { outline-offset: 0; }
.spd-rail { position: absolute; left: 0; right: 0; top: 21px; height: 2px; border-radius: 1px; background: var(--fill-2); }
.spd-fill { position: absolute; left: 0; top: 21px; height: 2px; border-radius: 1px; background: var(--accent); width: calc(var(--f) * 100%); }
.spd-stop { position: absolute; top: 16px; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px; background: var(--text-3); }
.spd-stop.on { background: var(--accent); }
.spd-thumb { position: absolute; top: 12px; left: calc(var(--f) * 100%); width: 20px; height: 20px; margin-left: -10px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft); transition: left var(--t-fast) var(--ease); }
.spd-track.dragging .spd-thumb { transition: none; }
.spd-labels { position: relative; height: 32px; margin: 0 var(--sp2); }
.spd-labels button { position: absolute; top: 0; height: 32px; min-width: 32px; padding: 0 var(--sp1); transform: translateX(-50%); border-radius: var(--r2);
  font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.spd-labels button:hover { background: var(--fill); color: var(--text); }
.spd-labels button.on { color: var(--accent); font-weight: 600; }
@media (pointer: coarse) { .spd-labels { height: 44px; } .spd-labels button { height: 44px; min-width: 44px; } }

/* ---- side panel ---- */
.panel { position: absolute; top: 0; right: 0; bottom: 0; width: var(--panelw); z-index: 5; display: flex; flex-direction: column;
  background: var(--s0); color: var(--text); border-left: 1px solid var(--line); }
.presize { position: absolute; left: -5px; top: 0; bottom: 0; width: 10px; cursor: col-resize; touch-action: none; }
.phead { display: flex; align-items: center; gap: 6px; padding: 10px var(--sp2) 6px var(--sp3); }
.tabs { display: flex; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.tabs button { position: relative; height: 32px; padding: 0 10px; border-radius: var(--r2); font-size: 13px; color: var(--text-2); white-space: nowrap; }
.tabs button:hover { background: var(--fill); color: var(--text); }
.tabs button[aria-selected=true] { color: var(--text); font-weight: 600; }
.tabs button[aria-selected=true]::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: 0; height: 2px; border-radius: 1px; background: var(--accent); }
@media (pointer: coarse) { .tabs button { height: 44px; } }
.phead .btn { width: 32px; height: 32px; }
.phead .btn svg, .psearch .btn svg { width: 20px; height: 20px; }
@media (pointer: coarse) { .phead .btn, .psearch .btn { width: 44px; height: 44px; } }
.pane { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pane[data-pane=notes], .pane[data-pane=discussion], .pane[data-pane=slides] { overflow-y: auto; padding: 0 var(--sp3) var(--sp4); overscroll-behavior: contain; }
.psearch { display: flex; align-items: center; gap: 2px; padding: 0 var(--sp2) var(--sp2) var(--sp3); }
.psearch .btn { width: 32px; height: 32px; }
.tsearch { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--r2); background: var(--s1); color: inherit; font: inherit; font-size: 13px; }
.tsearch:focus { border-color: var(--accent); }
.tcount { min-width: 4.5em; padding: 0 var(--sp1); font-size: 12px; text-align: right; white-space: nowrap; color: var(--text-2); font-variant-numeric: tabular-nums; }
.tlist { flex: 1; overflow-y: auto; padding: 2px 6px 56px; overscroll-behavior: contain; }
.trow { display: flex; gap: 10px; padding: 6px var(--sp2); border-radius: var(--r2); cursor: pointer; font-size: 14px; line-height: 1.45;
  content-visibility: auto; contain-intrinsic-size: auto 44px; }
.trow:hover { background: var(--fill); }
.trow .ts { flex: none; width: 4.4em; padding-top: 2px; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--text-2); }
.trow.cur { background: var(--accent-soft); }
.trow.cur .ts { color: var(--accent); }
/* Only the matched characters are marked (a background on the whole text, a block here,
   fell on its last lines whatever line the match was on). */
.trow .tx mark { background: var(--hl); color: inherit; border-radius: 2px; }
.tback { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); white-space: nowrap; height: 32px; padding: 0 14px; border-radius: var(--r2);
  background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 600; box-shadow: var(--shadow); }
.pextras { margin: 0 var(--sp3) var(--sp2); padding: var(--sp2) 10px; border-radius: var(--r2); background: var(--warn-bg); font-size: 12px; line-height: 1.45; }
.pextras button { margin-top: var(--sp1); }
.pinfo { margin: 2px 0 10px; font-size: 12px; line-height: 1.45; color: var(--text-2); }
.pwarn { margin-bottom: var(--sp2); padding: 7px 10px; border-radius: var(--r2); background: var(--warn-bg); color: var(--warn-text); font-size: 12px; line-height: 1.4; }
.perror { margin-bottom: 10px; padding: 7px 10px; border-radius: var(--r2); background: var(--danger-bg); color: var(--danger); font-size: 12px; }
.pempty { padding: var(--sp6) var(--sp2); text-align: center; font-size: 13px; color: var(--text-2); line-height: 1.5; }
.pmuted { font-size: 12px; color: var(--text-2); }
/* Marking a moment for the instructor (Notes tab). */
.flagrow { display: flex; align-items: center; gap: var(--sp2); flex-wrap: wrap; margin: 0 0 var(--sp3); padding: var(--sp2) 10px; border-radius: var(--r2);
  background: var(--s1); font-size: 12px; }
.flagrow .pbtn { display: inline-flex; align-items: center; gap: 6px; }
.flagrow .pbtn svg { width: 18px; height: 18px; color: var(--mk-flag); }
.flagrow .pbtn.armed { background: var(--accent); color: var(--on-accent); }
.flagrow .pbtn.armed svg { color: inherit; }
.flagrow .who { color: var(--text-2); }
.composer { display: flex; flex-direction: column; gap: var(--sp2); margin-bottom: var(--sp3); }
.composer.reply { margin: 10px 0 0; }
.input { width: 100%; padding: var(--sp2) 10px; border: 1px solid var(--line); border-radius: var(--r2); background: var(--s1);
  color: inherit; font: inherit; font-size: 13px; line-height: 1.45; resize: vertical; }
.input:focus { border-color: var(--accent); }
.input.small { width: auto; padding: var(--sp1) var(--sp2); }
@media (pointer: coarse) { .input.small { min-height: 44px; } }
select.input option { background: var(--s1); color: var(--text); }
.crow, .ptools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.ptools { margin-bottom: 10px; }
.grow { flex: 1; }
.check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.check input { accent-color: var(--accent); }
.counter { color: var(--text-2); } .counter.over { color: var(--danger); }
.plist { display: flex; flex-direction: column; gap: var(--sp2); }
.card { padding: 10px var(--sp3); border-radius: var(--r2); background: var(--s1); border-left: 3px solid transparent; }
.card.k-note { border-left-color: var(--mk-note); } .card.k-bookmark { border-left-color: var(--mk-bookmark); } .card.k-flag { border-left-color: var(--mk-flag); }
.ihead { display: flex; align-items: center; gap: var(--sp2); flex-wrap: wrap; font-size: 12px; }
.ibody { margin-top: 6px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.iactions, .cactions { display: flex; gap: 14px; flex-wrap: wrap; margin-top: var(--sp2); }
.kind { font-weight: 600; }
.chiptime { height: 22px; padding: 0 var(--sp2); border-radius: var(--r1); background: var(--accent-soft); color: var(--accent); font-size: 12px; font-variant-numeric: tabular-nums; }
.chiptime:hover { background: var(--fill-2); }
.author { font-weight: 600; font-size: 13px; }
.badge { padding: 1px 6px; border-radius: var(--r1); font-size: 11px; }
.badge.inst { background: var(--accent-soft); color: var(--accent); }
.comment + .comment { margin-top: 10px; }
.replies { margin-top: 10px; padding-left: var(--sp3); border-left: 2px solid var(--line); }
.comment.reply .ibody { font-size: 13px; }
/* Tags (local, private) */
.itags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.tagchip, .tagopt { display: inline-flex; align-items: center; gap: 5px; padding: 2px var(--sp2) 2px 6px; border-radius: var(--r1);
  background: var(--fill); color: inherit; font: inherit; font-size: 12px; border: 0; cursor: pointer; }
.tagchip i, .tagopt i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.tagopt { color: var(--text-2); } .tagopt.on { color: var(--text); background: var(--fill-2); box-shadow: inset 0 0 0 1px var(--line); }
.tagopt:hover, .tagchip:hover { background: var(--fill-2); }
.tagpick { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px; padding: var(--sp2); border-radius: var(--r2); background: var(--fill); }
.tagnew { flex-basis: 100%; display: flex; gap: var(--sp2); align-items: center; }
.tagnew input { flex: 1; min-width: 0; }
.addtag { font-size: 12px; }
.tagman { padding: 10px var(--sp3); margin-bottom: 10px; border-radius: var(--r2); background: var(--s1); display: flex; flex-direction: column; gap: var(--sp2); }
.tagrow { display: flex; gap: var(--sp2); align-items: center; }
.tagrow input { flex: 1; min-width: 0; }
.tagswatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--line); cursor: pointer; flex: none; padding: 0; }
/* Slides tab and the PDF reader */
.sstatus { padding: var(--sp1) 2px var(--sp2); font-size: 12px; color: var(--text-2); }
.sscreen { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 2px var(--sp2); font-size: 12px; }
.sscreen:empty { display: none; }
.sscreen > span { color: var(--text-2); }
.sview { padding: 2px var(--sp2); border-radius: var(--r1); border: 1px solid var(--line); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.sview.on { background: var(--fill-2); border-color: var(--accent); }
.slist { display: flex; flex-direction: column; gap: var(--sp2); }
.scard { display: flex; gap: 10px; align-items: flex-start; width: 100%; padding: 6px; border-radius: var(--r2); text-align: left; }
.scard:hover { background: var(--fill); }
.scard.cur { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.scard img, .scard .noimg { flex: none; width: 128px; aspect-ratio: 16 / 9; border-radius: var(--r1); background: var(--s1); object-fit: contain; }
.smeta { min-width: 0; flex: 1; }
.stitle { display: flex; justify-content: space-between; gap: var(--sp2); font-size: 13px; font-weight: 600; }
.stitle .st { font-weight: 400; color: var(--text-2); font-variant-numeric: tabular-nums; }
.ssaid { margin-top: 3px; font-size: 12px; line-height: 1.35; color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.reader { padding: var(--sp1) 0 var(--sp2); }
.rstage { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--r1); overflow: hidden; background: #fff; }
.rpage { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; transition: opacity var(--t) var(--ease); }
.rpage.in { opacity: 1; }
.rstale { position: absolute; inset: 0; z-index: 1; display: none; align-items: center; justify-content: center; padding: var(--sp3); text-align: center;
  font-size: 13px; font-weight: 600; color: #fff; background: rgba(20,20,24,.72); }
.stale > .rstale { display: flex; }
.pstage .rstale { z-index: 2; font-size: 15px; }
.rbar { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.rnav { width: 32px; height: 32px; border-radius: var(--r2); font-size: 20px; line-height: 1; }
.rnav:hover:not(:disabled) { background: var(--fill); }
.rnav:disabled { color: var(--text-3); cursor: default; }
@media (pointer: coarse) { .rnav { width: 44px; height: 44px; } }
.rlabel { flex: 1; text-align: center; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rfollow { margin-top: 6px; text-align: center; font-size: 12px; }
.rfollowing { color: var(--text-2); }
.rback { padding: 5px var(--sp3); border-radius: var(--r2); background: var(--accent); color: var(--on-accent); font-weight: 600; }
.rtimes { display: flex; flex-wrap: wrap; gap: var(--sp1); align-items: center; margin-top: var(--sp2); font-size: 12px; }
.rtl { color: var(--text-2); margin-right: 2px; }
.rtime { padding: 2px var(--sp2); border-radius: var(--r1); background: var(--fill); font-variant-numeric: tabular-nums; }
.rtime:hover { background: var(--fill-2); }
.rfix { margin-top: var(--sp2); font-size: 12px; }
.rfix summary { cursor: pointer; color: var(--text-2); }
.rfix[open] summary { color: var(--text); margin-bottom: var(--sp1); }
.rfixbtn { display: block; width: 100%; text-align: left; padding: 5px var(--sp2); border-radius: var(--r2); }
.rfixbtn:hover { background: var(--fill); }
.rmain { display: block; width: 100%; margin-top: 6px; padding: 6px var(--sp2); border-radius: var(--r2); font-size: 12px; background: var(--fill); }
.rmain:hover { background: var(--fill-2); }
.chaptoggle { display: block; margin: 6px 0; padding: var(--sp1) 0; font-size: 12px; color: var(--accent); }
.sdeck { padding: var(--sp2) 2px var(--sp1); border-bottom: 1px solid var(--line); margin-bottom: 6px; }
.sfiles { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sfile { display: inline-flex; align-items: center; gap: var(--sp1); max-width: 100%; padding: 3px var(--sp1) 3px 10px; border-radius: var(--r2); background: var(--fill); font-size: 12px; }
.sfname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
button.sfname { padding: 0; font-size: inherit; text-align: left; }
button.sfname:hover { text-decoration: underline; }
.sfile:has(> .sfname[aria-pressed=true]) { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.sfremove { width: 22px; height: 22px; border-radius: var(--r1); font-size: 11px; color: var(--text-2); }
.sfremove:hover { background: var(--fill-2); color: var(--text); }
.sfadd { padding: var(--sp1) 10px; border-radius: var(--r2); font-size: 12px; color: var(--accent); }
.sfadd:hover { background: var(--accent-soft); }
@media (pointer: coarse) { button.sfname, .pfile { min-height: 44px; } .sfremove { width: 44px; height: 44px; } }
.sdmsg { margin-top: 6px; font-size: 12px; line-height: 1.4; color: var(--text-2); }

/* A phone (a touch screen under 600 px across, upright or on its side): no 10 s jump
   buttons; the progress bar is the way to move, and the bar keeps room for the rest. */
@media (pointer: coarse) and (max-width: 600px), (pointer: coarse) and (max-height: 500px) {
  .row .rew, .row .fwd { display: none; }
}
/* ---- narrow windows ---- */
@media (max-width: 720px) {
  .app.panel-open .stage { right: 0; }
  .panel { width: 100%; }
  .presize { display: none; }
}
/* A phone held upright: the video on top at its own shape (16:9, between 200 px and half
   the height), the panel below it, as video apps do on phones. */
@media (max-width: 720px) and (orientation: portrait) {
  .app { --stageh: clamp(200px, 56.25vw, 50%); }
  .app.panel-open .stage { bottom: auto; height: var(--stageh); }
  .panel { top: var(--stageh); border-left: 0; border-top: 1px solid var(--line); }
  .app.panel-open .swapdot { margin-top: calc(var(--btn) / -2); }
}
/* The bars follow the video area's width, not the window's: an open panel narrows it. */
@container stage (max-width: 720px) {
  .top .chip .lbl { display: none; }
  .top .chip { padding: 0 var(--sp2); background: none; }
}
@container stage (max-width: 560px) {
  .top { padding: var(--sp1) var(--sp2) 20px; gap: var(--sp1); }
  .paused:not(.waiting) .pausehint { display: none; }
  .paused:not(.waiting) .title { margin-right: auto; }
  .bottom { padding: 20px var(--sp1) var(--sp1); }
}
/* Hidden controls take no clicks or taps at all: children that re-enable pointer events
   for themselves (the title bar's buttons, the loop band's handles) must not stay
   clickable while invisible. (Repeated after every other rule, so it always wins.) */
.stage.idle .top *, .stage.idle .bottom * { pointer-events: none; }
`;

function playerTemplate() {
  return `
<div class="app" data-theme="system">
<div class="stage paused l-single c-br">
  <div class="views">
    <video class="clock" playsinline preload="auto" data-slot="primary"></video>
    <video class="follower" playsinline preload="auto" muted data-slot="secondary"></video>
    <div class="pdfview" data-slot="off">
      <div class="pstage"></div>
      <div class="pbar">
        <button class="btn pprev" aria-label="${tr('prevPage')}" data-tip="${tr('prevPage')}">${svg('back')}</button>
        <span class="plabel"></span>
        <button class="btn pnext" aria-label="${tr('nextPage')}" data-tip="${tr('nextPage')}">${svg('next')}</button>
        <button class="pfile" hidden></button>
        <span class="pfollow"></span>
        <button class="btn pswap" aria-label="${tr('pdfSwap')}" data-tip="${tr('pdfSwap')}">${svg('swap')}</button>
        <button class="btn pdfclose" aria-label="${tr('pdfMainClose')}" data-tip="${tr('pdfMainClose')}">${svg('close')}</button>
      </div>
    </div>
    <div class="divider" role="separator" aria-orientation="vertical" aria-label="${tr('resizeViews')}" tabindex="0"></div>
    <button class="swapdot" aria-label="${tr('swapViews')}" data-tip="${tr('swapViewsKey')}">${svg('swap')}</button>
    <div class="pipframe" title="${tr('pipHint')}"><div class="grip" title="${tr('resizePip')}"></div></div>
  </div>
  <div class="captions" hidden><span></span></div>
  <div class="center"><div class="spinner"></div></div>
  <div class="nethint" role="status" hidden><span>${tr('offlineHint')}</span></div>
  <div class="sessionhint" role="status" hidden><i></i><span>${tr('sessionRenewing')}</span></div>
  <div class="top">
    <a class="back" aria-label="${tr('back')}" data-tip="${tr('back')}">${svg('back')}</a>
    <div class="title"></div>
    <span class="pausehint" aria-hidden="true">${svg('pause')}<span>${tr('pausedHint')}</span></span>
    <button class="chip tbtn" data-open="transcript" hidden aria-pressed="false" data-tip="${tr('transcriptKey')}">${svg('transcript')}<span class="lbl">${tr('transcript')}</span></button>
    <button class="chip tbtn" data-open="slides" hidden aria-pressed="false" data-tip="${tr('slides')}">${svg('slides')}<span class="lbl">${tr('slides')}</span></button>
    <button class="chip tbtn" data-open="notes" hidden aria-pressed="false" data-tip="${tr('notes')}">${svg('notes')}<span class="lbl">${tr('notes')}</span></button>
    <button class="chip tbtn" data-open="discussion" hidden aria-pressed="false" data-tip="${tr('discussion')}">${svg('discussion')}<span class="lbl">${tr('discussion')}</span></button>
    <button class="btn morebtn" aria-label="${tr('moreMenu')}" data-tip="${tr('moreMenu')}" aria-haspopup="menu" aria-expanded="false">${svg('more')}</button>
  </div>
  <div class="bottom">
    <div class="seek" role="slider" aria-label="${tr('seek')}" tabindex="0">
      <div class="rail"><div class="wat"></div><div class="bar buf"></div><div class="sils"></div><div class="chaps"></div><div class="bar hov"></div><div class="bar fill"></div></div>
      <div class="imarks"></div>
      <div class="marks"></div>
      <div class="knob-track"><div class="knob"></div></div>
      <div class="tip"><img class="pv" alt="" hidden><span class="tt">0:00</span><span class="tl"></span></div>
    </div>
    <div class="row">
      <button class="btn play" aria-label="${tr('play')}" data-tip="${tr('playKey')}">${svg('play')}</button>
      <button class="btn rew" aria-label="${tr('rewind')}" data-tip="${tr('rewindKey')}">${svg('back10')}</button>
      <button class="btn fwd" aria-label="${tr('forward')}" data-tip="${tr('forwardKey')}">${svg('fwd10')}</button>
      <div class="vol" data-bar="mute">
        <button class="btn mute" aria-label="${tr('mute')}" data-tip="${tr('muteKey')}">${svg('volume')}</button>
        <input class="volume" type="range" min="0" max="1" step="0.01" aria-label="${tr('volume')}">
      </div>
      <div class="time"><span class="cur">0:00</span><span class="sep"> / </span><span class="dur">0:00</span></div>
      <div class="spacer"></div>
      <button class="speed" aria-haspopup="dialog" aria-expanded="false" aria-label="${tr('speed')}" data-tip="${tr('speedKey')}">1×</button>
      <button class="btn ccbtn" data-bar="captions" aria-pressed="false" aria-disabled="true" aria-label="${tr('captions')}" data-tip="${tr('captionsLoading')}">${svg('cc')}</button>
      <button class="btn bmbtn" data-bar="bookmark" hidden aria-pressed="false" aria-label="${tr('bookmark')}" data-tip="${tr('bookmarkKey')}">${svg('bookmark')}</button>
      <button class="btn framebtn" data-bar="copyPicture" aria-label="${tr('copyFrame')}" data-tip="${tr('copyFrameKey')}">${svg('copyPicture')}</button>
      <button class="btn textbtn" data-bar="copyText" aria-label="${tr('copyCaptions')}" data-tip="${tr('copyCaptionsKey')}">${svg('copyText')}</button>
      <button class="btn layout" aria-label="${tr('layout')}">${svg('layoutSide')}</button>
      <button class="btn fs" aria-label="${tr('fullscreen')}" data-tip="${tr('fullscreenKey')}">${svg('fullscreen')}</button>
    </div>
  </div>
  <button class="skipsil fade" tabindex="-1"></button>
  <div class="endnote" hidden role="status"><span>${tr('contentEnded')}</span>
    <button class="endskip">${tr('contentEndSkip')}</button><button class="endstop">${tr('contentEndStop')}</button>
    <button class="endclose" aria-label="${tr('close')}">${svg('close')}</button></div>
  <div class="volosd" role="status"></div>
  <div class="toast" hidden role="status"><span class="msg"></span><button class="act"></button></div>
  <div class="dropzone" hidden>${tr('dropSlides')}</div>
  <div class="error" hidden><div class="dialog" role="alertdialog"><h2></h2><p></p><div class="actions"></div></div></div>
  <div class="keyhelp" hidden><div class="dialog" role="dialog" aria-label="${tr('keysTitle')}"><h2>${tr('keysTitle')}</h2><div class="khlist"></div>
    <div class="actions"><button class="pbtn khclose">${tr('close')}</button></div></div></div>
  <div class="diagbox" hidden><div class="dialog" role="dialog" aria-label="${tr('diagTitle')}"><h2>${tr('diagTitle')}</h2>
    <p class="diaginfo">${tr('diagInfo')}</p><pre class="diagtext"></pre>
    <div class="actions"><button class="pbtn diagcopy">${tr('diagCopy')}</button><button class="pbtn diagclose">${tr('close')}</button></div></div></div>
  <div class="tdbox" hidden><div class="dialog" role="dialog" aria-labelledby="tdtitle"><h2 class="tdtitle" id="tdtitle"></h2><div class="tdbody"></div>
    <div class="actions tdactions"></div></div></div>
</div>
<aside class="panel" hidden aria-label="${tr('sidebarTabs')}">
  <div class="presize" title="${tr('resizePanel')}"></div>
  <div class="phead">
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="transcript" hidden>${tr('transcript')}</button>
      <button role="tab" data-tab="slides" hidden>${tr('slides')}</button>
      <button role="tab" data-tab="notes" hidden>${tr('notes')}</button>
      <button role="tab" data-tab="discussion" hidden>${tr('discussion')}</button>
    </div>
    <button class="btn panelclose" aria-label="${tr('closePanel')}" data-tip="${tr('closePanel')}">${svg('close')}</button>
  </div>
  <div class="pextras" hidden><div class="msg"></div><button class="link">${tr('useOriginal')}</button></div>
  <section class="pane" data-pane="transcript" hidden>
    <div class="psearch">
      <input class="tsearch" type="search" placeholder="${tr('searchTranscript')}" aria-label="${tr('searchTranscript')}">
      <span class="tcount" aria-live="polite"></span>
      <button class="btn tprev" aria-label="${tr('prevMatch')}" data-tip="${tr('prevMatch')}">${svg('up')}</button>
      <button class="btn tnext" aria-label="${tr('nextMatch')}" data-tip="${tr('nextMatch')}">${svg('down')}</button>
    </div>
    <div class="tlist" tabindex="0"></div>
    <button class="tback" hidden>${tr('backToCurrent')}</button>
  </section>
  <section class="pane" data-pane="slides" hidden></section>
  <section class="pane" data-pane="notes" hidden></section>
  <section class="pane" data-pane="discussion" hidden></section>
</aside>
<div class="layer"></div>
</div>`;
}

// ---- 32-ui-kit.js ----
// ===================================================================================
// Shared UI components (docs/DESIGN.md "Components"). Every menu and popup of the player
// is made from these; no part positions, opens or closes one by itself.
//
//   Popovers      one popover open at a time, anchored to the button that opened it
//                 (above for the control bar, below for the title bar), moved inward at
//                 the edges, a bottom sheet when the player is phone-narrow; closes on
//                 Esc and on a press outside, and gives the focus back to its button.
//   SettingsMenu  a menu of items with second-level pages and a back button.
//   Tooltips      a label above or below a control, for a mouse or keyboard only; the
//                 same text is always the control's accessible name or in a menu too.
//   setPressed, setUnavailable, unavailableReason   on/off and "not now (why)" states
//                 of buttons (drawn by the stylesheet, not by colour alone).
// ===================================================================================

function setPressed(btn, on) {
  btn.setAttribute('aria-pressed', String(!!on));
}

// A control that cannot be used now: dimmed; its tooltip says why, and so does a press
// (a touch screen has no tooltips). reason '' makes it usable again with its tooltip `tip`.
function setUnavailable(btn, reason, tip) {
  btn.setAttribute('aria-disabled', String(!!reason));
  btn.dataset.reason = reason || '';
  btn.dataset.tip = reason || tip;
}

// An inline SVG icon in a span (el() sets only text).
function iconEl(name, cls) {
  const s = el('span' + (cls ? '.' + cls : ''));
  s.innerHTML = svg(name);
  return s;
}

function unavailableReason(btn) {
  return btn.getAttribute('aria-disabled') === 'true' ? btn.dataset.reason || '' : '';
}

class Popovers {
  // box: where popovers are placed (covers the whole player); onChange(open) after each
  // open and close.
  constructor(box, disposer, onChange) {
    this.box = box;
    this.d = disposer;
    this.cur = null;   // { pop, anchor, placement, onClose }
    this.pointerAt = 0;   // time of the last press (a popover opened by one does not focus an item)
    this.onChange = onChange || (() => {});
    // A press outside the open popover and its button closes it (the button's own click
    // toggles it).
    disposer.listen(box.getRootNode(), 'pointerdown', (e) => {
      this.pointerAt = performance.now();
      const c = this.cur;
      if (!c) return;
      const path = e.composedPath();
      if (path.includes(c.pop.el) || (c.anchor.nodeType && path.includes(c.anchor))) return;
      this.close(false);
    }, true);
    disposer.listen(windowOf(box), 'resize', () => this.place());
    disposer.add(() => this.close(false));
  }

  // A popover element (filled by the caller). role: 'menu' (arrow keys move between its
  // items) or 'dialog'.
  create(cls, role, label) {
    const elem = el('div.pop.' + cls, { role, 'aria-label': label, tabindex: '-1', hidden: true });
    this.box.append(elem);
    const pop = { el: elem, role };
    this.d.listen(elem, 'keydown', (e) => this.onKey(e, pop));
    // Focus moving elsewhere by keyboard (Tab) closes it.
    this.d.listen(elem, 'focusout', (e) => {
      if (this.isOpen(pop) && e.relatedTarget && !elem.contains(e.relatedTarget) && e.relatedTarget !== this.cur.anchor) this.close(false);
    });
    return pop;
  }

  isOpen(pop) {
    return pop ? !!this.cur && this.cur.pop === pop : !!this.cur;
  }

  // anchor: the button (or { getBoundingClientRect } for a point, e.g. a right-click).
  open(pop, anchor, placement, onClose) {
    if (this.cur) this.close(false);
    this.cur = { pop, anchor, placement, onClose };
    if (anchor.nodeType) anchor.setAttribute('aria-expanded', 'true');
    const elem = pop.el;
    elem.hidden = false;
    elem.classList.add('entering');
    this.place();
    void elem.offsetWidth;   // start the opening transition from the entering state
    elem.classList.remove('entering');
    this.focusFirst();
    this.onChange(true);
  }

  toggle(pop, anchor, placement, onClose) {
    if (this.isOpen(pop)) this.close(true); else this.open(pop, anchor, placement, onClose);
  }

  close(focusBack) {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    c.pop.el.hidden = true;
    if (c.anchor.nodeType) {
      c.anchor.setAttribute('aria-expanded', 'false');
      if (focusBack) c.anchor.focus({ preventScroll: true });
    }
    if (c.onClose) c.onClose();
    this.onChange(false);
  }

  // Opened from the keyboard: the first item takes the focus (arrow keys go on from there).
  // Opened by a press: the popover itself does, so no item looks selected.
  focusFirst() {
    const c = this.cur;
    if (!c) return;
    if (performance.now() - this.pointerAt < 1000) { c.pop.el.focus({ preventScroll: true }); return; }
    const first = c.pop.el.querySelector('[data-autofocus], .mi:not([aria-disabled=true]), button, [tabindex="0"]');
    (first || c.pop.el).focus({ preventScroll: true });
  }

  // Positions the open popover; again after its content or the window changes.
  place() {
    const c = this.cur;
    if (!c) return;
    const elem = c.pop.el;
    const box = this.box.getBoundingClientRect();
    const sheet = box.width < SHEET_BELOW;
    elem.classList.toggle('sheet', sheet);
    elem.style.maxHeight = '';
    if (sheet) return;
    const a = c.anchor.getBoundingClientRect();
    const room = { above: a.top - box.top - POP_GAP - POP_MARGIN, below: box.bottom - a.bottom - POP_GAP - POP_MARGIN };
    const want = elem.offsetHeight;
    // The asked side, unless it is too short and the other side has more room.
    let side = c.placement;
    const other = side === 'above' ? 'below' : 'above';
    if (room[side] < want && room[other] > room[side]) side = other;
    elem.style.maxHeight = Math.max(80, room[side]) + 'px';
    const w = elem.offsetWidth;
    const h = elem.offsetHeight;
    const left = clamp(a.left + a.width / 2 - w / 2 - box.left, POP_MARGIN, Math.max(POP_MARGIN, box.width - w - POP_MARGIN));
    const top = side === 'above' ? a.top - box.top - POP_GAP - h : a.bottom - box.top + POP_GAP;
    elem.style.left = Math.round(left) + 'px';
    elem.style.top = Math.round(Math.max(POP_MARGIN, top)) + 'px';
    elem.style.setProperty('--from', side === 'above' ? '4px' : '-4px');
  }

  onKey(e, pop) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
      return;
    }
    if (pop.role !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...pop.el.querySelectorAll('.mi, .mhead .btn')].filter((x) => x.getAttribute('aria-disabled') !== 'true');
    if (!items.length) return;
    const i = items.indexOf(e.composedPath()[0]);   // -1 (the popover itself): Down goes to the first
    const n = items.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' || (i < 0 && e.key === 'ArrowUp') ? n - 1 : e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
    items[next].focus();
    e.preventDefault();
  }
}

// A menu whose items may open second-level pages (with a back button), like a video
// player's settings menu. Items are described, not built, so the menu always shows the
// current state (refresh() redraws the page shown). Item kinds:
//   { kind: 'page', label, value() (shown on the right), items() }
//   { kind: 'action', label, key, run(event), reason() ('' or why not now), stay }
//   { kind: 'toggle', label, desc, on(), set(on, event), reason() }
//   { kind: 'radio', label, checked(), select() }
//   { kind: 'text', text(), warn } | { kind: 'group', label } | { kind: 'sep' }
//   { kind: 'custom', render() -> element } | { kind: 'foot', text }
// Any item may have hidden() -> true to leave it out.
class SettingsMenu {
  constructor(pops, cls, label, root, disposer) {
    this.pops = pops;
    this.root = root;
    this.pop = pops.create(cls, 'menu', label);
    this.stack = [];
    this.shown = [];
    this.anchor = null;
    disposer.listen(this.pop.el, 'click', (e) => {
      const b = e.target.closest('[data-i], .mback');
      if (!b) return;
      e.stopPropagation();
      if (b.classList.contains('mback')) { this.back(); return; }
      this.activate(this.shown[+b.dataset.i], e);
    });
    disposer.listen(this.pop.el, 'keydown', (e) => {
      const t = e.composedPath()[0];
      if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && this.stack.length) { e.preventDefault(); this.back(); }
      if (e.key === 'ArrowRight' && t.dataset && t.dataset.i != null && this.shown[+t.dataset.i].kind === 'page') {
        e.preventDefault();
        this.activate(this.shown[+t.dataset.i], e);
      }
    });
  }

  get isOpen() { return this.pops.isOpen(this.pop); }

  open(anchor, placement) {
    this.stack = [];
    this.anchor = anchor;
    this.render();
    this.pops.open(this.pop, anchor, placement, () => { this.stack = []; });
  }

  toggle(anchor, placement) {
    if (this.isOpen) this.pops.close(true); else this.open(anchor, placement);
  }

  close(focusBack) {
    if (this.isOpen) this.pops.close(focusBack);
  }

  refresh() {
    if (!this.isOpen) return;
    const active = this.pop.el.getRootNode().activeElement;
    const at = active && active.dataset ? active.dataset.i : null;
    this.render();
    if (at != null) {
      const again = this.pop.el.querySelector('[data-i="' + at + '"]');
      if (again) again.focus({ preventScroll: true });
    }
    this.pops.place();
  }

  back() {
    this.stack.pop();
    this.render();
    this.pops.place();
    this.pops.focusFirst();
  }

  activate(item, e) {
    if (!item) return;
    if (item.kind === 'page') {
      this.stack.push(item);
      this.render();
      this.pops.place();
      this.pops.focusFirst();
    } else if (item.kind === 'action') {
      if (item.reason && item.reason()) return;
      if (!item.stay) this.pops.close(false);
      item.run(e);
      if (item.stay) this.refresh();
    } else if (item.kind === 'toggle') {
      if (item.reason && item.reason()) return;
      item.set(!item.on(), e);
      this.refresh();
    } else if (item.kind === 'radio') {
      item.select();
      this.refresh();
    }
  }

  render() {
    const page = this.stack[this.stack.length - 1];
    const items = (page ? page.items() : this.root()).filter((it) => it && !(it.hidden && it.hidden()));
    const body = this.pop.el;
    body.textContent = '';
    this.shown = items;
    if (page) {
      const back = el('button.btn.mback', { 'aria-label': tr('menuBack') });
      back.innerHTML = svg('back');
      body.append(el('div.mhead', null, back, el('span', { text: page.label })));
    }
    items.forEach((it, i) => body.append(this.item(it, i)));
  }

  item(it, i) {
    const reason = it.reason ? it.reason() : '';
    const btn = (role, ...kids) => el('button.mi', { role, 'data-i': String(i), 'aria-disabled': reason ? 'true' : null }, ...kids);
    const label = (desc) => el('span.lbl', { text: it.label }, desc ? el('span.desc', { text: desc }) : null);
    switch (it.kind) {
      case 'page': {
        const b = btn('menuitem', label(), el('span.val', { text: it.value ? it.value() : '' }), iconEl('next'));
        b.setAttribute('aria-haspopup', 'menu');
        return b;
      }
      case 'action':
        return btn('menuitem', label(reason), it.key ? el('span.key', { text: it.key }) : null);
      case 'toggle': {
        const b = btn('menuitemcheckbox', label(reason || it.desc), el('span.sw'));
        b.setAttribute('aria-checked', String(!reason && !!it.on()));
        return b;
      }
      case 'radio': {
        const b = btn('menuitemradio', iconEl('check', 'tick'), label());
        b.setAttribute('aria-checked', String(!!it.checked()));
        return b;
      }
      case 'text': return el('div.mtext' + (it.warn ? '.warn' : ''), { text: it.text() });
      case 'group': return el('div.mgroup', { text: it.label });
      case 'sep': return el('div.msep', { role: 'separator' });
      case 'foot': return el('div.mfoot', { text: it.text });
      default: return it.render();
    }
  }
}

class Tooltips {
  // scope: where the controls are (the shadow root); box: where the tooltip is placed.
  constructor(scope, box, disposer) {
    this.box = box;
    this.tip = el('div.tooltip', { role: 'tooltip', hidden: true });
    box.append(this.tip);
    this.target = null;
    this.timer = 0;
    disposer.add(() => clearTimeout(this.timer));
    disposer.listen(scope, 'pointerover', (e) => {
      if (e.pointerType !== 'mouse') return;
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || t === this.target) return;
      // Moving from one control to the next shows the next label at once.
      const warm = !this.tip.hidden;
      this.hide();
      this.target = t;
      if (warm) this.show(); else this.timer = setTimeout(guard(() => this.show()), TIP_DELAY_MS);
    });
    disposer.listen(scope, 'pointerout', (e) => {
      if (this.target && !(e.relatedTarget && this.target.contains(e.relatedTarget))) { this.hide(); this.target = null; }
    });
    disposer.listen(scope, 'pointerdown', () => { this.hide(); this.target = null; }, true);
    // Tooltips are a desktop aid: on touch devices (no hover) the focus path stays quiet too.
    disposer.listen(scope, 'focusin', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t && t.matches(':focus-visible') && windowOf(box).matchMedia('(hover: hover)').matches) { this.hide(); this.target = t; this.show(); }
    });
    disposer.listen(scope, 'focusout', () => { this.hide(); this.target = null; });
  }

  show() {
    const t = this.target;
    const text = t && t.isConnected ? t.dataset.tip : '';
    if (!text || t.closest('.idle .top, .idle .bottom, .pop')) return;
    const tip = this.tip;
    tip.textContent = text;
    tip.hidden = false;
    const box = this.box.getBoundingClientRect();
    const a = t.getBoundingClientRect();
    // Below the controls in the top half of the player, above the others.
    const below = a.top - box.top < box.height / 2;
    const left = clamp(a.left + a.width / 2 - tip.offsetWidth / 2 - box.left, POP_MARGIN, box.width - tip.offsetWidth - POP_MARGIN);
    const top = below ? a.bottom - box.top + 6 : a.top - box.top - 6 - tip.offsetHeight;
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  hide() {
    clearTimeout(this.timer);
    this.tip.hidden = true;
  }
}

// ---- 35-stream.js ----
// ===================================================================================
// One <video> element fed by one hls.js instance (or native HLS), with retry and
// recovery. The player owns two of these in dual-view layouts.
//
// Quality: slides and code must be readable, so "auto" starts at the highest rendition
// and only steps down when the network cannot keep up (hls.js ABR, started from an
// optimistic bandwidth estimate and quick to step back up). A fixed height locks that
// rendition. A cap (used for the camera in a small picture-in-picture window) limits auto
// without affecting a fixed choice.
// ===================================================================================

// Whether streams can be played at all: hls.js with Media Source Extensions, or native HLS.
function canPlayHls() {
  if (platform.Hls && platform.Hls.isSupported()) return true;
  try { return !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl'); } catch (e) { return false; }
}

class Stream {
  constructor(video, onFatal) {
    this.video = video;
    this.onFatal = onFatal;
    this.onAuth = null;     // a request was refused (401/403), fatal or not yet
    this.hls = null;
    this.uri = null;
    this.netRetries = 0;
    this.mediaRecoveries = 0;
    this.retryTimer = 0;
    this.quality = 'auto'; // 'auto' or a rendition height
    this.capHeight = 0;    // 0 = no cap
    this.onLevel = null;   // called when the playing rendition changes
    this.priority = 'high'; // 'low': steps down first and up last when bandwidth is short
    // While a load is starting: where it is meant to start and whether it should play.
    // The element says 0 and paused until it gets there, so it cannot be asked (a second
    // reload in that window would start at 0).
    this.starting = null;     // { at, play } or null
    this.renewedAt = 0;
    this.nativeMeta = null;   // native HLS: the loadedmetadata handler of the current load       // when access was last renewed for this stream (see the player's recoverAccess)
    this.arrived = null;      // listener clearing `starting`
  }

  // Where this stream is (or, while starting, is about to be).
  position() {
    return this.starting ? this.starting.at : this.video.currentTime;
  }

  // Whether it plays (or, while starting, is going to).
  playing() {
    return this.starting ? this.starting.play : !this.video.paused;
  }

  // The user seeked or played/paused before the load arrived: that is the new intent.
  intend(at, play) {
    if (!this.starting) return;
    if (at != null) this.starting.at = at;
    if (play != null) this.starting.play = play;
  }

  // Renditions as [{ height, bitrate }], in hls.js order (lowest first).
  get levels() {
    return this.hls ? this.hls.levels.map((l) => ({ height: l.height, bitrate: l.bitrate })) : [];
  }

  // Height of the rendition being played (0 when unknown).
  get height() {
    const h = this.hls;
    if (!h || !h.levels.length) return this.video.videoHeight || 0;
    const i = h.currentLevel >= 0 ? h.currentLevel : h.loadLevel;
    return i >= 0 && h.levels[i] ? h.levels[i].height : 0;
  }

  // Index of the rendition for a fixed height: the tallest not above it, else the lowest.
  levelFor(height) {
    const ls = this.hls ? this.hls.levels : [];
    let pick = 0;
    ls.forEach((l, i) => { if (l.height <= height && l.height >= ls[pick].height) pick = i; });
    return pick;
  }

  applyQuality(starting) {
    const h = this.hls;
    if (!h || !h.levels.length) return;
    const top = h.levels.length - 1;
    if (this.quality === 'auto') {
      // Smallest rendition at least as tall as the cap; no cap: everything allowed.
      let cap = -1;
      if (this.capHeight) {
        cap = top;
        h.levels.forEach((l, i) => { if (l.height >= this.capHeight && l.height < h.levels[cap].height) cap = i; });
      }
      h.autoLevelCapping = cap;
      if (starting) h.startLevel = cap >= 0 ? cap : top;
      else if (!h.autoLevelEnabled) h.nextLevel = -1;
    } else {
      h.autoLevelCapping = -1;
      const i = this.levelFor(this.quality);
      if (starting) { h.startLevel = i; h.nextLevel = i; } else h.nextLevel = i;
    }
  }

  setQuality(q) {
    this.quality = q;
    this.applyQuality(false);
  }

  setCap(height) {
    if (height === this.capHeight) return;
    this.capHeight = height;
    if (this.quality === 'auto') this.applyQuality(false);
  }

  // Loads `uri` starting at `startAt` seconds. `onReady` runs once the manifest is parsed;
  // `play`: whether it is meant to play (what playing() says until it has arrived).
  load(uri, startAt, onReady, play) {
    this.destroyEngine();
    this.uri = uri;
    this.starting = { at: startAt || 0, play: !!play };
    const v0 = this.video;
    // Arrived: data is there at (about) the intended position.
    this.arrived = () => {
      const s = this.starting;
      if (s && v0.readyState >= 2 && Math.abs(v0.currentTime - s.at) <= 1) this.clearStarting();
    };
    v0.addEventListener('canplay', this.arrived);
    v0.addEventListener('seeked', this.arrived);
    this.netRetries = 0;
    this.mediaRecoveries = 0;
    const v = this.video;
    if (platform.Hls && platform.Hls.isSupported()) {
      const hls = new platform.Hls({
        startPosition: startAt,
        capLevelToPlayerSize: false,
        // Start from the connection the browser reports (hls.js assumes 500 kbps), and step
        // up again as soon as the measured bandwidth allows (hls.js: 0.7 up factor).
        abrEwmaDefaultEstimate: STREAM_START_BPS(),
        abrBandWidthFactor: STREAM_BW_FACTOR[this.priority === 'low' ? 'low' : 'main'][0],
        abrBandWidthUpFactor: STREAM_BW_FACTOR[this.priority === 'low' ? 'low' : 'main'][1],
        backBufferLength: STREAM_BACK_BUFFER_SEC,
        maxBufferLength: STREAM_MAX_BUFFER_SEC,
        maxMaxBufferLength: STREAM_MAX_AHEAD_SEC,
        xhrSetup: (xhr) => { xhr.withCredentials = true; },
      });
      this.hls = hls;
      hls.on(platform.Hls.Events.ERROR, guardCore((e, data) => this.onError(data)));
      hls.once(platform.Hls.Events.MANIFEST_PARSED, guardCore(() => {
        this.applyQuality(true);
        if (onReady) onReady();
      }));
      // The first switch is the start; later ones are counted (usage data).
      let switches = 0;
      hls.on(platform.Hls.Events.LEVEL_SWITCHED, guardCore(() => { if (switches++) usageNote('level'); if (this.onLevel) this.onLevel(); }));
      hls.on(platform.Hls.Events.FRAG_LOADED, (e, data) => { usageNote('streamBytes', null, data && data.frag && data.frag.stats ? data.frag.stats.loaded : 0); });
      // hls.js resets the MediaSource after some failed appends (refused segments can cause
      // them) and then starts over at startPosition: keep the position and play state.
      hls.on(platform.Hls.Events.MEDIA_DETACHING, guardCore(() => {
        if (this.hls === hls && v.readyState > 0) this.restore = { t: v.currentTime, play: !v.paused };
      }));
      hls.on(platform.Hls.Events.MEDIA_ATTACHED, guardCore(() => {
        const r = this.restore;
        this.restore = null;
        if (!r || this.hls !== hls) return;
        // Only for this hls instance: if the view is swapped before the metadata arrives,
        // the new source must not jump to the old position.
        const onMeta = () => {
          this.pendingRestore = null;
          if (this.hls !== hls) return;
          if (Math.abs(v.currentTime - r.t) > 1) v.currentTime = r.t;
          if (r.play && v.paused) v.play().catch(() => {});
        };
        this.pendingRestore = onMeta;
        v.addEventListener('loadedmetadata', onMeta, { once: true });
      }));
      hls.loadSource(uri);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari): the CDN answers credentialed CORS requests, so frames and audio
      // stay readable for later Web Audio / canvas features.
      v.crossOrigin = 'use-credentials';
      v.src = uri;
      // Owned like an hls.js instance: removed when this load is replaced or the stream
      // ends; it goes to where the stream is meant to be now (a seek while loading).
      const onMeta = () => {
        this.nativeMeta = null;
        const at = this.starting ? this.starting.at : startAt;
        if (at) v.currentTime = at;
        if (onReady) onReady();
      };
      this.nativeMeta = onMeta;
      v.addEventListener('loadedmetadata', onMeta, { once: true });
    } else {
      throw new Error('neither MSE (hls.js) nor native HLS is available');
    }
  }

  onError(data) {
    if (!data || !this.hls) return;
    const code = data.response && data.response.code;
    // Usage data: what went wrong (hls.js's name for it) and, for requests, how.
    usageNote('stream', data.details);
    if (data.type === platform.Hls.ErrorTypes.NETWORK_ERROR) usageNote('net', code || (/TimeOut$/.test(data.details || '') ? 'timeout' : 'network'));
    // Refused: hls.js would keep retrying for half a minute; renew the access now so that
    // one of its retries succeeds.
    if ((code === 401 || code === 403) && !data.fatal && this.onAuth) { this.onAuth(); return; }
    if (!data.fatal) return;
    if (code !== 401 && code !== 403) {
      if (data.type === platform.Hls.ErrorTypes.NETWORK_ERROR && this.netRetries < STREAM_NET_RETRIES) {
        this.netRetries++;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(guardCore(() => this.hls && this.hls.startLoad()), 1000 * this.netRetries);
        return;
      }
      if (data.type === platform.Hls.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries < STREAM_MEDIA_RECOVERIES) {
        this.mediaRecoveries++;
        this.hls.recoverMediaError();
        return;
      }
    }
    log.warn('fatal hls error', data.type, data.details, code || '');
    this.onFatal({ auth: code === 401 || code === 403, details: data.details, code: code || 0,
      media: data.type === platform.Hls.ErrorTypes.MEDIA_ERROR });
  }

  kick(at) {
    if (this.hls) this.hls.startLoad(at);
  }

  // After the access was renewed: carry on loading from `at`, keeping the element (and so
  // any Web Audio graph on it) and everything already buffered. A failure before the
  // playlists were read loads the source again.
  resume(at) {
    const h = this.hls;
    if (!h) return;
    this.netRetries = 0;
    if (!h.levels || !h.levels.length) { h.loadSource(this.uri); return; }
    h.startLoad(at);
  }

  clearStarting() {
    this.starting = null;
    if (this.arrived) {
      this.video.removeEventListener('canplay', this.arrived);
      this.video.removeEventListener('seeked', this.arrived);
      this.arrived = null;
    }
  }

  destroyEngine() {
    clearTimeout(this.retryTimer);
    this.clearStarting();
    if (this.pendingRestore) { this.video.removeEventListener('loadedmetadata', this.pendingRestore); this.pendingRestore = null; }
    if (this.nativeMeta) { this.video.removeEventListener('loadedmetadata', this.nativeMeta); this.nativeMeta = null; }
    if (this.hls) { this.hls.destroy(); this.hls = null; }
  }

  // Stops loading and releases the element's media resource.
  destroy() {
    this.destroyEngine();
    const v = this.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
    this.uri = null;
  }
}

// Why the video could not be loaded, in words, from what stream.onFatal reports
// ({ code, media, details }) and whether the browser is online.
function playbackFailReason(f, online) {
  if (f.media) return tr('failMedia');
  const c = f.code;
  if (c >= 500) return tr('failServer', { code: c });
  if (c === 404 || c === 410) return tr('failMissing', { code: c });
  if (c >= 400) return tr('failRefused', { code: c });
  if (!online) return tr('failOffline');
  if (/load|timeout|network/i.test(f.details || '')) return tr('failUnreachable');
  return f.details || tr('failUnreachable');
}

// ---- 36-session.js ----
// ===================================================================================
// Keeping the video access alive.
//
// Echo360 grants access to the video files with CloudFront signed cookies (HttpOnly, for
// all of the institution's media). They are valid for about two hours and are issued again
// by the lesson page itself: a GET of the page renews them once they are older than the
// renewal interval the page states (cookieRenewalIntervalMillis, one hour). The original
// player reloads the page after a day; we fetch the page in the background instead, which
// needs no new player, video element or page reload.
//
// - Ahead of time: every renewal interval while the page is open, and on returning to the
//   tab or pressing play when the last renewal is older than that (timers stall while a
//   laptop sleeps).
// - On failure: a 401 or 403 from the video files (playlists, segments, background
//   downloads) renews at once and the caller retries.
// - A renewal tries up to three times (two retries). If the school login itself has
//   expired, the page answers with a redirect to the login page: that cannot be fixed in
//   the background, so the keeper gives up and the player asks the user to reload.
//
// mediaSession.renew() is what fetchOk() (61-media-io.js) calls for background downloads.
// ===================================================================================


const mediaSession = { renew: null };

class SessionKeeper {
  // opts: { url (the lesson page), renewMs, disposer, onState(state), retryMs (tests) }
  // state: 'renewing' (after a failure) | 'ok' | 'failed' ({ login: bool })
  constructor(opts) {
    this.url = opts.url;
    this.renewMs = opts.renewMs > 0 ? Math.min(opts.renewMs, SESSION_MAX_RENEW_MS) : SESSION_DEFAULT_RENEW_MS;
    this.onState = opts.onState || (() => {});
    this.retryMs = opts.retryMs || SESSION_RETRY_MS;
    this.last = Date.now();       // the page load renewed the cookies if they needed it
    this.pending = null;
    this.failed = null;           // { login } once renewal has given up
    this.renewals = 0;
    this.failures = 0;            // renewals that failed (each after its retries)
    this.d = opts.disposer;
    this.timer = 0;
    // Once the player is gone (falling back to the original player), nothing may start
    // again: a renewal still on its way must not schedule the next one.
    this.disposed = false;
    this.ac = new AbortController();
    this.d.add(() => { this.disposed = true; this.ac.abort(); clearTimeout(this.timer); });
    this.schedule();
    const wake = () => { if (!document.hidden && Date.now() - this.last > this.renewMs) this.renew(false).catch(() => {}); };
    this.d.listen(document, 'visibilitychange', wake);
    this.wake = wake;
    const hook = () => this.renew(true);
    mediaSession.renew = hook;
    this.d.add(() => { if (mediaSession.renew === hook) mediaSession.renew = null; });
  }

  schedule() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.renew(false).catch(() => {}), Math.max(SESSION_MIN_RENEW_MS, this.renewMs - (Date.now() - this.last)));
  }

  // Renews the cookies. `afterFailure`: something was refused, so the user may notice a
  // pause and is told what is going on. Concurrent calls share one renewal.
  renew(afterFailure) {
    if (this.disposed) return Promise.reject(new Error('stopped'));
    if (this.failed) return Promise.reject(new Error('session expired'));
    if (this.pending) return this.pending;
    if (afterFailure) this.onState('renewing');
    this.pending = this.attempt(0).then(() => {
      if (this.disposed) throw new Error('stopped');
      this.last = Date.now();
      this.renewals++;
      this.onState('ok');
    }, (e) => {
      if (this.disposed) throw e;
      this.failures++;
      // A routine renewal that could not reach the server is tried again later; the
      // cookies are still valid for a while.
      if ((e && e.login) || afterFailure) {
        this.failed = { login: !!(e && e.login) };
        this.onState('failed', this.failed);
      } else this.onState('ok');
      throw e;
    }).finally(() => {
      this.pending = null;
      if (!this.failed) this.schedule();
    });
    return this.pending;
  }

  async attempt(k) {
    if (this.disposed) throw new Error('stopped');
    let r = null;
    try {
      r = await fetch(this.url, { credentials: 'include', cache: 'no-store', redirect: 'manual', signal: requestSignal(this.ac.signal) });
    } catch (e) {
      if (this.disposed) throw new Error('stopped');
      r = null;
    }
    if (r && r.body) r.body.cancel().catch(() => {});
    // A redirect (to the login page) or a refusal: the school login has expired.
    if (r && (r.type === 'opaqueredirect' || r.status === 401 || r.status === 403)) {
      throw Object.assign(new Error('login expired'), { login: true });
    }
    if (r && r.ok) return;
    if (k >= this.retryMs.length) throw new Error('renewal failed' + (r ? ' (HTTP ' + r.status + ')' : ''));
    await new Promise((res) => {
      const id = setTimeout(res, this.retryMs[k]);
      this.ac.signal.addEventListener('abort', () => { clearTimeout(id); res(); }, { once: true });
    });
    return this.attempt(k + 1);
  }
}

// ---- 38-sync.js ----
// ===================================================================================
// Keeps a muted follower <video> in step with the clock <video> (the one with audio).
//   - play / pause / seek / rate changes are mirrored immediately;
//   - while the clock buffers, the follower waits;
//   - a 1 s check while playing nudges the follower's rate for small drift and seeks it
//     for large drift. The check only runs while the clock is playing.
// ===================================================================================

class FollowerSync {
  constructor(clock, follower) {
    this.clock = clock;
    this.follower = follower;
    this.d = new Disposer();
    this.timer = 0;
    const d = this.d;
    const c = clock;
    const f = follower;
    f.muted = true;

    d.listen(c, 'play', () => { this.align(); this.playFollower(); this.start(); });
    d.listen(c, 'playing', () => this.playFollower());
    d.listen(c, 'pause', () => { this.stop(); f.pause(); this.align(); });
    d.listen(c, 'waiting', () => f.pause());
    d.listen(c, 'seeking', () => this.align());
    d.listen(c, 'ratechange', () => { f.playbackRate = c.playbackRate; });
    d.listen(f, 'loadedmetadata', () => { this.align(); if (!c.paused) this.playFollower(); });
    d.add(() => this.stop());

    f.playbackRate = c.playbackRate;
    if (!c.paused) this.start();
  }

  playFollower() {
    const c = this.clock;
    const f = this.follower;
    if (c.paused || c.readyState < 3) return;
    if (f.paused) f.play().catch(() => {});
  }

  align() {
    const f = this.follower;
    if (f.readyState === 0 || this.clock.readyState === 0) return;
    if (Math.abs(f.currentTime - this.clock.currentTime) > SYNC_TOLERANCE) f.currentTime = this.clock.currentTime;
    f.playbackRate = this.clock.playbackRate;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(guardCore(() => this.check()), 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  check() {
    const c = this.clock;
    const f = this.follower;
    if (c.paused || c.seeking || f.seeking || f.readyState < 2) return;
    const base = c.playbackRate;
    const drift = f.currentTime - c.currentTime;
    usageNote('drift', null, Math.abs(drift) * 1000);
    if (Math.abs(drift) >= SYNC_SEEK_AT) {
      // Aim slightly ahead so the follower lands in sync once its seek completes.
      f.currentTime = c.currentTime + 0.1 * base;
      f.playbackRate = base;
    } else if (Math.abs(drift) > SYNC_TOLERANCE) {
      f.playbackRate = base * (1 - clamp(drift * 0.5, -SYNC_MAX_NUDGE, SYNC_MAX_NUDGE));
    } else if (f.playbackRate !== base) {
      f.playbackRate = base;
    }
    if (f.paused && c.readyState >= 3) f.play().catch(() => {});
  }

  dispose() {
    this.d.dispose();
  }
}

// ---- 39-prefs.js ----
// ===================================================================================
// Settings: the defaults and one validation for everything that reads them back (the
// player at start, a backup restore). Each field is checked for type and range; anything
// else falls back to its default and unknown fields are dropped, so a damaged or foreign
// value can never stop the player from starting.
// ===================================================================================

// Layouts of the two views, and corners for the picture-in-picture window.
const LAYOUTS = ['side', 'pip', 'single'];
const CORNERS = ['br', 'bl', 'tr', 'tl'];
// Colour themes (the light one applies to the side panel, menus and dialogs only).
const THEMES = ['system', 'dark', 'light'];

const COPY_SPANS = [30, 60, 120, 300];

function prefDefaults() {
  return {
    primary: null, layout: 'side', ratio: 0.5, pipw: 0.26, corner: 'br', rate: 1, volume: 1, muted: false,
    captions: false, capSize: 'm', capHidePaused: true, panel: false, tab: 'transcript', panelw: 360,
    // Levelling is on unless the user turned it off (levelChosen: they set it themselves).
    audio: { level: true, levelChosen: false, voice: false, mono: false },
    silence: { auto: false, min: 30, sens: 'normal' },
    copySpan: 60,
    pdfMain: false, pdfFirst: false,
    emptyCamera: true,
    quality: { screen: 'auto', camera: 'auto' },
    theme: 'system',
    lang: 'auto',
    telemetry: true,
  };
}

function sanitizePrefs(raw) {
  const d = prefDefaults();
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : def);
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const oneOf = (v, list, def) => (list.includes(v) ? v : def);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const audio = obj(r.audio);
  const silence = obj(r.silence);
  const quality = obj(r.quality);
  const height = (v) => (v === 'auto' || (Number.isInteger(v) && v > 0 && v <= 4320) ? v : 'auto');
  return {
    primary: Number.isInteger(r.primary) && r.primary >= 0 ? r.primary : d.primary,
    layout: oneOf(r.layout, LAYOUTS, d.layout),
    ratio: num(r.ratio, 0.2, 0.8, d.ratio),
    pipw: num(r.pipw, 0.15, 0.6, d.pipw),
    corner: oneOf(r.corner, CORNERS, d.corner),
    rate: num(r.rate, 0.25, 4, d.rate),
    volume: num(r.volume, 0, 1, d.volume),
    muted: bool(r.muted, d.muted),
    captions: bool(r.captions, d.captions),
    capSize: oneOf(r.capSize, Object.keys(CAPTION_SIZES), d.capSize),
    capHidePaused: bool(r.capHidePaused, d.capHidePaused),
    panel: bool(r.panel, d.panel),
    tab: oneOf(r.tab, SIDEBAR_TABS, d.tab),
    panelw: num(r.panelw, 260, 2000, d.panelw),
    audio: {
      // A stored "off" from before levelling was on by default is not a choice: only one made
      // since (levelChosen) is kept.
      level: audio.levelChosen === true ? bool(audio.level, d.audio.level) : d.audio.level,
      levelChosen: audio.levelChosen === true,
      voice: bool(audio.voice, false), mono: bool(audio.mono, false),
    },
    silence: {
      auto: bool(silence.auto, false),
      min: oneOf(silence.min, SILENCE_MIN_CHOICES, d.silence.min),
      sens: oneOf(silence.sens, Object.keys(SILENCE_SENSITIVITY), d.silence.sens),
    },
    copySpan: oneOf(r.copySpan, COPY_SPANS, d.copySpan),
    pdfMain: bool(r.pdfMain, d.pdfMain),
    pdfFirst: bool(r.pdfFirst, d.pdfFirst),
    emptyCamera: bool(r.emptyCamera, d.emptyCamera),
    quality: { screen: height(quality.screen), camera: height(quality.camera) },
    theme: oneOf(r.theme, THEMES, d.theme),
    // 'auto' or a language code; one without a table means English (uiLang).
    lang: typeof r.lang === 'string' && /^(auto|[a-z]{2})$/.test(r.lang) ? r.lang : d.lang,
    telemetry: bool(r.telemetry, d.telemetry),
  };
}

// A saved position ({ t, at }) or null.
function sanitizePos(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.t !== 'number' || !isFinite(raw.t) || raw.t < 0) return null;
  return { t: raw.t, at: typeof raw.at === 'number' && isFinite(raw.at) ? raw.at : 0 };
}

// localStorage entries a backup may restore, with their validation. Development
// switches (debug, dryRun, ...) are never restored.
const BACKUP_LOCAL = [
  { match: (k) => k === 'prefs', clean: sanitizePrefs },
  { match: (k) => /^pos:[\w:.-]{1,200}$/.test(k), clean: sanitizePos },
];

// ---- 40-player.js ----
// ===================================================================================
// The player
//
// Streams: the "clock" <video> plays an audio+video rendition and drives everything
// (reporting, time display, seeking). In dual layouts a muted "follower" <video> plays the
// other view's video-only rendition and is kept in step by FollowerSync, so audio is never
// downloaded twice.
//
// Layout: which source is shown big ("primary") is independent of which one is the clock.
// Swapping views in the side-by-side and picture-in-picture layouts only moves the two
// elements (CSS); in the single layout the clock is reloaded with the shown source.
//
// The player assembles its parts and keeps what they share: the streams, the layout and
// the settings. Each part gets only the functions and elements it needs, and is owned
// through a child of the player's Disposer (released with it, or alone if it fails):
//   Popovers and Tooltips (32), SeekBar (41), KeyboardShortcuts (42), LayoutControls (43),
//   QualityController (44), MenuBar (45), PopoutController (46), SilenceUi (47),
//   SpeedControl (48), VolumeControl (49); and the features: captions and
//   transcript (53), side panel (54), notes (55), discussion (57), slides (64-68),
//   zoom (50), A-B loop (51), watched parts (52), audio tools (60).
// ===================================================================================

class LitePlayer {
  constructor(lesson, opts) {
    this.d = new Disposer();
    this.destroyed = false;
    // A failure half-way must not leave a half-built player (a black overlay over the
    // original player, timers, requests): release everything made so far, then let the
    // caller fall back.
    this.constructing = true;
    try {
      this.init(lesson, opts);
      this.constructing = false;
    } catch (e) {
      this.destroyed = true;
      try { this.d.dispose(); } catch (err) { /* keep the first error */ }
      throw e;
    }
  }

  init(lesson, opts) {
    this.startedAt = performance.now();   // usage data: times are measured from here
    this.lesson = lesson;
    this.opts = opts;
    // A feature that fails is announced once (playback goes on).
    featureErrors.notify = (name) => { if (!this.destroyed && this.root) this.toast(tr('featureFailed', { name: featureName(name) })); };
    this.d.add(() => { featureErrors.notify = null; });
    this.prefs = sanitizePrefs(store.get('prefs', null));
    this.played = new PlayedRanges();
    // Shared by the parts that drag (seek bar, divider, picture-in-picture window) and
    // those that must not interfere meanwhile (hiding the controls, skipping silences).
    this.ui = { dragging: false };
    this.sync = null;
    this.followerFailed = false;
    this.playbackFailed = false;    // the "playback failed" message is up
    this.partRetries = new Map();   // side-panel tab -> load again, for loads that failed for now
    this.frame = new FrameTask(() => this.render(), () => this.host);
    this.d.add(() => this.frame.cancel());

    this.sources = lesson.sources;
    this.dual = this.sources.length >= 2;
    const savedPrimary = this.sources.findIndex((s) => s.index === this.prefs.primary);
    this.primaryPos = savedPrimary >= 0 ? savedPrimary : 0;
    this.onlyFrom = null;     // the shown view before showOnly(), or null
    this.emptyScreen = null;
    this.toastNext = null;    // a message waiting for the shown one to close (toast)
    this.toastFrom = null;    // the source of the automatic message shown
    this.clockPos = this.sources[this.primaryPos].av ? this.primaryPos : this.sources.findIndex((s) => s.av);

    this.buildDom();
    this.session = new SessionKeeper({
      url: location.href, renewMs: lesson.sessionRenewMs, disposer: this.d.feature('session renewal'),
      onState: (st) => { if (!this.destroyed) this.$('.sessionhint').hidden = st !== 'renewing'; },
    });
    this.clock = new Stream(this.video, (f) => this.onClockFatal(f));
    this.follower = new Stream(this.fvideo, (f) => (f.auth ? this.recoverAccess(this.follower, () => this.onFollowerFatal()) : this.onFollowerFatal()));
    this.followerPos = -1;
    this.hold = null;          // Disposer of a held follower (holdFollower), or null
    for (const st of [this.clock, this.follower]) {
      st.onLevel = () => { if (!this.destroyed) this.quality.levelChanged(); };
      // Refused but still retrying: renew in the background (once at a time).
      st.onAuth = () => {
        if (this.destroyed) return;
        if (!this.session.failed) { this.session.renew(true).catch(() => {}); return; }
        // Renewal has already given up: say so now rather than after hls.js's retries.
        if (st === this.clock) this.showAuthError(); else this.onFollowerFatal();
      };
    }
    this.d.add(() => { this.dropFollower(); this.clock.destroy(); });
    this.setupParts();
    this.bindVideo();
    this.bindControls();
    this.watched = new WatchedStore(lesson, this.video, this.played);
    this.watched.load().then(() => { if (!this.destroyed) this.renderWatched(); }).catch(() => {});
    this.d.listen(window, 'pagehide', () => this.watched.save(this.duration()));
    this.reporter = lesson.analytics ? new Reporter(lesson.analytics, this.video, this.played, this.d.child()) : null;
    if (this.reporter) this.reporter.stateFn = () => ({ captions: this.cc.on, transcript: this.sidebar.visible('transcript') });
    // Optional features: one failing to start is turned off, the others and playback go on.
    featureGuard('silence detection', () => {
      this.silence = new SilenceUi({
        $: (sel) => this.$(sel), lesson, video: this.video, sources: this.sources, prefs: this.prefs, savePrefs: () => this.savePrefs(),
        seek: (t) => this.seek(t), duration: () => this.duration(), toast: (...a) => this.toast(...a), ui: this.ui,
        uniform: () => (this.slides ? this.slides.uniform : []),
        onChange: () => this.menus.refresh(),
        onSkips: (skips, end) => {
          this.seekBar.renderSkips(skips);
          if (this.watched) this.watched.contentEnd = end && end < this.duration() ? end : null;
        },
      }, this.d.feature('silence detection'));
      this.menuPages.silence = () => this.silence.items();
      this.menuValues.silence = () => this.silence.value();
    });
    featureGuard('slide chapters', () => this.setupSlides());
    featureGuard('camera for an empty screen', () => {
      this.emptyScreen = new EmptyScreenLayout({
        lesson, prefs: this.prefs, savePrefs: () => this.savePrefs(), duration: () => this.duration(), sources: this.sources,
        uniform: () => (this.slides ? this.slides.uniform : []),
        screenIndex: () => (this.slides ? this.slides.screenIndex : null),
        primaryPos: () => this.primaryPos, layout: () => this.prefs.layout,
        canSwitch: () => this.dual && !this.followerFailed && !this.pdfMode,
        showOnly: (pos) => this.showOnly(pos), toast: (msg, action, fn, valid) => this.toast(msg, action, fn, { later: true, from: 'emptyScreen', valid }),
      }, this.d.feature('camera for an empty screen'));
    });
    featureGuard('slide reader', () => this.setupDeck());
    featureGuard('captions', () => this.loadCues());
    featureGuard('notes and discussion', () => this.loadInteractions());
    featureGuard('audio tools', () => this.setupAudio());
    featureGuard('usage data', () => {
      this.usage = new UsageSession({
        root: this.root, video: this.video, videos: () => [this.video, this.fvideo], prefs: this.prefs,
        layout: () => (this.pdfMode ? 'pdf' : this.layout),
        slides: () => this.slides || null, deck: () => this.deck || null,
        silence: () => (this.silence && this.silence.analyzer) || null, emptyScreen: () => this.emptyScreen,
        session: () => this.session, duration: () => this.duration(), startedAt: this.startedAt,
        height: () => this.clock.height, bandwidth: () => (this.clock.hls ? this.clock.hls.bandwidthEstimate : NaN),
        played: () => this.played.merged(this.video.played),
      }, this.d.child());
      telemetry.envDaily();
    });

    const start = this.pickStart();
    this.startAt = start;
    // A page taken over goes on as the original player was: there, playing or not.
    this.loadClock(this.clockPos, start, !!(opts.takeover && opts.takeover.playing));
    this.applyLayout();
    if (start > 1) this.toast(tr('resumedAt', { time: fmtTime(start) }), tr('startOver'), () => this.seek(0));
    // Development's dry run is a switch in the page's storage: never on without saying so,
    // or writes would look saved while nothing is sent.
    if (this.writesHeld) this.toast(tr(this.writesHeld === 'all' ? 'dryRunAll' : 'dryRunPublic'), null, null, { later: true, from: 'dryRun' });
  }

  // An element of the player's own markup. Each selector must name exactly one element:
  // two elements sharing a class once bound one button's action to another. Looked up
  // once and remembered (the markup is fixed; parts that are redrawn are not looked up
  // this way).
  $(sel) {
    let elem = this.refs.get(sel);
    if (!elem) {
      const all = this.root.querySelectorAll(sel);
      if (all.length !== 1) throw new Error('player markup: "' + sel + '" matches ' + all.length + ' elements');
      elem = all[0];
      this.refs.set(sel, elem);
    }
    return elem;
  }

  // All elements of the player's markup matching sel (for groups such as menu items).
  all(sel) {
    return /** @type {HTMLElement[]} */ ([...this.root.querySelectorAll(sel)]);
  }

  get secondaryPos() {
    return this.dual ? (this.primaryPos + 1) % this.sources.length : -1;
  }

  get layout() {
    if (this.pdfMode) return this.prefs.layout;
    if (this.onlyFrom !== null) return 'single';
    return this.dual && !this.followerFailed ? this.prefs.layout : 'single';
  }

  // Shows the view at `pos` alone for now (the other one is empty), without changing the
  // chosen layout; null goes back to it (EmptyScreenLayout).
  showOnly(pos) {
    if (pos === null) {
      if (this.onlyFrom === null) return;
      this.primaryPos = this.onlyFrom;
      this.onlyFrom = null;
    } else {
      if (this.onlyFrom === null) this.onlyFrom = this.primaryPos;
      this.primaryPos = pos;
    }
    this.applyLayout();
  }

  // The lecturer's PDF shown in the picture area, next to one video (see SlideReader).
  get pdfMode() {
    return !!(this.prefs.pdfMain && this.deck && this.deck.pages.length);
  }

  buildDom() {
    const host = document.createElement('div');
    host.id = 'lite-player-for-echo360';
    host.lang = uiLocale();
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + PLAYER_CSS + '</style>' + playerTemplate();
    this.host = host;
    this.root = root;
    this.refs = new Map();
    this.stage = this.$('.stage');
    this.video = this.$('video.clock');
    this.fvideo = this.$('video.follower');
    this.app = this.$('.app');
    this.$('.title').textContent = this.lesson.title;
    document.title = this.lesson.title;
    const back = this.$('.back');
    if (this.lesson.backUrl) back.href = this.lesson.backUrl; else back.style.display = 'none';
    this.app.dataset.theme = this.prefs.theme;
    this.stage.classList.toggle('hidecc-paused', !!this.prefs.capHidePaused);
    this.stage.style.setProperty('--ratio', String(clamp(this.prefs.ratio, 0.2, 0.8)));
    this.stage.style.setProperty('--pipw', String(clamp(this.prefs.pipw, 0.15, 0.6)));
    this.app.style.setProperty('--panelw', clamp(this.prefs.panelw, 260, 640) + 'px');
    this.cc = new CaptionsView(this.$('.captions'), this.video);
    this.d.add(() => this.cc.dispose());
    this.cc.setSize(this.prefs.capSize);
    this.sidebar = new Sidebar(this, this.$('.panel'), this.d.child());
    this.transcript = new TranscriptPanel(this, this.$('.pane[data-pane=transcript]'), this.$('.marks'), this.d.child());
    this.markers = new MarkersLayer(this.$('.imarks'));
    this.notes = null;
    this.discussion = null;
    this.renderExtras();
    (document.body || document.documentElement).appendChild(host);
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    this.d.add(() => {
      if (fullscreenElement() === host) exitFullscreen();
      host.remove();
      document.documentElement.style.overflow = prevOverflow;
    });
  }

  // A link to a moment (#t=<seconds>, as in exported notes) wins over the resume position.
  linkTime() {
    const m = /(?:^#|&)t=(\d+(?:\.\d+)?)/.exec(location.hash);
    return m ? +m[1] : null;
  }

  pickStart() {
    // Taken over from the original player (90-main.js): where it was.
    const took = this.opts.takeover;
    if (took && took.at != null) return took.at;
    const dur = this.lesson.duration;
    // A link's time past the end (a link to another recording, a typo) starts at the end.
    const link = this.linkTime();
    if (link != null) return isFinite(dur) && dur > 0 ? Math.min(link, dur) : link;
    // Back from a reload the player made (reloadHere): where it was, once.
    const back = store.get('reloadAt', null);
    if (back) {
      store.set('reloadAt', null);
      if (back.id === this.lesson.id && typeof back.t === 'number' && back.t >= 0 && Math.abs(Date.now() - back.at) < RELOAD_RESUME_MS) return back.t;
    }
    let t0 = this.lesson.resumeAt;
    if (t0 == null) {
      const local = sanitizePos(store.get('pos:' + this.lesson.id, null));
      t0 = local ? local.t : 0;
    }
    if (!(t0 > 0) || (isFinite(dur) && t0 > dur - RESUME_END_SEC)) t0 = 0;
    return t0;
  }

  // ---- streams and layout ----

  // Core playback: an error here hands over to the original player.
  loadClock(pos, startAt, autoplay) {
    try { this.loadClockNow(pos, startAt, autoplay); } catch (e) { if (this.constructing) throw e; reportUnexpected(e); }
  }

  loadClockNow(pos, startAt, autoplay) {
    const v = this.video;
    const source = this.sources[pos];
    this.played.absorb(v.played);
    this.clockPos = pos;
    if (source.poster && startAt < 1) v.poster = source.poster; else v.removeAttribute('poster');
    v.defaultPlaybackRate = this.prefs.rate;
    v.volume = clamp(this.prefs.volume, 0, 1);
    v.muted = !!this.prefs.muted;
    this.volumeCtl.render();
    this.clock.quality = this.quality.qualityFor(pos);
    this.clock.priority = this.quality.roleOf(pos) === 'camera' ? 'low' : 'high';
    this.clock.load(source.av, startAt, () => {
      v.playbackRate = this.prefs.rate;
      // Refused by the browser (autoplay not allowed): no longer meant to play, so the button
      // says Play again. Interrupted by another load: that load carries the intent on.
      if (this.clock.playing()) {
        v.play().catch((e) => { if (e && e.name === 'NotAllowedError') { this.clock.intend(null, false); this.renderPlay(); } });
      }
    }, autoplay);
    this.renderPlay();
  }

  // Which element shows in which place. While the follower is held (holdFollower), it
  // keeps the place the reloading clock will take.
  assignSlots() {
    const pdfView = this.$('.pdfview');
    const held = !!this.hold;
    if (this.pdfMode) {
      const pdfFirst = !!this.prefs.pdfFirst;
      const videoSlot = pdfFirst ? 'secondary' : 'primary';
      this.video.dataset.slot = held ? 'off' : videoSlot;
      this.fvideo.dataset.slot = held ? videoSlot : 'off';
      pdfView.dataset.slot = pdfFirst ? 'primary' : 'secondary';
    } else {
      const clockIsPrimary = !held && (this.clockPos === this.primaryPos || this.layout === 'single');
      this.video.dataset.slot = clockIsPrimary ? 'primary' : 'secondary';
      this.fvideo.dataset.slot = clockIsPrimary ? 'secondary' : 'primary';
      pdfView.dataset.slot = 'off';
    }
  }

  // The clock is reloading with the view the follower shows (single view or the PDF after a
  // swap): the follower stops on its picture and stays in place instead of a black moment,
  // until the clock has a picture at its position; then only the clock plays.
  holdFollower() {
    if (this.sync) { this.sync.dispose(); this.sync = null; }
    this.fvideo.pause();
    const d = this.hold = this.d.child();
    const arrived = () => {
      if (this.hold !== d || this.clock.starting || this.video.readyState < 2) return;
      this.endHold();
      this.assignSlots();
    };
    for (const type of ['canplay', 'seeked', 'playing']) d.listen(this.video, type, arrived);
    // Never arrives (an error, offline): not held for ever.
    d.timeout(() => { if (this.hold === d) { this.endHold(); this.assignSlots(); } }, HOLD_FOLLOWER_MAX_MS);
  }

  // Ends a hold (holdFollower): the follower is released.
  endHold() {
    const d = this.hold;
    if (!d) return;
    this.hold = null;
    d.dispose();
    this.dropFollower();
  }

  ensureFollower() {
    const pos = this.sources.findIndex((s, i) => i !== this.clockPos);
    if (pos < 0) return;
    const source = this.sources[pos];
    const uri = source.v || source.av;
    if (this.follower.uri !== uri) {
      if (source.poster) this.fvideo.poster = source.poster;
      // Where the clock is, or is about to be while it is (re)loading.
      const at = this.clock.position();
      this.followerPos = pos;
      this.follower.quality = this.quality.qualityFor(pos);
      this.follower.priority = this.quality.roleOf(pos) === 'camera' ? 'low' : 'high';
      this.follower.load(uri, at, null);
    }
    if (!this.sync) this.sync = new FollowerSync(this.video, this.fvideo);
  }

  dropFollower() {
    if (this.sync) { this.sync.dispose(); this.sync = null; }
    if (this.follower.uri) this.follower.destroy();
    this.followerPos = -1;
  }

  applyLayout() {
    try { this.applyLayoutNow(); } catch (e) { if (this.constructing) throw e; reportUnexpected(e); }
  }

  applyLayoutNow() {
    // A new arrangement starts with whole pictures.
    if (this.zoom) this.zoom.resetAll();
    const layout = this.layout;
    const st = this.stage;
    const pdf = this.pdfMode;
    for (const l of LAYOUTS) st.classList.toggle('l-' + l, l === layout);
    for (const c of CORNERS) st.classList.toggle('c-' + c, c === this.prefs.corner);
    this.endHold();
    // One video plays when it is shown alone or next to the PDF.
    if (layout === 'single' || pdf) {
      if (this.clockPos !== this.primaryPos && this.sources[this.primaryPos].av) {
        // The follower already shows that view: its picture stays until the clock has one.
        const hold = this.followerPos === this.primaryPos && this.fvideo.readyState >= 2;
        // Asked of the stream, not the element: a switch made while the previous one is
        // still loading would otherwise read 0 (and paused) and start over.
        this.loadClock(this.primaryPos, this.clock.position(), this.clock.playing());
        if (hold) this.holdFollower(); else this.dropFollower();
      } else {
        this.dropFollower();
      }
    } else {
      this.ensureFollower();
    }
    this.assignSlots();
    this.renderLayoutButton();
    if (this.reader) {
      this.reader.setActive('main', pdf);
      if (pdf) this.redrawPdf();
    }
    this.quality.apply();
  }

  // ---- the PDF in the picture area ----

  setPdfMain(on) {
    this.prefs.pdfMain = !!on;
    // Shown alone the PDF would hide the video (or the other way round): put them side by side.
    if (on && this.prefs.layout === 'single') this.prefs.layout = 'side';
    this.savePrefs();
    this.applyLayout();
    if (this.reader) this.reader.info();
  }

  swapPdf() {
    this.prefs.pdfFirst = !this.prefs.pdfFirst;
    this.savePrefs();
    this.applyLayout();
  }

  // Re-renders the main PDF view at its new size (after a layout or window change).
  redrawPdf() {
    if (!this.reader || !this.pdfMode) return;
    windowOf(this.host).requestAnimationFrame(() => {
      const tg = this.reader.targets.get('main');
      const i = this.reader.currentView();
      if (tg && tg.active && i >= 0) this.reader.drawInto(tg, i);
    });
  }

  renderPdfBar() {
    const rd = this.reader;
    const deck = rd && rd.deck;
    const i = rd ? rd.currentView() : -1;
    if (!deck || i < 0) return;
    this.$('.plabel').textContent = rd.label();
    // With several files: the file's name, a button to the next file.
    const fb = this.$('.pfile');
    const shown = rd.shownFile();
    const next = rd.nextFile();
    fb.hidden = !next;
    if (next && shown) {
      fb.textContent = shown.name.replace(/\.pdf$/i, '');
      fb.dataset.tip = tr('showFile', { name: next.name });
      fb.setAttribute('aria-label', tr('pdfFileNext', { name: shown.name, next: next.name }));
    }
    this.$('.pprev').disabled = i <= 0;
    this.$('.pnext').disabled = i >= deck.pages.length - 1;
    const box = this.$('.pfollow');
    box.textContent = '';
    box.append(rd.followElement(true));
  }

  // What the user is looking at, for "copy picture": the larger of the pictures shown (a
  // video or the PDF view), the main place when they are the same size.
  // { video } or { page: { num, file, render(width) -> Promise of a canvas } }.
  focusView() {
    const slots = [...this.root.querySelectorAll('.views [data-slot=primary]'), ...this.root.querySelectorAll('.views [data-slot=secondary]')];
    let best = slots[0];
    for (const e of slots.slice(1)) if (e.clientWidth * e.clientHeight > best.clientWidth * best.clientHeight) best = e;
    const rd = this.reader;
    const i = rd && rd.deck ? rd.currentView() : -1;
    if (best && best.classList.contains('pdfview') && this.pdfMode && i >= 0) {
      const p = rd.deck.pages[i];
      return { page: { num: p.num, file: p.file, render: (w) => rd.deck.render(i, w, true) } };
    }
    return { video: best && best.tagName === 'VIDEO' ? best : this.video };
  }

  // Layouts offered in the settings menu ([]: one picture only).
  layoutChoices() {
    return this.dual || this.pdfMode ? LAYOUTS : [];
  }

  // The layout button's cycle. With the PDF view open it switches between side by side and
  // picture in picture: alone, the PDF or the video would be hidden (single view stays in
  // the settings menu).
  layoutCycle() {
    if (this.pdfMode) return ['side', 'pip'];
    return this.dual ? LAYOUTS : [];
  }

  nextLayout() {
    const list = this.layoutCycle();
    return list[(list.indexOf(this.layout) + 1) % list.length];
  }

  // The icon shows the layout now; the tooltip says what a press switches to.
  renderLayoutButton() {
    const b = this.$('.layout');
    const hide = !this.layoutCycle().length;
    if (b.hidden !== hide) { b.hidden = hide; this.menus.fitBar(); }
    if (hide) return;
    const now = this.layout;
    const to = tr({ side: 'layoutToSide', pip: 'layoutToPip', single: 'layoutToSingle' }[this.nextLayout()]);
    b.innerHTML = svg(now === 'side' ? 'layoutSide' : now === 'pip' ? 'layoutPip' : 'layoutSingle');
    b.setAttribute('aria-label', tr('layoutNow', { layout: tr(layoutKey(now)) }) + tr('sepSentence') + to);
    b.dataset.tip = to;
    this.menus.refresh();
  }

  setTheme(theme) {
    this.prefs.theme = theme;
    this.app.dataset.theme = theme;
    this.savePrefs();
  }

  // The interface language is decided when the page loads: a change is saved (with the
  // position) and the page reloads.
  setLang(lang) {
    if (lang === this.prefs.lang) return;
    this.prefs.lang = lang;
    clearTimeout(this.prefsTimer);
    store.set('prefs', this.prefs);
    this.reloadHere();
  }

  // Reloads the page and comes back where playback is now. (Echo360's own last position,
  // which pickStart prefers, follows only what was played, not a seek.)
  reloadHere() {
    store.set('reloadAt', { id: this.lesson.id, t: this.clock.position(), at: Date.now() });
    this.savePosition();
    location.reload();
  }

  setLayout(layout) {
    if (!(this.dual || this.pdfMode) || !LAYOUTS.includes(layout)) return;
    if (this.emptyScreen) this.emptyScreen.manual();
    this.followerFailed = false;
    this.prefs.layout = layout;
    this.savePrefs();
    this.applyLayout();
  }

  // Swaps the screen and camera views. With the PDF in the picture area, this changes which
  // video is shown next to it (or, with one video, swaps the PDF and the video).
  swapViews() {
    if (!this.dual) { if (this.pdfMode) this.swapPdf(); return; }
    // The camera was shown alone for an empty screen: a swap asks for the screen back.
    if (this.emptyScreen && this.emptyScreen.manual()) return;
    const next = this.secondaryPos;
    // A source without an audio+video rendition can only be shown as the follower.
    if ((this.layout === 'single' || this.pdfMode) && !this.sources[next].av) return;
    this.primaryPos = next;
    this.prefs.primary = this.sources[next].index;
    this.savePrefs();
    this.applyLayout();
  }

  onClockFatal(f) {
    if (this.destroyed) return;
    if (f.auth) {
      this.recoverAccess(this.clock, () => this.showAuthError());
      return;
    }
    this.showError(tr('playbackFailedTitle'), tr('playbackFailedText', { detail: playbackFailReason(f, navigator.onLine !== false) }),
      [[tr('retry'), () => this.retryPlayback(), true], [tr('useOriginal'), () => this.opts.onFallback('error')]]);
    this.playbackFailed = true;
  }

  retryPlayback() {
    this.hideError();
    this.loadClock(this.clockPos, this.clock.position(), true);
  }

  // Back online: load again at once instead of waiting for the next retry, and retry a
  // playback that gave up while offline. Parts that failed to load try again too.
  onOnline() {
    this.$('.nethint').hidden = true;
    if (this.playbackFailed) { this.retryPlayback(); return; }
    const v = this.video;
    if (!v.paused && v.readyState < 3) this.clock.kick(v.currentTime);
    if (this.follower && this.fvideo.readyState < 3) this.follower.kick(this.fvideo.currentTime);
    for (const retry of this.partRetries.values()) retry();
  }

  // The video files were refused: renew the access in the background and carry on from
  // the current position with the same element. A second refusal right after a renewal,
  // or a renewal that fails, ends in `fail`.
  recoverAccess(stream, fail) {
    const now = Date.now();
    if (stream.renewedAt && now - stream.renewedAt < RENEW_REFUSAL_MS) { fail(); return; }
    // The stream may be reloaded (views swapped) while renewing: resume only the instance
    // that failed; a new one has started loading by itself.
    const engine = stream.hls;
    this.session.renew(true).then(() => {
      if (this.destroyed || stream.hls !== engine) return;
      stream.renewedAt = Date.now();
      stream.resume(stream.position());
    }, () => { if (!this.destroyed) fail(); });
  }

  showAuthError() {
    const login = this.session.failed && this.session.failed.login;
    this.showError(tr('authExpiredTitle'), tr(login ? 'authLoginExpiredText' : 'authExpiredText'),
      [[tr('reload'), () => this.reloadHere(), true], [tr('useOriginal'), () => this.opts.onFallback('auth')]]);
  }

  onFollowerFatal() {
    if (this.destroyed || this.followerFailed) return;
    // Keep watching with the clock alone; the layout preference is kept for next time.
    this.followerFailed = true;
    this.applyLayout();
    this.toast(tr('secondViewLost'), tr('retry'), () => this.setLayout(this.prefs.layout));
  }

  // ---- the parts ----

  setupParts() {
    const $ = (sel) => this.$(sel);
    const savePrefs = () => this.savePrefs();
    const toast = (...a) => this.toast(...a);
    const isDestroyed = () => this.destroyed;
    const layer = this.$('.layer');
    this.pops = new Popovers(layer, this.d.child(), (open) => { if (open) this.wake(); else this.armIdle(); });
    this.tooltips = new Tooltips(this.root, layer, this.d.child());
    this.seekBar = new SeekBar({
      $, video: this.video, clock: this.clock, duration: () => this.duration(), seek: (t) => this.seek(t),
      isIdle: () => this.stage.classList.contains('idle'), armIdle: () => this.armIdle(), markers: this.markers, ui: this.ui,
      previewAt: (t) => this.previewAt(t), skipAt: (t) => (this.silence ? this.silence.skipAt(t) : null),
    }, this.d.child());
    this.quality = new QualityController({
      prefs: this.prefs, onChange: () => { if (this.menus) this.menus.refresh(); }, savePrefs, sources: this.sources, dual: this.dual,
      screenIndex: () => (this.slides ? this.slides.screenIndex : null),
      streams: () => [{ stream: this.clock, elem: this.video, pos: this.clockPos }, { stream: this.follower, elem: this.fvideo, pos: this.followerPos }],
      shown: () => (this.layout === 'single' || this.clockPos === this.primaryPos ? this.clock : this.follower),
      layout: () => this.layout,
    }, this.d.child());
    this.layoutControls = new LayoutControls({
      $, stage: this.stage, prefs: this.prefs, savePrefs, ui: this.ui, armIdle: () => this.armIdle(), redrawPdf: () => this.redrawPdf(),
      // A click swaps the two pictures (with the PDF shown: the PDF and the video).
      onPipClick: () => { if (this.pdfMode) this.swapPdf(); else this.swapViews(); },
    }, this.d.child());
    const notesReady = () => !!(this.notes && this.notesReady);
    this.menus = new MenuBar({
      $, root: this.root, pops: this.pops, stage: this.stage, video: this.video, prefs: this.prefs, savePrefs, cc: this.cc, toast,
      cues: () => this.cues || [], focusView: () => this.focusView(), title: this.lesson.title, duration: () => this.duration(),
      diagnostics: () => diagnosticsText(this),
      layouts: () => this.layoutChoices(), layout: () => this.layout, setLayout: (l) => this.setLayout(l), swap: () => this.swapViews(),
      canEmptyCamera: () => !!this.emptyScreen && this.dual,
      setEmptyCamera: (on) => { this.emptyScreen.setEnabled(on); this.emptyScreen.tick(this.clock.position()); },
      pdfMode: () => this.pdfMode, setTheme: (t) => this.setTheme(t), setLang: (l) => this.setLang(l),
      // Optional features add their pages and actions once they have started.
      pages: this.menuPages = { quality: () => this.quality.items(), audio: null, silence: null },
      values: this.menuValues = { quality: () => this.quality.value(), audio: () => '', silence: () => '' },
      actions: this.menuActions = {
        bookmark: (e) => { if (notesReady()) this.notes.toggleBookmark(e); },
        bookmarkHere: () => !!this.bookmarkHere,
        popout: PopoutController.supported() ? () => this.popout.toggle() : null,
        loopA: () => this.loop.setA(this.video.currentTime), loopB: () => this.loop.setB(this.video.currentTime),
        loopClear: () => this.loop.clear(), loopLabel: () => (this.loop ? this.loop.label() : tr('loopNone')),
        exportNotes: null, showKeys: () => this.keys.showHelp(true), original: () => this.opts.onFallback('user'),
      },
    }, this.d.child());
    this.menus.captionsAvailable(tr('captionsLoading'));
    this.volumeCtl = new VolumeControl({ $, video: this.video }, this.d.child());
    this.speed = new SpeedControl({ $, pops: this.pops, rate: () => this.video.playbackRate || this.prefs.rate, setRate: (r) => this.setRate(r) }, this.d.child());
    this.keys = new KeyboardShortcuts({ $, isDestroyed, wake: () => this.wake(), actions: this.keyActions() }, this.d.child());
    this.popout = new PopoutController({
      $, host: this.host, video: this.video, title: this.lesson.title, onKey: this.keys.onKey, isDestroyed, toast,
      relayout: () => { this.updateFullscreenButton(); this.quality.apply(); this.redrawPdf(); this.render(true); this.menus.fitBar(); this.pops.place(); },
    }, this.d.feature('floating window'));
  }

  // What the keyboard shortcuts do (see 42-keys.js); false: not available now.
  keyActions() {
    const v = this.video;
    const notesReady = () => this.notes && this.notesReady;
    return {
      togglePlay: () => this.togglePlay(),
      seekBy: (s) => this.seek(this.clock.position() + s),
      stepChapter: (dir) => this.stepChapter(dir),
      volumeBy: (dv) => this.volumeCtl.by(dv, true),
      toggleMute: () => { v.muted = !v.muted; },
      fullscreen: () => this.toggleFullscreen(),
      swap: () => this.swapViews(),
      captions: () => {
        const why = unavailableReason(this.$('.ccbtn'));
        if (why) this.toast(why); else this.menus.setCaptions(!this.cc.on);
      },
      transcript: () => (this.sidebar.has('transcript') ? this.sidebar.toggle('transcript') : false),
      bookmark: (a, e) => (notesReady() ? this.notes.toggleBookmark(e) : false),
      flag: (a, e) => (notesReady() && this.notes.canFlag ? this.notes.flagByKey(e) : false),
      tag: (a, e) => (notesReady() ? this.notes.tagHere(e) : false),
      copyFrame: () => this.menus.copyFrame(),
      copyCaptions: () => this.menus.copyCaptions(),
      escape: () => {
        if (this.menus.diagnosticsOpen) this.menus.showDiagnostics(false);
        else if (this.menus.myDataOpen) this.menus.showMyData(false);
        else if (this.keys.helpOpen) this.keys.showHelp(false);
        else if (this.pops.isOpen()) this.pops.close(true);
        else return false;
        return true;
      },
      zoom: (f) => this.zoomMain(f),
      loopA: () => this.loop.setA(v.currentTime),
      loopB: () => this.loop.setB(v.currentTime),
      loopClear: () => (this.loop.a != null ? this.loop.clear() : false),
      popout: () => (PopoutController.supported() ? this.popout.toggle() : false),
      exportNotes: () => (notesReady() ? this.notes.openExport() : false),
      speed: (dir) => this.setRate(nextSpeed(v.playbackRate, dir)),
    };
  }

  // ---- video events ----

  bindVideo() {
    const v = this.video;
    const stage = this.stage;
    // The clock video's events are core playback: an error here hands over to the original player.
    const d = this.d.core();
    const on = (type, fn) => d.listen(v, type, fn);
    on('play', () => {
      // Back after a long pause (or a sleeping laptop): renew the access before it runs out.
      this.session.wake();
      // Play is normally user-initiated; also recovers a context the browser suspended.
      if (this.audio) { this.audio.resume(); this.audio.syncTimer(); }
      this.renderPlay();
      if (this.reporter) this.reporter.onPlay();
      this.armIdle();
    });
    on('pause', () => {
      if (this.audio) this.audio.syncTimer();
      this.renderPlay();
      if (this.reporter) this.reporter.onPause();
      this.savePosition();
      this.wake();
    });
    on('waiting', () => stage.classList.add('waiting'));
    on('seeking', () => stage.classList.add('waiting'));
    const clearWaiting = () => stage.classList.remove('waiting');
    on('playing', clearWaiting);
    on('seeked', clearWaiting);
    on('canplay', clearWaiting);
    const invalidate = () => this.frame.request();
    // The optional features these events update: an error in one is not a playback error.
    // It is reported once and that feature is no longer updated here (these run several
    // times a second).
    const broken = new Set();
    const feature = (name, fn) => {
      if (broken.has(name)) return;
      try { fn(); } catch (e) { broken.add(name); reportFeatureError(name, e); }
    };
    const onTime = () => {
      const ct = v.currentTime;
      // Where playback is meant to be: while the start position loads, the element still
      // says 0, and nothing may act on that moment (skip a silence, switch the layout).
      const pos = this.clock.position();
      if (this.loop) feature('A-B loop', () => this.loop.tick(ct));
      feature('captions', () => { this.cc.update(ct); this.transcript.update(ct); });
      feature('notes', () => {
        const scene = Math.floor(ct / FLAG_SCENE_SECONDS);
        if (scene !== this.flagScene) { this.flagScene = scene; this.renderFlagButton(); }
        this.renderBookmarkButton();
      });
      if (this.silence) feature('silence detection', () => this.silence.tick(pos));
      if (this.slidesPane) feature('slide chapters', () => this.slidesPane.update(ct));
      if (this.reader) feature('slide reader', () => this.reader.update(ct));
      if (this.notes && this.notesReady) feature('notes', () => this.notes.update());
      if (this.emptyScreen) feature('camera for an empty screen', () => this.emptyScreen.tick(pos));
      if (this.discussion) feature('discussion', () => this.discussion.update());
    };
    on('timeupdate', () => { invalidate(); onTime(); });
    on('seeked', onTime);
    on('progress', invalidate);
    on('durationchange', () => {
      this.render(true);
      if (this.loop) feature('A-B loop', () => this.loop.render());
      feature('watched parts', () => this.renderWatched());
      feature('notes', () => this.updateMarkers());
      if (this.silence) feature('silence detection', () => this.silence.update());
      feature('slide chapters', () => this.renderChapterMarks());
    });
    on('ratechange', () => this.speed.render(v.playbackRate));
    on('volumechange', () => {
      this.volumeCtl.render();
      this.prefs.volume = v.volume;
      this.prefs.muted = v.muted;
      this.savePrefs();
    });
    on('ended', () => this.savePosition(0));
    d.listen(document, 'visibilitychange', () => { if (!document.hidden) this.render(true); });
    d.listen(window, 'hashchange', () => { const tm = this.linkTime(); if (tm != null) this.seek(tm); });
    d.listen(window, 'offline', () => { this.$('.nethint').hidden = false; });
    d.listen(window, 'online', () => this.onOnline());
    if (navigator.onLine === false) this.$('.nethint').hidden = false;

    // Stall watchdog (playing, not seeking, time has not moved for STALL_SEC) and, every
    // few ticks, the local resume position as a fallback for the server-side one.
    let lastT = -1;
    let still = 0;
    let tick = 0;
    d.interval(() => {
      if (v.paused || v.seeking || v.ended) { still = 0; lastT = v.currentTime; return; }
      if (v.currentTime === lastT) {
        still += STALL_CHECK_MS / 1000;
        if (still >= STALL_SEC) {
          log.warn('playback stalled, restarting loader at', v.currentTime.toFixed(1));
          this.clock.kick(v.currentTime);
          still = 0;
        }
      } else { still = 0; lastT = v.currentTime; }
      if (++tick % POSITION_SAVE_EVERY === 0) { this.savePosition(); this.watched.save(this.duration()); this.renderWatched(); }
    }, STALL_CHECK_MS);
  }

  setButton(sel, icon, label, tip) {
    const b = this.$(sel);
    b.innerHTML = svg(icon);
    b.setAttribute('aria-label', label);
    b.dataset.tip = tip;
  }

  savePrefs() {
    clearTimeout(this.prefsTimer);
    this.prefsTimer = setTimeout(() => store.set('prefs', this.prefs), 300);
  }

  savePosition(pos) {
    store.set('pos:' + this.lesson.id, { t: pos === undefined ? this.clock.position() : pos, at: Date.now() });
  }

  duration() {
    return mediaDuration(this.video, this.lesson);
  }

  // Time label, progress and buffer bars (at most once per frame, see SeekBar).
  render(force) {
    if (!this.destroyed) this.seekBar.render(force);
  }

  seek(target) {
    const dur = this.duration();
    const to = clamp(target, 0, dur ? dur - 0.1 : target);
    this.clock.intend(to, null);
    this.video.currentTime = to;
    this.render(true);
    if (this.loop) this.loop.seeked(to);
  }

  togglePlay() {
    const v = this.video;
    // While (re)loading the element says paused: go by what the stream is meant to do.
    const play = this.clock.starting ? !this.clock.playing() : v.paused || v.ended;
    this.clock.intend(null, play);
    if (play) v.play().catch(() => {}); else v.pause();
    this.renderPlay();
  }

  // The play button (and the paused look) show what playback is meant to do: while a stream
  // (re)loads the element says paused, though it is about to play (a takeover of a playing
  // original, a switch of views made while playing).
  renderPlay() {
    const play = this.clock.starting ? this.clock.playing() : !this.video.paused;
    this.stage.classList.toggle('paused', !play);
    if (play) this.setButton('.play', 'pause', tr('pause'), tr('pauseKey'));
    else this.setButton('.play', 'play', tr('play'), tr('playKey'));
  }

  setRate(r) {
    r = clamp(Math.round(r * 100) / 100, 0.25, 4);
    this.video.playbackRate = r;
    this.video.defaultPlaybackRate = r;
    this.prefs.rate = r;
    this.savePrefs();
  }

  // Where no element can be fullscreen (iPhone), the main video goes into the system's own
  // player: one view, its own controls; back inline it plays on in ours.
  toggleFullscreen() {
    const why = this.fullscreenWhyNot();
    if (why) { this.toast(why); return; }
    if (fullscreenElement()) exitFullscreen();
    else if (!requestFullscreen(this.host) && typeof this.video.webkitEnterFullscreen === 'function') this.video.webkitEnterFullscreen();
  }

  // Why full screen cannot be used here, or '': the floating window never allows it; in a
  // frame whose page does not allow it, neither the player nor a video can be fullscreen.
  fullscreenWhyNot() {
    if (this.host.ownerDocument !== document) return tr('fullscreenPopout');
    if (!fullscreenAllowed(document) && typeof this.video.webkitEnterFullscreen !== 'function') return tr('fullscreenBlocked');
    return '';
  }

  // Said on the button instead of a click that does nothing.
  updateFullscreenButton() {
    setUnavailable(this.$('.fs'), this.fullscreenWhyNot(), tr('fullscreenKey'));
  }

  // ---- idle (auto-hide) handling ----

  wake() {
    const wasIdle = this.stage.classList.contains('idle');
    this.stage.classList.remove('idle');
    if (wasIdle) this.render(true);
    this.armIdle();
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(guard(() => {
      if (!this.video.paused && !this.ui.dragging && !this.pops.isOpen()) this.stage.classList.add('idle');
    }), CONTROLS_HIDE_MS);
  }

  // The plain buttons, clicks on the pictures, zoom, the side panel chips.
  bindControls() {
    const $ = (sel) => this.$(sel);
    const v = this.video;
    const d = this.d;
    // Old analysis results are cleaned up in the background, once the page has settled.
    d.timeout(() => analysisCaches.prune().catch(() => {}), 60000);
    d.add(() => { clearTimeout(this.idleTimer); clearTimeout(this.toastTimer); clearTimeout(this.sharpTimer); clearTimeout(this.prefsTimer); store.set('prefs', this.prefs); });
    d.listen($('.play'), 'click', () => this.togglePlay());
    d.listen($('.rew'), 'click', () => this.seek(this.clock.position() - 10));
    d.listen($('.fwd'), 'click', () => this.seek(this.clock.position() + 10));
    d.listen($('.fs'), 'click', () => this.toggleFullscreen());
    this.updateFullscreenButton();
    d.listen($('.swapdot'), 'click', (e) => { e.stopPropagation(); this.swapViews(); });
    d.listen($('.layout'), 'click', () => this.setLayout(this.nextLayout()));
    const onFullscreen = () => {
      const fs = !!fullscreenElement();
      this.setButton('.fs', fs ? 'exitFullscreen' : 'fullscreen', tr(fs ? 'exitFullscreen' : 'fullscreen'), tr(fs ? 'exitFullscreenKey' : 'fullscreenKey'));
    };
    d.listen(document, 'fullscreenchange', onFullscreen);
    d.listen(document, 'webkitfullscreenchange', onFullscreen);
    let resizeTimer = 0;
    d.add(() => clearTimeout(resizeTimer));
    d.listen(window, 'resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(guard(() => { this.quality.apply(); this.redrawPdf(); }), 500); });
    for (const chip of this.all('.top [data-open]')) d.listen(chip, 'click', () => this.sidebar.toggle(chip.dataset.open));
    d.listen($('.panelclose'), 'click', () => this.sidebar.close());
    d.listen($('.bmbtn'), 'click', (e) => { if (this.notes && this.notesReady) this.notes.toggleBookmark(e); });
    d.listen($('.pextras button'), 'click', () => this.opts.onFallback('extras'));
    this.bindPanelResize();
    this.loop = new ABLoop({
      pops: this.pops, rail: $('.seek'), video: v, duration: () => this.duration(), seek: (t) => this.seek(t), toast: (...a) => this.toast(...a),
    }, this.d.feature('A-B loop'));

    // Click on a picture: play/pause; double click: fullscreen. While the controls are
    // hidden, the first click only brings them back (it may be aimed at a hidden button).
    let clickTimer = 0;
    let wokeByPress = false;
    d.add(() => clearTimeout(clickTimer));
    d.listen(this.stage, 'pointerdown', () => {
      wokeByPress = this.stage.classList.contains('idle');
      this.wake();
    }, true);
    const views = $('.views');
    this.zoom = new Zoomer(views, this.d.feature('zoom'), {
      // The PDF is drawn again at the zoom level once zooming pauses (in steps, so that
      // small changes do not render it again).
      onChange: () => {
        clearTimeout(this.sharpTimer);
        this.sharpTimer = setTimeout(guard(() => {
          const tg = this.reader && this.reader.targets.get('main');
          if (!tg || this.destroyed) return;
          const sharp = Math.min(4, Math.max(1, Math.round(this.zoom.get(tg.pages).s * 2) / 2));
          if (sharp !== (tg.sharp || 1)) { tg.sharp = sharp; this.redrawPdf(); }
        }), 250);
      },
      // Not the small picture-in-picture window.
      canZoom: (elem) => !(this.layout === 'pip' && (elem.closest('[data-slot]') || elem).dataset.slot === 'secondary'),
    });
    d.listen(views, 'click', (e) => {
      if (e.target.tagName !== 'VIDEO') return;
      if (this.zoom.dragged) return;
      if (wokeByPress) { wokeByPress = false; return; }
      clearTimeout(clickTimer);
      clickTimer = setTimeout(guard(() => this.togglePlay()), DOUBLE_CLICK_MS);
    });
    d.listen(views, 'dblclick', (e) => {
      // Zoomed in: back to the whole picture; otherwise full screen.
      const z = this.zoom.targetOf(e.target);
      if (z && this.zoom.zoomed(z)) { clearTimeout(clickTimer); this.zoom.reset(z); return; }
      if (e.target.tagName !== 'VIDEO') return;
      clearTimeout(clickTimer);
      this.toggleFullscreen();
    });

    // Auto-hide
    d.listen(this.stage, 'pointermove', () => this.wake());
    d.listen(this.stage, 'pointerleave', (e) => {
      // Touch ends with pointerleave even when the finger was lifted inside the player.
      // Keep the controls until the idle timer expires so the next tap can pause.
      if (e.pointerType !== 'touch' && !v.paused) this.stage.classList.add('idle');
    });
  }

  // ---- captions and transcript ----

  loadCues() {
    this.cues = null;
    const none = () => { if (!this.destroyed) this.menus.captionsAvailable(tr('captionsNone')); };
    if (!this.opts.fetchCues) { none(); if (this.silence) this.silence.start([]); return; }
    // Silence detection waits until it is known whether there is a transcript (a load that
    // failed for now is retried), so that it does not settle for the audio-only analysis.
    let cues = [];
    const load = () => this.opts.fetchCues(this.lesson).then((c) => {
      if (this.destroyed) return false;
      if (this.silence) this.silence.start(c);
      if (!c.length) { none(); return false; }
      cues = c;
      return true;
    }, (e) => {
      log.warn('captions:', e && e.message ? e.message : e);
      if (this.destroyed) return false;
      if (isTransient(e) || e.login) { this.menus.captionsAvailable(tr('captionsLoadFailed')); return e; }
      none();
      if (this.silence) this.silence.start([]);
      return false;
    });
    this.loadPart('transcript', this.transcript, load, () => {
      this.cues = cues;
      if (this.slidesPane) this.slidesPane.invalidate();
      if (this.reporter) this.reporter.captionsAvailable = cues.length;
      this.cc.setCues(cues);
      this.transcript.setCues(cues);
      this.menus.captionsAvailable('');
      if (this.prefs.captions) this.menus.setCaptions(true, true);
    }, 'transcriptLoadFailed');
  }

  // ---- audio processing ----

  setupAudio() {
    const a = new AudioChain(this.video);
    this.audio = a;
    this.d.add(() => a.dispose());
    a.settings = { level: !!this.prefs.audio.level, voice: !!this.prefs.audio.voice, mono: !!this.prefs.audio.mono };
    const why = () => (a.reason === 'noWebAudio' ? tr('audioNoWebAudio') : a.reason ? tr('audioNativeHls') : '');
    // The settings page: one switch per tool (shown off, with the reason, when unsupported).
    this.menuPages.audio = () => [['level', 'audioLevel'], ['voice', 'audioVoice'], ['mono', 'audioMono']].map(([k, label]) => ({
      kind: 'toggle', label: tr(label), desc: tr(label + 'Desc'), reason: why, on: () => !!a.settings[k],
      set: (on) => {
        a.build();
        a.resume();
        a.set({ [k]: !!on });
        this.prefs.audio = Object.assign({}, a.settings, { levelChosen: this.prefs.audio.levelChosen || k === 'level' });
        this.savePrefs();
      },
    }));
    this.menuValues.audio = () => (!a.reason && a.anyOn() ? tr('on') : tr('off'));
    // Remembered settings: build the graph on the first user gesture, never before.
    if (!a.reason && a.anyOn()) {
      const onGesture = () => {
        if (a.built) return;
        a.build();
        a.resume();
        a.apply();
      };
      this.d.listen(this.host, 'pointerdown', onGesture, true);
      this.d.listen(document, 'keydown', onGesture, true);
    }
  }

  // ---- slide chapters ----

  setupSlides() {
    this.slidesPane = null;
    this.slides = new SlideAnalyzer({
      lesson: this.lesson,
      video: this.video,
      disposer: this.d.feature('slide chapters'),
      onChange: () => { if (!this.destroyed) this.onSlidesChange(); },
    });
    this.slides.start();
  }

  onSlidesChange() {
    const a = this.slides;
    let empty = false;
    if (a.uniform !== this.knownUniform) { this.knownUniform = a.uniform; empty = true; if (this.silence) this.silence.update(); }
    // The screen view is known now: the per-view quality settings may apply differently.
    if (a.screenIndex !== this.knownScreen) {
      this.knownScreen = a.screenIndex;
      empty = true;
      this.quality.apply();
      if (this.deck) this.deck.screenKnown();
    }
    if (empty && this.emptyScreen) this.emptyScreen.tick(this.clock.position());
    this.renderChapterMarks();
    if (a.chapters.length && this.usage) this.usage.mark('chapters');
    // The tab also holds the slide reader: it is there once the analysis has an answer,
    // even when no chapters were found.
    if (!this.slidesPane && !a.chapters.length && a.state !== 'done' && a.state !== 'unavailable') return;
    if (a.state === 'unavailable' && this.deck) this.deck.screenKnown();
    if (!this.slidesPane) {
      this.slidesPane = new SlidesPane(this, this.$('.pane[data-pane=slides]'), this.d.child());
      this.registerTab('slides', this.slidesPane);
    }
    const pct = Math.floor(a.progress * 100);
    const status = a.reason === 'saveData' && !a.chapters.length ? tr('slidesSaveData')
      : !a.chapters.length && (a.state === 'done' || a.state === 'unavailable') ? tr('slidesNone')
      : a.state === 'done' ? tr(a.source === 'thumbs' ? 'slidesFromPreview' : 'slidesFound', { n: a.chapters.length })
        : !HlsVideoReader.supported() ? tr('slidesPreviewFinding')
          : a.state === 'thumbnails' ? tr('slidesRough', { pct }) : tr('slidesFinding', { pct });
    this.slidesPane.setChapters(a.chapters, status);
  }

  // ---- slide files ----

  setupDeck() {
    this.reader = new SlideReader(this);
    this.reader.addTarget('main', this.$('.pstage'));
    this.d.add(this.reader.onInfo(() => { if (!this.destroyed) this.renderPdfBar(); }));
    this.deck = new SlideDeckController({
      lesson: this.lesson,
      video: this.video,
      slides: this.slides,
      disposer: this.d.feature('slide reader'),
      onChange: () => {
        if (this.destroyed) return;
        if (this.slidesPane) this.slidesPane.invalidate();
        // The PDF view appears (pages loaded) or goes (files removed) with the deck.
        if (this.pdfMode !== this.shownPdfMode) { this.shownPdfMode = this.pdfMode; this.applyLayout(); }
        if (this.reader.active) this.reader.update(this.video.currentTime, true);
        if (this.deck && this.deck.decided && this.usage) this.usage.mark('pdf');
      },
    });
    this.deck.restore().catch((e) => log.warn('slide files:', e && e.message ? e.message : e));
    const bar = (sel, fn) => this.d.listen(this.$(sel), 'click', (e) => { e.stopPropagation(); fn(); });
    bar('.pprev', () => this.reader.turn(-1));
    bar('.pnext', () => this.reader.turn(1));
    bar('.pfile', () => { const f = this.reader.nextFile(); if (f) this.reader.showFile(f.hash); });
    bar('.pswap', () => this.swapPdf());
    bar('.pdfclose', () => this.setPdfMain(false));
    // Dropping PDF files anywhere on the player adds them.
    const zone = this.$('.dropzone');
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    let depth = 0;
    this.d.listen(this.host, 'dragenter', (e) => { if (hasFiles(e)) { depth++; zone.hidden = false; } });
    this.d.listen(this.host, 'dragleave', () => { if (--depth <= 0) { depth = 0; zone.hidden = true; } });
    this.d.listen(this.host, 'dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    this.d.listen(this.host, 'drop', (e) => {
      depth = 0;
      zone.hidden = true;
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.deck.addFiles(e.dataTransfer.files).then((n) => {
        if (!n) { this.toast(tr('dropNotPdf')); return; }
        if (this.sidebar.has('slides')) this.sidebar.open('slides');
      }).catch((err) => this.toast(this.deck.notice || tr('deckError', { msg: String((err && err.message) || err) })));
    });
  }

  renderChapterMarks() {
    this.seekBar.renderChapters(this.slides ? this.slides.chapters : []);
  }

  renderWatched() {
    if (this.watched.ready) this.seekBar.renderWatched(this.watched.ranges());
  }

  // Picture for the seek-bar preview: the slide shown at t if chapters are known,
  // otherwise Echo360's per-minute thumbnail of the main view.
  previewAt(t) {
    const chs = this.slides ? this.slides.chapters : [];
    const k = chapterIndexAt(chs, t);
    if (k >= 0 && chs[k].thumb) return chs[k].thumb;
    const src = this.sources[this.primaryPos];
    const set = (this.lesson.thumbnails || []).find((s) => s.sourceIndex === src.index);
    if (!set || !Array.isArray(set.timesInSeconds) || !set.timesInSeconds.length) return '';
    const times = set.timesInSeconds;
    let pick = times[0];
    for (const x of times) { if (x <= t) pick = x; else break; }
    return thumbUrlOf(set, pick);
  }

  // Previous / next chapter; returns false when there are none (key not handled).
  stepChapter(dir) {
    const chs = this.slides ? this.slides.chapters : [];
    if (!chs.length) return false;
    const ct = this.video.currentTime;
    let k = chapterIndexAt(chs, ct);
    // "Previous" from more than 3 s into a chapter restarts it, like a music player.
    if (dir < 0 && k >= 0 && ct - chs[k].start > 3) dir = 0;
    k = clamp(k + dir, 0, chs.length - 1);
    this.seek(chs[k].start);
    return true;
  }

  // ---- side panel, notes, discussion, markers ----

  registerTab(tab, controller) {
    this.sidebar.register(tab, controller);
    if (this.prefs.panel && this.prefs.tab === tab && !this.sidebar.isOpen) {
      this.restoringPanel = true;
      this.sidebar.open(tab);
      this.restoringPanel = false;
    }
  }

  onSidebarChange() {
    const sb = this.sidebar;
    this.app.classList.toggle('panel-open', sb.isOpen);
    for (const chip of this.all('.top [data-open]')) chip.setAttribute('aria-pressed', String(sb.visible(chip.dataset.open)));
    if (sb.visible('transcript')) this.transcript.renderMarks();
    if (!this.restoringPanel && sb.active) {
      this.prefs.panel = sb.isOpen;
      this.prefs.tab = sb.active;
      this.savePrefs();
    }
  }

  loadInteractions() {
    const l = this.lesson;
    const api = this.opts.api && l.lessonId && l.mediaId ? this.opts.api(l) : null;
    if (!api) return;
    this.writesHeld = api.dryRun;
    const canFlag = !!l.sectionId && !l.isAnonymousUser;
    this.tags = new TagStore(l, () => { if (!this.destroyed && this.notes) this.notes.changed(); });
    this.tags.load().catch((e) => log.warn('tags:', e && e.message ? e.message : e));
    this.notes = new NotesPane(this, this.$('.pane[data-pane=notes]'), api, canFlag, this.d.feature('notes'));
    this.loadPart('notes', this.notes, () => this.notes.load(), () => {
      this.notesReady = true;
      this.$('.bmbtn').hidden = false;
      this.menus.fitBar();
      this.menuActions.exportNotes = () => this.notes.openExport();
      this.renderFlagButton();
      this.renderBookmarkButton();
    }, 'notesLoadFailed');
    this.discussion = new DiscussionPane(this, this.$('.pane[data-pane=discussion]'), api, this.d.feature('discussion'));
    this.loadPart('discussion', this.discussion, () => this.discussion.load(), () => {}, 'discussionLoadFailed');
  }

  // Loads what a side-panel tab shows. `load` resolves true when loaded, false when this
  // lesson does not offer it (no tab), or to the error. An error that may pass by itself
  // (isTransient: no connection, server error) keeps the tab, which says what happened
  // with "Retry"; it is also tried again when the browser comes back online.
  loadPart(tab, controller, load, ready, failKey) {
    const pane = this.$('.pane[data-pane=' + tab + ']');
    let busy = false;
    const attempt = () => {
      if (busy || this.destroyed) return;
      busy = true;
      Promise.resolve().then(load).then((r) => r, (e) => e).then(guard((r) => {
        busy = false;
        if (this.destroyed) return;
        if (r === true) {
          this.partRetries.delete(tab);
          this.showPartError(pane, '');
          ready();
          this.registerTab(tab, controller);
        } else if (r && (r.login || (r.status === 401 && !this.lesson.isAnonymousUser))) {
          // Signed out: only signing in again helps, which a reload offers.
          this.showPartError(pane, tr('authLoginExpiredText'), () => this.reloadHere(), tr('reload'));
          this.registerTab(tab, controller);
        } else if (r && isTransient(r)) {
          log.info(tab + ' failed to load, can retry:', r.message);
          this.partRetries.set(tab, attempt);
          this.showPartError(pane, tr(failKey, { error: loadErrorText(r) }), attempt);
          this.registerTab(tab, controller);
        }
      }));
    };
    attempt();
  }

  showPartError(pane, msg, action, label) {
    let box = pane.querySelector(':scope > .loaderr');
    if (msg && !box) {
      box = el('div.loaderr', { role: 'alert' }, el('p'), el('button.pbtn'));
      pane.prepend(box);
    }
    pane.classList.toggle('loadfailed', !!msg);
    if (!box) return;
    box.hidden = !msg;
    box.querySelector('p').textContent = msg;
    const b = box.querySelector('button');
    b.textContent = label || tr('retry');
    b.onclick = action || null;
  }

  updateMarkers() {
    if (this.destroyed) return;
    const items = [];
    // Where Echo360 says playback stopped last time (any device), as it was when the page opened.
    const last = this.lesson.resumeAt;
    if (last > 1 && last < this.duration() - 1) items.push({ time: last, kind: 'laststop', label: tr('lastStopped') });
    if (this.notes) items.push(...this.notes.markers());
    if (this.discussion && this.sidebar.has('discussion')) items.push(...this.discussion.markers());
    this.markers.set(items, this.duration());
  }

  // The "Didn't understand" button in the Notes tab follows the part playing.
  // The bookmark button is on while a bookmark is near the playing moment (a press then
  // removes it). Changes the button only when that changes.
  renderBookmarkButton() {
    if (!this.notes || !this.notesReady) return;
    const here = !!this.notes.bookmarkNear(this.video.currentTime);
    if (here === this.bookmarkHere) return;
    this.bookmarkHere = here;
    const b = this.$('.bmbtn');
    setPressed(b, here);
    b.innerHTML = svg(here ? 'bookmarkOn' : 'bookmark');
    b.dataset.tip = tr(here ? 'removeBookmarkKey' : 'bookmarkKey');
    this.menus.refresh();
  }

  renderFlagButton() {
    if (this.notes && this.notesReady) this.notes.renderFlagRow();
  }

  renderExtras() {
    const x = this.lesson.extras || {};
    const what = [x.polls && tr('extraPolls'), x.slides && tr('extraSlides'), x.audioDescription && tr('extraAudioDescription')].filter(Boolean);
    const box = this.$('.pextras');
    box.hidden = !what.length;
    if (what.length) box.querySelector('.msg').textContent = tr('extrasNotice', { what: what.join(tr('sepList')) });
  }

  bindPanelResize() {
    const handle = this.$('.presize');
    const setWidth = (w) => {
      this.prefs.panelw = w;
      this.app.style.setProperty('--panelw', w + 'px');
    };
    onDrag(this.d, handle, {
      start: (e) => {
        if (e.button !== 0) return null;
        handle.setPointerCapture(e.pointerId);
        return { rect: this.app.getBoundingClientRect(), from: this.prefs.panelw };
      },
      move: (e, st) => setWidth(Math.round(clamp(st.rect.right - e.clientX, 260, Math.min(640, st.rect.width * 0.6)))),
      done: () => this.savePrefs(),
      cancel: (st) => setWidth(st.from),
    });
  }

  // Keyboard zoom on the main picture (the primary slot), around its centre; 0 resets.
  zoomMain(factor) {
    const slot = this.root.querySelector('.views [data-slot=primary]');
    const elem = slot && (slot.tagName === 'VIDEO' ? slot : slot.querySelector('.rpages'));
    if (!elem) return;
    if (!factor) { this.zoom.reset(elem); return; }
    this.zoom.zoomAt(elem, factor, 0.5, 0.5);
  }

  // One message at a time. opts.later: an automatic message (opts.from names its source)
  // waits while another source's message is shown, so that it does not take away an action
  // the user may still want (such as "Start over"); it replaces one from its own source.
  // When the shown one closes, the newest waiting one follows if opts.valid() still holds.
  toast(msg, action, fn, opts) {
    const elem = this.$('.toast');
    const o = opts || {};
    if (o.later && !elem.hidden && this.toastFrom !== o.from) { this.toastNext = [msg, action, fn, o]; return; }
    this.toastNext = null;
    this.toastFrom = o.from || null;
    elem.querySelector('.msg').textContent = msg;
    const btn = elem.querySelector('.act');
    btn.hidden = !action;
    btn.textContent = action || '';
    const close = () => {
      elem.hidden = true;
      this.toastFrom = null;
      const next = this.toastNext;
      this.toastNext = null;
      if (next && !this.destroyed && (!next[3].valid || next[3].valid())) this.toast(next[0], next[1], next[2], { from: next[3].from });
    };
    btn.onclick = guard((ev) => { close(); if (fn) fn(ev); });
    elem.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(close, 8000);
  }

  showError(title, text, actions) {
    const box = this.$('.error');
    box.querySelector('h2').textContent = title;
    box.querySelector('p').textContent = text;
    const wrap = box.querySelector('.actions');
    wrap.textContent = '';
    for (const [label, fn, primary] of actions) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = primary ? 'pbtn primary' : 'pbtn';
      b.addEventListener('click', fn);
      wrap.appendChild(b);
    }
    box.hidden = false;
    wrap.firstChild.focus({ preventScroll: true });
    this.wake();
  }

  hideError() { this.$('.error').hidden = true; this.playbackFailed = false; }

  destroy() {
    if (this.destroyed) return;
    this.savePosition();
    this.destroyed = true;
    this.d.dispose();
  }
}

// ---- 41-seekbar.js ----
// ===================================================================================
// The progress bar: time label, progress and buffer, dragging and clicking to seek, the
// hover tip (time, marker or skippable stretch, preview picture), and the marks drawn on
// the rail (chapters, skippable stretches, what was watched).
//
// Gets only what it needs (see the player's setupParts):
//   $(sel)          the player's markup
//   video, clock    the clock <video> and its Stream (position while loading)
//   duration()      seconds
//   seek(t)         seek the player
//   isIdle()        controls hidden (nothing to draw)
//   armIdle()       restart the hide timer after a drag
//   markers         MarkersLayer (notes, bookmarks... on the bar)
//   ui              shared { dragging }
//   previewAt(t)    picture URL for the tip, or ''
//   skipAt(t)       the skippable stretch at t, or null
// ===================================================================================

class SeekBar {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.el = deps.$('.seek');
    this.timeCur = deps.$('.cur');
    this.timeDur = deps.$('.dur');
    this.lastSecond = -1;
    this.lastP = -1;
    this.lastB = -1;
    this.bind();
  }

  // Time label, progress and buffer bars. Called at most once per frame, and only while
  // the controls are visible (a forced call draws anyway).
  render(force) {
    const x = this.x;
    if (!force && x.isIdle()) return;
    const v = x.video;
    const dur = x.duration();
    const ct = x.clock.position();
    const sec = Math.floor(ct);
    if (force || sec !== this.lastSecond) {
      this.lastSecond = sec;
      const long = dur >= 3600;
      this.timeCur.textContent = fmtTime(ct, long);
      this.timeDur.textContent = fmtTime(dur, long);
      this.el.setAttribute('aria-valuetext', fmtTime(ct, long));
    }
    if (!dur) return;
    if (!x.ui.dragging) {
      const p = ct / dur;
      if (force || Math.abs(p - this.lastP) > 0.0002) {
        this.lastP = p;
        this.el.style.setProperty('--p', p.toFixed(5));
      }
    }
    const buf = v.buffered;
    let end = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf.start(i) <= ct + 0.5 && buf.end(i) > end) end = buf.end(i);
    }
    const b = end / dur;
    if (force || Math.abs(b - this.lastB) > 0.001) {
      this.lastB = b;
      this.el.style.setProperty('--b', b.toFixed(4));
    }
  }

  // Stretches [{ start, end, kind? }] as marks in the element `sel` (kind other than
  // 'silence' is drawn as an empty part).
  drawStretches(sel, list) {
    const box = this.x.$(sel);
    box.textContent = '';
    const dur = this.x.duration();
    if (!dur) return;
    const frag = document.createDocumentFragment();
    for (const s of list) {
      const i = document.createElement('i');
      if (s.kind && s.kind !== 'silence') i.className = 'empty';
      i.style.left = ((s.start / dur) * 100).toFixed(3) + '%';
      i.style.width = (((Math.min(s.end, dur) - s.start) / dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    box.appendChild(frag);
  }

  renderChapters(chapters) {
    const box = this.x.$('.chaps');
    box.textContent = '';
    const dur = this.x.duration();
    if (!dur) return;
    const frag = document.createDocumentFragment();
    for (const c of chapters) {
      if (c.start <= 0 || c.start >= dur) continue;
      const i = document.createElement('i');
      i.style.left = ((c.start / dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    box.appendChild(frag);
  }

  renderSkips(skips) { this.drawStretches('.sils', skips); }

  // Stretches watched on this device (earlier visits and this one), faint on the rail.
  renderWatched(ranges) { this.drawStretches('.wat', ranges.map(([start, end]) => ({ start, end }))); }

  bind() {
    const x = this.x;
    const d = this.d;
    const seekEl = this.el;
    const tip = x.$('.tip');
    const tipText = tip.querySelector('.tt');
    const tipLabel = tip.querySelector('.tl');
    const tipImg = tip.querySelector('.pv');
    let rect = null;
    let lastSeekAt = 0;
    const frac = (cx) => clamp((cx - rect.left) / rect.width, 0, 1);
    let nearMarker = null;
    let downX = 0;
    // null: the bar has no width (not laid out), so no position can be read from it.
    const hover = (e) => {
      if (!rect) rect = seekEl.getBoundingClientRect();
      if (!(rect.width > 0)) return null;
      const f = frac(e.clientX);
      const dur = x.duration();
      seekEl.style.setProperty('--h', f.toFixed(4));
      nearMarker = x.markers.nearest(f, rect.width, 6);
      const sil = nearMarker ? null : x.skipAt(f * dur);
      tipText.textContent = fmtTime(nearMarker ? nearMarker.time : f * dur, dur >= 3600);
      tipLabel.textContent = nearMarker ? (nearMarker.label.length > 70 ? nearMarker.label.slice(0, 67) + '…' : nearMarker.label)
        : sil ? tr(sil.kind + 'Tip', { time: fmtTime(sil.end - sil.start) }) : '';
      const pv = x.previewAt(nearMarker ? nearMarker.time : f * dur);
      if (pv) { if (tipImg.getAttribute('src') !== pv) tipImg.src = pv; tipImg.hidden = false; } else tipImg.hidden = true;
      const half = pv ? 96 : 24;
      tip.style.left = clamp(f * rect.width, half, rect.width - half) + 'px';
      return f;
    };
    d.listen(seekEl, 'pointerenter', () => { rect = seekEl.getBoundingClientRect(); });
    d.listen(seekEl, 'pointermove', (e) => { hover(e); });
    // Dragging: seeks along the way; lifting the finger seeks there (a click next to a
    // marker jumps exactly to the marked time); a cancelled touch goes back to where
    // playback was before.
    onDrag(d, seekEl, {
      start: (e) => {
        if (e.button !== 0) return null;
        rect = seekEl.getBoundingClientRect();
        if (!(rect.width > 0)) return null;
        seekEl.setPointerCapture(e.pointerId);
        downX = e.clientX;
        x.ui.dragging = true;
        seekEl.classList.add('dragging');
        seekEl.style.setProperty('--p', hover(e).toFixed(5));
        return { from: x.clock.position(), moved: false };
      },
      move: (e, st) => {
        const f = frac(e.clientX);
        seekEl.style.setProperty('--p', f.toFixed(5));
        const now = performance.now();
        if (now - lastSeekAt > DRAG_SEEK_MS) { lastSeekAt = now; st.moved = true; x.video.currentTime = f * x.duration(); }
      },
      done: (e) => {
        x.ui.dragging = false;
        seekEl.classList.remove('dragging');
        if (nearMarker && Math.abs(e.clientX - downX) < 4) x.seek(nearMarker.time);
        else x.seek(frac(e.clientX) * x.duration());
        x.armIdle();
      },
      cancel: (st) => {
        x.ui.dragging = false;
        seekEl.classList.remove('dragging');
        if (st.moved) x.seek(st.from);
        this.render(true);
        x.armIdle();
      },
    });
    d.listen(seekEl, 'keydown', (e) => {
      if (e.key === 'Home') { x.seek(0); e.preventDefault(); }
      if (e.key === 'End') { x.seek(x.duration()); e.preventDefault(); }
    });
    d.listen(window, 'resize', () => { rect = null; });
  }
}

// ---- 42-keys.js ----
// ===================================================================================
// Keyboard shortcuts and their help panel (`?`).
//
// Keys are mapped to named actions the player provides (the player's keyActions); an
// action returning false means "not available now" and the key is left to the page.
// Typing in a field never triggers a shortcut.
// ===================================================================================

// As listed in the help panel: [keys, string key].
/** @type {[string[], string][]} */
const KEY_HELP = [
  [['Space', 'K'], 'keyPlay'], [['←', '→'], 'keySeek5'], [['J', 'L'], 'keySeek10'], [['↑', '↓'], 'keyVolume'],
  [['M'], 'keyMute'], [['F'], 'keyFullscreen'], [['S'], 'keySwap'], [['[', ']'], 'keySpeed'],
  [['C'], 'keyCaptions'], [['T'], 'keyTranscript'], [['B'], 'keyBookmark'], [['G'], 'keyTag'], [['U'], 'keyFlag'],
  [['Shift+←', 'Shift+→'], 'keySlide'], [['P'], 'keyCopyFrame'], [['A'], 'keyCopyCaptions'],
  [['W'], 'keyPopout'], [['E'], 'keyExport'], [['+', '-'], 'keyZoom'], [['0'], 'keyZoomReset'], [['I', 'O'], 'keyLoop'], [['X'], 'keyLoopClear'],
  [['?'], 'keyHelp'], [['Esc'], 'keyEscape'],
];

// Key (as KeyboardEvent.key, letters in either case) -> [action, argument]. Shift+arrows
// step through chapters.
const KEY_ACTIONS = {
  ' ': ['togglePlay'], k: ['togglePlay'],
  ArrowLeft: ['seekBy', -5], ArrowRight: ['seekBy', 5], j: ['seekBy', -10], l: ['seekBy', 10],
  ArrowUp: ['volumeBy', VOLUME_STEP], ArrowDown: ['volumeBy', -VOLUME_STEP], m: ['toggleMute'],
  f: ['fullscreen'], s: ['swap'], c: ['captions'], t: ['transcript'],
  b: ['bookmark'], u: ['flag'], g: ['tag'], p: ['copyFrame'], a: ['copyCaptions'],
  Escape: ['escape'], '?': ['help'],
  '+': ['zoom', 1.25], '=': ['zoom', 1.25], '-': ['zoom', 0.8], _: ['zoom', 0.8], 0: ['zoom', 0],
  i: ['loopA'], o: ['loopB'], x: ['loopClear'], w: ['popout'], e: ['exportNotes'],
  ']': ['speed', 1], '[': ['speed', -1],
};

// Actions a held key repeats (steps); every other action is one per press: a held B
// would otherwise add and remove the bookmark on Echo360 again and again.
const KEY_REPEATS = new Set(['seekBy', 'volumeBy', 'zoom', 'speed', 'stepChapter']);

// Whether the focused element `t` handles key k itself (see KeyboardShortcuts.handle).
function ownsKey(t, k) {
  if (!t.matches || !keyboardFocused(t)) return false;
  if (k === ' ' || k === 'Enter') return t.matches('button, [role=button], [role=tab], a[href], summary, input[type=checkbox], input[type=radio]') || !!t.closest('.panel');
  if (/^Arrow/.test(k)) return t.matches('[role=separator]') || !!t.closest('.panel');
  return /^(Page(Up|Down)|Home|End)$/.test(k) && !!t.closest('.panel');
}

function keyboardFocused(t) {
  try { return t.matches(':focus-visible'); } catch (e) { return false; }
}

class KeyboardShortcuts {
  // deps: { $, isDestroyed(), actions: { name(arg, event) -> false if not handled }, wake() }
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    // Also listened to in the floating window's document (see PopoutController).
    this.onKey = (e) => this.handle(e);
    this.d.listen(document, 'keydown', this.onKey, true);
    const box = deps.$('.keyhelp');
    this.d.listen(deps.$('.khclose'), 'click', (e) => { e.stopPropagation(); this.showHelp(false); });
    this.d.listen(box, 'click', (e) => { if (e.target === box) this.showHelp(false); });
  }

  handle(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || this.x.isDestroyed()) return;
    const target = e.composedPath()[0];
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) && target.type !== 'range') return;
    // A control reached by keyboard keeps its own keys: Space presses the focused button,
    // arrows move the divider or scroll the focused list. After a mouse click (no keyboard
    // focus) the shortcuts win, so Space still plays rather than pressing the last button.
    if (target && ownsKey(target, e.key)) return;
    // An open menu or popover handles its own keys (arrows, Enter, [ and ] on the speed
    // track); only Esc goes on to close it.
    if (target && target.closest && target.closest('.pop') && e.key !== 'Escape') return;
    let entry = KEY_ACTIONS[e.key] || KEY_ACTIONS[e.key.length === 1 ? e.key.toLowerCase() : ''];
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.shiftKey) entry = ['stepChapter', e.key === 'ArrowLeft' ? -1 : 1];
    // On the volume slider every arrow changes the volume (left and right do not seek).
    if (target && target.type === 'range' && /^Arrow(Left|Right)$/.test(e.key) && !e.shiftKey) entry = ['volumeBy', e.key === 'ArrowLeft' ? -VOLUME_STEP : VOLUME_STEP];
    if (e.key === '?') entry = ['help'];
    if (!entry) return;
    const [name, arg] = entry;
    // A held key's repeats of a one-per-press action: kept from the page too, done nothing.
    if (e.repeat && !KEY_REPEATS.has(name)) { e.preventDefault(); e.stopPropagation(); return; }
    const fn = name === 'help' ? () => this.showHelp(this.x.$('.keyhelp').hidden) : this.x.actions[name];
    if (!fn || fn(arg, e) === false) return;
    telemetry.use(KEY_FEATURES[name], 'key');
    e.preventDefault();
    e.stopPropagation();
    this.x.wake();
  }

  get helpOpen() { return !this.x.$('.keyhelp').hidden; }

  showHelp(on) {
    const box = this.x.$('.keyhelp');
    if (on) {
      const list = box.querySelector('.khlist');
      list.textContent = '';
      for (const [keys, label] of KEY_HELP) {
        list.append(el('div', null, ...keys.map((k) => el('kbd', { text: k === 'Space' ? tr('kbdSpace') : k }))), el('div', { text: tr(label) }));
      }
    }
    // Focus goes back to where it was (the ⋮ button when opened from its menu).
    if (on && box.hidden) {
      const active = box.getRootNode().activeElement;
      this.returnTo = active && active.offsetParent ? active : null;
    }
    box.hidden = !on;
    if (on) box.querySelector('.khclose').focus();
    else (this.returnTo || this.x.$('.morebtn')).focus({ preventScroll: true });
  }
}

// ---- 43-empty-screen.js ----
// ===================================================================================
// The camera alone while the screen view shows nothing: the slide analysis' empty-screen
// stretches (a black screen, "no signal") are planned ahead, and only long ones switch
// (EMPTY_SCREEN_MIN_SEC), so the layout does not flip back and forth. Until the analysis
// has found them nothing switches. A layout chosen by hand in a recording turns this off
// for that recording (remembered); each switch says so, with Undo. On by default; the
// switch is on the layout page of the settings menu.
//
// deps: { lesson, prefs (prefs.emptyCamera), savePrefs(), uniform() (empty-screen
//         stretches, [] until known), duration(), sources, primaryPos(), screenIndex()
//         (null until known), layout() (the chosen one), canSwitch() (two views, no PDF
//         in the picture area), showOnly(pos | null), toast(msg, action, fn, valid())
//         (valid: whether a message that had to wait is still true) }
// ===================================================================================

// The stretches to show the camera in: empty-screen stretches of at least minSec. One
// that ends before the recording does ends a sampling step early: the screen came back
// somewhere in that step, and a moment of black is better than missing the start.
function emptyScreenPlan(uniform, duration, minSec, step) {
  const out = [];
  for (const u of uniform || []) {
    if (u.end - u.start < minSec) continue;
    const end = u.end >= duration - 0.5 ? duration : u.end - step;
    if (end > u.start) out.push({ start: u.start, end });
  }
  return out;
}

const EMPTY_LAYOUT_KEY = 'layoutChosen';   // recordings whose layout was chosen by hand
const EMPTY_LAYOUT_KEEP = 300;             // newest kept (a small list in the settings store)

class EmptyScreenLayout {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.on = false;          // showing the camera alone now
    this.known = null;        // the uniform list the plan was made from
    this.plan = [];
    this.cameraPos = -1;
    this.undos = 0;           // automatic switches undone by the user (usage data)
    this.chosen = (store.get(EMPTY_LAYOUT_KEY, []) || []).includes(deps.lesson.id);
    disposer.add(() => { if (this.on) this.x.showOnly(null); });
  }

  // The camera's position, or -1: the view that is not the analysed screen and can play
  // alone (it has sound).
  camera() {
    const x = this.x;
    const screen = x.screenIndex();
    if (screen == null) return -1;
    const screenPos = x.sources.findIndex((s) => s.index === screen);
    if (screenPos < 0) return -1;
    return x.sources.findIndex((s, i) => i !== screenPos && s.av);
  }

  // Whether the chosen layout shows the screen at all (not the camera alone already).
  screenShown(cameraPos) {
    return this.x.layout() !== 'single' || this.x.primaryPos() !== cameraPos;
  }

  // Called as playback moves (timeupdate, seeked) and when the stretches become known.
  tick(t) {
    const x = this.x;
    // Turned off, or the PDF took the picture area: back to the chosen layout.
    if (this.on && (!x.prefs.emptyCamera || !x.canSwitch())) { this.leave(false); return; }
    if (this.chosen) return;
    const u = x.uniform();
    if (u !== this.known) {
      this.known = u;
      this.plan = emptyScreenPlan(u, x.duration(), EMPTY_SCREEN_MIN_SEC, CHAPTER_STEP_SEC);
    }
    if (!x.prefs.emptyCamera || !x.canSwitch()) return;
    let inside = false;
    for (const s of this.plan) if (t >= s.start && t < s.end) { inside = true; break; }
    if (inside && !this.on) {
      const cam = this.camera();
      if (cam < 0 || !this.screenShown(cam)) return;
      this.enter(cam, true);
    } else if (!inside && this.on) {
      this.leave(true);
    }
  }

  enter(cam, say) {
    this.on = true;
    this.cameraPos = cam;
    this.x.showOnly(cam);
    if (say) this.x.toast(tr('emptyScreenCamera'), tr('undo'), () => { this.undos++; this.leave(false); this.choose(); }, () => this.on);
  }

  leave(say) {
    this.on = false;
    this.x.showOnly(null);
    // Undo keeps the camera alone, as if chosen by hand.
    if (say) this.x.toast(tr('emptyScreenBack'), tr('undo'), () => { this.undos++; this.choose(); this.enter(this.cameraPos, false); }, () => !this.on);
  }

  // The user arranged the views: the chosen arrangement takes over and this recording is
  // not switched again. Returns whether the camera was shown alone (it is not any more).
  manual() {
    const was = this.on;
    if (was) this.leave(false);
    this.choose();
    return was;
  }

  choose() {
    if (this.chosen) return;
    this.chosen = true;
    const id = this.x.lesson.id;
    const list = (store.get(EMPTY_LAYOUT_KEY, []) || []).filter((v) => v !== id);
    list.push(id);
    store.set(EMPTY_LAYOUT_KEY, list.slice(-EMPTY_LAYOUT_KEEP));
  }

  setEnabled(on) {
    this.x.prefs.emptyCamera = !!on;
    this.x.savePrefs();
  }
}

// ---- 43-layout.js ----
// ===================================================================================
// Arranging the two pictures by hand: the divider between them (side by side) and the
// small picture-in-picture window (drag to move, snapping to the nearest corner; the grip
// resizes; a click swaps the pictures). Which layout is used, and loading the streams for
// it, is the player's (applyLayout); this only moves and sizes.
//
// deps: { $, stage, prefs (ratio, pipw, corner), savePrefs(), ui { dragging }, armIdle(),
//         redrawPdf(), onPipClick() }
// ===================================================================================

class LayoutControls {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.bindDivider();
    this.bindPip();
  }

  setRatio(r) {
    const x = this.x;
    x.prefs.ratio = clamp(r, 0.2, 0.8);
    x.stage.style.setProperty('--ratio', x.prefs.ratio.toFixed(4));
  }

  bindDivider() {
    const x = this.x;
    const divider = x.$('.divider');
    let stageRect = null;
    const finish = () => {
      divider.classList.remove('dragging');
      x.ui.dragging = false;
      x.armIdle();
    };
    onDrag(this.d, divider, {
      start: (e) => {
        if (e.button !== 0) return null;
        e.stopPropagation();
        stageRect = x.stage.getBoundingClientRect();
        // Not laid out (no width): nothing to measure the drag against.
        if (!(stageRect.width > 0)) return null;
        divider.setPointerCapture(e.pointerId);
        divider.classList.add('dragging');
        x.ui.dragging = true;
        return { from: x.prefs.ratio };
      },
      move: (e) => this.setRatio((e.clientX - stageRect.left) / stageRect.width),
      done: () => { finish(); x.savePrefs(); x.redrawPdf(); },
      cancel: (st) => { this.setRatio(st.from); finish(); },
    });
    this.d.listen(divider, 'dblclick', () => { this.setRatio(0.5); x.savePrefs(); });
    this.d.listen(divider, 'keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        this.setRatio(x.prefs.ratio + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
        x.savePrefs();
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  // While dragging, both the frame and the picture in it are moved.
  bindPip() {
    const x = this.x;
    const st = x.stage;
    const frame = x.$('.pipframe');
    const grip = x.$('.grip');
    const pipEls = () => [frame, x.stage.querySelector('.views [data-slot=secondary]')].filter(Boolean);
    const setWidth = (w) => {
      x.prefs.pipw = w;
      st.style.setProperty('--pipw', w.toFixed(4));
    };
    const finish = () => {
      x.ui.dragging = false;
      frame.classList.remove('dragging');
      for (const elem of pipEls()) elem.style.transform = '';
    };
    onDrag(this.d, frame, {
      start: (e) => {
        if (e.button !== 0) return null;
        e.stopPropagation();
        frame.setPointerCapture(e.pointerId);
        x.ui.dragging = true;
        return { x: e.clientX, y: e.clientY, moved: false, resize: e.target === grip, rect: frame.getBoundingClientRect(), stage: st.getBoundingClientRect(), pipw: x.prefs.pipw };
      },
      move: (e, drag) => {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        frame.classList.add('dragging');
        if (drag.resize) {
          const c = x.prefs.corner;
          const r = drag.rect;
          const w = c === 'br' || c === 'tr' ? r.right - e.clientX : e.clientX - r.left;
          setWidth(clamp(w / drag.stage.width, 0.15, 0.6));
        } else {
          for (const elem of pipEls()) elem.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        }
      },
      done: (e, was) => {
        finish();
        // A tap swaps the two pictures (with the PDF shown: the PDF and the video).
        if (!was.moved) { x.onPipClick(); return; }
        if (was.resize) x.redrawPdf();
        else {
          const cx = was.rect.left + was.rect.width / 2 + (e.clientX - was.x);
          const cy = was.rect.top + was.rect.height / 2 + (e.clientY - was.y);
          const right = cx > was.stage.left + was.stage.width / 2;
          const bottom = cy > was.stage.top + was.stage.height / 2;
          x.prefs.corner = (bottom ? 'b' : 't') + (right ? 'r' : 'l');
          for (const c of CORNERS) st.classList.toggle('c-' + c, c === x.prefs.corner);
        }
        x.savePrefs();
        x.armIdle();
      },
      // Cancelled (a touch the browser took over): nothing happened, not a tap.
      cancel: (was) => {
        if (was.resize) setWidth(was.pipw);
        finish();
        x.armIdle();
      },
    });
  }
}

// ---- 44-quality.js ----
// ===================================================================================
// Picture quality: per role (screen, camera) "auto" or a fixed rendition height, its page
// in the settings menu, and a cap for the camera while it is the small picture-in-picture
// window (no point fetching 1080p for a thumbnail).
//
// deps: { prefs, savePrefs(), sources, dual, screenIndex() (null until known),
//         streams() -> [{ stream, elem, pos }] (pos -1: not playing), shown() -> the stream
//         of the big picture, layout(), onChange() (the settings menu redraws) }
// ===================================================================================

class QualityController {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.levelsByRole = {};
  }

  // 'screen' or 'camera'. Until the screen view is known, the first view counts as screen.
  roleOf(pos) {
    const src = this.x.sources[pos];
    if (!src) return 'screen';
    const screen = this.x.screenIndex();
    if (screen != null) return src.index === screen ? 'screen' : 'camera';
    return pos === 0 ? 'screen' : 'camera';
  }

  qualityFor(pos) {
    return this.x.prefs.quality[this.roleOf(pos)] || 'auto';
  }

  // Applies the settings to both streams. The camera may use a smaller rendition only
  // while it is the small picture-in-picture window; the screen is never capped.
  apply() {
    for (const { stream, elem, pos } of this.x.streams()) {
      if (pos < 0 || !stream.uri) continue;
      let cap = 0;
      if (this.x.layout() === 'pip' && elem.dataset.slot === 'secondary' && this.roleOf(pos) === 'camera') {
        cap = Math.ceil(elem.clientHeight * (window.devicePixelRatio || 1));
      }
      stream.setCap(cap);
      stream.setQuality(this.qualityFor(pos));
    }
    this.levelChanged();
  }

  levelChanged() {
    for (const { stream, pos } of this.x.streams()) {
      if (pos >= 0 && stream.levels.length) this.levelsByRole[this.roleOf(pos)] = stream.levels.map((l) => l.height);
    }
    this.x.onChange();
  }

  // Shown next to the page in the settings menu: what the big picture plays now.
  value() {
    const shown = this.x.shown();
    const entry = this.x.streams().find((s) => s.stream === shown && s.pos >= 0);
    const h = shown.height;
    const want = this.x.prefs.quality[this.roleOf(entry ? entry.pos : 0)];
    return want === 'auto' ? tr('qualityAuto') + (h ? ' (' + h + 'p)' : '') : want + 'p';
  }

  // The settings page: for each view, "auto" and the renditions it has.
  items() {
    const x = this.x;
    const roles = x.dual ? ['screen', 'camera'] : [this.roleOf(0)];
    const playingAt = new Map(x.streams().filter((s) => s.pos >= 0).map((s) => [s.pos, s.stream]));
    const items = [];
    for (const role of roles) {
      const pos = x.sources.findIndex((s, i) => this.roleOf(i) === role);
      if (pos < 0) continue;
      const stream = playingAt.get(pos);
      const playing = stream && stream.height ? tr('qualityNow', { q: stream.height + 'p' }) : '';
      if (x.dual) items.push({ kind: 'group', label: tr(role === 'screen' ? 'qualityScreen' : 'qualityCamera') + (playing ? tr('sepLabel') + playing : '') });
      else if (playing) items.push({ kind: 'group', label: playing });
      const heights = (this.levelsByRole[role] || []).slice().sort((a, b) => b - a);
      const opts = [['auto', tr('qualityAutoBest')]].concat(heights.map((hh) => [hh, hh + 'p']));
      for (const [val, label] of opts) {
        items.push({ kind: 'radio', label, checked: () => x.prefs.quality[role] === val, select: () => { telemetry.use('quality', 'click'); this.set(role, val); } });
      }
    }
    return items;
  }

  set(role, val) {
    this.x.prefs.quality[role] = val === 'auto' ? 'auto' : +val;
    this.x.savePrefs();
    this.apply();
  }
}

// ---- 45-menus.js ----
// ===================================================================================
// The control bar's buttons and the settings menu (⋮ in the title bar), built from the
// shared components (32-ui-kit.js).
//
// Control bar: captions (on/off; unavailable with a reason when there are none), copy
// picture, copy text, and the priority overflow: when the bar is too narrow, the steps of
// BAR_OVERFLOW are taken in order until it fits: buttons make way and appear at the top of
// the ⋮ menu instead, the time moves above the progress bar. Play, the jumps, speed, layout
// and fullscreen always stay (a phone of 320 px fits them; a phone has no jump buttons,
// see the stylesheet). The bookmark and layout buttons
// are the player's; the speed button is SpeedControl's (48-speed.js), the volume button
// VolumeControl's (49-volume.js).
//
// Settings menu: pages for quality, captions, audio, skipping silence, layout, copy text
// and theme, then actions (floating window, loop, export, shortcuts, storage and
// diagnostics, the original player). Parts give their own pages (deps.pages).
//
// deps: { $, root, pops (Popovers), stage, video, prefs, savePrefs(), cc (CaptionsView),
//         cues() ([] until loaded), focusView() (see LitePlayer), title, duration(), toast(msg),
//         layouts() (offered: [] none), layout(), setLayout(l), swap(), pdfMode(),
//         canEmptyCamera(), setEmptyCamera(on) (the camera alone while the screen is empty),
//         pages: { quality(), audio(), silence() } (items, see SettingsMenu),
//         values: { quality(), audio(), silence() } (shown next to the pages),
//         actions: { bookmark(e) (adds or removes the bookmark here), bookmarkHere(), popout() or null, loopA(), loopB(), loopClear(),
//         loopLabel(), exportNotes() or null, showKeys(), original() }, setTheme(t), setLang(l) }
// ===================================================================================

// What makes way when the control bar is too narrow, the first to go first; it comes back
// in the opposite order when there is room. A name is a control's data-bar (it moves into
// the ⋮ menu); 'time' moves the time above the progress bar. Mute and captions go last:
// a phone has volume keys, and captions also have their own page in the menu.
const BAR_OVERFLOW = ['copyText', 'copyPicture', 'bookmark', 'time', 'mute', 'captions'];

// A language choice as shown in the menu: "Match browser", or the language in itself.
function langLabel(l) {
  return l === 'auto' ? tr('langAuto') : LANG_NAMES[l];
}

class MenuBar {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    const $ = deps.$;
    this.out = [];
    this.settings = new SettingsMenu(deps.pops, 'settings', tr('moreMenu'), () => this.rootItems(), disposer);
    this.bind();
    // The bar is measured again whenever its width changes.
    const row = $('.row');
    if (typeof ResizeObserver === 'function') disposer.observe(new ResizeObserver(() => this.fitBar())).observe(row);
    this.fitBar();
  }

  bind() {
    const x = this.x;
    const $ = x.$;
    const d = this.d;
    const more = $('.morebtn');
    d.listen(more, 'click', () => this.settings.toggle(more, 'below'));
    // A press on a control that is not available says why (touch screens have no tooltips).
    d.listen(x.root, 'click', (e) => {
      const b = e.target.closest && e.target.closest('[aria-disabled=true][data-reason]');
      if (b && b.dataset.reason) { e.stopImmediatePropagation(); x.toast(b.dataset.reason); }
    }, true);
    d.listen($('.ccbtn'), 'click', () => this.setCaptions(!x.cc.on));
    d.listen($('.framebtn'), 'click', () => this.copyFrame());
    d.listen($('.textbtn'), 'click', () => this.copyCaptions());
    d.listen($('.diagclose'), 'click', (e) => { e.stopPropagation(); this.showDiagnostics(false); });
    d.listen($('.diagbox'), 'click', (e) => { if (e.target === $('.diagbox')) this.showDiagnostics(false); });
    d.listen($('.tdbox'), 'click', (e) => { if (e.target === $('.tdbox')) this.showMyData(false); });
    d.listen($('.diagcopy'), 'click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText($('.diagtext').textContent)
        .then(() => x.toast(tr('diagCopied')), (err) => x.toast(tr('copyFailed', { msg: (err && err.message) || err })));
    });
  }

  anyOpen() { return this.x.pops.isOpen(); }

  closeAll() { this.x.pops.close(true); }

  // Redraws the settings menu if it is open (a part's state changed).
  refresh() { this.settings.refresh(); }

  // ---- the control bar ----

  // Takes the BAR_OVERFLOW steps in order until the bar fits.
  fitBar() {
    const $ = this.x.$;
    const row = $('.row');
    const bottom = $('.bottom');
    const btn = (k) => this.x.root.querySelector('.row [data-bar=' + k + ']');
    const take = (k, on) => (k === 'time' ? bottom : btn(k)).classList.toggle(k === 'time' ? 'compact' : 'out', on);
    for (const k of BAR_OVERFLOW) take(k, false);
    row.classList.add('measure');
    const over = () => row.scrollWidth > row.clientWidth + 1;
    let n = 0;
    while (n < BAR_OVERFLOW.length && over()) take(BAR_OVERFLOW[n++], true);
    row.classList.remove('measure');
    this.out = BAR_OVERFLOW.slice(0, n).filter((k) => k !== 'time' && !btn(k).hidden);
    this.refresh();
  }

  // The bar's buttons moved into the menu, as menu actions.
  overflowItems() {
    const x = this.x;
    const btn = (k) => x.root.querySelector('.row [data-bar=' + k + ']');
    const item = {
      bookmark: { kind: 'action', label: tr(x.actions.bookmarkHere() ? 'removeBookmark' : 'bookmark'), key: 'B', run: (e) => x.actions.bookmark(e) },
      copyPicture: { kind: 'action', label: tr('copyFrame'), key: 'P', run: () => this.copyFrame() },
      copyText: { kind: 'action', label: tr('copyCaptions'), key: 'A', run: () => this.copyCaptions(), reason: () => unavailableReason(btn('copyText')) },
      mute: { kind: 'toggle', label: tr('mute'), on: () => x.video.muted || x.video.volume === 0, set: () => x.$('.mute').click() },
      captions: { kind: 'toggle', label: tr('showCaptions'), on: () => x.cc.on, set: (on) => this.setCaptions(on), reason: () => unavailableReason(btn('captions')) },
    };
    // In the bar's order (mute, captions, bookmark, copy picture, copy text).
    const list = ['mute', 'captions', 'bookmark', 'copyPicture', 'copyText'].filter((k) => this.out.includes(k)).map((k) => item[k]);
    return list.length ? list.concat({ kind: 'sep' }) : [];
  }

  // ---- the settings menu ----

  rootItems() {
    const x = this.x;
    const a = x.actions;
    const layouts = x.layouts();
    return [
      ...this.overflowItems(),
      { kind: 'page', label: tr('quality'), value: x.values.quality, items: x.pages.quality },
      { kind: 'page', label: tr('captionsPage'), value: () => (x.cc.on ? tr('on') : tr('off')), items: () => this.captionItems() },
      { kind: 'page', label: tr('audio'), value: x.values.audio, items: x.pages.audio, hidden: () => !x.pages.audio },
      { kind: 'page', label: tr('silencePage'), value: x.values.silence, items: x.pages.silence, hidden: () => !x.pages.silence },
      { kind: 'page', label: tr('layout'), value: () => tr(layoutKey(x.layout())), items: () => this.layoutItems(), hidden: () => !layouts.length },
      { kind: 'page', label: tr('copyCaptionsSpan'), value: () => spanLabel(x.prefs.copySpan), items: () => this.copyItems() },
      { kind: 'page', label: tr('theme'), value: () => tr(themeKey(x.prefs.theme)), items: () => this.themeItems() },
      { kind: 'page', label: tr('language'), value: () => langLabel(x.prefs.lang), items: () => this.langItems() },
      { kind: 'sep' },
      { kind: 'action', label: tr('popout'), key: 'W', run: () => { telemetry.use('popout', 'click'); a.popout(); }, hidden: () => !a.popout },
      { kind: 'page', label: tr('loopMenu'), value: a.loopLabel, items: () => this.loopItems() },
      { kind: 'action', label: tr('exportNotes'), key: 'E', run: () => { telemetry.use('exportNotes', 'click'); a.exportNotes(); }, hidden: () => !a.exportNotes },
      { kind: 'action', label: tr('keysMenu'), key: '?', run: () => { telemetry.use('help', 'click'); a.showKeys(); } },
      { kind: 'page', label: tr('storageMenu'), items: () => this.storageItems() },
      { kind: 'page', label: tr('telemetryMenu'), value: () => tr(x.prefs.telemetry ? 'on' : 'off'), items: () => this.telemetryItems() },
      { kind: 'action', label: tr('useOriginal'), run: () => { telemetry.use('original', 'click'); a.original(); } },
      { kind: 'foot', text: tr('appVersion', { version: VERSION }) },
    ];
  }

  captionItems() {
    const x = this.x;
    const none = () => unavailableReason(x.$('.ccbtn'));
    return [
      { kind: 'toggle', label: tr('showCaptions'), on: () => x.cc.on, set: (on) => this.setCaptions(on), reason: none },
      { kind: 'toggle', label: tr('hideCaptionsPaused'), on: () => !!x.prefs.capHidePaused, set: (on) => this.setHidePaused(on) },
      { kind: 'group', label: tr('captionSize') },
      ...Object.keys(CAPTION_SIZES).map((s) => ({
        kind: 'radio', label: tr('size' + s.toUpperCase()), checked: () => x.prefs.capSize === s, select: () => this.setCaptionSize(s),
      })),
    ];
  }

  layoutItems() {
    const x = this.x;
    return [
      ...x.layouts().map((l) => ({ kind: 'radio', label: tr(layoutKey(l)), checked: () => x.layout() === l, select: () => x.setLayout(l) })),
      { kind: 'text', text: () => tr('layoutPdfNote'), hidden: () => !x.pdfMode() },
      { kind: 'sep' },
      { kind: 'action', label: tr('swapViews'), key: 'S', run: () => x.swap() },
      {
        kind: 'toggle', label: tr('emptyScreenAuto'), desc: tr('emptyScreenAutoDesc'),
        on: () => !!x.prefs.emptyCamera, set: (on) => x.setEmptyCamera(on), hidden: () => !x.canEmptyCamera(),
      },
    ];
  }

  copyItems() {
    const x = this.x;
    return [
      { kind: 'text', text: () => tr('copyCaptionsSpanDesc') },
      ...COPY_SPANS.map((s) => ({
        kind: 'radio', label: spanLabel(s), checked: () => x.prefs.copySpan === s,
        select: () => { x.prefs.copySpan = s; x.savePrefs(); },
      })),
    ];
  }

  themeItems() {
    const x = this.x;
    return [
      ...THEMES.map((t) => ({ kind: 'radio', label: tr(themeKey(t)), checked: () => x.prefs.theme === t, select: () => { telemetry.use('theme', 'click'); x.setTheme(t); } })),
      { kind: 'text', text: () => tr('themeNote') },
    ];
  }

  langItems() {
    const x = this.x;
    return [
      ...UI_LANGS.map((l) => ({ kind: 'radio', label: langLabel(l), checked: () => x.prefs.lang === l, select: () => { telemetry.use('language', 'click'); x.setLang(l); } })),
      { kind: 'text', text: () => tr('langNote') },
    ];
  }

  loopItems() {
    const a = this.x.actions;
    return [
      { kind: 'action', label: tr('loopFromHere'), key: 'I', run: () => { telemetry.use('loop', 'click'); a.loopA(); } },
      { kind: 'action', label: tr('loopToHere'), key: 'O', run: () => { telemetry.use('loop', 'click'); a.loopB(); } },
      { kind: 'action', label: tr('loopClear'), key: 'X', run: () => a.loopClear(), reason: () => (a.loopLabel() === tr('loopNone') ? tr('loopNone') : '') },
    ];
  }

  // Analysis results stored on this device (size, clear) and the diagnostics.
  storageItems() {
    const size = el('span.grow', { text: tr('cachesMeasuring') });
    const clear = el('button.pbtn', { text: tr('cachesClear') });
    clear.addEventListener('click', guard(async (e) => {
      e.stopPropagation();
      clear.disabled = true;
      const n = await analysisCaches.clear();
      size.textContent = tr('cachesCleared', { n });
    }));
    analysisCaches.usage().then((u) => {
      size.textContent = tr('cachesSize', { mb: (u.bytes / 1e6).toFixed(u.bytes < 1e7 ? 1 : 0), n: u.count });
    }).catch(() => { size.textContent = tr('cachesUnknown'); });
    const row = el('div.mrow', null, size, clear);
    return [
      { kind: 'custom', render: () => row },
      { kind: 'text', text: () => tr('cachesInfo') },
      { kind: 'sep' },
      { kind: 'action', label: tr('diagMenu'), run: () => { telemetry.use('diagnostics', 'click'); this.showDiagnostics(true); } },
    ];
  }

  // ---- usage data (87-telemetry.js) ----

  telemetryItems() {
    const x = this.x;
    return [
      {
        kind: 'toggle', label: tr('telemetrySend'), desc: tr('telemetryDesc'), on: () => !!x.prefs.telemetry,
        set: (on) => { x.prefs.telemetry = !!on; x.savePrefs(); telemetry.setEnabled(on); },
      },
      { kind: 'sep' },
      { kind: 'action', label: tr('telemetryView'), run: () => this.showMyData('view') },
      { kind: 'action', label: tr('telemetryDelete'), run: () => this.showMyData('delete') },
      { kind: 'action', label: tr('telemetryReset'), run: () => this.showMyData('reset') },
    ];
  }

  get myDataOpen() { return !this.x.$('.tdbox').hidden; }

  // The dialog for the data sent so far: 'view' (tables, download), 'delete' (asks first),
  // 'reset' (a new ID, optionally deleting first), false (close).
  showMyData(mode) {
    const x = this.x;
    const box = x.$('.tdbox');
    if (mode === false) { box.hidden = true; this.myDataJob = null; x.$('.morebtn').focus({ preventScroll: true }); return; }
    const job = {};
    this.myDataJob = job;
    const body = x.$('.tdbody');
    const acts = x.$('.tdactions');
    const set = (title, nodes, buttons) => {
      if (this.myDataJob !== job) return;
      x.$('.tdtitle').textContent = title;
      body.replaceChildren(...nodes);
      acts.replaceChildren(...buttons);
      // The first button: never the one that deletes.
      if (buttons[0]) buttons[0].focus();
    };
    const btn = (label, fn, cls) => el('button.pbtn' + (cls || ''), { text: label, onclick: (e) => { e.stopPropagation(); fn(); } });
    const close = btn(tr('close'), () => this.showMyData(false));
    const failed = (r) => tr('telemetryFailed', { msg: r.status ? 'HTTP ' + r.status : tr('telemetryNoAnswer') });
    const del = (then) => {
      set(tr('telemetryDeleteTitle'), [el('p', { text: tr('telemetryLoading') })], []);
      telemetry.ask('/v1/me/delete').then((r) => {
        if (r.status !== 200 || !r.data || !r.data.deleted) { set(tr('telemetryDeleteTitle'), [el('p', { text: failed(r) })], [close]); return; }
        const n = Object.values(r.data.deleted).reduce((a, b) => a + (+b || 0), 0);
        if (then) then(n); else set(tr('telemetryDeleteTitle'), [el('p', { text: tr('telemetryDeleted', { n }) })], [close]);
      }).catch((e) => {
        log.warn('usage data delete:', e);
        set(tr('telemetryDeleteTitle'), [el('p', { text: tr('telemetryFailed', { msg: String((e && e.message) || e) }) })], [close]);
      });
    };
    const reset = (n) => {
      telemetry.resetIdentity();
      this.showMyData(false);
      x.toast(n == null ? tr('telemetryResetDone') : tr('telemetryDeleted', { n }) + ' ' + tr('telemetryResetDone'));
    };
    box.hidden = false;
    if (mode === 'delete') {
      set(tr('telemetryDeleteTitle'), [el('p', { text: tr('telemetryDeleteText') })], [close, btn(tr('telemetryDeleteConfirm'), () => del(null), '.danger')]);
      return;
    }
    if (mode === 'reset') {
      set(tr('telemetryResetTitle'), [el('p', { text: tr('telemetryResetText') })],
        [btn(tr('cancel'), () => this.showMyData(false)), btn(tr('telemetryResetOnly'), () => reset(null)), btn(tr('telemetryResetDelete'), () => del(reset), '.danger')]);
      return;
    }
    set(tr('telemetryDataTitle'), [el('p', { text: tr('telemetryLoading') })], [close]);
    telemetry.ask('/v1/me').then((r) => {
      if (r.status !== 200 || !r.data) { set(tr('telemetryDataTitle'), [el('p', { text: failed(r) })], [close]); return; }
      const kinds = { env: 'telemetryKindEnv', session: 'telemetryKindSession', error: 'telemetryKindError', fallback: 'telemetryKindFallback', registration: 'telemetryKindRegistration' };
      const nodes = [];
      for (const [k, label] of Object.entries(kinds)) {
        const rows = Array.isArray(r.data[k]) ? r.data[k] : [];
        if (!rows.length) continue;
        const cols = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        const cell = (c, v) => {
          if (v == null) return '';
          const t = c === 'at' ? new Date(v) : null;
          return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 19).replace('T', ' ') : String(v);
        };
        nodes.push(el('h3', { text: tr(label) + ' · ' + (rows.length === 1 ? tr('telemetryRow') : tr('telemetryRows', { n: rows.length })) }));
        if (cols.length <= TELEMETRY_WIDE_COLS) {
          nodes.push(el('div.tdscroll', null, el('table', null,
            el('thead', null, el('tr', null, ...cols.map((c) => el('th', { text: c })))),
            el('tbody', null, ...rows.map((row) => el('tr', null, ...cols.map((c) => el('td', { text: cell(c, row[c]) }))))))));
          continue;
        }
        // Too many columns to read across: one record at a time, a field per line (the
        // empty ones left out), newest first and open.
        rows.forEach((row, i) => {
          const filled = cols.filter((c) => row[c] != null && row[c] !== '');
          const d = el('details.tdrec', null,
            el('summary', { text: [cell('at', row.at), row.version].filter(Boolean).join(' · ') }),
            el('div.tdscroll', null, el('table', null, el('tbody', null, ...filled.map((c) => el('tr', null, el('th', { text: c }), el('td', { text: cell(c, row[c]) })))))));
          if (i === 0) d.open = true;
          nodes.push(d);
        });
      }
      if (!nodes.length) nodes.push(el('p', { text: tr('telemetryNone') }));
      const json = JSON.stringify(r.data, null, 2);
      set(tr('telemetryDataTitle'), nodes, [btn(tr('telemetryDownload'), () => platform.save(new Blob([json], { type: 'application/json' }), 'lite-player-usage-data.json')), close]);
    }).catch((e) => {
      log.warn('usage data view:', e);
      set(tr('telemetryDataTitle'), [el('p', { text: tr('telemetryFailed', { msg: String((e && e.message) || e) }) })], [close]);
    });
  }

  // ---- captions ----

  // Captions can be turned on once they are loaded; until then (or when there are none)
  // the button says why not.
  captionsAvailable(reason) {
    setUnavailable(this.x.$('.ccbtn'), reason, tr('captionsKey'));
    setUnavailable(this.x.$('.textbtn'), reason ? tr('copyNoCaptions') : '', tr('copyCaptionsKey'));
    this.refresh();
  }

  setCaptions(on, restoring) {
    const x = this.x;
    x.cc.setOn(on);
    x.cc.update(x.video.currentTime);
    if (!restoring) { x.prefs.captions = on; x.savePrefs(); }
    setPressed(x.$('.ccbtn'), on);
    this.refresh();
  }

  setHidePaused(on) {
    this.x.prefs.capHidePaused = !!on;
    this.x.savePrefs();
    this.x.stage.classList.toggle('hidecc-paused', !!on);
  }

  setCaptionSize(size) {
    if (!(size in CAPTION_SIZES)) return;
    this.x.prefs.capSize = size;
    this.x.cc.setSize(size);
    this.x.savePrefs();
  }

  // ---- copying (picture, what was said) ----

  // Copies the current picture at the video's own resolution. Must run from a user action.
  // Copies the picture the user is looking at: the larger one shown, a video frame or the
  // PDF page (drawn PDF_COPY_WIDTH wide).
  copyFrame() {
    const x = this.x;
    const f = x.focusView();
    if (f.page) {
      const pg = f.page;
      const shot = pg.render(PDF_COPY_WIDTH).then((c) => new Promise((resolve) => c.toBlob(resolve, 'image/png')));
      navigator.clipboard.write([new ClipboardItem({ 'image/png': shot })])
        .then(() => x.toast(tr('copiedPage', { n: pg.num, file: pg.file })))
        .catch((e) => x.toast(tr('copyFailed', { msg: (e && e.message) || e })));
      return;
    }
    const v = f.video;
    if (!v.videoWidth) { x.toast(tr('copyFailed', { msg: tr('noPictureYet') })); return; }
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    // The clipboard item is created synchronously (within the user action) from a promise.
    const blob = new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      .then(() => x.toast(tr('copiedFrame', { w: c.width, h: c.height })))
      .catch((e) => x.toast(tr('copyFailed', { msg: (e && e.message) || e })));
  }

  // Copies what was said in the last copySpan seconds, in whole sentences, with the
  // lecture's name and the time range.
  copyCaptions() {
    const x = this.x;
    const cues = x.cues();
    if (!cues.length) { x.toast(tr('copyNoCaptions')); return; }
    const ex = captionExcerpt(cues, x.video.currentTime, x.prefs.copySpan || 60);
    if (!ex) { x.toast(tr('copyNoCaptions')); return; }
    const long = x.duration() >= 3600;
    const from = fmtTime(ex.start, long);
    const to = fmtTime(ex.end, long);
    const text = x.title + '\n' + from + '–' + to + '\n\n' + ex.text + '\n';
    navigator.clipboard.writeText(text)
      .then(() => x.toast(tr('copiedCaptions', { from, to })))
      .catch((e) => x.toast(tr('copyFailed', { msg: (e && e.message) || e })));
  }

  // ---- diagnostics ----

  get diagnosticsOpen() { return !this.x.$('.diagbox').hidden; }

  showDiagnostics(on) {
    const x = this.x;
    if (on === false) { x.$('.diagbox').hidden = true; x.$('.morebtn').focus({ preventScroll: true }); return; }
    x.$('.diagtext').textContent = x.diagnostics();
    x.$('.diagbox').hidden = false;
    x.$('.diagcopy').focus();
  }
}

function layoutKey(l) {
  return { side: 'layoutSide', pip: 'layoutPip', single: 'layoutSingle' }[l];
}

function themeKey(t) {
  return { system: 'themeSystem', dark: 'themeDark', light: 'themeLight' }[t];
}

function spanLabel(s) {
  return tr('copySpanValue', { time: s < 60 ? tr('seconds', { n: s }) : s === 60 ? tr('minute') : tr('minutes', { n: s / 60 }) });
}

// ---- 46-popout.js ----
// ===================================================================================
// The floating window (Document Picture-in-Picture): the whole player (both views,
// controls, captions, side panel) moves into a small always-on-top window and back.
// Nothing is rebuilt: the same elements, streams and audio graph move.
//
// deps: { host, video, title, $, onKey (keyboard handler, for the window's document),
//         isDestroyed(), relayout() (sizes changed: quality caps, PDF), toast(msg) }
// ===================================================================================

class PopoutController {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.window = null;
    this.opening = false;
    // On teardown: close the window; its pagehide (sync or later) only removes the
    // placeholder, since the player is destroyed by then.
    this.d.add(() => { if (this.window) { try { this.window.close(); } catch (e) { /* closed */ } } });
  }

  // Browsers open it only from a page of its own, not from a frame in another page.
  static supported() { return typeof window.documentPictureInPicture === 'object' && !!window.documentPictureInPicture && !inFrame(); }

  async toggle() {
    if (this.window) { this.window.close(); return; }
    // A second press while the window is being opened does nothing (no second window).
    if (this.opening) return;
    this.opening = true;
    try { await this.open(); } finally { this.opening = false; }
  }

  async open() {
    const x = this.x;
    const host = x.host;
    if (fullscreenElement()) await exitFullscreen();
    const r = host.getBoundingClientRect();
    let pip;
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: Math.round(Math.min(960, r.width * 0.6)), height: Math.round(Math.min(600, r.height * 0.6)) });
    } catch (e) {
      x.toast(tr('popoutFailed', { msg: (e && e.message) || e }));
      return;
    }
    if (x.isDestroyed()) { pip.close(); return; }
    const playing = !x.video.paused;
    const holder = el('div.lp360-holder', { style: 'display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:' + Math.round(r.height) + 'px;background:#111;color:#ccc;font:14px system-ui,sans-serif' },
      el('span', { text: tr('popoutHere') }),
      el('button', { text: tr('popoutBack'), style: 'padding:6px 12px;border-radius:8px;border:0;cursor:pointer', onclick: () => pip.close() }));
    const doc = pip.document;
    const css = host.style.cssText;
    const keys = (e) => x.onKey(e);
    const resize = () => { if (!x.isDestroyed()) x.relayout(); };
    // The window's own visibility now decides drawing (the page behind may be hidden).
    const visible = () => { if (!x.isDestroyed() && !doc.hidden) x.relayout(); };
    // Putting the player back. Registered before anything moves, so a failure half-way
    // (or the window closing at any point) always brings the player back to the page.
    let back = false;
    const putBack = () => {
      if (back) return;
      back = true;
      doc.removeEventListener('keydown', keys, true);
      doc.removeEventListener('visibilitychange', visible);
      pip.removeEventListener('resize', resize);
      this.window = null;
      // The player was destroyed meanwhile (handed over to the original player): only the
      // placeholder goes; the old player must not come back over the original one.
      if (x.isDestroyed()) { holder.remove(); return; }
      const still = !x.video.paused;
      host.classList.remove('in-popout');
      host.style.cssText = css;
      if (holder.isConnected) holder.replaceWith(host);
      if (still && x.video.paused) x.video.play().catch(() => {});
      x.relayout();
    };
    pip.addEventListener('pagehide', putBack, { once: true });
    this.window = pip;
    try {
      host.replaceWith(holder);
      doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
      doc.title = x.title;
      host.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
      doc.body.append(host);
      host.classList.add('in-popout');
      doc.addEventListener('keydown', keys, true);
      doc.addEventListener('visibilitychange', visible);
      pip.addEventListener('resize', resize);
      // Moving can pause the elements in some browsers: carry on as before.
      if (playing && x.video.paused) x.video.play().catch(() => {});
      x.relayout();
    } catch (e) {
      putBack();
      try { pip.close(); } catch (err) { /* already closed */ }
      throw e;
    }
  }
}

// ---- 47-silence-ui.js ----
// ===================================================================================
// Silences and empty parts during playback: the analysis (62-silence.js), the stretches
// that can be skipped (with the slide analysis' empty screens), the Skip button and
// automatic skipping, "the lecture has ended" at an empty ending, and the "Skip silence"
// page of the settings menu.
//
// deps: { $, lesson, video, sources, prefs (prefs.silence), savePrefs(), seek(t),
//         duration(), toast(msg, action, fn), ui { dragging }, uniform() (empty screen
//         stretches from the slide analysis), onSkips(skips, contentEnd), onChange()
//         (the settings menu redraws) }
// ===================================================================================

class SilenceUi {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    /** @type {SkipStretch[]} skippable stretches, sorted */
    this.skips = [];
    this.contentEnd = null;   // where the lecture's content ends (an empty ending follows), or null
    this.idx = -1;            // stretch the playhead is in
    this.autoSkipped = new Set();
    const av = deps.sources.find((s) => s.av);
    const p = deps.prefs.silence;
    this.analyzer = new SilenceAnalyzer({
      lesson: deps.lesson,
      video: deps.video,
      masterUrl: av ? av.av : null,
      disposer: disposer.child(),
      onChange: () => { if (!this.d.disposed) { this.update(); this.x.onChange(); } },
    });
    this.analyzer.options = { minSec: p.min, sensitivity: p.sens };
    this.d.add(() => { clearTimeout(this.skipTimer); clearTimeout(this.endTimer); });
    this.bind();
  }

  bind() {
    const x = this.x;
    const d = this.d;
    d.listen(x.$('.endskip'), 'click', (e) => { e.stopPropagation(); this.hideEnd(); x.seek(x.duration()); });
    d.listen(x.$('.endstop'), 'click', (e) => { e.stopPropagation(); this.hideEnd(); x.video.pause(); });
    d.listen(x.$('.endclose'), 'click', (e) => { e.stopPropagation(); this.hideEnd(); });
    d.listen(x.$('.skipsil'), 'click', (e) => {
      e.stopPropagation();
      const s = this.skips[this.idx];
      this.hideSkip();
      if (s) { usageNote('skip', s.kind, s.end - x.video.currentTime); x.seek(s.end); }
    });
  }

  // The transcript is known ([] when there is none): silences from it, else from the audio.
  start(cues) { this.analyzer.start(cues); }

  skipAt(t) { return this.skips[silenceIndexAt(this.skips, t)] || null; }

  // Stretches that can be skipped (silences, empty screen) and where the content ends.
  update() {
    const x = this.x;
    const a = this.analyzer;
    const audioKnown = a.source === 'transcript' || a.source === 'audio';
    this.skips = skipStretches(a.silences, x.uniform(), audioKnown, x.prefs.silence.min);
    const dur = x.duration();
    this.contentEnd = dur ? contentEndAt(this.skips, dur) : null;
    // New results (the analysis refines them as it goes) must not pop the button up again.
    this.idx = silenceIndexAt(this.skips, x.video.currentTime);
    x.onSkips(this.skips, this.contentEnd);
  }

  // What the analysis found, as a sentence.
  status() {
    const a = this.analyzer;
    const p = this.x.prefs.silence;
    const total = a.silences.reduce((n, s) => n + s.end - s.start, 0);
    const found = a.silences.length
      ? tr(a.source === 'transcript' ? 'silenceFromTranscript' : 'silenceFound', { n: a.silences.length, time: fmtTime(total) })
      : tr('silenceNone', { min: p.min < 60 ? p.min + ' s' : p.min / 60 + ' min' });
    let status;
    if (a.source === 'pending') status = tr('silenceWaiting');
    else if (a.source === 'unavailable') status = tr(a.reason === 'saveData' ? 'silenceSaveData' : 'silenceUnavailable');
    else if (a.source === 'audio' && a.progress < 1) status = tr('silenceAnalysing', { pct: Math.floor(a.progress * 100) }) + (a.silences.length ? ' ' + found : '');
    else status = found;
    return status;
  }

  value() { return this.x.prefs.silence.auto ? tr('on') : tr('off'); }

  // The settings page.
  items() {
    const x = this.x;
    const p = x.prefs.silence;
    const set = (k, v, opt) => { p[k] = v; x.savePrefs(); if (opt) this.analyzer.setOptions(opt); };
    return [
      { kind: 'text', text: () => this.status() },
      { kind: 'toggle', label: tr('silenceAuto'), desc: tr('silenceAutoDesc'), on: () => p.auto, set: (on) => set('auto', !!on) },
      { kind: 'group', label: tr('silenceMin') },
      ...SILENCE_MIN_CHOICES.map((s) => ({
        kind: 'radio', label: s < 60 ? tr('seconds', { n: s }) : s === 60 ? tr('minute') : tr('minutes', { n: s / 60 }),
        checked: () => p.min === s, select: () => set('min', s, { minSec: s }),
      })),
      // Sensitivity only matters when the audio itself is measured.
      { kind: 'group', label: tr('silenceSensitivity'), hidden: () => this.analyzer.source !== 'audio' },
      ...Object.keys(SILENCE_SENSITIVITY).map((k) => ({
        kind: 'radio', label: tr(k), checked: () => p.sens === k, select: () => set('sens', k, { sensitivity: k }),
        hidden: () => this.analyzer.source !== 'audio',
      })),
    ];
  }

  // On every time update: entering a silence offers to skip it (or skips it, if the user
  // turned that on). Only playback running into a silence skips automatically; seeking
  // into one just shows the button.
  tick(ct) {
    const x = this.x;
    const list = this.skips;
    if (!list.length && this.idx === -1) return;
    const i = silenceIndexAt(list, ct);
    if (i === this.idx) return;
    this.idx = i;
    const s = list[i];
    if (!s) { this.hideSkip(); this.hideEnd(); return; }
    const ranInto = !x.video.seeking && !x.ui.dragging && ct - s.start < 2;
    // The empty stretch at the end: the lecture is over.
    if (s.start === this.contentEnd) { this.hideSkip(); if (ranInto || ct - s.start < 15) this.showEnd(); return; }
    if (s.end - ct < 5) { this.hideSkip(); return; }
    // An empty screen with unknown audio is never skipped automatically.
    if (x.prefs.silence.auto && s.kind !== 'black' && ranInto && !this.autoSkipped.has(s.start)) {
      this.autoSkipped.add(s.start);
      const from = ct;
      this.hideSkip();
      usageNote('skip', s.kind, s.end - from);
      x.seek(s.end);
      x.toast(tr(s.kind === 'blank' ? 'skippedBlank' : 'skippedSilence', { time: fmtTime(s.end - from) }), tr('undo'), () => x.seek(from));
      return;
    }
    this.showSkip(s, ct);
  }

  showSkip(s, ct) {
    const btn = this.x.$('.skipsil');
    btn.textContent = tr(s.kind === 'silence' ? 'skipSilence' : 'skipBlank', { time: fmtTime(s.end - ct) });
    btn.classList.remove('fade');
    btn.tabIndex = 0;
    clearTimeout(this.skipTimer);
    this.skipTimer = setTimeout(guard(() => this.hideSkip()), 6000);
  }

  hideSkip() {
    const btn = this.x.$('.skipsil');
    btn.classList.add('fade');
    btn.tabIndex = -1;
    clearTimeout(this.skipTimer);
  }

  // "The lecture has ended": jump to the end (finishing it) or stop here.
  showEnd() {
    this.x.$('.endnote').hidden = false;
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(guard(() => this.hideEnd()), 20000);
  }

  hideEnd() {
    this.x.$('.endnote').hidden = true;
    clearTimeout(this.endTimer);
  }
}

// ---- 48-speed.js ----
// ===================================================================================
// The speed control: the control bar's speed button ("1.5×") opens a popover with the
// current value shown large and one track from SPEED_MIN to SPEED_MAX. The thumb moves
// in 0.05 steps and snaps to the stops (SPEED_STOPS) near it; the labelled stops can be
// tapped. Keys on the track: arrows 0.05, [ and ] (and Page Up / Down) the next stop,
// Home / End the ends. [ and ] also work anywhere in the player (42-keys.js).
//
// deps: { $, pops (Popovers), rate() (current), setRate(r) }
// ===================================================================================

const SPEED_STEP = 0.05;

function fmtRate(r) {
  return String(+r.toFixed(2)) + '×';
}

// The next stop from `current` in direction dir (-1, 1); current if there is none.
function nextSpeed(current, dir) {
  const eps = 0.001;
  if (dir > 0) return SPEED_STOPS.find((s) => s > current + eps) || current;
  for (let i = SPEED_STOPS.length - 1; i >= 0; i--) if (SPEED_STOPS[i] < current - eps) return SPEED_STOPS[i];
  return current;
}

function snapSpeed(v) {
  const stop = SPEED_STOPS.find((s) => Math.abs(s - v) <= SPEED_SNAP);
  if (stop != null) return stop;
  return clamp(Math.round(v / SPEED_STEP) * SPEED_STEP, SPEED_MIN, SPEED_MAX);
}

class SpeedControl {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.button = deps.$('.speed');
    this.pop = deps.pops.create('spdpop', 'dialog', tr('speed'));
    this.build();
    disposer.listen(this.button, 'click', () => deps.pops.toggle(this.pop, this.button, 'above'));
    this.render(deps.rate());
  }

  frac(r) { return (r - SPEED_MIN) / (SPEED_MAX - SPEED_MIN); }

  build() {
    const x = this.x;
    this.value = el('b.spd-val', { 'aria-hidden': 'true' });
    this.thumb = el('div.spd-thumb');
    this.stops = SPEED_STOPS.map((s) => el('i.spd-stop', { style: 'left:' + (this.frac(s) * 100).toFixed(2) + '%' }));
    this.track = el('div.spd-track', {
      role: 'slider', tabindex: '0', 'data-autofocus': true, 'aria-label': tr('speed'),
      'aria-valuemin': String(SPEED_MIN), 'aria-valuemax': String(SPEED_MAX),
    }, el('div.spd-rail'), el('div.spd-fill'), ...this.stops, this.thumb);
    this.labels = SPEED_LABELS.map((s) => el('button', {
      'data-rate': String(s), text: fmtRate(s), style: 'left:' + (this.frac(s) * 100).toFixed(2) + '%',
    }));
    this.pop.el.append(el('div.spd', null,
      el('div.spd-head', null, el('span', { text: tr('speed') }), this.value),
      this.track, el('div.spd-labels', null, ...this.labels)));
    const d = this.d;
    const track = this.track;
    const at = (e) => {
      const r = track.getBoundingClientRect();
      if (!(r.width > 0)) return x.rate();   // not laid out: no speed can be read from it
      return snapSpeed(SPEED_MIN + clamp((e.clientX - r.left) / r.width, 0, 1) * (SPEED_MAX - SPEED_MIN));
    };
    onDrag(d, track, {
      start: (e) => {
        if (e.button !== 0) return null;
        track.setPointerCapture(e.pointerId);
        track.classList.add('dragging');
        const from = x.rate();
        x.setRate(at(e));
        return { from };
      },
      move: (e) => x.setRate(at(e)),
      done: () => track.classList.remove('dragging'),
      cancel: (st) => { track.classList.remove('dragging'); x.setRate(st.from); },
    });
    d.listen(track, 'keydown', (e) => {
      const r = x.rate();
      const to = {
        ArrowLeft: r - SPEED_STEP, ArrowDown: r - SPEED_STEP, ArrowRight: r + SPEED_STEP, ArrowUp: r + SPEED_STEP,
        '[': nextSpeed(r, -1), PageDown: nextSpeed(r, -1), ']': nextSpeed(r, 1), PageUp: nextSpeed(r, 1),
        Home: SPEED_MIN, End: SPEED_MAX,
      }[e.key];
      if (to == null) return;
      e.preventDefault();
      x.setRate(clamp(Math.round(to * 100) / 100, SPEED_MIN, SPEED_MAX));
    });
    d.listen(this.pop.el, 'click', (e) => {
      const b = e.target.closest('button[data-rate]');
      if (b) x.setRate(+b.dataset.rate);
    });
  }

  render(rate) {
    const text = fmtRate(rate);
    this.button.textContent = text;
    this.button.setAttribute('aria-label', tr('speedNow', { rate: text }));
    this.value.textContent = text;
    this.track.style.setProperty('--f', clamp(this.frac(rate), 0, 1).toFixed(4));
    this.track.setAttribute('aria-valuenow', String(rate));
    this.track.setAttribute('aria-valuetext', text);
    SPEED_STOPS.forEach((s, i) => this.stops[i].classList.toggle('on', Math.abs(s - rate) < 0.001));
    for (const b of this.labels) b.classList.toggle('on', Math.abs(+b.dataset.rate - rate) < 0.001);
  }
}

// ---- 49-volume.js ----
// ===================================================================================
// The volume control: a speaker button that mutes and unmutes (its icon follows the
// level: muted, low, high), and a slider that the stylesheet shows only while a mouse is
// over the control or the keyboard focus is on it (touch screens never show it; devices
// there have volume keys). The mouse wheel over the control changes the volume; changes
// by the wheel or the arrow keys show the level on the picture for a moment.
//
// deps: { $, video }
// ===================================================================================

class VolumeControl {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.button = deps.$('.mute');
    this.input = deps.$('.volume');
    this.osd = deps.$('.volosd');
    this.wheelSum = 0;
    this.osdTimer = 0;
    disposer.add(() => clearTimeout(this.osdTimer));
    const v = deps.video;
    disposer.listen(this.button, 'click', () => this.toggleMute());
    disposer.listen(this.input, 'input', () => { v.volume = +this.input.value; v.muted = v.volume === 0; });
    disposer.listen(deps.$('.vol'), 'wheel', (e) => this.onWheel(e), { passive: false });
    this.render();
  }

  // A muted (or zero) volume comes back at the last level, or half when there is none.
  toggleMute() {
    const v = this.x.video;
    if (v.muted || v.volume === 0) {
      v.muted = false;
      if (v.volume === 0) v.volume = 0.5;
    } else v.muted = true;
  }

  // Changes the volume by dv; show: put the new level on the picture (keys and wheel).
  by(dv, show) {
    const v = this.x.video;
    if (dv > 0) v.muted = false;
    v.volume = clamp(Math.round((v.volume + dv) * 100) / 100, 0, 1);
    if (show) this.showLevel();
  }

  // One mouse-wheel notch is one step, whatever distance the browser reports for it (53 to
  // 120 px, or 3 lines); a touchpad's many small deltas add up to VOLUME_WHEEL_PX per step.
  // Up is louder.
  onWheel(e) {
    e.preventDefault();
    const raw = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    const px = clamp(raw, -VOLUME_WHEEL_PX, VOLUME_WHEEL_PX);
    if (Math.sign(px) !== Math.sign(this.wheelSum)) this.wheelSum = 0;
    this.wheelSum += px;
    const steps = Math.trunc(this.wheelSum / VOLUME_WHEEL_PX);
    if (!steps) return;
    this.wheelSum -= steps * VOLUME_WHEEL_PX;
    this.by(-steps * VOLUME_STEP, true);
  }

  level() {
    const v = this.x.video;
    return v.muted ? 0 : v.volume;
  }

  showLevel() {
    const level = this.level();
    this.osd.textContent = level ? tr('volumeLevel', { pct: Math.round(level * 100) }) : tr('muted');
    this.osd.classList.add('on');
    clearTimeout(this.osdTimer);
    this.osdTimer = setTimeout(guard(() => this.osd.classList.remove('on')), VOLUME_OSD_MS);
  }

  render() {
    const level = this.level();
    const silent = level === 0;
    const b = this.button;
    b.innerHTML = svg(silent ? 'muted' : level < 0.5 ? 'volumeLow' : 'volume');
    b.setAttribute('aria-label', tr(silent ? 'unmute' : 'mute'));
    b.dataset.tip = tr(silent ? 'unmuteKey' : 'muteKey');
    this.input.value = String(level);
    this.input.setAttribute('aria-valuetext', Math.round(level * 100) + '%');
    this.input.style.setProperty('--v', level * 100 + '%');
  }
}

// ---- 50-zoom.js ----
// ===================================================================================
// Zoom and pan inside a view (the screen video, the camera, or the PDF in the picture
// area): the wheel or a trackpad pinch zooms around the pointer, dragging pans, a double
// click returns to the whole picture. The element keeps its place in the layout; only a
// transform and a clip are set on it, so playback, Web Audio and the layouts are untouched.
// While zoomed in, a small overview in the view's corner shows which part is visible.
// ===================================================================================

const ZOOM_MAX = 8;

class Zoomer {
  // host: the element the views live in (.views); opts.onChange() after any change.
  constructor(host, disposer, opts) {
    this.host = host;
    this.d = disposer;
    this.onChange = (opts && opts.onChange) || (() => {});
    this.canZoom = (opts && opts.canZoom) || (() => true);
    this.state = new Map();     // element -> { s, cx, cy }
    this.drag = null;
    this.dragged = false;       // a pan just ended (the click that follows is not a play toggle)
    this.map = el('div.zmap', { hidden: true, 'aria-hidden': 'true' }, el('i'));
    this.mapFor = null;
    host.append(this.map);
    this.bind();
    // Sizes change with the layout, the divider and the window: keep the view in place.
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this.refresh());
      ro.observe(host);
      this.d.add(() => ro.disconnect());
    }
  }

  // The zoomable element at an event's target (a video or the PDF stage).
  targetOf(elem) {
    if (!elem || !elem.closest) return null;
    const stage = elem.tagName === 'VIDEO' ? null : elem.closest('.pstage');
    const t = elem.tagName === 'VIDEO' ? elem : stage && stage.querySelector('.rpages');
    return t && this.host.contains(t) && this.canZoom(t) ? t : null;
  }

  get(elem) { return this.state.get(elem) || { s: 1, cx: 0.5, cy: 0.5 }; }

  zoomed(elem) { return this.get(elem).s > 1.001; }

  // Zooms `el` by `factor` keeping the point at (fx, fy) (fractions of the element) still.
  zoomAt(elem, factor, fx, fy) {
    const z = this.get(elem);
    const s = clamp(z.s * factor, 1, ZOOM_MAX);
    // The content point under the pointer before, and where it must stay.
    const px = z.cx + (fx - 0.5) / z.s;
    const py = z.cy + (fy - 0.5) / z.s;
    this.set(elem, s, px - (fx - 0.5) / s, py - (fy - 0.5) / s);
  }

  set(elem, s, cx, cy) {
    const half = 0.5 / s;
    const z = { s, cx: clamp(cx, half, 1 - half), cy: clamp(cy, half, 1 - half) };
    if (s <= 1.001) this.state.delete(elem); else this.state.set(elem, z);
    this.apply(elem);
    this.onChange();
  }

  reset(elem) { if (this.state.has(elem)) this.set(elem, 1, 0.5, 0.5); }

  resetAll() { for (const elem of [...this.state.keys()]) this.reset(elem); }

  apply(elem) {
    const z = this.get(elem);
    if (z.s <= 1.001) {
      elem.style.transform = '';
      elem.style.clipPath = '';
      elem.style.transformOrigin = '';
      elem.classList.remove('zoomed');
    } else {
      const W = elem.offsetWidth;
      const H = elem.offsetHeight;
      const tx = W / 2 - z.s * z.cx * W;
      const ty = H / 2 - z.s * z.cy * H;
      elem.style.transformOrigin = '0 0';
      elem.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + z.s.toFixed(4) + ')';
      // The clip is in the element's own (unscaled) coordinates: the visible part only.
      const l = -tx / z.s;
      const tp = -ty / z.s;
      elem.style.clipPath = 'inset(' + tp.toFixed(1) + 'px ' + (W - l - W / z.s).toFixed(1) + 'px ' + (H - tp - H / z.s).toFixed(1) + 'px ' + l.toFixed(1) + 'px)';
      elem.classList.add('zoomed');
    }
    this.renderMap(elem);
  }

  // Re-applies after the element was resized (layout change, divider, window).
  refresh() { for (const elem of this.state.keys()) this.apply(elem); }

  renderMap(elem) {
    const m = this.map;
    if (!this.zoomed(elem)) {
      if (this.mapFor === elem) { m.hidden = true; this.mapFor = null; }
      return;
    }
    this.mapFor = elem;
    const z = this.get(elem);
    const W = elem.offsetWidth;
    const H = elem.offsetHeight;
    // Where the view is inside the host, without the zoom transform (a video is placed in
    // the host directly; the PDF pages inside an untransformed stage).
    let x = elem.offsetLeft;
    let y = elem.offsetTop;
    if (elem.tagName !== 'VIDEO') {
      const r = elem.parentElement.getBoundingClientRect();
      const hr = this.host.getBoundingClientRect();
      x = r.left - hr.left;
      y = r.top - hr.top;
    }
    const mw = Math.min(140, W * 0.25);
    const mh = (mw * H) / W;
    m.hidden = false;
    m.style.width = mw + 'px';
    m.style.height = mh + 'px';
    // Bottom right of the view, clear of the title bar, toolbars and the controls.
    m.style.left = (x + W - mw - 12) + 'px';
    m.style.top = Math.max(y + 64, y + H - mh - 96) + 'px';
    const r = m.firstChild;
    r.style.left = ((z.cx - 0.5 / z.s) * 100).toFixed(2) + '%';
    r.style.top = ((z.cy - 0.5 / z.s) * 100).toFixed(2) + '%';
    r.style.width = (100 / z.s).toFixed(2) + '%';
    r.style.height = (100 / z.s).toFixed(2) + '%';
  }

  bind() {
    const d = this.d;
    d.listen(this.host, 'wheel', (e) => {
      const elem = this.targetOf(e.target);
      if (!elem) return;
      e.preventDefault();
      const r = elem.getBoundingClientRect();
      // Pixel deltas from trackpads, line deltas from some mice.
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // The rect spans the whole scaled content: the pointer's position in the content,
      // then in the visible window.
      const z = this.get(elem);
      const wx = 0.5 + ((e.clientX - r.left) / r.width - z.cx) * z.s;
      const wy = 0.5 + ((e.clientY - r.top) / r.height - z.cy) * z.s;
      this.zoomAt(elem, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), clamp(wx, 0, 1), clamp(wy, 0, 1));
    }, { passive: false });
    d.listen(this.host, 'pointerdown', (e) => {
      const elem = this.targetOf(e.target);
      if (!elem || e.button !== 0 || !this.zoomed(elem) || this.drag) return;
      this.drag = { el: elem, x: e.clientX, y: e.clientY, z: this.get(elem), id: e.pointerId };
      this.dragged = false;
    });
    d.listen(this.host, 'pointermove', (e) => {
      const g = this.drag;
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!this.dragged && Math.hypot(dx, dy) < 4) return;
      if (!this.dragged) {
        this.dragged = true;
        g.el.classList.add('panning');
        // Captured once it is a drag (a plain click must still reach the picture), so the
        // drag works wherever the player is, also in a floating window.
        try { this.host.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      const W = g.el.offsetWidth;
      const H = g.el.offsetHeight;
      this.set(g.el, g.z.s, g.z.cx - dx / (W * g.z.s), g.z.cy - dy / (H * g.z.s));
    });
    // Only the pointer that started the pan ends it (a second finger does not). A cancelled
    // pan goes back to where it started.
    const end = (e, cancelled) => {
      const g = this.drag;
      if (!g || e.pointerId !== g.id) return;
      g.el.classList.remove('panning');
      this.drag = null;
      if (cancelled && this.dragged) this.set(g.el, g.z.s, g.z.cx, g.z.cy);
      // The click event comes right after; it reads `dragged` and then it is cleared.
      setTimeout(() => { this.dragged = false; }, 0);
    };
    d.listen(this.host, 'pointerup', (e) => end(e, false));
    d.listen(this.host, 'pointercancel', (e) => end(e, true));
    d.listen(this.host, 'lostpointercapture', (e) => end(e, true));
  }
}

// ---- 51-loop.js ----
// ===================================================================================
// A-B loop: play a stretch of the lecture again and again (a derivation, a sentence).
//
// Set the ends with I and O, from the settings menu ("Loop a section"), or by right-clicking
// the progress bar ("Start loop here" / "End loop here"); X or the band's ✕ ends it. The band on the progress bar shows the stretch and
// its ends can be dragged. Playback jumps back to A when it reaches B from inside the
// stretch; after a jump outside, a notice offers to end the loop (otherwise it loops again
// once playback is back inside).
// ===================================================================================

const LOOP_MIN_SEC = 1;

class ABLoop {
  // deps: { pops (Popovers), rail (the progress bar), video, duration(), seek(t),
  //         toast(msg, action, fn) }
  constructor(deps, disposer) {
    this.p = deps;
    this.a = null;
    this.b = null;
    this.last = -1;          // time at the previous check
    this.timer = 0;
    this.d = disposer;
    this.d.add(() => clearTimeout(this.timer));
    this.build();
  }

  get active() { return this.a != null && this.b != null; }

  build() {
    const seek = this.p.rail;
    this.band = el('div.loopband', { hidden: true },
      el('i.lh.la', { title: tr('loopStart') }), el('i.lh.lb', { title: tr('loopEnd') }),
      el('button.lx', { title: tr('loopClear') + ' (X)', 'aria-label': tr('loopClear'), text: '✕' }));
    seek.append(this.band);
    const d = this.d;
    let at = 0;
    this.menu = new SettingsMenu(this.p.pops, 'loopmenu', tr('loopMenu'), () => [
      { kind: 'action', label: tr('loopFromHere'), key: 'I', run: () => this.setA(at) },
      { kind: 'action', label: tr('loopToHere'), key: 'O', run: () => this.setB(at) },
      { kind: 'action', label: tr('loopClear'), key: 'X', run: () => this.clear(), hidden: () => this.a == null },
    ], d);
    d.listen(this.band.querySelector('.lx'), 'pointerdown', (e) => e.stopPropagation());
    d.listen(this.band.querySelector('.lx'), 'click', (e) => { e.stopPropagation(); this.clear(); });
    for (const hd of this.band.querySelectorAll('.lh')) this.bindHandle(hd);
    d.listen(seek, 'contextmenu', (e) => {
      e.preventDefault();
      const r = seek.getBoundingClientRect();
      at = clamp((e.clientX - r.left) / r.width, 0, 1) * this.p.duration();
      const x = e.clientX;
      const y = r.top;
      this.menu.open({ getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }) }, 'above');
    });
  }

  // For the settings menu: the loop now, or "No loop".
  label() {
    if (this.a == null) return tr('loopNone');
    return fmtTime(this.a) + '–' + (this.b == null ? '' : fmtTime(this.b));
  }

  // Dragging an end of the band.
  bindHandle(hd) {
    const seek = this.p.rail;
    const isA = hd.classList.contains('la');
    onDrag(this.d, hd, {
      start: (e) => {
        if (e.button !== 0) return null;
        e.stopPropagation();
        hd.setPointerCapture(e.pointerId);
        return { a: this.a, b: this.b };
      },
      move: (e) => {
        const r = seek.getBoundingClientRect();
        const tm = clamp((e.clientX - r.left) / r.width, 0, 1) * this.p.duration();
        if (isA) this.a = Math.max(0, Math.min(tm, (this.b ?? Infinity) - LOOP_MIN_SEC)); else this.b = Math.max(tm, this.a + LOOP_MIN_SEC);
        this.render();
      },
      done: (e) => { e.stopPropagation(); this.announce(); },
      // A cancelled drag leaves the loop as it was.
      cancel: (st) => { this.a = st.a; this.b = st.b; this.render(); },
    });
  }

  setA(tm) {
    this.a = clamp(tm, 0, this.p.duration());
    if (this.b != null && this.b - this.a < LOOP_MIN_SEC) this.b = null;
    this.render();
    if (this.active) this.announce(); else this.p.toast(tr('loopStartSet', { time: fmtTime(this.a) }));
  }

  setB(tm) {
    const b = clamp(tm, 0, this.p.duration());
    // Without a start, loop from a little before.
    if (this.a == null || b - this.a < LOOP_MIN_SEC) this.a = Math.max(0, b - 10);
    this.b = b;
    this.render();
    this.announce();
    const v = this.p.video;
    if (v.currentTime < this.a || v.currentTime >= this.b) this.p.seek(this.a);
  }

  clear() {
    if (this.a == null && this.b == null) return;
    this.a = null;
    this.b = null;
    clearTimeout(this.timer);
    this.render();
    this.p.toast(tr('loopCleared'));
  }

  announce() {
    this.p.toast(tr('loopSet', { from: fmtTime(this.a), to: fmtTime(this.b) }), tr('loopClear'), () => this.clear());
  }

  render() {
    const dur = this.p.duration();
    const band = this.band;
    if (this.a == null || !dur) { band.hidden = true; return; }
    const b = this.b == null ? this.a : this.b;
    band.hidden = false;
    band.classList.toggle('open', this.b == null);
    band.style.left = ((this.a / dur) * 100).toFixed(3) + '%';
    band.style.width = (((b - this.a) / dur) * 100).toFixed(3) + '%';
  }

  // Called on every time update: back to A when playback reaches B from inside.
  tick(tm) {
    const last = this.last;
    this.last = tm;
    if (!this.active) return;
    const v = this.p.video;
    if (v.seeking || v.paused) return;
    if (last >= this.a - 0.5 && last < this.b && tm >= this.b - 0.05) {
      this.p.seek(this.a);
      this.last = this.a;
      return;
    }
    // Time updates come about four times a second: aim the jump closer to B.
    const left = (this.b - tm) / (v.playbackRate || 1);
    clearTimeout(this.timer);
    if (tm >= this.a && left > 0 && left < 0.4) {
      this.timer = setTimeout(guard(() => { if (this.active && !v.paused && !v.seeking) this.tick(v.currentTime); }), left * 1000);
    }
  }

  // A seek by the user: outside the loop, offer to end it.
  seeked(target) {
    if (!this.active || (target >= this.a - 0.5 && target < this.b)) return;
    this.last = target;
    this.p.toast(tr('loopOutside', { from: fmtTime(this.a), to: fmtTime(this.b) }), tr('loopClear'), () => this.clear());
  }
}

// ---- 52-watched.js ----
// ===================================================================================
// What has been watched: the stretches of a recording played on this device, kept across
// visits, shown faintly on the progress bar and as a percentage on the course page
// (80-course-list.js).
//
// Echo360 keeps no per-user record of which parts were watched that a page can read: the
// course list only says whether a recording was opened (isRead), and the player only gets
// the last position (lastPlayedToSeconds). So coverage is local; the course page falls
// back to Echo360's last position where this device has no record.
//
//   watched:<lessonId>   { d: duration (s), r: [[start, end], ...] (s), at: last update }
// ===================================================================================

const WATCHED_MIN_SEC = 2;     // shorter stretches (a seek landing, a frame) do not count

class WatchedStore {
  constructor(lesson, video, played) {
    this.key = lesson.lessonId ? 'watched:' + lesson.lessonId : null;
    this.video = video;
    this.played = played;
    this.base = [];            // stored before this visit
    this.ready = false;
    this.contentEnd = null;    // where the lecture's content ends (an empty stretch follows), if known
  }

  async load() {
    if (!this.key) return;
    const rec = await idbCache.get(this.key);
    if (rec && Array.isArray(rec.r)) this.base = rec.r;
    this.ready = true;
  }

  // Everything watched so far: earlier visits and this one.
  ranges() {
    const all = new PlayedRanges();
    all.ranges = this.base.slice();
    for (const [a, b] of this.played.merged(this.video.played)) if (b - a >= WATCHED_MIN_SEC) all.add(a, b);
    return all.ranges;
  }

  // Merged with what is stored now, in one transaction: the same lecture open in another
  // tab may have saved its own stretches since this page loaded.
  save(duration) {
    if (!this.key || !this.ready || !(duration > 0) || storageLock.frozen) return;
    const mine = this.ranges();
    if (!mine.length) return;
    idbCache.update(this.key, (old) => {
      const all = new PlayedRanges();
      if (old && Array.isArray(old.r)) for (const [a, b] of old.r) if (b > a) all.add(a, b);
      for (const [a, b] of mine) all.add(a, b);
      const rec = { d: Math.round(duration), r: all.ranges.map(([a, b]) => [Math.floor(a), Math.ceil(b)]), at: Date.now() };
      if (this.contentEnd > 0) rec.e = Math.round(this.contentEnd); else if (old && old.e > 0) rec.e = old.e;
      return rec;
    }).then((rec) => { if (rec) this.base = rec.r; }).catch((e) => log.warn('watched record:', e));
  }
}

// Share of a recording watched (0..1) from a stored record. Only the lecture's content
// counts: an empty stretch at the end (rec.e, black screen and silence) is left out, so
// watching all of the content is 100%.
function watchedShare(rec) {
  if (!rec || !(rec.d > 0) || !Array.isArray(rec.r)) return 0;
  const end = rec.e > 0 && rec.e < rec.d ? rec.e : rec.d;
  let s = 0;
  for (const [a, b] of rec.r) s += Math.max(0, Math.min(b, end) - Math.max(a, 0));
  return Math.min(1, s / end);
}

// ---- 53-captions.js ----
// ===================================================================================
// Captions overlay and transcript panel. Both read one sorted cue list.
// ===================================================================================

// Finds the cue for a playback time. Sequential playback moves forward one cue at a time,
// so the previous answer is checked first; seeks fall back to a binary search.
class CueIndex {
  constructor(cues) {
    this.cues = cues;
    this.last = -1;
  }

  // Index of the last cue that started at or before t (-1 before the first cue).
  started(t) {
    const c = this.cues;
    const i = this.last;
    if (i >= 0 && i < c.length && c[i].start <= t && (i + 1 === c.length || c[i + 1].start > t)) return i;
    if (i + 1 < c.length && c[i + 1].start <= t && (i + 2 >= c.length || c[i + 2].start > t)) return (this.last = i + 1);
    let lo = 0;
    let hi = c.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    this.last = k;
    return k;
  }

  // Index of the cue being spoken at t, or -1 in a gap.
  active(t) {
    const k = this.started(t);
    return k >= 0 && t < this.cues[k].end ? k : -1;
  }
}

// What was said in the last `span` seconds before t, in whole sentences: { start, end,
// text } or null. A cue that continues a sentence from the cue before it pulls that one
// in (at most 30 s further back); the sentence being spoken at t is completed (at most
// 20 s ahead). Cues are sentence-ish but often break mid-sentence.
function captionExcerpt(cues, t, span) {
  const ends = (s) => /[.?!]["')\]]?\s*$/.test(s);
  let a = cues.findIndex((c) => c.end > t - span);
  if (a < 0) return null;
  let b = a;
  while (b + 1 < cues.length && cues[b + 1].start <= t) b++;
  if (cues[a].start > t) return null;
  const from = t - span;
  while (a > 0 && !ends(cues[a - 1].text) && cues[a - 1].start >= from - 30) a--;
  while (b + 1 < cues.length && !ends(cues[b].text) && cues[b + 1].start <= t + 20) b++;
  const text = cues.slice(a, b + 1).map((c) => c.text.trim()).join(' ').replace(/\s+/g, ' ');
  return { start: cues[a].start, end: cues[b].end, text };
}

const CAPTION_SIZES = { s: 0.8, m: 1, l: 1.3, xl: 1.65 };

class CaptionsView {
  constructor(elem, video) {
    this.el = elem;
    this.video = video;
    this.textEl = elem.firstElementChild;
    this.index = null;
    this.on = false;
    this.shown = -2;
    this.timer = 0;
  }

  setCues(cues) {
    this.index = new CueIndex(cues);
    this.shown = -2;
  }

  setOn(on) {
    this.on = on;
    this.el.hidden = !on;
    this.shown = -2;
    if (!on) this.clearTimer();
  }

  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
  }

  // timeupdate fires only about 4 times a second, so a caption could change up to 250 ms
  // late. While playing, one timer is set for the next cue boundary instead.
  scheduleNext(t) {
    this.clearTimer();
    const v = this.video;
    if (!v || v.paused || v.seeking || !this.index) return;
    const c = this.index.cues;
    const k = this.index.started(t);
    let next = k + 1 < c.length ? c[k + 1].start : Infinity;
    if (k >= 0 && c[k].end > t) next = Math.min(next, c[k].end);
    if (!isFinite(next)) return;
    const ms = ((next - t) / (v.playbackRate || 1)) * 1000;
    if (ms > 400) return; // the next timeupdate comes first
    this.timer = setTimeout(guard(() => { this.timer = 0; this.update(this.video.currentTime); }), Math.max(0, ms) + 5);
  }

  dispose() {
    this.clearTimer();
  }

  setSize(size) {
    this.el.style.setProperty('--capscale', String(CAPTION_SIZES[size] || 1));
  }

  // Called on timeupdate/seeked (about 4 times a second): writes the DOM only when the cue
  // changes.
  update(t) {
    if (!this.on || !this.index || hiddenFor(this.el)) return;
    const k = this.index.active(t);
    this.scheduleNext(t);
    if (k === this.shown) return;
    this.shown = k;
    if (k < 0) { this.el.classList.add('empty'); this.textEl.textContent = ''; return; }
    this.el.classList.remove('empty');
    this.textEl.textContent = this.index.cues[k].text;
  }
}

// What the transcript search looks for: the words as typed, ignoring case. Matched in the
// original text (not a lower-cased copy, whose length can differ, e.g. for a dotted
// capital I), so the marked positions are exactly the matched characters.
function searchPattern(q) {
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

// Puts `text` into `elem` with every match of `re` (a global pattern) in a <mark>.
// Returns whether anything matched; with no match, `elem` is left as it is.
function markMatches(elem, text, re) {
  re.lastIndex = 0;
  let m = re.exec(text);
  if (!m) return false;
  const frag = document.createDocumentFragment();
  let at = 0;
  for (; m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > at) frag.append(text.slice(at, m.index));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    frag.append(mark);
    at = m.index + m[0].length;
  }
  if (at < text.length) frag.append(text.slice(at));
  elem.textContent = '';
  elem.append(frag);
  return true;
}

// Transcript tab of the side panel. The list is built once, on first show; rows use
// `content-visibility: auto`, so off-screen rows cost no layout or paint.
class TranscriptPanel {
  constructor(player, elem, marksEl, disposer) {
    this.player = player;
    this.el = elem;
    this.visible = false;
    this.marksEl = marksEl;
    this.list = elem.querySelector('.tlist');
    this.search = elem.querySelector('.tsearch');
    this.countEl = elem.querySelector('.tcount');
    this.backBtn = elem.querySelector('.tback');
    // Empty until setCues: the tab can be shown before (a load that failed, with "Retry").
    this.cues = [];
    this.index = new CueIndex([]);
    this.rows = null;
    this.current = -1;
    this.follow = true;
    this.hits = [];
    this.hitPos = -1;
    this.searchTimer = 0;
    this.programmaticScrollUntil = 0;
    this.d = disposer || new Disposer();   // owned by whoever created this (parent.child())
    this.bind();
  }

  setCues(cues) {
    this.cues = cues;
    this.index = new CueIndex(cues);
    if (this.rows) { this.list.textContent = ''; this.rows = null; }
    // Shown already (a load that failed, then "Retry"): build the new list now.
    if (this.visible) this.show(true);
  }

  get open() { return this.visible; }

  build() {
    if (this.rows) return;
    const long = this.player.duration() >= 3600;
    const frag = document.createDocumentFragment();
    this.rows = this.cues.map((c, i) => {
      const row = document.createElement('div');
      row.className = 'trow';
      row.dataset.i = String(i);
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = fmtTime(c.start, long);
      const tx = document.createElement('span');
      tx.className = 'tx';
      tx.textContent = c.text;
      row.append(ts, tx);
      frag.appendChild(row);
      return row;
    });
    this.list.appendChild(frag);
    this.current = -1;
  }

  show(on) {
    this.visible = on;
    if (on) {
      this.build();
      this.follow = true;
      this.backBtn.hidden = true;
      this.update(this.player.video.currentTime, true);
    }
  }

  // Called on timeupdate/seeked while the panel is open: moves the highlight when the cue
  // changes and keeps it in view unless the user has scrolled away.
  update(t, force) {
    if (!this.open || !this.rows || hiddenFor(this.list)) return;
    const k = this.index.started(t);
    if (k === this.current && !force) return;
    if (this.current >= 0 && this.rows[this.current]) this.rows[this.current].classList.remove('cur');
    this.current = k;
    if (k < 0) return;
    this.rows[k].classList.add('cur');
    if (this.follow) this.scrollTo(k);
  }

  scrollTo(k) {
    const row = this.rows[k];
    if (!row) return;
    this.programmaticScrollUntil = performance.now() + 600;
    row.scrollIntoView({ block: 'center' });
  }

  stopFollowing() {
    if (!this.follow) return;
    this.follow = false;
    this.backBtn.hidden = false;
  }

  bind() {
    const d = this.d;
    d.listen(this.list, 'click', (e) => {
      const row = e.target.closest('.trow');
      if (!row) return;
      this.player.seek(this.cues[+row.dataset.i].start);
      this.follow = true;
      this.backBtn.hidden = true;
    });
    // Any user-initiated scrolling of the list pauses auto-follow.
    const userScroll = () => this.stopFollowing();
    d.listen(this.list, 'wheel', userScroll, { passive: true });
    d.listen(this.list, 'touchmove', userScroll, { passive: true });
    d.listen(this.list, 'keydown', (e) => { if (/^(Arrow|Page|Home|End| )/.test(e.key)) userScroll(); });
    d.listen(this.list, 'scroll', () => { if (performance.now() > this.programmaticScrollUntil && this.dragScroll) userScroll(); }, { passive: true });
    // A drag of the scroll bar ends where the pointer is lifted, in the window the list is
    // in at that time (the floating window, once moved there).
    this.dragUp = null;
    d.listen(this.list, 'pointerdown', (e) => {
      if (e.target !== this.list) return;
      if (this.dragUp) this.dragUp();
      this.dragScroll = true;
      const win = windowOf(this.list);
      const up = () => { this.dragScroll = false; win.removeEventListener('pointerup', up, true); this.dragUp = null; };
      win.addEventListener('pointerup', up, true);
      this.dragUp = up;
    });
    d.add(() => { if (this.dragUp) this.dragUp(); });
    d.listen(this.backBtn, 'click', () => {
      this.follow = true;
      this.backBtn.hidden = true;
      if (this.current >= 0) this.scrollTo(this.current);
    });
    d.listen(this.search, 'input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.runSearch(), 150);
    });
    d.listen(this.search, 'keydown', (e) => {
      if (e.key === 'Enter') { this.stepHit(e.shiftKey ? -1 : 1); e.preventDefault(); }
      if (e.key === 'Escape') { this.search.value = ''; this.runSearch(); e.preventDefault(); }
      e.stopPropagation();
    });
    d.listen(this.el.querySelector('.tprev'), 'click', () => this.stepHit(-1));
    d.listen(this.el.querySelector('.tnext'), 'click', () => this.stepHit(1));
    d.add(() => clearTimeout(this.searchTimer));
  }

  runSearch() {
    const q = this.search.value.trim();
    for (const i of this.hits) {
      const row = this.rows && this.rows[i];
      if (row) { row.classList.remove('hit'); row.querySelector('.tx').textContent = this.cues[i].text; }
    }
    this.hits = [];
    this.hitPos = -1;
    if (q && this.rows) {
      const re = searchPattern(q);
      for (let i = 0; i < this.cues.length; i++) {
        if (!markMatches(this.rows[i].querySelector('.tx'), this.cues[i].text, re)) continue;
        this.hits.push(i);
        this.rows[i].classList.add('hit');
      }
    }
    this.countEl.textContent = q ? tr('searchCount', { n: this.hits.length }) : '';
    this.renderMarks();
  }

  stepHit(dir) {
    if (!this.hits.length) return;
    this.hitPos = (this.hitPos + dir + this.hits.length) % this.hits.length;
    const k = this.hits[this.hitPos];
    this.countEl.textContent = tr('searchPos', { i: this.hitPos + 1, n: this.hits.length });
    this.stopFollowing();
    this.scrollTo(k);
  }

  // Search hits on the progress bar, merged into 0.25% buckets (at most 400 marks).
  renderMarks() {
    const elem = this.marksEl;
    elem.textContent = '';
    const dur = this.player.duration();
    if (!this.hits.length || !dur) return;
    const seen = new Set();
    const frag = document.createDocumentFragment();
    for (const i of this.hits) {
      const bucket = Math.floor((this.cues[i].start / dur) * 400);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      const m = document.createElement('i');
      m.style.left = (bucket / 4).toFixed(2) + '%';
      frag.appendChild(m);
    }
    elem.appendChild(frag);
  }

  dispose() {
    this.d.dispose();
  }
}

// ---- 54-sidebar.js ----
// ===================================================================================
// Side panel with tabs (transcript, slides, notes, discussion). Each tab is a controller with
// show(visible); only the active tab of an open panel is visible, so hidden tabs do no work.
// ===================================================================================

const SIDEBAR_TABS = ['transcript', 'slides', 'notes', 'discussion'];

class Sidebar {
  constructor(player, elem, disposer) {
    this.p = player;
    this.el = elem;
    this.controllers = {};
    this.active = null;
    this.isOpen = false;
    this.d = disposer || new Disposer();   // owned by whoever created this (parent.child())
    for (const b of elem.querySelectorAll('.tabs [data-tab]')) {
      this.d.listen(b, 'click', () => this.switchTo(b.dataset.tab));
    }
  }

  tabButton(tab) { return this.el.querySelector('.tabs [data-tab="' + tab + '"]'); }

  pane(tab) { return this.el.querySelector('.pane[data-pane="' + tab + '"]'); }

  register(tab, controller) {
    this.controllers[tab] = controller;
    this.tabButton(tab).hidden = false;
    for (const chip of this.p.root.querySelectorAll('.top [data-open="' + tab + '"]')) chip.hidden = false;
  }

  has(tab) { return !!this.controllers[tab]; }

  visible(tab) { return this.isOpen && this.active === tab; }

  open(tab) {
    const target = this.has(tab) ? tab : (this.has(this.active) ? this.active : SIDEBAR_TABS.find((x) => this.has(x)));
    if (!target) return;
    this.isOpen = true;
    this.el.hidden = false;
    this.switchTo(target);
    this.p.onSidebarChange();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    if (this.active && this.controllers[this.active]) this.controllers[this.active].show(false);
    this.p.onSidebarChange();
  }

  toggle(tab) {
    if (this.isOpen && (!tab || this.active === tab)) this.close();
    else this.open(tab);
  }

  switchTo(tab) {
    if (!this.has(tab)) return;
    const prev = this.active;
    if (prev && prev !== tab && this.controllers[prev]) this.controllers[prev].show(false);
    this.active = tab;
    for (const t2 of SIDEBAR_TABS) {
      const pane = this.pane(t2);
      if (pane) pane.hidden = t2 !== tab;
      const b = this.tabButton(t2);
      if (b) b.setAttribute('aria-selected', String(t2 === tab));
    }
    if (this.isOpen) this.controllers[tab].show(true);
    this.p.onSidebarChange();
  }

  // The panes are owned by whoever created them, not by the panel that shows them.
  dispose() {
    this.d.dispose();
  }
}

// ---- 55-notes.js ----
// ===================================================================================
// Notes tab: private notes, bookmarks and "didn't understand" flags, sorted by time.
// Data is loaded once at start (it also feeds the progress-bar markers); the list DOM is
// only rebuilt while the tab is visible. Notes and bookmarks can carry local tags
// (56-tags.js).
// ===================================================================================

const NOTE_FILTERS = ['all', 'note', 'bookmark', 'flag'];

class NotesPane {
  constructor(player, pane, api, canFlag, disposer) {
    this.p = player;
    this.pane = pane;
    this.api = api;
    this.canFlag = canFlag;
    this.items = [];
    this.filter = 'all';
    this.tagFilter = '';      // '' all, a tag id, or '-' untagged
    this.tags = player.tags;
    this.picking = null;      // item id whose tag picker is open
    this.managing = false;
    this.visible = false;
    this.dirty = true;
    this.d = disposer || new Disposer();   // owned by whoever created this (parent.child())
    this.build();
  }

  // Resolves true when notes are loaded, else to the error (see player.loadPart).
  async load() {
    const [notes, flags] = await Promise.allSettled([this.api.notes(), this.canFlag ? this.api.flags() : Promise.resolve([])]);
    if (notes.status !== 'fulfilled') {
      log.info('notes unavailable:', notes.reason && notes.reason.message);
      return notes.reason || false;
    }
    this.items = notes.value.concat(flags.status === 'fulfilled' ? flags.value : []);
    this.sort();
    this.changed();
    return true;
  }

  sort() {
    this.items.sort((a, b) => (a.time == null ? -1 : a.time) - (b.time == null ? -1 : b.time));
  }

  changed() {
    this.dirty = true;
    if (this.visible) this.render();
    this.p.updateMarkers();
    this.p.renderBookmarkButton();
  }

  build() {
    const timeLabel = el('span');
    this.composerTime = timeLabel;
    this.textarea = el('textarea.input', { rows: 3, maxLength: 5000, 'aria-label': tr('addNote') });
    this.addBtn = el('button.pbtn.primary', { text: tr('addNote'), onclick: (e) => this.addNote(e) });
    this.d.listen(this.textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.addNote(e); }
    });
    this.d.listen(this.textarea, 'focus', () => this.updatePlaceholder());
    this.select = el('select.input.small', { 'aria-label': tr('filterAll') });
    for (const f of NOTE_FILTERS) {
      const label = { all: tr('filterAll'), note: tr('filterNotes'), bookmark: tr('filterBookmarks'), flag: tr('filterFlags') }[f];
      if (f === 'flag' && !this.canFlag) continue;
      this.select.append(el('option', { value: f, text: label }));
    }
    this.d.listen(this.select, 'change', () => { this.filter = this.select.value; this.render(); });
    this.tagSelect = el('select.input.small', { 'aria-label': tr('filterTags') });
    this.d.listen(this.tagSelect, 'change', () => { this.tagFilter = this.tagSelect.value; this.render(); });
    this.manageBtn = el('button.link', { text: tr('manageTags'), onclick: () => { this.managing = !this.managing; this.exporting = false; this.render(); } });
    this.exportBtn = el('button.link', { text: tr('exportMenu'), onclick: () => { this.exporting = !this.exporting; this.managing = false; this.render(); } });
    this.manageBox = el('div');
    this.errorEl = el('div.perror', { hidden: true });
    this.list = el('div.plist');
    // "Didn't understand" is seen by the instructor: it lives here, says so, and asks first.
    this.flagRow = null;
    if (this.canFlag) {
      this.flagBtn = el('button.pbtn', { onclick: (e) => this.onFlagClick(e) });
      this.flagRow = el('div.flagrow', null, this.flagBtn, el('span.who', { text: tr('flagVisible') }));
      this.d.add(() => clearTimeout(this.flagArmed));
    }
    this.pane.append(
      el('div.pinfo', { text: tr('notesPrivate') }),
      this.flagRow,
      el('div.composer', null, this.textarea, el('div.crow', null, timeLabel, el('span.grow'), this.addBtn)),
      el('div.ptools', null, this.select, this.tagSelect, el('span.grow'), this.manageBtn, this.exportBtn),
      this.manageBox,
      this.errorEl,
      this.list,
    );
  }

  updatePlaceholder() {
    const at = fmtTime(this.p.video.currentTime, this.p.duration() >= 3600);
    const text = tr('addNotePlaceholder', { time: at });
    if (this.textarea.placeholder !== text) this.textarea.placeholder = text;
  }

  // The playing moment changed (play or seek): the empty composer says where a note goes.
  update() {
    if (this.visible) this.updatePlaceholder();
  }

  show(on) {
    this.visible = on;
    if (on) { this.updatePlaceholder(); if (this.dirty) this.render(); }
  }

  showError(msg) {
    this.errorEl.textContent = msg;
    this.errorEl.hidden = !msg;
  }

  fail(e) {
    log.warn('write failed', e);
    this.showError(tr('saveFailed', { error: errorText(e) }));
    this.p.toast(tr('saveFailed', { error: errorText(e) }));
  }

  renderTagFilter() {
    const sel = this.tagSelect;
    const keep = this.tagFilter;
    sel.textContent = '';
    sel.append(el('option', { value: '', text: tr('allTags') }));
    for (const tag of this.tags.tags) sel.append(el('option', { value: tag.id, text: tag.name }));
    sel.append(el('option', { value: '-', text: tr('untagged') }));
    this.tagFilter = keep && (keep === '-' || this.tags.byId(keep)) ? keep : '';
    sel.value = this.tagFilter;
  }

  tagMatch(item) {
    if (!this.tagFilter) return true;
    if (item.type === 'flag') return false;
    const ids = this.tags.of(item.id);
    return this.tagFilter === '-' ? !ids.length : ids.some((x) => x.id === this.tagFilter);
  }

  render() {
    this.dirty = false;
    const long = this.p.duration() >= 3600;
    this.renderTagFilter();
    this.manageBox.textContent = '';
    if (this.managing) this.manageBox.append(tagManager(this.tags, () => { this.managing = false; this.render(); }));
    if (this.exporting) this.manageBox.append(this.exportPanel());
    const shown = this.items.filter((x) => (this.filter === 'all' || x.type === this.filter) && this.tagMatch(x));
    const frag = document.createDocumentFragment();
    if (!shown.length) frag.append(el('div.pempty', { text: tr('noNotes') }));
    for (const item of shown) frag.append(this.renderItem(item, long));
    this.list.textContent = '';
    this.list.append(frag);
    // A note being edited stays open with what was typed (the list is redrawn on any
    // change: a tag, a bookmark, a reload).
    const ed = this.editing;
    if (ed) {
      const item = this.items.find((x) => x.id === ed.id);
      const card = item && [...this.list.querySelectorAll('.card[data-id]')].find((c) => c.dataset.id === String(item.id));
      if (card) this.startEdit(item, card, ed.text); else this.editing = null;
    }
  }

  renderItem(item, long) {
    const label = { note: tr('markerNote'), bookmark: tr('markerBookmark'), flag: tr('markerFlag') }[item.type];
    const time = item.time != null
      ? el('button.chiptime', { text: fmtTime(item.time, long), title: label, onclick: () => this.p.seek(item.time) })
      : null;
    const head = el('div.ihead', null, el('span.kind.k-' + item.type, { text: label }), time, el('span.grow'));
    const body = item.type === 'note' ? el('div.ibody', { text: item.text }) : null;
    let tags = null;
    if (item.type !== 'flag') {
      const open = () => { this.picking = this.picking === item.id ? null : item.id; this.render(); };
      tags = el('div.itags', null, ...this.tags.of(item.id).map((tag) => tagChip(tag, open)),
        el('button.link.addtag', { text: tr('addTagShort'), title: tr('tagsFor'), onclick: open }));
      if (this.picking === item.id) tags.append(tagPicker(this.tags, item.id, () => { this.picking = null; this.render(); }));
    }
    const actions = el('div.iactions');
    if (item.type === 'note') actions.append(el('button.link', { text: tr('edit'), onclick: () => this.startEdit(item, card) }));
    actions.append(this.deleteButton(item));
    const card = el('div.card.k-' + item.type, { 'data-id': item.id }, head, body, tags, actions);
    return card;
  }

  // Two clicks within 3 s delete; the second click is the user action sent with the write.
  deleteButton(item) {
    return confirmButton(item.type === 'flag' ? tr('remove') : tr('delete'), (e) => this.remove(e, item));
  }

  startEdit(item, card, draft) {
    const area = el('textarea.input', { rows: 3, maxLength: 5000 });
    area.value = draft == null ? item.text : draft;
    const focused = draft == null;
    this.editing = { id: item.id, text: area.value };
    area.addEventListener('input', () => { if (this.editing && this.editing.id === item.id) this.editing.text = area.value; });
    const save = el('button.pbtn.primary', { text: tr('save') });
    const cancel = el('button.pbtn', { text: tr('cancel'), onclick: () => { this.editing = null; this.render(); } });
    save.addEventListener('click', guard((e) => this.once(async () => {
      const text = area.value.trim();
      if (!text) return;
      save.disabled = true;
      try {
        await this.api.updateNote(e, item, text);
        item.text = text;
        // Edited further while it was saved: still being edited, with that text.
        if (area.value.trim() === text) this.editing = null;
        else save.disabled = false;
        this.showError('');
        this.changed();
      } catch (err) { save.disabled = false; this.fail(err); }
    })));
    card.querySelector('.ibody').replaceWith(el('div.composer', null, area, el('div.crow', null, el('span.grow'), cancel, save)));
    card.querySelector('.iactions').hidden = true;
    // Focus only when the user opened it (not on a redraw while they work elsewhere).
    if (focused) area.focus();
  }

  // One write at a time for the whole tab (see DiscussionPane.write): a second Ctrl+Enter
  // or click while a request is on its way does nothing.
  async once(fn) {
    if (this.busy) return undefined;
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  addNote(e) {
    return this.once(() => this.addNoteNow(e));
  }

  async addNoteNow(e) {
    const text = this.textarea.value.trim();
    if (!text) return;
    this.addBtn.disabled = true;
    try {
      const note = await this.api.addNote(e, { text, time: this.p.video.currentTime, num: this.count('note') + 1 });
      // Only what was sent goes: text typed while it was on its way stays.
      if (this.textarea.value.trim() === text) this.textarea.value = '';
      this.items.push(note);
      this.sort();
      this.showError('');
      this.changed();
    } catch (err) {
      this.fail(err);
    } finally {
      this.addBtn.disabled = false;
    }
  }

  count(type) { return this.items.filter((x) => x.type === type).length; }

  // Resolves to the new bookmark, or null if it could not be added (or another write was
  // still on its way). at: its time (default: now); tagIds: tags to put on it (undo).
  addBookmark(e, at, tagIds) {
    return this.once(async () => {
      const time = at == null ? this.p.video.currentTime : at;
      try {
        const note = await this.api.addNote(e, { bookmark: true, time, num: this.count('bookmark') + 1 });
        this.items.push(note);
        this.sort();
        for (const id of tagIds || []) if (this.tags.byId(id)) this.tags.toggle(note.id, id);
        this.changed();
        this.p.toast(tr('bookmarkedAt', { time: fmtTime(time) }), tr('undo'), (ev) => this.remove(ev, note));
        return note;
      } catch (err) { this.fail(err); return null; }
    }).then((x) => x || null);
  }

  // The bookmark "here": the nearest one within BOOKMARK_NEAR_SEC of time t, else null.
  bookmarkNear(t) {
    let best = null;
    for (const x of this.items) {
      if (x.type !== 'bookmark' || x.time == null || Math.abs(x.time - t) > BOOKMARK_NEAR_SEC) continue;
      if (!best || Math.abs(x.time - t) < Math.abs(best.time - t)) best = x;
    }
    return best;
  }

  // The bookmark button, B and the menu item: bookmarks this moment, or removes the
  // bookmark here (Undo puts it back, with its tags).
  toggleBookmark(e) {
    const near = this.bookmarkNear(this.p.video.currentTime);
    if (!near) return this.addBookmark(e);
    return this.once(async () => {
      const tagIds = this.tags.of(near.id).map((x) => x.id);
      if (!(await this.removeNow(e, near))) return null;
      this.p.toast(tr('bookmarkRemoved', { time: fmtTime(near.time) }), tr('undo'), (ev) => this.addBookmark(ev, near.time, tagIds));
      return null;
    }).then(() => null);
  }

  flagAt(time) {
    const scene = Math.floor(time / FLAG_SCENE_SECONDS) * FLAG_SCENE_SECONDS;
    return this.items.find((x) => x.type === 'flag' && x.time === scene) || null;
  }

  // The flag button for the part playing now: "Didn't understand", or remove the mark.
  renderFlagRow() {
    if (!this.flagBtn || this.flagArmed) return;
    const ex = this.flagAt(this.p.video.currentTime);
    const b = this.flagBtn;
    b.innerHTML = svg(ex ? 'flagOn' : 'flag');
    b.append(ex ? tr('flagRemoveLabel', { time: fmtTime(ex.time) }) : tr('flag'));
    b.classList.remove('armed');
  }

  // A first press asks (the button says what will happen); a second within FLAG_CONFIRM_MS
  // marks. Removing a mark needs no confirmation.
  onFlagClick(e) {
    const now = this.p.video.currentTime;
    if (this.flagAt(now)) { this.toggleFlag(e); return; }
    if (!this.flagArmed) {
      this.flagAt0 = now;
      this.flagArmed = setTimeout(guard(() => { this.flagArmed = 0; this.renderFlagRow(); }), FLAG_CONFIRM_MS);
      const b = this.flagBtn;
      b.innerHTML = svg('flag');
      b.append(tr('flagConfirmButton', { time: fmtTime(now) }));
      b.classList.add('armed');
      return;
    }
    clearTimeout(this.flagArmed);
    this.flagArmed = 0;
    this.toggleFlag(e, this.flagAt0);
  }

  // The U key: removes the mark here, or asks in a notice before marking.
  flagByKey(e) {
    const now = this.p.video.currentTime;
    if (this.flagAt(now)) { this.toggleFlag(e); return true; }
    this.p.toast(tr('flagConfirm', { time: fmtTime(now) }), tr('flagConfirmAction'), (ev) => this.toggleFlag(ev, now));
    return true;
  }

  toggleFlag(e, at) {
    return this.once(() => this.toggleFlagNow(e, at));
  }

  async toggleFlagNow(e, at) {
    if (!this.canFlag) return;
    const time = at == null ? this.p.video.currentTime : at;
    const existing = this.flagAt(time);
    try {
      if (existing) {
        await this.api.removeFlag(e, existing);
        this.items = this.items.filter((x) => x !== existing);
        this.p.toast(tr('flagRemoved', { time: fmtTime(existing.time) }));
      } else {
        await this.api.addFlag(e, time);
        const scene = Math.floor(time / FLAG_SCENE_SECONDS) * FLAG_SCENE_SECONDS;
        this.items.push({ id: 'flag-' + scene / FLAG_SCENE_SECONDS, type: 'flag', time: scene, createdAt: new Date().toISOString() });
        this.sort();
        this.p.toast(tr('flagAdded', { time: fmtTime(scene) }));
      }
      this.changed();
      this.p.renderFlagButton();
    } catch (err) { this.fail(err); }
  }

  remove(e, item) {
    return this.once(() => this.removeNow(e, item));
  }

  // True when removed.
  async removeNow(e, item) {
    try {
      if (item.type === 'flag') await this.api.removeFlag(e, item);
      else await this.api.deleteNote(e, item);
      this.items = this.items.filter((x) => x !== item);
      this.tags.forget(item.id);
      this.showError('');
      this.changed();
      this.p.renderFlagButton();
      return true;
    } catch (err) { this.fail(err); return false; }
  }

  markers() {
    return this.items.filter((x) => x.time != null).map((x) => {
      const tags = x.type === 'flag' ? [] : this.tags.of(x.id);
      const base = x.type === 'note' ? tr('markerNote') + tr('sepLabel') + x.text : x.type === 'bookmark' ? tr('markerBookmark') : tr('markerFlag');
      return {
        time: x.time,
        kind: x.type,
        color: tags.length ? tags[0].color : null,
        label: tags.length ? base + ' [' + tags.map((g) => g.name).join(tr('sepList')) + ']' : base,
      };
    });
  }

  openExport() {
    this.exporting = true;
    this.managing = false;
    this.p.sidebar.open('notes');
    this.render();
  }

  // Export (Markdown, zip) and backup / restore of what only lives in this browser.
  exportPanel() {
    const ex = new Exporter(this.p);
    const hasPdf = !!(this.p.deck && this.p.deck.pages.length);
    const pics = el('input', { type: 'checkbox', checked: hasPdf, disabled: !hasPdf });
    const pdfs = el('input', { type: 'checkbox' });
    const busy = async (btn, fn) => {
      btn.disabled = true;
      try { await fn(); } catch (e) { this.p.toast(tr('exportFailed', { msg: (e && e.message) || e })); } finally { btn.disabled = false; }
    };
    const one = el('button.pbtn.primary', { text: tr('exportLecture') });
    one.addEventListener('click', guard(() => busy(one, async () => {
      const r = await ex.lecture(pics.checked);
      this.p.toast(tr('exportedLecture', { n: r.notes, p: r.pictures }));
    })));
    const all = el('button.pbtn', { text: tr('exportCourse') });
    all.addEventListener('click', guard(() => busy(all, async () => {
      let r;
      // Back to its name however it ends (it showed the progress).
      try { r = await ex.course((k, total) => { all.textContent = tr('exportCourseProgress', { k: k + 1, n: total }); }); } finally { all.textContent = tr('exportCourse'); }
      this.p.toast(r.failed ? tr('exportedCoursePartial', { n: r.files, m: r.failed, file: tr('exportNotReadFile') }) : r.files ? tr('exportedCourse', { n: r.files }) : tr('exportedNothing'));
    })));
    const backup = el('button.pbtn', { text: tr('backupMake') });
    backup.addEventListener('click', guard(() => busy(backup, async () => {
      const data = await makeBackup(pdfs.checked);
      const name = 'lite-player-for-echo360-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      platform.save(new Blob([JSON.stringify(data)], { type: 'application/json' }), name);
      this.p.toast(tr('backupMade', { n: Object.keys(data.db).length }));
    })));
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    file.addEventListener('change', guard(async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        if (f.size > BACKUP_MAX_BYTES) throw new Error(tr('backupTooBig', { max: Math.round(BACKUP_MAX_BYTES / 1048576) }));
        const n = await restoreBackup(JSON.parse(await f.text()));
        // From now on this page must not write its older data over the restored one (its
        // settings on leaving, the watched record): stop all writes and reload at once.
        storageLock.frozen = true;
        this.p.toast(tr('backupRestored', { n }));
        setTimeout(() => location.reload(), 1200);
      } catch (e) { this.p.toast(tr('exportFailed', { msg: (e && e.message) || e })); }
      file.value = '';
    }));
    const restore = el('button.pbtn', { text: tr('backupRestore'), onclick: () => file.click() });
    return el('div.tagman', null,
      el('div.pinfo', { text: tr('exportInfo') }),
      el('label.crow', null, pics, el('span', { text: hasPdf ? tr('exportPictures') : tr('exportPicturesNoPdf') })),
      el('div.crow', null, one, all),
      el('div.pinfo', { text: tr('backupInfo') }),
      el('label.crow', null, pdfs, el('span', { text: tr('backupPdfs') })),
      el('div.crow', null, backup, restore, file),
      el('div.crow', null, el('span.grow'), el('button.link', { text: tr('done'), onclick: () => { this.exporting = false; this.render(); } })));
  }

  // `G`: tags the note or bookmark at the current time (within the last 30 s, or just
  // ahead), or bookmarks this moment first; opens its tag picker.
  async tagHere(e) {
    const now = this.p.video.currentTime;
    let item = null;
    for (const x of this.items) if (x.type !== 'flag' && x.time != null && x.time <= now + 5 && x.time >= now - 30 && (!item || Math.abs(x.time - now) < Math.abs(item.time - now))) item = x;
    if (!item) {
      // The bookmark just made, and only that one: if adding it failed, nothing is tagged.
      item = await this.addBookmark(e);
      if (!item) return;
    }
    this.filter = 'all';
    this.select.value = 'all';
    this.tagFilter = '';
    this.picking = item.id;
    this.p.sidebar.open('notes');
    this.render();
    // (The page replaces the global CSS object, so no CSS.escape here.)
    const card = [...this.list.querySelectorAll('.card')].find((c) => c.dataset.id === String(item.id));
    if (card) { card.scrollIntoView({ block: 'nearest' }); const b = card.querySelector('.tagopt'); if (b) b.focus(); }
  }

  dispose() {
    this.d.dispose();
  }
}

// ---- 56-tags.js ----
// ===================================================================================
// Private tags on notes and bookmarks. Local only: they are kept in IndexedDB and never
// sent to Echo360, so only the user sees them (and they go with a backup, 85-export.js).
//
// The tag list belongs to the course (Echo360 section), so every recording of the course
// offers the same tags; which tags an item has is kept per recording.
//   tags:<section>      { tags: [{ id, name, color }] }   (a few defaults the first time)
//   tagmap:<mediaId>    { <note or bookmark id>: [tag id, ...] }
// ===================================================================================

const TAG_COLORS = ['#f6c343', '#6ea8ff', '#ff6b6b', '#4fd1a5', '#c084fc', '#fb923c', '#94a3b8', '#f472b6'];

// Tags as stored may come from an old version or a restored backup: known fields only, and
// a plain colour (anything else would be put into a style attribute).
function cleanTags(list) {
  return list.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string')
    .map((g) => ({ id: g.id, name: g.name, color: plainColor(g.color, TAG_FALLBACK_COLOR) }));
}

// Several tabs can show recordings of the same course (or the same recording) at once, so
// a change is never saved by writing this page's whole copy back: that would undo what
// another tab saved meanwhile. Each change is an operation, applied to this page's copy at
// once and replayed on the stored record in one transaction (idbCache.update); this page
// then takes the stored result.
class TagStore {
  constructor(lesson, onChange) {
    this.courseKey = 'tags:' + (lesson.sectionId || 'all');
    this.mapKey = lesson.mediaId ? 'tagmap:' + lesson.mediaId : null;
    this.onChange = onChange || (() => {});
    this.tags = [];
    this.map = {};
    this.ready = false;
  }

  static defaults() {
    return [
      { id: 'exam', name: tr('tagExam'), color: TAG_COLORS[0] },
      { id: 'assignment', name: tr('tagAssignment'), color: TAG_COLORS[1] },
      { id: 'confused', name: tr('tagConfused'), color: TAG_COLORS[2] },
    ];
  }

  async load() {
    const rec = await idbCache.get(this.courseKey);
    if (rec && Array.isArray(rec.tags)) {
      this.tags = cleanTags(rec.tags);
    } else {
      // First use in this course: a few suggestions, which the user may delete (kept if
      // another tab has made the list meanwhile).
      this.tags = TagStore.defaults();
      this.changeTags(() => {});
    }
    const m = this.mapKey ? await idbCache.get(this.mapKey) : null;
    this.map = m && typeof m === 'object' ? m : {};
    this.ready = true;
    this.onChange();
  }

  // op(tags) changes a tag list in place: applied here now, then to the stored list.
  changeTags(op) {
    op(this.tags);
    idbCache.update(this.courseKey, (rec) => {
      const tags = rec && Array.isArray(rec.tags) ? cleanTags(rec.tags) : TagStore.defaults();
      op(tags);
      return { tags };
    }).then((rec) => {
      // Redraw only if another tab's changes came along (else nothing new to show).
      if (rec && Array.isArray(rec.tags) && JSON.stringify(rec.tags) !== JSON.stringify(this.tags)) { this.tags = cleanTags(rec.tags); this.onChange(); }
    }).catch((e) => log.warn('tags:', e));
  }

  // op(map) changes this recording's item -> tag ids map in place, the same way.
  changeMap(op) {
    if (!this.mapKey) return;
    op(this.map);
    idbCache.update(this.mapKey, (rec) => {
      const map = rec && typeof rec === 'object' ? rec : {};
      op(map);
      return map;
    }).then((rec) => {
      if (rec && typeof rec === 'object' && JSON.stringify(rec) !== JSON.stringify(this.map)) { this.map = rec; this.onChange(); }
    }).catch((e) => log.warn('tags:', e));
  }

  byId(id) { return this.tags.find((x) => x.id === id) || null; }

  // Tags of an item, in the order of the tag list (unknown ids, from tags deleted while
  // another recording was open, are skipped).
  of(itemId) {
    const ids = this.map[itemId] || [];
    return this.tags.filter((x) => ids.includes(x.id));
  }

  has(itemId, tagId) { return (this.map[itemId] || []).includes(tagId); }

  // Adds or removes a tag on an item. The wanted state is decided here, so replaying it
  // on the stored map cannot flip back a change another tab made.
  toggle(itemId, tagId) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const on = !this.has(itemId, tagId);
    this.changeMap((map) => {
      const ids = (map[itemId] || []).filter((x) => x !== tagId);
      if (on) ids.push(tagId);
      if (ids.length) map[itemId] = ids; else delete map[itemId];
    });
    this.onChange();
  }

  // Forgets an item's tags (the item was deleted).
  forget(itemId) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    if (!this.map[itemId]) return;
    this.changeMap((map) => { delete map[itemId]; });
  }

  create(name, color) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return null;
    const same = this.tags.find((x) => x.name.toLowerCase() === clean.toLowerCase());
    if (same) return same;
    const tag = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: clean, color: color || TAG_COLORS[this.tags.length % TAG_COLORS.length] };
    this.changeTags((tags) => {
      if (!tags.some((x) => x.id === tag.id || x.name.toLowerCase() === clean.toLowerCase())) tags.push(tag);
    });
    this.onChange();
    return tag;
  }

  rename(id, name) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const tag = this.byId(id);
    const clean = String(name || '').trim().slice(0, 40);
    if (!tag || !clean || clean === tag.name) return;
    this.changeTags((tags) => { const t = tags.find((x) => x.id === id); if (t) t.name = clean; });
    this.onChange();
  }

  recolor(id, color) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    if (!this.byId(id)) return;
    this.changeTags((tags) => { const t = tags.find((x) => x.id === id); if (t) t.color = color; });
    this.onChange();
  }

  remove(id) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    this.changeTags((tags) => { const i = tags.findIndex((x) => x.id === id); if (i >= 0) tags.splice(i, 1); });
    this.changeMap((map) => {
      for (const k of Object.keys(map)) {
        map[k] = map[k].filter((x) => x !== id);
        if (!map[k].length) delete map[k];
      }
    });
    this.onChange();
  }
}

// A tag's colour dot (one style property, never a whole style attribute).
function colorDot(color) {
  const i = el('i');
  i.style.backgroundColor = plainColor(color, TAG_FALLBACK_COLOR);
  return i;
}

// A tag as a small coloured chip.
function tagChip(tag, onclick) {
  const elem = el(onclick ? 'button.tagchip' : 'span.tagchip', { onclick: onclick || null, title: tag.name },
    colorDot(tag.color), el('span', { text: tag.name }));
  return elem;
}

// The picker for one item: every tag as a toggle, and a field for a new tag.
function tagPicker(tagStore, itemId, onDone) {
  const box = el('div.tagpick', { role: 'group', 'aria-label': tr('tagsFor') });
  const render = () => {
    box.textContent = '';
    for (const tag of tagStore.tags) {
      const on = tagStore.has(itemId, tag.id);
      box.append(el('button.tagopt' + (on ? '.on' : ''), { 'aria-pressed': String(on), onclick: () => { tagStore.toggle(itemId, tag.id); render(); } },
        colorDot(tag.color), el('span', { text: tag.name })));
    }
    const input = el('input.input.small', { placeholder: tr('newTag'), maxLength: 40, 'aria-label': tr('newTag') });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) {
        const tag = tagStore.create(input.value);
        if (tag && !tagStore.has(itemId, tag.id)) tagStore.toggle(itemId, tag.id);
        render();
        box.querySelector('input').focus();
      } else if (e.key === 'Escape') onDone();
    });
    box.append(el('div.tagnew', null, input, el('button.link', { text: tr('done'), onclick: onDone })));
  };
  render();
  return box;
}

// Managing the course's tags: rename, colour, delete (two clicks), add.
function tagManager(tagStore, onClose) {
  const box = el('div.tagman');
  const render = () => {
    box.textContent = '';
    box.append(el('div.pinfo', { text: tr('tagsPrivate') }));
    for (const tag of tagStore.tags) {
      const swatch = el('button.tagswatch', { title: tr('tagColor'), 'aria-label': tr('tagColor') });
      swatch.style.backgroundColor = plainColor(tag.color, TAG_FALLBACK_COLOR);
      swatch.addEventListener('click', () => {
        const i = TAG_COLORS.indexOf(tag.color);
        tagStore.recolor(tag.id, TAG_COLORS[(i + 1) % TAG_COLORS.length]);
        render();
      });
      const name = el('input.input.small', { value: tag.name, maxLength: 40, 'aria-label': tr('tagName') });
      name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
      name.addEventListener('change', () => tagStore.rename(tag.id, name.value));
      const del = confirmButton(tr('delete'), () => { tagStore.remove(tag.id); render(); });
      box.append(el('div.tagrow', null, swatch, name, del));
    }
    const input = el('input.input.small', { placeholder: tr('newTag'), maxLength: 40, 'aria-label': tr('newTag') });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && tagStore.create(input.value)) render(); });
    box.append(el('div.tagrow', null, input, el('button.pbtn', { text: tr('addTag'), onclick: () => { if (tagStore.create(input.value)) render(); } })),
      el('div.crow', null, el('span.grow'), el('button.link', { text: tr('done'), onclick: onClose })));
  };
  render();
  return box;
}

// ---- 57-discussion.js ----
// ===================================================================================
// Discussion tab: the lesson's public questions and replies.
// Loaded once at start (for availability and progress-bar markers) and again when the tab
// is opened or refreshed, and after every write, so the list always shows server state.
// Every write is a click (or Ctrl+Enter) by the user; the composer states who can see posts.
// ===================================================================================

const MAX_POST_LENGTH = 5000;

class DiscussionPane {
  constructor(player, pane, api, disposer) {
    this.p = player;
    this.pane = pane;
    this.api = api;
    this.threads = [];
    this.hiddenCount = 0;
    this.sort = 'newest';
    this.visible = false;
    this.dirty = true;
    this.openReplies = new Set();
    this.replyOpen = null;
    this.replyDrafts = new Map();   // question id -> { text, anon }: unsent replies survive redraws and failures
    this.loadedAt = 0;
    this.d = disposer || new Disposer();   // owned by whoever created this (parent.child())
    this.build();
  }

  // Resolves true when loaded, else to the error (see player.loadPart).
  // Loads can overlap (after a write, on opening the tab, "Refresh"): only the newest one's
  // answer is used, so an older answer arriving late cannot hide a post just made.
  async load() {
    const seq = (this.loadSeq = (this.loadSeq || 0) + 1);
    try {
      const data = await this.api.discussions();
      if (seq !== this.loadSeq) return true;
      this.threads = data.threads;
      this.hiddenCount = data.hiddenCount;
      this.loadedAt = Date.now();
      this.showError('');
      this.changed();
      return true;
    } catch (e) {
      if (seq !== this.loadSeq) return false;
      log.info('discussions unavailable:', e.message);
      if (this.loadedAt) this.showError(tr('loadFailed', { error: loadErrorText(e) }));
      return e || false;
    }
  }

  changed() {
    this.dirty = true;
    if (this.visible) this.render();
    this.p.updateMarkers();
  }

  build() {
    this.textarea = el('textarea.input', { rows: 3, maxLength: MAX_POST_LENGTH + 500, placeholder: tr('postPlaceholder'), 'aria-label': tr('postPlaceholder') });
    this.counter = el('span.counter');
    this.linkTime = el('input', { type: 'checkbox', checked: true });
    this.linkLabel = el('span');
    this.anon = el('input', { type: 'checkbox' });
    this.postBtn = el('button.pbtn.primary', { text: tr('postPublic'), onclick: (e) => this.post(e) });
    this.d.listen(this.textarea, 'input', () => this.updateCounter(this.textarea, this.counter, this.postBtn));
    this.d.listen(this.textarea, 'focus', () => this.updateLinkLabel());
    this.d.listen(this.textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.post(e); }
    });
    this.sortSel = el('select.input.small', { 'aria-label': tr('sortNewest') },
      el('option', { value: 'newest', text: tr('sortNewest') }), el('option', { value: 'time', text: tr('sortVideoTime') }));
    this.d.listen(this.sortSel, 'change', () => { this.sort = this.sortSel.value; this.render(); });
    this.hiddenEl = el('span.pmuted');
    this.errorEl = el('div.perror', { hidden: true });
    this.list = el('div.plist');
    this.pane.append(
      el('div.composer.public', null,
        el('div.pwarn', { role: 'note', text: tr('publicWarning') }),
        this.textarea,
        el('div.crow', null,
          el('label.check', null, this.linkTime, this.linkLabel),
          el('label.check', null, this.anon, el('span', { text: tr('hideName') })),
          el('span.grow'), this.counter, this.postBtn)),
      el('div.ptools', null, this.sortSel, this.hiddenEl, el('span.grow'),
        el('button.link', { text: tr('refresh'), onclick: () => this.load() })),
      this.errorEl,
      this.list,
    );
    this.updateLinkLabel();
    this.updateCounter(this.textarea, this.counter, this.postBtn);
  }

  updateLinkLabel() {
    const text = tr('linkTime', { time: fmtTime(this.p.video.currentTime, this.p.duration() >= 3600) });
    if (this.linkLabel.textContent !== text) this.linkLabel.textContent = text;
  }

  // The playing moment changed (play or seek): "Link to" names the moment a post links to.
  update() {
    if (this.visible) this.updateLinkLabel();
  }

  updateCounter(area, counter, button) {
    const left = MAX_POST_LENGTH - area.value.length;
    counter.textContent = left < 0 ? tr('tooLong', { n: -left }) : left < 500 ? tr('charsLeft', { n: left }) : '';
    counter.classList.toggle('over', left < 0);
    button.disabled = left < 0 || !area.value.trim();
  }

  show(on) {
    this.visible = on;
    if (!on) return;
    this.updateLinkLabel();
    if (this.dirty) this.render();
    // Refresh when the tab is opened, at most once a minute (no live push channel).
    // Never loaded: the first load failed and the tab says so, with "Retry".
    if (this.loadedAt && Date.now() - this.loadedAt > 60000) this.load();
  }

  showError(msg) {
    this.errorEl.textContent = msg;
    this.errorEl.hidden = !msg;
  }

  fail(e) {
    log.warn('discussion write failed', e);
    this.showError(tr('saveFailed', { error: errorText(e) }));
  }

  sorted() {
    const list = this.threads.slice();
    if (this.sort === 'time') list.sort((a, b) => (a.time == null ? Infinity : a.time) - (b.time == null ? Infinity : b.time));
    else list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return list;
  }

  render() {
    this.dirty = false;
    this.hiddenEl.textContent = this.hiddenCount ? tr('hiddenPosts', { n: this.hiddenCount }) : '';
    const long = this.p.duration() >= 3600;
    const frag = document.createDocumentFragment();
    if (!this.threads.length) frag.append(el('div.pempty', { text: tr('noPosts') }));
    for (const q of this.sorted()) frag.append(this.renderThread(q, long));
    this.list.textContent = '';
    this.list.append(frag);
  }

  renderThread(q, long) {
    const card = el('div.card.thread', null, this.renderComment(q, long));
    const n = q.replies.length;
    const footer = el('div.iactions');
    if (n) {
      const open = this.openReplies.has(q.id);
      footer.append(el('button.link', {
        text: open ? tr('hideReplies') : (n === 1 ? tr('oneReply') : tr('replies', { n })),
        onclick: () => { if (open) this.openReplies.delete(q.id); else this.openReplies.add(q.id); this.render(); },
      }));
    }
    footer.append(el('button.link', { text: tr('replyPublic'), onclick: () => { this.replyOpen = q.id; this.openReplies.add(q.id); this.render(); } }));
    card.append(footer);
    if (n && this.openReplies.has(q.id)) {
      const replies = el('div.replies');
      for (const r of q.replies) replies.append(this.renderComment(r, long));
      card.append(replies);
    }
    if (this.replyOpen === q.id) card.append(this.renderReplyComposer(q));
    return card;
  }

  renderComment(c, long) {
    const who = c.mine ? tr(c.nameHidden ? 'youAnonymous' : 'you') : (c.author || tr('anonymous'));
    const badges = [];
    if (c.instructor) badges.push(el('span.badge.inst', { text: tr('instructor') }));
    if (c.ta) badges.push(el('span.badge.inst', { text: tr('ta') }));
    const time = c.time != null ? el('button.chiptime', { text: fmtTime(c.time, long), onclick: () => this.p.seek(c.time) }) : null;
    const date = el('span.pmuted', { text: formatDate(c.createdAt), title: c.createdAt || '' });
    const actions = el('div.cactions',
      null,
      el('button.link' + (c.liked ? '.on' : ''), {
        text: (c.liked ? tr('unlike') : tr('like')) + (c.likes ? ' (' + c.likes + ')' : ''),
        onclick: (e) => this.write(e, () => this.api.like(e, c, !c.liked)),
      }),
      c.questionId ? null : el('button.link' + (c.saved ? '.on' : ''), {
        text: c.saved ? tr('unsavePost') : tr('savePost'),
        onclick: (e) => this.write(e, () => this.api.save(e, c, !c.saved)),
      }),
      c.mine ? this.deleteButton(c) : null,
      c.hasAttachment ? el('button.link', { text: tr('attachmentOpen'), onclick: () => this.p.opts.onFallback('attachment') }) : null,
    );
    return el('div.comment' + (c.questionId ? '.reply' : ''), null,
      el('div.ihead', null, el('span.author', { text: who }), ...badges, time, el('span.grow'), date),
      el('div.ibody', { text: c.body }),
      actions);
  }

  // Two clicks within 3 s delete; the second click is the user action sent with the write.
  deleteButton(c) {
    return confirmButton(tr('delete'), (e) => this.write(e, () => this.api.deleteComment(e, c)));
  }

  renderReplyComposer(q) {
    // The list is redrawn after every load (refresh, sorting, a write elsewhere): the reply
    // being written is kept per question, not in the element.
    const draft = this.replyDrafts.get(q.id) || { text: '', anon: false };
    this.replyDrafts.set(q.id, draft);
    const area = el('textarea.input', { rows: 2, placeholder: tr('replyPlaceholder'), 'aria-label': tr('replyPlaceholder') });
    area.value = draft.text;
    const counter = el('span.counter');
    const anon = el('input', { type: 'checkbox' });
    anon.checked = draft.anon;
    anon.addEventListener('change', () => { draft.anon = anon.checked; });
    const send = el('button.pbtn.primary', { text: tr('replyPublic') });
    const submit = (e) => {
      const body = area.value.trim();
      if (this.busy || !body || body.length > MAX_POST_LENGTH) return;
      send.disabled = true;
      this.write(e, () => this.api.reply(e, q.id, { body, anonymous: anon.checked }), () => {
        // Sent: the composer goes at once (not after the reload), with its text. Text typed
        // while it was on its way is another reply being written: it stays open with that.
        if (area.value.trim() !== body) { draft.text = area.value; return; }
        area.value = '';
        this.replyOpen = null;
        this.replyDrafts.delete(q.id);
        this.render();
      });
    };
    area.addEventListener('input', guard(() => { draft.text = area.value; this.updateCounter(area, counter, send); }));
    area.addEventListener('keydown', guard((e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(e); } }));
    send.addEventListener('click', guard(submit));
    this.updateCounter(area, counter, send);
    setTimeout(() => area.focus(), 0);
    return el('div.composer.public.reply', null,
      el('div.pwarn', { role: 'note', text: tr('publicWarning') }),
      area,
      el('div.crow', null, el('label.check', null, anon, el('span', { text: tr('hideName') })), el('span.grow'), counter,
        el('button.pbtn', { text: tr('cancel'), onclick: () => { this.replyOpen = null; this.replyDrafts.delete(q.id); this.render(); } }), send));
  }

  async post(e) {
    const body = this.textarea.value.trim();
    if (this.busy || !body || body.length > MAX_POST_LENGTH) return;
    this.postBtn.disabled = true;
    const time = this.linkTime.checked ? this.p.video.currentTime : null;
    await this.write(e, () => this.api.postComment(e, { body, anonymous: this.anon.checked, time }), () => {
      // Only what was sent goes: text typed while it was on its way stays (with its choice
      // of name).
      if (this.textarea.value.trim() !== body) return;
      this.textarea.value = '';
      this.anon.checked = false;
    });
    this.updateCounter(this.textarea, this.counter, this.postBtn);
  }

  // Runs one write, then reloads the list so it shows what the server stored. One write
  // at a time for the whole tab, until the reload has finished too: a second Ctrl+Enter
  // (or a click) while the request is on its way, or while the old composer is still shown
  // after it succeeded, does nothing, so a post can never be published twice.
  async write(e, fn, onSuccess) {
    if (this.busy) return false;
    this.busy = true;
    let ok = false;
    try {
      try {
        await fn();
        ok = true;
        if (onSuccess) onSuccess();
        this.showError('');
      } catch (err) {
        this.fail(err);
      }
      // The list is loaded again either way (what was saved, or what is there now); a write
      // that failed keeps saying so afterwards (a successful load clears load errors).
      const failed = ok ? '' : this.errorEl.textContent;
      await this.load();
      if (failed) this.showError(failed);
    } finally {
      this.busy = false;
    }
    return ok;
  }

  markers() {
    return this.threads.filter((q) => q.time != null).map((q) => ({
      time: q.time,
      kind: 'comment',
      label: tr('markerComment') + tr('sepLabel') + (q.body.length > 80 ? q.body.slice(0, 77) + '…' : q.body),
    }));
  }

  dispose() {
    this.d.dispose();
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric' });
  } catch (e) {
    return iso.slice(0, 10);
  }
}

// ---- 58-markers.js ----
// ===================================================================================
// Progress-bar markers for timed items (notes, bookmarks, flags, discussion posts).
// The layer is rebuilt only when the data or the duration changes; hover and click use
// the seek bar's existing pointer handlers via nearest().
// ===================================================================================

class MarkersLayer {
  constructor(elem) {
    this.el = elem;
    this.items = [];
    this.dur = 0;
  }

  set(items, dur) {
    this.items = items.slice().sort((a, b) => a.time - b.time);
    this.dur = dur;
    this.render();
  }

  render() {
    const elem = this.el;
    elem.textContent = '';
    if (!this.dur) return;
    const frag = document.createDocumentFragment();
    for (const m of this.items) {
      if (m.time < 0 || m.time > this.dur) continue;
      const i = document.createElement('i');
      i.className = 'mk mk-' + m.kind;
      if (m.color) i.style.backgroundColor = plainColor(m.color, TAG_FALLBACK_COLOR);
      i.style.left = ((m.time / this.dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    elem.appendChild(frag);
  }

  // Closest item within `px` pixels of fraction `f` on a bar `width` pixels wide.
  nearest(f, width, px) {
    if (!this.items.length || !this.dur || !width) return null;
    const t0 = f * this.dur;
    const tol = (px / width) * this.dur;
    let best = null;
    let bestD = tol;
    for (const m of this.items) {
      const dd = Math.abs(m.time - t0);
      if (dd <= bestD) { best = m; bestD = dd; }
      if (m.time > t0 + tol) break;
    }
    return best;
  }
}

// ---- 59-notice.js ----
// ===================================================================================
// Small, dismissible notice shown when we fall back to the original player. A fallback
// notice also says why and offers the start-up diagnostics (our player, with its own
// diagnostics, is not there).
// ===================================================================================

function notice(text, more) {
  const show = () => {
    const host = document.createElement('div');
    host.className = 'lite-player-for-echo360-notice';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>div{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:min(420px,calc(100vw - 32px));'
      + 'padding:10px 12px 10px 14px;border-radius:10px;background:rgba(20,20,24,.94);color:#eee;'
      + 'font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:flex-start}'
      + 'p{margin:0}small{display:block;opacity:.75;margin-top:4px;overflow-wrap:anywhere}'
      + 'button{all:unset;cursor:pointer;opacity:.7;padding:0 4px}button:hover{opacity:1}'
      + '.act{display:inline-block;margin-top:6px;padding:2px 8px;border:1px solid rgba(255,255,255,.35);border-radius:6px;opacity:.9}'
      + '@media (pointer: coarse){button{min-width:44px;min-height:44px;box-sizing:border-box;text-align:center}.act{display:inline-flex;align-items:center}}</style>'
      + '<div role="status"><p><span></span><small hidden></small><button class="act" hidden></button></p><button class="x">✕</button></div>';
    root.querySelector('span').textContent = text;
    const small = /** @type {HTMLElement} */ (root.querySelector('small'));
    if (more && more.detail) { small.textContent = more.detail; small.hidden = false; }
    const act = /** @type {HTMLElement} */ (root.querySelector('.act'));
    if (more && more.action) {
      act.textContent = more.action[0];
      act.hidden = false;
      act.addEventListener('click', () => more.action[1]((msg) => { act.textContent = msg; }));
    }
    const close = root.querySelector('.x');
    close.setAttribute('aria-label', tr('close'));
    close.addEventListener('click', () => host.remove());
    document.body.appendChild(host);
    setTimeout(() => host.remove(), more && more.action ? 30000 : 10000);
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
}

// The original player has the page: says so, why (boot.reason), and offers the start-up
// diagnostics.
function fallbackNotice(text) {
  notice(text, {
    detail: boot.reason ? tr('noticeReason', { why: boot.reason }) : '',
    action: [tr('copyDiagnostics'), (done) => {
      let text2 = '';
      try { text2 = startupDiagnosticsText(); } catch (e) { text2 = String(e); }
      navigator.clipboard.writeText(text2).then(() => done(tr('diagCopied')), (e) => done(tr('copyFailed', { msg: (e && e.message) || e })));
    }],
  });
}

// ---- 60-audio.js ----
// ===================================================================================
// Audio processing for the clock <video>: loudness levelling, voice enhancement, mono.
//
// createMediaElementSource() is irreversible and an AudioContext created without a user
// gesture starts suspended (which would silence the video), so the graph is only built
// from a user action. Settings remembered from an earlier visit are applied on the first
// click or key press.
//
// Only the enabled stages are connected: Chrome's DynamicsCompressor adds its own makeup
// gain even at ratio 1, so "neutral parameters" would still change the sound. With every
// feature off the graph is source -> destination. Rewiring only happens on user toggles.
//
//   source -> [mono] -> [highpass -> presence] -> [leveller -> makeup -> limiter -> trim] -> out
//
// The settings are in 02-tuning.js (VOICE_FILTERS, LEVELLER, LIMITER, LEVEL_*). The voice
// stage lowers 50 Hz hum by about 10 dB.
// ===================================================================================

const AUDIO_FEATURES = ['level', 'voice', 'mono'];

class AudioChain {
  constructor(video) {
    this.video = video;
    this.ctx = null;
    this.settings = { level: false, voice: false, mono: false };
    this.timer = 0;
    this.makeupDb = 0;
    this.avgPow = 0;
    this.buf = null;
    this.reason = AudioChain.unsupportedReason();
  }

  // Web Audio is only used with hls.js (MSE). With native HLS a cross-origin source could
  // make the graph output silence, so the features stay off there.
  static unsupportedReason() {
    if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return 'noWebAudio';
    if (!(platform.Hls && platform.Hls.isSupported())) return 'nativeHls';
    return null;
  }

  get built() { return !!this.ctx; }

  anyOn() { return AUDIO_FEATURES.some((k) => this.settings[k]); }

  build() {
    if (this.ctx || this.reason) return !!this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // Lecture playback does not need interactive latency. Android's default interactive
    // route can use game/speaker processing that changes the sound even with all stages
    // bypassed; prefer the media playback route and its power-efficient buffering.
    const ctx = new Ctx({ latencyHint: 'playback' });
    const n = {};
    // A graph that cannot be made leaves no context behind (each try would add one).
    try {
      n.src = ctx.createMediaElementSource(this.video);
      n.mono = ctx.createGain();
      n.mono.channelCount = 1;
      n.mono.channelCountMode = 'explicit';
      n.mono.channelInterpretation = 'speakers';
      n.highpass = ctx.createBiquadFilter();
      n.highpass.type = 'highpass';
      n.highpass.frequency.value = VOICE_FILTERS.highpassHz;
      n.highpass.Q.value = VOICE_FILTERS.highpassQ;
      n.presence = ctx.createBiquadFilter();
      n.presence.type = 'peaking';
      n.presence.frequency.value = VOICE_FILTERS.presenceHz;
      n.presence.Q.value = VOICE_FILTERS.presenceQ;
      n.presence.gain.value = VOICE_FILTERS.presenceDb;
      n.leveller = ctx.createDynamicsCompressor();
      for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n.leveller[k].value = LEVELLER[k];
      n.makeup = ctx.createGain();
      n.limiter = ctx.createDynamicsCompressor();
      n.limiter.threshold.value = LIMIT_THRESHOLD_DB;
      for (const k of ['knee', 'ratio', 'attack', 'release']) n.limiter[k].value = LIMITER[k];
      n.trim = ctx.createGain();
      n.trim.gain.value = Math.pow(10, LIMIT_TRIM_DB / 20);
      n.analyser = ctx.createAnalyser();
      n.analyser.fftSize = 2048;
      // The level stage is internally always wired; only its entry and exit move.
      n.leveller.connect(n.makeup).connect(n.limiter).connect(n.trim);
      n.leveller.connect(n.analyser);
      n.highpass.connect(n.presence);
    } catch (e) {
      ctx.close().catch(() => {});
      throw e;
    }
    this.ctx = ctx;
    this.n = n;
    this.buf = new Float32Array(n.analyser.fftSize);
    this.apply();
    return true;
  }

  // Call from a user event handler.
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  set(settings) {
    Object.assign(this.settings, settings);
    if (this.ctx) this.apply();
  }

  apply() {
    const s = this.settings;
    const n = this.n;
    for (const node of [n.src, n.mono, n.presence, n.trim]) node.disconnect();
    // Entry/exit pairs of the enabled stages, chained in order.
    const stages = [];
    if (s.mono) stages.push([n.mono, n.mono]);
    if (s.voice) stages.push([n.highpass, n.presence]);
    if (s.level) stages.push([n.leveller, n.trim]);
    /** @type {AudioNode} */
    let tail = n.src;
    for (const [entry, exit] of stages) { tail.connect(entry); tail = exit; }
    tail.connect(this.ctx.destination);
    if (!s.level) { this.makeupDb = 0; this.avgPow = 0; }
    n.makeup.gain.value = Math.pow(10, this.makeupDb / 20);
    this.syncTimer();
  }

  // The makeup-gain loop runs only while levelling is on and the video is playing.
  syncTimer() {
    const want = this.ctx && this.settings.level && !this.video.paused;
    if (want && !this.timer) this.timer = setInterval(guard(() => this.levelTick()), LEVEL_TICK_MS);
    else if (!want && this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  // Measures the level after compression (before the makeup gain), keeps a ~3 s running
  // average of speech power, and moves the makeup gain a little towards the target.
  levelTick() {
    const b = this.buf;
    this.n.analyser.getFloatTimeDomainData(b);
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
    const pow = sum / b.length;
    if (pow < LEVEL_SILENT_POW) return; // silence: leave the gain alone
    this.avgPow = this.avgPow ? this.avgPow * LEVEL_SMOOTHING + pow * (1 - LEVEL_SMOOTHING) : pow;
    const levelDb = 10 * Math.log10(this.avgPow);
    const wanted = clamp(LEVEL_TARGET_DB - levelDb, 0, LEVEL_MAX_GAIN_DB);
    this.makeupDb += clamp(wanted - this.makeupDb, LEVEL_STEP_DB[0], LEVEL_STEP_DB[1]);
    this.n.makeup.gain.setTargetAtTime(Math.pow(10, this.makeupDb / 20), this.ctx.currentTime, 0.3);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    if (this.ctx) this.ctx.close().catch(() => {});
  }
}

// ---- 61-media-io.js ----
// ===================================================================================
// Shared helpers for background media work: HLS playlist parsing, ranged fetches, an
// IndexedDB cache, and a gate that keeps background downloads from competing with playback.
// ===================================================================================

// Each name starts the list or follows a comma: unanchored, a long run of name characters
// with no "=" would be scanned again from each of its characters (quadratic).
function parseAttrs(s) {
  const out = {};
  const re = /(?:^|,)\s*([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

// Master playlist -> { media: [attributes of each #EXT-X-MEDIA], variants: [{ attrs, uri }]
// (each #EXT-X-STREAM-INF with the URI line after it, as written) }.
function parseMaster(text) {
  const out = { media: [], variants: [] };
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) out.media.push(parseAttrs(line.slice(13)));
    else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const uri = (lines.slice(i + 1).find((l) => l && !l.startsWith('#')) || '').trim();
      out.variants.push({ attrs: parseAttrs(line.slice(18)), uri });
    }
  }
  return out;
}

// Media playlist -> { init: { url, offset, length } | null, segments: [{ start, dur, url, offset, length }] }.
// length is null for segments that are whole files.
function parseMediaPlaylist(text, base) {
  const out = { init: null, segments: [] };
  let dur = 0;
  let range = null;
  let t = 0;
  const nextOffset = new Map();
  // A range that is not a positive length at a whole offset makes the playlist unusable
  // (an empty range would be asked for again and again).
  const parseRange = (spec, url) => {
    const [len, off] = spec.split('@');
    const offset = off !== undefined ? +off : (nextOffset.get(url) || 0);
    const length = +len;
    if (!(Number.isSafeInteger(length) && length > 0 && Number.isSafeInteger(offset) && offset >= 0)) throw new Error('bad byte range in playlist');
    nextOffset.set(url, offset + length);
    return { offset, length };
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      const url = new URL(a.URI, base).href;
      out.init = Object.assign({ url }, a.BYTERANGE ? parseRange(a.BYTERANGE, url) : { offset: 0, length: null });
    } else if (line.startsWith('#EXTINF:')) {
      const d = parseFloat(line.slice(8));
      dur = d > 0 && d < Infinity ? d : 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      range = line.slice(17);
    } else if (!line.startsWith('#')) {
      const url = new URL(line, base).href;
      const r = range ? parseRange(range, url) : { offset: 0, length: null };
      out.segments.push({ start: t, dur, url, offset: r.offset, length: r.length });
      t += dur;
      if (t > MEDIA_MAX_SEC) throw new Error('playlist too long (' + Math.round(t / 3600) + ' h)');
      range = null;
    }
  }
  return out;
}

// A refused request (the video access has expired) renews the session once and retries
// (see 36-session.js), so background work continues where it was.
// Failures are counted for the usage data (the status, or 'network' for no answer).
function fetchOk(url, init, renewed) {
  return fetch(url, Object.assign({ credentials: 'include' }, init)).then((r) => {
    if (!r.ok) usageNote('net', r.status);
    if ((r.status === 401 || r.status === 403) && !renewed && mediaSession.renew) {
      return mediaSession.renew().then(() => fetchOk(url, init, true));
    }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url.split('?')[0]);
    return r;
  }, (e) => {
    if (!(e && e.name === 'AbortError')) usageNote('net', 'network');
    throw e;
  });
}

// Used by the background analyses only: what they download is counted (usage data).
// A server that ignores Range sends the whole file (200): the range is cut from it; a
// partial answer longer than asked for is cut to the length.
function fetchRange(url, offset, length, signal) {
  const headers = length === null ? {} : { Range: 'bytes=' + offset + '-' + (offset + length - 1) };
  return fetchOk(url, { headers, signal }).then((r) => r.arrayBuffer().then((b) => {
    usageNote('bgBytes', null, b.byteLength);
    if (length === null) return b;
    if (r.status !== 206) return b.slice(offset, offset + length);
    return b.byteLength > length ? b.slice(0, length) : b;
  }));
}

// IndexedDB, one object store. Reads and ordinary writes never throw (a cache that cannot
// be used just means work is done again) but failures are logged; writes whose loss the
// user would notice (slide files, a restore) use putStrict, which throws. A failed open is
// tried again on the next call; when another tab needs a newer database version, this
// connection closes so it is not in the way.
const idbCache = {
  db: null,
  open() {
    if (this.db) return this.db;
    const p = new Promise((resolve, reject) => {
      const req = platform.openDb('lite-player-for-echo360', 1);
      if (!req) { reject(new Error('no IndexedDB')); return; }
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('cache')) req.result.createObjectStore('cache'); };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); if (this.db === p) this.db = null; };
        db.onclose = () => { if (this.db === p) this.db = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => log.warn('storage: opening is blocked by another tab');
    });
    this.db = p;
    p.catch((e) => { if (this.db === p) this.db = null; log.warn('storage unavailable:', e); });
    return p;
  },
  tx(mode, fn) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('cache', mode);
      const req = fn(tx.objectStore('cache'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  },
  soft(what, key, p) {
    return p.catch((e) => { log.warn('storage ' + what + ' failed (' + String(key).split(':')[0] + '):', e); return undefined; });
  },
  get(key) { return this.soft('read', key, this.tx('readonly', (s) => s.get(key))); },
  put(key, value) { return storageLock.frozen ? Promise.resolve() : this.soft('write', key, this.tx('readwrite', (s) => s.put(value, key))); },
  putStrict(key, value) { return this.tx('readwrite', (s) => s.put(value, key)); },
  // Several entries in one transaction: all are written or none (throws on failure).
  putMany(entries) {
    if (!entries.length) return Promise.resolve();
    return this.tx('readwrite', (s) => { let req = null; for (const [k, v] of entries) req = s.put(v, k); return req; });
  },
  del(key) { return this.soft('delete', key, this.tx('readwrite', (s) => s.delete(key))); },
  keys() { return this.soft('list', '', this.tx('readonly', (s) => s.getAllKeys())).then((k) => k || []); },
  // Read, change and write one entry in a single transaction (no other tab or task can
  // write in between). fn(old) returns the new value, or undefined to delete the entry.
  // Resolves to the new value.
  update(key, fn) {
    if (storageLock.frozen) return Promise.resolve(undefined);
    return this.open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('cache', 'readwrite');
      const os = tx.objectStore('cache');
      let next;
      const req = os.get(key);
      req.onsuccess = () => {
        try { next = fn(req.result); } catch (e) { tx.abort(); reject(e); return; }
        if (next === undefined) os.delete(key); else os.put(next, key);
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  },
  // The same for several entries: fn({ key: old }) returns { key: new } (undefined deletes;
  // keys left out stay as they are, and need not have been read). Resolves to that object;
  // throws when it could not be written.
  updateMany(keys, fn) {
    if (storageLock.frozen) return Promise.resolve(undefined);
    return this.open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('cache', 'readwrite');
      const os = tx.objectStore('cache');
      const old = {};
      let left = keys.length;
      let next;
      const write = () => {
        try { next = fn(old); } catch (e) { tx.abort(); reject(e); return; }
        for (const [k, v] of Object.entries(next)) { if (v === undefined) os.delete(k); else os.put(v, k); }
      };
      for (const k of keys) {
        const req = os.get(k);
        req.onsuccess = () => { old[k] = req.result; if (--left === 0) write(); };
      }
      if (!keys.length) write();
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  },
};

// Background downloads must never compete with playback: turn() resolves only when the
// video is paused or has at least minBuffer seconds buffered ahead, after a pause of
// playingMs (pausedMs while paused). Everything rejects once the signal aborts.
// Background analyses running now (chapter scan, silence from the audio, slide text): the
// usage data tells CPU pressure with them apart from without (87-telemetry.js).
const bgWork = {
  n: 0,
  track(promise) {
    this.n++;
    const done = () => { this.n--; };
    promise.then(done, done);
    return promise;
  },
};

class BackgroundGate {
  constructor(video, signal) {
    this.video = video;
    this.signal = signal;
  }

  wait(ms) {
    const signal = this.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      const onAbort = () => { clearTimeout(id); reject(new Error('aborted')); };
      const id = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async turn(playingMs, pausedMs, minBuffer) {
    const v = this.video;
    const need = minBuffer || BG_MIN_BUFFER_SEC;
    for (;;) {
      await this.wait(v.paused ? pausedMs : playingMs);
      if (v.seeking || v.readyState < 2) continue;
      if (v.paused || bufferedAhead(v) >= need) return;
    }
  }
}

function bufferedAhead(v) {
  const t = v.currentTime;
  const b = v.buffered;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) > t) return b.end(i) - t;
  return 0;
}

function idle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 1000 });
    else setTimeout(resolve, 0);
  });
}

// ---- 62-silence.js ----
// ===================================================================================
// Silence analysis, and the audio-track reader it is built on.
//
// Data sources, best first:
//   1. Transcript timing: gaps between cues. Free, because the cues are loaded anyway.
//   2. The separate audio rendition (about 46 kbps, 40 MB for two hours): fetched in
//      CHUNK_SEC byte ranges only while playback has enough buffer, decoded to 16 kHz mono by the
//      browser's decoder (which runs off the main thread), and reduced to a loudness
//      envelope of one value per 0.1 s. The envelope is cached in IndexedDB, so a later
//      visit shows it at once and an unfinished analysis continues where it stopped.
//
// The pieces are meant to be reused by later features that read the same audio and cut it
// at the same pauses (for example local transcription):
//   HlsAudioTrack     open(), duration, chunkCount, chunkSpan(i), readChunk(i) -> { start, end, rate, pcm }
//   Envelope          step, length, db(i), dbAt(t), known(i), fill(start, pcm, rate), coverage()
//   findSilences(env, opts)            -> { silences: [{ start, end }], noiseDb, speechDb, thresholdDb }
//   silencesFromCues(cues, dur, opts)  -> [{ start, end }]
//   speechSpans(silences, dur, env, maxSec) -> (not used yet: kept for local speech recognition; tested)
//                                         speech between silences, each piece at most
//                                         maxSec long and cut at its quietest moment
//   SilenceAnalyzer   source, silences, track, env, progress; onChange
// ===================================================================================


// ---- the audio track ----

// URI of the audio rendition used by the lowest-bandwidth variant of a master playlist.
function pickAudioRendition(master) {
  const m = parseMaster(master);
  const groups = new Map();
  for (const a of m.media) if (a.TYPE === 'AUDIO' && a.URI && !groups.has(a['GROUP-ID'])) groups.set(a['GROUP-ID'], a.URI);
  let best = null;
  for (const { attrs: a } of m.variants) {
    const bw = +a.BANDWIDTH || Infinity;
    if (a.AUDIO && groups.has(a.AUDIO) && (!best || bw < best.bw)) best = { bw, uri: groups.get(a.AUDIO) };
  }
  return best ? best.uri : (groups.size ? groups.values().next().value : null);
}

// Consecutive segments in groups of about `sec` seconds (segments are never split; a group
// holds at least one): [{ a, b }] (segment indexes, b exclusive).
function groupSegments(segments, sec) {
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const cur = out[out.length - 1];
    // A segment joins the group while that keeps the group closer to `sec` long.
    if (cur && segments[i].start + segments[i].dur / 2 - segments[cur.a].start <= sec) cur.b = i + 1;
    else out.push({ a: i, b: i + 1 });
  }
  return out;
}

// Reads the separate audio rendition of an HLS stream as PCM, one chunk at a time.
class HlsAudioTrack {
  constructor(masterUrl) {
    this.masterUrl = masterUrl;
    this.segments = [];
    this.init = null;
    this.initBytes = null;
    this.duration = 0;
  }

  async open(signal) {
    const master = await (await fetchOk(this.masterUrl, { signal })).text();
    const uri = pickAudioRendition(master);
    if (!uri) throw new Error('no separate audio rendition');
    this.playlistUrl = new URL(uri, this.masterUrl).href;
    const pl = parseMediaPlaylist(await (await fetchOk(this.playlistUrl, { signal })).text(), this.playlistUrl);
    if (!pl.segments.length) throw new Error('empty audio playlist');
    this.init = pl.init;
    this.segments = pl.segments;
    const last = pl.segments[pl.segments.length - 1];
    this.duration = last.start + last.dur;
    this.chunks = groupSegments(pl.segments, CHUNK_SEC);
    return this;
  }

  get chunkCount() { return this.chunks.length; }

  chunkSpan(i) {
    const c = this.chunks[i];
    const last = this.segments[c.b - 1];
    return { start: this.segments[c.a].start, end: last.start + last.dur };
  }

  chunkAt(t) {
    return Math.max(0, sampleIndexAt(this.chunks.map((c) => this.segments[c.a].start), t));
  }

  // Decoded audio of chunk i: { start, end, rate, pcm } with pcm a mono Float32Array.
  async readChunk(i, signal, rate) {
    const sampleRate = rate || AUDIO_RATE;
    const chunk = this.chunks[i];
    if (!chunk) throw new Error('no chunk ' + i);
    const segs = this.segments.slice(chunk.a, chunk.b);
    if (this.init && !this.initBytes) this.initBytes = await fetchRange(this.init.url, this.init.offset, this.init.length, signal);
    // Adjacent byte ranges of the same file are fetched with one request.
    const reqs = [];
    for (const s of segs) {
      const prev = reqs[reqs.length - 1];
      if (prev && s.length !== null && prev.length !== null && prev.url === s.url && prev.offset + prev.length === s.offset) prev.length += s.length;
      else reqs.push({ url: s.url, offset: s.offset, length: s.length });
    }
    const parts = [];
    if (this.initBytes) parts.push(this.initBytes);
    for (const r of reqs) parts.push(await fetchRange(r.url, r.offset, r.length, signal));
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) { bytes.set(new Uint8Array(p), o); o += p.byteLength; }
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const t0 = performance.now();
    const ab = await new Offline(1, sampleRate, sampleRate).decodeAudioData(bytes.buffer);
    let pcm = ab.getChannelData(0);
    if (ab.numberOfChannels > 1) {
      pcm = Float32Array.from(pcm);
      for (let c = 1; c < ab.numberOfChannels; c++) {
        const ch = ab.getChannelData(c);
        for (let k = 0; k < pcm.length; k++) pcm[k] += ch[k];
      }
      for (let k = 0; k < pcm.length; k++) pcm[k] /= ab.numberOfChannels;
    }
    this.decodeMs = performance.now() - t0;   // usage data
    const last = segs[segs.length - 1];
    return { start: segs[0].start, end: last.start + last.dur, rate: ab.sampleRate, pcm };
  }
}

// ---- loudness envelope ----

// Speech-band level (roughly 150 Hz to 4 kHz, so air-conditioning rumble counts as quiet)
// per ENV_STEP seconds, stored as one byte: 0 = not analysed yet, 1..255 = -100..0 dBFS.
// The filter loop of fill() is timed for the usage data (a fixed step: the same
// arithmetic for every sample whatever the sound, see FIXED_STEPS in 87-telemetry.js).
// LOUD_STEP_V names that loop: change it whenever the loop changes.
const LOUD_STEP_V = 1;
class Envelope {
  constructor(duration, data) {
    this.step = ENV_STEP;
    this.length = Math.max(1, Math.ceil(duration / ENV_STEP));
    this.data = data && data.length === this.length ? data : new Uint8Array(this.length);
    this.carry = null;   // filter state where the last fill ended: { at: frame, hpIn, hpOut, lp }
  }

  known(i) { return this.data[i] !== 0; }

  db(i) {
    const v = this.data[i];
    return v ? -100 + (v - 1) / 2.54 : NaN;
  }

  dbAt(t) { return this.db(clamp(Math.floor(t / this.step), 0, this.length - 1)); }

  fill(start, pcm, rate) {
    const per = Math.round(rate * this.step);
    // One-pole high-pass and low-pass filters. A chunk that continues the one filled last
    // continues its filter state; any other starts from rest at its first sample (not from
    // zero, which would be a step at the chunk's start).
    const hpA = Math.exp(-2 * Math.PI * SPEECH_BAND_HZ[0] / rate);
    const lpA = Math.exp(-2 * Math.PI * SPEECH_BAND_HZ[1] / rate);
    const first = Math.round(start / this.step);
    const c = this.carry && this.carry.at === first ? this.carry : null;
    let hpPrevIn = c ? c.hpIn : pcm[0] || 0;
    let hpPrevOut = c ? c.hpOut : 0;
    let lp = c ? c.lp : 0;
    let f = 0;
    const t0 = performance.now();
    for (; (f + 1) * per <= pcm.length; f++) {
      const i = first + f;
      let sum = 0;
      for (let k = f * per, end = k + per; k < end; k++) {
        const x = pcm[k];
        const hp = hpA * (hpPrevOut + x - hpPrevIn);
        hpPrevIn = x;
        hpPrevOut = hp;
        lp = lp * lpA + hp * (1 - lpA);
        sum += lp * lp;
      }
      if (i < 0 || i >= this.length) continue;
      const db = 10 * Math.log10(sum / per + 1e-12);
      this.data[i] = 1 + Math.round((clamp(db, -100, 0) + 100) * 2.54);
    }
    if (f) usageStep('loud', LOUD_STEP_V, f * per, performance.now() - t0);
    this.carry = { at: first + f, hpIn: hpPrevIn, hpOut: hpPrevOut, lp };
  }

  coverage() {
    let n = 0;
    for (let i = 0; i < this.length; i++) if (this.data[i]) n++;
    return n / this.length;
  }

  // Share of frames analysed in [start, end).
  coverageOf(start, end) {
    const a = clamp(Math.floor(start / this.step), 0, this.length);
    const b = clamp(Math.ceil(end / this.step), a, this.length);
    let n = 0;
    for (let i = a; i < b; i++) if (this.data[i]) n++;
    return b > a ? n / (b - a) : 1;
  }
}

// ---- finding silence ----

function percentile(sorted, p) {
  return sorted[clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1)];
}

// Quiet stretches of an envelope. The threshold adapts to the recording: a point between
// its noise floor (10th percentile) and its speech level (90th percentile), so a recording
// that is quiet overall is not marked silent as a whole.
function findSilences(env, opts) {
  const o = Object.assign({ minSec: 30, sensitivity: 'normal', pad: SILENCE_PAD, bridge: SILENCE_BRIDGE }, opts);
  const vals = [];
  for (let i = 0; i < env.length; i++) if (env.known(i)) vals.push(env.db(i));
  const result = { silences: [], noiseDb: NaN, speechDb: NaN, thresholdDb: NaN };
  if (vals.length < 60 / env.step) return result; // less than a minute analysed
  vals.sort((a, b) => a - b);
  const noise = percentile(vals, SILENCE_NOISE_PCT);
  const speech = percentile(vals, SILENCE_SPEECH_PCT);
  const k = SILENCE_SENSITIVITY[o.sensitivity] || SILENCE_SENSITIVITY.normal;
  let thr = noise + (speech - noise) * k;
  // No dynamics at all: either everything is silent (a muted microphone) or nothing is.
  if (speech - noise < SILENCE_MIN_RANGE_DB) thr = speech < SILENCE_MUTED_DB ? 1 : -101;
  Object.assign(result, { noiseDb: noise, speechDb: speech, thresholdDb: thr });

  // Quiet runs in frames; unanalysed frames end a run.
  const runs = [];
  let a = -1;
  for (let i = 0; i <= env.length; i++) {
    const quiet = i < env.length && env.known(i) && env.db(i) < thr;
    if (quiet && a < 0) a = i;
    else if (!quiet && a >= 0) { runs.push([a, i]); a = -1; }
  }
  // Bridge a short louder blip (a cough, a door) between two long quiet runs. Quiet talk
  // also has short gaps between words, but there the quiet runs on either side are short,
  // so it stays speech.
  const bridge = Math.round(o.bridge / env.step);
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    let ok = prev && r[0] - prev[1] <= bridge && prev[1] - prev[0] >= 2 * bridge && r[1] - r[0] >= 2 * bridge;
    if (ok) for (let i = prev[1]; i < r[0]; i++) if (!env.known(i)) { ok = false; break; }
    if (ok) prev[1] = r[1]; else merged.push(r.slice());
  }
  for (const [s, e] of merged) {
    const start = s * env.step + o.pad;
    const end = Math.min(e * env.step, env.length * env.step) - o.pad;
    if (end - start >= o.minSec) result.silences.push({ start, end });
  }
  return result;
}

// Gaps of at least minSec between transcript cues (and before the first / after the last).
function silencesFromCues(cues, duration, opts) {
  const o = Object.assign({ minSec: 30, pad: SILENCE_PAD }, opts);
  const out = [];
  let lastEnd = 0;
  const gap = (a, b) => {
    const start = a + (a > 0 ? o.pad : 0);
    const end = b - o.pad;
    if (end - start >= o.minSec) out.push({ start, end });
  };
  for (const c of cues) {
    if (c.start > lastEnd) gap(lastEnd, c.start);
    lastEnd = Math.max(lastEnd, c.end);
  }
  if (isFinite(duration) && duration > lastEnd) gap(lastEnd, duration + o.pad);
  return out;
}

// Speech between the silences, split into pieces no longer than maxSec. A long piece is
// cut at the quietest analysed moment in the last half of each window.
function speechSpans(silences, duration, env, maxSec) {
  const spans = [];
  let t = 0;
  const push = (a, b) => {
    while (b - a > maxSec) {
      let cut = a + maxSec;
      if (env) {
        let best = Infinity;
        const from = Math.ceil((a + maxSec / 2) / env.step);
        const to = Math.min(Math.floor((a + maxSec) / env.step), env.length - 1);
        for (let i = from; i <= to; i++) {
          if (env.known(i) && env.db(i) < best) { best = env.db(i); cut = i * env.step; }
        }
      }
      spans.push({ start: a, end: cut });
      a = cut;
    }
    if (b > a) spans.push({ start: a, end: b });
  };
  for (const s of silences) {
    if (s.start > t) push(t, s.start);
    t = Math.max(t, s.end);
  }
  if (duration > t) push(t, duration);
  return spans;
}

// Index of the silence containing t, or -1. Silences are sorted and disjoint.
// Stretches that can be skipped, from silences and from stretches where the screen shows
// one colour (`uniform`, from the slide analysis):
//   kind 'silence'  silent, picture as usual
//   kind 'blank'    silent and the screen empty (at least half of the silence)
//   kind 'black'    the screen empty while nothing is known about the audio (no transcript,
//                   audio not analysed): marked and skippable by hand, never automatically.
// An empty screen with someone speaking is not skippable. Sorted by start.
/** @returns {SkipStretch[]} */
function skipStretches(silences, uniform, audioKnown, minSec) {
  const overlap = (a, b) => {
    let n = 0;
    for (const u of uniform) n += Math.max(0, Math.min(b, u.end) - Math.max(a, u.start));
    return n;
  };
  const out = silences.map((x) => ({ start: x.start, end: x.end, kind: overlap(x.start, x.end) >= 0.5 * (x.end - x.start) ? 'blank' : 'silence' }));
  if (!audioKnown) {
    for (const u of uniform) if (u.end - u.start >= minSec) out.push({ start: u.start, end: u.end, kind: 'black' });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Where the lecture's content ends: the start of an empty stretch (blank or black) that
// runs to the end of the recording (within `slack` seconds: by default one and a half
// chapter samples, as a stretch ends where its last sample does), else the duration.
function contentEndAt(stretches, duration, slack) {
  const last = stretches[stretches.length - 1];
  if (last && (last.kind === 'blank' || last.kind === 'black') && last.end >= duration - (slack == null ? 1.5 * CHAPTER_STEP_SEC : slack)) return last.start;
  return duration;
}

function silenceIndexAt(silences, t) {
  let lo = 0;
  let hi = silences.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (silences[mid].end <= t) lo = mid + 1;
    else if (silences[mid].start > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}

// ---- the controller used by the player ----

class SilenceAnalyzer {
  // opts: { lesson, video, masterUrl, disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.masterUrl = opts.masterUrl;
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('silence detection (display)', e); } };
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.source = 'pending';     // pending | transcript | audio | unavailable
    this.reason = '';
    this.progress = 0;
    this.silences = [];
    this.cues = null;
    this.track = null;
    this.env = null;
    this.options = { minSec: 30, sensitivity: 'normal' };
    this.stats = null;
    this.took = null;            // ms reading the audio took in this visit, when it read any (usage data)
  }

  setOptions(o) {
    Object.assign(this.options, o);
    this.recompute();
  }

  // Called once the transcript is known ([] when there is none).
  start(cues) {
    if (cues && cues.length && !store.get('silenceFromAudio', false)) {
      this.cues = cues;
      this.source = 'transcript';
      this.progress = 1;
      this.recompute();
      return;
    }
    if (!this.masterUrl) { this.fail('noAudio'); return; }
    this.source = 'audio';
    bgWork.track(this.runAudio()).catch((e) => {
      if (this.ac.signal.aborted) return;
      log.warn('silence analysis stopped:', e && e.message ? e.message : e);
      this.fail('error');
    });
  }

  // The analysis stopped. Silences already found from the audio are kept (and stay
  // cached); only when nothing was found is the feature unavailable.
  fail(reason) {
    this.reason = reason;
    if (this.env && this.env.coverage() > 0) { this.recompute(); return; }
    this.source = 'unavailable';
    this.silences = [];
    this.onChange();
  }

  recompute() {
    const dur = this.duration();
    if (this.source === 'transcript') {
      this.silences = silencesFromCues(this.cues, dur, { minSec: this.options.minSec });
    } else if (this.source === 'audio' && this.env) {
      const r = findSilences(this.env, this.options);
      this.silences = r.silences;
      this.stats = { noiseDb: r.noiseDb, speechDb: r.speechDb, thresholdDb: r.thresholdDb };
    } else return;
    this.onChange();
  }

  duration() {
    return mediaDuration(this.video, this.lesson);
  }

  async runAudio() {
    const signal = this.ac.signal;
    if (saveDataOn()) { this.fail('saveData'); return; }
    const key = 'silence-env:' + this.lesson.mediaId;
    const cached = this.lesson.mediaId ? await idbCache.get(key) : undefined;
    await this.gate.wait(cached ? 0 : SILENCE_START_DELAY_MS); // let playback start first
    const track = await new HlsAudioTrack(this.masterUrl).open(signal);
    this.track = track;
    const data = cacheValid('silence-env', cached) && cached.step === ENV_STEP ? cached.data : null;
    if (data) cacheTouch(key);
    if (this.lesson.mediaId) usageNote('cache', data ? 'hit' : 'miss');
    this.env = new Envelope(track.duration, data);
    this.progress = this.env.coverage();
    this.recompute();

    // Upcoming audio first, then the rest from the beginning.
    const n = track.chunkCount;
    const from = track.chunkAt(this.video.currentTime || 0);
    const order = [];
    for (let k = 0; k < n; k++) order.push((from + k) % n);
    let sinceSave = 0;
    let fails = 0;
    let read = 0;
    const t0 = performance.now();
    for (const i of order) {
      const span = track.chunkSpan(i);
      if (this.env.coverageOf(span.start, span.end) > 0.9) continue;
      await this.gate.turn(SILENCE_PACE_MS[0], SILENCE_PACE_MS[1], BG_MIN_BUFFER_SEC);
      // A chunk that cannot be read or decoded is left out (that stretch stays unknown,
      // never "silent"); only several in a row end the analysis, keeping what was found.
      let chunk;
      try {
        chunk = await track.readChunk(i, signal);
        fails = 0;
      } catch (e) {
        if (signal.aborted) return;
        if (++fails >= ANALYSIS_MAX_FAILS) { this.save(key); this.recompute(); throw e; }
        log.warn('silence detection: chunk ' + i + ' skipped:', e);
        continue;
      }
      await idle();
      if (signal.aborted) return;
      const f0 = performance.now();
      this.env.fill(chunk.start, chunk.pcm, chunk.rate);
      if (chunk.end > chunk.start) usageNote('work', 'silenceMin', (track.decodeMs + performance.now() - f0) / ((chunk.end - chunk.start) / 60));
      read++;
      this.progress = this.env.coverage();
      if (++sinceSave >= 5) {
        sinceSave = 0;
        this.save(key);
        this.recompute();
      }
    }
    this.progress = 1;
    if (read) this.took = Math.round(performance.now() - t0);
    this.save(key);
    this.recompute();
  }

  save(key) {
    if (this.lesson.mediaId) idbCache.put(key, { v: cacheVersion('silence-env'), used: Date.now(), step: ENV_STEP, data: this.env.data, at: Date.now() });
  }

}

// ---- 63-caches.js ----
// ===================================================================================
// Analysis caches in IndexedDB: slide chapters, silence envelopes, text read on screen.
//
// - Each kind has a version tied to its algorithm. A stored result with another version
//   was made by different code and is computed again (bump the number when changing how
//   results are made, not only their format).
// - Each record carries `used`, the last time it was used (its own field: records already
//   use names such as `at` for their data). A minute after a player starts,
//   records of these kinds that were not used for CACHE_KEEP_DAYS, or are from another
//   version, are deleted in the background.
// - Settings menu: how much space they take, and clearing them all.
// User data (tags, slide files, watched records) is not an analysis cache and is never
// pruned here.
// ===================================================================================

const CACHE_KINDS = {
  slides: 4,          // chapters (2: screen view chosen per recording, tolerant scanning; 3: uniform stretches; 4: 160 x 90, learnt threshold)
  'silence-env': 1,   // audio level envelope
  ocr: 1,             // text read on screen
};
const CACHE_KEEP_DAYS = 60;

function cacheKind(key) {
  const k = String(key).split(':')[0];
  return Object.prototype.hasOwnProperty.call(CACHE_KINDS, k) ? k : null;
}

function cacheVersion(kind) {
  return CACHE_KINDS[kind];
}

// Whether a stored record of `kind` can be used.
function cacheValid(kind, rec) {
  return !!rec && typeof rec === 'object' && rec.v === CACHE_KINDS[kind];
}

// The record with its last use set to now (nothing else changes).
function cacheTouched(rec, now) {
  return rec && typeof rec === 'object' ? Object.assign(rec, { used: now }) : rec;
}

// When a record was last used or, for records from before `used`, saved (ms, or 0).
function cacheLastUse(rec) {
  if (!rec || typeof rec !== 'object') return 0;
  for (const k of ['used', 'savedAt', 'at']) if (typeof rec[k] === 'number' && isFinite(rec[k])) return rec[k];
  return 0;
}

// Marks a record as used now (keeps it from being pruned).
function cacheTouch(key) {
  idbCache.update(key, (rec) => cacheTouched(rec, Date.now())).catch(() => {});
}

// Rough size of a stored value in bytes (Blobs by their size, the rest as JSON).
function approxSize(v) {
  if (v instanceof Blob) return v.size;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (Array.isArray(v)) return v.reduce((s, x) => s + approxSize(x), 0) + 2;
  if (v && typeof v === 'object') {
    let s = 2;
    for (const [k, x] of Object.entries(v)) s += k.length + 3 + approxSize(x);
    return s;
  }
  return String(v).length + 1;
}

const analysisCaches = {
  async keys() {
    return (await idbCache.keys()).filter((k) => cacheKind(k));
  },

  // { count, bytes } of all analysis caches.
  async usage() {
    let bytes = 0;
    const keys = await this.keys();
    for (const k of keys) bytes += approxSize(await idbCache.get(k));
    return { count: keys.length, bytes };
  },

  async clear() {
    const keys = await this.keys();
    for (const k of keys) await idbCache.del(k);
    return keys.length;
  },

  // Deletes records unused for CACHE_KEEP_DAYS or from another algorithm version.
  async prune() {
    const old = Date.now() - CACHE_KEEP_DAYS * 864e5;
    let n = 0;
    for (const k of await this.keys()) {
      const rec = await idbCache.get(k);
      if (!cacheValid(cacheKind(k), rec) || !(cacheLastUse(rec) > old)) { await idbCache.del(k); n++; }
    }
    if (n) log.info('removed ' + n + ' old analysis results');
    return n;
  },
};

// ---- 64-slides.js ----
// ===================================================================================
// Slide chapters: find where the screen view changes to a new slide.
//
// Sources, best first:
//   1. Chapter or slide data from Echo360 itself. None of the recordings checked so far had
//      any (cfg.chapters, slide decks and scenes were all empty), so this is not used yet.
//   2. Keyframes of the screen view. Every HLS segment starts with a keyframe; reading just
//      the start of a segment every CHAPTER_STEP_SEC (about 20 KB at 360p, 15 MB for two
//      hours) and decoding it with WebCodecs gives the whole lecture at that resolution.
//      Each change is then pinned to about 1 s by decoding the stretch it happened in.
//      Downloads only run while playback has enough buffer, and the result is cached in
//      IndexedDB.
//   3. Echo360's preview thumbnails (one per minute), when WebCodecs is not available.
//      They are also shown at once while the keyframes are being read.
//
// Which view is the screen: slides, code and documents have large flat areas, camera
// pictures do not (sensor noise), so the view with the most flat area is used.
//
// Change detection compares 160 x 90 brightness pictures. How large a change makes a new
// picture is learnt per recording from its own changes (see learnThreshold): ink, a pointer
// or scrolling code change fewer pixels than another slide, but how many fewer depends on
// the lecturer, the slides and the recording, so no fixed share is used. A run of quick
// changes (scrolling code, flicking through slides) becomes one chapter instead of many,
// and a short look elsewhere that comes back joins the chapter (see buildScenes).
//
// Reusable pieces:
//   HlsVideoReader   open(), segments, segmentAt(t), sampleSegments(step),
//                    keyframe(i) -> VideoFrame, frames(i, stepSec, onFrame)
//   lumaThumb(g, img), frameLuma(img), thumbChange(a, b), learnThreshold(changes)
//   buildScenes(samples, duration, opts) -> [{ start, end, rep, first }]
//   SlideAnalyzer    chapters: [{ start, end, precise, repTime, thumb }], screenIndex,
//                    lumaAt(t) (shared with the slide reader)
// ===================================================================================


// ---- fragmented MP4 ----

function mp4Boxes(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr) break;
    out.push({ type, start: p, body: p + hdr, end: Math.min(p + size, end), size });
    p += size;
  }
  return out;
}

function mp4Find(dv, start, end, path) {
  let box = { body: start, end };
  for (const type of path) {
    box = mp4Boxes(dv, box.body, box.end).find((b) => b.type === type);
    if (!box) return null;
  }
  return box;
}

// Init segment of an H.264 track -> what VideoDecoder.configure() needs.
function parseVideoInit(buf) {
  const dv = new DataView(buf);
  const stsd = mp4Find(dv, 0, dv.byteLength, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  const mdhd = mp4Find(dv, 0, dv.byteLength, ['moov', 'trak', 'mdia', 'mdhd']);
  if (!stsd || !mdhd) throw new Error('unexpected init segment');
  const entry = mp4Boxes(dv, stsd.body + 8, stsd.end)[0];
  if (!entry || (entry.type !== 'avc1' && entry.type !== 'avc3')) throw new Error('not H.264: ' + (entry && entry.type));
  const avcC = mp4Boxes(dv, entry.body + 78, entry.end).find((b) => b.type === 'avcC');
  if (!avcC) throw new Error('no avcC');
  const hex = (o) => dv.getUint8(avcC.body + o).toString(16).padStart(2, '0');
  const v = dv.getUint8(mdhd.body);
  return {
    codec: entry.type + '.' + hex(1) + hex(2) + hex(3),
    description: new Uint8Array(buf.slice(avcC.body, avcC.end)),
    timescale: dv.getUint32(mdhd.body + (v ? 20 : 12)),
    width: dv.getUint16(entry.body + 24),
    height: dv.getUint16(entry.body + 26),
  };
}

// Samples of the first track fragment, in decode order: [{ offset, size, time, key }] with
// offsets relative to the start of `buf` and time in timescale units (presentation time).
// Samples whose bytes are not in `buf` are still listed (the caller checks the size).
function parseFragment(buf, segmentOffset) {
  const dv = new DataView(buf);
  const moof = mp4Boxes(dv, 0, dv.byteLength).find((b) => b.type === 'moof');
  if (!moof) throw new Error('no moof');
  const traf = mp4Find(dv, moof.body, moof.end, ['traf']);
  const kids = mp4Boxes(dv, traf.body, traf.end);
  const tfhd = kids.find((b) => b.type === 'tfhd');
  const tfdt = kids.find((b) => b.type === 'tfdt');
  const trun = kids.find((b) => b.type === 'trun');
  if (!tfhd || !trun) throw new Error('unexpected fragment');
  const hf = dv.getUint32(tfhd.body) & 0xffffff;
  let p = tfhd.body + 8;
  let base = moof.start;
  if (hf & 0x1) { base = Number(dv.getBigUint64(p)) - (segmentOffset || 0); p += 8; }
  if (hf & 0x2) p += 4;
  let defDur = 0;
  let defSize = 0;
  let defFlags = 0;
  if (hf & 0x8) { defDur = dv.getUint32(p); p += 4; }
  if (hf & 0x10) { defSize = dv.getUint32(p); p += 4; }
  if (hf & 0x20) { defFlags = dv.getUint32(p); p += 4; }
  let t = 0;
  if (tfdt) t = dv.getUint8(tfdt.body) ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);
  const rf = dv.getUint32(trun.body) & 0xffffff;
  const version = dv.getUint8(trun.body);
  const count = dv.getUint32(trun.body + 4);
  p = trun.body + 8;
  let offset = base;
  if (rf & 0x1) { offset = base + dv.getInt32(p); p += 4; }
  let firstFlags = null;
  if (rf & 0x4) { firstFlags = dv.getUint32(p); p += 4; }
  // Each listed field takes four bytes per sample: the count must fit in the box.
  const fieldBytes = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => rf & f).length;
  if (count > MP4_MAX_SAMPLES || count * fieldBytes > trun.end - p) throw new Error('bad sample count: ' + count);
  const samples = [];
  for (let i = 0; i < count; i++) {
    let dur = defDur;
    let size = defSize;
    let flags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
    let cto = 0;
    if (rf & 0x100) { dur = dv.getUint32(p); p += 4; }
    if (rf & 0x200) { size = dv.getUint32(p); p += 4; }
    if (rf & 0x400) { flags = dv.getUint32(p); p += 4; }
    if (rf & 0x800) { cto = version ? dv.getInt32(p) : dv.getUint32(p); p += 4; }
    // sample_is_non_sync_sample is bit 16 of the flags.
    samples.push({ offset, size, time: t + cto, key: !(flags & 0x10000) });
    offset += size;
    t += dur;
  }
  return { samples, end: offset };
}

// ---- reading frames from an HLS video stream ----

// Variant URIs of a master playlist with their heights, lowest first.
function videoVariants(master, base) {
  return parseMaster(master).variants.filter((x) => x.uri).map(({ attrs: a, uri }) => ({
    uri: new URL(uri, base).href, height: a.RESOLUTION ? +a.RESOLUTION.split('x')[1] : 0, bandwidth: +a.BANDWIDTH || 0,
  })).sort((x, y) => x.height - y.height || x.bandwidth - y.bandwidth);
}

// H.264 from an MP4 comes as length-prefixed NAL units, with the parameter sets (SPS, PPS) in
// the avcC record given to the decoder as its description. Safari on iOS 17 accepts that
// configuration for Echo360's streams yet decodes nothing from it (no picture, no error, for
// a single keyframe; "Decoder failure" for a whole segment), while the same samples in Annex
// B form (start codes, parameter sets in-line, no description) decode (measured on iOS 17.5,
// 2026-10-17). These turn one form into the other.

// The avcC record: the size of the NAL length fields and the parameter sets, SPS first.
function avcConfig(description) {
  const d = description instanceof Uint8Array ? description : new Uint8Array(description);
  if (d.length < 7 || d[0] !== 1) throw new Error('not an avcC record');
  const sets = [];
  let i = 5;
  for (const mask of [0x1f, 0xff]) {
    const count = d[i++] & mask;
    for (let k = 0; k < count; k++) {
      const n = (d[i] << 8) | d[i + 1];
      if (!(i + 2 + n <= d.length)) throw new Error('not an avcC record');
      sets.push(d.subarray(i + 2, i + 2 + n));
      i += 2 + n;
    }
  }
  return { lengthSize: (d[4] & 3) + 1, sets };
}

// One sample in Annex B form; a keyframe starts with the parameter sets.
function toAnnexB(data, avc, key) {
  const parts = key ? avc.sets.slice() : [];
  const L = avc.lengthSize;
  for (let o = 0; o < data.length;) {
    let n = 0;
    for (let j = 0; j < L; j++) n = n * 256 + data[o + j];
    if (!(o + L + n <= data.length)) throw new Error('bad H.264 sample');
    parts.push(data.subarray(o + L, o + L + n));
    o += L + n;
  }
  const out = new Uint8Array(parts.reduce((a, x) => a + 4 + x.length, 0));
  let at = 0;
  for (const x of parts) {
    out[at + 3] = 1;   // start code 00 00 00 01
    out.set(x, at + 4);
    at += 4 + x.length;
  }
  return out;
}

class HlsVideoReader {
  // maxHeight: the tallest rendition to use (the smallest one if none is small enough).
  // minHeight (optional): use the smallest rendition at least this tall instead (the
  // tallest one if none is).
  constructor(masterUrl, maxHeight, minHeight) {
    this.masterUrl = masterUrl;
    this.maxHeight = maxHeight || 360;
    this.minHeight = minHeight || 0;
    this.segments = [];
    this.info = null;
    this.bytes = 0;          // downloaded so far
    this.lastNeed = 0;       // bytes the last keyframe needed (header included)
    this.decodeMs = 0;       // how long decoding the last keyframe took, with onFrame (usage data)
    this.avc = null;         // set when the samples go to the decoder in Annex B form (avcConfig)
    this.form = null;        // which form gave pictures (decodeAny; usage data)
  }

  static supported() {
    return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
  }

  async open(signal) {
    const master = await (await fetchOk(this.masterUrl, { signal })).text();
    let url = this.masterUrl;
    if (/#EXT-X-STREAM-INF/.test(master)) {
      const vs = videoVariants(master, this.masterUrl);
      let pick;
      if (this.minHeight) {
        pick = vs.find((v) => v.height >= this.minHeight) || vs[vs.length - 1];
      } else {
        const fit = vs.filter((v) => v.height && v.height <= this.maxHeight);
        pick = fit.length ? fit[fit.length - 1] : vs[0];
      }
      if (!pick) throw new Error('no video variant');
      url = pick.uri;
    }
    const pl = parseMediaPlaylist(await (await fetchOk(url, { signal })).text(), url);
    if (!pl.init || !pl.segments.length || pl.segments.some((s) => s.length === null)) throw new Error('unsupported playlist layout');
    this.segments = pl.segments;
    const init = await fetchRange(pl.init.url, pl.init.offset, pl.init.length, signal);
    this.info = parseVideoInit(init);
    const cfg = { codec: this.info.codec, description: this.info.description };
    const ok = await VideoDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (!ok.supported) throw new Error('decoder not supported: ' + this.info.codec);
    const last = this.segments[this.segments.length - 1];
    this.duration = last.start + last.dur;
    return this;
  }

  segmentAt(t) {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // Segments to sample about every stepSec seconds: [segment index] (the keyframe of each
  // segment is at its start).
  sampleSegments(stepSec) {
    const out = [];
    let next = -Infinity;
    this.segments.forEach((sg, i) => {
      if (sg.start + sg.dur / 2 < next) return;
      out.push(i);
      next = sg.start + stepSec;
    });
    return out;
  }

  // Decodes samples ({ type, timestamp, data }); onFrame(frame) is called in presentation
  // order and the frame is closed right after it returns.
  async decode(samples, onFrame) {
    let failed = null;
    const dec = new VideoDecoder({
      output: (frame) => { try { if (!failed) onFrame(frame); } catch (e) { failed = e; } finally { frame.close(); } },
      error: (e) => { failed = failed || e; },
    });
    try {
      const avc = this.avc;
      dec.configure(avc ? { codec: this.info.codec, optimizeForLatency: true } : { codec: this.info.codec, description: this.info.description, optimizeForLatency: true });
      for (const x of samples) dec.decode(new EncodedVideoChunk({ type: x.type, timestamp: x.timestamp, data: avc ? toAnnexB(x.data, avc, x.type === 'key') : x.data }));
      await dec.flush();
    } finally {
      if (dec.state !== 'closed') dec.close();
    }
    if (failed) throw failed;
  }

  // decode(), and when the decoder gives no picture at all from the samples as they are
  // (Safari, see avcConfig), once more in Annex B form; this reader then keeps that form.
  // Only while the samples as they are never gave a picture: after that, a segment without
  // one is a bad segment, not the wrong form.
  // this.form (usage data): 'avcc' | 'annexb', the form that gave pictures; 'neither'; null
  // before the first decode.
  async decodeAny(samples, onFrame) {
    let n = 0;
    const count = (f) => { n++; onFrame(f); };
    let error = null;
    try { await this.decode(samples, count); } catch (e) { error = e; }
    if (n) this.form = this.avc ? 'annexb' : 'avcc';
    if (n || this.avc || this.form === 'avcc') { if (error) throw error; return; }
    this.avc = avcConfig(this.info.description);
    this.form = 'neither';
    await this.decode(samples, count);
    if (n) this.form = 'annexb';
  }

  // First frame of segment i: fn(frame, seconds) is called once.
  async keyframe(i, signal, fn) {
    const s = this.segments[i];
    // Bytes from the start of the segment, fetching only what is still missing.
    let buf = new ArrayBuffer(0);
    const upTo = async (n) => {
      const want = Math.min(s.length, n);
      if (want <= buf.byteLength) return;
      const more = await fetchRange(s.url, s.offset + buf.byteLength, want - buf.byteLength, signal);
      if (!more.byteLength) throw new Error('empty answer for a segment range'); // asked again, it would loop
      this.bytes += more.byteLength;
      const all = new Uint8Array(buf.byteLength + more.byteLength);
      all.set(new Uint8Array(buf), 0);
      all.set(new Uint8Array(more), buf.byteLength);
      buf = all.buffer;
    };
    // The fragment header and the keyframe come first; their size is only known once the
    // header is read. Ask for a little more than the last keyframe needed (keyframes of one
    // stream are of similar size), the first time for just the start of the header, then
    // for whatever is still missing: a wrong guess costs a request, never a wrong result.
    await upTo(this.lastNeed ? Math.round(this.lastNeed * 1.25) : 4096);
    for (;;) {
      const boxes = mp4Boxes(new DataView(buf), 0, buf.byteLength);
      const moof = boxes.find((x) => x.type === 'moof');
      const last = boxes[boxes.length - 1];
      const end = moof ? moof.start + moof.size : last ? last.start + last.size + 8 : 8;
      if (end <= buf.byteLength || buf.byteLength >= s.length) break;
      await upTo(end);
    }
    const frag = parseFragment(buf, s.offset);
    const k = frag.samples[0];
    if (!k || !k.key) throw new Error('segment does not start with a keyframe');
    this.lastNeed = k.offset + k.size;
    await upTo(k.offset + k.size);
    const ts = this.info.timescale;
    const sample = { type: 'key', timestamp: Math.round((k.time / ts) * 1e6), data: new Uint8Array(buf, k.offset, k.size) };
    let got = false;
    const t0 = performance.now();
    await this.decodeAny([sample], (f) => { if (!got) { got = true; fn(f, k.time / ts); } });
    this.decodeMs = performance.now() - t0;
    if (!got) throw new Error('no frame decoded');
  }

  // Every frame of segment i at least stepSec apart: fn(frame, seconds).
  async frames(i, stepSec, signal, fn) {
    const s = this.segments[i];
    const buf = await fetchRange(s.url, s.offset, s.length, signal);
    const frag = parseFragment(buf, s.offset);
    const ts = this.info.timescale;
    const samples = frag.samples
      .filter((x) => x.offset + x.size <= buf.byteLength)
      .map((x, j) => ({ type: j === 0 || x.key ? 'key' : 'delta', timestamp: Math.round((x.time / ts) * 1e6), data: new Uint8Array(buf, x.offset, x.size) }));
    let next = -Infinity;
    await this.decodeAny(samples, (f) => {
      const t = f.timestamp / 1e6;
      if (t + 1e-6 < next) return;
      next = t + stepSec;
      fn(f, t);
    });
  }
}

// ---- comparing frames ----
//
// Frames are compared as 160 x 90 brightness pictures (one pixel is a 2 x 2 block at 360p,
// 8 x 8 at 720p): fine enough that a changed line of slide text changes several pixels.


// Brightness of a frame at THUMB_W x THUMB_H, drawn with the 2D context g.
// The conversion loop is timed for the usage data (a fixed step: the same arithmetic for
// every pixel whatever the picture, see FIXED_STEPS in 87-telemetry.js). LUMA_STEP_V
// names this loop: change it whenever the loop changes, so that timings of different
// code are never compared.
const LUMA_STEP_V = 1;
function lumaThumb(g, img) {
  g.drawImage(img, 0, 0, THUMB_W, THUMB_H);
  const d = g.getImageData(0, 0, THUMB_W, THUMB_H).data;
  const out = new Uint8Array(THUMB_W * THUMB_H);
  const t0 = performance.now();
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  usageStep('luma', LUMA_STEP_V, out.length, performance.now() - t0);
  return out;
}

let thumbCtx = null;
function thumbContext() {
  if (!thumbCtx) {
    const c = makeCanvas(THUMB_W, THUMB_H);
    thumbCtx = c.getContext('2d', { willReadFrequently: true });
  }
  return thumbCtx;
}

// Brightness picture of any drawable (VideoFrame, ImageBitmap, <video>, <img>).
function frameLuma(img) {
  return lumaThumb(thumbContext(), img);
}

// Pixels of two brightness pictures that differ by more than PIXEL_DIFF. Stops counting
// at `limit` (the caller only needs to know whether that many changed).
function thumbChange(a, b, limit) {
  const stop = limit || Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_DIFF && ++n >= stop) break;
  return n;
}

// Share of pixels (0-1) of two brightness pictures that changed a little: more than
// STILL_LEVELS (the same picture encoded again), at most PIXEL_DIFF (a real edge moving).
// Sensor noise and movement in a camera picture; next to nothing on a still screen.
function slightChange(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > STILL_LEVELS && d <= PIXEL_DIFF) n++;
  }
  return n / a.length;
}

// The change of each sample against the last earlier sample that differed visibly from the
// one before it (so that slow changes, ink added a little at a time, still add up), in
// changed pixels; 0 for the first. samples: [{ luma }], sets sample.change; only samples
// from `from` on are computed (earlier ones keep theirs).
function sampleChanges(samples, from) {
  let ref = null;
  for (let k = Math.max(0, (from || 0) - 1); k >= 0 && !ref; k--) if (k === 0 || samples[k].change >= SAME_TEXT_MAX) ref = samples[k].luma;
  for (let k = from || 0; k < samples.length; k++) {
    const s = samples[k];
    if (!ref) { s.change = 0; ref = s.luma; continue; }
    s.change = thumbChange(ref, s.luma);
    if (s.change >= SAME_TEXT_MAX) ref = s.luma;
  }
}

// How many changed pixels make a new picture, learnt from this recording: its visible
// changes (SAME_TEXT_MAX or more) split into two groups (small: ink, scrolling, a pointer;
// large: another slide or program) at the point that separates them best (Otsu's method,
// on the logarithm, since the sizes span orders of magnitude). Samples without a visible
// change are left out: they say nothing about the split and, being most of a lecture,
// would pull it down to ink level (checked on four lectures: the same changes found, a
// sixth to a quarter fewer false ones). With fewer than two different visible changes
// there is nothing to split, and every visible change counts as a new picture.
function learnThreshold(changes) {
  const v = changes.filter((c) => c >= SAME_TEXT_MAX).map((c) => Math.log1p(c)).sort((a, b) => a - b);
  const n = v.length;
  let total = 0;
  for (const x of v) total += x;
  let best = -1;
  let cut = Infinity;
  let left = 0;
  for (let i = 1; i < n; i++) {
    left += v[i - 1];
    if (v[i] === v[i - 1]) continue;
    const ma = left / i;
    const mb = (total - left) / (n - i);
    const score = i * (n - i) * (mb - ma) ** 2;
    if (score > best) { best = score; cut = (v[i - 1] + v[i]) / 2; }
  }
  return cut === Infinity ? SAME_TEXT_MAX : Math.expm1(cut);
}

// Mean brightness of 5 x 5 blocks: a 32 x 18 version of a brightness picture.
function lumaBlocks(luma) {
  const W = THUMB_W / 5;
  const H = THUMB_H / 5;
  const out = new Float32Array(W * H);
  for (let y = 0; y < THUMB_H; y++) for (let x = 0; x < THUMB_W; x++) out[((y / 5) | 0) * W + ((x / 5) | 0)] += luma[y * THUMB_W + x] / 25;
  return out;
}

// A picture of (almost) one colour: a black screen, a "no signal" picture, a blank slide in
// one colour. Judged by evenness, not darkness, so any kind of empty picture counts: nearly
// every block of a 32 x 18 version is within noise of the median brightness (UNIFORM_*).
function frameUniform(luma) {
  const l = lumaBlocks(luma);
  const n = l.length;
  const sorted = Float32Array.from(l).sort();
  const med = sorted[n >> 1];
  let close = 0;
  for (let i = 0; i < n; i++) if (Math.abs(l[i] - med) <= UNIFORM_NOISE) close++;
  return close >= UNIFORM_SHARE * n;
}

// Stretches of uniform samples: [{ start, end }] (a stretch ends where the next sample starts).
function uniformStretches(samples, duration) {
  const out = [];
  for (let k = 0; k < samples.length; k++) {
    if (!samples[k].uniform) continue;
    const end = k + 1 < samples.length ? samples[k + 1].t : duration;
    const last = out[out.length - 1];
    if (last && last.end >= samples[k].t - 0.01) last.end = end; else out.push({ start: samples[k].t, end });
  }
  return out;
}

// Share of pixels that equal their right and lower neighbours: high for slides and code,
// low for camera pictures.
function flatShare(img) {
  const W = 160;
  const H = 90;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  let n = 0;
  let tot = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      const l = d[i] + d[i + 1] + d[i + 2];
      tot++;
      if (Math.abs(l - d[i + 4] - d[i + 5] - d[i + 6]) <= FLAT_LEVELS && Math.abs(l - d[i + W * 4] - d[i + W * 4 + 1] - d[i + W * 4 + 2]) <= FLAT_LEVELS) n++;
    }
  }
  return n / tot;
}

// ---- scenes ----

// samples: [{ t, luma, change }] in time order (see sampleChanges). Returns scenes
// [{ start, end, rep }] where rep is the sample that best shows the chapter: the last sample
// (ink and builds are complete there) of the view it stays on longest. A scene starts at
// its first sample; refinement moves it earlier.
//
// opts.threshold: changed pixels that make a new picture (default: learnt from the samples).
// opts.single: merge chapters of a single sample (default true; off for samples a minute
// apart, where one sample is a long stretch).
//
// 1. Runs: a new run starts where a sample changed by the threshold or more.
// 2. A run that starts with a picture already shown in the current chapter (back to the
//    slide after a look at the editor) continues the chapter.
// 3. A look elsewhere between two stays on the same picture, no longer than either of them,
//    joins them into one chapter (a short demo, then back to the slide; flicking between a
//    slide and a question board).
// 4. A chapter of a single sample is shorter than the sampling can tell apart: several in a
//    row (flicking through slides, scrolling) are one chapter, a lone one (a transition
//    caught half way) joins the next.
// All lengths are relative to each other or to the sampling step: no fixed durations.
function buildScenes(samples, duration, opts) {
  const o = Object.assign({ single: true }, opts);
  if (!samples.length) return [];
  if (samples.some((s) => s.change == null)) sampleChanges(samples);
  const thr = o.threshold != null ? o.threshold : learnThreshold(samples.slice(1).map((s) => s.change));
  const tAt = (k) => (k < samples.length ? samples[k].t : duration);
  const same = (i, j) => thumbChange(samples[i].luma, samples[j].luma, thr) < thr;
  // 1. Runs of the same picture.
  const runs = [{ a: 0, b: 0 }];
  for (let k = 1; k < samples.length; k++) {
    if (samples[k].change < thr) runs[runs.length - 1].b = k;
    else runs.push({ a: k, b: k });
  }
  // A chapter's pictures: the first and last sample of each of its runs.
  const shows = (ch, k) => ch.runs.some((r) => same(r.a, k) || (r.b !== r.a && same(r.b, k)));
  const len = (ch) => tAt(ch.b + 1) - samples[ch.a].t;
  // 2. Chapters; a return within the current chapter continues it.
  let chs = [];
  for (const r of runs) {
    const cur = chs[chs.length - 1];
    if (cur && shows(cur, r.a)) { cur.b = r.b; cur.runs.push(r); } else chs.push({ a: r.a, b: r.b, runs: [r] });
  }
  // 3. Short looks elsewhere between two stays on the same picture.
  for (let i = 1; i + 1 < chs.length; i++) {
    const [x, y, z] = [chs[i - 1], chs[i], chs[i + 1]];
    if (len(y) <= len(x) && len(y) <= len(z) && shows(x, z.a)) {
      chs.splice(i - 1, 3, { a: x.a, b: z.b, runs: x.runs.concat(y.runs, z.runs) });
      i = Math.max(0, i - 2);
    }
  }
  // 4. Chapters of one sample.
  if (o.single) {
    const out = [];
    const one = (ch) => ch.a === ch.b;
    for (let i = 0; i < chs.length; i++) {
      const ch = { a: chs[i].a, b: chs[i].b, runs: chs[i].runs.slice() };
      const absorb = (x) => { ch.b = x.b; ch.runs.push(...x.runs); };
      if (one(ch)) {
        let j = i;
        while (j + 1 < chs.length && one(chs[j + 1])) j++;
        if (j > i) { for (let q = i + 1; q <= j; q++) absorb(chs[q]); i = j; } else if (i + 1 < chs.length) { absorb(chs[i + 1]); i++; }
      }
      out.push(ch);
    }
    chs = out;
  }
  return chs.map((ch, i) => {
    let best = ch.runs[0];
    for (const x of ch.runs) if (tAt(x.b + 1) - samples[x.a].t >= tAt(best.b + 1) - samples[best.a].t) best = x;
    return {
      start: i === 0 ? 0 : samples[ch.a].t,
      end: i + 1 < chs.length ? samples[chs[i + 1].a].t : duration,
      rep: best.b,
      first: ch.a,
    };
  });
}

// Index of the last of the ascending times that is at or before t (-1 if none).
function sampleIndexAt(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return k;
}

function chapterIndexAt(chapters, t) {
  let lo = 0;
  let hi = chapters.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chapters[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return k;
}

// A small copy of a frame, made synchronously (a VideoFrame is only valid in its callback),
// in the frame's own shape (a 4:3 screen stays 4:3).
function smallBitmap(img, w) {
  const iw = img.displayWidth || img.width || 16;
  const ih = img.displayHeight || img.height || 9;
  const c = makeCanvas(w, Math.max(1, Math.round((w * ih) / iw)));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function bitmapToBlob(canvas) {
  return canvasBlob(canvas, 'image/jpeg', 0.8);
}

// The screen among scored views [{ vals, ... }] (see findScreen): the one with the lowest
// (lowerIsScreen) or highest median; sure if every view was scored and the chosen one's
// values beat each other view's in SCREEN_CLEARLY of all pairs. { best, sure }.
function pickScreen(scored, lowerIsScreen, viewCount) {
  const median = (v) => { const a = v.slice().sort((x, y) => x - y); return (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2; };
  // Share of pairs in which a value of `a` is above one of `b` (ties count half).
  const above = (a, b) => {
    let w = 0;
    for (const x of a) for (const y of b) w += x > y ? 1 : x === y ? 0.5 : 0;
    return w / (a.length * b.length);
  };
  const order = scored.slice().sort((a, b) => (lowerIsScreen ? median(a.vals) - median(b.vals) : median(b.vals) - median(a.vals)));
  const best = order[0];
  const sure = order.length === viewCount && order.slice(1).every((o) => (lowerIsScreen ? above(o.vals, best.vals) : above(best.vals, o.vals)) >= SCREEN_CLEARLY);
  return { best, sure };
}

// ---- the controller used by the player ----

// Why a keyframe scan stopped, as a short code for the usage data (never the message itself).
const STOP_REASONS = ['noWebCodecs', 'noFrame', 'decoder', 'playlist', 'network', 'other'];
function stopReason(e) {
  const m = String((e && e.message) || e || '');
  return /no frame decoded/.test(m) ? 'noFrame'
    : /decoder not supported|Decod|EncodingError|OperationError/i.test(m) || (e && /^(EncodingError|OperationError|NotSupportedError)$/.test(e.name)) ? 'decoder'
      : /playlist|variant|keyframe/.test(m) ? 'playlist'
        : /fetch|network|HTTP|\b[45]\d\d\b|Load failed/i.test(m) ? 'network' : 'other';
}

class SlideAnalyzer {
  // opts: { lesson, video, disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('slide chapters (display)', e); } };
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.state = 'pending';   // pending | thumbnails | keyframes | done | unavailable
    this.progress = 0;
    /** @type {Chapter[]} */
    this.chapters = [];
    this.uniform = [];       // stretches where the screen shows (almost) one colour
    this.screenIndex = null;
    this.guessScreen = null;
    this.screenSure = true;     // false: the views did not differ clearly (the screen is a guess)
    this.manualScreen = null;   // the view the user chose, if any
    this.took = null;           // ms the whole analysis took in this visit (usage data; null: from the cache)
    this.source = null;         // what the chapters come from: 'frames' (the video's keyframes) | 'thumbs' (preview pictures only)
    this.stopped = null;        // why the keyframe scan stopped early, if it did (usage data, STOP_REASONS)
    this.reader = null;         // the reader of the keyframe scan in this visit (its form: usage data; dev/chap-run.mjs)
    this.urls = [];
    this.d.add(() => { for (const u of this.urls) URL.revokeObjectURL(u); this.urlOf = null; });
  }

  // Each run has its own signal and gate: a run replaced by chooseScreen stops at its next
  // step and never writes into the new one's results.
  start() {
    const signal = this.ac.signal;
    bgWork.track(this.run(signal, this.gate)).catch((e) => {
      if (signal.aborted) return;
      log.warn('slide detection stopped:', e && e.message ? e.message : e);
      this.stopped = stopReason(e);
      // The preview pictures' chapters stay, as the answer: nothing more is coming.
      if (this.chapters.length && this.state === 'thumbnails') { this.state = 'done'; this.progress = 1; }
      else if (!this.chapters.length) this.state = 'unavailable';
      this.onChange();
    });
  }

  duration() {
    return mediaDuration(this.video, this.lesson);
  }

  thumbUrl(blob) {
    if (!this.urlOf) this.urlOf = new Map();
    let u = this.urlOf.get(blob);
    if (!u) {
      u = URL.createObjectURL(blob);
      this.urlOf.set(blob, u);
      this.urls.push(u);
    }
    return u;
  }

  // Lets go of pictures no chapter shows any more (chapters are rebuilt while scanning).
  pruneThumbs() {
    if (!this.urlOf) return;
    const used = new Set(this.chapters.map((c) => c.blob).filter(Boolean));
    for (const [blob, u] of this.urlOf) {
      if (used.has(blob)) continue;
      URL.revokeObjectURL(u);
      this.urlOf.delete(blob);
    }
    this.urls = [...this.urlOf.values()];
  }

  async run(signal, gate) {
    this.reason = null;   // why the analysis is unavailable, if it says ('saveData')
    const key = 'slides:' + this.lesson.mediaId;
    const id = this.lesson.mediaId;
    const pick = id ? await idbCache.get('screenpick:' + id) : null;
    this.manualScreen = pick && this.lesson.sources.some((x) => x.index === pick.index) ? pick.index : null;
    const cached = id ? await idbCache.get(key) : undefined;
    if (signal.aborted) return;
    // A result for another view than the one chosen by hand is made again.
    const hit = cacheValid('slides', cached) && Array.isArray(cached.chapters) && (this.manualScreen == null || cached.screen === this.manualScreen);
    if (id) usageNote('cache', hit ? 'hit' : 'miss');
    if (hit) {
      cacheTouch(key);
      this.uniform = Array.isArray(cached.uniform) ? cached.uniform : [];
      this.screenIndex = cached.screen;
      this.screenSure = cached.sure !== false;
      this.chapters = cached.chapters.map((c) => Object.assign({}, c, { thumb: c.blob ? this.thumbUrl(c.blob) : c.thumb }));
      this.source = 'frames';   // only the keyframe scan's results are stored
      this.state = 'done';
      this.progress = 1;
      this.onChange();
      return;
    }
    // Data Saver: no downloads at all (finding the screen view already reads keyframes or
    // preview pictures); only a stored result is used.
    if (saveDataOn()) { this.reason = 'saveData'; this.state = 'unavailable'; this.onChange(); return; }
    const t0 = performance.now();
    // Which view is the screen is needed early (quality settings are per view).
    const screen = await this.findScreen(signal);
    if (signal.aborted) return;
    if (!screen) { this.state = 'unavailable'; this.onChange(); return; }
    this.screenIndex = screen.source.index;
    this.screenSure = screen.sure;
    this.onChange();
    await gate.wait(BG_START_DELAY_MS); // let playback start first
    if (screen.thumbs) this.fromThumbnails(screen.thumbs, signal, gate);
    // Without WebCodecs (Safari before 16.4) the preview pictures are the answer.
    if (!HlsVideoReader.supported()) {
      this.stopped = 'noWebCodecs';
      await this.thumbsDone;
      if (signal.aborted) return;
      this.state = this.chapters.length ? 'done' : 'unavailable';
      this.progress = 1;
      this.onChange();
      return;
    }
    await this.fromKeyframes(screen.source, signal, gate, screen.reader);
    if (!signal.aborted && this.state === 'done') this.took = Math.round(performance.now() - t0);
    if (!signal.aborted) this.save(key);
  }

  // The user says which view is the screen (index), or leaves it to the analysis (null).
  // Kept per recording; the chapters are found again from that view.
  async chooseScreen(index) {
    const id = this.lesson.mediaId;
    if (id) {
      if (index == null) await idbCache.del('screenpick:' + id);
      else await idbCache.put('screenpick:' + id, { index });
    }
    // Confirming the view in use only remembers it.
    if (index != null && index === this.screenIndex) {
      this.manualScreen = index;
      this.screenSure = true;
      this.onChange();
      return;
    }
    this.ac.abort();
    this.ac = new AbortController();
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    if (this.lesson.mediaId) await idbCache.del('slides:' + this.lesson.mediaId);
    this.state = 'pending';
    this.progress = 0;
    this.chapters = [];
    this.uniform = [];
    this.source = null;
    this.stopped = null;
    this.reader = null;
    this.thumbsDone = null;
    this.lumas = null;
    this.pruneThumbs();
    this.onChange();
    this.start();
  }

  // Which view is the screen: { source, thumbs (its preview set or null), sure, reader },
  // or null if no view can be read at all.
  // 1. The view the user chose for this recording.
  // 2. With one view, that view.
  // 3. How each view changes over time, from pairs of keyframes CHAPTER_STEP_SEC apart
  //    spread over the recording: a screen is still between changes (the same picture is
  //    encoded the same way, so nearly every pixel stays within STILL_LEVELS) and then
  //    changes in a step; a camera always changes a little everywhere (sensor noise, people
  //    moving). The share of slightly changed pixels per pair is lower for the screen on
  //    every recording checked (median about 0.2-11% against 12-35%, the highest screen
  //    value from a document camera). Echo360's data does not say which view is which.
  // 4. Without WebCodecs: the preview pictures' flat area (slides and documents are
  //    flatter than camera pictures; weaker, a busy screen can be less flat).
  // The most likely view is used even when the views do not differ clearly (sure = false):
  // a wrong guess shows wrong chapters that the user can fix by choosing the view, while
  // giving up would hide the feature. "Clearly" is SCREEN_CLEARLY: the chosen view's
  // values are below (or for flatness above) another view's in that share of pairs.
  async findScreen(signal) {
    const sources = this.lesson.sources;
    const setOf = (src) => (this.lesson.thumbnails || []).find((x) => x.sourceIndex === src.index && Array.isArray(x.timesInSeconds) && x.timesInSeconds.length) || null;
    if (this.manualScreen != null) {
      const src = sources.find((x) => x.index === this.manualScreen);
      this.guessScreen = src.index;
      return { source: src, thumbs: setOf(src), sure: true, reader: null };
    }
    if (sources.length === 1) { this.guessScreen = sources[0].index; return { source: sources[0], thumbs: setOf(sources[0]), sure: true, reader: null }; }
    const decide = (scored, lowerIsScreen) => {
      const r = pickScreen(scored, lowerIsScreen, sources.length);
      this.guessScreen = r.best.source.index;
      return { source: r.best.source, thumbs: setOf(r.best.source), sure: r.sure, reader: r.best.reader || null };
    };
    if (HlsVideoReader.supported()) {
      const scored = [];
      for (const src of sources) {
        const vals = [];
        let rd = null;
        try {
          rd = await new HlsVideoReader(src.v || src.av, 360).open(signal);
          const picks = rd.sampleSegments(CHAPTER_STEP_SEC);
          for (let k = 0; k < SCREEN_PROBES && picks.length > 1; k++) {
            const q = Math.floor(((k + 0.5) * (picks.length - 1)) / SCREEN_PROBES);
            let a = null;
            let b = null;
            try {
              await rd.keyframe(picks[q], signal, (f) => { a = frameLuma(f); });
              await rd.keyframe(picks[q + 1], signal, (f) => { b = frameLuma(f); });
            } catch (e) { if (signal.aborted) throw e; continue; }
            vals.push(slightChange(a, b));
          }
        } catch (e) { if (signal.aborted) throw e; }
        if (vals.length >= SCREEN_PROBES / 2) scored.push({ source: src, vals, reader: rd });
      }
      if (scored.length) return decide(scored, true);
    }
    const scored = [];
    for (const src of sources) {
      const set = setOf(src);
      if (!set) continue;
      const ts = set.timesInSeconds;
      const vals = [];
      for (let k = 0; k < SCREEN_PROBES; k++) {
        // One picture that cannot be read does not decide anything.
        let img = null;
        try { img = await this.loadThumb(set, ts[Math.floor(((k + 0.5) * ts.length) / SCREEN_PROBES)], signal); } catch (e) { if (signal.aborted) throw e; }
        if (!img) continue;
        vals.push(flatShare(img));
        img.close();
      }
      if (vals.length >= SCREEN_PROBES / 2) scored.push({ source: src, vals });
    }
    return scored.length ? decide(scored, false) : null;
  }

  async loadThumb(set, t, signal) {
    const url = thumbUrlOf(set, t);
    let r;
    try {
      r = await fetchOk(url, { signal });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      // A copy cached from the original player (loaded as a plain image) can lack the
      // CORS headers; ask the server again.
      r = await fetchOk(url, { signal, cache: 'reload' });
    }
    return createImageBitmap(await r.blob());
  }

  // Coarse chapters from the per-minute thumbnails: a change between two thumbnails is
  // placed half way between them.
  async fromThumbnailsAsync(set, signal, gate) {
    const samples = [];
    let fails = 0;
    for (const t of set.timesInSeconds) {
      await gate.wait(0);
      // A preview picture that cannot be read is left out.
      let img = null;
      try { img = await this.loadThumb(set, t, signal); fails = 0; } catch (e) {
        if (signal.aborted || ++fails >= ANALYSIS_MAX_FAILS) throw e;
        continue;
      }
      samples.push({ t, luma: frameLuma(img) });
      img.close();
    }
    if (samples.length < 2 || signal.aborted) return;
    const scenes = buildScenes(samples, this.duration(), { single: false });
    this.chapters = scenes.map((sc, i) => ({
      start: i === 0 ? 0 : (samples[sc.first].t + samples[sc.first - 1].t) / 2,
      end: sc.end,
      precise: false,
      repTime: samples[sc.rep].t,
      thumb: thumbUrlOf(set, samples[sc.rep].t),
    }));
    for (let i = 1; i < this.chapters.length; i++) this.chapters[i - 1].end = this.chapters[i].start;
    this.state = 'thumbnails';
    this.source = 'thumbs';
    this.onChange();
  }

  fromThumbnails(set, signal, gate) {
    this.thumbsDone = this.fromThumbnailsAsync(set, signal, gate).catch((e) => { if (!signal.aborted) log.warn('thumbnails:', e.message); });
  }

  // The 360p brightness picture of the screen view at sample time t, while the scan keeps
  // them (see shareLumas), else null. The slide reader compares the same pictures; sharing
  // saves downloading them twice.
  lumaAt(t) {
    return (this.lumas && this.lumas.get(Math.round(t * 10))) || null;
  }

  // The slide reader of `source` wants the pictures (true) or no longer does (false). They
  // are kept while either the scan runs or a reader of the scanned view uses them.
  shareLumas(on, source) {
    this.sharing = !!on && !!source && source.index === this.screenIndex;
    if (!this.sharing && this.state === 'done') this.lumas = null;
    return this.sharing;
  }

  async fromKeyframes(source, signal, gate, opened) {
    const reader = opened || await new HlsVideoReader(source.v || source.av, 360).open(signal);
    if (this.thumbsDone) await this.thumbsDone;
    if (signal.aborted) return;
    this.reader = reader;
    const picks = reader.sampleSegments(CHAPTER_STEP_SEC);
    const n = picks.length;
    const samples = [];
    const lumas = new Map();
    this.lumas = lumas;
    if (store.get('debug', false)) this.samples = samples; // for tuning, development only
    const thumbs = new Map();
    let lastBuild = 0;
    let fails = 0;
    for (let q = 0; q < n; q++) {
      const i = picks[q];
      await gate.turn(CHAPTER_PACE_MS[0], CHAPTER_PACE_MS[1], BG_MIN_BUFFER_SEC);
      let luma = null;
      let pic = null;
      // One segment that cannot be read (a missing keyframe, a failed request) does not end
      // the analysis: it counts as "same picture as before"; only several in a row do.
      try {
        await reader.keyframe(i, signal, (f) => { luma = frameLuma(f); pic = smallBitmap(f, CHAPTER_THUMB_W); });
        usageNote('work', 'scanFrame', reader.decodeMs);
        fails = 0;
      } catch (e) {
        if (signal.aborted) throw e;
        if (++fails >= ANALYSIS_MAX_FAILS) {
          if (samples.length) this.applyScenes(samples, thumbs, reader.segments[i].start);
          throw e;
        }
        log.warn('slide chapters: segment ' + i + ' skipped:', e);
      }
      const j = samples.length;
      const t = reader.segments[i].start;
      if (!luma) {
        if (j) samples.push({ t, luma: samples[j - 1].luma, uniform: samples[j - 1].uniform, change: 0 });
        continue;
      }
      samples.push({ t, luma, uniform: frameUniform(luma) });
      lumas.set(Math.round(t * 10), luma);
      sampleChanges(samples, j);
      // Keep a small picture only for the last frame of each run of the same picture.
      if (thumbs.has(j - 1) && samples[j].change < SAME_TEXT_MAX) thumbs.delete(j - 1);
      thumbs.set(j, await bitmapToBlob(pic));
      if (signal.aborted) return;
      this.progress = ((q + 1) / n) * 0.8;
      if (q - lastBuild >= 30) {
        lastBuild = q;
        // With per-minute chapters on screen, partial results would only show fewer.
        if (this.state !== 'thumbnails') this.applyScenes(samples, thumbs, q + 1 < n ? reader.segments[picks[q + 1]].start : this.duration());
        else this.onChange();
      }
    }
    this.state = 'keyframes';
    this.uniform = uniformStretches(samples, this.duration());
    const thr = this.applyScenes(samples, thumbs, this.duration());
    // Pin each change to about a second: the first frame between the last sample before it
    // and the first one after it that differs from the one before as much as a new picture.
    const chs = this.chapters;
    const g = thumbContext();
    for (let c = 1; c < chs.length; c++) {
      const k = chs[c].firstSample;
      if (k <= 0) continue;
      await gate.turn(CHAPTER_REFINE_PACE_MS[0], CHAPTER_REFINE_PACE_MS[1], STREAM_MAX_BUFFER_SEC);
      const before = samples[k - 1].luma;
      /** @type {number | null} */
      let at = null;
      // A segment that cannot be read keeps the coarse time.
      try {
        for (let i = reader.segmentAt(samples[k - 1].t); at === null && i < reader.segments.length && reader.segments[i].start < samples[k].t; i++) {
          await reader.frames(i, 1, signal, (f, ft) => { if (at === null && thumbChange(before, lumaThumb(g, f), thr) >= thr) at = ft; });
        }
      } catch (e) {
        if (signal.aborted) throw e;
        at = null;
      }
      // Seeking exactly to a frame's timestamp can still show the frame before it.
      if (at !== null) at = Math.round((at + 0.05) * 100) / 100;
      if (at !== null && at < chs[c].start) {
        chs[c].start = at;
        chs[c - 1].end = at;
      }
      chs[c].precise = true;
      this.progress = 0.8 + (c / chs.length) * 0.2;
      if (c % 5 === 0) this.onChange();
    }
    this.state = 'done';
    if (!this.sharing) this.lumas = null;
    this.progress = 1;
    this.onChange();
  }

  // Chapters from the samples so far (end: when the last one ends). Returns the threshold
  // used.
  applyScenes(samples, thumbs, end) {
    const thr = learnThreshold(samples.slice(1).map((x) => x.change));
    const scenes = buildScenes(samples, end, { threshold: thr });
    this.source = 'frames';
    this.chapters = scenes.map((sc) => {
      let blob = null;
      // The newest picture of this scene that is still kept.
      for (let k = sc.rep; k >= sc.first && !blob; k--) blob = thumbs.get(k) || null;
      return { start: sc.start, end: sc.end, precise: false, repTime: samples[sc.rep].t, firstSample: sc.first, blob, thumb: blob ? this.thumbUrl(blob) : '' };
    });
    this.threshold = thr;
    this.pruneThumbs();
    this.onChange();
    return thr;
  }

  save(key) {
    if (!this.lesson.mediaId || this.state !== 'done') return;
    idbCache.put(key, {
      used: Date.now(),
      v: cacheVersion('slides'),
      uniform: this.uniform,
      screen: this.screenIndex,
      sure: this.screenSure !== false,
      at: Date.now(),
      chapters: this.chapters.map((c) => ({ start: c.start, end: c.end, precise: c.precise, repTime: c.repTime, blob: c.blob || null, thumb: c.blob ? '' : c.thumb })),
    });
  }
}

// ---- 65-slides-pane.js ----
// ===================================================================================
// Reading along with the lecturer's PDF, and the Slides tab of the side panel.
//
// SlideReader holds the reader's state (the page shown, whether it follows the lecture)
// and draws the page into any number of places: the small reader in the Slides tab and,
// when the user opens it there, the PDF view in the main picture area. Following turns to
// the page being talked about; paging by hand pauses it until "back to the page being
// talked about". After a while without a recognised page it says so instead of presenting
// an old page as current.
//
// SlidesPane is the tab: the slide files (add, remove), the small reader with the page's
// times on screen and a "wrong page?" menu, and the chapter list (folded away below the
// reader when there is a PDF). Without slide files it is just the chapter list.
// ===================================================================================

class SlideReader {
  constructor(player) {
    this.player = player;
    this.view = -1;
    this.viewKey = null;     // the key of that page (see currentView)
    this.follow = true;
    this.stale = false;
    this.sample = -1;
    this.targets = new Map();   // name -> { stage, active, token }
    this.infoListeners = new Set();
    this.lastInFile = new Map();   // page key prefix (a file) -> key of the page last shown in it
  }

  get deck() {
    const d = this.player.deck;
    return d && d.pages.length ? d : null;
  }

  // A place to draw pages into: `stage` gets the canvases (and a "not recognised" layer).
  addTarget(name, stage) {
    // The pages go in their own box (which the picture-area view can zoom), the
    // "not recognised" note stays over it at its own size.
    const pages = el('div.rpages');
    stage.append(pages, el('div.rstale', { text: tr('pageNotRecognised') }));
    this.targets.set(name, { stage, pages, active: false, token: 0 });
  }

  setActive(name, on) {
    const tg = this.targets.get(name);
    if (!tg || tg.active === on) return;
    tg.active = on;
    if (on && this.deck) {
      const i = this.currentView();
      if (i >= 0) this.drawInto(tg, i);
      this.update(this.player.video.currentTime, true);
    }
  }

  get active() {
    for (const tg of this.targets.values()) if (tg.active) return true;
    return false;
  }

  // Returns a function that removes the listener again.
  onInfo(fn) { this.infoListeners.add(fn); return () => this.infoListeners.delete(fn); }

  info() { for (const fn of this.infoListeners) fn(); }

  // Called on time updates while some place shows the reader.
  update(t, force) {
    const deck = this.deck;
    if (!deck || !this.active) return;
    const sample = deck.sampleAt(t);
    // Long without a recognised page: do not keep presenting an old page as current.
    const stale = this.follow && deck.unrecognisedFor(t) > FOLLOW_STALE_SEC;
    const staleChanged = stale !== this.stale;
    this.stale = stale;
    for (const tg of this.targets.values()) tg.stage.classList.toggle('stale', stale);
    if (this.follow) {
      const p = deck.pageAt(t);
      if (p !== this.currentView() || force) this.showPage(p >= 0 ? p : Math.max(0, this.currentView()), force);
      else if (sample !== this.sample || staleChanged) this.info();
    } else if (force) this.showPage(Math.max(0, this.currentView()), true);
    this.sample = sample;
  }

  // Manual paging pauses following.
  turn(dir) {
    const deck = this.deck;
    if (!deck) return;
    this.follow = false;
    this.showPage(clamp(this.currentView() + dir, 0, deck.pages.length - 1), true);
  }

  // Shows another file (by hash): the page last shown in it, else its first page. Like
  // paging by hand, this pauses following.
  showFile(hash) {
    const deck = this.deck;
    if (!deck) return;
    const prefix = pageKeyPrefix(hash);
    const last = this.lastInFile.get(prefix);
    let i = last ? deck.pages.findIndex((p) => p.key === last) : -1;
    if (i < 0) i = deck.pages.findIndex((p) => p.key.startsWith(prefix));
    if (i < 0) return;
    this.follow = false;
    this.showPage(i, true);
  }

  // The file shown now ({ hash, name }), or null.
  shownFile() {
    const deck = this.deck;
    const p = deck && deck.pages[this.currentView()];
    return p ? deck.files.find((f) => p.key.startsWith(pageKeyPrefix(f.hash))) || null : null;
  }

  // The file after the one shown (wrapping round), for the PDF view's file button.
  nextFile() {
    const deck = this.deck;
    const cur = this.shownFile();
    if (!deck || !cur || deck.files.length < 2) return null;
    return deck.files[(deck.files.indexOf(cur) + 1) % deck.files.length];
  }

  resumeFollow() {
    this.follow = true;
    this.update(this.player.video.currentTime, true);
  }

  // The page index shown now, kept valid when the files change (a file removed, replaced
  // or added): the same page if it is still there (by its key), else the nearest valid
  // index.
  currentView() {
    const pages = this.deck ? this.deck.pages : [];
    if (this.view < 0 || !pages.length) return -1;
    const p = pages[this.view];
    if (p && p.key === this.viewKey) return this.view;
    const k = pages.findIndex((x) => x.key === this.viewKey);
    this.view = k >= 0 ? k : Math.min(this.view, pages.length - 1);
    this.viewKey = pages[this.view].key;
    return this.view;
  }

  showPage(i, force) {
    if (!this.deck || i < 0) return;
    i = Math.min(i, this.deck.pages.length - 1);
    if (i < 0) return;
    const changed = i !== this.view;
    this.view = i;
    this.viewKey = this.deck.pages[i].key;
    this.lastInFile.set(pageKeyFile(this.viewKey), this.viewKey);
    if (changed || force) for (const tg of this.targets.values()) if (tg.active) this.drawInto(tg, i);
    this.info();
  }

  // Draws page i into a place, with a short cross-fade over the previous page.
  drawInto(tg, i) {
    const deck = this.deck;
    const token = ++tg.token;
    const stage = tg.stage;
    const p = deck.pages[i];
    if (!p) return;
    const dpr = window.devicePixelRatio || 1;
    // As wide as fits the place at the page's aspect ratio.
    const ar = p.ar || PAGE_AR_DEFAULT;
    const w = stage.clientWidth || 320;
    const hgt = stage.clientHeight || w * ar;
    // Zoomed in (picture-area view): sharper, up to a canvas the browser handles easily.
    const width = Math.min(4096, Math.max(200, Math.min(w, hgt / ar)) * dpr * (tg.sharp || 1));
    deck.render(i, width).then((src) => {
      if (token !== tg.token) return;
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      c.className = 'rpage';
      tg.pages.append(c);
      windowOf(tg.pages).requestAnimationFrame(() => c.classList.add('in'));
      const old = [...tg.pages.querySelectorAll('canvas')].filter((x) => x !== c);
      setTimeout(() => { for (const x of old) x.remove(); }, 220);
    }).catch((e) => log.warn('render page:', e && e.message ? e.message : e));
  }

  // "Page 5 of 21" for the page shown (of its file; the file's name is shown apart).
  label() {
    const deck = this.deck;
    const p = deck.pages[this.currentView()];
    if (!p) return '';
    const prefix = pageKeyFile(p.key);
    return tr('pageOfN', { n: p.num, total: deck.pages.filter((x) => x.key.startsWith(prefix)).length });
  }

  // The following line: following (sure / unsure / stale), or a button back to it.
  // `compact` gives the short wording for the toolbar over the PDF view.
  followElement(compact) {
    const now = this.player.video.currentTime;
    if (!this.follow) return el('button.rback', { text: compact ? tr('backToLectureShort') : tr('backToLecture'), onclick: () => this.resumeFollow() });
    const state = this.stale ? 'Stale' : this.deck.knownAt(now) ? '' : 'Unsure';
    return el('span.rfollowing', { text: tr('following' + state + (compact ? 'Short' : '')) });
  }
}

class SlidesPane {
  constructor(player, elem, disposer) {
    this.player = player;
    this.el = elem;
    this.visible = false;
    this.chapters = [];
    this.dirty = true;
    this.current = -1;
    this.cards = [];
    this.showChapters = false;
    this.d = disposer || new Disposer();   // owned by whoever created this (parent.child())
    this.reader = player.reader;
    this.d.add(() => this.reader.setActive('side', false));
    this.fileBtns = [];          // the file names, as buttons (renderDeck)
    this.deckBox = el('div.sdeck');
    this.readerBox = el('div.reader', { hidden: true });
    this.status = el('div.sstatus', { 'aria-live': 'polite' });
    this.chapToggle = el('button.chaptoggle', { hidden: true, onclick: () => { this.showChapters = !this.showChapters; this.render(); } });
    this.list = el('div.slist');
    this.screenBox = el('div.sscreen');
    elem.append(this.deckBox, this.readerBox, this.chapToggle, this.status, this.screenBox, this.list);
    this.buildReader();
    this.d.add(this.reader.onInfo(() => { if (this.visible) this.renderPageInfo(); }));
    this.d.listen(this.list, 'click', (e) => {
      const card = e.target.closest('.scard');
      if (card) this.player.seek(this.chapters[+card.dataset.i].start);
    });
  }

  get deck() { return this.reader.deck; }

  buildReader() {
    const r = this.readerBox;
    const stage = el('div.rstage');
    this.reader.addTarget('side', stage);
    this.stage = stage;
    this.prevBtn = el('button.rnav', { 'aria-label': tr('prevPage'), title: tr('prevPage'), text: '‹', onclick: () => this.reader.turn(-1) });
    this.nextBtn = el('button.rnav', { 'aria-label': tr('nextPage'), title: tr('nextPage'), text: '›', onclick: () => this.reader.turn(1) });
    this.pageLabel = el('span.rlabel');
    this.mainBtn = el('button.rmain', { onclick: () => this.player.setPdfMain(!this.player.prefs.pdfMain) });
    this.followBox = el('div.rfollow');
    this.timesBox = el('div.rtimes');
    this.fixBox = el('details.rfix');
    r.append(stage, el('div.rbar', null, this.prevBtn, this.pageLabel, this.nextBtn), this.mainBtn, this.followBox, this.timesBox, this.fixBox);
  }

  setChapters(chapters, statusText) {
    this.chapters = chapters;
    this.statusText = statusText;
    this.dirty = true;
    if (this.visible) this.render();
  }

  // The transcript or the slide files changed.
  invalidate() {
    this.dirty = true;
    if (this.visible) this.render();
  }

  show(on) {
    this.visible = on;
    this.reader.setActive('side', on && !!this.deck);
    if (on) this.render();
  }

  // Which view the chapters and the reader use, and the choice of another one (the last
  // resort when the analysis guessed wrong). Shown with two or more views.
  renderScreen() {
    const box = this.screenBox;
    box.textContent = '';
    const a = this.player.slides;
    const sources = this.player.lesson.sources;
    if (!a || sources.length < 2) return;
    const how = a.manualScreen != null ? tr('screenChosen') : a.screenIndex == null ? '' : a.screenSure ? tr('screenFound') : tr('screenGuessed');
    box.append(el('span', { text: tr('screenView') }));
    sources.forEach((src, i) => {
      const on = src.index === a.screenIndex;
      box.append(el('button.sview' + (on ? '.on' : ''), { text: tr('viewN', { n: i + 1 }), 'aria-pressed': String(on), title: tr('screenUse', { n: i + 1 }),
        onclick: () => { if (!on || a.manualScreen == null) a.chooseScreen(src.index).catch((e) => log.warn('screen choice:', e)); } }));
    });
    if (how) box.append(el('span.sviewhow', { text: how }));
    if (a.manualScreen != null) box.append(el('button.link', { text: tr('screenAuto'), onclick: () => a.chooseScreen(null).catch((e) => log.warn('screen choice:', e)) }));
  }

  renderDeck() {
    const deck = this.player.deck;
    const box = this.deckBox;
    box.textContent = '';
    if (!deck) return;
    const input = el('input', { type: 'file', accept: '.pdf,application/pdf', multiple: true, hidden: true });
    // Failures are shown in this tab (deck.notice, deck.error).
    input.addEventListener('change', guard(() => { if (input.files.length) deck.addFiles(input.files).catch(() => {}); }));
    const files = el('div.sfiles');
    // With several files, a name is a button that shows that file (renderPageInfo marks
    // the one shown).
    const several = deck.files.length > 1 && !!this.deck;
    this.fileBtns = [];
    for (const f of deck.files) {
      const name = several
        ? el('button.sfname', { text: f.name, title: tr('showFile', { name: f.name }), 'aria-pressed': 'false', onclick: () => this.reader.showFile(f.hash) })
        : el('span.sfname', { text: f.name, title: f.name });
      if (several) { name.dataset.hash = f.hash; this.fileBtns.push(name); }
      files.append(el('span.sfile', null, name,
        el('button.sfremove', { title: tr('removeFile', { name: f.name }), 'aria-label': tr('removeFile', { name: f.name }), text: '✕', onclick: () => deck.removeFile(f.hash) })));
    }
    files.append(el('button.sfadd', { text: deck.files.length ? tr('addMoreSlides') : tr('addSlides'), onclick: () => input.click() }), input);
    let msg = '';
    if (deck.state === 'loading') msg = tr('deckLoading');
    else if (deck.state === 'reading') {
      const r = deck.ocr;
      msg = !r ? tr('deckWaiting')
        : r.state === 'reading' && !r.engineReady && r.stats.read === 0 ? tr('deckLangLoading', { lang: languageName(r.lang), mb: (TESS_LANGS[r.lang].bytes / 1e6).toFixed(1) })
          : tr('deckReading', { pct: Math.floor(deck.progress * 100) });
    }
    else if (deck.state === 'error') msg = deck.error;
    else if (!deck.files.length) msg = tr('slidesLocal');
    box.append(files);
    if (msg) box.append(el('div.sdmsg', { text: msg }));
    if (deck.notice) box.append(el('div.sdmsg', { text: deck.notice }));
    if (deck.capped && deck.state !== 'error') box.append(el('div.sdmsg', { text: tr('deckCapped', { n: DECK_MAX_PAGES }) }));
  }

  render() {
    this.status.textContent = this.statusText || '';
    this.renderScreen();
    this.renderDeck();
    const deck = this.deck;
    this.readerBox.hidden = !deck;
    this.reader.setActive('side', this.visible && !!deck);
    this.chapToggle.hidden = !deck || !this.chapters.length;
    this.chapToggle.textContent = this.showChapters ? tr('hideChapters') : tr('showChapters', { n: this.chapters.length });
    const listShown = !deck || this.showChapters;
    this.list.hidden = !listShown;
    this.status.hidden = !listShown;
    if (deck) this.reader.update(this.player.video.currentTime, true);
    if (!listShown) return;
    if (!this.dirty) { this.update(this.player.video.currentTime, true); return; }
    this.dirty = false;
    const long = this.player.duration() >= 3600;
    const cues = this.player.cues;
    const index = cues && cues.length ? new CueIndex(cues) : null;
    const frag = document.createDocumentFragment();
    this.cards = this.chapters.map((c, i) => {
      let said = '';
      if (index) {
        // The sentence being spoken when the slide appears, or the next one.
        const k = index.started(c.start);
        const cue = k >= 0 && cues[k].end > c.start ? cues[k] : cues[k + 1];
        if (cue && cue.start < c.end) said = cue.text;
      }
      const img = c.thumb ? el('img', { src: c.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : el('div.noimg');
      const card = el('button.scard', { 'data-i': String(i) },
        img,
        el('div.smeta', null,
          el('div.stitle', null, el('span.sn', { text: tr('slideN', { n: i + 1 }) }), el('span.st', { text: fmtTime(c.start, long) + (c.precise ? '' : ' ~') })),
          said ? el('div.ssaid', { text: said }) : null));
      frag.appendChild(card);
      return card;
    });
    this.list.textContent = '';
    this.list.appendChild(frag);
    this.current = -1;
    this.update(this.player.video.currentTime, true);
  }

  // Called on time updates: the chapter highlight (the reader updates itself).
  update(t, force) {
    if (!this.visible || hiddenFor(this.list) || !this.cards.length || this.list.hidden) return;
    const k = chapterIndexAt(this.chapters, t);
    if (k === this.current && !force) return;
    if (this.cards[this.current]) this.cards[this.current].classList.remove('cur');
    this.current = k;
    if (this.cards[k]) {
      this.cards[k].classList.add('cur');
      this.cards[k].scrollIntoView({ block: 'nearest' });
    }
  }

  renderPageInfo() {
    const deck = this.deck;
    const rd = this.reader;
    const i = deck ? rd.currentView() : -1;
    const p = deck && deck.pages[i];
    if (!p) return;
    this.pageLabel.textContent = rd.label();
    this.pageLabel.title = p.title || '';
    const shown = rd.shownFile();
    for (const b of this.fileBtns || []) setPressed(b, !!shown && b.dataset.hash === shown.hash);
    this.prevBtn.disabled = i <= 0;
    this.nextBtn.disabled = i >= deck.pages.length - 1;
    this.mainBtn.textContent = this.player.prefs.pdfMain ? tr('pdfMainClose') : tr('pdfMainOpen');

    this.followBox.textContent = '';
    this.followBox.append(rd.followElement());

    const long = this.player.duration() >= 3600;
    const times = deck.timesOf(i);
    this.timesBox.textContent = '';
    if (times.length) {
      this.timesBox.append(el('span.rtl', { text: tr('shownAt') }));
      for (const r of times) this.timesBox.append(el('button.rtime', { text: fmtTime(r.start, long), onclick: () => { this.player.seek(r.start); rd.resumeFollow(); } }));
    } else if (deck.state === 'ready') {
      this.timesBox.append(el('span.rtl', { text: tr('notFoundInRecording') }));
    }

    // Correction for the part being played.
    const fixed = deck.correctionAt(this.player.video.currentTime);
    this.fixBox.textContent = '';
    this.fixBox.append(el('summary', { text: tr('wrongPage') }),
      el('button.rfixbtn', { text: tr('useThisPage', { n: p.num }), onclick: () => { deck.correct(this.player.video.currentTime, i); this.fixBox.open = false; rd.resumeFollow(); } }),
      el('button.rfixbtn', { text: tr('markNotSlide'), onclick: () => { deck.correct(this.player.video.currentTime, 'none'); this.fixBox.open = false; rd.resumeFollow(); } }));
    if (fixed) {
      this.fixBox.append(el('button.rfixbtn', { text: tr('undoCorrection'), onclick: () => { deck.correct(this.player.video.currentTime, null); this.fixBox.open = false; rd.resumeFollow(); } }));
    }
  }

  dispose() {
    this.d.dispose();
  }
}

// ---- 66-slide-ocr.js ----
// ===================================================================================
// Reading the text on the screen view, for following the lecturer's slides.
//
// Runs only while the recording has slide files. Every HLS segment starts with a keyframe;
// one keyframe every CHAPTER_STEP_SEC of the screen view is read at 720p (the smallest rendition at
// least that tall, or the tallest there is: text in 360p is not readable) and their text is
// recognised with Tesseract.js (pinned, from jsDelivr, loaded on first use).
//
// - A keyframe that looks like the previous one reuses its text: most of a lecture is the
//   same slide for many samples in a row. The comparison (at 160 x 90, see thumbChange)
//   uses the 360p keyframe (about 20 KB), taken from the slide analysis when it has it;
//   the 720p one (about 100 KB for a detailed screen) is only downloaded where something
//   changed.
// - Order: from the playback position onward; a seek starts again there; then the rest.
// - Pace: while playing, each reading is followed by a rest as long as it took (about half
//   of one core); while paused, readings follow each other. Downloads wait for the
//   playback buffer like all background work, and nothing runs with Data Saver on.
// - The texts are cached per recording (independent of the slide files) and a reading
//   continues where it stopped on the next visit.
//
// Cached record  ocr:<mediaId>  { v, screen, height, texts: [string], at: [text index per
// sample, -1 = not read, OCR_FAILED], stats }.
// For later features (on-device speech recognition may reuse the keyframes and text):
//   reader.times[i], reader.texts, reader.at[i].
// Language: chosen from the slide files' text (ocrLanguage); English data is about 3 MB,
// other languages 0.6 to 2.7 MB; each is downloaded when first needed (the browser's HTTP
// cache keeps it), and the slides tab says which and how large while it loads.
//
// Every file is checked against its SHA-256 (04-libs.js) before it is used: the library,
// its Worker and the engine through platform.libBlobUrl, the language data inside the
// Worker (tessWorkerGuard). Tesseract.js's own storage of language data is not used: what
// it kept would be read back without a check.
// ===================================================================================

const TESS_FILES = {
  lib: 'tesseract.js@7.0.0/dist/tesseract.esm.min.js',
  worker: 'tesseract.js@7.0.0/dist/worker.min.js',
  // The LSTM engine (OEM 1, the only one used), with WebAssembly SIMD where the browser has
  // it. Named here rather than chosen by Tesseract.js, so that the file run is a pinned one.
  core: 'tesseract.js-core@7.0.0/tesseract-core-lstm.wasm.js',
  coreSimd: 'tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js',
};
// Language data (pinned npm packages, 4.0.0_best_int): the scripts each one reads (the
// non-Latin ones read Latin letters too, for the English terms on such slides), the size
// of its download, and the language tag for its name. One language per engine: Tesseract.js
// loads every language of an engine from one place, and each is its own package.
const TESS_LANGS = {
  eng: { scripts: ['Latin'], bytes: 2952873, tag: 'en' },
  chi_sim: { scripts: ['Han', 'Latin'], bytes: 1718768, tag: 'zh-Hans' },
  chi_tra: { scripts: ['Han', 'Latin'], bytes: 1656239, tag: 'zh-Hant' },
  jpn: { scripts: ['Han', 'Latin'], bytes: 2030256, tag: 'ja' },
  kor: { scripts: ['Hangul', 'Latin'], bytes: 1572336, tag: 'ko' },
  rus: { scripts: ['Cyrillic', 'Latin'], bytes: 2679598, tag: 'ru' },
  ell: { scripts: ['Greek', 'Latin'], bytes: 1324749, tag: 'el' },
  ara: { scripts: ['Arabic', 'Latin'], bytes: 1661906, tag: 'ar' },
  heb: { scripts: ['Hebrew', 'Latin'], bytes: 580576, tag: 'he' },
  tha: { scripts: ['Thai', 'Latin'], bytes: 896631, tag: 'th' },
  hin: { scripts: ['Devanagari', 'Latin'], bytes: 1389692, tag: 'hi' },
};
const TESS_LANG_DIR = (lang) => '@tesseract.js-data/' + lang + '@1.0.0/4.0.0_best_int';

// The smallest module using a SIMD instruction (i8x16.splat): valid only where the browser
// runs WebAssembly SIMD. The same test Tesseract.js makes (wasm-feature-detect).
const WASM_SIMD_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];
function wasmSimd() {
  try { return WebAssembly.validate(new Uint8Array(WASM_SIMD_PROBE)); } catch (e) { return false; }
}

// Runs first in Tesseract.js's Worker, before its own code: the Worker's only downloads are
// language data, and each must be a pinned file (url -> SHA-256) with the right bytes.
// Anything else fails there, before the engine reads it.
function tessWorkerGuard(pinned) {
  const real = self.fetch.bind(self);
  self.fetch = async (url, opts) => {
    const want = pinned[String(url)];
    if (!want) throw new Error('not a pinned file: ' + url);
    const r = await real(url, opts);
    if (!r.ok) return r;
    const buf = await r.arrayBuffer();
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    if (Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('') !== want) throw new Error('language data changed on the CDN, not used: ' + url);
    return new Response(buf, { status: r.status, statusText: r.statusText, headers: r.headers });
  };
}

// The pinned language data, by the address the Worker asks for.
function tessPinnedData() {
  const out = {};
  for (const [path, hash] of Object.entries(LIB_SHA256)) if (path.endsWith('.traineddata.gz')) out[platform.libUrl(path)] = hash;
  return out;
}

// Characters written differently in simplified and traditional Chinese (common ones, in
// matching order), to tell the two apart.
const HANS_ONLY = '\u8fd9\u4eec\u4e2a\u65f6\u6765\u4e3a\u8bf4\u56fd\u8fc7\u53d1\u540e\u4f1a\u5bf9\u5b66\u52a8\u5b9e\u73b0\u70b9\u7ecf\u5173\u5e94\u8fdb\u79cd\u673a\u6570\u636e\u53d8\u8ba1\u7535\u538b\u7ea7\u4ea7\u7ebf\u56fe\u5f53\u8fd8\u65e0\u4e48\u95ee\u9898\u957f\u95f4\u89c1';
const HANT_ONLY = '\u9019\u5011\u500b\u6642\u4f86\u70ba\u8aaa\u570b\u904e\u767c\u5f8c\u6703\u5c0d\u5b78\u52d5\u5be6\u73fe\u9ede\u7d93\u95dc\u61c9\u9032\u7a2e\u6a5f\u6578\u64da\u8b8a\u8a08\u96fb\u58d3\u7d1a\u7522\u7dda\u5716\u7576\u9084\u7121\u9ebc\u554f\u984c\u9577\u9593\u898b';

// The language to read the screen in, from the text of the slide files: the script most of
// their words are in (a Chinese or Japanese character counts as a word), English for Latin
// and for scripts without language data here. Japanese if a tenth or more of the Chinese
// characters are kana (Japanese prose is about a third or more kana, Chinese has none);
// simplified or traditional Chinese by which characters it uses.
function ocrLanguage(pageTexts) {
  const words = {};
  let kana = 0;
  let hans = 0;
  let hant = 0;
  for (const text of pageTexts) {
    for (const [w] of String(text || '').normalize('NFKC').matchAll(WORD_RE)) {
      if (/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u.test(w)) {
        words.Han = (words.Han || 0) + w.length;
        for (const ch of w) {
          if (/[\p{sc=Hiragana}\p{sc=Katakana}]/u.test(ch)) kana++;
          else if (HANS_ONLY.includes(ch) && !HANT_ONLY.includes(ch)) hans++;
          else if (HANT_ONLY.includes(ch) && !HANS_ONLY.includes(ch)) hant++;
        }
        continue;
      }
      const sc = WORD_SCRIPTS.find((x) => new RegExp('^\\p{sc=' + x + '}', 'u').test(w));
      if (sc) words[sc] = (words[sc] || 0) + 1;
    }
  }
  let top = 'Latin';
  for (const k of Object.keys(words)) if (words[k] > (words[top] || 0)) top = k;
  if (top === 'Han') return kana >= 0.1 * words.Han ? 'jpn' : hant > hans ? 'chi_tra' : 'chi_sim';
  return Object.keys(TESS_LANGS).find((l) => l !== 'eng' && TESS_LANGS[l].scripts[0] === top) || 'eng';
}

// The name of a language for messages ("Chinese (Simplified)"), in the interface language.
function languageName(lang) {
  const tag = (TESS_LANGS[lang] || TESS_LANGS.eng).tag;
  try { return new Intl.DisplayNames([uiLocale()], { type: 'language' }).of(tag) || tag; } catch (e) { return tag; }
}

const OCR_FAILED = -3;         // a sample whose keyframe could not be read

let tesseractPromise = null;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = platform.importLib(TESS_FILES.lib).then((m) => m.default || m);
    tesseractPromise.catch(() => { tesseractPromise = null; });
  }
  return tesseractPromise;
}

class SlideTextReader {
  // opts: { lesson, video, source (the screen view), disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.source = opts.source;
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('slide reader (display)', e); } };
    this.ac = new AbortController();
    opts.disposer.add(() => this.stop());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.reader = null;
    this.times = [];         // start of each sample
    this.picks = [];         // segment of each sample
    this.end = 0;            // end of the recording (of the last sample)
    this.texts = [];
    this.at = null;          // Int32Array: text index per sample, -1 = not read
    this.state = 'idle';     // idle | loading | reading | done | unavailable
    this.error = '';
    this.stats = { read: 0, same: 0, failed: 0, ms: 0, bytes: 0, wall: 0 };
    this.debug = store.get('debug', false) ? { changes: [] } : null;
    this.engine = null;
    this.shared = opts.shared || null;   // the slide analysis, if it shares its pictures
    this.lang = TESS_LANGS[opts.lang] ? opts.lang : 'eng';
    this.engineReady = false;
  }

  // The scripts this reader can read (for matching words, see slideWords).
  get scripts() { return TESS_LANGS[this.lang].scripts; }

  get key() { return 'ocr:' + this.lesson.mediaId + ':' + this.source.index + (this.lang === 'eng' ? '' : ':' + this.lang); }

  done() {
    return this.at ? this.at.reduce((n, x) => n + (x !== -1 ? 1 : 0), 0) : 0;
  }

  progress() {
    return this.at && this.at.length ? this.done() / this.at.length : 0;
  }

  start() {
    bgWork.track(this.run()).catch((e) => {
      if (this.ac.signal.aborted) return;
      log.warn('slide text:', e && e.message ? e.message : e);
      this.state = 'unavailable';
      // Shown in the slides tab: the reason in words where it is known.
      this.error = (e && e.userText) || tr('readerFailed', { msg: String((e && e.message) || e) });
      this.onChange();
    });
  }

  stop() {
    this.ac.abort();
    if (this.shared) this.shared.shareLumas(false);
    if (this.engine) this.engine.then((w) => w.terminate()).catch(() => {});
    this.engine = null;
  }

  async run() {
    const signal = this.ac.signal;
    if (!HlsVideoReader.supported()) throw Object.assign(new Error('WebCodecs not available'), { userText: tr('readerNoWebCodecs') });
    if (saveDataOn()) throw Object.assign(new Error('Data Saver is on'), { userText: tr('readerSaveData') });
    this.state = 'loading';
    this.onChange();
    const url = this.source.v || this.source.av;
    this.reader = await new HlsVideoReader(url, Infinity, OCR_HEIGHT).open(signal);
    this.probe = await new HlsVideoReader(url, 360).open(signal);
    this.picks = this.reader.sampleSegments(CHAPTER_STEP_SEC);
    this.times = this.picks.map((i) => this.reader.segments[i].start);
    this.end = this.reader.duration;
    // The 360p keyframe of each sample: the probe's segment starting at the same time, or
    // the 720p one itself if the renditions are cut differently.
    this.probePicks = this.times.map((t) => this.probe.segmentAt(t + 0.01));
    if (this.probePicks.some((k, q) => Math.abs(this.probe.segments[k].start - this.times[q]) > 0.05)) { this.probe = this.reader; this.probePicks = this.picks; }
    const lumaOf = this.shared && this.shared.shareLumas(true, this.source) ? (t) => this.shared.lumaAt(t) : () => null;
    const n = this.times.length;
    const cached = this.lesson.mediaId ? await idbCache.get(this.key) : undefined;
    const hit = cacheValid('ocr', cached) && cached.height === this.reader.info.height && Array.isArray(cached.at) && cached.at.length === n;
    if (this.lesson.mediaId) usageNote('cache', hit ? 'hit' : 'miss');
    if (hit) {
      cacheTouch(this.key);
      this.texts = cached.texts;
      this.at = Int32Array.from(cached.at);
      Object.assign(this.stats, cached.stats || {});
    } else {
      this.at = new Int32Array(n).fill(-1);
    }
    if (this.done() === n) { this.state = 'done'; if (this.shared) this.shared.shareLumas(false); this.onChange(); return; }
    this.state = 'reading';
    this.onChange();
    const canvas = makeCanvas(this.reader.info.width, this.reader.info.height);
    const g = canvas.getContext('2d');
    const small = makeCanvas(THUMB_W, THUMB_H).getContext('2d', { willReadFrequently: true });
    // The previous sample of this pass, and the thumbnail of the last one whose text was
    // read: changes are measured against that, so that slow changes (ink added a little at
    // a time) still add up.
    let prev = -1;
    let ref = null;
    const bytes = () => this.reader.bytes + (this.probe !== this.reader ? this.probe.bytes : 0);
    let unsaved = 0;
    let fails = 0;
    const t0 = performance.now();
    const wall0 = this.stats.wall;
    for (let i = this.next(); i >= 0; i = this.next()) {
      await this.gate.turn(OCR_PACE_MS[0], OCR_PACE_MS[1], BG_MIN_BUFFER_SEC);
      let thumb = lumaOf(this.times[i]);
      let full = false;
      const bytes0 = bytes();
      if (!thumb) {
        try {
          await this.probe.keyframe(this.probePicks[i], signal, (f) => { thumb = lumaThumb(small, f); });
        } catch (e) {
          if (signal.aborted) throw e;
        }
      }
      const change = thumb && prev === i - 1 && ref ? thumbChange(ref, thumb) : -1;
      const same = change >= 0 && change < SAME_TEXT_MAX;
      if (this.debug) this.debug.changes[i] = change;
      if (thumb && !same) {
        try {
          await this.reader.keyframe(this.picks[i], signal, (f) => { g.drawImage(f, 0, 0, canvas.width, canvas.height); full = true; });
        } catch (e) {
          if (signal.aborted) throw e;
        }
      }
      this.stats.bytes += bytes() - bytes0;
      if (!thumb || (!same && !full)) {
        this.at[i] = OCR_FAILED;
        this.stats.failed++;
        ref = null;
        // Several in a row (network gone): stop and keep what was read; the next visit
        // continues, retrying these.
        if (++fails >= ANALYSIS_MAX_FAILS) { this.save(); throw new Error('keyframes cannot be read'); }
      } else if (same) {
        fails = 0;
        this.at[i] = this.at[i - 1];
        this.stats.same++;
      } else {
        fails = 0;
        const blob = await canvasBlob(canvas, 'image/png');
        const a = performance.now();
        const text = await this.recognize(blob);
        const ms = performance.now() - a;
        this.at[i] = this.addText(text);
        ref = thumb;
        this.stats.read++;
        this.stats.ms += Math.round(ms);
        usageNote('work', 'ocrMpx', ms / (canvas.width * canvas.height / 1e6));
        // Half pace while playing: rest as long as the reading took.
        if (!this.video.paused) await this.gate.wait(ms);
      }
      prev = ref ? i : -1;
      this.stats.wall = wall0 + Math.round(performance.now() - t0);
      if (++unsaved >= OCR_SAVE_EVERY) { unsaved = 0; this.save(); }
      this.onChange();
    }
    this.state = 'done';
    if (this.shared) this.shared.shareLumas(false);
    this.save();
    this.onChange();
  }

  addText(text) {
    this.texts.push(text);
    return this.texts.length - 1;
  }

  // The next sample to read: the first unread one from the playback position on, else the
  // first unread one. -1 when all are read.
  next() {
    const at = this.at;
    const here = Math.max(0, sampleIndexAt(this.times, this.video.currentTime || 0));
    for (let i = here; i < at.length; i++) if (at[i] === -1) return i;
    for (let i = 0; i < here; i++) if (at[i] === -1) return i;
    return -1;
  }

  async recognize(blob) {
    // Never start the engine (a Worker with tens of MB of WASM and language data) once
    // reading has been stopped; one that finishes starting after a stop is ended at once.
    if (this.ac.signal.aborted) throw new Error('aborted');
    if (!this.engine) {
      const signal = this.ac.signal;
      // The engine is given as one file ("...#.js": Tesseract.js uses a path ending in "js"
      // as it is, instead of choosing a file next to it).
      // The language data is checked here first, although the Worker downloads it again
      // (from the HTTP cache) and checks it too: Tesseract.js's createWorker never settles
      // when loading a language fails, so a failure must come before it. errorHandler turns
      // its later errors into a rejection instead of an exception thrown in the page.
      let failed;
      const failure = new Promise((res, rej) => { failed = rej; });
      failure.catch(() => {});
      this.engine = Promise.all([
        loadTesseract(),
        platform.libBlobUrl(TESS_FILES.worker, '(' + tessWorkerGuard + ')(' + JSON.stringify(tessPinnedData()) + ');\n'),
        platform.libBlobUrl(wasmSimd() ? TESS_FILES.coreSimd : TESS_FILES.core),
        platform.libBytes(TESS_LANG_DIR(this.lang) + '/' + this.lang + '.traineddata.gz'),
      ]).then(([T, workerPath, core]) => Promise.race([failure, T.createWorker(this.lang, 1, {
        workerPath,
        corePath: core + '#core.js',
        langPath: platform.libUrl(TESS_LANG_DIR(this.lang)),
        cacheMethod: 'none',
        errorHandler: (e) => { log.warn('text reader:', String(e).slice(0, 200)); failed(new Error(String(e))); },
      })])).then((w) => {
        if (signal.aborted) { w.terminate(); throw new Error('aborted'); }
        this.engineReady = true;
        this.onChange();
        return w;
      });
      this.engine.catch(() => { this.engine = null; });
    }
    const w = await this.engine;
    if (this.ac.signal.aborted) throw new Error('aborted');
    return String((await w.recognize(blob)).data.text || '');
  }

  save() {
    if (!this.lesson.mediaId || !this.at) return;
    // Samples that could not be read are stored as unread, so the next visit tries them again.
    const at = Array.from(this.at, (x) => (x === OCR_FAILED ? -1 : x));
    idbCache.put(this.key, { v: cacheVersion('ocr'), used: Date.now(), screen: this.source.index, height: this.reader.info.height, texts: this.texts, at, stats: this.stats, savedAt: Date.now() });
  }
}

// ---- 67-slide-text.js ----
// ===================================================================================
// Which page of the lecturer's slide files is on screen, from the text on screen.
//
// Pure functions on strings and numbers (the reading of the screen is in 66-slide-ocr.js).
//
//   1. Words. The text recognised in each distinct screen picture is compared with each
//      page's text (tf-idf cosine). Words on many pages (course name, footer) count little;
//      words on many screen pictures (the viewer's toolbar, tab titles, a file path) count
//      little too, whatever the software.
//   2. Evidence. How a score should be read is learnt from the lecture itself: the second
//      best page of a picture is always a wrong page, so the second best scores show what
//      "wrong" looks like in this lecture; the best scores are a mix of that and "right",
//      whose share and spread are fitted to them. A score then counts as the log of how
//      much more likely it is under "right" than under "wrong". A picture with little text
//      gives little evidence either way.
//   3. Sequence. A hidden Markov model over the pictures in time order decides all pages
//      at once (Viterbi). States: every page, and "not a slide" (remembering the last page,
//      so coming back to it is cheap). Staying or moving on one page is usual; going back,
//      jumping and leaving the slides are rarer; a jump to another file is rarer still.
//      Pages with little text are placed by their neighbours.
// ===================================================================================

const SLIDE_STOP = new Set(('the and for are but not you all any can had her was one our out has have this that with from they will would there their '
  + 'what about which when your then them these some into more than only other such also each just like been were said very where while here '
  + 'should could does using used use get got let its how why who may might must shall ours yours his him she hers').split(' '));

// Words of a text, in the scripts that text recognition can read (`scripts`, script
// names as in Unicode, 'Han' for Chinese and Japanese; Latin when not given): a word in
// another script (Greek letters of a formula in a PDF, when reading English) can only be on
// a page, never on screen, and would only blur the comparison.
// - runs of letters (and digits after them) of one script, in lower case: a change of
//   script inside a "word" is a formula (jωL) or recognition noise, not a word;
// - accents on Latin, Greek and Cyrillic letters dropped (text recognition often misses
//   them; the slide file has them), and compatibility forms unified (the "fi" ligature and
//   the maths italic letters of a PDF are plain letters);
// - words of three or more characters: shorter pieces are mostly recognition noise (two
//   capitals such as AI or ML were tried as words and cost a tenth of the pages on a
//   circuits lecture, where text recognition makes many of them out of drawings);
// - Chinese and Japanese text has no spaces: every two neighbouring characters are a word
//   (a lone character is one);
// - common English words (SLIDE_STOP) are left out; in other languages common words weigh
//   little anyway, being on many pages and pictures.
const WORD_SCRIPTS = ['Latin', 'Greek', 'Cyrillic', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Thai', 'Lao', 'Khmer', 'Myanmar', 'Hangul',
  'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Ethiopic'];
const WORD_RE = new RegExp('[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}]+|'
  + WORD_SCRIPTS.map((x) => '\\p{sc=' + x + '}[\\p{sc=' + x + '}\\p{M}\\p{N}]*').join('|') + '|\\p{L}[\\p{L}\\p{M}\\p{N}]*', 'gu');
function slideWords(text, scripts) {
  const key = (scripts || ['Latin']).join(',');
  // The pattern for these scripts is kept on the function itself (it also runs in the
  // Worker, built from this function's source, where no outside variable exists).
  const self = /** @type {any} */ (slideWords);
  if (!self.allowed || self.allowed.key !== key) {
    self.allowed = new RegExp('^(?:' + key.split(',').map((x) => (x === 'Han' ? '[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}]' : '\\p{sc=' + x + '}')).join('|') + ')', 'u');
    self.allowed.key = key;
  }
  const allowed = self.allowed;
  const s = String(text || '').normalize('NFKD').replace(/([\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}])\p{M}+/gu, '$1').normalize('NFKC');
  const out = [];
  for (const [w] of s.matchAll(WORD_RE)) {
    if (!allowed.test(w)) continue;
    if (/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
      continue;
    }
    const l = w.toLowerCase();
    if (w.length >= 3 && !SLIDE_STOP.has(l)) out.push(l);
  }
  return out;
}

function wordBag(words) {
  const b = new Map();
  for (const w of words) b.set(w, (b.get(w) || 0) + 1);
  return b;
}

// Words of the pages and pictures, shared by textScores and pageSimilarity. row(f, scores,
// explained, o, acc) writes picture f's cosine with every page to scores[o..o+P) and, when
// explained is given, the share of its text explained by each page (see textScores).
function textIndex(pageTexts, frameTexts, scripts) {
  const P = pageTexts.length;
  const F = frameTexts.length;
  const pdf = new Map();
  const pageBags = pageTexts.map((t) => {
    const b = wordBag(slideWords(t, scripts));
    for (const w of b.keys()) pdf.set(w, (pdf.get(w) || 0) + 1);
    return b;
  });
  const idf = (w) => Math.log((P + 1) / (pdf.get(w) + 0.5));
  // Inverted index of the pages' weighted words.
  const post = new Map();
  const pnorm = new Float64Array(P);
  pageBags.forEach((b, p) => {
    for (const [w, c] of b) {
      const x = (1 + Math.log(c)) * idf(w);
      if (x <= 0) continue;
      pnorm[p] += x * x;
      let l = post.get(w);
      if (!l) post.set(w, (l = []));
      l.push(p, x);
    }
  });
  for (let p = 0; p < P; p++) pnorm[p] = Math.sqrt(pnorm[p]) || 1;
  const raw = new Int32Array(F);
  const allBags = frameTexts.map((t, f) => { const ws = slideWords(t, scripts); raw[f] = ws.length; return wordBag(ws); });
  const frameBags = allBags.map((b) => new Map([...b].filter(([w]) => post.has(w))));
  const fdf = new Map();
  for (const b of allBags) for (const w of b.keys()) fdf.set(w, (fdf.get(w) || 0) + 1);
  // Share of the information a word carries among the pictures: 1 for a word on one
  // picture, near 0 for a word on all of them.
  const lf = Math.log(F + 1);
  const fw = (w) => (F > 1 ? Math.log((F + 1) / fdf.get(w)) / lf : 1);
  const row = (f, scores, explained, o, acc) => {
    const b = frameBags[f];
    acc.fill(0);
    if (explained) {
      let all = 0;
      for (const w of allBags[f].keys()) all += fw(w) ** 2;
      if (all > 0) {
        for (const w of b.keys()) {
          const x = fw(w) ** 2 / all;
          const l = post.get(w);
          for (let k = 0; k < l.length; k += 2) explained[o + l[k]] += x;
        }
      }
    }
    let n2 = 0;
    for (const [w, c] of b) {
      const x = (1 + Math.log(c)) * idf(w) * fw(w);
      if (x <= 0) continue;
      n2 += x * x;
      const l = post.get(w);
      for (let k = 0; k < l.length; k += 2) acc[l[k]] += x * l[k + 1];
    }
    const n = Math.sqrt(n2) || 1;
    for (let p = 0; p < P; p++) scores[o + p] = acc[p] / (n * pnorm[p]);
  };
  return { P, F, raw, row, frameBags, pageWords: Int32Array.from(pageBags, (b) => [...b.keys()].filter((w) => idf(w) > 0).length) };
}

// scores[f * P + p]: cosine between picture f and page p. explained[f * P + p]: share of
// the picture's text that is on page p (each word weighted by how rare it is among the
// pictures, so the viewer's own words count little): a slide on screen, even zoomed in,
// explains much of what is readable; a code editor showing the slide's code next to a file
// tree, menus and other code does not. words[f]: distinct page words in picture f.
function textScores(pageTexts, frameTexts, scripts) {
  const { P, F, raw, row, frameBags, pageWords } = textIndex(pageTexts, frameTexts, scripts);
  const scores = new Float32Array(F * P);
  const explained = new Float32Array(F * P);
  const words = new Int32Array(F);
  const acc = new Float64Array(P);
  for (let f = 0; f < F; f++) {
    row(f, scores, explained, f * P, acc);
    words[f] = frameBags[f].size;
  }
  return { scores, explained, words, raw, P, F, pageWords };
}

// Cosine similarity between page b and every page, from their text alone: sim(b) is a row of
// the P x P matrix, computed when first asked for (only the rows of pages some picture is
// closest to are used, and a whole matrix of a long PDF would take P^2 memory).
function pageSimilarity(pageTexts, scripts) {
  const { P, row } = textIndex(pageTexts, pageTexts, scripts);
  const rows = new Map();
  const acc = new Float64Array(P);
  return (b) => {
    let r = rows.get(b);
    if (!r) { row(b, (r = new Float32Array(P)), null, 0, acc); rows.set(b, r); }
    return r;
  };
}

// ---- evidence ----

// Log-likelihood ratio "this page is on screen" vs "it is not", learnt from the lecture's
// own scores (see the top of the file), from two measures of a picture and a page: the
// cosine and the share of the picture's text explained by the page. Each has a normal
// distribution under "wrong", fitted to every picture's second best page (always a wrong
// page) together with the best pages it explains, and one under "right", fitted to the
// best pages it explains; the share of "right" is fitted along (EM). Returns
// { llr(score, explained), right, wrong } (means and spreads of both measures).
function scoreModel(ts, pageSim) {
  const { scores, explained, words, P, F } = ts;
  const best = [];
  const second = [];
  for (let f = 0; f < F; f++) {
    if (!words[f]) continue;
    let b = -1;
    let bi = -1;
    for (let p = 0; p < P; p++) if (scores[f * P + p] > b) { b = scores[f * P + p]; bi = p; }
    // Pages at least as close to the best page as the picture is cannot be told apart
    // from it: they are not "wrong".
    const near = pageSim(bi);
    let si = -1;
    for (let p = 0; p < P; p++) if (p !== bi && near[p] < b && (si < 0 || scores[f * P + p] > scores[f * P + si])) si = p;
    best.push([b, explained[f * P + bi]]);
    second.push(si >= 0 ? [scores[f * P + si], explained[f * P + si]] : [0, 0]);
  }
  const fit = (xs, ws, d) => {
    let sw = 0;
    let sx = 0;
    let sxx = 0;
    xs.forEach((x, i) => { const w = ws ? ws[i] : 1; sw += w; sx += w * x[d]; sxx += w * x[d] * x[d]; });
    const mean = sw ? sx / sw : 0;
    return { mean, sd: Math.max(Math.sqrt(Math.max(0, sxx / (sw || 1) - mean * mean)), EVIDENCE_MIN_SD), w: sw };
  };
  const pdf = (d, x) => Math.exp(-0.5 * ((x - d.mean) / d.sd) ** 2) / (d.sd * Math.sqrt(2 * Math.PI));
  const fit2 = (xs, ws) => [fit(xs, ws, 0), fit(xs, ws, 1)];
  const pdf2 = (m, x) => pdf(m[0], x[0]) * pdf(m[1], x[1]);
  let wrong = fit2(second);
  let right = [{ mean: Math.max(0, ...best.map((x) => x[0])), sd: 0.1 }, { mean: Math.max(0, ...best.map((x) => x[1])), sd: 0.1 }];
  let share = 0.5;
  const resp = new Float64Array(best.length);
  const ones = second.map(() => 1);
  for (let it = 0; it < EVIDENCE_EM_ROUNDS && best.length; it++) {
    best.forEach((x, i) => {
      const a = share * pdf2(right, x);
      const b = (1 - share) * pdf2(wrong, x);
      resp[i] = a + b > 0 ? a / (a + b) : (x[0] > wrong[0].mean ? 1 : 0);
    });
    const w = resp.reduce((t, x) => t + x, 0);
    share = w / best.length;
    if (w < 0.5) { share = 0; break; }
    right = fit2(best, resp);
    wrong = fit2(second.concat(best), ones.concat(Array.from(resp, (x) => 1 - x)));
  }
  // Per measure, on a grid, made non-decreasing: a higher value is never weaker evidence,
  // and a value above the typical right one is no stronger than it.
  const n = EVIDENCE_GRID;
  const grid = (r, q) => {
    const g = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = Math.min(i / (n - 1), r.mean);
      // "right" with a share of outliers, uniform over 0-1 (EVIDENCE_OUTLIER).
      const v = share > 0 ? Math.log((1 - EVIDENCE_OUTLIER) * pdf(r, x) + EVIDENCE_OUTLIER) - Math.log(pdf(q, x)) : EVIDENCE_FLOOR;
      g[i] = Math.max(i ? g[i - 1] : -Infinity, isFinite(v) ? v : EVIDENCE_FLOOR);
    }
    return g;
  };
  const g0 = grid(right[0], wrong[0]);
  const g1 = grid(right[1], wrong[1]);
  const at = (g, x) => g[Math.max(0, Math.min(n - 1, Math.round(x * (n - 1))))];
  const llr = (s, e) => at(g0, s) + at(g1, e);
  const sum = (m) => ({ score: [m[0].mean, m[0].sd], explained: [m[1].mean, m[1].sd] });
  return { llr, right: Object.assign({ share }, sum(right)), wrong: sum(wrong) };
}

// Evidence for each picture and page: ev[f * P + p] (log-likelihood ratio against "not a
// slide"). A page without any text gives no evidence: where it was shown follows from the
// pages around it. A picture with nothing readable at all (a camera, a black screen) is
// taken as not showing any page: a page on screen always comes with some text, if only a
// title or the viewer around it.
function slideEvidence(ts, model) {
  const { scores, explained, P, F, pageWords, raw } = ts;
  const ev = new Float32Array(F * P);
  const none = model.llr(0, 0);
  for (let f = 0; f < F; f++) {
    for (let p = 0; p < P; p++) ev[f * P + p] = !raw[f] ? none : pageWords[p] ? model.llr(scores[f * P + p], explained[f * P + p]) : 0;
  }
  return ev;
}

// ---- sequence ----

// Moves between two pictures in a row: SLIDE_MOVES (02-tuning.js).

// ev: evidence per picture (F x P); fileOf[p]: file of page p; seq[t]: picture shown at
// step t (time order, one step per distinct picture); force[t] (optional): the user's
// correction for step t (a page, FORCE_OFF for "not a slide", -1 for none). Returns per
// step a page index or -1 (not a slide).
const FORCE_OFF = -2;

function decodeSlides(ev, P, fileOf, seq, force) {
  const S = 2 * P + 1;    // pages, "not a slide" after page p, "not a slide" before any page
  const NONE = 2 * P;
  const T = seq.length;
  const files = [];
  for (let p = 0; p < P; p++) (files[fileOf[p]] ||= []).push(p);
  const nf = files.length;
  const M = SLIDE_MOVES;
  const back = new Int32Array(T * S);
  const emit = (t, V) => {
    const f = seq[t];
    if (f >= 0) for (let p = 0; p < P; p++) V[p] += ev[f * P + p];
    const k = force ? force[t] : -1;
    if (k >= 0) { for (let s = 0; s < S; s++) if (s !== k) V[s] = -Infinity; } else if (k === FORCE_OFF) for (let p = 0; p < P; p++) V[p] = -Infinity;
  };
  let V = new Float64Array(S).fill(-Infinity);
  for (let p = 0; p < P; p++) V[p] = -Math.log(2 * P);
  V[NONE] = -Math.log(2);
  if (T) emit(0, V);
  const fileBest = new Float64Array(nf);
  const fileArg = new Int32Array(nf);
  const offBest = new Float64Array(nf);
  const offArg = new Int32Array(nf);
  // Best and second best file, for moves into another file.
  const top = (arr) => {
    let a = -1;
    let b = -1;
    for (let k = 0; k < nf; k++) if (a < 0 || arr[k] > arr[a]) { b = a; a = k; } else if (b < 0 || arr[k] > arr[b]) b = k;
    return [a, b];
  };
  for (let t = 1; t < T; t++) {
    const N = new Float64Array(S).fill(-Infinity);
    const B = back.subarray(t * S, (t + 1) * S);
    fileBest.fill(-Infinity);
    offBest.fill(-Infinity);
    for (let p = 0; p < P; p++) {
      const k = fileOf[p];
      if (V[p] > fileBest[k]) { fileBest[k] = V[p]; fileArg[k] = p; }
      if (V[P + p] > offBest[k]) { offBest[k] = V[P + p]; offArg[k] = P + p; }
    }
    const [fa, fb] = top(fileBest);
    const [oa, ob] = top(offBest);
    for (let q = 0; q < P; q++) {
      const k = fileOf[q];
      const n = files[k].length;
      const same = (r) => r >= 0 && r < P && fileOf[r] === k;
      let best = V[q] + M.stay;
      let arg = q;
      const from = (s, v) => { if (v > best) { best = v; arg = s; } };
      if (same(q - 1)) { from(q - 1, V[q - 1] + M.next); from(P + q - 1, V[P + q - 1] + M.offNext); }
      if (same(q + 1)) from(q + 1, V[q + 1] + M.back);
      from(P + q, V[P + q] + M.offBack);
      from(fileArg[k], fileBest[k] + M.jump - Math.log(n));
      from(offArg[k], offBest[k] + M.offJump - Math.log(n));
      const of = fa !== k ? fa : fb;
      if (of >= 0) from(fileArg[of], fileBest[of] + M.file - Math.log(n));
      const oo = oa !== k ? oa : ob;
      if (oo >= 0) from(offArg[oo], offBest[oo] + M.offFile - Math.log(n));
      from(NONE, V[NONE] + M.offJump - Math.log(P));
      N[q] = best;
      B[q] = arg;
      const a = V[q] + M.off;
      const b = V[P + q] + M.offStay;
      N[P + q] = a >= b ? a : b;
      B[P + q] = a >= b ? q : P + q;
    }
    N[NONE] = V[NONE] + M.offStay;
    B[NONE] = NONE;
    emit(t, N);
    V = N;
  }
  let s = 0;
  for (let i = 1; i < S; i++) if (V[i] > V[s]) s = i;
  const out = new Int32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    out[t] = s < P ? s : -1;
    if (t > 0) s = back[t * S + s];
  }
  return out;
}

// ---- one lecture ----

// input: { pageTexts: [string], fileOf: [file index per page], texts: [string] (each
// distinct picture read), at: [per sample: index into texts, -1 = not read yet],
// force: [per sample: page, FORCE_OFF or -1] (optional), scripts: what text recognition
// reads (see slideWords; optional) }.
// Returns { pages: Int32Array per sample (page index, -1 = not a slide, -2 = not read yet),
// model }.
function followLecture(input) {
  const P = input.pageTexts.length;
  const at = input.at;
  const force = input.force || [];
  const out = new Int32Array(at.length).fill(-2);
  if (!P || !input.texts.length) return { pages: out, model: null };
  const ts = textScores(input.pageTexts, input.texts, input.scripts);
  const model = scoreModel(ts, pageSimilarity(input.pageTexts, input.scripts));
  const ev = slideEvidence(ts, model);
  // One step per run of samples showing the same picture (with the same correction).
  const seq = [];
  const fs = [];
  const stepOf = new Int32Array(at.length).fill(-1);
  for (let i = 0; i < at.length; i++) {
    if (at[i] < 0) continue;
    const k = force[i] == null ? -1 : force[i];
    const last = seq.length - 1;
    if (last >= 0 && seq[last] === at[i] && fs[last] === k && stepOf[i - 1] === last) { stepOf[i] = last; continue; }
    seq.push(at[i]);
    fs.push(k);
    stepOf[i] = seq.length - 1;
  }
  const states = decodeSlides(ev, P, Int32Array.from(input.fileOf), seq, fs);
  for (let i = 0; i < at.length; i++) if (stepOf[i] >= 0) out[i] = states[stepOf[i]];
  return { pages: out, model: { right: model.right, wrong: model.wrong } };
}

// ---- the Worker ----

// Source of a Worker running followLecture, assembled from the functions above so the code
// that runs is exactly the code in this file.
function slideTextWorkerSource() {
  const fns = [slideWords, wordBag, textIndex, textScores, pageSimilarity, scoreModel, slideEvidence, decodeSlides, followLecture];
  return '"use strict";\n'
    + 'const SLIDE_STOP = new Set(' + JSON.stringify([...SLIDE_STOP]) + ');\n'
    + 'const WORD_RE = new RegExp(' + JSON.stringify(WORD_RE.source) + ', ' + JSON.stringify(WORD_RE.flags) + ');\n'
    + 'const SLIDE_MOVES = ' + JSON.stringify(SLIDE_MOVES) + ';\n'
    + 'const EVIDENCE_GRID = ' + EVIDENCE_GRID + ';\n'
    + 'const EVIDENCE_MIN_SD = ' + EVIDENCE_MIN_SD + ';\n'
    + 'const EVIDENCE_FLOOR = ' + EVIDENCE_FLOOR + ';\n'
    + 'const EVIDENCE_EM_ROUNDS = ' + EVIDENCE_EM_ROUNDS + ';\n'
    + 'const EVIDENCE_OUTLIER = ' + EVIDENCE_OUTLIER + ';\n'
    + 'const FORCE_OFF = ' + FORCE_OFF + ';\n'
    + fns.map((f) => f.toString()).join('\n\n') + '\n'
    + 'self.onmessage = (e) => {\n'
    + '  const t0 = Date.now();\n'
    + '  try { const r = followLecture(e.data.input); r.ms = Date.now() - t0; self.postMessage({ id: e.data.id, ok: true, result: r }, [r.pages.buffer]); }\n'
    + '  catch (err) { self.postMessage({ id: e.data.id, ok: false, error: String((err && err.message) || err) }); }\n'
    + '};\n';
}

// One Worker for a player's lifetime; run(input) resolves with followLecture's result.
class SlideTextWorker {
  constructor(disposer) {
    this.worker = null;
    this.seq = 0;
    this.waiting = new Map();
    disposer.add(() => this.close());
  }

  run(input) {
    // Closed with the player: never start a new Worker afterwards.
    if (this.closed) return Promise.reject(new Error('closed'));
    if (!this.worker) {
      const url = URL.createObjectURL(new Blob([slideTextWorkerSource()], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
      this.worker.onmessage = (e) => {
        const w = this.waiting.get(e.data.id);
        if (!w) return;
        this.waiting.delete(e.data.id);
        if (e.data.ok) w.resolve(e.data.result); else w.reject(new Error(e.data.error));
      };
      this.worker.onerror = (e) => {
        for (const w of this.waiting.values()) w.reject(new Error(e.message || 'worker error'));
        this.waiting.clear();
      };
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, input });
    });
  }

  close() {
    this.closed = true;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error('closed'));
    this.waiting.clear();
  }
}

// ---- 68-slide-deck.js ----
// ===================================================================================
// The lecturer's slide files (PDF) for a recording: loading, local storage, following the
// lecture, and the user's corrections.
//
// The PDF is the user's: they can page through it freely and remove it at any time.
// Following the lecture only turns the page for them until they take over.
//
// Which page is on screen comes from the text on the screen view, every CHAPTER_STEP_SEC
// across the lecture: 66-slide-ocr.js reads it, 67-slide-text.js decides the pages (in a Worker).
//
// Files never leave the browser: they are kept in IndexedDB (by SHA-256), remembered per
// recording. pdf.js is loaded from jsDelivr (pinned) only when a recording has slide files.
//
// Stored records:
//   deck:<mediaId>        { files: [{ hash, name }], fixes: [{ a, b, page: <page key> | 'none' }] }
//   deckfile:<hash>       Blob of the PDF
//   deckref:<hash>        [mediaId] recordings using the file (deleted with the last one)
// A correction covers a part of the lecture (a to b, in seconds); a page key is
// "<hash prefix>:<page>", so it survives reordering files.
//
// For later features (slide text as vocabulary for transcription, chapter titles):
// controller.pages[i] = { key, file, num, title, text }.
// ===================================================================================

const PDFJS_DIR = 'pdfjs-dist@6.4.299/build/';

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = platform.importLib(PDFJS_DIR + 'pdf.min.mjs');
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

// pdf.js's worker for one controller: a module worker from the checked worker script (a
// worker URL from another origin cannot be used directly). Ended by its owner.
function pdfWorkerUrl() {
  return platform.libBlobUrl(PDFJS_DIR + 'pdf.worker.min.mjs');
}
function makePdfWorker(lib, url) {
  const port = new Worker(url, { type: 'module' });
  return { port, pdf: new lib.PDFWorker({ port }) };
}

// The page's title: the largest text in the top PAGE_TITLE_TOP of the page.
function pageTitle(items, pageHeight) {
  let size = 0;
  for (const it of items) if (it.str.trim() && it.transform[5] > pageHeight * (1 - PAGE_TITLE_TOP)) size = Math.max(size, it.height);
  if (!size) return '';
  return items.filter((it) => it.str.trim() && it.transform[5] > pageHeight * (1 - PAGE_TITLE_TOP) && Math.abs(it.height - size) < 1)
    .map((it) => it.str.trim()).join(' ').slice(0, 1000).replace(/\s+/g, ' ').slice(0, 120);
}

// A page's key is this prefix (its file) and the page number.
function pageKeyPrefix(fileHash) {
  return fileHash.slice(0, 12) + ':';
}
function pageKeyFile(key) {
  return key.slice(0, key.indexOf(':') + 1);
}

// Page drawn `width` pixels wide, or smaller when that would pass the size limits for one
// page (the picture is shown scaled to its place either way).
function renderPdfPage(page, width) {
  const base = page.getViewport({ scale: 1 });
  const bw = base.width;
  const bh = base.height;
  if (!(bw > 0 && bh > 0 && Number.isFinite(bw) && Number.isFinite(bh))) throw new Error('bad page size');
  const scale = Math.min(width / bw, PAGE_RENDER_MAX_SIDE / bw, PAGE_RENDER_MAX_SIDE / bh, Math.sqrt(PAGE_RENDER_MAX_PX / (bw * bh)));
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(bw * scale));
  c.height = Math.max(1, Math.floor(bh * scale));
  const t0 = performance.now();
  return page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise.then(() => {
    usageNote('work', 'pdfMpx', (performance.now() - t0) / (c.width * c.height / 1e6));
    return c;
  });
}

// The page to show at each sample while following. pages[i]: from followLecture (a page,
// -1 not a slide, -2 not read yet); times[i]: when sample i starts; end: when the last one
// ends. Where no page is on screen the page shown before stays. A quick look at another
// page (a stretch shorter than minSec between two stretches of the same page) does not
// turn the page. Before the first page, that page is shown. Returns page indexes (-1 only
// when no page is known at all).
function followSamples(times, pages, minSec, end) {
  const min = minSec == null ? FOLLOW_MIN_SEC : minSec;
  const n = pages.length;
  // Without an end, the last sample lasts as long as the one before it.
  const tEnd = end == null ? (n ? times[n - 1] + (n > 1 ? times[n - 1] - times[n - 2] : 0) : 0) : end;
  // Stretches of one page: [{ p, a, b }] (samples a..b), ended by anything else.
  const runs = [];
  for (let i = 0; i < n; i++) {
    const p = pages[i];
    if (p < 0) continue;
    const last = runs[runs.length - 1];
    if (last && last.p === p && last.b === i - 1) last.b = i; else runs.push({ p, a: i, b: i });
  }
  const keep = runs.filter((r, k) => {
    const len = (r.b + 1 < n ? times[r.b + 1] : tEnd) - times[r.a];
    return !(len < min && k > 0 && k + 1 < runs.length && runs[k - 1].p === runs[k + 1].p && runs[k - 1].p !== r.p);
  });
  const out = new Int32Array(n);
  let k = 0;
  let cur = keep.length ? keep[0].p : -1;
  for (let i = 0; i < n; i++) {
    while (k < keep.length && keep[k].a <= i) { cur = keep[k].p; k++; }
    out[i] = cur;
  }
  return out;
}

class SlideDeckController {
  // opts: { lesson, video, slides (SlideAnalyzer: which view is the screen), disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.slides = opts.slides;
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('slide reader (display)', e); } };
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.files = [];          // [{ hash, name }]
    this.docs = [];           // pdf.js loading tasks of the open documents, per file
    /** @type {DeckPage[]} */
    this.pages = [];
    this.capped = false;      // more pages than DECK_MAX_PAGES: the rest are not read
    this.fixes = [];          // the user's corrections [{ a, b, page }]
    this.ocr = null;          // SlideTextReader
    this.worker = new SlideTextWorker(this.d);
    this.decided = null;      // per sample: page, -1 not a slide, -2 not read (followLecture)
    this.shown = null;        // per sample: page to show while following
    this.decidedAt = 0;
    this.deciding = null;
    this.state = 'empty';     // empty | loading | reading | ready | error
    this.corrections = 0;     // pages corrected by hand in this visit (usage data)
    this.error = '';
    this.notice = '';         // why the last file added or removed was not (the deck goes on)
    this.job = null;
    this.rendered = new Map(); // page key -> { c: canvas (newest size), w: width asked for }, least recently used first
    this.pdfWorker = null;     // pdf.js worker (makePdfWorker), owned here
    this.d.add(() => this.closeDocs());
  }

  get key() { return 'deck:' + this.lesson.mediaId; }

  get progress() { return this.ocr ? this.ocr.progress() : 0; }

  // Closes the open documents (through their loading tasks, which own them in pdf.js), and
  // pdf.js's worker when no document is left to use it.
  closeDocs(keepWorker) {
    for (const task of this.docs) task.destroy().catch(() => {});
    this.docs = [];
    this.rendered.clear();
    if (!keepWorker && this.pdfWorker) {
      try { this.pdfWorker.pdf.destroy(); } catch (e) { /* ignore */ }
      this.pdfWorker.port.terminate();
      this.pdfWorker = null;
    }
  }

  async restore() {
    if (!this.lesson.mediaId) return;
    const rec = await idbCache.get(this.key);
    if (!rec || !Array.isArray(rec.files) || !rec.files.length) return;
    this.files = rec.files;
    this.fixes = Array.isArray(rec.fixes) ? rec.fixes : [];
    await this.reload();
  }

  // op({ files, fixes }) changes the record in place: applied here now, then to the stored
  // record in one transaction. Another tab may have changed it meanwhile (added a file, made
  // a correction), so this tab's copy is never written back whole; if the stored files
  // differ afterwards, this tab takes them over. `stored(old, out, mid)`, when given, changes
  // the PDF files and their lists of users (deckfile:, deckref:) in the same transaction:
  // `old` holds the deckref: entries of `hashes`. Rejects when it could not be written.
  async changeRecord(op, hashes, stored) {
    op(this);
    const mid = this.lesson.mediaId;
    if (!mid && !stored) return;
    const keys = (mid ? [this.key] : []).concat((hashes || []).map((h) => 'deckref:' + h));
    const out = await idbCache.updateMany(keys, (old) => {
      const next = {};
      if (mid) {
        const rec = old[this.key];
        const st = { files: rec && Array.isArray(rec.files) ? rec.files : [], fixes: rec && Array.isArray(rec.fixes) ? rec.fixes : [] };
        op(st);
        next[this.key] = { files: st.files, fixes: st.fixes };
      }
      if (stored) stored(old, next, mid);
      return next;
    });
    const rec = out && mid && out[this.key];
    if (!rec || this.ac.signal.aborted) return;
    this.fixes = rec.fixes;
    if (JSON.stringify(rec.files) !== JSON.stringify(this.files)) {
      this.files = rec.files;
      this.reload();
    }
  }

  // A change of the corrections only: a failure is logged.
  changeFixes(op) {
    this.changeRecord(op).catch((e) => log.warn('slide files:', e));
  }

  // Adds PDF files (from a drop or a file picker). Returns how many were PDFs.
  async addFiles(fileList) {
    const pdfs = [...fileList].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) return 0;
    telemetry.use('pdfAdd');
    this.notice = '';
    const big = pdfs.filter((f) => f.size > DECK_MAX_FILE_BYTES);
    if (big.length) {
      this.notice = tr('deckTooBig', { name: big.map((f) => f.name).join(tr('sepList')), max: Math.round(DECK_MAX_FILE_BYTES / 1024 / 1024) });
      this.onChange();
      throw new Error(this.notice);
    }
    const added = [];
    const blobs = new Map();
    for (const f of pdfs) {
      const buf = await f.arrayBuffer();
      const hash = await sha256Hex(buf);
      if (this.files.some((x) => x.hash === hash) || added.some((x) => x.hash === hash)) continue;
      added.push({ hash, name: f.name });
      blobs.set(hash, new Blob([buf], { type: 'application/pdf' }));
    }
    // The files, their lists of users and this recording's list in one transaction: another
    // tab removing the same file from its recording cannot delete it in between. The files
    // must really be stored (a full disk would otherwise lose them silently on the next visit).
    try {
      if (added.length) {
        await this.changeRecord((st) => { for (const a of added) if (!st.files.some((x) => x.hash === a.hash)) st.files.push(a); },
          added.map((a) => a.hash), (old, next, mid) => {
            for (const a of added) {
              const refs = old['deckref:' + a.hash];
              next['deckfile:' + a.hash] = blobs.get(a.hash);
              next['deckref:' + a.hash] = Array.isArray(refs) ? (refs.includes(mid) ? refs : refs.concat(mid)) : [mid];
            }
          });
      }
    } catch (e) {
      this.files = this.files.filter((x) => !added.some((a) => a.hash === x.hash));
      this.notice = tr('deckSaveFailed', { name: added.map((a) => a.name).join(tr('sepList')), msg: (e && e.message) || e });
      this.onChange();
      throw new Error(this.notice);
    }
    await this.reload();
    return pdfs.length;
  }

  // The file itself is deleted when no other recording uses it, in the same transaction as
  // this recording's list (no other tab can add itself in between).
  // When that cannot be saved, the file stays (it would be back on the next visit).
  async removeFile(hash) {
    const prefix = pageKeyPrefix(hash);
    const before = { files: this.files, fixes: this.fixes };
    const file = this.files.find((f) => f.hash === hash);
    this.notice = '';
    try {
      await this.changeRecord((st) => {
        st.files = st.files.filter((f) => f.hash !== hash);
        st.fixes = st.fixes.filter((x) => !String(x.page).startsWith(prefix));
      }, [hash], (old, next, mid) => {
        const refs = (Array.isArray(old['deckref:' + hash]) ? old['deckref:' + hash] : []).filter((m) => m !== mid);
        if (refs.length) next['deckref:' + hash] = refs;
        else { next['deckref:' + hash] = undefined; next['deckfile:' + hash] = undefined; }
      });
    } catch (e) {
      log.warn('slide file removal:', e);
      if (this.ac.signal.aborted) return;
      this.files = before.files;
      this.fixes = before.fixes;
      this.notice = tr('deckRemoveFailed', { name: file ? file.name : '', msg: (e && e.message) || e });
      this.onChange();
      return;
    }
    await this.reload();
  }

  // Opens all files and reads the pages' titles and text, then follows the lecture.
  async reload() {
    const job = {};
    this.job = job;
    this.again = false; // a pending recompute was for the old files
    this.closeDocs(this.files.length > 0);
    this.pages = [];
    this.capped = false;
    this.decided = null;
    this.shown = null;
    if (!this.files.length) {
      this.stopReading();
      this.state = 'empty';
      this.onChange();
      return;
    }
    this.state = 'loading';
    this.onChange();
    try {
      // Replaced by a newer load, or the player is gone: checked after every wait, before
      // anything is made (a Worker made after closing would never be ended).
      const gone = () => this.job !== job || this.ac.signal.aborted;
      const lib = await loadPdfJs();
      if (gone()) return;
      const workerUrl = await pdfWorkerUrl();
      if (gone()) return;
      const pages = [];
      let capped = false;
      for (const f of this.files) {
        const blob = await idbCache.get('deckfile:' + f.hash);
        if (gone()) return;
        if (!blob) continue;
        const data = new Uint8Array(await blob.arrayBuffer());
        if (gone()) return;
        if (!this.pdfWorker) this.pdfWorker = makePdfWorker(lib, workerUrl);
        const task = lib.getDocument({ data, worker: this.pdfWorker.pdf });
        const doc = await task.promise;
        if (gone()) { task.destroy().catch(() => {}); return; }
        this.docs.push(task);
        for (let n = 1; n <= doc.numPages; n++) {
          if (pages.length >= DECK_MAX_PAGES) { capped = true; break; }
          const page = await doc.getPage(n);
          const tc = await page.getTextContent();
          const [x0, y0, x1, y1] = page.view;
          pages.push({
            key: pageKeyPrefix(f.hash) + n, file: f.name, num: n, doc, ar: (y1 - y0) / (x1 - x0),
            title: pageTitle(tc.items, y1 - y0),
            text: tc.items.map((x) => x.str).join(' ').slice(0, DECK_MAX_PAGE_CHARS * 2).replace(/\s+/g, ' ').trim().slice(0, DECK_MAX_PAGE_CHARS),
          });
        }
      }
      if (this.job !== job) return;
      this.pages = pages;
      this.capped = capped;
      this.state = 'reading';
      // Files in another language need the screen read again in that language.
      if (this.ocr && this.ocr.lang !== ocrLanguage(pages.map((x) => x.text))) this.stopReading();
      this.startReading();
      // A reader that has finished already (files added or removed after the screen was
      // read) has no change to come: its state is taken now.
      if (this.followReader()) this.decide(true);
      this.onChange();
    } catch (e) {
      if (this.ac.signal.aborted || this.job !== job) return;
      log.warn('slide file:', e && e.message ? e.message : e);
      this.state = 'error';
      this.error = tr('deckError', { msg: String((e && e.message) || e) });
      this.onChange();
    }
  }

  // Starts reading the screen once it is known which view that is (from the slide
  // analysis; a recording with one view uses that one).
  startReading() {
    if (this.ocr || !this.pages.length) return;
    const sources = this.lesson.sources;
    // The screen view; if the analysis could not tell clearly, its best guess.
    const a = this.slides;
    const idx = a && a.screenIndex != null ? a.screenIndex : a && a.guessScreen != null ? a.guessScreen : sources.length === 1 ? sources[0].index : null;
    if (idx == null) return;
    const source = sources.find((s) => s.index === idx);
    if (!source) return;
    // Owned by its own child of the controller: stopping it (files removed) releases it
    // and its texts, instead of keeping it referenced until the page closes.
    this.ocrD = this.d.child();
    this.ocr = new SlideTextReader({
      lesson: this.lesson, video: this.video, source, disposer: this.ocrD, shared: a || null,
      lang: ocrLanguage(this.pages.map((x) => x.text)),
      onChange: () => this.readingChanged(),
    });
    this.ocr.start();
  }

  stopReading() {
    if (this.ocrD) this.ocrD.dispose();
    this.ocrD = null;
    this.ocr = null;
  }

  // Called when the slide analysis changes (the screen view becomes known, or the user
  // chose another view: reading starts again there).
  screenKnown() {
    const a = this.slides;
    if (this.ocr && a && a.screenIndex != null && this.ocr.source.index !== a.screenIndex) this.stopReading();
    if (this.pages.length && !this.ocr) { this.startReading(); this.onChange(); }
  }

  readingChanged() {
    if (!this.ocr) return;
    if (this.followReader()) this.decide(this.ocr.state === 'done');
    this.onChange();
  }

  // The deck's state from the reader's: an error if it cannot work (false), ready once it
  // is done.
  followReader() {
    const r = this.ocr;
    if (r && r.state === 'unavailable') { this.state = 'error'; this.error = r.error; return false; }
    if (r && r.state === 'done' && this.state === 'reading') this.state = 'ready';
    return true;
  }

  // Decides the pages again from everything read so far (at most every FOLLOW_UPDATE_MS
  // while reading, unless `now`).
  decide(now) {
    const r = this.ocr;
    if (!r || !r.at || !this.pages.length) return;
    if (this.deciding) { this.again = this.again || now; return; }
    if (!now && performance.now() - this.decidedAt < FOLLOW_UPDATE_MS) return;
    this.decidedAt = performance.now();
    const fileOf = this.pages.map((p) => this.files.findIndex((f) => p.key.startsWith(pageKeyPrefix(f.hash))));
    const input = {
      pageTexts: this.pages.map((p) => p.text),
      fileOf,
      texts: r.texts,
      at: Array.from(r.at),
      force: this.forces(r.times),
      scripts: r.scripts,
    };
    const job = this.job;
    this.deciding = this.worker.run(input).then((res) => {
      if (this.job !== job) return;
      this.decided = res.pages;
      this.recompute();
      if (store.get('debug', false)) this.lastModel = res.model;
      this.onChange();
    }).catch((e) => {
      if (!this.ac.signal.aborted) log.warn('slide following:', e && e.message ? e.message : e);
    }).finally(() => {
      this.deciding = null;
      if (this.again && !this.ac.signal.aborted) { this.again = false; this.decide(true); }
    });
  }

  // The corrections as a value per sample (page index, FORCE_OFF or -1).
  forces(times) {
    const out = new Array(times.length).fill(-1);
    for (const x of this.fixes) {
      const v = x.page === 'none' ? FORCE_OFF : this.indexOfKey(x.page);
      if (v === -1) continue;
      for (let i = 0; i < times.length; i++) if (times[i] >= x.a - 0.5 && times[i] < x.b - 0.5) out[i] = v;
    }
    return out;
  }

  recompute() {
    const r = this.ocr;
    this.shown = r && this.decided ? followSamples(r.times, this.decided, FOLLOW_MIN_SEC, this.lesson.duration || r.end || undefined) : null;
  }

  // Page i rendered `width` pixels wide. Kept for reuse within a pixel budget (pages can
  // be 4096 pixels wide when zoomed in): only the newest size of each page, and the least
  // recently used pages go first.
  // Kept by the page's key (file and page number), not its index: an index means another
  // page once the files change, and a render still running for a removed file must not be
  // kept for whatever page has its index now.
  // once: a one-off size (a copy): drawn but not kept, so the page on screen stays cached.
  async render(i, width, once) {
    const w = Math.round(width);
    const pg = this.pages[i];
    if (!pg) throw new Error('no page ' + i);
    const hit = this.rendered.get(pg.key);
    // By the width asked for: a page drawn smaller (renderPdfPage) is still the one asked for.
    if (hit && hit.w === w) {
      this.rendered.delete(pg.key);
      this.rendered.set(pg.key, hit);
      return hit.c;
    }
    const page = await pg.doc.getPage(pg.num);
    const c = await renderPdfPage(page, width);
    // The files changed meanwhile: the picture is not kept (the caller checks whether it
    // still wants it).
    if (once || !this.pages.includes(pg)) return c;
    this.rendered.delete(pg.key);
    this.rendered.set(pg.key, { c, w });
    let px = 0;
    for (const { c: x } of this.rendered.values()) px += x.width * x.height;
    for (const [k, { c: x }] of this.rendered) {
      if (px <= DECK_RENDER_BUDGET || k === pg.key) break;
      px -= x.width * x.height;
      x.width = 0; // releases the canvas memory now
      this.rendered.delete(k);
    }
    return c;
  }

  indexOfKey(k) {
    return k ? this.pages.findIndex((p) => p.key === k) : -1;
  }

  // Index of the sample playing at time t (-1 before reading has started).
  sampleAt(t) {
    const r = this.ocr;
    if (!r || !r.times.length) return -1;
    return Math.max(0, sampleIndexAt(r.times, t));
  }

  // Page to show at time t while following (-1 when nothing is known yet). Samples are
  // CHAPTER_STEP_SEC apart; when the page changes between two of them and the slide analysis found
  // the change in between (to about a second), the page turns there.
  pageAt(t) {
    const k = this.sampleAt(t);
    if (!this.shown || k < 0) return -1;
    const times = this.ocr.times;
    if (k + 1 < this.shown.length && this.shown[k + 1] !== this.shown[k]) {
      const chs = this.slides ? this.slides.chapters : [];
      const c = chapterIndexAt(chs, times[k + 1] - 0.01);
      if (c > 0 && chs[c].precise && chs[c].start > times[k] && t >= chs[c].start) return this.shown[k + 1];
    }
    return this.shown[k];
  }

  // Whether the page at time t was recognised for that very part, rather than carried
  // over from an earlier part.
  knownAt(t) {
    const k = this.sampleAt(t);
    return !!this.decided && k >= 0 && this.decided[k] >= 0;
  }

  // Seconds since a page was last recognised at time t (0 while recognised, Infinity if
  // never). Following stops claiming a page after FOLLOW_STALE_SEC.
  unrecognisedFor(t) {
    const k = this.sampleAt(t);
    if (!this.decided || k < 0) return Infinity;
    if (this.decided[k] >= 0) return 0;
    const times = this.ocr.times;
    for (let j = k - 1; j >= 0; j--) if (this.decided[j] >= 0) return Math.max(0, t - times[j + 1]);
    return Infinity;
  }

  // When page i was on screen: [{ start, end }].
  timesOf(i) {
    const out = [];
    if (!this.decided) return out;
    const times = this.ocr.times;
    const end = (j) => (j + 1 < times.length ? times[j + 1] : this.lesson.duration || this.ocr.end);
    for (let j = 0; j < this.decided.length; j++) {
      if (this.decided[j] !== i) continue;
      const last = out[out.length - 1];
      if (last && last.endSample === j - 1) { last.end = end(j); last.endSample = j; } else out.push({ start: times[j], end: end(j), endSample: j });
    }
    return out;
  }

  // The part of the lecture around time t that shows one thing: the stretch of samples
  // with the same decision. { a, b } in seconds, or null.
  partAt(t) {
    const k = this.sampleAt(t);
    if (!this.decided || k < 0) return null;
    const times = this.ocr.times;
    const v = this.decided[k];
    let a = k;
    let b = k;
    while (a > 0 && this.decided[a - 1] === v) a--;
    while (b + 1 < this.decided.length && this.decided[b + 1] === v) b++;
    return { a: times[a], b: b + 1 < times.length ? times[b + 1] : this.lesson.duration || this.ocr.end };
  }

  // The user's correction for the part playing at time t: a page index, 'none' (not a
  // slide) or null (back to automatic).
  correct(t, value) {
    this.corrections++;
    if (value === null) {
      this.changeFixes((st) => { st.fixes = st.fixes.filter((x) => !(x.a <= t && t < x.b)); });
    } else {
      const part = this.correctionPart(t) || this.partAt(t);
      if (!part) return;
      const fix = { a: part.a, b: part.b, page: value === 'none' ? 'none' : this.pages[value].key };
      this.changeFixes((st) => { st.fixes = st.fixes.filter((x) => x.b <= part.a || x.a >= part.b).concat(fix); });
    }
    this.decide(true);
    this.onChange();
  }

  correctionPart(t) {
    return this.fixes.find((x) => x.a <= t && t < x.b) || null;
  }

  correctionAt(t) {
    const x = this.correctionPart(t);
    return x ? x.page : null;
  }
}

// ---- 70-cpufix.js ----
// ===================================================================================
// Fallback: CPU fix for the original player (styled-components 4.x). Same logic as the
// standalone "Echo360 player CPU fix" script; only started when the original player runs.
//   1. Static global styles are injected once instead of on every render.
//   2. Components that churn through class names (the progress bar bakes the current
//      percentage into its CSS) get their rules in a small sheet of ours, where unused
//      classes are deleted, so the main stylesheet stops growing.
//   3. timeupdate events reach the page at most once per second during normal playback.
// ===================================================================================

const cpuFix = (function () {
  const CHURN_THRESHOLD = 20;
  const KEEP_NEWEST = 4;
  const TIMEUPDATE_MIN_INTERVAL_MS = 1000;
  const state = { gs: false, cs: false, throttleOn: false, disabled: { gs: false, cs: false } };
  let started = false;

  function disable(part, err) {
    if (state.disabled[part]) return;
    state.disabled[part] = true;
    log.warn('cpu-fix part "' + part + '" disabled after an error', err);
  }

  function patchGlobalStyle(proto) {
    const origRender = proto.renderStyles;
    const origRemove = proto.removeStyles;
    const rendered = new WeakMap();
    proto.renderStyles = function (ctx, ss) {
      let skip = false;
      let mark = false;
      if (!state.disabled.gs) {
        try {
          if (this.isStatic === true && ss && typeof ss.hasId === 'function') {
            const set = rendered.get(ss);
            skip = !!set && set.has(this) && ss.hasId(this.componentId);
            mark = !skip;
          }
        } catch (e) { disable('gs', e); skip = mark = false; }
      }
      if (skip) return undefined;
      const result = origRender.apply(this, arguments);
      if (mark) {
        let set = rendered.get(ss);
        if (!set) rendered.set(ss, (set = new WeakSet()));
        set.add(this);
      }
      return result;
    };
    proto.removeStyles = function (ss) {
      try { const set = rendered.get(ss); if (set) set.delete(this); } catch (e) { /* ignore */ }
      return origRemove.apply(this, arguments);
    };
  }

  const own = { sheet: null, namesById: new Map(), names: new Set() };
  function ownSheet() {
    if (own.sheet && own.sheet.ownerNode && own.sheet.ownerNode.isConnected) return own.sheet;
    const elem = document.createElement('style');
    elem.setAttribute('data-lite-player-for-echo360-cpu-fix', '');
    document.head.appendChild(elem);
    own.sheet = elem.sheet;
    own.names.clear();
    own.namesById.clear();
    return own.sheet;
  }
  function isLocalSheet(ss) {
    const tags = ss && ss.tags;
    if (!Array.isArray(tags) || tags.length === 0) return false;
    return tags.every((tg) => tg && tg.styleTag && tg.styleTag.ownerDocument === document);
  }
  function classRegex(name) { return new RegExp('\\.' + name.replace(/[^\w-]/g, '\\$&') + '(?![\\w-])'); }
  function evict(list) {
    const sheet = own.sheet;
    const keep = [];
    const drop = [];
    list.forEach((name, i) => {
      if (i >= list.length - KEEP_NEWEST || document.getElementsByClassName(name).length > 0) keep.push(name);
      else drop.push(name);
    });
    if (!drop.length) return;
    const res = drop.map(classRegex);
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      if (res.some((re) => re.test(sheet.cssRules[i].cssText))) sheet.deleteRule(i);
    }
    drop.forEach((n) => own.names.delete(n));
    list.length = 0;
    list.push(...keep);
  }
  function addRules(id, name, rules) {
    const sheet = ownSheet();
    for (const r of rules) { try { sheet.insertRule(r, sheet.cssRules.length); } catch (e) { /* ignore */ } }
    own.names.add(name);
    let list = own.namesById.get(id);
    if (!list) own.namesById.set(id, (list = []));
    list.push(name);
    if (list.length > KEEP_NEWEST) evict(list);
  }
  function patchComponentStyle(proto) {
    const origGen = proto.generateAndInjectStyles;
    const churn = new Map();
    proto.generateAndInjectStyles = function (ctx, ss) {
      if (state.disabled.cs) return origGen.apply(this, arguments);
      const id = this.componentId;
      let st;
      try {
        st = churn.get(id);
        if (!st) churn.set(id, (st = { seen: new Set(), active: false }));
        if (st.active && isLocalSheet(ss)) {
          /** @type {{ rules: any, name: string } | null} */
          let captured = null;
          const proxy = new Proxy(ss, {
            get(target, key) {
              if (key === 'hasNameForId') return (cid, name) => (cid === id ? own.names.has(name) : target.hasNameForId(cid, name));
              if (key === 'inject') {
                return (cid, rules, name) => {
                  if (cid === id && typeof name === 'string' && Array.isArray(rules)) captured = { rules, name };
                  else target.inject(cid, rules, name);
                };
              }
              const val = target[key];
              return typeof val === 'function' ? val.bind(target) : val;
            },
          });
          const name = origGen.call(this, ctx, proxy);
          if (captured) addRules(id, captured.name, captured.rules);
          return name;
        }
      } catch (e) { disable('cs', e); return origGen.apply(this, arguments); }
      const name = origGen.apply(this, arguments);
      try {
        if (!st.active && this.isStatic === false && typeof name === 'string') {
          st.seen.add(name);
          if (st.seen.size > CHURN_THRESHOLD) { st.active = true; st.seen = null; }
        }
      } catch (e) { /* ignore */ }
      return name;
    };
  }

  function installThrottle() {
    const last = new WeakMap();
    platform.page.addEventListener('timeupdate', (e) => {
      const v = e.target;
      if (!state.throttleOn || !e.isTrusted || !(v instanceof HTMLMediaElement)) return;
      const now = performance.now();
      const ct = v.currentTime;
      const prev = last.get(v);
      const expected = prev ? prev.media + ((now - prev.wall) / 1000) * (v.playbackRate || 1) : NaN;
      if (!prev || v.paused || v.seeking || v.ended || !(Math.abs(ct - expected) < 1) || now - prev.wall >= TIMEUPDATE_MIN_INTERVAL_MS) {
        last.set(v, { wall: now, media: ct });
        return;
      }
      e.stopImmediatePropagation();
    }, true);
  }

  function scan() {
    let gsProto = null;
    let csProto = null;
    for (const elem of document.querySelectorAll('body, body *')) {
      const c = /** @type {any} */ (elem)._reactRootContainer;  // React 17's root, on its container element
      const root = c && (c._internalRoot || c);
      if (!root || !root.current) continue;
      const stack = [root.current];
      while (stack.length && !(gsProto && csProto)) {
        const f = stack.pop();
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
        const gs = f.stateNode && f.stateNode.state && f.stateNode.state.globalStyle;
        if (!gsProto && gs && typeof gs.componentId === 'string' && typeof gs.isStatic === 'boolean') {
          const p = Object.getPrototypeOf(gs);
          if (p && ['renderStyles', 'removeStyles', 'createStyles'].every((k) => typeof p[k] === 'function')) gsProto = p;
        }
        const cs = f.memoizedProps && f.memoizedProps.forwardedComponent && f.memoizedProps.forwardedComponent.componentStyle;
        if (!csProto && cs && typeof cs.componentId === 'string' && typeof cs.isStatic === 'boolean' && Array.isArray(cs.rules)) {
          const p = Object.getPrototypeOf(cs);
          if (p && typeof p.generateAndInjectStyles === 'function' && p.generateAndInjectStyles.length === 2) csProto = p;
        }
      }
    }
    return { gsProto, csProto };
  }

  // Polls once a second (at most 60 s) until the original player's styled-components
  // internals are found and patched, then stops.
  function start() {
    if (started) return;
    started = true;
    installThrottle();
    const t0 = Date.now();
    const timer = setInterval(() => {
      const elem = document.querySelector('style[data-styled-version]');
      const ver = elem && elem.getAttribute('data-styled-version');
      if (ver && !/^4\./.test(ver)) { clearInterval(timer); log.info('cpu-fix inactive: styled-components ' + ver); return; }
      if (ver) {
        try {
          const { gsProto, csProto } = scan();
          if (gsProto && !state.gs) { patchGlobalStyle(gsProto); state.gs = true; }
          if (csProto && !state.cs) { patchComponentStyle(csProto); state.cs = true; }
        } catch (e) { clearInterval(timer); log.warn('cpu-fix scan failed', e); return; }
      }
      if (state.gs && state.cs) {
        state.throttleOn = true;
        clearInterval(timer);
        log.info('cpu-fix active on the original player');
      } else if (Date.now() - t0 > 60000) {
        clearInterval(timer);
        log.info('cpu-fix inactive: player internals not found');
      }
    }, 1000);
  }

  return { start, state };
})();

// ---- 80-course-list.js ----
// ===================================================================================
// Course page (/section/<id>/home): a small progress bar next to each recording.
//
// It shows two things at once, each only when known:
//   - filled stretches: what was watched on this device (52-watched.js), with the share in
//     words (an empty ending, black screen and silence, does not count);
//   - a tick: where Echo360 says you stopped last time (any device), from the player's
//     properties (one request per opened recording, a few at a time).
// A tooltip says which is which. Light by design: nothing on the page is moved or replaced,
// one small element is added to each lesson row (again if the list is redrawn). Anything
// that fails is skipped without a word.
// ===================================================================================

const courseList = {
  matches() {
    return isEcho360Host() && /^\/section\/[^/]+\/home/.test(location.pathname);
  },

  start() {
    let section = location.pathname.split('/')[2];
    const known = new Map();   // lessonId -> label info (null while loading)
    let server = null;         // promise of { lessonId: { mediaId, read } } from the syllabus
    const style = document.createElement('style');
    style.textContent = '.lp360-watch{display:inline-flex;align-items:center;gap:6px;margin-left:12px;font-size:12px;line-height:18px;'
      + 'vertical-align:middle;color:#1d6b4f;white-space:nowrap}'
      + '.lp360-bar{position:relative;width:72px;height:6px;border-radius:3px;background:#e2e8f0;overflow:hidden}'
      + '.lp360-bar i{position:absolute;top:0;bottom:0;background:#2f855a}'
      + '.lp360-bar b{position:absolute;top:-1px;bottom:-1px;width:2px;margin-left:-1px;background:#2d3748}'
      + '.lp360-watch.lp360-done{color:#22543d;font-weight:600}.lp360-watch .lp360-last{color:#4a5568}';

    const syllabus = () => {
      if (!server) {
        server = fetchSyllabus(section)
          .then((data) => {
            const out = {};
            for (const x of data) {
              const l = x.lesson;
              const m = l && l.medias && l.medias[0];
              if (l && l.lesson && m) out[l.lesson.id] = { mediaId: m.id, read: !!m.isRead };
            }
            return out;
          })
          .catch(() => ({}));
      }
      return server;
    };

    const queue = [];
    let running = 0;
    const pump = () => {
      while (running < LIST_CONCURRENT && queue.length) {
        const job = queue.shift();
        running++;
        job().catch(() => {}).finally(() => { running--; setTimeout(pump, LIST_GAP_MS); });
      }
    };

    const label = (row, info) => {
      const host = row.querySelector('.header-details') || row.querySelector('header') || row;
      let elem = host.querySelector('.lp360-watch');
      if (!info) { if (elem) elem.remove(); return; }
      if (!elem) { elem = document.createElement('span'); host.append(elem); }
      elem.textContent = '';
      const bar = document.createElement('span');
      bar.className = 'lp360-bar';
      const dur = info.dur;
      const tips = [];
      if (info.ranges) {
        for (const [a, b] of info.ranges) {
          const i = document.createElement('i');
          i.style.left = ((Math.max(0, a) / dur) * 100).toFixed(2) + '%';
          i.style.width = (((Math.min(b, dur) - Math.max(0, a)) / dur) * 100).toFixed(2) + '%';
          bar.append(i);
        }
      }
      if (info.last != null) {
        const b = document.createElement('b');
        b.style.left = Math.min(100, (info.last / dur) * 100).toFixed(2) + '%';
        bar.append(b);
      }
      elem.append(bar);
      const txt = document.createElement('span');
      if (info.ranges) {
        const pct = Math.max(1, Math.round(info.share * 100)); // never "0%" for something watched
        txt.textContent = tr('listWatched', { pct });
        tips.push(tr('listWatchedTitle', { pct }));
        elem.className = 'lp360-watch' + (pct >= LIST_DONE_PCT ? ' lp360-done' : '');
      } else {
        txt.textContent = tr('listLastAt', { time: fmtTime(info.last) });
        txt.className = 'lp360-last';
        elem.className = 'lp360-watch';
      }
      if (info.last != null) tips.push(tr('listLastAtTitle', { time: fmtTime(info.last) }));
      elem.append(txt);
      elem.title = tips.join('; ');
    };

    // { dur, ranges, share } from this device and/or { last } from Echo360; null if neither.
    const lookup = async (lid) => {
      const rec = await idbCache.get('watched:' + lid);
      const out = {};
      if (rec && rec.d > 0 && Array.isArray(rec.r) && rec.r.length) {
        out.dur = rec.d;
        out.ranges = rec.r;
        out.share = watchedShare(rec);
      }
      const s = (await syllabus())[lid];
      if (s && s.read) {
        try {
          const r = await fetch('/api/ui/echoplayer/lessons/' + encodeURIComponent(lid) + '/media/' + encodeURIComponent(s.mediaId) + '/player-properties',
            { credentials: 'include', headers: { Accept: 'application/json' }, signal: requestSignal() });
          if (r.ok) {
            const d = (await r.json()).data || {};
            const dur = parseIsoDuration(d.playableAudioVideo && d.playableAudioVideo.duration);
            if (dur > 0 && d.lastPlayedToSeconds > 0) { out.last = d.lastPlayedToSeconds; if (!out.dur) out.dur = dur; }
          }
        } catch (e) { /* no tick */ }
      }
      return out.dur ? out : null;
    };

    const scan = () => {
      // The site can move to another course without loading a new page: start over.
      const now = /^\/section\/([^/]+)\/home/.exec(location.pathname);
      if (!now) return;
      if (now[1] !== section) { section = now[1]; known.clear(); server = null; }
      for (const row of document.querySelectorAll('.class-row[data-test-lessonid]')) {
        const lid = row.getAttribute('data-test-lessonid');
        // Rows drawn again lose the label; a row that has it is left alone (labelling is
        // itself a change the observer sees).
        if (known.has(lid)) { if (known.get(lid) && !row.querySelector('.lp360-watch')) label(row, known.get(lid)); continue; }
        known.set(lid, null);
        queue.push(() => lookup(lid).then((info) => {
          known.set(lid, info);
          // Compared, not put in a selector (an id with a backslash would break it).
          for (const r of document.querySelectorAll('.class-row[data-test-lessonid]')) if (r.getAttribute('data-test-lessonid') === lid) label(r, info);
        }));
      }
      pump();
    };

    let pending = 0;
    const observe = () => {
      document.head.append(style);
      scan();
      // The list is drawn by the page's own script and redrawn on sorting or filtering.
      new MutationObserver(() => {
        if (pending) return;
        pending = setTimeout(() => { pending = 0; scan(); }, LIST_DEBOUNCE_MS);
      }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true }); else observe();
  },
};

// ---- 84-sha256.js ----
// SHA-256 (FIPS 180-4) and HMAC-SHA-256 (RFC 2104) that run synchronously. WebCrypto's are
// asynchronous: a usage-data batch signed while the page closes cannot wait for them
// (87-telemetry.js), and the mint proof of work hashes in short idle slices where a Promise
// a hash would cost more than the hash. Tests and a speed benchmark load this file alone, so it
// uses nothing from the others.

const SHA256_K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA256_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const sha256W = new Int32Array(64);   // message schedule, reused (one hash at a time: synchronous)

// One 64-byte block: the 16 big-endian words m[off..off+15] into the state h (8 words).
function sha256Block(h, m, off) {
  const w = sha256W;
  for (let i = 0; i < 16; i++) w[i] = m[off + i];
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15], y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (k + S1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + k) | 0;
}

// The padded message as big-endian words.
function sha256Words(bytes) {
  const len = bytes.length;
  const m = new Int32Array(((len + 9 + 63) >> 6) << 4);
  for (let i = 0; i < len; i++) m[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
  m[len >> 2] |= 0x80 << (24 - (len & 3) * 8);
  m[m.length - 2] = Math.floor(len / 0x20000000);   // length in bits, high word
  m[m.length - 1] = (len * 8) | 0;
  return m;
}

// SHA-256 of a Uint8Array, as a Uint8Array of 32 bytes.
function sha256Sync(bytes) {
  const h = Int32Array.from(SHA256_IV);
  const m = sha256Words(bytes);
  for (let off = 0; off < m.length; off += 16) sha256Block(h, m, off);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = h[i >> 2] >>> (24 - (i & 3) * 8);
  return out;
}

function hmacSha256Sync(key, msg) {
  if (key.length > 64) key = sha256Sync(key);
  const inner = new Uint8Array(64 + msg.length), outer = new Uint8Array(96);
  for (let i = 0; i < 64; i++) {
    const b = key[i] || 0;
    inner[i] = b ^ 0x36;
    outer[i] = b ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha256Sync(inner), 64);
  return sha256Sync(outer);
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

function bytesHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

// Proof of work: looks at nonces from..from+count-1 (whole numbers, written in decimal) for
// one whose SHA-256(prefix + nonce) starts with at least `bits` zero bits; returns it, or -1.
// The prefix is ASCII. Its whole blocks are hashed once; each nonce then costs one or two
// blocks and allocates nothing.
function mintSearch(prefix, bits, from, count) {
  const pre = new Uint8Array(prefix.length);
  for (let i = 0; i < prefix.length; i++) pre[i] = prefix.charCodeAt(i) & 0x7f;
  const skip = (pre.length >> 6) << 6;
  const mid = Int32Array.from(SHA256_IV);
  const head = new Int32Array(skip >> 2);
  for (let i = 0; i < skip; i++) head[i >> 2] |= pre[i] << (24 - (i & 3) * 8);
  for (let off = 0; off < head.length; off += 16) sha256Block(mid, head, off);
  const tail = pre.subarray(skip);
  const m = new Int32Array(32), h = new Int32Array(8), digits = new Uint8Array(20);
  for (let nonce = from, end = from + count; nonce < end; nonce++) {
    let nd = 0;
    for (let v = nonce; ; v = Math.floor(v / 10)) { digits[nd++] = 48 + v % 10; if (v < 10) break; }
    const len = tail.length + nd;
    const words = len + 9 <= 64 ? 16 : 32;
    m.fill(0, 0, words);
    for (let i = 0; i < tail.length; i++) m[i >> 2] |= tail[i] << (24 - (i & 3) * 8);
    for (let j = 0; j < nd; j++) { const i = tail.length + j; m[i >> 2] |= digits[nd - 1 - j] << (24 - (i & 3) * 8); }
    m[len >> 2] |= 0x80 << (24 - (len & 3) * 8);
    m[words - 1] = (skip + len) * 8;
    h.set(mid);
    sha256Block(h, m, 0);
    if (words === 32) sha256Block(h, m, 16);
    let zeros = Math.clz32(h[0]);
    if (zeros === 32) zeros += Math.clz32(h[1]);
    if (zeros >= bits) return nonce;
  }
  return -1;
}

// ---- 85-export.js ----
// ===================================================================================
// Export and backup.
//
// Export: a recording's notes and bookmarks (with their local tags) as Markdown, each with
// a link back to that moment (the lesson page with #t=<seconds>, which this player
// honours). With a slide PDF, the page on screen at each note can go along as a picture;
// the Markdown and the pictures are packed in a zip (for Obsidian and similar). A whole
// course exports one Markdown file per recording (without pictures). Exports never contain
// the video or its address.
//
// Backup: everything that only exists in this browser (tags and which items carry them,
// slide files and their corrections, what was watched, settings and positions), optionally
// with the PDF files, in one JSON file that can be restored in another browser. Analysis
// caches (slides, silence, text on screen) are left out: they are rebuilt.
// ===================================================================================

// ---- zip (stored, no compression: the pictures are PNG already) ----

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Uint8Array }] -> Blob (application/zip). Names are UTF-8.
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);          // UTF-8 names
    head.setUint16(8, 0, true);               // stored
    head.setUint16(10, dosTime, true);
    head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, f.data.length, true);
    head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true);
    parts.push(head.buffer, name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((s, x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---- Markdown ----

function safeName(s) {
  return String(s || 'lecture').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'lecture';
}

// A file name not used yet in the archive, then counted as used: "x.md", "x (2).md", …
// Compared without case (Windows and macOS see "Lecture.md" and "lecture.md" as one file).
function uniqueName(name, taken) {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > name.lastIndexOf('/') ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let out = name;
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = stem + ' (' + n + ')' + ext;
  taken.add(out.toLowerCase());
  return out;
}

// A tag as a Markdown / Obsidian tag: no spaces or punctuation.
function mdTag(name) {
  const s = String(name).trim().replace(/[\s,.;:!?'"()[\]{}#]+/g, '-').replace(/^-+|-+$/g, '');
  return s ? '#' + s : '';
}

function mdEscape(s) {
  return String(s || '').replace(/\r/g, '').replace(/\n/g, '  \n  ');
}

// lec: { title, date (YYYY-MM-DD or ''), url (lesson page), items: [note/bookmark],
// tagsOf(id) -> [{ name }], picture(item) -> relative path or null }
function lectureMarkdown(lec) {
  const long = lec.items.some((x) => x.time >= 3600);
  const lines = ['# ' + lec.title, ''];
  const meta = [lec.date ? tr('mdRecorded', { date: lec.date }) : null, lec.url ? '[' + tr('mdOpen') + '](' + lec.url + ')' : null].filter(Boolean);
  if (meta.length) lines.push(meta.join(' · '), '');
  const items = lec.items.filter((x) => x.type === 'note' || x.type === 'bookmark');
  if (!items.length) lines.push('_' + tr('mdNothing') + '_');
  for (const x of items) {
    const when = x.time != null ? '[' + fmtTime(x.time, long) + '](' + lec.url + '#t=' + Math.floor(x.time) + ')' : tr('mdNoTime');
    const tags = lec.tagsOf(x.id).map((g) => mdTag(g.name)).filter(Boolean).join(' ');
    const body = x.type === 'note' ? mdEscape(x.text) : '🔖 ' + tr('markerBookmark');
    lines.push('- **' + when + '** ' + body + (tags ? ' ' + tags : ''));
    const pic = lec.picture ? lec.picture(x) : null;
    if (pic) lines.push('  ', '  ![](' + encodeURI(pic).replace(/\(/g, '%28').replace(/\)/g, '%29') + ')');
  }
  lines.push('', '_' + tr('mdFooter', { date: new Date().toISOString().slice(0, 10) }) + '_', '');
  return lines.join('\n');
}

// Date of a lesson from its id (G_..._2026-09-15T16:05:00.000_...), '' if none.
function lessonDate(lessonId) {
  const m = /_(\d{4}-\d{2}-\d{2})T/.exec(String(lessonId || ''));
  return m ? m[1] : '';
}

function lessonPageUrl(lessonId) {
  return location.origin + '/lesson/' + seg(lessonId) + '/classroom';
}

class Exporter {
  constructor(player) {
    this.p = player;
  }

  // This recording; with `pictures`, the slide page at each note (needs a slide PDF).
  async lecture(pictures) {
    const p = this.p;
    const l = p.lesson;
    const items = p.notes ? p.notes.items.filter((x) => x.type !== 'flag') : [];
    const base = (lessonDate(l.lessonId) ? lessonDate(l.lessonId) + ' ' : '') + safeName(l.title);
    const files = [];
    const taken = new Set([(base + '.md').toLowerCase()]);
    const pics = new Map();   // page index -> file name
    let picture = null;
    const deck = p.deck;
    if (pictures && deck && deck.pages.length) {
      for (const x of items) {
        if (x.time == null) continue;
        const i = deck.pageAt(x.time);
        if (i < 0 || pics.has(i)) continue;
        const pg = deck.pages[i];
        // Two PDFs with one name: their pictures still get a name each.
        const name = uniqueName(base + '/' + safeName(pg.file.replace(/\.pdf$/i, '')) + ' p' + pg.num + '.png', taken);
        const c = await deck.render(i, 1600, true);
        const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
        files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
        pics.set(i, name);
      }
      picture = (x) => (x.time == null ? null : pics.get(deck.pageAt(x.time)) || null);
    }
    const md = lectureMarkdown({
      title: l.title, date: lessonDate(l.lessonId), url: lessonPageUrl(l.lessonId), items,
      tagsOf: (id) => (p.tags ? p.tags.of(id) : []), picture,
    });
    const mdBytes = new TextEncoder().encode(md);
    if (!files.length) { platform.save(new Blob([mdBytes], { type: 'text/markdown' }), base + '.md'); return { notes: items.length, pictures: 0 }; }
    files.unshift({ name: base + '.md', data: mdBytes });
    platform.save(makeZip(files), base + '.zip');
    return { notes: items.length, pictures: files.length - 1 };
  }

  // Every recording of the course with notes or bookmarks, one Markdown file each. Returns
  // { files, failed }: recordings exported, and recordings whose notes could not be read
  // (listed in a file of the archive); throws when none could be read.
  async course(onProgress) {
    const p = this.p;
    const section = p.lesson.sectionId;
    if (!section) throw new Error('no course');
    const list = (await fetchSyllabus(section)).map((x) => x.lesson).filter((x) => x && x.lesson && x.hasVideo);
    const files = [];
    const taken = new Set();
    const failed = [];
    const tagStore = new TagStore({ sectionId: section, mediaId: null });
    await tagStore.load();
    for (let k = 0; k < list.length; k++) {
      const x = list[k];
      if (onProgress) onProgress(k, list.length);
      const lid = x.lesson.id;
      const mid = x.medias && x.medias[0] && x.medias[0].id;
      const title = x.lesson.name || (x.medias && x.medias[0] && x.medias[0].title) || lid;
      let items = [];
      // Not read (signed out, no connection): not the same as no notes.
      try { items = await new Echo360Api({ lessonId: lid, mediaId: mid }).notes(); } catch (e) { failed.push({ title, lid }); continue; }
      if (!items.length) continue;
      const map = mid ? (await idbCache.get('tagmap:' + mid)) || {} : {};
      const tagsOf = (id) => tagStore.tags.filter((g) => (map[id] || []).includes(g.id));
      items.sort((a, b) => (a.time == null ? -1 : a.time) - (b.time == null ? -1 : b.time));
      const md = lectureMarkdown({ title, date: lessonDate(lid), url: lessonPageUrl(lid), items, tagsOf });
      // Same names (two recordings on one day with one title): numbered.
      files.push({ name: uniqueName((lessonDate(lid) ? lessonDate(lid) + ' ' : '') + safeName(title) + '.md', taken), data: new TextEncoder().encode(md) });
    }
    if (failed.length && !files.length) throw new Error(tr('exportCourseUnread', { n: failed.length }));
    if (!files.length) return { files: 0, failed: 0 };
    const exported = files.length;
    if (failed.length) {
      const missing = failed.map((f) => '- [' + f.title.replace(/[[\]]/g, '') + '](' + lessonPageUrl(f.lid) + ')' + (lessonDate(f.lid) ? ' ' + lessonDate(f.lid) : '')).join('\n');
      const name = uniqueName(tr('exportNotReadFile') + '.md', taken);
      files.unshift({ name, data: new TextEncoder().encode('# ' + tr('exportNotReadFile') + '\n\n' + tr('exportNotReadText') + '\n\n' + missing + '\n') });
    }
    platform.save(makeZip(files), safeName(p.lesson.courseName || 'course') + ' notes.zip');
    return { files: exported, failed: failed.length };
  }
}

// ---- backup ----

const BACKUP_KEYS = /^(tags|tagmap|deck|deckref|watched|screenpick):/;

// Each restored IndexedDB entry, rebuilt from its known fields within BACKUP_MAX_* (02-tuning),
// or null: skipped. A backup may come from someone else, so a damaged or crafted one can
// neither plant data that breaks a later visit nor freeze one with its size.
const isStr = (x) => typeof x === 'string' && x.length < 2000;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const isHash = (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const listOf = (v, max, each) => Array.isArray(v) && v.length <= max && v.every(each);
const BACKUP_DB_CLEAN = {
  // Tags keep a plain colour (review R1).
  tags: (v) => (v && listOf(v.tags, BACKUP_MAX_TAGS, (g) => g && isStr(g.id) && isStr(g.name) && isStr(g.color))
    ? { tags: v.tags.map((g) => ({ id: g.id, name: g.name, color: plainColor(g.color, TAG_FALLBACK_COLOR) })) } : null),
  tagmap: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const items = Object.keys(v).filter((k) => k !== '__proto__');
    if (items.length > BACKUP_MAX_TAGGED || !items.every((k) => listOf(v[k], BACKUP_MAX_TAGS_EACH, isStr))) return null;
    const out = {};
    for (const k of items) out[k] = v[k].slice();
    return out;
  },
  deck: (v) => (v && listOf(v.files, BACKUP_MAX_FILES, (f) => f && isHash(f.hash) && isStr(f.name))
    && (v.fixes == null || listOf(v.fixes, BACKUP_MAX_FIXES, (x) => x && isNum(x.a) && isNum(x.b) && isStr(String(x.page))))
    ? { files: v.files.map((f) => ({ hash: f.hash, name: f.name })), fixes: (v.fixes || []).map((x) => ({ a: x.a, b: x.b, page: String(x.page) })) } : null),
  deckref: (v) => (listOf(v, BACKUP_MAX_USERS, isStr) ? v.slice() : null),
  watched: (v) => {
    if (!v || !isNum(v.d) || !(v.d > 0) || !listOf(v.r, BACKUP_MAX_RANGES, (x) => Array.isArray(x) && x.length === 2 && isNum(x[0]) && isNum(x[1]) && x[0] >= 0 && x[0] < x[1])) return null;
    if (v.e != null && !isNum(v.e)) return null;
    const out = { d: v.d, r: v.r.map(([a, b]) => [a, b]) };
    if (isNum(v.at)) out.at = v.at;
    if (v.e != null) out.e = v.e;
    return out;
  },
  screenpick: (v) => (v && Number.isInteger(v.index) && v.index >= 0 && v.index < 100 ? { index: v.index } : null),
};
// Kept with what this browser has (another recording's use of a PDF, a course's other
// tags): replacing them would let a later removal delete a PDF still in use, or drop tags
// that notes still carry.
const BACKUP_MERGE = {
  tags: (mine, theirs) => ({ tags: theirs.tags.concat(((mine && BACKUP_DB_CLEAN.tags(mine)) || { tags: [] }).tags.filter((g) => !theirs.tags.some((x) => x.id === g.id))) }),
  deckref: (mine, theirs) => theirs.concat((Array.isArray(mine) ? mine : []).filter((m) => !theirs.includes(m))),
};

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function makeBackup(withPdfs) {
  const out = { app: 'lite-player-for-echo360', v: 1, created: new Date().toISOString(), local: {}, db: {} };
  for (const k of platform.kv.names()) {
    const key = k.startsWith(NS) ? k.slice(NS.length) : null;
    if (key && BACKUP_LOCAL.some((x) => x.match(key))) out.local[key] = platform.kv.get(k);
  }
  for (const k of await idbCache.keys()) {
    const key = String(k);
    const pdf = key.startsWith('deckfile:');
    if (!BACKUP_KEYS.test(key) && !(pdf && withPdfs)) continue;
    const v = await idbCache.get(key);
    out.db[key] = v instanceof Blob ? { $blob: await blobToBase64(v), type: v.type } : v;
  }
  return out;
}

// Restores a backup: its entries replace the ones with the same keys (tags and the users of
// a PDF are merged, BACKUP_MERGE). Everything is checked first; the IndexedDB entries are
// then written in one transaction (all or none), and only then the settings. Returns the
// number of entries written. Whether usage data is sent is never taken from a file: it
// stays as this browser has it.
async function restoreBackup(data, db = idbCache) {
  if (!data || data.app !== 'lite-player-for-echo360' || data.v !== 1 || !data.db || typeof data.db !== 'object') throw new Error(tr('backupInvalid'));
  if (Object.keys(data.db).length > BACKUP_MAX_ENTRIES) throw new Error(tr('backupInvalid'));
  // Settings and positions: only known keys, each validated like the player does (a
  // damaged value becomes the default instead of breaking every later visit).
  const local = [];
  let positions = 0;
  for (const [k, v] of Object.entries(data.local && typeof data.local === 'object' ? data.local : {})) {
    const rule = BACKUP_LOCAL.find((x) => x.match(k));
    if (!rule) continue;
    if (k.startsWith('pos:') && ++positions > BACKUP_MAX_POSITIONS) continue;
    let parsed = null;
    try { parsed = JSON.parse(v); } catch (e) { parsed = null; }
    const clean = rule.clean(parsed);
    if (clean == null) continue;
    if (k === 'prefs') clean.telemetry = sanitizePrefs(store.get('prefs', null)).telemetry;
    local.push([k, clean]);
  }
  const entries = [];
  for (const [k, v] of Object.entries(data.db)) {
    if (k.startsWith('deckfile:')) {
      // A PDF is kept under the hash of its bytes: checked, so a file cannot stand in for
      // another (or replace a good copy of it).
      if (!v || typeof v !== 'object' || typeof v.$blob !== 'string' || !isHash(k.slice(9))) continue;
      let bytes;
      try {
        const bin = atob(v.$blob);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch (e) { continue; }
      if ((await sha256Hex(bytes)) !== k.slice(9)) continue;
      entries.push([k, new Blob([bytes], { type: 'application/pdf' })]);
      continue;
    }
    if (!BACKUP_KEYS.test(k)) continue;
    const clean = BACKUP_DB_CLEAN[k.split(':')[0]];
    const val = clean ? clean(v) : null;
    if (val != null) entries.push([k, val]);
  }
  const merged = entries.filter(([k]) => BACKUP_MERGE[k.split(':')[0]]).map(([k]) => k);
  await db.updateMany(merged, (old) => {
    const next = {};
    for (const [k, val] of entries) {
      const merge = BACKUP_MERGE[k.split(':')[0]];
      next[k] = merge ? merge(old[k], val) : val;
    }
    return next;
  });
  let n = entries.length;
  for (const [k, clean] of local) {
    try { platform.kv.set(NS + k, JSON.stringify(clean)); n++; } catch (e) { /* storage full */ }
  }
  return n;
}

// ---- 86-diagnostics.js ----
// ===================================================================================
// "Copy diagnostics": a plain-text summary to paste into a bug report. It names versions,
// the state of each feature and recent warnings and errors. It holds no credentials or
// cookies; web and email addresses in the warnings are masked, and errors from Echo360 keep
// only their status (ApiError), not the server's text. Other messages are kept as they
// are, so the user sees the exact text before copying it.
// ===================================================================================

function browserName() {
  const ua = navigator.userAgent;
  const m = /(Edg|OPR|Firefox|Chrome|Version)\/(\d+)/.exec(ua);
  const name = !m ? 'unknown' : m[1] === 'Edg' ? 'Edge' : m[1] === 'OPR' ? 'Opera' : m[1] === 'Version' ? 'Safari' : m[1];
  return name + (m ? ' ' + m[2] : '') + ' on ' + (/(Windows|Mac OS X|Linux|Android|iPhone|iPad|CrOS)/.exec(ua) || ['', 'unknown'])[1];
}

function maskUrls(s) {
  return String(s).replace(/(https?:)?\/\/[^\s'")]+/g, '<address>').replace(/[^\s@<>()'",;:]+@[^\s@<>()'",;:]+\.[^\s@<>()'",;:]+/g, '<email>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => id.slice(0, 8) + '…');
}

// How the script started (00-boot.js, 90-main.js): the way in, the page's state when the
// script ran, how long until the player was shown, the original player's watch reports
// stopped (taken over) and why the original player is used (if it is).
function startupLines() {
  const lines = [];
  const add = (k, val) => lines.push(k + ': ' + val);
  add('Start-up', (boot.path || 'waiting for the page') + (boot.reason ? ' (' + maskUrls(boot.reason) + ')' : ''));
  add('Page state when the script ran', boot.readyState);
  add('Player shown after', boot.readyAt ? Math.round(boot.readyAt - boot.at) + ' ms (from when the script ran)' : '-');
  if (boot.took) {
    add('Original player when taken over', (boot.took.at == null ? 'not started' : fmtTime(boot.took.at, true)) + ', ' + (boot.took.playing ? 'playing' : 'paused')
      + ', ' + (boot.took.unmounted ? 'unmounted' : 'removed from the page'));
  }
  if (boot.path === 'takeover' || boot.blocked) add('Original player watch reports stopped', boot.blocked);
  return lines;
}

// What "Copy diagnostics" in the notice copies when the original player is used (our
// player, and its diagnostics, are not there).
function startupDiagnosticsText() {
  const lines = ['Lite Player for Echo360: ' + VERSION, 'Browser: ' + browserName(), 'Runs in: ' + platform.manager(),
    'Page: ' + location.hostname, ...startupLines(), '', 'Recent warnings and errors:'];
  if (!eventLog.length) lines.push('  none');
  for (const e of eventLog) lines.push('  ' + e.t + ' ' + e.level + ' ' + maskUrls(e.text));
  return lines.join('\n');
}

function diagnosticsText(p) {
  const v = p.video;
  const q = (st) => (st && st.hls && st.hls.levels && st.hls.levels.length ? st.height + 'p of ' + Math.max(...st.hls.levels.map((l) => l.height)) + 'p' : '-');
  const lines = [];
  const add = (k, val) => lines.push(k + ': ' + val);
  add('Lite Player for Echo360', VERSION);
  add('Browser', browserName());
  add('Runs in', platform.manager());
  add('Page', location.hostname + ' (lesson page)');
  lines.push(...startupLines());
  add('Recording', (p.lesson.mediaId ? String(p.lesson.mediaId).slice(0, 8) + '…' : '-') + ', ' + p.sources.length + ' view(s), ' + fmtTime(p.duration(), true));
  add('Playback', (v.paused ? 'paused' : 'playing') + ' at ' + fmtTime(v.currentTime, true) + ', speed ' + v.playbackRate + ', layout ' + p.layout
    + (p.pdfMode ? ' (PDF view)' : '') + ', quality ' + q(p.clock) + ' / ' + q(p.follower)
    + (p.fvideo && !p.fvideo.paused ? ', sync ' + Math.round((p.fvideo.currentTime - v.currentTime) * 1000) + ' ms' : ''));
  const s = p.silence && p.silence.analyzer;
  if (s) {
    const lv = s.stats && isFinite(s.stats.noiseDb) ? ', levels: noise ' + Math.round(s.stats.noiseDb) + ' dB, speech ' + Math.round(s.stats.speechDb) + ' dB, threshold ' + Math.round(s.stats.thresholdDb) + ' dB' : '';
    add('Silence detection', (s.source || '-') + (s.reason ? ' (' + s.reason + ')' : '') + ', ' + (s.silences ? s.silences.length : 0) + ' found' + lv);
  }
  const a = p.slides;
  if (a) add('Slide chapters', a.state + ', ' + a.chapters.length + ' chapters, screen view ' + (a.screenIndex == null ? 'unknown' : a.screenIndex));
  const d = p.deck;
  if (d) {
    const r = d.ocr;
    add('Slide reader', d.state + ', ' + d.files.length + ' file(s), ' + d.pages.length + ' pages'
      + (r ? ', text on screen: ' + r.state + ', ' + Math.round(r.progress() * 100) + '% (read ' + r.stats.read + ', same ' + r.stats.same + ', failed ' + r.stats.failed + ')' : ''));
  }
  if (p.session) add('Session renewal', p.session.failed ? 'gave up (' + (p.session.failed.login ? 'sign-in expired' : 'failed') + ')' : 'ok, ' + p.session.renewals + ' renewal(s)');
  add('Notes', p.notesReady ? 'loaded' : 'not available');
  add('Audio tools', p.audio ? Object.entries(p.audio.settings || {}).filter(([, on]) => on).map(([k]) => k).join(', ') || 'off' : '-');
  add('Features turned off after an error', [...featureErrors.seen].join(', ') || 'none');
  lines.push('', 'Recent warnings and errors:');
  if (!eventLog.length) lines.push('  none');
  for (const e of eventLog) lines.push('  ' + e.t + ' ' + e.level + ' ' + maskUrls(e.text));
  return lines.join('\n');
}

// ---- 87-telemetry.js ----
// ===================================================================================
// Anonymous usage data (on by default; Settings > Usage data turns it off at once, and
// shows or deletes what was sent). What is sent and kept is listed in the README's privacy
// section and checked field by field by the Worker (telemetry-worker/src/schema.js).
//
// Who: a random secret made on first use (32 bytes, kept by the userscript manager, never
// shown, logged, exported or backed up) and its SHA-256, the user id every event carries.
// Viewing or deleting one's data sends the secret, which the Worker hashes and compares:
// knowing an id is not enough.
//
// What, and when:
//   env       the computer and browser: at most once a day, a while after a player starts
//   session   one viewing summed up (UsageSession): when the page is hidden or closed, and
//             when the player goes; sent again as the viewing goes on (same session id, the
//             Worker keeps the latest)
//   error     a feature that failed: its name, the error type, the message with addresses,
//             numbers, ids and quoted text taken out; collected for a minute, then sent
//   fallback  the page went to the original player, and why
// How fast this computer is: FIXED_STEPS below, timed as part of the analyses' real work
// (no test runs of its own).
// Nothing is sent while the page is in the background (except the summary as it is
// hidden) or offline. A request that fails is tried twice more, later and only in the
// foreground, then dropped. Nothing here may disturb the player: every entry point
// catches its own errors and none of them reports to featureGuard.
// ===================================================================================

const TELEMETRY_URL = 'https://lite-player-telemetry.zhenban.workers.dev';
const TELEMETRY_SECRET_KEY = 'telemetrySecret';
const TELEMETRY_DAY_KEY = 'telemetryDay';
const TELEMETRY_PENDING_KEY = 'telemetryPending';   // failed sends and dropped errors not yet reported
const TELEMETRY_REG_KEY = 'telemetryRegistered';    // the uid the server keeps a signing key for (private store)
const TELEMETRY_MINT_KEY = 'telemetryMint';         // proof of work in progress: { uid, day, from, bits, nonce } (private store)
const TELEMETRY_INGEST_INFO = 'lp-ingest-v1';       // signing key = HMAC(secret, this), as the server derives it
const TELEMETRY_MINT_PREFIX = 'lp-mint-v1|';

// Fixed steps: pieces of the analyses that do the same computation however the recording
// looks or sounds, so that their time per unit says how fast this computer is (the time of
// a whole analysis depends on the recording as much as on the computer). Each is timed
// around a loop of pure arithmetic: no decoding, drawing, network or waiting inside.
//   luma   160 x 90 colour pixels to brightness (lumaThumb, 64-slides.js): three multiplies,
//          two adds and a shift per pixel, no branch on the values. Runs for every frame
//          the chapter scan, its refinement and the slide reader look at.
//   loud   two one-pole filters and a sum of squares per audio sample, a logarithm per
//          0.1 s (Envelope.fill, 62-silence.js). The same operations for every sample;
//          the one difference sound makes is that a stretch of exact digital silence
//          passes through tiny (subnormal) numbers for a few hundred samples, which some
//          processors handle slower: it can only make a batch slower, so the fastest
//          batches (p10) are unaffected.
// Runs are added up into batches of TELEMETRY_STEP_BATCH_MS or more (one run is shorter
// than the timer's step: each reading is a whole number of steps, too long or too short by
// chance, and the errors cancel out over a batch); a batch gives one time per million
// units. A viewing reports per step: the version of the loop (its *_STEP_V constant;
// timings of different versions are never compared), p10 / p50 / p90 of its batches, how
// many, and what was going on as each finished. The p10 is the computer at its best; p50
// and p90 what the analyses really got.
const FIXED_STEPS = ['luma', 'loud'];
// Measures of the real work (not fixed: they depend on the recording too), per viewing.
//   scanFrame   ms to decode and reduce one keyframe of the chapter scan
//   silenceMin  ms to decode and analyse one minute of audio
//   ocrMpx      ms to read the text of a million pixels of screen
//   pdfMpx      ms to draw a million pixels of a PDF page
const WORK_MEASURES = ['scanFrame', 'silenceMin', 'ocrMpx', 'pdfMpx'];
// What a failed request is counted as.
function netClass(status) {
  if (status === 'network' || status === 'timeout') return status;
  if (status === 401 || status === 403) return String(status);
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  return 'other';
}

// Two significant digits: enough for comparing computers, too coarse to tell one apart.
function sig2(x) {
  return typeof x === 'number' && Number.isFinite(x) ? Number(x.toPrecision(2)) : undefined;
}

// Values of one measure, for percentiles: at most TELEMETRY_KEEP_VALUES of them (a uniform
// random sample once there are more), with their count and largest.
class TelemetryValues {
  constructor() { this.v = []; this.n = 0; this.max = -Infinity; }

  add(x) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return;
    this.n++;
    if (x > this.max) this.max = x;
    if (this.v.length < TELEMETRY_KEEP_VALUES) this.v.push(x);
    else {
      const j = Math.floor(Math.random() * this.n);
      if (j < this.v.length) this.v[j] = x;
    }
  }

  // The p-quantile (nearest rank, 0 < p <= 1), or undefined without values.
  q(p) {
    if (!this.v.length) return undefined;
    const a = this.v.slice().sort((x, y) => x - y);
    return a[clamp(Math.ceil(p * a.length) - 1, 0, a.length - 1)];
  }
}

// The step of performance.now() in microseconds: the smallest change seen over at most
// TELEMETRY_TIMER_PROBE_MS (browsers coarsen it on purpose; it decides how short a timed
// run can be).
function timerStepUs() {
  let last = performance.now();
  const end = last + TELEMETRY_TIMER_PROBE_MS;
  let min = Infinity;
  for (let changes = 0; changes < 20;) {
    const t = performance.now();
    if (t !== last) { min = Math.min(min, t - last); last = t; changes++; }
    if (t >= end) break;
  }
  return min === Infinity ? undefined : sig2(min * 1000);
}

// Key actions (42-keys.js) and the features they count as.
const KEY_FEATURES = {
  togglePlay: 'play', seekBy: 'seek', stepChapter: 'chapter', volumeBy: 'volume', toggleMute: 'mute',
  fullscreen: 'fullscreen', swap: 'swap', captions: 'captions', transcript: 'transcript', bookmark: 'bookmark',
  flag: 'flag', tag: 'tag', copyFrame: 'copyFrame', copyCaptions: 'copyCaptions', zoom: 'zoom',
  loopA: 'loop', loopB: 'loop', loopClear: 'loop', popout: 'popout', exportNotes: 'exportNotes', speed: 'speed', help: 'help',
};
// Clicks on the player's own controls and the features they count as (the first match).
const CLICK_FEATURES = [
  ['.play', 'play'], ['.rew', 'seek'], ['.fwd', 'seek'], ['.seek', 'seekbar'], ['.fs', 'fullscreen'],
  ['.swapdot', 'swap'], ['.layout', 'layout'], ['.ccbtn', 'captions'], ['.framebtn', 'copyFrame'],
  ['.textbtn', 'copyCaptions'], ['.bmbtn', 'bookmark'], ['.mute', 'mute'], ['.speed', 'speed'],
  ['.morebtn', 'settings'], ['[data-open=transcript]', 'transcript'], ['[data-open=notes]', 'notes'],
  ['[data-open=discussion]', 'discussion'], ['[data-open=slides]', 'slides'], ['.pprev', 'pdfTurn'],
  ['.pnext', 'pdfTurn'], ['.skipsil', 'silenceSkip'], ['.endskip', 'silenceSkip'], ['.pextras', 'original'],
  ['.views video', 'play'],
];

// An error message with nothing that could point at a person or a recording (the Worker
// does the same again).
function telemetryMessage(s) {
  return String(s == null ? '' : s)
    .replace(/[a-z][\w+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\S+@\S+/g, '<email>')
    .replace(/(["'`‘“])[^"'`’”]*["'`’”]/g, '<text>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{9,}/gi, '<id>')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

// Settings that differ from their defaults, by name ('audio.level'): never their values.
function changedPrefs(prefs) {
  const d = prefDefaults();
  const out = [];
  const walk = (a, b, path) => {
    for (const k of Object.keys(b)) {
      if (k === 'levelChosen' || k === 'telemetry') continue;
      const name = path ? path + '.' + k : k;
      if (b[k] && typeof b[k] === 'object') walk(a && a[k], b[k], name);
      else if (a && a[k] !== undefined && a[k] !== b[k]) out.push(name);
    }
  };
  walk(prefs, d, '');
  return out;
}

// Echo360's front-end build: the names and hash prefixes of its script bundles
// ("application-373f7d"), nothing of the page's address or content.
function echoFrontend() {
  const out = [];
  for (const s of document.querySelectorAll('script[src]')) {
    let u;
    try { u = new URL(s.getAttribute('src'), location.href); } catch (e) { continue; }
    if (u.origin !== location.origin || !u.pathname.startsWith('/assets/')) continue;
    const m = /\/([0-9a-f]{6})[0-9a-f]*-([A-Za-z][\w.-]{0,60})\.js$/.exec(u.pathname);
    if (m) out.push(m[2].replace(/\.react-bundle$/, '') + '-' + m[1]);
  }
  return out.sort().join(',').slice(0, 160) || null;
}

// The computer and browser, as far as the browser tells.
async function telemetryEnv() {
  const ua = navigator.userAgent;
  const m = /(Edg|OPR|Firefox|Chrome|Version)\/(\d+)/.exec(ua);
  const browser = !m ? 'other' : { Edg: 'Edge', OPR: 'Opera', Version: 'Safari' }[m[1]] || m[1];
  // iPadOS Safari presents itself as a Mac; a Mac has no touch screen.
  const os = /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  const mgr = /^(\S+)\s*(\S*)/.exec(platform.manager()) || [];
  const known = ['Tampermonkey', 'Violentmonkey', 'Greasemonkey', 'ScriptCat', 'Userscripts', 'Stay', 'extension'];
  const manager = known.includes(mgr[1]) ? mgr[1] : mgr[1] === 'unknown' ? 'none' : 'other';
  const conn = /** @type {any} */ (navigator).connection;
  const env = {
    k: 'env', v: VERSION, site: siteRegion(), browser, browserV: m ? +m[2] : undefined, os,
    manager, managerV: manager !== 'none' && /^[\w.-]{1,20}$/.test(mgr[2] || '') ? mgr[2] : undefined,
    lang: uiLang(), browserLang: (/^[a-z]{2,3}/.exec((navigator.language || '').toLowerCase()) || [])[0],
    touch: matchMedia('(pointer: coarse)').matches,
    screenW: screen.width, screenH: screen.height, dpr: Math.round(devicePixelRatio * 100) / 100,
    cores: navigator.hardwareConcurrency || undefined,
    memGb: /** @type {any} */ (navigator).deviceMemory,
    gpu: undefined, webgpu: false,
    webcodecs: typeof VideoDecoder === 'function',
    builtinAi: typeof (/** @type {any} */ (self)).LanguageModel === 'function' || typeof (/** @type {any} */ (self)).Summarizer === 'function',
    netType: conn && conn.effectiveType, downlink: conn && conn.downlink,
  };
  try {
    const c = document.createElement('canvas').getContext('webgl');
    const info = c && c.getExtension('WEBGL_debug_renderer_info');
    const r = info ? c.getParameter(info.UNMASKED_RENDERER_WEBGL) : c && c.getParameter(c.RENDERER);
    if (typeof r === 'string') env.gpu = r.replace(/[^\x20-\x7e]/g, '').slice(0, 120);
    const lose = c && c.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  } catch (e) { /* no WebGL */ }
  const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 3000))]);
  const word = (v) => (typeof v === 'string' && /^[\w .-]{1,40}$/.test(v) ? v : undefined);
  try {
    const gpu = /** @type {any} */ (navigator).gpu;
    const adapter = gpu ? await within(gpu.requestAdapter()) : null;
    env.webgpu = !!adapter;
    if (adapter) {
      const info = adapter.info || {};
      env.gpuVendor = word(info.vendor);
      env.gpuArch = word(info.architecture);
      env.gpuFallback = !!(info.isFallbackAdapter || adapter.isFallbackAdapter);
      env.gpuF16 = !!(adapter.features && adapter.features.has('shader-f16'));
    }
  } catch (e) { /* not available */ }
  // Whether the video decoding is done by the graphics hardware (power-efficient), for the
  // renditions Echo360 serves (H.264 at 720p and 1080p).
  try {
    const mc = navigator.mediaCapabilities;
    const ask = (codecs, width, height, bitrate) => within(mc.decodingInfo({ type: 'media-source', video: { contentType: 'video/mp4; codecs="' + codecs + '"', width, height, bitrate, framerate: 30 } }));
    if (mc && mc.decodingInfo) {
      const [a, b] = await Promise.all([ask('avc1.64001F', 1280, 720, 2e6), ask('avc1.640028', 1920, 1080, 4e6)]);
      if (a) env.hw720 = !!a.powerEfficient;
      if (b) env.hw1080 = !!b.powerEfficient;
    }
  } catch (e) { /* not known */ }
  // Processor, system version and device model (Chromium browsers say; the model is given
  // by Android only, and is null elsewhere).
  try {
    const uad = /** @type {any} */ (navigator).userAgentData;
    if (uad && uad.getHighEntropyValues) {
      const h = await within(uad.getHighEntropyValues(['architecture', 'bitness', 'platformVersion', 'model']));
      if (h) {
        env.arch = h.architecture === 'x86' || h.architecture === 'arm' ? h.architecture : h.architecture ? 'other' : undefined;
        env.bitness = h.bitness === '64' || h.bitness === '32' ? +h.bitness : undefined;
        const major = parseInt(h.platformVersion, 10);
        env.osV = Number.isInteger(major) && major >= 0 && major < 1000 ? major : undefined;
        env.model = typeof h.model === 'string' && /^[\w ()+.,/-]{1,40}$/.test(h.model.trim()) ? h.model.trim() : null;
      }
      env.mobile = !!uad.mobile;
    }
  } catch (e) { /* not known */ }
  try {
    const b = /** @type {any} */ (navigator).getBattery ? await within(/** @type {any} */ (navigator).getBattery()) : null;
    if (b) env.charging = !!b.charging;
  } catch (e) { /* not known */ }
  env.pressureApi = typeof (/** @type {any} */ (self)).PressureObserver === 'function';
  env.timerUs = telemetry.timerUs;
  return env;
}

const telemetry = {
  on: null,            // null: not read yet (from the settings)
  ids: null,           // Promise of { secret, uid }
  idNow: null,         // the same once known (a page that is closing cannot wait)
  regUid: undefined,   // the uid the server signs for (undefined: not read yet)
  clockMs: 0,          // the server's clock minus this computer's (from its answers)
  minting: false,      // the proof of work or the registration is under way
  mintTimer: 0,        // ... or planned
  waiting: [],         // batches refused until registered, sent once registered
  current: null,       // the UsageSession of the player on the page
  sessions: 0,         // viewings started on this page
  errors: new Map(),   // key -> error event, waiting to be sent
  errorTimer: 0,
  retries: new Set(),  // timers of requests to be tried again
  batches: {},         // fixed step -> { v, ms, units } of the batch being added up
  timerUs: undefined,  // the timer's step (timerStepUs), once measured

  enabled() {
    if (this.on === null) {
      let on = false;
      try { on = !store.get('telemetryOff', false) && sanitizePrefs(store.get('prefs', null)).telemetry; } catch (e) { on = false; }
      this.on = on;
    }
    return this.on;
  },

  // Turned on or off in the settings: off stops everything at once, retries included.
  setEnabled(on) {
    this.on = !!on;
    if (!on) {
      this.errors.clear(); clearTimeout(this.errorTimer); this.errorTimer = 0;
      for (const t of this.retries) clearTimeout(t);
      this.retries.clear();
    }
  },

  // Read from the settings again right before a request: turned off in another tab, this
  // one stops too (enabled() keeps what it read, for the frequent calls).
  consented() {
    this.on = null;
    return this.enabled();
  },

  // { secret, uid, kv }: made on first use. kv signs batches once registered.
  identity() {
    if (!this.ids) {
      let p; // read inside the function once it has awaited, so set by then
      this.ids = p = (async () => {
        await platform.privateReady;
        let secret = platform.privateKv.get(TELEMETRY_SECRET_KEY);
        if (!/^[A-Za-z0-9_-]{43}$/.test(secret || '')) {
          secret = newTelemetrySecret();
          platform.privateKv.set(TELEMETRY_SECRET_KEY, secret);
        }
        const id = { secret, uid: await sha256Hex(utf8(secret)), kv: hmacSha256Sync(utf8(secret), utf8(TELEMETRY_INGEST_INFO)) };
        if (this.ids === p) this.idNow = id;
        return id;
      })();
      this.ids.catch(() => { this.ids = null; });
    }
    return this.ids;
  },

  // A new secret (a new id): data sent before can no longer be viewed or deleted here.
  resetIdentity() {
    platform.privateKv.set(TELEMETRY_SECRET_KEY, newTelemetrySecret());
    this.ids = null;
    this.idNow = null;
    this.forgetRegistration();
    platform.privateKv.set(TELEMETRY_MINT_KEY, '');
    store.set(TELEMETRY_DAY_KEY, null);
  },

  registered(id) {
    if (this.regUid === undefined) this.regUid = platform.privateKv.get(TELEMETRY_REG_KEY);
    return this.regUid === id.uid;
  },

  forgetRegistration() {
    this.regUid = null;
    platform.privateKv.set(TELEMETRY_REG_KEY, '');
  },

  // The body of a batch: signed once registered (a retry sends the same, so the server
  // recognises a batch that did arrive), plain before (stored as unsigned).
  payload(id, events) {
    if (!this.registered(id)) return JSON.stringify({ uid: id.uid, events });
    const body = JSON.stringify({ events });
    const ts = Date.now() + this.clockMs;
    const batch = bytesHex(crypto.getRandomValues(new Uint8Array(12)));
    const sig = bytesHex(hmacSha256Sync(id.kv, utf8(ts + '.' + batch + '.' + bytesHex(sha256Sync(utf8(body))))));
    return JSON.stringify({ uid: id.uid, ts, batch, sig, body });
  },

  // An answer of the server: its JSON (or null), and its clock.
  answer(r) {
    let data = null;
    try { data = JSON.parse(r.text); } catch (e) { data = null; }
    if (data && typeof data.now === 'number' && Number.isFinite(data.now)) this.clockMs = data.now - Date.now();
    return data;
  },

  // Sends events; never throws. `last`: the page is being hidden or closed (no retries).
  // `again`: sent a second time after the server asked to register or fix the clock.
  async send(events, last, again) {
    try {
      if (!this.enabled() || !events.length || navigator.onLine === false) return;
      // Sent at once while the page closes: nothing is awaited before the request.
      const id = this.idNow || await this.identity();
      if (!this.enabled()) return;
      // deliver starts the request before its first await.
      await this.deliver(id, this.payload(id, events), events, !!last, !!again, 0);
    } catch (e) { /* dropped */ }
  },

  async deliver(id, payload, events, last, again, attempt) {
    try {
      if (!this.consented()) return;
      const r = await platform.post(TELEMETRY_URL + '/v1/events', payload, TELEMETRY_TIMEOUT_MS, last);
      const data = this.answer(r);
      if (r.status === 200) return;
      if (r.status === 401 && data && !last && !again) {
        // The clock was off: signed again with the server's.
        if (data.error === 'clock') { this.send(events, false, true); return; }
        // Not registered (any more), or the server's key is not ours: register, then send.
        if (data.register || data.error === 'signature') {
          if (this.registered(id)) this.forgetRegistration();
          if (this.waiting.length < TELEMETRY_WAIT_BATCHES) this.waiting.push(events);
          this.register(0);
          return;
        }
      }
      if ((r.status === 0 || r.status >= 500) && !last && attempt < TELEMETRY_RETRY_MS.length) {
        const t = setTimeout(() => {
          this.retries.delete(t);
          if (!document.hidden && navigator.onLine !== false) this.deliver(id, payload, events, false, again, attempt + 1);
        }, TELEMETRY_RETRY_MS[attempt]);
        this.retries.add(t);
        return;
      }
      // Given up (a summary sent while the page closes is not waited for: not counted).
      if (!last) this.selfCount('sendFail');
    } catch (e) { /* dropped */ }
  },

  // Once per id: a proof of work done in short idle slices (saved as it goes, so a page
  // closed early carries on next time), then the server keeps the signing key. `delay`: ms
  // before starting (playback settles first).
  register(delay) {
    if (this.minting || !this.enabled()) return;
    // Already planned: kept, unless asked to start sooner (the server asked to register).
    if (this.mintTimer && delay > 0) return;
    clearTimeout(this.mintTimer);
    this.mintTimer = setTimeout(() => {
      this.mintTimer = 0;
      this.minting = true;
      this.mint().catch(() => {}).then(() => { this.minting = false; });
    }, delay);
  },

  async mint() {
    const id = await this.identity();
    for (let tries = 0; tries < 2 && !this.registered(id); tries++) {
      const today = Math.floor((Date.now() + this.clockMs) / 86400000);
      let m = null;
      try { m = JSON.parse(platform.privateKv.get(TELEMETRY_MINT_KEY) || 'null'); } catch (e) { m = null; }
      const bits = Math.max(TELEMETRY_MINT_BITS, m && m.uid === id.uid && m.bits <= 32 ? m.bits : 0);
      // The server takes the day before, the day and the day after.
      if (!m || m.uid !== id.uid || m.bits !== bits || !(Math.abs(today - m.day) <= 1) || !(m.from >= 0)) m = { uid: id.uid, day: today, from: 0, bits };
      const save = () => platform.privateKv.set(TELEMETRY_MINT_KEY, JSON.stringify(m));
      const prefix = TELEMETRY_MINT_PREFIX + id.uid + '|' + m.day + '|';
      let chunk = 1000;
      let saved = performance.now();
      while (m.nonce == null) {
        // Safari has no idle callbacks: a pause as long as a slice instead (half the time).
        await new Promise((resolve) => {
          if (typeof requestIdleCallback === 'function') requestIdleCallback(resolve, { timeout: 1000 }); else setTimeout(resolve, TELEMETRY_MINT_SLICE_MS);
        });
        // Turned off, a new id, or the player gone (the original player chosen, the page
        // left): stops; the work so far is saved and goes on with the next viewing.
        if (!this.enabled() || this.idNow !== id || !this.current) { save(); return; }
        const t0 = performance.now();
        const found = mintSearch(prefix, m.bits, m.from, chunk);
        const ms = performance.now() - t0;
        if (found >= 0) m.nonce = found; else m.from += chunk;
        chunk = clamp(Math.round(chunk * TELEMETRY_MINT_SLICE_MS / Math.max(ms, 1)), 100, 1000000);
        if (m.nonce != null || performance.now() - saved > TELEMETRY_MINT_SAVE_MS) { save(); saved = performance.now(); }
      }
      if (!this.consented()) return;
      const r = await platform.post(TELEMETRY_URL + '/v1/register', JSON.stringify({ uid: id.uid, secret: id.secret, day: m.day, nonce: String(m.nonce) }), TELEMETRY_TIMEOUT_MS);
      const data = this.answer(r);
      if (r.status === 200) {
        this.regUid = id.uid;
        platform.privateKv.set(TELEMETRY_REG_KEY, id.uid);
        platform.privateKv.set(TELEMETRY_MINT_KEY, '');
        const list = this.waiting;
        this.waiting = [];
        for (const events of list) this.send(events, false, true);
        return;
      }
      // More bits asked, or the day was off (this computer's clock): done again.
      if (r.status === 403 && data && data.error === 'pow') {
        m = { uid: id.uid, day: today, from: 0, bits: Math.min(32, Math.max(bits, data.bits | 0)) };
        save();
        continue;
      }
      return;   // no answer or refused: tried again with the next viewing
    }
  },

  // Failed sends and dropped errors: told with the current viewing, or kept for the next.
  selfCount(what) {
    try {
      if (this.current) { this.current.self[what]++; return; }
      const p = store.get(TELEMETRY_PENDING_KEY, null) || {};
      p[what] = (+p[what] || 0) + 1;
      store.set(TELEMETRY_PENDING_KEY, p);
    } catch (e) { /* not counted */ }
  },

  // Counts not told yet, handed to a viewing (which then reports them).
  takePending() {
    const p = store.get(TELEMETRY_PENDING_KEY, null);
    if (p) store.set(TELEMETRY_PENDING_KEY, null);
    return { sendFail: p && +p.sendFail > 0 ? +p.sendFail : 0, dropped: p && +p.dropped > 0 ? +p.dropped : 0 };
  },

  // Something to count from code that does not know about usage data (usageNote).
  note(kind, key, value) {
    if (this.current && this.enabled()) this.current.note(kind, key, value);
  },

  // One timed run of a fixed step (usageStep): added to its batch; a full batch becomes one
  // value of the current viewing.
  step(name, v, units, ms) {
    if (!this.current || !this.enabled() || !(units > 0) || !(ms >= 0)) return;
    let b = this.batches[name];
    if (!b || b.v !== v) b = this.batches[name] = { v, ms: 0, units: 0 };
    b.ms += ms;
    b.units += units;
    if (b.ms < TELEMETRY_STEP_BATCH_MS) return;
    const perMillion = (b.ms / b.units) * 1e6;
    b.ms = 0;
    b.units = 0;
    this.current.stepDone(name, v, perMillion);
  },

  // The timer's step, measured once a page when the browser is idle.
  measureTimer() {
    if (this.timerUs !== undefined || this.timerAsked) return;
    this.timerAsked = true;
    const run = () => { try { this.timerUs = timerStepUs(); } catch (e) { /* not known */ } };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 }); else setTimeout(run, 1000);
  },

  // A request with the secret (viewing or deleting one's data): { status, data }.
  // Deleting also removes the registration on the server.
  // Never rejects (status 0: no answer).
  async ask(path) {
    try {
      const { secret, uid } = await this.identity();
      const r = await platform.post(TELEMETRY_URL + path, JSON.stringify({ uid, secret }), TELEMETRY_TIMEOUT_MS);
      const data = this.answer(r);
      if (path === '/v1/me/delete' && r.status === 200) this.forgetRegistration();
      return { status: r.status, data };
    } catch (e) {
      return { status: 0, data: null };
    }
  },

  // The environment, at most once a day.
  envDaily() {
    try {
      if (!this.enabled()) return;
      const day = new Date().toISOString().slice(0, 10);
      if (store.get(TELEMETRY_DAY_KEY, null) === day) return;
      setTimeout(() => {
        if (!this.enabled() || document.hidden || store.get(TELEMETRY_DAY_KEY, null) === day) return;
        store.set(TELEMETRY_DAY_KEY, day);
        telemetryEnv().then((env) => this.send([env]), () => {});
      }, TELEMETRY_ENV_DELAY_MS);
    } catch (e) { /* not sent */ }
  },

  // A feature that failed (from reportFeatureError / reportUnexpected).
  error(feature, err) {
    try {
      if (!this.enabled()) return;
      const name = String(feature || 'player').toLowerCase().replace(/[^a-z ()-]/g, '').slice(0, 40) || 'player';
      const type = err && typeof err.name === 'string' && /^[A-Za-z]\w{0,39}$/.test(err.name) ? err.name : typeof err;
      const msg = telemetryMessage(err && err.message != null ? err.message : err);
      const key = name + '\n' + type + '\n' + msg;
      const known = this.errors.get(key);
      if (known) { known.n++; return; }
      if (this.errors.size >= TELEMETRY_MAX_ERRORS) { this.selfCount('dropped'); return; }
      this.errors.set(key, { k: 'error', v: VERSION, feature: name, type, msg, n: 1 });
      if (!this.errorTimer) this.errorTimer = setTimeout(() => { this.errorTimer = 0; if (!document.hidden) this.flushErrors(false); }, TELEMETRY_ERROR_WAIT_MS);
    } catch (e) { /* not counted */ }
  },

  flushErrors(last) {
    const list = [...this.errors.values()];
    this.errors.clear();
    clearTimeout(this.errorTimer);
    this.errorTimer = 0;
    if (list.length) this.send(list, last);
  },

  fallback(reason) {
    try {
      if (this.enabled()) this.send([{ k: 'fallback', v: VERSION, reason, site: siteRegion(), framed: inFrame(), frontend: echoFrontend(), injectState: boot.readyState }]);
    } catch (e) { /* not sent */ }
  },

  // A feature used by `via` ('key' or 'click').
  use(feature, via) {
    try { if (this.current) this.current.use(feature, via); } catch (e) { /* not counted */ }
  },
};

function newTelemetrySecret() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// One viewing: what it cost the computer, how it went, what was used, how the analyses did.
// Times are summed up as percentiles; no series of values is sent.
//
// deps: { root (the player's shadow root), video (the clock video), videos() (both),
//         prefs, layout() ('side' | 'pip' | 'single' | 'pdf', as shown), slides(), deck(),
//         silence() (the analyzer), emptyScreen(), session() (SessionKeeper), duration(),
//         startedAt (performance.now() when the player started), height() (rendition
//         playing), bandwidth() (bits/s estimated by hls.js), played() ([[start, end]]) }
class UsageSession {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.sid = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    this.opened = performance.now();
    // The first viewing on a page is timed from the page's start, later ones (another
    // recording opened in the page) from the player's.
    this.fromLoad = telemetry.sessions++ === 0;
    this.t0 = this.fromLoad ? 0 : deps.startedAt || this.opened;
    this.readyMs = this.opened - this.t0;
    this.features = {};
    this.keys = 0;
    this.clicks = 0;
    this.playMs = 0;
    this.byRate = new Map();       // playback rate -> ms played
    this.byLayout = new Map();     // layout -> ms played
    this.byHeight = new Map();     // rendition height -> ms played
    this.lastTick = 0;
    this.longTasks = 0;
    this.visibleMs = 0;
    this.visibleSince = document.hidden ? 0 : performance.now();
    this.firstFrameMs = null;
    this.rebufferN = 0;
    this.rebufferMs = 0;
    this.waitingSince = 0;
    this.seekSince = 0;
    this.heap = 0;
    this.frames = new Map();       // video -> { dropped, total, base: { dropped, total } }
    this.lastReport = -Infinity;
    this.vals = {};                // measure -> TelemetryValues
    this.steps = {};               // fixed step -> { v, vals, cond: { condition: batches } }
    this.counts = { net: {}, stream: {}, guardOff: {} };
    this.levels = 0;
    this.streamBytes = 0;
    this.bgBytes = 0;
    this.cacheHit = 0;
    this.cacheMiss = 0;
    this.skipped = { silence: 0, blank: 0 };
    this.marks = {};               // 'chapters' | 'pdf' -> ms after the player started
    this.originalAfter = null;     // seconds played when the user went to the original player
    this.uncaught = 0;
    this.inputs = 0;               // interactions (pointer presses and key presses)
    this.inputMs = new Map();      // Event Timing interactionId -> longest duration
    this.inputUndrawn = new Set(); // interactions whose answer was never drawn (left out)
    this.pressure = null;          // CPU pressure level now (null: not known or not watched)
    this.pressureMs = { bg: {}, idle: {} };   // ms played at each level, with and without background analyses running
    this.pressureObs = null;       // the PressureObserver while it watches
    this.onBattery = null;         // null: not known
    this.powerMs = { ac: 0, battery: 0 };     // ms played on each power source
    this.self = telemetry.takePending();
    telemetry.current = this;
    telemetry.measureTimer();
    // The id is worked out now: a summary sent as the page closes cannot wait for it.
    if (telemetry.enabled()) {
      telemetry.identity().then((id) => {
        if (telemetry.current === this && !telemetry.registered(id)) telemetry.register(TELEMETRY_MINT_DELAY_MS);
      }, () => {});
    }
    disposer.add(() => {
      this.report(true);
      if (telemetry.current !== this) return;
      telemetry.current = null;
      // Registering waits for the next viewing (a running proof of work stops by itself).
      clearTimeout(telemetry.mintTimer);
      telemetry.mintTimer = 0;
    });
    const v = deps.video;
    const on = (target, type, fn, opts) => disposer.listen(target, type, (e) => { try { fn(e); } catch (err) { /* not counted */ } }, opts);
    on(v, 'timeupdate', () => this.tick());
    on(v, 'pause', () => { this.tick(); this.lastTick = 0; this.watchPressure(); });
    on(v, 'playing', () => this.watchPressure());
    on(v, 'loadeddata', () => { if (this.firstFrameMs == null) this.firstFrameMs = Math.round(performance.now() - this.t0); });
    on(v, 'waiting', () => { if (!v.seeking && !v.paused && this.firstFrameMs != null && !this.waitingSince) this.waitingSince = performance.now(); });
    const resumed = () => {
      if (!this.waitingSince) return;
      this.rebufferN++;
      this.rebufferMs += performance.now() - this.waitingSince;
      this.waitingSince = 0;
    };
    on(v, 'playing', resumed);
    on(v, 'seeking', () => { this.waitingSince = 0; if (this.firstFrameMs != null) this.seekSince = performance.now(); });
    on(v, 'seeked', () => {
      if (this.seekSince) this.value('seek', performance.now() - this.seekSince);
      this.seekSince = 0;
    });
    const MEDIA_ERRORS = ['', 'videoAborted', 'videoNetwork', 'videoDecode', 'videoUnsupported'];
    for (const ve of deps.videos()) if (ve) on(ve, 'error', () => { if (ve.error) this.note('stream', MEDIA_ERRORS[ve.error.code] || 'videoOther'); });
    on(document, 'visibilitychange', () => {
      if (document.hidden) {
        if (this.visibleSince) this.visibleMs += performance.now() - this.visibleSince;
        this.visibleSince = 0;
        this.report(true);
      } else this.visibleSince = performance.now();
      this.watchPressure();
    });
    on(window, 'pagehide', () => this.report(true));
    // Uncaught errors of this script (the page's own are not ours to count).
    const ours = (e) => /lite[ %_-]*player/i.test(String((e && (e.filename || (e.error && e.error.stack) || (e.reason && e.reason.stack))) || ''));
    on(window, 'error', (e) => { if (ours(e)) this.uncaught++; });
    on(window, 'unhandledrejection', (e) => { if (ours(e)) this.uncaught++; });
    // Clicks on the player's controls (before their own handlers: counted even when a
    // handler stops the event).
    disposer.listen(deps.root, 'click', (e) => {
      try {
        const t = e.target;
        if (!t || !t.closest) return;
        for (const [sel, f] of CLICK_FEATURES) if (t.closest(sel)) { this.use(f, 'click'); return; }
      } catch (err) { /* not counted */ }
    }, true);
    // Interactions: every press is counted; Event Timing reports those that took
    // TELEMETRY_INPUT_MIN_MS or longer (the player is all there is on the page).
    on(document, 'pointerdown', () => { this.inputs++; }, { capture: true, passive: true });
    on(document, 'keydown', (e) => { if (!e.repeat) this.inputs++; }, { capture: true, passive: true });
    const types = (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes) || [];
    if (types.includes('longtask')) {
      const po = new PerformanceObserver((list) => { this.longTasks += list.getEntries().length; });
      po.observe({ type: 'longtask' });
      disposer.observe(po);
    }
    if (types.includes('event')) {
      const po = new PerformanceObserver((list) => {
        for (const en of /** @type {any[]} */ (list.getEntries())) {
          if (!en.interactionId) continue;
          if (en.duration > TELEMETRY_INPUT_MAX_MS) { if (this.inputUndrawn.size < TELEMETRY_KEEP_VALUES) this.inputUndrawn.add(en.interactionId); continue; }
          if (this.inputMs.size >= TELEMETRY_KEEP_VALUES && !this.inputMs.has(en.interactionId)) continue;
          this.inputMs.set(en.interactionId, Math.max(this.inputMs.get(en.interactionId) || 0, en.duration));
        }
      });
      po.observe(/** @type {any} */ ({ type: 'event', durationThreshold: TELEMETRY_INPUT_MIN_MS }));
      disposer.observe(po);
    }
    // CPU pressure (Chromium browsers; watched only while playing in a visible tab, see
    // watchPressure) and whether the computer runs on battery.
    disposer.add(() => { this.watchPressure(true); });
    const nav = /** @type {any} */ (navigator);
    if (nav.getBattery) {
      nav.getBattery().then((b) => {
        if (disposer.disposed) return;
        const set = () => this.setBattery(!b.charging);
        set();
        disposer.listen(b, 'chargingchange', set);
      }).catch(() => {});
    }
    disposer.interval(() => { if (!document.hidden) this.sample(); }, TELEMETRY_SAMPLE_MS);
  }

  value(name, x) {
    (this.vals[name] || (this.vals[name] = new TelemetryValues())).add(x);
  }

  setPressure(state) {
    this.pressure = ['nominal', 'fair', 'serious', 'critical'].includes(state) ? state : null;
  }

  // CPU pressure is watched while the video plays in a visible tab, and not otherwise
  // (paused or hidden: not what watching costs). stop: the viewing is over.
  watchPressure(stop) {
    const want = !stop && !this.x.video.paused && !document.hidden;
    if (want === !!this.pressureObs) return;
    if (!want) {
      try { this.pressureObs.disconnect(); } catch (e) { /* gone */ }
      this.pressureObs = null;
      this.pressure = null;
      return;
    }
    const PO = /** @type {any} */ (self).PressureObserver;
    if (typeof PO !== 'function') return;
    try {
      const po = new PO((records) => { try { if (this.pressureObs === po) this.setPressure(records[records.length - 1].state); } catch (e) { /* not counted */ } });
      po.observe('cpu', { sampleInterval: TELEMETRY_PRESSURE_SAMPLE_MS }).catch(() => {});
      this.pressureObs = po;
    } catch (e) { /* not available */ }
  }

  setBattery(onBattery) {
    this.onBattery = onBattery;
  }

  // From usageNote (00-util.js).
  note(kind, key, value) {
    const c = this.counts;
    const inc = (map, k) => { if (map[k] || Object.keys(map).length < 20) map[k] = (map[k] || 0) + 1; };
    if (kind === 'net') inc(c.net, netClass(key));
    else if (kind === 'stream' && typeof key === 'string' && /^[A-Za-z]{1,40}$/.test(key)) inc(c.stream, key);
    else if (kind === 'guardOff' && typeof key === 'string') inc(c.guardOff, key.toLowerCase().replace(/[^a-z ()-]/g, '').slice(0, 40) || 'player');
    else if (kind === 'level') this.levels++;
    else if (kind === 'streamBytes') this.streamBytes += +value || 0;
    else if (kind === 'bgBytes') this.bgBytes += +value || 0;
    else if (kind === 'cache') { if (key === 'hit') this.cacheHit++; else this.cacheMiss++; }
    else if (kind === 'skip' && value > 0) this.skipped[key === 'silence' ? 'silence' : 'blank'] += value;
    else if (kind === 'drift') this.value('sync', value);
    else if (kind === 'work' && WORK_MEASURES.includes(key)) this.value(key, value);
  }

  // A batch of a fixed step finished (telemetry.step): its time per million units, and what
  // was going on.
  stepDone(name, v, perMillion) {
    let st = this.steps[name];
    if (!st || st.v !== v) st = this.steps[name] = { v, vals: new TelemetryValues(), cond: {} };
    st.vals.add(perMillion);
    const video = this.x.video;
    const conds = [
      video.paused ? 'paused' : 'playing',
      'rate:' + video.playbackRate,
      'cpu:' + (this.pressure || 'unknown'),
      'power:' + (this.onBattery === null ? 'unknown' : this.onBattery ? 'battery' : 'ac'),
    ];
    for (const k of conds) st.cond[k] = (st.cond[k] || 0) + 1;
  }

  // The first time something became available ('chapters', 'pdf'), after the player started.
  mark(name) {
    if (this.marks[name] == null) this.marks[name] = performance.now() - (this.x.startedAt || this.opened);
  }

  use(feature, via) {
    this.features[feature] = (this.features[feature] || 0) + 1;
    if (via === 'key') this.keys++; else if (via === 'click') this.clicks++;
    if (feature === 'original' && this.originalAfter == null) { this.tick(); this.originalAfter = Math.round(this.playMs / 1000); }
  }

  // Playing time, by rate, layout and rendition (from timeupdate, about four times a second).
  tick() {
    const v = this.x.video;
    const now = performance.now();
    if (this.lastTick && !v.paused) {
      const dt = now - this.lastTick;
      if (dt > 0 && dt < 2000) {
        this.playMs += dt;
        const r = v.playbackRate;
        this.byRate.set(r, (this.byRate.get(r) || 0) + dt);
        const l = this.x.layout();
        this.byLayout.set(l, (this.byLayout.get(l) || 0) + dt);
        const h = this.x.height ? this.x.height() : 0;
        if (h) this.byHeight.set(h, (this.byHeight.get(h) || 0) + dt);
        if (this.pressure && !document.hidden) {
          const m = this.pressureMs[bgWork.n > 0 ? 'bg' : 'idle'];
          m[this.pressure] = (m[this.pressure] || 0) + dt;
        }
        if (this.onBattery !== null) this.powerMs[this.onBattery ? 'battery' : 'ac'] += dt;
      }
    }
    this.lastTick = v.paused ? 0 : now;
  }

  // Dropped frames (counters start again when a video loads another stream), memory and the
  // estimated bandwidth while playing.
  sample() {
    for (const v of this.x.videos()) {
      if (!v || typeof v.getVideoPlaybackQuality !== 'function') continue;
      const q = v.getVideoPlaybackQuality();
      let f = this.frames.get(v);
      if (!f) { f = { dropped: 0, total: 0, base: { dropped: 0, total: 0 } }; this.frames.set(v, f); }
      if (q.totalVideoFrames < f.total) { f.base.dropped += f.dropped; f.base.total += f.total; }
      f.dropped = q.droppedVideoFrames;
      f.total = q.totalVideoFrames;
    }
    const mem = /** @type {any} */ (performance).memory;
    if (mem && mem.usedJSHeapSize > this.heap) this.heap = mem.usedJSHeapSize;
    const bw = this.x.bandwidth ? this.x.bandwidth() : NaN;
    if (!this.x.video.paused && bw > 0) this.value('bw', bw / 1000);
  }

  summary() {
    const x = this.x;
    this.tick();
    this.sample();
    const now = performance.now();
    let dropped = 0;
    let total = 0;
    for (const f of this.frames.values()) { dropped += f.base.dropped + f.dropped; total += f.base.total + f.total; }
    const visibleMs = this.visibleMs + (this.visibleSince ? now - this.visibleSince : 0);
    const top = (m) => { let best = null; let most = 0; for (const [k, ms] of m) if (ms > most) { most = ms; best = k; } return best; };
    // { key: percent of the total } of a Map or object of times (at most 12 keys).
    const shares = (m) => {
      const entries = (m instanceof Map ? [...m] : Object.entries(m)).filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]).slice(0, 12);
      const sum = entries.reduce((a, [, ms]) => a + ms, 0);
      if (!sum) return undefined;
      const out = {};
      for (const [k, ms] of entries) out[String(k)] = sig2((ms / sum) * 100);
      return out;
    };
    const some = (o) => (Object.keys(o).length ? Object.assign({}, o) : undefined);
    const slides = x.slides();
    const deck = x.deck();
    const silence = x.silence();
    const ocr = deck && deck.ocr;
    const ses = x.session();
    const dur = x.duration();
    const q = (name, p) => (this.vals[name] ? sig2(this.vals[name].q(p)) : undefined);
    const n = (name) => (this.vals[name] ? this.vals[name].n : undefined);
    // Interactions: those Event Timing did not report were faster than its threshold, and
    // count as TELEMETRY_INPUT_MIN_MS (so a percentile of 16 means "16 ms or less").
    const timed = [...this.inputMs].filter(([id]) => !this.inputUndrawn.has(id)).map(([, ms]) => ms).sort((a, b) => a - b);
    const fast = Math.max(0, this.inputs - timed.length - this.inputUndrawn.size);
    const inputQ = (p) => {
      const all = fast + timed.length;
      if (!all) return undefined;
      const r = clamp(Math.ceil(p * all), 1, all);
      return r <= fast ? TELEMETRY_INPUT_MIN_MS : sig2(timed[r - fast - 1]);
    };
    const slow = timed.filter((ms) => ms > TELEMETRY_SLOW_INPUT_MS).length;
    const power = this.powerMs;
    let watched = 0;
    try { for (const [a, b] of x.played ? x.played() : []) watched += Math.max(0, b - a); } catch (e) { watched = 0; }
    const s = {
      k: 'session', v: VERSION, sid: this.sid,
      // Which of Echo360's sites, and whether in another page's frame (a learning system).
      site: siteRegion(), framed: inFrame(),
      // Watching
      fromLoad: this.fromLoad,
      readyMs: Math.round(this.readyMs),
      // How the script started (00-boot.js): the way in, the page's state when it ran, the
      // time from then until the player was shown, the original's watch reports stopped.
      bootPath: this.fromLoad ? boot.path || undefined : undefined,
      injectState: this.fromLoad ? boot.readyState : undefined,
      bootMs: this.fromLoad && boot.readyAt ? Math.round(boot.readyAt - boot.at) : undefined,
      blockedReports: this.fromLoad && boot.path === 'takeover' ? boot.blocked : undefined,
      firstFrameMs: this.firstFrameMs == null ? undefined : this.firstFrameMs,
      seekN: n('seek'), seekMs50: q('seek', 0.5), seekMs90: q('seek', 0.9),
      rebufferN: this.rebufferN,
      rebufferSec: Math.round(this.rebufferMs / 100) / 10,
      rebufferPct: this.playMs > 0 ? sig2((this.rebufferMs / (this.playMs + this.rebufferMs)) * 100) : undefined,
      quality: shares(this.byHeight),
      levelSwitches: this.levels,
      bwKbps: q('bw', 0.5),
      syncMs50: q('sync', 0.5),
      syncMsMax: this.vals.sync ? sig2(this.vals.sync.max) : undefined,
      // Responsiveness and load
      inputN: fast + timed.length || undefined,
      inputMs50: inputQ(0.5),
      inputMs90: inputQ(0.9),
      inputSlow: fast + timed.length ? slow : undefined,
      longTasks: this.longTasks,
      longTasksPerMin: visibleMs > 60000 ? Math.round(this.longTasks / (visibleMs / 60000) * 10) / 10 : undefined,
      droppedPct: total > 0 ? Math.round(dropped / total * 10000) / 100 : undefined,
      heapMb: this.heap ? Math.round(this.heap / 1e5) / 10 : undefined,
      pressureBg: shares(this.pressureMs.bg),
      pressureIdle: shares(this.pressureMs.idle),
      power: power.ac > 0 && power.battery > 0 ? 'mixed' : power.ac > 0 ? 'ac' : power.battery > 0 ? 'battery' : undefined,
      // Background analyses
      streamMbPerHour: this.playMs >= 60000 ? sig2(this.streamBytes / 1e6 / (this.playMs / 3.6e6)) : undefined,
      bgMbPerHour: dur > 60 ? sig2(this.bgBytes / 1e6 / (dur / 3600)) : undefined,
      cacheHit: this.cacheHit, cacheMiss: this.cacheMiss,
      chaptersMs: this.marks.chapters == null ? undefined : sig2(this.marks.chapters),
      pdfMs: this.marks.pdf == null ? undefined : sig2(this.marks.pdf),
      scanMs: slides && slides.took != null ? slides.took : undefined,
      ocrFrameMs: ocr && ocr.stats && ocr.stats.read ? Math.round(ocr.stats.ms / ocr.stats.read) : undefined,
      silenceMs: silence && silence.took != null ? silence.took : undefined,
      // Stability
      guardOff: some(this.counts.guardOff),
      uncaught: this.uncaught,
      netErrors: some(this.counts.net),
      streamErrors: some(this.counts.stream),
      renewOk: ses ? ses.renewals : undefined,
      renewFail: ses ? ses.failures : undefined,
      frontend: echoFrontend() || undefined,
      // Habits
      playSec: Math.round(this.playMs / 1000),
      openSec: Math.round((now - this.opened) / 1000),
      watchedPct: dur > 0 ? sig2(Math.min(100, (watched / dur) * 100)) : undefined,
      speed: top(this.byRate) == null ? undefined : top(this.byRate),
      speeds: shares(this.byRate),
      layout: top(this.byLayout) || undefined,
      skipSilenceSec: Math.round(this.skipped.silence),
      skipBlankSec: Math.round(this.skipped.blank),
      keys: this.keys, clicks: this.clicks,
      features: some(this.features),
      changed: changedPrefs(x.prefs),
      lang: uiLang(),
      theme: x.prefs && x.prefs.theme,
      originalAfterSec: this.originalAfter == null ? undefined : this.originalAfter,
      // Analyses' results
      screen: !slides ? undefined : slides.manualScreen != null ? 'manual' : slides.screenIndex == null ? 'none' : slides.screenSure === false ? 'guess' : 'sure',
      slideSrc: !slides ? undefined : slides.source || 'none',
      slideStop: slides ? slides.stopped || undefined : undefined,
      slideForm: slides && slides.reader ? slides.reader.form || undefined : undefined,
      chaptersPerHour: slides && slides.state === 'done' && dur > 60 ? Math.round(slides.chapters.length / (dur / 3600) * 10) / 10 : undefined,
      pdfUnrecPct: deck && deck.decided && deck.decided.length ? Math.round(deck.decided.filter((p) => p < 0).length / deck.decided.length * 1000) / 10 : undefined,
      pageFixes: deck ? deck.corrections || 0 : undefined,
      layoutUndos: x.emptyScreen() ? x.emptyScreen().undos : undefined,
      // The usage data itself
      sendFail: this.self.sendFail,
      dropped: this.self.dropped,
      timerUs: telemetry.timerUs,
    };
    for (const m of WORK_MEASURES) {
      s[m + 'Ms50'] = q(m, 0.5);
      s[m + 'Ms90'] = q(m, 0.9);
      s[m + 'N'] = n(m);
    }
    for (const name of FIXED_STEPS) {
      const st = this.steps[name];
      if (!st) continue;
      s[name + 'V'] = st.v;
      s[name + 'P10'] = sig2(st.vals.q(0.1));
      s[name + 'P50'] = sig2(st.vals.q(0.5));
      s[name + 'P90'] = sig2(st.vals.q(0.9));
      s[name + 'N'] = st.vals.n;
      s[name + 'Cond'] = Object.assign({}, st.cond);
    }
    return s;
  }

  // Sends the summary so far (the Worker keeps the latest of this session).
  report(last) {
    try {
      if (!telemetry.enabled()) return;
      const now = performance.now();
      if ((now - this.opened) / 1000 < TELEMETRY_MIN_OPEN_SEC) return;
      // Hidden and then closed: one summary is enough.
      if (now - this.lastReport < 2000) return;
      this.lastReport = now;
      telemetry.send([this.summary()], last);
      telemetry.flushErrors(last);
    } catch (e) { /* not sent */ }
  }
}

// ---- 88-loading.js ----
// ===================================================================================
// The loading screen: the page's own player was caught (intercept path) and ours waits for
// hls.js. Without it the page would stay blank for the whole download, since neither player
// is there yet. Shown only when the wait is noticeable (LOADING_SHOW_MS): the lesson's title,
// the download's real progress, from LOADING_SLOW_MS how long it has waited and what happens
// at the time limit, a tip about the player to read meanwhile, and a way out to the original
// player at once. Removed when our player is built or the original one takes over.
// Costs: two timers while shown (at most HLS_LOAD_TIMEOUT_MS), none after.
// ===================================================================================

const LOADING_TIPS = ['loadingTip1', 'loadingTip2', 'loadingTip3', 'loadingTip4', 'loadingTip5', 'loadingTip6'];

const LOADING_CSS = `
/* max-width, max-height: as the player's (30-ui-assets.js), a page larger than a phone's screen. */
:host { all: initial; position: fixed; inset: 0; max-width: 100vw; max-height: 100vh; max-height: 100dvh; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
  background: #000; color: #ECEDEF; color-scheme: dark; padding: 16px; box-sizing: border-box;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; -webkit-font-smoothing: antialiased; }
.box { width: min(520px, 100%); display: flex; flex-direction: column; gap: 12px; }
.course { color: #A8ABB2; font-size: 13px; margin: 0; }
h1 { font-size: 20px; font-weight: 600; line-height: 1.3; margin: 0; overflow-wrap: anywhere; }
.bar { position: relative; height: 4px; border-radius: 2px; background: rgba(255,255,255,.16); overflow: hidden; margin-top: 8px; }
.bar i { position: absolute; inset: 0 auto 0 0; width: 100%; background: #3DBEC4; transform-origin: left; transform: scaleX(var(--p, 0));
  transition: transform 180ms cubic-bezier(.2,.8,.2,1); }
.bar.waiting i { width: 30%; transform: none; animation: slide 1.4s ease-in-out infinite; }
@keyframes slide { from { left: -30%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .bar.waiting i { animation: none; left: 0; opacity: .5; } .bar i { transition: none; } }
.status { color: #A8ABB2; font-size: 13px; margin: 0; min-height: 1.45em; }
.slow { color: #FFD38A; font-size: 13px; margin: 0; }
.tip { margin: 8px 0 0; padding: 10px 12px; border-radius: 8px; background: rgba(255,255,255,.08); color: #ECEDEF; font-size: 13px; }
.tip b { color: #3DBEC4; font-weight: 600; margin-right: 6px; }
button { all: unset; align-self: flex-start; cursor: pointer; color: #3DBEC4; font-size: 13px; font-weight: 600; padding: 6px 0; border-radius: 4px; }
button:hover { text-decoration: underline; }
button:focus-visible { outline: 2px solid #3DBEC4; outline-offset: 2px; }
@media (pointer: coarse) { button { min-height: 44px; display: inline-flex; align-items: center; } }
`;

class LoadingScreen {
  // lesson: the parsed lesson (title, courseName); onOriginal(): the user wants the original
  // player now.
  constructor(lesson, onOriginal) {
    this.lesson = lesson;
    this.onOriginal = onOriginal;
    this.host = null;
    this.bytes = 0;
    this.total = LIB_BYTES[HLS_LIB] || 0;
    this.started = Date.now();
    this.tip = Math.floor(Math.random() * LOADING_TIPS.length);
    this.showTimer = setTimeout(() => { this.showTimer = 0; this.show(); }, LOADING_SHOW_MS);
    this.tick = 0;
    this.nextTip = 0;
  }

  show() {
    const parent = document.body || document.documentElement;
    if (!parent) return;
    const host = document.createElement('div');
    host.id = 'lite-player-for-echo360-loading';
    host.lang = uiLocale();
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + LOADING_CSS + '</style><div class="box">'
      + '<p class="course"></p><h1></h1>'
      + '<div class="bar waiting" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div>'
      + '<p class="status" role="status" aria-live="polite"></p><p class="slow" hidden></p>'
      + '<p class="tip"><b></b><span></span></p><button type="button"></button></div>';
    const q = (s) => /** @type {HTMLElement} */ (root.querySelector(s));
    this.q = q;
    q('.course').textContent = this.lesson.courseName || '';
    q('.course').hidden = !this.lesson.courseName;
    q('h1').textContent = this.lesson.title || '';
    q('.bar').setAttribute('aria-label', tr('loadingPlayer'));
    q('.tip b').textContent = tr('loadingTipLabel');
    const btn = q('button');
    btn.textContent = tr('loadingUseOriginal');
    btn.addEventListener('click', () => { const f = this.onOriginal; this.dispose(); if (f) f(); });
    this.host = host;
    parent.appendChild(host);
    // The page under it does not scroll (as under the player).
    this.prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    this.render();
    this.tick = setInterval(() => this.render(), 1000);
  }

  // Bytes of hls.js received so far.
  progress(bytes) {
    this.bytes = bytes;
    if (this.host) this.render();
  }

  render() {
    const q = this.q;
    const kb = (n) => Math.round(n / 1024);
    const bar = q('.bar');
    if (this.bytes > 0 && this.total) {
      const p = clamp(this.bytes / this.total, 0, 1);
      bar.classList.remove('waiting');
      bar.style.setProperty('--p', String(p));
      bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
      q('.status').textContent = tr('loadingProgress', { done: kb(Math.min(this.bytes, this.total)), total: kb(this.total) });
    } else q('.status').textContent = tr('loadingPlayer');
    const waited = Date.now() - this.started;
    const slow = q('.slow');
    if (waited >= LOADING_SLOW_MS) {
      slow.hidden = false;
      slow.textContent = tr('loadingSlow', { s: Math.round(waited / 1000), limit: Math.round(HLS_LOAD_TIMEOUT_MS / 1000) });
    }
    const now = Date.now();
    if (now >= this.nextTip) {
      if (this.nextTip) this.tip++;
      this.nextTip = now + LOADING_TIP_MS;
      q('.tip span').textContent = tr(LOADING_TIPS[this.tip % LOADING_TIPS.length]);
    }
  }

  dispose() {
    clearTimeout(this.showTimer);
    clearInterval(this.tick);
    this.showTimer = 0;
    this.tick = 0;
    this.onOriginal = null;
    if (this.host) { this.host.remove(); document.documentElement.style.overflow = this.prevOverflow || ''; }
    this.host = null;
  }
}

// ---- 90-main.js ----
// ===================================================================================
// Bootstrap. Two ways in (boot.path, 00-boot.js):
//   intercept  the page's own player was caught before it started (the trap in 00-boot.js):
//              it never runs.
//   takeover   the page had started its player before this script ran (a manager that
//              injects late): the bootstrap data is read from the page, the original
//              player is stopped (its position and play state carried over) and its watch
//              reports are stopped at the network layer (15-takeover.js).
// Either way the same parser makes the lesson, and hls.js is loaded only then. Anything
// that does not work out leaves (or gives back) the page to the original player, with a
// notice saying why (fallback); a browser that cannot run the player is turned away
// before anything starts.
// ===================================================================================

// Why this browser cannot run the player ('' if it can): checked before anything starts.
// What the player needs; CSS aspect-ratio and createImageBitmap set the oldest browsers
// that pass (Safari 15: iOS and iPadOS 15).
function unsupportedReason() {
  const need = [
    ['Proxy', typeof Proxy === 'function'],
    ['fetch', typeof fetch === 'function'],
    ['AbortController', typeof AbortController === 'function'],
    ['Shadow DOM', typeof Element.prototype.attachShadow === 'function'],
    ['ResizeObserver', typeof ResizeObserver === 'function'],
    ['crypto.subtle', typeof crypto === 'object' && !!crypto.subtle],
    ['createImageBitmap', typeof createImageBitmap === 'function'],
    ['CSS aspect-ratio', typeof CSS === 'object' && typeof CSS.supports === 'function' && CSS.supports('aspect-ratio', '1')],
  ];
  const missing = need.filter(([, ok]) => !ok).map(([name]) => name);
  return missing.length ? 'browser too old (no ' + missing.join(', ') + ')' : '';
}

(function main() {
  // Rejections nobody handled: logged when they come from this script (the page's own are
  // not ours to report). Never a fallback.
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    const stack = String((r && r.stack) || '');
    if (/lite[ -]player[ -]for[ -]echo360/i.test(stack)) { log.warn('unhandled rejection', r); logEvent('warn', 'unhandled rejection: ' + ((r && r.message) || r)); }
  });
  if (boot.other) { log.warn('another copy (' + boot.other + ') already runs on this page: this one (' + VERSION + ') does nothing. Installed twice? Keep either the extension or the userscript.'); return; }
  if (courseList.matches()) { try { courseList.start(); } catch (e) { /* the page works without it */ } return; }
  const adapter = ADAPTERS.find((a) => { try { return a.matches(); } catch (e) { return false; } });
  if (!adapter) return;
  if (store.get('debug', false)) platform.page.__litePlayerForEcho360Boot = boot; // development only

  let booted = false;
  let player = null;
  // Why the page goes to the original player (usage data): the player's reasons.
  const FALLBACK_REASON = { error: 'playbackError', auth: 'auth', user: 'user', extras: 'extras', attachment: 'attachment' };

  // The page goes to (or stays with) the original player: why, for diagnostics.
  function fellBack(reason, detail) {
    boot.path = 'fallback';
    boot.reason = reason + (detail ? ': ' + detail : '');
    log.info('using the original player (' + boot.reason + ')');
    try { telemetry.fallback(reason); } catch (e) { /* not sent */ }
  }

  // Hands the page to the original player. Each step is protected: an exception here would
  // otherwise travel into the page's own start-up code.
  function startOriginal(callOriginal, arg, why) {
    if (player) { try { player.destroy(); } catch (e) { log.error('cleanup failed:', e); } player = null; }
    try { callOriginal(arg); } catch (e) { log.error('original player failed to start:', e); }
    try { cpuFix.start(); } catch (e) { log.warn('cpu fix failed:', e); }
    if (why) fallbackNotice(why);
  }

  // The original player keeps the page (taken over late, and something did not work out
  // before it was stopped).
  function keepOriginal(why) {
    try { cpuFix.start(); } catch (e) { log.warn('cpu fix failed:', e); }
    if (why) fallbackNotice(why);
  }

  // Our player for the page's bootstrap argument. takeover: the original player is running
  // (not yet stopped) and callOriginal would start it again.
  function launch(arg, callOriginal, takeover) {
    booted = true;
    if (store.get('forceOriginal', false)) {
      fellBack('user');
      if (!takeover) startOriginal(callOriginal, arg, null); else keepOriginal(null);
      return;
    }
    const giveUp = (reason, e) => {
      log.warn('could not start, using the original player:', e);
      fellBack(reason, String((e && e.message) || e));
      if (!takeover) startOriginal(callOriginal, arg, tr('fallbackNotice'));
      else keepOriginal(tr('fallbackNotice'));
    };
    const why = unsupportedReason();
    if (why) { giveUp('unsupported', why); return; }
    let lesson;
    try { lesson = adapter.parse(arg); } catch (e) { giveUp('startFailed', e); return; }
    const go = () => {
      // Checked before anything is built: without a way to play HLS, the original player.
      if (!canPlayHls()) { giveUp('noHls', new Error('this browser cannot play HLS here (no Media Source Extensions and no native HLS)')); return; }
      start(arg, callOriginal, takeover);
    };
    // hls.js already there (a development build injects it): at once.
    if (platform.Hls) { go(); return; }
    // Caught before it started, the original player is not on the page: while hls.js loads,
    // the loading screen (taken over, the original player plays on meanwhile). The user may
    // leave it for the original player; then a late hls.js is not used.
    let left = false;
    let screen = null;
    if (!takeover) {
      try {
        screen = new LoadingScreen(lesson, () => {
          left = true;
          fellBack('user', 'chose the original player while loading');
          startOriginal(callOriginal, arg, null);
        });
      } catch (e) { log.warn('loading screen failed:', e); }
    }
    const done = () => { if (screen) { try { screen.dispose(); } catch (e) { /* gone with the page */ } screen = null; } };
    platform.loadHls(HLS_LOAD_TIMEOUT_MS, screen ? (n) => { if (screen) screen.progress(n); } : undefined).then(
      // The loading screen goes first: the player keeps the page's state as it finds it (a
      // fallback later puts that back), so it must not find the loading screen's.
      () => { if (left) return; done(); go(); },
      (e) => { if (left) return; done(); giveUp('libFailed', e); });
  }

  function start(arg, callOriginal, takeover) {
    let stopped = null;
    let original = callOriginal;
    try {
      if (takeover) {
        // From here on the original player is stopped; going back to it starts it again.
        netGuard.start((m, u) => adapter.isWatchReport(m, u), null);
        original = (a) => { netGuard.stop(); if (stopped) stopped.restore(); return callOriginal(a); };
        stopped = adapter.stopOriginal(arg);
        boot.took = { at: stopped.at, playing: stopped.playing, unmounted: stopped.unmounted };
        if (!stopped.unmounted) {
          const box = stopped.container;
          netGuard.isOriginalMedia = (m) => !!box && box.contains(m);
          try { cpuFix.start(); } catch (e) { log.warn('cpu fix failed:', e); }
        }
        log.info('took over the original player (' + (stopped.unmounted ? 'unmounted' : 'removed from the page') + ', at '
          + (stopped.at == null ? '-' : fmtTime(stopped.at, true)) + ', ' + (stopped.playing ? 'playing' : 'paused') + ')');
      }
      const lesson = adapter.parse(arg);
      player = new LitePlayer(lesson, {
        fetchCues: adapter.fetchCues ? (l) => adapter.fetchCues(l) : null,
        api: adapter.api ? (l) => adapter.api(l) : null,
        takeover: stopped ? { at: stopped.at, playing: stopped.playing } : null,
        // The position handed over is the stream's: while it loads, the element says 0.
        onFallback(reason) {
          fellBack(FALLBACK_REASON[reason] || 'user');
          let handoff = arg;
          try { if (player) handoff = adapter.withStartTime(arg, player.clock.position()); } catch (e) { /* keep original arg */ }
          startOriginal(original, handoff, null);
        },
      });
      // Development only. `debug` is in the page's storage, which any script on the page can
      // set: what reaches the usage-data secret or lets a request past the page's reporting
      // guard is only there in the tests' builds.
      if (store.get('debug', false)) {
        platform.page.__litePlayerForEcho360 = player;
        platform.page.__litePlayerForEcho360Dev = Object.assign({ HlsVideoReader, frameLuma, thumbChange, learnThreshold, boot, bgWork },
          DEV_HOOKS ? { telemetry, telemetryEnv, TelemetryValues, sig2, netGuard, OWN_REQUEST } : {});
      }
      // Any unexpected error in our handlers from now on: hand the page to the original player.
      unexpected.handler = () => {
        if (!player) return;
        fellBack('coreError');
        let handoff = arg;
        try { handoff = adapter.withStartTime(arg, player.clock.position()); } catch (e) { /* keep original arg */ }
        startOriginal(original, handoff, tr('errorNotice'));
      };
      boot.path = takeover ? 'takeover' : 'intercept';
      boot.readyAt = performance.now();
      console.info(TAG, 'v' + VERSION + ' active (' + adapter.id + ', ' + boot.path + ', injected at ' + boot.readyState + ', '
        + lesson.sources.length + ' sources, reporting ' + (lesson.analytics ? 'on' : 'off') + ')');
    } catch (e) {
      log.warn('could not start, using the original player:', e);
      fellBack(canPlayHls() ? 'startFailed' : 'noHls', String((e && e.message) || e));
      if (takeover && !stopped) { netGuard.stop(); keepOriginal(tr('fallbackNotice')); return; }
      let handoff = arg;
      try { if (stopped && stopped.at != null) handoff = adapter.withStartTime(arg, stopped.at); } catch (err) { /* keep original arg */ }
      startOriginal(original, handoff, tr('fallbackNotice'));
    }
  }

  adapter.intercept((arg, callOriginal) => { launch(arg, callOriginal, false); return undefined; });

  // Started late: the page has started (or tried to start) its own player already, and will
  // not call the bootstrap again. Take it over.
  if (document.readyState === 'complete' && !boot.called) {
    const arg = adapter.bootArg();
    const callOriginal = adapter.original();
    if (arg == null || !callOriginal) {
      booted = true;
      fellBack('noBootData', arg == null ? 'the start-up data was not found on the page' : 'the page\'s player was not found');
      keepOriginal(tr('fallbackNotice'));
    } else {
      launch(arg, callOriginal, true);
    }
  }

  // If the page never calls the bootstrap we trapped (Echo360 changed how it starts), the
  // original player runs untouched: apply the CPU fix and say so once. A slow page may still
  // start late, so the notice waits until the original player is visibly there (a video on
  // the page), checking again for up to half a minute.
  const checkBootstrap = () => {
    let tries = 0;
    const check = () => {
      if (booted) return;
      if (!document.querySelector('video') && ++tries < 4) { setTimeout(check, BOOT_CHECK_MS); return; }
      fellBack('noBootstrap');
      cpuFix.start();
      fallbackNotice(tr('fallbackNotice'));
    };
    setTimeout(check, BOOT_CHECK_MS);
  };
  if (document.readyState === 'complete') checkBootstrap();
  else window.addEventListener('load', checkBootstrap, { once: true });
})();

})();
