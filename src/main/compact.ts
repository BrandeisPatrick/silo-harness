// Context compaction: estimates how full the context window is, prunes old tool output (no model call), and folds
// the older part of the conversation into a handoff brief while the recent tail stays word for word (Claude Code's
// /compact and auto-compact) so a session can go on past the model's context size.
// Everything here is pure: the agent decides when to run it and writes the result through the session store.

import type { AppConfig, PlanInfo, TaskItem } from '../shared/types';
import type { Msg } from './sessions';

/** First line of the user message that stands in for the folded conversation; the transcript hides it. */
export const COMPACT_MARK = '[Context compacted]';
/** Default fraction of the window at which a run compacts on its own (config.compactThreshold overrides it) */
export const COMPACT_THRESHOLD = 0.8;
/** Fraction of the window above which old tool output is pruned before anything else */
export const PRUNE_THRESHOLD = 0.6;
/** Fraction of the window the verbatim tail of a compaction aims for */
export const TAIL_FRACTION = 0.2;
const TOOL_RESULT_CHARS = 1500;
const ARGS_CHARS = 600;
/** The marker line pruning leaves in a shortened tool result (also how an already-pruned one is recognised) */
const PRUNE_MARK = /\[… \d+ characters cleared to save context\. Run the tool again if you need them\.\]/;
const IMAGE_PLACEHOLDER = '[An earlier image was removed to save context.]';
const FILES_HEADING = '## Files touched';

/** config.compactThreshold, kept inside 0.5 to 0.95 (default 0.8). */
export function compactThreshold(cfg: Pick<AppConfig, 'compactThreshold'> | undefined): number {
  const t = Number(cfg?.compactThreshold);
  if (!Number.isFinite(t) || t <= 0) return COMPACT_THRESHOLD;
  return Math.min(0.95, Math.max(0.5, t));
}

export function isCompactPreamble(m: Msg | undefined): boolean {
  return !!m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(COMPACT_MARK);
}

function textOf(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  let text = '';
  let images = 0;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && 'text' in part) text += String((part as { text: string }).text) + '\n';
      else if (part && typeof part === 'object' && 'image_url' in part) images++;
    }
  }
  return { text, images };
}

/** Rough size of a message: about four characters per token, plus a flat cost per image. */
export function estimateMessageTokens(m: Msg): number {
  const { text, images } = textOf((m as { content?: unknown }).content);
  let chars = text.length + 8;
  if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) chars += tc.type === 'function' ? tc.function.name.length + tc.function.arguments.length + 16 : 16;
  return Math.ceil(chars / 4) + images * 1000;
}

export function estimateTokens(messages: Msg[]): number {
  let n = 0;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

/** Tool specs count against the window on every call. */
export function estimateSpecTokens(specs: unknown[]): number {
  if (!specs.length) return 0;
  try {
    return Math.ceil(JSON.stringify(specs).length / 4);
  } catch {
    return 0;
  }
}

/** Tokens the summariser may write: a brief that stays small next to a small window. */
export function summaryMaxTokens(limit: number): number {
  return Math.max(600, Math.min(2000, Math.round(limit * 0.15)));
}

/** Characters of transcript that fit a summary request inside the window (its framing, the task list and the reply aside). */
export function summaryBudgetChars(limit: number): number {
  return Math.max(4000, Math.floor((limit - summaryMaxTokens(limit) - 900) * 3));
}

// ---------- Where the conversation can be cut ----------

/** A user message the app wrote itself (screenshot carrier, empty-reply nudge, compaction brief), not one the user sent. */
export function isSyntheticUser(m: Msg): boolean {
  if (m.role !== 'user') return false;
  if (isCompactPreamble(m)) return true;
  const t = textOf(m.content).text;
  return t.startsWith('[Screenshot returned by') || t.startsWith('You returned an empty response.') || t.startsWith(HOOK_NOTE_PREFIX);
}

/** A user-role message a hook added (context, a Stop hook's reason to keep going): sent to the model, not shown as a turn. */
export const HOOK_NOTE_PREFIX = '[Hook ';

/** A tool result that reports a failure: the call did not do what was asked (the window shows the row as failed). */
export const FAILED_RESULT = /^(Error:|User denied|Not permitted|Tool call was interrupted|[A-Za-z]+(?::\S+)? hook (?:error|denied))/;

/** Index of the last message the user sent (-1 when there is none). Nothing from there on is pruned or summarised. */
export function lastUserIndex(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user' && !isSyntheticUser(messages[i])) return i;
  return -1;
}

/**
 * For each index, whether the conversation may be cut right before it: never between an assistant message with tool
 * calls and the last of its results (results may be interleaved with screenshot messages), so the kept part never
 * starts with a result whose call was folded away. `ok[0]` and `ok[length]` are true.
 */
export function cutPoints(messages: Msg[]): boolean[] {
  const ok = new Array<boolean>(messages.length + 1).fill(true);
  const callAt = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) callAt.set(tc.id, i);
  });
  messages.forEach((m, i) => {
    if (m.role !== 'tool') return;
    const at = callAt.get(m.tool_call_id);
    // A result without its call can only travel with what comes before it.
    const from = at === undefined ? 0 : at;
    for (let c = from + 1; c <= i; c++) ok[c] = false;
  });
  return ok;
}

/**
 * Where to cut for a compaction: messages[cut..] are kept verbatim. Walks back from the end until the kept messages
 * take about `tailTokens`, keeps at least the last user message and everything after it, and moves the cut back to a
 * clean boundary. Returns 0 when nothing before the tail can be folded. With `insideTurn` (the last turn alone is
 * too big) the cut may fall after the last user message, but never at the very end.
 */
export function findCut(messages: Msg[], tailTokens: number, opts: { insideTurn?: boolean } = {}): number {
  const cut = rawCut(messages, tailTokens, opts);
  // Folding nothing but an earlier brief would only rewrite it.
  return cut > 0 && messages.slice(0, cut).every(isCompactPreamble) ? 0 : cut;
}

function rawCut(messages: Msg[], tailTokens: number, opts: { insideTurn?: boolean }): number {
  const n = messages.length;
  if (n < 2) return 0;
  const ok = cutPoints(messages);
  let cut = n;
  let acc = 0;
  while (cut > 0 && acc < tailTokens) acc += estimateMessageTokens(messages[--cut]);
  const lastUser = lastUserIndex(messages);
  if (!opts.insideTurn && lastUser >= 0) cut = Math.min(cut, lastUser);
  // Something is always kept, also when the request itself lives in an earlier brief (no user message is left).
  cut = Math.min(cut, n - 1);
  while (cut > 0 && !ok[cut]) cut--;
  if (cut > 0) return cut;
  if (!opts.insideTurn && lastUser > 0) return lastUser; // the tail rule took everything: fold what precedes the last request
  if (opts.insideTurn) {
    // Keep as little as a clean boundary allows: the last message, or the last call with its results.
    for (let c = n - 1; c > 0; c--) if (ok[c]) return c;
  }
  return 0;
}

// ---------- Pruning ----------

export interface PruneOptions {
  /** Tool results this recent (counted from the end) are left alone */
  keepRecent: number;
  /** Results at most this long are left alone */
  minChars: number;
  head: number;
  tail: number;
  /** Images this recent (counted from the end) are left alone */
  keepImages: number;
  /** Leave the last user message and everything after it alone */
  protectTail: boolean;
}

export const PRUNE_NORMAL: PruneOptions = { keepRecent: 6, minChars: 2000, head: 1200, tail: 500, keepImages: 2, protectTail: true };
/** The fallback when no summary could be produced: everything but the last two results, down to 400 characters */
export const PRUNE_HARD: PruneOptions = { keepRecent: 2, minChars: 400, head: 280, tail: 120, keepImages: 1, protectTail: false };

export interface PruneResult {
  messages: Msg[];
  /** Tool results shortened */
  results: number;
  /** Images replaced by a placeholder */
  images: number;
  /** Estimated tokens saved */
  saved: number;
}

function shorten(text: string, o: PruneOptions): string {
  // A result pruned before keeps its marker; prune it again only when the hard limits apply and it is still long.
  const cleared = text.length - o.head - o.tail;
  return `${text.slice(0, o.head)}\n[… ${cleared} characters cleared to save context. Run the tool again if you need them.]\n${text.slice(text.length - o.tail)}`;
}

/** Old tool output and old images shortened. Unchanged messages keep their identity; `messages` is a new array. */
export function pruneMessages(messages: Msg[], o: PruneOptions = PRUNE_NORMAL): PruneResult {
  const out = [...messages];
  const lu = lastUserIndex(messages);
  const stop = o.protectTail && lu >= 0 ? lu : messages.length;
  let results = 0;
  let images = 0;
  let saved = 0;
  let seenResults = 0;
  let seenImages = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool') {
      seenResults++;
      if (i >= stop || seenResults <= o.keepRecent) continue;
      const text = textOf(m.content).text;
      if (text.length <= o.minChars) continue;
      if (PRUNE_MARK.test(text) && text.length <= o.head + o.tail + 120) continue;
      const short = shorten(text, o);
      if (short.length >= text.length) continue;
      out[i] = { ...m, content: short };
      results++;
      saved += estimateMessageTokens(m) - estimateMessageTokens(out[i]);
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      const parts = m.content;
      const count = parts.filter((p) => p && typeof p === 'object' && 'image_url' in p).length;
      if (!count) continue;
      if (i >= stop) {
        seenImages += count;
        continue;
      }
      let changed = false;
      const next = [...parts].reverse().map((p) => {
        if (!(p && typeof p === 'object' && 'image_url' in p)) return p;
        seenImages++;
        if (seenImages <= o.keepImages) return p;
        changed = true;
        images++;
        return { type: 'text' as const, text: IMAGE_PLACEHOLDER };
      }).reverse();
      if (!changed) continue;
      out[i] = { ...m, content: next } as Msg;
      saved += estimateMessageTokens(m) - estimateMessageTokens(out[i]);
    }
  }
  return { messages: out, results, images, saved };
}

// ---------- The summary request ----------

const SUMMARY_SYSTEM = `You compact the older part of a coding-agent session into a handoff brief, so the agent can continue the work in a fresh context. The most recent messages are kept word for word after your brief, so concentrate on what came before them.

Write Markdown with exactly these eight sections, in this order. Every section is always present; write "(none)" when it has nothing.

## 1. Request and intent
What the user asked for, in their own words where the wording matters, with every constraint and preference they stated.

## 2. Key facts and concepts
Technologies, decisions and conventions that were established.

## 3. Files and code
Each file read or changed: its path, why it matters, and the snippets or signatures that will be needed again, verbatim.

## 4. Errors and fixes
What went wrong and how it was resolved, including every correction the user made.

## 5. Messages from the user
Every user message, briefly, in order.

## 6. Pending work
What was asked for and is not done yet.

## 7. Current work
Exactly what was being done when this brief was written.

## 8. Next step
The single next action, only if it follows from the most recent request; quote the request it comes from. Otherwise "(none)".

Rules:
- Facts, not narration. Never invent anything that is not in the transcript.
- Keep exact paths, commands, error messages, numbers and names.
- If the transcript starts with an EARLIER SUMMARY, merge it into your sections; do not copy it as a block.
- No text outside the eight sections: no greeting, no preamble, no closing remark.`;

function clipMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n[… ${s.length - max} characters of the middle of the transcript omitted …]\n\n${s.slice(s.length - tail)}`;
}

function clipEnd(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)} …[${s.length - max} more characters]`;
}

/** The brief inside a compaction preamble, without the app's framing or its Files touched list. */
export function briefOf(m: Msg): string {
  const body = (m.content as string).split('\n').slice(2).join('\n');
  return stripFilesSection(body).trim();
}

function stripFilesSection(s: string): string {
  const at = s.indexOf(`\n${FILES_HEADING}`);
  return at >= 0 ? s.slice(0, at) : s.startsWith(FILES_HEADING) ? '' : s;
}

/** The conversation as plain text for the summariser (tool results and arguments shortened). */
export function renderForSummary(messages: Msg[], budgetChars: number): string {
  const names = new Map<string, string>();
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (isCompactPreamble(m)) {
        lines.push(`EARLIER SUMMARY:\n${briefOf(m)}`);
        continue;
      }
      const { text, images } = textOf(m.content);
      lines.push(`USER: ${text.trim()}${images ? ` [${images} image${images === 1 ? '' : 's'} attached]` : ''}`);
    } else if (m.role === 'assistant') {
      const { text } = textOf(m.content);
      if (text.trim()) lines.push(`ASSISTANT: ${text.trim()}`);
      for (const tc of m.tool_calls ?? []) {
        if (tc.type !== 'function') continue;
        names.set(tc.id, tc.function.name);
        lines.push(`ASSISTANT CALLS ${tc.function.name}(${clipEnd(tc.function.arguments, ARGS_CHARS)})`);
      }
    } else if (m.role === 'tool') {
      const { text } = textOf(m.content);
      lines.push(`RESULT OF ${names.get(m.tool_call_id) ?? 'tool'}: ${clipEnd(text.trim(), TOOL_RESULT_CHARS)}`);
    }
  }
  return clipMiddle(lines.join('\n\n'), budgetChars);
}

/** What the summariser is told besides the transcript. */
export interface SummaryExtras {
  /** What the user asked the brief to keep in detail (/compact focus) */
  focus?: string;
  /** Upper bound for the brief's length; it has to be much smaller than what it replaces */
  maxWords?: number;
  tasks?: TaskItem[];
  plan?: Pick<PlanInfo, 'title' | 'status'>;
}

function tasksText(tasks: TaskItem[] | undefined): string {
  if (!tasks?.length) return '(none)';
  return tasks.map((t) => `- [${t.status}] ${t.title}`).join('\n');
}

/** The messages of a summary request. */
export function summaryRequest(messages: Msg[], extras: SummaryExtras | string | undefined, budgetChars: number): Msg[] {
  const x: SummaryExtras = typeof extras === 'string' ? { focus: extras } : extras ?? {};
  const transcript = renderForSummary(messages, budgetChars);
  const state = `Current task list:\n${tasksText(x.tasks)}\n\nLatest plan: ${x.plan ? `"${x.plan.title}" (${x.plan.status})` : '(none)'}`;
  const focus = x.focus?.trim() ? `\n\nThe user asked the brief to focus on: ${x.focus.trim()}` : '';
  const words = x.maxWords && x.maxWords > 0 ? `\n- Keep the whole brief under ${Math.max(80, Math.round(x.maxWords))} words: quote only the lines that matter, never whole files or outputs.` : '';
  return [
    { role: 'system', content: SUMMARY_SYSTEM + words },
    { role: 'user', content: `Transcript:\n\n${transcript}\n\n---\n${state}\n\n---\nWrite the handoff brief now, with the eight sections.${focus}` },
  ];
}

/** Cleans a model reply into the brief: no reasoning blocks, fences, preamble lines or a Files touched list of its own. */
export function cleanSummary(raw: string): string {
  let t = String(raw ?? '')
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^(?:here is|here's|below is)[^\n]*\n+/i, '').trim();
  return stripFilesSection(t).trim();
}

// ---------- Files touched ----------

const READ_TOOLS = new Set(['read_file']);
const EDIT_TOOLS = new Set(['write_file', 'edit_file']);

/** Paths the agent read or edited in `messages` (from its tool calls), plus those an earlier brief listed. */
export function filesTouched(messages: Msg[]): { read: string[]; edited: string[] } {
  const read = new Set<string>();
  const edited = new Set<string>();
  for (const m of messages) {
    if (isCompactPreamble(m)) {
      const body = m.content as string;
      const at = body.indexOf(FILES_HEADING);
      if (at < 0) continue;
      for (const line of body.slice(at + FILES_HEADING.length).split('\n')) {
        const hit = /^- (read|edited): (.+)$/.exec(line.trim());
        if (hit) (hit[1] === 'read' ? read : edited).add(hit[2]);
      }
      continue;
    }
    if (m.role !== 'assistant') continue;
    for (const tc of m.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      const name = tc.function.name;
      if (!READ_TOOLS.has(name) && !EDIT_TOOLS.has(name)) continue;
      let p: unknown;
      try {
        p = (JSON.parse(tc.function.arguments || '{}') as { path?: unknown }).path;
      } catch {
        continue;
      }
      if (typeof p !== 'string' || !p.trim()) continue;
      (EDIT_TOOLS.has(name) ? edited : read).add(p.trim());
    }
  }
  for (const p of edited) read.delete(p);
  return { read: [...read], edited: [...edited] };
}

/** The user message that replaces the folded conversation; `files` is appended by the app, not written by the model. */
export function compactedPreamble(summary: string, files?: { read: string[]; edited: string[] }, request?: string): string {
  let out = `${COMPACT_MARK}
This session was compacted: the earlier conversation was replaced by the brief below, and the messages after this one are kept as they were. Continue from it as if nothing was interrupted. Do not mention the compaction and do not redo work the brief marks as done. If a task was in progress, carry on with its next step; if the user's latest request was already complete, answer their next message.

${summary.trim()}`;
  if (request?.trim()) out += `\n\n${REQUEST_HEADING}\n${request.trim()}`;
  const lines = [...(files?.edited ?? []).map((p) => `- edited: ${p}`), ...(files?.read ?? []).map((p) => `- read: ${p}`)];
  if (lines.length) out += `\n\n${FILES_HEADING}\nFiles read or changed in the folded part (re-read one only when you need its exact contents again):\n${lines.slice(0, 40).join('\n')}`;
  return out;
}

const REQUEST_HEADING = "## The user's latest request, verbatim";

/** The verbatim request an earlier brief carried (when the turn it came from was folded), if any. */
export function carriedRequest(m: Msg | undefined): string | undefined {
  if (!m || !isCompactPreamble(m)) return undefined;
  const body = m.content as string;
  const at = body.indexOf(REQUEST_HEADING);
  if (at < 0) return undefined;
  const rest = body.slice(at + REQUEST_HEADING.length).replace(/^\n/, '');
  const end = rest.indexOf(`\n\n${FILES_HEADING}`);
  return (end >= 0 ? rest.slice(0, end) : rest).trim() || undefined;
}

/** The one-line note that stands in for messages dropped because no summary could be produced. */
export function droppedPreamble(count: number, files?: { read: string[]; edited: string[] }, request?: string): string {
  return compactedPreamble(`${count} earlier message${count === 1 ? ' was' : 's were'} dropped because a summary could not be produced.`, files, request);
}

// ---------- Context-length errors ----------

/** True for a provider's "the request does not fit the context window" error (and HTTP 413). */
export function isContextLengthError(err: unknown): boolean {
  const status = Number((err as { status?: unknown })?.status);
  if (status === 413) return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /context[ _-]?length|maximum context|context window|too many tokens|prompt is too long|exceeds the context|HTTP 413|\b413\b.*(?:too large|entity)/i.test(msg);
}

/** "38k" / "900" */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  return `${v < 10_000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(v / 1000)}k`;
}

/** Whole numbers proportional to `values` that add up to exactly `target` (largest remainders get the rounding). */
export function scaleTo(values: number[], target: number): number[] {
  const t = Math.max(0, Math.round(target));
  const sum = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (!values.length) return [];
  if (sum <= 0) return values.map((_, i) => (i === 0 ? t : 0));
  const exact = values.map((v) => (Math.max(0, v) * t) / sum);
  const out = exact.map(Math.floor);
  let left = t - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  return out;
}
