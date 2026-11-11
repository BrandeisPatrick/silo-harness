// Live check of the notice the Browser pane shows when a page asks for a passkey, which cannot work until the app is
// signed with a Developer ID: on local pages this script serves (localhost is a secure context), a modal
// navigator.credentials.get or .create shows "Passkeys don't work here yet. …" once per page load, in the bar under the
// URL bar, and the page's promise settles (NotAllowedError) instead of hanging; a conditional request (autofill), a
// password request and an ordinary page show nothing; OK dismisses it for the rest of the load; a request from a tab
// of a session that is not on screen shows nothing there and waits for that session.
// Run: npm run build && node test/live/browser-passkeys.js [screenshot-dir]
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt } = require('./rig.js');

const { check, done } = checker();

const NOTICE = "Passkeys don't work here yet. Choose another way to sign in.";
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const PAGES = {
  // Sign-in pages fire a conditional request on load, for autofill, and abort it before a modal one
  '/signin.html': page('Sign in', `<h1>Sign in</h1><input autocomplete="username webauthn"><script>window.__condAbort = new AbortController(); window.__cond = navigator.credentials.get({ mediation: 'conditional', signal: window.__condAbort.signal, publicKey: { challenge: new Uint8Array(32), rpId: 'localhost' } }).then(() => 'resolved', (e) => e.name);</script>`),
  '/plain.html': page('Plain', '<h1>Nothing to sign in to</h1>'),
};

const CHALLENGE = 'new Uint8Array(32)';
/** Runs a request in the page and says how it settled, within `capMs`. */
const ask = (ws, request, capMs = 8000) =>
  evalAt(ws, `(async () => { const t0 = performance.now(); const r = await Promise.race([(${request}).then(() => 'resolved', (e) => e.name), new Promise((r) => setTimeout(() => r('pending'), ${capMs}))]); return { r, ms: Math.round(performance.now() - t0) }; })()`, capMs + 5000);
const MODAL_GET = `navigator.credentials.get({ publicKey: { challenge: ${CHALLENGE}, rpId: 'localhost', timeout: 60000 } })`;
const MODAL_CREATE = `navigator.credentials.create({ publicKey: { challenge: ${CHALLENGE}, rp: { name: 'Example', id: 'localhost' }, user: { id: new Uint8Array(8), name: 'ada@example.com', displayName: 'Ada Example' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } })`;

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const server = http.createServer((req, res) => {
    const body = PAGES[new URL(req.url, 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;
  const app = await launch({ mode: 'bypass', mock: true });
  const notices = async () => (await app.evaluate('window.__oc_debug.mods.browser().safety.bars')).filter((b) => b.kind === 'passkey');
  const openSession = async (id) => {
    await app.click(`.session-item[data-id="${id}"]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${JSON.stringify(id)}`, 10_000, `session ${id} on screen`);
    await sleep(400);
  };

  try {
    // ---------- What shows nothing ----------
    await app.callTool('browser_navigate', { url: `${base}/signin.html` });
    let ws = await app.pageTarget(`${base}/signin.html`);
    await sleep(1500);
    check('a sign-in page with a conditional request on load shows no notice', (await notices()).length === 0, await notices());
    // A modal request while the page's own conditional one is still pending: Chromium refuses it at once
    let o = await ask(ws, MODAL_GET);
    await app.waitFor(`window.__oc_debug.mods.browser().safety.bars.some((b) => b.kind === 'passkey')`, 5000, 'the notice').catch(() => undefined);
    console.log(`     (a modal request while the page's conditional one is pending: ${o.r} after ${o.ms} ms)`);
    check('a modal request while the conditional one is pending settles at once, and the notice shows', o.r !== 'pending' && (await notices()).length === 1, o);
    await app.evaluate(`document.querySelector('.browser-ask.passkey button[data-answer]').click()`);
    await app.callTool('browser_navigate', { url: `${base}/signin.html` });
    ws = await app.pageTarget(`${base}/signin.html`);
    await sleep(800);
    await evalAt(ws, 'window.__condAbort.abort()');
    o = await ask(ws, `navigator.credentials.get({ mediation: 'conditional', signal: (window.__c2 = new AbortController()).signal, publicKey: { challenge: ${CHALLENGE}, rpId: 'localhost' } })`, 2500);
    check('a conditional request made later shows none either (and stays pending, as autofill does)', (await notices()).length === 0 && o.r === 'pending', o);
    await evalAt(ws, 'window.__c2.abort()');
    o = await ask(ws, `navigator.credentials.get({ password: true })`);
    await sleep(300);
    check('a password request shows none', (await notices()).length === 0 && o.r !== 'pending', o);

    // ---------- A modal request ----------
    o = await ask(ws, MODAL_GET);
    await app.waitFor(`window.__oc_debug.mods.browser().safety.bars.some((b) => b.kind === 'passkey')`, 5000, 'the notice').catch(() => undefined);
    let n = await notices();
    check("a modal passkey request: the page's promise settles with NotAllowedError instead of hanging", o.r === 'NotAllowedError' && o.ms < 4000, o);
    check('… and the notice shows once, in the bar style, with its fixed words and OK', n.length === 1 && n[0].text === NOTICE && JSON.stringify(n[0].buttons) === '["OK"]', n);
    await app.screenshotOf(path.join(shots, 'passkey-notice.png'), '#side-pane', 0).catch(() => undefined);
    o = await ask(ws, MODAL_GET);
    check('a second request on the same page settles too (none is left pending) and the notice stays one', o.r === 'NotAllowedError' && (await notices()).length === 1, o);
    await app.evaluate(`document.querySelector('.browser-ask.passkey button[data-answer]').click()`);
    await sleep(400);
    check('OK dismisses it', (await notices()).length === 0);
    o = await ask(ws, MODAL_GET);
    await sleep(500);
    check('… for the rest of the page load: another request settles and shows nothing', o.r === 'NotAllowedError' && (await notices()).length === 0, o);

    // ---------- A new load, another page ----------
    await app.callTool('browser_navigate', { url: `${base}/plain.html` });
    await sleep(800);
    check('an ordinary page shows no notice', (await notices()).length === 0);
    ws = await app.pageTarget(`${base}/plain.html`);
    o = await ask(ws, MODAL_CREATE);
    await app.waitFor(`window.__oc_debug.mods.browser().safety.bars.some((b) => b.kind === 'passkey')`, 5000, 'the notice for create').catch(() => undefined);
    check('a new page load: a modal create shows the notice again, and settles', o.r === 'NotAllowedError' && (await notices()).length === 1, o);

    // ---------- A session not on screen ----------
    const A = await app.evaluate('oc.sessions.current().then((s) => s.id)');
    await app.callTool('browser_navigate', { url: `${base}/signin.html` });
    await sleep(500);
    check('the next page load starts without it', (await notices()).length === 0);
    const signinA = await app.pageTarget(`${base}/signin.html`);
    await sleep(500);
    await evalAt(signinA, 'window.__condAbort.abort()');
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('#empty-state') && !document.querySelector('#empty-state').hidden`, 10_000, 'the new session');
    await sleep(500);
    o = await ask(signinA, MODAL_GET);
    await sleep(800);
    check("a request from a tab of a session not on screen settles, and shows nothing over the session in front", o.r === 'NotAllowedError' && (await notices()).length === 0, o);
    await app.send('hello');
    await app.waitIdle(30_000).catch(() => undefined);
    await openSession(A);
    await app.waitFor(`window.__oc_debug.mods.browser().safety.bars.some((b) => b.kind === 'passkey')`, 5000, "A's notice").catch(() => undefined);
    n = await notices();
    check('… it waits, and shows when that session is opened', n.length === 1 && n[0].text === NOTICE, n);
  } catch (err) {
    check(`no exception (${err.message})`, false);
  } finally {
    await app.close();
    server.close();
    console.log(`Screenshots: ${shots}`);
  }
  process.exit(done() ? 1 : 0);
})();
