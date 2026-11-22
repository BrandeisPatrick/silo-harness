#!/usr/bin/env node
// silo: set Silo Harness up from the command line, without the app's window (and without the app running).
// It reads and writes your settings.json (~/.silo-harness/settings.json, or SILO_HARNESS_CONFIG_DIR), keeping every
// key it does not know about; the running app sees the change within a second. It reads config.json (the window's
// settings) to tell what the app would use. The rules are the app's own: this script loads the built app (dist/).
//
// Run `silo --help`. In the app it is Contents/Resources/bin/silo; in a checkout `node bin/silo.js`.
// It was called open-harness before the app was renamed; the old folders and variables are still read.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Inside the app this script is Resources/app.asar/bin/silo.js: a repackaged app's defaults.json sits in Resources, and
// there is no Electron main process here to say so (the app finds it from process.resourcesPath).
if (!process.env.SILO_HARNESS_DEFAULTS && path.basename(path.join(__dirname, '..')) === 'app.asar') {
  process.env.SILO_HARNESS_DEFAULTS = path.join(__dirname, '..', '..', 'defaults.json');
}

const DIST = path.join(__dirname, '..', 'dist', 'main');
function load(name) {
  try {
    return require(path.join(DIST, name));
  } catch (err) {
    fail(`could not load the app's code (${path.join(DIST, name)}): ${err && err.message}. In a checkout, run npm run build first.`, 1);
  }
}

// ---------- Output ----------

let JSON_OUT = false;
class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
function fail(message, code = 1) {
  throw new CliError(message, code);
}
function emit(human, data) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, ...data }, null, 2) + '\n');
  else if (human) process.stdout.write(human.replace(/\n?$/, '\n'));
}

// ---------- Help ----------

const HELP = {
  main: `silo: configure Silo Harness from a file or the command line.

Usage: silo <command> [options]

Providers
  provider list                      every provider, the one in use marked with *
  provider add <name> --type <type>  add a named provider to your settings.json
  provider remove <name>             remove one
  provider use <name> [--model <id>] use it (and set its model)
  provider test [<name>]             one tiny chat completion: ok, the model and the time it took

Settings
  config path                        where settings.json and config.json are
  config get [<key>]                 what the app uses (keys are never shown)
  config set <key> <value>           set a field in your settings.json (checked like the app checks it)
  config unset <key>                 remove it from your settings.json

  doctor                             what the app would use right now, and what is wrong

Options on every command
  --json     machine-readable output: {"ok": true, ...} or {"ok": false, "error": "..."}
  --help     help for a command

A key is never taken from the command line (it would stay in your shell history): name its variable with
--key-env, or pipe it in with --key-stdin. See https://github.com/BrandeisPatrick/silo-harness/blob/main/docs/configure.md`,
  provider: `Usage: silo provider <list|add|remove|use|test> ...

  provider list
  provider add <name> --type <type> [--base-url <url>] [--key-env <VAR> | --key-stdin] [--model <id>]
               [--models <id,id,...>] [--header Name=Value]... [--label <text>] [--context-window <tokens>]
               [--max-output <tokens>] [--virtual-key <vk>] [--portkey-config <id>] [--portkey-provider <slug>]
               [--num-ctx <tokens>] [--think auto|on|off] [--use] [--replace]
  provider remove <name>
  provider use <name> [--model <id>]
  provider test [<name>]

Types: TYPES`,
  'provider add': `Usage: silo provider add <name> --type <type> [options]

Adds a named provider to your settings.json ("providers": { "<name>": { ... } }).

  --type <type>            TYPES
  --base-url <url>         the OpenAI-compatible endpoint (required for openai-compatible; others have one)
  --key-env <VAR>          the environment variable that holds the key (default: the type's, e.g. OPENROUTER_API_KEY)
  --key-stdin              read the key from standard input and store it as apiKey in your settings.json
  --model <id>             the model to run
  --models <id,id,...>     models to offer in the window's picker
  --header Name=Value      an extra request header (repeat it; \${VAR} in the value is expanded by the app)
  --label <text>           how the window names it
  --context-window <n>     the model's context window in tokens (default 128000)
  --max-output <n>         most tokens one reply may have (max_tokens)
  --virtual-key <vk>       portkey: x-portkey-virtual-key
  --portkey-config <id>    portkey: x-portkey-config
  --portkey-provider <s>   portkey: x-portkey-provider
  --num-ctx <n>            ollama: num_ctx
  --think auto|on|off      ollama: thinking mode
  --use                    also make it the provider in use
  --replace                replace an entry of that name instead of refusing

The names "ollama" and "portkey" belong to the built-in providers.`,
  'provider remove': 'Usage: silo provider remove <name>\n\nRemoves a named provider from your settings.json. If it was the provider in use there, that choice is removed too.',
  'provider use': 'Usage: silo provider use <name> [--model <id>]\n\nMakes <name> the provider in use ("provider" in your settings.json). With --model, also sets its model.',
  'provider test': 'Usage: silo provider test [<name>]\n\nSends one tiny chat completion through the provider (default: the one in use) and says ok with the model and the\ntime it took, or the service\'s error in plain words. Exit code 0 when it answered.',
  'provider list': 'Usage: silo provider list\n\nEvery provider: the two built-in ones (ollama, portkey) and every named one. * marks the one in use.',
  config: `Usage: silo config <path|get|set|unset> ...

  config path                  where settings.json (yours) and config.json (the window's) are
  config get [<key>]           a field the app uses, or all of them; keys show as set / not set
  config set <key> <value>     e.g. config set theme dark, config set maxTurns 60, config set ollama.model qwen3:8b
  config set <key> --stdin     for a secret (portkey.apiKey, portkey.providerApiKey, env.SOME_KEY): read from standard input
  config unset <key>

Keys: KEYS, env.<NAME>, workingDirectory. Providers are changed with "silo provider".`,
  doctor: 'Usage: silo doctor\n\nWhat the app would use right now (files, provider, model, key set or not) and what is wrong, if anything.\nExit code 0 when the provider in use can be used.',
};

function helpFor(topic) {
  const { PROVIDER_TYPES } = load('provider-presets.js');
  const { settableFields } = load('settings.js');
  return (HELP[topic] || HELP.main).replace('TYPES', PROVIDER_TYPES.join(', ')).replace('KEYS', settableFields().join(', '));
}

// ---------- Arguments ----------

const VALUE_FLAGS = new Set(['type', 'base-url', 'key-env', 'model', 'models', 'header', 'label', 'context-window', 'max-output', 'virtual-key', 'portkey-config', 'portkey-provider', 'num-ctx', 'think']);
const BOOL_FLAGS = new Set(['key-stdin', 'json', 'help', 'use', 'replace', 'stdin', 'version']);
/** Flags that would carry a secret: refused outright. */
const SECRET_FLAGS = new Set(['key', 'api-key', 'apikey', 'token', 'secret']);

function parseArgs(argv) {
  const pos = [];
  const flags = { header: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h') {
      flags.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (SECRET_FLAGS.has(name)) fail(`--${name}: a key is never taken from the command line (it would stay in your shell history). Use --key-env <VAR> or --key-stdin.`, 2);
    if (BOOL_FLAGS.has(name)) {
      if (value !== undefined) fail(`--${name} takes no value`, 2);
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) fail(`--${name} needs a value`, 2);
      }
      if (name === 'header') flags.header.push(value);
      else flags[name] = value;
    } else fail(`unknown option --${name} (see --help)`, 2);
  }
  return { pos, flags };
}

const int = (flag, v) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail(`--${flag}: expected a whole number above 0, got "${v}"`, 2);
  return n;
};

// ---------- Files ----------

function settingsFile() {
  return load('settings.js').userSettingsPath();
}

/**
 * config.json: SILO_HARNESS_USER_DATA (tests; OPEN_HARNESS_USER_DATA, its name before the rename, when it is unset),
 * else the app's data folder: Silo Harness, or Open Harness when only that one is there (the app has not started
 * since the rename).
 */
function configJsonFile() {
  const override = process.env.SILO_HARNESS_USER_DATA?.trim() || process.env.OPEN_HARNESS_USER_DATA?.trim();
  let dir = override;
  if (!dir) {
    const support = path.join(os.homedir(), 'Library', 'Application Support');
    const next = path.join(support, 'Silo Harness');
    const old = path.join(support, 'Open Harness');
    dir = !fs.existsSync(next) && fs.existsSync(old) ? old : next;
  }
  return path.join(path.resolve(dir), 'config.json');
}

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The user's settings.json as an object ({} when there is none). Refuses a file it could not write back faithfully. */
function readSettings() {
  const file = settingsFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file, data: {}, exists: false };
    fail(`could not read ${file}: ${err.message}`);
  }
  if (!raw.trim()) return { file, data: {}, exists: true };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    fail(`${file} is not valid JSON (${err.message}). Fix it first; nothing was changed.`);
  }
  if (!isRecord(data)) fail(`${file} must hold a JSON object ({ ... }). Fix it first; nothing was changed.`);
  return { file, data, exists: true };
}

/** Writes settings.json atomically (a temporary file renamed over it), two-space JSON, owner-only when it is new. */
function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = path.join(path.dirname(file), `.settings.json.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

/** What the app would use now: config.json with the settings files applied, the way the app loads it. */
function effective() {
  const { readStoredConfig, normalizeConfig } = load('config.js');
  const { SettingsLayer } = load('settings.js');
  const layer = new SettingsLayer();
  const stored = readStoredConfig(configJsonFile());
  const cfg = normalizeConfig(layer.load(stored));
  return { cfg, stored, layer, info: layer.info() };
}

async function readSecretFromStdin(what) {
  if (process.stdin.isTTY) {
    process.stderr.write(`Paste ${what}, then press Enter (it is not shown): `);
    return new Promise((resolve) => {
      let buf = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.off('data', onData);
            process.stderr.write('\n');
            return resolve(buf.trim());
          }
          if (ch === '\u0003') {
            process.stdin.setRawMode(false);
            process.stderr.write('\n');
            process.exit(130);
          }
          if (ch === '\u007f') buf = buf.slice(0, -1);
          else buf += ch;
        }
      };
      process.stdin.on('data', onData);
    });
  }
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (err) {
    fail(`could not read standard input: ${err.message}`);
  }
  return raw.trim();
}

// ---------- Describing ----------

function ownerOf(info, name) {
  const o = info.owned[`providers.${name}`];
  if (o === 'user') return 'settings.json';
  if (o === 'project') return 'project settings.json';
  if (name === 'ollama' || name === 'portkey') return 'built in';
  return 'config.json';
}

function keyText(v) {
  if (v.key === 'none') return 'not needed';
  return `${v.key === 'set' ? 'set' : 'not set'}${v.keySource ? ` (${v.keySource})` : ''}`;
}

function providerRows(cfg, info) {
  const { listProviders, providerView } = load('providers.js');
  return listProviders(cfg).map((r) => {
    const v = providerView(r, info.owned[`providers.${r.name}`]);
    return { name: v.name, type: v.type, label: v.label, active: v.name === cfg.provider, baseURL: v.baseURL, model: v.model, models: v.models, contextWindow: v.contextWindow, key: v.key, keySource: v.keySource, headers: v.headers, definedIn: ownerOf(info, v.name), ...(v.error ? { error: v.error } : {}), ...(r.problems.length ? { problems: r.problems } : {}) };
  });
}

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.title.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => cells.map((x, i) => String(x).padEnd(widths[i])).join('  ').trimEnd();
  return [line(cols.map((c) => c.title)), ...rows.map((r) => line(cols.map((c) => c.get(r))))].join('\n');
}

/** A secret-free copy of a provider entry. */
function redactEntry(e) {
  if (!isRecord(e)) return e;
  const out = { ...e };
  if (out.apiKey !== undefined) out.apiKey = out.apiKey ? 'set' : 'not set';
  if (isRecord(out.headers)) out.headers = Object.fromEntries(Object.keys(out.headers).map((k) => [k, 'set']));
  return out;
}

// ---------- Commands ----------

async function providerCmd(sub, pos, flags) {
  const { PROVIDER_TYPES, providerNameProblem, validateProviderEntry } = load('provider-presets.js');
  switch (sub) {
    case 'list': {
      const { cfg, info } = effective();
      const rows = providerRows(cfg, info);
      emit(
        table(rows, [
          { title: ' ', get: (r) => (r.active ? '*' : '') },
          { title: 'NAME', get: (r) => r.name },
          { title: 'TYPE', get: (r) => r.type },
          { title: 'LABEL', get: (r) => r.label },
          { title: 'MODEL', get: (r) => r.model || '-' },
          { title: 'KEY', get: (r) => keyText(r) },
          { title: 'DEFINED IN', get: (r) => r.definedIn },
        ]) + (rows.find((r) => r.active && r.error) ? `\n\nThe provider in use cannot be used yet: ${rows.find((r) => r.active).error}` : ''),
        { active: cfg.provider, providers: rows },
      );
      return;
    }
    case 'add': {
      const name = pos[0];
      if (!name) fail('provider add needs a name, e.g. provider add openrouter --type openrouter', 2);
      if (pos.length > 1) fail(`unexpected argument "${pos[1]}"`, 2);
      const np = providerNameProblem(name);
      if (np) fail(np, 2);
      if (!flags.type) fail(`--type is required: one of ${PROVIDER_TYPES.join(', ')}`, 2);
      if (flags['key-env'] && flags['key-stdin']) fail('use --key-env or --key-stdin, not both', 2);
      const entry = { type: flags.type };
      if (flags.label !== undefined) entry.label = flags.label;
      if (flags['base-url'] !== undefined) entry.baseURL = flags['base-url'];
      if (flags['key-env'] !== undefined) entry.apiKeyEnv = flags['key-env'];
      if (flags.model !== undefined) entry.model = flags.model;
      if (flags.models !== undefined) entry.models = flags.models.split(',').map((s) => s.trim()).filter(Boolean);
      if (flags.header.length) {
        entry.headers = {};
        for (const h of flags.header) {
          const i = h.indexOf('=');
          if (i <= 0) fail(`--header: expected Name=Value, got "${h}"`, 2);
          entry.headers[h.slice(0, i).trim()] = h.slice(i + 1);
        }
      }
      const cw = int('context-window', flags['context-window']);
      if (cw) entry.contextWindow = cw;
      const mo = int('max-output', flags['max-output']);
      if (mo) entry.maxOutput = mo;
      if (flags['virtual-key'] !== undefined) entry.virtualKey = flags['virtual-key'];
      if (flags['portkey-config'] !== undefined) entry.config = flags['portkey-config'];
      if (flags['portkey-provider'] !== undefined) entry.provider = flags['portkey-provider'];
      const nc = int('num-ctx', flags['num-ctx']);
      if (nc) entry.numCtx = nc;
      if (flags.think !== undefined) entry.think = flags.think;
      // Checked before the key is asked for, so a typo does not cost a paste.
      const pre = validateProviderEntry(name, entry, { scope: 'user' });
      if (!pre.entry || pre.problems.length) fail(pre.problems.map((p) => `${p.key}: ${p.message}`).join('; '), 2);
      const { file, data } = readSettings();
      const existing = isRecord(data.providers) ? data.providers[name] : undefined;
      if (existing !== undefined && !flags.replace) fail(`there is already a provider named "${name}" in ${file}; pass --replace to replace it, or remove it first`);
      if (flags['key-stdin']) {
        const key = await readSecretFromStdin(`the ${name} key`);
        if (!key) fail('no key on standard input; nothing was changed');
        entry.apiKey = key;
      }
      const checked = validateProviderEntry(name, entry, { scope: 'user' });
      if (!checked.entry || checked.problems.length) fail(checked.problems.map((p) => `${p.key}: ${p.message}`).join('; '), 2);
      data.providers = { ...(isRecord(data.providers) ? data.providers : {}), [name]: entry };
      if (flags.use) data.provider = name;
      writeSettings(file, data);
      const { cfg, info } = effective();
      const row = providerRows(cfg, info).find((r) => r.name === name);
      const notes = [];
      if (row && row.key === 'missing') notes.push(row.error);
      if (row && !row.model) notes.push(`No model yet: silo provider use ${name} --model <id>`);
      if (!flags.use && cfg.provider !== name) notes.push(`To use it: silo provider use ${name}`);
      if (flags.use && cfg.provider !== name) notes.push(`A project's settings.json chooses "${cfg.provider}", which wins over yours in that folder.`);
      emit(`${existing !== undefined ? 'Replaced' : 'Added'} provider "${name}" (${row ? row.label : entry.type}) in ${file}.${flags.use ? ' It is now the provider in use.' : ''}${notes.length ? '\n' + notes.join('\n') : ''}`, { file, provider: row, replaced: existing !== undefined, notes });
      return;
    }
    case 'remove': {
      const name = pos[0];
      if (!name) fail('provider remove needs a name', 2);
      const { file, data } = readSettings();
      if (!isRecord(data.providers) || !(name in data.providers)) {
        const { cfg, info } = effective();
        const where = name === 'ollama' || name === 'portkey' ? 'is built in and cannot be removed' : cfg.providers && name in cfg.providers ? `is defined in ${ownerOf(info, name) === 'project settings.json' ? "the project's settings.json" : configJsonFile()}, not in your settings.json; remove it there` : 'does not exist';
        fail(`the provider "${name}" ${where}`);
      }
      delete data.providers[name];
      if (!Object.keys(data.providers).length) delete data.providers;
      const wasUsed = data.provider === name;
      if (wasUsed) delete data.provider;
      writeSettings(file, data);
      const { cfg } = effective();
      emit(`Removed provider "${name}" from ${file}.${wasUsed ? ` It was the provider in use; the app now uses "${cfg.provider}".` : ''}`, { file, removed: name, active: cfg.provider });
      return;
    }
    case 'use': {
      const name = pos[0];
      if (!name) fail('provider use needs a name (see: silo provider list)', 2);
      const before = effective();
      const { providerNames } = load('providers.js');
      const names = providerNames(before.cfg);
      if (!names.includes(name)) fail(`there is no provider named "${name}". Known: ${names.join(', ')}`);
      const { file, data } = readSettings();
      data.provider = name;
      if (flags.model !== undefined) {
        const model = String(flags.model).trim();
        if (!model) fail('--model needs a model id', 2);
        if (name === 'ollama' || name === 'portkey') data[name] = { ...(isRecord(data[name]) ? data[name] : {}), model };
        else if (isRecord(data.providers) && isRecord(data.providers[name])) data.providers[name] = { ...data.providers[name], model };
        else fail(`the provider "${name}" is defined in ${ownerOf(before.info, name) === 'project settings.json' ? "the project's settings.json" : configJsonFile()}; set its model there (nothing was changed)`);
      }
      writeSettings(file, data);
      const { cfg, info } = effective();
      const row = providerRows(cfg, info).find((r) => r.name === name);
      const notes = [];
      if (cfg.provider !== name) notes.push(`A project's settings.json chooses "${cfg.provider}", which wins over yours in that folder.`);
      if (row && row.error) notes.push(`It cannot be used yet: ${row.error}`);
      emit(`Now using ${row.label}${row.model ? ` · ${row.model}` : ''} ("${name}"), set in ${file}.${notes.length ? '\n' + notes.join('\n') : ''}`, { file, provider: row, notes });
      return;
    }
    case 'test': {
      const { cfg } = effective();
      const { resolveProvider, testProvider, providerNames } = load('providers.js');
      const name = pos[0] || cfg.provider;
      if (!providerNames(cfg).includes(name)) fail(`there is no provider named "${name}". Known: ${providerNames(cfg).join(', ')}`);
      const r = resolveProvider(cfg, name);
      const res = await testProvider(r);
      if (!res.ok) {
        if (JSON_OUT) {
          process.stdout.write(JSON.stringify({ ok: false, error: res.error, test: res }, null, 2) + '\n');
          process.exitCode = 1;
          return;
        }
        fail(res.error);
      }
      emit(`ok  ${res.label} · ${res.model}  (${res.ms} ms)`, { test: res });
      return;
    }
    case undefined:
      fail('provider needs a command: list, add, remove, use or test (see --help)', 2);
    // eslint-disable-next-line no-fallthrough
    default:
      fail(`unknown command "provider ${sub}" (see --help)`, 2);
  }
}

/** Reads a field path of an object, or undefined. */
const getPath = (o, p) => p.split('.').reduce((v, k) => (isRecord(v) ? v[k] : undefined), o);

function displayValue(key, v) {
  const { SECRET_FIELDS } = load('settings.js');
  if (SECRET_FIELDS.includes(key) || (/^env\./.test(key) && /(KEY|TOKEN|SECRET|PASSWORD)$/i.test(key))) return v ? 'set' : 'not set';
  if (/^providers\.[^.]+$/.test(key)) return redactEntry(v);
  if (key === 'providers' && isRecord(v)) return Object.fromEntries(Object.entries(v).map(([n, e]) => [n, redactEntry(e)]));
  return v;
}

async function configCmd(sub, pos, flags) {
  const settings = load('settings.js');
  switch (sub) {
    case 'path': {
      const file = settingsFile();
      const cfgFile = configJsonFile();
      emit(`settings.json  ${file}${fs.existsSync(file) ? '' : '  (not there yet)'}\nconfig.json    ${cfgFile}${fs.existsSync(cfgFile) ? '' : '  (not there yet)'}`, { settings: file, settingsExists: fs.existsSync(file), config: cfgFile, configExists: fs.existsSync(cfgFile) });
      return;
    }
    case 'get': {
      const { cfg, info } = effective();
      const key = pos[0];
      const fields = [...settings.settableFields(), 'workingDirectory', 'providers'];
      const sourceOf = (k) => info.owned[k] === 'user' ? 'settings.json' : info.owned[k] === 'project' ? 'project settings.json' : 'config.json or default';
      if (!key) {
        const all = {};
        for (const f of fields) all[f] = displayValue(f, getPath(cfg, f));
        emit(JSON.stringify(all, null, 2), { config: all, owned: info.owned });
        return;
      }
      if (/^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        const { data } = readSettings();
        const v = getPath(data, key);
        const shown = displayValue(key, v);
        emit(v === undefined ? `${key} is not set in your settings.json` : typeof shown === 'string' ? shown : JSON.stringify(shown), { key, value: shown === undefined ? null : shown, source: 'settings.json' });
        return;
      }
      if (!fields.includes(key) && !/^providers\.[^.]+$/.test(key)) fail(`"${key}" is not a setting (see: silo config --help)`, 2);
      const v = displayValue(key, getPath(cfg, key));
      if (v === undefined) fail(`"${key}" is not set`);
      emit(typeof v === 'string' ? v : JSON.stringify(v, null, 2), { key, value: v, source: sourceOf(key) });
      return;
    }
    case 'set': {
      const key = pos[0];
      if (!key) fail('config set needs a key and a value, e.g. config set theme dark', 2);
      if (/^providers(\.|$)/.test(key) || key === 'provider') {
        if (key === 'provider') fail('use: silo provider use <name>', 2);
        fail('providers are changed with: silo provider add / remove / use', 2);
      }
      const secret = settings.SECRET_FIELDS.includes(key) || (/^env\./.test(key) && /(KEY|TOKEN|SECRET|PASSWORD)$/i.test(key));
      let value;
      if (flags.stdin) {
        if (pos.length > 1) fail('give the value on standard input or as an argument, not both', 2);
        value = await readSecretFromStdin(key);
      } else {
        if (secret) fail(`${key} holds a secret, which is never taken from the command line. Pipe it in: silo config set ${key} --stdin`, 2);
        if (pos.length < 2) fail(`config set ${key} needs a value`, 2);
        if (pos.length > 2) fail(`config set takes one value; quote it if it has spaces`, 2);
        value = pos[1];
      }
      const { file, data } = readSettings();
      if (/^env\./.test(key)) {
        const name = key.slice(4);
        const { ENV_NAME } = load('env.js');
        if (!ENV_NAME.test(name)) fail(`${name} is not a valid variable name`, 2);
        data.env = { ...(isRecord(data.env) ? data.env : {}), [name]: String(value) };
      } else if (key === 'workingDirectory') {
        const dir = path.resolve(String(value).replace(/^~(?=$|\/)/, os.homedir()));
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`no such folder: ${dir}`);
        data.workingDirectory = String(value);
      } else {
        // As written if that is valid (a string), else read as JSON (numbers, true/false).
        let v = value;
        let msg = settings.checkSetting(key, v);
        if (msg === 'unknown') fail(`"${key}" is not a setting you can set (see: silo config --help)`, 2);
        if (msg && !flags.stdin) {
          try {
            const parsed = JSON.parse(String(value));
            const m2 = settings.checkSetting(key, parsed);
            if (!m2) {
              v = parsed;
              msg = null;
            }
          } catch {
            /* keep the first reason */
          }
        }
        if (msg) fail(`${key}: ${msg}`, 2);
        const [a, b] = key.split('.');
        if (b === undefined) data[a] = v;
        else data[a] = { ...(isRecord(data[a]) ? data[a] : {}), [b]: v };
        value = v;
      }
      writeSettings(file, data);
      emit(`Set ${key} in ${file}.`, { file, key, value: displayValue(key, value) });
      return;
    }
    case 'unset': {
      const key = pos[0];
      if (!key) fail('config unset needs a key', 2);
      const { file, data } = readSettings();
      const parts = key.split('.');
      if (parts.length > 2) fail(`"${key}" is not a setting (providers are removed with: silo provider remove)`, 2);
      const [a, b] = parts;
      let had = false;
      if (b === undefined) {
        had = a in data;
        delete data[a];
      } else if (isRecord(data[a])) {
        had = b in data[a];
        delete data[a][b];
        if (!Object.keys(data[a]).length) delete data[a];
      }
      if (!had) {
        emit(`${key} was not set in ${file}; nothing changed.`, { file, key, changed: false });
        return;
      }
      writeSettings(file, data);
      emit(`Removed ${key} from ${file}.`, { file, key, changed: true });
      return;
    }
    case undefined:
      fail('config needs a command: path, get, set or unset (see --help)', 2);
    // eslint-disable-next-line no-fallthrough
    default:
      fail(`unknown command "config ${sub}" (see --help)`, 2);
  }
}

function doctor() {
  const { cfg, info, stored } = effective();
  const rows = providerRows(cfg, info);
  const active = rows.find((r) => r.active) || { name: cfg.provider, label: cfg.provider, error: `There is no provider named "${cfg.provider}".`, key: 'missing', keySource: '', model: '', baseURL: '', type: '?' };
  const problems = [];
  for (const f of info.files) {
    const label = f.scope === 'user' ? 'settings.json' : "the project's settings.json";
    if (f.error) problems.push(`${label} ${f.error}`);
    if (f.scope === 'project' && f.exists && !f.applied) problems.push(`${label} (${f.path}) is not applied: ${f.changed ? 'it changed since you trusted it' : 'you have not trusted it'} (Settings → Developer → Configuration files).`);
    if (f.applied || f.scope === 'user') for (const i of f.invalid) problems.push(`${label}: ${i.key}: ${i.message}`);
  }
  for (const r of rows) for (const p of r.problems || []) if (r.definedIn === 'config.json') problems.push(`config.json: ${p}`);
  if (active.error) problems.unshift(`The provider in use: ${active.error}`);
  // The app opened from the Dock or Finder does not see what a shell profile exports.
  const notes = [];
  if (active.key === 'set' && active.keySource && /^[A-Z_][A-Z0-9_]*$/.test(active.keySource)) {
    const fromFile = info.files.some((f) => f.applied && f.keys.includes(`env.${active.keySource}`));
    if (!fromFile) notes.push(`${active.keySource} is set in this shell. The app sees it only when started from this shell (open -a "Silo Harness"); started from the Dock or Finder it does not. To be sure, put it in the "env" block of ${settingsFile()} or store the key with --key-stdin.`);
  }
  const ownerOfProvider = info.owned.provider === 'user' ? 'settings.json' : info.owned.provider === 'project' ? "the project's settings.json" : 'config.json (the window)';
  const userFile = info.files.find((f) => f.scope === 'user');
  const projectFile = info.files.find((f) => f.scope === 'project');
  const lines = [
    `settings.json   ${settingsFile()}${userFile && userFile.exists ? '' : '  (not there yet)'}`,
    `config.json     ${configJsonFile()}${fs.existsSync(configJsonFile()) ? '' : '  (not there yet: the app has not been set up from the window)'}`,
    `project file    ${projectFile ? `${projectFile.path}${projectFile.exists ? (projectFile.applied ? '  (applied)' : '  (not applied)') : '  (none)'}` : '(none)'}`,
    `folder          ${cfg.workingDirectory}`,
    '',
    `provider        ${active.label} ("${active.name}", ${active.type}), chosen in ${ownerOfProvider}`,
    `base URL        ${active.baseURL || '-'}`,
    `model           ${active.model || '-'}`,
    `key             ${keyText(active)}`,
    '',
    problems.length ? `Problems:\n${problems.map((p) => `  - ${p}`).join('\n')}` : 'No problems found.',
    ...(notes.length ? ['', ...notes] : []),
  ];
  const ok = !active.error && !(userFile && userFile.error);
  const data = { usable: ok, files: { settings: settingsFile(), config: configJsonFile(), project: projectFile ? projectFile.path : null }, folder: cfg.workingDirectory, provider: active, chosenIn: ownerOfProvider, problems, notes, storedProvider: stored.provider };
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok, ...data, ...(ok ? {} : { error: problems[0] }) }, null, 2) + '\n');
  } else process.stdout.write(lines.join('\n') + '\n');
  if (!ok) process.exitCode = 1;
}

// ---------- Main ----------

async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  JSON_OUT = Boolean(flags.json);
  const [cmd, sub, ...rest] = pos;
  if (flags.version) {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return emit(pkg.version, { version: pkg.version });
  }
  if (flags.help || !cmd || cmd === 'help') {
    const topic = cmd === 'help' ? [sub, rest[0]].filter(Boolean).join(' ') : [cmd, sub].filter(Boolean).join(' ');
    const text = helpFor(HELP[topic] ? topic : cmd && HELP[cmd] ? cmd : 'main');
    if (JSON_OUT) return emit('', { help: text });
    process.stdout.write(text + '\n');
    return;
  }
  if (cmd === 'provider') return providerCmd(sub, rest, flags);
  if (cmd === 'config') return configCmd(sub, rest, flags);
  if (cmd === 'doctor') {
    if (sub) fail(`doctor takes no arguments`, 2);
    return doctor();
  }
  fail(`unknown command "${cmd}" (see: silo --help)`, 2);
}

main(process.argv.slice(2)).catch((err) => {
  const code = err instanceof CliError ? err.code : 1;
  let message = err instanceof Error ? err.message : String(err);
  try {
    message = require(path.join(DIST, 'providers.js')).scrubSecrets(message);
  } catch {
    /* nothing loaded: nothing to scrub */
  }
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + '\n');
  else process.stderr.write(`silo: ${message}\n`);
  process.exitCode = code;
});
