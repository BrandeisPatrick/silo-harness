// Pruning in batches where a provider caches the prefix (Agent.pruneInBatches, context-view.ts batchMarks): over a
// long session the bytes of the request prefix change only at a batch, never call after call; old screenshots go a
// batch at a time; a provider that does not cache keeps the old way, and so does one assumed to cache that reports no
// cache read or write on three warm requests in a row. After a pause longer than the cache lasts a batch starts at 60K.
// Run: node test/prune-batches.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const V = dist('agent/context-view.js');
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

(async () => {
  // ---- 1: the marks (pure) ----
  check('1: a large window: 90K high, 50K low', JSON.stringify(V.batchMarks(1_000_000, 0.6)) === JSON.stringify({ high: 90_000, low: 50_000 }));
  const small = V.batchMarks(32_000, 0.6);
  check('1: a small window keeps its 60%, the low mark scaled with it', small.high === 19_200 && small.low === Math.round((19_200 * 50) / 90), small);

  // ---- 2: screenshots in batches (pure) ----
  const shot = (n) => ({ role: 'user', content: [{ type: 'text', text: `[Screenshot returned by browser_screenshot] ${n}` }, { type: 'image_url', image_url: { url: `data:image/png;base64,S${n}` } }] });
  const images = (msgs) => msgs.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.image_url)).length;
  const series = [];
  for (let n = 1; n <= 12; n++) series.push(shot(n));
  const counts = [];
  for (let n = 1; n <= 12; n++) counts.push(images(V.modelMessages(series.slice(0, n), new Set(), { batchShots: true })));
  check('2: batched, the oldest screenshots go four at a time (2 to 5 kept)', JSON.stringify(counts) === JSON.stringify([1, 2, 3, 4, 5, 2, 3, 4, 5, 2, 3, 4]), counts);
  // An earlier message changes only when a batch goes
  let changes = 0;
  for (let n = 2; n <= 12; n++) {
    const a = JSON.stringify(V.modelMessages(series.slice(0, n - 1), new Set(), { batchShots: true }));
    const b = JSON.stringify(V.modelMessages(series.slice(0, n), new Set(), { batchShots: true }).slice(0, n - 1));
    if (a !== b) changes++;
  }
  check('2: …so of eleven new screenshots, two changed an earlier message', changes === 2, changes);
  const unbatched = [];
  for (let n = 1; n <= 6; n++) unbatched.push(images(V.modelMessages(series.slice(0, n))));
  check('2: unbatched (Ollama), the two newest as before', JSON.stringify(unbatched) === JSON.stringify([1, 2, 2, 2, 2, 2]), unbatched);

  // ---- 3: a long session through the agent ----
  const mock = await startMock();
  const { state } = mock;
  state.promptTokensFromBody = true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-prune-batches-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd);
  // About 6K tokens of output per read
  for (let i = 1; i <= 26; i++) fs.writeFileSync(path.join(cwd, `f${i}.txt`), `F${i}-START ${`line ${i} of the file with some words in it\n`.repeat(600)}F${i}-END`);
  const local = { type: 'lmstudio', baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', contextWindow: 1_000_000 };
  let config = {
    provider: 'portkey',
    providers: { local },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 1_000_000 },
    ollama: { baseURL: 'http://127.0.0.1:1/v1', model: 'x', numCtx: 4096, think: 'auto' },
    workingDirectory: cwd, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: true, compactThreshold: 0.8, pruneToolResults: true, notifications: false, allowRules: {}, recentDirs: [],
  };
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const agent = new Agent(() => config, { navigate: async (u) => u }, store, () => [], () => {});
  const streams = () => state.requests.filter((r) => r.payload?.stream).map((r) => r.payload);
  /** A session of `turns` turns, each reading one file: returns the requests and how many broke the prefix */
  const session = async (turns) => {
    agent.session = store.create({ cwd });
    state.requests.length = 0;
    for (let i = 1; i <= turns; i++) {
      state.replies.push({ content: '', toolCalls: [{ id: `r${i}`, name: 'read_file', args: { path: `f${i}.txt` } }] });
      state.replies.push({ content: `Read f${i}.` });
      await agent.run(`Read f${i}.txt`);
    }
    const reqs = streams();
    const breaks = [];
    for (let i = 1; i < reqs.length; i++) {
      const prev = reqs[i - 1];
      const cur = reqs[i];
      const same = JSON.stringify(prev.messages) === JSON.stringify(cur.messages.slice(0, prev.messages.length)) && JSON.stringify(prev.messages[0]) === JSON.stringify(cur.messages[0]);
      if (!same) breaks.push(i);
    }
    return { reqs, breaks, tokens: reqs.map((r) => Math.ceil(JSON.stringify(r).length / 4)) };
  };
  state.cachedTokens = 1000;
  const cached = await session(24);
  state.cachedTokens = 0;
  const peak = Math.max(...cached.tokens);
  // (counted here as the request's characters over four; the agent's own estimate is what it compares)
  check('3: the long session reached the high-water mark', peak >= 85_000, peak);
  check('3: a provider that caches: the prefix changed only at a batch (once or twice in 48 requests)', cached.breaks.length >= 1 && cached.breaks.length <= 2, cached.breaks);
  const at = cached.breaks[0];
  check('3: …the batch came at the high-water mark and brought the request down near the low one', cached.tokens[at - 1] >= 85_000 && cached.tokens[at] < 60_000, { before: cached.tokens[at - 1], after: cached.tokens[at] });
  check('3: …and between batches every request is the one before plus what was appended', cached.reqs.length === 48);
  check('3: the session keeps every result whole', agent.session.messages.filter((m) => m.role === 'tool').every((m) => /F\d+-END/.test(m.content)));
  // The provider that does not cache, the old way: a little more past 48K, turn after turn
  config = { ...config, provider: 'local' };
  const uncached = await session(24);
  check('3: a provider that does not cache keeps the old way (the prefix changes turn after turn past 48K)', uncached.breaks.length > 8, uncached.breaks.length);
  // A provider assumed to cache that never reports a cache read or write: after three warm misses, the old way too
  config = { ...config, provider: 'portkey' };
  const unreported = await session(24);
  check('3: a gateway that reports no cache falls back to the old way', unreported.breaks.length > 8 && !agent.cachesPrefix(config), unreported.breaks.length);

  // ---- 4: learning whether the session caches (injected clock and usage) ----
  let clock = 1_000_000;
  const timed = new Agent(() => config, { navigate: async (u) => u }, store, () => [], () => {}, undefined, undefined, undefined, { now: () => clock });
  const usage = (read, write = 0, prompt = 5000) => ({ prompt_tokens: prompt, completion_tokens: 30, prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } });
  /** One run of one request, `gap` ms after the last one answered; returns whether the session still counts as caching */
  const step = async (gap, u) => {
    clock += gap;
    state.replies.push({ content: 'Ok.', usage: u });
    await timed.run('Go on');
    return timed.cachesPrefix(config);
  };
  const MIN = 60_000;
  timed.session = store.create({ cwd });
  const reading = [];
  for (let i = 0; i < 6; i++) reading.push(await step(MIN, usage(i ? 4000 : 0, i ? 0 : 4000)));
  check('4: reads reported: stays batching', reading.every(Boolean), reading);
  timed.session = store.create({ cwd });
  const warm = [];
  for (let i = 0; i < 4; i++) warm.push(await step(MIN, usage(0)));
  // The first request has no reply before it, so it is not a miss; the next three are
  check('4: three warm misses in a row switch the session to the uncached rule', JSON.stringify(warm) === JSON.stringify([true, true, true, false]), warm);
  check('4: …a later read switches it back', (await step(MIN, usage(3000))) === true);
  check('4: …and a write alone counts too', (await step(MIN, usage(0))) && (await step(MIN, usage(0))) && (await step(MIN, usage(0))) === false && (await step(MIN, usage(0, 3000))) === true);
  timed.session = store.create({ cwd });
  const cold = [];
  for (let i = 0; i < 5; i++) cold.push(await step(6 * MIN, usage(0)));
  check('4: a request more than five minutes after the last reply is not a miss', cold.every(Boolean), cold);
  timed.session = store.create({ cwd });
  const short = [];
  for (let i = 0; i < 5; i++) short.push(await step(MIN, usage(0, 0, 1500)));
  check('4: nor is a prompt too short to cache', short.every(Boolean), short);
  config = { ...config, provider: 'local' };
  timed.session = store.create({ cwd });
  check('4: LM Studio stays uncached, reads or not', (await step(MIN, usage(4000))) === false && (await step(MIN, usage(4000))) === false);
  config = { ...config, provider: 'portkey' };

  // ---- 5: a batch at a pause (injected clock) ----
  clock = Date.now();
  const paused = new Agent(() => config, { navigate: async (u) => u }, store, () => [], () => {}, undefined, undefined, undefined, { now: () => clock });
  const pause = async (gap) => {
    clock += gap;
    state.replies.push({ content: 'Ok.' });
    await paused.run('Go on');
    return true;
  };
  state.cachedTokens = 1000;
  /** A session of `reads` earlier file reads, last active `idle` ms ago */
  const built = (reads, idle = 0) => {
    const s = store.create({ cwd });
    for (let i = 1; i <= reads; i++) {
      s.messages.push({ role: 'user', content: `Read f${i}.txt` });
      s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `p${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.txt` }) } }] });
      s.messages.push({ role: 'tool', tool_call_id: `p${i}`, content: fs.readFileSync(path.join(cwd, `f${i}.txt`), 'utf8') });
      s.messages.push({ role: 'assistant', content: `Read f${i}.` });
    }
    s.updatedAt = clock - idle;
    paused.session = s;
    return paused.contextInfo().tokens;
  };
  const set = () => (paused.session.prunedResults ?? []).length;
  const at70 = built(11);
  check('5: the test session is about 70K', at70 > 65_000 && at70 < 80_000, at70);
  await pause(0);
  check('5: warm at 70K: nothing set aside', set() === 0, set());
  const before = paused.contextInfo().tokens;
  await pause(6 * MIN);
  const after = paused.contextInfo().tokens;
  check('5: cold at 70K (the last reply over five minutes ago): set aside down to about 50K', set() > 0 && after < 55_000 && after > 40_000, { before, after, set: set() });
  const at55 = built(8, 10 * MIN);
  check('5: cold at 55K: nothing set aside', at55 > 50_000 && at55 < 60_000 && (await pause(0)) && set() === 0, { at55, set: set() });
  built(11, 10 * MIN);
  await pause(0);
  check('5: cold by the stored session\'s last activity (reloaded): set aside too', set() > 0, set());
  // A provider that reports no usage: the pause is still measured from the last reply, not from the stored time
  const quiet = async (gap) => {
    clock += gap;
    state.replies.push({ content: 'Ok.', noUsage: true });
    await paused.run('Go on');
  };
  built(11, 10 * MIN);
  await quiet(0);
  const first = set();
  for (let i = 1; i <= 4; i++) {
    const s = paused.session;
    s.messages.push({ role: 'user', content: `Read f${i}.txt again` });
    s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `q${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.txt` }) } }] });
    s.messages.push({ role: 'tool', tool_call_id: `q${i}`, content: fs.readFileSync(path.join(cwd, `f${i}.txt`), 'utf8') });
    s.messages.push({ role: 'assistant', content: `Read f${i}.` });
  }
  const grown = paused.contextInfo().tokens;
  await quiet(MIN);
  check('5: no usage reported: cold once by the stored time, warm after the first reply', first > 0 && grown > 62_000 && grown < 88_000 && set() === first, { first, grown, set: set() });
  config = { ...config, provider: 'local' };
  built(11);
  await pause(0);
  const warmLocal = set();
  built(11, 10 * MIN);
  await pause(0);
  check('5: a provider that does not cache: the same with or without a pause', set() === warmLocal && warmLocal > 0, { warmLocal, cold: set() });
  config = { ...config, provider: 'portkey' };
  state.cachedTokens = 0;

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
