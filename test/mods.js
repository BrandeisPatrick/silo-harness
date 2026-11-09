// Mods, main-process half: discovery, validation, state rules, serving, the bridge and its permissions, storage,
// the public config, model calls, skill usage, the agent's tools. Headless, with a fake App and temp folders.
// Run: npm run build && node test/mods.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');
const { startMock } = require('./support/mock-model.js');

const tmp = (p = 'oa-mods-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const HOME = tmp('oa-mods-home-');
process.env.SILO_HARNESS_CONFIG_DIR = HOME;

const dist = (f) => require(path.join(projectDir, 'dist', 'main', f));
const { createMods, checkLayout, serveModRequest } = dist('mods.js');
const { readManifest, validateManifest } = dist('mods/manifest.js');
const { resolveModUrl, modCsp, contentType } = dist('mods/serve.js');
const { MOD_METHOD_PERMISSIONS, isWindowMethod, MOD_PERMISSIONS } = dist('mods/permissions.js');
const { modRev, projectHash } = dist('mods/registry.js');
const { publicConfig } = dist('mods/public-config.js');
const { ModStorage } = dist('mods/storage.js');
const { SessionStore } = dist('sessions.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(40);
  }
  return !!fn();
}

/** Writes a mod folder: mod.json (object or raw text) plus files. */
function writeMod(root, id, manifest, files = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, 'mod.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}
const page = '<!doctype html><p>hi</p>';
const man = (id, extra = {}) => ({ protocol: 1, id, name: id.toUpperCase(), version: '0.1.0', contributes: { views: [{ id: 'main', title: 'Main', entry: 'panel.html', seat: 'rail' }] }, ...extra });

function baseConfig(project) {
  return {
    provider: 'ollama',
    ollama: { baseURL: 'http://localhost:11434/v1', model: 'qwen3:8b', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: 'https://api.portkey.ai/v1', apiKey: '', model: '@openai/gpt-4o-mini', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: project,
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
    compactThreshold: 0.8,
    pruneToolResults: true,
    historyTrashDays: 30,
    mods: { enabled: {}, disabledBundled: [], settings: {}, layout: { railOpen: true, railWidth: 300, collapsed: [], background: null, backgroundImage: null, backgroundDim: 0.82 }, safeMode: false },
    remote: { enabled: false, bind: 'lan', port: 0 },
    settingsTrusted: {},
  };
}

function fakeApp() {
  const userData = tmp('oa-mods-data-');
  const appRoot = tmp('oa-mods-app-');
  const project = tmp('oa-mods-project-');
  let config = baseConfig(project);
  const pushes = [];
  const handlers = {};
  const cfgSubs = [];
  const evSubs = [];
  const tools = [];
  const prompts = {};
  const commands = new Map();
  const services = new Map();
  const quits = [];
  const store = new SessionStore(path.join(userData, 'sessions'));
  const session = store.create();
  const sent = [];
  const stopped = [];
  const compacted = [];
  const agent = { contextInfo: () => ({ tokens: 4000, limit: 16384, threshold: 0.8, autoCompact: true }), compactNow: async (f) => (compacted.push(f), { ok: true }) };
  const runtime = {
    fg: session.id,
    foregroundId: () => runtime.fg,
    setForeground: (id) => ((runtime.fg = id), store.get(id)),
    agentFor: () => agent,
    create: () => store.create(),
    send: (id, text, att, opts) => (sent.push({ id, text, opts }), { ok: true }),
    stop: (id) => stopped.push(id),
    isRunning: () => false,
    running: () => [],
    status: () => ({ running: false }),
    live: () => ({ running: false, text: '', thinking: '', tools: [], approvals: [], queue: [] }),
    list: () => store.list().map((m) => ({ ...m, status: { running: false } })),
  };
  const app = {
    userData,
    appRoot,
    config: () => config,
    updateConfig(change) {
      const prev = config;
      config = typeof change === 'function' ? change(config) : { ...config, ...change };
      for (const cb of cfgSubs) cb(config, prev);
      return config;
    },
    onConfig: (cb) => (cfgSubs.push(cb), () => cfgSubs.splice(cfgSubs.indexOf(cb), 1)),
    window: () => null,
    push: (channel, payload) => pushes.push({ channel, payload }),
    rpc: { handle: (m, fn) => ((handlers[m] = fn), () => delete handlers[m]) },
    store,
    runtime,
    events: { on: (cb) => (evSubs.push(cb), () => evSubs.splice(evSubs.indexOf(cb), 1)) },
    tools: { register: (t) => (tools.push(t), () => tools.splice(tools.indexOf(t), 1)), list: () => tools },
    prompt: { add: (id, f) => ((prompts[id] = f), () => delete prompts[id]) },
    commands: { register: (c) => (commands.set(c.name, c), () => commands.delete(c.name)), list: () => [...commands.values()] },
    provide: (n, s) => (services.set(n, s), () => services.delete(n)),
    service: (n) => services.get(n),
    onQuit: (fn) => quits.push(fn),
  };
  const trashed = [];
  const host = { trash: async (d) => (trashed.push(d), fs.rmSync(d, { recursive: true, force: true })), reveal: () => {}, chooseImage: async () => host.picked ?? null };
  const roots = { bundled: path.join(appRoot, 'mods'), user: path.join(HOME, 'mods'), project: path.join(project, '.silo-harness', 'mods') };
  return { app, host, userData, appRoot, project, roots, pushes, handlers, evSubs, tools, prompts, commands, services, quits, store, session, sent, stopped, compacted, runtime, setConfig: (c) => (config = c) };
}

const rpc = (f, m, ...a) => f.handlers[m](...a);
const call = (f, mod, method, params) => f.handlers['mods.call']({ mod, view: 'main' }, method, params);
const resetHome = () => {
  fs.rmSync(path.join(HOME, 'mods'), { recursive: true, force: true });
};

(async () => {
  // ---------- Validation matrix ----------
  {
    const root = tmp();
    const full = {
      protocol: 1,
      id: 'full',
      name: 'Full',
      version: '1.2.3',
      description: 'd',
      author: 'a',
      homepage: 'https://x',
      license: 'MIT',
      icon: 'icon.svg',
      permissions: ['session:read', 'model', 'session:read'],
      futureField: { anything: true },
      contributes: {
        views: [
          { id: 'main', title: 'Main', entry: 'panel.html', seat: 'rail', order: 20, maxHeight: 400, icon: 'gauge' },
          { id: 'tab', title: 'Tab', entry: 'pages/tab.html', seat: 'tab' },
          { id: 'strip', title: 'Strip', entry: 'panel.html', seat: 'composer' },
          { id: 'bg', title: 'Bg', entry: 'panel.html', seat: 'background' },
        ],
        styles: ['theme.css'],
        commands: [{ name: 'words', description: 'Count', view: 'main' }],
        settings: [
          { key: 'live', type: 'boolean', title: 'Live', default: true },
          { key: 'label', type: 'string', title: 'Label', default: 'x', placeholder: 'p' },
          { key: 'n', type: 'number', title: 'N', default: 5, min: 1, max: 9, step: 1 },
          { key: 'unit', type: 'select', title: 'Unit', options: ['words', 'chars'], default: 'words' },
        ],
        later: [1],
      },
    };
    writeMod(root, 'full', full, { 'panel.html': page, 'pages/tab.html': page, 'theme.css': ':root{}', 'icon.svg': '<svg/>' });
    const r = readManifest(path.join(root, 'full'));
    check('a fully valid manifest has no problems', r.problems.length === 0 && !!r.manifest, r.problems);
    check('unknown fields are ignored (not copied)', r.manifest && !('futureField' in r.manifest) && !('later' in r.manifest.contributes));
    check('duplicate permissions are folded', r.manifest && r.manifest.permissions.join() === 'session:read,model', r.manifest && r.manifest.permissions);
    check('settings keep their fields', r.manifest && r.manifest.contributes.settings.length === 4 && r.manifest.contributes.settings[2].max === 9);

    const files = { 'panel.html': page, 'theme.css': 'a{}', '.secret.html': page, 'notes.txt': 'x' };
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'out.html'), page);
    const cases = [
      ['protocol missing', (m) => delete m.protocol, /^protocol: missing/],
      ['protocol 2', (m) => (m.protocol = 2), /^protocol: must be 1/],
      ['id pattern', (m) => (m.id = 'Bad_Id'), /^id: "Bad_Id" must be/],
      ['id one letter', (m) => (m.id = 'a'), /^id: "a" must be/],
      ['id not the folder', (m) => (m.id = 'other'), /must equal the folder name/],
      ['name missing', (m) => delete m.name, /^name: missing/],
      ['version form', (m) => (m.version = '1.0'), /^version: "1.0" must be major.minor.patch/],
      ['description type', (m) => (m.description = 3), /^description: must be a string/],
      ['unknown permission', (m) => (m.permissions = ['session:read', 'files:write']), /^permissions\[1\]: "files:write" is not a permission/],
      ['permissions not a list', (m) => (m.permissions = 'model'), /^permissions: must be a list/],
      ['contributes not an object', (m) => (m.contributes = []), /^contributes: must be an object/],
      ['views not a list', (m) => (m.contributes.views = {}), /^contributes.views: must be a list/],
      ['duplicate view ids', (m) => m.contributes.views.push({ ...m.contributes.views[0] }), /^views\[1\].id: "main" is used by another view/],
      ['bad view id', (m) => (m.contributes.views[0].id = 'Main View'), /^views\[0\].id:/],
      ['view title missing', (m) => delete m.contributes.views[0].title, /^views\[0\].title: missing/],
      ['unknown seat', (m) => (m.contributes.views[0].seat = 'sidebar-left'), /^views\[0\].seat: "sidebar-left" is not a seat/],
      ['reserved seat', (m) => (m.contributes.views[0].seat = 'transcript'), /^views\[0\].seat: "transcript" is reserved/],
      ['entry does not exist', (m) => (m.contributes.views[0].entry = 'missing.html'), /^views\[0\].entry: missing.html does not exist/],
      ['entry with ..', (m) => (m.contributes.views[0].entry = '../x/panel.html'), /^views\[0\].entry: .* leaves the mod's folder/],
      ['entry absolute', (m) => (m.contributes.views[0].entry = path.join(outside, 'out.html')), /^views\[0\].entry: .* is an absolute path/],
      ['entry dotfile', (m) => (m.contributes.views[0].entry = '.secret.html'), /^views\[0\].entry: .* hidden file/],
      ['entry backslash', (m) => (m.contributes.views[0].entry = 'a\\panel.html'), /^views\[0\].entry: .* uses "\\"/],
      ['entry not html', (m) => (m.contributes.views[0].entry = 'notes.txt'), /^views\[0\].entry: notes.txt must be a .html or .htm file/],
      ['entry symlink out', (m, dir) => (fs.symlinkSync(path.join(outside, 'out.html'), path.join(dir, 'link.html')), (m.contributes.views[0].entry = 'link.html')), /^views\[0\].entry: link.html points outside/],
      ['maxHeight', (m) => (m.contributes.views[0].maxHeight = -1), /^views\[0\].maxHeight:/],
      ['style missing', (m) => (m.contributes.styles = ['nope.css']), /^styles\[0\]: nope.css does not exist/],
      ['style escapes', (m) => (m.contributes.styles = ['../theme.css']), /^styles\[0\]: .* leaves/],
      ['style not css', (m) => (m.contributes.styles = ['panel.html']), /^styles\[0\]: panel.html must be a .css file/],
      ['command name', (m) => (m.contributes.commands = [{ name: 'Do It', description: 'x' }]), /^commands\[0\].name:/],
      ['command twice', (m) => (m.contributes.commands = [{ name: 'go', description: 'x' }, { name: 'go', description: 'y' }]), /^commands\[1\].name: "\/go" is defined twice/],
      ['command description', (m) => (m.contributes.commands = [{ name: 'go' }]), /^commands\[0\].description: missing/],
      ['command view', (m) => (m.contributes.commands = [{ name: 'go', description: 'x', view: 'nope' }]), /^commands\[0\].view: "nope" is not the id of a view/],
      ['setting type', (m) => (m.contributes.settings = [{ key: 'a', type: 'color', title: 'A' }]), /^settings\[0\].type: "color" is not a type/],
      ['boolean default', (m) => (m.contributes.settings = [{ key: 'a', type: 'boolean', title: 'A', default: 'yes' }]), /^settings\[0\].default: must be true or false/],
      ['string default', (m) => (m.contributes.settings = [{ key: 'a', type: 'string', title: 'A', default: 3 }]), /^settings\[0\].default: must be a string/],
      ['number default out of range', (m) => (m.contributes.settings = [{ key: 'a', type: 'number', title: 'A', default: 20, min: 0, max: 10 }]), /^settings\[0\].default: 20 is outside min\/max/],
      ['number min > max', (m) => (m.contributes.settings = [{ key: 'a', type: 'number', title: 'A', min: 5, max: 1 }]), /^settings\[0\]: min is greater than max/],
      ['select default', (m) => (m.contributes.settings = [{ key: 'a', type: 'select', title: 'A', options: ['x'], default: 'y' }]), /^settings\[0\].default: must be one of the options/],
      ['select options', (m) => (m.contributes.settings = [{ key: 'a', type: 'select', title: 'A', options: [] }]), /^settings\[0\].options: must be a non-empty list/],
      ['setting key twice', (m) => (m.contributes.settings = [{ key: 'a', type: 'boolean', title: 'A' }, { key: 'a', type: 'boolean', title: 'B' }]), /^settings\[1\].key: "a" is used by another setting/],
      ['setting title', (m) => (m.contributes.settings = [{ key: 'a', type: 'boolean' }]), /^settings\[0\].title: missing/],
      ['icon svg missing', (m) => (m.icon = 'nope.svg'), /^icon: nope.svg does not exist/],
    ];
    for (const [label, mutate, re] of cases) {
      const r2 = tmp();
      const m = man('case');
      const dir = writeMod(r2, 'case', undefined, files);
      mutate(m, dir);
      fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(m));
      const out = readManifest(dir);
      check(`invalid: ${label}`, !out.manifest && out.problems.some((p) => re.test(p.message)), out.problems.map((p) => p.message));
    }
    const noJson = writeMod(tmp(), 'nojson', '{ "protocol": 1, ');
    check('invalid: mod.json not JSON', /mod.json is not valid JSON/.test(readManifest(noJson).problems[0].message));
    const none = writeMod(tmp(), 'none', undefined, { 'panel.html': page });
    check('invalid: mod.json missing', /mod.json is missing/.test(readManifest(none).problems[0].message));
    check('invalid: not an object', /must be a JSON object/.test(validateManifest([1], none).problems[0].message));
    const fileKind = readManifest(writeMod(tmp(), 'fk', man('fk')));
    check('a missing entry is a "file" problem', fileKind.problems[0].kind === 'file', fileKind.problems);
  }

  // ---------- Discovery, state rules, overrides ----------
  resetHome();
  const f = fakeApp();
  writeMod(f.roots.bundled, 'alpha', man('alpha', { permissions: ['session:read'] }), { 'panel.html': page });
  writeMod(f.roots.user, 'beta', man('beta', { permissions: ['session:read'] }), { 'panel.html': page, 'img/a.png': 'PNG', '.env': 'SECRET=1', 'data.json': '{}' });
  writeMod(f.roots.project, 'gamma', man('gamma'), { 'panel.html': page });
  writeMod(f.roots.user, 'broken', '{ nope');
  const ctl = createMods(f.app, f.host);
  const byId = (id) => rpc(f, 'mods.list').find((m) => m.id === id);
  {
    const list = rpc(f, 'mods.list');
    check('discovers bundled, user and project mods', ['alpha', 'beta', 'gamma', 'broken'].every((id) => list.some((m) => m.id === id)), list.map((m) => m.key));
    check('bundled and user keys are the id', byId('alpha').key === 'alpha' && byId('beta').key === 'beta');
    check('project key is id@folder', byId('gamma').key === `gamma@${f.project}`, byId('gamma').key);
    check('origins by scope', byId('alpha').origin === 'mod://alpha.bundled' && byId('beta').origin === 'mod://beta.user' && byId('gamma').origin === `mod://gamma.p-${projectHash(f.project)}`, byId('gamma').origin);
    check('bundled is on with its manifest permissions', byId('alpha').state === 'on' && byId('alpha').granted.join() === 'session:read');
    check('user mod starts off and wants its permissions', byId('beta').state === 'off' && byId('beta').wants.join() === 'session:read' && byId('beta').granted.length === 0);
    check('project mod starts off', byId('gamma').state === 'off');
    check('never-valid manifest is invalid', byId('broken').state === 'invalid' && byId('broken').manifest === null && byId('broken').problems.length === 1);
    check('a user mod is listed with its folder', byId('beta').dir === path.join(f.roots.user, 'beta'));
  }
  {
    rpc(f, 'mods.setEnabled', 'beta', true);
    let b = byId('beta');
    check('turning on grants the manifest permissions', b.state === 'on' && b.granted.join() === 'session:read' && f.app.config().mods.enabled.beta.permissions.join() === 'session:read');
    const rev0 = b.rev;
    writeMod(f.roots.user, 'beta', man('beta', { permissions: ['session:read', 'model'] }));
    rpc(f, 'mods.reload');
    b = byId('beta');
    check('a grown permission pauses the mod', b.state === 'paused' && b.wants.join() === 'model' && b.granted.join() === 'session:read', b);
    rpc(f, 'mods.setEnabled', 'beta', true);
    b = byId('beta');
    check('turning it on again grants the new set', b.state === 'on' && b.granted.join() === 'session:read,model');
    writeMod(f.roots.user, 'beta', man('beta', { permissions: ['session:read', 'model'], contributes: { views: man('beta').contributes.views, styles: ['theme.css'] } }), { 'theme.css': ':root{--accent:red}' });
    rpc(f, 'mods.reload');
    b = byId('beta');
    check('newly contributed styles do not pause the switch: a look asks at its first Use', b.state === 'on' && b.wantsStyles === true && b.approved === false && b.inUse.length === 0, b);
    let useErr = '';
    try {
      rpc(f, 'mods.use', { theme: 'beta' });
    } catch (e) {
      useErr = e.message;
    }
    check('mods.use refuses a look of yours that was never approved', /not been approved/.test(useErr) && f.app.config().mods.layout.theme !== 'beta' && !rpc(f, 'mods.styles').length, useErr);
    rpc(f, 'mods.use', { theme: 'beta' }, { approve: true });
    b = byId('beta');
    check('with the approval it records it, puts the theme in use and serves its styles', b.approved === true && b.wantsStyles === false && f.app.config().mods.approved.beta.permissions.join() === 'session:read,model' && f.app.config().mods.layout.theme === 'beta' && b.inUse.join() === 'theme' && rpc(f, 'mods.styles').some((x) => x.key === 'beta' && /--accent:red/.test(x.css)), b);
    writeMod(f.roots.user, 'beta', man('beta', { permissions: ['session:read', 'model'], contributes: { views: [...man('beta').contributes.views, { id: 'bg', title: 'Bg', entry: 'panel.html', seat: 'background' }], styles: ['theme.css'] } }));
    rpc(f, 'mods.reload');
    check('a background added later needs no new approval', byId('beta').state === 'on' && byId('beta').approved === true);
    check('rev changed with the edit', byId('beta').rev !== rev0);

    rpc(f, 'mods.setSafeMode', true);
    check('safe mode turns user and project mods off, their looks too', byId('beta').state === 'off' && byId('beta').approved === false && !rpc(f, 'mods.styles').length && byId('alpha').state === 'on');
    check('safe mode keeps what is stored', !!f.app.config().mods.enabled.beta && !!f.app.config().mods.approved.beta && f.app.config().mods.layout.theme === 'beta');
    rpc(f, 'mods.setSafeMode', false);
    check('leaving safe mode restores them', byId('beta').state === 'on' && rpc(f, 'mods.styles').length === 1);

    rpc(f, 'mods.setEnabled', 'alpha', false);
    check('a bundled mod turned off is listed in disabledBundled', byId('alpha').state === 'off' && f.app.config().mods.disabledBundled.includes('alpha'));
    rpc(f, 'mods.setEnabled', 'alpha', true);
    check('and back on', byId('alpha').state === 'on' && !f.app.config().mods.disabledBundled.includes('alpha'));

    // A bundled theme has no switch: it is available, and in use only once chosen; one theme at a time
    writeMod(f.roots.bundled, 'tinted', man('tinted', { contributes: { styles: ['theme.css'] } }), { 'theme.css': ':root{--accent:blue}' });
    rpc(f, 'mods.reload');
    const tinted = byId('tinted');
    check('a bundled theme is available without approval and not in use (off), so its styles are not served', tinted.state === 'off' && tinted.approved === true && tinted.inUse.length === 0 && !rpc(f, 'mods.styles').some((x) => x.key === 'tinted'), tinted);
    rpc(f, 'mods.use', { theme: 'tinted' });
    let styles = rpc(f, 'mods.styles');
    check('used, it is on and it replaces the theme that was in use (one at a time)', byId('tinted').state === 'on' && byId('beta').inUse.length === 0 && styles.length === 1 && styles[0].key === 'tinted' && /--accent:blue/.test(styles[0].css), styles.map((x) => x.key));
    rpc(f, 'mods.use', { theme: null });
    check('Default (null) puts the app\'s own theme back', f.app.config().mods.layout.theme === null && !rpc(f, 'mods.styles').length && byId('tinted').state === 'off');
    rpc(f, 'mods.setEnabled', 'tinted', true);
    check('mods.setEnabled(true) on a look means using it', f.app.config().mods.layout.theme === 'tinted' && byId('tinted').state === 'on' && !f.app.config().mods.enabled.tinted);
    rpc(f, 'mods.setEnabled', 'tinted', false);
    check('… and false goes back to Default, with nothing left in enabled or disabledBundled', f.app.config().mods.layout.theme === null && byId('tinted').state === 'off' && !f.app.config().mods.enabled.tinted && !f.app.config().mods.disabledBundled.includes('tinted'));
    let kindErr = '';
    try {
      rpc(f, 'mods.use', { theme: 'alpha' });
    } catch (e) {
      kindErr = e.message;
    }
    check('mods.use refuses what is not a look of that kind', /is not a theme of an installed mod/.test(kindErr), kindErr);
    fs.rmSync(path.join(f.roots.bundled, 'tinted'), { recursive: true, force: true });
    rpc(f, 'mods.reload');
    rpc(f, 'mods.use', { theme: 'beta' });
  }
  {
    // Last good manifest
    const goodRev = byId('beta').rev;
    fs.writeFileSync(path.join(f.roots.user, 'beta', 'mod.json'), '{ "protocol": 1, "id": "beta", ');
    rpc(f, 'mods.reload');
    const b = byId('beta');
    check('a broken edit keeps the last good manifest', b.state === 'on' && b.manifest && b.manifest.id === 'beta', b.state);
    check('and lists the problem', b.problems.some((p) => p.kind === 'manifest' && /not valid JSON/.test(p.message)));
    check('rev follows the file even then', b.rev !== goodRev);
    writeMod(f.roots.user, 'beta', man('beta', { permissions: ['session:read', 'model'], contributes: { views: [...man('beta').contributes.views, { id: 'bg', title: 'Bg', entry: 'panel.html', seat: 'background' }], styles: ['theme.css'] } }));
    rpc(f, 'mods.reload');
    check('fixed again: no problems', byId('beta').problems.length === 0);
  }
  {
    // rev
    const dir = writeMod(tmp(), 'revm', man('revm'), { 'panel.html': page });
    const r1 = modRev(dir);
    fs.writeFileSync(path.join(dir, 'panel.html'), page + ' ');
    const r2 = modRev(dir);
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'panel.html'), t, t);
    const r3 = modRev(dir);
    fs.writeFileSync(path.join(dir, '.hidden'), 'x');
    check('rev changes on a content edit', r1 !== r2);
    check('rev changes on an mtime change', r2 !== r3);
    check('rev ignores dotfiles', modRev(dir) === r3);
  }
  {
    // Override
    writeMod(f.roots.user, 'alpha', man('alpha', { permissions: ['session:read'] }), { 'panel.html': page });
    rpc(f, 'mods.reload');
    const alphas = rpc(f, 'mods.list').filter((m) => m.id === 'alpha');
    check('a user mod with a bundled id replaces it', alphas.length === 1 && alphas[0].scope === 'user' && alphas[0].overrides === true, alphas.map((m) => m.scope));
    check('the override starts off like any user mod', alphas[0].state === 'off');
    fs.rmSync(path.join(f.roots.user, 'alpha'), { recursive: true });
    rpc(f, 'mods.reload');
    check('removing it brings the bundled one back', byId('alpha').scope === 'bundled' && byId('alpha').state === 'on');
  }

  // ---------- Watcher: mods:changed and mods:offer ----------
  {
    const before = f.pushes.length;
    writeMod(f.roots.user, 'delta', man('delta', { permissions: ['config:read'] }), { 'panel.html': page });
    const changed = await waitFor(() => f.pushes.slice(before).some((p) => p.channel === 'mods:changed' && p.payload.some((m) => m.id === 'delta')));
    check('the watcher pushes mods:changed for a new mod', changed);
    const offers = () => f.pushes.filter((p) => p.channel === 'mods:offer' && p.payload.id === 'delta');
    check('and offers it', await waitFor(() => offers().length === 1), offers().length);
    fs.writeFileSync(path.join(f.roots.user, 'delta', 'panel.html'), page + '<!-- edit -->');
    await waitFor(() => byId('delta') && byId('delta').rev !== '', 400);
    await sleep(500);
    check('an edit without new wants is not offered again', offers().length === 1, offers().length);
    writeMod(f.roots.user, 'delta', man('delta', { permissions: ['config:read', 'model'] }));
    check('a changed wanted set is offered again', await waitFor(() => offers().length === 2), offers().length);
    check('offers carry the ModInfo', offers()[1].payload.wants.join() === 'model,config:read' || offers()[1].payload.wants.includes('model'));
    const startup = f.pushes.filter((p) => p.channel === 'mods:offer' && p.payload.id === 'gamma');
    const paused = f.pushes.filter((p) => p.channel === 'mods:offer' && p.payload.id === 'beta');
    check('mods present at startup are not offered', startup.length === 0, startup.length);
    check('a paused mod was offered once, for its new permission (new styles ask at their first Use, not on the card)', paused.length === 1 && paused.every((p) => p.payload.state === 'paused'), paused.map((p) => p.payload.state));

    // A mod that was on at startup and is turned off: no card straight away.
    const h = fakeApp();
    writeMod(h.roots.project, 'early', man('early'), { 'panel.html': page });
    h.app.updateConfig((c) => ({ ...c, mods: { ...c.mods, enabled: { [`early@${h.project}`]: { permissions: [], styles: false, at: 1 } } } }));
    const hc = createMods(h.app, h.host);
    check('a mod enabled before startup is on', rpc(h, 'mods.list').find((m) => m.id === 'early').state === 'on');
    rpc(h, 'mods.setEnabled', `early@${h.project}`, false);
    check('turning it off does not offer it', !h.pushes.some((p) => p.channel === 'mods:offer'));
    hc.close();

    // The home folder as the working directory: its .silo-harness/mods is the user folder, listed once.
    const hm = fakeApp();
    const home = tmp('oa-mods-homeproj-');
    process.env.SILO_HARNESS_CONFIG_DIR = path.join(home, '.silo-harness');
    writeMod(path.join(home, '.silo-harness', 'mods'), 'solo', man('solo'), { 'panel.html': page });
    hm.app.updateConfig({ workingDirectory: home });
    const hmc = createMods(hm.app, hm.host);
    const solos = rpc(hm, 'mods.list').filter((m) => m.id === 'solo');
    check('the user folder is not also listed as a project folder', solos.length === 1 && solos[0].scope === 'user', solos.map((m) => m.key));
    hmc.close();
    process.env.SILO_HARNESS_CONFIG_DIR = HOME;

    // A root that does not exist yet (the project's) is picked up when it appears.
    const g = fakeApp();
    const gc = createMods(g.app, g.host);
    check('no project mods while the root is missing', !rpc(g, 'mods.list').some((m) => m.scope === 'project'));
    writeMod(g.roots.project, 'late', man('late'), { 'panel.html': page });
    check('a root that appears later is watched', await waitFor(() => rpc(g, 'mods.list').some((m) => m.id === 'late'), 5000));
    // The working directory changes: the project mods follow.
    const other = tmp('oa-mods-project2-');
    writeMod(path.join(other, '.silo-harness', 'mods'), 'elsewhere', man('elsewhere'), { 'panel.html': page });
    g.app.updateConfig({ workingDirectory: other });
    const l = rpc(g, 'mods.list');
    check('changing the working directory rescans project mods', l.some((m) => m.id === 'elsewhere') && !l.some((m) => m.id === 'late'), l.map((m) => m.key));
    gc.close();
  }

  // ---------- Serving ----------
  {
    fs.mkdirSync(path.join(f.appRoot, 'modkit'), { recursive: true });
    fs.writeFileSync(path.join(f.appRoot, 'modkit', 'harness.js'), '/* kit */');
    fs.writeFileSync(path.join(f.appRoot, 'modkit', 'harness.css'), '/* kit */');
    fs.writeFileSync(path.join(f.appRoot, 'modkit', 'other.js'), '/* not served */');
    const betaDir = path.join(f.roots.user, 'beta');
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(betaDir, 'escape.txt'));
    fs.symlinkSync(outside, path.join(betaDir, 'escdir'));
    fs.symlinkSync(path.join(betaDir, '.env'), path.join(betaDir, 'env.txt'));
    fs.mkdirSync(path.join(betaDir, 'sub'), { recursive: true });
    const r = (url) => resolveModUrl(url, ctl.serve);
    const ok = r('mod://beta.user/panel.html');
    check('an on mod serves its file', ok.status === 200 && ok.file === fs.realpathSync(path.join(betaDir, 'panel.html')));
    check('headers: type, CORS, no-store, nosniff, CSP', ok.headers['Content-Type'].startsWith('text/html') && ok.headers['Access-Control-Allow-Origin'] === '*' && ok.headers['Cache-Control'] === 'no-store' && ok.headers['X-Content-Type-Options'] === 'nosniff' && ok.headers['Content-Security-Policy'].includes('mod://beta.user'));
    check('nested files and types', r('mod://beta.user/img/a.png').headers['Content-Type'] === 'image/png' && r('mod://beta.user/data.json').headers['Content-Type'].startsWith('application/json'));
    check('kit files on every on mod origin', r('mod://beta.user/@harness/harness.js').status === 200 && r('mod://alpha.bundled/@harness/harness.css').status === 200);
    check('only the two kit files', r('mod://beta.user/@harness/other.js').status === 404);
    const refused = [
      ['..', 'mod://beta.user/../alpha/panel.html'],
      ['encoded ..', 'mod://beta.user/%2e%2e/%2e%2e/secret.txt'],
      ['encoded slash', 'mod://beta.user/..%2F..%2Fsecret.txt'],
      ['encoded backslash', 'mod://beta.user/..%5Csecret.txt'],
      ['absolute (double slash)', 'mod://beta.user//etc/passwd'],
      ['absolute encoded', 'mod://beta.user/%2Fetc%2Fpasswd'],
      ['NUL', 'mod://beta.user/panel.html%00.png'],
      ['dotfile', 'mod://beta.user/.env'],
      ['dotfile encoded', 'mod://beta.user/%2Eenv'],
      ['symlink out (file)', 'mod://beta.user/escape.txt'],
      ['symlink out (folder)', 'mod://beta.user/escdir/secret.txt'],
      ['symlink to a dotfile', 'mod://beta.user/env.txt'],
      ['directory', 'mod://beta.user/sub'],
      ['directory with slash', 'mod://beta.user/sub/'],
      ['root', 'mod://beta.user/'],
      ['another mod\'s file on this label', 'mod://alpha.bundled/data.json'],
      ['unknown label', 'mod://nobody.user/panel.html'],
      ['label of the wrong scope', 'mod://beta.bundled/panel.html'],
      ['off mod', `mod://gamma.p-${projectHash(f.project)}/panel.html`],
      ['userinfo', 'mod://x:y@beta.user/panel.html'],
      ['port', 'mod://beta.user:8080/panel.html'],
      ['other scheme', 'file:///etc/passwd'],
      ['drive letter', 'mod://beta.user/C:/x'],
    ];
    for (const [label, u] of refused) {
      const res = r(u);
      check(`refused: ${label}`, res.status === 404 && !res.file, res.status);
    }
    // paused
    writeMod(f.roots.user, 'beta', { ...JSON.parse(fs.readFileSync(path.join(betaDir, 'mod.json'), 'utf8')), permissions: ['session:read', 'model', 'remote'] });
    rpc(f, 'mods.reload');
    check('a paused mod is not served', byId('beta').state === 'paused' && r('mod://beta.user/panel.html').status === 404);
    rpc(f, 'mods.setEnabled', 'beta', true);
    check('served again once approved', r('mod://beta.user/panel.html').status === 200);
    // background picture
    const bg = path.join(f.userData, 'backgrounds');
    fs.mkdirSync(bg, { recursive: true });
    fs.writeFileSync(path.join(bg, 'pic.png'), 'PNG');
    fs.writeFileSync(path.join(bg, 'notes.txt'), 'x');
    check('the background picture is served', r('mod://app.background/pic.png').status === 200 && r('mod://app.background/pic.png').headers['Content-Type'] === 'image/png');
    check('only images from backgrounds/', r('mod://app.background/notes.txt').status === 404 && r('mod://app.background/../config.json').status === 404);
    check('content types', contentType('a.woff2') === 'font/woff2' && contentType('a.wasm') === 'application/wasm' && contentType('a.mjs').startsWith('text/javascript') && contentType('a.bin') === 'application/octet-stream');
    // the handler itself
    const resp = await serveModRequest(new Request('mod://beta.user/data.json'), ctl.serve);
    check('serveModRequest returns the file with headers', resp.status === 200 && (await resp.text()) === '{}' && resp.headers.get('content-security-policy').includes("default-src 'none'"));
    const nf = await serveModRequest(new Request('mod://beta.user/.env'), ctl.serve);
    check('serveModRequest 404 carries headers too', nf.status === 404 && nf.headers.get('x-content-type-options') === 'nosniff');
    const post = await serveModRequest(new Request('mod://beta.user/data.json', { method: 'POST', body: 'x' }), ctl.serve);
    check('only GET and HEAD', post.status === 405);
  }
  {
    const off = modCsp('mod://x.user', false);
    const on = modCsp('mod://x.user', true);
    const dir = (csp, name) => (csp.split('; ').find((d) => d.startsWith(name + ' ')) || '').split(' ').slice(1);
    check('CSP: default none, frame/form/base none', /default-src 'none'/.test(off) && /frame-src 'none'/.test(off) && /form-action 'none'/.test(off) && /base-uri 'none'/.test(off));
    check('CSP names the origin, not self', !/'self'/.test(off) && dir(off, 'script-src').includes('mod://x.user'));
    check('CSP: inline script and style', dir(off, 'script-src').includes("'unsafe-inline'") && dir(off, 'style-src').includes("'unsafe-inline'"));
    check('CSP without network: connect only the origin', dir(off, 'connect-src').join(' ') === 'mod://x.user');
    check('CSP without network: no https anywhere', !/https:|wss:/.test(off));
    check('CSP with network: https for img, media, font, connect; wss for connect', ['img-src', 'media-src', 'font-src', 'connect-src'].every((d) => dir(on, d).includes('https:')) && dir(on, 'connect-src').includes('wss:') && !dir(on, 'script-src').includes('https:'));
  }

  // ---------- The bridge: permissions across the whole table ----------
  {
    writeMod(f.roots.user, 'noperm', man('noperm'), { 'panel.html': page });
    writeMod(f.roots.user, 'allperm', man('allperm', { permissions: [...MOD_PERMISSIONS] }), { 'panel.html': page });
    rpc(f, 'mods.reload');
    const off = await call(f, 'noperm', 'settings.get', {});
    check('a mod that is off gets 4004', off.error && off.error.code === 4004, off);
    rpc(f, 'mods.setEnabled', 'noperm', true);
    rpc(f, 'mods.setEnabled', 'allperm', true);
    const unknown = await call(f, 'noperm', 'files.read', {});
    check('unknown method: -32601', unknown.error && unknown.error.code === -32601);
    let denied = 0;
    let window = 0;
    let wrong = [];
    const quick = { 'model.complete': true };
    for (const [method, need] of Object.entries(MOD_METHOD_PERMISSIONS)) {
      const res = await call(f, 'noperm', method, {});
      if (isWindowMethod(method)) {
        if (res.error && res.error.code === -32601 && /handled by the window/.test(res.error.message)) window++;
        else wrong.push(method);
      } else if (need) {
        if (res.error && res.error.code === 4003 && res.error.data.permission === need) denied++;
        else wrong.push(method);
      } else if (res.error && res.error.code === 4003) wrong.push(method);
    }
    check('without its permission every method is denied (4003, naming it)', wrong.length === 0, wrong);
    check('window methods are refused as "handled by the window"', window === Object.keys(MOD_METHOD_PERMISSIONS).filter(isWindowMethod).length, window);
    wrong = [];
    for (const [method] of Object.entries(MOD_METHOD_PERMISSIONS)) {
      if (isWindowMethod(method) || quick[method]) continue;
      const res = await call(f, 'allperm', method, {});
      if (res.error && res.error.code === 4003) wrong.push(method);
    }
    check('with every permission no method is denied', wrong.length === 0, wrong);

    // Params
    const bad = async (method, params, field) => {
      const res = await call(f, 'allperm', method, params);
      check(`bad params: ${method} ${JSON.stringify(params)}`, res.error && res.error.code === -32602 && res.error.message.includes(field), res.error);
    };
    await bad('storage.get', {}, 'key');
    await bad('storage.set', { key: 'a' }, 'value');
    await bad('storage.get', { key: 'a', scope: 'world' }, 'scope');
    await bad('session.send', {}, 'text');
    await bad('session.send', { text: 5 }, 'text');
    await bad('session.transcript', { limit: -1 }, 'limit');
    await bad('sessions.search', {}, 'query');
    await bad('skills.usage', { scope: 'year' }, 'scope');
    await bad('config.set', { patch: 'dark' }, 'patch');
    await bad('config.set', { patch: { permissionMode: 'bypass' } }, 'patch.permissionMode');
    await bad('model.complete', { messages: [] }, 'messages');
    await bad('model.complete', { messages: [{ role: 'system', content: 'x' }] }, 'messages[0].role');
    await bad('model.complete', { messages: [{ role: 'user', content: 'x' }], context: 'everything' }, 'context');
    await bad('schedules.create', {}, 'input');
    await bad('storage.keys', 'string params', 'params');
    const svcMissing = await call(f, 'allperm', 'schedules.list', {});
    check('a service that is absent: 4004', svcMissing.error && svcMissing.error.code === 4004, svcMissing);
    const spawn = await call(f, 'allperm', 'sessions.spawn', { title: 't', prompt: 'p' });
    check('sessions.spawn without the subagents service: 4004', spawn.error && spawn.error.code === 4004);
    for (const m of ['remote.status', 'sessions.merge']) {
      const res = await call(f, 'allperm', m, { id: 'x' });
      check(`${m} without its service: 4004`, res.error && res.error.code === 4004);
    }
    // services present
    const scheds = [];
    f.services.set('schedules', { list: () => scheds, create: (input, by) => (scheds.push({ ...input, by, id: 's1' }), scheds[0]), update: (id, p) => ({ id, ...p }), remove: () => {}, runNow: (id) => ({ id }) });
    f.services.set('remote', { status: () => ({ enabled: false, running: false }), start: async () => ({ enabled: true, running: true }), stop: async () => ({ enabled: false, running: false }) });
    const created = await call(f, 'allperm', 'schedules.create', { input: { name: 'n', prompt: 'p', when: { kind: 'every', minutes: 10 } } });
    check('schedules.create reaches the service', created.result && created.result.id === 's1' && scheds[0].by === 'user', created);
    check('schedules.list', (await call(f, 'allperm', 'schedules.list')).result.schedules.length === 1);
    check('remote.start', (await call(f, 'allperm', 'remote.start')).result.running === true);
    f.services.delete('schedules');
    f.services.delete('remote');
  }

  // ---------- Session methods ----------
  {
    const s = f.session;
    s.messages.push({ role: 'user', content: 'hello world, find the bug' });
    s.messages.push({ role: 'assistant', content: 'A'.repeat(25_000) });
    s.messages.push({ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] });
    s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] });
    s.messages.push({ role: 'tool', tool_call_id: 'c1', content: 'file text' });
    s.tasks = [{ id: '1', title: 'Fix', status: 'in_progress' }];
    s.plans = { p1: { id: 'p1', title: 'Plan', markdown: '# do', status: 'proposed', createdAt: 5 } };
    s.artifacts = { 'art-1': { id: 'art-1', sessionId: s.id, title: 'Report', kind: 'markdown', version: 2, createdAt: 1, updatedAt: 10, bytes: 10, url: '', path: '' } };
    f.store.save(s);
    const other = f.store.create();
    other.messages.push({ role: 'user', content: 'child' });
    other.parentId = s.id; // the core's sessions carry this through toMeta (fake list below)
    f.store.save(other);
    const fork = f.store.fork(s.id);
    f.runtime.list = () => f.store.list().map((m) => ({ ...m, parentId: m.id === other.id ? s.id : undefined, status: { running: false } }));

    const get = (await call(f, 'allperm', 'session.get')).result;
    check('session.get is the session on screen', get.id === s.id && get.messageCount === 5 && get.running === false && get.cwd === f.project && get.origin === 'user', get);
    const tr = (await call(f, 'allperm', 'session.transcript')).result.items;
    check('session.transcript maps items', tr[0].role === 'user' && tr[0].text.startsWith('hello') && tr.some((i) => i.role === 'tool' && i.name === 'read_file' && i.ok === true), tr.map((i) => i.role));
    check('long texts are cut at 20,000', tr[1].text.length < 20_100 && /more characters/.test(tr[1].text));
    check('images as counts only', tr[2].images === 1 && !JSON.stringify(tr[2]).includes('base64'));
    check('limit is the last N', (await call(f, 'allperm', 'session.transcript', { limit: 2 })).result.items.length === 2);
    check('session.tasks', (await call(f, 'allperm', 'session.tasks')).result.tasks[0].title === 'Fix');
    check('session.plan', (await call(f, 'allperm', 'session.plan')).result.plan.title === 'Plan');
    const outs = (await call(f, 'allperm', 'session.outputs')).result.outputs;
    check('session.outputs lists artifacts', outs.some((o) => o.kind === 'artifact' && o.detail === 'Markdown · v2'), outs);
    f.services.set('images', { list: () => [{ id: 'img-1', name: 'shot.png', mime: 'image/png', bytes: 100, width: 640, height: 480, createdAt: 20 }] });
    const outs2 = (await call(f, 'allperm', 'session.outputs')).result.outputs;
    check('session.outputs adds images from the service, newest first', outs2[0].kind === 'image' && outs2[0].detail === 'PNG · 640×480', outs2);
    f.services.delete('images');
    const ctx = (await call(f, 'allperm', 'session.context')).result;
    const sum = ctx.slices.reduce((n, x) => n + x.tokens, 0);
    check('session.context falls back to used/reserve/free', ctx.slices.map((x) => x.key).join() === 'messages,reserve,free' && sum === ctx.limit && ctx.tokens === 4000 && ctx.compactable === true, ctx);
    f.services.set('context', { breakdown: () => ({ tokens: 1, limit: 2, slices: [] }) });
    check('session.context uses the service when present', (await call(f, 'allperm', 'session.context')).result.limit === 2);
    f.services.delete('context');
    const rel = (await call(f, 'allperm', 'session.related')).result;
    check('session.related computed from the runtime', rel.parent === null && rel.children.length === 1 && rel.children[0].id === other.id && rel.forks.length === 1 && rel.forks[0].id === fork.id, rel);
    const sent = await call(f, 'allperm', 'session.send', { text: 'from a mod' });
    check('session.send goes through the runtime as a mod message', sent.result.ok && f.sent[0].id === s.id && f.sent[0].opts.origin === 'mod' && f.sent[0].opts.from === 'ALLPERM');
    await call(f, 'allperm', 'session.stop');
    check('session.stop', f.stopped[0] === s.id);
    const comp = await call(f, 'allperm', 'session.compact', { focus: 'the bug' });
    check('session.compact calls compactNow(focus)', comp.result.ok && f.compacted[f.compacted.length - 1] === 'the bug');
    const list = (await call(f, 'allperm', 'sessions.list')).result.sessions;
    check('sessions.list', list.length === 3 && list.every((x) => typeof x.running === 'boolean'));
    const hits = (await call(f, 'allperm', 'sessions.search', { query: 'HELLO' })).result.hits;
    check('sessions.search without history: title match, case-insensitive', hits.length >= 1 && hits[0].role === 'title' && hits[0].matchEnd - hits[0].matchStart === 5, hits);
    f.services.set('history', { search: (q, o) => [{ sessionId: 'x', title: q, limit: o.limit }] });
    check('sessions.search uses the history service', (await call(f, 'allperm', 'sessions.search', { query: 'q', limit: 3 })).result.hits[0].limit === 3);
    f.services.delete('history');
  }

  // ---------- Storage ----------
  {
    const set = (k, v, scope) => call(f, 'noperm', 'storage.set', { key: k, value: v, scope });
    const get = async (k, scope) => (await call(f, 'noperm', 'storage.get', { key: k, scope })).result.value;
    await set('count', 3);
    await set('note', { a: [1, 2] }, 'session');
    check('mod scope round trip', (await get('count')) === 3);
    check('session scope round trip', JSON.stringify(await get('note', 'session')) === '{"a":[1,2]}');
    check('scopes are separate', (await get('note')) === null && (await get('count', 'session')) === null);
    const fg = f.runtime.fg;
    f.runtime.fg = 'another-session';
    check('the session scope follows the session on screen', (await get('note', 'session')) === null);
    f.runtime.fg = fg;
    check('mods do not see each other', (await call(f, 'allperm', 'storage.get', { key: 'count' })).result.value === null);
    check('keys', (await call(f, 'noperm', 'storage.keys', {})).result.keys.join() === 'count');
    const big = await set('big', 'x'.repeat(256 * 1024 + 10));
    check('a value over 256 KB is refused', big.error && big.error.code === -32602 && /256 KB/.test(big.error.message));
    const longKey = await set('k'.repeat(201), 1);
    check('a key over 200 characters is refused', longKey.error && longKey.error.code === -32602);
    const fn = await set('f', undefined);
    check('a value that is not JSON is refused', fn.error && fn.error.code === -32602);
    let full = null;
    for (let i = 0; i < 25 && !full; i++) {
      const r = await set(`chunk${i}`, 'y'.repeat(250 * 1024));
      if (r.error) full = r.error;
    }
    check('5 MB per mod', full && full.code === 4000 && /5 MB/.test(full.message), full);
    for (let i = 0; i < 25; i++) await call(f, 'noperm', 'storage.remove', { key: `chunk${i}` });
    check('remove frees the space', !(await set('after', 'z'.repeat(1000))).error);
    ctl.storage.flush();
    const again = new ModStorage(path.join(f.userData, 'mods-data'));
    check('storage is written and read back', again.get('noperm', 'mod', fg, 'count') === 3 && JSON.stringify(again.get('noperm', 'session', fg, 'note')) === '{"a":[1,2]}');
  }

  // ---------- Settings ----------
  {
    writeMod(f.roots.user, 'opts', man('opts', { contributes: { views: man('x').contributes.views, settings: [{ key: 'unit', type: 'select', title: 'U', options: ['w', 'c'], default: 'w' }, { key: 'n', type: 'number', title: 'N', min: 1, max: 5 }] } }), { 'panel.html': page });
    f.app.updateConfig((c) => ({ ...c, mods: { ...c.mods, settings: { ...c.mods.settings, opts: { unit: 'zzz', n: 3 } } } }));
    rpc(f, 'mods.reload');
    check('settings: defaults, stored values that fit, misfits dropped', JSON.stringify(byId('opts').settings) === '{"unit":"w","n":3}', byId('opts').settings);
    rpc(f, 'mods.setSetting', 'opts', 'unit', 'c');
    check('setSetting stores a valid value', byId('opts').settings.unit === 'c');
    check('and tells the mod', f.pushes.some((p) => p.channel === 'mods:event' && p.payload.mod === 'opts' && p.payload.name === 'settings.changed' && p.payload.data.unit === 'c'));
    let threw = '';
    try {
      rpc(f, 'mods.setSetting', 'opts', 'n', 9);
    } catch (e) {
      threw = e.message;
    }
    check('setSetting validates against the field', /n: must be a number from 1 to 5/.test(threw), threw);
    rpc(f, 'mods.setEnabled', 'opts', true);
    check('settings.get', (await call(f, 'opts', 'settings.get')).result.unit === 'c');
  }

  // ---------- config.get / config.set ----------
  {
    const cfg = baseConfig(f.project);
    cfg.provider = 'portkey';
    cfg.portkey = { baseURL: 'https://user:SECRET-URLPASS@gw.example.com/v1?key=SECRET-Q', apiKey: 'SECRET-APIKEY', model: '@openai/gpt-4o', virtualKey: 'SECRET-VK', provider: 'openai', providerApiKey: 'SECRET-PROVKEY', configId: 'SECRET-CFG', contextWindow: 200000 };
    cfg.ollama.baseURL = 'http://u:SECRET-OLLAMA@localhost:11434/v1';
    cfg.mcpServers = { a: { command: 'x', env: { TOKEN: 'SECRET-ENV' } }, b: { type: 'http', url: 'https://SECRET-MCPURL', headers: { Authorization: 'Bearer SECRET-HDR' } } };
    cfg.systemPromptExtra = 'SECRET-PROMPT';
    cfg.allowRules = { x: { programs: ['SECRET-RULE'] } };
    cfg.settingsTrusted = { x: 'SECRET-HASH' };
    cfg.remote = { enabled: true, bind: 'lan', port: 1, token: 'SECRET-REMOTE' };
    const prev = f.app.config();
    f.setConfig({ ...cfg, mods: prev.mods });
    const pub = (await call(f, 'allperm', 'config.get')).result;
    const json = JSON.stringify(pub);
    check('config.get leaks no secret (portkey)', !/SECRET/.test(json), json);
    check('config.get has exactly the public fields', Object.keys(pub).sort().join() === 'autoCompact,background,compactThreshold,contextLimit,home,keepAwake,model,notifications,permissionMode,provider,theme,workingDirectory', Object.keys(pub));
    check('config.get values', pub.provider === 'portkey' && pub.model === '@openai/gpt-4o' && pub.contextLimit === 200000 && pub.home === os.homedir() && pub.workingDirectory === f.project);
    f.setConfig({ ...f.app.config(), provider: 'ollama', ollama: { ...cfg.ollama, model: 'qwen3:8b' } });
    check('config.get leaks no secret (ollama)', !/SECRET/.test(JSON.stringify(publicConfig(f.app.config()))));
    f.setConfig({ ...prev });
    const setRes = await call(f, 'allperm', 'config.set', { patch: { theme: 'dark', autoCompact: false, compactThreshold: 0.7, keepAwake: 'always', notifications: false } });
    check('config.set changes the allowed keys', setRes.result && setRes.result.theme === 'dark' && f.app.config().theme === 'dark' && f.app.config().compactThreshold === 0.7 && f.app.config().keepAwake === 'always');
    check('config.changed goes to mods with config:read', f.pushes.some((p) => p.channel === 'mods:event' && p.payload.name === 'config.changed' && p.payload.mod === 'allperm') && !f.pushes.some((p) => p.channel === 'mods:event' && p.payload.name === 'config.changed' && p.payload.mod === 'noperm'));
    for (const patch of [{ permissionMode: 'bypass' }, { provider: 'portkey' }, { mcpTrusted: {} }, { workingDirectory: '/' }, { theme: 'neon' }, { compactThreshold: 2 }, { background: 'image' }, { background: 'beta/nope' }]) {
      const r = await call(f, 'allperm', 'config.set', { patch });
      check(`config.set refuses ${JSON.stringify(patch)}`, r.error && r.error.code === -32602, r);
    }
    check('nothing else changed', f.app.config().permissionMode === 'ask' && f.app.config().provider === 'ollama');
    const bgSet = await call(f, 'allperm', 'config.set', { patch: { background: 'beta/bg' } });
    check('config.set background to an on mod\'s background view maps onto layout', bgSet.result && bgSet.result.background === 'beta/bg' && f.app.config().mods.layout.background === 'beta/bg', bgSet);
    await call(f, 'allperm', 'config.set', { patch: { background: null } });
    check('background null clears it', f.app.config().mods.layout.background === null);
  }

  // ---------- model.complete ----------
  {
    const mock = await startMock();
    const ollamaCfg = (c) => ({ ...c, provider: 'ollama', ollama: { ...c.ollama, baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock-ollama' } });
    f.app.updateConfig(ollamaCfg);
    mock.state.replies.push({ content: 'Hello from Ollama' });
    const deltasFor = (id) => f.pushes.filter((p) => p.channel === 'mods:event' && p.payload.name === 'model.delta' && p.payload.data.requestId === id);
    const r1 = await call(f, 'allperm', 'model.complete', { messages: [{ role: 'user', content: 'hi' }], requestId: 'r1' });
    check('model.complete (Ollama) returns the reply', r1.result && r1.result.text === 'Hello from Ollama' && !r1.result.stopped, r1);
    check('and streams it as model.delta to the mod', deltasFor('r1').length >= 1 && deltasFor('r1')[0].payload.mod === 'allperm' && deltasFor('r1').map((p) => p.payload.data.text).join('') === 'Hello from Ollama');
    const req1 = mock.state.requests.filter((r) => r.url === '/api/chat').pop();
    check('no tools, num_predict defaults to 1000', !req1.payload.tools && req1.payload.options.num_predict === 1000 && req1.payload.options.num_ctx === 16384, req1.payload.options);
    mock.state.replies.push({ content: 'ok' });
    await call(f, 'allperm', 'model.complete', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 99999, context: 'session' });
    const req2 = mock.state.requests.filter((r) => r.url === '/api/chat').pop();
    check('maxTokens is capped at 4000', req2.payload.options.num_predict === 4000);
    const sys = req2.payload.messages[0];
    check('context: session puts the conversation in front', sys.role === 'system' && /hello world, find the bug/.test(sys.content) && /<conversation>/.test(sys.content), sys.content.slice(0, 200));
    check('nothing is added to the session', f.session.messages.length === 5);

    f.app.updateConfig((c) => ({ ...c, provider: 'portkey', portkey: { ...c.portkey, baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'k', model: 'mock-portkey' } }));
    mock.state.replies.push({ content: 'Hello from Portkey' });
    const r3 = await call(f, 'allperm', 'model.complete', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, requestId: 'r3' });
    check('model.complete (Portkey) returns the reply and usage', r3.result && r3.result.text === 'Hello from Portkey' && r3.result.usage && r3.result.usage.completionTokens === 30, r3);
    const req3 = mock.state.requests.filter((r) => r.url === '/v1/chat/completions').pop();
    check('portkey request: max_tokens, stream, no tools', req3.payload.max_tokens === 50 && req3.payload.stream === true && !req3.payload.tools);
    check('portkey deltas', deltasFor('r3').map((p) => p.payload.data.text).join('') === 'Hello from Portkey');

    mock.state.delayMs = 1500;
    mock.state.replies.push({ content: 'late' }, { content: 'late' });
    const t0 = Date.now();
    const a = call(f, 'allperm', 'model.complete', { messages: [{ role: 'user', content: 'x' }], requestId: 'slow1' });
    const b = call(f, 'allperm', 'model.complete', { messages: [{ role: 'user', content: 'x' }], requestId: 'slow2' });
    await sleep(50);
    const third = await call(f, 'allperm', 'model.complete', { messages: [{ role: 'user', content: 'x' }], requestId: 'slow3' });
    check('at most two calls in flight per mod', third.error && third.error.code === 4004, third);
    await call(f, 'allperm', 'model.cancel', { requestId: 'slow1' });
    const ra = await a;
    check('model.cancel aborts one request; it resolves with stopped: true', ra.result && ra.result.text === '' && ra.result.stopped === true && Date.now() - t0 < 1200, { ra, ms: Date.now() - t0 });
    await call(f, 'allperm', 'model.cancel', {});
    const rb = await b;
    check('model.cancel without an id aborts all of the mod\'s', rb.result && Date.now() - t0 < 1400);
    mock.state.delayMs = 0;
    mock.close();
    f.app.updateConfig((c) => ({ ...c, provider: 'ollama' }));
  }

  // ---------- Skill usage ----------
  {
    fs.mkdirSync(path.join(f.appRoot, 'skills', 'review'), { recursive: true });
    fs.writeFileSync(path.join(f.appRoot, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: r\n---\nbody');
    const emit = (sid, ev) => f.evSubs.forEach((cb) => cb(sid, ev));
    emit('s-a', { type: 'tool_start', id: '1', name: 'skill', args: { name: 'review' } });
    emit('s-a', { type: 'user_message', text: '/review src', images: 0, origin: 'user' });
    emit('s-b', { type: 'user_message', text: '/nope', images: 0, origin: 'user' });
    emit('s-b', { type: 'tool_start', id: '2', name: 'read_file', args: { name: 'review' } });
    emit('s-b', { type: 'user_message', text: 'please /review', images: 0, origin: 'user' });
    emit('s-b', { type: 'tool_start', id: '3', name: 'skill', args: '{"name":"/Review"}' });
    const svc = f.services.get('skill-usage');
    check('skill-usage service is provided', !!svc);
    check('counts skill tool calls and /name messages', svc.usage('all')[0].name === 'review' && svc.usage('all')[0].count === 3, svc.usage('all'));
    check('per session', svc.usage('session', 's-a')[0].count === 2 && svc.usage('session', 's-b')[0].count === 1);
    check('unknown skills and other tools are not counted', svc.usage('all').length === 1);
    check('skills.used goes to mods with skills:read', f.pushes.some((p) => p.channel === 'mods:event' && p.payload.name === 'skills.used' && p.payload.mod === 'allperm' && p.payload.data.name === 'review') && !f.pushes.some((p) => p.payload && p.payload.name === 'skills.used' && p.payload.mod === 'noperm'));
    f.runtime.fg = 's-a';
    check('skills.usage over the bridge', (await call(f, 'allperm', 'skills.usage', { scope: 'session' })).result.items[0].count === 2);
    f.runtime.fg = f.session.id;
    check('skills.list', (await call(f, 'allperm', 'skills.list')).result.skills.some((s) => s.name === 'review'));
    ctl.usage.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(f.userData, 'skill-usage.json'), 'utf8'));
    check('persisted in skill-usage.json', saved.all.review.count === 3 && saved.sessions['s-a'].review.count === 2);
  }

  // ---------- create, install, customise, remove, report, styles ----------
  {
    for (const seat of ['rail', 'tab', 'composer', 'background']) {
      const info = rpc(f, 'mods.create', { id: `starter-${seat}`, name: `Starter ${seat}`, seat, scope: 'user' });
      check(`mods.create (${seat}) passes validation and starts off`, info.state === 'off' && info.problems.length === 0 && info.manifest.contributes.views[0].seat === seat, info.problems);
    }
    const p = rpc(f, 'mods.create', { id: 'starter-proj', name: 'Proj', seat: 'rail', scope: 'project' });
    check('mods.create in the project folder', p.scope === 'project' && p.dir === path.join(f.roots.project, 'starter-proj'));
    const html = fs.readFileSync(path.join(f.roots.user, 'starter-rail', 'index.html'), 'utf8');
    check('the starter uses the kit, the session title and storage', html.includes('/@harness/harness.js') && html.includes('harness.session.get') && html.includes('harness.storage.set'));
    let err = '';
    try {
      rpc(f, 'mods.create', { id: 'starter-rail', name: 'x', seat: 'rail', scope: 'user' });
    } catch (e) {
      err = e.message;
    }
    check('mods.create refuses a taken id', /already/.test(err), err);

    const src = writeMod(tmp(), 'shared-mod', man('shared-mod', { permissions: ['model'] }), { 'panel.html': page });
    const inst = await rpc(f, 'mods.install', src);
    check('mods.install from a folder copies it and leaves it off', inst.state === 'off' && inst.scope === 'user' && fs.existsSync(path.join(f.roots.user, 'shared-mod', 'panel.html')) && inst.wants.join() === 'model');
    const tryInstall = async (s) => {
      try {
        await rpc(f, 'mods.install', s);
        return '';
      } catch (e) {
        return e.message;
      }
    };
    check('install refuses an id that is taken', /already installed/.test(await tryInstall(src)));
    check('install refuses a bundled id', /already installed/.test(await tryInstall(writeMod(tmp(), 'alpha', man('alpha'), { 'panel.html': page }))));
    const badSrc = writeMod(tmp(), 'badmod', man('badmod'));
    check('install refuses an invalid mod with its problems', /panel.html does not exist/.test(await tryInstall(badSrc)));
    check('install refuses a folder without mod.json', /no mod.json/.test(await tryInstall(tmp())));
    check('install leaves no staging folder behind', fs.readdirSync(f.roots.user).every((n) => !n.startsWith('.install-')));

    const cust = rpc(f, 'mods.customise', 'alpha');
    const a = cust.find((m) => m.id === 'alpha');
    check('customise copies a bundled mod into the user folder, on', a.scope === 'user' && a.overrides === true && a.state === 'on' && fs.existsSync(path.join(f.roots.user, 'alpha', 'mod.json')));
    const removed = await rpc(f, 'mods.remove', 'alpha');
    check('remove sends a user mod to the Trash and forgets its grant', f.host && removed.find((m) => m.id === 'alpha').scope === 'bundled' && !f.app.config().mods.enabled.alpha);
    let rmErr = '';
    try {
      await rpc(f, 'mods.remove', 'alpha');
    } catch (e) {
      rmErr = e.message;
    }
    check('bundled mods cannot be removed', /cannot be removed/.test(rmErr));

    for (let i = 0; i < 25; i++) rpc(f, 'mods.report', { mod: 'beta', view: 'main' }, { message: `boom ${i}`, stack: `Error: boom ${i}\n    at panel.html:3` });
    const rt = byId('beta').problems.filter((x) => x.kind === 'runtime');
    check('mods.report keeps the last 20 runtime problems', rt.length === 20 && /boom 24/.test(rt[19].message) && rt[0].view === 'main');

    const styles = rpc(f, 'mods.styles');
    check('mods.styles returns the CSS of on mods', styles.length === 1 && styles[0].key === 'beta' && /--accent:red/.test(styles[0].css), styles);
    fs.writeFileSync(path.join(f.roots.user, 'beta', 'theme.css'), 'a{}' + ' '.repeat(600 * 1024));
    check('each stylesheet is capped at 500 KB', rpc(f, 'mods.styles')[0].css.length < 510 * 1024);

    const pic = path.join(tmp(), 'my photo.png');
    fs.writeFileSync(pic, 'PNG');
    f.host.picked = pic;
    const layout = await rpc(f, 'mods.chooseBackgroundImage');
    check('chooseBackgroundImage copies into backgrounds/ and sets the layout', layout.backgroundImage && path.dirname(layout.backgroundImage) === path.join(f.userData, 'backgrounds') && layout.background === null && fs.existsSync(layout.backgroundImage));
    f.host.picked = null;
    check('cancelled: layout unchanged', (await rpc(f, 'mods.chooseBackgroundImage')).backgroundImage === layout.backgroundImage);
    const lay = rpc(f, 'mods.setLayout', { railWidth: 5000, collapsed: ['beta/main', 'beta/main'], railOpen: false, junk: 1 });
    check('setLayout validates and clamps', lay.railWidth === 480 && lay.collapsed.length === 1 && lay.railOpen === false && !('junk' in lay));
    let layErr = '';
    try {
      checkLayout({ backgroundImage: '/etc/passwd' }, path.join(f.userData, 'backgrounds'));
    } catch (e) {
      layErr = e.message;
    }
    check('setLayout refuses an arbitrary picture path', /chooseBackgroundImage/.test(layErr));
  }

  // ---------- mod_check, prompt, commands ----------
  {
    const tool = f.tools.find((t) => t.name === 'mod_check');
    check('mod_check is registered read-only', tool && tool.readOnly === true);
    const healthy = (await tool.run({ id: 'noperm' })).content;
    check('mod_check: healthy mod', /State: on/.test(healthy) && /mod.json: valid/.test(healthy) && /on and healthy/.test(healthy) && healthy.includes(path.join(f.roots.user, 'noperm')), healthy);
    fs.writeFileSync(path.join(f.roots.user, 'starter-tab', 'mod.json'), JSON.stringify({ ...man('starter-tab'), contributes: { views: [{ id: 'main', title: 'T', entry: 'gone.html', seat: 'tab' }] } }));
    const broken = (await tool.run({ id: 'starter-tab' })).content;
    check('mod_check: broken mod lists the problem and what to do', /gone.html does not exist/.test(broken) && /Fix the problems above/.test(broken), broken);
    const offText = (await tool.run({ id: 'shared-mod' })).content;
    check('mod_check: off mod says the user turns it on', /written but off: the user turns it on from the card in the chat or in Settings → Mods/.test(offText) && /Permissions asked for and not granted: model/.test(offText), offText);
    const errs = (await tool.run({ id: 'beta' })).content;
    check('mod_check shows the errors the pages reported', /boom 24/.test(errs) && /Fix the errors above/.test(errs));
    const all = (await tool.run({})).content;
    check('mod_check without an id: every non-bundled mod', /## SHARED-MOD/.test(all) && /## NOPERM/.test(all) && !/## ALPHA/.test(all));
    check('mod_check for a missing id says where to write', /No mod with the id "zzz"/.test((await tool.run({ id: 'zzz' })).content));

    const prompt = f.prompts.mods({ cwd: f.project, mode: 'ask', sessionId: 'x' });
    check('prompt section: what mods are, the skill, the installed ones', /create-mod skill/.test(prompt) && /mod_check/.test(prompt) && /beta \(user, on\)/.test(prompt) && prompt.split('\n').length <= 3, prompt);

    writeMod(f.roots.user, 'cmds', man('cmds', { contributes: { views: man('x').contributes.views, commands: [{ name: 'words', description: 'Count words', view: 'main' }] } }), { 'panel.html': page });
    rpc(f, 'mods.reload');
    check('commands of an off mod are not registered', !f.commands.has('words'));
    rpc(f, 'mods.setEnabled', 'cmds', true);
    const cmd = f.commands.get('words');
    check('an on mod\'s commands are registered (source mod)', cmd && cmd.source === 'mod' && cmd.description === 'Count words');
    const result = await cmd.run('some text', { sessionId: 'x' });
    check('running one pushes a command event and returns an empty result', JSON.stringify(result) === '{}' && f.pushes.some((p) => p.channel === 'mods:event' && p.payload.mod === 'cmds' && p.payload.name === 'command' && p.payload.data.args === 'some text' && p.payload.data.view === 'main'));
    rpc(f, 'mods.setEnabled', 'cmds', false);
    check('turning the mod off disposes them', !f.commands.has('words'));
  }

  // ---------- Looks: the manifest, the grant, the layout, mods.looks, mod_check, the starter ----------
  {
    const css = { 'holo.css': ':scope { --glow: #4cf } .msg.user .bubble { border: 1px solid var(--glow) } @keyframes k { to { opacity: 1 } } @import url(x.css);', 'bar.css': '#composer { border-color: red }', 'panel.html': page };
    const lookMan = (id, looks, extra = {}) => ({ protocol: 1, id, name: id.toUpperCase(), version: '0.1.0', ...extra, contributes: { looks, ...(extra.contributes ?? {}) } });
    const holo = { id: 'holo', title: 'Holo', target: 'conversation', styles: ['holo.css'], description: 'd' };
    const bar = { id: 'bar', title: 'Bar', target: 'composer', styles: ['bar.css'] };

    // manifest
    let r = readManifest(writeMod(tmp(), 'lk', lookMan('lk', [holo, bar]), css));
    check('looks: a valid manifest keeps both looks', !!r.manifest && r.problems.length === 0 && r.manifest.contributes.looks.length === 2 && r.manifest.contributes.looks[0].description === 'd' && r.manifest.contributes.looks[1].styles.join() === 'bar.css', r.problems);
    r = readManifest(writeMod(tmp(), 'lk', lookMan('lk', [holo, { ...bar, id: 'side', target: 'sidebar' }]), css));
    check('looks: an unknown target is a warning and that look is left out', !!r.manifest && r.manifest.contributes.looks.length === 1 && r.problems.length === 1 && r.problems[0].warning === true && /looks\[1\]\.target: "sidebar" is not a region this version of the app knows/.test(r.problems[0].message), r.problems);
    r = readManifest(writeMod(tmp(), 'lk', lookMan('lk', [{ ...bar, target: 'sidebar' }]), css));
    check('looks: a mod with only an unknown-target look still loads', !!r.manifest && !r.manifest.contributes, r);
    const lookCases = [
      ['looks not a list', (m) => (m.contributes.looks = {}), /^contributes.looks: must be a list/],
      ['look not an object', (m) => (m.contributes.looks = ['holo.css']), /^looks\[0\]: must be an object/],
      ['look id', (m) => (m.contributes.looks[0].id = 'Holo Look'), /^looks\[0\]\.id:/],
      ['look id twice', (m) => m.contributes.looks.push({ ...holo }), /^looks\[1\]\.id: "holo" is used by another look/],
      ['look title', (m) => delete m.contributes.looks[0].title, /^looks\[0\]\.title: missing/],
      ['look target missing', (m) => delete m.contributes.looks[0].target, /^looks\[0\]\.target: missing; use one of conversation, composer/],
      ['look target not a string', (m) => (m.contributes.looks[0].target = 3), /^looks\[0\]\.target: missing/],
      ['look styles empty', (m) => (m.contributes.looks[0].styles = []), /^looks\[0\]\.styles: must be a non-empty list/],
      ['look style missing', (m) => (m.contributes.looks[0].styles = ['gone.css']), /^looks\[0\]\.styles\[0\]: gone.css does not exist/],
      ['look style not css', (m) => (m.contributes.looks[0].styles = ['panel.html']), /^looks\[0\]\.styles\[0\]: panel.html must be a .css file/],
      ['look style escapes', (m) => (m.contributes.looks[0].styles = ['../holo.css']), /leaves the mod's folder/],
      ['look description', (m) => (m.contributes.looks[0].description = 1), /^looks\[0\]\.description: must be a string/],
    ];
    for (const [label, mutate, re] of lookCases) {
      const m = lookMan('lk', [{ ...holo }]);
      mutate(m);
      const out = readManifest(writeMod(tmp(), 'lk', m, css));
      check(`looks invalid: ${label}`, !out.manifest && out.problems.some((p) => re.test(p.message) && !p.warning), out.problems.map((p) => p.message));
    }
    const fileProblem = readManifest(writeMod(tmp(), 'lk', lookMan('lk', [{ ...holo, styles: ['gone.css'] }]), css));
    check('looks: a missing stylesheet is a "file" problem', fileProblem.problems[0].kind === 'file');

    // a preview picture: an image in the mod
    const pic = { ...css, 'shot.png': 'PNG', 'notes.txt': 'x' };
    r = readManifest(writeMod(tmp(), 'lk', lookMan('lk', [{ ...holo, preview: 'shot.png' }], { contributes: { views: [{ id: 'bg', title: 'Bg', entry: 'panel.html', seat: 'background', preview: 'shot.png' }] } }), pic));
    check('looks: a look and a background may name a preview picture', !!r.manifest && r.manifest.contributes.looks[0].preview === 'shot.png' && r.manifest.contributes.views[0].preview === 'shot.png', r.problems);
    r = readManifest(writeMod(tmp(), 'lk', lookMan('lk', [{ ...holo, preview: 'notes.txt' }]), pic));
    check('looks: a preview that is not a picture is refused', !r.manifest && /looks\[0\]\.preview: notes.txt must be a/.test(r.problems[0]?.message ?? ''), r.problems);
    r = readManifest(writeMod(tmp(), 'lk', lookMan('lk', [{ ...holo, preview: 'gone.png' }]), pic));
    check('looks: a missing preview is a "file" problem', !r.manifest && r.problems[0]?.kind === 'file' && /gone.png does not exist/.test(r.problems[0].message), r.problems);

    // state: a mod of looks has no switch; it is on while one of its looks is in use
    const g = fakeApp();
    writeMod(g.roots.bundled, 'set', lookMan('set', [holo, bar], { contributes: { views: [{ id: 'bg', title: 'Bg', entry: 'panel.html', seat: 'background' }], settings: [{ key: 'glow', type: 'select', title: 'Glow', options: ['blue', 'green'], default: 'blue' }] } }), css);
    writeMod(g.roots.user, 'look-user', man('look-user'), css);
    const gctl = createMods(g.app, g.host);
    const st = (key) => rpc(g, 'mods.list').find((m) => m.key === key);
    check('looks: a bundled mod of looks is available without a switch, and off while none of it is in use', st('set').state === 'off' && st('set').approved === true && st('set').inUse.length === 0 && !g.app.config().mods.enabled.set);
    rpc(g, 'mods.setEnabled', 'look-user', true);
    check('looks: a user mod without looks is on and says nothing of looks', st('look-user').state === 'on' && st('look-user').approved === undefined);
    writeMod(g.roots.user, 'look-user', lookMan('look-user', [holo], { contributes: { views: man('x').contributes.views } }), css);
    rpc(g, 'mods.reload');
    check('looks: a look added to a mod with a switch does not pause it; the look asks at its first Use', st('look-user').state === 'on' && st('look-user').wantsStyles === true && st('look-user').approved === false, st('look-user'));

    // the layout
    check('looks: the layout starts with the app\'s own look everywhere (an older config has no looks)', JSON.stringify(rpc(g, 'mods.setLayout', {}).looks) === JSON.stringify({ conversation: null, composer: null }));
    let lay = rpc(g, 'mods.setLayout', { looks: { conversation: 'set/holo' } });
    lay = rpc(g, 'mods.setLayout', { looks: { composer: 'set/bar', sidebar: 'x/y' } });
    check('looks: a region is set on its own, the other kept, an unknown region ignored', lay.looks.conversation === 'set/holo' && lay.looks.composer === 'set/bar' && !('sidebar' in lay.looks), lay.looks);
    const layoutErr = (patch) => {
      try {
        rpc(g, 'mods.setLayout', patch);
        return '';
      } catch (e) {
        return e.message;
      }
    };
    check('looks: setLayout refuses a malformed choice', /looks must be an object/.test(layoutErr({ looks: 'set/holo' })) && /looks.conversation must be/.test(layoutErr({ looks: { conversation: 'noslash' } })) && /looks.composer must be/.test(layoutErr({ looks: { composer: 5 } })));
    check('looks: checkLayout passes a valid choice through', JSON.stringify(checkLayout({ looks: { conversation: null } }, '/x').looks) === '{"conversation":null}');
    check('checkLayout keeps the closed side-pane tabs once each', JSON.stringify(checkLayout({ closedTabs: ['side-chat/main', 'side-chat/main', 'scheduled/main'] }, '/x').closedTabs) === '["side-chat/main","scheduled/main"]' && /closedTabs must be a list/.test(layoutErr({ closedTabs: 'side-chat/main' })));
    check('checkLayout takes a theme (a mod key, or null) and refuses anything else', checkLayout({ theme: 'theme-paper' }, '/x').theme === 'theme-paper' && checkLayout({ theme: null }, '/x').theme === null && /theme must be/.test(layoutErr({ theme: 3 })));

    // mods.looks
    let looks = rpc(g, 'mods.looks');
    const conv = looks.find((l) => l.target === 'conversation');
    check('mods.looks: one per chosen region, with the ref and the mod', looks.length === 2 && conv.ref === 'set/holo' && conv.mod === 'set' && looks.find((l) => l.target === 'composer').ref === 'set/bar', looks.map((l) => l.ref));
    check('mods.looks: the conversation look is scoped to #messages, the chat bar to #chatbar', /@scope \(#messages\) \{/.test(conv.css) && /@scope \(#chatbar\) \{[\s\S]*#composer \{ border-color: red \}/.test(looks.find((l) => l.target === 'composer').css));
    check('mods.looks: @keyframes hoisted, @import dropped', conv.css.indexOf('@keyframes k') < conv.css.indexOf('@scope') && !/@import/.test(conv.css), conv.css);
    rpc(g, 'mods.setLayout', { looks: { composer: 'set/holo' } });
    check('mods.looks: a look chosen for the wrong region is not applied', rpc(g, 'mods.looks').length === 1);
    rpc(g, 'mods.setLayout', { looks: { composer: 'look-user/holo' } });
    check('mods.looks: …nor one that does not exist there', rpc(g, 'mods.looks').length === 1);
    rpc(g, 'mods.setLayout', { looks: { conversation: 'look-user/holo', composer: 'set/bar' } });
    check('mods.looks: a user mod\'s look named in the layout does not apply before its first Use is approved', !rpc(g, 'mods.looks').some((l) => l.ref === 'look-user/holo') && st('set').state === 'on' && st('set').inUse.join() === 'composer');
    rpc(g, 'mods.use', { conversation: 'look-user/holo' }, { approve: true });
    check('mods.looks: … and applies once it is', rpc(g, 'mods.looks').some((l) => l.ref === 'look-user/holo') && st('look-user').approved === true && st('look-user').inUse.join() === 'conversation');
    rpc(g, 'mods.setSafeMode', true);
    looks = rpc(g, 'mods.looks');
    check('mods.looks: safe mode leaves the user mod\'s look out, the bundled one stays', looks.length === 1 && looks[0].ref === 'set/bar', looks.map((l) => l.ref));
    rpc(g, 'mods.setSafeMode', false);
    rpc(g, 'mods.setEnabled', 'set', false);
    check('mods.setEnabled(false) on a mod of looks: what of it is in use goes back to Default, the rest stays', !rpc(g, 'mods.looks').some((l) => l.mod === 'set') && g.app.config().mods.layout.looks.composer === null && g.app.config().mods.layout.looks.conversation === 'look-user/holo' && st('set').state === 'off');
    rpc(g, 'mods.setEnabled', 'set', true);
    let L = g.app.config().mods.layout;
    check('mods.setEnabled(true): its whole set is used (its first look of each kind)', L.background === 'set/bg' && L.looks.composer === 'set/bar' && L.looks.conversation === 'set/holo' && st('set').inUse.join() === 'background,composer,conversation' && st('look-user').inUse.length === 0, L);
    rpc(g, 'mods.setEnabled', 'set', true);
    rpc(g, 'mods.use', { conversation: 'look-user/holo' });
    rpc(g, 'mods.setEnabled', 'set', true);
    check('… and again with one of its looks in use changes nothing', g.app.config().mods.layout.looks.conversation === 'look-user/holo');
    rpc(g, 'mods.use', { background: null });
    L = g.app.config().mods.layout;
    check('mods.use background null is Default: no background and no picture', L.background === null && L.backgroundImage === null && L.looks.composer === 'set/bar');
    let picErr = '';
    try {
      rpc(g, 'mods.use', { background: 'image' });
    } catch (e) {
      picErr = e.message;
    }
    check('mods.use refuses your picture when there is none', /no picture of yours/.test(picErr), picErr);
    const unknownKind = rpc(g, 'mods.use', { sidebar: 'x/y' });
    check('mods.use ignores a kind it does not know', Array.isArray(unknownKind));
    fs.writeFileSync(path.join(g.roots.bundled, 'set', 'bar.css'), '#send-btn { color: lime }');
    check('mods.looks: reads the file as it is now (an edit shows on the next call)', /#send-btn \{ color: lime \}/.test(rpc(g, 'mods.looks').find((l) => l.target === 'composer').css));

    // mod_check
    const tool = g.tools.find((t) => t.name === 'mod_check');
    writeMod(g.roots.user, 'look-user', lookMan('look-user', [holo, { ...bar, target: 'status' }], { contributes: { views: man('x').contributes.views } }), css);
    const text = (await tool.run({ id: 'look-user' })).content;
    check('mod_check lists the looks, the active one, and the warning', /Looks \(scoped/.test(text) && /- holo: "Holo" for the conversation \(@scope #messages\), holo\.css · active/.test(text) && /Warnings in mod.json \(1; the rest of the mod loads\)/.test(text) && /"status" is not a region/.test(text) && /mod.json: valid/.test(text) && /Looks in use: Conversation · approved for use: yes/.test(text), text);
    writeMod(g.roots.user, 'look-user', lookMan('look-user', [{ ...holo, styles: ['nope.css'] }]), css);
    const missingText = (await tool.run({ id: 'look-user' })).content;
    check('mod_check reports a look\'s missing stylesheet', /looks\[0\]\.styles\[0\]: nope.css does not exist/.test(missingText), missingText);

    // the starter
    const made = rpc(g, 'mods.create', { id: 'look-starter', name: 'Look starter', look: 'conversation', scope: 'user' });
    const lookCss = fs.readFileSync(path.join(g.roots.user, 'look-starter', 'look.css'), 'utf8');
    check('mods.create with a look: a valid mod with one look, off', made.state === 'off' && made.problems.length === 0 && made.manifest.contributes.looks[0].target === 'conversation' && made.wantsStyles === true, made.problems);
    check('… whose stylesheet shows the hooks', /data-running/.test(lookCss) && /data-set-tint/.test(lookCss) && /:scope/.test(lookCss));
    const bar2 = rpc(g, 'mods.create', { id: 'bar-starter', name: 'Bar starter', look: 'composer', scope: 'user' });
    check('mods.create with a chat bar look', bar2.manifest.contributes.looks[0].target === 'composer' && fs.existsSync(path.join(g.roots.user, 'bar-starter', 'look.css')));
    const theme2 = rpc(g, 'mods.create', { id: 'theme-starter', name: 'Theme starter', theme: true, scope: 'user' });
    const themeCss = fs.readFileSync(path.join(g.roots.user, 'theme-starter', 'theme.css'), 'utf8');
    check('mods.create with a theme: a valid mod with one stylesheet and no views, off', theme2.state === 'off' && theme2.problems.length === 0 && theme2.manifest.contributes.styles.join() === 'theme.css' && !theme2.manifest.contributes.views && theme2.wantsStyles === true, theme2.problems);
    check('… whose stylesheet overrides tokens for light and dark', /:root \{/.test(themeCss) && /data-theme="dark"/.test(themeCss) && /--accent/.test(themeCss));
    let createErr = '';
    try {
      rpc(g, 'mods.create', { id: 'bad-starter', name: 'x', look: 'sidebar', scope: 'user' });
    } catch (e) {
      createErr = e.message;
    }
    check('mods.create refuses an unknown region', /region must be one of conversation, composer/.test(createErr), createErr);
    const starterText = (await tool.run({ id: 'look-starter' })).content;
    check('mod_check of a new look: no switch, previewed and used from the card or its tab', /only looks, so no switch/.test(starterText) && /approved for use: not yet/.test(starterText) && /previews it and uses it from the card in the chat \(Preview, Use\) or in Settings → Mods → Conversation/.test(starterText), starterText);

    // Previews: a look not in use yet (even one never approved) is compiled for the preview's root and served
    const pv = rpc(g, 'mods.previewCss', { kind: 'conversation', ref: 'look-starter/main' }).css;
    check('mods.previewCss: a look is scoped to the preview\'s transcript, never #messages alone', /@scope \(\.lp-root #messages\) \{/.test(pv) && !/@scope \(#messages\)/.test(pv) && /@keyframes look-pulse/.test(pv), pv.slice(0, 300));
    const pt = rpc(g, 'mods.previewCss', { kind: 'theme', ref: 'theme-starter' }).css;
    check('mods.previewCss: a theme is scoped to the preview\'s root, with :root read as it', /^@scope \(\.lp-root\) \{/m.test(pt) && /:scope \{/.test(pt) && /:scope\[data-theme="dark"\]/.test(pt) && !/:root/.test(pt), pt);
    let pvErr = '';
    try {
      rpc(g, 'mods.previewCss', { kind: 'composer', ref: 'look-starter/main' });
    } catch (e) {
      pvErr = e.message;
    }
    check('mods.previewCss refuses a look of the wrong kind', /not a chat bar look/.test(pvErr), pvErr);
    const served = resolveModUrl('mod://look-starter.user/look.css', gctl.serve);
    check('a look never approved is served for its preview (its files only)', served.status === 200, served.status);
    const pcall = await g.handlers['mods.call']({ mod: 'look-starter', view: 'main', preview: true }, 'settings.get', {});
    const wcall = await g.handlers['mods.call']({ mod: 'look-starter', view: 'main' }, 'settings.get', {});
    check('its preview frames are answered; the same call from the window is not', !pcall.error && pcall.result && pcall.result.tint === 'accent' && wcall.error && wcall.error.code === 4004, { pcall, wcall });
    const ppcall = await g.handlers['mods.call']({ mod: 'look-starter', view: 'main', preview: true }, 'session.get', {});
    check('… with nothing granted before its first Use', ppcall.error && ppcall.error.code === 4003, ppcall);
    rpc(g, 'mods.setSafeMode', true);
    check('safe mode: a user look is not served even for a preview', resolveModUrl('mod://look-starter.user/look.css', gctl.serve).status === 404);
    rpc(g, 'mods.setSafeMode', false);

    // Removing a user look in use takes it back to Default and forgets its approval
    rpc(g, 'mods.use', { conversation: 'look-starter/main' }, { approve: true });
    check('used: it is on and approved', st('look-starter').state === 'on' && !!g.app.config().mods.approved['look-starter']);
    await rpc(g, 'mods.remove', 'look-starter');
    check('removed: Default again, the approval forgotten', g.app.config().mods.layout.looks.conversation === null && !g.app.config().mods.approved['look-starter']);
    for (const id of ['look-user', 'look-starter', 'bar-starter']) fs.rmSync(path.join(g.roots.user, id), { recursive: true, force: true });
    gctl.close();
  }

  // ---------- A profile from 0.8.0: looks had switches, themes stacked ----------
  {
    const css = { 'a.css': ':root{--accent:red}', 'holo.css': '.msg { color: red }', 'panel.html': page };
    const mg = fakeApp();
    const theme = (id) => ({ protocol: 1, id, name: id, version: '0.1.0', contributes: { styles: ['a.css'] } });
    writeMod(mg.roots.bundled, 'inky', theme('inky'), css);
    writeMod(mg.roots.bundled, 'paperish', theme('paperish'), css);
    writeMod(mg.roots.bundled, 'sleepy', theme('sleepy'), css);
    writeMod(mg.roots.bundled, 'hyper', { protocol: 1, id: 'hyper', name: 'Hyper', version: '0.1.0', contributes: { looks: [{ id: 'holo', title: 'Holo', target: 'conversation', styles: ['holo.css'] }, { id: 'bar', title: 'Bar', target: 'composer', styles: ['holo.css'] }] } }, css);
    writeMod(mg.roots.bundled, 'walls', { protocol: 1, id: 'walls', name: 'Walls', version: '0.1.0', contributes: { views: [{ id: 'aurora', title: 'Aurora', entry: 'panel.html', seat: 'background' }] } }, css);
    writeMod(mg.roots.bundled, 'dots', { protocol: 1, id: 'dots', name: 'Dots', version: '0.1.0', contributes: { views: [{ id: 'grid', title: 'Grid', entry: 'panel.html', seat: 'background' }] } }, css);
    writeMod(mg.roots.user, 'mine', { protocol: 1, id: 'mine', name: 'Mine', version: '0.1.0', permissions: ['session:read'], contributes: { looks: [{ id: 'holo', title: 'Holo', target: 'conversation', styles: ['holo.css'] }] } }, css);
    writeMod(mg.roots.user, 'yourtheme', { ...theme('yourtheme') }, css);
    writeMod(mg.roots.user, 'idle', { protocol: 1, id: 'idle', name: 'Idle', version: '0.1.0', contributes: { looks: [{ id: 'x', title: 'X', target: 'composer', styles: ['holo.css'] }] } }, css);
    const at = 1700000000000;
    mg.app.updateConfig((c) => {
      const { theme: _drop, ...layout } = c.mods.layout;
      return {
        ...c,
        mods: {
          ...c.mods,
          enabled: { inky: { permissions: [], styles: true, at }, paperish: { permissions: [], styles: true, at }, mine: { permissions: ['session:read'], styles: true, at }, yourtheme: { permissions: [], styles: true, at } },
          disabledBundled: ['walls'],
          layout: { ...layout, looks: { conversation: 'mine/holo', composer: 'hyper/bar' }, background: 'walls/aurora' },
        },
      };
    });
    check('migration: the profile has no theme in its layout (0.8.0)', !('theme' in mg.app.config().mods.layout));
    const mgc = createMods(mg.app, mg.host);
    const c = mg.app.config().mods;
    const ms = (k) => rpc(mg, 'mods.list').find((m) => m.key === k);
    check('migration: of the themes that were on, the last in apply order stays (built-in, then yours)', c.layout.theme === 'yourtheme' && rpc(mg, 'mods.styles').length === 1 && rpc(mg, 'mods.styles')[0].key === 'yourtheme', c.layout.theme);
    check('migration: a look that showed stays in use (its mod was on), with its approval', c.layout.looks.conversation === 'mine/holo' && c.approved.mine && c.approved.mine.permissions.join() === 'session:read' && ms('mine').state === 'on' && ms('mine').approved === true);
    check('migration: a look whose mod was off showed nothing, so it goes', c.layout.looks.composer === null);
    check('migration: a background from a mod turned off goes too', c.layout.background === null);
    check('migration: switches of looks are gone (enabled, disabledBundled)', !c.enabled.inky && !c.enabled.paperish && !c.enabled.mine && !c.enabled.yourtheme && !c.disabledBundled.includes('walls'));
    check('migration: a look mod that was on but not chosen is simply available', ms('inky').state === 'off' && ms('inky').approved === true && ms('yourtheme').approved === true && ms('idle').approved === false);
    mgc.close();
    // A second start does not migrate again
    mg.app.updateConfig((cc) => ({ ...cc, mods: { ...cc.mods, layout: { ...cc.mods.layout, theme: null } } }));
    const mgc2 = createMods(mg.app, mg.host);
    check('migration: runs once (a layout with a theme, even null, is left alone)', mg.app.config().mods.layout.theme === null);
    mgc2.close();
  }

  // ---------- Quit ----------
  {
    await call(f, 'noperm', 'storage.set', { key: 'last', value: 'quit' });
    for (const q of f.quits) await q();
    const again = new ModStorage(path.join(f.userData, 'mods-data'));
    check('quit flushes storage', again.get('noperm', 'mod', f.runtime.fg, 'last') === 'quit');
  }

  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
