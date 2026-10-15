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
// Nothing is sent while the page is in the background (except the summary as it is
// hidden) or offline. A request that fails is tried twice more, later and only in the
// foreground, then dropped. Nothing here may disturb the player: every entry point
// catches its own errors and none of them reports to featureGuard.
// ===================================================================================

const TELEMETRY_URL = 'https://lite-player-telemetry.zhenban.workers.dev';
const TELEMETRY_SECRET_KEY = 'telemetrySecret';
const TELEMETRY_DAY_KEY = 'telemetryDay';

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
  const os = /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  const mgr = /^(\S+)\s*(\S*)/.exec(platform.manager()) || [];
  const known = ['Tampermonkey', 'Violentmonkey', 'Greasemonkey', 'ScriptCat', 'Userscripts'];
  const manager = known.includes(mgr[1]) ? mgr[1] : mgr[1] === 'unknown' ? 'none' : 'other';
  const conn = /** @type {any} */ (navigator).connection;
  const env = {
    k: 'env', v: VERSION, browser, browserV: m ? +m[2] : undefined, os,
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
  try {
    const gpu = /** @type {any} */ (navigator).gpu;
    if (gpu) env.webgpu = !!(await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 3000))]));
  } catch (e) { /* not available */ }
  return env;
}

const telemetry = {
  on: null,            // null: not read yet (from the settings)
  ids: null,           // Promise of { secret, uid }
  idNow: null,         // the same once known (a page that is closing cannot wait)
  current: null,       // the UsageSession of the player on the page
  errors: new Map(),   // key -> error event, waiting to be sent
  errorTimer: 0,

  enabled() {
    if (this.on === null) {
      let on = false;
      try { on = !store.get('telemetryOff', false) && sanitizePrefs(store.get('prefs', null)).telemetry; } catch (e) { on = false; }
      this.on = on;
    }
    return this.on;
  },

  // Turned on or off in the settings: off stops everything at once.
  setEnabled(on) {
    this.on = !!on;
    if (!on) { this.errors.clear(); clearTimeout(this.errorTimer); this.errorTimer = 0; }
  },

  // { secret, uid }: made on first use.
  identity() {
    if (!this.ids) {
      let p; // read inside the function once it has awaited, so set by then
      this.ids = p = (async () => {
        let secret = platform.privateKv.get(TELEMETRY_SECRET_KEY);
        if (!/^[A-Za-z0-9_-]{43}$/.test(secret || '')) {
          secret = newTelemetrySecret();
          platform.privateKv.set(TELEMETRY_SECRET_KEY, secret);
        }
        const id = { secret, uid: await sha256Hex(new TextEncoder().encode(secret)) };
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
    store.set(TELEMETRY_DAY_KEY, null);
  },

  // Sends events; never throws. `last`: the page is being hidden or closed (no retries).
  async send(events, last, attempt) {
    try {
      if (!this.enabled() || !events.length || navigator.onLine === false) return;
      // Sent at once while the page closes: nothing is awaited before the request.
      const { uid } = this.idNow || await this.identity();
      if (!this.enabled()) return;
      const r = await platform.post(TELEMETRY_URL + '/v1/events', JSON.stringify({ uid, events }), TELEMETRY_TIMEOUT_MS, !!last);
      const k = attempt || 0;
      if ((r.status === 0 || r.status >= 500) && !last && k < TELEMETRY_RETRY_MS.length) {
        setTimeout(() => {
          if (!document.hidden && navigator.onLine !== false) this.send(events, false, k + 1);
        }, TELEMETRY_RETRY_MS[k]);
      }
    } catch (e) { /* dropped */ }
  },

  // A request with the secret (viewing or deleting one's data): { status, data }.
  // Never rejects (status 0: no answer).
  async ask(path) {
    try {
      const { secret, uid } = await this.identity();
      const r = await platform.post(TELEMETRY_URL + path, JSON.stringify({ uid, secret }), TELEMETRY_TIMEOUT_MS);
      let data = null;
      try { data = JSON.parse(r.text); } catch (e) { data = null; }
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
      if (this.errors.size >= TELEMETRY_MAX_ERRORS) return;
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
      if (this.enabled()) this.send([{ k: 'fallback', v: VERSION, reason, frontend: echoFrontend() }]);
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

// One viewing: what it cost the computer, what was used, how the analyses did.
//
// deps: { root (the player's shadow root), video (the clock video), videos() (both),
//         prefs, layout() ('side' | 'pip' | 'single' | 'pdf', as shown), slides(), deck(),
//         silence() (the analyzer), emptyScreen(), session() (SessionKeeper), duration() }
class UsageSession {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.sid = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    this.opened = performance.now();
    this.features = {};
    this.keys = 0;
    this.clicks = 0;
    this.playMs = 0;
    this.byRate = new Map();       // playback rate -> ms played
    this.byLayout = new Map();     // layout -> ms played
    this.lastTick = 0;
    this.longTasks = 0;
    this.visibleMs = 0;
    this.visibleSince = document.hidden ? 0 : performance.now();
    this.firstFrameMs = null;
    this.rebufferN = 0;
    this.rebufferMs = 0;
    this.waitingSince = 0;
    this.heap = 0;
    this.frames = new Map();       // video -> { dropped, total, base: { dropped, total } }
    this.lastReport = -Infinity;
    telemetry.current = this;
    // The id is worked out now: a summary sent as the page closes cannot wait for it.
    if (telemetry.enabled()) telemetry.identity().catch(() => {});
    disposer.add(() => { this.report(true); if (telemetry.current === this) telemetry.current = null; });
    const v = deps.video;
    const on = (target, type, fn, opts) => disposer.listen(target, type, () => { try { fn(); } catch (e) { /* not counted */ } }, opts);
    on(v, 'timeupdate', () => this.tick());
    on(v, 'pause', () => { this.tick(); this.lastTick = 0; });
    on(v, 'loadeddata', () => { if (this.firstFrameMs == null) this.firstFrameMs = Math.round(performance.now()); });
    on(v, 'waiting', () => { if (!v.seeking && !v.paused && this.firstFrameMs != null && !this.waitingSince) this.waitingSince = performance.now(); });
    const resumed = () => {
      if (!this.waitingSince) return;
      this.rebufferN++;
      this.rebufferMs += performance.now() - this.waitingSince;
      this.waitingSince = 0;
    };
    on(v, 'playing', resumed);
    on(v, 'seeking', () => { this.waitingSince = 0; });
    on(document, 'visibilitychange', () => {
      if (document.hidden) {
        if (this.visibleSince) this.visibleMs += performance.now() - this.visibleSince;
        this.visibleSince = 0;
        this.report(true);
      } else this.visibleSince = performance.now();
    });
    on(window, 'pagehide', () => this.report(true));
    // Clicks on the player's controls (before their own handlers: counted even when a
    // handler stops the event).
    disposer.listen(deps.root, 'click', (e) => {
      try {
        const t = e.target;
        if (!t || !t.closest) return;
        for (const [sel, f] of CLICK_FEATURES) if (t.closest(sel)) { this.use(f, 'click'); return; }
      } catch (err) { /* not counted */ }
    }, true);
    if (typeof PerformanceObserver === 'function' && (PerformanceObserver.supportedEntryTypes || []).includes('longtask')) {
      const po = new PerformanceObserver((list) => { this.longTasks += list.getEntries().length; });
      po.observe({ type: 'longtask' });
      disposer.observe(po);
    }
    disposer.interval(() => { if (!document.hidden) this.sample(); }, TELEMETRY_SAMPLE_MS);
  }

  use(feature, via) {
    this.features[feature] = (this.features[feature] || 0) + 1;
    if (via === 'key') this.keys++; else if (via === 'click') this.clicks++;
  }

  // Playing time, by rate and layout (from timeupdate, about four times a second).
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
      }
    }
    this.lastTick = v.paused ? 0 : now;
  }

  // Dropped frames (counters start again when a video loads another stream) and memory.
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
  }

  summary() {
    const x = this.x;
    this.tick();
    this.sample();
    let dropped = 0;
    let total = 0;
    for (const f of this.frames.values()) { dropped += f.base.dropped + f.dropped; total += f.base.total + f.total; }
    const visibleMs = this.visibleMs + (this.visibleSince ? performance.now() - this.visibleSince : 0);
    const top = (m) => { let best = null; let most = 0; for (const [k, ms] of m) if (ms > most) { most = ms; best = k; } return best; };
    const slides = x.slides();
    const deck = x.deck();
    const silence = x.silence();
    const ocr = deck && deck.ocr;
    const ses = x.session();
    const dur = x.duration();
    const s = {
      k: 'session', v: VERSION, sid: this.sid,
      playSec: Math.round(this.playMs / 1000),
      openSec: Math.round((performance.now() - this.opened) / 1000),
      longTasksPerMin: visibleMs > 60000 ? Math.round(this.longTasks / (visibleMs / 60000) * 10) / 10 : undefined,
      droppedPct: total > 0 ? Math.round(dropped / total * 10000) / 100 : undefined,
      heapMb: this.heap ? Math.round(this.heap / 1e5) / 10 : undefined,
      firstFrameMs: this.firstFrameMs == null ? undefined : this.firstFrameMs,
      rebufferN: this.rebufferN,
      rebufferSec: Math.round(this.rebufferMs / 100) / 10,
      scanMs: slides && slides.took != null ? slides.took : undefined,
      ocrFrameMs: ocr && ocr.stats && ocr.stats.read ? Math.round(ocr.stats.ms / ocr.stats.read) : undefined,
      silenceMs: silence && silence.took != null ? silence.took : undefined,
      speed: top(this.byRate) == null ? undefined : top(this.byRate),
      layout: top(this.byLayout) || undefined,
      keys: this.keys, clicks: this.clicks,
      features: this.features,
      changed: changedPrefs(x.prefs),
      screen: !slides ? undefined : slides.manualScreen != null ? 'manual' : slides.screenIndex == null ? 'none' : slides.screenSure === false ? 'guess' : 'sure',
      chaptersPerHour: slides && slides.state === 'done' && dur > 60 ? Math.round(slides.chapters.length / (dur / 3600) * 10) / 10 : undefined,
      pdfUnrecPct: deck && deck.decided && deck.decided.length ? Math.round(deck.decided.filter((p) => p < 0).length / deck.decided.length * 1000) / 10 : undefined,
      pageFixes: deck ? deck.corrections || 0 : undefined,
      layoutUndos: x.emptyScreen() ? x.emptyScreen().undos : undefined,
      renewOk: ses ? ses.renewals : undefined,
      renewFail: ses ? ses.failures : undefined,
      frontend: echoFrontend() || undefined,
    };
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
