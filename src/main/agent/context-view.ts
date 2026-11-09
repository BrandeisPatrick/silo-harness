// What the model is sent of the stored conversation: the same messages with cuts that save tokens, while the session
// keeps everything (the transcript, the tool rows, history and export show the whole output as before). Pure and
// deterministic: the same messages give the same request, so a provider's prompt cache keeps working.
//   - A tool result longer than MODEL_RESULT_CHARS keeps its start and its end with a note in between; read_file's is
//     cut after a whole line, with the offset to read on from.
//   - Screenshots the agent took (browser_screenshot's carrier messages), except the KEEP_SCREENSHOTS most recent, are
//     replaced by a line saying so. Images the user attached are always sent.
//   - Results the agent set aside to save context (Session.prunedResults, see pruneForModel) keep only their start
//     and end, as pruning does in a small window.

import type { Msg } from '../sessions';

/** Characters of one tool result the model gets; longer output keeps its start and end (about 8–10K tokens). */
export const MODEL_RESULT_CHARS = 30_000;
/** Screenshots the agent took that are sent in full: the most recent ones */
export const KEEP_SCREENSHOTS = 2;
/** How a result set aside to save context is shortened (as PRUNE_NORMAL in compact.ts) */
const PRUNED_HEAD = 1200;
const PRUNED_TAIL = 500;
/** Results at most this long are never set aside: shortening them saves little */
export const PRUNE_MIN_CHARS = 2000;
/**
 * Tokens a request may reach before old tool output is set aside for the model, whatever the window: without it a
 * large window (200K, 1M) would send every earlier output again with every request until 60% of it is full.
 */
export const PRUNE_BUDGET = 48_000;

const SCREENSHOT_MARK = '[Screenshot returned by';
const OLD_SCREENSHOT = '[An earlier screenshot was left out to save context; take a new one if you need it.]';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('\n');
}

/** A read_file result cut after the last whole line that fits, with where to go on reading. */
function cutRead(text: string, max: number): string {
  const end = text.lastIndexOf('\n', max);
  const kept = text.slice(0, end > 0 ? end : max);
  const lastLine = /(?:^|\n)\s*(\d+)\| [^\n]*$/.exec(kept)?.[1];
  const total = /…\((\d+) lines total; continue with offset=\d+\)\s*$/.exec(text)?.[1];
  const next = lastLine ? Number(lastLine) + 1 : null;
  return `${kept}\n…(cut here to save context${total ? `; the file has ${total} lines` : ''}${next ? `; continue with offset=${next}` : ''})`;
}

/** Any other long output: its start and its end, where errors, summaries and exit codes are. */
function cutMiddle(text: string, max: number): string {
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[${text.length - head - tail} characters of the middle left out to save context; narrow the command or search (grep, head, tail) to see them]…\n${text.slice(text.length - tail)}`;
}

function shortened(text: string): string {
  if (text.length <= PRUNED_HEAD + PRUNED_TAIL + 200) return text;
  return `${text.slice(0, PRUNED_HEAD)}\n[… ${text.length - PRUNED_HEAD - PRUNED_TAIL} characters cleared to save context. Run the tool again if you need them.]\n${text.slice(text.length - PRUNED_TAIL)}`;
}

/** The messages as the model gets them (see the top of this file). Unchanged messages keep their identity. */
export function modelMessages(messages: Msg[], pruned: ReadonlySet<string> = new Set()): Msg[] {
  const names = new Map<string, string>();
  for (const m of messages) if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) if (tc.type === 'function') names.set(tc.id, tc.function.name);
  // The screenshot carriers, newest first: the first KEEP_SCREENSHOTS keep their image
  let shots = 0;
  const keepShot = new Set<number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.content) || !textOf(m.content).startsWith(SCREENSHOT_MARK)) continue;
    if (shots++ < KEEP_SCREENSHOTS) keepShot.add(i);
  }
  return messages.map((m, i) => {
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : textOf(m.content);
      if (pruned.has(m.tool_call_id)) {
        const short = shortened(text);
        return short === text ? m : { ...m, content: short };
      }
      if (text.length <= MODEL_RESULT_CHARS) return m;
      return { ...m, content: names.get(m.tool_call_id) === 'read_file' ? cutRead(text, MODEL_RESULT_CHARS) : cutMiddle(text, MODEL_RESULT_CHARS) };
    }
    if (m.role === 'user' && Array.isArray(m.content) && textOf(m.content).startsWith(SCREENSHOT_MARK) && !keepShot.has(i)) {
      const parts = m.content.map((p) => (p && typeof p === 'object' && 'image_url' in p ? { type: 'text' as const, text: OLD_SCREENSHOT } : p));
      return { ...m, content: parts } as Msg;
    }
    return m;
  });
}

/**
 * The results to set aside so the model's view gets smaller: those before the last message the user sent, apart from
 * the `keepRecent` most recent results and short ones. `isUserTurn` tells a message the user sent from one the app
 * wrote (compact.ts isSyntheticUser). Returns the ids not set aside yet.
 */
export function resultsToPrune(messages: Msg[], already: ReadonlySet<string>, isUserTurn: (m: Msg) => boolean, keepRecent = 6): string[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserTurn(messages[i])) {
      lastUser = i;
      break;
    }
  }
  const out: string[] = [];
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    seen++;
    if (i >= lastUser || seen <= keepRecent || already.has(m.tool_call_id)) continue;
    const text = typeof m.content === 'string' ? m.content : textOf(m.content);
    if (text.length > PRUNE_MIN_CHARS) out.push(m.tool_call_id);
  }
  return out;
}
