// Live check of the next-step card (the next_step tool) with the mock model: a turn that reads a file, runs a command,
// answers and ends with a card. The card is drawn under the answer, above its Copy row, with no tool row of its own:
// the recap, the question, two replies (the first the primary one with ⌘↵). The model's words are text, never markup.
// A real click on a reply sends its label as the user's message and quiets the card (only the chosen reply stays);
// ⌘↵ with an empty chat bar picks the first reply (with text typed it sends that, as always). After a reload the
// stored cards are quiet with their chosen replies marked.
// Run: npm run build && node test/live/next-step.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const { check, done } = checker();
const ANSWER = 'The importer now resumes after a crash, and all tests pass.';
const CARD = { recap: 'The importer resumes after a crash and its tests pass. Nothing is pushed yet.', question: 'Push it on a new branch instead?', replies: ['Yes, new branch', 'Not yet'] };

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-nextstep-'));
  fs.writeFileSync(path.join(project, 'feed.ts'), 'export const feed = 1;\n');
  const app = await launch({ mode: 'bypass', mock: true, project, size: { width: 1200, height: 900 } });
  const replies = app.mock.state.replies;
  const nothingRuns = `(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`;
  const realClick = async (js) => {
    const p = await app.evaluate(`(() => { const e = ${js}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(60);
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(250);
  };
  /** The cards on screen: where each is, what it says, its buttons */
  const cards = () =>
    app.evaluate(`[...document.querySelectorAll('#messages .next-step')].map((c) => ({
      inReply: c.parentElement.matches('.msg.assistant'),
      beforeActions: c.nextElementSibling?.classList.contains('msg-actions') ?? false,
      quiet: c.classList.contains('quiet'),
      recap: c.querySelector('.next-step-recap')?.textContent,
      question: c.querySelector('.next-step-question')?.textContent ?? '',
      markup: c.querySelectorAll('b, img, a').length,
      buttons: [...c.querySelectorAll('.next-step-reply')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => ({ label: b.dataset.reply, primary: b.classList.contains('primary'), chosen: b.classList.contains('chosen'), kbd: b.querySelector('kbd')?.textContent ?? '', kbdShown: !!b.querySelector('kbd') && getComputedStyle(b.querySelector('kbd')).display !== 'none', disabled: b.disabled })),
      shown: c.getBoundingClientRect().height > 0,
    }))`);
  const userTexts = () => app.evaluate(`[...document.querySelectorAll('#messages > .msg.user .bubble')].map((b) => b.textContent.trim())`);
  try {
    // 1. A turn that works, answers and ends with a card
    replies.push({ content: '', toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'feed.ts' } }, { id: 'r2', name: 'bash', args: { command: 'echo 14 passed' } }] });
    replies.push({ content: ANSWER, toolCalls: [{ id: 'n1', name: 'next_step', args: CARD }], delayMs: 100 });
    replies.push({ content: '', delayMs: 100 });
    await app.send('Make the feed importer resumable.');
    await app.waitFor(nothingRuns, 30_000, 'the run to end');
    await app.waitFor(`Boolean(document.querySelector('#messages .next-step'))`, 10_000, 'the card');
    await sleep(500);
    let c = await cards();
    check('1: one card, inside the answer, above its Copy row', c.length === 1 && c[0].inReply && c[0].beforeActions && c[0].shown, c);
    check('1: recap, question, two replies; the first primary with ⌘↵', c[0].recap === CARD.recap && c[0].question === CARD.question && c[0].buttons.map((b) => b.label).join('|') === CARD.replies.join('|') && c[0].buttons[0].primary && c[0].buttons[0].kbd === '⌘↵' && !c[0].buttons[1].primary && !c[0].quiet, c[0]);
    const rows = await app.evaluate(`[...document.querySelectorAll('#messages .tool')].map((t) => t.dataset.tool)`);
    check('1: no tool row for next_step', !rows.includes('next_step'), rows);
    const fold = await app.evaluate(`(() => { const h = [...document.querySelectorAll('#messages > .turn-head .turn-head-btn')].pop(); const a = [...document.querySelectorAll('#messages > .msg.assistant')].pop(); return { head: h?.getAttribute('aria-expanded'), label: h?.innerText.replace(/\\s+/g, ' ').trim(), answerShown: a && !a.classList.contains('turn-hidden') && a.innerText.includes(${JSON.stringify(ANSWER)}) }; })()`);
    check('1: the turn folds to its header with the answer and the card under it', fold.head === 'false' && /^Read a file, ran a command/.test(fold.label) && fold.answerShown, { fold, nodes: await app.evaluate(`[...document.querySelectorAll('#messages > *')].map((n) => n.className + (n.classList.contains('turn-hidden') ? '' : '*'))`) });
    const look = await app.evaluate(`(() => { const c = document.querySelector('.next-step'); const s = getComputedStyle(c); const q = getComputedStyle(c.querySelector('.next-step-question')); const r = getComputedStyle(c.querySelector('.next-step-recap')); const b = getComputedStyle(c.querySelector('.next-step-reply')); return { radius: s.borderTopLeftRadius, pad: s.padding, border: s.borderTopWidth, recap: r.fontSize + '/' + r.lineHeight, question: q.fontSize + '/' + q.lineHeight, btn: b.height + ' ' + b.borderTopLeftRadius }; })()`);
    check('1: the card per the mock-up: radius 14, padding 16 18 18, recap 14/20, question 15/22, buttons 32 px radius 9', look.radius === '14px' && look.pad === '16px 18px 18px' && look.border === '1px' && look.recap === '14px/20px' && look.question === '15px/22px' && look.btn === '32px 9px', look);
    await app.screenshot(path.join(shots, 'next-step-card.png'));

    // 2. A real click on the second reply sends its label; the card goes quiet with that reply marked
    replies.push({ content: 'Fine, it stays local for now.', toolCalls: [{ id: 'n2', name: 'next_step', args: { recap: 'Nothing is pushed.', question: '<b>Ship</b> it <img src=x onerror="window.__xss=1">?', replies: ['Ship it', 'Wait'] } }] });
    replies.push({ content: '' });
    await realClick(`[...document.querySelectorAll('.next-step-reply')].find((b) => b.dataset.reply === 'Not yet')`);
    await app.waitFor(nothingRuns, 30_000, 'the second run to end');
    await app.waitFor(`document.querySelectorAll('#messages .next-step').length === 2`, 10_000, 'the second card');
    await sleep(400);
    let users = await userTexts();
    check('2: the click sent "Not yet" as the user\'s message', users[users.length - 1] === 'Not yet', users);
    c = await cards();
    check('2: the first card is quiet: only "Not yet" shows, marked, no ⌘↵', c[0].quiet && c[0].buttons.length === 1 && c[0].buttons[0].label === 'Not yet' && c[0].buttons[0].chosen && !c[0].buttons[0].kbdShown && c[0].buttons[0].disabled, c[0]);
    check('2: the new card is live', !c[1].quiet && c[1].buttons.length === 2, c[1]);
    check('2: the model\'s markup is text', c[1].markup === 0 && c[1].question.includes('<b>Ship</b>') && !(await app.evaluate('window.__xss === 1')), c[1]);
    const composer = await app.evaluate(`document.querySelector('#input').value`);
    check('2: the chat bar is empty after the click', composer === '', composer);

    // 3. ⌘↵ with an empty chat bar picks the first reply
    replies.push({ content: 'Shipped.' });
    await app.evaluate(`document.querySelector('#input').focus()`);
    await app.key('Enter', { meta: true });
    await app.waitFor(nothingRuns, 30_000, 'the third run to end');
    await sleep(400);
    users = await userTexts();
    c = await cards();
    check('3: ⌘↵ with an empty chat bar sent the first reply', users[users.length - 1] === 'Ship it', users);
    check('3: and the card is quiet with it marked', c[1].quiet && c[1].buttons.length === 1 && c[1].buttons[0].label === 'Ship it' && c[1].buttons[0].chosen, c[1]);

    // 4. A message typed by hand quiets a card too; nothing is marked when it is not a reply
    replies.push({ content: 'Done for now.', toolCalls: [{ id: 'n3', name: 'next_step', args: { recap: 'Shipped.', question: 'Tag a release?', replies: ['Tag it'] } }] });
    replies.push({ content: '' });
    await app.send('Thanks');
    await app.waitFor(nothingRuns, 30_000, 'the fourth run to end');
    await app.waitFor(`document.querySelectorAll('#messages .next-step').length === 3`, 10_000, 'the third card');
    replies.push({ content: 'Okay.' });
    await app.send('Something else first');
    await app.waitFor(nothingRuns, 30_000, 'the fifth run to end');
    await sleep(300);
    c = await cards();
    check('4: a typed message quiets the card, no reply marked (the buttons are gone)', c[2].quiet && c[2].buttons.length === 0, c[2]);

    // 5. After a reload the stored cards are quiet, the chosen replies marked
    await app.evaluate('location.reload()');
    await app.waitFor(`document.querySelectorAll('#messages .next-step').length === 3`, 15_000, 'the stored cards');
    await sleep(500);
    c = await cards();
    check('5: stored cards are quiet, in the replies, with the chosen replies', c.every((x) => x.quiet && x.inReply) && c[0].buttons.map((b) => b.label).join() === 'Not yet' && c[1].buttons.map((b) => b.label).join() === 'Ship it' && c[2].buttons.length === 0 && c[0].buttons[0].chosen, c);
    await app.evaluate(`document.querySelector('#input').focus()`);
    await app.key('Enter', { meta: true });
    await sleep(400);
    users = await userTexts();
    check('5: ⌘↵ picks nothing from a stored card', users[users.length - 1] === 'Something else first', users);

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await app.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
