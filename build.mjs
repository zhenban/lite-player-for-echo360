// Builds dist/lite-player-for-echo360.user.js from src/ by plain concatenation, so the published file
// stays readable (Greasy Fork does not accept minified or obfuscated code).
//
//   node build.mjs                      the userscript
//   node build.mjs --target extension   the Chrome extension: dist-extension/ and
//                                       dist-extension.zip (the same player, with
//                                       06-platform-extension.js; files in extension/);
//                                       --dev: with the test hooks, never to be released
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, 'src');

// Source code stays English-only; translated UI strings live in their own files
// (01-lang-<code>.js), the only ones allowed to hold CJK text.
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const LANG_FILE = /^01-lang-[a-z]+\.js$/;

// Only in the extension's build: the platform parts of the extension.
const EXTENSION_ONLY = '06-platform-extension.js';

// The whole userscript as one string (the tests use it too, to run the player in a
// simulated page). Returns null after reporting what is wrong. dev: with the test hooks
// (DEV_HOOKS), which a built script never has. target 'extension': the player of the
// extension (no userscript header; with EXTENSION_ONLY).
export function assemble({ dev = false, target = 'userscript' } = {}) {
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  const all = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
  const files = target === 'extension' ? all : all.filter((f) => f !== EXTENSION_ONLY);
  let failed = false;
  const parts = files.map((f) => {
    const text = readFileSync(join(srcDir, f), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (!LANG_FILE.test(f) && CJK.test(line)) { console.error(`${f}:${i + 1}: CJK characters in source`); failed = true; }
    });
    return `// ---- ${f} ----\n${text.trimEnd()}\n`;
  });
  // A file named in a comment (NN-name.js) must exist: names went stale before.
  for (const f of files) {
    for (const m of readFileSync(join(srcDir, f), 'utf8').matchAll(/\b(\d\d-[a-z0-9-]+\.js)\b/g)) {
      if (!all.includes(m[1])) { console.error(`${f}: names ${m[1]}, which does not exist`); failed = true; }
    }
  }
  // What depends on how the player is run goes through `platform` (05-platform.js), so that
  // an extension can provide its own. Echo360's own sign-in token lives in the page's
  // storage whatever runs the player, so the reporter reads it there.
  const PLATFORM_ONLY = [[/\blocalStorage\b/, 'localStorage'], [/\bindexedDB\b/, 'indexedDB'], [/\bimport\(/, 'import()'], [/\bGM_\w+/, 'GM_ functions'], [/\bunsafeWindow\b/, 'unsafeWindow'], [/(?<![.\w])Hls\b/, 'Hls']];
  // 00-boot.js finds the page's window itself: its trap is set before `platform` exists.
  const PLATFORM_ALLOWED = { '05-platform.js': /./, '20-reporter.js': /^localStorage$/, '00-boot.js': /^unsafeWindow$/ };
  for (const f of files) {
    readFileSync(join(srcDir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const [re, what] of PLATFORM_ONLY) {
        if (re.test(line) && !(PLATFORM_ALLOWED[f] && PLATFORM_ALLOWED[f].test(what))) { console.error(`${f}:${i + 1}: uses ${what} directly; go through platform (05-platform.js)`); failed = true; }
      }
    });
  }
  if (failed) return null;
  const meta =readFileSync(join(srcDir, 'meta.txt'), 'utf8').replace('{{VERSION}}', version).trimEnd();
  // The pages the script is loaded on (@match) and those it acts on (SITE_HOSTS) must agree.
  const matched = [...new Set([...meta.matchAll(/^\/\/ @match\s+https:\/\/([^/]+)\//gm)].map((m) => m[1]))].sort();
  const sites = JSON.parse(/const SITE_HOSTS = (\[[^\]]*\]);/.exec(readFileSync(join(srcDir, '03-common.js'), 'utf8'))[1].replace(/'/g, '"')).sort();
  if (JSON.stringify(matched) !== JSON.stringify(sites)) {
    console.error('meta.txt @match hosts ' + matched.join(', ') + ' differ from SITE_HOSTS ' + sites.join(', '));
    return null;
  }
  // The one host the script sends to (@connect) is the telemetry Worker's.
  const connect = [...meta.matchAll(/^\/\/ @connect\s+(\S+)$/gm)].map((m) => m[1]);
  const worker = /const TELEMETRY_URL = 'https:\/\/([^/']+)'/.exec(readFileSync(join(srcDir, '87-telemetry.js'), 'utf8'));
  if (!worker || connect.length !== 1 || connect[0] !== worker[1]) {
    console.error('meta.txt @connect (' + connect.join(', ') + ') must be exactly the host of TELEMETRY_URL (' + (worker ? worker[1] : 'not found') + ')');
    return null;
  }
  const header = target === 'extension' ? `// Lite Player for Echo360 ${version}, the Chrome extension's player (built from src/ by build.mjs).` : meta;
  const out = `${header}

/* global Hls */
(function () {
  'use strict';

  const VERSION = '${version}';
  const DEV_HOOKS = ${dev ? 'true' : 'false'};

${parts.join('\n')}
})();
`;
  // The concatenation must be valid JavaScript (each file alone can be, while the joined
  // script is not): compile it before writing anything.
  try {
    new vm.Script(out, { filename: 'lite-player-for-echo360.user.js' });
  } catch (e) {
    console.error('build failed: the joined script does not compile:', e.message);
    return null;
  }
  return { out, version, count: files.length };
}

// The extension's files, without the libraries (the tests use it too): { manifest, files:
// { name: text }, icons: [file names in extension/], libs: { npm path: SHA-256 } } or null.
// dev: with the test hooks (DEV_HOOKS), for dev/extension-check.mjs only.
export function extensionFiles({ dev = false } = {}) {
  const r = assemble({ target: 'extension', dev });
  if (!r) return null;
  const extDir = join(root, 'extension');
  const meta = readFileSync(join(srcDir, 'meta.txt'), 'utf8');
  const matches = [...meta.matchAll(/^\/\/ @match\s+(\S+)$/gm)].map((m) => m[1]);
  const sites = [...new Set(matches.map((m) => new URL(m.replace(/\*/g, 'x')).origin + '/*'))];
  const telemetry = /const TELEMETRY_URL = '([^']+)'/.exec(readFileSync(join(srcDir, '87-telemetry.js'), 'utf8'))[1];
  const fill = (text) => text.replace(/\{\{VERSION\}\}/g, r.version)
    .replace(/\{\{TELEMETRY_URL\}\}/g, telemetry).replace(/"\{\{MATCHES\}\}"/g, JSON.stringify(matches)).replace(/"\{\{SITES\}\}"/g, JSON.stringify(sites));
  const manifest = JSON.parse(fill(readFileSync(join(extDir, 'manifest.json'), 'utf8')));
  const files = { 'manifest.json': JSON.stringify(manifest, null, 2) + '\n', 'player.js': r.out };
  for (const f of ['bridge.js', 'background.js']) files[f] = fill(readFileSync(join(extDir, f), 'utf8'));
  // The name and store summary in each language of the store listing (Chrome picks one).
  for (const lang of readdirSync(join(extDir, '_locales'))) {
    const f = '_locales/' + lang + '/messages.json';
    files[f] = JSON.stringify(JSON.parse(readFileSync(join(extDir, f), 'utf8')), null, 2) + '\n';
  }
  const icons = readdirSync(extDir).filter((f) => /^icon-\d+\.png$/.test(f));
  // The shipped libraries: those 06-platform-extension.js serves from the package.
  const shipped = new RegExp(/const EXT_SHIPPED = \/(.+)\/;/.exec(readFileSync(join(srcDir, EXTENSION_ONLY), 'utf8'))[1]);
  const pinned = [...readFileSync(join(srcDir, '04-libs.js'), 'utf8').matchAll(/^\s+'([^']+)': '([0-9a-f]{64})',$/gm)];
  const libs = Object.fromEntries(pinned.filter((m) => shipped.test(m[1])).map((m) => [m[1], m[2]]));
  return { manifest, files, icons, libs, version: r.version };
}

// The extension: dist-extension/ (load it unpacked) and dist-extension.zip (for the store).
// The library files are shipped (Manifest V3 runs no code from elsewhere): fetched once from
// the CDN into .lib-cache/ and used only if they match their pinned SHA-256 (04-libs.js).
export async function buildExtension({ dev = false } = {}) {
  const x = extensionFiles({ dev });
  if (!x) return null;
  const extDir = join(root, 'extension');
  const out = join(root, 'dist-extension');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(x.files)) { mkdirSync(dirname(join(out, name)), { recursive: true }); writeFileSync(join(out, name), text); }
  for (const f of x.icons) copyFileSync(join(extDir, f), join(out, f));
  const cache = join(root, '.lib-cache');
  for (const [path, hash] of Object.entries(x.libs)) {
    const cached = join(cache, hash);
    if (!existsSync(cached)) {
      const res = await fetch('https://cdn.jsdelivr.net/npm/' + path);
      if (!res.ok) { console.error('HTTP ' + res.status + ' for ' + path); return null; }
      mkdirSync(cache, { recursive: true });
      writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
    }
    const bytes = readFileSync(cached);
    if (createHash('sha256').update(bytes).digest('hex') !== hash) { rmSync(cached); console.error('not the pinned file: ' + path); return null; }
    mkdirSync(dirname(join(out, 'lib', path)), { recursive: true });
    writeFileSync(join(out, 'lib', path), bytes);
  }
  const zip = join(root, 'dist-extension.zip');
  rmSync(zip, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: out });
  return { version: x.manifest.version, dir: out, zip };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--target')) {
  const target = process.argv[process.argv.indexOf('--target') + 1];
  if (target !== 'extension') { console.error('unknown target: ' + target); process.exit(1); }
  const dev = process.argv.includes('--dev');
  const r = await buildExtension({ dev });
  if (!r) process.exit(1);
  console.log(`built dist-extension/ and dist-extension.zip, ${r.version}` + (dev ? ', WITH TEST HOOKS: not for release' : ''));
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = assemble();
  if (!r) process.exit(1);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'lite-player-for-echo360.user.js'), r.out);
  console.log(`built dist/lite-player-for-echo360.user.js v${r.version} (${r.count} modules, ${r.out.length} bytes)`);
}
