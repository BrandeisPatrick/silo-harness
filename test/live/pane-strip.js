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
const { launch, checker, sleep, cdpAt } = require('./rig.js');
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
  /** A hidden window draws (and runs its resize observers) only when asked: a tiny capture draws a frame */
  const paint = async () => {
    for (let i = 0; i < 2; i++) await app.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
    await sleep(100);
  };

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

    // ---------- A narrow strip ----------
    // Five tabs: Landing, Diff (with its count), Terminal, a mod's pane, and a page with a long title, in front
    await app.click('#browser-tab-new');
    await app.waitFor(`window.__oc_debug.mods.browser().newTab.shown`, 5000, 'the New tab page');
    const modRow = (await dbg()).newTab.rows.find((r) => r.tool.startsWith('mod:'));
    await app.click(`#new-tab-page .ntp-row[data-tool=${js(modRow.tool)}]`);
    await app.waitFor(`window.__oc_debug.mods.browser().tab === ${js(modRow.tool)}`, 5000, 'the mod tab');
    await app.click('#browser-tab-new');
    await app.waitFor(`window.__oc_debug.mods.browser().newTab.shown`, 5000, 'a second blank tab');
    const LONG = 'Rate limits · Atlas API docs';
    await ev(`oc.rpc('browser.go', ${js(`${site.base}/other.html?long`)})`);
    await app.waitFor(`window.__oc_debug.mods.browser().strip.some((t) => t.title === 'Another site')`, 10_000, 'the second page');
    await cdpAt(await app.pageTarget(`${site.base}/other.html?long`), 'Runtime.evaluate', { expression: `document.title = ${js(LONG)}` });
    await app.waitFor(`window.__oc_debug.mods.browser().strip.some((t) => t.title === ${js(LONG)})`, 5000, 'the long title');
    s = await strip();
    check('five tabs: two pages, Diff, Terminal and a mod\'s pane, the long page in front', s.length === 5 && s[4].title === LONG && s[4].active, s);
    /** The strip as laid out: each tab's box, title, whether its title is cut or hidden, and the strip's overflow */
    const STRIP_GEO = `(() => {
      const strip = document.getElementById('pane-tabs');
      const ctx = document.createElement('canvas').getContext('2d');
      const tabs = [...strip.querySelectorAll(':scope > [role=tab]:not([hidden])')].map((el) => {
        const t = el.querySelector('.tab-title');
        const r = el.getBoundingClientRect();
        const tr = t.getBoundingClientRect();
        ctx.font = getComputedStyle(t).font;
        return {
          tab: el.dataset.tab, tool: !el.dataset.tab.startsWith('page:'), active: el.getAttribute('aria-selected') === 'true',
          left: r.left, right: r.right, width: r.width, text: t.textContent,
          shown: tr.width > 1, cut: t.scrollWidth > t.clientWidth + 1, six: tr.width + 1 >= ctx.measureText(t.textContent.slice(0, 6) + '…').width,
          close: (() => { const c = el.querySelector('.tab-close'); return c ? c.getClientRects().length > 0 : false; })(),
          name: el.getAttribute('aria-label') || '', tip: el.dataset.tip || '',
        };
      });
      const box = strip.getBoundingClientRect();
      return { tabs, scrolled: strip.scrollWidth > strip.clientWidth + 1, inView: tabs.every((t) => t.left >= box.left - 1 && t.right <= box.right + 1) };
    })()`;
    /** What must hold at any width: short titles never cut, the active one titled with its × and at least 112 px,
     *  a cut title showing six characters, and the quiet tools all alike */
    const rules = (g) => {
      const quietTools = g.tabs.filter((t) => t.tool && !t.active);
      const act = g.tabs.find((t) => t.active);
      return (
        g.tabs.every((t) => t.text.length > 8 || !t.shown || !t.cut) &&
        g.tabs.every((t) => !t.shown || !t.cut || t.six) &&
        act && act.shown && act.close && act.width >= 111.5 &&
        quietTools.every((t) => t.shown === quietTools[0].shown)
      );
    };
    const atWidth = async (px) => {
      await ev(`document.getElementById('side-pane').style.setProperty('--browser-w', '${px}px')`);
      await paint();
      return ev(STRIP_GEO);
    };
    const widths = {};
    for (const px of [900, 700, 569, 480, 424, 360]) {
      const g = await atWidth(px);
      widths[px] = g;
      check(`a ${px} px pane: short titles whole, the active tab titled with its ×, cut titles keep six characters, quiet tools alike`, rules(g), g.tabs.map((t) => [t.tab, Math.round(t.width), t.shown, t.cut]));
    }
    check('a wide pane (900 px): every tab with its whole title, or 200 px wide (the most a tab gets)', widths[900].tabs.every((t) => t.shown && (!t.cut || Math.round(t.width) === 200)) && !widths[900].scrolled, widths[900].tabs.map((t) => [t.tab, Math.round(t.width), t.cut]));
    const g424 = widths[424];
    check('at 424 px (details open): no tab scrolled away', !g424.scrolled && g424.inView, g424);
    check('… the quiet tool tabs show no title, only their icon (Diff its count)', g424.tabs.filter((t) => t.tool && !t.active).every((t) => !t.shown && !t.close), g424.tabs);
    check('… "Diff" and "Terminal" are never cut, at any width', Object.values(widths).every((g) => g.tabs.filter((t) => t.text === 'Diff' || t.text === 'Terminal').every((t) => !t.shown || !t.cut)));
    check('… an icon-only tab keeps its full name for screen readers and its title in the tooltip', g424.tabs.filter((t) => !t.shown).every((t) => t.name.includes(t.text) && t.tip.includes(t.text)), g424.tabs.map((t) => [t.text, t.name, t.tip]));
    check('the tabs shorten in order: pages titled while tools are icons at 569 px or less, pages icon-only only later', [569, 480, 424].every((px) => widths[px].tabs.filter((t) => !t.tool && !t.active).every((t) => t.shown) || widths[px].tabs.filter((t) => t.tool && !t.active).every((t) => !t.shown)), Object.fromEntries(Object.entries(widths).map(([k, g]) => [k, g.tabs.map((t) => t.shown)])));

    // Hovering a quiet titled tab shows its × over its title and moves nothing
    let g = await atWidth(700);
    const quiet = g.tabs.find((t) => !t.active && t.shown);
    const at = await ev(`(() => { const r = document.querySelector('[data-tab=${js(quiet.tab)}]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await sleep(200);
    const hovered = await ev(STRIP_GEO);
    check('hovering a quiet tab shows its × and moves no tab', hovered.tabs.find((t) => t.tab === quiet.tab).close && js(hovered.tabs.map((t) => Math.round(t.left))) === js(g.tabs.map((t) => Math.round(t.left))), { before: g.tabs.map((t) => Math.round(t.left)), after: hovered.tabs.map((t) => Math.round(t.left)) });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 400 });

    // Larger type (a look's font): the strip is fitted again
    await ev(`(() => { const st = document.createElement('style'); st.id = 'test-type'; st.textContent = '.strip-tab, .strip-probe { font-size: 16px !important; }'; document.head.append(st); })()`);
    await paint();
    g = await ev(STRIP_GEO);
    check('larger type: the strip is fitted again (short titles whole, nothing broken)', rules(g) && g.tabs.filter((t) => t.text.length <= 8).every((t) => !t.shown || !t.cut), g.tabs.map((t) => [t.tab, Math.round(t.width), t.shown, t.cut]));
    await ev(`document.getElementById('test-type').remove()`);
    await paint();

    // A middle click closes an icon-only tab (the mod's pane)
    g = await atWidth(424);
    const iconTab = g.tabs.find((t) => t.tab === modRow.tool);
    const mid = { x: (iconTab.left + iconTab.right) / 2, y: await ev(`document.querySelector('[data-tab=${js(modRow.tool)}]').getBoundingClientRect().top + 15`) };
    for (const type of ['mousePressed', 'mouseReleased']) await app.cdp('Input.dispatchMouseEvent', { type, x: mid.x, y: mid.y, button: 'middle', clickCount: 1 });
    await sleep(300);
    check('a middle click closes an icon-only tab', !iconTab.shown && !(await dbg()).tools.includes(modRow.tool), (await dbg()).tools);
    // Activating a tool at 424 px: it gets its title, the other tools stay icons
    await app.click('#pane-tab-diff');
    await sleep(250);
    g = await ev(STRIP_GEO);
    check('the active tool tab shows its title and × even where the other tools are icons', rules(g) && g.tabs.find((t) => t.tab === 'diff').shown && g.tabs.find((t) => t.tab === 'diff').close, g.tabs.map((t) => [t.tab, Math.round(t.width), t.shown]));
    await ev(`document.getElementById('side-pane').style.removeProperty('--browser-w')`);
    await sleep(200);

    // ---------- The Terminal pane's own row ----------
    const term = async () => (await paint(), ev(`(() => {
      const bar = document.getElementById('terminal-bar');
      const host = document.getElementById('terminal-host').getBoundingClientRect();
      const rows = document.querySelector('#terminal-host .term-view:not([hidden]) .xterm-rows')?.children.length ?? 0;
      return { n: window.__oc_debug.terminal.tabs().length, bar: !bar.hidden && bar.getClientRects().length > 0, hostTop: Math.round(host.top), stripBottom: Math.round(document.querySelector('.pane-strip').getBoundingClientRect().bottom), rows, empty: !document.getElementById('terminal-empty').hidden, emptyText: document.getElementById('terminal-empty').innerText };
    })()`));
    await app.click('#pane-tab-terminal');
    await sleep(400);
    let t = await term();
    check('one terminal: no row of terminals; the terminal starts right under the strip', t.n === 1 && !t.bar && t.hostTop === t.stripBottom && t.rows > 0, t);
    const oneRows = t.rows;
    await ev(`document.querySelector('#terminal-host .xterm-helper-textarea')?.focus()`);
    await app.key('t', { meta: true });
    await app.waitFor(`window.__oc_debug.terminal.tabs().length === 2`, 5000, 'a second terminal').catch(() => {});
    await sleep(400);
    t = await term();
    check('⌘T from inside the terminal opens a second one; the row shows, and the terminal refits to fewer rows', t.n === 2 && t.bar && t.hostTop > t.stripBottom && t.rows > 0 && t.rows < oneRows, { ...t, oneRows });
    await ev(`document.querySelector('#terminal-tabs .term-tab.active .term-tab-close').click()`);
    await app.waitFor(`window.__oc_debug.terminal.tabs().length === 1`, 5000, 'back to one terminal').catch(() => {});
    await sleep(400);
    t = await term();
    check('… closing one hides the row again and the terminal gets its rows back', t.n === 1 && !t.bar && t.rows === oneRows, { ...t, oneRows });
    await ev(`document.querySelector('#pane-tab-diff').focus()`);
    await app.key('t', { meta: true });
    await app.waitFor(`window.__oc_debug.terminal.tabs().length === 2`, 5000, 'a terminal from ⌘T elsewhere').catch(() => {});
    t = await term();
    check('⌘T from the strip (the row hidden) also opens one', t.n === 2 && (await dbg()).tab === 'terminal', t);
    await ev(`document.querySelector('#terminal-tabs .term-tab.active .term-tab-close').click()`);
    await app.waitFor(`window.__oc_debug.terminal.tabs().length === 1`, 5000, 'one terminal again').catch(() => {});

    // The New tab page: with the Terminal tab open on a terminal, its row starts another
    await app.click('#browser-tab-new');
    await app.waitFor(`window.__oc_debug.mods.browser().newTab.shown`, 5000, 'the New tab page');
    let rows = (await dbg()).newTab.rows;
    check('the New tab page offers "New terminal ⌘T" while the Terminal tab is open on a terminal', rows[0].tool === 'terminal:new' && rows[0].name === 'New terminal' && rows[0].kbd === '⌘T', rows[0]);
    await app.click('#new-tab-page .ntp-row[data-tool="terminal:new"]');
    await app.waitFor(`window.__oc_debug.terminal.tabs().length === 2`, 5000, 'a terminal from the New tab page').catch(() => {});
    await sleep(300);
    t = await term();
    check('… a click brings the Terminal tab forward with a new terminal (the row shows: two now)', t.n === 2 && t.bar && (await dbg()).tab === 'terminal', t);
    // No terminal at all (the last one closed): the empty state still offers one
    for (let i = 0; i < 4 && (await ev(`window.__oc_debug.terminal.tabs().length`)); i++) {
      await ev(`document.querySelector('#terminal-tabs .term-tab .term-tab-close')?.click()`);
      await sleep(300);
    }
    t = await term();
    check('no terminal at all: no row, and the empty state offers "New terminal"', t.n === 0 && !t.bar && t.empty && /New terminal/.test(t.emptyText), t);
    await app.click('#terminal-empty [data-action="new"]');
    await app.waitFor(`window.__oc_debug.terminal.tabs().length === 1`, 5000, 'a terminal from the empty state').catch(() => {});
    await sleep(300);
    t = await term();
    check('… which starts one, under the strip', t.n === 1 && !t.bar && !t.empty && t.hostTop === t.stripBottom, t);
    // The Terminal tab closed: the New tab page offers the Terminal tab again
    await app.click('#pane-tab-terminal .tab-close');
    await app.click('#browser-tab-new');
    await app.waitFor(`window.__oc_debug.mods.browser().newTab.shown`, 5000, 'the New tab page');
    rows = (await dbg()).newTab.rows;
    check('with the Terminal tab closed the row is "Terminal ⌘⇧T" again', rows[0].tool === 'terminal' && rows[0].name === 'Terminal' && rows[0].kbd === '⌘⇧T', rows[0]);
    // The browser in front again for the checks below
    await ev(`document.querySelector('#pane-tabs > .browser-tab').click()`);
    await sleep(300);

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
