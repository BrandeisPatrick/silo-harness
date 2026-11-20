// Feature: Settings. Keeps the settings.json layer (settings.ts) current while the app runs and answers the
// Settings page: which files are in play, whether the project's is trusted, which fields they own, facts about the app.
//
// The layer is recomputed when the folder changes, when either file changes on disk, when trust changes and on
// settings.reload. A recompute takes the app's config as it is at that moment, so a change made a moment ago to a
// field no file owns survives; the result becomes the app's config through app.updateConfig, whose save goes through
// withoutSettings, so an owned value never reaches config.json.
import { app as electronApp, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../shared/types';
import type { AppInfo, SettingsInfo } from '../shared/settings-info';
import type { App } from './app';
import { normalizeConfig } from './config';
import { configDir } from './paths';
import { settingsLayer, type SettingsLayer } from './settings';
import { windowConfig } from './providers';

export interface SettingsServiceOptions {
  /** Default: the app's layer, the one config.ts loads and saves through */
  layer?: SettingsLayer;
  /** How often the files are polled for changes (ms). fs.watchFile also sees files that do not exist yet. */
  pollMs?: number;
  /** Quiet time after a change on disk before the layer is recomputed (ms) */
  debounceMs?: number;
  /** Opens a file or folder with the system (default: Electron's shell.openPath) */
  openPath?: (p: string) => Promise<string>;
}

export interface SettingsHandle {
  recompute(): SettingsInfo;
  dispose(): void;
}

/** The running feature's recompute, for a change the app itself made to your settings.json (providers-service.ts) */
let recomputeNow: (() => SettingsInfo) | null = null;

/** Reads the settings files again at once and applies them; false when the settings feature is not running. */
export function reloadSettingsNow(): boolean {
  if (!recomputeNow) return false;
  recomputeNow();
  return true;
}

/** Order-insensitive deep equality of two JSON-like values. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Electron's shell, or null under plain Node (the headless suites), where require('electron') is a path string. */
const electronShell = (): typeof shell | null => (shell && typeof shell.openPath === 'function' ? shell : null);

export function setupSettings(app: App, opts: SettingsServiceOptions = {}): SettingsHandle {
  const layer = opts.layer ?? settingsLayer;
  const pollMs = opts.pollMs ?? 500;
  const debounceMs = opts.debounceMs ?? 150;
  const openPath =
    opts.openPath ??
    (async (p: string) => {
      const sh = electronShell();
      if (!sh) throw new Error('Opening files needs the app window.');
      return sh.openPath(p);
    });

  const watched = new Map<string, () => void>();
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;
  const reported = new Set<string>();

  const onDisk = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!disposed) recompute();
    }, debounceMs);
  };
  /** Watches exactly the user file and the current folder's project file. */
  const syncWatches = () => {
    const want = new Set([layer.userFile(), layer.projectFile()].map((f) => path.resolve(f)));
    for (const [file, stop] of watched) {
      if (!want.has(file)) {
        stop();
        watched.delete(file);
      }
    }
    for (const file of want) {
      if (watched.has(file)) continue;
      const listener = (cur: fs.Stats, prev: fs.Stats) => {
        if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size || cur.ino !== prev.ino) onDisk();
      };
      fs.watchFile(file, { interval: pollMs, persistent: false }, listener);
      watched.set(file, () => fs.unwatchFile(file, listener));
    }
  };

  /** Logs each problem once, so a broken file is visible in the log without repeating on every poll. */
  const report = (info: SettingsInfo) => {
    for (const f of info.files) {
      const lines = [...(f.error ? [`${f.path} ${f.error}`] : []), ...f.invalid.map((i) => `${f.path}: ${i.key}: ${i.message}`)];
      for (const line of lines) {
        if (reported.has(line)) continue;
        reported.add(line);
        console.warn(`[settings] ${line}`);
      }
    }
  };

  /**
   * Recomputes the layer over the app's config (after `change`, if given) and makes the result the app's config.
   * Pushes settings:changed when the files' description or the effective config changed.
   */
  function recompute(change?: (cfg: AppConfig) => AppConfig): SettingsInfo {
    const before = layer.info();
    const cur = app.config();
    const next = normalizeConfig(layer.recompute(change ? change(cur) : cur));
    syncWatches();
    const info = layer.info();
    report(info);
    const configChanged = !same(next, cur);
    if (configChanged) app.updateConfig(() => next);
    if (configChanged || !same(info, before)) app.push('settings:changed', info);
    // The files changed but the config did not (an env block, which fields are owned): the window's resolved
    // providers (key set or not, who owns an entry) may still have changed.
    if (!configChanged && !same(info, before)) app.push('config:changed', windowConfig(app.config(), info.owned, layer.envOwners()));
    return info;
  }

  // A folder change (from the UI, or following the session brought on screen) or a trust change made elsewhere.
  // Deferred to a microtask: recomputing inside another updateConfig's listeners would hand the listeners after
  // this one, and the window, the outer change's config after ours.
  let queued = false;
  const offConfig = app.onConfig((next, prev) => {
    if (next.workingDirectory === prev.workingDirectory && same(next.settingsTrusted, prev.settingsTrusted)) return;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disposed) recompute();
    });
  });

  const disposers = [
    offConfig,
    app.rpc.handle('settings.info', () => layer.info()),
    app.rpc.handle('settings.trustProject', (trust) => recompute((cfg) => layer.withTrust(cfg, Boolean(trust)))),
    app.rpc.handle('settings.reload', () => recompute()),
    app.rpc.handle('settings.open', async (scope) => {
      const file = scope === 'project' ? layer.projectFile(app.config().workingDirectory) : layer.userFile();
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{}\n', { flag: 'wx' });
      }
      const err = await openPath(file);
      if (err) throw new Error(`Could not open ${file}: ${err}`);
    }),
    app.rpc.handle('app.info', () => appInfo(app)),
    app.rpc.handle('app.reveal', async (which) => {
      // skills: your own skills folder (made when it is not there yet, so the button always opens something)
      const dir = which === 'userData' ? app.userData : which === 'project' ? app.config().workingDirectory : which === 'skills' ? path.join(configDir(), 'skills') : configDir();
      fs.mkdirSync(dir, { recursive: true });
      const err = await openPath(dir);
      if (err) throw new Error(`Could not open ${dir}: ${err}`);
    }),
  ];

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (recomputeNow === mine) recomputeNow = null;
    if (timer) clearTimeout(timer);
    for (const stop of watched.values()) stop();
    watched.clear();
    for (const d of disposers) d();
  };
  app.onQuit(dispose);

  const mine = () => recompute();
  recomputeNow = mine;

  // config.ts applied the files at launch; this picks up a layer that was not loaded through it and starts the watches.
  recompute();
  return { recompute: () => recompute(), dispose };
}

function appInfo(app: App): AppInfo {
  const ea = electronApp && typeof electronApp.getVersion === 'function' ? electronApp : null;
  let version = ea?.getVersion() ?? '';
  if (!version) {
    try {
      version = String(JSON.parse(fs.readFileSync(path.join(app.appRoot, 'package.json'), 'utf8')).version ?? '');
    } catch {
      /* unknown */
    }
  }
  return {
    name: ea?.getName() ?? 'Silo Harness',
    version,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    userData: app.userData,
    configDir: configDir(),
  };
}
