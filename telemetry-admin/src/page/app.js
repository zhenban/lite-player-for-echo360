// The page: filters, the overview (active users, then five health checks), and six
// sections of detail. Built once per language; data updates move what is already there.
// Preferences (language, theme, range, devices) stay in this browser only.
const PREFS_KEY = 'lpdash';
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
})();
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private window: not kept */ }
}

const state = {
  range: [7, 30, 90].includes(prefs.range) ? prefs.range : 30,
  version: 'all',
  devices: prefs.devices === 'others' ? 'others' : 'all',
  data: null,
  seq: 0,
};
LANG = prefs.lang === 'zh' ? 'zh' : 'en';
let ui = null;

function applyTheme() {
  const th = prefs.theme === 'light' || prefs.theme === 'dark' ? prefs.theme : null;
  if (th) document.documentElement.dataset.theme = th;
  else delete document.documentElement.dataset.theme;
}
applyTheme();

const GLYPH = {
  system: ['M3 4.5h14v9H3z', 'M7 16.5h6'],
  light: ['M10 6.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z', 'M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4'],
  dark: ['M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1Z'],
  table: ['M3 4.5h14v11H3zM3 8.5h14M3 12h14M8 4.5v11'],
  chart: ['M4 16V9M8 16V5M12 16v-5M16 16V7'],
};

// ---- Building --------------------------------------------------------------------------

function block(cls, title, ...content) {
  const caption = h('p', { class: 'blk-cap' });
  const note = h('span', { class: 'blk-low', hidden: true }, icon('none'), t('tooFew'));
  const empty = h('p', { class: 'blk-empty', hidden: true });
  const body = h('div', { class: 'blk-body' }, ...content);
  const head = h('div', { class: 'blk-head' }, h('h3', { text: title }));
  const root = h('div', { class: 'blk ' + cls }, head, h('div', { class: 'blk-meta' }, caption, note), body, empty);
  return {
    root, head, body,
    // Sample size (and dimming when it is small), or an empty-state text instead of the body.
    meta(text, low, emptyText) {
      caption.textContent = text || '';
      caption.hidden = !text;
      note.hidden = !low || !!emptyText;
      root.classList.toggle('is-low', !!low && !emptyText);
      body.hidden = !!emptyText;
      empty.hidden = !emptyText;
      empty.textContent = emptyText || '';
    },
  };
}

function tableToggle(chart, blk) {
  let on = false;
  const btn = h('button', { class: 'icon-btn', type: 'button', 'aria-pressed': 'false', title: t('showTable'), 'aria-label': t('showTable') }, glyph(GLYPH.table));
  btn.addEventListener('click', () => {
    on = !on;
    chart.showTable(on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = t(on ? 'showChart' : 'showTable');
    btn.setAttribute('aria-label', btn.title);
    btn.replaceChildren(glyph(on ? GLYPH.chart : GLYPH.table));
  });
  blk.head.append(btn);
}

function section(id, title) {
  const finding = h('p', { class: 'finding' });
  const grid = h('div', { class: 'sec-grid' });
  const root = h('section', { class: 'sec', id, 'aria-labelledby': id + '-h' },
    h('header', { class: 'sec-head' }, h('h2', { id: id + '-h', text: title }), finding), grid);
  return { root, finding, grid };
}

function statList(keys) {
  const root = h('dl', { class: 'stats' });
  const vals = {};
  for (const k of keys) {
    vals[k] = h('dd');
    root.append(h('div', { class: 'stat' }, h('dt', { text: t(k) }), vals[k]));
  }
  return { root, vals };
}

function segmented(name, options, current, onPick) {
  const root = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name });
  const buttons = options.map(([value, label]) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(value === current), text: label });
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      onPick(value);
    });
    b.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(b);
      const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1;
      if (j >= 0 && j < buttons.length) { e.preventDefault(); buttons[j].focus(); buttons[j].click(); }
    });
    root.append(b);
    return b;
  });
  return root;
}

function build() {
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  document.title = t('title');
  const app = document.getElementById('app');
  const u = {};

  // Header: title, preferences, filters.
  const mark = glyph(['M4 3.5h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z', 'M8.2 7.2v5.6l4.6-2.8-4.6-2.8Z'], 'mark');
  const langBtn = h('button', { class: 'pill-btn', type: 'button', lang: LANG === 'zh' ? 'en' : 'zh', title: t('language'), text: LANG === 'zh' ? 'English' : '中文' });
  langBtn.addEventListener('click', () => { prefs.lang = LANG === 'zh' ? 'en' : 'zh'; LANG = prefs.lang; savePrefs(); rebuild(); });
  const themeOrder = ['system', 'light', 'dark'];
  const theme = themeOrder.includes(prefs.theme) ? prefs.theme : 'system';
  const themeLabel = t('theme' + theme[0].toUpperCase() + theme.slice(1));
  const themeBtn = h('button', { class: 'icon-btn', type: 'button', title: themeLabel, 'aria-label': themeLabel }, glyph(GLYPH[theme]));
  themeBtn.addEventListener('click', () => {
    prefs.theme = themeOrder[(themeOrder.indexOf(themeOrder.includes(prefs.theme) ? prefs.theme : 'system') + 1) % 3];
    savePrefs();
    applyTheme();
    const lbl = t('theme' + prefs.theme[0].toUpperCase() + prefs.theme.slice(1));
    themeBtn.title = lbl;
    themeBtn.setAttribute('aria-label', lbl);
    themeBtn.replaceChildren(glyph(GLYPH[prefs.theme]));
  });

  const range = segmented(t('range'), [7, 30, 90].map((n) => [n, t('range_' + n)]), state.range, (v) => {
    state.range = v; prefs.range = v; savePrefs(); load();
  });
  u.version = h('select', { class: 'select', 'aria-label': t('version') });
  u.version.addEventListener('change', () => { state.version = u.version.value; load(); });
  u.exclude = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input' });
  u.exclude.checked = state.devices === 'others';
  u.exclude.addEventListener('change', () => {
    state.devices = u.exclude.checked ? 'others' : 'all'; prefs.devices = state.devices; savePrefs(); load();
  });
  u.excludeWrap = h('label', { class: 'switch', title: t('excludeMineHint') }, u.exclude, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', { text: t('excludeMine') }));
  u.asOf = h('p', { class: 'asof' });

  const header = h('header', { class: 'top' },
    h('div', { class: 'top-row' },
      h('div', { class: 'brand' }, mark, h('div', null, h('h1', { text: t('title') }), h('p', { class: 'sub', text: t('subtitle') }))),
      h('div', { class: 'prefs' }, langBtn, themeBtn)),
    h('div', { class: 'filters' }, range, h('label', { class: 'select-wrap' }, h('span', { class: 'sr', text: t('version') }), u.version), u.excludeWrap, u.asOf));

  // Overview: active users first and largest, then the five checks as one strip.
  u.heroValue = h('span', { class: 'hero-num' });
  u.heroUnit = h('span', { class: 'hero-unit' });
  u.heroDelta = h('p', { class: 'hero-delta' });
  u.heroSub = h('p', { class: 'hero-sub' });
  u.heroSpark = h('div', { class: 'spark', 'aria-hidden': 'true' });
  u.hero = h('a', { class: 'hero', href: '#users' },
    h('div', { class: 'hero-text' }, h('span', { class: 'hero-label', text: t('tile_users') }), h('p', { class: 'hero-line' }, u.heroValue, u.heroUnit), u.heroDelta, u.heroSub),
    u.heroSpark);
  u.tiles = {};
  const strip = h('nav', { class: 'strip', 'aria-label': t('title') });
  ['devices', 'smooth', 'errors', 'features', 'compat'].forEach((k, i) => {
    const tile = {
      status: h('span', { class: 'tile-status' }),
      value: h('strong', { class: 'tile-value' }),
      sub: h('span', { class: 'tile-sub' }),
    };
    tile.root = h('a', { class: 'tile', href: '#' + k, style: { '--i': String(i + 1) } },
      h('span', { class: 'tile-label', text: t('tile_' + k) }), tile.value, tile.sub, tile.status);
    u.tiles[k] = tile;
    strip.append(tile.root);
  });
  u.notice = h('div', { class: 'notice', hidden: true });

  // Users
  const users = section('users', t('sec_users'));
  u.usersSec = users;
  u.dailyUsers = columnChart({
    value: (d) => d.users,
    rows: (d) => [[fmtInt(d.users), t('tipUsers')], [fmtInt(d.sessions), t('tipViews')], [fmtDuration(d.playSec), t('tipPlayed')]],
    label: () => t('dailyUsers'),
    table: [[() => t('tile_users'), (d) => fmtInt(d.users)], [() => t('viewingsCol'), (d) => fmtInt(d.sessions)], [() => t('tipPlayed'), (d) => fmtDuration(d.playSec)]],
  });
  u.bDaily = block('w-8', t('dailyUsers'), u.dailyUsers.root);
  tableToggle(u.dailyUsers, u.bDaily);
  u.userStats = statList(['newInRange', 'watchedShare', 'silenceSkipped', 'keysShare']);
  u.versionBars = barList();
  u.bSide = block('w-4', t('versionsInUse'), u.versionBars.root, u.userStats.root);
  u.where = {};
  const whereBlocks = ['country', 'region', 'network'].map((k) => {
    u.where[k] = barList({ compact: true });
    const b = block('w-4', t(k), u.where[k].root);
    u.where[k + 'Blk'] = b;
    return b;
  });
  users.grid.append(u.bDaily.root, u.bSide.root, ...whereBlocks.map((b) => b.root));

  // Devices
  const devices = section('devices', t('sec_devices'));
  u.devicesSec = devices;
  u.dims = {};
  const dimList = h('div', { class: 'lists' });
  for (const dim of ['browser', 'os', 'form', 'manager', 'screen', 'cores', 'memory', 'gpu', 'hwdecode', 'webgpu', 'webcodecs']) {
    const list = barList({ compact: true });
    u.dims[dim] = list;
    dimList.append(h('div', { class: 'list' }, h('h4', { text: t('dim_' + dim) }), list.root));
  }
  u.bDevices = block('w-12', t('sec_devices'), dimList);
  u.bDevices.head.hidden = true;
  devices.grid.append(u.bDevices.root);

  // Performance
  const smooth = section('smooth', t('sec_smooth'));
  u.smoothSec = smooth;
  u.metrics = {};
  const groups = [['smoothness', ['dropped_pct', 'input_ms90', 'long_tasks_pm']], ['startup', ['boot_ms', 'ready_ms', 'first_frame_ms', 'seek_ms90', 'rebuffer_pct', 'sync_ms_max']], ['load', ['heap_mb', 'cpu_bg', 'cpu_idle']]];
  const metricGroups = groups.map(([g, list]) => h('div', { class: 'm-group' }, h('h4', { text: t(g) }), ...list.map((m) => { u.metrics[m] = metricRow(m); return u.metrics[m].root; })));
  u.bMetrics = block('w-8', t('smoothness'), h('p', { class: 'blk-intro', text: t('perfIntro') }), ...metricGroups);
  u.bMetrics.head.hidden = true;
  u.versionTable = h('table', { class: 'data-table versions' });
  u.bVersions = block('w-4', t('byVersion'), u.versionTable);
  smooth.grid.append(u.bMetrics.root, u.bVersions.root);

  // Stability
  const errors = section('errors', t('sec_errors'));
  u.errorsSec = errors;
  u.dailyProblems = columnChart({
    value: (d) => d.problems,
    rows: (d) => [[fmtInt(d.problems), t('tipProblems')], [fmtInt(d.sessions), t('tipViews')], [fmtInt(d.errors), t('tipErrors')]],
    label: () => t('dailyProblems'),
    table: [[() => t('dailyProblems'), (d) => fmtInt(d.problems)], [() => t('viewingsCol'), (d) => fmtInt(d.sessions)], [() => t('errTimes'), (d) => fmtInt(d.errors)]],
  });
  u.bProblems = block('w-8', t('dailyProblems'), u.dailyProblems.root);
  tableToggle(u.dailyProblems, u.bProblems);
  u.kinds = barList({ compact: true, stacked: true });
  u.parts = barList({ compact: true, stacked: true });
  u.bKinds = block('w-4', t('kinds'), u.kinds.root, h('h4', { class: 'sub-h', text: t('failedParts') }), u.parts.root);
  u.errTable = h('div', { class: 'err-list' });
  u.bErrors = block('w-12', t('topErrors'), u.errTable);
  errors.grid.append(u.bProblems.root, u.bKinds.root, u.bErrors.root);

  // Features
  const features = section('features', t('sec_features'));
  u.featuresSec = features;
  u.featureBars = barList();
  u.unused = h('div', { class: 'chips' });
  u.bFeatures = block('w-8', t('featureUse'), u.featureBars.root, h('h4', { class: 'sub-h', text: t('neverUsed') }), u.unused);
  u.changedBars = barList({ compact: true });
  u.bChanged = block('w-4', t('changedSettings'), u.changedBars.root);
  u.speedBars = barList({ compact: true, format: (v) => fmtDuration(v) });
  u.bSpeeds = block('w-4', t('speedsPlayed'), u.speedBars.root);
  u.slideSrcBars = barList({ compact: true, stacked: true });
  u.slideStopBars = barList({ compact: true, stacked: true });
  u.slideStopHead = h('h4', { class: 'sub-h', text: t('slideStops') });
  u.bSlides = block('w-4', t('slideSources'), u.slideSrcBars.root, u.slideStopHead, u.slideStopBars.root);
  const featSide = h('div', { class: 'stack w-4' }, u.bChanged.root, u.bSpeeds.root, u.bSlides.root);
  for (const b of [u.bChanged, u.bSpeeds, u.bSlides]) b.root.classList.remove('w-4');
  features.grid.append(u.bFeatures.root, featSide);
  u.formBars = barList({ compact: true, stacked: true });
  u.formTable = h('table', { class: 'data-table' });
  u.bForms = block('w-12', t('slideForms'), h('p', { class: 'blk-intro', text: t('slideFormsCap') }),
    h('div', { class: 'form-split' }, u.formBars.root,
      h('div', null, h('h4', { class: 'sub-h form-sub', text: t('bySystem') }), h('div', { class: 'tbl-scroll' }, u.formTable))));
  features.grid.append(u.bForms.root);

  // Compatibility
  const compat = section('compat', t('sec_compat'));
  u.compatSec = compat;
  u.dailyFallbacks = columnChart({
    value: (d) => d.fallbacks,
    rows: (d) => [[fmtInt(d.fallbacks), t('tipFallbacks')], [fmtInt(d.sessions), t('tipViews')]],
    label: () => t('dailyFallbacks'),
    table: [[() => t('dailyFallbacks'), (d) => fmtInt(d.fallbacks)], [() => t('viewingsCol'), (d) => fmtInt(d.sessions)]],
  });
  u.bFallbacks = block('w-8', t('dailyFallbacks'), u.dailyFallbacks.root);
  tableToggle(u.dailyFallbacks, u.bFallbacks);
  u.reasonBars = barList({ compact: true, stacked: true });
  u.bReasons = block('w-4', t('reasons'), u.reasonBars.root);
  u.frontends = h('ol', { class: 'timeline' });
  u.bFrontends = block('w-8', t('pageCode'), h('p', { class: 'blk-intro', text: t('pageCodeCap') }), u.frontends);
  u.bootBars = barList({ compact: true, stacked: true });
  u.bootNote = h('p', { class: 'blk-note' });
  u.bBoot = block('w-4', t('bootPaths'), u.bootBars.root, u.bootNote);
  compat.grid.append(u.bFallbacks.root, u.bReasons.root, u.bFrontends.root, u.bBoot.root);

  u.main = h('main', { class: 'main' }, users.root, devices.root, smooth.root, errors.root, features.root, compat.root);
  u.status = h('p', { class: 'load-status', role: 'status', 'aria-live': 'polite' });
  app.replaceChildren(header, h('section', { class: 'overview', 'aria-label': t('title') }, u.hero, strip), u.notice, u.status, u.main,
    h('footer', { class: 'foot', text: t('footer') }));
  return u;
}

function rebuild() {
  ui = build();
  if (state.data) render(state.data, false);
}

// ---- Rendering -------------------------------------------------------------------------

function statusChip(node, s) {
  const lvl = s.level === 'info' ? (s.low ? 'none' : 'info') : s.level;
  const label = s.level === 'none' ? t('status_none') : s.low ? t('lowSample') : t('status_' + s.level);
  node.replaceChildren(icon(s.level === 'none' || s.low ? 'none' : s.level), h('span', { text: label }));
  node.dataset.level = lvl;
  node.hidden = !label;
  // The coloured edge only when there is enough data to mean it.
  node.parentElement.dataset.level = s.low ? 'none' : s.level;
}

const GPU_NAMES = { amd: 'AMD', nvidia: 'NVIDIA', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm', arm: 'Arm', 'imagination-technologies': 'Imagination', microsoft: 'Microsoft' };
const basedOn = (kind, n) => t('basedOn_' + kind, { n });
const label = (dim, v) => {
  if (v == null) return t('unknown');
  if (dim === 'form' || dim === 'screen' || dim === 'memory' || dim === 'hwdecode' || dim === 'webgpu' || dim === 'webcodecs') return t(dim + '_' + v);
  if (dim === 'cores') return t('cores_n', { v });
  if (dim === 'gpu') return GPU_NAMES[v] || v.charAt(0).toUpperCase() + v.slice(1);
  if (dim === 'manager' && v === 'none') return t('unknown');
  return v;
};

function render(d, animate) {
  const o = d.overview;
  const low = d.lowSample;
  const rangeText = t('rangeLong', { n: d.filters.range });
  const prevText = t('prevLong', { n: d.filters.range });

  // Filters that depend on the data.
  const versions = d.versionList.map((v) => v.version);
  if (state.version !== 'all' && !versions.includes(state.version)) versions.unshift(state.version);
  ui.version.replaceChildren(h('option', { value: 'all', text: t('allVersions') }), ...versions.map((v) => h('option', { value: v, text: 'v' + v })));
  ui.version.value = state.version;
  ui.excludeWrap.hidden = !d.canExclude;
  ui.asOf.textContent = d.latestAt ? t('asOf', { time: fmtAgo(d.latestAt, d.generatedAt) }) : t('noDataYet');
  if (d.latestAt) ui.asOf.title = fmtTime(d.latestAt);

  // Hero: active users.
  tweenNumber(ui.heroValue, o.users, fmtInt, animate ? 900 : 500);
  ui.heroUnit.textContent = LANG === 'zh' ? '人' : o.users === 1 ? 'user' : 'users';
  const delta = o.users - o.prevUsers;
  ui.heroDelta.replaceChildren();
  if (o.users || o.prevUsers) {
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
    ui.heroDelta.append(h('span', { class: 'delta ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'), text: sign + fmtInt(Math.abs(delta)) }),
      ' ' + t('vsPrev', { prev: prevText }));
  }
  ui.heroSub.textContent = [t('views', { n: o.sessions }), t('hoursWatched', { h: fmtDuration(o.playSec) })].join(LANG === 'zh' ? '，' : ', ');
  ui.hero.classList.toggle('is-empty', !o.users);
  // A small daily-users spark under the number.
  const maxU = Math.max(1, ...d.days.map((x) => x.users));
  if (ui.heroSpark.children.length !== d.days.length) {
    ui.heroSpark.replaceChildren(...d.days.map(() => h('i')));
    ui.heroSpark.style.setProperty('--n', String(d.days.length));
  }
  [...ui.heroSpark.children].forEach((c, i) => {
    c.style.transitionDelay = animate && MOTION ? 300 + i * 10 + 'ms' : '0ms';
    requestAnimationFrame(() => { c.style.height = Math.max(d.days[i].users ? 8 : 2, (100 * d.days[i].users) / maxU) + '%'; });
    c.classList.toggle('zero', !d.days[i].users);
  });

  // Tiles
  const devs = d.devices.dims;
  const topBrowser = devs.browser[0];
  const topOs = devs.os[0];
  const tl = ui.tiles;
  statusChip(tl.devices.status, d.status.devices);
  if (topBrowser && d.devices.users) {
    tl.devices.value.textContent = t('setupOn', { browser: label('browser', topBrowser.value), os: label('os', topOs.value) });
    // Browser and system are counted separately (how many have both is not known).
    tl.devices.sub.textContent = t('setupShares', { browser: label('browser', topBrowser.value), b: fmtPct((100 * topBrowser.users) / d.devices.users, 0),
      os: label('os', topOs.value), o: fmtPct((100 * topOs.users) / d.devices.users, 0) });
  } else {
    tl.devices.value.textContent = '–';
    tl.devices.sub.textContent = t('status_none');
  }

  const pm = d.performance.metrics;
  statusChip(tl.smooth.status, d.status.smooth);
  if (pm.dropped_pct.n) {
    tl.smooth.value.replaceChildren(h('span', { text: fmtPct(pm.dropped_pct.p50) }), h('small', { text: ' ' + t('droppedFrames') }));
    tl.smooth.sub.textContent = t('inputP90', { v: fmtMs(pm.input_ms90.p50) });
  } else {
    tl.smooth.value.textContent = '–';
    tl.smooth.sub.textContent = t('find_smooth_none', { range: rangeText }).split(/[,，]/)[0];
  }

  const st = d.stability;
  statusChip(tl.errors.status, d.status.errors);
  if (st.sessions) {
    tl.errors.value.replaceChildren(h('span', { text: fmtPct(st.problemPct) }), h('small', { text: ' ' + t('ofViews', { n: st.sessions }) }));
    const top = st.errors[0];
    tl.errors.sub.textContent = top ? t('problemsTop', { what: top.feature + (top.type ? ' ' + top.type : '') }) : st.withProblem ? '' : t('problemsNone');
  } else {
    tl.errors.value.textContent = '–';
    tl.errors.sub.textContent = t('status_none');
  }

  const f = d.features;
  statusChip(tl.features.status, d.status.features);
  const used = f.used.filter((x) => ALL_FEATURES.includes(x.feature)).sort((a, b) => b.users - a.users || b.uses - a.uses);
  if (f.users) {
    tl.features.value.replaceChildren(h('span', { text: t('featuresOf', { used: used.length, total: ALL_FEATURES.length }) }));
    tl.features.sub.textContent = t('featuresTop', { list: used.slice(0, 3).map((x) => featureName(x.feature)).join(LANG === 'zh' ? '、' : ', ') });
  } else {
    tl.features.value.textContent = '–';
    tl.features.sub.textContent = t('status_none');
  }

  const c = d.compat;
  statusChip(tl.compat.status, d.status.compat);
  if (o.sessions + c.fallbacks) {
    tl.compat.value.replaceChildren(h('span', { text: fmtPct(c.fallbackPct) }), h('small', { text: ' ' + t('fallbackShare') }));
    const fresh = c.frontends.filter((x) => x.replaced && x.firstAt >= d.filters.to - 7 * 86400000);
    tl.compat.sub.textContent = fresh.length ? t('compatNew', { n: fresh.length, when: fmtAgo(fresh[0].firstAt, d.generatedAt) }) : t('compatSame');
  } else {
    tl.compat.value.textContent = '–';
    tl.compat.sub.textContent = t('status_none');
  }

  // Nothing at all in this range: say how to see more.
  const nothing = !o.users && !o.sessions;
  ui.notice.hidden = !nothing;
  if (nothing && !d.latestAt) {
    ui.notice.replaceChildren(icon('none'), h('p', { text: t('nothingYet') }));
  } else if (nothing) {
    const actions = [];
    if (state.range !== 90) actions.push(h('button', { class: 'pill-btn', type: 'button', text: t('range_90'), onclick: () => { state.range = 90; prefs.range = 90; savePrefs(); rebuild(); load(); } }));
    if (state.devices === 'others') actions.push(h('button', { class: 'pill-btn', type: 'button', text: t('excludeMine') + ' ✕', onclick: () => { state.devices = 'all'; prefs.devices = 'all'; savePrefs(); ui.exclude.checked = false; load(); } }));
    ui.notice.replaceChildren(icon('none'), h('p', { text: t('noUsersHint') }), ...actions);
  }

  // ---- Users
  if (!o.users) ui.usersSec.finding.textContent = t('find_users_none', { range: rangeText });
  else {
    const usersText = t('users', { n: o.users });
    let s = t('find_users', { users: usersText, range: rangeText, views: t('views', { n: o.sessions }), hours: fmtDuration(o.playSec) });
    if (o.prevUsers || delta) {
      s += ' ' + (delta === 0 ? t('same') + ' ' + prevText + '.' : t('find_users_delta', { delta: t(delta > 0 ? 'more' : 'fewer', { n: fmtInt(Math.abs(delta)) }), prev: prevText }));
    }
    ui.usersSec.finding.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  }
  const anyDays = d.days.some((x) => x.users);
  ui.dailyUsers.update(d.days, o.users < low);
  ui.bDaily.meta(basedOn('users', o.users), o.users > 0 && o.users < low, anyDays ? '' : t('find_users_none', { range: rangeText }));
  ui.versionBars.update(fold(d.versions.map((v) => ({ key: v.version, label: 'v' + v.version, value: v.users })), 6), o.users, o.users < low);
  const s = ui.userStats.vals;
  s.newInRange.textContent = fmtInt(o.newUsers);
  s.watchedShare.textContent = fmtPct(o.watchedPct, 0);
  s.silenceSkipped.textContent = fmtDuration(o.silenceSkippedSec);
  s.keysShare.textContent = o.keys + o.clicks ? fmtPct((100 * o.keys) / (o.keys + o.clicks), 0) : '–';
  ui.bSide.meta(basedOn('users', o.users), o.users > 0 && o.users < low, o.users ? '' : t('status_none'));
  for (const k of ['country', 'region', 'network']) {
    const rows = devs[k].map((x) => ({ key: String(x.value), label: x.value == null ? t('unknown') : x.value, value: x.users }));
    ui.where[k].update(fold(rows, 6), d.devices.users, d.devices.users < low);
    ui.where[k + 'Blk'].meta(basedOn('devices', d.devices.users), d.devices.users > 0 && d.devices.users < low, d.devices.users ? '' : t('status_none'));
  }

  // ---- Devices
  if (!d.devices.users) ui.devicesSec.finding.textContent = t('find_devices_none', { range: rangeText });
  else {
    const touch = devs.form.filter((x) => x.value === 'touch' || x.value === 'phone').reduce((a, x) => a + x.users, 0);
    ui.devicesSec.finding.textContent = t(d.devices.users === 1 ? 'find_devices_one' : 'find_devices', { setup: t('setupOn', { browser: label('browser', topBrowser.value), os: label('os', topOs.value) }), touch: fmtPct((100 * touch) / d.devices.users, 0) });
  }
  for (const [dim, list] of Object.entries(ui.dims)) {
    const rows = devs[dim].map((x) => ({ key: String(x.value), label: label(dim, x.value), value: x.users, muted: x.value == null }));
    list.update(fold(rows, 5), d.devices.users, d.devices.users < low);
  }
  ui.bDevices.meta(basedOn('devices', d.devices.users), d.devices.users > 0 && d.devices.users < low, d.devices.users ? '' : t('find_devices_none', { range: rangeText }));

  // An empty section is just its heading and the sentence saying why.
  const emptySec = (sec, empty) => sec.root.classList.toggle('is-empty', empty);
  emptySec(ui.usersSec, !o.users);
  emptySec(ui.devicesSec, !d.devices.users);
  emptySec(ui.errorsSec, !st.sessions);
  emptySec(ui.featuresSec, !f.users);
  emptySec(ui.compatSec, !(o.sessions + c.fallbacks));
  emptySec(ui.smoothSec, !pm.dropped_pct.n && !Object.keys(d.performance.byVersion).length);

  // ---- Performance
  const perfN = pm.dropped_pct.n;
  const lim = d.limits;
  if (!perfN) ui.smoothSec.finding.textContent = t('find_smooth_none', { range: rangeText });
  else {
    const over = ['dropped_pct', 'input_ms90', 'long_tasks_pm'].filter((m) => pm[m].p50 != null && pm[m].p50 >= lim[m].warn);
    const lvl = d.status.smooth.level;
    ui.smoothSec.finding.textContent = lvl === 'good' || !over.length
      ? t('find_smooth_good', { dropped: fmtPct(pm.dropped_pct.p50), input: fmtMs(pm.input_ms90.p50) })
      : t((lvl === 'bad' ? 'find_smooth_bad' : 'find_smooth_warn') + (over.length > 1 ? '_many' : ''), { what: over.map((m) => t('m_' + m).toLowerCase()).join(LANG === 'zh' ? '、' : ' and ') });
  }
  for (const [m, row] of Object.entries(ui.metrics)) row.update(pm[m], lim[m]);
  ui.bMetrics.meta(basedOn('views', perfN), perfN > 0 && perfN < low, perfN ? '' : t('find_smooth_none', { range: rangeText }));
  const byV = Object.entries(d.performance.byVersion).sort((a, b) => b[0].localeCompare(a[0], 'en', { numeric: true }));
  ui.versionTable.replaceChildren(
    h('thead', null, h('tr', null, h('th', { text: t('versionCol') }), h('th', { text: t('m_dropped_pct') }), h('th', { text: t('m_input_ms90') }), h('th', { text: t('viewingsCol') }))),
    h('tbody', null, ...byV.map(([v, m]) => h('tr', { class: v === state.version ? 'sel' : null },
      h('th', { text: 'v' + v }), h('td', { text: fmtPct(m.dropped_pct ? m.dropped_pct.p50 : null) }), h('td', { text: fmtMs(m.input_ms90 ? m.input_ms90.p50 : null) }),
      h('td', { text: fmtInt(Math.max(...Object.values(m).map((x) => x.n))) })))));
  ui.bVersions.meta(t('median'), false, byV.length ? '' : t('noMeasure'));

  if (perfN && perfN < low) ui.smoothSec.finding.textContent += ' ' + t('fewTail', { n: perfN });

  // ---- Stability
  if (!st.sessions) ui.errorsSec.finding.textContent = t('find_errors_none', { range: rangeText });
  else if (!st.withProblem) ui.errorsSec.finding.textContent = t('find_errors_clean', { range: rangeText });
  else ui.errorsSec.finding.textContent = t('find_errors', { pct: fmtPct(st.problemPct), n: fmtInt(st.withProblem) + ' / ' + fmtInt(st.sessions) });
  if (st.sessions && st.sessions < low) ui.errorsSec.finding.textContent += ' ' + t('fewTail', { n: st.sessions });
  ui.dailyProblems.update(d.days, st.sessions < low);
  ui.bProblems.meta(basedOn('views', st.sessions), st.sessions > 0 && st.sessions < low, st.sessions ? '' : t('find_errors_none', { range: rangeText }));
  const kinds = [
    ['k_uncaught', st.withUncaught], ['k_featureOff', st.withFeatureOff], ['k_stream', st.withStreamError],
    ['k_request', st.withRequestError], ['k_renew', st.renewFail], ['k_send', st.sendFail],
  ].map(([k, v]) => ({ key: k, label: t(k), value: v, muted: !v }));
  ui.kinds.update(kinds, st.sessions, st.sessions < low);
  ui.parts.update(st.problems.slice(0, 8).map((p) => ({ key: p.kind + p.name, label: t('kind_' + p.kind) + ': ' + p.name, value: p.sessions })), st.sessions, st.sessions < low);
  ui.bKinds.meta(basedOn('views', st.sessions), st.sessions > 0 && st.sessions < low, st.sessions ? '' : t('status_none'));
  renderErrors(st.errors, d.generatedAt);
  ui.bErrors.meta(st.errors.length ? basedOn('users', st.errors.reduce((a, e) => Math.max(a, e.users), 0)) : '', false, st.errors.length ? '' : t('noErrors'));

  // ---- Features
  const unused = ALL_FEATURES.filter((x) => !used.some((u) => u.feature === x));
  if (!f.users) ui.featuresSec.finding.textContent = t('find_features_none', { range: rangeText });
  else ui.featuresSec.finding.textContent = t('find_features', { used: used.length, total: ALL_FEATURES.length, unused: unused.length });
  ui.featureBars.update(used.map((x) => ({ key: x.feature, label: featureName(x.feature), value: x.users })), f.users, f.users < low);
  ui.unused.replaceChildren(...unused.map((x) => h('span', { class: 'chip', text: featureName(x) })));
  ui.bFeatures.meta(basedOn('users', f.users), f.users > 0 && f.users < low, f.users ? '' : t('find_features_none', { range: rangeText }));
  ui.changedBars.update(fold(f.changed.map((x) => ({ key: x.setting, label: settingName(x.setting), value: x.users })), 8), f.users, f.users < low);
  ui.bChanged.meta(basedOn('users', f.users), f.users > 0 && f.users < low, !f.users ? t('status_none') : f.changed.length ? '' : t('noneChanged'));
  const speedTotal = f.speeds.reduce((a, x) => a + x.sec, 0);
  ui.speedBars.update(f.speeds.slice().sort((a, b) => Number(a.speed) - Number(b.speed)).map((x) => ({ key: x.speed, label: t('speedX', { v: x.speed }), value: x.sec })), speedTotal, f.users < low);
  ui.bSpeeds.meta(basedOn('users', f.users), f.users > 0 && f.users < low, speedTotal ? '' : t('status_none'));
  const slideTotal = f.slideSources.reduce((a, x) => a + x.sessions, 0);
  ui.slideSrcBars.update(f.slideSources.map((x) => ({ key: x.source, label: t('src_' + x.source), value: x.sessions })), slideTotal, slideTotal < low);
  ui.slideStopBars.update(f.slideStops.map((x) => ({ key: x.reason, label: t('stop_' + x.reason), value: x.sessions })), slideTotal, slideTotal < low);
  ui.slideStopHead.hidden = !f.slideStops.length;
  ui.slideStopBars.root.hidden = !f.slideStops.length;
  ui.bSlides.meta(basedOn('views', slideTotal), slideTotal > 0 && slideTotal < low, slideTotal ? '' : t('noSlideSource'));
  const formTotal = f.slideForms.reduce((a, x) => a + x.sessions, 0);
  const formOrder = ['avcc', 'annexb', 'neither'];
  ui.formBars.update(f.slideForms.slice().sort((a, b) => formOrder.indexOf(a.form) - formOrder.indexOf(b.form)).map((x) => ({
    key: x.form, label: t('formWithUsers', { label: t('form_' + x.form), users: t('users', { n: x.users }) }), value: x.sessions })), formTotal, formTotal < low);
  renderForms(f.slideFormsBySystem);
  ui.bForms.meta(basedOn('views', formTotal), formTotal > 0 && formTotal < low, formTotal ? '' : t('noSlideForm'));

  // ---- Compatibility
  const loads = o.sessions + c.fallbacks;
  const fresh = c.frontends.filter((x) => x.replaced && x.firstAt >= d.filters.from);
  if (!loads) ui.compatSec.finding.textContent = t('find_compat_none', { range: rangeText });
  else {
    let s2 = c.fallbacks ? t('find_compat', { pct: fmtPct(c.fallbackPct), n: fmtInt(c.fallbacks) + ' / ' + fmtInt(loads) }) : t('find_compat_clean', { range: rangeText });
    if (fresh.length) s2 += ' ' + t('find_compat_new', { date: fmtDate(fresh[0].firstAt), fallbacks: t('pageFallbacks', { n: fresh[0].involuntary }) });
    ui.compatSec.finding.textContent = s2.charAt(0).toUpperCase() + s2.slice(1);
  }
  if (loads && loads < low) ui.compatSec.finding.textContent += ' ' + t('fewTail', { n: loads });
  ui.dailyFallbacks.update(d.days, loads < low);
  ui.bFallbacks.meta(basedOn('loads', loads), loads > 0 && loads < low, loads ? '' : t('find_compat_none', { range: rangeText }));
  const chosen = ['user', 'extras', 'attachment'];
  ui.reasonBars.update(c.reasons.map((r) => ({ key: r.reason, label: t('r_' + r.reason) + (chosen.includes(r.reason) ? ' (' + t('chosen') + ')' : ''), value: r.times, muted: chosen.includes(r.reason) })), 0, loads < low);
  ui.bReasons.meta('', false, c.reasons.length ? '' : t('noFallbacks'));
  renderFrontends(c.frontends, d);
  ui.bFrontends.meta('', false, c.frontends.length ? '' : t('noFrontends'));
  const bootTotal = c.boot.reduce((a, b) => a + b.sessions, 0);
  ui.bootBars.update(c.boot.slice().sort((a, b) => b.sessions - a.sessions).map((b) => ({ key: b.path, label: t('boot_' + b.path), value: b.sessions })), bootTotal, bootTotal < low);
  const intercept = c.boot.find((b) => b.path === 'intercept') || c.boot[0];
  ui.bootNote.textContent = intercept && intercept.bootMsP50 != null ? t('bootMedian', { v: fmtMs(intercept.bootMsP50) }) : '';
  ui.bBoot.meta(basedOn('views', bootTotal), bootTotal > 0 && bootTotal < low, bootTotal ? '' : t('status_none'));
}

function renderErrors(list, now) {
  const head = h('div', { class: 'err-row err-head', 'aria-hidden': 'true' },
    ...['errFeature', 'errMessage', 'errTimes', 'errUsers', 'errVersions', 'errLast'].map((k) => h('span', { text: t(k) })));
  ui.errTable.replaceChildren(head, ...list.slice(0, 12).map((e) => h('div', { class: 'err-row' },
    h('span', { class: 'err-feature' }, h('span', { class: 'err-label', text: t('errFeature') }), e.feature),
    h('span', { class: 'err-msg' }, h('b', { text: e.type || '' }), ' ', h('span', { text: e.msg || '' })),
    h('span', { class: 'err-num' }, h('span', { class: 'err-label', text: t('errTimes') }), fmtInt(e.times)),
    h('span', { class: 'err-num' }, h('span', { class: 'err-label', text: t('errUsers') }), fmtInt(e.users)),
    h('span', { class: 'err-ver' }, h('span', { class: 'err-label', text: t('errVersions') }), e.versions.map((v) => 'v' + v).join(', ')),
    h('span', { class: 'err-last' }, h('span', { class: 'err-label', text: t('errLast') }), e.lastAt ? fmtAgo(e.lastAt, now) : '–'))));
}

// Viewings by video form per system and browser version; the forms other than "as sent"
// are what this is for, so they are bold where they occur.
function renderForms(list) {
  const ver = (name, v) => (name == null ? t('unknown') : name + (v ? ' ' + v : ''));
  const num = (v, mark) => h('td', { class: mark && v ? 'hot' : '', text: fmtInt(v) });
  ui.formTable.replaceChildren(
    h('thead', null, h('tr', null, ...['colSystem', 'colAvcc', 'colAnnexb', 'colNeither', 'colUsers'].map((k) => h('th', { scope: 'col', text: t(k) })))),
    h('tbody', null, ...list.slice(0, 15).map((x) => h('tr', null,
      h('th', { scope: 'row' }, ver(x.os, x.osV), h('span', { class: 'cell-sub', text: ver(x.browser, x.browserV) })),
      num(x.avcc), num(x.annexb, true), num(x.neither, true), h('td', { text: fmtInt(x.users) })))));
}

function renderFrontends(list, d) {
  ui.frontends.replaceChildren(...list.map((x, i) => {
    const bad = x.involuntary > 0;
    const newer = x.replaced && x.firstAt >= d.filters.from;
    return h('li', { class: 'tl-item' + (bad ? ' bad' : '') + (newer ? ' new' : '') },
      h('span', { class: 'tl-dot' }, icon(bad ? 'warn' : 'good')),
      h('div', { class: 'tl-main' },
        h('code', { class: 'tl-code', text: x.frontend, title: x.frontend }),
        h('span', { class: 'tl-when', text: t('firstSeen', { when: fmtDate(x.firstAt) }) })),
      h('div', { class: 'tl-nums' },
        h('span', { text: t('pageViews', { v: fmtInt(x.sessions) }) }),
        h('span', { class: bad ? 'tl-bad' : '', text: t('pageFallbacks', { n: x.involuntary }) })));
  }));
}

// ---- Loading ---------------------------------------------------------------------------

async function load() {
  const seq = ++state.seq;
  const q = new URLSearchParams({ range: String(state.range), devices: state.devices, tz: String(-new Date().getTimezoneOffset()) });
  if (state.version !== 'all') q.set('version', state.version);
  document.body.classList.add('busy');
  ui.status.textContent = t('loading');
  try {
    const res = await fetch('/api/summary?' + q, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (seq !== state.seq) return;
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (seq !== state.seq) return;
    const first = !state.data;
    state.data = data;
    ui.status.textContent = '';
    render(data, first);
    if (first) requestAnimationFrame(() => document.body.classList.add('ready'));
  } catch (e) {
    if (seq !== state.seq) return;
    ui.status.replaceChildren(h('span', { text: t('loadFailed', { status: e.message || 'network' }) }), ' ',
      h('button', { class: 'pill-btn', type: 'button', text: t('retry'), onclick: load }));
    document.body.classList.add('ready');
  } finally {
    if (seq === state.seq) document.body.classList.remove('busy');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  ui = build();
  load();
});
