// Live check of "Send now" on a queued message in the real window with the mock model: a scripted slow bash call
// (sleep 8) runs, two made-up messages are queued, and Send now on the second cuts the command within about 2 s, shows
// the second as a user bubble, keeps the first as a queued row, prints no "Interrupted." and leaves the composer empty;
// the mock then gets a request ending with the second message, and the first is delivered after that step. Screenshots
// of the row (light and dark, the button at rest and hovered).
// Run: npm run build && node test/live/queue-send-now.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const lastUserText = (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  if (!m || m.role !== 'user') return '';
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
};
const userTexts = (payload) => (payload.messages ?? []).filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  fs.mkdirSync(shots, { recursive: true });
  const { check, done } = checker();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-sendnow-'));
  const app = await launch({ mode: 'bypass', mock: true, project, size: { width: 1100, height: 760 } });
  const FIRST = 'First queued note about the made-up garden';
  const SECOND = 'Second queued note: check the made-up fence instead';
  try {
    const { state } = app.mock;
    state.replies.push({ content: 'Starting the slow job.', toolCalls: [{ id: 'call_slow_1', name: 'bash', args: { command: 'sleep 8; echo slept' } }], when: (p) => lastUserText(p).includes('Start the slow made-up job') });
    state.replies.push({ content: 'Looked at the fence.', delayMs: 2000, when: (p) => lastUserText(p).includes(SECOND) });
    state.replies.push({ content: 'And the garden.', when: (p) => lastUserText(p).includes(FIRST) });

    await app.send('Start the slow made-up job');
    await app.waitFor(`Boolean(document.querySelector('.tool[data-tool="bash"] .tool-status.spin'))`, 15_000, 'the bash row to run');
    await app.send(FIRST);
    await app.waitFor(`document.querySelectorAll('#queue .queue-item').length === 1`, 5_000, 'the first queued row');
    await app.send(SECOND);
    await app.waitFor(`document.querySelectorAll('#queue .queue-item').length === 2`, 5_000, 'the second queued row');

    const row = await app.evaluate(`(() => {
      const it = document.querySelectorAll('#queue .queue-item')[1];
      const b = it.querySelector('.queue-send-now');
      const x = it.querySelector('.queue-remove');
      const r = b.getBoundingClientRect(); const rx = x.getBoundingClientRect(); const ri = it.getBoundingClientRect();
      return { label: b.getAttribute('aria-label'), tip: b.dataset.tip, text: b.textContent.trim(), before: b.nextElementSibling === x, focusable: b.tabIndex === 0 && b.tagName === 'BUTTON', oneLine: r.height <= 26 && Math.abs((r.top + r.bottom) / 2 - (rx.top + rx.bottom) / 2) < 2, inside: r.right <= ri.right && rx.right <= ri.right, size: getComputedStyle(b).fontSize, kickerSize: getComputedStyle(it.querySelector('.queue-kicker')).fontSize, color: getComputedStyle(b).color, kickerColor: getComputedStyle(it.querySelector('.queue-kicker')).color };
    })()`);
    check('row: "Send now" before the ×, with its label and tooltip', row.label === 'Send now' && row.text === 'Send now' && row.tip === 'Stops the current step and sends this message' && row.before, row);
    check('row: a focusable button, in the muted small type of the kicker, on one line inside the row', row.focusable && row.oneLine && row.inside && row.size === row.kickerSize && row.color === row.kickerColor, row);

    // Screenshots: light and dark, at rest and hovered (no transition: a hidden window draws no frames)
    await app.evaluate(`document.querySelectorAll('.queue-send-now').forEach((b) => (b.style.transition = 'none'))`);
    const hoverAt = await app.evaluate(`(() => { const r = document.querySelectorAll('#queue .queue-send-now')[1].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const away = { x: 5, y: 5 };
    const colours = {};
    for (const theme of ['light', 'dark']) {
      await app.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...away });
      await sleep(250);
      const rest = await app.evaluate(`getComputedStyle(document.querySelectorAll('#queue .queue-send-now')[1]).color`);
      await app.screenshotOf(path.join(shots, `queue-send-now-${theme}.png`), '#queue', 12);
      await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverAt });
      await sleep(250);
      const hover = await app.evaluate(`getComputedStyle(document.querySelectorAll('#queue .queue-send-now')[1]).color`);
      await app.screenshotOf(path.join(shots, `queue-send-now-${theme}-hover.png`), '#queue', 12);
      colours[theme] = { rest, hover };
    }
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...away });
    await app.evaluate(`document.documentElement.dataset.theme = 'light'`);
    check('hover: the button gets clearer in both themes', colours.light.rest !== colours.light.hover && colours.dark.rest !== colours.dark.hover, colours);

    // The narrowest window (the app's minimum width, side panes open): the text is cut, the buttons stay whole
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: 960, height: 760, deviceScaleFactor: 2, mobile: false });
    await sleep(300);
    const narrow = await app.evaluate(`(() => {
      const it = document.querySelectorAll('#queue .queue-item')[1];
      const ri = it.getBoundingClientRect(); const b = it.querySelector('.queue-send-now').getBoundingClientRect(); const x = it.querySelector('.queue-remove').getBoundingClientRect(); const t = it.querySelector('.queue-text');
      const col = document.querySelector('.composer-wrap').getBoundingClientRect();
      return { cut: t.scrollWidth > t.clientWidth, whole: b.right <= x.left && x.right <= ri.right && ri.right <= col.right && col.right <= window.innerWidth && b.height <= 26 && it.querySelector('.queue-send-now').scrollWidth <= Math.ceil(b.width) };
    })()`);
    check('narrow window: the message text truncates, the two buttons do not wrap or clip', narrow.cut && narrow.whole, narrow);
    await app.screenshotOf(path.join(shots, 'queue-send-now-narrow.png'), '#queue', 12);
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 2, mobile: false });
    await sleep(300);

    // Send now on the second
    const before = state.requests.length;
    const t0 = Date.now();
    await app.evaluate(`(() => { const b = document.querySelectorAll('#queue .queue-item')[1].querySelector('.queue-send-now'); b.click(); b.click(); })()`);
    const shown = await app
      .waitFor(
        `(() => {
          const bubbles = [...document.querySelectorAll('#messages .msg.user')].map((e) => e.innerText.trim());
          const rows = [...document.querySelectorAll('#queue .queue-item .queue-text')].map((e) => e.textContent.trim());
          const bash = document.querySelector('.tool[data-tool="bash"]');
          const cut = bash && !bash.querySelector('.tool-status.spin');
          return cut && bubbles.filter((t) => t === ${JSON.stringify(SECOND)}).length === 1 && rows.length === 1 && rows[0] === ${JSON.stringify(FIRST)} ? { bubbles, rows } : null;
        })()`,
        2500,
        'the cut and the bubble',
      )
      .catch(() => null);
    const ms = Date.now() - t0;
    check('within about 2 s: the command is cut, the second is a user bubble, the first is still a queued row', !!shown, { ms, shown });
    const after = await app.evaluate(`({ interrupted: /\\bInterrupted\\./.test(document.querySelector('#messages').innerText), composer: document.querySelector('#input').value })`);
    check('no "Interrupted." line and the composer is empty', !after.interrupted && after.composer === '', after);

    const sentReq = await (async () => {
      for (const until = Date.now() + 5000; Date.now() < until; await sleep(50)) {
        const r = state.requests.slice(before).find((x) => x.payload.stream && lastUserText(x.payload).includes(SECOND));
        if (r) return r;
      }
      return null;
    })();
    check('the mock gets a request ending with the second message, without the first', !!sentReq && !userTexts(sentReq.payload).some((t) => t.includes(FIRST)));
    await app.waitIdle(30_000, false);
    const firstReq = state.requests.slice(before).find((x) => x.payload.stream && lastUserText(x.payload).includes(FIRST));
    check('the first is delivered after that step', !!firstReq && state.requests.indexOf(firstReq) > state.requests.indexOf(sentReq));
    const end = await app.evaluate(`(async () => ({
      idle: (await oc.sessions.list()).every((m) => !m.status?.running),
      queue: document.querySelectorAll('#queue .queue-item').length, hidden: document.querySelector('#queue').hidden,
      bubbles: [...document.querySelectorAll('#messages .msg.user')].map((e) => e.innerText.trim()),
      interrupted: /\\bInterrupted\\./.test(document.querySelector('#messages').innerText),
      composer: document.querySelector('#input').value,
      bashRow: document.querySelector('.tool[data-tool="bash"]')?.dataset.state ?? null,
    }))()`);
    check('ends idle with an empty queue, each message once as a bubble, composer empty', end.idle && end.queue === 0 && end.hidden && JSON.stringify(end.bubbles) === JSON.stringify(['Start the slow made-up job', SECOND, FIRST]) && !end.interrupted && end.composer === '', end);
    await app.screenshot(path.join(shots, 'queue-send-now-after.png'));
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer console errors', errors.length === 0, errors.slice(0, 3));
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
