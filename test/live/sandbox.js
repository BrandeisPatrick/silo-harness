// Live check of the shell sandbox in the real window, with the mock model scripted for the agent and for the check,
// and "sandbox": { "enabled": true } in the test's own settings.json. In Auto mode: a heredoc into /tmp and a test
// run go through with no check; a Python write to a protected path in the project (.vscode) hits the sandbox, goes to
// the check, is allowed and runs again outside; git add and npm install go straight to the check (allowed, blocked),
// with no sandboxed first run. Five calls, three checks. In Plan mode a read runs in the read-only sandbox: a grep that
// reaches .env reads no secret, and the agent is told why. Temp folders only.
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

  const app = await launch({ mode: 'auto', mock: true, profile, ownsProfile: true, project, config: { theme: 'light' } });
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
    await app.screenshot(path.join(shots, 'sandbox-auto.png'));

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
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
