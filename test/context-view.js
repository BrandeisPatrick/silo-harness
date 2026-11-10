// What the model is sent of the stored conversation (agent/context-view.ts): long tool output keeps its start and
// end (read_file is cut after a whole line, with the offset to go on from), old screenshots are left out, and the
// stored messages are never changed. Run: node test/context-view.js
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const view = require(path.join(projectDir, 'dist/main/agent/context-view.js'));
const { check, done } = require('./support/check.js');

const { modelMessages, MODEL_RESULT_CHARS, KEEP_SCREENSHOTS } = view;
const call = (id, name, args = {}) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });
const shot = (n) => ({ role: 'user', content: [{ type: 'text', text: `[Screenshot returned by browser_screenshot]` }, { type: 'image_url', image_url: { url: `data:image/png;base64,SHOT${n}` } }] });

// ---- 1: short output and other messages pass through unchanged, as the same objects ----
const small = [{ role: 'user', content: 'hi' }, call('a', 'bash', { command: 'ls' }), result('a', 'one\ntwo'), { role: 'assistant', content: 'done' }];
const same = modelMessages(small);
check('1: nothing to cut: the same messages, the same objects', same.length === small.length && same.every((m, i) => m === small[i]));

// ---- 1b: a context note right after the user's message comes before it; the stored order does not change ----
const A = require(path.join(projectDir, 'dist/main/agent/anthropic.js'));
const note = (n) => ({ role: 'user', content: `[Session context] note ${n}` });
const texts = (ms) => ms.map((m) => (typeof m.content === 'string' ? m.content : m.role));
const u1 = { role: 'user', content: 'U1' };
const n1 = note(1);
const first = [u1, n1];
check('1b: the note goes before the message it follows', texts(modelMessages(first)).join('|') === '[Session context] note 1|U1' && first[0] === u1 && first[1] === n1);
const toolFirst = [u1, call('t', 'bash'), result('t', 'out'), note(2)];
check('1b: …a note after a tool result stays where it is', modelMessages(toolFirst).every((m, i) => m === toolFirst[i]));
const afterReply = [u1, { role: 'assistant', content: 'hi' }, note(3)];
check('1b: …as does one after a reply', modelMessages(afterReply).every((m, i) => m === afterReply[i]));
const queued = [u1, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'U2' }, { role: 'user', content: 'U3' }, note(4)];
check('1b: two queued messages, then a note: the note before both, the rest in place', texts(modelMessages(queued)).join('|') === 'U1|hi|[Session context] note 4|U2|U3');
const loadAfter = [u1, n1, call('l', 'load_tools', { groups: ['browser'] }), result('l', 'Loaded browser.')];
check('1b: an early load after the note: note, message, load, result', texts(modelMessages(loadAfter)).join('|') === '[Session context] note 1|U1||Loaded browser.');
const grown = [u1, n1, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'U2' }, note(5)];
const v1 = modelMessages(first);
const v2 = modelMessages(grown);
check('1b: the first request is still the start of a later one', v1.every((m, i) => m === v2[i]) && texts(v2).join('|') === '[Session context] note 1|U1|A1|[Session context] note 5|U2');
const r1 = JSON.stringify(A.toAnthropic(v1).messages);
const r2 = JSON.stringify(A.toAnthropic(modelMessages([u1, n1, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'U2' }])).messages);
check('1b: …and so is its native request', r2.startsWith(r1.slice(0, -1)), [r1, r2]);
check('1b: the merged turn: the note, then the message after a blank line', JSON.stringify(A.toAnthropic(v1).messages[0].content) === JSON.stringify([{ type: 'text', text: '[Session context] note 1' }, { type: 'text', text: '\n\nU1' }]));
check('1b: the stored messages are untouched', grown[0] === u1 && grown[1] === n1 && grown.length === 5);

// ---- 2: a long read_file result is cut after a whole line, with the offset to continue ----
const lines = Array.from({ length: 3000 }, (_, i) => `${String(i + 1).padStart(4)}| ${'x'.repeat(40)} line ${i + 1}`);
const readText = `${lines.slice(0, 2000).join('\n')}\n…(3000 lines total; continue with offset=2001)`;
const reading = [{ role: 'user', content: 'read it' }, call('r', 'read_file', { path: 'big.ts' }), result('r', readText)];
const readOut = modelMessages(reading)[2].content;
const lastLine = /(\d+)\| [^\n]*\n…\(cut here/.exec(readOut);
check('2: read_file: under the cap, ends on a whole line', readOut.length <= MODEL_RESULT_CHARS + 200 && Boolean(lastLine), readOut.slice(-160));
check('2: …and says where to go on reading, and how long the file is', lastLine && readOut.includes(`continue with offset=${Number(lastLine[1]) + 1}`) && readOut.includes('the file has 3000 lines'), readOut.slice(-120));
check('2: the stored result is untouched', reading[2].content === readText);

// ---- 3: other long output keeps its start and its end (the exit code) ----
const out = `${'start '.repeat(4000)}${'middle '.repeat(6000)}${'end '.repeat(2000)}[exit code: 1]`;
const cmd = modelMessages([call('c', 'bash', { command: 'npm test' }), result('c', out)])[1].content;
check('3: a command: start and end kept, the middle left out with a note', cmd.length < MODEL_RESULT_CHARS + 300 && cmd.startsWith('start start') && cmd.endsWith('[exit code: 1]') && /characters of the middle left out to save context/.test(cmd), cmd.length);
check('3: output at the cap is not cut', modelMessages([call('d', 'grep'), result('d', 'y'.repeat(MODEL_RESULT_CHARS))])[1].content.length === MODEL_RESULT_CHARS);

// ---- 4: screenshots: the most recent ones keep their image, older ones are left out; the user's own images stay ----
const userImage = { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,MINE' } }] };
const shots = [userImage, call('s1', 'browser_screenshot'), result('s1', 'Screenshot saved'), shot(1), call('s2', 'browser_screenshot'), result('s2', 'Screenshot saved'), shot(2), call('s3', 'browser_screenshot'), result('s3', 'Screenshot saved'), shot(3)];
const v = modelMessages(shots);
const images = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url) : []);
check(`4: the ${KEEP_SCREENSHOTS} newest screenshots keep their image`, images(v[9])[0]?.endsWith('SHOT3') && images(v[6])[0]?.endsWith('SHOT2'));
check('4: an older one is a line saying it was left out', images(v[3]).length === 0 && /earlier screenshot was left out/.test(JSON.stringify(v[3].content)));
check("4: the user's own image is always sent", images(v[0])[0]?.endsWith('MINE') && v[0] === userImage);
check('4: the stored screenshot keeps its image', images(shots[3])[0]?.endsWith('SHOT1'));

// ---- 5: results set aside to save context: start and end only; which ones are set aside ----
const { resultsToPrune, PRUNE_BUDGET } = view;
const long = (n) => `${'h'.repeat(1500)}${String(n).repeat(3000)}${'t'.repeat(600)}`;
const conv = [{ role: 'user', content: 'first' }];
for (let i = 1; i <= 9; i++) conv.push(call(`p${i}`, 'read_file', { path: `f${i}` }), result(`p${i}`, i === 5 ? 'short' : long(i)));
conv.push({ role: 'assistant', content: 'read them' }, { role: 'user', content: 'second' }, call('p10', 'read_file'), result('p10', long(0)));
const isUser = (m) => m.role === 'user';
const picked = resultsToPrune(conv, new Set(), isUser);
check('5: set aside: before the last user message, not among the 6 latest results, not short ones', JSON.stringify(picked.sort()) === JSON.stringify(['p1', 'p2', 'p3', 'p4']), picked);
check('5: …and not those set aside already', JSON.stringify(resultsToPrune(conv, new Set(['p1', 'p2']), isUser).sort()) === JSON.stringify(['p3', 'p4']));
const pv = modelMessages(conv, new Set(picked));
const contentOf = (id) => pv.find((m) => m.role === 'tool' && m.tool_call_id === id).content;
check('5: a result set aside keeps its start and end with a note', /^h{1200}\n\[… \d+ characters cleared to save context\. Run the tool again if you need them\.\]\nt{500}$/.test(contentOf('p1')), contentOf('p1').length);
check('5: the others are sent whole', contentOf('p6') === long(6) && contentOf('p10') === long(0));
check('5: the budget is well below a large window', PRUNE_BUDGET >= 32000 && PRUNE_BUDGET <= 64000, PRUNE_BUDGET);

// ---- 6: an agent with a large window sets old output aside once a request passes the budget (on a provider that does
// not cache the prefix: a local LM Studio; one that does waits for the high-water mark, see prune-batches.js) ----
(async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { Agent } = require(path.join(projectDir, 'dist/main/agent.js'));
  const { SessionStore } = require(path.join(projectDir, 'dist/main/sessions.js'));
  const { startMock } = require('./support/mock-model.js');
  const mock = await startMock();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-view-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd);
  for (let i = 1; i <= 8; i++) fs.writeFileSync(path.join(cwd, `f${i}.txt`), `F${i}-START ${'word '.repeat(1200)}F${i}-END`);
  let config = {
    provider: 'local',
    providers: { local: { type: 'lmstudio', baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', contextWindow: 1_000_000 } },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 1_000_000 },
    ollama: { baseURL: 'http://127.0.0.1:1/v1', model: 'x', numCtx: 4096, think: 'auto' },
    workingDirectory: cwd, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: true, compactThreshold: 0.8, pruneToolResults: true, notifications: false, allowRules: {}, recentDirs: [],
  };
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const events = [];
  const agent = new Agent(() => config, { navigate: async (u) => u }, store, () => [], (ev) => events.push(ev));
  const streams = () => mock.state.requests.filter((r) => r.payload?.stream).map((r) => r.payload);
  const firstTurn = async () => {
    mock.state.replies.push({ content: '', toolCalls: Array.from({ length: 8 }, (_, i) => ({ id: `rf${i + 1}`, name: 'read_file', args: { path: `f${i + 1}.txt` } })) });
    // The model's report: past the budget, far below the window
    mock.state.replies.push({ content: 'Read all eight.', promptTokens: PRUNE_BUDGET + 4000 });
    await agent.run('Read f1.txt to f8.txt.');
  };
  await firstTurn();
  mock.state.replies.push({ content: 'ok' });
  await agent.run('And now?');
  const sent = streams().pop();
  const tools = sent.messages.filter((m) => m.role === 'tool');
  const cleared = tools.filter((m) => /characters cleared to save context/.test(m.content)).map((m) => m.tool_call_id);
  check('6: the next request has the two oldest results set aside, the six latest whole', JSON.stringify(cleared) === JSON.stringify(['rf1', 'rf2']) && tools.length === 8, cleared);
  const stored = agent.session.messages.filter((m) => m.role === 'tool');
  check('6: the session keeps every result whole (the tool rows show all of it)', stored.length === 8 && stored.every((m) => /F\d-END/.test(m.content)));
  check('6: and remembers what it set aside', JSON.stringify([...(agent.session.prunedResults ?? [])].sort()) === JSON.stringify(['rf1', 'rf2']), agent.session.prunedResults);
  check('6: no notice: nothing the user sees changed', !events.some((e) => e.type === 'error' && /Cleared/.test(e.message ?? '')));

  // A provider that caches the prefix: past the budget but under the high-water mark, nothing is set aside
  config = { ...config, provider: 'portkey' };
  agent.session = store.create({ cwd });
  await firstTurn();
  mock.state.replies.push({ content: 'ok' });
  await agent.run('And now?');
  const cachedView = streams().pop().messages.filter((m) => m.role === 'tool');
  check('6: a provider that caches the prefix: nothing set aside under the high-water mark', cachedView.length === 8 && cachedView.every((m) => /F\d-END/.test(m.content)) && !agent.session.prunedResults);
  config = { ...config, provider: 'local' };

  // Turned off with pruneToolResults: false
  config = { ...config, pruneToolResults: false };
  agent.session = store.create({ cwd });
  await firstTurn();
  mock.state.replies.push({ content: 'ok' });
  await agent.run('And now?');
  const off = streams().pop().messages.filter((m) => m.role === 'tool');
  check('6: pruneToolResults false: every result is sent whole', off.length === 8 && off.every((m) => /F\d-END/.test(m.content)) && !agent.session.prunedResults);

  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
