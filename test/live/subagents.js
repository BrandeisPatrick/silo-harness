// Live check of sub-sessions in the real window, against the API: the agent is asked in plain words to start two
// sub-sessions, wait for both reports, merge both and answer; then /spawn, /sessions and /merge by hand.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/subagents.js [screenshot-dir]
// Without a key it runs against the mock model, which cannot call tools: only the slash commands are checked then.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-subagents-'));
  const readme = ['# Demo', '', 'A small folder for a live check.', '', 'Line five.', 'Line six.', 'Line seven.'];
  fs.writeFileSync(path.join(project, 'README.md'), readme.join('\n') + '\n');
  fs.writeFileSync(path.join(project, 'alpha.txt'), 'alpha\n');
  fs.writeFileSync(path.join(project, 'beta.js'), 'console.log(1);\n');
  const app = await launch({ mode: 'bypass', project });
  const shot = async (name) => {
    await app.evaluate(`document.documentElement.dataset.theme = 'light'`);
    await sleep(150);
    await app.screenshot(path.join(shots, `${name}-light.png`));
    await app.evaluate(`document.documentElement.dataset.theme = 'dark'`);
    await sleep(150);
    await app.screenshot(path.join(shots, `${name}-dark.png`));
    await app.evaluate(`document.documentElement.dataset.theme = ''`);
  };
  const current = () => app.evaluate(`oc.sessions.current().then((m) => m.id)`);
  const related = (id) => app.evaluate(`oc.rpc('sessions.related', ${JSON.stringify(id)})`);
  const list = () => app.evaluate(`oc.sessions.list()`);
  const nothingRuns = `(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`;
  try {
    if (!app.live) console.log('No API key: running against the mock model (only the slash commands are checked).');
    let P = await current();
    if (app.live) {
      await app.send('Start two sub-sessions: one counts the lines in README.md, the other lists the file names in this folder. When both have reported, merge them and tell me both answers.');
      await app.waitFor(`(async () => (await oc.rpc('sessions.related', ${JSON.stringify(P)})).children.length >= 2)()`, 120_000, 'two sub-sessions');
      P = await current();
      let rel = await related(P);
      check('two sub-sessions with parentId set', rel.children.length === 2 && rel.children.every((c) => c.parentId === P && c.origin === 'spawn'), rel.children.map((c) => [c.title, c.parentId]));
      await app.waitFor(`(async () => { const r = await oc.rpc('sessions.related', ${JSON.stringify(P)}); return r.children.length >= 2 && r.children.every((c) => c.mergedInto); })()`, 300_000, 'both sub-sessions merged');
      await app.waitFor(nothingRuns, 180_000, 'every session to finish');
      await sleep(800);
      rel = await related(P);
      check('both finished and merged into the parent', rel.children.every((c) => c.mergedInto === P && !c.status?.running), rel.children.map((c) => [c.title, c.mergedInto]));
      // On screen a report is one line, "Received message from <sub-session>", that opens to what it said: the frame
      // written for the model (its id, which tools to use next) stays out of sight.
      const reports = await app.evaluate(`[...document.querySelectorAll('.msg.user.session-msg.received')].map((e) => ({ label: e.querySelector('.session-msg-line > summary')?.innerText.trim() ?? '', text: e.querySelector('.session-msg-body')?.textContent ?? '' }))`);
      const notes = reports.filter((r) => /^Received message from .+/.test(r.label)).length;
      check('reports on screen are "Received message from …" lines and show no frame, id or tool name', notes >= 2 && !reports.some((r) => /\[Sub-session "|session_read|session_merge|[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.text)), reports.map((r) => [r.label, r.text.slice(0, 80)]));
      const transcript = await app.evaluate(`oc.rpc('sessions.transcript', ${JSON.stringify(P)})`);
      const noteItems = transcript.filter((i) => i.role === 'user' && /^\[Sub-session "/.test(i.text));
      check('the parent got both notes', noteItems.length >= 2 && new Set(noteItems.map((i) => /\(([0-9a-f-]{36})\)/.exec(i.text)?.[1])).size >= 2, { onScreen: notes, stored: noteItems.length });
      const merges = transcript.filter((i) => i.role === 'tool' && i.name === 'session_merge' && i.ok);
      check('the parent merged both itself', merges.length >= 2, merges.length);
      const answer = await app.lastReply();
      check('the final answer has the line count (7)', /\b7\b/.test(answer) || /seven/i.test(answer), answer.slice(0, 600));
      check('the final answer has the file names', /alpha\.txt/.test(answer) && /beta\.js/.test(answer) && /README\.md/.test(answer), answer.slice(0, 600));
      await shot('1-parent-after-merge');
      console.log('final answer:', answer.slice(0, 800));
    }

    // ---- by hand: /spawn, /sessions, /merge ----
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('#empty-state') && !document.querySelector('#empty-state').hidden`, 10_000, 'a new session');
    await app.send('Reply with exactly: READY');
    await app.waitIdle();
    const S = await current();
    await app.send('/spawn Reply with exactly the word PONG and nothing else');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /Started sub-session/.test(e.innerText))`, 20_000, 'the /spawn notice');
    let relS = await related(S);
    check('/spawn started a sub-session of the session on screen', relS.children.length === 1 && relS.children[0].title === 'Reply with exactly the word PONG', relS.children.map((c) => c.title));
    await app.waitFor(`(async () => { const r = await oc.rpc('sessions.related', ${JSON.stringify(S)}); return r.children.length === 1 && !r.children[0].status?.running; })()`, 120_000, 'the sub-session to finish');
    await app.waitFor(nothingRuns, 120_000, 'the parent to take the note');
    await sleep(500);
    await app.send('/sessions');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /1 related session/.test(e.innerText))`, 10_000, 'the /sessions notice');
    check('/sessions lists it', await app.evaluate(`[...document.querySelectorAll('.msg.system')].some((e) => /sub-session\\s+idle/.test(e.innerText))`));
    await app.send('/merge');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /Merged "|could not|Nothing to merge/.test(e.innerText))`, 120_000, 'the /merge notice');
    relS = await related(S);
    check('/merge merged it', relS.children[0].mergedInto === S, await app.evaluate(`[...document.querySelectorAll('.msg.system')].map((e) => e.innerText).slice(-2)`));
    check('the merge summary shows in the transcript, labelled, without its frame', await app.evaluate(`[...document.querySelectorAll('.msg.user.has-origin')].some((e) => /^merged from /.test(e.querySelector('.msg-origin')?.innerText ?? '') && !/\\[Merged from "/.test(e.innerText))`));
    await shot('2-commands');
    const metas = await list();
    check('the sidebar list carries parentId and mergedInto', metas.some((m) => m.parentId === S && m.mergedInto === S));
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${shots}`);
  } finally {
    await app.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
