// Mock model servers for the round 7 tests: an OpenAI-compatible streaming endpoint (the Portkey path),
// Ollama's native /api/chat + /api/show (the Ollama path, incl. the non-streaming summary request), and Anthropic's
// native /v1/messages (SSE events, tool_use, thinking, usage with cache fields; replies with `status` fail).
const http = require('node:http');

function startMock() {
  const state = { requests: [], replies: [], ollamaPromptTokens: 50, summary: 'SUMMARY PLACEHOLDER', summaryFails: false, delayMs: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      state.requests.push({ url: req.url, payload, headers: req.headers });
      const json = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      // A service that checks its key: with `apiKey` set, the OpenAI-compatible routes want exactly that bearer token.
      // Anthropic's API takes the key as x-api-key or (the SDK since 1.x) a bearer token
      if (state.apiKey && req.url.startsWith('/v1/messages') && req.headers['x-api-key'] !== state.apiKey && req.headers.authorization !== `Bearer ${state.apiKey}`) {
        return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key (mock)' } });
      }
      if (state.apiKey && req.url.startsWith('/v1/') && !req.url.startsWith('/v1/messages') && req.headers.authorization !== `Bearer ${state.apiKey}`) {
        return json(401, { error: { message: 'Invalid API key (mock)', type: 'authentication_error' } });
      }
      // The models list most OpenAI-compatible services have (GET /v1/models); `modelsDelayMs` holds it back and
      // `modelsStatus` fails it with that HTTP status
      if (req.url === '/v1/models' && req.method === 'GET') {
        return setTimeout(() => {
          if (state.modelsStatus) return json(state.modelsStatus, { error: { message: `mock error ${state.modelsStatus}` } });
          json(200, { object: 'list', data: (state.models ?? ['mock-model']).map((id) => ({ id, object: 'model', created: 0, owned_by: 'mock' })) });
        }, state.modelsDelayMs ?? 0);
      }
      if (req.url === '/api/show') return json(200, { capabilities: ['completion', 'tools'] });
      if (req.url.startsWith('/v1/messages')) return anthropic(state, payload, res, json);
      // A gateway that refuses prompt-cache fields it does not know (`rejectCacheFields`), as some do
      if (req.url === '/v1/chat/completions' && state.rejectCacheFields && /"(?:cache_control|prompt_cache_key|session_id)"/.test(body)) {
        return json(state.rejectCacheFields === 422 ? 422 : 400, { error: { message: 'Unrecognized request argument supplied: cache_control (mock)' } });
      }
      // A service that refuses the reasoning-effort fields (`rejectEffort`), as one without reasoning models does
      if (req.url === '/v1/chat/completions' && state.rejectEffort && (payload.reasoning_effort !== undefined || payload.reasoning !== undefined)) {
        return json(400, { error: { message: `Unrecognized request argument supplied: ${payload.reasoning_effort !== undefined ? 'reasoning_effort' : 'reasoning'} (mock)` } });
      }
      // The local models, for the model menu: whatever `ollamaModels` lists (none unless a test sets it)
      if (req.url === '/api/tags' && state.ollamaModels) return json(200, { models: state.ollamaModels.map((name) => ({ name, model: name })) });
      // A one-shot request (titles, summaries, Auto mode's safety check): a queued reply marked `nonStream` that
      // matches answers it (`status` makes it fail with that HTTP status), else the summary as before. Streamed
      // requests never take a `nonStream` reply.
      if (!payload.stream && (req.url === '/api/chat' || req.url === '/v1/chat/completions')) {
        const at = state.replies.findIndex((r) => r.nonStream && (typeof r.when !== 'function' || r.when(seen(payload))));
        // `classifierDefault` ({ decision, reason }): the standing answer of Auto mode's safety check when no reply
        // for it is queued (the screenshot scripts, where every check should pass)
        if (at < 0 && state.classifierDefault && isClassifierRequest(payload)) {
          const d = state.classifierDefault;
          const content = JSON.stringify({ decision: d.decision ?? 'allow', reason: d.reason ?? '[Local Work] part of the task' });
          return req.url === '/api/chat'
            ? json(200, { model: payload.model, message: { role: 'assistant', content }, done: true, prompt_eval_count: 300, eval_count: 20 })
            : json(200, { id: 'c', object: 'chat.completion', created: 0, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 20 } });
        }
        if (at >= 0) {
          const reply = state.replies.splice(at, 1)[0];
          setTimeout(() => {
            if (reply.status) return json(reply.status, { error: { message: reply.error || `mock error ${reply.status}` } });
            const content = reply.content ?? '';
            if (req.url === '/api/chat') return json(200, { model: payload.model, message: { role: 'assistant', content }, done: true, prompt_eval_count: 200, eval_count: 20 });
            json(200, { id: 't', object: 'chat.completion', created: 0, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 20 } });
          }, reply.delayMs ?? 0);
          return;
        }
      }
      if (req.url === '/api/chat') {
        if (!payload.stream) {
          setTimeout(() => {
            if (state.summaryFails) return json(500, { error: 'summary failed (test)' });
            json(200, { model: payload.model, message: { role: 'assistant', content: state.summary }, done: true, prompt_eval_count: 400, eval_count: 120 });
          }, state.summaryDelayMs ?? 0);
          return;
        }
        // As on the OpenAI-compatible path: a reply with `when(payload)` only answers requests it matches, and
        // `delayMs` holds it back (a run that stays in progress). Replies without either answer in order, at once.
        // `chunks` streams the content as lines of its own, `chunkDelayMs` apart, before the last line.
        const at = state.replies.findIndex((r) => !r.nonStream && (typeof r.when !== 'function' || r.when(seen(payload))));
        const reply = at >= 0 ? state.replies.splice(at, 1)[0] : { content: 'Done.' };
        const message = { role: 'assistant', content: reply.chunks ? '' : (reply.content ?? '') };
        // Ollama's calls carry no id unless `ollamaToolIds` is set (as newer versions send them)
        if (reply.toolCalls) message.tool_calls = reply.toolCalls.map((c) => ({ ...(state.ollamaToolIds && c.id ? { id: c.id } : {}), function: { name: c.name, arguments: c.args } }));
        const answer = async () => {
          // `status` fails the call with that HTTP status, as Ollama does
          if (reply.status) return json(reply.status, { error: reply.error || `mock error ${reply.status}` });
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          for (const piece of reply.chunks ?? []) {
            res.write(JSON.stringify({ model: payload.model, message: { role: 'assistant', content: piece }, done: false }) + '\n');
            await new Promise((r) => setTimeout(r, reply.chunkDelayMs ?? 50));
          }
          res.end(JSON.stringify({ model: payload.model, message, done: true, done_reason: reply.doneReason ?? (reply.toolCalls ? 'tool_calls' : 'stop'), prompt_eval_count: reply.promptTokens ?? state.ollamaPromptTokens, eval_count: 20 }) + '\n');
        };
        if (reply.delayMs) setTimeout(answer, reply.delayMs);
        else answer();
        return;
      }
      if (req.url !== '/v1/chat/completions') return json(404, {});
      if (!payload.stream) return json(200, { id: 't', object: 'chat.completion', created: 0, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content: state.summaryFails ? '' : state.summary }, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 120 } });
      // A reply with `when(payload)` only answers requests it matches (concurrent sessions share one mock); the first
      // matching reply is used. `delayMs` delays that reply; `chunks` streams the content in pieces `chunkDelayMs` apart.
      const at = state.replies.findIndex((r) => !r.nonStream && (typeof r.when !== 'function' || r.when(seen(payload))));
      const reply = at >= 0 ? state.replies.splice(at, 1)[0] : { content: 'Done.' };
      // `status` fails the call (`headers` go with it: retry-after, x-should-retry); `drop` ends the stream after the
      // content without a finish reason, as a dropped connection does; `finishReason` replaces the finish reason; a
      // tool call's `rawArgs` is sent as written (half-written JSON, say)
      setTimeout(async () => {
        if (reply.status) {
          res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers || {}) });
          return res.end(JSON.stringify({ error: { message: reply.error || `mock error ${reply.status}`, type: reply.errorType, code: reply.code } }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (obj) => res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: payload.model, ...obj })}\n\n`);
        if (reply.chunks) {
          for (const piece of reply.chunks) {
            send({ choices: [{ index: 0, delta: { role: 'assistant', content: piece } }] });
            await new Promise((r) => setTimeout(r, reply.chunkDelayMs ?? 50));
          }
        } else if (reply.content) send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.content } }] });
        if (reply.drop) return res.end();
        if (reply.toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: reply.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args) } })) } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason ?? (reply.toolCalls ? 'tool_calls' : 'stop') }] });
        // `usage` replaces the counts (cache fields and all), as a gateway that caches would send them
        // `promptTokensFromBody`: about a token per four characters of the request, as a real model would count;
        // `cachedTokens`: a cache read reported with every reply, as a gateway that caches would
        const counts = { prompt_tokens: reply.promptTokens ?? (state.promptTokensFromBody ? Math.ceil(body.length / 4) : 300), completion_tokens: 30 };
        if (state.cachedTokens) counts.prompt_tokens_details = { cached_tokens: state.cachedTokens };
        // `noUsage`: no usage chunk at all, as a server that does not count tokens
        if (!reply.noUsage) send({ choices: [], usage: reply.usage ?? counts });
        res.write('data: [DONE]\n\n');
        res.end();
      }, reply.delayMs ?? state.delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ ...state, port: server.address().port, state, close: () => server.close() }));
  });
}

/**
 * Anthropic's Messages API. A reply (state.replies, the first whose `when(payload)` matches) may have: content,
 * toolCalls ({ id, name, args }), thinking (text of a thinking block, with a signature), usage (fields of the usage
 * object: input_tokens, cache_read_input_tokens, cache_creation_input_tokens), status and error (fail with that HTTP
 * status and error type), delayMs, chunks (the text in pieces chunkDelayMs apart), failMidStream (an error event after
 * the first text). Non-streamed requests (Auto mode's check) take `nonStream` replies, as on the other routes.
 * `stopReason` replaces the stop reason ("max_tokens", "refusal"), `headers` go with a failing status, `drop` ends the
 * stream after the text without a stop reason, a tool call's `rawArgs` is streamed as written, and `thinkingChunks`
 * streams the thinking in pieces chunkDelayMs apart.
 */
function anthropic(state, payload, res, json) {
  const stream = !!payload.stream;
  // An endpoint without deferred tools (`rejectDeferred`): refuses a request that has any
  if (state.rejectDeferred && JSON.stringify(payload.tools ?? []).includes('"defer_loading"')) {
    return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'tools.20.defer_loading: Extra inputs are not permitted (mock)' } });
  }
  // An endpoint without the effort setting (`rejectEffort`): refuses output_config.effort
  if (state.rejectEffort && payload.output_config?.effort !== undefined) {
    return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.effort: Extra inputs are not permitted (mock)' } });
  }
  const at = state.replies.findIndex((r) => !!r.nonStream === !stream && (typeof r.when !== 'function' || r.when(seen(payload))));
  let reply = at >= 0 ? state.replies.splice(at, 1)[0] : null;
  if (!reply && !stream && state.classifierDefault && isClassifierRequest(payload)) {
    const d = state.classifierDefault;
    reply = { content: JSON.stringify({ decision: d.decision ?? 'allow', reason: d.reason ?? '[Local Work] part of the task' }) };
  }
  reply = reply ?? { content: stream ? 'Done.' : state.summary };
  const usage = { input_tokens: 300, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(reply.usage || {}) };
  const blocks = [];
  if (reply.thinking || reply.thinkingChunks) blocks.push({ type: 'thinking', thinking: reply.thinking ?? reply.thinkingChunks.join(''), signature: reply.signature ?? 'sig-mock' });
  if (reply.content || reply.chunks) blocks.push({ type: 'text', text: reply.content ?? reply.chunks.join('') });
  for (const c of reply.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`, name: c.name, input: c.args ?? {}, rawArgs: c.rawArgs });
  const stop = reply.stopReason ?? (reply.toolCalls?.length ? 'tool_use' : 'end_turn');
  const answer = async () => {
    if (reply.status) {
      res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers || {}) });
      return res.end(JSON.stringify({ type: 'error', error: { type: reply.errorType ?? 'api_error', message: reply.error ?? `mock error ${reply.status}` } }));
    }
    if (!stream) {
      return json(200, { id: 'msg_mock', type: 'message', role: 'assistant', model: payload.model, content: blocks.length ? blocks : [{ type: 'text', text: '' }], stop_reason: stop, stop_sequence: null, usage: { ...usage, output_tokens: 20 } });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`);
    send('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
    for (const [index, b] of blocks.entries()) {
      if (b.type === 'thinking') {
        send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        // `thinkingChunks`: the thinking in pieces `chunkDelayMs` apart (a slow thinking phase)
        for (const piece of reply.thinkingChunks ?? [b.thinking]) {
          send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: piece } });
          if (reply.thinkingChunks) await new Promise((r) => setTimeout(r, reply.chunkDelayMs ?? 50));
        }
        send('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
      } else if (b.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        for (const piece of reply.chunks ?? [b.text]) {
          send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
          if (reply.failMidStream) {
            send('error', { error: { type: 'overloaded_error', message: 'Overloaded (mock, mid-stream)' } });
            return res.end();
          }
          if (reply.chunks) await new Promise((r) => setTimeout(r, reply.chunkDelayMs ?? 50));
        }
        if (reply.drop) return res.end();
      } else {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        const args = b.rawArgs ?? JSON.stringify(b.input);
        // The arguments in two pieces, as the API streams them
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: args.slice(0, Math.ceil(args.length / 2)) } });
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: args.slice(Math.ceil(args.length / 2)) } });
      }
      send('content_block_stop', { index });
    }
    send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 30 } });
    send('message_stop', {});
    res.end();
  };
  setTimeout(answer, reply.delayMs ?? state.delayMs ?? 0);
}

/** The app's context note (src/main/compact.ts CONTEXT_NOTE_PREFIX): appended when the mode, folder or name changes */
const CONTEXT_NOTE = '[Session context]';

/**
 * The request as a reply's `when` sees it: without the app's context notes, which come after the user's message
 * when something changed, so "the last message is the user's" still holds. (state.requests keeps them.)
 */
function seen(payload) {
  if (!Array.isArray(payload?.messages)) return payload;
  const note = (m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(CONTEXT_NOTE);
  const nativeNote = (m) => m && m.role === 'user' && Array.isArray(m.content) && m.content.length && m.content.every((b) => b.type === 'text' && String(b.text).startsWith(CONTEXT_NOTE));
  if (!payload.messages.some((m) => note(m) || nativeNote(m))) return payload;
  return { ...payload, messages: payload.messages.filter((m) => !note(m) && !nativeNote(m)) };
}

let askSeq = 0;
/**
 * A scripted reply in which the model calls ask_user with `questions` (each { question, header, options, multiSelect },
 * options as { label, description }); push it onto `state.replies` like any other. `extra` adds reply fields (when,
 * delayMs, content) or an `id` for the call.
 */
function askUserReply(questions, extra = {}) {
  const { id, ...rest } = extra;
  return { content: '', ...rest, toolCalls: [{ id: id ?? `call_ask_${++askSeq}`, name: 'ask_user', args: { questions } }] };
}

/** Marks Auto mode's safety-check requests (src/main/agent/classifier.ts CLASSIFIER_MARK). */
const CLASSIFIER_MARK = 'You are the safety check of Auto mode in Silo Harness';

/** True for a request of Auto mode's safety check (its system message). */
function isClassifierRequest(payload) {
  // Anthropic's native requests carry the instructions as system blocks
  if (Array.isArray(payload?.system)) return String(payload.system[0]?.text ?? '').startsWith(CLASSIFIER_MARK);
  const sys = (payload?.messages ?? []).find((m) => m.role === 'system');
  return typeof sys?.content === 'string' && sys.content.startsWith(CLASSIFIER_MARK);
}

/**
 * A scripted answer of Auto mode's safety check: decision 'allow' or 'block' with its reason, as one line of JSON.
 * `extra` adds fields: `when` (and-ed with being a check request), `content` (a raw answer: garbage, say), `status`
 * (fail with that HTTP status), `delayMs`. Push it onto `state.replies` like any other.
 */
function classifierReply(decision, reason = '', extra = {}) {
  const { when, ...rest } = extra;
  return {
    nonStream: true,
    content: JSON.stringify({ decision, reason }),
    ...rest,
    when: (payload) => isClassifierRequest(payload) && (typeof when !== 'function' || when(payload)),
  };
}

module.exports = { startMock, askUserReply, classifierReply, isClassifierRequest, CLASSIFIER_MARK };
