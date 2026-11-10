// Where a run's time goes (src/main/agent/perf.ts): the sums add up to the wall time with calls that ran together
// counted once; nothing private reaches a record, the /timing note or the log file (secrets fed through every entry
// point); a retry and a fallback are counted; a slow first event and a slow thinking phase show in the turn's numbers;
// the log is size-capped and rotated; recording costs next to nothing.
// Run: node test/timing.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const P = dist('agent/perf.js');
const R = dist('agent/retry.js');
const { setupTiming, NO_TIMING } = dist('timing-service.js');
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

/** A clock the test moves by hand. */
function fakeClock() {
  let t = 1000;
  return { now: () => t, tick: (ms) => (t += ms) };
}

(async () => {
  // ---------- 1: the sums ----------
  {
    const c = fakeClock();
    const run = new P.RunTimer({ session: 'a1b2c3d4', provider: 'anthropic', model: 'claude-opus-5-5', mode: 'auto', limit: 4 }, c, 0);
    c.tick(100); // the harness before turn 1
    const t1 = run.turn();
    c.tick(20);
    t1.step('build');
    t1.attempt();
    c.tick(500); // waiting
    t1.observe('thinking_delta');
    c.tick(300);
    t1.observe('thinking_delta'); // 300 thinking
    c.tick(200);
    t1.observe('text_delta'); // 200 writing
    c.tick(100);
    t1.toolDelta(); // 100 writing
    c.tick(50);
    t1.usage({ promptTokens: 20000, completionTokens: 900, cacheReadTokens: 18000, cacheWriteTokens: 0 });
    t1.end('tool_use', 3);
    // Three calls: two run together (one with a safety check), the third waits for a card
    const a = t1.tool('read_file', 1);
    const b = t1.tool('grep', 1);
    a.ready();
    b.ready();
    a.started();
    b.started();
    const pa = a.permission();
    pa.checkStarted();
    c.tick(400);
    pa.checkEnded('allow');
    pa.settle('check', true);
    c.tick(100);
    b.ran();
    b.done('ok');
    c.tick(100);
    a.ran();
    a.done('ok');
    a.stored(1);
    b.stored(1);
    const d = t1.tool('bash', 2);
    d.ready();
    d.started();
    const pd = d.permission();
    pd.cardShown();
    c.tick(1000);
    pd.cardAnswered();
    pd.settle('card', true);
    c.tick(200);
    d.ran();
    d.done('ok');
    t1.group(1, 2, 600);
    t1.group(2, 1, 1200);
    c.tick(30);
    const t2 = run.turn();
    t2.attempt();
    c.tick(400);
    t2.retryWait();
    c.tick(2000);
    t2.attempt();
    c.tick(300);
    t2.observe('text_delta');
    c.tick(100);
    t2.end('stop');
    c.tick(70);
    const r = run.finish('done');
    const s = r.summary;
    const parts = s.modelMs + s.toolsMs + s.checksMs + s.approvalsMs + s.otherMs;
    check('1: the parts add up to the wall time', parts === s.wallMs && s.wallMs === 5970, { parts, s });
    check('1: waiting + thinking + writing = the model time', s.waitingMs + s.thinkingMs + s.writingMs === s.modelMs && s.thinkingMs === 300 && s.writingMs === 350 + 100, s);
    check('1: two calls that ran together count once; the check and the card are taken out of the tools', s.checksMs === 400 && s.approvalsMs === 1000 && s.toolsMs === 1800 - 400 - 1000 && s.otherMs === 120 + 30 + 70, s);
    check('1: alongside: the two reads ran together, the command alone', r.tools[0].alongside === 1 && r.tools[1].alongside === 1 && r.tools[2].alongside === 0, r.tools.map((t) => t.alongside));
    check('1: execution leaves the permission time out', r.tools[0].execMs === 200 && r.tools[2].execMs === 200 && r.tools[2].permission[0].humanMs === 1000, r.tools.map((t) => t.execMs));
    check('1: a retry and its wait are counted; the turn after it measures from the first attempt', s.retries === 1 && s.retryWaitMs === 2000 && r.turns[1].attempts === 2 && r.turns[1].endMs === 2800 && r.turns[1].waitingMs === 2700, r.turns[1]);
    check('1: unknown stays unknown (no tokens reported: absent, not 0)', r.turns[1].promptTokens === undefined && !('cacheReadTokens' in r.turns[1] && r.turns[1].cacheReadTokens !== undefined));
    const note = P.formatRun(r);
    check('1: the note has the owner\'s shape', note === '6s · model 4s (2 turns: waiting 3s, thinking 0.3s, writing 0.5s) · tools 0.4s (3 calls) · safety checks 0.4s · your approvals 1s · other 0.2s\nSlowest turn: #2, 3s (waiting 3s, writing 0.1s, 1 retry)', note);
    check('1: durations read as the owner wrote them', P.duration(553000) === '9m 13s' && P.duration(52000) === '52s' && P.duration(125000) === '2m 05s' && P.duration(400) === '0.4s' && P.duration(3_720_000) === '1h 02m');
  }

  // ---------- 2: privacy, the pure entry points ----------
  {
    const SECRETS = ['sk-ant-SECRET123', '/Users/jdoe/secret-project', 'https://internal.example.com/x', 'acme-corp', 'Project Falcon', 'jdoe@example.com'];
    P.setBuiltInToolNames(['read_file', 'bash', 'grep']);
    check('2: a tool name is kept only when built in', P.toolLabel('read_file') === 'read_file' && P.toolLabel('mcp__acme-corp__query') === 'mcp' && P.toolLabel('Project Falcon') === 'other' && P.toolLabel('sk-ant-SECRET123') === 'other');
    check('2: the model keeps its last segment, a fine-tuned id nothing', P.modelLabel('@acme-corp/claude-opus-5-5') === 'claude-opus-5-5' && P.modelLabel('ft:gpt-4o:acme-corp:falcon:abc') === 'fine-tuned' && P.modelLabel('/Users/jdoe/secret-project/model.gguf') === 'model.gguf' && P.modelLabel('jdoe@example.com') === 'other' && P.modelLabel('https://internal.example.com/x') === 'x');
    check('2: the provider only as a known type', P.providerLabel('anthropic') === 'anthropic' && P.providerLabel('acme-corp') === 'other' && P.providerLabel('https://internal.example.com/x') === 'other');
    const c = fakeClock();
    const run = new P.RunTimer({ session: 'sk-ant-SECRET123', provider: 'https://internal.example.com/x', model: 'jdoe@example.com', mode: 'Project Falcon', limit: '/Users/jdoe/secret-project' }, c, 0);
    const t = run.turn();
    t.step('/Users/jdoe/secret-project');
    t.attempt();
    t.fallback('sk-ant-SECRET123');
    t.observe('acme-corp');
    t.usage({ promptTokens: 'sk-ant-SECRET123', completionTokens: 5 });
    t.end('jdoe@example.com', 'acme-corp');
    const tool = t.tool('Project Falcon', 'acme-corp');
    const p = tool.permission();
    p.checkStarted();
    p.checkEnded('sk-ant-SECRET123', 'x');
    p.settle('/Users/jdoe/secret-project', 'acme-corp');
    tool.done('https://internal.example.com/x');
    t.group('acme-corp', 'Project Falcon', 'x');
    const out = JSON.stringify(run.finish('jdoe@example.com')) + P.formatRun(run.finish('x'));
    const leaked = SECRETS.filter((x) => out.includes(x));
    check('2: secrets through every entry point of the recorder: none in the record or the note', leaked.length === 0, leaked);
  }

  // ---------- 3: a real run: secrets in the prompt, arguments, paths, URLs, output, title, base URL, key ----------
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-timing-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const secretDir = path.join(tmp, 'falcon-secret-dir');
  fs.mkdirSync(secretDir);
  fs.writeFileSync(path.join(secretDir, 'notes-SECRETFILE.txt'), 'OUTPUT-SECRET-CONTENT');
  const userData = path.join(tmp, 'userdata');
  let config = {
    provider: 'acme-corp-provider',
    providers: { 'acme-corp-provider': { type: 'openai-compatible', baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'sk-ant-SECRETKEY99', model: '@acme-corp/mock-model', headers: {} } },
    ollama: { baseURL: 'http://127.0.0.1:1', model: 'm', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: '', apiKey: '', model: '', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: secretDir, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: 'SYSTEM-SECRET-EXTRA', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, timingLog: true,
  };
  const store = new SessionStore(path.join(tmp, 'sessions'));
  let events = [];
  const app = { userData, service: () => undefined, window: () => null };
  const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], (ev) => events.push(ev), undefined, undefined, undefined, { app, hooks: null });
  agent.session.title = 'Session Title SECRET';
  state.replies.push(
    { content: 'Looking.', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'echo CMD-SECRET-TOKEN https://internal.example.com/x' } }, { id: 'c2', name: 'read_file', args: { path: path.join(secretDir, 'notes-SECRETFILE.txt') } }, { id: 'c3', name: 'mcp__acme-corp__secret_tool', args: { q: 'MCP-SECRET-ARG' } }] },
    { content: 'Answer with OUTPUT-SECRET-CONTENT.' },
  );
  await agent.run('PROMPT-SECRET please read the file');
  const record = agent.lastTiming();
  check('3: a run leaves a record with its turns and calls', record && record.turns.length === 2 && record.tools.length === 3 && record.end === 'done', record && { turns: record.turns.length, tools: record.tools.length, end: record.end });
  check('3: …the provider as its type, the model as its last segment, MCP as mcp', record.provider === 'openai-compatible' && record.model === 'mock-model' && record.tools.map((t) => t.name).join() === 'bash,read_file,mcp', record.tools.map((t) => t.name));
  check('3: …tokens from the provider; the first event and text timed', record.turns[0].promptTokens === 300 && record.turns[0].firstEventMs !== undefined && record.turns[1].firstTextMs !== undefined && record.turns[0].firstToolMs !== undefined);
  check('3: …outcomes: the command ran, the read ran, the unknown tool failed', record.tools[0].outcome === 'ok' && record.tools[1].outcome === 'ok' && record.tools[2].outcome === 'failed', record.tools.map((t) => t.outcome));
  check('3: …the session is a short random id', /^[0-9a-f]{8}$/.test(record.session) && record.session !== agent.session.id.slice(0, 8));
  const s3 = record.summary;
  check('3: …the parts add up to the wall time', s3.modelMs + s3.toolsMs + s3.checksMs + s3.approvalsMs + s3.otherMs === s3.wallMs, s3);
  // The log file: the same record, written off the run's path
  const logFile = path.join(userData, 'timing', 'timing.jsonl');
  for (let i = 0; i < 50 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 20));
  const logged = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('3: timingLog on: one JSON line in <profile>/timing/timing.jsonl', logged.trim().split('\n').length === 1 && JSON.parse(logged).run === record.run);
  const all = JSON.stringify(record) + logged + P.formatRun(record);
  const SECRETS = ['PROMPT-SECRET', 'CMD-SECRET-TOKEN', 'internal.example.com', 'SECRETFILE', 'falcon-secret-dir', 'OUTPUT-SECRET-CONTENT', 'MCP-SECRET-ARG', 'secret_tool', 'acme-corp', 'Session Title SECRET', 'sk-ant-SECRETKEY99', `127.0.0.1:${mock.port}`, 'SYSTEM-SECRET-EXTRA', agent.session.id, tmp];
  const leaked = SECRETS.filter((x) => all.includes(x));
  check('3: nothing private in the record, the log or the note', leaked.length === 0, leaked);

  // /timing: the note, answered locally
  {
    const commands = [];
    const fake = { commands: { register: (c) => commands.push(c) }, runtime: { get: (id) => (id === agent.session.id ? agent.session : undefined), agentFor: () => agent } };
    setupTiming(fake);
    const cmd = commands.find((c) => c.name === 'timing');
    const res = await cmd.run('', { sessionId: agent.session.id });
    check('3: /timing answers with the note for the session on screen', cmd && typeof res.notice === 'string' && res.notice === P.formatRun(record) && /^.+ · model .+ turns: waiting .+ · tools .+ · other /.test(res.notice), res.notice);
    check('3: /timing in a session that never ran says so', (await cmd.run('', { sessionId: 'nope' })).notice === NO_TIMING);
  }

  // ---------- 4: a retry and a fallback are counted ----------
  config = { ...config, timingLog: false };
  R.retryTiming.sleep = async (ms, signal) => {
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  R.retryTiming.random = () => 0.5;
  events = [];
  state.replies.length = 0;
  state.replies.push({ status: 503, error: 'busy (mock)' }, { status: 503, error: 'busy (mock)' }, { content: 'Fine.' });
  agent.session = store.create();
  await agent.run('Hi');
  const rr = agent.lastTiming();
  check('4: two failed attempts and a third: attempts 3, two retry waits', rr.turns[0].attempts === 3 && rr.turns[0].retryWaits.length === 2 && rr.summary.retries === 2, rr.turns[0]);
  state.replies.push({ status: 400, error: 'Bad request (mock)' }, { content: 'Once.', nonStream: true });
  agent.session = store.create();
  await agent.run('Again');
  const rf = agent.lastTiming();
  check('4: a refused stream falls back to one request: counted as non_streaming', rf.turns[0].fallbacks.join() === 'non_streaming' && rf.turns[0].attempts === 1 && rf.summary.fallbacks === 1 && rf.turns[0].finish === 'stop', rf.turns[0]);
  check('4: …the slowest-turn line names the fallback', /fallback: non_streaming/.test(P.formatRun(rf)), P.formatRun(rf));
  R.retryTiming.sleep = R.abortableSleep;
  R.retryTiming.random = Math.random;

  // ---------- 5: the native path: a late first event and a slow thinking phase ----------
  config = {
    ...config,
    provider: 'claude',
    providers: { claude: { type: 'anthropic', baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'sk-test-native-key', model: 'claude-opus-5-5', headers: {} } },
  };
  state.replies.push({ delayMs: 300, thinkingChunks: ['a', 'b', 'c', 'd', 'e'], chunkDelayMs: 80, content: 'Done thinking.' });
  agent.session = store.create();
  await agent.run('Think');
  const tn = agent.lastTiming().turns[0];
  check('5: the first event comes after the delay', tn.firstEventMs >= 280, tn);
  check('5: thinking spans the thinking chunks; writing follows; the three add up', tn.thinkingMs >= 300 && tn.firstThinkingMs >= 280 && tn.firstTextMs > tn.firstThinkingMs && tn.waitingMs + tn.thinkingMs + tn.writingMs === tn.endMs, tn);
  check('5: the provider and model as recorded', agent.lastTiming().provider === 'anthropic' && agent.lastTiming().model === 'claude-opus-5-5');

  // ---------- 6: the log rotates at its cap ----------
  {
    const dir = path.join(tmp, 'rot');
    const log = new P.TimingLog(dir, 3000);
    const rec = agent.lastTiming();
    for (let i = 0; i < 6; i++) await log.append(rec);
    const cur = fs.readFileSync(path.join(dir, 'timing.jsonl'), 'utf8');
    const old = fs.existsSync(path.join(dir, 'timing.1.jsonl'));
    check('6: past its cap the log moves to timing.1.jsonl and starts again', old && Buffer.byteLength(cur) <= 3000 + JSON.stringify(rec).length, { size: Buffer.byteLength(cur), old });
    check('6: SILO_TIMING=1 or the setting turns it on, nothing else', P.timingLogOn({}, { SILO_TIMING: '1' }) && P.timingLogOn({ timingLog: true }, {}) && !P.timingLogOn({}, {}) && !P.timingLogOn({ timingLog: 'yes' }, { SILO_TIMING: 'true' }));
  }

  // ---------- 7: the cost of recording ----------
  {
    const run = new P.RunTimer({ session: 'a1b2c3d4' });
    const t = run.turn();
    t.attempt();
    const N = 200_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      t.event();
      t.observe(i % 3 ? 'text_delta' : 'thinking_delta');
    }
    const perEvent = ((performance.now() - t0) * 1e6) / (N * 2);
    const t1 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const tool = t.tool('read_file', 1);
      tool.ready();
      tool.started();
      tool.permission().settle('rule', true);
      tool.ran();
      tool.done('ok');
    }
    const perTool = ((performance.now() - t1) * 1e3) / 1000;
    t.end('stop');
    const t2 = performance.now();
    run.finish('done');
    const finishMs = performance.now() - t2;
    console.log(`  cost: ${perEvent.toFixed(0)} ns per streamed event, ${perTool.toFixed(1)} µs per tool call, ${finishMs.toFixed(1)} ms to sum up a run of 1000 calls`);
    check('7: under 2 µs per streamed event and 50 µs per tool call', perEvent < 2000 && perTool < 50, { perEvent, perTool });
  }

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
