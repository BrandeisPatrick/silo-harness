// Tool-call ids that repeat: Ollama numbers its calls per reply (and our own fallback ids restarted every run), so one
// session can hold two calls with the same id. Checked here: results pair with the nearest call before them (the
// transcript, the export, the Ollama request and compaction's cut points), new calls get ids unique in the session,
// a streamed reply keeps two calls apart by position even when they share an id, and two runs against the mock model
// (native Ollama and the OpenAI-style stream) each reusing call_0 leave every result with its own call.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { pairToolResults, toTranscript } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { toOllamaMessages } = require(path.join(projectDir, 'dist/main/ollama.js'));
const { cutPoints } = require(path.join(projectDir, 'dist/main/compact.js'));
const { uniqueCallIds } = require(path.join(projectDir, 'dist/main/agent/complete.js'));
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

(async () => {
  // ---------- A saved session whose two runs both used call_0_0 ----------
  const history = [
    { role: 'user', content: 'Read a.txt' },
    { role: 'assistant', content: '', tool_calls: [call('call_0_0', 'read_file', { path: 'a.txt' })] },
    { role: 'tool', tool_call_id: 'call_0_0', content: 'contents of A' },
    { role: 'assistant', content: 'A says hello.' },
    { role: 'user', content: 'Now list the folder' },
    { role: 'assistant', content: '', tool_calls: [call('call_0_0', 'list_directory', { path: '.' })] },
    { role: 'tool', tool_call_id: 'call_0_0', content: 'a.txt\nb.txt' },
    { role: 'assistant', content: 'Two files.' },
  ];
  const paired = pairToolResults(history);
  check('pairing: each result goes with the call just before it, not the last call with its id', paired.get(history[1].tool_calls[0])?.content === 'contents of A' && paired.get(history[5].tool_calls[0])?.content === 'a.txt\nb.txt', [...paired.values()].map((m) => m.content));

  const session = { id: 's1', title: 't', createdAt: 0, updatedAt: 0, messages: history };
  const rows = toTranscript(session).filter((i) => i.role === 'tool');
  check('the transcript shows each call with its own result', rows.length === 2 && rows[0].name === 'read_file' && rows[0].result === 'contents of A' && rows[1].name === 'list_directory' && rows[1].result === 'a.txt\nb.txt', rows.map((r) => [r.name, r.result]));

  const ol = toOllamaMessages(history).filter((m) => m.role === 'tool');
  check('the Ollama request names each result by its own call', ol.length === 2 && ol[0].tool_name === 'read_file' && ol[1].tool_name === 'list_directory', ol.map((m) => m.tool_name));

  const cuts = cutPoints(history);
  check('compaction never cuts between the first call and its result (the later call with the same id does not hide it)', cuts[2] === false && cuts[6] === false && cuts[4] === true, cuts);

  // Two calls of one reply sharing an id: results pair in order
  const twin = [
    { role: 'assistant', content: '', tool_calls: [call('call_0', 'read_file', { path: 'a' }), call('call_0', 'read_file', { path: 'b' })] },
    { role: 'tool', tool_call_id: 'call_0', content: 'first' },
    { role: 'tool', tool_call_id: 'call_0', content: 'second' },
  ];
  const twinPaired = pairToolResults(twin);
  check('two calls of one reply with one id: the results pair in order', twinPaired.get(twin[0].tool_calls[0])?.content === 'first' && twinPaired.get(twin[0].tool_calls[1])?.content === 'second');

  // ---------- uniqueCallIds ----------
  const fresh = uniqueCallIds([call('call_0_0', 'read_file'), call('call_0_0', 'read_file'), call('', 'grep'), call('toolu_abc', 'grep')], history);
  const ids = fresh.map((c) => c.id);
  check('an id the session already used is replaced', ids[0] !== 'call_0_0' && /^call_[0-9a-f]{24}$/.test(ids[0]), ids);
  check('a second call of the same reply with that id gets its own', ids[1] !== 'call_0_0' && ids[1] !== ids[0], ids);
  check('an empty id gets one', /^call_[0-9a-f]{24}$/.test(ids[2]), ids);
  check('an id that is already unique is kept', ids[3] === 'toolu_abc', ids);
  check('all four differ', new Set(ids).size === 4, ids);

  // ---------- Through the agent, against the mock model ----------
  const mock = await startMock();
  const { state } = mock;
  state.ollamaToolIds = true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-callids-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'alpha file');
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'beta file');
  let config = {
    provider: 'ollama',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: tmp, permissionMode: 'ask', autoApprove: false, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  const app = createApp({
    userData: tmp,
    appRoot: projectDir,
    loadConfig: () => config,
    saveConfig: (c) => (config = c),
    browser: () => ({ navigate: async () => '' }),
    artifacts: new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }),
  });
  const rt = app.runtime;
  const A = rt.foregroundId();
  const idle = () => waitFor(() => !rt.isRunning(A), 15000, 'the run to end');
  const readReply = (file) => ({ content: '', toolCalls: [{ id: 'call_0', name: 'read_file', args: { path: path.join(tmp, file) } }] });

  // Native Ollama: two runs, each calling read_file with id call_0
  state.replies.push(readReply('a.txt'), { content: 'Read A.' });
  rt.send(A, 'Read a.txt');
  await idle();
  state.replies.push(readReply('b.txt'), { content: 'Read B.' });
  rt.send(A, 'Read b.txt');
  await idle();
  const items = toTranscript(rt.get(A));
  const reads = items.filter((i) => i.role === 'tool' && i.name === 'read_file');
  check('Ollama, two runs reusing call_0: each read shows its own file', reads.length === 2 && /alpha file/.test(reads[0].result) && /beta file/.test(reads[1].result), reads.map((r) => r.result));
  const lastOllama = [...state.requests].reverse().find((r) => r.url.startsWith('/api/chat'));
  const sentTools = (lastOllama?.payload.messages ?? []).filter((m) => m.role === 'tool');
  const sentCalls = (lastOllama?.payload.messages ?? []).filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
  check('… the history sent back to Ollama carries two different call ids', sentCalls.length === 2 && new Set(sentCalls).size === 2, sentCalls);
  check('… and each result is sent with its own call\'s tool name and id', sentTools.length === 2 && sentTools.every((m) => m.tool_name === 'read_file') && sentTools[0].tool_call_id === sentCalls[0] && sentTools[1].tool_call_id === sentCalls[1], sentTools);

  // The OpenAI-style stream: a new session, the same call_0 in two runs, and two calls of one reply sharing an id
  app.updateConfig({ provider: 'portkey' });
  const B = rt.create({ foreground: true, cwd: tmp, origin: 'user' }).id;
  const idleB = () => waitFor(() => !rt.isRunning(B), 15000, 'the run to end');
  state.requests.length = 0;
  state.replies.push(readReply('a.txt'), { content: 'Read A.' });
  rt.send(B, 'Read a.txt');
  await idleB();
  state.replies.push({ content: '', toolCalls: [{ id: 'call_0', name: 'read_file', args: { path: path.join(tmp, 'a.txt') } }, { id: 'call_0', name: 'read_file', args: { path: path.join(tmp, 'b.txt') } }] }, { content: 'Read both.' });
  rt.send(B, 'Read both');
  await idleB();
  const lastV1 = [...state.requests].reverse().find((r) => r.url.startsWith('/v1/chat'));
  const v1Calls = (lastV1?.payload.messages ?? []).filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => ({ id: c.id, args: c.function.arguments })));
  const v1Results = (lastV1?.payload.messages ?? []).filter((m) => m.role === 'tool');
  check('stream: two calls of one reply with one id stay two calls (kept apart by position)', v1Calls.length === 3 && /b\.txt/.test(v1Calls[2].args) && /a\.txt/.test(v1Calls[1].args), v1Calls);
  check('stream: every call in the session has its own id', new Set(v1Calls.map((c) => c.id)).size === 3, v1Calls.map((c) => c.id));
  check('stream: each result goes back with its call\'s id, in order', v1Results.length === 3 && v1Results.every((m, i) => m.tool_call_id === v1Calls[i].id) && /beta file/.test(v1Results[2].content) && /alpha file/.test(v1Results[1].content), v1Results.map((m) => [m.tool_call_id, String(m.content).slice(0, 12)]));

  await mock.close?.();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
