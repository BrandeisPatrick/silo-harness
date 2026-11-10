// What a turn's working process is, and the words of its header (turn-fold.ts draws them). Pure, no imports, so the
// unit test loads it as it is (test/turn-fold.js).
//
// A turn is what follows a user message. Its process is the interim replies, thinking, tool rows and groups (with the
// approvals decided in them), sub-session and message lines and blocked calls; the answer is the reply after its last
// call. Everything else (shown images, cards, a plan, a card still waiting, notices, errors, compaction markers) is
// never part of the process.

/** "18s", "1m 05s": the status line's format, which the header shares */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The header: "Working for 18s" while the turn runs, "Worked for 53s" after, "Worked" when the time was not kept. */
export function headText(running: boolean, ms: number | undefined): string {
  if (running) return `Working for ${elapsedText(ms ?? 0)}`;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? `Worked for ${elapsedText(ms)}` : 'Worked';
}

/** call: a tool call's row or line; text: a reply; process: thinking or a decided approval; keep: anything else */
export type NodeKind = 'call' | 'text' | 'process' | 'keep';

/** What a top-level transcript node is to its turn, from its classes. */
export function nodeKind(classes: readonly string[]): NodeKind {
  const has = (c: string) => classes.includes(c);
  if (has('tool') || has('tool-group') || has('auto-blocked') || (has('session-msg') && has('sent'))) return 'call';
  if (has('msg') && has('assistant')) return 'text';
  if (has('thinking') || (has('approval') && has('done'))) return 'process';
  return 'keep';
}

export interface TurnShape {
  /** The turn made at least one call that left a row: it gets the header */
  hasCall: boolean;
  /** A reply came after the last call: the final answer */
  hasAnswer: boolean;
  /** Per node: part of the process (hidden while the turn is folded) */
  process: boolean[];
}

/** The shape of one turn from the kinds of its nodes, in order. */
export function turnShape(kinds: readonly NodeKind[]): TurnShape {
  const lastCall = kinds.lastIndexOf('call');
  return {
    hasCall: lastCall >= 0,
    hasAnswer: lastCall >= 0 && kinds.some((k, i) => k === 'text' && i > lastCall),
    // The answer is only the replies after the last call; thinking before it is process too
    process: kinds.map((k, i) => k === 'call' || k === 'process' || (k === 'text' && i < lastCall)),
  };
}

/**
 * Whether a turn is folded once it is over: with Tool activity on Summary, when it has an answer and the run did not
 * stop short (interrupted, failed). A stored turn (`reason` unknown) folds when it has an answer.
 */
export function foldsWhenDone(shape: TurnShape, summary: boolean, reason?: string): boolean {
  if (!summary || !shape.hasCall || !shape.hasAnswer) return false;
  return reason === undefined || reason === 'done' || reason === 'plan';
}
