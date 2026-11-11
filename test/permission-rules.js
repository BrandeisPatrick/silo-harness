// Permission rules in Claude Code's format (agent/rules.ts, agent/permissions.ts): the grammar and bad strings,
// Bash prefix and wildcard matching, compound commands and substitutions, paths and symlinks (allow needs both, deny
// either), deny > ask > allow, every permission mode, what an allow rule never loosens (protected paths, sudo, browser
// and custom cards, Plan mode), how strong a rule is (whole program, a named command, anchored and exact paths),
// Auto mode's exceptions, the shape before 0.16, settings.json (yours only), the rule files as protected writes, and
// in the agent loop: a deny rule in Bypass, an ask rule's card in Bypass, and a hook's allow beating neither.
// Run: node test/permission-rules.js <projectDir>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./support/check.js');
const { startMock } = require('./support/mock-model.js');

const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-rules-config-'));
process.env.SILO_HARNESS_CONFIG_DIR = CONFIG;

const R = dist('agent/rules.js');
const { decideApproval } = dist('agent/permissions.js');
const { guardCommand, setAppDataDir } = dist('guard.js');
const { readStoredConfig } = dist('config.js');
const { SettingsLayer, contentHash, trustKey, checkSetting } = dist('settings.js');
const { HookEngine } = dist('hooks/engine.js');
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const { ArtifactStore } = dist('artifacts.js');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const home = os.homedir();
const parse = (t, list = 'allow') => R.parseRule(t, list);
const ok = (t, list) => 'rule' in parse(t, list);
const err = (t, list) => parse(t, list).error;

(async () => {
  const cwd = tmp('oa-rules-cwd-');
  fs.mkdirSync(path.join(cwd, 'src'));
  const outside = tmp('oa-rules-out-');

  // ---------- 1. The grammar ----------
  for (const t of ['Bash', 'Bash(*)', 'Bash(npm run test:*)', 'Bash(git * main)', 'Bash(npm test)', 'Read', 'Read(~/notes/**)', 'Edit', 'Edit(//tmp/x.txt)', 'Edit(src/**)', 'Edit(/src/**/*.ts)', 'Write', 'Write(./a.txt)', 'mcp__github', 'mcp__github__*', 'mcp__github__get_issue'])
    check(`grammar: ${t} parses as an allow rule`, ok(t, 'allow'), err(t, 'allow'));
  for (const t of ['WebFetch', 'WebFetch(domain:example.com)', 'WebFetch(domain:*.example.com)', 'WebSearch', 'session_spawn', 'browser_navigate'])
    check(`grammar: ${t} parses as ask and deny`, ok(t, 'ask') && ok(t, 'deny'), err(t, 'deny'));
  for (const t of ['WebFetch(domain:example.com)', 'WebSearch', 'session_spawn'])
    check(`grammar: ${t} is refused as an allow rule, with the reason`, !ok(t, 'allow') && /ask|deny/.test(err(t, 'allow')), err(t, 'allow'));
  const bad = ['', '   ', 'bash(ls)', 'Bash()', 'Bash(:*)', 'Bash(ls', 'Foo(bar)', 'Read(!secret)', 'Read(../x)', 'Edit(~bob/x)', 'Edit(src/[ab)', 'WebFetch(example.com)', 'WebSearch(x)', 'mcp__s(x)', 'mcp__*', 'mcp__s__get_*', 'session_spawn(x)', 42];
  for (const t of bad) check(`grammar: ${JSON.stringify(t)} is refused with a reason`, typeof err(t, 'deny') === 'string' && err(t, 'deny').length > 0, parse(t, 'deny'));
  // A bad rule never becomes a broader rule: in a set, it is ignored and listed
  const withBad = R.compileRules({ allow: ['Bash(ls', 'Bash(git:*)'], deny: ['Bash()'] });
  check('a bad rule is ignored and listed as invalid', withBad.allow.length === 1 && withBad.deny.length === 0 && withBad.invalid.length === 2 && withBad.invalid.every((i) => i.error), withBad.invalid);
  check('… and does not cover anything', !R.bashAllow('ls -la', withBad, () => false).covered);

  // ---------- 2. Bash matching ----------
  const rs = (allow = [], ask = [], deny = [], extra = {}) => R.compileRules({ allow, ask, deny, ...extra });
  const covers = (rule, cmd) => R.bashAllow(cmd, rs([rule]), () => false).covered;
  check('prefix: Bash(npm run test:*) covers npm run test and npm run test --watch', covers('Bash(npm run test:*)', 'npm run test') && covers('Bash(npm run test:*)', 'npm run test --watch'));
  check('prefix: … not npm run test:unit nor npm install', !covers('Bash(npm run test:*)', 'npm run test:unit') && !covers('Bash(npm run test:*)', 'npm install'));
  check('prefix: Bash(ls *) covers ls and ls -la, not lsof', covers('Bash(ls *)', 'ls') && covers('Bash(ls *)', 'ls -la') && !covers('Bash(ls *)', 'lsof'));
  check('prefix: Bash(ls:*) is the same as Bash(ls *)', covers('Bash(ls:*)', 'ls') && !covers('Bash(ls:*)', 'lsof'));
  check('wildcard: Bash(ls*) covers lsof', covers('Bash(ls*)', 'lsof'));
  check('wildcard: Bash(git * main) covers git merge main, not git log', covers('Bash(git * main)', 'git merge main') && !covers('Bash(git * main)', 'git log'));
  check('wildcard: Bash(* --version) covers node --version, not node -v', covers('Bash(* --version)', 'node --version') && !covers('Bash(* --version)', 'node -v'));
  check('wildcard: Bash(* --help *) does not cover npm --help', covers('Bash(* --help *)', 'npm --help x') && !covers('Bash(* --help *)', 'npm --help'));
  check('exact: Bash(npm run build) covers only that command', covers('Bash(npm run build)', 'npm run build') && covers('Bash(npm run build)', 'npm  run  build') && !covers('Bash(npm run build)', 'npm run build --watch'));
  check('exact: quotes are read as the shell reads them', covers('Bash(git commit -m "fix it")', "git commit -m 'fix it'"));
  check('Bash and Bash(*) cover every command', covers('Bash', 'make all') && covers('Bash(*)', 'make all'));
  check('a whole-program rule covers the program by its name (/usr/bin/git)', covers('Bash(git:*)', '/usr/bin/git status'));
  check('only a whole-program rule matches past VAR=value', covers('Bash(npm:*)', 'NODE_ENV=test npm test') && !covers('Bash(npm test)', 'NODE_ENV=test npm test') && !covers('Bash(npm run *)', 'X=1 npm run a'));

  // ---------- 3. Compound commands and substitution ----------
  check('compound: allow needs every part', !covers('Bash(git:*)', 'git status && npm test') && R.bashAllow('git status && npm test', rs(['Bash(git:*)', 'Bash(npm test)']), () => false).covered);
  check('compound: ; || | and newlines split too', !covers('Bash(git:*)', 'git status; rm -rf x') && !covers('Bash(git:*)', 'git status || rm x') && !covers('Bash(git:*)', 'git log | sh') && !covers('Bash(git:*)', 'git status\nrm x'));
  check('compound: what sh -c runs must be covered too', !covers('Bash(sh:*)', "sh -c 'rm -rf build'") && R.bashAllow("sh -c 'rm -rf build'", rs(['Bash(sh:*)', 'Bash(rm:*)']), () => false).covered);
  check('substitution: $(…) is never covered by an allow rule', !R.bashAllow('git log $(git rev-parse HEAD)', rs(['Bash(git:*)']), () => false).covered);
  check('substitution: backticks, <(…), eval, an expanding here-document and a trailing && neither', ['echo `ls`', 'diff <(ls) b', 'eval ls', 'cat <<EOF\n$(id)\nEOF', 'npm test &&'].every((c) => !R.bashAllow(c, rs(['Bash']), () => false).covered));
  check('substitution: … but a program allowed for the session still is, as before', R.bashAllow('git log $(git rev-parse HEAD)', rs(), (p) => p === 'git').covered);
  const v = (rules, name, args) => R.ruleVerdict(rules, name, args, cwd);
  check('deny: applies when any part matches', v(rs([], [], ['Bash(rm:*)']), 'bash', { command: 'git status && rm -rf build' })?.list === 'deny');
  check('deny: tried against a substituted command', v(rs([], [], ['Bash(rm:*)']), 'bash', { command: 'echo $(rm -rf build)' })?.list === 'deny' && v(rs([], [], ['Bash(rm:*)']), 'bash', { command: 'echo `rm x`' })?.list === 'deny');
  check('deny: past VAR=value and a path to the program', v(rs([], [], ['Bash(rm:*)']), 'bash', { command: 'FOO=1 /bin/rm -rf build' })?.list === 'deny');
  check('ask: applies when any part matches (terminal_run too)', v(rs([], ['Bash(git push:*)']), 'terminal_run', { command: 'cd x && git push origin main' })?.list === 'ask');
  check('deny and ask: a command that matches nothing is left alone', v(rs([], ['Bash(git push:*)'], ['Bash(rm:*)']), 'bash', { command: 'git status' }) === null);

  // ---------- 4. Paths and symlinks ----------
  const target = path.join(outside, 'secret.txt');
  fs.writeFileSync(target, 'x');
  fs.symlinkSync(outside, path.join(cwd, 'link'));
  const viaLink = path.join(cwd, 'link', 'secret.txt');
  const pa = (rules, tool, p) => R.pathAllow(tool, p, cwd, rules);
  check('path: Edit(src/**) covers src/a.ts, not lib/a.ts', pa(rs(['Edit(src/**)']), 'Edit', path.join(cwd, 'src/a.ts')).any && !pa(rs(['Edit(src/**)']), 'Edit', path.join(cwd, 'lib/a.ts')).any);
  check('path: a bare name matches at any depth (gitignore)', pa(rs(['Edit(*.md)']), 'Edit', path.join(cwd, 'docs/x/readme.md')).any);
  check('path: /src/** is under the working directory, //tmp is absolute, ~/ the home folder', pa(rs(['Edit(/src/**)']), 'Edit', path.join(cwd, 'src/a')).any && pa(rs([`Edit(//${outside.slice(1)}/**)`]), 'Edit', target).any && pa(rs(['Read(~/notes/**)']), 'Read', path.join(home, 'notes/a.txt')).any);
  check('path: ~ in the target is resolved', pa(rs(['Read(~/notes/a.txt)']), 'Read', '~/notes/a.txt').exact);
  check('symlink: an allow rule needs both the link and its target to match', !pa(rs(['Edit(link/**)']), 'Edit', viaLink).any && !pa(rs([`Edit(//${outside.slice(1)}/**)`]), 'Edit', viaLink).any);
  check('symlink: … and covers it when both do', pa(rs(['Edit(link/**)', `Edit(//${outside.slice(1)}/**)`]), 'Edit', viaLink).any);
  check('symlink: a deny rule applies when either matches', v(rs([], [], [`Edit(//${outside.slice(1)}/**)`]), 'write_file', { path: 'link/secret.txt' })?.list === 'deny' && v(rs([], [], ['Edit(link/**)']), 'write_file', { path: viaLink })?.list === 'deny');
  check('symlink: an ask rule too', v(rs([], [`Read(//${outside.slice(1)}/**)`]), 'read_file', { path: 'link/secret.txt' })?.list === 'ask');
  check('a Read deny rule also refuses writing the path', v(rs([], [], ['Read(.env)']), 'write_file', { path: '.env' })?.list === 'deny' && v(rs([], ['Read(.env)']), 'write_file', { path: '.env' }) === null);
  check('ask/deny: secrets/** matches a nested secrets folder; as allow it does not', v(rs([], [], ['Read(secrets/**)']), 'read_file', { path: 'a/secrets/k' })?.list === 'deny' && !pa(rs(['Read(secrets/**)']), 'Read', path.join(cwd, 'a/secrets/k')).any);
  check('grep and glob are matched by their folder', v(rs([], [], ['Read(src/**)']), 'grep', { pattern: 'x', path: 'src' })?.list === 'deny');

  // ---------- 5. Web, MCP, tool names ----------
  check('WebFetch(domain:example.com) matches example.com only', v(rs([], [], ['WebFetch(domain:example.com)']), 'web_fetch', { url: 'https://example.com/a' })?.list === 'deny' && v(rs([], [], ['WebFetch(domain:example.com)']), 'web_fetch', { url: 'https://api.example.com/' }) === null);
  check('WebFetch(domain:*.example.com) matches subdomains, not the apex', v(rs([], ['WebFetch(domain:*.example.com)']), 'web_fetch', { url: 'https://a.b.example.com/' })?.list === 'ask' && v(rs([], ['WebFetch(domain:*.example.com)']), 'web_fetch', { url: 'https://example.com/' }) === null);
  check('WebSearch matches web_search', v(rs([], [], ['WebSearch']), 'web_search', { query: 'x' })?.list === 'deny');
  check('mcp__srv matches its tools, mcp__srv__t one tool', v(rs([], [], ['mcp__srv']), 'mcp__srv__t', {})?.list === 'deny' && v(rs([], [], ['mcp__srv__t']), 'mcp__srv__u', {}) === null && v(rs([], [], ['mcp__srv__*']), 'mcp__srv__u', {})?.list === 'deny');
  check('a tool name (ask, deny) matches that tool', v(rs([], ['session_spawn']), 'session_spawn', {})?.list === 'ask' && v(rs([], ['session_spawn']), 'session_send', {}) === null);

  // ---------- 6. Precedence ----------
  check('precedence: deny beats ask, whatever the order or how specific', v(rs([], ['Bash(git push origin main)'], ['Bash(git:*)']), 'bash', { command: 'git push origin main' })?.list === 'deny');
  check('precedence: ask beats allow', v(rs(['Bash(git push origin main)'], ['Bash(git:*)']), 'bash', { command: 'git push origin main' })?.list === 'ask');

  // ---------- 7. decideApproval: modes, hard rules, strength ----------
  const ctx = (over = {}) => ({ mode: 'ask', cwd, rules: undefined, mcp: () => undefined, allowed: { mcp: () => false, reason: () => false, program: () => false, custom: () => false }, ...over });
  const d = (name, detail, target, c, opts = {}) => decideApproval(name, detail, target, opts, ctx(c));
  const allowR = (...allow) => ({ allow });
  check('ask mode: Bash(npm:*) runs npm test, not make', d('bash', 'npm test', undefined, { rules: allowR('Bash(npm:*)') }).kind === 'allow' && d('bash', 'make', undefined, { rules: allowR('Bash(npm:*)') }).kind === 'ask');
  check('acceptEdits: an Edit rule is not needed inside the folder; Bash rules still apply', d('write_file', 'x', path.join(cwd, 'a'), { mode: 'acceptEdits' }).kind === 'allow' && d('bash', 'npm test', undefined, { mode: 'acceptEdits', rules: allowR('Bash(npm test)') }).kind === 'allow');
  check('Plan mode: an allow rule does not let an edit or a command run', d('write_file', 'x', path.join(cwd, 'a'), { mode: 'plan', rules: allowR('Edit') }).kind === 'refuse' && d('bash', 'npm test', undefined, { mode: 'plan', rules: allowR('Bash') }).kind === 'refuse');
  check('Bypass: runs what no rule names', d('bash', 'make', undefined, { mode: 'bypass' }).kind === 'allow');
  // Section 5: an allow rule never loosens a hard rule
  const gitCfg = path.join(cwd, '.git', 'config');
  const prot = d('edit_file', gitCfg, gitCfg, { rules: allowR('Edit', 'Edit(.git/**)', 'Edit(//**)') });
  check('hard: a protected path asks every time, with Allow and Deny only', prot.kind === 'ask' && prot.custom === true && prot.reason === 'modifies the .git directory', prot);
  check('hard: a command that writes a protected path asks too', d('bash', 'echo x > .git/config', undefined, { rules: allowR('Bash', 'Bash(echo x)') }).kind === 'ask');
  const sudo = d('bash', 'sudo apt update', undefined, { rules: allowR('Bash(sudo apt update:*)', 'Bash(sudo apt update)') });
  check('hard: sudo asks with a rule that names the command', sudo.kind === 'ask' && sudo.reason === 'uses sudo', sudo);
  check('hard: deleting a critical folder asks', d('bash', 'rm -rf ~', undefined, { rules: allowR('Bash(rm -rf ~)') }).kind === 'ask');
  const site = { origin: 'https://example.com', label: 'example.com' };
  check('hard: a browser card asks whatever the rules say', d('browser_navigate', 'https://example.com', undefined, { rules: allowR('Bash') }, { browser: { site, card: 'site' } }).kind === 'ask');
  check('hard: a custom card (a tool\'s own question) is not covered by an allow rule', d('session_spawn', 'x', undefined, { rules: allowR('Bash', 'Edit') }, { custom: true }).kind === 'ask');
  // Section 6: how strong an allow rule is
  check('strength: Bash(git:*) does not cover a force push', d('bash', 'git push --force origin main', undefined, { rules: allowR('Bash(git:*)') }).kind === 'ask');
  check('strength: … nor does Bash(git *) or bare Bash', d('bash', 'git push --force origin main', undefined, { rules: allowR('Bash(git *)') }).kind === 'ask' && d('bash', 'git push origin main', undefined, { rules: allowR('Bash') }).kind === 'ask');
  check('strength: Bash(git push --force-with-lease:*) covers its force push', d('bash', 'git push --force-with-lease origin feat', undefined, { rules: allowR('Bash(git push --force-with-lease:*)') }).kind === 'allow');
  check('strength: Bash(gcloud compute instances list:*) covers that cloud command', guardCommand('gcloud compute instances list', cwd) === 'cloud or infrastructure change' && d('bash', 'gcloud compute instances list --format=json', undefined, { rules: allowR('Bash(gcloud compute instances list:*)') }).kind === 'allow');
  check('strength: … not another gcloud command, nor one joined to it', d('bash', 'gcloud compute instances delete x', undefined, { rules: allowR('Bash(gcloud compute instances list:*)') }).kind === 'ask' && d('bash', 'gcloud compute instances list && gcloud projects delete p', undefined, { rules: allowR('Bash(gcloud compute instances list:*)', 'Bash(gcloud:*)') }).kind === 'ask');
  check('strength: … nor a redirection into a file outside the folder', d('bash', `gcloud compute instances list > ${home}/Desktop/x.json`, undefined, { rules: allowR('Bash(gcloud compute instances list:*)') }).kind === 'ask');
  check('strength: a named command never covers reading secrets by pattern, only exactly', d('bash', 'cat ~/.aws/credentials', undefined, { rules: allowR('Bash(cat ~/.aws/*)', 'Bash(cat ~/.aws:*)') }).kind === 'ask' && d('bash', 'cat ~/.aws/credentials', undefined, { rules: allowR('Bash(cat ~/.aws/credentials)') }).kind === 'allow');
  check('strength: a home-folder scan is never covered by a pattern rule', d('bash', 'find ~ -name x', undefined, { rules: allowR('Bash(find ~ -name x)', 'Bash(find ~:*)') }).kind === 'ask');
  const deskFile = path.join(home, 'Desktop', 'oa-rules-x.txt');
  check('strength: bare Edit covers edits inside the folder, not outside', d('write_file', 'x', path.join(cwd, 'a'), { rules: allowR('Edit') }).kind === 'allow' && d('write_file', 'x', deskFile, { rules: allowR('Edit') }).kind === 'ask');
  check('strength: an anchored path rule covers writes outside the folder', d('write_file', 'x', deskFile, { rules: allowR('Edit(~/Desktop/**)') }).kind === 'allow' && d('write_file', 'x', target, { rules: allowR(`Write(//${outside.slice(1)}/**)`) }).kind === 'allow');
  check('strength: … one that starts with a wildcard does not', d('write_file', 'x', deskFile, { rules: allowR('Edit(//**)') }).kind === 'ask' && d('write_file', 'x', deskFile, { rules: allowR('Edit(**/Desktop/**)') }).kind === 'ask');
  check('strength: a secret path is covered only by a Read rule with no wildcard', d('read_file', '~/.aws/credentials', path.join(home, '.aws/credentials'), { rules: allowR('Read(~/.aws/**)') }).kind === 'ask' && d('read_file', '~/.aws/credentials', path.join(home, '.aws/credentials'), { rules: allowR('Read(~/.aws/credentials)') }).kind === 'allow');
  check('strength: a home-folder scan by grep is never covered', d('grep', home, home, { rules: allowR('Read', 'Read(~/**)', `Read(//${home.slice(1)})`) }).kind === 'ask');
  check('strength: mcp__srv covers that server\'s tools', d('mcp__srv__t', '{}', undefined, { mcp: () => ({ server: 'srv', readOnly: false, destructive: false }), rules: allowR('mcp__srv') }).kind === 'allow' && d('mcp__srv__t', '{}', undefined, { mcp: () => ({ server: 'srv', readOnly: false, destructive: false }), rules: allowR('mcp__srv__u') }).kind === 'ask');
  // Auto mode with its check
  const auto = (over) => ({ mode: 'auto', auto: 'check', ...over });
  check('auto: a matching allow rule skips the check', d('bash', 'make build', undefined, auto({ rules: allowR('Bash(make:*)') })).kind === 'allow');
  check('auto: … not for an interpreter, even exactly', d('bash', 'python3 deploy.py', undefined, auto({ rules: allowR('Bash(python3 deploy.py)') })).kind === 'classify');
  check('auto: … not for bare Bash or a rule that starts with a wildcard', d('bash', 'make build', undefined, auto({ rules: allowR('Bash') })).kind === 'classify' && d('bash', 'make --version', undefined, auto({ rules: allowR('Bash(* --version)') })).kind === 'classify');
  check('auto: a named command covers its soft reason without the check', d('bash', 'gcloud compute instances list', undefined, auto({ rules: allowR('Bash(gcloud compute instances list:*)') })).kind === 'allow');
  check('auto: sudo still asks', d('bash', 'sudo true', undefined, auto({ rules: allowR('Bash(sudo true)') })).kind === 'ask');
  check('auto: a protected path still goes to the check', d('write_file', 'x', gitCfg, auto({ rules: allowR('Edit(//**)', 'Edit(.git/**)') })).kind === 'classify');
  check('auto: an anchored Edit rule covers a write outside without the check', d('write_file', 'x', deskFile, auto({ rules: allowR('Edit(~/Desktop/**)') })).kind === 'allow');

  // ---------- 8. The shape before 0.16 ----------
  const old = { programs: ['git', 'npm'], edits: true, mcp: ['srv'], reasons: ['uses sudo'] };
  const conv = R.normalizeStoredRules(old);
  check('old shape: converted to rule strings', JSON.stringify(conv) === JSON.stringify({ allow: ['Bash(git:*)', 'Bash(npm:*)', 'Edit', 'mcp__srv'], reasons: ['uses sudo'] }), conv);
  const cases = [
    ['bash', 'git status && npm test', undefined, {}],
    ['bash', 'git push --force origin x', undefined, {}],
    ['bash', 'git status && make', undefined, {}],
    ['bash', 'sudo true', undefined, {}],
    ['bash', 'sudo true', undefined, { mode: 'auto', auto: 'check' }],
    ['bash', 'npm test', undefined, { mode: 'auto', auto: 'check' }],
    ['write_file', 'x', path.join(cwd, 'a'), {}],
    ['write_file', 'x', deskFile, {}],
    ['mcp__srv__t', '{}', undefined, { mcp: () => ({ server: 'srv', readOnly: false, destructive: false }) }],
  ];
  for (const [n, det, tgt, over] of cases) {
    const a = d(n, det, tgt, { ...over, rules: old });
    const b = d(n, det, tgt, { ...over, rules: conv });
    check(`old shape behaves the same: ${n} ${det}${over.mode ? ` (${over.mode})` : ''}`, JSON.stringify(a) === JSON.stringify(b), { a, b });
  }
  const cfgFile = path.join(tmp('oa-rules-cfgfile-'), 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ schemaVersion: 2, allowRules: { [cwd]: old, '/x': { programs: [] } }, permissions: { allow: ['Bash'] } }));
  const loaded = readStoredConfig(cfgFile);
  check('old config.json: loads converted, empty entries dropped', JSON.stringify(loaded.allowRules) === JSON.stringify({ [cwd]: conv }), loaded.allowRules);
  check('config.json: a permissions block there is ignored (settings.json only)', loaded.permissions === undefined);
  const card = R.cardRules('program', ['git', 'we ird']);
  check('a card\'s "Always allow" saves the rule string (an odd program name its old way)', JSON.stringify(card.allow) === JSON.stringify(['Bash(git:*)']) && JSON.stringify(card.programs) === JSON.stringify(['we ird']) && R.cardRules('edits', [])[ 'allow'][0] === 'Edit' && R.cardRules('mcp', ['srv']).allow[0] === 'mcp__srv');

  // ---------- 9. settings.json: yours only ----------
  const userFile = path.join(CONFIG, 'settings.json');
  fs.writeFileSync(userFile, JSON.stringify({ permissions: { allow: ['Bash(npm test)', 'Bash('], deny: ['Bash(rm:*)'] } }));
  const proj = tmp('oa-rules-proj-');
  fs.mkdirSync(path.join(proj, '.silo-harness'));
  const projRaw = JSON.stringify({ permissions: { allow: ['Bash'] }, theme: 'dark' });
  fs.writeFileSync(path.join(proj, '.silo-harness', 'settings.json'), projRaw);
  const layer = new SettingsLayer({ userFile });
  const base = readStoredConfig(path.join(proj, 'none.json'));
  const applied = layer.load({ ...base, workingDirectory: proj, settingsTrusted: { [trustKey(proj)]: contentHash(projRaw) } });
  check('settings.json: the user file sets global rules', JSON.stringify(applied.permissions) === JSON.stringify({ allow: ['Bash(npm test)', 'Bash('], deny: ['Bash(rm:*)'] }), applied.permissions);
  const info = layer.info();
  check('settings.json: a bad rule there is reported', info.files[0].invalid.some((i) => i.key === 'permissions.allow[1]'), info.files[0].invalid);
  check('settings.json: a trusted project file may not set permissions', info.files[1].applied && applied.theme === 'dark' && info.files[1].invalid.some((i) => i.key === 'permissions'), info.files[1]);
  check('settings.json: never written into config.json', layer.withoutSettings(applied).permissions === undefined);
  check('checkSetting validates permissions', checkSetting('permissions', { allow: ['Bash(ls)'] }) === null && typeof checkSetting('permissions', { allow: ['Bash('] }) === 'string');
  const both = R.compileRules({ allow: ['Bash(make:*)'] }, applied.permissions);
  check('global and project rules apply together', R.bashAllow('npm test && make', both, () => false).covered && v(both, 'bash', { command: 'rm x' })?.list === 'deny' && both.invalid.some((i) => i.source === 'global'));

  // ---------- 10. The agent cannot write itself a rule ----------
  const appData = tmp('oa-rules-appdata-');
  setAppDataDir(appData);
  for (const mode of ['ask', 'acceptEdits', 'bypass', 'auto']) {
    const w = d('write_file', 'x', userFile, { mode, auto: 'check', rules: allowR('Edit', 'Edit(//**)') });
    check(`rule files: writing settings.json asks in ${mode} mode`, w.kind === 'ask' && w.firm === true && w.custom === true, w);
  }
  check('rule files: so does config.json, by a command, a copy or a symlink', ['ask', 'bypass'].every((mode) => d('bash', `echo '{}' > ${path.join(appData, 'config.json')}`, undefined, { mode, rules: allowR('Bash') }).firm && d('bash', `cp /tmp/x ${userFile}`, undefined, { mode }).firm));
  fs.symlinkSync(userFile, path.join(cwd, 'innocent.json'));
  check('rule files: a symlink to settings.json is the same file', d('write_file', 'x', path.join(cwd, 'innocent.json'), { mode: 'bypass' }).firm === true);
  check('rule files: Plan mode refuses', d('write_file', 'x', userFile, { mode: 'plan' }).kind === 'refuse');
  check('rule files: a session working in the config folder still asks', decideApproval('write_file', 'x', userFile, {}, { ...ctx({ mode: 'acceptEdits' }), cwd: CONFIG }).kind === 'ask');

  // ---------- 10b. A cd earlier in the line, relative paths, sudo ----------
  // The guard checks a path at every folder the line may be in, so a rule for cd and echo does not cover a write the
  // cd moved somewhere else; a write it cannot place counts as outside the working directory.
  const firm = (r) => r.kind === 'ask' && r.firm === true && r.reason === 'writes a protected file';
  const notRun = (r) => r.kind === 'ask' || r.kind === 'classify';
  const echoCd = allowR('Bash(echo:*)', 'Bash(cd:*)');
  for (const [mode, auto] of [['ask'], ['acceptEdits'], ['auto', 'check'], ['auto', 'guard'], ['bypass']]) {
    const m = `${mode}${auto ? ` (${auto})` : ''}`;
    for (const cmd of [`cd ${CONFIG} && echo x > settings.json`, `pushd ${CONFIG}; echo x > settings.json`, `cd ${appData} && echo x > config.json`, `dd of=${userFile}`, `ln -s ${userFile} s.json && echo x > s.json`, `tar -C ${CONFIG} -xf a.tar`, `unzip a.zip -d ${CONFIG}`, `sudo tee ${userFile}`])
      check(`rule files: ${m}: ${cmd.split(CONFIG).join('<config>').split(appData).join('<appdata>')} asks, firm`, firm(d('bash', cmd, undefined, { mode, auto, rules: echoCd })), d('bash', cmd, undefined, { mode, auto, rules: echoCd }));
    check(`rule files: ${m}: pushd <appdata>; echo x > config.json under bare Bash asks, firm`, firm(d('bash', `pushd ${appData}; echo x > config.json`, undefined, { mode, auto, rules: allowR('Bash') })));
  }
  for (const [mode, auto] of [['ask'], ['acceptEdits'], ['auto', 'check']]) {
    const m = `${mode}${auto ? ` (${auto})` : ''}`;
    const rows = [
      ['cd ~ && echo x > .zshrc', echoCd, 'writes a protected file'],
      ['cd /etc && echo hi > hosts', allowR('Bash(echo hi:*)', 'Bash(cd:*)'), 'writes outside the working directory'],
      ['cd .. && echo x > out.txt', echoCd, 'writes outside the working directory'],
      ['npm run test > ../out.txt', allowR('Bash(npm run test:*)'), 'writes outside the working directory'],
      ['X=~/.zshrc; echo evil >> $X', allowR('Bash(echo:*)'), 'writes outside the working directory'],
      [`D=${CONFIG}; echo x > $D/settings.json`, allowR('Bash(echo:*)'), 'writes outside the working directory'],
      ['cd $D && echo x > a', echoCd, 'writes outside the working directory'],
      ['rm ../x', allowR('Bash(rm:*)'), 'deletes outside the working directory'],
      ['cp a ../b', allowR('Bash(cp:*)'), 'writes outside the working directory'],
    ];
    for (const [cmd, rules, why] of rows) {
      const r = d('bash', cmd, undefined, { mode, auto, rules });
      check(`folders: ${m}: ${cmd.split(CONFIG).join('<config>')} under ${rules.allow.join(', ')} is not run unasked (${why})`, notRun(r) && r.reason === why, r);
    }
    // ordinary work under the same rules still runs
    for (const [cmd, rules] of [['cd src && echo x > out.txt', echoCd], ['npm run test > out.log', allowR('Bash(npm run test:*)')], ['cd src && rm -rf dist', allowR('Bash(cd:*)', 'Bash(rm:*)')], ['cat ../README.md', allowR('Bash(cat:*)')], ['cd .. && git status', allowR('Bash(cd:*)', 'Bash(git status:*)')]]) {
      const r = d('bash', cmd, undefined, { mode, auto, rules });
      check(`folders: ${m}: ${cmd} under ${rules.allow.join(', ')} runs`, r.kind === 'allow', r);
    }
  }
  check('folders: Bypass runs a write outside after a cd (only rule files ask there)', d('bash', 'cd .. && echo x > out.txt', undefined, { mode: 'bypass' }).kind === 'allow');
  // deny and ask rules look through sudo and doas; allow rules do not
  for (const cmd of ['sudo rm x', 'sudo -u root rm x', 'sudo -- rm x', 'sudo -E -u root VAR=1 rm x', 'doas rm x', 'sudo sh -c "rm x"', 'echo y | sudo xargs rm'])
    check(`deny: Bash(rm:*) refuses ${cmd}`, v(rs([], [], ['Bash(rm:*)']), 'bash', { command: cmd })?.list === 'deny');
  check('ask: Bash(git push:*) asks for sudo git push', v(rs([], ['Bash(git push:*)']), 'bash', { command: 'sudo git push origin main' })?.list === 'ask');
  check('deny: Bash(rm:*) leaves sudo ls alone', v(rs([], [], ['Bash(rm:*)']), 'bash', { command: 'sudo ls' }) === null);
  check('allow: Bash(rm:*) does not cover sudo rm x', !R.bashAllow('sudo rm x', rs(['Bash(rm:*)']), () => false).covered);
  for (const mode of ['ask', 'bypass']) check(`deny: sudo rm x is refused in ${mode} mode by deny Bash(rm:*)`, R.ruleVerdict(R.compileRules({ deny: ['Bash(rm:*)'] }), 'bash', { command: 'sudo rm x' }, cwd)?.list === 'deny');
  const sudoRm = d('bash', 'sudo rm -rf ~', undefined, { rules: { allow: ['Bash'], reasons: ['uses sudo'] } });
  check('sudo: a saved "uses sudo" does not wave through sudo rm -rf ~', sudoRm.kind === 'ask', sudoRm);

  // ---------- 11. The agent loop: deny in Bypass, ask in Bypass, a hook's allow ----------
  const mock = await startMock();
  const { state } = mock;
  const root = tmp('oa-rules-agent-');
  const work = path.join(root, 'project');
  fs.mkdirSync(work);
  const store = new SessionStore(path.join(root, 'sessions'));
  const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') });
  const config = {
    provider: 'portkey',
    ollama: { baseURL: 'http://127.0.0.1:1/v1', model: 'm', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: work, permissionMode: 'bypass', maxTurns: 20, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false, autoCompact: false, mcpServers: {}, mcpTrusted: {},
    allowRules: {},
  };
  const ran = [];
  const fake = (name) => ({ name, description: name, parameters: { type: 'object', properties: { text: { type: 'string' } } }, async run(args) { ran.push(name); return { content: `${name} ran` }; } });
  let groups = [];
  const hooks = new HookEngine({ settings: () => ({ sets: [{ groups, source: 'user', label: 'settings.json' }], disabled: false }) });
  let events = [];
  let answers = [];
  let agent;
  const emit = (ev) => {
    events.push(ev);
    if (ev.type === 'approval_request') setTimeout(() => agent.resolveApproval(ev.id, answers.length ? answers.shift() : false), 10);
  };
  const fakeSite = { name: 'fake_site', description: 'opens a site', parameters: { type: 'object', properties: {} }, async run(args, c) { const a = await c.approve('fake_site', 'Open example.com', undefined, { browser: { site, card: 'site' } }); if (!a.ok) return { content: a.message }; ran.push('fake_site'); return { content: 'opened' }; } };
  agent = new Agent(() => config, { navigate: async (u) => u }, store, () => [], emit, undefined, artifacts, undefined, { hooks, tools: () => [fake('fake_a'), fake('fake_b'), fakeSite] });
  let n = 0;
  const run = async (name, rules, hookAllow = false, ans = []) => {
    config.allowRules = { [work]: rules };
    groups = hookAllow ? [{ event: 'PreToolUse', matcher: name, handlers: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }] }] : [];
    events = [];
    ran.length = 0;
    answers = ans;
    state.requests.length = 0;
    state.replies.length = 0;
    state.replies.push({ toolCalls: [{ id: `r${++n}`, name, args: { text: 'x' } }] }, { content: 'ok' });
    await agent.run(`run ${name}`);
    const toolMsg = state.requests[1]?.payload.messages.filter((m) => m.role === 'tool').pop()?.content ?? '';
    return { cards: events.filter((e) => e.type === 'approval_request'), toolMsg };
  };
  let r = await run('fake_a', { deny: ['fake_a'] });
  check('agent: a deny rule refuses in Bypass, naming the rule', ran.length === 0 && /deny rule fake_a/.test(r.toolMsg) && r.cards.length === 0, r.toolMsg);
  r = await run('fake_a', { ask: ['fake_a'] }, false, [true]);
  check('agent: an ask rule shows a card in Bypass, naming the rule', r.cards.length === 1 && /ask rule fake_a/.test(r.cards[0].reason ?? '') && ran.length === 1, r.cards[0]);
  r = await run('fake_a', { ask: ['fake_a'] }, false, [false]);
  check('agent: … and Deny on it refuses', ran.length === 0);
  r = await run('fake_a', { deny: ['fake_a'] }, true);
  check('agent: a hook\'s allow does not beat a deny rule', ran.length === 0 && /deny rule/.test(r.toolMsg), r.toolMsg);
  r = await run('fake_a', { ask: ['fake_a'] }, true, [false]);
  check('agent: a hook\'s allow does not beat an ask rule', r.cards.length === 1 && ran.length === 0, r.cards);
  r = await run('fake_b', { deny: ['fake_a'], ask: ['fake_a'] }, true);
  check('agent: rules for another tool leave it alone', ran.length === 1 && r.cards.length === 0);
  config.permissionMode = 'ask';
  r = await run('fake_site', { ask: ['fake_site'] }, false, [true, false]);
  check('agent: Allow on an ask rule\'s card does not answer the browser\'s site card', r.cards.length === 2 && r.cards[1].browser && ran.length === 0, r.cards.map((c) => c.reason ?? c.browser));
  mock.close();
  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
