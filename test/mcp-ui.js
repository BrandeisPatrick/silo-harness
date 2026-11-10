// What Settings → MCP servers and the /mcp card say and offer for a server (src/renderer/mcp-model.ts), and what the
// main process lets the window see of a config (src/main/mcp.ts maskedConfig, configVars, log): one set of status
// words, one colour per meaning, one primary action, a menu, one-line reasons, the Trust disclosure, no secrets.
// Run: node test/mcp-ui.js <projectDir> (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');
const { maskedConfig, configVars, headerVarName, McpManager } = require(path.join(projectDir, 'dist/main/mcp.js'));
const TEST_SERVER = path.join(__dirname, 'support', 'test-mcp-server.js');

(async () => {
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/mcp-model.js'), 'utf8');
  const M = await import('data:text/javascript,' + encodeURIComponent(src));
  const srv = (o) => ({ name: 'files', scope: 'user', transport: 'stdio', target: 'npx -y @example/files-mcp', status: 'connected', tools: [], config: {}, ...o });
  const tools = (n) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, fullName: `mcp__files__t${i}`, description: '', readOnly: false, destructive: false }));

  // ---------- Status words and colours ----------
  check('status words', JSON.stringify(Object.values(M.STATUS_WORDS)) === JSON.stringify(['Connected', 'Connecting…', 'Reconnecting…', 'Needs sign-in', 'Signing in…', 'Failed', 'Off', 'Not trusted']));
  check('statusText: connected adds the count', M.statusText(srv({ tools: tools(5) })) === 'Connected · 5 tools' && M.statusText(srv({ tools: tools(1) })) === 'Connected · 1 tool' && M.statusText(srv({ tools: [] })) === 'Connected · no tools');
  check('one colour per meaning', M.statusTone('connected') === 'ok' && M.statusTone('needs-auth') === 'attention' && M.statusTone('blocked') === 'attention' && M.statusTone('error') === 'failed' && M.statusTone('disabled') === 'off');
  check('connecting and reconnecting are quiet (not amber, not red)', M.statusTone('connecting') === 'quiet' && M.statusTone('reconnecting') === 'quiet' && M.statusTone('authorizing') === 'quiet');

  // ---------- One primary action, the rest in the menu ----------
  const prim = (o) => (M.primaryAction(srv(o)) || { label: null }).label;
  check('primary by status', prim({ status: 'needs-auth' }) === 'Sign in' && prim({ status: 'authorizing' }) === 'Cancel' && prim({ status: 'error' }) === 'Retry' && prim({ status: 'blocked' }) === 'Trust' && prim({ tools: tools(5) }) === '5 tools');
  check('no primary while off, connecting or reconnecting', prim({ status: 'disabled' }) === null && prim({ status: 'connecting' }) === null && prim({ status: 'reconnecting' }) === null);
  check('menu: a connected local server', M.menuActions(srv({})).join(',') === 'reconnect,log,copy,remove');
  check('menu: signed-in remote server', M.menuActions(srv({ transport: 'http', signedIn: true })).join(',') === 'reconnect,sign-out,copy,remove');
  check('menu: no Reconnect while off or needing sign-in', !M.menuActions(srv({ status: 'disabled' })).includes('reconnect') && !M.menuActions(srv({ status: 'needs-auth', transport: 'http' })).includes('reconnect'));
  check('menu: Remove is last', M.menuActions(srv({ status: 'blocked', scope: 'project' })).pop() === 'remove');
  check('a not-trusted row has no switch', !M.hasSwitch(srv({ status: 'blocked' })) && M.hasSwitch(srv({ status: 'disabled' })));

  // ---------- One-line reasons ----------
  const tb = 'The server exited right after starting.\nTraceback (most recent call last):\n  File "server.py", line 12, in <module>\nKeyError: \'BUILDER_TOKEN\'';
  check('a local server that exited: the last line it printed comes first', M.reasonLine(srv({ status: 'error', error: tb })) === "Exited: KeyError: 'BUILDER_TOKEN'", M.reasonLine(srv({ status: 'error', error: tb })));
  check('a remote failure: its first line', M.reasonLine(srv({ status: 'error', transport: 'http', error: 'HTTP 403: forbidden\nmore' })) === 'HTTP 403: forbidden');
  check('reason: bidi and control characters escaped, one line, capped', M.reasonLine(srv({ status: 'error', transport: 'http', error: 'bad‮gnp.exe\u0007 ' + 'x'.repeat(400) })).startsWith('bad\\u{202e}gnp.exe\\u{7}') && M.reasonLine(srv({ status: 'error', transport: 'http', error: 'y'.repeat(400) })).length === 160);
  check('safeLines keeps lines, escapes each', JSON.stringify(M.safeLines(['a​b', 7, 'c'])) === JSON.stringify(['a\\u{200b}b', 'c']));

  // ---------- Trust disclosure ----------
  const local = M.trustLines(srv({ status: 'blocked', scope: 'project', target: 'npx -y @example/kanban-mcp --board ./board.json', vars: [{ name: 'KANBAN_TOKEN', set: true }] }));
  check('trust (local): what runs, read-only note, what it reads', JSON.stringify(local) === JSON.stringify(['Runs npx -y @example/kanban-mcp --board ./board.json', 'Read-only tools run without asking.', 'Reads $KANBAN_TOKEN']), local);
  const remote = M.trustLines(srv({ status: 'blocked', scope: 'project', transport: 'http', target: 'https://tracker.example.com/mcp', vars: [{ name: 'TRACKER_TOKEN', to: 'tracker.example.com', set: false }] }));
  check('trust (remote): the host, and what it sends where', JSON.stringify(remote) === JSON.stringify(['Connects to tracker.example.com', 'Read-only tools run without asking.', 'Sends $TRACKER_TOKEN to tracker.example.com']), remote);
  check('unset variables are named on the row', M.unsetText(srv({ unset: ['TRACKER_TOKEN'] })) === 'Not set: $TRACKER_TOKEN' && M.unsetText(srv({ unset: ['X'], status: 'disabled' })) === '' && M.unsetText(srv({ unset: ['bad name'] })) === '');
  check('subtitle: title and version dim beside the name', M.serverSubtitle(srv({ serverInfo: { name: 'x', version: '2025.10.2', title: 'Example Docs' } })) === 'Example Docs 2025.10.2' && M.serverSubtitle(srv({ serverInfo: { name: 'x', version: 'v1.4.0' } })) === 'v1.4.0' && M.serverSubtitle(srv({})) === '');
  check('subtitle: a title cannot rename the row (it is secondary, one line)', M.serverSubtitle(srv({ serverInfo: { name: 'x', version: '1', title: 'files\nREAL NAME' } })) === 'files REAL NAME 1');

  // ---------- What the window sees of a config: no secrets ----------
  const c = { type: 'stdio', command: 'node', args: ['s.js'], env: { API_KEY: 'sk-live-123', HOME_DIR: '${HOME}', OTHER: '${X:-y}' } };
  const m1 = maskedConfig('files', c);
  check('env values become ${KEY} refs; refs stay', m1.env.API_KEY === '${API_KEY}' && m1.env.HOME_DIR === '${HOME}' && m1.env.OTHER === '${X:-y}' && !JSON.stringify(m1).includes('sk-live'));
  const h = maskedConfig('tracker', { type: 'http', url: 'https://t.example.com/mcp', headers: { Authorization: 'Bearer abc', 'X-Team': '${TEAM}' } });
  check('header values become refs named for the server and header', h.headers.Authorization === '${TRACKER_AUTHORIZATION}' && h.headers['X-Team'] === '${TEAM}' && !JSON.stringify(h).includes('abc'));
  check('headerVarName: upper snake case', headerVarName('acme.docs', 'X-Api-Key') === 'ACME_DOCS_X_API_KEY' && headerVarName('9x', 'a') === '_9X_A');
  check('the original config is not changed', c.env.API_KEY === 'sk-live-123');
  check('copy text is the masked block', JSON.parse(M.copyText({ name: 'files', config: m1 })).mcpServers.files.env.API_KEY === '${API_KEY}');
  const vars = configVars({ type: 'http', url: 'https://${HOST:-t.example.com}/mcp', headers: { Authorization: 'Bearer ${OC_UNSET_TOKEN_X}' } }, { });
  check('configVars: a remote server sends its refs to its host; unset ones are marked', JSON.stringify(vars) === JSON.stringify([{ name: 'HOST', to: 't.example.com', set: true }, { name: 'OC_UNSET_TOKEN_X', to: 't.example.com', set: false }]), vars);
  const lv = configVars({ type: 'stdio', command: 'node', args: ['${DIR}/s.js'], env: { K: '${K}' } }, { DIR: '/x' });
  check('configVars: a local command reads its refs', JSON.stringify(lv) === JSON.stringify([{ name: 'DIR', set: true }, { name: 'K', set: false }]), lv);

  // ---------- The manager's list carries the masked config, the vars and the log ----------
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcpui-'));
  let config = { mcpServers: { test: { command: 'node', args: [TEST_SERVER], env: { OC_PROJECT: projectDir, SECRET_TOKEN: 'sk-test-999', GONE: '${OC_SURELY_UNSET_VAR}' } } }, mcpTrusted: {} };
  const m = new McpManager({ getConfig: () => config, saveConfig: (p) => { config = { ...config, ...p }; }, cwd: () => cwd });
  await m.reload();
  const info = m.list()[0];
  check('list(): no env value reaches the window', !JSON.stringify(info).includes('sk-test-999') && info.config.env.SECRET_TOKEN === '${SECRET_TOKEN}');
  check('list(): unset variables named', JSON.stringify(info.unset) === JSON.stringify(['OC_SURELY_UNSET_VAR']));
  const log = m.log('test', 'user');
  check('log(): what the server printed', Array.isArray(log) && log.includes('test server starting'), log);
  check('log(): unknown server rejected', (() => { try { m.log('nope', 'user'); return false; } catch { return true; } })());
  await m.close();

  done();
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
