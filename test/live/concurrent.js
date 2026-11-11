// Live check of concurrent sessions in the real window: a long run in session A, a second session B that runs and
// answers while A is still going, the sidebar showing A running, a switch back to A mid-run, and both transcripts
// complete and without duplicates at the end.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/concurrent.js [screenshot-dir]
// Without a key it runs against the mock model, which cannot call tools: the tool checks are then skipped.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

/** The transcript rows that count: messages, tool rows and cards (notices excluded). */
const ROWS = `[...document.querySelectorAll('#messages > *')].filter((e) => e.id !== 'empty-state' && !e.hidden && !e.matches('.msg.system')).map((e) => ({ cls: e.className.replace(/\\bfade-in\\b/g, '').trim(), text: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300) }))`;

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const app = await launch({ mode: 'bypass' });
  const shot = (name) => app.screenshot(path.join(shots, `concurrent-${name}.png`));
  const rows = () => app.evaluate(ROWS);
  const activeId = () => app.evaluate(`document.querySelector('.session-item.active')?.dataset.id ?? null`);
  try {
    if (!app.live) {
      console.log('No API key: running against the mock model (tool checks skipped).');
      // Both sessions ask the one mock: each reply answers the session whose message it names, A's after a while.
      const asks = (word) => (payload) => JSON.stringify(payload.messages).includes(word);
      app.mock.state.replies.push({ content: 'A DONE', delayMs: 6000, when: asks('Hello from A') }, { content: 'B DONE', when: asks('B DONE') });
    }
    // ---- A: a run that takes a while ----
    await app.send(app.live ? 'Use the bash tool to run exactly this command: sleep 6. When it has finished, reply with exactly: A DONE' : 'Hello from A');
    if (app.live) await app.waitFor(`Boolean(document.querySelector('.tool .tool-status.spin'))`, 30_000, 'the bash row to start');
    else await app.waitFor(`Boolean(document.querySelector('.session-item.running'))`, 10_000, 'A to run');
    const idA = await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id`, 10_000, 'A in the sidebar');
    await shot('1-a-running');

    // ---- B: a new session while A runs, and a reply in it ----
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('#empty-state') && !document.querySelector('#empty-state').hidden`, 10_000, 'the new session');
    const startedB = Date.now();
    check('B opened while A runs (no "stop the run first")', !(await app.evaluate(`[...document.querySelectorAll('.msg.system')].some((e) => /Stop the/.test(e.innerText))`)));
    await app.send('Reply with exactly: B DONE');
    await app.waitFor(`[...document.querySelectorAll('.msg.assistant')].some((e) => /B DONE/.test(e.innerText))`, 60_000, "B's reply");
    await app.waitFor(`document.querySelector('#status-line').hidden`, 20_000, "B's run to end");
    const idB = await activeId();
    check("B got its reply in B", idB && idB !== idA, { idA, idB });
    const aStillRunning = await app.evaluate(`Boolean(document.querySelector('.session-item.running[data-id="${idA}"]'))`);
    check('the sidebar shows A running while B is on screen', aStillRunning, `B took ${Date.now() - startedB} ms`);
    check('B on screen is not marked running', !(await app.evaluate(`document.querySelector('.session-item.active').classList.contains('running')`)));
    check('A shows a spinner in its row', await app.evaluate(`Boolean(document.querySelector('.session-item[data-id="${idA}"] .trail .spinner'))`));
    const rowsB = await rows();
    check('B shows only its own rows', rowsB.length === 2 && /msg user/.test(rowsB[0].cls) && /B DONE/.test(rowsB[1].text) && !rowsB.some((r) => /sleep|A DONE/.test(r.text)), rowsB);
    await shot('2-b-done-a-running');

    // ---- back to A while it still runs ----
    await app.click(`.session-item[data-id="${idA}"]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${JSON.stringify(idA)}`, 10_000, 'A on screen');
    await sleep(300);
    const midRun = await app.evaluate(`Boolean(document.querySelector('.session-item.running[data-id="${idA}"]'))`);
    if (app.live) {
      check('A was still running when switched back to', midRun);
      const toolRows = await app.count('.tool');
      const spinning = await app.count('.tool .tool-status.spin');
      check('the bash row is shown once, still running', toolRows === 1 && spinning === 1, { toolRows, spinning });
      const status = await app.evaluate(`({ hidden: document.querySelector('#status-line').hidden, text: document.querySelector('#status-text').innerText, time: document.querySelector('#status-time').innerText })`);
      check('the status line shows the run with its elapsed time', !status.hidden && /^\d+s$|^\dm/.test(status.time) && parseInt(status.time, 10) >= 1, status);
      check('one user bubble in A', (await app.count('.msg.user')) === 1);
      check('the stop button shows', await app.evaluate(`document.querySelector('#send-btn').classList.contains('stop')`));
      await shot('3-back-to-a-mid-run');
    }

    // ---- both finish ----
    await app.waitFor(`!document.querySelector('.session-item.running') && document.querySelector('#status-line').hidden`, 90_000, 'A to finish');
    await sleep(500);
    const liveA = await rows();
    if (app.live) {
      check('A ends with its reply', /A DONE/.test(await app.lastReply()), await app.lastReply());
      check('A: one user bubble, one bash row, a reply', liveA.filter((r) => /msg user/.test(r.cls)).length === 1 && (liveA.filter((r) => /^tool\b|\btool\b/.test(r.cls) && !/tool-group/.test(r.cls)).length === 1 || liveA.filter((r) => /tool-group/.test(r.cls) && /^Ran a command/.test(r.text)).length === 1) && liveA.filter((r) => /msg assistant/.test(r.cls)).length >= 1, liveA);
    }
    await shot('4-a-done');
    // What a window that watched from the start shows: the transcript rendered afresh
    await app.click(`.session-item[data-id="${idB}"]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${JSON.stringify(idB)}`, 10_000, 'B on screen');
    const rowsB2 = await rows();
    check("B's transcript is unchanged after A ended", JSON.stringify(rowsB2) === JSON.stringify(rowsB), rowsB2);
    await app.click(`.session-item[data-id="${idA}"]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${JSON.stringify(idA)}`, 10_000, 'A on screen again');
    await sleep(300);
    const freshA = await rows();
    // A stored transcript has no tool durations ("· 6.0s"), whichever way the window got there: compare without them.
    // A folded turn's rows are hidden, so a row reads as its whole text and the duration sits in the middle of it.
    const plain = (list) => list.map((r) => JSON.stringify({ ...r, text: r.text.replace(/ · \d+(\.\d+)?m?s\b/g, '') }));
    const [live, fresh] = [plain(liveA), plain(freshA)];
    // The first row that differs (a check's detail is clipped, so the two whole lists would not show it)
    const differ = live.length !== fresh.length ? { live: live.length, fresh: fresh.length } : live.map((row, i) => (row === fresh[i] ? null : { live: row, fresh: fresh[i] })).find(Boolean);
    check('A joined mid-run shows the same rows as A rendered afresh (none missing, none doubled)', !differ, differ);
    check('no unread or attention dots left', (await app.count('.status-dot')) === 0);
    await shot('5-a-fresh');
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${shots}`);
  } finally {
    await app.close();
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
