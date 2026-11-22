// Bundled defaults (config.ts) meet Settings → Models and the resets: a repackaged app ships a provider without a key,
// and a person pastes theirs on a first launch with no config.json and no settings.json. Checks that the bundled
// provider is the one in use with the bundle's models and "No key"; that a pasted key lands in the person's own
// config.json as that entry's apiKey alone (600), never in the bundle or the window, and the provider then answers;
// Replace and Remove; that a model, a provider and the safety check's model chosen here survive a restart while values
// equal to the bundle's stay out of config.json; Add provider beside a bundled one and under its name; Remove refused
// for a bundled entry; Reset settings and Full reset leave the bundle alone and the next launch starts on its values;
// and that nothing from a bundle (a key, an env block, a trust record, an allow rule) takes effect through these paths.
// Everything runs on temp folders, against the mock model. Run: npm run build && node test/bundled-settings.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (f) => require(path.join(projectDir, 'dist/main', f));
const { check, done } = require('./support/check.js');
const { startMock } = require('./support/mock-model.js');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-bundled-settings-')));
const home = path.join(root, 'home-config');
const userData = path.join(root, 'user-data');
const resources = path.join(root, 'Acme.app', 'Contents', 'Resources');
for (const d of [home, userData, resources]) fs.mkdirSync(d, { recursive: true });
process.env.SILO_HARNESS_CONFIG_DIR = home;
process.env.SILO_HARNESS_WORK_DIR = path.join(root, 'work');
const bundleFile = path.join(resources, 'defaults.json');
process.env.SILO_HARNESS_DEFAULTS = bundleFile;
const configFile = path.join(userData, 'config.json');
const settingsFile = path.join(home, 'settings.json');
for (const v of ['ACME_API_KEY', 'PORTKEY_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'BUNDLE_ENV_VAR']) delete process.env[v];

// config.ts asks Electron for the data folder only when it saves; stand in for it.
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? { app: { getPath: () => userData } } : load.call(this, request, ...rest);
};
const logged = [];
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k];
  console[k] = (...a) => {
    logged.push(a.map(String).join(' '));
    if (k === 'log' && /^(ok  |FAIL|\n?ALL OK|\n?\d+ FAILED)/.test(String(a[0]))) orig(...a);
  };
}

const C = dist('config.js');
const P = dist('providers.js');
const { settingsLayer } = dist('settings.js');
const { createApp } = dist('app.js');
const { setupProviders } = dist('providers-service.js');
const { setupSettings } = dist('settings-service.js');
const R = dist('reset.js');

const KEY = 'acme-SECRET-key-0123456789wxyz';
const KEY2 = 'acme-OTHER-key-0123456789abcd';
const modeOf = (f) => fs.statSync(f).mode & 0o777;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const stored = () => (fs.existsSync(configFile) && fs.readFileSync(configFile, 'utf8').trim() ? readJson(configFile) : {});
const fails = async (fn) => {
  try {
    await fn();
    return '';
  } catch (e) {
    return e.message || String(e);
  }
};

(async () => {
  const mock = await startMock();
  mock.state.apiKey = KEY; // the gateway wants exactly this key
  const base = `http://127.0.0.1:${mock.port}/v1`;
  const BUNDLE = {
    provider: 'acme',
    providers: {
      acme: { type: 'openai-compatible', label: 'Acme Gateway', baseURL: base, apiKeyEnv: 'ACME_API_KEY', model: 'mock-model', models: ['mock-model', 'mock-model-b'], apiKey: 'bundle-SHIPPED-key-0123456789' },
      // An entry without apiKeyEnv: its key goes in the entry's apiKey field all the same
      plain: { type: 'openai-compatible', baseURL: base, model: 'mock-model' },
    },
    autoMode: { model: 'acme:mock-model-b', allow: ['Bash(rm:*)'] },
    env: { BUNDLE_ENV_VAR: 'from-bundle' },
    portkey: { apiKey: 'pk-bundle-SHIPPED-0123456789' },
    settingsTrusted: { [root]: 'x' },
    allowRules: { [root]: { allow: ['Bash'] } },
  };
  fs.writeFileSync(bundleFile, JSON.stringify(BUNDLE, null, 2));
  const bundleText = fs.readFileSync(bundleFile, 'utf8');
  fs.writeFileSync(configFile, ''); // a first launch: config.json empty, no settings.json
  C.resetBundledDefaults();

  // One launch of the app's main side: the config as index.ts loads it, the real saveConfig, the two services.
  let app = null;
  let pushes = [];
  const launch = () => {
    C.resetBundledDefaults();
    const loaded = settingsLayer.load(C.readStoredConfig(configFile));
    app = createApp({ userData, appRoot: projectDir, loadConfig: () => loaded, saveConfig: C.saveConfig });
    pushes = [];
    app.push = (channel, payload) => pushes.push(JSON.stringify(payload));
    setupSettings(app, { pollMs: 50, debounceMs: 10, openPath: async () => '' });
    setupProviders(app, { linkDir: path.join(root, 'bin'), command: path.join(root, 'silo'), pathOf: async () => '' });
    return app;
  };
  const call = (m, ...a) => app.invokeRpc(m, a);
  const win = () => P.windowConfig(app.config(), settingsLayer.info().owned, settingsLayer.envOwners());
  const view = (name) => win().providerView.all.find((p) => p.name === name);

  // --- 1. the bundled provider on the Models page ----------------------------------------------------------------
  launch();
  {
    const v = win().providerView;
    check('1. the bundled provider is the one in use', v.active.name === 'acme' && v.active.label === 'Acme Gateway', v.active.name);
    check("1. … with the bundle's models for the picker", JSON.stringify(v.active.models) === JSON.stringify(['mock-model', 'mock-model-b']) && v.active.model === 'mock-model', v.active.models);
    check('1. … and no key: the page says "No key" and the field takes one', v.active.key === 'missing' && v.active.keyEditable === true && !v.active.keyRemovable, v.active);
    const cat = await call('providers.catalog', 'acme');
    check('1. … its list of models says it needs a key, without asking the service', cat.noKey === true && mock.state.requests.length === 0, cat);
  }

  // --- 2. pasting a key ----------------------------------------------------------------------------------------------
  {
    const place = dist('provider-keys.js').keyPlace(app.config(), 'acme', settingsLayer.info().owned, settingsLayer.envOwners(), {});
    check("2. keyPlace for an entry only the bundle has: save as the entry's apiKey in config.json, nothing to remove", place.from === null && place.save?.file === 'config' && place.save.path.join('.') === 'providers.acme.apiKey' && place.remove === null, place);
    await call('providers.setKey', 'acme', `  ${KEY}  `);
    const s = stored();
    check("2. the key is saved in the person's config.json under the provider, the key field alone", JSON.stringify(s.providers) === JSON.stringify({ acme: { apiKey: KEY } }), JSON.stringify(s.providers ?? {}).split(KEY).join('…'));
    check('2. … config.json is owner-only (600)', modeOf(configFile) === 0o600, modeOf(configFile).toString(8));
    check('2. … not in settings.json, not in an env block', !fs.existsSync(settingsFile) && !process.env.ACME_API_KEY);
    check('2. … the bundle file is untouched', fs.readFileSync(bundleFile, 'utf8') === bundleText);
    const v = view('acme');
    check('2. the provider has its key: shown as dots and the last four, saved in your settings', v.key === 'set' && v.keyTail === 'wxyz' && v.keyFrom === 'app' && v.keyEditable && v.keyRemovable, v);
    const cat = await call('providers.catalog', 'acme');
    check('2. … the list of models comes from the service with the key (Ready)', cat.listed === true && !cat.noKey && !cat.unreachable, cat);
    const t = await call('providers.test', 'acme', 'mock-model');
    check('2. … a model test runs', t && t.ok === true, t);
    await call('providers.setKey', 'acme', KEY2);
    check('2. Replace writes the new key in the same place', stored().providers.acme.apiKey === KEY2 && view('acme').keyTail === 'abcd');
    await call('providers.removeKey', 'acme');
    check('2. Remove takes it out; with nothing else of the person\'s, the entry leaves config.json', !('providers' in stored()) && view('acme').key === 'missing');
    await call('providers.setKey', 'plain', KEY);
    check('2. an entry naming no variable: its apiKey in config.json too', JSON.stringify(stored().providers) === JSON.stringify({ plain: { apiKey: KEY } }));
    await call('providers.removeKey', 'plain');
    await call('providers.setKey', 'acme', KEY);
    const all = [KEY, KEY2];
    check('2. no key ever reached the window whole (its config, every push)', all.every((k) => !JSON.stringify(win()).includes(k) && !pushes.join('\n').includes(k)));
    check('2. no key reached a log line', all.every((k) => !logged.join('\n').includes(k)), logged.filter((l) => all.some((k) => l.includes(k))).map((l) => l.slice(0, 200)));
  }

  // --- 3. a model, a provider and the check's model, across a restart ------------------------------------------
  {
    await call('providers.setModel', 'acme', 'mock-model-b');
    await call('providers.use', 'ollama');
    app.updateConfig((c) => ({ ...c, autoMode: { ...c.autoMode, model: 'acme:mock-model' } }));
    const s = stored();
    check('3. a model, a provider and a check model of the person\'s are in config.json', s.providers.acme.model === 'mock-model-b' && s.provider === 'ollama' && s.autoMode.model === 'acme:mock-model', s);
    launch();
    const c = app.config();
    check('3. … and after a restart', c.providers.acme.model === 'mock-model-b' && c.provider === 'ollama' && c.autoMode.model === 'acme:mock-model' && c.providers.acme.apiKey === KEY && c.providers.acme.baseURL === base);
    await call('providers.setModel', 'acme', 'mock-model');
    await call('providers.use', 'acme');
    app.updateConfig((c) => ({ ...c, autoMode: { ...c.autoMode, model: 'acme:mock-model-b' } }));
    const s2 = stored();
    check("3. choosing the bundle's own values leaves them out of config.json again", !('provider' in s2) && JSON.stringify(s2.providers) === JSON.stringify({ acme: { apiKey: KEY } }) && !('model' in (s2.autoMode ?? {})), s2);
    launch();
    check('3. … and the restart reads the bundle\'s values', app.config().provider === 'acme' && app.config().providers.acme.model === 'mock-model' && app.config().autoMode.model === 'acme:mock-model-b');
  }

  // --- 4. Add provider beside a bundled one, and under its name; Remove of a bundled entry --------------------
  {
    let err = await fails(() => call('providers.add', { type: 'openai-compatible', name: 'acme', baseURL: base }));
    check('4. adding one under the bundled name is refused in words, nothing written', /already a provider named "acme"/.test(err) && !fs.existsSync(settingsFile), err);
    const r = await call('providers.add', { type: 'openai-compatible', name: 'mine', baseURL: base, apiKey: KEY });
    check('4. one beside it goes in your settings.json and is put in use; the bundled one stays', r.selected && readJson(settingsFile).providers.mine.baseURL === base && app.config().provider === 'mine' && Boolean(app.config().providers.acme), r);
    check('4. … settings.json is owner-only', modeOf(settingsFile) === 0o600);
    check('4. a bundled entry offers no Remove', !view('acme').removable && view('mine').removable, view('acme'));
    err = await fails(() => call('providers.remove', 'acme'));
    check('4. … and removing it is refused in words', /comes with this copy of the app/.test(err) && Boolean(app.config().providers.acme), err);
    await call('providers.remove', 'mine');
    await call('providers.use', 'acme');
  }

  // --- 6. nothing of the bundle's keys or consent takes effect -------------------------------------------------
  {
    const c = app.config();
    check('6. the bundled apiKey never applies (the key in use is the person\'s)', c.providers.acme.apiKey === KEY && !JSON.stringify(c).includes('bundle-SHIPPED'));
    check('6. nor the env block, the gateway key, trust records or allow rules', !process.env.BUNDLE_ENV_VAR && c.portkey.apiKey === '' && !Object.keys(c.settingsTrusted).length && !Object.keys(c.allowRules).length && !c.autoMode.allow.length);
    await call('providers.removeKey', 'acme');
    check('6. Remove does not uncover the bundled key', view('acme').key === 'missing' && !app.config().providers.acme.apiKey);
    check('6. the window never sees it', !JSON.stringify(win()).includes('bundle-SHIPPED') && !pushes.join('\n').includes('bundle-SHIPPED'));
    await call('providers.setKey', 'acme', KEY);
  }

  // --- 5. the resets ---------------------------------------------------------------------------------------------
  {
    fs.mkdirSync(path.join(userData, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'sessions', 's1.json'), '{}');
    check('5. resetRefusal accepts the data folder with SILO_HARNESS_DEFAULTS set', R.resetRefusal(userData) === null);
    await call('providers.use', 'ollama');
    R.markReset(userData, { kind: 'settings', settingsJson: false, at: Date.now() });
    const plan = R.stageReset(userData, () => {}, home);
    check('5. Reset settings: config.json moved aside, sessions kept, the bundle untouched', plan?.kind === 'settings' && !fs.existsSync(configFile) && fs.existsSync(path.join(userData, 'sessions', 's1.json')) && fs.readFileSync(bundleFile, 'utf8') === bundleText);
    launch();
    check("5. … the next launch starts on the bundle's values, not the bare defaults", app.config().provider === 'acme' && app.config().providers.acme.model === 'mock-model' && app.config().autoMode.model === 'acme:mock-model-b' && view('acme').key === 'missing');
    await call('providers.setKey', 'acme', KEY);
    // A defaults file kept inside the data folder (SILO_HARNESS_DEFAULTS for a trial): a full reset leaves it there
    const inData = path.join(userData, 'trial', 'defaults.json');
    fs.mkdirSync(path.dirname(inData), { recursive: true });
    fs.writeFileSync(inData, bundleText);
    process.env.SILO_HARNESS_DEFAULTS = inData;
    R.markReset(userData, { kind: 'full', settingsJson: true, at: Date.now() + 1 });
    R.stageReset(userData, () => {}, home);
    check('5. Full reset: the data folder is swept, the bundle in Resources untouched', !fs.existsSync(configFile) && !fs.existsSync(path.join(userData, 'sessions')) && !fs.existsSync(settingsFile) && fs.readFileSync(bundleFile, 'utf8') === bundleText);
    check('5. … and a defaults file SILO_HARNESS_DEFAULTS names inside the data folder stays', fs.existsSync(inData) && fs.readFileSync(inData, 'utf8') === bundleText);
    process.env.SILO_HARNESS_DEFAULTS = bundleFile;
    launch();
    check("5. … the next launch starts on the bundle's values, with no key", app.config().provider === 'acme' && app.config().providers.acme.model === 'mock-model' && view('acme').key === 'missing');
  }

  mock.close();
  fs.rmSync(root, { recursive: true, force: true });
  done();
})().catch((err) => {
  process.stdout.write(`CRASH ${err && err.stack}\n`);
  process.exit(1);
});
