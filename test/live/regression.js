// Live regression pass over single-session behaviour after the concurrent-sessions change: send, approval allow and
// deny, stop mid-run (Esc), a queued message, rewind, plan mode end to end, /compact, rename, fork, delete, and the
// unread dot of a session that finished off screen. Needs the API (the mock model cannot call tools).
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/regression.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const app = await launch({ mode: 'ask' });
  const shot = (name) => app.screenshot(path.join(shots, `regression-${name}.png`));
  const setMode = (mode) => app.evaluate(`(async () => { const c = await window.oc.getConfig(); await window.oc.setConfig({ ...c, permissionMode: ${JSON.stringify(mode)} }); })()`);
  const menuItem = async (rowSelector, label) => {
    await app.evaluate(`document.querySelector(${JSON.stringify(rowSelector)} + ' .row-more').click()`);
    await app.waitFor(`[...document.querySelectorAll('.popover .pop-item')].some((b) => b.innerText.trim().startsWith(${JSON.stringify(label)}))`, 5000, `menu item ${label}`);
    await app.evaluate(`[...document.querySelectorAll('.popover .pop-item')].find((b) => b.innerText.trim().startsWith(${JSON.stringify(label)})).click()`);
  };
  const idle = () => app.waitFor(`document.querySelector('#status-line').hidden && !document.querySelector('.session-item.running')`, 120_000, 'the run to end');
  try {
    if (!app.live) throw new Error('This pass needs ANTHROPIC_API_KEY (the mock model cannot call tools).');
    // ---- send ----
    await app.send('Reply with exactly: ONE');
    await app.waitIdle(60_000);
    check('send: the reply arrives', /ONE/.test(await app.lastReply()));

    // ---- approval deny, then allow ----
    await app.send('Use the bash tool to run exactly: echo hi > denied.txt. Then reply with exactly: TRIED');
    await app.approve('deny');
    await idle();
    check('approval deny: the command did not run', !fs.existsSync(path.join(app.project, 'denied.txt')));
    check('approval deny: the call reads as denied', await app.evaluate(`[...document.querySelectorAll('.tool-group, .tool, .approval')].some((e) => /Denied/.test(e.innerText))`));
    await app.send('Use the bash tool to run exactly: echo hi > allowed.txt. Then reply with exactly: RAN');
    await app.approve('allow');
    await idle();
    check('approval allow: the command ran', fs.existsSync(path.join(app.project, 'allowed.txt')));
    await shot('1-approvals');

    // ---- the window follows a config change made elsewhere (config:changed push) ----
    await setMode('bypass');
    await app.waitFor(`document.querySelector('#mode-btn').dataset.mode === 'bypass'`, 5000, 'the mode chip to follow');
    check('config push: the mode chip follows', true);

    // ---- stop mid-run ----
    await app.send('Use the bash tool to run exactly: sleep 20. Then reply with exactly: SLEPT');
    await app.waitFor(`Boolean(document.querySelector('.tool .tool-status.spin'))`, 30_000, 'the sleep to start');
    await app.key('Escape');
    await idle();
    check('stop: the run was interrupted', await app.evaluate(`[...document.querySelectorAll('.msg.system')].some((e) => /Interrupted/.test(e.innerText))`));
    await shot('2-stopped');

    // ---- queue a message during a run ----
    await app.send('Use the bash tool to run exactly: sleep 4. Then reply with exactly: FIRST');
    await app.waitFor(`Boolean(document.querySelector('.tool .tool-status.spin'))`, 30_000, 'the sleep to start');
    // During a run the send button is Stop: Enter in the composer queues the message.
    await app.fill('#input', 'Also reply with exactly: SECOND');
    await app.key('Enter');
    await app.waitFor(`document.querySelectorAll('#queue .queue-item').length === 1`, 5000, 'the queued row').catch(() => undefined);
    check('queue: the message waits in the queue', (await app.count('#queue .queue-item')) === 1);
    await shot('3-queued');
    await idle();
    check('queue: it was delivered as a bubble', await app.evaluate(`[...document.querySelectorAll('.msg.user')].some((e) => /Also reply with exactly: SECOND/.test(e.innerText))`));
    check('queue: empty after the run', (await app.count('#queue .queue-item')) === 0);
    check('queue: the model answered it', /SECOND/.test(await app.lastReply()), await app.lastReply());

    // ---- rewind ----
    await app.waitFor(`document.querySelectorAll('.msg.user .msg-rewind').length > 0`, 10_000, 'rewind buttons');
    const usersBefore = await app.count('.msg.user');
    await app.evaluate(`[...document.querySelectorAll('.msg.user .msg-rewind')].pop().click()`);
    await app.click('#confirm-ok');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /Rewound/.test(e.innerText))`, 10_000, 'the rewind notice');
    check('rewind: the last message left the transcript and came back to the composer', (await app.count('.msg.user')) === usersBefore - 1 && /SECOND/.test(await app.evaluate(`document.querySelector('#input').value`)));
    await app.fill('#input', '');
    await shot('4-rewound');

    // ---- /compact ----
    await app.send('/compact');
    // A conversation this short may have nothing worth folding: then a notice says so instead of a divider.
    await app.waitFor(`Boolean(document.querySelector('#messages .compaction')) || [...document.querySelectorAll('.msg.system')].some((e) => /compact|summar/i.test(e.innerText))`, 90_000, 'a compaction divider, or a notice saying why there is none');
    check('/compact: a divider shows, or a notice says there is nothing worth compacting', true);
    await shot('5-compacted');

    // ---- rename ----
    await app.click('#session-title');
    await app.evaluate(`(() => { const t = document.querySelector('#session-title'); t.textContent = 'Regression session'; })()`);
    await app.key('Enter');
    await app.waitFor(`document.querySelector('.session-item.active .label')?.innerText === 'Regression session'`, 5000, 'the new title in the sidebar');
    check('rename: the sidebar shows the new title', true);

    // ---- fork ----
    const sessionsBefore = await app.count('.session-item');
    await menuItem('.session-item.active', 'Fork');
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /Forked .*The original is unchanged/.test(e.innerText))`, 10_000, 'the fork notice');
    check('fork: a new session on screen with the history', (await app.count('.session-item')) === sessionsBefore + 1 && (await app.count('.msg.user')) >= 1 && /\(fork\)/.test(await app.text('.session-item.active .label')));

    // ---- delete (the fork) ----
    await app.evaluate(`window.confirm = () => true`);
    await menuItem('.session-item.active', 'Delete');
    // Deleting the session on screen leaves a fresh empty one there
    await app.waitFor(`![...document.querySelectorAll('.session-item .label')].some((e) => /\\(fork\\)/.test(e.innerText))`, 10_000, 'the fork to go');
    check('delete: the fork is gone and a fresh session is on screen', (await app.text('.session-item.active .label')) === 'New session' && !(await app.exists('#messages .msg.user')));

    // ---- plan mode end to end ----
    await app.click('#new-session-btn');
    await setMode('plan');
    await app.waitFor(`document.querySelector('#mode-btn').dataset.mode === 'plan'`, 5000, 'plan mode');
    await app.send('Plan creating a file named plan.txt containing the word planned. Two steps at most; do not explore, submit the plan right away.');
    await app.waitFor(`Boolean(document.querySelector('.plan-card #plan-build'))`, 90_000, 'the plan card').catch(async (err) => {
      console.log('transcript:', JSON.stringify(await app.transcript()).slice(0, 2000));
      throw err;
    });
    // The status line stays up after a plan ("Waiting for plan approval"): wait for the run itself to end.
    await app.waitFor(`!document.querySelector('.session-item.running')`, 60_000, 'the planning run to end');
    await sleep(300);
    check('plan: the sidebar marks the session waiting for the plan', await app.evaluate(`Boolean(document.querySelector('.session-item.active .status-dot.attention'))`));
    await shot('6-plan');
    await app.click('.plan-card #plan-build');
    await app.waitFor(`document.querySelector('#mode-btn').dataset.mode === 'ask'`, 10_000, 'ask mode for the build');
    // The build runs in ask mode: allow every card until the run ends (the write, then perhaps a check with cat).
    for (let i = 0; i < 6; i++) {
      const asked = await app.waitFor(`Boolean(document.querySelector('.approval:not(.done) .btn.primary')) || (document.querySelector('#status-line').hidden && 'idle')`, 90_000, 'an approval or the end').catch(() => 'idle');
      if (asked === 'idle') break;
      await app.approve('allow');
      await sleep(500);
    }
    await idle();
    check('plan: the build created the file', fs.existsSync(path.join(app.project, 'plan.txt')));
    check('plan: no attention dot after the build', !(await app.evaluate(`Boolean(document.querySelector('.session-item.active .status-dot.attention'))`)));
    await shot('7-built');

    // ---- unread: a run that ends off screen ----
    await setMode('bypass');
    await app.click('#new-session-btn');
    await app.send('Use the bash tool to run exactly: sleep 3. Then reply with exactly: BACKGROUND');
    const bg = await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id`, 10_000, 'the session id');
    await app.click('.session-item:not(.active)');
    await app.waitFor(`!document.querySelector('.session-item.running')`, 60_000, 'the background run to end');
    await sleep(300);
    check('unread: the session that finished off screen has a dot', await app.evaluate(`Boolean(document.querySelector('.session-item[data-id="${bg}"] .status-dot.unread'))`));
    await shot('8-unread');
    await app.click(`.session-item[data-id="${bg}"]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${JSON.stringify(bg)}`, 5000, 'the session on screen');
    check('unread: opening it clears the dot and shows the reply', !(await app.evaluate(`Boolean(document.querySelector('.status-dot.unread'))`)) && /BACKGROUND/.test(await app.lastReply()));

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
