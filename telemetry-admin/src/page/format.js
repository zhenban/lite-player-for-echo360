// Numbers, durations and dates in the page's language.
const locale = () => (LANG === 'zh' ? 'zh-CN' : 'en-AU');

function fmtInt(v) {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Math.round(v));
}
// Compact from 10 000 up (12.9K), whole numbers below.
function fmtCount(v) {
  if (Math.abs(v) < 10000) return fmtInt(v);
  return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}
function fmtPct(v, digits) {
  if (v == null) return '–';
  const d = digits ?? (Math.abs(v) < 10 && v !== 0 && Math.round(v) !== v ? 1 : 0);
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(v) + '%';
}
function fmtMs(v) {
  if (v == null) return '–';
  if (v < 1000) return fmtInt(v) + ' ms';
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: v < 10000 ? 1 : 0 }).format(v / 1000) + ' s';
}
function fmtMb(v) {
  return v == null ? '–' : fmtInt(v) + ' MB';
}
function fmtRate(v) {
  return v == null ? '–' : new Intl.NumberFormat(locale(), { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v);
}
// Playback time: minutes under an hour, then hours.
function fmtDuration(sec) {
  if (!sec) return LANG === 'zh' ? '0 分钟' : '0 min';
  const nf = new Intl.NumberFormat(locale(), { maximumFractionDigits: sec < 36000 ? 1 : 0 });
  if (sec < 3600) return fmtInt(Math.max(1, sec / 60)) + (LANG === 'zh' ? ' 分钟' : ' min');
  return nf.format(sec / 3600) + (LANG === 'zh' ? ' 小时' : ' h');
}
function fmtDay(isoDay, opts) {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }).format(Date.UTC(y, m - 1, d));
}
function fmtDate(ms) {
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
}
function fmtTime(ms) {
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(ms);
}
function fmtAgo(ms, now) {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  // Rows are stamped by the telemetry Worker's clock; a little ahead of this one reads as now.
  const diff = Math.min(0, ms - now);
  const min = Math.round(diff / 60000);
  if (Math.abs(min) < 60) return rtf.format(min, 'minute');
  const hours = Math.round(diff / 3600000);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(diff / 86400000), 'day');
}
// A metric's value in its unit.
function fmtMetric(metric, v) {
  if (v == null) return '–';
  if (metric.endsWith('_pct') || metric.startsWith('cpu_')) return fmtPct(v);
  if (metric.endsWith('_mb')) return fmtMb(v);
  if (metric === 'long_tasks_pm') return fmtRate(v);
  return fmtMs(v);
}
