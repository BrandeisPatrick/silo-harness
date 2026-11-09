// Records the demo at the top of the README and the website: a coding turn, then the agent writing a mod that shows
// up in the rail. Writes demo.gif (1200 px wide, for the README), demo.mp4 (1440 px, for the website) and
// demo-poster.png (the last frame at 2x, the video's poster); with --dark the same scene in the dark theme, as
// demo-dark.gif, demo-dark.mp4 and demo-poster-dark.png.
//
// Like scripts/readme-shots.js, whose project, sessions and PNG helpers it uses: the built app runs hidden on a
// throwaway profile against the scripted model (Ollama path, reported as qwen3:8b), and only the model's replies are
// scripted. The prompts are typed into the composer key by key; the reads, the edit, `npm test`, the mod's files and
// mod_check really run on ~/code/atlas-api, and the mod is turned on from its card in the chat. Frames come from the
// renderer page (CDP Page.startScreencast at device scale 1), are laid on a steady clock and encoded with ffmpeg
// (a two-pass palette for the GIF, H.264 for the MP4). The Browser pane is closed throughout: it is a native view,
// which a capture of the page would not show.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/demo-gif.js [out-dir] [--dark]      default: docs/screenshots
//
// FFMPEG names the ffmpeg binary (default: ffmpeg on the PATH, else /opt/homebrew/bin/ffmpeg). DEMO_FRAMES keeps the
// captured frames in that folder instead of a temp one that is removed afterwards.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock } = require('../test/support/mock-model.js');

const DARK = process.argv.includes('--dark');
const OUT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'docs', 'screenshots'));
const outFile = (name, ext) => path.join(OUT, `${name}${DARK ? '-dark' : ''}.${ext}`);
const js = JSON.stringify;

/** The window, in CSS pixels; frames are taken at device scale 1 */
const W = 1440;
const H = 900;
/** Frame rates of the two files, and the GIF's width */
const GIF_FPS = 12;
const MP4_FPS = 24;
const GIF_W = 1200;

const FFMPEG = process.env.FFMPEG || (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    return '/opt/homebrew/bin/ffmpeg';
  }
})();

// ---------- the project: a search route the turn puts behind the rate limiter ----------

const SEARCH_JS = `const products = require('./products.json');

/** GET /v1/search?q=trail: the products whose name contains q. */
function search(req, res) {
  const q = (new URL(req.url, 'http://localhost').searchParams.get('q') || '').toLowerCase();
  const data = products.filter((p) => p.name.toLowerCase().includes(q));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data }));
}

module.exports = { search };
`;

const SEARCH_TEST_JS = `const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

async function withServer(fn) {
  const server = createServer().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(\`http://127.0.0.1:\${server.address().port}\`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const cases = [
  ['trail', ['p_1001']],
  ['SHELL', ['p_1002']],
  ['pack', ['p_1007']],
  ['', ['p_1001', 'p_1002', 'p_1003', 'p_1007']],
  ['boots', []],
];

for (const [q, ids] of cases) {
  test(\`GET /v1/search?q=\${q} finds \${ids.length}\`, () => withServer(async (base) => {
    const { data } = await (await fetch(\`\${base}/v1/search?q=\${q}\`)).json();
    assert.deepEqual(data.map((p) => p.id), ids);
  }));
}
`;

/** The project of the README shots, with the rate limiter from the earlier session and a search route without it. */
function makeProject() {
  F.FILES['src/search.js'] = SEARCH_JS;
  F.FILES['src/middleware/rateLimit.js'] = F.RATE_LIMIT_JS;
  F.FILES['test/search.test.js'] = SEARCH_TEST_JS;
  F.FILES['src/routes.js'] = F.FILES['src/routes.js']
    .replace("const products = require('./products.json');", "const products = require('./products.json');\nconst { search } = require('./search');")
    .replace("  if (pathname === '/v1/products') return", "  if (pathname === '/v1/search') return search(req, res);\n  if (pathname === '/v1/products') return");
  F.makeProject();
}

// ---------- the scripted model ----------

/** A reply's text as the stream would bring it: a few characters at a time */
const pieces = (text) => text.match(/.{1,4}/gs);
const say = (text, extra = {}) => ({ chunks: pieces(text), chunkDelayMs: 28, ...extra });

const MOD_JSON = JSON.stringify(
  {
    protocol: 1,
    id: 'test-runs',
    name: 'Test runs',
    version: '0.1.0',
    description: 'The last test run in this session: how many passed and how long it took.',
    icon: 'gauge',
    permissions: ['session:read'],
    contributes: { views: [{ id: 'main', title: 'Test runs', entry: 'panel.html', seat: 'rail', order: 15 }] },
  },
  null,
  2,
) + '\n';

const PANEL_HTML = `<!doctype html>
<link rel="stylesheet" href="/@harness/harness.css">
<style>
  .run { display: flex; align-items: center; gap: 8px; font-size: var(--fs-ui); line-height: var(--lh-ui); color: var(--text-100); }
  .run b { font-weight: 600; }
  .run .ok { color: var(--success); }
  .run .bad { color: var(--danger); }
  .sep { color: var(--text-400); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); flex: none; }
  .dot.bad { background: var(--danger); }
  .cmd { margin-top: 4px; font-size: var(--fs-small); line-height: var(--lh-small); color: var(--text-400); }
</style>
<div class="run" id="run" hidden>
  <span class="dot" id="dot"></span><span>Tests</span><span class="sep">·</span><b id="count"></b><span class="sep">·</span><span id="time"></span>
</div>
<div class="cmd h-mono" id="cmd" hidden></div>
<div class="h-empty" id="empty" hidden>No test run in this session yet.</div>
<script src="/@harness/harness.js"></script>
<script>
  // The last run of the test runner in the session on screen, from the summary node --test prints at the end
  const $ = (id) => document.getElementById(id);
  const last = (re, text) => [...text.matchAll(re)].pop();
  function lastRun(items) {
    for (let i = items.length - 1; i >= 0; i--) {
      const t = items[i];
      if (t.role !== 'tool' || t.name !== 'bash') continue;
      const pass = last(/(?:#|ℹ) pass (\\d+)/g, t.text);
      if (!pass) continue;
      const fail = last(/(?:#|ℹ) fail (\\d+)/g, t.text);
      const ms = last(/(?:#|ℹ) duration_ms ([\\d.]+)/g, t.text);
      let cmd = '';
      try { cmd = JSON.parse(t.args).command; } catch {}
      return { pass: +pass[1], fail: fail ? +fail[1] : 0, ms: ms ? +ms[1] : 0, cmd };
    }
    return null;
  }
  async function load() {
    const { items } = await harness.session.transcript();
    const run = lastRun(items);
    $('empty').hidden = Boolean(run);
    $('run').hidden = $('cmd').hidden = !run;
    if (!run) return;
    $('dot').className = run.fail ? 'dot bad' : 'dot';
    $('count').textContent = run.fail ? \`\${run.fail} failed\` : \`\${run.pass} passed\`;
    $('count').className = run.fail ? 'bad' : 'ok';
    $('time').textContent = run.ms < 1000 ? \`\${Math.round(run.ms)} ms\` : \`\${(run.ms / 1000).toFixed(1)} s\`;
    $('cmd').textContent = run.cmd;
  }
  harness.ready.then(load);
  harness.on('tool.ended', (e) => { if (e.name === 'bash') load(); });
  harness.on('session.switched', load);
</script>
`;

const ASK_CODE = 'Add rate limiting to /search and run the tests';
const ASK_MOD = 'Make a panel that shows the last test run';

function scriptCode(mock) {
  const main = (r) => mock.state.replies.push({ ...r, when: F.isMain });
  main({ ...say("I'll put the rate limiter you already have in front of the search route, then run the suite."), delayMs: 600, promptTokens: 8300, toolCalls: [F.call('read_file', { path: 'src/search.js' })] });
  main({
    delayMs: 800,
    promptTokens: 8900,
    toolCalls: [
      F.call('edit_file', {
        path: 'src/search.js',
        old_string: "const products = require('./products.json');\n\n/** GET /v1/search?q=trail: the products whose name contains q. */\nfunction search(req, res) {\n",
        new_string:
          "const products = require('./products.json');\nconst { rateLimit } = require('./middleware/rateLimit');\n\n// 30 searches a minute per client, then 429\nconst limit = rateLimit({ limit: 30, windowMs: 60_000 });\n\n/** GET /v1/search?q=trail: the products whose name contains q. */\nfunction search(req, res) {\n  limit(req, res, () => find(req, res));\n}\n\nfunction find(req, res) {\n",
      }),
    ],
  });
  main({ delayMs: 900, promptTokens: 9400, toolCalls: [F.call('bash', { command: 'npm test' })] });
  main({
    ...say('Search now takes **30 requests a minute per client**: the 31st gets `429` with `Retry-After`, and the other routes are as they were. All 10 tests pass.'),
    delayMs: 900,
    promptTokens: 9800,
  });
}

function scriptMod(mock) {
  const main = (r) => mock.state.replies.push({ ...r, when: F.isMain });
  main({ ...say("I'll make it a small mod for this project: a panel in the rail that reads the last `npm test` in the session."), delayMs: 600, promptTokens: 10300, toolCalls: [F.call('skill', { name: 'create-mod' })] });
  main({ delayMs: 700, promptTokens: 11900, toolCalls: [F.call('write_file', { path: '.silo-harness/mods/test-runs/panel.html', content: PANEL_HTML })] });
  // The manifest last, and checked straight away: the card that offers to turn the mod on follows the check
  main({ delayMs: 700, promptTokens: 12600, toolCalls: [F.call('write_file', { path: '.silo-harness/mods/test-runs/mod.json', content: MOD_JSON }), F.call('mod_check', { id: 'test-runs' })] });
  main({ ...say('**Test runs** checks out clean. Once it is on, it sits at the top of the rail and updates after every test run.'), delayMs: 800, promptTokens: 13100 });
}

// ---------- the recording ----------

/**
 * Records the renderer page with Page.startScreencast over a CDP connection of its own: every frame is written to
 * `dir` with the time it was drawn.
 */
async function recorder(port, dir) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Could not connect to the page for the recording')), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const frames = [];
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method === 'Page.screencastFrame') {
      const { data, metadata, sessionId } = m.params;
      const file = path.join(dir, `raw-${String(frames.length).padStart(5, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
      send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    }
  });
  await send('Page.enable');
  await send('Page.startScreencast', { format: 'png', maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  return {
    frames,
    async stop() {
      await send('Page.stopScreencast').catch(() => {});
      await sleep(200);
      ws.close();
    },
  };
}

/** Lays the frames from `from` to the end on a steady clock: frame k shows what was on screen at k / fps (hard links). */
function steady(frames, from, fps, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const shown = frames.slice(from);
  const t0 = shown[0].t;
  const end = shown[shown.length - 1].t;
  const n = Math.floor((end - t0) * fps) + 1;
  let at = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k / fps;
    while (at + 1 < shown.length && shown[at + 1].t <= t + 1e-6) at++;
    fs.linkSync(shown[at].file, path.join(dir, `${String(k).padStart(5, '0')}.png`));
  }
  return { count: n, seconds: n / fps };
}

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

/** The GIF: scaled with Lanczos, a palette from the frames' changes (two passes), Sierra dithering, looping. */
function encodeGif(seq, fps, palette, out) {
  const scale = `scale=${GIF_W}:-1:flags=lanczos`;
  ffmpeg(['-framerate', String(fps), '-i', path.join(seq, '%05d.png'), '-vf', `${scale},palettegen=stats_mode=diff`, palette]);
  ffmpeg(['-framerate', String(fps), '-i', path.join(seq, '%05d.png'), '-i', palette, '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, '-loop', '0', out]);
}

/** The MP4: H.264 at full width, yuv420p so every browser plays it, the index in front so it starts at once. */
function encodeMp4(seq, fps, out) {
  ffmpeg(['-framerate', String(fps), '-i', path.join(seq, '%05d.png'), '-c:v', 'libx264', '-preset', 'veryslow', '-tune', 'animation', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
}

const LEAKS = /\bmock\b|oa-live|oh-demo|atlas-home|\/var\/folders|\/private\/var|\/private\/tmp|^Done\.$/m;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  makeProject();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-demo-'));
  const keepFrames = process.env.DEMO_FRAMES ? path.resolve(process.env.DEMO_FRAMES, DARK ? 'dark' : 'light') : '';
  if (keepFrames) fs.rmSync(keepFrames, { recursive: true, force: true });
  const frameDir = keepFrames || fs.mkdtempSync(path.join(os.tmpdir(), 'oh-demo-frames-'));
  fs.mkdirSync(frameDir, { recursive: true });
  fs.writeFileSync(path.join(F.HOME, '.zprofile'), `export PATH=${js(process.env.PATH)}\n`);
  F.seedSessions(profile);
  const mock = await startMock();
  // Auto mode's safety check passes everything the scenes do
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.ollamaPromptTokens = 8000;
  mock.state.ollamaModels = ['qwen3:8b', 'qwen3:14b'];
  // Every call has its own id, so the mod's panel finds the test run under its own name in the transcript
  mock.state.ollamaToolIds = true;
  const inspect = await F.freePort(0);
  let app;
  let rec;
  try {
    app = await launch({
      args: [`--inspect=${inspect}`],
      profile,
      project: F.PROJECT,
      mock: true,
      mode: 'auto',
      size: { width: W, height: H },
      scale: 1,
      env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
      config: {
        provider: 'ollama',
        ollama: { baseURL: `http://127.0.0.1:${mock.port}`, model: 'qwen3:8b', numCtx: 32768, think: 'auto' },
        theme: DARK ? 'dark' : 'light',
        remote: { enabled: false, bind: 'localhost', port: 0 },
        recentDirs: [F.PROJECT],
      },
    });
    const ev = app.evaluate;
    const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
    // A hidden window draws only when asked: keep every page drawing, often enough for a smooth recording
    await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); globalThis.__demoPump = setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 16); ${WIN}.setContentSize(${W}, ${H}); return true; })()`);
    // The page believes it has focus, as a window in front would: the composer shows its caret
    await app.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });

    // A new session in atlas-api, the reading column and the rail; the Browser pane closed
    await app.waitFor(`document.querySelectorAll('.session-item').length >= 8`, 15_000, 'the seeded sessions');
    await ev(`(() => { if (!document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-close').click(); })()`);
    await app.click('#new-session-btn');
    await app.waitFor(`!document.querySelector('#empty-state').hidden && document.querySelector('.session-item.active')`, 10_000, 'the new session');
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.seat === 'rail' && !v.collapsed).every((v) => v.hello && v.height > 0)`, 45_000, 'the rail');
    await ev(`(() => { const i = document.querySelector('#input'); i.focus(); })()`);
    await sleep(1500);

    // ---------------- the scene ----------------
    rec = await recorder(app.port, frameDir);
    for (const until = Date.now() + 5000; !rec.frames.length && Date.now() < until; ) await sleep(50);
    if (!rec.frames.length) throw new Error('the screencast sent no frames');
    const from = rec.frames.length - 1;

    let rnd = 7;
    const jitter = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
    /** Types into the composer one key at a time, at about a person's speed */
    const type = async (text) => {
      await ev(`document.querySelector('#input').focus()`);
      for (const ch of text) {
        const key = { key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
        await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
        await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        await sleep(38 + jitter() * 40 + (ch === ' ' ? 30 : 0));
      }
    };
    const idle = () => app.waitFor(`document.querySelector('#status-line').hidden && !document.querySelector('.session-item.active.running')`, 60_000, 'the run to end');
    const lastGroup = `[...document.querySelectorAll('#messages > .tool-group')].pop()`;
    /** A real click: the pointer moves onto the element (its hover shows), then presses and lets go */
    const press = async (selector) => {
      const b = await ev(`(() => { const r = document.querySelector(${js(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
      await sleep(450);
      await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await sleep(120);
      await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    };

    // 1. A coding turn: read the route, edit it, run the tests
    await sleep(700);
    scriptCode(mock);
    await type(ASK_CODE);
    await sleep(500);
    await app.key('Enter');
    // The calls open once the edit is in, to show its diff, and fold into one line when the summary starts
    await app.waitFor(`(() => { const g = ${lastGroup}; return g && [...g.querySelectorAll('.tool[data-tool="edit_file"] .tool-status.ok')].length > 0; })()`, 30_000, 'the edit');
    await ev(`(() => { const g = ${lastGroup}; g.open = true; const e = g.querySelector('.tool[data-tool="edit_file"]'); e.open = true; })()`);
    await app.waitFor(`(() => { const a = [...document.querySelectorAll('#messages > .msg.assistant')].pop(); const g = ${lastGroup}; return a && g && a.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_PRECEDING; })()`, 30_000, 'the summary');
    await ev(`(() => { const g = ${lastGroup}; g.open = false; })()`);
    await idle();
    await sleep(1500);

    // 2. The agent builds a mod; turned on from its card, it shows in the rail
    scriptMod(mock);
    await type(ASK_MOD);
    await sleep(500);
    await app.key('Enter');
    await idle();
    await app.waitFor(`Boolean(document.querySelector('.mod-offer:not(.done) .mod-offer-on'))`, 15_000, 'the card for the new mod');
    await sleep(1300);
    await press('.mod-offer:not(.done) .mod-offer-on');
    await app.waitFor(`window.__oc_debug.mods.views().some((v) => v.key.includes('test-runs') && v.hello && v.height > 0)`, 20_000, 'the Test runs panel');
    await ev(`document.querySelector('#input').focus()`);
    await sleep(2600);
    await rec.stop();
    const panel = await ev(`(() => { const s = document.querySelector('.rail-section[data-view*="test-runs"]'); const f = s && s.querySelector('iframe'); return s ? s.innerText + ' | frame ' + Boolean(f) : 'none'; })()`);
    console.log(`panel: ${panel.replace(/\n/g, ' ')}`);
    const text = await ev(`document.body.innerText`);
    const hit = LEAKS.exec(text);
    if (hit) console.log(`WARN "${hit[0]}" on screen: …${text.slice(Math.max(0, hit.index - 60), hit.index + 60).replace(/\n/g, ' | ')}…`);

    // The poster: the last frame again, at 2x
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    await sleep(1200);
    await app.screenshot(outFile('demo-poster', 'png'));
    console.log(`wrote ${outFile('demo-poster', 'png')} (${Math.round(fs.statSync(outFile('demo-poster', 'png')).size / 1024)} KB)`);

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    if (errors.length) console.log('console errors:\n' + errors.slice(-10).join('\n'));
    await app.close();
    app = null;

    // ---------------- the files ----------------
    const frames = rec.frames;
    const span = frames[frames.length - 1].t - frames[from].t;
    const gaps = frames.slice(from + 1).map((f, i) => f.t - frames[from + i].t).sort((a, b) => a - b);
    console.log(`captured ${frames.length - from} frames over ${span.toFixed(1)} s (${((frames.length - from) / span).toFixed(1)} a second; gaps median ${Math.round(gaps[gaps.length >> 1] * 1000)} ms, longest ${Math.round(gaps[gaps.length - 1] * 1000)} ms)`);
    if (keepFrames) fs.writeFileSync(path.join(frameDir, 'frames.json'), js(frames.slice(from).map((f) => ({ file: path.basename(f.file), t: f.t }))));
    const gifSeq = steady(frames, from, GIF_FPS, path.join(frameDir, `seq-${GIF_FPS}`));
    const mp4Seq = steady(frames, from, MP4_FPS, path.join(frameDir, `seq-${MP4_FPS}`));
    const gif = outFile('demo', 'gif');
    const mp4 = outFile('demo', 'mp4');
    encodeGif(path.join(frameDir, `seq-${GIF_FPS}`), GIF_FPS, path.join(frameDir, 'palette.png'), gif);
    encodeMp4(path.join(frameDir, `seq-${MP4_FPS}`), MP4_FPS, mp4);
    const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(2);
    console.log(`wrote ${gif} (${mb(gif)} MB, ${gifSeq.count} frames at ${GIF_FPS} fps, ${gifSeq.seconds.toFixed(1)} s)`);
    console.log(`wrote ${mp4} (${mb(mp4)} MB, ${mp4Seq.count} frames at ${MP4_FPS} fps, ${mp4Seq.seconds.toFixed(1)} s)`);
  } finally {
    if (app) await app.close();
    mock.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(F.HOME, { recursive: true, force: true });
    if (!keepFrames) fs.rmSync(frameDir, { recursive: true, force: true });
  }
}

const started = Date.now();
main().then(
  () => {
    console.log(`done in ${Math.round((Date.now() - started) / 1000)} s`);
    process.exit(0);
  },
  (e) => {
    console.error(e && e.stack);
    process.exit(1);
  },
);
