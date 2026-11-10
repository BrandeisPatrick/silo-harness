// Live check that a web page cannot make part of the Browser pane a window-drag area: a page that declares
// -webkit-app-region: drag (Teams' loading splash does, over its whole viewport) would otherwise take every mouse
// press there to drag the window, and Electron keeps that region over every later page in the tab. Read from
// Electron's own region debugger (ELECTRON_DEBUG_DRAGGABLE_REGIONS), which logs each update a webContents sends:
// a tab's page ends at 0 drag regions and 0 hit-test rects, while the app's own window keeps its title bar. Popup
// cards are read from their pages' computed style in a second run (the debugger hangs on a popup card, see below).
// The debugger is in development Electron only, so against a packaged app (SILO_HARNESS_LIVE_APP) this is skipped.
// Run: npm run build && node test/live/browser-drag-regions.js
const fs = require('node:fs');
const http = require('node:http');
const { launch, checker, sleep, evalAt } = require('./rig.js');

const { check, done } = checker();

const DRAG = `<div style="height: 100vh; overflow: hidden; -webkit-app-region: drag;">Loading…</div>`;
const PAGES = {
  '/drag': `<!doctype html><title>Loading app</title><body style="margin:0">${DRAG}`,
  '/plain': `<!doctype html><title>Sign in</title><h1>Sign in</h1><input id="i"><button id="b">Next</button>`,
  '/every': `<!doctype html><title>Every way to drag</title>
<style>
  html { -webkit-app-region: drag !important; } body { app-region: drag; margin: 0; }
  .bar { position: fixed; top: 0; left: 0; width: 100%; height: 64px; -webkit-app-region: drag !important; }
  .p::before { content: 'x'; display: block; height: 50px; -webkit-app-region: drag; }
  .q::after { content: 'y'; display: block; height: 50px; -webkit-app-region: drag !important; }
  dialog { -webkit-app-region: drag; } dialog::backdrop { -webkit-app-region: drag; }
</style>
<div class="bar"></div><div class="p"></div><div class="q"></div>
<div style="height: 100vh; -webkit-app-region: drag !important">inline</div>
<div id="host"></div><dialog id="d">dialog</dialog>
<script>
  host.attachShadow({ mode: 'open' }).innerHTML = '<div style="height: 80px; -webkit-app-region: drag">shadow</div>';
  d.showModal();
  setTimeout(() => { const e = document.createElement('div'); e.style.cssText = 'height: 40px; -webkit-app-region: drag'; document.body.append(e); }, 400);
</script>`,
  // A plain page that rewrites itself into a drag page after it loaded
  '/rewrite': `<!doctype html><title>Rewrite</title><h1>plain</h1><script>setTimeout(() => { document.open(); document.write(${JSON.stringify(`<!doctype html><title>Rewritten</title><body style="margin:0">${DRAG}`)}); document.close(); }, 300);</script>`,
  // Opens a sized popup (a card over the pane) holding the drag page, or a blank one it writes a drag page into
  '/opener': `<!doctype html><title>Opener</title><h1>Opener</h1><script>
  function openDrag() { return window.open('/drag?popup', 'dragpopup', 'width=420,height=360') ? 'opened' : 'null'; }
  function openBlank() { const w = window.open('', 'blankpopup', 'width=420,height=360'); if (!w) return 'null'; w.document.write(${JSON.stringify(`<!doctype html><title>Written</title><body style="margin:0">${DRAG}`)}); w.document.close(); return 'opened'; }
</script>`,
};

(async () => {
  if (process.env.SILO_HARNESS_LIVE_APP) {
    console.log('SILO_HARNESS_LIVE_APP is set: Electron\'s draggable-region debugger is in development builds only, so a packaged app cannot show the regions. Skipped.');
    process.exit(0);
  }
  const server = http.createServer((req, res) => {
    const page = PAGES[req.url.split('?')[0]];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page || 'not here');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const one = `http://127.0.0.1:${port}`;
  const two = `http://localhost:${port}`;
  // --inspect: the main process, to tell which webContents is the tab and which the app's own window
  const inspectPort = 20000 + Math.floor(Math.random() * 20000);
  const app = await launch({ mode: 'bypass', mock: true, env: { ELECTRON_DEBUG_DRAGGABLE_REGIONS: '1', ELECTRON_ENABLE_LOGGING: '1' }, args: [`--inspect=${inspectPort}`, '--enable-logging'] });
  // The rig keeps the last 2000 log lines; the region lines are kept here from the start, so the window's own survive.
  const regions = [];
  const take = (line) => {
    const m = /\[draggable-regions\] webContents (\d+): update #(\d+)[^:]*: renderer sent (\d+) region\(s\) \((\d+) drag, (\d+) no-drag\);.*?: (\d+) rect\(s\)(?:, bounds (\S+) (\d+)x(\d+))?/.exec(line);
    if (m) regions.push({ id: +m[1], n: +m[2], drag: +m[4], noDrag: +m[5], rects: +m[6], bounds: m[7] ? { origin: m[7], w: +m[8], h: +m[9] } : null, line: line.replace(/^.*\[draggable-regions\] /, '') });
  };
  app.logs.forEach(take);
  const push = app.logs.push;
  app.logs.push = function (...lines) {
    lines.forEach(take);
    return push.apply(this, lines);
  };
  const last = (id) => regions.filter((r) => r.id === id).pop() || null;
  const count = (id) => regions.filter((r) => r.id === id).length;
  const mainWs = async () => (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0].webSocketDebuggerUrl;
  const mainEval = async (expr) => evalAt(await mainWs(), expr);
  const E = `process.mainModule.require('electron')`;
  /** The id of the webContents (other than the app's window) whose URL starts with `prefix`. */
  const idOf = (prefix) => mainEval(`(${E}.webContents.getAllWebContents().find((w) => w.getURL().startsWith(${JSON.stringify(prefix)})) || { id: null }).id`);
  /** Waits for a region update from `id` after `before` of them, then for the page to settle (late elements, rewrites). */
  const settle = async (id, before, what) => {
    const until = Date.now() + 10_000;
    while (count(id) <= before && Date.now() < until) await sleep(100);
    await sleep(1200);
    if (count(id) <= before) console.log(`(no region update from webContents ${id} for ${what})`);
    return count(id) > before;
  };
  const shown = (r) => (r ? r.line.replace(/hit-test region computed in [^:]+: /, '') : 'no update');

  try {
    const winId = await mainEval(`${E}.BrowserWindow.getAllWindows()[0].webContents.id`);

    // ---------- A page whose whole viewport is a drag area ----------
    let r = await app.callTool('browser_navigate', { url: `${one}/drag` });
    check('the drag page is in the tab', /Loading app/.test(r ?? ''), String(r).split('\n')[0]);
    const tab = await idOf(`${one}/drag`);
    check('the tab\'s webContents is found, and is not the window\'s', typeof tab === 'number' && tab !== winId, { tab, winId });
    await settle(tab, 0, 'the drag page');
    let l = last(tab);
    check('a page that is all drag area leaves the tab no drag region: 0 drag, 0 rects', l && l.drag === 0 && l.rects === 0, shown(l));

    // ---------- Then a plain page on another site: nothing left over ----------
    let before = count(tab);
    r = await app.callTool('browser_navigate', { url: `${two}/plain` });
    check('a plain page on another site loads in the same tab', /Sign in/.test(r ?? '') && (await idOf(`${two}/plain`)) === tab, String(r).split('\n')[0]);
    const arrived = await settle(tab, before, 'the plain page');
    l = last(tab);
    check('… sends a region update of its own, which leaves 0 rects (the drag page\'s region does not stay)', arrived && l && l.rects === 0, shown(l));

    // ---------- Every way a page can declare drag ----------
    before = count(tab);
    r = await app.callTool('browser_navigate', { url: `${one}/every` });
    check('the every-way page loads', /Every way to drag/.test(r ?? ''), String(r).split('\n')[0]);
    await settle(tab, before, 'the every-way page');
    await sleep(600);
    l = last(tab);
    check('html !important, body, a fixed bar, ::before/::after, inline !important, shadow DOM, a modal dialog and its ::backdrop, a late element: 0 drag, 0 rects', l && l.drag === 0 && l.rects === 0, shown(l));

    before = count(tab);
    await app.callTool('browser_navigate', { url: `${two}/rewrite` });
    await settle(tab, before, 'the rewrite page');
    await sleep(800);
    l = last(tab);
    const title = await mainEval(`${E}.webContents.fromId(${tab}).getTitle()`);
    check('a page that rewrites itself into a drag page with document.open: 0 drag, 0 rects', title === 'Rewritten' && l && l.drag === 0 && l.rects === 0, { title, last: shown(l) });

    // ---------- The app's own window keeps its title bar ----------
    l = last(winId);
    const top = l && l.bounds ? Number(l.bounds.origin.split(',')[1]) + l.bounds.h : Infinity;
    check('the app\'s own window still has its drag region: rects, within the top 45 px', l && l.rects > 0 && top <= 45, shown(l));
  } finally {
    // With logging on, the profile can still be written to as close() removes it: try again a moment later
    await app.close().catch(() => sleep(1000).then(() => fs.rmSync(app.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
  }

  // ---------- Popup cards, in a second run without the region debugger ----------
  // With ELECTRON_DEBUG_DRAGGABLE_REGIONS set, making a popup card (any page, with or without the fix) spins the
  // main process at full CPU for good, so the popups are read from their pages instead: the drag element's computed
  // app-region (none once the user style sheet is in, drag without it) and the root's (no-drag with it).
  const app2 = await launch({ mode: 'bypass', mock: true });
  const REGION = `(() => { const v = (el) => { const s = getComputedStyle(el); return s.getPropertyValue('app-region') || s.getPropertyValue('-webkit-app-region'); }; return document.readyState + ' ' + document.title + ': div ' + v(document.querySelector('body > div')) + ', root ' + v(document.documentElement); })()`;
  try {
    const r = await app2.callTool('browser_navigate', { url: `${one}/opener` });
    check('the opener page loads', /Opener/.test(r ?? ''), String(r).split('\n')[0]);
    const ws = await app2.pageTarget(`${one}/opener`);
    const port = new URL(ws).port;
    check('a sized window.open of the drag page is allowed', (await evalAt(ws, 'openDrag()')) === 'opened');
    await app2.waitFor('window.__oc_debug.mods.browser().popups.length === 1', 10_000, 'the popup card');
    const dragWs = await app2.pageTarget(`${one}/drag?popup`);
    await sleep(800);
    const inDrag = await evalAt(dragWs, REGION);
    check('the popup card\'s drag page: its drag element computes to none and its root to no-drag', inDrag === 'complete Loading app: div none, root no-drag', inDrag);

    // A blank popup the opener writes a drag page into: no navigation commits in it, so no did-navigate
    check('a sized blank window.open the opener writes into is allowed', (await evalAt(ws, 'openBlank()')) === 'opened');
    await app2.waitFor('window.__oc_debug.mods.browser().popups.length === 2', 10_000, 'the second popup card');
    await sleep(800);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    // The card's bar (a data: page of ours) carries the popup's title too
    const written = list.find((t) => t.type === 'page' && t.title === 'Written' && !t.url.startsWith('data:'));
    const inWritten = written ? await evalAt(written.webSocketDebuggerUrl, REGION) : 'no page titled Written';
    check('a blank popup written into as a drag page: div none, root no-drag', inWritten === 'complete Written: div none, root no-drag', inWritten);
  } finally {
    await app2.close();
    server.close();
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
