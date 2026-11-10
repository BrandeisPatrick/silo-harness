// Live checks of the side pane's one tab strip in the real window, against the mock model and the fixture site: a
// fresh profile has one page tab ("New tab") and no tool tabs; the strip is the pane's only row of tabs, level with
// the top bar; a tool opens as a tab from its shortcut and from the New tab page (whose blank tab then closes); exactly
// one tab is active at every step; a tool tab's × takes it out and its left neighbour comes forward; ←/→ move across
// pages and tools; Diff and Terminal appear by themselves, in the back, when files change or a terminal turns busy;
// #pane-toggle hides and shows the pane; no drag region lies over the page's slot; the open tools persist across a
// relaunch, and a profile from before the strip opens with its saved tool and nothing else.
// Run: npm run build && node test/live/pane-strip.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');
const { startSite } = require('./support/site.js');

const { check, done } = checker();
const js = (v) => JSON.stringify(v);

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-pane-strip-shots-'));
  const site = await startSite();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-pane-strip-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-pane-strip-project-'));
  let app = await launch({ profile, project, mode: 'bypass', mock: true, config: { theme: 'light' } });
  const ev = (x) => app.evaluate(x);
  const dbg = () => ev('window.__oc_debug.mods.browser()');
  /** The strip as drawn: each tab's entry ('page:<id>', 'diff', 'terminal', 'mod:…') and whether it is the active one */
  const strip = async () => (await dbg()).strip;
  const activeCount = () => ev(`document.querySelectorAll('#pane-tabs > [role=tab][aria-selected="true"]:not([hidden])').length`);
  const entries = async () => (await strip()).map((t) => t.tab);
  const active = async () => (await strip()).find((t) => t.active)?.tab ?? null;

  try {
    await app.waitFor(`window.__oc_debug.mods.browser().strip.length > 0`, 10_000, 'the strip');
    if (await ev(`document.querySelector('.shell').classList.contains('pane-hidden')`)) await app.click('#pane-toggle');
    await sleep(300);

    // ---------- A fresh profile ----------
    let s = await strip();
    let d = await dbg();
    check('a fresh profile: one page tab, "New tab", active, and no tool tabs', s.length === 1 && s[0].tab.startsWith('page:') && s[0].title === 'New tab' && s[0].active && d.tools.length === 0, { s, tools: d.tools });
    check('… the blank tab shows the New tab page, with no native view over it', d.newTab.shown && d.visible === false, { newTab: d.newTab, visible: d.visible });
    check('the New tab page lists the tools: Terminal and Diff with their shortcuts, then the mods\' panes', js(d.newTab.rows.slice(0, 2).map((r) => [r.tool, r.name, r.kbd])) === js([['terminal', 'Terminal', '⌘⇧T'], ['diff', 'Diff', '⌘⇧D']]) && d.newTab.rows.slice(2).every((r) => r.tool.startsWith('mod:') && !r.kbd), d.newTab.rows);
    check('… under one heading and nothing else', (await ev(`document.querySelector('#new-tab-page').innerText.split('\\n').filter((l) => l.trim())[0]`)) === 'Tools' && (await ev(`document.querySelectorAll('#new-tab-page h2, #new-tab-page p').length`)) === 1);

    // ---------- One strip, level with the top bar ----------
    const geo = await ev(`(() => {
      const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), height: Math.round(b.height) }; };
      const lists = [...document.querySelectorAll('#side-pane [role=tablist]')].filter((l) => l.getClientRects().length > 0).map((l) => l.id);
      return { strip: r('.pane-strip'), topbar: r('.topbar'), pane: r('#side-pane'), bar: r('.browser-bar'), tab: r('.strip-tab.active'), lists };
    })()`);
    check('one strip and no second row: the pane\'s only tablist, at the window\'s top, as tall as the top bar, the toolbar right under it', js(geo.lists) === js(['pane-tabs']) && geo.strip.top === 0 && geo.pane.top === 0 && geo.strip.height === geo.topbar.height && geo.strip.bottom === geo.topbar.bottom && geo.bar.top === geo.strip.bottom, geo);
    const look = await ev(`(() => { const t = document.querySelector('.strip-tab.active'); const s = getComputedStyle(t); const p = document.createElement('span'); p.style.background = 'var(--bg-000)'; document.body.append(p); const surface = getComputedStyle(p).backgroundColor; p.style.background = 'var(--bg-200)'; const chrome = getComputedStyle(p).backgroundColor; p.remove(); return { h: Math.round(t.getBoundingClientRect().height), radius: s.borderTopLeftRadius, bg: s.backgroundColor, surface, row: getComputedStyle(document.querySelector('.pane-strip')).backgroundColor, chrome, border: s.borderTopWidth + ' ' + s.borderBottomWidth, fs: getComputedStyle(t.querySelector('.tab-title')).fontSize, bar: Math.round(document.querySelector('.browser-bar').getBoundingClientRect().height), pill: Math.round(document.querySelector('.url-pill').getBoundingClientRect().height), plus: Math.round(document.querySelector('#browser-tab-new').getBoundingClientRect().width) }; })()`);
    check('the strip on the chrome surface; the active tab 30 px, 8 px round, on the page surface with a hairline; titles at 13 px', look.row === look.chrome && look.h === 30 && look.radius === '8px' && look.bg === look.surface && look.border === '1px 1px' && look.fs === '13px', look);
    check('the toolbar 48 px with a 34 px pill; + is 28 px', look.bar === 48 && look.pill === 34 && look.plus === 28, look);

    // ---------- Pages and tools ----------
    await ev(`oc.rpc('browser.go', ${js(site.base + '/landing.html')})`);
    await app.waitFor(`window.__oc_debug.mods.browser().strip[0]?.title === 'Landing'`, 10_000, 'the landing page');
    d = await dbg();
    check('a page in the tab: the New tab page goes and the native view shows', !d.newTab.shown && d.visible === true, { newTab: d.newTab.shown, visible: d.visible });
    await app.key('d', { meta: true, shift: true });
    await sleep(300);
    s = await strip();
    check('⌘⇧D opens Diff as a tab, last, active; no page tab looks active', s.length === 2 && s[1].tab === 'diff' && s[1].active && !s[0].active && (await activeCount()) === 1, s);
    check('… and Diff\'s pane shows', (await ev(`!document.querySelector('#diff-pane').hidden && document.querySelector('#browser-pane').hidden`)) === true);
    await app.key('d', { meta: true, shift: true });
    await sleep(300);
    check('⌘⇧D again hides the pane (the tab stays)', (await ev(`document.querySelector('.shell').classList.contains('pane-hidden')`)) && (await dbg()).tools.includes('diff'));
    await app.key('d', { meta: true, shift: true });
    await sleep(300);

    // The New tab page: + opens a blank tab last; its Terminal row opens Terminal and the blank tab closes
    await app.click('#browser-tab-new');
    await app.waitFor(`window.__oc_debug.mods.browser().strip.length === 3`, 5000, 'the new tab');
    s = await strip();
    d = await dbg();
    check('+ opens a blank page tab after the last tab, in front, showing the New tab page', s[2].tab.startsWith('page:') && s[2].title === 'New tab' && s[2].active && d.tab === 'browser' && d.newTab.shown && (await activeCount()) === 1, s);
    await app.screenshotOf(path.join(shots, 'strip-newtab.png'), '#side-pane', 0);
    await ev(`window.__oc_debug.terminal.mock(true)`);
    await app.click('#new-tab-page .ntp-row[data-tool="terminal"]');
    await app.waitFor(`window.__oc_debug.mods.browser().strip.length === 3 && window.__oc_debug.mods.browser().tab === 'terminal'`, 5000, 'Terminal from the New tab page').catch(() => {});
    s = await strip();
    check('a New tab page row opens its tool as a tab, in front; the blank tab it was in closes', js(s.map((t) => t.tab.replace(/^page:.*/, 'page'))) === js(['page', 'diff', 'terminal']) && s[2].active && (await activeCount()) === 1, s);

    // Arrow keys move across the whole strip
    await ev(`document.querySelector('#pane-tab-terminal').focus()`);
    await app.key('ArrowLeft');
    await sleep(200);
    check('← moves to the tab on the left (a tool)', (await active()) === 'diff' && (await ev(`document.activeElement.id`)) === 'pane-tab-diff');
    await app.key('ArrowLeft');
    await sleep(300);
    check('… and on to a page tab, bringing the browser forward', (await active())?.startsWith('page:') && (await dbg()).tab === 'browser' && (await ev(`document.activeElement.classList.contains('browser-tab')`)));
    await app.key('ArrowLeft');
    await sleep(200);
    check('… wrapping around to the last', (await active()) === 'terminal');

    // × on a tool tab: out of the strip, the left neighbour in front
    await app.click('#pane-tab-terminal .tab-close');
    await sleep(300);
    s = await strip();
    check('× on the active tool tab takes it out; its left neighbour (Diff) comes forward', js(s.map((t) => t.tab.replace(/^page:.*/, 'page'))) === js(['page', 'diff']) && (await active()) === 'diff' && (await activeCount()) === 1, s);
    check('… its terminal keeps running', (await ev(`window.__oc_debug.terminal.tabs().length`)) >= 1);
    await app.click('#pane-tab-diff .tab-close');
    await sleep(300);
    s = await strip();
    check('× on the last tool: the page tab on its left comes forward', s.length === 1 && s[0].active && (await dbg()).tab === 'browser', s);

    // Diff and Terminal appear by themselves, in the back
    await ev(`window.__oc_debug.mockChanges([{ path: ${js(path.join(project, 'a.txt'))}, relPath: 'a.txt', status: 'modified', additions: 2, deletions: 1, source: 'session' }])`);
    await app.waitFor(`window.__oc_debug.mods.browser().tools.includes('diff')`, 5000, 'Diff to appear').catch(() => {});
    s = await strip();
    check('files changing (0 → 1) bring the Diff tab into the strip, without taking the front', s.some((t) => t.tab === 'diff' && !t.active) && (await dbg()).tab === 'browser' && (await ev(`!document.querySelector('#pane-diff-count').hidden && document.querySelector('#pane-diff-count').textContent === '1'`)), s);
    await ev(`window.__oc_debug.terminal.input('sleep 3\\r')`);
    await app.waitFor(`window.__oc_debug.mods.browser().tools.includes('terminal')`, 5000, 'Terminal to appear').catch(() => {});
    s = await strip();
    check('a terminal turning busy brings the Terminal tab in, its busy dot on, without taking the front', s.some((t) => t.tab === 'terminal' && !t.active) && (await dbg()).tab === 'browser' && (await ev(`!document.querySelector('#pane-terminal-busy').hidden`)), s);
    check('exactly one active tab', (await activeCount()) === 1);

    // The pane's toggle
    const toggled = [];
    for (let i = 0; i < 2; i++) {
      await app.click('#pane-toggle');
      await sleep(250);
      toggled.push(await ev(`({ hidden: document.querySelector('.shell').classList.contains('pane-hidden'), pressed: document.querySelector('#pane-toggle').getAttribute('aria-pressed'), at: Math.round(document.querySelector('#pane-toggle').getBoundingClientRect().right) })`));
    }
    check('#pane-toggle hides the pane and shows it again, pressed while it is open, at the window\'s right edge both times', toggled[0].hidden && toggled[0].pressed === 'false' && !toggled[1].hidden && toggled[1].pressed === 'true' && toggled[0].at === toggled[1].at && toggled[0].at >= 1440 - 16, toggled);

    // No drag region over the page's slot
    const drag = await ev(`(() => {
      const view = document.getElementById('browser-view').getBoundingClientRect();
      const hit = [];
      let regions = 0;
      for (const el of document.querySelectorAll('*')) {
        const s = getComputedStyle(el);
        if ((s.getPropertyValue('app-region') || s.getPropertyValue('-webkit-app-region')) !== 'drag') continue;
        regions++;
        const r = el.getBoundingClientRect();
        if (r.width && r.height && r.left < view.right && r.right > view.left && r.top < view.bottom && r.bottom > view.top) hit.push(el.className);
      }
      return { regions, hit, view: { top: Math.round(view.top), height: Math.round(view.height) } };
    })()`);
    check('no drag region overlaps #browser-view', drag.regions > 0 && drag.hit.length === 0 && drag.view.height > 0, drag);

    // ---------- Relaunch ----------
    await app.click('#pane-tab-diff');
    await sleep(300);
    const before = (await dbg()).tools;
    await app.close();
    app = await launch({ profile, project, mode: 'bypass', mock: true, config: { theme: 'light' } });
    await app.waitFor(`window.__oc_debug.mods.browser().strip.length > 0`, 10_000, 'the strip after a relaunch');
    await sleep(500);
    d = await dbg();
    check('after a relaunch the open tools are there in their order, the one in front still in front, after the page tab', js(d.tools) === js(before) && d.tab === 'diff' && d.strip[0].tab.startsWith('page:') && js(d.strip.slice(1).map((t) => t.tab)) === js(before), { before, after: d.tools, tab: d.tab, strip: d.strip });

    // A profile from before the strip: its saved tab open and nothing else
    await ev(`(() => { localStorage.removeItem('paneTools'); localStorage.setItem('paneTab', 'terminal'); localStorage.setItem('pane', 'shown'); })()`);
    await app.close();
    app = await launch({ profile, project, mode: 'bypass', mock: true, config: { theme: 'light' } });
    await app.waitFor(`window.__oc_debug.mods.browser().strip.length > 0`, 10_000, 'the strip after the second relaunch');
    await sleep(500);
    d = await dbg();
    check('a profile saved before the strip opens with its saved tool (Terminal) in front and no other tool', js(d.tools) === js(['terminal']) && d.tab === 'terminal', { tools: d.tools, tab: d.tab });

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${shots}`);
  } catch (err) {
    check(`crashed: ${err && err.stack}`, false);
  } finally {
    await app.close();
    site.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})();
