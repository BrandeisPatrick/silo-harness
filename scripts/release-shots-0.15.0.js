// Makes the screenshots for the 0.15.0 release notes, 1600 px wide, in the light theme:
//   one-strip.png   the whole window with the side pane open: its one strip holds two page tabs (local fixture pages
//                   with a title and an icon), Diff (in front, showing the edit the agent just made) and Terminal,
//                   then +, with the pane toggle in the window's top-right corner; the chat beside it holds the
//                   short exchange that made the edit
//   worked-for.png  a finished turn folded under its "Worked for …" line, with the answer below it; the scripted
//                   replies are held back so the turn really takes about 53 s
//
// Like scripts/release-shots-0.14.0.js, whose start-up and capture it follows, with the project, sessions and PNG
// helpers of scripts/readme-shots.js: the built app runs hidden on a throwaway profile against the scripted model
// (test/support/mock-model.js), and nothing leaves the machine. The two pages are served by this script on 127.0.0.1;
// their icons are data: URLs, so nothing is fetched from anywhere else. The Browser pane's page is a native view
// that a capture of the window's page does not show, so a tool tab (Diff) is the one in front.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/release-shots-0.15.0.js [out-dir] [--only=strip,worked]     default: docs/releases/0.15.0
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock } = require('../test/support/mock-model.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs', 'releases', '0.15.0'));
const ONLY = (args.find((a) => a.startsWith('--only=')) || '--only=strip,worked').slice(7).split(',');
const WIDTH = 1600;
// The window is 1000 px wide at 1.6x: the image is 1600 px
const SCALE = 1.6;
const js = JSON.stringify;
const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;

/** The app on a throwaway profile, hidden, against the scripted model (Ollama path, reported as qwen3:8b). */
async function start(mock, size) {
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
    scale: SCALE,
    env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
    config: {
      provider: 'ollama',
      ollama: { baseURL: `http://127.0.0.1:${mock.port}`, model: 'qwen3:8b', numCtx: 32768, think: 'auto' },
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
    await app.evaluate(`(() => { if (!document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-toggle').click(); const r = document.querySelector('#rail-toggle'); if (r && !r.hidden && r.getAttribute('aria-pressed') === 'true') r.click(); })()`);
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

/** Takes the whole window and keeps the rectangle x, y, width, height (CSS pixels; width defaults to the whole row). */
async function capture({ app, inspect }, { x = 0, y, width, height }, file) {
  // Nothing in the window may show a real home path
  const leak = await app.evaluate(`document.body.innerText.includes(${js(os.homedir())}) || document.body.innerText.includes(${js(F.HOME)})`);
  if (leak) throw new Error('a real or temporary home path shows in the window');
  await app.evaluate(`document.activeElement && document.activeElement !== document.body && !document.activeElement.closest('.popover') && document.activeElement.blur()`);
  await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
  await sleep(150);
  const cap = await app.cdp('Page.captureScreenshot', { format: 'png' });
  const w = width === undefined ? WIDTH : Math.round(width * SCALE);
  const png = F.cropPng(Buffer.from(cap.data, 'base64'), Math.round(x * SCALE), Math.round(y * SCALE), w, Math.round(height * SCALE));
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB)`);
}

/** Closes the sessions sidebar, so the chat (and the pane) get the window's width. */
async function hideSidebar(app) {
  const open = await app.evaluate(`(() => { const s = document.querySelector('#sidebar'); return Boolean(s && s.getBoundingClientRect().width > 40); })()`);
  if (open) await app.click('#sidebar-toggle');
  await sleep(500);
}

/** Drags the side pane's edge until the pane is `width` CSS pixels wide, as a user would. */
async function dragPane(app, width) {
  const box = (sel) => app.evaluate(`(() => { const r = document.querySelector(${js(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const rz = await box('#pane-resizer');
  const dx = width - (await box('#side-pane')).width;
  const x = rz.x + rz.width / 2;
  const y = rz.y + rz.height / 2;
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 10; i++) await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - (i * dx) / 10, y, button: 'left', buttons: 1 });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - dx, y, button: 'left', clickCount: 1 });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
  await sleep(400);
}

// ---------- one-strip.png ----------

/** A square icon drawn as SVG, as a data: URL, so the tab has a favicon without fetching one. */
const icon = (bg, letter) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${bg}"/><text x="16" y="22.5" font-family="-apple-system,Helvetica,sans-serif" font-size="19" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`).toString('base64')}`;
const SITE = {
  '/docs/rate-limits': { title: 'Rate limits · Atlas docs', icon: icon('#277de2', 'A'), body: '<h1>Rate limits</h1><p>Each client may send 100 requests a minute to the public routes.</p>' },
  '/status': { title: 'atlas-api status', icon: icon('#2f7d4f', 'S'), body: '<h1>atlas-api</h1><p>Operational</p>' },
};

function startSite() {
  const server = http.createServer((req, res) => {
    const p = SITE[new URL(req.url, 'http://x').pathname];
    if (!p) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${p.title}</title><link rel="icon" href="${p.icon}"><body style="font:15px -apple-system,sans-serif;padding:32px">${p.body}</body>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

function scriptStrip(mock) {
  const main = (r) => mock.state.replies.push({ ...r, when: F.isMain });
  main({ delayMs: 300, promptTokens: 8400, toolCalls: [F.call('read_file', { path: 'src/routes.js' })] });
  main({
    delayMs: 300,
    promptTokens: 9100,
    toolCalls: [
      F.call('edit_file', {
        path: 'src/routes.js',
        old_string: "    return p ? json(res, 200, p) : json(res, 404, { error: 'not_found' });",
        new_string: "    return p ? json(res, 200, p) : json(res, 404, { error: 'not_found', id: m[1] });",
      }),
    ],
  });
  main({ delayMs: 300, promptTokens: 9500, toolCalls: [F.call('bash', { command: 'npm test' })] });
  main({ delayMs: 300, promptTokens: 9900, content: 'A missing product now answers `404` with the id it looked for, `{ "error": "not_found", "id": "nope" }`. The five tests pass.' });
}

async function sceneStrip() {
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.ollamaPromptTokens = 8000;
  mock.state.ollamaModels = ['qwen3:8b', 'qwen3:14b'];
  const site = await startSite();
  const size = { width: 1000, height: 640 };
  let s;
  try {
    s = await start(mock, size);
    const { app } = s;
    const ev = app.evaluate;
    const strip = async () => (await ev('window.__oc_debug.mods.browser()')).strip;
    // The sidebar closed and the pane dragged wide, so the strip has room for its titles
    await hideSidebar(app);
    await ev(`(() => { if (document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-toggle').click(); })()`);
    await sleep(400);
    await dragPane(app, 600);
    // Two pages in two tabs first, so the tools that open later sit after them
    await ev(`oc.rpc('browser.go', ${js(site.base + '/docs/rate-limits')})`);
    await app.waitFor(`window.__oc_debug.mods.browser().strip.some((t) => t.title === ${js(SITE['/docs/rate-limits'].title)})`, 10_000, 'the docs page');
    await app.click('#browser-tab-new');
    await app.waitFor(`window.__oc_debug.mods.browser().newTab.shown`, 5000, 'a blank tab');
    await ev(`oc.rpc('browser.go', ${js(site.base + '/status')})`);
    await app.waitFor(`window.__oc_debug.mods.browser().strip.some((t) => t.title === ${js(SITE['/status'].title)})`, 10_000, 'the status page');
    // The exchange: the edit brings Diff into the strip by itself
    scriptStrip(mock);
    await app.send('A missing product should say which id it could not find.');
    await app.waitFor(`document.querySelector('#status-line').hidden && !document.querySelector('.session-item.active.running') && document.querySelectorAll('#messages > .msg.assistant').length >= 2`, 60_000, 'the turn to end');
    // Both icons in
    await app.waitFor(`document.querySelectorAll('#pane-tabs .browser-tab-icon img').length >= 2 && [...document.querySelectorAll('#pane-tabs .browser-tab-icon img')].every((i) => i.complete && i.naturalWidth > 0)`, 10_000, 'the page icons');
    // Diff and Terminal, if not there yet (Diff may have opened by itself with the edit), then Diff in front
    if (!(await strip()).some((t) => t.tab === 'diff')) await app.key('d', { meta: true, shift: true });
    await sleep(300);
    if (!(await strip()).some((t) => t.tab === 'terminal')) await app.key('t', { meta: true, shift: true });
    await sleep(800);
    await app.click('#pane-tab-diff');
    await sleep(600);
    // The edited file open in the Diff pane
    await ev(`(() => { const row = document.querySelector('#change-list [role=option]'); if (row && row.getAttribute('aria-selected') !== 'true') row.click(); })()`);
    await sleep(800);
    // Scrolled to the end, the chat's top edge cuts through the earlier exchange: scroll back so the first item it
    // cuts shows whole, as long as the answer stays in view
    console.log('top edge:', await ev(`(() => {
      const m = document.querySelector('#messages');
      const box = m.getBoundingClientRect();
      const items = [...m.children].filter((e) => !e.hidden && e.getClientRects().length);
      const cut = items.find((e) => { const r = e.getBoundingClientRect(); return r.top < box.top && r.bottom > box.top; });
      if (!cut) return 'nothing cut';
      const up = Math.ceil(box.top + 12 - cut.getBoundingClientRect().top);
      const last = Math.max(...items.map((e) => e.getBoundingClientRect().bottom));
      if (last + up > box.bottom - 8) return 'no room';
      m.scrollTop -= up;
      return 'up ' + up;
    })()`));
    await sleep(1800);
    console.log('strip:',(await strip()).map((t) => `${t.tab}${t.title ? ` "${t.title}"` : ''}${t.active ? ' [active]' : ''}`).join(' | '));
    await capture(s, { y: 0, height: size.height }, path.join(OUT, 'one-strip.png'));
  } finally {
    await stop(s, mock);
    site.close();
  }
}

// ---------- worked-for.png ----------

/** The turn's replies, held back so the whole turn takes about 53 s, as in the notes */
function scriptWorked(mock) {
  const main = (r) => mock.state.replies.push({ ...r, when: F.isMain });
  main({ delayMs: 9000, promptTokens: 8400, toolCalls: [F.call('read_file', { path: 'src/server.js' }), F.call('read_file', { path: 'src/routes.js' }), F.call('read_file', { path: 'src/middleware/requestId.js' })] });
  main({ delayMs: 10000, promptTokens: 9200, toolCalls: [F.call('grep', { pattern: 'x-request-id', path: '.' })] });
  main({ delayMs: 9000, promptTokens: 9700, toolCalls: [F.call('bash', { command: 'npm test' })] });
  main({ delayMs: 10000, promptTokens: 10100, toolCalls: [F.call('list_directory', { path: 'test' })] });
  main({
    delayMs: Number(process.env.WORKED_LAST_MS || 15500),
    promptTokens: 10600,
    content:
      'Yes, every response carries a request id. `src/middleware/requestId.js` runs first for every request: it takes `X-Request-Id` from the caller when there is one, makes a UUID when not, and sends it back in the response. The test `responses carry a request id` checks the echo, and all five tests pass.',
  });
}

async function sceneWorked() {
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.ollamaPromptTokens = 8000;
  mock.state.ollamaModels = ['qwen3:8b', 'qwen3:14b'];
  const size = { width: 1000, height: 720 };
  let s;
  try {
    s = await start(mock, size);
    const { app } = s;
    const ev = app.evaluate;
    await hideSidebar(app);
    scriptWorked(mock);
    await app.send('Does every response carry a request id? Check the code and the tests.');
    await app.waitFor(`document.querySelector('#status-line').hidden && !document.querySelector('.session-item.active.running') && Boolean(document.querySelector('#messages > .turn-head:not(.live)'))`, 120_000, 'the turn to end');
    await sleep(800);
    const head = await ev(`[...document.querySelectorAll('#messages > .turn-head')].pop().innerText.trim()`);
    console.log('header:', head);
    if (!/^Worked for/.test(head)) throw new Error(`unexpected header: ${head}`);
    await ev(`(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; })()`);
    await sleep(1800);
    // From the question to the answer, across the reading column
    const r = await ev(`(() => {
      const chat = document.querySelector('#messages').getBoundingClientRect();
      const u = [...document.querySelectorAll('#messages > .msg.user')].pop();
      const prev = u.previousElementSibling;
      const a = [...document.querySelectorAll('#messages > .msg.assistant')].pop().getBoundingClientRect();
      return { chatTop: chat.top, chatBottom: chat.bottom, chatLeft: chat.left, chatWidth: chat.width, top: u.getBoundingClientRect().top, above: prev && !prev.hidden ? prev.getBoundingClientRect().bottom : -Infinity, end: a.bottom };
    })()`);
    console.log('rect', js(r));
    const y = Math.ceil(Math.max(r.chatTop, r.top - 28, r.above + 2));
    const bottom = Math.min(r.chatBottom, r.end + 28);
    await capture(s, { y, height: bottom - y }, path.join(OUT, 'worked-for.png'));
  } finally {
    await stop(s, mock);
  }
}

// ---------- main ----------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  try {
    if (ONLY.includes('strip')) await sceneStrip();
    if (ONLY.includes('worked')) await sceneWorked();
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
