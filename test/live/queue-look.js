// Live check of the bands round the status line and the queued messages, which float over the transcript's foot. A
// run is kept going with a slow shell call and a second message waits in the queue; then, light and dark, with and
// without a background (the bundled backgrounds mod): without one the bands are the opaque --bg-100 gradients they
// always were and the transcript has no mask; with one neither band paints a surface (the window shows through), the
// transcript's foot fades out under them instead (only while a row shows), the queued row is still a solid card, and
// "Jump to latest" stays on top and clickable. Screenshots of each, with transcript text running under the rows.
// Run: npm run build && node test/live/queue-look.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const { check, done } = checker();
const rpc = (app, method, ...args) => app.evaluate(`window.oc.rpc(${JSON.stringify(method)}, ...${JSON.stringify(args)})`);

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const app = await launch({ mode: 'bypass', mock: true, size: { width: 1200, height: 800 }, config: { theme: 'light' } });
  const replies = app.mock.state.replies;
  const nothingRuns = `(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`;
  const setTheme = async (scheme) => {
    await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = ${JSON.stringify(scheme)}; await window.oc.setConfig(c); document.documentElement.dataset.theme = ${JSON.stringify(scheme)}; })()`);
    await sleep(700);
  };
  /** What the bands and the transcript's foot paint */
  const look = () =>
    app.evaluate(`(() => {
      const cs = (s) => getComputedStyle(document.querySelector(s));
      const band = (s) => ({ image: cs(s).backgroundImage, color: cs(s).backgroundColor });
      const m = cs('#messages');
      const alpha = (c) => { const x = /rgba?\\(([^)]+)\\)/.exec(c); if (!x) return 1; const p = x[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };
      const item = document.querySelector('.queue-item');
      return { status: band('#status-line'), queue: band('#queue'), mask: m.webkitMaskImage || m.maskImage, itemAlpha: item ? alpha(getComputedStyle(item).backgroundColor) : null, modBg: document.documentElement.classList.contains('mod-bg'), statusShown: !document.querySelector('#status-line').hidden, queueShown: !document.querySelector('#queue').hidden };
    })()`);
  /** Scrolls up, then whether "Jump to latest" is the element under its own centre, and that clicking it goes down */
  const jump = async () => {
    await app.evaluate(`document.querySelector('#messages').scrollTop = 0; document.querySelector('#messages').dispatchEvent(new Event('scroll'))`);
    await app.evaluate(`document.querySelector('#jump-latest').hidden = false`);
    await sleep(150);
    const r = await app.evaluate(`(() => { const b = document.querySelector('#jump-latest'); const r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { onTop: Boolean(at && at.closest('#jump-latest')), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()`);
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(300);
    r.wentDown = await app.evaluate(`(() => { const m = document.querySelector('#messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 64 && document.querySelector('#jump-latest').hidden; })()`);
    return r;
  };

  try {
    // Transcript text that runs under the rows
    for (let i = 1; i <= 3; i++) {
      replies.push({ content: `Note ${i}. ` + 'The quick brown fox jumps over the lazy dog while the build runs and the tests report back. '.repeat(10) });
      await app.send(`Tell me something long ${i}`);
      await app.waitFor(nothingRuns, 30_000, 'a filler reply');
    }
    // A run that goes on, and a second message queued behind it
    replies.push({ content: 'Let me run the slow check. ' + 'It prints a long report as it goes, line after line, so there is text at the foot. '.repeat(6), toolCalls: [{ id: 'q1', name: 'bash', args: { command: 'sleep 40; echo done' } }] });
    replies.push({ content: 'The slow check passed.' });
    replies.push({ content: 'And the queued one is answered.' });
    await app.send('Run the slow check');
    await app.waitFor(`Boolean(document.querySelector('#messages > .tool-group.live'))`, 15_000, 'the slow call');
    await app.send('Then summarise the results');
    await app.waitFor(`!document.querySelector('#queue').hidden && document.querySelector('.queue-item')`, 10_000, 'the queued message');
    await app.evaluate(`document.querySelector('#messages').scrollTop = 1e6`);
    await sleep(500);

    const before = await look();
    check('a run goes on with a queued message: both rows show', before.statusShown && before.queueShown, before);
    check('no background: the status line keeps its opaque gradient band', !before.modBg && /gradient/.test(before.status.image), before.status);
    check('no background: the queue keeps its opaque gradient band', /gradient/.test(before.queue.image), before.queue);
    check('no background: the transcript has no mask', before.mask === 'none', before.mask);

    for (const scheme of ['light', 'dark']) {
      await setTheme(scheme);
      for (const bg of [null, 'aurora']) {
        await rpc(app, 'mods.setLayout', { background: bg ? `backgrounds/${bg}` : null, backgroundDim: 0.6 });
        if (bg) await app.waitFor(`window.__oc_debug.mods.views().find((v) => v.key === 'backgrounds/${bg}')?.hello`, 8000, 'the background').catch(() => {});
        await sleep(bg ? 1500 : 600);
        await app.evaluate(`document.querySelector('#messages').scrollTop = 1e6`);
        await sleep(300);
        const l = await look();
        const name = `${scheme}-${bg ?? 'none'}`;
        if (bg) {
          check(`${name}: the status line paints no band`, l.modBg && l.status.image === 'none' && l.status.color === 'rgba(0, 0, 0, 0)', l.status);
          check(`${name}: the queue paints no band`, l.queue.image === 'none' && l.queue.color === 'rgba(0, 0, 0, 0)', l.queue);
          check(`${name}: the transcript's foot fades out under the rows`, /linear-gradient/.test(l.mask) && /transparent|rgba\(0, 0, 0, 0\)/.test(l.mask), l.mask);
          check(`${name}: the queued row is still a solid card`, l.itemAlpha === 1, l.itemAlpha);
        } else {
          check(`${name}: the opaque bands, no mask`, /gradient/.test(l.status.image) && /gradient/.test(l.queue.image) && l.mask === 'none' && (scheme === 'dark' || JSON.stringify(l) === JSON.stringify(before)), l);
        }
        await app.screenshot(path.join(shots, `queue-${name}.png`));
        // A little way up, so text runs under the rows
        await app.evaluate(`document.querySelector('#messages').scrollTop -= 70`);
        await sleep(300);
        await app.screenshot(path.join(shots, `queue-${name}-under.png`));
        const j = await jump();
        check(`${name}: "Jump to latest" is on top and takes the click`, j.onTop && j.wentDown, j);
      }
    }
    await rpc(app, 'mods.setLayout', { background: null });
    await setTheme('light');
    const after = await look();
    check('background off again: the same computed styles as before it was on', JSON.stringify(after) === JSON.stringify(before), { before, after });

    // Once the rows are gone (the slow call ends, the queued message is answered) the foot is not masked
    await rpc(app, 'mods.setLayout', { background: 'backgrounds/aurora', backgroundDim: 0.82 });
    await app.waitFor(nothingRuns, 90_000, 'the runs to end');
    await app.waitFor(`document.querySelector('#status-line').hidden && document.querySelector('#queue').hidden`, 20_000, 'the rows to go');
    await sleep(300);
    const idle = await look();
    check('with a background and nothing running or queued, the transcript has no mask', idle.mask === 'none', idle);
    await rpc(app, 'mods.setLayout', { background: null });

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await app.close();
  }
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
