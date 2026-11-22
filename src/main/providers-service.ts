// Feature: providers. What the window asks about providers beyond the config itself (which already carries them
// resolved, see windowConfig in providers.ts): the models one offers, choosing a model, a quick test; and the
// command-line tool's row in Settings → Developer → This Mac, which links the bundled `silo` into ~/.local/bin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliStatus } from '../shared/providers';
import type { App } from './app';
import { loginPath } from './mcp';
import type { EffortLevel } from '../shared/types';
import { isEffortLevel } from './agent/effort';
import { listModels, providerCatalog, providerNames, providerView, resolveProvider, testProvider, withModel } from './providers';
import { envVar } from './paths';
import type { AddProviderInput, AddProviderResult, ProviderPresetInfo } from '../shared/providers';
import type { AppConfig, NamedProviderConfig, ProviderType } from '../shared/types';
import { cleanKey, configWith, editUserSettings, keyPlace, setIn, type KeySpot } from './provider-keys';
import { PRESETS, PROVIDER_TYPES, providerNameProblem, validateProviderEntry } from './provider-presets';
import { settingsLayer } from './settings';
import { reloadSettingsNow } from './settings-service';
import { isRecord } from './json';
import { bundledProviders } from './config';

/** The command's name (it was open-harness before the rename) */
export const CLI_NAME = 'silo';

export interface ProvidersServiceOptions {
  /** The folder the link goes in (default: SILO_HARNESS_CLI_LINK_DIR, else OPEN_HARNESS_CLI_LINK_DIR, else ~/.local/bin) */
  linkDir?: string;
  /** The command the link points at (default: the app's bin/silo) */
  command?: string;
  /** The PATH of a login shell (default: mcp.ts loginPath) */
  pathOf?: () => Promise<string>;
}

/** The bundled command: Contents/Resources/bin/silo in the app, bin/silo in a checkout. */
export function cliCommandPath(appRoot: string): string {
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = res ? path.join(res, 'bin', CLI_NAME) : '';
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(appRoot, 'bin', CLI_NAME);
}

/**
 * The link the app made under the command's old name (open-harness, pointing at an app's bin/open-harness): taken
 * away once the new one is in, since it stops working when the old app is deleted. Anything else there is left alone.
 */
export function removeOldLink(dir: string): void {
  const old = path.join(dir, 'open-harness');
  try {
    if (fs.lstatSync(old).isSymbolicLink() && fs.readlinkSync(old).endsWith(path.join('bin', 'open-harness'))) fs.unlinkSync(old);
  } catch {
    /* nothing there */
  }
}

/** How the window names each level */
const EFFORT_WORDS: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export function setupProviders(app: App, opts: ProvidersServiceOptions = {}): () => void {
  const linkDir = () => opts.linkDir ?? (envVar('CLI_LINK_DIR') || path.join(os.homedir(), '.local', 'bin'));
  const command = () => opts.command ?? cliCommandPath(app.appRoot);
  const pathOf = opts.pathOf ?? loginPath;

  async function status(): Promise<CliStatus> {
    const cmd = command();
    const link = path.join(linkDir(), CLI_NAME);
    let installed = false;
    let conflict: string | undefined;
    try {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink()) {
        const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
        if (target === path.resolve(cmd)) installed = true;
        else conflict = `${link} already links to ${target}`;
      } else conflict = `${link} already exists and is not a link`;
    } catch {
      /* nothing there */
    }
    let onPath = false;
    try {
      const dirs = (await pathOf()).split(':').map((d) => path.resolve(d.replace(/^~(?=\/|$)/, os.homedir())));
      onPath = dirs.includes(path.resolve(linkDir()));
    } catch {
      onPath = false;
    }
    return { command: cmd, available: fs.existsSync(cmd), link, installed, ...(conflict ? { conflict } : {}), onPath };
  }

  const disposers = [
    app.rpc.handle('providers.models', async (name) => listModels(resolveProvider(app.config(), String(name || app.config().provider)))),
    app.rpc.handle('providers.setModel', async (name, model) => {
      const n = String(name || app.config().provider);
      const m = String(model ?? '').trim();
      if (!m) throw new Error('Choose a model.');
      if (n !== 'ollama' && n !== 'portkey' && !app.config().providers?.[n]) throw new Error(`There is no provider named "${n}".`);
      await writeField(n === 'ollama' ? ['ollama', 'model'] : n === 'portkey' ? ['portkey', 'model'] : ['providers', n, 'model'], m);
    }),
    app.rpc.handle('providers.use', async (name) => {
      const n = String(name ?? '');
      if (!providerNames(app.config()).includes(n)) throw new Error(`There is no provider named "${n}".`);
      if (app.config().provider !== n) await writeField(['provider'], n);
    }),
    app.rpc.handle('providers.setKey', async (name, key) => {
      const n = String(name ?? '');
      const k = cleanKey(key);
      const place = placeOf(n);
      if (!place.save) throw new Error(lockedKeyWords(n, place.from));
      await writeSpot(place.save, k);
    }),
    app.rpc.handle('providers.removeKey', async (name) => {
      const n = String(name ?? '');
      const place = placeOf(n);
      if (!place.remove) throw new Error(place.from ? lockedKeyWords(n, place.from) : 'There is no key to remove.');
      await writeSpot(place.remove, undefined);
    }),
    app.rpc.handle('providers.presets', () => presets()),
    app.rpc.handle('providers.add', (input) => addProvider(input)),
    app.rpc.handle('providers.remove', (name) => removeProvider(String(name ?? ''))),
    app.rpc.handle('providers.setEffort', (name, level) => setEffort(String(name || app.config().provider), level)),
    app.commands.register({
      name: 'effort',
      description: 'Reasoning effort for this provider',
      argsHint: '<low|medium|high|xhigh|max|default>',
      source: 'app',
      run: (args) => effortCommand(args),
    }),
    app.rpc.handle('providers.catalog', async (name) => providerCatalog(resolveProvider(app.config(), String(name || app.config().provider || 'ollama')))),
    // With a model, that model of that provider (Settings → Models tests each row): only ever on a click, never on its own
    app.rpc.handle('providers.test', async (name, model) => {
      const cfg = app.config();
      const n = name ? String(name) : cfg.provider || 'ollama';
      const m = typeof model === 'string' ? model.trim() : '';
      return testProvider(resolveProvider(m ? withModel(cfg, n, m) : cfg, n));
    }),
    app.rpc.handle('cli.status', () => status()),
    app.rpc.handle('cli.install', async () => {
      const s = await status();
      if (!s.available) throw new Error(`The command is not in this copy of the app (${s.command}).`);
      if (s.installed) return s;
      if (s.conflict) throw new Error(`${s.conflict}. Remove it first, then try again.`);
      fs.mkdirSync(path.dirname(s.link), { recursive: true });
      fs.symlinkSync(s.command, s.link);
      removeOldLink(path.dirname(s.link));
      return status();
    }),
    app.rpc.handle('cli.uninstall', async () => {
      const s = await status();
      // Only our own link is removed, never a file or a link someone else put there.
      if (s.installed) fs.unlinkSync(s.link);
      return status();
    }),
  ];
  // ---------- Writing where a setting lives ----------

  const userFile = () => settingsLayer.userFile();
  const owned = () => settingsLayer.info().owned;
  /** The file that sets `keys` (or a field above it), if one does */
  const ownerOf = (keys: string[]): 'user' | 'project' | undefined => {
    const o = owned();
    for (let i = keys.length; i > 0; i--) {
      const hit = o[keys.slice(0, i).join('.')];
      if (hit) return hit;
    }
    return undefined;
  };

  /** Reads the settings files again (settings-service.ts), so a change to your settings.json applies at once. */
  async function reloadSettings(): Promise<void> {
    // Without the settings feature (a headless suite): recompute the layer here
    if (!reloadSettingsNow()) app.updateConfig((c) => settingsLayer.recompute(c));
  }

  async function writeSpot(spot: KeySpot, value: string | undefined): Promise<void> {
    if (spot.file === 'settings') {
      editUserSettings(userFile(), (d) => setIn(d, spot.path, value));
      await reloadSettings();
    } else app.updateConfig((c) => configWith(c, spot.path, value));
  }

  /**
   * Sets one field where it lives: in your settings.json when that file sets it (or a field above it), refused when a
   * project's settings.json does, else in the app's settings (config.json).
   */
  async function writeField(keys: string[], value: string): Promise<void> {
    const owner = ownerOf(keys);
    if (owner === 'project') throw new Error("This project's settings.json sets this. Change it there.");
    if (owner === 'user') await writeSpot({ file: 'settings', path: keys }, value);
    else await writeSpot({ file: 'config', path: keys }, value);
  }

  const placeOf = (n: string) => {
    if (!providerNames(app.config()).includes(n)) throw new Error(`There is no provider named "${n}".`);
    return keyPlace(app.config(), n, owned(), settingsLayer.envOwners());
  };

  /** Why a key cannot be saved or removed here, in plain words */
  function lockedKeyWords(n: string, from: string | null): string {
    const r = resolveProvider(app.config(), n);
    if (from === 'shell') return `This key comes from your shell (${r.keySource}). Change it there.`;
    if (from === 'project') return `This key comes from this project's settings.json (${r.keySource}). Change it there.`;
    return `${r.label} takes no key.`;
  }

  // ---------- Adding and removing providers ----------

  function presets(): ProviderPresetInfo[] {
    return PROVIDER_TYPES.map((type) => {
      const p = PRESETS[type];
      return { type, label: p.label, keyRequired: p.keyRequired, ...(p.keyEnv ? { keyEnv: p.keyEnv } : {}), keyInEnv: Boolean(p.keyEnv && process.env[p.keyEnv]), baseURL: p.baseURL };
    });
  }

  /** Puts `n` in use when the provider is not chosen by a project's file; says why not otherwise. */
  async function select(n: string): Promise<AddProviderResult> {
    if (ownerOf(['provider']) === 'project') return { name: n, selected: false, note: "This project's settings.json chooses the provider." };
    if (app.config().provider !== n) await writeField(['provider'], n);
    return { name: n, selected: true };
  }

  async function addProvider(input: AddProviderInput): Promise<AddProviderResult> {
    const type = String(input?.type ?? '') as ProviderType;
    const preset = PRESETS[type];
    if (!preset) throw new Error('Choose a type.');
    const key = String(input?.apiKey ?? '').trim() ? cleanKey(input.apiKey) : '';
    // Ollama: the built-in one, nothing to add
    if (type === 'ollama') return select('ollama');
    // A gateway, while the built-in block has no key: the key goes in the block, which is put in use
    if (type === 'portkey') {
      const block = keyPlace(app.config(), 'portkey', owned(), settingsLayer.envOwners());
      if (!block.from && block.save) {
        if (!key) throw new Error('Paste the key.');
        await writeSpot(block.save, key);
        return select('portkey');
      }
    }
    const name = String(input?.name ?? '').trim();
    if (!name) throw new Error('Name it.');
    const bad = providerNameProblem(name);
    if (bad) throw new Error(bad[0].toUpperCase() + bad.slice(1) + '.');
    if (app.config().providers?.[name] !== undefined) throw new Error(`There is already a provider named "${name}".`);
    const entry: Record<string, unknown> = { type };
    if (type === 'openai-compatible') {
      const url = String(input?.baseURL ?? '').trim();
      if (!url) throw new Error('Enter the base URL.');
      entry.baseURL = url;
    }
    if (key) entry.apiKey = key;
    else if (preset.keyRequired && !(preset.keyEnv && process.env[preset.keyEnv])) throw new Error('Paste the key.');
    const { entry: valid, problems } = validateProviderEntry(name, entry, { scope: 'user' });
    if (!valid || problems.length) throw new Error(`${(problems[0]?.message ?? 'That entry is not valid').replace(/^./, (c) => c.toUpperCase())}.`);
    editUserSettings(userFile(), (d) => {
      if (!isRecord(d.providers)) d.providers = {};
      const providers = d.providers as Record<string, unknown>;
      if (providers[name] !== undefined) throw new Error(`There is already a provider named "${name}" in your settings.json.`);
      providers[name] = entry;
    });
    await reloadSettings();
    if (!app.config().providers?.[name]) throw new Error('Your settings.json was saved, but the provider did not load. Check the file under Developer.');
    return select(name);
  }

  async function removeProvider(n: string): Promise<void> {
    const cfg = app.config();
    if (n === 'ollama' || n === 'portkey') throw new Error('A built-in provider cannot be removed.');
    if (!cfg.providers?.[n]) throw new Error(`There is no provider named "${n}".`);
    const owner = owned()[`providers.${n}`];
    if (owner === 'project') throw new Error("This provider comes from this project's settings.json. Remove it there.");
    // It would come back at the next launch
    if (owner !== 'user' && n in bundledProviders()) throw new Error(`"${n}" comes with this copy of the app and cannot be removed.`);
    // The one in use goes: the first other provider that is ready takes its place (else Ollama)
    if ((cfg.provider || 'ollama') === n) {
      const next = providerNames(cfg).find((x) => x !== n && !resolveProvider(cfg, x).error) ?? 'ollama';
      if (ownerOf(['provider']) !== 'project') await writeField(['provider'], next);
    }
    if (owner === 'user') {
      editUserSettings(userFile(), (d) => {
        if (isRecord(d.providers)) delete (d.providers as Record<string, unknown>)[n];
      });
      await reloadSettings();
    } else
      app.updateConfig((c: AppConfig) => {
        const providers = { ...(c.providers ?? {}) } as Record<string, NamedProviderConfig>;
        delete providers[n];
        return { ...c, providers };
      });
  }

  /** Stores the effort of a provider entry (null: none, the model's default). */
  function setEffort(n: string, level: EffortLevel | null): void {
    if (level !== null && !isEffortLevel(level)) throw new Error('Choose low, medium, high, xhigh or max.');
    app.updateConfig((c) => {
      const entry = c.providers?.[n];
      if (!entry) throw new Error(`Effort is set per provider entry; "${n}" has none.`);
      const { effort: _old, ...rest } = entry;
      return { ...c, providers: { ...c.providers, [n]: level ? { ...rest, effort: level } : rest } };
    });
  }

  /** /effort [level]: shows or sets the effort of the provider in use. */
  function effortCommand(args: string): { notice?: string; error?: string } {
    const name = app.config().provider || 'ollama';
    const view = providerView(resolveProvider(app.config(), name));
    const info = view.effort;
    if (!info) return { error: `${view.model || view.label} takes no effort setting.` };
    const word = args.trim().toLowerCase().replace(/[\s_-]+/g, '');
    const label = (l: EffortLevel | null) => (l ? EFFORT_WORDS[l] : 'Default');
    if (!word) return { notice: `Effort: ${label(info.chosen ?? info.default)}. Levels: ${info.levels.join(', ')}, default.` };
    const level = word === 'default' || word === 'auto' ? null : word === 'extrahigh' ? 'xhigh' : word;
    if (level !== null && !isEffortLevel(level)) return { error: `Unknown level "${args.trim()}". Use ${info.levels.join(', ')} or default.` };
    try {
      setEffort(name, level);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const now = providerView(resolveProvider(app.config(), name)).effort;
    return { notice: `Effort: ${label(now?.chosen ?? now?.default ?? null)}.` };
  }

  const dispose = () => {
    for (const d of disposers) d();
  };
  app.onQuit(dispose);
  return dispose;
}
