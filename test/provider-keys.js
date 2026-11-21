// Keys saved from Settings → Models (src/main/provider-keys.ts, providers-service.ts): where each kind of provider's
// key is kept and saved, that a key from the shell or a project is read-only, that your settings.json is written
// owner-only and never when it is not a JSON object, Add provider and Remove, and that a whole key never reaches the
// window's copy of the config, a mod's, an error text or a log. Everything runs on a temp config folder.
// Run: node test/provider-keys.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (f) => require(path.join(projectDir, 'dist/main', f));
const { check, done } = require('./support/check.js');
const { startMock } = require('./support/mock-model.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-provider-keys-'));
const home = path.join(root, 'home-config');
fs.mkdirSync(home, { recursive: true });
process.env.SILO_HARNESS_CONFIG_DIR = home;
// No key of this Mac's shell is read by the suite
for (const v of ['PORTKEY_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MY_GW_KEY']) delete process.env[v];
const logged = [];
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k];
  console[k] = (...a) => {
    logged.push(a.map(String).join(' '));
    if (k === 'log') orig(...a);
  };
}

const K = dist('provider-keys.js');
const P = dist('providers.js');
const { defaultConfig, normalizeConfig } = dist('config.js');
const { settingsLayer } = dist('settings.js');
const settingsFile = path.join(home, 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const modeOf = (f) => fs.statSync(f).mode & 0o777;
let n = 0;
const tmp = () => {
  const d = path.join(root, `d${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return fs.realpathSync(d);
};
const cfgWith = (over) => normalizeConfig({ ...defaultConfig(), workingDirectory: tmp(), ...over });
const SECRET = 'sk-or-SECRET-0123456789abcd';

(async () => {
  // --- keyPlace: where each kind of provider's key is and would be saved -------------------------------------
  {
    const at = (cfg, name, owned = {}, envBy = {}, env = {}) => K.keyPlace(cfg, name, owned, envBy, env);
    let p = at(cfgWith({ portkey: { ...defaultConfig().portkey, apiKey: 'pk-in-config-0123' } }), 'portkey');
    check('gateway block, key in the app: from the app, saved and removed in config.json', p.from === 'app' && p.save.file === 'config' && p.save.path.join('.') === 'portkey.apiKey' && p.remove.file === 'config', p);
    p = at(cfgWith({ portkey: { ...defaultConfig().portkey, apiKey: 'pk-in-file-0123' } }), 'portkey', { 'portkey.apiKey': 'user' });
    check('gateway block, key in your settings.json: from there, saved there', p.from === 'settings' && p.save.file === 'settings' && p.save.path.join('.') === 'portkey.apiKey', p);
    p = at(cfgWith({}), 'portkey', {}, {}, { PORTKEY_API_KEY: 'pk-shell-0123' });
    check('gateway block, key from the shell: read-only', p.from === 'shell' && p.save === null && p.remove === null, p);
    p = at(cfgWith({}), 'portkey', {}, { PORTKEY_API_KEY: 'user' }, { PORTKEY_API_KEY: 'pk-env-block-0123' });
    check('gateway block, key in your env block: saved and removed there', p.from === 'settings' && p.save.path.join('.') === 'env.PORTKEY_API_KEY' && p.remove.path.join('.') === 'env.PORTKEY_API_KEY', p);
    p = at(cfgWith({}), 'portkey');
    check('gateway block, no key: saved in the app (config.json)', p.from === null && p.save.file === 'config' && p.save.path.join('.') === 'portkey.apiKey' && p.remove === null, p);

    const or = (entry, owned = { 'providers.or': 'user' }, envBy = {}, env = {}) => at(cfgWith({ providers: { or: { type: 'openrouter', model: 'm', ...entry } } }), 'or', owned, envBy, env);
    p = or({});
    check('named provider in your settings.json, no key anywhere: saved as its apiKey there', p.from === null && p.save.file === 'settings' && p.save.path.join('.') === 'providers.or.apiKey', p);
    p = or({}, {});
    check('named provider in the app’s settings: saved as its apiKey in config.json', p.save.file === 'config' && p.save.path.join('.') === 'providers.or.apiKey', p);
    p = or({ apiKey: 'sk-or-entry-0123' });
    check('named provider with its own apiKey: from your settings.json, removable', p.from === 'settings' && p.remove.path.join('.') === 'providers.or.apiKey', p);
    p = or({ apiKeyEnv: 'MY_GW_KEY' });
    check('named provider naming a variable that is not set: saved under that variable in your env block', p.save.file === 'settings' && p.save.path.join('.') === 'env.MY_GW_KEY', p);
    p = or({}, { 'providers.or': 'user' }, {}, { OPENROUTER_API_KEY: 'sk-or-shell-0123' });
    check('named provider whose type’s variable comes from the shell: read-only', p.from === 'shell' && !p.save && !p.remove, p);
    p = or({}, { 'providers.or': 'project' });
    check('a project’s entry: never written to; a key goes under the type’s own variable in your env block', p.save.file === 'settings' && p.save.path.join('.') === 'env.OPENROUTER_API_KEY', p);
    p = or({ apiKeyEnv: 'PROJECT_CHOSEN' }, { 'providers.or': 'project' });
    check('a project’s entry naming its own variable: nothing saved for it (your key would go where the project says)', p.save === null, p);
    p = or({}, { 'providers.or': 'user' }, { OPENROUTER_API_KEY: 'project' }, { OPENROUTER_API_KEY: 'x-0123456789' });
    check('a key a project’s env block set: from the project, read-only', p.from === 'project' && !p.save, p);
    check('Ollama, LM Studio and an Ollama entry take no key', !at(cfgWith({}), 'ollama').save && !at(cfgWith({ providers: { l: { type: 'lmstudio' } } }), 'l').save && !at(cfgWith({ providers: { o: { type: 'ollama' } } }), 'o').save);
    p = at(cfgWith({ providers: { c: { type: 'openai-compatible', baseURL: 'http://x.example/v1' } } }), 'c', { 'providers.c': 'user' });
    check('an OpenAI-compatible entry may take one: its apiKey in your settings.json', p.save?.path.join('.') === 'providers.c.apiKey', p);
  }

  // --- editUserSettings: owner-only, atomic, refuses a file that is not a JSON object ------------------------------
  {
    const f = path.join(tmp(), 'settings.json');
    K.editUserSettings(f, (d) => K.setIn(d, ['providers', 'x', 'apiKey'], 'v'));
    check('a new settings.json is made owner-only (600)', modeOf(f) === 0o600 && JSON.parse(fs.readFileSync(f, 'utf8')).providers.x.apiKey === 'v');
    fs.chmodSync(f, 0o644);
    K.editUserSettings(f, (d) => K.setIn(d, ['theme'], 'dark'));
    check('an existing one becomes 600 when the app writes it, its other fields kept', modeOf(f) === 0o600 && JSON.parse(fs.readFileSync(f, 'utf8')).providers.x.apiKey === 'v');
    K.editUserSettings(f, (d) => K.setIn(d, ['providers', 'x', 'apiKey'], undefined));
    check('setIn with undefined removes the field', !('apiKey' in JSON.parse(fs.readFileSync(f, 'utf8')).providers.x));
    fs.writeFileSync(f, '{ not json');
    let err = '';
    try {
      K.editUserSettings(f, () => {});
    } catch (e) {
      err = e.message;
    }
    check('a settings.json that is not JSON is never overwritten', /not valid JSON/.test(err) && fs.readFileSync(f, 'utf8') === '{ not json');
    fs.writeFileSync(f, '[1]');
    try {
      K.editUserSettings(f, () => {});
      err = '';
    } catch (e) {
      err = e.message;
    }
    check('nor one that holds no object', /must hold a JSON object/.test(err) && fs.readFileSync(f, 'utf8') === '[1]');
    check('no temporary file is left beside it', fs.readdirSync(path.dirname(f)).length === 1, fs.readdirSync(path.dirname(f)));
    check('cleanKey: spaces and an empty key refused, in words without the key', (() => {
      const words = [];
      for (const k of ['', '  ', 'two words-0123456789']) {
        try {
          K.cleanKey(k);
        } catch (e) {
          words.push(e.message);
        }
      }
      return words.length === 3 && !words.join(' ').includes('0123456789');
    })());
  }

  // --- The window's view: set or not, the last four of a long key, where from; never the key ------------------
  {
    const cfg = cfgWith({ provider: 'or', portkey: { ...defaultConfig().portkey, apiKey: 'pk-short' }, providers: { or: { type: 'openrouter', model: 'm', apiKey: SECRET } } });
    const win = P.windowConfig(cfg, { 'providers.or': 'user' }, {});
    const or = win.providerView.all.find((p) => p.name === 'or');
    const pk = win.providerView.all.find((p) => p.name === 'portkey');
    check('the view shows the last four characters of a long key, where it is kept, and that it can be replaced and removed', or.key === 'set' && or.keyTail === 'abcd' && or.keyFrom === 'settings' && or.keyEditable && or.keyRemovable && or.removable, or);
    check('a short key shows no characters at all', pk.key === 'set' && !('keyTail' in pk) && pk.keyFrom === 'app', pk);
    check('the window’s copy never holds the whole key', !JSON.stringify(win).includes(SECRET) && !JSON.stringify(win).includes('pk-short'));
    const mods = require(path.join(projectDir, 'dist/main/mods/public-config.js')).publicConfig(cfg);
    check('a mod’s copy of the config holds no key, not even its last four characters', !JSON.stringify(mods).includes(SECRET) && !JSON.stringify(mods).includes('abcd'), mods);
    check('the built-in blocks and a project’s entry cannot be removed', !pk.removable && !P.windowConfig(cfg, { 'providers.or': 'project' }).providerView.all.find((p) => p.name === 'or').removable);
  }

  // --- The service: save, remove, add, choose, remove a provider; the files as they end up -------------------
  {
    const { createApp } = dist('app.js');
    const { setupProviders } = dist('providers-service.js');
    const { setupSettings } = dist('settings-service.js');
    const mock = await startMock();
    const base = `http://127.0.0.1:${mock.port}/v1`;
    fs.writeFileSync(settingsFile, JSON.stringify({ providers: { or: { type: 'openrouter', model: 'anthropic/claude-haiku-5.5' }, gw: { type: 'openai-compatible', baseURL: base, apiKeyEnv: 'MY_GW_KEY', model: 'mock-model' } } }, null, 2));
    fs.chmodSync(settingsFile, 0o644);
    const loaded = settingsLayer.load(cfgWith({ provider: 'portkey', ollama: { ...defaultConfig().ollama, baseURL: 'http://127.0.0.1:9/v1' }, portkey: { ...defaultConfig().portkey, baseURL: base, model: 'mock-model', apiKey: '' } }));
    const app = createApp({ userData: tmp(), appRoot: projectDir, loadConfig: () => loaded, saveConfig: () => {} });
    const pushes = [];
    app.push = (channel, payload) => pushes.push({ channel, payload: JSON.stringify(payload) });
    setupSettings(app, { pollMs: 50, debounceMs: 10, openPath: async () => '' });
    setupProviders(app, { linkDir: tmp(), command: path.join(tmp(), 'silo'), pathOf: async () => '' });
    const call = (m, ...a) => app.invokeRpc(m, a);
    const view = (name) => P.windowConfig(app.config(), settingsLayer.info().owned, settingsLayer.envOwners()).providerView.all.find((p) => p.name === name);
    const fails = async (fn) => {
      try {
        await fn();
        return '';
      } catch (e) {
        return e.message || String(e);
      }
    };

    check('(the entries of your settings.json are loaded)', Boolean(app.config().providers?.or) && view('or').key === 'missing' && view('or').keyEditable);
    await call('providers.setKey', 'or', `  ${SECRET}  `);
    check('a key saved for an entry of your settings.json goes in its apiKey there, trimmed', readSettings().providers.or.apiKey === SECRET);
    check('… the file is owner-only (600) after the app wrote it', modeOf(settingsFile) === 0o600, modeOf(settingsFile).toString(8));
    check('… it applies at once: the provider has its key, shown as its last four', view('or').key === 'set' && view('or').keyTail === 'abcd' && view('or').keyFrom === 'settings');
    await call('providers.removeKey', 'or');
    check('Remove takes it out of the file again', !('apiKey' in readSettings().providers.or) && view('or').key === 'missing');

    await call('providers.setKey', 'gw', 'gw-SECRET-key-0123456789');
    check('an entry naming a variable: the key goes under that variable in your env block', readSettings().env?.MY_GW_KEY === 'gw-SECRET-key-0123456789' && process.env.MY_GW_KEY === 'gw-SECRET-key-0123456789' && view('gw').key === 'set' && view('gw').keyFrom === 'settings');
    await call('providers.removeKey', 'gw');
    check('… and Remove takes the variable away', !('MY_GW_KEY' in (readSettings().env ?? {})) && !process.env.MY_GW_KEY);

    await call('providers.setKey', 'portkey', 'pk-SECRET-in-app-0123456789');
    check('the gateway block’s key goes in the app’s settings, not your settings.json', app.config().portkey.apiKey === 'pk-SECRET-in-app-0123456789' && !JSON.stringify(readSettings()).includes('pk-SECRET') && view('portkey').keyFrom === 'app');

    process.env.GROQ_API_KEY = 'gsk-SHELL-0123456789';
    fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), providers: { ...readSettings().providers, gq: { type: 'groq', model: 'llama' } } }, null, 2));
    await call('settings.reload');
    let err = await fails(() => call('providers.setKey', 'gq', 'gsk-other-0123456789'));
    check('a key from the shell cannot be replaced here, and the words say where it comes from', /comes from your shell \(GROQ_API_KEY\)/.test(err) && !('apiKey' in readSettings().providers.gq), err);
    err = await fails(() => call('providers.removeKey', 'gq'));
    check('… nor removed', /comes from your shell/.test(err));
    delete process.env.GROQ_API_KEY;
    err = await fails(() => call('providers.setKey', 'or', 'has space-0123456789'));
    check('a key with a space is refused without echoing it', /no spaces/.test(err) && !err.includes('0123456789'));
    err = await fails(() => call('providers.setKey', 'ollama', 'whatever-0123456789'));
    check('Ollama takes no key', /takes no key/.test(err));

    // Add provider
    const res = await call('providers.add', { type: 'openrouter', name: 'or2', apiKey: 'sk-or-ADDED-0123456789' });
    check('Add provider writes the entry and its key to your settings.json and puts it in use', res.name === 'or2' && res.selected && readSettings().providers.or2.type === 'openrouter' && readSettings().providers.or2.apiKey === 'sk-or-ADDED-0123456789' && app.config().provider === 'or2', res);
    check('… the choice of provider is the app’s (config), not a line in your settings.json', !('provider' in readSettings()));
    err = await fails(() => call('providers.add', { type: 'openrouter', name: 'or2', apiKey: 'x-0123456789' }));
    check('a name already taken is refused', /already a provider named "or2"/.test(err), err);
    err = await fails(() => call('providers.add', { type: 'openrouter', name: 'bad name', apiKey: 'x-0123456789' }));
    check('a name that is not a name is refused in plain words', /1 to 48 letters/.test(err), err);
    err = await fails(() => call('providers.add', { type: 'openai-compatible', name: 'c' }));
    check('OpenAI-compatible needs its base URL', err === 'Enter the base URL.', err);
    err = await fails(() => call('providers.add', { type: 'groq', name: 'g2' }));
    check('a type that needs a key, with none set anywhere, asks for it', err === 'Paste the key.', err);
    const c = await call('providers.add', { type: 'openai-compatible', name: 'local', baseURL: base });
    check('an OpenAI-compatible service without a key is added with its base URL', c.selected && readSettings().providers.local.baseURL === base && !('apiKey' in readSettings().providers.local));
    const o = await call('providers.add', { type: 'ollama' });
    check('Ollama adds nothing: the built-in one is put in use', o.name === 'ollama' && o.selected && app.config().provider === 'ollama' && !('ollama' in readSettings().providers));

    // The model of an entry of your settings.json is written there; of a block, in the app's settings
    await call('providers.setModel', 'or2', 'anthropic/claude-opus-5-5');
    check('choosing a model of an entry of your settings.json writes it there', readSettings().providers.or2.model === 'anthropic/claude-opus-5-5' && app.config().providers.or2.model === 'anthropic/claude-opus-5-5');
    await call('providers.use', 'or2');
    check('providers.use puts a provider in use', app.config().provider === 'or2');

    // Remove a provider you added: the one in use gives way to one that is ready
    await call('providers.remove', 'or2');
    check('Remove takes the entry and its key out of your settings.json', !('or2' in readSettings().providers) && !JSON.stringify(readSettings()).includes('ADDED'));
    check('… and another provider that is ready takes its place', app.config().provider !== 'or2' && !P.resolveProvider(app.config()).error?.startsWith('There is no provider'), app.config().provider);
    err = await fails(() => call('providers.remove', 'portkey'));
    check('a built-in provider cannot be removed', /built-in/.test(err));

    // Nothing held the whole key: the window's pushes, the log
    const all = [SECRET, 'gw-SECRET-key-0123456789', 'pk-SECRET-in-app-0123456789', 'sk-or-ADDED-0123456789'];
    const pushed = pushes.map((p) => p.payload).join('\n');
    check('no key ever reached the window whole (every config:changed and settings:changed push)', all.every((k) => !pushed.includes(k)), all.filter((k) => pushed.includes(k)));
    check('no key reached a log line', all.every((k) => !logged.join('\n').includes(k)));
    mock.close();
  }

  fs.rmSync(root, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.log('CRASH', err && err.stack);
  process.exit(1);
});
