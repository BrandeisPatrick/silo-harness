import type OpenAI from 'openai';
import { pairToolResults, type Msg } from './sessions';

export type ToolSpec = OpenAI.Chat.Completions.ChatCompletionTool;
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: { id?: string; type?: 'function'; function: { name: string; arguments: Record<string, unknown> } }[];
  tool_call_id?: string;
  tool_name?: string;
}

interface OllamaChunk {
  message?: { role?: string; content?: string; thinking?: string; tool_calls?: { id?: string; function: { name: string; arguments: unknown } }[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Token counts of one model call: prompt = whole input incl. history, completion = generated tokens. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** Native API root for a configured base URL, which may be the OpenAI-compatible .../v1 endpoint. */
export function ollamaRoot(baseURL: string): string {
  return (baseURL || 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** num_ctx sent with every request. Keep it identical across calls: a different value makes Ollama reload the model. */
export function contextSize(numCtx: unknown): number {
  return Math.max(2048, Number(numCtx) || 16384);
}

async function httpError(res: Response): Promise<Error> {
  const detail = (await res.text().catch(() => '')).slice(0, 300);
  return new Error(`Ollama returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { _raw: raw };
    }
  }
  return {};
}

/** Converts OpenAI-style history (what the app stores) into Ollama's native message shape. */
export function toOllamaMessages(messages: Msg[]): OllamaMessage[] {
  // Each result names the tool of the call it answers (the nearest call before it with that id: ids can repeat)
  const toolNames = new Map<Msg, string>();
  for (const [call, result] of pairToolResults(messages)) if (call.type === 'function') toolNames.set(result, call.function.name);
  const out: OllamaMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      out.push({ role: 'system', content: typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join('\n') });
    } else if (m.role === 'user') {
      if (typeof m.content === 'string') out.push({ role: 'user', content: m.content });
      else {
        const texts: string[] = [];
        const images: string[] = [];
        for (const part of m.content) {
          if (part.type === 'text') texts.push(part.text);
          else if (part.type === 'image_url') images.push(part.image_url.url.replace(/^data:[^;]+;base64,/, ''));
        }
        out.push({ role: 'user', content: texts.join('\n'), ...(images.length ? { images } : {}) });
      }
    } else if (m.role === 'assistant') {
      const msg: OllamaMessage = { role: 'assistant', content: typeof m.content === 'string' ? m.content : '' };
      const calls = (m.tool_calls ?? []).filter((tc) => tc.type === 'function');
      if (calls.length) {
        msg.tool_calls = calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.type === 'function' ? tc.function.name : '', arguments: parseArgs(tc.type === 'function' ? tc.function.arguments : '') },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join('\n'),
        tool_call_id: m.tool_call_id,
        tool_name: toolNames.get(m),
      });
    }
  }
  return out;
}

export interface OllamaChatOptions {
  baseURL: string;
  model: string;
  numCtx: number;
  think: 'auto' | 'on' | 'off';
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
  turn: number;
  onText: (text: string) => void;
  onThinking?: (text: string) => void;
  onWarning?: (message: string) => void;
  /** Called once, with the counts from the final chunk (missing counts are 0). */
  onUsage?: (usage: Usage) => void;
  /** Most tokens to generate (options.num_predict); unlimited when absent */
  numPredict?: number;
}

/**
 * Streams a chat completion from Ollama's native /api/chat endpoint. Unlike the
 * OpenAI-compatible endpoint it honours options.num_ctx, so long agent prompts
 * are not silently truncated at the server's default context size.
 */
export async function ollamaChat(o: OllamaChatOptions): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const root = ollamaRoot(o.baseURL);
  const body: Record<string, unknown> = {
    model: o.model,
    messages: toOllamaMessages(o.messages),
    stream: true,
    options: o.numPredict ? { num_ctx: o.numCtx, num_predict: o.numPredict } : { num_ctx: o.numCtx },
  };
  // Models without tool support (vision-only ones, say) reject any tools field; leave it out when there are none.
  if (o.tools.length) body.tools = o.tools;
  if (o.think !== 'auto') body.think = o.think === 'on';

  const res = await fetch(`${root}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: o.signal,
  });
  if (!res.ok || !res.body) throw await httpError(res);

  let text = '';
  const toolCalls: ToolCall[] = [];
  let usageReported = false;
  const handle = (line: string) => {
    const chunk = JSON.parse(line) as OllamaChunk;
    if (chunk.error) throw new Error(chunk.error);
    const m = chunk.message;
    if (m?.thinking) o.onThinking?.(m.thinking);
    if (m?.content) {
      text += m.content;
      o.onText(m.content);
    }
    for (const tc of m?.tool_calls ?? []) {
      toolCalls.push({
        id: tc.id || `call_${o.turn}_${toolCalls.length}`,
        type: 'function',
        function: { name: tc.function.name, arguments: JSON.stringify(parseArgs(tc.function.arguments)) },
      });
    }
    if (chunk.done) {
      if (!usageReported) {
        usageReported = true;
        o.onUsage?.({ promptTokens: chunk.prompt_eval_count ?? 0, completionTokens: chunk.eval_count ?? 0 });
      }
      if (chunk.done_reason === 'length') o.onWarning?.('The model hit its output limit; the reply may be cut off.');
      if (chunk.prompt_eval_count && chunk.prompt_eval_count >= o.numCtx - 64) {
        o.onWarning?.(`The prompt filled the ${o.numCtx}-token context window; older messages were likely dropped. Start a new chat or raise the Ollama context size in Settings.`);
      }
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(line);
    }
  }
  if (buf.trim()) handle(buf.trim());
  return { text, toolCalls };
}

/** One short, non-streaming reply from /api/chat with no tools (used to generate session titles). */
export async function ollamaComplete(o: {
  baseURL: string;
  model: string;
  messages: Msg[];
  think?: boolean;
  options: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<string> {
  const body: Record<string, unknown> = { model: o.model, messages: toOllamaMessages(o.messages), stream: false, options: o.options };
  if (o.think !== undefined) body.think = o.think;
  const res = await fetch(`${ollamaRoot(o.baseURL)}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: o.signal,
  });
  if (!res.ok) throw await httpError(res);
  const data = (await res.json()) as OllamaChunk;
  if (data.error) throw new Error(data.error);
  return data.message?.content ?? '';
}
