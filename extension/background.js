// Lite Player for Echo360, the extension's service worker:
//   - opens the settings page when the player asks (options.html)
//   - sends the player's usage data (asked for by the bridge, bridge.js) to the usage-data
//     server, and nothing else
//   - shows "OFF" on the toolbar button while the player is turned off (popup.js)
//   - notes when the extension was installed (the popup's one rating line waits a while)
const SERVER = '{{TELEMETRY_URL}}/';
const MAX_MS = 60000;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // The player's "Open settings page" (backups are made there).
  if (sender.id === chrome.runtime.id && msg && msg.type === 'options') { chrome.runtime.openOptionsPage().catch(() => {}); return false; }
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('installedAt').then((o) => { if (!o.installedAt) chrome.storage.local.set({ installedAt: Date.now() }); }, () => {});
});
