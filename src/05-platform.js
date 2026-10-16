// ===================================================================================
// Platform: everything that depends on how the player is run. Today that is a userscript
// (Tampermonkey, Violentmonkey) running in the page; a browser extension built from the
// same sources will provide its own version of this object. The rest of the code uses
// only `platform` for these things (the build checks it):
//   - kv: small settings kept on this device (synchronous: settings are needed at start-up;
//     an extension reads a snapshot before it starts the player)
//   - openDb: the IndexedDB database for larger data (slide files, analyses, tags)
//   - libUrl / libBlobUrl / importLib: the libraries loaded when first needed (pdf.js,
//     Tesseract and its language data), named by their npm path ('pdfjs-dist@6.4.299/
//     build/...'). A userscript fetches them from a CDN and runs a file only after its
//     bytes match LIB_SHA256 (04-libs.js); an extension ships them (Manifest V3 does not
//     allow code from elsewhere).
//   - Hls / loadHls: hls.js, loaded when a player is about to start (a pinned file like the
//     others); a copy already on the page (development builds inject one) is used as is
//   - save: offer a file to the user
//   - manager: what runs the player, for diagnostics
//   - post: send JSON to the telemetry Worker (87-telemetry.js)
//   - privateKv: values kept out of the page's reach (the telemetry secret)
//   - page: the page's own window, for traps on the page's globals (window.Echo)
// ===================================================================================

const libBlobUrls = new Map();   // path -> Promise of a blob URL (platform.libBlobUrl)

// A response body read to the end as an ArrayBuffer, reporting the bytes so far (a failure in
// the report does not stop the download).
async function readCounting(reader, onProgress) {
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.byteLength;
    try { onProgress(n); } catch (e) { /* display only */ }
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out.buffer;
}

const platform = {
  name: 'userscript',
  // With any @grant other than none, Tampermonkey and Violentmonkey give the script a
  // wrapper as `window`: a property defined on it is not seen by the page's scripts.
  page: pageWindow(),
  kv: {
    get(name) { try { return localStorage.getItem(name); } catch (e) { return null; } },
    // Throws when storage is full or blocked; callers decide whether that matters.
    set(name, text) { localStorage.setItem(name, text); },
    names() {
      const out = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k != null) out.push(k); } } catch (e) { /* blocked */ }
      return out;
    },
  },
  openDb(name, version) {
    if (typeof indexedDB === 'undefined') return null;
    return indexedDB.open(name, version);
  },
  libUrl(path) { return 'https://cdn.jsdelivr.net/npm/' + path; },
  // A blob URL of the pinned file, made once per page from bytes that match its SHA-256
  // (a file that differs is refused). Kept for the page's life: workers are made from it
  // again, and it is a few files of 0.1 to 4 MB.
  libBlobUrl(path, prefix, suffix, onProgress) {
    const key = path + (prefix ? '\n' + prefix : '') + (suffix ? '\n' + suffix : '');
    let p = libBlobUrls.get(key);
    if (!p) {
      p = this.libBytes(path, onProgress).then((buf) => URL.createObjectURL(new Blob([prefix || '', buf, suffix || ''], { type: 'text/javascript' })));
      libBlobUrls.set(key, p);
      p.catch(() => libBlobUrls.delete(key));
    }
    return p;
  },
  // The bytes of a pinned file, refused unless they match its SHA-256. onProgress(bytes so
  // far): called as the body arrives, where the browser can stream it.
  async libBytes(path, onProgress) {
    const want = LIB_SHA256[path];
    if (!want) throw new Error('not a pinned library file: ' + path);
    const r = await fetch(this.libUrl(path), { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path);
    const buf = onProgress && r.body && r.body.getReader ? await readCounting(r.body.getReader(), onProgress) : await r.arrayBuffer();
    if (await sha256Hex(buf) !== want) throw new Error('library file changed on the CDN, not used: ' + path);
    return buf;
  },
  importLib(path) { return this.libBlobUrl(path).then((u) => import(u)); },
  Hls: typeof Hls !== 'undefined' ? Hls : window.Hls,
  hlsLoading: null,
  // Resolves to hls.js, or rejects (the file could not be had in timeoutMs, or differs).
  // hls.min.js is a UMD file: run as a module, it is given `module` and `exports` to fill
  // (so it sets no global on the page) and its export is passed on.
  // onProgress(bytes so far): see libBytes (only the call that starts the download gets it).
  loadHls(timeoutMs, onProgress) {
    if (this.Hls) return Promise.resolve(this.Hls);
    if (!this.hlsLoading) {
      this.hlsLoading = this.libBlobUrl(HLS_LIB, 'const module = { exports: {} }; const exports = module.exports;\n', '\n;export default module.exports;\n', onProgress)
        .then((u) => import(u))
        .then((m) => {
          const lib = m && m.default;
          if (!lib || typeof lib.isSupported !== 'function') throw new Error('hls.js did not load');
          this.Hls = lib;
          return lib;
        });
      this.hlsLoading.catch(() => { this.hlsLoading = null; });
    }
    let timer = 0;
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('hls.js not loaded in ' + Math.round(timeoutMs / 1000) + ' s')), timeoutMs); });
    return Promise.race([this.hlsLoading, late]).finally(() => clearTimeout(timer));
  },
  save(blob, fileName) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  },
  // POSTs a JSON text; resolves to { status, text } (status 0: no answer), never rejects.
  // keepalive: the page is closing (the request must outlive it; GM_xmlhttpRequest is made
  // by the extension and does anyway).
  // A userscript uses GM_xmlhttpRequest: no cookies are sent, and the page's content
  // security policy does not apply (it allows only the page's own servers); @connect in
  // meta.txt names the one host it may reach. Without it (a development build injected
  // into the page), fetch.
  post(url, body, timeoutMs, keepalive) {
    return new Promise((resolve) => {
      const done = (status, text) => resolve({ status, text: typeof text === 'string' ? text : '' });
      try {
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'POST', url, data: body, headers: { 'Content-Type': 'application/json' }, anonymous: true, timeout: timeoutMs,
            onload: (r) => done(r.status, r.responseText), onerror: () => done(0), ontimeout: () => done(0), onabort: () => done(0),
          });
          return;
        }
        fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: !!keepalive, signal: keepalive ? undefined : timeoutSignal(timeoutMs) })
          .then((r) => r.text().then((t) => done(r.status, t)), () => done(0));
      } catch (e) {
        done(0);
      }
    });
  },
  // Kept by the userscript manager (GM_getValue), where the page's own scripts cannot read
  // it; without one, the page's storage like the settings.
  privateKv: {
    get(name) {
      try { if (typeof GM_getValue === 'function') { const v = GM_getValue(name, null); return typeof v === 'string' ? v : null; } } catch (e) { return null; }
      try { return localStorage.getItem(NS + name); } catch (e) { return null; }
    },
    set(name, text) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(name, text); return; } } catch (e) { return; }
      try { localStorage.setItem(NS + name, text); } catch (e) { /* storage blocked: a new secret next time */ }
    },
  },
  manager() {
    try {
      if (typeof GM_info !== 'undefined' && GM_info) return (GM_info.scriptHandler || 'userscript manager') + ' ' + (GM_info.version || '');
    } catch (e) { /* not available */ }
    return 'unknown (or development)';
  },
};
