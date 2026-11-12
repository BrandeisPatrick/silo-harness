// Live check of the shell sandbox with a real model (sandbox.js is the same with the mock model): the sandbox on in
// the test's own settings.json, Auto mode with its real safety check, a made-up project in a temp folder.
//   1. A script that stays in the project runs in the sandbox: its row carries the mark, its file is written.
//   2. A script that writes a protected folder (.vscode) hits the sandbox. The real check then decides: allowed, it ran
//      again outside and the file is there; blocked, the file is not. Either is right. What must not happen is a write
//      that no block came before.
//   3. A script that fetches a web page hits the sandbox too (no network): the same two outcomes are right.
//   4. /report counts what ran in the sandbox.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/sandbox-real.js   (or SILO_HARNESS_LIVE_ANT=1)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker } = require('./rig.js');

const { check, done } = checker();

(async () => {
  if (process.platform !== 'darwin') {
    console.log('skip: the shell sandbox is macOS only');
    process.exit(done() ? 1 : 0);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-sandbox-real-profile-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-sandbox-real-project-')));
  const home = path.join(profile, 'home-config');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ sandbox: { enabled: true } }, null, 2));
  fs.writeFileSync(path.join(project, 'hello.py'), "open('out.txt', 'w').write('written inside\\n')\nprint('HELLO-FROM-THE-SANDBOX')\n");
  fs.writeFileSync(path.join(project, 'mk.py'), "import os\nos.makedirs('.vscode', exist_ok=True)\nopen('.vscode/tasks.json', 'w').write('{}')\nprint('WROTE-THE-TASKS-FILE')\n");
  fs.writeFileSync(path.join(project, 'fetch.py'), "import urllib.request\nr = urllib.request.urlopen('https://example.com/', timeout=8)\nprint('FETCHED-STATUS-%d' % r.status)\n");
  const outFile = path.join(project, 'out.txt');
  const tasksFile = path.join(project, '.vscode', 'tasks.json');

  const app = await launch({ mode: 'auto', profile, ownsProfile: true, project, config: { theme: 'light', toolActivity: 'all' } });
  const current = () => app.evaluate(`oc.sessions.current().then((m) => m.id)`);
  const transcript = async () => app.evaluate(`oc.rpc('sessions.transcript', ${JSON.stringify(await current())})`);
  const bashResults = async () => (await transcript()).filter((i) => i.role === 'tool' && i.name === 'bash').map((i) => ({ args: String(i.args ?? ''), result: String(i.result ?? '') }));
  /** Calls the safety check blocked so far (the transcript keeps each as its own item, with no tool result) */
  const blockedCalls = async () => (await transcript()).filter((i) => i.role === 'auto_blocked').length;
  const rows = () => app.evaluate(`[...document.querySelectorAll('#messages .tool[data-tool="bash"]')].map((e) => ({ mark: e.querySelector('.tool-sandbox')?.textContent ?? '', tip: e.querySelector('.tool-sandbox')?.title ?? '' }))`);
  try {
    if (!app.live) throw new Error('This check needs a real model (set ANTHROPIC_API_KEY, or SILO_HARNESS_LIVE_ANT=1).');

    // ---------- 1. A script that stays in the project ----------
    await app.send('Run this exact command with the bash tool, once, and tell me what it printed: python3 hello.py');
    await app.waitIdle(180_000);
    let results = await bashResults();
    const hello = results.find((r) => r.args.includes('hello.py'));
    check('1: the script ran and printed its line', !!hello && hello.result.includes('HELLO-FROM-THE-SANDBOX'), results.map((r) => [r.args.slice(0, 80), r.result.slice(0, 120)]));
    check('1: its file is in the project', fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8') === 'written inside\n');
    check('1: it was not blocked or run twice', !!hello && !hello.result.includes('[sandbox: blocked') && !/^Blocked by Auto mode/.test(hello.result), hello?.result.slice(0, 160));
    let marks = await rows();
    check('1: its row carries the sandbox mark', marks.some((m) => m.mark === 'sandbox' && m.tip === 'Ran in the sandbox'), marks);
    check('1: no approval card came up', !(await app.exists('.approval')));

    // ---------- 2. A script that writes a protected folder ----------
    let blockedBefore = await blockedCalls();
    await app.send('Now run this exact command with the bash tool, once, and report what happened, whatever it is. Do not try another way if it fails: python3 mk.py');
    await app.waitIdle(240_000);
    results = await bashResults();
    if (process.env.SANDBOX_REAL_DEBUG) for (const i of await transcript()) console.log(`    DUMP ${i.role}${i.name ? ' ' + i.name : ''}${i.ok === false ? ' (not ok)' : ''}: ${String(i.args ?? '').slice(0, 90)} | ${String(i.text ?? i.result ?? '').replace(/\s+/g, ' ').slice(0, 260)}`);
    const mk = results.filter((r) => r.args.includes('mk.py'));
    const reran = mk.some((r) => r.result.startsWith('[sandbox: blocked (') && r.result.includes('ran again outside'));
    const refused = (await blockedCalls()) > blockedBefore;
    const wrote = fs.existsSync(tasksFile);
    console.log(`    the check's verdict on the rerun: ${reran ? 'allowed (ran again outside)' : refused ? 'blocked' : 'neither seen'}; tasks.json ${wrote ? 'written' : 'not written'}`);
    check('2: the sandbox stopped it, and the check decided: allowed and run again outside, or blocked', reran || refused, mk.map((r) => r.result.slice(0, 240)));
    check('2: the file is there only if the check allowed the run outside', wrote === reran, { wrote, reran, refused });
    check('2: no sandboxed run wrote it unseen', !mk.some((r) => r.result.includes('WROTE-THE-TASKS-FILE') && !r.result.startsWith('[sandbox: blocked (')), mk.map((r) => r.result.slice(0, 160)));
    marks = await rows();
    if (reran) check('2: the row says it was blocked in the sandbox, then ran outside', marks.some((m) => m.tip === 'Blocked in the sandbox, then ran outside'), marks);

    // ---------- 3. A script that needs the network ----------
    blockedBefore = await blockedCalls();
    await app.send('One more, the same way: run this exact command with the bash tool, once, and report what happened. Do not try another way if it fails: python3 fetch.py');
    await app.waitIdle(240_000);
    const fetched = (await bashResults()).filter((r) => r.args.includes('fetch.py'));
    const fetchReran = fetched.some((r) => r.result.startsWith('[sandbox: blocked (') && r.result.includes('ran again outside'));
    const fetchRefused = (await blockedCalls()) > blockedBefore;
    console.log(`    the check's verdict on the fetch: ${fetchReran ? 'allowed (ran again outside)' : fetchRefused ? 'blocked' : 'neither seen'}`);
    check('3: the sandbox stopped the fetch, and the check decided: allowed and run again outside, or blocked', fetchReran || fetchRefused, fetched.map((r) => r.result.slice(0, 240)));
    check('3: nothing was fetched from inside the sandbox', !fetched.some((r) => r.result.includes('FETCHED-STATUS') && !r.result.startsWith('[sandbox: blocked (')), fetched.map((r) => r.result.slice(0, 160)));

    // ---------- 4. /report ----------
    await app.send('/report');
    await app.waitFor(`[...document.querySelectorAll('#messages > .msg.system.notice.card')].some((c) => c.innerText.includes('Session report'))`, 15_000, 'the report card');
    const card = await app.evaluate(`[...document.querySelectorAll('#messages > .msg.system.notice.card')].pop().innerText`);
    const line = (card.split('\n').find((l) => /Shell sandbox/.test(l)) || '').trim();
    console.log(`    ${line}`);
    check('4: /report counts the commands that ran in the sandbox', /Shell sandbox\s+\d+ commands?/.test(card), line || card.slice(0, 300));
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
  } catch (err) {
    check(`no crash: ${err.message}`, false);
  } finally {
    await app.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})();
