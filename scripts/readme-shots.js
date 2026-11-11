// Makes the README screenshots in the real app: hero, mods, sidebar, images, settings, remote and approval.
// With --dark the same scenes are taken in the dark theme, as <name>-dark.png beside the light ones (the website
// shows the pair that matches its theme; the README keeps the light ones).
//
// The built app runs hidden on a throwaway profile (test/live/rig.js) against the scripted model
// (test/support/mock-model.js, Ollama path, reported as qwen3:8b). Only the model's replies and a few earlier
// sessions in the sidebar are scripted: the tools really run on a small project, `atlas-api`. Everything the run
// makes sits in one temp home folder that the app gets as HOME, so the project at <home>/code/atlas-api shows as
// ~/code/atlas-api; it is removed afterwards, with the profile. The model's Grafana panel comes from a small MCP
// server written there too. The remote-control page is loaded from the app's own remote server in a hidden
// phone-sized window (this script, re-run under Electron).
//
//   npm run build   (once; dist/ must be current)
//   node scripts/readme-shots.js [out-dir] [--dark]      default: docs/screenshots
//
// Required as a module it runs nothing and hands out its fixtures (the project, the seeded sessions, the scripted
// replies, the PNG helpers), for other screenshot scripts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------------------------------------------
// Electron mode: capture the remote-control page at phone size (2x). Run by the main script, never by hand.
// ---------------------------------------------------------------------------------------------------------------
if (process.versions.electron && process.type === 'browser') {
  const { app, BrowserWindow, nativeTheme } = require('electron');
  const [url, out, userData] = process.argv.slice(-3);
  // Its own data folder (in the run's temp home), not Electron's default one in ~/Library
  app.setPath('userData', userData);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  app.dock?.hide();
  app.whenReady().then(async () => {
    try {
      nativeTheme.themeSource = process.env.README_SHOTS_THEME === 'dark' ? 'dark' : 'light';
      const W = 390;
      const H = 844;
      const win = new BrowserWindow({ width: W, height: H, show: false, paintWhenInitiallyHidden: true, webPreferences: { sandbox: true, contextIsolation: true } });
      await win.loadURL(url);
      const js = (code) => win.webContents.executeJavaScript(code);
      // Loaded: the main script starts the turn now, and the card arrives over the page's live stream
      await sleep(1000);
      console.log('PHONE_READY');
      const until = Date.now() + 60_000;
      while (!(await js(`Boolean(document.querySelector('.card.approval:not(.decided)'))`))) {
        if (Date.now() > until) throw new Error('no approval card on the remote page');
        await sleep(100);
      }
      await sleep(800);
      const dbg = win.webContents.debugger;
      dbg.attach('1.3');
      // Scrolled to the end, the header covers the top of the transcript: pick the phone height (around an iPhone's
      // 844) at which that edge falls between two items rather than through one.
      let h = H;
      for (const candidate of [H, 812, 852, 832, 800, 860, 820, 790, 870, 780]) {
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: W, height: candidate, deviceScaleFactor: 2, mobile: true });
        await sleep(250);
        const cut = await js(`(() => { const s = document.getElementById('scroll'); s.scrollTop = s.scrollHeight; const top = document.querySelector('header.top').getBoundingClientRect().bottom; return [...document.querySelectorAll('#transcript > *')].some((e) => { const r = e.getBoundingClientRect(); return r.height && r.top < top - 1 && r.bottom > top + 1; }); })()`);
        h = candidate;
        if (!cut) break;
      }
      console.log(`phone: ${W} x ${h}`);
      await sleep(400);
      // A hidden window only advances animations while frames are produced: draw a few before the capture.
      for (let i = 0; i < 4; i++) {
        win.webContents.invalidate();
        await win.webContents.capturePage();
        await sleep(150);
      }
      const r = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
      console.log(`phone: wrote ${out}`);
      app.exit(0);
    } catch (err) {
      console.error('phone capture failed:', err && err.stack);
      app.exit(1);
    }
  });
  return;
}

// ---------------------------------------------------------------------------------------------------------------
// Node mode
// ---------------------------------------------------------------------------------------------------------------
const { launch, sleep } = require(path.join(ROOT, 'test', 'live', 'rig.js'));
const { startMock } = require(path.join(ROOT, 'test', 'support', 'mock-model.js'));

const DARK = process.argv.includes('--dark');
const OUT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs', 'screenshots'));
/** The file a scene is written to: hero.png, or hero-dark.png in the dark pass */
const outFile = (name) => path.join(OUT, `${name}${DARK ? '-dark' : ''}.png`);
// Everything the run makes lives in one temp home: the app runs with HOME pointing at it, so the project at
// <home>/code/atlas-api shows as ~/code/atlas-api and the app's config folder is <home>/.silo-harness.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-home-')));
const PROJECT = path.join(HOME, 'code', 'atlas-api');
const CONFIG_DIR = path.join(HOME, '.silo-harness');
const js = (v) => JSON.stringify(v);

// ---------- PNG crop ----------
// Page.captureScreenshot with a clip under the 2x emulation can come back with the region drawn twice, so every
// shot is taken whole and cropped here. 8-bit RGB/RGBA, non-interlaced: what Chromium writes.

const zlib = require('node:zlib');

function decodePng(buf) {
  let i = 8;
  let w = 0;
  let h = 0;
  let bpp = 4;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'IHDR') {
      w = buf.readUInt32BE(i + 8);
      h = buf.readUInt32BE(i + 12);
      if (buf[i + 16] !== 8 || buf[i + 20] !== 0) throw new Error('unexpected PNG format');
      bpp = { 2: 3, 6: 4 }[buf[i + 17]];
      if (!bpp) throw new Error('unexpected PNG colour type');
    }
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const d = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = d[y * (stride + 1)];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const r = d[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const up = y ? out[row - stride + x] : 0;
      const c = x >= bpp && y ? out[row - stride + x - bpp] : 0;
      let v = r;
      if (ft === 1) v = r + a;
      else if (ft === 2) v = r + up;
      else if (ft === 3) v = r + ((a + up) >> 1);
      else if (ft === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      out[row + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

function encodePng({ w, h, bpp, data }) {
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  const cand = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    // Pick the filter with the smallest sum of absolute values, as libpng does
    let best = null;
    let bestSum = Infinity;
    for (let ft = 0; ft <= 4; ft++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const cur = data[y * stride + x];
        const a = x >= bpp ? data[y * stride + x - bpp] : 0;
        const up = y ? data[(y - 1) * stride + x] : 0;
        const c = x >= bpp && y ? data[(y - 1) * stride + x - bpp] : 0;
        let pred = 0;
        if (ft === 1) pred = a;
        else if (ft === 2) pred = up;
        else if (ft === 3) pred = (a + up) >> 1;
        else if (ft === 4) {
          const p = a + up - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
        }
        const v = (cur - pred) & 255;
        cand[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = { ft, bytes: Buffer.from(cand) };
      }
    }
    raw[y * (stride + 1)] = best.ft;
    best.bytes.copy(raw, y * (stride + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b) => {
    let c = ~0;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return ~c >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = bpp === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Crops a PNG to a rectangle given in device pixels; the result is RGB when every pixel is opaque. */
function cropPng(buf, x, y, width, height) {
  const img = decodePng(buf);
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  width = Math.min(img.w - x, Math.round(width));
  height = Math.min(img.h - y, Math.round(height));
  let opaque = img.bpp === 3;
  if (!opaque) {
    opaque = true;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) { opaque = false; break; }
  }
  const bpp = opaque ? 3 : img.bpp;
  const data = Buffer.alloc(width * height * bpp);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const s = ((y + r) * img.w + x + c) * img.bpp;
      const d = (r * width + c) * bpp;
      for (let k = 0; k < bpp; k++) data[d + k] = img.data[s + k];
    }
  }
  return encodePng({ w: width, h: height, bpp, data });
}

// ---------- the project ----------

/** A small deterministic PRNG, so every run draws the same traffic. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Yesterday's traffic, one request per line: 46 ordinary clients, and one scraper from 14:18 to 14:44. */
function traffic() {
  const rnd = prng(20261105);
  const start = Date.UTC(2026, 10, 5, 14, 0, 0);
  const lines = [];
  const paths = ['/v1/products', '/v1/products', '/v1/products/p_1001', '/v1/products/p_1002', '/v1/products/p_1007', '/health'];
  const clients = Array.from({ length: 46 }, (_, i) => `198.51.100.${10 + i}`);
  for (let m = 0; m < 60; m++) {
    const wave = 1 + 0.35 * Math.sin((m / 60) * Math.PI * 2 - 0.6);
    for (const ip of clients) {
      const n = Math.round((3 + rnd() * 4) * wave);
      for (let k = 0; k < n; k++) lines.push({ t: start + m * 60_000 + Math.floor(rnd() * 60_000), ip, path: paths[Math.floor(rnd() * paths.length)] });
    }
    if (m >= 18 && m <= 44) {
      const n = Math.round(380 + 260 * Math.sin(((m - 18) / 26) * Math.PI) + rnd() * 40);
      for (let k = 0; k < n; k++) lines.push({ t: start + m * 60_000 + Math.floor(rnd() * 60_000), ip: '203.0.113.42', path: `/v1/products/p_${1001 + Math.floor(rnd() * 40)}` });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const FILES = {
  'package.json': JSON.stringify({ name: 'atlas-api', version: '0.4.0', private: true, description: 'Product catalogue API for the Atlas storefront', main: 'src/server.js', scripts: { start: 'node src/server.js', test: 'node --test' }, engines: { node: '>=22' } }, null, 2) + '\n',
  'README.md': '# atlas-api\n\nProduct catalogue API for the Atlas storefront.\n\n```bash\nnpm start   # http://localhost:3000\nnpm test\n```\n',
  '.gitignore': 'node_modules/\n.env\n',
  'src/server.js': `const http = require('node:http');
const { requestId } = require('./middleware/requestId');
const routes = require('./routes');

function createServer() {
  const stack = [requestId];
  const stats = { started: Date.now(), served: 0, limited: 0 };
  return http.createServer((req, res) => {
    res.on('finish', () => {
      stats.served++;
      if (res.statusCode === 429) stats.limited++;
    });
    let i = 0;
    const next = () => (i < stack.length ? stack[i++](req, res, next) : routes.handle(req, res, stats));
    next();
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(\`atlas-api listening on http://localhost:\${port}\`));
}

module.exports = { createServer };
`,
  'src/middleware/requestId.js': `const { randomUUID } = require('node:crypto');

/** Gives every request an id, taken from X-Request-Id when the caller sent one. */
function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = { requestId };
`,
  'src/routes.js': `const products = require('./products.json');

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function statusPage(stats) {
  const up = Math.round((Date.now() - stats.started) / 60_000);
  const row = (k, v) => \`<div class="row"><span>\${k}</span><b>\${v}</b></div>\`;
  return \`<!doctype html><meta charset="utf-8"><title>atlas-api status</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f6f5f1;color:#29261b;margin:0;padding:48px}
.card{max-width:520px;margin:auto;background:#fff;border:1px solid #e4e1d8;border-radius:12px;padding:24px 28px}
h1{font-size:20px;margin:0 0 4px}.ok{color:#2f7d4f;font-weight:600}.row{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #efede6}</style>
<div class="card"><h1>atlas-api</h1><p class="ok">● Operational</p>
\${row('Version', '0.4.0')}\${row('Uptime', \`\${up} min\`)}\${row('Requests served', stats.served)}\${row('Rate-limited (429)', stats.limited)}\${row('Node', process.version)}</div>\`;
}

function handle(req, res, stats) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/health') return json(res, 200, { ok: true });
  if (pathname === '/status') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(statusPage(stats));
  }
  if (pathname === '/v1/products') return json(res, 200, { data: products });
  const m = /^\\/v1\\/products\\/([\\w-]+)$/.exec(pathname);
  if (m) {
    const p = products.find((x) => x.id === m[1]);
    return p ? json(res, 200, p) : json(res, 404, { error: 'not_found' });
  }
  json(res, 404, { error: 'not_found' });
}

module.exports = { handle };
`,
  'src/products.json': JSON.stringify(
    [
      { id: 'p_1001', name: 'Trail Runner 3', price: 129 },
      { id: 'p_1002', name: 'Summit Shell Jacket', price: 249 },
      { id: 'p_1003', name: 'Merino Base Layer', price: 89 },
      { id: 'p_1007', name: 'Ridge 28L Pack', price: 159 },
    ],
    null,
    2,
  ) + '\n',
  'test/routes.test.js': `const test = require('node:test');
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

test('GET /health answers ok', () => withServer(async (base) => {
  const res = await fetch(\`\${base}/health\`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
}));

test('GET /v1/products lists the catalogue', () => withServer(async (base) => {
  const { data } = await (await fetch(\`\${base}/v1/products\`)).json();
  assert.equal(data.length, 4);
}));

test('GET /v1/products/:id returns one product', () => withServer(async (base) => {
  const p = await (await fetch(\`\${base}/v1/products/p_1002\`)).json();
  assert.equal(p.name, 'Summit Shell Jacket');
}));

test('unknown products are 404', () => withServer(async (base) => {
  assert.equal((await fetch(\`\${base}/v1/products/nope\`)).status, 404);
}));

test('responses carry a request id', () => withServer(async (base) => {
  const res = await fetch(\`\${base}/health\`, { headers: { 'x-request-id': 'abc' } });
  assert.equal(res.headers.get('x-request-id'), 'abc');
}));
`,
  'scripts/replay.js': `#!/usr/bin/env node
// Replays recorded traffic through the rate limiter and charts requests per minute served, with and without it.
//   node scripts/replay.js <traffic.ndjson> <out.svg>
const fs = require('node:fs');
const { rateLimit } = require('../src/middleware/rateLimit');

const [file, out] = process.argv.slice(2);
const events = fs.readFileSync(file, 'utf8').trim().split('\\n').map((l) => JSON.parse(l));
const t0 = events[0].t;
const minutes = Math.ceil((events[events.length - 1].t - t0 + 1) / 60_000);
const before = new Array(minutes).fill(0);
const after = new Array(minutes).fill(0);
let now = t0;
const limiter = rateLimit({ limit: 100, windowMs: 60_000, skip: (req) => req.url === '/health', now: () => now });
const res = { statusCode: 200, setHeader() {}, writeHead(s) { this.statusCode = s; }, end() {} };
let rejected = 0;
for (const e of events) {
  now = e.t;
  const m = Math.floor((e.t - t0) / 60_000);
  before[m]++;
  let served = false;
  limiter({ url: e.path, headers: {}, socket: { remoteAddress: e.ip } }, res, () => (served = true));
  if (served) after[m]++;
  else rejected++;
}

// ---- the chart ----
const W = 420, H = 260, L = 40, R = 22, T = 58, B = 30;
const top = Math.ceil(Math.max(...before) / 200) * 200;
const x = (i) => L + (i / (minutes - 1)) * (W - L - R);
const y = (v) => T + (1 - v / top) * (H - T - B);
const line = (vals) => vals.map((v, i) => \`\${i ? 'L' : 'M'}\${x(i).toFixed(1)},\${y(v).toFixed(1)}\`).join('');
const grid = [];
for (let v = 0; v <= top; v += 200) grid.push(\`<line x1="\${L}" x2="\${W - R}" y1="\${y(v)}" y2="\${y(v)}" stroke="#ebe8df"/><text x="\${L - 7}" y="\${y(v) + 3.5}" text-anchor="end">\${v}</text>\`);
for (let m = 0; m < minutes; m += 15) grid.push(\`<text x="\${x(m)}" y="\${H - B + 17}" text-anchor="middle">14:\${String(m).padStart(2, '0')}</text>\`);
grid.push(\`<text x="\${x(minutes - 1)}" y="\${H - B + 17}" text-anchor="middle">15:00</text>\`);
const svg = \`<svg xmlns="http://www.w3.org/2000/svg" width="\${W}" height="\${H}" viewBox="0 0 \${W} \${H}" font-family="-apple-system, system-ui, sans-serif">
<rect width="\${W}" height="\${H}" fill="#fdfcf9"/>
<text x="\${L - 26}" y="24" font-size="13" font-weight="600" fill="#29261b">Requests per minute, Nov 5 (UTC)</text>
<g font-size="10.5" fill="#6f6b60">
<line x1="\${L - 26}" x2="\${L - 8}" y1="40" y2="40" stroke="#a8a49a" stroke-width="2" stroke-dasharray="4 3"/><text x="\${L - 3}" y="43.5">Without the limiter</text>
<line x1="\${L + 112}" x2="\${L + 130}" y1="40" y2="40" stroke="#277de2" stroke-width="2.5"/><text x="\${L + 135}" y="43.5">With the limiter (100 a minute per client)</text>
</g>
<g font-size="10" fill="#8a867b">\${grid.join('')}</g>
<path d="\${line(after)}L\${x(minutes - 1)},\${y(0)}L\${x(0)},\${y(0)}Z" fill="#277de2" fill-opacity="0.10"/>
<path d="\${line(before)}" fill="none" stroke="#a8a49a" stroke-width="1.75" stroke-dasharray="4 3" stroke-linejoin="round"/>
<path d="\${line(after)}" fill="none" stroke="#277de2" stroke-width="2.25" stroke-linejoin="round"/>
</svg>
\`;
fs.writeFileSync(out, svg);
const clients = new Set(events.map((e) => e.ip)).size;
console.log(\`Replayed \${events.length.toLocaleString('en-US')} requests from \${clients} clients over \${minutes} min\`);
console.log(\`Without the limiter: peak \${Math.max(...before)} req/min\`);
console.log(\`With the limiter:    peak \${Math.max(...after)} req/min, \${rejected.toLocaleString('en-US')} answered 429\`);
console.log(\`Wrote \${out}\`);
`,
};

const RATE_LIMIT_JS = `// Fixed-window rate limiting per client IP: \`limit\` requests per \`windowMs\`, then 429 with Retry-After.
function rateLimit({ limit = 100, windowMs = 60_000, skip = () => false, now = Date.now } = {}) {
  const hits = new Map();
  return function limitRequests(req, res, next) {
    if (skip(req)) return next();
    const key = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const t = now();
    let entry = hits.get(key);
    if (!entry || t >= entry.reset) {
      entry = { count: 0, reset: t + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
    if (entry.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((entry.reset - t) / 1000)));
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'rate_limited' }));
    }
    next();
  };
}

module.exports = { rateLimit };
`;

function makeProject() {
  fs.mkdirSync(PROJECT, { recursive: true });
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(PROJECT, rel)), { recursive: true });
    fs.writeFileSync(path.join(PROJECT, rel), text);
  }
  fs.mkdirSync(path.join(PROJECT, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'reports', 'traffic-2026-11-05.ndjson'), traffic());
  const git = (...args) => execFileSync('git', args, { cwd: PROJECT, stdio: 'ignore', env: { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Sam Rivera');
  git('config', 'user.email', 'sam@atlas.example');
  git('add', '-A');
  git('commit', '-q', '-m', 'Catalogue routes, request ids, traffic replay');
  git('checkout', '-q', '-b', 'feat/rate-limit');
}

// ---------- earlier sessions in the sidebar ----------

const DAY = 86_400_000;

function seedSessions(profile) {
  const dir = path.join(profile, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const midnight = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  // Times inside today stay before now even just after midnight
  const today = (frac) => midnight + Math.floor((now - midnight) * frac);
  const ago = (n, h) => midnight - n * DAY + h * 3_600_000;
  const id = () => crypto.randomUUID();
  const ids = { main: id(), audit: id(), config: id(), configFork: id() };
  const s = (sid, title, at, messages, extra = {}) => ({ id: sid, title, createdAt: at, updatedAt: at, titleLocked: true, cwd: PROJECT, messages, ...extra });
  const pair = (q, a) => [{ role: 'user', content: q }, { role: 'assistant', content: a }];
  const list = [
    s(ids.main, 'Add rate limiting to the public routes', today(0.9), pair('Which routes are public, and is anything in front of them today?', 'Three: `GET /v1/products`, `GET /v1/products/:id`, and `/health` for the load balancer. Nothing limits them: the only middleware is `requestId`, which tags each request, so one client can take as much as the server will give.')),
    s(ids.audit, 'Audit the public routes', today(0.86), pair('List every route in src/ that answers without authentication, with its method and handler.', '`/health`, `/status`, `/v1/products` and `/v1/products/:id`, all in `src/routes.js`. None of them are authenticated.'), { parentId: ids.main, origin: 'spawn', mergedInto: ids.main, mergedAt: today(0.88) }),
    s(id(), 'Fix the flaky webhook retry test', today(0.7), pair('The webhook retry test fails about one run in five. Find out why.', 'The retry waited a fixed 3 s and the test times out at 5 s. The backoff is configurable now and the test passes `backoffMs: 0`; 20 runs in a row pass.'), { unread: true }),
    s(id(), 'Bump Node to 22 in CI', today(0.45), pair('Move CI to Node 22.', 'CI runs on Node 22 now, and `engines` in package.json says so too.')),
    s(ids.config, 'Move config to environment variables', ago(1, 10), pair('Read the port, log level and database URL from the environment.', 'Done: `src/config.js` reads `PORT`, `LOG_LEVEL` and `DATABASE_URL` with defaults for local work.')),
    s(ids.configFork, 'Config from a .env file instead', ago(1, 11), pair('Read the port, log level and database URL from the environment.', 'Done: `src/config.js` reads `PORT`, `LOG_LEVEL` and `DATABASE_URL` with defaults for local work.'), { forkedFrom: ids.config, origin: 'fork', seedLength: 2 }),
    s(id(), 'Nightly dependency audit', ago(1, 3), pair('Run npm audit and summarise anything high or critical.', 'No high or critical advisories. Two moderate ones in dev dependencies.'), { origin: 'schedule' }),
    s(id(), 'Paginate the /orders endpoint', ago(2, 15), pair('Add cursor pagination to /orders.', 'Cursor pagination is in, 50 per page by default.')),
    s(id(), 'Add request IDs to the logs', ago(2, 11), pair('Log the request id with every line.', 'Every log line carries `reqId` now.')),
    s(id(), 'Sketch the checkout flow', ago(12, 12), pair('Sketch the checkout flow.', 'Here is a first sketch.')),
  ];
  for (const x of list) fs.writeFileSync(path.join(dir, `${x.id}.json`), JSON.stringify(x));
  return ids;
}

// ---------- the scripted model ----------

const call = (name, args) => ({ id: `call_${crypto.randomBytes(4).toString('hex')}`, name, args });
const firstUser = (payload) => (payload.messages || []).find((m) => m.role === 'user')?.content || '';
const LOADTEST_BRIEF = 'Load-test the new rate limiter in src/middleware/rateLimit.js: start the server with `npm start`, send 300 requests a minute from one client for two minutes, and report how many were served and how many got 429, minute by minute.';
const isLoadTest = (p) => firstUser(p).includes('Load-test the new rate limiter');
const isMain = (p) => !isLoadTest(p);


function scriptHero(mock) {
  const main = (r) => mock.state.replies.push({ ...r, when: isMain });
  const tasks = (...status) =>
    call('update_tasks', {
      tasks: [
        { id: 't1', title: 'Add a rate-limit middleware', status: status[0] },
        { id: 't2', title: 'Apply it to the public routes', status: status[1] },
        { id: 't3', title: 'Run the test suite', status: status[2] },
        { id: 't4', title: 'Load-test the limiter', status: status[3] },
      ],
    });
  main({ promptTokens: 8240, toolCalls: [call('read_file', { path: 'src/server.js' })] });
  main({ promptTokens: 9310, toolCalls: [call('write_file', { path: 'src/middleware/rateLimit.js', content: RATE_LIMIT_JS })] });
  main({
    promptTokens: 9960,
    toolCalls: [
      call('edit_file', {
        path: 'src/server.js',
        old_string: "const routes = require('./routes');\n\nfunction createServer() {\n  const stack = [requestId];",
        new_string: "const { rateLimit } = require('./middleware/rateLimit');\nconst routes = require('./routes');\n\nfunction createServer() {\n  const limiter = rateLimit({ limit: 100, windowMs: 60_000, skip: (req) => req.url === '/health' });\n  const stack = [requestId, limiter];",
      }),
    ],
  });
  main({ promptTokens: 10720, toolCalls: [call('bash', { command: 'npm test' })] });
  // The load test goes to a sub-session, which runs beside this one
  main({ promptTokens: 11380, toolCalls: [call('session_spawn', { title: 'Load-test the limiter', prompt: LOADTEST_BRIEF }), tasks('completed', 'completed', 'completed', 'in_progress')] });
  main({
    promptTokens: 11820,
    content:
      'Public routes now allow **100 requests a minute per client IP**; the 101st gets `429` with `Retry-After`, and `/health` stays unlimited. All 5 tests pass. A sub-session is load-testing it and will report back here.',
  });
  // The sub-session's first answer is held back, so it is still running in every shot
  mock.state.replies.push({ when: isLoadTest, delayMs: 30 * 60_000, content: 'Starting the load test.' });
}

function scriptImages(mock) {
  const main = (r) => mock.state.replies.push({ ...r, when: isMain });
  main({ promptTokens: 12400, toolCalls: [call('mcp__grafana__render_panel', { dashboard: 'atlas-api', panel: 'Requests per minute', from: '2026-11-05T14:00Z', to: '2026-11-05T15:00Z' })] });
  main({ promptTokens: 13600, toolCalls: [call('bash', { command: 'node scripts/replay.js reports/traffic-2026-11-05.ndjson reports/rpm.svg' })] });
  main({ promptTokens: 14100, toolCalls: [call('show_image', { path: 'reports/rpm.svg', caption: 'Replay of Nov 5, 14:00–15:00 UTC' })] });
  main({
    promptTokens: 14480,
    content: 'Grafana shows the spike: one client, `203.0.113.42`, at over 600 requests a minute from 14:18 to 14:44. In the replay the limiter holds it to 100 and everyone else is served as before.',
  });
}

// ---------- a Grafana stand-in: an MCP server whose one tool renders a panel as a PNG ----------

/** Requests per minute in yesterday's traffic, drawn as a Grafana-style bar panel (2x pixels). */
function panelPng(trafficText) {
  const counts = new Array(60).fill(0);
  const lines = trafficText.trim().split('\n');
  const t0 = JSON.parse(lines[0]).t;
  for (const l of lines) counts[Math.min(59, Math.floor((JSON.parse(l).t - t0) / 60_000))]++;
  const w = 1200;
  const h = 440;
  const data = Buffer.alloc(w * h * 3);
  const fill = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) data.set([r, g, b], (y * w + x) * 3);
  };
  fill(0, 0, w, h, [255, 255, 255]);
  const top = 1000;
  const L = 40;
  const B = 400;
  for (let v = 0; v <= top; v += 250) fill(L, Math.round(B - (v / top) * 340), w - 24, Math.round(B - (v / top) * 340) + 2, [236, 236, 240]);
  const bw = (w - 24 - L) / 60;
  counts.forEach((c, i) => {
    const x = Math.round(L + i * bw + 2);
    const y = Math.round(B - (c / top) * 340);
    fill(x, y, Math.round(L + (i + 1) * bw - 2), B, c > 400 ? [242, 73, 92] : [115, 191, 105]);
  });
  return encodePng({ w, h, bpp: 3, data });
}

function writeGrafanaServer(dir, png) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'server.js');
  fs.writeFileSync(
    file,
    `// A minimal MCP server over stdio (newline-delimited JSON-RPC) with one tool.
const PNG = ${js(png.toString('base64'))};
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'grafana', version: '1.4.0' } } });
    else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'render_panel', description: 'Render a dashboard panel as a PNG for a time range', inputSchema: { type: 'object', properties: { dashboard: { type: 'string' }, panel: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['dashboard', 'panel'] }, annotations: { readOnlyHint: true } }] } });
    else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'text', text: 'Requests per minute, atlas-api, 2026-11-05 14:00–15:00 UTC' }] } });
    else if (m.method === 'ping') send({ id: m.id, result: {} });
    else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`,
  );
  return file;
}

/** The approval card, in Ask mode (Auto mode now lets a push to a feature branch through without a card). */
function scriptApproval(mock) {
  const main = (r) => mock.state.replies.push({ ...r, when: isMain });
  main({ promptTokens: 15400, toolCalls: [call('bash', { command: 'git push -u origin feat/rate-limit', description: 'Push the branch to GitHub' })] });
}

/** The mod from the README ("A mod in two files"), installed the way a user would: a folder in ~/.silo-harness/mods. */
function installWordCount(configDir) {
  const dir = path.join(configDir, 'mods', 'word-count');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mod.json'),
    JSON.stringify({ protocol: 1, id: 'word-count', name: 'Word count', version: '0.1.0', description: 'How many words the assistant has written in this session.', permissions: ['session:read'], contributes: { views: [{ id: 'main', title: 'Word count', entry: 'panel.html', seat: 'rail' }] } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'panel.html'),
    `<link rel="stylesheet" href="/@harness/harness.css">
<div class="h-row"><span class="h-label">Assistant words</span><span class="h-value" id="n">0</span></div>
<script src="/@harness/harness.js"></script>
<script>
  let words = 0;
  harness.on('message.assistant', (m) => {
    words += (m.text.match(/\\S+/g) || []).length;
    document.getElementById('n').textContent = words;
  });
</script>
`,
  );
}

// ---------- the run ----------

const LEAKS = /\bmock\b|oa-live|atlas-profile|atlas-home|\/var\/folders|\/private\/var|^Done\.$/m;

/** Runs an expression in the app's main process, through its inspector (as test/live/mods.js does). */
async function mainEval(port, expression) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const res = await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) resolve(m.result);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res?.result?.value;
}

function freePort(preferred) {
  const net = require('node:net');
  const tryPort = (p) =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(0));
      s.listen(p, '127.0.0.1', () => {
        const got = s.address().port;
        s.close(() => resolve(got));
      });
    });
  return tryPort(preferred).then((p) => p || tryPort(0));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  makeProject();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-profile-'));
  // The agent's shell is a login zsh; with HOME moved it would lose the PATH your own .zprofile sets up (Homebrew's
  // git and node), so the temp home's .zprofile puts this PATH back.
  fs.writeFileSync(path.join(HOME, '.zprofile'), `export PATH=${js(process.env.PATH)}\n`);
  const grafana = writeGrafanaServer(path.join(HOME, '.grafana-mcp'), panelPng(fs.readFileSync(path.join(PROJECT, 'reports', 'traffic-2026-11-05.ndjson'), 'utf8')));
  const ids = seedSessions(profile);
  const mock = await startMock();
  // Auto mode's safety check passes everything the scenes do
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.ollamaPromptTokens = 8000;
  mock.state.ollamaModels = ['qwen3:8b', 'qwen3:14b', 'gemma3:12b'];
  let app = null;
  let phone = null;
  const inspect = await freePort(0);
  try {
    app = await launch({
      args: [`--inspect=${inspect}`],
      profile,
      project: PROJECT,
      mock: true,
      mode: 'auto',
      size: { width: 1280, height: 800 },
      env: { HOME, SILO_HARNESS_CONFIG_DIR: CONFIG_DIR, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
      config: {
        provider: 'ollama',
        ollama: { baseURL: `http://127.0.0.1:${mock.port}`, model: 'qwen3:8b', numCtx: 32768, think: 'auto' },
        theme: DARK ? 'dark' : 'light',
        remote: { enabled: false, bind: 'localhost', port: 0 },
        recentDirs: [PROJECT],
        mcpServers: { grafana: { command: process.execPath, args: [grafana] } },
      },
    });
    const ev = app.evaluate;
    // A hidden window draws only when asked: without fresh frames a capture can come back stale or tiled, and the
    // built-in browser's own screenshot fails. Keep every page drawing while the script runs.
    const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
    await mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); globalThis.__readmePump = setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); return true; })()`);
    const paint = () => mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
    /** The window and the page take the same size, so what is drawn is what is captured. */
    const viewport = async (width, height) => {
      await mainEval(inspect, `(() => { ${WIN}.setContentSize(${width}, ${height}); return true; })()`);
      await app.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
      await sleep(700);
    };
    await viewport(1280, 800);
    const settle = async (ms = 600) => {
      await ev(`document.activeElement && document.activeElement.blur()`);
      await sleep(ms);
    };
    const railReady = () => app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.seat === 'rail' && !v.collapsed).every((v) => v.hello && v.height > 0)`, 45_000, 'the rail mods');
    const mainIdle = () => app.waitFor(`document.querySelector('#status-line').hidden && !document.querySelector('.session-item.active.running')`, 60_000, 'the run to end');
    const leakCheck = async (label) => {
      const text = await ev(`document.body.innerText`);
      const hit = LEAKS.exec(text);
      if (hit) console.log(`WARN ${label}: "${hit[0]}" on screen: …${text.slice(Math.max(0, hit.index - 60), hit.index + 60).replace(/\n/g, ' | ')}…`);
    };
    /** The whole page, cropped to `clip` (CSS pixels) when given. */
    const shot = async (name, clip) => {
      await leakCheck(name);
      await paint();
      await sleep(150);
      const r = await app.cdp('Page.captureScreenshot', { format: 'png' });
      let png = Buffer.from(r.data, 'base64');
      png = clip ? cropPng(png, clip.x * 2, clip.y * 2, clip.width * 2, clip.height * 2) : cropPng(png, 0, 0, Infinity, Infinity);
      const file = outFile(name);
      fs.writeFileSync(file, png);
      console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB)`);
    };
    const box = (sel) => ev(`(() => { const r = document.querySelector(${js(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const paneOpen = async (open) => {
      await ev(`(() => { const hidden = document.querySelector('.shell').classList.contains('pane-hidden'); if (${open} === hidden) document.querySelector('#pane-toggle').click(); })()`);
      await sleep(400);
    };
    // Scrolled to the end, the top edge of the transcript can cut through a line of text or a box. Scroll back just
    // enough that it falls between them, as long as the end of the transcript stays in view; otherwise stay put.
    const alignTop = async () => {
      const moved = await ev(`(() => {
        const m = document.querySelector('#messages');
        const box = m.getBoundingClientRect();
        const lastBottom = () => Math.max(...[...m.children].filter((e) => !e.hidden && e.id !== 'empty-state').map((e) => e.getBoundingClientRect().bottom));
        const start = m.scrollTop;
        for (let i = 0; i < 6; i++) {
          const top = box.top;
          const rects = [];
          const walker = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent.trim()) continue;
            const r = document.createRange();
            r.selectNodeContents(n);
            rects.push(...r.getClientRects());
          }
          for (const e of m.querySelectorAll('.msg.user .bubble, .msg.user, .tool, code, pre, .approval, figure, #task-list')) rects.push(e.getBoundingClientRect());
          const cut = rects.filter((r) => r.height && r.top < top - 0.5 && r.bottom > top + 0.5);
          if (!cut.length) break;
          const up = Math.ceil(Math.max(...cut.map((r) => top - r.top))) + 6;
          if (lastBottom() + up > box.bottom - 8) {
            m.scrollTop = start;
            return 'kept at the end: no room';
          }
          m.scrollTop -= up;
        }
        return start - m.scrollTop;
      })()`);
      console.log(`hero: top edge aligned (${moved})`);
      await sleep(1800);
    };
    const toBottom = async () => {
      await ev(`(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; })()`);
      // Overlay scrollbars fade out a moment after the last scroll
      await sleep(1800);
    };

    // Open the session the work happens in.
    await app.waitFor(`Boolean(document.querySelector('.session-item[data-id=${js(ids.main)}]'))`, 15_000, 'the seeded sessions');
    await app.click(`.session-item[data-id=${js(ids.main)}]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${js(ids.main)}`, 10_000, 'the main session');
    await paneOpen(false);
    await railReady();

    // ---------------- hero ----------------
    scriptHero(mock);
    await app.send('Add rate limiting to the public routes: 100 requests a minute per client, 429 with Retry-After when over. Keep /health unlimited.');
    // Starting a sub-session asks first, also in Auto mode: allow it, as the user would
    await app.approve('allow');
    await mainIdle();
    await app.waitFor(`Boolean(document.querySelector('.session-item[data-parent=${js(ids.main)}].running'))`, 15_000, 'the running sub-session');
    await sleep(1200);
    await railReady();
    await settle();
    await toBottom();
    await alignTop();
    await shot('hero');

    // ---------------- sidebar ----------------
    {
      const sb = await box('#sidebar');
      // Down to the collapsed Older group, the last row of the list
      const end = await ev(`(() => { const g = [...document.querySelectorAll('.session-group')].pop(); return g.getBoundingClientRect().bottom; })()`);
      // …and above the composer, whose top edge would otherwise show in the corner
      const composer = await box('#composer');
      await shot('sidebar', { x: 0, y: 0, width: Math.round(sb.width) + 340, height: Math.floor(Math.min(end + 18, composer.y - 4)) });
    }

    // ---------------- mods: the rail beside the Scheduled tab ----------------
    const schedules = [
      { name: 'Nightly dependency audit', prompt: 'Run npm audit and summarise anything high or critical.', when: { kind: 'cron', expr: '0 3 * * *' } },
      { name: 'Weekly changelog draft', prompt: 'Draft the changelog from the commits merged since last Monday.', when: { kind: 'cron', expr: '0 9 * * 1' } },
      { name: 'Watch the 429 rate', prompt: 'Check how many requests got 429 in the last hour and say if any client looks blocked by mistake.', when: { kind: 'every', minutes: 120 } },
    ];
    for (const sc of schedules) await ev(`window.oc.rpc('schedules.create', ${js({ ...sc, target: 'new', cwd: PROJECT })})`);
    // A taller window so the rail shows Outputs too; the empty Plan section folded; the pane dragged wider so its
    // tabs have their labels.
    // Rail and pane together under 800 px wide, so the shot stays legible at the README's 400 px (the mod tabs'
    // titles shorten at this width, as they do in the app)
    const RAIL_W = 300;
    const PANE_W = 480;
    await viewport(1600, 980);
    await ev(`document.querySelector('.rail-section[data-view="plan/main"] .rail-head-btn').click()`);
    await paneOpen(true);
    const dragPane = async (width) => {
      const rz = await box('#pane-resizer');
      const dx = width - (await box('#side-pane')).width;
      const x = rz.x + rz.width / 2;
      const y = rz.y + rz.height / 2;
      await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 10; i++) await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - (i * dx) / 10, y, button: 'left', buttons: 1 });
      await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - dx, y, button: 'left', clickCount: 1 });
      await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
      // The rail at its own width (the drag can take room from it)
      await ev(`window.__oc_debug.mods.setRailWidth(${RAIL_W})`);
      await sleep(300);
    };
    await app.waitFor(`Boolean(document.querySelector('.mod-pane-tab[data-view="scheduled/main"]'))`, 10_000, 'the Scheduled tab');
    await dragPane(PANE_W);
    await app.waitFor(`Boolean(document.querySelector('.mod-pane-tab[data-view="scheduled/main"]'))`, 10_000, 'the Scheduled tab');
    await app.click('.mod-pane-tab[data-view="scheduled/main"]');
    await app.waitFor(`window.__oc_debug.mods.views().find((v) => v.key === 'scheduled/main')?.hello`, 10_000, 'the Scheduled page');
    await sleep(1500);
    await railReady();
    // Outputs lists the two changed files (an empty Outputs page can report a near-zero height at start-up)
    await app.waitFor(`(window.__oc_debug.mods.views().find((v) => v.key === 'outputs/main')?.height || 0) > 40`, 20_000, 'the Outputs panel');
    await settle();
    {
      const rail = await box('#mod-rail');
      const pane = await box('#side-pane');
      const x = Math.floor(rail.x);
      const end = await ev(`document.querySelector('.rail-section[data-view="outputs/main"]').getBoundingClientRect().bottom`);
      await shot('mods', { x, y: 0, width: Math.ceil(pane.x + pane.width - x), height: Math.min(980, Math.ceil(end + 1)) });
    }
    await paneOpen(false);
    await ev(`document.querySelector('.rail-section[data-view="plan/main"] .rail-head-btn').click()`);

    // ---------------- images ----------------
    await viewport(1180, 1000);
    scriptImages(mock);
    await app.send("Pull yesterday's traffic panel from Grafana, then replay that hour through the limiter and chart requests per minute, before and after.");
    await mainIdle();
    await app.waitFor(`[...document.querySelectorAll('.reply-image img, .tool-thumb')].length >= 2 && [...document.querySelectorAll('.reply-image img, .tool-thumb')].every((i) => i.complete && i.naturalWidth > 0)`, 15_000, 'the images');
    // The screenshot's row opens to show it; fold it back to its summary line, where the thumbnail stays.
    await ev(`(() => { const row = [...document.querySelectorAll('.tool[data-tool="mcp__grafana__render_panel"]')].pop(); if (row && row.open) row.querySelector('summary').click(); })()`);
    await paneOpen(false);
    await sleep(800);
    await settle();
    await toBottom();
    const chatShot = async (name, bottomSel) => {
      const chat = await box('#messages');
      const r = await ev(`(() => { const users = [...document.querySelectorAll('.msg.user')]; const u = users[users.length - 1].getBoundingClientRect(); const end = [...document.querySelectorAll(${js(bottomSel)})].pop().getBoundingClientRect(); const card = document.querySelector('#messages > #task-list:not([hidden])'); return { top: u.top, bottom: end.bottom, card: card ? card.getBoundingClientRect().top : Infinity }; })()`);
      const y = Math.max(chat.y, Math.floor(r.top - 20));
      const bottom = Math.min(chat.y + chat.height, r.bottom + 20, r.card - 2);
      // Leave out the scrollbar's strip at the right edge
      await shot(name, { x: Math.floor(chat.x), y, width: Math.floor(chat.width - 10), height: Math.ceil(bottom - y) });
    };
    await chatShot('images', '#messages > *:not([hidden]):not(#task-list):not(#empty-state)');

    // ---------------- approval, and the same card on the phone ----------------
    const st = await ev(`window.oc.rpc('remote.start')`);
    const url = (st.urls || [])[0];
    if (!url) throw new Error(`remote control did not start: ${JSON.stringify(st)}`);
    const electron = require(path.join(ROOT, 'node_modules', 'electron'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // The phone follows the session before the turn starts, as it would in use.
    let phoneReady;
    const ready = new Promise((r) => (phoneReady = r));
    const phoneDone = new Promise((resolve, reject) => {
      phone = spawn(electron, [`--user-data-dir=${path.join(HOME, '.phone-window')}`, __filename, url, outFile('remote'), path.join(HOME, '.phone-window')], { env: { ...env, HOME, README_SHOTS_THEME: DARK ? 'dark' : 'light' }, stdio: ['ignore', 'pipe', 'inherit'] });
      phone.stdout.on('data', (d) => {
        if (String(d).includes('PHONE_READY')) phoneReady();
        process.stdout.write(String(d).replace(/PHONE_READY\n?/, ''));
      });
      phone.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`phone capture exited ${code}`))));
    });
    await Promise.race([ready, phoneDone]);
    scriptApproval(mock);
    await ev(`(async () => { const c = await window.oc.getConfig(); await window.oc.setConfig({ ...c, permissionMode: 'ask' }); return true; })()`);
    await app.send('Looks good. Push the branch.');
    await app.waitFor(`Boolean(document.querySelector('.approval:not(.decided) .btn'))`, 30_000, 'the approval card');
    await sleep(800);
    await settle();
    await toBottom();
    await chatShot('approval', '.approval:not(.decided)');
    await phoneDone;
    phone = null;
    await ev(`window.oc.rpc('remote.stop')`);

    // ---------------- settings: Mods, with a mod of yours expanded ----------------
    installWordCount(CONFIG_DIR);
    await app.waitFor(`window.oc.rpc('mods.list').then((l) => l.some((m) => m.key === 'word-count'))`, 10_000, 'the word-count mod');
    await ev(`window.oc.rpc('mods.setEnabled', 'word-count', true)`);
    await sleep(800);
    await viewport(720, 680);
    await sleep(300);
    await ev(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); })()`);
    await app.waitFor(`document.querySelector('#settings').open && Boolean(document.querySelector('#sp-nav-mods'))`, 10_000, 'Settings');
    await app.click('#sp-nav-mods');
    // The Mods tab (the general mods), where a rail panel of yours is listed
    await app.click('#sp-modtab-mods');
    await app.waitFor(`Boolean(document.querySelector('#sp-row-mod-word-count .sp-mod-expand'))`, 10_000, 'the Word count row');
    await app.click('#sp-row-mod-word-count .sp-mod-expand');
    await sleep(500);
    // From the "Yours" heading down, so no row is cut at the top
    // Scrolled to the end of the list; the window height is picked so the top edge of the list falls between rows
    for (const height of [680, 700, 660, 720, 690, 670, 710, 740, 650]) {
      await viewport(720, height);
      const cut = await ev(`(() => { const r = document.querySelector('#sp-row-mod-word-count'); let p = r.parentElement; while (p && p.scrollHeight <= p.clientHeight + 1) p = p.parentElement; p.scrollTop = p.scrollHeight; const top = p.getBoundingClientRect().top; return [...p.querySelectorAll('.sp-row, .sp-group-title, .sp-row-text > *')].some((e) => { const b = e.getBoundingClientRect(); return b.height && b.top < top - 1 && b.bottom > top + 1; }); })()`);
      if (!cut) break;
    }
    await sleep(1500);
    await settle(300);
    {
      const d = await box('#settings');
      await shot('settings', { x: Math.floor(d.x), y: Math.floor(d.y), width: Math.ceil(d.width), height: Math.ceil(d.height) });
    }

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    if (errors.length) console.log('console errors:\n' + errors.slice(-10).join('\n'));
  } catch (err) {
    // Leave a picture of where it stopped, then fail
    if (app && process.env.SHOTS_DEBUG) {
      await app.screenshot(path.join(process.env.SHOTS_DEBUG, 'failed.png')).catch(() => {});
      console.log('model requests:\n' + mock.state.requests.map((r) => `${r.url} ${firstUser(r.payload).slice(0, 40)}`).join('\n'));
      console.log('replies left:', mock.state.replies.length);
      console.log('views:', JSON.stringify(await app.evaluate(`window.__oc_debug.mods.views().map((v) => [v.key, v.seat, v.hello, v.height, v.collapsed, v.failed])`).catch((e) => String(e))));
      console.log(app.console.slice(-15).join('\n'));
      console.log(app.logs.slice(-15).join('\n'));
    }
    throw err;
  } finally {
    phone?.kill();
    if (app) await app.close();
    mock.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

module.exports = { HOME, PROJECT, CONFIG_DIR, FILES, RATE_LIMIT_JS, makeProject, seedSessions, scriptHero, scriptImages, scriptApproval, panelPng, writeGrafanaServer, installWordCount, cropPng, encodePng, decodePng, mainEval, freePort, isMain, call };
if (require.main !== module) return;

const started = Date.now();
main().then(
  () => {
    console.log(`done in ${Math.round((Date.now() - started) / 1000)} s`);
    process.exit(0);
  },
  (err) => {
    console.error(err && err.stack);
    fs.rmSync(HOME, { recursive: true, force: true });
    // A start-up hiccup of the hidden app (a mod page slow to load, say) should not need a second command: try once more
    if (!process.env.README_SHOTS_RETRY) {
      console.error('trying once more from the start…');
      const again = require('node:child_process').spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, README_SHOTS_RETRY: '1' } });
      process.exit(again.status ?? 1);
    }
    process.exit(1);
  },
);
