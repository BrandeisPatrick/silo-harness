// Model providers. Every service the app talks to is resolved to one shape (ResolvedProvider: name, type, label,
// base URL, key, headers, model, context window), so the rest of the app does not care which service it is:
//
//   - 'ollama'  the config's `ollama` block (native /api/chat with num_ctx, thinking and capability detection)
//   - 'portkey' the config's `portkey` block (any OpenAI-compatible gateway; the window calls it Gateway)
//   - <name>    an entry of `providers`, of a type from provider-presets.ts (openrouter, openai, anthropic, …)
//
// Keys: read from the entry (apiKey) or the environment (apiKeyEnv, else the preset's variable). A key never leaves
// this module except as a request header: the window gets providerView (set / not set), errors are scrubbed.

import type Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AppConfig, ModelCapabilities, NamedProviderConfig, OllamaConfig, ProviderType, ProvidersView, ProviderView } from '../shared/types';
import { expandEnvRefs } from './env';
import { maskedConfig } from './mcp-values';
import { anthropicClient, isNativeAnthropic } from './agent/anthropic';
import { contextSize, ollamaRoot } from './ollama';
import { PRESETS, validateProviderEntry } from './provider-presets';
import os from 'node:os';
import path from 'node:path';
import { configDir } from './paths';

/** The user's settings.json as messages show it (~/… when it is under the home folder). */
function shownSettingsPath(): string {
  const p = path.join(configDir(), 'settings.json');
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

export interface ProviderClient {
  client: OpenAI;
  model: string;
  label: string;
  /** max_tokens for the agent's requests, when the entry sets one */
  maxOutput?: number;
  /** Anthropic's own API: the client of its native Messages API, which the agent's model calls use (they cache) */
  native?: Anthropic;
}

export interface ResolvedProvider {
  name: string;
  type: ProviderType;
  label: string;
  builtIn: boolean;
  /** No trailing slash */
  baseURL: string;
  /** '' when none */
  apiKey: string;
  /** A variable name or a field name ("apiKey", "portkey.apiKey"), for messages */
  keySource: string;
  keyRequired: boolean;
  /** Sent as Authorization: Bearer */
  bearer: string;
  headers: Record<string, string>;
  model: string;
  models: string[];
  contextWindow: number;
  maxOutput?: number;
  /** ollama type */
  numCtx: number;
  think: 'auto' | 'on' | 'off';
  /** Why it cannot be used as it is; makeClient throws it */
  error?: string;
  /** Problems with the entry's fields (skipped ones), for doctor */
  problems: string[];
}

/** What the window gets in place of a key that is set. */
export const KEY_MASK = '••••••••';

const DEFAULT_CONTEXT = 128000;
const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');
const isPortkeyHost = (u: string) => {
  try {
    return /(^|\.)portkey\.ai$/.test(new URL(u).hostname);
  } catch {
    return false;
  }
};

// ---------- Keeping keys out of messages ----------

const secrets = new Set<string>();
const remember = (key: string) => {
  if (key && key.length >= 8) secrets.add(key);
};

/** `text` with every key this process has resolved replaced by "…" (a service's error may quote it). */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join('…');
  return out;
}

// ---------- Resolving ----------

/** The names of every provider: the two built-in ones, then the named ones in file order. */
export function providerNames(cfg: AppConfig): string[] {
  return ['ollama', 'portkey', ...Object.keys(cfg.providers ?? {}).filter((n) => n !== 'ollama' && n !== 'portkey')];
}

function resolveOllamaBlock(cfg: AppConfig): ResolvedProvider {
  const o = cfg.ollama;
  return {
    name: 'ollama',
    type: 'ollama',
    label: 'Ollama',
    builtIn: true,
    baseURL: trimUrl(o.baseURL || PRESETS.ollama.baseURL),
    apiKey: '',
    keySource: '',
    keyRequired: false,
    bearer: 'ollama',
    headers: {},
    model: o.model || '',
    models: [],
    contextWindow: contextSize(o.numCtx),
    numCtx: contextSize(o.numCtx),
    think: o.think ?? 'auto',
    error: o.model ? undefined : 'No Ollama model selected. Open Settings and pick one (e.g. `ollama pull qwen3:8b`).',
    problems: [],
  };
}

function resolvePortkeyBlock(cfg: AppConfig, env: NodeJS.ProcessEnv): ResolvedProvider {
  const p = cfg.portkey;
  const apiKey = p.apiKey || env.PORTKEY_API_KEY || '';
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-portkey-api-key'] = apiKey;
  if (p.virtualKey) headers['x-portkey-virtual-key'] = p.virtualKey;
  if (p.provider) headers['x-portkey-provider'] = p.provider;
  if (p.configId) headers['x-portkey-config'] = p.configId;
  const baseURL = trimUrl(p.baseURL || PRESETS.portkey.baseURL);
  remember(apiKey);
  remember(p.providerApiKey);
  return {
    name: 'portkey',
    type: 'portkey',
    // The block is used for any OpenAI-compatible gateway; only Portkey's own is called Portkey.
    label: isPortkeyHost(baseURL) ? 'Portkey' : 'Gateway',
    builtIn: true,
    baseURL,
    apiKey,
    keySource: p.apiKey ? 'portkey.apiKey' : 'PORTKEY_API_KEY',
    keyRequired: true,
    // With x-portkey-provider, Portkey forwards this bearer token to the upstream provider.
    // With a virtual key or model-catalog id, the Portkey key itself is enough.
    bearer: p.providerApiKey || apiKey,
    headers,
    model: p.model || '',
    models: [],
    contextWindow: Math.max(4096, Number(p.contextWindow) || DEFAULT_CONTEXT),
    numCtx: 0,
    think: 'auto',
    error: !apiKey ? 'Portkey API key is not set. Open Settings and add it, or export PORTKEY_API_KEY.' : !p.model ? 'No Portkey model set. Open Settings and enter one, e.g. @openai/gpt-4o-mini.' : undefined,
    problems: [],
  };
}

function unknownProvider(cfg: AppConfig, name: string): ResolvedProvider {
  return {
    name,
    type: 'openai-compatible',
    label: name,
    builtIn: false,
    baseURL: '',
    apiKey: '',
    keySource: '',
    keyRequired: false,
    bearer: 'none',
    headers: {},
    model: '',
    models: [],
    contextWindow: DEFAULT_CONTEXT,
    numCtx: 0,
    think: 'auto',
    error: `There is no provider named "${name}". Known: ${providerNames(cfg).join(', ')}.`,
    problems: [],
  };
}

function resolveNamed(cfg: AppConfig, name: string, env: NodeJS.ProcessEnv): ResolvedProvider {
  const raw = cfg.providers?.[name];
  if (raw === undefined) return unknownProvider(cfg, name);
  const { entry, problems } = validateProviderEntry(name, raw, { scope: 'config', expand: (v) => expandEnvRefs(v, env) });
  const problemLines = problems.map((p) => `${p.key}: ${p.message}`);
  if (!entry) return { ...unknownProvider(cfg, name), error: `The provider "${name}" cannot be used: ${problemLines[0] ?? 'its entry is not valid'}.`, problems: problemLines };
  const e: NamedProviderConfig = entry;
  const preset = PRESETS[e.type];
  // Two entries of one type without labels would look the same in the window.
  const twin = Object.entries(cfg.providers ?? {}).some(([n, x]) => n !== name && x && typeof x === 'object' && (x as NamedProviderConfig).type === e.type && !(x as NamedProviderConfig).label);
  const label = e.label || (twin ? `${preset.label} (${name})` : preset.label);
  const keyVar = e.apiKeyEnv || preset.keyEnv || '';
  const apiKey = e.apiKey || (keyVar ? env[keyVar] || '' : '');
  remember(apiKey);
  const keyRequired = preset.keyRequired || Boolean(e.apiKeyEnv);
  const headers: Record<string, string> = { ...(preset.headers ?? {}) };
  if (e.type === 'portkey') {
    if (apiKey) headers['x-portkey-api-key'] = apiKey;
    if (e.virtualKey) headers['x-portkey-virtual-key'] = e.virtualKey;
    if (e.config) headers['x-portkey-config'] = e.config;
    if (e.provider) headers['x-portkey-provider'] = e.provider;
  }
  for (const [k, v] of Object.entries(e.headers ?? {})) headers[k] = v;
  for (const v of Object.values(e.headers ?? {})) remember(v.replace(/^Bearer\s+/i, ''));
  const numCtx = contextSize(e.numCtx);
  const where = e.apiKey ? `providers.${name}.apiKey` : keyVar;
  let error: string | undefined;
  if (keyRequired && !apiKey) {
    error = `${label} needs a key: set ${keyVar} in your environment or in the "env" block of ${shownSettingsPath()}${e.apiKeyEnv ? '' : `, or name another variable with providers.${name}.apiKeyEnv`}.`;
  } else if (!e.model) {
    error = `No model set for ${label}. Choose one in Settings → Model, or run: silo provider use ${name} --model <id>`;
  }
  return {
    name,
    type: e.type,
    label,
    builtIn: false,
    baseURL: trimUrl(e.baseURL || preset.baseURL),
    apiKey,
    keySource: where,
    keyRequired,
    bearer: apiKey || (e.type === 'ollama' ? 'ollama' : 'none'),
    headers,
    model: e.model || '',
    models: e.models ?? [],
    contextWindow: e.type === 'ollama' ? numCtx : Math.max(1024, e.contextWindow || DEFAULT_CONTEXT),
    maxOutput: e.maxOutput,
    numCtx,
    think: e.think ?? 'auto',
    error,
    problems: problemLines,
  };
}

/** One provider (default: the one in use), resolved over its preset, the config's blocks and the environment. */
export function resolveProvider(cfg: AppConfig, name: string = cfg.provider || 'ollama', env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
  if (name === 'ollama') return resolveOllamaBlock(cfg);
  if (name === 'portkey') return resolvePortkeyBlock(cfg, env);
  return resolveNamed(cfg, name, env);
}

/** Every provider, resolved. */
export function listProviders(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): ResolvedProvider[] {
  return providerNames(cfg).map((n) => resolveProvider(cfg, n, env));
}

/**
 * The OpenAI client for a resolved provider. maxRetries 0: the agent's model calls retry in their own loop
 * (agent/retry.ts), and the other calls (summary, titles, Auto mode's check, …) pass their own.
 */
export function clientFor(r: ResolvedProvider): OpenAI {
  return new OpenAI({ baseURL: r.baseURL, apiKey: r.bearer || 'none', defaultHeaders: r.headers, maxRetries: 0 });
}

/**
 * The client for the provider in use. Every provider speaks OpenAI-compatible chat completions; only the base URL,
 * the key and the headers differ. Throws, in plain words, when it cannot be used (no key, no model, unknown name).
 */
export function makeClient(cfg: AppConfig): ProviderClient {
  const r = resolveProvider(cfg);
  if (r.error) throw new Error(r.error);
  const out: ProviderClient = { client: clientFor(r), model: r.model, label: `${r.label} · ${r.model}`, maxOutput: r.maxOutput };
  if (isNativeAnthropic(r)) out.native = anthropicClient(r);
  return out;
}

/** True when the provider in use is an Ollama (the block or a named entry of type ollama): the native path. */
export function isOllama(cfg: AppConfig): boolean {
  return resolveProvider(cfg).type === 'ollama';
}

/** The Ollama settings the native path uses: the provider in use when it is an Ollama, else the `ollama` block. */
export function ollamaOf(cfg: AppConfig): OllamaConfig {
  const r = resolveProvider(cfg);
  if (r.type !== 'ollama' || r.builtIn || r.error?.startsWith('There is no provider')) return cfg.ollama;
  return { baseURL: r.baseURL, model: r.model, numCtx: r.numCtx, think: r.think };
}

/** The model in use (whatever the provider), '' when none is set. */
export function activeModel(cfg: AppConfig): string {
  return resolveProvider(cfg).model;
}

// ---------- What the window may see ----------

/** A resolved provider with the key reduced to set / not set. */
export function providerView(r: ResolvedProvider, owner?: 'user' | 'project'): ProviderView {
  return {
    name: r.name,
    type: r.type,
    label: r.label,
    builtIn: r.builtIn,
    baseURL: r.baseURL,
    model: r.model,
    models: [...r.models],
    contextWindow: r.contextWindow,
    ...(r.maxOutput ? { maxOutput: r.maxOutput } : {}),
    key: r.apiKey ? 'set' : r.keyRequired ? 'missing' : 'none',
    keySource: r.keySource,
    headers: Object.keys(r.headers).filter((h) => !/^x-portkey-api-key$/i.test(h)),
    ...(owner ? { owner } : {}),
    ...(r.error ? { error: scrubSecrets(r.error) } : {}),
  };
}

export function providersView(cfg: AppConfig, owned: Record<string, 'user' | 'project'> = {}, env: NodeJS.ProcessEnv = process.env): ProvidersView {
  const all = providerNames(cfg).map((n) => providerView(resolveProvider(cfg, n, env), owned[`providers.${n}`]));
  const name = cfg.provider || 'ollama';
  const active = all.find((p) => p.name === name) ?? providerView(resolveProvider(cfg, name, env));
  return { active, all };
}

/**
 * The config as the window gets it: keys masked (KEY_MASK when set, '' when not), header values masked, and the
 * providers resolved in providerView. acceptFromWindow undoes the masks on the way back.
 */
export function windowConfig(cfg: AppConfig, owned: Record<string, 'user' | 'project'> = {}): AppConfig {
  const mask = (v: string | undefined) => (v ? KEY_MASK : '');
  const providers: AppConfig['providers'] = {};
  for (const [name, e] of Object.entries(cfg.providers ?? {})) {
    if (!e || typeof e !== 'object') continue;
    const copy: NamedProviderConfig = { ...e };
    if (copy.apiKey !== undefined) copy.apiKey = mask(copy.apiKey);
    if (copy.headers && typeof copy.headers === 'object') copy.headers = Object.fromEntries(Object.keys(copy.headers).map((k) => [k, KEY_MASK]));
    providers[name] = copy;
  }
  return {
    ...cfg,
    portkey: { ...cfg.portkey, apiKey: mask(cfg.portkey?.apiKey), providerApiKey: mask(cfg.portkey?.providerApiKey) },
    ...(cfg.webSearch ? { webSearch: { ...cfg.webSearch, apiKey: mask(cfg.webSearch.apiKey) } } : {}),
    providers,
    providerView: providersView(cfg, owned),
    // MCP env and header values stay in the main process (config:set keeps the current ones)
    mcpServers: Object.fromEntries(Object.entries(cfg.mcpServers ?? {}).map(([n, c]) => [n, maskedConfig(n, c)])),
    mcpProjectValues: {},
  };
}

/** A config sent back by the window, over the current one: masks keep the current keys, providers stay as they are. */
export function acceptFromWindow<T extends Partial<AppConfig>>(current: AppConfig, next: T): T {
  const out = { ...next } as T & { providerView?: unknown };
  delete out.providerView;
  delete (out as Partial<AppConfig>).providers;
  if (next.portkey) {
    const pk = { ...next.portkey };
    if (pk.apiKey === KEY_MASK) pk.apiKey = current.portkey.apiKey;
    if (pk.providerApiKey === KEY_MASK) pk.providerApiKey = current.portkey.providerApiKey;
    (out as Partial<AppConfig>).portkey = pk;
  }
  if (next.webSearch?.apiKey === KEY_MASK) (out as Partial<AppConfig>).webSearch = { ...next.webSearch, apiKey: current.webSearch?.apiKey ?? '' };
  return out;
}

// ---------- Asking the service ----------

/** What the configured model can do. Ollama reports capabilities from /api/show (0.6+); other services' models are unknown. */
export async function modelCapabilities(cfg: AppConfig): Promise<ModelCapabilities> {
  const r = resolveProvider(cfg);
  if (r.type !== 'ollama') return { provider: r.name, model: r.model, vision: null, tools: null };
  const model = r.model;
  try {
    const res = await fetch(`${ollamaRoot(r.baseURL)}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return { provider: r.name, model, vision: null, tools: null };
    const data = (await res.json()) as { capabilities?: string[] };
    if (!Array.isArray(data.capabilities)) return { provider: r.name, model, vision: null, tools: null };
    return { provider: r.name, model, vision: data.capabilities.includes('vision'), tools: data.capabilities.includes('tools') };
  } catch {
    return { provider: r.name, model, vision: null, tools: null };
  }
}

/** Lists locally available Ollama models via the native /api/tags endpoint. */
export async function listOllamaModels(baseURL: string): Promise<string[]> {
  const res = await fetch(`${ollamaRoot(baseURL)}/api/tags`);
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name).sort();
}

/**
 * The models a provider offers: Ollama's local ones, or the service's GET /models (most OpenAI-compatible services
 * have it), with the entry's own list first. Rejects when the service cannot be asked and the entry lists none.
 */
export async function listModels(r: ResolvedProvider, timeoutMs = 8000): Promise<string[]> {
  const own = [...r.models];
  let asked: string[] = [];
  try {
    if (r.type === 'ollama') asked = await listOllamaModels(r.baseURL);
    else {
      if (r.keyRequired && !r.apiKey) throw new Error(r.error ?? 'no key');
      const page = await clientFor(r).models.list({ signal: AbortSignal.timeout(timeoutMs), maxRetries: 0 });
      asked = page.data.map((m) => m.id).filter((id) => typeof id === 'string').sort();
    }
  } catch (err) {
    if (!own.length) throw new Error(plainError(err, r));
  }
  return [...new Set([...own, ...asked])];
}

/** A service's error in plain words, without the key. */
export function plainError(err: unknown, r: ResolvedProvider): string {
  const e = err as { status?: number; message?: string; name?: string; error?: { message?: string }; cause?: { code?: string; message?: string } };
  const detail = String(e?.error?.message || e?.message || err || 'unknown error').replace(/^\d{3}\s+/, '').trim();
  let msg: string;
  if (e?.name === 'APIConnectionTimeoutError' || e?.name === 'AbortError' || e?.name === 'TimeoutError' || /timed? ?out|aborted/i.test(String(e?.message))) msg = `${r.label} did not answer in time (${r.baseURL}).`;
  else if (e?.name === 'APIConnectionError' || e?.cause?.code) msg = `Could not reach ${r.label} at ${r.baseURL}${e?.cause?.code ? ` (${e.cause.code})` : ''}. Check the base URL and your connection.`;
  else if (e?.status === 401 || e?.status === 403) msg = `${r.label} refused the key (HTTP ${e.status}): ${detail}${r.keySource ? ` Check ${r.keySource}.` : ''}`;
  else if (e?.status === 404) msg = `${r.label} answered 404: ${detail} Check the model id ("${r.model}") and the base URL (${r.baseURL}).`;
  else if (e?.status === 429) msg = `${r.label} is rate limiting or out of credit (HTTP 429): ${detail}`;
  else if (e?.status === 529) msg = `${r.label} is overloaded (HTTP 529). Try again shortly.`;
  else if (e?.status) msg = `${r.label} returned HTTP ${e.status}: ${detail}`;
  else msg = `${r.label}: ${detail}`;
  return scrubSecrets(msg);
}

export interface ProviderTestResult {
  ok: boolean;
  name: string;
  label: string;
  model: string;
  ms: number;
  /** ok: the first words of the reply */
  reply?: string;
  error?: string;
}

/** One tiny chat completion through the provider: whether it answers, with which model and how fast. */
export async function testProvider(r: ResolvedProvider, timeoutMs = 60_000): Promise<ProviderTestResult> {
  const base = { name: r.name, label: r.label, model: r.model };
  if (r.error) return { ...base, ok: false, ms: 0, error: scrubSecrets(r.error) };
  const started = Date.now();
  try {
    const res = await clientFor(r).chat.completions.create(
      { model: r.model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 16, stream: false },
      { signal: AbortSignal.timeout(timeoutMs), maxRetries: 0 },
    );
    const reply = String(res.choices?.[0]?.message?.content ?? '').trim().slice(0, 80);
    return { ...base, model: res.model || r.model, ok: true, ms: Date.now() - started, reply: scrubSecrets(reply) };
  } catch (err) {
    return { ...base, ok: false, ms: Date.now() - started, error: plainError(err, r) };
  }
}
