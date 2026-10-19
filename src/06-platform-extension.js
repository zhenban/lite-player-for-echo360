// ===================================================================================
// Platform in the Chrome extension: only in the extension build (build.mjs --target
// extension), where it replaces parts of `platform` (05-platform.js). The player runs in
// the page's world (a content script with world MAIN, like the userscript with
// @inject-into page); the extension's own parts are reached through a bridge, a content
// script in the extension's isolated world (extension/bridge.js):
//   - privateKv: chrome.storage.local, read once at start-up (platform.privateReady)
//   - post: made by the extension's service worker (no cookies; the page's content
//     security policy does not apply there)
//   - libraries: shipped in the package; Tesseract's language data other than English comes
//     from the CDN, hash checked as in the userscript
// The two worlds share the DOM. They meet at start-up, before any of the page's scripts has
// run: each sends a synchronous event carrying a node that is in no document, and the first
// to be heard is acknowledged. After that they talk only through events on that node, which
// the page's scripts cannot reach.
// ===================================================================================

const EXT_HELLO = 'lite-player-for-echo360:hello';
const EXT_ACK = 'lite-player-for-echo360:ack';
const EXT_TO_PAGE = 'lite-player-for-echo360:to-page';
const EXT_TO_EXT = 'lite-player-for-echo360:to-ext';
// The library files shipped in the package (build.mjs puts them under lib/); the others
// (language data other than English) come from the CDN.
const EXT_SHIPPED = /^(hls\.js|pdfjs-dist|tesseract\.js|tesseract\.js-core)@|^@tesseract\.js-data\/eng@/;

const extBridge = {
  node: null,        // the node the two worlds talk through
  base: '',          // the package's URL (chrome-extension://<id>/)
  kv: new Map(),     // chrome.storage.local, as read at start-up and written since
  replies: new Map(),
  seq: 0,
  ready: null,       // resolves once kv is read
  readyResolve: /** @type {(value?: any) => void} */ (() => {}),
  onHello: null,

  adopt(node) {
    if (this.node || !node || node.nodeType !== 1) return false;
    this.node = node;
    node.addEventListener(EXT_TO_PAGE, (e) => this.receive(e));
    window.removeEventListener(EXT_HELLO, this.onHello, true);
    return true;
  },

  start() {
    this.ready = new Promise((resolve) => { this.readyResolve = resolve; });
    const mine = document.createElement('span');
    this.onHello = (e) => {
      const other = /** @type {MouseEvent} */ (e).relatedTarget;
      if (other === mine || !this.adopt(/** @type {Element} */ (other))) return;
      e.stopImmediatePropagation();
      this.node.dispatchEvent(new CustomEvent(EXT_ACK));
      this.base = this.node.getAttribute('data-base') || '';
    };
    window.addEventListener(EXT_HELLO, this.onHello, true);
    mine.addEventListener(EXT_ACK, () => { if (this.adopt(mine)) this.base = mine.getAttribute('data-base') || ''; }, { once: true });
    window.dispatchEvent(new MouseEvent(EXT_HELLO, { relatedTarget: mine }));
    // Not met by the time the page's own scripts run: nothing is listened to from then on
    // (the page's scripts could pose as the bridge). Usage data then waits for ever.
    document.addEventListener('readystatechange', () => { if (!this.node) window.removeEventListener(EXT_HELLO, this.onHello, true); }, { once: true });
  },

  send(msg) {
    if (this.node) this.node.dispatchEvent(new CustomEvent(EXT_TO_EXT, { detail: JSON.stringify(msg) }));
  },

  receive(e) {
    let msg = null;
    try { msg = JSON.parse(/** @type {CustomEvent} */ (e).detail); } catch (err) { return; }
    if (!msg) return;
    if (msg.type === 'kv' && msg.values && typeof msg.values === 'object') {
      // Written before the snapshot arrived: kept.
      for (const [k, v] of Object.entries(msg.values)) if (typeof v === 'string' && !this.kv.has(k)) this.kv.set(k, v);
      this.readyResolve();
    } else if (msg.type === 'posted') {
      const done = this.replies.get(msg.id);
      if (done) done(+msg.status || 0, typeof msg.text === 'string' ? msg.text : '');
    }
  },
};
extBridge.start();

Object.assign(platform, {
  name: 'extension',
  privateReady: extBridge.ready,
  libUrl(path) {
    return extBridge.base && EXT_SHIPPED.test(path) ? extBridge.base + 'lib/' + path : 'https://cdn.jsdelivr.net/npm/' + path;
  },
  // As in 05-platform.js; keepalive is not needed (the service worker outlives the page).
  post(url, body, timeoutMs) {
    return new Promise((resolve) => {
      if (!extBridge.node) { resolve({ status: 0, text: '' }); return; }
      const id = ++extBridge.seq;
      const timer = setTimeout(() => done(0, ''), timeoutMs + 5000);
      const done = (status, text) => { clearTimeout(timer); extBridge.replies.delete(id); resolve({ status, text }); };
      extBridge.replies.set(id, done);
      extBridge.send({ type: 'post', id, url, body, timeoutMs });
    });
  },
  privateKv: {
    get(name) { const v = extBridge.kv.get(name); return typeof v === 'string' ? v : null; },
    set(name, text) { extBridge.kv.set(name, text); extBridge.send({ type: 'set', name, text }); },
  },
  manager() { return 'extension ' + VERSION; },
});
