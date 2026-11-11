// How the side pane's strip shares its width among its tabs (side-pane.ts measures the tabs and applies the answer).
// As room runs out: every tab at its natural width, 200 px at most; then long titles shorten together under one cap,
// never below about six characters (a title of eight or fewer is never cut); then the quiet tool tabs (Diff, Terminal,
// mod panes) show only their icon, all of them at once; then the quiet page tabs too; then the strip scrolls. The
// active tab always keeps its title. Pure, so the unit suite can check it without a window.

export interface FitTab {
  /** A tool's tab (Diff, Terminal, a mod's pane) rather than a page tab */
  tool: boolean;
  active: boolean;
  /** The tab with its title whole (the caller caps it at 200 px) */
  full: number;
  /** The narrowest it may get with a title: about six characters and an ellipsis, or `full` for a short title */
  short: number;
  /** With its icon only (and its count, when it has one) */
  icon: number;
}

export interface Fit {
  /** Each tab's width in px, in the order given */
  widths: number[];
  /** Which tabs show their icon only */
  iconOnly: boolean[];
}

/** The tab widths for `room` px of strip with `gap` px between two tabs. */
export function fitStrip(tabs: FitTab[], room: number, gap: number): Fit {
  const free = room - gap * Math.max(0, tabs.length - 1);
  // The steps in order; the last one that fits (or the last one at all) wins
  const steps: ((t: FitTab) => boolean)[] = [() => false, (t) => t.tool && !t.active, (t) => !t.active];
  for (let i = 0; i < steps.length; i++) {
    const iconOnly = tabs.map(steps[i]);
    const fixed = tabs.reduce((sum, t, j) => sum + (iconOnly[j] ? t.icon : 0), 0);
    const text = tabs.filter((_, j) => !iconOnly[j]);
    const need = text.reduce((sum, t) => sum + t.short, 0);
    if (fixed + need > free && i < steps.length - 1) continue;
    const cap = capFor(text, free - fixed);
    return { widths: tabs.map((t, j) => (iconOnly[j] ? t.icon : widthUnder(t, cap))), iconOnly };
  }
  return { widths: [], iconOnly: [] };
}

const widthUnder = (t: FitTab, cap: number) => Math.max(t.short, Math.min(t.full, cap));

/** The widest common cap under which the titled tabs fit in `room` (they never go under their `short`). */
function capFor(tabs: FitTab[], room: number): number {
  const total = (cap: number) => tabs.reduce((sum, t) => sum + widthUnder(t, cap), 0);
  let hi = Math.max(0, ...tabs.map((t) => t.full));
  if (total(hi) <= room) return hi;
  let lo = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (total(mid) <= room) lo = mid;
    else hi = mid;
  }
  return lo;
}
