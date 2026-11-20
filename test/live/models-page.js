// Live check of Settings → Models in the real window, against two mock services (a gateway and an OpenRouter-style
// provider with a long list), a provider without its key and an Ollama that is not running:
//   - the page is called Models; In use, Connected and Connection are there, every older row and its search words too
//   - Connected has a group per provider, the one in use first, each with its state in plain words and its models
//     (asked once when the page opens; nothing is tested on its own); a long list shows eight, a filter and Show all
//   - Test on a row sends one small request to exactly that model through that provider and shows the result on the
//     row ("Answered in … ms" or the plain error, never the key); Use makes a model of another provider the one in use
//   - Safety check: says what the check runs on now; picking a connected model writes "<provider>:<model>"; "Test as
//     safety check" says how many requests it sends, runs the 24 actions through the check (the mock answers each with
//     its label, one flipped), shows its progress, the result in plain words, and stops on Cancel
// Never a real model: both services are the mock model. Run: npm run build && node test/live/models-page.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');
const { startMock } = require('../support/mock-model.js');

const OR_KEY = 'mock-or-key-0123456789';

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const gw = await startMock();
  gw.state.models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  const or = await startMock();
  or.state.apiKey = OR_KEY;
  or.state.models = [...Array.from({ length: 40 }, (_, i) => `vendor-${i % 5}/model-${i}`), 'anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5'];
  let app;
  try {
    app = await launch({
      mock: true,
      scale: 1,
      size: { width: 1440, height: 1000 },
      env: { MOCK_OR_KEY: OR_KEY, GROQ_API_KEY: '' },
      config: {
        ollama: { baseURL: 'http://127.0.0.1:9/v1', model: '', numCtx: 16384, think: 'auto' },
        portkey: { baseURL: `http://127.0.0.1:${gw.port}/v1`, apiKey: '', model: 'claude-opus-5-5', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
        providers: {
          openrouter: { type: 'openrouter', baseURL: `http://127.0.0.1:${or.port}/v1`, apiKeyEnv: 'MOCK_OR_KEY', model: 'anthropic/claude-sonnet-5.5' },
          groq: { type: 'groq', model: 'llama-3.3-70b-versatile' },
        },
      },
    });
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
    const group = (name) => `.sp-provider[data-provider-name="${name}"]`;
    const groupText = (name) => app.evaluate(`document.querySelector(${JSON.stringify(group(name))})?.innerText ?? ''`);
    const rowSel = (name, model) => `${group(name)} .sp-model[data-model=${JSON.stringify(model)}]`;
    const rowText = (name, model) => app.evaluate(`document.querySelector(${JSON.stringify(rowSel(name, model))})?.innerText ?? ''`);
    const clickIn = (sel, label) => app.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${sel} button`)})].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);

    // --- The page ---
    await app.evaluate(`document.querySelector('#settings-btn').click()`);
    await sleep(1200);
    const openedAt = await app.evaluate(`document.querySelector('.sp-nav-item.active')?.dataset.section`);
    check('Settings opened at another section asks no provider for its list', openedAt !== 'model' && lists(gw).length === 0 && lists(or).length === 0, { openedAt, gw: lists(gw).length, or: lists(or).length });
    await app.click('#sp-nav-model');
    const navLabel = await app.text('#sp-nav-model');
    const title = await app.text('#sp-sec-model .sp-title');
    check('the section is called Models (its id is still model)', navLabel?.trim() === 'Models' && title === 'Models', { navLabel, title });
    const groups = await app.evaluate(`[...document.querySelectorAll('#sp-sec-model .sp-group-title')].map((e) => e.textContent)`);
    check('In use, Connected and Connection, in that order', groups.join() === 'In use,Connected,Connection', groups);
    const inUseRows = await app.evaluate(`[...document.querySelector('#sp-sec-model .sp-group').querySelectorAll('.sp-row')].map((r) => r.dataset.row)`);
    check('In use holds the provider and the model fields', ['provider', 'ollama-model', 'portkey-model', 'provider-model'].every((id) => inUseRows.includes(id)), inUseRows);
    const ids = ['provider', 'ollama-baseURL', 'ollama-model', 'ollama-numCtx', 'ollama-think', 'portkey-baseURL', 'portkey-apiKey', 'portkey-model', 'portkey-contextWindow', 'portkey-virtualKey', 'portkey-provider', 'portkey-providerApiKey', 'portkey-configId', 'provider-service', 'provider-key', 'provider-model', 'provider-contextWindow', 'provider-files'];
    const missing = await app.evaluate(`${JSON.stringify(ids)}.filter((id) => !document.querySelector('#sp-sec-model #sp-row-' + id))`);
    check('every row the section had is still there, under its id', missing.length === 0, missing);

    // --- Connected: a group per provider, the one in use first ---
    await app.waitFor(`document.querySelectorAll('#sp-sec-model .sp-provider').length === 4 && !document.querySelector('#sp-sec-model').innerText.includes('Checking…')`, 15_000, 'the four groups');
    const order = await app.evaluate(`[...document.querySelectorAll('#sp-sec-model .sp-provider')].map((g) => g.dataset.providerName)`);
    check('one group per provider, the one in use first', order.join() === 'portkey,ollama,openrouter,groq', order);
    const gwText = await groupText('portkey');
    check('the gateway: "Through Gateway", ready, its three models, the one in use marked', /^Through Gateway\s+Ready/.test(gwText) && /3 models offered/.test(gwText) && (await rowText('portkey', 'claude-opus-5-5')).includes('In use') && (await app.count(`${group('portkey')} .sp-model`)) === 3, gwText);
    const olText = await groupText('ollama');
    check('Ollama: not reachable, in plain words', /Through Ollama\s+Not reachable/.test(olText) && /Could not reach Ollama at http:\/\/127\.0\.0\.1:9\/v1\. Is Ollama running\?/.test(olText), olText);
    const orText = await groupText('openrouter');
    check('OpenRouter: ready, 42 models, eight shown, a filter and Show all 42', /Through OpenRouter\s+Ready/.test(orText) && /42 models offered/.test(orText) && (await app.count(`${group('openrouter')} .sp-model`)) === 8 && (await app.exists(`${group('openrouter')} input.sp-models-filter`)) && /Show all 42/.test(orText), orText.slice(0, 300));
    const grText = await groupText('groq');
    check('Groq: no key found, naming the variable; its model shows, its Test is off', /Through Groq\s+No key found/.test(grText) && /GROQ_API_KEY/.test(grText) && (await app.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${rowSel('groq', 'llama-3.3-70b-versatile')} button`)})].every((b) => b.disabled)`)), grText);
    check('the lists were asked for once each when the page opened, and no model was called', lists(gw).length === 1 && lists(or).length === 1 && chats(gw).length === 0 && chats(or).length === 0, { gwLists: lists(gw).length, orLists: lists(or).length, gwChats: chats(gw).length, orChats: chats(or).length });
    await app.screenshot(path.join(shots, 'models-page.png'));

    // A long list: the filter, Show all, Show fewer
    await app.fill(`${group('openrouter')} input.sp-models-filter`, 'haiku');
    const filtered = await app.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${group('openrouter')} .sp-model`)})].map((r) => r.dataset.model)`);
    check('the filter narrows the list as you type', filtered.join() === 'anthropic/claude-haiku-5.5', filtered);
    check('… and keeps the focus in the field', await app.evaluate(`document.activeElement?.classList.contains('sp-models-filter')`));
    await app.fill(`${group('openrouter')} input.sp-models-filter`, '');
    await app.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${group('openrouter')} .sp-models-more`)})][0].click()`);
    const all = await app.count(`${group('openrouter')} .sp-model`);
    await app.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${group('openrouter')} .sp-models-more`)})][0].click()`);
    check('Show all shows the 42, Show fewer eight again', all === 42 && (await app.count(`${group('openrouter')} .sp-model`)) === 8, all);

    // --- Test: one request to exactly that model, only on a click ---
    check('Test: a click', await clickIn(rowSel('portkey', 'claude-haiku-5-5'), 'Test'));
    const answered = await until(async () => /Answered in \d+(\.\d)? (ms|s)/.test(await rowText('portkey', 'claude-haiku-5-5')));
    const sent = chats(gw);
    check('… shows "Answered in … ms" on the row', Boolean(answered), await rowText('portkey', 'claude-haiku-5-5'));
    check('… after one request to exactly that model through that provider, none elsewhere', sent.length === 1 && sent[0].payload.model === 'claude-haiku-5-5' && sent[0].payload.max_tokens === 16 && chats(or).length === 0, sent.map((q) => q.payload.model));
    check('… and leaves the model in use as it was', (await cfg()).portkey.model === 'claude-opus-5-5');
    await sleep(1500);
    check('nothing tests again on its own', chats(gw).length === 1 && chats(or).length === 0);
    await app.evaluate(`document.querySelector(${JSON.stringify(rowSel('portkey', 'claude-haiku-5-5'))}).scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await app.screenshot(path.join(shots, 'models-row-tested.png'));

    // A refusal: the plain error on the row, never the key
    or.state.replies.push({ nonStream: true, status: 401, error: `invalid key ${OR_KEY}` });
    await clickIn(rowSel('openrouter', 'anthropic/claude-haiku-5.5'), 'Test');
    const refused = await until(async () => /refused the key \(HTTP 401\)/.test(await rowText('openrouter', 'anthropic/claude-haiku-5.5')));
    check('a refused test shows the plain error on its row', Boolean(refused), await rowText('openrouter', 'anthropic/claude-haiku-5.5'));
    check('… with the key as bearer, and the key nowhere in the window', chats(or).pop()?.headers.authorization === `Bearer ${OR_KEY}` && !(await app.evaluate('document.documentElement.outerHTML')).includes(OR_KEY));

    // --- The safety check's model ---
    const checkDesc = () => app.text('#sp-row-autoMode-model .sp-row-desc');
    check('Safety check sits under In use, and says what the check runs on now', (await app.evaluate(`Boolean(document.querySelector('#sp-sec-model .sp-group #sp-row-autoMode-model'))`)) && (await checkDesc()) === "Runs on Claude Opus 5.5 through Gateway, the session's model.", await checkDesc());
    check('… with the line on which model passed the eval', /Only Claude Haiku 5\.5 on Anthropic's own API has passed the app's check eval\. Another model may judge worse\./.test((await app.text('#sp-row-autoMode-model')) || ''));
    const opts = await app.evaluate(`[...document.querySelector('#autoMode-model').options].map((o) => ({ v: o.value, l: o.textContent, g: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '' }))`);
    check('the select: "Same as the session", then every connected model as <provider>:<model>, under "Through …"', opts[0].v === '' && opts[0].l === 'Same as the session' && opts.some((o) => o.v === 'portkey:claude-haiku-5-5' && o.g === 'Through Gateway') && opts.some((o) => o.v === 'openrouter:anthropic/claude-haiku-5.5' && o.g === 'Through OpenRouter') && opts.filter((o) => o.g === 'Through OpenRouter').length === 42 && !opts.some((o) => o.v.startsWith('groq:')), opts.slice(0, 6));
    check('… set to Same as the session, as autoMode.model is empty', (await app.evaluate(`document.querySelector('#autoMode-model').value`)) === '' && (await cfg()).autoMode.model === '');
    await app.fill('#autoMode-model', 'portkey:claude-haiku-5-5');
    const picked = await until(async () => (await cfg()).autoMode.model === 'portkey:claude-haiku-5-5' && (await checkDesc()) === 'Runs on Claude Haiku 5.5 through Gateway.');
    check('picking a model writes "<provider>:<model>" and the line follows', Boolean(picked), await checkDesc());
    const marked = await until(async () => (await rowText('portkey', 'claude-haiku-5-5')).includes('Safety check') && !(await rowText('portkey', 'claude-opus-5-5')).includes('Safety check'));
    check('… and that model’s row carries the Safety check mark', Boolean(marked), await rowText('portkey', 'claude-haiku-5-5'));
    await app.evaluate(`document.querySelector('#sp-row-autoMode-model').scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await app.screenshot(path.join(shots, 'models-check-select.png'));

    // --- Test as safety check: says what it sends, then the mock answers each action with its label, one flipped ---
    const { checkTestItems } = require(path.join(app.root, 'dist', 'main', 'agent', 'check-test.js'));
    const set = checkTestItems();
    const plan = await app.text('#sp-row-autoMode-checkTest .sp-row-desc');
    const checksBefore = chats(gw).length;
    check('the test says beforehand how many requests it sends, and to which model', plan === 'Sends 24 made-up actions to Claude Haiku 5.5, one request each, and scores how it judges them.', plan);
    check('… and sends nothing until clicked', chats(gw).length === checksBefore);
    const { classifierReply } = require('../support/mock-model.js');
    for (const it of set) gw.state.replies.push(classifierReply(it.id === 'force-push-main' ? 'allow' : it.label, `[Eval] ${it.id}`, { delayMs: 60 }));
    check('Run test: a click', await clickIn('#sp-row-autoMode-checkTest', 'Run test'));
    const progress = await until(async () => /^Checking \d+ of 24…$/.test((await app.text('#sp-row-autoMode-checkTest .sp-row-desc')) || ''), 4000);
    check('… shows its progress, with a Cancel', Boolean(progress) && (await app.evaluate(`[...document.querySelectorAll('#sp-row-autoMode-checkTest button')].some((b) => !b.hidden && b.innerText.trim() === 'Cancel')`)));
    const finished = await until(async () => /Judged/.test((await app.text('#sp-row-autoMode-checkTest .sp-check-result')) || ''), 20_000);
    const result = (await app.text('#sp-row-autoMode-checkTest .sp-check-result')) || '';
    check('… then the result in plain words: judged right, what it let through and that it matters, wrong blocks, the time', Boolean(finished) && /Judged 23 of 24 right\./.test(result) && /Let 1 of 18 risky actions through: git push --force origin main\. This is the failure that matters/.test(result) && /Blocked no safe action\./.test(result) && /Median answer time \d+ ms\./.test(result) && /Tested on Gateway · claude-haiku-5-5\./.test(result), result);
    const sentChecks = chats(gw).slice(checksBefore);
    check('… after exactly 24 checks through the gateway, to the chosen model', sentChecks.length === 24 && sentChecks.every((q) => q.payload.model === 'claude-haiku-5-5' && /safety check of Auto mode/.test(JSON.stringify(q.payload.messages[0]))), sentChecks.length);
    const sys = sentChecks[0]?.payload.messages[0];
    const lastPart = (m) => (Array.isArray(m.content) ? m.content[m.content.length - 1] : { text: m.content });
    check('… each with its instructions marked for the gateway’s cache, the part that changes never', sentChecks.every((q) => Array.isArray(q.payload.messages[0].content) && q.payload.messages[0].content[0].cache_control?.type === 'ephemeral' && !('cache_control' in lastPart(q.payload.messages[1])) && !('cache_control' in q.payload)), sys && { role: sys.role, parts: Array.isArray(sys.content) ? sys.content.length : 'string' });
    check('… and the stable start of a case with notes is marked too (notes-allow-staging)', sentChecks.some((q) => Array.isArray(q.payload.messages[1].content) && q.payload.messages[1].content[0].cache_control?.type === 'ephemeral' && /<\/user_notes>/.test(q.payload.messages[1].content[0].text)));
    check('… and the plan is back, the button too', /^Sends 24/.test((await app.text('#sp-row-autoMode-checkTest .sp-row-desc')) || '') && (await app.evaluate(`[...document.querySelectorAll('#sp-row-autoMode-checkTest button')].some((b) => !b.hidden && b.innerText.trim() === 'Run test')`)));
    await app.evaluate(`document.querySelector('#sp-row-autoMode-checkTest').scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await app.screenshot(path.join(shots, 'models-check-test.png'));

    // Cancel part way
    for (const it of set) gw.state.replies.push(classifierReply(it.label, '', { delayMs: 150 }));
    const beforeCancel = chats(gw).length;
    await clickIn('#sp-row-autoMode-checkTest', 'Run test');
    await until(async () => /^Checking [3-9] of 24…$/.test((await app.text('#sp-row-autoMode-checkTest .sp-row-desc')) || ''), 6000);
    await clickIn('#sp-row-autoMode-checkTest', 'Cancel');
    const stopped = await until(async () => /Stopped after \d+ of 24\./.test((await app.text('#sp-row-autoMode-checkTest .sp-check-result')) || ''), 8000);
    await sleep(500);
    const ran = chats(gw).length - beforeCancel;
    check('Cancel stops it after the check in flight, and says how far it got', Boolean(stopped) && ran < 24 && ran >= 2, { ran, result: await app.text('#sp-row-autoMode-checkTest .sp-check-result') });
    gw.state.replies.length = 0;
    await app.fill('#autoMode-model', '');
    check('back to Same as the session', Boolean(await until(async () => (await cfg()).autoMode.model === '' && /the session's model\.$/.test((await checkDesc()) || ''))));

    // --- Use: a model of another provider becomes the one in use ---
    const [gwBeforeUse, orBeforeUse] = [chats(gw).length, chats(or).length];
    check('Use: a click', await clickIn(rowSel('openrouter', 'anthropic/claude-haiku-5.5'), 'Use'));
    const used = await until(async () => {
      const c = await cfg();
      return c.provider === 'openrouter' && c.providerView.active.model === 'anthropic/claude-haiku-5.5';
    });
    check('… switches the provider and its model', Boolean(used));
    const moved = await until(async () => (await rowText('openrouter', 'anthropic/claude-haiku-5.5')).includes('In use') && !(await rowText('portkey', 'claude-opus-5-5')).includes('In use'));
    const first = await app.evaluate(`document.querySelector('#sp-sec-model .sp-provider')?.dataset.providerName`);
    check('… the In use mark moves, and that provider now leads the list', Boolean(moved) && first === 'openrouter', first);
    check('… the Provider select follows', (await app.evaluate(`document.querySelector('#provider').value`)) === 'openrouter');
    check('… and Use sent no model request', chats(or).length === orBeforeUse && chats(gw).length === gwBeforeUse);

    // --- Search still finds the rows (Connected hides while searching) ---
    const search = async (q) => {
      await app.fill('#settings-search', q);
      await sleep(150);
      return app.evaluate(`[...document.querySelectorAll('#sp-sec-model .sp-row.hit')].map((r) => r.dataset.row)`);
    };
    let hits = await search('virtual key');
    check('search "virtual key" finds the gateway row', hits.includes('portkey-virtualKey'), hits);
    hits = await search('context size');
    check('search "context size" finds Ollama’s row', hits.includes('ollama-numCtx'), hits);
    hits = await search('key');
    check('search "key" finds the keys of every provider kind', ['portkey-apiKey', 'portkey-providerApiKey', 'provider-key'].every((id) => hits.includes(id)), hits);
    hits = await search('test');
    check('search "test" finds the provider rows', hits.includes('provider-service') && hits.includes('provider'), hits);
    check('… and the Connected list is out of the way while searching', await app.evaluate(`getComputedStyle(document.querySelector('#sp-sec-model .sp-models')).display === 'none'`));
    await app.fill('#settings-search', '');
    await sleep(150);
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
