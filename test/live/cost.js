// Live: a session's cost in the status line. With a price set for the model (`prices`), a figure stands beside the
// tokens while a run goes on, and its hover says it is an estimate; /cost answers with a local note (never sent to
// the model); after a restart the session still has its total, /cost says so and the next run's figure carries on
// from it. Without a price there is no figure at all, and /cost names the model. Mock model only.
//
//   npm run build && node test/live/cost.js [screenshot folder]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-cost-'));

(async () => {
  const { check, done } = checker();
  let app = null;
  // One mock call is 300 input and 30 output tokens: at $1,000 and $5,000 per million, $0.30 + $0.15 = $0.45
  const prices = { 'mock-model': { input: 1000, output: 5000 } };
  const costShown = `(() => { const e = document.querySelector('#status-cost'); return e && !e.hidden && !document.querySelector('#status-line').hidden ? e.innerText.trim() : ''; })()`;
  const tokensShown = `(() => { const e = document.querySelector('#status-tokens'); return e && !e.hidden && !document.querySelector('#status-line').hidden ? e.innerText.trim() : ''; })()`;
  const notes = () => app.evaluate(`[...document.querySelectorAll('#messages .msg.system')].map((e) => e.innerText.trim())`);
  /** A run of two calls (a read-only command, then an answer held back so the status line can be read). */
  const twoCalls = (tag) => {
    app.mock.state.replies.push({ content: '', toolCalls: [{ id: `c_${tag}`, name: 'bash', args: { command: `echo ${tag}` } }] });
    app.mock.state.replies.push({ content: `Done ${tag}.`, delayMs: 2500 });
  };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-cost-profile-'));
  try {
    app = await launch({ mock: true, mode: 'bypass', config: { prices }, profile });
    // ---------- 1. A priced model: the figure beside the tokens ----------
    twoCalls('one');
    await app.send('Run echo one please');
    const first = await app.waitFor(costShown, 20_000, 'the cost in the status line');
    check('the status line shows the cost beside the tokens: $0.45 after the first call', first === '$0.45' && /tokens$/.test(await app.evaluate(tokensShown)), first);
    const tip = await app.evaluate(`document.querySelector('#status-cost').dataset.tip`);
    check('its hover says it is an estimate from list prices', /estimate/i.test(tip) && /list prices/i.test(tip), tip);
    const order = await app.evaluate(`(() => { const t = document.querySelector('#status-tokens'), c = document.querySelector('#status-cost'); return Boolean(t.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) && Math.abs(c.getBoundingClientRect().top - t.getBoundingClientRect().top) < 2; })()`);
    check('…on the same line, right after the tokens', order);
    for (const theme of ['light', 'dark']) {
      await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await sleep(150);
      await app.screenshotOf(path.join(shots, `cost-status-line-${theme}.png`), '#status-line', 8);
    }
    await app.evaluate(`delete document.documentElement.dataset.theme`);
    await app.waitIdle();
    check('the figure goes with the status line when the run ends', !(await app.evaluate(costShown)));

    // ---------- 2. /cost: a local note ----------
    const before = app.mock.state.requests.length;
    await app.send('/cost');
    await app.waitFor(`[...document.querySelectorAll('#messages .msg.system')].some((e) => /estimated from list prices/.test(e.innerText))`, 10_000, 'the /cost note');
    const note = (await notes()).find((t) => /estimated from list prices/.test(t)) || '';
    check('/cost: the total of both calls, the tokens and what is counted', note.startsWith('$0.90, estimated from list prices') && /600 uncached input · 0 cached · 0 cache write · 60 output tokens · 2 calls/.test(note) && /Counts the agent's turns/.test(note), note);
    await sleep(300);
    check('/cost sent nothing to the model', app.mock.state.requests.length === before, app.mock.state.requests.length - before);

    // ---------- 3. After a restart ----------
    const id = (await app.evaluate('oc.sessions.current()')).id;
    await app.close();
    app = await app.relaunch();
    await app.waitFor(`document.querySelector('.session-item[data-id=${JSON.stringify(id)}]')`, 10_000, 'the session in the sidebar after the restart');
    await app.click(`.session-item[data-id=${JSON.stringify(id)}]`);
    await app.waitFor(`document.querySelectorAll('#messages .msg.user').length >= 1`, 10_000, 'its conversation');
    await app.send('/cost');
    await app.waitFor(`[...document.querySelectorAll('#messages .msg.system')].some((e) => /estimated from list prices/.test(e.innerText))`, 10_000, 'the /cost note after the restart');
    const kept = (await notes()).filter((t) => /estimated from list prices/.test(t)).pop() || '';
    check("after a restart, /cost still has the session's total ($0.90, 2 calls)", kept.startsWith('$0.90') && / 2 calls/.test(kept), kept);
    twoCalls('three');
    await app.send('Run echo three please');
    const next = await app.waitFor(costShown, 20_000, 'the cost after the restart');
    check("…and the next run's figure carries on from it ($1.35 after its first call)", next === '$1.35', next);
    await app.waitIdle();
    await app.close();
    app = null;

    // ---------- 4. No price: no figure ----------
    app = await launch({ mock: true, mode: 'bypass' });
    twoCalls('four');
    await app.send('Run echo four please');
    await app.waitFor(tokensShown, 20_000, 'the tokens in the status line');
    await sleep(400);
    check('without a price: the tokens, and no dollar figure', !(await app.evaluate(costShown)) && (await app.evaluate(`document.querySelector('#status-cost').innerText.trim()`)) === '');
    await app.waitIdle();
    await app.send('/cost');
    await app.waitFor(`[...document.querySelectorAll('#messages .msg.system')].some((e) => /No dollar figure/.test(e.innerText))`, 10_000, 'the /cost note without a price');
    const none = (await notes()).find((t) => /No dollar figure/.test(t)) || '';
    check('/cost names the model without a price and the setting', none.startsWith('No dollar figure: no price for mock-model') && /"prices"/.test(none), none);
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${shots}`);
  } catch (err) {
    console.log(`FAIL crashed: ${err && err.stack ? err.stack : err}`);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})();
