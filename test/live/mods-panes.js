// Live checks of how the mods' panels open and close, in the real window: the rail's toggle is always there at the
// right end of the chat column's top bar, drawn as a list in a box at the same size and in the same pressed style as
// the corner's ⋯ and pane toggle; it and ⌘⇧E open and close the rail, and the choice survives a relaunch; it stays
// when no rail mod is on, and goes with the corner's buttons while a page has the main column. A mod's pane is a tab
// in the side pane's one strip only once opened (the ⋯ menu opens it, opening the pane if it was closed); its × takes
// it out of the strip without stopping the mod (Delete does the same), and the strip is remembered across a relaunch.
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
  const strip = () => ev(`[...document.querySelectorAll('#pane-tabs > [role=tab]')].filter((b) => !b.hidden).map((b) => b.dataset.view || b.dataset.tab)`);
  const topShot = async (name) => {
    await ev(`document.activeElement && document.activeElement.blur()`);
    await sleep(350);
    const r = await ev(`(() => { const a = document.querySelector('.window-actions').getBoundingClientRect(); return { x: Math.max(0, a.right - 560), y: 0, width: Math.min(560, a.right), height: 240 }; })()`);
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
    const order = await ev(`[...document.querySelectorAll('.topbar-actions > button, .window-actions > button')].filter((b) => b.offsetParent).map((b) => b.id)`);
    check('the top bar\'s icon: details; then the corner\'s: ⋯ and the pane toggle', js(order) === js(['rail-toggle', 'mods-more', 'pane-toggle']), order);
    check('the rail toggle is a list inside a box', await ev(`(() => { const p = document.querySelector('#rail-toggle svg'); return !!p && !!p.querySelector('rect') && /M5 6\\.25h6/.test(p.innerHTML); })()`));
    const sizes = await ev(`['rail-toggle', 'mods-more', 'pane-toggle'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); const s = document.getElementById(id).querySelector('svg').getBoundingClientRect(); return [r.width, r.height, s.width, s.height].map(Math.round).join('x'); })`);
    check('… the same size as the others, icon included', new Set(sizes).size === 1, sizes);
    let t = await toggle();
    check('the rail is open at the start, its toggle pressed', t.shown && t.pressed === 'true' && t.active && (await railShown()), t);
    // The pane open: its toggle is pressed too, and the two pressed buttons look the same
    await ev(`(() => { if (document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-toggle').click(); })()`);
    await sleep(300);
    await ev(`document.activeElement && document.activeElement.blur()`);
    await sleep(300);
    const pressedLook = await ev(`['rail-toggle', 'pane-toggle'].map((id) => { const s = getComputedStyle(document.getElementById(id)); return s.backgroundColor + ' ' + s.color + ' ' + s.borderRadius; })`);
    check('… in the same pressed style as the pane\'s', pressedLook[0] === pressedLook[1], pressedLook);
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
    check('on a page: the rail toggle, the corner\'s buttons and the rail are hidden', (await ev(`window.__oc_debug.pages.state().open`)) && !(await toggle()).shown && !(await railShown()) && !(await ev(`!!document.querySelector('#pane-toggle').offsetParent`)));
    await app.key('e', { meta: true, shift: true });
    await sleep(300);
    check('… and ⌘⇧E does nothing there', (await layout()).railOpen === true);
    if (onScreen) await app.click(`.session-item[data-id="${onScreen}"]`);
    else await ev(`document.querySelector('.session-item')?.click()`);
    await sleep(600);
    t = await toggle();
    check('back from the page: the toggle and the rail are as they were', !(await ev(`window.__oc_debug.pages.state().open`)) && t.shown && t.pressed === 'true' && (await railShown()), t);

    // ---------- A mod's pane is a tab once opened: the ⋯ menu opens it, × takes it out ----------
    await app.waitFor(`document.querySelector('.mod-pane-tab[data-view="side-chat/main"]') !== null`, 10_000, 'the Side chat tab');
    check('a mod\'s pane waits out of the strip until it is opened', !(await strip()).includes('side-chat/main') && (await tabs()).find((x) => x.key === 'side-chat/main')?.inStrip === false, await strip());
    let items = await menuItems();
    check('the ⋯ menu lists the mods\' panes and Manage mods', items.includes('Side chat') && items.includes('Scheduled') && items.includes('Manage mods…'), items);
    await ev(`document.activeElement && document.activeElement.blur()`);
    await app.screenshotOf(path.join(SHOTS, 'more-menu-light.png'), '.popover.mods-menu', 12).catch(() => {});
    await pickMenu('Side chat');
    await app.waitFor(`window.__oc_debug.mods.views().find((v) => v.key === 'side-chat/main')?.hello`, 10_000, 'the Side chat page').catch(() => {});
    let s = await strip();
    check('picking it puts its tab last in the strip, in front', s[s.length - 1] === 'side-chat/main' && (await ev(`document.querySelector('.mod-pane-tab[data-view="side-chat/main"]').getAttribute('aria-selected')`)) === 'true', s);
    check('a mod tab in front shows its ×', await ev(`(() => { const x = document.querySelector('.mod-pane-tab[data-view="side-chat/main"] .tab-close'); return !!x && getComputedStyle(x).visibility === 'visible' && x.getBoundingClientRect().width > 0; })()`));
    await app.screenshotOf(path.join(SHOTS, 'pane-tabs-close-light.png'), '.pane-strip', 0);
    await ev(`document.querySelector('.mod-pane-tab[data-view="side-chat/main"] .tab-close').click()`);
    await sleep(500);
    s = await strip();
    check('its × takes it out of the strip; the mod keeps running', !s.includes('side-chat/main') && !(await tabs()).find((x) => x.key === 'side-chat/main').inStrip && (await ev(`window.__oc_debug.mods.views().some((v) => v.key === 'side-chat/main' && v.hello)`)), s);
    check('… and its left neighbour, the page tab, comes to the front', (await ev(`window.__oc_debug.mods.browser().tab`)) === 'browser' && (await ev(`document.querySelector('.browser-tab').getAttribute('aria-selected')`)) === 'true');
    await app.click('#pane-toggle');
    await sleep(300);
    check('the pane closed', await ev(`document.querySelector('.shell').classList.contains('pane-hidden')`));
    await menuItems();
    await pickMenu('Side chat');
    await sleep(400);
    s = await strip();
    check('the ⋯ menu brings it back in front and opens the pane', s.includes('side-chat/main') && !(await ev(`document.querySelector('.shell').classList.contains('pane-hidden')`)) && (await ev(`document.querySelector('.mod-pane-tab[data-view="side-chat/main"]').getAttribute('aria-selected')`)) === 'true', s);
    // Delete on a focused tab closes it too
    await menuItems();
    await pickMenu('Scheduled');
    await sleep(400);
    await ev(`document.querySelector('.mod-pane-tab[data-view="scheduled/main"]').focus()`);
    await app.key('Delete');
    await sleep(500);
    check('Delete on a focused mod tab closes it', !(await strip()).includes('scheduled/main') && (await strip()).includes('side-chat/main'));
    check('Diff and Terminal tabs have a × like every tab', await ev(`!!document.querySelector('#pane-tab-diff .tab-close') && !!document.querySelector('#pane-tab-terminal .tab-close')`));

    // ---------- Remembered across a relaunch: the rail closed, the Scheduled tab closed ----------
    await app.click('#rail-toggle');
    await sleep(500);
    await app.close();
    app = await launch({ mock: true, profile, project, scale: 2, config: { theme: 'light' } });
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.seat === 'tab' || v.seat === 'rail').length >= 3`, 20_000, 'the mods after the relaunch').catch(() => {});
    await sleep(800);
    t = await toggle();
    check('after a relaunch the rail is still closed, its toggle there and not pressed', t.shown && t.pressed === 'false' && !(await railShown()), t);
    check('… and the strip is as it was: Side chat in it, Scheduled out', !(await strip()).includes('scheduled/main') && (await strip()).includes('side-chat/main'), await strip());
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
