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

  // The player's settings storage, here: chrome.storage (shared.js).
  const kv = await LP.coreKv(C);

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
  // One setting: its name and what it does on the left, its control on the right (below them
  // when the window is too narrow for both).
  const opt = (id, label, desc, control) => h('div', { class: 'opt' },
    h('div', { class: 'text' }, h('label', { for: id, text: label }), desc ? h('p', { class: 'desc', id: id + 'd', text: desc }) : null), control);
  const toggle = (label, desc, on, set) => {
    const id = 'o' + (++uid);
    const input = h('input', { type: 'checkbox', role: 'switch', id, 'aria-describedby': desc ? id + 'd' : null });
    input.checked = on;
    input.addEventListener('change', () => set(input.checked));
    return opt(id, label, desc, input);
  };
  const choice = (label, options, value, set, desc) => {
    const id = 'o' + (++uid);
    const sel = h('select', { id, 'aria-describedby': desc ? id + 'd' : null });
    for (const [v, text] of options) sel.append(h('option', { value: String(v), text }));
    sel.value = String(value);
    sel.addEventListener('change', () => set(options.find(([v]) => String(v) === sel.value)[0]));
    return opt(id, label, desc, sel);
  };
  // A section of the page, with an id for the side navigation. Settings sit in one panel of
  // rows; the read-only and data sections pass their own content.
  const section = (id, title, ...kids) => h('section', { id, 'aria-labelledby': id + '-h' }, h('h2', { id: id + '-h', text: title }), ...kids);
  const group = (id, title, ...opts) => section(id, title, h('div', { class: 'group' }, ...opts));
  // A change on the page shown as a short morph or cross-fade (View Transitions), at once
  // where the browser has none or the user asked for less motion.
  const swap = (fn) => (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches ? document.startViewTransition(fn) : fn());
  const seconds = (s) => (s < 60 ? tr('seconds', { n: s }) : s === 60 ? tr('minute') : tr('minutes', { n: s / 60 }));

  // ---- settings ----
  function settings() {
    const p = prefs();
    const audio = (k, on) => save({ audio: Object.assign({}, prefs().audio, { [k]: on, levelChosen: prefs().audio.levelChosen || k === 'level' }) });
    const silence = (k, v) => save({ silence: Object.assign({}, prefs().silence, { [k]: v }) });
    return [
      group('captions', tr('captionsPage'),
        toggle(tr('optCaptionsDefault'), '', p.captions, (on) => save({ captions: on })),
        toggle(tr('hideCaptionsPaused'), '', p.capHidePaused, (on) => save({ capHidePaused: on })),
        choice(tr('captionSize'), Object.keys(C.CAPTION_SIZES).map((s) => [s, tr('size' + s.toUpperCase())]), p.capSize, (v) => save({ capSize: v })),
        choice(tr('copyCaptionsSpan'), C.COPY_SPANS.map((s) => [s, C.spanLabel(s)]), p.copySpan, (v) => save({ copySpan: v }), tr('copyCaptionsSpanDesc'))),
      group('audio', tr('audio'),
        toggle(tr('audioLevel'), tr('audioLevelDesc'), p.audio.level, (on) => audio('level', on)),
        toggle(tr('audioVoice'), tr('audioVoiceDesc'), p.audio.voice, (on) => audio('voice', on)),
        toggle(tr('audioMono'), tr('audioMonoDesc'), p.audio.mono, (on) => audio('mono', on))),
      group('silence', tr('silencePage'),
        toggle(tr('silenceAuto'), tr('silenceAutoDesc'), p.silence.auto, (on) => silence('auto', on)),
        choice(tr('silenceMin'), C.SILENCE_MIN_CHOICES.map((s) => [s, seconds(s)]), p.silence.min, (v) => silence('min', v)),
        choice(tr('silenceSensitivity'), Object.keys(C.SILENCE_SENSITIVITY).map((k) => [k, tr(k)]), p.silence.sens, (v) => silence('sens', v))),
      group('layout', tr('layout'),
        toggle(tr('emptyScreenAuto'), tr('emptyScreenAutoDesc'), p.emptyCamera, (on) => save({ emptyCamera: on }))),
      group('appearance', tr('optAppearance'),
        choice(tr('theme'), C.THEMES.map((t) => [t, tr(C.themeKey(t))]), p.theme, (v) => save({ theme: v }), tr('themeNote')),
        choice(tr('language'), C.UI_LANGS.map((l) => [l, C.langLabel(l)]), p.lang, (v) => { save({ lang: v }); location.reload(); })),
      group('usage', tr('telemetryMenu'),
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
      swap(() => once.replaceWith(item(tr('compatOnce'), !twice, twice ? tr('compatOnceTwice') : '')));
    });
    return section('compat', tr('compatTitle'), list);
  }

  // ---- your data ----
  // done: the result of the last action, kept across a re-render (the restore re-renders).
  function data(done) {
    const used = h('p', { class: 'status', 'aria-live': 'polite', text: tr('dataMeasuring') });
    const note = h('p', { class: 'note', role: 'status', text: done || '' });
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
      render(tr('dataRestored', { n }));
    }));

    // Delete everything the user has (settings stay): asked here first, not in a dialog.
    // The button and the question share a view-transition name, so the one morphs into the other.
    const clear = h('button', { class: 'secondary danger', text: tr('dataClear') });
    const ask = h('div', { class: 'ask', hidden: true });
    clear.addEventListener('click', () => swap(() => {
      ask.hidden = false;
      clear.hidden = true;
      ask.querySelector('button.danger').focus();
    }));
    const no = () => swap(() => { ask.hidden = true; clear.hidden = false; clear.focus(); });
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

    // The results sit under the counts they change; deleting is set apart below the backup.
    return section('data', tr('dataTitle'),
      h('p', { class: 'desc', text: tr('dataInfo') }), used, note,
      h('div', { class: 'group pad' },
        h('h3', { text: tr('dataBackupTitle') }),
        h('p', { class: 'desc', text: tr('backupInfo') }),
        h('label', { class: 'check' }, pdfs, h('span', { text: tr('backupPdfs') })),
        h('div', { class: 'buttons' }, backup, restore, file)),
      h('div', { class: 'erase' },
        h('div', { class: 'clear' }, h('p', { class: 'desc', text: tr('dataClearInfo') }), clear), ask));
  }

  // ---- the side navigation ----
  // The current section is marked by the browser where it can (scroll-target-group,
  // :target-current in options.css); elsewhere by watching which section is at the top.
  let stop = null;
  function track(nav, sections) {
    if (stop) stop.abort();
    stop = new AbortController();
    const strip = nav.firstChild;
    // On a narrow window the links are a strip that scrolls sideways: once the page stops
    // scrolling, the current link is brought into it (scrollend, Chrome 114; else it stays put).
    const reveal = () => {
      let a = nav.querySelector('a[aria-current]');
      try { a = a || nav.querySelector('a:target-current'); } catch (e) { /* no :target-current */ }
      if (!a || strip.scrollWidth <= strip.clientWidth) return;
      const r = a.getBoundingClientRect();
      const left = strip.scrollLeft + r.left - strip.getBoundingClientRect().left - (strip.clientWidth - r.width) / 2;
      strip.scrollTo({ left, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    };
    addEventListener('scrollend', reveal, { signal: stop.signal });
    if (CSS.supports('scroll-target-group', 'auto') || typeof IntersectionObserver !== 'function') return;
    const shown = new Set();
    const watcher = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) shown.add(e.target); else shown.delete(e.target);
      const top = sections.find((s) => shown.has(s));
      if (!top) return;
      for (const a of nav.querySelectorAll('a')) {
        if (a.hash === '#' + top.id) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      }
    }, { rootMargin: '-10% 0px -60% 0px' });
    for (const s of sections) watcher.observe(s);
    stop.signal.addEventListener('abort', () => watcher.disconnect());
  }

  function render(done) {
    document.documentElement.lang = C.uiLocale();
    document.title = tr('optTitle');
    const app = document.getElementById('app');
    const on = h('input', { type: 'checkbox', role: 'switch', id: 'on', 'aria-describedby': 'ond' });
    chrome.storage.local.get('off').then((o) => { on.checked = o.off !== true; }, () => { on.checked = true; });
    on.addEventListener('change', () => chrome.storage.local.set({ off: !on.checked }));
    const sections = [...settings(), compatibility(), data(done)];
    // The settings, then what this browser can do and holds, as two groups of links.
    const link = (s) => h('a', { href: '#' + s.id, text: s.querySelector('h2').textContent });
    const nav = h('nav', { class: 'toc', 'aria-label': tr('optSections') },
      h('div', { class: 'links' }, ...sections.slice(0, -2).map(link), h('span', { class: 'gap', 'aria-hidden': 'true' }), ...sections.slice(-2).map(link)));
    app.replaceChildren(
      h('header', null, h('img', { src: 'icon-32.png', alt: '', width: 24, height: 24 }),
        h('div', null, h('h1', { text: tr('optTitle') }), h('span', { class: 'ver', text: chrome.runtime.getManifest().version }))),
      h('div', { class: 'master' }, h('div', { class: 'opt' },
        h('div', { class: 'text' }, h('label', { for: 'on', text: tr('optOn') }), h('p', { class: 'desc', id: 'ond', text: tr('optApplyNote') })), on)),
      nav,
      h('div', { class: 'sections' }, ...sections));
    track(nav, sections);
    app.removeAttribute('aria-busy');
  }
  render();
})();
