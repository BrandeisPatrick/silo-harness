// The remote page, for real: a scripted fake App plays a believable session (history, a streamed reply, a tool
// call, an approval that waits, a plan in another session), the real remote server serves the page from it, and a
// hidden Electron window at phone size loads it. Takes screenshots in light and dark, then drives the page (types
// and sends a message, taps Allow) and checks the fixture received both. Never starts the app itself.
//
// Run (after npm run build):
//   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron test/live/remote-page.js <shots-dir>
const path = require('node:path');
const fs = require('node:fs');
const { app: electron, BrowserWindow, nativeTheme } = require('electron');

const projectDir = path.join(__dirname, '..', '..');
const shots = path.resolve(process.argv[2] || path.join(require('node:os').tmpdir(), 'oa-remote-shots'));
fs.mkdirSync(shots, { recursive: true });
const { setupRemote } = require(path.join(projectDir, 'dist/main/remote.js'));
const { Subagents, messageHead, mergedText } = require(path.join(projectDir, 'dist/main/subagents/service.js'));
const { frameMessage } = require(path.join(projectDir, 'dist/main/schedules/service.js'));
const { fakeApp } = require(path.join(projectDir, 'test/support/fake-app.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` | ${JSON.stringify(detail)}` : ''}`.slice(0, 400));
};

// ---------------------------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------------------------

const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const live = { running: false, text: '', thinking: '', tools: [], approvals: [], queue: [] };
let f;

function seed(store) {
  const a = store.create();
  a.title = 'Fix the flaky login test';
  a.titleLocked = true;
  a.messages.push(
    { role: 'user', content: 'The login test fails about one run in five on CI. Find out why and fix it.' },
    { role: 'assistant', content: "I'll look at the test and the code it covers.", tool_calls: [tc('c1', 'read_file', { path: 'test/auth/login.test.ts' }), tc('c2', 'grep', { pattern: 'retryLogin', path: 'src' })] },
    { role: 'tool', tool_call_id: 'c1', content: "import { login } from '../../src/auth/login';\n\ndescribe('login', () => {\n  it('retries once on 503', async () => {\n    server.failNext(503);\n    await expect(login(user)).resolves.toBeTruthy();\n  });\n});" },
    { role: 'tool', tool_call_id: 'c2', content: 'src/auth/login.ts:42:export async function retryLogin(fn, attempts = 2) {' },
    { role: 'assistant', content: '', tool_calls: [tc('c3', 'bash', { command: 'npm test -- test/auth/login.test.ts --runInBand' })] },
    { role: 'tool', tool_call_id: 'c3', content: 'Error: 1 failing\n\n  login\n    ✗ retries once on 503 (timeout after 5000 ms)' },
    {
      role: 'assistant',
      content:
        'Found it. `retryLogin` waits a **fixed 3 s** before retrying, and the test server answers in up to 2.5 s, so the retry can cross the 5 s test timeout.\n\nThe fix:\n\n1. Make the backoff come from the options, with `250 ms` as the default\n2. Pass `{ backoffMs: 0 }` in the test\n\n```ts\nexport async function retryLogin(fn: () => Promise<Session>, { attempts = 2, backoffMs = 250 } = {}) {\n  for (let i = 0; i < attempts; i++) {\n    try { return await fn(); } catch (err) { if (i === attempts - 1) throw err; }\n    await sleep(backoffMs * 2 ** i);\n  }\n}\n```',
    },
  );
  store.save(a);

  const b = store.create();
  b.title = 'Add dark mode to the settings page';
  b.titleLocked = true;
  const planArgs = {
    title: 'Dark mode for Settings',
    markdown:
      '## Goal\nSettings follows the system theme, with a manual override.\n\n## Steps\n1. Add a `theme` field to `UserPrefs` (`system` | `light` | `dark`)\n2. Move the colours in `settings.css` to custom properties\n3. Add a **Theme** row with a segmented control\n4. Persist the choice and apply it before first paint\n\n## Verification\n- Screenshots of both themes\n- `npm test` stays green',
  };
  b.plans = { 'plan-7': { id: 'plan-7', title: planArgs.title, markdown: planArgs.markdown, status: 'proposed', createdAt: Date.now() - 60_000 } };
  b.messages.push(
    { role: 'user', content: 'Plan dark mode for the settings page. Do not change anything yet.' },
    { role: 'assistant', content: 'I read the settings page and its styles. Here is the plan.', tool_calls: [tc('p1', 'submit_plan', planArgs)] },
    { role: 'tool', tool_call_id: 'p1', content: 'Plan submitted.' },
  );
  store.save(b);

  const c = store.create();
  c.title = 'Refactor the API client';
  c.titleLocked = true;
  // The session, schedule and mod tools, and a command that exited non-zero: each gets a readable row on the phone.
  const tools = [
    [tc('s1', 'session_spawn', { title: 'Split the users module', prompt: 'Move the user routes into src/api/users.ts.' }), 'Started sub-session "Split the users module" (id x1).'],
    [tc('s2', 'session_send', { to: b.id, message: 'The API client is split; rebase on it.' }), `Delivered to "${b.title}" (${b.id}) and it started working on it.`],
    [tc('s3', 'session_list', {}), '3 sessions'],
    [tc('s4', 'session_read', { id: a.id }), 'user: The login test fails…'],
    [tc('s5', 'session_merge', { id: a.title }), 'Merged.'],
    [tc('s6', 'schedule_create', { name: 'Nightly API smoke test', prompt: 'Run the smoke tests.', when: { kind: 'cron', expr: '0 3 * * *' } }), 'Scheduled "Nightly API smoke test" (id s_42): every day at 03:00.'],
    [tc('s7', 'schedule_list', {}), '1 schedule:\ns_42  "Nightly API smoke test"  every day at 03:00'],
    [tc('s8', 'schedule_update', { id: 's_42', enabled: false }), 'Updated: s_42  "Nightly API smoke test"  every day at 03:00  next: disabled  last: not run yet'],
    [tc('s9', 'schedule_delete', { id: 's_7' }), 'Deleted schedule "Weekly changelog" (s_7).'],
    [tc('s10', 'mod_check', { id: 'word-count' }), 'word-count: ok'],
    [tc('s11', 'show_image', { path: '/Users/someone/shots/before.png' }), 'Error: no such file: /Users/someone/shots/before.png'],
    [tc('s12', 'bash', { command: 'npm run lint' }), 'src/api/users.ts\n  12:5  error  no-unused-vars\n\n1 problem\n[exit code: 1]'],
    [tc('s13', 'bash', { command: 'npm test' }), 'Tests: 24 passed\n[exit code: 0]'],
  ];
  c.messages.push(
    { role: 'user', content: 'Split api.ts into one module per resource.' },
    { role: 'assistant', content: '', tool_calls: tools.map(([call]) => call) },
    ...tools.map(([call, result]) => ({ role: 'tool', tool_call_id: call.id, content: result })),
    { role: 'assistant', content: 'Done: 6 modules under `src/api/`, all imports updated, tests pass.' },
  );
  // Messages that were not typed, in the frames the app really writes around them (the sender's id, which tools to
  // use next): a sub-session's report, a message from another session, a merged summary, a scheduled prompt.
  const framed = [
    ['session', Subagents.prototype.noteText.call(null, b, { type: 'run_end', reason: 'done', text: 'The plan is ready: **tokens first**, then the settings page.' }), b.id],
    ['session', `${messageHead(a, 'peer session')}\nThe login fix is merged; rebase before you go on.`, a.id],
    ['command', mergedText(b.title, 'Dark mode needs two new tokens and one stylesheet.'), b.id],
    ['schedule', frameMessage({ name: 'Nightly API smoke test', describe: 'every day at 03:00', prompt: 'Run the API smoke test and report failures.' }), undefined],
  ];
  c.turns = c.turns ?? [];
  for (const [origin, text, from] of framed) {
    c.turns.push({ at: c.messages.length, createdAt: Date.now(), text, files: {}, origin, from });
    c.messages.push({ role: 'user', content: text }, { role: 'assistant', content: 'Noted.' });
  }
  store.save(c);
  // Oldest first in updatedAt so the list order is: login (running), dark mode, refactor.
  c.updatedAt = Date.now() - 3 * 3600_000;
  b.updatedAt = Date.now() - 20 * 60_000;
  a.updatedAt = Date.now();
  return { a, b, c };
}

// ---------------------------------------------------------------------------------------------------------------
// Driving the window
// ---------------------------------------------------------------------------------------------------------------

async function shot(win, name) {
  // A hidden window only advances CSS animations while frames are produced: draw a couple before the real capture.
  for (let i = 0; i < 3; i++) {
    win.webContents.invalidate();
    await win.webContents.capturePage();
    await sleep(120);
  }
  for (const scheme of ['light', 'dark']) {
    nativeTheme.themeSource = scheme;
    await sleep(350);
    // A hidden window can hand back its previous frame; ask for a fresh one first.
    win.webContents.invalidate();
    await sleep(100);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(shots, `${name}-${scheme}.png`), img.toPNG());
  }
  nativeTheme.themeSource = 'light';
  console.log(`shot ${name}`);
}

const js = (win, code) => win.webContents.executeJavaScript(code);

async function tap(win, selector) {
  const r = await js(win, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error(`nothing matches ${selector}`);
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await sleep(150);
}

async function waitFor(win, code, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await js(win, code)) return true;
    await sleep(50);
  }
  return false;
}

async function main() {
  const userData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oa-remote-page-'));
  let seq = 0;
  f = fakeApp(projectDir, {
    userData,
    onSend: (id, text) => {
      if (live.running) {
        const q = { id: `q-${++seq}`, text, attachments: [], createdAt: Date.now() };
        live.queue.push(q);
        return { ok: true, queued: true, id: q.id };
      }
      return { ok: true };
    },
    onApproval: (id, ok, always, scope) => {
      const card = live.approvals.find((x) => x.id === id);
      if (!card) return false;
      live.approvals = live.approvals.filter((x) => x.id !== id);
      f.status.set(sessions.a.id, { running: true });
      setTimeout(() => f.emit(sessions.a.id, { type: 'approval_resolved', id, ok, scope: always ? scope : 'once' }), 0);
      return true;
    },
  });
  const sessions = seed(f.app.store);
  f.setForeground(sessions.a.id);
  f.status.set(sessions.b.id, { running: false, attention: 'plan' });
  f.live.set(sessions.a.id, live);
  setupRemote(f.app);
  const st = await f.handlers['remote.start']();
  const url = st.urls[0];
  console.log('serving', url.replace(/[0-9a-f]{64}/, '<token>'));

  const win = new BrowserWindow({ width: 390, height: 844, show: false, paintWhenInitiallyHidden: true, webPreferences: { sandbox: true, contextIsolation: true } });
  const consoleErrors = [];
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    const message = e.message ?? e.params?.message;
    if (level === 'error' || level === 3) consoleErrors.push(message);
  });
  await win.loadURL(url);
  check('page loaded', await waitFor(win, `document.querySelectorAll('.msg.assistant').length >= 2`), await js(win, 'document.body.innerText.slice(0, 200)'));

  // 1. A run starts and streams a reply, with thinking, while a tool runs. Like the real agent, the stored
  // conversation grows as messages complete, so a reload mid-run sees what a real one would.
  const A = sessions.a.id;
  const store = (...msgs) => {
    sessions.a.messages.push(...msgs);
    f.app.store.save(sessions.a);
  };
  live.running = true;
  live.startedAt = Date.now();
  f.status.set(A, { running: true });
  f.emit(A, { type: 'run_start' });
  store({ role: 'user', content: 'Good. Make the backoff configurable and fix the test.' });
  f.emit(A, { type: 'user_message', text: 'Good. Make the backoff configurable and fix the test.', images: 0, origin: 'remote' });
  for (const t of ['The user wants ', 'the backoff ', 'configurable…']) f.emit(A, { type: 'thinking_delta', text: t });
  f.emit(A, { type: 'thinking_done' });
  f.emit(A, { type: 'tool_start', id: 't1', name: 'edit_file', args: { path: 'src/auth/login.ts', old_string: 'await sleep(3000);', new_string: 'await sleep(backoffMs * 2 ** i);' } });
  f.emit(A, { type: 'tool_end', id: 't1', name: 'edit_file', result: 'Edited src/auth/login.ts (+3 −2)', ok: true });
  store({ role: 'assistant', content: '', tool_calls: [tc('t1', 'edit_file', { path: 'src/auth/login.ts', old_string: 'await sleep(3000);', new_string: 'await sleep(backoffMs * 2 ** i);' })] }, { role: 'tool', tool_call_id: 't1', content: 'Edited src/auth/login.ts (+3 −2)' });
  const reply = "I changed `retryLogin` to take `{ attempts, backoffMs }`. Now the test:\n\n- passes `{ backoffMs: 0 }` so the retry is immediate\n- keeps the 5 s timeout as a guard\n\nRunning the suite to confirm";
  for (const chunk of reply.match(/.{1,9}/gs)) {
    f.emit(A, { type: 'text_delta', text: chunk });
    await sleep(12);
  }
  await sleep(200);
  check('streamed text shows', await waitFor(win, `document.querySelector('.msg.assistant.streaming')?.innerText.includes('Running the suite')`));
  await shot(win, '1-midstream');

  // 2. The reply finishes, a command asks for approval and waits.
  f.emit(A, { type: 'text_done' });
  f.emit(A, { type: 'assistant_message', text: reply + '.', toolCalls: 1 });
  // The assistant message with its pending tool call is stored before the tool has a result.
  // Two calls in it, as a model often sends: the first runs (and waits for approval), the second has not started.
  store({ role: 'assistant', content: reply + '.', tool_calls: [tc('t2', 'bash', { command: 'npm test -- test/auth/login.test.ts --runInBand' }), tc('t3', 'list_directory', { path: 'test/auth' })] });
  f.emit(A, { type: 'tool_start', id: 't2', name: 'bash', args: { command: 'npm test -- test/auth/login.test.ts --runInBand' } });
  const ap = { type: 'approval_request', id: 'ap-1', name: 'bash', detail: 'npm test -- test/auth/login.test.ts --runInBand', mode: 'ask', alwaysLabel: 'Allow npm for this session', projectLabel: 'Always allow npm in this project' };
  live.approvals = [ap];
  live.tools = [{ id: 't2', name: 'bash', args: { command: 'npm test -- test/auth/login.test.ts --runInBand' } }];
  f.status.set(A, { running: true, attention: 'approval' });
  f.emit(A, ap);
  check('approval card shows', await waitFor(win, `!!document.querySelector('.card.approval:not(.decided)')`));
  check('approval card offers Deny, the session allow and Allow, nothing for the project', (await js(win, `[...document.querySelectorAll('.card.approval button')].map(b => b.textContent).join('|')`)) === 'Deny|Allow npm for this session|Allow');
  await shot(win, '2-approval');

  // A reload mid-run shows exactly the same, nothing twice.
  const before = await js(win, `document.getElementById('transcript').innerText`);
  live.text = '';
  await win.webContents.reload();
  await waitFor(win, `!!document.querySelector('.card.approval')`);
  await sleep(300);
  const after = await js(win, `document.getElementById('transcript').innerText`);
  check('a reload during the run shows one approval card and one running tool', (await js(win, `document.querySelectorAll('.card.approval').length`)) === 1 && (await js(win, `document.querySelectorAll('.tool .spinner').length`)) === 1);
  // The calls of the run's last message have no result yet: the one running shows once, the one not started not at all.
  const rows = await js(win, `[...document.querySelectorAll('#transcript .tool summary')].map((s) => s.innerText.replace(/\\s+/g, ' ').trim())`);
  check('…the command waiting for approval shows once, the call not started yet not at all', rows.filter((r) => r === 'Bash npm test -- test/auth/login.test.ts --runInBand').length === 1 && !rows.some((r) => r.startsWith('List')), rows);
  check('…and the earlier history once', (after.match(/Found it\./g) || []).length === 1, after.length);
  // Thinking and a message's origin are not stored with the conversation, so only those may differ.
  const norm = (t) => t.replace(/Thought|Thinking…|Sent from this device/g, '').replace(/\s+/g, ' ').trim();
  check('…and the same text as before the reload (thinking and origin labels aside)', norm(after) === norm(before), [norm(before), norm(after)]);

  // 3. The session list.
  await tap(win, '#open-sessions');
  check('sheet opens with three sessions', await waitFor(win, `!document.getElementById('sheet').hidden && document.querySelectorAll('#session-list li').length === 3`));
  await shot(win, '3-sessions');

  // 4. The plan in the other session.
  await tap(win, '#session-list li:nth-child(2) button');
  check('switching shows the plan card', await waitFor(win, `!!document.querySelector('.card.plan .card-actions:not([hidden])')`));
  await js(win, `document.querySelector('.card.plan').scrollIntoView({ block: 'start' })`);
  await shot(win, '4-plan');

  // 4b. The third session's tool rows: readable names for the session, schedule and mod tools, and a failed command
  // judged by its exit code as the desktop does.
  await tap(win, '#open-sessions');
  await tap(win, '#session-list li:nth-child(3) button');
  check('switching shows the third session', await waitFor(win, `document.getElementById('transcript').innerText.includes('Done: 6 modules')`));
  const toolRows = await js(win, `[...document.querySelectorAll('#transcript .tool')].map((d) => ({ row: (d.querySelector('.tool-verb').textContent + ' ' + d.querySelector('.tool-arg').textContent).trim(), meta: d.querySelector('.tool-meta').textContent, err: d.querySelector('.tool-status').classList.contains('err') }))`);
  const wanted = [
    'Sub-session Split the users module',
    'Message to Add dark mode to the settings page',
    'Sessions',
    'Read session Fix the flaky login test',
    'Merge Fix the flaky login test',
    'Schedule Nightly API smoke test',
    'Schedules',
    'Update schedule Nightly API smoke test',
    'Delete schedule Weekly changelog',
    'Check mod word-count',
    'Show image before.png',
    'Bash npm run lint',
    'Bash npm test',
  ];
  check('session, schedule and mod tools have readable rows (no raw names or JSON)', JSON.stringify(toolRows.map((r) => r.row)) === JSON.stringify(wanted), toolRows.map((r) => r.row));
  const lint = toolRows.find((r) => r.row === 'Bash npm run lint');
  const passed = toolRows.find((r) => r.row === 'Bash npm test');
  check('a stored command that exited 1 shows as failed with "exit 1"; one that exited 0 as done', lint && lint.err && lint.meta === 'exit 1' && passed && !passed.err && passed.meta === '', { lint, passed });
  check('a failed show_image says failed', toolRows.find((r) => r.row === 'Show image before.png')?.meta === 'failed');
  // Messages from elsewhere: what was said and who said it, not the frame written for the model
  const bubbles = await js(win, `[...document.querySelectorAll('#transcript .msg.user')].map((m) => ({ text: m.querySelector('.bubble').innerText.trim(), from: m.querySelector('.from')?.innerText ?? '', bold: m.querySelector('.bubble strong')?.innerText ?? '' }))`);
  const said = (text) => bubbles.find((x) => x.text === text);
  const report = said('The plan is ready: tokens first, then the settings page.');
  check('a sub-session report shows what it said, as Markdown, labelled with its session', report && report.bold === 'tokens first' && report.from === 'From session Add dark mode to the settings page · finished a turn', bubbles.slice(-4));
  check('a message from another session shows its text and sender', said('The login fix is merged; rebase before you go on.')?.from === 'From session Fix the flaky login test', bubbles.slice(-3));
  check('a merged summary shows the summary and where it came from', said('Dark mode needs two new tokens and one stylesheet.')?.from === 'Merged from Add dark mode to the settings page', bubbles.slice(-2));
  check('a scheduled run shows the prompt the schedule holds', said('Run the API smoke test and report failures.')?.from === 'From a schedule', bubbles.slice(-1));
  check('no frame, id or tool hint is left on the page', !/\[Sub-session "|\[Message from|\[Merged from|\[Scheduled task|session_read|Carry out the task below/.test(await js(win, `document.getElementById('transcript').innerText`)));
  await js(win, `document.querySelector('#scroll').scrollTop = 0`);
  await shot(win, '4b-tools');

  // 5. Drive it: back to the running session, tap Allow, type and send a message (queued: the run is still going).
  await tap(win, '#open-sessions');
  await tap(win, '#session-list li:nth-child(1) button');
  await waitFor(win, `!!document.querySelector('.card.approval:not(.decided)')`);
  f.calls.length = 0;
  await tap(win, '.card.approval:not(.decided) button.primary');
  check('tapping Allow reached the runtime: allow once, session scope', await waitFor(win, `document.querySelector('.card.approval')?.classList.contains('decided')`) && JSON.stringify(f.calls.find((c) => c[0] === 'respondApproval')) === JSON.stringify(['respondApproval', 'ap-1', true, false, 'session']), f.calls);
  f.status.set(A, { running: true });
  live.approvals = [];
  live.tools = [];
  f.emit(A, { type: 'tool_end', id: 't2', name: 'bash', result: 'PASS test/auth/login.test.ts\n  login\n    ✓ retries once on 503 (12 ms)\n\nTests: 1 passed', ok: true });
  store({ role: 'tool', tool_call_id: 't2', content: 'PASS test/auth/login.test.ts\n  login\n    ✓ retries once on 503 (12 ms)\n\nTests: 1 passed' });
  f.emit(A, { type: 'tool_start', id: 't3', name: 'list_directory', args: { path: 'test/auth' } });
  f.emit(A, { type: 'tool_end', id: 't3', name: 'list_directory', result: 'test/auth\n  login.test.ts', ok: true });
  store({ role: 'tool', tool_call_id: 't3', content: 'test/auth\n  login.test.ts' });
  // A command that exits non-zero, live: a red mark and its exit code, not a check mark.
  f.emit(A, { type: 'tool_start', id: 't4', name: 'bash', args: { command: 'npm run lint' } });
  f.emit(A, { type: 'tool_end', id: 't4', name: 'bash', result: 'src/auth/login.ts\n  3:1  error  no-unused-vars\n[exit code: 1]', ok: true });
  store({ role: 'assistant', content: '', tool_calls: [tc('t4', 'bash', { command: 'npm run lint' })] }, { role: 'tool', tool_call_id: 't4', content: 'src/auth/login.ts\n  3:1  error  no-unused-vars\n[exit code: 1]' });
  check('a live command that exited 1 shows as failed with "exit 1"', await waitFor(win, `(() => { const r = [...document.querySelectorAll('#transcript .tool')].pop(); return r && r.querySelector('.tool-arg').textContent === 'npm run lint' && r.querySelector('.tool-status').classList.contains('err') && r.querySelector('.tool-meta').textContent === 'exit 1'; })()`));
  await tap(win, '#input');
  win.webContents.insertText('Also add a test for three attempts');
  await sleep(100);
  await tap(win, '#send');
  check('the typed message reached runtime.send with origin remote', await waitFor(win, `document.querySelectorAll('.queued').length === 1`) && JSON.stringify(f.calls.find((c) => c[0] === 'send')) === JSON.stringify(['send', A, 'Also add a test for three attempts', [], { origin: 'remote' }]), f.calls.find((c) => c[0] === 'send'));
  check('the composer emptied and shows the message as queued, with Stop', (await js(win, `document.getElementById('input').value === '' && !document.getElementById('stop').hidden && document.querySelector('.queued .text').textContent`)) === 'Also add a test for three attempts');
  await shot(win, '5-driven');

  // 5b. The agent asks a question (ask_user): one answer is a tap; more than one is for the app.
  const LIB = { question: 'Which chart library should the dashboard use?', header: 'Library', options: [{ label: 'Chart.js', description: 'Small, canvas' }, { label: 'D3', description: 'Anything, more code' }], multiSelect: false };
  f.emit(A, { type: 'tool_start', id: 't5', name: 'ask_user', args: { questions: [LIB] } });
  f.emit(A, { type: 'question_request', id: 'qq-1', questions: [LIB] });
  check('a question shows as a card with its options as buttons', await waitFor(win, `document.querySelectorAll('.card.question:not(.decided) button.q-opt').length === 2`) && (await js(win, `document.querySelector('.card.question .card-title').textContent`)) === LIB.question);
  await shot(win, '5b-question');
  f.calls.length = 0;
  await tap(win, '.card.question:not(.decided) button.q-opt:nth-child(2)');
  check('tapping an option answers it: the label reaches the runtime', await waitFor(win, `document.querySelector('.card.question')?.classList.contains('decided')`) && JSON.stringify(f.calls.find((c) => c[0] === 'respondQuestion')) === JSON.stringify(['respondQuestion', 'qq-1', [{ selected: ['D3'] }]]), f.calls);
  f.emit(A, { type: 'question_resolved', id: 'qq-1', answers: [{ selected: ['D3'] }] });
  f.emit(A, { type: 'tool_end', id: 't5', name: 'ask_user', result: 'The user answered your question:\n- Library: D3', ok: true });
  const FEAT = { question: 'Which features first?', header: 'Features', options: [{ label: 'Export', description: '' }, { label: 'Filters', description: '' }], multiSelect: true };
  f.emit(A, { type: 'question_request', id: 'qq-2', questions: [FEAT] });
  check('a question with several answers says to answer in the app, with no buttons', await waitFor(win, `[...document.querySelectorAll('.card.question')].pop()?.querySelector('.q-elsewhere')?.textContent.startsWith('Answer in the app')`) && (await js(win, `[...document.querySelectorAll('.card.question')].pop().querySelectorAll('button').length`)) === 0);
  f.emit(A, { type: 'question_resolved', id: 'qq-2', answers: [{ selected: ['Export', 'Filters'] }] });
  check('answered on the Mac, the card says what was picked', await waitFor(win, `[...document.querySelectorAll('.card.question')].pop()?.querySelector('.decision')?.textContent === 'Export, Filters'`));

  // 5c. Browser cards, worded as the desktop words them: a site's first approval with its answer for the session, and
  // a purchase with Allow and Deny only; the action, the model's reason in grey under it, the amber note.
  const lastCard = `[...document.querySelectorAll('.card.approval')].pop()`;
  const cardInfo = () =>
    js(win, `(() => { const c = ${lastCard}; const probe = (v) => { const s = document.createElement('span'); s.style.color = 'var(' + v + ')'; document.body.append(s); const col = getComputedStyle(s).color; s.remove(); return col; };
      return { title: c.querySelector('.card-title').textContent, action: c.querySelector('.card-action')?.textContent ?? null, why: c.querySelector('.card-why')?.textContent ?? null, whyColor: c.querySelector('.card-why') ? getComputedStyle(c.querySelector('.card-why')).color : null, grey: probe('--text-400'),
        note: c.querySelector('.card-note')?.textContent ?? null, noteColor: c.querySelector('.card-note') ? getComputedStyle(c.querySelector('.card-note')).color : null, amber: probe('--warn'), reason: c.querySelector('.card-reason')?.textContent ?? null,
        buttons: [...c.querySelectorAll('.card-actions button')].map((b) => b.textContent).join('|'), decided: c.classList.contains('decided'), decision: c.querySelector('.decision')?.textContent ?? null }; })()`);
  const siteCard = { type: 'approval_request', id: 'ap-b1', name: 'browser_navigate', detail: 'Open docs.example.com\nTo read the retry guide the user linked', mode: 'ask', alwaysLabel: 'Allow docs.example.com for this session', projectLabel: 'Always allow docs.example.com', browser: { card: 'site', site: 'docs.example.com' } };
  live.approvals = [siteCard];
  f.status.set(A, { running: true, attention: 'approval' });
  f.emit(A, siteCard);
  await waitFor(win, `${lastCard}?.querySelector('.card-title')?.textContent.startsWith('Let the agent')`);
  let bc = await cardInfo();
  check("a browser site card reads as the desktop's: \"Let the agent use docs.example.com?\", the action, the reason in grey", bc.title === 'Let the agent use docs.example.com?' && bc.action === 'Open docs.example.com' && bc.why === 'To read the retry guide the user linked' && bc.whyColor === bc.grey && bc.note === null, bc);
  check('… with Deny, Allow docs.example.com for this session and Allow (no Always: that is for the Mac)', bc.buttons === 'Deny|Allow docs.example.com for this session|Allow', bc.buttons);
  await shot(win, '5c-browser-site');
  f.calls.length = 0;
  await tap(win, `.card.approval:not(.decided) button[data-a="session"]`);
  await waitFor(win, `${lastCard}.classList.contains('decided')`);
  bc = await cardInfo();
  check('… "for this session" reaches the runtime and the card says "Allowed docs.example.com for this session"', JSON.stringify(f.calls.find((c) => c[0] === 'respondApproval')) === JSON.stringify(['respondApproval', 'ap-b1', true, true, 'session']) && bc.decision === 'Allowed docs.example.com for this session', { calls: f.calls, bc });
  const buyCard = { type: 'approval_request', id: 'ap-b2', name: 'browser_click', detail: 'Click "Pay now" on shop.example\nTo finish the order the user asked for', mode: 'bypass', reason: '"Pay now" looks like a purchase', alwaysLabel: '', projectLabel: '', note: 'This looks like a payment page', browser: { card: 'purchase', site: 'shop.example' } };
  live.approvals = [buyCard];
  f.status.set(A, { running: true, attention: 'approval' });
  f.emit(A, buyCard);
  await waitFor(win, `${lastCard}?.querySelector('.card-title')?.textContent === 'Make a purchase?'`);
  bc = await cardInfo();
  check('a purchase card: "Make a purchase?", what was seen, the action and reason, the amber note', bc.title === 'Make a purchase?' && /looks like a purchase/.test(bc.reason ?? '') && bc.action === 'Click "Pay now" on shop.example' && bc.why === 'To finish the order the user asked for' && bc.note === 'This looks like a payment page' && bc.noteColor === bc.amber, bc);
  check('… with Allow and Deny only', bc.buttons === 'Deny|Allow', bc.buttons);
  await shot(win, '5c-browser-purchase');
  f.calls.length = 0;
  await tap(win, `.card.approval:not(.decided) button[data-a="deny"]`);
  await waitFor(win, `${lastCard}.classList.contains('decided')`);
  bc = await cardInfo();
  check('… Deny reaches the runtime and the card says "Denied on shop.example"', JSON.stringify(f.calls.find((c) => c[0] === 'respondApproval')) === JSON.stringify(['respondApproval', 'ap-b2', false, false, 'session']) && bc.decision === 'Denied on shop.example', { calls: f.calls, bc });
  f.status.set(A, { running: true });
  live.approvals = [];

  // 6. The queued message is delivered and the run ends.
  f.emit(A, { type: 'queue_delivered', id: 'q-1' });
  f.emit(A, { type: 'user_message', text: 'Also add a test for three attempts', images: 0, origin: 'queue' });
  f.emit(A, { type: 'tasks_updated', tasks: [{ id: '1', title: 'Make backoff configurable', status: 'completed' }, { id: '2', title: 'Fix the login test', status: 'completed' }, { id: '3', title: 'Add a three-attempt test', status: 'in_progress' }] });
  for (const chunk of ['Added ', '`retries three times`', ' to the suite; ', 'all **4** tests pass.']) f.emit(A, { type: 'text_delta', text: chunk });
  f.emit(A, { type: 'text_done' });
  f.emit(A, { type: 'assistant_message', text: 'Added `retries three times` to the suite; all **4** tests pass.', toolCalls: 0 });
  live.running = false;
  f.status.set(A, { running: false });
  f.emit(A, { type: 'run_end', reason: 'done' });
  check('run end: queue cleared, Stop hidden, idle mark', await waitFor(win, `document.getElementById('queue').hidden && document.getElementById('stop').hidden && document.getElementById('mark').classList.contains('idle')`));
  check('the delivered message appears once', (await js(win, `[...document.querySelectorAll('.msg.user .bubble')].filter(b => b.textContent === 'Also add a test for three attempts').length`)) === 1);
  await shot(win, '6-done');

  // 7. Desktop width.
  win.setSize(1100, 800);
  await sleep(300);
  await shot(win, '7-desktop');

  // 8. The link dies after newLink.
  win.setSize(390, 844);
  await f.handlers['remote.newLink']();
  check('the page says the link no longer works', await waitFor(win, `document.body.innerText.includes('no longer works')`, 8000));
  await shot(win, '8-dead');

  check('no console errors (CSP violations included)', consoleErrors.length === 0, consoleErrors);
  await f.quit();
  console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
  electron.exit(failures ? 1 : 0);
}

electron.whenReady().then(() =>
  main().catch((err) => {
    console.log('CRASH', err && err.stack);
    electron.exit(1);
  }),
);
