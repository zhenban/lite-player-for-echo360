// Lite Player for Echo360, the extension's bridge: a content script in the extension's
// isolated world, run at document_start next to the player (player.js, in the page's world).
// It gives the player chrome.storage and the service worker, which the page's world cannot
// reach. How the two meet: src/06-platform-extension.js.
//
// What it keeps for the player (chrome.storage.local unless said otherwise):
//   private:<name>   values out of the page's reach (the usage-data secret); never synced
//   kv:<name>        the settings and saved positions, the same on every Echo360 site
//   prefs (sync)     the settings that follow the user's Chrome account: all but those of
//                    this device's screen and sound (DEVICE_PREFS)
(() => {
  const HELLO = 'lite-player-for-echo360:hello';
  const ACK = 'lite-player-for-echo360:ack';
  const TO_PAGE = 'lite-player-for-echo360:to-page';
  const TO_EXT = 'lite-player-for-echo360:to-ext';
  const KEY = 'private:';
  const KV = 'kv:';
  const PREFS = 'lite-player-for-echo360:prefs';   // the player's name for its settings
  // Settings of this device, not synced: the layout suits its screen, the volume and quality
  // its speakers and connection.
  const DEVICE_PREFS = ['primary', 'layout', 'ratio', 'pipw', 'corner', 'panel', 'panelw', 'volume', 'muted', 'quality'];
  // Chrome allows about one sync write every 2 s on average: at most one per SYNC_GAP_MS
  // per page, and none when nothing synced changed.
  const SYNC_GAP_MS = 5000;
  let node = null;
  let synced = null;   // the text last read from or written to sync
  let syncTimer = 0;
  let syncNext = null;

  const toPage = (msg) => node.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(msg) }));
  const parse = (text) => { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; } };
  const shared = (prefs) => {
    const out = {};
    for (const [k, v] of Object.entries(prefs)) if (!DEVICE_PREFS.includes(k)) out[k] = v;
    return JSON.stringify(out);
  };

  function syncPrefs(text) {
    const p = parse(text);
    if (!p) return;
    syncNext = shared(p);
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
      if (msg.name === PREFS) syncPrefs(msg.text);
    } else if (msg.type === 'kvdel' && typeof msg.name === 'string') {
      chrome.storage.local.remove(KV + msg.name).catch(() => {});
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
      const fromSync = typeof s === 'string' ? parse(s) : null;
      if (fromSync) {
        synced = s;
        const mine = parse(kv[PREFS] || '') || {};
        for (const k of DEVICE_PREFS) delete fromSync[k];
        kv[PREFS] = JSON.stringify(Object.assign(mine, fromSync));
      }
    } catch (e) { /* sync off or unavailable: this device's copy */ }
    return { values, kv };
  }

  function adopt(n) {
    if (node || !n || n.nodeType !== 1) return false;
    node = n;
    n.setAttribute('data-base', chrome.runtime.getURL(''));
    n.addEventListener(TO_EXT, receive);
    window.removeEventListener(HELLO, onHello, true);
    snapshot().then(({ values, kv }) => toPage({ type: 'kv', values, shared: kv }));
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
