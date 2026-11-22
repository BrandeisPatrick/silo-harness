// Settings → Models, its pure pieces: a provider's status in one word, which providers the Provider picker lists, the
// key as the API key row shows it, the models a picker shows for what was typed, the words of a test, and the safety
// check's choices and its result in one line. Nothing here touches the DOM or imports at run time, so the headless
// suite (test/settings-page.js) loads the compiled file directly.

import type { ProviderView } from '../../shared/types';
import type { ProviderCatalog, ProviderTestInfo } from '../../shared/providers';

/** How many matches a model picker shows; typing narrows the rest */
export const MATCHES_SHOWN = 50;

export type StateTone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface ProviderStatus {
  tone: StateTone;
  /** One word or two: "Ready", "No key", "Not reachable", "Key refused", "Error", "Checking…" */
  word: string;
  /** Why, in plain words, when it is not Ready ('' when ready or still checking) */
  reason: string;
}

/** A provider's status (the dot and the word beside the Provider picker), from its view and its list of models. */
export function providerStatus(p: ProviderView, cat: ProviderCatalog | null | undefined): ProviderStatus {
  if (p.key === 'missing' || cat?.noKey) {
    const reason = p.keyEditable ? 'Paste its key under API key.' : `Set ${p.keySource || 'its key variable'} in your environment.`;
    return { tone: 'warn', word: 'No key', reason };
  }
  if (!cat) return { tone: 'neutral', word: 'Checking…', reason: '' };
  if (cat.unreachable) return { tone: 'danger', word: 'Not reachable', reason: cat.error ?? `Could not reach ${p.label} at ${p.baseURL}.` };
  if (!cat.listed) {
    const why = cat.error ?? 'It gave no list of models.';
    if (/refused the key|HTTP 40[13]\b/.test(why)) return { tone: 'danger', word: 'Key refused', reason: why };
    // A service without a list of models still answers: the model is typed
    if (/no list of models|HTTP 404\b/.test(why)) return { tone: 'ok', word: 'Ready', reason: '' };
    return { tone: 'danger', word: 'Error', reason: why };
  }
  return { tone: 'ok', word: 'Ready', reason: '' };
}

/**
 * The providers the Provider picker lists: the one in use always; Ollama (the built-in one) once it answered; any
 * other once it has its key. One not set up yet is reached through Add provider.
 */
export function pickableProviders(all: ProviderView[], cats: ReadonlyMap<string, ProviderCatalog>, active: string): ProviderView[] {
  return all.filter((p) => {
    if (p.name === active) return true;
    if (p.name === 'ollama') {
      const c = cats.get('ollama');
      return Boolean(c && !c.unreachable);
    }
    return p.key !== 'missing';
  });
}

/** The key as the API key row shows it: dots and the last four characters, "None" for one not set. */
export function keyShown(p: Pick<ProviderView, 'key' | 'keyTail'>): string {
  if (p.key !== 'set') return 'None';
  return `••••••••${p.keyTail ?? ''}`;
}

/** Where the key in effect comes from, as one muted phrase. */
export function keyFromWords(p: Pick<ProviderView, 'key' | 'keyFrom'>): string {
  if (p.key !== 'set') return '';
  switch (p.keyFrom) {
    case 'app':
      return 'Saved in your settings';
    case 'settings':
      return 'Saved in your settings.json';
    case 'shell':
      return 'From your shell';
    case 'project':
      return "From this project's settings.json";
    default:
      return '';
  }
}

/** A long id cut so its end stays readable: "…/claude-opus-5-5"; whole ids up to `max` characters. */
export function cutId(id: string, max = 40): string {
  const s = String(id ?? '');
  if (s.length <= max) return s;
  const keepStart = Math.max(4, Math.floor((max - 1) * 0.3));
  return `${s.slice(0, keepStart)}…${s.slice(s.length - (max - 1 - keepStart))}`;
}


/** What the Add provider form holds, for addFormReady */
export interface AddFormState {
  type: string;
  /** The Name line shows (not when the type fills a built-in block) */
  askName: boolean;
  name: string;
  /** The names in use already */
  taken: string[];
  /** The type's service refuses requests without a key, and none is set where it would be read */
  keyNeeded: boolean;
  key: string;
  /** The Base URL line shows (OpenAI-compatible) */
  askUrl: boolean;
  url: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;

/** Whether Add can be clicked: a type; a free, well-formed name when one is asked; the key it needs; a base URL. */
export function addFormReady(f: AddFormState): boolean {
  if (!f.type) return false;
  if (f.askName) {
    const n = f.name.trim();
    if (!NAME_RE.test(n) || n === 'ollama' || n === 'portkey' || f.taken.includes(n)) return false;
  }
  if (f.keyNeeded && !f.key.trim()) return false;
  if (f.askUrl) {
    try {
      if (!/^https?:$/.test(new URL(f.url.trim()).protocol)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
/** A name for a new provider of `type` that no provider has yet: "openrouter", "openrouter-2", … (never a built-in's) */
export function suggestName(type: string, taken: string[]): string {
  const base = type === 'openai-compatible' ? 'custom' : String(type || 'provider');
  const used = new Set(['ollama', 'portkey', ...taken.map((t) => t.toLowerCase())]);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
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

export interface PickerMatches {
  /** The ids shown, in order (at most MATCHES_SHOWN) */
  shown: string[];
  /** How many matched */
  matched: number;
  /** What was typed, when it is no id listed: the picker offers it as it is */
  typed: string;
}

/** What a model picker shows for `query`: the matches (MATCHES_SHOWN at most), and what was typed when it is new. */
export function pickerMatches(ids: string[], query: string): PickerMatches {
  const q = String(query ?? '').trim();
  const matched = q ? ids.filter((id) => matchesModel(id, q)) : ids;
  return { shown: matched.slice(0, MATCHES_SHOWN), matched: matched.length, typed: q && !/\s/.test(q) && !ids.includes(q) ? q : '' };
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

/** The line under the select when the check runs on another model: the one model that passed the app's eval. */
export const CHECK_EVAL_NOTE = 'Only Claude Haiku 5.5 has passed the eval.';

/** The caution shows for any model but Claude Haiku 5.5 (and while no model can run the check, nothing shows). */
export function checkNeedsCaution(model: string | undefined): boolean {
  return Boolean(model) && modelWords(String(model)) !== 'Claude Haiku 5.5';
}

/** The line under the select while no model can run the check */
export const CHECK_NONE_NOTE = 'No model can run it; you approve instead.';

/**
 * The line under the safety check's select. A model you picked: the eval caution, unless it is Claude Haiku 5.5.
 * "Same as the session": a line only when the check runs elsewhere ("Runs on Claude Haiku 5.5, automatic."); on the
 * session's own model, none. No model at all: says so.
 */
export function checkDesc(info: CheckModelView | null): string {
  if (!info) return '';
  if (info.none || !info.model) return CHECK_NONE_NOTE;
  if (info.spec) return checkNeedsCaution(info.model) ? CHECK_EVAL_NOTE : '';
  return info.automatic ? `Runs on ${modelWords(info.model)}, automatic.` : '';
}

/** What an HTTP status from a provider means, in a few plain words */
const STATUS_WORDS: Record<string, string> = {
  '400': 'the service refused the request.',
  '401': 'the key was refused.',
  '403': 'the key was refused.',
  '404': 'this model does not exist or your key cannot use it.',
  '408': 'it did not answer in time.',
  '413': 'the request was too large.',
  '429': 'rate limited or out of credit.',
  '500': 'the service had a problem. Try again.',
  '502': 'the service had a problem. Try again.',
  '503': 'the service is unavailable. Try again shortly.',
  '529': 'the service is overloaded. Try again shortly.',
};
/** At most this many words in a reason's line; the whole text is its tooltip */
export const REASON_WORDS = 12;

/**
 * A provider's error as one short line, at most about twelve plain words: the HTTP status and what it means, or that
 * it could not be reached, or the first sentence cut. The model id and the address it carries stay in the tooltip.
 */
export function shortReason(text: string): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const code = /\b(?:HTTP|answered) (\d{3})\b/.exec(t)?.[1];
  if (code) return `${code}: ${STATUS_WORDS[code] ?? (code.startsWith('5') ? 'the service had a problem. Try again.' : 'the service refused the request.')}`;
  if (/did not answer in time|timed? ?out/i.test(t)) return 'It did not answer in time.';
  // The provider is named on the row already; Ollama's own hint is the useful part
  if (/^Could not reach /.test(t)) return /Is Ollama running/.test(t) ? 'Could not reach it. Is Ollama running?' : 'Could not reach it. Check its address.';
  const first = t.split(/(?<=[.!?])\s/)[0];
  const words = first.split(' ');
  return words.length <= REASON_WORDS ? first : `${words.slice(0, REASON_WORDS).join(' ').replace(/[,:;(]+$/, '')}…`;
}

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

/** A check test's result in one line: "23 of 24 right, none let through", or the failure that matters. */
export function checkLine(r: CheckTestView): { tone: 'ok' | 'danger' | 'neutral'; text: string } {
  if (!r.done) return { tone: 'neutral', text: r.cancelled ? 'Stopped before any check.' : 'Nothing was checked.' };
  const fa = r.falseAllows.length;
  const stopped = r.cancelled ? `Stopped at ${r.done} of ${r.total}: ` : '';
  if (r.noAnswer.length === r.done) {
    const why = r.noAnswer.find((x) => x.error)?.error;
    return { tone: 'danger', text: `${stopped}No answer${why ? `: ${why}` : '.'}` };
  }
  if (fa) return { tone: 'danger', text: `${stopped}${r.right} of ${r.done} right, let ${fa} risky ${fa === 1 ? 'action' : 'actions'} through` };
  return { tone: 'ok', text: `${stopped}${r.right} of ${r.done} right, none let through` };
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

/** The line under "Think before acting": what it does on Anthropic's own API, else where it applies. */
export function thinkingWords(p: Pick<ProviderView, 'name' | 'type' | 'native' | 'effort'>): string {
  if (p.native) return 'Reasons first, as Claude Code does.';
  if (p.name === 'ollama' || p.type === 'ollama') return "Ollama's own Thinking is under Connection.";
  return "Only for Anthropic's own API.";
}
