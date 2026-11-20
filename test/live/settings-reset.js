// Live: Settings → Developer → Reset settings… and Full reset… in the real window, on a throwaway profile with the mock
// model. The Trash is a stand-in folder beside the profile (the rig sets SILO_HARNESS_TRASH_DIR), so nothing lands in
// yours; SILO_HARNESS_NO_RELAUNCH makes the app quit where it would relaunch, and the rig starts it again.
//   - each confirmation says what goes and what stays, Cancel has the focus, Cancel changes nothing
//   - Reset settings: the app's saved settings back to defaults; sessions, mods and your settings.json stay
//   - Full reset: sessions, history, learned answers, browser data, the saved settings and your mods go; settings.json
//     and your skills and projects stay; with the box ticked, settings.json goes too
//   - everything that went is in the Trash stand-in, whole
// Run: npm run build && node test/live/settings-reset.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const js = (v) => JSON.stringify(v);

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-profile-'));
  const home = path.join(profile, 'home-config');
  const userSettings = path.join(home, 'settings.json');
  const modDir = path.join(home, 'mods', 'hello');
  const skillFile = path.join(home, 'skills', 'mine', 'SKILL.md');
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, 'mod.json'), js({ protocol: 1, id: 'hello', version: '0.1.0', name: 'Hello' }));
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, '---\nname: mine\ndescription: A skill of yours.\n---\nHello.\n');
  fs.writeFileSync(userSettings, js({ providers: { local: { type: 'lmstudio', model: 'qwen' } } }));
  const opts = { profile, mock: true, scale: 1, size: { width: 1100, height: 900 }, env: { SILO_HARNESS_NO_RELAUNCH: '1' }, config: { theme: 'dark', autoCompact: false } };
  let app = await launch(opts);
  const trash = app.trashDir;
  const projectFile = path.join(app.project, 'notes.txt');
  fs.writeFileSync(projectFile, 'a file of your project');
  const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
  const inTrash = (prefix) => ls(trash).filter((n) => n.startsWith(prefix));

  /** Opens Developer, clicks a Reset row's button and waits for the confirmation; returns its text */
  const ask = async (row) => {
    await app.evaluate(`window.__oc_debug.settings.open('developer')`);
    await sleep(500);
    await app.evaluate(`document.querySelector('#sp-row-${row}').scrollIntoView({ block: 'center' })`);
    await app.click(`#sp-row-${row} button`);
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000, 'the confirmation');
    await sleep(200);
    return (await app.text('#confirm-dialog')) || '';
  };
  /** Confirms, waits for the app to quit, and starts it again on the same profile */
  const confirmAndRelaunch = async () => {
    await app.click('#confirm-ok');
    const child = app.child;
    const exited = await Promise.race([new Promise((r) => (child.exitCode !== null ? r(true) : child.once('exit', () => r(true)))), sleep(20_000).then(() => false)]);
    await app.kill();
    app = await app.relaunch();
    return exited;
  };
  const sessions = () => app.evaluate('window.oc.sessions.list()');

  try {
    // ---------- A session, a learned answer's file, a theme ----------
    await app.send('Remember the copper kettle');
    await app.waitIdle();
    check('(a session with a message, the dark theme)', (await sessions()).length === 1 && (await app.evaluate('window.oc.getConfig()')).theme === 'dark');
    fs.writeFileSync(path.join(profile, 'auto-learned.json'), '[]');

    // ---------- The rows ----------
    await app.evaluate(`window.__oc_debug.settings.open('developer')`);
    await sleep(500);
    const rows = await app.evaluate(`[...document.querySelectorAll('#sp-sec-developer .sp-danger-card .sp-row')].map((r) => [r.dataset.row, r.querySelector('.sp-row-title').innerText, r.querySelector('.sp-row-desc').innerText])`);
    check('Developer → Reset: Delete all sessions, Delete all custom mods, Reset settings, Full reset', rows.map((r) => r[0]).join() === 'reset-sessions,reset-mods,reset-settings,reset-full', rows);
    check('… Reset settings says "Back to defaults. Sessions stay."', rows.find((r) => r[0] === 'reset-settings')?.[2] === 'Back to defaults. Sessions stay.');

    // ---------- Reset settings: Cancel first ----------
    let text = await ask('reset-settings');
    check('Reset settings asks first, says sessions, mods and settings.json stay, and Cancel has the focus', /Reset settings\?/.test(text) && /Sessions, mods and your settings\.json stay/.test(text) && (await app.evaluate(`document.activeElement?.id`)) === 'confirm-cancel', text);
    await app.screenshot(path.join(shots, 'reset-settings-confirm.png'));
    await app.click('#confirm-cancel');
    await sleep(500);
    check('Cancel changes nothing', (await app.evaluate('window.oc.getConfig()')).theme === 'dark' && !fs.existsSync(path.join(profile, '.silo-reset.json')) && ls(trash).length === 0);
    await ask('reset-settings');
    check('Confirm: the app quits to relaunch', await confirmAndRelaunch());
    let c = await app.evaluate('window.oc.getConfig()');
    check('after Reset settings: the saved settings are the defaults', c.theme === 'system' && c.autoCompact === true, { theme: c.theme, autoCompact: c.autoCompact });
    check('… the session stays, with its message', (await sessions()).some((m) => m.messageCount >= 1));
    check('… your mods, settings.json and the learned answers stay', fs.existsSync(modDir) && fs.existsSync(userSettings) && fs.existsSync(path.join(profile, 'auto-learned.json')));
    const settingsTrash = inTrash('.silo-reset-');
    check('… the old saved settings are in the Trash (the stand-in), with the dark theme in them', settingsTrash.length === 1 && JSON.parse(fs.readFileSync(path.join(trash, settingsTrash[0], 'config.json'), 'utf8')).theme === 'dark', settingsTrash);

    // ---------- Full reset, settings.json kept ----------
    text = await ask('reset-full');
    check('Full reset lists what goes, says projects are not touched, offers settings.json unticked, and Cancel has the focus', /Full reset\?/.test(text) && ['Sessions and history', 'Logs', 'Browser data and sign-ins', 'Learned answers', 'Your mods', "The app's saved settings"].every((x) => text.includes(x)) && /projects and their files are not touched/.test(text) && /Also my settings\.json \(providers and keys\)/.test(text) && !(await app.evaluate(`document.querySelector('#confirm-check-input').checked`)) && (await app.evaluate(`document.activeElement?.id`)) === 'confirm-cancel', text);
    await app.screenshot(path.join(shots, 'reset-full-confirm.png'));
    check('Confirm: the app quits to relaunch', await confirmAndRelaunch());
    check('after Full reset: no session but a fresh empty one', (await sessions()).length === 0);
    check('… the history, the learned answers and the browser data are gone from the data folder', !fs.existsSync(path.join(profile, 'history', 'index.json')) && !ls(path.join(profile, 'history')).some((f) => f.endsWith('.jsonl')) && !fs.existsSync(path.join(profile, 'auto-learned.json')));
    check('… your mods are gone; your settings.json, your skills and your project’s files stay', !fs.existsSync(modDir) && fs.existsSync(userSettings) && fs.existsSync(skillFile) && fs.readFileSync(projectFile, 'utf8') === 'a file of your project');
    const full = inTrash('.silo-reset-').filter((n) => !settingsTrash.includes(n));
    const fullDir = full[0] ? path.join(trash, full[0]) : '';
    check('… all of it is in the Trash (the stand-in), whole: sessions, history, learned answers, your mods', full.length === 1 && ['sessions', 'history', 'auto-learned.json', 'config.json', 'your-mods'].every((x) => ls(fullDir).includes(x)) && fs.existsSync(path.join(fullDir, 'your-mods', 'hello', 'mod.json')), ls(fullDir));

    // ---------- Full reset with the box ticked ----------
    await ask('reset-full');
    await app.click('#confirm-check-input');
    check('Confirm with "Also my settings.json" ticked: the app quits to relaunch', await confirmAndRelaunch());
    const third = inTrash('.silo-reset-').filter((n) => !settingsTrash.includes(n) && !full.includes(n));
    check('… settings.json is gone, into the Trash with the rest; your skills and project stay', !fs.existsSync(userSettings) && third.length === 1 && ls(path.join(trash, third[0])).includes('your-settings.json') && fs.existsSync(skillFile) && fs.existsSync(projectFile), third.map((n) => ls(path.join(trash, n))));
    c = await app.evaluate('window.oc.getConfig()');
    check('… and the providers it held are gone from the app', !c.providers?.local, Object.keys(c.providers || {}));
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
  } catch (err) {
    check(`no crash: ${err.message}`, false, app?.logs?.slice(-20).join('\n'));
  } finally {
    await app?.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(`${profile}-trash`, { recursive: true, force: true });
  }
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
