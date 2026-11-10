// MCP details polished after the comparison with Claude: what the model is sent stays the same (pinned), a removed
// server's sign-in goes with it, the interface gets the real server and tool names, the SSE fallback never hides a
// 401/403, and adding a project server never overwrites an entry of .mcp.json. Run: node test/mcp-polish.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');
const { McpManager, isOldServerAnswer } = require(path.join(projectDir, 'dist/main/mcp.js'));
const { FileTokenStore } = require(path.join(projectDir, 'dist/main/mcp-auth.js'));
const { withMcpNames } = require(path.join(projectDir, 'dist/main/mcp-names.js'));
const { approvalLabels, decideApproval } = require(path.join(projectDir, 'dist/main/agent/permissions.js'));
const { startMock } = require('./support/mock-oauth.js');
const TEST_SERVER = path.join(__dirname, 'support', 'test-mcp-server.js');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rejectsWith = async (p, re) => { try { await p; return false; } catch (e) { return re.test(e.message); } };
const srv = (env = {}) => ({ command: 'node', args: [TEST_SERVER], env: { OC_PROJECT: projectDir, ...env } });

/** A manager over an in-memory config; `config()` reads the latest */
function manager(cwd, initial, more = {}) {
  let config = { mcpServers: {}, mcpTrusted: {}, ...initial };
  const m = new McpManager({ getConfig: () => config, saveConfig: (p) => { config = { ...config, ...p }; }, cwd: () => cwd, ...more });
  return { m, config: () => config, set: (patch) => { config = { ...config, ...patch }; } };
}

(async () => {
  // ---------- What the model is sent: pinned ----------
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcpp-'));
    const { m } = manager(cwd, { mcpServers: { test: srv() } });
    await m.reload();
    const defs = JSON.stringify(m.tools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
    // The definitions of the eight test tools as v0.13.1 sent them (titles and the rest are for the interface only)
    check('the tool definitions sent to the model are byte-identical to v0.13.1', sha(defs) === '443d27358bbe4e7641399db3c55c4d8d544446498f28c14c7c85718550085d45', `${defs.length} chars`);
    await m.close();
  }

  // ---------- Real names for the interface ----------
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcpp-'));
    const { m } = manager(cwd, { mcpServers: { 'acme.docs': srv({ OC_TEST_ODD: '1' }) } });
    await m.reload();
    const full = m.tools().map((t) => t.name);
    const odd = full.find((n) => n.endsWith('list__items'));
    check('the model-facing names are sanitised (acme.docs → acme_docs)', full.includes('mcp__acme_docs__echo') && odd === 'mcp__acme_docs__list__items', full);
    check('names(): the real server and tool for a sanitised name', JSON.stringify(m.names('mcp__acme_docs__echo')) === JSON.stringify({ server: 'acme.docs', tool: 'echo' }));
    check('names(): a tool with "__" in its name is not split there', JSON.stringify(m.names(odd)) === JSON.stringify({ server: 'acme.docs', tool: 'list__items' }));
    check('names(): unknown name → undefined', m.names('mcp__nope__x') === undefined);
    const ev = withMcpNames({ type: 'tool_start', id: '1', name: odd, args: {} }, m);
    check('tool_start carries the real names', ev.mcp && ev.mcp.server === 'acme.docs' && ev.mcp.tool === 'list__items');
    const ap = withMcpNames({ type: 'approval_request', id: '2', name: 'mcp__acme_docs__echo', detail: '{}', mode: 'ask', alwaysLabel: '', projectLabel: '' }, m);
    check('approval_request carries the real names', ap.mcp && ap.mcp.server === 'acme.docs');
    const other = { type: 'tool_start', id: '3', name: 'bash', args: {} };
    check('other events and built-in tools pass unchanged', withMcpNames(other, m) === other && withMcpNames({ type: 'run_start' }, m).mcp === undefined);
    // The wider answers name the server the rule stores (decideApproval's programs are the real name)
    const ref = m.lookup('mcp__acme_docs__add');
    const d = decideApproval('mcp__acme_docs__add', '{}', undefined, {}, { mode: 'ask', cwd, rules: {}, allowed: { mcp: () => false, reason: () => false, program: () => false }, mcp: () => ref });
    const labels = approvalLabels('mcp__acme_docs__add', d.reason ?? null, d.programs);
    check('the wider answers and the stored rule use the same real name', d.kind === 'ask' && d.programs[0] === 'acme.docs' && labels.alwaysLabel === 'Allow acme.docs for this session' && labels.projectLabel === 'Always allow acme.docs in this project', [d, labels]);
    await m.close();

    // The renderer's side (types only, so it loads as a data: module)
    const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/mcp-labels.js'), 'utf8');
    const L = await import('data:text/javascript,' + encodeURIComponent(src));
    check('renderer: an old session parses the name', JSON.stringify(L.mcpNames('mcp__github__search_issues')) === JSON.stringify({ server: 'github', tool: 'search_issues' }) && L.mcpNames('bash') === null);
    L.rememberMcpNames(odd, { server: 'acme.docs', tool: 'list__items' });
    check('renderer: names an event carried win over parsing', L.mcpNames(odd).server === 'acme.docs' && L.mcpNames(odd).tool === 'list__items');
    L.noteMcpServers([{ name: 'acme.docs', scope: 'user', tools: [{ name: 'echo', fullName: 'mcp__acme_docs__echo', title: 'Echo‮ text\nback' }] }]);
    check('renderer: the server list fills the names; a title is one line with bidi characters escaped', L.mcpNames('mcp__acme_docs__echo').server === 'acme.docs' && L.mcpNames('mcp__acme_docs__echo').title === 'Echo\\u{202e} text back', L.mcpNames('mcp__acme_docs__echo'));
    L.rememberMcpNames('mcp__x__y', { server: '', tool: 'y' });
    check('renderer: a malformed record is ignored', L.mcpNames('mcp__x__y').server === 'x');
    check('renderer: oneLine caps', L.oneLine('a'.repeat(100), 10).length === 10);
  }

  // ---------- A removed server's sign-in goes with it ----------
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcpp-'));
    const file = path.join(cwd, 'auth', 'mcp-auth.json');
    const store = new FileTokenStore(file);
    const mock = await startMock(projectDir, { requireAuth: true });
    const { m, config } = manager(cwd, {}, { auth: { store, openExternal: async () => {} }, connectTimeoutMs: 4000 });
    await m.add('tracker', mock.mcpUrl, 'user');
    await store.set('user:tracker', { url: mock.mcpUrl, tokens: { access_token: 'tok-abc', token_type: 'Bearer' }, client: { client_id: 'c1' } });
    await m.reconnect('tracker', 'user');
    check('stored tokens show as signed in', m.list().find((s) => s.name === 'tracker').signedIn === true);
    await m.remove('tracker', 'user');
    const after = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { servers: {} };
    check('remove: the sign-in (tokens and client) is deleted from mcp-auth.json', !after.servers['user:tracker'] && !config().mcpServers.tracker, after);
    await m.add('tracker', mock.mcpUrl, 'user');
    const s = m.list().find((x) => x.name === 'tracker');
    check('adding the same name and URL again: needs sign-in, not signed in', s.status === 'needs-auth' && !s.signedIn, s);
    await m.close();
    await mock.close();
  }

  // ---------- HTTP → SSE fallback: only for an old server's answer, never 401/403 ----------
  {
    check('old-server answers: 400, 404, 405', isOldServerAnswer({ code: 400 }) && isOldServerAnswer({ code: 404 }) && isOldServerAnswer({ code: 405 }));
    check('not old-server answers: 401, 403, 500, none', !isOldServerAnswer({ code: 401 }) && !isOldServerAnswer({ code: 403 }) && !isOldServerAnswer({ code: 500 }) && !isOldServerAnswer(new Error('fetch failed')));
    const seen = [];
    let status = 403;
    const server = http.createServer((req, res) => {
      seen.push(req.method);
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(status === 403 ? 'forbidden' : 'nope');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcpp-'));
    const { m } = manager(cwd, { mcpServers: { api: { type: 'http', url, headers: { Authorization: 'Bearer wrong-key' } } } }, { connectTimeoutMs: 3000 });
    await m.reload();
    let s = m.list()[0];
    check('a 403 to a server with its own Authorization header: Failed with the 403, no SSE attempt', s.status === 'error' && /403/.test(s.error) && !seen.includes('GET') && !/SSE/i.test(s.error), [s.error, seen]);
    check('…and the key is not in the error text', !/wrong-key/.test(s.error));
    seen.length = 0;
    status = 405;
    await m.reconnect('api', 'user');
    s = m.list()[0];
    check('a 405: the SSE transport is tried (a GET)', seen.includes('POST') && seen.includes('GET'), seen);
    await m.close();
    server.close();
  }

  // ---------- Adding a project server never overwrites an entry of .mcp.json ----------
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcpp-'));
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { broken: { args: ['x'] }, fine: srv() } }, null, 2));
    const { m } = manager(cwd, {});
    await m.reload();
    check('adding over an invalid entry is refused', await rejectsWith(m.add('broken', 'node x.js', 'project'), /already exists/));
    check('adding over a valid entry is refused', await rejectsWith(m.add('fine', 'node x.js', 'project'), /already exists/));
    check('…and the file is unchanged', JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).mcpServers.broken.args[0] === 'x');
    await m.close();
  }

  done();
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
