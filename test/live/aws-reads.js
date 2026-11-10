// Live check of recognised read-only aws commands (guard.ts isAwsRead) in the real window, mock model. Auto mode: a
// recognised read runs with no safety-check request and no card; an unrecognised aws command still goes to the check.
// Ask mode: the read shows the plain card (no reason, "Allow aws for this session"); the other shows the cloud card.
// aws is never the real CLI: the shell's start-up files come from a folder of this script's (ZDOTDIR) that defines
// aws as a function printing its arguments, and the AWS config and credential files point at nothing.
// Run: npm run build && node test/live/aws-reads.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launch, checker } = require('./rig.js');
const { classifierReply, isClassifierRequest } = require('../support/mock-model.js');

const { check, done } = checker();

const lastMsg = (p) => p.messages?.[p.messages.length - 1];
const afterTool = (p) => lastMsg(p)?.role === 'tool';
const userSays = (text) => (p) => {
  const m = lastMsg(p);
  return m?.role === 'user' && JSON.stringify(m.content).includes(text);
};

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-aws-'));
  fs.mkdirSync(shots, { recursive: true });
  const zdot = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-aws-zdot-'));
  const stub = 'aws() { print -r -- "stub-aws $*"; }\n';
  for (const f of ['.zshenv', '.zprofile', '.zlogin']) fs.writeFileSync(path.join(zdot, f), stub);
  const nothing = path.join(zdot, 'no-such-file');
  const env = { ZDOTDIR: zdot, AWS_CONFIG_FILE: nothing, AWS_SHARED_CREDENTIALS_FILE: nothing, AWS_EC2_METADATA_DISABLED: 'true', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '', AWS_PROFILE: '' };
  // The shell tool runs `/bin/zsh -lc`: make sure that shell finds the stub, not a real aws, before the app starts
  const probe = spawnSync('/bin/zsh', ['-lc', 'whence -w aws'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  if (probe.stdout.trim() !== 'aws: function') {
    console.error(`LIVE TEST CRASHED: the aws stub is not in effect (${probe.stdout.trim() || probe.stderr.trim()}); not starting`);
    process.exit(1);
  }

  const READ = 'aws sts get-caller-identity --output json --no-cli-pager';
  const OTHER = 'aws ec2 terminate-instances --instance-ids i-0abc1234example';

  // ---------- 1. Auto mode with the check ----------
  let project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-aws-project-'));
  let app = await launch({ mode: 'auto', mock: true, project, env });
  try {
    const { replies, requests } = app.mock.state;
    const checks = () => requests.filter((r) => isClassifierRequest(r.payload)).length;
    const toolResult = (id) => requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content;

    replies.push({ content: '', toolCalls: [{ id: 'r1', name: 'bash', args: { command: READ, description: 'Show the caller identity' } }], when: userSays('Who am I') });
    replies.push({ content: 'Done.', when: afterTool });
    await app.send('Who am I in the cloud account?');
    await app.waitIdle(30_000);
    check('auto: a recognised read ran', /stub-aws sts get-caller-identity --output json --no-cli-pager/.test(toolResult('r1') ?? ''), toolResult('r1'));
    check('auto: … with no safety-check request', checks() === 0, checks());
    check('auto: … and no card', !(await app.exists('.approval')));

    replies.push({ content: '', toolCalls: [{ id: 'r2', name: 'bash', args: { command: OTHER, description: 'Terminate the instance' } }], when: userSays('Terminate') });
    replies.push(classifierReply('block', '[Infrastructure] terminates an EC2 instance'));
    replies.push({ content: 'Blocked.', when: afterTool });
    await app.send('Terminate the demo instance.');
    await app.waitIdle(30_000);
    check('auto: an unrecognised aws command made one safety-check request', checks() === 1, checks());
    check('auto: … was blocked and did not run', /^Blocked by Auto mode: \[Infrastructure\]/.test(toolResult('r2') ?? '') && !/stub-aws/.test(toolResult('r2') ?? ''), toolResult('r2'));
    const errors = app.console.filter((x) => /^\[(error|exception)\]/.test(x));
    check('auto: no renderer errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await app.close();
    fs.rmSync(project, { recursive: true, force: true });
  }

  // ---------- 2. Ask mode (the default) ----------
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-aws-project-'));
  app = await launch({ mode: 'ask', mock: true, project, env });
  try {
    const { replies, requests } = app.mock.state;
    const toolResult = (id) => requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content;
    const card = () => app.evaluate(`(() => { const c = [...document.querySelectorAll('.approval')].filter((e) => !e.classList.contains('decided')).pop(); return c ? { text: c.innerText.replace(/\\s+/g, ' ').trim(), flagged: c.classList.contains('flagged') } : null; })()`);

    replies.push({ content: '', toolCalls: [{ id: 'a1', name: 'bash', args: { command: READ, description: 'Show the caller identity' } }], when: userSays('Who am I') });
    replies.push({ content: 'Done.', when: afterTool });
    await app.send('Who am I in the cloud account?');
    await app.waitFor(`Boolean(document.querySelector('.approval:not(.decided) .btn'))`, 30_000, 'the card for the read');
    let c = await card();
    check('ask: a recognised read shows the plain card, no reason', c && !c.flagged && !/cloud or infrastructure/.test(c.text) && /aws sts get-caller-identity/.test(c.text), c);
    await app.screenshot(path.join(shots, 'aws-read-card.png'));
    await app.approve('deny');
    await app.waitIdle(30_000);
    check('ask: denied, nothing ran', /^Not permitted: the user denied/.test(toolResult('a1') ?? ''), toolResult('a1'));

    replies.push({ content: '', toolCalls: [{ id: 'a2', name: 'bash', args: { command: OTHER, description: 'Terminate the instance' } }], when: userSays('Terminate') });
    replies.push({ content: 'Denied.', when: afterTool });
    await app.send('Terminate the demo instance.');
    await app.waitFor(`Boolean(document.querySelector('.approval:not(.decided) .btn'))`, 30_000, 'the card for terminate-instances');
    c = await card();
    check('ask: an unrecognised aws command shows the cloud card', c && c.flagged && /cloud or infrastructure change/.test(c.text), c);
    await app.approve('deny');
    await app.waitIdle(30_000);
    check('ask: denied, nothing ran', /^Not permitted: the user denied/.test(toolResult('a2') ?? ''), toolResult('a2'));
    const errors = app.console.filter((x) => /^\[(error|exception)\]/.test(x));
    check('ask: no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${shots}`);
  } finally {
    await app.close();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(zdot, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
