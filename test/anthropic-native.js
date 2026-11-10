// The native Anthropic Messages path (src/main/agent/anthropic.ts): the history converted at the boundary
// (table-driven), cache marks in their places, a tool loop through the mock's /v1/messages, usage with cache fields,
// thinking kept and replayed, errors in the loop's terms, abort, and Auto mode's check on the same API.
// Run: node test/anthropic-native.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const A = dist('agent/anthropic.js');
const P = dist('providers.js');
const R = dist('agent/retry.js');
const { startMock, classifierReply } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  // ---------- 1: conversion (pure, table-driven) ----------
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
  const conv = [
    ['system and a user message',
      [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
      { system: [{ type: 'text', text: 'SYS' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }],
    ['a user message with an image (data URL)',
      [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: PNG } }] }],
      { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] }],
    ['assistant text and tool calls become text and tool_use; results and the text after them one user turn, results first',
      [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'Reading.', tool_calls: [call('t1', 'read_file', { path: 'a' }), call('t2', 'bash', { command: 'ls' })] }, { role: 'tool', tool_call_id: 't1', content: 'A' }, { role: 'tool', tool_call_id: 't2', content: 'B' }, { role: 'user', content: 'and also' }],
      { system: [], messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }, { type: 'tool_use', id: 't2', name: 'bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'A' }, { type: 'tool_result', tool_use_id: 't2', content: 'B' }, { type: 'text', text: 'and also' }] },
      ] }],
    ['a screenshot between two results: the results first, then the screenshot',
      [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [call('s1', 'browser_screenshot', {}), call('s2', 'bash', {})] }, { role: 'tool', tool_call_id: 's1', content: 'shot' }, { role: 'user', content: [{ type: 'text', text: '[Screenshot returned by browser_screenshot]' }, { type: 'image_url', image_url: { url: PNG } }] }, { role: 'tool', tool_call_id: 's2', content: 'ok' }],
      { system: [], messages: [
        { role: 'user', content: [{ type: 'text', text: 'x' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'browser_screenshot', input: {} }, { type: 'tool_use', id: 's2', name: 'bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'shot' }, { type: 'tool_result', tool_use_id: 's2', content: 'ok' }, { type: 'text', text: '[Screenshot returned by browser_screenshot]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] },
      ] }],
    ['consecutive user messages are one turn (a message, then the context note)',
      [{ role: 'user', content: 'one' }, { role: 'user', content: '[Session context] note' }],
      { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: '[Session context] note' }] }] }],
    ['empty contents get placeholders the API accepts',
      [{ role: 'user', content: '  ' }, { role: 'assistant', content: '' }, { role: 'user', content: 'q' }, { role: 'assistant', content: null, tool_calls: [call('e1', 'bash', '')] }, { role: 'tool', tool_call_id: 'e1', content: '' }],
      { system: [], messages: [
        { role: 'user', content: [{ type: 'text', text: '(empty message)' }] },
        { role: 'assistant', content: [{ type: 'text', text: '(no reply)' }] },
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: '(no output)' }] },
      ] }],
    ['arguments that are not JSON stay visible',
      [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', tool_calls: [call('j1', 'bash', '{oops')] }, { role: 'tool', tool_call_id: 'j1', content: 'Error: not JSON' }],
      { system: [], messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'j1', name: 'bash', input: { _raw: '{oops' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'j1', content: 'Error: not JSON' }] },
      ] }],
    ['a history that starts with the assistant gets a user turn first',
      [{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'hi' }],
      { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: '(continued)' }] }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }] }],
  ];
  for (const [label, history, want] of conv) {
    const got = A.toAnthropic(history);
    check(`1: ${label}`, same(got, want), got);
  }
  const think = [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }];
  const withThinking = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', tool_calls: [call('k1', 'bash', {})], [A.THINKING_KEY]: think }, { role: 'tool', tool_call_id: 'k1', content: 'r' }];
  check('1: kept thinking goes first in its reply', same(A.toAnthropic(withThinking).messages[1].content[0], think[0]));
  check('1: …and is left out before stripThinkingBefore', A.toAnthropic(withThinking, 2).messages[1].content[0].type === 'text');
  check('1: other providers get the history without it', !(A.THINKING_KEY in A.withoutNative(withThinking)[1]) && A.withoutNative([{ role: 'user', content: 'x' }])[0].content === 'x');
  check('1: the conversion is deterministic (same bytes twice)', JSON.stringify(A.toAnthropic(conv[2][1])) === JSON.stringify(A.toAnthropic(conv[2][1])));

  // ---------- 2: thinking, max_tokens, which provider ----------
  check('2: Haiku 5.5 runs with thinking off', same(A.thinkingFor('claude-haiku-5-5'), { type: 'disabled' }));
  check('2: Opus 5.5 always thinks: adaptive, summaries shown', same(A.thinkingFor('claude-opus-5-5'), { type: 'adaptive', display: 'summarized' }));
  check('2: Sonnet 5.5 turns it off its own way', same(A.thinkingFor('claude-sonnet-5-5'), { type: 'between_tools' }));
  check('2: Claude 4 and 3 models get no thinking field', A.thinkingFor('claude-opus-4-8') === undefined && A.thinkingFor('claude-haiku-4-5') === undefined && A.thinkingFor('claude-3-5-sonnet-20241022') === undefined);
  check('2: max_tokens defaults per family', A.defaultMaxTokens('claude-3-haiku-20240307') === 4096 && A.defaultMaxTokens('claude-3-5-haiku-latest') === 8192 && A.defaultMaxTokens('claude-haiku-5-5') === 32000);
  check('2: native for type anthropic and for a base URL on api.anthropic.com', A.isNativeAnthropic({ type: 'anthropic', baseURL: 'http://x' }) && A.isNativeAnthropic({ type: 'portkey', baseURL: 'https://api.anthropic.com/v1' }) && !A.isNativeAnthropic({ type: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' }));

  // ---------- 3: cache marks ----------
  const specs = [{ type: 'function', function: { name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } } }, { type: 'function', function: { name: 'bash', description: 'b', parameters: { type: 'object', properties: {} } } }];
  const loop = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'go' }];
  for (let i = 0; i < 14; i++) loop.push({ role: 'assistant', content: `step ${i}`, tool_calls: [call(`l${i}`, 'bash', { i })] }, { role: 'tool', tool_call_id: `l${i}`, content: `out ${i}` });
  const req = A.nativeRequest('claude-haiku-5-5', loop, specs, 1000);
  const marks = [];
  const walk = (o, where) => {
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) k === 'cache_control' ? marks.push([where, v]) : walk(v, `${where}.${k}`);
  };
  walk(req, 'req');
  check('3: four marks at most', marks.length === 4, marks);
  check('3: the last tool and the end of the system prompt, an hour', same(req.tools[1].cache_control, { type: 'ephemeral', ttl: '1h' }) && same(req.system[0].cache_control, { type: 'ephemeral', ttl: '1h' }) && !req.tools[0].cache_control);
  const lastMsg = req.messages[req.messages.length - 1];
  check('3: the newest message\'s last block, five minutes', same(lastMsg.content[lastMsg.content.length - 1].cache_control, { type: 'ephemeral' }));
  const middle = marks.filter(([w]) => w.startsWith('req.messages') && !w.startsWith(`req.messages[${req.messages.length - 1}]`));
  check('3: one earlier message mark on the grid, five minutes', middle.length === 1 && same(middle[0][1], { type: 'ephemeral' }), middle);
  // The grid mark stays put while the loop grows by one step, so the next request finds the entry it wrote
  const next = A.nativeRequest('claude-haiku-5-5', [...loop, { role: 'assistant', content: 's', tool_calls: [call('lx', 'bash', {})] }, { role: 'tool', tool_call_id: 'lx', content: 'o' }], specs, 1000);
  const marks2 = [];
  const walk2 = (o, where) => {
    if (Array.isArray(o)) o.forEach((x, i) => walk2(x, `${where}[${i}]`));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) k === 'cache_control' ? marks2.push(where) : walk2(v, `${where}.${k}`);
  };
  walk2(next, 'req');
  check('3: the grid mark is in the same place one step later', marks2.includes(middle[0][0]), [middle[0][0], marks2]);
  check('3: thinking blocks never carry a mark', (() => {
    const r = A.nativeRequest('claude-opus-5-5', [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', tool_calls: [call('z', 'bash', {})], [A.THINKING_KEY]: think }, { role: 'tool', tool_call_id: 'z', content: 'r' }], [], 100);
    return !r.messages[1].content[0].cache_control;
  })());
  check('3: a short conversation has only the tail mark in its messages', (() => {
    const r = A.nativeRequest('claude-haiku-5-5', [{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }], [], 100);
    return same(r.messages[0].content[0].cache_control, { type: 'ephemeral' }) && !r.tools;
  })());

  // ---------- 4: a tool loop through the agent ----------
  // The retry loop's waits return at once (agent/retry.ts retryTiming); the waits asked for are kept
  const waits = [];
  R.retryTiming.random = () => 0.5;
  R.retryTiming.sleep = async (ms, signal) => {
    waits.push(ms);
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  const mock = await startMock();
  const { state } = mock;
  state.apiKey = 'sk-test-native-key';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-native-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'hello');
  let config = {
    provider: 'claude',
    providers: { claude: { type: 'anthropic', baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'sk-test-native-key', model: 'claude-haiku-5-5', headers: { 'X-Extra': 'yes' } } },
    ollama: { baseURL: 'http://127.0.0.1:1', model: 'm', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: '', apiKey: '', model: '', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: tmp, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: true, notifications: false, allowRules: {},
  };
  check('4: makeClient gives the native client for this provider', !!P.makeClient(config).native);
  const store = new SessionStore(path.join(tmp, 'sessions'));
  let events = [];
  const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], (ev) => events.push(ev));
  const native = () => state.requests.filter((r) => r.url.startsWith('/v1/messages'));
  const reset = () => {
    events = [];
    state.requests.length = 0;
    state.replies.length = 0;
  };
  state.replies.push({ content: 'Reading it.', toolCalls: [{ id: 'toolu_1', name: 'read_file', args: { path: 'notes.txt' } }], usage: { input_tokens: 50, cache_creation_input_tokens: 4000 } });
  state.replies.push({ content: 'It says hello.', usage: { input_tokens: 60, cache_read_input_tokens: 4000, cache_creation_input_tokens: 120 } });
  await agent.run('What does notes.txt say?');
  const reqs = native();
  check('4: two native requests, streamed, nothing on the OpenAI route', reqs.length === 2 && reqs.every((r) => r.payload.stream === true) && !state.requests.some((r) => r.url === '/v1/chat/completions'), state.requests.map((r) => r.url));
  check('4: the key as the API key (a bearer token in SDK 1.x), the provider\'s headers', reqs[0].headers.authorization === 'Bearer sk-test-native-key' && reqs[0].headers['x-extra'] === 'yes');
  const r1 = reqs[1].payload;
  check('4: model, max_tokens, thinking off for Haiku 5.5', r1.model === 'claude-haiku-5-5' && r1.max_tokens === 32000 && same(r1.thinking, { type: 'disabled' }), { model: r1.model, max: r1.max_tokens, thinking: r1.thinking });
  check('4: the second request has the tool_use and its tool_result', r1.messages[1].role === 'assistant' && r1.messages[1].content.some((b) => b.type === 'tool_use' && b.id === 'toolu_1' && b.input.path === 'notes.txt') && r1.messages[2].content[0].type === 'tool_result' && /hello/.test(r1.messages[2].content[0].content));
  check('4: the tools are Anthropic tools with the last one marked', r1.tools.every((t) => t.name && t.input_schema && !t.function) && same(r1.tools[r1.tools.length - 1].cache_control, { type: 'ephemeral', ttl: '1h' }));
  check('4: the first request is the start of the second, apart from where the tail mark moved', (() => {
    const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v)));
    const a = strip(reqs[0].payload);
    const b = strip(r1);
    return same(a.system, b.system) && same(a.tools, b.tools) && same(a.messages, b.messages.slice(0, a.messages.length));
  })());
  const usage = events.filter((e) => e.type === 'usage');
  check('4: usage: the prompt is the whole input, with the cache counts', usage.length === 2 && usage[0].promptTokens === 4050 && usage[0].cacheWriteTokens === 4000 && usage[0].cacheReadTokens === 0 && usage[1].promptTokens === 4180 && usage[1].cacheReadTokens === 4000 && usage[1].completionTokens === 30, usage);
  check('4: the run ended with the reply; text streamed as usual', events.find((e) => e.type === 'run_end')?.text === 'It says hello.' && events.some((e) => e.type === 'text_delta' && e.text === 'Reading it.'));
  check('4: the stored history stays in the OpenAI shape', agent.session.messages[2].role === 'assistant' && agent.session.messages[2].tool_calls[0].function.name === 'read_file' && agent.session.messages[3].role === 'tool');
  check('4: the context breakdown shows the cached share', Math.abs(agent.contextBreakdown().cached - 4000 / 4210) < 0.001, agent.contextBreakdown().cached);

  // ---------- 5: thinking kept and replayed (a model that always thinks) ----------
  reset();
  config = { ...config, providers: { claude: { ...config.providers.claude, model: 'claude-opus-5-5' } } };
  state.replies.push({ thinking: 'Let me look.', signature: 'sig-1', content: '', toolCalls: [{ id: 'toolu_2', name: 'read_file', args: { path: 'notes.txt' } }] });
  state.replies.push({ content: 'Done thinking.' });
  await agent.run('Think, then read notes.txt');
  const t1 = native()[1].payload;
  const stored = agent.session.messages.find((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'toolu_2');
  check('5: the request asks for adaptive thinking with summaries', same(native()[0].payload.thinking, { type: 'adaptive', display: 'summarized' }));
  check('5: the thinking was shown as it came', events.some((e) => e.type === 'thinking_delta' && e.text === 'Let me look.'));
  check('5: the thinking is kept on the stored reply', stored && same(stored[A.THINKING_KEY], [{ type: 'thinking', thinking: 'Let me look.', signature: 'sig-1' }]));
  const asst = t1.messages.find((m) => m.role === 'assistant' && m.content.some((b) => b.id === 'toolu_2'));
  check('5: …and replayed first in that reply, signature and all', asst && same(asst.content[0], { type: 'thinking', thinking: 'Let me look.', signature: 'sig-1' }), asst && asst.content);
  // The API refuses kept thinking once the history before it changed: sent again without it, once
  reset();
  state.replies.push({ status: 400, errorType: 'invalid_request_error', error: 'messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' });
  state.replies.push({ content: 'Fine without it.' });
  await agent.run('Go on');
  const retry = native();
  check('5: a refused thinking block: retried once without the kept thinking, and the run goes on', retry.length === 2 && JSON.stringify(retry[0].payload.messages).includes('sig-1') && !JSON.stringify(retry[1].payload.messages).includes('sig-1') && events.find((e) => e.type === 'run_end')?.reason === 'done', retry.length);
  reset();
  state.replies.push({ content: 'Still without.' });
  await agent.run('And later');
  check('5: …and that thinking is not sent again', !JSON.stringify(native()[0].payload.messages).includes('sig-1'));
  config = { ...config, providers: { claude: { ...config.providers.claude, model: 'claude-haiku-5-5' } } };
  // The OpenAI-shaped and Ollama paths never send the kept thinking (complete.ts passes them withoutNative's history)
  check('5: other providers get the history without the kept thinking', !JSON.stringify(A.withoutNative(agent.session.messages)).includes(A.THINKING_KEY));

  // ---------- 6: errors ----------
  // context too long: the loop compacts and retries the call
  reset();
  // A session with an earlier turn long enough that a brief is smaller than it
  agent.session = store.create();
  state.replies.push({ content: 'A long answer. '.repeat(400) });
  await agent.run('Tell me everything');
  reset();
  state.summary = '## 1. Request and intent\nThe conversation so far, in a brief.';
  state.replies.push({ status: 400, errorType: 'invalid_request_error', error: 'prompt is too long: 210000 tokens > 200000 maximum' });
  state.replies.push({ content: 'After the fold.' });
  await agent.run('One more thing');
  check('6: "prompt is too long" compacts and retries the call', events.some((e) => e.type === 'compact_end' && e.compaction) && events.find((e) => e.type === 'run_end')?.text === 'After the fold.' && native().length === 2, events.filter((e) => e.type === 'error').map((e) => e.message));
  // a bad key
  reset();
  state.replies.push({ status: 401, errorType: 'authentication_error', error: 'invalid x-api-key' });
  await agent.run('Hello?');
  const authErr = events.find((e) => e.type === 'error' && !e.kind);
  check('6: a refused key: the provider and what to check, no key in it', authErr && /refused the key \(HTTP 401\): invalid x-api-key/.test(authErr.message) && !authErr.message.includes('sk-test-native-key'), authErr);
  // overloaded every time: six tries (the agent's own loop; the SDK's retries are off), then one error that says so
  reset();
  for (let i = 0; i < 6; i++) state.replies.push({ status: 529, errorType: 'overloaded_error', error: 'Overloaded' });
  await agent.run('Busy?');
  const over = events.filter((e) => e.type === 'error' && !e.kind);
  check('6: overloaded: six tries, then one error that says so in plain words', over.length === 1 && /^Could not reach the provider after 6 tries: .*overloaded \(HTTP 529\)/.test(over[0].message) && native().length === 6 && events.find((e) => e.type === 'run_end')?.reason === 'error', over);
  check('6: …with "Provider busy" on the status line while it waited', events.filter((e) => e.type === 'retry_status' && e.text).map((e) => e.text).join('|').startsWith('Provider busy. Retrying in 1 s (2 of 6).|Provider busy. Retrying in 2 s (3 of 6).'), events.filter((e) => e.type === 'retry_status'));
  // rate limited twice, then through
  reset();
  for (let i = 0; i < 2; i++) state.replies.push({ status: 429, errorType: 'rate_limit_error', error: 'Number of request tokens has exceeded your rate limit' });
  state.replies.push({ content: 'Through.' });
  await agent.run('Fast?');
  check('6: rate limited twice: retried, and the run ends with the reply', events.find((e) => e.type === 'run_end')?.text === 'Through.' && native().length === 3 && !events.some((e) => e.type === 'error' && !e.kind));
  // rate limited with a long Retry-After: no retry, the wait is said
  reset();
  state.replies.push({ status: 429, errorType: 'rate_limit_error', error: 'Number of request tokens has exceeded your rate limit', headers: { 'retry-after': '300' } });
  await agent.run('Later?');
  const rate = events.find((e) => e.type === 'error' && !e.kind);
  check('6: a Retry-After over 60 s: no retry, the error says when, and the provider\'s words', native().length === 1 && rate && /^Rate limited\. Try again in 5 min\. .*rate limiting/.test(rate.message), rate);
  // an error in the middle of the stream, then a reply: only the second attempt's text is kept
  reset();
  state.replies.push({ content: 'partial', thinking: 'first thoughts', failMidStream: true, usage: { input_tokens: 70 } });
  state.replies.push({ content: 'Whole answer.', usage: { input_tokens: 80 } });
  await agent.run('Stream?');
  const kinds = events.map((e) => e.type);
  check('6: an error mid-stream: what it showed is discarded, then the call is tried again', kinds.indexOf('reply_discarded') > kinds.indexOf('text_delta') && native().length === 2 && events.find((e) => e.type === 'run_end')?.reason === 'done');
  check('6: …the stored reply is the second attempt\'s only, without the first one\'s thinking', agent.session.messages[agent.session.messages.length - 1].content === 'Whole answer.' && !JSON.stringify(agent.session.messages).includes('first thoughts'));
  check('6: …and usage is counted once', events.filter((e) => e.type === 'usage').length === 1 && events.find((e) => e.type === 'usage').promptTokens === 80);
  // a stream that ends without a stop reason (a dropped connection)
  reset();
  state.replies.push({ content: 'half', drop: true });
  state.replies.push({ content: 'All of it.' });
  await agent.run('Drop?');
  check('6: a stream that ends without a stop reason is retried', events.some((e) => e.type === 'reply_discarded') && events.find((e) => e.type === 'run_end')?.text === 'All of it.' && native().length === 2);

  // ---------- 6b: a refusal, and a reply cut at the output limit ----------
  reset();
  state.replies.push({ content: 'I can\'t help with that.', stopReason: 'refusal' });
  await agent.run('Something it declines');
  const notices = events.filter((e) => e.type === 'error');
  check('6b: a refusal: one notice, the run ends done, no second request', native().length === 1 && notices.length === 1 && notices[0].kind === 'notice' && notices[0].message === 'The model declined this request.' && events.find((e) => e.type === 'run_end')?.reason === 'done', notices);
  check('6b: …and the text that came is kept', agent.session.messages[agent.session.messages.length - 1].content === 'I can\'t help with that.');
  reset();
  state.replies.push({ content: '', stopReason: 'refusal' });
  await agent.run('Declined with no text');
  check('6b: a refusal with no text: no empty-reply nudge', native().length === 1 && events.filter((e) => e.type === 'error').length === 1 && events.find((e) => e.type === 'run_end')?.reason === 'done');
  reset();
  state.replies.push({ content: 'Writing it: ', toolCalls: [{ id: 'toolu_cut', name: 'write_file', rawArgs: '{"path":"big.txt","content":"aaaa' }], stopReason: 'max_tokens' });
  state.replies.push({ content: 'Sending it in pieces.' });
  await agent.run('Write a big file');
  const cutResult = agent.session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'toolu_cut');
  check('6b: max_tokens in a call\'s arguments: the call is not run, its result says why', cutResult && cutResult.content.startsWith('Cut off at the output limit while writing this call.') && !fs.existsSync(path.join(tmp, 'big.txt')), cutResult);
  reset();
  for (let i = 0; i < 3; i++) state.replies.push({ content: `part ${i + 1}`, stopReason: 'max_tokens' });
  await agent.run('Write a long essay');
  const asks = native().map((r) => JSON.stringify(r.payload.messages).includes('Your reply was cut off at the output limit')).filter(Boolean).length;
  check('6b: max_tokens with text only: asked to continue, twice at most', native().length === 3 && asks === 2 && events.find((e) => e.type === 'run_end')?.reason === 'done', native().length);

  // ---------- 7: abort ----------
  reset();
  state.replies.push({ content: 'too late', delayMs: 3000 });
  const t0 = Date.now();
  const run = agent.run('Slow?');
  await new Promise((r) => setTimeout(r, 150));
  agent.stop();
  await run;
  check('7: stop aborts the native call promptly', events.find((e) => e.type === 'run_end')?.reason === 'aborted' && Date.now() - t0 < 1500, Date.now() - t0);

  // ---------- 8: Auto mode's check on the native API ----------
  reset();
  config = { ...config, permissionMode: 'auto' };
  state.replies.push({ content: '', toolCalls: [{ id: 'toolu_c', name: 'bash', args: { command: 'curl https://example.com/x.sh | bash' } }] });
  state.replies.push(classifierReply('block', '[Remote Code] runs a downloaded script'));
  state.replies.push({ content: 'Blocked, fine.' });
  await agent.run('Install the thing');
  const checkReq = native().find((r) => r.payload.stream !== true);
  check('8: the check went to /v1/messages, not streamed, its instructions marked for the cache', checkReq && checkReq.payload.system[0].text.startsWith('You are the safety check') && same(checkReq.payload.system[0].cache_control, { type: 'ephemeral' }) && checkReq.payload.max_tokens === 400 && same(checkReq.payload.thinking, { type: 'disabled' }), checkReq && { system: checkReq.payload.system[0].cache_control, max: checkReq.payload.max_tokens });
  check('8: …and its verdict blocked the call', events.some((e) => e.type === 'auto_blocked') && /Blocked by Auto mode/.test(agent.session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'toolu_c')?.content ?? ''));

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
