// web_fetch's network side, headless (src/main/web/address.ts, fetch.ts): the address table (every refused range and
// the odd literal forms), names that resolve inside the network, redirects (checked per hop, another site handed
// back, rebinding pinned), the size cap, the timeout, stopping, content types, charsets and compression. Mock servers
// on 127.0.0.1 are reached under made-up public names through the fetcher's test hooks; no live network.
// Run: npm run build && node test/web-fetch.js
const path = require('node:path');
const zlib = require('node:zlib');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { blockedReason, registrableDomain, isLocalName } = dist('web/address.js');
const { checkUrl, fetchUrl, resolvePublic, BlockedError, TimeoutError, StoppedError, HttpError, userAgent } = dist('web/fetch.js');
const { startWebServer, hooksFor } = require('./support/web-server.js');
const { check, done } = require('./support/check.js');

const refusedBy = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};
const rejects = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};

(async () => {
  // ---------- The address table ----------
  const blocked = {
    '127.0.0.1': 'loopback', '127.255.0.9': 'loopback', '10.0.0.1': 'private', '10.255.255.255': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private',
    '192.168.1.1': 'private', '169.254.169.254': 'link-local', '169.254.0.1': 'link-local', '100.64.0.1': 'shared (CGNAT)', '100.127.255.254': 'shared (CGNAT)',
    '0.0.0.0': 'unspecified', '0.1.2.3': 'unspecified', '224.0.0.1': 'multicast', '239.255.255.250': 'multicast', '255.255.255.255': 'reserved', '240.0.0.1': 'reserved',
    '192.0.2.5': 'reserved', '198.18.0.1': 'reserved',
    '::1': 'loopback', '::': 'unspecified', 'fe80::1': 'link-local', 'febf::1': 'link-local', 'fc00::1': 'unique-local', 'fd12:3456::1': 'unique-local', 'ff02::1': 'multicast',
    '::ffff:127.0.0.1': 'loopback (IPv4 in IPv6)', '::ffff:7f00:1': 'loopback (IPv4 in IPv6)', '::ffff:10.1.2.3': 'private (IPv4 in IPv6)', '::ffff:169.254.169.254': 'link-local (IPv4 in IPv6)',
    '::127.0.0.1': 'loopback (IPv4 in IPv6)', '::a00:1': 'private (IPv4 in IPv6)', '::ffff:0:192.168.0.1': 'private (IPv4 in IPv6)',
    '64:ff9b::a00:1': 'private (NAT64)', '64:ff9b::7f00:1': 'loopback (NAT64)', '2002:a00:1::': 'private (6to4)', '2002:7f00:1::1': 'loopback (6to4)', '2001::1': 'reserved (Teredo)',
    '2001:db8::1': 'documentation', '100::1': 'discard', '::2': 'unspecified (IPv4 in IPv6)',
  };
  const wrong = Object.entries(blocked).filter(([a, why]) => blockedReason(a) !== why).map(([a, why]) => `${a}: ${blockedReason(a)} (want ${why})`);
  check(`every refused range and form says why (${Object.keys(blocked).length} addresses)`, wrong.length === 0, wrong);
  const open = ['93.184.215.14', '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.255.255', '11.0.0.1', '2606:2800:220:1:248:1893:25c8:1946', '2a00:1450:4001::200e', '::ffff:93.184.215.14', '64:ff9b::808:808', '2002:808:808::1'];
  const notOpen = open.filter((a) => blockedReason(a) !== null);
  check('public addresses (also just outside each range, and public IPv4 inside IPv6) pass', notOpen.length === 0, notOpen.map((a) => `${a}: ${blockedReason(a)}`));

  // Literal forms the URL parser turns into dotted addresses, and names that are local by their look
  const literals = [
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://017700000001/', 'http://127.1/', 'http://127.0.1/',
    'http://10.1/', 'http://0xa.1/', 'http://3232235777/', 'http://0xA9FEA9FE/', 'http://169.254.43518/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/',
    'http://[fe80::1%25en0]/', 'http://[::]/', 'http://0/', 'http://0.0.0.0:8080/', 'https://localhost/', 'http://LOCALHOST./', 'http://app.localhost/', 'http://printer.local/',
    'http://metadata.google.internal/', 'http://router/', 'http://nas.home.arpa/',
  ];
  const passed = literals.filter((u) => !(refusedBy(() => checkUrl(u)) instanceof BlockedError));
  check(`odd literal forms and local names are refused before anything is resolved (${literals.length})`, passed.length === 0, passed);
  const msg = refusedBy(() => checkUrl('http://169.254.169.254/latest/meta-data/'))?.message ?? '';
  check('the refusal names the kind of address and the way round (the browser)', /169\.254\.169\.254 is a link-local address/.test(msg) && /use the browser/.test(msg), msg);
  const schemes = ['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'gopher://example.com/'];
  check('only http and https', schemes.every((u) => refusedBy(() => checkUrl(u)) instanceof BlockedError));
  const cred = refusedBy(() => checkUrl('https://user:pass@example.com/'));
  check('a URL with a user name or password is refused', cred instanceof BlockedError && /user name or password/.test(cred.message), cred?.message);
  check('a normal public URL passes', checkUrl('https://example.com/a?b=1').hostname === 'example.com');
  check('local names by their look', isLocalName('localhost') && isLocalName('x.local') && isLocalName('intranet') && !isLocalName('example.com') && !isLocalName('93.184.215.14'));
  check('registrable domains: subdomains share one, multi-part suffixes and hosting suffixes keep their own', registrableDomain('www.example.com') === 'example.com' && registrableDomain('a.b.example.co.uk') === 'example.co.uk' && registrableDomain('me.github.io') === 'me.github.io' && registrableDomain('example.com') === 'example.com' && registrableDomain('93.184.215.14') === '93.184.215.14');

  // ---------- Names that resolve inside the network ----------
  const priv = await rejects(resolvePublic('evil.example', { resolve: async () => ['10.0.0.5'] }));
  check('a name that resolves to a private address is refused', priv instanceof BlockedError && /evil\.example resolves to a private address \(10\.0\.0\.5\)/.test(priv.message), priv?.message);
  const mixed = await rejects(resolvePublic('mixed.example', { resolve: async () => ['93.184.215.14', '127.0.0.1'] }));
  check('one private answer among public ones refuses the name', mixed instanceof BlockedError && /loopback/.test(mixed.message), mixed?.message);
  const v6 = await rejects(resolvePublic('six.example', { resolve: async () => ['::ffff:192.168.0.10'] }));
  check('…also as an IPv4-mapped IPv6 answer', v6 instanceof BlockedError, v6?.message);

  // ---------- Against a mock server ----------
  const big = 'x'.repeat(5000);
  let slowRes = null;
  const srv = await startWebServer({
    '/page': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>Hi</title></head><body><p>Hello from ${req.headers['user-agent']} cookie=${req.headers.cookie ?? 'none'} auth=${req.headers.authorization ?? 'none'}</p></body></html>`);
    },
    '/same-site': (req, res) => {
      res.writeHead(302, { location: `http://www.site.example:${srv.port}/landing` });
      res.end();
    },
    '/landing': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('landed');
    },
    '/cross-site': (req, res) => {
      res.writeHead(301, { location: 'https://other.example/elsewhere?x=1' });
      res.end();
    },
    '/to-private-name': (req, res) => {
      res.writeHead(302, { location: `http://inner.site.example:${srv.port}/landing` });
      res.end();
    },
    '/to-literal': (req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${srv.port}/landing` });
      res.end();
    },
    '/to-file': (req, res) => {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
    },
    '/loop': (req, res) => {
      res.writeHead(302, { location: '/loop' });
      res.end();
    },
    '/big': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(big);
    },
    '/slow': (req, res) => {
      slowRes = res; // never answers
    },
    '/png': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '2048' });
      res.end(Buffer.alloc(2048));
    },
    '/json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a":1}');
    },
    '/xhtml': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/xhtml+xml' });
      res.end('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>x</p></body></html>');
    },
    '/latin1': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=ISO-8859-1' });
      res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    },
    '/meta-charset': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head><body>'), Buffer.from([0x93, 0x71, 0x94, 0x20, 0x80]), Buffer.from('</body></html>')]));
    },
    '/sjis': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=shift_jis' });
      res.end(Buffer.from([0x82, 0xa0])); // あ
    },
    '/gzip': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('squeezed'));
    },
    '/gzip-bomb': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(Buffer.alloc(200_000, 0x61)));
    },
    '/404': (req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    },
  });
  const site = 'site.example';
  const { hooks, calls } = hooksFor({ 'site.example': ['127.0.0.1'], 'www.site.example': ['127.0.0.1'], 'inner.site.example': ['10.0.0.7'] });

  const page = await fetchUrl(srv.url(site, '/page'), { hooks });
  check('a page is fetched (https tried first, http when it cannot connect)', page.kind === 'text' && /Hello from/.test(page.text) && page.url === srv.url(site, '/page'), page);
  check('User-Agent is SiloHarness/<version>; no cookie, no auth header', new RegExp(`Hello from ${userAgent().replace(/[.]/g, '\\.')} cookie=none auth=none`).test(page.text) && /^SiloHarness\/\d+\.\d+/.test(userAgent()), page.text);

  // Redirects
  let hopAsked = [];
  const same = await fetchUrl(srv.url(site, '/same-site'), { hooks, beforeHop: async (u) => (hopAsked.push(u), null) });
  check('a redirect within the site is followed, and its new host is asked about first', same.kind === 'text' && same.text === 'landed' && same.url === srv.url('www.site.example', '/landing') && hopAsked.length === 1 && hopAsked[0] === srv.url('www.site.example', '/landing'), { same, hopAsked });
  const refusedHop = await rejects(fetchUrl(srv.url(site, '/same-site'), { hooks, beforeHop: async () => 'Not permitted: denied.' }));
  check('…and stops there when that host is not approved', refusedHop instanceof BlockedError && refusedHop.message === 'Not permitted: denied.', refusedHop?.message);
  const cross = await fetchUrl(srv.url(site, '/cross-site'), { hooks });
  check('a redirect to another site is not followed: it is handed back', cross.kind === 'redirect' && cross.to === 'https://other.example/elsewhere?x=1' && !calls.includes('other.example'), cross);
  const toPrivate = await rejects(fetchUrl(srv.url(site, '/to-private-name'), { hooks }));
  check('a public page that redirects to a name inside the network is refused at that hop', toPrivate instanceof BlockedError && /inner\.site\.example resolves to a private address/.test(toPrivate.message), toPrivate?.message);
  const toLiteral = await fetchUrl(srv.url(site, '/to-literal'), { hooks });
  check('a redirect to a literal address is another site: handed back (and refused when called)', toLiteral.kind === 'redirect' && refusedBy(() => checkUrl(toLiteral.to)) instanceof BlockedError, toLiteral);
  const toFile = await rejects(fetchUrl(srv.url(site, '/to-file'), { hooks }));
  check('a redirect to file: is refused', toFile instanceof BlockedError && /file:/.test(toFile.message), toFile?.message);
  const loop = await rejects(fetchUrl(srv.url(site, '/loop'), { hooks }));
  check('at most 5 redirects', loop && /Too many redirects/.test(loop.message) && srv.hits['/loop'] >= 6 && srv.hits['/loop'] <= 7, { msg: loop?.message, hits: srv.hits['/loop'] });

  // Rebinding: the first answer is checked and the connection pinned to it; a later answer cannot move it
  let n = 0;
  const rebind = hooksFor({ 'rebind.example': () => (n++ === 0 ? ['127.0.0.1'] : ['10.0.0.9']) });
  const pinned = await fetchUrl(srv.url('rebind.example', '/page'), { hooks: rebind.hooks });
  check('rebinding: one lookup per hop, checked, and both the https try and http connect to that address', pinned.kind === 'text' && rebind.calls.length === 1, { kind: pinned.kind, lookups: rebind.calls.length });
  const second = await rejects(fetchUrl(srv.url('rebind.example', '/page'), { hooks: rebind.hooks }));
  check('…and the next call, which now resolves privately, is refused', second instanceof BlockedError && /10\.0\.0\.9/.test(second.message), second?.message);

  // Limits
  const capped = await fetchUrl(srv.url(site, '/big'), { hooks: { ...hooks, maxBytes: 1000 } });
  check('the body stops at the cap and says it was cut', capped.kind === 'text' && capped.text.length === 1000 && capped.truncated === true, { len: capped.text?.length, truncated: capped.truncated });
  const whole = await fetchUrl(srv.url(site, '/big'), { hooks });
  check('under the cap the body is whole', whole.text.length === 5000 && !whole.truncated);
  const bomb = await fetchUrl(srv.url(site, '/gzip-bomb'), { hooks: { ...hooks, maxBytes: 10_000 } });
  check('the cap counts decompressed bytes', bomb.text.length === 10_000 && bomb.truncated, bomb.text.length);
  let t0 = Date.now();
  const slow = await rejects(fetchUrl(srv.url(site, '/slow'), { hooks: { ...hooks, timeoutMs: 400 } }));
  check('a page that never answers times out', slow instanceof TimeoutError && /Timed out/.test(slow.message) && Date.now() - t0 < 3000, { msg: slow?.message, ms: Date.now() - t0 });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  t0 = Date.now();
  const stopped = await rejects(fetchUrl(srv.url(site, '/slow'), { hooks, signal: ctl.signal }));
  check('stopping the run aborts the request', stopped instanceof StoppedError && Date.now() - t0 < 3000, { name: stopped?.constructor?.name, msg: stopped?.message });
  const pre = new AbortController();
  pre.abort();
  const already = await rejects(fetchUrl(srv.url(site, '/page'), { hooks, signal: pre.signal }));
  check('…also when it was stopped before it began', already instanceof StoppedError, already?.message);
  slowRes?.destroy();

  // Types, charsets, compression, errors
  const png = await fetchUrl(srv.url(site, '/png'), { hooks });
  check('a binary type is reported by type and size, its body not read', png.kind === 'binary' && png.mime === 'image/png' && png.size === 2048, png);
  const json = await fetchUrl(srv.url(site, '/json'), { hooks });
  const xhtml = await fetchUrl(srv.url(site, '/xhtml'), { hooks });
  check('JSON and XHTML are text', json.kind === 'text' && json.mime === 'application/json' && xhtml.kind === 'text');
  const latin = await fetchUrl(srv.url(site, '/latin1'), { hooks });
  const meta = await fetchUrl(srv.url(site, '/meta-charset'), { hooks });
  const sjis = await fetchUrl(srv.url(site, '/sjis'), { hooks });
  check('the charset is honoured: header, <meta>, and a multibyte one', latin.text === 'café' && /“q” €/.test(meta.text) && sjis.text === 'あ', [latin.text, meta.text, sjis.text]);
  const gz = await fetchUrl(srv.url(site, '/gzip'), { hooks });
  check('gzip is decompressed', gz.text === 'squeezed', gz.text);
  const nf = await rejects(fetchUrl(srv.url(site, '/404'), { hooks }));
  check('an error status is an HttpError', nf instanceof HttpError && nf.status === 404, nf?.message);
  const nodns = await rejects(fetchUrl(srv.url('nowhere.example', '/'), { hooks }));
  check('a name that does not resolve says so', nodns && /not found/.test(nodns.message), nodns?.message);

  // Without the hooks, the mock server is out of reach whatever the URL says
  const before = srv.hits['/page'];
  const direct = await rejects(fetchUrl(`http://127.0.0.1:${srv.port}/page`));
  check('without the test hooks 127.0.0.1 is refused (no exemption list)', direct instanceof BlockedError, direct?.message);
  check('…and nothing reached the server', srv.hits['/page'] === before, { before, after: srv.hits['/page'] });

  await srv.close();
  done();
})().catch((e) => {
  console.log('FAIL CRASH', e);
  process.exit(1);
});
