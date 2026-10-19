// Lite Player for Echo360, the extension's bridge: a content script in the extension's
// isolated world, run at document_start next to the player (player.js, in the page's world).
// It gives the player chrome.storage.local and the service worker, which the page's world
// cannot reach. How the two meet: src/06-platform-extension.js.
(() => {
  const HELLO = 'lite-player-for-echo360:hello';
  const ACK = 'lite-player-for-echo360:ack';
  const TO_PAGE = 'lite-player-for-echo360:to-page';
  const TO_EXT = 'lite-player-for-echo360:to-ext';
  const KEY = 'private:';   // the player's private values in chrome.storage.local
  let node = null;

  const toPage = (msg) => node.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(msg) }));

  function receive(e) {
    let msg = null;
    try { msg = JSON.parse(e.detail); } catch (err) { return; }
    if (!msg) return;
    if (msg.type === 'set' && typeof msg.name === 'string' && typeof msg.text === 'string') {
      chrome.storage.local.set({ [KEY + msg.name]: msg.text }).catch(() => {});
    } else if (msg.type === 'post' && typeof msg.url === 'string' && typeof msg.body === 'string') {
      const id = msg.id;
      chrome.runtime.sendMessage({ type: 'post', url: msg.url, body: msg.body, timeoutMs: +msg.timeoutMs || 0 })
        .then((r) => toPage({ type: 'posted', id, status: r ? r.status : 0, text: r ? r.text : '' }), () => toPage({ type: 'posted', id, status: 0, text: '' }));
    }
  }

  function adopt(n) {
    if (node || !n || n.nodeType !== 1) return false;
    node = n;
    n.setAttribute('data-base', chrome.runtime.getURL(''));
    n.addEventListener(TO_EXT, receive);
    window.removeEventListener(HELLO, onHello, true);
    chrome.storage.local.get(null).then((all) => {
      const values = {};
      for (const [k, v] of Object.entries(all)) if (k.startsWith(KEY) && typeof v === 'string') values[k.slice(KEY.length)] = v;
      toPage({ type: 'kv', values });
    }, () => toPage({ type: 'kv', values: {} }));
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
