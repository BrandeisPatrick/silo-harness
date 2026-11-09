// Live smoke test: the real window, a real model call with a tool, an approval card, and a screenshot.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/smoke.js [screenshot-dir]
// Without a key it runs against the mock model, scripted to make the same write through the same card.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker } = require('./rig.js');

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const app = await launch({ mode: 'ask' });
  try {
    check('the window loads with an empty session', await app.exists('#empty-state'));
    check('the composer shows the configured model', /haiku|mock/i.test((await app.text('#model-btn')) || ''), await app.text('#model-btn'));

    // The welcome screen: the title, the folder row (the working folder's path and Choose folder), the composer
    const project = await app.evaluate(`oc.getConfig().then((c) => c.workingDirectory)`);
    const tildeOf = (p) => (p === os.homedir() ? '~' : p.startsWith(os.homedir() + '/') ? '~' + p.slice(os.homedir().length) : p);
    const welcome = await app.evaluate(`(() => { const p = document.querySelector('#folder-row-path'); return { title: document.querySelector('.empty-title')?.textContent, paragraph: document.querySelectorAll('#empty-state p').length, chips: document.querySelectorAll('#empty-state button').length, row: !document.querySelector('#folder-row').hidden, path: p?.textContent, tip: p?.dataset.tip, button: document.querySelector('#folder-row-btn')?.innerText.trim(), sentence: /Working in|home folder/.test(document.querySelector('#empty-state').innerText) }; })()`);
    check('welcome: the title and nothing under it but the folder row', welcome.title === 'What should we build?' && welcome.paragraph === 0 && welcome.chips === 1 && welcome.row && !welcome.sentence, welcome);
    check('welcome: the row shows the working folder as a path, the whole path as its tooltip, and Choose folder', welcome.tip === tildeOf(project) && welcome.path.endsWith(path.basename(project)) && welcome.button === 'Choose folder', { welcome, project });
    const menuItems = () => app.evaluate(`[...document.querySelectorAll('.folder-menu .pop-item')].map((b) => ({ label: b.querySelector('.pop-title').textContent, checked: b.getAttribute('aria-checked') }))`);
    await app.click('#folder-row-btn');
    await app.waitFor(`!!document.querySelector('.folder-menu')`, 5000, 'the folder menu');
    let items = await menuItems();
    const silo = path.join(app.profile, 'home-config', 'Silo');
    check('Choose folder: the Silo folder first, the working folder checked, then Choose another folder…', items.length === 3 && items[0].label.endsWith('/Silo') && items[0].checked === 'false' && items[1].label.endsWith(path.basename(project)) && items[1].checked === 'true' && items[2].label === 'Choose another folder…', items);
    await app.evaluate(`document.querySelectorAll('.folder-menu .pop-item')[0].click()`);
    const switched = await app.waitFor(`oc.getConfig().then((c) => c.workingDirectory === ${JSON.stringify(silo)} && document.querySelector('#folder-row-path').textContent.endsWith('Silo'))`, 5000, 'the switch to the Silo folder').catch(() => false);
    check('picking the Silo folder makes it the working folder, and the row follows', Boolean(switched) && fs.existsSync(silo), silo);
    await app.click('#folder-row-btn');
    await app.waitFor(`!!document.querySelector('.folder-menu')`, 5000, 'the folder menu again');
    items = await menuItems();
    check('… the folder left is now a recent folder in the menu', items.length === 3 && items[0].checked === 'true' && items[1].label.endsWith(path.basename(project)) && items[1].checked === 'false', items);
    await app.evaluate(`document.querySelectorAll('.folder-menu .pop-item')[1].click()`);
    const back = await app.waitFor(`oc.getConfig().then((c) => c.workingDirectory === ${JSON.stringify(project)})`, 5000, 'the switch back').catch(() => false);
    check('… and picking it switches back', Boolean(back));
    await app.screenshot(path.join(shots, 'smoke-1-empty.png'));

    if (app.live) {
      await app.send('Create a file named hello.txt in the working directory containing exactly the text: live test ok. Then reply with the single word DONE.');
      await app.approve('allow');
      await app.waitIdle(120_000);
      const file = path.join(app.project, 'hello.txt');
      check('the model wrote the file through write_file', fs.existsSync(file) && /live test ok/.test(fs.readFileSync(file, 'utf8')), fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'missing');
      check('an approval card was answered: it is gone and the call\'s row keeps the answer', (await app.count('.approval')) === 0 && (await app.count('.tool .tool-decision')) >= 1);
      check('a tool row is shown, folded into a line', (await app.count('.tool')) >= 1 && (await app.count('#messages > .tool-group')) >= 1);
      check('the reply arrives', /DONE/i.test(await app.lastReply()), await app.lastReply());
    } else {
      await app.send('Hello');
      await app.waitIdle(30_000);
      check('the mock model replies', (await app.lastReply()).length > 0, await app.lastReply());
      // The same write as with the real model, scripted: the card, Allow once, the file, one line for the call
      app.mock.state.replies.push({ content: '', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'hello.txt', content: 'live test ok\n' } }] });
      app.mock.state.replies.push({ content: 'DONE' });
      await app.send('Create hello.txt containing: live test ok');
      await app.approve('allow');
      await app.waitIdle(30_000);
      const file = path.join(app.project, 'hello.txt');
      check('the write went through the approval card', fs.existsSync(file) && /live test ok/.test(fs.readFileSync(file, 'utf8')));
      const line = await app.evaluate(`(() => { const g = [...document.querySelectorAll('#messages > .tool-group')].pop(); return g ? { words: g.querySelector('.group-verb').textContent, answer: g.querySelector('.tool-decision')?.textContent } : null; })()`);
      check('the card is gone; the call is one line ("Created a file") with the answer in its row', (await app.count('.approval')) === 0 && line && line.words === 'Created a file' && line.answer === 'Allowed once', line);
    }
    check('the session appears in the sidebar', (await app.count('.session-item')) >= 1);
    await app.screenshot(path.join(shots, 'smoke-2-run.png'));
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${shots}`);
  } finally {
    await app.close();
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
