// Lite Player for Echo360, the extension's own pages and its bridge: where the player's
// settings are kept, in one place (loaded before bridge.js in the content script, and by the
// toolbar popup and the options page).
//   chrome.storage.local  kv:<name>  the player's settings and saved positions (<name> is its
//                                    page-storage name, lite-player-for-echo360:...)
//   chrome.storage.sync   prefs      the settings that follow the Chrome account: all but
//                                    this device's screen and sound (DEVICE_PREFS)
// eslint-disable-next-line no-redeclare -- declared global for the files that use it (eslint.config.mjs)
const LP = (() => {
  const PREFS = 'lite-player-for-echo360:prefs';
  const KV = 'kv:';
  // Settings of this device, not synced: the layout suits its screen, the volume and quality
  // its speakers and connection.
  const DEVICE_PREFS = ['primary', 'layout', 'ratio', 'pipw', 'corner', 'panel', 'panelw', 'volume', 'muted', 'quality'];

  const parse = (text) => {
    try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; }
  };
  // The synced part of a settings object, as text.
  const synced = (prefs) => {
    const out = {};
    for (const [k, v] of Object.entries(prefs)) if (!DEVICE_PREFS.includes(k)) out[k] = v;
    return JSON.stringify(out);
  };
  // This device's settings text with the synced ones laid over it (changed on another
  // computer since).
  const merged = (localText, syncText) => {
    const fromSync = typeof syncText === 'string' ? parse(syncText) : null;
    if (!fromSync) return localText;
    for (const k of DEVICE_PREFS) delete fromSync[k];
    return JSON.stringify(Object.assign(parse(localText || '') || {}, fromSync));
  };

  // The settings as the player will read them (an object; {} when none were saved yet: the
  // player's defaults apply).
  async function readPrefs() {
    let local = null;
    let sync;
    try { local = (await chrome.storage.local.get(KV + PREFS))[KV + PREFS]; } catch (e) { /* none */ }
    try { sync = (await chrome.storage.sync.get('prefs')).prefs; } catch (e) { /* sync off */ }
    return parse(merged(typeof local === 'string' ? local : '', sync) || '') || {};
  }

  // Changes some settings (the player checks every value when it reads them).
  async function writePrefs(patch) {
    const next = Object.assign(await readPrefs(), patch);
    const text = JSON.stringify(next);
    await chrome.storage.local.set({ [KV + PREFS]: text });
    try { await chrome.storage.sync.set({ prefs: synced(next) }); } catch (e) { /* sync off or over its limits */ }
    return next;
  }

  return { PREFS, KV, DEVICE_PREFS, parse, synced, merged, readPrefs, writePrefs };
})();
