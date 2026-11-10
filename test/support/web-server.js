// A mock web server on 127.0.0.1 for the web tool suites: routes by path, counts hits, and the NetHooks that let the
// fetcher reach it under made-up public names (the hooks are a test seam only, never reachable from the tools).
const http = require('node:http');

/**
 * routes: { '/path': (req, res) => void } ; an unknown path is a 404. Returns { port, url(host, path), hits, close }.
 */
async function startWebServer(routes) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits[p] = (hits[p] || 0) + 1;
    const route = routes[p];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    route(req, res);
  });
  // A TLS hello sent to this plain server is answered with a 400 and closed: the fetcher's https attempt fails to
  // connect and it falls back to http, as it does for a real http-only site.
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    url: (host, p = '/') => `http://${host}:${port}${p}`,
    hits,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

/**
 * Hooks for the fetcher: `names` maps made-up host names to the addresses they "resolve" to; 127.0.0.1 counts as a
 * public address (it is the mock server), nothing else that the checks refuse does.
 */
function hooksFor(names, extra = {}) {
  const calls = [];
  return {
    calls,
    hooks: {
      resolve: async (host) => {
        calls.push(host);
        const v = names[host];
        if (typeof v === 'function') return v();
        if (!v) throw new Error(`${host} was not found (DNS).`);
        return v;
      },
      allowAddress: (address) => address === '127.0.0.1',
      ...extra,
    },
  };
}

module.exports = { startWebServer, hooksFor };
