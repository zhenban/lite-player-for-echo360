// ===================================================================================
// Export and backup.
//
// Export: a recording's notes and bookmarks (with their local tags) as Markdown, each with
// a link back to that moment (the lesson page with #t=<seconds>, which this player
// honours). With a slide PDF, the page on screen at each note can go along as a picture;
// the Markdown and the pictures are packed in a zip (for Obsidian and similar). A whole
// course exports one Markdown file per recording (without pictures). Exports never contain
// the video or its address.
//
// Backup: everything that only exists in this browser (tags and which items carry them,
// slide files and their corrections, what was watched, settings and positions), optionally
// with the PDF files, in one JSON file that can be restored in another browser. Analysis
// caches (slides, silence, text on screen) are left out: they are rebuilt.
// ===================================================================================

// ---- zip (stored, no compression: the pictures are PNG already) ----

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Uint8Array }] -> Blob (application/zip). Names are UTF-8.
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);          // UTF-8 names
    head.setUint16(8, 0, true);               // stored
    head.setUint16(10, dosTime, true);
    head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, f.data.length, true);
    head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true);
    parts.push(head.buffer, name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((s, x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---- Markdown ----

function safeName(s) {
  return String(s || 'lecture').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'lecture';
}

// A file name not used yet in the archive, then counted as used: "x.md", "x (2).md", …
// Compared without case (Windows and macOS see "Lecture.md" and "lecture.md" as one file).
function uniqueName(name, taken) {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > name.lastIndexOf('/') ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let out = name;
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = stem + ' (' + n + ')' + ext;
  taken.add(out.toLowerCase());
  return out;
}

// A tag as a Markdown / Obsidian tag: no spaces or punctuation.
function mdTag(name) {
  const s = String(name).trim().replace(/[\s,.;:!?'"()[\]{}#]+/g, '-').replace(/^-+|-+$/g, '');
  return s ? '#' + s : '';
}

function mdEscape(s) {
  return String(s || '').replace(/\r/g, '').replace(/\n/g, '  \n  ');
}

// lec: { title, date (YYYY-MM-DD or ''), url (lesson page), items: [note/bookmark],
// tagsOf(id) -> [{ name }], picture(item) -> relative path or null }
function lectureMarkdown(lec) {
  const long = lec.items.some((x) => x.time >= 3600);
  const lines = ['# ' + lec.title, ''];
  const meta = [lec.date ? tr('mdRecorded', { date: lec.date }) : null, lec.url ? '[' + tr('mdOpen') + '](' + lec.url + ')' : null].filter(Boolean);
  if (meta.length) lines.push(meta.join(' · '), '');
  const items = lec.items.filter((x) => x.type === 'note' || x.type === 'bookmark');
  if (!items.length) lines.push('_' + tr('mdNothing') + '_');
  for (const x of items) {
    const when = x.time != null ? '[' + fmtTime(x.time, long) + '](' + lec.url + '#t=' + Math.floor(x.time) + ')' : tr('mdNoTime');
    const tags = lec.tagsOf(x.id).map((g) => mdTag(g.name)).filter(Boolean).join(' ');
    const body = x.type === 'note' ? mdEscape(x.text) : '🔖 ' + tr('markerBookmark');
    lines.push('- **' + when + '** ' + body + (tags ? ' ' + tags : ''));
    const pic = lec.picture ? lec.picture(x) : null;
    if (pic) lines.push('  ', '  ![](' + encodeURI(pic).replace(/\(/g, '%28').replace(/\)/g, '%29') + ')');
  }
  lines.push('', '_' + tr('mdFooter', { date: new Date().toISOString().slice(0, 10) }) + '_', '');
  return lines.join('\n');
}

// Date of a lesson from its id (G_..._2026-09-15T16:05:00.000_...), '' if none.
function lessonDate(lessonId) {
  const m = /_(\d{4}-\d{2}-\d{2})T/.exec(String(lessonId || ''));
  return m ? m[1] : '';
}

function lessonPageUrl(lessonId) {
  return location.origin + '/lesson/' + seg(lessonId) + '/classroom';
}

class Exporter {
  constructor(player) {
    this.p = player;
  }

  // This recording; with `pictures`, the slide page at each note (needs a slide PDF).
  async lecture(pictures) {
    const p = this.p;
    const l = p.lesson;
    const items = p.notes ? p.notes.items.filter((x) => x.type !== 'flag') : [];
    const base = (lessonDate(l.lessonId) ? lessonDate(l.lessonId) + ' ' : '') + safeName(l.title);
    const files = [];
    const taken = new Set([(base + '.md').toLowerCase()]);
    const pics = new Map();   // page index -> file name
    let picture = null;
    const deck = p.deck;
    if (pictures && deck && deck.pages.length) {
      for (const x of items) {
        if (x.time == null) continue;
        const i = deck.pageAt(x.time);
        if (i < 0 || pics.has(i)) continue;
        const pg = deck.pages[i];
        // Two PDFs with one name: their pictures still get a name each.
        const name = uniqueName(base + '/' + safeName(pg.file.replace(/\.pdf$/i, '')) + ' p' + pg.num + '.png', taken);
        const c = await deck.render(i, 1600, true);
        const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
        files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
        pics.set(i, name);
      }
      picture = (x) => (x.time == null ? null : pics.get(deck.pageAt(x.time)) || null);
    }
    const md = lectureMarkdown({
      title: l.title, date: lessonDate(l.lessonId), url: lessonPageUrl(l.lessonId), items,
      tagsOf: (id) => (p.tags ? p.tags.of(id) : []), picture,
    });
    const mdBytes = new TextEncoder().encode(md);
    if (!files.length) { platform.save(new Blob([mdBytes], { type: 'text/markdown' }), base + '.md'); return { notes: items.length, pictures: 0 }; }
    files.unshift({ name: base + '.md', data: mdBytes });
    platform.save(makeZip(files), base + '.zip');
    return { notes: items.length, pictures: files.length - 1 };
  }

  // Every recording of the course with notes or bookmarks, one Markdown file each. Returns
  // { files, failed }: recordings exported, and recordings whose notes could not be read
  // (listed in a file of the archive); throws when none could be read.
  async course(onProgress) {
    const p = this.p;
    const section = p.lesson.sectionId;
    if (!section) throw new Error('no course');
    const list = (await fetchSyllabus(section)).map((x) => x.lesson).filter((x) => x && x.lesson && x.hasVideo);
    const files = [];
    const taken = new Set();
    const failed = [];
    const tagStore = new TagStore({ sectionId: section, mediaId: null });
    await tagStore.load();
    for (let k = 0; k < list.length; k++) {
      const x = list[k];
      if (onProgress) onProgress(k, list.length);
      const lid = x.lesson.id;
      const mid = x.medias && x.medias[0] && x.medias[0].id;
      const title = x.lesson.name || (x.medias && x.medias[0] && x.medias[0].title) || lid;
      let items = [];
      // Not read (signed out, no connection): not the same as no notes.
      try { items = await new Echo360Api({ lessonId: lid, mediaId: mid }).notes(); } catch (e) { failed.push({ title, lid }); continue; }
      if (!items.length) continue;
      const map = mid ? (await idbCache.get('tagmap:' + mid)) || {} : {};
      const tagsOf = (id) => tagStore.tags.filter((g) => (map[id] || []).includes(g.id));
      items.sort((a, b) => (a.time == null ? -1 : a.time) - (b.time == null ? -1 : b.time));
      const md = lectureMarkdown({ title, date: lessonDate(lid), url: lessonPageUrl(lid), items, tagsOf });
      // Same names (two recordings on one day with one title): numbered.
      files.push({ name: uniqueName((lessonDate(lid) ? lessonDate(lid) + ' ' : '') + safeName(title) + '.md', taken), data: new TextEncoder().encode(md) });
    }
    if (failed.length && !files.length) throw new Error(tr('exportCourseUnread', { n: failed.length }));
    if (!files.length) return { files: 0, failed: 0 };
    const exported = files.length;
    if (failed.length) {
      const missing = failed.map((f) => '- [' + f.title.replace(/[[\]]/g, '') + '](' + lessonPageUrl(f.lid) + ')' + (lessonDate(f.lid) ? ' ' + lessonDate(f.lid) : '')).join('\n');
      const name = uniqueName(tr('exportNotReadFile') + '.md', taken);
      files.unshift({ name, data: new TextEncoder().encode('# ' + tr('exportNotReadFile') + '\n\n' + tr('exportNotReadText') + '\n\n' + missing + '\n') });
    }
    platform.save(makeZip(files), safeName(p.lesson.courseName || 'course') + ' notes.zip');
    return { files: exported, failed: failed.length };
  }
}

// ---- backup ----

const BACKUP_KEYS = /^(tags|tagmap|deck|deckref|watched|screenpick):/;

// Each restored IndexedDB entry, rebuilt from its known fields within BACKUP_MAX_* (02-tuning),
// or null: skipped. A backup may come from someone else, so a damaged or crafted one can
// neither plant data that breaks a later visit nor freeze one with its size.
const isStr = (x) => typeof x === 'string' && x.length < 2000;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const isHash = (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const listOf = (v, max, each) => Array.isArray(v) && v.length <= max && v.every(each);
const BACKUP_DB_CLEAN = {
  // Tags keep a plain colour (review R1).
  tags: (v) => (v && listOf(v.tags, BACKUP_MAX_TAGS, (g) => g && isStr(g.id) && isStr(g.name) && isStr(g.color))
    ? { tags: v.tags.map((g) => ({ id: g.id, name: g.name, color: plainColor(g.color, TAG_FALLBACK_COLOR) })) } : null),
  tagmap: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const items = Object.keys(v).filter((k) => k !== '__proto__');
    if (items.length > BACKUP_MAX_TAGGED || !items.every((k) => listOf(v[k], BACKUP_MAX_TAGS_EACH, isStr))) return null;
    const out = {};
    for (const k of items) out[k] = v[k].slice();
    return out;
  },
  deck: (v) => (v && listOf(v.files, BACKUP_MAX_FILES, (f) => f && isHash(f.hash) && isStr(f.name))
    && (v.fixes == null || listOf(v.fixes, BACKUP_MAX_FIXES, (x) => x && isNum(x.a) && isNum(x.b) && isStr(String(x.page))))
    ? { files: v.files.map((f) => ({ hash: f.hash, name: f.name })), fixes: (v.fixes || []).map((x) => ({ a: x.a, b: x.b, page: String(x.page) })) } : null),
  deckref: (v) => (listOf(v, BACKUP_MAX_USERS, isStr) ? v.slice() : null),
  watched: (v) => {
    if (!v || !isNum(v.d) || !(v.d > 0) || !listOf(v.r, BACKUP_MAX_RANGES, (x) => Array.isArray(x) && x.length === 2 && isNum(x[0]) && isNum(x[1]) && x[0] >= 0 && x[0] < x[1])) return null;
    if (v.e != null && !isNum(v.e)) return null;
    const out = { d: v.d, r: v.r.map(([a, b]) => [a, b]) };
    if (isNum(v.at)) out.at = v.at;
    if (v.e != null) out.e = v.e;
    return out;
  },
  screenpick: (v) => (v && Number.isInteger(v.index) && v.index >= 0 && v.index < 100 ? { index: v.index } : null),
};
// Kept with what this browser has (another recording's use of a PDF, a course's other
// tags): replacing them would let a later removal delete a PDF still in use, or drop tags
// that notes still carry.
const BACKUP_MERGE = {
  tags: (mine, theirs) => ({ tags: theirs.tags.concat(((mine && BACKUP_DB_CLEAN.tags(mine)) || { tags: [] }).tags.filter((g) => !theirs.tags.some((x) => x.id === g.id))) }),
  deckref: (mine, theirs) => theirs.concat((Array.isArray(mine) ? mine : []).filter((m) => !theirs.includes(m))),
};

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function makeBackup(withPdfs) {
  const out = { app: 'lite-player-for-echo360', v: 1, created: new Date().toISOString(), local: {}, db: {} };
  for (const k of platform.kv.names()) {
    const key = k.startsWith(NS) ? k.slice(NS.length) : null;
    if (key && BACKUP_LOCAL.some((x) => x.match(key))) out.local[key] = platform.kv.get(k);
  }
  for (const k of await idbCache.keys()) {
    const key = String(k);
    const pdf = key.startsWith('deckfile:');
    if (!BACKUP_KEYS.test(key) && !(pdf && withPdfs)) continue;
    const v = await idbCache.get(key);
    out.db[key] = v instanceof Blob ? { $blob: await blobToBase64(v), type: v.type } : v;
  }
  return out;
}

// Restores a backup: its entries replace the ones with the same keys (tags and the users of
// a PDF are merged, BACKUP_MERGE). Everything is checked first; the IndexedDB entries are
// then written in one transaction (all or none), and only then the settings. Returns the
// number of entries written. Whether usage data is sent is never taken from a file: it
// stays as this browser has it.
async function restoreBackup(data, db = idbCache) {
  if (!data || data.app !== 'lite-player-for-echo360' || data.v !== 1 || !data.db || typeof data.db !== 'object') throw new Error(tr('backupInvalid'));
  if (Object.keys(data.db).length > BACKUP_MAX_ENTRIES) throw new Error(tr('backupInvalid'));
  // Settings and positions: only known keys, each validated like the player does (a
  // damaged value becomes the default instead of breaking every later visit).
  const local = [];
  let positions = 0;
  for (const [k, v] of Object.entries(data.local && typeof data.local === 'object' ? data.local : {})) {
    const rule = BACKUP_LOCAL.find((x) => x.match(k));
    if (!rule) continue;
    if (k.startsWith('pos:') && ++positions > BACKUP_MAX_POSITIONS) continue;
    let parsed = null;
    try { parsed = JSON.parse(v); } catch (e) { parsed = null; }
    const clean = rule.clean(parsed);
    if (clean == null) continue;
    if (k === 'prefs') clean.telemetry = sanitizePrefs(store.get('prefs', null)).telemetry;
    local.push([k, clean]);
  }
  const entries = [];
  for (const [k, v] of Object.entries(data.db)) {
    if (k.startsWith('deckfile:')) {
      // A PDF is kept under the hash of its bytes: checked, so a file cannot stand in for
      // another (or replace a good copy of it).
      if (!v || typeof v !== 'object' || typeof v.$blob !== 'string' || !isHash(k.slice(9))) continue;
      let bytes;
      try {
        const bin = atob(v.$blob);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch (e) { continue; }
      if ((await sha256Hex(bytes)) !== k.slice(9)) continue;
      entries.push([k, new Blob([bytes], { type: 'application/pdf' })]);
      continue;
    }
    if (!BACKUP_KEYS.test(k)) continue;
    const clean = BACKUP_DB_CLEAN[k.split(':')[0]];
    const val = clean ? clean(v) : null;
    if (val != null) entries.push([k, val]);
  }
  const merged = entries.filter(([k]) => BACKUP_MERGE[k.split(':')[0]]).map(([k]) => k);
  await db.updateMany(merged, (old) => {
    const next = {};
    for (const [k, val] of entries) {
      const merge = BACKUP_MERGE[k.split(':')[0]];
      next[k] = merge ? merge(old[k], val) : val;
    }
    return next;
  });
  let n = entries.length;
  for (const [k, clean] of local) {
    try { platform.kv.set(NS + k, JSON.stringify(clean)); n++; } catch (e) { /* storage full */ }
  }
  return n;
}
