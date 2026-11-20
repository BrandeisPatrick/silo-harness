// Makes the images for the 0.20.0 release notes (Settings → Models), 1600 px wide, in the light theme:
//   models-page.png  In use (provider Anthropic, the model, "Think before acting" on, Safety check) and the start of
//                    Connected: the "Through Anthropic" group, Test and Use on its rows, one row after a test
//                    ("Answered in … ms")
//   check-test.png   the Safety check set to a smaller model (Claude Haiku 5.5) and the finished "Test as safety
//                    check": judged right, no risky action let through, one safe action blocked, the median time
//
// Like scripts/release-shots-0.19.0.js, whose capture it follows, with the made-up home of scripts/readme-shots.js.
// The built app runs hidden on a throwaway profile against two scripted mock services (test/support/mock-model.js):
// one in the shape of Anthropic's own API (a provider of type anthropic, so "Think before acting" applies) with three
// models, and one behind the built-in gateway block, so it reaches no real host. Ollama points at a closed port.
// Nothing leaves the machine. Nothing on the page is edited; the dialog is only let grow past its 800 px height in
// the tall hidden window, so the first picture is one piece. The Connected list is cut after its first group.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/release-shots-0.20.0.js [out-dir]     default: docs/releases/0.20.0
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock, classifierReply } = require('../test/support/mock-model.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'releases', '0.20.0'));
const WIDTH = 1600;
const js = JSON.stringify;
const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
const MARGIN = 24;
const AN_KEY = 'mock-anthropic-key-0123456789';
const ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const GATEWAY_MODELS = ['@anthropic/claude-opus-5-5', '@anthropic/claude-sonnet-5-5', '@anthropic/claude-haiku-5-5', '@openai/gpt-5.6-mini'];

/**
 * Takes the whole window and keeps the rectangle x, y, width, height (CSS pixels), drawn at 1600 / width device
 * pixels per CSS pixel, so the image is exactly 1600 px wide.
 */
async function capture({ app, inspect, size }, { x, y, width, height }, file) {
  const leak = await app.evaluate(`document.body.innerText.includes(${js(os.homedir())}) || document.body.innerText.includes(${js(F.HOME)}) || document.body.innerText.includes(${js(os.tmpdir())})`);
  if (leak) throw new Error('a real or temporary home path shows in the window');
  await app.evaluate(`document.activeElement && document.activeElement !== document.body && document.activeElement.blur()`);
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: size.width - 2, y: size.height - 2 });
  const scale = WIDTH / width;
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: scale, mobile: false });
  await sleep(300);
  await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
  await app.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
  await sleep(150);
  const cap = await app.cdp('Page.captureScreenshot', { format: 'png' });
  const png = F.cropPng(Buffer.from(cap.data, 'base64'), Math.round(x * scale), Math.round(y * scale), WIDTH, Math.round(height * scale));
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB, ${WIDTH} x ${Math.round(height * scale)})`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  const an = await startMock();
  an.state.anthropicModels = true;
  an.state.apiKey = AN_KEY;
  an.state.models = ANTHROPIC_MODELS;
  const gw = await startMock();
  gw.state.models = GATEWAY_MODELS;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-models-shot-'));
  // Tall enough that In use and the first Connected group show at once
  const size = { width: 1280, height: 1800 };
  const inspect = await F.freePort(0);
  let app;
  try {
    app = await launch({
      args: [`--inspect=${inspect}`],
      profile,
      project: F.PROJECT,
      mock: true,
      size,
      scale: 1,
      env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR, MOCK_ANTHROPIC_KEY: AN_KEY, GROQ_API_KEY: '' },
      config: {
        theme: 'light',
        remote: { enabled: false, bind: 'localhost', port: 0 },
        recentDirs: [F.PROJECT],
        provider: 'anthropic',
        ollama: { baseURL: 'http://127.0.0.1:9/v1', model: '', numCtx: 16384, think: 'auto' },
        portkey: { baseURL: `http://127.0.0.1:${gw.port}/v1`, apiKey: '', model: GATEWAY_MODELS[0], virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
        providers: { anthropic: { type: 'anthropic', baseURL: `http://127.0.0.1:${an.port}/v1`, apiKeyEnv: 'MOCK_ANTHROPIC_KEY', model: ANTHROPIC_MODELS[0] } },
      },
    });
    const s = { app, inspect, size };
    // A hidden window only draws while asked to: keep it drawing, at the page's size
    await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); ${WIN}.setContentSize(${size.width}, ${size.height}); return true; })()`);
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
    await app.evaluate(`document.querySelector('#settings-btn').click()`);
    await sleep(300);
    // The dialog stops at 800 px high; let it take the tall window, so the first picture is one piece (layout only)
    await app.evaluate(`document.head.append(Object.assign(document.createElement('style'), { textContent: '#settings { height: calc(100vh - 48px) !important; }' }))`);
    await app.click('#sp-nav-model');
    await app.waitFor(`document.querySelectorAll('#sp-sec-model .sp-provider').length === 3 && !document.querySelector('#sp-sec-model').innerText.includes('Checking…') && /Runs on/.test(document.querySelector('#sp-row-autoMode-model .sp-row-desc')?.textContent || '')`, 15_000, 'the Models page');
    await app.waitFor(`/as Claude Code does/.test(document.querySelector('#sp-row-thinking .sp-row-desc')?.textContent || '')`, 10_000, 'Think before acting on Anthropic');
    const body = (y) => app.evaluate(`document.querySelector('#settings-body').scrollTop = ${y}`);
    const scrollTo = (sel, gap = 16) => app.evaluate(`(() => { const b = document.querySelector('#settings-body'); const e = document.querySelector(${js(sel)}); b.scrollTop += e.getBoundingClientRect().top - b.getBoundingClientRect().top - ${gap}; })()`);
    /** The Models section's column, from the top of `fromSel` to the bottom of `toSel`, with a margin all round */
    const column = (fromSel, toSel, top = MARGIN, bottom = MARGIN) => app.evaluate(`(() => { const c = document.querySelector('#sp-sec-model').getBoundingClientRect(); const a = document.querySelector(${js(fromSel)}).getBoundingClientRect(); const b = document.querySelector(${js(toSel)}).getBoundingClientRect(); return { x: c.x - ${MARGIN}, y: a.top - ${top}, width: c.width + 2 * ${MARGIN}, height: b.bottom - a.top + ${top} + ${bottom} }; })()`);
    const group = (name) => `.sp-provider[data-provider-name="${name}"]`;
    const row = (name, m) => `${group(name)} .sp-model[data-model="${m}"]`;
    const clickTest = (sel) => app.evaluate(`[...document.querySelectorAll(${js(sel + ' button')})].find((b) => b.innerText.trim() === 'Test').click()`);

    // 1. In use and the start of Connected, after a row test through Anthropic
    an.state.replies.push({ nonStream: true, content: 'ok', delayMs: 840 });
    await clickTest(row('anthropic', ANTHROPIC_MODELS[1]));
    await app.waitFor(`/Answered in/.test(document.querySelector(${js(row('anthropic', ANTHROPIC_MODELS[1]))}).innerText)`, 10_000, 'the answered test');
    await body(0);
    await sleep(1200);
    await capture(s, await column('#sp-sec-model .sp-group-title', group('anthropic'), 8, MARGIN), path.join(OUT, 'models-page.png'));

    // 2. A smaller model for the safety check, and Test as safety check: the mock judges each action as labelled,
    //    with one safe action blocked
    await app.fill('#autoMode-model', `anthropic:${ANTHROPIC_MODELS[2]}`);
    await app.waitFor(`/^Runs on Claude Haiku 5.5 through Anthropic/.test(document.querySelector('#sp-row-autoMode-model .sp-row-desc').textContent)`, 10_000, 'the check model');
    const { checkTestItems } = require(path.join(ROOT, 'dist', 'main', 'agent', 'check-test.js'));
    checkTestItems().forEach((it, i) => an.state.replies.push(classifierReply(it.id === 'force-push-named' ? 'block' : it.label, `[Eval] ${it.id}`, { delayMs: 620 + ((i * 137) % 520) })));
    await app.evaluate(`[...document.querySelectorAll('#sp-row-autoMode-checkTest button')].find((b) => b.innerText.trim() === 'Run test').click()`);
    await app.waitFor(`/Judged/.test(document.querySelector('#sp-row-autoMode-checkTest .sp-check-result')?.innerText || '')`, 60_000, 'the check test');
    await sleep(2000); // the Saved tick fades
    await body(0);
    await sleep(800);
    await capture(s, await column('#sp-row-autoMode-model', '#sp-row-autoMode-checkTest .sp-check-result', 2, MARGIN), path.join(OUT, 'check-test.png'));
  } finally {
    await app?.close();
    an.close();
    gw.close();
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
