// Live check of certificate errors in the real app (hidden, a throwaway profile, the mock model): the fixture site over
// HTTPS on its self-signed certificate stops at the pane's interstitial ("This connection is not private", the host,
// the code in words, Go back, Proceed anyway), browser_navigate's result says the certificate is not valid and that
// only the user can proceed, Go back returns to the page before, Proceed loads the page and the URL pill shows the
// amber triangle; an http page shows "Not secure"; a new launch asks again.
// Run: npm run build && node test/live/browser-cert.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');
const { startSite, httpsServer } = require('./support/site.js');

const { check, done } = checker();
const SENTENCE = /^The certificate for localhost is not valid \((net::ERR_CERT_[A-Z_]+)\)\. Only the user can proceed\.$/;

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const site = await startSite();
  const tls = await httpsServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-browser-cert-'));
  let app = await launch({ profile, mode: 'bypass', mock: true });
  const dbg = () => app.evaluate('window.__oc_debug.mods.browser()');
  const active = async () => {
    const d = await dbg();
    return d.tabs.length ? (await app.evaluate('oc.browser.state()')).tabs.find((t) => t.id === d.activeId) : null;
  };
  const click = (sel) => app.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.offsetParent === null) return false; b.click(); return true; })()`);
  const waitIx = (shown, what) => app.waitFor(`${shown ? '' : '!'}window.__oc_debug.mods.browser().safety.interstitial`, 15_000, what);

  try {
    // ---------- An http page first: "Not secure" ----------
    let r = await app.callTool('browser_navigate', { url: `${site.base}/landing.html` });
    check('setup: an http page opens', /Landing/.test(r ?? ''), r);
    let s = (await dbg()).safety;
    const pill = await app.evaluate(`(() => { const e = document.getElementById('url-icon'); const st = getComputedStyle(e); return { text: e.textContent, fs: st.fontSize, color: st.color, grey: getComputedStyle(document.querySelector('.url-pill')).color }; })()`);
    check('the URL pill says "Not secure" for http, in 12 px grey', s.security === 'insecure' && pill.text === 'Not secure' && pill.fs === '12px' && pill.color === pill.grey, pill);

    // ---------- The interstitial ----------
    r = await app.callTool('browser_navigate', { url: `${tls.base}/landing.html` });
    const code = SENTENCE.exec(r ?? '')?.[1];
    check("browser_navigate's result says the certificate is not valid and only the user can proceed", Boolean(code), r);
    await waitIx(true, 'the interstitial');
    s = (await dbg()).safety;
    check('the interstitial covers the slot: "This connection is not private"', s.interstitial && s.interstitial.title === 'This connection is not private', s.interstitial);
    check('… with the host and the code in words', s.interstitial && /^localhost may not be the site it says it is\. Its certificate .+\.$/.test(s.interstitial.text), s.interstitial && s.interstitial.text);
    check('… with Go back and Proceed anyway (unsafe)', s.interstitial && JSON.stringify(s.interstitial.buttons) === JSON.stringify(['Go back', 'Proceed anyway (unsafe)']), s.interstitial && s.interstitial.buttons);
    const tab = await active();
    check("the tab records the error: host, code, fingerprint, the page", tab.certError && tab.certError.host === 'localhost' && tab.certError.code === code && /\S/.test(tab.certError.fingerprint) && tab.certError.url === `${tls.base}/landing.html`, tab.certError);
    const look = await app.evaluate(`(() => {
      const ix = document.getElementById('browser-interstitial');
      const slot = document.getElementById('browser-view').getBoundingClientRect();
      const r = ix.getBoundingClientRect();
      const css = (sel) => getComputedStyle(ix.querySelector(sel));
      return { covers: r.left === slot.left && r.top === slot.top && r.width === slot.width && r.height === slot.height, bg: getComputedStyle(ix).backgroundColor, page: getComputedStyle(document.body).backgroundColor, title: css('.ix-title').fontSize, text: css('.ix-text').fontSize, back: css('.ix-back').backgroundColor, ink: getComputedStyle(document.body).color, proceed: css('.ix-proceed').color, grey: getComputedStyle(document.querySelector('.url-pill')).color, triangle: !!ix.querySelector('.ix-icon svg') };
    })()`);
    check('… drawn in the app\'s style: the page colour, the title 17 px, the text 15 px, Go back filled with the text colour, Proceed a grey link, an outlined triangle', look.covers && look.bg === look.page && look.title === '17px' && look.text === '15px' && look.back === look.ink && look.proceed === look.grey && look.triangle, look);
    await app.screenshotOf(path.join(shots, 'cert-interstitial.png'), '#side-pane');

    // ---------- Go back ----------
    check('Go back', await click('#browser-interstitial .ix-back'));
    await waitIx(false, 'the interstitial to go');
    await app.waitFor(`window.__oc_debug.mods.browser().tabs.some((t) => t.url === ${JSON.stringify(`${site.base}/landing.html`)})`, 10_000, 'the page before');
    check('… returns to the page before, without the interstitial', (await active()).url === `${site.base}/landing.html` && (await active()).certError === null);

    // ---------- Proceed ----------
    r = await app.callTool('browser_navigate', { url: `${tls.base}/landing.html` });
    check('the next visit stops again', SENTENCE.test(r ?? ''), r);
    await waitIx(true, 'the interstitial again');
    check('Proceed anyway', await click('#browser-interstitial .ix-proceed'));
    await waitIx(false, 'the interstitial to go after Proceed');
    await app.waitFor(`(async () => { const s = await oc.browser.state(); return s.url === ${JSON.stringify(`${tls.base}/landing.html`)} && s.title === 'Landing'; })()`, 15_000, 'the page to load past the certificate');
    check('… loads the page', (await active()).title === 'Landing' && (await active()).certError === null);
    await sleep(200);
    s = (await dbg()).safety;
    const amber = await app.evaluate(`(() => { const e = document.getElementById('url-icon'); const probe = document.createElement('span'); probe.style.color = 'var(--warn)'; document.body.append(probe); const warn = getComputedStyle(probe).color; probe.remove(); return { color: getComputedStyle(e).color, warn, svg: !!e.querySelector('svg') }; })()`);
    check('… and the URL pill shows the amber triangle in place of the lock', s.security === 'proceeded' && amber.svg && amber.color === amber.warn, { security: s.security, amber });
    await app.screenshotOf(path.join(shots, 'cert-proceeded.png'), '.browser-bar');
    r = await app.callTool('browser_navigate', { url: `${tls.base}/login.html` });
    check('for the rest of this run the agent reaches the host it was let through to', /^Now at .*\/login\.html/.test(r ?? ''), r);

    // ---------- A new launch asks again ----------
    await app.close();
    app = await app.relaunch();
    r = await app.callTool('browser_navigate', { url: `${tls.base}/landing.html` });
    check('a new launch asks again', SENTENCE.test(r ?? ''), r);
    await waitIx(true, 'the interstitial after the relaunch');
    check('… with the interstitial', (await dbg()).safety.interstitial?.title === 'This connection is not private');
  } finally {
    await app.close();
    site.close();
    tls.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
