// The Scheduled tasks and Dreaming pages' pure pieces (src/renderer/pages-model.ts): a task's state and its card,
// the search, filter and sort of the list, the templates, the New task form's rhythm and back again for Edit, the
// runs of a task, and the project cards of Dreaming. The pages themselves are checked live by test/live/pages.js.
// Run: node test/pages.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

(async () => {
  // ES modules in a package without "type": .mjs copies (pages-model imports the settings model at run time)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-pages-'));
  fs.mkdirSync(path.join(dir, 'settings'));
  fs.copyFileSync(path.join(projectDir, 'dist/renderer/settings/model.js'), path.join(dir, 'settings/model.mjs'));
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/pages-model.js'), 'utf8').replace("'./settings/model.js'", "'./settings/model.mjs'");
  fs.writeFileSync(path.join(dir, 'pages-model.mjs'), src);
  const m = await import(pathToFileURL(path.join(dir, 'pages-model.mjs')).href);
  fs.rmSync(dir, { recursive: true, force: true });

  const NOW = new Date(2026, 10, 8, 12, 0).getTime(); // Sun Nov 8, 12:00
  const HOUR = 3_600_000;
  const iso = (ms) => {
    const d = new Date(ms);
    const off = -d.getTimezoneOffset();
    const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
  };
  const task = (id, o = {}) => ({ id, name: id, prompt: `prompt of ${id}`, when: { kind: 'cron', expr: '0 9 * * 1-5' }, target: 'new', cwd: '/w', enabled: true, createdAt: 1, createdBy: 'user', nextRunAt: NOW + HOUR, runs: 0, describe: 'weekdays at 09:00', ...o });

  // --- a task's state and card ---
  check('active, paused, running', m.taskState(task('a'), NOW) === 'active' && m.taskState(task('p', { enabled: false, nextRunAt: null }), NOW) === 'paused' && m.taskState(task('r', { lastStatus: 'running' }), NOW) === 'running');
  const once = task('o', { when: { kind: 'at', at: iso(NOW - HOUR) }, enabled: false, nextRunAt: null, runs: 1, lastRunAt: NOW - HOUR, lastStatus: 'ok', describe: 'once on Nov 8 at 11:00' });
  check('a one-shot that ran is done', m.taskState(once, NOW) === 'done' && m.taskFooter(once, NOW) === 'Done · Once on Nov 8 at 11:00');
  check('a one-shot missed says so', m.taskFooter({ ...once, runs: 0, lastStatus: 'missed' }, NOW) === 'Missed · Once on Nov 8 at 11:00');
  check('a paused one-shot still in the future is paused', m.taskState(task('f', { when: { kind: 'at', at: iso(NOW + 5 * HOUR) }, enabled: false, nextRunAt: null }), NOW) === 'paused');
  check('the footer: state and rhythm', m.taskFooter(task('a'), NOW) === 'Active · Weekdays at 09:00' && m.taskFooter(task('p', { enabled: false, nextRunAt: null }), NOW) === 'Paused · Weekdays at 09:00');
  check('the chip says where a run goes', m.targetWords({ target: 'new' }) === 'New session' && m.targetWords({ target: 'session' }) === 'Same session');
  check('the next run in words', m.nextRunWords(task('a'), NOW) === 'Next run: Today at 13:00' && /^Paused/.test(m.nextRunWords(task('p', { enabled: false, nextRunAt: null }), NOW)) && /^Ran today at 11:00$/.test(m.nextRunWords(once, NOW)), m.nextRunWords(once, NOW));
  check('folder names', m.folderName('/Users/me/code/shop/') === 'shop' && m.folderName('/') === '/');

  // --- search, filter, sort ---
  const list = [
    task('Morning summary', { nextRunAt: NOW + 3 * HOUR, lastRunAt: NOW - 20 * HOUR, prompt: 'Summarise what changed' }),
    task('Audit', { nextRunAt: NOW + HOUR, lastRunAt: NOW - 2 * HOUR, prompt: 'npm audit the deps' }),
    task('Changelog', { enabled: false, nextRunAt: null, prompt: 'Draft the changelog' }),
    task('Tests', { nextRunAt: NOW + 2 * HOUR, prompt: 'Run the suite' }),
    once,
  ];
  const ids = (l) => l.map((s) => s.id).join(',');
  check('sort by next run: soonest first, then the rest by name', ids(m.shownTasks(list, { now: NOW })) === 'Audit,Tests,Morning summary,Changelog,o', ids(m.shownTasks(list, { now: NOW })));
  check('sort by name', ids(m.shownTasks(list, { sort: 'name', now: NOW })) === 'Audit,Changelog,Morning summary,o,Tests');
  check('sort by last run: most recent first, never-run last', ids(m.shownTasks(list, { sort: 'last', now: NOW })) === 'o,Audit,Morning summary,Changelog,Tests', ids(m.shownTasks(list, { sort: 'last', now: NOW })));
  check('filter: active and paused (a finished one-shot is neither)', ids(m.shownTasks(list, { filter: 'active', sort: 'name', now: NOW })) === 'Audit,Morning summary,Tests' && ids(m.shownTasks(list, { filter: 'paused', now: NOW })) === 'Changelog');
  check('search: name and prompt, every word', ids(m.shownTasks(list, { query: 'audit', now: NOW })) === 'Audit' && ids(m.shownTasks(list, { query: 'draft change', now: NOW })) === 'Changelog' && ids(m.shownTasks(list, { query: 'summ', now: NOW })) === 'Morning summary' && m.shownTasks(list, { query: 'zzz', now: NOW }).length === 0);
  check('the list it is given is left in its order', ids(list) === 'Morning summary,Audit,Changelog,Tests,o');

  // --- templates ---
  check('five templates, each a valid rhythm, with a name and a prompt', m.TEMPLATES.length === 5 && m.TEMPLATES.every((t) => t.name && t.prompt.length > 40 && m.rhythmToWhen(m.fullRhythm(t.rhythm), NOW).ok));
  check('the templates the brief asks for', ['Nightly dependency audit', 'Weekly changelog draft', 'Morning summary', 'Daily test run'].every((n) => m.TEMPLATES.some((t) => t.name === n)));

  // --- the form's rhythm ---
  const w = (r) => m.rhythmToWhen(m.fullRhythm(r, NOW), NOW);
  check('daily, weekdays, weekly, monthly, hourly as cron', w({ kind: 'daily', time: '08:40' }).value.expr === '40 8 * * *' && w({ kind: 'weekdays', time: '08:40' }).value.expr === '40 8 * * 1-5' && w({ kind: 'weekly', day: 5, time: '16:00' }).value.expr === '0 16 * * 5' && w({ kind: 'monthly', date: 1, time: '09:30' }).value.expr === '30 9 1 * *' && w({ kind: 'hourly', minute: 15 }).value.expr === '15 * * * *');
  check('an interval in minutes, hours or days', w({ kind: 'interval', every: 30, unit: 'minutes' }).value.minutes === 30 && w({ kind: 'interval', every: 2, unit: 'hours' }).value.minutes === 120 && w({ kind: 'interval', every: 1, unit: 'days' }).value.minutes === 1440);
  check('an interval under five minutes is refused', !w({ kind: 'interval', every: 2, unit: 'minutes' }).ok && /5 minutes/.test(w({ kind: 'interval', every: 2, unit: 'minutes' }).error));
  const at = w({ kind: 'once', at: '2026-11-27T09:00' });
  check('once: an ISO time with the offset of that local time', at.ok && at.value.kind === 'at' && new Date(at.value.at).getHours() === 9 && new Date(at.value.at).getDate() === 27, at);
  check('once: in the past is refused', !w({ kind: 'once', at: '2026-11-07T09:00' }).ok);
  check('a bad time, a day of the month over 28, a cron of four fields are refused', !w({ kind: 'daily', time: '25:00' }).ok && !w({ kind: 'monthly', date: 31, time: '09:00' }).ok && !w({ kind: 'cron', cron: '0 9 * *' }).ok && w({ kind: 'cron', cron: ' 0  9 * * 1-5 ' }).value.expr === '0 9 * * 1-5');
  const round = (r) => JSON.stringify(m.whenToRhythm(w(r).value));
  check('Edit: each kind comes back as the form it was made with', [
    { kind: 'daily', time: '08:40' },
    { kind: 'weekdays', time: '07:05' },
    { kind: 'weekly', day: 0, time: '18:00' },
    { kind: 'monthly', date: 15, time: '09:00' },
    { kind: 'hourly', minute: 45 },
  ].every((r) => { const back = m.whenToRhythm(w(r).value); return Object.keys(r).every((k) => back[k] === r[k]); }), round({ kind: 'weekly', day: 0, time: '18:00' }));
  check('Edit: an interval in its largest unit; once as a local value', JSON.stringify(m.whenToRhythm({ kind: 'every', minutes: 120 })) === JSON.stringify({ kind: 'interval', every: 2, unit: 'hours' }) && m.whenToRhythm({ kind: 'every', minutes: 45 }).unit === 'minutes' && m.whenToRhythm({ kind: 'at', at: at.value.at }).at === '2026-11-27T09:00');
  check('Edit: a cron the form has no kind for stays custom', JSON.stringify(m.whenToRhythm({ kind: 'cron', expr: '*/15 9-17 * * 1-5' })) === JSON.stringify({ kind: 'cron', cron: '*/15 9-17 * * 1-5' }) && m.whenToRhythm({ kind: 'cron', expr: '0 9 * * 7' }).day === 0);

  // --- a task's runs ---
  const hist = [
    { at: NOW - 3 * HOUR, sessionId: 's1', status: 'ok' },
    { at: NOW - 2 * HOUR, sessionId: 's2', status: 'error' },
    { at: NOW - HOUR, sessionId: 's3', status: 'running' },
  ];
  check('runs newest first', m.taskRuns(task('h', { history: hist })).map((r) => r.sessionId).join() === 's3,s2,s1');
  check('a task from before run history shows its last run', JSON.stringify(m.taskRuns(task('old', { lastSessionId: 'sx', lastRunAt: 5, lastStatus: 'ok' }))) === JSON.stringify([{ at: 5, sessionId: 'sx', status: 'ok' }]) && m.taskRuns(task('none')).length === 0 && m.taskRuns(task('sk', { lastSessionId: 'sx', lastRunAt: 5, lastStatus: 'skipped' })).length === 0);
  check('run states: running, waiting for you (its session waits), done, failed, stopped', m.runState(hist[2], true, { running: true }) === 'running' && m.runState(hist[2], true, { running: true, attention: 'approval' }) === 'waiting' && m.runState(hist[0], true) === 'done' && m.runState(hist[1], true) === 'failed' && m.runState({ ...hist[0], status: 'stopped' }, true) === 'stopped');
  check('an older run of a session that runs again is not the one running', m.runState({ ...hist[2] }, false, { running: true }) === 'done');

  // --- Dreaming ---
  const cfg = { daily: true, time: '03:00', mode: 'approve', skills: true, mods: true, memory: true };
  const dream = (id, cwd, startedAt, o = {}) => ({ id, sessionId: `s-${id}`, cwd, trigger: 'manual', mode: 'approve', startedAt, status: 'done', covered: { sessions: 2, turns: 4, left: 0, from: 0, to: 0 }, proposals: [], ...o });
  const prop = (id, state, kind = 'memory') => ({ id, dreamId: 'x', kind, scope: 'project', title: `t ${id}`, why: 'w', sessions: [], state, createdAt: 1, changesExisting: false, target: '/t' });
  const state = {
    config: cfg,
    running: null,
    nextRunAt: NOW + 15 * HOUR,
    waiting: 2,
    dreams: [dream('d2', '/code/shop', NOW - HOUR, { proposals: [prop('p1', 'waiting'), prop('p2', 'waiting'), prop('p3', 'applied')] }), dream('d1', '/code/shop', NOW - 30 * HOUR, { summary: 'Nothing worth proposing.' }), dream('d0', '/code/blog', NOW - 50 * HOUR, { proposals: [prop('p4', 'dismissed', 'skill')] })],
  };
  const projects = [
    { cwd: '/code/api', fresh: 3, lastActivity: NOW - 10 * 60_000, next: true },
    { cwd: '/code/shop', fresh: 0, lastActivity: NOW - 2 * HOUR, next: false },
    { cwd: '/code/old', fresh: 0, lastActivity: NOW - 900 * HOUR, next: false },
  ];
  const cards = m.dreamProjects(state, projects);
  check('a card per project with dreams or read by the next dream (not one with neither)', cards.map((c) => c.cwd).sort().join() === '/code/api,/code/blog,/code/shop', cards.map((c) => c.cwd));
  const shop = cards.find((c) => c.cwd === '/code/shop');
  check('a project card: its dreams newest first and what waits', shop.dreams.map((d) => d.id).join() === 'd2,d1' && shop.waiting === 2 && shop.name === 'shop');
  check('footers: waiting, last dream, sessions to read, off', m.projectFooter(shop, cfg, NOW) === 'Daily at 03:00 · 2 suggestions waiting' && m.projectFooter(cards.find((c) => c.cwd === '/code/blog'), { ...cfg, daily: false }, NOW) === 'Off · last dream nov 6'.replace('nov', 'Nov') && m.projectFooter(cards.find((c) => c.cwd === '/code/api'), cfg, NOW) === 'Daily at 03:00 · 3 sessions to read', [m.projectFooter(shop, cfg, NOW), m.projectFooter(cards.find((c) => c.cwd === '/code/blog'), { ...cfg, daily: false }, NOW)]);
  check('summaries: its report, else what it suggested, else nothing yet', m.dreamSummary(state.dreams[1]) === 'Nothing worth proposing.' && /^Suggested a skill: “t p4”\.$/.test(m.dreamSummary(state.dreams[2])) && /^No dream yet/.test(m.dreamSummary(undefined)) && /failed: boom/.test(m.dreamSummary(dream('df', '/x', 1, { status: 'failed', error: 'boom' }))));
  check('projects: sort by last dream, name, activity', m.shownProjects(cards, {}).map((c) => c.name).join() === 'shop,blog,api' && m.shownProjects(cards, { sort: 'name' }).map((c) => c.name).join() === 'api,blog,shop' && m.shownProjects(cards, { sort: 'activity' }).map((c) => c.name).join() === 'api,shop,blog');
  check('projects: filter waiting and not dreamed yet; search by name', m.shownProjects(cards, { filter: 'waiting' }).map((c) => c.name).join() === 'shop' && m.shownProjects(cards, { filter: 'new' }).map((c) => c.name).join() === 'api' && m.shownProjects(cards, { query: 'blo' }).map((c) => c.name).join() === 'blog');
  check('a running dream: its project card says so', m.projectFooter(m.dreamProjects({ ...state, running: { dreamId: 'z', sessionId: 'sz', cwd: '/code/api', queued: 0 } }, projects).find((c) => c.cwd === '/code/api'), cfg, NOW) === 'Daily at 03:00 · dreaming now');
  check('waiting: a running dream counts nothing yet', m.dreamWaiting(dream('r', '/x', 1, { status: 'running', proposals: [prop('q', 'waiting')] })) === 0 && m.dreamWaiting(state.dreams[0]) === 2);
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
