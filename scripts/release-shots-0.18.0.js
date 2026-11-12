// Makes the images for the 0.18.0 release notes (what a run is doing, and /report), 1600 px wide, in the light theme:
//   status-line.png  the lower part of the chat while the model writes a large file: the user's request, the read so
//                    far, and the status line under the chat reading "Writing a file… 12 KB" (the call's row comes
//                    only once its input is complete), then the composer
//   report.png       /report typed after a session of three turns that used tools (reads, a write, an edit, commands
//                    that Auto mode's safety check passed, one model call tried again after a 529): the card of
//                    numbers it shows in the chat (turns, model and tool calls, waits, checks, retries, the longest
//                    silent stretches)
//
// Like scripts/release-shots-0.16.0.js, whose start-up and capture it follows, with the made-up home, project and
// sessions of scripts/readme-shots.js, and the scripted replies of test/live/run-visibility.js: the built app runs
// hidden on a throwaway profile against the scripted model (test/support/mock-model.js), and nothing leaves the
// machine. Every number on screen is what the app works out from the scripted run; nothing on the page is edited.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/release-shots-0.18.0.js [out-dir] [--only=status,report]     default: docs/releases/0.18.0
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock, classifierReply } = require('../test/support/mock-model.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs', 'releases', '0.18.0'));
const ONLY = (args.find((a) => a.startsWith('--only=')) || '--only=status,report').slice(7).split(',');
const WIDTH = 1600;
const MARGIN = 24;
const js = JSON.stringify;
const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
const MODEL = 'claude-sonnet-5-5';

/** The app on a throwaway profile, hidden, against the scripted model, in the seeded session, the sidebar closed. */
async function start(mock, size, scale) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-release-shot-'));
  fs.writeFileSync(path.join(F.HOME, '.zprofile'), `export PATH=${js(process.env.PATH)}\n`);
  const ids = F.seedSessions(profile);
  const inspect = await F.freePort(0);
  const app = await launch({
    args: [`--inspect=${inspect}`],
    profile,
    project: F.PROJECT,
    mock: true,
    mode: 'auto',
    size,
    scale,
    env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
    config: {
      theme: 'light',
      remote: { enabled: false, bind: 'localhost', port: 0 },
      recentDirs: [F.PROJECT],
      provider: 'portkey',
      portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: '', model: MODEL, virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    },
  });
  try {
    // A hidden window only draws while asked to: keep every view drawing, and give the window the page's size
    await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); ${WIN}.setContentSize(${size.width}, ${size.height}); return true; })()`);
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: scale, mobile: false });
    await app.waitFor(`Boolean(document.querySelector('.session-item[data-id=${js(ids.main)}]'))`, 15_000, 'the seeded sessions');
    await app.click(`.session-item[data-id=${js(ids.main)}]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${js(ids.main)}`, 10_000, 'the session');
    // The side pane and the rail closed, as on a first start
    await app.evaluate(`(() => { if (!document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-toggle').click(); const r = document.querySelector('#rail-toggle'); if (r && !r.hidden && r.getAttribute('aria-pressed') === 'true') r.click(); })()`);
    await hideSidebar(app);
  } catch (e) {
    await app.close();
    throw e;
  }
  return { app, inspect, profile, size, scale };
}

async function stop(s, mock) {
  if (s) {
    await s.app.close();
    fs.rmSync(s.profile, { recursive: true, force: true });
  }
  mock.close();
}

/**
 * Takes the whole window and keeps the rectangle x, y, width, height (CSS pixels). The window is drawn at
 * 1600 / width device pixels per CSS pixel, so the image is exactly 1600 px wide.
 */
async function capture({ app, inspect, size }, { x, y, width, height }, file) {
  // Nothing in the window may show a real home path
  const leak = await app.evaluate(`document.body.innerText.includes(${js(os.homedir())}) || document.body.innerText.includes(${js(F.HOME)})`);
  if (leak) throw new Error('a real or temporary home path shows in the window');
  await app.evaluate(`document.activeElement && document.activeElement !== document.body && document.activeElement.blur()`);
  // The pointer out of the way, so nothing shows a hover
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: size.width - 2, y: size.height - 2 });
  const scale = WIDTH / width;
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: scale, mobile: false });
  await sleep(300);
  await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
  // A tiny clipped capture first: the hidden window's next full capture is then a fresh frame at the emulated scale
  await app.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
  await sleep(150);
  const cap = await app.cdp('Page.captureScreenshot', { format: 'png' });
  const png = F.cropPng(Buffer.from(cap.data, 'base64'), Math.round(x * scale), Math.round(y * scale), WIDTH, Math.round(height * scale));
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB, ${WIDTH} x ${Math.round(height * scale)})`);
}

/** Closes the sessions sidebar, so the chat gets the window's width. */
async function hideSidebar(app) {
  const open = await app.evaluate(`(() => { const s = document.querySelector('#sidebar'); return Boolean(s && s.getBoundingClientRect().width > 40); })()`);
  if (open) await app.click('#sidebar-toggle');
  await sleep(500);
}

/** The status line's text, or null when it is hidden */
const statusText = (app) => app.evaluate(`(() => { const s = document.querySelector('#status-line'); return s && !s.hidden ? document.querySelector('#status-text').textContent : null; })()`);

/** Scrolled to the end of the chat; a scroll shows the overlay scroll bar for a moment, so it is left to fade. */
async function toEnd(app) {
  const scrolled = await app.evaluate(`(() => { const m = document.querySelector('#messages'); const end = m.scrollHeight - m.clientHeight; if (m.scrollTop >= end - 1) return false; m.scrollTop = end; return true; })()`);
  await sleep(scrolled ? 3000 : 800);
}

// ---------- status-line.png ----------

const DOC_REQUEST = 'Write docs/api-reference.md: every public route with its method, rate limit, and an example request and response.';

/** The reference the model writes: about 48 KB, sent in four pieces 12 s apart, so the line holds each size a while. */
function apiReference() {
  const routes = ['GET /v1/products', 'GET /v1/products/:id', 'GET /health', 'GET /status'];
  const out = ['# atlas-api reference', ''];
  // 48 KB of the call's input as sent (the JSON of its arguments), so the first piece reads 12 KB
  for (let i = 0; js({ path: 'docs/api-reference.md', content: out.join('\n') }).length < 48 * 1024 - 600; i++) {
    const r = routes[i % routes.length];
    out.push(`## ${r} (example ${Math.floor(i / routes.length) + 1})`, '', 'Limited to 100 requests a minute per client IP; /health is not limited.', '', '```http', `${r.replace(':id', 'p-1042')} HTTP/1.1`, 'Host: api.atlas.example', '```', '', '```json', '{ "id": "p-1042", "name": "Trail runner", "price": 129.0, "currency": "EUR" }', '```', '');
  }
  return out.join('\n');
}

async function sceneStatus() {
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.models = [MODEL, 'claude-haiku-5-5', 'claude-opus-5-5'];
  // Short enough that the conversation fills the chat down to the status line
  const size = { width: 1000, height: 540 };
  let s;
  try {
    s = await start(mock, size, 1.6);
    const { app } = s;
    const main = (r) => mock.state.replies.push({ delayMs: 2500, ...r, when: F.isMain });
    main({ promptTokens: 14_180, toolCalls: [F.call('read_file', { path: 'src/routes.js' })] });
    main({ promptTokens: 15_020, delayMs: 1500, toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'docs/api-reference.md', content: apiReference() } }], argChunks: 4, chunkDelayMs: 12_000 });
    main({ promptTokens: 27_400, content: 'Wrote docs/api-reference.md.' });
    await app.send(DOC_REQUEST);
    await app.waitFor(`/^Writing a file… \\d+ KB$/.test(document.querySelector('#status-text')?.textContent ?? '')`, 30_000, 'the Writing a file line');
    const t = await statusText(app);
    console.log('status text:', t);
    const row = await app.evaluate(`Boolean(document.querySelector('#messages .tool[data-call-id="w1"]'))`);
    if (row) throw new Error('the write row is already there');
    const uncut = await app.evaluate(`(() => { const t = document.querySelector('#status-text'); return t.scrollWidth <= t.clientWidth + 1; })()`);
    if (!uncut) throw new Error('the status line is cut');
    await toEnd(app);
    const line = await app.evaluate(`document.querySelector('#status-line').innerText.replace(/\\s+/g, ' ').trim()`);
    console.log('status line:', line);
    // From a little above the user's request down to the bottom of the composer
    const r = await app.evaluate(`(() => {
      const box = (e) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
      const u = [...document.querySelectorAll('#messages > .msg.user')].pop();
      const prev = u.previousElementSibling;
      return { chat: box(document.querySelector('#messages')), user: box(u), above: prev && !prev.hidden && prev.getClientRects().length ? box(prev).bottom : -Infinity, composer: box(document.querySelector('#chatbar')), status: box(document.querySelector('#status-line')) };
    })()`);
    console.log('rect:', js(r));
    const y = Math.ceil(Math.max(r.chat.top, r.user.top - 28, r.above + 2));
    const bottom = Math.min(size.height, r.composer.bottom + 16);
    await capture(s, { x: 4, y, width: size.width - 16, height: bottom - y }, path.join(OUT, 'status-line.png'));
    const after = await statusText(app);
    if (after !== t) console.log(`note: the line read "${after}" just after the capture`);
  } finally {
    await stop(s, mock);
  }
}

// ---------- report.png ----------

/** Three turns that use tools; one model call fails with a 529 and is tried again. */
function scriptReport(mock) {
  const main = (r) => mock.state.replies.push({ delayMs: 2200, ...r, when: F.isMain });
  const check = (ms) => mock.state.replies.push(classifierReply('allow', '[Local Work] runs the project tests', { delayMs: ms }));
  // Turn 1
  main({ promptTokens: 14_180, toolCalls: [F.call('read_file', { path: 'src/server.js' })] });
  main({ promptTokens: 15_020, delayMs: 4200, toolCalls: [F.call('write_file', { path: 'src/middleware/rateLimit.js', content: F.RATE_LIMIT_JS })] });
  main({
    promptTokens: 16_240,
    toolCalls: [
      F.call('edit_file', {
        path: 'src/server.js',
        old_string: "const routes = require('./routes');\n\nfunction createServer() {\n  const stack = [requestId];",
        new_string: "const { rateLimit } = require('./middleware/rateLimit');\nconst routes = require('./routes');\n\nfunction createServer() {\n  const limiter = rateLimit({ limit: 100, windowMs: 60_000, skip: (req) => req.url === '/health' });\n  const stack = [requestId, limiter];",
      }),
    ],
  });
  main({ promptTokens: 18_050, toolCalls: [F.call('bash', { command: 'npm test' })] });
  check(1800);
  main({ promptTokens: 18_420, content: 'Public routes now allow 100 requests a minute per client IP, and `/health` stays unlimited. The tests pass.' });
  // Turn 2: the first call is refused as busy (529) and tried again
  mock.state.replies.push({ status: 529, error: 'Overloaded (mock)', headers: { 'retry-after': '2' }, delayMs: 900, when: F.isMain });
  main({ promptTokens: 18_900, toolCalls: [F.call('read_file', { path: 'test/routes.test.js' })] });
  main({ promptTokens: 19_700, toolCalls: [F.call('bash', { command: 'npm test -- --test-reporter=spec' })] });
  check(2400);
  main({ promptTokens: 20_300, content: 'All routes are covered; the limiter is exercised through `/v1/products`.' });
  // Turn 3
  main({ promptTokens: 20_800, toolCalls: [F.call('bash', { command: 'git status --short' })] });
  main({ promptTokens: 21_100, content: 'Two files changed: `src/server.js` and the new `src/middleware/rateLimit.js`.' });
}

const TURNS = [
  'Add rate limiting to the public routes: 100 requests a minute per client IP, with /health left out. Then run the tests.',
  'Do the tests cover the limited routes?',
  'Which files changed?',
];

async function sceneReport() {
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.models = [MODEL, 'claude-haiku-5-5', 'claude-opus-5-5'];
  // Tall enough for the whole card
  const size = { width: 1000, height: 1500 };
  let s;
  try {
    s = await start(mock, size, 1.6);
    const { app } = s;
    // A new session, so the report covers only the turns below
    await app.evaluate(`document.querySelector('#new-session-btn').click()`);
    await app.waitFor(`!document.querySelector('#messages > .msg.user')`, 10_000, 'a new session');
    await sleep(500);
    scriptReport(mock);
    for (const t of TURNS) {
      await app.send(t);
      await sleep(500);
      await app.waitIdle(90_000);
    }
    const asked = mock.state.requests.length;
    await app.send('/report');
    const sel = `[...document.querySelectorAll('#messages > .msg.system.notice.card')].pop()`;
    await app.waitFor(`[...document.querySelectorAll('#messages > .msg.system.notice.card')].some((c) => c.innerText.includes('Session report'))`, 10_000, 'the report card');
    const card = await app.evaluate(`${sel}.innerText`);
    console.log(card.replace(/^/gm, '    '));
    if (mock.state.requests.length !== asked) throw new Error('/report sent a request to the model');
    if (!/3 turns/.test(card) || !/Retries\s+1/.test(card) || !/Safety checks\s+\d/.test(card)) throw new Error('the card does not show the three turns, the retry and the checks');
    await toEnd(app);
    const r = await app.evaluate(`(() => {
      const box = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; };
      const c = ${sel};
      const prev = c.previousElementSibling;
      const m = document.querySelector('#messages');
      return { pad: getComputedStyle(m).paddingBottom, scroll: [m.scrollTop, m.scrollHeight, m.clientHeight], chat: box(m), card: box(c), prev: prev ? { cls: prev.className, text: prev.innerText.slice(0, 40), ...box(prev) } : null };
    })()`);
    console.log('rect:', js(r));
    if (r.card.top < r.chat.top || r.card.bottom > r.chat.bottom) throw new Error('the card does not fit the chat: make the window taller');
    // The /report message above the card, when it shows as one
    const top = r.prev && /\/report/.test(r.prev.text) && r.prev.top >= r.chat.top ? r.prev.top : r.card.top;
    const x = r.card.left - MARGIN;
    const width = r.card.width + 2 * MARGIN;
    const y = Math.max(r.chat.top, top - MARGIN);
    const bottom = r.card.bottom + MARGIN;
    if (bottom > r.chat.bottom) throw new Error(`no room for the margin under the card: ${bottom} > ${r.chat.bottom}`);
    await capture(s, { x, y, width, height: bottom - y }, path.join(OUT, 'report.png'));
  } finally {
    await stop(s, mock);
  }
}

// ---------- main ----------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  try {
    if (ONLY.includes('status')) await sceneStatus();
    if (ONLY.includes('report')) await sceneReport();
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
