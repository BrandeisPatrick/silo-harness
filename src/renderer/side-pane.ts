// The side pane next to the transcript: the Browser, Diff and Terminal tabs (the mods' tabs join them through
// mods-host.ts), the rail that resizes it, the browser's URL bar, and the native browser view's bounds and visibility,
// which follow the pane because the view floats above the page. The browser's bars, interstitial and downloads tray
// are browser-bars.ts.

import type { BrowserState, ChangeDiff, ChangeEntry, ChangesApi, SiloHarnessApi, TerminalApi } from '../shared/types';
import { createBrowserBars } from './browser-bars.js';
import { createBrowserPane } from './browser-pane.js';
import { createChangesPane, mockChangesSource } from './changes.js';
import { byId } from './dom.js';
import type { ModPaneTabs } from './mods-host.js';
import { createTerminalPane, mockTerminalSource, type MockTerminalSource } from './terminal.js';
import { forgetFile } from './tools.js';
import { rpc } from './rpc.js';

/** A built-in tab, or a mod's tab view as 'mod:<mod key>/<view id>' (mods-host.ts makes those). */
export type PaneTab = 'browser' | 'diff' | 'terminal' | `mod:${string}`;

export interface SidePaneDeps {
  shell: HTMLElement;
  content: HTMLElement;
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

export function createSidePane({ shell, content: contentEl, browserView, dialogs, browser, changesApi, terminalApi, dialogOpen, pageOpen, focusComposer, showError, cleanError, confirm }: SidePaneDeps) {
  const sidePane = byId('side-pane');
  const browserPane = byId('browser-pane');
  const diffPane = byId('diff-pane');
  const paneTabBrowser = byId<HTMLButtonElement>('pane-tab-browser');
  const paneTabDiff = byId<HTMLButtonElement>('pane-tab-diff');
  const diffToggle = byId<HTMLButtonElement>('diff-toggle');
  const diffCountBadges = [byId('diff-count'), byId('pane-diff-count')];
  const terminalPaneEl = byId('terminal-pane');
  const paneTabTerminal = byId<HTMLButtonElement>('pane-tab-terminal');
  const terminalToggle = byId<HTMLButtonElement>('terminal-toggle');
  const terminalBusyDots = [byId('terminal-busy'), byId('pane-terminal-busy')];
  const urlEl = byId<HTMLInputElement>('url');
  const backBtn = byId<HTMLButtonElement>('back-btn');
  const fwdBtn = byId<HTMLButtonElement>('fwd-btn');
  const reloadBtn = byId<HTMLButtonElement>('reload-btn');
  const openExternalBtn = byId<HTMLButtonElement>('open-external-btn');
  const browserTitle = byId('browser-title');
  const browserToggle = byId<HTMLButtonElement>('browser-toggle');
  const resizer = byId('pane-resizer');
  const placeholder = browserView.querySelector<HTMLElement>('.browser-placeholder');
  /** The tab strip, the popups' state and the profile note (browser-pane.ts) */
  const browserTabs = createBrowserPane({
    strip: byId('browser-tabs'),
    newButton: byId<HTMLButtonElement>('browser-tab-new'),
    note: byId('browser-note'),
    noteClose: byId<HTMLButtonElement>('browser-note-close'),
    urlField: urlEl,
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
  const PANE_TABS: readonly (readonly [PaneTab, HTMLButtonElement])[] = [
    ['browser', paneTabBrowser],
    ['diff', paneTabDiff],
    ['terminal', paneTabTerminal],
  ];
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

  /** Every tab in strip order with its button: the built-in ones, then the mods'. */
  function paneTabList(): (readonly [PaneTab, HTMLButtonElement])[] {
    return [...PANE_TABS, ...(paneMods?.buttons() ?? []).map(({ key, el }) => [`mod:${key}` as PaneTab, el] as const)];
  }

  function browserShown(): boolean {
    return paneVisible && paneTab === 'browser' && !pageOpen();
  }

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

  /** The native browser view floats above the page: it is shown only while its tab is on screen and no dialog is open. */
  function syncBrowserView(): void {
    if (browserShown() && !dialogOpen() && !browserBars.overlayOpen()) {
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
    // A mod tab whose mod went off or away: back to the Browser.
    if (modTabKey(paneTab) && !paneMods?.has(modTabKey(paneTab)!)) paneTab = 'browser';
    const showBrowser = browserShown();
    const showDiff = paneVisible && paneTab === 'diff';
    const showTerminal = paneVisible && paneTab === 'terminal';
    if (!showBrowser) {
      browserBars.closeTray();
      setBrowserVisible(false);
    }
    // Focus would be lost with a hidden terminal: hand it back to the composer.
    if (!showTerminal && terminalPaneEl.contains(document.activeElement)) focusComposer();
    shell.classList.toggle('pane-hidden', !paneVisible);
    shell.classList.toggle('browser-hidden', !showBrowser);
    browserPane.hidden = paneTab !== 'browser';
    diffPane.hidden = paneTab !== 'diff';
    terminalPaneEl.hidden = paneTab !== 'terminal';
    for (const [tab, el] of PANE_TABS) {
      el.classList.toggle('active', paneTab === tab);
      el.setAttribute('aria-selected', String(paneTab === tab));
      el.tabIndex = paneTab === tab ? 0 : -1;
    }
    paneMods?.apply(modTabKey(paneTab), paneVisible);
    browserToggle.classList.toggle('active', showBrowser);
    browserToggle.setAttribute('aria-pressed', String(showBrowser));
    diffToggle.classList.toggle('active', showDiff);
    diffToggle.setAttribute('aria-pressed', String(showDiff));
    terminalToggle.classList.toggle('active', showTerminal);
    terminalToggle.setAttribute('aria-pressed', String(showTerminal));
    changesPane.setVisible(showDiff);
    terminalPane.setVisible(showTerminal);
    if (showBrowser) syncBrowserView();
    if (persist) {
      try {
        localStorage.setItem('pane', paneVisible ? 'shown' : 'hidden');
        localStorage.setItem('paneTab', paneTab);
      } catch {
        /* ignore */
      }
    }
  }

  /** The top-bar toggles: show the pane on that tab, or hide it when that tab is already showing. */
  function togglePane(tab: PaneTab): void {
    pendingModTab = null;
    if (paneVisible && paneTab === tab) paneVisible = false;
    else {
      paneVisible = true;
      paneTab = tab;
    }
    applyPane();
  }

  function showPaneTab(tab: PaneTab): void {
    pendingModTab = null;
    if (paneVisible && paneTab === tab) return;
    if (modTabKey(tab) && !paneMods?.has(modTabKey(tab)!)) return;
    paneVisible = true;
    paneTab = tab;
    applyPane();
  }

  /** The mod tabs changed: a tab remembered from the last run comes back once it exists; a vanished one falls back. */
  function paneTabsChanged(): void {
    const key = pendingModTab ? modTabKey(pendingModTab) : null;
    if (key && paneMods?.has(key)) {
      paneTab = pendingModTab!;
      pendingModTab = null;
    }
    applyPane(false);
  }

  /** The rail between the transcript and the pane opened, closed or was resized. */
  function paneLayoutChanged(): void {
    const stored = sidePane.style.getPropertyValue('--browser-w');
    if (stored) setBrowserWidth(parseFloat(stored));
    reportBounds();
    requestAnimationFrame(reportBounds);
  }

  browserToggle.onclick = () => togglePane('browser');
  diffToggle.onclick = () => togglePane('diff');
  terminalToggle.onclick = () => toggleTerminal();
  paneTabBrowser.onclick = () => showPaneTab('browser');
  paneTabDiff.onclick = () => showPaneTab('diff');
  paneTabTerminal.onclick = () => showPaneTab('terminal');
  byId('pane-close').onclick = () => {
    paneVisible = false;
    applyPane();
  };
  // ←/→ move between the pane tabs (the mods' ones too), wrapping around.
  sidePane.querySelector('.pane-tabs')!.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if ((ke.key !== 'ArrowLeft' && ke.key !== 'ArrowRight') || !(ke.target as HTMLElement).matches('[role="tab"]')) return;
    ke.preventDefault();
    const list = paneTabList();
    const at = Math.max(0, list.findIndex(([tab]) => tab === paneTab));
    const [next, nextEl] = list[(at + (ke.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
    showPaneTab(next);
    nextEl.focus();
  });

  // Diff tab
  let debugChanges: ChangesApi | null = null;

  function changesSource(): ChangesApi | null {
    if (debugChanges) return debugChanges;
    const api = changesApi();
    return api && typeof api.list === 'function' && typeof api.diff === 'function' ? api : null;
  }

  function setChangeCount(n: number): void {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    for (const badge of diffCountBadges) {
      badge.textContent = String(count);
      badge.hidden = count === 0;
    }
    const files = `${count} changed file${count === 1 ? '' : 's'}`;
    diffToggle.dataset.tip = count ? `Toggle diff · ${files}` : 'Toggle diff';
    paneTabDiff.setAttribute('aria-label', count ? `Diff, ${files}` : 'Diff');
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

  function setTerminalBusy(n: number): void {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    for (const dot of terminalBusyDots) dot.hidden = count === 0;
    terminalToggle.dataset.tip = count ? `Toggle terminal · ${count} running` : 'Toggle terminal';
    paneTabTerminal.setAttribute('aria-label', count ? `Terminal, ${count} running` : 'Terminal');
  }

  /** A link clicked in a terminal opens in the Browser pane. */
  function openTerminalLink(url: string): void {
    showPaneTab('browser');
    go(url, paneTabBrowser);
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

  /** ⌘⇧T and the top-bar toggle: show the terminal with the cursor in it, or hide it. */
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
    return Math.round(Math.max(BROWSER_MIN, Math.min(px, contentEl.clientWidth - TRANSCRIPT_MIN - resizer.offsetWidth - railW)));
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
    const blank = !s.url || s.url === 'about:blank';
    if (document.activeElement !== urlEl) urlEl.value = blank ? '' : s.url;
    browserTitle.textContent = s.title && s.title !== s.url ? s.title : s.loading && !blank ? 'Loading…' : '';
    backBtn.disabled = !s.canGoBack;
    fwdBtn.disabled = !s.canGoForward;
    openExternalBtn.disabled = blank;
    browserPane.classList.toggle('loading', s.loading);
    if (placeholder) placeholder.hidden = !blank;
  }
  browser.onState(applyBrowserState);
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
    if (e.target !== urlEl) {
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
    paneTab = savedTab === 'diff' || savedTab === 'terminal' ? savedTab : 'browser';
    const w = Number(localStorage.getItem('browserWidth'));
    if (w > 0) setBrowserWidth(w);
  }

  /** The pane's own chrome has the focus (the URL bar, the tab strip, a bar button): the browser's shortcuts apply. */
  function browserFocused(): boolean {
    return browserShown() && browserPane.contains(document.activeElement);
  }

  /** For the live checks (__oc_debug.mods.browser()): what was last sent to the native browser view, where its slot is, the tabs and popups */
  function browserDebug() {
    const r = browserView.getBoundingClientRect();
    return { ...browserSent, bounds: browserSent.bounds && { ...browserSent.bounds }, element: { x: r.left, y: r.top, width: r.width, height: r.height }, tab: paneTab, paneVisible, dialog: dialogOpen(), ...browserTabs.debug(), safety: browserBars.debug() };
  }

  return {
    changesPane,
    terminalPane,
    terminalSource,
    visible: () => paneVisible,
    tab: () => paneTab,
    showPaneTab,
    togglePane,
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
    /** ⌘⇧N, ⌘W and ⌘L while the pane's chrome has the focus (keys inside the page itself reach the main process) */
    newBrowserTab: () => void browserTabs.newTab(),
    closeBrowserTab: () => void browserTabs.closeActive(),
    focusUrl: () => browserTabs.focusUrl(),
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
