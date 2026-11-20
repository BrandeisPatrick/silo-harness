import type { NextStep } from '../../shared/next-step';
import type { Tool } from './types';

// next_step, as the Claude Code desktop app does it: when a turn's work is done and leaves the user a decision or a
// step, the model calls it, then writes its closing reply in full; the card (a recap in grey, one question, one or
// two replies, the recommended one first) is drawn under that reply and never replaces it. A model that writes the
// reply first and calls it last gets the same picture. It needs no approval and does nothing but show the card: it
// returns at once, and the user's answer is their next message (a click on a reply sends its label). An empty
// message after it is nudged once for the reply, then the recap stands in (Agent, 'recap_reply'). Offered to
// top-level sessions only (Agent.toolPool). The window draws only what parseNextStep returns, and as text, never
// markup: the words are the model's.

export const MAX_RECAP = 300;
export const MAX_QUESTION = 100;
export const MAX_REPLY = 40;
export const MAX_REPLIES = 2;
/** What the model reads after a card was shown */
export const SHOWN =
  'The card is ready; it is drawn under your reply. Now write your reply to the user in full, standing on its own, without asking the card\'s question again. (If you already wrote it before this call, you are done.)';
/** The nudge when the message after a card is empty (it starts as the app's own nudge does, so the transcript, compaction and dreams leave it out alike) */
export const NEXT_STEP_NUDGE = 'You returned an empty response. Your reply to the user is still missing: write it now, in full. The next-step card is drawn under it and does not replace it.';
/** A trailing "(Recommended)" on a reply: the first reply is the recommended one, so the mark is dropped */
const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** Plain text on one line: control, zero-width and direction characters and runs of white space become one space. */
function plain(v: unknown): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const chars = (s: string) => [...s].length;

/**
 * The card a next_step call asks for, checked. Throws an Error whose message tells the model what to fix: a recap is
 * required (at most MAX_RECAP characters), a question is optional (at most MAX_QUESTION), replies are optional (one
 * or two, each at most MAX_REPLY characters, different from each other) and need a question.
 */
export function parseNextStep(args: unknown): NextStep {
  let a: Record<string, unknown> = {};
  if (typeof args === 'string') {
    try {
      const v = JSON.parse(args) as unknown;
      if (v && typeof v === 'object') a = v as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  } else if (args && typeof args === 'object') a = args as Record<string, unknown>;
  const recap = plain(a.recap);
  if (!recap) throw new Error('recap is required: one or two sentences on what is now true and where it stands.');
  if (chars(recap) > MAX_RECAP) throw new Error(`recap is ${chars(recap)} characters; keep it to ${MAX_RECAP}.`);
  const question = plain(a.question);
  if (chars(question) > MAX_QUESTION) throw new Error(`question is ${chars(question)} characters; keep it to ${MAX_QUESTION}.`);
  const raw = a.replies === undefined || a.replies === null ? [] : a.replies;
  if (!Array.isArray(raw)) throw new Error('replies must be a list of one or two short labels.');
  const replies = raw.map((r) => plain(r).replace(RECOMMENDED, '').trim());
  if (replies.some((r) => !r)) throw new Error('Each reply needs a label.');
  if (replies.length > MAX_REPLIES) throw new Error(`Give at most ${MAX_REPLIES} replies (got ${replies.length}).`);
  for (const r of replies) if (chars(r) > MAX_REPLY) throw new Error(`The reply "${r}" is ${chars(r)} characters; keep each to ${MAX_REPLY}.`);
  if (replies.length === 2 && replies[0].toLowerCase() === replies[1].toLowerCase()) throw new Error('The two replies are the same; give two different answers.');
  if (replies.length && !question) throw new Error('Replies answer a question: add the question, or leave the replies out.');
  return { recap, question, replies };
}

/** parseNextStep, or null for arguments it refuses (a stored call the tool turned down). */
export function nextStepOrNull(args: unknown): NextStep | null {
  try {
    return parseNextStep(args);
  } catch {
    return null;
  }
}

export const nextStep: Tool = {
  name: 'next_step',
  description:
    "Call it once when the turn's work is done and leaves the user a decision or a step to take, then write your reply to the user in full: the card (a recap, optionally one question with one or two replies to click) is drawn under that reply and does not replace it. The first reply is the recommended one; do not mark it. Plain text.",
  parameters: {
    type: 'object',
    properties: {
      recap: { type: 'string', description: `Where things stand, incl. what is not done; ≤${MAX_RECAP} chars` },
      question: { type: 'string', description: `≤${MAX_QUESTION} chars` },
      replies: { type: 'array', maxItems: MAX_REPLIES, items: { type: 'string', description: `≤${MAX_REPLY} chars` } },
    },
    required: ['recap'],
  },
  async run(args) {
    parseNextStep(args);
    return { content: SHOWN };
  },
};
