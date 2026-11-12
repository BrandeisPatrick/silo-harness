// Live test rig: launches the built app under Electron with a throwaway profile and drives the real window over
// the Chrome DevTools Protocol. No dependencies (Node 22+ for the global WebSocket).
//
// The model is the real API when ANTHROPIC_API_KEY is set (Anthropic's own endpoint through the app's gateway
// fields; the key travels in the environment and is never written to the profile), or, with no key and
// SILO_HARNESS_LIVE_ANT=1, the real API through a local relay that signs requests with the `ant` CLI's sign-in
// (ant-relay.js; the app is given a secret made for the run, never the token). Otherwise it is the mock model
// server from test/support. Nothing here touches your own profile, settings or sessions: the app gets
// its own --user-data-dir and its own config directory, and the window stays hidden.
//
//   const { launch } = require('./rig.js');
//   const app = await launch({ mode: 'bypass' });
//   await app.send('Say hello');
//   await app.waitIdle();
//   await app.screenshot('/tmp/hello.png');
//   await app.close();
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The mock models this process has started, by address: a relaunch finds its profile pointing at a closed one. */
const mockUrls = new Set();

/** The model live checks use unless a test asks for another one: the cheapest that handles tools well. */
const LIVE_MODEL = process.env.SILO_HARNESS_LIVE_MODEL || 'claude-haiku-5-5';

/** Where live runs get a real model from: 'key' (ANTHROPIC_API_KEY), 'ant' (the ant CLI's sign-in through ant-relay.js), or '' (the mock model). */
function liveSource() {
  if (process.env.ANTHROPIC_API_KEY) return 'key';
  return process.env.SILO_HARNESS_LIVE_ANT ? 'ant' : '';
}

async function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Starts the app. Options:
 *   root        the repository to run (default: this one); it must be built (npm run build)
 *   profile     the user-data folder (default: a new temp folder, removed by close())
 *   project     the working directory the app opens in (default: a new temp folder)
 *   mode        permission mode to start in (default 'ask')
 *   model       model id for the API (default LIVE_MODEL)
 *   mock        true forces the mock model even when a key is set
 *   config      extra fields merged into the seeded config.json
 *   seed        false leaves the profile without a config.json, to see what the app makes of the folder it finds
 *   env         extra environment variables for the app
 *   size        { width, height } of the page for screenshots (default 1440 x 900)
 *   scale       device pixels per CSS pixel for screenshots (default 2; 1 gives native-size PNGs)
 *   binary      the executable of a packaged app to drive instead of `electron <root>` (also: SILO_HARNESS_LIVE_APP),
 *               e.g. release/mac-arm64/Silo Harness.app/Contents/MacOS/Silo Harness
 *   ownsProfile whether close() removes the profile (default: only when the rig made it)
 *
 * For crash tests: kill() ends the app with SIGKILL (nothing runs on the way out) and keeps the profile and the
 * project; relaunch(extra) starts the app again on them, and the new instance's close() cleans up what this one
 * would have.
 */
async function launch(opts = {}) {
  const root = opts.root || ROOT;
  if (!fs.existsSync(path.join(root, 'dist', 'main', 'index.js'))) throw new Error('Build first: npm run build');
  let ownsProfile = opts.ownsProfile ?? !opts.profile;
  const profile = opts.profile || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-profile-'));
  const project = opts.project || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-project-'));
  const home = path.join(profile, 'home-config');
  // Not made when the test names the config folder itself (an empty value: the app's own, in a home the test made)
  const ownConfigDir = !(opts.env && 'SILO_HARNESS_CONFIG_DIR' in opts.env);
  if (ownConfigDir) fs.mkdirSync(home, { recursive: true });

  const ant = !opts.mock && liveSource() === 'ant' ? await require('./ant-relay.js').relay() : null;
  const key = opts.mock ? '' : process.env.ANTHROPIC_API_KEY || (ant ? ant.key : '');
  let mock = null;
  let baseURL = ant ? ant.baseURL : 'https://api.anthropic.com/v1';
  if (!key) {
    const { startMock } = require(path.join(root, 'test', 'support', 'mock-model.js'));
    mock = await startMock();
    baseURL = `http://127.0.0.1:${mock.port}/v1`;
    mockUrls.add(baseURL);
  }
  const config = {
    schemaVersion: 2,
    provider: 'portkey',
    portkey: { baseURL, apiKey: '', model: key ? opts.model || LIVE_MODEL : 'mock-model', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: project,
    permissionMode: opts.mode || 'ask',
    notifications: false,
    autoTitles: false,
    ...(opts.config || {}),
  };
  if (ant && config.provider === 'portkey') {
    // The relay is not api.anthropic.com, so the gateway block would talk to it in the OpenAI format. A provider of
    // type anthropic keeps the app on Anthropic's own API, as with a key; it takes the block's model and context size,
    // and the label the block has with a key, so the window reads the same.
    const block = { ...config.portkey, baseURL: ant.baseURL };
    config.portkey = block;
    config.providers = { ...(config.providers || {}), live: { type: 'anthropic', label: 'Gateway', baseURL: ant.baseURL, apiKeyEnv: 'SILO_HARNESS_LIVE_RELAY_KEY', model: block.model, contextWindow: block.contextWindow } };
    config.provider = 'live';
  }
  const configFile = path.join(profile, 'config.json');
  if (!fs.existsSync(configFile)) {
    if (opts.seed !== false) fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  } else if (mock) {
    // A relaunch on a kept profile: its settings still name the mock model of the instance before, closed by now.
    try {
      const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (saved.portkey && saved.portkey.baseURL !== baseURL && mockUrls.has(saved.portkey.baseURL)) {
        saved.portkey.baseURL = baseURL;
        fs.writeFileSync(configFile, JSON.stringify(saved, null, 2));
      }
    } catch {
      /* not a file this rig wrote */
    }
  }

  const port = opts.port || (await freePort());
  const electron = require(path.join(root, 'node_modules', 'electron'));
  const env = {
    ...process.env,
    SILO_HARNESS_LIVE_TEST: '1',
    // The app's own config directory (settings.json, skills, mods) is redirected too, so a test never reads yours.
    SILO_HARNESS_CONFIG_DIR: home,
    PORTKEY_API_KEY: key || 'mock-key',
    ...(ant ? { SILO_HARNESS_LIVE_RELAY_KEY: ant.key } : {}),
    ...(opts.env || {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // A packaged app is its own executable; in development Electron is given the repository to run.
  const binary = opts.binary || process.env.SILO_HARNESS_LIVE_APP;
  const flags = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...(opts.args || [])];
  const child = binary ? spawn(binary, flags, { env, stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(electron, [root, ...flags], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  const keep = (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) logs.push(line);
    if (logs.length > 2000) logs.splice(0, logs.length - 2000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = false;
  child.once('exit', () => (exited = true));

  // The renderer page is the target whose URL is the app's index.html (the built-in browser is another target).
  let wsUrl = '';
  const deadline = Date.now() + 30_000;
  while (!wsUrl) {
    if (exited) throw new Error(`The app exited during start-up:\n${logs.slice(-20).join('\n')}`);
    if (Date.now() > deadline) throw new Error(`The app did not open its window within 30 s:\n${logs.slice(-20).join('\n')}`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url));
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch {
      /* not listening yet */
    }
    if (!wsUrl) await sleep(150);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Could not connect to the DevTools endpoint')), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const consoleLines = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleLines.push(`[exception] ${d.exception?.description || d.text}`);
    }
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const size = opts.size || { width: 1440, height: 900 };
  await cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: opts.scale || 2, mobile: false });

  /** Runs an expression in the page (promises are awaited) and returns its JSON value. */
  async function evaluate(expression) {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  /** Polls until the expression is truthy; returns its value. */
  async function waitFor(expression, timeoutMs = 20_000, what = expression) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const v = await evaluate(expression).catch(() => undefined);
      if (v) return v;
      if (exited) throw new Error(`The app exited while waiting for: ${what}`);
      if (Date.now() > until) throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}`);
      await sleep(120);
    }
  }

  const q = (selector) => JSON.stringify(selector);
  let toolSeq = 0;
  const api = {
    root,
    profile,
    project,
    port,
    /** true when the run talks to the real API, false with the mock model */
    live: Boolean(key),
    mock,
    logs,
    console: consoleLines,
    cdp,
    evaluate,
    waitFor,
    /**
     * The CDP websocket URL of a page in the Browser pane (a tab, a popup) whose URL starts with `prefix`, polled
     * until it is there. Use it with evalAt / cdpAt to run code inside that page.
     */
    async pageTarget(prefix, timeoutMs = 10_000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json().catch(() => []);
        const t = list.find((x) => x.type === 'page' && String(x.url).startsWith(prefix));
        if (t) return t.webSocketDebuggerUrl;
        if (exited) throw new Error('The app exited while looking for a pane page');
        if (Date.now() > until) throw new Error(`The Browser pane has no page whose URL starts with ${prefix}`);
        await sleep(100);
      }
    },
    /** Every page target of the pane whose URL starts with `prefix` (several tabs of one site), as { url, wsUrl }. */
    async pageTargets(prefix) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json().catch(() => []);
      return list.filter((x) => x.type === 'page' && String(x.url).startsWith(prefix)).map((x) => ({ url: x.url, wsUrl: x.webSocketDebuggerUrl }));
    },
    /** PNG of the window's page (2x, or the launch's `scale`). `clip` is { x, y, width, height } in CSS pixels. */
    async screenshot(file, clip) {
      let r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      // In the hidden window, a capture after some changes (seen every time Settings opens or closes) can
      // come back as a stale surface at half the emulated size, repeated 2 × 2. A tiny clipped capture makes the
      // compositor draw a fresh frame at the emulated scale, and the capture after it is whole. Only then: the extra
      // frame re-rasterises the page, which a pixel comparison of two captures would count as change.
      // A clipped capture of such a surface shows the same 2 × 2 repeat inside the clip, and gets the same remedy.
      if (looksTiled(Buffer.from(r.data, 'base64'))) {
        await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
        r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    /** PNG of one element (by selector), with a margin around it. */
    async screenshotOf(file, selector, margin = 0) {
      const box = await evaluate(`(() => { const e = document.querySelector(${q(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      if (!box) throw new Error(`No element matches ${selector}`);
      return api.screenshot(file, { x: Math.max(0, box.x - margin), y: Math.max(0, box.y - margin), width: box.width + margin * 2, height: box.height + margin * 2 });
    },
    exists: (selector) => evaluate(`Boolean(document.querySelector(${q(selector)}))`),
    text: (selector) => evaluate(`(document.querySelector(${q(selector)})?.innerText ?? null)`),
    count: (selector) => evaluate(`document.querySelectorAll(${q(selector)}).length`),
    async click(selector) {
      await waitFor(`Boolean(document.querySelector(${q(selector)}))`, 10_000, `element ${selector}`);
      await evaluate(`document.querySelector(${q(selector)}).click()`);
    },
    /** Sets a text field's value the way typing would (fires input and change). */
    async fill(selector, value) {
      await waitFor(`Boolean(document.querySelector(${q(selector)}))`, 10_000, `element ${selector}`);
      await evaluate(`(() => { const e = document.querySelector(${q(selector)}); e.focus(); const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(String(value))}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    },
    /** A real key press in the page, e.g. key('Escape') or key('k', { meta: true }). */
    async key(key, mods = {}) {
      const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
      const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Backspace: 8 };
      const base = { key, modifiers, windowsVirtualKeyCode: codes[key] ?? key.toUpperCase().charCodeAt(0), code: key.length === 1 ? `Key${key.toUpperCase()}` : key };
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      if (key.length === 1 && !mods.meta && !mods.ctrl) await cdp('Input.dispatchKeyEvent', { type: 'char', text: key, ...base });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    /** Types a message into the composer and sends it. */
    async send(text) {
      await api.fill('#input', text);
      await waitFor(`!document.querySelector('#send-btn').disabled`, 5_000, 'the send button to enable');
      await api.click('#send-btn');
    },
    /** Waits until a run has started and ended (or, with started=false, just until nothing is running). */
    async waitIdle(timeoutMs = 120_000, started = true) {
      const busy = `(() => { const s = document.querySelector('#status-line'); return Boolean(s && !s.hidden) || Boolean(document.querySelector('.session-item.running')); })()`;
      if (started) await waitFor(busy, 15_000, 'the run to start').catch(() => undefined);
      await waitFor(`!(${busy})`, timeoutMs, 'the run to end');
      await sleep(250);
    },
    /**
     * The transcript as text: one entry per message, tool row or card, in order. A folded run of tool calls is one
     * entry for its line followed by one for each row inside it, whether it is open or not.
     */
    transcript: () =>
      evaluate(`(() => {
        const out = [];
        const flat = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 2000);
        for (const e of document.querySelectorAll('#messages > *')) {
          if (e.id === 'empty-state' || e.hidden) continue;
          out.push({ cls: e.className, text: (e.innerText || '').trim().slice(0, 2000) });
          if (!e.classList.contains('tool-group')) continue;
          for (const row of e.querySelectorAll(':scope > .group-body > *')) out.push({ cls: row.className, text: flat(row.querySelector(':scope > summary') || row) });
        }
        return out;
      })()`),
    /**
     * One user turn in which the mock model calls tool `name` with `args` once (then says "Done."); resolves with the
     * tool's result as the model got it. Mock model only.
     */
    async callTool(name, args, timeoutMs = 60_000) {
      if (!mock) throw new Error('callTool needs the mock model');
      const id = `call_${name}_${++toolSeq}`;
      const marker = `Tool step ${toolSeq}: ${name.replace(/_/g, ' ')}`;
      mock.state.replies.push({
        content: '',
        toolCalls: [{ id, name, args }],
        when: (payload) => {
          const m = payload.messages?.[payload.messages.length - 1];
          return Boolean(m && m.role === 'user' && (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes(marker));
        },
      });
      await api.send(marker);
      let content = null;
      for (const until = Date.now() + timeoutMs; content === null && Date.now() < until; ) {
        for (const r of [...mock.state.requests].reverse()) {
          const m = (r.payload?.messages ?? []).find((x) => x.role === 'tool' && x.tool_call_id === id);
          if (m) content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        }
        if (content === null) await sleep(100);
      }
      await waitFor(`(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`, timeoutMs, `${name} to finish`);
      await sleep(150);
      return content;
    },
    /** Opens every folded turn (its "Worked for 53s" header), so the process under it is on screen again. */
    unfold: () => evaluate(`[...document.querySelectorAll('#messages > .turn-head.folded button')].forEach((b) => b.click())`),
    /** The last assistant reply's text. */
    lastReply: () => evaluate(`(() => { const all = document.querySelectorAll('.msg.assistant'); const e = all[all.length - 1]; return e ? e.innerText.trim() : ''; })()`),
    /** Answers the open approval card: 'allow' or 'deny'. */
    async approve(answer = 'allow') {
      await waitFor(`Boolean(document.querySelector('.approval:not(.decided) .btn'))`, 60_000, 'an approval card');
      await evaluate(`(() => { const card = [...document.querySelectorAll('.approval')].filter((c) => !c.classList.contains('decided')).pop(); const btns = [...card.querySelectorAll('.btn')]; const pick = ${JSON.stringify(answer)} === 'deny' ? btns.find((b) => /deny/i.test(b.innerText)) : card.querySelector('.btn.primary'); pick.click(); })()`);
    },
    /** The Electron process */
    child,
    /** Kills the app at once, as a crash would; the profile and the project stay for relaunch(). */
    async kill() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (!exited) {
        child.kill('SIGKILL');
        await Promise.race([new Promise((r) => child.once('exit', r)), sleep(4000)]);
      }
      mock?.close();
    },
    /** Starts the app again on the same profile and project (after kill() or close()); the new instance owns the clean-up. */
    async relaunch(extra = {}) {
      const owned = ownsProfile;
      ownsProfile = false;
      return launch({ ...opts, ...extra, root, profile, project, ownsProfile: owned });
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (!exited) {
        child.kill('SIGTERM');
        await Promise.race([new Promise((r) => child.once('exit', r)), sleep(4000)]);
        if (!exited) child.kill('SIGKILL');
      }
      mock?.close();
      if (ownsProfile) fs.rmSync(profile, { recursive: true, force: true });
    },
  };
  // The page is usable once the composer has taken focus at the end of its start-up.
  await waitFor(`Boolean(window.oc) && Boolean(document.querySelector('#input'))`, 20_000, 'the page to load');
  await sleep(400);
  return api;
}

/**
 * Whether a PNG screenshot is its own top-left quarter repeated 2 × 2 (a stale surface of a hidden window). Decodes
 * the PNG (8-bit RGB or RGBA, as CDP writes them) and compares sample points across the four quarters; a real page
 * agrees at nearly none of them.
 */
function looksTiled(png) {
  const zlib = require('node:zlib');
  let i = 8;
  let w = 0;
  let h = 0;
  let bpp = 4;
  const idat = [];
  while (i < png.length) {
    const len = png.readUInt32BE(i);
    const type = png.toString('ascii', i + 4, i + 8);
    if (type === 'IHDR') {
      w = png.readUInt32BE(i + 8);
      h = png.readUInt32BE(i + 12);
      bpp = png[i + 17] === 2 ? 3 : 4;
    }
    if (type === 'IDAT') idat.push(png.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  if (w < 64 || h < 64 || w % 2 || h % 2) return false;
  const d = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = d[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = d[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? raw[y * stride + x - bpp] : 0;
      const up = y ? raw[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? raw[(y - 1) * stride + x - bpp] : 0;
      let o = v;
      if (ft === 1) o = v + a;
      else if (ft === 2) o = v + up;
      else if (ft === 3) o = v + ((a + up) >> 1);
      else if (ft === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        o = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      raw[y * stride + x] = o & 255;
    }
  }
  let same = 0;
  let n = 0;
  const varied = new Set();
  for (let y = 7; y < h / 2; y += 29) {
    for (let x = 7; x < w / 2; x += 31) {
      n++;
      const at = (xx, yy) => raw.readUIntBE((yy * w + xx) * bpp, 3);
      const p = at(x, y);
      varied.add(p);
      if (p === at(x + w / 2, y) && p === at(x, y + h / 2) && p === at(x + w / 2, y + h / 2)) same++;
    }
  }
  // A blank page agrees everywhere too: only a quarter with something in it counts as tiled.
  return varied.size > 8 && same / n > 0.97;
}

/**
 * Runs an expression over CDP in another target (the main process's inspector, or a page in the Browser pane) and
 * returns its JSON value; an exception comes back as { error }.
 */
async function evalAt(wsUrl, expression, timeoutMs = 15_000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const res = await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) resolve(m.result?.exceptionDetails ? { error: m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text } : m.result?.result?.value);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }));
    setTimeout(() => resolve({ error: 'timed out' }), timeoutMs);
  });
  ws.close();
  return res;
}

/** Sends one CDP command to another target and returns its result (or { error }). */
async function cdpAt(wsUrl, method, params = {}, timeoutMs = 15_000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const res = await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) resolve(m.error ? { error: m.error.message } : m.result);
    });
    ws.send(JSON.stringify({ id: 1, method, params }));
    setTimeout(() => resolve({ error: 'timed out' }), timeoutMs);
  });
  ws.close();
  return res;
}

/** A small check helper in the style of test/support/check.js, for live scripts. */
function checker() {
  let failures = 0;
  return {
    check(label, cond, detail) {
      if (!cond) failures++;
      console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`.slice(0, 600));
    },
    done() {
      console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
      return failures;
    },
  };
}

module.exports = { launch, checker, sleep, evalAt, cdpAt, LIVE_MODEL, liveSource };
