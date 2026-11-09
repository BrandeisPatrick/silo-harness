// Live check of the Browser pane's tabs in the real app, with the mock model scripted to call the browser tools and
// the fixture site from support/site.js: the strip (one tab and the +, then more), the + button, the one-time
// profile note, browser_tabs (list, new, select, close), a ⌘-click on a link, the shortcuts (⌘⇧N, ⌘W in the pane's
// chrome and inside the page), the cap at 12, and that closing the last tab leaves a blank one.
// Run: npm run build && node test/live/browser-tabs.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt, cdpAt } = require('./rig.js');

/** A tab's URL before its first page commits is empty; both read as blank. */
const isBlank = (url) => !url || url === 'about:blank';
const { startSite } = require('./support/site.js');

const { check, done } = checker();

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const site = await startSite();
  // A profile whose browser was migrated last time, with sign-ins that came along: the note is due once.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-browser-tabs-'));
  fs.mkdirSync(path.join(profile, 'browser'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'browser', 'profile.json'), JSON.stringify({ migrated: true, copied: 3, failed: 0, at: new Date().toISOString(), noteDue: true }));
  // --inspect: the main process's own input path, for the shortcuts pressed inside a page (CDP-injected keys skip it)
  const inspectPort = 20000 + Math.floor(Math.random() * 20000);
  const app = await launch({ profile, mode: 'bypass', mock: true, args: [`--inspect=${inspectPort}`] });
  const mainWs = async () => (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0].webSocketDebuggerUrl;
  const mainEval = async (expr) => evalAt(await mainWs(), expr);
  const dbg = () => app.evaluate('window.__oc_debug.mods.browser()');
  const tabs = () => app.evaluate('oc.rpc("browser.tabs")');
  const state = () => app.evaluate('oc.browser.state()');
  const waitTabs = (n, what = `${n} tabs`) => app.waitFor(`(async () => (await oc.rpc('browser.tabs')).length === ${n})()`, 10_000, what);
  const waitTabAt = (url, what = `a tab at ${url}`) => app.waitFor(`(async () => (await oc.rpc('browser.tabs')).some((t) => t.url === ${JSON.stringify(url)}))()`, 10_000, what);

  try {
    // ---------- One tab, the + and the note ----------
    let d = await dbg();
    check('the pane starts with one blank tab, drawn in the strip, active', d.tabs.length === 1 && d.activeId === d.tabs[0].id && d.drawn.length === 1 && d.drawn[0].active && d.drawn[0].title === 'New tab', d);
    check('the strip shows with one tab: the tab and the + button', (await app.count('#browser-tabs .browser-tab')) === 1 && (await app.evaluate(`!document.querySelector('#browser-tab-new').hidden && document.querySelector('#browser-tab-new').offsetHeight > 0`)));
    const look = await app.evaluate(`(() => { const row = document.querySelector('.browser-tabs'); const tab = document.querySelector('.browser-tab.active'); const s = getComputedStyle(tab); return { h: row.getBoundingClientRect().height, bg: s.backgroundColor, bt: s.borderTopWidth, bb: s.borderBottomWidth, tabH: tab.getBoundingClientRect().height }; })()`);
    check('the strip is 32 px tall, the active tab 28 px, white, with a hairline above and none below', look.h === 32 && look.bt === '1px' && look.bb === '0px' && look.tabH === 28 && look.bg === 'rgb(255, 255, 255)', look);
    check('the placeholder shows for the blank tab', await app.evaluate(`!document.querySelector('.browser-placeholder').hidden`));
    check('the one-time note about the profile is shown', d.noteShown && /profile of its own/.test(await app.text('#browser-note')), await app.text('#browser-note'));
    await app.screenshotOf(path.join(shots, 'tabs-1-note.png'), '#side-pane', 0);
    await app.click('#browser-note-close');
    await sleep(200);
    check('… and dismissing it is remembered', (await app.evaluate(`document.querySelector('#browser-note').hidden`)) === true && (await app.evaluate(`oc.rpc('browser.profileNote')`)) === false && JSON.parse(fs.readFileSync(path.join(profile, 'browser', 'profile.json'), 'utf8')).noteDue === false);

    // ---------- Navigation shows in the strip ----------
    let r = await app.callTool('browser_navigate', { url: `${site.base}/popup.html` });
    check('browser_navigate opens the page in the active tab', /Popup opener/.test(r ?? ''), r);
    await app.waitFor(`window.__oc_debug.mods.browser().drawn[0].title === 'Popup opener'`, 5000, 'the strip to show the title');
    d = await dbg();
    const first = d.tabs[0].id;
    check('the tab shows the page title; the URL bar the address', d.drawn[0].title === 'Popup opener' && (await app.evaluate(`document.querySelector('#url').value`)) === `${site.base}/popup.html`, d.drawn);
    check('the placeholder is gone', await app.evaluate(`document.querySelector('.browser-placeholder').hidden`));

    // ---------- The + button ----------
    await app.click('#browser-tab-new');
    await waitTabs(2);
    d = await dbg();
    const second = d.tabs[1].id;
    check('+ opens a blank tab and makes it active', d.tabs.length === 2 && d.activeId === second && d.drawn[1].active && d.drawn[1].title === 'New tab' && !d.drawn[0].active, d);
    check('… the URL bar empties and the placeholder is back', (await app.evaluate(`document.querySelector('#url').value`)) === '' && (await app.evaluate(`!document.querySelector('.browser-placeholder').hidden`)));
    const s2 = await state();
    check('the state carries every tab and the active one flat', s2.tabs.length === 2 && s2.activeId === second && isBlank(s2.url) && s2.tabs[0].url === `${site.base}/popup.html` && s2.tabs[0].title === 'Popup opener' && typeof s2.tabs[0].canGoBack === 'boolean' && s2.tabs[0].blockedPopups === 0, s2);

    // ---------- browser_tabs through the mock model ----------
    r = await app.callTool('browser_tabs', { action: 'list' });
    check('browser_tabs list: one line per tab, the active one marked', r && r.includes('2 tabs') && r.includes(`${first}  "Popup opener"  ${site.base}/popup.html`) && new RegExp(`\\* ${second} .*\\(active\\)`).test(r) && !new RegExp(`\\* ${first}`).test(r), r.replace(/\n/g, ' ⏎ '));
    r = await app.callTool('browser_tabs', { action: 'select', tab_id: first });
    check('browser_tabs select switches the pane', r && r.startsWith(`Now on ${first}: ${site.base}/popup.html`) && (await dbg()).activeId === first, r);
    check('… and the URL bar follows', (await app.evaluate(`document.querySelector('#url').value`)) === `${site.base}/popup.html`);
    r = await app.callTool('browser_tabs', { action: 'new', url: `${site.base}/login.html` });
    await waitTabs(3);
    d = await dbg();
    check('browser_tabs new opens and loads the page, active, and says so', /^Opened tab-\d+\. Now at .*\/login\.html — "Sign in"/.test(r ?? '') && d.tabs.length === 3 && d.tabs[2].url === `${site.base}/login.html` && d.activeId === d.tabs[2].id, r);
    const third = d.tabs[2].id;
    r = await app.callTool('browser_tabs', { action: 'new', url: `${site.base}/landing.html`, background: true });
    await waitTabs(4);
    d = await dbg();
    check('browser_tabs new in the background keeps the current tab in front', /^Opened tab-\d+ in the background\. Now at .*\/landing\.html — "Landing"/.test(r ?? '') && d.activeId === third && d.tabs[3].url === `${site.base}/landing.html`, { r, active: d.activeId, tabs: d.tabs.map((t) => t.url) });
    r = await app.callTool('browser_tabs', { action: 'close', tab_id: d.tabs[3].id });
    await waitTabs(3);
    check('browser_tabs close closes it and lists the rest', r && r.startsWith(`Closed ${d.tabs[3].id}.`) && r.includes('3 tabs'), r);
    r = await app.callTool('browser_tabs', { action: 'select', tab_id: 'tab-99' });
    check('an unknown tab is refused with the list', /No tab tab-99\. The tabs are: tab-/.test(r ?? ''), r);
    await app.screenshotOf(path.join(shots, 'tabs-2-three.png'), '#side-pane', 0);

    // ---------- ⌘-click on a link inside the page ----------
    await app.evaluate(`oc.rpc('browser.activateTab', ${JSON.stringify(first)})`);
    await sleep(200);
    const ws = await app.pageTarget(`${site.base}/popup.html`);
    const rect = await evalAt(ws, `(() => { const r = document.getElementById('plain').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await cdpAt(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await cdpAt(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers: 4 });
    await cdpAt(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers: 4 });
    let how = 'a real ⌘-click';
    let opened = await waitTabAt(`${site.base}/landing.html`, 'a tab from the ⌘-click').then(() => true, () => false);
    if (!opened) {
      // A hidden window delivers no mouse events to the page (the live rig never shows one): the same click as the
      // page's own script would see it.
      how = 'a synthetic ⌘-click';
      await evalAt(ws, `document.getElementById('plain').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, button: 0 }))`);
      opened = await waitTabAt(`${site.base}/landing.html`, 'a tab from the synthetic ⌘-click').then(() => true, () => false);
    }
    d = await dbg();
    check(`⌘-click on a link opens it in a new tab (${how})`, opened && d.tabs.some((t) => t.url === `${site.base}/landing.html`) && d.tabs[0].url === `${site.base}/popup.html`, d.tabs.map((t) => t.url));
    console.log(`     (${how}; active after it: ${d.activeId === first ? 'the opener stayed in front' : 'the new tab'})`);

    // ---------- Shortcuts in the pane's chrome ----------
    await app.evaluate(`oc.rpc('browser.activateTab', ${JSON.stringify(first)})`);
    await sleep(150);
    const before = (await tabs()).length;
    await app.evaluate(`document.querySelector('#url').focus()`);
    await app.key('N', { meta: true, shift: true });
    await waitTabs(before + 1, 'a tab from ⌘⇧N');
    d = await dbg();
    const fromShortcut = d.tabs[d.tabs.length - 1];
    check('⌘⇧N with the URL bar focused opens a blank tab, active', d.tabs.length === before + 1 && isBlank(fromShortcut.url) && d.activeId === fromShortcut.id, d.tabs.map((t) => t.url));
    await app.evaluate(`document.querySelector('#url').focus()`);
    await app.key('w', { meta: true });
    await waitTabs(before, 'the tab to close on ⌘W');
    d = await dbg();
    check('⌘W with the URL bar focused closes the active tab (the window stays)', d.tabs.length === before && !d.tabs.some((t) => t.id === fromShortcut.id) && (await app.exists('#input')), d.tabs.map((t) => t.url));
    await app.evaluate(`document.querySelector('#input').focus(); document.querySelector('#url').blur()`);
    await app.key('w', { meta: true });
    await sleep(300);
    check('⌘W elsewhere is not the browser\'s', (await tabs()).length === before && (await app.exists('#input')));
    await app.evaluate(`document.querySelector('#url').focus(); document.querySelector('#url').blur()`);
    await app.evaluate(`document.querySelector('#browser-tab-new').focus()`);
    await app.key('l', { meta: true });
    await sleep(100);
    check('⌘L in the pane focuses the URL bar', (await app.evaluate(`document.activeElement === document.querySelector('#url')`)) === true);
    await app.evaluate(`document.querySelector('#input').focus()`);

    // ---------- Shortcuts inside the page (the main process sees them before the page does) ----------
    // A key pressed in the native view goes through the main process's input path (before-input-event), which keys
    // injected over CDP skip; the press is made there, on the opener page's contents.
    const pressInPage = (url, keyCode, modifiers) => mainEval(`(() => { const { webContents } = process.mainModule.require('electron'); const wc = webContents.getAllWebContents().find((w) => w.getURL() === ${JSON.stringify(url)}); if (!wc) return 'no such page'; wc.sendInputEvent({ type: 'keyDown', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(modifiers)} }); wc.sendInputEvent({ type: 'keyUp', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(modifiers)} }); return 'sent'; })()`);
    const n0 = (await tabs()).length;
    let sent = await pressInPage(`${site.base}/popup.html`, 'N', ['cmd', 'shift']);
    const pageNew = await waitTabs(n0 + 1, '⌘⇧N inside the page').then(() => true, () => false);
    check('⌘⇧N pressed inside a page opens a tab (before-input-event in the main process)', sent === 'sent' && pageNew, { sent, tabs: (await tabs()).length });
    sent = await pressInPage(`${site.base}/popup.html`, 'w', ['cmd']);
    const closed = await waitTabs(n0, '⌘W inside the page').then(() => true, () => false);
    check('⌘W pressed inside a page closes that tab', sent === 'sent' && closed && !(await tabs()).some((t) => t.url === `${site.base}/popup.html`), { sent, tabs: (await tabs()).map((t) => t.url) });

    // ---------- The cap ----------
    let count = (await tabs()).length;
    while (count < 12) {
      await app.evaluate(`oc.rpc('browser.newTab')`);
      count++;
    }
    await waitTabs(12);
    const refused = await app.evaluate(`oc.rpc('browser.newTab').then(() => 'opened', (e) => e.message)`);
    check('the 13th tab is refused', /Close a tab first: the browser keeps at most 12/.test(refused) && (await tabs()).length === 12, refused);
    r = await app.callTool('browser_tabs', { action: 'new', url: `${site.base}/landing.html` });
    check('… through browser_tabs too, as an error the model reads', /Close a tab first: the browser keeps at most 12/.test(r ?? '') && (await tabs()).length === 12, r);
    check('twelve tabs scroll in the strip, no arrows', await app.evaluate(`(() => { const s = document.querySelector('#browser-tabs'); return s.scrollWidth >= s.clientWidth && getComputedStyle(s).overflowX === 'auto' && document.querySelectorAll('.browser-tab').length === 12; })()`));
    await app.screenshotOf(path.join(shots, 'tabs-3-twelve.png'), '#side-pane', 0);

    // ---------- Closing the last tab leaves a blank one ----------
    for (const t of await tabs()) await app.evaluate(`oc.rpc('browser.closeTab', ${JSON.stringify(t.id)})`);
    await waitTabs(1);
    d = await dbg();
    check('closing every tab leaves one blank tab, active, with the placeholder', d.tabs.length === 1 && isBlank(d.tabs[0].url) && d.activeId === d.tabs[0].id && d.drawn.length === 1 && d.drawn[0].title === 'New tab' && (await app.evaluate(`!document.querySelector('.browser-placeholder').hidden`)), d);
    const popupTargets = await app.pageTargets(site.base);
    check('the closed tabs\' pages are gone', popupTargets.length === 0, popupTargets.map((t) => t.url));

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${shots}`);
  } finally {
    await app.close();
    site.close();
  }
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
