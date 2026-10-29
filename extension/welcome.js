// Lite Player for Echo360, the welcome page: opened once after the extension is installed
// (background.js), and from the player's one "what's new" note after an update to a new
// version (welcome.html#new: its changes first). A short tour in three steps, each ticked
// by itself when done (open a lecture, copy with P or A, add a lecture moment to an AI
// chat), the keys worth knowing next, and whether usage data is sent (shown here, not only
// in settings). The tour can be skipped (and shown again).
//
// What ticks the steps (chrome.storage.local): lectureSeen and copies (bridge.js, told by
// the player), moments (moment.js, after a lecture moment went into a chat).
/* global LitePlayerCore */
(async () => {
  const C = LitePlayerCore;
  const { tr } = C;
  await LP.coreKv(C);
  // The version whose changes the list below gives (background.js tells about the same one).
  const NEWS = '1.1';

  const h = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  };
  // The pictures are drawn here (no image files): they follow the theme (welcome.css).
  const picture = (markup, label) => {
    const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    return document.importNode(svg, true);
  };
  const kbd = (k) => h('kbd', { text: k });

  // A lecture in the player: the slide, the timeline with its chapters, the transcript.
  const SLIDE = '<rect class="slide" x="0" y="0" width="200" height="112" rx="2"/><rect class="ink" x="14" y="14" width="96" height="10" rx="2"/>'
    + '<rect class="ink2" x="14" y="36" width="120" height="5" rx="2"/><rect class="ink2" x="14" y="48" width="104" height="5" rx="2"/><rect class="ink2" x="14" y="60" width="112" height="5" rx="2"/>'
    + '<rect class="bar" x="146" y="70" width="10" height="28"/><rect class="bar" x="160" y="56" width="10" height="42"/><rect class="bar a" x="174" y="40" width="10" height="58"/>';
  const HERO = '<svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg">'
    + '<rect class="win" x="1" y="1" width="638" height="298" rx="10"/><circle class="dot" cx="20" cy="18" r="4"/><circle class="dot" cx="34" cy="18" r="4"/><circle class="dot" cx="48" cy="18" r="4"/>'
    + '<rect class="addr" x="70" y="10" width="300" height="16" rx="8"/>'
    + '<rect class="video" x="16" y="38" width="420" height="246" rx="4"/>'
    + '<g transform="translate(46 54) scale(1.8)">' + SLIDE + '</g>'
    + '<rect class="track" x="32" y="262" width="388" height="4" rx="2"/><rect class="fill" x="32" y="262" width="150" height="4" rx="2"/>'
    + '<g class="ticks"><rect x="90" y="259" width="2" height="10"/><rect x="152" y="259" width="2" height="10"/><rect x="238" y="259" width="2" height="10"/><rect x="330" y="259" width="2" height="10"/></g>'
    + '<circle class="fill" cx="182" cy="264" r="6"/>'
    + '<rect class="panel" x="448" y="38" width="176" height="246" rx="4"/>'
    + '<rect class="tab on" x="460" y="50" width="48" height="14" rx="7"/><rect class="tab" x="514" y="50" width="40" height="14" rx="7"/><rect class="tab" x="560" y="50" width="40" height="14" rx="7"/>'
    + '<g class="lines"><rect x="460" y="80" width="140" height="5" rx="2"/><rect x="460" y="92" width="120" height="5" rx="2"/><rect x="460" y="112" width="148" height="5" rx="2"/><rect x="460" y="124" width="96" height="5" rx="2"/></g>'
    + '<rect class="now" x="454" y="140" width="164" height="38" rx="4"/><g class="lines strong"><rect x="460" y="148" width="144" height="5" rx="2"/><rect x="460" y="160" width="128" height="5" rx="2"/></g>'
    + '<g class="lines"><rect x="460" y="194" width="136" height="5" rx="2"/><rect x="460" y="206" width="108" height="5" rx="2"/><rect x="460" y="226" width="146" height="5" rx="2"/><rect x="460" y="238" width="90" height="5" rx="2"/></g>'
    + '</svg>';
  // The lecture's picture and text going into a chat's message box (moved by welcome.css).
  const MOMENT = '<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg">'
    + '<rect class="win" x="1" y="1" width="250" height="200" rx="8"/><rect class="video" x="12" y="14" width="228" height="140" rx="3"/>'
    + '<g transform="translate(26 24) scale(1)">' + SLIDE + '</g><rect class="track" x="20" y="166" width="212" height="4" rx="2"/><rect class="fill" x="20" y="166" width="90" height="4" rx="2"/>'
    + '<g class="lines"><rect x="20" y="180" width="160" height="4" rx="2"/></g>'
    + '<path class="arrow" d="M268 100 h44 m-10 -9 l10 9 l-10 9"/>'
    + '<rect class="win" x="329" y="1" width="310" height="218" rx="8"/>'
    + '<rect class="bubble" x="474" y="18" width="150" height="26" rx="13"/><rect class="bubble other" x="344" y="54" width="190" height="40" rx="13"/>'
    + '<rect class="box" x="342" y="112" width="284" height="96" rx="12"/>'
    + '<g class="typed"><rect class="ink2" x="430" y="128" width="170" height="5" rx="2"/><rect class="ink2" x="430" y="140" width="150" height="5" rx="2"/><rect class="ink2" x="430" y="152" width="160" height="5" rx="2"/></g>'
    + '<rect class="caret" x="356" y="184" width="2" height="14"/>'
    + '<g class="fly"><g transform="translate(354 124) scale(.32)">' + SLIDE + '</g><rect class="edge" x="354" y="124" width="64" height="36" rx="2"/></g>'
    + '</svg>';

  // ---- the steps ----
  const key = await momentKey();
  const steps = [
    { id: 'lecture', title: 'welStep1T', wait: 'welStep1Wait', done: 'welStep1Done', body: () => [h('p', { text: tr('welStep1') })] },
    {
      id: 'copy', title: 'welStep2T', wait: 'welStep2Wait', done: 'welStep2Done',
      body: () => [h('dl', { class: 'keylist big' }, h('dt', null, kbd('P')), h('dd', { text: tr('welStep2P') }), h('dt', null, kbd('A')), h('dd', { text: tr('welStep2A') }))],
    },
    {
      id: 'moment', title: 'welStep3T', wait: 'welStep3Wait', done: 'welStep3Done',
      body: () => [
        h('p', { text: tr('welStep3') }),
        key ? h('p', { class: 'shortcut' }, LP.keysNode(key))
          : h('p', { class: 'shortcut none' }, h('span', { text: tr('welStep3NoKey') + ' ' }),
            h('button', { class: 'link', text: tr('welSetKey'), onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) })),
        h('p', { class: 'desc', text: tr('welStep3After') }),
        h('figure', { class: 'moment' }, picture(MOMENT, tr('welStep3T'))),
      ],
    },
  ];
  const list = h('ol', { class: 'steps', 'aria-live': 'polite' });
  const items = steps.map((s, i) => {
    const say = h('p', { class: 'state' });
    const li = h('li', { class: 'step' }, h('span', { class: 'num', 'aria-hidden': 'true' }, h('span', { class: 'n', text: String(i + 1) })),
      h('div', { class: 'body' }, h('h2', { text: tr(s.title) }), ...s.body(), say));
    list.append(li);
    return { s, li, say };
  });
  const allDone = h('p', { class: 'alldone', text: tr('welAllDone'), hidden: '' });

  // Ticked from what the extension has seen; changes elsewhere (a lecture tab, a chat) tick
  // them while this page is open. View transitions move the tick in where Chrome has them.
  let state = {};
  const show = () => {
    const done = { lecture: state.lectureSeen === true, copy: +state.copies > 0, moment: +state.moments > 0 };
    let current = false;
    for (const { s, li, say } of items) {
      const ok = done[s.id];
      li.classList.toggle('done', ok);
      li.classList.toggle('current', !ok && !current);
      if (!ok) current = true;
      say.textContent = tr(ok ? s.done : s.wait);
    }
    allDone.hidden = !Object.values(done).every(Boolean);
  };
  const KEYS = ['lectureSeen', 'copies', 'moments', 'tourSkipped'];
  try { state = await chrome.storage.local.get(KEYS); } catch (e) { /* nothing ticked */ }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !KEYS.some((k) => k in changes)) return;
    for (const k of KEYS) if (k in changes) state[k] = changes[k].newValue;
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(show);
    else show();
  });

  // ---- the rest of the page ----
  const TIER1 = [[['Space', 'K'], 'keyPlay'], [['J', 'L'], 'keySeek10'], [['[', ']'], 'keySpeed'], [['Shift+←', 'Shift+→'], 'keySlide'],
    [['C'], 'keyCaptions'], [['T'], 'keyTranscript'], [['B'], 'keyBookmark']];
  const keys = h('section', { class: 'more' }, h('h2', { text: tr('welKeysT') }),
    h('dl', { class: 'keylist' }, ...TIER1.flatMap(([ks, label]) => [h('dt', null, ...ks.map((k) => kbd(k === 'Space' ? tr('kbdSpace') : k))), h('dd', { text: tr(label) })])),
    h('p', { class: 'desc' }, tr('welKeysAll')));
  const tour = h('div', { class: 'tour' }, h('p', { class: 'lead', text: tr('welLead') }), h('figure', { class: 'hero' }, picture(HERO, tr('welTitle'))), list, allDone, keys);

  const news = h('section', { class: 'card news', id: 'new' }, h('h2', { text: tr('welNew', { version: NEWS }) }),
    h('ul', { class: 'plain' }, ...['welNew0', 'welNew1', 'welNew2', 'welNew3', 'welNew4'].map((k) => h('li', { text: tr(k) }))));
  const prefs = C.sanitizePrefs(C.store.get('prefs', null));
  const usage = h('input', { type: 'checkbox', role: 'switch', id: 'telemetry', 'aria-describedby': 'telemetryd' });
  usage.checked = prefs.telemetry;
  usage.addEventListener('change', () => C.store.set('prefs', Object.assign(C.sanitizePrefs(C.store.get('prefs', null)), { telemetry: usage.checked })));
  const extras = h('div', { class: 'extras' },
    h('section', { class: 'card' }, h('h2', { text: tr('welPin') }), h('p', { class: 'desc', text: tr('welPinText') })),
    h('section', { class: 'card' }, h('div', { class: 'row' }, h('label', { for: 'telemetry', text: tr('telemetrySend') }), usage),
      h('p', { class: 'desc', id: 'telemetryd', text: tr('telemetryDesc') })));

  // Skipping hides the tour (remembered); the same button shows it again.
  const skip = h('button', { class: 'link skip' });
  const skipped = () => {
    tour.hidden = state.tourSkipped === true;
    skip.textContent = tr(tour.hidden ? 'welShow' : 'welSkip');
  };
  skip.addEventListener('click', () => {
    state.tourSkipped = !tour.hidden;
    chrome.storage.local.set({ tourSkipped: state.tourSkipped }).catch(() => {});
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(skipped);
    else skipped();
  });

  const isNews = location.hash === '#new';
  document.documentElement.lang = C.uiLocale();
  document.title = tr('welTitle');
  show();
  skipped();
  document.getElementById('app').replaceChildren(
    h('header', null, h('img', { src: 'icon-128.png', alt: '', width: 48, height: 48 }), h('h1', { text: tr('welTitle') }), skip),
    ...(isNews ? [news] : []), tour, extras,
    h('div', { class: 'buttons' }, h('button', { class: 'secondary', text: tr('welSettings'), onclick: () => chrome.runtime.openOptionsPage() })));
  document.getElementById('app').removeAttribute('aria-busy');
})();
