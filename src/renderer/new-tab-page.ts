// The New tab page: what a blank page tab shows in the browser's slot (the native view hides for a blank tab, so this
// is plain DOM). One heading, "Tools", and a row per tool the strip can open (Terminal, Diff, each pane a mod adds) with
// its icon, its name and its shortcut; Diff carries the changed-file count. side-pane.ts says what the tools are and
// what a click does.

import { escapeHtml } from './dom.js';

export interface NewTabTool {
  /** The pane tab it opens: 'terminal', 'diff' or 'mod:<view key>' */
  tab: string;
  title: string;
  /** The icon's markup, as the tool's tab draws it */
  iconHtml: string;
  /** The shortcut's keys as the tooltips write them ("⌘ ⇧ T"), when it has one */
  kbd?: string;
  /** A count beside the name (Diff's changed files) */
  count?: number;
}

export interface NewTabPageDeps {
  root: HTMLElement;
  tools(): NewTabTool[];
  open(tab: string): void;
}

export function createNewTabPage({ root, tools, open }: NewTabPageDeps) {
  /** What is drawn now: drawn again only when that changes (a row under the pointer keeps its hover) */
  let drawnKey = '';

  function render(): void {
    const list = tools();
    const key = JSON.stringify(list);
    if (key === drawnKey) return;
    drawnKey = key;
    const rows = list
      .map(
        (t) =>
          `<button type="button" class="ntp-row" data-tool="${escapeHtml(t.tab)}">` +
          `<span class="ntp-icon" aria-hidden="true">${t.iconHtml}</span>` +
          `<span class="ntp-name">${escapeHtml(t.title)}</span>` +
          (t.count ? `<span class="count-badge ntp-count">${t.count}</span>` : '') +
          (t.kbd ? `<kbd class="ntp-kbd">${escapeHtml(t.kbd.replace(/ /g, ''))}</kbd>` : '') +
          `</button>`,
      )
      .join('');
    root.innerHTML = `<div class="ntp-col"><h2 class="ntp-head" id="ntp-tools">Tools</h2><div class="ntp-grid" role="group" aria-labelledby="ntp-tools">${rows}</div></div>`;
  }

  root.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.ntp-row');
    if (row?.dataset.tool) open(row.dataset.tool);
  });

  return {
    /** Shows the page (drawn from the tools as they are now) or hides it */
    setShown(shown: boolean): void {
      if (shown) render();
      root.hidden = !shown;
    },
    /** The tools changed (a mod's pane came or went, Diff's count): drawn again while it shows */
    refresh(): void {
      if (!root.hidden) render();
    },
    debug: () => ({ shown: !root.hidden, rows: [...root.querySelectorAll<HTMLElement>('.ntp-row')].map((r) => ({ tool: r.dataset.tool ?? '', name: r.querySelector('.ntp-name')?.textContent ?? '', kbd: r.querySelector('.ntp-kbd')?.textContent ?? '' })) }),
  };
}
