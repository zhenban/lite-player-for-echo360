// The page's lists of features and settings match what the telemetry Worker accepts, and
// every text has both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FEATURES, PREFS } from '../../telemetry-worker/src/schema.js';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../src/page/i18n.js', import.meta.url), 'utf8') + '\n;globalThis.out = { STRINGS, FEATURE_NAMES, SETTING_NAMES };', ctx);
const { STRINGS, FEATURE_NAMES, SETTING_NAMES } = ctx.out;

test('feature and setting names cover exactly the Worker\'s lists, in both languages', () => {
  for (const lang of ['en', 'zh']) {
    assert.deepEqual(Object.keys(FEATURE_NAMES[lang]).sort(), [...FEATURES].sort(), lang + ' features');
    assert.deepEqual(Object.keys(SETTING_NAMES[lang]).sort(), [...PREFS].sort(), lang + ' settings');
  }
});

test('every slide source and stop reason the Worker accepts has a name', () => {
  // As in telemetry-worker/src/schema.js (slideSrc, slideStop).
  const values = { src: ['frames', 'thumbs', 'none'], stop: ['noWebCodecs', 'noFrame', 'decoder', 'playlist', 'network', 'other'] };
  for (const lang of ['en', 'zh']) {
    for (const [prefix, list] of Object.entries(values)) for (const v of list) assert.ok(STRINGS[lang][prefix + '_' + v], lang + ' ' + prefix + '_' + v);
  }
});

test('every English text has a Chinese one', () => {
  const base = (k) => k.replace(/_(one|other)$/, '');
  const zh = new Set(Object.keys(STRINGS.zh).map(base));
  const missing = [...new Set(Object.keys(STRINGS.en).map(base))].filter((k) => !zh.has(k) && STRINGS.en[k] !== '');
  assert.deepEqual(missing, []);
});
