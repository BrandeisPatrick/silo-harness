// Live check of the Browser pane's polish in the real app, hidden, on a throwaway profile, with the mock model and the
// fixture site from support/site.js: find in page (⌘F pressed inside the page through the main process's own input
// path, "1 of 3", Enter, ⇧Enter, Esc; ⌘F in the pane's chrome; the composer's ⌘F still searching sessions; a new
// page and a tab switch), zoom per site (⌘+ in the page and in the chrome, the chip, another site at 100 %, the level
// kept across a relaunch, the chip resetting it), the blocked-popup strip and its Show and ×, a link from the chat with
// the switch off and on, browser_type refused when the focus ends in a password field after its own click, and the
// context menu a right click on a link builds. A hidden window's view takes no mouse input at all, so the right click
// is the tab's own context-menu event with the params read from the page, and the menu's labels are read, not clicked.
// Run: npm run build && node test/live/browser-polish.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt } = require('./rig.js');
const { startSite } = require('./support/site.js');

const { check, done } = checker();

const HOSTS = ['--host-resolver-rules=MAP fixture.example 127.0.0.1'];
const SECRET = 'Live-Polish-Pw-77';
const REFUSAL = 'Not permitted: passwords, one-time codes and card details are for the user to type. Ask them to sign in (or fill the card) in the Browser pane, then continue.';

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const site = await startSite();
  const P = new URL(site.base).port;
  const named = `http://fixture.example:${P}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-browser-polish-'));
  // --inspect: the main process's own input path for keys pressed inside a page (CDP-injected keys skip it), and
  // its modules (the context menu's last template, shell.openExternal stubbed so no real browser opens)
  const inspectPort = 20000 + Math.floor(Math.random() * 20000);
  const opts = { profile, mode: 'bypass', mock: true, args: [`--inspect=${inspectPort}`, ...HOSTS] };
  let app = await launch(opts);
  const mainEval = async (expr) => evalAt((await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0].webSocketDebuggerUrl, expr);
  const dbg = () => app.evaluate('window.__oc_debug.mods.browser()');
  const tabs = () => app.evaluate('oc.rpc("browser.tabs")');
  const active = async () => {
    const s = await app.evaluate('oc.browser.state()');
    return s.tabs.find((t) => t.id === s.activeId);
  };
  const go = async (url) => {
    await app.evaluate(`oc.rpc('browser.go', ${JSON.stringify(url)})`);
    await app.waitFor(`(async () => { const s = await oc.browser.state(); return s.url === ${JSON.stringify(url)} && !s.loading; })()`, 15_000, `the pane at ${url}`);
    await sleep(250);
  };
  /** A key pressed inside the page with that URL, through the main process's input path (before-input-event). */
  const pressInPage = (url, keyCode, modifiers = []) =>
    mainEval(`(() => { const { webContents } = process.mainModule.require('electron'); const wc = webContents.getAllWebContents().find((w) => w.getURL() === ${JSON.stringify(url)}); if (!wc) return 'no such page'; wc.sendInputEvent({ type: 'keyDown', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(modifiers)} }); wc.sendInputEvent({ type: 'keyUp', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(modifiers)} }); return 'sent'; })()`);
  const zoomOfPage = (url) => mainEval(`(() => { const { webContents } = process.mainModule.require('electron'); const wc = webContents.getAllWebContents().find((w) => w.getURL() === ${JSON.stringify(url)}); return wc ? Math.round(wc.getZoomFactor() * 100) : null; })()`);
  const zoomFile = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(profile, 'browser', 'zoom.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const centre = async (url, selector) => {
    const ws = await app.pageTarget(url);
    return evalAt(ws, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  };

  try {
    // ---------- Find in page ----------
    const FIND = `${site.base}/find.html`;
    await go(FIND);
    const slot0 = (await dbg()).element.height;
    let sent = await pressInPage(FIND, 'F', ['cmd']);
    await app.waitFor(`window.__oc_debug.mods.browser().find.open`, 5000, 'the find bar to open').catch(() => undefined);
    let d = await dbg();
    check('⌘F pressed inside the page opens the find bar with its field focused', sent === 'sent' && d.find.open && d.find.focused, { sent, find: d.find });
    await app.waitFor(`window.__oc_debug.mods.browser().bounds.height < ${slot0 - 30}`, 5000, 'the view to follow the slot').catch(() => undefined);
    d = await dbg();
    check('… under the URL bar, taking its height out of the page\'s slot (the native view follows)', d.find.height >= 36 && Math.abs(slot0 - d.element.height - d.find.height) <= 1 && Math.abs(d.bounds.height - d.element.height) <= 1, { slot0, slot: d.element.height, bar: d.find.height, sent: d.bounds });
    await app.fill('#browser-find-input', 'kumquat');
    const count = (text, what) => app.waitFor(`window.__oc_debug.mods.browser().find.count === ${JSON.stringify(text)}`, 6000, what).then(() => true, () => false);
    check('typing a word that occurs three times reads "1 of 3"', await count('1 of 3', '1 of 3'), (await dbg()).find);
    const look = await app.evaluate(`(() => { const c = document.querySelector('#browser-find-count'); const s = getComputedStyle(c); return { size: s.fontSize, line: s.lineHeight }; })()`);
    check('… the count in --fs-micro (12/16)', look.size === '12px' && look.line === '16px', look);
    await app.screenshotOf(path.join(shots, 'find-bar.png'), '#side-pane', 0);
    await app.key('Enter');
    check('Enter moves to the next match: "2 of 3"', await count('2 of 3', '2 of 3'), (await dbg()).find);
    await app.key('Enter');
    await count('3 of 3', '3 of 3');
    await app.key('Enter', { shift: true });
    check('⇧Enter moves back: "2 of 3"', await count('2 of 3', 'back to 2 of 3'), (await dbg()).find);
    await app.fill('#browser-find-input', 'durian');
    check('a word not on the page reads "No results"', await count('No results', 'No results'), (await dbg()).find);
    await app.fill('#browser-find-input', 'kumquat');
    await count('1 of 3', '1 of 3 again');
    await app.key('Escape');
    await sleep(300);
    d = await dbg();
    const pageFocused = await mainEval(`(() => { const { webContents } = process.mainModule.require('electron'); const wc = webContents.getAllWebContents().find((w) => w.getURL() === ${JSON.stringify(FIND)}); return wc ? wc.isFocused() : null; })()`);
    check('Esc closes the bar and clears the search; the slot gets its height back', !d.find.open && d.find.count === '' && !d.find.focused && Math.abs(d.element.height - slot0) <= 1, { find: d.find, slot: d.element.height, slot0 });
    console.log(`     (the page reports focus after Esc: ${pageFocused}; a hidden window may not hand focus over)`);
    check('… and Esc there did not stop or rewind anything (no dialog opened)', !(await app.evaluate(`[...document.querySelectorAll('dialog')].some((x) => x.open)`)));
    // ⌘F in the pane's chrome: the bar again, the last word searched again from the top
    await app.evaluate(`document.querySelector('#url').focus()`);
    await app.key('f', { meta: true });
    check('⌘F with the URL bar focused opens the bar on the last word, searched again', await count('1 of 3', 'the bar from the chrome'), (await dbg()).find);
    // A new page: the count clears, the word stays
    await go(`${site.base}/landing.html`);
    await app.waitFor(`window.__oc_debug.mods.browser().find.count === ''`, 5000, 'the count to clear').catch(() => undefined);
    d = await dbg();
    check('a new page in the tab clears the count; the bar keeps the word', d.find.open && d.find.count === '' && d.find.text === 'kumquat', d.find);
    await go(FIND);
    await app.evaluate(`document.querySelector('#browser-find-input').focus()`);
    await app.key('Enter');
    check('… Enter searches the new page', await count('1 of 3', 'search on the new page'), (await dbg()).find);
    // A tab switch closes the bar
    const findTab = (await active()).id;
    await app.evaluate(`oc.rpc('browser.newTab')`);
    await app.waitFor(`!window.__oc_debug.mods.browser().find.open`, 5000, 'the bar to close on a tab switch').catch(() => undefined);
    check('switching to another tab closes the find bar', !(await dbg()).find.open);
    await app.evaluate(`(async () => oc.rpc('browser.closeTab', (await oc.browser.state()).activeId))()`);
    await app.evaluate(`oc.rpc('browser.activateTab', ${JSON.stringify(findTab)})`);
    // The composer's ⌘F still searches the sessions
    await app.evaluate(`document.querySelector('#input').focus()`);
    await app.key('f', { meta: true });
    await sleep(250);
    check("the composer's ⌘F still searches sessions, not the page", !(await dbg()).find.open && (await app.evaluate(`document.activeElement === document.querySelector('#session-search')`)), await app.evaluate('document.activeElement?.id'));
    await app.key('Escape');
    await app.evaluate(`document.querySelector('#input').focus()`);

    // ---------- Zoom per site ----------
    await go(FIND);
    sent = await pressInPage(FIND, '=', ['cmd']);
    await pressInPage(FIND, '=', ['cmd']);
    await app.waitFor(`window.__oc_debug.mods.browser().zoomChip === '125%'`, 5000, 'the chip').catch(() => undefined);
    d = await dbg();
    check('⌘+ twice inside the page: the chip reads 125%, the page is at 125%', sent === 'sent' && d.zoomChip === '125%' && (await zoomOfPage(FIND)) === 125, { chip: d.zoomChip, page: await zoomOfPage(FIND) });
    check('… kept for the site in userData/browser/zoom.json', JSON.stringify(zoomFile()) === JSON.stringify({ '127.0.0.1': 125 }), zoomFile());
    const chipLook = await app.evaluate(`(() => { const c = document.querySelector('#zoom-chip'); const s = getComputedStyle(c); return { size: s.fontSize, inPill: Boolean(c.closest('.url-pill')) }; })()`);
    check('… the chip sits in the URL pill, in --fs-micro', chipLook.inPill && chipLook.size === '12px', chipLook);
    await app.screenshotOf(path.join(shots, 'zoom-chip.png'), '.browser-bar', 0);
    await app.evaluate(`document.querySelector('#url').focus()`);
    await app.key('-', { meta: true });
    await app.waitFor(`window.__oc_debug.mods.browser().zoomChip === '110%'`, 5000, '110%').catch(() => undefined);
    const appZoom = () => mainEval(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.getZoomLevel()`);
    check('⌘− with the URL bar focused zooms the page out a step (110%), not the app', (await dbg()).zoomChip === '110%' && (await zoomOfPage(FIND)) === 110 && (await appZoom()) === 0, { chip: (await dbg()).zoomChip, app: await appZoom() });
    await app.key('=', { meta: true });
    await app.waitFor(`window.__oc_debug.mods.browser().zoomChip === '125%'`, 5000, '125% again').catch(() => undefined);
    check('⌘= there zooms back in (125%)', (await dbg()).zoomChip === '125%' && (await zoomOfPage(FIND)) === 125);
    await app.evaluate(`document.querySelector('#input').focus()`);
    // Another site: its own level
    const OTHER = `${named}/find.html`;
    await go(OTHER);
    d = await dbg();
    check('another site in the tab is at 100%: no chip', d.zoomChip === null && (await zoomOfPage(OTHER)) === 100, { chip: d.zoomChip });
    await go(FIND);
    await app.waitFor(`window.__oc_debug.mods.browser().zoomChip === '125%'`, 5000, 'the level back').catch(() => undefined);
    check('back on the first site the level comes back', (await dbg()).zoomChip === '125%' && (await zoomOfPage(FIND)) === 125);
    // A relaunch on the same profile keeps it
    await app.close();
    app = await launch(opts);
    await go(FIND);
    await app.waitFor(`window.__oc_debug.mods.browser().zoomChip === '125%'`, 5000, 'the level after a relaunch').catch(() => undefined);
    check('after a relaunch the site opens at 125%, chip and page', (await dbg()).zoomChip === '125%' && (await zoomOfPage(FIND)) === 125, { chip: (await dbg()).zoomChip, page: await zoomOfPage(FIND) });
    await app.click('#zoom-chip');
    await app.waitFor(`window.__oc_debug.mods.browser().zoomChip === null`, 5000, 'the chip to go').catch(() => undefined);
    check('a click on the chip resets the page to 100%, the chip goes, the site is forgotten', (await dbg()).zoomChip === null && (await zoomOfPage(FIND)) === 100 && JSON.stringify(zoomFile()) === '{}', { chip: (await dbg()).zoomChip, file: zoomFile() });
    check('… and the click did not put the cursor in the URL field', !(await app.evaluate(`document.activeElement === document.querySelector('#url')`)));

    // ---------- The blocked-popup strip ----------
    const OPENER = `${site.base}/popup.html`;
    await go(OPENER);
    let ws = await app.pageTarget(OPENER);
    const opened = [];
    for (const n of [1, 2, 3]) opened.push(await evalAt(ws, `openStay(${n})`));
    await app.waitFor(`window.__oc_debug.mods.browser().popups.length === 3`, 8000, 'three popups').catch(() => undefined);
    const fourth = await evalAt(ws, 'openStay(4)');
    await app.waitFor(`Boolean(window.__oc_debug.mods.browser().popupNote)`, 5000, 'the strip').catch(() => undefined);
    d = await dbg();
    check('a fourth popup is blocked: the strip under the URL bar says so, with Show', JSON.stringify(opened) === '["opened","opened","opened"]' && fourth === 'null' && d.popupNote && d.popupNote.text === 'A popup was blocked · Show' && d.popupNote.show, { opened, fourth, note: d.popupNote });
    const stripLook = await app.evaluate(`(() => { const s = getComputedStyle(document.querySelector('#browser-popup-note')); return { size: s.fontSize, line: s.lineHeight }; })()`);
    check('… one line in --fs-small (13/18)', stripLook.size === '13px' && stripLook.line === '18px' && d.popupNote.height <= 33, { stripLook, h: d.popupNote.height });
    await app.screenshotOf(path.join(shots, 'popup-strip.png'), '#side-pane', 0);
    for (const p of (await dbg()).popups) await app.evaluate(`oc.rpc('browser.closePopup', ${JSON.stringify(p.id)})`);
    const before = (await tabs()).length;
    await app.click('#browser-popup-show');
    const shownAt = `${site.base}/popup-stay.html?n=4`;
    const shown = await app.waitFor(`(async () => (await oc.rpc('browser.tabs')).some((t) => t.url === ${JSON.stringify(shownAt)}))()`, 8000, 'the popup in a tab').then(() => true, () => false);
    d = await dbg();
    check('Show opens the blocked popup\'s address in a new tab, in front; the strip goes', shown && (await tabs()).length === before + 1 && d.tabs.find((t) => t.id === d.activeId)?.url === shownAt && d.popupNote === null, { tabs: d.tabs.map((t) => t.url), note: d.popupNote });
    await app.evaluate(`(async () => oc.rpc('browser.closeTab', (await oc.browser.state()).activeId))()`);
    await app.evaluate(`(async () => { const s = await oc.browser.state(); const t = s.tabs.find((x) => x.url === ${JSON.stringify(OPENER)}); await oc.rpc('browser.activateTab', t.id); })()`);
    ws = await app.pageTarget(OPENER);
    for (const n of [5, 6, 7]) await evalAt(ws, `openStay(${n})`);
    await evalAt(ws, 'openStay(8)');
    await app.waitFor(`Boolean(window.__oc_debug.mods.browser().popupNote)`, 5000, 'the strip again').catch(() => undefined);
    await app.click('#browser-popup-close');
    await app.waitFor(`window.__oc_debug.mods.browser().popupNote === null`, 5000, 'the strip to go').catch(() => undefined);
    check('× dismisses the strip', (await dbg()).popupNote === null);
    await evalAt(ws, 'openStay(9)');
    await app.waitFor(`Boolean(window.__oc_debug.mods.browser().popupNote)`, 5000, 'the strip once more').catch(() => undefined);
    const again = (await dbg()).popupNote;
    for (const p of (await dbg()).popups) await app.evaluate(`oc.rpc('browser.closePopup', ${JSON.stringify(p.id)})`);
    await go(`${site.base}/landing.html`);
    check('the next navigation takes the strip away', again !== null && (await dbg()).popupNote === null, { again });

    // ---------- The context menu ----------
    // A hidden window's view receives no mouse input at all (no click, no right click, by sendInputEvent or CDP), so
    // the right click is the tab's own context-menu event, emitted in the main process with the params Chromium would
    // send for the element at that point of the page (read from the page). The handler, the template and the tab's
    // history are the real ones; the native menu is built but not popped up in a hidden window.
    await go(OPENER);
    const MENU_MODULE = JSON.stringify(path.join(app.root, 'dist', 'main', 'browser', 'context-menu.js'));
    const lastMenu = () => mainEval(`process.mainModule.require(${MENU_MODULE}).lastContextMenu()`);
    const rightClick = async (x, y) => {
      const at = await evalAt(await app.pageTarget(OPENER), `(() => { const e = document.elementFromPoint(${x}, ${y}); const a = e && e.closest('a[href]'); const img = e && e.closest('img'); const sel = String(getSelection()); return { linkURL: a ? a.href : '', srcURL: img ? img.src : '', mediaType: img ? 'image' : 'none', selectionText: sel, isEditable: Boolean(e && (e.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.tagName))) }; })()`);
      const params = { x, y, ...at, misspelledWord: '', dictionarySuggestions: [], editFlags: { canCut: false, canCopy: Boolean(at.selectionText), canPaste: false, canSelectAll: true } };
      return mainEval(`(() => { const { webContents } = process.mainModule.require('electron'); const wc = webContents.getAllWebContents().find((w) => w.getURL() === ${JSON.stringify(OPENER)}); if (!wc) return 'no such page'; wc.emit('context-menu', { preventDefault() {} }, ${JSON.stringify(params)}); return 'sent'; })()`);
    };
    const link = await centre(OPENER, '#plain');
    sent = await rightClick(link.x, link.y);
    let menu = await lastMenu();
    check('a right click on a link builds the link\'s menu: Open Link in New Tab, Copy Link Address, Print…, Save as PDF…, Inspect Element', sent === 'sent' && menu && menu.params && menu.params.linkURL === `${site.base}/landing.html` && JSON.stringify(menu.labels) === JSON.stringify(['Open Link in New Tab', 'Copy Link Address', '-', 'Print…', 'Save as PDF…', '-', 'Inspect Element']), menu);
    const blank = await evalAt(await app.pageTarget(OPENER), '({ x: 24, y: innerHeight - 24 })');
    sent = await rightClick(blank.x, blank.y);
    menu = await lastMenu();
    check('… and on the page itself: Back (enabled: the tab has history), Forward (disabled), Reload, …, Inspect Element last', sent === 'sent' && menu && !menu.params.linkURL && JSON.stringify(menu.labels.slice(0, 3)) === JSON.stringify(['Back', 'Forward', 'Reload']) && menu.enabled[0] === true && menu.enabled[1] === false && menu.labels.at(-1) === 'Inspect Element', menu);
    const extra = await mainEval(`(() => { const { BrowserWindow, webContents } = process.mainModule.require('electron'); return { windows: BrowserWindow.getAllWindows().length, devtools: webContents.getAllWebContents().filter((w) => w.getURL().startsWith('devtools:')).length }; })()`);
    check('… nothing else opened (no DevTools, no other window)', extra && extra.windows === 1 && extra.devtools === 0, extra);

    // ---------- Links from the chat ----------
    // shell.openExternal is stubbed for the run: the default browser must not open, and the call is recorded
    const stubbed = await mainEval(`(() => { const { shell } = process.mainModule.require('electron'); global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(u); }; return String(shell.openExternal).includes('__opened'); })()`);
    const LINK = `${site.base}/landing.html?from=chat`;
    let marker = 0;
    const replyWithLink = async () => {
      const m = `Link step ${++marker}`;
      app.mock.state.replies.push({ content: `Here it is: [the landing page](${LINK}).`, when: (payload) => JSON.stringify(payload.messages?.at(-1)?.content ?? '').includes(m) });
      await app.send(m);
      await app.waitIdle(30_000);
      await app.waitFor(`[...document.querySelectorAll('.msg.assistant .md a')].filter((a) => a.getAttribute('href') === ${JSON.stringify(LINK)}).length >= ${marker}`, 10_000, 'the link in the reply');
    };
    const clickChatLink = () => app.evaluate(`[...document.querySelectorAll('.msg.assistant .md a')].filter((a) => a.getAttribute('href') === ${JSON.stringify(LINK)}).pop().click()`);
    if (!stubbed) check('shell.openExternal could be stubbed (otherwise the off case is skipped so no browser opens)', false);
    else {
      await replyWithLink();
      let n = (await tabs()).length;
      await clickChatLink();
      await sleep(600);
      const ext = await mainEval('global.__opened');
      check('with the switch off (the default), a chat link opens in the default browser, not the pane', JSON.stringify(ext) === JSON.stringify([LINK]) && (await tabs()).length === n && !(await tabs()).some((t) => t.url === LINK), { ext, tabs: (await tabs()).map((t) => t.url) });
      await app.evaluate(`(async () => { const c = await oc.getConfig(); c.browser = { ...c.browser, openChatLinksInPane: true }; await oc.setConfig(c); })()`);
      await app.evaluate(`document.querySelector('#pane-tab-diff').click()`);
      await sleep(200);
      n = (await tabs()).length;
      await clickChatLink();
      const inPane = await app.waitFor(`(async () => (await oc.rpc('browser.tabs')).some((t) => t.url === ${JSON.stringify(LINK)}))()`, 8000, 'the link in a tab').then(() => true, () => false);
      d = await dbg();
      check('with the switch on, it opens in a new tab of the pane, in front, and the Browser tab comes forward', inPane && (await tabs()).length === n + 1 && d.tabs.find((t) => t.id === d.activeId)?.url === LINK && d.tab === 'browser', { tab: d.tab, tabs: d.tabs.map((t) => t.url) });
      check('… as the user\'s own navigation: no card, nothing sent outside', JSON.stringify(await mainEval('global.__opened')) === JSON.stringify([LINK]) && (await app.count('.approval.prompt-card:not(.decided)')) === 0);
      const MAIL = 'mailto:someone@example.com';
      await app.evaluate(`(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(MAIL)}; a.target = '_blank'; a.rel = 'noreferrer'; document.querySelector('.msg.assistant .md').append(a); a.click(); a.remove(); })()`);
      await sleep(500);
      check('… a mailto: link still goes to the Mac\'s mail app', JSON.stringify(await mainEval('global.__opened')) === JSON.stringify([LINK, MAIL]));
    }

    // ---------- browser_type when the click moves the focus ----------
    const FORM = `${named}/focus-move.html`;
    let r = await app.callTool('browser_navigate', { url: FORM });
    check('the profile page opens (bypass mode, fixture.example is not exempt)', /Your profile|Profile/.test(r ?? ''), r);
    // The text field hands the focus to the password field once it has it, as a click on it would in a visible window
    ws = await app.pageTarget(FORM);
    await evalAt(ws, `document.getElementById('nick').focus()`);
    // A page in a hidden window runs its timers late: wait for the hand-over
    let handed = '';
    for (let i = 0; i < 50 && handed !== 'pw'; i++) {
      await sleep(100);
      handed = await evalAt(ws, 'document.activeElement && document.activeElement.id');
    }
    r = await app.callTool('browser_type', { field: 'Nickname', text: SECRET });
    const fields = await evalAt(ws, `({ nick: document.getElementById('nick').value, pw: document.getElementById('pw').value, focus: document.activeElement && document.activeElement.id })`);
    check('browser_type into a field whose click moves the focus to the password: the result is the refusal', handed === 'pw' && r === REFUSAL, { handed, r });
    check('… nothing was typed: the password field and the text field are empty', fields && fields.pw === '' && fields.nick === '', fields);
    const sessionsDir = path.join(profile, 'sessions');
    const stored = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(sessionsDir, f), 'utf8')).join('\n') : '';
    check('… and the stored call hides the text', stored.length > 0 && !stored.includes(SECRET), { bytes: stored.length });

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
