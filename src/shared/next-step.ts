// next_step: the small card that ends a turn which leaves the user a decision or a step (src/main/tools/next-step.ts
// checks a call's arguments, src/renderer/next-step.ts draws the card). Types only.

export interface NextStep {
  /** One or two sentences: what is now true, where it stands */
  recap: string;
  /** The one question for the user ('' when there is none) */
  question: string;
  /** The replies that answer it, the recommended one first (none without a question) */
  replies: string[];
}
