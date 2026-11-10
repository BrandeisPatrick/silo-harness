// Live check of the settings page in the real window: every section in light and dark at two window sizes, one
// control of each kind applied at once and still there after a relaunch, rejected values, a field a settings.json
// owns, search, Esc and the keyboard, the MCP and rules panels, the mods list (real backend), the old entry points.
// Features this build does not have (settings.info, app.info, history.*) are driven through
// window.__oc_debug.settings.mock. The model is never called, so this runs against the mock model.
//
// Run: npm run build && node test/live/settings-page.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

// Scheduled and Dreaming are pages of their own now (test/live/pages.js); a search finds them under Pages
const SECTIONS = ['general', 'model', 'permissions', 'context', 'mods', 'mcp', 'skills', 'remote', 'history', 'appearance', 'files', 'about'];
const now = Date.now();
const MOCK = {
  info: {
    files: [
      { scope: 'user', path: '/Users/me/.silo-harness/settings.json', exists: true, applied: true, trusted: true, keys: ['maxTurns', 'portkey.model', 'env.GITHUB_TOKEN'], invalid: [{ key: 'theme', message: 'expected "system", "light" or "dark"' }] },
      { scope: 'project', path: '/Users/me/project/.silo-harness/settings.json', exists: true, applied: false, trusted: false, keys: ['permissionMode'], invalid: [] },
    ],
    owned: { maxTurns: 'user', 'portkey.model': 'user' },
  },
  app: { name: 'Silo Harness', version: '0.1.0', electron: '45.0.0', chrome: '142.0.0.0', node: '22.20.0', platform: 'darwin', arch: 'arm64', userData: '/Users/me/Library/Application Support/Silo Harness', configDir: '/Users/me/.open-harness' },
  history: {
    stats: { sessions: 42, bytes: 18234567, trash: 2, trashBytes: 129000, dir: '/Users/me/Library/Application Support/Silo Harness/history' },
    trash: [
      { id: 't1', title: 'Fix the flaky login test', deletedAt: now - 2 * 86400000, purgeAt: now + 28 * 86400000, messageCount: 14, bytes: 120000 },
      { id: 't2', title: 'Explore the build', deletedAt: now - 3600000, purgeAt: now + 30 * 86400000, messageCount: 3, bytes: 9000 },
    ],
  },
};

const js = (v) => JSON.stringify(v);

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-settings-shots-'));
  const { check, done } = checker();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-settings-profile-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-settings-project-'));
  // A skill so its section has rows to look at.
  fs.mkdirSync(path.join(project, '.silo-harness', 'skills', 'release-notes'), { recursive: true });
  fs.writeFileSync(path.join(project, '.silo-harness', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Write release notes from the merged pull requests since the last tag.\n---\nSteps…\n');

  const open = async (app, section) => {
    await app.evaluate(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-${section}')?.click(); })()`);
    await sleep(300);
  };
  const isOpen = (app) => app.evaluate(`document.querySelector('#settings').open`);
  const cfg = (app) => app.evaluate('window.oc.getConfig()');

  let app;
  try {
    // ---------- Screenshots: light and dark, 1440 × 900 and 1000 × 640 ----------
    for (const size of [{ width: 1440, height: 900 }, { width: 1000, height: 640 }]) {
      for (const theme of ['light', 'dark']) {
        app = await launch({ mock: true, size, project, config: { theme } });
        await app.evaluate(`window.__oc_debug.settings.mock(${js(MOCK)})`);
        await app.evaluate(`window.__oc_debug.rules.mock({ cwd: ${js(project)}, programs: ['git', 'npm'], reasons: ['uses sudo'], edits: true, mcp: [] })`);
        for (const s of SECTIONS) {
          await open(app, s);
          if (s === 'mods') await app.evaluate(`document.querySelector('.sp-mod:not(.sp-tab-out) .sp-mod-expand')?.click()`);
          await sleep(150);
          await app.screenshot(path.join(shots, `${size.width}-${theme}-${s}.png`));
        }
        // Layout: the controls sit in one column at the right, nothing overflows the page horizontally.
        await open(app, 'general');
        const layout = await app.evaluate(`(() => {
          const body = document.querySelector('#settings-body');
          const rights = [...document.querySelectorAll('.sp-section.current .sp-row:not(.full) .sp-row-control')].map((c) => Math.round(c.getBoundingClientRect().right));
          const dlg = document.querySelector('#settings').getBoundingClientRect();
          return { rights, overflow: body.scrollWidth - body.clientWidth, dlg: { w: Math.round(dlg.width), h: Math.round(dlg.height) } };
        })()`);
        check(`${size.width}/${theme}: controls align at the right`, new Set(layout.rights).size === 1, layout.rights);
        check(`${size.width}/${theme}: no horizontal overflow`, layout.overflow <= 0, layout);
        await open(app, 'mods');
        const modRights = await app.evaluate(`[...document.querySelectorAll('.sp-section.current .sp-row .sp-row-control')].filter((c) => c.offsetParent).map((c) => Math.round(c.getBoundingClientRect().right))`);
        check(`${size.width}/${theme}: mod switches align with the other controls`, new Set(modRights).size === 1, modRights);
        const errs = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
        check(`${size.width}/${theme}: no renderer errors`, errs.length === 0, errs.slice(0, 3));
        await app.close();
        app = null;
      }
    }

    // ---------- Behaviour, on a profile kept for a relaunch ----------
    app = await launch({ mock: true, profile, project });
    await app.evaluate(`window.__oc_debug.settings.mock(${js({ app: MOCK.app, history: MOCK.history })})`);

    // Entry points
    await app.click('#settings-btn');
    check('the sidebar button opens it', await isOpen(app));
    await app.key('Escape');
    check('Esc closes it', !(await isOpen(app)));
    await app.key(',', { meta: true });
    await sleep(200);
    check('⌘, opens it', await isOpen(app));
    await app.evaluate(`document.querySelector('#settings-close').click()`);
    await app.evaluate(`document.querySelector('#conn-settings').click()`);
    check("the connection banner's Settings button opens it", await isOpen(app));
    await app.evaluate(`document.querySelector('#settings').close()`);
    await app.send('/mcp');
    await app.waitFor(`Boolean(document.querySelector('.mcp-manage'))`, 5000);
    await app.click('.mcp-manage');
    await sleep(200);
    check('"Manage in Settings…" opens MCP servers', (await app.evaluate('window.__oc_debug.settings.state().section')) === 'mcp' && (await isOpen(app)));
    await app.evaluate(`document.querySelector('#settings').close()`);

    // One control of each kind, applied at once
    await open(app, 'general');
    const before = await cfg(app);
    await app.click('#sp-row-notifications input.switch');
    await app.evaluate(`[...document.querySelectorAll('#sp-row-keepAwake input')].find((i) => i.value === 'always').click()`);
    await app.fill('#maxTurns', '25');
    await app.evaluate(`document.querySelector('#maxTurns').blur()`);
    await open(app, 'context');
    await app.fill('#compactThreshold', '0.65');
    await open(app, 'model');
    await app.fill('#portkey-contextWindow', '150000');
    await app.key('Enter');
    await sleep(500);
    let c = await cfg(app);
    check('switch applied (notifications)', c.notifications === !before.notifications, c.notifications);
    check('segmented applied (keep awake)', c.keepAwake === 'always', c.keepAwake);
    check('text applied on blur (max tool turns)', c.maxTurns === 25, c.maxTurns);
    check('select applied (compact at)', c.compactThreshold === 0.65, c.compactThreshold);
    check('text applied on Enter (context window)', c.portkey.contextWindow === 150000, c.portkey.contextWindow);
    check('the Saved tick showed', await app.exists('#sp-row-portkey-contextWindow .sp-saved.show'));

    // Rejected values: nothing saved, the problem inline
    await open(app, 'general');
    await app.fill('#maxTurns', '0');
    await app.evaluate(`document.querySelector('#maxTurns').blur()`);
    await sleep(300);
    check('max tool turns 0 shows the problem', /from 1 to 500/.test((await app.text('#sp-row-maxTurns .sp-problem')) || ''), await app.text('#sp-row-maxTurns .sp-problem'));
    check('max tool turns 0 is not saved', (await cfg(app)).maxTurns === 25);
    await app.screenshot(path.join(shots, 'rejected-maxturns.png'));
    await app.fill('#maxTurns', '30');
    await app.evaluate(`document.querySelector('#maxTurns').blur()`);
    await sleep(300);
    check('a valid value clears the problem and saves', (await cfg(app)).maxTurns === 30 && !(await app.exists('#sp-row-maxTurns.invalid')));
    await open(app, 'model');
    // The Ollama rows show only for Ollama: switch to it to edit one, then back.
    await app.fill('#provider', 'ollama');
    await sleep(300);
    await app.fill('#ollama-numCtx', 'abc');
    await app.evaluate(`document.querySelector('#ollama-numCtx').blur()`);
    const numCtxProblem = /whole number/.test((await app.text('#sp-row-ollama-numCtx .sp-problem')) || '');
    check('Ollama rows show for Ollama', await app.evaluate(`Boolean(document.querySelector('#sp-row-ollama-numCtx').offsetParent) && !document.querySelector('#sp-row-portkey-apiKey').offsetParent`));
    await app.fill('#ollama-numCtx', String(before.ollama.numCtx));
    await app.evaluate(`document.querySelector('#ollama-numCtx').blur()`);
    await app.fill('#provider', 'portkey');
    await sleep(300);
    await app.fill('#portkey-contextWindow', 'abc');
    await app.evaluate(`document.querySelector('#portkey-contextWindow').blur()`);
    await sleep(300);
    c = await cfg(app);
    check('a context size of "abc" shows the problem', /whole number/.test((await app.text('#sp-row-portkey-contextWindow .sp-problem')) || '') && numCtxProblem, numCtxProblem);
    check('"abc" is not saved', c.portkey.contextWindow === 150000 && c.ollama.numCtx === before.ollama.numCtx, [c.portkey.contextWindow, c.ollama.numCtx]);
    await app.screenshot(path.join(shots, 'rejected-context.png'));
    await app.fill('#portkey-contextWindow', '150000');
    await app.evaluate(`document.querySelector('#portkey-contextWindow').blur()`);

    // Provider: only the selected provider's rows show
    const visible = (id) => app.evaluate(`(() => { const e = document.querySelector('#sp-row-${id}'); return Boolean(e && e.offsetParent); })()`);
    check('gateway rows show for the gateway', (await visible('portkey-apiKey')) && !(await visible('ollama-baseURL')));

    // An owned field (the main-process side is absent here: through the mock)
    await app.evaluate(`window.__oc_debug.settings.mock(${js(MOCK)})`);
    await sleep(300);
    await open(app, 'general');
    check('a field settings.json owns is disabled', await app.evaluate(`document.querySelector('#maxTurns').disabled`));
    check('… with the pill and the path as its tooltip', /settings\.json/.test(await app.evaluate(`document.querySelector('#sp-row-maxTurns .sp-owned')?.title ?? ''`)));
    await app.screenshot(path.join(shots, 'owned.png'));
    await app.click('#sp-row-maxTurns .sp-owned');
    await sleep(200);
    check('clicking the pill opens Configuration files', (await app.evaluate('window.__oc_debug.settings.state().section')) === 'files');
    await app.evaluate(`[...document.querySelectorAll('#sp-sec-files button')].find((b) => /Trust and apply/.test(b.innerText)).click()`);
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000);
    await app.click('#confirm-ok');
    await sleep(300);
    check('Trust and apply reaches settings.trustProject', (await app.evaluate('window.__oc_debug.settings.calls()')).some((x) => x.method === 'settings.trustProject' && x.args[0] === true));
    check('… and the project file now shows Applied', /Applied/.test(await app.text('#sp-sec-files')));

    // Search
    const searchFor = async (q) => {
      await app.fill('#settings-search', q);
      await sleep(150);
      return app.evaluate(`({ rows: [...document.querySelectorAll('.sp-section.has-hit .sp-row.hit')].filter((r) => r.offsetParent).map((r) => r.dataset.row), empty: !document.querySelector('#settings-empty').hidden, dim: [...document.querySelectorAll('.sp-nav-item.dim')].length })`);
    };
    let s = await searchFor('theme');
    check('search "theme" finds Theme', s.rows.includes('theme'), s.rows);
    await app.screenshot(path.join(shots, 'search-theme.png'));
    s = await searchFor('key');
    check('search "key" finds the API keys (of either provider)', s.rows.includes('portkey-apiKey') && s.rows.includes('portkey-providerApiKey') && s.rows.includes('portkey-virtualKey'), s.rows);
    check('… and dims sections without a match', s.dim > 3, s.dim);
    await app.screenshot(path.join(shots, 'search-key.png'));
    s = await searchFor('sleep');
    check('search "sleep" finds Keep awake', s.rows.includes('keepAwake') && s.rows.length <= 3, s.rows);
    s = await searchFor('dream');
    check('search "dream" finds the Dreaming page (no longer a section), listed first', s.rows[0] === 'page-dreaming' && s.rows.includes('page-dreaming-daily'), s.rows);
    s = await searchFor('cron');
    check('search "cron" finds the Scheduled tasks page', s.rows.includes('page-scheduled'), s.rows);
    s = await searchFor('zqxv blorf');
    check('nonsense says nothing matches', s.empty && s.rows.length === 0, s);
    await app.screenshot(path.join(shots, 'search-none.png'));
    await app.evaluate(`document.querySelector('#settings-search').focus()`);
    await app.key('Escape');
    await sleep(150);
    check('Esc first clears the search', (await isOpen(app)) && (await app.evaluate(`document.querySelector('#settings-search').value`)) === '');
    check('… and the section that was open comes back', (await app.evaluate('window.__oc_debug.settings.state().section')) === 'files' && (await visible('files-reload')));
    await app.key('Escape');
    check('… then Esc closes', !(await isOpen(app)));

    // Keyboard navigation
    await app.click('#settings-btn');
    await app.evaluate(`document.querySelector('#sp-nav-files').focus()`);
    await app.key('ArrowDown');
    await sleep(100);
    check('ArrowDown moves to the next section', (await app.evaluate('window.__oc_debug.settings.state().section')) === 'hooks' && (await app.evaluate(`document.activeElement.id`)) === 'sp-nav-hooks');
    await app.key('ArrowUp');
    await app.key('ArrowUp');
    check('ArrowUp goes back', (await app.evaluate('window.__oc_debug.settings.state().section')) === 'appearance');
    check('every control has a name', await app.evaluate(`[...document.querySelectorAll('#settings input, #settings select, #settings textarea')].filter((e) => e.offsetParent && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !e.labels?.length && !e.closest('label')).map((e) => e.id || e.outerHTML.slice(0, 80)).length === 0`));

    // A feature that is absent hides its section
    await app.evaluate(`window.__oc_debug.settings.mock(${js({ app: MOCK.app, history: null })})`);
    await sleep(300);
    check('without history.* the History section and its nav item hide', await app.evaluate(`document.querySelector('#sp-nav-history').hidden && document.querySelector('#sp-sec-history').hidden`));
    // The same for Configuration files when settings.info is reported absent; with the real backend it shows.
    await app.evaluate(`window.__oc_debug.settings.mock(${js({ app: MOCK.app, history: MOCK.history, absent: ['settings.info'] })})`);
    await sleep(300);
    check('without settings.info Configuration files hides', await app.evaluate(`document.querySelector('#sp-nav-files').hidden`));
    await app.evaluate(`window.__oc_debug.settings.mock(null)`);
    await sleep(300);
    check('with the real backend Configuration files shows', await app.evaluate(`!document.querySelector('#sp-nav-files').hidden`));
    await app.evaluate(`window.__oc_debug.settings.mock(${js({ app: MOCK.app, history: MOCK.history })})`);

    // History through the mock: restore one
    await open(app, 'history');
    await app.evaluate(`[...document.querySelectorAll('#sp-row-trash-t2 button')].find((b) => /Restore/.test(b.innerText)).click()`);
    await sleep(300);
    check('Restore takes it out of the trash', !(await app.exists('#sp-row-trash-t2')) && (await app.exists('#sp-row-trash-t1')));

    // MCP panel (debug mock): add, then remove a server
    await app.evaluate(`window.__oc_debug.mcp.mock([])`);
    await open(app, 'mcp');
    await app.fill('#mcp-name', 'files');
    await app.fill('#mcp-spec', 'npx -y @modelcontextprotocol/server-filesystem /tmp');
    await app.click('#mcp-add-btn');
    await app.waitFor(`document.querySelectorAll('#mcp-list .mcp-row').length === 1`, 5000).catch(() => false);
    check('the MCP panel adds a server', (await app.count('#mcp-list .mcp-row')) === 1);
    await app.click('#mcp-list .mcp-remove');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000).catch(() => false);
    if (await app.evaluate(`document.querySelector('#confirm-dialog').open`)) await app.click('#confirm-ok');
    await app.waitFor(`document.querySelectorAll('#mcp-list .mcp-row').length === 0`, 5000).catch(() => false);
    check('… and removes it', (await app.count('#mcp-list .mcp-row')) === 0);
    check('the settings page stays open after the confirmation', await isOpen(app));
    await app.evaluate(`window.__oc_debug.mcp.mock(null)`);

    // Rules panel (debug mock): remove a rule
    await app.evaluate(`window.__oc_debug.rules.mock({ cwd: ${js(project)}, programs: ['git', 'npm'], reasons: [], edits: false, mcp: [] })`);
    await open(app, 'permissions');
    await sleep(200);
    const chips = await app.count('#rules-programs .rule-chip');
    await app.click('#rules-programs .rule-remove');
    await sleep(400);
    check('the rules panel removes a rule', chips === 2 && (await app.count('#rules-programs .rule-chip')) === 1, chips);
    await app.evaluate(`window.__oc_debug.rules.mock(null)`);

    // Mods (real backend). The built-in mods that restyle the app start off, so this follows one mod that is on.
    await open(app, 'mods');
    check('the bundled mods are listed', (await app.count('#sp-sec-mods .sp-mod')) >= 7);
    const modKey = await app.evaluate(`document.querySelector('#sp-sec-mods .sp-mod input.switch:checked').dataset.focusKey.split('|')[0]`);
    const modSwitch = `#sp-sec-mods .sp-mod input.switch[data-focus-key=${JSON.stringify(modKey + '|switch')}]`;
    await app.evaluate(`document.querySelector(${js(modSwitch)}).click()`);
    await sleep(400);
    let mods = await app.evaluate(`window.oc.rpc('mods.list')`);
    check('turning a built-in mod off applies at once', mods.find((m) => m.key === modKey)?.scope === 'bundled' && mods.find((m) => m.key === modKey)?.state === 'off', modKey);
    await app.evaluate(`document.querySelector(${js(modSwitch)}).click()`);
    await sleep(400);
    mods = await app.evaluate(`window.oc.rpc('mods.list')`);
    check('… and back on without asking', mods.find((m) => m.key === modKey)?.state === 'on' && !(await app.evaluate(`document.querySelector('#confirm-dialog').open`)), modKey);
    // A mod written while the page is open shows up (as when the agent writes one)
    const modDir = path.join(app.profile, 'home-config', 'mods', 'word-count');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(modDir, 'panel.html'), '<!doctype html><p>words</p>');
    fs.writeFileSync(
      path.join(modDir, 'mod.json'),
      JSON.stringify({ protocol: 1, id: 'word-count', name: 'Word count', version: '0.1.0', description: 'Counts the words of the last reply.', permissions: ['session:read', 'network'], contributes: { views: [{ id: 'main', title: 'Words', entry: 'panel.html', seat: 'rail' }], settings: [{ key: 'unit', type: 'select', title: 'Count', options: ['words', 'characters'], default: 'words' }] } }),
    );
    const appeared = await app.waitFor(`Boolean(document.querySelector('#sp-row-mod-word-count'))`, 10_000).catch(() => false);
    check('a mod written while the page is open appears (mods:changed)', Boolean(appeared));
    check('… under Yours, marked Off', /Off/.test((await app.text('#sp-row-mod-word-count')) || ''));
    await app.click('#sp-row-mod-word-count input.switch');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000).catch(() => false);
    const sheet = (await app.text('#confirm-dialog')) || '';
    check('turning it on first shows what it asks for, in plain words', /Read the session on screen/.test(sheet) && /Reach the internet/.test(sheet) && /leave this Mac/.test(sheet), sheet.slice(0, 300));
    await sleep(300);
    await app.screenshot(path.join(shots, 'mod-grant.png'));
    await app.click('#confirm-ok');
    await sleep(500);
    mods = await app.evaluate(`window.oc.rpc('mods.list')`);
    check('… and confirming turns it on', mods.find((m) => m.id === 'word-count')?.state === 'on');
    await app.click('#sp-row-mod-word-count .sp-mod-expand');
    await sleep(200);
    check('the row expands to where it lives, what it adds, permissions and settings', await app.evaluate(`(() => { const t = document.querySelector('#sp-row-mod-word-count').innerText; return /Where it lives/.test(t) && /Words: a panel in the right-hand rail/.test(t) && /Permissions/.test(t) && /Count/.test(t) && /Remove/.test(t); })()`));
    await app.evaluate(`(() => { const s = document.querySelector('#sp-row-mod-word-count .sp-mod-settings select'); s.value = 'characters'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(400);
    mods = await app.evaluate(`window.oc.rpc('mods.list')`);
    check("its own setting applies (mods.setSetting)", mods.find((m) => m.id === 'word-count')?.settings.unit === 'characters');
    await app.screenshot(path.join(shots, 'mod-expanded.png'));

    // ---------- Settings → Mods by kind: the tabs ----------
    const st = () => app.evaluate('window.__oc_debug.settings.state()');
    const shown = (sel) => app.evaluate(`(() => { const e = document.querySelector(${js(sel)}); return Boolean(e && e.offsetParent); })()`);
    const tabTo = async (t) => {
      await app.click(`#sp-modtab-${t}`);
      await sleep(150);
    };
    const layoutNow = async () => (await cfg(app)).mods.layout;
    const looks = (t) => app.evaluate(`window.__oc_debug.looks.state(${js(t)})`);
    /** A version used as a person does: its card (it shows in the preview), then Use */
    const useCard = async (t, ref) => {
      await tabTo(t);
      await app.click(`.sp-look-tab[data-subtab="${t}"] .sp-look-card[data-ref="${ref}"]`);
      await sleep(400);
      await app.click(`.sp-look-tab[data-subtab="${t}"] .sp-look-use`);
      await sleep(600);
    };
    const TABS = ['mods', 'backgrounds', 'chat-bar', 'conversation'];
    await open(app, 'mods');
    check('the Mods tab strip is exactly Mods, Background, Chat bar, Conversation (no Theme)', (await app.evaluate(`[...document.querySelectorAll('#sp-sec-mods [role=tablist] [role=tab]')].map((b) => b.textContent).join()`)) === 'Mods,Background,Chat bar,Conversation' && !(await app.exists('#sp-modtab-themes')) && !(await app.exists('.sp-look-tab[data-subtab="themes"]')));
    // The Mods tab's toolbar: New ⌄ (From a template…, Install…) and Reload; one form open at a time
    await tabTo('mods');
    const toolbar = await app.evaluate(`[...document.querySelectorAll('#sp-modpanel .sp-toolbar > button, #sp-modpanel .sp-toolbar > .sp-menu-wrap > button')].map((b) => b.textContent.trim())`);
    check('the Mods toolbar is New and Reload (no Install… button)', JSON.stringify(toolbar) === js(['New', 'Reload']), toolbar);
    const menuInside = [];
    const pickNew = async (label) => {
      await app.click('#sp-modpanel .sp-mods-new');
      await sleep(200);
      const items = await app.evaluate(`[...document.querySelectorAll('#sp-modpanel .sp-toolbar .sp-menu .sp-menu-item')].map((b) => b.textContent)`);
      menuInside.push(await app.evaluate(`(() => { const m = document.querySelector('#sp-modpanel .sp-toolbar .sp-menu').getBoundingClientRect(); const p = document.querySelector('#sp-modpanel').getBoundingClientRect(); return m.left >= p.left - 1 && m.right <= p.right + 1; })()`));
      await app.evaluate(`[...document.querySelectorAll('#sp-modpanel .sp-toolbar .sp-menu .sp-menu-item')].find((b) => b.textContent === ${js(label)}).click()`);
      await sleep(250);
      return items;
    };
    const forms = () => app.evaluate(`({ create: !document.querySelector('#sp-modpanel > .sp-form[aria-label="Create a mod"]')?.hidden, install: !document.querySelector('#sp-modpanel > .sp-form[aria-label="Install a mod"]')?.hidden, focus: document.activeElement?.closest('.sp-form')?.getAttribute('aria-label') ?? null })`);
    const newItems = await pickNew('From a template…');
    check('New ⌄ on the Mods tab offers From a template… and Install…', JSON.stringify(newItems) === js(['From a template…', 'Install…']), newItems);
    let fm = await forms();
    check('From a template… opens the New mod form, its first field focused', fm.create && !fm.install && fm.focus === 'Create a mod', fm);
    await pickNew('Install…');
    fm = await forms();
    check('Install… opens the install form instead (one at a time), its field focused', !fm.create && fm.install && fm.focus === 'Install a mod', fm);
    await pickNew('Install…');
    fm = await forms();
    check('picking Install… again closes it', !fm.create && !fm.install, fm);
    check('the menu opens inside the Mods page, not over the side bar', menuInside.length === 3 && menuInside.every(Boolean), menuInside);
    await tabTo('backgrounds');
    check('a tab is selected by a click', (await st()).tab === 'backgrounds' && (await app.evaluate(`document.querySelector('#sp-modtab-backgrounds').getAttribute('aria-selected')`)) === 'true');
    // Hyperspace has no switch: no card on any tab, its looks are versions on theirs
    const onTabs = {};
    for (const t of TABS) {
      await tabTo(t);
      onTabs[t] = {
        hyperCard: await shown('#sp-row-mod-hyperspace'),
        words: await shown('#sp-row-mod-word-count'),
        hyperVersion: await shown(`.sp-look-tab[data-subtab="${t}"] .sp-look-card[data-ref^="hyperspace/"]`),
        theme: await shown(`.sp-look-tab[data-subtab="${t}"] .sp-look-card[data-ref^="theme-"]`),
      };
      await app.screenshot(path.join(shots, `mods-tab-${t}.png`));
    }
    check('a general mod (Word count) is only on the Mods tab, with its switch', TABS.every((t) => onTabs[t].words === (t === 'mods')), onTabs);
    check('Hyperspace has no card or switch anywhere; its looks are on Background, Chat bar and Conversation', TABS.every((t) => !onTabs[t].hyperCard && onTabs[t].hyperVersion === ['backgrounds', 'chat-bar', 'conversation'].includes(t)), onTabs);
    check('no theme is a version on any tab', TABS.every((t) => !onTabs[t].theme), onTabs);

    // Background: use Hyperspace's, see its settings under it, move Dim
    await tabTo('backgrounds');
    check('Background has the preview, the Dim row and New; no picker', (await shown('.sp-look-tab[data-subtab="backgrounds"] .sp-look-pane .lp-stage')) && (await shown('#sp-row-background-dim')) && (await shown('.sp-look-tab[data-subtab="backgrounds"] .sp-look-new')) && !(await app.exists('#sp-sec-mods select[aria-labelledby="sp-t-background"]')));
    await useCard('backgrounds', 'hyperspace/starfield');
    await app.waitFor(`window.oc.getConfig().then((c) => c.mods.layout.background === 'hyperspace/starfield')`, 5000).catch(() => {});
    check('using the Hyperspace background applies it', (await layoutNow()).background === 'hyperspace/starfield' && (await app.evaluate(`document.documentElement.classList.contains('mod-bg')`)));
    await sleep(300);
    check("… and Hyperspace's own settings show under it", (await shown('#sp-row-pick-backgrounds-modset-hyperspace-glow')) && (await shown('#sp-row-pick-backgrounds-modset-hyperspace-motion')));
    await app.evaluate(`(() => { const r = document.querySelector('#sp-row-background-dim input[type=range]'); r.value = '30'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()`);
    await sleep(400);
    check('the Dim slider on the Background tab applies', Math.abs((await layoutNow()).backgroundDim - 0.3) < 1e-9, (await layoutNow()).backgroundDim);
    // Chat bar and Conversation
    await useCard('chat-bar', 'hyperspace/cockpit');
    await app.waitFor(`document.querySelector('#chatbar').dataset.look === 'hyperspace/cockpit'`, 5000).catch(() => {});
    check('using the Cockpit chat bar look applies it', (await layoutNow()).looks.composer === 'hyperspace/cockpit' && (await app.evaluate(`document.querySelector('#chatbar').dataset.look`)) === 'hyperspace/cockpit');
    await useCard('conversation', 'hyperspace/holo');
    await app.waitFor(`document.querySelector('#messages').dataset.look === 'hyperspace/holo'`, 5000).catch(() => {});
    check('using the Holo conversation look applies it', (await layoutNow()).looks.conversation === 'hyperspace/holo' && (await app.evaluate(`document.querySelector('#messages').dataset.look`)) === 'hyperspace/holo');
    await sleep(300);
    check('with all three in use, the whole set is not offered again', !(await app.exists('.sp-look-tab[data-subtab="conversation"] .sp-look-acts button[aria-label^="Use the set"]')));
    // The whole set, from the Chat bar tab
    await app.evaluate(`window.oc.rpc('mods.use', { background: null, composer: null, conversation: null })`);
    await sleep(400);
    let L = await layoutNow();
    check('Default for all three puts them back', !L.background && !L.looks.conversation && !L.looks.composer, L);
    await tabTo('chat-bar');
    await app.click('.sp-look-tab[data-subtab="chat-bar"] .sp-look-card[data-ref="hyperspace/cockpit"]');
    await sleep(300);
    check('… and Cockpit previewed on the Chat bar tab offers "Use the set"', await shown('.sp-look-tab[data-subtab="chat-bar"] .sp-look-acts button[aria-label^="Use the set"]'));
    await app.click('.sp-look-tab[data-subtab="chat-bar"] .sp-look-acts button[aria-label^="Use the set"]');
    await app.waitFor(`window.__oc_debug.mods.views().some((v) => v.key === 'hyperspace/starfield')`, 10_000).catch(() => {});
    L = await layoutNow();
    check('"Use the set" applies the conversation look, the chat bar look and the background', L.background === 'hyperspace/starfield' && L.looks.conversation === 'hyperspace/holo' && L.looks.composer === 'hyperspace/cockpit', L);
    const inUse = (await Promise.all(['conversation', 'chat-bar', 'backgrounds'].map(looks))).map((x) => x.current).join();
    check('… and the tabs follow', inUse === 'hyperspace/holo,hyperspace/cockpit,hyperspace/starfield', inUse);
    // Keyboard: the arrows move between the tabs
    await tabTo('conversation');
    await app.evaluate(`document.querySelector('#sp-modtab-conversation').focus()`);
    await app.key('ArrowRight');
    await sleep(100);
    check('ArrowRight from the last tab wraps to the first', (await st()).tab === 'mods' && (await app.evaluate('document.activeElement.id')) === 'sp-modtab-mods');
    await app.key('ArrowRight');
    await sleep(100);
    check('ArrowRight moves to the next tab', (await st()).tab === 'backgrounds' && (await app.evaluate('document.activeElement.id')) === 'sp-modtab-backgrounds');
    await app.key('ArrowLeft');
    await app.key('ArrowLeft');
    await sleep(100);
    check('ArrowLeft goes back (and wraps)', (await st()).tab === 'conversation' && (await app.evaluate('document.activeElement.id')) === 'sp-modtab-conversation');
    check('only the selected tab is in the tab order', (await app.evaluate(`[...document.querySelectorAll('#sp-sec-mods [role=tab]')].map((b) => b.tabIndex).join()`)) === '-1,-1,-1,0');
    // Search: a row inside a tab is found, and choosing it opens its tab
    await tabTo('mods');
    s = await searchFor('dim');
    check('search "dim" finds the Dim row on the Background tab', s.rows.includes('background-dim'), s.rows);
    await app.click('#sp-row-background-dim .sp-row-name');
    await sleep(300);
    let now = await st();
    check('choosing the hit clears the search and opens Mods → Background', now.section === 'mods' && now.tab === 'backgrounds' && now.query === '' && (await shown('#sp-row-background-dim')), now);
    await app.screenshot(path.join(shots, 'search-opened-backgrounds.png'));
    s = await searchFor('install');
    check('search "install" finds the look tabs, whose New ⌄ has Install…', ['background', 'look-composer', 'look-conversation'].every((r) => s.rows.includes(r)), s.rows);
    s = await searchFor('chat bar look');
    check('search "chat bar look" finds the Chat bar tab\'s look in use', s.rows.includes('look-composer'), s.rows);
    await app.evaluate(`document.querySelector('#settings-search').focus()`);
    await app.key('Enter');
    await sleep(300);
    now = await st();
    check('Enter goes to the first hit, on its tab', now.tab === 'chat-bar' && now.query === '' && (await app.evaluate(`Boolean(document.activeElement.closest('#sp-row-look-composer'))`)), now);
    // Appearance: Light, Dark and System, and one row per look with the one in use, opening its tab
    await open(app, 'appearance');
    check('Appearance keeps Light, Dark and System, a Looks group, and no pickers', !(await app.exists('#sp-sec-appearance select')) && /Looks/.test(await app.text('#sp-sec-appearance')) && (await app.evaluate(`[...document.querySelectorAll('#sp-row-theme input')].map((i) => i.value).join()`)) === 'system,light,dark');
    const kindText = await app.evaluate(`['background', 'composer', 'conversation'].map((k) => document.querySelector('#sp-row-appearance-' + k + ' .sp-row-desc').textContent).join(' | ')`);
    check('… it shows each look in use in words, and has no Theme row', kindText === 'Hyperspace: Starfield | Hyperspace: Cockpit | Hyperspace: Holo terminal' && !(await app.exists('#sp-row-appearance-themes')), kindText);
    await app.screenshot(path.join(shots, 'appearance.png'));
    await app.click('#sp-row-appearance-conversation button');
    await sleep(200);
    now = await st();
    check('its Conversation row opens Mods → Conversation', now.section === 'mods' && now.tab === 'conversation', now);
    // The sidebar's Customize row, and openSettings with a tab
    await app.evaluate(`document.querySelector('#settings').close()`);
    await app.evaluate(`document.querySelector('#customize-row').click()`);
    await sleep(300);
    now = await st();
    check("the sidebar's Customize row opens Mods at the tab last open", now.open && now.section === 'mods' && now.tab === 'conversation', now);
    await app.evaluate(`window.__oc_debug.settings.open('mods', { tab: 'chat-bar' })`);
    check("openSettings('mods', { tab }) opens that tab", (await st()).tab === 'chat-bar');
    await app.evaluate(`window.__oc_debug.settings.open('mods', { tab: 'themes' })`);
    check("… and a tab that is gone (themes) leaves it where it was, without an error", (await st()).tab === 'chat-bar' && (await st()).section === 'mods');
    await app.evaluate(`window.__oc_debug.settings.open('mods:backgrounds')`);
    check("… and so does 'mods:backgrounds'", (await st()).tab === 'backgrounds');
    await app.evaluate(`window.__oc_debug.settings.open('appearance')`);
    await app.evaluate(`window.__oc_debug.settings.open('sp-row-look-conversation')`);
    await sleep(200);
    check('an element id on a tab opens that tab', (await st()).section === 'mods' && (await st()).tab === 'conversation');
    await app.evaluate(`window.oc.rpc('mods.setLayout', { looks: { conversation: null, composer: null }, background: null, backgroundImage: null, backgroundDim: 0.5 })`);
    await app.evaluate(`window.oc.rpc('mods.setEnabled', 'hyperspace', false)`);
    // The card in the chat for a new background links to the Background tab
    await app.evaluate(`document.querySelector('#settings').close()`);
    const bgDir = path.join(app.profile, 'home-config', 'mods', 'dusk-glow');
    fs.mkdirSync(bgDir, { recursive: true });
    fs.writeFileSync(path.join(bgDir, 'bg.html'), '<!doctype html><body style="background:#223">');
    fs.writeFileSync(path.join(bgDir, 'mod.json'), JSON.stringify({ protocol: 1, id: 'dusk-glow', name: 'Dusk glow', version: '0.1.0', contributes: { views: [{ id: 'main', title: 'Dusk', entry: 'bg.html', seat: 'background' }] } }));
    const card = await app.waitFor(`Boolean(document.querySelector('.mod-offer[data-mod="dusk-glow"] .mod-offer-later'))`, 10_000).catch(() => false);
    if (card) {
      await app.click('.mod-offer[data-mod="dusk-glow"] .mod-offer-later');
      await sleep(200);
      const where = (await app.text('.mod-offer[data-mod="dusk-glow"]')) || '';
      await app.click('.mod-offer[data-mod="dusk-glow"] .mod-offer-where');
      await sleep(400);
      now = await st();
      const bgTab = await looks('backgrounds');
      check('the chat card of a new background links to Settings → Mods → Background, with it previewed', /Settings → Mods → Background/.test(where) && now.open && now.section === 'mods' && now.tab === 'backgrounds' && bgTab.shown === 'dusk-glow/main' && bgTab.previewing, { where, now, bgTab });
      await app.evaluate(`document.querySelector('#settings').close()`);
    } else check('the chat card of a new background appears', false);

    // Theme through the page applies to the window
    await open(app, 'appearance');
    await app.evaluate(`[...document.querySelectorAll('#sp-row-theme input')].find((i) => i.value === 'dark').click()`);
    await sleep(300);
    check('Theme applies to the window at once', (await app.evaluate(`document.documentElement.dataset.theme`)) === 'dark' && (await cfg(app)).theme === 'dark');

    const errs = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errs.length === 0, errs.slice(0, 3));
    await app.close();
    app = null;

    // ---------- Relaunch on the same profile: the changes persisted ----------
    app = await launch({ mock: true, profile, project });
    c = await cfg(app);
    check('after a relaunch: notifications, keep awake, max turns, compact at, context window, theme persisted', c.notifications === !before.notifications && c.keepAwake === 'always' && c.maxTurns === 30 && c.compactThreshold === 0.65 && c.portkey.contextWindow === 150000 && c.theme === 'dark', [c.notifications, c.keepAwake, c.maxTurns, c.compactThreshold, c.portkey.contextWindow, c.theme]);
    await app.click('#settings-btn');
    check('the page reopens at the section last open', (await app.evaluate('window.__oc_debug.settings.state().section')) === 'appearance');
    await app.close();
    app = null;
    console.log(`screenshots: ${shots}`);
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
