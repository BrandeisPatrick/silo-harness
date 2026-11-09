// Live check of popups in the real app against the fixture site: a sized window.open becomes a card over the pane
// whose page is the one Electron made for the opener (window.opener and postMessage work), the card goes when the
// popup closes itself, a cookie the popup set is the opener's too (one profile), a target="_blank" link becomes a
// tab, a fourth popup is refused and counted, cards move and close through the RPC and through their own bar's ×.
// Run: npm run build && node test/live/browser-oauth.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt } = require('./rig.js');
const { startSite } = require('./support/site.js');

const { check, done } = checker();

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const site = await startSite();
  const app = await launch({ mode: 'bypass', mock: true });
  const dbg = () => app.evaluate('window.__oc_debug.mods.browser()');
  const popups = () => app.evaluate('window.__oc_debug.mods.browser().popups');
  const waitPopups = (n, what = `${n} popups`) => app.waitFor(`window.__oc_debug.mods.browser().popups.length === ${n}`, 10_000, what);

  try {
    let r = await app.callTool('browser_navigate', { url: `${site.base}/popup.html` });
    check('the opener page is in the pane', /Popup opener/.test(r ?? ''), r);
    const ws = await app.pageTarget(`${site.base}/popup.html`);
    const paneBounds = (await dbg()).bounds;

    // ---------- The sign-in popup: opened, reports back, closes itself ----------
    const opened = await evalAt(ws, 'openPopup()');
    check('window.open with a size returns a window to the page', opened === 'opened', opened);
    await waitPopups(1, 'the popup card');
    let list = await popups();
    const p = list[0];
    check('the renderer is told of the card: its tab, url, and bounds the size asked for', list.length === 1 && p.tabId === (await dbg()).activeId && /popup-child\.html|about:blank/.test(p.url) && p.bounds.width === 420 && p.bounds.height === 560, p);
    check('… centred over the pane, under a 32 px bar', Math.abs(p.bounds.x + p.bounds.width / 2 - (paneBounds.x + paneBounds.width / 2)) <= 1 && p.bounds.y - 32 >= paneBounds.y && p.bounds.y + p.bounds.height <= paneBounds.y + paneBounds.height, { popup: p.bounds, pane: paneBounds });
    await waitPopups(0, 'the popup to close itself');
    const msgs = await evalAt(ws, 'JSON.stringify(window.__msgs)');
    const parsed = JSON.parse(msgs || '[]');
    check('the opener received the popup\'s postMessage: it had window.opener and the token came through', parsed.length === 1 && parsed[0].type === 'oauth-done' && parsed[0].token === 'fixture-token' && parsed[0].hasOpener === true, parsed);
    check('… at the size the card gave it', parsed[0] && parsed[0].innerWidth === 420 && parsed[0].innerHeight === 560, parsed[0]);
    check('the opener sees the popup closed', (await evalAt(ws, 'window.__popup ? window.__popup.closed : "no handle"')) === true);
    const cookie = await evalAt(ws, 'document.cookie');
    check('a cookie the popup set is the opener\'s too: one profile for both', /site_popup=1/.test(cookie), cookie);
    const stray = (await app.pageTargets(`${site.base}/popup-child`)).length;
    check('the popup\'s page is gone', stray === 0, stray);

    // ---------- A target=_blank link becomes a tab ----------
    const tabsBefore = (await dbg()).tabs.length;
    await evalAt(ws, `document.getElementById('blank').click()`);
    await app.waitFor(`window.__oc_debug.mods.browser().tabs.some((t) => t.url === ${JSON.stringify(`${site.base}/landing.html`)})`, 10_000, 'a tab from the _blank link');
    let d = await dbg();
    const landing = d.tabs.find((t) => t.url === `${site.base}/landing.html`);
    check('the _blank link opened a tab, in front', Boolean(landing) && d.activeId === landing.id && (await popups()).length === 0, d.tabs.map((t) => t.url));
    const opener = d.tabs[0].id;
    await app.evaluate(`oc.rpc('browser.activateTab', ${JSON.stringify(opener)})`);
    await sleep(200);
    const plain = await evalAt(ws, `window.open('/landing.html') ? 'opened' : 'null'`);
    await app.waitFor(`window.__oc_debug.mods.browser().tabs.length === ${tabsBefore + 2}`, 10_000, 'a tab from a plain window.open');
    check('window.open without a size is a tab too (the page gets no handle)', plain === 'null' && (await dbg()).tabs.length === tabsBefore + 2 && (await popups()).length === 0, plain);
    await app.evaluate(`oc.rpc('browser.activateTab', ${JSON.stringify(opener)})`);
    await sleep(200);

    // ---------- Three stay open; the fourth is refused ----------
    for (const n of [1, 2, 3]) check(`popup ${n} opens`, (await evalAt(ws, `openStay(${n})`)) === 'opened');
    await waitPopups(3, 'three popup cards');
    const fourth = await evalAt(ws, 'openStay(4)');
    await sleep(300);
    d = await dbg();
    const tab = d.tabs.find((t) => t.id === opener);
    check('a fourth popup is refused: the page gets null and the tab counts it', fourth === 'null' && (await popups()).length === 3 && tab && tab.blockedPopups === 1, { fourth, blocked: tab && tab.blockedPopups });
    list = await popups();
    check('the cards carry their titles once loaded', list.every((q) => /Stays open|about:blank|popup-stay/.test(q.title + q.url)), list.map((q) => [q.title, q.url]));
    await app.screenshotOf(path.join(shots, 'oauth-1-three-popups.png'), '#side-pane', 0);

    // ---------- Move, close through the RPC, close through the bar ----------
    // The refused popup put the blocked-popup strip under the URL bar, which takes its height out of the page's slot:
    // the pane the cards are kept in is the slot as it is now.
    await app.waitFor(`window.__oc_debug.mods.browser().bounds.y > ${paneBounds.y}`, 5000, 'the slot under the blocked-popup strip').catch(() => undefined);
    const slot = (await dbg()).bounds;
    check('the blocked-popup strip takes its height out of the page\'s slot', slot.y > paneBounds.y && Math.round(paneBounds.y + paneBounds.height) === Math.round(slot.y + slot.height), { before: paneBounds, after: slot });
    const moving = list[0];
    await app.evaluate(`oc.rpc('browser.movePopup', ${JSON.stringify(moving.id)}, ${slot.x + 10}, ${slot.y + 10})`);
    await sleep(150);
    let moved = (await popups()).find((q) => q.id === moving.id);
    check('browser.movePopup puts the card where the bar\'s corner was dragged to', moved && moved.bounds.x === Math.round(slot.x + 10) && moved.bounds.y === Math.round(slot.y + 10) + 32, moved && moved.bounds);
    await app.evaluate(`oc.rpc('browser.movePopup', ${JSON.stringify(moving.id)}, 99999, 99999)`);
    await sleep(150);
    moved = (await popups()).find((q) => q.id === moving.id);
    check('… and keeps it inside the pane', moved && moved.bounds.x + moved.bounds.width <= slot.x + slot.width && moved.bounds.y + moved.bounds.height <= slot.y + slot.height, moved && moved.bounds);
    await app.evaluate(`oc.rpc('browser.closePopup', ${JSON.stringify(moving.id)})`);
    await waitPopups(2, 'the card closed through the RPC');
    check('browser.closePopup closes a card', (await popups()).every((q) => q.id !== moving.id));
    // The bar is a small page of ours: its × reaches the main process through its preload.
    const bars = await app.pageTargets('data:text/html');
    check('each card has a bar page of its own', bars.length === 2, bars.length);
    if (bars.length) {
      const barTitle = await evalAt(bars[0].wsUrl, `({ title: document.getElementById('title').textContent, host: document.getElementById('host').textContent })`);
      check('the bar shows the popup\'s title and host in its own page', barTitle && barTitle.title === 'Stays open' && barTitle.host === site.host, barTitle);
      await evalAt(bars[0].wsUrl, `document.getElementById('x').click()`);
      await waitPopups(1, 'the card closed by its ×');
      check('the bar\'s × closes its card', (await popups()).length === 1);
    }
    // The pane hides: the cards do too (nothing to read from here but no error); a tab closing takes its popups
    await app.evaluate(`oc.rpc('browser.closeTab', ${JSON.stringify(opener)})`);
    await waitPopups(0, 'the last card to go with its tab');
    check('closing the tab closes its remaining popup', (await popups()).length === 0 && !(await dbg()).tabs.some((t) => t.id === opener));

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${shots}`);
  } finally {
    await app.close();
    site.close();
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
