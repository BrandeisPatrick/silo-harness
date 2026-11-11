// Live compaction check: a small context window (10k), a task that needs several tool calls and remembers something
// across them, then /compact by hand and a follow-up that depends on the earlier conversation. Screenshots of the
// divider (collapsed and expanded) and of the context meter's popover, in light and dark.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/compaction.js [screenshot-dir]
// Needs the real API: the mock model cannot call tools, so without a key the script says so and stops.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, LIVE_MODEL } = require('./rig.js');

const WORDS = ['Apple', 'Banana', 'Cherry', 'Damson', 'Elderberry'];
const WINDOW = 10250;
const FILLER = 'This line is filler text that pads the file so that reading it takes a fair share of a small context window. ';

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-compaction-'));
  const { check, done } = checker();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY: the mock model cannot call tools, so this check needs the real API. Skipped.');
    process.exit(0);
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-compaction-project-'));
  // Changed on purpose: with tool groups loaded when needed, a request's fixed part is about 4k tokens instead of 10k,
  // so the window is smaller (was 12k) and the files longer (were 22 fillers) for the reads to fill it as before.
  // Changed on purpose again: the system prompt grew by about 170 tokens, which at a 10,000-token window made
  // compaction due one read earlier, when what it would fold is already too small to summarise. 10,250 keeps the
  // same sequence as before: two prunes, then a summary.
  WORDS.forEach((w, i) => fs.writeFileSync(path.join(project, `${'abcde'[i]}.txt`), `${w} ${FILLER.repeat(40)}\nEnd of file ${'abcde'[i]}.txt.\n`));
  const app = await launch({
    mode: 'bypass',
    project,
    config: {
      // The whole portkey block: the rig's config option replaces sections instead of merging them.
      portkey: { baseURL: 'https://api.anthropic.com/v1', apiKey: '', model: LIVE_MODEL, virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: WINDOW },
      autoCompact: true,
      compactThreshold: 0.8,
      pruneToolResults: true,
    },
  });
  try {
    await app.evaluate(`document.documentElement.dataset.theme = 'light'`).catch(() => {});
    await app.send('Read a.txt, b.txt, c.txt, d.txt and e.txt in the working directory one at a time (one read_file call per message, in that order). Then tell me the first word of each file, in order, as a comma-separated list, and nothing else.');
    await app.waitIdle(300_000);
    const items = await app.transcript();
    const dividers = items.filter((i) => /\bcompaction\b/.test(i.cls));
    const prunes = items.filter((i) => /notice/.test(i.cls) && /Cleared .* tokens of old tool output/.test(i.text));
    const fallbacks = items.filter((i) => /notice/.test(i.cls) && /Couldn't summarise|Dropped/.test(i.text));
    check('a prune notice or a compaction divider appeared', dividers.length + prunes.length >= 1, { dividers: dividers.map((d) => d.text.split('\n')[0]), prunes: prunes.map((p) => p.text), fallbacks: fallbacks.map((f) => f.text) });
    console.log('notices:', JSON.stringify(items.filter((i) => /notice/.test(i.cls)).map((i) => i.text)));
    const errors = items.filter((i) => /\berror\b/.test(i.cls));
    check('the run finished without an error', errors.length === 0, errors.map((e) => e.text));
    const answer = await app.lastReply();
    const order = WORDS.map((w) => answer.indexOf(w));
    check('the final answer names the five first words in order', order.every((p) => p >= 0) && order.every((p, i) => i === 0 || p > order[i - 1]), answer);
    if (dividers.length) check('the divider says what happened', /^Compacted · \d+ messages? (summarised|dropped)(, \d+ kept)? · [\d.]+k? → [\d.]+k? tokens/.test(dividers[0].text), dividers[0].text.split('\n')[0]);

    // /compact by hand, then a follow-up that needs the earlier conversation
    const before = await app.count('#messages > .compaction');
    await app.send('/compact keep the five first words');
    await app.waitFor(`document.querySelectorAll('#messages > .compaction').length > ${before} || [...document.querySelectorAll('#messages > .msg.system.error')].length > 0`, 180_000, 'the manual compaction');
    await sleep(500);
    const manual = await app.count('#messages > .compaction');
    check('/compact added a divider', manual === before + 1, await app.transcript().then((t) => t.slice(-3)));
    await app.send('What was the first word of c.txt? Answer with that one word only, without reading any file again.');
    await app.waitIdle(180_000);
    const follow = await app.lastReply();
    check('the follow-up after /compact remembers the earlier conversation', /Cherry/i.test(follow), follow);

    // Screenshots: the divider collapsed and expanded, then the meter popover; light and dark.
    const shoot = async (theme) => {
      await app.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`).catch(() => {});
      await sleep(300);
      await app.evaluate(`(() => { const d = document.querySelector('#messages > .compaction'); d.open = false; d.scrollIntoView({ block: 'center' }); })()`);
      await sleep(200);
      await app.screenshotOf(path.join(shots, `divider-collapsed-${theme}.png`), '#messages > .compaction', 16);
      await app.evaluate(`(() => { const d = document.querySelector('#messages > .compaction'); d.open = true; d.scrollIntoView({ block: 'start' }); })()`);
      await sleep(250);
      await app.screenshot(path.join(shots, `divider-expanded-${theme}.png`));
      await app.evaluate(`document.querySelector('#messages > .compaction').open = false`);
      await app.click('#context-meter');
      await app.waitFor(`Boolean(document.querySelector('.popover.context-menu .ctx-slices'))`, 10_000, 'the breakdown in the meter popover');
      // Let the popover finish its fade-in and settle its position before measuring it.
      await sleep(800);
      await app.screenshotOf(path.join(shots, `meter-popover-${theme}.png`), '.popover.context-menu', 16);
      const rows = await app.evaluate(`[...document.querySelectorAll('.popover.context-menu .ctx-slice')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await app.key('Escape');
      await sleep(200);
      return rows;
    };
    const rows = await shoot('light');
    check('the meter popover lists the breakdown', rows.length >= 4 && rows.some((r) => /^(Free|Reserved for compaction) \d/.test(r)) && rows.some((r) => /^System prompt/.test(r)), rows);
    await shoot('dark');
    const breakdown = await app.evaluate(`window.oc.rpc('context.breakdown')`);
    check('context.breakdown adds up to the window', breakdown && breakdown.slices.reduce((a, s) => a + s.tokens, 0) === breakdown.limit && breakdown.limit === WINDOW, breakdown && { basis: breakdown.basis, tokens: breakdown.tokens });
    const rendererErrors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', rendererErrors.length === 0, rendererErrors.slice(0, 3));
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
