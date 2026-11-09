// Live checks of how the mods' panels open and close from the top bar, in the real window: the rail's toggle is
// always there, first of the top bar's icons (rail, terminal, diff, browser, ⋯), drawn as a list in a box at the same
// size and in the same pressed style as the others; it and ⌘⇧E open and close the rail, and the choice survives a
// relaunch; it stays when no rail mod is on, and goes with the rest of the top bar's buttons while a page has the main
// column. A mod's tab in the side pane has a × that takes it out of the strip (Delete does the same), the ⋯ menu shows
// it again ("Show Side chat"), opening the pane if it was closed, and a closed tab stays closed after a relaunch.
// Screenshots: the top bar with the rail open and closed, light and dark; the strip with a tab's ×; the ⋯ menu.
// Run: npm run build && node test/live/mods-panes.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.argv[2] || process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mods-panes-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const { check, done } = checker();
const js = (v) => JSON.stringify(v);
const RAIL_MODS = ['context', 'environment', 'outputs', 'plan', 'skills', 'sub-sessions', 'tasks'];

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mods-panes-profile-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mods-panes-project-'));
  let app = await launch({ mock: true, profile, project, scale: 2, config: { theme: 'light' } });
  const ev = (x) => app.evaluate(x);
  const rpc = (m, ...a) => ev(`window.oc.rpc(${js(m)}, ...${js(a)})`);
  const layout = () => ev(`window.oc.getConfig().then((c) => c.mods.layout)`);
  const toggle = () => ev(`(() => { const b = document.querySelector('#rail-toggle'); return { shown: !!b.offsetParent, pressed: b.getAttribute('aria-pressed'), active: b.classList.contains('active') }; })()`);
  const railShown = () => ev(`(() => { const r = document.querySelector('#mod-rail'); return !r.hidden && r.getClientRects().length > 0; })()`);
  const tabs = () => ev(`window.__oc_debug.mods.tabs()`);
  const strip = () => ev(`[...document.querySelectorAll('.pane-tabs > .pane-tab')].filter((b) => !b.hidden).map((b) => b.dataset.view || b.id)`);
  const topShot = async (name) => {
    await ev(`document.activeElement && document.activeElement.blur()`);
    await sleep(350);
    const r = await ev(`(() => { const a = document.querySelector('.topbar-actions').getBoundingClientRect(); return { x: Math.max(0, a.right - 560), y: 0, width: Math.min(560, a.right), height: 240 }; })()`);
    await app.screenshot(path.join(SHOTS, `${name}.png`), r);
  };
  const setScheme = async (scheme) => {
    await ev(`(async () => { const c = await window.oc.getConfig(); c.theme = ${js(scheme)}; await window.oc.setConfig(c); document.documentElement.dataset.theme = ${js(scheme)}; })()`);
    await sleep(900);
  };
  const menuItems = async () => {
    await app.click('#mods-more');
    await sleep(300);
    return ev(`[...document.querySelectorAll('.popover.mods-menu .pop-item')].map((b) => (b.querySelector('.pop-title')?.textContent || b.textContent).trim())`);
  };
  const pickMenu = (label) => ev(`[...document.querySelectorAll('.popover.mods-menu .pop-item')].find((b) => (b.querySelector('.pop-title')?.textContent || b.textContent).trim() === ${js(label)}).click()`);

  try {
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.seat === 'rail' && v.hello).length >= 5`, 20_000, 'the rail to start');

    // ---------- The rail's toggle ----------
    const order = await ev(`[...document.querySelectorAll('.topbar-actions > button')].filter((b) => b.offsetParent).map((b) => b.id)`);
    check('the top bar\'s icons: rail, terminal, diff, browser, then ⋯', js(order) === js(['rail-toggle', 'terminal-toggle', 'diff-toggle', 'browser-toggle', 'mods-more']), order);
    check('the rail toggle is a list inside a box', await ev(`(() => { const p = document.querySelector('#rail-toggle svg'); return !!p && !!p.querySelector('rect') && /M5 6\\.25h6/.test(p.innerHTML); })()`));
    const sizes = await ev(`['rail-toggle', 'terminal-toggle', 'diff-toggle', 'browser-toggle'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); const s = document.getElementById(id).querySelector('svg').getBoundingClientRect(); return [r.width, r.height, s.width, s.height].map(Math.round).join('x'); })`);
    check('… the same size as the others, icon included', new Set(sizes).size === 1, sizes);
    let t = await toggle();
    check('the rail is open at the start, its toggle pressed', t.shown && t.pressed === 'true' && t.active && (await railShown()), t);
    // The pane on the Browser: its toggle is pressed too, and the two pressed buttons look the same
    await ev(`(() => { if (document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#browser-toggle').click(); })()`);
    await sleep(300);
    await ev(`document.activeElement && document.activeElement.blur()`);
    await sleep(300);
    const pressedLook = await ev(`['rail-toggle', 'browser-toggle'].map((id) => { const s = getComputedStyle(document.getElementById(id)); return s.backgroundColor + ' ' + s.color + ' ' + s.borderRadius; })`);
    check('… in the same pressed style as the Browser\'s', pressedLook[0] === pressedLook[1], pressedLook);
    await topShot('top-bar-rail-open-light');
    await app.click('#rail-toggle');
    await sleep(500);
    t = await toggle();
    check('a click closes the rail; the toggle stays, not pressed', t.shown && t.pressed === 'false' && !t.active && !(await railShown()) && (await layout()).railOpen === false, t);
    await topShot('top-bar-rail-closed-light');
    await app.key('e', { meta: true, shift: true });
    await sleep(500);
    check('⌘⇧E opens it again', (await toggle()).pressed === 'true' && (await railShown()) && (await layout()).railOpen === true);
    await setScheme('dark');
    await topShot('top-bar-rail-open-dark');
    await app.key('e', { meta: true, shift: true });
    await sleep(500);
    check('… and closes it', (await toggle()).pressed === 'false' && !(await railShown()));
    await topShot('top-bar-rail-closed-dark');
    await setScheme('light');

    // With no rail mod on, the toggle is still there
    for (const id of RAIL_MODS) await rpc('mods.setEnabled', id, false);
    await sleep(800);
    t = await toggle();
    check('with no rail mod on, the toggle is still there (and keeps the choice)', t.shown && t.pressed === 'false', t);
    await app.click('#rail-toggle');
    await sleep(300);
    check('… and its click is kept for when one comes back', (await toggle()).pressed === 'true' && !(await railShown()));
    for (const id of RAIL_MODS) await rpc('mods.setEnabled', id, true);
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.seat === 'rail').length >= 5`, 10_000, 'the rail mods back').catch(() => {});
    await sleep(500);
    check('the rail mods back on: the rail shows, as chosen', await railShown());

    // A page has the main column: the top bar's buttons go, the toggle with them, and come back as they were
    const onScreen = await ev(`document.querySelector('.session-item.active')?.dataset.id || ''`);
    await app.waitFor(`!document.querySelector('#scheduled-row').hidden`, 10_000, 'the Scheduled row').catch(() => {});
    await app.click('#scheduled-row');
    await sleep(600);
    check('on a page: the rail toggle and the rail are hidden', (await ev(`window.__oc_debug.pages.state().open`)) && !(await toggle()).shown && !(await railShown()));
    await app.key('e', { meta: true, shift: true });
    await sleep(300);
    check('… and ⌘⇧E does nothing there', (await layout()).railOpen === true);
    if (onScreen) await app.click(`.session-item[data-id="${onScreen}"]`);
    else await ev(`document.querySelector('.session-item')?.click()`);
    await sleep(600);
    t = await toggle();
    check('back from the page: the toggle and the rail are as they were', !(await ev(`window.__oc_debug.pages.state().open`)) && t.shown && t.pressed === 'true' && (await railShown()), t);

    // ---------- A mod's tab in the side pane: × takes it out, the ⋯ menu shows it again ----------
    await app.waitFor(`document.querySelector('.mod-pane-tab[data-view="side-chat/main"]') !== null`, 10_000, 'the Side chat tab');
    await app.click('.mod-pane-tab[data-view="side-chat/main"]');
    await app.waitFor(`window.__oc_debug.mods.views().find((v) => v.key === 'side-chat/main')?.hello`, 10_000, 'the Side chat page').catch(() => {});
    check('a mod tab in front shows its ×', await ev(`(() => { const x = document.querySelector('.mod-pane-tab[data-view="side-chat/main"] .pane-tab-close'); return !!x && getComputedStyle(x).opacity === '1' && x.getBoundingClientRect().width > 0; })()`));
    await app.screenshotOf(path.join(SHOTS, 'pane-tabs-close-light.png'), '.pane-tabs', 0);
    await ev(`document.querySelector('.mod-pane-tab[data-view="side-chat/main"] .pane-tab-close').click()`);
    await sleep(500);
    let s = await strip();
    check('its × takes it out of the strip, and its page unloads', !s.includes('side-chat/main') && (await tabs()).find((x) => x.key === 'side-chat/main').closed && !(await ev(`window.__oc_debug.mods.views().some((v) => v.key === 'side-chat/main')`)) && (await layout()).closedTabs.includes('side-chat/main'), s);
    check('… and the pane falls back to the Browser', (await ev(`document.querySelector('#pane-tab-browser').getAttribute('aria-selected')`)) === 'true');
    const items = await menuItems();
    check('the ⋯ menu shows it again ("Show Side chat") beside the tabs still in the strip', items.includes('Show Side chat') && items.includes('Scheduled') && items.includes('Manage mods…'), items);
    await ev(`document.activeElement && document.activeElement.blur()`);
    await app.screenshotOf(path.join(SHOTS, 'more-menu-show-light.png'), '.popover.mods-menu', 12).catch(() => {});
    await app.key('Escape');
    await sleep(200);
    await app.click('#pane-close');
    await sleep(300);
    check('the pane closed', await ev(`document.querySelector('.shell').classList.contains('pane-hidden')`));
    await menuItems();
    await pickMenu('Show Side chat');
    await app.waitFor(`window.__oc_debug.mods.views().find((v) => v.key === 'side-chat/main')?.hello`, 10_000, 'the Side chat page again').catch(() => {});
    s = await strip();
    check('"Show Side chat" puts the tab back in front and opens the pane', s.includes('side-chat/main') && !(await ev(`document.querySelector('.shell').classList.contains('pane-hidden')`)) && (await ev(`document.querySelector('.mod-pane-tab[data-view="side-chat/main"]').getAttribute('aria-selected')`)) === 'true' && !(await layout()).closedTabs.includes('side-chat/main'), s);
    // Delete on a focused tab closes it too
    await ev(`document.querySelector('.mod-pane-tab[data-view="scheduled/main"]').focus()`);
    await app.key('Delete');
    await sleep(500);
    check('Delete on a focused mod tab closes it', !(await strip()).includes('scheduled/main') && (await layout()).closedTabs.includes('scheduled/main'));
    check('the built-in tabs have no ×', await ev(`!document.querySelector('#pane-tab-browser .pane-tab-close, #pane-tab-diff .pane-tab-close, #pane-tab-terminal .pane-tab-close')`));

    // ---------- Remembered across a relaunch: the rail closed, the Scheduled tab closed ----------
    await app.click('#rail-toggle');
    await sleep(500);
    await app.close();
    app = await launch({ mock: true, profile, project, scale: 2, config: { theme: 'light' } });
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.seat === 'tab' || v.seat === 'rail').length >= 3`, 20_000, 'the mods after the relaunch').catch(() => {});
    await sleep(800);
    t = await toggle();
    check('after a relaunch the rail is still closed, its toggle there and not pressed', t.shown && t.pressed === 'false' && !(await railShown()), t);
    check('… and the Scheduled tab is still out of the strip', !(await strip()).includes('scheduled/main') && (await strip()).includes('side-chat/main'));
    await ev(`window.__oc_debug.mods.open('scheduled/main')`);
    await sleep(600);
    check('opening its view (a command, harness.ui.open) brings the tab back, in front', (await strip()).includes('scheduled/main') && (await ev(`document.querySelector('.mod-pane-tab[data-view="scheduled/main"]').getAttribute('aria-selected')`)) === 'true');
    await app.click('#rail-toggle');
    await sleep(400);

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 5));
    console.log(`screenshots: ${SHOTS}`);
  } catch (err) {
    check(`crashed: ${err && err.stack}`, false);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})();
