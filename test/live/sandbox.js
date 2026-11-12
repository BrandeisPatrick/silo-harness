// Live check of the shell sandbox in the real window, with the mock model scripted for the agent and for the check,
// and "sandbox": { "enabled": true } in the test's own settings.json. In Auto mode: a heredoc into /tmp and a test
// run go through with no check; a Python write to a protected path in the project (.vscode) hits the sandbox, goes to
// the check, is allowed and runs again outside; git add and npm install go straight to the check (allowed, blocked),
// with no sandboxed first run. Five calls, three checks. The rows that ran in the sandbox carry its mark, and the one
// that ran twice shows both runs. In Plan mode a read runs in the read-only sandbox: a grep that reaches .env reads no
// secret, and the agent is told why. Then, in a fresh window with the sandbox off: Settings → Permissions → Auto mode
// turns it on, shows Local ports and the folders, saves a folder, and is screenshotted in light and dark. Temp folders only.
// Run: npm run build && node test/live/sandbox.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { launch, checker } = require('./rig.js');
const { classifierReply, isClassifierRequest } = require('../support/mock-model.js');

const { check, done } = checker();

const userSays = (marker) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  return !!m && m.role === 'user' && JSON.stringify(m.content).includes(marker);
};
const afterTool = (id) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  return !!m && m.role === 'tool' && (payload.messages ?? []).some((x) => x.role === 'tool' && x.tool_call_id === id);
};
const sh = (id, args) => ({ id, name: 'bash', args });

(async () => {
  if (process.platform !== 'darwin') {
    console.log('skip: the shell sandbox is macOS only');
    process.exit(done() ? 1 : 0);
  }
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-sandbox-'));
  fs.mkdirSync(shots, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-sandbox-profile-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-sandbox-project-')));
  const home = path.join(profile, 'home-config');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ sandbox: { enabled: true } }, null, 2));
  fs.mkdirSync(path.join(project, '.vscode'));
  fs.writeFileSync(path.join(project, '.env'), 'LIVE_TOKEN=hunter4\n');
  fs.writeFileSync(path.join(project, 'notes.txt'), 'notes\n');
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: project });
  const tmpFile = path.join('/private/tmp', `silo-sandbox-live-${process.pid}.txt`);

  const app = await launch({ mode: 'auto', mock: true, profile, ownsProfile: true, project, config: { theme: 'light', toolActivity: 'all' } });
  const theme = (a, t) => a.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(t)}`);
  const both = async (a, name, selector, margin = 16) => {
    for (const t of ['light', 'dark']) {
      await theme(a, t);
      await new Promise((r) => setTimeout(r, 250));
      await a.screenshotOf(path.join(shots, `${name}-${t}.png`), selector, margin);
    }
    await theme(a, 'light');
  };
  const { replies, requests } = app.mock.state;
  const checkRequests = () => requests.filter((r) => isClassifierRequest(r.payload));
  // What each check decided on: its <action> section (the earlier calls it lists are context, not actions)
  const actions = () => checkRequests().map((r) => (JSON.stringify(r.payload.messages).match(/<action>([\s\S]*?)<\/action>/) || [])[1] ?? '');
  const result = (id) => requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';
  const setConfig = (patch) => app.evaluate(`(async () => { const c = await window.oc.getConfig(); await window.oc.setConfig({ ...c, ...${JSON.stringify(patch)} }); })()`);
  try {
    if (await app.evaluate(`!document.querySelector('.shell').classList.contains('pane-hidden')`)) await app.click('#pane-toggle').catch(() => undefined);

    // ---------- 1. Auto mode: five calls, three checks ----------
    replies.push({ content: '', toolCalls: [sh('s1', { command: `cat > ${tmpFile} <<'EOF'\nsandboxed heredoc\nEOF` })], when: userSays('Do the work') });
    replies.push({ content: '', toolCalls: [sh('s2', { command: `node -e "require('assert').strictEqual(1 + 1, 2); console.log('tests pass')"` })], when: afterTool('s1') });
    replies.push({ content: '', toolCalls: [sh('s3', { command: `python3 -c "open('.vscode/settings.json', 'w').write('{}')"` })], when: afterTool('s2') });
    replies.push(classifierReply('allow', '[Local Work] editor settings for this project', { when: (p) => JSON.stringify(p.messages).includes('.vscode/settings.json') }));
    replies.push({ content: '', toolCalls: [sh('s4', { command: 'git add notes.txt' })], when: afterTool('s3') });
    replies.push(classifierReply('allow', '[Local Work] stages a file', { when: (p) => JSON.stringify(p.messages).includes('git add notes.txt') }));
    replies.push({ content: '', toolCalls: [sh('s5', { command: 'npm install left-pad' })], when: afterTool('s4') });
    replies.push(classifierReply('block', '[Dependencies] not asked for', { when: (p) => JSON.stringify(p.messages).includes('npm install left-pad') }));
    replies.push({ content: 'Done.', when: afterTool('s5') });
    await app.send('Do the work.');
    await app.waitIdle(60_000);
    const seen = actions();
    check('auto: the heredoc into /tmp ran in the sandbox, no check', fs.existsSync(tmpFile) && fs.readFileSync(tmpFile, 'utf8') === 'sandboxed heredoc\n' && !seen.some((s) => s.includes(tmpFile)), result('s1'));
    check('auto: the test run ran in the sandbox, no check', /tests pass/.test(result('s2')) && !seen.some((s) => s.includes('strictEqual')), result('s2'));
    check('auto: the Python write hit the sandbox, the check allowed it, it ran again outside', fs.existsSync(path.join(project, '.vscode', 'settings.json')) && result('s3').startsWith('[sandbox: blocked (') && result('s3').includes('ran again outside'), result('s3'));
    check('auto: … and the check was told it ran once in the sandbox, in fixed words, with nothing of its output', seen.some((s) => s.includes('.vscode/settings.json') && s.includes('already ran once in a sandbox') && s.includes('blocked by: the sandbox refused an operation')) && !checkRequests().some((r) => /PermissionError|Traceback/.test(JSON.stringify(r.payload.messages))));
    check('auto: git add went straight to the check and ran', /\[exit code: 0\]/.test(result('s4')) && execFileSync('/usr/bin/git', ['diff', '--cached', '--name-only'], { cwd: project, encoding: 'utf8' }).trim() === 'notes.txt' && seen.some((s) => s.includes('git add notes.txt') && !s.includes('already ran once')), result('s4'));
    check('auto: npm install went straight to the check and was blocked', result('s5').startsWith('Blocked by Auto mode: [Dependencies] not asked for') && !fs.existsSync(path.join(project, 'node_modules')) && seen.some((s) => s.includes('npm install left-pad') && !s.includes('already ran once')), result('s5'));
    check('auto: three checks for five calls', checkRequests().length === 3, checkRequests().length);
    const offered = requests.find((r) => r.payload?.stream)?.payload.tools?.find((t) => t.function?.name === 'bash');
    check('auto: the model is offered bash with outside', !!offered?.function.parameters.properties.outside);
    check('auto: no approval card came up', !(await app.exists('.approval')));
    // The rows: the mark on the three that ran in the sandbox, none on git add; npm install is the quiet blocked line
    const rows = await app.evaluate(`Object.fromEntries([...document.querySelectorAll('#messages .tool[data-tool="bash"]')].map((e) => [e.dataset.callId, { mark: e.querySelector('.tool-sandbox')?.textContent ?? '', tip: e.querySelector('.tool-sandbox')?.title ?? '' }]))`);
    check('rows: the sandbox mark on the three that ran in it, not on git add', rows.s1?.mark === 'sandbox' && rows.s2?.mark === 'sandbox' && rows.s3?.mark === 'sandbox' && rows.s3.tip === 'Blocked in the sandbox, then ran outside' && rows.s1.tip === 'Ran in the sandbox' && rows.s4 && !rows.s4.mark, rows);
    await app.evaluate(`(() => { const e = document.querySelector('#messages .tool[data-call-id="s3"]'); e.open = true; })()`);
    const twoRuns = await app.text('#messages .tool[data-call-id="s3"] .tool-body');
    check('rows: the one that ran twice shows both runs and what happened', /In the sandbox/.test(twoRuns) && /Outside/.test(twoRuns) && /Sandbox blocked · checked · ran again outside/.test(twoRuns) && /PermissionError/.test(twoRuns) && !/\[sandbox: blocked/.test(twoRuns), twoRuns);
    await app.evaluate(`document.querySelector('#messages .tool[data-call-id="s1"]').open = true`);
    check('rows: a clean run says it ran in the sandbox', /Ran in the sandbox/.test((await app.text('#messages .tool[data-call-id="s1"] .tool-body')) ?? ''));
    await both(app, 'sandbox-row-two-runs', '#messages .tool[data-call-id="s3"]');

    // ---------- 2. Plan mode: a read in the read-only sandbox ----------
    await setConfig({ permissionMode: 'plan' });
    await app.waitFor(`document.querySelector('#mode-btn').dataset.mode === 'plan'`, 5000, 'plan mode');
    const before = checkRequests().length;
    replies.push({ content: '', toolCalls: [sh('p1', { command: 'grep -r LIVE_TOKEN .' })], when: userSays('Find the token') });
    replies.push({ content: 'It is in .env, which I cannot read here.', when: afterTool('p1') });
    await app.send('Find the token.');
    await app.waitIdle(60_000);
    check('plan: the read ran read-only in the sandbox: no secret, a note, no check, no card', result('p1').includes('[sandbox: Plan mode runs commands read-only') && !result('p1').includes('hunter4') && checkRequests().length === before && !(await app.exists('.approval')), result('p1'));
  } finally {
    fs.rmSync(tmpFile, { force: true });
    await app.close();
  }

  // ---------- 3. Settings → Permissions → Auto mode, the sandbox off at first ----------
  const app2 = await launch({ mode: 'auto', mock: true, config: { theme: 'light' } });
  try {
    const cfg = () => app2.evaluate('window.oc.getConfig()');
    await app2.evaluate(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-permissions')?.click(); })()`);
    await app2.waitFor(`Boolean(document.querySelector('#sp-row-sandbox-enabled'))`, 10_000, 'the sandbox switch');
    const shown = () => app2.evaluate(`({ on: document.querySelector('#sp-row-sandbox-enabled input').checked, ports: !document.querySelector('#sp-row-sandbox-loopback').hidden, folders: !document.querySelector('#sp-row-sandbox-allowWrite').hidden, desc: document.querySelector('#sp-row-sandbox-enabled .sp-row-desc').textContent })`);
    let v = await shown();
    check('settings: off by default, Local ports and the folders hidden', !v.on && !v.ports && !v.folders && (await cfg()).sandbox?.enabled !== true, v);
    await app2.click('#sp-row-sandbox-enabled input');
    await app2.waitFor(`window.oc.getConfig().then((c) => c.sandbox && c.sandbox.enabled === true)`, 5000, 'the setting saved');
    await app2.waitFor(`!document.querySelector('#sp-row-sandbox-loopback').hidden`, 5000, 'Local ports to show');
    v = await shown();
    check('settings: on, saved, Local ports and the folders shown; this Mac can run it', v.on && v.ports && v.folders && v.desc === 'Commands that stay in the project and temp folders run without the check.', v);
    await app2.fill('#sandbox-allowWrite', '~');
    await app2.evaluate(`document.querySelector('#sandbox-allowWrite').dispatchEvent(new FocusEvent('blur'))`);
    await app2.waitFor(`!document.querySelector('#sp-row-sandbox-allowWrite .sp-problem').hidden`, 5000, 'the problem line');
    const problem = await app2.text('#sp-row-sandbox-allowWrite .sp-problem');
    check('settings: the home folder itself is refused', /whole home folder/.test(problem ?? ''), problem);
    await app2.fill('#sandbox-allowWrite', '~/silo-sandbox-scratch\n/Volumes/Work/builds');
    await app2.evaluate(`document.querySelector('#sandbox-allowWrite').dispatchEvent(new FocusEvent('blur'))`);
    await app2.waitFor(`window.oc.getConfig().then((c) => Array.isArray(c.sandbox?.allowWrite) && c.sandbox.allowWrite.length === 2)`, 5000, 'the folders saved');
    check('settings: two folders saved', JSON.stringify((await cfg()).sandbox.allowWrite) === JSON.stringify(['~/silo-sandbox-scratch', '/Volumes/Work/builds']));
    // The group's title and its three sandbox rows, scrolled into view (the group goes on with the learned answers)
    await app2.evaluate(`document.querySelector('#sp-row-sandbox-enabled').closest('.sp-group').scrollIntoView({ block: 'start' })`);
    const box = await app2.evaluate(`(() => { const top = document.querySelector('#sp-row-sandbox-enabled').closest('.sp-group').getBoundingClientRect(); const end = document.querySelector('#sp-row-sandbox-allowWrite').getBoundingClientRect(); return { x: top.x - 16, y: top.y - 16, width: top.width + 32, height: end.bottom - top.y + 32 }; })()`);
    for (const t of ['light', 'dark']) {
      await theme(app2, t);
      await new Promise((r) => setTimeout(r, 250));
      await app2.screenshot(path.join(shots, `sandbox-settings-${t}.png`), box);
    }
    await theme(app2, 'light');
  } finally {
    await app2.close();
  }
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
