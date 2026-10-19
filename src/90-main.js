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
