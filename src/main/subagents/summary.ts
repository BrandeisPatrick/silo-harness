// The merge summary: what a sub-session or fork did, written by the model outside any run (like titles.ts), from a
// bounded plain-text rendering of the messages. Kept apart from compact.ts on purpose: a compaction brief is for the
// same agent to carry on, this one is a report for another session that only needs the outcome.

import type { AppConfig } from '../../shared/types';
import { contextSize, ollamaComplete } from '../ollama';
import { isOllama, makeClient, ollamaOf } from '../providers';
import type { Msg } from '../sessions';

/** Characters of transcript the summariser sees at most; the middle goes first, since the brief and the outcome sit at the ends. */
export const SUMMARY_INPUT_CHARS = 24_000;
const RESULT_CHARS = 1200;
const ARGS_CHARS = 400;
const TIMEOUT_MS = 120_000;

const SYSTEM = `You write the merge report of a coding-agent session that worked on part of a job for another session. The other session reads only your report, so it must stand on its own. Write Markdown with exactly these short sections:

## Asked
What the session was asked to do, in a sentence or two.

## Done
What it did, briefly, in order.

## Result
What it found, answered or changed. Keep numbers, names, paths, commands and short code or error text verbatim when they matter.

## Files touched
The paths it created or changed, or "None".

## Open
Anything unfinished, unverified, failing or waiting on someone, or "Nothing".

Facts only, no narration, nothing that is not in the transcript. Do not address anyone and add nothing outside these sections.`;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: string }).text) : part && typeof part === 'object' && 'image_url' in part ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function clipEnd(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)} …[${s.length - max} more characters]`;
}

function clipMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.35);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n[… ${s.length - max} characters omitted …]\n\n${s.slice(s.length - tail)}`;
}

/** Messages as plain text, tool arguments and results cut short. `resultChars` bounds each tool result. */
export function renderMessages(messages: Msg[], resultChars = RESULT_CHARS, argsChars = ARGS_CHARS): string {
  const names = new Map<string, string>();
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const text = textOf(m.content).trim();
      if (text) out.push(`USER: ${text}`);
    } else if (m.role === 'assistant') {
      const text = textOf(m.content).trim();
      if (text) out.push(`ASSISTANT: ${text}`);
      for (const tc of m.tool_calls ?? []) {
        if (tc.type !== 'function') continue;
        names.set(tc.id, tc.function.name);
        out.push(`ASSISTANT CALLS ${tc.function.name}(${clipEnd(tc.function.arguments, argsChars)})`);
      }
    } else if (m.role === 'tool') {
      out.push(`RESULT OF ${names.get(m.tool_call_id) ?? 'tool'}: ${clipEnd(textOf(m.content).trim(), resultChars)}`);
    }
  }
  return out.join('\n\n');
}

/** The request for one merge report. */
export function mergeRequest(title: string, kind: 'sub-session' | 'fork', messages: Msg[]): Msg[] {
  const transcript = clipMiddle(renderMessages(messages), SUMMARY_INPUT_CHARS);
  const what = kind === 'fork' ? `This is what the fork "${title}" did after it split off from the other session.` : `This is the whole conversation of the sub-session "${title}".`;
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${what}\n\nTranscript:\n\n${transcript}\n\n---\nWrite the merge report now.` },
  ];
}

/** Cleans a reply into the report: no reasoning blocks, fences or "Here is…" line. */
export function cleanReport(raw: string): string {
  let t = String(raw ?? '')
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(t);
  if (fence) t = fence[1].trim();
  return t.replace(/^(?:here is|here's|below is)[^\n]*\n+/i, '').trim();
}

/** Asks the configured model for the report. Throws when the call fails or the reply is empty. */
export async function writeMergeReport(cfg: AppConfig, title: string, kind: 'sub-session' | 'fork', messages: Msg[]): Promise<string> {
  const request = mergeRequest(title, kind, messages);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let raw: string;
  if (isOllama(cfg)) {
    const ol = ollamaOf(cfg);
    if (!ol.model) throw new Error('No Ollama model selected.');
    raw = await ollamaComplete({
      baseURL: ol.baseURL,
      model: ol.model,
      messages: request,
      think: false,
      // The agent's own num_ctx, so Ollama does not reload the model for this call
      options: { num_ctx: contextSize(ol.numCtx), num_predict: 1200, temperature: 0.2 },
      signal,
    });
  } else {
    const { client, model } = makeClient(cfg);
    const res = await client.chat.completions.create({ model, messages: request, max_tokens: 1200, stream: false }, { signal, maxRetries: 1 });
    raw = res.choices?.[0]?.message?.content ?? '';
  }
  const report = cleanReport(raw);
  if (!report) throw new Error('The model returned an empty summary.');
  return report;
}
