// Live check that each session has its own browser tabs, in the real app with the mock model calling the browser
// tools on local pages this script serves: a new session starts with a blank tab of its own; tabs never leak from one session to the
// other; switching session swaps the strip and the page; a session's agent navigates, reads, takes a screenshot,
// clicks and types on its own tab while another session is in front, and none of it shows there; a popup from that
// background tab waits until its session is opened; a link from the chat opens in the session in front; deleting a
// session closes its tabs; a fork starts with a blank tab.
// Run: npm run build && node test/live/session-tabs.js [screenshot-dir]
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt } = require('./rig.js');

const { check, done } = checker();

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const PAGES = {
  '/a.html': page('Page A', '<h1>Session A</h1>'),
  '/b.html': page('Page B', '<h1>Session B</h1>'),
  '/link.html': page('Chat link', '<h1>From the chat</h1>'),
  '/form.html': page(
    'Form',
    `<h1>A form for the agent</h1>
<p id="said">Nothing pressed</p>
<p><button id="press" type="button" onclick="document.getElementById('said').textContent = 'Pressed at ' + document.visibilityState; window.__pressed = true">Press me</button></p>
<p><label>Name <input id="name" type="text"></label></p>
<p><button id="pop" type="button" onclick="window.__pop = window.open('/pop-child.html', 'pop', 'width=400,height=300') ? 'opened' : 'null'">Open a popup</button></p>`,
  ),
  '/pop-child.html': page('A popup', '<h1>A popup that stays</h1>'),
};

function startPages() {
  const server = http.createServer((req, res) => {
    const body = PAGES[new URL(req.url, 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/** The PNG's size from its header. */
const pngSize = (file) => {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const site = await startPages();
  const app = await launch({ mode: 'bypass', mock: true });
  const dbg = () => app.evaluate('window.__oc_debug.mods.browser()');
  const tabs = () => app.evaluate('oc.rpc("browser.tabs")');
  const current = () => app.evaluate('oc.sessions.current().then((s) => s.id)');
  const openSession = async (id) => {
    await app.click(`.session-item[data-id="${id}"]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${JSON.stringify(id)}`, 10_000, `session ${id} on screen`);
    await sleep(400);
  };
  const strip = async () => (await dbg()).drawn.map((t) => t.title);
  /** One blank tab, drawn as "New tab", with the New tab page over it */
  const blankOnly = async () => {
    const t = await tabs();
    const dd = await dbg();
    const ntp = await app.evaluate(`!document.querySelector('#new-tab-page').hidden`);
    return { ok: t.length === 1 && (!t[0].url || t[0].url === 'about:blank') && JSON.stringify(dd.drawn.map((x) => x.title)) === '["New tab"]' && ntp && dd.visible === false, t, drawn: dd.drawn, ntp };
  };

  try {
    // ---------- A new session starts with no tabs ----------
    const A = await current();
    let d = await dbg();
    let blank = await blankOnly();
    check('a new session starts with one blank tab: "New tab" in the strip, the New tab page, no view', blank.ok, blank);
    let r = await app.callTool('browser_navigate', { url: `${site.base}/a.html` });
    await app.waitFor(`window.__oc_debug.mods.browser().drawn.some((t) => t.title === 'Page A')`, 10_000, "A's tab in the strip");
    const tabsA = await tabs();
    check("A's agent opens a page: it takes the blank tab's place (one tab, at that page)", /Page A/.test(r ?? '') && tabsA.length === 1 && tabsA[0].url === `${site.base}/a.html`, tabsA);

    // ---------- Session B: its own, none of A's ----------
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('#empty-state') && !document.querySelector('#empty-state').hidden`, 10_000, 'the new session');
    await sleep(400);
    const B0 = await current();
    blank = await blankOnly();
    check("a second session shows none of A's tabs: a blank tab of its own", B0 !== A && blank.ok && blank.t[0].id !== tabsA[0].id, blank);
    r = await app.callTool('browser_navigate', { url: `${site.base}/b.html` });
    const B = await current();
    await app.waitFor(`window.__oc_debug.mods.browser().drawn.some((t) => t.title === 'Page B')`, 10_000, "B's tab in the strip");
    const tabsB = await tabs();
    check("B's agent opens a page in B's own tab, not in A's", /Page B/.test(r ?? '') && tabsB.length === 1 && tabsB[0].url === `${site.base}/b.html` && tabsB[0].id !== tabsA[0].id && !(await strip()).includes('Page A'), { tabsB, strip: await strip() });
    await app.screenshotOf(path.join(shots, 'session-tabs-1-b.png'), '#side-pane', 0);

    // ---------- Switching swaps the strip and the page ----------
    await openSession(A);
    d = await dbg();
    check("back on A: the strip shows A's tab only, the URL bar A's page, the page view shows", JSON.stringify(await strip()) === '["Page A"]' && (await app.evaluate(`document.querySelector('#url').value`)) === `${site.base}/a.html` && d.visible === true, { strip: await strip(), visible: d.visible });
    await app.screenshotOf(path.join(shots, 'session-tabs-2-a.png'), '#side-pane', 0);
    await openSession(B);
    check("on B again: B's tab only", JSON.stringify(await strip()) === '["Page B"]' && (await app.evaluate(`document.querySelector('#url').value`)) === `${site.base}/b.html`);

    // ---------- A's agent works on its own tab while B is in front ----------
    await openSession(A);
    const mock = app.mock;
    const ids = ['bg_nav', 'bg_read', 'bg_shot', 'bg_click', 'bg_type', 'bg_pop'];
    const afterTool = (prev) => (p) => {
      const m = p.messages?.[p.messages.length - 1];
      return Boolean(m && m.role === 'tool' && m.tool_call_id === prev);
    };
    const steps = [
      { id: 'bg_nav', name: 'browser_navigate', args: { url: `${site.base}/form.html` } },
      { id: 'bg_read', name: 'browser_read_page', args: {} },
      { id: 'bg_shot', name: 'browser_screenshot', args: {} },
      { id: 'bg_click', name: 'browser_click', args: { text: 'Press me' } },
      { id: 'bg_type', name: 'browser_type', args: { field: 'Name', text: 'Ada Example' } },
      { id: 'bg_pop', name: 'browser_click', args: { text: 'Open a popup' } },
    ];
    steps.forEach((s, i) =>
      mock.state.replies.push({
        content: '',
        toolCalls: [{ id: s.id, name: s.name, args: s.args }],
        // The first waits, so that B is in front before the agent starts
        ...(i === 0 ? { delayMs: 2500, when: (p) => JSON.stringify(p.messages?.[p.messages.length - 1] ?? '').includes('Work behind') } : { when: afterTool(steps[i - 1].id) }),
      }),
    );
    mock.state.replies.push({ content: 'BG DONE', when: afterTool('bg_pop') });
    await app.send('Work behind');
    await app.waitFor(`Boolean(document.querySelector('.session-item.running'))`, 10_000, 'A to run');
    await openSession(B);
    // While A works: B's strip, tabs and popups never change
    const seen = new Set();
    let leaked = null;
    const until = Date.now() + 60_000;
    for (;;) {
      const t = await tabs();
      const dd = await dbg();
      for (const x of t) seen.add(x.url);
      if (t.length !== 1 || t[0].id !== tabsB[0].id || dd.popups.length || dd.drawn.length !== 1 || dd.activeId !== tabsB[0].id) leaked = leaked ?? { t, drawn: dd.drawn, popups: dd.popups };
      const running = await app.evaluate(`Boolean(document.querySelector('.session-item.running'))`);
      if (!running || Date.now() > until) break;
      await sleep(150);
    }
    const result = (id) => {
      for (const req of [...mock.state.requests].reverse()) {
        const m = (req.payload?.messages ?? []).find((x) => x.role === 'tool' && x.tool_call_id === id);
        if (m) return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      }
      return null;
    };
    check('while A worked, B kept only its own tab in the strip and in front, and no popup', !leaked && [...seen].join() === `${site.base}/b.html`, leaked ?? [...seen]);
    check("A's navigate worked behind", /Now at .*form\.html/.test(result('bg_nav') ?? ''), result('bg_nav'));
    check("A's read worked behind (the outline with refs)", /Press me/.test(result('bg_read') ?? '') && /ref_\d+/.test(result('bg_read') ?? ''), (result('bg_read') ?? '').slice(0, 200));
    const shotText = result('bg_shot') ?? '';
    check("A's screenshot worked behind", shotText && !/^Error|refused|failed/i.test(shotText), shotText.slice(0, 300));
    const shotFile = /\/[^\s"]*shot-\d+\.png/.exec(shotText)?.[0];
    if (shotFile && fs.existsSync(shotFile)) {
      const size = pngSize(shotFile);
      check('… the image has the size of a page, not an empty one', size.width > 300 && size.height > 200, size);
      fs.copyFileSync(shotFile, path.join(shots, 'session-tabs-3-background-shot.png'));
    } else console.log(`     (no screenshot path in the result to measure: ${shotText.slice(0, 120)})`);
    check("A's click worked behind", /Clicked/.test(result('bg_click') ?? ''), result('bg_click'));
    check("A's typing worked behind", /Typed "Ada Example"/.test(result('bg_type') ?? ''), result('bg_type'));
    const formWs = await app.pageTarget(`${site.base}/form.html`);
    const inPage = await evalAt(formWs, `({ said: document.getElementById('said').textContent, name: document.getElementById('name').value, pop: window.__pop ?? null, visibility: document.visibilityState })`);
    check("… and the page in A's tab has the click and the text", /^Pressed/.test(inPage?.said ?? '') && inPage?.name === 'Ada Example', inPage);
    console.log(`     (the background page's visibility: ${inPage?.visibility}; the click landed while it was ${(inPage?.said ?? '').replace('Pressed at ', '')})`);
    check("A's popup click opened a popup in A, not shown over B", inPage?.pop === 'opened' && (await dbg()).popups.length === 0, { pop: inPage?.pop, popups: (await dbg()).popups });
    check('B still shows its own page', JSON.stringify(await strip()) === '["Page B"]' && (await app.evaluate(`document.querySelector('#url').value`)) === `${site.base}/b.html`);
    await app.screenshotOf(path.join(shots, 'session-tabs-4-b-while-a-worked.png'), '#side-pane', 0);

    // ---------- Opening A: its page and its popup ----------
    await openSession(A);
    await app.waitFor(`window.__oc_debug.mods.browser().popups.length === 1`, 5000, "A's popup").catch(() => undefined);
    d = await dbg();
    check("opening A shows A's form page and the popup that waited", d.drawn.some((t) => t.title === 'Form' && t.active) && d.popups.length === 1 && /pop-child/.test(d.popups[0].url), { drawn: d.drawn, popups: d.popups });
    await app.screenshotOf(path.join(shots, 'session-tabs-5-a-popup.png'), '#side-pane', 0);
    await app.evaluate(`oc.rpc('browser.closePopup', ${JSON.stringify(d.popups[0]?.id ?? '')})`).catch(() => undefined);

    // ---------- A link from the chat opens in the session in front ----------
    await app.evaluate(`(async () => { const c = await oc.getConfig(); c.browser = { ...c.browser, openChatLinksInPane: true }; await oc.setConfig(c); })()`);
    await openSession(B);
    await app.evaluate(`window.open(${JSON.stringify(`${site.base}/link.html`)})`);
    await app.waitFor(`(async () => (await oc.rpc('browser.tabs')).some((t) => t.url === ${JSON.stringify(`${site.base}/link.html`)}))()`, 10_000, 'the link in B').catch(() => undefined);
    const linkB = await tabs();
    check('a link clicked in the chat opens in a tab of the session in front (B)', linkB.length === 2 && linkB.some((t) => t.url === `${site.base}/link.html`), linkB.map((t) => t.url));
    await openSession(A);
    check("… and not in A's", !(await tabs()).some((t) => t.url === `${site.base}/link.html`), (await tabs()).map((t) => t.url));

    // ---------- Deleting a session closes its tabs ----------
    const bPages = async () => (await app.pageTargets(`${site.base}/b.html`)).length + (await app.pageTargets(`${site.base}/link.html`)).length;
    check("B's pages are open before B is deleted", (await bPages()) === 2);
    await app.evaluate(`oc.sessions.delete(${JSON.stringify(B)})`);
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      gone = (await bPages()) === 0;
      if (!gone) await sleep(150);
    }
    check("deleting B closes B's tabs; A keeps its own", gone && (await tabs()).some((t) => t.url === `${site.base}/form.html`), { gone, a: (await tabs()).map((t) => t.url) });

    // ---------- A fork starts with no tabs ----------
    const fork = await app.evaluate(`oc.sessions.fork(${JSON.stringify(A)}).then((s) => s.id)`);
    await app.evaluate(`oc.sessions.switch(${JSON.stringify(fork)})`);
    await sleep(400);
    const forked = await tabs();
    check("a fork of A starts with a blank tab of its own, none of A's", fork && fork !== A && forked.length === 1 && (!forked[0].url || forked[0].url === 'about:blank'), forked);
  } catch (err) {
    check(`no exception (${err.message})`, false);
  } finally {
    await app.close();
    site.close();
    console.log(`Screenshots: ${shots}`);
  }
  process.exit(done() ? 1 : 0);
})();
