// Full reset and Reset settings (src/main/reset.ts, trash.ts): what the next launch moves aside for each, what stays
// (your projects, your skills, Chromium's lock; settings.json unless asked), that everything goes to the Trash (here a
// stand-in folder, SILO_HARNESS_TRASH_DIR) and nothing is deleted, and that only the main window's own page can ask:
// not an RPC (so not the phone remote, a mod's bridge, a hook or the agent's tools). Runs on temp folders only.
// Run: node test/reset.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (f) => require(path.join(projectDir, 'dist/main', f));
const { check, done } = require('./support/check.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-reset-'));
const stand = path.join(root, 'trash-stand-in');
process.env.SILO_HARNESS_TRASH_DIR = stand;
process.env.SILO_HARNESS_CONFIG_DIR = path.join(root, 'unused-config');
const R = dist('reset.js');
const lines = [];
const log = (l) => lines.push(l);

let n = 0;
/** A data folder and a config folder as the app leaves them */
function profile() {
  const base = path.join(root, `p${++n}`);
  const userData = path.join(base, 'userData');
  const config = path.join(base, 'config');
  const put = (f, text = 'x') => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  put(path.join(userData, 'config.json'), '{"theme":"dark"}');
  put(path.join(userData, 'sessions', 's1.json'));
  put(path.join(userData, 'history', 's1.jsonl'));
  put(path.join(userData, 'auto-learned.json'));
  put(path.join(userData, 'Partitions', 'browser', 'Cookies'));
  put(path.join(userData, 'logs', 'run.log'));
  put(path.join(userData, 'SingletonLock'));
  put(path.join(userData, 'DevToolsActivePort'));
  put(path.join(config, 'settings.json'), '{"providers":{}}');
  put(path.join(config, 'mods', 'hello', 'mod.json'));
  put(path.join(config, 'skills', 'mine', 'SKILL.md'));
  return { userData, config };
}
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const standItems = () => ls(stand);

(async () => {
  // --- No mark: nothing happens ---
  {
    const p = profile();
    check('no mark: nothing is moved', R.stageReset(p.userData, log, p.config) === null && ls(p.userData).includes('sessions') && ls(p.config).includes('mods'));
    check('… and nothing is sent to the Trash', (await R.finishReset(p.userData, log)) === 0 && standItems().length === 0);
  }

  // --- Full reset, settings.json kept ---
  {
    const p = profile();
    R.markReset(p.userData, { kind: 'full', settingsJson: false, at: 1000 });
    check('the mark is the app’s own small file, owner-only', (fs.statSync(path.join(p.userData, R.RESET_MARK)).mode & 0o777) === 0o600);
    const plan = R.stageReset(p.userData, log, p.config);
    const left = ls(p.userData);
    check('full reset: the data folder keeps only the folder on its way to the Trash and Chromium’s own files', plan?.kind === 'full' && left.join() === '.silo-reset-1000,DevToolsActivePort,SingletonLock', left);
    const stage = path.join(p.userData, '.silo-reset-1000');
    check('… everything else is in that folder, moved not copied: sessions, history, logs, browser data, learned answers, the saved settings', ['config.json', 'sessions', 'history', 'logs', 'Partitions', 'auto-learned.json', 'your-mods'].every((x) => ls(stage).includes(x)), ls(stage));
    check('… your mods went with it; your settings.json and your skills stay', !ls(p.config).includes('mods') && ls(p.config).includes('settings.json') && ls(p.config).includes('skills'), ls(p.config));
    check('… the mark is gone', !fs.existsSync(path.join(p.userData, R.RESET_MARK)));
    const sent = await R.finishReset(p.userData, log);
    const inTrash = standItems();
    check('once ready: the folder goes to the Trash (the stand-in) whole, nothing deleted', sent === 1 && inTrash.length === 1 && inTrash[0].startsWith('.silo-reset-1000') && fs.existsSync(path.join(stand, inTrash[0], 'sessions', 's1.json')) && fs.existsSync(path.join(stand, inTrash[0], 'your-mods', 'hello', 'mod.json')), inTrash);
    check('… and the data folder is as at a first launch (Chromium’s lock aside)', ls(p.userData).join() === 'DevToolsActivePort,SingletonLock');
  }

  // --- A config folder inside the data folder (a test's profile): it stays, but for its mods ---
  {
    const p = profile();
    const inner = path.join(p.userData, 'home-config');
    fs.renameSync(p.config, inner);
    R.markReset(p.userData, { kind: 'full', settingsJson: false, at: 1500 });
    R.stageReset(p.userData, log, inner);
    check('a config folder inside the data folder stays (settings.json, skills); only its mods go', ls(p.userData).includes('home-config') && ls(inner).join() === 'settings.json,skills' && ls(path.join(p.userData, '.silo-reset-1500')).includes('your-mods') && !ls(p.userData).includes('sessions'), { top: ls(p.userData), inner: ls(inner) });
    await R.finishReset(p.userData, log);
  }

  // --- Full reset with settings.json ---
  {
    const p = profile();
    R.markReset(p.userData, { kind: 'full', settingsJson: true, at: 2000 });
    R.stageReset(p.userData, log, p.config);
    check('full reset with the box ticked: settings.json goes too; skills stay', !ls(p.config).includes('settings.json') && ls(p.config).includes('skills') && ls(path.join(p.userData, '.silo-reset-2000')).includes('your-settings.json'));
    await R.finishReset(p.userData, log);
  }

  // --- Reset settings ---
  {
    const p = profile();
    R.markReset(p.userData, { kind: 'settings', settingsJson: true, at: 3000 });
    const plan = R.stageReset(p.userData, log, p.config);
    check('reset settings: only config.json moves aside; sessions, history, browser data stay', plan?.kind === 'settings' && plan.settingsJson === false && !ls(p.userData).includes('config.json') && ['sessions', 'history', 'Partitions', 'auto-learned.json'].every((x) => ls(p.userData).includes(x)));
    check('… your mods and your settings.json are not touched', ls(p.config).includes('mods') && ls(p.config).includes('settings.json'));
    const before = standItems().length;
    await R.finishReset(p.userData, log);
    const added = standItems().filter((x) => x.startsWith('.silo-reset-3000'));
    check('… and the old config.json is in the Trash', standItems().length === before + 1 && added.length === 1 && fs.readFileSync(path.join(stand, added[0], 'config.json'), 'utf8') === '{"theme":"dark"}');
  }

  // --- A mark the app did not write: left out ---
  {
    const p = profile();
    fs.writeFileSync(path.join(p.userData, R.RESET_MARK), '{"kind":"everything"}');
    check('a mark the app did not write moves nothing', R.stageReset(p.userData, log, p.config) === null && ls(p.userData).includes('sessions') && !fs.existsSync(path.join(p.userData, R.RESET_MARK)));
  }

  // --- A folder the Trash could not take stays for the next launch ---
  {
    const p = profile();
    R.markReset(p.userData, { kind: 'settings', settingsJson: false, at: 4000 });
    R.stageReset(p.userData, log, p.config);
    process.env.SILO_HARNESS_TRASH_DIR = path.join(p.userData, 'config.json.not-a-dir', 'x');
    fs.writeFileSync(path.join(p.userData, 'config.json.not-a-dir'), 'file');
    const sent = await R.finishReset(p.userData, log);
    check('when the Trash cannot take it, the folder stays (nothing lost) and the next launch tries again', sent === 0 && ls(p.userData).includes('.silo-reset-4000') && lines.some((l) => /trying again at the next launch/.test(l)));
    process.env.SILO_HARNESS_TRASH_DIR = stand;
    check('… which it does', (await R.finishReset(p.userData, log)) === 1 && !ls(p.userData).includes('.silo-reset-4000'));
  }

  // --- Only the main window's own page can ask ---
  {
    const mainFrame = { url: 'file:///app/dist/renderer/index.html' };
    const wc = { mainFrame };
    const win = { webContents: wc };
    check('the main window’s top frame may ask', R.fromMainWindow(wc, mainFrame, win));
    check('… not a frame inside it (a mod’s view, an artifact)', !R.fromMainWindow(wc, { url: 'mod://hello/panel.html' }, win));
    check('… not another page (the Browser pane, a mod window)', !R.fromMainWindow({ mainFrame: {} }, {}, win));
    check('… not the main window once it shows anything but the app’s own file', !R.fromMainWindow({ mainFrame: { url: 'https://example.com/' } }, { url: 'https://example.com/' }, { webContents: { mainFrame: { url: 'https://example.com/' } } }) && !R.fromMainWindow(wc, { ...mainFrame }, win));
    check('… and nothing at all without a window', !R.fromMainWindow(wc, mainFrame, null));

    // Not an RPC: the generic channel the window, the remote's routes and the mods' bridge all go through has no reset
    const { createApp } = dist('app.js');
    const { defaultConfig } = dist('config.js');
    const app = createApp({ userData: path.join(root, 'app-data'), appRoot: projectDir, loadConfig: () => ({ ...defaultConfig(), workingDirectory: root }), saveConfig: () => {} });
    const refusals = [];
    for (const m of ['app.reset', 'reset', 'settings.reset', 'app:reset', 'providers.reset', 'history.reset']) {
      try {
        await app.invokeRpc(m, ['full', { settingsJson: true }]);
        refusals.push(`${m}: answered`);
      } catch (e) {
        if (!/Unknown RPC method/.test(e.message)) refusals.push(`${m}: ${e.message}`);
      }
    }
    check('no RPC resets anything (the window’s generic channel, which the other surfaces reach)', refusals.length === 0, refusals);
    const { MOD_METHOD_PERMISSIONS } = dist('mods/permissions.js');
    check('a mod’s bridge has no reset method', !Object.keys(MOD_METHOD_PERMISSIONS).some((m) => /reset|relaunch|trash/i.test(m)), Object.keys(MOD_METHOD_PERMISSIONS).filter((m) => /reset/i.test(m)));
    const { Api: RemoteApi } = dist('remote/api.js');
    const api = new RemoteApi(app, { sessionsMoved: () => {}, mark: () => 0 });
    const answered = [];
    for (const route of ['reset', 'app.reset', 'settings/reset', 'full-reset']) {
      for (const method of ['GET', 'POST']) {
        const res = { writeHead() {}, setHeader() {}, end() {} };
        if (await api.handle(route, new URL(`http://x/api/${route}`), { method, headers: {} }, res)) answered.push(`${method} ${route}`);
      }
    }
    check('the phone remote has no reset route', answered.length === 0, answered);
    const tools = app.tools.list().map((t) => t.name);
    check('no agent tool resets the app', !tools.some((t) => /reset|relaunch/i.test(t)), tools.filter((t) => /reset/i.test(t)));
  }

  fs.rmSync(root, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.log('CRASH', err && err.stack);
  process.exit(1);
});
