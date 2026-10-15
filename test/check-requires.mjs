// Every @require in src/meta.txt must carry a SHA-256 hash (#sha256-<base64>, checked by
// Tampermonkey) that matches the file the CDN serves now, and so must every library file
// loaded when first needed (LIB_SHA256 in src/04-libs.js, hex; the player checks these
// itself). Needs the network (CI runs it).
//   npm run check-requires
//
// Two kinds of failure are told apart: a file that could not be downloaded (no answer, a
// timeout, a server error or rate limit, tried REQUIRE_TRIES times with growing pauses) is
// a network problem and says so; only a file that was downloaded and differs (or that the
// CDN says does not exist) fails the check itself. Either one fails the step: a file that
// could not be checked is not known to be right. Exit code 1: a hash mismatch (or a missing
// hash); 2: only network problems.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REQUIRE_TRIES = 4;                  // attempts per file
const REQUIRE_PAUSE_MS = [2000, 5000, 10000];   // pauses between them
const REQUIRE_TIMEOUT_MS = 30000;         // one attempt; hls.js is about 400 KB

// The files to check: [{ url, want, enc ('base64' | 'hex') }], or { error } for a
// malformed @require.
export function pinnedFiles(meta, libs) {
  const out = [];
  for (const [, line] of meta.matchAll(/^\/\/ @require\s+(\S+)$/gm)) {
    const [url, frag] = line.split('#');
    const want = frag && /^sha256-([A-Za-z0-9+/=]+)$/.exec(frag);
    out.push(want ? { url, want: want[1], enc: 'base64' } : { error: 'no #sha256-<base64> hash: ' + line });
  }
  for (const [, path, want] of libs.matchAll(/^\s*'([^']+)': '([0-9a-f]{64})',$/gm)) {
    out.push({ url: 'https://cdn.jsdelivr.net/npm/' + path, want, enc: 'hex' });
  }
  return out;
}

// One file: { ok } | { mismatch: message } | { network: message }. fetchFn and sleep are
// passed in (tests).
export async function checkFile(file, fetchFn, sleep, tries = REQUIRE_TRIES) {
  let last = '';
  for (let k = 0; k < tries; k++) {
    if (k) await sleep(REQUIRE_PAUSE_MS[Math.min(k - 1, REQUIRE_PAUSE_MS.length - 1)]);
    let buf;
    try {
      const r = await fetchFn(file.url, { signal: AbortSignal.timeout(REQUIRE_TIMEOUT_MS) });
      // Not found (or gone) is an answer about the file, not about the network.
      if (r.status === 404 || r.status === 410) return { mismatch: file.url + ': HTTP ' + r.status + ' (the file is not there)' };
      if (!r.ok) { last = 'HTTP ' + r.status; continue; }
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = (e && e.name === 'TimeoutError') ? 'no answer in ' + REQUIRE_TIMEOUT_MS / 1000 + ' s' : String((e && e.cause && e.cause.code) || (e && e.message) || e);
      continue;
    }
    const got = createHash('sha256').update(buf).digest(file.enc);
    return got === file.want ? { ok: true } : { mismatch: file.url + ': hash ' + got + ', expected ' + file.want };
  }
  return { network: file.url + ': could not be downloaded after ' + tries + ' attempts (' + last + ')' };
}

export async function checkAll(files, fetchFn, sleep, out) {
  let mismatch = 0;
  let network = 0;
  if (!files.some((f) => f.enc === 'base64' || f.error)) { out.error('no @require found'); mismatch++; }
  if (!files.some((f) => f.enc === 'hex')) { out.error('no LIB_SHA256 entry found'); mismatch++; }
  for (const f of files) {
    if (f.error) { out.error(f.error); mismatch++; continue; }
    const r = await checkFile(f, fetchFn, sleep);
    if (r.ok) out.log('ok ' + f.url);
    else if (r.mismatch) { out.error('HASH CHECK FAILED ' + r.mismatch); mismatch++; } else { out.error('NETWORK PROBLEM (not a hash mismatch) ' + r.network); network++; }
  }
  if (network && !mismatch) out.error(network + ' file(s) could not be downloaded: a network problem, not a changed file. Run the check again.');
  return mismatch ? 1 : network ? 2 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const meta = readFileSync(new URL('../src/meta.txt', import.meta.url), 'utf8');
  const libs = readFileSync(new URL('../src/04-libs.js', import.meta.url), 'utf8');
  const code = await checkAll(pinnedFiles(meta, libs), fetch, (ms) => new Promise((r) => setTimeout(r, ms)), console);
  process.exit(code);
}
