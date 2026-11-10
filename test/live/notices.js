// Live check of the transcript's notes about a setting: stepping through the permission modes with Shift+Tab leaves
// one "Permission mode: …" line (a new note takes the place of its group's earlier one), and a note that a message
// came after stays where it was. Runs against the mock model.
// Run: npm run build && node test/live/notices.js
const { launch, checker } = require('./rig.js');

(async () => {
  const { check, done } = checker();
  const app = await launch({ mode: 'ask', mock: true });
  const modeNotes = () => app.evaluate(`[...document.querySelectorAll('#messages > .msg.system')].map((e) => e.innerText.trim()).filter((t) => /^Permission mode:/.test(t))`);
  const mode = () => app.evaluate(`document.querySelector('#mode-btn').dataset.mode`);
  const step = async () => {
    const before = await mode();
    await app.evaluate(`document.querySelector('#input').focus()`);
    await app.key('Tab', { shift: true });
    await app.waitFor(`document.querySelector('#mode-btn').dataset.mode !== ${JSON.stringify(before)}`, 5000, 'the mode to change');
  };
  try {
    await app.send('Reply with exactly: ONE');
    await app.waitIdle();

    await step();
    check('a mode change leaves a note', (await modeNotes()).length === 1, await modeNotes());
    await step();
    await step();
    let notes = await modeNotes();
    check('three changes in a row leave one note', notes.length === 1, notes);
    check('… the last mode’s', (await mode()) === 'plan' && /^Permission mode: Plan\./.test(notes[0] ?? ''), { mode: await mode(), notes });

    await app.send('Reply with exactly: TWO');
    await app.waitIdle();
    await step();
    notes = await modeNotes();
    check('a note a message came after stays', notes.length === 2 && /Plan/.test(notes[0]) && /Ask/.test(notes[1]), notes);
    const order = await app.evaluate(`[...document.querySelectorAll('#messages > .msg')].map((e) => (e.classList.contains('system') ? 'note' : e.classList.contains('user') ? 'user' : 'reply'))`);
    check('… above that message', order.join(' ') === 'user reply note user reply note', order);

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await app.close();
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
