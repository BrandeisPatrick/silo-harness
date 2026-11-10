// OAuth sign-in for remote MCP servers, against local mocks (test/support/mock-oauth.js): an MCP server that needs a
// bearer token and an authorization server. The opener the manager gets fetches the authorization URL and follows its
// redirect to the callback, as a browser would: no browser opens. Run: node test/mcp-oauth.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { McpManager } = require(path.join(projectDir, 'dist/main/mcp.js'));
const auth = require(path.join(projectDir, 'dist/main/mcp-auth.js'));
const { startMock, makeOpener } = require('./support/mock-oauth.js');

// Every console line is kept, to look for secrets in them at the end.
const logged = [];
for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    logged.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    orig(...a);
  };
}
const errors = []; // every error string the user or the model could see

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`.slice(0, 500));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(25); } return fn(); };
const caught = async (p) => { try { await p; return ''; } catch (e) { errors.push(e.message); return e.message; } };

(async () => {
  // ---- units ----
  check('https and loopback http allowed', auth.isSecureOrLoopback('https://a.example/x') && auth.isSecureOrLoopback('http://127.0.0.1:9/x') && auth.isSecureOrLoopback('http://localhost/x') && auth.isSecureOrLoopback('http://[::1]:8/x'));
  check('other http refused', !auth.isSecureOrLoopback('http://a.example/x') && !auth.isSecureOrLoopback('http://127.0.0.1.evil.example/') && !auth.isSecureOrLoopback('javascript:alert(1)'));
  let msg = '';
  try { auth.checkDiscovery({ authorizationServerUrl: 'https://as.example', authorizationServerMetadata: { authorization_endpoint: 'https://as.example/a', token_endpoint: 'http://as.example/t', registration_endpoint: 'https://as.example/r' } }); } catch (e) { msg = e.message; }
  check('non-https token endpoint refused', /Refused the sign-in token endpoint http:\/\/as\.example\/t/.test(msg), msg);
  msg = '';
  try { await auth.guardedFetch(new URL('http://10.0.0.5/mcp'))('http://as.example/.well-known/x'); } catch (e) { msg = e.message; }
  check('guarded fetch refuses http to another host', /Refused/.test(msg), msg);
  auth.rememberSecret('sekrit-value-123');
  const red = auth.redactSecrets('a sekrit-value-123 b Authorization: Bearer abc.def-ghi c ?code=xyz&state=s {"access_token":"tok","x":1}');
  check('redaction: known values, Bearer, code=, JSON tokens', !/sekrit-value-123|abc\.def|xyz|"tok"/.test(red) && /state=s/.test(red), red);

  // the callback listener alone
  const l = await auth.startCallbackListener({ state: 'st-1', timeoutMs: 400 });
  let r = await fetch(`http://127.0.0.1:${l.port}/other?code=c&state=st-1`);
  check('listener: other paths get 404 and do not count', r.status === 404);
  r = await fetch(`http://127.0.0.1:${l.port}/callback?code=good-code-1&state=st-1`);
  const page = await r.text();
  check('listener: plain page "Signed in. You can close this tab."', r.status === 200 && page === 'Signed in. You can close this tab.' && /text\/plain/.test(r.headers.get('content-type')), page);
  check('listener: resolves with the code', (await l.code) === 'good-code-1');
  check('listener: closed after one callback', !!(await caught(fetch(`http://127.0.0.1:${l.port}/callback?code=x&state=st-1`))));
  const l2 = await auth.startCallbackListener({ state: 'st-2', timeoutMs: 300 });
  check('listener: times out', /timed out/.test(await caught(l2.code)));
  check('listener: closed after the timeout', !!(await caught(fetch(`http://127.0.0.1:${l2.port}/callback?code=x&state=st-2`))));
  const l3 = await auth.startCallbackListener({ state: 'st-3' });
  r = await fetch(`http://127.0.0.1:${l3.port}/callback?code=x&state=wrong`);
  check('listener: wrong state rejected', r.status === 400 && /unexpected state/.test(await caught(l3.code)));
  const l4 = await auth.startCallbackListener({ state: 'st-4' });
  l4.close();
  check('listener: cancel', /cancelled/.test(await caught(l4.code)));
  const l5 = await auth.startCallbackListener({ state: 'st-5' });
  check('listener: bound to 127.0.0.1 only', l5.redirectUrl === `http://127.0.0.1:${l5.port}/callback`);
  l5.close();

  // ---- the manager against the mocks ----
  const mock = await startMock(projectDir, { requireAuth: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-oauth-'));
  const tokenFile = path.join(tmp, 'data', 'mcp-auth.json');
  const opener = makeOpener();
  let config = { mcpServers: { remote: { type: 'http', url: mock.mcpUrl } }, mcpTrusted: {} };
  const make = (open = opener.open, store = new auth.FileTokenStore(tokenFile)) =>
    new McpManager({ getConfig: () => config, saveConfig: (p) => { config = { ...config, ...p }; }, cwd: () => tmp, auth: { store, openExternal: open, signInTimeoutMs: 5000 } });
  const m = make();
  await m.reload();
  const st = (mgr = m, name = 'remote') => mgr.list().find((x) => x.name === name);
  check('401 → needs-auth', st().status === 'needs-auth' && !st().error && !st().signedIn, st());
  check('…with no browser opened and no registration', opener.opened.length === 0 && mock.state.registrations === 0 && mock.state.authorizeRequests === 0);
  check('…and no tools offered', m.tools().length === 0);
  check('…and nothing written to the data folder', !fs.existsSync(tokenFile));
  errors.push(await caught(m.call('mcp__remote__whoami', {})));

  // full sign-in
  const signedIn = m.signIn('remote', 'user');
  check('sign-in: status authorizing at once', st().status === 'authorizing');
  await signedIn;
  check('sign-in: connected with the tools', st().status === 'connected' && st().tools.length === 2 && st().signedIn === true, st());
  check('sign-in: browser opened once, client registered once', opener.opened.length === 1 && mock.state.registrations === 1);
  const authUrl = new URL(opener.opened[0]);
  check('sign-in: PKCE S256, state, loopback redirect', authUrl.searchParams.get('code_challenge_method') === 'S256' && !!authUrl.searchParams.get('code_challenge') && (authUrl.searchParams.get('state') || '').length >= 20 && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(authUrl.searchParams.get('redirect_uri')));
  check('sign-in: the browser saw "Signed in"', await until(() => opener.results.some((x) => x.status === 200 && x.body === 'Signed in. You can close this tab.')), opener.results);
  const cbPort = new URL(authUrl.searchParams.get('redirect_uri')).port;
  check('sign-in: callback listener closed', !!(await caught(fetch(`http://127.0.0.1:${cbPort}/callback?code=x`))));
  let res = await m.call('mcp__remote__whoami', {});
  check('sign-in: calls work', res.content === 'hello from remote');
  const mode = fs.statSync(tokenFile).mode & 0o777;
  check('token file mode 0600', mode === 0o600, mode.toString(8));
  const stored = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  check('token file holds the tokens and the registration', !!stored.servers['user:remote'].tokens.access_token && !!stored.servers['user:remote'].client.client_id && stored.servers['user:remote'].url === mock.mcpUrl);
  check('no verifier stored', !JSON.stringify(stored).includes('verifier'));
  check('no temp files left beside it', fs.readdirSync(path.dirname(tokenFile)).join(',') === 'mcp-auth.json');

  // second manager from the same file
  const opener2 = makeOpener();
  const m2 = make(opener2.open);
  await m2.reload();
  check('second instance reuses the stored token', st(m2).status === 'connected' && st(m2).signedIn && opener2.opened.length === 0 && mock.state.registrations === 1, st(m2));
  await m2.close();

  // refresh
  mock.expireAccess();
  const refreshesBefore = mock.state.tokenRequests.filter((g) => g === 'refresh_token').length;
  res = await m.call('mcp__remote__whoami', {});
  check('expired token refreshed on its own', res.content === 'hello from remote' && mock.state.tokenRequests.filter((g) => g === 'refresh_token').length === refreshesBefore + 1 && opener.opened.length === 1);

  // failed refresh
  mock.expireAccess();
  mock.revokeRefresh();
  const e1 = await caught(m.call('mcp__remote__whoami', {}));
  check('failed refresh → needs-auth, one clear line', /needs sign-in/.test(e1) && st().status === 'needs-auth', [e1, st().status]);
  check('…no browser opened by itself', opener.opened.length === 1 && mock.state.authorizeRequests === 1);
  await sleep(200);
  check('…and no reconnect loop', st().status === 'needs-auth');

  // sign in again, then sign out
  await m.signIn('remote', 'user');
  check('sign in again', st().status === 'connected' && opener.opened.length === 2);
  await m.signOut('remote', 'user');
  const after = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  check('sign out: tokens and registration deleted', !after.servers['user:remote'] && st().status === 'needs-auth' && !st().signedIn, st());
  check('sign out: file still 0600', (fs.statSync(tokenFile).mode & 0o777) === 0o600);

  // cancel
  const quiet = { opened: [], open: async (u) => { quiet.opened.push(u); } };
  const m3 = make(quiet.open, new auth.MemoryTokenStore());
  await m3.reload();
  const pending = m3.signIn('remote', 'user');
  await until(() => quiet.opened.length === 1);
  check('waiting for the browser', st(m3).status === 'authorizing');
  await m3.cancelSignIn('remote', 'user');
  await pending;
  const port3 = new URL(new URL(quiet.opened[0]).searchParams.get('redirect_uri')).port;
  check('cancel: back to needs-auth, listener closed', st(m3).status === 'needs-auth' && !st(m3).error && !!(await caught(fetch(`http://127.0.0.1:${port3}/callback?code=x`))));
  await m3.close();

  // wrong state
  const bad = makeOpener({ tamperState: true });
  const m4 = make(bad.open, new auth.MemoryTokenStore());
  await m4.reload();
  await m4.signIn('remote', 'user');
  check('wrong state rejected: needs-auth with the reason, no token', st(m4).status === 'needs-auth' && /unexpected state/.test(st(m4).error) && !st(m4).signedIn, st(m4));
  check('…token endpoint not asked for a code', mock.state.tokenRequests.filter((g) => g === 'authorization_code').length === 2);
  errors.push(st(m4).error);
  await m4.close();

  // non-https endpoint
  mock.state.insecure = 'token_endpoint';
  const m5 = make(makeOpener().open, new auth.MemoryTokenStore());
  await m5.reload();
  check('non-https token endpoint: connect refused with the reason', st(m5).status === 'error' && /Refused the sign-in token endpoint http:\/\/not-loopback\.example/.test(st(m5).error), st(m5));
  const op5 = makeOpener();
  const m6 = make(op5.open, new auth.MemoryTokenStore());
  await m6.reload();
  await m6.signIn('remote', 'user').catch(() => undefined);
  check('non-https token endpoint: sign-in refused before the browser', op5.opened.length === 0 && st(m6).status === 'needs-auth' && /Refused/.test(st(m6).error), st(m6));
  errors.push(st(m5).error, st(m6).error);
  mock.state.insecure = null;
  await m5.close();
  await m6.close();

  // a server with its own Authorization header is not an OAuth server
  config = { mcpServers: { remote: { type: 'http', url: mock.mcpUrl, headers: { Authorization: 'Bearer static-wrong-token' } } }, mcpTrusted: {} };
  const m7 = make(makeOpener().open, new auth.MemoryTokenStore());
  await m7.reload();
  check('static Authorization header: a 401 is an error, not needs-auth', st(m7).status === 'error', st(m7));
  errors.push(st(m7).error);
  await m7.close();
  check('sign-in refused for a stdio server', /not a remote server/.test(await caught((async () => {
    config = { mcpServers: { local: { command: 'node', args: ['-e', ''] } }, mcpTrusted: {} };
    const m8 = make();
    await m8.reload();
    try { await m8.signIn('local', 'user'); } finally { await m8.close(); }
  })())));

  await m.close();
  await mock.close();

  // ---- no secret anywhere ----
  const secrets = mock.state.issued;
  const leakedLog = logged.filter((line) => secrets.some((s) => line.includes(s)));
  const leakedErr = errors.filter((e) => e && secrets.some((s) => e.includes(s)));
  check(`tokens and codes absent from every log line (${logged.length}) and error string (${errors.length})`, secrets.length >= 6 && !leakedLog.length && !leakedErr.length, { leakedLog: leakedLog.length, leakedErr: leakedErr.length });

  console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
