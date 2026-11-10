// Live check of the browser's hardening in the real app, with the mock model calling the tools and fixture pages
// served here (reached as shop.example and friends, mapped to 127.0.0.1): an HTML artifact cannot send anything out
// (an image, fetch, sendBeacon, a worker, a WebSocket, a form, a stylesheet, a script, window.open and location all
// stay home) and never leaves the artifact by itself. The later parts of the hardening add their checks below.
// Run: npm run build && node test/live/browser-hardening.js
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt, cdpAt } = require('./rig.js');

const { check, done } = checker();
const HOSTS = ['--host-resolver-rules=MAP *.example 127.0.0.1'];

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** Every page of the fixture server, by path; `hits` records each request's path. */
function fixtures(P) {
  return {
    '/landing.html': page('Landing', '<h1>Landing</h1><p>Plain page.</p>'),
  };
}

(async () => {
  const hits = [];
  let routes = {};
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const r = routes[req.url.split('?')[0]];
    if (!r) {
      res.writeHead(404);
      return res.end();
    }
    const body = typeof r === 'string' ? r : r.body;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(typeof r === 'string' ? {} : r.headers) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const P = server.address().port;
  routes = fixtures(P);
  const SHOP = `http://shop.example:${P}`;
  const LOCAL = `http://127.0.0.1:${P}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-browser-hardening-'));
  const app = await launch({ profile, mode: 'ask', mock: true, args: HOSTS, config: { browser: { alwaysAllowed: [`shop.example:${P}`, `other.example:${P}`] } } });
  const dbg = () => app.evaluate('window.__oc_debug.mods.browser()');
  const activeTab = async () => {
    const d = await dbg();
    return d.tabs.find((t) => t.id === d.activeId);
  };

  try {
    // ---------- 1. An HTML artifact sends nothing out ----------
    const beacon = `<!doctype html><html><head><meta charset="utf-8"><title>Beacon</title>
<link rel="stylesheet" href="${LOCAL}/beacon/css">
<script src="${LOCAL}/beacon/script.js"></script></head><body>
<h1>Chart</h1>
<img src="${LOCAL}/beacon/img?d=secret">
<form action="${LOCAL}/beacon/form" method="get"><input name="d" value="secret"></form>
<script>
  window.__errors = [];
  fetch('${LOCAL}/beacon/fetch?d=secret').catch((e) => __errors.push('fetch'));
  try { navigator.sendBeacon('${LOCAL}/beacon/sendbeacon', 'secret'); } catch (e) { __errors.push('beacon'); }
  try { new Worker(URL.createObjectURL(new Blob(["fetch('${LOCAL}/beacon/worker?d=secret').catch(() => {})"], { type: 'text/javascript' }))); } catch (e) { __errors.push('worker'); }
  try { new WebSocket('ws://127.0.0.1:${P}/beacon/ws'); } catch (e) { __errors.push('ws'); }
  setTimeout(() => { try { document.forms[0].submit(); } catch (e) {} }, 300);
  setTimeout(() => { window.open('${LOCAL}/beacon/open?d=secret'); }, 600);
  setTimeout(() => { location.href = '${LOCAL}/beacon/nav?d=secret'; }, 900);
</script></body></html>`;
    let r = await app.callTool('create_artifact', { title: 'Beacon', kind: 'html', content: beacon });
    check('setup: create_artifact made the page', /art-1/.test(r ?? ''), r);
    await app.waitFor(`window.__oc_debug.mods.browser().tabs.some((t) => t.url.startsWith('artifact:'))`, 10_000, 'the artifact in the pane');
    await sleep(2500);
    const beacons = hits.filter((h) => h.startsWith('/beacon'));
    check('the fixture server saw no request from the artifact (img, fetch, sendBeacon, worker, WebSocket, form, CSS, script, window.open, location)', beacons.length === 0, beacons);
    let tab = await activeTab();
    check('… the tab is still on the artifact', tab && tab.url.startsWith('artifact://view/'), tab);
    check('… and the blocked-popup strip offers the address it wanted, for the user to open', tab && tab.blockedPopups >= 1 && /\/beacon\/(nav|open)/.test(tab.blockedPopupUrl ?? ''), tab);
    const tabsAfter = (await dbg()).tabs.length;
    check('… no tab was opened for it', tabsAfter === 1, tabsAfter);
    const art = await app.pageTarget('artifact://', 5000);
    const csp = await evalAt(art, `fetch(location.href).then((r) => r.headers.get('content-security-policy'), (e) => 'blocked: ' + e.message)`);
    check("the artifact's own response carries the CSP (connect-src 'none' also stops a fetch of itself)", /blocked/.test(String(csp)), csp);
    // Chromium must understand every directive (it does not know webrtc 'block', so the policy leaves it out)
    const logs = await consoleOf(art, () => cdpAt(art, 'Page.reload', {}));
    check('the policy has no directive Chromium ignores', logs.length > 0 && !logs.some((l) => /Unrecognized Content-Security-Policy/i.test(l)), logs.filter((l) => /Unrecognized/.test(l)));
    check('… and the reload is blocked the same way (CSS and script refused by the CSP)', logs.some((l) => /violates the following Content Security Policy directive: "style-src/.test(l)) && logs.some((l) => /directive: "script-src/.test(l)));
  } finally {
    await app.close();
    server.close();
  }
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});

/** The console messages and log entries of a target while `run` happens (and 1.5 s after). */
async function consoleOf(wsUrl, run) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const out = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.method === 'Runtime.consoleAPICalled') out.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Log.entryAdded') out.push(`${m.params.entry.level}: ${m.params.entry.text}`);
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
  ws.send(JSON.stringify({ id: 2, method: 'Log.enable' }));
  await sleep(200);
  await run();
  await sleep(1500);
  ws.close();
  return out;
}
