// Live check of what the window shows during long steps, with the mock model (no key needed, none used):
//   1  while the model writes a large tool input, the status line says "Writing a file… N KB" and the size grows;
//      the call's row appears only once the input is complete, and the line then names the tool's own verb
//   2  while Auto mode's safety check decides on a command, the status line and the command's row say "Checking…"
//      (the command has not run); both clear when the check allows it and the command runs
//   3  after 30 s with nothing from the model the status line says "No output for 30 s · retries at 5 min", counting
//      up, and clears when the text comes; with keep-alive data meanwhile it says "still connected" instead
//   4  /report shows the session as a card of numbers, in the window only
// Each state's text fits the line uncut; in a narrow column (the rail and the Browser pane open in a 1200 px window)
// "to interrupt" and the token count give way so "Checking…" still fits, and the shut run line says it too.
// Screenshots of each state, light and dark, in the folder given (default: a temp folder). Takes about two minutes:
// the silences are the real 30 s.
// Run: npm run build && env -u ANTHROPIC_API_KEY node test/live/run-visibility.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');
const { classifierReply } = require('../support/mock-model.js');

const { check, done } = checker();
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-visibility-'));
fs.mkdirSync(shots, { recursive: true });

/** The status line's text, or null when it is hidden */
const statusText = (app) => app.evaluate(`(() => { const s = document.querySelector('#status-line'); return s && !s.hidden ? document.querySelector('#status-text').textContent : null; })()`);
/** The status line's text is shown whole (not cut with an ellipsis) */
const uncut = (app) => app.evaluate(`(() => { const t = document.querySelector('#status-text'); return t.scrollWidth <= t.clientWidth + 1; })()`);

/**
 * Screenshots in light and dark of the reading column from `topJs` (an expression giving the element whose top starts
 * the crop) down to just under the composer. The theme goes back to what it was.
 */
async function shoot(app, name, topJs) {
  // New messages fade in: let them settle first
  await sleep(1000);
  const was = await app.evaluate(`document.documentElement.dataset.theme || ''`);
  for (const theme of ['light', 'dark']) {
    await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await sleep(450);
    const clip = await app.evaluate(`(() => {
      const top = (${topJs}) || document.querySelector('#status-line');
      const foot = document.querySelector('#composer').getBoundingClientRect();
      const col = document.querySelector('#messages').getBoundingClientRect();
      const t = top.getBoundingClientRect();
      const x = Math.max(col.x, foot.x - 40);
      const y = Math.max(col.y, t.y - 24);
      return { x, y, width: Math.min(col.x + col.width, foot.x + foot.width + 40) - x, height: foot.y + foot.height + 14 - y };
    })()`);
    await app.screenshot(path.join(shots, `${name}-${theme}.png`), clip);
  }
  await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(was)}`);
}

(async () => {
  let app;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-visibility-project-'));
  try {
    app = await launch({ mode: 'auto', mock: true, project });
    const replies = app.mock.state.replies;
    const lastUser = `[...document.querySelectorAll('#messages > .msg.user')].pop()`;

    // ---------- 1: a large tool input being written ----------
    const content = Array.from({ length: 900 }, (_, i) => `Line ${i + 1} of the made-up notes for the demo project.`).join('\n');
    replies.push({ content: '', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'notes.md', content } }], argChunks: 40, chunkDelayMs: 200 });
    replies.push({ content: 'Wrote notes.md.' });
    await app.send('Write the notes file');
    const seen = [];
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const t = await statusText(app);
      if (t && t.startsWith('Writing a file')) seen.push(t);
      if (seen.length >= 3 && /KB$/.test(seen[seen.length - 1])) break;
      await sleep(250);
    }
    const sizes = seen.map((t) => Number(/(\d+) KB$/.exec(t)?.[1] ?? 0)).filter(Boolean);
    check('1: while the input is written, the status line says "Writing a file… N KB"', seen.some((t) => /^Writing a file… \d+ KB$/.test(t)), seen.slice(-4));
    const rowEarly = await app.evaluate(`Boolean(document.querySelector('#messages .tool[data-call-id="w1"]'))`);
    check('1: …the call\'s row is not there yet', !rowEarly);
    check('1: …and the line is not cut', await uncut(app));
    await shoot(app, 'input-progress', lastUser);
    await sleep(1200);
    const later = await statusText(app);
    const laterSize = Number(/(\d+) KB$/.exec(later ?? '')?.[1] ?? 0);
    check('1: …and the size grows', sizes.length > 0 && laterSize > sizes[0], { first: sizes[0], later });
    await app.waitFor(`Boolean(document.querySelector('#messages .tool[data-call-id="w1"]'))`, 20_000, 'the write row');
    await app.waitIdle(30_000);
    check('1: the write ran, and the line is gone with the run', fs.existsSync(path.join(project, 'notes.md')) && (await statusText(app)) === null);

    // ---------- 2: Auto mode's safety check ----------
    replies.push({ content: 'Saving the date.', toolCalls: [{ id: 'b1', name: 'bash', args: { command: 'date > stamp.txt' } }] });
    replies.push(classifierReply('allow', '[Local Work] writes a file in the project', { delayMs: 9000 }));
    replies.push({ content: 'Saved the date.' });
    await app.send('Save the date in a file');
    await app.waitFor(`document.querySelector('#status-text')?.textContent === 'Checking…'`, 15_000, 'the Checking line');
    const row = await app.evaluate(`(() => { const r = document.querySelector('#messages .tool[data-call-id="b1"]'); if (!r) return null; const g = r.closest('.tool-group'); return { checking: r.classList.contains('checking'), tag: r.querySelector(':scope > summary > .tool-check')?.textContent ?? null, group: g ? { open: g.open, line: g.querySelector(':scope > summary')?.innerText.replace(/\\s+/g, ' ').trim() } : null }; })()`);
    check('2: while the check runs, the status line says "Checking…"', (await statusText(app)) === 'Checking…');
    check('2: …and the command\'s row says "Checking…"', row?.checking === true && row.tag === 'Checking…', row);
    check('2: …the command has not run', !fs.existsSync(path.join(project, 'stamp.txt')));
    check('2: …the line is not cut', await uncut(app));
    await shoot(app, 'checking', lastUser);
    // A narrow column: the rail and the Browser pane open in a 1200 px window
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(500);
    const narrow = await app.evaluate(`(() => ({ col: Math.round(document.querySelector('#messages').getBoundingClientRect().width), hint: getComputedStyle(document.querySelector('#stop-btn > span')).display, line: [...document.querySelectorAll('#messages > .tool-group.live')].pop()?.querySelector(':scope > summary')?.innerText.replace(/\\s+/g, ' ').trim() ?? null }))()`);
    check('2: in a narrow column "to interrupt" gives way and "Checking…" still fits', narrow.col < 480 && narrow.hint === 'none' && (await uncut(app)) && (await statusText(app)) === 'Checking…', narrow);
    check('2: …and the shut run line says "Checking…" beside the command', narrow.line !== null && /date > stamp\.txt.*Checking…/.test(narrow.line), narrow.line);
    await shoot(app, 'checking-narrow', lastUser);
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(300);
    await app.waitIdle(30_000);
    const after = await app.evaluate(`(() => { const r = document.querySelector('#messages .tool[data-call-id="b1"]'); return r ? { checking: r.classList.contains('checking'), tag: Boolean(r.querySelector('.tool-check')) } : null; })()`);
    check('2: allowed, the command ran and its row no longer says "Checking…"', fs.existsSync(path.join(project, 'stamp.txt')) && after && !after.checking && !after.tag, after);

    // ---------- 3: a silence from the model ----------
    replies.push({ content: 'Here is the plan after a long think.', silenceMs: 40_000 });
    await app.send('Think about the next step');
    await app.waitFor(`/^No output for \\d+ s · retries at 5 min$/.test(document.querySelector('#status-text')?.textContent ?? '')`, 40_000, 'the silence line');
    const s1 = await statusText(app);
    await sleep(2200);
    const s2 = await statusText(app);
    const secs = (t) => Number(/for (\d+) s/.exec(t ?? '')?.[1] ?? -1);
    check('3: after 30 s with nothing, the line says "No output for 30 s · retries at 5 min"', secs(s1) >= 30 && secs(s1) <= 32, s1);
    check('3: …counting up', secs(s2) >= secs(s1) + 2, { s1, s2 });
    check('3: …and the line is not cut', await uncut(app));
    await shoot(app, 'no-output', lastUser);
    await app.waitFor(`!/^No output/.test(document.querySelector('#status-text')?.textContent ?? '')`, 20_000, 'the silence to end');
    await app.waitIdle(20_000);
    const answered = await app.evaluate(`[...document.querySelectorAll('#messages > .msg.assistant')].pop()?.innerText.includes('Here is the plan')`);
    check('3: the text came and the line went', answered === true);

    replies.push({ content: 'Still thinking, then done.', silenceMs: 36_000, pingMs: 3000 });
    await app.send('Think once more');
    await app.waitFor(`/^No output for \\d+ s · still connected$/.test(document.querySelector('#status-text')?.textContent ?? '')`, 40_000, 'the still-connected line');
    check('3: with keep-alive data meanwhile, the line says "still connected" instead', /^No output for \d+ s · still connected$/.test((await statusText(app)) ?? ''));
    await shoot(app, 'no-output-connected', lastUser);
    await app.waitIdle(30_000);

    // ---------- 4: /report ----------
    const asked = app.mock.state.requests.length;
    await app.send('/report');
    await app.waitFor(`[...document.querySelectorAll('#messages > .msg.system.notice.card')].some((c) => c.innerText.includes('Session report'))`, 10_000, 'the report card');
    const card = await app.evaluate(`[...document.querySelectorAll('#messages > .msg.system.notice.card')].pop().innerText`);
    console.log(card.replace(/^/gm, '    '));
    check('4: /report shows a card: turns, model calls, tools, the check, the stretches', /Time/.test(card) && /4 turns/.test(card) && /Model calls/.test(card) && /bash: 1/.test(card) && /write_file: 1/.test(card) && /Safety checks 1/.test(card) && /allow 1/.test(card) && /Longest stretches with no record/.test(card) && /after (user message|start of turn), before model reply/.test(card), card);
    check('4: …nothing of the content: no file name, no command, no text', !/notes\.md|stamp|date >|plan after|Think/.test(card));
    check('4: …and no request went to the model for it', app.mock.state.requests.length === asked);
    await app.evaluate(`[...document.querySelectorAll('#messages > .msg.system.notice.card')].pop().scrollIntoView({ block: 'end' })`);
    await shoot(app, 'report', `[...document.querySelectorAll('#messages > .msg.system.notice.card')].pop()`);

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no console errors', errors.length === 0, errors.slice(-5));
    console.log(`screenshots: ${shots}`);
  } catch (err) {
    check(`no crash: ${err && err.message}`, false);
  } finally {
    if (app) await app.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
  done();
})();
