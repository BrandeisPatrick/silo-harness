// The live tests' relay for the ant CLI's sign-in (test/live/ant-relay.js), checked without the network and without a
// real sign-in: a stand-in `ant` prints a made-up token, and nothing here sends a request upstream.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./support/check.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-ant-relay-'));
const TOKEN = 'made-up-token-0123456789abcdef';
const standIn = (name, script) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
};
process.env.SILO_HARNESS_LIVE_ANT_BIN = standIn('ant', `echo ${TOKEN}`);
const { startRelay, signedHeaders, tally } = require('./live/ant-relay.js');

(async () => {
  // What goes upstream: the app's headers without its credentials, with the token and the beta header
  const h = signedHeaders(
    { host: '127.0.0.1:1234', 'x-api-key': 'relay-secret', authorization: 'Bearer relay-secret', 'x-portkey-api-key': 'relay-secret', 'X-Portkey-Provider': 'anthropic', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'some-beta-2026-01-01', 'content-type': 'application/json', connection: 'keep-alive', 'content-length': '999', 'accept-encoding': 'gzip' },
    TOKEN,
    42,
  );
  check('headers: the token goes in Authorization', h.authorization === `Bearer ${TOKEN}`, Object.keys(h));
  check('headers: the app\'s own key and the gateway\'s headers are left out', !('x-api-key' in h) && !Object.keys(h).some((k) => /^x-portkey-/i.test(k)) && !JSON.stringify(h).includes('relay-secret'), Object.keys(h));
  check('headers: the sign-in beta is added to the ones the app asked for', h['anthropic-beta'] === 'some-beta-2026-01-01,oauth-2025-04-20', h['anthropic-beta']);
  check('headers: the sign-in beta is not added twice', signedHeaders({ 'anthropic-beta': 'oauth-2025-04-20' }, TOKEN, 0)['anthropic-beta'] === 'oauth-2025-04-20');
  check('headers: with no beta asked for, only the sign-in one', signedHeaders({}, TOKEN, 0)['anthropic-beta'] === 'oauth-2025-04-20');
  check('headers: the host, the length and a plain reply', h.host === 'api.anthropic.com' && h['content-length'] === '42' && h['accept-encoding'] === 'identity' && !('connection' in h), h);
  check('headers: the rest passes through', h['anthropic-version'] === '2023-06-01' && h['content-type'] === 'application/json');

  // The relay answers only the run that started it, and only /v1/ paths; neither refusal goes upstream
  const relay = await startRelay();
  const other = await startRelay();
  check('relay: on this machine only, with /v1', /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(relay.baseURL), relay.baseURL);
  check('relay: a secret made for each run', /^relay-[0-9a-f]{48}$/.test(relay.key) && relay.key !== other.key && !relay.key.includes(TOKEN));
  const post = (base, urlPath, key) => fetch(base.replace(/\/v1$/, '') + urlPath, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body: '{}' });
  let res = await post(relay.baseURL, '/v1/messages', 'wrong');
  let text = await res.text();
  check('relay: a wrong secret is refused', res.status === 401 && /only the test run that started it/.test(text) && !text.includes(TOKEN), text);
  res = await post(relay.baseURL, '/v1/messages', '');
  check('relay: no secret is refused', res.status === 401);
  res = await post(relay.baseURL, '/v1/messages', other.key);
  check('relay: another run\'s secret is refused', res.status === 401);
  res = await post(relay.baseURL, '/other/path', relay.key);
  text = await res.text();
  check('relay: a path outside /v1/ is refused', res.status === 404 && !text.includes(TOKEN), text);
  check('relay: nothing went upstream', relay.requests() === 0 && other.requests() === 0, [relay.requests(), other.requests()]);
  await relay.close();
  await other.close();

  // The token tally reads numbers only, from a whole reply, a stream, and the OpenAI format
  const totals = {};
  tally(totals, 'm', JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 18, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 4 } }));
  check('tally: a whole reply', JSON.stringify(totals.m) === JSON.stringify({ requests: 1, input: 18, output: 4, cacheRead: 100, cacheWrite: 5 }), totals.m);
  const stream = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 1 } } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'the reply says "input_tokens": 999999 in its own words' } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 31 } })}`,
  ].join('\n\n');
  tally(totals, 'm', stream);
  check('tally: a stream counts its last numbers, and not what the reply text says', JSON.stringify(totals.m) === JSON.stringify({ requests: 2, input: 25, output: 35, cacheRead: 2100, cacheWrite: 5 }), totals.m);
  tally(totals, 'other', JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 50, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 40 } } }));
  check('tally: the OpenAI format, by model', JSON.stringify(totals.other) === JSON.stringify({ requests: 1, input: 50, output: 6, cacheRead: 40, cacheWrite: 0 }), totals.other);

  // A CLI that is not signed in, or prints something else, stops the run with a plain message
  process.env.SILO_HARNESS_LIVE_ANT_BIN = standIn('ant-out', 'echo "not signed in" >&2; exit 1');
  let failed = await startRelay().then(() => null, (e) => e);
  check('sign-in: a CLI that fails is reported', failed instanceof Error && /ant auth login/.test(failed.message), failed && failed.message);
  process.env.SILO_HARNESS_LIVE_ANT_BIN = standIn('ant-odd', 'echo "{ not a token }"');
  failed = await startRelay().then(() => null, (e) => e);
  check('sign-in: output that is not a token is reported, and not repeated', failed instanceof Error && /not a token/.test(failed.message) && !failed.message.includes('{ not a token }'), failed && failed.message);
  process.env.SILO_HARNESS_LIVE_ANT_BIN = path.join(dir, 'missing');
  failed = await startRelay().then(() => null, (e) => e);
  check('sign-in: a missing CLI is reported', failed instanceof Error && /ant auth login/.test(failed.message), failed && failed.message);

  fs.rmSync(dir, { recursive: true, force: true });
  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
