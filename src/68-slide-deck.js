// ===================================================================================
// The lecturer's slide files (PDF) for a recording: loading, local storage, following the
// lecture, and the user's corrections.
//
// The PDF is the user's: they can page through it freely and remove it at any time.
// Following the lecture only turns the page for them until they take over.
//
// Which page is on screen comes from the text on the screen view, every CHAPTER_STEP_SEC
// across the lecture: 66-slide-ocr.js reads it, 67-slide-text.js decides the pages (in a Worker).
//
// Files never leave the browser: they are kept in IndexedDB (by SHA-256), remembered per
// recording. pdf.js is loaded from jsDelivr (pinned) only when a recording has slide files.
//
// Stored records:
//   deck:<mediaId>        { files: [{ hash, name }], fixes: [{ a, b, page: <page key> | 'none' }] }
//   deckfile:<hash>       Blob of the PDF
//   deckref:<hash>        [mediaId] recordings using the file (deleted with the last one)
// A correction covers a part of the lecture (a to b, in seconds); a page key is
// "<hash prefix>:<page>", so it survives reordering files.
//
// For later features (slide text as vocabulary for transcription, chapter titles):
// controller.pages[i] = { key, file, num, title, text }.
// ===================================================================================

const PDFJS_DIR = 'pdfjs-dist@6.4.299/build/';

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = platform.importLib(PDFJS_DIR + 'pdf.min.mjs');
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

// pdf.js's worker for one controller: a module worker from the checked worker script (a
// worker URL from another origin cannot be used directly). Ended by its owner.
function pdfWorkerUrl() {
  return platform.libBlobUrl(PDFJS_DIR + 'pdf.worker.min.mjs');
}
function makePdfWorker(lib, url) {
  const port = new Worker(url, { type: 'module' });
  return { port, pdf: new lib.PDFWorker({ port }) };
}

// The page's title: the largest text in the top PAGE_TITLE_TOP of the page.
function pageTitle(items, pageHeight) {
  let size = 0;
  for (const it of items) if (it.str.trim() && it.transform[5] > pageHeight * (1 - PAGE_TITLE_TOP)) size = Math.max(size, it.height);
  if (!size) return '';
  return items.filter((it) => it.str.trim() && it.transform[5] > pageHeight * (1 - PAGE_TITLE_TOP) && Math.abs(it.height - size) < 1)
    .map((it) => it.str.trim()).join(' ').slice(0, 1000).replace(/\s+/g, ' ').slice(0, 120);
}

// A page's key is this prefix (its file) and the page number.
function pageKeyPrefix(fileHash) {
  return fileHash.slice(0, 12) + ':';
}
function pageKeyFile(key) {
  return key.slice(0, key.indexOf(':') + 1);
}

// Page drawn `width` pixels wide, or smaller when that would pass the size limits for one
// page (the picture is shown scaled to its place either way).
function renderPdfPage(page, width) {
  const base = page.getViewport({ scale: 1 });
  const bw = base.width;
  const bh = base.height;
  if (!(bw > 0 && bh > 0 && Number.isFinite(bw) && Number.isFinite(bh))) throw new Error('bad page size');
  const scale = Math.min(width / bw, PAGE_RENDER_MAX_SIDE / bw, PAGE_RENDER_MAX_SIDE / bh, Math.sqrt(PAGE_RENDER_MAX_PX / (bw * bh)));
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(bw * scale));
  c.height = Math.max(1, Math.floor(bh * scale));
  const t0 = performance.now();
  return page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise.then(() => {
    usageNote('work', 'pdfMpx', (performance.now() - t0) / (c.width * c.height / 1e6));
    return c;
  });
}

// The page to show at each sample while following. pages[i]: from followLecture (a page,
// -1 not a slide, -2 not read yet); times[i]: when sample i starts; end: when the last one
// ends. Where no page is on screen the page shown before stays. A quick look at another
// page (a stretch shorter than minSec between two stretches of the same page) does not
// turn the page. Before the first page, that page is shown. Returns page indexes (-1 only
// when no page is known at all).
function followSamples(times, pages, minSec, end) {
  const min = minSec == null ? FOLLOW_MIN_SEC : minSec;
  const n = pages.length;
  // Without an end, the last sample lasts as long as the one before it.
  const tEnd = end == null ? (n ? times[n - 1] + (n > 1 ? times[n - 1] - times[n - 2] : 0) : 0) : end;
  // Stretches of one page: [{ p, a, b }] (samples a..b), ended by anything else.
  const runs = [];
  for (let i = 0; i < n; i++) {
    const p = pages[i];
    if (p < 0) continue;
    const last = runs[runs.length - 1];
    if (last && last.p === p && last.b === i - 1) last.b = i; else runs.push({ p, a: i, b: i });
  }
  const keep = runs.filter((r, k) => {
    const len = (r.b + 1 < n ? times[r.b + 1] : tEnd) - times[r.a];
    return !(len < min && k > 0 && k + 1 < runs.length && runs[k - 1].p === runs[k + 1].p && runs[k - 1].p !== r.p);
  });
  const out = new Int32Array(n);
  let k = 0;
  let cur = keep.length ? keep[0].p : -1;
  for (let i = 0; i < n; i++) {
    while (k < keep.length && keep[k].a <= i) { cur = keep[k].p; k++; }
    out[i] = cur;
  }
  return out;
}

class SlideDeckController {
  // opts: { lesson, video, slides (SlideAnalyzer: which view is the screen), disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.slides = opts.slides;
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('slide reader (display)', e); } };
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.files = [];          // [{ hash, name }]
    this.docs = [];           // pdf.js loading tasks of the open documents, per file
    /** @type {DeckPage[]} */
    this.pages = [];
    this.capped = false;      // more pages than DECK_MAX_PAGES: the rest are not read
    this.fixes = [];          // the user's corrections [{ a, b, page }]
    this.ocr = null;          // SlideTextReader
    this.worker = new SlideTextWorker(this.d);
    this.decided = null;      // per sample: page, -1 not a slide, -2 not read (followLecture)
    this.shown = null;        // per sample: page to show while following
    this.decidedAt = 0;
    this.deciding = null;
    this.state = 'empty';     // empty | loading | reading | ready | error
    this.corrections = 0;     // pages corrected by hand in this visit (usage data)
    this.error = '';
    this.notice = '';         // why the last file added or removed was not (the deck goes on)
    this.job = null;
    this.rendered = new Map(); // page key -> { c: canvas (newest size), w: width asked for }, least recently used first
    this.pdfWorker = null;     // pdf.js worker (makePdfWorker), owned here
    this.d.add(() => this.closeDocs());
  }

  get key() { return 'deck:' + this.lesson.mediaId; }

  get progress() { return this.ocr ? this.ocr.progress() : 0; }

  // Closes the open documents (through their loading tasks, which own them in pdf.js), and
  // pdf.js's worker when no document is left to use it.
  closeDocs(keepWorker) {
    for (const task of this.docs) task.destroy().catch(() => {});
    this.docs = [];
    this.rendered.clear();
    if (!keepWorker && this.pdfWorker) {
      try { this.pdfWorker.pdf.destroy(); } catch (e) { /* ignore */ }
      this.pdfWorker.port.terminate();
      this.pdfWorker = null;
    }
  }

  async restore() {
    if (!this.lesson.mediaId) return;
    const rec = await idbCache.get(this.key);
    if (!rec || !Array.isArray(rec.files) || !rec.files.length) return;
    this.files = rec.files;
    this.fixes = Array.isArray(rec.fixes) ? rec.fixes : [];
    await this.reload();
  }

  // op({ files, fixes }) changes the record in place: applied here now, then to the stored
  // record in one transaction. Another tab may have changed it meanwhile (added a file, made
  // a correction), so this tab's copy is never written back whole; if the stored files
  // differ afterwards, this tab takes them over. `stored(old, out, mid)`, when given, changes
  // the PDF files and their lists of users (deckfile:, deckref:) in the same transaction:
  // `old` holds the deckref: entries of `hashes`. Rejects when it could not be written.
  async changeRecord(op, hashes, stored) {
    op(this);
    const mid = this.lesson.mediaId;
    if (!mid && !stored) return;
    const keys = (mid ? [this.key] : []).concat((hashes || []).map((h) => 'deckref:' + h));
    const out = await idbCache.updateMany(keys, (old) => {
      const next = {};
      if (mid) {
        const rec = old[this.key];
        const st = { files: rec && Array.isArray(rec.files) ? rec.files : [], fixes: rec && Array.isArray(rec.fixes) ? rec.fixes : [] };
        op(st);
        next[this.key] = { files: st.files, fixes: st.fixes };
      }
      if (stored) stored(old, next, mid);
      return next;
    });
    const rec = out && mid && out[this.key];
    if (!rec || this.ac.signal.aborted) return;
    this.fixes = rec.fixes;
    if (JSON.stringify(rec.files) !== JSON.stringify(this.files)) {
      this.files = rec.files;
      this.reload();
    }
  }

  // A change of the corrections only: a failure is logged.
  changeFixes(op) {
    this.changeRecord(op).catch((e) => log.warn('slide files:', e));
  }

  // Adds PDF files (from a drop or a file picker). Returns how many were PDFs.
  async addFiles(fileList) {
    const pdfs = [...fileList].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) return 0;
    telemetry.use('pdfAdd');
    this.notice = '';
    const big = pdfs.filter((f) => f.size > DECK_MAX_FILE_BYTES);
    if (big.length) {
      this.notice = tr('deckTooBig', { name: big.map((f) => f.name).join(tr('sepList')), max: Math.round(DECK_MAX_FILE_BYTES / 1024 / 1024) });
      this.onChange();
      throw new Error(this.notice);
    }
    const added = [];
    const blobs = new Map();
    for (const f of pdfs) {
      const buf = await f.arrayBuffer();
      const hash = await sha256Hex(buf);
      if (this.files.some((x) => x.hash === hash) || added.some((x) => x.hash === hash)) continue;
      added.push({ hash, name: f.name });
      blobs.set(hash, new Blob([buf], { type: 'application/pdf' }));
    }
    // The files, their lists of users and this recording's list in one transaction: another
    // tab removing the same file from its recording cannot delete it in between. The files
    // must really be stored (a full disk would otherwise lose them silently on the next visit).
    try {
      if (added.length) {
        await this.changeRecord((st) => { for (const a of added) if (!st.files.some((x) => x.hash === a.hash)) st.files.push(a); },
          added.map((a) => a.hash), (old, next, mid) => {
            for (const a of added) {
              const refs = old['deckref:' + a.hash];
              next['deckfile:' + a.hash] = blobs.get(a.hash);
              next['deckref:' + a.hash] = Array.isArray(refs) ? (refs.includes(mid) ? refs : refs.concat(mid)) : [mid];
            }
          });
      }
    } catch (e) {
      this.files = this.files.filter((x) => !added.some((a) => a.hash === x.hash));
      this.notice = tr('deckSaveFailed', { name: added.map((a) => a.name).join(tr('sepList')), msg: (e && e.message) || e });
      this.onChange();
      throw new Error(this.notice);
    }
    await this.reload();
    return pdfs.length;
  }

  // The file itself is deleted when no other recording uses it, in the same transaction as
  // this recording's list (no other tab can add itself in between).
  // When that cannot be saved, the file stays (it would be back on the next visit).
  async removeFile(hash) {
    const prefix = pageKeyPrefix(hash);
    const before = { files: this.files, fixes: this.fixes };
    const file = this.files.find((f) => f.hash === hash);
    this.notice = '';
    try {
      await this.changeRecord((st) => {
        st.files = st.files.filter((f) => f.hash !== hash);
        st.fixes = st.fixes.filter((x) => !String(x.page).startsWith(prefix));
      }, [hash], (old, next, mid) => {
        const refs = (Array.isArray(old['deckref:' + hash]) ? old['deckref:' + hash] : []).filter((m) => m !== mid);
        if (refs.length) next['deckref:' + hash] = refs;
        else { next['deckref:' + hash] = undefined; next['deckfile:' + hash] = undefined; }
      });
    } catch (e) {
      log.warn('slide file removal:', e);
      if (this.ac.signal.aborted) return;
      this.files = before.files;
      this.fixes = before.fixes;
      this.notice = tr('deckRemoveFailed', { name: file ? file.name : '', msg: (e && e.message) || e });
      this.onChange();
      return;
    }
    await this.reload();
  }

  // Opens all files and reads the pages' titles and text, then follows the lecture.
  async reload() {
    const job = {};
    this.job = job;
    this.again = false; // a pending recompute was for the old files
    this.closeDocs(this.files.length > 0);
    this.pages = [];
    this.capped = false;
    this.decided = null;
    this.shown = null;
    if (!this.files.length) {
      this.stopReading();
      this.state = 'empty';
      this.onChange();
      return;
    }
    this.state = 'loading';
    this.onChange();
    try {
      // Replaced by a newer load, or the player is gone: checked after every wait, before
      // anything is made (a Worker made after closing would never be ended).
      const gone = () => this.job !== job || this.ac.signal.aborted;
      const lib = await loadPdfJs();
      if (gone()) return;
      const workerUrl = await pdfWorkerUrl();
      if (gone()) return;
      const pages = [];
      let capped = false;
      for (const f of this.files) {
        const blob = await idbCache.get('deckfile:' + f.hash);
        if (gone()) return;
        if (!blob) continue;
        const data = new Uint8Array(await blob.arrayBuffer());
        if (gone()) return;
        if (!this.pdfWorker) this.pdfWorker = makePdfWorker(lib, workerUrl);
        const task = lib.getDocument({ data, worker: this.pdfWorker.pdf });
        const doc = await task.promise;
        if (gone()) { task.destroy().catch(() => {}); return; }
        this.docs.push(task);
        for (let n = 1; n <= doc.numPages; n++) {
          if (pages.length >= DECK_MAX_PAGES) { capped = true; break; }
          const page = await doc.getPage(n);
          const tc = await page.getTextContent();
          const [x0, y0, x1, y1] = page.view;
          pages.push({
            key: pageKeyPrefix(f.hash) + n, file: f.name, num: n, doc, ar: (y1 - y0) / (x1 - x0),
            title: pageTitle(tc.items, y1 - y0),
            text: tc.items.map((x) => x.str).join(' ').slice(0, DECK_MAX_PAGE_CHARS * 2).replace(/\s+/g, ' ').trim().slice(0, DECK_MAX_PAGE_CHARS),
          });
        }
      }
      if (this.job !== job) return;
      this.pages = pages;
      this.capped = capped;
      this.state = 'reading';
      // Files in another language need the screen read again in that language.
      if (this.ocr && this.ocr.lang !== ocrLanguage(pages.map((x) => x.text))) this.stopReading();
      this.startReading();
      // A reader that has finished already (files added or removed after the screen was
      // read) has no change to come: its state is taken now.
      if (this.followReader()) this.decide(true);
      this.onChange();
    } catch (e) {
      if (this.ac.signal.aborted || this.job !== job) return;
      log.warn('slide file:', e && e.message ? e.message : e);
      this.state = 'error';
      this.error = tr('deckError', { msg: String((e && e.message) || e) });
      this.onChange();
    }
  }

  // Starts reading the screen once it is known which view that is (from the slide
  // analysis; a recording with one view uses that one).
  startReading() {
    if (this.ocr || !this.pages.length) return;
    const sources = this.lesson.sources;
    // The screen view; if the analysis could not tell clearly, its best guess.
    const a = this.slides;
    const idx = a && a.screenIndex != null ? a.screenIndex : a && a.guessScreen != null ? a.guessScreen : sources.length === 1 ? sources[0].index : null;
    if (idx == null) return;
    const source = sources.find((s) => s.index === idx);
    if (!source) return;
    // Owned by its own child of the controller: stopping it (files removed) releases it
    // and its texts, instead of keeping it referenced until the page closes.
    this.ocrD = this.d.child();
    this.ocr = new SlideTextReader({
      lesson: this.lesson, video: this.video, source, disposer: this.ocrD, shared: a || null,
      lang: ocrLanguage(this.pages.map((x) => x.text)),
      onChange: () => this.readingChanged(),
    });
    this.ocr.start();
  }

  stopReading() {
    if (this.ocrD) this.ocrD.dispose();
    this.ocrD = null;
    this.ocr = null;
  }

  // Called when the slide analysis changes (the screen view becomes known, or the user
  // chose another view: reading starts again there).
  screenKnown() {
    const a = this.slides;
    if (this.ocr && a && a.screenIndex != null && this.ocr.source.index !== a.screenIndex) this.stopReading();
    if (this.pages.length && !this.ocr) { this.startReading(); this.onChange(); }
  }

  readingChanged() {
    if (!this.ocr) return;
    if (this.followReader()) this.decide(this.ocr.state === 'done');
    this.onChange();
  }

  // The deck's state from the reader's: an error if it cannot work (false), ready once it
  // is done.
  followReader() {
    const r = this.ocr;
    if (r && r.state === 'unavailable') { this.state = 'error'; this.error = r.error; return false; }
    if (r && r.state === 'done' && this.state === 'reading') this.state = 'ready';
    return true;
  }

  // Decides the pages again from everything read so far (at most every FOLLOW_UPDATE_MS
  // while reading, unless `now`).
  decide(now) {
    const r = this.ocr;
    if (!r || !r.at || !this.pages.length) return;
    if (this.deciding) { this.again = this.again || now; return; }
    if (!now && performance.now() - this.decidedAt < FOLLOW_UPDATE_MS) return;
    this.decidedAt = performance.now();
    const fileOf = this.pages.map((p) => this.files.findIndex((f) => p.key.startsWith(pageKeyPrefix(f.hash))));
    const input = {
      pageTexts: this.pages.map((p) => p.text),
      fileOf,
      texts: r.texts,
      at: Array.from(r.at),
      force: this.forces(r.times),
      scripts: r.scripts,
    };
    const job = this.job;
    this.deciding = this.worker.run(input).then((res) => {
      if (this.job !== job) return;
      this.decided = res.pages;
      this.recompute();
      if (store.get('debug', false)) this.lastModel = res.model;
      this.onChange();
    }).catch((e) => {
      if (!this.ac.signal.aborted) log.warn('slide following:', e && e.message ? e.message : e);
    }).finally(() => {
      this.deciding = null;
      if (this.again && !this.ac.signal.aborted) { this.again = false; this.decide(true); }
    });
  }

  // The corrections as a value per sample (page index, FORCE_OFF or -1).
  forces(times) {
    const out = new Array(times.length).fill(-1);
    for (const x of this.fixes) {
      const v = x.page === 'none' ? FORCE_OFF : this.indexOfKey(x.page);
      if (v === -1) continue;
      for (let i = 0; i < times.length; i++) if (times[i] >= x.a - 0.5 && times[i] < x.b - 0.5) out[i] = v;
    }
    return out;
  }

  recompute() {
    const r = this.ocr;
    this.shown = r && this.decided ? followSamples(r.times, this.decided, FOLLOW_MIN_SEC, this.lesson.duration || r.end || undefined) : null;
  }

  // Page i rendered `width` pixels wide. Kept for reuse within a pixel budget (pages can
  // be 4096 pixels wide when zoomed in): only the newest size of each page, and the least
  // recently used pages go first.
  // Kept by the page's key (file and page number), not its index: an index means another
  // page once the files change, and a render still running for a removed file must not be
  // kept for whatever page has its index now.
  // once: a one-off size (a copy): drawn but not kept, so the page on screen stays cached.
  async render(i, width, once) {
    const w = Math.round(width);
    const pg = this.pages[i];
    if (!pg) throw new Error('no page ' + i);
    const hit = this.rendered.get(pg.key);
    // By the width asked for: a page drawn smaller (renderPdfPage) is still the one asked for.
    if (hit && hit.w === w) {
      this.rendered.delete(pg.key);
      this.rendered.set(pg.key, hit);
      return hit.c;
    }
    const page = await pg.doc.getPage(pg.num);
    const c = await renderPdfPage(page, width);
    // The files changed meanwhile: the picture is not kept (the caller checks whether it
    // still wants it).
    if (once || !this.pages.includes(pg)) return c;
    this.rendered.delete(pg.key);
    this.rendered.set(pg.key, { c, w });
    let px = 0;
    for (const { c: x } of this.rendered.values()) px += x.width * x.height;
    for (const [k, { c: x }] of this.rendered) {
      if (px <= DECK_RENDER_BUDGET || k === pg.key) break;
      px -= x.width * x.height;
      x.width = 0; // releases the canvas memory now
      this.rendered.delete(k);
    }
    return c;
  }

  indexOfKey(k) {
    return k ? this.pages.findIndex((p) => p.key === k) : -1;
  }

  // Index of the sample playing at time t (-1 before reading has started).
  sampleAt(t) {
    const r = this.ocr;
    if (!r || !r.times.length) return -1;
    return Math.max(0, sampleIndexAt(r.times, t));
  }

  // Page to show at time t while following (-1 when nothing is known yet). Samples are
  // CHAPTER_STEP_SEC apart; when the page changes between two of them and the slide analysis found
  // the change in between (to about a second), the page turns there.
  pageAt(t) {
    const k = this.sampleAt(t);
    if (!this.shown || k < 0) return -1;
    const times = this.ocr.times;
    if (k + 1 < this.shown.length && this.shown[k + 1] !== this.shown[k]) {
      const chs = this.slides ? this.slides.chapters : [];
      const c = chapterIndexAt(chs, times[k + 1] - 0.01);
      if (c > 0 && chs[c].precise && chs[c].start > times[k] && t >= chs[c].start) return this.shown[k + 1];
    }
    return this.shown[k];
  }

  // Whether the page at time t was recognised for that very part, rather than carried
  // over from an earlier part.
  knownAt(t) {
    const k = this.sampleAt(t);
    return !!this.decided && k >= 0 && this.decided[k] >= 0;
  }

  // Seconds since a page was last recognised at time t (0 while recognised, Infinity if
  // never). Following stops claiming a page after FOLLOW_STALE_SEC.
  unrecognisedFor(t) {
    const k = this.sampleAt(t);
    if (!this.decided || k < 0) return Infinity;
    if (this.decided[k] >= 0) return 0;
    const times = this.ocr.times;
    for (let j = k - 1; j >= 0; j--) if (this.decided[j] >= 0) return Math.max(0, t - times[j + 1]);
    return Infinity;
  }

  // When page i was on screen: [{ start, end }].
  timesOf(i) {
    const out = [];
    if (!this.decided) return out;
    const times = this.ocr.times;
    const end = (j) => (j + 1 < times.length ? times[j + 1] : this.lesson.duration || this.ocr.end);
    for (let j = 0; j < this.decided.length; j++) {
      if (this.decided[j] !== i) continue;
      const last = out[out.length - 1];
      if (last && last.endSample === j - 1) { last.end = end(j); last.endSample = j; } else out.push({ start: times[j], end: end(j), endSample: j });
    }
    return out;
  }

  // The part of the lecture around time t that shows one thing: the stretch of samples
  // with the same decision. { a, b } in seconds, or null.
  partAt(t) {
    const k = this.sampleAt(t);
    if (!this.decided || k < 0) return null;
    const times = this.ocr.times;
    const v = this.decided[k];
    let a = k;
    let b = k;
    while (a > 0 && this.decided[a - 1] === v) a--;
    while (b + 1 < this.decided.length && this.decided[b + 1] === v) b++;
    return { a: times[a], b: b + 1 < times.length ? times[b + 1] : this.lesson.duration || this.ocr.end };
  }

  // The user's correction for the part playing at time t: a page index, 'none' (not a
  // slide) or null (back to automatic).
  correct(t, value) {
    this.corrections++;
    if (value === null) {
      this.changeFixes((st) => { st.fixes = st.fixes.filter((x) => !(x.a <= t && t < x.b)); });
    } else {
      const part = this.correctionPart(t) || this.partAt(t);
      if (!part) return;
      const fix = { a: part.a, b: part.b, page: value === 'none' ? 'none' : this.pages[value].key };
      this.changeFixes((st) => { st.fixes = st.fixes.filter((x) => x.b <= part.a || x.a >= part.b).concat(fix); });
    }
    this.decide(true);
    this.onChange();
  }

  correctionPart(t) {
    return this.fixes.find((x) => x.a <= t && t < x.b) || null;
  }

  correctionAt(t) {
    const x = this.correctionPart(t);
    return x ? x.page : null;
  }
}
