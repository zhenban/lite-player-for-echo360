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
