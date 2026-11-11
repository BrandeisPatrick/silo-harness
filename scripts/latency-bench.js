#!/usr/bin/env node
// A repeatable latency benchmark with the mock model and made-up files: the agent driven directly (no window), each
// scenario run N times "before" (toolConcurrency 1, the old one-at-a-time loop) and "after" (the default, 4), with the
// median and 95th percentile of the run's wall time and the numbers the timing record (agent/perf.ts) gives.
// The tools' slowness is simulated: read_file and web_fetch wait for a `delay_ms` argument of their own.
//   npm run build && node scripts/latency-bench.js [--runs 15] [--json]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = (p) => require(path.join(root, 'dist', 'main', p));
let Agent, SessionStore, fsTools, webTools, R;
try {
  ({ Agent } = dist('agent.js'));
  ({ SessionStore } = dist('sessions.js'));
  fsTools = dist('tools/fs.js');
  webTools = dist('tools/web.js');
  R = dist('agent/retry.js');
} catch {
  console.error('Build first: npm run build');
  process.exit(1);
}
const { startMock } = require(path.join(root, 'test', 'support', 'mock-model.js'));

const args = process.argv.slice(2);
const RUNS = Math.max(3, Number(args[args.indexOf('--runs') + 1]) || 15);
const JSON_OUT = args.includes('--json');

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

// Slow tools: a read waits `delay_ms`; web_fetch is a remote read that never leaves the machine
const realRead = fsTools.readFile.run;
fsTools.readFile.run = async (a, ctx) => {
  if (a.delay_ms) await sleep(a.delay_ms, ctx.signal);
  if (ctx.signal?.aborted) return { content: 'Tool call was interrupted before it produced a result.' };
  return realRead(a, ctx);
};
webTools.webFetch.run = async (a, ctx) => {
  await sleep(a.delay_ms ?? 400, ctx.signal);
  return { content: ctx.signal?.aborted ? 'Error: stopped.' : '# Example page\nMade-up remote content.' };
};

const pct = (list, p) => {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const median = (list) => pct(list, 50);

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-bench-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const proj = path.join(tmp, 'project');
  fs.mkdirSync(proj);
  const reset = () => {
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(proj, `${n}.txt`), `made-up ${n}\n`);
  };
  reset();
  const base = {
    provider: 'portkey',
    ollama: { baseURL: 'http://127.0.0.1:1', model: 'm', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'made-up', model: 'mock-model', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: proj, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {},
  };
  const native = { ...base, provider: 'claude', providers: { claude: { type: 'anthropic', baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'made-up', model: 'claude-opus-5-5', headers: {} } } };
  let config = base;
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], () => undefined, undefined, undefined, undefined, { hooks: null });
  const read = (id, file, ms) => ({ id, name: 'read_file', args: { path: file, delay_ms: ms } });

  /** One scenario: `setup` queues the mock's replies; `during` may act mid-run (a stop). Returns the record and its wall time. */
  async function once(cfg, setup, during) {
    config = cfg;
    state.replies.length = 0;
    state.requests.length = 0;
    agent.session = store.create();
    reset();
    setup();
    const t0 = performance.now();
    const run = agent.run('Benchmark step');
    if (during) await during();
    await run;
    return { ms: performance.now() - t0, record: agent.lastTiming() };
  }

  const scenarios = [
    {
      name: 'A. three reads (300, 100, 200 ms)',
      setup: () => state.replies.push({ content: '', toolCalls: [read('a1', 'a.txt', 300), read('a2', 'b.txt', 100), read('a3', 'c.txt', 200)] }, { content: 'Done.' }),
      check: (r) => r.record.tools.length === 3 && r.record.end === 'done',
    },
    {
      name: 'B. local read (100 ms) + remote read (400 ms)',
      setup: () => state.replies.push({ content: '', toolCalls: [read('b1', 'a.txt', 100), { id: 'b2', name: 'web_fetch', args: { url: 'https://example.com/', delay_ms: 400 } }] }, { content: 'Done.' }),
      check: (r) => r.record.tools.length === 2,
    },
    {
      name: 'C. read (200 ms), edit, read (200 ms)',
      setup: () => state.replies.push({ content: '', toolCalls: [read('c1', 'a.txt', 200), { id: 'c2', name: 'edit_file', args: { path: 'a.txt', old_string: 'made-up a', new_string: 'edited a' } }, read('c3', 'a.txt', 200)] }, { content: 'Done.' }),
      // The edit must not overlap either read
      check: (r) => {
        const [x, e, y] = r.record.tools;
        return e.startAt >= x.endAt && y.startAt >= e.endAt;
      },
    },
    {
      name: 'D. uncertain command, Auto mode (check 300 ms, blocks)',
      cfg: { permissionMode: 'auto', autoMode: { environment: '', allow: [], model: '' } },
      setup: () => {
        state.replies.push({ content: '', toolCalls: [{ id: 'd1', name: 'bash', args: { command: 'curl -s https://example.com/made-up' } }] }, { content: 'Done.' });
        state.replies.push({ nonStream: true, delayMs: 300, content: '{"decision":"block","reason":"[Exfiltration] made-up"}' });
      },
      check: (r) => r.record.tools[0]?.outcome === 'blocked' && r.record.tools[0].permission[0]?.path === 'check',
    },
    {
      name: 'D2. the same, the check answers nonsense (fails closed)',
      cfg: { permissionMode: 'auto', autoMode: { environment: '', allow: [], model: '' } },
      setup: () => {
        state.replies.push({ content: '', toolCalls: [{ id: 'd2', name: 'bash', args: { command: 'curl -s https://example.com/made-up' } }] }, { content: 'Done.' });
        state.replies.push({ nonStream: true, delayMs: 300, content: 'not a verdict' });
      },
      check: (r) => r.record.tools[0]?.outcome === 'blocked' && r.record.tools[0].permission[0]?.check === 'error' && !fs.existsSync(path.join(proj, 'made-up')),
    },
    {
      name: 'E. native stream: first event at 400 ms, thinking streamed over 500 ms',
      cfg: native,
      setup: () => state.replies.push({ delayMs: 400, thinkingChunks: ['a', 'b', 'c', 'd', 'e', 'f'], chunkDelayMs: 100, content: 'Thought it through.' }),
      check: (r) => r.record.turns[0].firstEventMs >= 380 && r.record.turns[0].thinkingMs >= 450,
    },
    {
      name: 'F. stop 200 ms into three 2 s reads',
      setup: () => state.replies.push({ content: '', toolCalls: [read('f1', 'a.txt', 2000), read('f2', 'b.txt', 2000), read('f3', 'c.txt', 2000)] }),
      during: async () => {
        await sleep(200);
        agent.stop();
      },
      check: (r) => r.record.end === 'aborted' && agent.session.messages.filter((m) => m.role === 'tool').length === 3,
    },
    {
      name: 'G. provider fails once (503), then answers',
      setup: () => state.replies.push({ status: 503, error: 'busy (made-up)' }, { content: 'Done.' }),
      check: (r) => r.record.turns[0].attempts === 2 && r.record.turns[0].retryWaits.length === 1,
    },
  ];

  // Retries wait a fixed 1 s (no jitter) so before and after compare
  R.retryTiming.random = () => 0.5;
  const out = [];
  for (const s of scenarios) {
    const row = { name: s.name };
    for (const [label, limit] of [['before', 1], ['after', 4]]) {
      const walls = [];
      const recs = [];
      let ok = true;
      for (let i = 0; i < RUNS; i++) {
        const r = await once({ ...(s.cfg?.provider ? s.cfg : { ...base, ...(s.cfg ?? {}) }), toolConcurrency: limit }, s.setup, s.during);
        walls.push(r.ms);
        recs.push(r.record);
        if (!s.check(r)) ok = false;
      }
      const m = (f) => median(recs.map(f));
      row[label] = {
        median: Math.round(median(walls)),
        p95: Math.round(pct(walls, 95)),
        ok,
        model: Math.round(m((r) => r.summary.modelMs)),
        tools: Math.round(m((r) => r.summary.toolsMs)),
        checks: Math.round(m((r) => r.summary.checksMs)),
        other: Math.round(m((r) => r.summary.otherMs)),
        firstEvent: Math.round(m((r) => r.turns[0]?.firstEventMs ?? 0)),
        thinking: Math.round(m((r) => r.turns[0]?.thinkingMs ?? 0)),
        retryWait: Math.round(m((r) => r.summary.retryWaitMs)),
      };
    }
    out.push(row);
  }
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  if (JSON_OUT) console.log(JSON.stringify({ runs: RUNS, node: process.version, scenarios: out }, null, 2));
  else {
    console.log(`${RUNS} runs each; wall time of the whole run in ms (median / p95); before = toolConcurrency 1, after = 4\n`);
    console.log('| Scenario | Before | After | Holds | Timing record (after, medians) |');
    console.log('| --- | ---: | ---: | :---: | --- |');
    for (const r of out) {
      const a = r.after;
      const extra = [`model ${a.model}`, `tools ${a.tools}`];
      if (a.checks) extra.push(`checks ${a.checks}`);
      if (a.firstEvent >= 100) extra.push(`first event ${a.firstEvent}`);
      if (a.thinking) extra.push(`thinking ${a.thinking}`);
      if (a.retryWait) extra.push(`retry wait ${a.retryWait}`);
      extra.push(`other ${a.other}`);
      console.log(`| ${r.name} | ${r.before.median} / ${r.before.p95} | ${a.median} / ${a.p95} | ${r.before.ok && a.ok ? 'yes' : 'NO'} | ${extra.join(', ')} |`);
    }
  }
  process.exit(out.every((r) => r.before.ok && r.after.ok) ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
