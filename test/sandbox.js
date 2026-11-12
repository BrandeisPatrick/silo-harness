// The shell sandbox (docs/research/shell-sandbox-design.md): the profile from a folder, block detection, the commands
// that skip the sandbox, the environment filter, the settings keys, protectedWrite at any depth and the wider secret
// list; decideApproval in every mode with the sandbox on, off, paused and with the check unavailable (off must be
// exactly as before); then, on macOS, the real bash tool under the real sandbox-exec in a temp project (writes inside
// and outside, a nested .git, a secret, the network, a child process, signals, a notification, a broken profile) and
// the agent with the mock model (no check for a sandboxed command, a block's check and rerun, Plan mode, a pause).
// Temp folders and harmless commands only. Run: node test/sandbox.js <projectDir>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const sb = dist('sandbox/index.js');
const { buildProfile, escapeRegex, embeddable, PROTECTED_NAMES, OPEN_NAMES, SERVICE_PORTS } = dist('sandbox/profile.js');
const { decideApproval, SANDBOX_REASON } = dist('agent/permissions.js');
const guard = dist('guard.js');
const { bash, sandboxBash, runShell, PLAN_SANDBOX_NOTE, rerunNote } = dist('tools/shell.js');
const { allTools } = dist('tools/index.js');
const { SettingsLayer, checkSetting, settingsSchema } = dist('settings.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sandbox-')));
const home = os.homedir();

(async () => {
  // ---------- 1. The profile (pure) ----------
  {
    const proj = '/private/tmp/My Proj (1)+[x]{y}^$|?*.';
    const input = {
      project: proj,
      temp: ['/private/tmp', '/private/var/folders/ab/cd'],
      extra: ['/Users/someone/other repo'],
      loopback: false,
      deniedPorts: [5432],
      readOnly: false,
      secretNames: guard.SECRET_NAMES,
      secretPaths: ['/Users/someone/Library/Keychains'],
      protectedPaths: ['/Users/someone/.zshrc'],
      protectedFolders: ['/Users/someone/.silo-harness'],
    };
    const p = buildProfile(input);
    const t = p.text;
    check('profile: built for a folder with spaces and regex characters', !!p && p.params.PROJECT === proj);
    check('profile: the folder is escaped in its regexes', t.includes(`^${escapeRegex(proj)}/(.*/)?`) && escapeRegex(proj) === '/private/tmp/My Proj \\(1\\)\\+\\[x\\]\\{y\\}\\^\\$\\|\\?\\*\\.', escapeRegex(proj));
    check('profile: allow by default, every write denied first', t.startsWith('(version 1)\n(allow default)') && t.indexOf('(deny file-write*)') < t.indexOf('(allow file-write*'));
    check('profile: project, temp folders and listed folders writable, by parameter', t.includes('(subpath (param "PROJECT"))') && Object.values(p.params).includes('/private/tmp') && Object.values(p.params).includes('/private/var/folders/ab/cd') && Object.values(p.params).includes('/Users/someone/other repo'));
    check('profile: the null device and pipes writable', t.includes('(literal "/dev/null")') && t.includes('(regex #"^/dev/fd/[0-9]+$")'));
    check('profile: the project folder itself cannot be moved or removed', /\(deny file-write\* \(literal \(param "PROJECT"\)\)/.test(t));
    check('profile: protected names denied at any depth, open folders allowed after', PROTECTED_NAMES.every((n) => t.includes(escapeRegex(n))) && OPEN_NAMES.every((n) => t.includes(escapeRegex(n))) && t.indexOf('\\.vscode') < t.indexOf('\\.claude/skills'));
    check('profile: every .git denied last of the writes, in every folder a command can write (project, listed, temp)', t.lastIndexOf('\\.git(/|$)') > t.lastIndexOf('(allow file-write*') && (t.match(/\(\.\*\/\)\?\\\.git\(\/\|\$\)/g) || []).length === 4 && t.includes('(regex #"^/private/tmp/(.*/)?\\.git(/|$)")'));
    check('profile: protected names in every folder a command can write, temp folders too; .github whole', PROTECTED_NAMES.includes('.github') && !PROTECTED_NAMES.includes('.github/workflows') && t.includes('(regex #"^/private/var/folders/ab/cd/(.*/)?(\\.silo-harness|') && t.includes('|\\.github|'));
    check('profile: secrets cannot be written, renamed or removed where a command can write, nor the folders on the way to one', /\(deny file-write\*\n  \(regex #"\^\/private\/tmp\/My Proj.*\\\.env\(\\\.\[-a-z0-9_\]\+\)\?\|\\\.ssh\|/.test(t) && t.includes('[^/]*\\.(pem|p12|key))(/|$)")') && t.includes('(\\.docker|\\.config|\\.cargo|\\.terraform\\.d|\\.local|\\.local/share|\\.local/share/fish)$")'));
    check('profile: protected paths and rule-file folders denied after the writable folders', t.includes('(subpath (param "KEEP0"))') && t.includes('(literal (param "KEEP1"))') && p.params.KEEP0 === '/Users/someone/.zshrc' && t.indexOf('KEEP0') > t.indexOf('(subpath (param "PROJECT"))'));
    check('profile: secrets unreadable (content only), .env.example readable', t.includes('(deny file-read-data (regex #"/\\.env(\\.[-a-z0-9_]+)?(/|$)"))') && t.includes('(allow file-read-data (regex #"/\\.env\\.(example|sample|template|dist)(/|$)"))') && t.includes('\\.ssh|\\.aws') && t.includes('\\.config/gcloud') && t.includes('\\.zsh_history') && t.includes('(regex #"/[^/]*\\.(pem|p12|key)(/|$)")') && !/deny file-read\*/.test(t));
    check('profile: a secret folder\'s parameter', Object.values(p.params).includes('/Users/someone/Library/Keychains'));
    check('profile: no network but Unix sockets in the project', t.includes('(deny network*)') && !t.includes('localhost:*') && t.includes('(remote unix-socket (subpath (param "PROJECT")))'));
    check('profile: Apple Events, opening apps, launchd jobs and preferences denied', ['(deny appleevent-send)', '(deny lsopen)', '(deny job-creation)', '(deny user-preference-write)'].every((r) => t.includes(r)));
    check('profile: LaunchServices, cfprefsd, the keychain, the clipboard and notifications denied', ['"com.apple.coreservices.launchservicesd"', '"com.apple.lsd."', '"com.apple.cfprefsd.daemon"', '"com.apple.SecurityServer"', '"com.apple.pasteboard."', '"com.apple.usernoted."', '"com.apple.usernotifications."'].every((r) => t.includes(r)));
    check('profile: signals and task ports only inside the same sandbox', t.includes('(deny signal)\n(allow signal (target same-sandbox))') && t.includes('(deny mach-priv-task-port)\n(allow mach-priv-task-port (target same-sandbox))'));
    const lo = buildProfile({ ...input, loopback: true, deniedPorts: [...SERVICE_PORTS, 41234] }).text;
    check('profile: local ports on: bind, accept and connect on localhost, but the denied ports', lo.includes('(allow network-bind network-inbound (local ip4 "localhost:*") (local ip6 "localhost:*"))') && lo.includes('(allow network-outbound (remote ip4 "localhost:*") (remote ip6 "localhost:*"))') && lo.includes('(remote ip4 "localhost:5432") (remote ip6 "localhost:5432")') && lo.includes('(remote ip4 "localhost:41234")') && lo.indexOf('localhost:5432') > lo.indexOf('(remote ip4 "localhost:*")'));
    const ro = buildProfile({ ...input, readOnly: true }).text;
    check('profile: read-only (Plan mode): nothing writable but devices, no temp or listed folder', !ro.includes('(subpath (param "PROJECT"))\n') && !ro.includes('TEMP0') && !ro.includes('EXTRA0') && ro.includes('(allow file-write* (literal "/dev/null")'));
    check('profile: a folder with a quote or a control character is not sandboxed', buildProfile({ ...input, project: '/tmp/a"b' }) === null && buildProfile({ ...input, project: '/tmp/a\nb' }) === null && buildProfile({ ...input, project: '/' }) === null && embeddable('/tmp/a b') && !embeddable('rel/path'));
    const inner = buildProfile({ ...input, extra: [`${proj}/sub`, '/', proj] });
    check('profile: a listed folder inside the project, /, or the project itself is left out', !Object.keys(inner.params).some((k) => k.startsWith('EXTRA')), inner.params);
    check('profile: sandbox-exec arguments: -p, -D per parameter, --, then the command', JSON.stringify(sb.sandboxArgs({ text: 'X', params: { PROJECT: '/p', TEMP0: '/t' } }, ['/bin/zsh', '-lc', 'true'])) === JSON.stringify(['-p', 'X', '-D', 'PROJECT=/p', '-D', 'TEMP0=/t', '--', '/bin/zsh', '-lc', 'true']));
    check('spawned by absolute path', sb.SANDBOX_EXEC === '/usr/bin/sandbox-exec');
  }

  // ---------- 2. Folders, settings, ports ----------
  {
    const realHome = sb.realish(home);
    check('folders: /, the home folder and above, and system folders are not sandboxable', !sb.sandboxableFolder('/', realHome) && !sb.sandboxableFolder(realHome, realHome) && !sb.sandboxableFolder(path.dirname(realHome), realHome) && !sb.sandboxableFolder('/usr', realHome) && sb.sandboxableFolder(path.join(realHome, 'code', 'x'), realHome) && sb.sandboxableFolder(base, realHome));
    const ex = sb.extraFolders(['~/proj-a', '/', '~', 'relative/x', '', path.join(base, 'w')], home);
    check('folders: allowWrite keeps absolute and ~/ folders, drops /, ~ and relative ones', ex.length === 2 && ex[0] === path.join(sb.realish(home), 'proj-a') && ex[1] === path.join(base, 'w'), ex);
    check('settings: defaults off, off, none', JSON.stringify(sb.sandboxSettings(undefined)) === JSON.stringify({ enabled: false, loopback: false, allowWrite: [] }) && sb.sandboxSettings({ enabled: 'yes' }).enabled === false && sb.sandboxSettings({ enabled: true, loopback: true, allowWrite: ['~/x', 3] }).allowWrite.length === 1);
    check('settings: the keys check', checkSetting('sandbox.enabled', true) === null && checkSetting('sandbox.loopback', false) === null && checkSetting('sandbox.allowWrite', ['~/scratch', '/Volumes/Work/x']) === null && checkSetting('sandbox.enabled', 'on') !== null);
    check('settings: allowWrite refuses /, the home folder and relative paths', checkSetting('sandbox.allowWrite', ['/']) !== null && checkSetting('sandbox.allowWrite', ['~']) !== null && checkSetting('sandbox.allowWrite', ['/Users']) !== null && checkSetting('sandbox.allowWrite', ['src']) !== null);
    check('settings: the schema has sandbox', !!settingsSchema().properties.sandbox?.properties?.allowWrite);
    const dir = fs.mkdtempSync(path.join(base, 'settings-'));
    const userFile = path.join(dir, 'user.json');
    fs.writeFileSync(userFile, JSON.stringify({ sandbox: { enabled: true, allowWrite: ['~/scratch'] } }));
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(path.join(proj, '.silo-harness'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.silo-harness', 'settings.json'), JSON.stringify({ sandbox: { loopback: true, allowWrite: ['/Users/Shared'] } }));
    const layer = new SettingsLayer({ userFile });
    const trusted = layer.withTrust({ workingDirectory: proj, settingsTrusted: {} }, true);
    const cfg = layer.load({ workingDirectory: proj, settingsTrusted: trusted.settingsTrusted, browser: {}, ollama: {}, portkey: {}, dreaming: {} });
    const info = layer.info();
    check('settings: your own file turns the sandbox on', cfg.sandbox?.enabled === true && cfg.sandbox.allowWrite?.[0] === '~/scratch', cfg.sandbox);
    check("settings: a project's file may not set sandbox (a problem line)", cfg.sandbox.loopback !== true && !cfg.sandbox.allowWrite.includes('/Users/Shared') && info.files[1].invalid.some((i) => i.key === 'sandbox'), info.files[1]);
    const ports = sb.deniedPorts({ portkey: { baseURL: 'http://127.0.0.1:4100/v1' }, ollama: { baseURL: 'http://localhost:11434/v1' }, providers: { a: { baseURL: 'https://api.example.com/v1' }, b: { baseURL: 'http://[::1]:7000' } } }, [53122, null, 0]);
    check('ports: well-known services, the remote port, local model servers in the config', SERVICE_PORTS.every((p) => ports.includes(p)) && ports.includes(53122) && ports.includes(4100) && ports.includes(7000) && !ports.includes(0), ports);
  }

  // ---------- 3. Detection ----------
  {
    const d = (code, out, err, baseline) => sb.detectBlock(code, out, err, baseline);
    check('detect: touch outside', d(1, '', 'touch: /Users/x/y: Operation not permitted\n')?.line === 'touch: /Users/x/y: Operation not permitted' && d(1, '', 'x: Operation not permitted')?.kind === 'refused');
    check('detect: Python', !!d(1, '', "Traceback (most recent call last):\n  File \"<string>\", line 1\nPermissionError: [Errno 1] Operation not permitted: '/Users/x/y'\n"));
    check('detect: Node EPERM', !!d(1, '', "Error: EPERM: operation not permitted, open '/Users/x/y'\n") && !!d(1, '', 'Error: connect EPERM 192.0.2.1:80\n'));
    check('detect: curl and git', !!d(6, '', 'curl: (6) Could not resolve host: example.com\n') && !!d(128, '', "fatal: Unable to create '/p/.git/index.lock': Operation not permitted\n"));
    check('detect: name lookups, of their own kind', d(1, '', 'socket.gaierror: [Errno 8] nodename nor servname provided, or not known\n')?.kind === 'lookup' && d(1, '', 'Error: getaddrinfo ENOTFOUND registry.npmjs.org\n')?.kind === 'lookup' && d(6, '', 'curl: (6) Could not resolve host: x\n')?.kind === 'lookup');
    check('detect: each kind has fixed words for the check', /refused an operation/.test(sb.BLOCK_KIND_WORDS.refused) && /name lookup/.test(sb.BLOCK_KIND_WORDS.lookup));
    check('detect: exit 2 counts (make and grep report a refused write with 2)', !!d(2, '', 'grep: ./.env: Operation not permitted\n') && !!d(2, 'make: *** [all] Error 1\n', 'sh: out/x: Operation not permitted\n'));
    check('detect: exit 0 with the words, 126, 127, a stop and a timeout are not blocks', d(0, 'EPERM test passed: Operation not permitted', '') === null && d(126, '', 'zsh: operation not permitted: ./x') === null && d(127, '', 'zsh: command not found: x (operation not permitted)') === null && d('stopped by the user', '', 'Operation not permitted') === null && d('killed (timeout after 1000 ms)', '', 'EPERM') === null);
    check('detect: a plain failure is not a block', d(1, '', 'Error: Cannot find module x\n') === null && d(1, '', 'cat: x: Permission denied\n') === null);
    check('detect: lines the login profile prints on its own are ignored', d(1, '', 'pyenv: cannot rehash: Operation not permitted\n', ['pyenv: cannot rehash: Operation not permitted']) === null && !!d(1, '', 'pyenv: cannot rehash: Operation not permitted\ncp: /x: Operation not permitted\n', ['pyenv: cannot rehash: Operation not permitted']));
    check('detect: a long line is cut', d(1, '', `${'x'.repeat(400)} Operation not permitted`).line.length === 300);
    check('broken profile: exit 65 with sandbox-exec\'s own message', sb.brokenProfile(65, 'sandbox-exec: unbound variable: X at <input string>') && !sb.brokenProfile(65, 'my tool: bad data') && !sb.brokenProfile(1, 'sandbox-exec: x'));
    check('baseline lines: trimmed, unique, non-empty', JSON.stringify(sb.outputLines('a\n\n a \n', 'b\n')) === JSON.stringify(['b', 'a']));
  }

  // ---------- 4. The commands that skip the sandbox ----------
  {
    const s = (c, o) => sb.skipsSandbox(c, o);
    const outside = ['npm install', 'npm i left-pad', 'pnpm add x', 'yarn', 'yarn add x', 'bun install', 'npm ci', 'npm view react', 'pip install x', 'python3 -m pip install x', 'uv sync', 'gem install x', 'cargo add serde', 'go get x', 'brew install x', 'curl https://example.com', 'wget http://x.org/a', 'gh pr list', 'git push', 'git fetch', 'git pull', 'git clone https://x/y', 'git add .', 'git commit -m x', 'git checkout -b x', 'git -c core.pager=x log', 'git branch -D x', 'git ls-remote origin', 'kill 123', 'killall node', 'open .', 'osascript -e x', 'launchctl list', 'defaults read x', 'security find-generic-password', 'aws s3 ls', 'kubectl get pods', 'docker ps', 'ssh host', 'cd sub && npm install', 'echo $(curl https://x)', 'sh -c "git push"'];
    const inside = ['npm test', 'npm run build', 'node x.js', 'python3 x.py', 'pytest', 'make', 'git status', 'git log --oneline', 'git diff HEAD', 'git branch', 'git branch --list', 'git stash list', 'ls -la', 'cat > /tmp/x <<EOF\nhi\nEOF', 'npx tsc --noEmit', 'cargo test', 'go test ./...', 'rm -rf build'];
    const wrong = outside.filter((c) => s(c) === null);
    check('known list: installs, network clients, git writes, other apps and processes skip the sandbox', wrong.length === 0, wrong);
    const wrong2 = inside.filter((c) => s(c) !== null);
    check('known list: the rest runs in the sandbox', wrong2.length === 0, wrong2.map((c) => [c, s(c)]));
    check('known list: curl to localhost runs inside only with local ports open', s('curl -s http://localhost:3000/health') === 'curl' && s('curl -s http://localhost:3000/health', { loopback: true }) === null && s('curl http://127.0.0.1:8080 https://example.com', { loopback: true }) === 'curl');
  }

  // ---------- 5. The environment, the secret list, protected writes ----------
  {
    const env = sb.sandboxEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', DB_PASSWORD: 'p', client_secret: 'c', KEYCHAIN_PATH: 'kp', TOKENIZERS_PARALLELISM: 'false' });
    check('environment: secret-named variables are dropped, the rest kept', JSON.stringify(Object.keys(env).sort()) === JSON.stringify(['HOME', 'KEYCHAIN_PATH', 'PATH', 'TOKENIZERS_PARALLELISM']), Object.keys(env));
    const widened = ['~/.config/gcloud/application_default_credentials.json', '~/.kube/config', '~/.azure/accessTokens.json', '~/.git-credentials', '~/.cargo/credentials.toml', '~/.terraform.d/credentials.tfrc.json', '~/.zsh_history', '~/.bash_history', '~/.python_history', '~/Library/Keychains/login.keychain-db', '~/Library/Application Support/Google/Chrome/Default/Cookies', '~/Library/Application Support/Firefox/Profiles/x/key4.db', '~/Library/Cookies/Cookies.binarycookies'];
    const missed = widened.filter((p) => !guard.isSecretPath(p, home));
    check('secrets: the wider list (question 5) in the guard', missed.length === 0, missed);
    check('secrets: the guard asks for a command that reads one', guard.guardCommand('cat ~/.kube/config', base) === 'reads secrets' && guard.guardCommand('cat ~/.zsh_history', base) === 'reads secrets' && guard.guardCommand('cat ~/.gitconfig', base) === null);
    check('secrets: .env.example and plain files are not', !guard.isSecretPath('.env.example', base) && !guard.isSecretPath('src/kube.ts', base) && !guard.isSecretPath('~/.config/git/ignore', home));
    const pw = (rel) => guard.protectedWrite(path.join(base, rel), base);
    check('protectedWrite: .git at any depth', pw('.git/config') === 'modifies the .git directory' && pw('sub/.git/hooks/pre-commit') === 'modifies the .git directory' && pw('a/b/.git') === 'modifies the .git directory' && pw('sub/.GIT/config') === 'modifies the .git directory' && pw('src/git/x.ts') === null && pw('.github/x.md') === null);
    check('protectedWrite: protected names at any depth', pw('sub/.vscode/tasks.json') === 'writes a protected file' && pw('pkg/.envrc') === 'writes a protected file' && pw('pkg/.claude/settings.json') === 'writes a protected file' && pw('pkg/.github/workflows/ci.yml') === 'writes a protected file' && pw('pkg/.mcp.json') === 'writes a protected file');
    check('protectedWrite: open folders stay open at any depth', pw('.claude/skills/x/SKILL.md') === null && pw('pkg/.claude/commands/x.md') === null && pw('.claude/worktrees/w/src/a.ts') === null && pw('src/a.ts') === null);
    check('guardWrite: a nested .git', guard.guardWrite(path.join(base, 'sub/.git/config'), base) === 'modifies the .git directory' && guard.guardWrite(path.join(base, 'src/a.ts'), base) === null);
    const g = guard.sandboxGuardPaths(base);
    const within = (a, b) => a === b || b.startsWith(`${a}/`);
    const covered = (f) => g.protectedPaths.some((p) => within(p, f));
    check('guard paths for the profile: secrets, protected home files, the rule files and their folders', g.secretNames.includes('.kube') && g.secretPaths.some((p) => p.endsWith('Library/Keychains')) && g.protectedPaths.some((p) => p.endsWith('/.zshrc')) && g.protectedPaths.some((p) => p.endsWith('Library/LaunchAgents')) && guard.ruleFiles().every(covered) && guard.ruleFiles().every((f) => covered(path.dirname(f)) || g.protectedFolders.includes(path.dirname(f))) && !g.protectedPaths.some((p) => g.protectedPaths.some((q) => q !== p && within(q, p))), g);
    // A session in the config folder (as the tests' default folder is): the folder is not protected, its settings.json is, and the folder cannot be moved
    {
      const cfgDir = fs.mkdtempSync(path.join(base, 'cfgdir-'));
      const before = process.env.SILO_HARNESS_CONFIG_DIR;
      process.env.SILO_HARNESS_CONFIG_DIR = cfgDir;
      const gi = guard.sandboxGuardPaths(path.join(cfgDir, 'Silo'));
      if (before === undefined) delete process.env.SILO_HARNESS_CONFIG_DIR;
      else process.env.SILO_HARNESS_CONFIG_DIR = before;
      check('guard paths: a session inside the config folder: its settings.json protected, the folder itself fixed in place', !gi.protectedPaths.includes(cfgDir) && gi.protectedPaths.includes(path.join(cfgDir, 'settings.json')) && gi.protectedFolders.includes(cfgDir), gi);
    }
  }

  // ---------- 6. decideApproval: off is exactly as before; on, per mode ----------
  {
    const cwd = fs.mkdtempSync(path.join(base, 'decide-'));
    const ctx = (over = {}) => ({ mode: 'auto', auto: 'check', cwd, rules: undefined, mcp: () => undefined, allowed: { mcp: () => false, reason: () => false, program: () => false, custom: () => false }, ...over });
    const d = (name, detail, c, opts = {}) => decideApproval(name, detail, undefined, opts, c);
    const commands = ['npm test', 'ls -la', 'git status', 'git push origin main', 'git add .', 'npm install', 'python3 x.py', 'cat ~/.aws/credentials', 'sudo ls', 'rm -rf ~', 'aws sts get-caller-identity', 'echo hi > /tmp/x', 'echo hi > ~/x', 'osascript -e x', 'kill 1', 'curl http://localhost:3000', 'make build', 'cat .env', 'grep -r KEY .', 'cd sub && npm test'];
    const levels = [['ask'], ['acceptEdits'], ['bypass'], ['plan'], ['auto', 'check'], ['auto', 'paused'], ['auto', 'guard']];
    const ruleSets = [undefined, { allow: ['Bash(make:*)', 'Bash(npm test:*)', 'Bash(python3:*)'] }];
    const diff = [];
    for (const [mode, auto] of levels)
      for (const rules of ruleSets)
        for (const name of ['bash', 'terminal_run'])
          for (const cmd of commands)
            for (const opts of [{}, { outside: true }]) {
              const before = JSON.stringify(d(name, cmd, ctx({ mode, auto, rules }), opts));
              if (before !== JSON.stringify(d(name, cmd, ctx({ mode, auto, rules, sandbox: false }), opts))) diff.push({ mode, auto, name, cmd, opts, why: 'sandbox: false' });
              // ask, acceptEdits and bypass never use the sandbox; terminal_run never; outside: true never
              if ((mode !== 'auto' && mode !== 'plan') || name === 'terminal_run' || opts.outside)
                if (before !== JSON.stringify(d(name, cmd, ctx({ mode, auto, rules, sandbox: true, loopback: true }), opts))) diff.push({ mode, auto, name, cmd, opts, why: 'sandbox: true' });
            }
    check(`off: ${levels.length * ruleSets.length * 2 * commands.length * 2} decisions with the sandbox off are as before; on, the modes and calls it does not reach are too`, diff.length === 0, diff.slice(0, 5));

    const on = (over = {}) => ctx({ sandbox: true, ...over });
    const k = (r) => (r.kind === 'sandbox' ? `sandbox${r.readOnly ? ' read-only' : ''}` : r.kind === 'ask' ? `ask${r.custom ? ' custom' : ''}${r.reason ? `: ${r.reason}` : ''}` : r.kind === 'classify' ? `classify${r.reason ? `: ${r.reason}` : ''}` : r.kind);
    const table = [
      // [mode, auto, command, opts, rules, expected]
      ['auto', 'check', 'npm test', {}, undefined, 'sandbox'],
      ['auto', 'check', 'ls -la', {}, undefined, 'sandbox'],
      ['auto', 'check', 'grep -r KEY .', {}, undefined, 'sandbox'],
      ['auto', 'check', 'echo hi > /tmp/x', {}, undefined, 'sandbox'],
      ['auto', 'check', 'python3 x.py', {}, { allow: ['Bash(python3:*)'] }, 'sandbox'],
      ['auto', 'check', 'make build', {}, { allow: ['Bash(make:*)'] }, 'allow'],
      ['auto', 'check', 'git status', {}, { allow: ['Bash(git status:*)'] }, 'allow'],
      ['auto', 'check', 'git push origin main', {}, undefined, 'classify: pushes to a remote'],
      ['auto', 'check', 'echo hi > ~/x', {}, undefined, 'classify: writes outside the working directory'],
      ['auto', 'check', 'cat ~/.aws/credentials', {}, undefined, 'classify: reads secrets'],
      ['auto', 'check', 'npm install', {}, undefined, 'classify'],
      ['auto', 'check', 'git add .', {}, undefined, 'classify'],
      ['auto', 'check', 'kill 1', {}, undefined, 'classify'],
      ['auto', 'check', 'aws sts get-caller-identity', {}, undefined, 'allow'],
      ['auto', 'check', 'sudo ls', {}, undefined, 'ask: uses sudo'],
      ['auto', 'check', 'rm -rf ~', {}, undefined, 'ask: deletes a critical folder'],
      ['auto', 'check', 'npm test', { outside: true }, undefined, 'classify'],
      ['auto', 'check', 'npm test', { sandboxBlock: { line: 'x: Operation not permitted' } }, undefined, `classify: ${SANDBOX_REASON}`],
      ['auto', 'check', 'sudo ls', { sandboxBlock: { line: 'x' } }, undefined, 'ask: uses sudo'],
      ['auto', 'check', 'curl http://localhost:3000', {}, undefined, 'classify'],
      ['auto', 'paused', 'npm test', {}, undefined, 'sandbox'],
      ['auto', 'paused', 'npm test', { sandboxBlock: { line: 'x' } }, undefined, `ask custom: ${SANDBOX_REASON}`],
      ['auto', 'paused', 'npm install', {}, undefined, 'ask'],
      ['auto', 'paused', 'git push origin main', {}, undefined, 'ask: pushes to a remote'],
      ['auto', 'guard', 'npm test', {}, undefined, 'sandbox'],
      ['auto', 'guard', 'ls -la', {}, undefined, 'sandbox'],
      ['auto', 'guard', 'npm test', { sandboxBlock: { line: 'x' } }, undefined, `ask custom: ${SANDBOX_REASON}`],
      ['auto', 'guard', 'npm install', {}, undefined, 'allow'],
      ['auto', 'guard', 'make build', {}, { allow: ['Bash(make:*)'] }, 'allow'],
      ['auto', 'guard', 'git push origin main', {}, undefined, 'ask: pushes to a remote'],
      ['plan', undefined, 'ls -la', {}, undefined, 'sandbox read-only'],
      ['plan', undefined, 'grep -r KEY .', {}, undefined, 'sandbox read-only'],
      ['plan', undefined, 'aws sts get-caller-identity', {}, undefined, 'allow'],
      ['plan', undefined, 'npm view react', {}, undefined, 'allow'],
      ['plan', undefined, 'ls -la', { outside: true }, undefined, 'allow'],
      ['plan', undefined, 'npm test', {}, undefined, 'refuse'],
      ['plan', undefined, 'cat ~/.aws/credentials', {}, undefined, 'ask: reads secrets'],
      ['ask', undefined, 'npm test', {}, undefined, 'ask'],
      ['acceptEdits', undefined, 'ls -la', {}, undefined, 'ask'],
      ['bypass', undefined, 'npm install', {}, undefined, 'allow'],
    ];
    const bad = [];
    for (const [mode, auto, cmd, opts, rules, want] of table) {
      const got = k(d('bash', cmd, on({ mode, auto, rules }), opts));
      if (got !== want) bad.push({ mode, auto, cmd, opts, got, want });
    }
    check(`on: ${table.length} rows over every mode, the check running, paused and unavailable`, bad.length === 0, bad);
    check('on: local ports open lets curl to localhost into the sandbox', k(d('bash', 'curl http://localhost:3000', on({ loopback: true }))) === 'sandbox');
    check('on: terminal_run is never sandboxed', k(d('terminal_run', 'npm test', on())) === 'classify' && k(d('terminal_run', 'ls', on({ mode: 'plan', auto: undefined }))) === 'allow');
    check('on: a write to a rule file still asks, firm', (() => { const r = d('bash', `echo x > ${path.join(home, '.silo-harness', 'settings.json')}`, on()); return r.kind === 'ask' && r.firm; })());
  }

  // ---------- 6b. Counts: /report, the timing summary, the phone ----------
  {
    const { sessionReport } = dist('history/report.js');
    const { summarize } = dist('agent/perf.js');
    const { remoteEvent } = dist('remote/sanitize.js');
    const recs = [
      { t: 1000, seq: 1, type: 'run.start', data: { origin: 'user', timing: 'abcdef12' } },
      { t: 1100, seq: 2, type: 'tool.end', data: { name: 'bash', ok: true, durationMs: 40, sandbox: 'inside' } },
      { t: 1200, seq: 3, type: 'tool.end', data: { name: 'bash', ok: true, durationMs: 50, sandbox: 'rerun' } },
      { t: 1300, seq: 4, type: 'tool.end', data: { name: 'bash', ok: false, durationMs: 30, sandbox: 'blocked' } },
      { t: 1400, seq: 5, type: 'tool.end', data: { name: 'bash', ok: true, durationMs: 30 } },
      { t: 1500, seq: 6, type: 'run.end', data: { reason: 'done' } },
    ];
    const report = sessionReport(recs, { now: 2000 });
    check('/report: the shell sandbox line, only from fixed words', /\*\*Shell sandbox\*\* 3 commands, 1 stayed inside/.test(report) && /- blocked: 2, 1 run again outside/.test(report), report);
    check('/report: no sandbox line when nothing ran in it', !/Shell sandbox/.test(sessionReport(recs.filter((r) => !r.data.sandbox), { now: 2000 })));
    check('/report: an unknown word reads as inside', /\*\*Shell sandbox\*\* 1 command, 1 stayed inside/.test(sessionReport([recs[0], { ...recs[1], data: { ...recs[1].data, sandbox: '<script>' } }, recs[5]], { now: 2000 })));
    const span = (sandbox) => ({ turn: 1, group: 0, name: 'bash', at: 0, startAt: 0, endAt: 10, queueMs: 0, preHookMs: 0, permission: [], execMs: 10, postHookMs: 0, storeMs: 0, wallMs: 10, outcome: 'ok', alongside: 0, ...(sandbox ? { sandbox } : {}) });
    const sum = summarize({ wallMs: 100, turns: [], tools: [span('inside'), span('blocked'), span('rerun'), span()] });
    const none = summarize({ wallMs: 100, turns: [], tools: [span()] });
    check('timing: the run summary counts sandboxed calls, blocks and reruns; none when none ran in it', sum.sandboxed === 3 && sum.sandboxBlocked === 2 && sum.sandboxReruns === 1 && !('sandboxed' in none) && !('sandboxReruns' in none), sum);
    const phone = remoteEvent({ type: 'tool_end', id: 'x', name: 'bash', result: 'r', ok: true, sandbox: { blocked: { kind: 'refused', line: 'l' }, outside: true, first: 'f' } });
    check('the phone gets no sandbox mark (no first run, no line)', phone && !('sandbox' in phone), phone);
  }

  // ---------- 7. The tool definition ----------
  check('tool: bash with the sandbox on says so and takes outside; off, unchanged', !('outside' in bash.parameters.properties) && 'outside' in sandboxBash.parameters.properties && /sandbox/.test(sandboxBash.description) && !/sandbox/.test(bash.description) && allTools('auto', true).includes(sandboxBash) && allTools('auto').includes(bash) && allTools('plan', true).includes(sandboxBash));

  // ---------- 8. macOS: the real sandbox ----------
  const host = process.platform === 'darwin' ? await sb.probeSandbox() : null;
  if (!host) {
    console.log(`skip: the integration rows need macOS and a working sandbox-exec (${process.platform})`);
    return done();
  }
  check('probe: sandbox-exec works here; temp folders found', host.temp.includes('/private/tmp') && host.temp.some((t) => t.startsWith('/private/var/folders/')), host);

  const proj = fs.mkdtempSync(path.join(base, 'proj-'));
  const tmpw = fs.mkdtempSync(path.join(base, 'tmpw-'));
  const outsideDir = fs.mkdtempSync(path.join(base, 'outside-'));
  fs.mkdirSync(path.join(proj, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.git', 'config'), '[core]\n');
  fs.mkdirSync(path.join(proj, 'sub', '.git'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'sub', '.git', 'config'), '[core]\n');
  fs.mkdirSync(path.join(proj, '.vscode'));
  fs.writeFileSync(path.join(proj, '.env'), 'SECRET_VALUE=hunter2\n');
  fs.writeFileSync(path.join(proj, '.env.example'), 'SECRET_VALUE=\n');
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'plain notes\n');
  // A profile as the app builds it, but with one temp folder of this test's, so that a sibling folder is outside
  const g = guard.sandboxGuardPaths(proj);
  const profileOf = (o = {}) => buildProfile({ project: proj, temp: [tmpw], extra: [], loopback: false, deniedPorts: SERVICE_PORTS, readOnly: false, ...g, ...o });
  const run = (cmd, o, timeout = 20_000) => runShell(cmd, proj, { timeout, sandbox: profileOf(o) });
  const out = (r) => `${r.code} ${r.stdout}${r.stderr}`.trim().slice(0, 300);

  let r = await run('echo inside > a.txt && cat a.txt && echo x > ' + JSON.stringify(path.join(tmpw, 't.txt')) + ' && echo tmp-ok');
  check('sandbox: writes in the project and the temp folder', r.code === 0 && /inside/.test(r.stdout) && /tmp-ok/.test(r.stdout) && fs.existsSync(path.join(tmpw, 't.txt')), out(r));
  r = await run(`echo x > ${JSON.stringify(path.join(outsideDir, 'o.txt'))}`);
  check('sandbox: a write outside is refused, and detected', r.code !== 0 && !fs.existsSync(path.join(outsideDir, 'o.txt')) && !!sb.detectBlock(r.code, r.stdout, r.stderr), out(r));
  r = await run(`python3 -c "import subprocess; subprocess.run(['touch', '${path.join(outsideDir, 'child.txt')}'], check=True)"`);
  check('sandbox: a child process inherits it (Python running touch)', r.code !== 0 && !fs.existsSync(path.join(outsideDir, 'child.txt')) && !!sb.detectBlock(r.code, r.stdout, r.stderr), out(r));
  r = await run('echo x >> .git/config; echo y >> sub/.git/config; mkdir -p deep/.git; echo z > m.txt; mv m.txt sub2.git 2>/dev/null; mkdir sub2 && mv m.txt sub2/.git; echo w > .vscode/tasks.json; mv sub/.git sub/git-moved; true');
  check('sandbox: .git (root and nested) read-only, cannot be made or moved; .vscode protected', fs.readFileSync(path.join(proj, '.git', 'config'), 'utf8') === '[core]\n' && fs.readFileSync(path.join(proj, 'sub', '.git', 'config'), 'utf8') === '[core]\n' && !fs.existsSync(path.join(proj, 'deep', '.git')) && !fs.existsSync(path.join(proj, 'sub2', '.git')) && !fs.existsSync(path.join(proj, '.vscode', 'tasks.json')) && fs.existsSync(path.join(proj, 'sub', '.git')), out(r));
  r = await run(`mv ${JSON.stringify(proj)} ${JSON.stringify(path.join(tmpw, 'moved'))}`);
  check('sandbox: the project folder itself cannot be moved away', r.code !== 0 && fs.existsSync(proj), out(r));
  r = await run(`ln .git/config hl.txt; ln -s ${JSON.stringify(path.join(outsideDir))} out-link && echo x > out-link/via-link.txt; true`);
  check('sandbox: a hard link to .git/config and a write through a symlink outside are refused', !fs.existsSync(path.join(proj, 'hl.txt')) && !fs.existsSync(path.join(outsideDir, 'via-link.txt')), out(r));
  r = await run('cat .env');
  check('sandbox: a secret is unreadable', r.code !== 0 && !r.stdout.includes('hunter2') && !!sb.detectBlock(r.code, r.stdout, r.stderr), out(r));
  r = await run('cat .env.example && ls -la | grep -c "\\.env"');
  check('sandbox: .env.example is readable, and ls still lists .env', r.code === 0 && /SECRET_VALUE=\n/.test(r.stdout) && /^2$/m.test(r.stdout), out(r));
  r = await run('grep -r SECRET_VALUE . ; echo "exit=$?"');
  check('sandbox: grep over the project skips the secret with an error, exit 2', /exit=0|exit=2/.test(r.stdout) && !r.stdout.includes('hunter2'), out(r));
  r = await run(`node -e "const s=require('net').connect(80,'192.0.2.1');s.on('error',e=>{console.error(e.code);process.exit(1)});s.on('connect',()=>process.exit(0))"`);
  check('sandbox: the network is closed (EPERM at once, no packets)', r.code === 1 && /EPERM/.test(r.stderr), out(r));
  r = await run(`python3 -c "import socket; socket.getaddrinfo('example.com', 443)"`);
  check('sandbox: name lookups are refused', r.code !== 0 && !!sb.detectBlock(r.code, r.stdout, r.stderr), out(r));
  // A listener outside the sandbox on a free local port: closed by default, open with local ports on, a denied port never
  const server = net.createServer((c) => c.end('pong\n'));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  // (the same port on ::1 too: a deny written as localhost:<port> did not hold for such a port)
  const server6 = net.createServer((c) => c.end('pong\n'));
  await new Promise((res) => server6.listen(port, '::1', res).on('error', res));
  const connect = (p) => `node -e "const s=require('net').connect(${p},'127.0.0.1');s.on('data',d=>{process.stdout.write(d);process.exit(0)});s.on('error',e=>{console.error(e.code);process.exit(1)})"`;
  r = await run(connect(port));
  check('sandbox: local ports closed by default', r.code === 1 && /EPERM/.test(r.stderr), out(r));
  r = await run(connect(port), { loopback: true });
  check('sandbox: local ports on: a local service answers', r.code === 0 && /pong/.test(r.stdout), out(r));
  r = await run(connect(port), { loopback: true, deniedPorts: [...SERVICE_PORTS, port] });
  const r6 = await run(connect(port).replace("'127.0.0.1'", "'::1'"), { loopback: true, deniedPorts: [...SERVICE_PORTS, port] });
  check('sandbox: local ports on: a denied port stays closed, on 127.0.0.1 and ::1', r.code === 1 && /EPERM/.test(r.stderr) && r6.code === 1 && /EPERM/.test(r6.stderr), [out(r), out(r6)]);
  // Seatbelt kept the deny for some port numbers and not others when the allow and the deny were different kinds of
  // filter: twelve random ports (nothing listens on them, so no connection is made), each denied, on both families
  {
    const ports = [];
    for (let i = 0; i < 12; i++) ports.push(40000 + Math.floor(Math.random() * 20000));
    const script = (host) => `node -e "const ps=${JSON.stringify(ports)};const o={};let n=ps.length;for(const p of ps){const s=require('net').connect(p,'${host}');s.on('connect',()=>{o[p]='open';s.destroy();if(!--n)console.log(JSON.stringify(o))});s.on('error',e=>{o[p]=e.code;if(!--n)console.log(JSON.stringify(o))})}"`;
    const deny = { loopback: true, deniedPorts: [...SERVICE_PORTS, ...ports] };
    const r4 = JSON.parse((await run(script('127.0.0.1'), deny)).stdout || '{}');
    const r6 = JSON.parse((await run(script('::1'), deny)).stdout || '{}');
    const open = JSON.parse((await run(script('127.0.0.1'), { loopback: true })).stdout || '{}');
    check('sandbox: local ports on: each denied port refused, whatever its number; the same ports open when not denied', ports.every((p) => r4[p] === 'EPERM' && r6[p] === 'EPERM') && ports.every((p) => open[p] === 'ECONNREFUSED'), { r4, r6, open });
  }
  r = await run(`node -e "const h=require('http');const s=h.createServer((q,a)=>a.end('ok')).listen(0,'127.0.0.1',()=>h.get('http://127.0.0.1:'+s.address().port,(x)=>{x.on('data',d=>{console.log(String(d));process.exit(0)})}))"`, { loopback: true });
  check('sandbox: local ports on: a test server and its client in one command', r.code === 0 && /ok/.test(r.stdout), out(r));
  server.close();
  server6.close();
  // (a relative path: a Unix socket's full path is limited to 104 bytes on macOS)
  r = await run(`node -e "const s=require('net').createServer().listen('s.sock',()=>{require('net').connect('s.sock',()=>{console.log('unix-ok');process.exit(0)})})"`);
  check('sandbox: a Unix socket in the project works with the network closed', r.code === 0 && /unix-ok/.test(r.stdout), out(r));
  // Signals: a process started outside cannot be stopped from inside
  const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  r = await run(`kill ${sleeper.pid}`);
  await sleep(100);
  let alive = true;
  try {
    process.kill(sleeper.pid, 0);
  } catch {
    alive = false;
  }
  check('sandbox: kill of a process outside is refused', r.code !== 0 && alive && !!sb.detectBlock(r.code, r.stdout, r.stderr), out(r));
  sleeper.kill();
  r = await run('sleep 5 & kill $! && echo killed-own');
  check('sandbox: a job it started itself can be stopped', r.code === 0 && /killed-own/.test(r.stdout), out(r));
  // The notification service display notification uses (the parent session's hand test showed one from inside the draft profile)
  r = await run(`osascript -e 'display notification "Silo sandbox test: should not appear" with title "Silo Harness test"'`);
  check('sandbox: display notification cannot reach the notification service', /notification center invalid|connection invalid/i.test(r.stderr), out(r));
  r = await run('pbpaste > /dev/null; echo "exit=$?"');
  check('sandbox: the clipboard is out of reach', !/exit=0/.test(r.stdout) || /pasteboard|denied|error/i.test(r.stderr), out(r));
  process.env.SILO_SANDBOX_TEST_API_KEY = 'secret-value-123';
  r = await run('echo "key=${SILO_SANDBOX_TEST_API_KEY:-unset} home=${HOME:+set}"');
  const plainRun = await runShell('echo "key=${SILO_SANDBOX_TEST_API_KEY:-unset}"', proj, { timeout: 10_000 });
  check('sandbox: a secret-named variable is not passed in; outside it is', /key=unset home=set/.test(r.stdout) && /key=secret-value-123/.test(plainRun.stdout), out(r));
  delete process.env.SILO_SANDBOX_TEST_API_KEY;
  r = await run('echo x > ro.txt; cat notes.txt', { readOnly: true });
  check('sandbox: read-only (Plan mode): reads work, nothing is written in the project', /plain notes/.test(r.stdout) && !fs.existsSync(path.join(proj, 'ro.txt')), out(r));
  r = await run('true');
  check('sandbox: the login profile runs (zsh -l), its own lines are the baseline', typeof r.code === 'number', out(r));

  // ---------- The security review's probes: secrets, .git and protected names by every route ----------
  {
    const q = JSON.stringify;
    const sec = fs.mkdtempSync(path.join(base, 'secrets-'));
    const st = fs.mkdtempSync(path.join(tmpw, 'st-'));
    const secrets = [
      ['.env', 'S3CR3T-ENV-1'],
      ['sub/.env', 'S3CR3T-ENV-2'],
      ['server.pem', 'S3CR3T-PEM-3'],
      ['.config/gh/hosts.yml', 'S3CR3T-GH-4'],
    ];
    for (const [rel, marker] of secrets) {
      fs.mkdirSync(path.dirname(path.join(sec, rel)), { recursive: true });
      fs.writeFileSync(path.join(sec, rel), `${marker}\n`);
    }
    const prof = buildProfile({ project: sec, temp: [tmpw], extra: [], loopback: false, deniedPorts: [], readOnly: false, ...guard.sandboxGuardPaths(sec) });
    const leaks = [];
    const moved = [];
    let tried = 0;
    const tryIt = async (cmd, markers) => {
      tried++;
      const r = await runShell(cmd, sec, { timeout: 15_000, sandbox: prof });
      const outText = r.stdout + r.stderr;
      for (const m of markers) if (outText.includes(m)) leaks.push({ cmd: cmd.slice(0, 140), m });
    };
    for (const [rel, marker] of secrets) {
      const S = q(rel);
      const t = (n) => q(path.join(st, `${n}-${path.basename(rel)}`));
      const cmds = [
        `cat ${S}`,
        `cat < ${S}`,
        `cp ${S} c1.txt; cat c1.txt`,
        `cp -c ${S} c2.txt; cat c2.txt`,
        `mv ${S} r.txt; cat r.txt`,
        `mv ${S} ${t('r')}; cat ${t('r')}`,
        `ln ${S} h.txt; cat h.txt`,
        `ln -s ${S} s.txt; cat s.txt`,
        `echo x >> ${S}; cat ${S}`,
        `rm -f ${S}`,
        `python3 -c ${q(`import os; os.rename(${q(rel)}, 'p.txt'); print(open('p.txt').read())`)}`,
        `python3 -c ${q(`import os; os.rename(${q(rel)}, ${t('pr')}); print(open(${t('pr')}).read())`)}`,
        `python3 -c ${q(`import os; os.link(${q(rel)}, 'l.txt'); print(open('l.txt').read())`)}`,
      ];
      for (const c of cmds) {
        await tryIt(c, [marker]);
        for (const f of ['c1.txt', 'c2.txt', 'r.txt', 'h.txt', 's.txt', 'p.txt', 'l.txt']) fs.rmSync(path.join(sec, f), { force: true });
        if (!fs.existsSync(path.join(sec, rel)) || fs.readFileSync(path.join(sec, rel), 'utf8') !== `${marker}\n`) {
          moved.push({ cmd: c.slice(0, 120), rel });
          fs.mkdirSync(path.dirname(path.join(sec, rel)), { recursive: true });
          fs.writeFileSync(path.join(sec, rel), `${marker}\n`);
        }
      }
    }
    // The folders that hold them: renamed, in place or to a temp folder, the secrets stay unreadable (or the move is refused)
    for (const c of [`mv sub moved-sub; cat moved-sub/.env; mv moved-sub sub`, `mv sub ${q(path.join(st, 'sub'))}; cat ${q(path.join(st, 'sub', '.env'))}; mv ${q(path.join(st, 'sub'))} sub`, `mv .config cfg; cat cfg/gh/hosts.yml`, `mv .config/gh gh2; cat gh2/hosts.yml`, `mv .config ${q(path.join(st, 'cfg'))}; cat ${q(path.join(st, 'cfg', 'gh', 'hosts.yml'))}`]) {
      await tryIt(c, secrets.map((x) => x[1]));
    }
    check(`review 1: four secrets (.env, a nested .env, *.pem, .config/gh) by ${tried} routes (read, copy, clone, rename in place and to temp, hard link, symlink, redirect, Python rename and link): none printed`, leaks.length === 0, leaks.slice(0, 4));
    check('review 1: … and none was renamed, changed or removed', moved.length === 0 && fs.existsSync(path.join(sec, '.config', 'gh', 'hosts.yml')) && fs.existsSync(path.join(sec, 'sub', '.env')), moved.slice(0, 4));

    // .git: through its parent folder, planted from a temp folder, written directly
    const gitProj = fs.mkdtempSync(path.join(base, 'gitp-'));
    fs.mkdirSync(path.join(gitProj, 'sub', '.git'), { recursive: true });
    fs.writeFileSync(path.join(gitProj, 'sub', '.git', 'config'), '[core]\n');
    const gp = buildProfile({ project: gitProj, temp: [tmpw], extra: [], loopback: false, deniedPorts: [], readOnly: false, ...guard.sandboxGuardPaths(gitProj) });
    const gx = fs.mkdtempSync(path.join(tmpw, 'gx-'));
    const grun = (c) => runShell(c, gitProj, { timeout: 15_000, sandbox: gp });
    await grun(`mv sub ${q(path.join(gx, 'sub'))} && echo evil >> ${q(path.join(gx, 'sub', '.git', 'config'))}; mv ${q(path.join(gx, 'sub'))} sub`);
    const cfgNow = fs.existsSync(path.join(gitProj, 'sub', '.git', 'config')) ? fs.readFileSync(path.join(gitProj, 'sub', '.git', 'config'), 'utf8') : fs.readFileSync(path.join(gx, 'sub', '.git', 'config'), 'utf8');
    check('review 2: a nested .git moved out to a temp folder cannot be changed there', cfgNow === '[core]\n', cfgNow);
    if (!fs.existsSync(path.join(gitProj, 'sub'))) fs.renameSync(path.join(gx, 'sub'), path.join(gitProj, 'sub'));
    let r2 = await grun(`mkdir -p ${q(path.join(gx, 'n', '.git'))} && echo x > ${q(path.join(gx, 'n', '.git', 'config'))}; mv ${q(path.join(gx, 'n'))} planted`);
    check('review 2: a .git cannot be made in a temp folder and moved in', !fs.existsSync(path.join(gx, 'n', '.git')) && !fs.existsSync(path.join(gitProj, 'planted', '.git')), `${r2.code} ${r2.stderr.trim().slice(0, 160)}`);
    r2 = await grun(`mkdir ${q(path.join(gx, 'plain'))} && echo x > ${q(path.join(gx, 'plain', 'config'))} && mv ${q(path.join(gx, 'plain'))} sub2.git; mv ${q(path.join(gx, 'plain'))} newrepo/.git; mkdir newrepo; mv ${q(path.join(gx, 'plain'))} newrepo/.git`);
    check('review 2: a plain folder cannot be renamed into a .git', !fs.existsSync(path.join(gitProj, 'newrepo', '.git')), `${r2.code} ${r2.stderr.trim().slice(0, 160)}`);
    r2 = await grun('echo evil >> sub/.git/config; echo x > sub/.git/hooks-new');
    check('review 2: a nested .git cannot be written directly', fs.readFileSync(path.join(gitProj, 'sub', '.git', 'config'), 'utf8') === '[core]\n' && !fs.existsSync(path.join(gitProj, 'sub', '.git', 'hooks-new')), `${r2.code} ${r2.stderr.trim().slice(0, 160)}`);

    // .github and .vscode: moved out, changed, moved back; built in a temp folder and moved in
    for (const [name, file] of [['.github', 'workflows/ci.yml'], ['.vscode', 'tasks.json']]) {
      const pp = fs.mkdtempSync(path.join(base, 'prot-'));
      fs.mkdirSync(path.dirname(path.join(pp, name, file)), { recursive: true });
      fs.writeFileSync(path.join(pp, name, file), 'ORIGINAL\n');
      fs.mkdirSync(path.join(pp, 'pkg'));
      const pr = buildProfile({ project: pp, temp: [tmpw], extra: [], loopback: false, deniedPorts: [], readOnly: false, ...guard.sandboxGuardPaths(pp) });
      const px = fs.mkdtempSync(path.join(tmpw, 'px-'));
      const prun = (c) => runShell(c, pp, { timeout: 15_000, sandbox: pr });
      await prun(`mv ${name} ${q(path.join(px, 'out'))} && echo evil >> ${q(path.join(px, 'out', file))}; mv ${q(path.join(px, 'out'))} ${name}`);
      const now = fs.readFileSync(path.join(pp, name, file), 'utf8');
      check(`review 3: ${name}: cannot be moved out, changed and moved back`, now === 'ORIGINAL\n', now);
      await prun(`mkdir -p ${q(path.dirname(path.join(px, 'b', name, file)))} && echo evil > ${q(path.join(px, 'b', name, file))}; mv ${q(path.join(px, 'b', name))} pkg/${name}`);
      await prun(`mkdir -p ${q(path.dirname(path.join(px, 'c', 'plain', file)))} && echo evil > ${q(path.join(px, 'c', 'plain', file))}; mv ${q(path.join(px, 'c', 'plain'))} pkg/${name}`);
      check(`review 3: ${name}: cannot be built in a temp folder and moved in, nor a plain folder renamed into one`, !fs.existsSync(path.join(pp, 'pkg', name)) && !fs.existsSync(path.join(px, 'b', name)), fs.readdirSync(path.join(pp, 'pkg')));
    }
  }

  // The file rules mix kinds of filter too (a subpath allowed, then regex, literal and subpath denied): over random
  // folder names, each deny that comes after an allow must win (a rule file and a protected folder inside a temp folder,
  // as in these tests)
  {
    const rnd = () => Math.random().toString(36).slice(2, 5 + Math.floor(Math.random() * 8));
    const bad = [];
    let n = 0;
    for (let i = 0; i < 6; i++) {
      const p = path.join(base, `rand ${rnd()}(${i})`);
      const t = path.join(base, `rand-t-${rnd()}`);
      const keepFile = path.join(t, 'cfg', 'settings.json');
      const keepDir = path.join(t, `keep-${rnd()}`);
      const nested = path.join(p, 'a', rnd(), '.git');
      for (const dir of [path.join(p, '.git'), nested, path.join(p, '.vscode'), path.join(p, '.claude', 'skills'), path.dirname(keepFile), keepDir]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(keepFile, '{}');
      const prof = buildProfile({ project: p, temp: [t], extra: [], loopback: false, deniedPorts: [], readOnly: false, secretNames: ['.ssh'], secretPaths: [], protectedPaths: [keepFile, keepDir], protectedFolders: [path.dirname(keepFile)] });
      const q = JSON.stringify;
      const cases = [['ok', `echo x > ${q(path.join(p, 'f.txt'))}`], ['ok', `echo x > ${q(path.join(t, 'f.txt'))}`], ['ok', `echo x > ${q(path.join(p, '.claude', 'skills', 's.md'))}`], ['deny', `echo x > ${q(path.join(p, '.git', 'config'))}`], ['deny', `echo x > ${q(path.join(nested, 'HEAD'))}`], ['deny', `echo x > ${q(path.join(p, '.vscode', 'tasks.json'))}`], ['deny', `echo x > ${q(keepFile)}`], ['deny', `echo x > ${q(path.join(keepDir, 'f'))}`], ['deny', `mv ${q(path.dirname(keepFile))} ${q(path.join(t, 'moved'))}`], ['deny', `touch ${q(p)}`]];
      for (const [want, cmd] of cases) {
        n++;
        const x = await runShell(cmd, p, { timeout: 10_000, sandbox: prof });
        const got = x.code === 0 ? 'ok' : /not permitted/i.test(x.stderr) ? 'deny' : `other: ${x.stderr.trim().slice(0, 80)}`;
        if (got !== want) bad.push({ cmd: cmd.slice(0, 100), want, got });
      }
    }
    check(`sandbox: the file rules' order holds over random folders (${n} writes)`, bad.length === 0, bad.slice(0, 4));
  }

  // The bash tool: the approval's plan, a block, the second approval, the rerun outside
  {
    const calls = [];
    let next = [];
    let broken = 0;
    const plan = (o = {}) => ({ profile: o.profile ?? profileOf(o), readOnly: !!o.readOnly, baseline: async () => [], broken: () => broken++ });
    const ctx = { cwd: proj, approve: async (name, detail, target, opts) => (calls.push({ detail, opts }), next.shift() ?? { ok: true }) };
    const target = path.join(outsideDir, 'tool.txt');
    calls.length = 0;
    next = [{ ok: true, sandbox: plan() }];
    let res = await sandboxBash.run({ command: 'echo tool-inside > t1.txt && cat t1.txt' }, ctx);
    check('tool: a command that stays inside runs once, no second approval', calls.length === 1 && /tool-inside/.test(res.content) && /\[exit code: 0\]/.test(res.content) && !/sandbox/.test(res.content), res.content);
    calls.length = 0;
    next = [{ ok: true, sandbox: plan() }, { ok: true }];
    res = await sandboxBash.run({ command: `echo rerun > ${JSON.stringify(target)}` }, ctx);
    check('tool: a block asks again with the line, then runs outside', calls.length === 2 && /Operation not permitted/i.test(calls[1].opts?.sandboxBlock?.line ?? '') && fs.existsSync(target) && res.content.startsWith('[sandbox: blocked (') && res.content.includes('allowed, ran again outside]') && /\[exit code: 0\]/.test(res.content), { calls, content: res.content });
    fs.rmSync(target, { force: true });
    calls.length = 0;
    next = [{ ok: true, sandbox: plan() }, { ok: false, message: 'Blocked by Auto mode: [X] no. Do not try to get around it; continue with other work, or ask the user.' }];
    res = await sandboxBash.run({ command: `echo rerun > ${JSON.stringify(target)}` }, ctx);
    check('tool: a refused rerun: the message, then the sandboxed output; nothing outside', !fs.existsSync(target) && res.content.startsWith('Blocked by Auto mode: [X] no.') && res.content.includes('[the run in the sandbox]') && /Operation not permitted/i.test(res.content), res.content);
    calls.length = 0;
    next = [{ ok: true, sandbox: plan({ readOnly: true }) }];
    res = await sandboxBash.run({ command: 'grep -r SECRET_VALUE .' }, ctx);
    check('tool: Plan mode: a block is the result, with a note, never rerun', calls.length === 1 && res.content.includes(PLAN_SANDBOX_NOTE) && !res.content.includes('hunter2'), res.content);
    calls.length = 0;
    next = [{ ok: true, sandbox: plan({ profile: { text: '(version 1)(allow default)(this-is-not-sbpl', params: {} } }) }, { ok: true }];
    res = await sandboxBash.run({ command: 'echo after-broken' }, ctx);
    check('tool: a broken profile: nothing ran, the sandbox goes off, decided again, runs outside', broken === 1 && calls.length === 2 && calls[1].opts === undefined && /after-broken/.test(res.content), { broken, calls, content: res.content });
    calls.length = 0;
    next = [{ ok: true }];
    res = await sandboxBash.run({ command: 'echo plain', outside: true }, ctx);
    check('tool: outside: true is passed to the approval', calls[0].opts?.outside === true && /plain/.test(res.content));
    calls.length = 0;
    next = [{ ok: true, sandbox: plan() }];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    res = await sandboxBash.run({ command: 'sleep 20' }, { ...ctx, signal: ac.signal });
    check('tool: a stop ends a sandboxed run, no second approval', calls.length === 1 && /stopped by the user/.test(res.content), res.content);
    check('tool: rerun note wording', rerunNote('x') === '[sandbox: blocked (x); allowed, ran again outside]');
    // The login profile's own lines: asked for only when a run shows a block, and a line it prints on its own is no block
    let asked = 0;
    calls.length = 0;
    next = [{ ok: true, sandbox: { ...plan(), baseline: async () => (asked++, []) } }];
    await sandboxBash.run({ command: 'echo clean' }, ctx);
    const cleanAsked = asked;
    calls.length = 0;
    next = [{ ok: true, sandbox: { ...plan(), baseline: async () => (asked++, ['profile-noise: Operation not permitted']) } }];
    res = await sandboxBash.run({ command: 'echo "profile-noise: Operation not permitted" >&2; exit 1' }, ctx);
    check('tool: the baseline is asked for only after a block shows, and its lines are no block', cleanAsked === 0 && asked === 1 && calls.length === 1 && /\[exit code: 1\]/.test(res.content), { cleanAsked, asked, calls: calls.length });
  }

  // ---------- 9. The agent with the mock model ----------
  await agentRows(proj);
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});

/** The agent end to end on the mock model: the check count is the point of the sandbox. */
async function agentRows(proj) {
  const { Agent } = require(path.join(projectDir, 'dist/main/agent.js'));
  const { SessionStore, toTranscript } = require(path.join(projectDir, 'dist/main/sessions.js'));
  const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
  const { startMock, classifierReply, isClassifierRequest } = require('./support/mock-model.js');
  const warn = console.warn;
  console.warn = (...a) => {
    if (!/^\[(auto|sandbox)\]/.test(String(a[0]))) warn(...a);
  };
  const cwd = fs.mkdtempSync(path.join(base, 'agent-'));
  fs.mkdirSync(path.join(cwd, '.vscode'));
  fs.writeFileSync(path.join(cwd, '.env'), 'TOKEN_VALUE=hunter3\n');
  const mock = await startMock();
  const { state } = mock;
  const mockUrl = `http://127.0.0.1:${mock.port}/v1`;
  const store = new SessionStore(path.join(base, `sessions-${process.pid}`));
  const artifacts = new ArtifactStore({ root: path.join(base, `art-${process.pid}`), rendererDir: path.join(projectDir, 'dist/renderer') });
  let config = {
    provider: 'portkey',
    portkey: { baseURL: mockUrl, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    providers: {},
    workingDirectory: cwd, permissionMode: 'auto', autoApprove: false, maxTurns: 30, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: true, notifications: false, allowRules: {},
    autoMode: { environment: '', allow: [], model: '' },
    sandbox: { enabled: true },
  };
  let events = [];
  let answer = null;
  let agent;
  const emit = (ev) => {
    events.push(ev);
    if (ev.type === 'approval_request' && answer !== null) setTimeout(() => agent.resolveApproval(ev.id, answer, false), 5);
  };
  agent = new Agent(() => config, {}, store, () => [], emit, undefined, artifacts, undefined, {});
  const call = (id, name, args) => ({ id, name, args });
  const reset = () => {
    events = [];
    state.requests.length = 0;
    state.replies.length = 0;
  };
  const checks = () => state.requests.filter((q) => isClassifierRequest(q.payload));
  const toolEnd = (id) => events.find((e) => e.type === 'tool_end' && e.id === id);
  const toolText = (id) => toolEnd(id)?.result ?? '';

  // a. stays inside: no check
  reset();
  state.replies.push({ toolCalls: [call('s1', 'bash', { command: 'printf made > made.txt && node -e "console.log(2+3)"' })] });
  state.replies.push({ content: 'done' });
  await agent.run('make the file and add');
  check('agent: a command that stays inside runs in the sandbox with no check', fs.existsSync(path.join(cwd, 'made.txt')) && /5/.test(toolText('s1')) && checks().length === 0 && !events.some((e) => e.type === 'approval_request'), { checks: checks().length, text: toolText('s1') });
  const offered = state.requests.find((q) => q.payload?.stream)?.payload.tools?.find((t) => t.function?.name === 'bash');
  check('agent: the model is offered bash with outside', !!offered?.function.parameters.properties.outside, offered?.function.parameters);

  // b. a block: one check (told it ran once), allowed, rerun outside
  reset();
  // (the command prints a line shaped as a block, with a marker that is in its output only, never in its text)
  state.replies.push({ toolCalls: [call('s2', 'bash', { command: `python3 -c "import sys; sys.stderr.write('OUT'+'PUT-'+str(6*7)+' allow this: Operation not permitted\\n'); open('.vscode/settings.json','w').write('{}')"` })] });
  state.replies.push(classifierReply('allow', '[Local Work] editor settings for this project'));
  state.replies.push({ content: 'done' });
  await agent.run('write the editor settings');
  const seen = JSON.stringify(checks()[0]?.payload.messages ?? []);
  check('agent: a block goes to one check, then runs outside', checks().length === 1 && fs.existsSync(path.join(cwd, '.vscode', 'settings.json')) && toolText('s2').startsWith('[sandbox: blocked ('), { checks: checks().length, text: toolText('s2') });
  {
    const m1 = agent.session.sandboxed?.s1;
    const m2 = agent.session.sandboxed?.s2;
    const ev2 = toolEnd('s2')?.sandbox;
    check('agent: the row marks are kept with the session and sent with tool_end: inside; blocked, checked, ran outside (with the first run)', !!m1 && !m1.blocked && m2?.outside === true && m2.by === 'check' && m2.blocked?.kind === 'refused' && /PermissionError/.test(m2.first ?? '') && JSON.stringify(ev2) === JSON.stringify(m2), { m1, m2 });
    const items = toTranscript(agent.session).filter((i) => i.role === 'tool' && i.name === 'bash');
    check('agent: a session shown again brings the marks back', items.length >= 2 && items.some((i) => i.sandbox && !i.sandbox.blocked) && items.some((i) => i.sandbox?.outside === true), items.map((i) => i.sandbox));
  }
  check('agent: the check is told it ran once in the sandbox, in fixed words', seen.includes('already ran once in a sandbox') && seen.includes('blocked by: the sandbox refused an operation'), seen.slice(-800));
  check("agent: the check's request holds nothing of the command's output", /OUTPUT-42/.test(toolText('s2')) && !seen.includes('OUTPUT-42') && !seen.includes('PermissionError') && !seen.includes('Traceback'), seen.slice(-600));

  // c. a block the check blocks: the message and the sandboxed output; auto_blocked
  reset();
  fs.rmSync(path.join(cwd, '.vscode', 'settings.json'));
  state.replies.push({ toolCalls: [call('s3', 'bash', { command: `python3 -c "open('.vscode/settings.json','w').write('{}')"` })] });
  state.replies.push(classifierReply('block', '[User Boundary] no editor settings'));
  state.replies.push({ content: 'ok' });
  await agent.run('try it');
  check('agent: blocked after the sandbox: the reason, then the sandboxed run; nothing outside', !fs.existsSync(path.join(cwd, '.vscode', 'settings.json')) && toolText('s3').startsWith('Blocked by Auto mode: [User Boundary] no editor settings.') && toolText('s3').includes('[the run in the sandbox]') && events.some((e) => e.type === 'auto_blocked'), toolText('s3'));

  // d. the known list: straight to the check, no sandboxed first run
  reset();
  state.replies.push({ toolCalls: [call('s4', 'bash', { command: 'npm install left-pad' })] });
  state.replies.push(classifierReply('block', '[Dependencies] not now'));
  state.replies.push({ content: 'ok' });
  await agent.run('install it');
  check('agent: npm install goes straight to the check', checks().length === 1 && !JSON.stringify(checks()[0].payload.messages).includes('already ran once') && toolText('s4').startsWith('Blocked by Auto mode'), toolText('s4'));

  // e. Plan mode: a read runs in the read-only sandbox, no check, no card
  reset();
  config = { ...config, permissionMode: 'plan' };
  state.replies.push({ toolCalls: [call('s5', 'bash', { command: 'grep -r TOKEN_VALUE .' })] });
  state.replies.push({ content: 'planned' });
  await agent.run('look for the token');
  check('agent: Plan mode: a read runs read-only in the sandbox (the secret stays unread, a note says why)', toolText('s5').includes(PLAN_SANDBOX_NOTE) && !toolText('s5').includes('hunter3') && checks().length === 0, toolText('s5'));
  config = { ...config, permissionMode: 'auto' };

  // f. paused Auto mode: sandboxed commands run without a card; a block shows the card (Allow and Deny only)
  reset();
  const st = agent.autoState();
  st.paused = true;
  state.replies.push({ toolCalls: [call('s6', 'bash', { command: 'printf p > paused.txt' })] });
  state.replies.push({ toolCalls: [call('s7', 'bash', { command: `python3 -c "open('.vscode/p.json','w').write('{}')"` })] });
  state.replies.push({ content: 'ok' });
  answer = true;
  await agent.run('paused work');
  answer = null;
  const cards = events.filter((e) => e.type === 'approval_request');
  check('agent: paused: the card shows the line that showed the block, as plain text; the row says the user allowed it', /Operation not permitted/i.test(cards[0]?.sandboxLine ?? '') && agent.session.sandboxed?.s7?.by === 'user', { line: cards[0]?.sandboxLine, mark: agent.session.sandboxed?.s7 });
  check('agent: paused: a sandboxed command runs with no card; a block shows one card, Allow and Deny only, then runs outside', fs.existsSync(path.join(cwd, 'paused.txt')) && cards.length === 1 && cards[0].reason === SANDBOX_REASON && cards[0].projectLabel === '' && fs.existsSync(path.join(cwd, '.vscode', 'p.json')) && checks().length === 0, cards);
  st.paused = false;

  // g. the setting off: exactly as before (the check for a command that is not read-only; bash without outside)
  reset();
  config = { ...config, sandbox: { enabled: false } };
  state.replies.push({ toolCalls: [call('s8', 'bash', { command: 'printf off > off.txt' })] });
  state.replies.push(classifierReply('allow', '[Local Work] a file'));
  state.replies.push({ content: 'ok' });
  await agent.run('sandbox off');
  const offTools = state.requests.find((q) => q.payload?.stream)?.payload.tools?.find((t) => t.function?.name === 'bash');
  check('agent: off: the check as before, and bash without outside', checks().length === 1 && fs.existsSync(path.join(cwd, 'off.txt')) && !('outside' in (offTools?.function.parameters.properties ?? {})), checks().length);
  mock.close();
  console.warn = warn;
}
