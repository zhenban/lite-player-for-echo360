// Full-page screenshots of the local preview at desktop and phone widths, light and dark.
// Starts its own headless Chrome (own profile directory, own debugging port) and closes it.
//   node dev/shoot.mjs <url> <out-dir> <profile-dir> [name-prefix]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [url, outDir, profile, prefix = 'shot'] = process.argv.slice(2);
const PORT = 9411;
mkdirSync(outDir, { recursive: true });
const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch('http://127.0.0.1:' + PORT + '/json')).json()).find((x) => x.type === 'page'); } catch { /* not up yet */ }
}
if (!target) { chrome.kill(); throw new Error('Chrome did not start'); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});

const shots = (process.env.SHOTS || 'desktop-light,desktop-dark,phone-light,phone-dark').split(',');
const errors = [];
await send('Runtime.enable');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
});
try {
  for (const s of shots) {
    const [form, theme] = s.split('-');
    const phone = form === 'phone';
    const width = phone ? 390 : 1360;
    await send('Emulation.setDeviceMetricsOverride', { width, height: phone ? 844 : 900, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await send('Page.navigate', { url });
    await sleep(Number(process.env.WAIT || 2600));
    // PREFS: stored preferences to load with (then reload); ACT: a script to run before the shot.
    if (process.env.PREFS) {
      await send('Runtime.evaluate', { expression: 'localStorage.setItem("lpdash", ' + JSON.stringify(process.env.PREFS) + ')' });
      await send('Page.navigate', { url });
      await sleep(Number(process.env.WAIT || 2600));
    }
    if (process.env.ACT) {
      const r = await send('Runtime.evaluate', { expression: process.env.ACT, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) errors.push('ACT: ' + r.exceptionDetails.text);
      else if (r.result && r.result.value !== undefined) console.log('ACT ->', JSON.stringify(r.result.value));
      await sleep(1500);
    }
    const { contentSize } = await send('Page.getLayoutMetrics');
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height: Math.ceil(contentSize.height), scale: 1 } });
    writeFileSync(outDir + '/' + prefix + '-' + s + '.png', Buffer.from(data, 'base64'));
  }
} finally {
  ws.close();
  chrome.kill();
}
if (errors.length) { console.log('Page errors:\n' + errors.join('\n')); process.exitCode = 1; }
else console.log('ok');
