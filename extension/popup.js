// Lite Player for Echo360, the toolbar popup: the on/off switch, what the player does on the
// current tab (asked through bridge.js), the language and usage-data settings, the settings
// page, "Report a problem" and, once, a line asking for a rating.
// Its words follow the player's language setting (English or Chinese), like the player.
const STORE_REVIEWS = 'https://chromewebstore.google.com/detail/bbcmnjnijjfpnngkkgoahjljibfackbh/reviews';
const BUG_FORM = 'https://github.com/zhenban/lite-player-for-echo360/issues/new?template=bug_report.yml';
// The rating line: after this many lectures watched for a while, and this long after install.
const RATE_AFTER_VIEWED = 10;
const RATE_AFTER_DAYS = 7;

const WORDS = {
  en: {
    title: 'Lite Player', onLabel: 'Use Lite Player on Echo360', reload: 'Reload this page',
    language: 'Language', langAuto: 'Same as the browser', usageData: 'Send anonymous usage data',
    settings: 'All settings', report: 'Report a problem',
    rate: 'Enjoying Lite Player? Rate it in the Chrome Web Store', rateClose: 'Do not show again',
    noPage: 'Open an Echo360 lecture recording to use Lite Player.',
    running: 'Lite Player is playing this lecture.',
    waiting: 'Lite Player is starting.',
    courseList: 'Course page: the recordings you watched are marked.',
    off: 'Lite Player is off: Echo360\'s own player is used.',
    offChanged: 'Reload the page to use {what}.',
    offWhatOn: 'Lite Player', offWhatOff: 'Echo360\'s own player',
    duplicate: 'Lite Player is installed twice (the extension and the userscript). Remove the userscript from your userscript manager.',
    original: 'Echo360\'s own player is used here: {why}',
    why: {
      user: 'you chose it.',
      extras: 'you opened something only it has (polls, slide decks, attachments or audio description).',
      live: 'live lectures open in Echo360\'s player.',
      copyright: 'this recording asks you to accept a copyright notice first.',
      unsupported: 'this browser is missing something Lite Player needs.',
      noHls: 'this browser cannot play the video here.',
      libFailed: 'part of Lite Player could not be loaded. Check the connection and reload.',
      auth: 'your sign-in to Echo360 expired.',
      coreError: 'playback failed, so Lite Player stepped aside.',
      playbackError: 'playback failed, so Lite Player stepped aside.',
      other: 'this page was not recognised. Report a problem if it keeps happening.',
    },
    copied: 'Diagnostics copied. Paste them into the form that just opened.',
    copyFailed: 'Could not copy the diagnostics. The form opened anyway.',
  },
  zh: {
    title: 'Lite Player', onLabel: '在 Echo360 上使用 Lite Player', reload: '重新加载此页',
    language: '语言', langAuto: '跟随浏览器', usageData: '发送匿名使用数据',
    settings: '全部设置', report: '报告问题',
    rate: '用得顺手吗？去 Chrome 应用商店评个分吧', rateClose: '不再显示',
    noPage: '打开一节 Echo360 课程回放即可使用 Lite Player。',
    running: 'Lite Player 正在播放这节课。',
    waiting: 'Lite Player 正在启动。',
    courseList: '课程页：看过的录像已标出。',
    off: 'Lite Player 已关闭：使用 Echo360 自带的播放器。',
    offChanged: '重新加载此页后改用{what}。',
    offWhatOn: ' Lite Player', offWhatOff: ' Echo360 自带的播放器',
    duplicate: 'Lite Player 装了两份（扩展和用户脚本）。请在用户脚本管理器里删除用户脚本。',
    original: '这里使用的是 Echo360 自带的播放器：{why}',
    why: {
      user: '是你选择的。',
      extras: '你打开了只有它才有的内容（投票、幻灯片、附件或口述影像）。',
      live: '直播课在 Echo360 的播放器里打开。',
      copyright: '这个录像要先接受版权声明。',
      unsupported: '这个浏览器缺少 Lite Player 需要的功能。',
      noHls: '这个浏览器在这里无法播放视频。',
      libFailed: 'Lite Player 的一部分没能加载。请检查网络后重新加载。',
      auth: '你的 Echo360 登录已过期。',
      coreError: '播放出错，Lite Player 已让位。',
      playbackError: '播放出错，Lite Player 已让位。',
      other: '没能识别这个页面。如果反复出现，请报告问题。',
    },
    copied: '诊断信息已复制。请粘贴到刚打开的表单里。',
    copyFailed: '没能复制诊断信息，表单已经打开。',
  },
};

const $ = (id) => document.getElementById(id);
let w = WORDS.en;
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

function langOf(prefs) {
  if (prefs.lang === 'en' || prefs.lang === 'zh') return prefs.lang;
  return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
}

function translate() {
  document.documentElement.lang = w === WORDS.zh ? 'zh-CN' : 'en';
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = w[el.dataset.t];
  for (const el of document.querySelectorAll('[data-t-label]')) el.setAttribute('aria-label', w[el.dataset.tLabel]);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// The tab's player's answer, or null (not a page the player handles).
async function askTab(tab, name) {
  if (!tab || tab.id == null) return null;
  try { return await chrome.tabs.sendMessage(tab.id, { type: 'ask', name }); } catch (e) { return null; }
}

let tabStatus = null;
function showStatus(off) {
  const box = $('status');
  const s = tabStatus;
  let text;
  let warn = false;
  // The page was loaded with the switch the other way: a reload applies it.
  const stale = s && !s.duplicate && (s.state === 'off') !== off;
  $('reload').hidden = !stale;
  if (stale) text = fill(w.offChanged, { what: off ? w.offWhatOff : w.offWhatOn });
  else if (!s) text = off ? w.off : w.noPage;
  else if (s.duplicate) { text = w.duplicate; warn = true; }
  else if (s.state === 'off' || off) text = w.off;
  else if (s.state === 'original') { text = fill(w.original, { why: w.why[s.reason] || w.why.other }); warn = !['user', 'extras', 'live', 'copyright'].includes(s.reason); }
  else text = w[s.state] || w.noPage;
  box.textContent = text;
  box.parentElement.classList.toggle('warn', warn);
}

async function reportProblem(tab) {
  let text = tabStatus ? await askTab(tab, 'diagnostics') : null;
  if (typeof text !== 'string' || !text) {
    text = 'Lite Player for Echo360: ' + chrome.runtime.getManifest().version + '\nRuns in: extension\nBrowser: ' + navigator.userAgent
      + '\nPage: ' + (tabStatus ? 'lesson or course page' : 'not an Echo360 lecture');
  }
  let ok = true;
  try { await navigator.clipboard.writeText(text); } catch (e) { ok = false; }
  await chrome.tabs.create({ url: BUG_FORM });
  const note = $('note');
  note.textContent = ok ? w.copied : w.copyFailed;
  note.hidden = false;
}

async function main() {
  const prefs = await LP.readPrefs();
  w = WORDS[langOf(prefs)];
  translate();
  document.querySelector('.ver').textContent = chrome.runtime.getManifest().version;

  const local = await chrome.storage.local.get(['off', 'viewed', 'installedAt', 'rateDone']);
  let off = local.off === true;
  $('on').checked = !off;
  $('lang').value = ['en', 'zh'].includes(prefs.lang) ? prefs.lang : 'auto';
  $('telemetry').checked = prefs.telemetry !== false;

  const tab = await activeTab();
  tabStatus = await askTab(tab, 'status');
  showStatus(off);

  $('on').addEventListener('change', async () => {
    off = !$('on').checked;
    await chrome.storage.local.set({ off });
    showStatus(off);
  });
  $('reload').addEventListener('click', () => { if (tab) chrome.tabs.reload(tab.id); window.close(); });
  $('lang').addEventListener('change', async () => {
    const lang = $('lang').value;
    const next = await LP.writePrefs({ lang });
    w = WORDS[langOf(next)];
    translate();
    showStatus(off);
    // The player's language changes when the page is loaded again.
    if (tabStatus) $('reload').hidden = false;
  });
  $('telemetry').addEventListener('change', () => { LP.writePrefs({ telemetry: $('telemetry').checked }); });
  $('options').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
  $('report').addEventListener('click', () => { reportProblem(tab); });

  const days = (Date.now() - (+local.installedAt || Date.now())) / 864e5;
  if (!local.rateDone && (+local.viewed || 0) >= RATE_AFTER_VIEWED && days >= RATE_AFTER_DAYS) {
    $('rate').hidden = false;
    $('rateLink').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.storage.local.set({ rateDone: true });
      chrome.tabs.create({ url: STORE_REVIEWS });
    });
    $('rateClose').addEventListener('click', () => { chrome.storage.local.set({ rateDone: true }); $('rate').hidden = true; });
  }
}

main();
