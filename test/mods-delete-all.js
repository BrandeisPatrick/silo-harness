// Settings → Mods → Delete all custom mods, headless: createMods with a fake App and a fake desktop host, in temp
// folders. Only the folders in the user mods folder go, through the host's trash (shell.trashItem in the app); what
// the config held for them is forgotten and a look of theirs in use goes back to Default; built-in and project mods
// stay. Run: node test/mods-delete-all.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

const tmp = (p = 'oa-mods-all-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const HOME = tmp('oa-mods-all-home-');
process.env.SILO_HARNESS_CONFIG_DIR = HOME;

const { createMods } = require(path.join(projectDir, 'dist', 'main', 'mods.js'));
const { SessionStore } = require(path.join(projectDir, 'dist', 'main', 'sessions.js'));

/** Writes a mod folder: mod.json (object or raw text) plus files. */
function writeMod(root, id, manifest, files = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, 'mod.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  return dir;
}
const page = '<!doctype html><p>hi</p>';
const panel = (id, extra = {}) => ({ protocol: 1, id, name: id[0].toUpperCase() + id.slice(1), version: '0.1.0', contributes: { views: [{ id: 'main', title: 'Main', entry: 'panel.html', seat: 'rail' }] }, ...extra });
const theme = (id) => ({ protocol: 1, id, name: id[0].toUpperCase() + id.slice(1), version: '0.1.0', contributes: { styles: ['theme.css'] } });

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

/** The App as test/mods.js fakes it, with a host whose trash records each folder and removes it. */
function fakeApp() {
  const userData = tmp('oa-mods-all-data-');
  const appRoot = tmp('oa-mods-all-app-');
  const project = tmp('oa-mods-all-project-');
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
  const runtime = {
    fg: session.id,
    foregroundId: () => runtime.fg,
    setForeground: (id) => ((runtime.fg = id), store.get(id)),
    agentFor: () => ({ contextInfo: () => ({ tokens: 0, limit: 16384, threshold: 0.8, autoCompact: true }) }),
    create: () => store.create(),
    send: () => ({ ok: true }),
    stop: () => {},
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
  const host = { trash: async (d) => (trashed.push(d), fs.rmSync(d, { recursive: true, force: true })), reveal: () => {}, chooseImage: async () => null };
  const roots = { bundled: path.join(appRoot, 'mods'), user: path.join(HOME, 'mods'), project: path.join(project, '.silo-harness', 'mods') };
  return { app, host, project, roots, pushes, handlers, trashed };
}
const rpc = (f, m, ...a) => f.handlers[m](...a);
const by = (list, id, scope) => list.find((m) => m.id === id && (!scope || m.scope === scope));
const summary = (list) => list.map((m) => `${m.id}:${m.scope}:${m.state}`);

(async () => {
  const f = fakeApp();
  // Built-in: a panel and a theme. Yours: a panel with a setting, a theme, a conversation look, a background, a folder
  // without mod.json, a customised copy of the built-in panel, an install's staging folder and a plain file. The
  // project's: a panel.
  writeMod(f.roots.bundled, 'alpha', panel('alpha'), { 'panel.html': page });
  writeMod(f.roots.bundled, 'beta', theme('beta'), { 'theme.css': ':root{--accent:red}' });
  writeMod(f.roots.user, 'hello', panel('hello', { contributes: { views: [{ id: 'main', title: 'Hello', entry: 'panel.html', seat: 'rail' }], settings: [{ key: 'n', type: 'number', title: 'N', default: 1 }] } }), { 'panel.html': page });
  writeMod(f.roots.user, 'tint', theme('tint'), { 'theme.css': ':root{--accent:blue}' });
  writeMod(f.roots.user, 'dusk', { protocol: 1, id: 'dusk', name: 'Dusk', version: '0.1.0', contributes: { looks: [{ id: 'main', title: 'Dusk', target: 'conversation', styles: ['look.css'] }] } }, { 'look.css': '.msg { color: red }' });
  writeMod(f.roots.user, 'stars', { protocol: 1, id: 'stars', name: 'Stars', version: '0.1.0', contributes: { views: [{ id: 'main', title: 'Stars', entry: 'bg.html', seat: 'background' }] } }, { 'bg.html': page });
  writeMod(f.roots.user, 'broken', undefined, { 'notes.txt': 'no mod.json here' });
  writeMod(f.roots.user, '.install-1a2b', '{}');
  fs.writeFileSync(path.join(f.roots.user, 'README.txt'), 'a file, not a mod');
  writeMod(f.roots.project, 'projo', panel('projo'), { 'panel.html': page });
  const ctl = createMods(f.app, f.host);
  const projKey = `projo@${f.project}`;
  rpc(f, 'mods.setEnabled', 'hello', true);
  rpc(f, 'mods.setSetting', 'hello', 'n', 5);
  rpc(f, 'mods.setEnabled', projKey, true);
  rpc(f, 'mods.use', { theme: 'tint', conversation: 'dusk/main', background: 'stars/main' }, { approve: true });
  rpc(f, 'mods.customise', 'alpha');
  // A theme ref the layout names for a folder of yours that has no usable mod.json (as a broken edit could leave it)
  rpc(f, 'mods.setLayout', { theme: 'broken' });
  rpc(f, 'mods.setLayout', { theme: 'tint' });
  const before = rpc(f, 'mods.list');
  check(
    'setup: the mods of yours are listed: on, in use, overriding, invalid',
    by(before, 'hello', 'user').state === 'on' && by(before, 'tint', 'user').state === 'on' && by(before, 'dusk', 'user').inUse.join() === 'conversation' && by(before, 'stars', 'user').inUse.join() === 'background' && by(before, 'alpha', 'user').overrides === true && by(before, 'alpha', 'user').state === 'on' && by(before, 'broken', 'user').state === 'invalid' && by(before, 'projo', 'project').state === 'on' && !before.some((m) => m.id.startsWith('.')),
    summary(before),
  );
  const cfg0 = f.app.config().mods;
  check(
    'setup: the config holds their grants, approvals, settings and looks',
    !!cfg0.enabled.hello && !!cfg0.enabled.alpha && cfg0.settings.hello.n === 5 && !!cfg0.approved.tint && !!cfg0.approved.dusk && !!cfg0.approved.stars && cfg0.layout.theme === 'tint' && cfg0.layout.looks.conversation === 'dusk/main' && cfg0.layout.background === 'stars/main',
    { enabled: Object.keys(cfg0.enabled), approved: Object.keys(cfg0.approved), layout: cfg0.layout },
  );
  check('setup: the theme and the look are served', rpc(f, 'mods.styles').length === 1 && rpc(f, 'mods.looks').length === 1);
  const pushesBefore = f.pushes.length;

  const r = await rpc(f, 'mods.removeAll');
  check('removeAll names every folder of yours, sorted, and not the staging folder or the file', r.removed.join() === 'alpha,broken,dusk,hello,stars,tint', r.removed);
  check("each went through the host's trash, from the user folder only", f.trashed.length === 6 && f.trashed.every((d) => path.dirname(d) === f.roots.user) && f.trashed.map((d) => path.basename(d)).sort().join() === r.removed.join(), f.trashed);
  check('the user folder keeps only the staging folder and the file', fs.readdirSync(f.roots.user).sort().join() === '.install-1a2b,README.txt', fs.readdirSync(f.roots.user));
  check('built-in and project folders are untouched', ['alpha', 'beta'].every((id) => fs.existsSync(path.join(f.roots.bundled, id, 'mod.json'))) && fs.existsSync(path.join(f.roots.project, 'projo', 'mod.json')));
  const after = r.mods;
  check(
    'the list has no mod of yours; the built-in alpha is back, on; beta and the project mod are as they were',
    !after.some((m) => m.scope === 'user') && by(after, 'alpha').scope === 'bundled' && by(after, 'alpha').state === 'on' && by(after, 'beta').scope === 'bundled' && by(after, 'projo', 'project').state === 'on' && after.length === 3,
    summary(after),
  );
  check('… and it is what mods.list returns', JSON.stringify(rpc(f, 'mods.list')) === JSON.stringify(after));
  const cfg = f.app.config().mods;
  check('their grants, approvals and settings are forgotten; the project mod keeps its grant', Object.keys(cfg.enabled).join() === projKey && Object.keys(cfg.approved).length === 0 && Object.keys(cfg.settings).length === 0, { enabled: Object.keys(cfg.enabled), approved: Object.keys(cfg.approved), settings: Object.keys(cfg.settings) });
  check('the theme, the conversation look and the background are Default again', cfg.layout.theme === null && cfg.layout.looks.conversation === null && cfg.layout.looks.composer === null && cfg.layout.background === null, cfg.layout);
  check('mods.styles and mods.looks serve nothing of theirs', rpc(f, 'mods.styles').length === 0 && rpc(f, 'mods.looks').length === 0);
  const changed = f.pushes.slice(pushesBefore).filter((p) => p.channel === 'mods:changed');
  check('the window was told the list changed, without them', changed.length >= 1 && !changed[changed.length - 1].payload.some((m) => m.scope === 'user'), changed.length);

  const r2 = await rpc(f, 'mods.removeAll');
  check('deleting again removes nothing and trashes nothing', r2.removed.length === 0 && f.trashed.length === 6 && r2.mods.length === after.length, r2.removed);
  fs.rmSync(f.roots.user, { recursive: true, force: true });
  const r3 = await rpc(f, 'mods.removeAll');
  check('without a user mods folder it removes nothing and does not fail', r3.removed.length === 0 && f.trashed.length === 6 && r3.mods.length === after.length);

  // A ref in the layout to a folder of yours that is gone with the rest, whatever its mod.json said
  writeMod(f.roots.user, 'ghost', undefined, { 'notes.txt': 'no manifest' });
  rpc(f, 'mods.reload');
  rpc(f, 'mods.setLayout', { theme: 'ghost', looks: { composer: 'ghost/main' } });
  const r4 = await rpc(f, 'mods.removeAll');
  const l4 = f.app.config().mods.layout;
  check('a look in use that names a folder of yours without a manifest goes back to Default with it', r4.removed.join() === 'ghost' && l4.theme === null && l4.looks.composer === null, { removed: r4.removed, theme: l4.theme, looks: l4.looks });

  ctl.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
