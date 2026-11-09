// Live check of Auto mode's safety check in the real window, with the mock model scripted for the agent and for the
// check: a blocked command shows one quiet line ("Auto mode blocked … · Allow") and no card, the call's row gives way
// to it, and the agent reads the reason; Allow lets the command run once when the agent tries it again, and Settings →
// Permissions → Recently blocked lists it; after three blocks in a row Auto mode pauses and the card comes back.
// Run: npm run build && node test/live/auto-mode.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');
const { classifierReply, isClassifierRequest } = require('../support/mock-model.js');

const { check, done } = checker();

const lastMsg = (p) => p.messages?.[p.messages.length - 1];
const afterTool = (p) => lastMsg(p)?.role === 'tool';
const userSays = (text) => (p) => {
  const m = lastMsg(p);
  return m?.role === 'user' && JSON.stringify(m.content).includes(text);
};

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-auto-'));
  fs.mkdirSync(shots, { recursive: true });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-auto-project-'));
  const app = await launch({ mode: 'auto', mock: true, project, size: { width: 1200, height: 860 } });
  const replies = app.mock.state.replies;
  const requests = app.mock.state.requests;
  const checks = () => requests.filter((r) => isClassifierRequest(r.payload)).length;
  const toolResult = (id) => requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content;
  const theme = (t) => app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(t)}`);
  const both = async (name, selector) => {
    for (const t of ['light', 'dark']) {
      await theme(t);
      await sleep(250);
      await app.screenshotOf(path.join(shots, `${name}-${t}.png`), selector, 24);
    }
    await theme('light');
  };
  const lines = () =>
    app.evaluate(`[...document.querySelectorAll('#messages .auto-blocked')].map((e) => ({ text: e.innerText.replace(/\\s+/g, ' ').trim(), tip: e.querySelector('.auto-blocked-words')?.dataset.tip ?? '', allow: Boolean(e.querySelector('.auto-blocked-allow')), shown: Boolean(e.offsetParent) }))`);
  const visibleRows = (needle) => app.evaluate(`[...document.querySelectorAll('#messages .tool')].filter((e) => !e.hidden && e.offsetParent && e.textContent.includes(${JSON.stringify(needle)})).length`);
  try {
    if (await app.evaluate(`!document.querySelector('.shell').classList.contains('pane-hidden')`)) await app.click('#pane-close');

    // ---------- 1. A blocked command: one quiet line, no card ----------
    replies.push({ content: '', toolCalls: [{ id: 'a1', name: 'bash', args: { command: 'touch blocked.txt', description: 'Create the file' } }], when: userSays('Make blocked.txt') });
    replies.push(classifierReply('block', '[User Boundary] the user said not to create files'));
    replies.push({ content: 'Auto mode blocked it, so I left it.', when: afterTool });
    await app.send('Make blocked.txt, but no new files.');
    await app.waitIdle(30_000);
    let l = await lines();
    check('block: one quiet line with the command and Allow', l.length === 1 && l[0].text === 'Auto mode blocked touch blocked.txt · Allow' && l[0].allow && l[0].shown, l);
    check('block: the reason is the line\'s tooltip', l[0]?.tip === '[User Boundary] the user said not to create files', l[0]);
    check('block: no approval card, and the call\'s row gave way', !(await app.exists('.approval')) && (await visibleRows('blocked.txt')) === 0);
    check('block: nothing ran, the agent read the reason', !fs.existsSync(path.join(project, 'blocked.txt')) && /^Blocked by Auto mode: \[User Boundary\] the user said not to create files\. Do not try to get around it/.test(toolResult('a1') ?? ''), toolResult('a1'));
    await both('auto-blocked-line', '#messages .auto-blocked');

    // ---------- 2. Allow: the agent is told, and its retry runs once without the check ----------
    await app.click('.auto-blocked-allow');
    await app.waitFor(`document.querySelector('#messages .auto-blocked')?.innerText.includes('Allowed')`, 5000, 'the line to say Allowed');
    l = await lines();
    check('Allow: the line says Allowed', l[0]?.text === 'Auto mode blocked touch blocked.txt · Allowed' && !l[0].allow, l);
    const before = checks();
    replies.push({ content: '', toolCalls: [{ id: 'a2', name: 'bash', args: { command: 'touch blocked.txt' } }], when: userSays('Go ahead') });
    replies.push({ content: 'Made it.', when: afterTool });
    await app.send('Go ahead.');
    await app.waitIdle(30_000);
    check('Allow: the retry ran, without the check', fs.existsSync(path.join(project, 'blocked.txt')) && checks() === before, { checks: checks(), before });
    check('Allow: the model was told before it retried', requests.some((r) => r.payload.stream && JSON.stringify(r.payload.messages).includes('[Auto mode] The user allowed an action Auto mode blocked: touch blocked.txt')));
    check('Allow: the note is not shown as a message', !(await app.evaluate(`[...document.querySelectorAll('#messages .msg.user')].some((e) => e.innerText.includes('[Auto mode]'))`)));

    // Settings → Permissions → Recently blocked
    await app.evaluate(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-permissions')?.click(); })()`);
    await app.waitFor(`Boolean(document.querySelector('.auto-blocked-list .sp-row'))`, 10_000, 'the Recently blocked list');
    const listed = await app.evaluate(`[...document.querySelectorAll('.auto-blocked-list .sp-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`);
    check('Settings: Recently blocked lists it, allowed', listed.length === 1 && listed[0].includes('touch blocked.txt') && listed[0].includes('[User Boundary]') && listed[0].includes('Allowed'), listed);
    await both('auto-recently-blocked', '#sp-row-auto-blocked-0');
    await app.key('Escape');
    await app.waitFor(`!document.querySelector('#settings').open`, 5000, 'Settings to close');

    // A switch away and back: the stored line still knows it was allowed
    const firstId = await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id`, 10_000, 'the session in the sidebar');
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('#empty-state') && !document.querySelector('#empty-state').hidden`, 10_000, 'the new session');
    await app.click(`.session-item[data-id="${firstId}"]`);
    await app.waitFor(`Boolean(document.querySelector('#messages .auto-blocked'))`, 10_000, 'the stored line');
    await app.waitFor(`document.querySelector('#messages .auto-blocked')?.innerText.includes('Allowed')`, 5000, 'the stored line to know it was allowed').catch(() => undefined);
    l = await lines();
    check('stored: the line comes back from the transcript, still Allowed', l.length === 1 && l[0].text === 'Auto mode blocked touch blocked.txt · Allowed', l);

    // ---------- 3. Three blocks in a row pause Auto mode: the card comes back ----------
    replies.push({
      content: '',
      toolCalls: ['p1', 'p2', 'p3', 'p4'].map((n) => ({ id: `c_${n}`, name: 'bash', args: { command: `touch ${n}.txt` } })),
      when: userSays('Make four files'),
    });
    replies.push(classifierReply('block', '[Other] first'));
    replies.push(classifierReply('block', '[Other] second'));
    replies.push(classifierReply('block', '[Other] third'));
    replies.push({ content: 'Stopped.', when: afterTool });
    const beforePause = checks();
    await app.send('Make four files.');
    await app.waitFor(`Boolean(document.querySelector('.approval.prompt-card .btn.primary'))`, 30_000, 'the card after the pause');
    const pause = await app.evaluate(`({ notice: [...document.querySelectorAll('#messages .msg.system')].map((e) => e.innerText.trim()).find((t) => /paused/.test(t)) ?? '', blocked: document.querySelectorAll('#messages .auto-blocked').length, card: document.querySelector('.approval.prompt-card')?.innerText ?? '' })`);
    check('pause: three blocks, then a one-line notice', pause.blocked === 4 && pause.notice === 'Auto mode paused after 3 blocks in a row: actions ask again.', pause);
    check('pause: the fourth action shows the approval card, without a check', /touch p4\.txt/.test(pause.card) && checks() === beforePause + 3, { card: pause.card, checks: checks() - beforePause });
    await app.screenshot(path.join(shots, 'auto-paused.png'));
    await app.approve('deny');
    await app.waitIdle(30_000);
    check('pause: nothing ran', !['p1', 'p2', 'p3', 'p4'].some((n) => fs.existsSync(path.join(project, `${n}.txt`))));

    const errors = app.console.filter((x) => /^\[(error|exception)\]/.test(x));
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
