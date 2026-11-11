// Live check of the turn header and the fold, with the mock model in the real window. A turn that calls tools gets
// "Working for Ns" at the top of its output (the seconds tick) and a hairline; a run of calls is one line that reads
// the call in flight, faint and shimmering, then says what the run did; when the turn ends with its answer the header
// reads "Worked for Ns" and the process folds away, leaving the answer; the header (a real button) unfolds and folds
// it. An opened group lists its calls flat, capped with a fade. A reloaded session folds the same way and shows its
// time; an interrupted turn stays open; a card waiting for the user is never hidden; Every call folds nothing; light
// and dark.
// Run: npm run build && node test/live/chat-fold.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const { check, done } = checker();

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-fold-'));
  for (let i = 1; i <= 14; i++) fs.writeFileSync(path.join(project, `note-${i}.txt`), `Note ${i}\n`);
  const app = await launch({ mode: 'bypass', mock: true, project });
  const replies = app.mock.state.replies;
  const nothingRuns = `(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`;
  const idle = async () => {
    await app.waitFor(nothingRuns, 60_000, 'the run to end');
    await sleep(400);
  };
  /** The last turn's header and what its process looks like */
  const lastTurn = () =>
    app.evaluate(`(() => {
      const heads = [...document.querySelectorAll('#messages > .turn-head')];
      const h = heads.pop();
      if (!h) return null;
      const btn = h.querySelector('button');
      const nodes = [];
      for (let n = h.nextElementSibling; n && !(n.classList.contains('msg') && n.classList.contains('user')); n = n.nextElementSibling) nodes.push(n);
      const shown = (n) => getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().height > 0;
      return {
        heads: heads.length + 1,
        label: h.querySelector('.turn-head-label').textContent,
        live: h.classList.contains('live'),
        expanded: btn.getAttribute('aria-expanded'),
        disabled: btn.disabled,
        isButton: btn.tagName === 'BUTTON' && btn.tabIndex >= 0,
        chevron: getComputedStyle(h.querySelector('.turn-head-chevron')).display !== 'none',
        hairline: getComputedStyle(h).borderBottomStyle === 'solid' && parseFloat(getComputedStyle(h).borderBottomWidth) > 0,
        afterUser: h.previousElementSibling?.classList.contains('user') ?? false,
        nodes: nodes.map((n) => ({ cls: n.className, shown: shown(n), text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) })),
      };
    })()`);
  const kinds = (t, re) => t.nodes.filter((n) => re.test(n.cls));

  try {
    // ---------- 1. A turn: interim text, a command that takes a while, two reads, the answer ----------
    replies.push({ content: 'Let me look at the notes first.', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'sleep 3; echo checked' } }] });
    replies.push({ content: '', toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'note-1.txt' } }, { id: 'c3', name: 'read_file', args: { path: 'note-2.txt' } }], delayMs: 300 });
    replies.push({ content: 'Both notes are short. The answer: everything checks out.', delayMs: 300 });
    await app.send('Check the notes for me');
    await app.waitFor(`Boolean(document.querySelector('#messages > .turn-head.live'))`, 15_000, 'the live header');
    let t = await lastTurn();
    check('running: the header sits right under the user message and reads "Working for Ns"', t.afterUser && t.live && /^Working for \d+s$/.test(t.label), t.label);
    check('running: a hairline under it, no chevron, not a toggle yet', t.hairline && !t.chevron && t.disabled, t);
    const first = Number(/(\d+)s/.exec(t.label)[1]);
    const live = await app.waitFor(`(() => { const g = document.querySelector('#messages > .tool-group.live'); return g ? { verb: g.querySelector('.group-verb').textContent, arg: g.querySelector('.group-arg').textContent, opacity: getComputedStyle(g.querySelector('summary')).opacity, mask: getComputedStyle(g.querySelector('summary')).webkitMaskImage, anim: getComputedStyle(g.querySelector('.group-verb')).animationName, spin: g.querySelector('.group-icon').classList.contains('spin') } : null; })()`, 10_000, 'the live group');
    check('the live line reads the call in flight', live.verb === 'Bash' && /sleep 3/.test(live.arg), live);
    check('the live line is faint, shimmers and fades at the edge (no spinner)', Number(live.opacity) < 1 && live.anim === 'shimmer' && /gradient/.test(live.mask) && !live.spin, live);
    check('the interim text is under the header, in body ink', t.nodes.some((n) => /assistant/.test(n.cls) && /look at the notes/.test(n.text) && n.shown));
    await app.screenshot(path.join(shots, 'fold-1-running.png'));
    await sleep(2200);
    t = await lastTurn();
    const later = Number(/(\d+)s/.exec(t.label)?.[1] ?? -1);
    check('the seconds tick', later >= first + 2, { first, later });
    await idle();
    // The command and the two reads after it are one run of calls (nothing came between them)
    const doneWords = await app.evaluate(`[...document.querySelectorAll('#messages > .tool-group')][0].querySelector('.group-verb').textContent`);
    check('done, the line says what the run did, in our words', doneWords === 'Ran a command, read 2 files', doneWords);
    const answerTopBefore = await app.evaluate(`document.querySelector('#messages').scrollHeight`);

    t = await lastTurn();
    check('ended: "Worked for Ns", with a chevron, a real button, folded', /^Worked for \d+s$/.test(t.label) && !t.live && t.chevron && t.isButton && !t.disabled && t.expanded === 'false', t);
    const worked = Number(/(\d+)s/.exec(t.label)[1]);
    check('the time covers the run (about 4 s)', worked >= 3 && worked <= 15, t.label);
    check('folded: the groups and the interim text are hidden', kinds(t, /tool-group/).length === 1 && kinds(t, /tool-group/).every((n) => !n.shown) && t.nodes.filter((n) => /assistant/.test(n.cls) && /look at the notes/.test(n.text)).every((n) => !n.shown), t.nodes);
    const answer = t.nodes.filter((n) => /assistant/.test(n.cls) && /everything checks out/.test(n.text));
    check('folded: only the final answer shows', answer.length === 1 && answer[0].shown && t.nodes.filter((n) => n.shown).length === 1, t.nodes.filter((n) => n.shown));
    const inView = await app.evaluate(`(() => { const m = document.querySelector('#messages'); const a = [...document.querySelectorAll('#messages > .msg.assistant')].pop(); const r = a.getBoundingClientRect(); const box = m.getBoundingClientRect(); return { inView: r.top >= box.top - 1 && r.bottom <= box.bottom + 1, scrollHeight: m.scrollHeight }; })()`);
    check('the answer is in view after the fold, and the transcript got shorter', inView.inView && inView.scrollHeight <= answerTopBefore, { inView, answerTopBefore });
    await app.screenshot(path.join(shots, 'fold-2-folded.png'));

    // Click unfolds, click folds; the keyboard reaches it
    await app.evaluate(`[...document.querySelectorAll('#messages > .turn-head button')].pop().click()`);
    await sleep(200);
    t = await lastTurn();
    check('click: the process comes back in place, the header says it is open', t.expanded === 'true' && t.nodes.every((n) => n.shown), t.nodes.filter((n) => !n.shown));
    await app.evaluate(`[...document.querySelectorAll('#messages > .turn-head button')].pop().click()`);
    await sleep(200);
    t = await lastTurn();
    check('click again: folded', t.expanded === 'false' && t.nodes.filter((n) => n.shown).length === 1);
    await app.evaluate(`[...document.querySelectorAll('#messages > .turn-head button')].pop().focus()`);
    // Enter as a keyboard sends it (with its text, which is what activates a button)
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...enter });
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
    await sleep(200);
    t = await lastTurn();
    check('Enter on the focused header unfolds it', t.expanded === 'true' && t.nodes.every((n) => n.shown));

    // ---------- 2. A long group: opened, its calls are flat at its edge, capped with a fade ----------
    replies.push({ content: 'Reading all of them.', toolCalls: Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, name: 'read_file', args: { path: `note-${i + 1}.txt` } })) });
    replies.push({ content: 'All fourteen notes are fine.' });
    await app.send('Read every note');
    await idle();
    t = await lastTurn();
    check('a second turn: its own header, folded', t.heads === 2 && t.expanded === 'false' && /^Worked for \d+s$/.test(t.label));
    await app.evaluate(`[...document.querySelectorAll('#messages > .turn-head button')].pop().click()`);
    await sleep(150);
    await app.evaluate(`[...document.querySelectorAll('#messages > .tool-group')].pop().open = true`);
    await sleep(300);
    const list = await app.evaluate(`(() => {
      const g = [...document.querySelectorAll('#messages > .tool-group')].pop();
      const body = g.querySelector('.group-body');
      const rows = [...body.querySelectorAll(':scope > .tool')];
      const sum = g.querySelector('summary').getBoundingClientRect();
      const r0 = rows[0].querySelector('summary').getBoundingClientRect();
      const r1 = rows[1].querySelector('summary').getBoundingClientRect();
      return { words: g.querySelector('.group-verb').textContent, rows: rows.length, left: [sum.left, r0.left], pitch: r1.top - r0.top, height: body.clientHeight, scroll: body.scrollHeight, more: body.classList.contains('more'), mask: getComputedStyle(body).webkitMaskImage, chevronHidden: getComputedStyle(rows[0].querySelector('.tool-chevron')).visibility === 'hidden' };
    })()`);
    check('the group says what it did, with our wording', list.words === 'Read 14 files', list.words);
    check('opened: its rows sit at the group line\'s own left edge', list.rows === 14 && Math.abs(list.left[0] - list.left[1]) < 1, list.left);
    check('rows about 25 px apart, one line each', list.pitch >= 24 && list.pitch <= 26, list.pitch);
    check('the list is capped at about nine rows and scrolls, its last row fading', list.height >= 200 && list.height <= 240 && list.scroll > list.height && list.more && /gradient/.test(list.mask), list);
    check('rows show no chevron until hovered', list.chevronHidden);
    await app.evaluate(`(() => { const g = [...document.querySelectorAll('#messages > .tool-group')].pop(); g.scrollIntoView({ block: 'center' }); })()`);
    await sleep(300);
    await app.screenshot(path.join(shots, 'fold-3-long-group.png'));
    await app.evaluate(`(() => { const b = [...document.querySelectorAll('#messages > .tool-group')].pop().querySelector('.group-body'); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); })()`);
    await sleep(250);
    check('scrolled to its end, the fade goes', !(await app.evaluate(`[...document.querySelectorAll('#messages > .tool-group')].pop().querySelector('.group-body').classList.contains('more')`)));
    const rowOpen = await app.evaluate(`(() => { const g = [...document.querySelectorAll('#messages > .tool-group')].pop(); const row = g.querySelector('.group-body > .tool'); row.querySelector('summary').click(); return new Promise((r) => setTimeout(() => r({ open: row.open, body: (row.querySelector('.tool-body')?.textContent ?? '').trim().slice(0, 40), capped: getComputedStyle(g.querySelector('.group-body')).maxHeight }), 200)); })()`);
    check('a row still opens to its output on click (and lifts the cap)', rowOpen.open && /Note 1/.test(rowOpen.body) && rowOpen.capped === 'none', rowOpen);

    // ---------- 3. A reopened session folds the same way and shows its time ----------
    const before = (await app.evaluate(`[...document.querySelectorAll('#messages > .turn-head .turn-head-label')].map((e) => e.textContent)`));
    await app.evaluate('location.reload()');
    await sleep(1500);
    await app.waitFor(`document.querySelectorAll('#messages > .turn-head').length === 2`, 20_000, 'the reloaded session');
    const after = await app.evaluate(`[...document.querySelectorAll('#messages > .turn-head')].map((h) => ({ label: h.querySelector('.turn-head-label').textContent, expanded: h.querySelector('button').getAttribute('aria-expanded'), hidden: (() => { let n = 0; for (let x = h.nextElementSibling; x && !x.classList.contains('user'); x = x.nextElementSibling) if (getComputedStyle(x).display === 'none') n++; return n; })() }))`);
    const secs = (s) => Number(/(\d+)s/.exec(s)?.[1] ?? NaN);
    check('reloaded: both turns folded, process hidden', after.every((h) => h.expanded === 'false' && h.hidden > 0), after);
    check('reloaded: each shows the time it worked (the one stored)', after.every((h, i) => /^Worked for \d+s$/.test(h.label) && Math.abs(secs(h.label) - secs(before[i])) <= 1), { before, after: after.map((h) => h.label) });

    // ---------- 4. An approval card waiting is never hidden; decided, it folds with the process ----------
    await app.evaluate(`(async () => { const c = await oc.getConfig(); await oc.setConfig({ ...c, permissionMode: 'ask', autoApprove: false }); })()`);
    replies.push({ content: 'I need to write a file.', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'summary.txt', content: 'All fine.\n' } }] });
    replies.push({ content: 'Wrote summary.txt.' });
    await app.send('Write a summary file');
    await app.waitFor(`Boolean([...document.querySelectorAll('.approval')].find((c) => !c.classList.contains('done') && c.querySelector('.btn.primary')))`, 20_000, 'the approval card');
    await sleep(300);
    const waiting = await app.evaluate(`(() => { const c = [...document.querySelectorAll('.approval')].filter((x) => !x.classList.contains('done')).pop(); return { shown: getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 0, hiddenClass: c.classList.contains('turn-hidden'), live: Boolean(document.querySelector('#messages > .turn-head.live')) }; })()`);
    check('a card waiting for the user shows under a live header', waiting.shown && !waiting.hiddenClass && waiting.live, waiting);
    await app.approve('allow');
    await idle();
    t = await lastTurn();
    const left = t.nodes.filter((n) => n.shown);
    check('answered and done: the turn folds; the answer and the file\'s card show', t.expanded === 'false' && left.length === 2 && /Wrote summary/.test(left[0].text) && /chat-cards/.test(left[1].cls) && t.nodes.some((n) => /tool-group/.test(n.cls) && !n.shown), left);
    await app.evaluate(`(async () => { const c = await oc.getConfig(); await oc.setConfig({ ...c, permissionMode: 'bypass', autoApprove: true }); })()`);

    // ---------- 5. An interrupted turn stays open ----------
    replies.push({ content: 'Starting a long job.', toolCalls: [{ id: 'l1', name: 'bash', args: { command: 'sleep 30' } }] });
    await app.send('Run the long job');
    await app.waitFor(`Boolean(document.querySelector('#messages > .tool-group.live'))`, 15_000, 'the long call');
    await sleep(1200);
    await app.evaluate('oc.abort()');
    await idle();
    t = await lastTurn();
    check('interrupted: "Worked for Ns", open, nothing hidden', /^Worked for \d+s$/.test(t.label) && t.expanded === 'true' && t.nodes.every((n) => n.shown), t);
    check('interrupted: the "Interrupted." line is there', t.nodes.some((n) => /system/.test(n.cls) && /Interrupted/.test(n.text) && n.shown));

    // ---------- 6. A plain reply gets no header ----------
    replies.push({ content: 'Just an answer, no tools.' });
    await app.send('Say something');
    await idle();
    const plain = await app.evaluate(`(() => { const last = [...document.querySelectorAll('#messages > .msg.user')].pop(); let n = 0; for (let x = last.nextElementSibling; x; x = x.nextElementSibling) if (x.classList.contains('turn-head')) n++; return n; })()`);
    check('a turn without a tool call has no header', plain === 0);

    // ---------- 7. Every call: nothing folds by itself, groups open; the header still toggles ----------
    await app.evaluate(`(async () => { const c = await oc.getConfig(); await oc.setConfig({ ...c, toolActivity: 'all' }); })()`);
    await sleep(300);
    const refold = await app.evaluate(`[...document.querySelectorAll('#messages > .turn-head button')].map((b) => b.getAttribute('aria-expanded'))`);
    check('Every call: the turns on screen open', refold.every((v) => v === 'true'), refold);
    replies.push({ content: 'Reading three.', toolCalls: [1, 2, 3].map((i) => ({ id: `e${i}`, name: 'read_file', args: { path: `note-${i}.txt` } })) });
    replies.push({ content: 'Read three notes.' });
    await app.send('Read three notes');
    await idle();
    t = await lastTurn();
    const groupOpen = await app.evaluate(`(() => { const g = [...document.querySelectorAll('#messages > .tool-group')].pop(); return g ? g.open : null; })()`);
    check('Every call: the header shows, the turn stays open, its group is open', /^Worked for \d+s$/.test(t.label) && t.expanded === 'true' && t.nodes.every((n) => n.shown) && groupOpen === true, { label: t.label, groupOpen });
    await app.evaluate(`[...document.querySelectorAll('#messages > .turn-head button')].pop().click()`);
    await sleep(150);
    t = await lastTurn();
    check('Every call: the header still folds it', t.expanded === 'false' && t.nodes.filter((n) => n.shown).length === 1);
    await app.evaluate(`(async () => { const c = await oc.getConfig(); await oc.setConfig({ ...c, toolActivity: 'summary' }); })()`);
    await sleep(300);

    // ---------- 8. Light and dark ----------
    for (const theme of ['light', 'dark']) {
      await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await sleep(200);
      const look = await app.evaluate(`(() => {
        const h = document.querySelector('#messages > .turn-head');
        // (A hidden window draws no frames, so a colour transition would never finish)
        h.querySelector('button').style.transition = 'none';
        const probe = document.createElement('div'); probe.style.color = 'var(--text-400)'; probe.style.borderColor = 'var(--border-subtle)'; document.body.appendChild(probe);
        const want = getComputedStyle(probe).color; const line = getComputedStyle(probe).borderTopColor; probe.remove();
        return { label: getComputedStyle(h.querySelector('button')).color, want, line: getComputedStyle(h).borderBottomColor, wantLine: line, bg: getComputedStyle(document.body).backgroundColor };
      })()`);
      check(`${theme}: the header in the muted ink and the hairline in the subtle border`, look.label === look.want && look.line === look.wantLine && look.label !== look.bg, look);
    }
    await app.evaluate(`document.documentElement.dataset.theme = 'light'`);

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
