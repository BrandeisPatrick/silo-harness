// The session report (/report in the window, scripts/session-report.js outside the app): where a session's time went,
// read from its history log (history/log.ts) and written as numbers and fixed words only, so it is safe to paste to
// someone else. Markdown, light: a bold label per section and a list under it.
//
// What it reads of a record, and nothing else: its type, time and sequence number; a tool end's durationMs, ok and
// chars; the token counts of a usage record and of a compaction; a tool's name, only through toolLabel (agent/perf.ts:
// a built-in name, "mcp" or "other"); a message's role; a run's origin and end reason, each through a fixed list; and
// the numbers and fixed words of the records written for it (retry, check, question.*, compaction.start, run.start's
// timing). An approval's id pairs a card with its answer and is dropped once paired. Message text, arguments,
// commands, paths, URLs, titles, provider and account names are never read, so they cannot reach the output.
//
// Pure: no file access, and no clock but the `now` passed in. A log written by 0.17.0 works (what it lacks reads
// "not recorded"), and so does any list of records: broken ones are skipped.

import { duration, toolLabel } from '../agent/perf';

/** One record, as much of it as the report keeps. */
interface Step {
  t: number;
  seq: number;
  kind: Kind;
  /** A tool's label (toolLabel) */
  tool?: string;
  /** A tool's own time, a check's, a thinking block's */
  ms?: number;
  ok?: boolean;
  /** An approval card's id, only to pair the card with its answer */
  pair?: string;
  /** run.start: the origin's words; run.end: the reason's words */
  word?: string;
  /** run.start written by a version that records checks and retries (it carries the timing id) */
  marked?: boolean;
  prompt?: number;
  completion?: number;
  cacheRead?: number;
  before?: number;
  after?: number;
  verdict?: string;
  timedOut?: boolean;
  waitMs?: number;
  ranMs?: number;
  fail?: string;
  answered?: boolean;
}

type Kind =
  | 'run.start'
  | 'run.end'
  | 'user'
  | 'reply'
  | 'result'
  | 'message'
  | 'usage'
  | 'tool.start'
  | 'tool.end'
  | 'approval.request'
  | 'approval.resolved'
  | 'question.request'
  | 'question.resolved'
  | 'check'
  | 'retry'
  | 'compaction.start'
  | 'compaction'
  | 'thinking'
  | 'notice'
  | 'error'
  | 'save'
  | 'replace'
  | 'rewind'
  | 'session'
  | 'other';

/** Where a run's message came from, in the report's words */
const ORIGINS: Record<string, string> = {
  user: 'your message',
  queue: 'queued message',
  schedule: 'schedule',
  session: 'another session',
  remote: 'phone',
  mod: 'mod',
  command: 'command',
  dream: 'dream',
};
/** How a run ended, in the report's words ("done" says nothing) */
const REASONS: Record<string, string> = {
  done: '',
  aborted: 'stopped',
  max_turns: 'turn limit',
  error: 'error',
  plan: 'plan',
  loop: 'repeated call',
  interrupted: 'app closed',
};
const VERDICTS = ['allow', 'block', 'ask', 'error', 'stopped'];
const FAIL_KINDS = ['idle', 'connection', 'rate_limited', 'busy', 'too_long', 'other'];
const FAIL_WORDS: Record<string, string> = { idle: 'no data', connection: 'connection', rate_limited: 'rate limited', busy: 'busy', too_long: 'too long', other: 'other' };

const has = (o: Record<string, string>, k: unknown): k is string => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
/** A count or duration: a finite number of 0 or more; else undefined */
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const oneOf = (list: string[], v: unknown, dflt: string): string => (typeof v === 'string' && list.includes(v) ? v : dflt);

/** What the report keeps of one record, or null for one it cannot read. */
function slim(r: unknown): Step | null {
  if (!r || typeof r !== 'object') return null;
  const rec = r as { t?: unknown; seq?: unknown; type?: unknown; data?: unknown };
  if (typeof rec.t !== 'number' || !Number.isFinite(rec.t) || typeof rec.type !== 'string') return null;
  const d = (rec.data && typeof rec.data === 'object' ? rec.data : {}) as Record<string, unknown>;
  const s = (kind: Kind, extra: Partial<Step> = {}): Step => ({ t: rec.t as number, seq: typeof rec.seq === 'number' ? rec.seq : 0, kind, ...extra });
  switch (rec.type) {
    case 'run.start':
      return s('run.start', { word: has(ORIGINS, d.origin) ? ORIGINS[d.origin] : 'other', marked: typeof d.timing === 'string' && /^[0-9a-f]{8}$/.test(d.timing) });
    case 'run.end':
      return s('run.end', { word: has(REASONS, d.reason) ? REASONS[d.reason] : 'other' });
    case 'message.append': {
      const role = d.message && typeof d.message === 'object' ? (d.message as { role?: unknown }).role : undefined;
      return s(role === 'user' ? 'user' : role === 'assistant' ? 'reply' : role === 'tool' ? 'result' : 'message');
    }
    case 'usage':
      return s('usage', { prompt: num(d.promptTokens), completion: num(d.completionTokens), cacheRead: num(d.cacheReadTokens) });
    case 'tool.start':
      return s('tool.start', { tool: toolLabel(d.name as string) });
    case 'tool.end':
      return s('tool.end', { tool: toolLabel(d.name as string), ms: num(d.durationMs), ok: d.ok !== false });
    case 'approval.request':
      return s('approval.request', { pair: typeof d.id === 'string' ? d.id : undefined });
    case 'approval.resolved':
      return s('approval.resolved', { pair: typeof d.id === 'string' ? d.id : undefined });
    case 'question.request':
      return s('question.request');
    case 'question.resolved':
      return s('question.resolved', { answered: d.outcome === 'answered' });
    case 'check':
      return s('check', { ms: num(d.ms), verdict: oneOf(VERDICTS, d.verdict, 'error'), timedOut: d.timedOut === true });
    case 'retry':
      return s('retry', { waitMs: num(d.waitMs), ranMs: num(d.ranMs), fail: oneOf(FAIL_KINDS, d.kind, 'other') });
    case 'compaction.start':
      return s('compaction.start');
    case 'compaction':
      return s('compaction', { before: num(d.tokensBefore), after: num(d.tokensAfter) });
    case 'thinking':
      return s('thinking', { ms: num(d.ms) });
    case 'notice':
      return s('notice');
    case 'error':
      return s('error');
    case 'snapshot':
      return s('save');
    case 'messages.replace':
      return s('replace');
    case 'messages.truncate':
      return s('rewind');
    default:
      return s(rec.type.startsWith('session.') ? 'session' : 'other');
  }
}

/** A step in the fixed words of the stretches list. */
function words(st: Step | undefined): string {
  if (!st) return 'now';
  const tool = (label: string | undefined) => (label === 'mcp' ? 'MCP tool' : label === 'other' || !label ? 'other tool' : `tool ${label}`);
  switch (st.kind) {
    case 'run.start':
      return 'start of turn';
    case 'run.end':
      return 'end of turn';
    case 'user':
      return 'user message';
    case 'reply':
    case 'usage':
      return 'model reply';
    case 'result':
      return 'tool result';
    case 'message':
      return 'message';
    case 'tool.start':
      return tool(st.tool);
    case 'tool.end':
      return `${tool(st.tool)} done`;
    case 'approval.request':
      return 'approval card';
    case 'approval.resolved':
      return 'your approval';
    case 'question.request':
      return 'question card';
    case 'question.resolved':
      return 'your answer';
    case 'check':
      return 'safety check';
    case 'retry':
      return 'retry';
    case 'compaction.start':
      return 'compaction start';
    case 'compaction':
      return 'compaction';
    case 'thinking':
      return 'thinking';
    case 'notice':
      return 'notice';
    case 'error':
      return 'error';
    case 'save':
      return 'session saved';
    case 'replace':
      return 'messages replaced';
    case 'rewind':
      return 'rewind';
    case 'session':
      return 'session change';
    default:
      return 'other record';
  }
}

/** "18k", "950", "1.2k", "6.4M" */
function tok(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 10_000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
function median(list: number[]): number {
  const s = [...list].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Run {
  n: number;
  start: number;
  end: number;
  origin: string;
  /** How it ended, in words ('' for done, 'in progress' for the open one) */
  how: string;
  marked: boolean;
  /** Its steps, run.start and run.end included */
  steps: Step[];
}

export interface ReportOptions {
  /** The time now (epoch ms), when the session may still be running: an open turn counts up to it */
  now?: number;
}

/** How many of the longest stretches, model calls and compactions are listed */
const LONGEST = 5;
const SLOWEST_CALLS = 3;

/**
 * The report for one session's records (HistoryRecord[], or anything: what is not a record is skipped), as Markdown
 * text of numbers and fixed words.
 */
export function sessionReport(records: readonly unknown[], opts: ReportOptions = {}): string {
  const steps = (Array.isArray(records) ? records : [])
    .map(slim)
    .filter((x): x is Step => !!x)
    .sort((a, b) => a.t - b.t || a.seq - b.seq);
  const out: string[] = ['**Session report** · numbers only, no content'];
  if (!steps.length) {
    out.push('', 'Nothing recorded for this session yet.');
    return out.join('\n');
  }
  const now = num(opts.now);

  // ---------- Turns ----------
  const runs: Run[] = [];
  let open: Run | null = null;
  const close = (end: number, why: string) => {
    if (!open) return;
    open.end = Math.max(open.start, end);
    open.how = why;
    runs.push(open);
    open = null;
  };
  for (const [i, st] of steps.entries()) {
    if (st.kind === 'run.start') {
      // A run that never ended (the app was killed and the log not recovered) ends at its last record
      if (open) close(steps[i - 1]?.t ?? st.t, 'unfinished');
      open = { n: runs.length + 1, start: st.t, end: st.t, origin: st.word ?? 'other', how: '', marked: st.marked === true, steps: [st] };
      continue;
    }
    if (!open) continue;
    const cur: Run = open;
    if (st.kind === 'run.end') {
      // Recovery writes "interrupted" when the app starts again: the run ended at its last record before that
      const interrupted = st.word === 'app closed';
      const end = interrupted ? (cur.steps[cur.steps.length - 1]?.t ?? st.t) : st.t;
      if (!interrupted) cur.steps.push(st);
      close(end, st.word ?? '');
      continue;
    }
    cur.steps.push(st);
  }
  if (open) {
    const cur: Run = open;
    const last = cur.steps[cur.steps.length - 1].t;
    close(now !== undefined && now > last ? now : last, 'in progress');
  }
  const working = sum(runs.map((r) => r.end - r.start));
  const span = steps[steps.length - 1].t - steps[0].t;
  out.push('');
  if (!runs.length) out.push(`**Time** no turn recorded; the log spans ${duration(span)}`);
  else {
    out.push(`**Time** ${duration(working)} working in ${plural(runs.length, 'turn')}${span > working + 60_000 ? `, over ${duration(span)}` : ''}`);
    const turnLine = (r: Run) => `- turn ${r.n}, ${r.origin}: ${duration(r.end - r.start)}${r.how ? `, ${r.how}` : ''}`;
    if (runs.length <= 12) for (const r of runs) out.push(turnLine(r));
    else {
      out.push(`- the ${Math.min(10, runs.length)} longest:`);
      for (const r of [...runs].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 10).sort((a, b) => a.n - b.n)) out.push(turnLine(r));
    }
  }

  // ---------- Model calls: the gap before each usage record ----------
  // Measured from the record before it that is not a retry, a notice or an error (those come while the call goes on)
  const calls: { n: number; ms: number }[] = [];
  for (const [i, st] of steps.entries()) {
    if (st.kind !== 'usage') continue;
    let j = i - 1;
    while (j >= 0 && (steps[j].kind === 'retry' || steps[j].kind === 'notice' || steps[j].kind === 'error')) j--;
    if (j >= 0) calls.push({ n: calls.length + 1, ms: st.t - steps[j].t });
  }
  out.push('');
  if (!calls.length) out.push('**Model calls** none recorded');
  else {
    const list = calls.map((c) => c.ms);
    out.push(`**Model calls** ${calls.length}, ${duration(sum(list))} in all, median ${duration(median(list))}`);
    const slow = [...calls].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_CALLS);
    out.push(`- slowest: ${slow.map((c) => `call ${c.n} ${duration(c.ms)}`).join(', ')}`);
  }

  // ---------- Tool calls by tool (ask_user's time is the user's, below) ----------
  const tools = new Map<string, { n: number; ms: number; max: number; failed: number }>();
  const askUserMs: number[] = [];
  for (const st of steps) {
    if (st.kind !== 'tool.end') continue;
    const label = st.tool ?? 'other';
    const ms = st.ms ?? 0;
    if (label === 'ask_user') askUserMs.push(ms);
    const t = tools.get(label) ?? { n: 0, ms: 0, max: 0, failed: 0 };
    t.n++;
    if (label !== 'ask_user') {
      t.ms += ms;
      t.max = Math.max(t.max, ms);
    }
    if (st.ok === false) t.failed++;
    tools.set(label, t);
  }
  out.push('');
  if (!tools.size) out.push('**Tool calls** none');
  else {
    const all = [...tools.values()];
    out.push(`**Tool calls** ${sum(all.map((t) => t.n))}, ${duration(sum(all.map((t) => t.ms)))} of their own work (approvals and checks not included)`);
    const name = (label: string) => (label === 'mcp' ? 'MCP tools' : label === 'other' ? 'other tools' : label);
    for (const [label, t] of [...tools].sort((a, b) => b[1].ms - a[1].ms || b[1].n - a[1].n)) {
      const bits = [`${t.n}`];
      if (label === 'ask_user') bits.push('time under Waiting on you');
      else {
        bits.push(duration(t.ms));
        if (t.n > 1) bits.push(`slowest ${duration(t.max)}`);
      }
      if (t.failed) bits.push(`${t.failed} failed`);
      out.push(`- ${name(label)}: ${bits.join(', ')}`);
    }
  }

  // ---------- Waiting on the user ----------
  const cards: number[] = [];
  const openCards = new Map<string, number>();
  const questions: number[] = [];
  let questionAt = -1;
  let questionRecords = false;
  for (const st of steps) {
    if (st.kind === 'approval.request' && st.pair) openCards.set(st.pair, st.t);
    else if (st.kind === 'approval.resolved' && st.pair && openCards.has(st.pair)) {
      cards.push(st.t - openCards.get(st.pair)!);
      openCards.delete(st.pair);
    } else if (st.kind === 'question.request') {
      questionRecords = true;
      questionAt = st.t;
    } else if (st.kind === 'question.resolved' && questionAt >= 0) {
      questions.push(st.t - questionAt);
      questionAt = -1;
    }
  }
  openCards.clear();
  // A log from before the question records: ask_user's own time is the wait for the answer
  const asked = questionRecords ? questions : askUserMs;
  out.push('');
  out.push(`**Waiting on you** ${duration(sum(cards) + sum(asked))}`);
  out.push(`- approval cards: ${cards.length ? `${cards.length}, ${duration(sum(cards))}${cards.length > 1 ? `, longest ${duration(Math.max(...cards))}` : ''}` : 'none'}`);
  out.push(`- questions: ${asked.length ? `${asked.length}, ${duration(sum(asked))}${questionRecords ? '' : ' (from the ask_user calls)'}` : 'none'}`);

  // ---------- Safety checks and retries: recorded only by newer versions ----------
  const marked = runs.filter((r) => r.marked).length;
  const partly = marked > 0 && marked < runs.length ? ` (recorded in ${marked} of ${runs.length} turns)` : '';
  const checks = steps.filter((s) => s.kind === 'check');
  const retries = steps.filter((s) => s.kind === 'retry');
  out.push('');
  if (!marked && !checks.length) out.push('**Safety checks** not recorded');
  else if (!checks.length) out.push(`**Safety checks** none${partly}`);
  else {
    const ms = checks.map((c) => c.ms ?? 0);
    const by = VERDICTS.map((v) => [v, checks.filter((c) => c.verdict === v).length] as const).filter(([, n]) => n);
    const timedOut = checks.filter((c) => c.timedOut).length;
    out.push(`**Safety checks** ${checks.length}, ${duration(sum(ms))} in all, slowest ${duration(Math.max(...ms))}${partly}`);
    out.push(`- ${by.map(([v, n]) => `${v} ${n}`).join(', ')}${timedOut ? `; ${timedOut} timed out` : ''}`);
  }
  if (!marked && !retries.length) out.push('', '**Retries** not recorded');
  else if (!retries.length) out.push('', `**Retries** none${partly}`);
  else {
    const kinds = FAIL_KINDS.map((k) => [k, retries.filter((r) => r.fail === k).length] as const).filter(([, n]) => n);
    const longest = retries.reduce((a, b) => ((b.ranMs ?? 0) > (a.ranMs ?? 0) ? b : a));
    out.push('', `**Retries** ${retries.length}, ${duration(sum(retries.map((r) => r.waitMs ?? 0)))} waiting before them${partly}`);
    out.push(`- why: ${kinds.map(([k, n]) => `${FAIL_WORDS[k]} ${n}`).join(', ')}`);
    if ((longest.ranMs ?? 0) >= 1000) out.push(`- longest failed attempt: ${duration(longest.ranMs ?? 0)} (${FAIL_WORDS[longest.fail ?? 'other']})`);
  }

  // ---------- The longest stretches with no record, inside turns ----------
  const gaps: { ms: number; turn: number; at: number; before: Step; after?: Step }[] = [];
  for (const r of runs) {
    for (let i = 1; i < r.steps.length; i++) gaps.push({ ms: r.steps[i].t - r.steps[i - 1].t, turn: r.n, at: r.steps[i - 1].t - r.start, before: r.steps[i - 1], after: r.steps[i] });
    // The open turn: from its last record to now
    const last = r.steps[r.steps.length - 1];
    if (r.how === 'in progress' && r.end > last.t) gaps.push({ ms: r.end - last.t, turn: r.n, at: last.t - r.start, before: last });
  }
  const longest = gaps
    .filter((g) => g.ms >= 1000)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, LONGEST);
  out.push('');
  if (!longest.length) out.push('**Longest stretches with no record** none over 1s');
  else {
    out.push('**Longest stretches with no record**');
    for (const g of longest) out.push(`- ${duration(g.ms)} in turn ${g.turn}${g.at >= 1000 ? `, ${duration(g.at)} in` : ''}: after ${words(g.before)}, before ${g.after ? words(g.after) : 'now (still running)'}`);
  }

  // ---------- Tokens per model call ----------
  const usage = steps.filter((s) => s.kind === 'usage');
  out.push('');
  if (!usage.length) out.push('**Tokens per model call** none recorded');
  else {
    const ins = usage.map((u) => u.prompt ?? 0);
    const outs = usage.map((u) => u.completion ?? 0);
    const read = usage.filter((u) => u.cacheRead !== undefined);
    const cached = read.length && sum(ins) > 0 ? `, ${Math.round((sum(read.map((u) => u.cacheRead ?? 0)) / sum(ins)) * 100)}% read from cache` : '';
    const line = (list: number[]) => `${tok(Math.min(...list))} min, ${tok(median(list))} median, ${tok(Math.max(...list))} max, ${tok(sum(list))} total`;
    out.push(`**Tokens per model call** ${usage.length} ${usage.length === 1 ? 'call' : 'calls'}`);
    out.push(`- input: ${line(ins)}${cached}`);
    out.push(`- output: ${line(outs)}`);
  }

  // ---------- Compactions ----------
  const compactions: { before?: number; after?: number; ms?: number }[] = [];
  let unfinished = 0;
  let startAt = -1;
  for (const st of steps) {
    if (st.kind === 'compaction.start') {
      if (startAt >= 0) unfinished++;
      startAt = st.t;
    } else if (st.kind === 'compaction') {
      compactions.push({ before: st.before, after: st.after, ...(startAt >= 0 ? { ms: st.t - startAt } : {}) });
      startAt = -1;
    } else if (st.kind === 'run.end' && startAt >= 0) {
      unfinished++;
      startAt = -1;
    }
  }
  out.push('');
  if (!compactions.length && !unfinished) out.push('**Compactions** none');
  else {
    out.push(`**Compactions** ${compactions.length}${unfinished ? `, and ${plural(unfinished, 'start')} that did not finish` : ''}`);
    for (const c of compactions.slice(-LONGEST)) {
      const tokens = c.before !== undefined && c.after !== undefined ? `${tok(c.before)} → ${tok(c.after)} tokens` : 'tokens not recorded';
      out.push(`- ${tokens}, ${c.ms !== undefined ? duration(c.ms) : 'time not recorded'}`);
    }
    if (compactions.length > LONGEST) out.push(`- (the last ${LONGEST} shown)`);
  }
  return out.join('\n');
}
