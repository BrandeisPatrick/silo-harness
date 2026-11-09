// Live check of the browser's safety in the real app, with the mock model scripted to call the browser tools and a
// small local page served here: a password the agent types with browser_type, and one the user types into the page
// themselves, never reach a tool result, the transcript on screen, the saved session, the history or a request to
// the model; browser_read_page, browser_find and browser_eval show ••• in their place, also after "Show password";
// browser_screenshot is refused while a filled credential field has the focus or shows its value. Then permissions:
// a camera request from a page brings up the permission bar under the URL bar, Don't allow is remembered,
// notifications can be allowed every time, and the app's own page keeps its permissions unasked
// (test/live/browser-permissions.js goes through the bar in full).
// Run: npm run build && node test/live/browser-safety.js
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt, cdpAt } = require('./rig.js');

const { check, done } = checker();

const AGENT_SECRET = 'Tr0ub4dor&3-agent';
const USER_SECRET = 'Corr3ct-Horse-Battery';
const EMAIL = 'ada@example.com';
const PLAIN = 'plainuser42';
const OTP = '730215';
const SECRETS = [AGENT_SECRET, USER_SECRET, OTP];

const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body>
<h1>Sign in</h1>
<form onsubmit="return false">
  <p><label>Email <input id="email" name="email" type="email" autocomplete="username"></label></p>
  <p><label>Password <input id="pw" name="password" type="password" autocomplete="current-password"></label></p>
  <p><input id="bare" type="password"> <input id="user" type="text"></p>
  <p><label>Code from the app <input id="otp" name="otp" inputmode="numeric"></label></p>
  <p><button type="button" id="show" onclick="const f = document.getElementById('pw'); f.type = f.type === 'password' ? 'text' : 'password'">Show password</button>
  <button type="submit">Sign in</button></p>
</form>
</body></html>`;
const CAMERA = '<!doctype html><html><head><meta charset="utf-8"><title>Camera</title></head><body><h1>Camera test</h1></body></html>';

/** Matches a request whose last message is the user's and contains `marker` (the scripted reply answers only that). */
const lastUserHas = (marker) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  if (!m || m.role !== 'user') return false;
  return (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes(marker);
};

/** Every file under `dir` that contains one of `needles` (as UTF-8), with which. */
function filesHolding(dir, needles) {
  const hits = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        let buf;
        try {
          if (fs.statSync(p).size > 64 * 1024 * 1024) continue;
          buf = fs.readFileSync(p);
        } catch {
          continue;
        }
        for (const n of needles) if (buf.includes(Buffer.from(n, 'utf8'))) hits.push(`${path.relative(dir, p)} (${n === USER_SECRET ? 'user' : 'agent'} secret)`);
      }
    }
  };
  walk(dir);
  return hits;
}

(async () => {
  const server = http.createServer((req, res) => {
    const body = req.url.startsWith('/login') ? LOGIN : req.url.startsWith('/camera') ? CAMERA : null;
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const site = `127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-browser-safety-'));
  // Chromium's stand-in camera and microphone: a request reaches the permission check without touching real devices
  const app = await launch({ profile, mode: 'bypass', mock: true, args: ['--use-fake-device-for-media-stream'] });
  /** The permission bar's sentences, and a click on one of its answers */
  const permissionBars = async () => (await app.evaluate('window.__oc_debug.mods.browser()')).safety.bars.filter((b) => b.kind === 'permission');
  const waitPermissionBar = (re, what) => app.waitFor(`window.__oc_debug.mods.browser().safety.bars.some((b) => b.kind === 'permission' && ${re}.test(b.text))`, 10_000, what);
  const answerBar = (label) => app.evaluate(`(() => { const b = [...document.querySelectorAll('#browser-bars .browser-ask.permission button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  /** The Browser pane's page from the fixture server, as a CDP target. */
  const paneWs = () => app.pageTarget(base, 5000);
  const paneEval = async (expr) => evalAt(await paneWs(), expr);

  let n = 0;
  /** One user turn in which the model calls `name` with `args` once (then says "Done."); the tool's result comes back. */
  async function step(name, args) {
    const id = `call_bs_${++n}`;
    const marker = `Safety step ${n} ${name.replace(/_/g, ' ')}`;
    app.mock.state.replies.push({ content: '', toolCalls: [{ id, name, args }], when: lastUserHas(marker) });
    await app.send(marker);
    // The request after the call carries its result; then the run ends.
    let content = null;
    for (const until = Date.now() + 60_000; content === null && Date.now() < until; ) {
      for (const r of [...app.mock.state.requests].reverse()) {
        const m = (r.payload?.messages ?? []).find((x) => x.role === 'tool' && x.tool_call_id === id);
        if (m) content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      }
      if (content === null) await sleep(100);
    }
    await app.waitFor(`(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`, 60_000, `${name} to finish`);
    await sleep(150);
    return content;
  }
  const leaks = (s) => SECRETS.filter((x) => String(s ?? '').includes(x));

  try {
    // ---------- Credentials ----------
    let r = await step('browser_navigate', { url: `${base}/login.html` });
    check('the fixture login page opens in the pane', /Sign in/.test(r ?? ''), r);

    // The hidden test window does not take focus from a synthetic click, so the field gets it from the page first;
    // browser_type still finds it by its label and clicks it as it would in a visible window.
    await paneEval(`document.getElementById('pw').focus()`);
    r = await step('browser_type', { field: 'Password', text: AGENT_SECRET });
    check('browser_type into the password field: the result gives the length, not the text', r && r.startsWith(`Typed ${AGENT_SECRET.length} characters into a password field 'Password'`) && !leaks(r).length, r);
    check('… and the text really is in the field', (await paneEval(`document.getElementById('pw').value`)) === AGENT_SECRET);
    const row = await app.evaluate(`(() => { const el = [...document.querySelectorAll('.tool[data-tool="browser_type"]')].pop(); return el ? { arg: el.querySelector('.tool-arg')?.textContent ?? '', title: el.querySelector('.tool-arg')?.getAttribute('title') ?? '' } : null; })()`);
    check('… the tool row shows •••', row && row.arg.includes('•••') && !leaks(row.arg + row.title).length, row);

    await paneEval(`document.getElementById('email').focus()`);
    r = await step('browser_type', { field: 'Email', text: EMAIL });
    check('browser_type into an ordinary field still says what it typed', r && r.startsWith(`Typed "${EMAIL}" into textbox 'Email'`), r);

    // The user types into the page themselves: a password field with no label (its value used to stand in for one)
    // and an ordinary field with no label.
    const pane = await paneWs();
    await paneEval(`document.getElementById('bare').focus()`);
    await cdpAt(pane, 'Input.insertText', { text: USER_SECRET });
    await paneEval(`document.getElementById('user').focus()`);
    await cdpAt(pane, 'Input.insertText', { text: PLAIN });
    check('setup: the user typed into the page', (await paneEval(`document.getElementById('bare').value === ${JSON.stringify(USER_SECRET)} && document.getElementById('user').value === ${JSON.stringify(PLAIN)}`)) === true);

    r = await step('browser_read_page', {});
    check('browser_read_page: the labelled password field reads = "•••"', /input\[type=password\] "Password" = "•••"/.test(r ?? ''), r);
    check('… the unlabelled one too, with no value for a label', /input\[type=password\] "" = "•••"/.test(r ?? ''), r);
    check('… neither password is in it', r && !leaks(r).length, leaks(r));
    check('… an ordinary field keeps its value', r && r.includes(`"${PLAIN}"`), r);

    r = await step('browser_find', { query: 'password' });
    check('browser_find: the password field shows •••', r && r.includes('= "•••"') && !leaks(r).length, r);

    r = await step('browser_eval', { code: `document.getElementById('pw').value` });
    check('browser_eval reading the password returns •••', r === '•••', r);
    r = await step('browser_eval', { code: `({ email: document.getElementById('email').value, pw: document.getElementById('pw').value, bare: document.getElementById('bare').value, user: document.getElementById('user').value })` });
    check('browser_eval: in an object both passwords are •••, the email and the username are not', r && !leaks(r).length && r.includes(EMAIL) && r.includes(PLAIN) && (r.match(/•••/g) || []).length === 2, r);
    r = await step('browser_eval', { code: `(() => { const v = document.getElementById('bare').value; document.getElementById('bare').value = ''; return 'was ' + v; })()` });
    check('browser_eval that clears the field first still gets •••', r === 'was •••', r);
    await paneEval(`(() => { const f = document.getElementById('bare'); f.focus(); f.select(); return true; })()`);
    await cdpAt(pane, 'Input.insertText', { text: USER_SECRET });

    // Screenshots
    await paneEval(`document.getElementById('pw').focus()`);
    r = await step('browser_screenshot', {});
    check('browser_screenshot is refused while the filled password field has the focus', /Screenshot refused: the focus is in a password field/.test(r ?? ''), r);
    await paneEval(`document.getElementById('user').focus()`);
    r = await step('browser_screenshot', {});
    check('… and not refused once the focus is on an ordinary field', r && !/refused/i.test(r), r);

    // "Show password", by the user, and a type change by code the agent runs
    await paneEval(`document.getElementById('show').click()`);
    check('setup: the password field now shows its text', (await paneEval(`document.getElementById('pw').type`)) === 'text');
    r = await step('browser_eval', { code: `document.getElementById('bare').type = 'text'; 'ok'` });
    r = await step('browser_read_page', { filter: 'all' });
    check('after "Show password" both fields still read •••', /input\[type=text\] "Password" = "•••"/.test(r ?? '') && /input\[type=text\] "" = "•••"/.test(r ?? '') && !leaks(r).length, r);
    r = await step('browser_eval', { code: `[document.getElementById('pw').value, document.getElementById('bare').value]` });
    check('… and browser_eval still gets •••', r && !leaks(r).length && (r.match(/•••/g) || []).length === 2, r);
    r = await step('browser_screenshot', {});
    check('browser_screenshot is refused while a password shows in clear text on screen', /Screenshot refused: a password field .* shows a filled-in credential in clear text/.test(r ?? ''), r);
    r = await step('browser_get_text', {});
    check('browser_get_text holds neither password', r && !leaks(r).length, r);

    // A one-time code field known by its name only (its label says nothing of a code): the page is asked before the
    // call is stored, without renumbering the refs.
    await paneEval(`document.getElementById('otp').focus()`);
    r = await step('browser_type', { field: 'Code from the app', text: OTP });
    check('browser_type into a one-time code field: length only', r && r.startsWith(`Typed ${OTP.length} characters into a one-time code field 'Code from the app'`) && !leaks(r).length, r);
    const otpRow = await app.evaluate(`(() => { const el = [...document.querySelectorAll('.tool[data-tool="browser_type"]')].pop(); return el ? el.querySelector('.tool-arg')?.textContent ?? '' : null; })()`);
    check('… its row shows ••• from the start', otpRow && otpRow.includes('•••') && !leaks(otpRow).length, otpRow);
    check('… and the code is in the field', (await paneEval(`document.getElementById('otp').value`)) === OTP);

    // Everywhere the conversation goes
    const screenText = await app.evaluate(`(() => { const m = document.querySelector('#messages'); return m.innerText + ' ' + [...m.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).join(' '); })()`);
    check('the transcript on screen holds neither password', !leaks(screenText).length, leaks(screenText));
    const sentToModel = JSON.stringify(app.mock.state.requests.map((q) => q.payload));
    check('no request to the model holds either password', !leaks(sentToModel).length, leaks(sentToModel));
    const sessionsDir = path.join(profile, 'sessions');
    const sessionHits = filesHolding(sessionsDir, SECRETS);
    check('the saved session holds neither password', fs.existsSync(sessionsDir) && !sessionHits.length, sessionHits);

    // ---------- Permissions ----------
    r = await step('browser_navigate', { url: `${base}/camera.html` });
    check('setup: the camera page opens', /Camera/.test(r ?? ''), r);
    await paneEval(`(window.__cam = navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(() => 'granted', (e) => e.name), 1)`);
    await waitPermissionBar(/camera/, 'the permission bar');
    let bars = await permissionBars();
    check('a camera request from a page brings up the permission bar', bars.length === 1 && bars[0].text === `${site} wants to use your camera and microphone`, bars);
    check("… with Allow this time, Allow every time and Don't allow, Don't allow in the primary position", bars[0] && JSON.stringify(bars[0].buttons) === JSON.stringify(['Allow this time', 'Allow every time', "Don't allow"]) && (await app.evaluate(`document.querySelector('#browser-bars .browser-ask.permission button:last-child').classList.contains('primary')`)), bars[0]);
    check("… and \"Don't allow\" denies it", (await answerBar("Don't allow")) && (await paneEval('window.__cam')) === 'NotAllowedError');
    const cam2 = await paneEval(`navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e) => e.name)`);
    await sleep(200);
    check('the answer is remembered: no second question, still denied', (await permissionBars()).length === 0 && cam2 === 'NotAllowedError', cam2);

    await paneEval(`(window.__n = Notification.requestPermission(), 1)`);
    await waitPermissionBar(/notifications/, 'the notifications bar');
    bars = await permissionBars();
    check('notifications: asked, and Allow every time grants them', bars[0]?.text === `${site} wants to show notifications` && (await answerBar('Allow every time')) && (await paneEval('window.__n')) === 'granted', bars[0]);
    const notif2 = await paneEval(`Promise.all([Notification.requestPermission(), Notification.permission])`);
    check('… remembered, and the page sees them granted', JSON.stringify(notif2) === '["granted","granted"]' && (await permissionBars()).length === 0, notif2);
    const geo = await paneEval(`navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state)`);
    const clip = await paneEval(`navigator.permissions.query({ name: 'clipboard-write' }).then((s) => s.state, (e) => e.name)`);
    check('a check alone never asks: location reads denied until asked, clipboard writes granted', geo === 'denied' && clip === 'granted' && (await permissionBars()).length === 0, { geo, clip });

    const own = await app.evaluate(`(async () => ({ notif: await Notification.requestPermission(), current: Notification.permission, camera: (await navigator.permissions.query({ name: 'camera' })).state, geo: (await navigator.permissions.query({ name: 'geolocation' })).state }))()`);
    check("the app's own page keeps its permissions, without a question", own && own.notif === 'granted' && own.current === 'granted' && own.camera === 'granted' && own.geo === 'granted' && (await permissionBars()).length === 0, own);
  } finally {
    await app.close();
    server.close();
  }

  // After the app has quit and written everything: nothing in the whole profile holds a password.
  const hits = filesHolding(profile, SECRETS);
  check('no file the app wrote (sessions, history, logs) holds either password', !hits.length, hits);
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
