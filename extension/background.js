// Lite Player for Echo360, the extension's service worker:
//   - opens the settings page when the player asks (options.html)
//   - "Add lecture moment" from the toolbar or its shortcut (moment.js)
//   - sends the player's usage data (asked for by the bridge, bridge.js) to the usage-data
//     server, and nothing else
//   - shows "OFF" on the toolbar button while the player is turned off (popup.js)
//   - notes when the extension was installed (the popup's one rating line waits a while),
//     opens the welcome page after an install, and after an update to a new version has
//     the player tell about it once (welcome.html#new)
importScripts('shared.js', 'moment.js');

const SERVER = '{{TELEMETRY_URL}}/';
const MAX_MS = 60000;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // The player's "Open settings page" (backups are made there).
  if (sender.id === chrome.runtime.id && msg && msg.type === 'options') { chrome.runtime.openOptionsPage().catch(() => {}); return false; }
  // The toolbar's "Add lecture moment" (moment.js), for the tab it was opened on.
  if (sender.id === chrome.runtime.id && msg && msg.type === 'moment' && Number.isInteger(msg.tabId)) { addMoment(msg.tabId).then(reply, () => reply(null)); return true; }
  // The player's tips about that shortcut (bridge.js): the one set now, or '' if none.
  if (sender.id === chrome.runtime.id && msg && msg.type === 'momentKey') { momentKey().then(reply); return true; }
  if (sender.id === chrome.runtime.id && msg && msg.type === 'news') { chrome.tabs.create({ url: 'welcome.html#new' }).catch(() => {}); return false; }
  if (sender.id !== chrome.runtime.id || !msg || msg.type !== 'post' || typeof msg.url !== 'string' || !msg.url.startsWith(SERVER) || typeof msg.body !== 'string') return false;
  const ms = Math.min(Math.max(+msg.timeoutMs || 0, 1000), MAX_MS);
  fetch(msg.url, { method: 'POST', body: msg.body, headers: { 'Content-Type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(ms) })
    .then((r) => r.text().then((text) => reply({ status: r.status, text })))
    .catch(() => reply({ status: 0, text: '' }));
  return true;   // answered later
});

function showOff(off) {
  chrome.action.setBadgeText({ text: off ? 'OFF' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#555960' }).catch(() => {});
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.off) showOff(changes.off.newValue === true);
});
chrome.storage.local.get('off').then((o) => showOff(o.off === true), () => {});

// The version whose changes welcome.html#new lists: told once in the player (bridge.js) after
// an update from an older one.
const NEWS = '1.1';
const minor = (v) => String(v || '').split('.').slice(0, 2).map(Number);
const older = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get('installedAt').then((o) => { if (!o.installedAt) chrome.storage.local.set({ installedAt: Date.now() }); }, () => {});
  if (details.reason === 'install') chrome.tabs.create({ url: 'welcome.html' }).catch(() => {});
  else if (details.reason === 'update' && minor(chrome.runtime.getManifest().version).join('.') === NEWS && older(minor(details.previousVersion), minor(NEWS))) {
    chrome.storage.local.set({ news: NEWS }).catch(() => {});
  }
});

// The keyboard shortcut for "Add lecture moment" (manifest commands; changeable at
// chrome://extensions/shortcuts).
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'add-lecture-moment' && tab && tab.id != null) addMoment(tab.id).catch(() => {});
});
