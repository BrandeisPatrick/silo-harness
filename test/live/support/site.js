// A small fixture site the browser's live checks share: pages for a sign-in form, popups (window.open with a size,
// postMessage back to the opener, a target="_blank" link), a redirect to a second port that stands in for another
// site, a download with Content-Disposition, a camera request, and the same pages over HTTPS on a self-signed
// certificate for localhost and 127.0.0.1 (test/live/fixtures/site-cert.pem, valid 100 years).
//
//   const { startSite, httpsServer } = require('./support/site.js');
//   const site = await startSite();      // site.base, site.other (the second port), site.close()
//   const tls = await httpsServer();     // tls.base (https://localhost:<port>), tls.close()
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** The pages, by path. `other` is the second server's base, for the redirect. */
function pages(other) {
  return {
    '/login.html': page(
      'Sign in',
      `<h1>Sign in</h1>
<form onsubmit="return false">
  <p><label>Email <input id="email" name="email" type="email" autocomplete="username"></label></p>
  <p><label>Password <input id="pw" name="password" type="password" autocomplete="current-password"></label></p>
  <p><input id="bare" type="password"> <input id="user" type="text"></p>
  <p><label>Code from the app <input id="otp" name="otp" inputmode="numeric"></label></p>
  <p><button type="button" id="show" onclick="const f = document.getElementById('pw'); f.type = f.type === 'password' ? 'text' : 'password'">Show password</button>
  <button type="submit">Sign in</button></p>
</form>`,
    ),
    '/popup.html': page(
      'Popup opener',
      `<h1>Popup opener</h1>
<script>
  window.__msgs = [];
  addEventListener('message', (e) => { window.__msgs.push(e.data); });
  function openPopup(features) { window.__popup = window.open('/popup-child.html', 'oauth', features || 'width=420,height=560'); return window.__popup ? 'opened' : 'null'; }
  function openStay(n) { return window.open('/popup-stay.html?n=' + n, 'stay' + n, 'width=360,height=300') ? 'opened' : 'null'; }
</script>
<p><button id="open" type="button" onclick="openPopup()">Sign in with Example</button></p>
<p><a id="blank" href="/landing.html" target="_blank">Open the landing page in a new tab</a></p>
<p><a id="plain" href="/landing.html">The landing page</a></p>`,
    ),
    '/popup-child.html': page(
      'Example sign-in',
      `<h1>Example sign-in</h1>
<script>
  document.cookie = 'site_popup=1; path=/';
  const info = { hasOpener: Boolean(window.opener), innerWidth, innerHeight };
  if (window.opener) window.opener.postMessage({ type: 'oauth-done', token: 'fixture-token', ...info }, '*');
  setTimeout(() => window.close(), 400);
</script>`,
    ),
    '/popup-stay.html': page('Stays open', '<h1>A popup that stays open</h1>'),
    '/landing.html': page('Landing', '<h1>Landing</h1><p>You made it.</p>'),
    '/redirect.html': { status: 302, location: `${other}/other.html` },
    '/other.html': page('Another site', '<h1>Another site</h1>'),
    '/download.html': page('Download', '<h1>Download</h1><p><a id="file" href="/report.txt">report.txt</a></p>'),
    '/report.txt': { body: 'A small report.\n', headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' } },
    '/camera.html': page(
      'Camera',
      `<h1>Camera test</h1>
<script>function requestCamera() { return navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(() => 'granted', (e) => e.name); }</script>
<p><button id="cam" type="button" onclick="requestCamera()">Use the camera</button></p>`,
    ),
  };
}

function handler(getOther) {
  return (req, res) => {
    const url = req.url.split('?')[0];
    const all = pages(getOther());
    const entry = all[url] ?? (url === '/' ? all['/landing.html'] : undefined);
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    if (typeof entry === 'string') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(entry);
    }
    if (entry.status === 302) {
      res.writeHead(302, { location: entry.location });
      return res.end();
    }
    res.writeHead(200, entry.headers);
    res.end(entry.body);
  };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));

/** The site on two ports: `base` (the pages) and `other` (the same pages, standing in for another site). */
async function startSite() {
  let otherBase = '';
  const other = http.createServer(handler(() => otherBase));
  await listen(other);
  otherBase = `http://127.0.0.1:${other.address().port}`;
  const main = http.createServer(handler(() => otherBase));
  await listen(main);
  const base = `http://127.0.0.1:${main.address().port}`;
  return {
    base,
    other: otherBase,
    host: `127.0.0.1:${main.address().port}`,
    close: () => {
      main.close();
      other.close();
    },
  };
}

/** The same pages over HTTPS on the committed self-signed certificate (the browser must not trust it). */
async function httpsServer() {
  const server = https.createServer(
    { key: fs.readFileSync(path.join(FIXTURES, 'site-key.pem')), cert: fs.readFileSync(path.join(FIXTURES, 'site-cert.pem')) },
    handler(() => ''),
  );
  await listen(server);
  return { base: `https://localhost:${server.address().port}`, ip: `https://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

module.exports = { startSite, httpsServer, pages };
