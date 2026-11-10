// Retries the user can see (src/main/agent/retry.ts): which failures are tried again, the waits, the status line, a
// stream that drops mid-reply, a Stop during a wait; and the run loop's guards (agent/turn-guards.ts): a reply cut at
// the output limit, and one call repeated with the same result. The OpenAI-compatible and Ollama paths here; the native
// Anthropic path in anthropic-native.js. No test sleeps for a real backoff: the loop's clock is replaced.
// Run: node test/retry.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const R = dist('agent/retry.js');
const G = dist('agent/turn-guards.js');
const OpenAI = require(path.join(projectDir, 'node_modules/openai')).default;
const Anthropic = require(path.join(projectDir, 'node_modules/@anthropic-ai/sdk')).default;
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const withStatus = (status, extra = {}) => Object.assign(new Error(extra.message ?? `HTTP ${status}`), { status, ...extra });

(async () => {
  // ---------- 1: isRetryable ----------
  for (const s of [408, 409, 429, 500, 502, 503, 504, 529]) check(`1: HTTP ${s} is retried`, R.isRetryable(withStatus(s)));
  for (const s of [400, 401, 403, 404, 413, 422]) check(`1: HTTP ${s} is not`, !R.isRetryable(withStatus(s)));
  check('1: a user abort is not', !R.isRetryable(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' })) && !R.isRetryable(new OpenAI.APIUserAbortError()) && !R.isRetryable(new Anthropic.APIUserAbortError()));
  check('1: a context-length error is not (it has its own compaction path)', !R.isRetryable(withStatus(400, { message: 'prompt is too long: 210000 tokens > 200000 maximum' })) && !R.isRetryable(new Error("This model's maximum context length is 8192 tokens")));
  check('1: a quota or billing error is not', !R.isRetryable(withStatus(429, { code: 'insufficient_quota', message: 'You exceeded your current quota' })) && !R.isRetryable(withStatus(429, { error: { type: 'insufficient_quota' } })) && !R.isRetryable(withStatus(400, { message: 'Your credit balance is too low' })) && !R.isRetryable(withStatus(429, { message: 'Check your plan and billing details.' })));
  check('1: x-should-retry: false wins over the status', !R.isRetryable(withStatus(503, { headers: new Headers({ 'x-should-retry': 'false' }) })) && !R.isRetryable(withStatus(503, { headers: { 'X-Should-Retry': 'false' } })));
  check('1: the refusals complete.ts answers with another request are not', !R.isRetryable(new Error('Unrecognized request argument supplied: stream_options')) && !R.isRetryable(new Error('registry.ollama.ai/library/x does not support tools')) && !R.isRetryable(new Error('unknown field cache_control')));
  check('1: the SDKs\' connection errors are', R.isRetryable(new OpenAI.APIConnectionError({ message: 'Connection error.' })) && R.isRetryable(new OpenAI.APIConnectionTimeoutError()) && R.isRetryable(new Anthropic.APIConnectionError({ message: 'Connection error.' })) && R.isRetryable(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })));
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']) {
    check(`1: ${code} (by code, on the error or its cause) is retried`, R.isRetryable(Object.assign(new Error('x'), { code })) && R.isRetryable(Object.assign(new TypeError('x'), { cause: { code } })));
  }
  for (const text of ['fetch failed', 'socket hang up', 'terminated', 'other side closed', 'network error', 'Premature close']) check(`1: "${text}" is retried`, R.isRetryable(new Error(text)));
  check('1: a stream that dropped is retried', R.isRetryable(new R.StreamDropped()));
  check('1: a stream\'s error event (no status) is retried by its type', R.isRetryable(Object.assign(new Error('Overloaded'), { error: { type: 'overloaded_error' } })) && !R.isRetryable(Object.assign(new Error('bad'), { error: { type: 'invalid_request_error' } })));
  check('1: any other error is not', !R.isRetryable(new Error('boom')) && !R.isRetryable(null));
  check('1: Ollama\'s HTTP errors carry the status for the loop', R.isRetryable(Object.assign(new Error('Ollama returned HTTP 503'), { httpStatus: 503 })) && !R.isRetryable(Object.assign(new Error('Ollama returned HTTP 404'), { httpStatus: 404 })));

  // ---------- 2: retryDelayMs ----------
  const mid = () => 0.5;
  check('2: 1 s, doubling', R.retryDelayMs(1, withStatus(503), mid) === 1000 && R.retryDelayMs(2, withStatus(503), mid) === 2000 && R.retryDelayMs(3, withStatus(503), mid) === 4000 && R.retryDelayMs(5, withStatus(503), mid) === 16000);
  check('2: to a 30 s cap', R.retryDelayMs(6, withStatus(503), mid) === 30000 && R.retryDelayMs(12, withStatus(503), () => 0.999) === 30000);
  check('2: ±20% jitter', R.retryDelayMs(3, withStatus(503), () => 0) === 3200 && R.retryDelayMs(3, withStatus(503), () => 1) === 4800 && R.retryDelayMs(1, withStatus(503), () => 0.25) === 900);
  let inBounds = true;
  for (let i = 0; i < 200; i++) {
    const d = R.retryDelayMs(2, withStatus(503));
    if (d < 1600 || d > 2400) inBounds = false;
  }
  check('2: with Math.random, every wait within the bounds', inBounds);
  check('2: Retry-After in seconds wins', R.retryDelayMs(1, withStatus(429, { headers: new Headers({ 'retry-after': '7' }) }), mid) === 7000);
  check('2: retry-after-ms wins over Retry-After', R.retryDelayMs(1, withStatus(429, { headers: new Headers({ 'retry-after-ms': '1500', 'retry-after': '7' }) }), mid) === 1500);
  const now = Date.parse('2026-11-09T10:00:00Z');
  check('2: Retry-After as an HTTP date', R.retryDelayMs(1, withStatus(503, { headers: { 'Retry-After': 'Mon, 09 Nov 2026 10:00:12 GMT' } }), mid, now) === 12000);
  check('2: a header that is neither is ignored', R.retryDelayMs(2, withStatus(503, { headers: { 'retry-after': 'soon' } }), mid) === 2000);
  check('2: the status line', R.retryStatusText(withStatus(429), 3200, 2) === 'Provider busy. Retrying in 4 s (2 of 6).' && R.retryStatusText(new TypeError('fetch failed'), 4000, 2) === 'Connection lost. Retrying in 4 s (2 of 6).' && R.retryStatusText(withStatus(529), 1000, 3) === 'Provider busy. Retrying in 1 s (3 of 6).');
  check('2: six attempts in all', R.MAX_ATTEMPTS === 6 && R.MAX_DELAY_MS === 30000 && R.MAX_RETRY_AFTER_MS === 60000 && R.STREAM_IDLE_MS === 300000);

  // ---------- 3: the loop (a clock that does not sleep) ----------
  const waits = [];
  R.retryTiming.random = mid;
  R.retryTiming.sleep = async (ms, signal) => {
    waits.push(ms);
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  const hooks = (log) => ({ onWait: (t) => log.push(t), onClear: () => log.push(null) });
  {
    const log = [];
    let n = 0;
    const out = await R.withRetries(async () => {
      if (++n < 3) throw withStatus(503);
      return 'ok';
    }, new AbortController().signal, hooks(log));
    check('3: fails twice, then through: two waits, then cleared', out === 'ok' && n === 3 && JSON.stringify(log) === JSON.stringify(['Provider busy. Retrying in 1 s (2 of 6).', 'Provider busy. Retrying in 2 s (3 of 6).', null]), log);
  }
  {
    const log = [];
    let n = 0;
    let err;
    await R.withRetries(async () => {
      n++;
      throw withStatus(503, { message: 'unavailable' });
    }, new AbortController().signal, hooks(log)).catch((e) => (err = e));
    check('3: every attempt fails: six tries, then RetryGaveUp that says so', n === 6 && err instanceof R.RetryGaveUp && err.lead === 'Could not reach the provider after 6 tries:' && err.last.status === 503 && log.filter(Boolean).length === 5 && log[log.length - 1] === null, { n, lead: err?.lead });
  }
  {
    let n = 0;
    let err;
    await R.withRetries(async () => {
      n++;
      throw withStatus(401);
    }, new AbortController().signal, hooks([])).catch((e) => (err = e));
    check('3: 401: no retry, the error as it was', n === 1 && err.status === 401 && !(err instanceof R.RetryGaveUp));
  }
  {
    let n = 0;
    let err;
    await R.withRetries(async () => {
      n++;
      throw withStatus(429, { headers: new Headers({ 'retry-after': '300' }) });
    }, new AbortController().signal, hooks([])).catch((e) => (err = e));
    check('3: Retry-After over 60 s: no retry, the wait is said', n === 1 && err instanceof R.RetryGaveUp && err.lead === 'Rate limited. Try again in 5 min.', err?.lead);
  }
  {
    // A Stop during a real wait (a 30 s one) ends it at once
    R.retryTiming.sleep = R.abortableSleep;
    const ctl = new AbortController();
    const t0 = Date.now();
    let err;
    const p = R.withRetries(async () => {
      throw withStatus(503, { headers: { 'retry-after': '30' } });
    }, ctl.signal, hooks([])).catch((e) => (err = e));
    setTimeout(() => ctl.abort(), 30);
    await p;
    check('3: a Stop during a wait ends it at once, as an abort', err?.name === 'AbortError' && Date.now() - t0 < 1000, Date.now() - t0);
    const t1 = Date.now();
    const c2 = new AbortController();
    c2.abort();
    const e2 = await R.abortableSleep(30000, c2.signal).catch((e) => e);
    check('3: …and a wait on a signal already fired does not start', e2?.name === 'AbortError' && Date.now() - t1 < 100);
  }
  R.retryTiming.sleep = async (ms, signal) => {
    waits.push(ms);
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };

  // ---------- 4: the guards (pure) ----------
  check('4: canonical JSON sorts keys at every level', G.canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }) === '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  check('4: complete and cut JSON', G.isCompleteJson('{"a":1}') && G.isCompleteJson('') && !G.isCompleteJson('{"path":"a","content":"x'));
  {
    const w = new G.RepeatWatch();
    const counts = [1, 2, 3].map(() => w.add('bash', '{"command":"echo hi"}', 'hi'));
    const reordered = w.add('bash', '{ "command": "echo hi" }', 'hi');
    const other = w.add('bash', '{"command":"echo hi"}', 'changed');
    check('4: the same call, same result: counted; another result starts again', JSON.stringify(counts) === '[1,2,3]' && reordered === 4 && other === 1, { counts, reordered, other });
    check('4: terminal_read with wait_ms and session_list are not counted', w.add('terminal_read', '{"tab_id":"1","wait_ms":500}', '') === 0 && w.add('session_list', '{}', '') === 0 && w.add('terminal_read', '{"tab_id":"1"}', '') === 1);
  }

  // ---------- 5: through a run (the OpenAI-compatible path) ----------
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-retry-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  let config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}`, model: 'mock', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'sk-retry-test-key', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: tmp, permissionMode: 'bypass', autoApprove: true, maxTurns: 20, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {},
  };
  const store = new SessionStore(path.join(tmp, 'sessions'));
  let events = [];
  const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], (ev) => events.push(ev));
  const chat = () => state.requests.filter((r) => r.url === '/v1/chat/completions' || r.url === '/api/chat');
  const reset = () => {
    events = [];
    waits.length = 0;
    state.requests.length = 0;
    state.replies.length = 0;
    agent.session = store.create();
  };
  const runEnd = () => events.find((e) => e.type === 'run_end');
  const errors = () => events.filter((e) => e.type === 'error' && !e.kind);
  const statuses = () => events.filter((e) => e.type === 'retry_status').map((e) => e.text);

  // 429 twice, then through
  reset();
  state.replies.push({ status: 429, error: 'Rate limit reached' }, { status: 429, error: 'Rate limit reached' }, { content: 'Hello there.' });
  await agent.run('Hi');
  check('5: 429 twice, then a reply: the run completes', runEnd()?.reason === 'done' && runEnd()?.text === 'Hello there.' && chat().length === 3 && !errors().length, errors());
  check('5: …two status updates were emitted, then cleared', JSON.stringify(statuses()) === JSON.stringify(['Provider busy. Retrying in 1 s (2 of 6).', 'Provider busy. Retrying in 2 s (3 of 6).', null]), statuses());
  check('5: …no request went without streaming (no fallback on a busy provider)', chat().every((r) => r.payload.stream === true));

  // 503 six times
  reset();
  for (let i = 0; i < 6; i++) state.replies.push({ status: 503, error: 'Service Unavailable (mock)' });
  await agent.run('Anyone?');
  check('5: 503 six times: one error with the "after 6 tries" text, the run ends error', errors().length === 1 && /^Could not reach the provider after 6 tries: .*HTTP 503.*Service Unavailable \(mock\)/.test(errors()[0].message) && runEnd()?.reason === 'error' && chat().length === 6, errors());
  check('5: …and the key is not in it', !errors()[0].message.includes('sk-retry-test-key'));

  // 401 and 400: no retry (the stream's refusal gets the existing no-stream fallback once, as before: a gateway that
  // rejects streaming with tools; that is not a retry)
  reset();
  state.replies.push({ status: 401, error: 'Invalid API key' }, { status: 401, error: 'Invalid API key', nonStream: true });
  await agent.run('Key?');
  check('5: 401: no retry', chat().length === 2 && chat()[1].payload.stream === false && runEnd()?.reason === 'error' && !statuses().length && /HTTP 401/.test(errors()[0]?.message ?? '') && !/after 6 tries/.test(errors()[0]?.message ?? ''), errors());
  reset();
  state.replies.push({ status: 400, error: 'Bad request (mock)' }, { status: 400, error: 'Bad request (mock)', nonStream: true });
  await agent.run('Bad?');
  check('5: 400: no retry', chat().length === 2 && chat()[1].payload.stream === false && runEnd()?.reason === 'error' && !statuses().length, chat().length);

  // A Stop during a wait
  reset();
  R.retryTiming.sleep = R.abortableSleep;
  state.replies.push({ status: 503, error: 'busy', headers: { 'retry-after': '30' } });
  const t0 = Date.now();
  const run = agent.run('Slow?');
  for (let i = 0; i < 100 && !statuses().length; i++) await new Promise((r) => setTimeout(r, 10));
  agent.stop();
  await run;
  check('5: Stop during a wait: the run ends aborted, promptly, with no error', runEnd()?.reason === 'aborted' && Date.now() - t0 < 2000 && !errors().length && chat().length === 1, { ms: Date.now() - t0, reason: runEnd()?.reason });
  R.retryTiming.sleep = async (ms, signal) => {
    waits.push(ms);
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };

  // A stream that drops after two text chunks, then succeeds
  reset();
  state.replies.push({ chunks: ['First att', 'empt '], chunkDelayMs: 5, drop: true, usage: { prompt_tokens: 111, completion_tokens: 5 } });
  state.replies.push({ content: 'Second attempt.', usage: { prompt_tokens: 222, completion_tokens: 6 } });
  await agent.run('Tell me');
  const kinds = events.map((e) => e.type);
  const shownBefore = events.slice(0, kinds.indexOf('reply_discarded')).filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  const shownAfter = events.slice(kinds.indexOf('reply_discarded')).filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  check('5: a dropped stream: what it showed is discarded before the retry', kinds.includes('reply_discarded') && shownBefore === 'First attempt ' && shownAfter === 'Second attempt.', { shownBefore, shownAfter });
  check('5: …the final message holds only the second attempt\'s text', runEnd()?.text === 'Second attempt.' && agent.session.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('|') === 'Second attempt.' && events.find((e) => e.type === 'assistant_message')?.text === 'Second attempt.');
  check('5: …usage is counted once', JSON.stringify(events.filter((e) => e.type === 'usage').map((e) => e.promptTokens)) === '[222]');
  check('5: …and the status said the connection was lost', statuses()[0] === 'Connection lost. Retrying in 1 s (2 of 6).', statuses());

  // A stream with no chunk for the idle limit counts as dropped
  reset();
  R.retryTiming.idleMs = 150;
  state.replies.push({ chunks: ['slow ', 'slower'], chunkDelayMs: 600 });
  state.replies.push({ content: 'Quick.' });
  await agent.run('Idle?');
  R.retryTiming.idleMs = R.STREAM_IDLE_MS;
  check('5: no chunk for the idle limit: a dropped connection, tried again', runEnd()?.text === 'Quick.' && events.some((e) => e.type === 'reply_discarded') && chat().length === 2, { text: runEnd()?.text, n: chat().length });

  // finish_reason "length" with half-written arguments
  reset();
  state.replies.push({ content: '', toolCalls: [{ id: 'call_cut', name: 'write_file', rawArgs: '{"path":"big.txt","content":"aaaa' }], finishReason: 'length' });
  state.replies.push({ content: 'Will send it in pieces.' });
  await agent.run('Write a big file');
  const cut = agent.session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_cut');
  check('5: "length" with half-written JSON: the call is not run, the result is the cut-off text', cut?.content === G.CUT_CALL_TEXT && !fs.existsSync(path.join(tmp, 'big.txt')), cut);
  check('5: …the row shows it as failed', events.some((e) => e.type === 'tool_end' && e.id === 'call_cut' && !e.ok && e.result === G.CUT_CALL_TEXT));
  reset();
  state.replies.push({ content: 'Two calls: ', toolCalls: [{ id: 'call_ok', name: 'write_file', args: { path: 'small.txt', content: 'fine' } }, { id: 'call_cut2', name: 'write_file', rawArgs: '{"path":"big2.txt","con' }], finishReason: 'length' });
  state.replies.push({ content: 'Done.' });
  await agent.run('Write two files');
  check('5: …a complete call of the same reply runs as usual', fs.existsSync(path.join(tmp, 'small.txt')) && !fs.existsSync(path.join(tmp, 'big2.txt')) && agent.session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_cut2')?.content === G.CUT_CALL_TEXT);

  // finish_reason "length" with text only
  reset();
  for (let i = 0; i < 4; i++) state.replies.push({ content: `part ${i + 1} `, finishReason: 'length' });
  await agent.run('A long essay');
  const lastReq = chat()[chat().length - 1].payload.messages;
  const continues = lastReq.filter((m) => m.role === 'user' && m.content === G.CONTINUE_TEXT).length;
  check('5: "length" with text only: one continuation per cut, capped at two', chat().length === 3 && continues === 2 && runEnd()?.reason === 'done' && runEnd()?.text === 'part 3 ', { n: chat().length, continues });
  check('5: …the continuation is a message in the conversation, the system prompt unchanged', lastReq[0].role === 'system' && !String(lastReq[0].content).includes('cut off') && chat()[0].payload.messages[0].content === lastReq[0].content);
  reset();
  state.replies.push({ content: 'part 1 ', finishReason: 'length' });
  state.replies.push({ content: 'and the end.' });
  await agent.run('A shorter essay');
  check('5: …one continuation, then the reply ends as usual', chat().length === 2 && runEnd()?.text === 'and the end.' && agent.session.messages.filter((m) => m.role === 'user' && m.content === G.CONTINUE_TEXT).length === 1);

  // ---------- 6: the same call again and again ----------
  reset();
  for (let i = 0; i < 6; i++) state.replies.push({ content: '', toolCalls: [{ id: `call_rep_${i}`, name: 'bash', args: { command: 'echo hi' } }] });
  await agent.run('Say hi');
  const results = agent.session.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const warned = results.map((r) => r.includes(G.REPEAT_WARNING));
  check('6: the 3rd identical call\'s result carries the warning, the first two not', results.length === 5 && JSON.stringify(warned) === '[false,false,true,true,true]' && results[2].endsWith(`\n${G.REPEAT_WARNING}`), warned);
  check('6: the run ends "loop" after the 5th; no 6th call runs', runEnd()?.reason === 'loop' && chat().length === 5 && state.replies.length === 1, { reason: runEnd()?.reason, n: chat().length });
  const loopNotices = events.filter((e) => e.type === 'error' && e.kind === 'notice');
  check('6: …with one notice line', loopNotices.length === 1 && loopNotices[0].message === 'Stopped: the model repeated the same call 5 times.', loopNotices);
  check('6: …and the warning is in the tool result, not the system prompt', !String(chat()[chat().length - 1].payload.messages[0].content).includes('exact call'));
  reset();
  for (let i = 0; i < 6; i++) state.replies.push({ content: '', toolCalls: [{ id: `call_tr_${i}`, name: 'terminal_read', args: { tab_id: 'none', wait_ms: 10 } }] });
  state.replies.push({ content: 'Finished waiting.' });
  await agent.run('Wait for the build');
  check('6: terminal_read with wait_ms six times does not end the run', runEnd()?.reason === 'done' && chat().length === 7 && !agent.session.messages.some((m) => m.role === 'tool' && m.content.includes(G.REPEAT_WARNING)), { reason: runEnd()?.reason, n: chat().length });

  // ---------- 7: the native Ollama path ----------
  config = { ...config, provider: 'ollama' };
  reset();
  state.replies.push({ status: 503, error: 'server busy' }, { content: 'From Ollama.' });
  await agent.run('Local?');
  check('7: Ollama: a 503 is retried, then the reply', runEnd()?.text === 'From Ollama.' && chat().filter((r) => r.url === '/api/chat').length === 2 && statuses()[0] === 'Provider busy. Retrying in 1 s (2 of 6).', statuses());
  reset();
  state.replies.push({ status: 404, error: 'model "mock" not found' });
  await agent.run('Missing?');
  check('7: Ollama: a 404 is not', chat().filter((r) => r.url === '/api/chat').length === 1 && runEnd()?.reason === 'error' && /Ollama returned HTTP 404/.test(errors()[0]?.message ?? ''), errors());
  reset();
  state.replies.push({ content: 'Cut here', doneReason: 'length' }, { content: ' and done.' });
  await agent.run('Long?');
  check('7: Ollama: done_reason "length" asks to continue, without the old warning', chat().length === 2 && runEnd()?.text === ' and done.' && !events.some((e) => e.type === 'error' && /output limit/.test(e.message)));
  const unreachable = { ...config, ollama: { ...config.ollama, baseURL: 'http://127.0.0.1:1' } };
  config = unreachable;
  reset();
  await agent.run('Nobody home?');
  check('7: Ollama unreachable: six tries, "Connection lost" while waiting, then the error', runEnd()?.reason === 'error' && /^Could not reach the provider after 6 tries: /.test(errors()[0]?.message ?? '') && statuses().filter(Boolean).length === 5 && statuses()[0].startsWith('Connection lost.'), errors());

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
