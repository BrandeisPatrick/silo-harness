import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, AutoModeConfig, PermissionMode } from '../shared/types';
import type { DreamingConfig } from '../shared/dreaming';
import type { BrowserConfig } from '../shared/browser';
import { DEFAULT_DREAMING } from './dreaming/names';
import { applySettings, withoutSettings } from './settings';
import { isRecord } from './json';
import { defaultWorkDir } from './paths';

/** Bumped when stored values change meaning: v2 renamed the old "auto" (run everything) to "bypass" and "readonly" to "plan". */
const SCHEMA_VERSION = 2;
const MODES: PermissionMode[] = ['ask', 'acceptEdits', 'auto', 'plan', 'bypass'];

export function defaultConfig(): AppConfig {
  return {
    provider: 'ollama',
    ollama: {
      baseURL: process.env.OLLAMA_HOST ? normalizeOllamaHost(process.env.OLLAMA_HOST) : 'http://localhost:11434/v1',
      model: 'qwen3:8b',
      numCtx: 16384,
      think: 'auto',
    },
    portkey: {
      baseURL: 'https://api.portkey.ai/v1',
      apiKey: '',
      model: '@openai/gpt-4o-mini',
      virtualKey: '',
      provider: '',
      providerApiKey: '',
      configId: '',
      contextWindow: 128000,
    },
    workingDirectory: defaultWorkDir(),
    permissionMode: 'ask',
    autoApprove: false,
    maxTurns: 40,
    sendScreenshotsToModel: false,
    systemPromptExtra: '',
    theme: 'system',
    autoTitles: true,
    mcpServers: {},
    mcpTrusted: {},
    mcpTrustedEntries: {},
    autoCompact: true,
    notifications: true,
    allowRules: {},
    recentDirs: [],
    keepAwake: 'running',
    compactThreshold: 0.8,
    pruneToolResults: true,
    toolSet: 'auto',
    toolActivity: 'summary',
    historyTrashDays: 30,
    mods: {
      enabled: {},
      disabledBundled: [],
      settings: {},
      layout: { railOpen: true, railWidth: 300, collapsed: [], closedTabs: [], background: null, backgroundImage: null, backgroundDim: 0.82, looks: { conversation: null, composer: null }, theme: null },
      safeMode: false,
    },
    remote: { enabled: false, bind: 'lan', port: 0 },
    settingsTrusted: {},
    dreaming: { ...DEFAULT_DREAMING },
    providers: {},
    browser: { keepCookies: true, downloadsDir: '', openChatLinksInPane: false, alwaysAllowed: [], sensitive: [], exempt: [] },
    autoMode: { environment: '', allow: [], model: '' },
  };
}

const MAX_RECENT = 8;

/**
 * The recent list with `dir` first, then the folder just left, then the others; the home folder and folders that no
 * longer exist are dropped, duplicates removed, at most MAX_RECENT kept.
 */
export function withRecentDir(list: string[] | undefined, dir: string, previous?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [dir, previous ?? '', ...(list ?? [])]) {
    if (!d || seen.has(d) || d === os.homedir()) continue;
    seen.add(d);
    try {
      if (fs.statSync(d).isDirectory()) out.push(d);
    } catch {
      /* gone */
    }
  }
  return out.slice(0, MAX_RECENT);
}

/** The mods section of a stored config over the defaults: an older file has none of it, a hand-edited one part of it. */
function modsSection(d: AppConfig['mods'], raw: unknown): AppConfig['mods'] {
  const m = isRecord(raw) ? raw : {};
  const layout = isRecord(m.layout) ? m.layout : {};
  const looks = isRecord(layout.looks) ? layout.looks : {};
  const ref = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    ...d,
    ...m,
    // A layout without `theme` is from 0.8.0 or before, when themes had switches: the mods code migrates it on start.
    layout: { ...d.layout, ...layout, looks: { conversation: ref(looks.conversation), composer: ref(looks.composer) }, theme: 'theme' in layout ? ref(layout.theme) : undefined },
  } as AppConfig['mods'];
}

function normalizeOllamaHost(host: string): string {
  let h = host.trim();
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, '') + '/v1';
}

/**
 * <userData>/config.json. Electron is loaded here only, and lazily, so the command-line tool (which runs without the
 * app) can use the rest of this file; it passes the path itself.
 */
export function configPath(): string {
  const { app } = require('electron') as typeof import('electron');
  return path.join(app.getPath('userData'), 'config.json');
}

/** Maps a stored mode (any version) to a current one. */
export function migrateMode(raw: unknown, autoApprove: unknown, schemaVersion: number): PermissionMode {
  let mode = typeof raw === 'string' ? raw : autoApprove ? 'bypass' : 'ask';
  if (mode === 'readonly') mode = 'plan';
  if (schemaVersion < SCHEMA_VERSION && mode === 'auto') mode = 'bypass'; // "auto" used to mean "run everything"
  return (MODES as string[]).includes(mode) ? (mode as PermissionMode) : 'ask';
}

/** config.json on its own, before any settings.json layer. */
function storedConfig(): AppConfig {
  return readStoredConfig(configPath());
}

/** A config.json file over the defaults (the defaults alone when it is missing or unreadable). */
export function readStoredConfig(file: string): AppConfig {
  const d = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppConfig> & { schemaVersion?: number };
    const version = Number(raw.schemaVersion) || 1;
    delete raw.schemaVersion;
    return normalizeConfig({
      ...d,
      ...raw,
      permissionMode: migrateMode(raw.permissionMode, raw.autoApprove, version),
      // Settings files written before generated titles existed have no flag: on by default.
      autoTitles: raw.autoTitles ?? d.autoTitles,
      autoCompact: raw.autoCompact ?? d.autoCompact,
      notifications: raw.notifications ?? d.notifications,
      allowRules: raw.allowRules && typeof raw.allowRules === 'object' && !Array.isArray(raw.allowRules) ? raw.allowRules : {},
      recentDirs: Array.isArray(raw.recentDirs) ? raw.recentDirs.filter((d): d is string => typeof d === 'string') : [],
      mcpServers: raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? raw.mcpServers : {},
      mcpTrusted: raw.mcpTrusted && typeof raw.mcpTrusted === 'object' && !Array.isArray(raw.mcpTrusted) ? raw.mcpTrusted : {},
      mcpTrustedEntries: isRecord(raw.mcpTrustedEntries) ? (raw.mcpTrustedEntries as Record<string, Record<string, string>>) : {},
      ollama: { ...d.ollama, ...(raw.ollama ?? {}) },
      portkey: { ...d.portkey, ...(raw.portkey ?? {}) },
      // Sections added after 0.1: an older file has none of them, a hand-edited one may have part of one.
      mods: modsSection(d.mods, raw.mods),
      remote: { ...d.remote, ...(isRecord(raw.remote) ? raw.remote : {}) },
      settingsTrusted: isRecord(raw.settingsTrusted) ? (raw.settingsTrusted as Record<string, string>) : {},
      dreaming: { ...d.dreaming, ...(isRecord(raw.dreaming) ? raw.dreaming : {}) },
      // Named providers are kept as written, even a broken one: resolving reports what is wrong with it.
      providers: isRecord(raw.providers) ? (raw.providers as AppConfig['providers']) : {},
      browser: normalizeBrowser(raw.browser),
    });
  } catch {
    return d;
  }
}

/**
 * config.json with the user's settings.json and then the project's (when trusted) applied over it, at launch.
 * Afterwards settings-service.ts recomputes the layer; saveConfig restores the fields a file owns before writing,
 * so neither the Settings panel nor a recompute can bake an override into config.json.
 */
export function loadConfig(): AppConfig {
  return withWorkDir(normalizeConfig(applySettings(storedConfig())));
}

/**
 * The Silo folder (~/Documents/Silo) is made if it is missing, and a session never starts in the bare home folder:
 * the old default, a folder that is gone, or none becomes the Silo folder. A folder the user chose stays.
 */
export function withWorkDir(cfg: AppConfig): AppConfig {
  const silo = defaultWorkDir();
  try {
    fs.mkdirSync(silo, { recursive: true });
  } catch (err) {
    console.warn('[config] could not make the Silo folder:', err instanceof Error ? err.message : String(err));
    return cfg;
  }
  const dir = cfg.workingDirectory;
  let usable = false;
  try {
    usable = Boolean(dir) && path.resolve(dir) !== os.homedir() && fs.statSync(dir).isDirectory();
  } catch {
    usable = false;
  }
  return usable ? cfg : { ...cfg, workingDirectory: silo };
}

/** "HH:MM" (24-hour) for a time of day: "3:00" and "03:00" are fine, anything else is not. */
export const TIME_OF_DAY_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** The dreaming section over the defaults, each field checked: a hand-edited or older file may have any of it. */
export function normalizeDreaming(raw: unknown): DreamingConfig {
  const d = DEFAULT_DREAMING;
  const r = isRecord(raw) ? raw : {};
  const t = typeof r.time === 'string' ? TIME_OF_DAY_RE.exec(r.time.trim()) : null;
  const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  return {
    daily: bool(r.daily, d.daily),
    time: t ? `${t[1].padStart(2, '0')}:${t[2]}` : d.time,
    mode: r.mode === 'auto' || r.mode === 'plan' || r.mode === 'approve' ? r.mode : d.mode,
    skills: bool(r.skills, d.skills),
    mods: bool(r.mods, d.mods),
    memory: bool(r.memory, d.memory),
  };
}

/** The browser section over its defaults: a file from before the Browser pane had a profile of its own has none. */
export function normalizeBrowser(raw: unknown): BrowserConfig {
  const r = isRecord(raw) ? raw : {};
  const list = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()))] : []);
  return {
    keepCookies: typeof r.keepCookies === 'boolean' ? r.keepCookies : true,
    downloadsDir: typeof r.downloadsDir === 'string' ? r.downloadsDir.trim() : '',
    openChatLinksInPane: r.openChatLinksInPane === true,
    alwaysAllowed: list(r.alwaysAllowed),
    sensitive: list(r.sensitive),
    exempt: list(r.exempt),
  };
}

/** autoMode as stored or hand-edited, over the defaults: free text, a list of rules, a model reference. */
export function normalizeAutoMode(raw: unknown): AutoModeConfig {
  const r = isRecord(raw) ? raw : {};
  return {
    environment: typeof r.environment === 'string' ? r.environment.trim() : '',
    allow: Array.isArray(r.allow) ? [...new Set(r.allow.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()))] : [],
    model: typeof r.model === 'string' ? r.model.trim() : '',
  };
}

/** Keeps the legacy autoApprove flag consistent with permissionMode, and autoTitles a boolean (default on). */
export function normalizeConfig(cfg: AppConfig): AppConfig {
  const mode: PermissionMode = (MODES as string[]).includes(cfg.permissionMode) ? cfg.permissionMode : 'ask';
  return { ...cfg, permissionMode: mode, autoApprove: mode === 'bypass', autoTitles: cfg.autoTitles !== false, toolActivity: cfg.toolActivity === 'all' ? 'all' : 'summary', dreaming: normalizeDreaming(cfg.dreaming), providers: isRecord(cfg.providers) ? cfg.providers : {}, browser: normalizeBrowser(cfg.browser), autoMode: normalizeAutoMode(cfg.autoMode) };
}

export function saveConfig(cfg: AppConfig): void {
  const stored = withoutSettings(cfg);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ ...stored, schemaVersion: SCHEMA_VERSION }, null, 2));
}
