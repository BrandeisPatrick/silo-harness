// Live: a repackaged app's bundled defaults (SILO_HARNESS_DEFAULTS standing in for Contents/Resources/defaults.json)
// meet Settings → Models in the real window, on a first launch with an empty config.json and no settings.json:
//   - the bundled provider is the one in use, "No key", with the bundle's models in the picker and its key field open
//   - a key pasted there is saved in the person's config.json as that entry's apiKey alone (600), never in the bundle,
//     never whole in the window; the provider reads Ready and a model test answers
//   - a model and the safety check's model chosen in the window are kept across a restart; a bundled provider offers
//     no Remove
//   - Reset settings… goes back to the bundle's values (the key with it), keeps sessions, leaves the bundle file alone
// The provider is the mock model, which wants exactly the pasted key. Run: npm run build && node test/live/bundled-models.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');
const { startMock } = require('../support/mock-model.js');

const KEY = 'acme-SECRET-key-0123456789wxyz';

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const gw = await startMock();
  gw.state.apiKey = KEY;
  gw.state.models = ['acme/model-a', 'acme/model-b'];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-profile-'));
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-resources-'));
  const bundleFile = path.join(resources, 'defaults.json');
  const bundle = {
    provider: 'acme',
    providers: { acme: { type: 'openai-compatible', label: 'Acme Gateway', baseURL: `http://127.0.0.1:${gw.port}/v1`, apiKeyEnv: 'ACME_API_KEY', model: 'acme/model-a', models: ['acme/model-a', 'acme/model-b'] } },
    autoMode: { model: 'acme:acme/model-b' },
  };
  fs.writeFileSync(bundleFile, JSON.stringify(bundle, null, 2));
  const bundleText = fs.readFileSync(bundleFile, 'utf8');
  const configFile = path.join(profile, 'config.json');
  fs.writeFileSync(configFile, '');
  const userSettings = path.join(profile, 'home-config', 'settings.json');
  const opts = { profile, mock: true, seed: false, scale: 1, size: { width: 1440, height: 1000 }, env: { SILO_HARNESS_DEFAULTS: bundleFile, SILO_HARNESS_NO_RELAUNCH: '1', ACME_API_KEY: '' } };
  let app;
  const cfg = () => app.evaluate('window.oc.getConfig()');
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn().catch(() => null);
      if (v || Date.now() > end) return v;
      await sleep(120);
    }
  };
  const status = () => app.evaluate(`document.querySelector('#sp-row-provider .sp-status')?.innerText.trim() ?? ''`);
  const desc = (row) => app.evaluate(`(() => { const d = document.querySelector('#sp-row-${row} > .sp-row-text > .sp-row-desc'); return d && !d.hidden ? d.textContent : ''; })()`);
  const shown = (sel) => app.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return Boolean(e && e.offsetParent !== null && !e.hidden); })()`);
  const options = () => app.evaluate(`[...document.querySelectorAll('.sp-picker-pop .sp-picker-item')].map((o) => o.innerText.trim().replace(/\\s+/g, ' '))`);
  const pickOption = (text) => app.evaluate(`(() => { const o = [...document.querySelectorAll('.sp-picker-pop .sp-picker-item')].find((x) => x.title === ${JSON.stringify(text)} || x.innerText.trim().startsWith(${JSON.stringify(text)})); if (!o) return false; o.click(); return true; })()`);
  const stored = () => {
    const t = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
    return t.trim() ? JSON.parse(t) : {};
  };
  const chats = () => gw.state.requests.filter((q) => q.url === '/v1/chat/completions');
  const openModels = async () => {
    await app.evaluate(`window.__oc_debug.settings.open('model')`);
    await sleep(800);
  };
  const setCheck = (v) => app.evaluate(`(() => { const s = document.querySelector('#autoMode-model'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); return s.value; })()`);

  try {
    app = await launch(opts);

    // --- First launch: the bundled provider, no key ---
    await openModels();
    check('the bundled provider is the one in use', (await app.text('#provider'))?.includes('Acme Gateway') && (await cfg()).provider === 'acme', await app.text('#provider'));
    check('… "No key", and where it goes', (await status()) === 'No key' && (await desc('provider')) === 'Paste its key under API key.', { s: await status(), d: await desc('provider') });
    check('… the key field is open', await shown('#provider-apiKey-input'));
    await app.click('#provider-model');
    await sleep(300);
    const opts1 = await options();
    check("… the model picker holds the bundle's models, the bundle's model in use", opts1.length === 2 && opts1[0] === 'acme/model-a In use' && opts1[1] === 'acme/model-b', opts1);
    await app.key('Escape');
    check('… nothing was asked of the service without a key', gw.state.requests.length === 0);
    await app.screenshot(path.join(shots, 'bundled-no-key.png'));

    // --- Pasting the key ---
    await app.fill('#provider-apiKey-input', KEY);
    await app.click('#sp-row-provider-apiKey .btn.primary');
    check('Save: the provider reads Ready with the key', Boolean(await until(async () => (await status()) === 'Ready')), await status());
    const s = stored();
    check("… the key is in the person's config.json as the entry's apiKey alone, and nothing else of the bundle's", JSON.stringify(s.providers) === JSON.stringify({ acme: { apiKey: KEY } }) && !('provider' in s) && !('model' in (s.autoMode ?? {})), JSON.stringify(s).split(KEY).join('…'));
    check('… config.json is owner-only (600)', (fs.statSync(configFile).mode & 0o777) === 0o600);
    check('… no settings.json was made, and the bundle file is untouched', !fs.existsSync(userSettings) && fs.readFileSync(bundleFile, 'utf8') === bundleText);
    check('… the row shows dots and the last four, "Saved in your settings"', (await app.text('#sp-row-provider-apiKey .sp-key-box')) === '••••••••wxyz' && (await desc('provider-apiKey')) === 'Saved in your settings');
    const page = await app.evaluate(`document.documentElement.outerHTML + [...document.querySelectorAll('input')].map((i) => i.value).join(' ')`);
    check('… the window never has the whole key', !JSON.stringify(await cfg()).includes(KEY) && !page.includes(KEY));
    await app.click('#sp-row-provider-model .sp-pair-side .btn');
    const answered = await until(async () => /^Answered in \d/.test((await app.text('#sp-row-provider-model .sp-row-result')) || ''), 10_000);
    check('… a model test answers', Boolean(answered) && chats().length === 1, await app.text('#sp-row-provider-model .sp-row-result'));
    check('a bundled provider offers no Remove', !(await shown('#sp-row-provider-remove')));
    await app.screenshot(path.join(shots, 'bundled-key-saved.png'));

    // --- A model and the check's model, kept across a restart ---
    await app.click('#provider-model');
    await sleep(300);
    check('choosing acme/model-b in the picker', await pickOption('acme/model-b'));
    check('… writes only that into config.json', Boolean(await until(async () => stored().providers?.acme?.model === 'acme/model-b')));
    await app.click('#sp-sec-model .sp-page-advanced .sp-disclosure');
    await sleep(300);
    check("the safety check's select starts on the bundle's model", (await app.evaluate(`document.querySelector('#autoMode-model').value`)) === 'acme:acme/model-b');
    await setCheck('acme:acme/model-a');
    check('… choosing another writes it', Boolean(await until(async () => stored().autoMode?.model === 'acme:acme/model-a')));
    await app.close();
    app = await app.relaunch();
    let c = await cfg();
    check('after a restart: the model, the check model and the key are kept', c.provider === 'acme' && c.providers.acme.model === 'acme/model-b' && c.autoMode.model === 'acme:acme/model-a', { m: c.providers.acme.model, check: c.autoMode.model });
    await openModels();
    check('… and the provider is Ready', Boolean(await until(async () => (await status()) === 'Ready')), await status());
    await app.click('#provider-model');
    await sleep(300);
    await pickOption('acme/model-a');
    check("choosing the bundle's own model again leaves it out of config.json", Boolean(await until(async () => stored().providers?.acme && !('model' in stored().providers.acme))), JSON.stringify(stored().providers).split(KEY).join('…'));

    // --- Reset settings: back to the bundle's values ---
    await app.send('Hello from the bundled install');
    await app.waitIdle();
    await app.evaluate(`window.__oc_debug.settings.open('developer')`);
    await sleep(500);
    await app.evaluate(`document.querySelector('#sp-row-reset-settings').scrollIntoView({ block: 'center' })`);
    await app.click('#sp-row-reset-settings button');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000, 'the confirmation');
    await app.click('#confirm-ok');
    const child = app.child;
    const exited = await Promise.race([new Promise((r) => (child.exitCode !== null ? r(true) : child.once('exit', () => r(true)))), sleep(20_000).then(() => false)]);
    await app.kill();
    check('Reset settings: the app quits to relaunch', exited);
    app = await app.relaunch();
    c = await cfg();
    check("after Reset settings: the bundle's values, not the bare defaults", c.provider === 'acme' && c.providers.acme.model === 'acme/model-a' && c.autoMode.model === 'acme:acme/model-b', { p: c.provider, m: c.providers?.acme?.model, check: c.autoMode.model });
    check('… the bundle file is untouched, the session stays', fs.readFileSync(bundleFile, 'utf8') === bundleText && (await app.evaluate('window.oc.sessions.list()')).length >= 1);
    await openModels();
    check('… and the key went with the saved settings: "No key" again', (await status()) === 'No key' && (await shown('#provider-apiKey-input')));
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
  } catch (err) {
    check(`no crash: ${err.message}`, false, app?.logs?.slice(-20).join('\n'));
  } finally {
    await app?.close();
    gw.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(`${profile}-trash`, { recursive: true, force: true });
    fs.rmSync(resources, { recursive: true, force: true });
  }
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
