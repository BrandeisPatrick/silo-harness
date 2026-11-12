// Makes the images for the 0.19.0 release notes (the shell sandbox), 1600 px wide, in the light theme:
//   sandbox-settings.png  Settings → Permissions → Auto mode with the sandbox on: the group's title and its three rows,
//                         "Run commands in a sandbox", "Local ports" and "Folders commands may also write"
//   sandbox-row.png       a bash row in the chat that the sandbox blocked, that Auto mode's check allowed, and that ran
//                         again outside: opened, so both runs show ("In the sandbox", "Outside") under the line
//                         "Sandbox blocked · checked · ran again outside", with the row's "sandbox" mark
//
// Like scripts/release-shots-0.18.0.js, whose start-up and capture it follows, with the made-up home and project of
// scripts/readme-shots.js, and the scripted call and check of test/live/sandbox.js (its call s3: a Python write to
// .vscode/settings.json, which the sandbox refuses and the check allows). The built app runs hidden on a throwaway
// profile against the scripted model (test/support/mock-model.js), and nothing leaves the machine. The sandbox is on
// through the made-up home's own settings.json ({ "sandbox": { "enabled": true } }), in its throwaway config folder.
// The command really runs, in the sandbox and then outside it, in the made-up project; nothing on the page is edited.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/release-shots-0.19.0.js [out-dir] [--only=settings,row]     default: docs/releases/0.19.0
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock, classifierReply, isClassifierRequest } = require('../test/support/mock-model.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs', 'releases', '0.19.0'));
const ONLY = (args.find((a) => a.startsWith('--only=')) || '--only=settings,row').slice(7).split(',');
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
      toolActivity: 'all',
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
    const cfg = await app.evaluate('window.oc.getConfig()');
    if (cfg.sandbox?.enabled !== true) throw new Error("the sandbox is not on: the made-up home's settings.json was not read");
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
  const leak = await app.evaluate(`document.body.innerText.includes(${js(os.homedir())}) || document.body.innerText.includes(${js(F.HOME)}) || document.body.innerText.includes(${js(os.tmpdir())})`);
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

// ---------- sandbox-row.png ----------

const ROW_REQUEST = 'Add an empty .vscode/settings.json to the project; I will fill it in later.';
// Short, so Python's traceback of the sandboxed run fits the row's width unwrapped
const ROW_COMMAND = `python3 -c "open('.vscode/settings.json', 'w').write('{}')"`;

const userSays = (marker) => (p) => {
  const m = p.messages?.[p.messages.length - 1];
  return !isClassifierRequest(p) && !!m && m.role === 'user' && js(m.content).includes(marker);
};
const afterTool = (id) => (p) => {
  const m = p.messages?.[p.messages.length - 1];
  return !isClassifierRequest(p) && !!m && m.role === 'tool' && m.tool_call_id === id;
};

async function sceneRow() {
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.models = [MODEL, 'claude-haiku-5-5', 'claude-opus-5-5'];
  const size = { width: 1000, height: 1000 };
  let s;
  try {
    s = await start(mock, size, 1.6);
    const { app } = s;
    // A new session, so the chat holds only this turn
    await app.evaluate(`document.querySelector('#new-session-btn').click()`);
    await app.waitFor(`!document.querySelector('#messages > .msg.user')`, 10_000, 'a new session');
    await sleep(500);
    const { replies, requests } = mock.state;
    replies.push({ delayMs: 1500, content: '', toolCalls: [{ id: 's3', name: 'bash', args: { command: ROW_COMMAND } }], when: userSays('empty .vscode/settings.json') });
    replies.push(classifierReply('allow', '[Local Work] editor settings for this project', { delayMs: 1500, when: (p) => js(p.messages).includes('.vscode/settings.json') }));
    replies.push({ delayMs: 1500, content: 'Added an empty `.vscode/settings.json`.', when: afterTool('s3') });
    await app.send(ROW_REQUEST);
    await sleep(500);
    await app.waitIdle(60_000);
    const result = requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === 's3')?.content ?? '';
    // A string, or (with prompt caching) a list of text parts
    const text = typeof result === 'string' ? result : result.map((p) => p.text ?? '').join('');
    if (!text.startsWith('[sandbox: blocked (') || !text.includes('ran again outside')) throw new Error(`the call did not run twice: ${text}`);
    const written = fs.readFileSync(path.join(F.PROJECT, '.vscode', 'settings.json'), 'utf8');
    if (written !== '{}') throw new Error(`the file was not written outside: ${written}`);
    const sel = `document.querySelector('#messages .tool[data-call-id="s3"]')`;
    await app.evaluate(`${sel}.open = true`);
    await sleep(600);
    const mark = await app.evaluate(`${sel}.querySelector('.tool-sandbox')?.textContent ?? ''`);
    const body = await app.evaluate(`${sel}.querySelector('.tool-body').innerText`);
    console.log(body.replace(/^/gm, '    '));
    if (mark !== 'sandbox' || !/In the sandbox/.test(body) || !/Outside/.test(body) || !/Sandbox blocked · checked · ran again outside/.test(body)) throw new Error('the row does not show its mark and both runs');
    await app.evaluate(`${sel}.scrollIntoView({ block: 'center' })`);
    await sleep(3000);
    const r = await app.evaluate(`(() => {
      const box = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; };
      const row = ${sel};
      // What follows the row in the chat (the closing reply), so the margin under it stops short of it
      let next = row.nextElementSibling;
      while (next && !next.getClientRects().length) next = next.nextElementSibling;
      if (!next) { const msg = row.closest('#messages > *'); next = msg && msg.nextElementSibling; }
      return { chat: box(document.querySelector('#messages')), row: box(row), next: next ? box(next).top : Infinity };
    })()`);
    console.log('rect:', js(r));
    if (r.row.top - MARGIN < r.chat.top || r.row.bottom + MARGIN > r.chat.bottom) throw new Error('the row does not fit the chat: make the window taller');
    // The same margin all round, no more than the room under the row
    const m = Math.min(MARGIN, Math.floor(r.next - r.row.bottom - 2));
    await capture(s, { x: r.row.left - m, y: r.row.top - m, width: r.row.width + 2 * m, height: r.row.bottom - r.row.top + 2 * m }, path.join(OUT, 'sandbox-row.png'));
  } finally {
    await stop(s, mock);
  }
}

// ---------- sandbox-settings.png ----------

async function sceneSettings() {
  const mock = await startMock();
  mock.state.models = [MODEL, 'claude-haiku-5-5', 'claude-opus-5-5'];
  const size = { width: 1000, height: 900 };
  let s;
  try {
    s = await start(mock, size, 1.6);
    const { app } = s;
    await app.evaluate(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-permissions')?.click(); })()`);
    await app.waitFor(`Boolean(document.querySelector('#sp-row-sandbox-enabled'))`, 10_000, 'the sandbox switch');
    await app.waitFor(`!document.querySelector('#sp-row-sandbox-loopback').hidden && !document.querySelector('#sp-row-sandbox-allowWrite').hidden`, 5000, 'Local ports and the folders');
    const v = await app.evaluate(`({ on: document.querySelector('#sp-row-sandbox-enabled input').checked, text: document.querySelector('#sp-row-sandbox-enabled').closest('.sp-group').innerText })`);
    if (!v.on) throw new Error('the sandbox switch is off');
    for (const t of ['Run commands in a sandbox', 'Local ports', 'Folders commands may also write']) if (!v.text.includes(t)) throw new Error(`no "${t}" row`);
    // The group's title and its three sandbox rows (the group goes on with the learned answers: the margin under the
    // rows stops short of the next row's title)
    await app.evaluate(`document.querySelector('#sp-row-sandbox-enabled').closest('.sp-group').scrollIntoView({ block: 'start' })`);
    await sleep(3000);
    const box = await app.evaluate(`(() => { const top = document.querySelector('#sp-row-sandbox-enabled').closest('.sp-group').getBoundingClientRect(); const last = document.querySelector('#sp-row-sandbox-allowWrite'); const end = last.getBoundingClientRect(); let next = last.nextElementSibling; while (next && !next.getClientRects().length) next = next.nextElementSibling; const room = next ? next.getBoundingClientRect().top + parseFloat(getComputedStyle(next).paddingTop) - end.bottom - 4 : Infinity; const below = Math.max(0, Math.min(${MARGIN}, Math.floor(room))); return { x: top.x - ${MARGIN}, y: top.y - ${MARGIN}, width: top.width + ${2 * MARGIN}, height: end.bottom - top.y + ${MARGIN} + below }; })()`);
    console.log('rect:', js(box));
    if (box.y + box.height > size.height) throw new Error('the rows do not fit the window: make it taller');
    await capture(s, box, path.join(OUT, 'sandbox-settings.png'));
  } finally {
    await stop(s, mock);
  }
}

// ---------- main ----------

async function main() {
  if (process.platform !== 'darwin') throw new Error('the shell sandbox is macOS only');
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  fs.mkdirSync(path.join(F.PROJECT, '.vscode'), { recursive: true });
  // The sandbox on, in the made-up home's own settings.json (its throwaway config folder)
  fs.mkdirSync(F.CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(F.CONFIG_DIR, 'settings.json'), js({ sandbox: { enabled: true } }, null, 2));
  try {
    if (ONLY.includes('settings')) await sceneSettings();
    if (ONLY.includes('row')) await sceneRow();
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
