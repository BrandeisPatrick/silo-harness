// Makes the README's screenshot of a look set: Hyperspace, in dark, while a run is going (the stars are streaks).
//
// Like scripts/readme-shots.js, whose project, sessions and scripted replies it uses: the built app runs hidden on a
// throwaway profile against the scripted model, plays the hero turn, turns the bundled Hyperspace mod on, uses the
// whole set from its card in Settings → Mods (its conversation look, chat bar look and background), starts a run that does not end, and takes the picture.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/looks-shot.js [out-file]      default: docs/screenshots/hyperspace.png
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock } = require('../test/support/mock-model.js');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'docs', 'screenshots', 'hyperspace.png'));
const js = JSON.stringify;

async function main() {
  F.makeProject();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-looks-shot-'));
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
      size: { width: 1440, height: 900 },
      env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR },
      config: {
        provider: 'ollama',
        ollama: { baseURL: `http://127.0.0.1:${mock.port}`, model: 'qwen3:8b', numCtx: 32768, think: 'auto' },
        theme: 'dark',
        remote: { enabled: false, bind: 'localhost', port: 0 },
        recentDirs: [F.PROJECT],
      },
    });
    const ev = app.evaluate;
    const win = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
    // A hidden window draws no frames by itself: keep every page painting so the starfield moves
    await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); ${win}.setContentSize(1440, 900); return true; })()`);

    await app.waitFor(`Boolean(document.querySelector('.session-item[data-id=${js(ids.main)}]'))`, 15_000, 'the seeded sessions');
    await app.click(`.session-item[data-id=${js(ids.main)}]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${js(ids.main)}`, 10_000, 'the main session');
    await ev(`(() => { if (!document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-close').click(); })()`);

    // The hero turn, so there is a conversation to dress
    F.scriptHero(mock);
    await app.send('Add rate limiting to the public routes: 100 requests a minute per client, 429 with Retry-After when over. Keep /health unlimited.');
    await app.approve('allow');
    await app.waitFor(`document.querySelector('#status-line').hidden`, 60_000, 'the hero run to end');
    await sleep(1200);

    // The set: a looks-only mod has no switch; using it puts its background and both looks in use at once
    await ev(`window.oc.rpc('mods.setEnabled', 'hyperspace', true)`);
    await sleep(600);
    await app.waitFor(`window.__oc_debug.mods.views().some((v) => v.key === 'hyperspace/starfield' && v.hello)`, 20_000, 'the starfield');

    // A run that does not end by itself: the stars stretch into streaks about two seconds in
    mock.state.replies.push({ when: F.isMain, delayMs: 30_000, content: 'Still going.' });
    await app.send('Run the load test once more and compare the two minutes.');
    await app.waitFor(`document.querySelector('#messages').dataset.running === 'true'`, 10_000, 'the run to start');
    await ev(`(() => { document.activeElement && document.activeElement.blur(); const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; })()`);
    await sleep(2600);
    await F.mainEval(inspect, `(async () => { const w = ${win}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
    await app.screenshot(out);
    console.log(`wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
    await ev(`window.oc.abort()`);
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
