// The usage-data dashboard of Lite Player for Echo360: a read-only Worker behind Cloudflare
// Access. Order of checks for every request, page and data alike:
//   1. configuration complete (auth.js), else 503 and nothing else;
//   2. signed in as an allowed email (auth.js), else 403;
//   3. GET or HEAD only, else 405 (there is no route that changes anything);
//   4. a known path, else 404.
// Responses are never cached, never framed, and carry no CORS headers (only this page may
// read them). Nothing is logged.
import { authorize, readConfig } from './auth.js';
import { parseFilters, summary } from './summary.js';
import { ASSETS } from './assets.gen.js';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function headers(type) {
  return {
    'content-type': type,
    'cache-control': 'no-store, private',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': CSP,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}

function text(status, body) {
  return new Response(body, { status, headers: headers('text/plain; charset=utf-8') });
}

const FILES = {
  '/': ['html', 'text/html; charset=utf-8'],
  '/app.css': ['css', 'text/css; charset=utf-8'],
  '/app.js': ['js', 'text/javascript; charset=utf-8'],
  '/instrument-sans.woff2': ['font', 'font/woff2'],
};

let fontBytes = null;
function asset(key) {
  if (key !== 'font') return ASSETS[key];
  fontBytes ||= Uint8Array.from(atob(ASSETS.font), (c) => c.charCodeAt(0));
  return fontBytes;
}

// `deps.keys` replaces Cloudflare's key set and `deps.now` the clock (tests only).
export async function handle(request, env, ctx, deps = {}) {
  const config = readConfig(env);
  if (!config) return text(503, 'Not configured');
  const email = await authorize(request, config, ctx, deps.keys);
  if (!email) return text(403, 'Forbidden');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const r = text(405, 'Method not allowed');
    r.headers.set('allow', 'GET, HEAD');
    return r;
  }
  const url = new URL(request.url);
  const head = request.method === 'HEAD';
  if (url.pathname === '/api/summary') {
    const now = deps.now ? deps.now() : Date.now();
    const filters = parseFilters(url, now);
    if (!filters) return text(400, 'Bad filters');
    const data = await summary(env.DB, filters, config.owners, now);
    return new Response(head ? null : JSON.stringify(data), { status: 200, headers: headers('application/json; charset=utf-8') });
  }
  const file = Object.hasOwn(FILES, url.pathname) ? FILES[url.pathname] : null;
  if (!file || url.search) return text(404, 'Not found');
  return new Response(head ? null : asset(file[0]), { status: 200, headers: headers(file[1]) });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch {
      // Nothing about the error goes back or into a log.
      return text(500, 'Server error');
    }
  },
};
