// Live check of the Scheduled tasks and Dreaming pages in the real window (mock model). Scheduled: the sidebar row
// opens the page in the main column (row selected, no session selected, the chat view gone), a task made in the New
// task form and one from a template, their cards, search, filter and sort, a task's page with Run now (a run that
// waits for an approval, then ends, and one more), each run opening its session in the chat view (listed with the
// lightning bolt), pause and resume, Edit, Delete behind the breadcrumb menu with the confirmation, ⌘[ and a session
// chosen in the sidebar taking the column back. Settings no longer has the sections; its search opens the pages.
// The Scheduled mod tab's New button opens the form. Dreaming: the banner, the settings, a project card, Run a dream
// for a project, the project's page and its History, the dream's session with its cards (and the moon in the
// sidebar), Suggestions with Apply and Dismiss. Screenshots of each page in light and dark.
// Run: npm run build && node test/live/pages.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-pages-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const { check, done } = checker();
const js = (v) => JSON.stringify(v);
const isDreamReq = (p) => (p.messages || []).some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Dream]'));
const isTaskReq = (name) => (p) => (p.messages || []).some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(`Scheduled task "${name}"`));

/** Evaluates in a mod's frame (its own DevTools target) */
async function frameEval(app, part, expression) {
  const list = await (await fetch(`http://127.0.0.1:${app.port}/json/list`)).json();
  const t = list.find((x) => x.type === 'iframe' && x.url.includes(part));
  if (!t || !t.webSocketDebuggerUrl) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const res = await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) resolve(m.result?.result?.value ?? null);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => resolve(null), 4000);
  });
  ws.close();
  return res;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-pages-profile-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-pages-project-'));
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"shop","version":"1.5.0"}\n');
  const app = await launch({ profile, project, mock: true, mode: 'ask', config: { theme: 'light', dreaming: { daily: false, time: '03:00', mode: 'approve', skills: true, mods: true, memory: true } } });
  const rpc = (m, ...a) => app.evaluate(`oc.rpc(${js(m)}, ...${js(a)})`);
  const pages = () => app.evaluate('window.__oc_debug.pages.state()');
  const pick = async (label) => {
    await app.waitFor(`[...document.querySelectorAll('.popover .pop-item')].some((b) => b.querySelector('.pop-title')?.textContent === ${js(label)})`, 5000, `the menu item ${label}`);
    await app.evaluate(`[...document.querySelectorAll('.popover .pop-item')].find((b) => b.querySelector('.pop-title')?.textContent === ${js(label)}).click()`);
    await sleep(150);
  };
  const theme = (t) => app.evaluate(`document.documentElement.dataset.theme = ${js(t)}`);
  const shoot = async (name) => {
    for (const t of ['light', 'dark']) {
      await theme(t);
      await sleep(250);
      await app.screenshot(path.join(SHOTS, `${name}-${t}.png`));
    }
    await theme('light');
  };
  const cards = () => app.evaluate(`[...document.querySelectorAll('#scheduled-body .task-card')].map((c) => ({ id: c.dataset.task, name: c.querySelector('.pg-card-title').textContent, chip: c.querySelector('.pg-chip').textContent, foot: c.querySelector('.pg-card-foot').innerText.trim() }))`);
  const taskId = async (name) => (await rpc('schedules.list')).find((s) => s.name === name)?.id;
  const openTask = async (name) => {
    await app.click(`.task-card[data-task="${await taskId(name)}"]`);
    await app.waitFor(`document.querySelector('#page-view')?.dataset.page === 'task' && document.querySelector('#page-title')?.textContent === ${js(name)}`, 5000, `the page of ${name}`);
  };
  const toList = async () => {
    await app.click('#scheduled-row');
    await app.waitFor(`document.querySelector('#page-view')?.dataset.page === 'scheduled' && !!document.querySelector('#scheduled-body')`, 5000, 'the Scheduled list');
    await sleep(150);
  };
  try {
    // ---------- The Scheduled page from the sidebar ----------
    await app.waitFor(`!document.querySelector('#scheduled-row').hidden`, 10_000, 'the Scheduled row');
    await app.click('#scheduled-row');
    await app.waitFor(`document.querySelector('.shell').classList.contains('page-open')`, 5000, 'the page');
    const look = await app.evaluate(`(() => ({
      title: document.querySelector('#page-title')?.textContent,
      rowActive: document.querySelector('#scheduled-row').classList.contains('active') && document.querySelector('#scheduled-row').getAttribute('aria-current') === 'page',
      noSessionActive: !document.querySelector('.session-item.active'),
      chatGone: getComputedStyle(document.querySelector('.content')).display === 'none' && getComputedStyle(document.querySelector('.title-block')).display === 'none',
      banner: document.querySelector('#scheduled-banner')?.innerText,
      empty: !!document.querySelector('#scheduled-empty'),
      tabs: [...document.querySelectorAll('.pg-tab')].map((t) => t.textContent + ':' + t.getAttribute('aria-selected')),
      focus: document.activeElement?.id,
      landmark: document.querySelector('#page-view').getAttribute('role') + '|' + document.querySelector('#page-view').getAttribute('aria-labelledby'),
    }))()`);
    check('Scheduled opens in the main column: its title, the row selected, no session selected, the chat view gone', look.title === 'Scheduled tasks' && look.rowActive && look.noSessionActive && look.chatGone, look);
    check('a region labelled by the page heading, which has the focus', look.landmark === 'region|page-title' && look.focus === 'page-title', look);
    check('Yours and Templates; the banner says when tasks run', look.tabs.join() === 'Yours:true,Templates:false' && /only while Silo Harness is open and your Mac is awake/.test(look.banner) && /less than a day/.test(look.banner), look);
    check('no tasks: the empty state with New task', look.empty && (await app.exists('#task-empty-new')));
    await app.screenshot(path.join(SHOTS, 'scheduled-empty-light.png'));

    // ---------- New task, from the form ----------
    await app.click('#task-new');
    await pick('New task');
    await app.waitFor(`!!document.querySelector('#task-dialog[open]')`, 5000, 'the New task dialog');
    check('New task ⌄ → New task opens the form, the name focused', (await app.evaluate(`document.activeElement?.id`)) === 'task-name');
    await app.fill('#task-name', 'Daily test run');
    await app.fill('#task-prompt', 'Run the test suite and report failures.');
    await app.fill('#task-rhythm', 'daily');
    await app.fill('#task-time', '07:15');
    await app.waitFor(`/Every day at 07:15/.test(document.querySelector('#task-preview').textContent)`, 5000, 'the preview');
    check('the form previews the rhythm and its first run', /first run/.test(await app.text('#task-preview')), await app.text('#task-preview'));
    const kinds = await app.evaluate(`[...document.querySelectorAll('#task-rhythm option')].map((o) => o.value)`);
    check('the rhythms the form offers', kinds.join() === 'once,hourly,interval,daily,weekdays,weekly,monthly,cron', kinds);
    await shoot('new-task-form');
    // A bad value is caught in the form
    await app.fill('#task-rhythm', 'interval');
    await app.fill('#task-every', '2');
    await app.click('#task-save');
    await app.waitFor(`!document.querySelector('#task-problem').hidden`, 3000, 'the problem');
    check('every 2 minutes is refused before sending', /at most every 5 minutes/.test(await app.text('#task-problem')) && (await rpc('schedules.list')).length === 0);
    await app.fill('#task-rhythm', 'daily');
    await app.fill('#task-time', '07:15');
    await app.click('#task-save');
    await app.waitFor(`!document.querySelector('#task-dialog')`, 5000, 'the dialog to close');
    let cs = await cards();
    check('created: its card with the chip and the schedule', cs.length === 1 && cs[0].name === 'Daily test run' && cs[0].chip === 'New session' && cs[0].foot === 'Active · Every day at 07:15', cs);
    const made = (await rpc('schedules.list'))[0];
    check('… in the folder chosen (the working directory)', made.cwd === project && made.when.kind === 'cron' && made.when.expr === '15 7 * * *', made);

    // ---------- From a template ----------
    await app.click('#task-new');
    await pick('From a template');
    await app.waitFor(`document.querySelector('.pg-tab[data-tab="templates"]').getAttribute('aria-selected') === 'true'`, 3000, 'the Templates tab');
    const tpls = await app.evaluate(`[...document.querySelectorAll('.template-card')].map((c) => c.dataset.template)`);
    check('Templates: five starter tasks', tpls.length === 5 && tpls.includes('dependency-audit') && tpls.includes('changelog-draft') && tpls.includes('morning-summary') && tpls.includes('test-run'), tpls);
    await shoot('templates');
    await app.click('.template-card[data-template="morning-summary"]');
    await app.waitFor(`!!document.querySelector('#task-dialog[open]')`, 5000, 'the form from the template');
    const pre = await app.evaluate(`({ title: document.querySelector('#task-dialog-title').textContent, name: document.querySelector('#task-name').value, prompt: document.querySelector('#task-prompt').value, kind: document.querySelector('#task-rhythm').value, time: document.querySelector('#task-time')?.value })`);
    check('a template opens the form prefilled', pre.title === 'New task from “Morning summary”' && pre.name === 'Morning summary' && /Summarise what changed/.test(pre.prompt) && pre.kind === 'weekdays' && pre.time === '08:30', pre);
    await app.click('#task-save');
    await app.waitFor(`!document.querySelector('#task-dialog') && document.querySelector('.pg-tab[data-tab="yours"]').getAttribute('aria-selected') === 'true'`, 5000, 'back on Yours');
    cs = await cards();
    check('created from the template: back on Yours, with its card', cs.some((c) => c.name === 'Morning summary' && c.foot === 'Active · Weekdays at 08:30'), cs);
    // Two more, so the list has four
    await rpc('schedules.create', { name: 'Nightly dependency audit', prompt: "Check this project's dependencies for known vulnerabilities and list the smallest safe upgrades. Do not change any files.", when: { kind: 'cron', expr: '0 2 * * *' }, cwd: project });
    const cl = await rpc('schedules.create', { name: 'Weekly changelog draft', prompt: 'Draft a changelog entry for what was merged this week and write it to CHANGELOG-draft.md for review.', when: { kind: 'cron', expr: '0 16 * * 5' }, cwd: project });
    await rpc('schedules.update', cl.id, { enabled: false });
    await app.waitFor(`document.querySelectorAll('#scheduled-body .task-card').length === 4`, 5000, 'four cards');
    cs = await cards();
    check('the list follows changes made elsewhere; a paused task says so', cs.find((c) => c.name === 'Weekly changelog draft')?.foot === 'Paused · Fridays at 16:00', cs);
    check('sorted by next run: the soonest first, a paused one last', cs.map((c) => c.name).join() === 'Nightly dependency audit,Daily test run,Morning summary,Weekly changelog draft' || cs[cs.length - 1].name === 'Weekly changelog draft', cs.map((c) => c.name));
    await shoot('scheduled-list');

    // ---------- Search, filter, sort ----------
    await app.click('#task-search-btn');
    await app.fill('#task-search', 'audit');
    await sleep(150);
    cs = await cards();
    check('search finds by name', cs.length === 1 && cs[0].name === 'Nightly dependency audit', cs);
    await app.fill('#task-search', 'changelog review');
    cs = await cards();
    check('search finds by prompt, every word', cs.length === 1 && cs[0].name === 'Weekly changelog draft', cs);
    await app.evaluate(`document.querySelector('#task-search').focus()`);
    await app.key('Escape');
    await sleep(150);
    check('Esc clears the search', (await cards()).length === 4 && !(await app.exists('#task-search')));
    await app.click('#task-filter');
    await pick('Paused');
    cs = await cards();
    check('filter Paused', cs.length === 1 && cs[0].name === 'Weekly changelog draft' && (await app.evaluate(`document.querySelector('#task-filter').classList.contains('on')`)), cs);
    await app.click('#task-filter');
    await pick('Active');
    check('filter Active', (await cards()).length === 3);
    await app.click('#task-filter');
    await pick('All');
    await app.click('#task-sort');
    await pick('Name');
    check('sort by name', (await cards()).map((c) => c.name).join() === 'Daily test run,Morning summary,Nightly dependency audit,Weekly changelog draft');
    await app.click('#task-sort');
    await pick('Next run');
    check('keyboard: the cards are buttons in a list', await app.evaluate(`[...document.querySelectorAll('#scheduled-body .pg-grid > li > button.task-card')].length === 4 && document.querySelector('#scheduled-body .pg-grid').tagName === 'UL'`));

    // ---------- A task's page ----------
    await openTask('Daily test run');
    let st = await pages();
    let tp = await app.evaluate(`(() => ({ crumbs: document.querySelector('#page-crumbs').innerText.replace(/\\s+/g, ' ').trim(), sub: document.querySelector('#page-sub').textContent, nothing: document.querySelector('#task-no-runs')?.textContent, side: [...document.querySelectorAll('.pg-side .pg-h3')].map((e) => e.textContent), active: document.querySelector('#task-active').checked, chip: document.querySelector('.pg-title-chip')?.textContent, serif: getComputedStyle(document.querySelector('#page-title')).fontFamily }))()`);
    check("a task's page: the breadcrumb, the next run, the chip, Active on, History empty", st.crumbs?.parent === 'Scheduled tasks' && /Scheduled tasks \/ Daily test run/.test(tp.crumbs) && /^Next run: /.test(tp.sub) && tp.chip === 'New session' && tp.active && tp.nothing === 'No runs yet', { st, tp });
    check('… Instructions, Project, Runs, Each run, Permissions beside it; the title in the display serif', tp.side.join() === 'Instructions,Project,Runs,Each run,Permissions' && /serif|New York|Georgia/.test(tp.serif), tp);

    // Run now: the run asks to run a command (Ask mode), so it waits for the user
    app.mock.state.replies.push({ toolCalls: [{ id: 'run1', name: 'bash', args: { command: 'echo tests pass' } }], when: isTaskReq('Daily test run') });
    await app.click('#task-run-now');
    await app.waitFor(`document.querySelector('.run-row')?.dataset.state === 'waiting'`, 20_000, 'the run to wait for the approval');
    let rows = await app.evaluate(`[...document.querySelectorAll('.run-row')].map((r) => ({ state: r.dataset.state, text: r.innerText.replace(/\\s+/g, ' '), session: r.dataset.session }))`);
    check('Run now: a run under History, waiting for you', rows.length === 1 && /Waiting for you/.test(rows[0].text), rows);
    const run1 = rows[0].session;
    const sideRow = await app.evaluate(`window.__oc_debug.sidebar.state().rows.find((r) => r.id === ${js(run1)})`);
    check('the run is a session in the sidebar, with the lightning in front and its state at the end', sideRow && sideRow.lead === 'schedule' && (sideRow.indicator === 'attention' || sideRow.indicator === 'running') && sideRow.title === 'Daily test run', sideRow);
    // Its session opens in the chat view, where the approval card waits
    await app.click(`.run-row[data-session="${run1}"]`);
    await app.waitFor(`!document.querySelector('.shell').classList.contains('page-open')`, 5000, 'the chat view');
    check('a run opens its session in the chat view', (await app.evaluate(`oc.sessions.current().then((m) => m.id)`)) === run1 && !(await pages()).open);
    await app.approve('allow');
    await app.waitIdle(30_000, false);
    check('the session of a run is an ordinary session: the scheduled message, then the reply', /Scheduled task "Daily test run"|scheduled/i.test(JSON.stringify(await app.transcript())));
    await app.screenshotOf(path.join(SHOTS, 'sidebar-run-light.png'), '#sidebar', 0);
    await toList();
    await openTask('Daily test run');
    await app.waitFor(`document.querySelector('.run-row')?.dataset.state === 'done'`, 15_000, 'the run done');
    check('once its run ended, the run says Done', true);
    // One more run
    await app.waitFor(`!document.querySelector('#task-run-now').disabled`, 5000, 'Run now enabled again');
    await app.click('#task-run-now');
    await app.waitFor(`document.querySelectorAll('.run-row').length === 2 && [...document.querySelectorAll('.run-row')].every((r) => r.dataset.state === 'done')`, 20_000, 'two runs done');
    rows = await app.evaluate(`[...document.querySelectorAll('.run-row')].map((r) => r.dataset.session)`);
    check('runs newest first, each in its own session', rows.length === 2 && rows[1] === run1 && rows[0] !== run1, rows);
    await shoot('task-page');

    // ⌘[ goes back to the list; a session chosen in the sidebar takes the column back
    await app.key('[', { meta: true });
    await sleep(200);
    st = await pages();
    check('⌘[ goes back to the list', st.open && st.route.page === 'scheduled', st);
    await app.key('[', { meta: true });
    await sleep(200);
    check('⌘[ on the list closes the page', !(await pages()).open);
    const onScreen = await app.evaluate(`oc.sessions.current().then((m) => m.id)`);
    await toList();
    check('on a page, the session that was on screen is not shown selected', !(await app.evaluate(`document.querySelector('.session-item[data-id="${onScreen}"]').classList.contains('active')`)));
    await app.click(`.session-item[data-id="${onScreen}"]`);
    await sleep(300);
    check('choosing the session that was on screen in the sidebar closes the page', !(await pages()).open && (await app.evaluate(`document.querySelector('.session-item[data-id="${onScreen}"]').classList.contains('active')`)));

    // ---------- Pause, resume, Edit, Delete ----------
    await toList();
    await openTask('Daily test run');
    await app.click('#task-active');
    await app.waitFor(`oc.rpc('schedules.list').then((l) => l.find((s) => s.name === 'Daily test run').enabled === false)`, 5000, 'paused');
    await app.waitFor(`/^Paused/.test(document.querySelector('#page-sub').textContent)`, 5000, 'the line under the title');
    check('the Active switch pauses it', !(await app.evaluate(`document.querySelector('#task-active').checked`)));
    await app.click('#task-active');
    await app.waitFor(`oc.rpc('schedules.list').then((l) => l.find((s) => s.name === 'Daily test run').enabled === true)`, 5000, 'resumed');
    check('… and resumes it', /^Next run/.test(await app.text('#page-sub')));
    await app.click('.crumb-menu');
    await pick('Edit');
    await app.waitFor(`!!document.querySelector('#task-dialog[open]')`, 5000, 'the Edit dialog');
    const ed = await app.evaluate(`({ title: document.querySelector('#task-dialog-title').textContent, name: document.querySelector('#task-name').value, kind: document.querySelector('#task-rhythm').value, time: document.querySelector('#task-time').value, save: document.querySelector('#task-save').textContent })`);
    check('Edit opens the form with the task in it', ed.title === 'Edit “Daily test run”' && ed.name === 'Daily test run' && ed.kind === 'daily' && ed.time === '07:15' && ed.save === 'Save', ed);
    await app.fill('#task-rhythm', 'weekdays');
    await app.fill('#task-time', '06:45');
    await app.click('#task-save');
    await app.waitFor(`document.querySelector('#task-rhythm-words')?.textContent === 'Weekdays at 06:45'`, 5000, 'the new rhythm on the page');
    check('Edit saves the new rhythm', (await rpc('schedules.list')).find((s) => s.name === 'Daily test run').when.expr === '45 6 * * 1-5');
    await app.click('.crumb-menu');
    await pick('Delete');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000, 'the confirmation');
    check('Delete asks first, with the app’s confirmation', (await app.text('#confirm-title')) === 'Delete “Daily test run”?');
    await app.click('#confirm-cancel');
    await sleep(200);
    check('Cancel keeps it', Boolean(await taskId('Daily test run')));
    await app.click('.crumb-menu');
    await pick('Delete');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000, 'the confirmation');
    await app.click('#confirm-ok');
    await app.waitFor(`document.querySelector('#page-view')?.dataset.page === 'scheduled'`, 5000, 'back on the list');
    check('deleted: gone from the list, its run sessions stay', !(await taskId('Daily test run')) && !(await cards()).some((c) => c.name === 'Daily test run') && (await app.evaluate(`oc.sessions.list().then((l) => l.some((m) => m.id === ${js(run1)}))`)));

    // ---------- Settings: no sections for them; search opens the pages ----------
    await app.click('#settings-btn');
    await sleep(200);
    const nav = await app.evaluate(`[...document.querySelectorAll('#settings-nav .sp-nav-item')].map((b) => b.dataset.section)`);
    check('Settings has no Scheduled or Dreaming section', !nav.includes('scheduled') && !nav.includes('dreaming') && !nav.includes('pages') && nav.includes('general'), nav);
    await app.fill('#settings-search', 'scheduled');
    await sleep(200);
    const hits = await app.evaluate(`[...document.querySelectorAll('.sp-row.hit')].filter((r) => r.offsetParent).map((r) => r.dataset.row)`);
    check('searching Settings for "scheduled" finds the page', hits.includes('page-scheduled'), hits);
    await app.screenshot(path.join(SHOTS, 'settings-search-scheduled-light.png'));
    await app.evaluate(`document.querySelector('#settings-search').focus()`);
    await app.key('Enter');
    await sleep(300);
    st = await pages();
    check('Enter opens the Scheduled tasks page, Settings closes', st.open && st.route.page === 'scheduled' && !(await app.evaluate(`document.querySelector('#settings').open`)), st);
    await app.click('#settings-btn');
    await app.fill('#settings-search', 'dream every day');
    await sleep(200);
    await app.click('#sp-row-page-dreaming-daily button');
    await sleep(300);
    st = await pages();
    check('"dream every day" finds the Dreaming page', st.open && st.route.page === 'dreaming', st);

    // ---------- The Scheduled mod tab: New opens the app's form ----------
    await app.click(`.session-item[data-id="${onScreen}"]`);
    await sleep(200);
    await app.evaluate(`(() => { if (document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#browser-toggle').click(); })()`);
    const tab = await app.waitFor(`Boolean(document.querySelector('.mod-pane-tab[data-view="scheduled/main"]'))`, 15_000, 'the Scheduled tab').catch(() => false);
    if (tab) {
      await app.click('.mod-pane-tab[data-view="scheduled/main"]');
      await sleep(1500);
      const clicked = await frameEval(app, 'scheduled', `(() => { const b = document.getElementById('new'); if (!b || b.hidden) return 'no button'; b.click(); return 'ok'; })()`);
      await app.waitFor(`!!document.querySelector('#task-dialog[open]')`, 5000, 'the form').catch(() => {});
      st = await pages();
      check("the mod tab's New scheduled task opens the New task form on the page", clicked === 'ok' && st.open && st.route.page === 'scheduled' && (await app.exists('#task-dialog[open]')), { clicked, st });
      await app.key('Escape');
      await app.click(`.session-item[data-id="${onScreen}"]`);
      await sleep(200);
      await app.click('.mod-pane-tab[data-view="scheduled/main"]');
      await sleep(500);
      const toPage = await frameEval(app, 'scheduled', `(() => { const b = document.getElementById('page'); if (!b) return 'no button'; b.click(); return 'ok'; })()`);
      await sleep(400);
      check('… and Open page opens the Scheduled tasks page', toPage === 'ok' && (await pages()).route?.page === 'scheduled', toPage);
      await app.click(`.session-item[data-id="${onScreen}"]`);
      await sleep(200);
      await app.click('.mod-pane-tab[data-view="scheduled/main"]');
      await sleep(500);
      const old = await frameEval(app, 'scheduled', `harness.ui.openSettings('dreaming').then(() => 'ok', (e) => e.message)`);
      await sleep(400);
      check('a mod asking for Settings → Dreaming (an old section) gets the Dreaming page', old === 'ok' && (await pages()).route?.page === 'dreaming' && !(await app.evaluate(`document.querySelector('#settings').open`)), old);
      await app.click(`.session-item[data-id="${onScreen}"]`);
      await app.click('#pane-tab-browser');
    } else check('the Scheduled mod tab is there', false);

    // ---------- Dreaming ----------
    await app.click('#new-session-btn');
    await app.send('Do the release chore: bump the version, add a CHANGELOG entry, run the tests with pnpm, then tag it.');
    await app.waitIdle();
    await app.send('Please use pnpm, never npm, in this repo.');
    await app.waitIdle();
    const sid = await app.evaluate(`oc.sessions.current().then((m) => m.id)`);
    await app.click('#dreaming-row');
    await app.waitFor(`document.querySelector('#page-view')?.dataset.page === 'dreaming' && !!document.querySelector('.project-card')`, 10_000, 'the Dreaming page with a project card');
    const dl = await app.evaluate(`(() => ({ title: document.querySelector('#page-title').textContent, row: document.querySelector('#dreaming-row').classList.contains('active'), banner: document.querySelector('#dreaming-banner').innerText, tabs: [...document.querySelectorAll('.pg-tab')].map((t) => t.dataset.tab), cards: [...document.querySelectorAll('.project-card')].map((c) => ({ cwd: c.dataset.project, chip: c.querySelector('.pg-chip').textContent, foot: c.querySelector('.pg-card-foot').innerText.trim(), text: c.querySelector('.pg-card-text').textContent })) }))()`);
    check('Dreaming: the page, its row selected, Projects and Suggestions', dl.title === 'Dreaming' && dl.row && dl.tabs.join() === 'projects,suggestions', dl);
    check('the banner: off until turned on, and what a dream sends', /daily dream is off/.test(dl.banner) && /sends parts of your past sessions to the model you configured/.test(dl.banner), dl.banner);
    check('a card for the project the next dream reads: its mode, sessions to read', dl.cards.length === 1 && dl.cards[0].cwd === project && dl.cards[0].chip === 'Approve' && /^Off · \d+ sessions? to read$/.test(dl.cards[0].foot) && /^No dream yet/.test(dl.cards[0].text), dl.cards);
    await app.click('#dream-banner-on');
    await app.waitFor(`oc.getConfig().then((c) => c.dreaming.daily === true)`, 5000, 'daily on');
    await app.waitFor(`/runs at 03:00/.test(document.querySelector('#dreaming-banner').innerText)`, 5000, 'the banner');
    check('Turn on: the daily dream is on and the banner says when', /Daily at 03:00/.test(await app.text('.project-card .pg-card-foot')));
    await app.click('#dream-settings-btn');
    await app.waitFor(`!!document.querySelector('#dream-settings[open]')`, 3000, 'the settings dialog');
    const sd = await app.evaluate(`(() => ({ daily: document.querySelector('#dream-dlg-daily').checked, time: document.querySelector('#dream-dlg-time').value, mode: document.querySelector('#dream-dlg-mode-approve').checked, kinds: ['skills', 'mods', 'memory'].map((k) => document.querySelector('#dream-dlg-' + k).checked) }))()`);
    check('Dreaming settings: daily, time, mode, kinds', sd.daily && sd.time === '03:00' && sd.mode && sd.kinds.every(Boolean), sd);
    await app.click('#dream-dlg-daily');
    await app.waitFor(`oc.getConfig().then((c) => c.dreaming.daily === false)`, 5000, 'daily off');
    await app.key('Escape');
    // Run a dream for the project
    const memArgs = { scope: 'project', add: ['Use pnpm, never npm, in this repo.'], why: 'The user said "Please use pnpm, never npm, in this repo."', sessions: [sid] };
    const skillArgs = { name: 'release-chore', description: 'Bump the version, add a CHANGELOG entry, run the tests with pnpm, then tag', body: '1. Bump the version.\n2. Add a CHANGELOG entry.\n3. Run `pnpm test`.\n4. Tag it.', scope: 'project', why: 'Asked for the release chore step by step', sessions: [sid] };
    app.mock.state.replies.push({ toolCalls: [{ id: 'd1', name: 'propose_skill', args: skillArgs }, { id: 'd2', name: 'propose_memory', args: memArgs }], when: isDreamReq });
    app.mock.state.replies.push({ content: 'I propose a release skill and one memory line about pnpm.', when: isDreamReq });
    await app.click('#dream-run');
    const projectItem = path.basename(project);
    await pick(projectItem);
    await app.waitFor(`oc.rpc('dreaming.get').then((s) => !s.running && s.dreams[0] && s.dreams[0].status === 'done')`, 30_000, 'the dream to end');
    await app.waitFor(`/2 suggestions waiting/.test(document.querySelector('.project-card .pg-card-foot')?.innerText || '')`, 10_000, 'the card to say so');
    const card = await app.evaluate(`({ text: document.querySelector('.project-card .pg-card-text').textContent, count: document.querySelector('.pg-tab[data-tab="suggestions"] .pg-tab-count')?.textContent })`);
    check('after the dream: the card shows its report and what waits; Suggestions has the count', card.text === 'I propose a release skill and one memory line about pnpm.' && card.count === '2', card);
    check('the sidebar row has its dot', !(await app.evaluate(`document.querySelector('#dreaming-dot').hidden`)));
    await shoot('dreaming-list');
    // The project's page
    await app.click('.project-card');
    await app.waitFor(`document.querySelector('#page-view')?.dataset.page === 'project'`, 5000, "the project's page");
    const pp = await app.evaluate(`(() => ({ crumbs: document.querySelector('#page-crumbs').innerText.replace(/\\s+/g, ' ').trim(), title: document.querySelector('#page-title').textContent, rows: [...document.querySelectorAll('.dream-row')].map((r) => r.innerText.replace(/\\s+/g, ' ')), side: [...document.querySelectorAll('.pg-side .pg-h3')].map((e) => e.textContent), run: !!document.querySelector('#project-run') }))()`);
    check("a project's page: the breadcrumb, its dreams under History, Run a dream now", pp.crumbs.startsWith('Dreaming /') && pp.title === projectItem && pp.rows.length === 1 && /Waiting for you · 2/.test(pp.rows[0]) && pp.run, pp);
    check('… and the settings beside it: daily, mode, kinds, project, privacy', pp.side.join() === 'Daily dream,Mode,Looks for,Project,Privacy', pp.side);
    await app.click('#project-mode-plan');
    await app.waitFor(`oc.getConfig().then((c) => c.dreaming.mode === 'plan')`, 5000, 'plan mode');
    check('the mode changes from the page', /one plan/.test(await app.text('#project-mode-note')));
    await app.click('#project-mode-approve');
    await app.waitFor(`oc.getConfig().then((c) => c.dreaming.mode === 'approve')`, 5000, 'approve mode');
    await shoot('project-page');
    // The dream's session with its cards
    const dreamSession = await app.evaluate(`document.querySelector('.dream-row').dataset.session`);
    await app.click('.dream-row');
    await app.waitFor(`document.querySelectorAll('#messages .proposal-card').length === 2`, 10_000, "the dream's cards");
    check("a dream opens its session in the chat view, with its proposal cards", (await app.evaluate(`oc.sessions.current().then((m) => m.id)`)) === dreamSession && !(await pages()).open);
    const dr = await app.evaluate(`window.__oc_debug.sidebar.state().rows.find((r) => r.id === ${js(dreamSession)})`);
    check('the dream session in the sidebar: the moon in front, the dot at the end', dr && dr.lead === 'dream' && dr.indicator === 'attention', dr);
    // Suggestions: Apply and Dismiss
    await app.click('#dreaming-row');
    await app.waitFor(`!!document.querySelector('.pg-tab[data-tab="suggestions"]')`, 5000, 'the tabs');
    await app.click('.pg-tab[data-tab="suggestions"]');
    await app.waitFor(`document.querySelectorAll('#dream-suggestions .proposal-card').length === 2`, 5000, 'the suggestions');
    check('Suggestions: the waiting proposals as cards, with Apply all', await app.exists('#dream-suggestions .dream-apply-all'));
    await shoot('suggestions');
    await app.click('#dream-suggestions .proposal-card[data-kind="skill"] [data-action="apply"]');
    await app.waitFor(`oc.rpc('dreaming.get').then((s) => s.dreams[0].proposals.find((p) => p.kind === 'skill').state === 'applied')`, 5000, 'applied');
    check('Apply writes the skill', fs.existsSync(path.join(project, '.silo-harness/skills/release-chore/SKILL.md')));
    await app.waitFor(`document.querySelectorAll('#dream-suggestions .proposal-card').length === 1`, 5000, 'one left');
    await app.click('#dream-suggestions .proposal-card[data-kind="memory"] [data-action="dismiss"]');
    await app.waitFor(`/Nothing waits for you/.test(document.querySelector('#dream-suggestions')?.innerText || '')`, 5000, 'nothing left');
    check('Dismiss: nothing written, nothing waits, the dot goes', !fs.existsSync(path.join(project, 'SILOHARNESS.md')) && (await app.evaluate(`document.querySelector('#dreaming-dot').hidden`)));

    const errs = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errs.length === 0, errs.slice(0, 4));
  } catch (err) {
    check('no crash', false, String(err && err.stack ? err.stack : err));
    console.log(app.logs.slice(-30).join('\n'));
  } finally {
    await app.close();
  }
  process.exit(done() ? 1 : 0);
})();
