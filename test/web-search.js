// web_search's backends, headless (src/main/web/search.ts): each parser against a fixture (DuckDuckGo's page is a
// trimmed recording, an ad added by hand; the JSON ones follow each API's documented shape), each backend's request
// against a mock server (method, headers, the key where the provider wants it, site filters), rate limits and blocks
// as one line naming the setting, SearXNG's private address allowed for its own host only, and the key kept out of
// every message, the window's copy of the config and a project's settings file.
// Run: npm run build && node test/web-search.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const S = dist('web/search.js');
const { windowConfig, acceptFromWindow, KEY_MASK } = dist('providers.js');
const { defaultConfig } = dist('config.js');
const { SettingsLayer, contentHash, trustKey, checkSetting, SECRET_FIELDS, settingsSchema } = dist('settings.js');
const { startWebServer, hooksFor } = require('./support/web-server.js');
const { check, done } = require('./support/check.js');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'support/web', f), 'utf8');
const KEY = 'sk-test-0123456789abcdef';
const rejects = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};

(async () => {
  // ---------- Parsers ----------
  const ddg = S.parseDuckDuckGo(fixture('duckduckgo.html'));
  check('DuckDuckGo: results from the recorded page, links unwrapped, ad dropped', ddg.length === 3 && ddg[0].url === 'https://www.electronjs.org/docs/latest/api/browser-window' && ddg[0].title === 'BrowserWindow - Electron' && ddg[2].url === 'http://electronproject.org/browser-window.html' && !ddg.some((r) => /Buy Electron|y\.js/.test(r.title + r.url)), ddg.map((r) => r.url));
  check('DuckDuckGo: snippets are text, entities decoded, at most 300 characters', ddg[1].snippet.includes("your app's windows") && ddg.every((r) => r.snippet.length <= 300 && !/<b>/.test(r.snippet)) && ddg[0].snippet.endsWith('…'), ddg.map((r) => r.snippet.length));
  check('DuckDuckGo: its redirect link is unwrapped, its own pages and ads are not results', S.unwrapDuckDuckGo('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx&rut=1') === 'https://a.example/x' && S.unwrapDuckDuckGo('https://duckduckgo.com/y.js?ad=1') === null && S.unwrapDuckDuckGo('https://b.example/') === 'https://b.example/');
  let blockedMsg = '';
  try {
    S.parseDuckDuckGo('<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form"></form></body></html>');
  } catch (e) {
    blockedMsg = e instanceof S.SearchError ? e.message : `wrong error: ${e}`;
  }
  check('DuckDuckGo: its bot check is a one-line error naming the setting', /DuckDuckGo blocked the request/.test(blockedMsg) && /webSearch\.provider/.test(blockedMsg), blockedMsg);
  check('DuckDuckGo: a page that changed shape gives no results rather than an error', S.parseDuckDuckGo('<html><body><p>new layout</p></body></html>').length === 0);
  const brave = S.parseBrave(JSON.parse(fixture('brave.json')));
  check('Brave: title, URL, description without tags (extra_snippets when empty); non-web URLs dropped', brave.length === 2 && brave[0].snippet === "Create and control browser windows. Process: Main. This module cannot be used until the 'ready' event of the app module is emitted." && /exposes various ways/.test(brave[1].snippet), brave);
  const tav = S.parseTavily(JSON.parse(fixture('tavily.json')));
  check('Tavily: results with content', tav.length === 2 && tav[1].title === 'Window Customization | Electron' && /foundation/.test(tav[1].snippet), tav);
  const exa = S.parseExa(JSON.parse(fixture('exa.json')));
  check('Exa: text collapsed, a highlight preferred', exa.length === 2 && exa[0].snippet.startsWith('BrowserWindow Create and control') && exa[1].snippet === 'Build cross-platform desktop apps with JavaScript, HTML, and CSS', exa);
  const sx = S.parseSearxng(JSON.parse(fixture('searxng.json')));
  check('SearXNG: results with content, entities decoded', sx.length === 2 && sx[1].title === 'Electron BrowserWindow & frames' && sx[1].snippet === 'A question about BrowserWindow frames.', sx);
  check('every parser takes junk without throwing', [S.parseBrave, S.parseTavily, S.parseExa, S.parseSearxng].every((p) => p(null).length === 0 && p({ results: 'x', web: 1 }).length === 0 && p([1, 2]).length === 0));

  // ---------- Requests against a mock ----------
  const seen = {};
  const body = (req) => new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(b));
  });
  const json = (res, obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  let ddgMode = 'ok';
  const srv = await startWebServer({
    '/html/': (req, res) => {
      seen.ddg = { url: req.url, method: req.method, ua: req.headers['user-agent'], cookie: req.headers.cookie };
      if (ddgMode === 'blocked') {
        res.writeHead(202, { 'content-type': 'text/html' });
        res.end('<html>challenge</html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fixture('duckduckgo.html'));
    },
    '/brave': (req, res) => {
      seen.brave = { url: req.url, token: req.headers['x-subscription-token'] };
      if (req.headers['x-subscription-token'] !== KEY) return json(res, { error: `bad key ${req.headers['x-subscription-token']}` }, 401);
      json(res, fixture('brave.json'));
    },
    '/tavily': async (req, res) => {
      seen.tavily = { auth: req.headers.authorization, body: JSON.parse(await body(req)), method: req.method };
      json(res, fixture('tavily.json'));
    },
    '/exa': async (req, res) => {
      seen.exa = { key: req.headers['x-api-key'], body: JSON.parse(await body(req)) };
      json(res, fixture('exa.json'));
    },
    '/limited': (req, res) => json(res, { error: 'rate limited' }, 429),
    '/searx/search': (req, res) => {
      seen.searx = { url: req.url };
      json(res, fixture('searxng.json'));
    },
  });
  const { hooks } = hooksFor({ 'search.example': ['127.0.0.1'] });
  const endpoints = { duckduckgo: srv.url('search.example', '/html/'), brave: srv.url('search.example', '/brave'), tavily: srv.url('search.example', '/tavily'), exa: srv.url('search.example', '/exa') };
  const opts = { hooks, endpoints };
  const settings = (provider, extra = {}) => ({ provider, apiKey: '', baseUrl: '', ...extra });

  const r1 = await S.runSearch(settings('duckduckgo'), 'electron window', 2, 'electronjs.org', opts);
  const q1 = new URL(seen.ddg.url, 'http://x').searchParams.get('q');
  check('DuckDuckGo: GET with the query (site: added), as SiloHarness, no cookie; count respected', r1.length === 2 && q1 === 'electron window site:electronjs.org' && seen.ddg.method === 'GET' && /^SiloHarness/.test(seen.ddg.ua) && !seen.ddg.cookie, { q1, n: r1.length });
  ddgMode = 'blocked';
  const blocked = await rejects(S.runSearch(settings('duckduckgo'), 'x', 5, undefined, opts));
  check('DuckDuckGo answering 202 (its block) is a one-line error naming the setting', blocked instanceof S.SearchError && /DuckDuckGo blocked/.test(blocked.message) && /webSearch\.provider/.test(blocked.message), blocked?.message);

  const r2 = await S.runSearch(settings('brave', { apiKey: KEY }), 'electron', 5, undefined, opts);
  check('Brave: the key in X-Subscription-Token, count in the query', r2.length === 2 && seen.brave.token === KEY && new URL(seen.brave.url, 'http://x').searchParams.get('count') === '5');
  const badKey = await rejects(S.runSearch(settings('brave', { apiKey: `${KEY}-wrong` }), 'electron', 5, undefined, opts));
  check('Brave: a refused key is one line naming webSearch.apiKey, without the key (the reply quoted it)', badKey instanceof S.SearchError && /refused the API key \(webSearch\.apiKey/.test(badKey.message) && !badKey.message.includes(KEY), badKey?.message);
  const noKey = await rejects(S.runSearch(settings('tavily'), 'x', 3, undefined, opts));
  check('a provider that needs a key and has none says which setting', noKey instanceof S.SearchError && /Tavily needs an API key: set webSearch\.apiKey/.test(noKey.message), noKey?.message);
  const r3 = await S.runSearch(settings('tavily', { apiKey: KEY }), 'electron', 3, 'electronjs.org', opts);
  check('Tavily: POST JSON, Bearer key, max_results and include_domains', r3.length === 2 && seen.tavily.method === 'POST' && seen.tavily.auth === `Bearer ${KEY}` && seen.tavily.body.max_results === 3 && seen.tavily.body.include_domains[0] === 'electronjs.org' && !('api_key' in seen.tavily.body), seen.tavily);
  const r4 = await S.runSearch(settings('exa', { apiKey: KEY }), 'electron', 4, undefined, opts);
  check('Exa: x-api-key header, numResults', r4.length === 2 && seen.exa.key === KEY && seen.exa.body.numResults === 4, seen.exa);
  const limited = await rejects(S.runSearch(settings('exa', { apiKey: KEY }), 'x', 4, undefined, { hooks, endpoints: { exa: srv.url('search.example', '/limited') } }));
  check('a rate limit (429) is one line that says so and names the setting', limited instanceof S.SearchError && /Exa rate-limited the search/.test(limited.message) && /webSearch\.provider/.test(limited.message), limited?.message);

  // SearXNG on the user's own (private) address: that host only, and without any test hook
  const r5 = await S.runSearch(settings('searxng', { baseUrl: `http://127.0.0.1:${srv.port}/searx` }), 'electron', 8, 'stackoverflow.com', {});
  const q5 = new URL(seen.searx.url, 'http://x').searchParams;
  check('SearXNG: its own private address works (no hooks), format=json, site: in the query', r5.length === 2 && q5.get('format') === 'json' && q5.get('q') === 'electron site:stackoverflow.com', seen.searx);
  const other = await rejects(S.runSearch(settings('duckduckgo'), 'x', 3, undefined, { endpoints: { duckduckgo: `http://127.0.0.1:${srv.port}/html/` } }));
  check('…but no other provider may reach a private address', other instanceof S.SearchError && /loopback/.test(other.message), other?.message);
  const noBase = await rejects(S.runSearch(settings('searxng'), 'x', 3, undefined, {}));
  check('SearXNG without an address names webSearch.baseUrl', noBase instanceof S.SearchError && /webSearch\.baseUrl/.test(noBase.message), noBase?.message);

  // The key never leaves in a message: an error lower down that quotes it is redacted
  const leaky = await rejects(S.runSearch(settings('brave', { apiKey: KEY }), 'x', 3, undefined, { hooks: { ...hooks, resolve: async () => { throw new Error(`resolver saw ${KEY} and ${encodeURIComponent(KEY + '/')}`); } }, endpoints }));
  check('key redaction: a lower error that quotes the key comes out without it', leaky instanceof S.SearchError && !leaky.message.includes(KEY) && /…/.test(leaky.message), leaky?.message);
  check('redactKey takes out the key and its URL-encoded form', S.redactKey(`a ${KEY} b ${encodeURIComponent('k/y=1')}`, KEY) === 'a … b k%2Fy%3D1' && S.redactKey('x k%2Fy%3D1 x', 'k/y=1') === 'x … x' && S.redactKey('short abc', 'abc') === 'short abc');
  await srv.close();

  // ---------- The setting ----------
  check('searchSettings: DuckDuckGo by default, junk ignored', S.searchSettings({}).provider === 'duckduckgo' && S.searchSettings({ webSearch: { provider: 'nope' } }).provider === 'duckduckgo' && S.searchSettings({ webSearch: { provider: 'exa', apiKey: ' k ' } }).apiKey === 'k');
  check('providerHost names where queries go', S.providerHost(settings('duckduckgo')) === 'html.duckduckgo.com' && S.providerHost(settings('searxng', { baseUrl: 'http://10.0.0.2:8888/s' })) === '10.0.0.2:8888' && S.providerHost(settings('searxng')) === '');
  check('settings.json: webSearch fields are checked', checkSetting('webSearch.provider', 'brave') === null && /expected one of/.test(checkSetting('webSearch.provider', 'google')) && checkSetting('webSearch.apiKey', 'k') === null && checkSetting('webSearch.nope', 1) === 'unknown');
  check('the key is listed as a secret field, and the schema has the section', SECRET_FIELDS.includes('webSearch.apiKey') && settingsSchema().properties.webSearch.properties.provider.enum.length === 5);
  const schemaFile = JSON.parse(fs.readFileSync(path.join(projectDir, 'docs/settings.schema.json'), 'utf8'));
  check('docs/settings.schema.json is up to date', JSON.stringify(schemaFile) === JSON.stringify(settingsSchema()));

  const cfg = { ...defaultConfig(), webSearch: { provider: 'brave', apiKey: KEY, baseUrl: '' } };
  const win = windowConfig(cfg);
  check('the window gets the key masked', win.webSearch.apiKey === KEY_MASK && win.webSearch.provider === 'brave' && !JSON.stringify(win).includes(KEY));
  check('…and an empty key stays empty', windowConfig({ ...cfg, webSearch: { provider: 'brave', apiKey: '' } }).webSearch.apiKey === '');
  const back = acceptFromWindow(cfg, { webSearch: { provider: 'brave', apiKey: KEY_MASK } });
  const changed = acceptFromWindow(cfg, { webSearch: { apiKey: 'new-key-123456' } });
  check('the mask sent back keeps the stored key; a new key replaces it', back.webSearch.apiKey === KEY && changed.webSearch.apiKey === 'new-key-123456');

  // A project's settings.json may choose the provider but not hold a key or move the address
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-websearch-'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'p-')));
  const pfile = path.join(cwd, '.silo-harness', 'settings.json');
  fs.mkdirSync(path.dirname(pfile), { recursive: true });
  fs.writeFileSync(pfile, JSON.stringify({ webSearch: { provider: 'searxng', apiKey: 'repo-key-123456', baseUrl: 'http://10.9.9.9' } }));
  const layer = new SettingsLayer({ userFile: path.join(root, 'absent.json') });
  const applied = layer.load({ workingDirectory: cwd, settingsTrusted: { [trustKey(cwd)]: contentHash(fs.readFileSync(pfile, 'utf8')) }, webSearch: { provider: 'brave', apiKey: KEY } });
  const invalid = layer.info().files[1].invalid.map((i) => i.key);
  check("a project's file sets the provider, not the key or the address", applied.webSearch.provider === 'searxng' && applied.webSearch.apiKey === KEY && applied.webSearch.baseUrl === undefined && invalid.includes('webSearch.apiKey') && invalid.includes('webSearch.baseUrl'), { ws: applied.webSearch, invalid });
  fs.rmSync(root, { recursive: true, force: true });

  done();
})().catch((e) => {
  console.log('FAIL CRASH', e);
  process.exit(1);
});
