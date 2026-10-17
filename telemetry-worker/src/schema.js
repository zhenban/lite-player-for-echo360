// What the Worker accepts and stores: one list of fields per kind of event. Each field
// names its database column and a check; a value that fails the check is stored as NULL,
// and fields that are not listed are dropped. The player builds its events from the same
// lists (test/telemetry.test.mjs in the main repository checks that every field it sends is
// listed here).
//
// Kinds:
//   env       the computer and browser, at most once a day per user
//   session   one viewing of a recording, summed up when it ends or the page is hidden
//   error     a feature that failed (feature, error type, a message without addresses,
//             numbers or names)
//   fallback  the page went to the original player, and why

const HEX64 = /^[0-9a-f]{64}$/;
const SID = /^[0-9a-f]{16}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const int = (lo, hi) => (v) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const num = (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 1000) / 1000 : null);
const bool = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : null);
const text = (re, max) => (v) => (typeof v === 'string' && v.length <= max && re.test(v) ? v : null);
const oneOf = (list) => (v) => (list.includes(v) ? v : null);
// Two significant digits (the player rounds timings so; done again here).
const num2 = (lo, hi) => Object.assign((v) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Number(v.toPrecision(2)) : null), { twoDigits: true });

// Features whose use is counted (the player's feature ids, 87-telemetry.js).
export const FEATURES = [
  'play', 'seek', 'seekbar', 'chapter', 'volume', 'mute', 'fullscreen', 'swap', 'layout', 'speed',
  'captions', 'transcript', 'bookmark', 'flag', 'tag', 'notes', 'discussion', 'slides', 'copyFrame',
  'copyCaptions', 'zoom', 'loop', 'popout', 'exportNotes', 'help', 'pdfAdd', 'pdfTurn', 'pdfFix',
  'silenceSkip', 'quality', 'settings', 'original', 'diagnostics', 'backup', 'theme', 'language',
];
// Settings whose change from the default is reported (names only, never values).
export const PREFS = [
  'primary', 'layout', 'ratio', 'pipw', 'corner', 'rate', 'volume', 'muted', 'captions', 'capSize',
  'capHidePaused', 'panel', 'tab', 'panelw', 'audio.level', 'audio.voice', 'audio.mono', 'silence.auto',
  'silence.min', 'silence.sens', 'copySpan', 'pdfMain', 'pdfFirst', 'emptyCamera', 'quality.screen',
  'quality.camera', 'theme', 'lang',
];
export const FALLBACK_REASONS = ['startFailed', 'noHls', 'noBootstrap', 'coreError', 'playbackError', 'auth', 'user', 'extras', 'attachment',
  'unsupported', 'libFailed', 'noBootData'];
// The page's state when the script ran (document.readyState).
const READY_STATES = ['loading', 'interactive', 'complete'];

// { name: count } with known names and whole counts only.
const counts = (names) => (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, n] of Object.entries(v)) if (names.includes(k) && Number.isInteger(n) && n > 0 && n <= 100000) out[k] = n;
  return Object.keys(out).length ? JSON.stringify(out) : null;
};
// { key: number } with keys matching `re` (at most `most`) and values in [lo, hi].
const keyed = (re, most, lo, hi, whole) => (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > most) return null;
  const out = {};
  for (const [k, n] of entries) {
    if (!re.test(k) || typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi || (whole && !Number.isInteger(n))) continue;
    out[k] = whole ? n : Number(n.toPrecision(2));
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
};
// Shares in percent: { name: 0..100 }.
const shares = (re) => keyed(re, 12, 0, 100, false);
// Counts: { name: times }.
const tally = (re) => keyed(re, 20, 1, 1000000, true);
const THEMES = ['system', 'dark', 'light'];
// Measures of the analyses' real work (median, 90th percentile and count each) and the
// fixed steps that time this computer (87-telemetry.js: WORK_MEASURES, FIXED_STEPS).
const WORK = ['scanFrame', 'silenceMin', 'ocrMpx', 'pdfMpx'];
const STEPS = ['luma', 'loud'];

// A list of known names.
const names = (list) => (v) => {
  if (!Array.isArray(v) || v.length > list.length) return null;
  const out = [...new Set(v.filter((x) => list.includes(x)))].sort();
  return JSON.stringify(out);
};

// An error message with nothing that could point at a person or a recording: addresses,
// e-mail addresses, quoted text, long hexadecimal or numeric ids and other numbers are
// replaced. Done by the player before sending and again here.
export function plainMessage(s) {
  if (typeof s !== 'string') return null;
  const out = s
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
  return out || null;
}

// [field in the event, column, check]
export const KINDS = {
  env: [
    ['v', 'version', text(VERSION, 11)],
    ['browser', 'browser', oneOf(['Chrome', 'Edge', 'Firefox', 'Safari', 'Opera', 'other'])],
    ['browserV', 'browser_v', int(1, 999)],
    ['os', 'os', oneOf(['Windows', 'macOS', 'Linux', 'ChromeOS', 'Android', 'iOS', 'other'])],
    ['manager', 'manager', oneOf(['Tampermonkey', 'Violentmonkey', 'Greasemonkey', 'ScriptCat', 'Userscripts', 'Stay', 'other', 'none'])],
    ['managerV', 'manager_v', text(/^[\w.-]+$/, 20)],
    ['lang', 'lang', text(/^[a-z]{2}$/, 2)],
    ['browserLang', 'browser_lang', text(/^[a-z]{2,3}$/, 3)],
    ['touch', 'touch', bool],
    ['screenW', 'screen_w', int(1, 20000)],
    ['screenH', 'screen_h', int(1, 20000)],
    ['dpr', 'dpr', num(0.25, 10)],
    ['cores', 'cores', int(1, 1024)],
    ['memGb', 'mem_gb', num(0, 1024)],
    ['gpu', 'gpu', text(/^[\x20-\x7e]+$/, 120)],
    ['webgpu', 'webgpu', bool],
    ['webcodecs', 'webcodecs', bool],
    ['builtinAi', 'builtin_ai', bool],
    ['netType', 'net_type', oneOf(['slow-2g', '2g', '3g', '4g'])],
    ['downlink', 'downlink', num(0, 100000)],
    ['gpuVendor', 'gpu_vendor', text(/^[\w .-]+$/, 40)],
    ['gpuArch', 'gpu_arch', text(/^[\w .-]+$/, 40)],
    ['gpuFallback', 'gpu_fallback', bool],
    ['gpuF16', 'gpu_f16', bool],
    ['hw720', 'hw720', bool],
    ['hw1080', 'hw1080', bool],
    ['arch', 'arch', oneOf(['x86', 'arm', 'other'])],
    ['bitness', 'bitness', oneOf([32, 64])],
    ['osV', 'os_v', int(0, 999)],
    ['mobile', 'mobile', bool],
    ['model', 'model', text(/^[\w ()+.,/-]+$/, 40)],
    ['charging', 'charging', bool],
    ['pressureApi', 'pressure_api', bool],
    ['timerUs', 'timer_us', num2(0, 1000000)],
  ],
  session: [
    ['sid', 'sid', text(SID, 16)],
    ['v', 'version', text(VERSION, 11)],
    ['playSec', 'play_sec', int(0, 86400)],
    ['openSec', 'open_sec', int(0, 7 * 86400)],
    ['longTasksPerMin', 'long_tasks_pm', num(0, 10000)],
    ['droppedPct', 'dropped_pct', num(0, 100)],
    ['heapMb', 'heap_mb', num(0, 1000000)],
    ['firstFrameMs', 'first_frame_ms', int(0, 3600000)],
    ['rebufferN', 'rebuffer_n', int(0, 100000)],
    ['rebufferSec', 'rebuffer_sec', num(0, 86400)],
    ['scanMs', 'scan_ms', int(0, 86400000)],
    ['ocrFrameMs', 'ocr_frame_ms', num(0, 600000)],
    ['silenceMs', 'silence_ms', int(0, 86400000)],
    ['speed', 'speed', num(0.25, 4)],
    ['layout', 'layout', oneOf(['side', 'pip', 'single', 'pdf'])],
    ['keys', 'keys', int(0, 1000000)],
    ['clicks', 'clicks', int(0, 1000000)],
    ['features', 'features', counts(FEATURES)],
    ['changed', 'changed', names(PREFS)],
    ['screen', 'screen', oneOf(['sure', 'guess', 'manual', 'none'])],
    ['slideSrc', 'slide_src', oneOf(['frames', 'thumbs', 'none'])],
    ['slideStop', 'slide_stop', oneOf(['noWebCodecs', 'noFrame', 'decoder', 'playlist', 'network', 'other'])],
    ['chaptersPerHour', 'chapters_ph', num(0, 3600)],
    ['pdfUnrecPct', 'pdf_unrec_pct', num(0, 100)],
    ['pageFixes', 'page_fixes', int(0, 100000)],
    ['layoutUndos', 'layout_undos', int(0, 100000)],
    ['renewOk', 'renew_ok', int(0, 100000)],
    ['renewFail', 'renew_fail', int(0, 100000)],
    ['frontend', 'frontend', text(/^[\w.,-]+$/, 160)],
    // Watching
    ['fromLoad', 'from_load', bool],
    ['readyMs', 'ready_ms', int(0, 3600000)],
    ['bootPath', 'boot_path', oneOf(['intercept', 'takeover', 'fallback'])],
    ['injectState', 'inject_state', oneOf(READY_STATES)],
    ['bootMs', 'boot_ms', int(0, 3600000)],
    ['blockedReports', 'blocked_reports', int(0, 100000)],
    ['seekN', 'seek_n', int(0, 1000000)],
    ['seekMs50', 'seek_ms50', num2(0, 3600000)],
    ['seekMs90', 'seek_ms90', num2(0, 3600000)],
    ['rebufferPct', 'rebuffer_pct', num2(0, 100)],
    ['quality', 'quality', shares(/^\d{2,4}$/)],
    ['levelSwitches', 'level_switches', int(0, 1000000)],
    ['bwKbps', 'bw_kbps', num2(0, 10000000)],
    ['syncMs50', 'sync_ms50', num2(0, 3600000)],
    ['syncMsMax', 'sync_ms_max', num2(0, 3600000)],
    // Responsiveness and load
    ['inputN', 'input_n', int(0, 1000000)],
    ['inputMs50', 'input_ms50', num2(0, 600000)],
    ['inputMs90', 'input_ms90', num2(0, 600000)],
    ['inputSlow', 'input_slow', int(0, 1000000)],
    ['longTasks', 'long_tasks', int(0, 10000000)],
    ['pressureBg', 'pressure_bg', shares(/^(nominal|fair|serious|critical)$/)],
    ['pressureIdle', 'pressure_idle', shares(/^(nominal|fair|serious|critical)$/)],
    ['power', 'power', oneOf(['ac', 'battery', 'mixed'])],
    // Background analyses
    ['streamMbPerHour', 'stream_mb_ph', num2(0, 100000)],
    ['bgMbPerHour', 'bg_mb_ph', num2(0, 100000)],
    ['cacheHit', 'cache_hit', int(0, 100000)],
    ['cacheMiss', 'cache_miss', int(0, 100000)],
    ['chaptersMs', 'chapters_ms', num2(0, 86400000)],
    ['pdfMs', 'pdf_ms', num2(0, 86400000)],
    // Stability
    ['guardOff', 'guard_off', tally(/^[a-z][a-z ()-]{0,39}$/)],
    ['uncaught', 'uncaught', int(0, 1000000)],
    ['netErrors', 'net_errors', tally(/^(401|403|4xx|5xx|timeout|network|other)$/)],
    ['streamErrors', 'stream_errors', tally(/^[A-Za-z]{1,40}$/)],
    // Habits
    ['watchedPct', 'watched_pct', num2(0, 100)],
    ['speeds', 'speeds', shares(/^\d(\.\d{1,3})?$/)],
    ['skipSilenceSec', 'skip_silence_sec', int(0, 86400)],
    ['skipBlankSec', 'skip_blank_sec', int(0, 86400)],
    ['lang', 'lang', text(/^[a-z]{2}$/, 2)],
    ['theme', 'theme', oneOf(THEMES)],
    ['originalAfterSec', 'original_after_sec', int(0, 86400)],
    // The usage data itself
    ['sendFail', 'send_fail', int(0, 100000)],
    ['dropped', 'dropped', int(0, 100000)],
    ['timerUs', 'timer_us', num2(0, 1000000)],
    // Kept together as JSON (a dotted column: column.key.subkey), since D1 allows at most
    // 100 columns a table: work {scanFrame: {ms50, ms90, n}, ...}, steps {luma: {v, p10,
    // p50, p90, n, cond}, ...}.
    ...WORK.flatMap((f) => [
      [f + 'Ms50', 'work.' + f + '.ms50', num2(0, 86400000)],
      [f + 'Ms90', 'work.' + f + '.ms90', num2(0, 86400000)],
      [f + 'N', 'work.' + f + '.n', int(0, 10000000)],
    ]),
    ...STEPS.flatMap((f) => [
      [f + 'V', 'steps.' + f + '.v', int(1, 999)],
      [f + 'P10', 'steps.' + f + '.p10', num2(0, 1000000)],
      [f + 'P50', 'steps.' + f + '.p50', num2(0, 1000000)],
      [f + 'P90', 'steps.' + f + '.p90', num2(0, 1000000)],
      [f + 'N', 'steps.' + f + '.n', int(0, 1000000)],
      [f + 'Cond', 'steps.' + f + '.cond', tally(/^(playing|paused|rate:\d(\.\d{1,3})?|cpu:(nominal|fair|serious|critical|unknown)|power:(ac|battery|unknown))$/)],
    ]),
  ],
  error: [
    ['v', 'version', text(VERSION, 11)],
    ['feature', 'feature', text(/^[a-z][a-z ()-]*$/, 40)],
    ['type', 'type', text(/^[A-Za-z]\w*$/, 40)],
    ['msg', 'msg', plainMessage],
    ['n', 'n', int(1, 100000)],
  ],
  fallback: [
    ['v', 'version', text(VERSION, 11)],
    ['reason', 'reason', oneOf(FALLBACK_REASONS)],
    ['frontend', 'frontend', text(/^[\w.,-]+$/, 160)],
    ['injectState', 'inject_state', oneOf(READY_STATES)],
  ],
};
// Without these an event is dropped.
const REQUIRED = { env: ['v'], session: ['sid', 'v'], error: ['v', 'feature'], fallback: ['v', 'reason'] };

export const TABLES = { env: 'env', session: 'sessions', error: 'errors', fallback: 'fallbacks' };

// The columns of one event, or null when it is not one we keep.
export function cleanEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev) || !Object.hasOwn(KINDS, ev.k)) return null;
  const row = {};
  const nested = {};
  for (const [field, column, check] of KINDS[ev.k]) {
    const v = Object.hasOwn(ev, field) ? check(ev[field]) : null;
    const path = column.split('.');
    if (path.length === 1) { row[column] = v; continue; }
    // A JSON column: only the values that pass, nested by the dotted path.
    if (!nested[path[0]]) nested[path[0]] = {};
    if (v == null) continue;
    const group = nested[path[0]];
    const inner = group[path[1]] || (group[path[1]] = {});
    inner[path[2]] = typeof v === 'string' && v[0] === '{' ? JSON.parse(v) : v;
  }
  for (const [column, group] of Object.entries(nested)) row[column] = Object.keys(group).length ? JSON.stringify(group) : null;
  for (const f of REQUIRED[ev.k]) {
    const col = KINDS[ev.k].find((x) => x[0] === f)[1];
    if (row[col] == null) return null;
  }
  return { kind: ev.k, row };
}

export function isUid(v) { return typeof v === 'string' && HEX64.test(v); }
// The secret: 32 random bytes in base64url (43 characters).
export function isSecret(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v); }
