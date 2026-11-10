// What Auto mode learns from the user: their own answers on approval cards (allow or deny, any scope, any mode) and
// their Allow on an action Auto mode blocked, one short line each, merged when alike. Written only from the user's
// clicks (Agent.resolveApproval, Agent.allowBlocked), never from the agent, a tool result, a page or the check itself;
// kept in the app's profile folder as a file of its own. The safety check reads a capped selection as earlier
// decisions (classifier.ts); Settings → Permissions → Auto mode lists them, with remove and Forget all.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LearnedAnswer } from '../../shared/auto-mode';

/** How many answers are kept: past it, the least used go first, the oldest of them first. */
export const MAX_LEARNED = 200;
/** How many the check is given: the most recent denials first, then the most recent allows. */
export const LEARNED_FOR_CHECK = 30;
const MAX_LINE = 160;
const MAX_KEY = 120;
const MAX_TOOL = 80;

/** One line: whitespace and newlines collapsed, control characters out, cut at `max`. */
export function cleanLine(s: unknown, max = MAX_LINE): string {
  const t = String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** An answer as recorded: the tool, what it concerned (a site, the programs, a file, a server) and the card's line. */
export interface AnswerInput {
  tool: string;
  key: string;
  line: string;
  decision: 'allow' | 'deny';
}

/** The answers with `input` merged in: an answer about the same tool, target and line counts up (the latest decision wins), else a new one; capped. */
export function learn(list: readonly LearnedAnswer[], input: AnswerInput, now = Date.now()): LearnedAnswer[] {
  const tool = cleanLine(input.tool, MAX_TOOL);
  const line = cleanLine(input.line);
  const key = cleanLine(input.key, MAX_KEY);
  if (!tool || !line || (input.decision !== 'allow' && input.decision !== 'deny')) return [...list];
  const same = list.find((e) => e.tool === tool && e.key === key && e.line === line);
  let out: LearnedAnswer[];
  if (same) {
    const merged: LearnedAnswer = same.decision === input.decision ? { ...same, count: same.count + 1, at: now } : { ...same, decision: input.decision, count: 1, at: now };
    out = list.map((e) => (e === same ? merged : e));
  } else {
    out = [...list, { id: randomUUID(), tool, key, line, decision: input.decision, count: 1, at: now }];
  }
  return capLearned(out);
}

/** At most MAX_LEARNED: the least used go first, and among them the oldest. Order otherwise kept. */
export function capLearned(list: readonly LearnedAnswer[], max = MAX_LEARNED): LearnedAnswer[] {
  if (list.length <= max) return [...list];
  const drop = new Set([...list].sort((a, b) => a.count - b.count || a.at - b.at).slice(0, list.length - max));
  return list.filter((e) => !drop.has(e));
}

/**
 * What the check is given: up to LEARNED_FOR_CHECK answers, denials first (a deny weighs more), each group the most
 * recently answered first; listed oldest first. The selection changes only when the user answers a card, so the
 * request's start stays the same from one check to the next.
 */
export function forCheck(list: readonly LearnedAnswer[], max = LEARNED_FOR_CHECK): LearnedAnswer[] {
  const pick = [...list].sort((a, b) => (a.decision === b.decision ? b.at - a.at : a.decision === 'deny' ? -1 : 1)).slice(0, max);
  return pick.sort((a, b) => a.at - b.at);
}

/** One answer as the check reads it: "denied browser_navigate on news.example: open news.example (3 times)". */
export function answerText(e: LearnedAnswer): string {
  const target = e.key && e.key !== e.line ? ` on ${e.key}` : '';
  return `- ${e.decision === 'allow' ? 'allowed' : 'denied'} ${e.tool}${target}: ${e.line}${e.count > 1 ? ` (${e.count} times)` : ''}`;
}

function isAnswer(v: unknown): v is LearnedAnswer {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.tool === 'string' && typeof e.key === 'string' && typeof e.line === 'string' && (e.decision === 'allow' || e.decision === 'deny') && typeof e.count === 'number' && typeof e.at === 'number';
}

/** The answers in a file of their own (`auto-learned.json` in the profile folder), read once and written on each change. */
export class LearnedStore {
  private list: LearnedAnswer[] | null = null;

  constructor(private readonly file: string) {}

  all(): LearnedAnswer[] {
    if (!this.list) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { answers?: unknown };
        const answers = Array.isArray(raw?.answers) ? raw.answers.filter(isAnswer) : [];
        // A hand-edited file is cleaned as a recorded one would be
        this.list = capLearned(answers.map((e) => ({ ...e, tool: cleanLine(e.tool, MAX_TOOL), key: cleanLine(e.key, MAX_KEY), line: cleanLine(e.line), count: Math.max(1, Math.floor(e.count)) })));
      } catch {
        this.list = [];
      }
    }
    return this.list.map((e) => ({ ...e }));
  }

  record(input: AnswerInput, now = Date.now()): void {
    this.save(learn(this.all(), input, now));
  }

  remove(id: string): boolean {
    const all = this.all();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return false;
    this.save(next);
    return true;
  }

  clear(): void {
    this.save([]);
  }

  private save(list: LearnedAnswer[]): void {
    this.list = list;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ answers: list }, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[auto] could not save what Auto mode learned:', err instanceof Error ? err.message : String(err));
    }
  }
}
