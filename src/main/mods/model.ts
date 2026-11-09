// harness.model.complete: one streamed reply from the configured model, with no tools, for a mod with the `model`
// permission. Both providers work the way agent.ts calls them: Ollama through its native /api/chat (so num_ctx is
// honoured), Portkey (and any OpenAI-compatible gateway) through the OpenAI client.

import type { AppConfig } from '../../shared/types';
import type { ModelRequest } from '../../shared/mods';
import { contextLimit } from '../context-window';
import { estimateTokens, renderForSummary } from '../compact';
import { contextSize, ollamaChat } from '../ollama';
import { isOllama, makeClient, ollamaOf } from '../providers';
import type { Msg } from '../sessions';

export const MODEL_MAX_TOKENS = 4000;
export const MODEL_DEFAULT_TOKENS = 1000;
export const MODEL_MAX_IN_FLIGHT = 2;
const MODEL_TIMEOUT_MS = 180_000;
const MAX_INPUT_CHARS = 400_000;
const DEFAULT_SYSTEM = 'You are a helpful assistant answering a request from a panel (a mod) inside Silo Harness, a coding app. Answer directly and concisely.';

export class ModelCallError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

/** Validated request: what the bridge passes on after checking the params. */
export interface ModelCall {
  messages: { role: 'user' | 'assistant'; content: string }[];
  system?: string;
  maxTokens: number;
  context: 'none' | 'session';
  requestId: string;
}

/** Checks ModelRequest params; returns a message naming the field, or the normalised call. */
export function checkModelRequest(p: unknown, makeId: () => string): ModelCall | string {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'params: must be an object { messages, system?, maxTokens?, context? }';
  const r = p as ModelRequest;
  if (!Array.isArray(r.messages) || !r.messages.length) return 'messages: must be a non-empty list of { role, content }';
  let chars = 0;
  for (let i = 0; i < r.messages.length; i++) {
    const m = r.messages[i] as unknown as Record<string, unknown>;
    if (!m || typeof m !== 'object') return `messages[${i}]: must be { role, content }`;
    if (m.role !== 'user' && m.role !== 'assistant') return `messages[${i}].role: must be "user" or "assistant"`;
    if (typeof m.content !== 'string') return `messages[${i}].content: must be a string`;
    chars += m.content.length;
  }
  if (r.system !== undefined && typeof r.system !== 'string') return 'system: must be a string';
  chars += r.system?.length ?? 0;
  if (chars > MAX_INPUT_CHARS) return `messages: ${chars} characters is more than the ${MAX_INPUT_CHARS} a mod may send`;
  if (r.maxTokens !== undefined && (typeof r.maxTokens !== 'number' || !Number.isFinite(r.maxTokens) || r.maxTokens < 1)) return 'maxTokens: must be a positive number';
  if (r.context !== undefined && r.context !== 'none' && r.context !== 'session') return 'context: must be "none" or "session"';
  if (r.requestId !== undefined && (typeof r.requestId !== 'string' || !r.requestId || r.requestId.length > 100)) return 'requestId: must be a string of up to 100 characters';
  return {
    messages: r.messages.map((m) => ({ role: m.role, content: m.content })),
    system: r.system,
    maxTokens: Math.min(MODEL_MAX_TOKENS, Math.floor(r.maxTokens ?? MODEL_DEFAULT_TOKENS)),
    context: r.context ?? 'none',
    requestId: r.requestId ?? makeId(),
  };
}

/** The request's chat messages: the system prompt (with the session as context when asked for), then the mod's messages. */
export function buildMessages(cfg: AppConfig, call: ModelCall, sessionMessages: Msg[] | null): Msg[] {
  let system = call.system?.trim() || DEFAULT_SYSTEM;
  if (call.context === 'session' && sessionMessages?.length) {
    const own: Msg[] = [{ role: 'system', content: system }, ...call.messages];
    // What is left of the window once the mod's own messages and the reply are accounted for, at ~3.2 chars a token.
    const room = contextLimit(cfg) - estimateTokens(own) - call.maxTokens - 600;
    const budget = Math.max(2000, Math.floor(room * 3.2));
    const transcript = renderForSummary(sessionMessages, budget);
    if (transcript.trim()) {
      system += `\n\nThe conversation the user has open in Silo Harness, for context (read-only; you are not taking part in it):\n\n<conversation>\n${transcript}\n</conversation>`;
    }
  }
  return [{ role: 'system', content: system }, ...call.messages];
}

/** Streams one reply. Resolves with what arrived (also when `signal` aborts after some text). */
export async function completeOnce(
  cfg: AppConfig,
  messages: Msg[],
  maxTokens: number,
  signal: AbortSignal,
  onDelta: (text: string) => void,
): Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number }; stopped?: boolean }> {
  const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  const both = AbortSignal.any([signal, timeout]);
  let text = '';
  const delta = (t: string) => {
    text += t;
    onDelta(t);
  };
  try {
    if (isOllama(cfg)) {
      const ol = ollamaOf(cfg);
      if (!ol.model) throw new ModelCallError('No Ollama model is selected in Settings.', 4004);
      let usage: { promptTokens: number; completionTokens: number } | undefined;
      await ollamaChat({
        baseURL: ol.baseURL,
        model: ol.model,
        // The same num_ctx as the agent's requests, so Ollama does not reload the model for a mod's call.
        numCtx: contextSize(ol.numCtx),
        think: ol.think ?? 'auto',
        messages,
        tools: [],
        signal: both,
        turn: 0,
        numPredict: maxTokens,
        onText: delta,
        onUsage: (u) => (usage = u),
      });
      return signal.aborted ? { text, stopped: true } : { text, usage };
    }
    let made: ReturnType<typeof makeClient>;
    try {
      made = makeClient(cfg);
    } catch (err) {
      // No key or no model chosen: nothing to call yet, which is not the provider failing.
      throw new ModelCallError(err instanceof Error ? err.message : String(err), 4004);
    }
    const { client, model } = made;
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    const run = async (includeUsage: boolean) => {
      const stream = await client.chat.completions.create(
        { model, messages, max_tokens: maxTokens, stream: true, stream_options: includeUsage ? { include_usage: true } : undefined },
        { signal: both, maxRetries: 1 },
      );
      for await (const chunk of stream) {
        if (chunk.usage) usage = { promptTokens: Number(chunk.usage.prompt_tokens) || 0, completionTokens: Number(chunk.usage.completion_tokens) || 0 };
        const c = chunk.choices?.[0]?.delta?.content;
        if (c) delta(c);
      }
    };
    try {
      await run(true);
    } catch (err) {
      // A gateway that rejects stream_options still streams without it (as in agent.ts).
      if (both.aborted || text || !/stream_options|include_usage/i.test(String((err as Error)?.message))) throw err;
      await run(false);
    }
    return signal.aborted ? { text, stopped: true } : { text, usage };
  } catch (err) {
    if (signal.aborted) return { text, stopped: true };
    if (timeout.aborted) throw new ModelCallError(`The model did not finish within ${MODEL_TIMEOUT_MS / 1000} s.`, 4008);
    if (err instanceof ModelCallError) throw err;
    throw new ModelCallError(err instanceof Error ? err.message : String(err), 4000);
  }
}
