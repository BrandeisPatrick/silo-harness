// Downloads in the Browser pane, headless (src/main/browser/downloads.ts): the names a site suggests made safe to
// save, " (2)" for a name that is taken, which downloads are the agent's (during one of its actions or within two
// seconds after), and the list kept across launches. The real downloads: test/live/browser-downloads.js.
// Run: npm run build && node test/browser-downloads.js
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dl = require(path.join(projectDir, 'dist/main/browser/downloads.js'));
const { check, done } = require('./support/check.js');

const { sanitizeFilename: sanitize, uniqueName, uniquePath, startedByAgent, splitExtension, cleanDownloadList, downloadHost, NAME_MAX, AGENT_TAIL_MS } = dl;

// ---------- 1. sanitize ----------
check('an ordinary name is kept', sanitize('report.pdf') === 'report.pdf' && sanitize('Quarterly report (final).xlsx') === 'Quarterly report (final).xlsx' && sanitize('résumé.pdf') === 'résumé.pdf');
check('"../../x" cannot climb out of the folder', sanitize('../../x') === 'x' && sanitize('..\\..\\x.txt') === 'x.txt', [sanitize('../../x'), sanitize('..\\..\\x.txt')]);
check('path separators are removed (/, \\ and the Finder\'s :)', sanitize('a/b\\c:d.txt') === 'abcd.txt' && !/[/\\:]/.test(sanitize('/etc/passwd')), sanitize('a/b\\c:d.txt'));
check('control characters are removed', sanitize('re\u0000po\u0007rt\n\r\t.txt') === 'report.txt' && sanitize('a\u007fb\u0085c.txt') === 'abc.txt');
check('a direction override cannot hide the real extension', sanitize('invoice‮txt.exe') === 'invoicetxt.exe');
check('a leading dot (a hidden file) is removed, as are leading and trailing spaces', sanitize('.bashrc') === 'bashrc' && sanitize('...hidden.txt') === 'hidden.txt' && sanitize('  spaced.txt  ') === 'spaced.txt');
const long = `${'a'.repeat(300)}.pdf`;
const capped = sanitize(long);
check(`a 300-character name is capped at ${NAME_MAX} characters, the extension kept`, [...capped].length === NAME_MAX && capped.endsWith('.pdf') && capped.startsWith('aaaa'), capped.length);
const wide = sanitize(`${'文'.repeat(300)}.txt`);
check('… and a name of wide characters stays under the Mac\'s 255 bytes', Buffer.byteLength(wide, 'utf8') <= 255 && wide.endsWith('.txt'), Buffer.byteLength(wide, 'utf8'));
check('an empty name, or one that is nothing but dots and slashes, becomes "download"', sanitize('') === 'download' && sanitize('   ') === 'download' && sanitize('../..') === 'download' && sanitize('/') === 'download' && sanitize(null) === 'download');

// ---------- 2. unique ----------
check('the extension is found, .tar.gz as one', JSON.stringify(splitExtension('a.tar.gz')) === '{"stem":"a","ext":".tar.gz"}' && JSON.stringify(splitExtension('README')) === '{"stem":"README","ext":""}' && JSON.stringify(splitExtension('my.report.pdf')) === '{"stem":"my.report","ext":".pdf"}');
const taken = new Set(['report.pdf', 'report (2).pdf', 'notes', 'archive.tar.gz']);
const has = (n) => taken.has(n);
check('a free name is kept', uniqueName('summary.pdf', has) === 'summary.pdf');
check('a taken name gets the first free " (n)" before the extension', uniqueName('report.pdf', has) === 'report (3).pdf' && uniqueName('notes', has) === 'notes (2)' && uniqueName('archive.tar.gz', has) === 'archive (2).tar.gz', [uniqueName('report.pdf', has), uniqueName('notes', has), uniqueName('archive.tar.gz', has)]);
const onDisk = new Set(['/dl/a.txt']);
check('a path is free when neither on disk nor reserved by a download still running', uniquePath('/dl', 'a.txt', (p) => onDisk.has(p)) === '/dl/a (2).txt' && uniquePath('/dl', 'a.txt', (p) => onDisk.has(p), new Set(['/dl/a (2).txt'])) === '/dl/a (3).txt' && uniquePath('/dl', 'b.txt', () => false) === '/dl/b.txt');

// ---------- 3. Whose download ----------
const t0 = 1_000_000;
check('nothing acting, ever: the user\'s', startedByAgent({ inFlight: 0, lastEnd: 0 }, t0) === false);
check('during an action of the agent: the agent\'s', startedByAgent({ inFlight: 1, lastEnd: 0 }, t0) === true && startedByAgent({ inFlight: 2, lastEnd: t0 - 60_000 }, t0) === true);
check(`within ${AGENT_TAIL_MS / 1000} seconds after one: the agent's`, startedByAgent({ inFlight: 0, lastEnd: t0 }, t0) === true && startedByAgent({ inFlight: 0, lastEnd: t0 - 1999 }, t0) === true && startedByAgent({ inFlight: 0, lastEnd: t0 - AGENT_TAIL_MS }, t0) === true);
check('later than that: the user\'s', startedByAgent({ inFlight: 0, lastEnd: t0 - AGENT_TAIL_MS - 1 }, t0) === false && startedByAgent({ inFlight: 0, lastEnd: t0 - 60_000 }, t0) === false);
check('the tail can be set', startedByAgent({ inFlight: 0, lastEnd: t0 - 3000 }, t0, 5000) === true);

// ---------- 4. The list across launches ----------
check('the host includes a port', downloadHost('http://127.0.0.1:8123/report.txt') === '127.0.0.1:8123' && downloadHost('https://example.com/a') === 'example.com' && downloadHost('blob:') === '');
const kept = cleanDownloadList([
  { id: 'a', filename: 'a.txt', path: '/dl/a.txt', url: 'https://x/a.txt', host: 'x', received: 5, total: 5, state: 'completed', startedAt: 1, byAgent: false, asking: false, tabId: 'tab-1' },
  { id: 'b', filename: 'b.txt', path: '/dl/b.txt', url: 'https://x/b.txt', host: 'x', received: 2, total: 9, state: 'progressing', startedAt: 2, byAgent: false, asking: false, tabId: 'tab-1' },
  { id: 'c', filename: 'c.txt', path: '', url: 'https://x/c.txt', host: 'x', received: 0, total: 0, state: 'paused', startedAt: 3, byAgent: true, asking: true, tabId: 'tab-1' },
  { id: 'd', filename: 'd.txt', state: 'exploded' },
  { nope: true },
  'junk',
]);
check('a finished download is kept as it was (its tab is not)', kept[0].id === 'a' && kept[0].state === 'completed' && kept[0].tabId === null);
check('one still running when the app went is interrupted now', kept[1].id === 'b' && kept[1].state === 'interrupted');
check("an agent's download that was never answered is gone", !kept.some((d) => d.id === 'c'));
check('an unknown state reads as interrupted; malformed entries are dropped', kept.length === 3 && kept[2].id === 'd' && kept[2].state === 'interrupted', kept.map((d) => d.id));
check('at most 50 are kept', cleanDownloadList(Array.from({ length: 70 }, (_, i) => ({ id: `x${i}`, filename: 'f', state: 'completed' }))).length === 50);

done();
