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
  const os = /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  const mgr = /^(\S+)\s*(\S*)/.exec(platform.manager()) || [];
  const known = ['Tampermonkey', 'Violentmonkey', 'Greasemonkey', 'ScriptCat', 'Userscripts', 'Stay'];
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
  current: null,       // the UsageSession of the player on the page
  sessions: 0,         // viewings started on this page
  errors: new Map(),   // key -> error event, waiting to be sent
  errorTimer: 0,
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
      if (r.status === 200) return;
      if ((r.status === 0 || r.status >= 500) && !last && k < TELEMETRY_RETRY_MS.length) {
        setTimeout(() => {
          if (!document.hidden && navigator.onLine !== false) this.send(events, false, k + 1);
        }, TELEMETRY_RETRY_MS[k]);
        return;
      }
      // Given up (a summary sent while the page closes is not waited for: not counted).
      if (!last) this.selfCount('sendFail');
    } catch (e) { /* dropped */ }
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
      if (this.enabled()) this.send([{ k: 'fallback', v: VERSION, reason, frontend: echoFrontend(), injectState: boot.readyState }]);
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
    if (telemetry.enabled()) telemetry.identity().catch(() => {});
    disposer.add(() => { this.report(true); if (telemetry.current === this) telemetry.current = null; });
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
