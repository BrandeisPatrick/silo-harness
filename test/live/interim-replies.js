// Live check of interim replies: the text a model writes together with its tool calls, drawn as plain body text
// between the run lines, in order, the way Codex and Claude Code show them. One user turn with the mock model: reply 1
// is a sentence plus two calls, reply 2 a sentence plus one slow call, reply 3 the answer. While the run goes on each
// sentence shows in order and ends the run line before it (the calls after it start a new line); after the run, in
// Summary mode, the turn folds to its header and the answer, the header (a real click) shows sentence, line, sentence,
// line, answer, and a second click folds it. The same turn with Tool activity on Every call shows the rows themselves
// between the sentences and folds nothing by itself. An interim sentence is styled exactly like the answer, and the
// space around it matches the space between a run line and the answer. Screenshots of the unfolded turn, light and dark.
// Run: npm run build && node test/live/interim-replies.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const { check, done } = checker();
const T1 = "I'll read the README first.";
const T2 = 'The README has 7 lines. Now checking the tests.';
const ANSWER = 'The README is fine and the tests pass.';

/** The turn's nodes after its header: kind (text, group, row, head), text, shown */
const turnNodes = (app) =>
  app.evaluate(`(() => {
    const h = [...document.querySelectorAll('#messages > .turn-head')].pop();
    if (!h) return null;
    const out = [];
    for (let n = h.nextElementSibling; n && !(n.classList.contains('msg') && n.classList.contains('user')); n = n.nextElementSibling) {
      const c = n.classList;
      const kind = c.contains('tool-group') ? 'group' : c.contains('tool') ? 'row' : c.contains('msg') && c.contains('assistant') ? 'text' : c.contains('thinking') ? 'thinking' : n.className;
      const shown = getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().height > 0;
      out.push({ kind, shown, live: c.contains('live'), calls: kind === 'group' ? n.querySelectorAll(':scope > .group-body > .tool').length : undefined, text: kind === 'text' ? n.querySelector('.md').innerText.trim() : (n.querySelector(':scope > summary')?.innerText ?? '').replace(/\\s+/g, ' ').trim() });
    }
    return out;
  })()`);
const seq = (nodes, onlyShown = false) => nodes.filter((n) => !onlyShown || n.shown).map((n) => (n.kind === 'text' ? `text:${n.text}` : n.kind === 'group' ? `group:${n.calls}` : n.kind)).join(' | ');

async function runTurn(mode, shots) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-interim-'));
  fs.writeFileSync(path.join(project, 'README.md'), '# Demo\n\nA small project.\n\n## Use\n\nRun it.\n');
  fs.mkdirSync(path.join(project, 'test'));
  fs.writeFileSync(path.join(project, 'test', 'demo.test.js'), 'console.log("ok");\n');
  const app = await launch({ mode: 'bypass', mock: true, project, size: { width: 1200, height: 900 }, config: mode === 'all' ? { toolActivity: 'all' } : {} });
  const tag = (s) => `[${mode}] ${s}`;
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
  const HEAD = `[...document.querySelectorAll('#messages > .turn-head .turn-head-btn')].pop()`;
  try {
    replies.push({ content: T1, toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'README.md' } }, { id: 'r2', name: 'bash', args: { command: 'sleep 1; wc -l README.md' } }] });
    replies.push({ content: T2, toolCalls: [{ id: 'r3', name: 'bash', args: { command: 'sleep 3; node test/demo.test.js' } }], delayMs: 300 });
    replies.push({ content: ANSWER, delayMs: 300 });
    await app.send('Check the README and the tests');

    // While the run goes on
    const first = await app.waitFor(`(() => { const t = [...document.querySelectorAll('#messages > .msg.assistant')].pop(); return t && t.innerText.includes(${JSON.stringify(T1)}) && document.querySelector('#messages > .turn-head') ? true : false; })()`, 15_000, 'the first sentence');
    check(tag('running: the first sentence shows'), first);
    await app.waitFor(`[...document.querySelectorAll('#messages > .msg.assistant')].some((t) => t.innerText.includes(${JSON.stringify(T2)}))`, 20_000, 'the second sentence');
    await app.waitFor(`document.querySelectorAll('#messages > .tool-group, #messages > .tool').length >= ${mode === 'all' ? 3 : 2}`, 10_000, 'the call after it');
    await sleep(300);
    let nodes = await turnNodes(app);
    const runningWant = mode === 'all' ? `text:${T1} | row | row | text:${T2} | row` : `text:${T1} | group:2 | text:${T2} | group:1`;
    check(tag('running: sentence, calls, sentence, call, in order'), seq(nodes) === runningWant, seq(nodes));
    if (mode !== 'all') {
      const groups = nodes.filter((n) => n.kind === 'group');
      check(tag('running: the sentence ended the first line (not live, "Read a file, ran a command"); the call after it is a new live line'), groups.length === 2 && !groups[0].live && groups[1].live && /^Read a file, ran a command/.test(groups[0].text), groups);
    }
    await app.screenshot(path.join(shots, `interim-${mode}-running.png`));
    await app.waitFor(nothingRuns, 60_000, 'the run to end');
    await sleep(500);

    nodes = await turnNodes(app);
    const allWant = mode === 'all' ? `text:${T1} | row | row | text:${T2} | row | text:${ANSWER}` : `text:${T1} | group:2 | text:${T2} | group:1 | text:${ANSWER}`;
    check(tag('after the run: the nodes are still in order'), seq(nodes) === allWant, seq(nodes));
    const expanded = () => app.evaluate(`${HEAD}.getAttribute('aria-expanded')`);
    if (mode === 'all') {
      check(tag('Every call: nothing folds by itself'), seq(nodes, true) === allWant && (await expanded()) === 'true', seq(nodes, true));
      await realClick(HEAD);
      nodes = await turnNodes(app);
      check(tag('Every call: the header folds the process, the answer stays'), seq(nodes, true) === `text:${ANSWER}` && (await expanded()) === 'false', seq(nodes, true));
      await realClick(HEAD);
      nodes = await turnNodes(app);
      check(tag('Every call: a second click shows it all again'), seq(nodes, true) === allWant, seq(nodes, true));
    } else {
      check(tag('after the run: folded to the header and the answer'), seq(nodes, true) === `text:${ANSWER}` && (await expanded()) === 'false', seq(nodes, true));
      await realClick(HEAD);
      nodes = await turnNodes(app);
      check(tag('the header shows sentence, line, sentence, line, answer'), seq(nodes, true) === allWant && (await expanded()) === 'true', seq(nodes, true));
      const words = nodes.filter((n) => n.kind === 'group').map((n) => n.text);
      check(tag('the lines say what each part did'), words[0] === 'Read a file, ran a command' && words[1] === 'Ran a command', words);
      await realClick(HEAD);
      nodes = await turnNodes(app);
      check(tag('a second click folds it again'), seq(nodes, true) === `text:${ANSWER}` && (await expanded()) === 'false', seq(nodes, true));
      await realClick(HEAD);
    }

    // An unfolded node replays its 120 ms fade-in; a hidden window can hold that at its first frame, so it is finished
    const settle = () => app.evaluate(`document.getAnimations().filter((a) => a.effect?.target?.closest?.('#messages')).forEach((a) => { try { a.finish(); } catch {} })`);
    await settle();
    // An interim sentence looks like the answer, and sits like it (layout boxes, not the fade's transform)
    const look = await app.evaluate(`(() => {
      const h = [...document.querySelectorAll('#messages > .turn-head')].pop();
      const nodes = []; for (let n = h.nextElementSibling; n; n = n.nextElementSibling) nodes.push(n);
      const texts = nodes.filter((n) => n.classList.contains('assistant'));
      const st = (e) => { const c = getComputedStyle(e.querySelector('.md p') || e.querySelector('.md')); return [c.fontSize, c.lineHeight, c.color, c.fontWeight, c.fontStyle, c.fontFamily].join(' '); };
      const r = (e) => ({ top: e.offsetTop, bottom: e.offsetTop + e.offsetHeight });
      const gaps = []; for (let i = 0; i + 1 < nodes.length; i++) gaps.push({ from: nodes[i].className.split(' ').slice(0, 2).join('.'), to: nodes[i + 1].className.split(' ').slice(0, 2).join('.'), gap: Math.round(r(nodes[i + 1]).top - r(nodes[i]).bottom) });
      return { styles: texts.map(st), gaps };
    })()`);
    check(tag('the interim sentences are styled exactly like the answer'), look.styles.length === 3 && look.styles.every((s) => s === look.styles[2]), look.styles);
    const textToCall = look.gaps.filter((g) => /^msg\.assistant/.test(g.from) && /^tool/.test(g.to)).map((g) => g.gap);
    const callToText = look.gaps.filter((g) => /^tool/.test(g.from) && /^msg\.assistant/.test(g.to)).map((g) => g.gap);
    check(tag('the space under a sentence before a line matches the space under a line before a sentence'), textToCall.length >= 2 && callToText.length >= 2 && [...textToCall, ...callToText].every((g) => g === callToText[callToText.length - 1]), look.gaps);

    // Screenshots of the unfolded turn
    for (const scheme of ['light', 'dark']) {
      await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(scheme)}`);
      await app.evaluate(`[...document.querySelectorAll('#messages > .turn-head')].pop().scrollIntoView({ block: 'start' })`);
      await sleep(400);
      await settle();
      await app.screenshot(path.join(shots, `interim-${mode}-unfolded-${scheme}.png`));
    }
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check(tag('no renderer errors'), errors.length === 0, errors.slice(0, 3));
  } finally {
    await app.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
}

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  await runTurn('summary', shots);
  await runTurn('all', shots);
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
