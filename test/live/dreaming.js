// Live check of Dreaming in the real window. A profile seeded with past sessions in which the user twice asks for the
// same multi-step chore and states a preference; the mock model is scripted to call the proposal tools. A dream in
// each mode: the sidebar row and its dot, the Dreaming page (its banner, settings, Run a dream, the project's page and
// Suggestions), the cards, Apply, Dismiss and Revert against the files on disk, the plan approval, the sidebar rule for
// dream sessions, and that a dream session offers no shell or edit tool. Then one dream with the real API on the same seed (when a key is set): it ends without an error, every
// proposal cites sessions that exist, and nothing is written in Approve mode before Apply.
// Run: npm run build && node test/live/dreaming.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-dreaming-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const { check, done } = checker();
const HOUR = 3_600_000;

/** Past sessions with history logs, as the app writes them: the chore twice, a preference, a failure, another chat. */
function seed(profile, project) {
  const sessions = path.join(profile, 'sessions');
  const history = path.join(profile, 'history');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(history, { recursive: true });
  const now = Date.now();
  const mk = (id, title, at, turns) => {
    const messages = [];
    const records = [];
    let seq = 0;
    const rec = (t, type, data) => records.push({ v: 1, seq: ++seq, t, type, data });
    rec(at, 'session.created', { title, cwd: project, origin: 'user', createdAt: at });
    const checkpoints = [];
    turns.forEach(([user, calls, reply], i) => {
      const t = at + i * 60_000;
      rec(t, 'run.start', { origin: 'user' });
      checkpoints.push({ at: messages.length, createdAt: t, text: user, files: {} });
      const push = (m, dt) => {
        messages.push(m);
        rec(t + dt, 'message.append', { index: messages.length - 1, message: m });
      };
      push({ role: 'user', content: user }, 0);
      calls.forEach(([name, args, result], k) => {
        const id = `${id_(title)}_${i}_${k}`;
        push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 1000 + k * 2);
        push({ role: 'tool', tool_call_id: id, content: result }, 1001 + k * 2);
      });
      push({ role: 'assistant', content: reply }, 5000);
      rec(t + 5001, 'run.end', { reason: 'done', text: reply });
    });
    rec(at + turns.length * 60_000, 'snapshot', { messages: messages.length });
    const last = records[records.length - 1].t;
    fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify({ id, title, createdAt: at, updatedAt: last, titleLocked: true, cwd: project, origin: 'user', messages, turns: checkpoints }));
    fs.writeFileSync(path.join(history, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  const id_ = (t) => t.replace(/\W+/g, '').slice(0, 8).toLowerCase();
  mk('s-release-1', 'Cut the 1.4 release', now - 30 * HOUR, [
    [
      'Do the release chore: bump the version in package.json, add a dated CHANGELOG entry from the merged PRs, run the tests, then tag it.',
      [
        ['read_file', { path: 'package.json' }, '1| {"name":"shop","version":"1.3.0"}'],
        ['bash', { command: 'npm test' }, 'Error: command failed: npm is not used here'],
        ['bash', { command: 'pnpm test' }, '42 passing'],
      ],
      'Bumped to 1.4.0, added the CHANGELOG entry, tests pass with pnpm, tagged v1.4.0.',
    ],
    ['Please use pnpm, never npm, in this repo. I keep telling you.', [], 'Understood: pnpm from now on.'],
  ]);
  mk('s-release-2', 'Release 1.5', now - 6 * HOUR, [
    [
      'Release chore again: version bump, CHANGELOG entry with today’s date, tests with pnpm, then the tag. Same as last time.',
      [
        ['edit_file', { path: 'package.json' }, 'Edited package.json'],
        ['bash', { command: 'git push --tags' }, 'Not permitted: the user denied this action. Do not retry it; explain what you would have done and continue or stop.'],
      ],
      'Released 1.5.0; I did not push the tag since you denied it.',
    ],
  ]);
  mk('s-other', 'Explain the cart total', now - 3 * HOUR, [['Why is the cart total rounded twice?', [['grep', { pattern: 'round' }, 'cart.js:12']], 'It rounds in cart.js and again in the view.']]);
  return ['s-release-1', 's-release-2', 's-other'];
}

const shotOf = async (app, name, theme = 'light') => {
  // The conversation alone on screen: the side pane and the rail closed
  await app.evaluate(`(() => { if (!document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-toggle')?.click(); const r = document.querySelector('#rail-toggle'); if (r && !r.hidden && r.getAttribute('aria-pressed') === 'true') r.click(); })()`);
  await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await sleep(200);
  await app.screenshot(path.join(SHOTS, `${name}.png`));
};

const state = (app) => app.evaluate(`oc.rpc('dreaming.get')`);
const waitDream = (app, ms = 30_000) => app.waitFor(`(async () => { const s = await oc.rpc('dreaming.get'); return !s.running && s.dreams[0] && s.dreams[0].status !== 'running' ? s.dreams[0] : null; })()`, ms, 'the dream to end');
const isDreamReq = (p) => (p.messages || []).some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Dream]'));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-dream-profile-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-dream-project-'));
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"shop","version":"1.5.0"}\n');
  const seeded = seed(profile, project);
  const app = await launch({ profile, project, mock: true, mode: 'ask', scale: 1, config: { theme: 'light', dreaming: { daily: false, time: '03:00', mode: 'approve', skills: true, mods: true, memory: true } } });
  const home = path.join(profile, 'home-config');
  const skillFile = path.join(project, '.silo-harness/skills/release-chore/SKILL.md');
  const memFile = path.join(project, 'SILOHARNESS.md');
  const modDir = path.join(home, 'mods/release-status');
  const replies = app.mock.state.replies;
  const call = (n, name, args) => ({ id: `d${n}`, name, args });
  const dreamReply = (r) => replies.push({ ...r, when: isDreamReq });
  const skillArgs = { name: 'release-chore', description: 'Bump the version, add a dated CHANGELOG entry, run the tests with pnpm, then tag', body: '1. Bump the version in package.json.\n2. Add a CHANGELOG entry dated today, from the merged PRs.\n3. Run `pnpm test`.\n4. Tag the release (ask before pushing tags).', scope: 'project', why: 'Asked twice: "Do the release chore: bump the version…" and "Release chore again: … Same as last time."', sessions: ['s-release-1', 's-release-2'] };
  const memArgs = { scope: 'project', add: ['Use pnpm, never npm, in this repo.'], why: 'The user said "Please use pnpm, never npm, in this repo. I keep telling you."', sessions: ['s-release-1'] };
  const modArgs = {
    id: 'release-status', name: 'Release status', description: 'The version in package.json', scope: 'user', why: 'Each release starts by reading the version', sessions: ['s-release-1', 's-release-2'],
    files: [
      { path: 'mod.json', content: JSON.stringify({ protocol: 1, id: 'release-status', name: 'Release status', version: '0.1.0', contributes: { views: [{ id: 'main', title: 'Release', entry: 'panel.html', seat: 'rail' }] } }, null, 2) },
      { path: 'panel.html', content: '<!doctype html>\n<p>Version: <span id="v"></span></p>\n' },
    ],
  };
  try {
    // ---- the row and the page ----
    const pick = async (label) => {
      await app.waitFor(`[...document.querySelectorAll('.popover .pop-item')].some((b) => b.querySelector('.pop-title')?.textContent === ${JSON.stringify(label)})`, 5000, `the menu item ${label}`);
      await app.evaluate(`[...document.querySelectorAll('.popover .pop-item')].find((b) => b.querySelector('.pop-title')?.textContent === ${JSON.stringify(label)}).click()`);
    };
    const openPage = async () => {
      await app.click('#dreaming-row');
      await app.waitFor(`document.querySelector('#page-view')?.dataset.page === 'dreaming' && !!document.querySelector('#dreaming-body')`, 10_000, 'the Dreaming page');
    };
    const openProject = async () => {
      await openPage();
      await app.waitFor(`!!document.querySelector('.project-card')`, 10_000, 'the project card');
      await app.click('.project-card');
      await app.waitFor(`document.querySelector('#page-view')?.dataset.page === 'project'`, 5000, "the project's page");
    };
    await app.waitFor(`!document.querySelector('#dreaming-row').hidden`, 10_000, 'the Dreaming row');
    check('sidebar: the Dreaming row is under Customize, with the moon', await app.evaluate(`(() => { const r = document.querySelector('#dreaming-row'); return r.previousElementSibling.id === 'customize-row' && !!r.querySelector('.nav-icon svg') && r.innerText.trim() === 'Dreaming'; })()`));
    check('sidebar: no dot while nothing waits', await app.evaluate(`document.querySelector('#dreaming-dot').hidden`));
    await app.screenshotOf(path.join(SHOTS, '1-sidebar-row.png'), '.sidebar-nav', 8);
    await openPage();
    check('page: the row opens the Dreaming page in the main column, not Settings', !(await app.evaluate(`document.querySelector('#settings').open`)) && (await app.evaluate(`document.querySelector('#dreaming-row').classList.contains('active')`)));
    const run = await app.evaluate(`(() => { const b = document.querySelector('#dream-run'); return b && { text: b.innerText.trim(), menu: b.getAttribute('aria-haspopup') }; })()`);
    check('page: a "Run a dream" button with a menu', run && run.text === 'Run a dream' && run.menu === 'menu', run);
    const bannerText = await app.text('#dreaming-banner');
    check('page: the banner says the daily dream is off, and what a dream sends and costs', /daily dream is off/.test(bannerText) && /send parts of past sessions to your model/.test(bannerText) && /use tokens/.test(bannerText), bannerText);
    await app.click('#dream-settings-btn');
    await app.waitFor(`!!document.querySelector('#dream-settings[open]')`, 5000, 'the settings dialog');
    const page = await app.evaluate(`document.querySelector('#dream-settings').innerText`);
    check('settings: daily, mode, what to look for, privacy and cost', /Daily dream/.test(page) && /Auto/.test(page) && /Approve/.test(page) && /Plan/.test(page) && /Skills/.test(page) && /Mods/.test(page) && /Memory/.test(page) && /send parts of past sessions/.test(page) && /use tokens/.test(page), page.slice(0, 600));
    check('settings: the mode line says what Approve does', /Each suggestion waits for you to apply or dismiss\./.test(page));
    check('settings: off by default', !(await app.evaluate(`document.querySelector('#dream-dlg-daily').checked`)));
    await shotOf(app, '2-settings-off');
    await app.evaluate(`document.querySelector('#dream-dlg-daily').click()`);
    await app.waitFor(`oc.getConfig().then((c) => c.dreaming.daily === true)`, 5000, 'daily on');
    await app.waitFor(`/Next: /.test(document.querySelector('#dream-dlg-daily-note')?.innerText || '')`, 5000, 'the next run');
    check('settings: turning daily on saves it and shows the next run', await app.evaluate(`document.querySelector('#dream-dlg-time').value === '03:00'`));
    await shotOf(app, '3-settings-on');
    await app.evaluate(`document.querySelector('#dream-dlg-daily').click()`);
    await app.waitFor(`oc.getConfig().then((c) => c.dreaming.daily === false)`, 5000, 'daily off again');
    await app.key('Escape');

    // ---- Approve mode ----
    dreamReply({ toolCalls: [call(1, 'propose_skill', skillArgs), call(2, 'propose_memory', memArgs), call(3, 'propose_mod', modArgs)] });
    dreamReply({ toolCalls: [call(4, 'bash', { command: 'touch hacked' })] });
    dreamReply({ content: 'I propose a release skill, one memory line and a small status mod.' });
    const reqsBefore = app.mock.state.requests.length;
    await app.click('#dream-run');
    await pick('Every project with new activity');
    let d = await waitDream(app);
    check('approve: the dream ended with three proposals waiting', d.status === 'done' && d.proposals.length === 3 && d.proposals.every((p) => p.state === 'waiting'), d.proposals.map((p) => [p.kind, p.state, p.error]));
    check('approve: a dream started from the page is by hand', d.trigger === 'manual', d.trigger);
    check('approve: nothing written before Apply', !fs.existsSync(skillFile) && !fs.existsSync(memFile) && !fs.existsSync(modDir) && !fs.existsSync(path.join(project, 'hacked')));
    const dreamReqs = app.mock.state.requests.slice(reqsBefore).filter((r) => r.url === '/v1/chat/completions' && isDreamReq(r.payload));
    const offered = dreamReqs[0]?.payload.tools.map((t) => t.function.name) ?? [];
    check('approve: a dream session offers no shell or edit tool', offered.length > 0 && !offered.some((n) => /^(bash|write_file|edit_file|terminal_|browser_|session_spawn|session_send|schedule_|create_artifact|submit_plan)/.test(n)) && offered.includes('propose_skill') && offered.includes('read_file'), offered);
    const bashResult = (await app.evaluate(`oc.rpc('sessions.transcript', ${JSON.stringify(d.sessionId)})`)).find((i) => i.role === 'tool' && i.name === 'bash');
    check('approve: a shell call in a dream is refused as unknown', bashResult && /^Error: unknown tool "bash"/.test(bashResult.result), bashResult);
    await app.waitFor(`!document.querySelector('#dreaming-dot').hidden`, 5000, 'the dot');
    check('sidebar: a quiet dot while proposals wait', true);
    await app.waitFor(`/3 suggestions waiting/.test(document.querySelector('.project-card .pg-card-foot')?.innerText || '')`, 5000, 'the project card');
    check('page: the project card says what waits', /I propose a release skill/.test(await app.text('.project-card .pg-card-text')));
    await app.click('.project-card');
    await app.waitFor(`/Waiting for you · 3/.test(document.querySelector('.dream-row')?.innerText || '')`, 5000, 'the dream row');
    check("page: the project's History says the dream waits, with the count", true);
    await shotOf(app, '4-project-page');
    await app.click('#dreaming-row');
    await app.waitFor(`!!document.querySelector('.pg-tab[data-tab="suggestions"]')`, 5000, 'the tabs');
    await app.click('.pg-tab[data-tab="suggestions"]');
    await app.waitFor(`document.querySelectorAll('#dream-suggestions .proposal-card').length === 3`, 5000, 'the cards in the page');
    check('page: Suggestions shows the three proposals and Apply all', await app.exists('#dream-suggestions .dream-apply-all'));
    await shotOf(app, '4-suggestions');
    const cardBtn = (kind, action, where = '#dream-suggestions') => `document.querySelector('${where} .proposal-card[data-kind="${kind}"] [data-action="${action}"]').click()`;
    await app.evaluate(cardBtn('skill', 'apply'));
    await app.waitFor(`oc.rpc('dreaming.get').then((s) => s.dreams[0].proposals.find((p) => p.kind === 'skill').state === 'applied')`, 5000, 'skill applied');
    const skillText = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, 'utf8') : '';
    check('apply: the skill file is on disk with its frontmatter', /^---\nname: release-chore\ndescription: Bump the version/.test(skillText) && /pnpm test/.test(skillText), skillText.slice(0, 200));
    await app.waitFor(`!document.querySelector('#dream-suggestions .proposal-card[data-kind="skill"]')`, 5000, 'the applied card to leave Suggestions');
    await app.evaluate(cardBtn('memory', 'dismiss'));
    await app.waitFor(`oc.rpc('dreaming.get').then((s) => s.dreams[0].proposals.find((p) => p.kind === 'memory').state === 'dismissed')`, 5000, 'memory dismissed');
    check('dismiss: the memory line is not written', !fs.existsSync(memFile));
    await app.waitFor(`!!document.querySelector('#dream-suggestions .proposal-card[data-kind="mod"]')`, 5000, 'the mod card');
    await app.evaluate(cardBtn('mod', 'apply'));
    await app.waitFor(`oc.rpc('dreaming.get').then((s) => s.dreams[0].proposals.find((p) => p.kind === 'mod').state === 'applied')`, 5000, 'mod applied');
    check('apply: the mod folder is written', fs.existsSync(path.join(modDir, 'mod.json')) && fs.existsSync(path.join(modDir, 'panel.html')));
    const modState = await app.evaluate(`oc.rpc('mods.list').then((l) => (l.find((m) => m.id === 'release-status') || {}).state)`).catch(() => null);
    check('apply: the new mod stays off', modState !== 'on', modState);
    await app.waitFor(`document.querySelector('#dreaming-dot').hidden`, 5000, 'the dot to go');
    check('sidebar: the dot goes once nothing waits', /No suggestions waiting/.test(await app.text('#dream-suggestions')));

    // ---- the dream's session ----
    await openProject();
    await app.click('.dream-row');
    await app.waitFor(`oc.sessions.current().then((m) => m.id === ${JSON.stringify(d.sessionId)})`, 10_000, 'the dream session on screen');
    await app.waitFor(`document.querySelectorAll('#messages .proposal-card').length === 3`, 10_000, 'the cards in the transcript');
    check("session: the dream's row brings its session on screen with a card per proposal", !(await app.evaluate(`document.querySelector('.shell').classList.contains('page-open')`)));
    await app.evaluate(cardBtn('skill', 'revert', '#messages'));
    await app.waitFor(`document.querySelector('#messages .proposal-card[data-kind="skill"]').dataset.state === 'reverted'`, 5000, 'skill reverted');
    check('revert: from its card in the session, the skill file is gone again', !fs.existsSync(skillFile));
    const t = await app.evaluate(`(() => ({ label: document.querySelector('#messages .msg.user .msg-origin')?.innerText, folded: !!document.querySelector('#messages .msg.user .bubble.folded'), states: [...document.querySelectorAll('#messages .proposal-card')].map((c) => c.dataset.state), links: [...document.querySelectorAll('#messages .proposal-card .proposal-session')].map((a) => a.dataset.session), toolRows: [...document.querySelectorAll('#messages .tool')].map((r) => r.innerText) }))()`);
    check('session: the digest is a labelled, folded message', /dreaming/.test(t.label ?? '') && t.folded, t);
    check('session: the cards show their state and link the sessions they came from', JSON.stringify(t.states) === JSON.stringify(['reverted', 'dismissed', 'applied']) && t.links.includes('s-release-1') && t.links.includes('s-release-2'), t);
    const rows = await app.evaluate(`window.__oc_debug.sidebar.state().rows.filter((r) => r.kind === 'session')`);
    const dreamRow = rows.find((r) => r.id === d.sessionId);
    check('sidebar: the dream session shows while on screen, the moon in front of its title', dreamRow && dreamRow.lead === 'dream' && (await app.evaluate(`!!document.querySelector('.session-item[data-id="${d.sessionId}"] .lead.dream svg')`)), dreamRow);
    await app.evaluate(`document.querySelector('#messages .msg.user').scrollIntoView({ block: 'start' })`);
    await shotOf(app, '5-dream-session-top-light');
    await app.evaluate(`document.querySelector('#messages .msg.user').scrollIntoView({ block: 'start' })`);
    await shotOf(app, '5-dream-session-top-dark', 'dark');
    await app.evaluate(`document.querySelector('#messages').lastElementChild.scrollIntoView({ block: 'end' })`);
    await shotOf(app, '5-dream-session-light');
    await shotOf(app, '6-dream-session-dark', 'dark');
    await app.evaluate(`document.documentElement.dataset.theme = 'light'`);
    // A link opens the session it names
    await app.evaluate(`document.querySelector('#messages .proposal-card .proposal-session[data-session="s-release-2"]').click()`);
    await app.waitFor(`oc.sessions.current().then((m) => m.id === 's-release-2')`, 10_000, 'the linked session');
    check('session: a session link opens that session', true);
    const rows2 = await app.evaluate(`window.__oc_debug.sidebar.state().rows.filter((r) => r.kind === 'session').map((r) => r.id)`);
    check('sidebar: off screen, a dream session with nothing waiting is not listed', !rows2.includes(d.sessionId) && seeded.every((id) => rows2.includes(id)), rows2);

    // ---- Auto mode ----
    await app.evaluate(`oc.rpc('dreaming.set', { mode: 'auto' })`);
    await app.send('Release chore once more, as always [new]');
    await app.waitIdle();
    dreamReply({ toolCalls: [call(5, 'propose_memory', { ...memArgs, sessions: ['s-release-1', 's-release-2'] })] });
    dreamReply({ content: 'Applied: added "Use pnpm, never npm, in this repo." to SILOHARNESS.md.' });
    await app.evaluate(`oc.rpc('dreaming.run')`);
    d = await waitDream(app);
    check('auto: the proposal was applied when it was made', d.mode === 'auto' && d.proposals[0]?.state === 'applied' && fs.existsSync(memFile) && /- Use pnpm, never npm/.test(fs.readFileSync(memFile, 'utf8')), d.proposals);
    const autoRows = await app.evaluate(`window.__oc_debug.sidebar.state().rows.filter((r) => r.kind === 'session').map((r) => r.id)`);
    check('sidebar: a finished auto dream does not crowd the list', !autoRows.includes(d.sessionId));
    await app.evaluate(`oc.rpc('dreaming.revert', ${JSON.stringify(d.proposals[0].id)})`);
    check('auto: revert puts the instructions file back (it did not exist)', !fs.existsSync(memFile));

    // ---- Plan mode ----
    await app.evaluate(`oc.rpc('dreaming.set', { mode: 'plan' })`);
    await app.send('And release again please [new2]');
    await app.waitIdle();
    dreamReply({ toolCalls: [call(6, 'propose_skill', skillArgs), call(7, 'propose_memory', memArgs)] });
    dreamReply({ content: 'Two suggestions, gathered as a plan.' });
    await app.evaluate(`oc.rpc('dreaming.run')`);
    d = await waitDream(app);
    check('plan: nothing applied, both in the plan', d.mode === 'plan' && d.planId && d.proposals.every((p) => p.state === 'planned') && !fs.existsSync(skillFile) && !fs.existsSync(memFile), d.proposals.map((p) => p.state));
    const listedPlan = await app.evaluate(`window.__oc_debug.sidebar.state().rows.find((r) => r.id === ${JSON.stringify(d.sessionId)})`);
    check('sidebar: a dream with a plan waiting is listed, with the dot', listedPlan && listedPlan.indicator === 'attention', listedPlan);
    await app.evaluate(`document.querySelector('.session-item[data-id="${d.sessionId}"]').click()`);
    await app.waitFor(`!!document.querySelector('#messages .plan-card #plan-build')`, 10_000, 'the plan card');
    const pc = await app.evaluate(`(() => { const c = document.querySelector('#messages .plan-card'); return { kicker: c.querySelector('.plan-kicker').innerText, apply: c.querySelector('#plan-build').innerText, keep: !!c.querySelector('#plan-keep'), build2: !!c.querySelector('#plan-build-accept') }; })()`);
    check('plan: the plan card says Dream plan, Apply all and Keep planning', pc.kicker === 'Dream plan' && /Apply all/.test(pc.apply) && pc.keep && !pc.build2, pc);
    await app.evaluate(`document.querySelector('#messages .plan-card').scrollIntoView({ block: 'end' })`);
    await shotOf(app, '7-plan-dream');
    const reqs = app.mock.state.requests.length;
    const modeBefore = await app.evaluate(`oc.getConfig().then((c) => c.permissionMode)`);
    await app.click('#messages .plan-card #plan-build');
    await app.waitFor(`oc.rpc('dreaming.get').then((s) => s.dreams[0].proposals.every((p) => p.state === 'applied'))`, 10_000, 'the plan applied');
    await sleep(600);
    check('plan: approving applies everything, on disk', fs.existsSync(skillFile) && /- Use pnpm, never npm/.test(fs.readFileSync(memFile, 'utf8')));
    check('plan: without a model call or a mode switch', app.mock.state.requests.length === reqs && (await app.evaluate(`oc.getConfig().then((c) => c.permissionMode)`)) === modeBefore);
    check('plan: the card says applied', /Approved · applied/.test(await app.text('#messages .plan-card .plan-foot')));
    for (const p of d.proposals) await app.evaluate(`oc.rpc('dreaming.revert', ${JSON.stringify(p.id)})`);
    check('plan: reverted again', !fs.existsSync(skillFile) && !fs.existsSync(memFile));
    // /dream on a project with nothing new
    await app.evaluate(`oc.rpc('commands.run', 'dream', '')`).then((r) => check('/dream: nothing new says so', /Nothing new to dream about/.test(r.notice ?? ''), r));

    // ---- the page with dreams in several states: one waiting, one with nothing to suggest ----
    await app.evaluate(`oc.rpc('dreaming.set', { mode: 'approve' })`);
    await app.click('#new-session-btn');
    await app.send('Release chore, the fifth one [new3]');
    await app.waitIdle();
    dreamReply({ toolCalls: [call(8, 'propose_memory', { ...memArgs, add: ['Tag releases as vX.Y.Z and ask before pushing tags.'], why: 'The user denied "git push --tags" in "Release 1.5"', sessions: ['s-release-2'] })] });
    dreamReply({ content: 'One memory line.' });
    await app.evaluate(`oc.rpc('dreaming.run')`);
    await waitDream(app);
    await app.send('Thanks, that is all [new4]');
    await app.waitIdle();
    dreamReply({ content: 'Nothing worth proposing this time: one short exchange.' });
    await app.evaluate(`oc.rpc('dreaming.run')`);
    d = await waitDream(app);
    check('a dream with nothing to propose ends done, with no proposals', d.status === 'done' && d.proposals.length === 0);
    await openProject();
    await app.waitFor(`document.querySelectorAll('.dream-row').length >= 5`, 10_000, 'the dreams');
    const statuses = await app.evaluate(`[...document.querySelectorAll('.dream-row .pg-row-state')].map((e) => e.innerText)`);
    check("page: the project's dreams newest first, each with its state", statuses[0] === 'Nothing to suggest' && statuses[1] === 'Waiting for you · 1' && statuses.length === 5, statuses);
    await shotOf(app, '8-project-dreams');
    await shotOf(app, '9-project-dreams-dark', 'dark');
    await app.evaluate(`document.documentElement.dataset.theme = 'light'`);
    await app.key('Escape');
  } catch (err) {
    check('no crash', false, String(err && err.stack ? err.stack : err));
    console.log(app.logs.slice(-30).join('\n'));
  } finally {
    await app.close();
  }

  // ---- one dream with the real API, on the same seed ----
  if (!process.env.ANTHROPIC_API_KEY) console.log('No API key: the real-API dream is skipped.');
  else {
    const profile2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-dream-api-profile-'));
    const project2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-dream-api-project-'));
    fs.writeFileSync(path.join(project2, 'package.json'), '{"name":"shop","version":"1.5.0"}\n');
    const ids = seed(profile2, project2);
    const api = await launch({ profile: profile2, project: project2, mode: 'ask', scale: 1, config: { dreaming: { daily: false, time: '03:00', mode: 'approve', skills: true, mods: true, memory: true } } });
    const home2 = path.join(profile2, 'home-config');
    const before = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort().join('|') : '');
    const snap = () => [before(path.join(project2, '.silo-harness')), before(path.join(home2, 'skills')), before(path.join(home2, 'mods')), fs.existsSync(path.join(project2, 'SILOHARNESS.md')), fs.existsSync(path.join(home2, 'SILOHARNESS.md'))].join('#');
    const was = snap();
    try {
      await api.evaluate(`oc.rpc('dreaming.run')`);
      const dr = await waitDream(api, 300_000);
      check('api: the dream ended without an error', dr.status === 'done', { status: dr.status, error: dr.error });
      const known = new Set((await api.evaluate(`oc.sessions.list()`)).map((m) => m.id));
      check('api: every proposal cites sessions that exist', dr.proposals.every((p) => p.sessions.length && p.sessions.every((s) => known.has(s) && ids.includes(s))), dr.proposals.map((p) => [p.kind, p.title, p.sessions]));
      check('api: nothing is written in Approve mode before Apply', snap() === was && dr.proposals.every((p) => p.state === 'waiting' || p.state === 'withdrawn'), dr.proposals.map((p) => p.state));
      const reply = (await api.evaluate(`oc.rpc('sessions.transcript', ${JSON.stringify(dr.sessionId)})`)).filter((i) => i.role === 'assistant').pop();
      console.log(`api dream: ${dr.proposals.length} proposal(s): ${dr.proposals.map((p) => `${p.kind} "${p.title}"`).join('; ') || 'none'}\n  reply: ${(reply?.text ?? '').slice(0, 400)}`);
    } catch (err) {
      check('api: no crash', false, String(err && err.stack ? err.stack : err));
      console.log(api.logs.slice(-30).join('\n'));
    } finally {
      await api.close();
    }
  }
  process.exit(done() ? 1 : 0);
})();
