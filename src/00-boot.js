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
