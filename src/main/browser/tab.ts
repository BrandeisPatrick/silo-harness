// One tab of the Browser pane: its WebContentsView in the browser's own profile, the listeners that keep its
// TabState current (title, url, loading, history, favicon, the page's security and zoom), the safety prelude started
// on every page, the pane's shortcuts pressed inside the page (⌘⇧N, ⌘W, ⌘L, ⌘F, ⌘+ ⌘− ⌘0, ⌥⌘I), which the window
// never sees, the find bar's search (find.ts), the right click (context-menu.ts), and the certificate error its page
// stopped at (certificates.ts), which the pane covers with the interstitial.

import { WebContentsView, type ContextMenuParams, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { CertErrorState, FindResultState, TabState } from '../../shared/browser';
import { pageSecurity } from './certificates';
import { noPageDragRegions } from './drag-regions';
import { PageFinder } from './find';
import { passkeyGuardScript, passkeyWatchScript } from './page-scripts';
import { inSafetyWorld, SAFETY_WORLD } from './safety';
import { browserSession, BROWSER_PARTITION, cleanUserAgent } from './session';
import { zoomOf } from './zoom';

export type TabShortcut = 'new-tab' | 'close-tab' | 'focus-url' | 'find' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'devtools';

/** The parts of a key press (Electron's Input) the shortcuts read. */
export interface ShortcutInput {
  type: string;
  key: string;
  code?: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
  isAutoRepeat: boolean;
}

/**
 * The pane's shortcut a key pressed inside a page stands for, or null (the page gets it): ⌘⇧N new tab, ⌘W close it,
 * ⌘L the URL bar, ⌘F find, ⌘+ (⌘= too) and ⌘− zoom, ⌘0 back to 100 %, ⌥⌘I DevTools. ⌘ is Control away from the Mac,
 * so Control+N and friends keep their text-editing meaning there. A held key repeats only the zoom.
 */
export function shortcutOf(input: ShortcutInput, platform: string = process.platform): TabShortcut | null {
  if (input.type !== 'keyDown') return null;
  const mod = platform === 'darwin' ? input.meta : input.control;
  if (!mod) return null;
  const key = String(input.key ?? '').toLowerCase();
  if (input.alt) return !input.shift && !input.isAutoRepeat && (input.code === 'KeyI' || key === 'i') ? 'devtools' : null;
  if (key === '=' || key === '+') return 'zoom-in';
  if (key === '-' || key === '_') return 'zoom-out';
  if (input.isAutoRepeat) return null;
  if (key === '0' && !input.shift) return 'zoom-reset';
  if (key === 'n' && input.shift) return 'new-tab';
  if (input.shift) return null;
  return key === 'w' ? 'close-tab' : key === 'l' ? 'focus-url' : key === 'f' ? 'find' : null;
}

export interface TabHooks {
  /** Something the state carries changed */
  onChange(tab: BrowserTab): void;
  /** One of the pane's shortcuts was pressed inside the page */
  onShortcut(tab: BrowserTab, key: TabShortcut): void;
  /** The tab stopped at a certificate error, or left it (the view hides behind the interstitial while it has one) */
  onCertError?(tab: BrowserTab): void;
  /** A new page committed in the main frame (the permission bar's "this time" answers end when the site changes) */
  onNavigated?(tab: BrowserTab, url: string): void;
  /** The page was right-clicked */
  onContextMenu?(tab: BrowserTab, params: ContextMenuParams): void;
  /** The find bar's search found something, or stopped */
  onFound?(tab: BrowserTab, result: Omit<FindResultState, 'tabId'>): void;
}

/** The events after which the state is read again. */
const STATE_EVENTS = ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load'] as const;

/**
 * The device APIs a page in the pane does not get at all (their permissions are refused anyway): without them a page,
 * or the agent clicking on one, cannot start a Bluetooth scan or a device enumeration that brings up a macOS prompt.
 */
export const NO_DEVICE_APIS = 'WebBluetooth,WebHID,WebUSB,Serial';

/** A host on this Mac or its local network: an address in a private range, link-local, loopback, or a .local name. */
export function isLocalNetworkHost(host: string): boolean {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  return /^(fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(h);
}

/**
 * Whether the main process may fetch a page's icon: a data: icon, or one on the web. An icon on this Mac or the local
 * network is fetched only for a page on that same host: a page must not make the app reach into the network (and so
 * bring up macOS's Local Network prompt) with an icon address alone.
 */
export function faviconAllowed(icon: string, pageUrl: string): boolean {
  if (/^data:image\//i.test(icon)) return true;
  try {
    const u = new URL(icon);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!isLocalNetworkHost(u.hostname)) return true;
    return new URL(pageUrl).hostname.toLowerCase() === u.hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** Favicons are kept as data: URLs; one bigger than this is left out (the globe shows instead). */
const FAVICON_MAX_BYTES = 64 * 1024;
const faviconCache = new Map<string, string | null>();

/**
 * A page's icon as a data: URL, fetched through the browser's own profile (the app's window never loads a site's
 * resources, so the default session gets no cookies from it). null when it cannot be had.
 */
export async function fetchFavicon(url: string): Promise<string | null> {
  const cached = faviconCache.get(url);
  if (cached !== undefined) return cached;
  let out: string | null = null;
  try {
    if (/^data:image\//i.test(url)) out = url.length <= FAVICON_MAX_BYTES * 1.4 ? url : null;
    else if (/^https?:/i.test(url)) {
      const res = await browserSession().fetch(url, { signal: AbortSignal.timeout(5000) });
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const buf = Buffer.from(await res.arrayBuffer());
      const isImage = type.startsWith('image/') || /\.(ico|png|svg|gif|webp)(\?|#|$)/i.test(url);
      if (res.ok && buf.length > 0 && buf.length <= FAVICON_MAX_BYTES && isImage) {
        out = `data:${type.startsWith('image/') ? type : 'image/x-icon'};base64,${buf.toString('base64')}`;
      }
    }
  } catch {
    out = null;
  }
  if (faviconCache.size >= 300) faviconCache.delete(faviconCache.keys().next().value as string);
  faviconCache.set(url, out);
  return out;
}

let seq = 0;
/** The event a page's passkey request raises for the watcher: a name of this app run's own */
const PASSKEY_EVENT = `silo-passkey-${randomUUID()}`;

export class BrowserTab {
  readonly id = `tab-${++seq}`;
  readonly view: WebContentsView;
  favicon: string | null = null;
  /** Popups refused since the last navigation (a fourth while three are open) */
  blockedPopups = 0;
  /** The address the last refused popup wanted, until the next navigation */
  blockedPopupUrl: string | null = null;
  /** The certificate error the main frame stopped at (the interstitial shows), until the tab navigates on */
  certError: CertErrorState | null = null;
  /** The page asked for a passkey, which cannot work here yet: the pane's notice shows until dismissed */
  passkeyNotice = false;
  /** The notice came for this page load already (it shows once per load) */
  private passkeyShown = false;
  /** Counts page loads, so a watcher of an earlier page cannot bring the notice to a later one */
  private passkeyLoad = 0;
  private disposed = false;
  private readonly finder: PageFinder;

  constructor(private readonly hooks: TabHooks) {
    this.view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: BROWSER_PARTITION, disableBlinkFeatures: NO_DEVICE_APIS },
    });
    const wc = this.view.webContents;
    wc.setUserAgent(cleanUserAgent(wc.getUserAgent()));
    noPageDragRegions(wc);
    this.finder = new PageFinder(wc, (r) => {
      if (!this.disposed) this.hooks.onFound?.(this, r);
    });
    // A new page starts with no icon, a clean popup count and no search; the generic listeners below then report the state.
    wc.on('did-navigate', () => {
      this.passkeyLoad++;
      this.passkeyShown = false;
      this.passkeyNotice = false;
      this.favicon = null;
      this.blockedPopups = 0;
      this.blockedPopupUrl = null;
      if (this.finder.stop() && !this.disposed) this.hooks.onFound?.(this, { text: '', matches: 0, active: 0, final: true });
    });
    for (const ev of STATE_EVENTS) wc.on(ev as 'did-navigate', () => this.changed());
    wc.on('page-favicon-updated', (_e, favicons) => void this.loadFavicon(favicons));
    this.watchCertificates(wc);
    // Start watching each page's credential fields as soon as it is there (see pagePrelude in safety.ts)
    wc.on('dom-ready', () => void wc.executeJavaScriptInIsolatedWorld(SAFETY_WORLD, [{ code: inSafetyWorld('return true;') }]).catch(() => undefined));
    wc.on('dom-ready', () => this.watchPasskeys(wc));
    wc.on('before-input-event', (event, input) => {
      const action = shortcutOf(input);
      if (!action) return;
      // Taken here, the key reaches neither the page nor the app's menu (whose zoom would act a second time)
      event.preventDefault();
      this.hooks.onShortcut(this, action);
    });
    // ⌘ and the scroll wheel (or a pinch with ⌘) asks for a zoom, which Electron leaves to the app: a step, like ⌘+ / ⌘−
    wc.on('zoom-changed', (_e, direction) => this.hooks.onShortcut(this, direction === 'in' ? 'zoom-in' : 'zoom-out'));
    wc.on('context-menu', (_e, params) => {
      if (!this.disposed) this.hooks.onContextMenu?.(this, params);
    });
  }

  /**
   * A web page's modal passkey request shows the pane's notice, once per page load (page-scripts.ts
   * passkeyGuardScript, which also refuses a request that would hang). The page can only raise it: the text is ours.
   */
  private watchPasskeys(wc: WebContents): void {
    if (!/^https?:/i.test(wc.getURL())) return;
    const load = this.passkeyLoad;
    void wc.executeJavaScript(passkeyGuardScript(PASSKEY_EVENT)).catch(() => undefined);
    void wc
      .executeJavaScriptInIsolatedWorld(SAFETY_WORLD, [{ code: passkeyWatchScript(PASSKEY_EVENT) }])
      .then((asked: unknown) => {
        if (asked !== true || this.disposed || load !== this.passkeyLoad || this.passkeyShown) return;
        this.passkeyShown = true;
        this.passkeyNotice = true;
        this.changed();
      })
      .catch(() => undefined);
  }

  /** The notice's OK: it goes for the rest of this page load. */
  dismissPasskeyNotice(): void {
    if (!this.passkeyNotice) return;
    this.passkeyNotice = false;
    this.changed();
  }

  /** The find bar's search on this page: a new text, or the next (previous) match of the same one; '' stops it. */
  find(text: string, forward = true): void {
    if (!this.disposed) this.finder.find(text, forward);
  }

  /** The search ends and its highlight goes (the bar closed, the tab went to the background). */
  stopFind(): void {
    this.finder.stop();
  }

  get webContents(): WebContents {
    return this.view.webContents;
  }

  private changed(): void {
    if (!this.disposed) this.hooks.onChange(this);
  }

  private async loadFavicon(favicons: string[]): Promise<void> {
    const wc = this.view.webContents;
    const url = favicons.find((f) => /^(https?|data):/i.test(f));
    if (!url || wc.isDestroyed()) return;
    const page = wc.getURL();
    if (!faviconAllowed(url, page)) return;
    const icon = await fetchFavicon(url);
    if (this.disposed || wc.isDestroyed() || wc.getURL() !== page) return;
    this.favicon = icon;
    this.changed();
  }

  // ---------- Certificate errors (browser safety) ----------

  /**
   * The certificate error goes when the tab moves on: a navigation to another address starts, or a page commits (an
   * error page does not: Electron reports it as did-fail-load). A new page is also reported for the permission bar.
   */
  private watchCertificates(wc: WebContents): void {
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || !this.certError) return;
      if (details.url !== this.certError.url) this.setCertError(null);
    });
    wc.on('did-navigate', (_e, url) => {
      if (this.certError) this.setCertError(null);
      if (!this.disposed) this.hooks.onNavigated?.(this, url);
    });
  }

  /** The main frame stopped at a certificate error (certificates.ts), or left it (null). */
  setCertError(error: CertErrorState | null): void {
    if (this.disposed) return;
    this.certError = error;
    this.hooks.onCertError?.(this);
    this.changed();
  }

  /** A popup of this tab was refused: counted (and its address kept for the strip's Show) until the next navigation. */
  blockedPopup(url?: string): void {
    this.blockedPopups++;
    if (url && !/^\s*javascript:/i.test(url)) this.blockedPopupUrl = url;
    this.changed();
  }

  /** The strip's Show or ×: the count and the address go. Returns the address there was. */
  clearBlockedPopups(): string | null {
    const url = this.blockedPopupUrl;
    this.blockedPopups = 0;
    this.blockedPopupUrl = null;
    this.changed();
    return url;
  }

  state(): TabState {
    const wc = this.view.webContents;
    if (this.disposed || wc.isDestroyed()) {
      return { id: this.id, url: '', title: '', favicon: null, loading: false, canGoBack: false, canGoForward: false, blockedPopups: this.blockedPopups, blockedPopupUrl: null, certError: null, security: 'none', zoom: 100, passkeyNotice: false };
    }
    const url = wc.getURL();
    return {
      id: this.id,
      url,
      title: wc.getTitle(),
      favicon: this.favicon,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      blockedPopups: this.blockedPopups,
      blockedPopupUrl: this.blockedPopupUrl,
      certError: this.certError ? { ...this.certError } : null,
      security: this.certError ? 'none' : pageSecurity(url),
      zoom: zoomOf(wc),
      passkeyNotice: this.passkeyNotice,
    };
  }

  /** Ends the page (its contents are destroyed); the view must already be out of the window. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const wc = this.view.webContents;
    if (!wc.isDestroyed()) wc.close();
  }
}
