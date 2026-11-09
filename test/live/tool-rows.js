// Live check of the tool rows for the agent's own tools in the real window, with the mock model scripted to call
// them in a real session: a real sub-session is spawned, listed, read, messaged and merged; a real schedule is
// created, listed, changed and deleted; two real mod folders are checked; and a second session messages the first.
// Each row must read like the file and shell rows ("Sub-session Load-test the limiter … started"), never a raw tool
// name with JSON; an answered approval card leaves no line of its own, its answer ("Allowed once", "Denied") is in the
// call's row, and the call folds to one line that says what it did ("Started a sub-session").
// Runs twice: in ask mode (cards for sub-sessions, schedules and the message to an unrelated session) and in bypass
// (only schedules ask). Everything it makes lives in the rig's throwaway profile and project.
// Run: npm run build && node test/live/tool-rows.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const { check, done } = checker();

/** Matches a request whose last message is the user's and contains `marker` (the scripted reply answers only that). */
const lastUserHas = (marker) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  if (!m || m.role !== 'user') return false;
  return (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes(marker);
};

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

async function runMode(mode, shots) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-toolrows-'));
  fs.writeFileSync(path.join(project, 'README.md'), '# Demo\n');
  const app = await launch({ mode, mock: true, project, size: { width: 1800, height: 1000 } });
  const asks = mode !== 'bypass';
  let callN = 0;
  const tag = (s) => `[${mode}] ${s}`;
  const nothingRuns = `(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`;
  const current = () => app.evaluate(`oc.sessions.current().then((m) => m.id)`);
  const light = () => app.evaluate(`document.documentElement.dataset.theme = 'light'`);

  /**
   * The newest row of a tool: verb, argument (and its tooltip), summary, whether it finished, and its folded line.
   * session_send is a line of its own ("Messaged …", session-messages.ts): its words, link, delivery note and answer.
   */
  const readRow = (name) =>
    app.evaluate(`(() => {
      if (${JSON.stringify(name)} === 'session_send') {
        const el = [...document.querySelectorAll('#messages .session-msg.sent')].pop();
        if (!el) return null;
        return { summary: el.querySelector(':scope > summary').innerText.trim(), done: el.dataset.state !== 'running', state: el.dataset.state, top: el.parentElement.id === 'messages' && !el.closest('.tool-group'), to: el.querySelector(':scope > summary .session-msg-link')?.dataset.session ?? null, note: (el.querySelector('.session-msg-note')?.textContent ?? '').trim(), decision: (el.querySelector('.tool-decision')?.textContent ?? '').replace(/\\s+/g, ' ').trim(), verb: el.querySelector(':scope > summary').innerText.trim(), arg: '', meta: el.dataset.state };
      }
      const el = [...document.querySelectorAll('.tool[data-tool=${JSON.stringify(name)}]')].pop();
      if (!el) return null;
      const t = (s) => (el.querySelector(s)?.textContent ?? '').replace(/\\s+/g, ' ').trim();
      const g = el.closest('.tool-group');
      return { verb: t('.tool-verb'), arg: t('.tool-arg'), argTitle: el.querySelector('.tool-arg')?.getAttribute('title') ?? '', meta: t('.tool-meta'), done: !el.querySelector('.tool-status.spin'), body: (el.querySelector('.tool-body')?.textContent ?? '').replace(/\\s+/g, ' ').trim(), decision: t('.tool-decision'), line: g ? g.querySelector(':scope > summary .group-verb').textContent : null };
    })()`);

  /**
   * One user turn in which the model calls `name` with `args` once (then says "Done."). With `answer` ('allow' or
   * 'deny') an approval card is expected and answered; its title, body and decided line come back.
   */
  async function step(name, args, { answer, shot } = {}) {
    const marker = `Rows ${mode} ${++callN} ${name.replace(/_/g, ' ')}`;
    app.mock.state.replies.push({ content: '', toolCalls: [{ id: `call_${callN}`, name, args }], when: lastUserHas(marker) });
    await app.send(marker);
    let card = null;
    if (answer) {
      await app.waitFor(`Boolean([...document.querySelectorAll('.approval')].find((c) => !c.classList.contains('done') && c.querySelector('.btn.primary')))`, 30_000, `${name}'s approval card`);
      await sleep(150);
      card = await app.evaluate(`(() => { const c = [...document.querySelectorAll('.approval')].filter((x) => !x.classList.contains('done')).pop(); return { title: c.querySelector('.title').innerText.trim(), body: c.querySelector('.approval-body').innerText.trim() }; })()`);
      card.row = await readRow(name);
      if (shot) {
        await light();
        await app.evaluate(`[...document.querySelectorAll('.approval')].pop().scrollIntoView({ block: 'end' })`);
        await sleep(400);
        await app.screenshot(path.join(shots, `${shot}.png`));
      }
      await app.approve(answer);
      await app.waitFor(`!document.querySelector('.approval')`, 10_000, 'the card to go');
      card.decided = norm((await readRow(name))?.decision);
    }
    const finished =
      name === 'session_send'
        ? `(() => { const el = [...document.querySelectorAll('#messages .session-msg.sent')].pop(); return el && el.dataset.state !== 'running'; })()`
        : `(() => { const el = [...document.querySelectorAll('.tool[data-tool=${JSON.stringify(name)}]')].pop(); return el && !el.querySelector('.tool-status.spin'); })()`;
    await app.waitFor(finished, 60_000, `${name}'s row to finish`);
    await app.waitFor(nothingRuns, 120_000, 'every session to finish');
    await sleep(300);
    return { row: await readRow(name), card };
  }

  const expectRow = (label, r, verb, arg, meta, line) => {
    check(tag(`${label}: row reads "${verb}${arg ? ' ' + arg : ''}"`), r && r.verb === verb && r.arg === arg, r && `${r.verb} | ${r.arg}`);
    if (line) check(tag(`${label}: folds to the line "${line}"`), r && r.line === line, r && r.line);
    check(tag(`${label}: summary "${meta}"`), r && (r.meta === meta || r.meta.startsWith(meta + ' · ')), r && r.meta);
    check(tag(`${label}: no tool name or JSON in the row`), r && !/[_{}]/.test(r.verb + r.arg), r && `${r.verb} ${r.arg}`);
  };
  const results = [];
  const record = (tool, r, card) => results.push({ mode, tool, row: r ? `${r.verb} ${r.arg}`.trim() : null, meta: r?.meta, card: card ? { title: card.title, decided: card.decided } : undefined });

  try {
    // Two user mods to check: one healthy, one with a broken mod.json
    const mods = path.join(app.profile, 'home-config', 'mods');
    fs.mkdirSync(path.join(mods, 'good-mod'), { recursive: true });
    fs.writeFileSync(path.join(mods, 'good-mod', 'mod.json'), JSON.stringify({ protocol: 1, id: 'good-mod', name: 'Good mod', version: '1.0.0', description: 'A mod for a live check.', permissions: [], contributes: {} }, null, 2));
    fs.mkdirSync(path.join(mods, 'bad-mod'), { recursive: true });
    fs.writeFileSync(path.join(mods, 'bad-mod', 'mod.json'), JSON.stringify({ protocol: 1, id: 'Wrong Id', version: 7 }, null, 2));

    // ---- sub-sessions ----
    const TITLE = 'Load-test the limiter';
    let s = await step('session_spawn', { title: TITLE, prompt: 'Load-test the new rate limiter and report the 429 rate.' }, { answer: asks ? 'allow' : undefined, shot: asks ? 'ask-1-spawn-card' : undefined });
    expectRow('session_spawn', s.row, 'Sub-session', TITLE, 'started', 'Started a sub-session');
    check(tag('session_spawn: the brief shows in the body'), /Load-test the new rate limiter/.test(s.row.body), s.row.body.slice(0, 200));
    record('session_spawn', s.row, s.card);
    if (asks) {
      check(tag('session_spawn card: title'), s.card.title === `Allow Silo Harness to start the sub-session “${TITLE}”?`, s.card.title);
      check(tag('session_spawn card: the row already reads Sub-session'), s.card.row.verb === 'Sub-session' && s.card.row.arg === TITLE, s.card.row);
      check(tag('session_spawn card: the answer is in the row'), s.card.decided === 'Allowed once', s.card.decided);
    }
    const A = await current();
    const rel = await app.evaluate(`oc.rpc('sessions.related', ${JSON.stringify(A)})`);
    check(tag('a real sub-session was started'), rel.children.length === 1 && rel.children[0].title === TITLE, rel.children.map((c) => c.title));
    const child = rel.children[0].id;

    s = await step('session_list', {});
    const sessionsMeta = /^(\d+) sessions?\b/.exec(s.row.meta);
    expectRow('session_list', s.row, 'Sessions', '', sessionsMeta ? sessionsMeta[0] : '<n> sessions');
    record('session_list', s.row);

    s = await step('session_read', { id: child });
    const readMeta = /^(\d+) messages?\b/.exec(s.row.meta);
    expectRow('session_read', s.row, 'Read session', TITLE, readMeta ? readMeta[0] : '<n> messages');
    record('session_read', s.row);

    s = await step('session_send', { to: child, message: 'Also check that /health stays unlimited.' });
    // A message is not a tool row: its own line, "Messaged <title>", the title linked to the session
    check(tag('session_send: its own line "Messaged …", linked, never folded'), s.row && s.row.summary === `Messaged ${TITLE}` && s.row.to === child && s.row.top && s.row.state === 'sent', s.row);
    check(tag('session_send: opened, it says how it was delivered'), s.row && /^Delivered: (it started a run on it|it is busy, so the message waits behind its current step)\.$/.test(s.row.note), s.row && s.row.note);
    check(tag('session_send: no card for its own sub-session'), !s.card);
    record('session_send', s.row);

    s = await step('session_merge', { id: child });
    expectRow('session_merge', s.row, 'Merge', TITLE, 'merged');
    record('session_merge', s.row);
    const merged = await app.evaluate(`oc.rpc('sessions.related', ${JSON.stringify(A)})`);
    check(tag('the sub-session really merged'), merged.children[0]?.mergedInto === A);

    // ---- schedules ----
    const NAME = 'Nightly audit';
    const rhythm = asks ? { cron: '0 3 * * *' } : { every_minutes: 120 };
    const words = asks ? 'every day at 03:00' : 'every 2 hours';
    s = await step('schedule_create', { name: NAME, prompt: 'Run npm audit and report anything high.', ...rhythm }, { answer: 'allow', shot: `${mode}-2-schedule-card` });
    expectRow('schedule_create', s.row, 'Schedule', `${NAME} · ${words}`, 'created', 'Created a schedule');
    check(tag('schedule_create card: title'), s.card.title === `Allow Silo Harness to schedule “${NAME}”?`, s.card.title);
    check(tag('schedule_create card: the row has the rhythm in words while it waits'), s.card.row.arg === `${NAME} · ${words}`, s.card.row.arg);
    check(tag('schedule_create card: the answer is in the row'), s.card.decided === 'Allowed once', s.card.decided);
    record('schedule_create', s.row, s.card);
    let list = await app.evaluate(`oc.rpc('schedules.list')`);
    check(tag('a real schedule was created'), list.length === 1 && list[0].name === NAME && list[0].describe === words, list.map((x) => [x.name, x.describe]));
    const sid = list[0].id;

    if (asks) {
      s = await step('schedule_create', { name: 'Hourly ping', prompt: 'Say hi.', every_minutes: 60 }, { answer: 'deny' });
      expectRow('schedule_create (denied)', s.row, 'Schedule', 'Hourly ping · every hour', 'denied', 'Denied a schedule');
      check(tag('schedule_create denied: the row says Denied'), s.card.decided === 'Denied', s.card.decided);
      record('schedule_create (denied)', s.row, s.card);
    }

    s = await step('schedule_list', {});
    expectRow('schedule_list', s.row, 'Schedules', '', '1 schedule');
    record('schedule_list', s.row);

    s = await step('schedule_update', { id: sid, every_minutes: 240 }, { answer: 'allow' });
    expectRow('schedule_update', s.row, 'Update schedule', NAME, 'updated');
    check(tag('schedule_update card: title'), s.card.title === `Allow Silo Harness to change the schedule “${NAME}”?`, s.card.title);
    check(tag('schedule_update card: the answer is in the row'), s.card.decided === 'Allowed once', s.card.decided);
    record('schedule_update', s.row, s.card);

    s = await step('schedule_delete', { id: sid });
    expectRow('schedule_delete', s.row, 'Delete schedule', NAME, 'deleted');
    record('schedule_delete', s.row);
    list = await app.evaluate(`oc.rpc('schedules.list')`);
    check(tag('the schedule is gone'), list.length === 0, list.map((x) => x.name));

    // ---- mods ----
    s = await step('mod_check', { id: 'good-mod' });
    expectRow('mod_check (healthy)', s.row, 'Check mod', 'good-mod', 'no problems');
    record('mod_check', s.row);
    s = await step('mod_check', { id: 'bad-mod' });
    const probs = /^(\d+) problems?\b/.exec(s.row.meta);
    expectRow('mod_check (broken)', s.row, 'Check mod', 'bad-mod', probs && Number(probs[1]) > 0 ? probs[0] : '<n> problems');
    record('mod_check (broken)', s.row);

    await light();
    // Each call is one folded line; open them to show the rows
    await app.evaluate(`document.querySelectorAll('#messages > .tool-group').forEach((g) => (g.open = true))`);
    await app.evaluate(`document.querySelectorAll('#messages .tool').forEach((r) => (r.open = false))`);
    await app.evaluate(`document.querySelector('.tool[data-tool="session_spawn"]').scrollIntoView({ block: 'start' })`);
    await sleep(500);
    await app.screenshot(path.join(shots, `${mode}-3-rows-sessions.png`));
    await app.evaluate(`document.querySelector('.tool[data-tool="schedule_create"]').scrollIntoView({ block: 'start' })`);
    await sleep(500);
    await app.screenshot(path.join(shots, `${mode}-4-rows-schedules.png`));
    await app.evaluate(`document.querySelector('.tool[data-tool="mod_check"]').scrollIntoView({ block: 'start' })`);
    await sleep(500);
    await app.screenshot(path.join(shots, `${mode}-5-rows-mods.png`));
    // One row open: the answer, the brief, then the result
    await app.evaluate(`(() => { const el = document.querySelector('.tool[data-tool="session_spawn"]'); el.open = true; el.scrollIntoView({ block: 'start' }); })()`);
    await sleep(500);
    await app.screenshot(path.join(shots, `${mode}-6-spawn-open.png`));

    // ---- a message to an unrelated session (asks in ask mode) ----
    const aTitle = (await app.evaluate(`oc.sessions.list()`)).find((m) => m.id === A).title;
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('#empty-state') && !document.querySelector('#empty-state').hidden`, 10_000, 'a new session');
    s = await step('session_send', { to: A, message: 'FYI: the limiter is merged.' }, { answer: asks ? 'allow' : undefined, shot: asks ? 'ask-7-send-card' : undefined });
    check(tag('session_send (unrelated): its own line "Messaged …", linked'), s.row && s.row.summary === `Messaged ${aTitle}` && s.row.to === A && s.row.top && s.row.state === 'sent', s.row);
    record('session_send (unrelated)', s.row, s.card);
    if (asks) {
      check(tag('session_send card: title'), s.card.title === `Allow Silo Harness to send a message to “${aTitle}”?`, s.card.title);
      check(tag('session_send card: while it waits the line reads "Messaging …"'), s.card.row && s.card.row.state === 'running' && s.card.row.summary === `Messaging ${aTitle}…`, s.card.row);
      check(tag('session_send card: the answer is in the line'), s.card.decided === 'Allowed once', s.card.decided);
    } else check(tag('session_send to an unrelated session: no card in bypass'), !s.card && (await app.count('.approval')) === 0);

    const decided = await app.evaluate(`({ lines: document.querySelectorAll('.approval').length, answers: [...document.querySelectorAll('.tool-decision')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()), words: [...document.querySelectorAll('#messages > .tool-group > summary .group-verb, #messages > .session-msg > summary')].map((e) => e.textContent) })`);
    check(tag('no answered card is left as a line; the answers in the rows name no tool'), decided.lines === 0 && decided.answers.length === (asks ? 1 : 0) && decided.answers.every((l) => !/_/.test(l)), decided.answers);
    check(tag('no folded line or message line names a tool'), decided.words.length > 0 && decided.words.every((w) => !/_/.test(w)), decided.words);
    await light();
    await sleep(300);
    await app.screenshot(path.join(shots, `${mode}-8-unrelated-send.png`));

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check(tag('no renderer errors'), errors.length === 0, errors.slice(0, 3));
  } finally {
    await app.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
  return results;
}

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const all = [...(await runMode('ask', shots)), ...(await runMode('bypass', shots))];
  console.log('\nrows:');
  for (const r of all) console.log(`  [${r.mode}] ${r.tool}: "${r.row}" · ${r.meta}${r.card ? ` | card: ${r.card.title} | ${r.card.decided}` : ''}`);
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
