// What a session has cost, in dollars: every model call the app makes for it (the agent's turns, Auto mode's safety
// checks, the title, a compaction summary, a merge summary) adds its tokens to the session's running totals
// (Session.cost), kept with the session so they survive a restart. The dollars are worked out from those totals
// whenever they are shown, with the prices in force then: the user's own (`prices` in settings.json) or, for a call
// to Anthropic's own API, the built-in table below. No network request is ever made for prices. When one call of the
// session has no known price there is no figure at all: a partial sum would understate. Nothing here reaches a model.

import type { AppConfig, ModelPrice } from '../shared/types';
import type { Usage } from './ollama';
import { resolveProvider } from './providers';

/** Dollars per million tokens. cacheWrite: a five-minute cache write; cacheWrite1h: a one-hour one. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

/** A model of the built-in table: its rates, and the higher rates of a request whose prompt is over `long.over` tokens. */
export interface TableEntry extends Rates {
  id: string;
  long?: Rates & { over: number };
}

export const PRICES_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRICES_DATE = '2026-11-10';

const r = (input: number, cacheWrite: number, cacheWrite1h: number, cacheRead: number, output: number): Rates => ({ input, cacheWrite, cacheWrite1h, cacheRead, output });

/**
 * Anthropic's list prices, read from https://platform.claude.com/docs/en/about-claude/pricing on 2026-11-10 ("Model
 * pricing": base input, 5m cache writes, 1h cache writes, cache hits, output). Used only for a call to Anthropic's own
 * API. Claude Haiku 5.5 "is priced by prompt length": a request whose prompt (all of its input tokens, cache reads and
 * writes included) is over 100,000 tokens pays the second set of rates. Retired models (Opus 4.1, Opus 4, Sonnet 4)
 * are left out. The ids follow the page's model ID format (claude-{name}-{major}[-{minor}], with a -YYYYMMDD
 * snapshot before the 4.6 generation, which is stripped before the lookup).
 */
export const PRICE_TABLE: TableEntry[] = [
  { id: 'claude-fable-5-2', ...r(8, 10, 16, 0.2, 40) },
  { id: 'claude-mythos-5-2', ...r(8, 10, 16, 0.2, 40) },
  { id: 'claude-fable-5-1', ...r(10, 12.5, 20, 0.25, 50) },
  { id: 'claude-mythos-5-1', ...r(10, 12.5, 20, 0.25, 50) },
  { id: 'claude-fable-5', ...r(10, 12.5, 20, 1, 50) },
  { id: 'claude-mythos-5', ...r(10, 12.5, 20, 1, 50) },
  { id: 'claude-opus-5-5', ...r(4, 5, 8, 0.2, 20) },
  { id: 'claude-opus-5', ...r(5, 6.25, 10, 0.5, 25) },
  { id: 'claude-opus-4-8', ...r(5, 6.25, 10, 0.5, 25) },
  { id: 'claude-opus-4-7', ...r(5, 6.25, 10, 0.5, 25) },
  { id: 'claude-opus-4-6', ...r(5, 6.25, 10, 0.5, 25) },
  { id: 'claude-opus-4-5', ...r(5, 6.25, 10, 0.5, 25) },
  { id: 'claude-sonnet-5-5', ...r(2, 2.5, 4, 0.1, 10) },
  { id: 'claude-sonnet-5', ...r(2, 2.5, 4, 0.2, 10) },
  { id: 'claude-sonnet-4-6', ...r(3, 3.75, 6, 0.3, 15) },
  { id: 'claude-sonnet-4-5', ...r(3, 3.75, 6, 0.3, 15) },
  { id: 'claude-haiku-5-5', ...r(0.1, 0.125, 0.2, 0.01, 0.5), long: { over: 100_000, ...r(0.5, 0.625, 1, 0.05, 2.5) } },
  { id: 'claude-haiku-4-5', ...r(1, 1.25, 2, 0.1, 5) },
];

/** The table's entry for a model id ("claude-haiku-4-5-20251001" finds claude-haiku-4-5), if it has one. */
export function tableEntry(model: string): TableEntry | undefined {
  const id = String(model ?? '').trim().toLowerCase().replace(/-\d{8}$/, '');
  return PRICE_TABLE.find((e) => e.id === id);
}

/** Who made a call: the model, and whether it went to Anthropic's own API (the only place the table applies). */
export interface CallSource {
  model: string;
  anthropic: boolean;
}

/** The source of a call made with a config's provider (and `model` when the call names its own). */
export function callSource(cfg: AppConfig, model?: string): CallSource {
  try {
    const p = resolveProvider(cfg);
    let anthropic = false;
    try {
      anthropic = new URL(p.baseURL).hostname === 'api.anthropic.com';
    } catch {
      /* no usable base URL: not Anthropic's API */
    }
    return { model: model || p.model, anthropic };
  } catch {
    return { model: model || '', anthropic: false };
  }
}

/** One model's tokens, summed over the calls of a session that fell in the same price bracket. */
export interface CostBucket {
  model: string;
  /** The calls went to Anthropic's own API */
  anthropic?: true;
  /** The calls were over the table's price step for the model (Claude Haiku 5.5: prompts over 100K tokens) */
  long?: true;
  calls: number;
  /** Input tokens neither read from nor written to the prompt cache */
  input: number;
  cacheRead: number;
  /** Five-minute cache writes */
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}

/** Session.cost: the running totals, since when they are kept, and whether the session had calls before that. */
export interface SessionCost {
  since: number;
  /** The session had model calls before its cost was kept (it is older than this feature): they are not counted */
  partial?: true;
  buckets: CostBucket[];
}

/** A call's tokens split the way they are priced: of the prompt, cache reads and writes apart from the rest. */
export function splitUsage(u: Usage): Pick<CostBucket, 'input' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h' | 'output'> {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const prompt = n(u.promptTokens);
  const read = Math.min(n(u.cacheReadTokens), prompt);
  const write = Math.min(n(u.cacheWriteTokens), prompt - read);
  const hour = Math.min(n(u.cacheWrite1hTokens), write);
  return { input: prompt - read - write, cacheRead: read, cacheWrite: write - hour, cacheWrite1h: hour, output: n(u.completionTokens) };
}

/** Adds one call to the totals (made when missing). `before`: the session already had model calls before this one. */
export function addCall(cost: SessionCost | undefined, src: CallSource, u: Usage, opts: { now?: number; before?: boolean } = {}): SessionCost {
  const out: SessionCost = cost ?? { since: opts.now ?? Date.now(), buckets: [], ...(opts.before ? { partial: true as const } : {}) };
  const step = tableEntry(src.model)?.long;
  const long = Boolean(step && (Number(u.promptTokens) || 0) > step.over);
  let b = out.buckets.find((x) => x.model === src.model && !!x.anthropic === src.anthropic && !!x.long === long);
  if (!b) {
    b = { model: src.model, ...(src.anthropic ? { anthropic: true as const } : {}), ...(long ? { long: true as const } : {}), calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 };
    out.buckets.push(b);
  }
  const t = splitUsage(u);
  b.calls++;
  b.input += t.input;
  b.cacheRead += t.cacheRead;
  b.cacheWrite += t.cacheWrite;
  b.cacheWrite1h += t.cacheWrite1h;
  b.output += t.output;
  return out;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** A user-set price as rates: cacheRead and cacheWrite default to the input price; a one-hour write costs cacheWrite. */
export function userRates(p: ModelPrice | undefined): Rates | null {
  if (!p || typeof p !== 'object') return null;
  const input = num(p.input);
  const output = num(p.output);
  if (input === undefined || output === undefined) return null;
  const cacheWrite = num(p.cacheWrite) ?? input;
  return { input, output, cacheRead: num(p.cacheRead) ?? input, cacheWrite, cacheWrite1h: cacheWrite };
}

/** The rates a bucket is priced at: the user's price for its model, else the table's (Anthropic's API only), else null. */
export function ratesFor(b: Pick<CostBucket, 'model' | 'anthropic' | 'long'>, prices: AppConfig['prices']): Rates | null {
  const own = prices && Object.prototype.hasOwnProperty.call(prices, b.model) ? userRates(prices[b.model]) : null;
  if (own) return own;
  if (!b.anthropic) return null;
  const e = tableEntry(b.model);
  if (!e) return null;
  return b.long && e.long ? e.long : e;
}

/** Dollars for some tokens at some rates. */
export function dollars(t: Pick<CostBucket, 'input' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h' | 'output'>, p: Rates): number {
  return (t.input * p.input + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite + t.cacheWrite1h * p.cacheWrite1h + t.output * p.output) / 1e6;
}

/** The dollars of one call on its own (the price step applies per request). Null without a price. */
export function callCost(src: CallSource, u: Usage, prices?: AppConfig['prices']): number | null {
  const one = addCall(undefined, src, u, { now: 0 }).buckets[0];
  const p = ratesFor(one, prices);
  return p ? dollars(one, p) : null;
}

export interface CostSummary {
  /** The estimate; undefined when there is nothing counted or a model has no price */
  usd?: number;
  /** Models of the session with no known price */
  unpriced: string[];
  calls: number;
  input: number;
  cacheRead: number;
  /** Cache writes, five-minute and one-hour together */
  cacheWrite: number;
  output: number;
}

/** The session's totals priced now. */
export function summarize(cost: SessionCost | undefined, prices: AppConfig['prices']): CostSummary {
  const out: CostSummary = { unpriced: [], calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let usd = 0;
  for (const b of cost?.buckets ?? []) {
    if (!b.calls) continue;
    out.calls += b.calls;
    out.input += b.input;
    out.cacheRead += b.cacheRead;
    out.cacheWrite += b.cacheWrite + b.cacheWrite1h;
    out.output += b.output;
    const p = ratesFor(b, prices);
    if (p) usd += dollars(b, p);
    else if (!out.unpriced.includes(b.model || '(no model)')) out.unpriced.push(b.model || '(no model)');
  }
  if (out.calls && !out.unpriced.length) out.usd = usd;
  return out;
}

/** "$0.04", "<$0.01" under a cent, "$12.30", "$1,234.50"; "$0.00" for nothing at all (a model priced at zero). */
export function formatUsd(usd: number): string {
  if (!(usd > 0)) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The `cost` event for a session's totals: the figure, or nothing when there is none. */
export function costEvent(cost: SessionCost | undefined, prices: AppConfig['prices']): { type: 'cost'; usd?: number; label?: string } {
  const s = summarize(cost, prices);
  return s.usd === undefined ? { type: 'cost' } : { type: 'cost', usd: s.usd, label: formatUsd(s.usd) };
}

/** The session parts this needs (the store's Session has them). */
export interface Costed {
  cost?: SessionCost;
  messages: { role: string }[];
  seedLength?: number;
}

/**
 * Counts one call for a session: adds it to the totals and returns the `cost` event to put on its stream. The totals
 * are written with the session's next save (each run, compaction, title and merge ends with one), not here: a save
 * of its own would add a snapshot to the history log for every call. A session older than this feature, which made
 * calls before, is marked partial.
 */
export function chargeSession(s: Costed, src: CallSource, u: Usage, cfg: Pick<AppConfig, 'prices'>): { type: 'cost'; usd?: number; label?: string } {
  const before = !s.cost && s.messages.slice(s.seedLength ?? 0).some((m) => m.role === 'assistant');
  s.cost = addCall(s.cost, src, u, { before });
  return costEvent(s.cost, cfg.prices);
}

/** What /cost says counts. */
export const COUNTED = "Counts the agent's turns, Auto mode's checks, the title, compaction and merge summaries. Not counted: mods' model calls, Settings' provider test, and calls whose provider reports no tokens.";

const n0 = (n: number) => Math.round(n).toLocaleString('en-US');

/** The /cost note: the tokens, the dollars (or why there are none) and what is counted. */
export function costNote(cost: SessionCost | undefined, prices: AppConfig['prices']): string {
  const s = summarize(cost, prices);
  if (!s.calls) return `No model calls counted in this session yet.\n${COUNTED}`;
  const lines = [
    s.usd !== undefined ? `${formatUsd(s.usd)}, estimated from list prices (the provider's bill is the truth).` : `No dollar figure: no price for ${s.unpriced.join(', ')}. Set one under "prices" in settings.json.`,
    `${n0(s.input)} uncached input · ${n0(s.cacheRead)} cached · ${n0(s.cacheWrite)} cache write · ${n0(s.output)} output tokens · ${s.calls} call${s.calls === 1 ? '' : 's'}`,
  ];
  if (cost?.partial) lines.push(`Counted since ${new Date(cost.since).toISOString().slice(0, 10)}; earlier calls were not kept.`);
  lines.push(COUNTED);
  return lines.join('\n');
}
