// Live check of quiet tool activity in the real window, with the mock model scripted to make realistic turns on a
// small project: three reads, two edits, a failing and a passing command, a reply, then a search and a listing; an
// Ask-mode turn with a write that is allowed and a command that is denied; a turn with one call. In Summary (the
// default) each run of calls is one line with the expected words, the diff total and the failed and denied counts;
// it opens and closes with the mouse and the keyboard; while the turn runs the line reads like the call in flight;
// a waiting approval card stays in the open under the run and goes once decided, its answer kept in the call's row;
// a single call is one line too ("Read a file"), which opens straight to its row's details. Settings → General →
// Tool activity → Every call shows the rows as they always were (only the three reads fold, as before), and Summary
// folds them again. Opening the session again folds it the same way, also after a rewind and after /compact.
// Screenshots: folded (light and dark), one group open, the live line, a waiting card, the Settings row.
// Run: npm run build && node test/live/quiet.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const { check, done } = checker();
let seq = 0;
const call = (name, args) => ({ id: `call_q${++seq}`, name, args });

const FILES = {
  'src/cart.js': "export function total(items) {\n  return items.reduce((sum, i) => sum + i.price, 0);\n}\n",
  'src/discount.js': "export function discount(total, code) {\n  return code === 'SAVE10' ? total * 0.9 : total;\n}\n",
  'test/cart.test.js': "import { total } from '../src/cart.js';\n// total([{ price: 2, qty: 3 }]) should be 6\n",
};

/** The folded lines on screen: words, the right-hand counts, and how many rows each holds */
const GROUPS = `[...document.querySelectorAll('#messages > .tool-group')].map((g) => ({
  words: g.querySelector(':scope > summary > .group-verb').textContent,
  meta: g.querySelector(':scope > summary > .group-meta').textContent.replace(/\\s+/g, ' ').trim(),
  rows: g.querySelectorAll(':scope > .group-body > .tool').length,
  decided: g.querySelectorAll(':scope > .group-body > .tool .tool-decision').length,
  live: g.classList.contains('live'),
}))`;
/** What the conversation is made of, top level: one letter per thing (u user, a reply, g group, t row, d decided approval line, c card) */
// (The "Worked for …" header over a turn is checked in chat-fold.js and left out here.)
const SHAPE = `[...document.querySelectorAll('#messages > *')].filter((e) => e.id !== 'empty-state' && !e.hidden && !e.matches('.turn-head')).map((e) => e.matches('.msg.user') ? 'u' : e.matches('.msg.assistant') ? 'a' : e.matches('.tool-group') ? 'g' : e.matches('.tool') ? 't' : e.matches('.approval.done') ? 'd' : e.matches('.approval') ? 'c' : e.matches('.compaction') ? '=' : e.matches('.msg.system') ? 's' : e.matches('.chat-cards') ? 'k' : '?').join('')`;

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-quiet-'));
  fs.mkdirSync(shots, { recursive: true });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-quiet-project-'));
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
  }
  const app = await launch({ mode: 'bypass', mock: true, project, scale: 1 });
  const reply = (r) => app.mock.state.replies.push(r);
  const groups = () => app.evaluate(GROUPS);
  const shape = () => app.evaluate(SHAPE);
  const theme = (t) => app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(t)}`);
  const setConfig = (patch) => app.evaluate(`(async () => { const c = await window.oc.getConfig(); await window.oc.setConfig({ ...c, ...${JSON.stringify(patch)} }); })()`);
  const idle = () => app.waitFor(`document.querySelector('#status-line').hidden && !document.querySelector('.session-item.running')`, 60_000, 'the run to end');
  const shot = async (name) => {
    await sleep(250);
    await app.screenshot(path.join(shots, `${name}.png`));
  };
  try {
    await theme('light');
    // The reading column on its own, as a user reading a long session would have it
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.hello).length >= 5`, 20_000, 'the rail to start').catch(() => {});
    if (await app.evaluate(`!document.querySelector('.shell').classList.contains('pane-hidden')`)) await app.click('#pane-toggle');
    await app.evaluate(`(() => { const b = document.querySelector('#rail-toggle'); if (b && !b.hidden && b.getAttribute('aria-pressed') === 'true') b.click(); })()`);

    // ---------- Turn 1: reads, edits, a failing and a passing command, a reply, a search and a listing ----------
    reply({ content: '', toolCalls: [call('read_file', { path: 'src/cart.js' }), call('read_file', { path: 'src/discount.js' }), call('read_file', { path: 'test/cart.test.js' })] });
    reply({
      content: '',
      toolCalls: [
        call('edit_file', { path: 'src/cart.js', old_string: '  return items.reduce((sum, i) => sum + i.price, 0);', new_string: '  // Each line counts its quantity (one when it has none)\n  return items.reduce((sum, i) => sum + i.price * (i.qty ?? 1), 0);' }),
        call('edit_file', { path: 'test/cart.test.js', old_string: '// total([{ price: 2, qty: 3 }]) should be 6', new_string: "console.assert(total([{ price: 2, qty: 3 }]) === 6, 'quantity');" }),
      ],
    });
    reply({ content: '', toolCalls: [call('bash', { command: 'node --test test/ 2>&1 | tail -3; exit 3' })] });
    reply({ content: '', delayMs: 300, toolCalls: [call('bash', { command: 'sleep 2.5; echo "# pass 4"' })] });
    reply({ content: 'The total now counts each line’s quantity, and the tests pass. Let me check nothing else sums prices the old way.', toolCalls: [call('grep', { pattern: 'i\\.price', path: 'src' }), call('list_directory', { path: 'src' })] });
    reply({ content: 'Only `cart.js` summed prices, so that was the one place to fix.' });
    await app.send('The cart total ignores quantities. Fix it and run the tests.');

    // While it runs: one live line that reads like the call in flight
    const live = await app.waitFor(`(() => { const g = document.querySelector('#messages > .tool-group.live'); const v = g?.querySelector('.group-verb').textContent; const a = g?.querySelector('.group-arg').textContent ?? ''; return v === 'Bash' && /sleep 2\\.5/.test(a) ? { v, a, spin: Boolean(g.querySelector(':scope > summary > .group-icon.spin')), shimmer: getComputedStyle(g.querySelector('.group-verb')).animationName, open: g.open } : null; })()`, 30_000, 'the live line on the passing command');
    check('while the turn runs the line reads like the call in flight, shimmering (no spinner)', live && live.shimmer === 'shimmer' && !live.spin, live);
    check('the live group stays closed', live && !live.open);
    check('nothing but the one line while the calls run', /^ug$/.test(await shape()), await shape());
    await shot('quiet-running');
    await idle();
    // The turn folded under its header once it had its answer: open it to look at its lines
    await app.unfold();

    let g = await groups();
    check('turn 1: two lines, one per run of calls', g.length === 2, g);
    check('the first line says what the run did', g[0]?.words === 'Read 3 files, edited 2 files, ran 2 commands', g[0]?.words);
    check('…and on its right the diff total and the failed command', g[0]?.meta === '+3 −2 1 failed', g[0]?.meta);
    check('…and holds the seven rows', g[0]?.rows === 7, g[0]);
    check('the second run is its own line', g[1]?.words === 'Ran a search, listed a directory' && g[1]?.meta === '' && g[1]?.rows === 2, g[1]);
    check('neither is live once the run is over', g.every((x) => !x.live));
    check('the turn reads: you, a line, a reply, a line, a reply', (await shape()) === 'ugaga', await shape());
    const style = await app.evaluate(`(() => {
      const s = getComputedStyle(document.querySelector('.tool-group > summary'));
      const stat = getComputedStyle(document.querySelector('.tool-group .group-stat'));
      const failed = getComputedStyle(document.querySelector('.tool-group .group-failed'));
      const add = getComputedStyle(document.querySelector('.tool-group .group-stat .git-add'));
      const chev = document.querySelector('.tool-group > summary .tool-chevron').getBoundingClientRect().left;
      const words = document.querySelector('.tool-group > summary .group-verb').getBoundingClientRect().right;
      const probe = document.createElement('span'); probe.style.color = 'var(--danger)'; document.body.append(probe); const danger = getComputedStyle(probe).color; probe.style.color = 'var(--git-add)'; const green = getComputedStyle(probe).color; probe.remove();
      return { size: s.fontSize, height: s.height, color: s.color, statSize: stat.fontSize, failedColor: failed.color, danger, addColor: add.color, green, chevronAfter: chev > words };
    })()`);
    check('the line is a tool row: 15px on a 24px row, muted', style.size === '15px' && style.height === '24px', style);
    check('the counts are in the secondary size, the failed count in the danger colour, the additions green', style.statSize === '13px' && style.failedColor === style.danger && style.addColor === style.green, style);
    check('the chevron comes after the words', style.chevronAfter, style);
    await shot('quiet-folded-light');
    await theme('dark');
    await shot('quiet-folded-dark');
    await theme('light');

    // ---------- It opens and closes; the rows inside are the rows as they always were ----------
    await app.evaluate(`document.querySelector('#messages > .tool-group > summary').click()`);
    const opened = await app.evaluate(`(() => { const g = document.querySelector('#messages > .tool-group'); const rows = [...g.querySelectorAll(':scope > .group-body > .tool')]; return { open: g.open, visible: rows.filter((r) => r.getBoundingClientRect().height > 0).length, verbs: rows.map((r) => r.querySelector('.tool-verb').textContent + ' ' + r.querySelector('.tool-arg').textContent), failedOpen: rows[5]?.open === false && rows[5]?.querySelector('.tool-meta').innerText }; })()`);
    check('a click opens the line to its rows', opened.open && opened.visible === 7, opened);
    check('the rows read as single rows do', opened.verbs.join(' | ') === 'Read src/cart.js | Read src/discount.js | Read test/cart.test.js | Edit src/cart.js | Edit test/cart.test.js | Bash node --test test/ 2>&1 | tail -3; exit 3 | Bash sleep 2.5; echo "# pass 4"', opened.verbs);
    await app.evaluate(`[...document.querySelectorAll('#messages > .tool-group .group-body > .tool')][3].querySelector(':scope > summary').click()`);
    check('a row inside opens to its own detail (the edit shows its diff)', await app.evaluate(`(() => { const r = [...document.querySelectorAll('#messages > .tool-group .group-body > .tool')][3]; return r.open && Boolean(r.querySelector('.tool-body .diff')) && r.querySelector('.tool-body').getBoundingClientRect().height > 0; })()`));
    await app.evaluate(`document.querySelector('#messages > .tool-group').scrollIntoView({ block: 'start' })`);
    await shot('quiet-group-open');
    await app.evaluate(`[...document.querySelectorAll('#messages > .tool-group .group-body > .tool')][3].querySelector(':scope > summary').click()`);
    // The keyboard: the summary is a real <summary>, focusable; Enter toggles it and the state is exposed
    const kb = await app.evaluate(`(async () => {
      const s = document.querySelector('#messages > .tool-group > summary');
      s.focus();
      const focused = document.activeElement === s;
      return { focused, tag: s.tagName, label: s.getAttribute('aria-label'), tabbable: s.tabIndex >= 0 };
    })()`);
    // Enter as a keyboard sends it (with its text, which is what activates a <summary>)
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...enter });
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
    await sleep(100);
    const closed = await app.evaluate(`!document.querySelector('#messages > .tool-group').open`);
    check('the line is a focusable <summary> with a label that says what it holds', kb.focused && kb.tag === 'SUMMARY' && kb.tabbable && /Read 3 files, edited 2 files, ran 2 commands/.test(kb.label) && /1 failed/.test(kb.label), kb);
    check('Enter closes it again', closed);
    const ax = await app.cdp('Accessibility.getPartialAXTree', { nodeId: undefined, backendNodeId: undefined, objectId: (await app.cdp('Runtime.evaluate', { expression: `document.querySelector('#messages > .tool-group > summary')` })).result.objectId, fetchRelatives: false }).catch((e) => ({ error: String(e) }));
    const node = ax.nodes?.[0];
    const expanded = node?.properties?.find((p) => p.name === 'expanded');
    check('screen readers hear it as collapsed', node && expanded && expanded.value.value === false, node ? { role: node.role?.value, name: node.name?.value, expanded } : ax);

    // ---------- Turn 2, in Ask mode: a waiting card stays out, decided ones fold in, a denied call counts ----------
    await setConfig({ permissionMode: 'ask' });
    await app.waitFor(`document.querySelector('#mode-btn').dataset.mode === 'ask'`, 5000, 'ask mode');
    reply({ content: '', toolCalls: [call('read_file', { path: 'src/discount.js' })] });
    reply({ content: '', toolCalls: [call('write_file', { path: 'CHANGELOG.md', content: '# Changelog\n\n- The cart total counts quantities.\n' })] });
    reply({ content: '', toolCalls: [call('bash', { command: 'git commit -am "Count quantities in the cart total"' })] });
    reply({ content: 'I added a changelog entry; the commit is yours to make.' });
    await app.send('Note it in a changelog and commit.');
    await app.waitFor(`Boolean([...document.querySelectorAll('.approval')].find((c) => !c.classList.contains('done') && c.querySelector('.btn.primary')))`, 30_000, 'the write’s approval card');
    await sleep(200);
    const waiting = await app.evaluate(`(() => {
      const card = [...document.querySelectorAll('.approval')].find((c) => !c.classList.contains('done'));
      const g = [...document.querySelectorAll('#messages > .tool-group')].pop();
      const r = card.getBoundingClientRect();
      return { top: card.parentElement.id === 'messages', after: Boolean(g && (g.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)), visible: r.height > 40, verb: g?.querySelector('.group-verb').textContent, arg: g?.querySelector('.group-arg').textContent, live: g?.classList.contains('live') };
    })()`);
    check('the waiting card is in the open, under the run', waiting.top && waiting.after && waiting.visible, waiting);
    check('the run’s line names the call that waits', waiting.verb === 'Write' && waiting.arg === 'CHANGELOG.md' && waiting.live, waiting);
    await app.evaluate(`[...document.querySelectorAll('.approval')].pop().scrollIntoView({ block: 'end' })`);
    await shot('quiet-ask-waiting');
    await app.approve('allow');
    await app.waitFor(`[...document.querySelectorAll('.approval')].filter((c) => !c.classList.contains('done')).length === 1 && !document.querySelector('.approval.done')`, 30_000, 'the command’s card, the write’s card gone');
    check('once allowed, the card goes and the write’s row keeps the answer', await app.evaluate(`(() => { const d = [...document.querySelectorAll('#messages > .tool-group')].pop().querySelectorAll('.group-body > .tool[data-tool="write_file"] .tool-decision'); return d.length === 1 && d[0].textContent === 'Allowed once'; })()`));
    await app.approve('deny');
    await idle();
    g = await groups();
    const last = g[g.length - 1];
    check('turn 2 folds to one line', g.length === 3 && (await shape()) === 'ugagauga', { g, shape: await shape() });
    check('…saying what happened, with the created file’s lines and the denied command', last.words === 'Read a file, created a file' && last.meta === '+3 1 denied', last);
    check('…and both answers are in its rows, with no line of their own', last.decided === 2 && last.rows === 3 && !(await app.exists('.approval')), last);
    check('the denied command did not run', !fs.readdirSync(project).includes('.git'));

    // ---------- Turn 3: a single call is one quiet line too ----------
    reply({ content: '', toolCalls: [call('read_file', { path: 'src/cart.js' })] });
    reply({ content: 'Yes: `total` multiplies by `qty` now.' });
    await app.send('Does cart.js use qty now?');
    await idle();
    await app.unfold();
    check('a single call folds to one line', (await shape()) === 'ugagaugauga', await shape());
    g = await groups();
    check('…that says what it did', g[g.length - 1].words === 'Read a file' && g[g.length - 1].rows === 1 && g[g.length - 1].meta === '', g[g.length - 1]);
    await app.evaluate(`[...document.querySelectorAll('#messages > .tool-group')].pop().querySelector(':scope > summary').click()`);
    const lone = await app.evaluate(`(() => { const g = [...document.querySelectorAll('#messages > .tool-group')].pop(); const t = g.querySelector('.group-body > .tool'); return { open: g.open, row: t.querySelector('.tool-verb').textContent + ' ' + t.querySelector('.tool-arg').textContent, rowOpen: t.open, code: t.querySelector('.tool-body .code-view, .tool-body pre, .tool-body .code') !== null && t.querySelector('.tool-body').getBoundingClientRect().height > 0 }; })()`);
    check('opened, it shows the row as it always read, open on its details', lone.open && lone.row === 'Read src/cart.js' && lone.rowOpen && lone.code, lone);
    await shot('quiet-single-open');
    await app.evaluate(`(() => { const g = [...document.querySelectorAll('#messages > .tool-group')].pop(); g.open = false; g.querySelector('.group-body > .tool').open = false; })()`);
    const folded = await groups();
    const foldedShape = await shape();

    // ---------- The setting: Every call shows the rows, Summary folds them again ----------
    await app.evaluate(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-general')?.click(); })()`);
    await app.waitFor(`Boolean(document.querySelector('#sp-row-toolActivity input[value="all"]'))`, 5000, 'the Tool activity row');
    const row = await app.evaluate(`(() => { const r = document.querySelector('#sp-row-toolActivity'); return { title: r.querySelector('.sp-row-name').textContent, desc: r.querySelector('.sp-row-desc').textContent, choices: [...r.querySelectorAll('label')].map((l) => l.innerText.trim()), checked: r.querySelector('input:checked')?.value }; })()`);
    check('Settings → General has "Tool activity: Summary / Every call", on Summary', row.title === 'Tool activity' && row.choices.join('/') === 'Summary/Every call' && row.checked === 'summary' && row.desc.length > 20, row);
    await app.evaluate(`document.querySelector('#sp-row-toolActivity').scrollIntoView({ block: 'center' })`);
    await shot('quiet-settings-row');
    await app.evaluate(`document.querySelector('#sp-row-toolActivity input[value="all"]').click()`);
    await app.waitFor(`(async () => (await window.oc.getConfig()).toolActivity === 'all')()`, 5000, 'the setting to save');
    await app.waitFor(`document.querySelectorAll('#messages > .tool-group').length === 1`, 5000, 'the rows to come out');
    const all = await groups();
    const allShape = await shape();
    check('Every call: only the three reads fold, as they always did', all.length === 1 && all[0].words === 'Read 3 files' && all[0].rows === 3, all);
    check('Every call: each other call is its own row, and the answers stay in their rows', allShape === 'ugttttattautttauta' && (await app.count('#messages > .tool .tool-decision')) === 2, allShape);
    await app.evaluate(`document.querySelector('#sp-row-toolActivity input[value="summary"]').click()`);
    await app.waitFor(`(async () => (await window.oc.getConfig()).toolActivity === 'summary')()`, 5000, 'the setting to save');
    await app.key('Escape');
    await sleep(200);
    check('Summary again: the same lines as before', JSON.stringify(await groups()) === JSON.stringify(folded) && (await shape()) === foldedShape, { now: await groups(), before: folded });

    // ---------- A group the user opened stays open while rows are added ----------
    await setConfig({ permissionMode: 'bypass' });
    reply({ content: '', toolCalls: [call('read_file', { path: 'src/cart.js' }), call('read_file', { path: 'src/discount.js' })] });
    reply({ content: '', delayMs: 1500, toolCalls: [call('list_directory', { path: 'test' })] });
    reply({ content: 'Both files are as expected.' });
    await app.send('Look over both files once more.');
    await app.waitFor(`(() => { const g = [...document.querySelectorAll('#messages > .tool-group')].pop(); return g && g.querySelectorAll('.group-body > .tool').length === 2 && g.classList.contains('live'); })()`, 20_000, 'the new run');
    await app.evaluate(`[...document.querySelectorAll('#messages > .tool-group')].pop().querySelector(':scope > summary').click()`);
    await idle();
    const kept = await app.evaluate(`(() => { const g = [...document.querySelectorAll('#messages > .tool-group')].pop(); return { open: g.open, rows: g.querySelectorAll('.group-body > .tool').length, words: g.querySelector('.group-verb').textContent }; })()`);
    check('a group opened while it runs stays open as rows join it', kept.open && kept.rows === 3 && kept.words === 'Read 2 files, listed a directory', kept);
    const beforeReopen = await groups();
    const shapeBeforeReopen = await shape();

    // ---------- Opening the session again folds it the same way ----------
    const id = await app.evaluate(`document.querySelector('.session-item.active')?.dataset.id`);
    const reopen = async () => {
      await app.click('#new-session-btn');
      await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id !== ${JSON.stringify(id)}`, 10_000, 'another session');
      await app.click(`.session-item[data-id=${JSON.stringify(id)}]`);
      await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${JSON.stringify(id)} && document.querySelectorAll('#messages > .tool-group').length > 0`, 10_000, 'the session back');
      await sleep(300);
    };
    // Stored sessions keep no approval lines: a run's line and its rows are what must match
    const lines = (list) => list.map((x) => ({ words: x.words, meta: x.meta, rows: x.rows }));
    const plain = (s) => s.replace(/d/g, '');
    await reopen();
    check('reopened: the same lines, with the same words, counts and rows', JSON.stringify(lines(await groups())) === JSON.stringify(lines(beforeReopen)), { now: await groups(), before: beforeReopen });
    check('reopened: the same shape', plain(await shape()) === plain(shapeBeforeReopen), { now: await shape(), before: shapeBeforeReopen });
    check('reopened: closed, as nothing was opened yet', await app.evaluate(`[...document.querySelectorAll('#messages > .tool-group')].every((g) => !g.open)`));

    // After a rewind: the last turn goes, the rest folds as it did
    await app.waitFor(`document.querySelectorAll('.msg.user .msg-rewind').length > 0`, 10_000, 'rewind buttons');
    await app.evaluate(`[...document.querySelectorAll('.msg.user .msg-rewind')].pop().click()`);
    await app.click('#confirm-ok');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /Rewound/.test(e.innerText))`, 10_000, 'the rewind notice');
    await app.fill('#input', '');
    const rewound = await groups();
    check('after a rewind the earlier runs keep their lines', JSON.stringify(lines(rewound)) === JSON.stringify(lines(beforeReopen.slice(0, 4))), rewound);
    await reopen();
    check('…and the session opened again folds the same', JSON.stringify(lines(await groups())) === JSON.stringify(lines(rewound)), await groups());

    // After /compact: the folded part and the kept part both fold as before
    app.mock.state.summary = 'The user asked to count quantities in the cart total; it was fixed, tested and noted in the changelog.';
    await app.send('/compact');
    await app.waitFor(`Boolean(document.querySelector('#messages > .compaction')) || [...document.querySelectorAll('.msg.system')].some((e) => /compact|summar/i.test(e.innerText))`, 30_000, 'the compaction');
    await sleep(300);
    const compacted = await groups();
    const hasDivider = await app.exists('#messages > .compaction');
    await reopen();
    check('after /compact the lines are the same, before and after opening the session again', hasDivider && JSON.stringify(lines(await groups())) === JSON.stringify(lines(compacted)) && JSON.stringify(lines(compacted)) === JSON.stringify(lines(rewound)), { hasDivider, now: await groups(), compacted, shape: await shape() });

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
