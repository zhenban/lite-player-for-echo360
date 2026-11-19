// ===================================================================================
// Analysis caches in IndexedDB: slide chapters, silence envelopes, text read on screen.
//
// - Each kind has a version tied to its algorithm. A stored result with another version
//   was made by different code and is computed again (bump the number when changing how
//   results are made, not only their format).
// - Each record carries `used`, the last time it was used (its own field: records already
//   use names such as `at` for their data). A minute after a player starts,
//   records of these kinds that were not used for CACHE_KEEP_DAYS, or are from another
//   version, are deleted in the background.
// - Settings menu: how much space they take, and clearing them all.
// User data is not an analysis cache. Most of it is kept for good (tags), but what only
// matters while a course runs is deleted when unused for USER_DATA_KEEP_DAYS
// (userData.prune): a recording's slide PDFs (the files themselves once no recording uses
// them), what was watched, and the saved position. A year covers a course and its exam.
// ===================================================================================

const CACHE_KINDS = {
  slides: 5,          // chapters (2: screen view chosen per recording, tolerant scanning; 3: uniform stretches; 4: 160 x 90, learnt threshold; 5: frozen views never the screen, kept as dead)
  'silence-env': 1,   // audio level envelope
  ocr: 1,             // text read on screen
};
const CACHE_KEEP_DAYS = 60;
const USER_DATA_KEEP_DAYS = 365;

function cacheKind(key) {
  const k = String(key).split(':')[0];
  return Object.prototype.hasOwnProperty.call(CACHE_KINDS, k) ? k : null;
}

function cacheVersion(kind) {
  return CACHE_KINDS[kind];
}

// Whether a stored record of `kind` can be used.
function cacheValid(kind, rec) {
  return !!rec && typeof rec === 'object' && rec.v === CACHE_KINDS[kind];
}

// The record with its last use set to now (nothing else changes).
function cacheTouched(rec, now) {
  return rec && typeof rec === 'object' ? Object.assign(rec, { used: now }) : rec;
}

// When a record was last used or, for records from before `used`, saved (ms, or 0).
function cacheLastUse(rec) {
  if (!rec || typeof rec !== 'object') return 0;
  for (const k of ['used', 'savedAt', 'at']) if (typeof rec[k] === 'number' && isFinite(rec[k])) return rec[k];
  return 0;
}

// Marks a record as used now (keeps it from being pruned).
function cacheTouch(key) {
  idbCache.update(key, (rec) => cacheTouched(rec, Date.now())).catch(() => {});
}

// Rough size of a stored value in bytes (Blobs by their size, the rest as JSON).
function approxSize(v) {
  if (v instanceof Blob) return v.size;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (Array.isArray(v)) return v.reduce((s, x) => s + approxSize(x), 0) + 2;
  if (v && typeof v === 'object') {
    let s = 2;
    for (const [k, x] of Object.entries(v)) s += k.length + 3 + approxSize(x);
    return s;
  }
  return String(v).length + 1;
}

const analysisCaches = {
  async keys() {
    return (await idbCache.keys()).filter((k) => cacheKind(k));
  },

  // { count, bytes } of all analysis caches.
  async usage() {
    let bytes = 0;
    const keys = await this.keys();
    for (const k of keys) bytes += approxSize(await idbCache.get(k));
    return { count: keys.length, bytes };
  },

  async clear() {
    const keys = await this.keys();
    for (const k of keys) await idbCache.del(k);
    return keys.length;
  },

  // Deletes records unused for CACHE_KEEP_DAYS or from another algorithm version.
  async prune() {
    const old = Date.now() - CACHE_KEEP_DAYS * 864e5;
    let n = 0;
    for (const k of await this.keys()) {
      const rec = await idbCache.get(k);
      if (!cacheValid(cacheKind(k), rec) || !(cacheLastUse(rec) > old)) { await idbCache.del(k); n++; }
    }
    if (n) log.info('removed ' + n + ' old analysis results');
    return n;
  },
};

const userData = {
  // Deletes slide PDFs, watched records and saved positions unused for USER_DATA_KEEP_DAYS.
  // A recording's PDFs from before `used` was kept start counting now.
  async prune(now = Date.now()) {
    const old = now - USER_DATA_KEEP_DAYS * 864e5;
    let n = 0;
    for (const k of await idbCache.keys()) {
      const key = String(k);
      if (key.startsWith('watched:')) {
        const rec = await idbCache.get(key);
        if (rec && typeof rec.at === 'number' && rec.at < old) { await idbCache.del(key); n++; }
      } else if (key.startsWith('deck:')) {
        const rec = await idbCache.get(key);
        if (!rec || !Array.isArray(rec.files)) continue;
        if (typeof rec.used !== 'number') {
          await idbCache.update(key, (r) => (r && typeof r === 'object' && typeof r.used !== 'number' ? Object.assign(r, { used: now }) : r));
          continue;
        }
        if (rec.used >= old) continue;
        const mid = key.slice(5);
        const hashes = rec.files.map((f) => f && f.hash).filter((h) => typeof h === 'string');
        // As removing a file (68-slide-deck.js): its users in the same transaction, and
        // nothing if the recording was opened meanwhile.
        await idbCache.updateMany([key].concat(hashes.map((h) => 'deckref:' + h)), (cur) => {
          const r = cur[key];
          if (!r || typeof r.used !== 'number' || r.used >= old) return {};
          const next = { [key]: undefined };
          for (const h of hashes) {
            const refs = (Array.isArray(cur['deckref:' + h]) ? cur['deckref:' + h] : []).filter((m) => m !== mid);
            if (refs.length) next['deckref:' + h] = refs;
            else { next['deckref:' + h] = undefined; next['deckfile:' + h] = undefined; }
          }
          return next;
        });
        n++;
      }
    }
    for (const name of platform.kv.names()) {
      if (!name.startsWith(NS + 'pos:')) continue;
      const pos = sanitizePos(store.get(name.slice(NS.length), null));
      if (pos && pos.at > 0 && pos.at < old) { platform.kv.remove(name); n++; }
    }
    if (n) log.info('removed ' + n + ' records unused for a year');
    return n;
  },
};
