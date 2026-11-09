// A Claude Code-style settings.json layer over the GUI's config.json.
//
//   <configDir>/settings.json                     user scope, always applied
//   <workingDirectory>/.silo-harness/settings.json   project scope (.open-harness/ when only that one is there), wins over user, applied only once trusted
//
// Precedence: defaults < config.json < user settings.json < project settings.json.
//
// A project file comes with whatever repository was cloned, so it is not applied until the user approves its exact
// content (config.settingsTrusted[cwd] holds the SHA-256 of what was approved); an edit withdraws the approval, the
// same way a project's .mcp.json servers stay off until enabled. Until then it is read and described, nothing more.
//
// Every value is validated against its field; a bad one is skipped and reported, the rest of the file still applies.
// `env` is applied to process.env before the file's strings are expanded (`${VAR}`, `${VAR:-default}`), and every
// recompute first restores the variables an earlier recompute set, so one project's variables never outlive it.
//
// Fields a file sets are owned by it: withoutSettings() puts them back to their stored values before config.json is
// written, so an override, or a secret, is never baked into config.json. A change made to an owned field while the
// app runs lives in memory until the next recompute applies the file again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../shared/types';
import type { SettingsFileInfo, SettingsInfo } from '../shared/settings-info';
import { ENV_NAME, expandEnvRefs } from './env';
import { isRecord } from './json';
import { between, bool, describe, kind, nonNegative, oneOf, positiveInt, str, stringList, timeOfDay, type Check } from './checks';
import { BUILT_IN_PROVIDERS, providerEntrySchema, validateProviderEntry } from './provider-presets';
import { configDir, projectConfigDir } from './paths';
import { hooksSchema, validateHooks } from './hooks/config';

type Scope = 'user' | 'project';

/** The user's settings.json (read on every call, so SILO_HARNESS_CONFIG_DIR may be set late). */
export function userSettingsPath(): string {
  return path.join(configDir(), 'settings.json');
}

/** A project's settings.json, whether or not it exists. */
export function projectSettingsPath(cwd: string): string {
  return path.join(projectConfigDir(cwd), 'settings.json');
}

/** The key settingsTrusted is indexed by. */
export function trustKey(cwd: string): string {
  return path.resolve(cwd);
}

export function contentHash(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

// ---------- The schema ----------

/** The provider in use: a built-in one or a key of `providers` (whether it exists is checked when it is resolved). */
const providerRef: Check = describe(
  Object.assign((v: unknown) => (typeof v === 'string' && v.trim() ? null : `expected the name of a provider ("ollama", "portkey" or a key of "providers"), got ${typeof v === 'string' ? 'an empty string' : kind(v)}`), { schema: { type: 'string', minLength: 1 } }),
  'The provider in use: "ollama", "portkey", or the name of an entry in "providers".',
);

/** Scalar AppConfig fields a settings file may set. */
const SCALARS: Record<string, Check> = {
  provider: providerRef,
  permissionMode: describe(oneOf('ask', 'acceptEdits', 'auto', 'plan', 'bypass'), 'The permission mode a session starts in.'),
  maxTurns: describe(positiveInt, 'How many tool calls one request may make before it stops and asks you to continue.'),
  sendScreenshotsToModel: describe(bool, 'Attach browser screenshots to the conversation as images (needs a vision model).'),
  systemPromptExtra: describe(str, 'Added to every request: house rules, coding style, project context.'),
  theme: describe(oneOf('system', 'light', 'dark'), 'The window theme.'),
  autoTitles: describe(bool, 'Name a session from its first exchange.'),
  autoCompact: describe(bool, 'Summarise the conversation on its own when it nears the context window.'),
  compactThreshold: describe(between(0.5, 0.95), 'How full the context window gets before the conversation is summarised.'),
  pruneToolResults: describe(bool, 'Shorten old tool results for the model: past 48K tokens, and before summarising.'),
  notifications: describe(bool, 'Notify when a run finishes or needs approval while the app is in the background.'),
  keepAwake: describe(oneOf('off', 'running', 'always'), 'Keep the Mac awake: never, while a session runs, or whenever the app is open.'),
  toolSet: describe(oneOf('auto', 'all', 'essential'), 'Which tools the model is offered.'),
  toolActivity: describe(oneOf('summary', 'all'), 'Fold each run of tool calls into one line, or show every call.'),
  historyTrashDays: describe(nonNegative, 'Days a deleted session stays in the trash.'),
};

/** Sections a settings file may set field by field. */
const SECTIONS: Record<'ollama' | 'portkey' | 'dreaming' | 'browser' | 'autoMode', Record<string, Check>> = {
  ollama: {
    baseURL: describe(str, "The Ollama server's OpenAI-compatible endpoint, e.g. http://localhost:11434/v1."),
    model: describe(str, 'The Ollama model tag, e.g. qwen3:8b.'),
    numCtx: describe(positiveInt, 'Tokens of context Ollama is asked for (num_ctx).'),
    think: describe(oneOf('auto', 'on', 'off'), 'Thinking mode for models that can reason.'),
  },
  portkey: {
    baseURL: describe(str, "The gateway endpoint (Portkey, or any OpenAI-compatible gateway). Not allowed in a project file."),
    apiKey: describe(str, 'The gateway key (x-portkey-api-key); falls back to PORTKEY_API_KEY. Not allowed in a project file.'),
    model: describe(str, 'The model id, e.g. @openai/gpt-4o-mini.'),
    virtualKey: describe(str, 'x-portkey-virtual-key'),
    provider: describe(str, 'x-portkey-provider'),
    providerApiKey: describe(str, "The upstream provider's key, sent as Authorization: Bearer. Not allowed in a project file."),
    configId: describe(str, 'x-portkey-config'),
    contextWindow: describe(positiveInt, "The model's context window in tokens."),
  },
  dreaming: {
    daily: describe(bool, 'Dream once a day.'),
    time: describe(timeOfDay, 'When, as "HH:MM" (24-hour).'),
    mode: describe(oneOf('auto', 'approve', 'plan'), 'How suggestions are applied.'),
    skills: describe(bool, 'Look for skills.'),
    mods: describe(bool, 'Look for mods.'),
    memory: describe(bool, 'Look for memory lines.'),
  },
  browser: {
    keepCookies: describe(bool, "Keep the Browser pane's cookies and site data when the app quits."),
    downloadsDir: describe(str, 'Where downloads are saved; empty for the Downloads folder.'),
    openChatLinksInPane: describe(bool, 'Open links from the chat in the Browser pane instead of the default browser.'),
    alwaysAllowed: describe(stringList, 'Sites the agent may use without asking (example.com, *.example.com, localhost:3000).'),
    sensitive: describe(stringList, 'Sites that always ask before the agent acts, beside the built-in list.'),
    exempt: describe(stringList, 'Hosts the agent may use freely, like localhost; a folder makes the files in it exempt.'),
  },
  autoMode: {
    environment: describe(str, "What Auto mode's safety check should know about this Mac, e.g. \"aisolutions-dev is a dev AWS account\". Your own settings.json only."),
    allow: describe(stringList, 'Plain-language rules the safety check allows, e.g. "Deploys to staging". Your own settings.json only.'),
    model: describe(str, 'The safety check\'s model: "<provider>:<model>" or a model id of the session\'s provider. Empty: the session\'s own model. Your own settings.json only.'),
  },
};

/** Fields of the built-in blocks that hold a secret: never shown, never accepted from a project's file. */
export const SECRET_FIELDS = ['portkey.apiKey', 'portkey.providerApiKey'];

/** Variable names that hold a secret by their look; a project's env block may not set them. */
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD)$/i;

/** Keys an editor puts in for itself; ignored without a complaint. */
const IGNORED = new Set(['$schema']);

/**
 * Checks one settable field path ("maxTurns", "ollama.model", "dreaming.time") the way a settings file is checked.
 * Returns null when the value is good, the reason otherwise; `unknown` when the path is not settable this way
 * (workingDirectory, env, providers have their own rules).
 */
export function checkSetting(p: string, value: unknown): string | null | 'unknown' {
  if (p === 'hooks') {
    const first = validateHooks(value).problems[0];
    return first ? `${first.key}: ${first.message}` : null;
  }
  if (p === 'disableAllHooks') return bool(value);
  const [a, b, ...rest] = p.split('.');
  if (rest.length) return 'unknown';
  if (b === undefined) return a in SCALARS ? SCALARS[a](value) : 'unknown';
  const sec = (SECTIONS as Record<string, Record<string, Check>>)[a];
  return sec && b in sec ? sec[b](value) : 'unknown';
}

/** Every field path checkSetting knows, in schema order. */
export function settableFields(): string[] {
  return [...Object.keys(SCALARS), ...Object.entries(SECTIONS).flatMap(([sec, fields]) => Object.keys(fields).map((f) => `${sec}.${f}`)), 'hooks', 'disableAllHooks'];
}

/** The JSON Schema of settings.json, built from the checks above (docs/settings.schema.json is this, written out). */
export function settingsSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    $schema: { type: 'string', description: 'The schema this file follows (for editors).' },
    env: { type: 'object', description: 'Environment variables set for the app before the rest of the file is read; keys can live here.', propertyNames: { pattern: ENV_NAME.source }, additionalProperties: { type: 'string' } },
    workingDirectory: { type: 'string', description: 'Your own settings.json only: the folder the app opens in.' },
  };
  for (const [k, c] of Object.entries(SCALARS)) properties[k] = c.schema;
  for (const [sec, fields] of Object.entries(SECTIONS)) {
    properties[sec] = { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(fields).map(([f, c]) => [f, c.schema])) };
  }
  properties.providers = {
    type: 'object',
    description: 'Named providers. "provider" selects one by its name. The names "ollama" and "portkey" are taken by the built-in blocks.',
    propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$', not: { enum: [...BUILT_IN_PROVIDERS] } },
    additionalProperties: providerEntrySchema(),
  };
  properties.hooks = hooksSchema();
  properties.disableAllHooks = { type: 'boolean', description: 'Turn off every hook from the settings files (mods\' hooks still run).' };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://brandeispatrick.github.io/silo-harness/settings.schema.json',
    title: 'Silo Harness settings.json',
    description: 'Settings for Silo Harness: ~/.silo-harness/settings.json (yours) and <project>/.silo-harness/settings.json (a project\'s, applied once you trust it). See https://github.com/BrandeisPatrick/silo-harness/blob/main/docs/configure.md',
    type: 'object',
    additionalProperties: false,
    properties,
  };
}

const rec = (o: object): Record<string, unknown> => o as unknown as Record<string, unknown>;
const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, os.homedir());
const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Reads a field path ("maxTurns", "portkey.model") of a config. */
function getPath(cfg: AppConfig, p: string): unknown {
  const [a, b] = p.split('.');
  const v = rec(cfg)[a];
  return b === undefined ? v : isRecord(v) ? v[b] : undefined;
}

/** A copy of `cfg` with one field path set; sections are copied, never shared. */
function setPath(cfg: AppConfig, p: string, value: unknown): AppConfig {
  const [a, b] = p.split('.');
  const out = { ...cfg };
  if (b === undefined) rec(out)[a] = value;
  else rec(out)[a] = { ...(isRecord(rec(cfg)[a]) ? (rec(cfg)[a] as object) : {}), [b]: value };
  return out;
}

// ---------- Reading one file ----------

interface Analysis {
  info: SettingsFileInfo;
  /** Valid field values, expanded, in file order */
  values: { path: string; value: unknown }[];
  /** user scope: the folder to open at launch */
  workingDirectory?: string;
}

/**
 * Reads and validates one file. `applyEnv` receives the valid `env` entries before strings are expanded, so the
 * expansion sees them (for an untrusted project file it does nothing: its strings expand against the env as it is).
 */
function analyse(file: string, scope: Scope, opts: { trustedHash?: string; applyEnv: (entries: [string, string][]) => void; willApply: (hash: string) => boolean }): Analysis {
  const info: SettingsFileInfo = { scope, path: file, exists: false, applied: false, trusted: scope === 'user', keys: [], invalid: [] };
  const out: Analysis = { info, values: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return out; // absent is the normal case
    info.exists = true;
    info.error = `could not be read (${code ?? (e instanceof Error ? e.message : String(e))})`;
    return out;
  }
  info.exists = true;
  const hash = contentHash(raw);
  if (scope === 'project') {
    info.trusted = opts.trustedHash === hash;
    if (opts.trustedHash && !info.trusted) info.changed = true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    info.error = `is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
    return out;
  }
  if (!isRecord(parsed)) {
    info.error = `must hold a JSON object ({ … }), not ${kind(parsed)}`;
    return out;
  }
  const apply = opts.willApply(hash);
  const bad = (key: string, message: string) => info.invalid.push({ key, message });

  // env first: the rest of the file's strings may refer to it.
  if (parsed.env !== undefined) {
    if (!isRecord(parsed.env)) bad('env', `expected an object of NAME: "value" pairs, got ${kind(parsed.env)}`);
    else {
      const entries: [string, string][] = [];
      for (const [name, v] of Object.entries(parsed.env)) {
        if (!ENV_NAME.test(name)) bad(`env.${name}`, 'not a valid variable name (letters, digits and _, not starting with a digit)');
        else if (scope === 'project' && SECRET_ENV.test(name)) bad(`env.${name}`, "a project's settings.json may not set a key variable; set it in your own settings.json or your environment");
        else if (typeof v !== 'string') bad(`env.${name}`, `expected a string, got ${kind(v)}`);
        else {
          entries.push([name, v]);
          info.keys.push(`env.${name}`);
        }
      }
      if (apply) opts.applyEnv(entries);
    }
  }
  const expand = (v: unknown): unknown => (typeof v === 'string' ? expandEnvRefs(v) : v);

  for (const [key, rawValue] of Object.entries(parsed)) {
    let value = rawValue;
    if (key === 'env' || IGNORED.has(key)) continue;
    if (key === 'workingDirectory') {
      if (scope === 'project') bad(key, "only your own settings.json can choose the folder the app opens in");
      else if (typeof value !== 'string') bad(key, `expected a path to a folder, got ${kind(value)}`);
      else {
        const dir = path.resolve(expandHome(expandEnvRefs(value)));
        if (!isDir(dir)) bad(key, 'no such folder');
        else {
          out.workingDirectory = dir;
          info.keys.push(key);
        }
      }
      continue;
    }
    if (key in SCALARS) {
      const v = expand(value);
      const msg = SCALARS[key](v);
      if (msg) bad(key, msg);
      else {
        out.values.push({ path: key, value: v });
        info.keys.push(key);
      }
      continue;
    }
    if (key === 'hooks') {
      // Read by the hooks engine itself (hooks/settings-source.ts), per session folder; here it is described and checked.
      const block = validateHooks(value);
      for (const pr of block.problems) bad(pr.key, pr.message);
      info.keys.push(...block.keys);
      if (block.commands.length) info.hookCommands = block.commands;
      continue;
    }
    if (key === 'disableAllHooks') {
      if (typeof value !== 'boolean') bad(key, `expected true or false, got ${kind(value)}`);
      else info.keys.push(key);
      continue;
    }
    if (key === 'providers') {
      if (!isRecord(value)) {
        bad(key, `expected an object of named providers, e.g. { "openrouter": { "type": "openrouter" } }, got ${kind(value)}`);
        continue;
      }
      for (const [name, raw] of Object.entries(value)) {
        const r = validateProviderEntry(name, raw, { scope, expand: expandEnvRefs });
        for (const pr of r.problems) bad(pr.key, pr.message);
        if (r.entry) {
          out.values.push({ path: `providers.${name}`, value: r.entry });
          info.keys.push(`providers.${name}`);
        }
      }
      continue;
    }
    if (key === 'portkey' && scope === 'project' && isRecord(value)) {
      // A repository must not carry or override a secret; the rest of the block applies.
      const block: Record<string, unknown> = { ...value };
      // The gateway key goes to portkey.baseURL: a project may not move it. Model, virtual key, provider slug and
      // config id still apply; they go to the address the user chose.
      if ('baseURL' in block) {
        bad('portkey.baseURL', "a project's settings.json may not change where the gateway key is sent; set the gateway's address in your own settings.json");
        delete block.baseURL;
      }
      for (const f of ['apiKey', 'providerApiKey']) {
        if (f in block) {
          bad(`portkey.${f}`, "a project's settings.json may not hold a key; set it in your own settings.json or with PORTKEY_API_KEY");
          delete block[f];
        }
      }
      value = block;
    }
    if (key === 'browser' && scope === 'project' && isRecord(value)) {
      // The sites the agent may use without asking, and the exempt hosts, decide where it acts unasked: the user's
      // alone. The rest of the block (cookies, the downloads folder, chat links, sites that always ask) applies.
      const block: Record<string, unknown> = { ...value };
      for (const f of ['alwaysAllowed', 'exempt']) {
        if (f in block) {
          bad(`browser.${f}`, "a project's settings.json may not choose where the agent acts without asking; add sites in Settings → Browser or your own settings.json");
          delete block[f];
        }
      }
      value = block;
    }
    if (key === 'autoMode' && scope === 'project') {
      // What the safety check allows and which model judges is the user's alone: a cloned repository could otherwise
      // allow its own actions, or send the conversation to a model of its choosing.
      bad(key, "a project's settings.json may not set autoMode; set it in your own settings.json");
      continue;
    }
    if (key === 'ollama' || key === 'portkey' || key === 'dreaming' || key === 'browser' || key === 'autoMode') {
      if (!isRecord(value)) {
        bad(key, `expected an object of ${key} fields, got ${kind(value)}`);
        continue;
      }
      const fields = SECTIONS[key];
      for (const [field, fv] of Object.entries(value)) {
        const p = `${key}.${field}`;
        if (!(field in fields)) {
          bad(p, `not a ${key} setting (known: ${Object.keys(fields).join(', ')})`);
          continue;
        }
        const v = expand(fv);
        const msg = fields[field](v);
        if (msg) bad(p, msg);
        else {
          out.values.push({ path: p, value: v });
          info.keys.push(p);
        }
      }
      continue;
    }
    bad(key, 'not a setting settings.json can change');
  }
  info.applied = apply;
  return out;
}

// ---------- The layer ----------

export interface LayerOptions {
  /** Default: userSettingsPath() at each read */
  userFile?: string;
}

/**
 * The settings.json layer: what the files set, which fields they own, the stored values of those fields and the
 * environment variables they changed. One instance serves the app (`settingsLayer`); tests make their own.
 */
export class SettingsLayer {
  /** The config without the layer: owned fields hold the values config.json keeps for them */
  private baseline: AppConfig | null = null;
  private ownedBy: Record<string, Scope> = {};
  private fileInfo: SettingsFileInfo[] = [];
  /** Variables a file set, with the value each had before any file touched it (undefined: it did not exist) */
  private envSaved = new Map<string, string | undefined>();
  private cwd = '';

  constructor(private readonly opts: LayerOptions = {}) {}

  userFile(): string {
    return this.opts.userFile ?? userSettingsPath();
  }

  /** The project file of a folder (default: the folder of the last recompute). */
  projectFile(cwd = this.cwd): string {
    return projectSettingsPath(cwd);
  }

  /** The folder the layer was last computed for. */
  folder(): string {
    return this.cwd;
  }

  /** At launch: config.json as stored, with the files applied. The user file's workingDirectory applies here only. */
  load(fromDisk: AppConfig): AppConfig {
    this.baseline = null;
    this.ownedBy = {};
    return this.compute(fromDisk, true);
  }

  /**
   * The current config with owned fields put back to their stored values and the files applied again for its
   * folder. Non-owned fields keep whatever they hold now.
   */
  recompute(current: AppConfig): AppConfig {
    return this.compute(current, false);
  }

  private compute(current: AppConfig, launch: boolean): AppConfig {
    const base = structuredClone(this.withoutSettings(current));
    this.restoreEnv();
    this.ownedBy = {};
    const applyEnv = (entries: [string, string][]) => {
      for (const [name, v] of entries) {
        if (!this.envSaved.has(name)) this.envSaved.set(name, process.env[name]);
        process.env[name] = expandEnvRefs(v);
      }
    };

    const userFile = this.userFile();
    const user = analyse(userFile, 'user', { applyEnv, willApply: () => true });
    let cfg: AppConfig = base;
    for (const { path: p, value } of user.values) {
      cfg = setPath(cfg, p, value);
      this.ownedBy[p] = 'user';
    }
    if (launch && user.workingDirectory) cfg = { ...cfg, workingDirectory: user.workingDirectory };

    this.cwd = trustKey(cfg.workingDirectory);
    const files = [user.info];
    const projectFile = this.projectFile();
    // A user file whose workingDirectory is its own config folder's parent would otherwise be read twice.
    if (path.resolve(projectFile) !== path.resolve(userFile)) {
      const trustedHash = (cfg.settingsTrusted ?? {})[this.cwd];
      const project = analyse(projectFile, 'project', { trustedHash, applyEnv, willApply: (hash) => trustedHash === hash });
      if (project.info.applied) {
        for (const { path: p, value } of project.values) {
          cfg = setPath(cfg, p, value);
          this.ownedBy[p] = 'project';
        }
      }
      files.push(project.info);
    }
    this.fileInfo = files;
    this.baseline = base;
    return cfg;
  }

  /** Puts every variable a file set back to what it was before. */
  restoreEnv(): void {
    for (const [name, prev] of this.envSaved) {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
    this.envSaved.clear();
  }

  /**
   * `current` with every owned field put back to its stored value: what config.json may hold. Returns `current`
   * itself when nothing is owned.
   */
  withoutSettings(current: AppConfig): AppConfig {
    const baseline = this.baseline;
    const paths = Object.keys(this.ownedBy);
    if (!baseline || !paths.length) return current;
    let out = current;
    for (const p of paths) out = setPath(out, p, getPath(baseline, p));
    return out;
  }

  /** `current` with the project file of its folder approved as it is on disk now (or the approval removed). */
  withTrust(current: AppConfig, trust: boolean): AppConfig {
    const key = trustKey(current.workingDirectory);
    const trusted = { ...(current.settingsTrusted ?? {}) };
    if (!trust) {
      delete trusted[key];
      return { ...current, settingsTrusted: trusted };
    }
    const file = projectSettingsPath(key);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      throw new Error(`This project has no settings file (${file}).`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object; fix it before approving it.`);
    trusted[key] = contentHash(raw);
    return { ...current, settingsTrusted: trusted };
  }

  /** The files and the fields they own. Keys only, never a value. */
  info(): SettingsInfo {
    return { files: this.fileInfo.map((f) => ({ ...f, keys: [...f.keys], invalid: f.invalid.map((i) => ({ ...i })) })), owned: { ...this.ownedBy } };
  }

  /** Field paths owned now, e.g. ["portkey.model"]. */
  owned(): string[] {
    return Object.keys(this.ownedBy);
  }
}

/** The app's layer: config.ts loads and saves through it, settings-service.ts recomputes it. */
export const settingsLayer = new SettingsLayer();

/** config.json as stored, with the settings files applied (launch). */
export function applySettings(fromDisk: AppConfig): AppConfig {
  return settingsLayer.load(fromDisk);
}

/** What config.json may hold for `current`: owned fields restored. */
export function withoutSettings(current: AppConfig): AppConfig {
  return settingsLayer.withoutSettings(current);
}
