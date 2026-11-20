// Live check of Settings → Models in the real window, against two mock services (the gateway and an OpenRouter-style
// provider whose key comes from the shell), a provider without its key and an Ollama that is not running:
//   - one card: Provider (a picker of the providers set up, with a status), Model (a searchable picker and Test),
//     API key (dots and the last four, Replace, Remove), Connection (closed), Add provider; Advanced closed
//   - lists are asked for only once the page is on screen; nothing is tested on its own
//   - a key typed here is saved where the app reads it (the gateway's in the app's settings, owner-only), applies at
//     once, and never comes back to the window whole: not in its config, not in the page, not in an error
//   - a key from the shell is read-only; Remove takes a saved key away after a confirmation
//   - the model picker filters as you type, offers a typed id, and choosing writes the model; Test sends one request to
//     exactly that model and shows "Answered in …" or the plain error
//   - Add provider writes the entry and its key to your settings.json (600) and puts it in use; Remove takes it out
//   - Advanced: Think before acting only where it applies (found by search elsewhere), the safety check's model with
//     a Test whose result is one line and the eval caution only for another model than Claude Haiku 5.5
//   - every old row id lands on the row that holds its setting now; search finds the rows by their old words
// Never a real model: both services are the mock model. Run: npm run build && node test/live/models-page.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');
const { startMock, classifierReply } = require('../support/mock-model.js');

const OR_KEY = 'mock-or-key-0123456789';
const GW_KEY = 'gw-SECRET-key-0123456789wxyz';
const LOCAL_KEY = 'local-SECRET-key-0123456789';

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const gw = await startMock();
  gw.state.models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  // The gateway checks its key: the list answers only once the right one is saved
  gw.state.apiKey = GW_KEY;
  const or = await startMock();
  or.state.apiKey = OR_KEY;
  or.state.models = [...Array.from({ length: 120 }, (_, i) => `vendor-${i % 5}/model-${i}`), 'anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5'];
  let app;
  try {
    app = await launch({
      mock: true,
      scale: 1,
      size: { width: 1440, height: 1000 },
      // The gateway starts without a key; OpenRouter's comes from the shell
      env: { MOCK_OR_KEY: OR_KEY, GROQ_API_KEY: '', PORTKEY_API_KEY: '' },
      config: {
        ollama: { baseURL: 'http://127.0.0.1:9/v1', model: '', numCtx: 16384, think: 'auto' },
        portkey: { baseURL: `http://127.0.0.1:${gw.port}/v1`, apiKey: '', model: 'claude-opus-5-5', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
        providers: {
          openrouter: { type: 'openrouter', baseURL: `http://127.0.0.1:${or.port}/v1`, apiKeyEnv: 'MOCK_OR_KEY', model: 'anthropic/claude-sonnet-5.5' },
          groq: { type: 'groq', model: 'llama-3.3-70b-versatile' },
        },
      },
    });
    const userSettings = path.join(app.profile, 'home-config', 'settings.json');
    const configFile = path.join(app.profile, 'config.json');
    const cfg = () => app.evaluate('window.oc.getConfig()');
    const until = async (fn, ms = 8000) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn().catch(() => null);
        if (v || Date.now() > end) return v;
        await sleep(120);
      }
    };
    const chats = (mock) => mock.state.requests.filter((q) => q.url === '/v1/chat/completions');
    const lists = (mock) => mock.state.requests.filter((q) => q.url === '/v1/models');
    const status = () => app.evaluate(`document.querySelector('#sp-row-provider .sp-status')?.innerText.trim() ?? ''`);
    const desc = (row) => app.evaluate(`(() => { const d = document.querySelector('#sp-row-${row} > .sp-row-text > .sp-row-desc'); return d && !d.hidden ? d.textContent : ''; })()`);
    const shown = (sel) => app.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return Boolean(e && e.offsetParent !== null && !e.hidden); })()`);
    const options = () => app.evaluate(`[...document.querySelectorAll('.sp-picker-pop .sp-picker-item')].map((o) => o.innerText.trim().replace(/\\s+/g, ' '))`);
    const pickOption = (text) => app.evaluate(`(() => { const o = [...document.querySelectorAll('.sp-picker-pop .sp-picker-item')].find((x) => x.title === ${JSON.stringify(text)} || x.innerText.trim().startsWith(${JSON.stringify(text)})); if (!o) return false; o.click(); return true; })()`);
    const typeIn = (q) => app.evaluate(`(() => { const i = document.querySelector('.sp-picker-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); return true; })()`);
    const confirmYes = async () => {
      await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000, 'the confirmation');
      await app.click('#confirm-ok');
    };
    const noWholeKey = async (key) => {
      const winCfg = JSON.stringify(await cfg());
      const page = await app.evaluate(`document.documentElement.outerHTML + [...document.querySelectorAll('input')].map((i) => i.value).join(' ')`);
      return !winCfg.includes(key) && !page.includes(key);
    };

    // --- The page ---
    await app.evaluate(`document.querySelector('#settings-btn').click()`);
    await sleep(1000);
    const openedAt = await app.evaluate(`document.querySelector('.sp-nav-item.active')?.dataset.section`);
    check('Settings opened at another page asks no provider for its list', openedAt !== 'model' && lists(gw).length === 0 && lists(or).length === 0, { openedAt, gw: lists(gw).length, or: lists(or).length });
    await app.click('#sp-nav-model');
    await sleep(600);
    const card = await app.evaluate(`[...document.querySelector('#sp-sec-model .sp-card').children].map((c) => c.dataset.row || (c.classList.contains('sp-advanced') ? 'connection' : c.id || c.className))`);
    check('one card: Provider, Model, API key, Connection, Add provider (and the closed form)', card.slice(0, 5).join() === 'provider,provider-model,provider-apiKey,connection,provider-add', card);
    check('Connection and Advanced are closed', !(await app.evaluate(`document.querySelector('#sp-sec-model .sp-connection').classList.contains('open')`)) && !(await app.evaluate(`document.querySelector('#sp-sec-model .sp-page-advanced').classList.contains('open')`)));
    check('the old groups are gone: no In use, Connected or per-model rows', !(await app.exists('#sp-sec-model .sp-provider')) && !(await app.exists('#sp-sec-model .sp-model')));

    // --- The gateway without its key ---
    check('the gateway without its key: "No key", and where it goes', (await status()) === 'No key' && (await desc('provider')) === 'Paste its key under API key.', { s: await status(), d: await desc('provider') });
    check('… the key field is open, Test is off', (await shown('#provider-apiKey-input')) && (await app.evaluate(`document.querySelector('#sp-row-provider-model .sp-pair-side .btn').disabled`)));
    check('… and nothing was asked of it without a key', lists(gw).length === 0);
    await app.screenshot(path.join(shots, 'models-no-key.png'));

    // --- Saving a key ---
    await app.fill('#provider-apiKey-input', GW_KEY);
    await app.click('#sp-row-provider-apiKey .btn.primary');
    const ready = await until(async () => (await status()) === 'Ready', 8000);
    check('Save: the key applies at once, the gateway lists its models with it and is Ready', Boolean(ready) && lists(gw).length >= 1, await status());
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    check('… it is saved in the app’s settings (config.json), the file owner-only', saved.portkey?.apiKey === GW_KEY && (fs.statSync(configFile).mode & 0o777) === 0o600, (fs.statSync(configFile).mode & 0o777).toString(8));
    const boxText = await app.text('#sp-row-provider-apiKey .sp-key-box');
    check('… the row shows dots and the last four, and where it is kept', boxText === '••••••••wxyz' && (await desc('provider-apiKey')) === 'Saved in your settings', { boxText, d: await desc('provider-apiKey') });
    check('… and the window never has the whole key: not its config, not the page, not the field', await noWholeKey(GW_KEY));
    await app.screenshot(path.join(shots, 'models-key-saved.png'));

    // --- The Provider picker: the ones set up, each with its status ---
    await app.click('#provider');
    await sleep(300);
    let opts = await options();
    check('the Provider picker lists the providers set up: not Groq (no key), not Ollama (not running)', opts.length === 2 && opts.some((o) => o.startsWith('Gateway')) && opts.some((o) => o.startsWith('OpenRouter')) && !opts.some((o) => /Groq|Ollama/.test(o)), opts);
    await app.key('Escape');
    check('Escape closes the list, not Settings', !(await app.exists('.sp-picker-pop')) && (await app.evaluate(`document.querySelector('#settings').open`)));

    // --- The Model picker ---
    await app.click('#provider-model');
    await sleep(300);
    opts = await options();
    check('the Model picker: the gateway’s models, the one in use marked', opts.length === 3 && opts[0] === 'claude-opus-5-5 In use', opts);
    await typeIn('haiku');
    await sleep(100);
    opts = await options();
    check('… filters as you type (what was typed comes after the matches)', opts.length === 2 && opts[0] === 'claude-haiku-5-5' && opts[1] === 'haiku Use as typed', opts);
    await typeIn('my-own-model-id');
    await sleep(100);
    opts = await options();
    check('… and offers an id it does not list, as typed', opts[0] === 'my-own-model-id Use as typed', opts);
    await typeIn('haiku');
    await sleep(100);
    check('choosing a model: a click', await pickOption('claude-haiku-5-5'));
    check('… writes it', Boolean(await until(async () => (await cfg()).portkey.model === 'claude-haiku-5-5')));
    check('… and no model was called', chats(gw).length === 0 && chats(or).length === 0);

    // --- Test: one request to exactly that model ---
    await app.click('#sp-row-provider-model .sp-pair-side .btn');
    const answered = await until(async () => /^Answered in \d/.test((await app.text('#sp-row-provider-model .sp-row-result')) || ''), 10_000);
    check('Test: one request to exactly the model in use, "Answered in …"', Boolean(answered) && chats(gw).length === 1 && chats(gw)[0].payload.model === 'claude-haiku-5-5', await app.text('#sp-row-provider-model .sp-row-result'));
    gw.state.replies.push({ nonStream: true, status: 401, error: `invalid key ${GW_KEY}` });
    await app.click('#sp-row-provider-model .sp-pair-side .btn');
    const failed = await until(async () => /refused the key/.test((await app.text('#sp-row-provider-model .sp-row-result')) || ''), 10_000);
    const failText = (await app.text('#sp-row-provider-model .sp-row-result')) || '';
    check('… a refusal: the plain error under the row, without the key', Boolean(failed) && !failText.includes(GW_KEY) && failText.includes('…'), failText);
    await app.screenshot(path.join(shots, 'models-test-failed.png'));

    // --- Replace, then Remove ---
    await app.click('#sp-row-provider-apiKey .sp-pair-side .btn:not(.primary)');
    check('Replace opens an empty field', (await shown('#provider-apiKey-input')) && (await app.evaluate(`document.querySelector('#provider-apiKey-input').value`)) === '');
    await app.evaluate(`document.querySelector('#provider-apiKey-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    check('… Escape puts the key back as it was', !(await shown('#provider-apiKey-input')) && (await app.text('#sp-row-provider-apiKey .sp-key-box')) === '••••••••wxyz');
    await app.click('#sp-row-provider-apiKey button[aria-label="Remove the key"]');
    await confirmYes();
    const removed = await until(async () => JSON.parse(fs.readFileSync(configFile, 'utf8')).portkey?.apiKey === '' && (await status()) === 'No key');
    check('Remove (after a confirmation) takes the saved key away', Boolean(removed), await status());
    await app.fill('#provider-apiKey-input', GW_KEY);
    await app.evaluate(`document.querySelector('#provider-apiKey-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    check('Enter saves a key too', Boolean(await until(async () => (await status()) === 'Ready')));

    // --- A key from the shell is read-only ---
    await app.click('#provider');
    await sleep(200);
    await pickOption('OpenRouter');
    const onOr = await until(async () => (await cfg()).provider === 'openrouter' && (await status()) === 'Ready', 8000);
    check('choosing OpenRouter puts it in use; its list comes with the key from the shell', Boolean(onOr), await status());
    check('… its key: the last four, "From your shell", no Replace and no Remove', (await app.text('#sp-row-provider-apiKey .sp-key-box')) === '••••••••6789' && (await desc('provider-apiKey')) === 'From your shell' && !(await shown('#sp-row-provider-apiKey .sp-pair-side .btn')) && !(await shown('#sp-row-provider-apiKey button[aria-label="Remove the key"]')));
    await app.click('#provider-model');
    await sleep(300);
    opts = await options();
    check('a long list shows fifty, and says how many more', opts.length === 50 && /72 more\. Type to narrow\./.test((await app.text('.sp-picker-foot')) || ''), { n: opts.length, foot: await app.text('.sp-picker-foot') });
    await app.key('Escape');

    // --- Add provider, then remove it ---
    gw.state.apiKey = '';
    await app.click('#sp-row-provider-add button');
    check('Add provider opens a short form', await shown('#provider-add-form'));
    await app.evaluate(`(() => { const s = document.querySelector('#provider-add-type'); s.value = 'openai-compatible'; s.dispatchEvent(new Event('change')); })()`);
    check('… OpenAI-compatible asks for its base URL; the name is suggested', (await shown('#provider-add-url')) && (await app.evaluate(`document.querySelector('#provider-add-name').value`)) === 'custom');
    await app.screenshot(path.join(shots, 'models-add-provider.png'));
    await app.fill('#provider-add-name', 'local2');
    await app.fill('#provider-add-key', LOCAL_KEY);
    await app.fill('#provider-add-url', `http://127.0.0.1:${gw.port}/v1`);
    await app.click('#provider-add-form .btn.primary');
    const added = await until(async () => (await cfg()).provider === 'local2' && fs.existsSync(userSettings), 8000);
    const us = added ? JSON.parse(fs.readFileSync(userSettings, 'utf8')) : {};
    check('Add: the entry and its key go in your settings.json, and it is in use', Boolean(added) && us.providers?.local2?.type === 'openai-compatible' && us.providers.local2.apiKey === LOCAL_KEY, us.providers);
    check('… that file is owner-only (600)', (fs.statSync(userSettings).mode & 0o777) === 0o600);
    check('… the form is closed and forgot the key; the window never had it back', !(await shown('#provider-add-form')) && (await noWholeKey(LOCAL_KEY)));
    await until(async () => (await status()) === 'Ready');
    await app.click('#provider-model');
    await sleep(300);
    await pickOption('claude-sonnet-5-5');
    check('choosing its model writes it in your settings.json', Boolean(await until(async () => JSON.parse(fs.readFileSync(userSettings, 'utf8')).providers.local2.model === 'claude-sonnet-5-5')));
    await app.click('#sp-sec-model .sp-connection .sp-disclosure');
    check('Connection shows its address and a Remove for a provider you added', (await desc('provider-baseURL')) === `http://127.0.0.1:${gw.port}/v1` && (await shown('#sp-row-provider-remove')));
    await app.click('#sp-row-provider-remove button');
    await confirmYes();
    const gone = await until(async () => !('local2' in (JSON.parse(fs.readFileSync(userSettings, 'utf8')).providers ?? {})) && (await cfg()).provider !== 'local2');
    check('Remove (after a confirmation) takes it out of your settings.json; another provider takes its place', Boolean(gone), (await cfg()).provider);
    await app.click('#sp-sec-model .sp-connection .sp-disclosure');

    // --- Back on the gateway: Connection's rows are the gateway's ---
    await app.click('#provider');
    await sleep(200);
    await pickOption('Gateway');
    await until(async () => (await cfg()).provider === 'portkey');
    await app.click('#sp-sec-model .sp-connection .sp-disclosure');
    check('Connection on the gateway: its address and routing, not Ollama’s', (await shown('#sp-row-portkey-baseURL')) && (await shown('#sp-row-portkey-virtualKey')) && !(await shown('#sp-row-ollama-numCtx')));
    await app.click('#sp-sec-model .sp-connection .sp-disclosure');

    // --- Advanced ---
    await app.click('#sp-sec-model .sp-page-advanced .sp-disclosure');
    check('Advanced: Think before acting does not show on the gateway (it does not apply there)', !(await shown('#sp-row-thinking')) && (await shown('#sp-row-autoMode-model')) && (await shown('#sp-row-autoCompact')));
    const setCheck = (v) => app.evaluate(`(() => { const s = document.querySelector('#autoMode-model'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
    await setCheck('portkey:claude-opus-5-5');
    const caution = await until(async () => (await desc('autoMode-model')) === 'Only Claude Haiku 5.5 has passed the eval.');
    check('the safety check on another model than Claude Haiku 5.5: the eval caution', Boolean(caution) && (await cfg()).autoMode.model === 'portkey:claude-opus-5-5', await desc('autoMode-model'));
    await setCheck('portkey:claude-haiku-5-5');
    check('… on Claude Haiku 5.5: no caution', Boolean(await until(async () => (await desc('autoMode-model')) === '')));
    const { checkTestItems } = require(path.join(app.root, 'dist', 'main', 'agent', 'check-test.js'));
    const set = checkTestItems();
    const before = chats(gw).length;
    for (const it of set) gw.state.replies.push(classifierReply(it.id === 'force-push-main' ? 'allow' : it.label, `[Eval] ${it.id}`, { delayMs: 40 }));
    check('… its Test says beforehand what it sends', /^Sends 24 made-up actions/.test(await app.evaluate(`document.querySelector('#sp-row-autoMode-model .sp-row-control > .btn').title`)));
    await app.click('#sp-row-autoMode-model .sp-row-control > .btn');
    const line = await until(async () => {
      const t = (await app.text('#sp-row-autoMode-model .sp-row-result')) || '';
      return (await shown('#sp-row-autoMode-model .sp-row-result')) && t ? t : null;
    }, 20_000);
    const sent = chats(gw).slice(before);
    check('… its result in one line: what it got right and what it let through', line === '23 of 24 right, let 1 risky action through', line);
    check('… after exactly 24 checks to the chosen model', sent.length === 24 && sent.every((q) => q.payload.model === 'claude-haiku-5-5'), sent.length);
    await app.screenshot(path.join(shots, 'models-advanced.png'));

    // --- Search: the old words still find the rows; a hit in a closed Advanced opens it ---
    await app.click('#sp-sec-model .sp-page-advanced .sp-disclosure');
    const search = async (q) => {
      await app.fill('#settings-search', q);
      await sleep(150);
      return app.evaluate(`[...document.querySelectorAll('#sp-sec-model .sp-row.hit')].filter((r) => r.offsetParent !== null).map((r) => r.dataset.row)`);
    };
    let hits = await search('virtual key');
    check('search "virtual key" finds the gateway row', hits.includes('portkey-virtualKey'), hits);
    hits = await search('context size');
    check('search "context size" finds Ollama’s row', hits.includes('ollama-numCtx'), hits);
    hits = await search('key');
    check('search "key" finds the API key and the gateway’s provider key', ['provider-apiKey', 'portkey-providerApiKey'].every((id) => hits.includes(id)), hits);
    hits = await search('reasoning');
    check('search "reasoning" finds Think before acting, with the line that says where it applies', hits.includes('thinking') && (await desc('thinking')) === "Only for Anthropic's own API.", hits);
    hits = await search('more providers');
    check('search "more providers" finds Add provider', hits.includes('provider-add'), hits);
    hits = await search('auto-compact');
    check('search "auto-compact" finds the row in the closed Advanced', hits.includes('autoCompact'), hits);
    await app.key('Enter');
    await sleep(300);
    check('… Enter goes to it and opens Advanced', (await app.evaluate(`document.querySelector('#sp-sec-model .sp-page-advanced').classList.contains('open')`)) && (await app.evaluate(`document.querySelector('#settings-search').value`)) === '');
    await app.click('#sp-sec-model .sp-page-advanced .sp-disclosure');

    // --- Old targets land on the row that holds the setting now ---
    const land = async (target) => {
      await app.evaluate(`window.__oc_debug.settings.open(${JSON.stringify(target)})`);
      await sleep(250);
      const s = await app.evaluate('window.__oc_debug.settings.state()');
      const visible = await shown(`#sp-row-${s.revealed}`);
      return { section: s.section, row: s.revealed, visible };
    };
    for (const [target, row] of [
      ['portkey-apiKey', 'provider-apiKey'],
      ['provider-key', 'provider-apiKey'],
      ['ollama-model', 'provider-model'],
      ['portkey-model', 'provider-model'],
      ['provider-service', 'provider'],
      ['provider-files', 'provider-add'],
      ['autoMode-checkTest', 'autoMode-model'],
      ['portkey-contextWindow', 'portkey-contextWindow'],
      ['ollama-fields', 'provider'],
      ['context', 'autoCompact'],
    ]) {
      const at = await land(target);
      check(`openSettings('${target}') lands on Models, row ${row}, on screen`, at.section === 'model' && at.row === row && at.visible, at);
    }
    check("… a row inside Connection opens it", await app.evaluate(`document.querySelector('#sp-sec-model .sp-connection').classList.contains('open')`));

    // --- On Anthropic's own API (an entry of your settings.json, here the gateway's mock): Think before acting shows ---
    fs.writeFileSync(userSettings, JSON.stringify({ provider: 'claude', providers: { claude: { type: 'anthropic', baseURL: `http://127.0.0.1:${gw.port}/v1`, apiKey: 'sk-mock-thinking-0123456789', model: 'claude-haiku-5-5' } } }));
    await app.evaluate(`window.oc.rpc('settings.reload')`);
    await app.evaluate(`window.__oc_debug.settings.open('thinking')`);
    const nativeLine = await until(async () => (await shown('#sp-row-thinking')) && (await desc('thinking')) === 'Reasons first, as Claude Code does.');
    check("Think before acting on Anthropic's own API: shown, with what it does", Boolean(nativeLine), await desc('thinking'));
    check('… the Provider picker is not locked by your own settings.json (the app writes it there)', !(await app.evaluate(`document.querySelector('#provider').disabled`)) && !(await app.exists('#sp-row-provider .sp-lock')));
  } catch (err) {
    check(`no crash: ${err.message}`, false);
  } finally {
    await app?.close();
    gw.close();
    or.close();
  }
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})();
