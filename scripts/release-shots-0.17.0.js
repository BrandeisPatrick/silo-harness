// Makes the images for the 0.17.0 release notes (MCP servers), 1600 px wide, in the light theme:
//   mcp-servers.png  Settings → MCP servers with four servers the app itself started or tried to start: tracker and
//                    docs connected (6 and 3 tools), postgres from the project's .mcp.json and not trusted yet (Trust),
//                    metrics whose command is not installed (Retry, with its one-line reason)
//   mcp-tools.png    the tracker row's tools opened: Read-only and Can make changes, one switch ("Close issue")
//                    turned off by clicking it
//
// Like scripts/release-shots-0.15.0.js, whose start-up and capture it follows, with the made-up home and project of
// scripts/readme-shots.js: the built app runs hidden on a throwaway profile against the scripted model
// (test/support/mock-model.js), and nothing leaves the machine. The servers are real stdio processes: copies of
// scripts/release-shots-mcp-server.js inside the made-up home (~/mcp-servers/tracker.js, ~/mcp-servers/docs.js, and
// tools/mcp/postgres.js in the project), so every command line the page shows reads ~/… or a project path. metrics
// runs `atlas-metrics-mcp`, a program that does not exist, so it fails at once.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/release-shots-0.17.0.js [out-dir] [--only=servers,tools]     default: docs/releases/0.17.0
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock } = require('../test/support/mock-model.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs', 'releases', '0.17.0'));
const ONLY = (args.find((a) => a.startsWith('--only=')) || '--only=servers,tools').slice(7).split(',');
const WIDTH = 1600;
// Crops are 1000 CSS px wide at 1.6x: the image is 1600 px
const SCALE = 1.6;
const CROP_W = WIDTH / SCALE;
const MARGIN = 24;
const js = JSON.stringify;
const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
const SERVER_JS = path.join(__dirname, 'release-shots-mcp-server.js');

/** The servers: copies of the fixture server in the made-up home and the project's .mcp.json naming postgres. */
function writeServers() {
  const dir = path.join(F.HOME, 'mcp-servers');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['tracker', 'docs']) fs.copyFileSync(SERVER_JS, path.join(dir, `${n}.js`));
  const tools = path.join(F.PROJECT, 'tools', 'mcp');
  fs.mkdirSync(tools, { recursive: true });
  fs.copyFileSync(SERVER_JS, path.join(tools, 'postgres.js'));
  fs.writeFileSync(path.join(F.PROJECT, '.mcp.json'), `${js({ mcpServers: { postgres: { command: 'node', args: ['tools/mcp/postgres.js'] } } }, null, 2)}\n`);
  return {
    tracker: { command: 'node', args: ['~/mcp-servers/tracker.js'] },
    docs: { command: 'node', args: ['~/mcp-servers/docs.js'] },
    metrics: { command: 'atlas-metrics-mcp', args: ['--stdio'] },
  };
}

/** The app on a throwaway profile, hidden, against the scripted model, with Settings → MCP servers open. */
async function start(mock, size, mcpServers) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-release-shot-'));
  fs.writeFileSync(path.join(F.HOME, '.zprofile'), `export PATH=${js(process.env.PATH)}\n`);
  F.seedSessions(profile);
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
      mcpServers,
    },
  });
  const s = { app, inspect, profile, size };
  try {
    // A hidden window only draws while asked to: keep every view drawing
    await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); return true; })()`);
    await resize(s, size);
    await app.waitFor(`Boolean(window.__oc_debug)`, 20_000, 'the app');
    // Every server where it settles: two connected, postgres waiting for trust, metrics failed
    const settled = `oc.mcp.list().then((l) => { const st = Object.fromEntries(l.map((x) => [x.name, x.status])); return st.tracker === 'connected' && st.docs === 'connected' && st.postgres === 'blocked' && st.metrics === 'error'; })`;
    await app.waitFor(settled, 30_000, 'the servers to settle').catch(async (e) => {
      console.error('servers:', js(await app.evaluate(`oc.mcp.list().then((l) => l.map((x) => [x.name, x.status, x.error]))`)));
      throw e;
    });
    await app.evaluate(`(() => { document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-mcp').click(); })()`);
    await app.waitFor(`document.querySelectorAll('#mcp-list .mcp-row').length === 4`, 10_000, 'the four rows');
    await sleep(600);
  } catch (e) {
    await app.close();
    throw e;
  }
  return s;
}

async function resize(s, size) {
  s.size = size;
  await F.mainEval(s.inspect, `(() => { ${WIN}.setContentSize(${size.width}, ${size.height}); return true; })()`);
  await s.app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: SCALE, mobile: false });
  await sleep(500);
}

async function stop(s, mock) {
  if (s) {
    await s.app.close();
    fs.rmSync(s.profile, { recursive: true, force: true });
  }
  mock.close();
}

/** Takes the whole window and keeps the rectangle x, y, width, height (CSS pixels). */
async function capture({ app, inspect, size }, { x, y, width, height }, file) {
  // Nothing in the window may show a real home path
  const leak = await app.evaluate(`document.body.innerText.includes(${js(os.homedir())}) || document.body.innerText.includes(${js(F.HOME)})`);
  if (leak) throw new Error('a real or temporary home path shows in the window');
  await app.evaluate(`document.activeElement && document.activeElement !== document.body && document.activeElement.blur()`);
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: size.width - 2, y: size.height - 2 });
  await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
  await sleep(250);
  const cap = await app.cdp('Page.captureScreenshot', { format: 'png' });
  const png = F.cropPng(Buffer.from(cap.data, 'base64'), Math.round(x * SCALE), Math.round(y * SCALE), Math.round(width * SCALE), Math.round(height * SCALE));
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB)`);
}

const rect = (app, sel) => app.evaluate(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);

/**
 * The crop's left and right: the section with MARGIN on its right; it is narrower than CROP_W, so the settings
 * navigation column comes in on the left (from the dialog's inner edge). The window is made as wide as it takes for
 * that span to be exactly CROP_W.
 */
async function fitWidth(s) {
  for (let i = 0; i < 4; i++) {
    const dlg = await rect(s.app, '#settings');
    const sec = await rect(s.app, '#sp-sec-mcp');
    const left = dlg.left + 1;
    const right = sec.right + MARGIN;
    const w = right - left;
    console.log(`fit: window ${s.size.width}, dialog ${dlg.left}–${dlg.right}, section ${sec.left}–${sec.right}, crop ${w}`);
    if (Math.abs(w - CROP_W) < 0.5) return { x: left, width: CROP_W };
    await resize(s, { width: Math.round(s.size.width + (CROP_W - w)), height: s.size.height });
  }
  throw new Error('could not fit the crop to the width');
}

/**
 * The crop's bottom edge moved off any settings navigation item it would cut through: up to the item's top when that
 * still leaves `least` under the section, else down to the item's bottom.
 */
async function navSafe(app, bottom, least) {
  const cut = await app.evaluate(`[...document.querySelectorAll('#settings-nav .sp-nav-item, #settings-nav .sp-nav-sep')].map((b) => b.getBoundingClientRect()).filter((r) => r.height && r.top < ${bottom} && r.bottom > ${bottom}).map((r) => ({ top: r.top, bottom: r.bottom }))[0] ?? null`);
  if (!cut) return bottom;
  const to = cut.top >= least ? cut.top : cut.bottom;
  console.log(`bottom edge ${bottom} cuts a navigation item (${cut.top}–${cut.bottom}): ${to}`);
  return to;
}

/** What the rows say, for the log (and the report). */
async function rows(app) {
  return app.evaluate(`[...document.querySelectorAll('#mcp-list .mcp-row')].map((r) => [r.dataset.name, r.dataset.status, r.querySelector('.mcp-target')?.innerText ?? '', r.querySelector('.mcp-sub')?.innerText ?? '', r.querySelector('.mcp-status-line').innerText.replace(/\\s+/g, ' '), r.querySelector('.mcp-primary')?.innerText.trim() ?? ''].join(' | '))`);
}

// ---------- mcp-servers.png ----------

async function sceneServers(mcpServers) {
  const mock = await startMock();
  mock.state.ollamaModels = ['qwen3:8b'];
  let s;
  try {
    s = await start(mock, { width: 1068, height: 820 }, mcpServers);
    const { app } = s;
    const fit = await fitWidth(s);
    console.log('rows:\n  ' + (await rows(app)).join('\n  '));
    const title = await rect(app, '#sp-sec-mcp .sp-title');
    const last = await rect(app, '#mcp-list');
    const main = await rect(app, '#settings .sp-main');
    const content = await app.evaluate(`(() => { const c = document.querySelector('#settings-body'); return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight }; })()`);
    console.log('geometry:', js({ title, last, main, content }));
    if (content.scrollTop !== 0 || content.scrollHeight > content.clientHeight + 1) throw new Error('the section scrolls: make the window taller');
    // From just under the dialog's header (the title sits about MARGIN below it) to MARGIN under the last row
    const y = Math.max(main.top + 1, title.top - MARGIN);
    const bottom = await navSafe(app, last.bottom + MARGIN, last.bottom + 16);
    await capture(s, { x: fit.x, y, width: fit.width, height: bottom - y }, path.join(OUT, 'mcp-servers.png'));
  } finally {
    await stop(s, mock);
  }
}

// ---------- mcp-tools.png ----------

async function sceneTools(mcpServers) {
  const mock = await startMock();
  mock.state.ollamaModels = ['qwen3:8b'];
  let s;
  try {
    s = await start(mock, { width: 1050, height: 1000 }, mcpServers);
    const { app } = s;
    const row = `#mcp-list .mcp-row[data-name="tracker"]`;
    // Open the tools as a user would, then turn "Close issue" off with its switch
    await app.click(`${row} .mcp-tools-toggle`);
    await sleep(300);
    // The switch, in view, clicked with the mouse
    await app.evaluate(`document.querySelector('${row} input.switch[data-tool="close_issue"]').closest('label').scrollIntoView({ block: 'nearest' })`);
    await sleep(300);
    const sw = await rect(app, `${row} input.switch[data-tool="close_issue"]`);
    const x = sw.left + sw.width / 2;
    const yy = sw.top + sw.height / 2;
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: yy });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: yy, button: 'left', clickCount: 1 });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: yy, button: 'left', clickCount: 1 });
    await app.waitFor(`Boolean(document.querySelector('${row} .mcp-tool.off input.switch[data-tool="close_issue"]')) && !document.querySelector('${row}.busy')`, 10_000, 'Close issue turned off');
    await app.waitFor(`oc.mcp.list().then((l) => l.find((x) => x.name === 'tracker')?.status === 'connected')`, 10_000, 'tracker connected');
    await sleep(800);
    const tools = await app.evaluate(`(() => { const t = document.querySelector('${row} .mcp-tools'); return { open: !t.hidden, scrollHeight: t.scrollHeight, clientHeight: t.clientHeight, groups: [...t.querySelectorAll('.mcp-tools-group')].map((g) => g.innerText), tools: [...t.querySelectorAll('.mcp-tool')].map((e) => [e.querySelector('.mcp-tool-title').innerText, e.querySelector('input.switch')?.checked]) }; })()`);
    console.log('tools:', js(tools));
    console.log('rows:\n  ' + (await rows(app)).join('\n  '));
    if (!tools.open) throw new Error('the tools list is closed');
    if (tools.scrollHeight > tools.clientHeight + 1) throw new Error('the tools list scrolls inside');
    // The whole section in view, without a scroll bar
    const content = await app.evaluate(`(() => { const c = document.querySelector('#settings-body'); return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight }; })()`);
    console.log('content:', js(content));
    if (content.scrollTop !== 0 || content.scrollHeight > content.clientHeight + 1) throw new Error('the section scrolls');
    const fit = await fitWidth(s);
    // From the section title (with the Add server button) down to the next row under tracker
    const title = await rect(app, '#sp-sec-mcp .sp-title');
    const main = await rect(app, '#settings .sp-main');
    const next = await app.evaluate(`(() => { const n = document.querySelector('${row}').nextElementSibling; if (!n) return null; const r = n.querySelector('.mcp-main').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
    const tr = await rect(app, row);
    const y = Math.max(main.top + 1, title.top - MARGIN);
    const end = next ? next.bottom : (await rect(app, '#mcp-list')).bottom;
    const bottom = await navSafe(app, end + MARGIN, end + 16);
    if (bottom > main.bottom) throw new Error('the crop runs past the dialog');
    console.log('geometry:', js({ title, tracker: tr, next, y, bottom }));
    await capture(s, { x: fit.x, y, width: fit.width, height: bottom - y }, path.join(OUT, 'mcp-tools.png'));
  } finally {
    await stop(s, mock);
  }
}

// ---------- main ----------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  try {
    const servers = writeServers();
    if (ONLY.includes('servers')) await sceneServers(servers);
    if (ONLY.includes('tools')) await sceneTools(servers);
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
