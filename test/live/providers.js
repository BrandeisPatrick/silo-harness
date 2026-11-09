// Live check of named providers in the real app, driven by the silo command as a coding agent would:
//   - the app runs on a throwaway profile and config folder; the command adds an OpenRouter-style provider that
//     points at the mock model and selects it; the window's label and Settings follow without a restart
//   - a message is answered through it (with the key as bearer), a broken key gives the plain error, the window
//     never holds the key, the Model section switches providers, the Command line tool row installs and removes
//   - with ANTHROPIC_API_KEY: a provider of type anthropic using apiKeyEnv, provider test says ok, and a short real
//     exchange works; the key stays in the environment and is never written to disk
// Run: npm run build && node test/live/providers.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launch, checker, sleep, LIVE_MODEL } = require('./rig.js');

const ROOT = path.join(__dirname, '..', '..');
const KEY = 'mock-live-key-0123456789';

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-profile-'));
  const home = path.join(profile, 'home-config');
  const userFile = path.join(home, 'settings.json');
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-bin-'));

  /** The command, as an agent runs it: the app's config folder and data folder, the variables given. */
  const cli = (args, env = {}, input) =>
    new Promise((resolve) => {
      const e = { ...process.env, SILO_HARNESS_CONFIG_DIR: home, SILO_HARNESS_USER_DATA: profile, ...env };
      const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'silo.js'), ...args], { env: e });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.stdin.end(input ?? '');
      child.on('close', (code) => {
        let json = null;
        try {
          json = JSON.parse(out);
        } catch {
          /* text */
        }
        resolve({ code, out, err, json });
      });
    });

  let app;
  try {
    app = await launch({ profile, mock: true, scale: 1, env: { MOCK_PROVIDER_KEY: KEY, SILO_HARNESS_CLI_LINK_DIR: linkDir } });
    const mock = app.mock;
    const mockURL = `http://127.0.0.1:${mock.port}/v1`;
    const cfg = () => app.evaluate('window.oc.getConfig()');
    const open = async (section) => {
      await app.evaluate(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-${section}')?.click(); })()`);
      await sleep(400);
    };
    const closeSettings = () => app.evaluate(`(() => { const d = document.querySelector('#settings'); if (d.open) d.close(); })()`);
    const until = async (fn, ms = 5000) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v || Date.now() > end) return v;
        await sleep(120);
      }
    };

    // The rig's own setup is the gateway block: the backward-compatibility path.
    let c = await cfg();
    check('the rig’s gateway block is in use, labelled Gateway', c.provider === 'portkey' && c.providerView?.active?.label === 'Gateway', c.providerView?.active);

    // --- The command adds a provider and selects it; the window follows without a restart ---
    let r = await cli(['provider', 'add', 'openrouter', '--type', 'openrouter', '--base-url', mockURL, '--key-env', 'MOCK_PROVIDER_KEY', '--model', 'anthropic/claude-sonnet-4.5', '--models', 'anthropic/claude-sonnet-4.5,openai/gpt-5-mini,google/gemini-3-pro', '--json']);
    check('silo provider add: ok', r.code === 0 && r.json?.ok, r.out + r.err);
    await cli(['provider', 'add', 'groq', '--type', 'groq', '--model', 'llama-3.3-70b-versatile']);
    await cli(['provider', 'add', 'lmstudio', '--type', 'lmstudio', '--model', 'qwen2.5-coder-14b-instruct', '--context-window', '32768']);
    r = await cli(['provider', 'use', 'openrouter', '--json']);
    check('silo provider use: ok', r.code === 0 && r.json?.provider?.name === 'openrouter', r.out + r.err);
    const followed = await until(async () => (await cfg()).providerView?.active?.name === 'openrouter');
    check('the running app picked the change up from settings.json', Boolean(followed));
    const btn = await until(async () => {
      const t = await app.text('#model-btn');
      return /anthropic\/claude-sonnet-4\.5/.test(t || '') ? t : null;
    });
    const tip = await app.evaluate(`document.querySelector('#model-btn').dataset.tip`);
    check('the model button shows the model and its tip the provider’s label', Boolean(btn) && /^OpenRouter · http:\/\/127\.0\.0\.1/.test(tip || ''), { btn, tip });
    c = await cfg();
    check('the window knows the key is set, from which variable, never its value', c.providerView.active.key === 'set' && c.providerView.active.keySource === 'MOCK_PROVIDER_KEY' && !JSON.stringify(c).includes(KEY));

    // --- A message through it ---
    mock.state.replies.push({ content: 'Hello from the OpenRouter-style provider.' });
    await app.send('Say hello');
    await app.waitIdle(60_000);
    const reply = await app.lastReply();
    const req = mock.state.requests.filter((q) => q.url === '/v1/chat/completions').pop();
    check('a message is answered through it', /Hello from the OpenRouter-style provider/.test(reply), reply);
    check('… with the key as bearer, the model, and OpenRouter’s attribution headers', req?.headers.authorization === `Bearer ${KEY}` && req.payload.model === 'anthropic/claude-sonnet-4.5' && req.headers['x-openrouter-title'] === 'Silo Harness' && req.headers['http-referer'] === 'https://github.com/BrandeisPatrick/silo-harness', req && { auth: Boolean(req.headers.authorization), model: req.payload.model });
    await app.screenshot(path.join(shots, 'chat-model-button-openrouter.png'));
    await app.screenshotOf(path.join(shots, 'chat-model-button-openrouter-detail.png'), '#model-btn', 24);

    // The model menu: the provider's models and the other providers
    await app.click('#model-btn');
    await until(() => app.evaluate(`[...document.querySelectorAll('.popover, .menu')].some((m) => /openai\\/gpt-5-mini/.test(m.innerText))`));
    const menuText = await app.evaluate(`[...document.querySelectorAll('.popover, .menu')].map((m) => m.innerText).join(' | ')`);
    check('the model menu lists the entry’s models under its label, and the other usable providers', /OpenRouter/.test(menuText) && /google\/gemini-3-pro/.test(menuText) && /LM Studio/.test(menuText) && !/Groq/.test(menuText), menuText);
    await sleep(500); // the menu fades in
    await app.screenshot(path.join(shots, 'chat-model-menu-openrouter.png'));
    await app.key('Escape');
    await sleep(200);

    // --- A broken key: the plain error ---
    mock.state.apiKey = 'a-different-key-0123456789';
    await app.send('Again');
    await app.waitIdle(60_000);
    const transcript = (await app.transcript()).map((e) => e.text).join('\n');
    check('a broken key gives the plain error, naming the provider and the variable', /OpenRouter refused the key \(HTTP 401\): Invalid API key \(mock\)/.test(transcript) && /MOCK_PROVIDER_KEY/.test(transcript), transcript.slice(-400));
    check('the key is nowhere in the window', !(await app.evaluate('document.documentElement.outerHTML')).includes(KEY));
    mock.state.apiKey = undefined;

    // --- Settings → Model with several providers; the one in use is owned by settings.json ---
    await open('model');
    const sel = await app.evaluate(`(() => { const s = document.querySelector('#provider'); return { value: s.value, disabled: s.disabled, options: [...s.options].map((o) => o.textContent) }; })()`);
    check('Settings → Model lists every provider and shows the one in use', sel.value === 'openrouter' && sel.options.length === 5 && sel.options.some((o) => /LM Studio/.test(o)) && sel.options.some((o) => /Groq/.test(o)), sel);
    check('… read-only, set in settings.json by the command', sel.disabled && (await app.exists('#sp-row-provider .sp-owned')));
    const visible = (id) => app.evaluate(`(() => { const e = document.querySelector('#sp-row-${id}'); return Boolean(e && e.offsetParent); })()`);
    check('the named provider’s rows show; the gateway’s and Ollama’s do not', (await visible('provider-service')) && (await visible('provider-model')) && !(await visible('portkey-apiKey')) && !(await visible('ollama-model')));
    const keyDesc = await app.text('#sp-row-provider-key .sp-row-desc');
    check('the key row says Set from MOCK_PROVIDER_KEY', /^Set from MOCK_PROVIDER_KEY/.test(keyDesc || ''), keyDesc);
    check('the model field holds the model', (await app.evaluate(`document.querySelector('#provider-model').value`)) === 'anthropic/claude-sonnet-4.5');
    await app.click('#sp-row-provider-service button');
    const tested = await until(async () => /answered with/.test((await app.text('#sp-row-provider-service .sp-row-desc')) || ''), 15_000);
    check('Test answers through the provider', Boolean(tested), await app.text('#sp-row-provider-service'));
    await app.screenshot(path.join(shots, 'settings-model-several-providers.png'));

    // The model from the window
    await app.fill('#provider-model', 'openai/gpt-5-mini');
    await app.key('Enter');
    const changed = await until(async () => (await cfg()).providerView.active.model === 'openai/gpt-5-mini');
    check('choosing a model in Settings applies at once', Boolean(changed) && /openai\/gpt-5-mini/.test((await app.text('#model-btn')) || ''));

    // --- The Model section switches providers once the file no longer chooses one ---
    r = await cli(['config', 'unset', 'provider']);
    await until(async () => !(await app.evaluate(`document.querySelector('#provider').disabled`)));
    // config.json still holds the gateway block as the choice
    await app.fill('#provider', 'lmstudio');
    const lm = await until(async () => (await cfg()).provider === 'lmstudio');
    check('the Model section switches to another provider', Boolean(lm) && (await visible('provider-service')) && /LM Studio/.test((await app.text('#sp-row-provider-service .sp-row-desc')) || ''));
    await app.fill('#provider', 'portkey');
    const pk = await until(async () => (await cfg()).provider === 'portkey');
    check('… and back to the gateway block, whose rows show again', Boolean(pk) && (await visible('portkey-apiKey')) && !(await visible('provider-service')));
    await app.fill('#provider', 'groq');
    await until(async () => (await cfg()).provider === 'groq');
    const groqKey = await app.text('#sp-row-provider-key .sp-row-desc');
    check('a provider without its key says which variable to set', /Not set\. Groq needs a key: set GROQ_API_KEY/.test(groqKey || ''), groqKey);
    await app.screenshot(path.join(shots, 'settings-model-key-missing.png'));
    await closeSettings();
    await app.evaluate(`document.querySelector('#new-chat-btn, #new-session-btn')?.click()`);
    await sleep(500);
    const strip = await app.evaluate(`document.querySelector('#setup-strip')?.innerText || ''`);
    check('the setup strip says the key is missing, with Settings at hand', /Groq needs a key/.test(strip) && /Open settings/.test(strip), strip);
    await open('model');
    await app.fill('#provider', 'openrouter');
    await until(async () => (await cfg()).provider === 'openrouter');
    // Back to a file-owned choice for the screenshot of an owned provider
    await cli(['provider', 'use', 'openrouter']);
    await until(() => app.evaluate(`document.querySelector('#provider').disabled`));
    await sleep(300);
    await app.screenshot(path.join(shots, 'settings-model-owned-by-settings-json.png'));

    // --- The Command line tool row ---
    await open('general');
    const cliDesc = await app.text('#sp-row-cli .sp-row-desc');
    check('the Command line tool row shows the command’s full path', /bin\/silo/.test(cliDesc || ''), cliDesc);
    await app.evaluate(`[...document.querySelectorAll('#sp-row-cli button')].find((b) => /Install/.test(b.innerText)).click()`);
    const linked = await until(() => fs.existsSync(path.join(linkDir, 'silo')));
    check('Install links it in the link folder', Boolean(linked) && fs.readlinkSync(path.join(linkDir, 'silo')).endsWith(path.join('bin', 'silo')));
    await until(async () => /Linked|not on your PATH/.test((await app.text('#sp-row-cli .sp-row-desc')) || ''));
    await app.screenshot(path.join(shots, 'settings-general-command-line-tool.png'));
    const viaLink = await new Promise((resolve) => {
      const child = spawn(path.join(linkDir, 'silo'), ['provider', 'list', '--json'], { env: { ...process.env, SILO_HARNESS_CONFIG_DIR: home, SILO_HARNESS_USER_DATA: profile } });
      let out = '';
      child.stdout.on('data', (x) => (out += x));
      child.on('close', (code) => resolve({ code, out }));
    });
    check('the linked command runs', viaLink.code === 0 && /"active": "openrouter"/.test(viaLink.out), viaLink.out.slice(0, 200));
    await app.evaluate(`[...document.querySelectorAll('#sp-row-cli button')].find((b) => /Remove/.test(b.innerText)).click()`);
    check('Remove takes the link away', Boolean(await until(() => !fs.existsSync(path.join(linkDir, 'silo')))));
    await closeSettings();
    check('no key in settings.json for a provider that reads a variable', !fs.readFileSync(userFile, 'utf8').includes(KEY));
    check('no entry from settings.json was written into config.json', !JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).providers?.openrouter);

    // --- The real API: a provider of type anthropic reading ANTHROPIC_API_KEY ---
    const realKey = process.env.ANTHROPIC_API_KEY || '';
    if (!realKey) {
      console.log('skip  the real-API checks (set ANTHROPIC_API_KEY)');
    } else {
      r = await cli(['provider', 'add', 'claude', '--type', 'anthropic', '--key-env', 'ANTHROPIC_API_KEY', '--model', LIVE_MODEL, '--context-window', '200000', '--use', '--json']);
      check('anthropic provider added with apiKeyEnv', r.code === 0 && r.json?.provider?.key === 'set' && r.json.provider.baseURL === 'https://api.anthropic.com/v1', r.json?.provider);
      r = await cli(['provider', 'test', 'claude']);
      check('silo provider test claude: ok with the model and the time', r.code === 0 && /^ok {2}Anthropic · claude-/.test(r.out), r.out + r.err);
      check('… and printed no key', !(r.out + r.err).includes(realKey));
      await until(async () => (await cfg()).providerView?.active?.name === 'claude');
      c = await cfg();
      check('the window follows to Anthropic', c.providerView.active.label === 'Anthropic' && !JSON.stringify(c).includes(realKey));
      await app.evaluate(`document.querySelector('#new-chat-btn, #new-session-btn')?.click()`);
      await sleep(400);
      await app.send('Reply with exactly the word: pong');
      await app.waitIdle(120_000);
      const real = await app.lastReply();
      check('a short real exchange through the anthropic provider', /pong/i.test(real), real);
      await app.screenshot(path.join(shots, 'chat-anthropic-real.png'));
      check('the real key was never written to disk', ![userFile, path.join(profile, 'config.json')].some((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(realKey)));
    }
  } catch (err) {
    check('no crash', false, err && err.stack);
    if (app) console.log(app.logs.slice(-30).join('\n'));
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(linkDir, { recursive: true, force: true });
  }
  done();
})();
