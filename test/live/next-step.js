// Live check of the next-step card (the next_step tool) with the mock model: a turn that reads a file, runs a command,
// answers and ends with a card. The card is drawn under the answer, above its Copy row, with no tool row of its own:
// the recap, the question, two replies (the first the primary one with ⌘↵). The model's words are text, never markup.
// A real click on a reply sends its label as the user's message and quiets the card (only the chosen reply stays);
// ⌘↵ with an empty chat bar picks the first reply (with text typed it sends that, as always). After a reload the
// stored cards are quiet with their chosen replies marked. A model that calls the tool first and writes its reply
// after gets the card under that reply; one that writes nothing after it, even when asked, gets the recap as its reply. Under each reply, after Copy, the time it was written.
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
      buttons: [...c.querySelectorAll('.next-step-reply')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => ({ label: b.dataset.reply, primary: b.classList.contains('primary'), chosen: b.classList.contains('chosen'), kbd: [...b.querySelectorAll('kbd')].map((k) => k.textContent).join(''), kbdShown: !!b.querySelector('.next-step-keys') && getComputedStyle(b.querySelector('.next-step-keys')).display !== 'none', kbdVisible: !!b.querySelector('kbd') && getComputedStyle(b.querySelector('kbd')).color !== getComputedStyle(b).backgroundColor, disabled: b.disabled })),
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
    check('1: recap, question, two replies; the first primary with ⌘↵', c[0].recap === CARD.recap && c[0].question === CARD.question && c[0].buttons.map((b) => b.label).join('|') === CARD.replies.join('|') && c[0].buttons[0].primary && c[0].buttons[0].kbd === '⌘↵' && c[0].buttons[0].kbdVisible && !c[0].buttons[1].primary && !c[0].quiet, c[0]);
    const rows = await app.evaluate(`[...document.querySelectorAll('#messages .tool')].map((t) => t.dataset.tool)`);
    check('1: no tool row for next_step', !rows.includes('next_step'), rows);
    const fold = await app.evaluate(`(() => { const h = [...document.querySelectorAll('#messages > .turn-head .turn-head-btn')].pop(); const a = [...document.querySelectorAll('#messages > .msg.assistant')].pop(); return { head: h?.getAttribute('aria-expanded'), label: h?.innerText.replace(/\\s+/g, ' ').trim(), answerShown: a && !a.classList.contains('turn-hidden') && a.innerText.includes(${JSON.stringify(ANSWER)}) }; })()`);
    check('1: the turn folds to its header with the answer and the card under it', fold.head === 'false' && /^Read a file, ran a command/.test(fold.label) && fold.answerShown, { fold, nodes: await app.evaluate(`[...document.querySelectorAll('#messages > *')].map((n) => n.className + (n.classList.contains('turn-hidden') ? '' : '*'))`) });
    const look = await app.evaluate(`(() => { const c = document.querySelector('.next-step'); const s = getComputedStyle(c); const q = getComputedStyle(c.querySelector('.next-step-question')); const r = getComputedStyle(c.querySelector('.next-step-recap')); const b = getComputedStyle(c.querySelector('.next-step-reply')); return { radius: s.borderTopLeftRadius, pad: s.padding, border: s.borderTopWidth, recap: r.fontSize + '/' + r.lineHeight, question: q.fontSize + '/' + q.lineHeight, btn: b.height + ' ' + b.borderTopLeftRadius }; })()`);
    check('1: the card per the mock-up: radius 14, padding 16 18 18, recap 14/20, question at the reading size 16/24 (--fs-reply), buttons 32 px radius 9', look.radius === '14px' && look.pad === '16px 18px 18px' && look.border === '1px' && look.recap === '14px/20px' && look.question === '16px/24px' && look.btn === '32px 9px', look);
    const foot = await app.evaluate(`(() => { const a = [...document.querySelectorAll('#messages > .msg.assistant')].pop().querySelector(':scope > .msg-actions'); const t = a.querySelector('.msg-time'); return { kids: [...a.children].map((k) => k.classList.contains('msg-copy') ? 'copy' : k.classList.contains('msg-time') ? 'time' : k.className), time: t?.textContent, size: t && getComputedStyle(t).fontSize, shown: getComputedStyle(a).opacity === '1', tip: t?.title }; })()`);
    check('1: under the answer: Copy, then the time ("Just now", 13 px), shown for the latest reply', foot.kids.join() === 'copy,time' && foot.time === 'Just now' && foot.size === '13px' && foot.shown && /\d{4}, \d\d:\d\d$/.test(foot.tip), foot);
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
    await sleep(1000);
    c = await cards();
    check('5: stored cards are quiet, in the replies, with the chosen replies', c.every((x) => x.quiet && x.inReply) && c[0].buttons.map((b) => b.label).join() === 'Not yet' && c[1].buttons.map((b) => b.label).join() === 'Ship it' && c[2].buttons.length === 0 && c[0].buttons[0].chosen, c);
    const times = await app.evaluate(`[...document.querySelectorAll('#messages > .msg.assistant')].filter((a) => a.querySelector('.md').innerText.trim()).map((a) => ({ time: a.querySelector('.msg-time')?.textContent ?? '', shown: getComputedStyle(a.querySelector(':scope > .msg-actions')).opacity === '1' }))`);
    check('5: stored replies keep their time; only the latest row shows without hover', times.length >= 4 && times.every((x) => x.time === 'Just now') && times.filter((x) => x.shown).length === 1 && times[times.length - 1].shown, times);
    await app.evaluate(`document.querySelector('#input').focus()`);
    await app.key('Enter', { meta: true });
    await sleep(400);
    users = await userTexts();
    check('5: ⌘↵ picks nothing from a stored card', users[users.length - 1] === 'Something else first', users);

    // 6. The call first, then the reply (as the tool asks): the card moves under that reply, live and after a reload
    const lastCard = () => app.evaluate(`(() => { const c = [...document.querySelectorAll('#messages .next-step')].pop(); const r = c.closest('.msg.assistant'); const replies = [...document.querySelectorAll('#messages > .msg.assistant')]; return { inReply: !!r, reply: r ? r.querySelector('.md').innerText.trim() : '', inLast: r === replies[replies.length - 1], beforeActions: c.nextElementSibling?.classList.contains('msg-actions') ?? false, quiet: c.classList.contains('quiet'), buttons: [...c.querySelectorAll('.next-step-reply')].length, cards: document.querySelectorAll('#messages .next-step').length }; })()`);
    replies.push({ content: 'Checking the CI config first.', toolCalls: [{ id: 'n6', name: 'next_step', args: { recap: 'Lint is not set up yet.', question: 'Which checks should CI run?', replies: ['ESLint and tsc', 'Only tsc'] } }] });
    replies.push({ content: 'Nothing lints the code today. Adding ESLint and tsc would catch both style and type errors.', delayMs: 300 });
    await app.send('What should CI check?');
    await app.waitFor(nothingRuns, 30_000, 'the sixth run to end');
    await sleep(500);
    let lc = await lastCard();
    check('6: call first, reply after: the card sits under that reply (the last one), above its Copy row, live', lc.cards === 4 && lc.inReply && lc.inLast && lc.beforeActions && /^Nothing lints/.test(lc.reply) && !lc.quiet && lc.buttons === 2, lc);
    await app.screenshot(path.join(shots, 'next-step-call-first.png'));

    // 7. The call first, then nothing (twice): the recap is the reply, the card under it
    replies.push({ content: '', toolCalls: [{ id: 'n7', name: 'next_step', args: { recap: 'The build passes; nothing is deployed.', question: 'Deploy now?', replies: ['Deploy', 'Wait'] } }] });
    replies.push({ content: '' });
    replies.push({ content: '' });
    await app.send('Build it.');
    await app.waitFor(nothingRuns, 30_000, 'the seventh run to end');
    await sleep(500);
    lc = await lastCard();
    check('7: nothing written after the card, even when asked: the recap is the reply, with the card under it', lc.cards === 5 && lc.inReply && lc.inLast && lc.reply === 'The build passes; nothing is deployed.' && lc.buttons === 2, lc);
    const quietBefore = await app.evaluate(`[...document.querySelectorAll('#messages .next-step')][3].classList.contains('quiet')`);
    check('7: the card before it went quiet (a message was sent)', quietBefore);

    await app.evaluate('location.reload()');
    await app.waitFor(`document.querySelectorAll('#messages .next-step').length === 5`, 15_000, 'the stored cards (6, 7)');
    await sleep(500);
    const stored67 = await app.evaluate(`[...document.querySelectorAll('#messages .next-step')].slice(3).map((c) => { const r = c.closest('.msg.assistant'); return r ? r.querySelector('.md').innerText.trim().slice(0, 20) : null; })`);
    check('6, 7: stored, each card is under its turn\'s last reply', stored67[0] === 'Nothing lints the co' && stored67[1] === 'The build passes; no', stored67);

    // 8. Long labels: up to 40 characters, a trailing "(Recommended)" dropped; two that do not fit side by side wrap
    replies.push({ content: '', toolCalls: [{ id: 'n8', name: 'next_step', args: { recap: 'CI runs only the unit tests.', question: 'Which checks should CI add?', replies: ['ESLint, tsc and Prettier (Recommended)', 'Only tsc and the unit tests for now'] } }] });
    replies.push({ content: 'CI runs only the unit tests today; linting and type checks would catch more before review.' });
    await app.send('What else should CI run?');
    await app.waitFor(nothingRuns, 30_000, 'the eighth run to end');
    await sleep(500);
    const long = await app.evaluate(`(() => { const c = [...document.querySelectorAll('#messages .next-step')].pop(); const b = [...c.querySelectorAll('.next-step-reply')]; return { labels: b.map((x) => x.dataset.reply), text: b.map((x) => x.querySelector('span').textContent) }; })()`);
    check('8: a 35-character reply shows whole; "(Recommended)" is dropped from the first', JSON.stringify(long.labels) === JSON.stringify(['ESLint, tsc and Prettier', 'Only tsc and the unit tests for now']) && JSON.stringify(long.text) === JSON.stringify(long.labels), long);
    const wrap = await app.evaluate(`(() => { const c = [...document.querySelectorAll('#messages .next-step')].pop(); c.style.width = '360px'; const cr = c.getBoundingClientRect(); const b = [...c.querySelectorAll('.next-step-reply')].map((x) => x.getBoundingClientRect()); const out = { rows: b.map((r) => Math.round(r.top)), inside: b.every((r) => r.right <= cr.right - 17 && r.left >= cr.left), scroll: c.scrollWidth <= c.clientWidth }; return out; })()`);
    check('8: too narrow for both side by side, the second reply wraps to its own row, nothing overflows', wrap.rows[1] > wrap.rows[0] && wrap.inside && wrap.scroll, wrap);
    await app.screenshot(path.join(shots, 'next-step-long-labels.png'));
    await app.evaluate(`[...document.querySelectorAll('#messages .next-step')].pop().style.width = ''`);

    // 9. While the turn still runs (the card is drawn at the call, the reply not written yet) a click or ⌘↵ does nothing
    replies.push({ content: '', toolCalls: [{ id: 'n9', name: 'next_step', args: { recap: 'The plan is ready.', question: 'Start on it?', replies: ['Start', 'Stop here'] } }] });
    replies.push({ content: 'Here is the plan in full: tokens first, then the page.', delayMs: 3000 });
    await app.send('Plan it.');
    await app.waitFor(`document.querySelectorAll('#messages .next-step').length === 7`, 10_000, 'the card while the run goes on');
    await realClick(`[...document.querySelectorAll('#messages .next-step')].pop().querySelector('.next-step-reply')`);
    await app.evaluate(`document.querySelector('#input').focus()`);
    await app.key('Enter', { meta: true });
    await sleep(300);
    const during = await app.evaluate(`(async () => ({ running: !(await oc.sessions.list()).every((m) => !m.status?.running), last: [...document.querySelectorAll('#messages > .msg.user .bubble')].pop().textContent.trim(), quiet: [...document.querySelectorAll('#messages .next-step')].pop().classList.contains('quiet') }))()`);
    check('9: while the run goes on a click and ⌘↵ send nothing; the card stays live', during.running && during.last === 'Plan it.' && !during.quiet, during);
    await app.waitFor(nothingRuns, 30_000, 'the ninth run to end');

    // 10. After a reload the last card, with nothing after it, keeps its buttons; a pick sends its label alone, as
    // plain text: the draft stays in the chat bar and the image waiting in the tray stays there
    await app.evaluate('location.reload()');
    await app.waitFor(`document.querySelectorAll('#messages .next-step').length === 7`, 15_000, 'the stored cards (9)');
    await sleep(800);
    c = await cards();
    check('10: stored, the last card (no message after it) is live with both replies; the ones before are quiet', !c[6].quiet && c[6].buttons.length === 2 && c[6].buttons.every((b) => !b.disabled) && c.slice(0, 6).every((x) => x.quiet), c.map((x) => [x.quiet, x.buttons.length]));
    await app.evaluate(`(() => {
      const i = document.querySelector('#input');
      i.value = 'my draft';
      const bin = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))], 'dot.png', { type: 'image/png' }));
      i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await app.waitFor(`document.querySelectorAll('#attachments .attachment:not(.pending)').length === 1`, 10_000, 'the image in the tray');
    replies.push({ content: 'Stopping here.' });
    await realClick(`[...document.querySelectorAll('.next-step-reply')].find((b) => b.dataset.reply === 'Stop here')`);
    await app.waitFor(nothingRuns, 30_000, 'the tenth run to end');
    await sleep(400);
    const pick = await app.evaluate(`(() => { const u = [...document.querySelectorAll('#messages > .msg.user')].pop(); return { text: u.querySelector('.bubble').textContent.trim(), images: u.querySelectorAll('.bubble-image').length, draft: document.querySelector('#input').value, tray: document.querySelectorAll('#attachments .attachment').length }; })()`);
    const sentImages = app.mock.state.requests.filter((q) => q.url === '/v1/chat/completions').pop()?.payload.messages.filter((m) => m.role === 'user').pop()?.content;
    check('10: the pick sent "Stop here" alone: no image with it, the draft and the image left where they were', pick.text === 'Stop here' && pick.images === 0 && pick.draft === 'my draft' && pick.tray === 1 && !JSON.stringify(sentImages ?? '').includes('image_url'), { pick, sentImages });

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
