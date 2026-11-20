// Settings → Models, its pure pieces: the state line of each provider, the list of models a group shows (the marked
// ones first, a filter, the first few until "Show all"), the words of a test result and the safety check's choices.
// Nothing here touches the DOM or imports at run time, so the headless suite (test/settings-page.js) loads the
// compiled file directly.

import type { ProviderView } from '../../shared/types';
import type { ProviderCatalog, ProviderTestInfo } from '../../shared/providers';

/** How many models a group shows before "Show all" */
export const MODELS_SHOWN = 8;
/** How many matches a filter shows before asking for a narrower one */
export const MATCHES_SHOWN = 50;

export type StateTone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface ProviderState {
  tone: StateTone;
  /** "Ready", "No key found", "Not reachable", "Checking…", "Can't list models" */
  label: string;
  /** One line under the head, in plain words ('' for none) */
  detail: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * A provider's state in plain words: ready; no key found, naming the variable; not reachable; or that it could not
 * list its models (its own are shown). A problem is in colour only for the provider in use (`inUse`): an Ollama that
 * is not running is no news to someone who never uses it.
 */
export function providerState(p: ProviderView, cat: ProviderCatalog | null | undefined, inUse = false): ProviderState {
  const loud = (t: StateTone): StateTone => (inUse ? t : 'neutral');
  if (p.key === 'missing' || cat?.noKey) {
    const where = p.builtIn ? `Set ${p.keySource || 'PORTKEY_API_KEY'}, or enter the key under Connection.` : `Set ${p.keySource || 'its key variable'} in your environment or in settings.json.`;
    return { tone: loud('warn'), label: 'No key found', detail: where };
  }
  if (!cat) return { tone: 'neutral', label: 'Checking…', detail: '' };
  if (cat.unreachable) return { tone: loud('danger'), label: 'Not reachable', detail: cat.error ?? `Could not reach ${p.label} at ${p.baseURL}.` };
  if (!cat.listed) {
    const own = cat.own.length ? ` Showing the ${cat.own.length === 1 ? 'model' : 'models'} in your settings.` : '';
    return { tone: loud('warn'), label: "Can't list models", detail: `${cat.error ?? 'The service gave no list.'}${own}` };
  }
  return { tone: 'ok', label: 'Ready', detail: cat.models.length ? `${plural(cat.models.length, 'model')} offered.` : 'The service listed no models.' };
}

/** The models a group lists: the session's and the check's first (when they are this provider's), then the rest. */
export function modelIds(p: ProviderView, cat: ProviderCatalog | null | undefined, first: string[] = []): string[] {
  const all = cat ? cat.models : [p.model, ...p.models];
  const clean = (m: string) => String(m ?? '').trim();
  return [...new Set([...first.map(clean), ...all.map(clean)].filter(Boolean))];
}

/** Every word of the filter is in the model id ("opus 5" finds claude-opus-5-5); case does not matter. */
export function matchesModel(id: string, query: string): boolean {
  const words = String(query ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const hay = String(id ?? '').toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface ShownModels {
  /** The ids on screen, in order */
  shown: string[];
  /** How many the filter matched (all of them without one) */
  matched: number;
  /** How many of those are not on screen */
  more: number;
}

/**
 * What a group shows: without a filter the first MODELS_SHOWN (all with `showAll`), with one the matches (up to
 * MATCHES_SHOWN unless `showAll`). The ids in `keep` (the session's and the check's) show whatever the filter says.
 */
export function shownModels(ids: string[], query: string, showAll: boolean, keep: ReadonlySet<string> = new Set()): ShownModels {
  const q = String(query ?? '').trim();
  const matched = q ? ids.filter((id) => matchesModel(id, q)) : ids;
  const cap = showAll ? Infinity : q ? MATCHES_SHOWN : MODELS_SHOWN;
  const shown = matched.slice(0, cap);
  for (const id of ids) if (keep.has(id) && !shown.includes(id)) shown.unshift(id);
  return { shown, matched: matched.length, more: Math.max(0, matched.length - Math.min(matched.length, cap)) };
}

/** "840 ms", "1.2 s", "14 s" */
export function msWords(ms: number): string {
  const v = Math.max(0, Math.round(Number(ms) || 0));
  if (v < 1000) return `${v} ms`;
  return v < 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v / 1000)} s`;
}

/** A row's test result: "Answered in 840 ms", or the plain error. */
export function testWords(r: Pick<ProviderTestInfo, 'ok' | 'ms' | 'error'>): { ok: boolean; text: string } {
  if (r.ok) return { ok: true, text: `Answered in ${msWords(r.ms)}` };
  return { ok: false, text: String(r.error || 'It did not answer.') };
}

/** The key of a row's test result: one per provider and model */
export const rowKey = (provider: string, model: string): string => `${provider}\u0000${model}`;

/** "Claude Haiku 5.5" for claude-haiku-5-5 (and the gateway forms: anthropic/claude-haiku-5.5, @anthropic/…); else the id. */
export function modelWords(id: string): string {
  const m = /claude-(haiku|sonnet|opus|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?![\d])/i.exec(String(id ?? ''));
  if (!m) return String(id ?? '');
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `Claude ${family} ${m[2]}${m[3] && m[3].length === 1 ? `.${m[3]}` : ''}`;
}

// ---------- The safety check's model ----------

export interface CheckChoice {
  /** '' (same as the session) or "<provider>:<model>" */
  value: string;
  label: string;
  /** The optgroup: "Through Gateway" */
  group?: string;
}

/** A provider as the check's select lists it: its models, and whether it can be used (it has its key). */
export interface CheckGroup {
  name: string;
  label: string;
  models: string[];
  usable: boolean;
}

/**
 * The safety check's choices: "Same as the session" (autoMode.model '') and every model of every usable provider
 * ("<provider>:<model>"). A value set in settings.json that is none of them stays, as it is, at the end.
 */
export function checkChoices(groups: CheckGroup[], current: string): CheckChoice[] {
  const out: CheckChoice[] = [{ value: '', label: 'Same as the session' }];
  for (const g of groups) {
    if (!g.usable) continue;
    for (const m of [...new Set(g.models.map((x) => String(x ?? '').trim()).filter(Boolean))]) out.push({ value: `${g.name}:${m}`, label: m, group: `Through ${g.label}` });
  }
  const cur = String(current ?? '').trim();
  if (cur && !out.some((c) => c.value === cur)) out.push({ value: cur, label: `${cur} (your setting)` });
  return out;
}

/** What the check runs on now (CheckModelInfo), as the row says it. */
export interface CheckModelView {
  spec: string;
  none: boolean;
  automatic: boolean;
  providerLabel?: string;
  model?: string;
  testCount: number;
}

/** "Runs on Claude Haiku 5.5 through Anthropic, automatic." and the like */
export function checkModelWords(info: CheckModelView | null): string {
  if (!info) return '';
  if (info.none || !info.model) return 'No model can run the check now: risky actions ask you instead.';
  const on = `Runs on ${modelWords(info.model)}${info.providerLabel ? ` through ${info.providerLabel}` : ''}`;
  if (info.automatic) return `${on}, automatic.`;
  return info.spec ? `${on}.` : `${on}, the session's model.`;
}

/** The line under the select: which model passed the app's eval. */
export const CHECK_EVAL_NOTE = "Only Claude Haiku 5.5 on Anthropic's own API has passed the app's check eval. Another model may judge worse.";

/** Before a run: what it sends. */
export function checkTestPlan(info: CheckModelView | null): string {
  if (!info || info.none || !info.model) return 'Needs a model that can run the check.';
  return `Sends ${info.testCount} made-up actions to ${modelWords(info.model)}, one request each, and scores how it judges them.`;
}

/** A check test's result (CheckTestReport), in plain words. */
export interface CheckTestView {
  total: number;
  done: number;
  cancelled: boolean;
  right: number;
  blockLabelled: number;
  falseAllows: { id: string; action: string }[];
  falseBlocks: { id: string; action: string }[];
  noAnswer: { id: string; action: string; error?: string }[];
  medianMs: number | null;
}

/** The headline and its lines: let-through first (the failure that matters), then wrong blocks, no answer, time. */
export function checkTestWords(r: CheckTestView): { tone: 'ok' | 'danger' | 'neutral'; headline: string; lines: { tone: 'ok' | 'danger' | 'warn' | 'neutral'; text: string }[] } {
  const lines: { tone: 'ok' | 'danger' | 'warn' | 'neutral'; text: string }[] = [];
  const list = (xs: { action: string }[]) => xs.slice(0, 3).map((x) => x.action).join('; ') + (xs.length > 3 ? `; and ${xs.length - 3} more` : '');
  if (!r.done) return { tone: 'neutral', headline: r.cancelled ? 'Stopped before any check.' : 'Nothing was checked.', lines };
  const fa = r.falseAllows.length;
  if (fa) lines.push({ tone: 'danger', text: `Let ${fa} of ${r.blockLabelled} risky actions through: ${list(r.falseAllows)}. This is the failure that matters: the check would have allowed ${fa === 1 ? 'it' : 'them'} without asking you.` });
  else lines.push(r.blockLabelled ? { tone: 'ok', text: `Let none of the ${r.blockLabelled} risky actions through.` } : { tone: 'neutral', text: 'No risky action was among those checked.' });
  const fb = r.falseBlocks.length;
  lines.push(fb ? { tone: 'warn', text: `Blocked ${fb} safe ${fb === 1 ? 'action' : 'actions'}: ${list(r.falseBlocks)}. ${fb === 1 ? 'It' : 'They'} would have asked you.` } : { tone: 'ok', text: 'Blocked no safe action.' });
  const na = r.noAnswer.length;
  if (na) {
    const why = r.noAnswer.find((x) => x.error)?.error;
    lines.push({ tone: 'warn', text: `${na} ${na === 1 ? 'check' : 'checks'} gave no answer${why ? ` (${why})` : ''}; ${na === 1 ? 'it counts' : 'they count'} as blocked.` });
  }
  if (r.medianMs !== null) lines.push({ tone: 'neutral', text: `Median answer time ${msWords(r.medianMs)}.` });
  if (r.cancelled) lines.unshift({ tone: 'neutral', text: `Stopped after ${r.done} of ${r.total}.` });
  return { tone: fa ? 'danger' : 'ok', headline: `Judged ${r.right} of ${r.done} right.`, lines };
}

/**
 * The list requests in flight, one latest per provider. Each request gets a number; a result that lands after a later
 * request for the same provider started is dropped (the later one decides), so a refresh or a change of key or address
 * while a request is out never leaves the older answer on screen. A provider counts as busy until its latest lands.
 */
export class LatestRequests<T> {
  private next = 0;
  private live = new Map<string, { no: number; sig: string; req: Promise<T> }>();
  private landed = new Map<string, T>();

  /** The latest request for `name` still out, with the signature it was asked for */
  inFlight(name: string): { sig: string; req: Promise<T> } | undefined {
    return this.live.get(name);
  }

  has(name: string): boolean {
    return this.live.has(name);
  }

  /**
   * Whether `name` should be asked again for `sig`: the request out was asked for another signature, or (none out)
   * the list on hand was (`listedSig`, undefined when there is none yet).
   */
  askAgain(name: string, sig: string, listedSig: string | undefined): boolean {
    const out = this.live.get(name);
    return out ? out.sig !== sig : listedSig !== undefined && listedSig !== sig;
  }

  /**
   * Starts a request for `name` asked as `sig` (`ask` must not reject). `onLatest` gets its result only when it is still
   * the latest when it lands; the promise resolves with the latest request's result either way.
   */
  start(name: string, sig: string, ask: () => Promise<T>, onLatest: (v: T) => void): Promise<T> {
    const no = ++this.next;
    const req = ask().then((v): T | Promise<T> => {
      const cur = this.live.get(name);
      if (cur && cur.no !== no) return cur.req;
      if (!cur) return this.landed.has(name) ? (this.landed.get(name) as T) : v;
      this.live.delete(name);
      this.landed.set(name, v);
      onLatest(v);
      return v;
    });
    this.live.set(name, { no, sig, req });
    return req;
  }
}

/** The line under "Think before acting": what it does on Anthropic's own API, and else what applies instead. */
export function thinkingWords(p: Pick<ProviderView, 'name' | 'type' | 'native' | 'effort'>): string {
  if (p.native) return 'The model reasons before it acts, as Claude Code does. Off is faster and costs less.';
  if (p.name === 'ollama' || p.type === 'ollama') return "Doesn't apply to Ollama: its Thinking setting under Connection does.";
  if (p.effort) return "Doesn't apply to this provider, only to Anthropic's own API: the effort control after the model under the chat bar does.";
  return "Doesn't apply to this provider, only to Anthropic's own API. It takes no effort setting either.";
}
