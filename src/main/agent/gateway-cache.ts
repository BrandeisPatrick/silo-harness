// Prompt caching on the OpenAI-shaped path. Claude through a gateway caches only where the request marks it, and each
// gateway takes the marks its own way; OpenAI caches on its own and routes by a key. What each one gets:
//   - OpenRouter: Anthropic's automatic mark at the top level (it follows the newest block, tool results included, so a
//     tool loop stays in the cached prefix), an hour's mark on the system prompt, and session_id for sticky routing.
//   - Portkey: marks on the last content part of the system prompt and of the newest message, and on the last tool.
//   - Vercel's AI Gateway: message-level marks on the system prompt and the newest message.
//   - Any other OpenAI-compatible gateway with a Claude model (LiteLLM and the like): the content-part marks.
//   - OpenAI: prompt_cache_key, the session id. Nothing to any other endpoint: some reject fields they do not know.
// A gateway that refuses a request with these fields gets it again without them (complete.ts), and is not sent them
// again while the app runs: the harness never fails because of a mark.

import type { Msg } from '../sessions';
import type { ToolSpec } from '../ollama';

export type CacheShape = 'openrouter' | 'sticky' | 'portkey' | 'vercel' | 'parts' | 'openai';

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** Endpoints on this machine (Ollama, LM Studio, a local server) have no prompt cache to steer. */
const LOCAL_TYPES = new Set(['ollama', 'lmstudio']);

/** How a provider's requests ask for caching, or null when they should carry nothing extra. */
export function cacheShape(r: { type: string; baseURL: string }, model: string): CacheShape | null {
  const host = hostOf(r.baseURL);
  if (r.type === 'openai' || host === 'api.openai.com') return 'openai';
  // OpenRouter: the marks for Claude; for any model the session id, which keeps it on the provider that has its cache
  if (r.type === 'openrouter' || host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return /claude/i.test(model) ? 'openrouter' : 'sticky';
  if (!/claude/i.test(model) || LOCAL_TYPES.has(r.type)) return null;
  if (r.type === 'portkey' && (host === 'portkey.ai' || host.endsWith('.portkey.ai'))) return 'portkey';
  if (host === 'ai-gateway.vercel.sh') return 'vercel';
  // The built-in Gateway block on a host of its own, or an OpenAI-compatible entry: LiteLLM and the like
  if (r.type === 'portkey' || r.type === 'openai-compatible') return 'parts';
  return null;
}

type Mark = { type: 'ephemeral'; ttl?: '1h' };
const FIVE: Mark = { type: 'ephemeral' };
const HOUR: Mark = { type: 'ephemeral', ttl: '1h' };

/** The message with a mark on the last part of its content (a string becomes one text part). */
function markLastPart(m: Msg, mark: Mark): Msg {
  const c = (m as { content?: unknown }).content;
  if (typeof c === 'string') return { ...m, content: [{ type: 'text', text: c, cache_control: mark }] } as unknown as Msg;
  if (Array.isArray(c) && c.length) return { ...m, content: [...c.slice(0, -1), { ...c[c.length - 1], cache_control: mark }] } as unknown as Msg;
  return m;
}

/** The fields a request gets for caching, for `shape`: what replaces its messages and tools, and what is added. */
export function cacheFields(shape: CacheShape, messages: Msg[], tools: ToolSpec[], sessionId: string): { messages: Msg[]; tools: ToolSpec[]; extra: Record<string, unknown> } {
  if (shape === 'openai') return { messages, tools, extra: sessionId ? { prompt_cache_key: sessionId } : {} };
  if (shape === 'sticky') return { messages, tools, extra: sessionId ? { session_id: sessionId.slice(0, 256) } : {} };
  const out = [...messages];
  const sys = out.findIndex((m) => m.role === 'system');
  const last = out.length - 1;
  if (shape === 'openrouter') {
    if (sys >= 0) out[sys] = markLastPart(out[sys], HOUR);
    return { messages: out, tools, extra: { cache_control: FIVE, ...(sessionId ? { session_id: sessionId.slice(0, 256) } : {}) } };
  }
  if (shape === 'vercel') {
    if (sys >= 0) out[sys] = { ...out[sys], cache_control: FIVE } as unknown as Msg;
    if (last >= 0 && last !== sys) out[last] = { ...out[last], cache_control: FIVE } as unknown as Msg;
    return { messages: out, tools, extra: {} };
  }
  if (sys >= 0) out[sys] = markLastPart(out[sys], FIVE);
  if (last >= 0 && last !== sys) out[last] = markLastPart(out[last], FIVE);
  const marked = shape === 'portkey' && tools.length ? [...tools.slice(0, -1), { ...tools[tools.length - 1], cache_control: FIVE } as unknown as ToolSpec] : tools;
  return { messages: out, tools: marked, extra: {} };
}

/** The routing key of Auto mode's check (OpenAI's prompt_cache_key, OpenRouter's session_id): its instructions are the same in every session. */
export const CHECK_CACHE_KEY = 'silo-harness-safety-check';

/** The message with its text split at `ends` (character offsets), a mark after each piece but the last: the same text. */
function markAt(m: Msg, ends: number[], mark: Mark): Msg {
  const text = String((m as { content?: unknown }).content ?? '');
  const cuts = ends.filter((e) => e > 0 && e < text.length);
  if (!cuts.length) return m;
  const parts: { type: 'text'; text: string; cache_control?: Mark }[] = [];
  let from = 0;
  for (const e of cuts) {
    parts.push({ type: 'text', text: text.slice(from, e), cache_control: mark });
    from = e;
  }
  parts.push({ type: 'text', text: text.slice(from) });
  return { ...m, content: parts } as unknown as Msg;
}

/**
 * The fields Auto mode's check (classifier.ts) gets for caching on this path, for `shape` (cacheShape, the same
 * conditions as the agent's own requests). Only the part that is the same from check to check is marked: the system
 * prompt (the check's instructions, when `markSystem`) and the user message up to each of `stableEnds` (the user's
 * notes and instruction files, then their earlier answers), as text parts split there, the way the native path sends
 * them. Never the newest message: it changes on every check, so a mark there would write it all to the cache each
 * time. OpenAI and OpenRouter's other models get the routing key instead. The model reads the same text either way.
 */
export function checkCacheFields(shape: CacheShape, messages: Msg[], stableEnds: number[], markSystem = true): { messages: Msg[]; extra: Record<string, unknown> } {
  if (shape === 'openai') return { messages, extra: { prompt_cache_key: CHECK_CACHE_KEY } };
  if (shape === 'sticky') return { messages, extra: { session_id: CHECK_CACHE_KEY } };
  const out = [...messages];
  const sys = out.findIndex((m) => m.role === 'system');
  const user = out.findIndex((m) => m.role === 'user');
  if (shape === 'vercel') {
    // Marks on whole messages only: the instructions
    if (sys >= 0 && markSystem) out[sys] = { ...out[sys], cache_control: FIVE } as unknown as Msg;
    return { messages: out, extra: {} };
  }
  // OpenRouter, Portkey and the other gateways with a Claude model: marks on content parts
  if (sys >= 0 && markSystem) out[sys] = markLastPart(out[sys], FIVE);
  if (user >= 0 && stableEnds.length) out[user] = markAt(out[user], stableEnds, FIVE);
  return { messages: out, extra: {} };
}

/** Base URLs that refused a request with these fields, for the life of the process: they get none again. */
export const refusedCacheFields = new Set<string>();

/** A refusal that may be the cache fields' doing (a request the gateway does not accept as it is). */
export function isFieldRefusal(err: unknown): boolean {
  const status = Number((err as { status?: unknown })?.status);
  return status === 400 || status === 422;
}
