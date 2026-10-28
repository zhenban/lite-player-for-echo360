// Lite Player for Echo360, the options page: every setting of the player, what this browser
// can do with it, and the user's data (how much, backup and restore, delete). It uses the
// player's own code (core.js, built from src/: its words, its settings checks, its storage
// and backups), with the settings read from and written to chrome.storage like the bridge
// does (shared.js). The data is the extension's own IndexedDB, as the player's frame keeps
// it (store.js).
/* global LitePlayerCore */
(async () => {
  const C = LitePlayerCore;
  const { tr } = C;

  // The player's settings storage, here: chrome.storage (kv:<name>, the synced settings laid
  // over this device's). Read once; written through.
  const kv = new Map();
  try {
    const all = await chrome.storage.local.get(null);
    for (const [k, v] of Object.entries(all)) if (k.startsWith(LP.KV) && typeof v === 'string') kv.set(k.slice(LP.KV.length), v);
  } catch (e) { /* none yet */ }
  try {
    const s = (await chrome.storage.sync.get('prefs')).prefs;
    if (typeof s === 'string') kv.set(LP.PREFS, LP.merged(kv.get(LP.PREFS), s));
  } catch (e) { /* sync off */ }
  C.platform.kv = {
    get: (name) => (kv.has(name) ? kv.get(name) : null),
    set(name, text) {
      kv.set(name, text);
      chrome.storage.local.set({ [LP.KV + name]: text }).catch(() => {});
      if (name === LP.PREFS) { const p = LP.parse(text); if (p) chrome.storage.sync.set({ prefs: LP.synced(p) }).catch(() => {}); }
    },
    remove(name) { kv.delete(name); chrome.storage.local.remove(LP.KV + name).catch(() => {}); },
    names: () => [...kv.keys()],
  };

  // Writes to the data take the lock the player's frames take (store.js), so a lecture open
  // meanwhile cannot write between a read and a write of its own.
  const locked = (fn) => navigator.locks.request('lite-player-for-echo360:db', fn);

  const prefs = () => C.sanitizePrefs(C.store.get('prefs', null));
  const save = (patch) => C.store.set('prefs', Object.assign(prefs(), patch));

  // ---- building blocks ----
  const h = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  };
  let uid = 0;
  const toggle = (label, desc, on, set) => {
    const id = 'o' + (++uid);
    const input = h('input', { type: 'checkbox', role: 'switch', id, 'aria-describedby': desc ? id + 'd' : null });
    input.checked = on;
    input.addEventListener('change', () => set(input.checked));
    return h('div', { class: 'opt' }, h('div', { class: 'row' }, h('label', { for: id, text: label }), input),
      desc ? h('p', { class: 'desc', id: id + 'd', text: desc }) : null);
  };
  const choice = (label, options, value, set, desc) => {
    const id = 'o' + (++uid);
    const sel = h('select', { id });
    for (const [v, text] of options) sel.append(h('option', { value: String(v), text }));
    sel.value = String(value);
    sel.addEventListener('change', () => set(options.find(([v]) => String(v) === sel.value)[0]));
    return h('div', { class: 'opt' }, h('div', { class: 'row' }, h('label', { for: id, text: label }), sel),
      desc ? h('p', { class: 'desc', text: desc }) : null);
  };
  const section = (title, ...kids) => h('section', { class: 'card' }, h('h2', { text: title }), ...kids);
  const seconds = (s) => (s < 60 ? tr('seconds', { n: s }) : s === 60 ? tr('minute') : tr('minutes', { n: s / 60 }));

  // ---- settings ----
  function settings() {
    const p = prefs();
    const audio = (k, on) => save({ audio: Object.assign({}, prefs().audio, { [k]: on, levelChosen: prefs().audio.levelChosen || k === 'level' }) });
    const silence = (k, v) => save({ silence: Object.assign({}, prefs().silence, { [k]: v }) });
    return [
      section(tr('captionsPage'),
        toggle(tr('optCaptionsDefault'), '', p.captions, (on) => save({ captions: on })),
        toggle(tr('hideCaptionsPaused'), '', p.capHidePaused, (on) => save({ capHidePaused: on })),
        choice(tr('captionSize'), Object.keys(C.CAPTION_SIZES).map((s) => [s, tr('size' + s.toUpperCase())]), p.capSize, (v) => save({ capSize: v })),
        choice(tr('copyCaptionsSpan'), C.COPY_SPANS.map((s) => [s, C.spanLabel(s)]), p.copySpan, (v) => save({ copySpan: v }), tr('copyCaptionsSpanDesc'))),
      section(tr('audio'),
        toggle(tr('audioLevel'), tr('audioLevelDesc'), p.audio.level, (on) => audio('level', on)),
        toggle(tr('audioVoice'), tr('audioVoiceDesc'), p.audio.voice, (on) => audio('voice', on)),
        toggle(tr('audioMono'), tr('audioMonoDesc'), p.audio.mono, (on) => audio('mono', on))),
      section(tr('silencePage'),
        toggle(tr('silenceAuto'), tr('silenceAutoDesc'), p.silence.auto, (on) => silence('auto', on)),
        choice(tr('silenceMin'), C.SILENCE_MIN_CHOICES.map((s) => [s, seconds(s)]), p.silence.min, (v) => silence('min', v)),
        choice(tr('silenceSensitivity'), Object.keys(C.SILENCE_SENSITIVITY).map((k) => [k, tr(k)]), p.silence.sens, (v) => silence('sens', v))),
      section(tr('layout'),
        toggle(tr('emptyScreenAuto'), tr('emptyScreenAutoDesc'), p.emptyCamera, (on) => save({ emptyCamera: on }))),
      section(tr('optAppearance'),
        choice(tr('theme'), C.THEMES.map((t) => [t, tr(C.themeKey(t))]), p.theme, (v) => save({ theme: v }), tr('themeNote')),
        choice(tr('language'), C.UI_LANGS.map((l) => [l, C.langLabel(l)]), p.lang, (v) => { save({ lang: v }); location.reload(); })),
      section(tr('telemetryMenu'),
        toggle(tr('telemetrySend'), tr('telemetryDesc'), p.telemetry, (on) => save({ telemetry: on }))),
    ];
  }

  // ---- compatibility ----
  // Asked of the open Echo360 tabs (the bridge answers for a page the player handles).
  async function tabStatuses() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (e) { return []; }
    const answers = await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'ask', name: 'status' }).catch(() => null)));
    return answers.filter((a) => a && typeof a === 'object');
  }
  function compatibility() {
    const v = document.createElement('video');
    const MS = window.ManagedMediaSource || window.MediaSource;
    const video = !!(MS && MS.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')) || !!v.canPlayType('application/vnd.apple.mpegurl');
    const rows = [
      [tr('compatRun'), !C.unsupportedReason(), C.unsupportedReason()],
      [tr('compatVideo'), video, ''],
      [tr('compatSlides'), typeof WebAssembly === 'object' && typeof Worker === 'function' && typeof OffscreenCanvas === 'function', ''],
      [tr('compatSound'), typeof AudioContext === 'function', ''],
      [tr('compatCopy'), typeof ClipboardItem === 'function', ''],
      [tr('compatPopout'), 'documentPictureInPicture' in window, ''],
    ];
    const list = h('ul', { class: 'compat' });
    const item = (label, ok, note) => h('li', { class: ok === true ? 'ok' : ok === false ? 'no' : 'unknown' },
      h('span', { class: 'mark', 'aria-hidden': 'true', text: ok === true ? '✓' : ok === false ? '!' : '–' }),
      h('span', { class: 'what' }, h('span', { text: label }), h('span', { class: 'sr', text: ok === true ? tr('compatYes') : ok === false ? tr('compatNo') : '' }),
        note ? h('span', { class: 'desc', text: note }) : null));
    for (const [label, ok, note] of rows) list.append(item(label, ok, ok ? '' : note));
    const once = item(tr('compatOnce'), null, tr('compatOnceUnknown'));
    list.append(once);
    tabStatuses().then((all) => {
      if (!all.length) return;
      const twice = all.some((s) => s.duplicate);
      once.replaceWith(item(tr('compatOnce'), !twice, twice ? tr('compatOnceTwice') : ''));
    });
    return section(tr('compatTitle'), list);
  }

  // ---- your data ----
  function data() {
    const used = h('p', { class: 'status', 'aria-live': 'polite', text: tr('dataMeasuring') });
    const note = h('p', { class: 'note', role: 'status' });
    const say = (text) => { note.textContent = text; };
    async function measure() {
      const keys = (await C.idbCache.keys()).map(String);
      const n = (prefix) => keys.filter((k) => k.startsWith(prefix)).length;
      let bytes = 0;
      try { bytes = (await navigator.storage.estimate()).usage || 0; } catch (e) { /* unknown */ }
      used.textContent = tr('dataUsed', { mb: (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0), pdfs: n('deckfile:'), watched: n('watched:'), tags: n('tags:') });
    }
    measure();

    const busy = async (btn, fn) => {
      btn.disabled = true;
      try { await fn(); } catch (e) { say(tr('exportFailed', { msg: (e && e.message) || e })); } finally { btn.disabled = false; }
    };
    const pdfs = h('input', { type: 'checkbox', id: 'withPdfs' });
    const backup = h('button', { class: 'secondary', text: tr('backupMake') });
    backup.addEventListener('click', () => busy(backup, async () => {
      const b = await C.makeBackup(pdfs.checked);
      const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' })), download: 'lite-player-for-echo360-backup-' + new Date().toISOString().slice(0, 10) + '.json' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      say(tr('backupMade', { n: Object.keys(b.db).length }));
    }));
    const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    const restore = h('button', { class: 'secondary', text: tr('backupRestore'), onclick: () => file.click() });
    file.addEventListener('change', () => busy(restore, async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      if (f.size > C.BACKUP_MAX_BYTES) throw new Error(tr('backupTooBig', { max: Math.round(C.BACKUP_MAX_BYTES / 1048576) }));
      const text = await f.text();
      const n = await locked(() => C.restoreBackup(JSON.parse(text)));
      say(tr('dataRestored', { n }));
      render();
    }));

    // Delete everything the user has (settings stay): asked here first, not in a dialog.
    const clear = h('button', { class: 'secondary danger', text: tr('dataClear') });
    const ask = h('div', { class: 'ask', hidden: true });
    clear.addEventListener('click', () => {
      ask.hidden = false;
      clear.hidden = true;
      ask.querySelector('button.danger').focus();
    });
    const no = () => { ask.hidden = true; clear.hidden = false; clear.focus(); };
    const yes = h('button', { class: 'secondary danger', text: tr('dataClearYes') });
    yes.addEventListener('click', () => busy(yes, async () => {
      const keys = (await C.idbCache.keys()).map(String);
      await locked(() => C.idbCache.putMany(keys.map((k) => [k, undefined])));
      const pos = [...kv.keys()].filter((k) => k.startsWith(C.NS + 'pos:'));
      for (const k of pos) C.platform.kv.remove(k);
      no();
      say(tr('dataCleared', { n: keys.length + pos.length }));
      measure();
    }));
    ask.append(h('p', { text: tr('dataClearAsk') }), h('div', { class: 'buttons' }, yes, h('button', { class: 'secondary', text: tr('cancel'), onclick: no })));

    return section(tr('dataTitle'),
      h('p', { class: 'desc', text: tr('dataInfo') }), used,
      h('h3', { text: tr('dataBackupTitle') }),
      h('p', { class: 'desc', text: tr('backupInfo') }),
      h('label', { class: 'check' }, pdfs, h('span', { text: tr('backupPdfs') })),
      h('div', { class: 'buttons' }, backup, restore, file),
      h('div', { class: 'buttons' }, clear), ask, note);
  }

  function render() {
    document.documentElement.lang = C.uiLocale();
    document.title = tr('optTitle');
    const app = document.getElementById('app');
    const on = h('input', { type: 'checkbox', role: 'switch', id: 'on' });
    chrome.storage.local.get('off').then((o) => { on.checked = o.off !== true; }, () => { on.checked = true; });
    on.addEventListener('change', () => chrome.storage.local.set({ off: !on.checked }));
    app.replaceChildren(
      h('header', null, h('img', { src: 'icon-32.png', alt: '', width: 24, height: 24 }), h('h1', { text: tr('optTitle') }),
        h('span', { class: 'ver', text: chrome.runtime.getManifest().version })),
      h('section', { class: 'card' }, h('div', { class: 'row switch' }, h('label', { for: 'on', text: tr('optOn') }), on),
        h('p', { class: 'desc', text: tr('optApplyNote') })),
      ...settings(), compatibility(), data());
    app.removeAttribute('aria-busy');
  }
  render();
})();
