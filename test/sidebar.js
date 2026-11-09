// The sidebar's pure logic (src/renderer/sidebar-model.ts): day groups around midnight and across a month, "Older",
// families placed by their newest member, nesting by forkedFrom and parentId, depth, orphans, a cycle in bad data,
// ordering stability, the indicator priority, and search-result shaping. Run: node test/sidebar.js
//
// The renderer compiles to ES modules in dist/renderer. sidebar-model.js imports types only, so its source is loaded
// as a data: module (an import() of the .js path works too, but Node then warns about the package having no "type").
const path = require('node:path');
const fs = require('node:fs');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

(async () => {
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/sidebar-model.js'), 'utf8');
  const M = await import('data:text/javascript,' + encodeURIComponent(src));
  const { dayGroup, shortDate, buildTree, groupFamilies, visibleRows, indicatorFor, leadFor, shapeResults, cleanSnippet, matchRange, ancestorsOf, groupOf, titleMatches } = M;

  const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo, d, h, mi).getTime();

  // ---------- Day groups ----------
  const now = at(2026, 10, 5, 0, 5); // Nov 5, 00:05
  check('a minute after midnight is Today', dayGroup(at(2026, 10, 5, 0, 1), now) === 'Today');
  check('a minute before midnight is yesterday, labelled by its date', dayGroup(at(2026, 10, 4, 23, 59), now) === 'Nov 4');
  check('midnight itself is Today', dayGroup(at(2026, 10, 5, 0, 0), now) === 'Today');
  check('six days before is its own day', dayGroup(at(2026, 9, 30, 9), now) === 'Oct 30', dayGroup(at(2026, 9, 30, 9), now));
  check('seven days before is Older', dayGroup(at(2026, 9, 29, 23, 59), now) === 'Older');
  check('the future counts as Today', dayGroup(at(2026, 10, 6, 10), now) === 'Today');
  const march = at(2026, 2, 2, 8); // Mar 2 (across a month boundary, and February is short)
  check('across a month boundary: Mar 1 and Feb 28', dayGroup(at(2026, 2, 1, 1), march) === 'Mar 1' && dayGroup(at(2026, 1, 28, 23), march) === 'Feb 28');
  check('across a month boundary: Feb 24 is the sixth day before', dayGroup(at(2026, 1, 24, 0, 0), march) === 'Feb 24' && dayGroup(at(2026, 1, 23, 23, 59), march) === 'Older');
  const jan = at(2027, 0, 2, 9);
  check('across a year: Dec 31 is labelled with its year', dayGroup(at(2026, 11, 31, 22), jan) === 'Dec 31, 2026', dayGroup(at(2026, 11, 31, 22), jan));
  check('shortDate in the same year has no year', shortDate(at(2026, 10, 3), now) === 'Nov 3');

  // ---------- The tree ----------
  let t = 0;
  const meta = (id, o = {}) => ({ id, title: o.title ?? id, createdAt: o.createdAt ?? ++t, updatedAt: o.updatedAt ?? o.createdAt ?? t, messageCount: 1, ...o });
  const today = (h) => at(2026, 10, 5, h);
  const N = at(2026, 10, 5, 23); // Nov 5, 23:00
  const list = [
    meta('p', { createdAt: at(2026, 10, 1, 9), updatedAt: at(2026, 10, 1, 9) }), // old parent ...
    meta('f1', { forkedFrom: 'p', origin: 'fork', createdAt: at(2026, 10, 1, 10), updatedAt: at(2026, 10, 2, 10) }),
    meta('f2', { forkedFrom: 'p', origin: 'fork', createdAt: at(2026, 10, 1, 11), updatedAt: today(15) }), // ... whose newest member is today
    meta('f1a', { forkedFrom: 'f1', origin: 'fork', createdAt: at(2026, 10, 2, 11), updatedAt: at(2026, 10, 2, 11) }),
    meta('q', { createdAt: at(2026, 10, 3, 9), updatedAt: at(2026, 10, 3, 9) }),
    meta('s1', { parentId: 'q', origin: 'spawn', createdAt: at(2026, 10, 3, 10), updatedAt: at(2026, 10, 3, 10) }),
    meta('s2', { parentId: 'q', origin: 'spawn', mergedInto: 'q', createdAt: at(2026, 10, 3, 11), updatedAt: at(2026, 10, 3, 12) }),
    meta('orphan', { forkedFrom: 'gone', origin: 'fork', createdAt: at(2026, 10, 4, 9), updatedAt: at(2026, 10, 4, 9) }),
    meta('solo', { createdAt: today(9), updatedAt: today(9) }),
    meta('old', { createdAt: at(2026, 8, 1), updatedAt: at(2026, 8, 1) }),
  ];
  const roots = buildTree(list);
  const ids = (nodes) => nodes.map((n) => n.meta.id);
  check('roots: families newest activity first, orphan is a root', JSON.stringify(ids(roots)) === JSON.stringify(['p', 'solo', 'orphan', 'q', 'old']), ids(roots));
  const p = roots[0];
  check('forks nest under their source, oldest first', JSON.stringify(ids(p.children)) === '["f1","f2"]');
  check('a fork of a fork nests one deeper', p.children[0].children[0]?.meta.id === 'f1a' && p.children[0].children[0].depth === 2);
  check('sub-sessions nest by parentId', JSON.stringify(ids(roots.find((r) => r.meta.id === 'q').children)) === '["s1","s2"]');
  check('descendants count the whole family', p.descendants === 3);
  check('family activity is its newest member', p.activity === today(15));

  const groups = groupFamilies(roots, N);
  check('groups: Today, the days before newest first, Older last', JSON.stringify(groups.map((g) => g.label)) === JSON.stringify(['Today', 'Nov 4', 'Nov 3', 'Older']), groups.map((g) => g.label));
  check('a family is placed by its newest member (the Nov 1 parent shows under Today)', groups[0].families.some((f) => f.meta.id === 'p'));
  check('Older collects what is a week or more old', groups[3].families.length === 1 && groups[3].families[0].meta.id === 'old');

  // Stability: the order does not depend on the order of the input, and children do not jump when they get busy
  const shuffled = [...list].reverse();
  check('the tree does not depend on the input order', JSON.stringify(ids(buildTree(shuffled))) === JSON.stringify(ids(roots)));
  const busier = list.map((m) => (m.id === 'f1' ? { ...m, updatedAt: today(22) } : m));
  check('a child that becomes the newest keeps its place among its siblings', JSON.stringify(ids(buildTree(busier)[0].children)) === '["f1","f2"]');

  // Depth and a long chain
  const chain = [meta('c0', { createdAt: 1 })];
  for (let i = 1; i <= 6; i++) chain.push(meta(`c${i}`, { createdAt: 1 + i, forkedFrom: `c${i - 1}` }));
  const rowsChain = visibleRows(chain, { now: N, groupCollapsed: () => false, parentCollapsed: () => false }).filter((r) => r.kind === 'session');
  check('deep chains keep their depth', rowsChain.map((r) => r.depth).join() === '0,1,2,3,4,5,6');
  check('indent stops growing after three levels', rowsChain.map((r) => r.indent).join() === '0,1,2,3,3,3,3');

  // A cycle in bad data does not hang and leaves every session on screen exactly once
  const cyc = [meta('x', { forkedFrom: 'z', createdAt: 1 }), meta('y', { forkedFrom: 'x', createdAt: 2 }), meta('z', { forkedFrom: 'y', createdAt: 3 }), meta('self', { forkedFrom: 'self', createdAt: 4 })];
  const cycRows = visibleRows(cyc, { now: N, groupCollapsed: () => false, parentCollapsed: () => false }).filter((r) => r.kind === 'session');
  check('a cycle ends: every session appears once', cycRows.map((r) => r.meta.id).sort().join() === 'self,x,y,z', cycRows.map((r) => r.meta.id));
  check('a cycle is cut where it closes (z, the newest of the loop, becomes the root)', cycRows.find((r) => r.meta.id === 'z').depth === 0 && cycRows.find((r) => r.meta.id === 'y').depth === 2);
  check('a session that names itself as parent is a root', cycRows.find((r) => r.meta.id === 'self').depth === 0);
  check('ancestorsOf, nearest first', JSON.stringify(ancestorsOf(list, 'f1a')) === '["f1","p"]');
  check('groupOf follows the family', groupOf(list, 'f1a', N) === 'Today' && groupOf(list, 's1', N) === 'Nov 3');

  // ---------- Visible rows ----------
  const opts = (o = {}) => ({ now: N, currentId: 'solo', groupCollapsed: (l) => l === 'Older', parentCollapsed: () => false, ...o });
  const rows = visibleRows(list, opts());
  const shape = rows.map((r) => (r.kind === 'group' ? `[${r.label}]` : `${'  '.repeat(r.depth)}${r.meta.id}`));
  check('rows: groups and the tree in order, Older collapsed', JSON.stringify(shape) === JSON.stringify(['[Today]', 'p', '  f1', '    f1a', '  f2', 'solo', '[Nov 4]', 'orphan', '[Nov 3]', 'q', '  s1', '  s2', '[Older]']), shape);
  const row = (id, rs = rows) => rs.find((r) => r.kind === 'session' && r.meta.id === id);
  check('connector: f1 is not last (its line runs on), f2 is last', row('f1').last === false && row('f2').last === true);
  check('rails: f1a gets the line of f1 running past it to f2', JSON.stringify(row('f1a').rails) === '[1]', row('f1a').rails);
  check('the merged sub-session is marked merged', row('s2').merged === true && row('s1').merged === false);
  const collapsedP = visibleRows(list, opts({ parentCollapsed: (id) => id === 'p' }));
  check('a collapsed parent hides its family and shows the count', !row('f1', collapsedP) && row('p', collapsedP).collapsed && row('p', collapsedP).indicator.kind === 'family' && row('p', collapsedP).indicator.count === 3);
  check('a collapsed group shows only its label', visibleRows(list, opts({ groupCollapsed: (l) => l === 'Today' || l === 'Older' }))[1].kind === 'group');
  const hotRows = visibleRows(list, opts({ parentCollapsed: (id) => id === 'p', status: (id) => (id === 'f1a' ? { running: true } : undefined) }));
  check('a collapsed parent with a running session inside is hot', row('p', hotRows).indicator.hot === true);

  // ---------- Indicator priority ----------
  const m0 = meta('m', { origin: 'fork', forkedFrom: 'p' });
  const ind = (st, o) => indicatorFor(m0, st, o)?.kind ?? null;
  check('running beats everything', ind({ running: true, attention: 'approval', unread: true }) === 'running');
  check('waiting for the user beats unread', ind({ running: false, attention: 'plan', unread: true }) === 'attention');
  check('unread beats the kind glyph', ind({ running: false, unread: true }) === 'unread');
  check('unread is not shown for the session on screen', ind({ running: false, unread: true }, { current: true }) === 'fork');
  check('a parent shows the family glyph', ind({ running: false }, { children: 2 }) === 'family');
  check('a fork shows the fork glyph', ind({ running: false }) === 'fork');
  check('a sub-session shows its glyph; a scheduled run nothing at the end (its lightning is in front)', indicatorFor(meta('s', { origin: 'spawn', parentId: 'q' }), { running: false })?.kind === 'spawn' && indicatorFor(meta('r', { origin: 'schedule' }), undefined) === null);
  check('a scheduled run shows unread and waiting like any session', indicatorFor(meta('r2', { origin: 'schedule' }), { running: false, unread: true })?.kind === 'unread' && indicatorFor(meta('r3', { origin: 'schedule' }), { running: false, attention: 'approval' })?.kind === 'attention');
  check('a dream: the dot while it waits, else nothing at the end; unread still shows', indicatorFor(meta('dw', { origin: 'dream', dream: { id: 'x', waiting: 2 } }), { running: false })?.kind === 'dream' && indicatorFor(meta('dn', { origin: 'dream', dream: { id: 'x', waiting: 0 } }), { running: false }) === null && indicatorFor(meta('du', { origin: 'dream', dream: { id: 'x', waiting: 0 } }), { running: false, unread: true })?.kind === 'unread');
  check('the lead: lightning for a scheduled run, the moon for a dream, nothing for the rest', leadFor(meta('l1', { origin: 'schedule' })) === 'schedule' && leadFor(meta('l2', { origin: 'dream' })) === 'dream' && leadFor(meta('l3', { origin: 'user' })) === null && leadFor(meta('l4', { origin: 'fork' })) === null);
  check('a plain session shows nothing', indicatorFor(meta('u', { origin: 'user' }), { running: false }) === null);
  check('the status on the meta is used when none is passed', indicatorFor(meta('v', { status: { running: true } }), undefined)?.kind === 'running');

  // ---------- Search ----------
  const sm = [
    meta('a', { title: 'Fix the login bug', updatedAt: 30 }),
    meta('b', { title: 'Login page redesign', updatedAt: 20 }),
    meta('c', { title: 'Benchmarks', updatedAt: 40 }),
    meta('d', { title: 'Docs', updatedAt: 10 }),
  ];
  check('title matching: every word, any case', titleMatches('Fix the login bug', 'LOGIN fix') && !titleMatches('Fix the login bug', 'login page'));
  const r0 = shapeResults('login', sm, null);
  check('titles filter at once, newest first', r0.map((r) => r.id).join() === 'a,b' && r0[0].titleMatch?.join() === '8,13');
  const hits = [
    { sessionId: 'c', title: 'Benchmarks', updatedAt: 40, role: 'assistant', snippet: '…the  login\nflow is slow…', matchStart: 6, matchEnd: 11, count: 3 },
    { sessionId: 'b', title: 'Login page redesign', updatedAt: 20, role: 'user', snippet: 'the login form', matchStart: 4, matchEnd: 9, count: 1 },
    { sessionId: 'zz', title: 'Gone', updatedAt: 50, role: 'user', snippet: 'login', matchStart: 0, matchEnd: 5, count: 1 },
    { sessionId: 'd', title: 'Docs', updatedAt: 10, role: 'tool', snippet: 'login', matchStart: 0, matchEnd: 5, count: 1, trashed: true },
  ];
  const r1 = shapeResults('login', sm, hits);
  check('content matches follow the title matches; unknown and trashed sessions are left out', r1.map((r) => r.id).join() === 'a,b,c', r1.map((r) => r.id));
  check('one result per session; a title match takes its session\'s snippet', r1.filter((r) => r.id === 'b').length === 1 && r1[1].snippet?.text === 'the login form' && r1[1].role === 'user');
  check('a content-only match has no title highlight', r1[2].titleMatch === null && r1[2].count === 3);
  const sn = r1[2].snippet;
  check('snippets are one line with the match offsets kept', sn.text === '…the login flow is slow…' && sn.text.slice(sn.start, sn.end) === 'login', sn);
  const bad = cleanSnippet({ snippet: 'abc', matchStart: 10, matchEnd: -4 });
  check('match offsets out of range are clamped', bad.start === 3 && bad.end === 3);
  check('an empty snippet gives none', cleanSnippet({ snippet: '   ', matchStart: 0, matchEnd: 1 }) === null);
  check('the highlight is the whole query when it occurs, else its first word', matchRange('Login page', 'login page')?.join() === '0,10' && matchRange('page Login', 'login x')?.join() === '5,10');
  check('an empty query has no results', shapeResults('   ', sm, hits).length === 0);
  check('no match at all: an empty list', shapeResults('zebra', sm, []).length === 0);

  done();
})().catch((err) => {
  console.log('FAIL crashed', err && err.stack);
  process.exit(1);
});
