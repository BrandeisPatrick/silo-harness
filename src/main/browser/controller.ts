// The Browser pane's controller: it owns the tabs (at most MAX_TABS; one is active and on screen, the others keep
// their pages hidden), places the active tab's view where the window's pane is, hands popups to popups.ts, and does
// what the browser_* tools ask, on the active tab and nothing else (browser_tabs switches). Every change is pushed
// to the window as a BrowserState. For the browser's safety it also stamps the agent's actions (a download that
// begins during one is the agent's and asks), hides a tab stopped at a certificate error behind the pane's
// interstitial, and knows which tab a popup belongs to (its permission requests and downloads are that tab's).

import { app, clipboard, dialog, webContents as allContents, type BrowserWindow, type ContextMenuParams, type WebContents, type WindowOpenHandlerResponse } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Bounds, BrowserState, FindResultState, PopupState, TabState } from '../../shared/browser';
import { aimScript, describeScript, fieldKindScript, flashScript, getTextScript, passwordFieldScript, readPageScript, REF_RE, scrollScript, selectAllScript, targetScript, waitScript } from './page-scripts';
import { CHANGED_UNDER_CLICK, CREDENTIAL_REFUSAL, sameClickTarget, type ClickTarget } from './policy';
import { fencePage } from './fence';
import { DEFAULT_READ, readPiece } from './paging';
import { leavesArtifact, opensInTab, PopupManager } from './popups';
import { fieldPhrase, frameCheckScript, inSafetyWorld, SAFETY_WORLD, typedSecretMessage } from './safety';
import { BrowserTab, type TabShortcut } from './tab';
// Polish: the right click, find in page and zoom per site
import { searchUrl, showContextMenu, type ContextAction } from './context-menu';
import { applySavedZoom, stepZoom, type ZoomChange } from './zoom';
// Browser safety: the certificate interstitial, the agent's downloads, the permission bar's tabs
import type { CertErrorState } from '../../shared/browser';
import { certificateSentence, proceeded } from './certificates';
import { sanitizeFilename, startedByAgent, type ActingStamps } from './downloads';
import { ownerTabId } from './permissions';

export const MAX_TABS = 12;
/** The outline is built up to this many characters (refs for every element in it); a read returns a piece of it. */
const OUTLINE_MAX = 400_000;
/** A screenshot for the model: JPEG at this quality, its longest side at most MODEL_SHOT_MAX CSS pixels. */
const MODEL_SHOT_QUALITY = 70;
const MODEL_SHOT_MAX = 1280;
export const TOO_MANY_TABS = `Close a tab first: the browser keeps at most ${MAX_TABS}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEY_MAP: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
};

/**
 * What the URL bar (and browser_navigate) makes of what was typed: a URL as it is, a path relative to the current
 * page, a bare host with https://, anything else a DuckDuckGo search.
 */
export function resolveTarget(input: string, current: string): string {
  let url = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const looksLikePath = /^(\.{1,2}\/|\/)/.test(url) || (/^[\w.-]+(\/[\w.-]*)*\.[a-z0-9]{1,5}(\?.*)?(#.*)?$/i.test(url) && !/\.(com|org|net|io|dev|ai|co|edu|gov|app)(\/|$)/i.test(url));
  if (current && current !== 'about:blank' && looksLikePath) {
    try {
      return new URL(url, current).href;
    } catch {
      /* fall through */
    }
  }
  return /\s/.test(url) || !url.includes('.') ? `https://duckduckgo.com/?q=${encodeURIComponent(url)}` : `https://${url}`;
}

/**
 * Listeners on every controller's tabs (feature.ts): a tab's main frame committed a new page (the permission bar's
 * "this time" answers end when it leaves the site), and a tab closed.
 */
export const tabEvents = {
  navigated: new Set<(tabId: string, url: string, contentsId: number) => void>(),
  closed: new Set<(tabId: string) => void>(),
};

export interface BrowserControllerOptions {
  /** The state changed (pushed to the window as browser:state) */
  onState(state: BrowserState): void;
  /** The popups over the pane changed (browser:popups) */
  onPopups(popups: PopupState[]): void;
  /** ⌘L inside a page: the window has the focus again and should put it in the URL bar */
  onFocusUrl?(): void;
  /** ⌘F inside a page: the window has the focus again and should open the find bar */
  onFindOpen?(): void;
  /** What the find bar's search found on a tab (browser:found) */
  onFound?(result: FindResultState): void;
  /** The window's chrome is dark (the popup cards' bars follow) */
  dark?(): boolean;
}

/** How long a Save Image As… counts as the user's download, whatever the agent did just before. */
const USER_DOWNLOAD_MS = 10_000;

export class BrowserController {
  private readonly tabs: BrowserTab[] = [];
  private activeTab: BrowserTab;
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  private visible = true;
  private readonly popups: PopupManager;
  private stateTimer: NodeJS.Immediate | null = null;
  /** A popup's contents id → the tab that opened it */
  private readonly popupOwners = new Map<number, string>();
  /** The agent's actions running now, and when the last one ended (ms) */
  private actingCount = 0;
  private lastActEnd = 0;
  /** When the user last pressed a key or clicked in each tab (or its popups), ms */
  private readonly userInput = new Map<string, number>();
  /** Input events until this time (ms) are the controller's own sendInputEvent calls, not the user's */
  private syntheticUntil = 0;
  /** Addresses the user asked to save from the context menu, and until when that counts (ms) */
  private readonly userDownloads = new Map<string, number>();

  constructor(
    private readonly win: BrowserWindow,
    private readonly opts: BrowserControllerOptions,
  ) {
    this.popups = new PopupManager({
      win,
      pane: () => this.rounded(),
      visible: () => this.visible && !win.isDestroyed(),
      dark: () => opts.dark?.() ?? false,
      onChange: () => this.emitPopups(),
    });
    this.activeTab = this.makeTab();
    void this.activeTab.webContents.loadURL('about:blank');
    this.layout();
  }

  // ---------- Tabs ----------

  /** A new tab, attached under the popups and hidden until it is activated; nothing loaded yet. */
  private makeTab(): BrowserTab {
    if (this.tabs.length >= MAX_TABS) throw new Error(TOO_MANY_TABS);
    const tab = new BrowserTab({
      onChange: () => this.scheduleState(),
      onShortcut: (t, key) => this.shortcut(t, key),
      onCertError: () => {
        this.layout();
        this.scheduleState();
      },
      onNavigated: (t, url) => {
        // A site whose zoom was saved gets it back (also after a relaunch)
        applySavedZoom(t.webContents, url);
        for (const fn of tabEvents.navigated) fn(t.id, url, t.webContents.id);
      },
      onContextMenu: (t, params) => this.contextMenu(t, params),
      onFound: (t, r) => {
        if (!this.win.isDestroyed()) this.opts.onFound?.({ tabId: t.id, ...r });
      },
    });
    tab.webContents.setWindowOpenHandler(this.ownPopups(tab, this.popups.handlerFor(tab, (url, background) => this.openFromPage(url, background))));
    tab.webContents.on('input-event', (_e, input) => this.noteInput(tab.id, input.type));
    // An artifact never takes its tab anywhere else by itself (a link, location, a meta refresh): the strip offers it.
    tab.webContents.on('will-frame-navigate', (details) => {
      if (tab.webContents.isDestroyed() || !leavesArtifact(tab.webContents.getURL(), details.url)) return;
      details.preventDefault();
      tab.blockedPopup(details.url);
    });
    // Tabs sit below the popup cards: at the index of the last tab, never at the end of the window's views.
    this.win.contentView.addChildView(tab.view, this.tabs.length);
    this.tabs.push(tab);
    tab.view.setVisible(false);
    return tab;
  }

  /**
   * Opens a tab, blank or at `url` (resolved as the URL bar would), active unless `background` is set (the agent
   * reading another site while the user keeps theirs). The 13th throws TOO_MANY_TABS.
   */
  newTab(url?: string, opts: { background?: boolean } = {}): TabState {
    const tab = this.makeTab();
    const target = url && url.trim() ? resolveTarget(url, '') : 'about:blank';
    tab.webContents.loadURL(target).catch(() => undefined);
    if (opts.background) this.layout();
    else this.activate(tab.id);
    this.scheduleState();
    return tab.state();
  }

  /** browser_tabs new: a tab at `url`, loaded like browser_navigate loads, with the same "Now at …" answer. */
  openTab(url: string, opts: { background?: boolean } = {}): Promise<string> {
    return this.stamp(async () => {
      const tab = this.makeTab();
      if (opts.background) this.layout();
      else this.activate(tab.id);
      this.scheduleState();
      const where = await this.navigateIn(tab, url);
      return `Opened ${tab.id}${opts.background ? ' in the background' : ''}. ${where}`;
    });
  }

  /** A link or window.open from a page: a tab (the active one when the cap is reached, as a plain navigation). */
  private openFromPage(url: string, background: boolean): void {
    if (!opensInTab(url)) return;
    try {
      this.newTab(url, { background });
    } catch {
      this.activeTab.webContents.loadURL(url).catch(() => undefined);
    }
  }

  private tabById(id: string): BrowserTab {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`No tab ${id}. The tabs are: ${this.tabs.map((t) => t.id).join(', ')}.`);
    return tab;
  }

  activate(id: string): void {
    const tab = this.tabById(id);
    if (tab !== this.activeTab) {
      // The find bar belongs to the tab it searched: its highlight goes with it (the window closes the bar)
      this.activeTab.stopFind();
      this.activeTab = tab;
      this.layout();
    }
    this.scheduleState();
  }

  /** Closes a tab (its popups with it). Closing the last tab leaves one blank tab; the next tab, else the one before, becomes active. */
  closeTab(id: string): void {
    const tab = this.tabById(id);
    if (this.tabs.length === 1) this.newTab();
    const at = this.tabs.indexOf(tab);
    this.tabs.splice(at, 1);
    this.popups.closeFor(tab.id);
    for (const fn of tabEvents.closed) fn(tab.id);
    if (this.activeTab === tab) this.activeTab = this.tabs[Math.min(at, this.tabs.length - 1)];
    try {
      this.win.contentView.removeChildView(tab.view);
    } catch {
      /* the window is going */
    }
    tab.dispose();
    this.layout();
    this.scheduleState();
  }

  listTabs(): TabState[] {
    return this.tabs.map((t) => t.state());
  }

  /** Every tab loads its page again (after the browsing data was cleared). */
  reloadAll(): void {
    for (const t of this.tabs) if (!t.webContents.isDestroyed() && t.webContents.getURL() && t.webContents.getURL() !== 'about:blank') t.webContents.reload();
  }

  private shortcut(tab: BrowserTab, key: TabShortcut): void {
    if (key === 'new-tab') {
      try {
        this.newTab();
      } catch {
        /* at the cap: nothing opens */
      }
    } else if (key === 'close-tab') this.closeTab(tab.id);
    else if (key === 'focus-url') {
      if (!this.win.isDestroyed()) this.win.webContents.focus();
      this.opts.onFocusUrl?.();
    } else if (key === 'find') {
      if (!this.win.isDestroyed()) this.win.webContents.focus();
      this.opts.onFindOpen?.();
    } else if (key === 'zoom-in' || key === 'zoom-out' || key === 'zoom-reset') this.zoom(key === 'zoom-in' ? 'in' : key === 'zoom-out' ? 'out' : 'reset', tab);
    else if (key === 'devtools') this.toggleDevTools(tab);
  }

  /**
   * A link from the chat (Settings → Browser: Open links from the chat in the pane): a new tab at `url`, in front,
   * as the user's own navigation (no agent stamp, no site card). False when the pane already holds MAX_TABS.
   */
  openLink(url: string): boolean {
    try {
      this.newTab(url);
      return true;
    } catch {
      return false;
    }
  }

  // ---------- Find, zoom, the strip, DevTools, the right click (the user's, never the agent's) ----------

  /** The find bar's search on the active tab: a new text, or the next (previous) match; '' stops. */
  findInPage(text: string, forward = true): void {
    this.activeTab.find(text, forward);
  }

  /** The find bar closed: the search stops, and with `focusPage` the page has the focus again. */
  stopFindInPage(focusPage = false): void {
    this.activeTab.stopFind();
    if (focusPage && !this.wc.isDestroyed()) this.wc.focus();
  }

  /** One zoom step on a tab (the active one by default), saved for its site. Returns the level in percent. */
  zoom(change: ZoomChange, tab: BrowserTab = this.activeTab): number {
    const level = stepZoom(tab.webContents, change);
    this.scheduleState();
    return level;
  }

  /** The View menu's zoom while `wc` has the focus: true when it is a page of the browser (a tab or a popup), which then zooms. */
  zoomContents(wc: WebContents, change: ZoomChange): boolean {
    if (!this.tabIdOf(wc)) return false;
    stepZoom(wc, change);
    this.scheduleState();
    return true;
  }

  /** The blocked-popup strip: Show opens the last refused popup's address in a new tab; both answers clear the strip. */
  blockedPopup(tabId: string, action: 'show' | 'dismiss'): void {
    const url = this.tabById(tabId).clearBlockedPopups();
    if (action === 'show' && url) this.openFromPage(url, false);
  }

  /** ⌥⌘I: a tab's DevTools, in a window of their own (a view in the pane has nowhere to dock them), opened or closed. */
  toggleDevTools(tab: BrowserTab = this.activeTab): void {
    const wc = tab.webContents;
    if (wc.isDestroyed()) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  }

  /** Whether a download of `url` beginning now is one the user asked for in the context menu (the mark is used up). */
  userDownload(url: string, now = Date.now()): boolean {
    for (const [u, until] of this.userDownloads) if (until < now) this.userDownloads.delete(u);
    const mine = this.userDownloads.has(url);
    this.userDownloads.delete(url);
    return mine;
  }

  /** A right click on a tab's page: the native menu (context-menu.ts), whose items act on that tab. */
  private contextMenu(tab: BrowserTab, params: ContextMenuParams): void {
    const wc = tab.webContents;
    if (wc.isDestroyed() || this.win.isDestroyed()) return;
    showContextMenu(
      params,
      { canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() },
      (action) => void this.contextAction(tab, action, params).catch((err: unknown) => console.warn('[browser] the context menu item failed:', err instanceof Error ? err.message : String(err))),
      (menu) => menu.popup({ window: this.win }),
    );
  }

  private async contextAction(tab: BrowserTab, action: ContextAction, params: { x: number; y: number }): Promise<void> {
    const wc = tab.webContents;
    if (wc.isDestroyed()) return;
    switch (action.do) {
      case 'replace':
        return wc.replaceMisspelling(action.word);
      case 'learn':
        wc.session.addWordToSpellCheckerDictionary(action.word);
        return;
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        return;
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        return;
      case 'reload':
        return wc.reload();
      case 'cut':
        return wc.cut();
      case 'copy':
        return wc.copy();
      case 'paste':
        return wc.paste();
      case 'pasteAndMatchStyle':
        return wc.pasteAndMatchStyle();
      case 'selectAll':
        return wc.selectAll();
      case 'openTab':
        // In the background, as Chrome does (a ⌘-click too)
        return this.openFromPage(action.url, true);
      case 'copyText':
        return clipboard.writeText(action.text);
      case 'copyImage':
        return wc.copyImageAt(Math.round(params.x), Math.round(params.y));
      case 'saveImage':
        // Saved like any download (the folder in Settings → Browser), as the user's even right after an agent's action
        this.userDownloads.set(action.url, Date.now() + USER_DOWNLOAD_MS);
        return wc.downloadURL(action.url);
      case 'search':
        return this.openFromPage(searchUrl(action.query), false);
      case 'print':
        wc.print({}, (ok, why) => {
          if (!ok && why && why !== 'cancelled') console.warn('[browser] printing failed:', why);
        });
        return;
      case 'savePdf':
        return this.saveAsPdf(wc);
      case 'inspect':
        if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
        wc.inspectElement(Math.round(params.x), Math.round(params.y));
        return;
    }
  }

  /** Save as PDF…: a save dialog on the window (the page's title as the name, in the Downloads folder), then the page as a PDF. */
  private async saveAsPdf(wc: WebContents): Promise<void> {
    let host = '';
    try {
      host = new URL(wc.getURL()).hostname;
    } catch {
      /* no host */
    }
    const name = sanitizeFilename(`${(wc.getTitle() || host || 'Page').slice(0, 120)}.pdf`);
    const r = await dialog.showSaveDialog(this.win, { title: 'Save as PDF', defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath || wc.isDestroyed()) return;
    const data = await wc.printToPDF({ printBackground: true });
    await fs.promises.writeFile(r.filePath, data);
  }

  // ---------- Popups ----------

  popupStates(): PopupState[] {
    return this.popups.list();
  }

  closePopup(id: string): void {
    this.popups.close(id);
  }

  movePopup(id: string, x: number, y: number): void {
    this.popups.move(id, x, y);
  }

  private emitPopups(): void {
    if (!this.win.isDestroyed()) this.opts.onPopups(this.popups.list());
  }

  // ---------- State and layout ----------

  private get wc() {
    return this.activeTab.webContents;
  }

  state(): BrowserState {
    const active = this.activeTab.state();
    return {
      tabs: this.tabs.map((t) => t.state()),
      activeId: active.id,
      url: active.url,
      title: active.title,
      canGoBack: active.canGoBack,
      canGoForward: active.canGoForward,
      loading: active.loading,
    };
  }

  /** One push per burst of changes (a navigation fires several events at once). */
  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setImmediate(() => {
      this.stateTimer = null;
      this.emitState();
    });
  }

  private emitState(): void {
    if (this.win.isDestroyed()) return;
    this.opts.onState(this.state());
  }

  setBounds(b: Bounds): void {
    this.bounds = b;
    this.layout();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.layout();
  }

  private rounded(): Bounds {
    return { x: Math.round(this.bounds.x), y: Math.round(this.bounds.y), width: Math.round(this.bounds.width), height: Math.round(this.bounds.height) };
  }

  /** The active tab's view has the pane's bounds and shows while the pane does; the others keep their size, hidden. */
  private layout(): void {
    // A hidden pane (a dialog, a page, another pane tab) also takes the views' size away, as before tabs: a dialog
    // must never sit under a page, whatever setVisible does in a window that is covered or not yet painted.
    const b = this.visible ? this.rounded() : { x: 0, y: 0, width: 0, height: 0 };
    for (const tab of this.tabs) {
      tab.view.setBounds(b);
      // A tab stopped at a certificate error hides behind the pane's interstitial (drawn by the window).
      tab.view.setVisible(tab === this.activeTab && this.visible && !tab.certError);
    }
    this.popups.layout();
  }

  // ---------- The tools, on the active tab ----------

  /** Runs `body` in the page's safety world, which the page and browser_eval cannot see or change. */
  private safety<T>(body: string): Promise<T> {
    return this.wc.executeJavaScriptInIsolatedWorld(SAFETY_WORLD, [{ code: inSafetyWorld(body) }]) as Promise<T>;
  }

  /**
   * The values of every filled credential field on the page (password, one-time code, card), for the browser tools
   * to hide from what they return. Empty when the page cannot be asked.
   */
  async secretValues(): Promise<string[]> {
    try {
      const r = await this.safety<unknown>('return S.secrets();');
      return Array.isArray(r) ? r.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * The kind of credential the field typed into holds (see targetScript), or null. 'embedded': the focus is in a frame
   * from another site that could not be asked, which counts as a credential field.
   */
  private async targetKind(ref: string | undefined, active: boolean): Promise<string | null> {
    const r = await this.wc
      .executeJavaScriptInIsolatedWorld(SAFETY_WORLD, [{ code: targetScript(ref, active) }])
      .catch(() => null) as { kind: string | null; crossOrigin: boolean } | null;
    if (!r) return null;
    if (r.kind || !r.crossOrigin) return r.kind;
    const frame = this.wc.focusedFrame;
    if (!frame || frame.frameTreeNodeId === this.wc.mainFrame.frameTreeNodeId) return 'embedded';
    const inner = (await frame.executeJavaScript(frameCheckScript()).catch(() => undefined)) as { activeKind: string | null } | undefined;
    return inner ? inner.activeKind : 'embedded';
  }

  /**
   * Before the agent's text is typed (and stored), without changing the page: whether the field it names is a
   * credential field (`ref`; else `field`, a credential field whose label or placeholder contains it; else the focused
   * element). browser_type then keeps the text out of the transcript.
   */
  async credentialTarget(ref?: string, field?: string): Promise<string | null> {
    if (ref && REF_RE.test(ref)) return this.targetKind(ref, false);
    if (field) return ((await this.wc.executeJavaScriptInIsolatedWorld(SAFETY_WORLD, [{ code: fieldKindScript(field) }]).catch(() => null)) as string | null) ?? null;
    return this.targetKind(undefined, true);
  }

  /**
   * What a click on `ref`, or at a viewport point, would land on, for the click rules (policy.ts clickRule): its text,
   * role, tag and type, whether it sits in a CAPTCHA, whether its form holds card fields and where that form posts.
   * The page is not changed. null when nothing is there or the page cannot be asked.
   */
  async describeTarget(target: { ref: string } | { x: number; y: number }): Promise<ClickTarget | null> {
    if ('ref' in target && !REF_RE.test(target.ref)) return null;
    const a = await this.aim(target);
    if (!a || ('refusal' in a && a.missing)) return null;
    return 'refusal' in a ? { text: '', role: '', tag: '', type: '', inCaptcha: false, formHasCardFields: false, formActionHost: null, blocked: a.refusal } : a.target;
  }

  /** Runs a script made with inSafetyWorld (page-scripts.ts) in the active page's safety world. */
  private world<T>(code: string): Promise<T> {
    return this.wc.executeJavaScriptInIsolatedWorld(SAFETY_WORLD, [{ code }]) as Promise<T>;
  }

  /**
   * Where a click on `ref` (scrolled into view unless `scroll` is false) or at a viewport point lands, decided in the
   * safety world by a hit test of the point: the point and what is really there (a frame from another site named by
   * its committed origin), or the refusal the model reads (missing: the ref is gone). null: the page cannot be asked.
   */
  private async aim(target: { ref: string; scroll?: boolean } | { x: number; y: number }): Promise<{ x: number; y: number; target: ClickTarget } | { refusal: string; missing?: boolean } | null> {
    type Raw = { x: number; y: number; target: ClickTarget; frame?: { src: string; name: string; index: number } } | { error: string; role?: string; name?: string };
    const r = (await this.world<Raw | null>(aimScript(target)).catch(() => null)) ?? null;
    if (!r) return null;
    if ('error' in r) {
      const ref = 'ref' in target ? target.ref : '';
      const what = `${r.role ?? 'element'}${r.name ? ` '${r.name}'` : ''} (${ref})`;
      if (r.error === 'missing') return { refusal: `No element with ${ref} on the current page (refs change after navigation). Read the page again, or pass the element's visible text instead.`, missing: true };
      if (r.error === 'changed') return { refusal: `${ref} changed; read the page again.` };
      if (r.error === 'hidden') return { refusal: `${what} has no size on the page, so there is nothing to click; read the page again.` };
      if (r.error === 'nothing') return { refusal: `Nothing on the page is at (${'x' in target ? target.x : 0}, ${'y' in target ? target.y : 0}).` };
      return { refusal: `Something else covers ${what}; read the page again.` };
    }
    return { x: r.x, y: r.y, target: { ...r.target, frameOrigin: r.frame ? this.frameOrigin(r.frame) : null } };
  }

  /**
   * The committed origin of the frame from another site a click would go into: the child frame with that name, else
   * the one at that address, else the one in the same place among the page's frames; failing all, the origin of its src.
   */
  private frameOrigin(f: { src: string; name: string; index: number }): string {
    let kids: Electron.WebFrameMain[] = [];
    try {
      kids = this.wc.mainFrame.frames;
    } catch {
      kids = [];
    }
    const pick = (list: Electron.WebFrameMain[]) => (list.length === 1 ? list[0] : null);
    const frame = (f.name ? pick(kids.filter((k) => k.name === f.name)) : null) ?? pick(kids.filter((k) => k.url === f.src)) ?? (f.index >= 0 && f.index < kids.length ? kids[f.index] : null);
    const origin = frame && frame.origin && frame.origin !== 'null' ? frame.origin : '';
    if (origin) return origin;
    try {
      return new URL(f.src).origin;
    } catch {
      return 'another site';
    }
  }

  /**
   * The committed origin of the active page's main frame: for a page with no address of its own (about:blank, data:)
   * that a page opened or navigated to, the origin it inherited; '' when it is opaque ("null") or cannot be read.
   */
  pageOrigin(): string {
    try {
      const o = this.wc.mainFrame.origin;
      return o && o !== 'null' ? o : '';
    } catch {
      return '';
    }
  }

  /** Whether the active page shows a password field: the sign-in page signal (policy.ts looksLikeSignInPage). False when it cannot say. */
  async pageHasPasswordField(): Promise<boolean> {
    return (await this.wc.executeJavaScriptInIsolatedWorld(SAFETY_WORLD, [{ code: passwordFieldScript() }]).catch(() => false)) === true;
  }

  private async waitForLoad(wc = this.wc, timeoutMs = 20_000): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!wc.isDestroyed()) {
          wc.removeListener('did-finish-load', done);
          wc.removeListener('did-fail-load', done);
          wc.removeListener('did-stop-loading', done);
        }
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      wc.once('did-finish-load', done);
      wc.once('did-fail-load', done);
      wc.once('did-stop-loading', done);
      wc.once('destroyed', done);
    });
    await sleep(250);
  }

  /** browser_navigate on the active tab: a URL, "back", "forward", a relative path or a search. */
  navigate(target: string): Promise<string> {
    return this.stamp(() => this.navigateIn(this.activeTab, target));
  }

  /** The user's own navigation (the URL bar, Back, Forward, Reload; browser.go): the same, but not an agent action. */
  userNavigate(target: string): Promise<string> {
    if (target.trim() === 'reload') return this.reloadNow().then(() => 'Reloaded.');
    return this.navigateIn(this.activeTab, target);
  }

  private async navigateIn(tab: BrowserTab, target: string): Promise<string> {
    const wc = tab.webContents;
    const t = target.trim();
    if (t === 'back' || t === 'forward') {
      const can = t === 'back' ? wc.navigationHistory.canGoBack() : wc.navigationHistory.canGoForward();
      if (!can) return `Cannot go ${t}: no history in that direction.`;
      const wait = this.waitForLoad(wc);
      if (t === 'back') wc.navigationHistory.goBack();
      else wc.navigationHistory.goForward();
      await wait;
    } else {
      const url = resolveTarget(t, wc.getURL());
      const wait = this.waitForLoad(wc);
      wc.loadURL(url).catch(() => undefined);
      await wait;
    }
    if (tab.certError) return certificateSentence(tab.certError);
    const s = tab.state();
    return `Now at ${fencePage(s.url, `${s.url}${s.title ? ` — "${s.title}"` : ''}`)}`;
  }

  reload(): Promise<void> {
    return this.stamp(() => this.reloadNow());
  }

  private async reloadNow(): Promise<void> {
    const wc = this.wc;
    const wait = this.waitForLoad(wc);
    wc.reload();
    await wait;
  }

  /** browser_get_text: the text a person can see, from `start`, at most `maxChars` characters (paging.ts). */
  async getText(maxChars = DEFAULT_READ, start = 0): Promise<string> {
    const text = ((await this.world<string>(getTextScript())) ?? '') as string;
    const s = this.state();
    return `URL: ${s.url}\nTitle: ${s.title}\n\n${text ? readPiece(text, start, maxChars) : '(no visible text)'}`;
  }

  /** browser_read_page: the outline with refs (every element numbered), from `start`, at most `maxChars` characters. */
  async readPage(mode: 'interactive' | 'all' = 'interactive', maxChars = DEFAULT_READ, start = 0): Promise<string> {
    const r = await this.world<{ text: string; count: number; truncated: boolean }>(readPageScript(mode, OUTLINE_MAX));
    // The address and the title are the browser's, never what a script in the page says they are
    const s = this.state();
    return `URL: ${s.url}\nTitle: ${s.title}\n${r.count} interactive element${r.count === 1 ? '' : 's'}\n\n${r.text ? readPiece(r.text, start, maxChars, r.truncated) : '(nothing visible)'}`;
  }

  async find(query: string): Promise<string> {
    const r = await this.world<{ text: string }>(readPageScript('all', OUTLINE_MAX));
    const q = query.toLowerCase();
    const hits = r.text.split('\n').filter((l) => l.toLowerCase().includes(q)).slice(0, 25);
    return hits.length ? hits.join('\n') : `No visible element or text matched "${query}".`;
  }

  /** Outline lines of the visible interactive elements; refs are refreshed as a side effect. */
  private async outlineLines(): Promise<string[]> {
    const r = await this.world<{ text: string }>(readPageScript('interactive', OUTLINE_MAX));
    return r.text ? r.text.split('\n') : [];
  }

  /**
   * The ref of the element whose visible label contains `text` (case-insensitive; exact > prefix > substring),
   * so a model can act on "Sign in" without juggling refs. Throws with the candidates when ambiguous or missing.
   */
  async findRef(text: string, kind: 'any' | 'field' = 'any'): Promise<string> {
    const q = text.trim().toLowerCase();
    if (!q) throw new Error('text is required.');
    const lines = await this.outlineLines();
    const parsed = lines
      .map((line) => {
        const m = /^\[(ref_\d+)\] ([a-z0-9]+)(?:\[type=([^\]]*)\])? "([^"]*)"(?: -> (\S+))?/.exec(line);
        return m ? { ref: m[1], tag: m[2], type: (m[3] ?? '').toLowerCase(), label: m[4], href: m[5] ?? '', line } : null;
      })
      .filter((x): x is { ref: string; tag: string; type: string; label: string; href: string; line: string } => x !== null);
    const isField = (p: { tag: string; type: string }) =>
      p.tag === 'textarea' || p.tag === 'select' || (p.tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file'].includes(p.type)) || (p.tag !== 'a' && p.tag !== 'button' && p.tag !== 'input');
    const pool = kind === 'field' ? parsed.filter(isField) : parsed;
    const score = (p: { label: string; href: string }) => {
      const l = p.label.toLowerCase();
      if (l === q) return 3;
      if (l.startsWith(q)) return 2;
      if (l.includes(q)) return 1;
      if (p.href && p.href.toLowerCase().includes(q)) return 0.5;
      return 0;
    };
    const scored = pool.map((p) => ({ p, s: score(p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (!scored.length) throw new Error(`No ${kind === 'field' ? 'field' : 'element'} matching "${text}" on this page. Visible elements:\n${lines.slice(0, 30).join('\n') || '(none)'}`);
    const ties = scored.filter((x) => x.s === scored[0].s);
    if (ties.length > 1) throw new Error(`Several elements match "${text}"; use one of these refs instead:\n${ties.map((x) => x.p.line).join('\n')}`);
    return scored[0].p.ref;
  }

  /**
   * Where the agent's click or typing at `ref` goes, checked twice: once with the element scrolled into view (the flash
   * then shows it), and again at the moment of the click without scrolling, which must find the same thing there. A
   * string is the refusal the model reads; a ref that is gone throws with the elements there are now.
   */
  private async aimAt(ref: string): Promise<{ x: number; y: number; target: ClickTarget } | string> {
    if (!REF_RE.test(ref)) throw new Error(`Invalid ref "${ref}". Refs look like ref_12 and come from browser_read_page, or pass text instead.`);
    const a = await this.aim({ ref });
    if (!a) throw new Error('The page could not be asked where the element is; read the page again.');
    if ('refusal' in a) {
      if (!a.missing) return a.refusal;
      const lines = await this.outlineLines().catch(() => [] as string[]);
      throw new Error(`No element with ${ref} on the current page (refs change after navigation). The elements now are:\n${lines.slice(0, 30).join('\n') || '(none)'}\nUse one of these refs, or pass the element's visible text instead.`);
    }
    this.flash(ref);
    await sleep(120);
    const b = await this.aim({ ref, scroll: false });
    if (!b) throw new Error('The page could not be asked where the element is; read the page again.');
    if ('refusal' in b) return b.refusal;
    return sameClickTarget(a.target, b.target) ? b : CHANGED_UNDER_CLICK;
  }

  private async describe(ref: string): Promise<{ role: string; name: string }> {
    const d = (await this.world<{ role: string; name: string } | null>(describeScript(ref)).catch(() => null)) ?? null;
    return d ?? { role: 'element', name: '' };
  }

  private flash(ref: string): void {
    this.world(flashScript(ref)).catch(() => undefined);
  }

  /** Lets an action land: a short pause, the rest of any navigation it started, then "Now at …" when the page changed. */
  private async settle(before: BrowserState): Promise<string> {
    await sleep(300);
    if (this.wc.isLoading()) await this.waitForLoad(this.wc, 5000);
    if (this.activeTab.certError) return ` ${certificateSentence(this.activeTab.certError)}`;
    const after = this.state();
    if (after.url !== before.url || after.title !== before.title) return ` Now at: ${fencePage(after.url, `${after.title ? `${after.title} — ` : ''}${after.url}`)}`;
    return '';
  }

  /** Polls the page for text or a selector (plan: 200 ms steps). */
  async waitFor(text: string | undefined, selector: string | undefined, timeoutMs = 10_000): Promise<string> {
    const what = [text ? `text "${text}"` : '', selector ? `selector "${selector}"` : ''].filter(Boolean).join(' or ');
    if (!what) throw new Error('Give text and/or selector to wait for.');
    const deadline = Date.now() + Math.min(Math.max(500, timeoutMs), 60_000);
    for (;;) {
      const found = (await this.world<false | string | { line: string }>(waitScript(text, selector)).catch(() => false)) ?? false;
      if (found === 'bad-selector') throw new Error(`"${selector}" is not a valid CSS selector.`);
      if (found && typeof found === 'object') return `Found ${what}.${found.line ? ` The page says: ${fencePage(this.state().url, found.line)}` : ''}`;
      if (Date.now() >= deadline) return `Timed out after ${timeoutMs} ms waiting for ${what}. The page may still be loading or the text may differ.`;
      await sleep(200);
    }
  }

  clickAt(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', clickCount = 1): void {
    const wc = this.wc;
    const px = Math.round(x);
    const py = Math.round(y);
    this.synthetic();
    wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
    wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button, clickCount });
    wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button, clickCount });
    // An action of its own (browser_click with x and y): what it starts in the next two seconds is the agent's.
    this.lastActEnd = Date.now();
  }

  /**
   * Clicks the ref'd element where it really is: the point is hit-tested in the safety world just before the click, and
   * a page that covers the element, changed it, or moved something else under the point gets no click (the refusal is
   * the result). `expect`: what the click rules saw there (browser.ts clickCheck), which must still be what is there.
   */
  click(ref: string, button: 'left' | 'right' | 'middle' = 'left', double = false, expect?: ClickTarget | null): Promise<string> {
    return this.stamp(async () => {
      const what = await this.describe(ref);
      const before = this.state();
      const at = await this.aimAt(ref);
      if (typeof at === 'string') return at;
      if (expect && !sameClickTarget(expect, at.target)) return CHANGED_UNDER_CLICK;
      this.wc.focus();
      this.clickAt(at.x, at.y, button, double ? 2 : 1);
      const suffix = await this.settle(before);
      return `Clicked ${what.role}${what.name ? ` '${what.name}'` : ''} (${ref}).${suffix}`;
    });
  }

  /**
   * browser_click at viewport coordinates: what is under the point is looked at again just before the click and must be
   * what the click rules saw (`expect`), else nothing is clicked.
   */
  clickPoint(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', clickCount = 1, expect?: ClickTarget | null): Promise<string> {
    return this.stamp(async () => {
      const before = this.state();
      const a = await this.aim({ x, y });
      if (!a) return `The page could not be asked what is at (${x}, ${y}); nothing was clicked.`;
      if ('refusal' in a) return a.refusal;
      if (expect && !sameClickTarget(expect, a.target)) return CHANGED_UNDER_CLICK;
      this.wc.focus();
      this.clickAt(x, y, button, clickCount);
      const suffix = await this.settle(before);
      return `Clicked at (${x}, ${y}).${suffix}`;
    });
  }

  /**
   * Types `text` into the field; `secret`: it was a credential field, so the result leaves the text out. The field is
   * asked again after the click, since a page can move the focus on a click (a text field whose handler focuses the
   * password field): a credential field then gets nothing and the call throws CREDENTIAL_REFUSAL, unless `allowSecret`
   * (an exempt host: the user's own app under development).
   */
  type(ref: string | undefined, text: string, submit = false, clear = true, opts: { allowSecret?: boolean } = {}): Promise<{ content: string; secret: boolean }> {
    return this.stamp(() => this.typeNow(ref, text, submit, clear, opts.allowSecret === true));
  }

  private async typeNow(ref: string | undefined, text: string, submit: boolean, clear: boolean, allowSecret: boolean): Promise<{ content: string; secret: boolean }> {
    const before = this.state();
    let what = { role: 'the focused element', name: '' };
    if (ref) {
      what = await this.describe(ref);
      const at = await this.aimAt(ref);
      if (typeof at === 'string') return { content: at, secret: false };
      // A frame from another site over the field: the text would go to that site
      if (at.target.frameOrigin) return { content: `Something else covers ${what.role}${what.name ? ` '${what.name}'` : ''} (${ref}): a frame from ${at.target.frameOrigin}; read the page again.`, secret: false };
      this.wc.focus();
      this.clickAt(at.x, at.y);
      await sleep(120);
    }
    // Where the focus is now decides, before a key reaches the page. A credential field's text is never echoed: the
    // result says how much was typed, not what.
    const secret = await this.targetKind(ref, true);
    if (secret && !allowSecret) throw new Error(CREDENTIAL_REFUSAL);
    if (ref && clear) await this.world(selectAllScript());
    await this.wc.insertText(text);
    if (submit) {
      await sleep(100);
      await this.pressKey('Enter');
    }
    const suffix = await this.settle(before);
    if (secret) return { content: typedSecretMessage(secret, [...text].length, what.name, ref, submit) + suffix, secret: true };
    return { content: `Typed ${JSON.stringify(text)} into ${what.role}${what.name ? ` '${what.name}'` : ''}${ref ? ` (${ref})` : ''}${submit ? ' and pressed Enter' : ''}.${suffix}`, secret: false };
  }

  pressKey(combo: string): Promise<string> {
    return this.stamp(() => this.pressKeyNow(combo));
  }

  private async pressKeyNow(combo: string): Promise<string> {
    const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
    const keyName = parts.pop() ?? '';
    const modifiers = parts.map((m) => m.toLowerCase()).map((m) => (m === 'cmd' || m === 'command' || m === 'meta' ? 'cmd' : m === 'ctrl' || m === 'control' ? 'control' : m === 'option' ? 'alt' : m));
    const keyCode = KEY_MAP[keyName.toLowerCase()] ?? keyName;
    const wc = this.wc;
    this.synthetic();
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers as never });
    if (keyCode.length === 1 || keyCode === 'Return' || keyCode === 'Space' || keyCode === 'Tab') {
      wc.sendInputEvent({ type: 'char', keyCode, modifiers: modifiers as never });
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers as never });
    const suffix = await this.settle(this.state());
    return `Pressed ${combo}.${suffix}`;
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 600): Promise<string> {
    const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    const pos = await this.world<{ x: number; y: number; h: number; vh: number }>(scrollScript(dx, dy));
    await sleep(150);
    return `Scrolled ${direction}. Now at y=${Math.round(pos.y)} of ${pos.h} (viewport ${pos.vh}).`;
  }

  /**
   * A filled credential field a screenshot would show, described for the refusal: focused, or drawn in clear text
   * (a one-time code, a card number, a password after "Show password") inside the viewport. Frames from other sites
   * (a card form from a payment provider) are asked in their own world. null: nothing to hide.
   */
  private async exposedCredential(): Promise<{ kind: string; label: string; focused: boolean } | null> {
    type Exposed = { kind: string; label: string; focused: boolean };
    const own = ((await this.safety<Exposed[]>('return S.exposed();').catch(() => null)) ?? []) as Exposed[];
    if (own.length) return own.find((e) => e.focused) ?? own[0];
    const main = this.wc.mainFrame;
    for (const frame of main.framesInSubtree) {
      if (frame.frameTreeNodeId === main.frameTreeNodeId) continue;
      const r = (await frame.executeJavaScript(frameCheckScript()).catch(() => null)) as { exposed: Exposed[] } | null;
      if (r?.exposed?.length) return r.exposed.find((e) => e.focused) ?? r.exposed[0];
    }
    return null;
  }

  async screenshot(): Promise<{ path: string; dataUrl: string; width: number; height: number }> {
    // Refused rather than blanked: hiding the field in the capture would need the page repainted first, which a
    // hidden or busy window does not promise. The image would go to the user, the transcript and maybe the model.
    const exposed = await this.exposedCredential();
    if (exposed) {
      const what = `${fieldPhrase(exposed.kind)}${exposed.label ? ` ('${exposed.label}')` : ''}`;
      throw new Error(
        exposed.focused
          ? `Screenshot refused: the focus is in ${what} that is filled in. Click somewhere else on the page (or press Tab) and take it again.`
          : `Screenshot refused: ${what} on screen shows a filled-in credential in clear text. Scroll it out of view, or ask the user to look, instead.`,
      );
    }
    // A hidden view's first capture can fail (UnknownVizError): one more try after a moment
    const image = await this.wc.capturePage().catch(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return this.wc.capturePage();
    });
    // The user's copy on disk keeps every pixel; what goes into the conversation (and to the model, when Settings
    // allow) is a JPEG at CSS scale, its longest side at most 1280 px: a fraction of the image tokens.
    const png = image.toPNG();
    const dir = path.join(app.getPath('temp'), 'silo-harness-screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shot-${Date.now()}.png`);
    fs.writeFileSync(file, png);
    const { width, height } = image.getSize();
    const css = { width: Math.max(1, Math.round(this.bounds.width) || width), height: Math.max(1, Math.round(this.bounds.height) || height) };
    const fit = Math.min(1, MODEL_SHOT_MAX / Math.max(css.width, css.height));
    const small = image.resize({ width: Math.max(1, Math.round(css.width * fit)), height: Math.max(1, Math.round(css.height * fit)), quality: 'good' });
    return { path: file, dataUrl: `data:image/jpeg;base64,${small.toJPEG(MODEL_SHOT_QUALITY).toString('base64')}`, width, height };
  }

  evaluate(code: string): Promise<string> {
    return this.stamp(() => this.evaluateNow(code));
  }

  private async evaluateNow(code: string): Promise<string> {
    // No user gesture: the agent's code cannot open windows, go full screen or start what a click would allow
    const result = await this.wc.executeJavaScript(code, false);
    if (result === undefined) return 'undefined';
    try {
      const s = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return s ?? String(result);
    } catch {
      return String(result);
    }
  }

  // ---------- Browser safety: the agent's actions, popups' tabs, certificate errors ----------

  /**
   * Runs one of the agent's actions (navigate, openTab, reload, click, type, pressKey, evaluate; clickAt stamps its
   * end): while it runs, and for two seconds after, a download that begins is the agent's (downloads.ts).
   */
  private async stamp<T>(run: () => Promise<T>): Promise<T> {
    this.actingCount++;
    try {
      return await run();
    } finally {
      this.actingCount--;
      this.lastActEnd = Date.now();
    }
  }

  /** A key press or click reached a tab's page (or its popup): the user's, unless it is one the controller sent. */
  private noteInput(tabId: string, type: string): void {
    if (Date.now() < this.syntheticUntil) return;
    if (/^(mouseDown|rawKeyDown|keyDown|char|touchStart|gestureTap|gestureTapDown)$/.test(type)) this.userInput.set(tabId, Date.now());
  }

  /** When the user last pressed a key or clicked in that tab (downloads.ts startedByUser); 0: never. */
  userInputAt(tabId: string | null): number {
    return tabId ? this.userInput.get(tabId) ?? 0 : 0;
  }

  /**
   * Live tests only (feature.ts registers it with SILO_HARNESS_LIVE_TEST): the hidden test window's views receive no
   * input at all, so a test says "the user just pressed a key in the active tab" this way.
   */
  liveTestUserInput(): void {
    this.userInput.set(this.activeTab.id, Date.now());
  }

  /** The next input events are the agent's (clickAt, pressKey): they never count as the user's. */
  private synthetic(): void {
    this.syntheticUntil = Date.now() + 500;
  }

  stamps(): ActingStamps {
    return { inFlight: this.actingCount, lastEnd: this.lastActEnd };
  }

  /** Whether a browser tool is acting now, or ended less than two seconds ago. */
  acting(now = Date.now()): boolean {
    return startedByAgent(this.stamps(), now);
  }

  /** Remembers which tab each popup a tab's page opens belongs to (a popup's own popups are found through their opener). */
  private ownPopups(tab: BrowserTab, handler: (details: { url: string; disposition: string; features: string }) => WindowOpenHandlerResponse) {
    return (details: Parameters<typeof handler>[0]): WindowOpenHandlerResponse => {
      const r = handler(details);
      if (r.action !== 'allow' || !r.createWindow) return r;
      const make = r.createWindow;
      return {
        ...r,
        createWindow: (options) => {
          const wc = make(options);
          const id = wc.id;
          this.popupOwners.set(id, tab.id);
          wc.on('input-event', (_e, input) => this.noteInput(tab.id, input.type));
          wc.once('destroyed', () => this.popupOwners.delete(id));
          return wc;
        },
      };
    };
  }

  private tabOfContents(wc: WebContents): BrowserTab | undefined {
    return this.tabs.find((t) => !t.webContents.isDestroyed() && t.webContents.id === wc.id);
  }

  /** The tab a page belongs to: a tab's own contents, else the tab that opened it (a popup, a popup's popup). */
  tabIdOf(wc: WebContents | null): string | null {
    if (!wc || wc.isDestroyed()) return null;
    return ownerTabId(wc.id, {
      tabOf: (id) => this.tabs.find((t) => !t.webContents.isDestroyed() && t.webContents.id === id)?.id ?? this.popupOwners.get(id) ?? null,
      openerOf: (id) => {
        const opener = allContents.fromId(id)?.opener;
        const from = opener ? allContents.fromFrame(opener) : undefined;
        return from && !from.isDestroyed() ? from.id : null;
      },
    });
  }

  /** A tab's main frame stopped at a certificate error (certificates.ts). False: not a tab's contents (a popup). */
  certificateError(wc: WebContents, error: CertErrorState): boolean {
    const tab = this.tabOfContents(wc);
    if (!tab) return false;
    tab.setCertError(error);
    return true;
  }

  /** Proceed anyway (the interstitial's link, the window only): this host and certificate pass until the app quits. */
  certProceed(tabId: string): void {
    const tab = this.tabById(tabId);
    const e = tab.certError;
    if (!e) return;
    proceeded.add(e.host, e.fingerprint);
    tab.setCertError(null);
    tab.webContents.loadURL(e.url).catch(() => undefined);
  }

  /** Go back (the interstitial's button): the page before the failed one, or a blank tab when there is none. */
  certBack(tabId: string): void {
    const tab = this.tabById(tabId);
    const e = tab.certError;
    if (!e) return;
    const wc = tab.webContents;
    tab.setCertError(null);
    // Electron commits an error page for the failed address; when it did not, the tab is still on the page before.
    if (wc.getURL() !== e.url) return;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else wc.loadURL('about:blank').catch(() => undefined);
  }
}
