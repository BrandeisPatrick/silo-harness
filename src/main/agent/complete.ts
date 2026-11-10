// One model call: streamed through the OpenAI client (or Ollama's native chat), the fallbacks when a gateway rejects
// stream_options or streaming with tools, and the plain-chat retry for an Ollama model that takes no tools.

import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { AgentEvent, AppConfig } from '../../shared/types';
import { isContextLengthError } from '../compact';
import { contextSize, ollamaChat, type ToolCall, type ToolSpec, type Usage } from '../ollama';
import { ollamaOf, resolveProvider } from '../providers';
import type { Msg } from '../sessions';
import { completeAnthropic, withoutNative, type ThinkingBlock } from './anthropic';
import { cacheFields, cacheShape, isFieldRefusal, refusedCacheFields, type CacheShape } from './gateway-cache';
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
  /** The native Anthropic path's memory for this session (agent/anthropic.ts NativeHost.thinking) */
  thinking?: { stripBefore: number };
  /** The session's id: the key a provider's prompt cache is steered by (agent/gateway-cache.ts) */
  cacheKey?: string;
}

/** What a request adds for the provider's prompt cache (gateway-cache.ts), or nothing. */
type Decorate = (messages: Msg[], tools: ToolSpec[]) => { messages: Msg[]; tools: ToolSpec[]; extra: Record<string, unknown> };
const plain: Decorate = (messages, tools) => ({ messages, tools, extra: {} });

/** A model's reply: its text, its tool calls, and (native Anthropic path) its thinking blocks to keep with it. */
export interface Reply {
  text: string;
  toolCalls: ToolCall[];
  thinking?: ThinkingBlock[];
}

export function noToolsNotice(model: string): string {
  return `${model} doesn't support tools, so it can't read files, run commands or browse.`;
}

/** An OpenAI-shaped usage object as providers and gateways send it, with every spelling of the cache counts. */
export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenAI, OpenRouter, LiteLLM, Portkey (cache_write_tokens: OpenRouter, OpenAI on newer models) */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  /** Anthropic's spellings, which LiteLLM and Portkey pass through */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** A count when the provider sent one (0 included), else undefined. */
function count(...values: unknown[]): number | undefined {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return undefined;
}

/**
 * One usage object in our terms. The prompt stays the whole input; a gateway that reports only the uncached part as
 * prompt_tokens (fewer than it read and wrote) gets the cached tokens added back.
 */
export function usageOf(u: RawUsage): Usage {
  const read = count(u.prompt_tokens_details?.cached_tokens, u.cache_read_input_tokens);
  const write = count(u.prompt_tokens_details?.cache_write_tokens, u.cache_creation_input_tokens);
  let prompt = Number(u.prompt_tokens) || 0;
  if ((read ?? 0) + (write ?? 0) > prompt) prompt += (read ?? 0) + (write ?? 0);
  const out: Usage = { promptTokens: prompt, completionTokens: Number(u.completion_tokens) || 0 };
  if (read !== undefined) out.cacheReadTokens = read;
  if (write !== undefined) out.cacheWriteTokens = write;
  return out;
}

/** Folds one chunk's usage into the running counts (gateways may repeat or split the counts across chunks). */
export function mergeUsage(prev: Usage | null, raw: RawUsage): Usage {
  const u = usageOf(raw);
  const out: Usage = {
    promptTokens: Math.max(prev?.promptTokens ?? 0, u.promptTokens),
    completionTokens: Math.max(prev?.completionTokens ?? 0, u.completionTokens),
  };
  const read = prev?.cacheReadTokens === undefined ? u.cacheReadTokens : Math.max(prev.cacheReadTokens, u.cacheReadTokens ?? 0);
  const write = prev?.cacheWriteTokens === undefined ? u.cacheWriteTokens : Math.max(prev.cacheWriteTokens, u.cacheWriteTokens ?? 0);
  if (read !== undefined) out.cacheReadTokens = read;
  if (write !== undefined) out.cacheWriteTokens = write;
  return out;
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
  native?: Anthropic,
): Promise<Reply> {
  // Anthropic's own API: the Messages path, which caches (agent/anthropic.ts)
  if (native) return completeAnthropic(host, native, model, history, specs, signal, turn);
  // The thinking blocks kept for that path go to no other provider
  history = withoutNative(history);
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
  let shape: CacheShape | null = null;
  try {
    shape = cacheShape(resolveProvider(cfg), model);
  } catch {
    shape = null;
  }
  const noFields = refusedCacheFields;
  const decorate = (): Decorate => (shape && !noFields.has(client.baseURL) ? (m, t) => cacheFields(shape!, m, t, host.cacheKey ?? '') : plain);
  for (;;) {
    const includeUsage = !host.noStreamUsage.has(endpoint);
    const withFields = decorate() !== plain;
    try {
      return await completeStreaming(host, client, model, history, specs, signal, turn, includeUsage, onEmit, decorate());
    } catch (err) {
      if (signal.aborted || emitted || isContextLengthError(err)) throw err;
      // A gateway or provider that rejects stream_options still streams without it.
      if (includeUsage && /stream_options|include_usage/i.test(errorMessage(err))) {
        host.noStreamUsage.add(endpoint);
        continue;
      }
      // A gateway that refuses the cache fields gets the request without them, now and for the rest of the process
      if (withFields && isFieldRefusal(err)) {
        console.warn('[agent] the provider refused the prompt-cache fields; sending without them:', errorMessage(err));
        noFields.add(client.baseURL);
        continue;
      }
      // Some gateways/models reject streaming with tools; fall back to a single request
      // as long as nothing has been shown to the user yet.
      console.warn('[agent] streaming failed, retrying without streaming:', errorMessage(err));
      return completeOnce(host, client, model, history, specs, signal, turn, decorate());
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
  decorate: Decorate = plain,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const d = decorate(history, specs);
  const stream = await client.chat.completions.create(
    { model, messages: d.messages, tools: d.tools, stream: true, stream_options: includeUsage ? { include_usage: true } : undefined, ...(host.maxOutput() ? { max_tokens: host.maxOutput() } : {}), ...d.extra } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    { signal },
  );
  let text = '';
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const byIndex = new Map<number, ToolCall>();
  let usage: Usage | null = null;

  for await (const chunk of stream) {
    // With include_usage the counts arrive on a final chunk whose choices array is empty.
    if (chunk.usage) usage = mergeUsage(usage, chunk.usage as RawUsage);
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
      const fresh = (id: string): ToolCall => {
        const c: ToolCall = { id, type: 'function', function: { name: '', arguments: '' } };
        calls.push(c);
        if (id) byId.set(id, c);
        return c;
      };
      if (typeof tc.index === 'number') {
        // The position decides which call a chunk belongs to (OpenAI sends the id only on a call's first chunk; Ollama
        // can give two calls of one reply the same id). A new id at a known position is a new call (a provider that
        // numbers every call 0).
        const at = byIndex.get(tc.index);
        if (at && (!tc.id || !at.id || at.id === tc.id)) {
          call = at;
          if (tc.id && !at.id) at.id = tc.id;
        } else {
          call = fresh(tc.id ?? '');
          byIndex.set(tc.index, call);
        }
      } else if (tc.id) {
        const known = byId.get(tc.id);
        if (known) call = known;
        else {
          call = fresh(tc.id);
          byIndex.set(calls.length - 1, call);
        }
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
  decorate: Decorate = plain,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const d = decorate(history, specs);
  const res = await client.chat.completions.create({ model, messages: d.messages, tools: d.tools, stream: false, ...(host.maxOutput() ? { max_tokens: host.maxOutput() } : {}), ...d.extra } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { signal });
  if (res.usage) host.reportUsage(usageOf(res.usage as RawUsage));
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

/**
 * Gives every call of a reply an id no other call in the session has, in place: a call whose id is empty, already
 * used by an earlier call or result in `history`, or taken by an earlier call of the same reply gets a fresh one.
 * Models served by Ollama number their calls per reply (and our own fallback ids restart every run), so without this
 * a result could be paired with another run's call. Ids that are already unique (OpenAI's, Anthropic's) are kept.
 */
export function uniqueCallIds(calls: ToolCall[], history: Msg[]): ToolCall[] {
  const used = new Set<string>();
  for (const m of history) {
    if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) used.add(tc.id);
    else if (m.role === 'tool') used.add(m.tool_call_id);
  }
  for (const call of calls) {
    if (!call.id || used.has(call.id)) call.id = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    used.add(call.id);
  }
  return calls;
}
