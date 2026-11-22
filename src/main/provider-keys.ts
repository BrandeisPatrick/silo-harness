// Where each provider's key is kept, and saving or removing one from the window (Settings → Models → API key).
//
// A key is saved where the app already resolves it from, in the user's own files only, never a project's:
//
//   gateway block (portkey)     portkey.apiKey, in config.json (or in your settings.json when that file sets it), else
//                               PORTKEY_API_KEY in the env block of your settings.json when that is where it comes from
//   a named provider            its apiKey field when it has one; else the variable its apiKeyEnv names, in the env
//                               block of your settings.json; else (no apiKeyEnv) its apiKey field, in the file that
//                               defines it (a project's file may hold no key: the type's own variable, in your file)
//   Ollama, LM Studio           take no key
//
// A key that comes from the real process environment (your shell) is read-only here: the window says so.
//
// The files that hold a key are mode 600 (config.ts saveConfig, editUserSettings below). No keychain: the app is
// ad-hoc signed and must not prompt. The window never receives a whole key (providers.ts providerView: set or not, and
// the last four characters of a long one), and a key never reaches a log or an error text (scrubSecrets).

import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, NamedProviderConfig } from '../shared/types';
import { isRecord } from './json';
import { PRESETS } from './provider-presets';
import { bundledProviders } from './config';

/** A place a key can be kept: a field of config.json or of the user's settings.json (path from the top) */
export interface KeySpot {
  file: 'config' | 'settings';
  path: string[];
}

export interface KeyPlace {
  /** Where the key in effect comes from: the app's settings (config.json), your settings.json, your shell, a project's settings.json, or none */
  from: 'app' | 'settings' | 'shell' | 'project' | null;
  /** Where a key typed in the window is saved; null: it cannot be (a key from your shell, a service that takes none) */
  save: KeySpot | null;
  /** Where the key in effect is kept, when the app can take it away (your own files only) */
  remove: KeySpot | null;
}

const NONE: KeyPlace = { from: null, save: null, remove: null };
const fromOf = (spot: KeySpot): 'app' | 'settings' => (spot.file === 'config' ? 'app' : 'settings');

/**
 * Where `name`'s key is kept and where one would be saved. `owned`: the fields a settings file sets (SettingsLayer);
 * `envBy`: which file set a variable (none: a value comes from the shell); `bundled`: the bundle's named providers (config.ts).
 */
export function keyPlace(cfg: AppConfig, name: string, owned: Record<string, 'user' | 'project'>, envBy: Record<string, 'user' | 'project'>, env: NodeJS.ProcessEnv = process.env, bundled: Record<string, unknown> = bundledProviders()): KeyPlace {
  const envSpot = (v: string): KeySpot => ({ file: 'settings', path: ['env', v] });
  /** The key comes from variable `v` when it is set: your settings.json's env block (editable), a project's, or the shell */
  const fromVar = (v: string, newSpot: KeySpot | null): KeyPlace => {
    if (!env[v]) return { from: null, save: newSpot, remove: null };
    if (envBy[v] === 'user') return { from: 'settings', save: envSpot(v), remove: envSpot(v) };
    return { from: envBy[v] === 'project' ? 'project' : 'shell', save: null, remove: null };
  };

  if (name === 'ollama') return NONE;
  if (name === 'portkey') {
    const owner = owned['portkey.apiKey'];
    if (owner === 'project') return cfg.portkey?.apiKey ? { from: 'project', save: null, remove: null } : fromVar('PORTKEY_API_KEY', null);
    const field: KeySpot = { file: owner === 'user' ? 'settings' : 'config', path: ['portkey', 'apiKey'] };
    if (cfg.portkey?.apiKey) return { from: fromOf(field), save: field, remove: field };
    return fromVar('PORTKEY_API_KEY', field);
  }

  const entry = cfg.providers?.[name] as NamedProviderConfig | undefined;
  if (!entry || typeof entry !== 'object' || !PRESETS[entry.type]) return NONE;
  const preset = PRESETS[entry.type];
  // Ollama and LM Studio take no key; an OpenAI-compatible service or a Portkey entry may want one
  const takesKey = preset.keyRequired || Boolean(entry.apiKeyEnv) || entry.type === 'openai-compatible' || entry.type === 'portkey';
  if (!takesKey) return NONE;
  const variable = entry.apiKeyEnv || preset.keyEnv || '';
  const owner = owned[`providers.${name}`];
  if (owner === 'project') {
    // A project's entry: never written to. Its key comes from a variable; one typed here goes in your env block, and
    // only under the type's own variable (a name the project chose would hand your key to whatever reads it there)
    if (entry.apiKey) return { from: 'project', save: null, remove: null };
    if (!variable) return NONE;
    const place = fromVar(variable, variable === preset.keyEnv ? envSpot(variable) : null);
    return variable === preset.keyEnv ? place : { ...place, save: null };
  }
  const entrySpot: KeySpot = { file: owner === 'user' ? 'settings' : 'config', path: ['providers', name, 'apiKey'] };
  if (entry.apiKey) return { from: fromOf(entrySpot), save: entrySpot, remove: entrySpot };
  // The variable the entry names is where its key belongs; without one, the entry's own apiKey field. So is a variable
  // a bundled defaults.json named: your key goes in the entry's apiKey in config.json, not into every process the app starts
  if (!variable) return { from: null, save: entrySpot, remove: null };
  const bundledVar = isRecord(bundled[name]) && bundled[name].apiKeyEnv === entry.apiKeyEnv;
  return fromVar(variable, entry.apiKeyEnv && !bundledVar ? envSpot(entry.apiKeyEnv) : entrySpot);
}

/** A key as typed: trimmed; one line, no spaces, not absurdly long. Throws in plain words otherwise. */
export function cleanKey(raw: unknown): string {
  const k = String(raw ?? '').trim();
  if (!k) throw new Error('Paste the key.');
  if (/\s/.test(k)) throw new Error('A key has no spaces or line breaks.');
  if (k.length > 4096) throw new Error('That is too long for a key.');
  return k;
}

/**
 * Changes the user's settings.json: reads it (a missing or empty file is {}), lets `mutate` change the object and
 * writes it back atomically (a temporary file renamed over it), two-space JSON, owner-only (600), since it may hold a
 * key. A file that is not a JSON object is left alone and the change refused.
 */
export function editUserSettings(file: string, mutate: (data: Record<string, unknown>) => void): void {
  let data: Record<string, unknown> = {};
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read your settings.json (${(err as NodeJS.ErrnoException).code ?? 'error'}). Nothing was changed.`);
  }
  if (raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Your settings.json is not valid JSON. Fix it first; nothing was changed.');
    }
    if (!isRecord(parsed)) throw new Error('Your settings.json must hold a JSON object. Fix it first; nothing was changed.');
    data = parsed;
  }
  mutate(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A link (a dotfiles repo's settings.json) stays a link: the write goes to the file it points to
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    /* no file yet */
  }
  const tmp = path.join(path.dirname(target), `.settings.json.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // the mode applies only when the file is created; a stale temp file keeps its own
  fs.renameSync(tmp, target);
}

/** Sets (or, with undefined, deletes) the value at `keys` in a plain object, making the objects on the way. */
export function setIn(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isRecord(cur[k])) {
      if (value === undefined) return;
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

/** `cfg` with the field at `keys` set (or, undefined, deleted; the gateway's key is '' when it has none), copied on the way. */
export function configWith(cfg: AppConfig, keys: string[], value: string | undefined): AppConfig {
  const out = structuredClone(cfg) as unknown as Record<string, unknown>;
  if (keys.join('.') === 'portkey.apiKey') setIn(out, keys, value ?? '');
  else setIn(out, keys, value);
  return out as unknown as AppConfig;
}
