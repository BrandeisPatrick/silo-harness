import type { AppConfig } from '../shared/types';
import { clip, displayText, type Msg, type Session } from './sessions';
import { contextSize, ollamaComplete, type Usage } from './ollama';
import { usageOf, type RawUsage } from './agent/complete';
import { isOllama, makeClient, ollamaOf } from './providers';
import { isCompactPreamble } from './compact';

const SYSTEM = 'You name chat sessions. Reply with only a title of at most six words. No quotes, no trailing period.';
const MAX_INPUT = 1200;
const MAX_TITLE = 60;
const TIMEOUT_MS = 60_000;

/** Opening quote → closing quote; a reply wrapped in one of these pairs is unwrapped. */
const PAIRS: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '«': '»', '「': '」', '*': '*' };
const TRAILING_PUNCT = /[\s.,;:!?…。，；：！？、\-–—]+$/;

/** The user turn of a title request (first user message plus first assistant text), or null before the first exchange. */
export function titlePrompt(session: Session): string | null {
  const msgs = session.compactions?.[0]?.folded ?? session.messages;
  const user = msgs.find((m) => m.role === 'user' && !isCompactPreamble(m));
  if (!user || !msgs.some((m) => m.role === 'assistant')) return null;
  const question = displayText(user.content).trim();
  if (!question) return null;
  const reply = msgs.find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  const answer = typeof reply?.content === 'string' ? reply.content.trim() : '';
  return `${clip(question, MAX_INPUT)}\n\nAssistant reply:\n${clip(answer, MAX_INPUT)}`;
}

/** Cleans a model reply into a title: no reasoning, labels, quotes, markdown or trailing punctuation; at most 60 characters. */
export function sanitizeTitle(raw: string): string {
  let t = String(raw ?? '')
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, ' ') // reasoning, closed or cut off by the token limit
    .replace(/\*\*|`/g, '')
    .trim()
    .replace(/^[^\n:]{0,40}\btitle\s*[:：]\s*/i, ''); // "Title: …", "Here is a title: …"
  t = t.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  t = t.replace(/^(?:#{1,6}\s+|>\s*|[-*+•]\s+|\d+[.)]\s+)+/, '').replace(/\s+/g, ' ').trim();
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(TRAILING_PUNCT, '');
    const close = PAIRS[t[0]];
    if (close && t.length > 1 && t.endsWith(close)) t = t.slice(1, -1).trim();
    t = t.replace(/^["'“”‘’«»「」]+/, '').replace(/["“”«»「」]+$/, '').trim();
  }
  if (Array.from(t).length > MAX_TITLE) {
    const cut = clip(t, MAX_TITLE);
    const space = cut.lastIndexOf(' ');
    t = (space >= MAX_TITLE / 2 ? cut.slice(0, space) : cut).replace(TRAILING_PUNCT, '');
  }
  return t;
}

/** Asks the configured model for a short session title. Resolves to '' when the reply holds nothing usable. `onUsage` gets the call's tokens. */
export async function generateTitle(cfg: AppConfig, prompt: string, onUsage?: (u: Usage) => void): Promise<string> {
  const messages: Msg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: prompt },
  ];
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let raw: string;
  if (isOllama(cfg)) {
    const ol = ollamaOf(cfg);
    if (!ol.model) return '';
    raw = await ollamaComplete({
      baseURL: ol.baseURL,
      model: ol.model,
      messages,
      think: false,
      // num_ctx matches the agent's own requests: a different value would make Ollama reload the model now and again on the next message.
      options: { num_ctx: contextSize(ol.numCtx), num_predict: 32, temperature: 0.2 },
      signal,
      onUsage,
    });
  } else {
    const { client, model } = makeClient(cfg);
    const res = await client.chat.completions.create({ model, messages, max_tokens: 32, stream: false }, { signal, maxRetries: 0 });
    if (res.usage) onUsage?.(usageOf(res.usage as RawUsage));
    raw = res.choices?.[0]?.message?.content ?? '';
  }
  return sanitizeTitle(raw);
}
