// What the run loop (agent.ts) tells the model when a reply went wrong in a way the model can mend: a reply cut at the
// output limit, and one tool call made again and again with the same result. Every text here goes into the
// conversation (a tool result or a user-role message), never into the system prompt, so the cached prefix stays.

import { createHash } from 'node:crypto';

/** The result of a call whose arguments were cut off at the output limit (it is not run). */
export const CUT_CALL_TEXT = 'Cut off at the output limit while writing this call. Send it again in smaller pieces (several edit_file calls instead of one write_file).';
/** The message that asks the model to go on after a reply cut at the output limit. */
export const CONTINUE_TEXT = 'Your reply was cut off at the output limit. Continue from where it stopped; do not repeat what you already wrote.';
/** At most this many continuations per user message; then the run ends as it would have. */
export const MAX_CONTINUATIONS = 2;

/** How many of the newest calls are kept to compare */
export const REPEAT_WINDOW = 10;
/** This many identical calls in a row: a line on the result asks the model to change course */
export const REPEAT_WARN = 3;
/** This many: the run ends (run_end reason `loop`) */
export const REPEAT_STOP = 5;
export const REPEAT_WARNING = `[You have made this exact call ${REPEAT_WARN} times with the same result. Try a different approach or ask the user.]`;
export const REPEAT_STOP_NOTICE = `Stopped: the model repeated the same call ${REPEAT_STOP} times.`;
/** The notice for a refusal (Anthropic stop_reason "refusal") */
export const REFUSAL_NOTICE = 'The model declined this request.';

/** True when `raw` is complete JSON (the arguments of a call that was not cut off). */
export function isCompleteJson(raw: string): boolean {
  if (!raw.trim()) return true;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** JSON with every object's keys sorted, so the same arguments in another order are the same call. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Calls whose purpose is to be made again: reading a terminal while waiting for output, listing sessions. */
export function isPolling(name: string, args: unknown): boolean {
  if (name === 'session_list') return true;
  if (name === 'terminal_read') return !!args && typeof args === 'object' && (args as Record<string, unknown>).wait_ms !== undefined;
  return false;
}

/**
 * The newest calls of a run as (name, canonical arguments, short hash of the result). `add` returns how many of the
 * newest are the same as the one just added (1 when it differs from the one before).
 */
export class RepeatWatch {
  private recent: string[] = [];

  add(name: string, rawArgs: string, result: string): number {
    let args: unknown = rawArgs;
    try {
      args = JSON.parse(rawArgs || '{}');
    } catch {
      /* compared as written */
    }
    if (isPolling(name, args)) return 0;
    const hash = createHash('sha256').update(result).digest('hex').slice(0, 12);
    const key = `${name}\u0000${canonicalJson(args)}\u0000${hash}`;
    this.recent.push(key);
    if (this.recent.length > REPEAT_WINDOW) this.recent.shift();
    let same = 0;
    for (let i = this.recent.length - 1; i >= 0 && this.recent[i] === key; i--) same++;
    return same;
  }
}
