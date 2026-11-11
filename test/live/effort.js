// Live check of the effort pill under the chat bar (src/renderer/effort.ts) against the mock model:
//   - it shows after the model pill for a model that takes effort (Claude Haiku 5.5: Medium, its default) and hides
//     for one that does not (Claude Haiku 4.5), for an Ollama provider and for LM Studio
//   - the keyboard opens its menu, moves and chooses as in the model pill's; the choice is stored on the provider entry
//     and the next request carries it; a change made while a run waits on a tool applies to the run's next request
//   - an OpenAI-compatible provider offers Default, Low, Medium, High; a service that refuses the field is asked again
//     without it, and the window says so once
//   - /effort sets it; a sub-session's requests carry it; the menu open in light and dark (screenshots)
// Run: npm run build && node test/live/effort.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');
const { startMock } = require('../support/mock-model.js');

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-effort-shots-'));
  const { check, done } = checker();
  // A mock of our own, so the providers can name its address in config.json before the app starts
  const mock = await startMock();
  const { state } = mock;
  const base = `http://127.0.0.1:${mock.port}/v1`;
  const providers = {
    claude: { type: 'anthropic', baseURL: base, apiKey: 'sk-mock-effort-0123456789', model: 'claude-haiku-5-5', models: ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-opus-4-6'] },
    gw: { type: 'openai-compatible', label: 'Example gateway', baseURL: base, model: 'example-model' },
    studio: { type: 'lmstudio', baseURL: base, model: 'example-local' },
  };
  let app;
  try {
    app = await launch({ mock: true, mode: 'bypass', config: { provider: 'claude', providers } });
    const cfg = () => app.evaluate('window.oc.getConfig()');
    const pill = () => app.evaluate(`(() => { const b = document.querySelector('#effort-btn'); return b && { hidden: b.hidden, text: b.innerText.trim(), tip: b.dataset.tip, after: b.previousElementSibling?.id }; })()`);
    const native = () => state.requests.filter((r) => r.url.startsWith('/v1/messages') && r.payload.stream === true);
    const chat = () => state.requests.filter((r) => r.url === '/v1/chat/completions' && r.payload.stream === true);
    // Another provider, from the model pill's menu (its Provider section), as a user does
    const useProvider = async (label) => {
      await app.evaluate(`document.querySelector('#model-btn').click()`);
      await app.waitFor(`[...document.querySelectorAll('.popover[role=menu] button')].some((b) => b.innerText.trim().startsWith(${JSON.stringify(label)}))`, 5_000, `${label} in the model menu`);
      await app.evaluate(`[...document.querySelectorAll('.popover[role=menu] button')].find((b) => b.innerText.trim().startsWith(${JSON.stringify(label)})).click()`);
      await app.waitFor(`document.querySelector('#model-btn').dataset.tip.startsWith(${JSON.stringify(label)})`, 5_000, `${label} in use`);
      await sleep(200);
    };
    const enter = async () => {
      const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
      await app.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
      await app.cdp('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...k });
      await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    };
    const menuItems = () => app.evaluate(`[...document.querySelectorAll('.popover[role=menu] button')].map((b) => ({ text: b.innerText.replace(/\\s+/g, ' ').trim(), checked: b.getAttribute('aria-checked') === 'true' || b.classList.contains('checked') || !!b.querySelector('.check, [data-icon=check]'), active: b.classList.contains('active') }))`);

    await app.waitFor(`!document.querySelector('#effort-btn').hidden`, 15_000, 'the effort pill');
    let p = await pill();
    check('the pill shows for Claude Haiku 5.5, right after the model pill, with its default and the tooltip Effort', p && !p.hidden && p.text === 'Medium' && p.after === 'model-btn' && p.tip === 'Effort', p);

    // --- Keyboard: focus, Enter opens, arrows move, Enter chooses ---
    await app.evaluate(`document.querySelector('#effort-btn').focus()`);
    await enter();
    await app.waitFor(`Boolean(document.querySelector('.popover[role=menu]'))`, 5_000, 'the effort menu');
    let items = await menuItems();
    check('Enter on the focused pill opens its menu: Low … Max, the default marked', items.map((i) => i.text.split(' ')[0]).join(',') === 'Low,Medium,High,Extra,Max' && items.some((i) => /Medium/.test(i.text) && /default/.test(i.text)), items);
    // The menu opens on the current level (Medium); one step down is High
    await app.key('ArrowDown');
    items = await menuItems();
    const active = items.find((i) => i.active)?.text;
    await enter();
    const chosenWord = active?.split(' ')[0];
    await app.waitFor(`document.querySelector('#effort-btn').innerText.trim() === ${JSON.stringify(chosenWord === 'Extra' ? 'Extra high' : chosenWord)}`, 5_000, 'the pill to follow the choice');
    let c = await cfg();
    check('arrows and Enter choose a level; it is stored on the provider entry', active && /High/.test(active) && c.providers.claude.effort === 'high' && !(await app.exists('.popover[role=menu]')), { active, effort: c.providers.claude.effort });
    await app.evaluate(`document.querySelector('#effort-btn').click()`);
    await app.waitFor(`Boolean(document.querySelector('.popover[role=menu]'))`, 5_000, 'the menu again');
    await app.key('Escape');
    check('Escape closes the menu', !(await app.exists('.popover[role=menu]')));

    // --- The next request carries it ---
    state.requests.length = 0;
    state.replies.push({ content: 'Noted for the example.com team.' });
    await app.send('Say hello to the example.com team');
    await app.waitIdle();
    check('the next request carries output_config.effort high', native().length === 1 && native()[0].payload.output_config?.effort === 'high', native().map((r) => r.payload.output_config));

    // --- A change during a run applies to the next request ---
    state.requests.length = 0;
    fs.writeFileSync(path.join(app.project, 'notes.txt'), 'Ship on Friday.');
    state.replies.push({ content: 'Reading.', toolCalls: [{ id: 'toolu_e1', name: 'bash', args: { command: 'sleep 2; cat notes.txt' } }] });
    state.replies.push({ content: 'It says to ship on Friday.' });
    await app.send('What does notes.txt say?');
    await app.waitFor(`Boolean(document.querySelector('.session-item.running') || !document.querySelector('#status-line').hidden)`, 10_000, 'the run');
    await sleep(500);
    await app.evaluate(`document.querySelector('#effort-btn').click()`);
    await app.waitFor(`Boolean(document.querySelector('.popover[role=menu]'))`, 5_000, 'the menu during the run');
    await app.evaluate(`[...document.querySelectorAll('.popover[role=menu] button')].find((b) => /^Low/.test(b.innerText.trim())).click()`);
    await app.waitIdle();
    const during = native().map((r) => r.payload.output_config?.effort);
    check('a change while the run waits on a tool applies to its next request', during.length === 2 && during[0] === 'high' && during[1] === 'low', during);

    // --- /effort ---
    state.requests.length = 0;
    await app.send('/effort max');
    await app.waitFor(`document.querySelector('#effort-btn').innerText.trim() === 'Max'`, 5_000, '/effort max');
    c = await cfg();
    check('/effort max sets it', c.providers.claude.effort === 'max');

    // --- A sub-session's requests carry it ---
    state.requests.length = 0;
    await app.send('/spawn Reply with the word PONG');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /Started sub-session/.test(e.innerText))`, 20_000, 'the /spawn notice');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !native().some((r) => JSON.stringify(r.payload.messages).includes('PONG'))) await sleep(150);
    const sub = native().find((r) => JSON.stringify(r.payload.messages).includes('PONG'));
    check('a sub-session\'s request carries the effort (max, thinking on)', sub && sub.payload.output_config?.effort === 'max' && sub.payload.thinking?.type === 'adaptive', sub && { e: sub.payload.output_config, t: sub.payload.thinking });
    await sleep(800);

    // --- Screenshots: the composer's foot with the menu open, light and dark ---
    await app.send('/effort default');
    await app.waitFor(`document.querySelector('#effort-btn').innerText.trim() === 'Medium'`, 5_000, '/effort default');
    for (const theme of ['light', 'dark']) {
      await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await app.evaluate(`document.querySelector('#effort-btn').click()`);
      await app.waitFor(`Boolean(document.querySelector('.popover[role=menu]'))`, 5_000, 'the menu for the shot');
      await sleep(300);
      const box = await app.evaluate(`(() => { const m = document.querySelector('.popover[role=menu]').getBoundingClientRect(); const f = document.querySelector('#chatbar').getBoundingClientRect(); const x = Math.min(m.x, f.x) - 16, y = m.y - 16; return { x, y, width: Math.max(m.right, f.right) + 16 - x, height: f.bottom + 16 - y }; })()`);
      await app.screenshot(path.join(shots, `effort-menu-${theme}.png`), box);
      await app.key('Escape');
    }
    await app.evaluate(`document.documentElement.dataset.theme = ''`);

    // --- Hidden for a model without effort ---
    await app.evaluate(`document.querySelector('#model-btn').click()`);
    await app.waitFor(`[...document.querySelectorAll('.popover[role=menu] button')].some((b) => b.innerText.trim() === 'claude-haiku-4-5')`, 5_000, 'the model menu');
    await app.evaluate(`[...document.querySelectorAll('.popover[role=menu] button')].find((b) => b.innerText.trim() === 'claude-haiku-4-5').click()`);
    await app.waitFor(`document.querySelector('#model-btn').innerText.includes('claude-haiku-4-5')`, 5_000, 'the model change');
    await sleep(200);
    p = await pill();
    check('hidden for Claude Haiku 4.5 (no effort setting)', p.hidden, p);
    state.requests.length = 0;
    await app.send('Hello again');
    await app.waitIdle();
    check('…and its request has no output_config', native().length === 1 && native()[0].payload.output_config === undefined);

    // --- OpenAI-compatible: Default, Low, Medium, High; a refusal is sent again without it, noticed once ---
    await useProvider('Example gateway');
    p = await pill();
    check('an OpenAI-compatible provider: the pill says Default', !p.hidden && p.text === 'Default', p);
    await app.evaluate(`document.querySelector('#effort-btn').click()`);
    await app.waitFor(`Boolean(document.querySelector('.popover[role=menu]'))`, 5_000, 'the gateway menu');
    items = await menuItems();
    check('its menu: Default, Low, Medium, High', items.map((i) => i.text).join(',') === 'Default,Low,Medium,High', items);
    await app.evaluate(`[...document.querySelectorAll('.popover[role=menu] button')].find((b) => b.innerText.trim() === 'Medium').click()`);
    await app.waitFor(`document.querySelector('#effort-btn').innerText.trim() === 'Medium'`, 5_000, 'Medium');
    state.requests.length = 0;
    state.rejectEffort = true;
    await app.send('Hi there');
    await app.waitIdle();
    await app.send('And again');
    await app.waitIdle();
    const sentEfforts = chat().map((r) => r.payload.reasoning_effort ?? null);
    const notices = await app.evaluate(`[...document.querySelectorAll('.msg.system')].filter((e) => /effort setting/.test(e.innerText)).map((e) => e.innerText.trim())`);
    check('refused: the first request is sent again without reasoning_effort, the second goes without it', JSON.stringify(sentEfforts) === JSON.stringify(['medium', null, null]), sentEfforts);
    check('refused: one short notice', notices.length === 1 && notices[0].length < 80, notices);
    const transcript = await app.transcript();
    const errorsShown = await app.evaluate(`document.querySelectorAll('.msg.system.error').length`);
    check('refused: both replies arrived, no error shown (no failed turn)', JSON.stringify(transcript).split('Done.').length - 1 >= 2 && errorsShown === 0, { errorsShown, tail: JSON.stringify(transcript.slice(-4)).slice(0, 300) });
    state.rejectEffort = false;

    // --- Hidden for LM Studio ---
    await useProvider('LM Studio');
    p = await pill();
    check('hidden for LM Studio', p.hidden, p);

    const errors = app.console.filter((l) => /\[exception\]|\[error\]/.test(l));
    check('no errors in the window', !errors.length, errors.slice(0, 5));
  } catch (err) {
    check(`no crash: ${err.message}`, false);
  } finally {
    await app?.close();
    mock.close();
  }
  console.log(`screenshots: ${shots}`);
  done();
})();
