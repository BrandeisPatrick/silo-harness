// UX tick 1: the file index and fuzzy search, @-mention expansion, project approval rules and the approval
// card's project scope, with the mock model. Run: node test-tick1.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { Agent } = require(path.join(projectDir, 'dist/main/agent.js'));
const { SessionStore, toTranscript, displayText } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { McpManager } = require(path.join(projectDir, 'dist/main/mcp.js'));
const { searchFiles, fuzzyScore, fileIndexSize, invalidateFileIndex } = require(path.join(projectDir, 'dist/main/files.js'));
const { expandMentions, findMentions, mentionedPaths, FILE_BLOCK_RE } = require(path.join(projectDir, 'dist/main/mentions.js'));
const { startMock } = require('./support/mock-model.js');
const TEST_SERVER = path.join(__dirname, 'support', 'test-mcp-server.js');

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`.slice(0, 500));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- a small project tree ----
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tick1-'));
  const mk = (rel, content = '') => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), content); };
  mk('src/main/agent.ts', 'export const agent = 1;\n'.repeat(3));
  mk('src/main/index.ts', 'index');
  mk('src/renderer/renderer.ts', 'renderer');
  mk('README.md', '# Readme\nhello');
  mk('docs/notes with spaces.md', 'spaced');
  mk('node_modules/pkg/index.js', 'ignored');
  mk('dist/out.js', 'ignored');
  mk('.gitignore', 'secrets/\n*.log\nlocal.env\n');
  mk('secrets/key.txt', 'ignored by gitignore');
  mk('app.log', 'ignored by ext');
  mk('local.env', 'ignored by name');
  mk('bin/blob.bin', Buffer.from([0, 1, 2, 3, 0, 255]).toString('binary'));
  mk('big.txt', 'x'.repeat(20_000));

  // ---- files ----
  const size = fileIndexSize(cwd);
  check('index skips node_modules, dist and .gitignore entries', size.entries === 13 && !size.truncated, size);
  let hits = searchFiles(cwd, '');
  check('empty query: root entries first, folders before files', hits[0].isDir && hits.map((h) => h.path).slice(0, 4).join(',') === 'bin,docs,src,.gitignore', hits.map((h) => h.path).slice(0, 6));
  hits = searchFiles(cwd, 'agent');
  check('name match first', hits[0].path === 'src/main/agent.ts', hits.map((h) => h.path));
  hits = searchFiles(cwd, 'smag');
  check('subsequence over the path (s/m/ag…)', hits.some((h) => h.path === 'src/main/agent.ts'), hits.map((h) => h.path));
  hits = searchFiles(cwd, 'rend');
  check('prefix of the name wins over deep path matches', hits[0].path === 'src/renderer/renderer.ts' || hits[0].path === 'src/renderer', hits.map((h) => h.path));
  check('no match → empty', searchFiles(cwd, 'zzzz').length === 0);
  check('limit respected', searchFiles(cwd, '', 3).length === 3);
  check('fuzzyScore: exact name beats prefix beats substring', fuzzyScore('a', { path: 'a', name: 'a', dir: '', isDir: false }) > fuzzyScore('a', { path: 'ab', name: 'ab', dir: '', isDir: false }) && fuzzyScore('b', { path: 'ab', name: 'ab', dir: '', isDir: false }) > fuzzyScore('b', { path: 'x/ab', name: 'ab', dir: 'x', isDir: false }));
  mk('src/new.ts', 'n');
  check('cache: a new file shows after invalidation', !searchFiles(cwd, 'new.ts').length && (invalidateFileIndex(), searchFiles(cwd, 'new.ts')[0]?.path === 'src/new.ts'));

  // ---- mentions ----
  check('findMentions: bare, quoted, trailing punctuation, no emails', JSON.stringify(findMentions('see @src/main/agent.ts, and @"docs/notes with spaces.md" plus @README.md. mail me@x.io (@src/renderer)')) === JSON.stringify(['src/main/agent.ts', 'docs/notes with spaces.md', 'README.md', 'src/renderer']));
  let r = expandMentions('look at @src/main/agent.ts and @README.md please', cwd);
  check('expand: both files inlined after the text', r.mentions.join(',') === 'src/main/agent.ts,README.md' && r.content.startsWith('look at @src/main/agent.ts and @README.md please\n\n<file path="src/main/agent.ts">\nexport const agent = 1;') && /<file path="README.md">\n# Readme\nhello\n<\/file>$/.test(r.content));
  check('displayText hides the blocks', displayText(r.content) === 'look at @src/main/agent.ts and @README.md please');
  check('mentionedPaths recovers the paths', mentionedPaths(r.content).join(',') === 'src/main/agent.ts,README.md');
  r = expandMentions('@src/renderer has what?', cwd);
  check('expand: a folder gives its listing', r.mentions[0] === 'src/renderer' && /note="folder listing"/.test(r.content) && /renderer\.ts/.test(r.content));
  r = expandMentions('check @"docs/notes with spaces.md"', cwd);
  check('expand: quoted path with spaces', r.mentions[0] === 'docs/notes with spaces.md' && /spaced/.test(r.content));
  r = expandMentions('@nope.txt and @../outside and @/etc/hosts and @~/x', cwd);
  check('expand: missing, outside, absolute and home paths are left alone', r.mentions.length === 0 && r.content === '@nope.txt and @../outside and @/etc/hosts and @~/x');
  r = expandMentions('@bin/blob.bin', cwd);
  check('expand: binary files are named, not inlined', /note="binary, 0 KB"/.test(r.content) && !/\x00/.test(r.content));
  r = expandMentions('@big.txt', cwd);
  check('expand: long files are cut with a note', /note="first 12000 characters; 8000 more not shown/.test(r.content) && r.content.length < 12_300);
  check('expand: nothing to do → unchanged', expandMentions('plain text', cwd).content === 'plain text');
  check('FILE_BLOCK_RE strips every block', 'a\n\n<file path="x">\n1\n</file>\n\n<file path="y" note="folder listing">\n2\n</file>'.replace(FILE_BLOCK_RE, '') === 'a');

  // ---- agent: mentions reach the model, rules and scopes ----
  const mock = await startMock();
  const { state } = mock;
  const store = new SessionStore(path.join(cwd, '..', `oc-tick1-sessions-${process.pid}`));
  const artifacts = new ArtifactStore({ root: path.join(cwd, '..', `oc-tick1-art-${process.pid}`), rendererDir: path.join(projectDir, 'dist/renderer') });
  let config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: cwd, permissionMode: 'ask', autoApprove: false, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: { test: { command: 'node', args: [TEST_SERVER], env: { OC_PROJECT: projectDir } } }, mcpTrusted: {}, autoCompact: true, notifications: true, allowRules: {},
  };
  const mcp = new McpManager({ getConfig: () => config, saveConfig: (p) => { config = { ...config, ...p }; }, cwd: () => config.workingDirectory });
  await mcp.reload();
  let events = [];
  let answer = null; // [ok, always, scope]
  let agent;
  const emit = (ev) => {
    events.push(ev);
    if (ev.type === 'approval_request' && answer) {
      const [ok, always, scope] = answer;
      setTimeout(() => {
        const out = agent.resolveApproval(ev.id, ok, always, scope);
        if (out.rule) {
          const r = { ...(config.allowRules[cwd] ?? {}) };
          if (out.rule.kind === 'edits') r.edits = true;
          else { const k = out.rule.kind === 'program' ? 'programs' : out.rule.kind === 'reason' ? 'reasons' : 'mcp'; r[k] = [...new Set([...(r[k] ?? []), ...out.rule.values])]; }
          config = { ...config, allowRules: { ...config.allowRules, [cwd]: r } };
        }
        if (out.setMode) config = { ...config, permissionMode: out.setMode };
        events.push({ type: 'test_outcome', out });
      }, 10);
    }
  };
  agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], emit, undefined, artifacts, mcp);
  let id = 0;
  const call = (name, args) => ({ id: `c${++id}`, name, args });
  const approvals = () => events.filter((e) => e.type === 'approval_request');
  const outcomes = () => events.filter((e) => e.type === 'test_outcome').map((e) => e.out);
  const reset = () => { events = []; state.requests.length = 0; state.replies.length = 0; };

  reset();
  state.replies.push({ content: 'ok' });
  await agent.run('summarise @README.md for me');
  const sent = state.requests[0].payload.messages.filter((m) => m.role === 'user' && !String(m.content).startsWith('[Session context]')).pop().content;
  check('run: mention inlined for the model', /<file path="README.md">\n# Readme\nhello\n<\/file>/.test(sent) && sent.startsWith('summarise @README.md for me'));
  check('run: system prompt explains @ mentions', /when the user writes @path/.test(state.requests[0].payload.messages[0].content));
  const items = toTranscript(agent.session);
  check('transcript: user item shows the typed text and the mentions', items[0].text === 'summarise @README.md for me' && JSON.stringify(items[0].mentions) === JSON.stringify(['README.md']));

  // project rule for a command
  reset();
  answer = [true, true, 'project'];
  state.replies.push({ toolCalls: [call('bash', { command: 'git status' })] });
  state.replies.push({ content: 'ok' });
  await agent.run('git?');
  let ap = approvals()[0];
  check('approval event carries the project label', ap && ap.alwaysLabel === 'Allow git for this session' && ap.projectLabel === 'Always allow git in this project', ap && ap.projectLabel);
  check('project scope returns a program rule', outcomes()[0] && outcomes()[0].rule && outcomes()[0].rule.kind === 'program' && outcomes()[0].rule.values[0] === 'git' && !outcomes()[0].setMode && config.allowRules[cwd].programs.includes('git'));
  reset();
  answer = null; // nobody answers: a card would hang the run
  agent.session = store.create(); // new session: session allow-lists are gone, the project rule stays
  state.replies.push({ toolCalls: [call('bash', { command: 'git log -1' })] });
  state.replies.push({ content: 'ok' });
  await agent.run('log?');
  check('a saved program rule skips the card in a new session', approvals().length === 0 && events.some((e) => e.type === 'tool_end' && e.name === 'bash'));
  reset();
  state.replies.push({ toolCalls: [call('bash', { command: 'git status && npm test' })] });
  answer = [false, false, 'session'];
  state.replies.push({ content: 'ok' });
  await agent.run('both?');
  check('a command with a program outside the rules still asks', approvals().length === 1 && /npm/.test(approvals()[0].alwaysLabel));

  // project rule for edits
  reset();
  answer = [true, true, 'project'];
  state.replies.push({ toolCalls: [call('write_file', { path: 'note.txt', content: 'hi' })] });
  state.replies.push({ content: 'ok' });
  await agent.run('write');
  check('edit card: project label and an edits rule, mode unchanged', approvals()[0].projectLabel === 'Always allow edits in this project' && outcomes()[0].rule.kind === 'edits' && config.permissionMode === 'ask' && config.allowRules[cwd].edits === true);
  reset();
  answer = null;
  agent.session = store.create();
  state.replies.push({ toolCalls: [call('edit_file', { path: 'note.txt', old_string: 'hi', new_string: 'hello' })] });
  state.replies.push({ content: 'ok' });
  await agent.run('edit');
  check('edits rule skips the card in ask mode', approvals().length === 0 && fs.readFileSync(path.join(cwd, 'note.txt'), 'utf8') === 'hello');

  // session scope for edits still switches the mode
  reset();
  config = { ...config, allowRules: {} };
  answer = [true, true, 'session'];
  state.replies.push({ toolCalls: [call('write_file', { path: 'note2.txt', content: 'x' })] });
  state.replies.push({ content: 'ok' });
  await agent.run('write2');
  check('session scope on an edit card switches to acceptEdits (as before)', outcomes()[0].setMode === 'acceptEdits' && !outcomes()[0].rule && config.permissionMode === 'acceptEdits');
  config = { ...config, permissionMode: 'ask' };

  // project rule for an MCP server
  reset();
  answer = [true, true, 'project'];
  state.replies.push({ toolCalls: [call('mcp__test__add', { a: 1, b: 2 })] });
  state.replies.push({ content: 'ok' });
  await agent.run('add');
  check('MCP card: project label and an mcp rule', approvals()[0].projectLabel === 'Always allow test in this project' && outcomes()[0].rule.kind === 'mcp' && config.allowRules[cwd].mcp.includes('test'));
  reset();
  answer = null;
  agent.session = store.create();
  state.replies.push({ toolCalls: [call('mcp__test__add', { a: 3, b: 4 })] });
  state.replies.push({ content: 'ok' });
  await agent.run('add again');
  check('mcp rule skips the card', approvals().length === 0 && events.some((e) => e.type === 'tool_end' && e.result === '7'));

  // auto-mode reason rule
  reset();
  config = { ...config, permissionMode: 'auto' };
  answer = [true, true, 'project'];
  state.replies.push({ toolCalls: [call('bash', { command: 'sudo true' })] });
  state.replies.push({ content: 'ok' });
  await agent.run('sudo');
  check('auto mode: reason rule saved', approvals()[0].reason === 'uses sudo' && outcomes()[0].rule.kind === 'reason' && config.allowRules[cwd].reasons.includes('uses sudo'));
  reset();
  answer = null;
  agent.session = store.create();
  state.replies.push({ toolCalls: [call('bash', { command: 'sudo -n true' })] });
  state.replies.push({ content: 'ok' });
  await agent.run('sudo again');
  check('saved reason no longer pauses', approvals().length === 0);

  await mcp.close();
  mock.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
