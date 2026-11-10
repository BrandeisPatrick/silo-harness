// Cache counts in usage (agent/complete.ts usageOf): every spelling providers and gateways use, the prompt still the
// whole input, the counts carried in the usage event, the history log and the context breakdown, and nothing when
// the provider reports none.
// Run: node test/cache-usage.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const { usageOf, mergeUsage } = dist('agent/complete.js');
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

(async () => {
  // ---- 1: the spellings (pure) ----
  const cases = [
    ['OpenAI: cached_tokens', { prompt_tokens: 2000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 1536 } }, { promptTokens: 2000, completionTokens: 10, cacheReadTokens: 1536 }],
    ['OpenRouter: cached and written', { prompt_tokens: 5000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4800 } }, { promptTokens: 5000, completionTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 4800 }],
    ['LiteLLM / Portkey: Anthropic spellings', { prompt_tokens: 9000, completion_tokens: 7, cache_read_input_tokens: 8000, cache_creation_input_tokens: 900 }, { promptTokens: 9000, completionTokens: 7, cacheReadTokens: 8000, cacheWriteTokens: 900 }],
    ['a gateway that counts only the uncached input as prompt_tokens', { prompt_tokens: 40, completion_tokens: 7, cache_read_input_tokens: 8000, cache_creation_input_tokens: 900 }, { promptTokens: 8940, completionTokens: 7, cacheReadTokens: 8000, cacheWriteTokens: 900 }],
    ["Anthropic's OpenAI-compatible endpoint: details empty", { prompt_tokens: 3000, completion_tokens: 9, prompt_tokens_details: {} }, { promptTokens: 3000, completionTokens: 9 }],
    ['no details at all', { prompt_tokens: 3000, completion_tokens: 9 }, { promptTokens: 3000, completionTokens: 9 }],
    ['details null', { prompt_tokens: 3000, completion_tokens: 9, prompt_tokens_details: null }, { promptTokens: 3000, completionTokens: 9 }],
  ];
  for (const [label, raw, want] of cases) check(`1: ${label}`, JSON.stringify(usageOf(raw)) === JSON.stringify(want), usageOf(raw));
  const merged = mergeUsage(mergeUsage(null, { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 80 } }), { prompt_tokens: 100, completion_tokens: 12 });
  check('1: counts split across chunks are merged (a later chunk without them keeps them)', merged.promptTokens === 100 && merged.completionTokens === 12 && merged.cacheReadTokens === 80 && !('cacheWriteTokens' in merged), merged);

  // ---- 2: through a run ----
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-cache-usage-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const config = {
    provider: 'portkey',
    ollama: { baseURL: 'http://127.0.0.1:1', model: 'mock', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: tmp, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {},
  };
  const store = new SessionStore(path.join(tmp, 'sessions'));
  let events = [];
  const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], (ev) => events.push(ev));
  state.replies.push({ content: 'cached', usage: { prompt_tokens: 4000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 3000, cache_write_tokens: 500 } } });
  await agent.run('hello');
  const u = events.find((e) => e.type === 'usage');
  check('2: the usage event carries the cache counts', u && u.promptTokens === 4000 && u.cacheReadTokens === 3000 && u.cacheWriteTokens === 500, u);
  const bd = agent.contextBreakdown();
  check('2: the breakdown says what share of the last request was read from the cache', bd.basis === 'reported' && Math.abs(bd.cached - 3000 / 4020) < 0.001, bd.cached);
  events = [];
  state.replies.push({ content: 'plain', usage: { prompt_tokens: 4100, completion_tokens: 20 } });
  await agent.run('again');
  const u2 = events.find((e) => e.type === 'usage');
  check('2: no cache fields from the provider: none in the event', u2 && !('cacheReadTokens' in u2) && !('cacheWriteTokens' in u2), u2);
  check('2: …and none in the breakdown', !('cached' in agent.contextBreakdown()));

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
