// The Browser pane's contract between the window and the main process: the tabs and the active tab's state, the
// popups laid over the pane, the config section, and the RPC methods and push channels of src/main/browser/feature.ts.
// Types only (types.ts re-exports the state shapes so older imports keep working).

/** A rectangle in the window's CSS pixels (the renderer reports the pane's slot; popups are placed in the same frame). */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One tab of the Browser pane. */
export interface TabState {
  /** Short stable id, e.g. "tab-3"; the agent's browser_tabs takes it as tab_id */
  id: string;
  url: string;
  title: string;
  /** The page's icon as a data: URL (fetched through the browser's own profile), or null for the globe */
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Popups this tab asked for that were refused since its last navigation (a fourth one while three are open) */
  blockedPopups: number;
}

/** The pane: every tab, which one is active, and the active tab's fields flat (the URL bar reads those). */
export interface BrowserState {
  tabs: TabState[];
  activeId: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/** A popup window a page opened (an OAuth sign-in), drawn as a card over the pane. `bounds` is the page area, under its 32 px bar. */
export interface PopupState {
  id: string;
  /** The tab that opened it */
  tabId: string;
  title: string;
  url: string;
  favicon: string | null;
  bounds: Bounds;
}

/** The browser's part of AppConfig (Settings → Browser). */
export interface BrowserConfig {
  /** Keep cookies and site data when the app quits (off: the browser's profile is cleared at quit) */
  keepCookies: boolean;
}

export interface BrowserRpc {
  'browser.tabs': () => TabState[];
  /** Opens a tab (blank, or at `url` resolved like the URL bar does) and makes it active unless `background` is set */
  'browser.newTab': (url?: string, opts?: { background?: boolean }) => TabState;
  /** Closes a tab; closing the last one leaves a blank tab */
  'browser.closeTab': (id: string) => void;
  'browser.activateTab': (id: string) => void;
  'browser.closePopup': (id: string) => void;
  /** Moves a popup's card so its bar's top-left corner is at (x, y), clamped to the pane */
  'browser.movePopup': (id: string, x: number, y: number) => void;
  /** Cookies, storage, caches and HTTP auth of the browser's profile, then every tab reloads */
  'browser.clearBrowsingData': () => void;
  /** Whether the one-time note about the browser's own profile is still to be shown */
  'browser.profileNote': () => boolean;
  'browser.dismissProfileNote': () => void;
}

export interface BrowserEvents {
  /** The popups open over the pane changed (opened, moved, retitled, closed) */
  'browser:popups': PopupState[];
  /** ⌘L inside a page: the window should focus the URL bar */
  'browser:focus-url': null;
}
