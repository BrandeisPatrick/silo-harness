// Live check of messages between sessions in the real window, with the mock model: two unrelated sessions, "stars"
// (B) and "Release notes" (A). A's turn lists the folder, then messages B with session_send; the approval card in A
// is answered "Allow messages to "stars" for this session"; B starts a run and replies. A shows "Messaged stars ›"
// (its own line, never folded with the listing, in either Tool activity mode) that opens to the message and how it
// was delivered; B shows "Received message from Release notes ›" with A linked, opening to the message, followed by
// B's reply; the names open the other session; B carries the unread mark while A is on screen.
// Run: npm run build && node test/live/session-messages.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const MESSAGE = 'Count the lines in README.md and tell me the number. **Only the number** is needed.';
const REPLY_B = 'README.md has 7 lines.';

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-session-messages-'));
  fs.writeFileSync(path.join(project, 'README.md'), ['# Demo', '', 'A small folder for a live check.', '', 'Line five.', 'Line six.', 'Line seven.'].join('\n') + '\n');
  const app = await launch({ mode: 'ask', mock: true, project });
  const st = app.mock.state;
  const q = (v) => JSON.stringify(v);
  const current = () => app.evaluate(`oc.sessions.current().then((m) => m.id)`);
  const nothingRuns = `(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`;
  const last = (p) => p.messages?.[p.messages.length - 1];
  const text = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
  const firstUser = (p) => (p.messages || []).find((m) => m.role === 'user');
  const shot = async (name, selector, margin = 24) => {
    for (const theme of ['light', 'dark']) {
      await app.evaluate(`document.documentElement.dataset.theme = ${q(theme)}`);
      await sleep(200);
      await app.screenshotOf(path.join(shots, `${name}-${theme}.png`), selector, margin);
    }
    await app.evaluate(`document.documentElement.dataset.theme = ''`);
  };
  try {
    // ---- B: the session the app opened with, named "stars" ----
    st.replies.push({ content: 'Ready.', when: (p) => last(p)?.role === 'user' && text(last(p)).includes('[B-start]') });
    await app.send('Wait for requests from other sessions [B-start]');
    await app.waitIdle();
    const B = await current();
    await app.evaluate(`oc.sessions.rename(${q(B)}, 'stars')`);

    // ---- A: a new session on screen, named "Release notes" ----
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('#empty-state') && !document.querySelector('#empty-state').hidden`, 10_000, 'a new session');
    const A = await current();
    check('A is a session of its own', A && A !== B, { A, B });
    // A's turn: list the folder, message B, then say so
    const inA = (p) => text(firstUser(p)).includes('[A-send]');
    st.replies.push({ content: '', toolCalls: [{ id: 'call_ls_1', name: 'list_directory', args: { path: '.' } }], when: (p) => inA(p) && last(p)?.role === 'user' });
    st.replies.push({ content: '', toolCalls: [{ id: 'call_send_1', name: 'session_send', args: { to: B, message: MESSAGE } }], when: (p) => inA(p) && last(p)?.role === 'tool' && last(p).tool_call_id === 'call_ls_1' });
    st.replies.push({ content: 'I asked stars to count the lines.', when: (p) => inA(p) && last(p)?.role === 'tool' && last(p).tool_call_id === 'call_send_1' });
    st.replies.push({ content: REPLY_B, when: (p) => last(p)?.role === 'user' && text(last(p)).includes('Count the lines in README.md') });
    await app.send('Ask the stars session how many lines README.md has [A-send]');
    await app.waitFor(`(async () => (await oc.sessions.list()).some((m) => m.id === ${q(A)}))()`, 10_000, 'A in the list');
    await app.evaluate(`oc.sessions.rename(${q(A)}, 'Release notes')`);

    // ---- the approval card in A: Allow once, "Allow messages to "stars" for this session", Deny ----
    await app.waitFor(`Boolean([...document.querySelectorAll('.approval')].find((c) => !c.classList.contains('done') && c.querySelector('.btn.primary')))`, 30_000, 'the approval card');
    await sleep(200);
    const card = await app.evaluate(`(() => { const c = [...document.querySelectorAll('.approval')].pop(); return { title: c.querySelector('.title').innerText.trim(), body: c.querySelector('.approval-body').innerText.trim(), buttons: [...c.querySelectorAll('.btn')].map((b) => b.getAttribute('aria-label') || b.innerText.trim()) }; })()`);
    check('the card asks to message "stars" and shows the message', card.title === 'Allow Silo Harness to send a message to “stars”?' && card.body.includes(MESSAGE), card);
    check('the card has Deny, Allow once and the menu of wider answers', JSON.stringify(card.buttons) === JSON.stringify(['Deny', 'Allow once', 'More ways to allow']), card.buttons);
    check('while it waits, the line reads "Messaging stars…"', (await app.evaluate(`document.querySelector('#messages > .session-msg.sent > summary')?.innerText.trim()`)) === 'Messaging stars…');
    await app.click('.approval .split-btn .more');
    await app.waitFor(`Boolean(document.querySelector('.popover [role="menuitem"]'))`, 5_000, 'the scope menu');
    const items = await app.evaluate(`[...document.querySelectorAll('.popover [role="menuitem"]')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim())`);
    check('the menu offers only "Allow messages to "stars" for this session" (no project answer)', items.length === 1 && items[0].startsWith('Allow messages to "stars" for this session'), items);
    await app.screenshot(path.join(shots, '1-card-menu.png'));
    await app.evaluate(`[...document.querySelectorAll('.popover [role="menuitem"]')].find((b) => /Allow messages to "stars" for this session/.test(b.innerText)).click()`);
    await app.waitFor(`!document.querySelector('.approval')`, 10_000, 'the card to go');

    // ---- B runs and replies; A finishes its turn ----
    await app.waitFor(`[...document.querySelectorAll('.msg.assistant')].some((e) => e.innerText.includes('I asked stars to count the lines.'))`, 30_000, "A's reply");
    await app.waitFor(nothingRuns, 30_000, 'both sessions to finish');
    await sleep(600);
    const bTranscript = await app.evaluate(`oc.rpc('sessions.transcript', ${q(B)})`);
    check("B's run started on the message and B replied", bTranscript.some((i) => i.role === 'user' && i.origin === 'session' && i.from === A && i.text.includes(MESSAGE)) && bTranscript.some((i) => i.role === 'assistant' && i.text === REPLY_B), bTranscript.map((i) => [i.role, (i.text ?? i.name ?? '').slice(0, 60)]));

    // ---- A's transcript: the "Messaged stars" line ----
    const sent = await app.evaluate(`(() => {
      const el = document.querySelector('#messages .session-msg.sent');
      if (!el) return null;
      const link = el.querySelector(':scope > summary .session-msg-link');
      return { top: el.parentElement.id === 'messages', inGroup: Boolean(el.closest('.tool-group')), summary: el.querySelector(':scope > summary').innerText.trim(), link: link?.textContent, to: link?.dataset.session, before: el.previousElementSibling?.className ?? '', count: document.querySelectorAll('#messages .session-msg.sent').length };
    })()`);
    check('A shows one "Messaged stars" line', sent && sent.count === 1 && sent.summary === 'Messaged stars', sent);
    check('… with "stars" linked to B', sent && sent.link === 'stars' && sent.to === B, sent);
    check('… on its own, not folded with the listing before it (Summary)', sent && sent.top && !sent.inGroup && /tool-group/.test(sent.before), sent);
    const lineStyle = await app.evaluate(`(() => {
      const s = getComputedStyle(document.querySelector('#messages .session-msg.sent > summary'));
      const g = getComputedStyle(document.querySelector('#messages > .tool-group > summary'));
      const k = ['height', 'fontSize', 'lineHeight', 'color', 'paddingLeft'];
      return { sent: k.map((x) => s[x]), group: k.map((x) => g[x]) };
    })()`);
    check('the line is measured like the folded tool line (height, size, line height, colour, inset)', JSON.stringify(lineStyle.sent) === JSON.stringify(lineStyle.group), lineStyle);
    await app.evaluate(`document.querySelector('#messages .session-msg.sent > summary').click()`);
    await sleep(200);
    const opened = await app.evaluate(`(() => { const el = document.querySelector('#messages .session-msg.sent'); return { open: el.open, md: el.querySelector('.session-msg-body .md')?.innerText.trim(), strong: el.querySelector('.session-msg-body .md strong')?.innerText, note: el.querySelector('.session-msg-note')?.innerText.trim(), decision: el.querySelector('.tool-decision')?.innerText.trim() }; })()`);
    check('opened: the message (as Markdown) and how it was delivered, in muted small text', opened.open && opened.md === MESSAGE.replace(/\*\*/g, '') && opened.strong === 'Only the number' && opened.note === 'Delivered: it started a run on it.', opened);
    check('opened: the answer to the card', opened.decision === 'Allowed messages to "stars" for this session', opened.decision);
    check('B has the unread mark in the sidebar while A is on screen', await app.evaluate(`Boolean(document.querySelector('.session-item[data-id=${q(B)}] .status-dot.unread'))`));
    await shot('2-messaged-row', '#messages .session-msg.sent');
    // Every call: still a line of its own
    await app.evaluate(`(async () => { const c = await oc.getConfig(); await oc.setConfig({ ...c, toolActivity: 'all' }); })()`);
    await app.waitFor(`!document.querySelector('#messages > .tool-group')`, 5_000, 'the listing to unfold (Every call)');
    check('… and in Every call too', await app.evaluate(`(() => { const el = document.querySelector('#messages .session-msg.sent'); return el.parentElement.id === 'messages' && !el.closest('.tool-group'); })()`));
    await app.evaluate(`(async () => { const c = await oc.getConfig(); await oc.setConfig({ ...c, toolActivity: 'summary' }); })()`);
    await app.waitFor(`Boolean(document.querySelector('#messages > .tool-group'))`, 5_000, 'the listing to fold again');

    // ---- the name opens B; B's transcript: "Received message from Release notes", then B's reply ----
    await app.evaluate(`document.querySelector('#messages .session-msg.sent .session-msg-link').click()`);
    await app.waitFor(`(async () => (await oc.sessions.current()).id === ${q(B)})()`, 10_000, 'B on screen');
    await app.waitFor(`Boolean(document.querySelector('#messages .session-msg.received'))`, 10_000, "B's received line");
    await sleep(300);
    const recv = await app.evaluate(`(() => {
      const el = document.querySelector('#messages .session-msg.received');
      const sum = el.querySelector('.session-msg-line > summary');
      const link = sum.querySelector('.session-msg-link');
      const next = el.nextElementSibling;
      return { cls: el.className, summary: sum.innerText.trim(), link: link?.textContent, from: link?.dataset.session, open: el.querySelector('.session-msg-line').open, next: next?.className, nextText: next?.innerText.trim(), turn: el.dataset.turn, bubble: Boolean(el.querySelector('.bubble')), frame: /\\[Message from|Not from the user|session_send/.test(el.innerText) };
    })()`);
    check('B shows "Received message from Release notes", shut', recv.summary === 'Received message from Release notes' && recv.open === false && !recv.bubble, recv);
    check('… with A linked', recv.link === 'Release notes' && recv.from === A, recv);
    check("… followed by B's reply", /msg assistant/.test(recv.next) && recv.nextText === REPLY_B, recv);
    check('… still a user message with its checkpoint (Rewind), and no frame on screen', /\bmsg\b/.test(recv.cls) && /\buser\b/.test(recv.cls) && recv.turn !== undefined && !recv.frame, recv);
    check('the unread mark went when B came on screen', !(await app.evaluate(`Boolean(document.querySelector('.session-item[data-id=${q(B)}] .status-dot.unread'))`)));
    await app.evaluate(`document.querySelector('#messages .session-msg.received .session-msg-line > summary').click()`);
    await sleep(200);
    const body = await app.evaluate(`(() => { const el = document.querySelector('#messages .session-msg.received'); return { open: el.querySelector('.session-msg-line').open, md: el.querySelector('.session-msg-body .md')?.innerText.trim(), strong: el.querySelector('.session-msg-body .md strong')?.innerText }; })()`);
    check('opened: the message, as Markdown', body.open && body.md === MESSAGE.replace(/\*\*/g, '') && body.strong === 'Only the number', body);
    // Copy (on hover) copies the message, not the frame; the page's clipboard is stubbed so the Mac's stays untouched
    await app.evaluate(`(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; document.querySelector('#messages .session-msg.received .msg-copy').click(); })()`);
    await sleep(200);
    check('Copy copies the message without its frame', (await app.evaluate(`window.__copied`)) === MESSAGE, await app.evaluate(`window.__copied`));
    await shot('3-received-row', '#messages .session-msg.received', 24);
    await app.evaluate(`document.querySelector('#messages .session-msg.received').scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await app.screenshot(path.join(shots, '4-receiver-window.png'));
    // The name opens A
    await app.evaluate(`document.querySelector('#messages .session-msg.received .session-msg-link').click()`);
    await app.waitFor(`(async () => (await oc.sessions.current()).id === ${q(A)})()`, 10_000, 'A on screen again');
    check('the sender\'s name opens the sender', true);
    await app.waitFor(`Boolean(document.querySelector('#messages .session-msg.sent'))`, 10_000, "A's sent line after the switch");
    await sleep(400);
    check('A rendered from its stored transcript still shows "Messaged stars" linked', (await app.evaluate(`document.querySelector('#messages .session-msg.sent > summary').innerText.trim()`)) === 'Messaged stars' && (await app.evaluate(`document.querySelector('#messages .session-msg.sent .session-msg-link')?.dataset.session`)) === B);
    await app.screenshot(path.join(shots, '5-sender-window.png'));

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
