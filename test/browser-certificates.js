// Certificate errors in the Browser pane, headless (src/main/browser/certificates.ts): the codes in words for the
// interstitial, the sentence the agent reads, the pairs the user proceeded past (host and fingerprint, for one run)
// and the mark the URL pill shows. The interstitial in the real app: test/live/browser-cert.js.
// Run: npm run build && node test/browser-certificates.js
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const certs = require(path.join(projectDir, 'dist/main/browser/certificates.js'));
const { check, done } = require('./support/check.js');

const { certErrorWords: words, certificateSentence, createProceedSet, pageSecurity, certErrorState, hostOf } = certs;

// ---------- 1. Words ----------
check('an authority this Mac does not trust', words('net::ERR_CERT_AUTHORITY_INVALID') === 'Its certificate is not issued by an authority this Mac trusts');
check('expired or not valid yet', words('net::ERR_CERT_DATE_INVALID') === 'Its certificate has expired or is not valid yet');
check('for a different site', words('net::ERR_CERT_COMMON_NAME_INVALID') === 'Its certificate is for a different site');
check('revoked', words('net::ERR_CERT_REVOKED') === 'Its certificate was revoked');
check('the code without its net:: prefix reads the same', words('ERR_CERT_DATE_INVALID') === words('net::ERR_CERT_DATE_INVALID'));
check('any other code is shown as it is', words('net::ERR_CERT_WEAK_KEY') === 'net::ERR_CERT_WEAK_KEY' && words('') === 'Its certificate is not valid');
check('what the agent reads', certificateSentence({ host: 'localhost', code: 'net::ERR_CERT_AUTHORITY_INVALID' }) === 'The certificate for localhost is not valid (net::ERR_CERT_AUTHORITY_INVALID). Only the user can proceed.');
const st = certErrorState('https://self-signed.example:8443/page?q=1', 'net::ERR_CERT_AUTHORITY_INVALID', 'sha256/AAA=');
check("the tab's record: host without the port, code, fingerprint, the page and the words", st.host === 'self-signed.example' && st.code === 'net::ERR_CERT_AUTHORITY_INVALID' && st.fingerprint === 'sha256/AAA=' && st.url === 'https://self-signed.example:8443/page?q=1' && st.reason === words(st.code), st);
check('the host of a URL', hostOf('https://LocalHost:9/x') === 'localhost' && hostOf('nonsense') === '');

// ---------- 2. Proceed: host and fingerprint, for this run ----------
const set = createProceedSet();
check('nothing proceeded at first', !set.has('localhost', 'sha256/AAA=') && !set.hasHost('localhost') && set.size === 0);
set.add('localhost', 'sha256/AAA=');
check('the pair the user proceeded past passes', set.has('localhost', 'sha256/AAA=') && set.has('LOCALHOST', 'sha256/AAA='));
check('the same host with another certificate does not', !set.has('localhost', 'sha256/BBB='));
check('another host with the same certificate does not', !set.has('127.0.0.1', 'sha256/AAA='));
set.add('localhost', 'sha256/AAA=');
check('adding a pair twice keeps one', set.size === 1);
check('the host is marked for the pill', set.hasHost('localhost') && !set.hasHost('example.com'));
const fresh = createProceedSet();
check('a new run (a new set) asks again', !fresh.has('localhost', 'sha256/AAA=') && !fresh.hasHost('localhost'));
check("the app's set starts empty", certs.proceeded.size === 0);

// ---------- 3. The URL pill ----------
check('https: a lock', pageSecurity('https://example.com/', set) === 'secure');
check('http: Not secure', pageSecurity('http://example.com/', set) === 'insecure' && pageSecurity('http://127.0.0.1:8080/', set) === 'insecure');
check('https on a host proceeded past: the amber triangle', pageSecurity('https://localhost:8443/landing.html', set) === 'proceeded');
check('a blank tab, a file, an artifact: the globe', ['about:blank', 'file:///Users/a/x.html', 'artifact://view/s/a', '', 'nonsense'].every((u) => pageSecurity(u, set) === 'none'));

done();
