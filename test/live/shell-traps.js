// Live check of the shell tool's traps in the real window, mock model, Auto mode: a sign-in that waits for the user
// (aws sso login) is not run and the result says to use terminal_run, with no safety check and no card; terminal_run
// still goes to the check; an unmatched wildcard (grep --include=*.ts) passes through; a timeout says how to raise it.
// aws is never the real CLI: the shell's start-up files come from a folder of this script's (ZDOTDIR) that defines
// aws as a function printing its arguments.
// Run: npm run build && node test/live/shell-traps.js [screenshot-dir]
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
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-traps-'));
  fs.mkdirSync(shots, { recursive: true });
  const zdot = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-traps-zdot-'));
  const stub = 'aws() { print -r -- "stub-aws $*"; }\n';
  for (const f of ['.zshenv', '.zprofile', '.zlogin']) fs.writeFileSync(path.join(zdot, f), stub);
  const nothing = path.join(zdot, 'no-such-file');
  const env = { ZDOTDIR: zdot, AWS_CONFIG_FILE: nothing, AWS_SHARED_CREDENTIALS_FILE: nothing, AWS_EC2_METADATA_DISABLED: 'true', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '', AWS_PROFILE: '' };
  const probe = spawnSync('/bin/zsh', ['-lc', 'whence -w aws'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  if (probe.stdout.trim() !== 'aws: function') {
    console.error(`LIVE TEST CRASHED: the aws stub is not in effect (${probe.stdout.trim() || probe.stderr.trim()}); not starting`);
    process.exit(1);
  }

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-traps-project-'));
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'const NEEDLE = 1;\n');
  fs.writeFileSync(path.join(project, 'src', 'b.md'), 'NEEDLE in markdown\n');
  const app = await launch({ mode: 'auto', mock: true, project, env });
  try {
    const { replies, requests } = app.mock.state;
    const checks = () => requests.filter((r) => isClassifierRequest(r.payload)).length;
    const toolResult = (id) => requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content;
    const turn = async (id, name, args, say, extra = []) => {
      replies.push({ content: '', toolCalls: [{ id, name, args }], when: userSays(say) });
      for (const r of extra) replies.push(r);
      replies.push({ content: 'Done.', when: afterTool });
      await app.send(say);
      await app.waitIdle(60_000);
      return toolResult(id) ?? '';
    };

    // ---------- 1. A sign-in in the shell tool: said at once ----------
    let started = Date.now();
    let res = await turn('t1', 'bash', { command: 'aws sso login --profile dev', description: 'Sign in' }, 'Sign in to the cloud account.');
    check('login: not run, the result says to use terminal_run', /^Not run: aws sso login waits for the user to sign in.*terminal_run/.test(res) && !/stub-aws/.test(res), res);
    check('login: no safety check, no card, at once', checks() === 0 && !(await app.exists('.approval')) && Date.now() - started < 20_000, { checks: checks(), ms: Date.now() - started });

    // terminal_run still asks as before: in Auto mode the check decides (blocked here, so nothing runs)
    res = await turn('t2', 'terminal_run', { command: 'aws sso login --profile dev' }, 'Use the terminal then.', [classifierReply('block', '[Other] test: not now')]);
    check('login: terminal_run still goes to the check', checks() === 1 && /^Blocked by Auto mode: \[Other\]/.test(res), { checks: checks(), res });

    // ---------- 2. An unmatched wildcard passes through ----------
    res = await turn('t3', 'bash', { command: 'grep -rn NEEDLE --include=*.ts src' }, 'Find NEEDLE in the TypeScript files.');
    check('wildcard: grep --include=*.ts ran as in bash', /src\/a\.ts:1:const NEEDLE = 1;/.test(res) && !/b\.md/.test(res) && !/no matches found/.test(res) && /\[exit code: 0\]$/.test(res), res);
    check('wildcard: a read, so no check', checks() === 1, checks());

    // ---------- 3. A timeout says how to raise it ----------
    res = await turn('t4', 'bash', { command: 'sleep 5', timeout_ms: 1000 }, 'Wait a little.');
    check('timeout: the hint, then the exit code', /\[timed out: raise timeout_ms \(up to 600000, now 1000\), or run it with terminal_run\]\n\[exit code: killed \(timeout after 1000 ms\)\]$/.test(res), res);
    const row = await app.evaluate(`[...document.querySelectorAll('#messages .tool')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()).find((t) => t.includes('sleep 5')) ?? ''`);
    check('timeout: the row still shows how the command ended', /killed \(timeout after 1000 ms\)/.test(row), row);
    await app.screenshot(path.join(shots, 'shell-traps.png'));

    const errors = app.console.filter((x) => /^\[(error|exception)\]/.test(x));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
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
