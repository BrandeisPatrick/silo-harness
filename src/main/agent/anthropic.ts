// The native Anthropic Messages API, for a provider that is Anthropic itself (type 'anthropic', or a base URL on
// api.anthropic.com). Its OpenAI-compatible endpoint never caches; this one does, so the agent's model calls come here
// with cache marks on the stable layers (tools, system) and on the conversation. The stored history stays in the
// OpenAI shape (Msg) and is converted at this boundary, the same way for every request, so the bytes of a request's
// prefix are the bytes of the one before.

import Anthropic from '@anthropic-ai/sdk';
import type { AgentEvent } from '../../shared/types';
import type { ToolCall, ToolSpec, Usage } from '../ollama';
import type { Msg } from '../sessions';

type Block = Anthropic.ContentBlockParam;
type MessageParam = Anthropic.MessageParam;

/** The stable layers (tools, system) are kept an hour: a desktop user often pauses longer than five minutes. */
export const STABLE_TTL = '1h' as const;
/** The conversation's marks keep the default five minutes (a write costs 1.25x there, 2x for an hour). */
export const TAIL_TTL = '5m' as const;
/**
 * A breakpoint looks back at most 20 positions for an earlier cache entry: a mark on a fixed grid of positions keeps
 * an entry within reach when one step of a tool loop appends many blocks.
 */
export const GRID_POSITIONS = 12;

/**
 * Thinking blocks of an assistant reply, kept on the stored message under this key and replayed only on this path
 * (the OpenAI-shaped and Ollama paths never send it): the API wants them back unchanged with the tool results.
 */
export const THINKING_KEY = 'anthropic_thinking';
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string };

/** The thinking blocks stored on a message, if any. */
export function thinkingOf(m: Msg): ThinkingBlock[] | undefined {
  const t = (m as unknown as Record<string, unknown>)[THINKING_KEY];
  return Array.isArray(t) && t.length ? (t as ThinkingBlock[]) : undefined;
}

/** The messages without the thinking blocks of this path, for any other provider (some reject unknown fields). */
export function withoutNative(history: Msg[]): Msg[] {
  if (!history.some((m) => thinkingOf(m))) return history;
  return history.map((m) => {
    if (!thinkingOf(m)) return m;
    const { [THINKING_KEY]: _t, ...rest } = m as unknown as Record<string, unknown>;
    return rest as unknown as Msg;
  });
}

// ---------- Which provider, which model ----------

/** True for Anthropic's own API: the provider type, or a base URL on api.anthropic.com (the live rig's gateway). */
export function isNativeAnthropic(r: { type: string; baseURL: string }): boolean {
  if (r.type === 'anthropic') return true;
  try {
    return new URL(r.baseURL).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

/**
 * The thinking setting for a model: off where the model lets it be turned off (the agent has never asked for it),
 * else the model's adaptive thinking with readable summaries. Undefined: send nothing (the older models think only
 * when asked).
 */
export function thinkingFor(model: string): Anthropic.ThinkingConfigParam | undefined {
  const m = model.toLowerCase();
  // Claude 3 and 4 (up to 4.8): no thinking unless asked for
  if (/claude-(?:opus|sonnet|haiku)-[34](?:-|$)|claude-[34]-/.test(m)) return undefined;
  // Accept "disabled": Haiku 5.5, Opus 5 and Sonnet 5 (at the default effort)
  if (/claude-haiku-5-5|claude-opus-5(?!-\d)|claude-sonnet-5(?!-\d)/.test(m)) return { type: 'disabled' };
  // Sonnet 5.5 turns it off its own way
  if (/claude-sonnet-5-5/.test(m)) return { type: 'between_tools' };
  // Opus 5.5, Fable, Mythos and what comes next: always on
  return { type: 'adaptive', display: 'summarized' };
}

/** max_tokens is required here: the provider's maxOutput, else what the model family can write. */
export function defaultMaxTokens(model: string): number {
  const m = model.toLowerCase();
  if (/claude-3-(?:5|7)-|claude-3-[57]/.test(m)) return 8192;
  if (/claude-3-/.test(m)) return 4096;
  return 32_000;
}

// ---------- Converting the history ----------

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

function imageBlock(url: string): Block | null {
  const d = DATA_URL.exec(url);
  if (d) {
    const media = d[1].toLowerCase();
    if (!/^image\/(?:png|jpe?g|gif|webp)$/.test(media)) return null;
    return { type: 'image', source: { type: 'base64', media_type: (media === 'image/jpg' ? 'image/jpeg' : media) as 'image/png', data: d[2] } };
  }
  if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
  return null;
}

/** A message's content as blocks: text parts (empty ones left out) and images. */
function contentBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const p of content as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) out.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url') {
      const url = (p.image_url as { url?: unknown } | undefined)?.url;
      const img = typeof url === 'string' ? imageBlock(url) : null;
      out.push(img ?? { type: 'text', text: '[An image that could not be sent]' });
    }
  }
  return out;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    // What the model sent stays visible to it, though it was not JSON
    return { _raw: raw };
  }
}

/** Placeholders for turns the API would refuse empty. */
const EMPTY_USER = '(empty message)';
const EMPTY_ASSISTANT = '(no reply)';
const EMPTY_RESULT = '(no output)';

/**
 * The OpenAI-shaped history as a Messages request: system messages become the system blocks; assistant tool calls
 * become tool_use blocks (after the reply's thinking, when kept); tool results become tool_result blocks in the user
 * turn that follows, merged with any user text after them (the results first, as the API wants); consecutive messages
 * of one role are one turn. `stripThinkingBefore`: leave out the thinking of messages before that index (a history
 * the API no longer accepts them for). Pure and deterministic.
 */
export function toAnthropic(history: Msg[], stripThinkingBefore = 0): { system: Anthropic.TextBlockParam[]; messages: MessageParam[] } {
  const system: Anthropic.TextBlockParam[] = [];
  const messages: MessageParam[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) (last.content as Block[]).push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  history.forEach((m, i) => {
    if (m.role === 'system' || m.role === 'developer') {
      const text = typeof m.content === 'string' ? m.content : contentBlocks(m.content).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      if (text.trim()) system.push({ type: 'text', text });
    } else if (m.role === 'user') {
      push('user', contentBlocks(m.content));
    } else if (m.role === 'assistant') {
      const blocks: Block[] = [];
      const thinking = i >= stripThinkingBefore ? thinkingOf(m) : undefined;
      if (thinking) blocks.push(...(thinking as Block[]));
      blocks.push(...contentBlocks(m.content));
      for (const tc of m.tool_calls ?? []) {
        if (tc.type !== 'function') continue;
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      }
      if (!blocks.some((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')) blocks.push({ type: 'text', text: EMPTY_ASSISTANT });
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : contentBlocks(m.content).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text.trim() ? text : EMPTY_RESULT }]);
    }
  });
  for (const msg of messages) {
    const blocks = msg.content as Block[];
    if (msg.role === 'user') {
      // Tool results first, then what the user (or the app) added after them, each group in its order
      const firstOther = blocks.findIndex((b) => b.type !== 'tool_result');
      let lastResult = -1;
      blocks.forEach((b, k) => {
        if (b.type === 'tool_result') lastResult = k;
      });
      if (firstOther >= 0 && lastResult > firstOther) msg.content = [...blocks.filter((b) => b.type === 'tool_result'), ...blocks.filter((b) => b.type !== 'tool_result')];
      if (!blocks.length) msg.content = [{ type: 'text', text: EMPTY_USER }];
    }
  }
  // The conversation starts with the user
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continued)' }] });
  return { system, messages };
}

/** OpenAI-shaped tool specs as Anthropic tools. */
export function toolsOf(specs: ToolSpec[]): Anthropic.Tool[] {
  const out: Anthropic.Tool[] = [];
  for (const s of specs) {
    if (s.type !== 'function') continue;
    const params = (s.function.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema;
    out.push({ name: s.function.name, ...(s.function.description ? { description: s.function.description } : {}), input_schema: { ...params, type: 'object' } });
  }
  return out;
}

// ---------- Cache marks ----------

/** One block of the request that can carry a mark, and its position for the lookback (runs of calls or results count once). */
interface Slot {
  block: Block;
  position: number;
}

function slots(messages: MessageParam[]): Slot[] {
  const out: Slot[] = [];
  let position = 0;
  let prev = '';
  for (const msg of messages) {
    for (const b of msg.content as Block[]) {
      const run = b.type === 'tool_use' || b.type === 'tool_result' ? b.type : '';
      if (!(run && run === prev)) position++;
      prev = run;
      if (b.type === 'thinking' || b.type === 'redacted_thinking') continue; // a mark there is refused
      out.push({ block: b, position });
    }
    prev = '';
  }
  return out;
}

const mark = (b: object, ttl: '1h' | '5m') => {
  (b as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = ttl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl };
};

/**
 * Puts the cache marks on a request, in place (at most four, longer TTLs first in the prefix): the last tool and the
 * end of the system prompt (an hour), the newest message's last block, and the last block on the grid of positions
 * before it (five minutes), so a long tool loop always has an entry within a breakpoint's lookback.
 */
export function addCacheMarks(req: { tools?: Anthropic.Tool[]; system?: Anthropic.TextBlockParam[]; messages: MessageParam[] }): void {
  const lastTool = req.tools?.[req.tools.length - 1];
  if (lastTool) mark(lastTool, STABLE_TTL);
  const lastSystem = req.system?.[req.system.length - 1];
  if (lastSystem) mark(lastSystem, STABLE_TTL);
  const all = slots(req.messages);
  const tail = all[all.length - 1];
  if (!tail) return;
  mark(tail.block, TAIL_TTL);
  const grid = Math.floor((tail.position - 1) / GRID_POSITIONS) * GRID_POSITIONS;
  if (grid <= 0) return;
  let at: Slot | undefined;
  for (const s of all) if (s.position <= grid) at = s;
  if (at && at.block !== tail.block) mark(at.block, TAIL_TTL);
}

// ---------- The call ----------

/** What the agent lends this call (the same as complete.ts's CompletionHost, the part this path needs). */
export interface NativeHost {
  emit(ev: AgentEvent): void;
  reportUsage(usage: Usage): void;
  maxOutput(): number | undefined;
  /** Per session: thinking before this index of the history is no longer sent (the API refused it once) */
  thinking?: { stripBefore: number };
}

export interface NativeReply {
  text: string;
  toolCalls: ToolCall[];
  /** The reply's thinking blocks, for the stored message (THINKING_KEY) */
  thinking?: ThinkingBlock[];
}

/** Usage of a Messages response in our terms: the prompt is the whole input, cached tokens included. */
export function nativeUsage(u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): Usage {
  const read = Number(u.cache_read_input_tokens) || 0;
  const write = Number(u.cache_creation_input_tokens) || 0;
  return { promptTokens: (Number(u.input_tokens) || 0) + read + write, completionTokens: Number(u.output_tokens) || 0, cacheReadTokens: read, cacheWriteTokens: write };
}

/** The request for a history and tool specs, marks included. */
export function nativeRequest(model: string, history: Msg[], specs: ToolSpec[], maxTokens: number, stripThinkingBefore = 0): Anthropic.MessageCreateParamsStreaming {
  const { system, messages } = toAnthropic(history, stripThinkingBefore);
  const tools = toolsOf(specs);
  addCacheMarks({ tools, system, messages });
  const req: Anthropic.MessageCreateParamsStreaming = { model, max_tokens: maxTokens, messages, stream: true };
  if (system.length) req.system = system;
  if (tools.length) req.tools = tools;
  const thinking = thinkingFor(model);
  if (thinking) req.thinking = thinking;
  return req;
}

/** An error in the terms the loop and providerErrorMessage already read (status, a plain message). */
export function nativeError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
  if (err instanceof Anthropic.APIConnectionError) {
    const e = new Error(err.message || 'Connection error.');
    return Object.assign(e, { name: err instanceof Anthropic.APIConnectionTimeoutError ? 'APIConnectionTimeoutError' : 'APIConnectionError', cause: (err as { cause?: unknown }).cause });
  }
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { type?: string; message?: string } } | undefined;
    const detail = body?.error?.message || err.message;
    // "overloaded_error", "rate_limit_error", …: the status says the same, the message is what the user reads
    return Object.assign(new Error(detail), { status: err.status, error: { message: detail, type: body?.error?.type } });
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** A 400 about replayed thinking (the history before it changed): sent again without that thinking, once. */
function isThinkingRefusal(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 400 && /thinking|signature|bound to a different conversation/i.test(String(e.message));
}

/**
 * One streamed model call. Emits text_delta and thinking_delta as they come and reports the usage; returns the reply
 * in the shape the OpenAI path returns, with its thinking blocks.
 */
export async function completeAnthropic(host: NativeHost, client: Anthropic, model: string, history: Msg[], specs: ToolSpec[], signal: AbortSignal, turn: number): Promise<NativeReply> {
  const maxTokens = host.maxOutput() ?? defaultMaxTokens(model);
  const attempt = (strip: number) => stream(host, client, nativeRequest(model, history, specs, maxTokens, strip), signal, turn);
  const strip = host.thinking?.stripBefore ?? 0;
  try {
    return await attempt(strip);
  } catch (raw) {
    const err = nativeError(raw);
    if (signal.aborted || !isThinkingRefusal(err) || !history.slice(strip).some((m) => thinkingOf(m))) throw err;
    // Thinking blocks are bound to the history they were made in; a pruned or folded history refuses them
    if (host.thinking) host.thinking.stripBefore = history.length;
    try {
      return await attempt(history.length);
    } catch (again) {
      throw nativeError(again);
    }
  }
}

async function stream(host: NativeHost, client: Anthropic, req: Anthropic.MessageCreateParamsStreaming, signal: AbortSignal, turn: number): Promise<NativeReply> {
  const events = await client.messages.create(req, { signal });
  let text = '';
  const calls: ToolCall[] = [];
  const thinking: ThinkingBlock[] = [];
  /** The block being streamed at each index */
  const open = new Map<number, { kind: 'text' } | { kind: 'tool'; call: ToolCall } | { kind: 'thinking'; block: ThinkingBlock }>();
  let usage: Usage | null = null;
  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start':
        usage = nativeUsage(ev.message.usage);
        break;
      case 'content_block_start': {
        const b = ev.content_block;
        if (b.type === 'text') {
          open.set(ev.index, { kind: 'text' });
          if (b.text) {
            text += b.text;
            host.emit({ type: 'text_delta', text: b.text });
          }
        } else if (b.type === 'tool_use') {
          const call: ToolCall = { id: b.id || `call_${turn}_${calls.length}`, type: 'function', function: { name: b.name, arguments: '' } };
          calls.push(call);
          open.set(ev.index, { kind: 'tool', call });
        } else if (b.type === 'thinking') {
          const block: ThinkingBlock = { type: 'thinking', thinking: b.thinking ?? '', signature: b.signature ?? '' };
          thinking.push(block);
          open.set(ev.index, { kind: 'thinking', block });
        } else if (b.type === 'redacted_thinking') {
          thinking.push({ type: 'redacted_thinking', data: b.data });
        }
        break;
      }
      case 'content_block_delta': {
        const at = open.get(ev.index);
        const d = ev.delta;
        if (d.type === 'text_delta') {
          text += d.text;
          host.emit({ type: 'text_delta', text: d.text });
        } else if (d.type === 'input_json_delta' && at?.kind === 'tool') at.call.function.arguments += d.partial_json;
        else if (d.type === 'thinking_delta' && at?.kind === 'thinking' && at.block.type === 'thinking') {
          at.block.thinking += d.thinking;
          if (d.thinking) host.emit({ type: 'thinking_delta', text: d.thinking });
        } else if (d.type === 'signature_delta' && at?.kind === 'thinking' && at.block.type === 'thinking') at.block.signature += d.signature;
        break;
      }
      case 'content_block_stop':
        open.delete(ev.index);
        break;
      case 'message_delta':
        if (usage && ev.usage) {
          usage.completionTokens = Number(ev.usage.output_tokens) || usage.completionTokens;
          // Some gateways send the input counts only here
          if (ev.usage.input_tokens != null || ev.usage.cache_read_input_tokens != null) {
            const late = nativeUsage({ ...ev.usage });
            if (late.promptTokens > usage.promptTokens) Object.assign(usage, { promptTokens: late.promptTokens, cacheReadTokens: late.cacheReadTokens, cacheWriteTokens: late.cacheWriteTokens });
          }
        }
        break;
      default:
        break;
    }
  }
  // A tool call without arguments streams none
  for (const c of calls) if (!c.function.arguments) c.function.arguments = '{}';
  if (usage) host.reportUsage(usage);
  return thinking.length ? { text, toolCalls: calls, thinking } : { text, toolCalls: calls };
}

/** The client for a resolved provider: its key as the API key, its base URL without /v1, its headers (no gateway's own). */
export function anthropicClient(r: { baseURL: string; apiKey: string; bearer: string; headers: Record<string, string> }): Anthropic {
  const baseURL = r.baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
  let onAnthropic = false;
  try {
    onAnthropic = new URL(baseURL).hostname === 'api.anthropic.com';
  } catch {
    /* a base URL the SDK will report on */
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) if (!(onAnthropic && /^x-portkey-/i.test(k))) headers[k] = v;
  const key = r.apiKey || (r.bearer && r.bearer !== 'none' ? r.bearer : '');
  // authToken null: an ANTHROPIC_AUTH_TOKEN in the environment must not ride along with the provider's own key
  return new Anthropic({ apiKey: key || null, authToken: null, baseURL, defaultHeaders: headers });
}
