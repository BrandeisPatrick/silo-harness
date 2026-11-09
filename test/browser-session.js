// The browser's own profile, headless: how a cookie of the default session is set again in the browser's jar
// (cookieToSet), the one-time migration over two stand-in sessions, the marker file and the note it leaves due,
// what "Keep cookies: off" clears, and the user-agent rule. The session itself is Electron's; the live scripts
// run against it.
// Run: npm run build && node test/browser-session.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const ses = require(path.join(projectDir, 'dist/main/browser/session.js'));
const { check, done } = require('./support/check.js');

const { cookieToSet, migrateCookies, migrateProfileOnce, readProfileMarker, profileMarkerPath, profileNoteDue, dismissProfileNote, clearPrivateData, PRIVATE_STORAGES, cleanUserAgent, BROWSER_PARTITION } = ses;

/** A stand-in for the two sessions' cookie jars and storage. */
function fakeSession(cookies = [], opts = {}) {
  const s = {
    jar: cookies.map((c) => ({ ...c })),
    sets: [],
    cleared: [],
    cookies: {
      async get(filter) {
        if (opts.getFails) throw new Error('no jar');
        s.lastFilter = filter;
        return s.jar.map((c) => ({ ...c }));
      },
      async set(details) {
        if (opts.rejectNamed && details.name === opts.rejectNamed) throw new Error(`cannot set ${details.name}`);
        s.sets.push(details);
      },
    },
    async clearStorageData(o) {
      s.cleared.push(o);
    },
  };
  return s;
}

(async () => {
  // ---------- 1. One cookie, set again ----------
  const base = { name: 'sid', value: 'abc123', domain: 'example.com', path: '/', secure: true, httpOnly: true, hostOnly: true, session: false, expirationDate: 1900000000.5, sameSite: 'lax' };
  let d = cookieToSet(base);
  check('1: a secure host-only cookie: an https url of its host and path, no domain, the flags and the expiry carried', d.url === 'https://example.com/' && d.domain === undefined && d.name === 'sid' && d.value === 'abc123' && d.path === '/' && d.secure === true && d.httpOnly === true && d.expirationDate === 1900000000.5 && d.sameSite === 'lax', d);
  d = cookieToSet({ ...base, domain: '.example.com', hostOnly: false, secure: false, httpOnly: false, path: '/app' });
  check('1: a domain cookie: the leading dot stripped, the domain set, an http url with its path', d.url === 'http://example.com/app' && d.domain === 'example.com' && d.secure === false && d.httpOnly === false && d.path === '/app', d);
  d = cookieToSet({ name: 's', value: 'v', domain: 'a.example.org', hostOnly: false, session: true, sameSite: 'unspecified' });
  check('1: a session cookie has no expirationDate; a domain without a dot is kept; unspecified sameSite passes through', !('expirationDate' in d) && d.domain === 'a.example.org' && d.sameSite === 'unspecified' && d.path === '/', d);
  d = cookieToSet({ name: 's', value: 'v', domain: '.example.net', path: '', sameSite: 'strict', hostOnly: false, expirationDate: Number.NaN });
  check('1: an empty path reads /, a NaN expiry is left out, strict sameSite carried', d.path === '/' && d.url === 'http://example.net/' && !('expirationDate' in d) && d.sameSite === 'strict', d);
  d = cookieToSet({ name: 'n', value: 'v', domain: 'localhost', hostOnly: true, path: '/', sameSite: 'no_restriction', secure: true });
  check('1: a host-only localhost cookie', d.url === 'https://localhost/' && d.domain === undefined && d.sameSite === 'no_restriction', d);

  // ---------- 2. The migration over stand-in sessions ----------
  const from = fakeSession([base, { ...base, name: 'bad' }, { name: 'theme', value: 'dark', domain: '.example.com', hostOnly: false, path: '/', sameSite: 'unspecified', session: true }]);
  const to = fakeSession([], { rejectNamed: 'bad' });
  let r = await migrateCookies(from, to);
  check('2: every cookie is read with an empty filter and set one by one; a failure is counted and skipped', r.copied === 2 && r.failed === 1 && to.sets.length === 2 && to.sets.map((s) => s.name).join() === 'sid,theme' && JSON.stringify(from.lastFilter) === '{}', r);
  check('2: the old jar is cleared, cookies only', from.cleared.length === 1 && JSON.stringify(from.cleared[0]) === JSON.stringify({ storages: ['cookies'] }), from.cleared);
  const broken = fakeSession([], { getFails: true });
  const warn = console.warn;
  console.warn = () => undefined; // the warning about the unreadable jar is the point here
  r = await migrateCookies(broken, fakeSession());
  console.warn = warn;
  check('2: a jar that cannot be read copies nothing and clears nothing', r.copied === 0 && r.failed === 0 && broken.cleared.length === 0, r);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-browser-session-'));
  check('2: before the first run there is no marker and no note', readProfileMarker(tmp) === null && profileNoteDue(tmp) === false);
  const from2 = fakeSession([base]);
  const marker = await migrateProfileOnce(tmp, from2, fakeSession());
  check('2: the first run migrates and writes the marker', marker && marker.migrated === true && marker.copied === 1 && marker.failed === 0 && /^\d{4}-\d{2}-\d{2}T/.test(marker.at) && marker.noteDue === true, marker);
  check('2: … to userData/browser/profile.json', fs.existsSync(profileMarkerPath(tmp)) && profileMarkerPath(tmp) === path.join(tmp, 'browser', 'profile.json') && readProfileMarker(tmp).copied === 1);
  check('2: … and the note is due', profileNoteDue(tmp) === true);
  const again = fakeSession([base, base]);
  check('2: a second run does nothing', (await migrateProfileOnce(tmp, again, fakeSession())) === null && again.cleared.length === 0 && readProfileMarker(tmp).copied === 1);
  dismissProfileNote(tmp);
  check('2: dismissing the note is remembered, the rest of the marker kept', profileNoteDue(tmp) === false && readProfileMarker(tmp).migrated === true && readProfileMarker(tmp).copied === 1);
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-browser-session-'));
  const empty = await migrateProfileOnce(tmp2, fakeSession([]), fakeSession());
  check('2: a fresh install (no cookies) is marked migrated with no note to show', empty && empty.copied === 0 && empty.noteDue === false && profileNoteDue(tmp2) === false, empty);
  fs.writeFileSync(profileMarkerPath(tmp2), '{not json');
  check('2: a broken marker reads as none', readProfileMarker(tmp2) === null);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });

  // ---------- 3. Keep cookies: off ----------
  const quit = fakeSession();
  await clearPrivateData(quit);
  check('3: the quit clearing names cookies, local storage, IndexedDB, service workers and the cache storage', JSON.stringify(PRIVATE_STORAGES) === JSON.stringify(['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']) && quit.cleared.length === 1 && JSON.stringify(quit.cleared[0].storages) === JSON.stringify(PRIVATE_STORAGES), quit.cleared);

  // ---------- 4. The profile and the user agent ----------
  check('4: the partition persists and is the browser\'s own', BROWSER_PARTITION === 'persist:browser');
  check('4: the user agent loses the Electron and app tokens and nothing else', cleanUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) silo-harness/0.9.0 Chrome/140.0.0.0 Electron/45.0.0 Safari/537.36') === 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' && cleanUserAgent('X open-harness/0.8.0 Electron/44.1.0 Y') === 'X Y');

  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
