// Compaction: the cut (property-style), pruning, the tail kept verbatim, checkpoints, the fallbacks, the context-length
// retry, the threshold setting, the context breakdown and its service. Headless, against a mock OpenAI-compatible model
// that reports prompt sizes from what it receives and rejects malformed requests.
// Run: node test/compaction.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { Agent, contextLimit } = require(path.join(projectDir, 'dist/main/agent.js'));
const { SessionStore, toTranscript, rewindSession } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { McpManager } = require(path.join(projectDir, 'dist/main/mcp.js'));
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { setupContext } = require(path.join(projectDir, 'dist/main/context-service.js'));
const C = require(path.join(projectDir, 'dist/main/compact.js'));
const { check, done } = require('./support/check.js');
const TEST_SERVER = path.join(__dirname, 'support', 'test-mcp-server.js');

// ---------- A mock model ----------

/** Why a chat request is malformed (a result without its call, or a call left unanswered), or null. */
function malformed(messages) {
  let open = new Set();
  let issued = new Set();
  for (const [i, m] of messages.entries()) {
    if (m.role === 'assistant') {
      if (open.size) return `message ${i}: assistant before results of ${[...open].join(',')}`;
      issued = new Set((m.tool_calls || []).map((c) => c.id));
      open = new Set(issued);
    } else if (m.role === 'tool') {
      if (!issued.has(m.tool_call_id)) return `message ${i}: result for unknown call ${m.tool_call_id}`;
      open.delete(m.tool_call_id);
    }
  }
  return null;
}

function startModel() {
  const state = { requests: [], replies: [], summary: '## 1. Request and intent\nRead notes.txt and remember the code word (falcon).\n\n## 8. Next step\n(none)', summaryFails: false, summaryDelayMs: 0, failStreams: 0, failMessage: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9100 tokens." };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      state.requests.push(payload);
      const json = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const bad = malformed(payload.messages || []);
      if (bad) return json(400, { error: { message: `Invalid request: ${bad}`, type: 'invalid_request_error' } });
      if (!payload.stream) {
        return setTimeout(() => {
          if (state.summaryFails) return json(500, { error: { message: 'summary failed (test)' } });
          const content = typeof state.summary === 'function' ? state.summary(payload) : state.summary;
          json(200, { id: 's', object: 'chat.completion', created: 0, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 100 } });
        }, state.summaryDelayMs);
      }
      if (state.failStreams > 0) {
        state.failStreams--;
        return json(400, { error: { message: state.failMessage, type: 'invalid_request_error', code: 'context_length_exceeded' } });
      }
      const reply = state.replies.shift() || { content: 'Done.' };
      // The prompt size the mock "saw": about four characters per token of what it was sent.
      const promptTokens = Math.ceil((JSON.stringify(payload.messages).length + JSON.stringify(payload.tools || []).length) / 4);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: payload.model, ...obj })}\n\n`);
      if (reply.content) send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.content } }] });
      if (reply.toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: reply.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 20 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ state, port: server.address().port, close: () => server.close() })));
}

// ---------- Random conversations for the cut property ----------

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomConversation(rand) {
  const msgs = [];
  let id = 0;
  if (rand() < 0.3) msgs.push({ role: 'user', content: C.compactedPreamble('An earlier brief.') });
  const turns = 1 + Math.floor(rand() * 5);
  for (let t = 0; t < turns; t++) {
    msgs.push({ role: 'user', content: `request ${t} ${'u'.repeat(Math.floor(rand() * 400))}` });
    const steps = Math.floor(rand() * 5);
    for (let k = 0; k < steps; k++) {
      const calls = Math.floor(rand() * 4);
      const a = { role: 'assistant', content: rand() < 0.5 ? 'thinking '.repeat(Math.floor(rand() * 30)) : '' };
      if (calls) a.tool_calls = Array.from({ length: calls }, () => ({ id: `t${++id}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `f${id}.txt` }) } }));
      msgs.push(a);
      for (const c of a.tool_calls || []) {
        msgs.push({ role: 'tool', tool_call_id: c.id, content: 'r'.repeat(Math.floor(rand() * 3000)) });
        if (rand() < 0.2) msgs.push({ role: 'user', content: [{ type: 'text', text: `[Screenshot returned by ${c.function.name}]` }, { type: 'image_url', image_url: { url: 'data:x' } }] });
      }
    }
    if (rand() < 0.8) msgs.push({ role: 'assistant', content: 'answer '.repeat(Math.floor(rand() * 100)) });
  }
  return msgs;
}

/** True when cutting before `cut` keeps every call with its results. */
function cleanCut(msgs, cut) {
  const callAt = new Map();
  msgs.forEach((m, i) => (m.tool_calls || []).forEach((c) => callAt.set(c.id, i)));
  for (let i = cut; i < msgs.length; i++) if (msgs[i].role === 'tool' && !(callAt.get(msgs[i].tool_call_id) >= cut)) return false;
  for (let i = 0; i < cut; i++) if (msgs[i].role === 'tool' && callAt.get(msgs[i].tool_call_id) >= cut) return false;
  return true;
}

// ---------- The suite ----------

(async () => {
  // ---- 1: the cut, property-style ----
  const rand = rng(42);
  let bad = 0;
  let badTail = 0;
  let badInside = 0;
  let cuts = 0;
  for (let n = 0; n < 1500; n++) {
    const msgs = randomConversation(rand);
    const tail = Math.floor(rand() * 3000);
    const cut = C.findCut(msgs, tail);
    const lastUser = C.lastUserIndex(msgs);
    if (cut > 0) cuts++;
    if (!cleanCut(msgs, cut)) bad++;
    const kept = C.estimateTokens(msgs.slice(cut));
    if (cut > 0 && (cut > lastUser || (kept < tail && cut !== lastUser))) badTail++;
    const inside = C.findCut(msgs, tail, { insideTurn: true });
    if (!cleanCut(msgs, inside) || (inside > 0 && inside >= msgs.length)) badInside++;
  }
  check('1: no cut ever splits a call from its results (1500 random conversations)', bad === 0, { bad, cuts });
  check('1: the tail keeps the last user message onward and about the tail size', badTail === 0, { badTail });
  check('1: an inside-the-turn cut is clean too and never empties the tail', badInside === 0, { badInside });
  {
    const m = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a'.repeat(4000) },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'x', content: 'b'.repeat(4000) },
      { role: 'assistant', content: 'done' },
    ];
    check('1: tail rule: a small tail still keeps the whole last turn', C.findCut(m, 10) === 2);
    check('1: tail rule: a larger tail moves the cut earlier; one larger than everything keeps what precedes the last request foldable', C.findCut(m, 1500) === 1 && C.findCut(m, 100000) === 2);
    check('1: only an earlier brief before the last request is nothing to fold', C.findCut([{ role: 'user', content: C.compactedPreamble('x') }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }], 10) === 0);
    check('1: inside the turn: the cut can fall after the last user message on a clean boundary', C.findCut(m.slice(2), 10, { insideTurn: true }) === 1 && C.findCut(m.slice(2, 4).concat([{ role: 'tool', tool_call_id: 'x', content: 'short' }, { role: 'assistant', content: 'done' }]), 2, { insideTurn: true }) === 3, C.findCut(m.slice(2), 10, { insideTurn: true }));
  }

  // ---- 2: pruning ----
  {
    const call = (id, name = 'read_file') => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: '{"path":"p"}' } }] });
    const msgs = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 9; i++) {
      msgs.push(call(`r${i}`));
      msgs.push({ role: 'tool', tool_call_id: `r${i}`, content: i === 1 ? 'short result' : `HEAD${i}` + 'x'.repeat(3000) + `TAIL${i}` });
    }
    msgs.push({ role: 'user', content: [{ type: 'text', text: 'img1' }, { type: 'image_url', image_url: { url: 'data:1' } }] });
    msgs.push({ role: 'user', content: [{ type: 'text', text: 'img2' }, { type: 'image_url', image_url: { url: 'data:2' } }] });
    msgs.push({ role: 'user', content: [{ type: 'text', text: 'img3' }, { type: 'image_url', image_url: { url: 'data:3' } }] });
    msgs.push({ role: 'user', content: 'the last request' });
    msgs.push(call('late'));
    msgs.push({ role: 'tool', tool_call_id: 'late', content: 'z'.repeat(5000) });
    const r = C.pruneMessages(msgs);
    const res = (i) => r.messages.find((m) => m.role === 'tool' && m.tool_call_id === `r${i}`).content;
    // 10 results in all; the 6 most recent (r4..r8, late) are left alone; of r0..r3 the short one is left alone.
    check('2: old long results pruned, the 6 most recent and short ones kept', r.results === 3 && /cleared to save context/.test(res(0)) && /cleared/.test(res(2)) && /cleared/.test(res(3)) && res(1) === 'short result' && !/cleared/.test(res(4)), r.results);
    const p0 = res(0);
    check('2: a pruned result keeps its first 1200 and last 500 characters around the marker', p0.startsWith('HEAD0' + 'x'.repeat(1195)) && p0.endsWith('x'.repeat(495) + 'TAIL0') && /\n\[… \d+ characters cleared to save context\. Run the tool again if you need them\.\]\n/.test(p0) && p0.split('\n')[1].includes(String(3010 - 1700)), p0.split('\n')[1]);
    check('2: images older than the two most recent become a placeholder', r.images === 1 && r.messages[19].content[1].type === 'text' && /image was removed/.test(r.messages[19].content[1].text) && r.messages[20].content[1].type === 'image_url' && r.messages[21].content[1].type === 'image_url', r.messages[19].content);
    check('2: the last user message and everything after it are untouched', r.messages[22] === msgs[22] && r.messages[24] === msgs[24] && r.messages[24].content.length === 5000);
    check('2: unchanged messages keep their identity; tokens saved are counted', r.messages[1] === msgs[1] && r.saved > 1500 && C.estimateTokens(r.messages) === C.estimateTokens(msgs) - r.saved);
    const again = C.pruneMessages(r.messages);
    check('2: pruning again changes nothing', again.results === 0 && again.images === 0);
    const hard = C.pruneMessages(r.messages, C.PRUNE_HARD);
    check('2: hard pruning: all but the last two results down to ~400 characters, the turn included', hard.results >= 6 && hard.messages.filter((m) => m.role === 'tool').slice(0, -2).every((m) => m.content.length < 520) && hard.messages[24].content.length === 5000, hard.results);
  }

  // ---- 3: summary request, brief and helpers ----
  {
    const folded = [
      { role: 'user', content: C.compactedPreamble('## 1. Request and intent\nOld.', { read: ['old.txt'], edited: [] }) },
      { role: 'user', content: 'edit it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'e', type: 'function', function: { name: 'edit_file', arguments: '{"path":"src/a.ts","old":"x","new":"y"}' } }, { id: 'r', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'e', content: 'ok' },
      { role: 'tool', tool_call_id: 'r', content: 'readme' },
    ];
    const f = C.filesTouched(folded);
    check('3: files touched: edited and read paths, merged with the earlier brief', f.edited.join() === 'src/a.ts' && f.read.includes('README.md') && f.read.includes('old.txt'), f);
    const req = C.summaryRequest(folded, { focus: 'the tests', tasks: [{ id: '1', title: 'Write tests', status: 'in_progress' }], plan: { title: 'Widget plan', status: 'approved' } }, 20000);
    const sys = req[0].content;
    const sections = ['Request and intent', 'Key facts and concepts', 'Files and code', 'Errors and fixes', 'Messages from the user', 'Pending work', 'Current work', 'Next step'];
    check('3: the prompt asks for the eight sections in order, each always present', sections.every((s, i) => sys.indexOf(`## ${i + 1}. ${s}`) > (i ? sys.indexOf(`## ${i}. ${sections[i - 1]}`) : -1)) && /\(none\)/.test(sys) && /never invent/i.test(sys) && /merge it/i.test(sys));
    const u = req[1].content;
    check('3: the request carries the task list, the plan status and the focus after the transcript', /EARLIER SUMMARY:\n## 1\. Request and intent\nOld\./.test(u) && !/Files touched/.test(u) && u.indexOf('Current task list:\n- [in_progress] Write tests') > u.indexOf('Transcript:') && /Latest plan: "Widget plan" \(approved\)/.test(u) && /focus on: the tests/.test(u));
    const brief = C.compactedPreamble(C.cleanSummary('## 1. Request\nx\n\n## Files touched\n- read: made-up'), f);
    check('3: the brief ends with a Files touched list written by the app, not the model', C.isCompactPreamble({ role: 'user', content: brief }) && /## Files touched\n[^\n]*\n- edited: src\/a\.ts\n- read: /.test(brief) && !/made-up/.test(brief));
    check('3: context-length errors are recognised', ["This model's maximum context length is 8192 tokens", 'prompt is too long: 9000 tokens > 8192 maximum', 'Request exceeds the context window', 'too many tokens', 'input length and max_tokens exceed context length', 'Ollama returned HTTP 413'].every((m) => C.isContextLengthError(new Error(m))) && C.isContextLengthError({ status: 413, message: 'x' }) && !C.isContextLengthError(new Error('HTTP 500: overloaded')));
    check('3: threshold kept within 0.5 to 0.95', C.compactThreshold({ compactThreshold: 0.3 }) === 0.5 && C.compactThreshold({ compactThreshold: 0.99 }) === 0.95 && C.compactThreshold({}) === 0.8 && C.compactThreshold({ compactThreshold: 0.65 }) === 0.65);
    check('3: scaleTo adds up exactly', C.scaleTo([1, 1, 1], 100).reduce((a, b) => a + b) === 100 && C.scaleTo([5, 0, 3], 7).reduce((a, b) => a + b) === 7 && C.scaleTo([0, 0], 4).join() === '4,0');
  }

  // ---- The agent against the mock ----
  const model = await startModel();
  const { state } = model;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-compaction-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd);
  for (const name of 'abcdefghij') fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name.toUpperCase()}-START ` + `${name}word `.repeat(900) + `${name.toUpperCase()}-END`);
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'The code word is falcon.');
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const mutations = [];
  store.onMutation((s, op) => mutations.push({ sid: s.id, kind: op.kind, reason: op.reason }));
  const artifacts = new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') });
  const baseConfig = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${model.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 12380 },
    // 12,000 until the system prompt's guidance on reads, searches and evidence (about 120 tokens) came in; 12,150
    // until the bullet asking for short updates while working (about 60 tokens); 12,240 until the bash tool's path
    // argument with its two sentences and edit_file's edits list (about 110 tokens)
    workingDirectory: cwd, permissionMode: 'bypass', autoApprove: true, maxTurns: 30, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: true, compactThreshold: 0.8, pruneToolResults: true, notifications: false, allowRules: {}, recentDirs: [],
    // Changed on purpose: the window sizes below were chosen with every tool offered from the first request; tool
    // groups loaded when needed (the default now) make that floor smaller, which is not what these checks are about.
    toolSet: 'all',
  };
  let config = { ...baseConfig };
  let events = [];
  const agent = new Agent(() => config, { navigate: async (u) => u }, store, () => [], (ev) => events.push(ev), undefined, artifacts);
  let id = 0;
  const read = (file) => ({ toolCalls: [{ id: `k${++id}`, name: 'read_file', args: { path: file } }] });
  const reset = () => {
    events = [];
    state.requests.length = 0;
    state.replies.length = 0;
    mutations.length = 0;
  };
  const streams = () => state.requests.filter((q) => q.stream);
  const summaries = () => state.requests.filter((q) => !q.stream);
  const notices = () => events.filter((e) => e.type === 'error' && e.kind === 'notice').map((e) => e.message);
  const runEnd = () => events.find((e) => e.type === 'run_end');
  const fresh = (patch = {}) => {
    config = { ...baseConfig, ...patch, portkey: { ...baseConfig.portkey, ...(patch.portkey || {}) } };
    agent.session = store.create({ cwd });
    reset();
  };
  /** A first turn that reads notes.txt and answers at length: something worth folding later */
  const firstTurn = async () => {
    state.replies.push(read('notes.txt'));
    state.replies.push({ content: 'The code word is falcon. ' + 'Here is a long explanation of it. '.repeat(160) });
    await agent.run('Read notes.txt and remember the code word.');
  };
  const base = agent.contextInfo().tokens;
  check('4: setup: the prompt and tools take a few thousand tokens of the 12k window', base > 2500 && base < 6000, base);

  // ---- 4: prune only, when that is enough ----
  // On a provider that does not cache the prefix (a local LM Studio here); where it is cached, prune-batches.js
  const local = (window) => ({ provider: 'local', providers: { local: { type: 'lmstudio', baseURL: `http://127.0.0.1:${model.port}/v1`, model: 'mock', contextWindow: window } } });
  fresh(local(24000));
  for (const f of 'abcdefgh') state.replies.push(read(`${f}.txt`));
  state.replies.push({ content: 'Read them all.' });
  await agent.run('Read a.txt to h.txt, one at a time.');
  const lastTurn1 = JSON.stringify(streams().slice(-1)[0].messages).length;
  check('4: a long single turn: nothing is pruned or folded inside it', runEnd().reason === 'done' && !mutations.some((m) => m.reason) && !events.some((e) => e.type === 'compact_start'), notices());
  const lastPromptBefore = agent.contextInfo().tokens;
  reset();
  state.replies.push({ content: 'The first word was AWORD.' });
  await agent.run('What was the first word of a.txt?');
  const pruneOps = mutations.filter((m) => m.kind === 'replace');
  const results = agent.session.messages.filter((m) => m.role === 'tool');
  check('4: past 60% the next turn prunes the old results beyond the 6 most recent, through the store', pruneOps.length === 1 && pruneOps[0].reason === 'prune' && results.filter((m) => /cleared to save context/.test(m.content)).length === 2 && /cleared/.test(results[1].content) && !/cleared/.test(results[3].content), { pruneOps, lastPromptBefore });
  check('4: prune only: it was enough, so no summary was made', !events.some((e) => e.type === 'compact_start') && summaries().length === 0 && !agent.session.compactions);
  check('4: a quiet notice says how much was cleared', notices().some((n) => /^Cleared [\d.]+k? tokens of old tool output/.test(n)), notices());
  check('4: the request after pruning is well-formed and smaller', runEnd().reason === 'done' && JSON.stringify(streams()[0].messages).length < lastTurn1, { lastTurn1, now: JSON.stringify(streams()[0].messages).length });
  // the kill switch
  fresh({ ...local(24000), pruneToolResults: false });
  for (const f of 'abcdefgh') state.replies.push(read(`${f}.txt`));
  state.replies.push({ content: 'ok' });
  await agent.run('Read a.txt to h.txt, one at a time.');
  reset();
  state.replies.push({ content: 'ok' });
  await agent.run('Next?');
  check('4: pruneToolResults=false: nothing is pruned', !mutations.some((m) => m.reason === 'prune') && !notices().some((n) => /Cleared/.test(n)) && !agent.session.messages.some((m) => m.role === 'tool' && /cleared/.test(m.content)));

  // ---- 5: compaction keeps the tail; checkpoints and rewinding ----
  fresh();
  await firstTurn();
  agent.session.tasks = [{ id: 't1', title: 'Read the files', status: 'in_progress' }];
  reset();
  for (const f of 'abc') state.replies.push(read(`${f}.txt`));
  state.replies.push({ content: 'Words: AWORD BWORD CWORD. The code word is falcon.' });
  await agent.run('Now read a.txt, b.txt and c.txt.');
  const s5 = agent.session;
  const comp = s5.compactions && s5.compactions[0];
  check('5: the run compacted once and finished', runEnd().reason === 'done' && events.filter((e) => e.type === 'compact_start').length === 1 && comp && comp.stage === 'summary', { notices: notices(), end: runEnd() });
  const summaryReq = summaries()[0];
  check('5: only the earlier turn went to the summariser, with the task list', summaryReq && /USER: Read notes\.txt and remember/.test(summaryReq.messages[1].content) && !/Now read a\.txt/.test(summaryReq.messages[1].content) && /\[in_progress\] Read the files/.test(summaryReq.messages[1].content));
  check('5: after compaction the conversation is the brief, then the tail unchanged', C.isCompactPreamble(s5.messages[0]) && s5.messages[1].content === 'Now read a.txt, b.txt and c.txt.' && comp.folded.length === 5 && comp.folded.filter(C.isContextNote).length === 1 && comp.kept >= 3 && comp.messages === 4);
  check('5: the brief lists the files touched in the folded part', /## Files touched[\s\S]*- read: notes\.txt/.test(s5.messages[0].content));
  const afterCompact = streams().slice(-1)[0];
  check('5: the next request is brief + tail and the mock accepted it as well-formed', afterCompact.messages[1].content.startsWith('[Context compacted]') && afterCompact.messages[2].content.startsWith('Now read') && !malformed(afterCompact.messages) && runEnd().reason === 'done');
  const ce = events.find((e) => e.type === 'compact_end' && e.compaction);
  check('5: compact_end reports summarised, kept and the token drop', ce && ce.compaction.messages === 4 && ce.compaction.kept === comp.kept && ce.compaction.tokensAfter < ce.compaction.tokensBefore, ce && ce.compaction);
  check('5: the store saw the fold as a compaction', mutations.some((m) => m.kind === 'replace' && m.reason === 'compaction'));
  check('5: the checkpoint in the tail survived, shifted to just after the brief', s5.turns.length === 1 && s5.turns[0].at === 1 && s5.turns[0].text === 'Now read a.txt, b.txt and c.txt.', s5.turns);
  const items = toTranscript(s5);
  const dividerAt = items.findIndex((i) => i.role === 'compaction');
  check('5: the transcript shows the folded turn, the divider, then the kept turn with its rewind checkpoint', dividerAt === 3 && items[0].role === 'user' && items[dividerAt + 1].role === 'user' && items[dividerAt + 1].turn === 0, items.map((i) => i.role));
  // a follow-up turn, then rewind to the kept one
  reset();
  state.replies.push({ content: 'falcon' });
  await agent.run('What is the code word?');
  check('5: a follow-up after compaction works, its checkpoint numbered after the kept one', runEnd().reason === 'done' && s5.turns.length === 2 && s5.turns[1].at > s5.turns[0].at);
  const rw = rewindSession(s5, cwd, 0, store);
  check('5: rewinding to the kept checkpoint works', rw.text === 'Now read a.txt, b.txt and c.txt.' && s5.messages.length === 1 && C.isCompactPreamble(s5.messages[0]) && s5.turns.length === 0);

  // ---- 6: a non-shrinking summary is rejected ----
  fresh();
  await firstTurn();
  state.replies.push({ content: 'ok' });
  await agent.run('And then?');
  reset();
  state.summary = '## 1. Request and intent\n' + 'Lots of words. '.repeat(1500);
  const before6 = agent.session.messages.length;
  let r = await agent.compactNow();
  check('6: a summary not smaller than what it replaces is rejected, the conversation stays', !r.ok && /not smaller/.test(r.error) && agent.session.messages.length === before6 && !agent.session.compactions && events.some((e) => e.type === 'compact_end' && /not smaller/.test(e.error)), r);
  state.summary = 'SUMMARY of the earlier conversation, short and dense.';

  // ---- 7: /compact with a focus ----
  reset();
  r = await agent.compactNow('keep the code word');
  check('7: /compact with a focus: same pipeline, the focus reaches the summariser', r.ok && /focus on: keep the code word/.test(summaries()[0].messages[1].content) && agent.session.compactions.length === 1 && agent.session.compactions[0].reason === 'manual' && events.find((e) => e.type === 'compact_start').reason === 'manual', r);
  check('7: a manual compaction keeps the last turn too', agent.session.messages[1].content === 'And then?' && agent.session.messages.length === 3);
  r = await agent.compactNow();
  check('7: then there is nothing left to compact', !r.ok && /Nothing to compact/.test(r.error));
  // One finished turn has nothing before its request, yet /compact must be able to fold it: the whole conversation
  // goes into the brief, which carries the request word for word.
  fresh();
  await firstTurn();
  reset();
  r = await agent.compactNow();
  check('7: /compact folds a single finished turn whole and carries its request', r.ok && agent.session.messages.length === 1 && /Read notes\.txt and remember the code word\./.test(agent.session.messages[0].content) && agent.session.compactions.length === 1 && agent.session.compactions[0].kept === 0, { ok: r.ok, error: r.error, messages: agent.session.messages.length });
  state.replies.push({ content: 'falcon' });
  await agent.run('What was the code word?');
  check('7: …and the conversation goes on from the brief', streams().length === 1 && streams()[0].messages.length === 4 && runEnd().reason === 'done', streams().map((q) => q.messages.map((m) => m.role)));
  check('7: …with the context note again, sent before the brief and the request, since the fold took the old one', C.isContextNote(streams()[0].messages[1]) && agent.session.messages.filter(C.isContextNote).length === 1, streams()[0].messages.map((m) => String(m.content).slice(0, 30)));

  // ---- 8: fallbacks when no summary can be produced ----
  // (a) prune harder
  fresh();
  state.replies.push(read('a.txt'), read('b.txt'), read('c.txt'));
  state.replies.push({ content: 'ok' });
  await agent.run('Read a, b and c.');
  reset();
  state.summaryFails = true;
  for (const f of 'defg') state.replies.push(read(`${f}.txt`));
  state.replies.push({ content: 'done reading' });
  await agent.run('Now read d, e, f and g.');
  // The newest outputs stay whole: the last two at the last prune, which comes a read earlier or later as the tool
  // definitions grow; everything before them is cut
  check('8a: the summary failed, so old tool output was shortened further, and the run went on', runEnd().reason === 'done' && notices().some((n) => /^Couldn't summarise.*Cleared .* more tokens of old tool output/.test(n)) && !agent.session.compactions && agent.session.messages.filter((m) => m.role === 'tool').slice(0, -3).every((m) => m.content.length < 600), notices());
  check('8a: the summary is not retried on every turn of the run', events.filter((e) => e.type === 'compact_start').length === 1 && notices().length >= 2);
  // (b) drop the oldest messages (no pruning allowed)
  fresh({ pruneToolResults: false });
  await firstTurn();
  reset();
  for (const f of 'abc') state.replies.push(read(`${f}.txt`));
  state.replies.push({ content: 'done' });
  await agent.run('Now read a.txt, b.txt and c.txt.');
  const c8 = agent.session.compactions && agent.session.compactions[0];
  check('8b: the summary failed and nothing could be pruned, so the oldest messages were dropped', runEnd().reason === 'done' && c8 && c8.stage === 'dropped' && c8.folded.length === 5 && /dropped because a summary could not be produced/.test(agent.session.messages[0].content) && agent.session.messages[1].content.startsWith('Now read') && notices().some((n) => /Dropped the \d+ oldest messages/.test(n)), notices());
  check('8b: the dropped messages still show in the transcript above the divider', toTranscript(agent.session).findIndex((i) => i.role === 'compaction') === 3);
  state.summaryFails = false;

  // ---- 9: a context-length error compacts and retries the call once ----
  fresh();
  await firstTurn();
  reset();
  state.failStreams = 1;
  state.replies.push({ content: 'Retried fine.' });
  await agent.run('Go on.');
  check('9: the provider said too long: compacted and the call retried, the run did not end in an error', runEnd().reason === 'done' && agent.session.compactions && agent.session.compactions.length === 1 && streams().length === 2 && events.some((e) => e.type === 'text_delta' && /Retried fine/.test(e.text)) && !events.some((e) => e.type === 'error' && e.kind !== 'notice'), { end: runEnd(), errors: events.filter((e) => e.type === 'error') });
  reset();
  state.failStreams = 2;
  state.replies.push({ content: 'x' });
  await agent.run('Again.');
  check('9: only once: a second context-length error ends the run with that error', runEnd().reason === 'error' && events.some((e) => e.type === 'error' && /maximum context length/.test(e.message)));
  state.failStreams = 0;

  // ---- 10: the threshold setting ----
  fresh({ portkey: { contextWindow: 16000 }, compactThreshold: 0.5 });
  check('10: contextInfo reports the configured threshold', agent.contextInfo().threshold === 0.5);
  await firstTurn();
  reset();
  for (const f of 'abc') state.replies.push(read(`${f}.txt`));
  state.replies.push({ content: 'ok' });
  await agent.run('Read a.txt, b.txt and c.txt.');
  check('10: at 0.5 a 16k session compacts where 0.8 would not', agent.session.compactions && agent.session.compactions.length >= 1 && agent.session.compactions[0].stage === 'summary', { ctx: agent.contextInfo(), notices: notices(), ev: events.filter((e) => e.type === 'context').map((e) => e.context.tokens) });
  fresh({ portkey: { contextWindow: 16000 }, compactThreshold: 0.8 });
  await firstTurn();
  reset();
  for (const f of 'abc') state.replies.push(read(`${f}.txt`));
  state.replies.push({ content: 'ok' });
  await agent.run('Read a.txt, b.txt and c.txt.');
  check('10: the same conversation at 0.8 does not compact', !agent.session.compactions);

  // ---- 13: one long turn: its old output is shortened first; then its start is folded, the request kept verbatim ----
  fresh();
  for (const f of 'abcdef') state.replies.push(read(`${f}.txt`));
  state.replies.push({ content: 'AWORD BWORD CWORD DWORD EWORD FWORD' });
  await agent.run('Read a.txt to f.txt, one at a time.');
  const res13 = agent.session.messages.filter((m) => m.role === 'tool');
  check('13: a single turn over the limit: old results in it are shortened (heads kept), no summary needed', runEnd().reason === 'done' && !events.some((e) => e.type === 'compact_start') && notices().some((n) => /Cleared .* tokens of old tool output in this turn/.test(n)) && /^1\| A-START/.test(res13[0].content) && res13[0].content.length < 600 && res13[res13.length - 1].content.length > 5000, { notices: notices(), first: res13[0].content.slice(0, 40), len: res13.map((m) => m.content.length) });
  fresh({ pruneToolResults: false });
  const request13 = 'Read a.txt to h.txt, one at a time.';
  for (const f of 'abcdefgh') state.replies.push(read(`${f}.txt`));
  state.replies.push({ content: 'all read' });
  await agent.run(request13);
  const comps13 = agent.session.compactions || [];
  check('13: without pruning the start of the turn is summarised, the request kept verbatim in the brief', runEnd().reason === 'done' && comps13.length >= 2 && comps13.every((c) => c.stage === 'summary' && c.kept >= 1), { n: comps13.length, notices: notices() });
  const verbatim = (m) => typeof m.content === 'string' && m.content.includes(`## The user's latest request, verbatim\n${request13}`);
  check('13: a later fold of that brief carries the request on', verbatim(agent.session.messages[0]) && comps13[1] && C.isCompactPreamble(comps13[1].folded[0]) && verbatim(comps13[1].folded[0]));
  check('13: every request stayed well-formed', streams().every((q) => !malformed(q.messages)) && agent.session.messages.length > 1);

  // ---- 11: the breakdown ----
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Rules\n' + 'Be careful. '.repeat(200));
  let mcpConfig = { ...baseConfig, mcpServers: { test: { command: 'node', args: [TEST_SERVER], env: { OC_PROJECT: projectDir } } } };
  const mcp = new McpManager({ getConfig: () => mcpConfig, saveConfig: (p) => (mcpConfig = { ...mcpConfig, ...p }), cwd: () => cwd });
  await mcp.reload();
  const agent2 = new Agent(() => config, { navigate: async (u) => u }, store, () => [], (ev) => events.push(ev), undefined, artifacts, mcp, { session: store.create({ cwd }) });
  config = { ...baseConfig, portkey: { ...baseConfig.portkey, contextWindow: 32000 } };
  let b = agent2.contextBreakdown();
  const sum = (x) => x.slices.reduce((a, s) => a + s.tokens, 0);
  const slice = (x, key) => x.slices.find((s) => s.key === key);
  check('11: estimated breakdown of a fresh session adds up to the window', b.basis === 'estimated' && sum(b) === b.limit && b.limit === 32000 && b.tokens > 0, b.slices.map((s) => `${s.key}:${s.tokens}`));
  check('11: instructions per file and MCP tools per server', slice(b, 'instructions') && slice(b, 'instructions').items.some((i) => i.label === 'AGENTS.md' && i.tokens > 400) && slice(b, 'mcpTools') && slice(b, 'mcpTools').items.some((i) => i.label === 'test' && i.tokens > 0) && slice(b, 'tools').tokens > 2000, b.slices);
  check('11: reserve is the part above the threshold, and nothing is compactable yet', slice(b, 'reserve').tokens === Math.round(32000 * 0.2) && b.compactable === false && b.threshold === 0.8 && b.autoCompact === true);
  state.replies.push(read('notes.txt'));
  state.replies.push({ content: 'falcon ' + 'and more words '.repeat(200) });
  await agent2.run('Read notes.txt');
  state.replies.push({ content: 'ok' });
  await agent2.run('Thanks');
  b = agent2.contextBreakdown();
  check('11: after a run the breakdown is scaled to the reported size and still adds up', b.basis === 'reported' && sum(b) === b.limit && b.tokens === agent2.contextInfo().tokens && b.slices.filter((s) => s.key !== 'reserve' && s.key !== 'free').reduce((a, s) => a + s.tokens, 0) === b.tokens, { tokens: b.tokens, ctx: agent2.contextInfo().tokens, slices: b.slices.map((s) => `${s.key}:${s.tokens}`) });
  check('11: messages and tool calls are counted apart; a foldable conversation is compactable', slice(b, 'messages').tokens > 0 && slice(b, 'toolResults').tokens > 0 && b.compactable === true && b.messages === agent2.session.messages.length);
  const items11 = slice(b, 'instructions').items;
  check('11: items add up to their slice', items11.reduce((a, i) => a + i.tokens, 0) === slice(b, 'instructions').tokens);
  await agent2.compactNow();
  b = agent2.contextBreakdown();
  check('11: after a compaction the brief has its own slice and the last compaction is described', slice(b, 'summary') && slice(b, 'summary').tokens > 0 && b.compactions === 1 && b.lastCompaction && b.lastCompaction.reason === 'manual' && sum(b) === b.limit);
  await mcp.close();
  fs.rmSync(path.join(cwd, 'AGENTS.md'));

  // ---- 12: the service and the RPC ----
  const app = createApp({ userData: path.join(tmp, 'app'), appRoot: projectDir, loadConfig: () => ({ ...baseConfig }), saveConfig: () => {}, browser: () => ({ navigate: async (u) => u }), artifacts });
  setupContext(app);
  const fg = app.runtime.foregroundId();
  const viaRpc = await app.invokeRpc('context.breakdown', []);
  const viaSvc = app.service('context').breakdown(fg);
  check('12: context.breakdown defaults to the session on screen; the service answers for a session', viaRpc && viaRpc.limit === contextLimit(baseConfig) && sum(viaRpc) === viaRpc.limit && viaSvc.limit === viaRpc.limit && viaSvc.messages === 0);
  let threw = false;
  try {
    await app.invokeRpc('context.breakdown', ['no-such-session']);
  } catch {
    threw = true;
  }
  check('12: an unknown session is an error', threw);

  model.close();
  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
