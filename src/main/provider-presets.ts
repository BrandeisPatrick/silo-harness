// The provider types (presets) and the rules for a named provider entry. No dependencies beyond checks.ts, so the
// settings layer, the JSON Schema and the command-line tool all share exactly these rules.
//
// Each base URL is the service's documented OpenAI-compatible endpoint (see docs/configure.md for the sources).

import type { NamedProviderConfig, ProviderType } from '../shared/types';
import { describe, envName, headerMap, httpUrl, kind, nonEmpty, oneOf, positiveInt, stringList, type Check, type JsonSchema } from './checks';
import { isRecord } from './json';

export interface Preset {
  /** What the window calls it */
  label: string;
  /** '' for openai-compatible, which has none of its own */
  baseURL: string;
  /** The variable the key is read from when the entry names none */
  keyEnv?: string;
  /** Without a key the service refuses every request */
  keyRequired: boolean;
  /** Headers sent with every request (the entry's own headers win) */
  headers?: Record<string, string>;
  /** Where the base URL is documented */
  docs: string;
}

export const PRESETS: Record<ProviderType, Preset> = {
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    keyRequired: true,
    // App attribution, as OpenRouter's docs describe it
    headers: { 'HTTP-Referer': 'https://github.com/BrandeisPatrick/silo-harness', 'X-OpenRouter-Title': 'Silo Harness' },
    docs: 'https://openrouter.ai/docs/quickstart',
  },
  portkey: { label: 'Portkey', baseURL: 'https://api.portkey.ai/v1', keyEnv: 'PORTKEY_API_KEY', keyRequired: true, docs: 'https://portkey.ai/docs/api-reference/inference-api/introduction' },
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', keyRequired: true, docs: 'https://developers.openai.com/api/reference/overview' },
  anthropic: { label: 'Anthropic', baseURL: 'https://api.anthropic.com/v1/', keyEnv: 'ANTHROPIC_API_KEY', keyRequired: true, docs: 'https://platform.claude.com/docs/en/api/openai-sdk' },
  groq: { label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', keyRequired: true, docs: 'https://console.groq.com/docs/openai' },
  deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', keyRequired: true, docs: 'https://api-docs.deepseek.com/' },
  together: { label: 'Together AI', baseURL: 'https://api.together.ai/v1', keyEnv: 'TOGETHER_API_KEY', keyRequired: true, docs: 'https://docs.together.ai/docs/openai-api-compatibility' },
  ollama: { label: 'Ollama', baseURL: 'http://localhost:11434/v1', keyRequired: false, docs: 'https://docs.ollama.com/api/openai-compatibility' },
  lmstudio: { label: 'LM Studio', baseURL: 'http://localhost:1234/v1', keyRequired: false, docs: 'https://lmstudio.ai/docs/app/api/endpoints/openai' },
  'openai-compatible': { label: 'OpenAI-compatible', baseURL: '', keyRequired: false, docs: '' },
};

export const PROVIDER_TYPES = Object.keys(PRESETS) as ProviderType[];

/** The names of the two config.json blocks; a named entry may not take them. */
export const BUILT_IN_PROVIDERS = ['ollama', 'portkey'] as const;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;

/** Why `name` cannot name a provider entry, or null. */
export function providerNameProblem(name: string): string | null {
  if ((BUILT_IN_PROVIDERS as readonly string[]).includes(name)) return `"${name}" is the name of a built-in provider (the ${name} block); choose another name, e.g. "my-${name}"`;
  if (!NAME_RE.test(name)) return 'a provider name is 1 to 48 letters, digits, ".", "_" or "-", starting with a letter or digit';
  return null;
}

type Field = { check: Check; types?: ProviderType[] };

/** The fields of an entry, in the order the schema and the docs list them. `types`: the only types that use it. */
export const ENTRY_FIELDS: Record<keyof NamedProviderConfig, Field> = {
  type: { check: describe(oneOf(...PROVIDER_TYPES), 'The kind of service. Each type knows its base URL, its usual key variable and any headers.') },
  label: { check: describe(nonEmpty, "How the window names it (default: the type's name).") },
  baseURL: { check: describe(httpUrl, "The OpenAI-compatible endpoint; overrides the type's. Required for openai-compatible. In a project's settings.json only for services that take no key (ollama, lmstudio, or openai-compatible without a key).") },
  apiKey: { check: describe(nonEmpty, "The key itself. Only in your own settings.json or config.json, never in a project's file; prefer apiKeyEnv.") },
  apiKeyEnv: { check: describe(envName, "The environment variable that holds the key (the env block of settings.json counts). Default: the type's, e.g. OPENROUTER_API_KEY. Ignored in a project's settings.json, which may not choose whose key is sent.") },
  model: { check: describe(nonEmpty, 'The model to run, as the service names it.') },
  models: { check: describe(stringList, 'Models to offer in the model picker.') },
  headers: { check: describe(headerMap, "Extra request headers; ${VAR} is expanded in the values (not in a project's settings.json).") },
  contextWindow: { check: describe(positiveInt, "The model's context window in tokens (default 128000); drives the context meter and auto-compaction.") },
  maxOutput: { check: describe(positiveInt, 'Most tokens one reply may have, sent as max_tokens (default: the service decides).') },
  virtualKey: { check: describe(nonEmpty, 'portkey: a virtual key (x-portkey-virtual-key).'), types: ['portkey'] },
  config: { check: describe(nonEmpty, 'portkey: a config id for routing, fallbacks and caching (x-portkey-config).'), types: ['portkey'] },
  provider: { check: describe(nonEmpty, 'portkey: a provider slug (x-portkey-provider), e.g. openai.'), types: ['portkey'] },
  numCtx: { check: describe(positiveInt, 'ollama: the context size asked for (num_ctx).'), types: ['ollama'] },
  think: { check: describe(oneOf('auto', 'on', 'off'), 'ollama: thinking mode for models that can reason.'), types: ['ollama'] },
};

export interface EntryProblem {
  /** "providers.<name>" or "providers.<name>.<field>" */
  key: string;
  message: string;
}

export interface EntryOptions {
  /** project: a repository's file, which may not carry a key */
  scope: 'user' | 'project' | 'config';
  /** Applied to every string before it is checked (the settings layer expands ${VAR}) */
  expand?: (v: string) => string;
}


/**
 * Checks one entry. A bad field is dropped and reported; an entry without a usable type (or an openai-compatible one
 * without a base URL) is dropped whole. Returns the entry to apply (null: none) and the problems.
 */
export function validateProviderEntry(name: string, raw: unknown, opts: EntryOptions): { entry: NamedProviderConfig | null; problems: EntryProblem[] } {
  const base = `providers.${name}`;
  const problems: EntryProblem[] = [];
  const nameProblem = providerNameProblem(name);
  if (nameProblem) return { entry: null, problems: [{ key: base, message: nameProblem }] };
  if (!isRecord(raw)) return { entry: null, problems: [{ key: base, message: `expected an object such as { "type": "openrouter" }, got ${kind(raw)}` }] };
  const typeMsg = raw.type === undefined ? `needs a "type": one of ${PROVIDER_TYPES.join(', ')}` : ENTRY_FIELDS.type.check(raw.type);
  if (typeMsg) return { entry: null, problems: [{ key: raw.type === undefined ? base : `${base}.type`, message: typeMsg }] };
  const type = raw.type as ProviderType;
  const out: Record<string, unknown> = { type };
  const expandDeep = (v: unknown): unknown => {
    if (!opts.expand) return v;
    if (typeof v === 'string') return opts.expand(v);
    if (Array.isArray(v)) return v.map(expandDeep);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x)]));
    return v;
  };
  for (const [field, value] of Object.entries(raw)) {
    if (field === 'type') continue;
    const key = `${base}.${field}`;
    const spec = (ENTRY_FIELDS as Record<string, Field>)[field];
    if (!spec) {
      problems.push({ key, message: `not a provider setting (known: ${Object.keys(ENTRY_FIELDS).join(', ')})` });
      continue;
    }
    if (spec.types && !spec.types.includes(type)) {
      problems.push({ key, message: `only for type ${spec.types.join(' or ')}` });
      continue;
    }
    if (field === 'apiKey' && opts.scope === 'project') {
      problems.push({ key, message: "a project's settings.json may not hold a key; name the variable with apiKeyEnv instead" });
      continue;
    }
    // A project may not choose whose key is sent: the type's usual variable is used, and an openai-compatible entry
    // (an address of its own) takes no key at all from a project.
    if (field === 'apiKeyEnv' && opts.scope === 'project') {
      problems.push({ key, message: "a project's settings.json may not choose the variable that holds a key; the type's usual variable is used. For another variable, define this provider in your own settings.json and select it here with \"provider\"" });
      continue;
    }
    let rawValue = value;
    if (field === 'headers' && opts.scope === 'project' && isRecord(value)) {
      // Checked before ${VAR} is expanded: a variable in a header would carry a secret to wherever the entry points.
      const kept: Record<string, unknown> = {};
      for (const [h, hv] of Object.entries(value)) {
        if (typeof hv === 'string' && hv.includes('${')) problems.push({ key: `${key}.${h}`, message: "a project's settings.json may not put a variable in a header" });
        else kept[h] = hv;
      }
      if (!Object.keys(kept).length) continue;
      rawValue = kept;
    }
    const v = expandDeep(rawValue);
    const msg = spec.check(v);
    if (msg) {
      problems.push({ key, message: msg });
      continue;
    }
    out[field] = typeof v === 'string' ? v.trim() : v;
  }
  if (out.apiKey !== undefined && out.apiKeyEnv !== undefined) problems.push({ key: `${base}.apiKeyEnv`, message: 'both apiKey and apiKeyEnv are set; apiKey is used' });
  if (type === 'openai-compatible' && !out.baseURL) {
    problems.push({ key: `${base}.baseURL`, message: 'type openai-compatible needs a baseURL, e.g. "https://gateway.example.com/v1"' });
    return { entry: null, problems };
  }
  // Trusting a project's file is not consent to sending your key where it says: a service that takes a key (the
  // type's own variable, or one the entry names) keeps its documented address when the entry comes from a project.
  // Ollama and LM Studio take no key, so their address may be set there.
  const keyed = PRESETS[type].keyRequired || out.apiKeyEnv !== undefined;
  if (opts.scope === 'project' && keyed && raw.baseURL !== undefined && type !== 'openai-compatible') {
    problems.push({ key: `${base}.baseURL`, message: "a project's settings.json may not point a keyed service at an address of its own; define this provider in your own settings.json and select it here with \"provider\"" });
    return { entry: null, problems };
  }
  return { entry: out as unknown as NamedProviderConfig, problems };
}

/** The JSON Schema of one entry. */
export function providerEntrySchema(): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [field, spec] of Object.entries(ENTRY_FIELDS)) properties[field] = spec.check.schema;
  return {
    type: 'object',
    required: ['type'],
    additionalProperties: false,
    properties,
    allOf: [
      { if: { properties: { type: { const: 'openai-compatible' } } }, then: { required: ['type', 'baseURL'] } },
      ...Object.entries(ENTRY_FIELDS)
        .filter(([, s]) => s.types)
        .map(([field, s]) => ({ if: { required: [field] }, then: { properties: { type: { enum: s.types } } } })),
    ],
  };
}
