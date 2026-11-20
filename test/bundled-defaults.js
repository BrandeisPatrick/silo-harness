// Bundled defaults (a defaults.json a repackager ships in Resources): where it is found, that secrets are stripped,
// that an invalid file is ignored, the precedence over config.json, and that saveConfig keeps unchanged bundled values
// out of config.json so a later bundle still reaches an existing install. Run: node test/bundled-defaults.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-bundled-'));
process.env.SILO_HARNESS_CONFIG_DIR = path.join(root, 'home-config');
const userData = path.join(root, 'user-data');
fs.mkdirSync(userData, { recursive: true });
const configFile = path.join(userData, 'config.json');
const bundleFile = path.join(root, 'defaults.json');

// config.ts asks Electron for the data folder only when it saves; stand in for it.
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? { app: { getPath: () => userData } } : load.call(this, request, ...rest);
};

const warnings = [];
console.warn = (...args) => warnings.push(args.join(' '));
const { defaultConfig, readStoredConfig, saveConfig, resetBundledDefaults } = require(path.join(projectDir, 'dist/main/config.js'));
const { bundledDefaultsPath } = require(path.join(projectDir, 'dist/main/paths.js'));

const writeBundle = (v) => {
  fs.writeFileSync(bundleFile, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  process.env.SILO_HARNESS_DEFAULTS = bundleFile;
  resetBundledDefaults();
};
const noBundle = () => {
  delete process.env.SILO_HARNESS_DEFAULTS;
  resetBundledDefaults();
};
const writeConfig = (v) => fs.writeFileSync(configFile, JSON.stringify(v, null, 2));
const stored = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const rm = () => fs.rmSync(configFile, { force: true });

const BUNDLE = {
  provider: 'acme',
  providers: { acme: { type: 'openai-compatible', baseURL: 'https://gateway.example.com/v1', model: 'example/model-a', models: ['example/model-a', 'example/model-b'] } },
  autoMode: { model: 'example/model-b' },
};

// --- where the file comes from ---------------------------------------------------------------------------------
{
  check('the env var names the file', bundledDefaultsPath({ SILO_HARNESS_DEFAULTS: '/x/defaults.json' }, '/res') === '/x/defaults.json');
  check('else Resources/defaults.json', bundledDefaultsPath({}, '/res') === path.join('/res', 'defaults.json'));
  check('neither: no bundle', bundledDefaultsPath({}, undefined) === null);
}

// --- no bundle: identical to today -----------------------------------------------------------------------------
{
  noBundle();
  rm();
  check('no bundle, no config.json: the defaults', JSON.stringify(readStoredConfig(configFile)) === JSON.stringify(defaultConfig()));
  process.env.SILO_HARNESS_DEFAULTS = path.join(root, 'missing.json');
  resetBundledDefaults();
  check('a missing file is no bundle', JSON.stringify(readStoredConfig(configFile)) === JSON.stringify(defaultConfig()));
  noBundle();
  const cfg = { ...defaultConfig(), theme: 'dark', providers: { other: { type: 'openai-compatible', model: 'm' } } };
  saveConfig(cfg);
  const written = fs.readFileSync(configFile, 'utf8');
  check('no bundle: saveConfig writes everything, as before', written === JSON.stringify({ ...cfg, schemaVersion: 2 }, null, 2));
  check('no bundle: reading it back changes nothing', readStoredConfig(configFile).theme === 'dark' && readStoredConfig(configFile).providers.other.model === 'm');
}

// --- a bundle shows up -----------------------------------------------------------------------------------------
{
  rm();
  writeBundle(BUNDLE);
  const c = readStoredConfig(configFile);
  check('bundle: provider is set', c.provider === 'acme', c.provider);
  check('bundle: the named provider entry is there', c.providers.acme && c.providers.acme.model === 'example/model-a' && c.providers.acme.models.length === 2);
  check('bundle: autoMode.model is set, the rest of autoMode keeps its defaults', c.autoMode.model === 'example/model-b' && c.autoMode.learn === true);
  check('bundle: untouched sections stay default', c.ollama.model === defaultConfig().ollama.model && c.maxTurns === 40);
  check('bundle: unknown keys are ignored', !('nonsense' in c));
}

// --- config.json wins; other providers keep the bundled one ----------------------------------------------------
{
  writeBundle(BUNDLE);
  writeConfig({ schemaVersion: 2, provider: 'ollama', providers: { acme: { model: 'example/model-b' }, mine: { type: 'openai-compatible', model: 'm' } }, autoMode: { model: 'mine/model' } });
  const c = readStoredConfig(configFile);
  check('config.json beats the bundle', c.provider === 'ollama' && c.autoMode.model === 'mine/model');
  check('a same-named entry merges field by field', c.providers.acme.model === 'example/model-b' && c.providers.acme.baseURL === 'https://gateway.example.com/v1' && c.providers.acme.models.length === 2, c.providers.acme);
  check('config.json providers keep the bundled provider too', c.providers.mine && c.providers.mine.model === 'm' && c.providers.acme);
  writeConfig({ schemaVersion: 2, providers: { mine: { type: 'openai-compatible', model: 'm' } } });
  check('a config.json with only other providers keeps the bundled one', Object.keys(readStoredConfig(configFile).providers).sort().join() === 'acme,mine');
}

// --- secrets are stripped ---------------------------------------------------------------------------------------
{
  warnings.length = 0;
  writeBundle({
    env: { SOME_KEY: 'secret-value' },
    portkey: { apiKey: 'secret-value', providerApiKey: 'secret-value', model: 'example/model-a' },
    webSearch: { apiKey: 'secret-value' },
    providers: { acme: { type: 'openai-compatible', apiKey: 'secret-value', providerApiKey: 'secret-value', model: 'example/model-a' } },
    nonsense: true,
  });
  rm();
  const c = readStoredConfig(configFile);
  check('env, apiKey and providerApiKey never get through', !('env' in c) && c.portkey.apiKey === '' && c.portkey.providerApiKey === '' && !('apiKey' in c.providers.acme) && !('providerApiKey' in c.providers.acme) && !JSON.stringify(c).includes('secret-value'));
  check('the rest of the same sections is kept', c.portkey.model === 'example/model-a' && c.providers.acme.model === 'example/model-a');
  check('one warning says something was stripped', warnings.filter((w) => /removed keys/.test(w)).length === 1, warnings);
}

// --- optional keys survive; consent is never bundled --------------------------------------------------------------
{
  warnings.length = 0;
  rm();
  writeBundle({ checkForUpdates: false, timingLog: false });
  const c = readStoredConfig(configFile);
  check('an optional key without a default (checkForUpdates) survives', c.checkForUpdates === false && c.timingLog === false);
  check('and it raises no warning', warnings.length === 0, warnings);

  warnings.length = 0;
  writeBundle({
    settingsTrusted: { '/p': 'h' },
    mcpTrusted: { '/p': ['s'] },
    mcpTrustedEntries: { '/p': { s: 'h' } },
    mcpProjectValues: { '/p': { s: { A: 'b' } } },
    allowRules: { '/p': { allow: ['Edit'] } },
    recentDirs: ['/tmp'],
    mods: { approved: { m: 'h' }, safeMode: true },
    autoMode: { allow: ['rule'], model: 'example/model-b', environment: 'example env' },
    permissionMode: 'bypass',
    mcpServers: { demo: { command: 'example-server', args: ['--x'], env: { A: 'b' }, headers: { H: 'v' } } },
  });
  const k = readStoredConfig(configFile);
  const d = defaultConfig();
  check('trust and approval records are dropped', JSON.stringify([k.settingsTrusted, k.mcpTrusted, k.mcpTrustedEntries, k.mcpProjectValues, k.allowRules, k.recentDirs]) === JSON.stringify([d.settingsTrusted, d.mcpTrusted, d.mcpTrustedEntries, d.mcpProjectValues, d.allowRules, d.recentDirs]), k.settingsTrusted);
  check('mods.approved is dropped, the rest of mods stays', JSON.stringify(k.mods.approved) === '{}' && k.mods.safeMode === true);
  check('autoMode.allow is dropped, model and environment stay', k.autoMode.allow.length === 0 && k.autoMode.model === 'example/model-b' && k.autoMode.environment === 'example env');
  check('a bundled bypass mode is dropped', k.permissionMode === 'ask' && k.autoApprove === false);
  check('mcpServers keep the entry but lose env and headers', k.mcpServers.demo && k.mcpServers.demo.command === 'example-server' && !('env' in k.mcpServers.demo) && !('headers' in k.mcpServers.demo), k.mcpServers);
  check('all of it is one warning', warnings.filter((w) => /removed keys/.test(w)).length === 1 && warnings.length === 1, warnings);

  writeBundle({ permissionMode: 'plan' });
  check('another permission mode is kept', readStoredConfig(configFile).permissionMode === 'plan');
}

// --- an invalid file never breaks launch ------------------------------------------------------------------------
{
  for (const [label, body] of [['unparseable JSON', '{ not json'], ['a list', '[1, 2]'], ['a string', '"hi"']]) {
    warnings.length = 0;
    writeBundle(body);
    rm();
    check(`${label}: behaves as no bundle`, JSON.stringify(readStoredConfig(configFile)) === JSON.stringify(defaultConfig()));
    check(`${label}: one warning`, warnings.length === 1, warnings);
  }
}

// --- saveConfig keeps unchanged bundled values out of config.json ----------------------------------------------
{
  writeBundle(BUNDLE);
  rm();
  const first = readStoredConfig(configFile);
  // The user picks another model in the picker (providers.setModel) and changes a plain setting.
  saveConfig({ ...first, theme: 'dark', providers: { ...first.providers, acme: { ...first.providers.acme, model: 'example/model-b' } } });
  const s = stored();
  check('unchanged bundled values are left out of config.json', s.provider === undefined && s.autoMode.model === undefined && s.providers.acme.models === undefined && s.providers.acme.baseURL === undefined, s.providers);
  check('what the user changed is written', s.theme === 'dark' && s.providers.acme.model === 'example/model-b');

  // A later app version ships a longer model list and a new default.
  writeBundle({ ...BUNDLE, providers: { acme: { ...BUNDLE.providers.acme, models: ['example/model-a', 'example/model-b', 'example/model-c'] } } });
  const next = readStoredConfig(configFile);
  check('a changed bundled list reaches the existing install', next.providers.acme.models.length === 3, next.providers.acme.models);
  check('the user-picked model survives', next.providers.acme.model === 'example/model-b' && next.theme === 'dark');

  // Nothing of the user's left in an entry: it is removed from the file.
  rm();
  saveConfig(readStoredConfig(configFile));
  check('an untouched bundled entry is not written at all', stored().providers === undefined || !('acme' in stored().providers), stored().providers);

  // A bundled permission mode that the user left alone is still honoured when it is not stored.
  writeBundle({ permissionMode: 'plan' });
  rm();
  saveConfig(readStoredConfig(configFile));
  check('a bundled permissionMode survives a save and a reload', readStoredConfig(configFile).permissionMode === 'plan');
  const picked = readStoredConfig(configFile);
  saveConfig({ ...picked, permissionMode: 'ask', autoApprove: false });
  check('a permissionMode the user changed wins over it', readStoredConfig(configFile).permissionMode === 'ask');
}

noBundle();
fs.rmSync(root, { recursive: true, force: true });
done();
