// Lite Player for Echo360, "Add lecture moment": from an AI chat (any page), the lecture's
// picture (what Copy picture gives) and what was said just before (Copy text) go into the
// page's chat box, as if pasted; nothing is sent. Started by the toolbar's button
// (popup.js) or the keyboard shortcut (manifest commands), both of which let the extension
// into that one page for the moment (activeTab); it asks for no access to any AI site.
// Loaded by the service worker (background.js).
//
// Which lecture: of the open Echo360 tabs with the player, the one playing, or else the one
// used last (their status, bridge.js).

/* eslint-disable no-redeclare -- declared global for the files that use it (eslint.config.mjs) */
const MOMENT_ASK = { type: 'ask' };

// The shortcut set for it now (chrome://extensions/shortcuts), or '' if none.
async function momentKey() {
  try { return ((await chrome.commands.getAll()).find((c) => c.name === 'add-lecture-moment') || {}).shortcut || ''; } catch (e) { return ''; }
}

async function lectureTabs(exceptId) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (e) { return []; }
  const found = [];
  await Promise.all(tabs.filter((t) => t.id !== exceptId).map(async (t) => {
    const s = await chrome.tabs.sendMessage(t.id, Object.assign({ name: 'status' }, MOMENT_ASK)).catch(() => null);
    if (s && s.lecture) found.push({ id: t.id, playing: !!s.lecture.playing, usedAt: +s.lecture.usedAt || 0 });
  }));
  return found.sort((a, b) => (b.playing - a.playing) || (b.usedAt - a.usedAt));
}

// -> { ok, say (what to tell the user), moment (when it could not be added: for the popup
// to copy instead) }
async function addMoment(tabId) {
  const w = await LP.momentWords();
  const here = await chrome.tabs.sendMessage(tabId, Object.assign({ name: 'status' }, MOMENT_ASK)).catch(() => null);
  if (here && here.lecture) return { ok: false, say: w.fromLecture };
  const [lecture] = await lectureTabs(tabId);
  if (!lecture) return { ok: false, say: w.noLecture };
  const m = await chrome.tabs.sendMessage(lecture.id, Object.assign({ name: 'moment' }, MOMENT_ASK)).catch(() => null);
  if (!m || typeof m.text !== 'string') return { ok: false, say: w.noLecture };
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: insertMoment, args: [m, w] });
    // Counted for the welcome page's last step (welcome.js).
    if (r && r.result && r.result.ok) chrome.storage.local.get('moments').then((o) => chrome.storage.local.set({ moments: (+o.moments || 0) + 1 })).catch(() => {});
    return r && r.result ? r.result : { ok: false, say: w.cannot, moment: m };
  } catch (e) {
    return { ok: false, say: w.cannot, moment: m };
  }
}

// Runs in the AI page (the extension's isolated world there): self-contained.
// The chat box: the one with the focus, or else the lowest visible text box on the page.
// The picture is offered as a paste (chat pages take pasted images as attachments); a page
// that does not take it gets it on the clipboard instead. The text is typed in. A short
// note on the page says what happened.
async function insertMoment(m, w) {
  const key = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘V' : 'Ctrl+V';
  const fill = (text) => text.replace(/\{(\w+)\}/g, (s, k) => ({ from: m.from, to: m.to, key })[k] || s);
  const editable = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search)$/.test(el.type)));
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden'; };
  let box = document.activeElement;
  while (box && box.shadowRoot && box.shadowRoot.activeElement) box = box.shadowRoot.activeElement;
  if (!editable(box) || !shown(box)) {
    box = [...document.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')]
      .filter((el) => editable(el) && shown(el))
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
  }

  let png = null;
  if (m.picture && /^data:image\/png;base64,/.test(m.picture)) {
    const bin = atob(m.picture.slice(m.picture.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    png = new File([bytes], (m.title || 'lecture').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80) + ' ' + m.to.replace(/:/g, '.') + '.png', { type: 'image/png' });
  }
  const toClipboard = async (withText) => {
    const item = { };
    if (png) item['image/png'] = png;
    if (withText) item['text/plain'] = new Blob([m.text], { type: 'text/plain' });
    try { await navigator.clipboard.write([new ClipboardItem(item)]); return true; } catch (e) { return false; }
  };
  const note = (text) => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const d = document.createElement('div');
    d.setAttribute('role', 'status');
    d.textContent = text;
    d.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:min(520px,calc(100vw - 32px));'
      + 'padding:10px 14px;border-radius:8px;background:#232529;color:#ECEDEF;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)';
    root.append(d);
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 5000);
  };

  if (!box) {
    const ok = await toClipboard(true);
    const say = ok ? fill(w.copied) : w.cannot;
    note(say);
    return { ok, say };
  }
  box.focus();
  let pictureIn = !png;
  if (png) {
    const dt = new DataTransfer();
    dt.items.add(png);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    box.dispatchEvent(ev);
    // A page that takes the picture handles the paste itself (and stops the browser's own).
    pictureIn = ev.defaultPrevented;
  }
  const before = 'value' in box ? box.value : box.textContent;
  const typed = document.execCommand('insertText', false, (before && before.trim() ? '\n' : '') + m.text);
  if (!typed && 'value' in box) {
    box.value = (box.value ? box.value + '\n' : '') + m.text;
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: m.text }));
  }
  // Not taken by the page: on the clipboard, for the user to paste.
  const onClipboard = !pictureIn && await toClipboard(false);
  const say = fill(pictureIn ? w.added : onClipboard ? w.addedText : w.addedNoPicture);
  note(say);
  return { ok: true, say };
}
