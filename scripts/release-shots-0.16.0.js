// Makes the screenshots for the 0.16.0 release notes, 1600 px wide, in the light theme:
//   permission-rules.png  Settings → Permissions, the Rules block: this project's allow, ask and deny rules (added
//                         through the app, as the add row does) and the rules for every project from the user's own
//                         settings.json (~/.silo-harness/settings.json), listed read-only
//   cost.png              the lower part of the chat while a run goes on: the user's request, the tool calls so far,
//                         the status line with the elapsed time, the context's tokens and the session's cost, then
//                         the composer
//
// Like scripts/release-shots-0.15.0.js, whose start-up and capture it follows, with the project, sessions and PNG
// helpers of scripts/readme-shots.js: the built app runs hidden on a throwaway profile against the scripted model
// (test/support/mock-model.js), and nothing leaves the machine.
//
// The cost: the session's model is claude-sonnet-5-5 behind an OpenAI-compatible gateway (the Gateway provider),
// which here is the scripted model. The app's built-in price table only applies to calls to Anthropic's own API, so
// the user's settings.json sets `prices` for claude-sonnet-5-5 at the table's own rates ($2 input, $0.10 cache read,
// $2.50 cache write, $10 output per million tokens). The scripted replies report their token counts (`usage`), and
// every figure on screen is what the app works out from them: nothing on the page is edited.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/release-shots-0.16.0.js [out-dir] [--only=rules,cost]     default: docs/releases/0.16.0
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock } = require('../test/support/mock-model.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs', 'releases', '0.16.0'));
const ONLY = (args.find((a) => a.startsWith('--only=')) || '--only=rules,cost').slice(7).split(',');
const WIDTH = 1600;
const js = JSON.stringify;
const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
const SETTINGS = path.join(F.CONFIG_DIR, 'settings.json');

/** The model of the cost shot and its list price (src/main/cost.ts PRICE_TABLE), in dollars per million tokens */
const MODEL = 'claude-sonnet-5-5';
const PRICE = { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 };

/** The app on a throwaway profile, hidden, against the scripted model; `config` is merged into the profile's config. */
async function start(mock, size, scale, config) {
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
      ...config,
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
  await app.evaluate(`document.activeElement && document.activeElement !== document.body && !document.activeElement.closest('.popover') && document.activeElement.blur()`);
  // The pointer out of the way, so nothing shows a hover
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: size.width - 2, y: size.height - 2 });
  const scale = WIDTH / width;
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: scale, mobile: false });
  await sleep(300);
  await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
  // A tiny clipped capture first: the hidden window's next full capture is then a fresh frame at the emulated scale
  // (after Settings opens, one can otherwise come back as a stale half-size surface; see test/live/rig.js)
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

// ---------- permission-rules.png ----------

const PROJECT_RULES = [
  ['allow', 'Bash(npm run test:*)'],
  ['allow', 'Bash(git status:*)'],
  ['allow', 'Edit(src/**)'],
  ['ask', 'Bash(git push:*)'],
  ['deny', 'Bash(rm:*)'],
  ['deny', 'Read(.env)'],
];
const GLOBAL_RULES = { allow: ['Bash(ls:*)', 'Bash(git diff:*)'], deny: ['Bash(curl:*)'] };

async function sceneRules() {
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.ollamaModels = ['qwen3:8b', 'qwen3:14b'];
  fs.mkdirSync(F.CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ permissions: GLOBAL_RULES }, null, 2));
  const size = { width: 1000, height: 900 };
  let s;
  try {
    s = await start(mock, size, 1.6, { provider: 'ollama', ollama: { baseURL: `http://127.0.0.1:${mock.port}`, model: 'qwen3:8b', numCtx: 32768, think: 'auto' } });
    const { app } = s;
    const ev = app.evaluate;
    await hideSidebar(app);
    // This project's rules, added as the add row adds them
    for (const [list, text] of PROJECT_RULES) {
      const why = await ev(`oc.rules.check(${js(list)}, ${js(text)})`);
      if (why) throw new Error(`the rule ${text} is refused: ${why}`);
      await ev(`oc.rules.add(${js(list)}, ${js(text)})`);
    }
    const r = await ev('oc.rules.list()');
    const texts = (l) => (r[l] ?? []).map((e) => e.text);
    const gtexts = (l) => (r.global?.[l] ?? []).map((e) => e.text);
    console.log('rules:', js({ allow: texts('allow'), ask: texts('ask'), deny: texts('deny'), global: { allow: gtexts('allow'), ask: gtexts('ask'), deny: gtexts('deny') } }));
    if (texts('allow').length !== 3 || texts('ask').length !== 1 || texts('deny').length !== 2) throw new Error('the project rules are not all there');
    if (gtexts('allow').length !== 2 || gtexts('deny').length !== 1) throw new Error('the settings.json rules are not all there');
    // Settings → Permissions
    await ev(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-permissions')?.click(); })()`);
    await app.waitFor(`[...document.querySelectorAll('#rules-global .rule-chip')].length === 3 && [...document.querySelectorAll('#rules-deny .rule-chip')].length === 2`, 10_000, 'the rules on the page');
    await sleep(600);
    const page = await ev(`(() => {
      const t = (sel) => document.querySelector(sel)?.innerText.trim();
      const shown = (sel) => { const e = document.querySelector(sel); return Boolean(e && !e.hidden && e.getClientRects().length); };
      return { cwd: t('#rules-cwd'), file: t('#rules-global-file'), input: document.querySelector('#rules-add-input').value, error: shown('#rules-add-error'), ignored: shown('#rules-ignored'), status: shown('#rules-status'), reasons: shown('#rules-reasons') };
    })()`);
    console.log('page:', js(page));
    if (page.cwd !== '~/code/atlas-api' || page.file !== '~/.silo-harness/settings.json') throw new Error(`unexpected paths: ${js(page)}`);
    if (page.input || page.error || page.ignored || page.status || page.reasons) throw new Error(`something on the page should not show: ${js(page)}`);
    const M = 24;
    // The block alone is narrower than the 1000 CSS px of the 0.15.0 images (Settings is at most 1020 px wide), so the
    // settings navigation comes in, as the app shows it: the crop starts at the top of the navigation, and the page
    // is scrolled so the group's title ("This project", just above "Rules") sits M below it
    const measure = () =>
      ev(`(() => {
        const r = (e) => { const b = (typeof e === 'string' ? document.querySelector(e) : e).getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
        const row = document.querySelector('#sp-row-rules');
        const group = row.closest('.sp-group');
        const gt = group && group.querySelector(':scope > .sp-group-title');
        const rows = [...document.querySelectorAll('#rules-global .rules-row')].filter((e) => !e.hidden);
        const nav = [...document.querySelectorAll('.sp-side .sp-search, .sp-side .sp-nav-item, .sp-side hr, .sp-side .sp-nav-sep')].filter((e) => e.getClientRects().length).map((e) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; });
        return { row: r(row), title: r('#sp-t-rules'), groupTitle: gt ? r(gt) : null, last: rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom : r('#rules-global').bottom, content: r('#settings-body'), side: r('.sp-side'), dialog: r('#settings'), nav };
      })()`);
    let box = await measure();
    const head = box.groupTitle ?? box.title;
    await ev(`document.querySelector('#settings-body').scrollTop += ${head.top - (box.side.top + M)}`);
    await sleep(400);
    box = await measure();
    console.log('box:', js({ ...box, nav: box.nav.length }));
    const x = box.side.left;
    const width = box.row.right + M - x;
    const y = box.side.top;
    // The bottom M below the last row, moved by up to 12 px so it falls between two items of the navigation
    const clear = (b) => box.nav.every((n) => b <= n.top + 4 || b >= n.bottom - 4);
    let bottom = box.last + M;
    for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9, -9, 10, -10, 11, -11, 12, -12]) {
      if (clear(box.last + M + d)) {
        bottom = box.last + M + d;
        break;
      }
    }
    const fromTop = (box.groupTitle ?? box.title).top - y;
    if (Math.abs(fromTop - M) > 2) throw new Error(`the block could not be scrolled into place: its top is ${fromTop} px down`);
    if (bottom > box.content.bottom) throw new Error(`the block does not fit the window: ${js({ bottom, content: box.content })}`);
    await capture(s, { x, y, width, height: bottom - y }, path.join(OUT, 'permission-rules.png'));
  } finally {
    await stop(s, mock);
    fs.rmSync(SETTINGS, { force: true });
  }
}

// ---------- cost.png ----------

const REQUEST = 'Add rate limiting to the public routes: 100 requests a minute per client IP, with /health left out. Then run the tests.';

/**
 * The run's model calls, each with the tokens the model reports (prompt and output). The fourth answer is held back
 * long enough for the shot, so the run is still going on when it is taken.
 */
function scriptCost(mock) {
  const main = (r) => mock.state.replies.push({ delayMs: 3200, ...r, when: F.isMain });
  const usage = (prompt, output) => ({ usage: { prompt_tokens: prompt, completion_tokens: output } });
  main({ ...usage(14_180, 186), toolCalls: [F.call('read_file', { path: 'src/server.js' })] });
  main({ ...usage(15_020, 612), toolCalls: [F.call('write_file', { path: 'src/middleware/rateLimit.js', content: F.RATE_LIMIT_JS })] });
  main({
    ...usage(16_240, 344),
    toolCalls: [
      F.call('edit_file', {
        path: 'src/server.js',
        old_string: "const routes = require('./routes');\n\nfunction createServer() {\n  const stack = [requestId];",
        new_string: "const { rateLimit } = require('./middleware/rateLimit');\nconst routes = require('./routes');\n\nfunction createServer() {\n  const limiter = rateLimit({ limit: 100, windowMs: 60_000, skip: (req) => req.url === '/health' });\n  const stack = [requestId, limiter];",
      }),
    ],
  });
  main({ ...usage(18_050, 142), toolCalls: [F.call('bash', { command: 'npm test' })] });
  main({ ...usage(18_420, 96), delayMs: 10 * 60_000, content: 'Public routes now allow 100 requests a minute per client IP, and `/health` stays unlimited. All 5 tests pass.' });
}

async function sceneCost() {
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.models = [MODEL, 'claude-haiku-5-5', 'claude-opus-5-5'];
  fs.mkdirSync(F.CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ prices: { [MODEL]: PRICE } }, null, 2));
  // Short enough that the conversation fills the chat down to the status line
  const size = { width: 1000, height: 540 };
  let s;
  try {
    s = await start(mock, size, 1.6, {
      provider: 'portkey',
      portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: '', model: MODEL, virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    });
    const { app } = s;
    const ev = app.evaluate;
    await hideSidebar(app);
    scriptCost(mock);
    const t0 = Date.now();
    await app.send(REQUEST);
    // The fourth call's tokens counted (18,050 + 142 = 18.2k), and the run some 15 s old
    await app.waitFor(`/^18\\.2k tokens$/.test(document.querySelector('#status-tokens')?.innerText.trim() ?? '') && !document.querySelector('#status-cost').hidden`, 60_000, 'the fourth call to be counted');
    const wait = 16_000 - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    // The last tool's row done (npm test), the status line steady
    await app.waitFor(`!document.querySelector('#messages .tool-status.spin')`, 20_000, 'the test run to finish').catch(() => undefined);
    await sleep(800);
    const line = await ev(`document.querySelector('#status-line').innerText.replace(/\\s+/g, ' ').trim()`);
    console.log('status line:', line);
    console.log('model calls so far:', mock.state.requests.filter((q) => q.url === '/v1/chat/completions').map((q) => (q.payload.stream ? 'agent' : 'check')).join(', '));
    if (!/\$\d+\.\d\d/.test(line)) throw new Error(`no cost in the status line: ${line}`);
    // At the end of the chat; a scroll shows the overlay scroll bar for a moment, so it is left to fade
    const scrolled = await ev(`(() => { const m = document.querySelector('#messages'); const end = m.scrollHeight - m.clientHeight; if (m.scrollTop >= end - 1) return false; m.scrollTop = end; return true; })()`);
    await sleep(scrolled ? 3000 : 800);
    // From a little above the user's request down to the bottom of the composer
    const r = await ev(`(() => {
      const box = (e) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
      const u = [...document.querySelectorAll('#messages > .msg.user')].pop();
      const prev = u.previousElementSibling;
      const composer = document.querySelector('#chatbar');
      return { chat: box(document.querySelector('#messages')), user: box(u), above: prev && !prev.hidden && prev.getClientRects().length ? box(prev).bottom : -Infinity, composer: box(composer), status: box(document.querySelector('#status-line')) };
    })()`);
    console.log('rect:', js(r));
    const y = Math.ceil(Math.max(r.chat.top, r.user.top - 28, r.above + 2));
    const bottom = Math.min(size.height, r.composer.bottom + 16);
    // The chat's width, less the window's left edge and the transcript's scroll bar (an 8 px gutter on the right; the
    // column sits 4 px left of the centre to match it, so this keeps it centred)
    await capture(s, { x: 4, y, width: size.width - 16, height: bottom - y }, path.join(OUT, 'cost.png'));
  } finally {
    await stop(s, mock);
    fs.rmSync(SETTINGS, { force: true });
  }
}

// ---------- main ----------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  try {
    if (ONLY.includes('rules')) await sceneRules();
    if (ONLY.includes('cost')) await sceneCost();
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
