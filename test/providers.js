// Named providers: resolution of every type and of the two config.json blocks (a 0.4.0 config.json resolves as
// before), validation and its problem lines, keys never leaking (window copy, mods, settings info, errors, the
// command's output), the JSON Schema against the validation code and against docs/configure.md, the silo
// command against a temporary config folder (every command, --json, exit codes, --key-stdin, unknown keys and
// formatting kept, provider test against the mock model), and the Command line tool row's install / remove.
// Run: node test/providers.js   (CLI_TRANSCRIPT=<file> also writes every command and its output there)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (f) => require(path.join(projectDir, 'dist/main', f));
const { check, done } = require('./support/check.js');
const { validate } = require('./support/json-schema.js');
const { startMock } = require('./support/mock-model.js');

console.warn = () => {};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-providers-'));
process.env.SILO_HARNESS_CONFIG_DIR = path.join(root, 'home-config');
const P = dist('providers.js');
const presets = dist('provider-presets.js');
const { defaultConfig, readStoredConfig, normalizeConfig } = dist('config.js');
const { SettingsLayer, settingsSchema, settableFields, contentHash, trustKey } = dist('settings.js');

let n = 0;
const tmp = () => {
  const d = path.join(root, `d${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return fs.realpathSync(d);
};
const write = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return file;
};
const cfgWith = (over) => normalizeConfig({ ...defaultConfig(), workingDirectory: tmp(), ...over });
const PLANTED = 'sk-PLANTED-9f8e7d6c5b4a3210';
const headersOf = (client) => {
  const h = client._options?.defaultHeaders ?? {};
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
};

(async () => {
  // --- every type resolves over its preset ------------------------------------------------------------------
  {
    const results = [];
    for (const type of presets.PROVIDER_TYPES) {
      const preset = presets.PRESETS[type];
      const entry = { type, model: 'm-1', ...(type === 'openai-compatible' ? { baseURL: 'https://gw.example.com/v1/' } : {}) };
      const env = preset.keyEnv ? { [preset.keyEnv]: `key-${type}-0123456789` } : {};
      const cfg = cfgWith({ provider: 'p', providers: { p: entry } });
      const r = P.resolveProvider(cfg, undefined, env);
      const wantBase = (preset.baseURL || 'https://gw.example.com/v1').replace(/\/+$/, '');
      const client = P.clientFor(r);
      results.push({
        type,
        ok: !r.error && r.baseURL === wantBase && r.label === preset.label && r.model === 'm-1' && r.apiKey === (env[preset.keyEnv] ?? '') && client.baseURL === wantBase && (preset.keyEnv ? client.apiKey === env[preset.keyEnv] : true),
        r: { error: r.error, baseURL: r.baseURL, label: r.label, key: r.apiKey ? 'set' : '' },
      });
    }
    const bad = results.filter((x) => !x.ok);
    check(`every type (${presets.PROVIDER_TYPES.length}) resolves to its preset's base URL, label, key variable and the model`, !bad.length, bad);
    const or = P.resolveProvider(cfgWith({ provider: 'or', providers: { or: { type: 'openrouter', model: 'x', headers: { 'X-OpenRouter-Title': 'Mine', 'X-Extra': '${EXTRA_H}' } } } }), undefined, { OPENROUTER_API_KEY: 'k-or-0123456789', EXTRA_H: 'expanded' });
    check('openrouter sends its attribution headers; the entry’s headers win and ${VAR} is expanded', or.headers['HTTP-Referer'] && or.headers['X-OpenRouter-Title'] === 'Mine' && or.headers['X-Extra'] === 'expanded', or.headers);
    const pk = P.resolveProvider(cfgWith({ provider: 'pk', providers: { pk: { type: 'portkey', virtualKey: 'vk-1', config: 'pc-1', provider: 'openai', model: 'gpt' } } }), undefined, { PORTKEY_API_KEY: 'pk-0123456789' });
    check('a portkey entry sends the Portkey headers', pk.headers['x-portkey-api-key'] === 'pk-0123456789' && pk.headers['x-portkey-virtual-key'] === 'vk-1' && pk.headers['x-portkey-config'] === 'pc-1' && pk.headers['x-portkey-provider'] === 'openai', pk.headers);
    const env2 = P.resolveProvider(cfgWith({ provider: 'a', providers: { a: { type: 'anthropic', apiKeyEnv: 'MY_ANTH', model: 'claude' } } }), undefined, { MY_ANTH: 'sk-ant-0123456789', ANTHROPIC_API_KEY: 'other' });
    check('apiKeyEnv names the variable the key comes from', env2.apiKey === 'sk-ant-0123456789' && env2.keySource === 'MY_ANTH');
    const own = P.resolveProvider(cfgWith({ provider: 'a', providers: { a: { type: 'openai', apiKey: 'sk-own-0123456789', model: 'gpt' } } }), undefined, { OPENAI_API_KEY: 'other' });
    check('apiKey in the entry wins over the variable', own.apiKey === 'sk-own-0123456789' && own.keySource === 'providers.a.apiKey');
    const missing = P.resolveProvider(cfgWith({ provider: 'g', providers: { g: { type: 'groq', model: 'llama' } } }), undefined, {});
    check('a missing key is an error that names the variable to set', /GROQ_API_KEY/.test(missing.error || '') && /needs a key/.test(missing.error), missing.error);
    const noModel = P.resolveProvider(cfgWith({ provider: 'g', providers: { g: { type: 'groq' } } }), undefined, { GROQ_API_KEY: 'gsk-0123456789' });
    check('no model is an error that says how to set one', /No model set for Groq/.test(noModel.error || '') && /provider use g --model/.test(noModel.error), noModel.error);
    const unknown = P.resolveProvider(cfgWith({ provider: 'nope' }), undefined, {});
    check('an unknown provider name is an error that lists the known ones', /no provider named "nope"/.test(unknown.error) && /ollama, portkey/.test(unknown.error), unknown.error);
    let threw = '';
    try {
      P.makeClient(cfgWith({ provider: 'g', providers: { g: { type: 'groq', model: 'x' } } }));
    } catch (e) {
      threw = e.message;
    }
    check('makeClient throws the plain error', /needs a key/.test(threw), threw);
    const lm = P.resolveProvider(cfgWith({ provider: 'lm', providers: { lm: { type: 'lmstudio', model: 'q', contextWindow: 32768, maxOutput: 4096 } } }), undefined, {});
    check('a local service needs no key; contextWindow and maxOutput come from the entry', !lm.error && lm.contextWindow === 32768 && lm.maxOutput === 4096 && P.makeClient(cfgWith({ provider: 'lm', providers: { lm: { type: 'lmstudio', model: 'q', maxOutput: 4096 } } })).maxOutput === 4096);
    const twins = cfgWith({ provider: 'a', providers: { a: { type: 'openrouter', model: 'x' }, b: { type: 'openrouter', model: 'y' }, c: { type: 'openrouter', label: 'Mine', model: 'z' } } });
    check('two entries of one type get their names in the label; a label wins', P.resolveProvider(twins, 'a').label === 'OpenRouter (a)' && P.resolveProvider(twins, 'c').label === 'Mine');
    const ol = cfgWith({ provider: 'box', providers: { box: { type: 'ollama', baseURL: 'http://10.0.0.2:11434/v1', model: 'qwen3:14b', numCtx: 32768, think: 'off' } } });
    const olv = P.ollamaOf(ol);
    check('an ollama entry takes the native path with its own address, model, num_ctx and thinking', P.isOllama(ol) && olv.baseURL === 'http://10.0.0.2:11434/v1' && olv.model === 'qwen3:14b' && olv.numCtx === 32768 && olv.think === 'off', olv);
    const agent = dist('agent.js');
    check('the context window follows the provider in use', agent.contextLimit(ol) === 32768 && agent.contextLimit(lm.name ? cfgWith({ provider: 'lm', providers: { lm: { type: 'lmstudio', model: 'q', contextWindow: 32768 } } }) : null) === 32768 && agent.contextLimit(cfgWith({ provider: 'g', providers: { g: { type: 'groq', model: 'x' } } })) === 128000);
    check('activeModel and providerNames', P.activeModel(ol) === 'qwen3:14b' && JSON.stringify(P.providerNames(twins)) === '["ollama","portkey","a","b","c"]');
  }

  // --- the two blocks: a 0.4.0 config.json resolves exactly as before --------------------------------------
  {
    const d = tmp();
    const file = write(path.join(d, 'config.json'), {
      schemaVersion: 2,
      provider: 'portkey',
      ollama: { baseURL: 'http://localhost:11434/v1', model: 'qwen3:8b', numCtx: 16384, think: 'auto' },
      portkey: { baseURL: 'https://api.portkey.ai/v1', apiKey: 'pk-040-0123456789', model: '@openai/gpt-4o-mini', virtualKey: 'vk-040', provider: 'openai', providerApiKey: 'sk-upstream-0123456789', configId: 'pc-040', contextWindow: 64000 },
      workingDirectory: d,
      permissionMode: 'ask',
      someFutureKey: { kept: true },
    });
    const cfg = readStoredConfig(file);
    const made = P.makeClient(cfg);
    const h = headersOf(made.client);
    check('0.4.0 portkey block: same base URL, model, bearer and headers as before', made.client.baseURL === 'https://api.portkey.ai/v1' && made.model === '@openai/gpt-4o-mini' && made.client.apiKey === 'sk-upstream-0123456789' && h['x-portkey-api-key'] === 'pk-040-0123456789' && h['x-portkey-virtual-key'] === 'vk-040' && h['x-portkey-provider'] === 'openai' && h['x-portkey-config'] === 'pc-040', { base: made.client.baseURL, h });
    check('0.4.0 portkey block: label Portkey · model, context window as stored', made.label === 'Portkey · @openai/gpt-4o-mini' && dist('agent.js').contextLimit(cfg) === 64000);
    check('a 0.4.0 config.json has no providers and gets an empty map; nothing else changes', JSON.stringify(cfg.providers) === '{}' && cfg.provider === 'portkey' && cfg.portkey.apiKey === 'pk-040-0123456789');
    // The live rig's shape: the gateway block pointed at another service, the key from PORTKEY_API_KEY
    const rig = normalizeConfig({ ...defaultConfig(), provider: 'portkey', portkey: { ...defaultConfig().portkey, baseURL: 'https://api.anthropic.com/v1', apiKey: '', model: 'claude-haiku-5-5' } });
    const saved = process.env.PORTKEY_API_KEY;
    process.env.PORTKEY_API_KEY = 'sk-ant-rig-0123456789';
    const rm = P.makeClient(rig);
    process.env.PORTKEY_API_KEY = saved;
    if (saved === undefined) delete process.env.PORTKEY_API_KEY;
    check('the gateway block elsewhere: key from PORTKEY_API_KEY as bearer, labelled Gateway (no longer “Portkey”)', rm.client.apiKey === 'sk-ant-rig-0123456789' && headersOf(rm.client)['x-portkey-api-key'] === 'sk-ant-rig-0123456789' && rm.label === 'Gateway · claude-haiku-5-5');
    const o = normalizeConfig({ ...defaultConfig(), provider: 'ollama' });
    const om = P.makeClient(o);
    check('0.4.0 ollama block: same address and model; native path', om.client.baseURL === 'http://localhost:11434/v1' && om.model === 'qwen3:8b' && om.label === 'Ollama · qwen3:8b' && P.isOllama(o) && P.ollamaOf(o) === o.ollama);
    const noKey = normalizeConfig({ ...defaultConfig(), provider: 'portkey' });
    let msg = '';
    const k = process.env.PORTKEY_API_KEY;
    delete process.env.PORTKEY_API_KEY;
    try {
      P.makeClient(noKey);
    } catch (e) {
      msg = e.message;
    }
    if (k !== undefined) process.env.PORTKEY_API_KEY = k;
    check('the portkey block without a key gives the same message as 0.4.0', msg === 'Portkey API key is not set. Open Settings and add it, or export PORTKEY_API_KEY.', msg);
  }

  // --- validation in the settings layer ---------------------------------------------------------------------
  {
    const cwd = tmp();
    const userFile = write(path.join(tmp(), 'settings.json'), {
      provider: 'good',
      providers: {
        good: { type: 'openrouter', model: 'a/b', models: ['a/b', 'c/d'], apiKeyEnv: 'OR_KEY', contextWindow: 200000 },
        badtype: { type: 'nope' },
        notype: { model: 'x' },
        ollama: { type: 'openai' },
        'bad name!': { type: 'openai' },
        nourl: { type: 'openai-compatible' },
        extra: { type: 'openai', model: 'm', virtualKey: 'vk', colour: 'red', contextWindow: 'big' },
        both: { type: 'openai', model: 'm', apiKey: 'sk-both-0123456789', apiKeyEnv: 'OPENAI_API_KEY' },
        notobj: 'openai',
      },
    });
    const layer = new SettingsLayer({ userFile });
    const cfg = layer.load(cfgWith({ workingDirectory: cwd }));
    const info = layer.info();
    const inv = Object.fromEntries(info.files[0].invalid.map((i) => [i.key, i.message]));
    check('a good entry applies and is owned by the file', cfg.provider === 'good' && cfg.providers.good?.model === 'a/b' && info.owned['providers.good'] === 'user');
    check('an unknown type is skipped with the list of types', /expected one of "openrouter"/.test(inv['providers.badtype.type'] || '') && !cfg.providers.badtype, inv);
    check('an entry without a type is skipped with a reason', /needs a "type"/.test(inv['providers.notype'] || '') && !cfg.providers.notype);
    check('the names ollama and portkey are refused with a clear message', /built-in provider/.test(inv['providers.ollama'] || '') && !('ollama' in cfg.providers), inv['providers.ollama']);
    check('a bad name is refused', /provider name is/.test(inv['providers.bad name!'] || ''));
    check('openai-compatible without baseURL is skipped whole', /needs a baseURL/.test(inv['providers.nourl.baseURL'] || '') && !cfg.providers.nourl);
    check('a field for another type, an unknown field and a bad value are skipped; the entry applies without them', /only for type portkey/.test(inv['providers.extra.virtualKey'] || '') && /not a provider setting/.test(inv['providers.extra.colour'] || '') && /whole number/.test(inv['providers.extra.contextWindow'] || '') && cfg.providers.extra?.model === 'm' && !('virtualKey' in cfg.providers.extra) && !('colour' in cfg.providers.extra), inv);
    check('apiKey with apiKeyEnv: reported, apiKey used', /apiKey is used/.test(inv['providers.both.apiKeyEnv'] || '') && P.resolveProvider(cfg, 'both', {}).apiKey === 'sk-both-0123456789');
    check('a non-object entry is reported', /expected an object/.test(inv['providers.notobj'] || ''));
    check('the problem lines never carry a value', !JSON.stringify(info).includes('sk-both-0123456789'));
    const stored = layer.withoutSettings(cfg);
    check('withoutSettings: an entry from the file is never written to config.json', !stored.providers.good && stored.provider !== 'good');
    check('"providers" that is not an object is reported', (() => {
      const l2 = new SettingsLayer({ userFile: write(path.join(tmp(), 'settings.json'), { providers: [] }) });
      l2.load(cfgWith({}));
      return /named providers/.test(l2.info().files[0].invalid[0]?.message || '');
    })());

    // A project's file: no keys, but variables may be named
    const proj = tmp();
    const projectFile = write(path.join(proj, '.silo-harness', 'settings.json'), {
      env: { OPENAI_API_KEY: 'sk-from-repo-0123456789', SOME_FLAG: 'yes' },
      provider: 'repo',
      providers: { repo: { type: 'openai', apiKey: 'sk-from-repo-0123456789', apiKeyEnv: 'TEAM_KEY', model: 'gpt' } },
      portkey: { apiKey: 'pk-from-repo-0123456789', model: '@x/y' },
    });
    const pl = new SettingsLayer({ userFile: path.join(tmp(), 'none.json') });
    const pcfg = pl.load(cfgWith({ workingDirectory: proj, settingsTrusted: { [trustKey(proj)]: contentHash(fs.readFileSync(projectFile, 'utf8')) } }));
    const pinv = Object.fromEntries(pl.info().files[1].invalid.map((i) => [i.key, i.message]));
    check("a project's apiKey and apiKeyEnv are ignored with problem lines; the entry applies with the type's own variable", /may not hold a key/.test(pinv['providers.repo.apiKey'] || '') && /may not choose the variable/.test(pinv['providers.repo.apiKeyEnv'] || '') && pcfg.providers.repo && !('apiKey' in pcfg.providers.repo) && !('apiKeyEnv' in pcfg.providers.repo) && P.resolveProvider(pcfg, 'repo', { OPENAI_API_KEY: 'sk-user-0123456789', TEAM_KEY: 'sk-team-0123456789' }).apiKey === 'sk-user-0123456789', pinv);
    check("a project's portkey.apiKey is ignored; the rest of the block applies", /may not hold a key/.test(pinv['portkey.apiKey'] || '') && pcfg.portkey.model === '@x/y' && pcfg.portkey.apiKey === '');
    check("a project's env block may not set a key variable; other variables apply", /may not set a key variable/.test(pinv['env.OPENAI_API_KEY'] || '') && process.env.OPENAI_API_KEY !== 'sk-from-repo-0123456789' && process.env.SOME_FLAG === 'yes');
    pl.restoreEnv();

    // A trusted project file may not send your key to an address of its own choosing
    const proj2 = tmp();
    const file2 = write(path.join(proj2, '.silo-harness', 'settings.json'), {
      providers: {
        redirect: { type: 'openai', baseURL: 'https://evil.example/v1', model: 'gpt' },
        redirectEnv: { type: 'anthropic', baseURL: 'https://evil.example/v1', apiKeyEnv: 'TEAM_KEY', model: 'c' },
        localEnv: { type: 'ollama', baseURL: 'http://evil.example:11434/v1', apiKeyEnv: 'TEAM_KEY', model: 'q' },
        gateway: { type: 'openai-compatible', baseURL: 'https://gw.example/v1', apiKeyEnv: 'TEAM_KEY', model: 'm', headers: { Authorization: 'Bearer ${OPENAI_API_KEY}', 'X-Team': 'core', 'X-Mixed': 'a-${HOME}' } },
        lan: { type: 'ollama', baseURL: 'http://192.168.1.20:11434/v1', model: 'qwen3:14b' },
        studio: { type: 'lmstudio', baseURL: 'http://192.168.1.21:1234/v1', model: 'q' },
        plain: { type: 'openai', apiKeyEnv: 'TEAM_KEY', model: 'gpt', headers: { 'X-Key': '${OPENAI_API_KEY}' } },
      },
    });
    const pl2 = new SettingsLayer({ userFile: path.join(tmp(), 'none.json') });
    const p2 = pl2.load(cfgWith({ workingDirectory: proj2, settingsTrusted: { [trustKey(proj2)]: contentHash(fs.readFileSync(file2, 'utf8')) } }));
    const inv2 = Object.fromEntries(pl2.info().files[1].invalid.map((i) => [i.key, i.message]));
    const ADDR = /may not point a keyed service at an address of its own; define this provider in your own settings\.json and select it here with "provider"/;
    check("project: a keyed type with its own baseURL (the type's default variable) is dropped whole", ADDR.test(inv2['providers.redirect.baseURL'] || '') && !p2.providers.redirect, inv2);
    check('project: a keyed type with apiKeyEnv and its own baseURL is dropped whole', ADDR.test(inv2['providers.redirectEnv.baseURL'] || '') && !p2.providers.redirectEnv);
    check('project: an ollama entry may not name a key variable; its address applies, without a key', /may not choose the variable/.test(inv2['providers.localEnv.apiKeyEnv'] || '') && p2.providers.localEnv?.baseURL === 'http://evil.example:11434/v1' && !('apiKeyEnv' in p2.providers.localEnv) && P.resolveProvider(p2, 'localEnv', { TEAM_KEY: 'sk-team-0123456789' }).apiKey === '', inv2);
    check('project: openai-compatible may not name a key variable; the entry applies without a key', /may not choose the variable/.test(inv2['providers.gateway.apiKeyEnv'] || '') && p2.providers.gateway && !('apiKeyEnv' in p2.providers.gateway) && P.resolveProvider(p2, 'gateway', { TEAM_KEY: 'sk-team-0123456789' }).bearer === 'none');
    check('project: a variable in a header is refused, header by header; plain headers apply', /may not put a variable in a header/.test(inv2['providers.gateway.headers.Authorization'] || '') && /may not put a variable in a header/.test(inv2['providers.gateway.headers.X-Mixed'] || '') && JSON.stringify(p2.providers.gateway.headers) === '{"X-Team":"core"}', p2.providers.gateway);
    check('project: a variable in the only header leaves no headers', /may not put a variable in a header/.test(inv2['providers.plain.headers.X-Key'] || '') && p2.providers.plain && !('headers' in p2.providers.plain));
    check('project: ollama and lmstudio may set their address (no key)', p2.providers.lan?.baseURL === 'http://192.168.1.20:11434/v1' && p2.providers.studio?.baseURL === 'http://192.168.1.21:1234/v1' && !inv2['providers.lan.baseURL']);
    check("project: a keyed type at its documented address may not name a variable; the type's own is used", /may not choose the variable/.test(inv2['providers.plain.apiKeyEnv'] || '') && p2.providers.plain && !('apiKeyEnv' in p2.providers.plain) && P.resolveProvider(p2, 'plain', { OPENAI_API_KEY: 'sk-user-0123456789', TEAM_KEY: 'sk-team-0123456789' }).apiKey === 'sk-user-0123456789' && P.resolveProvider(p2, 'plain', {}).baseURL === 'https://api.openai.com/v1', inv2);
    pl2.restoreEnv();
    // The same entries in your own file all apply
    const ul = new SettingsLayer({ userFile: write(path.join(tmp(), 'settings.json'), JSON.parse(fs.readFileSync(file2, 'utf8'))) });
    const u2 = ul.load(cfgWith({}));
    check('in your own settings.json the same entries apply as written', ['redirect', 'redirectEnv', 'localEnv', 'gateway'].every((n) => u2.providers[n]) && u2.providers.gateway.apiKeyEnv === 'TEAM_KEY' && !ul.info().files[0].invalid.length, ul.info().files[0].invalid);
    ul.restoreEnv();
  }

  // --- keys never leak --------------------------------------------------------------------------------------
  {
    const env = { LEAK_ENV: PLANTED };
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const cfg = cfgWith({
      provider: 'a',
      portkey: { ...defaultConfig().portkey, apiKey: PLANTED, providerApiKey: PLANTED },
      providers: {
        a: { type: 'openai-compatible', baseURL: 'https://gw.example.com/v1', apiKey: PLANTED, model: 'm', headers: { Authorization: `Bearer ${PLANTED}`, 'X-Token': PLANTED } },
        b: { type: 'openai', apiKeyEnv: 'LEAK_ENV', model: 'm' },
      },
    });
    const win = P.windowConfig(cfg, {});
    const winText = JSON.stringify(win);
    check('the window’s copy of the config holds no key (block keys, entry keys, header values)', !winText.includes(PLANTED) && win.portkey.apiKey === P.KEY_MASK && win.providers.a.apiKey === P.KEY_MASK && win.providers.a.headers['X-Token'] === P.KEY_MASK);
    check('…and says which keys are set', win.providerView.active.key === 'set' && win.providerView.all.find((p) => p.name === 'b').key === 'set' && win.providerView.all.find((p) => p.name === 'b').keySource === 'LEAK_ENV');
    const back = P.acceptFromWindow(cfg, win);
    check('a config sent back by the window keeps the real keys and leaves providers alone', back.portkey.apiKey === PLANTED && back.portkey.providerApiKey === PLANTED && !('providers' in back) && !('providerView' in back));
    const cleared = P.acceptFromWindow(cfg, { ...win, portkey: { ...win.portkey, apiKey: '' } });
    check('clearing the key in the window clears it', cleared.portkey.apiKey === '');
    const { publicConfig } = dist('mods/public-config.js');
    check('what mods can read holds no key and names the provider', !JSON.stringify(publicConfig(cfg)).includes(PLANTED) && publicConfig(cfg).provider === 'a' && publicConfig(cfg).model === 'm');
    const r = P.resolveProvider(cfg);
    const e1 = P.plainError({ status: 401, error: { message: `Incorrect API key provided: ${PLANTED}` } }, r);
    check('a service’s error that quotes the key is scrubbed', !e1.includes(PLANTED) && /refused the key \(HTTP 401\)/.test(e1), e1);
    // The SDK's connection error: its name is "Error", the class only on the constructor, the code two causes deep
    class APIConnectionError extends Error {}
    const refused = Object.assign(new APIConnectionError('Connection error.'), { cause: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) });
    const e2 = P.plainError(refused, r);
    check('a refused connection (the SDK’s "Connection error.") reads "Could not reach", with its code', /^Could not reach .* \(ECONNREFUSED\)\. Check the base URL/.test(e2), e2);
    check('scrubSecrets covers every resolved key, also from headers and variables', !P.scrubSecrets(`a ${PLANTED} b`).includes(PLANTED));
    // A key carried in a URL: user:key@host, or a query parameter
    const inUser = P.scrubSecrets('Could not reach X at https://alice:sk-user-0123456789@gw.example.com/v1.');
    check('scrubSecrets removes a key given as user:key@host', !inUser.includes('sk-user-0123456789') && !inUser.includes('alice') && inUser.includes('https://…@gw.example.com/v1'), inUser);
    const inBare = P.scrubSecrets('at http://sk-bare-0123456789@10.0.0.2:4000/v1 (HTTP 404)');
    check('…and a key given alone before the @', !inBare.includes('sk-bare-0123456789') && inBare.includes('http://…@10.0.0.2:4000/v1'), inBare);
    const inQuery = P.scrubSecrets('X has no list of models at https://gw.example.com/v1?api-version=2024-10-01&api_key=sk-q-0123456789&x=1/models (HTTP 404).');
    check('scrubSecrets removes a key given as a query parameter, and keeps the other parameters', !inQuery.includes('sk-q-0123456789') && inQuery.includes('api_key=…') && inQuery.includes('api-version=2024-10-01') && inQuery.includes('&x=1'), inQuery);
    check('…also as key=, token= and access_token=', ['?key=abc123secret', '?token=abc123secret', '&access_token=abc123secret', '?sig=abc123secret'].every((q) => !P.scrubSecrets(`https://h.example${q}`).includes('abc123secret')));
    check('…and leaves a URL without a key alone', P.scrubSecrets('Could not reach X at https://gw.example.com/v1?api-version=2024-10-01.') === 'Could not reach X at https://gw.example.com/v1?api-version=2024-10-01.');
    // providerCatalog's "no list of models" (HTTP 404) text names the base URL: without the key in it
    {
      const http = require('node:http');
      const srv = http.createServer((q, s) => { s.writeHead(404, { 'content-type': 'application/json' }); s.end('{"error":{"message":"not found"}}'); });
      await new Promise((res) => srv.listen(0, '127.0.0.1', res));
      const QKEY = 'sk-in-query-0123456789';
      const rq = P.resolveProvider({ ...cfg, provider: 'q', providers: { q: { type: 'openai-compatible', baseURL: `http://127.0.0.1:${srv.address().port}/v1?api_key=${QKEY}`, apiKey: 'none-needed-here', model: 'm' } } }, 'q');
      const cq = await P.providerCatalog(rq, 3000);
      check('providerCatalog: a 404 for the list does not show a key carried in the base URL', !cq.listed && /has no list of models at .*\(HTTP 404\)/.test(cq.error) && !cq.error.includes(QKEY), cq.error);
      srv.close();
    }
    check('the remote page and the history export use activeModel, not a key', P.activeModel(cfg) === 'm');
    delete process.env.LEAK_ENV;
  }

  // --- the schema: generated from the code, and the docs' examples -----------------------------------------
  {
    const schema = settingsSchema();
    const onDisk = JSON.parse(fs.readFileSync(path.join(projectDir, 'docs', 'settings.schema.json'), 'utf8'));
    check('docs/settings.schema.json is what the validation code generates (run npm run schema)', JSON.stringify(onDisk) === JSON.stringify(schema));
    const props = Object.keys(schema.properties);
    const want = ['$schema', 'env', 'workingDirectory', 'providers', ...new Set(settableFields().map((f) => f.split('.')[0]))];
    check('the schema covers every settable field and nothing else', props.length === want.length && want.every((k) => props.includes(k)), { props, want });
    const entryProps = Object.keys(schema.properties.providers.additionalProperties.properties);
    check('the schema’s provider entry has every entry field and the types are the presets', JSON.stringify(entryProps) === JSON.stringify(Object.keys(presets.ENTRY_FIELDS)) && JSON.stringify(schema.properties.providers.additionalProperties.properties.type.enum) === JSON.stringify(presets.PROVIDER_TYPES));

    const md = fs.readFileSync(path.join(projectDir, 'docs', 'configure.md'), 'utf8');
    const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    const results = blocks.map((b, i) => {
      const obj = JSON.parse(b);
      const errors = validate(schema, obj);
      const file = write(path.join(tmp(), 'settings.json'), obj);
      const layer = new SettingsLayer({ userFile: file });
      const cfg = layer.load(cfgWith({}));
      const invalid = layer.info().files[0].invalid;
      layer.restoreEnv();
      const resolved = P.resolveProvider(cfg, undefined, { ...process.env, ...(obj.env || {}) });
      return { i, errors, invalid, resolveError: resolved.error };
    });
    check(`every example in configure.md (${blocks.length}) passes the schema and the app's validation, and resolves`, blocks.length >= 8 && results.every((r) => !r.errors.length && !r.invalid.length && !r.resolveError), results.filter((r) => r.errors.length || r.invalid.length || r.resolveError));

    const wrong = [
      { maxTurns: 'many' },
      { theme: 'blue' },
      { colour: 'red' },
      { provider: '' },
      { providers: { ollama: { type: 'openai' } } },
      { providers: { x: { type: 'nope' } } },
      { providers: { x: { model: 'm' } } },
      { providers: { x: { type: 'openai-compatible' } } },
      { providers: { x: { type: 'openai', virtualKey: 'vk' } } },
      { providers: { x: { type: 'openai', headers: { 'Bad Header': 'v' } } } },
      { providers: { x: { type: 'openai', contextWindow: 0 } } },
      { providers: { x: { type: 'openai', apiKeyEnv: '1BAD' } } },
      { providers: { x: { type: 'openai', baseURL: 'ftp://x' } } },
      { ollama: { numCtx: -1 } },
      { dreaming: { time: '25:00' } },
      { env: { '1X': 'v' } },
    ];
    const missed = wrong.filter((obj) => {
      const errors = validate(schema, obj);
      const layer = new SettingsLayer({ userFile: write(path.join(tmp(), 'settings.json'), obj) });
      layer.load(cfgWith({}));
      const invalid = layer.info().files[0].invalid;
      layer.restoreEnv();
      return !errors.length || !invalid.length;
    });
    check(`deliberately wrong files (${wrong.length}) fail both the schema and the app's validation`, !missed.length, missed);
  }

  // --- the command line -------------------------------------------------------------------------------------
  const transcript = [];
  const outputs = [];
  const cliDir = tmp();
  const CLI_ENV = { SILO_HARNESS_CONFIG_DIR: path.join(cliDir, 'config'), SILO_HARNESS_USER_DATA: path.join(cliDir, 'data') };
  const settingsFile = path.join(CLI_ENV.SILO_HARNESS_CONFIG_DIR, 'settings.json');
  const bin = path.join(projectDir, 'bin', 'silo.js');
  function run(args, opts = {}) {
    return new Promise((resolve) => {
      const env = { ...process.env, ...CLI_ENV, ...(opts.env || {}) };
      for (const k of ['OPENROUTER_API_KEY', 'PORTKEY_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) if (!(opts.env && k in opts.env)) delete env[k];
      const child = spawn(process.execPath, [bin, ...args], { env, cwd: cliDir });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.stdin.end(opts.input ?? '');
      child.on('close', (code) => {
        outputs.push(out + err);
        transcript.push(`$ silo ${args.join(' ').split(PLANTED).join('<a key typed as an argument>')}${opts.input !== undefined ? '   (key on standard input)' : ''}\n${out}${err}[exit ${code}]\n`);
        let json = null;
        try {
          json = JSON.parse(out);
        } catch {
          /* not json */
        }
        resolve({ code, out, err, json });
      });
    });
  }
  const mock = await startMock();
  const mockURL = `http://127.0.0.1:${mock.port}/v1`;
  try {
    let r = await run(['--help']);
    check('--help: usage and exit 0', r.code === 0 && /provider add <name> --type <type>/.test(r.out));
    r = await run(['provider', 'add', '--help']);
    check('provider add --help lists the types', r.code === 0 && /openrouter, portkey, openai/.test(r.out));
    r = await run(['config', 'path', '--json']);
    check('config path --json', r.code === 0 && r.json?.ok && r.json.settings === settingsFile && r.json.settingsExists === false);
    r = await run(['doctor', '--json']);
    check('doctor on a fresh folder: Ollama, usable, exit 0', r.code === 0 && r.json?.usable === true && r.json.provider.name === 'ollama');

    // A file with keys the command does not know: kept, and the file stays two-space JSON
    write(settingsFile, JSON.stringify({ $schema: 'https://brandeispatrick.github.io/silo-harness/settings.schema.json', myNote: { keep: [1, 2] }, theme: 'light' }, null, 2) + '\n');
    r = await run(['provider', 'add', 'mock', '--type', 'openai-compatible', '--base-url', mockURL, '--key-env', 'MOCK_KEY', '--model', 'mock-model', '--models', 'mock-model,other-model', '--header', 'X-Team=core', '--label', 'Mock gateway', '--json']);
    const afterAdd = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('provider add writes the entry', r.code === 0 && r.json?.ok && afterAdd.providers.mock.baseURL === mockURL && afterAdd.providers.mock.apiKeyEnv === 'MOCK_KEY' && JSON.stringify(afterAdd.providers.mock.models) === '["mock-model","other-model"]' && afterAdd.providers.mock.headers['X-Team'] === 'core', r.out + r.err);
    check('unknown keys and $schema are kept; the file is two-space JSON', afterAdd.myNote?.keep?.length === 2 && afterAdd.$schema && afterAdd.theme === 'light' && fs.readFileSync(settingsFile, 'utf8') === JSON.stringify(afterAdd, null, 2) + '\n');
    r = await run(['provider', 'add', 'mock', '--type', 'openai']);
    check('adding a name that exists fails (exit 1) and says how to replace it', r.code === 1 && /--replace/.test(r.err));
    r = await run(['provider', 'add', 'ollama', '--type', 'openai']);
    check('a built-in name is refused (exit 2)', r.code === 2 && /built-in provider/.test(r.err));
    r = await run(['provider', 'add', 'x', '--type', 'nope', '--json']);
    check('a bad type: exit 2, --json error', r.code === 2 && r.json?.ok === false && /expected one of/.test(r.json.error));
    r = await run(['provider', 'add', 'x', '--type', 'openai', '--key', PLANTED]);
    check('a key as an argument is refused (exit 2) and not echoed', r.code === 2 && /never taken from the command line/.test(r.err) && !r.err.includes(PLANTED));
    r = await run(['provider', 'add', 'x', '--type', 'openai-compatible']);
    check('openai-compatible without --base-url is refused', r.code === 2 && /needs a baseURL/.test(r.err));

    r = await run(['provider', 'use', 'mock', '--json']);
    check('provider use selects it', r.code === 0 && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).provider === 'mock' && r.json.provider.label === 'Mock gateway');
    r = await run(['provider', 'test', '--json']);
    check('provider test without the key: exit 1, names the variable', r.code === 1 && r.json?.ok === false && /MOCK_KEY/.test(r.json.error), r.out);
    mock.state.apiKey = 'mock-secret-0123456789';
    r = await run(['provider', 'test'], { env: { MOCK_KEY: 'mock-secret-0123456789' } });
    const testReq = mock.state.requests.filter((q) => q.url === '/v1/chat/completions').pop();
    check('provider test against the mock: ok, the model and the time', r.code === 0 && /^ok {2}Mock gateway · mock-model {2}\(\d+ ms\)/.test(r.out) && !r.out.includes('mock-secret'), r.out + r.err);
    check('…sending the key as bearer and the entry’s headers', testReq?.headers.authorization === 'Bearer mock-secret-0123456789' && testReq.headers['x-team'] === 'core' && testReq.payload.max_tokens === 16);
    r = await run(['provider', 'test', '--json'], { env: { MOCK_KEY: 'wrong-key-0123456789' } });
    check('a broken key: exit 1 and the service’s error in plain words', r.code === 1 && /refused the key \(HTTP 401\): Invalid API key \(mock\)/.test(r.json?.error || '') && !r.out.includes('wrong-key-0123456789'), r.out);
    mock.state.apiKey = undefined;

    r = await run(['provider', 'add', 'stdin', '--type', 'openrouter', '--key-stdin', '--model', 'a/b', '--json'], { input: `${PLANTED}\n` });
    const withKey = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('--key-stdin stores the key as apiKey, never prints it', r.code === 0 && withKey.providers.stdin.apiKey === PLANTED && !r.out.includes(PLANTED) && r.json.provider.key === 'set');
    r = await run(['provider', 'add', 'empty', '--type', 'openrouter', '--key-stdin'], { input: '' });
    check('--key-stdin with nothing on standard input changes nothing', r.code === 1 && !JSON.parse(fs.readFileSync(settingsFile, 'utf8')).providers.empty);
    r = await run(['provider', 'add', 'stdin', '--type', 'openrouter', '--model', 'c/d', '--replace']);
    check('--replace replaces an entry', r.code === 0 && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).providers.stdin.model === 'c/d');
    r = await run(['provider', 'use', 'ollama', '--model', 'llama3.1:8b']);
    const useOllama = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('provider use for a built-in sets its block’s model', r.code === 0 && useOllama.provider === 'ollama' && useOllama.ollama.model === 'llama3.1:8b');
    r = await run(['provider', 'use', 'nope']);
    check('provider use of an unknown name: exit 1 with the known names', r.code === 1 && /Known: ollama, portkey, mock/.test(r.err));
    r = await run(['provider', 'use', 'mock', '--model', 'other-model']);
    check('provider use --model for a named entry', r.code === 0 && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).providers.mock.model === 'other-model');

    r = await run(['provider', 'list']);
    check('provider list: a table with the one in use marked, no key', r.code === 0 && /^\* +mock /m.test(r.out) && /not set \(OPENROUTER_API_KEY\)/.test(r.out) && !r.out.includes(PLANTED));
    r = await run(['provider', 'list', '--json']);
    check('provider list --json', r.code === 0 && r.json.active === 'mock' && r.json.providers.length === 4 && !r.out.includes(PLANTED));

    // config
    r = await run(['config', 'set', 'maxTurns', '60']);
    check('config set reads numbers', r.code === 0 && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).maxTurns === 60);
    r = await run(['config', 'set', 'theme', 'dark', '--json']);
    check('config set a string, --json', r.code === 0 && r.json.value === 'dark');
    r = await run(['config', 'set', 'dreaming.time', '04:30']);
    check('config set a section field', r.code === 0 && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).dreaming.time === '04:30');
    r = await run(['config', 'set', 'maxTurns', 'many']);
    check('config set with a bad value: exit 2, the app’s reason, nothing written', r.code === 2 && /expected a whole number/.test(r.err) && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).maxTurns === 60);
    r = await run(['config', 'set', 'colour', 'red']);
    check('config set of an unknown key: exit 2', r.code === 2 && /not a setting/.test(r.err));
    r = await run(['config', 'set', 'portkey.apiKey', PLANTED]);
    check('config set of a secret as an argument is refused, not echoed', r.code === 2 && /--stdin/.test(r.err) && !r.err.includes(PLANTED) && !fs.readFileSync(settingsFile, 'utf8').includes(`"apiKey": "${PLANTED}",\n    "model"`));
    r = await run(['config', 'set', 'portkey.apiKey', '--stdin'], { input: PLANTED });
    check('config set --stdin takes a secret from standard input', r.code === 0 && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).portkey.apiKey === PLANTED && !r.out.includes(PLANTED));
    r = await run(['config', 'set', 'env.TEAM_FLAG', 'on']);
    check('config set env.NAME', r.code === 0 && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).env.TEAM_FLAG === 'on');
    r = await run(['config', 'get', 'maxTurns', '--json']);
    check('config get one field with its source', r.code === 0 && r.json.value === 60 && r.json.source === 'settings.json');
    r = await run(['config', 'get', 'portkey.apiKey']);
    check('config get of a secret says set, never the key', r.code === 0 && r.out.trim() === 'set');
    r = await run(['config', 'get']);
    check('config get: everything, no key', r.code === 0 && JSON.parse(r.out).maxTurns === 60 && !r.out.includes(PLANTED));
    r = await run(['config', 'get', 'nope']);
    check('config get of an unknown key: exit 2', r.code === 2);
    r = await run(['config', 'unset', 'theme']);
    check('config unset', r.code === 0 && !('theme' in JSON.parse(fs.readFileSync(settingsFile, 'utf8'))));
    r = await run(['config', 'unset', 'dreaming.time']);
    check('config unset of a section’s last field removes the section', r.code === 0 && !('dreaming' in JSON.parse(fs.readFileSync(settingsFile, 'utf8'))));
    r = await run(['config', 'unset', 'theme', '--json']);
    check('config unset of what is not set: exit 0, changed false', r.code === 0 && r.json.changed === false);

    r = await run(['doctor'], { env: { MOCK_KEY: 'mock-secret-0123456789' } });
    check('doctor: the provider in use, the model, the key set, exit 0', r.code === 0 && /Mock gateway \("mock", openai-compatible\), chosen in settings\.json/.test(r.out) && /key +set \(MOCK_KEY\)/.test(r.out) && !r.out.includes('mock-secret'), r.out);
    r = await run(['doctor', '--json']);
    check('doctor without the key: exit 1 and the reason', r.code === 1 && r.json.ok === false && /MOCK_KEY/.test(r.json.error));
    r = await run(['provider', 'remove', 'mock', '--json']);
    const afterRemove = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('provider remove of the one in use removes the choice too', r.code === 0 && !afterRemove.providers.mock && !('provider' in afterRemove) && r.json.active === 'ollama');
    r = await run(['provider', 'remove', 'mock']);
    check('removing what is not there: exit 1', r.code === 1 && /does not exist/.test(r.err));
    r = await run(['provider', 'remove', 'portkey']);
    check('a built-in cannot be removed', r.code === 1 && /built in/.test(r.err));
    check('unknown keys survived every write', JSON.parse(fs.readFileSync(settingsFile, 'utf8')).myNote?.keep?.length === 2);

    // A config.json written by the window is read too
    write(path.join(CLI_ENV.SILO_HARNESS_USER_DATA, 'config.json'), { schemaVersion: 2, provider: 'portkey', portkey: { ...defaultConfig().portkey, model: 'from-window' }, workingDirectory: cliDir });
    const s0 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    delete s0.provider;
    delete s0.portkey;
    write(settingsFile, JSON.stringify(s0, null, 2) + '\n');
    r = await run(['doctor', '--json'], { env: { PORTKEY_API_KEY: 'pk-env-0123456789' } });
    check('doctor reads config.json: the window’s choice and model', r.json?.provider?.name === 'portkey' && r.json.provider.model === 'from-window' && r.json.chosenIn.startsWith('config.json'), r.out);

    write(settingsFile, '{ not json');
    r = await run(['provider', 'add', 'z', '--type', 'openai']);
    check('a settings.json that is not JSON is never overwritten', r.code === 1 && /not valid JSON/.test(r.err) && fs.readFileSync(settingsFile, 'utf8') === '{ not json');
    r = await run(['frobnicate']);
    check('an unknown command: exit 2', r.code === 2);
    check('no key in any of the command’s output', !outputs.join('\n').includes(PLANTED) && !outputs.join('\n').includes('mock-secret-0123456789') && !transcript.join('\n').includes(PLANTED));
  } finally {
    mock.close();
  }
  if (process.env.CLI_TRANSCRIPT) fs.writeFileSync(process.env.CLI_TRANSCRIPT, `silo, every command against a temporary config folder (SILO_HARNESS_CONFIG_DIR, SILO_HARNESS_USER_DATA)\n\n${transcript.join('\n').split(root).join('<tmp>')}`);

  // --- the app side: providers.* and the Command line tool row ---------------------------------------------
  {
    const { createApp } = dist('app.js');
    const { setupProviders } = dist('providers-service.js');
    const m2 = await startMock();
    m2.state.models = ['b-model', 'a-model'];
    const linkDir = path.join(tmp(), 'bin-on-path');
    const command = write(path.join(tmp(), 'bin', 'silo'), '#!/bin/sh\n');
    const app = createApp({
      userData: tmp(),
      appRoot: projectDir,
      // Ollama at a closed port: a test never reaches an Ollama of this Mac
      loadConfig: () => cfgWith({ provider: 'm', ollama: { ...defaultConfig().ollama, baseURL: 'http://127.0.0.1:9/v1' }, providers: { m: { type: 'openai-compatible', baseURL: `http://127.0.0.1:${m2.port}/v1`, model: 'a-model', models: ['own-model'] } } }),
      saveConfig: () => {},
    });
    const pushes = [];
    app.push = (channel, payload) => pushes.push({ channel, payload });
    setupProviders(app, { linkDir, command, pathOf: async () => `/usr/bin:${linkDir}` });
    const call = (m, ...a) => app.invokeRpc(m, a);
    const models = await call('providers.models', 'm');
    check('providers.models: the entry’s list first, then what the service lists', JSON.stringify(models) === '["own-model","a-model","b-model"]', models);
    await call('providers.setModel', 'm', 'b-model');
    check('providers.setModel sets a named entry’s model', app.config().providers.m.model === 'b-model');
    await call('providers.setModel', 'ollama', 'qwen3:14b');
    check('providers.setModel sets a block’s model', app.config().ollama.model === 'qwen3:14b');
    const cp = pushes.filter((p) => p.channel === 'config:changed').pop();
    check('config:changed carries the window copy with the providers resolved', cp?.payload?.providerView?.active?.name === 'm' && cp.payload.providerView.active.model === 'b-model');
    const t = await call('providers.test', 'm');
    check('providers.test answers ok with the time', t.ok && t.model && t.ms >= 0, t);
    // With a model: exactly that model, through that provider, one request; the config stays as it was
    const before = m2.state.requests.length;
    const tm = await call('providers.test', 'm', 'a-model');
    const sentTest = m2.state.requests.slice(before).filter((q) => q.url === '/v1/chat/completions');
    check('providers.test with a model sends one request to exactly that model', tm.ok && sentTest.length === 1 && sentTest[0].payload.model === 'a-model' && sentTest[0].payload.max_tokens === 16, sentTest.map((q) => q.payload.model));
    check('… and changes nothing in the config', app.config().providers.m.model === 'b-model' && app.config().provider === 'm');
    const tOther = await call('providers.test', 'ollama', 'qwen3:14b');
    check('providers.test of another provider’s model: a plain error when it cannot be reached, the provider in use unchanged', !tOther.ok && /Ollama/.test(tOther.error) && tOther.model === 'qwen3:14b' && app.config().provider === 'm', tOther);
    const tUnknown = await call('providers.test', 'nope', 'x');
    check('providers.test of an unknown provider: its plain error, nothing sent', !tUnknown.ok && /There is no provider named "nope"/.test(tUnknown.error));
    m2.state.replies.push({ nonStream: true, status: 401, error: 'invalid key mock-secret-0123456789' });
    const tBad = await call('providers.test', 'm', 'a-model');
    check('providers.test: a refusal comes back in plain words', !tBad.ok && /HTTP 401/.test(tBad.error), tBad);
    // What a provider offers, for Settings → Models
    let catl = await call('providers.catalog', 'm');
    check('providers.catalog: its own models first, then the listed ones, listed', catl.listed && JSON.stringify(catl.models) === '["b-model","own-model","a-model"]' && JSON.stringify(catl.own) === '["b-model","own-model"]', catl);
    m2.state.modelsStatus = 404;
    catl = await call('providers.catalog', 'm');
    check('providers.catalog: a service that cannot list says why, and its own models stay', !catl.listed && !catl.unreachable && /404/.test(catl.error) && JSON.stringify(catl.models) === '["b-model","own-model"]', catl);
    delete m2.state.modelsStatus;
    catl = await call('providers.catalog', 'ollama');
    check('providers.catalog: an Ollama that is not running is not reachable, in plain words', !catl.listed && catl.unreachable === true && /Could not reach Ollama at .*Is Ollama running/.test(catl.error), catl);
    // An OpenAI-compatible service where nothing listens (port 9 on this Mac): not reachable, not "Error"
    catl = await P.providerCatalog(P.resolveProvider(cfgWith({ provider: 'x', providers: { x: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x-1' } } }), 'x'));
    check('providers.catalog: an OpenAI-compatible address where nothing listens is not reachable', !catl.listed && catl.unreachable === true && /^Could not reach /.test(catl.error), catl);
    // Anthropic's own API lists its models only with the anthropic-version header (HTTP 400 without it): the list
    // goes through its SDK, as the native path calls it, page by page. Every other type's request is as it was.
    {
      const listReqs = (mock) => mock.state.requests.filter((q) => q.url.split('?')[0] === '/v1/models');
      const plainList = listReqs(m2);
      check('an OpenAI-compatible provider’s list request is unchanged: its bearer, no anthropic-version, no x-api-key', plainList.length > 0 && plainList.every((q) => !('anthropic-version' in q.headers) && !('x-api-key' in q.headers) && /^Bearer /.test(q.headers.authorization || '')), plainList.map((q) => q.headers));
      const ma = await startMock();
      const ANT_KEY = 'mock-ant-key-0123456789';
      Object.assign(ma.state, { anthropicModels: true, apiKey: ANT_KEY, modelsPageSize: 10, models: Array.from({ length: 25 }, (_, i) => `claude-mock-${String(i).padStart(2, '0')}`) });
      try {
        const bare = await fetch(`http://127.0.0.1:${ma.port}/v1/models`, { headers: { authorization: `Bearer ${ANT_KEY}` } });
        check('(the mock answers as Anthropic does: a list request without anthropic-version is HTTP 400)', bare.status === 400 && /anthropic-version: header is required/.test(await bare.text()));
        const ant = P.resolveProvider(cfgWith({ provider: 'a', providers: { a: { type: 'anthropic', baseURL: `http://127.0.0.1:${ma.port}/v1/`, model: 'claude-own' } } }), undefined, { ANTHROPIC_API_KEY: ANT_KEY });
        const n0 = listReqs(ma).length;
        const c = await P.providerCatalog(ant);
        const asked = listReqs(ma).slice(n0);
        check('providers.catalog on the anthropic type: listed, every page followed (25 models in pages of 10, 3 requests)', c.listed && c.models.length === 26 && c.models[0] === 'claude-own' && c.models.includes('claude-mock-24') && asked.length === 3, { listed: c.listed, error: c.error, n: c.models.length, asked: asked.map((q) => q.url) });
        // The header's value is the SDK's own (it sends it on every request of the native path), so it is not pinned here
        const sdkVersion = asked[0]?.headers['anthropic-version'];
        check('… each request with the anthropic-version header and the key, as the native path sends them', asked.length === 3 && /^\d{4}-\d{2}-\d{2}$/.test(sdkVersion || '') && asked.every((q) => q.headers['anthropic-version'] === sdkVersion && /^Anthropic\/JS /.test(q.headers['user-agent'] || '') && (q.headers.authorization === `Bearer ${ANT_KEY}` || q.headers['x-api-key'] === ANT_KEY)), asked.map((q) => ({ v: q.headers['anthropic-version'], ua: q.headers['user-agent'], auth: Boolean(q.headers.authorization || q.headers['x-api-key']) })));
        check('… each next page asked after the last id of the one before', /after_id=claude-mock-09/.test(asked[1]?.url || '') && /after_id=claude-mock-19/.test(asked[2]?.url || ''), asked.map((q) => q.url));
        const n1 = listReqs(ma).length;
        const viaList = await P.listModels(ant);
        check('listModels (the model menu) asks the anthropic type the same way', viaList.length === 25 && listReqs(ma).slice(n1).every((q) => q.headers['anthropic-version'] === sdkVersion), viaList.length);
        Object.assign(ma.state, { modelsPageSize: 1, models: Array.from({ length: 12 }, (_, i) => `claude-one-${String(i).padStart(2, '0')}`) });
        const n2 = listReqs(ma).length;
        const capped = await P.providerCatalog(ant);
        check('… at most 10 pages are followed: a longer list stops there and keeps what came', capped.listed && capped.models.length === 11 && listReqs(ma).length - n2 === 10, { n: capped.models.length, asked: listReqs(ma).length - n2 });
        ma.state.apiKey = 'another-key-0123456789';
        const refused = await P.providerCatalog(ant);
        check('… a refused key comes back in plain words, without the key', !refused.listed && /401/.test(refused.error || '') && !refused.error.includes(ANT_KEY), refused);
      } finally {
        ma.close();
      }
    }
    {
      const app2 = createApp({ userData: tmp(), appRoot: projectDir, loadConfig: () => cfgWith({ provider: 'g', providers: { g: { type: 'groq', model: 'llama-x' } } }), saveConfig: () => {} });
      app2.push = () => {};
      setupProviders(app2, { linkDir, command, pathOf: async () => '' });
      const saved = process.env.GROQ_API_KEY;
      delete process.env.GROQ_API_KEY;
      const nk = await app2.invokeRpc('providers.catalog', ['g']);
      if (saved !== undefined) process.env.GROQ_API_KEY = saved;
      check('providers.catalog: no key, nothing asked, the variable named', nk.noKey && !nk.listed && /GROQ_API_KEY/.test(nk.error) && JSON.stringify(nk.models) === '["llama-x"]', nk);
    }
    let st = await call('cli.status');
    check('cli.status: available, not installed, the link folder on the PATH', st.available && !st.installed && st.onPath && st.link === path.join(linkDir, 'silo'));
    // The link the app made under the command's old name goes when the new one is installed; a stranger's stays
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync('/Applications/Open Harness.app/Contents/Resources/bin/open-harness', path.join(linkDir, 'open-harness'));
    st = await call('cli.install');
    check('cli.install links the command', st.installed && fs.readlinkSync(st.link) === command);
    check('… and takes away the old open-harness link the app made', !fs.existsSync(path.join(linkDir, 'open-harness')) && !(() => { try { return fs.lstatSync(path.join(linkDir, 'open-harness')); } catch { return null; } })());
    await call('cli.uninstall');
    fs.writeFileSync(path.join(linkDir, 'open-harness'), 'a script of someone else’s');
    st = await call('cli.install');
    check('… but leaves an open-harness that is not the app’s link', st.installed && fs.readFileSync(path.join(linkDir, 'open-harness'), 'utf8') === 'a script of someone else’s');
    fs.rmSync(path.join(linkDir, 'open-harness'));
    st = await call('cli.uninstall');
    check('cli.uninstall removes only that link', !st.installed && !fs.existsSync(st.link));
    fs.mkdirSync(linkDir, { recursive: true });
    fs.writeFileSync(path.join(linkDir, 'silo'), 'someone else’s');
    st = await call('cli.status');
    let err = '';
    try {
      await call('cli.install');
    } catch (e) {
      err = e.message;
    }
    check('something else at the link’s place is reported and never replaced', st.conflict && /Remove it first/.test(err) && fs.readFileSync(path.join(linkDir, 'silo'), 'utf8') === 'someone else’s');
    await call('cli.uninstall');
    check('…nor removed', fs.existsSync(path.join(linkDir, 'silo')));
    m2.close();
  }

  fs.rmSync(root, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.log('CRASH', err && err.stack);
  process.exit(1);
});
