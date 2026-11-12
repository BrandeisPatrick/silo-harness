// Live check of session names in the real window: one session renamed in the sidebar, another with /rename, then
// from a third session the agent is asked in plain words to read the one and message the other by name, and to
// rename its own session; each must reach the right session (checked by id). Also /rename alone (the title edit)
// and /sessions <name>.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/names.js [screenshot-dir]
// Without a key it runs against the mock model, which cannot call tools: only the renames by hand and the
// commands are checked then.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-names-'));
  fs.writeFileSync(path.join(project, 'README.md'), '# Names\n');
  const app = await launch({ mode: 'bypass', project });
  const current = () => app.evaluate(`oc.sessions.current().then((m) => m.id)`);
  const meta = (id) => app.evaluate(`oc.sessions.list().then((l) => l.find((m) => m.id === ${JSON.stringify(id)}) ?? null)`);
  const transcript = (id) => app.evaluate(`oc.rpc('sessions.transcript', ${JSON.stringify(id)})`);
  const notices = () => app.evaluate(`[...document.querySelectorAll('.msg.system')].map((e) => e.innerText)`);
  const row = (id) => `.session-item[data-id="${id}"]`;
  const nothingRuns = `(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`;
  const newSession = async () => {
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('#empty-state') && !document.querySelector('#empty-state').hidden`, 10_000, 'a new session');
  };
  /** A session with one short exchange, so it is stored and listed */
  const started = async (word) => {
    await app.send(`Reply with exactly: ${word}`);
    await app.waitIdle();
    return current();
  };
  try {
    if (!app.live) console.log('No API key: running against the mock model (only the renames by hand and the commands are checked).');

    // ---- A: renamed in the sidebar ----
    const A = await started('ATLAS');
    await app.waitFor(`Boolean(document.querySelector('${row(A)}'))`, 10_000, 'the row of A');
    await app.evaluate(`document.querySelector('${row(A)}').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await app.waitFor(`Boolean(document.querySelector('${row(A)} .rename-input'))`, 3000, 'the rename field');
    await app.fill(`${row(A)} .rename-input`, 'Atlas notes');
    await app.key('Enter');
    await app.waitFor(`document.querySelector('${row(A)} .label')?.innerText === 'Atlas notes'`, 5000, 'the new title in the sidebar');
    check('A renamed in the sidebar, the title locked', (await meta(A))?.title === 'Atlas notes' && (await meta(A))?.titleLocked === true, await meta(A));

    // ---- B: renamed with /rename ----
    await newSession();
    const B = await started('BEACON');
    await app.send('/rename Beacon (fork)');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /Renamed this session to "Beacon \\(fork\\)"/.test(e.innerText))`, 10_000, 'the /rename notice');
    check('B renamed with /rename', (await meta(B))?.title === 'Beacon (fork)' && (await meta(B))?.titleLocked === true, await meta(B));
    check('the top bar and the sidebar show it', (await app.text('#session-title')) === 'Beacon (fork)' && (await app.evaluate(`document.querySelector('${row(B)} .label')?.innerText`)) === 'Beacon (fork)');
    // /rename alone: the title in the top bar turns editable; Escape leaves it as it was
    await app.send('/rename');
    await app.waitFor(`document.querySelector('#session-title').classList.contains('editing') && document.activeElement?.id === 'session-title'`, 5000, 'the title edit');
    check('/rename alone starts the title edit', true);
    await app.screenshot(path.join(shots, '1-rename-title-edit.png'));
    await app.key('Escape');
    await app.waitFor(`!document.querySelector('#session-title').classList.contains('editing')`, 3000, 'the edit to end');
    check('Escape keeps the name', (await meta(B))?.title === 'Beacon (fork)');
    await app.send('/rename Atlas notes');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /also called that/.test(e.innerText))`, 10_000, 'the namesake warning');
    check('/rename to a name in use says so', (await notices()).some((t) => t.includes(A) && /ambiguous/.test(t)), (await notices()).slice(-1));
    await app.send('/rename Beacon (fork)');
    await app.waitFor(`(async () => (await oc.sessions.current()).title === 'Beacon (fork)')()`, 10_000, 'the name back');

    // ---- C: finds them by name ----
    await newSession();
    await app.send('/sessions atlas');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /Sessions matching "atlas"/.test(e.innerText))`, 10_000, 'the /sessions notice');
    check('/sessions <name> finds A', (await notices()).some((t) => /Sessions matching "atlas" \(1\)/.test(t) && t.includes(A)), (await notices()).slice(-1));
    await app.send('/send beacon fork: Reply with exactly: GOT IT');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /Sent to "Beacon \\(fork\\)"/.test(e.innerText))`, 10_000, 'the /send notice');
    check('/send by a loose name reaches B', (await transcript(B)).some((i) => i.role === 'user' && /GOT IT/.test(i.text)));
    await app.waitFor(nothingRuns, 120_000, 'B to answer');

    if (app.live) {
      await app.send('Read the session called atlas notes and tell me, in one line, what it last replied.');
      await app.waitIdle(180_000);
      const C = await current();
      let tc = await transcript(C);
      const reads = tc.filter((i) => i.role === 'tool' && i.name === 'session_read');
      check('C read A by name (session_read reached A)', reads.some((i) => i.ok && i.result.startsWith(`Session ${A} "Atlas notes"`)), tc.filter((i) => i.role === 'tool').map((i) => [i.name, i.args, i.result.slice(0, 120)]));
      check('the answer has what A said', /ATLAS/.test(await app.lastReply()), await app.lastReply());

      const bBefore = (await transcript(B)).length;
      await app.send('Send a message to the session called "beacon fork" asking it to reply with exactly: HELLO FROM C. Do not wait for its answer.');
      await app.waitIdle(180_000);
      await app.waitFor(nothingRuns, 180_000, 'B to answer');
      tc = await transcript(C);
      const sends = tc.filter((i) => i.role === 'tool' && i.name === 'session_send' && i.ok);
      check('C messaged B by name (session_send reached B)', sends.some((i) => i.result.startsWith(`Delivered to "Beacon (fork)" (${B})`)), tc.filter((i) => i.role === 'tool').map((i) => [i.name, i.args, i.result.slice(0, 160)]));
      const tb = await transcript(B);
      const got = tb.slice(bBefore).find((i) => i.role === 'user' && i.origin === 'session' && i.from === C);
      check('B got the message, from C', Boolean(got) && /HELLO FROM C/.test(got.text), tb.slice(bBefore).map((i) => [i.role, i.origin, i.from, (i.text ?? '').slice(0, 80)]));
      check('B answered it', tb.slice(bBefore).some((i) => i.role === 'assistant' && /HELLO FROM C/.test(i.text)));
      check('A got nothing', !(await transcript(A)).some((i) => i.role === 'user' && /HELLO FROM C/.test(i.text ?? '')));
      // With the head line's wording B answers in its reply; a message back is allowed but should be rare, and the
      // app pauses the two after PEER_CAP messages whatever the model does. The parent's twenty-run check counts this line.
      const back = tb.slice(bBefore).filter((i) => i.role === 'tool' && i.name === 'session_send').length;
      const tcNow = await transcript(C);
      const asked = tcNow.findIndex((i) => i.role === 'user' && i.origin === undefined && /HELLO FROM C/.test(i.text ?? ''));
      const toC = tcNow.slice(asked).filter((i) => i.role === 'user' && i.origin === 'session' && i.from === B).length;
      const toB = tb.slice(bBefore).filter((i) => i.role === 'user' && i.origin === 'session' && i.from === C).length;
      console.log(`info: B sent ${back} message(s) back to C; messages that reached B or C: ${toB + toC}`);
      check('the exchange between B and C stayed within the pause limit (4 messages)', asked >= 0 && toB + toC <= 4, { toB, toC });

      await app.send('Call this session Comet log.');
      await app.waitIdle(120_000);
      tc = await transcript(C);
      check('C renamed itself through session_rename', tc.some((i) => i.role === 'tool' && i.name === 'session_rename' && i.ok) && (await meta(C))?.title === 'Comet log' && (await meta(C))?.titleLocked === true, [(await meta(C))?.title, tc.filter((i) => i.role === 'tool').map((i) => i.name)]);
      check('the top bar follows', (await app.text('#session-title')) === 'Comet log');
      await app.unfold();
      await app.evaluate(`document.querySelectorAll('details.tool-group').forEach((d) => { d.open = true; })`);
      await sleep(400);
      check('the tool row reads as words', await app.evaluate(`[...document.querySelectorAll('.tool')].some((e) => /Rename session/.test(e.innerText) && !/session_rename/.test(e.innerText))`));
      await app.screenshot(path.join(shots, '2-found-by-name.png'));
    }
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
