// A local relay for live tests that have no API key: it signs each request with the `ant` CLI's sign-in
// (https://github.com/anthropics/anthropic-cli) and passes it on to Anthropic's API.
//
// Why a relay: the app sends an API key (x-api-key); a sign-in token goes in an Authorization header with a beta
// header, and the app has no such path. With the relay the app is unchanged and never sees the token:
//
//   app  --x-api-key: <a secret made for this run>-->  127.0.0.1:<port>  --Authorization: Bearer <token>-->  api.anthropic.com
//
// The token is read from `ant auth print-credentials --access-token` (which refreshes it when it is near expiry),
// kept in this process's memory only, and never printed, logged or written. The relay listens on 127.0.0.1, answers
// only requests that carry this run's secret, and forwards only /v1/ paths to api.anthropic.com.
//
//   SILO_HARNESS_LIVE_ANT=1 npm run test:live        (the rig starts the relay; see rig.js)
//
// With SILO_HARNESS_LIVE_ANT_USAGE=<file> each test process adds one line of token counts by model to that file when
// it ends (numbers only, read from the usage the API reports), so a run's spend can be added up afterwards.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const UPSTREAM = 'api.anthropic.com';
const OAUTH_BETA = 'oauth-2025-04-20';
/** Headers that belong to one connection, or that carry the caller's own credentials */
const DROPPED = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length', 'x-api-key', 'authorization']);

function readToken() {
  let out = '';
  try {
    out = execFileSync(process.env.SILO_HARNESS_LIVE_ANT_BIN || 'ant', ['auth', 'print-credentials', '--access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
  } catch {
    throw new Error('The ant CLI gave no token. Sign in with `ant auth login`, or set ANTHROPIC_API_KEY instead.');
  }
  if (!/^[A-Za-z0-9_.-]{20,}$/.test(out)) throw new Error('The ant CLI printed something that is not a token. Run `ant auth status`.');
  return out;
}

/**
 * The headers that go upstream for a request the app made: the app's own, without its credentials, a gateway's
 * headers and what belongs to one connection, plus the sign-in token and the beta header it needs.
 */
function signedHeaders(headers, token, length) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!DROPPED.has(k.toLowerCase()) && !/^x-portkey-/i.test(k)) out[k] = v;
  const betas = String(out['anthropic-beta'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
  out['anthropic-beta'] = betas.join(',');
  out.authorization = `Bearer ${token}`;
  out.host = UPSTREAM;
  // Plain text back, so the usage numbers can be read as the reply passes through
  out['accept-encoding'] = 'identity';
  out['content-length'] = String(length);
  return out;
}

/** One request to the API with the sign-in token; resolves with the upstream response (its body not yet read). */
function forward(method, pathAndQuery, headers, body, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: UPSTREAM, port: 443, method, path: pathAndQuery, headers: signedHeaders(headers, token, body.length) }, resolve);
    req.on('error', reject);
    req.end(body);
  });
}

/** The last number a reply gives for a usage field: a stream repeats the fields, and the last is the final count. */
function lastCount(text, field) {
  const re = new RegExp(`"${field}":\\s*(\\d+)`, 'g');
  let m;
  let n = 0;
  while ((m = re.exec(text))) n = Number(m[1]);
  return n;
}

/** Adds one reply's token counts to the totals for its model (Messages API field names, then the OpenAI ones). */
function tally(totals, model, text) {
  const t = totals[model] || (totals[model] = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  t.requests++;
  t.input += lastCount(text, 'input_tokens') || lastCount(text, 'prompt_tokens');
  t.output += lastCount(text, 'output_tokens') || lastCount(text, 'completion_tokens');
  t.cacheRead += lastCount(text, 'cache_read_input_tokens') || lastCount(text, 'cached_tokens');
  t.cacheWrite += lastCount(text, 'cache_creation_input_tokens');
}

/**
 * Starts the relay. Resolves with { baseURL, key, requests(), usage(), close() }: the address the app talks to (with
 * /v1), the secret it must send as its API key, how many requests went upstream, and the token counts by model.
 */
async function startRelay() {
  let token = readToken();
  const key = `relay-${crypto.randomBytes(24).toString('hex')}`;
  let count = 0;
  const totals = {};
  const usageFile = process.env.SILO_HARNESS_LIVE_ANT_USAGE;
  if (usageFile) {
    process.on('exit', () => {
      if (!count) return;
      try {
        fs.appendFileSync(usageFile, `${JSON.stringify({ script: path.basename(process.argv[1] || ''), requests: count, models: totals })}\n`);
      } catch {
        /* the tally is a convenience */
      }
    });
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => res.destroy());
    req.on('end', async () => {
      const fail = (status, message) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'relay_error', message } }));
      };
      const sent = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (sent !== key) return fail(401, 'This relay answers only the test run that started it.');
      if (!/^\/v1\//.test(req.url || '')) return fail(404, 'The relay forwards /v1/ paths only.');
      const body = Buffer.concat(chunks);
      try {
        count++;
        let up = await forward(req.method, req.url, req.headers, body, token);
        if (up.statusCode === 401) {
          // The token may have run out during a long suite: ask the CLI again (it refreshes) and try once more
          up.resume();
          token = readToken();
          up = await forward(req.method, req.url, req.headers, body, token);
        }
        const headers = { ...up.headers };
        delete headers.connection;
        delete headers['keep-alive'];
        res.writeHead(up.statusCode || 502, headers);
        if (up.statusCode === 200) {
          let model = 'unknown';
          try {
            model = String(JSON.parse(body.toString('utf8')).model || model);
          } catch {
            /* not a JSON request */
          }
          const seen = [];
          up.on('data', (c) => seen.push(c));
          up.on('end', () => tally(totals, model, Buffer.concat(seen).toString('utf8')));
        }
        up.pipe(res);
        res.on('close', () => up.destroy());
      } catch (err) {
        fail(502, `The relay could not reach the API: ${err && err.code ? err.code : 'request failed'}.`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // The relay must not keep a finished test script alive
  server.unref();
  const { port } = server.address();
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    key,
    requests: () => count,
    usage: () => JSON.parse(JSON.stringify(totals)),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The one relay of this process, started on first use. */
let shared = null;
function relay() {
  if (!shared) shared = startRelay();
  return shared;
}

module.exports = { startRelay, relay, signedHeaders, tally };
