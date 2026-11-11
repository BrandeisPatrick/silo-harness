// Makes the screenshots for the 0.13.0 release notes, 1600 px wide, in the light theme:
//   web-tools.png       a turn that searches the web (web_search) and reads a page (web_fetch), then answers
//   browser-safety.png  the Browser pane asking about a download the agent started
//   mcp-sign-in.png     Settings → MCP servers: one remote server connected, one waiting to be signed in to
//
// Like scripts/tool-activity-shot.js, whose project, sessions and PNG helpers it uses (scripts/readme-shots.js): the
// built app runs hidden on a throwaway profile against the scripted model, and nothing leaves the machine.
//   - Web: the search goes to a fake SearXNG on 127.0.0.1 (the webSearch setting, as a user with their own instance
//     would have it). web_fetch only reaches public addresses and has no switch for a local one, so the fetcher's own
//     test seam (NetHooks in src/main/web/fetch.ts: a stand-in for DNS and a loopback address let through) is handed
//     to it from outside, through the main process's inspector, for the few made-up public names below; every other
//     name is refused. The page itself comes from the same local server.
//   - Browser: Chromium's --host-resolver-rules sends the made-up site name to a local server, as the live tests do.
//   - MCP: two local MCP servers over streamable HTTP, added in Settings by URL; the one that wants a sign-in answers
//     401. The main process's fetch (which remote MCP servers are reached with) is wrapped, through the inspector, to
//     send the two made-up https origins to them; loopback goes through and every other host is refused.
//   - The Browser pane's page is a native view that the window's own capture leaves out: it is captured on its own
//     (over the remote-debugging port) and laid into its slot in the window's capture.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/release-shots-0.13.0.js [out-dir] [--only=web,browser,mcp]     default: docs/releases/0.13.0
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep, cdpAt, evalAt } = require('../test/live/rig.js');
const { startMock } = require('../test/support/mock-model.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs', 'releases', '0.13.0'));
const ONLY = (args.find((a) => a.startsWith('--only=')) || '--only=web,browser,mcp').slice(7).split(',');
const WIDTH = 1600;
const js = JSON.stringify;
const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;

// ---------- shared ----------

/** A plain HTTP server on 127.0.0.1 that answers by path. */
async function localServer(routes) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const route = routes[p];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    route(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => { server.closeAllConnections?.(); server.close(); } };
}

/** The app on a throwaway profile, hidden, against the scripted model; `inspect` is its main process's inspector. */
async function start({ mock, config = {}, mode = 'auto', size, args: extra = [], scale = 2 }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-release-shot-'));
  const ids = F.seedSessions(profile);
  const inspect = await F.freePort(0);
  const app = await launch({
    args: [`--inspect=${inspect}`, ...extra],
    profile,
    project: F.PROJECT,
    mock: true,
    mode,
    size,
    scale,
    env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
    config: {
      provider: 'ollama',
      ollama: { baseURL: `http://127.0.0.1:${mock.port}`, model: 'qwen3:8b', numCtx: 32768, think: 'auto' },
      theme: 'light',
      remote: { enabled: false, bind: 'localhost', port: 0 },
      recentDirs: [F.PROJECT],
      ...config,
    },
  });
  // A hidden window only draws while asked to: keep every view drawing, and give the window the page's size
  await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); ${WIN}.setContentSize(${size.width}, ${size.height}); return true; })()`);
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: scale, mobile: false });
  await app.waitFor(`Boolean(document.querySelector('.session-item[data-id=${js(ids.main)}]'))`, 15_000, 'the seeded sessions');
  return { app, inspect, profile, ids };
}

/** Takes the whole page and crops it to `r` (CSS pixels); the page's scale must make r.width come out 1600 px. */
async function capture(app, inspect, r, scale, file) {
  await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
  await sleep(150);
  const cap = await app.cdp('Page.captureScreenshot', { format: 'png' });
  const png = F.cropPng(Buffer.from(cap.data, 'base64'), Math.round(r.x * scale), Math.round(r.y * scale), WIDTH, Math.round(r.height * scale));
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB)`);
}

async function openSession(app, id) {
  await app.click(`.session-item[data-id=${js(id)}]`);
  await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${js(id)}`, 10_000, 'the session');
}

// ---------- web-tools.png ----------

const RFC9110 = 'https://www.rfc-editor.org/rfc/rfc9110.html';
const SEARCH_RESULTS = [
  {
    title: 'RFC 9110: HTTP Semantics, 10.2.3. Retry-After',
    url: `${RFC9110}#name-retry-after`,
    content: 'Servers send the "Retry-After" header field to indicate how long the user agent ought to wait before making a follow-up request. Its value is either an HTTP-date or a number of seconds.',
  },
  {
    title: 'Retry-After header - HTTP | MDN',
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After',
    content: 'The HTTP Retry-After response header tells the client how long to wait before making a follow-up request, as a date or as a delay in seconds. Common with 429 and 503 responses.',
  },
  {
    title: 'RFC 6585: Additional HTTP Status Codes, 4. 429 Too Many Requests',
    url: 'https://www.rfc-editor.org/rfc/rfc6585.html#section-4',
    content: 'The 429 status code indicates that the user has sent too many requests in a given amount of time. The response MAY include a Retry-After header indicating how long to wait.',
  },
];
// The part of the page the fetch reads: a short stand-in for the section, in the RFC's own structure
const RFC_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RFC 9110: HTTP Semantics</title></head><body><main>
<h1>HTTP Semantics</h1>
<h4 id="name-retry-after">10.2.3. Retry-After</h4>
<p>Servers send the "Retry-After" header field to indicate how long the user agent ought to wait before making a follow-up request.</p>
<p>The value of this field can be either an HTTP-date or a number of seconds to delay after receiving the response.</p>
<pre>Retry-After = HTTP-date / delay-seconds</pre>
<p>A delay-seconds value is a non-negative decimal integer, representing time in seconds.</p>
<pre>delay-seconds  = 1*DIGIT</pre>
<p>Two examples of its use are</p>
<pre>Retry-After: Fri, 31 Dec 1999 23:59:59 GMT
Retry-After: 120</pre>
<p>In the latter example, the delay is 2 minutes.</p>
</main></body></html>`;

function scriptWeb(mock) {
  const main = (r) => mock.state.replies.push({ ...r, when: F.isMain });
  main({ promptTokens: 8200, toolCalls: [F.call('web_search', { query: 'Retry-After header 429 seconds or HTTP-date', count: 5 })] });
  main({ promptTokens: 9000, toolCalls: [F.call('web_fetch', { url: `${RFC9110}#name-retry-after` })] });
  main({
    promptTokens: 9800,
    content:
      'Both are allowed. [RFC 9110, §10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) defines the field as `HTTP-date / delay-seconds`, so a number of seconds such as `120` is as valid as a date, and [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html#section-4) lets a `429` carry it.\n\nOur limiter already sends seconds (`Math.ceil((entry.reset - t) / 1000)`), which is the better choice here: clients do not have to parse a date or trust our clock.',
  });
}

/**
 * Hands web_fetch the fetcher's test seam (src/main/web/fetch.ts, NetHooks) for the made-up public names in `names`:
 * they "resolve" to the local server, whose port is added to the URL, and the result names the page as asked. Any
 * other name is refused, so nothing is fetched from the internet.
 */
function fakeWebFetch(port, names) {
  const mod = path.join(ROOT, 'dist', 'main', 'web', 'fetch.js');
  return `(() => {
    const f = process.mainModule.require(${js(mod)});
    const orig = f.fetchUrl;
    const names = new Set(${js(names)});
    const hooks = { resolve: async () => ['127.0.0.1'], allowAddress: (a) => a === '127.0.0.1' };
    f.fetchUrl = async (raw, opts = {}) => {
      const u = new URL(raw);
      if (!names.has(u.hostname)) throw new Error(u.hostname + ' was not found (DNS).');
      const asked = u.protocol + '//' + u.host;
      const local = 'http://' + u.hostname + ':${port}';
      const out = await orig(local + u.pathname + u.search, { ...opts, hooks });
      for (const k of ['url', 'to']) if (typeof out[k] === 'string') out[k] = out[k].split(local).join(asked);
      return out;
    };
    return true;
  })()`;
}

async function sceneWeb() {
  const web = await localServer({
    // SearXNG's JSON API, as webSearch.provider "searxng" calls it
    '/search': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ query: new URL(req.url, 'http://x').searchParams.get('q'), results: SEARCH_RESULTS }));
    },
    '/rfc/rfc9110.html': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(RFC_PAGE);
    },
  });
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.ollamaPromptTokens = 8000;
  mock.state.ollamaModels = ['qwen3:8b', 'qwen3:14b'];
  const size = { width: 1180, height: 1000 };
  let s;
  try {
    s = await start({
      mock,
      size,
      config: {
        webSearch: { provider: 'searxng', baseUrl: `http://127.0.0.1:${web.port}` },
      },
    });
    const { app, inspect, ids } = s;
    const ev = app.evaluate;
    await F.mainEval(inspect, fakeWebFetch(web.port, ['www.rfc-editor.org']));
    await openSession(app, ids.main);
    await ev(`(() => { if (!document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-toggle').click(); const r = document.querySelector('#rail-toggle'); if (r && !r.hidden && r.getAttribute('aria-pressed') === 'true') r.click(); })()`);

    scriptWeb(mock);
    await app.send('Should the Retry-After on our 429s be a number of seconds or a date? Check what the spec allows.');
    // The first search asks, and so does the first fetch from the site: answered Allow, as the user would
    const until = Date.now() + 90_000;
    for (;;) {
      const st = await ev(`(() => {
        const card = [...document.querySelectorAll('.approval:not(.decided)')].pop();
        if (card) { const b = [...card.querySelectorAll('button')].find((x) => /session/i.test(x.innerText)) || card.querySelector('.btn.primary'); b.click(); return 'answered: ' + card.innerText.replace(/\\s+/g, ' ').slice(0, 160); }
        return document.querySelector('#status-line').hidden && !document.querySelector('.session-item.active.running') && document.querySelectorAll('#messages > .msg.assistant').length > 1 ? 'done' : '';
      })()`);
      if (st === 'done') break;
      if (st) console.log(st);
      if (Date.now() > until) throw new Error('the web turn did not end');
      await sleep(200);
    }
    await sleep(800);
    // The tool line opened to its two rows
    await ev(`(() => {
      const g = [...document.querySelectorAll('#messages > .tool-group')].pop();
      if (g && !g.open) g.querySelector(':scope > summary').click();
      document.activeElement && document.activeElement.blur();
    })()`);
    await sleep(600);
    await ev(`(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; })()`);
    await sleep(1500);
    const r = await ev(`(() => {
      const chat = document.querySelector('#messages').getBoundingClientRect();
      const users = [...document.querySelectorAll('.msg.user')]; const u = users[users.length - 1];
      const ub = u.querySelector('.bubble').getBoundingClientRect();
      const end = [...document.querySelectorAll('#messages > .msg.assistant')].pop().getBoundingClientRect();
      const col = [...document.querySelectorAll('#messages > .msg.assistant')].pop();
      const prev = u.previousElementSibling;
      return { chat: { x: chat.x, y: chat.y, width: chat.width, height: chat.height }, above: prev && !prev.hidden ? prev.getBoundingClientRect().bottom : -1e9, top: ub.top, bottom: end.bottom, left: end.left, right: ub.right };
    })()`);
    console.log('rect', JSON.stringify(r));
    const left = r.left - 40;
    const width = r.right + 40 - left;
    const scale = WIDTH / width;
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: scale, mobile: false });
    await sleep(800);
    const y = Math.max(r.chat.y, r.top - 28, r.above + 2);
    const bottom = Math.min(r.chat.y + r.chat.height, r.bottom + 28);
    await capture(app, inspect, { x: left, y, height: bottom - y }, scale, path.join(OUT, 'web-tools.png'));
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    if (errors.length) console.log('console errors:\n' + errors.slice(-10).join('\n'));
  } finally {
    if (s) {
      await s.app.close();
      fs.rmSync(s.profile, { recursive: true, force: true });
    }
    mock.close();
    web.close();
  }
}

// ---------- browser-safety.png ----------

const DATA_HOST = 'data.example.org';
const EXPORTS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Exports · Atlas data</title>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; color: #1f2328; background: #fff; margin: 0; }
  header { padding: 18px 32px; border-bottom: 1px solid #e6e3dc; display: flex; align-items: center; gap: 10px; font-weight: 600; }
  header i { width: 22px; height: 22px; border-radius: 6px; background: #2f6f5e; display: inline-block; }
  main { padding: 28px 32px; max-width: 760px; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  p { color: #59636e; margin: 0 0 22px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 11px 8px; border-bottom: 1px solid #eeebe5; }
  th { font-size: 13px; color: #59636e; font-weight: 500; }
  td.n { color: #59636e; font-variant-numeric: tabular-nums; }
  a { color: #2f6f5e; }
</style></head><body>
<header><i></i>Atlas data</header>
<main>
<h1>Monthly exports</h1>
<p>Orders by day and product, as CSV. Each export is made on the first of the month.</p>
<table>
<tr><th>Export</th><th>Rows</th><th>Size</th></tr>
<tr><td><a href="/exports/orders-2026-10.csv">orders-2026-10.csv</a></td><td class="n">48,210</td><td class="n">2.4 MB</td></tr>
<tr><td><a href="/exports/orders-2026-09.csv">orders-2026-09.csv</a></td><td class="n">69,418</td><td class="n">2.3 MB</td></tr>
<tr><td><a href="/exports/orders-2026-08.csv">orders-2026-08.csv</a></td><td class="n">66,385</td><td class="n">2.2 MB</td></tr>
<tr><td><a href="/exports/orders-2026-07.csv">orders-2026-07.csv</a></td><td class="n">63,107</td><td class="n">2.1 MB</td></tr>
</table>
</main></body></html>`;

/** About 2.4 MB of plausible CSV, so the bar names a real size. */
function ordersCsv() {
  const rows = ['date,order_id,product_id,quantity,unit_price'];
  let i = 0;
  for (let len = 0; len < 2.4 * 1024 * 1024; i++) {
    rows.push(`2026-10-${String(1 + (i % 31)).padStart(2, '0')},o_${700000 + i},p_${1001 + (i % 40)},${1 + (i % 4)},${(9.5 + (i % 17) * 1.25).toFixed(2)}`);
    len += rows[rows.length - 1].length + 1;
  }
  return rows.join('\n') + '\n';
}

async function sceneBrowser() {
  const csv = ordersCsv();
  // The listing gives the export's real row count
  const listing = EXPORTS_PAGE.replace('48,210', (csv.split('\n').length - 2).toLocaleString('en-US'));
  const site = await localServer({
    '/exports': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(listing);
    },
    '/exports/orders-2026-10.csv': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-length': Buffer.byteLength(csv), 'content-disposition': 'attachment; filename="orders-2026-10.csv"' });
      res.end(csv);
    },
  });
  const mock = await startMock();
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.ollamaPromptTokens = 8000;
  mock.state.ollamaModels = ['qwen3:8b', 'qwen3:14b'];
  const size = { width: 1800, height: 820 };
  const downloads = path.join(F.HOME, 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const BASE = `http://${DATA_HOST}`;
  let s;
  try {
    s = await start({
      mock,
      size,
      args: [`--host-resolver-rules=MAP ${DATA_HOST} 127.0.0.1:${site.port}`],
      config: { browser: { downloadsDir: downloads, alwaysAllowed: [`http://${DATA_HOST}`] } },
    });
    const { app, inspect, ids } = s;
    const ev = app.evaluate;
    await openSession(app, ids.main);
    const main = (r) => mock.state.replies.push({ ...r, when: F.isMain });
    main({ promptTokens: 8300, toolCalls: [F.call('browser_navigate', { url: `${BASE}/exports` })] });
    main({ promptTokens: 9100, toolCalls: [F.call('browser_navigate', { url: `${BASE}/exports/orders-2026-10.csv` })] });
    main({ promptTokens: 9600, content: 'The October export started downloading, and the browser is holding it until you answer the bar above the page. Once you allow it, I will read it and count the orders by product.' });
    await app.send('Get the October orders export from data.example.org and tell me which product sold best.');
    const until = Date.now() + 90_000;
    for (;;) {
      const st = await ev(`(() => {
        const card = [...document.querySelectorAll('.approval:not(.decided)')].pop();
        if (card) { (card.querySelector('.btn.primary') || card.querySelector('button')).click(); return 'answered: ' + card.innerText.replace(/\\s+/g, ' ').slice(0, 160); }
        return window.__oc_debug.mods.browser().safety.bars.some((b) => b.kind === 'download') ? 'bar' : '';
      })()`);
      if (st === 'bar') break;
      if (st) console.log(st);
      if (Date.now() > until) throw new Error('no download bar');
      await sleep(200);
    }
    await sleep(3000);
    const dbg = await ev('window.__oc_debug.mods.browser()');
    console.log('bars', JSON.stringify(dbg.safety.bars), 'bounds', JSON.stringify(dbg.bounds));
    console.log('staged downloads folder:', fs.readdirSync(downloads));
    // The pane 800 px wide, so at 2x it is the image's 1600
    await ev(`document.getElementById('side-pane').style.setProperty('--browser-w', '800px')`);
    await sleep(1500);
    await ev(`document.activeElement && document.activeElement.blur()`);
    const pane = await ev(`(() => { const r = document.getElementById('side-pane').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const b = (await ev('window.__oc_debug.mods.browser()')).bounds;
    console.log('pane', JSON.stringify(pane), 'view', JSON.stringify(b));
    // The page is a native view over the window, which the window's own capture leaves out: capture it on its own
    // (main process) and lay it into its slot.
    // Over the remote-debugging port, at the slot's size and the window's 2x
    const target = await app.pageTarget(`${BASE}/exports`);
    const view = (await cdpAt(target, 'Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: b.width, height: b.height, scale: 2 } })).data;
    const tableEnd = await evalAt(target, `document.querySelector('table').getBoundingClientRect().bottom`);
    await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
    await sleep(150);
    const cap = await app.cdp('Page.captureScreenshot', { format: 'png' });
    const whole = F.decodePng(Buffer.from(cap.data, 'base64'));
    const page = F.decodePng(Buffer.from(view, 'base64'));
    console.log('view capture', page.w, 'x', page.h, 'table ends at', tableEnd);
    paste(whole, page, Math.round(b.x * 2), Math.round(b.y * 2));
    const png = F.cropPng(F.encodePng(whole), Math.round(pane.x * 2), Math.round(pane.y * 2), WIDTH, Math.round((b.y - pane.y + tableEnd + 40) * 2));
    const file = path.join(OUT, 'browser-safety.png');
    fs.writeFileSync(file, png);
    console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB)`);
  } finally {
    if (s) {
      await s.app.close();
      fs.rmSync(s.profile, { recursive: true, force: true });
    }
    mock.close();
    site.close();
  }
}

/** Copies decoded image `src` into decoded image `dst` at (x, y), as opaque pixels. */
function paste(dst, src, x, y) {
  for (let r = 0; r < src.h && y + r < dst.h; r++) {
    for (let c = 0; c < src.w && x + c < dst.w; c++) {
      const s = (r * src.w + c) * src.bpp;
      const d = ((y + r) * dst.w + x + c) * dst.bpp;
      for (let k = 0; k < 3; k++) dst.data[d + k] = src.data[s + k];
      if (dst.bpp === 4) dst.data[d + 3] = 255;
    }
  }
}

// ---------- mcp-sign-in.png ----------

const MCP_SITES = { tracker: 'https://mcp.tracker.example.com', docs: 'https://mcp.docs.example.com' };

/** A remote MCP server on 127.0.0.1 over streamable HTTP (stateless), with the tools an issue tracker would have. */
async function trackerServer() {
  const sdk = (p) => require(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/cjs', p));
  const { McpServer } = sdk('server/mcp.js');
  const { StreamableHTTPServerTransport } = sdk('server/streamableHttp.js');
  const { z } = require(path.join(ROOT, 'node_modules/zod'));
  const make = () => {
    const server = new McpServer({ name: 'tracker', version: '2.3.0' });
    const text = (t) => async () => ({ content: [{ type: 'text', text: t }] });
    const ro = { readOnlyHint: true };
    server.registerTool('list_projects', { description: 'Lists the projects you can see', inputSchema: {}, annotations: ro }, text('[]'));
    server.registerTool('list_issues', { description: 'Lists the open issues of a project', inputSchema: { project: z.string() }, annotations: ro }, text('[]'));
    server.registerTool('search_issues', { description: 'Searches issues by text', inputSchema: { query: z.string() }, annotations: ro }, text('[]'));
    server.registerTool('get_issue', { description: 'Reads one issue with its comments', inputSchema: { id: z.string() }, annotations: ro }, text('{}'));
    server.registerTool('create_issue', { description: 'Opens an issue', inputSchema: { project: z.string(), title: z.string(), body: z.string().optional() } }, text('{}'));
    server.registerTool('update_issue', { description: 'Changes the title, state or assignee of an issue', inputSchema: { id: z.string(), state: z.string().optional() } }, text('{}'));
    server.registerTool('add_comment', { description: 'Comments on an issue', inputSchema: { id: z.string(), body: z.string() } }, text('{}'));
    return server;
  };
  return localServer({
    '/mcp': async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await make().connect(t);
      await t.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    },
  });
}

/** A remote MCP server that wants a sign-in: every request is answered 401, as before an OAuth sign-in. */
function docsServer() {
  const unauthorized = (req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_token' }));
  };
  return localServer({ '/mcp': unauthorized });
}

/**
 * The main process's fetch, which remote MCP servers are reached with, sends the two made-up https origins to the
 * local servers. Loopback requests (the scripted model) go through; anything else is refused.
 */
function fakeMcpFetch(map) {
  return `(() => {
    const orig = globalThis.fetch;
    const map = ${js(map)};
    globalThis.__shotLog = [];
    globalThis.fetch = (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(raw);
      globalThis.__shotLog.push(u.href);
      if (map[u.origin]) {
        const to = map[u.origin] + u.pathname + u.search;
        return orig(typeof input === 'string' || input instanceof URL ? to : new Request(to, input), init);
      }
      if (['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return orig(input, init);
      return Promise.reject(new Error(u.hostname + ' was not found (DNS).'));
    };
    return true;
  })()`;
}

async function sceneMcp() {
  const tracker = await trackerServer();
  const docs = await docsServer();
  const mock = await startMock();
  mock.state.ollamaModels = ['qwen3:8b', 'qwen3:14b'];
  const size = { width: 1180, height: 820 };
  let s;
  try {
    s = await start({ mock, size });
    const { app, inspect } = s;
    const ev = app.evaluate;
    await F.mainEval(inspect, fakeMcpFetch({ [MCP_SITES.tracker]: `http://127.0.0.1:${tracker.port}`, [MCP_SITES.docs]: `http://127.0.0.1:${docs.port}` }));
    await ev(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-mcp')?.click(); })()`);
    await sleep(500);
    // Added the way a user adds them: a name and the server's URL
    for (const name of ['tracker', 'docs']) {
      await app.fill('#mcp-name', name);
      await app.fill('#mcp-spec', `${MCP_SITES[name]}/mcp`);
      await app.click('#mcp-add-btn');
      await app.waitFor(`Boolean(document.querySelector('#mcp-list .mcp-row[data-name=${js(name)}]'))`, 15_000, `the ${name} row`).catch(async (e) => {
        console.log('add error:', await ev(`document.querySelector('#mcp-add-error').innerText + ' | status: ' + document.querySelector('#mcp-status').innerText + ' | rows: ' + [...document.querySelectorAll('#mcp-list .mcp-row')].map((r) => r.dataset.name + ' ' + r.dataset.status).join(', ') + ' | spec: ' + document.querySelector('#mcp-spec').value + ' | btn disabled: ' + document.querySelector('#mcp-add-btn').disabled`));
        console.log('requests:', JSON.stringify(await F.mainEval(inspect, 'globalThis.__shotLog')));
        throw e;
      });
      await app.waitFor(`!document.querySelector('#mcp-add-btn').disabled && !document.querySelector('#mcp-spec').value`, 15_000, 'the add form to be free');
    }
    await app.waitFor(`document.querySelector('#mcp-list .mcp-row[data-name="tracker"]')?.dataset.status === 'connected' && document.querySelector('#mcp-list .mcp-row[data-name="docs"]')?.dataset.status === 'needs-auth'`, 20_000, 'tracker connected and docs waiting for a sign-in').catch(async (e) => {
      console.log(await ev(`[...document.querySelectorAll('#mcp-list .mcp-row')].map((r) => r.dataset.name + ': ' + r.dataset.status + ' ' + r.innerText.replace(/\\s+/g, ' ')).join(' | ')`));
      throw e;
    });
    console.log('requests:', JSON.stringify(await F.mainEval(inspect, 'globalThis.__shotLog')));
    console.log(await ev(`[...document.querySelectorAll('#mcp-list .mcp-row')].map((r) => r.dataset.name + ': ' + r.innerText.replace(/\\s+/g, ' ')).join(' | ')`));
    await ev(`document.activeElement && document.activeElement.blur()`);
    // The highlight a new row gets fades first
    await app.waitFor(`!document.querySelector('#mcp-list .mcp-row.flash')`, 15_000, 'the new-row highlight to fade');
    await sleep(800);
    const r = await ev(`(() => {
      const sec = document.querySelector('#mcp-section').getBoundingClientRect();
      const title = document.querySelector('#mcp-section').parentElement.querySelector('h2, h3, .sp-title, .section-title');
      const list = document.querySelector('#mcp-list').getBoundingClientRect();
      return { x: sec.x, width: sec.width, top: title ? title.getBoundingClientRect().top : sec.top - 60, bottom: list.bottom };
    })()`);
    console.log('rect', JSON.stringify(r));
    const pad = (800 - r.width) / 2;
    // Below the dialog's header rule, which sits about 6 px above the title
    await capture(app, inspect, { x: r.x - pad, y: r.top - 4, height: r.bottom + 14 - (r.top - 4) }, 2, path.join(OUT, 'mcp-sign-in.png'));
  } finally {
    if (s) {
      await s.app.close();
      fs.rmSync(s.profile, { recursive: true, force: true });
    }
    mock.close();
    tracker.close();
    docs.close();
  }
}

// ---------- main ----------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  fs.writeFileSync(path.join(F.HOME, '.zprofile'), `export PATH=${js(process.env.PATH)}\n`);
  try {
    if (ONLY.includes('web')) await sceneWeb();
    if (ONLY.includes('browser')) await sceneBrowser();
    if (ONLY.includes('mcp')) await sceneMcp();
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
