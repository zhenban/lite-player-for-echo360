// Lite Player for Echo360, the extension's bridge: a content script in the extension's
// isolated world, run at document_start next to the player (player.js, in the page's world).
// It gives the player chrome.storage and the service worker, which the page's world cannot
// reach. How the two meet: src/06-platform-extension.js.
//
// What it keeps for the player (chrome.storage.local unless said otherwise):
//   private:<name>   values out of the page's reach (the usage-data secret); never synced
//   kv:<name>        the settings and saved positions, the same on every Echo360 site
//   prefs (sync)     the settings that follow the user's Chrome account (shared.js)
//   off              true: turned off with the toolbar button (popup.js)
//   viewed           lectures watched for a while (the toolbar's one rating line)
//   news             a version whose changes the player tells about once (background.js)
// It also answers the toolbar button about this page (status, diagnostics), when the page
// is one the player handles (the player said so: 'present').
(() => {
  const HELLO = 'lite-player-for-echo360:hello';
  const ACK = 'lite-player-for-echo360:ack';
  const TO_PAGE = 'lite-player-for-echo360:to-page';
  const TO_EXT = 'lite-player-for-echo360:to-ext';
  const KEY = 'private:';
  const { KV, PREFS } = LP;   // shared.js, loaded before this file
  // Chrome allows about one sync write every 2 s on average: at most one per SYNC_GAP_MS
  // per page, and none when nothing synced changed.
  const SYNC_GAP_MS = 5000;
  let node = null;
  let synced = null;   // the text last read from or written to sync
  let syncTimer = 0;
  let syncNext = null;
  const mineWritten = new Set();   // settings this page wrote (not sent back to it)
  let present = false;   // the player handles this page and answers questions
  const asked = new Map();
  let askSeq = 0;
  const ASK_MS = 3000;
  const MOMENT_MS = 10000;

  const toPage = (msg) => node.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(msg) }));

  function syncPrefs(text) {
    const p = LP.parse(text);
    if (!p) return;
    syncNext = LP.synced(p);
    if (syncTimer) return;
    const write = () => {
      syncTimer = 0;
      if (syncNext === null || syncNext === synced) return;
      synced = syncNext;
      syncNext = null;
      chrome.storage.sync.set({ prefs: synced }).catch(() => {});
      syncTimer = setTimeout(write, SYNC_GAP_MS);
    };
    write();
  }

  function receive(e) {
    let msg = null;
    try { msg = JSON.parse(e.detail); } catch (err) { return; }
    if (!msg) return;
    if (msg.type === 'set' && typeof msg.name === 'string' && typeof msg.text === 'string') {
      chrome.storage.local.set({ [KEY + msg.name]: msg.text }).catch(() => {});
    } else if (msg.type === 'kvset' && typeof msg.name === 'string' && typeof msg.text === 'string') {
      chrome.storage.local.set({ [KV + msg.name]: msg.text }).catch(() => {});
      if (msg.name === PREFS) { mineWritten.add(msg.text); syncPrefs(msg.text); }
    } else if (msg.type === 'kvdel' && typeof msg.name === 'string') {
      chrome.storage.local.remove(KV + msg.name).catch(() => {});
    } else if (msg.type === 'viewed') {
      // Counted for the toolbar's rating line (popup.js).
      chrome.storage.local.get('viewed').then((o) => chrome.storage.local.set({ viewed: (+o.viewed || 0) + 1 })).catch(() => {});
    } else if (msg.type === 'options' || msg.type === 'news') {
      chrome.runtime.sendMessage({ type: msg.type }).catch(() => {});
    } else if (msg.type === 'newsSeen') {
      chrome.storage.local.remove('news').catch(() => {});
    } else if (msg.type === 'present') {
      present = true;
    } else if (msg.type === 'answer') {
      const done = asked.get(msg.id);
      if (done) done(msg.value === undefined ? null : msg.value);
    } else if (msg.type === 'post' && typeof msg.url === 'string' && typeof msg.body === 'string') {
      const id = msg.id;
      chrome.runtime.sendMessage({ type: 'post', url: msg.url, body: msg.body, timeoutMs: +msg.timeoutMs || 0 })
        .then((r) => toPage({ type: 'posted', id, status: r ? r.status : 0, text: r ? r.text : '' }), () => toPage({ type: 'posted', id, status: 0, text: '' }));
    }
  }

  // Everything the player reads at start-up, in one message. The synced settings win over
  // this device's copy (changed on another computer since); this device's own stay.
  async function snapshot() {
    const values = {};
    const kv = {};
    try {
      const all = await chrome.storage.local.get(null);
      for (const [k, v] of Object.entries(all)) {
        if (typeof v !== 'string') continue;
        if (k.startsWith(KEY)) values[k.slice(KEY.length)] = v;
        else if (k.startsWith(KV)) kv[k.slice(KV.length)] = v;
      }
    } catch (e) { /* nothing read: the player starts with what the page has */ }
    try {
      const s = (await chrome.storage.sync.get('prefs')).prefs;
      if (typeof s === 'string' && LP.parse(s)) { synced = s; kv[PREFS] = LP.merged(kv[PREFS], s); }
    } catch (e) { /* sync off or unavailable: this device's copy */ }
    let off = false;
    let news = '';
    try {
      const o = await chrome.storage.local.get(['off', 'news']);
      off = o.off === true;
      news = typeof o.news === 'string' ? o.news : '';
    } catch (e) { /* on */ }
    return { values, kv, off, news };
  }

  // The toolbar's questions (popup.js): answered by the page's player, when there is one
  // here (frames without one stay silent, so the one with the player answers).
  function ask(name) {
    return new Promise((resolve) => {
      const id = ++askSeq;
      // The moment's picture may be a PDF page to draw first.
      const timer = setTimeout(() => done(null), name === 'moment' ? MOMENT_MS : ASK_MS);
      const done = (value) => { clearTimeout(timer); asked.delete(id); resolve(value); };
      asked.set(id, done);
      toPage({ type: 'ask', id, name });
    });
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !msg || msg.type !== 'ask' || !present || !node) return false;
    if (!['status', 'diagnostics', 'moment'].includes(msg.name)) return false;
    ask(msg.name).then(reply);
    return true;
  });
  // Settings changed elsewhere (the toolbar, the options page, another tab): the page's copy
  // follows (usage data turned off stops at once).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !node) return;
    const c = changes[KV + PREFS];
    if (!c || typeof c.newValue !== 'string') return;
    if (mineWritten.delete(c.newValue)) return;
    toPage({ type: 'prefs', name: PREFS, text: c.newValue });
  });

  function adopt(n) {
    if (node || !n || n.nodeType !== 1) return false;
    node = n;
    n.setAttribute('data-base', chrome.runtime.getURL(''));
    n.addEventListener(TO_EXT, receive);
    window.removeEventListener(HELLO, onHello, true);
    snapshot().then(({ values, kv, off, news }) => toPage({ type: 'kv', values, shared: kv, off, news }));
    return true;
  }

  const mine = document.createElement('span');
  function onHello(e) {
    if (e.relatedTarget === mine || !adopt(e.relatedTarget)) return;
    e.stopImmediatePropagation();
    node.dispatchEvent(new CustomEvent(ACK));
  }
  window.addEventListener(HELLO, onHello, true);
  mine.setAttribute('data-base', chrome.runtime.getURL(''));
  mine.addEventListener(ACK, () => adopt(mine), { once: true });
  window.dispatchEvent(new MouseEvent(HELLO, { relatedTarget: mine }));
  document.addEventListener('readystatechange', () => { if (!node) window.removeEventListener(HELLO, onHello, true); }, { once: true });
})();
