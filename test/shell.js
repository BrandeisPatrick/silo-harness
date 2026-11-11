// The bash tool: output and exit code, and that stopping a run (the abort signal) or a timeout ends the command
// together with everything it started. Run: node test/shell.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { bash, shellResult, interactiveLogin, loginRedirect } = require(path.join(projectDir, 'dist/main/tools/shell.js'));
const { truncateMiddle } = require(path.join(projectDir, 'dist/main/tools/types.js'));
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-shell-'));
  const ctx = (signal) => ({ cwd, signal, approve: async () => ({ ok: true }) });

  const plain = await bash.run({ command: 'echo hello && echo oops >&2 && exit 3' }, ctx());
  check('stdout, stderr and the exit code are reported', /hello/.test(plain.content) && /\[stderr\]\noops/.test(plain.content) && /\[exit code: 3\]/.test(plain.content), plain.content);

  const denied = await bash.run({ command: 'echo no' }, { cwd, approve: async () => ({ ok: false, message: 'Not permitted: test' }) });
  check('a denied command does not run', denied.content === 'Not permitted: test', denied.content);

  // Long output keeps its start, its end and the exit code
  const long = await bash.run({ command: 'seq 1 50000; exit 3' }, ctx());
  const c = long.content;
  check('long output ends with the exit code', c.endsWith('[exit code: 3]'), c.slice(-80));
  check('… keeps its first and last lines', c.startsWith('1\n2\n') && c.includes('\n50000\n'), c.slice(-80));
  check('… says what it left out, and stays under 31K characters', /\[… \d+ characters left out …\]\n/.test(c) && c.length < 31_000, c.length);
  const both = shellResult('o'.repeat(100) + '\n' + 'x\n'.repeat(40_000), 'e\n'.repeat(20_000) + 'LAST ERROR\n', 2);
  check('stdout and stderr share the budget, each keeping its end', both.includes('LAST ERROR') && both.includes('[stderr]') && both.endsWith('[exit code: 2]') && both.length < 31_000, both.length);
  check('short output is unchanged', shellResult('hi\n', '', 0) === 'hi\n[exit code: 0]' && shellResult('a', 'b', 1) === 'a\n[stderr]\nb\n[exit code: 1]');
  check('truncateMiddle: within the limit unchanged', truncateMiddle('abc\ndef', 100) === 'abc\ndef');
  const cut = truncateMiddle(Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n'), 1000);
  check('truncateMiddle: cuts on line boundaries', /^line 0\n/.test(cut) && cut.endsWith('line 999') && cut.split('\n').every((l) => /^line \d+$|^\[… \d+ characters left out …\]$/.test(l)), cut.slice(0, 200));

  // Stop: the shell and the process it started are both gone, promptly.
  {
    const pidFile = path.join(cwd, 'child.pid');
    const ac = new AbortController();
    const started = Date.now();
    const pending = bash.run({ command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait` }, ctx(ac.signal));
    await sleep(400);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    check('the command started a child process', childPid > 0 && alive(childPid), childPid);
    ac.abort();
    const res = await pending;
    const took = Date.now() - started;
    check('stopping ends the command at once, not after its 30 seconds', took < 4000, took);
    check('the result says it was stopped', /\[exit code: stopped by the user\]/.test(res.content), res.content);
    await sleep(300);
    check('the process it started is gone too', !alive(childPid), childPid);
  }

  // A signal that is already aborted: the command is stopped straight away.
  {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const res = await bash.run({ command: 'sleep 20' }, ctx(ac.signal));
    check('an already-stopped run does not wait for the command', Date.now() - started < 4000 && /stopped by the user/.test(res.content), res.content);
  }

  // Timeout: same, with its own wording.
  {
    const pidFile = path.join(cwd, 'child2.pid');
    const started = Date.now();
    const res = await bash.run({ command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`, timeout_ms: 1000 }, ctx());
    const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    check('a timeout ends the command', Date.now() - started < 5000 && /\[exit code: killed \(timeout after 1000 ms\)\]/.test(res.content), res.content);
    await sleep(300);
    check('and what it started', !alive(childPid), childPid);
  }

  // A command that ignores SIGTERM is killed after the grace period.
  {
    const ac = new AbortController();
    const started = Date.now();
    const pending = bash.run({ command: `trap '' TERM; sleep 30` }, ctx(ac.signal));
    await sleep(300);
    ac.abort();
    await pending;
    check('a command that ignores the polite signal is killed anyway', Date.now() - started < 6000, Date.now() - started);
  }

  // Sign-ins that wait for the user: said at once, before any approval, never run
  const logins = [
    ['aws sso login', 'aws sso login'],
    ['aws sso login --profile dev', 'aws sso login'],
    ['aws --profile dev sso login', 'aws sso login'],
    ['AWS_PROFILE=dev aws sso login', 'aws sso login'],
    ['aws configure sso', 'aws configure sso'],
    ['aws login', 'aws login'],
    ['gcloud auth login', 'gcloud auth login'],
    ['gcloud auth login --no-launch-browser', 'gcloud auth login'],
    ['gcloud auth application-default login', 'gcloud auth application-default login'],
    ['az login', 'az login'],
    ['az login --use-device-code', 'az login'],
    ['gh auth login', 'gh auth login'],
    ['gh auth login --web -h github.com', 'gh auth login'],
    ['npm login', 'npm login'],
    ['npm adduser', 'npm adduser'],
    ['docker login', 'docker login'],
    ['docker login registry.example.com -u someone', 'docker login'],
    ['cd app && aws sso login && aws sts get-caller-identity', 'aws sso login'],
  ];
  for (const [cmd, want] of logins) check(`login: ${cmd}`, interactiveLogin(cmd) === want, interactiveLogin(cmd));
  for (const cmd of ['aws sts get-caller-identity', 'aws s3 ls', 'aws logs tail /example', 'gcloud auth list', 'gcloud auth login --cred-file=key.json', 'az login --service-principal -u a -p b --tenant t', 'az login --identity', 'az account show', 'gh auth status', 'gh auth login --with-token < token.txt', 'npm run login', 'npm install', 'docker login --password-stdin -u someone', 'docker login -u someone -p x', 'docker logout', 'grep -r login src', 'echo aws sso login']) {
    check(`not a login: ${cmd}`, interactiveLogin(cmd) === null, interactiveLogin(cmd));
  }
  let asked = 0;
  const redirect = await bash.run({ command: 'aws sso login --profile dev' }, { cwd, approve: async () => (asked++, { ok: true }) });
  check('login: the result says to use terminal_run, without asking or running', redirect.content === loginRedirect('aws sso login') && asked === 0, redirect.content);
  check('login: … in two short lines at most', redirect.content.length < 200 && /terminal_run/.test(redirect.content), redirect.content.length);

  // Unmatched wildcards pass through as in bash
  const glob = await bash.run({ command: 'echo --include=*.no-such-ext src/*.zzz' }, ctx());
  check('an unmatched wildcard passes through, as in bash', glob.content === '--include=*.no-such-ext src/*.zzz\n[exit code: 0]', glob.content);
  fs.writeFileSync(path.join(cwd, 'one.ts'), 'x');
  const matched = await bash.run({ command: 'echo *.ts' }, ctx());
  check('… a matching one still expands', matched.content === 'one.ts\n[exit code: 0]', matched.content);

  // The pipeline's exit code is still its last command's (no pipefail)
  const piped = await bash.run({ command: 'false | true' }, ctx());
  check('a pipeline keeps its last command\'s exit code', /\[exit code: 0\]$/.test(piped.content), piped.content);

  // Results that say what happened, and what to do, the exit code last (the transcript reads it from the end)
  const slow = await bash.run({ command: 'sleep 5', timeout_ms: 1000 }, ctx());
  check('timeout: one line on raising timeout_ms or using the terminal, then the exit code', /\n?\[timed out: raise timeout_ms \(up to 600000, now 1000\), or run it with terminal_run\]\n\[exit code: killed \(timeout after 1000 ms\)\]$/.test(slow.content), slow.content);
  const noTimeout = await bash.run({ command: 'print -u2 "zsh:1: command not found: timeout"; exit 127' }, ctx());
  check('timeout missing: says to use timeout_ms', noTimeout.content.endsWith("[macOS has no timeout: use this tool's timeout_ms]\n[exit code: 127]"), noTimeout.content);
  const gnu = await bash.run({ command: 'print -u2 "zsh:1: command not found: gtimeout"; exit 127' }, ctx());
  check('gtimeout missing: the same', gnu.content.includes("[macOS has no timeout: use this tool's timeout_ms]"), gnu.content);
  const nostart = await bash.run({ command: 'echo hi' }, { cwd: path.join(cwd, 'no-such-folder'), approve: async () => ({ ok: true }) });
  check('could not start: says so', /^\[exit code: could not start \(.+\)\]$/.test(nostart.content), nostart.content);
  const signalled = await bash.run({ command: 'kill -9 $$' }, ctx());
  check('killed by a signal: names it', /\[exit code: killed \(SIGKILL\)\]$/.test(signalled.content), signalled.content);
  check('the description stays short', bash.description.length < 420, bash.description.length);

  // path: the folder a call starts in. It is approved as `cd '<folder>' && <command>` (what the rules, the check and
  // the card read), and the command runs there; the session's own folder, or none, changes nothing.
  {
    const real = fs.realpathSync(cwd);
    fs.mkdirSync(path.join(cwd, 'sub', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'sub', 'f.txt'), 'made-up sub file\n');
    const seen = [];
    const at = (ok = true) => ({ cwd, approve: async (name, detail) => (seen.push([name, detail]), ok ? { ok: true } : { ok: false, message: 'Not permitted: test' }) });
    const out = (r) => r.content.replace(/\n?\[exit code: \d+\]$/, '').trim();
    let r = await bash.run({ command: 'pwd -P && cat f.txt', path: 'sub' }, at());
    check('path: the command runs in that folder', out(r) === `${path.join(real, 'sub')}\nmade-up sub file`, r.content);
    check('path: approved as cd <folder> && <command>', seen.pop()?.join('|') === `bash|cd '${path.join(cwd, 'sub')}' && pwd -P && cat f.txt`, seen);
    r = await bash.run({ command: 'pwd -P', path: path.join(cwd, 'sub', 'deeper') }, at());
    check('path: an absolute folder', out(r) === path.join(real, 'sub', 'deeper') && seen.pop()?.[1] === `cd '${path.join(cwd, 'sub', 'deeper')}' && pwd -P`, r.content);
    r = await bash.run({ command: 'pwd -P' }, at());
    check('path: none, the session folder, the command as it is', out(r) === real && seen.pop()?.[1] === 'pwd -P', r.content);
    for (const p of ['', '.', cwd, `${cwd}/`]) {
      r = await bash.run({ command: 'pwd -P', path: p }, at());
      check(`path: ${JSON.stringify(p === cwd ? '<session folder>' : p === `${cwd}/` ? '<session folder>/' : p)} is the session folder, nothing added`, out(r) === real && seen.pop()?.[1] === 'pwd -P', r.content);
    }
    const marker = path.join(cwd, 'sub', 'ran.txt');
    r = await bash.run({ command: 'touch ran.txt', path: 'sub' }, at(false));
    check('path: denied, nothing runs', r.content === 'Not permitted: test' && !fs.existsSync(marker), r.content);
    const err = (args) => bash.run(args, at()).then((x) => x.content, (e) => `ERROR: ${e.message}`);
    let e = await err({ command: 'touch ran.txt', path: 'no-such-folder' });
    check('path: a folder that is not there is an error, after the approval, and nothing runs', e === `ERROR: path is not a folder: ${path.join(cwd, 'no-such-folder')}` && seen.pop()?.[1].startsWith("cd '"), e);
    e = await err({ command: 'touch ran.txt', path: 'sub/f.txt' });
    check('path: a file is not a folder', e.startsWith('ERROR: path is not a folder') && !fs.existsSync(marker), e);
    seen.length = 0;
    r = await bash.run({ command: 'cat id_rsa', path: '~/.ssh' }, at(false));
    check('path: ~ is the home folder (the call is only approved here, never run)', seen[0]?.[1] === `cd '${path.join(os.homedir(), '.ssh')}' && cat id_rsa` && r.content === 'Not permitted: test', seen);
    check('path: in the schema, said in the description', bash.parameters.properties.path?.type === 'string' && /starts? in the working directory; path picks another folder/.test(bash.description) && /edit_file or write_file, not scripts/.test(bash.description), bash.description);
  }

  fs.rmSync(cwd, { recursive: true, force: true });
  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
