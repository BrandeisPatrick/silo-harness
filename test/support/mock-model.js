// Mock model servers for the round 7 tests: an OpenAI-compatible streaming endpoint (the Portkey path) and
// Ollama's native /api/chat + /api/show (the Ollama path, incl. the non-streaming summary request).
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
      if (state.apiKey && req.url.startsWith('/v1/') && req.headers.authorization !== `Bearer ${state.apiKey}`) {
        return json(401, { error: { message: 'Invalid API key (mock)', type: 'authentication_error' } });
      }
      // The models list most OpenAI-compatible services have (GET /v1/models)
      if (req.url === '/v1/models' && req.method === 'GET') return json(200, { object: 'list', data: (state.models ?? ['mock-model']).map((id) => ({ id, object: 'model', created: 0, owned_by: 'mock' })) });
      if (req.url === '/api/show') return json(200, { capabilities: ['completion', 'tools'] });
      // The local models, for the model menu: whatever `ollamaModels` lists (none unless a test sets it)
      if (req.url === '/api/tags' && state.ollamaModels) return json(200, { models: state.ollamaModels.map((name) => ({ name, model: name })) });
      // A one-shot request (titles, summaries, Auto mode's safety check): a queued reply marked `nonStream` that
      // matches answers it (`status` makes it fail with that HTTP status), else the summary as before. Streamed
      // requests never take a `nonStream` reply.
      if (!payload.stream && (req.url === '/api/chat' || req.url === '/v1/chat/completions')) {
        const at = state.replies.findIndex((r) => r.nonStream && (typeof r.when !== 'function' || r.when(payload)));
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
        const at = state.replies.findIndex((r) => !r.nonStream && (typeof r.when !== 'function' || r.when(payload)));
        const reply = at >= 0 ? state.replies.splice(at, 1)[0] : { content: 'Done.' };
        const message = { role: 'assistant', content: reply.chunks ? '' : (reply.content ?? '') };
        // Ollama's calls carry no id unless `ollamaToolIds` is set (as newer versions send them)
        if (reply.toolCalls) message.tool_calls = reply.toolCalls.map((c) => ({ ...(state.ollamaToolIds && c.id ? { id: c.id } : {}), function: { name: c.name, arguments: c.args } }));
        const answer = async () => {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          for (const piece of reply.chunks ?? []) {
            res.write(JSON.stringify({ model: payload.model, message: { role: 'assistant', content: piece }, done: false }) + '\n');
            await new Promise((r) => setTimeout(r, reply.chunkDelayMs ?? 50));
          }
          res.end(JSON.stringify({ model: payload.model, message, done: true, done_reason: reply.toolCalls ? 'tool_calls' : 'stop', prompt_eval_count: reply.promptTokens ?? state.ollamaPromptTokens, eval_count: 20 }) + '\n');
        };
        if (reply.delayMs) setTimeout(answer, reply.delayMs);
        else answer();
        return;
      }
      if (req.url !== '/v1/chat/completions') return json(404, {});
      if (!payload.stream) return json(200, { id: 't', object: 'chat.completion', created: 0, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content: state.summaryFails ? '' : state.summary }, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 120 } });
      // A reply with `when(payload)` only answers requests it matches (concurrent sessions share one mock); the first
      // matching reply is used. `delayMs` delays that reply; `chunks` streams the content in pieces `chunkDelayMs` apart.
      const at = state.replies.findIndex((r) => !r.nonStream && (typeof r.when !== 'function' || r.when(payload)));
      const reply = at >= 0 ? state.replies.splice(at, 1)[0] : { content: 'Done.' };
      setTimeout(async () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (obj) => res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: payload.model, ...obj })}\n\n`);
        if (reply.chunks) {
          for (const piece of reply.chunks) {
            send({ choices: [{ index: 0, delta: { role: 'assistant', content: piece } }] });
            await new Promise((r) => setTimeout(r, reply.chunkDelayMs ?? 50));
          }
        } else if (reply.content) send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.content } }] });
        if (reply.toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: reply.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }] });
        send({ choices: [], usage: { prompt_tokens: reply.promptTokens ?? 300, completion_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        res.end();
      }, reply.delayMs ?? state.delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ ...state, port: server.address().port, state, close: () => server.close() }));
  });
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
