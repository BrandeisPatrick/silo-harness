// Live check of the sidebar and the task card in the real window (through the rig): a profile seeded with sessions
// across today, the last days and older, two families (a parent with two forks, one forked again; a parent with two
// sub-sessions, one merged), an unread one and long titles. Checks groups, nesting and order; collapsing a group and a
// parent, remembered across a relaunch; rename; fork from the menu (nested under its source); deleting a parent (its
// children become roots); search (titles, and conversation hits through the debug fakes); the menu's Export and Merge
// entries (fakes); keyboard navigation; one real message (spinner in its row); the task card (under the latest message,
// stays last, follows the session). Screenshots in light and dark.
//
//   npm run build && node test/live/sidebar.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'oa-sidebar-shots');
const DAY = 86_400_000;

function seed(profile) {
  const dir = path.join(profile, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const start = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
  // Times inside today stay before now even just after midnight
  const today = (frac) => start + Math.floor((now - start) * frac);
  const daysAgo = (n, h = 12) => start - n * DAY + h * 3_600_000;
  const msgs = (title) => [
    { role: 'user', content: `Work on: ${title}` },
    { role: 'assistant', content: `Done with ${title}. The login flow was the slow part.` },
  ];
  const s = (id, title, createdAt, updatedAt, extra = {}) => ({ id, title, createdAt, updatedAt, titleLocked: true, messages: msgs(title), ...extra });
  const list = [
    s('fam-a', 'Refactor the payment service so retries are idempotent and logged', daysAgo(3, 9), daysAgo(3, 9)),
    s('fam-a-f1', 'Refactor the payment service (fork)', daysAgo(3, 10), daysAgo(2, 10), { forkedFrom: 'fam-a', origin: 'fork', seedLength: 2 }),
    s('fam-a-f2', 'Try the queue-based approach', daysAgo(3, 11), today(0.6), { forkedFrom: 'fam-a', origin: 'fork', seedLength: 2 }),
    s('fam-a-f1-f', 'Payment retries, second try', daysAgo(2, 11), daysAgo(2, 11), { forkedFrom: 'fam-a-f1', origin: 'fork', seedLength: 2 }),
    s('today-1', 'Write the release notes', today(0.8), today(0.8), {
      unread: true,
      tasks: [
        { id: '1', title: 'Collect merged changes', status: 'completed' },
        { id: '2', title: 'Draft the notes', status: 'in_progress' },
        { id: '3', title: 'Ask for review', status: 'pending' },
      ],
    }),
    s('today-2', 'A very long session title that keeps on going well past the edge of the sidebar', today(0.4), today(0.4)),
    s('fam-b', 'reverse benchmark', daysAgo(1, 9), daysAgo(1, 9)),
    s('fam-b-s1', 'social media', daysAgo(1, 10), daysAgo(1, 10), { parentId: 'fam-b', origin: 'spawn' }),
    s('fam-b-s2', 'collect numbers', daysAgo(1, 11), daysAgo(1, 11), { parentId: 'fam-b', origin: 'spawn', mergedInto: 'fam-b' }),
    s('y-1', 'Fix the flaky upload test', daysAgo(1, 15), daysAgo(1, 15)),
    s('d2-1', 'tcg', daysAgo(2, 14), daysAgo(2, 14)),
    s('d2-2', 'Rename the config keys', daysAgo(2, 8), daysAgo(2, 8)),
    s('d4-1', 'Profile the search index', daysAgo(4, 12), daysAgo(4, 12)),
    s('d5-1', 'Nightly dependency check', daysAgo(5, 3), daysAgo(5, 3), { origin: 'schedule' }),
    s('old-1', 'Sketch the onboarding flow', daysAgo(10), daysAgo(10)),
    s('old-2', 'Port the CLI to the new parser', daysAgo(40), daysAgo(40)),
  ];
  for (const x of list) fs.writeFileSync(path.join(dir, `${x.id}.json`), JSON.stringify(x));
  const label = (ts) => {
    const d = new Date(ts);
    return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}${d.getFullYear() === new Date(now).getFullYear() ? '' : `, ${d.getFullYear()}`}`;
  };
  return { count: list.length, labels: ['Today', label(daysAgo(1)), label(daysAgo(2)), label(daysAgo(4)), label(daysAgo(5)), 'Older'], yesterday: label(daysAgo(1)) };
}

(async () => {
  const { check, done } = checker();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-sidebar-'));
  const seeded = seed(profile);
  fs.mkdirSync(SHOTS, { recursive: true });
  let app = null;
  const state = () => app.evaluate('window.__oc_debug.sidebar.state()');
  const sessionsOf = async () => (await state()).rows.filter((r) => r.kind === 'session');
  const theme = (t) => app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(t)}`);
  const shot = async (name, selector, margin = 0) => {
    for (const t of ['light', 'dark']) {
      await theme(t);
      await sleep(120);
      if (selector) await app.screenshotOf(path.join(SHOTS, `${name}-${t}.png`), selector, margin);
      else await app.screenshot(path.join(SHOTS, `${name}-${t}.png`));
    }
    await theme('light');
  };
  const menuItem = async (rowSelector, label) => {
    await app.evaluate(`document.querySelector(${JSON.stringify(rowSelector + ' .row-more')}).click()`);
    await app.waitFor(`[...document.querySelectorAll('.popover .pop-item')].some((b) => b.innerText.trim().startsWith(${JSON.stringify(label)}))`, 5000, `menu item ${label}`);
    await app.evaluate(`[...document.querySelectorAll('.popover .pop-item')].find((b) => b.innerText.trim().startsWith(${JSON.stringify(label)})).click()`);
  };
  const menuLabels = async (rowSelector) => {
    await app.evaluate(`document.querySelector(${JSON.stringify(rowSelector + ' .row-more')}).click()`);
    await app.waitFor(`document.querySelectorAll('.popover .pop-item').length > 0`, 5000, 'the menu');
    const labels = await app.evaluate(`[...document.querySelectorAll('.popover .pop-item')].map((b) => b.innerText.trim().split('\\n')[0])`);
    await app.key('Escape');
    await sleep(100);
    return labels;
  };
  const row = (id) => `.session-item[data-id="${id}"]`;
  try {
    app = await launch({ profile, size: { width: 1280, height: 860 } });
    await app.waitFor(`document.querySelectorAll('.session-item').length >= 12`, 10_000, 'the seeded sessions');
    await app.evaluate('window.__oc_debug.sidebar.resetCollapse()');
    await sleep(150);

    // ---- groups, nesting, order ----
    let st = await state();
    const groups = st.rows.filter((r) => r.kind === 'group');
    check('groups: Today, one per day, Older last', JSON.stringify(groups.map((g) => g.label)) === JSON.stringify(seeded.labels), groups.map((g) => g.label));
    check('Older is collapsed by default', groups.find((g) => g.label === 'Older')?.collapsed === true && !(await app.exists(row('old-1'))));
    let ss = await sessionsOf();
    const order = ss.map((r) => r.id);
    const fa = order.indexOf('fam-a');
    check('the payment family sits in Today (placed by its newest fork)', fa > 0 && order.indexOf('today-1') > -1 && st.rows.findIndex((r) => r.id === 'fam-a') < st.rows.findIndex((r) => r.kind === 'group' && r.label === seeded.yesterday));
    check('forks nest under their source, oldest first, a fork of a fork one deeper', JSON.stringify(order.slice(fa, fa + 4)) === '["fam-a","fam-a-f1","fam-a-f1-f","fam-a-f2"]' && JSON.stringify(ss.slice(fa, fa + 4).map((r) => r.depth)) === '[0,1,2,1]', ss.slice(fa, fa + 4));
    const fb = order.indexOf('fam-b');
    check('sub-sessions nest under their parent', JSON.stringify(order.slice(fb, fb + 3)) === '["fam-b","fam-b-s1","fam-b-s2"]' && ss[fb + 1].depth === 1 && ss[fb + 1].parent === 'fam-b');
    check('families ordered by newest activity (Today: the new session first, then the payment family)', order.indexOf('today-1') < fa ? true : order[0] !== 'fam-a', order.slice(0, 6));
    check('the unread session has the blue dot', ss.find((r) => r.id === 'today-1')?.indicator === 'unread' && (await app.exists(`${row('today-1')} .status-dot.unread`)));
    check('a parent shows the fork glyph; a scheduled run the lightning in front of its title, nothing at the end', ss.find((r) => r.id === 'fam-a')?.indicator === 'family' && ss.find((r) => r.id === 'd5-1')?.lead === 'schedule' && ss.find((r) => r.id === 'd5-1')?.indicator === null && ss.find((r) => r.id === 'fam-a')?.lead === null);
    check('the long title ends in an ellipsis inside the row', await app.evaluate(`(() => { const l = document.querySelector('${row('today-2')} .label'); return l.scrollWidth > l.clientWidth && l.getBoundingClientRect().right <= document.querySelector('${row('today-2')}').getBoundingClientRect().right; })()`));
    // The merge mark: sessions.merge (another feature) is what sets mergedInto; until it lands the meta does not carry
    // it, so the debug overlay supplies it.
    const mergedFromMain = ss.find((r) => r.id === 'fam-b-s2')?.merged;
    if (!mergedFromMain) await app.evaluate(`window.__oc_debug.sidebar.mock({ metas: { 'fam-b-s2': { mergedInto: 'fam-b' } } })`);
    check('the merged sub-session is dimmed with a tag', await app.waitFor(`Boolean(document.querySelector('${row('fam-b-s2')}.merged .merged-tag'))`, 3000), mergedFromMain ? 'from the main process' : 'through the debug overlay');
    const geo = await app.evaluate(`(() => { const r = document.querySelector('${row('fam-a-f1')}').getBoundingClientRect(); const p = document.querySelector('${row('fam-a')} .label').getBoundingClientRect(); const e = document.querySelector('${row('fam-a-f1')} .tree-line.elbow').getBoundingClientRect(); const l = document.querySelector('${row('fam-a-f1')} .label').getBoundingClientRect(); return { h: r.height, elbowX: e.left, parentText: p.left, childText: l.left, elbowRight: e.right, top: e.top, rowTop: r.top }; })()`);
    check('rows are 32 px with a 2 px gap; the elbow starts at the parent text and ends before the child text', geo.h === 32 && geo.elbowX >= geo.parentText && geo.elbowX <= geo.parentText + 8 && geo.elbowRight <= geo.childText && geo.top < geo.rowTop, geo);
    await shot('sidebar-full', '#sidebar');

    // ---- collapse a group and a parent; remembered across a relaunch ----
    await app.click(`.session-group[data-group="${seeded.yesterday}"]`);
    await app.click(`${row('fam-a')} .tree-toggle`);
    await sleep(150);
    ss = await sessionsOf();
    check('a collapsed group hides its sessions', !ss.some((r) => r.id === 'fam-b' || r.id === 'y-1'));
    check('a collapsed parent hides its family and shows the count', !ss.some((r) => r.id === 'fam-a-f1') && ss.find((r) => r.id === 'fam-a')?.collapsed && ss.find((r) => r.id === 'fam-a')?.count === '3', ss.find((r) => r.id === 'fam-a'));
    await shot('sidebar-collapsed-family', '#sidebar');
    await app.close();
    app = null;
    app = await launch({ profile, size: { width: 1280, height: 860 } });
    await app.waitFor(`document.querySelectorAll('.session-item').length >= 8`, 10_000, 'the sessions after the relaunch');
    await sleep(200);
    st = await state();
    check('after a relaunch the group is still collapsed', st.rows.find((r) => r.kind === 'group' && r.label === seeded.yesterday)?.collapsed === true);
    check('after a relaunch the parent is still collapsed', st.rows.find((r) => r.id === 'fam-a')?.collapsed === true && !st.rows.some((r) => r.id === 'fam-a-f1'));
    await app.click(`.session-group[data-group="${seeded.yesterday}"]`);
    await app.click(`${row('fam-a')} .tree-toggle`);
    await sleep(150);
    check('expanding shows them again', (await app.exists(row('fam-a-f1'))) && (await app.exists(row('fam-b'))));
    if (!(await app.exists(`${row('fam-b-s2')}.merged`))) await app.evaluate(`window.__oc_debug.sidebar.mock({ metas: { 'fam-b-s2': { mergedInto: 'fam-b' } } })`);

    // ---- keyboard ----
    await app.evaluate(`document.querySelector('${row('fam-a-f1')}').focus()`);
    await app.key('ArrowDown');
    check('ArrowDown moves to the next visible row', (await app.evaluate('document.activeElement.dataset.id')) === 'fam-a-f1-f');
    await app.key('ArrowDown');
    await app.key('ArrowLeft');
    check('Left on a child goes to its parent', (await app.evaluate('document.activeElement.dataset.id')) === 'fam-a');
    await app.key('ArrowLeft');
    check('Left on a parent collapses it', (await app.evaluate(`document.querySelector('${row('fam-a')}').classList.contains('collapsed')`)) && (await app.evaluate('document.activeElement.dataset.id')) === 'fam-a');
    await app.key('ArrowRight');
    check('Right expands it again', !(await app.evaluate(`document.querySelector('${row('fam-a')}').classList.contains('collapsed')`)));
    await app.key('ArrowUp');
    const up = await app.evaluate('document.activeElement.dataset.id || document.activeElement.dataset.group');
    check('ArrowUp moves to the row above', up && up !== 'fam-a', up);
    await app.key('Enter');
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${JSON.stringify(up)} || ${JSON.stringify(up)} === 'Today'`, 5000, 'Enter to open');
    check('Enter opens the focused session', true);

    // ---- rename in place ----
    await app.evaluate(`document.querySelector('${row('d2-2')}').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await app.waitFor(`Boolean(document.querySelector('${row('d2-2')} .rename-input'))`, 3000, 'the rename field');
    await app.fill(`${row('d2-2')} .rename-input`, 'Renamed config keys');
    await app.key('Enter');
    await app.waitFor(`document.querySelector('${row('d2-2')} .label')?.innerText === 'Renamed config keys'`, 5000, 'the new title');
    check('rename in place', true);

    // ---- the menu: Export and Merge (fakes, the RPCs belong to other features) ----
    const real = await state();
    let labels = await menuLabels(row('fam-a-f2'));
    check(`menu without the RPCs: ${labels.join(', ')}`, labels.includes('Rename') && labels.includes('Fork') && labels.includes('Delete') && labels.includes('Export…') === real.has.export && labels.some((l) => l.startsWith('Merge')) === real.has.merge, real.has);
    await app.evaluate(`window.__oc_debug.sidebar.mock({ export: '/tmp/payment.md', merge: { ok: false, error: 'Stop the session first.' }, metas: { 'fam-b-s2': { mergedInto: 'fam-b' } } })`);
    labels = await menuLabels(row('fam-a-f2'));
    check('with the fakes the menu has Export… and Merge into "<parent>"', labels.includes('Export…') && labels.some((l) => /^Merge into "Refactor the payment/.test(l)), labels);
    labels = await menuLabels(row('fam-b-s2'));
    check('a merged sub-session offers no merge', !labels.some((l) => l.startsWith('Merge')), labels);
    labels = await menuLabels(row('d2-1'));
    check('a root offers no merge', !labels.some((l) => l.startsWith('Merge')), labels);
    await menuItem(row('fam-a-f2'), 'Merge into');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000, 'the merge confirmation');
    check('merge asks first', /Merge into/.test(await app.text('#confirm-title')));
    await app.click('#confirm-ok');
    await app.waitFor(`Boolean(document.querySelector('.inline-error'))`, 3000, 'the merge error');
    check('a failed merge shows the error it returned', /Stop the session first/.test(await app.text('.inline-error')));
    await app.evaluate(`window.__oc_debug.sidebar.mock({ merge: { ok: true } })`);
    await menuItem(row('fam-a-f2'), 'Merge into');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000, 'the merge confirmation');
    await app.click('#confirm-ok');
    await app.waitFor(`Boolean(document.querySelector('${row('fam-a-f2')}.merged'))`, 3000, 'the merged mark');
    check('a merge that worked marks the row merged', true);
    await menuItem(row('fam-a-f2'), 'Export…');
    await app.waitFor(`/Exported payment\\.md/.test(document.querySelector('#status-flash')?.innerText || '')`, 3000, 'the export flash');
    check('export says where it went', true);
    await app.evaluate(`document.querySelector('.inline-error')?.remove()`);
    await app.evaluate(`window.__oc_debug.sidebar.mock(null)`);

    // ---- fork from the menu: nested under its source ----
    await menuItem(row('d2-1'), 'Fork');
    await app.waitFor(`(() => { const a = document.querySelector('.session-item.active'); return a && a.dataset.parent === 'd2-1'; })()`, 10_000, 'the fork on screen, nested');
    const forkId = await app.evaluate(`document.querySelector('.session-item.active').dataset.id`);
    ss = await sessionsOf();
    check('fork: the new row is nested under its source, right after it', ss[ss.findIndex((r) => r.id === 'd2-1') + 1]?.id === forkId && ss.find((r) => r.id === forkId).depth === 1);

    // ---- delete a parent: its children become roots ----
    await app.evaluate('window.confirm = () => true');
    await menuItem(row('fam-b'), 'Delete');
    await app.waitFor(`!document.querySelector('${row('fam-b')}')`, 5000, 'the parent to go');
    ss = await sessionsOf();
    check('delete a parent: its sub-sessions are roots now', ss.find((r) => r.id === 'fam-b-s1')?.depth === 0 && ss.find((r) => r.id === 'fam-b-s2')?.depth === 0);

    // ---- search ----
    await app.click('#search-row');
    check('the Search row turns into the focused field', (await app.evaluate(`!document.querySelector('#search-field').hidden && document.querySelector('#search-row').hidden && document.activeElement.id === 'session-search'`)));
    await app.fill('#session-search', 'pay');
    await sleep(80);
    st = await state();
    const titled = st.rows.filter((r) => r.kind === 'result').map((r) => r.id);
    check('titles filter immediately', titled.includes('fam-a') && titled.includes('fam-a-f1') && !titled.includes('tcg') && st.rows.every((r) => r.kind !== 'session'), titled);
    check('the title match is highlighted', st.rows.find((r) => r.kind === 'result')?.mark?.toLowerCase() === 'pay');
    await app.evaluate(`window.__oc_debug.sidebar.mock({ search: [{ sessionId: 'y-1', title: 'Fix the flaky upload test', updatedAt: Date.now(), role: 'assistant', snippet: 'The login flow was the slow part, so the upload waited on it.', matchStart: 4, matchEnd: 9, count: 2 }, { sessionId: 'nope', title: 'Gone', updatedAt: 1, role: 'user', snippet: 'login', matchStart: 0, matchEnd: 5, count: 1 }] })`);
    await app.fill('#session-search', 'login');
    await app.waitFor(`window.__oc_debug.sidebar.state().rows.some((r) => r.kind === 'result' && r.id === 'y-1')`, 3000, 'the conversation hit');
    st = await state();
    const hit = st.rows.find((r) => r.id === 'y-1');
    check('a conversation hit shows its title, the snippet and the highlighted match', hit.title === 'Fix the flaky upload test' && /slow part/.test(hit.snippet) && hit.mark === 'login', hit);
    check('a hit for a session that is not in the list is left out', !st.rows.some((r) => r.id === 'nope'));
    await shot('search-results', '#sidebar');
    await app.key('ArrowDown');
    await app.key('Enter');
    await app.waitFor(`document.querySelector('.search-result.active')`, 5000, 'the result opened');
    check('Enter on a result opens that session', true);
    await app.evaluate(`window.__oc_debug.sidebar.mock({ search: [] })`);
    await app.fill('#session-search', 'zebra crossing');
    await app.waitFor(`window.__oc_debug.sidebar.state().rows.some((r) => r.kind === 'empty' && /No sessions match/.test(r.text))`, 3000, 'the empty result');
    check('an empty result says so', true);
    await app.evaluate(`document.querySelector('#session-search').focus()`);
    await app.key('Escape');
    check('Esc with text clears it', (await app.evaluate(`document.querySelector('#session-search').value`)) === '' && (await app.count('.session-item')) > 5);
    await app.key('Escape');
    check('Esc when empty turns it back into the row', await app.evaluate(`document.querySelector('#search-field').hidden && !document.querySelector('#search-row').hidden`));
    await app.evaluate(`window.__oc_debug.sidebar.mock(null)`);

    // ---- footer ----
    const foot = await app.evaluate(`(() => { const c = document.querySelector('#model-chip'); const l = document.querySelector('#model-label'); return { text: l.innerText, fits: l.getBoundingClientRect().right <= document.querySelector('#shortcuts-btn').getBoundingClientRect().left, settings: Boolean(document.querySelector('.sidebar-foot #settings-btn')), shortcuts: Boolean(document.querySelector('.sidebar-foot #shortcuts-btn')) }; })()`);
    check('footer: the model chip, shortcuts and settings', / · (Portkey|Gateway|Ollama)$/.test(foot.text) && foot.fits && foot.settings && foot.shortcuts, foot);
    await shot('footer', '.sidebar-foot', 4);
    const navs = await app.evaluate(`[...document.querySelectorAll('.sidebar-nav .nav-row')].filter((b) => !b.hidden).map((b) => b.innerText.split('\\n')[0])`);
    check('navigation rows', navs[0] === 'New session' && navs[1] === 'Search' && navs.includes('Scheduled') && navs.includes('Customize'), navs);
    // Scheduled opens its page in the main column, the row selected and no session; a session row takes the column back
    await app.click('#scheduled-row');
    await app.waitFor(`document.querySelector('.shell').classList.contains('page-open')`, 5000, 'the Scheduled page');
    check('Scheduled: the page in the main column, its row selected, no session selected', await app.evaluate(`document.querySelector('#scheduled-row').classList.contains('active') && document.querySelector('#scheduled-row').getAttribute('aria-current') === 'page' && !document.querySelector('.session-item.active') && document.querySelector('#page-title')?.textContent === 'Scheduled tasks'`));
    await shot('scheduled-row-selected', '.sidebar', 0);
    await app.click(row('today-2'));
    await app.waitFor(`!document.querySelector('.shell').classList.contains('page-open')`, 5000, 'the chat view');
    check('a session chosen in the sidebar takes the column back', await app.evaluate(`document.querySelector('.session-item.active')?.dataset.id === 'today-2' && !document.querySelector('#scheduled-row').classList.contains('active')`));

    // ---- the task card: the session's tasks under its latest message ----
    await app.click(row('today-1'));
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === 'today-1'`, 5000, 'the session with tasks');
    await app.waitFor(`Boolean(document.querySelector('#messages > #task-list:not([hidden])'))`, 5000, 'its task card');
    const lastCheck = `(() => { const card = document.querySelector('#messages > #task-list'); const others = [...document.querySelectorAll('#messages > *')].filter((e) => e !== card && e.id !== 'empty-state' && !e.hidden); return others.every((e) => e.getBoundingClientRect().bottom <= card.getBoundingClientRect().top + 0.5); })()`;
    check('the session\'s tasks show as a card under its latest message', await app.evaluate(lastCheck));
    check('the card has the three row states and no header', JSON.stringify(await app.evaluate(`[...document.querySelectorAll('#task-list .task-row')].map((r) => r.dataset.status)`)) === '["completed","in_progress","pending"]' && !(await app.exists('#task-list .task-head')));
    check('unread cleared once opened', !(await app.exists(`${row('today-1')} .status-dot.unread`)));
    await app.evaluate(`window.__oc_debug.user('One more thing'); window.__oc_debug.renderMarkdown('Sure, here is **more** text.')`);
    await sleep(100);
    check('the card stays last as messages arrive', await app.evaluate(lastCheck));
    await shot('task-card', '#task-list', 12);
    await app.evaluate(`window.__oc_debug.tasks([{ id: '1', title: 'Collect merged changes', status: 'completed' }, { id: '2', title: 'Draft the notes', status: 'completed' }, { id: '3', title: 'Ask for review', status: 'completed' }])`);
    check('all done: the card stays, muted', await app.exists('#task-list.all-done:not([hidden])'));
    await shot('task-card-done', '#task-list', 12);
    await app.click(row('y-1'));
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === 'y-1'`, 5000, 'another session');
    check('another session without tasks: no card', !(await app.exists('#messages > #task-list')));
    await app.click(row('today-1'));
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === 'today-1' && Boolean(document.querySelector('#messages > #task-list:not([hidden])'))`, 5000, 'the card back with its session');
    check('switching back shows that session\'s tasks again', (await app.count('#task-list .task-row')) === 3);
    await app.evaluate('window.__oc_debug.tasks(null)');
    check('an empty list hides the card', !(await app.exists('#messages > #task-list')));
    await shot('window', null);

    // ---- one real message: the row spins while it runs ----
    await app.click('#new-session-btn');
    await app.waitFor(`document.querySelector('.session-item.active .label')?.innerText === 'New session'`, 5000, 'a new session');
    if (!app.live) app.mock.state.replies.push({ content: 'OK', delayMs: 700 }); // slow enough for the spinner to be seen
    await app.send('Reply with the single word OK.');
    const spun = await app.waitFor(`Boolean(document.querySelector('.session-item.active.running .trail .spinner'))`, 15_000, 'the spinner in the row').catch(() => false);
    check(`the row shows the spinner while it runs (${app.live ? 'real API' : 'mock model'})`, spun);
    await app.waitIdle();
    check('the run ended and the row stopped spinning', !(await app.exists('.session-item.running')) && /OK/i.test(await app.lastReply()), await app.lastReply());

    const errors = app.console.filter((l) => /\[(error|exception)\]/.test(l));
    check('no errors in the console', errors.length === 0, errors.slice(0, 5));
  } catch (err) {
    check(`crashed: ${err.message}`, false);
    if (app) console.log(app.console.slice(-15).join('\n'));
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})();
