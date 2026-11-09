// The rows of the agent's own tools (src/renderer/tool-labels.ts): sub-sessions, schedules, mod_check and
// submit_plan read like the file and shell rows ("Sub-session Load-test the limiter", "started"), never a raw tool name
// with JSON; ids become names from what the renderer knows, the approval detail or the result; the approval card and
// its decided line name the action in words. Also checks that every tool the main process registers has a label.
// Run: node test/tool-labels.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

(async () => {
  // tool-labels.js imports types only, so its source loads as a data: module (as test/sidebar.js does)
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/tool-labels.js'), 'utf8');
  const M = await import('data:text/javascript,' + encodeURIComponent(src));
  const { AGENT_TOOLS, agentToolLabel, agentArgFromResult, agentArgFromApproval, agentToolMeta, agentApproval, agentStatusVerb, agentBrief, rhythmFromArgs, setNameLookup, isDeniedResult } = M;
  const { describeWhen } = require(path.join(projectDir, 'dist/main/schedules/when.js'));

  const SUB = 'b1f0c2d4-0000-4000-8000-000000000001';
  const SCHED = 'sch_42';
  setNameLookup({ session: (id) => (id === SUB ? 'Load-test the limiter' : undefined), schedule: (id) => (id === SCHED ? 'Nightly audit' : undefined) });
  const row = (name, args) => {
    const l = agentToolLabel(name, args);
    return l ? `${l.verb} ${l.arg}`.trim() : null;
  };

  // ---------- Every registered tool has a row of its own ----------
  const registered = new Set();
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name !== 'remote') walk(p);
      } else if (p.endsWith('.ts')) {
        // A tool definition: `name: 'x'`, a description, then its parameters (slash commands and features have none)
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/name: '([a-z_]+)',\s*\n\s*description:(?:(?!\bname: ')[\s\S]){0,2000}?\bparameters:/g)) registered.add(m[1]);
      }
    }
  };
  walk(path.join(projectDir, 'src/main'));
  const toolsTs = fs.readFileSync(path.join(projectDir, 'src/renderer/tools.ts'), 'utf8');
  const unlabelled = [...registered].filter((n) => !AGENT_TOOLS.has(n) && !toolsTs.includes(`case '${n}':`));
  check('the scan finds the registered tools', registered.size >= 35 && registered.has('session_spawn') && registered.has('mod_check') && registered.has('bash'), [...registered].join(' '));
  check('every registered tool has a row of its own (no raw name + JSON)', unlabelled.length === 0, unlabelled);
  for (const n of AGENT_TOOLS) check(`${n}: a status line while it runs`, typeof agentStatusVerb(n) === 'string' && !agentStatusVerb(n).includes('_'), agentStatusVerb(n));

  // ---------- Rows from the arguments ----------
  check('session_spawn', row('session_spawn', { title: 'Load-test the limiter', prompt: 'Load-test the new rate limiter' }) === 'Sub-session Load-test the limiter');
  check('session_send: an id becomes the title', row('session_send', { to: SUB, message: 'hi' }) === 'Message to Load-test the limiter');
  check('session_send: a title stays', row('session_send', { to: 'Fix the tests', message: 'hi' }) === 'Message to Fix the tests');
  check('session_list', row('session_list', {}) === 'Sessions');
  check('session_list with a query', row('session_list', { query: 'deploy fix' }) === 'Sessions deploy fix');
  check('session_rename', row('session_rename', { name: 'Release checklist' }) === 'Rename session Release checklist' && agentToolLabel('session_rename', { name: 'x' }).icon === 'pencil');
  check('session_read: an id becomes the title', row('session_read', { id: SUB }) === 'Read session Load-test the limiter');
  check('session_merge: an id becomes the title', row('session_merge', { id: SUB }) === 'Merge Load-test the limiter');
  check('session_merge: an unknown id stays an id', row('session_merge', { id: 'zzz' }) === 'Merge zzz');
  check('schedule_create: every 120 minutes', row('schedule_create', { name: 'Nightly audit', prompt: 'p', every_minutes: 120 }) === 'Schedule Nightly audit · every 2 hours');
  check('schedule_create: a cron stays as written until the main process words it', row('schedule_create', { name: 'Nightly audit', prompt: 'p', cron: '0 3 * * *' }) === 'Schedule Nightly audit · cron 0 3 * * *');
  check('schedule_list', row('schedule_list', {}) === 'Schedules');
  check('schedule_update: id → name', row('schedule_update', { id: SCHED, every_minutes: 60 }) === 'Update schedule Nightly audit');
  check('schedule_delete: id → name', row('schedule_delete', { id: SCHED }) === 'Delete schedule Nightly audit');
  check('mod_check with an id (mono)', row('mod_check', { id: 'word-count' }) === 'Check mod word-count' && agentToolLabel('mod_check', { id: 'word-count' }).mono === true);
  check('mod_check without an id', row('mod_check', {}) === 'Check mod all mods');
  check('submit_plan', row('submit_plan', { title: 'Rate limits', markdown: 'x' }) === 'Plan Rate limits');
  check('a long title is cut with its full text as the tooltip', (() => { const l = agentToolLabel('session_spawn', { title: 'x'.repeat(120) }); return l.arg.length === 81 && l.title.length === 120; })());
  check('other tools are not labelled here', agentToolLabel('bash', { command: 'ls' }) === null && agentToolLabel('mcp__x__y', {}) === null);

  // The rhythm worded from the arguments agrees with the main process where both word it
  const now = new Date(2026, 10, 6, 10, 0).getTime();
  for (const m of [5, 30, 60, 120, 1440, 2880, 90]) check(`every ${m} minutes words as the main process does`, rhythmFromArgs({ every_minutes: m }, now) === describeWhen({ kind: 'every', minutes: m }, now), rhythmFromArgs({ every_minutes: m }, now));
  const at = '2026-11-07T09:00:00Z';
  check('a one-off "at" words as the main process does', rhythmFromArgs({ at }, now) === describeWhen({ kind: 'at', at }, now), rhythmFromArgs({ at }, now));
  check('in_minutes is a one-off time', /^once on Nov 6 at 10:30$/.test(rhythmFromArgs({ in_minutes: 30 }, now)), rhythmFromArgs({ in_minutes: 30 }, now));

  // ---------- The approval detail and the result name things ----------
  const createDetail = `Create schedule "Nightly audit"\nWhen: ${describeWhen({ kind: 'cron', expr: '0 3 * * *' }, now)} (first run Sat Nov 7 03:00)\nRuns in: a new session each time, in /p\nPrompt:\nRun npm audit`;
  check('schedule_create: the card\'s When line words the cron', agentArgFromApproval('schedule_create', createDetail) === 'Nightly audit · every day at 03:00', agentArgFromApproval('schedule_create', createDetail));
  check('schedule_create: the result words it too', agentArgFromResult('schedule_create', {}, 'Scheduled "Nightly audit" (id sch_1): every day at 03:00; next run Sat Nov 7 03:00, in a new session each time, in /p.') === 'Nightly audit · every day at 03:00');
  check('schedule_update: the card names it', agentArgFromApproval('schedule_update', 'Change schedule "Nightly audit" (sch_1)\nWhen: every 4 hours (was every day at 03:00)\nPrompt:\nx') === 'Nightly audit');
  check('schedule_update: the result names it', agentArgFromResult('schedule_update', { id: 'sch_1' }, 'Updated: sch_1  "Nightly audit"  every 4 hours  next: Fri Nov 6 14:00  last: not run yet') === 'Nightly audit');
  check('schedule_update: a rename keeps the old name in the row', agentArgFromResult('schedule_update', { id: 'sch_1', name: 'New' }, 'Updated: sch_1  "New"  every 4 hours  next: x  last: y') === null);
  check('schedule_delete: the result names it', agentArgFromResult('schedule_delete', { id: 'sch_1' }, 'Deleted schedule "Nightly audit" (sch_1).') === 'Nightly audit');
  check('session_send: the card names the session', agentArgFromApproval('session_send', `Send to session "Fix the tests" (${SUB}):\n\nhello`) === 'to Fix the tests');
  check('session_send: the result names it', agentArgFromResult('session_send', { to: SUB }, `Delivered to "Fix the tests" (${SUB}): it started a run on it. Its reply does not come back by itself: read it later with session_read ${SUB} or session_list, or it may answer with session_send.`) === 'to Fix the tests');
  check('session_read: the result names it', agentArgFromResult('session_read', { id: 'x' }, 'Session x "Fix the tests" (idle): the last 6 messages of 12.\n\nUSER: hi') === 'Fix the tests');
  check('session_merge: the result names it', agentArgFromResult('session_merge', { id: 'x' }, '[Merged from "Fix the tests"]\n\nSUMMARY') === 'Fix the tests');

  // ---------- Summaries on the right ----------
  const meta = (name, r, a = {}) => agentToolMeta(name, a, r)?.text;
  check('session_spawn: started', meta('session_spawn', `Started sub-session "L" (id ${SUB}). It runs in the background…`) === 'started');
  check('session_send: sent', meta('session_send', `Delivered to "L" (${SUB}): it started a run on it. It is your sub-session, so its report comes back here by itself when it finishes the turn.`) === 'sent');
  check('session_send: queued', meta('session_send', `Delivered to "L" (${SUB}): it is busy, so the message waits behind its current step. Its reply does not come back by itself.`) === 'queued');
  check('session_send: held', meta('session_send', `Delivered to "L" (${SUB}): its plan waits for the user, so the message is held until the user decides the plan. Its reply does not come back by itself.`) === 'held');
  check('session_send: refused in a scheduled tree reads as denied', meta('session_send', 'Not sent: Not permitted: this session runs unattended (a scheduled task or a dream started it), so …') === 'denied');
  const list = `This session: a "Parent"\nRelated (2):\n  b  "L"  sub-session  idle  last: ok\n  c  "M"  fork  idle\nOther recent sessions (1):\n  d  "N"  other  idle`;
  check('session_list: 3 sessions', meta('session_list', list) === '3 sessions', meta('session_list', list));
  check('session_list: none', meta('session_list', 'This session: a "P"\nRelated: none.') === 'no other sessions');
  check('session_read: 12 messages', meta('session_read', 'Session x "L" (idle): the last 12 messages of 20.\n\nUSER: x') === '12 messages');
  check('session_read: 1 message', meta('session_read', 'Session x "L" (idle): the last 1 message of 1.') === '1 message');
  check('session_merge: merged', meta('session_merge', '[Merged from "L"]\n\nS') === 'merged');
  check('session_list: a query with no match', meta('session_list', 'This session: a "P"\nNo session matches "zz". Closest names:\n  b  "Q"  ~/x  active just now') === 'no match');
  check('session_list: a query with matches', meta('session_list', 'This session: a "P"\nSessions matching "q" (2), best first:\n  b  "Q"  other  idle  ~/x  active just now\n  c  "Qa"  other  idle  ~/x  active 5 min ago') === '2 sessions');
  check('session_rename: renamed', meta('session_rename', `Renamed this session to "L" (id ${SUB}). Other sessions can find it by that name.`) === 'renamed');
  check('session_rename: a shared name', meta('session_rename', `Renamed this session to "L" (id ${SUB}). 1 other session is also called that (x), so a lookup by this name is ambiguous: use the id, or pick a name of its own.`) === 'renamed, name shared');
  check('session_rename: refused', meta('session_rename', 'Error: A session name cannot be empty.') === 'error');
  check('schedule_create: created', meta('schedule_create', 'Scheduled "N" (id s): every 2 hours; next run x, in y.') === 'created');
  check('schedule_list: 3 schedules', meta('schedule_list', '3 schedules:\na\nb\nc') === '3 schedules');
  check('schedule_list: 1 schedule', meta('schedule_list', '1 schedule:\na') === '1 schedule');
  check('schedule_list: none', meta('schedule_list', 'No schedules.') === 'no schedules');
  check('schedule_update: updated', meta('schedule_update', 'Updated: s  "N"  every 2 hours  next: x  last: y') === 'updated');
  check('schedule_delete: deleted', meta('schedule_delete', 'Deleted schedule "N" (s).') === 'deleted');
  const healthy = '## Demo (demo 1.0.0)\nFolder: /x\nScope: user · key: k · origin: o/\nState: off\nmod.json: valid\nPermissions granted: none\nViews: none\nNext: …';
  const broken = '## demo\nFolder: /x\nState: invalid\nProblems in mod.json (2):\n- a\n- b\nPermissions granted: none\nViews: none\nNext: Fix';
  check('mod_check: no problems', meta('mod_check', healthy) === 'no problems');
  check('mod_check: 2 problems (shown as an error)', meta('mod_check', broken) === '2 problems' && agentToolMeta('mod_check', {}, broken).err === true);
  check('mod_check: problems across mods and page errors add up', meta('mod_check', `${broken}\n\n${healthy}\nErrors its pages reported (latest 1 of 3):\n- x`) === '5 problems');
  check('mod_check: not found', meta('mod_check', 'No mod with the id "x". Mods are folders…') === 'not found');
  check('a denied card reads denied', meta('session_spawn', 'Not started: Not permitted: the user denied this action.') === 'denied' && isDeniedResult('Not scheduled: Not permitted: the user denied this action.'));
  check('a refusal reads error', meta('schedule_create', 'Error: frequency_too_high: every 3 minutes is too often') === 'error' && meta('session_merge', 'Error: "L" is running.') === 'error');
  check('other tools get no summary here', agentToolMeta('bash', {}, 'x') === null);

  // ---------- Bodies ----------
  check('the brief, the message and the prompt show in the body', agentBrief('session_spawn', { prompt: ' Do it ' }) === 'Do it' && agentBrief('session_send', { message: 'hi' }) === 'hi' && agentBrief('schedule_create', { prompt: 'p' }) === 'p' && agentBrief('session_list', {}) === '');

  // ---------- Approval cards ----------
  const spawn = agentApproval('session_spawn', 'Start sub-session "Load-test the limiter"\n\nLoad-test the new rate limiter');
  check('session_spawn card', spawn.title === 'Allow Silo Harness to start the sub-session “Load-test the limiter”?' && spawn.subject === 'start sub-session “Load-test the limiter”', spawn);
  const send = agentApproval('session_send', `Send to session "Fix the tests" (${SUB}):\n\nhello`);
  check('session_send card', send.title === 'Allow Silo Harness to send a message to “Fix the tests”?' && send.subject === 'message “Fix the tests”', send);
  const create = agentApproval('schedule_create', createDetail);
  check('schedule_create card', create.title === 'Allow Silo Harness to schedule “Nightly audit”?' && create.subject === 'schedule “Nightly audit”', create);
  const update = agentApproval('schedule_update', 'Change schedule "Nightly audit" (sch_1)\nWhen: every 4 hours (was every day at 03:00)');
  check('schedule_update card', update.title === 'Allow Silo Harness to change the schedule “Nightly audit”?' && update.subject === 'change schedule “Nightly audit”', update);
  for (const [n, c] of [['session_spawn', spawn], ['session_send', send], ['schedule_create', create], ['schedule_update', update]]) check(`${n}: no tool name in the card`, !/_/.test(c.title + c.subject), c);
  check('other tools keep their own cards', agentApproval('bash', 'ls') === null && agentApproval('mcp__a__b', '{}') === null);

  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
