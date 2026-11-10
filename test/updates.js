// The update check's logic, headless (src/main/updates.ts): semver comparison, which releases count (not drafts,
// prereleases, older or equal ones, junk), the page it links to, and the schedule (30 s after start, then daily) with
// an injected fetch and clock: off when the switch is off, silent on failure, one change per new version. The module
// loads without Electron. Run: npm run build && node test/updates.js
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const U = require(path.join(projectDir, 'dist/main/updates.js'));
const { check, done } = require('./support/check.js');

(async () => {
  const cmp = (a, b) => Math.sign(U.compareVersions(a, b));
  check('versions compare by semver', cmp('0.14.0', '0.12.0') === 1 && cmp('0.12.0', '0.14.0') === -1 && cmp('v1.2.3', '1.2.3') === 0 && cmp('0.10.0', '0.9.9') === 1 && cmp('1.0', '1.0.0') === 0 && cmp('2.0.0', '10.0.0') === -1);
  check('a prerelease sorts before its release, and prereleases among themselves', cmp('1.0.0-beta', '1.0.0') === -1 && cmp('1.0.0-beta.2', '1.0.0-beta.10') === -1 && cmp('1.0.0-alpha', '1.0.0-beta') === -1 && cmp('1.0.0-1', '1.0.0-alpha') === -1);
  check('junk is not a version', U.parseVersion('latest') === null && U.parseVersion('') === null && U.parseVersion('1') === null);

  const rel = (o) => ({ tag_name: 'v0.14.0', draft: false, prerelease: false, html_url: 'https://github.com/BrandeisPatrick/silo-harness/releases/tag/v0.14.0', ...o });
  check('a newer release is found, with its page', JSON.stringify(U.newerRelease(rel({}), '0.12.0')) === JSON.stringify({ version: '0.14.0', url: 'https://github.com/BrandeisPatrick/silo-harness/releases/tag/v0.14.0' }));
  check('the same or an older version is not', U.newerRelease(rel({}), '0.14.0') === null && U.newerRelease(rel({ tag_name: '0.11.0' }), '0.12.0') === null);
  check('drafts and prereleases are ignored (by flag or by tag)', U.newerRelease(rel({ draft: true }), '0.1.0') === null && U.newerRelease(rel({ prerelease: true }), '0.1.0') === null && U.newerRelease(rel({ tag_name: 'v0.15.0-rc.1' }), '0.1.0') === null);
  check('junk replies find nothing', [null, 'x', [], {}, { tag_name: 5 }, { tag_name: 'nightly' }].every((j) => U.newerRelease(j, '0.1.0') === null) && U.newerRelease(rel({}), 'dev') === null);
  check('a page outside the project\'s releases is not linked: its own release page is', U.newerRelease(rel({ html_url: 'https://evil.example/x' }), '0.1.0').url === 'https://github.com/BrandeisPatrick/silo-harness/releases/tag/v0.14.0');
  check('the API is the project\'s latest release', U.RELEASES_API === 'https://api.github.com/repos/BrandeisPatrick/silo-harness/releases/latest' && U.FIRST_CHECK_MS === 30_000 && U.CHECK_EVERY_MS === 86_400_000 && U.CHECK_TIMEOUT_MS === 10_000);

  // ---------- The schedule, on a fake clock ----------
  let timers = [];
  const clock = {
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => (timers = timers.filter((x) => x !== t)),
  };
  const fire = async () => {
    const t = timers.shift();
    t.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return t.ms;
  };
  let reply = rel({});
  let fail = false;
  let fetches = 0;
  let enabled = true;
  const changes = [];
  const checker = new U.UpdateChecker({
    currentVersion: '0.12.0',
    fetchJson: async (url) => {
      fetches++;
      if (url !== U.RELEASES_API) throw new Error('wrong url');
      if (fail) throw new Error('offline');
      return reply;
    },
    enabled: () => enabled,
    clock,
    onChange: (s) => changes.push(s),
  });
  checker.start();
  check('nothing is fetched at start; the first check is set for 30 s', fetches === 0 && timers.length === 1 && timers[0].ms === 30_000);
  await fire();
  check('the first check finds the release and tells the window once', fetches === 1 && changes.length === 1 && changes[0].available.version === '0.14.0' && checker.state().available.version === '0.14.0');
  check('…and the next is a day later', timers.length === 1 && timers[0].ms === 86_400_000);
  await fire();
  check('the same release again is no change', fetches === 2 && changes.length === 1);
  fail = true;
  await fire();
  check('a failure is silent and keeps what was found; the schedule goes on', fetches === 3 && changes.length === 1 && checker.state().available.version === '0.14.0' && timers.length === 1);
  fail = false;
  reply = rel({ tag_name: 'v0.15.0', html_url: 'https://github.com/BrandeisPatrick/silo-harness/releases/tag/v0.15.0' });
  await fire();
  check('a newer one replaces it', changes.length === 2 && changes[1].available.version === '0.15.0');
  enabled = false;
  await fire();
  check('with the switch off nothing is fetched and the line goes', fetches === 4 && changes.length === 3 && changes[2].available === null && timers.length === 1);
  enabled = true;
  await fire();
  check('on again: the next scheduled check finds it', fetches === 5 && checker.state().available?.version === '0.15.0');
  checker.disabled();
  check('turning the switch off clears it at once', checker.state().available === null);
  checker.stop();
  check('stop clears the timer', timers.length === 0);

  // Concurrent checks share one request
  let release;
  let started = 0;
  const slow = new U.UpdateChecker({ currentVersion: '0.1.0', enabled: () => true, clock, fetchJson: () => (started++, new Promise((r) => (release = r))) });
  const a = slow.check();
  const b = slow.check();
  release(rel({}));
  await Promise.all([a, b]);
  check('a check while one runs does not start another', started === 1 && slow.state().available.version === '0.14.0');

  check('the module loads under plain Node (Electron only inside setupUpdates)', typeof U.setupUpdates === 'function');
  done();
})().catch((e) => {
  console.log('FAIL CRASH', e);
  process.exit(1);
});
