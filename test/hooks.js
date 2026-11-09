// Hooks (src/main/hooks/*): the `hooks` block of settings.json (validation, problem lines, trust), matchers and `if`
// rules, the tool-name mapping, the exit-code and JSON-output rules, timeouts, onFailure, async, the merge of several
// hooks' decisions; then the agent loop with a mock model and fake tools (deny, ask, allow, rewritten input, context,
// UserPromptSubmit, SessionStart, Stop re-entry, PreCompact, Notification); then mods: the manifest, the bridge request
// and its answer, and a view that never answers. Run: node test/hooks.js (after npm run build)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { check, done } = require('./support/check.js');
const { startMock } = require('./support/mock-model.js');

const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-hooks-home-'));
process.env.SILO_HARNESS_CONFIG_DIR = HOME;

const { validateHooks, matcherProblem } = dist('hooks/config.js');
const { matcherMatches, ifRuleMatches, bashRuleMatches, bashSubcommands, pathRuleMatches } = dist('hooks/match.js');
const { claudeToolName, claudeToolInput, nativeToolInput, toolMatchNames } = dist('hooks/tools.js');
const { readResult, parseStdout } = dist('hooks/run.js');
const { HookEngine, claudePermissionMode } = dist('hooks/engine.js');
const { SettingsHooks } = dist('hooks/settings-source.js');
const { SettingsLayer, contentHash, settingsSchema, settableFields, checkSetting } = dist('settings.js');
const { Agent } = dist('agent.js');
const { SessionStore, toTranscript } = dist('sessions.js');
const { ArtifactStore } = dist('artifacts.js');
const { validateManifest } = dist('mods/manifest.js');
const { createMods } = dist('mods.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const script = (dir, name, body) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(f, 0o755);
  return f;
};

(async () => {
  // ---------- A. the hooks block ----------
  {
    const b = validateHooks({
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/block-rm.sh', timeout: 60 }, { type: 'command' }] },
        { matcher: 'Edit|Write', hooks: [{ type: 'http', url: 'http://localhost:9/hook', headers: { Authorization: 'Bearer $TOKEN' }, allowedEnvVars: ['TOKEN'] }] },
        { matcher: '[unclosed', hooks: [{ type: 'command', command: 'true' }] },
      ],
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is it done?' }, { type: 'command', command: 'echo ok', statusMessage: 'Checking   the end' }] }],
      PermissionRequest: [{ hooks: [{ type: 'command', command: 'x' }] }],
      NotAnEvent: [],
      UserPromptSubmit: { not: 'a list' },
      PostToolUse: [{ hooks: [{ type: 'command', command: 'x', timeout: -1 }, { type: 'command', command: 'node', args: ['a.js', 1] }, { type: 'mcp_tool', server: 's', tool: 't' }, { type: 'agent', prompt: 'p' }, { type: 'command', command: 'y', if: 'not a rule!' }] }],
    });
    const keyOf = (k) => b.problems.find((p) => p.key === k);
    check('A: valid groups are kept (a bad handler is dropped, the rest applies)', b.groups.length === 3 && b.groups[0].handlers.length === 1 && b.groups[0].handlers[0].timeout === 60, b.groups);
    check('A: a handler without a command is a problem line', !!keyOf('hooks.PreToolUse[0].hooks[1].command'));
    check('A: an invalid regular expression matcher is a problem line', /regular expression/.test(keyOf('hooks.PreToolUse[2].matcher')?.message ?? ''));
    check('A: prompt, mcp_tool and agent handlers are reported as unsupported', /not supported/.test(keyOf('hooks.Stop[0].hooks[0].type')?.message ?? '') && !!keyOf('hooks.PostToolUse[0].hooks[2].type') && !!keyOf('hooks.PostToolUse[0].hooks[3].type'));
    check('A: a Claude Code event this app does not fire is a problem line, not an error', /does not fire/.test(keyOf('hooks.PermissionRequest')?.message ?? ''));
    check('A: an unknown event and a non-list are problem lines', !!keyOf('hooks.NotAnEvent') && !!keyOf('hooks.UserPromptSubmit'));
    check('A: timeout, args and if are checked', !!keyOf('hooks.PostToolUse[0].hooks[0].timeout') && !!keyOf('hooks.PostToolUse[0].hooks[1].args') && !!keyOf('hooks.PostToolUse[0].hooks[4].if'));
    check('A: keys name the events that have a usable handler', JSON.stringify(b.keys) === JSON.stringify(['hooks.PreToolUse', 'hooks.Stop']), b.keys);
    check('A: the commands it runs are listed (for the trust prompt)', b.commands.includes('~/.claude/hooks/block-rm.sh') && b.commands.includes('http://localhost:9/hook') && b.commands.includes('echo ok'));
    check('A: statusMessage is one line', b.groups[2].handlers[0].statusMessage === 'Checking the end');
    check('A: not an object', validateHooks([]).problems[0].key === 'hooks');
    check('A: matcherProblem: names and lists are not regexps', matcherProblem('Edit|Write') === null && matcherProblem('mcp__.*') === null && !!matcherProblem('('));
    check('A: checkSetting knows hooks and disableAllHooks', checkSetting('hooks', { Stop: [] }) === null && /hooks/.test(String(checkSetting('hooks', 3))) && checkSetting('disableAllHooks', 'yes') !== null && checkSetting('disableAllHooks', true) === null);
    check('A: settableFields and the schema have hooks', settableFields().includes('hooks') && settableFields().includes('disableAllHooks') && !!settingsSchema().properties.hooks && !!settingsSchema().properties.disableAllHooks);
    const exec = validateHooks({ PostToolUse: [{ hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/x.js', '--fix'], async: true, onFailure: 'block' }] }] });
    check('A: exec form, async and onFailure are read', exec.groups[0].handlers[0].args.length === 2 && exec.groups[0].handlers[0].async === true && exec.groups[0].handlers[0].onFailure === 'block');
  }

  // ---------- B. the files: user, project, trust ----------
  {
    const cwd = tmp('oa-hooks-proj-');
    const userFile = path.join(HOME, 'settings.json');
    fs.writeFileSync(userFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }, { type: 'nope' }] }], Bogus: [] } }));
    fs.mkdirSync(path.join(cwd, '.silo-harness'));
    const projectFile = path.join(cwd, '.silo-harness', 'settings.json');
    const projectText = JSON.stringify({ maxTurns: 5, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'project-hook' }] }] } });
    fs.writeFileSync(projectFile, projectText);
    let cfg = { workingDirectory: cwd, settingsTrusted: {}, permissionMode: 'ask' };
    const layer = new SettingsLayer({ userFile });
    layer.load(cfg);
    const info = layer.info();
    const user = info.files.find((f) => f.scope === 'user');
    const project = info.files.find((f) => f.scope === 'project');
    check('B: the user file sets hooks.PreToolUse, with problem lines for the rest', user.keys.includes('hooks.PreToolUse') && user.invalid.some((i) => i.key === 'hooks.PreToolUse[0].hooks[1].type') && user.invalid.some((i) => i.key === 'hooks.Bogus'), user);
    check('B: a project file lists its hooks and the commands they run', project.keys.includes('hooks.Stop') && project.hookCommands?.includes('project-hook') && !project.applied, project);
    const sh = new SettingsHooks({ config: () => cfg, userFile: () => userFile });
    let sets = sh.forCwd(cwd).sets;
    check('B: an untrusted project file runs no hooks', sets.length === 1 && sets[0].source === 'user' && sets[0].groups[0].handlers.length === 1);
    cfg = { ...cfg, settingsTrusted: { [path.resolve(cwd)]: contentHash(projectText) } };
    sets = sh.forCwd(cwd).sets;
    check('B: a trusted project file adds its hooks', sets.length === 2 && sets[1].source === 'project' && sets[1].label === projectFile);
    await sleep(20);
    fs.writeFileSync(projectFile, projectText.replace('project-hook', 'changed-hook'));
    sets = sh.forCwd(cwd).sets;
    check('B: an edited project file is not trusted any more', sets.length === 1);
    fs.writeFileSync(userFile, JSON.stringify({ disableAllHooks: true, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
    check('B: disableAllHooks is read', sh.forCwd(cwd).disabled === true);
    check('B: problems are listed per file', sh.problems(cwd).length === 0);
    fs.rmSync(userFile);
  }

  // ---------- C. matchers and if ----------
  {
    check('C: *, empty and none match all', matcherMatches('*', ['Bash']) && matcherMatches('', ['x']) && matcherMatches(undefined, ['x']));
    check('C: exact names and | , lists', matcherMatches('Bash', ['Bash']) && !matcherMatches('Bash', ['BashOutput']) && matcherMatches('Edit|Write', ['Write']) && matcherMatches('Edit, Write', ['Edit']) && !matcherMatches('Edit|Write', ['Read']));
    check('C: a regular expression, unanchored', matcherMatches('Edit.*', ['NotebookEdit']) && matcherMatches('^Notebook', ['NotebookEdit']) && !matcherMatches('^Edit$', ['NotebookEdit']) && matcherMatches('mcp__memory__.*', ['mcp__memory__create']));
    check('C: mcp__memory alone is an exact name and matches no tool', !matcherMatches('mcp__memory', ['mcp__memory__create']));
    check('C: either name of a tool matches', matcherMatches('read_file', toolMatchNames('read_file')) && matcherMatches('Read', toolMatchNames('read_file')) && matcherMatches('Bash', toolMatchNames('terminal_run')));
    // The Bash table of the reference
    check('C: FOO=bar git push matches Bash(git *)', bashRuleMatches('git *', 'FOO=bar git push'));
    check('C: npm test && git push matches Bash(git *)', bashRuleMatches('git *', 'npm test && git push'));
    check('C: echo $(rm -rf /) matches Bash(rm *)', bashRuleMatches('rm *', 'echo $(rm -rf /)'));
    check('C: echo $(date) does not match Bash(rm *)', !bashRuleMatches('rm *', 'echo $(date)'));
    check('C: Bash(git push *) runs anyway on $()', bashRuleMatches('git push *', 'echo $(date)'));
    check('C: backticks are checked', bashRuleMatches('rm *', 'echo `rm x`') && !bashRuleMatches('rm *', 'echo `date`'));
    check('C: an unreadable command runs the hook', bashRuleMatches('rm *', 'echo "unclosed'));
    check('C: "ls *" matches ls -la and ls, not lsof', bashRuleMatches('ls *', 'ls -la') && bashRuleMatches('ls *', 'ls') && !bashRuleMatches('ls *', 'lsof'));
    check('C: the :* prefix form', bashRuleMatches('npm run test:*', 'npm run test -- --watch') && !bashRuleMatches('npm run test:*', 'npm run testing'));
    check('C: subcommands split at ; | || & and newlines, groups opened', JSON.stringify(bashSubcommands('a; b | c || d & e\nf')) === JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f']) && JSON.stringify(bashSubcommands('(cd x && rm y)')) === JSON.stringify(['cd x', 'rm y']));
    check('C: quotes keep separators', JSON.stringify(bashSubcommands("echo 'a; b' && echo \"c | d\"")) === JSON.stringify(["echo 'a; b'", 'echo "c | d"']));
    check('C: ${VAR} is not a group', JSON.stringify(bashSubcommands('cat ${HOME}/x && ls')) === JSON.stringify(['cat ${HOME}/x', 'ls']));
    const cwd = '/work/proj';
    check('C: Edit(*.ts) matches TypeScript at any depth', pathRuleMatches('*.ts', '/work/proj/src/a/b.ts', cwd) && !pathRuleMatches('*.ts', '/work/proj/b.js', cwd));
    check('C: Edit(src/**) is the src folder of the working directory only', pathRuleMatches('src/**', '/work/proj/src/a.ts', cwd) && !pathRuleMatches('src/**', '/work/proj/lib/src/a.ts', cwd) && pathRuleMatches('**/src/**', '/work/proj/lib/src/a.ts', cwd));
    check('C: //abs and ~/ patterns', pathRuleMatches('//etc/**', '/etc/hosts', cwd) && pathRuleMatches('~/x/*', path.join(os.homedir(), 'x', 'y'), cwd));
    const names = toolMatchNames('edit_file');
    check('C: if Edit(*.ts) on edit_file', ifRuleMatches('Edit(*.ts)', names, { file_path: '/work/proj/a.ts' }, cwd) && !ifRuleMatches('Edit(*.ts)', names, { file_path: '/work/proj/a.md' }, cwd));
    check('C: if Bash(rm *) on bash and on terminal_run', ifRuleMatches('Bash(rm *)', toolMatchNames('bash'), { command: 'rm -rf build' }, cwd) && ifRuleMatches('Bash(rm *)', toolMatchNames('terminal_run'), { command: 'rm x' }, cwd) && !ifRuleMatches('Bash(rm *)', toolMatchNames('bash'), { command: 'npm test' }, cwd));
    check('C: if with another tool name does not match', !ifRuleMatches('Write', names, {}, cwd) && ifRuleMatches('Edit', names, {}, cwd));
  }

  // ---------- D. tool names and inputs ----------
  {
    const cwd = '/work/proj';
    check('D: Claude Code names where the tool is the same thing', claudeToolName('bash') === 'Bash' && claudeToolName('read_file') === 'Read' && claudeToolName('write_file') === 'Write' && claudeToolName('edit_file') === 'Edit' && claudeToolName('glob') === 'Glob' && claudeToolName('grep') === 'Grep');
    check('D: the rest keep their names (MCP tools already match)', claudeToolName('browser_click') === 'browser_click' && claudeToolName('mcp__mem__x') === 'mcp__mem__x' && claudeToolName('terminal_run') === 'terminal_run');
    check('D: Bash input', JSON.stringify(claudeToolInput('bash', { command: 'ls', timeout_ms: 5000 }, cwd)) === JSON.stringify({ command: 'ls', timeout: 5000 }));
    check('D: Read/Write/Edit inputs with absolute file_path', claudeToolInput('read_file', { path: 'a.txt' }, cwd).file_path === '/work/proj/a.txt' && claudeToolInput('write_file', { path: '/x', content: 'c' }, cwd).content === 'c' && claudeToolInput('edit_file', { path: 'b', old_string: 'o', new_string: 'n' }, cwd).old_string === 'o');
    check('D: other tools pass their arguments as they are', JSON.stringify(claudeToolInput('browser_click', { text: 'OK' }, cwd)) === '{"text":"OK"}');
    check('D: updatedInput maps back', JSON.stringify(nativeToolInput('bash', { command: 'ls -a', timeout: 10 })) === JSON.stringify({ command: 'ls -a', timeout_ms: 10 }) && nativeToolInput('write_file', { file_path: '/x', content: 'y' }).path === '/x' && nativeToolInput('write_file', { path: '/n' }).path === '/n');
    check('D: permission modes as Claude Code names them', claudePermissionMode('ask') === 'default' && claudePermissionMode('bypass') === 'bypassPermissions' && claudePermissionMode('acceptEdits') === 'acceptEdits' && claudePermissionMode('plan') === 'plan');
  }

  // ---------- E. exit codes and JSON output ----------
  {
    const ex = (code, stdout = '', stderr = '') => ({ kind: 'exit', code, stdout, stderr });
    const pre = (r, h = {}) => readResult('PreToolUse', h, r);
    let v = pre(ex(0, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}'));
    check('E: exit 0 + JSON deny', v.permission === 'deny' && v.permissionReason === 'no' && !v.block);
    v = pre(ex(0, 'just text'));
    check('E: exit 0 + plain text on PreToolUse: nothing', !v.permission && !v.block && !v.context && !v.failure);
    v = readResult('UserPromptSubmit', {}, ex(0, 'Today is a holiday.\n'));
    check('E: exit 0 + plain text on UserPromptSubmit is context', v.context === 'Today is a holiday.');
    v = readResult('PreCompact', {}, ex(0, 'Keep the API decisions'));
    check('E: PreCompact stdout is instructions', v.context === 'Keep the API decisions');
    v = pre(ex(0, '{ not json }'));
    check('E: exit 0 + broken JSON is a non-blocking error', !!v.failure && !v.block && /parsed/.test(v.failure));
    v = pre(ex(0, '{"continue": "yes"}'));
    check('E: exit 0 + JSON that fails validation is an error', /validation/.test(v.failure ?? ''));
    v = pre(ex(2, '', 'Blocked: rm is not allowed\n'));
    check('E: exit 2 blocks with stderr as the reason', v.block === 'Blocked: rm is not allowed' && v.label === 'block');
    v = pre(ex(2, '{"hookSpecificOutput":{"permissionDecision":"allow"}}', 'nope'));
    check('E: exit 2 blocks even when the JSON allows', v.block === 'nope' && !v.permission);
    v = pre(ex(1, '', 'something broke\nmore'));
    check('E: another exit code is a non-blocking error with the first stderr line', !v.block && v.failure === 'Failed with non-blocking status code: something broke' && v.exitCode === 1);
    v = pre(ex(1, '{"hookSpecificOutput":{"permissionDecision":"deny"}}'));
    check('E: another exit code with valid JSON: the fields decide', v.permission === 'deny' && !v.failure);
    v = pre(ex(1, '', 'boom'), { onFailure: 'block' });
    check('E: onFailure block turns a failure into a block', /failed; blocking because onFailure is "block"\nboom/.test(v.block ?? ''));
    v = pre({ kind: 'timeout' });
    check('E: a timeout renders no decision', !v.block && !v.permission && v.label === 'timeout');
    v = pre({ kind: 'timeout' }, { onFailure: 'block' });
    check('E: a timeout with onFailure block blocks', /^timed out; blocking/.test(v.block ?? ''));
    v = pre({ kind: 'error', message: 'spawn ENOENT' }, { onFailure: 'block' });
    check('E: a hook that cannot start, with onFailure block, blocks', /^failed; blocking/.test(v.block ?? ''));
    v = readResult('Stop', { onFailure: 'block' }, ex(1, '', 'x'));
    check('E: onFailure has no effect on Stop', !v.block && !!v.failure);
    v = readResult('Stop', {}, ex(2, '', '/bin/sh: /nope.sh: No such file or directory'));
    check('E: Stop exit 2 with a missing script is non-blocking', !v.block && !!v.failure);
    v = readResult('Stop', {}, ex(0, '{"decision":"block","reason":"Run the tests first"}'));
    check('E: decision block + reason on Stop', v.block === 'Run the tests first');
    v = readResult('PostToolUse', {}, ex(0, '{"systemMessage":"note","hookSpecificOutput":{"additionalContext":"ctx"},"continue":false,"stopReason":"enough"}'));
    check('E: systemMessage, additionalContext and continue:false', v.systemMessage === 'note' && v.context === 'ctx' && v.stop?.reason === 'enough');
    v = pre(ex(0, '{"decision":"approve"}'));
    check('E: the older decision "approve" is allow on PreToolUse', v.permission === 'allow');
    check('E: stdout rules: several JSON lines without fields are text; with a field, a failure', 'text' in parseStdout('{"a":1}\n{"b":2}') && 'error' in parseStdout('{"a":1}\n{"decision":"block"}') && 'text' in parseStdout('[1,2]'));
  }

  // ---------- F. the engine, with real commands ----------
  const dir = tmp('oa-hooks-scripts-');
  const cwd = tmp('oa-hooks-cwd-');
  let groups = [];
  let disabled = false;
  const logs = [];
  const engine = new HookEngine({ settings: () => ({ sets: [{ groups, source: 'user', label: '/u/settings.json' }, ...(dupe ? [{ groups, source: 'project', label: '/p/settings.json' }] : [])], disabled }), log: (l) => logs.push(l) });
  let dupe = false;
  const ctxFor = (fields = {}, extra = {}) => ({ sessionId: 'S1', cwd, transcriptPath: '/t/S1.json', permissionMode: 'ask', fields, ...extra });
  const cmd = (command, more = {}) => ({ type: 'command', command, ...more });
  {
    const inFile = path.join(dir, 'in.json');
    const envFile = path.join(dir, 'env.txt');
    groups = [{ event: 'PreToolUse', matcher: 'Bash', handlers: [cmd(`cat > ${inFile}; echo "$CLAUDE_PROJECT_DIR|$SILO_PROJECT_DIR|$(pwd)" > ${envFile}`)] }];
    const names = toolMatchNames('bash');
    const input = claudeToolInput('bash', { command: 'ls' }, cwd);
    let out = await engine.fire('PreToolUse', ctxFor({ tool_name: 'Bash', tool_input: input, tool_use_id: 'c1', silo_tool_name: 'bash', silo_tool_input: { command: 'ls' } }, { match: names, tool: { names, input } }));
    const got = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    check('F: the input on stdin: common and event fields', got.session_id === 'S1' && got.transcript_path === '/t/S1.json' && got.cwd === cwd && got.permission_mode === 'default' && got.hook_event_name === 'PreToolUse' && got.tool_name === 'Bash' && got.tool_input.command === 'ls' && got.tool_use_id === 'c1' && got.silo_tool_name === 'bash', got);
    const [pd, sd, wd] = fs.readFileSync(envFile, 'utf8').trim().split('|');
    check('F: CLAUDE_PROJECT_DIR, SILO_PROJECT_DIR and the cwd are the session folder', pd === cwd && sd === cwd && fs.realpathSync(wd) === fs.realpathSync(cwd));
    check('F: no decision, nothing blocked', out.ran === 1 && !out.block && !out.permission);
    // matcher filters
    out = await engine.fire('PreToolUse', ctxFor({}, { match: toolMatchNames('read_file'), tool: { names: toolMatchNames('read_file'), input: {} } }));
    check('F: a group whose matcher does not match does not run', out.ran === 0);

    // the merge: deny > ask > allow, any block blocks
    const decide = (d, reason) => cmd(`printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"${d}","permissionDecisionReason":"${reason}"}}'`);
    groups = [{ event: 'PreToolUse', matcher: '', handlers: [decide('allow', 'a'), decide('ask', 'b'), decide('deny', 'c')] }];
    out = await engine.fire('PreToolUse', ctxFor({}, { match: ['Bash'] }));
    check('F: deny wins over ask and allow', out.permission === 'deny' && out.permissionReason === 'c' && out.ran === 3);
    groups = [{ event: 'PreToolUse', matcher: '', handlers: [decide('allow', 'a'), decide('ask', 'b')] }];
    out = await engine.fire('PreToolUse', ctxFor({}, { match: ['Bash'] }));
    check('F: ask wins over allow', out.permission === 'ask' && out.permissionReason === 'b');
    groups = [{ event: 'PreToolUse', matcher: '', handlers: [decide('allow', 'a'), cmd(`echo 'Blocked: no rm' >&2; exit 2`)] }];
    out = await engine.fire('PreToolUse', ctxFor({}, { match: ['Bash'], tool: { names: ['Bash', 'bash'], input: {} } }));
    check('F: any block blocks, worded as Claude Code does', out.block === "PreToolUse:Bash hook error: [echo 'Blocked: no rm' >&2; exit 2]: Blocked: no rm", out.block);
    groups = [{ event: 'PreToolUse', matcher: '', handlers: [cmd(`printf '%s' '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"ls -la"}}}'`)] }];
    out = await engine.fire('PreToolUse', ctxFor({}, { match: ['Bash'] }));
    check('F: updatedInput comes with allow', out.permission === 'allow' && out.updatedInput?.command === 'ls -la');

    // parallel, timeout, onFailure, async
    groups = [{ event: 'PreToolUse', matcher: '', handlers: [cmd('sleep 0.6'), cmd('sleep 0.6; true')] }];
    let t0 = Date.now();
    await engine.fire('PreToolUse', ctxFor({}, { match: ['Bash'] }));
    check('F: the hooks of one event run in parallel', Date.now() - t0 < 1100, Date.now() - t0);
    groups = [{ event: 'PreToolUse', matcher: '', handlers: [cmd('sleep 5', { timeout: 0.3 })] }];
    t0 = Date.now();
    out = await engine.fire('PreToolUse', ctxFor({}, { match: ['Bash'] }));
    check('F: a hook past its timeout is cancelled and renders no decision', Date.now() - t0 < 2000 && !out.block && !out.permission && /timed out/.test(out.notices[0] ?? ''), out);
    groups = [{ event: 'PreToolUse', matcher: '', handlers: [cmd('sleep 5', { timeout: 0.3, onFailure: 'block' })] }];
    out = await engine.fire('PreToolUse', ctxFor({}, { match: ['Bash'], tool: { names: ['Bash'], input: {} } }));
    check('F: with onFailure block the timeout blocks', /timed out; blocking because onFailure is "block"/.test(out.block ?? ''), out);
    groups = [{ event: 'PreToolUse', matcher: '', handlers: [cmd('/no/such/hook.sh', { onFailure: 'block' })] }];
    out = await engine.fire('PreToolUse', ctxFor({}, { match: ['Bash'] }));
    check('F: a missing script with onFailure block blocks', /blocking because onFailure/.test(out.block ?? ''), out);
    const asyncFile = path.join(dir, 'async.txt');
    groups = [{ event: 'PostToolUse', matcher: '', handlers: [cmd(`sleep 0.4; echo done > ${asyncFile}; printf '%s' '{"hookSpecificOutput":{"permissionDecision":"deny"}}'`, { async: true })] }];
    t0 = Date.now();
    out = await engine.fire('PostToolUse', ctxFor({}, { match: ['Bash'] }));
    check('F: an async hook is not waited for and decides nothing', Date.now() - t0 < 300 && !out.permission && out.ran === 1 && !fs.existsSync(asyncFile));
    await sleep(800);
    check('F: … it still runs, and its run is recorded', fs.existsSync(asyncFile) && engine.recentRuns().some((r) => r.event === 'PostToolUse' && r.exitCode === 0));
    // if
    groups = [{ event: 'PreToolUse', matcher: 'Bash', handlers: [cmd(`echo no >&2; exit 2`, { if: 'Bash(rm *)' })] }];
    const bn = toolMatchNames('bash');
    out = await engine.fire('PreToolUse', ctxFor({}, { match: bn, tool: { names: bn, input: { command: 'npm test' } } }));
    const out2 = await engine.fire('PreToolUse', ctxFor({}, { match: bn, tool: { names: bn, input: { command: 'rm -rf build' } } }));
    check('F: if filters the handler (npm test runs nothing, rm is blocked)', out.ran === 0 && !!out2.block);
    groups = [{ event: 'Stop', matcher: '', handlers: [cmd(`exit 2`, { if: 'Bash(*)' })] }];
    out = await engine.fire('Stop', ctxFor({}));
    check('F: a handler with if never runs on an event that is not a tool event', out.ran === 0);
    // matcher on events without matcher support is ignored
    groups = [{ event: 'Stop', matcher: 'Whatever', handlers: [cmd('true')] }];
    out = await engine.fire('Stop', ctxFor({}));
    check('F: a matcher on Stop is ignored', out.ran === 1);
    // the same handler in two files runs once
    dupe = true;
    groups = [{ event: 'Stop', matcher: '', handlers: [cmd('true')] }];
    out = await engine.fire('Stop', ctxFor({}));
    check('F: the same handler in two files runs once', out.ran === 1);
    dupe = false;
    // disableAllHooks
    disabled = true;
    check('F: disableAllHooks turns the files off', !engine.has('Stop', cwd));
    disabled = false;
    // an http hook
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const input = JSON.parse(body);
        res.writeHead(req.url === '/bad' ? 500 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ decision: 'block', reason: `seen ${input.hook_event_name} ${req.headers['x-token'] ?? ''}` }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    process.env.HOOK_TOKEN = 'tok';
    groups = [{ event: 'Stop', matcher: '', handlers: [{ type: 'http', url: `http://127.0.0.1:${port}/ok`, headers: { 'x-token': '$HOOK_TOKEN' }, allowedEnvVars: ['HOOK_TOKEN'] }] }];
    out = await engine.fire('Stop', ctxFor({ stop_hook_active: false }));
    check('F: an http hook: the POST body is the input, the response the output, headers from allowed variables', out.block === 'seen Stop tok', out);
    groups = [{ event: 'Stop', matcher: '', handlers: [{ type: 'http', url: `http://127.0.0.1:${port}/bad` }] }];
    out = await engine.fire('Stop', ctxFor({}));
    check('F: a non-2xx response is a non-blocking error', !out.block && /HTTP 500/.test(out.notices[0] ?? ''), out);
    server.close();
    // SessionEnd budget
    groups = [{ event: 'SessionEnd', matcher: '', handlers: [cmd('sleep 4')] }];
    t0 = Date.now();
    await engine.fire('SessionEnd', ctxFor({ reason: 'other' }, { match: ['other'] }));
    check('F: SessionEnd hooks share a 1.5 s budget', Date.now() - t0 < 2500, Date.now() - t0);
    check('F: runs are recorded with exit code, decision and stderr', engine.recentRuns().some((r) => r.decision === 'block' && r.stderr === 'Blocked: no rm' && r.exitCode === 2));
    check('F: entries list what is in effect', engine.entries(cwd)[0].event === 'SessionEnd' && engine.entries(cwd)[0].sourceLabel === '/u/settings.json');
    engine.clearRuns();
    check('F: clearRuns', engine.recentRuns().length === 0);
  }

  // ---------- G. the agent loop ----------
  {
    const mock = await startMock();
    const { state } = mock;
    const root = tmp('oa-hooks-agent-');
    const work = path.join(root, 'project');
    fs.mkdirSync(work);
    const store = new SessionStore(path.join(root, 'sessions'));
    const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') });
    const config = {
      provider: 'portkey',
      ollama: { baseURL: 'http://127.0.0.1:1/v1', model: 'm', numCtx: 4096, think: 'auto' },
      portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
      workingDirectory: work, permissionMode: 'ask', maxTurns: 20, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false, autoCompact: false, mcpServers: {}, mcpTrusted: {},
    };
    let events = [];
    let approvals = []; // what to answer, in order (true = allow)
    let agent;
    const ran = [];
    const fakeWrite = {
      name: 'fake_write',
      description: 'Writes (asks first)',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async run(args, ctx) {
        const a = await ctx.approve('fake_write', `write ${args.text}`, undefined, { custom: true });
        if (!a.ok) return { content: a.message };
        ran.push(['fake_write', args]);
        return { content: `wrote ${args.text}` };
      },
    };
    const fakeRead = { name: 'fake_read', description: 'Reads', readOnly: true, parameters: { type: 'object', properties: { path: { type: 'string' } } }, async run(args) { ran.push(['fake_read', args]); return { content: `read ${args.path}` }; } };
    const hooksEngine = new HookEngine({ settings: () => ({ sets: [{ groups: agentGroups, source: 'user', label: 'settings.json' }], disabled: false }) });
    let agentGroups = [];
    const emit = (ev) => {
      events.push(ev);
      if (ev.type === 'approval_request') {
        const ok = approvals.length ? approvals.shift() : true;
        setTimeout(() => agent.resolveApproval(ev.id, ok), 10);
      }
    };
    agent = new Agent(() => config, { navigate: async (u) => u }, store, () => [], emit, undefined, artifacts, undefined, { hooks: hooksEngine, tools: () => [fakeWrite, fakeRead] });
    const reset = () => {
      events = [];
      ran.length = 0;
      state.requests.length = 0;
      state.replies.length = 0;
      approvals = [];
    };
    let n = 0;
    const call = (name, args) => ({ id: `call${++n}`, name, args });
    const toolMsgs = (req) => req.payload.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    const notices = () => events.filter((e) => e.type === 'error' && e.kind === 'notice').map((e) => e.message);
    const deny = cmd(`printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"not today"}}'`);

    // SessionStart (first run) and its context
    agentGroups = [{ event: 'SessionStart', matcher: 'startup', handlers: [cmd(`echo 'The project uses tabs.'`)] }];
    reset();
    state.replies.push({ content: 'hi' });
    await agent.run('hello');
    const firstMsgs = state.requests[0].payload.messages;
    check('G: SessionStart (startup) stdout reaches the model as context', firstMsgs.some((m) => m.role === 'user' && /The project uses tabs/.test(String(m.content))), firstMsgs.map((m) => m.role));
    check('G: … and the transcript does not show it as a message', !toTranscript(agent.session).some((i) => i.role === 'user' && /tabs/.test(i.text)) && toTranscript(agent.session).some((i) => i.role === 'user' && i.text === 'hello'));

    // deny
    agentGroups = [{ event: 'PreToolUse', matcher: 'fake_write', handlers: [deny] }];
    reset();
    state.replies.push({ toolCalls: [call('fake_write', { text: 'x' })] }, { content: 'ok' });
    await agent.run('write x');
    let res = toolMsgs(state.requests[1])[0] ?? '';
    check('G: deny: the tool does not run, the model reads the reason', ran.length === 0 && /PreToolUse:fake_write hook denied this tool call: not today/.test(res), res);
    check('G: deny: the tool row fails and a notice says so', events.some((e) => e.type === 'tool_end' && e.ok === false) && notices().some((t) => /A PreToolUse hook blocked fake_write: not today/.test(t)), notices());
    check('G: deny: no approval card', !events.some((e) => e.type === 'approval_request'));

    // exit 2 with Claude Code's wording
    agentGroups = [{ event: 'PreToolUse', matcher: 'fake_write', handlers: [cmd(`echo 'Blocked: rm commands are not allowed' >&2; exit 2`)] }];
    reset();
    state.replies.push({ toolCalls: [call('fake_write', { text: 'x' })] }, { content: 'ok' });
    await agent.run('write x');
    res = toolMsgs(state.requests[1]).pop() ?? '';
    check('G: exit 2: "PreToolUse:<tool> hook error: [<command>]: <stderr>"', res === "PreToolUse:fake_write hook error: [echo 'Blocked: rm commands are not allowed' >&2; exit 2]: Blocked: rm commands are not allowed", res);

    // allow skips the card
    agentGroups = [{ event: 'PreToolUse', matcher: 'fake_write', handlers: [cmd(`printf '%s' '{"hookSpecificOutput":{"permissionDecision":"allow"}}'`)] }];
    reset();
    state.replies.push({ toolCalls: [call('fake_write', { text: 'y' })] }, { content: 'ok' });
    await agent.run('write y');
    check('G: allow: the tool runs without an approval card', ran.length === 1 && !events.some((e) => e.type === 'approval_request'));
    // without the hook the card comes
    agentGroups = [];
    reset();
    state.replies.push({ toolCalls: [call('fake_write', { text: 'z' })] }, { content: 'ok' });
    await agent.run('write z');
    check('G: without a hook the custom tool asks', events.some((e) => e.type === 'approval_request') && ran.length === 1);

    // ask forces the card on a tool that never asks
    agentGroups = [{ event: 'PreToolUse', matcher: 'fake_read', handlers: [cmd(`printf '%s' '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"check this read"}}'`)] }];
    reset();
    approvals = [false];
    state.replies.push({ toolCalls: [call('fake_read', { path: 'a' })] }, { content: 'ok' });
    await agent.run('read a');
    const card = events.find((e) => e.type === 'approval_request');
    check('G: ask: the card appears for a tool that never asks, with the reason', !!card && card.name === 'fake_read' && card.reason === 'check this read' && ran.length === 0, card);
    reset();
    approvals = [true];
    state.replies.push({ toolCalls: [call('fake_read', { path: 'b' })] }, { content: 'ok' });
    await agent.run('read b');
    check('G: ask, allowed: the tool runs', ran.length === 1 && ran[0][1].path === 'b');
    // ask on a tool that asks itself: one card only
    agentGroups = [{ event: 'PreToolUse', matcher: 'fake_write', handlers: [cmd(`printf '%s' '{"hookSpecificOutput":{"permissionDecision":"ask"}}'`)] }];
    reset();
    state.replies.push({ toolCalls: [call('fake_write', { text: 'w' })] }, { content: 'ok' });
    await agent.run('write w');
    check('G: ask on a tool that asks too: one card, then it runs', events.filter((e) => e.type === 'approval_request').length === 1 && ran.length === 1);

    // updatedInput
    agentGroups = [{ event: 'PreToolUse', matcher: 'fake_read', handlers: [cmd(`printf '%s' '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"path":"rewritten.txt"}}}'`)] }];
    reset();
    state.replies.push({ toolCalls: [call('fake_read', { path: 'orig.txt' })] }, { content: 'ok' });
    await agent.run('read orig');
    const started = events.find((e) => e.type === 'tool_start');
    check('G: updatedInput replaces the arguments (and the row shows them)', ran[0]?.[1].path === 'rewritten.txt' && started.args.path === 'rewritten.txt', ran);

    // PreToolUse and PostToolUse context, PostToolUse block, PostToolUseFailure
    agentGroups = [
      { event: 'PreToolUse', matcher: 'fake_read', handlers: [cmd(`printf '%s' '{"hookSpecificOutput":{"additionalContext":"pre-context here"}}'`)] },
      { event: 'PostToolUse', matcher: 'fake_read', handlers: [cmd(`printf '%s' '{"decision":"block","reason":"lint failed","hookSpecificOutput":{"additionalContext":"post-context here"}}'`)] },
    ];
    reset();
    state.replies.push({ toolCalls: [call('fake_read', { path: 'c' })] }, { content: 'ok' });
    await agent.run('read c');
    res = toolMsgs(state.requests[1]).pop() ?? '';
    check('G: PreToolUse and PostToolUse context and a PostToolUse block reach the model with the result', /^read c/.test(res) && /pre-context here/.test(res) && /post-context here/.test(res) && /lint failed/.test(res), res);
    check('G: a PostToolUse block is a notice', notices().some((t) => /PostToolUse hook flagged fake_read: lint failed/.test(t)));
    const failFile = path.join(dir, 'failure.json');
    agentGroups = [{ event: 'PostToolUseFailure', matcher: '', handlers: [cmd(`cat > ${failFile}`)] }];
    reset();
    state.replies.push({ toolCalls: [call('no_such_tool', {})] }, { toolCalls: [call('fake_write', { text: 'q' })] }, { content: 'ok' });
    approvals = [false];
    await agent.run('fail');
    const failure = JSON.parse(fs.readFileSync(failFile, 'utf8'));
    check('G: PostToolUseFailure gets the error', failure.hook_event_name === 'PostToolUseFailure' && failure.tool_name === 'fake_write' && /^Not permitted/.test(failure.error) && failure.is_interrupt === false, failure);

    // PostToolUse input: tool_response
    const postFile = path.join(dir, 'post.json');
    agentGroups = [{ event: 'PostToolUse', matcher: 'fake_read', handlers: [cmd(`cat > ${postFile}`)] }];
    reset();
    state.replies.push({ toolCalls: [call('fake_read', { path: 'd' })] }, { content: 'ok' });
    await agent.run('read d');
    const post = JSON.parse(fs.readFileSync(postFile, 'utf8'));
    check('G: PostToolUse input carries tool_response and tool_use_id', post.tool_response === 'read d' && post.tool_use_id && post.tool_input.path === 'd');

    // UserPromptSubmit: context and a block
    agentGroups = [{ event: 'UserPromptSubmit', matcher: '', handlers: [cmd(`echo "The secret word is PELICAN"`)] }];
    reset();
    state.replies.push({ content: 'ok' });
    await agent.run('what is the word?');
    const sent = state.requests[0].payload.messages;
    const ui = sent.findIndex((m) => m.role === 'user' && m.content === 'what is the word?');
    check('G: UserPromptSubmit stdout reaches the model right after the prompt', ui >= 0 && /PELICAN/.test(String(sent[ui + 1]?.content)), sent.slice(-3));
    const upsFile = path.join(dir, 'ups.json');
    agentGroups = [{ event: 'UserPromptSubmit', matcher: '', handlers: [cmd(`cat > ${upsFile}; echo 'No passwords in prompts' >&2; exit 2`)] }];
    reset();
    const before = agent.session.messages.length;
    await agent.run('my password is hunter2');
    check('G: a UserPromptSubmit block drops the message, says why, and calls no model', agent.session.messages.length === before && state.requests.length === 0 && notices().some((t) => /blocked this message/.test(t) && /No passwords in prompts/.test(t)) && events.some((e) => e.type === 'run_end'), notices());
    const upsInput = JSON.parse(fs.readFileSync(upsFile, 'utf8'));
    check('G: UserPromptSubmit input has the prompt', upsInput.prompt === 'my password is hunter2');
    check('G: … and where it came from (silo_origin), with no sending session for a typed one', upsInput.silo_origin === 'user' && !('silo_from_session' in upsInput), upsInput);

    // Stop: exit 2 sends the run back once
    const stopIn = path.join(dir, 'stop-inputs.txt');
    agentGroups = [{ event: 'Stop', matcher: '', handlers: [cmd(`cat >> ${stopIn}; echo >> ${stopIn}; echo 'Run the tests before you stop' >&2; exit 2`)] }];
    reset();
    fs.rmSync(stopIn, { force: true });
    state.replies.push({ content: 'first answer' }, { content: 'second answer' }, { content: 'third answer' });
    await agent.run('do it');
    const stopInputs = fs.readFileSync(stopIn, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    check('G: Stop (exit 2) sends the run back once, then lets it end', state.requests.length === 2 && stopInputs.length === 2 && stopInputs[0].stop_hook_active === false && stopInputs[1].stop_hook_active === true, stopInputs.length);
    check('G: … the model reads the reason, and last_assistant_message is given', /Run the tests before you stop/.test(JSON.stringify(state.requests[1].payload.messages.slice(-1))) && stopInputs[0].last_assistant_message === 'first answer');
    // Stop: JSON block keeps going while the hook says so
    const counter = path.join(dir, 'count.txt');
    fs.writeFileSync(counter, '0');
    agentGroups = [{ event: 'Stop', matcher: '', handlers: [cmd(`n=$(cat ${counter}); n=$((n+1)); echo $n > ${counter}; if [ $n -le 2 ]; then printf '%s' '{"decision":"block","reason":"again"}'; fi`)] }];
    reset();
    state.replies.push({ content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' });
    await agent.run('loop');
    check('G: Stop with a JSON block: the hook decides each round (stop_hook_active)', state.requests.length === 3, state.requests.length);

    // Notification: permission_prompt
    const noteFile = path.join(dir, 'note.json');
    agentGroups = [{ event: 'Notification', matcher: 'permission_prompt', handlers: [cmd(`cat > ${noteFile}`)] }];
    reset();
    fs.rmSync(noteFile, { force: true });
    state.replies.push({ toolCalls: [call('fake_write', { text: 'n' })] }, { content: 'ok' });
    await agent.run('write n');
    await sleep(300);
    const note = fs.existsSync(noteFile) ? JSON.parse(fs.readFileSync(noteFile, 'utf8')) : {};
    check('G: Notification permission_prompt when an approval card waits', note.notification_type === 'permission_prompt' && /fake_write/.test(note.message), note);
    const idleFile = path.join(dir, 'idle.json');
    agentGroups = [{ event: 'Notification', matcher: 'idle_prompt', handlers: [cmd(`cat > ${idleFile}`)] }];
    reset();
    state.replies.push({ content: 'ok' });
    await agent.run('hi');
    await sleep(300);
    check('G: Notification idle_prompt when a run ends with no window in front', fs.existsSync(idleFile) && JSON.parse(fs.readFileSync(idleFile, 'utf8')).notification_type === 'idle_prompt');

    // continue: false stops the run
    agentGroups = [{ event: 'PostToolUse', matcher: '', handlers: [cmd(`printf '%s' '{"continue":false,"stopReason":"Budget reached"}'`)] }];
    reset();
    state.replies.push({ toolCalls: [call('fake_read', { path: 'e' })] }, { content: 'should not come' });
    await agent.run('read e');
    check('G: continue:false ends the run after the step, with the reason shown', state.requests.length === 1 && notices().some((t) => /Stopped by a hook: Budget reached/.test(t)));

    // PreCompact / PostCompact
    const pcFile = path.join(dir, 'postcompact.json');
    agentGroups = [
      { event: 'PreCompact', matcher: 'manual', handlers: [cmd(`echo 'Keep every file name'`)] },
      { event: 'PostCompact', matcher: '', handlers: [cmd(`cat > ${pcFile}`)] },
    ];
    reset();
    state.summary = 'A summary of what happened, long enough to be used by the compaction step here.';
    const r = await agent.compactNow();
    const sumReq = state.requests.find((q) => !q.payload.stream);
    check('G: PreCompact stdout is instructions for the summary', r.ok && !!sumReq && /Keep every file name/.test(JSON.stringify(sumReq.payload.messages)), r);
    check('G: PostCompact gets the trigger and the summary', fs.existsSync(pcFile) && JSON.parse(fs.readFileSync(pcFile, 'utf8')).trigger === 'manual' && /A summary/.test(JSON.parse(fs.readFileSync(pcFile, 'utf8')).compact_summary));
    agentGroups = [{ event: 'PreCompact', matcher: '', handlers: [cmd(`echo 'not now' >&2; exit 2`)] }];
    state.replies.push({ content: 'more' });
    await agent.run('more talk');
    const r2 = await agent.compactNow();
    check('G: a PreCompact block cancels the compaction', !r2.ok && /PreCompact hook blocked/.test(r2.error ?? ''), r2);

    // SessionEnd
    const endFile = path.join(dir, 'end.json');
    agentGroups = [{ event: 'SessionEnd', matcher: '', handlers: [cmd(`cat > ${endFile}`)] }];
    await agent.endSession('quit');
    check('G: SessionEnd on quit', JSON.parse(fs.readFileSync(endFile, 'utf8')).silo_reason === 'quit');

    // SubagentStop for a sub-session, with the parent as the hook's session
    const subFile = path.join(dir, 'sub.json');
    agentGroups = [{ event: 'SubagentStop', matcher: 'sub-session', handlers: [cmd(`cat > ${subFile}`)] }, { event: 'Stop', matcher: '', handlers: [cmd(`echo stop-ran >> ${subFile}.stop`)] }];
    const parent = agent.session;
    const child = store.create({ cwd: work, parentId: parent.id, origin: 'spawn' });
    const sub = new Agent(() => config, { navigate: async (u) => u }, store, () => [], () => {}, undefined, artifacts, undefined, { hooks: hooksEngine, session: child });
    reset();
    state.replies.push({ content: 'sub done' });
    await sub.run('do a part');
    const subIn = JSON.parse(fs.readFileSync(subFile, 'utf8'));
    check('G: SubagentStop for a sub-session, from the parent\'s point of view', subIn.hook_event_name === 'SubagentStop' && subIn.session_id === parent.id && subIn.agent_id === child.id && subIn.last_assistant_message === 'sub done' && !fs.existsSync(`${subFile}.stop`), subIn);
    mock.close();
  }

  // ---------- H. mods: manifest, the bridge request and its answer ----------
  {
    const fixture = path.join(__dirname, 'fixtures', 'hooks-mod');
    const m = validateManifest(JSON.parse(fs.readFileSync(path.join(fixture, 'mod.json'), 'utf8')), fixture, 'hooks-mod');
    check('H: the fixture manifest is valid: a worker view, hooks contributed', !!m.manifest && m.manifest.contributes.views[0].seat === 'worker' && JSON.stringify(m.manifest.contributes.hooks) === JSON.stringify([{ event: 'PreToolUse', timeout: 5 }, { event: 'PostToolUse' }]), m.problems);
    const noPerm = validateManifest({ protocol: 1, id: 'hooks-mod', name: 'x', version: '1.0.0', contributes: { hooks: ['Stop'] } }, fixture, 'hooks-mod');
    check('H: contributes.hooks needs the hooks permission', !noPerm.manifest && /needs the "hooks" permission/.test(noPerm.problems[0].message));
    const unknown = validateManifest({ protocol: 1, id: 'hooks-mod', name: 'x', version: '1.0.0', permissions: ['hooks'], contributes: { hooks: ['Stop', 'PermissionRequest', { event: 'PreToolUse', timeout: 9999 }] } }, fixture, 'hooks-mod');
    check('H: a timeout out of range is an error; an event this app does not fire a warning', !unknown.manifest && unknown.problems.some((p) => p.warning && /PermissionRequest/.test(p.message)) && unknown.problems.some((p) => !p.warning && /timeout/.test(p.message)));

    // createMods with a window and the hooks service
    const userData = tmp('oa-hooks-mods-');
    const project = tmp('oa-hooks-mods-proj-');
    const userMods = path.join(HOME, 'mods');
    fs.mkdirSync(userMods, { recursive: true });
    fs.cpSync(fixture, path.join(userMods, 'hooks-mod'), { recursive: true });
    let config = { workingDirectory: project, permissionMode: 'ask', mods: { enabled: { 'hooks-mod': { permissions: ['hooks'], styles: false, at: 1 } }, disabledBundled: [], settings: {}, layout: { railOpen: true, railWidth: 300, collapsed: [], background: null, backgroundImage: null, backgroundDim: 0.82 }, safeMode: false }, settingsTrusted: {} };
    const pushes = [];
    const handlers = {};
    const services = new Map();
    const store = new SessionStore(path.join(userData, 'sessions'));
    const engine = new HookEngine({ settings: () => ({ sets: [], disabled: false }) });
    services.set('hooks', engine);
    let answer = null; // (req) => reply, or null: no answer
    const app = {
      userData,
      appRoot: tmp('oa-hooks-approot-'),
      config: () => config,
      updateConfig: (c) => (config = typeof c === 'function' ? c(config) : { ...config, ...c }),
      onConfig: () => () => {},
      window: () => ({}),
      push: (channel, payload) => {
        pushes.push({ channel, payload });
        if (channel === 'mods:hook' && answer) setTimeout(() => handlers['mods.hookResult'](payload.id, answer(payload)), 20);
      },
      rpc: { handle: (name, fn) => ((handlers[name] = fn), () => delete handlers[name]) },
      store,
      runtime: { foregroundId: () => '', list: () => [], agentFor: () => ({}) },
      events: { on: () => () => {} },
      tools: { register: () => () => {}, list: () => [] },
      prompt: { add: () => () => {} },
      commands: { register: () => () => {}, list: () => [] },
      provide: (n, s) => (services.set(n, s), () => services.delete(n)),
      service: (n) => services.get(n),
      onQuit: () => {},
    };
    const host = { trash: async () => {}, reveal: () => {}, chooseImage: async () => null };
    const ctl = createMods(app, host);
    const info = ctl.registry.list().find((x) => x.id === 'hooks-mod');
    check('H: the fixture mod is on with the hooks permission', info?.state === 'on' && info.granted.includes('hooks'), info && { state: info.state, problems: info.problems });
    const entries = engine.entries(project);
    check('H: its hooks are listed with the mod\'s name as the source', entries.length === 2 && entries[0].type === 'mod' && entries[0].sourceLabel === 'Hooks fixture' && entries[0].timeout === 5 && entries[1].timeout === 10, entries);
    const ctx = { sessionId: 'S', cwd: project, transcriptPath: '/t', permissionMode: 'ask', fields: { tool_name: 'Read', tool_input: { file_path: '/x' } }, match: ['Read', 'read_file'], tool: { names: ['Read', 'read_file'], input: { file_path: '/x' } } };
    answer = (req) => ({ result: req.input.tool_name === 'Read' ? { hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'mod asks' } } : null });
    let out = await engine.fire('PreToolUse', ctx);
    const req = pushes.find((p) => p.channel === 'mods:hook');
    check('H: the request goes to the window with the mod, the event, the input and the timeout', req && req.payload.mod === 'hooks-mod' && req.payload.event === 'PreToolUse' && req.payload.input.hook_event_name === 'PreToolUse' && req.payload.input.tool_name === 'Read' && req.payload.timeoutMs === 5000, req);
    check('H: the mod\'s answer is merged like a command hook\'s output', out.permission === 'ask' && out.permissionReason === 'mod asks', out);
    answer = () => ({ error: 'handler threw' });
    out = await engine.fire('PreToolUse', ctx);
    check('H: an error from the mod is a non-blocking error notice', !out.permission && /mod Hooks fixture/.test(out.notices[0] ?? '') && /handler threw/.test(out.notices[0] ?? ''), out);
    answer = () => ({ result: { decision: 'nonsense' } });
    out = await engine.fire('PreToolUse', ctx);
    check('H: an output that fails validation is an error', /validation/.test(out.notices[0] ?? ''), out);
    // A view that never answers (a kit from before hooks): skipped after the timeout
    answer = null;
    config = { ...config };
    const short = engine.entries(project);
    void short;
    const t0 = Date.now();
    out = await engine.fire('PreToolUse', ctx);
    check('H: a mod that does not answer is skipped after its timeout, with no decision', Date.now() - t0 >= 4900 && Date.now() - t0 < 7000 && !out.permission && !out.block && out.notices.length === 0, Date.now() - t0);
    const skipped = engine.recentRuns().filter((r) => r.decision === 'skipped');
    check('H: … and the skip is recorded for Settings → Hooks', skipped.length === 1 && /did not answer/.test(skipped[0].stderr ?? ''), skipped);
    // A window reply that the views skipped (none registered) is a skip too
    answer = () => ({ skipped: 'no view of the mod handles PreToolUse' });
    out = await engine.fire('PreToolUse', ctx);
    check('H: no view registered: a skip, not an error', !out.permission && out.notices.length === 0 && engine.recentRuns().filter((r) => r.decision === 'skipped').length === 2);
    // mods turned off: no hooks
    config = { ...config, mods: { ...config.mods, enabled: {} } };
    ctl.registry.recompute();
    check('H: a mod that is off handles no hooks', !engine.has('PreToolUse', project));
    ctl.close();
    check('H: closing the mods detaches them from the engine', engine.entries(project).length === 0);
  }

  done();
})().catch((err) => {
  console.log(`CRASH ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
