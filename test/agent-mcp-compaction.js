// Agent + MCP tools (approval rules per mode), context compaction and project instructions, with mock models.
// Run: node test-agent.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { Agent, contextLimit } = require(path.join(projectDir, 'dist/main/agent.js'));
const { SessionStore, toTranscript, toMeta } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { McpManager } = require(path.join(projectDir, 'dist/main/mcp.js'));
const compact = require(path.join(projectDir, 'dist/main/compact.js'));
const { loadInstructions, instructionsPrompt } = require(path.join(projectDir, 'dist/main/instructions.js'));
const { titlePrompt } = require(path.join(projectDir, 'dist/main/titles.js'));
const { startMock, classifierReply } = require('./support/mock-model.js');
const TEST_SERVER = path.join(__dirname, 'support', 'test-mcp-server.js');

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`.slice(0, 500));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-r7-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd);
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const artifacts = new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') });
  let config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: cwd, permissionMode: 'ask', autoApprove: false, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: { test: { command: 'node', args: [TEST_SERVER], env: { OC_PROJECT: projectDir } } }, mcpTrusted: {}, autoCompact: true,
  };
  const mcp = new McpManager({ getConfig: () => config, saveConfig: (p) => { config = { ...config, ...p }; }, cwd: () => config.workingDirectory });
  await mcp.reload();
  let events = [];
  let approvalPolicy = null; // (ev) => [ok, always]
  const browser = { navigate: async (url) => `Now at ${url}` };
  let agent;
  const emit = (ev) => {
    events.push(ev);
    if (ev.type === 'approval_request' && approvalPolicy) {
      const [ok, always] = approvalPolicy(ev);
      setTimeout(() => agent.resolveApproval(ev.id, ok, always), 10);
    }
  };
  agent = new Agent(() => config, browser, store, () => [], emit, undefined, artifacts, mcp);
  let id = 0;
  const call = (name, args) => ({ id: `c${++id}`, name, args });
  const toolEnds = () => events.filter((e) => e.type === 'tool_end');
  const approvals = () => events.filter((e) => e.type === 'approval_request');
  const reset = () => { events = []; state.requests.length = 0; state.replies.length = 0; };
  const specsOf = (req) => (req.payload.tools ?? []).map((t) => t.function.name);

  // ---- A: tools and prompt ----
  reset();
  state.replies.push({ content: 'ok' });
  await agent.run('hello');
  let names = specsOf(state.requests[0]);
  check('A: MCP tools offered with built-ins', names.includes('mcp__test__echo') && names.includes('mcp__test__add') && names.includes('read_file'), names.length);
  const spec = state.requests[0].payload.tools.find((t) => t.function.name === 'mcp__test__echo');
  check('A: description prefixed with the server, schema passed through', spec.function.description === '[test] Echoes text back' && spec.function.parameters.properties.text.type === 'string');
  const sys = state.requests[0].payload.messages[0].content;
  check('A: system prompt lists the server', /MCP servers provide extra tools named mcp__<server>__<tool>/.test(sys) && /- test \(8 tools\): echo, add/.test(sys));
  check('A: context events carry tokens and limit', events.some((e) => e.type === 'context' && e.context.limit === 128000 && e.context.tokens > 0 && e.context.threshold === 0.8 && e.context.autoCompact === true));
  const ctxAfter = agent.contextInfo();
  check('A: usage anchors the estimate (300 prompt + 30 completion)', ctxAfter.tokens === 330, ctxAfter);

  // ---- B: ask mode ----
  reset();
  approvalPolicy = () => [true, true];
  state.replies.push({ toolCalls: [call('mcp__test__echo', { text: 'hi' })] });
  state.replies.push({ toolCalls: [call('mcp__test__add', { a: 2, b: 3 })] });
  state.replies.push({ toolCalls: [call('mcp__test__add', { a: 4, b: 5 })] });
  state.replies.push({ content: 'done' });
  await agent.run('use the tools');
  let ends = toolEnds();
  check('B: read-only tool ran without approval', ends[0].name === 'mcp__test__echo' && ends[0].ok && ends[0].result === 'echo: hi' && approvals().length === 1);
  const ap = approvals()[0];
  check('B: approval card for add: name, pretty args, server label', ap.name === 'mcp__test__add' && ap.detail === '{\n  "a": 2,\n  "b": 3\n}' && ap.alwaysLabel === 'Allow test for this session' && ap.mode === 'ask' && !ap.reason, ap);
  check('B: both add calls ran, second without asking (allowed for session)', ends[1].result === '5' && ends[2].result === '9' && approvals().length === 1);
  await sleep(400); // the change listing is asynchronous
  check('B: changes_updated after a non-read-only MCP tool', events.some((e) => e.type === 'changes_updated'));

  // ---- C: plan mode offers read-only MCP tools only ----
  reset();
  config = { ...config, permissionMode: 'plan' };
  state.replies.push({ toolCalls: [call('mcp__test__echo', { text: 'plan' })] });
  state.replies.push({ content: 'planning' });
  await agent.run('plan it');
  names = specsOf(state.requests[0]);
  check('C: plan mode: echo offered, add not', names.includes('mcp__test__echo') && !names.includes('mcp__test__add') && !names.includes('mcp__test__remove_item'));
  check('C: plan mode: read-only MCP tool ran', toolEnds()[0].result === 'echo: plan' && approvals().length === 0);

  // ---- D: auto mode: MCP calls that are not read-only go to the safety check; no card ----
  reset();
  config = { ...config, permissionMode: 'auto' };
  agent.session = store.create(); // fresh session: no "allow test" from B
  approvalPolicy = () => [false, false];
  state.replies.push({ toolCalls: [call('mcp__test__add', { a: 1, b: 1 }), call('mcp__test__remove_item', { id: 'x1' })] });
  state.replies.push(classifierReply('allow', '[Local Work] adds two numbers'));
  state.replies.push(classifierReply('block', '[Destructive] removes an item'));
  state.replies.push({ content: 'ok' });
  await agent.run('auto');
  ends = toolEnds();
  check('D: auto mode runs an MCP tool the check allows, without a card', ends[0].result === '2');
  check('D: a destructive MCP tool the check blocks: the reason, no card', approvals().length === 0 && ends[1].result.startsWith('Blocked by Auto mode: [Destructive] removes an item.') && !ends[1].ok, ends[1]);

  // ---- E: image and error results, bypass mode ----
  reset();
  config = { ...config, permissionMode: 'bypass' };
  state.replies.push({ toolCalls: [call('mcp__test__picture', {}), call('mcp__test__fail', {})] });
  state.replies.push({ content: 'ok' });
  await agent.run('pics');
  ends = toolEnds();
  check('E: image result shown (tool_end.image) and described', ends[0].image && ends[0].image.startsWith('data:image/png;base64,') && /\[image: image\/png/.test(ends[0].result) && ends[0].ok);
  check('E: isError result marked failed', ends[1].result === 'Error: nope' && ends[1].ok === false);
  check('E: transcript keeps MCP rows', toTranscript(agent.session).some((i) => i.role === 'tool' && i.name === 'mcp__test__picture'));

  // ---- F: stop during a slow MCP call ----
  reset();
  state.replies.push({ toolCalls: [call('mcp__test__slow', { ms: 8000 })] });
  const t0 = Date.now();
  const run = agent.run('slow');
  await sleep(400);
  agent.stop();
  await run;
  const end = events.find((e) => e.type === 'run_end');
  check('F: stop aborts the MCP call promptly', end && end.reason === 'aborted' && Date.now() - t0 < 3000, Date.now() - t0);

  // ---- G: auto compaction (Ollama path, 16384 window): the earlier turn is summarised, the current one kept ----
  reset();
  config = { ...config, provider: 'ollama', permissionMode: 'bypass', ollama: { ...config.ollama, numCtx: 16384 } };
  agent.session = store.create();
  state.ollamaPromptTokens = 100;
  state.replies.push({ content: 'Noted, the widget is blue. ' + 'The widget spec is long. '.repeat(200) });
  await agent.run('Remember: the widget is blue.');
  reset();
  state.ollamaPromptTokens = 14000; // ≥ 80% of 16384 after the first reply
  state.summary = '## 1. Request and intent\nBuild the widget; it is blue.\n\n## 2. Key facts and concepts\n(none)\n\n## 6. Pending work\nRun npm test.';
  state.replies.push({ toolCalls: [{ name: 'mcp__test__echo', args: { text: 'one' } }] });
  state.replies.push({ content: 'All done after compaction.' });
  await agent.run('Build the widget please');
  const chat = state.requests.filter((r) => r.url === '/api/chat');
  const summaryReq = chat.find((r) => r.payload.stream === false);
  // Changed on purpose: only the earlier turn goes to the summariser; the current turn (with its tool result) is kept verbatim.
  check('G: a non-streaming summary request was made with the earlier transcript only', summaryReq && /handoff brief/.test(summaryReq.payload.messages[0].content) && /Transcript:/.test(summaryReq.payload.messages[1].content) && /USER: Remember: the widget is blue\./.test(summaryReq.payload.messages[1].content) && !/RESULT OF mcp__test__echo/.test(summaryReq.payload.messages[1].content) && /Current task list:/.test(summaryReq.payload.messages[1].content), summaryReq && summaryReq.payload.messages[1].content.slice(0, 200));
  check('G: summary request has no tools and thinking off', summaryReq && !summaryReq.payload.tools && summaryReq.payload.think === false && summaryReq.payload.options.num_ctx === 16384);
  const after = chat[chat.length - 1].payload;
  // Changed on purpose: brief + kept tail (user, call, result) instead of the brief alone.
  check('G: the next model call sees the system prompt, the brief and the kept tail', after.stream === true && after.messages.map((m) => m.role).join(',') === 'system,user,user,assistant,tool' && after.messages[1].content.startsWith('[Context compacted]') && /Build the widget; it is blue\./.test(after.messages[1].content) && after.messages[2].content === 'Build the widget please', after.messages.map((m) => m.role));
  const cs = events.filter((e) => e.type === 'compact_start');
  const ce = events.filter((e) => e.type === 'compact_end');
  // The size after is mostly the floor every request pays, the system prompt and the tool definitions (about 10.5k tokens
  // with browser_tabs), so the ratio leaves room for that floor to grow with the tools.
  check('G: compact events', cs.length === 1 && cs[0].reason === 'auto' && ce.length === 1 && ce[0].compaction && ce[0].compaction.reason === 'auto' && ce[0].compaction.messages === 2 && ce[0].compaction.kept === 3 && ce[0].compaction.stage === 'summary' && ce[0].compaction.tokensBefore >= 14000 && ce[0].compaction.tokensAfter < ce[0].compaction.tokensBefore * 0.8, ce[0]);
  check('G: session stores the compaction with folded messages', agent.session.compactions.length === 1 && agent.session.compactions[0].folded.length === 2 && agent.session.messages.length === 5 && toMeta(agent.session).compactions === 1);
  const items = toTranscript(agent.session);
  check('G: transcript: folded turn, divider, then the kept turn and the reply', items.map((i) => i.role).join(',') === 'user,assistant,compaction,user,tool,assistant' && items[2].compaction.summary === state.summary && !items[2].compaction.folded, items.map((i) => i.role));
  check('G: the kept user message can still be rewound to', items[3].turn === 0 && agent.session.turns.length === 1 && agent.session.turns[0].at === 1, items[3]);
  check('G: run ended done with the reply after compaction', events.find((e) => e.type === 'run_end').reason === 'done' && events.some((e) => e.type === 'text_delta' && /after compaction/.test(e.text)));
  const endIdx = events.findIndex((e) => e.type === 'compact_end');
  const ctxAfterCompact = events.slice(endIdx).find((e) => e.type === 'context');
  // Changed on purpose: the estimate after a fold is scaled by reported/estimated of the last request (the mock reports
  // 14000 for a much smaller conversation, so the scale is at its cap of 2), and the kept tail counts too.
  check('G: context event right after compaction shows a smaller context, under the threshold', ctxAfterCompact && ctxAfterCompact.context.tokens < 16384 * 0.8 && ctxAfterCompact.context.tokens < ce[0].compaction.tokensBefore && ctxAfterCompact.context.limit === 16384, ctxAfterCompact && ctxAfterCompact.context);
  check('G: title prompt uses the folded first message', /Remember: the widget is blue/.test(titlePrompt(agent.session)));
  const forked = store.fork(agent.session.id);
  check('G: fork copies compactions', forked.compactions.length === 1 && forked.messages.length === 5);

  // ---- H: manual /compact, errors and abort ----
  reset();
  state.ollamaPromptTokens = 100;
  agent.session.lastPrompt = undefined; // G's last reply reported 14000 prompt tokens; this turn should not auto-compact
  state.replies.push({ content: 'More. ' + 'Details follow. '.repeat(100) });
  await agent.run('Tell me more');
  reset();
  let r = await agent.compactNow('keep the file names');
  check("H: manual compaction ok and focused", r.ok && agent.session.compactions.length === 2 && /focus on: keep the file names/.test(state.requests.find((q) => q.payload.stream === false).payload.messages[1].content) && events.find((e) => e.type === 'compact_start').reason === 'manual', r);
  r = await agent.compactNow();
  // Changed on purpose: what is left is the brief and the kept last turn, and folding the brief alone is pointless.
  check('H: nothing to compact with only the brief before the last request', !r.ok && /Nothing to compact/.test(r.error) && !state.requests.some((q) => q.payload.stream === false && q !== state.requests.find((x) => x.payload.stream === false)));
  agent.session = store.create();
  state.replies.push({ content: 'hi' });
  await agent.run('hey');
  state.replies.push({ content: 'hi again' });
  await agent.run('hey again');
  reset();
  state.summaryFails = true;
  r = await agent.compactNow();
  check('H: a failed summary leaves the conversation alone', !r.ok && /summary failed|HTTP 500/.test(r.error) && agent.session.messages.length === 4 && events.some((e) => e.type === 'compact_end' && e.error));
  // a failed auto compaction does not retry every turn
  reset();
  state.ollamaPromptTokens = 15000;
  state.replies.push({ toolCalls: [{ name: 'mcp__test__echo', args: { text: 'a' } }] });
  state.replies.push({ toolCalls: [{ name: 'mcp__test__echo', args: { text: 'b' } }] });
  state.replies.push({ content: 'end' });
  await agent.run('go');
  // Changed on purpose: over the limit, a failed summary falls back (here: nothing worth dropping) and says so in a notice.
  check('H: failed auto compaction tried once per run', state.requests.filter((q) => q.url === '/api/chat' && q.payload.stream === false).length === 1 && events.filter((e) => e.type === 'compact_end').length === 1 && events.filter((e) => e.type === 'error' && e.kind === 'notice' && /summary could not be produced/.test(e.message)).length === 1 && events.find((e) => e.type === 'run_end').reason === 'done', events.filter((e) => e.type === 'error'));
  state.summaryFails = false;
  // auto-compact off
  reset();
  config = { ...config, autoCompact: false };
  state.replies.push({ toolCalls: [{ name: 'mcp__test__echo', args: { text: 'c' } }] });
  state.replies.push({ content: 'end' });
  await agent.run('again');
  check('H: autoCompact=false never summarises', !state.requests.some((q) => q.payload.stream === false) && !events.some((e) => e.type === 'compact_start'));
  config = { ...config, autoCompact: true };
  // abort a manual compaction
  reset();
  state.ollamaPromptTokens = 100;
  state.replies.push({ content: 'hi' });
  await agent.run('one more');
  const compactionsBefore = (agent.session.compactions ?? []).length;
  state.summaryDelayMs = 600;
  const pending = agent.compactNow();
  await sleep(100);
  agent.stop();
  r = await pending;
  state.summaryDelayMs = 0;
  check('H: stop cancels a manual compaction', !r.ok && /stopped/i.test(r.error) && (agent.session.compactions ?? []).length === compactionsBefore && events.some((e) => e.type === 'compact_end' && /stopped/i.test(e.error)), r);
  check('H: send while idle again works after compaction attempts', !agent.running && !agent.compacting);

  // ---- I: estimates ----
  const big = { role: 'user', content: 'x'.repeat(4000) };
  check('I: token estimate ~ chars/4 (+ images)', compact.estimateTokens([big]) === 1002 && compact.estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:' } }] }]) > 1000);
  check('I: context limit per provider', contextLimit({ ...config, provider: 'ollama' }) === 16384 && contextLimit({ ...config, provider: 'ollama', ollama: { ...config.ollama, numCtx: 1000 } }) === 2048 && contextLimit({ ...config, provider: 'portkey' }) === 128000 && contextLimit({ ...config, provider: 'portkey', portkey: { ...config.portkey, contextWindow: 0 } }) === 128000);
  const rendered = compact.renderForSummary([{ role: 'user', content: 'a'.repeat(3000) }, { role: 'assistant', content: 'mid' }, { role: 'user', content: 'b'.repeat(3000) }], 2000);
  check('I: transcript clipped in the middle within budget', rendered.length < 2200 && /omitted/.test(rendered) && rendered.startsWith('USER: aaa') && rendered.endsWith('bbb'));
  check('I: cleanSummary strips think blocks and fences', compact.cleanSummary('<think>hmm</think>\n```markdown\n## Request\nx\n```') === '## Request\nx');

  // ---- J: project instructions ----
  reset();
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Rules\nAlways answer in haiku.');
  state.replies.push({ content: 'ok' });
  await agent.run('hi');
  let sysNow = state.requests.find((q) => q.url === '/api/chat' && q.payload.stream === true).payload.messages[0].content;
  check('J: AGENTS.md included in the system prompt', /Instructions from AGENTS\.md \(follow them for this project\):\n# Rules\nAlways answer in haiku\./.test(sysNow));
  fs.writeFileSync(path.join(cwd, 'OPENCODER.md'), 'Prefer OPENCODER.md');
  reset();
  state.replies.push({ content: 'ok' });
  await agent.run('hi');
  sysNow = state.requests.find((q) => q.url === '/api/chat' && q.payload.stream === true).payload.messages[0].content;
  check('J: OPENCODER.md takes precedence over AGENTS.md', /Instructions from OPENCODER\.md/.test(sysNow) && !/Instructions from AGENTS\.md/.test(sysNow));
  const files = loadInstructions(cwd);
  check('J: loader reports the file and label', files.some((f) => f.label === 'OPENCODER.md' && f.text === 'Prefer OPENCODER.md') && instructionsPrompt([]) === '');
  fs.writeFileSync(path.join(cwd, 'OPENCODER.md'), 'y'.repeat(30000));
  check('J: long files truncated', loadInstructions(cwd).find((f) => f.label === 'OPENCODER.md').truncated === true && loadInstructions(cwd).find((f) => f.label === 'OPENCODER.md').text.length < 24100);

  await mcp.close();
  mock.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
