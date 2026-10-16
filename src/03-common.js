// ===================================================================================
// Small helpers shared by several parts (each used to be written out in two or more
// places): building elements, canvases, the site's hosts, Echo360 URLs, durations.
// ===================================================================================

// Pages this script runs on. Must list the same hosts as the @match lines in meta.txt
// (the build checks it): a page outside them never loads the script anyway.
const SITE_HOSTS = ['echo360.net.au'];

function isEcho360Host() {
  return SITE_HOSTS.includes(location.hostname);
}

// An element: el('button.btn.primary', { title: 'x', onclick }, 'text', child, ...).
// on* functions are guarded (an error there is reported, not thrown into the page).
function el(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const elem = document.createElement(tag || 'div');
  if (classes.length) elem.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') elem.addEventListener(k.slice(2), guard(v));
      else if (k === 'text') elem.textContent = v;
      else if (k in elem && typeof v !== 'string') elem[k] = v;
      else elem.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c != null && c !== false) elem.append(c);
  return elem;
}

// A delete button that needs a second click within 3 s (it says "Click again to delete"
// in between). onConfirm(event) gets the second click, the user action for the write.
function confirmButton(label, onConfirm) {
  let armed = 0;
  const b = el('button.link.danger', { text: label });
  b.addEventListener('click', guard((e) => {
    if (!armed) {
      b.textContent = tr('confirmDelete');
      armed = setTimeout(() => { armed = 0; b.textContent = label; }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    b.textContent = label;
    onConfirm(e);
  }));
  return b;
}

// The value of the JavaScript string literal starting at text[at] (a quote), or null if
// there is none there. Every escape a string literal can hold is decoded.
function readJsString(text, at) {
  const q = text[at];
  if (q !== '"' && q !== "'") return null;
  let out = '';
  let i = at + 1;
  for (;;) {
    let j = i;
    while (j < text.length && text[j] !== q && text[j] !== '\\' && text[j] !== '\n' && text[j] !== '\r') j++;
    out += text.slice(i, j);
    if (j >= text.length || text[j] === '\n' || text[j] === '\r') return null;
    if (text[j] === q) return out;
    const c = text[j + 1];
    i = j + 2;
    const hex = (n) => {
      const h = text.slice(i, i + n);
      if (!new RegExp('^[0-9a-fA-F]{' + n + '}$').test(h)) return null;
      i += n;
      return parseInt(h, 16);
    };
    if (c === undefined) return null;
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' }[c];
    if (simple) { out += simple; continue; }
    if (c === 'x') { const n = hex(2); if (n == null) return null; out += String.fromCharCode(n); continue; }
    if (c === 'u') {
      if (text[i] === '{') {
        const end = text.indexOf('}', i);
        const n = end > i + 1 && /^[0-9a-fA-F]{1,6}$/.test(text.slice(i + 1, end)) ? parseInt(text.slice(i + 1, end), 16) : NaN;
        if (!(n <= 0x10ffff)) return null;
        out += String.fromCodePoint(n);
        i = end + 1;
        continue;
      }
      const n = hex(4);
      if (n == null) return null;
      out += String.fromCharCode(n);
      continue;
    }
    if (c === '0' && !/[0-9]/.test(text[i] || '')) { out += '\0'; continue; }
    if (c === '\r') { if (text[i] === '\n') i++; continue; }      // line continuation
    if (c === '\n' || c === '\u2028' || c === '\u2029') continue;
    if (/[0-9]/.test(c)) return null;                                  // octal escapes: not expected
    out += c;                                                          // \" \' \\ \/ and the like
  }
}

// A canvas to draw on off screen (an OffscreenCanvas where there is one).
function makeCanvas(w, h) {
  return typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

// A picture file of a canvas made by makeCanvas (OffscreenCanvas or a page canvas).
function canvasBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas could not be saved'))), type, quality));
}

// Path segment as the original player builds it: Echo360 ids are used verbatim (they
// contain ':' and '.'), only characters that would break the URL are escaped.
function seg(id) {
  return String(id).replace(/[^\w.:~-]/g, encodeURIComponent);
}

// URL of Echo360's preview picture at `t` (one of set.timesInSeconds) of a thumbnail set.
function thumbUrlOf(set, t) {
  return set.baseUri + '/' + t + '.' + set.extension;
}

// The recording's length: the video's once it knows it, else what the page said.
function mediaDuration(video, lesson) {
  const v = video.duration;
  if (isFinite(v) && v > 0) return v;
  return isFinite(lesson.duration) ? lesson.duration : 0;
}

// The user asked the browser to save data: no background downloads.
function saveDataOn() {
  return !!(navigator.connection && navigator.connection.saveData);
}

// A course's recordings as listed by Echo360 (the JSON `data` array). Rejects when the
// list cannot be had.
async function fetchSyllabus(section) {
  const r = await fetch('/section/' + encodeURIComponent(section) + '/syllabus', { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return j && Array.isArray(j.data) ? j.data : [];
}

// A drag by one pointer on `target`, owned by the Disposer d. h.start(e) begins it and
// returns its state (or null: not a drag); h.move(e, state) follows it; h.done(e, state)
// when that pointer is lifted normally; h.cancel(state) when the browser cancels it (a
// touch turned into scrolling, the capture lost), which must undo, not complete it.
// Other pointers (a second finger) are ignored until the first one is done.
// Pointer events: https://www.w3.org/TR/pointerevents/
function onDrag(d, target, h) {
  let cur = null;   // { id, state }
  d.listen(target, 'pointerdown', (e) => {
    if (cur) return;
    const state = h.start(e);
    if (state != null) cur = { id: e.pointerId, state };
  });
  d.listen(target, 'pointermove', (e) => { if (cur && e.pointerId === cur.id && h.move) h.move(e, cur.state); });
  d.listen(target, 'pointerup', (e) => {
    if (!cur || e.pointerId !== cur.id) return;
    const c = cur;
    cur = null;
    h.done(e, c.state);
  });
  const cancel = (e) => {
    if (!cur || e.pointerId !== cur.id) return;
    const c = cur;
    cur = null;
    h.cancel(c.state);
  };
  d.listen(target, 'pointercancel', cancel);
  d.listen(target, 'lostpointercapture', cancel);
}

// The window and visibility of the document a node is in now. The player can move into the
// floating window (46-popout.js): from then on its parts are drawn by that window, and the
// page it came from may be hidden (another tab) while the player is in plain view.
function windowOf(node) {
  return (node && node.ownerDocument && node.ownerDocument.defaultView) || window;
}
function hiddenFor(node) {
  return !!(node && node.ownerDocument ? node.ownerDocument : document).hidden;
}
