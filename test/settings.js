// settings.json layering: user vs project precedence, project trust, validation, the env block and its restore,
// ${VAR} expansion, recomputing on folder / file / trust changes, and that saving never bakes an override back into
// config.json. Run: node test/settings.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { SettingsLayer, contentHash, trustKey } = require(path.join(projectDir, 'dist/main/settings.js'));
const { setupSettings } = require(path.join(projectDir, 'dist/main/settings-service.js'));
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { check, done } = require('./support/check.js');

// The service logs each problem once; keep it out of the suite's output and check it instead.
const warnings = [];
console.warn = (...args) => warnings.push(args.join(' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) return v;
    await sleep(20);
  }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-settings-'));
process.env.SILO_HARNESS_CONFIG_DIR = path.join(root, 'home-config');
let n = 0;
const tmp = () => {
  const d = path.join(root, `d${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return fs.realpathSync(d);
};
const write = (dir, name, obj) => {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
};
const PROJECT = path.join('.silo-harness', 'settings.json');
const writeProject = (cwd, obj) => write(cwd, PROJECT, obj);
const trustedFor = (cwd) => ({ [trustKey(cwd)]: contentHash(fs.readFileSync(path.join(cwd, PROJECT), 'utf8')) });

// A config.json-shaped baseline.
const base = (cwd) => ({
  provider: 'ollama',
  ollama: { baseURL: 'http://localhost:11434/v1', model: 'qwen3:8b', numCtx: 16384, think: 'auto' },
  portkey: { baseURL: 'https://api.portkey.ai/v1', apiKey: '', model: '@openai/gpt-4o-mini', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
  workingDirectory: cwd || os.homedir(),
  permissionMode: 'ask',
  autoApprove: false,
  maxTurns: 40,
  sendScreenshotsToModel: false,
  systemPromptExtra: '',
  theme: 'system',
  autoTitles: true,
  mcpServers: {},
  mcpTrusted: {},
  autoCompact: true,
  notifications: true,
  allowRules: {},
  recentDirs: [],
  keepAwake: 'running',
  toolActivity: 'summary',
  compactThreshold: 0.8,
  pruneToolResults: true,
  historyTrashDays: 30,
  settingsTrusted: {},
});
const absent = () => path.join(tmp(), 'absent.json');
const fileOf = (layer, scope) => layer.info().files.find((f) => f.scope === scope);

(async () => {
  // --- no settings files: identity (unchanged) ---------------------------------
  {
    const cwd = tmp();
    const layer = new SettingsLayer({ userFile: absent() });
    const cfg = base(cwd);
    const out = layer.load(cfg);
    check('no settings files leaves the config alone', JSON.stringify(out) === JSON.stringify(cfg));
    check('nothing is owned', layer.owned().length === 0);
    check('withoutSettings is identity', JSON.stringify(layer.withoutSettings(out)) === JSON.stringify(cfg));
    const info = layer.info();
    check('info lists both files as absent', info.files.length === 2 && info.files.every((f) => !f.exists && !f.applied && f.keys.length === 0), info);
    check('info: project file path under the folder', fileOf(layer, 'project').path === path.join(cwd, PROJECT));
  }

  // --- a user settings.json that is a link: info says so (Full reset's confirmation names it) --------------------
  {
    const target = write(tmp(), 'settings.json', { theme: 'dark' });
    const userFile = path.join(tmp(), 'settings.json');
    fs.symlinkSync(target, userFile);
    const layer = new SettingsLayer({ userFile });
    layer.load(base(tmp()));
    check('info marks a linked user settings.json as a link', fileOf(layer, 'user').link === true && fileOf(layer, 'user').exists, fileOf(layer, 'user'));
  }

  // --- user scope overrides config.json (unchanged) ----------------------------
  {
    const cwd = tmp();
    const userFile = write(tmp(), 'settings.json', {
      provider: 'portkey',
      portkey: { baseURL: 'https://gateway.example.com/v1', model: '@vertex/anthropic.claude-opus-5', contextWindow: 200000 },
    });
    const layer = new SettingsLayer({ userFile });
    const out = layer.load(base(cwd));
    check('provider overridden', out.provider === 'portkey', out.provider);
    check('portkey.model overridden', out.portkey.model === '@vertex/anthropic.claude-opus-5', out.portkey.model);
    check('portkey.baseURL overridden', out.portkey.baseURL === 'https://gateway.example.com/v1');
    check('untouched portkey fields keep config.json values', out.portkey.apiKey === '' && out.portkey.virtualKey === '');
    check('unrelated sections untouched', out.ollama.model === 'qwen3:8b' && out.maxTurns === 40);
    check('owned paths reported', layer.owned().sort().join(',') === 'portkey.baseURL,portkey.contextWindow,portkey.model,provider', layer.owned());
    check('owned map names the user file', Object.values(layer.info().owned).every((s) => s === 'user'));
    const edited = { ...out, maxTurns: 99 };
    const stored = layer.withoutSettings(edited);
    check('save restores provider to config.json value', stored.provider === 'ollama', stored.provider);
    check('save restores portkey.model', stored.portkey.model === '@openai/gpt-4o-mini', stored.portkey.model);
    check('save keeps genuinely edited fields', stored.maxTurns === 99);
    const u = fileOf(layer, 'user');
    check('the user file never needs trust', u.trusted && u.applied && !u.changed);
  }

  // --- project scope beats user scope, once trusted (changed: needs trust now) --
  {
    const cwd = tmp();
    writeProject(cwd, { portkey: { model: '@vertex/project-model' }, maxTurns: 7 });
    const userFile = write(tmp(), 'settings.json', { provider: 'portkey', portkey: { model: '@vertex/user-model', contextWindow: 200000 } });
    const layer = new SettingsLayer({ userFile });
    const out = layer.load({ ...base(cwd), settingsTrusted: trustedFor(cwd) });
    check('project model wins', out.portkey.model === '@vertex/project-model', out.portkey.model);
    check('user-only field survives', out.portkey.contextWindow === 200000);
    check('user provider still applies', out.provider === 'portkey');
    check('project-only field applies', out.maxTurns === 7);
    check('owned map: project wins where both set', layer.info().owned['portkey.model'] === 'project' && layer.info().owned['portkey.contextWindow'] === 'user' && layer.info().owned.maxTurns === 'project');
  }

  // --- trust ----------------------------------------------------------------------
  {
    const cwd = tmp();
    const proj = writeProject(cwd, { permissionMode: 'bypass', systemPromptExtra: 'PROJECT-EXTRA', portkey: { baseURL: 'https://evil.example/v1', model: 'proj-model', virtualKey: 'proj-vk' }, env: { OA_T_PROJ: 'x' } });
    delete process.env.OA_T_PROJ;
    const layer = new SettingsLayer({ userFile: absent() });
    let cfg = layer.load(base(cwd));
    let p = fileOf(layer, 'project');
    check('untrusted project file: nothing applied', cfg.permissionMode === 'ask' && cfg.systemPromptExtra === '' && cfg.portkey.baseURL === 'https://api.portkey.ai/v1');
    check('untrusted project file: env not applied', process.env.OA_T_PROJ === undefined);
    check('untrusted project file: nothing owned', layer.owned().length === 0);
    check('untrusted project file: described', p.exists && !p.trusted && !p.applied && !p.changed && p.keys.sort().join(',') === 'env.OA_T_PROJ,permissionMode,portkey.model,portkey.virtualKey,systemPromptExtra', p);
    cfg = layer.recompute(layer.withTrust(cfg, true));
    p = fileOf(layer, 'project');
    check('trusted: applied', cfg.permissionMode === 'bypass' && cfg.systemPromptExtra === 'PROJECT-EXTRA' && cfg.portkey.model === 'proj-model' && cfg.portkey.virtualKey === 'proj-vk' && process.env.OA_T_PROJ === 'x');
    check("trusted: a project's portkey.baseURL is ignored with a problem line (the gateway key stays where you sent it)", cfg.portkey.baseURL === 'https://api.portkey.ai/v1' && p.invalid.some((i) => i.key === 'portkey.baseURL' && /may not change where the gateway key is sent; set the gateway's address in your own settings\.json/.test(i.message)), p.invalid);
    check('trusted: info says so', p.trusted && p.applied && !p.changed);
    check('trust stores the hash of the content by folder', cfg.settingsTrusted[trustKey(cwd)] === contentHash(fs.readFileSync(proj, 'utf8')));
    writeProject(cwd, { permissionMode: 'bypass', systemPromptExtra: 'EDITED' });
    cfg = layer.recompute(cfg);
    p = fileOf(layer, 'project');
    check('edited after trust: not applied', cfg.permissionMode === 'ask' && cfg.systemPromptExtra === '' && cfg.portkey.baseURL === 'https://api.portkey.ai/v1', cfg.permissionMode);
    check('edited after trust: changed, not trusted', p.changed === true && !p.trusted && !p.applied);
    check('edited after trust: env restored', process.env.OA_T_PROJ === undefined);
    cfg = layer.recompute(layer.withTrust(cfg, true));
    check('re-trusted: applied', cfg.permissionMode === 'bypass' && cfg.systemPromptExtra === 'EDITED' && !fileOf(layer, 'project').changed);
    cfg = layer.recompute(layer.withTrust(cfg, false));
    check('untrusted again: not applied, no approval left', cfg.permissionMode === 'ask' && !(trustKey(cwd) in cfg.settingsTrusted) && !fileOf(layer, 'project').changed);
    let threw = '';
    try {
      layer.withTrust(base(tmp()), true);
    } catch (e) {
      threw = e.message;
    }
    check('trusting a folder without a project file is refused', /no settings file/.test(threw), threw);
  }

  // --- validation matrix: one bad value per key, the rest still applies ------------
  {
    const good = {
      provider: 'portkey', permissionMode: 'plan', maxTurns: 12, sendScreenshotsToModel: true, systemPromptExtra: 'hi', theme: 'dark', autoTitles: false, autoCompact: false,
      compactThreshold: 0.6, pruneToolResults: false, notifications: false, keepAwake: 'always', historyTrashDays: 0, toolActivity: 'all',
      ollama: { baseURL: 'http://o/v1', model: 'm', numCtx: 8192, think: 'on' },
      portkey: { baseURL: 'http://p/v1', apiKey: 'k', model: 'pm', virtualKey: 'v', provider: 'pp', providerApiKey: 'ppk', configId: 'c', contextWindow: 1000 },
    };
    const bad = {
      provider: 42, permissionMode: 'yolo', maxTurns: 'many', sendScreenshotsToModel: 'yes', systemPromptExtra: 5, theme: 'blue', autoTitles: 1, autoCompact: null,
      compactThreshold: 0.99, pruneToolResults: 'no', notifications: [], keepAwake: 'sometimes', historyTrashDays: -1, toolActivity: 'verbose',
      'ollama.baseURL': 3, 'ollama.model': false, 'ollama.numCtx': 0, 'ollama.think': 'maybe',
      'portkey.baseURL': {}, 'portkey.apiKey': 1, 'portkey.model': null, 'portkey.virtualKey': 2, 'portkey.provider': true, 'portkey.providerApiKey': [], 'portkey.configId': 9, 'portkey.contextWindow': 1.5,
    };
    const extra = { maxTurns: [0, -3, 2.5], compactThreshold: [0.4, '0.6'] };
    const cases = Object.entries(bad).map(([k, v]) => [k, v]);
    for (const [k, vs] of Object.entries(extra)) for (const v of vs) cases.push([k, v]);
    let allOk = true;
    const failures = [];
    for (const [key, value] of cases) {
      const file = structuredClone(good);
      const [a, b] = key.split('.');
      if (b) file[a][b] = value;
      else file[a] = value;
      const layer = new SettingsLayer({ userFile: write(tmp(), 'settings.json', file) });
      const out = layer.load(base(tmp()));
      const u = fileOf(layer, 'user');
      const reported = u.invalid.length === 1 && u.invalid[0].key === key && u.invalid[0].message.length > 5;
      const skipped = b ? out[a][b] === base()[a][b] : out[a] === base()[a];
      const restApplied = Object.entries(good).every(([gk, gv]) =>
        typeof gv === 'object' ? Object.entries(gv).every(([f, fv]) => `${gk}.${f}` === key || out[gk][f] === fv) : gk === key || out[gk] === gv,
      );
      const notOwned = !layer.owned().includes(key) && !u.keys.includes(key);
      if (!(reported && skipped && restApplied && notOwned)) {
        allOk = false;
        failures.push({ key, value, reported, skipped, restApplied, notOwned, invalid: u.invalid });
      }
    }
    check(`validation matrix: ${cases.length} bad values each reported and skipped, the rest applied`, allOk, failures);
    const layer = new SettingsLayer({ userFile: write(tmp(), 'settings.json', { maxTurns: 'many' }) });
    layer.load(base(tmp()));
    check('message a person can act on', fileOf(layer, 'user').invalid[0].message === 'expected a whole number above 0, got a string', fileOf(layer, 'user').invalid);
    const all = new SettingsLayer({ userFile: write(tmp(), 'settings.json', good) });
    const out = all.load(base(tmp()));
    check('every settable key applies when valid', out.provider === 'portkey' && out.keepAwake === 'always' && out.toolActivity === 'all' && out.historyTrashDays === 0 && out.compactThreshold === 0.6 && out.ollama.think === 'on' && out.portkey.configId === 'c' && fileOf(all, 'user').invalid.length === 0);
    check('every settable key is owned', all.owned().length === 14 + 4 + 8, all.owned().length);
  }

  // --- unknown keys, sections, env entries --------------------------------------
  {
    delete process.env.OA_T_OK;
    const layer = new SettingsLayer({
      userFile: write(tmp(), 'settings.json', {
        $schema: 'https://example.com/schema.json',
        mcpServers: { x: { command: 'evil' } },
        mods: {},
        settingsTrusted: { '/': 'x' },
        allowRules: {},
        recentDirs: ['/'],
        remote: { enabled: true },
        frobnicate: 1,
        ollama: { model: 'ok', color: 'red' },
        portkey: 'not an object',
        env: { OA_T_OK: 'fine', '1BAD': 'x', 'A-B': 'x', OA_T_NUM: 5 },
        maxTurns: 9,
      }),
    });
    const out = layer.load(base(tmp()));
    const u = fileOf(layer, 'user');
    const inv = u.invalid.map((i) => i.key).sort().join(',');
    check('unknown keys reported, not applied', inv === 'allowRules,env.1BAD,env.A-B,env.OA_T_NUM,frobnicate,mcpServers,mods,ollama.color,portkey,recentDirs,remote,settingsTrusted', inv);
    check('$schema ignored quietly', !u.invalid.some((i) => i.key === '$schema') && !u.keys.includes('$schema'));
    check('nothing outside the settable keys changed', JSON.stringify(out.mcpServers) === '{}' && out.remote === undefined && JSON.stringify(out.settingsTrusted) === '{}' && out.recentDirs.length === 0);
    check('valid entries next to them still apply', out.maxTurns === 9 && out.ollama.model === 'ok' && process.env.OA_T_OK === 'fine');
    check('valid env entries listed as env.NAME', u.keys.includes('env.OA_T_OK') && !u.keys.includes('env.OA_T_NUM'));
    layer.restoreEnv();
    check('restoreEnv removes a variable that did not exist', process.env.OA_T_OK === undefined);
  }

  // --- workingDirectory -----------------------------------------------------------
  {
    const start = tmp();
    const other = tmp();
    const userFile = write(tmp(), 'settings.json', { workingDirectory: start, maxTurns: 3 });
    const layer = new SettingsLayer({ userFile });
    let cfg = layer.load(base(os.homedir()));
    check('workingDirectory: the folder the app opens in at launch', cfg.workingDirectory === start, cfg.workingDirectory);
    check('workingDirectory is not owned', !layer.owned().includes('workingDirectory') && fileOf(layer, 'user').keys.includes('workingDirectory'));
    cfg = layer.recompute({ ...cfg, workingDirectory: other });
    check('after launch the folder follows the user', cfg.workingDirectory === other && cfg.maxTurns === 3);
    check('a saved config keeps the folder the user chose', layer.withoutSettings(cfg).workingDirectory === other);
    const missing = new SettingsLayer({ userFile: write(tmp(), 'settings.json', { workingDirectory: path.join(root, 'nope') }) });
    const c2 = missing.load(base(other));
    check('workingDirectory that does not exist is invalid', c2.workingDirectory === other && fileOf(missing, 'user').invalid[0]?.key === 'workingDirectory');
    const cwd = tmp();
    writeProject(cwd, { workingDirectory: start, maxTurns: 4 });
    const pl = new SettingsLayer({ userFile: absent() });
    const c3 = pl.load({ ...base(cwd), settingsTrusted: trustedFor(cwd) });
    check('workingDirectory in a project file is invalid', c3.workingDirectory === cwd && c3.maxTurns === 4 && fileOf(pl, 'project').invalid.map((i) => i.key).join() === 'workingDirectory');
  }

  // --- env block + ${VAR} expansion (unchanged) ----------------------------------
  {
    delete process.env.OA_TEST_KEY;
    const userFile = write(tmp(), 'settings.json', {
      env: { OA_TEST_KEY: 'secret-from-settings' },
      portkey: { apiKey: '${OA_TEST_KEY}', model: '${OA_MISSING:-fallback-model}' },
    });
    const layer = new SettingsLayer({ userFile });
    const out = layer.load(base(tmp()));
    check('env block reaches process.env', process.env.OA_TEST_KEY === 'secret-from-settings');
    check('${VAR} expands from the env block', out.portkey.apiKey === 'secret-from-settings', out.portkey.apiKey);
    check('${VAR:-default} falls back', out.portkey.model === 'fallback-model', out.portkey.model);
    check('expanded secret is not written back to config.json', layer.withoutSettings(out).portkey.apiKey === '');
    const info = JSON.stringify(layer.info());
    check('SettingsInfo carries keys, never values', !info.includes('secret-from-settings') && !info.includes('fallback-model') && info.includes('env.OA_TEST_KEY') && info.includes('portkey.apiKey'));
    layer.restoreEnv();
    check('env restored', process.env.OA_TEST_KEY === undefined);
  }

  // --- malformed files: error on the info, nothing applied (changed: reported in info) --
  {
    const cwd = tmp();
    for (const [label, content, re] of [
      ['malformed JSON', '{ this is not json ', /not valid JSON/],
      ['a JSON array', '[1,2,3]', /JSON object/],
      ['a JSON string', '"x"', /JSON object/],
    ]) {
      const userFile = write(tmp(), 'settings.json', content);
      const layer = new SettingsLayer({ userFile });
      let out;
      let threw = false;
      try {
        out = layer.load(base(cwd));
      } catch {
        threw = true;
      }
      const u = fileOf(layer, 'user');
      check(`${label}: no throw, config falls back to config.json`, !threw && out.provider === 'ollama' && layer.owned().length === 0);
      check(`${label}: error on its info`, u.exists && !u.applied && re.test(u.error || ''), u);
    }
    writeProject(cwd, '{ nope');
    const pl = new SettingsLayer({ userFile: absent() });
    pl.load(base(cwd));
    check('malformed project file: error, not applied', /not valid JSON/.test(fileOf(pl, 'project').error) && !fileOf(pl, 'project').applied);
    let threw = '';
    try {
      pl.withTrust(base(cwd), true);
    } catch (e) {
      threw = e.message;
    }
    check('a malformed project file cannot be trusted', /not a JSON object/.test(threw), threw);
  }

  // --- env: set, overridden by the project, restored on folder change and on untrust --
  {
    process.env.OA_E_PRE = 'original';
    delete process.env.OA_E_NEW;
    delete process.env.OA_E_PROJ;
    const a = tmp();
    const b = tmp();
    writeProject(a, { env: { OA_E_PRE: 'from-project', OA_E_PROJ: 'p' }, systemPromptExtra: '${OA_E_PRE}/${OA_E_NEW}' });
    const userFile = write(tmp(), 'settings.json', { env: { OA_E_PRE: 'from-user', OA_E_NEW: 'new' } });
    const layer = new SettingsLayer({ userFile });
    let cfg = layer.load({ ...base(a), settingsTrusted: trustedFor(a) });
    check('env: the project file overrides the user file', process.env.OA_E_PRE === 'from-project' && process.env.OA_E_NEW === 'new' && process.env.OA_E_PROJ === 'p');
    check('expansion sees env after both blocks applied', cfg.systemPromptExtra === 'from-project/new', cfg.systemPromptExtra);
    cfg = layer.recompute({ ...cfg, workingDirectory: b });
    check('env: restored on folder change (user value back, project variable gone)', process.env.OA_E_PRE === 'from-user' && process.env.OA_E_NEW === 'new' && process.env.OA_E_PROJ === undefined);
    check('folder change drops the project override', cfg.systemPromptExtra === '');
    cfg = layer.recompute({ ...cfg, workingDirectory: a });
    check('env: back in project A', process.env.OA_E_PRE === 'from-project' && process.env.OA_E_PROJ === 'p');
    cfg = layer.recompute(layer.withTrust(cfg, false));
    check('env: restored on untrust', process.env.OA_E_PRE === 'from-user' && process.env.OA_E_PROJ === undefined);
    layer.restoreEnv();
    check('env: original values back, new ones gone', process.env.OA_E_PRE === 'original' && process.env.OA_E_NEW === undefined);
    delete process.env.OA_E_PRE;
  }

  // --- the service: a headless App, recompute triggers, saves, pushes, RPC ----------
  {
    const a = tmp();
    const b = tmp();
    const userFile = write(tmp(), 'settings.json', { maxTurns: 21, theme: 'dark', env: { OA_S_USER: 'u' } });
    writeProject(a, { systemPromptExtra: 'FROM-A', permissionMode: 'bypass', env: { OA_S_PROJ: 'a' } });
    writeProject(b, { systemPromptExtra: 'FROM-B', portkey: { model: 'model-from-b' } });
    delete process.env.OA_S_USER;
    delete process.env.OA_S_PROJ;
    const layer = new SettingsLayer({ userFile });
    const stored = { ...base(a), settingsTrusted: { ...trustedFor(a), ...trustedFor(b) } };
    const saved = [];
    const app = createApp({ userData: tmp(), appRoot: projectDir, loadConfig: () => layer.load(stored), saveConfig: (c) => saved.push(structuredClone(layer.withoutSettings(c))) });
    const pushes = [];
    app.push = (channel, payload) => pushes.push({ channel, payload });
    const opened = [];
    const svc = setupSettings(app, { layer, pollMs: 40, debounceMs: 30, openPath: async (p) => (opened.push(p), '') });
    const OWNED_VALUES = ['FROM-A', 'FROM-B', 'model-from-b'];
    const leaks = () => saved.filter((c) => OWNED_VALUES.includes(c.systemPromptExtra) || c.portkey.model === 'model-from-b' || c.maxTurns === 21 || c.theme === 'dark' || c.permissionMode === 'bypass');

    let cfg = app.config();
    check('service: launch applies user and trusted project', cfg.maxTurns === 21 && cfg.theme === 'dark' && cfg.systemPromptExtra === 'FROM-A' && cfg.permissionMode === 'bypass' && cfg.autoApprove === true);
    check('service: setup does not save when nothing changed', saved.length === 0, saved.length);

    // A save of a non-owned field: owned values stay out.
    app.updateConfig({ autoCompact: false });
    check('save: owned fields restored, the edit kept', saved.length === 1 && saved[0].autoCompact === false && leaks().length === 0, saved[0]);
    // The mode chip on an owned field: in memory only.
    app.updateConfig({ permissionMode: 'plan' });
    check('an owned field changed in the app applies in memory', app.config().permissionMode === 'plan');
    check('… and is not persisted', saved.at(-1).permissionMode === 'ask' && leaks().length === 0);

    // Folder change: A's overrides dropped, B's applied, a non-owned change made just before survives.
    pushes.length = 0;
    app.updateConfig({ notifications: false });
    app.updateConfig({ workingDirectory: b });
    await sleep(0);
    cfg = app.config();
    check('folder change: project A dropped, project B applied', cfg.systemPromptExtra === 'FROM-B' && cfg.portkey.model === 'model-from-b' && cfg.permissionMode === 'ask', { e: cfg.systemPromptExtra, m: cfg.permissionMode });
    check('folder change: user file still applies', cfg.maxTurns === 21 && cfg.theme === 'dark');
    check('folder change: non-owned changes survive', cfg.notifications === false && cfg.autoCompact === false && cfg.workingDirectory === b);
    check('folder change: env of A restored', process.env.OA_S_PROJ === undefined && process.env.OA_S_USER === 'u');
    check('folder change: settings:changed pushed with B as the project file', pushes.some((p) => p.channel === 'settings:changed' && p.payload.files[1].path === path.join(b, PROJECT) && p.payload.owned['portkey.model'] === 'project'));
    check('folder change: owned values never saved', leaks().length === 0, leaks());

    // Trust change through RPC.
    let info = await app.invokeRpc('settings.trustProject', [false]);
    cfg = app.config();
    check('untrust via RPC: B no longer applied', cfg.systemPromptExtra === '' && cfg.portkey.model === '@openai/gpt-4o-mini' && !info.files[1].trusted && !info.files[1].applied && !info.owned['portkey.model']);
    check('untrust saved, without owned values', !(trustKey(b) in saved.at(-1).settingsTrusted) && leaks().length === 0);
    info = await app.invokeRpc('settings.trustProject', [true]);
    check('trust via RPC: B applied again', app.config().systemPromptExtra === 'FROM-B' && info.files[1].applied && saved.at(-1).settingsTrusted[trustKey(b)] && leaks().length === 0);

    // The watcher: an edit to the user file, then an edit to the project file.
    pushes.length = 0;
    app.updateConfig({ sendScreenshotsToModel: true });
    write(path.dirname(userFile), 'settings.json', { maxTurns: 22, theme: 'dark', env: { OA_S_USER: 'u2' } });
    await waitFor(() => app.config().maxTurns === 22);
    check('watcher: an edit to the user file is picked up', app.config().maxTurns === 22 && process.env.OA_S_USER === 'u2');
    check('watcher: a non-owned change made a moment before survives', app.config().sendScreenshotsToModel === true);
    check('watcher: settings:changed pushed, nothing owned saved', pushes.some((p) => p.channel === 'settings:changed') && leaks().length === 0);
    writeProject(b, { systemPromptExtra: 'FROM-B-EDITED' });
    await waitFor(() => app.config().systemPromptExtra === '');
    info = await app.invokeRpc('settings.info', []);
    check('watcher: an edited project file stops applying', app.config().systemPromptExtra === '' && info.files[1].changed === true && pushes.some((p) => p.channel === 'settings:changed' && p.payload.files[1].changed));

    // A project file that does not exist yet, created while the app runs.
    const c = tmp();
    app.updateConfig({ workingDirectory: c });
    await sleep(0);
    check('folder without a project file: nothing from B', app.config().systemPromptExtra === '' && !layer.info().files[1].exists && layer.info().files[1].path === path.join(c, PROJECT));
    writeProject(c, { maxTurns: 5 });
    await waitFor(() => (layer.info().files[1].exists ? true : false));
    info = await app.invokeRpc('settings.info', []);
    check('watcher: a newly created project file is seen (and waits for approval)', info.files[1].exists && !info.files[1].applied && info.files[1].keys.join() === 'maxTurns' && app.config().maxTurns === 22);
    fs.rmSync(path.join(path.dirname(userFile), 'settings.json'));
    await waitFor(() => app.config().maxTurns === 40);
    check('watcher: removing the user file drops its fields back to stored values', app.config().maxTurns === 40 && app.config().theme === 'system' && process.env.OA_S_USER === undefined);
    write(path.dirname(userFile), 'settings.json', { theme: 'light' });
    await waitFor(() => app.config().theme === 'light');
    check('watcher: a newly created user file applies', app.config().theme === 'light');
    write(path.dirname(userFile), 'settings.json', '{ broken');
    await waitFor(() => layer.info().files[0].error);
    check('a problem is logged once', warnings.filter((w) => w.includes('is not valid JSON')).length === 1, warnings);
    check('watcher: a file broken while running reports an error, its fields go back', /not valid JSON/.test(layer.info().files[0].error || '') && app.config().theme === 'system');

    // settings.reload, settings.open, app.info, app.reveal.
    write(path.dirname(userFile), 'settings.json', { maxTurns: 33 });
    info = await app.invokeRpc('settings.reload', []);
    check('settings.reload reads the files again at once', app.config().maxTurns === 33 && info.owned.maxTurns === 'user');
    const d = tmp();
    app.updateConfig({ workingDirectory: d });
    await sleep(0);
    await app.invokeRpc('settings.open', ['project']);
    const created = path.join(d, PROJECT);
    check('settings.open creates the project file with {} and opens it', fs.readFileSync(created, 'utf8').trim() === '{}' && opened.at(-1) === created);
    fs.writeFileSync(path.dirname(userFile) + '/settings.json', '{"maxTurns": 34}');
    await app.invokeRpc('settings.open', ['user']);
    check('settings.open leaves an existing file alone', fs.readFileSync(userFile, 'utf8') === '{"maxTurns": 34}' && opened.at(-1) === userFile);
    const ai = await app.invokeRpc('app.info', []);
    check('app.info', ai.name && typeof ai.version === 'string' && ai.version.length > 0 && ai.node === process.versions.node && ai.platform === process.platform && ai.userData === app.userData && ai.configDir === path.resolve(process.env.SILO_HARNESS_CONFIG_DIR), ai);
    await app.invokeRpc('app.reveal', ['configDir']);
    check('app.reveal opens the folder', opened.at(-1) === path.resolve(process.env.SILO_HARNESS_CONFIG_DIR) && fs.existsSync(opened.at(-1)));
    check('owned values never saved, across every path', leaks().length === 0 && saved.length > 5, { leaks: leaks().length, saves: saved.length });

    svc.dispose();
    layer.restoreEnv();
    write(path.dirname(userFile), 'settings.json', { maxTurns: 35 });
    await sleep(200);
    check('dispose stops the watches', app.config().maxTurns !== 35);
  }

  // --- the service re-reads after a folder change made by bringing a session on screen --
  {
    const a = tmp();
    const b = tmp();
    writeProject(b, { maxTurns: 8 });
    const layer = new SettingsLayer({ userFile: absent() });
    const app = createApp({ userData: tmp(), appRoot: projectDir, loadConfig: () => layer.load({ ...base(a), settingsTrusted: trustedFor(b) }), saveConfig: () => {} });
    const svc = setupSettings(app, { layer, pollMs: 1000 });
    const sa = app.runtime.foregroundId();
    const sb = app.runtime.create({ cwd: b }).id;
    app.showSession(sb);
    await sleep(0);
    check('switching to a session in another folder applies that folder’s trusted file', app.config().workingDirectory === b && app.config().maxTurns === 8);
    app.showSession(sa);
    await sleep(0);
    check('… and switching back drops it', app.config().workingDirectory === a && app.config().maxTurns === 40);
    svc.dispose();
  }

  fs.rmSync(root, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.log('FAIL CRASH', err && err.stack);
  process.exit(1);
});
