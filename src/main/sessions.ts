import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { CompactionInfo, MessageOrigin, PlanInfo, SessionMeta, SessionOrigin, TaskItem, TranscriptItem, ArtifactInfo } from '../shared/types';
import type { ImageInfo } from '../shared/images';
import type { Snapshot } from './changes';
import { FAILED_RESULT, HOOK_NOTE_PREFIX, isCompactPreamble } from './compact';
import { imagesByCall } from './images/store';
import { FILE_BLOCK_RE, mentionedPaths } from './mentions';
import { PROPOSAL_ID_RE, PROPOSAL_TOOLS } from './dreaming/names';
import { actionLine, AUTO_NOTE_PREFIX, blockedReason } from './agent/auto-rules';

export type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  forkedFrom?: string;
  /** The folder the agent works in for this session (absolute). Missing on sessions stored before folders were per session. */
  cwd?: string;
  /** The session this one was spawned from (origin 'spawn') */
  parentId?: string;
  origin?: SessionOrigin;
  /** A run ended while the session was not on screen and it has not been opened since */
  unread?: boolean;
  /** For a fork: how many messages it was seeded with from its source */
  seedLength?: number;
  /** Set once this session (a sub-session or fork) was merged into another: that session's id, and when (see subagents) */
  mergedInto?: string;
  mergedAt?: number;
  /** Set once the user renamed the session or a title was generated; save() then stops deriving one. */
  titleLocked?: boolean;
  messages: Msg[];
  /** Plans proposed in plan mode, by id */
  plans?: Record<string, PlanInfo>;
  /** Artifacts the model created with create_artifact (see artifacts.ts) */
  artifacts?: Record<string, ArtifactInfo>;
  /** Images the model showed with show_image, by id (see images/store.ts) */
  images?: Record<string, ImageInfo>;
  /** Files the agent changed: content before the first change (see changes.ts) */
  changes?: Record<string, Snapshot>;
  /** Compactions in order; each keeps the messages it folded so the transcript can still show them */
  compactions?: StoredCompaction[];
  /** Size of the last request the model saw (prompt + reply), and the message index it covered; drives the context meter */
  lastPrompt?: { tokens: number; at: number };
  /** One checkpoint per user message of the live conversation, for rewinding (see rewindSession) */
  turns?: Turn[];
  /** The agent's task list (update_tasks) */
  tasks?: TaskItem[];
  /**
   * The names of the only tools this session's agent is offered, whatever the permission mode (a dream's session:
   * reading and proposing, nothing that changes a file). Unset: the usual tools.
   */
  tools?: string[];
  /** Set on a dream's session: the dream, and how many of its proposals wait for the user (see dreaming/) */
  dream?: { id: string; waiting?: number };
}

/** A checkpoint: where a user message sits in `messages` and what files looked like when the agent first touched them after it. */
export interface Turn {
  /** Index of the user message in Session.messages */
  at: number;
  createdAt: number;
  /** What the user typed (without inlined skill or file blocks), for the composer */
  text: string;
  /** Absolute path → content before the first write or edit in this turn; null when the file did not exist */
  files: Record<string, string | null>;
  /** Files the turn changed but could not snapshot (too large or not text) */
  skipped?: string[];
  /** The agent's task list when the turn started (restored by a rewind) */
  tasks?: TaskItem[];
  /** Set when the message was not typed in the window (a schedule, another session, …) */
  origin?: MessageOrigin;
  from?: string;
}

const SNAPSHOT_LIMIT = 2 * 1024 * 1024;

/** Records a file's content on the turn before the agent's first change to it in that turn. */
export function turnSnapshot(turn: Turn, absPath: string): void {
  const key = path.resolve(absPath);
  if (key in turn.files || turn.skipped?.includes(key)) return;
  let buf: Buffer;
  try {
    const st = fs.statSync(key);
    if (!st.isFile() || st.size > SNAPSHOT_LIMIT) {
      (turn.skipped ??= []).push(key);
      return;
    }
    buf = fs.readFileSync(key);
  } catch {
    turn.files[key] = null; // the agent is about to create it
    return;
  }
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) {
    (turn.skipped ??= []).push(key);
    return;
  }
  turn.files[key] = buf.toString('utf8');
}

export interface RewindOutcome {
  text: string;
  restored: string[];
  deleted: string[];
  skipped: string[];
}

/**
 * Puts the session back to the checkpoint `turnIndex`: files the agent wrote or edited from then on go back to their
 * content at that point (a file that did not exist is removed), and the messages from that user message on are dropped.
 * Returns the message's text so it can be edited and sent again. Paths in the result are relative to `cwd`.
 */
export function rewindSession(s: Session, cwd: string, turnIndex: number, store?: SessionStore): RewindOutcome {
  const turns = s.turns ?? [];
  const turn = turns[turnIndex];
  if (!turn || turn.at > s.messages.length) throw new Error('That message can no longer be rewound to.');
  // The content to restore is what the earliest affected turn saw: nothing changed it between that point and the checkpoint.
  const target = new Map<string, string | null>();
  const skipped = new Set<string>();
  for (let i = turnIndex; i < turns.length; i++) {
    for (const [abs, content] of Object.entries(turns[i].files)) if (!target.has(abs)) target.set(abs, content);
    for (const abs of turns[i].skipped ?? []) if (!target.has(abs)) skipped.add(abs);
  }
  const rel = (abs: string) => path.relative(cwd, abs) || abs;
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const [abs, content] of target) {
    try {
      if (content === null) {
        fs.rmSync(abs, { force: true });
        deleted.push(rel(abs));
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        restored.push(rel(abs));
      }
    } catch (err) {
      console.warn('[rewind] could not restore', abs, err);
      skipped.add(abs);
    }
  }
  if (store) store.truncate(s, turn.at);
  else s.messages.splice(turn.at);
  s.turns = turns.slice(0, turnIndex);
  s.tasks = turn.tasks?.length ? structuredClone(turn.tasks) : undefined;
  if (s.lastPrompt && s.lastPrompt.at > s.messages.length) delete s.lastPrompt;
  return { text: turn.text, restored: restored.sort(), deleted: deleted.sort(), skipped: [...skipped].map(rel).sort() };
}

export interface StoredCompaction extends CompactionInfo {
  folded: Msg[];
}

/** The public part of a stored compaction (without the folded messages). */
export function compactionInfo(c: StoredCompaction): CompactionInfo {
  const { folded: _folded, ...info } = c;
  return info;
}

/** The most recently proposed plan of a session, if any. */
export function latestPlan(s: Session): PlanInfo | undefined {
  let best: PlanInfo | undefined;
  for (const p of Object.values(s.plans ?? {})) if (!best || p.createdAt > best.createdAt) best = p;
  return best;
}

const NEW_TITLE = 'New session';
const MAX_TITLE = 80;

/** First `max` characters of s, without splitting a surrogate pair (emoji). */
export function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

const SKILL_BLOCK = /\n*<skill name="[^"]*">[\s\S]*?<\/skill>\s*$/;

/** Strips the inlined skill body and @-mentioned file blocks from a user message so the transcript shows what the user typed. */
export function displayText(content: unknown): string {
  const strip = (s: string) => s.replace(SKILL_BLOCK, '').replace(FILE_BLOCK_RE, '');
  if (typeof content === 'string') return strip(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? strip(String((part as { text: string }).text)) : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** The raw text of a user message (string content, or its text parts). */
function rawText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: string }).text) : '')).join('\n');
  return '';
}

/** Data URLs of the images in a user message's content parts. */
export function imageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    const url = part && typeof part === 'object' && 'image_url' in part ? (part as { image_url?: { url?: string } }).image_url?.url : undefined;
    if (typeof url === 'string' && url.startsWith('data:image/')) out.push(url);
  }
  return out;
}

export function toMeta(s: Session): SessionMeta {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    forkedFrom: s.forkedFrom,
    messageCount: s.messages.length,
    titleLocked: s.titleLocked === true,
    plan: latestPlan(s),
    changedFiles: Object.keys(s.changes ?? {}).length,
    artifacts: Object.keys(s.artifacts ?? {}).length,
    compactions: s.compactions?.length ?? 0,
    tasks: s.tasks?.length ? s.tasks.map((t) => ({ ...t })) : undefined,
    cwd: s.cwd,
    parentId: s.parentId,
    origin: s.origin,
    mergedInto: s.mergedInto,
    dream: s.dream ? { id: s.dream.id, waiting: s.dream.waiting ?? 0 } : undefined,
  };
}

/**
 * The whole conversation for the renderer: folded messages, a divider per compaction, then the live messages.
 * With `running` (the session has a run in progress) a tool call that has no result yet is left out instead of shown
 * as a finished "(no result)" row: it is still in flight, and the window shows it from the runtime's LiveState.
 */
export function toTranscript(s: Session, opts: { running?: boolean } = {}): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const shown = s.images ? imagesByCall(s, [...(s.compactions ?? []).flatMap((c) => c.folded), ...s.messages]) : undefined;
  for (const c of s.compactions ?? []) {
    appendTranscript(s, c.folded, items, undefined, false, shown);
    items.push({ role: 'compaction', compaction: compactionInfo(c) });
  }
  // Only the live messages have checkpoints; folded ones cannot be rewound to.
  const turnByAt = new Map<number, number>();
  (s.turns ?? []).forEach((t, i) => turnByAt.set(t.at, i));
  appendTranscript(s, s.messages, items, turnByAt, opts.running === true, shown);
  return items;
}

/** A tool call as the stored assistant messages hold it (the object itself is the key of pairToolResults). */
export type StoredToolCall = NonNullable<Extract<Msg, { role: 'assistant' }>['tool_calls']>[number];

/**
 * Each tool result paired with the call it answers, keyed by the call object: the nearest call before it with that
 * id, in order when one reply holds the same id twice. An id alone is not enough: a model (Ollama's numbering, or
 * our own fallback ids in sessions saved before 0.11.1) can reuse one across runs, and a map from id to result would
 * show the last run's result on every call that had it.
 */
export function pairToolResults(messages: Msg[]): Map<StoredToolCall, Extract<Msg, { role: 'tool' }>> {
  const out = new Map<StoredToolCall, Extract<Msg, { role: 'tool' }>>();
  const open = new Map<string, StoredToolCall[]>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const fresh = new Map<string, StoredToolCall[]>();
      for (const call of m.tool_calls) fresh.set(call.id, [...(fresh.get(call.id) ?? []), call]);
      for (const [id, calls] of fresh) open.set(id, calls);
    } else if (m.role === 'tool') {
      const call = open.get(m.tool_call_id)?.shift();
      if (call) out.set(call, m);
    }
  }
  return out;
}

function appendTranscript(s: Session, messages: Msg[], items: TranscriptItem[], turnByAt?: Map<number, number>, inFlight = false, shown?: Map<string, ImageInfo>): void {
  const paired = pairToolResults(messages);
  const results = new Map<StoredToolCall, string>();
  for (const [call, m] of paired) results.set(call, typeof m.content === 'string' ? m.content : String(m.content));
  messages.forEach((m, index) => {
    if (m.role === 'user') {
      if (isCompactPreamble(m)) return;
      const text = displayText(m.content);
      if (text.startsWith('[Screenshot returned by') || text.startsWith('You returned an empty response.') || text.startsWith(HOOK_NOTE_PREFIX) || text.startsWith(AUTO_NOTE_PREFIX)) return;
      const images = imageUrls(m.content);
      const mentions = mentionedPaths(rawText(m.content));
      const item: Extract<TranscriptItem, { role: 'user' }> = { role: 'user', text };
      if (images.length) item.images = images;
      if (mentions.length) item.mentions = mentions;
      const turn = turnByAt?.get(index);
      if (turn !== undefined) {
        item.turn = turn;
        const t = s.turns?.[turn];
        if (t?.origin && t.origin !== 'user' && t.origin !== 'queue') {
          item.origin = t.origin;
          if (t.from) item.from = t.from;
        }
      }
      items.push(item);
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) items.push({ role: 'assistant', text });
      for (const call of m.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        if (inFlight && !results.has(call)) continue;
        const result = results.get(call) ?? '(no result)';
        const ok = !FAILED_RESULT.test(result);
        if (call.function.name === 'submit_plan') {
          const plan = planForCall(s, call.function.arguments);
          if (plan) {
            items.push({ role: 'plan', plan });
            continue;
          }
        }
        if (call.function.name === 'create_artifact' && ok) {
          const id = /\bid: ([\w-]+)/.exec(result)?.[1];
          const artifact = id ? s.artifacts?.[id] : undefined;
          if (artifact) {
            items.push({ role: 'artifact', artifact });
            continue;
          }
        }
        // A dream's proposal is its card (a refused one stays a tool row with the reason)
        const proposal = ok && PROPOSAL_TOOLS.includes(call.function.name) ? PROPOSAL_ID_RE.exec(result)?.[1] : undefined;
        if (proposal) {
          items.push({ role: 'proposal', proposalId: proposal, name: call.function.name, args: call.function.arguments, result });
          continue;
        }
        // A call Auto mode's check blocked is one quiet line (auto-blocked.ts in the window)
        const blocked = blockedReason(result);
        if (blocked !== null) {
          items.push({ role: 'auto_blocked', block: { id: call.id, sessionId: s.id, name: call.function.name, what: actionLine(call.function.name, call.function.arguments), reason: blocked, at: 0 } });
          continue;
        }
        // A show_image call is the image itself (a failed one stays a tool row with its error)
        const image = call.function.name === 'show_image' && ok ? shown?.get(call.id) : undefined;
        if (image) {
          items.push({ role: 'image', image });
          continue;
        }
        items.push({ role: 'tool', name: call.function.name, args: call.function.arguments, result, ok });
      }
    }
  });
}

/** The stored plan that a submit_plan call produced (matched by title and body), or a synthetic proposed one. */
function planForCall(s: Session, rawArgs: string): PlanInfo | null {
  let args: { title?: unknown; markdown?: unknown } = {};
  try {
    args = JSON.parse(rawArgs) as typeof args;
  } catch {
    return null;
  }
  const markdown = typeof args.markdown === 'string' ? args.markdown.trim() : '';
  if (!markdown) return null;
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Plan';
  const stored = Object.values(s.plans ?? {}).find((p) => p.markdown === markdown && p.title === clip(title, MAX_TITLE));
  return stored ?? { id: '', title, markdown, status: 'proposed', createdAt: s.updatedAt };
}

/**
 * One event in a session's life. Every change to its messages goes through SessionStore.append / truncate /
 * replaceAll, and the store reports creating, forking, renaming, saving and deleting too, so one listener
 * (onMutation) can keep a complete record of what the model saw.
 */
export type SessionMutation =
  /** `index` is where the message now sits in session.messages */
  | { kind: 'append'; message: Msg; index: number }
  /** Messages from `length` on were removed (a rewind); `removed` holds them */
  | { kind: 'truncate'; length: number; removed: Msg[] }
  /** reason: 'compaction' | 'prune' | 'recovery' | … ; `removed` are the messages that were replaced */
  | { kind: 'replace'; messages: Msg[]; removed: Msg[]; reason: string }
  /** The session file was written with this many messages */
  | { kind: 'save'; messages: number }
  | { kind: 'create' }
  /** Fires on the new session: the source's id and how many messages it was seeded with */
  | { kind: 'fork'; from: string; seedLength: number }
  | { kind: 'rename'; title: string }
  /** Fires before the session's file is removed */
  | { kind: 'delete' };

export interface CreateSessionOptions {
  cwd?: string;
  parentId?: string;
  origin?: SessionOrigin;
  title?: string;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private mutationListeners = new Set<(session: Session, op: SessionMutation) => void>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
        if (s && s.id && Array.isArray(s.messages)) this.sessions.set(s.id, s);
      } catch (err) {
        console.warn(`[sessions] could not read ${file}:`, err);
      }
    }
  }

  /** The JSON file a session is saved in (whether or not it has been written yet). */
  file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].filter((s) => s.messages.length > 0).sort((a, b) => b.updatedAt - a.updatedAt).map(toMeta);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Every session held, empty ones too (list() leaves those out), in no order. */
  all(): Session[] {
    return [...this.sessions.values()];
  }

  /** New empty session. It is only written to disk once it has messages. */
  create(opts: CreateSessionOptions = {}): Session {
    const now = Date.now();
    const s: Session = { id: randomUUID(), title: NEW_TITLE, createdAt: now, updatedAt: now, messages: [] };
    if (opts.cwd) s.cwd = opts.cwd;
    if (opts.parentId) s.parentId = opts.parentId;
    if (opts.origin) s.origin = opts.origin;
    const title = opts.title ? clip(opts.title.replace(/\s+/g, ' ').trim(), MAX_TITLE).trim() : '';
    if (title) {
      s.title = title;
      s.titleLocked = true;
    }
    this.sessions.set(s.id, s);
    this.notify(s, { kind: 'create' });
    return s;
  }

  // ---------- Message mutations: the only way session.messages changes ----------

  /** Adds a message at the end of the conversation. */
  append(s: Session, message: Msg): void {
    s.messages.push(message);
    this.notify(s, { kind: 'append', message, index: s.messages.length - 1 });
  }

  /** Drops the messages from `length` on. */
  truncate(s: Session, length: number): void {
    const at = Math.max(0, Math.min(s.messages.length, Math.floor(length)));
    if (at >= s.messages.length) return;
    const removed = s.messages.splice(at);
    this.notify(s, { kind: 'truncate', length: at, removed });
  }

  /** Replaces the whole conversation; `reason` says why (e.g. 'compaction'). */
  replaceAll(s: Session, messages: Msg[], reason: string): void {
    const removed = s.messages.splice(0, s.messages.length, ...messages);
    this.notify(s, { kind: 'replace', messages: [...messages], removed, reason });
  }

  /** Called for every mutation of any session, right after it happened (a delete: right before the file goes). */
  onMutation(cb: (session: Session, op: SessionMutation) => void): () => void {
    this.mutationListeners.add(cb);
    return () => this.mutationListeners.delete(cb);
  }

  private notify(s: Session, op: SessionMutation): void {
    for (const cb of [...this.mutationListeners]) {
      try {
        cb(s, op);
      } catch (err) {
        console.warn('[sessions] a mutation listener failed:', err);
      }
    }
  }

  /** Copy of a session, including its full history, that continues independently. */
  fork(id: string): Session {
    const src = this.sessions.get(id);
    if (!src) throw new Error(`No session ${id}`);
    const now = Date.now();
    const s: Session = {
      id: randomUUID(),
      title: src.title === NEW_TITLE ? NEW_TITLE : `${src.title} (fork)`,
      createdAt: now,
      updatedAt: now,
      forkedFrom: src.id,
      cwd: src.cwd,
      origin: 'fork',
      titleLocked: src.titleLocked,
      messages: structuredClone(src.messages),
      plans: src.plans ? structuredClone(src.plans) : undefined,
      changes: src.changes ? structuredClone(src.changes) : undefined,
      compactions: src.compactions ? structuredClone(src.compactions) : undefined,
      lastPrompt: src.lastPrompt ? { ...src.lastPrompt } : undefined,
      turns: src.turns ? structuredClone(src.turns) : undefined,
      tasks: src.tasks ? structuredClone(src.tasks) : undefined,
      seedLength: src.messages.length,
    };
    this.sessions.set(s.id, s);
    this.notify(s, { kind: 'fork', from: src.id, seedLength: src.messages.length });
    if (s.messages.length) this.save(s);
    return s;
  }

  /**
   * Takes in a session that was not loaded from this store's folder (brought back from the trash, or rebuilt from
   * its history log) and writes it. Refused when a session with that id exists.
   */
  adopt(s: Session): Session {
    if (!s?.id || !Array.isArray(s.messages)) throw new Error('Not a session.');
    if (this.sessions.has(s.id)) throw new Error(`A session ${s.id} already exists.`);
    this.sessions.set(s.id, s);
    this.save(s, false);
    return s;
  }

  delete(id: string): void {
    const s = this.sessions.get(id);
    if (s) this.notify(s, { kind: 'delete' });
    this.sessions.delete(id);
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }

  /**
   * Sets a user-chosen title and locks it so neither save() nor title generation replaces it.
   * Mutates the stored Session object, which is the same object the agent holds for the current session.
   */
  rename(id: string, title: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`No session ${id}`);
    const clean = clip(String(title ?? '').replace(/\s+/g, ' ').trim(), MAX_TITLE).trim();
    if (!clean) throw new Error('A session title cannot be empty.');
    s.title = clean;
    s.titleLocked = true;
    this.notify(s, { kind: 'rename', title: clean });
    this.save(s, false);
    return s;
  }

  /** Writes the session to disk. `touch` bumps updatedAt (the sidebar's sort key); renames pass false. */
  save(s: Session, touch = true): void {
    // A session deleted while something still held its object (a run that was stopped and is ending) stays deleted.
    if (!this.sessions.has(s.id)) return;
    if (touch) s.updatedAt = Date.now();
    if (!s.titleLocked && s.title === NEW_TITLE) {
      const first = (s.compactions?.[0]?.folded ?? s.messages).find((m) => m.role === 'user' && !isCompactPreamble(m));
      if (first) {
        const text = displayText(first.content).replace(/\s+/g, ' ').trim();
        if (text) s.title = text.length > 48 ? text.slice(0, 47) + '…' : text;
      }
    }
    if (!s.messages.length) return;
    fs.writeFileSync(path.join(this.dir, `${s.id}.json`), JSON.stringify(s));
    this.notify(s, { kind: 'save', messages: s.messages.length });
  }
}
