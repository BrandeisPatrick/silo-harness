// Live check of a run's line ("Ran 4 commands") while the run goes on, driven with real mouse and key input
// (CDP Input events, not el.click()) in the hidden window against the mock model. One user turn of several model
// replies, each with slow shell calls, keeps the line live for seconds. Checks: a click opens the list and it stays
// open while more calls join, a second click shuts it and it stays shut, and the run's end keeps that choice; no row
// opens by itself (a lone call opens to its details only once the run is over); the line does not jump under the
// pointer (no chevron riding on the end of the changing words, no scroll away from it); a mouse click leaves no focus
// ring and the composer keeps the focus (on the line, on a row in it and on the turn's header); keyboard focus still
// shows the ring, and Enter and Space toggle the line. Opened while live, the line heads its list in the present
// ("Running 2 commands") instead of repeating the row of the call in flight; shut, it reads like that row again.
// Run: npm run build && node test/live/group-live.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const { check, done } = checker();

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const app = await launch({ mode: 'bypass', mock: true, size: { width: 1200, height: 800 } });
  const replies = app.mock.state.replies;
  const nothingRuns = `(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`;
  const idle = async () => {
    await app.waitFor(nothingRuns, 60_000, 'the run to end');
    await sleep(400);
  };
  // The hidden window is never the focused one: focus emulation lets the page keep a focused element as a shown one would
  await app.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  const G = `[...document.querySelectorAll('#messages > .tool-group')].pop()`;
  const liveWith = (n) => `(() => { const g = ${G}; return Boolean(g && g.classList.contains('live') && g.querySelectorAll(':scope > .group-body > .tool').length === ${n}); })()`;

  /** A real left click 40px into an element (on its words), as the mouse gives it */
  async function realClick(js) {
    const p = await app.evaluate(`(() => { const e = ${js}; const r = e.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(60);
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(150);
  }
  const press = async (key) => {
    const k = key === 'Enter' ? { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' } : key === ' ' ? { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' } : { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key };
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined });
    await sleep(150);
  };
  const state = () =>
    app.evaluate(`(() => {
      const g = ${G}; if (!g) return null;
      const s = g.querySelector(':scope > summary');
      return { open: g.open, live: g.classList.contains('live'), rows: [...g.querySelectorAll(':scope > .group-body > .tool')].map((r) => r.open), words: s.querySelector('.group-verb').textContent, ring: s.matches(':focus-visible'), focused: document.activeElement === s, top: Math.round(s.getBoundingClientRect().top) };
    })()`);
  /** Samples the last line every 50 ms: open, its rows, where its chevron is drawn (null: not drawn) and its top */
  const record = () =>
    app.evaluate(`(() => { window.__log = []; clearInterval(window.__rec); window.__rec = setInterval(() => { const g = ${G}; if (!g) return; const s = g.querySelector(':scope > summary'); const c = s.querySelector('.tool-chevron'); const shown = getComputedStyle(c).display !== 'none'; window.__log.push({ open: g.open, live: g.classList.contains('live'), rows: [...g.querySelectorAll(':scope > .group-body > .tool')].map((r) => (r.open ? 1 : 0)).join(''), chev: shown ? Math.round(c.getBoundingClientRect().x) : null, top: Math.round(s.getBoundingClientRect().top) }); }, 50); })()`);
  const stop = () => app.evaluate(`(() => { clearInterval(window.__rec); return window.__log; })()`);

  try {
    // Enough transcript that it scrolls
    for (let i = 0; i < 3; i++) {
      replies.push({ content: `Filler ${i}. ` + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(14) });
      await app.send(`filler ${i}`);
      await idle();
    }

    // ---------- 1. Opened while its first call runs; three more calls join; the run ends ----------
    replies.push({ content: '', toolCalls: [{ id: 'a1', name: 'bash', args: { command: 'sleep 3; echo one' } }] });
    replies.push({ content: '', toolCalls: [{ id: 'a2', name: 'bash', args: { command: 'sleep 2; echo two-and-a-much-longer-command-line-than-the-first' } }] });
    replies.push({ content: '', toolCalls: [{ id: 'a3', name: 'bash', args: { command: 'sleep 2; echo 3' } }, { id: 'a4', name: 'bash', args: { command: 'sleep 1; echo four' } }] });
    replies.push({ content: 'All four commands ran.' });
    await app.send('Run the commands');
    await app.waitFor(liveWith(1), 15_000, 'the live line');
    await app.evaluate(`document.querySelector('#input').focus()`);
    const before = await state();
    await realClick(`${G}.querySelector(':scope > summary')`);
    await record();
    let s = await state();
    check('1: a click on the live line opens it', s.open && s.live, s);
    check('1: opening it does not move the line', s.top === before.top, { before: before.top, after: s.top });
    check('1: a mouse click leaves no focus ring and the composer keeps the focus', !s.ring && !s.focused && (await app.evaluate(`document.activeElement === document.querySelector('#input')`)), s);
    await press('h');
    s = await state();
    check('1: the next key types in the composer, no ring on the line, the line stays open', !s.ring && s.open && (await app.evaluate(`document.querySelector('#input').value`)) === 'h', s);
    await app.fill('#input', '');
    await app.screenshot(path.join(shots, 'group-live-1-open.png'));
    await app.waitFor(liveWith(2), 15_000, 'the second call');
    await sleep(300);
    s = await state();
    check('1: a call joins: the list stays open, no row opened by itself', s.open && s.rows.every((r) => !r), s);
    check('1: the line moved at most a row as the view followed the bottom', before.top - s.top <= 30, { before: before.top, now: s.top });
    await idle();
    const log1 = await stop();
    const live1 = log1.filter((e) => e.live);
    const chevs = new Set(live1.map((e) => e.chev).filter((x) => x !== null));
    check('1: while live, no chevron moves along with the words', chevs.size <= 1, [...chevs]);
    check('1: the list never shut by itself and no row ever opened by itself', log1.length > 10 && log1.every((e) => e.open && !e.rows.includes('1')), log1.filter((e) => !e.open || e.rows.includes('1')).slice(0, 3));
    await app.unfold();
    await sleep(300);
    s = await state();
    check('1: after the run the line reads "Ran 4 commands" and is still open', s.words === 'Ran 4 commands' && s.open && !s.live && s.rows.length === 4 && s.rows.every((r) => !r), s);
    await app.screenshot(path.join(shots, 'group-live-1-after.png'));

    // ---------- 2. Opened, then shut again while live; it stays shut ----------
    replies.push({ content: '', toolCalls: [{ id: 'b1', name: 'bash', args: { command: 'sleep 2; echo b1' } }] });
    replies.push({ content: '', toolCalls: [{ id: 'b2', name: 'bash', args: { command: 'sleep 2; echo b2' } }] });
    replies.push({ content: 'Done twice.' });
    await app.send('Second turn');
    await app.waitFor(liveWith(1), 15_000, 'the live line (2)');
    await realClick(`${G}.querySelector(':scope > summary')`);
    await realClick(`${G}.querySelector(':scope > summary')`);
    await record();
    s = await state();
    check('2: a second click shuts it', !s.open, s);
    await idle();
    const log2 = await stop();
    check('2: it stays shut while the next call joins and the run ends', log2.length > 10 && log2.every((e) => !e.open), log2.filter((e) => e.open).slice(0, 2));
    await app.unfold();
    s = await state();
    check('2: after the run "Ran 2 commands", still shut', s.words === 'Ran 2 commands' && !s.open, s);

    // ---------- 3. Keyboard: the ring shows, Enter and Space toggle ----------
    replies.push({ content: '', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'sleep 3; echo c1' } }] });
    replies.push({ content: '', toolCalls: [{ id: 'c2', name: 'bash', args: { command: 'sleep 2; echo c2' } }] });
    replies.push({ content: 'Keys done.' });
    await app.send('Third turn');
    await app.waitFor(liveWith(1), 15_000, 'the live line (3)');
    await app.evaluate(`${G}.querySelector(':scope > summary').focus()`);
    await press('Enter');
    s = await state();
    check('3: Enter opens the focused live line, with the focus ring', s.open && s.ring && s.rows.every((r) => !r), s);
    await press(' ');
    s = await state();
    check('3: Space shuts it', !s.open && s.ring, s);
    await press(' ');
    s = await state();
    check('3: Space opens it again', s.open, s);
    await idle();

    // ---------- 4. A row inside a live line; a click between two calls; the turn header ----------
    replies.push({ content: '', toolCalls: [{ id: 'e1', name: 'bash', args: { command: 'sleep 3; echo e1' } }] });
    replies.push({ content: '', toolCalls: [{ id: 'e2', name: 'bash', args: { command: 'sleep 3; echo e2' } }], delayMs: 1500 });
    replies.push({ content: 'Rows done.' });
    await app.send('Fourth turn');
    await app.waitFor(liveWith(1), 15_000, 'the live line (4)');
    await app.evaluate(`document.querySelector('#input').focus()`);
    // Between two calls: the first is done, the next reply is held back 1.5 s
    await app.waitFor(`(() => { const g = ${G}; return g && g.classList.contains('live') && !g.querySelector('.tool-status.spin'); })()`, 15_000, 'a pause between calls');
    await realClick(`${G}.querySelector(':scope > summary')`);
    s = await state();
    check('4: a click between two calls opens the line', s.open && s.live && s.rows.every((r) => !r), s);
    await app.waitFor(liveWith(2), 15_000, 'the second call (4)');
    await realClick(`${G}.querySelector(':scope > .group-body > .tool:last-child > summary')`);
    await press('h');
    const row = await app.evaluate(`(() => { const r = ${G}.querySelector(':scope > .group-body > .tool:last-child'); const s = r.querySelector(':scope > summary'); return { open: r.open, ring: s.matches(':focus-visible'), focused: document.activeElement === s, typed: document.querySelector('#input').value }; })()`);
    check('4: a row clicked inside the live line opens, without a focus ring; the key goes to the composer', row.open && !row.ring && !row.focused && row.typed === 'h', row);
    await app.fill('#input', '');
    await idle();
    s = await state();
    await app.unfold();
    const rows4 = await app.evaluate(`[...${G}.querySelectorAll(':scope > .group-body > .tool')].map((r) => r.open)`);
    check('4: the row the user opened is still open after the run, the other is not', rows4.length === 2 && !rows4[0] && rows4[1], rows4);
    await app.evaluate(`document.querySelector('#input').focus()`);
    await realClick(`[...document.querySelectorAll('#messages > .turn-head .turn-head-btn')].pop()`);
    await press('h');
    const head = await app.evaluate(`(() => { const b = [...document.querySelectorAll('#messages > .turn-head .turn-head-btn')].pop(); return { ring: b.matches(':focus-visible'), focused: document.activeElement === b, expanded: b.getAttribute('aria-expanded'), typed: document.querySelector('#input').value }; })()`);
    check('4: the turn header clicked folds, without a focus ring; the key goes to the composer', head.expanded === 'false' && !head.ring && !head.focused && head.typed === 'h', head);
    await app.fill('#input', '');

    // ---------- 5. A finished lone call still opens straight to its details ----------
    replies.push({ content: '', toolCalls: [{ id: 'f1', name: 'bash', args: { command: 'echo lone' } }] });
    replies.push({ content: 'Lone call done.' });
    await app.send('Fifth turn');
    await idle();
    await app.unfold();
    await app.evaluate(`${G}.scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await realClick(`${G}.querySelector(':scope > summary')`);
    s = await state();
    check('5: a finished one-call line opens to its row', s.open && s.rows.length === 1 && s.rows[0], s);

    // ---------- 6. Scrolled up a little: opening the live line and the calls after it do not move it ----------
    replies.push({ content: '', toolCalls: [{ id: 'g1', name: 'bash', args: { command: 'sleep 3; echo g1' } }] });
    replies.push({ content: '', toolCalls: [{ id: 'g2', name: 'bash', args: { command: 'sleep 2; echo g2' } }] });
    replies.push({ content: 'Scrolled.' });
    await app.send('Sixth turn');
    await app.waitFor(liveWith(1), 15_000, 'the live line (6)');
    await sleep(300);
    await app.evaluate(`document.querySelector('#messages').scrollTop -= 80`);
    await sleep(200);
    await record();
    const top6 = (await state()).top;
    await realClick(`${G}.querySelector(':scope > summary')`);
    await idle();
    const log6 = (await stop()).filter((e) => e.live);
    check('6: scrolled up, the opened live line stays where it was', log6.length > 10 && log6.every((e) => e.top === top6), [...new Set(log6.map((e) => e.top))]);

    // ---------- 7. Opened while live, the line heads the list in the present; shut, it reads like the call in flight ----------
    replies.push({ content: '', toolCalls: [{ id: 'h1', name: 'bash', args: { command: 'sleep 3; echo h1' } }] });
    replies.push({ content: '', toolCalls: [{ id: 'h2', name: 'bash', args: { command: 'sleep 3; echo h2' } }] });
    replies.push({ content: 'Headings done.' });
    await app.send('Seventh turn');
    await app.waitFor(liveWith(1), 15_000, 'the live line (7)');
    await app.evaluate(`document.querySelector('#messages').scrollTop = 1e6`);
    await sleep(200);
    const words = () =>
      app.evaluate(`(() => {
        const g = ${G}; const s = g.querySelector(':scope > summary');
        const t = (e, q) => (e.querySelector(q)?.textContent ?? '').trim();
        const line = [t(s, '.group-verb'), t(s, '.group-arg')].filter(Boolean).join(' ');
        const rows = [...g.querySelectorAll(':scope > .group-body > .tool')].map((r) => ({ verb: t(r, ':scope > summary > .tool-verb'), line: [t(r, ':scope > summary > .tool-verb'), t(r, ':scope > summary > .tool-arg')].filter(Boolean).join(' '), icon: r.dataset.icon, running: Boolean(r.querySelector('.tool-status.spin')) }));
        return { open: g.open, live: g.classList.contains('live'), line, aria: s.getAttribute('aria-label'), icon: s.querySelector('.group-icon').dataset.kind ?? 'files', rows };
      })()`);
    let w = await words();
    check('7: shut and live, the line reads like the row of the call in flight', !w.open && w.live && w.line === w.rows[0].line, w);
    await realClick(`${G}.querySelector(':scope > summary')`);
    w = await words();
    check('7: opened with one call in flight it reads "Running a command", and so does its label', w.open && w.live && w.line === 'Running a command' && w.aria === 'Running a command', w);
    check('7: opened, the line carries the words of none of its rows; the icon stays the call in flight\'s', w.rows.every((r) => r.line !== w.line && r.verb !== w.line) && w.icon === w.rows[0].icon, w);
    await app.waitFor(liveWith(2), 15_000, 'the second call (7)');
    await sleep(200);
    w = await words();
    check('7: a second call joins: "Running 2 commands", no row repeated', w.open && w.line === 'Running 2 commands' && w.aria === 'Running 2 commands' && w.rows.every((r) => r.line !== w.line), w);
    await realClick(`${G}.querySelector(':scope > summary')`);
    w = await words();
    const inFlight = w.rows.filter((r) => r.running).pop() ?? w.rows[w.rows.length - 1];
    check('7: shut again, it reads like the row of the call in flight', !w.open && w.live && w.line === inFlight.line && /echo h2/.test(w.line), w);
    await realClick(`${G}.querySelector(':scope > summary')`);
    await idle();
    await app.unfold();
    w = await words();
    check('7: after the run, "Ran 2 commands" in the past, still open', w.open && !w.live && w.line === 'Ran 2 commands' && w.aria === 'Ran 2 commands', w);

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
