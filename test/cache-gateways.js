// Prompt caching on the OpenAI-shaped path (src/main/agent/gateway-cache.ts): which provider gets which fields, the
// exact request bodies through the agent for OpenRouter, Portkey, a LiteLLM-like gateway and OpenAI, nothing extra for
// other endpoints, and the fallback: a gateway that refuses the fields gets the request again without them, and
// never again while the app runs.
// Run: node test/cache-gateways.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const G = dist('agent/gateway-cache.js');
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  // ---- 1: which shape (pure) ----
  const shapes = [
    [{ type: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' }, 'anthropic/claude-sonnet-5.5', 'openrouter'],
    [{ type: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1' }, 'anthropic/claude-haiku-5.5', 'openrouter'],
    [{ type: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' }, 'openai/gpt-5.6', 'sticky'],
    [{ type: 'portkey', baseURL: 'https://api.portkey.ai/v1' }, '@anthropic/claude-haiku-5-5', 'portkey'],
    [{ type: 'openai-compatible', baseURL: 'https://ai-gateway.vercel.sh/v1' }, 'anthropic/claude-sonnet-5.5', 'vercel'],
    [{ type: 'openai-compatible', baseURL: 'http://localhost:4000/v1' }, 'claude-haiku-5-5', 'parts'],
    [{ type: 'portkey', baseURL: 'http://my-litellm:4000/v1' }, 'claude-haiku-5-5', 'parts'],
    [{ type: 'openai', baseURL: 'https://api.openai.com/v1' }, 'gpt-5.6', 'openai'],
    [{ type: 'openai-compatible', baseURL: 'https://api.openai.com/v1' }, 'gpt-5.6', 'openai'],
    [{ type: 'openai-compatible', baseURL: 'http://localhost:4000/v1' }, 'qwen3:8b', null],
    [{ type: 'groq', baseURL: 'https://api.groq.com/openai/v1' }, 'llama-4', null],
    [{ type: 'deepseek', baseURL: 'https://api.deepseek.com' }, 'deepseek-chat', null],
    [{ type: 'lmstudio', baseURL: 'http://localhost:1234/v1' }, 'claude-distill', null],
  ];
  for (const [r, model, want] of shapes) check(`1: ${r.type} at ${r.baseURL} with ${model}: ${want}`, G.cacheShape(r, model) === want, G.cacheShape(r, model));

  // ---- 2: the exact bodies through the agent ----
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-gateways-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'hello');
  const base = `http://127.0.0.1:${mock.port}/v1`;
  let config = {
    provider: 'gw',
    providers: {},
    ollama: { baseURL: 'http://127.0.0.1:1', model: 'm', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: base, apiKey: 'k', model: 'claude-haiku-5-5', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: tmp, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {},
  };
  const store = new SessionStore(path.join(tmp, 'sessions'));
  let events = [];
  const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], (ev) => events.push(ev));
  const streams = () => state.requests.filter((r) => r.url === '/v1/chat/completions' && r.payload.stream).map((r) => r.payload);
  const reset = () => {
    events = [];
    state.requests.length = 0;
    state.replies.length = 0;
  };
  /** A tool loop of two calls: the second request's newest message is a tool result */
  const toolLoop = async (text) => {
    state.replies.push({ content: '', toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name: 'read_file', args: { path: 'notes.txt' } }] });
    state.replies.push({ content: 'It says hello.' });
    await agent.run(text);
    return streams();
  };
  const use = (entry) => {
    config = { ...config, provider: 'gw', providers: { gw: { apiKey: 'k', baseURL: base, ...entry } } };
    agent.session = store.create();
    reset();
  };

  // OpenRouter with Claude: the top-level automatic mark, the system prompt's hour, the session id
  use({ type: 'openrouter', model: 'anthropic/claude-haiku-5.5' });
  let [q1, q2] = await toolLoop('Read notes.txt [or]');
  check('2: OpenRouter: the top-level automatic mark and the session id on every request', same(q1.cache_control, { type: 'ephemeral' }) && q1.session_id === agent.session.id && q2.session_id === agent.session.id);
  check('2: OpenRouter: the system prompt as one part with an hour\'s mark', Array.isArray(q2.messages[0].content) && q2.messages[0].content.length === 1 && same(q2.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' }));
  check('2: OpenRouter: no marks on the messages or tools (the automatic mark follows the tool loop)', !JSON.stringify(q2.messages.slice(1)).includes('cache_control') && !JSON.stringify(q2.tools).includes('cache_control') && q2.messages[q2.messages.length - 1].role === 'tool');
  // OpenRouter, another model: the session id only
  use({ type: 'openrouter', model: 'openai/gpt-5.6' });
  [q1] = await toolLoop('Read [or2]');
  check('2: OpenRouter, not Claude: the session id and nothing else', q1.session_id === agent.session.id && !JSON.stringify(q1).includes('cache_control'));

  // Portkey (recognised by its host, so checked on the fields alone): parts on the system prompt and the newest
  // message, and the last tool
  const { cacheFields } = G;
  const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't', content: 'out' }];
  const tools = [{ type: 'function', function: { name: 'a' } }, { type: 'function', function: { name: 'f' } }];
  const pk = cacheFields('portkey', msgs, tools, 'sid');
  check('2: Portkey: the system prompt and the newest message (a tool result) marked on their last part', same(pk.messages[0].content, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]) && same(pk.messages[3].content, [{ type: 'text', text: 'out', cache_control: { type: 'ephemeral' } }]) && pk.messages[1].content === 'go');
  check('2: Portkey: the last tool marked, the others as they were', same(pk.tools[1].cache_control, { type: 'ephemeral' }) && !('cache_control' in pk.tools[0]) && same(pk.extra, {}));
  check('2: the history passed in is not changed', msgs[0].content === 'SYS' && msgs[3].content === 'out' && !('cache_control' in tools[1]));
  const vc = cacheFields('vercel', msgs, tools, 'sid');
  check('2: Vercel: message-level marks on the system prompt and the newest message', same(vc.messages[0].cache_control, { type: 'ephemeral' }) && same(vc.messages[3].cache_control, { type: 'ephemeral' }) && vc.messages[3].content === 'out' && !JSON.stringify(vc.tools).includes('cache_control'));
  const withImage = cacheFields('parts', [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }], [], '');
  check('2: a newest message with parts: the mark on its last part', same(withImage.messages[0].content[1].cache_control, { type: 'ephemeral' }) && !('cache_control' in withImage.messages[0].content[0]));

  // A LiteLLM-like gateway (an OpenAI-compatible entry) with Claude, through the agent
  use({ type: 'openai-compatible', model: 'claude-haiku-5-5' });
  [q1, q2] = await toolLoop('Read [litellm]');
  check('2: LiteLLM-like: system and newest message marked on their last part, nothing at the top level', same(q2.messages[0].content[0].cache_control, { type: 'ephemeral' }) && q2.messages[q2.messages.length - 1].role === 'tool' && same(q2.messages[q2.messages.length - 1].content[0].cache_control, { type: 'ephemeral' }) && !('cache_control' in q2) && !('session_id' in q2));
  check('2: …and the earlier messages as stored (the mark moves with the newest)', q2.messages.slice(1, -1).every((m) => !JSON.stringify(m).includes('cache_control')) && typeof q2.messages[1].content === 'string');

  // OpenAI: prompt_cache_key, nothing else
  use({ type: 'openai-compatible', model: 'gpt-5.6', baseURL: base });
  [q1] = await toolLoop('Read [plain]');
  check('2: another OpenAI-compatible endpoint, not Claude: no extra field at all', !('prompt_cache_key' in q1) && !('session_id' in q1) && !JSON.stringify(q1).includes('cache_control'));
  check('2: OpenAI: prompt_cache_key is the session id (pure)', same(cacheFields('openai', msgs, tools, 'sid-1').extra, { prompt_cache_key: 'sid-1' }) && cacheFields('openai', msgs, tools, 'sid-1').messages === msgs);

  // ---- 3: the fallback ----
  use({ type: 'openai-compatible', model: 'claude-haiku-5-5' });
  state.rejectCacheFields = 400;
  [q1, q2] = (await toolLoop('Read [refused]'));
  const all = streams();
  check('3: a gateway that refuses the fields: the same request again without them, and the run goes on', all.length === 3 && JSON.stringify(all[0]).includes('cache_control') && !JSON.stringify(all[1]).includes('cache_control') && !JSON.stringify(all[2]).includes('cache_control') && events.find((e) => e.type === 'run_end')?.reason === 'done', all.length);
  check('3: no error reached the user', !events.some((e) => e.type === 'error'));
  reset();
  state.replies.push({ content: 'still fine' });
  await agent.run('Again [refused]');
  check('3: …and that gateway gets no fields again (one request, none)', streams().length === 1 && !JSON.stringify(streams()[0]).includes('cache_control'));
  // 422 too, on another gateway (another base URL: the mock under a second address)
  const mock2 = await startMock();
  mock2.state.rejectCacheFields = 422;
  config = { ...config, providers: { gw: { type: 'openrouter', apiKey: 'k', baseURL: `http://127.0.0.1:${mock2.port}/v1`, model: 'anthropic/claude-haiku-5.5' } } };
  mock2.state.replies.push({ content: 'ok' });
  events = [];
  await agent.run('Hi [422]');
  const r2 = mock2.state.requests.filter((r) => r.url === '/v1/chat/completions');
  check('3: a 422 is handled the same way', r2.length === 2 && 'session_id' in r2[0].payload && !('session_id' in r2[1].payload) && events.find((e) => e.type === 'run_end')?.reason === 'done');
  state.rejectCacheFields = false;
  mock2.close();
  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
