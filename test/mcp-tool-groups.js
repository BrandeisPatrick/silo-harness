// MCP servers' tools load when needed (tools/groups.ts): each connected server is a group, mcp:<server>. A fresh
// session sends none of their definitions; the prompt names each server with its tools' names; a server loads by
// load_tools, by a call to one of its tools by name, or by a user message naming it; once loaded it stays (through
// compaction). Loading is not permission: the approval cards are the same as with every tool up front. Plan mode, an
// off server, a server's untrusted names, no secret anywhere, and on Anthropic's native path the request's tools and
// system prompt are byte for byte the same before and after a load.
// Run: node test/mcp-tool-groups.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const { McpManager } = dist('mcp.js');
const G = dist('tools/groups.js');
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');
const TEST_SERVER = path.join(__dirname, 'support', 'test-mcp-server.js');

const SECRET = 'made-up-secret-7f3a9c'; // a made-up env value: must never reach a request
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  // ---- 0: the helpers ----
  const servers = [{ group: 'mcp:docs', name: 'docs' }, { group: 'mcp:ab', name: 'ab' }, { group: 'mcp:my_c_x', name: 'my.c+x' }];
  check('0: a message naming a server, as a whole word in any case', same(G.mcpGroupsForMessage('Ask DOCS about it', servers), ['mcp:docs']) && same(G.mcpGroupsForMessage('the docs server, please', servers), ['mcp:docs']));
  check('0: …not inside a word, not a name under three characters, regex characters taken as text', G.mcpGroupsForMessage('read the mydocs and docs2 folders, ab', servers).length === 0 && same(G.mcpGroupsForMessage('use my.c+x now', servers), ['mcp:my_c_x']) && G.mcpGroupsForMessage('use myXc+x', servers).length === 0);
  check('0: an MCP group name is mcp: and a sanitised name', G.isGroupId('mcp:docs') && G.isGroupId('browser') && !G.isGroupId('mcp:') && !G.isGroupId('mcp:Docs') && !G.isGroupId('mcp:a b'));
  check('0: a brief\'s "Loaded mcp:…" line is read back', same(G.foldedGroups(`${G.FOLDED_GROUPS_HEADING}\nLoaded mcp:docs: mcp__docs__a.\nLoaded terminal: terminal_run.`), ['mcp:docs', 'terminal']));

  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mcp-groups-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd);
  // A project server nobody trusted: never started, nothing to load
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { command: 'node', args: [TEST_SERVER], env: { OC_PROJECT: projectDir } } } }));
  const server = (extra = {}) => ({ command: 'node', args: [TEST_SERVER], env: { OC_PROJECT: projectDir, OC_SECRET: SECRET, ...extra } });
  let config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: cwd, permissionMode: 'ask', autoApprove: false, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: { test: server(), other: server(), spare: { ...server(), disabled: true }, 'Odd.Name-X': server() },
    mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, toolSet: 'auto',
  };
  const mcp = new McpManager({ getConfig: () => config, saveConfig: (p) => (config = { ...config, ...p }), cwd: () => config.workingDirectory });
  await mcp.reload();
  const store = new SessionStore(path.join(tmp, 'sessions'));
  let events = [];
  let policy = null; // (ev) => [ok, always]
  let agent;
  const emit = (ev) => {
    events.push(ev);
    if (ev.type === 'approval_request' && policy) {
      const [ok, always] = policy(ev);
      setTimeout(() => agent.resolveApproval(ev.id, ok, always), 5);
    }
  };
  const fresh = () => (agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], emit, undefined, undefined, mcp, { session: store.create({ cwd }), foreground: () => true }));
  const reset = () => {
    events = [];
    state.requests.length = 0;
    state.replies.length = 0;
  };
  const streams = () => state.requests.filter((r) => r.url === '/v1/chat/completions' && r.payload.stream);
  const names = (req) => (req?.payload.tools ?? []).map((t) => t.function.name);
  const system = (req) => String(req?.payload.messages?.[0]?.content ?? '');
  const loadTool = (req) => req?.payload.tools?.find((t) => t.function.name === 'load_tools')?.function;
  const toolMsgs = (req) => (req?.payload.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content));
  const mcpNames = (req, server) => names(req).filter((n) => n.startsWith(`mcp__${server ?? ''}`));
  let n = 0;
  const call = (name, args) => ({ id: `m${++n}`, name, args });

  // ---- A: a fresh session ----
  reset();
  fresh();
  state.replies.push({ content: 'hi' });
  await agent.run('hello');
  let req = streams()[0];
  const sys = system(req);
  check('A: no MCP tool definition is sent', mcpNames(req).length === 0 && names(req).includes('load_tools'), names(req));
  check('A: load_tools takes the connected servers and says how in one line', same(loadTool(req).parameters.properties.groups.items.enum.filter((g) => g.startsWith('mcp:')), ['mcp:test', 'mcp:other', 'mcp:odd_name-x']) && loadTool(req).description.includes(`- ${G.MCP_GROUP_LINE}`), loadTool(req).parameters.properties.groups.items.enum);
  check('A: the prompt names each server, its tool count and tool names, and says to load it first', /Load a server's tools with load_tools/.test(sys) && /^- mcp:test \(8 tools\): echo, add, remove_item, picture, fail, slow, env, cwd$/m.test(sys) && /^- mcp:other \(8 tools\): /m.test(sys), sys.slice(sys.indexOf('MCP servers')));
  check('A: …without the tools\' descriptions (they come with a load)', !/Echoes text back|Adds two numbers/.test(sys));
  check('A: an off server and an untrusted project server are not in the prompt nor loadable', !/mcp:spare|mcp:proj/.test(sys) && !loadTool(req).parameters.properties.groups.items.enum.some((g) => g === 'mcp:spare' || g === 'mcp:proj'));
  check('A: a server\'s name is lower case and sanitised in its group', /^- mcp:odd_name-x \(8 tools\)/m.test(sys) && !/Odd\.Name/.test(sys));
  check('A: no secret in the request', !JSON.stringify(req.payload).includes(SECRET));
  const firstTools = req.payload.tools;
  const firstSystem = sys;

  // ---- B: load_tools loads a server: its tools at the end, nothing else changes ----
  reset();
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['mcp:test'] })] });
  state.replies.push({ content: 'loaded' });
  await agent.run('load it');
  let [b1, b2] = streams();
  const loadResult = toolMsgs(b2).pop();
  check('B: the load answers with the server\'s tool names', /^Loaded mcp:test: mcp__test__echo, mcp__test__add, mcp__test__remove_item, mcp__test__picture, mcp__test__fail, mcp__test__slow, mcp__test__env, mcp__test__cwd\.$/.test(loadResult), loadResult);
  check('B: the next request adds that server\'s tools at the end, and only that server\'s', mcpNames(b2).length === 8 && mcpNames(b2, 'other').length === 0 && same(b2.payload.tools.slice(0, firstTools.length), firstTools) && names(b2).slice(firstTools.length).every((x) => x.startsWith('mcp__test__')), names(b2).slice(firstTools.length));
  check('B: the system prompt and load_tools did not change', system(b1) === firstSystem && system(b2) === firstSystem && same(loadTool(b2), loadTool({ payload: { tools: firstTools } })));
  check('B: the session keeps it', same(agent.session.toolGroups, ['mcp:test']));
  reset();
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['other', 'mcp:spare', 'mcp:proj'] })] });
  state.replies.push({ content: 'ok' });
  await agent.run('load more');
  const mixed = toolMsgs(streams()[1]).pop();
  check('B: a bare server name loads it; an off or untrusted server gets a plain error line', /^Loaded mcp:other: mcp__other__echo/.test(mixed) && /\n\nmcp:spare is not an MCP server with tools to load here\.\n\nmcp:proj is not an MCP server with tools to load here\.$/.test(mixed), mixed);
  check('B: …and other loads it, not test again', same(agent.session.toolGroups, ['mcp:test', 'mcp:other']));
  reset();
  fresh();
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['mcp:spare'] })] });
  state.replies.push({ content: 'ok' });
  await agent.run('load spare');
  check('B: a load of only an off server is an error', toolMsgs(streams()[1]).pop() === 'Error: mcp:spare is not an MCP server with tools to load here.', toolMsgs(streams()[1]));

  // ---- C: a call by name loads its server, and asks for approval exactly as with every tool up front ----
  const approvalsFor = async (toolSet) => {
    reset();
    config = { ...config, toolSet };
    fresh();
    policy = () => [true, true]; // Allow, for this session (per server)
    state.replies.push({ toolCalls: [call('mcp__test__add', { a: 2, b: 3 })] });
    state.replies.push({ toolCalls: [call('mcp__test__remove_item', { id: 'x1' })] });
    state.replies.push({ toolCalls: [call('mcp__other__add', { a: 1, b: 1 })] });
    state.replies.push({ content: 'done' });
    await agent.run('add things');
    policy = null;
    const cards = events.filter((e) => e.type === 'approval_request').map(({ id, callId, ...rest }) => rest);
    const ends = events.filter((e) => e.type === 'tool_end').map((e) => [e.name, String(e.result ?? e.content ?? '').slice(0, 20)]);
    return { cards, ends, groups: agent.session.toolGroups, reqs: streams() };
  };
  const lazy = await approvalsFor('auto');
  const all = await approvalsFor('all');
  config = { ...config, toolSet: 'auto' };
  check('C: the same approval cards as with every tool up front', lazy.cards.length === 2 && same(lazy.cards, all.cards), { lazy: lazy.cards, all: all.cards });
  check('C: …the per-server "for this session" still covers the server\'s next tool, and not another server', lazy.cards[0].name === 'mcp__test__add' && lazy.cards[1].name === 'mcp__other__add');
  check('C: the calls ran the same', same(lazy.ends, all.ends) && lazy.ends.length === 3, lazy.ends);
  check('C: each call by name loaded its own server only', same(lazy.groups, ['mcp:test', 'mcp:other']), lazy.groups);
  check('C: with every tool up front, MCP tools are in the first request', mcpNames(all.reqs[0]).length >= 24 && !names(all.reqs[0]).includes('load_tools'));
  const denied = async () => {
    reset();
    fresh();
    policy = () => [false, false];
    state.replies.push({ toolCalls: [call('mcp__test__remove_item', { id: 'x2' })] });
    state.replies.push({ content: 'ok' });
    await agent.run('remove it');
    policy = null;
    return toolMsgs(streams()[1]);
  };
  const deniedMsgs = await denied();
  check('C: a denied call after an implied load is still denied', deniedMsgs.some((m) => /^Loaded mcp:test:/.test(m)) && !deniedMsgs.some((m) => /removed x2/.test(m)) && events.filter((e) => e.type === 'approval_request').length === 1, deniedMsgs);

  // ---- D: a user message that names the server loads it before the first request ----
  reset();
  fresh();
  state.replies.push({ content: 'ok' });
  await agent.run('What can the test server do?');
  req = streams()[0];
  check('D: the first request already has that server\'s tools, not the others\'', mcpNames(req, 'test').length === 8 && mcpNames(req, 'other').length === 0 && /^Loaded mcp:test:/.test(toolMsgs(req).pop() ?? ''), names(req).slice(-9));
  check('D: …and the system prompt is the one every session starts with', system(req) === firstSystem);

  // ---- E: plan mode offers only the read-only tools ----
  reset();
  config = { ...config, permissionMode: 'plan' };
  fresh();
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['mcp:test'] })] });
  state.replies.push({ content: 'ok' });
  await agent.run('plan with it');
  const planReq = streams()[1];
  check('E: plan mode: only the read-only tools load', same(mcpNames(planReq), ['mcp__test__echo', 'mcp__test__picture', 'mcp__test__fail', 'mcp__test__slow', 'mcp__test__env', 'mcp__test__cwd']), mcpNames(planReq));
  config = { ...config, permissionMode: 'ask' };

  // ---- F: compaction keeps a loaded server ----
  reset();
  fresh();
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['mcp:test'] })] });
  state.replies.push({ content: 'ok ' + 'Some long findings. '.repeat(300) });
  await agent.run('load test');
  state.summary = '## 1. Request and intent\nTools.\n\n## 6. Pending work\nNone.';
  const compacted = await agent.compactNow();
  const brief = String(agent.session.messages[0].content);
  reset();
  state.replies.push({ content: 'after' });
  await agent.run('And now?');
  check('F: the brief says the server was loaded, and its tools are still sent', compacted.ok && /Loaded mcp:test: mcp__test__echo/.test(brief) && mcpNames(streams()[0], 'test').length === 8 && same(agent.session.toolGroups, ['mcp:test']), { compacted, brief: brief.slice(0, 300) });

  // ---- G: a server that drops mid-session: its tools go, the load stays; back on, they come back ----
  await mcp.setEnabled('test', 'user', false);
  reset();
  state.replies.push({ content: 'x' });
  await agent.run('still?');
  const offReq = streams()[0];
  check('G: an off server: its tools and its prompt line go', mcpNames(offReq, 'test').length === 0 && !/mcp:test/.test(system(offReq)));
  await mcp.setEnabled('test', 'user', true);
  reset();
  state.replies.push({ content: 'y' });
  await agent.run('back?');
  check('G: back on, the session still has it loaded', mcpNames(streams()[0], 'test').length === 8);

  // ---- H: Anthropic's native path: deferred from the first request, a load references them ----
  state.apiKey = 'k-test-native';
  config = {
    ...config,
    provider: 'claude',
    providers: { claude: { type: 'anthropic', baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'k-test-native', model: 'claude-haiku-5-5' } },
  };
  reset();
  fresh();
  state.replies.push({ content: 'hi' });
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['mcp:test'] })] });
  state.replies.push({ content: 'loaded' });
  await agent.run('hello');
  await agent.run('load it');
  const nat = state.requests.filter((r) => r.url.startsWith('/v1/messages') && r.payload.stream).map((r) => r.payload);
  const strip = (x) => JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v));
  const mcpDefs = nat[0].tools.filter((t) => t.name.startsWith('mcp__'));
  check('H: native: the MCP tools are in the first request, every one deferred', mcpDefs.length === 24 && mcpDefs.every((t) => t.defer_loading === true), mcpDefs.length);
  check('H: native: the tools and the system prompt are the same bytes before and after the load', nat.length === 3 && strip(nat[0].tools) === strip(nat[2].tools) && strip(nat[0].system) === strip(nat[2].system));
  const refBlock = nat[2].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c) => c.type === 'tool_reference'));
  check('H: native: the load answers with tool_reference blocks for that server\'s tools only', refBlock && same(refBlock.content.map((c) => c.tool_name), ['mcp__test__echo', 'mcp__test__add', 'mcp__test__remove_item', 'mcp__test__picture', 'mcp__test__fail', 'mcp__test__slow', 'mcp__test__env', 'mcp__test__cwd']), refBlock?.content);
  check('H: no secret in any request', !state.requests.some((r) => JSON.stringify(r.payload ?? '').includes(SECRET)));

  await mcp.closeAll?.();
  await mcp.shutdown?.();
  mock.close?.();
  done();
})().catch((err) => {
  console.error('TEST CRASHED', err);
  process.exit(1);
});
