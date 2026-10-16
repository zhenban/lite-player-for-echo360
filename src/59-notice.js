// ===================================================================================
// Small, dismissible notice shown when we fall back to the original player. A fallback
// notice also says why and offers the start-up diagnostics (our player, with its own
// diagnostics, is not there).
// ===================================================================================

function notice(text, more) {
  const show = () => {
    const host = document.createElement('div');
    host.className = 'lite-player-for-echo360-notice';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>div{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:min(420px,calc(100vw - 32px));'
      + 'padding:10px 12px 10px 14px;border-radius:10px;background:rgba(20,20,24,.94);color:#eee;'
      + 'font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:flex-start}'
      + 'p{margin:0}small{display:block;opacity:.75;margin-top:4px;overflow-wrap:anywhere}'
      + 'button{all:unset;cursor:pointer;opacity:.7;padding:0 4px}button:hover{opacity:1}'
      + '.act{display:inline-block;margin-top:6px;padding:2px 8px;border:1px solid rgba(255,255,255,.35);border-radius:6px;opacity:.9}'
      + '@media (pointer: coarse){button{min-width:44px;min-height:44px;box-sizing:border-box;text-align:center}.act{display:inline-flex;align-items:center}}</style>'
      + '<div role="status"><p><span></span><small hidden></small><button class="act" hidden></button></p><button class="x">✕</button></div>';
    root.querySelector('span').textContent = text;
    const small = /** @type {HTMLElement} */ (root.querySelector('small'));
    if (more && more.detail) { small.textContent = more.detail; small.hidden = false; }
    const act = /** @type {HTMLElement} */ (root.querySelector('.act'));
    if (more && more.action) {
      act.textContent = more.action[0];
      act.hidden = false;
      act.addEventListener('click', () => more.action[1]((msg) => { act.textContent = msg; }));
    }
    const close = root.querySelector('.x');
    close.setAttribute('aria-label', tr('close'));
    close.addEventListener('click', () => host.remove());
    document.body.appendChild(host);
    setTimeout(() => host.remove(), more && more.action ? 30000 : 10000);
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
}

// The original player has the page: says so, why (boot.reason), and offers the start-up
// diagnostics.
function fallbackNotice(text) {
  notice(text, {
    detail: boot.reason ? tr('noticeReason', { why: boot.reason }) : '',
    action: [tr('copyDiagnostics'), (done) => {
      let text2 = '';
      try { text2 = startupDiagnosticsText(); } catch (e) { text2 = String(e); }
      navigator.clipboard.writeText(text2).then(() => done(tr('diagCopied')), (e) => done(tr('copyFailed', { msg: (e && e.message) || e })));
    }],
  });
}
