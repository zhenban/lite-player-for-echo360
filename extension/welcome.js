// Lite Player for Echo360, the welcome page: opened once after the extension is installed
// (background.js), and from the player's one "what's new" note after an update to a new
// version (welcome.html#new: its changes first). How to start, what the player does,
// the toolbar button, and whether usage data is sent (shown here, not only in settings).
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
  const feature = (title, text) => h('li', null, h('h3', { text: tr(title) }), h('p', { class: 'desc', text: tr(text) }));

  const news = h('section', { class: 'card news', id: 'new' }, h('h2', { text: tr('welNew', { version: NEWS }) }),
    h('ul', { class: 'plain' }, ...['welNew1', 'welNew2', 'welNew3', 'welNew4'].map((k) => h('li', { text: tr(k) }))));
  const prefs = C.sanitizePrefs(C.store.get('prefs', null));
  const usage = h('input', { type: 'checkbox', role: 'switch', id: 'telemetry', 'aria-describedby': 'telemetryd' });
  usage.checked = prefs.telemetry;
  usage.addEventListener('change', () => C.store.set('prefs', Object.assign(C.sanitizePrefs(C.store.get('prefs', null)), { telemetry: usage.checked })));
  const start = [
    h('section', { class: 'card' }, h('h2', { text: tr('welTour') }),
      h('ul', { class: 'features' }, feature('welSlidesT', 'welSlides'), feature('welPdfT', 'welPdf'), feature('welAskT', 'welAsk'), feature('welStudyT', 'welStudy'))),
    h('section', { class: 'card' }, h('h2', { text: tr('welPin') }), h('p', { class: 'desc', text: tr('welPinText') })),
    h('section', { class: 'card' }, h('div', { class: 'row' }, h('label', { for: 'telemetry', text: tr('telemetrySend') }), usage),
      h('p', { class: 'desc', id: 'telemetryd', text: tr('telemetryDesc') })),
  ];
  const isNews = location.hash === '#new';
  document.documentElement.lang = C.uiLocale();
  document.title = tr('welTitle');
  document.getElementById('app').replaceChildren(
    h('header', null, h('img', { src: 'icon-128.png', alt: '', width: 48, height: 48 }), h('h1', { text: tr('welTitle') })),
    h('p', { class: 'lead', text: tr('welLead') }),
    ...(isNews ? [news, ...start] : start),
    h('div', { class: 'buttons' }, h('button', { class: 'secondary', text: tr('welSettings'), onclick: () => chrome.runtime.openOptionsPage() })));
  document.getElementById('app').removeAttribute('aria-busy');
})();
