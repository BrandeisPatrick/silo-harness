// Reasoning effort: which levels a model takes, what is sent for a level, and the services that refused it.
//
// Native Anthropic path: `output_config.effort`. The levels and defaults per model are the API reference's
// (claude-api skill: shared/models.md, shared/model-migration.md): every model listed below takes low, medium, high,
// xhigh and max, except Opus 4.6 and Sonnet 4.6 (no xhigh). Opus 5.5 and Haiku 5.5 default to medium, the rest to high.
// Models not listed (Claude 3, Haiku 4.5, Sonnet 4.5, Opus 4.5, unknown ids) get nothing and the pill is hidden.
// Where the agent turns thinking off (`disabled`, Sonnet 5.5's `between_tools`), the API takes that only at high or
// below: at xhigh and max the request asks for adaptive thinking instead.
//
// OpenAI-compatible path: Low, Medium or High as the field each service documents (OpenRouter: `reasoning.effort`;
// OpenAI, Groq, DeepSeek, Together, Portkey and openai-compatible: `reasoning_effort`). LM Studio documents no such
// field and Ollama has its own think switch: no pill there.
//
// Not chosen: nothing is sent and the model's own default applies. Changing the level re-writes part of the prompt
// cache once (the top-level effort is part of the cached prefix), so the app never changes it on its own.

import type Anthropic from '@anthropic-ai/sdk';
import type { EffortInfo, EffortLevel, ProviderType } from '../../shared/types';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALL = EFFORT_LEVELS;
const NO_XHIGH: readonly EffortLevel[] = ['low', 'medium', 'high', 'max'];
/** What the OpenAI-compatible services share */
const COMPAT: readonly EffortLevel[] = ['low', 'medium', 'high'];

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** The family and version in a Claude model id ("claude-opus-4-6", "claude-opus-4-5-20251101", "us.anthropic.claude-…"). */
function claudeId(model: string): { family: string; major: number; minor: number } | null {
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d)(?!\d))?/.exec(model.toLowerCase());
  return m ? { family: m[1], major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 } : null;
}

/** The levels a model takes on the Messages API and its default, or null (no effort setting). */
export function nativeEffort(model: string): { levels: readonly EffortLevel[]; default: EffortLevel } | null {
  const id = claudeId(model);
  if (!id) return null;
  const v = id.major * 10 + id.minor;
  switch (id.family) {
    case 'opus':
      if (v === 46) return { levels: NO_XHIGH, default: 'high' };
      if (v === 47 || v === 48 || v === 50) return { levels: ALL, default: 'high' };
      if (v === 55) return { levels: ALL, default: 'medium' };
      return null;
    case 'sonnet':
      if (v === 46) return { levels: NO_XHIGH, default: 'high' };
      if (v === 50 || v === 55) return { levels: ALL, default: 'high' };
      return null;
    case 'haiku':
      return v === 55 ? { levels: ALL, default: 'medium' } : null;
    case 'fable':
    case 'mythos':
      return v === 50 || v === 51 ? { levels: ALL, default: 'high' } : null;
    default:
      return null;
  }
}

/** The nearest level the list has; between two equally near, the lower (xhigh on Opus 4.6 runs as high). */
export function clampEffort(level: EffortLevel, levels: readonly EffortLevel[]): EffortLevel {
  if (levels.includes(level)) return level;
  const at = EFFORT_LEVELS.indexOf(level);
  let best = levels[0];
  let dist = Infinity;
  for (const l of levels) {
    const d = Math.abs(EFFORT_LEVELS.indexOf(l) - at);
    if (d < dist) {
      best = l;
      dist = d;
    }
  }
  return best;
}

/** The field an OpenAI-compatible service type documents for effort, or null (none). */
export function compatEffortField(type: ProviderType): 'reasoning_effort' | 'reasoning.effort' | null {
  if (type === 'openrouter') return 'reasoning.effort';
  if (type === 'openai' || type === 'groq' || type === 'deepseek' || type === 'together' || type === 'portkey' || type === 'openai-compatible') return 'reasoning_effort';
  return null;
}

/**
 * What the pill shows for a provider: the levels on offer, what was chosen (clamped to them) and the model's default.
 * Null: the model or the service takes no effort setting (the pill is hidden).
 */
export function effortInfo(r: { type: ProviderType; model: string; effort?: EffortLevel; native: boolean }): EffortInfo | null {
  if (!r.model) return null;
  if (r.native) {
    const n = nativeEffort(r.model);
    if (!n) return null;
    return { levels: [...n.levels], chosen: r.effort ? clampEffort(r.effort, n.levels) : null, default: n.default };
  }
  if (!compatEffortField(r.type)) return null;
  return { levels: [...COMPAT], chosen: r.effort ? clampEffort(r.effort, COMPAT) : null, default: null };
}

/** The native request's effort for the chosen level (clamped), or undefined: send nothing. */
export function nativeEffortFor(model: string, chosen: EffortLevel | undefined): EffortLevel | undefined {
  const n = chosen ? nativeEffort(model) : null;
  return n && chosen ? clampEffort(chosen, n.levels) : undefined;
}

/**
 * The thinking field to send with an effort: off (disabled, between_tools) is accepted only at high or below, so a
 * higher level asks for adaptive thinking with summaries, as the models that always think get.
 */
export function thinkingWithEffort(thinking: Anthropic.ThinkingConfigParam | undefined, effort: EffortLevel | undefined): Anthropic.ThinkingConfigParam | undefined {
  if (!thinking || (effort !== 'xhigh' && effort !== 'max')) return thinking;
  if (thinking.type === 'disabled' || thinking.type === 'between_tools') return { type: 'adaptive', display: 'summarized' };
  return thinking;
}

/** The request fields for an OpenAI-compatible service (empty: send nothing). */
export function compatEffortFields(type: ProviderType, chosen: EffortLevel | undefined): Record<string, unknown> {
  const field = chosen ? compatEffortField(type) : null;
  if (!field || !chosen) return {};
  const level = clampEffort(chosen, COMPAT);
  return field === 'reasoning.effort' ? { reasoning: { effort: level } } : { reasoning_effort: level };
}

// ---------- Services that refused the field ----------

/** base URL | model pairs that refused the effort field: sent without it for the rest of the process */
export const effortRefused = new Set<string>();

/** A 400 or 422 whose message names the effort field (reasoning_effort, reasoning, output_config, effort). */
export function isEffortRefusal(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown; error?: { message?: unknown } };
  const status = Number(e?.status);
  if (status !== 400 && status !== 422) return false;
  const text = `${String(e?.message ?? '')} ${String(e?.error?.message ?? '')}`;
  return /reasoning_effort|output_config|\beffort\b|\breasoning\b/i.test(text);
}

/** The one notice when a service refused the field. */
export function effortRefusedNotice(model: string): string {
  return `${model} doesn't take an effort setting here; sent without it.`;
}
