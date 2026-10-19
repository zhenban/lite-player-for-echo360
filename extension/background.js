// Lite Player for Echo360, the extension's service worker: sends the player's usage data
// (asked for by the bridge, bridge.js) to the usage-data server, and nothing else.
const SERVER = '{{TELEMETRY_URL}}/';
const MAX_MS = 60000;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg || msg.type !== 'post' || typeof msg.url !== 'string' || !msg.url.startsWith(SERVER) || typeof msg.body !== 'string') return false;
  const ms = Math.min(Math.max(+msg.timeoutMs || 0, 1000), MAX_MS);
  fetch(msg.url, { method: 'POST', body: msg.body, headers: { 'Content-Type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(ms) })
    .then((r) => r.text().then((text) => reply({ status: r.status, text })))
    .catch(() => reply({ status: 0, text: '' }));
  return true;   // answered later
});
