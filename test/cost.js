// A session's cost in dollars (src/main/cost.ts): the cost of a call from its usage and price, with cache reads and
// writes split out of the prompt (five-minute and one-hour writes apart); Claude Haiku 5.5's price step per request;
// the user's price overriding the table and pricing any other model; no figure when a call has no price; the
// formatting; totals across models; the agent charging its turns, Auto mode's check (on its own model), the title and
// a compaction summary; the merge summary's and the title's usage reported; the totals surviving a restart; /cost.
// Run: node test/cost.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const C = dist('cost.js');
const { nativeUsage } = dist('agent/anthropic.js');
const { usageOf } = dist('agent/complete.js');
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const { writeMergeReport } = dist('subagents/summary.js');
const { generateTitle } = dist('titles.js');
const { setupCost } = dist('cost-service.js');
const { SettingsLayer, settingsSchema, checkSetting } = dist('settings.js');
const { startMock, classifierReply } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-12;
const ANTHROPIC = (model) => ({ model, anthropic: true });
const GATEWAY = (model) => ({ model, anthropic: false });

(async () => {
  // ---------- 1: one call ----------
  {
    // The page's worked example (Claude Opus 5.5): 50,000 input and 15,000 output tokens; then 40,000 of the input read from the cache
    check('1: Opus 5.5, 50K in / 15K out: $0.50', near(C.callCost(ANTHROPIC('claude-opus-5-5'), { promptTokens: 50_000, completionTokens: 15_000 }), 0.5));
    const cached = nativeUsage({ input_tokens: 10_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0, output_tokens: 15_000 });
    check('1: …with 40K of it read from the cache: $0.348 (reads at 0.05x on Opus 5.5)', cached.promptTokens === 50_000 && near(C.callCost(ANTHROPIC('claude-opus-5-5'), cached), 0.348), cached);
    // Native usage: input_tokens is only the uncached part; the prompt is the sum. Writes split by lifetime.
    const native = nativeUsage({ input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }, output_tokens: 500 });
    const split = C.splitUsage(native);
    check('1: native usage: prompt 6000 = 1000 uncached + 2000 read + 1000 written 5m + 2000 written 1h', native.promptTokens === 6000 && split.input === 1000 && split.cacheRead === 2000 && split.cacheWrite === 1000 && split.cacheWrite1h === 2000 && split.output === 500, split);
    // Sonnet 4.6: 1000×3 + 2000×0.3 + 1000×3.75 + 2000×6 + 500×15 = 3000 + 600 + 3750 + 12000 + 7500 = 26850
    check('1: …priced per kind: Sonnet 4.6 $0.02685', near(C.callCost(ANTHROPIC('claude-sonnet-4-6'), native), 0.02685));
    // A gateway's usage (OpenAI shape): prompt_tokens is the whole input, cached tokens are of it
    const gw = usageOf({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 } });
    const g = C.splitUsage(gw);
    check('1: OpenAI-shaped usage: cached tokens come out of the prompt, not on top', g.input === 400 && g.cacheRead === 600 && g.cacheWrite === 0, g);
    check('1: a dated snapshot id finds its model', C.tableEntry('claude-haiku-4-5-20251001')?.id === 'claude-haiku-4-5' && C.tableEntry('Claude-Opus-4-5')?.id === 'claude-opus-4-5');
    check('1: "claude-opus-5" is not "claude-opus-5-5"', C.tableEntry('claude-opus-5').input === 5 && C.tableEntry('claude-opus-5-5').input === 4);
    check('1: a model the table does not have, and a retired one, have no entry', !C.tableEntry('claude-opus-4-1') && !C.tableEntry('mock-model') && !C.tableEntry(''));
  }

  // ---------- 2: the price step (Claude Haiku 5.5, prompts over 100,000 tokens) ----------
  {
    const haiku = ANTHROPIC('claude-haiku-5-5');
    check('2: 100,000 tokens exactly: the base rates ($0.01)', near(C.callCost(haiku, { promptTokens: 100_000, completionTokens: 0 }), 0.01));
    check('2: 100,001 tokens: every token at the higher rates', near(C.callCost(haiku, { promptTokens: 100_001, completionTokens: 1000 }), (100_001 * 0.5 + 1000 * 2.5) / 1e6));
    // The prompt's length counts cache reads and writes: 30K uncached + 80K read is over the step
    const mixed = { promptTokens: 110_000, completionTokens: 0, cacheReadTokens: 80_000, cacheWriteTokens: 0 };
    check('2: cache reads count toward the step and are priced at its read rate', near(C.callCost(haiku, mixed), (30_000 * 0.5 + 80_000 * 0.05) / 1e6));
    // Each request on its own: one long and one short call make two brackets
    let cost = C.addCall(undefined, haiku, { promptTokens: 150_000, completionTokens: 0 }, { now: 1 });
    cost = C.addCall(cost, haiku, { promptTokens: 50_000, completionTokens: 0 });
    const s = C.summarize(cost, undefined);
    check('2: per request: a long and a short call, each at its own rate', cost.buckets.length === 2 && near(s.usd, (150_000 * 0.5 + 50_000 * 0.1) / 1e6), cost.buckets);
    check('2: only Haiku 5.5 has a step in the table', C.PRICE_TABLE.filter((e) => e.long).map((e) => e.id).join() === 'claude-haiku-5-5');
  }

  // ---------- 3: whose price ----------
  {
    const prices = { 'claude-opus-5-5': { input: 1, output: 2 }, 'my-model': { input: 2, output: 8 }, 'my-cached': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 } };
    const u = { promptTokens: 1_000_000, completionTokens: 1_000_000 };
    check("3: the user's price overrides the table", near(C.callCost(ANTHROPIC('claude-opus-5-5'), u, prices), 3));
    check("3: …and prices a model on any provider", near(C.callCost(GATEWAY('my-model'), u, prices), 10));
    check('3: cacheRead and cacheWrite default to the input price', near(C.callCost(GATEWAY('my-model'), { promptTokens: 3_000_000, completionTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, prices), 6));
    check('3: …or take their own (a one-hour write at cacheWrite too)', near(C.callCost(GATEWAY('my-cached'), { promptTokens: 3_000_000, completionTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 500_000 }, prices), 2 + 0.5 + 3));
    check('3: a Claude model through a gateway has no built-in price', C.callCost(GATEWAY('claude-opus-5-5'), u) === null);
    check('3: an unknown model has no price', C.callCost(ANTHROPIC('mock-model'), u) === null && C.callCost(GATEWAY('mock-model'), u) === null);
    check('3: a user price without input or output is no price', C.callCost(GATEWAY('half'), u, { half: { input: 1 } }) === null);
    // callSource: the table only for a base URL on api.anthropic.com
    const base = { provider: 'a', providers: { a: { type: 'anthropic', baseURL: 'https://api.anthropic.com/v1', apiKey: 'k', model: 'claude-opus-5-5' }, g: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'claude-opus-5-5' } }, ollama: { baseURL: '', model: '', numCtx: 1, think: 'auto' }, portkey: {} };
    const a = C.callSource(base);
    const gs = C.callSource({ ...base, provider: 'g' }, 'other-model');
    check("3: callSource: Anthropic's API, and a gateway with the call's own model", a.anthropic === true && a.model === 'claude-opus-5-5' && gs.anthropic === false && gs.model === 'other-model', { a, gs });
  }

  // ---------- 4: totals, formatting, the note ----------
  {
    let cost = C.addCall(undefined, ANTHROPIC('claude-opus-5-5'), { promptTokens: 10_000, completionTokens: 1000 }, { now: 1 });
    cost = C.addCall(cost, ANTHROPIC('claude-haiku-5-5'), { promptTokens: 5000, completionTokens: 100 });
    cost = C.addCall(cost, ANTHROPIC('claude-opus-5-5'), { promptTokens: 10_000, completionTokens: 1000 });
    const s = C.summarize(cost, undefined);
    check('4: totals across models, each at its own price', s.calls === 3 && near(s.usd, (2 * (10_000 * 4 + 1000 * 20) + 5000 * 0.1 + 100 * 0.5) / 1e6) && s.input === 25_000 && s.output === 2100, s);
    const mixed = C.addCall(structuredClone(cost), GATEWAY('mock-model'), { promptTokens: 300, completionTokens: 30 });
    const m = C.summarize(mixed, undefined);
    check('4: one call without a price: no figure at all, and the model is named', m.usd === undefined && m.unpriced.join() === 'mock-model', m);
    check('4: …the event carries no figure', JSON.stringify(C.costEvent(mixed, undefined)) === JSON.stringify({ type: 'cost' }));
    check('4: …until the user prices it', C.costEvent(mixed, { 'mock-model': { input: 1, output: 1 } }).label === C.formatUsd(C.summarize(mixed, { 'mock-model': { input: 1, output: 1 } }).usd));
    check('4: nothing counted yet: no figure', C.summarize(undefined, undefined).usd === undefined && C.costEvent(undefined, undefined).label === undefined);
    const f = [C.formatUsd(0.0004), C.formatUsd(0.009), C.formatUsd(0.04), C.formatUsd(0.041), C.formatUsd(12.3), C.formatUsd(1234.5), C.formatUsd(0)];
    check('4: formatting: <$0.01, $0.01, $0.04, $0.04, $12.30, $1,234.50, $0.00', f.join(' ') === '<$0.01 <$0.01 $0.04 $0.04 $12.30 $1,234.50 $0.00', f);
    const note = C.costNote(cost, undefined);
    check('4: /cost: the figure, the tokens and what is counted', note.startsWith(`${C.formatUsd(s.usd)}, estimated from list prices`) && /25,000 uncached input · 0 cached · 0 cache write · 2,100 output tokens · 3 calls/.test(note) && note.includes(C.COUNTED), note);
    const missing = C.costNote(mixed, undefined);
    check('4: /cost without a price names the model and the setting', missing.startsWith('No dollar figure: no price for mock-model') && missing.includes('"prices"'), missing);
    check('4: /cost with nothing yet says so', C.costNote(undefined, undefined).startsWith('No model calls counted'));
    const old = C.addCall(undefined, GATEWAY('m'), { promptTokens: 1, completionTokens: 1 }, { now: Date.UTC(2026, 10, 10), before: true });
    check('4: a session with calls from before says since when it is counted', old.partial === true && C.costNote(old, { m: { input: 1, output: 1 } }).includes('Counted since 2026-11-10'));
  }

  // ---------- 5: settings ----------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cost-settings-'));
    const file = path.join(tmp, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ prices: { good: { input: 1, output: 5, cacheRead: 0.1 }, bad: { input: 'x', output: 1 }, partial: { input: 1 }, odd: { input: 1, output: 1, foo: 2 } } }));
    const layer = new SettingsLayer({ userFile: file });
    const cfg = layer.load({ provider: 'ollama', ollama: { baseURL: '', model: '', numCtx: 1, think: 'auto' }, portkey: {}, providers: {}, workingDirectory: tmp, settingsTrusted: {} });
    const invalid = layer.info().files[0].invalid.map((i) => i.key).sort();
    layer.restoreEnv();
    check('5: settings.json prices: the good entry applies, each bad one is reported', JSON.stringify(cfg.prices) === JSON.stringify({ good: { input: 1, output: 5, cacheRead: 0.1 } }) && invalid.join() === 'prices.bad.input,prices.odd.foo,prices.partial', { prices: cfg.prices, invalid });
    check('5: the schema has prices; checkSetting checks it', !!settingsSchema().properties.prices && checkSetting('prices', { a: { input: 1, output: 2 } }) === null && typeof checkSetting('prices', { a: { output: 2 } }) === 'string');
  }

  // ---------- 6: the agent charges each kind of call, on the model that made it ----------
  const mock = await startMock();
  const { state } = mock;
  state.summary = 'The user asked for a file; the agent made it with touch and said done. Nothing else is pending.';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cost-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd);
  const mockUrl = `http://127.0.0.1:${mock.port}/v1`;
  const config = {
    provider: 'portkey',
    ollama: { baseURL: 'http://127.0.0.1:1', model: 'm', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: mockUrl, apiKey: 'test', model: 'mock-model', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    providers: {},
    workingDirectory: cwd, permissionMode: 'auto', autoApprove: false, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: true,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {},
    autoMode: { environment: '', allow: [], model: 'check-model' },
    prices: { 'mock-model': { input: 1, output: 5 }, 'check-model': { input: 2, output: 10 } },
  };
  const sessionsDir = path.join(tmp, 'sessions');
  const store = new SessionStore(sessionsDir);
  const events = [];
  const agent = new Agent(() => config, {}, store, () => [], (ev) => events.push(ev), undefined, undefined, undefined, { hooks: null });
  state.replies.push({ toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'touch made.txt' } }] });
  state.replies.push(classifierReply('allow', '[Local Work] makes a file'));
  state.replies.push({ content: 'done' });
  state.replies.push({ nonStream: true, content: 'Make A File', when: (p) => JSON.stringify(p.messages ?? []).includes('You name chat sessions') });
  await agent.run('make a file please');
  for (let i = 0; i < 100 && agent.session.title !== 'Make A File'; i++) await new Promise((r) => setTimeout(r, 20));
  const b = (model) => (agent.session.cost?.buckets ?? []).find((x) => x.model === model);
  // mock-model: 2 turns (300 in / 30 out each) and the title (200 / 20); check-model: the check (200 / 20)
  check('6: two turns and the title on the session model, the check on its own', b('mock-model')?.calls === 3 && b('check-model')?.calls === 1 && b('mock-model').input === 800 && b('mock-model').output === 80, agent.session.cost);
  const costs = events.filter((e) => e.type === 'cost');
  const want1 = (800 * 1 + 80 * 5 + 200 * 2 + 20 * 10) / 1e6;
  check('6: a cost event after each counted call, the last with the total', costs.length === 4 && near(costs[3].usd, want1) && costs[3].label === '<$0.01', costs);
  const usageAt = events.findIndex((e) => e.type === 'usage');
  check('6: the turn\'s cost follows its usage event', events[usageAt + 1]?.type === 'cost');
  const r = await agent.compactNow();
  check('6: a compaction summary is counted too (400 / 120 on the session model)', r.ok && b('mock-model').calls === 4 && near(C.summarize(agent.session.cost, config.prices).usd, want1 + (400 + 600) / 1e6), { r, cost: agent.session.cost });
  const leaked = state.requests.filter((q) => JSON.stringify(q.payload).includes('estimated from list prices') || JSON.stringify(q.payload).includes('<$0.01'));
  check('6: no cost text in any request', leaked.length === 0);

  // Without a price for the check's model: no figure
  delete config.prices['check-model'];
  check('6: the check\'s model unpriced: no figure, /cost names it', C.costEvent(agent.session.cost, config.prices).label === undefined && C.costNote(agent.session.cost, config.prices).includes('no price for check-model'));
  config.prices['check-model'] = { input: 2, output: 10 };

  // ---------- 7: the totals survive a restart; /cost ----------
  {
    const before = JSON.stringify(agent.session.cost);
    const again = new SessionStore(sessionsDir);
    const loaded = again.get(agent.session.id);
    check('7: the totals are saved with the session and read back after a restart', loaded && JSON.stringify(loaded.cost) === before, loaded?.cost);
    const commands = [];
    setupCost({ commands: { register: (c) => commands.push(c) }, runtime: { get: (id) => again.get(id) }, config: () => config });
    const cmd = commands.find((c) => c.name === 'cost');
    const res = await cmd.run('', { sessionId: agent.session.id });
    check('7: /cost after the restart answers locally with the same figure', cmd && res.notice === C.costNote(loaded.cost, config.prices) && res.notice.startsWith('<$0.01'), res.notice);
    check('7: /cost with no session says nothing is counted', (await cmd.run('', {})).notice.startsWith('No model calls counted'));
    // A fork starts its own count
    const fork = again.fork(agent.session.id);
    check('7: a fork does not carry its source\'s cost', fork.cost === undefined);
    // A session from before this change: the first call marks it partial
    const s = again.create({ cwd });
    s.messages.push({ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' });
    C.chargeSession(s, GATEWAY('mock-model'), { promptTokens: 10, completionTokens: 1 }, config);
    check('7: a session that made calls before the totals existed is marked partial', s.cost.partial === true);
  }

  // ---------- 8: the title and merge summary report their usage ----------
  {
    let got = null;
    state.replies.push({ nonStream: true, content: 'A Title', when: (p) => JSON.stringify(p.messages ?? []).includes('You name chat sessions') });
    await generateTitle(config, 'hello\n\nAssistant reply:\nhi', (u) => (got = u));
    check('8: generateTitle hands on its usage', got && got.promptTokens === 200 && got.completionTokens === 20, got);
    got = null;
    await writeMergeReport(config, 'Sub', 'sub-session', [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'did it' }], (u) => (got = u));
    check('8: writeMergeReport hands on its usage', got && got.promptTokens === 400 && got.completionTokens === 120, got);
  }

  mock.server?.close?.();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
