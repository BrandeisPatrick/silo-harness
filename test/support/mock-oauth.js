// Local mocks for the MCP OAuth and remote-transport tests, on 127.0.0.1 random ports:
//   - an MCP server over streamable HTTP (SDK server classes) that can require a bearer token, stop and start again;
//   - an OAuth authorization server: metadata, dynamic registration, /authorize (redirects to the callback),
//     /token (authorization_code with a PKCE S256 check, refresh_token), with switches to expire, revoke and misbehave.
// Usage: const m = await startMock(projectDir, { requireAuth: true }); … await m.close();
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

function sdk(projectDir, p) {
  return require(path.join(projectDir, 'node_modules/@modelcontextprotocol/sdk/dist/cjs', p));
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const rand = (prefix) => `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startMock(projectDir, opts = {}) {
  const { McpServer } = sdk(projectDir, 'server/mcp.js');
  const { StreamableHTTPServerTransport } = sdk(projectDir, 'server/streamableHttp.js');
  const { isInitializeRequest } = sdk(projectDir, 'types.js');
  const { z } = require(path.join(projectDir, 'node_modules/zod'));

  const state = {
    requireAuth: opts.requireAuth !== false,
    clients: new Map(), // client_id → { redirect_uris }
    codes: new Map(), // code → { client_id, redirect_uri, challenge, used }
    access: new Map(), // access token → { valid }
    refresh: new Map(), // refresh token → { client_id, valid }
    insecure: null, // a field of the metadata to point at http://not-loopback.example
    registrations: 0,
    tokenRequests: [],
    authorizeRequests: 0,
    mcpRequests: 0,
    issued: [], // every secret value handed out (tokens, codes)
  };

  // ---- the authorization server ----
  const as = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const base = `http://127.0.0.1:${asPort}`;
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const meta = {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      };
      if (state.insecure) meta[state.insecure] = `http://not-loopback.example/${state.insecure}`;
      return json(200, meta);
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.registrations++;
      const client_id = rand('client');
      state.clients.set(client_id, { redirect_uris: body.redirect_uris || [] });
      return json(201, { ...body, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (url.pathname === '/authorize') {
      state.authorizeRequests++;
      const q = url.searchParams;
      const client = state.clients.get(q.get('client_id')) || (opts.preRegistered && q.get('client_id') === opts.preRegistered ? { redirect_uris: [q.get('redirect_uri')] } : null);
      if (!client) return json(400, { error: 'invalid_client' });
      if (!client.redirect_uris.includes(q.get('redirect_uri'))) return json(400, { error: 'invalid_request', error_description: 'redirect_uri' });
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(400, { error: 'invalid_request', error_description: 'pkce' });
      const code = rand('code');
      state.issued.push(code);
      state.codes.set(code, { client_id: q.get('client_id'), redirect_uri: q.get('redirect_uri'), challenge: q.get('code_challenge'), used: false });
      const to = new URL(q.get('redirect_uri'));
      to.searchParams.set('code', code);
      if (q.get('state') !== null) to.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: to.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(await readBody(req));
      state.tokenRequests.push(p.get('grant_type'));
      const issue = (client_id) => {
        const access_token = rand('at');
        const refresh_token = rand('rt');
        state.issued.push(access_token, refresh_token);
        state.access.set(access_token, { valid: true });
        state.refresh.set(refresh_token, { client_id, valid: true });
        return json(200, { access_token, refresh_token, token_type: 'Bearer', expires_in: 3600 });
      };
      if (p.get('grant_type') === 'authorization_code') {
        const c = state.codes.get(p.get('code'));
        if (!c || c.used) return json(400, { error: 'invalid_grant' });
        c.used = true;
        if (c.redirect_uri !== p.get('redirect_uri') || c.client_id !== p.get('client_id')) return json(400, { error: 'invalid_grant' });
        const challenge = b64url(crypto.createHash('sha256').update(p.get('code_verifier') || '').digest());
        if (challenge !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return issue(c.client_id);
      }
      if (p.get('grant_type') === 'refresh_token') {
        const r = state.refresh.get(p.get('refresh_token'));
        if (!r || !r.valid) return json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        r.valid = false; // rotation
        return issue(r.client_id);
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    res.writeHead(404).end();
  });
  const asPort = await listen(as);
  const asUrl = `http://127.0.0.1:${asPort}`;

  // ---- the MCP server ----
  let sessions = new Map();
  const makeServer = () => {
    const server = new McpServer({ name: 'mock-remote', version: '0.0.1' }, { instructions: opts.instructions });
    server.registerTool('whoami', { description: 'Says hello', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'hello from remote' }] }));
    server.registerTool('echo', { description: 'Echoes', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
    return server;
  };
  let mcpPort = 0;
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ resource: mcpUrl, authorization_servers: [asUrl] }));
    }
    if (url.pathname !== '/mcp') return res.writeHead(404).end();
    state.mcpRequests++;
    if (state.requireAuth) {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const tok = m && state.access.get(m[1]);
      if (!tok || !tok.valid) {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource/mcp"`, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_token' }));
      }
    }
    const raw = req.method === 'POST' ? await readBody(req) : '';
    const body = raw ? JSON.parse(raw) : undefined;
    const sid = req.headers['mcp-session-id'];
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (sid || !isInitializeRequest(body)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
      }
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: (id) => sessions.set(id, t) });
      await makeServer().connect(t);
      transport = t;
    }
    await transport.handleRequest(req, res, body);
  };
  let mcp = http.createServer(handler);
  mcpPort = await listen(mcp);

  const mock = {
    state,
    asUrl,
    get mcpUrl() {
      return `http://127.0.0.1:${mcpPort}/mcp`;
    },
    /** Every access token stops working (the next request answers 401) */
    expireAccess() {
      for (const t of state.access.values()) t.valid = false;
    },
    /** Every refresh token stops working */
    revokeRefresh() {
      for (const r of state.refresh.values()) r.valid = false;
    },
    /** Drops the MCP server: every connection is cut and the port closes */
    async stopMcp() {
      const old = mcp;
      for (const t of sessions.values()) await t.close().catch(() => undefined);
      sessions = new Map();
      await new Promise((r) => {
        old.close(() => r());
        old.closeAllConnections();
      });
    },
    /** Starts the MCP server again on the same port (fresh sessions) */
    async startMcp() {
      mcp = http.createServer(handler);
      await listen(mcp, mcpPort);
    },
    async close() {
      await mock.stopMcp().catch(() => undefined);
      await new Promise((r) => {
        as.close(() => r());
        as.closeAllConnections();
      });
    },
  };
  return mock;
}

/**
 * The test's stand-in for shell.openExternal: fetches the authorization URL, takes the redirect to the callback and
 * fetches that (optionally with the state changed), as the browser would. Records each URL it was given.
 */
function makeOpener({ tamperState = false } = {}) {
  const opened = [];
  const results = [];
  const open = async (authUrl) => {
    opened.push(authUrl);
    const r = await fetch(authUrl, { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (!loc) {
      results.push({ status: r.status, body: await r.text() });
      return;
    }
    const cb = new URL(loc);
    if (tamperState) cb.searchParams.set('state', 'not-the-state');
    // The browser follows on its own: the opener returns at once, as shell.openExternal does.
    void fetch(cb.href)
      .then(async (x) => results.push({ status: x.status, body: await x.text() }))
      .catch((e) => results.push({ error: String(e) }));
  };
  return { open, opened, results };
}

module.exports = { startMock, makeOpener };
