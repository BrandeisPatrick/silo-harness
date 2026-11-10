// What a dream reads: the skeleton of recent sessions, built by the app so the model does not crawl. A session's
// turns come from its history log (the session file when it has none): what the user said, the final reply, the
// tool activity in a few words with failures and denied approvals called out, and the # memory lines. The digest
// is cut to a token budget, oldest turns first; what does not fit waits for the next dream.

import fs from 'node:fs';
import path from 'node:path';
import type { HistoryRecord } from '../../shared/history';
import type { DreamMode } from '../../shared/dreaming';
import type { MessageOrigin } from '../../shared/types';
import { FAILED_RESULT, isCompactPreamble, isContextNote } from '../compact';
import { displayText, type Msg, type Session } from '../sessions';

/** How much of each piece a digest keeps */
export const CLIP = { user: 700, reply: 500, error: 160, what: 90, memory: 300, instructions: 8000 };
/** The share of the context window a digest may take */
export const DIGEST_SHARE = 0.4;

/** One user message and what came of it. */
export interface DigestTurn {
  sessionId: string;
  /** When the user's message was added (unix ms) */
  t: number;
  text: string;
  /** Who sent it when it was not typed (a schedule, another session, …) */
  origin?: MessageOrigin;
  /** The last thing the agent said in reply */
  reply?: string;
  /** Tool name → calls */
  tools: Record<string, number>;
  failed: { name: string; what: string; error: string }[];
  denied: { name: string; what: string }[];
  /** Lines the user added to the instructions with # while this turn was the latest */
  memory: string[];
}

/** Tokens of a text, the way the context meter estimates them (four characters a token). */
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

export function clipText(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

const DENIED_RE = /^Not permitted: the user denied/;
const FAILED_RE = FAILED_RESULT;

/** A few words for what a tool call was about: the command, the path, the URL, the first string it was given. */
export function callWhat(name: string, rawArgs: unknown): string {
  let args: Record<string, unknown> = {};
  try {
    args = typeof rawArgs === 'string' ? (JSON.parse(rawArgs) as Record<string, unknown>) : ((rawArgs ?? {}) as Record<string, unknown>);
  } catch {
    return '';
  }
  if (!args || typeof args !== 'object') return '';
  for (const key of ['command', 'path', 'url', 'pattern', 'query', 'text', 'name', 'id']) {
    if (typeof args[key] === 'string' && args[key]) return clipText(String(args[key]), CLIP.what);
  }
  const first = Object.values(args).find((v) => typeof v === 'string' && v);
  return typeof first === 'string' ? clipText(first, CLIP.what) : name;
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('\n');
  return '';
}

/** Turns of a conversation, folded by the agent's messages one by one. */
class TurnBuilder {
  readonly turns: DigestTurn[] = [];
  private calls = new Map<string, { name: string; args: unknown }>();
  private origin: MessageOrigin | undefined;
  constructor(private readonly sessionId: string) {}

  /** The next run's first message came from `origin` (run.start) */
  runStart(origin: MessageOrigin | undefined): void {
    this.origin = origin;
  }

  message(m: Msg, t: number): void {
    if (m.role === 'user') {
      if (isCompactPreamble(m) || isContextNote(m)) return;
      const text = displayText(m.content).trim();
      if (!text || text.startsWith('[Screenshot returned by') || text.startsWith('You returned an empty response.')) return;
      const turn: DigestTurn = { sessionId: this.sessionId, t, text, tools: {}, failed: [], denied: [], memory: [] };
      if (this.origin && this.origin !== 'user' && this.origin !== 'queue') turn.origin = this.origin;
      this.origin = undefined;
      this.turns.push(turn);
      return;
    }
    const turn = this.turns[this.turns.length - 1];
    if (!turn) return;
    if (m.role === 'assistant') {
      const text = contentText(m.content).trim();
      if (text) turn.reply = text;
      for (const call of m.tool_calls ?? []) if (call.type === 'function') this.calls.set(call.id, { name: call.function.name, args: call.function.arguments });
    } else if (m.role === 'tool') {
      const call = this.calls.get(m.tool_call_id);
      const name = call?.name ?? 'tool';
      turn.tools[name] = (turn.tools[name] ?? 0) + 1;
      const result = contentText(m.content).trim();
      if (DENIED_RE.test(result)) turn.denied.push({ name, what: callWhat(name, call?.args) });
      else if (FAILED_RE.test(result)) turn.failed.push({ name, what: callWhat(name, call?.args), error: clipText(result.replace(/^Error:\s*/, ''), CLIP.error) });
    }
  }

  memory(text: string, t: number): void {
    const line = clipText(text, CLIP.memory);
    if (!line) return;
    const turn = this.turns[this.turns.length - 1];
    if (turn) turn.memory.push(line);
    else this.turns.push({ sessionId: this.sessionId, t, text: '', tools: {}, failed: [], denied: [], memory: [line] });
  }
}

/**
 * A session's turns, oldest first, from its log; a session without one (stored before the log existed) is read from
 * its file, its turns dated by their checkpoints. `running`: the last turn is still going and is left out.
 */
export function sessionTurns(s: Session, records: HistoryRecord[], opts: { running?: boolean } = {}): DigestTurn[] {
  const b = new TurnBuilder(s.id);
  if (records.some((r) => r.type === 'message.append')) {
    for (const r of records) {
      const d = (r.data ?? {}) as Record<string, unknown>;
      if (r.type === 'run.start') b.runStart(typeof d.origin === 'string' ? (d.origin as MessageOrigin) : undefined);
      else if (r.type === 'message.append' && d.message) b.message(d.message as Msg, r.t);
      else if (r.type === 'memory' && typeof d.text === 'string') b.memory(d.text, r.t);
    }
  } else {
    const at = new Map<number, { t: number; origin?: MessageOrigin }>();
    for (const turn of s.turns ?? []) at.set(turn.at, { t: turn.createdAt, origin: turn.origin });
    const folded = (s.compactions ?? []).flatMap((c) => c.folded ?? []);
    folded.forEach((m) => b.message(m, s.createdAt));
    s.messages.forEach((m, i) => {
      const hit = at.get(i);
      if (hit) b.runStart(hit.origin);
      b.message(m, hit?.t ?? s.updatedAt);
    });
  }
  const turns = b.turns;
  if (opts.running && turns.length) turns.pop();
  return turns;
}

// ---------- The digest ----------

export interface ExistingThings {
  skills: { name: string; description: string; source: string }[];
  mods: { id: string; name: string; scope: string }[];
  /** The project's instructions file and the user's (either may be missing: `text` null) */
  instructions: { scope: 'project' | 'user'; label: string; path: string; text: string | null }[];
}

export interface DigestSession {
  id: string;
  title: string;
  createdAt: number;
  origin?: string;
  turns: DigestTurn[];
}

export interface DigestInput {
  cwd: string;
  mode: DreamMode;
  lookFor: { skills: boolean; mods: boolean; memory: boolean };
  /** Turns not covered yet, per session */
  sessions: DigestSession[];
  existing: ExistingThings;
  /** Tokens the whole message may take */
  budget: number;
}

export interface Digest {
  text: string;
  covered: { sessions: number; turns: number; left: number; from: number; to: number };
  /** The sessions it covers, in the order it shows them */
  sessionIds: string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "Nov 3, 14:02" in local time */
export function when(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ORIGIN_WORDS: Record<string, string> = { user: 'started by the user', fork: 'a fork', spawn: 'a sub-session', schedule: 'a scheduled run' };
const FROM_WORDS: Partial<Record<MessageOrigin, string>> = { schedule: 'Scheduled task', session: 'Another session', remote: 'User (remote)', mod: 'A mod', command: 'A command' };

/** One turn as the digest shows it. */
export function turnText(turn: DigestTurn): string {
  const lines: string[] = [];
  if (turn.text) lines.push(`- [${when(turn.t)}] ${turn.origin ? FROM_WORDS[turn.origin] ?? 'Sent' : 'User'}: ${clipText(turn.text, CLIP.user)}`);
  else lines.push(`- [${when(turn.t)}] (no message)`);
  const calls = Object.entries(turn.tools);
  if (calls.length) lines.push(`  Tools: ${calls.map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ')}`);
  for (const f of turn.failed.slice(0, 4)) lines.push(`  Failed: ${f.name}${f.what ? ` (${f.what})` : ''}: ${f.error}`);
  if (turn.failed.length > 4) lines.push(`  …and ${turn.failed.length - 4} more failed calls`);
  for (const d of turn.denied.slice(0, 4)) lines.push(`  Denied by the user: ${d.name}${d.what ? ` (${d.what})` : ''}`);
  if (turn.reply) lines.push(`  Reply: ${clipText(turn.reply, CLIP.reply)}`);
  for (const m of turn.memory) lines.push(`  Remembered with #: ${m}`);
  return lines.join('\n');
}

function sessionHeading(s: DigestSession): string {
  return `### "${s.title}" · id ${s.id} · ${when(s.createdAt)} · ${ORIGIN_WORDS[s.origin ?? 'user'] ?? s.origin}`;
}

const MODE_WORDS: Record<DreamMode, string> = {
  auto: 'Auto: the app applies each proposal as you make it',
  approve: 'Approve: each proposal waits for the user to apply or dismiss it',
  plan: 'Plan: nothing is applied; your proposals become one plan the user approves',
};

function existingText(e: ExistingThings, lookFor: DigestInput['lookFor']): string {
  const out: string[] = ['## What already exists', ''];
  if (lookFor.skills) {
    out.push('Skills (do not propose one that is here already; to change one, say so):');
    out.push(...(e.skills.length ? e.skills.map((s) => `- ${s.name} (${s.source}): ${clipText(s.description || 'no description', 200)}`) : ['- none']));
    out.push('');
  }
  if (lookFor.mods) {
    out.push('Mods:');
    out.push(...(e.mods.length ? e.mods.map((m) => `- ${m.id} (${m.scope}): ${m.name}`) : ['- none']));
    out.push('');
  }
  out.push('Instructions files (what the agent already reads at the start of every run):');
  for (const f of e.instructions) {
    if (f.text === null) out.push(`- ${f.label} (${f.scope}): none yet; a memory proposal would create ${f.path}`);
    else {
      const text = f.text.length > CLIP.instructions ? `${f.text.slice(0, CLIP.instructions)}\n[… cut here]` : f.text;
      out.push(`- ${f.label} (${f.scope}, ${f.path}):`, '```', text, '```');
    }
  }
  return out.join('\n');
}

/**
 * The dream's first message. Oldest turns first, across the project's sessions, while they fit the budget; the
 * covered range is from the first to the last turn shown, and the cursor may move to `covered.to`.
 */
export function buildDigest(input: DigestInput): Digest {
  const looking = (['skills', 'memory', 'mods'] as const).filter((k) => input.lookFor[k]);
  const off = (['skills', 'memory', 'mods'] as const).filter((k) => !input.lookFor[k]);
  const all = input.sessions.flatMap((s) => s.turns).sort((a, b) => a.t - b.t);
  const head = [
    `[Dream] Silo Harness put this message together from the logs of recent sessions in ${input.cwd}, for a dream; the user did not type it.`,
    `Review these sessions and propose what would help you work better for this user. Mode: ${MODE_WORDS[input.mode]}.`,
    `Look for: ${looking.join(', ') || 'nothing'}${off.length ? ` (${off.join(' and ')} turned off by the user)` : ''}.`,
  ].join('\n');
  const existing = existingText(input.existing, input.lookFor);
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  let used = tokensOf(head) + tokensOf(existing) + 60;
  const shown: DigestTurn[] = [];
  const opened = new Set<string>();
  for (const turn of all) {
    const cost = tokensOf(turnText(turn)) + (opened.has(turn.sessionId) ? 0 : tokensOf(sessionHeading(byId.get(turn.sessionId)!)) + 2);
    // Always at least one turn, so a dream never reads nothing; then only what fits.
    if (shown.length && used + cost > input.budget) {
      // Turns at the same moment go together, so the cursor (a time) never splits them
      while (shown.length > 1 && shown[shown.length - 1].t === turn.t) shown.pop();
      break;
    }
    shown.push(turn);
    opened.add(turn.sessionId);
    used += cost;
  }
  const left = all.length - shown.length;
  const order: string[] = [];
  for (const t of shown) if (!order.includes(t.sessionId)) order.push(t.sessionId);
  const body: string[] = [`## Sessions (${order.length}, ${shown.length} turn${shown.length === 1 ? '' : 's'}, oldest first)`, ''];
  for (const id of order) {
    const s = byId.get(id)!;
    body.push(sessionHeading(s));
    for (const t of shown) if (t.sessionId === id) body.push(turnText(t));
    body.push('');
  }
  if (left) body.push(`${left} newer turn${left === 1 ? '' : 's'} did not fit and wait for the next dream.`);
  const text = [head, existing, body.join('\n').trim()].join('\n\n');
  const from = shown.length ? shown[0].t : 0;
  const to = shown.length ? shown[shown.length - 1].t : 0;
  return { text, covered: { sessions: order.length, turns: shown.length, left, from, to }, sessionIds: order };
}

// ---------- Reading further: one session's conversation as text ----------

/**
 * Messages [start, start + count) of a session's whole conversation (what compactions folded, then the live part),
 * numbered, tool results clipped to `clip` characters.
 */
export function conversationText(s: Session, start: number, count: number, clip = 400): { text: string; total: number } {
  const all: Msg[] = [...(s.compactions ?? []).flatMap((c) => c.folded ?? []), ...s.messages.filter((m) => !isCompactPreamble(m))];
  const from = Math.max(0, Math.min(all.length, Math.floor(start)));
  const slice = all.slice(from, from + Math.max(1, Math.floor(count)));
  const names = new Map<string, string>();
  for (const m of all) if (m.role === 'assistant') for (const c of m.tool_calls ?? []) if (c.type === 'function') names.set(c.id, c.function.name);
  const lines = slice.map((m, i) => {
    const n = from + i;
    if (m.role === 'user') return `#${n} user: ${clipText(displayText(m.content), 4000)}`;
    if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).flatMap((c) => (c.type === 'function' ? [`${c.function.name} ${clipText(c.function.arguments, 300)}`] : []));
      const text = clipText(contentText(m.content), 4000);
      return `#${n} assistant: ${text}${calls.length ? `${text ? ' ' : ''}[calls: ${calls.join('; ')}]` : ''}`;
    }
    if (m.role === 'tool') return `#${n} result of ${names.get(m.tool_call_id) ?? 'a tool'}: ${clipText(contentText(m.content), clip)}`;
    return `#${n} ${m.role}: ${clipText(contentText(m.content), 1000)}`;
  });
  return { text: lines.join('\n'), total: all.length };
}

// ---------- What exists ----------

/** The mods in the three folders, by id (the bundled ones first; a user or project mod with the same id follows). */
export function listMods(roots: { bundled: string; user: string; project: string }): ExistingThings['mods'] {
  const out: ExistingThings['mods'] = [];
  for (const [scope, dir] of [['bundled', roots.bundled], ['user', roots.user], ['project', roots.project]] as const) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const id of names.sort()) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, id, 'mod.json'), 'utf8')) as { name?: unknown };
        out.push({ id, scope, name: typeof m.name === 'string' ? m.name : id });
      } catch {
        /* not a mod folder */
      }
    }
  }
  return out;
}
