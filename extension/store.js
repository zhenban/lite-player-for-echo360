// Lite Player for Echo360, the extension's data store: tags, slide files and their
// corrections, what was watched, and the analyses' caches, in the extension's own IndexedDB
// (the same on every Echo360 site, and reachable from the options page for backups).
// The player cannot open the extension's storage from the page, so it puts this page in a
// hidden frame (store.html) and talks to it through a MessagePort, which carries Blobs
// (slide PDFs) as they are. How the player uses it: src/61-media-io.js (idbCache).
//
// Only an Echo360 site may use it: the frame refuses any other parent (and the manifest
// lets only those sites load it).
//
// Messages, each { id, op, ... } answered by { id, ok, value } or { id, ok: false, error }:
//   get key        keys           the value / all keys
//   write entries  [[key, value | undefined (delete)], ...] in one transaction
//   lock keys      waits for the write lock, then answers { lock, old: { key: value } }; the
//                  lock is held until commit (lock, entries) or release (lock), or for
//                  STORE_LOCK_MS at most. Every write takes the same lock, in every tab,
//                  so a read-change-write cannot be overtaken (Web Locks: one origin).
(() => {
  const SITES = "{{SITES}}".map((s) => s.replace(/\/\*$/, ''));
  const STORE_LOCK_MS = 10000;
  const LOCK = 'lite-player-for-echo360:db';
  const parent = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  if (window.parent === window || !SITES.includes(parent)) return;

  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('lite-player-for-echo360', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('cache')) req.result.createObjectStore('cache'); };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbp = null; };
        db.onclose = () => { dbp = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction('cache', mode);
      const req = fn(t.objectStore('cache'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    }));
  }
  const write = (entries) => tx('readwrite', (s) => {
    for (const [k, v] of entries) { if (v === undefined) s.delete(k); else s.put(v, k); }
    return null;
  });
  const readMany = (keys) => tx('readonly', (s) => {
    const out = {};
    for (const k of keys) { const r = s.get(k); r.onsuccess = () => { out[k] = r.result; }; }
    return { get result() { return out; } };
  });
  // Runs fn with the write lock held; fn's promise decides when it is let go.
  const withLock = (fn) => navigator.locks.request(LOCK, fn);

  let lockSeq = 0;
  const held = new Map();   // lock id -> { release(), timer }

  function serve(port) {
    const answer = (id, p) => p.then((value) => port.postMessage({ id, ok: true, value }),
      (e) => port.postMessage({ id, ok: false, error: String((e && e.message) || e) }));
    port.onmessage = (e) => {
      const m = e.data || {};
      const id = m.id;
      const entries = Array.isArray(m.entries) ? m.entries.filter((x) => Array.isArray(x) && typeof x[0] === 'string') : [];
      if (m.op === 'get') answer(id, tx('readonly', (s) => s.get(String(m.key))));
      else if (m.op === 'keys') answer(id, tx('readonly', (s) => s.getAllKeys()));
      else if (m.op === 'write') answer(id, withLock(() => write(entries)));
      else if (m.op === 'lock') {
        const keys = Array.isArray(m.keys) ? m.keys.map(String) : [];
        answer(id, new Promise((resolve, reject) => {
          withLock(() => new Promise((release) => {
            const lock = ++lockSeq;
            const timer = setTimeout(() => { held.delete(lock); release(); }, STORE_LOCK_MS);
            held.set(lock, { release, timer });
            readMany(keys).then((old) => resolve({ lock, old }), (err) => { clearTimeout(timer); held.delete(lock); release(); reject(err); });
          })).catch(reject);
        }));
      } else if (m.op === 'commit' || m.op === 'release') {
        const h = held.get(m.lock);
        if (!h) { answer(id, Promise.reject(new Error('the lock was let go (too slow)'))); return; }
        held.delete(m.lock);
        clearTimeout(h.timer);
        const done = m.op === 'commit' ? write(entries) : Promise.resolve(null);
        done.finally(() => h.release());
        answer(id, done);
      }
    };
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== parent || e.data !== 'lite-player-for-echo360:store' || !e.ports[0]) return;
    serve(e.ports[0]);
  });
  window.parent.postMessage('lite-player-for-echo360:store-ready', parent);
})();
