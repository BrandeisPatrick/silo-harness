// The fixed part of a request with one MCP server connected, by the app's own estimate (compact.ts: about four
// characters per token, the tool definitions as JSON): what a fresh session's first request sends, and what a request
// sends once the server is loaded. Mock model, no key, no window: the agent runs in Node on a throwaway folder, with
// the test MCP server (test/support/test-mcp-server.js) and its twenty tools (OC_TEST_BENCH).
//   npm run build
//   node scripts/mcp-token-bench.js [--project <a built checkout>] [--out <file.json>]
// --project measures another build (for a before/after); the default is this checkout. docs/token-bench.md has the result.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const here = path.join(__dirname, '..');
const projectDir = path.resolve(arg('project') ?? here);
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const { McpManager } = dist('mcp.js');
const { estimateSpecTokens } = dist('compact.js');
const { startMock } = require(path.join(here, 'test/support/mock-model.js'));
const TEST_SERVER = path.join(here, 'test/support/test-mcp-server.js');

const chars = (t) => (t ? Math.ceil(t.length / 4) : 0);

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mcp-bench-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd);
  const base = {
    ollama: { baseURL: 'http://127.0.0.1:1', model: 'm', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: cwd, permissionMode: 'ask', autoApprove: false, maxTurns: 6, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: { tracker: { command: 'node', args: [TEST_SERVER], env: { OC_PROJECT: here, OC_TEST_BENCH: '1' } } },
    mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, toolSet: 'auto',
  };
  let config = { ...base, provider: 'portkey' };
  const mcp = new McpManager({ getConfig: () => config, saveConfig: (p) => (config = { ...config, ...p }), cwd: () => cwd });
  await mcp.reload();
  const toolCount = mcp.tools().length;
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const fresh = () => new Agent(() => config, { navigate: async () => '' }, store, () => [], () => {}, undefined, undefined, mcp, { session: store.create({ cwd }), foreground: () => true });
  const measure = (payload) => {
    const tools = payload.tools ?? [];
    const isMcp = (t) => (t.function?.name ?? t.name ?? '').startsWith('mcp__');
    const sys = Array.isArray(payload.system) ? payload.system.map((b) => b.text).join('') : String(payload.messages?.[0]?.content ?? '');
    const mcpSpecs = tools.filter(isMcp);
    const deferred = tools.filter((t) => t.defer_loading);
    const mcpSection = sys.slice(Math.max(0, sys.indexOf('\n\nMCP servers provide')));
    return {
      toolsSent: tools.length,
      mcpToolsSent: mcpSpecs.length,
      toolTokens: estimateSpecTokens(tools.filter((t) => !t.defer_loading)),
      mcpToolTokens: estimateSpecTokens(mcpSpecs.filter((t) => !t.defer_loading)),
      deferredTokens: estimateSpecTokens(deferred),
      systemTokens: chars(sys),
      mcpPromptTokens: sys.includes('MCP servers provide') ? chars(mcpSection) : 0,
      fixedTokens: estimateSpecTokens(tools.filter((t) => !t.defer_loading)) + chars(sys),
    };
  };
  const streams = (native) => state.requests.filter((r) => (native ? r.url.startsWith('/v1/messages') : r.url === '/v1/chat/completions') && r.payload.stream).map((r) => r.payload);
  const out = { build: projectDir, server: { name: 'tracker', tools: toolCount }, model: 'mock (test/support/mock-model.js)', estimate: 'app estimate: ceil(chars / 4); tool definitions as JSON (compact.ts estimateSpecTokens)' };

  // OpenAI-shaped path (every provider but Anthropic's own API)
  state.requests.length = 0;
  state.replies.push({ content: 'hi' });
  const a = fresh();
  await a.run('hello');
  out.first = measure(streams(false)[0]);
  if (out.first.mcpToolsSent === 0) {
    state.requests.length = 0;
    state.replies.push({ toolCalls: [{ id: 'b1', name: 'load_tools', args: { groups: ['mcp:tracker'] } }] }, { content: 'ok' });
    await a.run('load it');
    out.loaded = measure(streams(false)[1]);
  }

  // Anthropic's native path: what the model's context holds (deferred definitions are in the request, not in context)
  state.apiKey = 'k-bench';
  config = { ...base, provider: 'claude', providers: { claude: { type: 'anthropic', baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'k-bench', model: 'claude-haiku-5-5' } } };
  state.requests.length = 0;
  state.replies.push({ content: 'hi' });
  await fresh().run('hello');
  out.nativeFirst = measure(streams(true)[0]);

  console.log(JSON.stringify(out, null, 2));
  const file = arg('out');
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  await mcp.close();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
