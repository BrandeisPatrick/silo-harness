// Reasoning effort (src/main/agent/effort.ts): what each model family is sent for each level (clamped, "not chosen"
// sends nothing, thinking turned on where off is refused), the OpenAI-compatible fields per service type, the entry
// field's checks, the pill's info, and through the agent and the mock: the level read at each request (a change during
// a run applies to the next request), a refused field sent again without it and noticed once, and the calls that do
// not take it (Auto mode's check, compaction, titles).
// Run: node test/effort.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const E = dist('agent/effort.js');
const A = dist('agent/anthropic.js');
const P = dist('providers.js');
const PP = dist('provider-presets.js');
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const { startMock, classifierReply } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sent = (model, level) => {
  const r = A.nativeRequest(model, [{ role: 'user', content: 'hi' }], [], 1000, 0, level);
  return { thinking: r.thinking, effort: r.output_config?.effort };
};
const ADAPTIVE = { type: 'adaptive', display: 'summarized' };

(async () => {
  // ---------- 1: the native table: model × level → thinking and output_config.effort ----------
  // [model, chosen level, thinking sent, effort sent]
  const table = [
    // not chosen: nothing, thinking as before
    ['claude-haiku-5-5', undefined, { type: 'disabled' }, undefined],
    ['claude-opus-5-5', undefined, ADAPTIVE, undefined],
    ['claude-sonnet-5-5', undefined, { type: 'between_tools' }, undefined],
    ['claude-opus-4-8', undefined, undefined, undefined],
    // Haiku 5.5 / Opus 5 / Sonnet 5: thinking stays off up to high, adaptive at xhigh and max
    ['claude-haiku-5-5', 'low', { type: 'disabled' }, 'low'],
    ['claude-haiku-5-5', 'high', { type: 'disabled' }, 'high'],
    ['claude-haiku-5-5', 'xhigh', ADAPTIVE, 'xhigh'],
    ['claude-haiku-5-5', 'max', ADAPTIVE, 'max'],
    ['claude-opus-5', 'medium', { type: 'disabled' }, 'medium'],
    ['claude-opus-5', 'max', ADAPTIVE, 'max'],
    ['claude-sonnet-5', 'high', { type: 'disabled' }, 'high'],
    ['claude-sonnet-5', 'xhigh', ADAPTIVE, 'xhigh'],
    // Sonnet 5.5: between_tools up to high, adaptive above
    ['claude-sonnet-5-5', 'medium', { type: 'between_tools' }, 'medium'],
    ['claude-sonnet-5-5', 'xhigh', ADAPTIVE, 'xhigh'],
    // Always thinking: unchanged thinking, the level as chosen
    ['claude-opus-5-5', 'low', ADAPTIVE, 'low'],
    ['claude-opus-5-5', 'max', ADAPTIVE, 'max'],
    ['claude-fable-5-1', 'xhigh', ADAPTIVE, 'xhigh'],
    ['claude-mythos-5', 'medium', ADAPTIVE, 'medium'],
    // Claude 4.6-4.8: no thinking field, the effort alone; 4.6 has no xhigh (runs as high)
    ['claude-opus-4-8', 'xhigh', undefined, 'xhigh'],
    ['claude-opus-4-7', 'max', undefined, 'max'],
    ['claude-opus-4-6', 'xhigh', undefined, 'high'],
    ['claude-sonnet-4-6', 'xhigh', undefined, 'high'],
    ['claude-sonnet-4-6', 'max', undefined, 'max'],
    // No effort setting: nothing sent whatever was chosen
    ['claude-haiku-4-5', 'high', undefined, undefined],
    ['claude-haiku-4-5-20251001', 'high', undefined, undefined],
    ['claude-sonnet-4-5', 'low', undefined, undefined],
    ['claude-opus-4-5-20251101', 'low', undefined, undefined],
    ['claude-3-7-sonnet-20250219', 'low', undefined, undefined],
    ['some-other-model', 'high', ADAPTIVE, undefined],
  ];
  for (const [model, level, thinking, effort] of table) {
    const got = sent(model, level);
    check(`1: ${model} at ${level ?? 'not chosen'}: thinking ${JSON.stringify(thinking) ?? 'none'}, effort ${effort ?? 'none'}`, same(got.thinking, thinking) && got.effort === effort, got);
  }
  check('1: not chosen sends no output_config at all', !('output_config' in A.nativeRequest('claude-opus-5-5', [{ role: 'user', content: 'hi' }], [], 1000)));

  // ---------- 2: levels and defaults per family ----------
  const fam = (m) => {
    const n = E.nativeEffort(m);
    return n && `${n.levels.join(',')}|${n.default}`;
  };
  const ALL = 'low,medium,high,xhigh,max';
  check('2: Opus 5.5 and Haiku 5.5 default to medium, all five levels', fam('claude-opus-5-5') === `${ALL}|medium` && fam('claude-haiku-5-5') === `${ALL}|medium`);
  check('2: Opus 5, 4.8, 4.7, Sonnet 5.5, Sonnet 5, Fable, Mythos: all five, default high', ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5-1'].every((m) => fam(m) === `${ALL}|high`));
  check('2: Opus 4.6 and Sonnet 4.6: no xhigh, default high', fam('claude-opus-4-6') === 'low,medium,high,max|high' && fam('claude-sonnet-4-6') === 'low,medium,high,max|high');
  check('2: a gateway prefix still finds the model', fam('us.anthropic.claude-opus-5-5') === `${ALL}|medium`);
  check('2: clamping goes to the nearest, the lower of two', E.clampEffort('xhigh', ['low', 'medium', 'high', 'max']) === 'high' && E.clampEffort('max', ['low', 'medium', 'high']) === 'high' && E.clampEffort('low', ['high', 'max']) === 'high');

  // ---------- 3: the OpenAI-compatible fields per service type ----------
  check('3: OpenRouter: reasoning.effort', same(E.compatEffortFields('openrouter', 'low'), { reasoning: { effort: 'low' } }));
  for (const t of ['openai', 'groq', 'deepseek', 'together', 'portkey', 'openai-compatible']) check(`3: ${t}: reasoning_effort`, same(E.compatEffortFields(t, 'medium'), { reasoning_effort: 'medium' }));
  check('3: xhigh and max are sent as high there', same(E.compatEffortFields('openai', 'max'), { reasoning_effort: 'high' }) && same(E.compatEffortFields('openai', 'xhigh'), { reasoning_effort: 'high' }));
  check('3: LM Studio and Ollama: nothing', same(E.compatEffortFields('lmstudio', 'high'), {}) && same(E.compatEffortFields('ollama', 'high'), {}));
  check('3: not chosen: nothing', same(E.compatEffortFields('openai', undefined), {}));

  // ---------- 4: the entry field and the pill's info ----------
  const v = (name, raw) => PP.validateProviderEntry(name, raw, { scope: 'user' });
  check('4: effort is a field of an entry', v('a', { type: 'anthropic', effort: 'xhigh' }).entry?.effort === 'xhigh' && !v('a', { type: 'anthropic', effort: 'xhigh' }).problems.length);
  const bad = v('b', { type: 'openai', effort: 'extreme' });
  check('4: an unknown level is dropped with a problem', bad.entry && bad.entry.effort === undefined && bad.problems.some((p) => p.key === 'providers.b.effort'), bad.problems);
  const ol = v('c', { type: 'ollama', effort: 'high' });
  check('4: not for ollama or lmstudio entries', ol.problems.some((p) => /only for type/.test(p.message)) && v('d', { type: 'lmstudio', effort: 'low' }).problems.length === 1);
  const base = { provider: 'x', ollama: { baseURL: 'http://127.0.0.1:1', model: 'm', numCtx: 4096, think: 'auto' }, portkey: { baseURL: '', apiKey: '', model: '', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 1 } };
  const view = (entry) => P.providersView({ ...base, providers: { x: entry } }, {}, {}).active.effort;
  check('4: the pill: Opus 5.5 not chosen shows its default', same(view({ type: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5' }), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], chosen: null, default: 'medium' }));
  check('4: the pill: a chosen level is clamped to the model\'s', same(view({ type: 'anthropic', apiKey: 'k', model: 'claude-opus-4-6', effort: 'xhigh' }), { levels: ['low', 'medium', 'high', 'max'], chosen: 'high', default: 'high' }));
  check('4: the pill: hidden for a model without effort', view({ type: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5' }) === undefined);
  check('4: the pill: OpenAI-compatible: Low, Medium, High, the default unknown', same(view({ type: 'openrouter', apiKey: 'k', model: 'some/model', effort: 'max' }), { levels: ['low', 'medium', 'high'], chosen: 'high', default: null }));
  check('4: the pill: hidden for LM Studio, an Ollama entry and the built-in blocks', view({ type: 'lmstudio', model: 'm' }) === undefined && view({ type: 'ollama', model: 'm' }) === undefined && P.providersView({ ...base, provider: 'ollama', providers: {} }, {}, {}).active.effort === undefined && P.providersView({ ...base, provider: 'portkey', providers: {} }, {}, {}).active.effort === undefined);
  check('4: the pill: an openai-compatible entry on api.anthropic.com is the native path', view({ type: 'openai-compatible', baseURL: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5' })?.default === 'medium');

  // ---------- 5: through the agent, the native path ----------
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-effort-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'hello');
  const entry = { type: 'anthropic', baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'sk-test-effort', model: 'claude-haiku-5-5', effort: 'low' };
  let config = {
    ...base,
    provider: 'claude',
    providers: { claude: entry },
    workingDirectory: tmp, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: true, notifications: false, allowRules: {},
  };
  const setEffort = (level) => {
    const { effort: _e, ...rest } = config.providers.claude;
    config = { ...config, providers: { claude: level ? { ...rest, effort: level } : rest } };
  };
  const store = new SessionStore(path.join(tmp, 'sessions'));
  let events = [];
  const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], (ev) => events.push(ev));
  const native = () => state.requests.filter((r) => r.url.startsWith('/v1/messages'));
  const reset = () => {
    events = [];
    state.requests.length = 0;
    state.replies.length = 0;
  };
  // The first reply asks for a tool; while the tool runs the level changes: the second request carries the new one
  state.replies.push({ content: 'Reading.', toolCalls: [{ id: 'toolu_1', name: 'read_file', args: { path: 'notes.txt' } }], when: () => (setEffort('xhigh'), true) });
  state.replies.push({ content: 'It says hello.' });
  await agent.run('What does notes.txt say?');
  let reqs = native();
  check('5: the first request carries the chosen level, thinking still off', reqs[0]?.payload.output_config?.effort === 'low' && same(reqs[0].payload.thinking, { type: 'disabled' }), reqs[0]?.payload.output_config);
  check('5: a change during the run applies to the next request (xhigh, with adaptive thinking)', reqs[1]?.payload.output_config?.effort === 'xhigh' && same(reqs[1].payload.thinking, ADAPTIVE), reqs[1] && { e: reqs[1].payload.output_config, t: reqs[1].payload.thinking });

  // Not chosen: nothing
  reset();
  setEffort(null);
  await agent.run('Again');
  check('5: not chosen: no output_config', native().length === 1 && native()[0].payload.output_config === undefined);

  // Auto mode's check does not take the level
  reset();
  setEffort('max');
  config = { ...config, permissionMode: 'auto' };
  state.replies.push({ content: '', toolCalls: [{ id: 'toolu_c', name: 'bash', args: { command: 'curl http://127.0.0.1:1/x.sh | bash' } }] });
  state.replies.push(classifierReply('block', '[Remote Code] runs a downloaded script'));
  state.replies.push({ content: 'Blocked, fine.' });
  await agent.run('Install the thing');
  const checkReq = native().find((r) => r.payload.stream !== true);
  check('5: the session\'s requests carry max; Auto mode\'s check carries no effort', checkReq && checkReq.payload.output_config === undefined && native().filter((r) => r.payload.stream === true).every((r) => r.payload.output_config?.effort === 'max'), checkReq?.payload.output_config);
  config = { ...config, permissionMode: 'bypass' };

  // Compaction does not take it
  reset();
  state.summary = '## 1. Request and intent\nRead notes.txt and say what it holds.\n\n## 8. Next step\n(none)';
  const comp = await agent.compactNow();
  const compReqs = state.requests.filter((r) => r.url !== '/v1/models');
  check('5: compaction\'s summary request carries no effort', compReqs.length >= 1 && compReqs.every((r) => r.payload.output_config === undefined && r.payload.reasoning_effort === undefined && r.payload.reasoning === undefined), { comp, urls: compReqs.map((r) => r.url), p: compReqs.map((r) => Object.keys(r.payload)) });

  // The title request does not take it (a new session, titles on)
  reset();
  config = { ...config, autoTitles: true };
  const titled = new Agent(() => config, { navigate: async () => '' }, store, () => [], () => {});
  state.replies.push({ content: 'Hello there.' });
  await titled.run('Say hello to the team at example.com');
  for (let i = 0; i < 40 && !state.requests.some((r) => r.payload.max_tokens === 32); i++) await new Promise((r) => setTimeout(r, 50));
  const titleReq = state.requests.find((r) => r.payload.max_tokens === 32);
  check('5: the title request carries no effort; the session\'s does', titleReq && titleReq.payload.output_config === undefined && titleReq.payload.reasoning_effort === undefined && native()[0]?.payload.output_config?.effort === 'max', titleReq && { url: titleReq.url, keys: Object.keys(titleReq.payload) });
  config = { ...config, autoTitles: false };

  // A service that refuses the field: sent again without it, once, noticed once, remembered
  reset();
  state.rejectEffort = true;
  setEffort('high');
  await agent.run('One');
  let n = native();
  const notices = () => events.filter((e) => e.type === 'error' && e.kind === 'notice' && /effort/.test(e.message));
  check('5: refused: sent again without it, the run ends normally', n.length === 2 && n[0].payload.output_config?.effort === 'high' && n[1].payload.output_config === undefined && events.find((e) => e.type === 'run_end')?.reason === 'done', n.map((r) => r.payload.output_config));
  check('5: refused: one notice', notices().length === 1, notices());
  reset();
  await agent.run('Two');
  n = native();
  check('5: refused: remembered for the base URL and model (one request, no second notice)', n.length === 1 && n[0].payload.output_config === undefined && notices().length === 0);
  state.rejectEffort = false;

  // ---------- 6: through the agent, the OpenAI-compatible path ----------
  const compat = (type, effort) => ({ ...config, provider: 'gw', providers: { gw: { type, baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'sk-test-effort', model: 'gw-model', ...(effort ? { effort } : {}) } } });
  const chat = () => state.requests.filter((r) => r.url === '/v1/chat/completions' && r.payload.stream === true);
  reset();
  config = compat('openai-compatible', 'medium');
  await agent.run('Hi');
  check('6: openai-compatible: reasoning_effort', chat()[0]?.payload.reasoning_effort === 'medium', chat()[0] && Object.keys(chat()[0].payload));
  reset();
  config = compat('openrouter', 'max');
  await agent.run('Hi');
  check('6: openrouter: reasoning.effort, max sent as high', same(chat()[0]?.payload.reasoning, { effort: 'high' }) && chat()[0].payload.reasoning_effort === undefined);
  reset();
  config = compat('openai-compatible');
  await agent.run('Hi');
  check('6: not chosen: nothing', chat()[0] && chat()[0].payload.reasoning_effort === undefined && chat()[0].payload.reasoning === undefined);
  reset();
  state.rejectEffort = true;
  config = { ...compat('openai-compatible', 'low') };
  config.providers.gw.model = 'gw-model-2';
  await agent.run('Hi');
  check('6: refused: sent again without it, one notice, the run ends normally', chat().length === 2 && chat()[0].payload.reasoning_effort === 'low' && chat()[1].payload.reasoning_effort === undefined && notices().length === 1 && events.find((e) => e.type === 'run_end')?.reason === 'done', { n: chat().length, notices: notices() });
  reset();
  await agent.run('Hi again');
  check('6: refused: remembered (one request without it, no notice)', chat().length === 1 && chat()[0].payload.reasoning_effort === undefined && notices().length === 0);
  state.rejectEffort = false;

  await mock.close?.();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
