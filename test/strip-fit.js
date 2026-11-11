// How the side pane's strip shares its width (src/renderer/strip-fit.ts): natural widths when there is room, long
// titles shortened together but not below their least, then the quiet tools icon-only (all at once), then the quiet
// pages, then the overflow; the active tab keeps its title throughout. Run: node test/strip-fit.js
const path = require('node:path');
const fs = require('node:fs');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

(async () => {
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/strip-fit.js'), 'utf8');
  const { fitStrip } = await import('data:text/javascript,' + encodeURIComponent(src));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const gap = 2;
  // A long page title (active), a second page, Diff with a count, Terminal, a mod's pane
  const tabs = [
    { tool: false, active: true, full: 200, short: 112, icon: 32 },
    { tool: false, active: false, full: 180, short: 80, icon: 32 },
    { tool: true, active: false, full: 72, short: 72, icon: 50 },
    { tool: true, active: false, full: 92, short: 92, icon: 32 },
    { tool: true, active: false, full: 110, short: 80, icon: 32 },
  ];
  const used = (f) => sum(f.widths) + gap * (f.widths.length - 1);

  let f = fitStrip(tabs, 1000, gap);
  check('room for all: every tab at its natural width', JSON.stringify(f.widths) === JSON.stringify(tabs.map((t) => t.full)) && !f.iconOnly.some(Boolean), f);

  f = fitStrip(tabs, 560, gap);
  check('a little short: the long titles shorten under one cap, short titles stay whole, no icon-only tab', !f.iconOnly.some(Boolean) && f.widths[2] === 72 && f.widths[3] === 92 && used(f) <= 560 && f.widths[0] === f.widths[1], f);
  check('… the room is used (within a pixel a tab)', 560 - used(f) <= tabs.length, f);

  f = fitStrip(tabs, 420, gap);
  check('shorter still: the quiet tools show only their icon, all of them, the pages keep titles', JSON.stringify(f.iconOnly) === JSON.stringify([false, false, true, true, true]) && f.widths[2] === 50 && used(f) <= 420 && f.widths[1] >= 80, f);

  f = fitStrip(tabs, 300, gap);
  check('shorter still: the quiet pages too; the active tab keeps its title, at least its least width', JSON.stringify(f.iconOnly) === JSON.stringify([false, true, true, true, true]) && f.widths[0] >= 112 && used(f) <= 300, f);

  f = fitStrip(tabs, 150, gap);
  check('no room at all: everything at its least, the active tab titled (the strip scrolls)', JSON.stringify(f.iconOnly) === JSON.stringify([false, true, true, true, true]) && f.widths[0] === 112, f);

  const toolActive = tabs.map((t, i) => ({ ...t, active: i === 3 }));
  f = fitStrip(toolActive, 420, gap);
  check('an active tool tab keeps its title while the other tools are icons', f.iconOnly[3] === false && f.iconOnly[2] && f.iconOnly[4], f);

  check('no tabs: nothing to size', fitStrip([], 300, gap).widths.length === 0);
  done();
})();
