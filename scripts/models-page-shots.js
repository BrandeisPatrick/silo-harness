// Makes pictures of Settings → Models, 1600 px wide, in the light theme:
//   models-page.png          the top of the page: In use (provider, model, Safety check and its test) and Connected
//   models-row-tested.png    Connected after two row tests: one answered (through the gateway), one refused (OpenRouter)
//   models-check-select.png  In use after choosing a model for the safety check: what it runs on now, the eval line
//   models-check-test.png    "Test as safety check" after a run: judged right, let through, blocked wrongly, the time
//
// Like scripts/release-shots-0.19.0.js, whose capture it follows, with the made-up home of scripts/readme-shots.js.
// The built app runs hidden on a throwaway profile against two scripted mock services (test/support/mock-model.js): a
// gateway with four models and an OpenRouter-style provider with a longer list. Ollama points at a closed port, so its
// group says it is not reachable. Nothing leaves the machine; nothing on the page is edited.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/models-page-shots.js [out-dir]     default: shots/ (not committed)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock, classifierReply } = require('../test/support/mock-model.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'shots'));
const WIDTH = 1600;
const js = JSON.stringify;
const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
const OR_KEY = 'mock-openrouter-key-0123456789';
const GATEWAY_MODELS = ['@anthropic/claude-opus-5-5', '@anthropic/claude-sonnet-5-5', '@anthropic/claude-haiku-5-5', '@openai/gpt-5.6-mini'];
const OPENROUTER_MODELS = [
  'anthropic/claude-haiku-5.5',
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'deepseek/deepseek-v4',
  'google/gemini-3-flash',
  'google/gemini-3-pro',
  'meta-llama/llama-4-maverick',
  'mistralai/devstral-medium',
  'moonshotai/kimi-k3',
  'openai/gpt-5.6',
  'openai/gpt-5.6-mini',
  'qwen/qwen3-coder',
  'x-ai/grok-5',
  'z-ai/glm-5',
];

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

/** The settings dialog's rectangle, or the part of it from `fromSel` (its top, less a margin) to the dialog's bottom. */
const dialogBox = (app) => app.evaluate(`(() => { const r = document.querySelector('#settings').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  const gw = await startMock();
  gw.state.models = GATEWAY_MODELS;
  const or = await startMock();
  or.state.apiKey = OR_KEY;
  or.state.models = OPENROUTER_MODELS;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-models-shot-'));
  const size = { width: 1280, height: 900 };
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
      env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR, MOCK_OPENROUTER_KEY: OR_KEY, GROQ_API_KEY: '' },
      config: {
        theme: 'light',
        remote: { enabled: false, bind: 'localhost', port: 0 },
        recentDirs: [F.PROJECT],
        provider: 'portkey',
        ollama: { baseURL: 'http://127.0.0.1:9/v1', model: '', numCtx: 16384, think: 'auto' },
        portkey: { baseURL: `http://127.0.0.1:${gw.port}/v1`, apiKey: '', model: GATEWAY_MODELS[0], virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
        providers: { openrouter: { type: 'openrouter', baseURL: `http://127.0.0.1:${or.port}/v1`, apiKeyEnv: 'MOCK_OPENROUTER_KEY', model: 'anthropic/claude-sonnet-5.5' } },
      },
    });
    const s = { app, inspect, size };
    // A hidden window only draws while asked to: keep it drawing, at the page's size
    await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); ${WIN}.setContentSize(${size.width}, ${size.height}); return true; })()`);
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
    await app.evaluate(`document.querySelector('#settings-btn').click()`);
    await sleep(300);
    await app.click('#sp-nav-model');
    await app.waitFor(`document.querySelectorAll('#sp-sec-model .sp-provider').length === 3 && !document.querySelector('#sp-sec-model').innerText.includes('Checking…') && /Runs on/.test(document.querySelector('#sp-row-autoMode-model .sp-row-desc')?.textContent || '')`, 15_000, 'the Models page');
    const body = (y) => app.evaluate(`document.querySelector('#settings-body').scrollTop = ${y}`);
    const scrollTo = (sel, gap = 16) => app.evaluate(`(() => { const b = document.querySelector('#settings-body'); const e = document.querySelector(${js(sel)}); b.scrollTop += e.getBoundingClientRect().top - b.getBoundingClientRect().top - ${gap}; })()`);

    // 1. The top of the page
    await body(0);
    await sleep(1200);
    await capture(s, await dialogBox(app), path.join(OUT, 'models-page.png'));

    // 2. Two row tests: one answered through the gateway, one refused by OpenRouter
    gw.state.replies.push({ nonStream: true, content: 'ok', delayMs: 840 });
    await app.evaluate(`[...document.querySelectorAll('.sp-provider[data-provider-name="portkey"] .sp-model[data-model="@anthropic/claude-haiku-5-5"] button')].find((b) => b.innerText.trim() === 'Test').click()`);
    await app.waitFor(`/Answered in/.test(document.querySelector('.sp-provider[data-provider-name="portkey"] .sp-model[data-model="@anthropic/claude-haiku-5-5"]').innerText)`, 10_000, 'the answered test');
    or.state.replies.push({ nonStream: true, status: 429, error: 'Rate limit exceeded: free-models-per-day. Add credits to unlock more requests.' });
    await app.evaluate(`[...document.querySelectorAll('.sp-provider[data-provider-name="openrouter"] .sp-model[data-model="anthropic/claude-haiku-5.5"] button')].find((b) => b.innerText.trim() === 'Test').click()`);
    await app.waitFor(`/HTTP 429/.test(document.querySelector('.sp-provider[data-provider-name="openrouter"] .sp-model[data-model="anthropic/claude-haiku-5.5"]').innerText)`, 10_000, 'the refused test');
    await scrollTo('.sp-provider[data-provider-name="portkey"]');
    await sleep(800);
    await capture(s, await dialogBox(app), path.join(OUT, 'models-row-tested.png'));

    // 3. A model for the safety check
    await app.fill('#autoMode-model', `portkey:${GATEWAY_MODELS[2]}`);
    await app.waitFor(`document.querySelector('#sp-row-autoMode-model .sp-row-desc').textContent === 'Runs on Claude Haiku 5.5 through Gateway.'`, 10_000, 'the check model');
    await sleep(2000); // the Saved tick fades
    await body(0);
    await sleep(800);
    await capture(s, await dialogBox(app), path.join(OUT, 'models-check-select.png'));

    // 4. Test as safety check: the mock judges each action as labelled, with one safe action blocked
    const { checkTestItems } = require(path.join(ROOT, 'dist', 'main', 'agent', 'check-test.js'));
    checkTestItems().forEach((it, i) => gw.state.replies.push(classifierReply(it.id === 'force-push-named' ? 'block' : it.label, `[Eval] ${it.id}`, { delayMs: 620 + ((i * 137) % 520) })));
    await app.evaluate(`[...document.querySelectorAll('#sp-row-autoMode-checkTest button')].find((b) => b.innerText.trim() === 'Run test').click()`);
    await app.waitFor(`/Judged/.test(document.querySelector('#sp-row-autoMode-checkTest .sp-check-result')?.innerText || '')`, 60_000, 'the check test');
    await scrollTo('#sp-row-autoMode-model', 12);
    await sleep(800);
    await capture(s, await dialogBox(app), path.join(OUT, 'models-check-test.png'));
  } finally {
    await app?.close();
    gw.close();
    or.close();
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
