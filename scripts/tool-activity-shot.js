// Makes the screenshot of folded tool activity: one turn whose first run of calls is opened to its rows (an edit open
// to its diff) and whose second run stays one line. In light and in dark.
//
// Like scripts/readme-shots.js, whose project, sessions and PNG helpers it uses: the built app runs hidden on a
// throwaway profile against the scripted model; the reads, edits and test runs really happen on ~/code/atlas-api.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/tool-activity-shot.js [out-dir]      default: docs/screenshots (tool-activity.png, tool-activity-dark.png)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock } = require('../test/support/mock-model.js');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'docs', 'screenshots'));
const js = JSON.stringify;

// Each reply is held back so the whole turn takes about 53 s and its header reads "Worked for 53s", as in the README
const STEP_MS = Number(process.env.TOOL_SHOT_STEP_MS || 7550);

function scriptTurn(mock) {
  const main = (r) => mock.state.replies.push({ delayMs: STEP_MS, ...r, when: F.isMain });
  main({ promptTokens: 8400, toolCalls: [F.call('read_file', { path: 'src/routes.js' }), F.call('read_file', { path: 'src/products.json' }), F.call('read_file', { path: 'test/routes.test.js' })] });
  main({
    promptTokens: 9100,
    toolCalls: [
      F.call('edit_file', {
        path: 'test/routes.test.js',
        old_string: '  assert.equal((await fetch(`${base}/v1/products/nope`)).status, 404);',
        new_string: "  const res = await fetch(`${base}/v1/products/nope`);\n  assert.equal(res.status, 404);\n  assert.deepEqual(await res.json(), { error: 'not_found', id: 'nope' });",
      }),
    ],
  });
  main({ promptTokens: 9500, toolCalls: [F.call('bash', { command: 'npm test' })] });
  main({
    promptTokens: 10200,
    toolCalls: [
      F.call('edit_file', {
        path: 'src/routes.js',
        old_string: "    return p ? json(res, 200, p) : json(res, 404, { error: 'not_found' });",
        new_string: "    return p ? json(res, 200, p) : json(res, 404, { error: 'not_found', id: m[1] });",
      }),
    ],
  });
  main({ promptTokens: 10600, toolCalls: [F.call('bash', { command: 'npm test' })] });
  main({ promptTokens: 11000, content: 'A missing product now answers `404` with the id it looked for, and the new test passes with the other four. Let me check no other route builds a 404 by hand.', toolCalls: [F.call('grep', { pattern: 'not_found', path: 'src' }), F.call('list_directory', { path: 'src' })] });
  main({ promptTokens: 11400, content: 'The other `not_found` is the catch-all for unknown paths, which has no id to name, so it stays as it is.' });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-tool-shot-'));
  fs.writeFileSync(path.join(F.HOME, '.zprofile'), `export PATH=${js(process.env.PATH)}\n`);
  const ids = F.seedSessions(profile);
  const mock = await startMock();
  // Auto mode's safety check passes everything the scenes do
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.ollamaPromptTokens = 8000;
  mock.state.ollamaModels = ['qwen3:8b', 'qwen3:14b'];
  const inspect = await F.freePort(0);
  let app;
  try {
    app = await launch({
      args: [`--inspect=${inspect}`],
      profile,
      project: F.PROJECT,
      mock: true,
      mode: 'auto',
      size: { width: 1180, height: 1000 },
      env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
      config: {
        provider: 'ollama',
        ollama: { baseURL: `http://127.0.0.1:${mock.port}`, model: 'qwen3:8b', numCtx: 32768, think: 'auto' },
        theme: 'light',
        remote: { enabled: false, bind: 'localhost', port: 0 },
        recentDirs: [F.PROJECT],
      },
    });
    const ev = app.evaluate;
    const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
    await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); ${WIN}.setContentSize(1180, 1000); return true; })()`);
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1180, height: 1000, deviceScaleFactor: 2, mobile: false });

    await app.waitFor(`Boolean(document.querySelector('.session-item[data-id=${js(ids.main)}]'))`, 15_000, 'the seeded sessions');
    await app.click(`.session-item[data-id=${js(ids.main)}]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${js(ids.main)}`, 10_000, 'the main session');
    // The reading column on its own: the side pane and the rail closed
    await ev(`(() => { if (!document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-toggle').click(); const r = document.querySelector('#rail-toggle'); if (r && !r.hidden && r.getAttribute('aria-pressed') === 'true') r.click(); })()`);

    scriptTurn(mock);
    await app.send('A missing product should say which id it could not find. Add a test for it, fix it, and run the tests.');
    await app.waitFor(`document.querySelector('#status-line').hidden && !document.querySelector('.session-item.active.running') && document.querySelectorAll('#messages > .tool-group').length >= 2`, 120_000, 'the turn to end');
    await sleep(800);
    console.log('header:', await ev(`[...document.querySelectorAll('#messages > .turn-head')].pop()?.innerText.trim()`));
    // The turn folded its working under "Worked for …": open it, so its tool lines show under the header
    await ev(`(() => { const b = [...document.querySelectorAll('#messages > .turn-head button')].pop(); if (b && b.getAttribute('aria-expanded') === 'false') b.click(); })()`);
    await sleep(300);
    const words = await ev(`[...document.querySelectorAll('#messages > .tool-group')].map((g) => g.querySelector(':scope > summary').innerText.replace(/\\s+/g, ' ').trim())`);
    console.log('lines:', words.join(' | '));

    // The first line opened, and in it the edit of the test opened to its diff
    await ev(`(() => {
      const g = [...document.querySelectorAll('#messages > .tool-group')].slice(-2)[0];
      if (!g.open) g.querySelector(':scope > summary').click();
      const edit = [...g.querySelectorAll(':scope > .group-body > .tool')].find((r) => /test\\/routes\\.test\\.js/.test(r.querySelector('.tool-arg')?.textContent || '') && /Edit/.test(r.querySelector('.tool-verb')?.textContent || ''));
      if (edit && !edit.open) edit.querySelector(':scope > summary').click();
      document.activeElement && document.activeElement.blur();
    })()`);
    await sleep(600);
    await ev(`(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; })()`);
    await sleep(1800);

    for (const theme of ['light', 'dark']) {
      await ev(`document.documentElement.dataset.theme = ${js(theme)}`);
      await sleep(700);
      const chat = await ev(`(() => { const r = document.querySelector('#messages').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      // From your message to the last reply, across the reading column with a margin on each side
      const r = await ev(`(() => { const users = [...document.querySelectorAll('.msg.user')]; const u = users[users.length - 1]; const ub = u.querySelector('.bubble').getBoundingClientRect(); const g = document.querySelector('#messages > .tool-group').getBoundingClientRect(); const end = [...document.querySelectorAll('#messages > .msg.assistant')].pop().getBoundingClientRect(); const prev = u.previousElementSibling; return { above: prev && !prev.hidden ? prev.getBoundingClientRect().bottom : -Infinity, top: ub.top, bottom: end.bottom, left: g.left, right: ub.right }; })()`);
      const y = Math.ceil(Math.max(chat.y, r.top - 28, r.above + 2));
      const bottom = Math.min(chat.y + chat.height, r.bottom + 28);
      const x = Math.max(chat.x, Math.floor(r.left - 32));
      const width = Math.ceil(r.right + 32 - x);
      await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
      await sleep(150);
      const cap = await app.cdp('Page.captureScreenshot', { format: 'png' });
      const png = F.cropPng(Buffer.from(cap.data, 'base64'), x * 2, y * 2, width * 2, Math.ceil(bottom - y) * 2);
      const file = path.join(OUT, theme === 'dark' ? 'tool-activity-dark.png' : 'tool-activity.png');
      fs.writeFileSync(file, png);
      console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB)`);
    }
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    if (errors.length) console.log('console errors:\n' + errors.slice(-10).join('\n'));
  } finally {
    if (app) await app.close();
    mock.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(F.HOME, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e && e.stack);
    process.exit(1);
  },
);
