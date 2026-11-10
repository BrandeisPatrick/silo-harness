// Pruning in batches where a provider caches the prefix (Agent.pruneInBatches, context-view.ts batchMarks): over a
// long session the bytes of the request prefix change only at a batch, never call after call; old screenshots go a
// batch at a time; a provider that does not cache keeps the old way.
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
  const cached = await session(24);
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

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
