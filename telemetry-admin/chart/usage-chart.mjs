// The public usage chart for the main README: daily active users over the last 90 days and
// two totals, drawn as SVG (one for GitHub's light theme, one for dark). Run daily by
// .github/workflows/usage-chart.yml, which publishes the files on the `stats` branch.
//
// Only totals leave the database: a count of distinct users per day, in the last 30 days and
// in all. The statements are fixed and pass the dashboard's read-only check (compile() in
// src/queries.js); the API token it runs with can only read D1.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_D1_TOKEN=... node chart/usage-chart.mjs <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compile } from '../src/queries.js';

const DAY = 86400000;
export const DAYS = 90;

// Someone is active on a day when the player sent anything for them: a viewing or the
// device report (the dashboard's "Active users" counts the same way, plus errors and
// fallbacks, which always come with one of these).
const ACTIVE = `SELECT uid, at FROM sessions WHERE at >= $from AND at < $to
  UNION ALL SELECT uid, at FROM env WHERE at >= $from AND at < $to`;
export const STATEMENTS = Object.freeze({
  daily: compile('daily', `
SELECT date(a.at / 1000, 'unixepoch') AS day, COUNT(DISTINCT a.uid) AS users
FROM (${ACTIVE}) a GROUP BY day ORDER BY day`),
  totals: compile('totals', `
SELECT (SELECT COUNT(DISTINCT a.uid) FROM (${ACTIVE}) a WHERE a.at >= $month) AS month,
       (SELECT COUNT(DISTINCT uid) FROM (SELECT uid FROM sessions UNION SELECT uid FROM env)) AS ever,
       (SELECT MIN(at) FROM env) AS first_at`),
});

// Days are UTC days; `to` is the end of today (UTC).
export function range(now) {
  const to = Math.floor(now / DAY) * DAY + DAY;
  return { from: to - DAYS * DAY, to, month: to - 30 * DAY };
}

async function query(account, db, token, stmt, values) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: stmt.sql, params: stmt.params.map((p) => String(values[p])) }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.success) {
    // The API's error codes and messages, never the request (it carries the token).
    const why = body && body.errors ? body.errors.map((e) => e.code + ' ' + e.message).join('; ') : 'HTTP ' + res.status;
    throw new Error('D1 query ' + stmt.name + ' failed: ' + why);
  }
  return body.result[0].results;
}

export async function fetchUsage({ account, db, token, now }) {
  const w = range(now);
  const daily = await query(account, db, token, STATEMENTS.daily, w);
  const [t] = await query(account, db, token, STATEMENTS.totals, w);
  return toUsage(daily, t, now);
}

// Every day of the window, with zeros where nobody was active.
export function toUsage(daily, totals, now) {
  const w = range(now);
  const byDay = new Map(daily.map((d) => [d.day, Number(d.users) || 0]));
  const days = [];
  for (let t = w.from; t < w.to; t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    days.push({ day, users: byDay.get(day) || 0 });
  }
  return {
    days, month: Number(totals?.month) || 0, ever: Number(totals?.ever) || 0,
    firstAt: totals?.first_at == null ? null : Number(totals.first_at), updatedAt: now,
  };
}

// Colours of the dashboard, for GitHub's white and near-black page backgrounds.
const THEMES = {
  light: { ink: '#16202e', ink2: '#455163', muted: '#6d7889', grid: '#e3e8ee', series: '#3858d6' },
  dark: { ink: '#e7ecf3', ink2: '#b4bfcd', muted: '#8692a4', grid: '#262f3d', series: '#6a85f2' },
};
const W = 760;
const H = 260;
const PLOT = { left: 40, right: W - 16, top: 104, bottom: H - 34 };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtDay = (iso) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.parse(iso + 'T00:00:00Z'));
const fmtDate = (ms) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(ms);
const plural = (n, one, many) => n.toLocaleString('en-AU') + ' ' + (n === 1 ? one : many);

// A rounded-top column from the baseline (radius at most half its width or its height).
function column(x, y, w, h) {
  const r = Math.min(2, w / 2, h);
  const b = y + h;
  return `M${x} ${b}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${b}Z`;
}

// A "nice" top for the y axis: 1, 2, 2.5, 5, 10, 20, 25, 50... at or above the busiest day.
function niceMax(v) {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

export function renderSvg(usage, theme) {
  const c = THEMES[theme];
  const n = usage.days.length;
  const top = niceMax(Math.max(0, ...usage.days.map((d) => d.users)));
  const step = (PLOT.right - PLOT.left) / n;
  const bw = Math.max(1, step - 2); // a 2px gap between columns
  const y = (v) => PLOT.bottom - (v / top) * (PLOT.bottom - PLOT.top);
  const r1 = (v) => Math.round(v * 10) / 10;

  const cols = usage.days.map((d, i) => d.users > 0
    ? `<path d="${column(r1(PLOT.left + i * step + 1), r1(y(d.users)), r1(bw), r1(PLOT.bottom - y(d.users)))}"/>` : '').join('');
  const ticks = [0, top / 2, top].filter((v, i, a) => Number.isInteger(v) && a.indexOf(v) === i);
  const grid = ticks.map((v) => `<line x1="${PLOT.left}" x2="${PLOT.right}" y1="${r1(y(v))}" y2="${r1(y(v))}"/>`).join('');
  const yLabels = ticks.map((v) => `<text x="${PLOT.left - 8}" y="${r1(y(v) + 4)}" text-anchor="end">${v}</text>`).join('');
  const xAt = [0, Math.floor(n / 2), n - 1];
  const xLabels = xAt.map((i, k) => `<text x="${r1(PLOT.left + i * step + step / 2)}" y="${H - 12}" text-anchor="${['start', 'middle', 'end'][k]}">${esc(fmtDay(usage.days[i].day))}</text>`).join('');

  const headline = plural(usage.month, 'user', 'users');
  const since = usage.firstAt != null ? `, ${plural(usage.ever, 'user', 'users')} since ${fmtDate(usage.firstAt)}` : '';
  const sub = `in the last 30 days${since}`;
  const desc = `Lite Player for Echo360: ${headline} ${sub}. Daily active users over the last ${n} days.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">Lite Player for Echo360 users</title>
<desc id="d">${esc(desc)}</desc>
<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;fill:${c.muted};font-size:12px}.h{fill:${c.ink};font-size:34px;font-weight:600}.s{fill:${c.ink2};font-size:14px}.l{fill:${c.ink};font-size:14px;font-weight:600}</style>
<text class="l" x="${PLOT.left}" y="26">Active users</text>
<text class="h" x="${PLOT.left}" y="66">${esc(headline)}</text>
<text class="s" x="${PLOT.left}" y="88">${esc(sub)}</text>
<text x="${PLOT.right}" y="26" text-anchor="end">Daily, last ${n} days (UTC). Updated ${esc(fmtDate(usage.updatedAt))}</text>
<g stroke="${c.grid}" stroke-width="1">${grid}</g>
<g fill="${c.series}">${cols}</g>
${yLabels}${xLabels}
</svg>
`;
}

// Writes usage-light.svg and usage-dark.svg into outDir.
export function writeCharts(usage, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const theme of Object.keys(THEMES)) writeFileSync(`${outDir}/usage-${theme}.svg`, renderSvg(usage, theme));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const outDir = process.argv[2];
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_D1_TOKEN;
  const db = /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'))?.[1];
  if (!outDir || !account || !token || !db) {
    console.error('Usage: CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_D1_TOKEN=... node chart/usage-chart.mjs <out-dir>');
    process.exit(2);
  }
  const usage = await fetchUsage({ account, db, token, now: Date.now() });
  writeCharts(usage, outDir);
  console.log(`Wrote charts: ${usage.month} users in the last 30 days, ${usage.ever} in all.`);
}
