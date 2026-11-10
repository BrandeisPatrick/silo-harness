// Each session's own browser tabs, headless: the per-session store (session-tabs.ts) with plain objects standing in
// for the controllers, and the window-wide pieces feature.ts builds from every session's tabs (the agents' acting for
// downloads, an asking download of a session not on screen). The real thing: test/live/session-tabs.js.
// Run: npm run build && node test/session-tabs.js
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (f) => require(path.join(projectDir, 'dist/main', f));
const { SessionTabs, NO_TABS } = dist('browser/session-tabs.js');
const { mergedStamps, markElsewhere } = dist('browser/feature.js');
const { check, done } = require('./support/check.js');

/** A stand-in for a session's controller: it records what the store tells it. */
function fakeSet(sessionId, inFront) {
  return { sessionId, inFront, bounds: null, visible: null, disposed: false, pristine: true, tabs: [`${sessionId}-tab`], calls: [], isPristine() { return this.pristine; }, setInFront(f) { this.inFront = f; this.calls.push(f ? 'front' : 'back'); }, setBounds(b) { this.bounds = b; }, setVisible(v) { this.visible = v; }, hasTab(id) { return this.tabs.includes(id); }, dispose() { this.disposed = true; } };
}

(async () => {
  const made = [];
  const store = new SessionTabs('A', {
    make: (id, inFront) => {
      const s = fakeSet(id, inFront);
      made.push(s);
      return s;
    },
  });

  // ---------- 1. A session's set is made when it is needed ----------
  check('1: no set until one is asked for', store.of('A', false) === null && store.current() === null && made.length === 0);
  check('1: the state with no window set is empty (no tabs, nothing active)', NO_TABS.tabs.length === 0 && NO_TABS.activeId === '' && NO_TABS.url === '');
  store.setBounds({ x: 10, y: 20, width: 600, height: 500 });
  store.setVisible(true);
  const a = store.current(true);
  check('1: made on first use, in front, with the pane bounds and visibility already known', a && a.sessionId === 'A' && a.inFront === true && a.bounds.width === 600 && a.visible === true);
  check('1: asked again, the same set (not a second one)', store.of('A') === a && made.length === 1);
  const b = store.of('B');
  check('1: a background session gets a set of its own, not in front', b && b !== a && b.inFront === false && b.bounds.width === 600 && made.length === 2);
  check('1: an empty session id makes nothing', store.of('') === null && made.length === 2);

  // ---------- 2. Switching session swaps the set in front ----------
  a.pristine = false;
  b.pristine = false;
  store.setFront('B');
  check('2: B comes forward, A (with a page) is parked', store.frontId() === 'B' && b.inFront && !a.inFront && a.calls.join() === 'back' && b.calls.join() === 'front' && !a.disposed);
  check('2: the set in front is listed first', store.all()[0] === b && store.all().length === 2);
  store.setFront('C');
  const c = store.current();
  check('2: a session without a set comes forward: it gets one (its blank tab), in front', c && c.sessionId === 'C' && c.inFront && !b.inFront && made.length === 3 && c.bounds.width === 600);
  store.setFront('C');
  check('2: the same session again changes nothing', made.length === 3 && c.calls.length === 0);
  store.setFront('B');
  check('2: leaving a session whose set is only its untouched blank tab drops that set', c.disposed && store.of('C', false) === null && b.inFront);
  store.setBounds({ x: 0, y: 0, width: 800, height: 700 });
  store.setVisible(false);
  check('2: bounds and visibility reach every set, in front or not', a.bounds.width === 800 && b.bounds.width === 800 && a.visible === false && b.visible === false);

  // ---------- 3. Whose tab is it ----------
  check('3: a tab is found with its session', store.owner('B-tab')?.sessionId === 'B' && store.owner('B-tab')?.set === b && store.owner('nope') === null);

  // ---------- 4. Deleting a session closes its tabs ----------
  store.close('B');
  const b2 = store.of('B', false);
  check('4: the deleted session in front: its set is closed and a blank one takes its place', b.disposed && b2 && b2 !== b && b2.inFront && store.sessions().sort().join() === 'A,B');
  store.close('A');
  check('4: a background session deleted: its set closed', a.disposed && store.of('A', false) === null && store.sessions().join() === 'B');
  const c1 = store.of('C1');
  const c2 = store.of('C2');
  store.closeAll();
  check('4: closing every set (the window went) makes none again', c1.disposed && c2.disposed && b2.disposed && store.sessions().length === 0);
  const again = store.of('C1');
  check('4: a session used again after its set closed starts a new, empty one', again && again !== c1 && !again.disposed);

  // ---------- 5. Window-wide pieces ----------
  const m = mergedStamps([
    { inFlight: 0, lastEnd: 100 },
    { inFlight: 2, lastEnd: 50 },
  ]);
  check("5: the agents' acting across sessions: any one acting counts, the latest end", m.inFlight === 2 && m.lastEnd === 100, m);
  check('5: no sets: nothing acting', JSON.stringify(mergedStamps([])) === JSON.stringify({ inFlight: 0, lastEnd: 0 }));
  const list = [
    { id: 'd1', asking: true, tabId: 'tab-1' },
    { id: 'd2', asking: true, tabId: 'tab-2' },
    { id: 'd3', asking: false, tabId: 'tab-2' },
    { id: 'd4', asking: true, tabId: null },
  ];
  const marked = markElsewhere(list, (tabId) => tabId === 'tab-2');
  check("5: an asking download from a background session's tab waits (elsewhere); the rest are unchanged", marked[1].elsewhere === true && !('elsewhere' in marked[0]) && !('elsewhere' in marked[2]) && !('elsewhere' in marked[3]) && marked[0] === list[0] && !('elsewhere' in list[1]), marked);

  process.exit(done());
})();
