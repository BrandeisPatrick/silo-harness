// Live check of the question card (ask_user) and the approval card's keys in the real window, with the mock model
// scripted to call ask_user and bash. The question card: its parts and names, a click and the number keys pick, ⌘↵
// submits, "Other" takes the user's own words, Esc skips, several questions go one at a time (Next, Back, checkboxes),
// Plan mode asks too, and a card survives a switch to another session and back; each answer reaches the model as the
// tool's result, and the answered call folds to one line ("Asked a question") with the answers inside. The approval
// card: the description and the Auto-mode note in muted text, Deny and "Allow once ⌘↵" with ⌄ for the scopes (A, P),
// ⌘↵ allows once, Esc denies, and the decision lands in the call's row instead of a line of its own.
// Run: npm run build && node test/live/questions.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');
const { askUserReply } = require('../support/mock-model.js');

const { check, done } = checker();

const LIB = { question: 'Which chart library should the dashboard use?', header: 'Library', options: [{ label: 'Chart.js (Recommended)', description: 'Small and canvas-based; enough for bars and lines' }, { label: 'D3', description: 'Anything is possible, at the cost of more code' }, { label: 'Recharts', description: 'React components, if the dashboard moves to React' }], multiSelect: false };
const FEAT = { question: 'Which features should ship first?', header: 'Features', options: [{ label: 'Export', description: 'CSV and PNG downloads' }, { label: 'Filters', description: 'By date range and team' }, { label: 'Sharing', description: 'A read-only link' }], multiSelect: true };
const WHEN = { question: 'When should the numbers refresh?', header: 'Refresh', options: [{ label: 'Every minute', description: 'Live, more load' }, { label: 'Every hour', description: 'Cheap; fine for reviews' }], multiSelect: false };

const afterTool = (p) => p.messages?.[p.messages.length - 1]?.role === 'tool';

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-questions-'));
  fs.mkdirSync(shots, { recursive: true });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-questions-project-'));
  const app = await launch({ mode: 'ask', mock: true, project, size: { width: 1200, height: 860 } });
  const replies = app.mock.state.replies;
  const requests = app.mock.state.requests;
  /** The last tool result the model was sent */
  const lastTool = () => requests.flatMap((r) => r.payload.messages ?? []).filter((m) => m.role === 'tool').pop()?.content;
  const setConfig = (patch) => app.evaluate(`(async () => { const c = await window.oc.getConfig(); await window.oc.setConfig({ ...c, ...${JSON.stringify(patch)} }); })()`);
  const theme = (t) => app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(t)}`);
  const both = async (name, selector) => {
    for (const t of ['light', 'dark']) {
      await theme(t);
      await sleep(250);
      await app.screenshotOf(path.join(shots, `${name}-${t}.png`), selector, 24);
    }
    await theme('light');
  };
  const card = () => app.waitFor(`Boolean(document.querySelector('.question-card'))`, 20_000, 'the question card');
  const gone = () => app.waitFor(`!document.querySelector('.question-card')`, 10_000, 'the card to go');
  const opts = `[...document.querySelectorAll('.question-card .q-option')]`;
  const checked = () => app.evaluate(`${opts}.map((o) => o.getAttribute('aria-checked') === 'true')`);
  /** The newest folded line, and the row inside it */
  const lastLine = () =>
    app.evaluate(`(() => {
      const g = [...document.querySelectorAll('#messages > .tool-group')].pop();
      if (!g) return null;
      const row = g.querySelector(':scope > .group-body > .tool');
      const t = (e, s) => (e?.querySelector(s)?.textContent ?? '').replace(/\\s+/g, ' ').trim();
      return { words: t(g, ':scope > summary .group-verb'), meta: t(g, ':scope > summary .group-meta'), rows: g.querySelectorAll(':scope > .group-body > .tool').length, verb: t(row, '.tool-verb'), arg: t(row, '.tool-arg'), rowMeta: t(row, '.tool-meta'), body: t(row, '.tool-body'), decision: t(row, '.tool-decision'), open: g.open, rowOpen: row?.open };
    })()`);
  try {
    if (await app.evaluate(`!document.querySelector('.shell').classList.contains('pane-hidden')`)) await app.click('#pane-toggle');

    // ---------- 1. One question: a click picks, a number key picks, ⌘↵ submits ----------
    replies.push(askUserReply([LIB]));
    replies.push({ content: 'Chart.js it is.', when: afterTool });
    await app.send('Plan the dashboard charts.');
    await card();
    await sleep(200);
    const look = await app.evaluate(`(() => {
      const c = document.querySelector('.question-card');
      return {
        title: c.querySelector('.prompt-head .title').textContent,
        chip: c.querySelector('.q-chip').textContent,
        labels: [...c.querySelectorAll('.q-option .q-label')].map((e) => e.textContent),
        roles: [...c.querySelectorAll('.q-option')].map((o) => o.getAttribute('role')),
        group: c.querySelector('.q-options').getAttribute('role'),
        labelled: document.getElementById(c.getAttribute('aria-labelledby'))?.textContent,
        buttons: [...c.querySelectorAll('.prompt-foot button')].filter((b) => !b.hidden).map((b) => b.getAttribute('aria-label') || b.textContent.trim()),
        keys: c.querySelector('.submit .keys')?.getAttribute('aria-hidden'),
        submitDisabled: c.querySelector('.submit').disabled,
        status: document.querySelector('#status-text')?.textContent,
        focus: document.activeElement?.classList.contains('q-option') && c.contains(document.activeElement),
        radius: getComputedStyle(c).borderTopLeftRadius,
      };
    })()`);
    look.attention = await app.evaluate(`(async () => (await oc.sessions.list()).find((m) => m.status?.running)?.status?.attention)()`);
    check('the card: the question in the header band, its header as a chip', look.title === LIB.question && look.chip === 'Library', look);
    check('…the options as radio rows in a radio group, then Other', look.labels.join('|') === 'Chart.js (Recommended)|D3|Recharts|Other' && look.roles.every((r) => r === 'radio') && look.group === 'radiogroup', look);
    check('…named by its question for screen readers', look.labelled === LIB.question);
    check('…Skip and Submit (keycaps hidden from screen readers); Submit waits for a choice', look.buttons.join('|') === 'Skip|Submit' && look.keys === 'true' && look.submitDisabled, look);
    check('…in the approval card\'s frame (12px corners)', look.radius === '12px', look.radius);
    check('the status line says it waits for your answer', /Waiting for your answer/.test(look.status), look.status);
    check('the keyboard moves into the card', look.focus);
    check('the session waits for the user ("question", for the Dock badge and the phone)', look.attention === 'question', look.attention);
    await both('question-one', '.question-card');
    await app.evaluate(`${opts}[1].querySelector('.q-desc').click()`);
    check('a click anywhere on a row picks it', JSON.stringify(await checked()) === '[false,true,false,false]' && !(await app.evaluate(`document.querySelector('.question-card .submit').disabled`)));
    await app.key('1');
    check('the number keys pick (1 is the first option), one at a time', JSON.stringify(await checked()) === '[true,false,false,false]', await checked());
    await app.key('ArrowDown');
    check('↓ moves to the next row', await app.evaluate(`document.activeElement === ${opts}[1]`));
    await app.key('Enter', { meta: true });
    await gone();
    await app.waitIdle(30_000);
    check('⌘↵ sent the answer: the model read the header and the label', lastTool() === 'The user answered your question:\n- Library: Chart.js (Recommended)', lastTool());
    let line = await lastLine();
    check('answered, the call folds to one line: "Asked a question"', line && line.words === 'Asked a question' && line.rows === 1 && !line.open, line);
    check('…its row: the question, "answered", and the answer inside', line && line.verb === 'Question' && line.arg === LIB.question && line.rowMeta === 'answered' && line.body === 'Chart.js (Recommended)', line);
    await app.evaluate(`[...document.querySelectorAll('#messages > .tool-group')].pop().querySelector(':scope > summary').click()`);
    line = await lastLine();
    check('opening the line opens the call\'s row with it', line.open && line.rowOpen, line);
    check('the status line is back to the run, then off', await app.evaluate(`document.querySelector('#status-line').hidden`));

    // ---------- 2. Other: the user's own words replace the options ----------
    replies.push(askUserReply([LIB]));
    replies.push({ content: 'Recharts then.', when: afterTool });
    await app.send('Ask me again.');
    await card();
    await app.evaluate(`${opts}[0].click()`);
    await app.fill('.question-card .q-other', 'Recharts, with a dark theme');
    check('typing under Other picks Other instead of the option', JSON.stringify(await checked()) === '[false,false,false,true]', await checked());
    await app.key('Enter');
    await gone();
    await app.waitIdle(30_000);
    check('Enter in the field sends it: the model reads the user\'s own words', lastTool() === 'The user answered your question:\n- Library: in their own words: "Recharts, with a dark theme"', lastTool());
    line = await lastLine();
    check('…and the row shows them in quotes', line.body === '“Recharts, with a dark theme”', line.body);

    // ---------- 3. Esc skips ----------
    replies.push(askUserReply([LIB]));
    replies.push({ content: 'I will go with Chart.js.', when: afterTool });
    await app.send('Ask once more.');
    await card();
    await app.key('Escape');
    await gone();
    await app.waitIdle(30_000);
    check('Esc skips: the model reads "The user skipped the question." and the run goes on', lastTool() === 'The user skipped the question.' && /Chart\.js/.test(await app.lastReply()), lastTool());
    line = await lastLine();
    check('…the row says skipped', line.rowMeta === 'skipped' && /Skipped/.test(line.body), line);

    // ---------- 4. Several questions: one at a time, Next and Back, checkboxes ----------
    replies.push(askUserReply([LIB, FEAT, WHEN]));
    replies.push({ content: 'D3, export and filters, hourly.', when: afterTool });
    await app.send('Settle the details.');
    await card();
    const chip = () => app.evaluate(`document.querySelector('.question-card .q-chip').textContent`);
    const primary = () => app.evaluate(`document.querySelector('.question-card .submit').getAttribute('aria-label')`);
    check('several: the chip counts ("1 of 3"), the button says Next, no Back yet', (await chip()) === 'Library · 1 of 3' && (await primary()) === 'Next' && (await app.evaluate(`document.querySelector('.question-card .back').hidden`)), [await chip(), await primary()]);
    await app.evaluate(`${opts}[1].click()`);
    await app.evaluate(`document.querySelector('.question-card .submit').click()`);
    const second = await app.evaluate(`(() => { const c = document.querySelector('.question-card'); return { title: c.querySelector('.title').textContent, roles: [...c.querySelectorAll('.q-option')].map((o) => o.getAttribute('role')), group: c.querySelector('.q-options').getAttribute('role') }; })()`);
    check('Next: the second question, its options checkboxes in a group', second.title === FEAT.question && second.roles.every((r) => r === 'checkbox') && second.group === 'group' && (await chip()) === 'Features · 2 of 3', second);
    await app.evaluate(`${opts}[0].click()`);
    await app.evaluate(`${opts}[1].click()`);
    await app.fill('.question-card .q-other', 'A dark theme');
    check('several options and Other can be on together', JSON.stringify(await checked()) === '[true,true,false,true]', await checked());
    await both('question-several', '.question-card');
    await app.evaluate(`document.querySelector('.question-card .back').click()`);
    check('Back returns to the first question with its answer kept', (await chip()) === 'Library · 1 of 3' && JSON.stringify(await checked()) === '[false,true,false,false]', await checked());
    await app.key('Enter', { meta: true });
    check('…and the second still has its answers', JSON.stringify(await checked()) === '[true,true,false,true]' && (await app.evaluate(`document.querySelector('.question-card .q-other').value`)) === 'A dark theme');
    await app.key('Enter', { meta: true });
    check('the last question: the button says Submit', (await chip()) === 'Refresh · 3 of 3' && (await primary()) === 'Submit');
    await app.key('2');
    await app.key('Enter', { meta: true });
    await gone();
    await app.waitIdle(30_000);
    check('the answers reach the model together, one line per header', lastTool() === 'The user answered your questions:\n- Library: D3\n- Features: Export, Filters, and in their own words: "A dark theme"\n- Refresh: Every hour', lastTool());
    line = await lastLine();
    check('…the row names the headers and holds each question with its answer', line.verb === 'Questions' && line.arg === 'Library, Features, Refresh' && /Which features should ship first\?\s*Export, Filters, “A dark theme”/.test(line.body), line);

    // ---------- 5. Plan mode asks too, and a card survives a switch to another session ----------
    await setConfig({ permissionMode: 'plan' });
    await app.waitFor(`document.querySelector('#mode-btn').dataset.mode === 'plan'`, 5000, 'plan mode');
    replies.push(askUserReply([WHEN]));
    replies.push({ content: 'Hourly, noted for the plan.', when: afterTool });
    await app.send('Plan the refresh.');
    await card();
    const id = await app.evaluate(`document.querySelector('.session-item.active')?.dataset.id`);
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id !== ${JSON.stringify(id)} && !document.querySelector('.question-card')`, 10_000, 'another session');
    await app.click(`.session-item[data-id=${JSON.stringify(id)}]`);
    await card();
    check('in Plan mode the card shows, and comes back with its session', (await app.evaluate(`document.querySelector('.question-card .title').textContent`)) === WHEN.question);
    await app.evaluate(`${opts}[1].click()`);
    await app.evaluate(`document.querySelector('.question-card .submit').click()`);
    await gone();
    await app.waitIdle(30_000);
    check('…and the answer arrives', lastTool() === 'The user answered your question:\n- Refresh: Every hour', lastTool());
    await setConfig({ permissionMode: 'ask' });
    await app.waitFor(`document.querySelector('#mode-btn').dataset.mode === 'ask'`, 5000, 'ask mode');

    // ---------- 6. The approval card: its parts, the scope menu, Esc denies, ⌘↵ allows once, A for the session ----------
    replies.push({ content: '', toolCalls: [{ id: 'b1', name: 'bash', args: { command: 'touch a.txt', description: 'Create an empty file named a.txt' } }] });
    replies.push({ content: 'Not made, as you said.', when: afterTool });
    await app.send('Make a.txt.');
    await app.waitFor(`Boolean(document.querySelector('.approval.prompt-card .btn.primary'))`, 20_000, 'the approval card');
    await sleep(200);
    const ap = await app.evaluate(`(() => {
      const c = document.querySelector('.approval.prompt-card');
      const btns = [...c.querySelectorAll('.prompt-foot button')];
      return {
        title: c.querySelector('.prompt-head .title').textContent,
        texts: [...c.querySelectorAll('.prompt-text')].map((e) => e.textContent),
        cmd: c.querySelector('.cmd')?.textContent.replace(/\\s+/g, ' ').trim(),
        names: btns.map((b) => b.getAttribute('aria-label') || b.textContent.trim()),
        shortcuts: btns.map((b) => b.getAttribute('aria-keyshortcuts')),
        keycaps: [...c.querySelectorAll('.allow kbd')].map((k) => k.textContent).join(''),
        icon: Boolean(c.querySelector('.approval-icon, .reason')),
        labelled: document.getElementById(c.getAttribute('aria-labelledby'))?.textContent,
        allowBg: getComputedStyle(c.querySelector('.split-btn')).backgroundColor,
        denyBg: getComputedStyle(c.querySelector('.deny')).backgroundColor,
        text100: (() => { const p = document.createElement('span'); p.style.color = 'var(--text-100)'; document.body.append(p); const v = getComputedStyle(p).color; p.remove(); return v; })(),
      };
    })()`);
    check('approval: the title in the band, the call\'s own description in muted text, the command', ap.title === 'Run this command?' && ap.texts.join('|') === 'Create an empty file named a.txt' && ap.cmd === '$touch a.txt', ap);
    check('…Deny, then "Allow once ⌘↵" with ⌄ for more; no icon tile', ap.names.join('|') === 'Deny|Allow once|More ways to allow' && ap.keycaps === '⌘↵' && !ap.icon, ap);
    check('…the keys are named for screen readers, and the card by its title', ap.shortcuts.join('|') === 'Escape|Meta+Enter|' && ap.labelled === ap.title, ap.shortcuts);
    check('…Allow once is inverted (the text colour as its fill)', ap.allowBg === ap.text100 && ap.denyBg !== ap.allowBg, [ap.allowBg, ap.text100, ap.denyBg]);
    await app.evaluate(`document.querySelector('.approval.prompt-card .more').click()`);
    await sleep(200);
    const menu = await app.evaluate(`[...document.querySelectorAll('.popover .pop-item')].map((b) => b.querySelector('.pop-title').textContent + ' [' + (b.querySelector('.pop-hint')?.textContent ?? '') + ']')`);
    check('⌄ opens the wider scopes with their keys', menu.join('|') === 'Allow touch for this session [A]|Always allow touch in this project [P]', menu);
    check('…and says it is open', (await app.evaluate(`document.querySelector('.approval.prompt-card .more').getAttribute('aria-expanded')`)) === 'true');
    await app.key('Escape');
    await sleep(150);
    check('Esc closes the menu first; the card still waits', !(await app.exists('.popover')) && (await app.exists('.approval.prompt-card')));
    await app.evaluate(`document.getElementById('input').focus()`);
    await app.key('Escape');
    await app.waitFor(`!document.querySelector('.approval.prompt-card')`, 10_000, 'the card to go');
    await app.waitIdle(30_000);
    check('Esc denied it (the run went on): the command did not run', !fs.existsSync(path.join(project, 'a.txt')) && /Not made/.test(await app.lastReply()));
    line = await lastLine();
    check('…no line of its own: the call folds to "Denied a command", the row says Denied', line.words === 'Denied a command' && line.decision === 'Denied' && line.rowMeta.startsWith('denied') && !(await app.exists('.approval')), line);

    replies.push({ content: '', toolCalls: [{ id: 'b2', name: 'bash', args: { command: 'touch b.txt' } }] });
    replies.push({ content: 'Made b.txt.', when: afterTool });
    await app.send('Make b.txt.');
    await app.waitFor(`Boolean(document.querySelector('.approval.prompt-card .btn.primary'))`, 20_000, 'the second card');
    check('without a description the body is the command alone', (await app.count('.approval.prompt-card .prompt-text')) === 0);
    await app.key('Enter', { meta: true });
    await app.waitIdle(30_000);
    line = await lastLine();
    check('⌘↵ allowed it once: it ran, "Ran a command", "Allowed once" in its row', fs.existsSync(path.join(project, 'b.txt')) && line.words === 'Ran a command' && line.decision === 'Allowed once', line);

    replies.push({ content: '', toolCalls: [{ id: 'b3', name: 'bash', args: { command: 'touch c.txt' } }] });
    replies.push({ content: '', toolCalls: [{ id: 'b4', name: 'bash', args: { command: 'touch d.txt' } }], when: afterTool });
    replies.push({ content: 'Made c and d.', when: afterTool });
    await app.send('Make c.txt and d.txt.');
    await app.waitFor(`Boolean(document.querySelector('.approval.prompt-card .btn.primary'))`, 20_000, 'the third card');
    await app.evaluate(`document.getElementById('input').focus()`);
    await app.key('a');
    await app.waitIdle(30_000);
    line = await lastLine();
    check('A allowed touch for the session: the second touch ran without a card', fs.existsSync(path.join(project, 'c.txt')) && fs.existsSync(path.join(project, 'd.txt')) && line.words === 'Ran 2 commands' && line.decision === 'Allowed touch for this session' && (await app.evaluate(`document.getElementById('input').value`)) === '', line);

    // ---------- 7. Auto mode: why it stopped, as a muted note (sudo asks even in Auto mode) ----------
    await setConfig({ permissionMode: 'auto' });
    await app.waitFor(`document.querySelector('#mode-btn').dataset.mode === 'auto'`, 5000, 'auto mode');
    replies.push({ content: '', toolCalls: [{ id: 'b5', name: 'bash', args: { command: 'sudo -n true', description: 'Check for sudo access' } }] });
    replies.push({ content: 'Left it to you.', when: afterTool });
    await app.send('Check sudo.');
    await app.waitFor(`Boolean(document.querySelector('.approval.prompt-card .btn.primary'))`, 20_000, 'the paused card');
    const auto = await app.evaluate(`(() => { const c = document.querySelector('.approval.prompt-card'); return { texts: [...c.querySelectorAll('.prompt-text')].map((e) => e.textContent), color: getComputedStyle(c.querySelector('.prompt-note')).color, muted: (() => { const p = document.createElement('span'); p.style.color = 'var(--text-400)'; document.body.append(p); const v = getComputedStyle(p).color; p.remove(); return v; })(), svg: c.querySelectorAll('.prompt-body svg').length }; })()`);
    check('Auto mode: the card says why it stopped, muted, with no warning icon', auto.texts.join('|') === 'Check for sudo access|Auto mode stopped to ask: it uses sudo.' && auto.color === auto.muted && auto.svg === 0, auto);
    await both('approval-auto-paused', '.approval.prompt-card');
    await app.approve('deny');
    await app.waitIdle(30_000);
    await setConfig({ permissionMode: 'ask' });

    await app.evaluate(`document.getElementById('messages').scrollTop = 1e9`);
    await sleep(200);
    await app.screenshot(path.join(shots, 'transcript-folded.png'));
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
