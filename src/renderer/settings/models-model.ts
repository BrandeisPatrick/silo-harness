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
