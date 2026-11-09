// Remote control: the real server on 127.0.0.1 driven with real HTTP requests, against a fake App container.
// Covers every route, every security requirement, the event stream, and start/stop/configure/newLink with what
// they push and persist. Run: node test/remote.js
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { setupRemote } = require(path.join(projectDir, 'dist/main/remote.js'));
const { fakeApp } = require('./support/fake-app.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A request with full control over headers (fetch will not let us forge Host). */
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The exact bytes of a response, for byte-for-byte comparisons. */
function raw(port, lines) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(lines.join('\r\n') + '\r\n\r\n'));
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    sock.on('error', reject);
  });
}

const POST_HEADERS = { 'content-type': 'application/json', 'x-silo-harness-remote': '1' };
const post = (base, route, body, headers = POST_HEADERS) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });

/** An SSE reader: collects { event, data } in order. */
function openStream(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const events = [];
    const comments = [];
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers, agent: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) comments.push(line);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) events.push({ event, data: JSON.parse(data) });
        }
      });
      let closed = false;
      res.on('close', () => (closed = true));
      resolve({ status: res.statusCode, headers: res.headers, events, comments, close: () => req.destroy(), closed: () => closed, res });
    });
    req.on('error', reject);
  });
}

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(10);
  }
  return fn();
}

function seedSession(store, title, extra = []) {
  const s = store.create();
  s.messages.push(
    { role: 'user', content: [{ type: 'text', text: 'Look at this screenshot and fix the header' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAA' } }] },
    { role: 'assistant', content: 'Reading the file first.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/header.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(30_000) },
    { role: 'assistant', content: 'Done.' },
    ...extra,
  );
  s.title = title;
  s.titleLocked = true;
  store.save(s);
  return s;
}

(async () => {
  const f = fakeApp(projectDir);
  const { app, handlers, pushes, calls } = f;
  const s1 = seedSession(app.store, 'Fix the header');
  const s2 = seedSession(app.store, 'Second one');
  f.setForeground(s1.id);
  setupRemote(app);

  // --- registration and the default -------------------------------------------------------------------------
  for (const m of ['remote.status', 'remote.start', 'remote.stop', 'remote.configure', 'remote.newLink']) check(`rpc ${m} registered`, typeof handlers[m] === 'function');
  check('RemoteService provided', typeof f.services.remote?.status === 'function' && typeof f.services.remote?.start === 'function' && typeof f.services.remote?.stop === 'function');
  let st = handlers['remote.status']();
  check('off by default', st.enabled === false && st.running === false && st.urls.length === 0 && st.port === null, st);

  // --- start --------------------------------------------------------------------------------------------------
  pushes.length = 0;
  st = await handlers['remote.start']();
  check('start: running on localhost', st.running && st.enabled && st.bind === 'localhost' && st.port > 0, st);
  check('start saves the setting', app.config().remote.enabled === true);
  check('start pushes remote:changed with the status', pushes.some(([c, p]) => c === 'remote:changed' && p.running && p.port === st.port), pushes);
  check('localhost: one url, on 127.0.0.1', st.urls.length === 1 && /^http:\/\/127\.0\.0\.1:\d+\/r\/[0-9a-f]{64}\/$/.test(st.urls[0]), st.urls);
  const remoteFile = path.join(app.userData, 'remote.json');
  const stored = JSON.parse(fs.readFileSync(remoteFile, 'utf8'));
  check('token and picked port persisted', st.urls[0].includes(stored.token) && stored.port === st.port, stored);
  check('remote.json is 0600', (fs.statSync(remoteFile).mode & 0o777) === 0o600, (fs.statSync(remoteFile).mode & 0o777).toString(8));
  check('token is 32 bytes hex', /^[0-9a-f]{64}$/.test(stored.token));
  check('startedAt set', typeof st.startedAt === 'number');

  let base = st.urls[0];
  const port = st.port;
  const origin = `http://127.0.0.1:${port}`;

  // --- the page and static files ------------------------------------------------------------------------------
  {
    const r = await fetch(base);
    const html = await r.text();
    check('GET ./ serves the page', r.status === 200 && /text\/html/.test(r.headers.get('content-type')) && html.includes('<script src="app.js"'), r.status);
    check("page CSP is default-src 'self'", /^default-src 'self'(;|$)/.test(r.headers.get('content-security-policy') || ''), r.headers.get('content-security-policy'));
    check('page has no inline script or style', !/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !/<style/.test(html) && !/\sstyle=/.test(html) && !/\son[a-z]+=/.test(html));
    for (const [name, type] of [['app.js', 'javascript'], ['style.css', 'text/css']]) {
      const a = await fetch(base + name);
      check(`GET ./${name}`, a.status === 200 && a.headers.get('content-type').includes(type), a.status);
    }
    const trav = await request(base + '..%2fpackage.json');
    check('no traversal out of the page folder', trav.status === 404 && trav.text === '');
    const noSlash = await request(base.slice(0, -1));
    check('/r/<token> redirects to the slash form', noSlash.status === 308 && noSlash.headers.location === base.split('/').slice(-2, -1)[0] + '/', noSlash.headers.location);
  }

  // --- security headers on every kind of response ---------------------------------------------------------------
  {
    const responses = [await request(base), await request(base + 'api/state'), await request(base + 'nope'), await request(`${origin}/r/wrong/`)];
    let ok = true;
    for (const r of responses) {
      ok &&= r.headers['cache-control'] === 'no-store' && r.headers['referrer-policy'] === 'no-referrer' && r.headers['x-content-type-options'] === 'nosniff' && r.headers['x-frame-options'] === 'DENY';
      ok &&= !Object.keys(r.headers).some((h) => h.startsWith('access-control-'));
    }
    check('no-store, no-referrer, nosniff, DENY on every response; no CORS headers', ok, responses.map((r) => r.headers));
    const pre = await request(base + 'api/send', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    check('CORS preflight gets no CORS answer', !Object.keys(pre.headers).some((h) => h.startsWith('access-control-')) && pre.status === 403, pre.status);
  }

  // --- routes --------------------------------------------------------------------------------------------------
  {
    const r = await fetch(base + 'api/state');
    const body = await r.json();
    check('api/state shape', body.app.name === 'Silo Harness' && typeof body.app.version === 'string' && body.foreground === s1.id && body.model === '@anthropic/claude-sonnet-5' && body.provider === 'portkey' && body.permissionMode === 'ask', body);
    check('api/state lists sessions with status', body.sessions.length === 2 && body.sessions.every((s) => s.status && typeof s.status.running === 'boolean'));
    check('api/state has exactly the listed fields', Object.keys(body).sort().join(',') === 'app,foreground,model,permissionMode,provider,sessions', Object.keys(body));
    const text = JSON.stringify(body);
    check('api/state carries no keys, URLs, folders or rules', !/SECRET|gateway\.example|\/Users\/someone|allowRules/.test(text));
  }
  {
    f.live.set(s1.id, { running: true, startedAt: 1, text: 'Streaming…', thinking: '', tools: [], approvals: [], queue: [{ id: 'q1', text: 'and then', attachments: [{ id: 'a', name: 'x.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', width: 1, height: 1, size: 3 }], createdAt: 2 }] });
    const r = await fetch(base + 'api/transcript?session=' + s1.id);
    const body = await r.json();
    const user = body.items[0];
    const tool = body.items.find((i) => i.role === 'tool');
    check('api/transcript returns items and live', r.status === 200 && Array.isArray(body.items) && body.live.running === true && body.live.text === 'Streaming…');
    check('user item keeps an image count, no data URL', user.role === 'user' && user.images === 1 && !JSON.stringify(body).includes('data:image'), user);
    check('tool results cut to 20,000 chars', tool.result.length < 20_100 && tool.result.startsWith('x'.repeat(20_000)), tool.result.length);
    check('queued attachments become a count', body.live.queue[0].images === 1 && !('attachments' in body.live.queue[0]));
    const missing = await fetch(base + 'api/transcript?session=nope');
    check('api/transcript unknown session → 404 with a message', missing.status === 404 && (await missing.json()).error);
  }
  {
    // A run in progress: its assistant message (two calls) is stored, the first call runs (in live.tools), the second
    // has not started. Neither belongs in the items: no "(no result)" row, and the running one only once (from live).
    const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const s = seedSession(app.store, 'Mid-run');
    s.messages.push({ role: 'user', content: 'Push it' }, { role: 'assistant', content: '', tool_calls: [tc('f1', 'bash', { command: 'git push' }), tc('f2', 'read_file', { path: 'README.md' })] });
    app.store.save(s);
    f.status.set(s.id, { running: true, attention: 'approval' });
    f.live.set(s.id, { running: true, startedAt: 1, text: '', thinking: '', tools: [{ id: 'f1', name: 'bash', args: { command: 'git push' } }], approvals: [], queue: [] });
    const mid = await (await fetch(base + 'api/transcript?session=' + s.id)).json();
    const inFlight = mid.items.filter((i) => i.role === 'tool' && (i.args.includes('git push') || i.args.includes('README.md')));
    check('api/transcript mid-run leaves out tool calls still in flight (live.tools has the running one)', inFlight.length === 0 && !mid.items.some((i) => i.role === 'tool' && i.result === '(no result)') && mid.live.tools.length === 1, mid.items.filter((i) => i.role === 'tool'));
    // Once the run is over, a call that never got a result is shown as it is stored.
    f.status.set(s.id, { running: false });
    f.live.set(s.id, { running: false, text: '', thinking: '', tools: [], approvals: [], queue: [] });
    const after = await (await fetch(base + 'api/transcript?session=' + s.id)).json();
    check('…and keeps them once the session is not running', after.items.filter((i) => i.role === 'tool' && (i.args.includes('git push') || i.args.includes('README.md'))).length === 2);
    app.store.delete(s.id);
    f.status.delete(s.id);
    f.live.delete(s.id);
  }
  {
    calls.length = 0;
    const r = await post(base, 'api/send', { session: s1.id, text: 'Also fix the footer', extra: 'ignored' });
    const body = await r.json();
    check('api/send → runtime.send with origin remote, no attachments', r.status === 200 && body.ok === true && JSON.stringify(calls[0]) === JSON.stringify(['send', s1.id, 'Also fix the footer', [], { origin: 'remote' }]), calls);
    check('unknown fields ignored', r.status === 200);
    const r2 = await post(base, 'api/stop', { session: s1.id });
    check('api/stop → runtime.stop', r2.status === 200 && calls.some((c) => c[0] === 'stop' && c[1] === s1.id));
    const r3 = await post(base, 'api/approve', { id: 'ap1', ok: true, always: true, scope: 'project' });
    check('api/approve allow for session → scope session (a project scope in the body is ignored)', r3.status === 200 && JSON.stringify(calls.at(-1)) === JSON.stringify(['respondApproval', 'ap1', true, true, 'session']), calls.at(-1));
    await post(base, 'api/approve', { id: 'ap2', ok: true });
    check('api/approve allow once', JSON.stringify(calls.at(-1)) === JSON.stringify(['respondApproval', 'ap2', true, false, 'session']), calls.at(-1));
    await post(base, 'api/approve', { id: 'ap3', ok: false, always: true });
    check('api/approve deny never carries always', JSON.stringify(calls.at(-1)) === JSON.stringify(['respondApproval', 'ap3', false, false, 'session']), calls.at(-1));
    const gone = await post(base, 'api/approve', { id: 'gone', ok: true });
    check('api/approve on an answered card → 404', gone.status === 404);
    const r4 = await post(base, 'api/plan', { session: s1.id, id: 'plan-1', decision: 'build-acceptEdits' });
    check('api/plan → runtime.respondPlan', r4.status === 200 && JSON.stringify(calls.at(-1)) === JSON.stringify(['respondPlan', s1.id, 'plan-1', 'build-acceptEdits']));
    const r5 = await post(base, 'api/new', {});
    const meta = await r5.json();
    check('api/new → runtime.create({ foreground: false }) and its meta', r5.status === 200 && typeof meta.id === 'string' && meta.title && JSON.stringify(calls.at(-1)) === JSON.stringify(['create', { foreground: false }]), meta);
    check('api/new leaves the foreground alone', app.runtime.foregroundId() === s1.id);

    // A browser card reaches the phone whole (its kind, site and amber note), answered through api/approve like any
    // card; the Browser pane's permission bar and download bar have no route: only the Mac's window answers them.
    const { remoteEvent } = require(path.join(projectDir, 'dist/main/remote/sanitize.js'));
    const card = { type: 'approval_request', id: 'ap-b', name: 'browser_click', detail: 'Click "Sign in" on login.example.com\nTo reach the dashboard', mode: 'ask', alwaysLabel: '', projectLabel: '', note: 'This looks like a sign-in site', browser: { card: 'sensitive', site: 'login.example.com' } };
    const out = remoteEvent(card);
    check('a browser card passes to the phone with its browser { card, site } and its note', out && JSON.stringify(out.browser) === JSON.stringify(card.browser) && out.note === card.note && out.detail === card.detail && out.alwaysLabel === '', out);
    for (const route of ['api/permission', 'api/permissions', 'api/answerPermission', 'api/download', 'api/downloads', 'api/browser']) {
      const r = await post(base, route, { id: 'x', answer: 'always' });
      check(`no route answers the browser's bars (${route} → 404)`, r.status === 404, r.status);
    }
  }

  // --- validation ---------------------------------------------------------------------------------------------
  {
    const bad = [
      ['api/send', { session: s1.id, text: 42 }, /"text"/],
      ['api/send', { session: s1.id }, /"text"/],
      ['api/approve', { id: 'x', ok: 'yes' }, /"ok"/],
      ['api/plan', { session: s1.id, id: 'p', decision: 'build-bypass' }, /decision/],
    ];
    for (const [route, body, re] of bad) {
      const r = await post(base, route, body);
      const j = await r.json();
      check(`wrong type → 400 with a message (${route} ${JSON.stringify(body)})`, r.status === 400 && re.test(j.error), j);
    }
    const notJson = await fetch(base + 'api/send', { method: 'POST', headers: POST_HEADERS, body: '{nope' });
    check('malformed JSON → 400', notJson.status === 400);
    const arr = await fetch(base + 'api/send', { method: 'POST', headers: POST_HEADERS, body: '[1]' });
    check('a JSON array → 400', arr.status === 400);
    const big = await request(base + 'api/send', { method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ session: s1.id, text: 'a'.repeat(300 * 1024) }) });
    check('body over 256 KB → 413', big.status === 413, big.status);
    const chunked = await new Promise((resolve) => {
      const u = new URL(base + 'api/send');
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { ...POST_HEADERS, 'transfer-encoding': 'chunked' }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve('reset'));
      for (let i = 0; i < 40; i++) req.write('a'.repeat(8 * 1024));
      req.end();
    });
    check('chunked body over 256 KB (no length declared) → 413', chunked === 413, chunked);
    const wrongMethod = await fetch(base + 'api/state', { method: 'POST', headers: POST_HEADERS, body: '{}' });
    check('wrong method → 405', wrongMethod.status === 405);
  }

  // --- nothing else is reachable ------------------------------------------------------------------------------
  {
    const tries = ['api/config', 'api/settings', 'api/mode', 'api/rules', 'api/mods', 'api/schedules', 'api/files', 'api/trust'];
    let all404 = true;
    for (const t of tries) {
      const g = await request(base + t);
      const p = await request(base + t, { method: 'POST', headers: POST_HEADERS, body: '{"permissionMode":"bypass"}' });
      all404 &&= g.status === 404 && p.status === 404;
    }
    check('no route for settings, mode, rules, mods, schedules, files, trust', all404);
    check('config untouched by the remote', app.config().permissionMode === 'ask' && Object.keys(app.config().allowRules).length === 1);
  }

  // --- token ------------------------------------------------------------------------------------------------
  {
    const wrongTok = base.replace(/[0-9a-f]{64}/, 'f'.repeat(64));
    const r1 = await request(wrongTok);
    const r2 = await request(`${origin}/r/`);
    const r3 = await request(`${origin}/`);
    check('wrong token → 404, empty body', r1.status === 404 && r1.text === '');
    check('missing token → 404, empty body', r2.status === 404 && r2.text === '' && r3.status === 404 && r3.text === '');
    const tok = base.match(/[0-9a-f]{64}/)[0];
    const req = (p) => [`GET ${p} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];
    const a = await raw(port, req(`/r/${'0'.repeat(64)}/api/state`));
    const b = await raw(port, req('/favicon.ico'));
    const c = await raw(port, req(`/r/${tok}/no-such-file.js`));
    const d = await raw(port, req(`/r/${tok.slice(0, 63)}/`));
    check('wrong-token, unknown-path and near-miss-token responses are byte-identical', a === b && b === c && c === d && a.startsWith('HTTP/1.1 404'), [a, b, c, d]);
    check('…and carry no Date header or body', !/\r\ndate:/i.test(a) && a.endsWith('\r\n\r\n'));
  }

  // --- Host (DNS rebinding) ---------------------------------------------------------------------------------
  {
    const evil = await request(base + 'api/state', { headers: { host: `evil.example:${port}` } });
    const noPort = await request(base + 'api/state', { headers: { host: '127.0.0.1' } });
    const otherPort = await request(base + 'api/state', { headers: { host: `127.0.0.1:${port + 1}` } });
    const okLocal = await request(base + 'api/state', { headers: { host: `localhost:${port}` } });
    check('foreign Host → bare 404', evil.status === 404 && evil.text === '' && noPort.status === 404 && otherPort.status === 404);
    check('own Host (localhost:port) accepted', okLocal.status === 200);
    const rebind = await raw(port, [`GET /r/${base.match(/[0-9a-f]{64}/)[0]}/api/state HTTP/1.1`, `Host: evil.example:${port}`, 'Connection: close']);
    const unknown = await raw(port, ['GET /nope HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: close']);
    check('foreign-Host response is byte-identical to an unknown path', rebind === unknown, [rebind, unknown]);
  }

  // --- Origin and the POST requirements ---------------------------------------------------------------------
  {
    const foreign = await request(base + 'api/state', { headers: { origin: 'https://evil.example' } });
    const nullOrigin = await request(base + 'api/state', { headers: { origin: 'null' } });
    const own = await request(base + 'api/state', { headers: { origin } });
    check('foreign Origin → 403', foreign.status === 403 && nullOrigin.status === 403, foreign.status);
    check('own Origin accepted', own.status === 200);
    const before = calls.length;
    const form = await request(base + 'api/send', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-silo-harness-remote': '1' }, body: 'session=x&text=rm' });
    const textPlain = await request(base + 'api/send', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-silo-harness-remote': '1' }, body: JSON.stringify({ session: s1.id, text: 'hi' }) });
    const noHeader = await request(base + 'api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: s1.id, text: 'hi' }) });
    const crossSite = await request(base + 'api/send', { method: 'POST', headers: { ...POST_HEADERS, origin: 'http://192.168.1.66:8080' }, body: JSON.stringify({ session: s1.id, text: 'hi' }) });
    check('POST without application/json → refused (415)', form.status === 415 && textPlain.status === 415, [form.status, textPlain.status]);
    check('POST without x-silo-harness-remote: 1 → 403', noHeader.status === 403, noHeader.status);
    check('POST from another origin → 403', crossSite.status === 403);
    check('none of them reached the runtime', calls.length === before);
    // A page loaded before the rename sends the header under its old name: still accepted
    const oldHeader = await request(base + 'api/send', { method: 'POST', headers: { 'content-type': 'application/json', 'x-open-harness-remote': '1' }, body: JSON.stringify({ session: 'no-such-session', text: 'hi' }) });
    check('POST with the old x-open-harness-remote: 1 passes the header check', oldHeader.status !== 403, oldHeader.status);
  }

  // --- the event stream -------------------------------------------------------------------------------------
  {
    pushes.length = 0;
    const s = await openStream(base + 'api/events');
    check('api/events is an event stream', s.status === 200 && /text\/event-stream/.test(s.headers['content-type']) && s.headers['cache-control'] === 'no-store');
    await waitFor(() => s.events.length >= 1);
    check('stream opens with the session list', s.events[0]?.event === 'sessions' && s.events[0].data.length === 2, s.events[0]);
    check('client count 1 and pushed', handlers['remote.status']().clients === 1 && pushes.some(([c, p]) => c === 'remote:changed' && p.clients === 1));

    s.events.length = 0;
    f.emit(s1.id, { type: 'run_start' });
    f.emit(s1.id, { type: 'user_message', text: 'go', images: 0, origin: 'user' });
    for (const ch of ['Hel', 'lo', ', ', 'wor', 'ld']) f.emit(s1.id, { type: 'text_delta', text: ch });
    f.emit(s2.id, { type: 'thinking_delta', text: 'hmm ' });
    f.emit(s2.id, { type: 'thinking_delta', text: 'ok' });
    f.emit(s1.id, { type: 'text_done' });
    f.emit(s1.id, { type: 'tool_start', id: 't1', name: 'bash', args: { command: 'ls' } });
    f.emit(s1.id, { type: 'tool_end', id: 't1', name: 'bash', result: 'y'.repeat(25_000), ok: true, image: 'data:image/png;base64,QUJD' });
    f.emit(s1.id, { type: 'usage', promptTokens: 1, completionTokens: 2 });
    f.emit(s1.id, { type: 'text_delta', text: 'A' });
    await sleep(30);
    f.emit(s1.id, { type: 'text_delta', text: 'B' });
    await sleep(250);
    f.emit(s1.id, { type: 'text_delta', text: 'C' });
    f.emit(s1.id, { type: 'run_end', reason: 'done', text: 'Hello, worldABC' });
    await waitFor(() => s.events.filter((e) => e.event === 'sessions').length >= 2);
    const agent = s.events.filter((e) => e.event === 'agent');
    const s1evs = agent.filter((e) => e.data.sessionId === s1.id).map((e) => e.data.ev);
    const types = s1evs.map((e) => e.type + (e.text !== undefined && e.type.endsWith('delta') ? `:${e.text}` : ''));
    check('per-session order kept and deltas coalesced', JSON.stringify(types) === JSON.stringify(['run_start', 'user_message', 'text_delta:Hello, world', 'text_done', 'tool_start', 'tool_end', 'text_delta:AB', 'text_delta:C', 'run_end']), types);
    const s2evs = agent.filter((e) => e.data.sessionId === s2.id).map((e) => e.data.ev);
    check('thinking deltas coalesced per session', s2evs.length === 1 && s2evs[0].type === 'thinking_delta' && s2evs[0].text === 'hmm ok', s2evs);
    const te = s1evs.find((e) => e.type === 'tool_end');
    check('tool_end: image dropped, result cut', !('image' in te) && te.result.length < 20_100, Object.keys(te));
    check('usage events not forwarded', !s1evs.some((e) => e.type === 'usage'));
    const order = s.events.map((e) => e.event + ':' + (e.data.ev?.type || ''));
    const firstSessions = order.indexOf('sessions:');
    check('session list sent after run_start and after run_end', firstSessions > order.indexOf('agent:run_start') && order.lastIndexOf('sessions:') > order.indexOf('agent:run_end'), order);

    // Joining a snapshot to the stream: api/transcript flushes held text and answers with the last event number.
    s.events.length = 0;
    f.emit(s1.id, { type: 'text_delta', text: 'held ' });
    f.emit(s1.id, { type: 'text_delta', text: 'back' });
    const snap = await (await fetch(base + 'api/transcript?session=' + s1.id)).json();
    f.emit(s1.id, { type: 'text_done' });
    await waitFor(() => s.events.filter((e) => e.event === 'agent').length >= 2);
    const [held, next] = s.events.filter((e) => e.event === 'agent').map((e) => e.data);
    check('api/transcript returns seq and flushes held deltas first', typeof snap.seq === 'number' && held.ev.text === 'held back' && held.seq === snap.seq, [snap.seq, held]);
    check('events after the snapshot have a higher seq', next.ev.type === 'text_done' && next.seq === snap.seq + 1, next);

    // A heartbeat comment: wait for one only if the interval is short; instead check the opening comment arrived.
    check('stream carries comment lines (heartbeat format)', s.comments.includes(': connected'));

    // The cap: 7 more fit, the 9th is refused.
    const more = [];
    for (let i = 0; i < 7; i++) more.push(await openStream(base + 'api/events'));
    check('8 streams open', more.every((m) => m.status === 200) && handlers['remote.status']().clients === 8, handlers['remote.status']().clients);
    const ninth = await openStream(base + 'api/events');
    let ninthBody = '';
    ninth.res.on('data', (c) => (ninthBody += c));
    await waitFor(() => ninth.closed());
    check('9th stream refused with 503', ninth.status === 503 && handlers['remote.status']().clients === 8, ninth.status);
    for (const m of more) m.close();
    await waitFor(() => handlers['remote.status']().clients === 1);
    check('client count drops as streams close', handlers['remote.status']().clients === 1);
    s.close();
    await waitFor(() => handlers['remote.status']().clients === 0);
    check('client count back to 0 and pushed', handlers['remote.status']().clients === 0 && pushes.at(-1)[1].clients === 0);
  }

  // --- newLink: the old token dies ----------------------------------------------------------------------------
  {
    const s = await openStream(base + 'api/events');
    pushes.length = 0;
    const oldBase = base;
    st = await handlers['remote.newLink']();
    base = st.urls[0];
    check('newLink: a different token, same port', base !== oldBase && st.port === port && st.running, st);
    check('newLink pushes remote:changed', pushes.some(([c, p]) => c === 'remote:changed' && p.urls[0] === base));
    await waitFor(() => s.closed());
    check('streams opened with the old token are closed', s.closed());
    check('old token → 404', (await request(oldBase + 'api/state')).status === 404);
    check('new token works', (await request(base + 'api/state')).status === 200);
    check('new token persisted', JSON.parse(fs.readFileSync(remoteFile, 'utf8')).token === base.match(/[0-9a-f]{64}/)[0]);
  }

  // --- configure: port, bind, restarts --------------------------------------------------------------------------
  {
    pushes.length = 0;
    const free = await new Promise((r) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => r(p));
      });
    });
    st = await handlers['remote.configure']({ port: free });
    check('configure port restarts on it', st.running && st.port === free && app.config().remote.port === free, st);
    check('configure pushes the new status', pushes.some(([c, p]) => c === 'remote:changed' && p.port === free));
    base = st.urls[0];

    // lan: listens on every interface, one url per non-internal IPv4 address plus loopback.
    st = await handlers['remote.configure']({ bind: 'lan' });
    const lanAddrs = Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address);
    check('lan: urls for loopback and each LAN address', st.bind === 'lan' && st.urls.length === 1 + lanAddrs.length && lanAddrs.every((a) => st.urls.some((u) => u.startsWith(`http://${a}:${free}/r/`))), st.urls);
    if (lanAddrs.length) {
      const lanUrl = st.urls.find((u) => u.includes(lanAddrs[0]));
      const r = await request(lanUrl + 'api/state').catch((e) => ({ status: e.code }));
      check('lan: answers on the LAN address with its own Host', r.status === 200, r.status);
    }
    st = await handlers['remote.configure']({ bind: 'localhost' });
    if (lanAddrs.length) {
      const r = await request(`http://${lanAddrs[0]}:${free}/`).catch((e) => ({ status: e.code }));
      check('localhost: not reachable on the LAN address', r.status === 'ECONNREFUSED', r.status);
    }
    check('localhost: one url again', st.urls.length === 1);
    let threw = false;
    try {
      await handlers['remote.configure']({ bind: 'internet' });
    } catch {
      threw = true;
    }
    check('configure refuses an unknown bind', threw && app.config().remote.bind === 'localhost');
  }

  // --- a port already in use ---------------------------------------------------------------------------------
  {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    pushes.length = 0;
    const warn = console.warn;
    const warned = [];
    console.warn = (...a) => warned.push(a.join(' ')); // the expected warning would otherwise end the suite's output
    st = await handlers['remote.configure']({ port: busy });
    console.warn = warn;
    check('the failure is logged', warned.some((w) => /already in use/.test(w)), warned);
    check('port in use → not running, error says so', !st.running && st.enabled && /already in use/.test(st.error || ''), st);
    check('the error is pushed', pushes.some(([c, p]) => c === 'remote:changed' && p.error));
    blocker.close();
    st = await handlers['remote.start']();
    check('start retries once the port is free', st.running && st.port === busy && !st.error, st);
  }

  // --- stop -----------------------------------------------------------------------------------------------------
  {
    st = await handlers['remote.configure']({ port: 0 });
    const pickedPort = st.port;
    const token = st.urls[0].match(/[0-9a-f]{64}/)[0];
    pushes.length = 0;
    st = await handlers['remote.stop']();
    check('stop: not running, setting saved', !st.running && !st.enabled && app.config().remote.enabled === false && st.urls.length === 0, st);
    check('stop pushes', pushes.some(([c, p]) => c === 'remote:changed' && !p.running));
    const gone = await request(`http://127.0.0.1:${pickedPort}/`).catch((e) => ({ status: e.code }));
    check('nothing listens after stop', gone.status === 'ECONNREFUSED', gone.status);

    // --- a restart of the app: same token, same port -------------------------------------------------------------
    st = await handlers['remote.start']();
    await f.quit();
    check('quit stops the server but keeps the setting', !handlers['remote.status']().running && app.config().remote.enabled === true);
    const g = fakeApp(projectDir, { userData: app.userData, remote: { enabled: true, bind: 'localhost', port: 0 } });
    setupRemote(g.app);
    await waitFor(() => g.handlers['remote.status']().running);
    const st2 = g.handlers['remote.status']();
    check('after a restart: same port and token, links keep working', st2.port === st.port && st2.urls[0] === st.urls[0] && st2.urls[0].includes(token), [st.urls[0], st2.urls[0]]);
    check('the old link answers after the restart', (await request(st2.urls[0] + 'api/state')).status === 200);
    await g.quit();
  }

  // --- throttle: 10 wrong tokens in a minute → 429 (a fresh app: it locks 127.0.0.1 out) -----------------------
  {
    const h = fakeApp(projectDir);
    setupRemote(h.app);
    const hs = await h.handlers['remote.start']();
    const hOrigin = `http://127.0.0.1:${hs.port}`;
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await request(`${hOrigin}/r/${'a'.repeat(64)}/`)).status);
    const after = await request(hs.urls[0] + 'api/state');
    check('10 wrong tokens → 404 each', statuses.every((s) => s === 404), statuses);
    check('then the address gets 429, even with the right token', after.status === 429 && after.headers['retry-after'] === '60' && after.text === '', after.status);
    await h.quit();
  }

  done();
})().catch((err) => {
  console.log('CRASH', err && err.stack);
  process.exit(1);
});
