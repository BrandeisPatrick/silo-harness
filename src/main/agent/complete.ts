// One model call: streamed through the OpenAI client (or Ollama's native chat), the fallbacks when a gateway rejects
// stream_options or streaming with tools, and the plain-chat retry for an Ollama model that takes no tools.

import type OpenAI from 'openai';
import type { AgentEvent, AppConfig } from '../../shared/types';
import { isContextLengthError } from '../compact';
import { contextSize, ollamaChat, type ToolCall, type ToolSpec, type Usage } from '../ollama';
import { ollamaOf } from '../providers';
import type { Msg } from '../sessions';
import { errorMessage } from './errors';

/** What the agent lends a model call: its events, its usage report and the memories kept across calls. */
export interface CompletionHost {
  emit(ev: AgentEvent): void;
  reportUsage(usage: Usage): void;
  /** base URL + model pairs that rejected stream_options; they stream without usage */
  noStreamUsage: Set<string>;
  /** Ollama base URL + model → whether the model accepts tools (vision-only models do not); unknown until checked */
  toolSupport: Map<string, boolean>;
  /** max_tokens for the provider in use, when its entry sets maxOutput */
  maxOutput(): number | undefined;
}

export function noToolsNotice(model: string): string {
  return `${model} does not support tools, so this run is a plain chat: it can see your message and images but cannot read files, run commands or browse.`;
}

/** Folds one chunk's usage into the running counts (gateways may repeat or split the counts across chunks). */
function mergeUsage(prev: Usage | null, u: { prompt_tokens?: number; completion_tokens?: number }): Usage {
  return {
    promptTokens: Math.max(prev?.promptTokens ?? 0, Number(u.prompt_tokens) || 0),
    completionTokens: Math.max(prev?.completionTokens ?? 0, Number(u.completion_tokens) || 0),
  };
}

export async function complete(
  host: CompletionHost,
  cfg: AppConfig,
  client: OpenAI | null,
  model: string,
  history: Msg[],
  specs: ToolSpec[],
  signal: AbortSignal,
  turn: number,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  if (!client) {
    const ol = ollamaOf(cfg);
    const chat = (tools: ToolSpec[]) =>
      ollamaChat({
        baseURL: ol.baseURL,
        model,
        numCtx: contextSize(ol.numCtx),
        think: ol.think ?? 'auto',
        messages: history,
        tools,
        signal,
        turn,
        onText: (t) => host.emit({ type: 'text_delta', text: t }),
        onThinking: (t) => host.emit({ type: 'thinking_delta', text: t }),
        onWarning: (message) => host.emit({ type: 'error', message }),
        onUsage: (usage) => host.reportUsage(usage),
      });
    try {
      return await chat(specs);
    } catch (err) {
      // An Ollama too old to report capabilities only tells us here: retry once as a plain chat.
      if (!specs.length || signal.aborted || !/does not support tools/i.test(errorMessage(err))) throw err;
      host.toolSupport.set(`${ol.baseURL}|${model}`, false);
      host.emit({ type: 'error', kind: 'notice', message: noToolsNotice(model) });
      return chat([]);
    }
  }
  let emitted = false;
  const onEmit = () => (emitted = true);
  const endpoint = `${client.baseURL}|${model}`;
  for (;;) {
    const includeUsage = !host.noStreamUsage.has(endpoint);
    try {
      return await completeStreaming(host, client, model, history, specs, signal, turn, includeUsage, onEmit);
    } catch (err) {
      if (signal.aborted || emitted || isContextLengthError(err)) throw err;
      // A gateway or provider that rejects stream_options still streams without it.
      if (includeUsage && /stream_options|include_usage/i.test(errorMessage(err))) {
        host.noStreamUsage.add(endpoint);
        continue;
      }
      // Some gateways/models reject streaming with tools; fall back to a single request
      // as long as nothing has been shown to the user yet.
      console.warn('[agent] streaming failed, retrying without streaming:', errorMessage(err));
      return completeOnce(host, client, model, history, specs, signal, turn);
    }
  }
}

async function completeStreaming(
  host: CompletionHost,
  client: OpenAI,
  model: string,
  history: Msg[],
  specs: ToolSpec[],
  signal: AbortSignal,
  turn: number,
  includeUsage: boolean,
  onEmit: () => void,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const stream = await client.chat.completions.create(
    { model, messages: history, tools: specs, stream: true, stream_options: includeUsage ? { include_usage: true } : undefined, ...(host.maxOutput() ? { max_tokens: host.maxOutput() } : {}) },
    { signal },
  );
  let text = '';
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const byIndex = new Map<number, ToolCall>();
  let usage: Usage | null = null;

  for await (const chunk of stream) {
    // With include_usage the counts arrive on a final chunk whose choices array is empty.
    if (chunk.usage) usage = mergeUsage(usage, chunk.usage);
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    const reasoning = (delta as { reasoning_content?: string; reasoning?: string }).reasoning_content ?? (delta as { reasoning?: string }).reasoning;
    if (reasoning) host.emit({ type: 'thinking_delta', text: reasoning });
    if (delta.content) {
      text += delta.content;
      onEmit();
      host.emit({ type: 'text_delta', text: delta.content });
    }
    for (const tc of delta.tool_calls ?? []) {
      let call: ToolCall;
      const known = tc.id ? byId.get(tc.id) : undefined;
      if (known) call = known;
      else if (tc.id) {
        call = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
        calls.push(call);
        byId.set(tc.id, call);
        byIndex.set(tc.index ?? calls.length - 1, call);
      } else {
        const existing = byIndex.get(tc.index ?? 0) ?? calls[calls.length - 1];
        if (existing) call = existing;
        else {
          call = { id: '', type: 'function', function: { name: '', arguments: '' } };
          calls.push(call);
          byIndex.set(tc.index ?? 0, call);
        }
      }
      if (tc.function?.name) call.function.name += tc.function.name;
      const args = tc.function?.arguments as unknown;
      if (typeof args === 'string') call.function.arguments += args;
      else if (args && typeof args === 'object') call.function.arguments += JSON.stringify(args);
    }
  }
  calls.forEach((c, i) => {
    if (!c.id) c.id = `call_${turn}_${i}`;
  });
  if (usage) host.reportUsage(usage);
  return { text, toolCalls: calls };
}

async function completeOnce(
  host: CompletionHost,
  client: OpenAI,
  model: string,
  history: Msg[],
  specs: ToolSpec[],
  signal: AbortSignal,
  turn: number,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const res = await client.chat.completions.create({ model, messages: history, tools: specs, stream: false, ...(host.maxOutput() ? { max_tokens: host.maxOutput() } : {}) }, { signal });
  if (res.usage) host.reportUsage(mergeUsage(null, res.usage));
  const msg = res.choices?.[0]?.message;
  const text = msg?.content ?? '';
  if (text) host.emit({ type: 'text_delta', text });
  const toolCalls: ToolCall[] = [];
  (msg?.tool_calls ?? []).forEach((tc, i) => {
    if (tc.type !== 'function') return;
    const args = tc.function.arguments as unknown;
    toolCalls.push({
      id: tc.id || `call_${turn}_${i}`,
      type: 'function',
      function: { name: tc.function.name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
    });
  });
  return { text, toolCalls };
}
