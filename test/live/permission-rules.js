// Live check of permission rules in the real window, with the mock model: a card's "Always allow git in this project"
// saves Bash(git:*), which then lets git run without a card; Settings → Permissions lists the rules, refuses a bad
// one as it is typed, adds to Deny and Ask, and removes; a deny rule refuses in Bypass, naming the rule; an ask rule
// shows a card in Bypass; the rules of your settings.json are listed read-only with the file's name. Light and dark.
// Run: npm run build && node test/live/permission-rules.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const { check, done } = checker();

const lastMsg = (p) => p.messages?.[p.messages.length - 1];
const afterTool = (p) => lastMsg(p)?.role === 'tool';
const userSays = (text) => (p) => {
  const m = lastMsg(p);
  return m?.role === 'user' && JSON.stringify(m.content).includes(text);
};

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-rules-'));
  fs.mkdirSync(shots, { recursive: true });
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-rules-project-')));
  fs.writeFileSync(path.join(project, 'keep.txt'), 'keep');
  const app = await launch({ mode: 'ask', mock: true, project, config: { toolSet: 'all' }, size: { width: 1200, height: 860 } });
  const replies = app.mock.state.replies;
  const requests = app.mock.state.requests;
  const toolResult = (id) => requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content;
  const cards = () => app.count('.approval:not(.decided)');
  const rules = () => app.evaluate('window.oc.rules.list()');
  const openPermissions = async () => {
    await app.evaluate(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-permissions')?.click(); })()`);
    await sleep(400);
  };
  const closeSettings = async () => {
    await app.evaluate(`document.querySelector('#settings').open && document.querySelector('#settings-close').click()`);
    await sleep(300);
  };
  const chipsOf = (sel) => app.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)} + ' .rule-chip')].map((c) => ({ text: c.dataset.value, remove: Boolean(c.querySelector('.rule-remove')) }))`);
  const setMode = (mode) => app.evaluate(`(async () => { const c = await oc.getConfig(); await oc.setConfig({ ...c, permissionMode: ${JSON.stringify(mode)}, autoApprove: ${mode === 'bypass'} }); })()`);
  try {
    if (await app.evaluate(`!document.querySelector('.shell').classList.contains('pane-hidden')`)) await app.click('#pane-toggle');

    // ---------- 1. "Always allow git in this project" saves Bash(git:*) ----------
    replies.push({ content: '', toolCalls: [{ id: 'g1', name: 'bash', args: { command: 'git status', description: 'Check the tree' } }], when: userSays('[one]') });
    replies.push({ content: 'Done.', when: afterTool });
    await app.send('Check git [one]');
    await app.waitFor(`Boolean(document.querySelector('.approval:not(.decided)'))`, 20_000, 'the approval card');
    const cardText = await app.evaluate(`[...document.querySelectorAll('.approval')].pop().innerText`);
    await app.evaluate(`document.activeElement?.blur?.()`);
    await app.key('p');
    await app.waitIdle(30_000);
    let r = await rules();
    check('card: "Always allow git in this project" saves Bash(git:*)', r.allow.some((e) => e.text === 'Bash(git:*)'), { r, cardText });
    const onDisk = JSON.parse(fs.readFileSync(path.join(app.profile, 'config.json'), 'utf8'));
    check('… in config.json, as a rule string', (onDisk.allowRules?.[project]?.allow ?? []).includes('Bash(git:*)') && !onDisk.allowRules?.[project]?.programs, onDisk.allowRules);

    replies.push({ content: '', toolCalls: [{ id: 'g2', name: 'bash', args: { command: 'git log -1' } }], when: userSays('[two]') });
    replies.push({ content: 'Done.', when: afterTool });
    await app.send('Log [two]');
    await app.waitIdle(30_000);
    check('… and the rule then applies: git runs without a card', (await cards()) === 0 && toolResult('g2') !== undefined && !/Not permitted/.test(toolResult('g2') ?? ''), toolResult('g2'));

    // ---------- 2. Settings → Permissions: list, validate, add, remove ----------
    await openPermissions();
    check('Settings lists the project\'s allow rule', (await chipsOf('#rules-allow')).some((c) => c.text === 'Bash(git:*)' && c.remove));
    await app.fill('#rules-add-input', 'Bash(');
    await app.waitFor(`!document.querySelector('#rules-add-error').hidden`, 5000, 'the typed error').catch(() => false);
    check('a bad rule is refused as it is typed', !(await app.evaluate(`document.querySelector('#rules-add-error').hidden`)) && (await app.evaluate(`document.querySelector('#rules-add-btn').disabled`)));
    await app.fill('#rules-add-list', 'deny');
    await app.fill('#rules-add-input', 'Bash(rm:*)');
    await app.waitFor(`!document.querySelector('#rules-add-btn').disabled`, 5000, 'Add to enable');
    await app.click('#rules-add-btn');
    await app.waitFor(`[...document.querySelectorAll('#rules-deny .rule-chip')].some((c) => c.dataset.value === 'Bash(rm:*)')`, 5000, 'the deny chip');
    await app.fill('#rules-add-list', 'ask');
    await app.fill('#rules-add-input', 'Bash(touch:*)');
    await app.waitFor(`!document.querySelector('#rules-add-btn').disabled`, 5000, 'Add to enable');
    await app.key('Enter');
    await app.waitFor(`[...document.querySelectorAll('#rules-ask .rule-chip')].some((c) => c.dataset.value === 'Bash(touch:*)')`, 5000, 'the ask chip');
    await app.fill('#rules-add-list', 'allow');
    await app.fill('#rules-add-input', 'Bash(npm test)');
    await app.waitFor(`!document.querySelector('#rules-add-btn').disabled`, 5000, 'Add to enable');
    await app.click('#rules-add-btn');
    await app.waitFor(`document.querySelectorAll('#rules-allow .rule-chip').length === 2`, 5000, 'the second allow chip');
    r = await rules();
    check('Settings adds to Deny, Ask and Allow', r.deny.some((e) => e.text === 'Bash(rm:*)') && r.ask.some((e) => e.text === 'Bash(touch:*)') && r.allow.some((e) => e.text === 'Bash(npm test)'), r);
    await app.evaluate(`[...document.querySelectorAll('#rules-allow .rule-chip')].find((c) => c.dataset.value === 'Bash(npm test)').querySelector('.rule-remove').click()`);
    await app.waitFor(`document.querySelectorAll('#rules-allow .rule-chip').length === 1`, 5000, 'the chip to go');
    r = await rules();
    check('Settings removes a rule', !r.allow.some((e) => e.text === 'Bash(npm test)') && r.allow.some((e) => e.text === 'Bash(git:*)'), r);

    // The global rules of settings.json: read-only, with the file's name
    const userSettings = path.join(app.profile, 'home-config', 'settings.json');
    fs.mkdirSync(path.dirname(userSettings), { recursive: true });
    fs.writeFileSync(userSettings, JSON.stringify({ permissions: { allow: ['Bash(make:*)'], deny: ['WebSearch', 'Bash(('] } }, null, 2));
    await app.waitFor(`(async () => (await oc.rules.list()).global.deny.length === 2)()`, 10_000, 'the settings.json rules').catch(() => false);
    await closeSettings();
    await openPermissions();
    const g = await chipsOf('#rules-global');
    const file = await app.evaluate(`document.querySelector('#rules-global-file').textContent`);
    check('settings.json rules are listed read-only', g.some((c) => c.text === 'Bash(make:*)') && g.some((c) => c.text === 'WebSearch') && g.every((c) => !c.remove) && /settings\.json$/.test(file), { g, file });
    const ignored = await app.evaluate(`document.querySelector('#rules-ignored').hidden ? '' : document.querySelector('#rules-ignored').innerText`);
    check('… and one that does not parse is shown as ignored, with the reason', /Ignored Bash\(\(/.test(ignored), ignored);
    for (const t of ['light', 'dark']) {
      await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(t)}`);
      await sleep(300);
      await app.screenshotOf(path.join(shots, `permission-rules-${t}.png`), '#sp-sec-permissions', 16).catch(() => app.screenshot(path.join(shots, `permission-rules-${t}.png`)));
    }
    await app.evaluate(`document.documentElement.dataset.theme = 'light'`);
    await closeSettings();

    // ---------- 3. A deny rule refuses in Bypass ----------
    await setMode('bypass');
    replies.push({ content: '', toolCalls: [{ id: 'd1', name: 'bash', args: { command: 'rm -f keep.txt' } }], when: userSays('[three]') });
    replies.push({ content: 'It was refused.', when: afterTool });
    await app.send('Remove keep.txt [three]');
    await app.waitIdle(30_000);
    check('deny: refused in Bypass, nothing ran, no card', fs.existsSync(path.join(project, 'keep.txt')) && /deny rule Bash\(rm:\*\)/.test(toolResult('d1') ?? '') && (await cards()) === 0, toolResult('d1'));

    // ---------- 4. An ask rule shows a card where the mode would not ----------
    replies.push({ content: '', toolCalls: [{ id: 'a1', name: 'bash', args: { command: 'touch made.txt' } }], when: userSays('[four]') });
    replies.push({ content: 'Made.', when: afterTool });
    await app.send('Make made.txt [four]');
    await app.waitFor(`Boolean(document.querySelector('.approval:not(.decided)'))`, 20_000, 'the ask rule\'s card');
    const askText = await app.evaluate(`[...document.querySelectorAll('.approval')].pop().innerText`);
    check('ask: a card in Bypass, naming the rule', /Bash\(touch:\*\)/.test(askText), askText);
    await app.screenshotOf(path.join(shots, 'permission-rules-ask-card.png'), '.approval:not(.decided)', 16).catch(() => undefined);
    await app.approve('allow');
    await app.waitIdle(30_000);
    check('… and once allowed it runs', fs.existsSync(path.join(project, 'made.txt')));
    // A global deny rule from settings.json applies too
    replies.push({ content: '', toolCalls: [{ id: 'w1', name: 'web_search', args: { query: 'example' } }], when: userSays('[five]') });
    replies.push({ content: 'Refused.', when: afterTool });
    await app.send('Search [five]');
    await app.waitIdle(30_000);
    check('a deny rule from settings.json refuses too', /deny rule WebSearch/.test(toolResult('w1') ?? ''), toolResult('w1'));
    console.log(`screenshots: ${shots}`);
  } catch (e) {
    check(`no crash: ${e.message}`, false);
  } finally {
    await app.close();
  }
  done();
})();
