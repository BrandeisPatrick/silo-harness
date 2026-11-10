// Export of one session: a readable Markdown transcript, the stored session object (JSON), or the raw log (JSONL).

import type { Msg, Session } from '../sessions';
import { displayText, pairToolResults, type StoredToolCall } from '../sessions';
import { isCompactPreamble } from '../compact';
import { LOAD_TOOLS } from '../tools/groups';

export type ExportFormat = 'markdown' | 'json' | 'jsonl';

/** Tool results longer than this are cut in the Markdown transcript (the JSON and the log keep them whole). */
const RESULT_CHARS = 4000;
const ARGS_CHARS = 2000;

/** A fence that does not occur in the text, so a result containing ``` cannot break out of its block. */
function fence(text: string, lang = ''): string {
  let ticks = '```';
  while (text.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

function imageCount(content: unknown): number {
  return Array.isArray(content) ? content.filter((p) => p && typeof p === 'object' && 'image_url' in p).length : 0;
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function messagesMarkdown(s: Session, messages: Msg[], out: string[]): void {
  const results = new Map<StoredToolCall, string>();
  for (const [call, m] of pairToolResults(messages)) results.set(call, typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  for (const m of messages) {
    if (m.role === 'user') {
      if (isCompactPreamble(m)) continue;
      const text = displayText(m.content).trim();
      const images = imageCount(m.content);
      if (!text && !images) continue;
      const parts = [text, ...Array.from({ length: images }, () => '[image]')].filter(Boolean);
      out.push(`## User\n\n${parts.join('\n\n')}\n`);
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content.trim() : '';
      if (text) out.push(`## Assistant\n\n${text}\n`);
      for (const call of m.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        const name = call.function.name;
        if (name === LOAD_TOOLS) continue; // internal, as in the transcript
        if (name === 'submit_plan') {
          let args: { title?: string; markdown?: string } = {};
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            /* shown as a plain tool call below */
          }
          if (typeof args.markdown === 'string' && args.markdown.trim()) {
            const stored = Object.values(s.plans ?? {}).find((p) => p.markdown === args.markdown!.trim());
            const status = stored ? ` (${stored.status})` : '';
            out.push(`### Plan: ${args.title?.trim() || 'Plan'}${status}\n\n${args.markdown.trim()}\n`);
            continue;
          }
        }
        const result = results.get(call) ?? '(no result)';
        out.push(`### Tool: ${name}\n\n${fence(cut(prettyArgs(call.function.arguments), ARGS_CHARS), 'json')}\n\nResult:\n\n${fence(cut(result, RESULT_CHARS))}\n`);
      }
    }
  }
}

/** A readable transcript: header, then the folded messages and a divider for each compaction, then the live messages. */
export function sessionMarkdown(s: Session, info: { model?: string } = {}): string {
  const out: string[] = [`# ${s.title || 'Session'}\n`];
  const head = [`- Date: ${new Date(s.createdAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`];
  if (s.cwd) head.push(`- Folder: ${s.cwd}`);
  if (info.model) head.push(`- Model: ${info.model}`);
  head.push(`- Session: ${s.id}`);
  out.push(head.join('\n') + '\n');
  for (const c of s.compactions ?? []) {
    messagesMarkdown(s, c.folded ?? [], out);
    out.push(`---\n\n**Context compacted** (${c.reason}, ${c.messages} messages folded)\n\n${c.summary.trim()}\n\n---\n`);
  }
  messagesMarkdown(s, s.messages, out);
  return out.join('\n');
}
