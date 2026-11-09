// The chat cards' pure pieces, headless: which pull requests a reply or a tool result names (src/renderer/
// chat-cards-model.ts), which written files are documents and what their cards say, the pull request card's words;
// the main process's URL check, gh's arguments and the mapping of its JSON (src/main/chat-cards/pull-requests.ts),
// the lookup's minute-long cache, its one call per pull request and its few calls at once; the document viewer's
// tokens (chat-cards/documents.ts). No window, no gh, no network. The cards themselves: test/live/chat-cards.js.
// Run: npm run build && node test/run.js chat-cards
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');
const pr = require(path.join(projectDir, 'dist/main/chat-cards/pull-requests.js'));
const docs = require(path.join(projectDir, 'dist/main/chat-cards/documents.js'));

(async () => {
  // An ES module in a package without "type": an .mjs copy (it imports nothing at run time)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-cards-'));
  fs.copyFileSync(path.join(projectDir, 'dist/renderer/chat-cards-model.js'), path.join(dir, 'chat-cards-model.mjs'));
  const m = await import(pathToFileURL(path.join(dir, 'chat-cards-model.mjs')).href);

  const U = (n, repo = 'tcg', owner = 'BrandeisPatrick') => `https://github.com/${owner}/${repo}/pull/${n}`;
  const urls = (list) => list.map((r) => r.url);

  // ---------- 1. Pull requests in a reply ----------
  check('1: a bare URL', JSON.stringify(m.findPullRequests(`Opened ${U(3)}.`)) === JSON.stringify([{ owner: 'BrandeisPatrick', repo: 'tcg', number: 3, url: U(3) }]));
  check('1: a Markdown link, once however often it is named', JSON.stringify(urls(m.findPullRequests(`[#3](${U(3)}) — see ${U(3)} and <${U(3)}>`))) === JSON.stringify([U(3)]));
  check('1: a deeper page, a query and an anchor name the same pull request', JSON.stringify(urls(m.findPullRequests(`${U(3)}/files ${U(3)}?w=1 ${U(3)}#discussion_r1`))) === JSON.stringify([U(3)]));
  check('1: www., http and any case of the host', JSON.stringify(urls(m.findPullRequests('http://www.GitHub.com/a-b/c.d_e/pull/12'))) === JSON.stringify(['https://github.com/a-b/c.d_e/pull/12']));
  check('1: the number ends where the digits end', urls(m.findPullRequests(`${U(3)}0x`))[0] === U(30) && urls(m.findPullRequests(`(${U(3)})`))[0] === U(3));
  check('1: issues, commits, other hosts and repos named . or .. are not pull requests', m.findPullRequests('https://github.com/a/b/issues/3 https://github.com/a/b/commit/abc https://gitlab.com/a/b/pull/3 https://github.com/a/../pull/3 https://example.com/github.com/x').length === 0);
  check('1: two pull requests, in order', JSON.stringify(urls(m.findPullRequests(`${U(8)} then ${U(7, 'other')}`))) === JSON.stringify([U(8), U(7, 'other')]));
  check('1: a reply naming up to three gets their cards; four is a list and gets none', m.replyPullRequests([1, 2, 3].map((n) => U(n)).join(' ')).length === 3 && m.replyPullRequests([1, 2, 3, 4].map((n) => U(n)).join(' ')).length === 0 && m.MAX_PR_CARDS === 3);

  // ---------- 2. Pull requests in a tool result ----------
  const created = `Creating pull request for feat into main in BrandeisPatrick/tcg\n\n${U(3)}\n[exit code: 0]`;
  check('2: gh pr create through bash', urls(m.toolPullRequests('bash', { command: 'gh pr create --fill' }, created, true))[0] === U(3));
  check('2: the arguments may come as JSON text', urls(m.toolPullRequests('bash', JSON.stringify({ command: 'git push && gh pr create --fill' }), created, true))[0] === U(3));
  check('2: gh by its path', urls(m.toolPullRequests('bash', { command: '/opt/homebrew/bin/gh pr create --fill' }, created, true))[0] === U(3));
  check('2: gh pr view <url> names it in the command', urls(m.toolPullRequests('bash', { command: `gh pr view ${U(5)} --comments` }, 'title:\tX\n[exit code: 0]', true))[0] === U(5));
  check('2: gh pr view <n> prints its url', urls(m.toolPullRequests('terminal_run', { command: 'gh pr view 9' }, `title:\tX\nurl:\t${U(9)}\n[exit code: 0]`, true))[0] === U(9));
  check('2: a failed call names none (ok false, or a failing exit code)', m.toolPullRequests('bash', { command: 'gh pr create' }, created, false).length === 0 && m.toolPullRequests('bash', { command: 'gh pr create' }, `${U(3)}\n[exit code: 1]`, true).length === 0);
  check('2: other commands that print a URL name none (curl, git log, grep)', m.toolPullRequests('bash', { command: 'git log --oneline' }, `${U(3)}\n[exit code: 0]`, true).length === 0 && m.toolPullRequests('bash', { command: 'echo gh pr createx' }, `${U(3)}`, true).length === 0 && m.toolPullRequests('grep', { pattern: 'pull' }, U(3), true).length === 0);
  check('2: gh pr list is a list: no cards', m.toolPullRequests('bash', { command: 'gh pr list' }, [1, 2, 3, 4].map((n) => U(n)).join('\n'), true).length === 0);
  check('2: an MCP GitHub tool that makes a pull request: its first URL', urls(m.toolPullRequests('mcp__github__create_pull_request', {}, JSON.stringify({ html_url: U(11), base: { repo: { html_url: 'https://github.com/a/b' } } }), true))[0] === U(11) && m.toolPullRequests('mcp__github__create_pull_request', {}, `Error: ${U(11)}`, true).length === 0);

  // ---------- 3. Documents the agent wrote ----------
  const cwd = '/Users/ada/proj';
  const wrote = (p, opts = {}) => m.toolDocument(opts.name ?? 'write_file', { path: p, content: 'x' }, opts.result ?? 'Wrote 1 line to x', opts.ok ?? true, cwd, '/Users/ada');
  check('3: notes/trend-log.md → "Trend log", MD, its absolute path', JSON.stringify(wrote('notes/trend-log.md')) === JSON.stringify({ path: '/Users/ada/proj/notes/trend-log.md', title: 'Trend log', label: 'MD' }), wrote('notes/trend-log.md'));
  check('3: HTML, PDF and plain text are documents', wrote('report.html').label === 'HTML' && wrote('out/a.htm').label === 'HTML' && wrote('/tmp/x.pdf').label === 'PDF' && wrote('todo.txt').label === 'TXT' && wrote('a.markdown').label === 'MD');
  check('3: a name with capitals or spaces keeps them', wrote('NOTES.md').title === 'NOTES' && wrote('Q3 Plan.md').title === 'Q3 Plan' && wrote('my_notes.txt').title === 'My notes');
  check('3: a project file the agent keeps up to date is not a card, however it is spelled', ['README.md', 'readme.txt', 'README.ja.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE.txt', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'docs/SECURITY.md', 'CODE_OF_CONDUCT.md'].every((p) => !wrote(p)) && Boolean(wrote('docs/readme-notes.md')) && Boolean(wrote('changelog-draft.md')));
  check('3: ~ and .. are resolved', wrote('~/Desktop/n.md').path === '/Users/ada/Desktop/n.md' && wrote('../other/./n.md').path === '/Users/ada/other/n.md');
  check('3: code, config and tool input are not documents', !wrote('src/a.ts') && !wrote('package.json') && !wrote('requirements.txt') && !wrote('requirements-dev.txt') && !wrote('robots.txt') && !wrote('CMakeLists.txt') && !wrote('LICENSE.txt'));
  check('3: nothing inside node_modules, .git or another dot folder', !wrote('node_modules/x/README.md') && !wrote('.github/PULL_REQUEST_TEMPLATE.md') && !wrote('/Users/ada/.claude/notes.md') && Boolean(wrote('/Users/ada/.notes.md')));
  check('3: an edit, a failed write or another tool leaves no card', !wrote('n.md', { name: 'edit_file' }) && !wrote('n.md', { ok: false }) && !wrote('n.md', { result: 'Error: EACCES' }) && !wrote('n.md', { name: 'read_file' }));

  // ---------- 4. The card's words ----------
  const NOW = Date.UTC(2026, 10, 9, 12, 0);
  check('4: ages', m.relativeTime(NOW - 20_000, NOW) === 'just now' && m.relativeTime(NOW - 20 * 60_000, NOW) === '20m ago' && m.relativeTime(NOW - 3 * 3_600_000, NOW) === '3h ago' && m.relativeTime(NOW - 5 * 86_400_000, NOW) === '5d ago');
  check('4: older than a month: the date', /^[A-Z][a-z]{2} \d{1,2}$/.test(m.relativeTime(NOW - 60 * 86_400_000, NOW)) && /^[A-Z][a-z]{2} \d{1,2}, 2024$/.test(m.relativeTime(Date.UTC(2024, 2, 3), NOW)));
  const ref = { owner: 'BrandeisPatrick', repo: 'tcg', number: 3, url: U(3) };
  check('4: the meta line', m.prMetaLine({ ref, author: 'BrandeisPatrick', at: NOW - 20 * 60_000 }, NOW) === 'BrandeisPatrick/tcg #3 · BrandeisPatrick · 20m ago' && m.prMetaLine({ ref }, NOW) === 'BrandeisPatrick/tcg #3');
  check('4: files and the diff stat, with a real minus', m.filesLabel(198) === '198 files' && m.filesLabel(1) === '1 file' && JSON.stringify(m.diffLabels(12349, 8032)) === JSON.stringify(['+12,349', '−8,032']));
  const info = (o) => ({ ref, found: true, state: 'open', fetchedAt: NOW, ...o });
  const foot = (o) => m.prFooter(info(o));
  check('4: no footer with nothing to say, nor for merged and closed', foot({}) === null && foot({ state: 'merged', checks: { state: 'failing', total: 1, passed: 0, failed: 1, pending: 0 } }) === null && foot({ state: 'closed', conflicts: true }) === null);
  check('4: checks passing', JSON.stringify(foot({ checks: { state: 'passing', total: 5, passed: 5, failed: 0, pending: 0 } })) === JSON.stringify({ text: 'All 5 checks passed', tone: 'ok' }) && foot({ checks: { state: 'passing', total: 1, passed: 1, failed: 0, pending: 0 } }).text === 'The check passed');
  check('4: checks failing and changes requested: the worst tone', JSON.stringify(foot({ checks: { state: 'failing', total: 5, passed: 3, failed: 2, pending: 0 }, review: 'changes' })) === JSON.stringify({ text: '2 of 5 checks failed · Changes requested', tone: 'bad' }));
  check('4: running checks, approved, conflicts', foot({ checks: { state: 'pending', total: 4, passed: 1, failed: 0, pending: 3 }, review: 'approved' }).text === 'Checks running · 1 of 4 done · Approved' && foot({ checks: { state: 'pending', total: 4, passed: 1, failed: 0, pending: 3 } }).tone === 'wait' && foot({ conflicts: true }).text === 'Merge conflicts');
  check('4: a draft is open for the footer', foot({ state: 'draft', review: 'required' }).text === 'Review required');
  check('4: gh gave nothing: why, quietly', JSON.stringify(m.prFooter({ ref, found: false, error: 'gh is not installed', fetchedAt: NOW })) === JSON.stringify({ text: 'Status unavailable · gh is not installed', tone: 'info' }));
  check('4: the pills', m.PR_STATE_LABEL.open === 'Open' && m.PR_STATE_LABEL.draft === 'Draft' && m.PR_STATE_LABEL.merged === 'Merged' && m.PR_STATE_LABEL.closed === 'Closed');

  // ---------- 5. The main process: the URL check and gh's arguments ----------
  check('5: the canonical URL', JSON.stringify(pr.parsePullRequestUrl(`${U(3)}/files?w=1`)) === JSON.stringify(ref) && pr.parsePullRequestUrl('http://www.github.com/BrandeisPatrick/tcg/pull/3').url === U(3));
  check('5: anything else is refused', ['', 'https://github.com/a/b/issues/3', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/3 && rm -rf /', 'https://github.com/-a/b/pull/3', 'https://github.com/a/../pull/3', 'https://evil.com/github.com/a/b/pull/3', 'file:///etc/passwd', 'https://github.com/a/b.git/pull/3', null].every((u) => pr.parsePullRequestUrl(u) === null));
  check('5: gh pr view <url> --json with the fields the card shows', JSON.stringify(pr.ghArgs(ref)) === JSON.stringify(['pr', 'view', U(3), '--json', 'number,title,state,isDraft,author,createdAt,mergedAt,closedAt,additions,deletions,changedFiles,statusCheckRollup,reviewDecision,mergeable']));

  // ---------- 6. gh's JSON mapped ----------
  const gh = {
    number: 3, title: '  Deck game,\n hero rebuild ', state: 'OPEN', isDraft: false, author: { login: 'BrandeisPatrick', name: 'Patrick', is_bot: false },
    createdAt: '2026-11-09T11:40:00Z', mergedAt: '0001-01-01T00:00:00Z', closedAt: '', additions: 12349, deletions: 8032, changedFiles: 198,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
    ],
    reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
  };
  const open = pr.pullRequestFromGh(gh, ref, NOW);
  check('6: an open pull request', JSON.stringify(open) === JSON.stringify({ ref, found: true, title: 'Deck game, hero rebuild', state: 'open', author: 'BrandeisPatrick', at: Date.parse('2026-11-09T11:40:00Z'), files: 198, additions: 12349, deletions: 8032, checks: { state: 'passing', total: 3, passed: 3, failed: 0, pending: 0 }, review: 'approved', conflicts: false, fetchedAt: NOW }), open);
  check('6: a draft', pr.pullRequestFromGh({ ...gh, isDraft: true }, ref, NOW).state === 'draft');
  const merged = pr.pullRequestFromGh({ ...gh, state: 'MERGED', mergedAt: '2026-11-09T10:00:00Z', closedAt: '2026-11-09T10:00:00Z', mergeable: 'CONFLICTING' }, ref, NOW);
  check('6: merged: dated by its merge, never in conflict', merged.state === 'merged' && merged.at === Date.parse('2026-11-09T10:00:00Z') && merged.conflicts === false);
  const closed = pr.pullRequestFromGh({ ...gh, state: 'CLOSED', closedAt: '2026-11-04T10:00:00Z' }, ref, NOW);
  check('6: closed: dated by its closing', closed.state === 'closed' && closed.at === Date.parse('2026-11-04T10:00:00Z'));
  check('6: conflicts on an open one', pr.pullRequestFromGh({ ...gh, mergeable: 'CONFLICTING' }, ref, NOW).conflicts === true);
  check('6: the review decisions', pr.pullRequestFromGh({ ...gh, reviewDecision: 'CHANGES_REQUESTED' }, ref, NOW).review === 'changes' && pr.pullRequestFromGh({ ...gh, reviewDecision: 'REVIEW_REQUIRED' }, ref, NOW).review === 'required' && pr.pullRequestFromGh({ ...gh, reviewDecision: '' }, ref, NOW).review === null);
  const checks = pr.checksOf([
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'CheckRun', status: 'QUEUED', conclusion: null },
    { __typename: 'StatusContext', state: 'PENDING' },
    { __typename: 'StatusContext', state: 'ERROR' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    'junk',
  ]);
  check('6: the checks counted: failed, running, passed', JSON.stringify(checks) === JSON.stringify({ state: 'failing', total: 7, passed: 1, failed: 3, pending: 3 }), checks);
  check('6: running only: pending; none: null', pr.checksOf([{ status: 'IN_PROGRESS' }]).state === 'pending' && pr.checksOf([]) === null && pr.checksOf(null) === null);
  const sparse = pr.pullRequestFromGh({ state: 'OPEN', title: 'T' }, ref, NOW);
  check('6: what gh leaves out stays out', JSON.stringify(sparse) === JSON.stringify({ ref, found: true, title: 'T', state: 'open', checks: null, review: null, conflicts: false, fetchedAt: NOW }), sparse);
  check('6: not an object: not found', pr.pullRequestFromGh('nope', ref, NOW).found === false && pr.pullRequestFromGh(null, ref, NOW).error === 'gh gave no pull request');
  check('6: negative or odd numbers are dropped', pr.pullRequestFromGh({ ...gh, additions: -1, deletions: 'x', changedFiles: Infinity }, ref, NOW).additions === undefined);

  // ---------- 7. What a failed gh says ----------
  check('7: the errors in a few words', pr.ghError({ code: 'ENOENT' }) === 'gh is not installed' && pr.ghError({ killed: true }) === 'gh took too long' && pr.ghError({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }) === 'gh is not signed in' && pr.ghError({ code: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 404.' }) === 'Pull request not found' && pr.ghError({ code: 1, stderr: 'error connecting to api.github.com\ncould not resolve host' }) === 'GitHub could not be reached' && pr.ghError({ code: 1, stderr: '\n  something odd\nmore' }) === 'something odd' && pr.ghError(null) === 'gh failed');

  // ---------- 8. The lookup: a minute's cache, one call per pull request, a few at once ----------
  let clock = NOW;
  const callsFor = [];
  let running = 0;
  let most = 0;
  const lookup = new pr.PullRequestLookup({
    now: () => clock,
    exec: async (args) => {
      callsFor.push(args[2]);
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      if (args[2].endsWith('/404')) throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'GraphQL: Could not resolve to a PullRequest' });
      if (args[2].endsWith('/500')) return 'not json';
      return JSON.stringify({ ...gh, number: Number(args[2].split('/').pop()) });
    },
  });
  const [a, b] = await Promise.all([lookup.get(U(3)), lookup.get(`${U(3)}/files`)]);
  check('8: two cards at once for one pull request: one gh call, one answer', callsFor.length === 1 && a === b && a.found && a.title === 'Deck game, hero rebuild');
  clock += 59_000;
  await lookup.get(U(3));
  check('8: asked again within the minute: the same answer, no call', callsFor.length === 1);
  clock += 2_000;
  const again = await lookup.get(U(3));
  check('8: after a minute: gh again', callsFor.length === 2 && again.fetchedAt === clock);
  const nf = await lookup.get(U(404));
  check('8: gh failing: what the URL gives, and why', nf.found === false && nf.error === 'Pull request not found' && nf.ref.url === U(404));
  await lookup.get(U(404));
  check('8: … kept for the minute too', callsFor.filter((u) => u.endsWith('/404')).length === 1);
  check('8: output that is not JSON: not found', (await lookup.get(U(500))).found === false);
  let refused = '';
  await lookup.get('https://github.com/a/b/issues/1').catch((e) => (refused = e.message));
  check('8: a URL that is not a pull request is refused before gh', refused === 'Not a GitHub pull request URL' && !callsFor.some((u) => u.includes('issues')));
  callsFor.length = 0;
  most = 0;
  await Promise.all([10, 11, 12, 13, 14, 15, 16].map((n) => lookup.get(U(n))));
  check('8: seven pull requests at once: at most three gh calls run together, each asked once', most === 3 && callsFor.length === 7, { most, calls: callsFor.length });

  // ---------- 9. The document viewer's tokens ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-cards-docs-'));
  const note = path.join(tmp, 'trend-log.md');
  fs.writeFileSync(note, '# Trend log\n\n- one\n');
  const p1 = docs.documentViewerPath(note);
  check('9: the viewer path names a token and the file', /^_doc\/[0-9a-f]{24}\/trend-log\.md$/.test(p1));
  check('9: the same file keeps its URL', docs.documentViewerPath(note) === p1);
  const token = p1.split('/')[1];
  check('9: the token gives the file back', docs.documentFile(token) === note && docs.documentFile('0'.repeat(24)) === null);
  check('9: the title is the first heading, else the file name', docs.documentTitle(note, fs.readFileSync(note, 'utf8')) === 'Trend log' && docs.documentTitle(path.join(tmp, 'x.txt'), '# not a heading in text') === 'x.txt');
  check('9: kinds by extension', docs.documentKind('a.md') === 'markdown' && docs.documentKind('a.TXT') === 'text' && docs.documentKind('a.htm') === 'html' && docs.documentKind('a.pdf') === 'pdf' && docs.documentKind('a.ts') === null);
  fs.rmSync(note);
  check('9: a file that is gone is served no more', docs.documentFile(token) === null);
  const html = path.join(tmp, 'page.html');
  fs.writeFileSync(html, '<p>x</p>');
  check('9: the viewer takes only Markdown and text', docs.documentFile(docs.documentViewerPath(html).split('/')[1]) === null);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.error(`FAIL  crashed: ${err.stack || err}`);
  process.exit(1);
});
