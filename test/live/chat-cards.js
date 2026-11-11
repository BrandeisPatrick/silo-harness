// Live check of the chat cards in the real window, with the mock model and a fake GitHub CLI (SILO_HARNESS_GH points
// the main process at it, and the shell calls run it by its path, so no real gh and no network are ever used):
// a `gh pr create` and the reply naming the same pull request give one card under the reply, filled from
// `gh pr view` (state, repository, author, age, title, files, diff, checks); two notes written with write_file give
// two document cards stacked 8px apart; artifacts get the compact card; merged, draft and closed pull requests their
// own pills; a pull request gh cannot find keeps what its URL gives; a reply listing many gets none; a document card
// opens the file in the Browser pane's viewer; the session drawn again shows the same cards in the same places, and
// gh is not asked again within the minute. Screenshots light and dark.
// Run: npm run build && node test/live/chat-cards.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt } = require('./rig.js');

const { check, done } = checker();
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-cards-'));

const OWNER = 'BrandeisPatrick';
const PR = (n, repo = 'tcg') => `https://github.com/${OWNER}/${repo}/pull/${n}`;
const MIN = 60_000;

/** A fake `gh`: `pr create` prints the URL, `pr view <url>` prints the JSON for that number, every call is logged. */
function fakeGh(dir) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const ok = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });
  const prs = {
    3: { number: 3, title: 'Deck game, hero rebuild, trigger prompts, Victor and Silver', state: 'OPEN', isDraft: false, author: { login: OWNER }, createdAt: iso(now - 20 * MIN), mergedAt: null, closedAt: null, additions: 12349, deletions: 8032, changedFiles: 198, statusCheckRollup: [ok('build'), ok('test'), ok('lint')], reviewDecision: '', mergeable: 'MERGEABLE' },
    7: { number: 7, title: 'Settings → Browser', state: 'MERGED', isDraft: false, author: { login: OWNER }, createdAt: iso(now - 50 * 60 * MIN), mergedAt: iso(now - 2 * 60 * MIN), closedAt: iso(now - 2 * 60 * MIN), additions: 840, deletions: 112, changedFiles: 14, statusCheckRollup: [ok('build')], reviewDecision: 'APPROVED', mergeable: 'UNKNOWN' },
    8: { number: 8, title: 'Phone page cards', state: 'OPEN', isDraft: true, author: { login: OWNER }, createdAt: iso(now - 3 * 60 * MIN), additions: 61, deletions: 4, changedFiles: 3, statusCheckRollup: [ok('build'), { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '' }], reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE' },
    9: { number: 9, title: 'An idea that did not work out', state: 'CLOSED', isDraft: false, author: { login: 'someone' }, createdAt: iso(now - 9 * 24 * 60 * MIN), closedAt: iso(now - 5 * 24 * 60 * MIN), additions: 5, deletions: 5, changedFiles: 1, statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci', state: 'FAILURE' }], reviewDecision: '', mergeable: 'CONFLICTING' },
  };
  for (const [n, json] of Object.entries(prs)) fs.writeFileSync(path.join(dir, `pr-${n}.json`), JSON.stringify(json));
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(
    gh,
    `#!/bin/sh
echo "$*" >> "${dir}/calls.log"
if [ "$1 $2" = "pr create" ]; then echo "Creating pull request for feature into main in ${OWNER}/tcg"; echo; echo "${PR(3)}"; exit 0; fi
if [ "$1 $2" = "pr view" ]; then
  n=$(echo "$3" | sed -n 's#.*/pull/\\([0-9]*\\).*#\\1#p')
  if [ -f "${dir}/pr-$n.json" ]; then cat "${dir}/pr-$n.json"; exit 0; fi
  echo "GraphQL: Could not resolve to a PullRequest with the number of $n. (repository.pullRequest)" >&2; exit 1
fi
echo "unknown command" >&2; exit 1
`,
  );
  fs.chmodSync(gh, 0o755);
  return gh;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-gh-'));
  const gh = fakeGh(dir);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-cards-project-'));
  const app = await launch({ mode: 'bypass', mock: true, project, env: { SILO_HARNESS_GH: gh }, size: { width: 1440, height: 1000 } });
  const calls = (n) => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter((l) => l.startsWith('pr view') && l.includes(`/pull/${n}`)).length : 0);
  const theme = (t) => app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(t)}`);
  /** One turn: the mock model's replies in order (tool calls, then the text), sent with `text` */
  const turn = async (text, replies) => {
    for (const r of replies) app.mock.state.replies.push(r);
    await app.send(text);
    await app.waitIdle();
  };
  /** The reading column at its full width: the details rail and the side pane shut */
  const wide = async () => {
    await app.evaluate(`(() => { const r = document.querySelector('#rail-toggle'); if (r && r.getAttribute('aria-pressed') === 'true') r.click(); const p = document.querySelector('#side-pane'); if (p && p.getBoundingClientRect().width > 0) document.querySelector('#pane-toggle')?.click(); })()`);
    await sleep(300);
  };
  const blocks = () =>
    app.evaluate(`[...document.querySelectorAll('#messages > .chat-cards')].map((b) => ({
      after: b.previousElementSibling ? b.previousElementSibling.className : '',
      prs: [...b.querySelectorAll('.pr-card')].map((c) => c.dataset.url),
      docs: [...b.querySelectorAll('.doc-card')].map((c) => c.dataset.path),
      artifacts: b.querySelectorAll('.artifact-card').length,
    }))`);
  const readPr = (url) =>
    app.evaluate(`(() => {
      const c = document.querySelector('.pr-card[data-url=${JSON.stringify(url)}]');
      if (!c) return null;
      const t = (s) => (c.querySelector(s)?.innerText ?? '').replace(/\\s+/g, ' ').trim();
      const r = c.getBoundingClientRect();
      return { pill: c.querySelector('.pr-pill:not([hidden])') ? t('.pr-pill') : '', pillClass: c.querySelector('.pr-pill')?.className, meta: t('.pr-card-meta'), title: t('.pr-card-title'), files: c.querySelector('.pr-files:not([hidden])') ? t('.pr-files') : '', add: t('.pr-add'), del: t('.pr-del'), foot: c.querySelector('.pr-card-foot:not([hidden])') ? t('.pr-foot-text') : '', loading: c.classList.contains('loading'), bare: c.classList.contains('bare'), href: c.getAttribute('href'), target: c.getAttribute('target'), w: r.width, h: Math.round(r.height) };
    })()`);

  try {
    // ---------- 1. gh pr create, then a reply naming the same pull request ----------
    await turn('Open a pull request for this branch', [
      { content: '', toolCalls: [{ id: 'call_pr', name: 'bash', args: { command: `${gh} pr create --title "Deck game, hero rebuild, trigger prompts, Victor and Silver" --body "The deck game."`, description: 'Open the pull request' } }] },
      { content: `Opened the pull request: [#3](${PR(3)}). It is ready for review.` },
    ]);
    await app.waitFor(`document.querySelector('.pr-card[data-url="${PR(3)}"] .pr-pill:not([hidden])')`, 15_000, 'the pull request card to fill');
    await wide();
    let b = await blocks();
    check('1: one block of cards, right under the reply', b.length === 1 && /msg assistant/.test(b[0].after), b);
    check('1: the tool result and the reply name one pull request: one card', b[0]?.prs.length === 1 && b[0].prs[0] === PR(3), b);
    const pr3 = await readPr(PR(3));
    check('1: the pill says Open, in its colour', pr3.pill === 'Open' && /\bopen\b/.test(pr3.pillClass), pr3);
    check('1: owner/repo #n · author · age', pr3.meta === `${OWNER}/tcg #3 · ${OWNER} · 20m ago`, pr3.meta);
    check('1: the title on its own line', pr3.title === 'Deck game, hero rebuild, trigger prompts, Victor and Silver', pr3.title);
    check('1: the file count and the diff stat', pr3.files === '198 files' && pr3.add === '+12,349' && pr3.del === '−8,032', pr3);
    check('1: the footer says what the checks say', pr3.foot === 'All 3 checks passed', pr3.foot);
    check('1: a link like any in the chat (the pane or the default browser, as Settings → Browser says)', pr3.href === PR(3) && pr3.target === '_blank', pr3);
    const style = await app.evaluate(`(() => { const c = document.querySelector('.pr-card'); const s = getComputedStyle(c); const add = getComputedStyle(c.querySelector('.pr-add')); const del = getComputedStyle(c.querySelector('.pr-del')); return { radius: s.borderTopLeftRadius, border: s.borderTopWidth, pad: s.paddingTop, title: getComputedStyle(c.querySelector('.pr-card-title')).fontSize, meta: getComputedStyle(c.querySelector('.pr-card-meta')).fontSize, add: add.color, del: del.color }; })()`);
    check('1: the card takes the column (736px)', Math.round(pr3.w) === 736, pr3.w);
    const cols = await app.evaluate(`(() => { const b = document.querySelector('#messages > .chat-cards'); const r = b.previousElementSibling.getBoundingClientRect(); return { block: Math.round(b.getBoundingClientRect().left), reply: Math.round(r.left), card: Math.round(b.querySelector('.pr-card').getBoundingClientRect().left) }; })()`);
    check('1: the block sits in the reading column, like the reply', cols.block === cols.reply && cols.card === cols.reply, cols);
    check('1: white card, 1px border, 12px radius, 16px padding; 14px title, 13px meta', style.radius === '12px' && style.border === '1px' && style.pad === '16px' && style.title === '14px' && style.meta === '13px', style);
    check('1: the diff stat in green and red', style.add !== style.del && /rgb\(47, 118, 19\)/.test(style.add) && /rgb\(181, 51, 51\)/.test(style.del), style);
    check('1: gh was asked once', calls(3) === 1, calls(3));
    await app.screenshotOf(path.join(shots, 'pr-card-light.png'), '.chat-cards', 16);

    // ---------- 2. Two notes written with write_file ----------
    await turn('Write the trend log and the context notes', [
      {
        content: '',
        toolCalls: [
          { id: 'call_w1', name: 'write_file', args: { path: 'notes/trend-log.md', content: '# Trend log\n\n- Cards in the chat\n' } },
          { id: 'call_w2', name: 'write_file', args: { path: 'notes/context.md', content: '# Context\n\nWhy the cards.\n' } },
        ],
      },
      { content: 'Both notes are written.' },
    ]);
    await wide();
    b = await blocks();
    const docs = b[b.length - 1];
    check('2: the two documents in one block under the reply', docs && /msg assistant/.test(docs.after) && docs.docs.length === 2 && docs.docs[0] === path.join(project, 'notes/trend-log.md'), b);
    const docCards = await app.evaluate(`[...document.querySelectorAll('.doc-card')].map((c) => { const r = c.getBoundingClientRect(); const tile = c.querySelector('.file-card-tile').getBoundingClientRect(); const s = getComputedStyle(c.querySelector('.file-card-title')); return { title: c.querySelector('.file-card-title').innerText, meta: c.querySelector('.file-card-meta').innerText, top: r.top, bottom: r.bottom, w: r.width, h: r.height, tileW: tile.width, tileTop: tile.top - r.top, size: s.fontSize, weight: s.fontWeight }; })`);
    check('2: "Trend log" and "Context", Document · MD', docCards.length === 2 && docCards[0].title === 'Trend log' && docCards[1].title === 'Context' && docCards.every((c) => c.meta === 'Document · MD'), docCards);
    check('2: 72px tall, 520px wide, the tile 56px wide from 16px down', docCards.every((c) => c.h === 72 && c.w === 520 && c.tileW === 56 && Math.round(c.tileTop) === 17), docCards);
    check('2: 8px between the two', Math.round(docCards[1].top - docCards[0].bottom) === 8, docCards);
    check('2: the title is 14px 500', docCards.every((c) => c.size === '14px' && c.weight === '500'), docCards);
    await app.screenshotOf(path.join(shots, 'doc-cards-light.png'), '#messages > .chat-cards:last-of-type', 16);

    // ---------- 3. Artifacts: the compact card, two in a row 8px apart ----------
    await turn('Make two artifacts', [
      {
        content: '',
        toolCalls: [
          { id: 'call_a1', name: 'create_artifact', args: { id: 'board', title: 'Release board', kind: 'html', content: '<h1>Release board</h1>' } },
          { id: 'call_a2', name: 'create_artifact', args: { id: 'plan', title: 'Plan', kind: 'markdown', content: '# Plan\n' } },
        ],
      },
      { content: 'Both are in the pane.' },
    ]);
    await wide();
    const arts = await app.evaluate(`[...document.querySelectorAll('.artifact-card')].map((c) => { const r = c.getBoundingClientRect(); return { title: c.querySelector('.file-card-title').innerText, meta: c.querySelector('.file-card-meta').innerText, top: r.top, bottom: r.bottom, h: r.height, block: c.parentElement.className }; })`);
    check('3: the compact card, "Artifact · HTML" and "Artifact · MD"', arts.length === 2 && arts[0].title === 'Release board' && arts[0].meta === 'Artifact · HTML' && arts[1].meta === 'Artifact · MD' && arts.every((a) => a.h === 72 && /\bchat-cards\b/.test(a.block)), arts);
    check('3: two artifacts in a row stack 8px apart', arts.length === 2 && Math.round(arts[1].top - arts[0].bottom) === 8, arts);

    // ---------- 4. Merged, draft and closed ----------
    await turn('How are the others?', [{ content: `- [#7](${PR(7)}) is merged\n- [#8](${PR(8)}) is a draft\n- [#9](${PR(9)}) was closed` }]);
    await app.waitFor(`[7, 8, 9].every((n) => document.querySelector('.pr-card[data-url$="/pull/' + n + '"] .pr-pill:not([hidden])'))`, 15_000, 'the three cards to fill');
    const [p7, p8, p9] = [await readPr(PR(7)), await readPr(PR(8)), await readPr(PR(9))];
    check('4: Merged, 2h ago, no footer', p7.pill === 'Merged' && /\bmerged\b/.test(p7.pillClass) && p7.meta.endsWith('· 2h ago') && p7.foot === '', p7);
    check('4: Draft, checks running, review required', p8.pill === 'Draft' && p8.foot === 'Checks running · 1 of 2 done · Review required', p8);
    check('4: Closed, by its author, 5d ago, no footer', p9.pill === 'Closed' && p9.meta === `${OWNER}/tcg #9 · someone · 5d ago` && p9.foot === '', p9);

    // ---------- 5. A pull request gh cannot find; a reply that lists many ----------
    await turn('And 404?', [{ content: `That one is ${PR(404)}.` }]);
    await app.waitFor(`document.querySelector('.pr-card[data-url="${PR(404)}"].bare')`, 15_000, 'the bare card');
    const p404 = await readPr(PR(404));
    check('5: what the URL alone gives: repository, number, the link, and why', p404.bare && p404.pill === '' && p404.meta === `${OWNER}/tcg #404` && p404.title === 'Pull request #404' && p404.files === '' && p404.foot === 'Status unavailable · Pull request not found' && p404.href === PR(404), p404);
    const before = (await blocks()).length;
    await turn('List them all', [{ content: [3, 7, 8, 9].map((n) => `- ${PR(n)}`).join('\n') }]);
    check('5: a reply naming four pull requests is a list: no cards', (await blocks()).length === before, await blocks());

    // ---------- 6. Drawn again: the same cards in the same places, gh not asked again within the minute ----------
    const id = await app.evaluate(`oc.sessions.current().then((m) => m.id)`);
    const was = await blocks();
    const asked = calls(3);
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('#empty-state') && !document.querySelector('#empty-state').hidden`, 10_000, 'a new session');
    await app.click(`.session-item[data-id="${id}"]`);
    await app.waitFor(`document.querySelectorAll('#messages > .chat-cards').length === ${was.length}`, 10_000, 'the cards drawn again');
    await app.waitFor(`document.querySelector('.pr-card[data-url="${PR(3)}"] .pr-pill:not([hidden])')`, 10_000, 'the card filled again');
    check('6: the same blocks, in the same places', JSON.stringify(await blocks()) === JSON.stringify(was), { was, now: await blocks() });
    check('6: gh was not asked again within the minute', calls(3) === asked, { before: asked, after: calls(3) });

    // ---------- 7. A document card opens the file in the Browser pane's viewer ----------
    await app.evaluate(`document.querySelector('.doc-card').click()`);
    const viewer = await app.pageTarget('artifact://view/_doc/', 10_000);
    let page = null;
    for (const until = Date.now() + 10_000; Date.now() < until; await sleep(150)) {
      page = await evalAt(viewer, `({ h1: document.querySelector('h1')?.innerText, meta: document.querySelector('.artifact-head .meta')?.innerText, md: document.querySelector('#md')?.innerText })`).catch(() => null);
      if (page?.md) break;
    }
    check('7: the note opens in the viewer in the Browser pane, rendered', page && page.h1 === 'Trend log' && /^trend-log\.md · /.test(page.meta) && /Cards in the chat/.test(page.md), page);
    const paneOn = await app.waitFor(`!document.querySelector('.pane-hidden') && window.__oc_debug.mods.browser().tab === 'browser' && Boolean(document.querySelector('.browser-tab.active'))`, 5_000, 'the browser in front').catch(() => false);
    check('7: the browser came forward, its page tab active in the strip', paneOn === true, await app.evaluate(`({ hidden: Boolean(document.querySelector('.pane-hidden')), tab: window.__oc_debug.mods.browser().tab, active: document.querySelector('.strip-tab.active')?.dataset.tab })`));
    await wide();

    // ---------- Screenshots, light and dark ----------
    await app.evaluate(`document.querySelector('#messages').scrollTop = 0`);
    await theme('light');
    await sleep(200);
    // A capture right after the theme changes can come back as a stale surface; this one is thrown away
    await app.screenshot(path.join(shots, 'window-light.png'));
    await app.evaluate(`document.querySelector('.pr-card[data-url="${PR(3)}"]').scrollIntoView({ block: 'center' })`);
    await app.screenshotOf(path.join(shots, 'pr-card-light.png'), `.pr-card[data-url="${PR(3)}"]`, 24);
    await app.evaluate(`document.querySelector('.doc-card').scrollIntoView({ block: 'center' })`);
    await app.screenshotOf(path.join(shots, 'doc-cards-light.png'), '.doc-card', 24);
    await app.screenshot(path.join(shots, 'window-light.png'));
    await theme('dark');
    await sleep(200);
    await app.screenshot(path.join(shots, 'window-dark.png'));
    await app.evaluate(`document.querySelector('.pr-card[data-url="${PR(3)}"]').scrollIntoView({ block: 'center' })`);
    await app.screenshotOf(path.join(shots, 'pr-card-dark.png'), `.pr-card[data-url="${PR(3)}"]`, 24);
    await app.evaluate(`document.querySelector('.doc-card').scrollIntoView({ block: 'center' })`);
    await app.screenshotOf(path.join(shots, 'doc-cards-dark.png'), '.doc-card', 24);
    await app.screenshot(path.join(shots, 'window-dark.png'));
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no errors in the window', errors.length === 0, errors);
    console.log(`screenshots: ${shots}`);
  } catch (err) {
    check('the run finished', false, err.stack || String(err));
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  done();
})();
