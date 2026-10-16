// Building blocks: an element helper (text always as textContent), status icons, the shared
// tooltip, and three chart kinds that update in place so filter changes move bars and
// numbers instead of redrawing: a daily column chart, a list of horizontal bars, and a
// row showing a measure's median and slowest 10% against its limit.
const MOTION = !matchMedia('(prefers-reduced-motion: reduce)').matches;
const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
function clear(node) { node.replaceChildren(); return node; }

// Status icons: shape and label carry the state, colour only repeats it.
const ICONS = {
  good: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm3 4.3-3.9 4-2-2',
  warn: 'M8 2 14.5 13.5h-13L8 2Zm0 4.3v3.4m0 1.8v.1',
  bad: 'M5.3 1.5h5.4l3.8 3.8v5.4l-3.8 3.8H5.3l-3.8-3.8V5.3l3.8-3.8Zm.6 4.4 4.2 4.2m0-4.2-4.2 4.2',
  none: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Z',
  info: 'M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z',
};
function icon(level) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon icon-' + level);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ICONS[level] || ICONS.none);
  svg.append(p);
  return svg;
}
function glyph(d, cls) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('class', cls || 'glyph');
  svg.setAttribute('aria-hidden', 'true');
  for (const part of [].concat(d)) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', part);
    svg.append(p);
  }
  return svg;
}

// Counts a number up (or across) to its new value; reduced motion sets it at once.
const tweens = new WeakMap();
function tweenNumber(node, to, format, duration = 700) {
  const from = tweens.has(node) ? tweens.get(node).value : 0;
  const prev = tweens.get(node);
  if (prev && prev.raf) cancelAnimationFrame(prev.raf);
  const state = { value: from, raf: 0 };
  tweens.set(node, state);
  if (!MOTION || from === to || typeof to !== 'number') {
    state.value = to;
    node.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / duration);
    const e = 1 - Math.pow(1 - k, 3);
    state.value = from + (to - from) * e;
    node.textContent = format(k < 1 && Number.isInteger(to) ? Math.round(state.value) : state.value);
    if (k < 1) state.raf = requestAnimationFrame(step);
    else { state.value = to; node.textContent = format(to); }
  };
  state.raf = requestAnimationFrame(step);
}

// The one tooltip: rows of [value, label], value first.
const tip = {
  node: null,
  show(rows, title, x, y) {
    if (!this.node) {
      this.node = h('div', { class: 'tooltip', role: 'tooltip' });
      document.body.append(this.node);
    }
    clear(this.node).append(h('div', { class: 'tip-title', text: title }),
      ...rows.map(([v, label]) => h('div', { class: 'tip-row' }, h('span', { class: 'tip-key' }), h('b', { text: v }), h('span', { text: label }))));
    this.node.classList.add('on');
    const r = this.node.getBoundingClientRect();
    const left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8);
    const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
    this.node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  },
  hide() { if (this.node) this.node.classList.remove('on'); },
};

// A round upper bound for an axis: 1, 2, 5 times a power of ten (small counts exactly).
function niceMax(v) {
  if (v <= 0) return 1;
  if (v <= 5 && Number.isInteger(v)) return v;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Daily columns. `opts`: value(day) -> number, rows(day) -> tooltip rows, label (aria),
// table: [[header, (day) -> text], ...] for the table view.
function columnChart(opts) {
  const plot = h('div', { class: 'cols-plot', tabindex: '0', role: 'img' });
  const grid = h('div', { class: 'cols-grid', 'aria-hidden': 'true' });
  const bars = h('div', { class: 'cols-bars', 'aria-hidden': 'true' });
  const axis = h('div', { class: 'cols-axis', 'aria-hidden': 'true' });
  plot.append(grid, bars);
  const table = h('table', { class: 'data-table', hidden: true });
  const root = h('div', { class: 'cols' }, plot, axis, table);
  let days = [];
  let active = -1;
  let cols = [];

  function point(i) {
    const c = cols[i];
    if (!c) return;
    cols.forEach((x, j) => x.classList.toggle('on', j === i));
    const r = c.getBoundingClientRect();
    tip.show(opts.rows(days[i]), fmtDay(days[i].day, { weekday: 'short' }), r.left + r.width / 2, plot.getBoundingClientRect().top + 4);
  }
  function leave() { active = -1; cols.forEach((x) => x.classList.remove('on')); tip.hide(); }
  plot.addEventListener('pointermove', (e) => {
    if (!days.length) return;
    const r = bars.getBoundingClientRect();
    const i = Math.max(0, Math.min(days.length - 1, Math.floor(((e.clientX - r.left) / r.width) * days.length)));
    if (i !== active) { active = i; point(i); }
  });
  plot.addEventListener('pointerleave', leave);
  plot.addEventListener('blur', leave);
  plot.addEventListener('focus', () => { if (days.length) { active = days.length - 1; point(active); } });
  plot.addEventListener('keydown', (e) => {
    if (!days.length) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      active = e.key === 'Home' ? 0 : e.key === 'End' ? days.length - 1 : Math.max(0, Math.min(days.length - 1, active + (e.key === 'ArrowLeft' ? -1 : 1)));
      point(active);
    } else if (e.key === 'Escape') leave();
  });

  function update(next, low) {
    const sameDays = next.length === days.length && next.every((d, i) => d.day === days[i].day);
    days = next;
    const values = days.map(opts.value);
    const max = niceMax(Math.max(0, ...values));
    root.classList.toggle('low', !!low);
    plot.setAttribute('aria-label', opts.label() + ': ' + days.map((d, i) => fmtDay(d.day) + ' ' + values[i]).join(', '));
    // Gridlines at 0, half and the top, labelled.
    clear(grid);
    // The middle line only when it is a whole number (no "12.5 users").
    const ticks = max <= 2 || !Number.isInteger(max / 2) ? [0, max] : [0, max / 2, max];
    for (const v of ticks) {
      grid.append(h('div', { class: 'cols-line' + (v === 0 ? ' base' : ''), style: { bottom: (100 * v) / max + '%' } },
        h('span', { text: Number.isInteger(v) ? fmtCount(v) : fmtRate(v) })));
    }
    if (!sameDays) {
      clear(bars);
      cols = days.map(() => {
        const c = h('span', { class: 'col' }, h('i'));
        bars.append(c);
        return c;
      });
      bars.style.setProperty('--n', String(days.length));
      // New columns grow from the baseline.
      cols.forEach((c) => { c.firstChild.style.height = '0%'; });
      void bars.offsetHeight;
    }
    cols.forEach((c, i) => {
      c.firstChild.style.transitionDelay = MOTION && !sameDays ? Math.min(i * 12, 400) + 'ms' : '0ms';
      c.firstChild.style.height = (100 * values[i]) / max + '%';
      c.classList.toggle('zero', values[i] === 0);
    });
    // First, middle and last day under the axis.
    clear(axis);
    if (days.length) {
      const marks = days.length > 2 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : [0, days.length - 1];
      for (const i of [...new Set(marks)]) {
        axis.append(h('span', { text: fmtDay(days[i].day), style: { left: ((i + 0.5) / days.length) * 100 + '%' } }));
      }
    }
    // The same numbers as a table.
    clear(table).append(
      h('thead', null, h('tr', null, h('th', { text: '' }), ...opts.table.map(([head]) => h('th', { text: head() })))),
      h('tbody', null, ...days.slice().reverse().map((d) => h('tr', null, h('th', { text: fmtDay(d.day, { weekday: 'short' }) }),
        ...opts.table.map(([, cell]) => h('td', { text: cell(d) }))))),
    );
  }
  function showTable(on) { plot.hidden = on; axis.hidden = on; table.hidden = !on; }
  return { root, update, showTable };
}

// Horizontal bars, one per row, keyed so a filter change slides the bars. rows: [{ key,
// label, value, note? }], total: what 100% is (the share shown), max: longest bar's value.
function barList(opts = {}) {
  const root = h('ol', { class: 'bars' + (opts.compact ? ' compact' : '') + (opts.stacked ? ' stacked' : '') });
  const items = new Map();
  function update(rows, total, low) {
    root.classList.toggle('low', !!low);
    const max = Math.max(1, ...rows.map((r) => r.value));
    const seen = new Set();
    rows.forEach((r, i) => {
      seen.add(r.key);
      let it = items.get(r.key);
      if (!it) {
        const fill = h('span', { class: 'bar-fill' });
        const value = h('span', { class: 'bar-val' });
        const share = h('span', { class: 'bar-pct' });
        const label = h('span', { class: 'bar-label' });
        const node = h('li', { class: 'bar-row' }, label, h('span', { class: 'bar-track' }, fill), value, share);
        fill.style.width = '0%';
        it = { node, fill, value, share, label };
        items.set(r.key, it);
      }
      it.label.textContent = r.label;
      it.label.title = r.label;
      it.node.classList.toggle('muted', !!r.muted);
      it.value.textContent = opts.format ? opts.format(r.value) : fmtCount(r.value);
      it.share.textContent = total ? fmtPct((100 * r.value) / total, 0) : '';
      if (root.children[i] !== it.node) root.insertBefore(it.node, root.children[i] || null);
      const w = (100 * r.value) / max;
      it.fill.style.transitionDelay = MOTION ? Math.min(i * 30, 300) + 'ms' : '0ms';
      requestAnimationFrame(() => { it.fill.style.width = w + '%'; });
    });
    for (const [k, it] of items) if (!seen.has(k)) { it.node.remove(); items.delete(k); }
  }
  return { root, update };
}

// Folds rows past `most` into one "Other" row.
function fold(rows, most) {
  if (rows.length <= most) return rows;
  const rest = rows.slice(most - 1);
  return [...rows.slice(0, most - 1), { key: '__other', label: t('other'), value: rest.reduce((a, r) => a + r.value, 0), muted: true }];
}

// One measure: its median (dot) and slowest 10% (end of the line), on a scale that keeps
// the limit in view.
function metricRow(metric) {
  const name = h('span', { class: 'm-name' });
  const status = h('span', { class: 'm-status' });
  const span = h('span', { class: 'm-span' });
  const dot = h('span', { class: 'm-dot' });
  const limit = h('span', { class: 'm-limit' });
  const track = h('div', { class: 'm-track', 'aria-hidden': 'true' }, limit, span, dot);
  const p50 = h('b', { class: 'm-p50' });
  const p90 = h('span', { class: 'm-p90' });
  const vals = h('div', { class: 'm-vals' }, p50, p90);
  const root = h('div', { class: 'metric' }, h('div', { class: 'm-head' }, status, name), track, vals);
  function update(m, lim) {
    name.textContent = t('m_' + metric);
    const none = !m || !m.n || m.p50 == null;
    root.classList.toggle('empty', none);
    clear(status);
    if (none) {
      p50.textContent = t('noMeasure');
      p90.textContent = '';
      span.style.width = '0%';
      dot.style.left = '0%';
      limit.hidden = true;
      return;
    }
    const top = Math.max(m.p90 ?? m.p50, lim ? lim.bad : 0, m.p50) * 1.15 || 1;
    const x50 = (100 * m.p50) / top;
    const x90 = (100 * (m.p90 ?? m.p50)) / top;
    requestAnimationFrame(() => {
      dot.style.left = x50 + '%';
      span.style.left = x50 + '%';
      span.style.width = Math.max(0, x90 - x50) + '%';
    });
    limit.hidden = !lim;
    if (lim) {
      limit.style.left = (100 * lim.warn) / top + '%';
      limit.title = t('limit', { v: fmtMetric(metric, lim.warn) });
      const lvl = m.p50 >= lim.bad ? 'bad' : m.p50 >= lim.warn ? 'warn' : 'good';
      status.append(icon(lvl));
      root.dataset.level = lvl;
    } else {
      delete root.dataset.level;
    }
    p50.textContent = fmtMetric(metric, m.p50);
    p90.textContent = t('p90Is', { v: fmtMetric(metric, m.p90) });
  }
  return { root, update };
}
