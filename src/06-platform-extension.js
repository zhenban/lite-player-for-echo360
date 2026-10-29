// ===================================================================================
// Platform in the Chrome extension: only in the extension build (build.mjs --target
// extension), where it replaces parts of `platform` (05-platform.js). The player runs in
// the page's world (a content script with world MAIN, like the userscript with
// @inject-into page); the extension's own parts are reached through a bridge, a content
// script in the extension's isolated world (extension/bridge.js):
//   - privateKv: chrome.storage.local, read once at start-up (platform.privateReady)
//   - kv: the settings and saved positions also live in the extension (the same on every
//     Echo360 site and in learning systems' frames; the settings follow the Chrome account,
//     bridge.js), read with the private values (platform.kvReady); the page's storage keeps
//     the rest (development switches, the reload marker), and is read for a setting the
//     extension does not have yet (kept there before 1.1.0)
//   - post: made by the extension's service worker (no cookies; the page's content
//     security policy does not apply there)
//   - off, toolbar: the toolbar button's switch (read with the settings), and its
//     questions to this page (status, diagnostics), answered through the bridge
//   - dataStore: tags, slide files, watched records and the analyses' caches, kept in the
//     extension's IndexedDB (the same on every Echo360 site, and reachable from the options
//     page) through a hidden frame of the extension (extension/store.js) and a MessagePort
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

// The page-storage names kept in the extension instead (see kv above).
const EXT_SHARED = (name) => name === NS + 'prefs' || name.startsWith(NS + 'pos:');

const extBridge = {
  node: null,        // the node the two worlds talk through
  base: '',          // the package's URL (chrome-extension://<id>/)
  kv: new Map(),     // private values (chrome.storage.local), as read at start-up and written since
  shared: new Map(), // settings and positions (EXT_SHARED), likewise
  kvRead: false,     // the settings were read, or no longer waited for (platform.whenKv)
  off: false,        // turned off with the toolbar button
  news: '',          // a version whose changes are told once (background.js), or ''
  momentKey: '',     // the shortcut for "Add lecture moment", or '' (none set)
  copies: 0,         // pictures and texts copied so far (the first ones tip that shortcut)
  answers: null,     // the toolbar's questions: name -> () => value (platform.toolbar)
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
    // The player may have offered answers before the bridge was there (it ran first). Sent
    // after this turn: the bridge starts listening once it has the acknowledgement.
    Promise.resolve().then(() => { if (this.answers) this.send({ type: 'present' }); });
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
      const shared = msg.shared && typeof msg.shared === 'object' ? msg.shared : {};
      for (const [k, v] of Object.entries(shared)) if (typeof v === 'string' && EXT_SHARED(k) && !this.shared.has(k)) this.shared.set(k, v);
      this.off = msg.off === true;
      this.news = typeof msg.news === 'string' && /^\d+\.\d+$/.test(msg.news) ? msg.news : '';
      this.momentKey = typeof msg.momentKey === 'string' && msg.momentKey.length <= 40 ? msg.momentKey : '';
      this.copies = Math.max(this.copies, Number.isInteger(msg.copies) ? msg.copies : 0);
      this.readyResolve();
    } else if (msg.type === 'prefs' && typeof msg.name === 'string' && typeof msg.text === 'string' && EXT_SHARED(msg.name)) {
      // Changed in the toolbar or the options page (read again where it is used: whether
      // usage data is sent, before each request).
      this.shared.set(msg.name, msg.text);
    } else if (msg.type === 'ask' && typeof msg.name === 'string') {
      const fn = this.answers && Object.prototype.hasOwnProperty.call(this.answers, msg.name) ? this.answers[msg.name] : null;
      const id = msg.id;
      new Promise((resolve) => resolve(fn ? fn() : null))
        .then((value) => this.send({ type: 'answer', id, value: value === undefined ? null : value }), () => this.send({ type: 'answer', id, value: null }));
    } else if (msg.type === 'posted') {
      const done = this.replies.get(msg.id);
      if (done) done(+msg.status || 0, typeof msg.text === 'string' ? msg.text : '');
    }
  },
};
extBridge.start();

// Run once the settings are read (or EXT_KV_WAIT_MS has passed without them).
const extKvWaiting = [];
const extKvDone = () => {
  if (extBridge.kvRead) return;
  extBridge.kvRead = true;
  for (const fn of extKvWaiting.splice(0)) { try { fn(); } catch (e) { console.error(TAG, e); } }
};
extBridge.ready.then(extKvDone);
setTimeout(extKvDone, EXT_KV_WAIT_MS);

// The extension's data store (extension/store.js): a hidden frame, made when first needed.
// Its requests: get, keys, write (entries), and lock (keys) -> commit / release, which make
// a read-change-write that no other tab can overtake (61-media-io.js, idbCache).
const extStore = {
  ready: null,       // Promise of the backend, or rejected (the page's own storage is used)
  port: null,
  frame: null,
  seq: 0,
  calls: new Map(),  // id -> { resolve, reject, timer }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!extBridge.base) { reject(new Error('the extension is not reachable')); return; }
      const origin = new URL(extBridge.base).origin;
      const frame = document.createElement('iframe');
      frame.src = extBridge.base + 'store.html';
      frame.style.display = 'none';
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      this.frame = frame;
      const stop = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); };
      const timer = setTimeout(() => { stop(); frame.remove(); reject(new Error('the data store did not answer')); }, EXT_STORE_WAIT_MS);
      const onMessage = (e) => {
        if (e.source !== frame.contentWindow || e.origin !== origin || e.data !== 'lite-player-for-echo360:store-ready') return;
        stop();
        const ch = new MessageChannel();
        ch.port1.onmessage = (m) => this.receive(m.data);
        frame.contentWindow.postMessage('lite-player-for-echo360:store', origin, [ch.port2]);
        this.port = ch.port1;
        resolve(this.backend);
      };
      window.addEventListener('message', onMessage);
      document.documentElement.appendChild(frame);
    });
    return this.ready;
  },

  receive(m) {
    const c = m && this.calls.get(m.id);
    if (!c) return;
    this.calls.delete(m.id);
    clearTimeout(c.timer);
    if (m.ok) c.resolve(m.value); else c.reject(new Error('data store: ' + m.error));
  },

  call(msg) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.calls.delete(id);
        // Gone with its frame: the next request makes a new one.
        if (this.frame) this.frame.remove();
        this.port = null;
        this.ready = null;
        reject(new Error('data store: no answer'));
      }, EXT_STORE_OP_MS);
      this.calls.set(id, { resolve, reject, timer });
      this.port.postMessage(Object.assign({ id }, msg));
    });
  },

  // Each request makes sure there is a frame (a lost one is made again).
  async request(msg) {
    if (!this.port) await this.connect();
    return this.call(msg);
  },

  backend: null,
};
extStore.backend = {
  where: 'extension',
  get: (key) => extStore.request({ op: 'get', key }),
  keys: () => extStore.request({ op: 'keys' }),
  write: (entries) => extStore.request({ op: 'write', entries }),
  async updateMany(keys, fn) {
    const { lock, old } = await extStore.request({ op: 'lock', keys });
    let next;
    try { next = fn(old || {}); } catch (e) { extStore.call({ op: 'release', lock }).catch(() => {}); throw e; }
    await extStore.call({ op: 'commit', lock, entries: Object.entries(next) });
    return next;
  },
};

// The page's storage, for what stays there.
const extPageKv = platform.kv;

Object.assign(platform, {
  name: 'extension',
  privateReady: extBridge.ready,
  // Settings are needed to start: waited for, but not for ever (without the bridge, the
  // page's copy).
  whenKv(fn) {
    if (extBridge.kvRead) { fn(); return; }
    extKvWaiting.push(fn);
  },
  kv: {
    get(name) {
      if (!EXT_SHARED(name)) return extPageKv.get(name);
      const v = extBridge.shared.get(name);
      return typeof v === 'string' ? v : extPageKv.get(name);
    },
    set(name, text) {
      if (!EXT_SHARED(name) || !extBridge.node) { extPageKv.set(name, text); return; }
      extBridge.shared.set(name, text);
      extBridge.send({ type: 'kvset', name, text });
    },
    remove(name) {
      extPageKv.remove(name);
      if (!EXT_SHARED(name) || !extBridge.node) return;
      extBridge.shared.delete(name);
      extBridge.send({ type: 'kvdel', name });
    },
    names() {
      return [...new Set([...extPageKv.names(), ...extBridge.shared.keys()])];
    },
  },
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
  dataStore() { return extStore.connect(); },
  openSettings() { extBridge.send({ type: 'options' }); },
  off() { return extBridge.off; },
  toolbar(answers) {
    extBridge.answers = answers;
    extBridge.send({ type: 'present' });
  },
  viewed() { extBridge.send({ type: 'viewed' }); },
  news() { return extBridge.news; },
  newsSeen() { extBridge.news = ''; extBridge.send({ type: 'newsSeen' }); },
  openNews() { extBridge.send({ type: 'news' }); },
  momentKey() { return extBridge.momentKey; },
  lectureShown() { extBridge.send({ type: 'lectureShown' }); },
  copied() { extBridge.send({ type: 'copied' }); return extBridge.copies++; },
  privateKv: {
    get(name) { const v = extBridge.kv.get(name); return typeof v === 'string' ? v : null; },
    set(name, text) { extBridge.kv.set(name, text); extBridge.send({ type: 'set', name, text }); },
  },
  manager() { return 'extension ' + VERSION; },
});
