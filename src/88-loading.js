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
