// Messages that were not typed here (a sub-session's report, a message from another session, a merged summary, a
// scheduled task) reach the conversation inside a frame written for the model: who sent it, its id, what to do next.
// The transcript shows what was said; the frame's news about the sender goes into the label above the bubble.
// The frames are written in src/main/subagents/service.ts, src/main/schedules/service.ts and src/main/dreaming/digest.ts; test/origin.js runs
// their real output through this, so a change of wording there shows up as a failing test rather than as a raw frame
// in the chat. A text that does not match is shown as it is.
import type { MessageOrigin } from '../shared/types.js';

export interface Unframed {
  /** What the bubble (or the row, opened) shows */
  text: string;
  /** What the frame said about the sender, for the label ("finished a turn", "it was stopped") */
  note?: string;
  /** The sending session's title as the frame gave it (a message or a report), for a sender that is gone since */
  sender?: string;
}

const REPORT = /^\[Sub-session "([\s\S]*?)" \([\w-]+\) finished a turn: ([^\]\n]+)\]\n([\s\S]*?)\n\nNext: read more with session_read[^\n]*$/;
/** The head line (src/main/subagents/service.ts messageHead): the sender, then a one-line note without "]" */
const MESSAGE = /^\[Message from (?:another session|session "([\s\S]*?)" \([\w-]+\))[^\]\n]*\]\n([\s\S]*)$/;
const MERGED = /^\[Merged from "[\s\S]*?"\]\n\n([\s\S]*)$/;
const SCHEDULED = /^\[Scheduled task "[\s\S]*?" \([^\n]*\)\. This message was sent automatically[^\n]*\]\n[^\n]*\n\n([\s\S]*)$/;
/** A dream's digest (src/main/dreaming/digest.ts): the frame line and the line that asks for the review */
const DREAM = /^\[Dream\] [^\n]*\n[^\n]*\n([\s\S]*)$/;

export function unframe(origin: MessageOrigin | undefined, text: string): Unframed {
  const raw = String(text ?? '');
  if (origin === 'session') {
    const report = REPORT.exec(raw);
    if (report) return { text: report[3].trim(), note: report[2] === 'done' ? 'finished a turn' : report[2], sender: report[1] };
    const message = MESSAGE.exec(raw);
    if (message) return message[1] === undefined ? { text: message[2].trim() } : { text: message[2].trim(), sender: message[1] };
  } else if (origin === 'command') {
    const merged = MERGED.exec(raw);
    if (merged) return { text: merged[1].trim() };
  } else if (origin === 'schedule') {
    const scheduled = SCHEDULED.exec(raw);
    if (scheduled) return { text: scheduled[1].trim() };
  } else if (origin === 'dream') {
    const dream = DREAM.exec(raw);
    if (dream) return { text: dream[1].trim() };
  }
  return { text: raw };
}
