// The side pane next to the transcript: its one tab strip, where the browser's page tabs and the open tools (Diff,
// Terminal, each pane a mod adds through mods-host.ts) are all tabs in the order they were opened, the pane's toggle,
// the rail that resizes it, the browser's URL bar, the New tab page, and the native browser view's bounds and
// visibility, which follow the pane because the view floats above the page. The browser's bars, interstitial and
// downloads tray are browser-bars.ts; the find bar is browser-find.ts; the page tabs themselves are browser-pane.ts.

import type { BrowserState, ChangeDiff, ChangeEntry, ChangesApi, SiloHarnessApi, TerminalApi } from '../shared/types';
import { createBrowserBars } from './browser-bars.js';
import { createBrowserFind } from './browser-find.js';
import { createBrowserPane, hostOf } from './browser-pane.js';
import { createChangesPane, mockChangesSource } from './changes.js';
import { byId } from './dom.js';
import { icon } from './icons.js';
import type { ModPaneTabs } from './mods-host.js';
import { createNewTabPage, type NewTabTool } from './new-tab-page.js';
import { createTerminalPane, mockTerminalSource, type MockTerminalSource } from './terminal.js';
import { forgetFile } from './tools.js';
import { onPush, rpc } from './rpc.js';

/** A built-in tab, or a mod's tab view as 'mod:<mod key>/<view id>' (mods-host.ts makes those). */
export type PaneTab = 'browser' | 'diff' | 'terminal' | `mod:${string}`;

export interface SidePaneDeps {
  shell: HTMLElement;
  /** The main column: the chat and the pane share its width */
  main: HTMLElement;
  /** The slot the native browser view is glued to */
  browserView: HTMLElement;
  /** Dialogs that hide the browser view while open (their closing brings it back) */
  dialogs: HTMLDialogElement[];
  browser: SiloHarnessApi['browser'];
  /** oc.changes and oc.terminal, read when needed (an older main process may lack them) */
  changesApi(): ChangesApi | undefined;
  terminalApi(): TerminalApi | undefined;
  dialogOpen(): boolean;
  /** A page (Scheduled tasks, Dreaming) covers the main column: no browser view, no bounds */
  pageOpen(): boolean;
  focusComposer(): void;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
  confirm: Parameters<typeof createChangesPane>[0]['confirm'];
}

export function createSidePane({ shell, main: mainEl, browserView, dialogs, browser, changesApi, terminalApi, dialogOpen, pageOpen, focusComposer, showError, cleanError, confirm }: SidePaneDeps) {
  const sidePane = byId('side-pane');
  const browserPane = byId('browser-pane');
  const diffPane = byId('diff-pane');
  /** The strip's row (it drags the window where nothing is on it) and the tablist in it */
  const stripRow = sidePane.querySelector<HTMLElement>('.pane-strip')!;
  const strip = byId('pane-tabs');
  const newTabButton = byId<HTMLButtonElement>('browser-tab-new');
  const paneToggle = byId<HTMLButtonElement>('pane-toggle');
  const paneTabDiff = byId<HTMLButtonElement>('pane-tab-diff');
  const diffCountBadge = byId('pane-diff-count');
  const terminalPaneEl = byId('terminal-pane');
  const paneTabTerminal = byId<HTMLButtonElement>('pane-tab-terminal');
  const terminalBusyDot = byId('pane-terminal-busy');
  const urlEl = byId<HTMLInputElement>('url');
  const backBtn = byId<HTMLButtonElement>('back-btn');
  const fwdBtn = byId<HTMLButtonElement>('fwd-btn');
  const reloadBtn = byId<HTMLButtonElement>('reload-btn');
  const openExternalBtn = byId<HTMLButtonElement>('open-external-btn');
  const browserTitle = byId('browser-title');
  const resizer = byId('pane-resizer');
  /** The page tabs, the popups' state and the profile note (browser-pane.ts) */
  const browserTabs = createBrowserPane({
    strip,
    newButton: newTabButton,
    front: () => paneTab === 'browser',
    onTabs: () => arrangeStrip(),
    note: byId('browser-note'),
    noteClose: byId<HTMLButtonElement>('browser-note-close'),
    urlField: urlEl,
    zoomChip: byId<HTMLButtonElement>('zoom-chip'),
    popupNote: byId('browser-popup-note'),
    popupText: byId('browser-popup-note').querySelector<HTMLElement>('.browser-popup-text')!,
    popupShow: byId<HTMLButtonElement>('browser-popup-show'),
    popupClose: byId<HTMLButtonElement>('browser-popup-close'),
    showError,
    cleanError,
  });
  /** Find in page: the bar under the URL bar */
  const browserFind = createBrowserFind({
    bar: byId('browser-find'),
    input: byId<HTMLInputElement>('browser-find-input'),
    count: byId('browser-find-count'),
    prev: byId<HTMLButtonElement>('browser-find-prev'),
    next: byId<HTMLButtonElement>('browser-find-next'),
    close: byId<HTMLButtonElement>('browser-find-close'),
    showError,
    cleanError,
  });
  /** The permission and download bars, the certificate interstitial, the pill's mark and the downloads tray */
  const browserBars = createBrowserBars({
    bars: byId('browser-bars'),
    interstitial: byId('browser-interstitial'),
    urlIcon: byId('url-icon'),
    trayButton: byId<HTMLButtonElement>('downloads-btn'),
    tray: byId('downloads-pop'),
    // The tray's popover would sit under the native view: the view hides while it is open
    onOverlay: () => syncBrowserView(),
    showError,
    cleanError,
  });
  /** The user's own navigation from the pane's chrome: not an agent action (a download it starts just starts). */
  const go = (target: string, anchor: HTMLElement) => void rpc('browser.go', target).catch((err: unknown) => showError(anchor, `Couldn't open the page: ${cleanError(err)}`));

  let paneVisible = true;
  let paneTab: PaneTab = 'browser';
  /**
   * The strip in order: 'page:<id>' for a page tab, the tab itself for an open tool ('diff', 'terminal',
   * 'mod:<view key>'). New ones go last; the tools and their order are kept with the pane (localStorage 'paneTools').
   */
  let order: string[] = [];
  /** The first page tabs reported go before the tools a relaunch restored; later ones go last */
  let pagesPlaced = false;
  /** The mod tabs, once the mod host is up (setModTabs, from the feature wiring in renderer.ts) */
  let paneMods: ModPaneTabs | null = null;
  /** A mod tab that was in front at the last quit: it comes back once its mod has loaded, unless another tab was chosen first */
  let pendingModTab: PaneTab | null = null;
  try {
    const saved = localStorage.getItem('paneTab');
    if (saved?.startsWith('mod:')) pendingModTab = saved as PaneTab;
  } catch {
    /* ignore */
  }

  const modTabKey = (tab: PaneTab): string | null => (tab.startsWith('mod:') ? tab.slice(4) : null);
  const isPage = (entry: string) => entry.startsWith('page:');
  const isToolTab = (v: unknown): v is PaneTab => typeof v === 'string' && (v === 'diff' || v === 'terminal' || (v.startsWith('mod:') && v.length > 4));
  const isOpen = (tab: PaneTab) => order.includes(tab);

  /** A tool's tab element: the built-in buttons, or the one the mod host made for a mod's pane (null: not there yet) */
  function toolElement(tab: PaneTab): HTMLElement | null {
    if (tab === 'diff') return paneTabDiff;
    if (tab === 'terminal') return paneTabTerminal;
    const key = modTabKey(tab);
    return (key && paneMods?.tabs().find((t) => t.key === key)?.el) || null;
  }

  function entryElement(entry: string): HTMLElement | null {
    return isPage(entry) ? browserTabs.element(entry.slice(5)) : toolElement(entry as PaneTab);
  }

  /** The tabs drawn in the strip now, in order (a mod tab whose mod has not loaded yet is left out) */
  function drawnEntries(): string[] {
    return order.filter((e) => entryElement(e) !== null);
  }

  /** The strip's active tab: the browser's active page while the browser is in front, else the tool in front */
  function activeEntry(): string {
    return paneTab === 'browser' ? `page:${browserTabs.activeId()}` : paneTab;
  }

  /** Page tabs that came or went join or leave the order; the elements are put in it, closed tools after them, hidden. */
  function arrangeStrip(): void {
    const pages = browserTabs.ids();
    order = order.filter((e) => !isPage(e) || pages.includes(e.slice(5)));
    const fresh = pages.map((id) => `page:${id}`).filter((e) => !order.includes(e));
    if (fresh.length) order = pagesPlaced ? [...order, ...fresh] : [...fresh, ...order];
    if (pages.length) pagesPlaced = true;
    const shown = drawnEntries().map((e) => entryElement(e)!);
    const closed = [paneTabDiff, paneTabTerminal, ...(paneMods?.tabs().map((t) => t.el) ?? [])].filter((el) => !shown.includes(el));
    [...shown, ...closed].forEach((el, i) => {
      if (strip.children.item(i) !== el) strip.insertBefore(el, strip.children.item(i));
    });
    for (const el of closed) el.hidden = true;
    for (const el of shown) el.hidden = false;
    const active = entryElement(activeEntry());
    if (active && strip.scrollWidth > strip.clientWidth) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    markOverflow();
  }

  /** Which ends of the strip have tabs scrolled out of view (they fade there) */
  function markOverflow(): void {
    strip.classList.toggle('scroll-left', strip.scrollLeft > 1);
    strip.classList.toggle('scroll-right', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
  }
  strip.addEventListener('scroll', markOverflow, { passive: true });
  new ResizeObserver(markOverflow).observe(strip);

  function saveTools(): void {
    try {
      localStorage.setItem('paneTools', JSON.stringify(order.filter((e) => !isPage(e))));
    } catch {
      /* ignore */
    }
  }

  /** Puts a tool's tab in the strip (last), without bringing it forward. */
  function openTool(tab: PaneTab): void {
    if (tab === 'browser' || isOpen(tab)) return;
    order.push(tab);
    saveTools();
  }

  function browserShown(): boolean {
    return paneVisible && paneTab === 'browser' && !pageOpen();
  }

  /** The active page tab is blank: the New tab page shows in its place and the native view stays hidden. */
  let activeBlank = true;

  /** What was last sent to the native browser view (for the live checks: __oc_debug.mods.browser()) */
  const browserSent = { bounds: null as { x: number; y: number; width: number; height: number } | null, visible: false };

  function reportBounds(): void {
    if (shell.classList.contains('browser-hidden') || pageOpen()) return;
    const r = browserView.getBoundingClientRect();
    browserSent.bounds = { x: r.left, y: r.top, width: r.width, height: r.height };
    browser.setBounds(browserSent.bounds);
  }
  new ResizeObserver(reportBounds).observe(browserView);

  function setBrowserVisible(v: boolean): void {
    browserSent.visible = v;
    browser.setVisible(v);
  }

  /** The native browser view floats above the page: it is shown only while its tab is on screen with a page in it and no dialog is open. */
  function syncBrowserView(): void {
    if (browserShown() && !activeBlank && !dialogOpen() && !browserBars.overlayOpen()) {
      reportBounds();
      setBrowserVisible(true);
      requestAnimationFrame(reportBounds);
    } else setBrowserVisible(false);
  }

  // A dialog's own 'close' event is delivered with the next painted frame, and a window that is hidden or covered
  // may not paint one for a long time: the view it hid would stay hidden. The attribute change is reported at once.
  for (const d of dialogs) {
    new MutationObserver(() => {
      if (!d.open) syncBrowserView();
    }).observe(d, { attributes: true, attributeFilter: ['open'] });
  }

  function applyPane(persist = true): void {
    // A mod tab whose mod went off or away, or a tool that is not open: back to the browser.
    if (modTabKey(paneTab) && !paneMods?.has(modTabKey(paneTab)!)) paneTab = 'browser';
    if (paneTab !== 'browser' && !isOpen(paneTab)) paneTab = 'browser';
    const showBrowser = browserShown();
    const showDiff = paneVisible && paneTab === 'diff';
    const showTerminal = paneVisible && paneTab === 'terminal';
    if (!showBrowser) browserBars.closeTray();
    // Focus would be lost with a hidden terminal: hand it back to the composer.
    if (!showTerminal && terminalPaneEl.contains(document.activeElement)) focusComposer();
    shell.classList.toggle('pane-hidden', !paneVisible);
    shell.classList.toggle('browser-hidden', !showBrowser);
    browserPane.hidden = paneTab !== 'browser';
    diffPane.hidden = paneTab !== 'diff';
    terminalPaneEl.hidden = paneTab !== 'terminal';
    for (const [tab, el] of [['diff', paneTabDiff], ['terminal', paneTabTerminal]] as const) {
      el.classList.toggle('active', paneTab === tab);
      el.setAttribute('aria-selected', String(paneTab === tab));
    }
    paneMods?.apply(modTabKey(paneTab), paneVisible);
    // Page tabs look active only while the browser is in front
    browserTabs.refresh();
    arrangeStrip();
    // One tab in the strip is reachable with Tab: the active one
    const active = entryElement(activeEntry());
    for (const el of strip.querySelectorAll<HTMLElement>('[role="tab"]')) el.tabIndex = el === active ? 0 : -1;
    paneToggle.classList.toggle('active', paneVisible);
    paneToggle.setAttribute('aria-pressed', String(paneVisible));
    newTabPage.setShown(paneTab === 'browser' && activeBlank);
    changesPane.setVisible(showDiff);
    terminalPane.setVisible(showTerminal);
    syncBrowserView();
    if (persist) {
      try {
        localStorage.setItem('pane', paneVisible ? 'shown' : 'hidden');
        localStorage.setItem('paneTab', paneTab);
      } catch {
        /* ignore */
      }
      saveTools();
    }
  }

  /** The shortcuts (⌘⇧B, ⌘⇧D, ⌘⇧T): show the pane on that tab, or hide it when that tab is already showing. */
  function togglePane(tab: PaneTab): void {
    pendingModTab = null;
    if (paneVisible && paneTab === tab) {
      paneVisible = false;
      applyPane();
    } else showPaneTab(tab);
  }

  /** Shows the pane on a tab; a tool's tab joins the strip first if it is not there. */
  function showPaneTab(tab: PaneTab): void {
    pendingModTab = null;
    if (modTabKey(tab) && !paneMods?.has(modTabKey(tab)!)) return;
    if (paneVisible && paneTab === tab) return;
    openTool(tab);
    paneVisible = true;
    paneTab = tab;
    applyPane();
  }

  /** A click or a key on a tab: a page tab shows the browser on that page, a tool's tab shows the tool. */
  function activateEntry(entry: string): void {
    if (!isPage(entry)) return showPaneTab(entry as PaneTab);
    const id = entry.slice(5);
    showPaneTab('browser');
    if (id !== browserTabs.activeId()) void browserTabs.activate(id);
  }

  /** A tab's ×: the tab leaves the strip (a page closes; a tool only leaves, its terminals and mod keep running). The
   *  active one hands over to its left neighbour, or the right one when it has none. */
  function closeEntry(entry: string): void {
    const list = drawnEntries();
    const at = list.indexOf(entry);
    if (at < 0) return;
    const next = list[at - 1] ?? list[at + 1];
    const wasActive = paneVisible && entry === activeEntry();
    if (isPage(entry)) {
      if (wasActive && next) activateEntry(next);
      void browserTabs.closeTab(entry.slice(5));
      return;
    }
    order = order.filter((e) => e !== entry);
    if (paneTab === entry) {
      if (next) {
        paneTab = isPage(next) ? 'browser' : (next as PaneTab);
        if (isPage(next) && next.slice(5) !== browserTabs.activeId()) void browserTabs.activate(next.slice(5));
      } else paneTab = 'browser';
    }
    applyPane();
  }

  /** The mod tabs changed: a tab remembered from the last run comes back once it exists; a vanished one falls back. */
  function paneTabsChanged(): void {
    const key = pendingModTab ? modTabKey(pendingModTab) : null;
    if (key && paneMods?.has(key)) {
      if (isOpen(pendingModTab!)) paneTab = pendingModTab!;
      pendingModTab = null;
    }
    applyPane(false);
    newTabPage.refresh();
  }

  /** The rail between the transcript and the pane opened, closed or was resized. */
  function paneLayoutChanged(): void {
    const stored = sidePane.style.getPropertyValue('--browser-w');
    if (stored) setBrowserWidth(parseFloat(stored));
    reportBounds();
    requestAnimationFrame(reportBounds);
  }

  paneToggle.onclick = () => {
    pendingModTab = null;
    paneVisible = !paneVisible;
    applyPane();
  };
  newTabButton.onclick = () => newPageTab();

  /** + and ⌘⇧N: a blank page tab, last in the strip, in front. */
  function newPageTab(): void {
    showPaneTab('browser');
    void browserTabs.newTab();
  }

  const entryOf = (target: EventTarget | null) => (target as HTMLElement | null)?.closest<HTMLElement>('[data-tab]')?.dataset.tab ?? null;
  strip.addEventListener('click', (e) => {
    const entry = entryOf(e.target);
    if (!entry) return;
    if ((e.target as HTMLElement).closest('.tab-close')) closeEntry(entry);
    else activateEntry(entry);
  });
  // Middle-click closes a tab (and must not start autoscroll).
  strip.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  strip.addEventListener('auxclick', (e) => {
    const entry = entryOf(e.target);
    if (e.button !== 1 || !entry) return;
    e.preventDefault();
    closeEntry(entry);
  });
  // ←/→ (and Home/End) move across the whole strip, pages and tools alike; Delete closes the focused tab; Enter or
  // Space on a page tab activates it (a tool's tab is a button and clicks by itself).
  strip.addEventListener('keydown', (e) => {
    const entry = entryOf(e.target);
    if (!entry || e.metaKey || e.ctrlKey || e.altKey) return;
    const list = drawnEntries();
    const at = list.indexOf(entry);
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % list.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if ((e.key === 'Enter' || e.key === ' ') && isPage(entry)) {
      e.preventDefault();
      activateEntry(entry);
      return;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      closeEntry(entry);
      return;
    }
    if (next < 0 || at < 0) return;
    e.preventDefault();
    activateEntry(list[next]);
    entryElement(list[next])?.focus();
  });
  // A vertical wheel scrolls an overflowing strip sideways (no arrows).
  strip.addEventListener(
    'wheel',
    (e) => {
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    },
    { passive: false },
  );

  /** The New tab page: a row per tool; a click opens that tool's tab, and the blank tab it was in closes if another page is open. */
  const newTabPage = createNewTabPage({
    root: byId('new-tab-page'),
    tools: (): NewTabTool[] => [
      { tab: 'terminal', title: 'Terminal', iconHtml: icon('terminal'), kbd: '⌘ ⇧ T' },
      { tab: 'diff', title: 'Diff', iconHtml: icon('file-diff'), kbd: '⌘ ⇧ D', count: changeCount },
      ...(paneMods?.tabs() ?? []).map((t) => ({ tab: `mod:${t.key}`, title: t.title, iconHtml: t.el.querySelector('.tab-icon')?.innerHTML ?? '' })),
    ],
    open: (tab) => {
      const blank = browserTabs.activeId();
      showPaneTab(tab as PaneTab);
      if (tab === 'terminal') terminalPane.focus();
      if (browserTabs.ids().length > 1 && browserTabs.isBlank(blank)) void browserTabs.closeTab(blank);
    },
  });

  // Diff tab
  let debugChanges: ChangesApi | null = null;

  function changesSource(): ChangesApi | null {
    if (debugChanges) return debugChanges;
    const api = changesApi();
    return api && typeof api.list === 'function' && typeof api.diff === 'function' ? api : null;
  }

  /** The session's changed files; null until the first count came (a count at start-up opens nothing) */
  let changeCount = 0;
  let countKnown = false;

  function setChangeCount(n: number): void {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    diffCountBadge.textContent = String(count);
    diffCountBadge.hidden = count === 0;
    paneTabDiff.setAttribute('aria-label', count ? `Diff, ${count} changed file${count === 1 ? '' : 's'}` : 'Diff');
    // Files started changing: the Diff tab joins the strip, in the back
    const appears = countKnown && changeCount === 0 && count > 0 && !isOpen('diff');
    changeCount = count;
    countKnown = true;
    if (appears) {
      openTool('diff');
      applyPane();
    }
    newTabPage.refresh();
  }


  const changesPane = createChangesPane({
    root: diffPane,
    list: byId('change-list'),
    detail: byId('change-detail'),
    empty: byId('changes-empty'),
    source: changesSource,
    onCount: setChangeCount,
    onError: showError,
    confirm,
    cleanError,
    onReverted: (entry) => forgetFile(entry.path),
  });

  // Terminal tab
  let debugTerminal: MockTerminalSource | null = null;

  function terminalSource(): TerminalApi | null {
    if (debugTerminal) return debugTerminal;
    const api = terminalApi();
    return api && typeof api.list === 'function' && typeof api.create === 'function' && typeof api.onData === 'function' && typeof api.onTabs === 'function' ? api : null;
  }

  /** Terminals running a command; null until the first report (one at start-up opens nothing) */
  let busyCount: number | null = null;

  function setTerminalBusy(n: number): void {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    terminalBusyDot.hidden = count === 0;
    paneTabTerminal.setAttribute('aria-label', count ? `Terminal, ${count} running` : 'Terminal');
    // A terminal turned busy: the Terminal tab joins the strip, in the back
    const appears = busyCount === 0 && count > 0 && !isOpen('terminal');
    busyCount = count;
    if (appears) {
      openTool('terminal');
      applyPane();
    }
  }

  /** A link clicked in a terminal opens in the browser. */
  function openTerminalLink(url: string): void {
    showPaneTab('browser');
    go(url, urlEl);
  }

  const terminalPane = createTerminalPane({
    root: terminalPaneEl,
    strip: byId('terminal-tabs'),
    newButton: byId<HTMLButtonElement>('terminal-new'),
    host: byId('terminal-host'),
    empty: byId('terminal-empty'),
    source: terminalSource,
    onBusy: setTerminalBusy,
    onOpenUrl: openTerminalLink,
    onError: showError,
    cleanError,
  });

  /** ⌘⇧T: show the terminal with the cursor in it, or hide the pane. */
  function toggleTerminal(): void {
    togglePane('terminal');
    if (paneVisible && paneTab === 'terminal') terminalPane.focus();
  }

  /** ⌘T: a new shell tab (the Terminal pane is shown first). */
  function openNewTerminal(): void {
    showPaneTab('terminal');
    void terminalPane.newTab();
  }

  const BROWSER_MIN = 360;
  const TRANSCRIPT_MIN = 320;
  function clampBrowserWidth(px: number): number {
    // The mods' rail sits between the transcript and the pane: what it takes is not the pane's to have.
    const rail = document.getElementById('mod-rail');
    const railW = rail && !rail.hidden ? rail.offsetWidth : 0;
    return Math.round(Math.max(BROWSER_MIN, Math.min(px, mainEl.clientWidth - TRANSCRIPT_MIN - resizer.offsetWidth - railW)));
  }
  function setBrowserWidth(px: number | null): void {
    if (px === null) sidePane.style.removeProperty('--browser-w');
    else sidePane.style.setProperty('--browser-w', `${clampBrowserWidth(px)}px`);
  }
  window.addEventListener('resize', () => {
    const stored = sidePane.style.getPropertyValue('--browser-w');
    if (stored) setBrowserWidth(parseFloat(stored));
    reportBounds();
  });

  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startW = sidePane.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      setBrowserWidth(startW + (startX - ev.clientX));
      reportBounds();
    };
    const up = (ev: PointerEvent) => {
      if (resizer.hasPointerCapture(ev.pointerId)) resizer.releasePointerCapture(ev.pointerId);
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      resizer.removeEventListener('pointercancel', up);
      resizer.classList.remove('dragging');
      document.body.classList.remove('resizing');
      reportBounds();
      try {
        localStorage.setItem('browserWidth', String(Math.round(sidePane.getBoundingClientRect().width)));
      } catch {
        /* ignore */
      }
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
    resizer.addEventListener('pointercancel', up);
  });
  resizer.addEventListener('dblclick', () => {
    setBrowserWidth(null);
    try {
      localStorage.removeItem('browserWidth');
    } catch {
      /* ignore */
    }
    requestAnimationFrame(reportBounds);
  });

  function applyBrowserState(s: BrowserState): void {
    browserTabs.applyState(s);
    browserBars.applyState(s);
    browserFind.applyState(s);
    const blank = !s.url || s.url === 'about:blank';
    if (document.activeElement !== urlEl) urlEl.value = blank ? '' : s.url;
    // Centred in the pill while it is not being edited: the page's title, else its host
    browserTitle.textContent = blank ? '' : s.title && s.title !== s.url ? s.title : s.loading ? 'Loading…' : hostOf(s.url);
    backBtn.disabled = !s.canGoBack;
    fwdBtn.disabled = !s.canGoForward;
    openExternalBtn.disabled = blank;
    browserPane.classList.toggle('loading', s.loading);
    if (blank !== activeBlank) {
      activeBlank = blank;
      newTabPage.setShown(paneTab === 'browser' && blank);
      syncBrowserView();
    }
  }
  browser.onState(applyBrowserState);
  // A link from the chat opened in a new tab (Settings → Browser): the browser comes forward
  onPush('browser:show', () => showPaneTab('browser'));
  urlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go(urlEl.value, urlEl);
      urlEl.blur();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      urlEl.blur();
      void browser.state().then(applyBrowserState);
    }
  });
  urlEl.addEventListener('focus', () => urlEl.select());
  document.querySelector('.url-pill')!.addEventListener('mousedown', (e) => {
    // The zoom chip is a button of its own; the rest of the pill puts the cursor in the field
    if (e.target !== urlEl && !(e.target as HTMLElement).closest('#zoom-chip')) {
      e.preventDefault();
      urlEl.focus();
    }
  });
  backBtn.onclick = () => go('back', backBtn);
  fwdBtn.onclick = () => go('forward', fwdBtn);
  reloadBtn.onclick = () => go('reload', reloadBtn);
  openExternalBtn.onclick = async () => {
    try {
      if (typeof browser.openExternal !== 'function') throw new Error('No handler registered');
      await browser.openExternal();
    } catch (err) {
      showError(openExternalBtn, `Couldn't open the page: ${cleanError(err)}`);
    }
  };

  /** Keeps the native browser view glued to its slot while something animates the layout. */
  function trackBounds(ms: number): void {
    const end = performance.now() + ms;
    const step = () => {
      reportBounds();
      if (performance.now() < end) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Restores the pane from localStorage (the caller's try/catch covers a storage that throws). */
  function restore(): void {
    // 'browser' is the key older builds used for the pane's visibility
    const pane = localStorage.getItem('pane') ?? localStorage.getItem('browser');
    paneVisible = pane !== 'hidden';
    const savedTab = localStorage.getItem('paneTab');
    // The open tools in their order; a profile from before the strip had one tool tab: the one in front, if any
    let tools: PaneTab[] = isToolTab(savedTab) ? [savedTab] : [];
    const raw = localStorage.getItem('paneTools');
    if (raw !== null) {
      try {
        const list: unknown = JSON.parse(raw);
        tools = Array.isArray(list) ? [...new Set(list.filter(isToolTab))] : [];
      } catch {
        tools = [];
      }
    }
    order = [...order.filter(isPage), ...tools];
    paneTab = (savedTab === 'diff' || savedTab === 'terminal') && tools.includes(savedTab) ? savedTab : 'browser';
    if (pendingModTab && !tools.includes(pendingModTab)) pendingModTab = null;
    const w = Number(localStorage.getItem('browserWidth'));
    if (w > 0) setBrowserWidth(w);
  }

  /** The pane's own chrome has the focus (the strip, the URL bar, a bar button): the browser's shortcuts apply. */
  function browserFocused(): boolean {
    return browserShown() && (browserPane.contains(document.activeElement) || stripRow.contains(document.activeElement));
  }

  /** For the live checks (__oc_debug.mods.browser()): what was last sent to the native browser view, where its slot is, the tabs and popups */
  function browserDebug() {
    const r = browserView.getBoundingClientRect();
    const strip = drawnEntries().map((e) => {
      const el = entryElement(e)!;
      return { tab: e, title: el.querySelector('.tab-title')?.textContent ?? '', active: el.getAttribute('aria-selected') === 'true' };
    });
    return { ...browserSent, bounds: browserSent.bounds && { ...browserSent.bounds }, element: { x: r.left, y: r.top, width: r.width, height: r.height }, tab: paneTab, paneVisible, dialog: dialogOpen(), ...browserTabs.debug(), strip, tools: order.filter((e) => !isPage(e)), newTab: newTabPage.debug(), safety: browserBars.debug(), find: browserFind.debug() };
  }

  return {
    changesPane,
    terminalPane,
    terminalSource,
    visible: () => paneVisible,
    tab: () => paneTab,
    showPaneTab,
    togglePane,
    /** Closes a tab of the strip, as its × does: 'page:<id>', or a tool's tab */
    closeTab: (entry: string) => closeEntry(entry),
    toggleTerminal,
    openNewTerminal,
    /** The mod host is up: its tabs join the strip */
    setModTabs: (tabs: ModPaneTabs) => {
      paneMods = tabs;
    },
    paneTabsChanged,
    paneLayoutChanged,
    syncBrowserView,
    setBrowserVisible,
    reportBounds,
    trackBounds,
    applyPane,
    applyBrowserState,
    restore,
    browserDebug,
    browserFocused,
    /** ⌘⇧N, ⌘W, ⌘L, ⌘F, ⌘+ ⌘− ⌘0 and ⌥⌘I while the pane's chrome has the focus (keys inside the page itself reach the main process) */
    newBrowserTab: newPageTab,
    closeBrowserTab: () => void browserTabs.closeActive(),
    focusUrl: () => browserTabs.focusUrl(),
    openFind: () => browserFind.openBar(),
    zoomBrowser: (change: 'in' | 'out' | 'reset') => void browserTabs.zoom(change),
    browserDevTools: () => void browserTabs.devTools(),
    /** The one-time note about the browser's profile, when it is due */
    refreshBrowserNote: () => browserTabs.refreshNote(),
    /** The debug hook: the Diff pane from memory (null: the real tracker again) */
    mockChanges: (list: ChangeEntry[] | null, diffs: Record<string, Partial<ChangeDiff>> = {}) => {
      debugChanges = list ? mockChangesSource(list, diffs) : null;
      changesPane.reset();
    },
    /** The debug hook: an in-memory fake shell (true) or the real terminal again (false) */
    mockTerminal: (on: boolean, cwd?: string) => {
      debugTerminal?.dispose();
      debugTerminal = on ? mockTerminalSource(cwd) : null;
      terminalPane.reset();
    },
  };
}
