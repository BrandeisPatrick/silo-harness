// Makes the screenshots for the 0.14.0 release notes, 1600 px wide (the whole window), in the light theme:
//   effort.png  the reasoning-effort menu open under the chat bar, after the model pill: Claude Haiku 5.5's levels,
//               High checked, below the end of an earlier exchange
//   timing.png  a run in which one reply asks for three read_file calls at once, its answer, and /timing's note on
//               where the run spent its time
//
// Like scripts/release-shots-0.13.0.js, whose start-up it follows, with the project, sessions and PNG helpers of
// scripts/readme-shots.js: the built app runs hidden on a throwaway profile against the scripted model
// (test/support/mock-model.js), and nothing leaves the machine.
//   - Both scenes use an Anthropic-type provider pointed at the scripted model, with model claude-haiku-5-5 (a model
//     that takes an effort setting, as in test/live/effort.js) and an obviously fake key. effort.png has the
//     provider's effort set to high in its config.
//   - effort.png: one short exchange first, so the chat ends just above the chat bar.
//   - timing.png: the scripted replies are held back (waiting) and stream their thinking and text in pieces (thinking,
//     writing). A PostToolUse hook in the throwaway settings.json sleeps 0.3 s after each read, so the reads take
//     visible time (PostToolUse runs inside a call, so the three still overlap; a PreToolUse hook would not, as calls
//     are prepared one at a time). The note is the app's own answer to /timing, as printed.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/release-shots-0.14.0.js [out-dir] [--only=effort,timing]     default: docs/releases/0.14.0
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock } = require('../test/support/mock-model.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs', 'releases', '0.14.0'));
const ONLY = (args.find((a) => a.startsWith('--only=')) || '--only=effort,timing').slice(7).split(',');
const WIDTH = 1600;
// The window is 1000 px wide at 1.6x: the image is the whole window, 1600 px
const SCALE = 1.6;
const js = JSON.stringify;
const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;

/** The app on a throwaway profile, hidden, against the scripted model as an Anthropic-type provider. */
async function start(mock, size, provider = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-release-shot-'));
  const ids = F.seedSessions(profile);
  const inspect = await F.freePort(0);
  const app = await launch({
    args: [`--inspect=${inspect}`],
    profile,
    project: F.PROJECT,
    mock: true,
    mode: 'auto',
    size,
    scale: SCALE,
    env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
    config: {
      provider: 'claude',
      providers: {
        claude: { type: 'anthropic', baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'sk-example-not-a-real-key', model: 'claude-haiku-5-5', models: ['claude-haiku-5-5', 'claude-opus-4-6'], ...provider },
      },
      theme: 'light',
      remote: { enabled: false, bind: 'localhost', port: 0 },
      recentDirs: [F.PROJECT],
    },
  });
  try {
    // A hidden window only draws while asked to: keep every view drawing, and give the window the page's size
    await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); ${WIN}.setContentSize(${size.width}, ${size.height}); return true; })()`);
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: SCALE, mobile: false });
    await app.waitFor(`Boolean(document.querySelector('.session-item[data-id=${js(ids.main)}]'))`, 15_000, 'the seeded sessions');
    await app.click(`.session-item[data-id=${js(ids.main)}]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${js(ids.main)}`, 10_000, 'the session');
    // The side pane and the rail closed, as on a first start
    await app.evaluate(`(() => { if (!document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-close').click(); const r = document.querySelector('#rail-toggle'); if (r && !r.hidden && r.getAttribute('aria-pressed') === 'true') r.click(); })()`);
  } catch (e) {
    await app.close();
    throw e;
  }
  return { app, inspect, profile };
}

async function stop(s, mock) {
  if (s) {
    await s.app.close();
    fs.rmSync(s.profile, { recursive: true, force: true });
  }
  mock.close();
}

/** Takes the whole window and keeps rows y … y + height (CSS pixels), the full width. */
async function capture({ app, inspect }, y, height, file) {
  // Nothing in the window may show a real home path
  const leak = await app.evaluate(`document.body.innerText.includes(${js(os.homedir())}) || document.body.innerText.includes(${js(F.HOME)})`);
  if (leak) throw new Error('a real or temporary home path shows in the window');
  await app.evaluate(`document.activeElement && document.activeElement !== document.body && !document.activeElement.closest('.popover') && document.activeElement.blur()`);
  await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
  await sleep(150);
  const cap = await app.cdp('Page.captureScreenshot', { format: 'png' });
  const png = F.cropPng(Buffer.from(cap.data, 'base64'), 0, Math.round(y * SCALE), WIDTH, Math.round(height * SCALE));
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB)`);
}

// ---------- effort.png ----------

async function sceneEffort() {
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  const size = { width: 1000, height: 620 };
  let s;
  try {
    s = await start(mock, size, { effort: 'high' });
    const { app } = s;
    mock.state.replies.push({ delayMs: 400, content: 'Yes: `/health` answers before any middleware, so the load balancer\'s checks never count against a client. The limiter goes on the `/v1` routes only.' });
    await app.send('Will the limiter also catch the load balancer\'s health checks?');
    await app.waitIdle(30_000);
    await app.waitFor(`!document.querySelector('#effort-btn').hidden && document.querySelector('#effort-btn').innerText.trim() === 'High'`, 15_000, 'the effort pill at High');
    await app.evaluate(`(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; })()`);
    await app.evaluate(`document.querySelector('#effort-btn').click()`);
    await app.waitFor(`Boolean(document.querySelector('.popover[role=menu]'))`, 5_000, 'the effort menu');
    await sleep(600);
    const items = await app.evaluate(`[...document.querySelectorAll('.popover[role=menu] button')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim() + (b.getAttribute('aria-checked') === 'true' ? ' [checked]' : ''))`);
    console.log('menu:', items.join(' | '));
    const r = await app.evaluate(`(() => {
      const m = document.querySelector('.popover[role=menu]').getBoundingClientRect();
      const chat = document.querySelector('#messages').getBoundingClientRect();
      return { menuTop: m.top, chatTop: chat.top, bottom: window.innerHeight };
    })()`);
    console.log('rect', js(r));
    const y = Math.max(r.chatTop, r.menuTop - 162);
    await capture(s, y, r.bottom - y, path.join(OUT, 'effort.png'));
  } finally {
    await stop(s, mock);
  }
}

// ---------- timing.png ----------

const HOOKS = { hooks: { PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'sleep 0.3', timeout: 10 }] }] } };

function scriptTiming(mock) {
  const think = (t) => t.match(/.{1,24}(\s|$)/g);
  mock.state.replies.push({
    delayMs: 900,
    thinkingChunks: think('A request enters in server.js, goes through the requestId middleware, then routes.js answers. Reading all three.'),
    chunkDelayMs: 90,
    usage: { input_tokens: 1450, cache_read_input_tokens: 8200 },
    toolCalls: [F.call('read_file', { path: 'src/server.js' }), F.call('read_file', { path: 'src/middleware/requestId.js' }), F.call('read_file', { path: 'src/routes.js' })],
  });
  const answer =
    'A request goes through three steps:\n\n1. `src/server.js` creates the HTTP server and runs every request through the middleware first.\n2. `src/middleware/requestId.js` gives it an id (from `X-Request-Id` when the caller sent one) and echoes it back in the response.\n3. `src/routes.js` matches the method and path and answers with JSON: the product list, one product, `/health` or `/status`.\n\nNothing else sits in between, so a rate limiter would go in step 1, before the routes.';
  mock.state.replies.push({ delayMs: 700, chunks: answer.match(/[^]{1,40}/g), chunkDelayMs: 25, usage: { input_tokens: 2100, cache_read_input_tokens: 9650 } });
}

async function sceneTiming() {
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  fs.mkdirSync(F.CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(F.CONFIG_DIR, 'settings.json'), JSON.stringify(HOOKS, null, 2));
  const size = { width: 1000, height: 1000 };
  let s;
  try {
    s = await start(mock, size);
    const { app } = s;
    scriptTiming(mock);
    await app.send('Walk me through what happens to a request, from the server to the route that answers it.');
    await app.waitIdle(90_000);
    // Approval cards are not expected (reads in Auto mode); fail loudly if one waits
    if (await app.exists('.approval:not(.decided)')) throw new Error('an approval card is waiting');
    await app.send('/timing');
    await app.waitFor(`[...document.querySelectorAll('#messages > .msg.system.notice')].some((e) => /Slowest turn/.test(e.innerText))`, 10_000, 'the /timing note');
    const note = await app.evaluate(`[...document.querySelectorAll('#messages > .msg.system.notice')].pop().innerText.trim()`);
    console.log('timing note:\n' + note);
    // The tool line opened to its three rows
    await app.evaluate(`(() => { const g = [...document.querySelectorAll('#messages > .tool-group')].pop(); if (g && !g.open) g.querySelector(':scope > summary').click(); })()`);
    await sleep(600);
    await app.evaluate(`(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; })()`);
    await sleep(1200);
    const r = await app.evaluate(`(() => {
      const chat = document.querySelector('#messages').getBoundingClientRect();
      const u = [...document.querySelectorAll('#messages > .msg.user')].find((e) => /Walk me through/.test(e.innerText));
      const top = u.getBoundingClientRect().top;
      const end = [...document.querySelectorAll('#messages > .msg.system.notice')].pop().getBoundingClientRect().bottom;
      return { chatTop: chat.top, chatBottom: chat.bottom, top, end };
    })()`);
    console.log('rect', js(r));
    if (r.top < r.chatTop) throw new Error('the run does not fit in the window: make it taller');
    const y = Math.max(r.chatTop, r.top - 20);
    await capture(s, y, Math.min(r.chatBottom, r.end + 24) - y, path.join(OUT, 'timing.png'));
  } finally {
    await stop(s, mock);
    fs.rmSync(path.join(F.CONFIG_DIR, 'settings.json'), { force: true });
  }
}

// ---------- main ----------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  try {
    if (ONLY.includes('effort')) await sceneEffort();
    if (ONLY.includes('timing')) await sceneTiming();
  } finally {
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
