// Where a run's time goes: numbers per run, model turn and tool call, kept in memory for /timing and, when asked for
// (SILO_TIMING=1 or the timingLog setting), appended to a JSON-lines file in the profile folder.
//
// Privacy: nothing here takes text. Every field is a number, a count, or one of a fixed set of words; a tool's name is
// kept only when it is one of the built-in tools (an MCP tool is "mcp", anything else "other"), the provider only as
// its type, the model only as the last part of its id. No prompt, argument, command, path, URL, output, title, account,
// base URL or key can reach a record, because no entry point accepts one (test/timing.js feeds secrets through all of
// them and looks for them in the output).
//
// Pure apart from TimingLog at the end; the clock is injectable.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** How a tool call ended. */
export type Outcome = 'ok' | 'failed' | 'denied' | 'blocked' | 'stopped' | 'timed_out';
/**
 * How one permission question was settled: a rule of the mode or project, a read-only command, something the user
 * allowed earlier in the session, an approval card, Auto mode's safety check, a refusal, or a PreToolUse hook.
 */
export type PermissionPath = 'rule' | 'read_only' | 'allowed_before' | 'card' | 'check' | 'refused' | 'hook';
/** A changed request after a refusal, or a slower way of asking (see complete.ts, anthropic.ts). */
export type Fallback = 'no_stream_usage' | 'no_cache_fields' | 'non_streaming' | 'plain_chat' | 'deferred_tools' | 'thinking_stripped' | 'compacted';
/** The work the harness does before a request goes out (Agent.run's turn loop). */
export type PreStep = 'notes' | 'queue' | 'prune_compact' | 'context_note' | 'build';
export const PRE_STEPS: readonly PreStep[] = ['notes', 'queue', 'prune_compact', 'context_note', 'build'];
/** How a model turn ended. */
export type Finish = 'stop' | 'tool_use' | 'length' | 'refusal' | 'error' | 'aborted';

const PROVIDERS = new Set(['openrouter', 'portkey', 'openai', 'anthropic', 'groq', 'deepseek', 'together', 'ollama', 'lmstudio', 'openai-compatible']);
const MODES = new Set(['ask', 'acceptEdits', 'auto', 'plan', 'bypass']);
const RUN_ENDS = new Set(['done', 'aborted', 'max_turns', 'error', 'plan', 'loop']);
const OUTCOMES = new Set<Outcome>(['ok', 'failed', 'denied', 'blocked', 'stopped', 'timed_out']);
const PATHS = new Set<PermissionPath>(['rule', 'read_only', 'allowed_before', 'card', 'check', 'refused', 'hook']);
const FALLBACKS = new Set<Fallback>(['no_stream_usage', 'no_cache_fields', 'non_streaming', 'plain_chat', 'deferred_tools', 'thinking_stripped', 'compacted']);
const FINISHES = new Set<Finish>(['stop', 'tool_use', 'length', 'refusal', 'error', 'aborted']);

/** The built-in tools whose names a record keeps; the agent adds load_tools. */
let builtInNames = new Set<string>();
export function setBuiltInToolNames(names: Iterable<string>): void {
  builtInNames = new Set([...names].filter((n) => /^[a-z][a-z_]{0,40}$/.test(n)));
}

/** A tool's name as a record keeps it: a built-in name, "mcp", or "other". */
export function toolLabel(name: string): string {
  if (typeof name !== 'string') return 'other';
  if (name.startsWith('mcp__')) return 'mcp';
  return builtInNames.has(name) ? name : 'other';
}

/** The provider type, when it is one of the known types. */
export function providerLabel(type: unknown): string {
  return typeof type === 'string' && PROVIDERS.has(type) ? type : 'other';
}

/**
 * The last path segment of a model id ("@openai/gpt-4o-mini" → "gpt-4o-mini"), when it looks like a model name; a
 * fine-tuned id ("ft:…", which names its organisation) is just "fine-tuned".
 */
export function modelLabel(model: unknown): string {
  if (typeof model !== 'string') return 'other';
  const last = model.trim().split('/').pop() ?? '';
  if (/^ft:/i.test(last)) return 'fine-tuned';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(last) ? last : 'other';
}

const pick = <T extends string>(set: Set<T>, v: unknown, dflt: T): T => (typeof v === 'string' && set.has(v as T) ? (v as T) : dflt);
/** A duration or count: a finite number of 0 or more, rounded; else undefined (unknown, not zero). */
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
const ms = (v: number): number => Math.max(0, Math.round(v));

/** A short random id: a session's or a run's, never the session's own id. */
export function shortId(): string {
  return randomBytes(4).toString('hex');
}

// ---------- The records ----------

export interface PermissionSpan {
  path: PermissionPath;
  /** From the question to its answer, waits included */
  ms: number;
  ok: boolean;
  /** The human's wait on a card, and when it began (ms from the run's start) */
  humanMs?: number;
  humanAt?: number;
  /** Auto mode's check: how long, when it began, what it said, and whether it ran out of time */
  checkMs?: number;
  checkAt?: number;
  check?: 'allow' | 'block' | 'error';
  timedOut?: boolean;
}

export interface ToolSpan {
  /** The model turn whose reply asked for it (1-based), and the group it ran in within that reply */
  turn: number;
  group: number;
  name: string;
  /** ms from the run's start: when its preparation began, when it ran, when it was done (post hooks included) */
  at: number;
  startAt: number;
  endAt: number;
  /** Waiting for a free place in its group */
  queueMs: number;
  preHookMs: number;
  permission: PermissionSpan[];
  /** The tool's own work: its run minus the permission questions inside it */
  execMs: number;
  postHookMs: number;
  /** Appending the result to the session, in call order */
  storeMs: number;
  /** From its preparation to its end (post hooks included; not the wait for earlier calls to be stored) */
  wallMs: number;
  outcome: Outcome;
  /** How many other calls ran at some point while it ran */
  alongside: number;
}

export interface TurnSpan {
  n: number;
  /** ms from the run's start: when the harness began on this turn (the user's message or the last tool result) */
  at: number;
  /** The harness's own work before the request went out, by step */
  pre: Partial<Record<PreStep, number>>;
  /** ms from the run's start: the first attempt went out (undefined: no request was made) */
  requestAt?: number;
  /** ms from requestAt, of the attempt that answered: first provider event, first thinking, text and tool-call delta, last event */
  firstEventMs?: number;
  firstThinkingMs?: number;
  firstTextMs?: number;
  firstToolMs?: number;
  lastEventMs?: number;
  /** ms from requestAt: the reply was complete (or the request failed) */
  endMs?: number;
  /** waiting (before anything streamed, retries included) + thinking + writing = endMs */
  waitingMs?: number;
  thinkingMs?: number;
  writingMs?: number;
  attempts: number;
  /** The measured wait before each retry */
  retryWaits: number[];
  fallbacks: Fallback[];
  finish?: Finish;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Tool calls in its reply */
  calls: number;
}

export interface GroupSpan {
  turn: number;
  group: number;
  size: number;
  wallMs: number;
}

export interface RunSummary {
  wallMs: number;
  turns: number;
  calls: number;
  modelMs: number;
  waitingMs: number;
  thinkingMs: number;
  writingMs: number;
  /** Tool phases, less the time the checks and the human took inside them */
  toolsMs: number;
  checksMs: number;
  approvalsMs: number;
  /** The rest: the harness between turns, hooks at the start and end, compaction */
  otherMs: number;
  compactionMs: number;
  retries: number;
  retryWaitMs: number;
  fallbacks: number;
  /** The turn that took longest (1-based), from the harness's start on it to its reply */
  slowest?: number;
}

export interface RunRecord {
  v: 1;
  /** When the run started (epoch ms) */
  at: number;
  session: string;
  run: string;
  provider: string;
  model: string;
  mode: string;
  /** toolConcurrency in effect */
  limit: number;
  wallMs: number;
  end: string;
  turns: TurnSpan[];
  tools: ToolSpan[];
  groups: GroupSpan[];
  summary: RunSummary;
}

// ---------- Recording ----------

export interface Clock {
  now(): number;
}
const perfClock: Clock = { now: () => performance.now() };

/** What complete.ts and anthropic.ts tell about a model request (CompletionHost.timing): a few calls, nothing else. */
export interface RequestTiming {
  /** An attempt goes out (the first, or a retry) */
  attempt(): void;
  /** The retry loop waits before the next attempt */
  retryWait(): void;
  /** A refused request is sent again changed, or a slower way is taken */
  fallback(kind: Fallback): void;
  /** Any event or chunk from the provider */
  event(): void;
  /** A tool call's delta */
  toolDelta(): void;
}

type Phase = 'thinking' | 'writing';

/** One model turn being timed. */
export class TurnTimer implements RequestTiming {
  readonly span: TurnSpan;
  private stepAt = 0;
  private reqAt = -1;
  private waitAt = -1;
  private lastAt = -1;
  private phases = { thinking: 0, writing: 0 };
  private lastPhase: Phase | null = null;

  constructor(
    private readonly run: RunTimer,
    n: number,
    at: number,
  ) {
    this.span = { n, at, pre: {}, attempts: 0, retryWaits: [], fallbacks: [], calls: 0 };
    this.stepAt = run.now();
  }

  /** Ends the step since the last one (or the turn's start) as `step`; the steps add up. */
  step(step: PreStep): void {
    const t = this.run.now();
    if (!PRE_STEPS.includes(step)) return;
    this.span.pre[step] = ms((this.span.pre[step] ?? 0) + (t - this.stepAt));
    this.stepAt = t;
  }

  attempt(): void {
    const t = this.run.now();
    if (this.reqAt < 0) {
      this.reqAt = t;
      this.span.requestAt = ms(t - this.run.start);
    }
    if (this.waitAt >= 0) {
      this.span.retryWaits.push(ms(t - this.waitAt));
      this.waitAt = -1;
    }
    this.span.attempts++;
    // The answering attempt's events count: what a failed one streamed was taken back
    this.span.firstEventMs = this.span.firstThinkingMs = this.span.firstTextMs = this.span.firstToolMs = this.span.lastEventMs = undefined;
    this.phases = { thinking: 0, writing: 0 };
    this.lastPhase = null;
    this.lastAt = -1;
  }

  retryWait(): void {
    this.waitAt = this.run.now();
  }

  fallback(kind: Fallback): void {
    if (FALLBACKS.has(kind)) this.span.fallbacks.push(kind);
  }

  event(): void {
    if (this.reqAt < 0) return;
    const rel = ms(this.run.now() - this.reqAt);
    if (this.span.firstEventMs === undefined) this.span.firstEventMs = rel;
    this.span.lastEventMs = rel;
  }

  toolDelta(): void {
    this.delta('writing', 'firstToolMs');
  }

  /** The agent's events as they pass (CompletionHost.emit): thinking and text deltas. */
  observe(type: string): void {
    if (type === 'thinking_delta') this.delta('thinking', 'firstThinkingMs');
    else if (type === 'text_delta') this.delta('writing', 'firstTextMs');
  }

  private delta(phase: Phase, first: 'firstThinkingMs' | 'firstTextMs' | 'firstToolMs'): void {
    if (this.reqAt < 0) return;
    const t = this.run.now();
    const rel = ms(t - this.reqAt);
    if (this.span[first] === undefined) this.span[first] = rel;
    if (this.span.firstEventMs === undefined) this.span.firstEventMs = rel;
    this.span.lastEventMs = rel;
    // The time up to a delta went into making it; the time before the first one was waiting
    if (this.lastAt >= 0) this.phases[phase] += t - this.lastAt;
    this.lastAt = t;
    this.lastPhase = phase;
  }

  usage(u: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
    this.span.promptTokens = num(u.promptTokens);
    this.span.completionTokens = num(u.completionTokens);
    this.span.cacheReadTokens = num(u.cacheReadTokens);
    this.span.cacheWriteTokens = num(u.cacheWriteTokens);
  }

  /** The reply is complete, or the request failed. */
  end(finish: Finish, calls = 0): void {
    if (this.reqAt < 0 || this.span.endMs !== undefined) return;
    const t = this.run.now();
    if (this.lastAt >= 0 && this.lastPhase) this.phases[this.lastPhase] += t - this.lastAt;
    const total = t - this.reqAt;
    this.span.endMs = ms(total);
    this.span.thinkingMs = ms(Math.min(total, this.phases.thinking));
    this.span.writingMs = ms(Math.min(total - this.span.thinkingMs, this.phases.writing));
    this.span.waitingMs = ms(total - this.span.thinkingMs - this.span.writingMs);
    this.span.finish = pick(FINISHES, finish, 'error');
    this.span.calls = num(calls) ?? 0;
    this.run.modelEnd();
  }

  /** A tool call of this turn's reply, its preparation starting now. */
  tool(name: string, group: number): ToolTimer {
    return this.run.addTool(new ToolTimer(this.run, this.span.n, group, toolLabel(name)));
  }

  /** The reply's calls ran in groups: one group's size and wall time. */
  group(group: number, size: number, wallMs: number): void {
    this.run.addGroup({ turn: this.span.n, group: num(group) ?? 0, size: num(size) ?? 0, wallMs: num(wallMs) ?? 0 });
  }
}

/** One tool call being timed. */
export class ToolTimer {
  readonly span: ToolSpan;
  private t0: number;
  private readyAt = -1;
  private runAt = -1;
  private permMs = 0;

  constructor(
    private readonly run: RunTimer,
    turn: number,
    group: number,
    name: string,
  ) {
    this.t0 = run.now();
    const at = ms(this.t0 - run.start);
    this.span = { turn, group: num(group) ?? 0, name, at, startAt: at, endAt: at, queueMs: 0, preHookMs: 0, permission: [], execMs: 0, postHookMs: 0, storeMs: 0, wallMs: 0, outcome: 'ok', alongside: 0 };
  }

  /** The group of its reply it ran in (agent/schedule.ts) */
  setGroup(group: number): void {
    this.span.group = num(group) ?? 0;
  }

  preHook(msSpent: number): void {
    this.span.preHookMs = ms(this.span.preHookMs + msSpent);
  }

  /** Prepared: from here until it runs is the queue. */
  ready(): void {
    this.readyAt = this.run.now();
  }

  /** The tool's run begins. */
  started(): void {
    const t = this.run.now();
    this.runAt = t;
    this.span.startAt = ms(t - this.run.start);
    if (this.readyAt >= 0) this.span.queueMs = ms(t - this.readyAt);
  }

  /** The tool's run ended. */
  ran(): void {
    if (this.runAt < 0) return;
    this.span.execMs = ms(this.run.now() - this.runAt - this.permMs);
  }

  /** A permission question begins: call the returned function with how it was settled. */
  permission(): PermissionProbe {
    return new PermissionProbe(this.run, (p) => {
      this.span.permission.push(p);
      this.permMs += p.ms;
    });
  }

  postHook(msSpent: number): void {
    this.span.postHookMs = ms(this.span.postHookMs + msSpent);
  }

  /** Done (post hooks included). */
  done(outcome: Outcome): void {
    const t = this.run.now();
    this.span.endAt = ms(t - this.run.start);
    if (this.runAt < 0) this.span.startAt = this.span.endAt;
    this.span.wallMs = ms(t - this.t0);
    this.span.outcome = pick(OUTCOMES, outcome, 'failed');
  }

  stored(msSpent: number): void {
    this.span.storeMs = ms(this.span.storeMs + msSpent);
  }
}

/** One permission question being timed (ToolTimer.permission). */
export class PermissionProbe {
  private t0: number;
  private humanAt = -1;
  private humanMs = 0;
  private checkAt = -1;
  private checkMs: number | undefined;
  private checkSaid: 'allow' | 'block' | 'error' | undefined;
  private timedOut = false;
  private settled = false;

  constructor(
    private readonly run: RunTimer,
    private readonly done: (p: PermissionSpan) => void,
  ) {
    this.t0 = run.now();
  }

  /** A card is on screen: the human's wait begins (a lane wait before it is not the human's). */
  cardShown(): void {
    this.humanAt = this.run.now();
  }

  cardAnswered(): void {
    if (this.humanAt < 0) return;
    this.humanMs += this.run.now() - this.humanAt;
  }

  checkStarted(): void {
    this.checkAt = this.run.now();
  }

  checkEnded(said: 'allow' | 'block' | 'error', timedOut = false): void {
    if (this.checkAt < 0) return;
    this.checkMs = this.run.now() - this.checkAt;
    this.checkSaid = said === 'allow' || said === 'block' ? said : 'error';
    this.timedOut = timedOut === true;
  }

  settle(path: PermissionPath, ok: boolean): void {
    if (this.settled) return;
    this.settled = true;
    const p: PermissionSpan = { path: pick(PATHS, path, 'rule'), ms: ms(this.run.now() - this.t0), ok: ok === true };
    if (this.humanAt >= 0) {
      p.humanMs = ms(this.humanMs);
      p.humanAt = ms(this.humanAt - this.run.start);
    }
    if (this.checkMs !== undefined) {
      p.checkMs = ms(this.checkMs);
      p.checkAt = ms(this.checkAt - this.run.start);
      p.check = this.checkSaid;
      if (this.timedOut) p.timedOut = true;
    }
    this.done(p);
  }
}

/** One run being timed: the agent makes one per run, its turns and tools hang off it. */
export class RunTimer {
  readonly start: number;
  readonly at: number;
  private turns: TurnTimer[] = [];
  private tools: ToolTimer[] = [];
  private groups: GroupSpan[] = [];
  private record: RunRecord | null = null;
  readonly id = shortId();

  constructor(
    private readonly info: { session: string; provider?: unknown; model?: unknown; mode?: unknown; limit?: unknown },
    private readonly clock: Clock = perfClock,
    epoch = Date.now(),
  ) {
    this.start = clock.now();
    this.at = epoch;
  }

  now(): number {
    return this.clock.now();
  }

  /** The provider and model become known once the run resolved them. */
  setModel(provider: unknown, model: unknown): void {
    this.info.provider = provider;
    this.info.model = model;
  }

  /** A new model turn: the harness begins on it now. */
  turn(): TurnTimer {
    const t = new TurnTimer(this, this.turns.length + 1, ms(this.now() - this.start));
    this.turns.push(t);
    return t;
  }

  /** @internal */
  addTool(t: ToolTimer): ToolTimer {
    this.tools.push(t);
    return t;
  }

  /** @internal */
  addGroup(g: GroupSpan): void {
    this.groups.push(g);
  }

  /** @internal a model turn ended */
  modelEnd(): void {
    /* the summary reads the spans */
  }

  /** The run ended: the record, summed up. */
  finish(end: string): RunRecord {
    if (this.record) return this.record;
    const wallMs = ms(this.now() - this.start);
    const tools = this.tools.map((t) => t.span);
    // How many others ran alongside each call (same reply, overlapping run)
    const byTurn = new Map<number, ToolSpan[]>();
    for (const t of tools) byTurn.set(t.turn, [...(byTurn.get(t.turn) ?? []), t]);
    for (const list of byTurn.values()) for (const a of list) a.alongside = list.filter((b) => b !== a && b.startAt < a.endAt && a.startAt < b.endAt && a.endAt > a.startAt && b.endAt > b.startAt).length;
    const record: RunRecord = {
      v: 1,
      at: this.at,
      session: /^[0-9a-f]{8}$/.test(this.info.session) ? this.info.session : 'unknown',
      run: this.id,
      provider: providerLabel(this.info.provider),
      model: modelLabel(this.info.model),
      mode: pick(MODES, this.info.mode, 'ask'),
      limit: num(this.info.limit) ?? 1,
      wallMs,
      end: pick(RUN_ENDS, end, 'error'),
      turns: this.turns.map((t) => t.span),
      tools,
      groups: [...this.groups],
      summary: undefined as unknown as RunSummary,
    };
    record.summary = summarize(record);
    this.record = record;
    return record;
  }
}

// ---------- Summing up ----------

type Interval = [number, number];

/** The length of the union of intervals. */
function unionLength(list: Interval[]): number {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: Interval | null = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** The parts of `list` that no interval of `minus` covers. */
function subtract(list: Interval[], minus: Interval[]): Interval[] {
  let out = list.filter(([a, b]) => b > a);
  for (const [ma, mb] of minus) {
    const next: Interval[] = [];
    for (const [a, b] of out) {
      if (mb <= a || ma >= b) next.push([a, b]);
      else {
        if (ma > a) next.push([a, ma]);
        if (mb < b) next.push([mb, b]);
      }
    }
    out = next;
  }
  return out;
}

/**
 * The run's time in parts that add up to its wall time: model turns (waiting, thinking, writing), the tool phases of
 * each reply less what the safety checks and the human took inside them (the human first where the two overlap), and
 * the rest (other). Calls that ran together are counted once.
 */
export function summarize(r: Pick<RunRecord, 'wallMs' | 'turns' | 'tools'>): RunSummary {
  let modelMs = 0;
  let waitingMs = 0;
  let thinkingMs = 0;
  let writingMs = 0;
  let retries = 0;
  let retryWaitMs = 0;
  let fallbacks = 0;
  let compactionMs = 0;
  let slowest: number | undefined;
  let slowestMs = -1;
  for (const t of r.turns) {
    modelMs += t.endMs ?? 0;
    waitingMs += t.waitingMs ?? 0;
    thinkingMs += t.thinkingMs ?? 0;
    writingMs += t.writingMs ?? 0;
    retries += t.retryWaits.length;
    retryWaitMs += t.retryWaits.reduce((a, b) => a + b, 0);
    fallbacks += t.fallbacks.length;
    compactionMs += t.pre.prune_compact ?? 0;
    const own = (t.requestAt !== undefined ? t.requestAt - t.at : 0) + (t.endMs ?? 0);
    if (own > slowestMs) {
      slowestMs = own;
      slowest = t.n;
    }
  }
  let toolsMs = 0;
  let checksMs = 0;
  let approvalsMs = 0;
  const byTurn = new Map<number, ToolSpan[]>();
  for (const s of r.tools) byTurn.set(s.turn, [...(byTurn.get(s.turn) ?? []), s]);
  for (const list of byTurn.values()) {
    // The reply's tool phase: from the first call's preparation to the last one's end
    const phase = unionLength(list.map((s) => [s.at, s.endAt + s.storeMs] as Interval));
    const human: Interval[] = [];
    const check: Interval[] = [];
    for (const s of list) {
      for (const p of s.permission) {
        if (p.humanAt !== undefined && p.humanMs) human.push([p.humanAt, p.humanAt + p.humanMs]);
        if (p.checkAt !== undefined && p.checkMs) check.push([p.checkAt, p.checkAt + p.checkMs]);
      }
    }
    const a = unionLength(human);
    const c = unionLength(subtract(check, human));
    approvalsMs += a;
    checksMs += c;
    toolsMs += Math.max(0, phase - a - c);
  }
  const otherMs = Math.max(0, r.wallMs - modelMs - toolsMs - checksMs - approvalsMs);
  return {
    wallMs: ms(r.wallMs),
    turns: r.turns.filter((t) => t.requestAt !== undefined).length,
    calls: r.tools.length,
    modelMs: ms(modelMs),
    waitingMs: ms(waitingMs),
    thinkingMs: ms(thinkingMs),
    writingMs: ms(writingMs),
    toolsMs: ms(toolsMs),
    checksMs: ms(checksMs),
    approvalsMs: ms(approvalsMs),
    otherMs: ms(otherMs),
    compactionMs: ms(compactionMs),
    retries,
    retryWaitMs: ms(retryWaitMs),
    fallbacks,
    slowest,
  };
}

// ---------- Words ----------

/** "9m 13s", "52s", "0.4s", "1h 02m". */
export function duration(msv: number): string {
  const v = Math.max(0, Math.round(msv));
  if (v < 1000) return `${(v / 1000).toFixed(1)}s`;
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "18k", "950", "1.2k". */
function tokens(n: number): string {
  if (n < 1000) return String(n);
  return n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/**
 * The run as two short lines (/timing, scripts/timing-report.js):
 * `9m 13s · model 7m 35s (27 turns: waiting 1m 10s, thinking 4m 20s, writing 2m 05s) · tools 52s · safety checks 25s · your approvals 12s · other 9s`
 * and the slowest turn.
 */
export function formatRun(r: Pick<RunRecord, 'summary' | 'turns'>): string {
  const s = r.summary;
  const parts = [
    duration(s.wallMs),
    `model ${duration(s.modelMs)} (${s.turns} turn${s.turns === 1 ? '' : 's'}: waiting ${duration(s.waitingMs)}, thinking ${duration(s.thinkingMs)}, writing ${duration(s.writingMs)})`,
    `tools ${duration(s.toolsMs)}${s.calls ? ` (${s.calls} call${s.calls === 1 ? '' : 's'})` : ''}`,
  ];
  if (s.checksMs) parts.push(`safety checks ${duration(s.checksMs)}`);
  if (s.approvalsMs) parts.push(`your approvals ${duration(s.approvalsMs)}`);
  parts.push(`other ${duration(s.otherMs)}${s.compactionMs >= 1000 ? ` (compaction ${duration(s.compactionMs)})` : ''}`);
  const lines = [parts.join(' · ')];
  const t = r.turns.find((x) => x.n === s.slowest);
  if (t && t.endMs !== undefined) {
    const before = t.requestAt !== undefined ? t.requestAt - t.at : 0;
    const bits = [`waiting ${duration(t.waitingMs ?? 0)}`];
    if (t.thinkingMs) bits.push(`thinking ${duration(t.thinkingMs)}`);
    if (t.writingMs) bits.push(`writing ${duration(t.writingMs)}`);
    if (t.retryWaits.length) bits.push(`${t.retryWaits.length} retr${t.retryWaits.length === 1 ? 'y' : 'ies'}`);
    if (t.fallbacks.length) bits.push(`fallback: ${t.fallbacks.join(', ')}`);
    if (before >= 1000) bits.push(`${duration(before)} before the request`);
    let line = `Slowest turn: #${t.n}, ${duration(before + t.endMs)} (${bits.join(', ')})`;
    if (t.promptTokens !== undefined) {
      const cached = t.cacheReadTokens !== undefined && t.promptTokens > 0 ? `, ${Math.round((t.cacheReadTokens / t.promptTokens) * 100)}% cached` : '';
      line += ` · ${tokens(t.promptTokens)} in${cached} · ${tokens(t.completionTokens ?? 0)} out`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------- The log file ----------

/** The log's size before it is rotated (the previous one is kept as timing.1.jsonl). */
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

/** Whether the file log is on: SILO_TIMING=1 in the environment, or the timingLog setting. */
export function timingLogOn(cfg: { timingLog?: unknown } | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SILO_TIMING === '1' || cfg?.timingLog === true;
}

/** JSON lines in <profile>/timing/timing.jsonl, size-capped and rotated; written in order, off the run's path. */
export class TimingLog {
  private chain: Promise<void> = Promise.resolve();
  readonly file: string;

  constructor(
    dir: string,
    private readonly maxBytes = LOG_MAX_BYTES,
  ) {
    this.file = path.join(dir, 'timing.jsonl');
  }

  append(record: RunRecord): Promise<void> {
    const line = JSON.stringify(record) + '\n';
    this.chain = this.chain.then(() => this.write(line)).catch((err: unknown) => console.warn('[timing] could not write the log:', err instanceof Error ? err.message : String(err)));
    return this.chain;
  }

  private async write(line: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const size = await fs.promises.stat(this.file).then((s) => s.size, () => 0);
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) await fs.promises.rename(this.file, path.join(path.dirname(this.file), 'timing.1.jsonl'));
    await fs.promises.appendFile(this.file, line, { mode: 0o600 });
  }
}
