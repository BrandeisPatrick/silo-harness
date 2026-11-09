// The Browser pane's contract between the window and the main process: the tabs and the active tab's state, the
// popups laid over the pane, the browser's safety (permission requests, certificate errors, downloads), the config
// section, and the RPC methods and push channels of src/main/browser/feature.ts. Types only (types.ts re-exports the
// state shapes so older imports keep working).

/** A rectangle in the window's CSS pixels (the renderer reports the pane's slot; popups are placed in the same frame). */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A tab's main frame failed on a certificate (certificates.ts): the pane covers the tab with the interstitial until
 * it navigates on or the user proceeds.
 */
export interface CertErrorState {
  host: string;
  /** Chromium's code, e.g. "net::ERR_CERT_AUTHORITY_INVALID" */
  code: string;
  /** The certificate's fingerprint ("sha256/…"); Proceed remembers it with the host for this app run */
  fingerprint: string;
  /** The page that failed */
  url: string;
  /** The code in words: "Its certificate is not issued by an authority this Mac trusts" */
  reason: string;
}

/**
 * What the URL pill shows at its left: a grey lock (https), "Not secure" (http), an amber triangle (https on a host
 * whose certificate the user proceeded past in this run), or the globe (a blank tab, a file, an artifact).
 */
export type PageSecurity = 'secure' | 'insecure' | 'proceeded' | 'none';

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
  /** The certificate error the tab is stopped at, or null */
  certError: CertErrorState | null;
  security: PageSecurity;
}

/**
 * A page asked for something (the camera, notifications, …) and waits for the user's answer on the permission bar
 * under the URL bar. The bar shows the active tab's first one; a request from a tab in the background waits for it, and
 * one from a popup belongs to the tab that opened it. `id` is a random UUID only the window gets (no tool can answer).
 */
export interface PermissionRequestState {
  id: string;
  tabId: string;
  /** "example.com" (siteName) */
  site: string;
  /** "use your camera and microphone" (permissionPhrase) */
  phrase: string;
  /** Electron's permission name ("media", "notifications", …) */
  permission: string;
  /** The page that asked */
  url: string;
  /** What it wants to open, for openExternal ("mailto:…") */
  target?: string;
}

/** The bar's three answers: this time (for that tab, until it leaves the site), every time and Don't allow (both saved). */
export type PermissionAnswer = 'once' | 'always' | 'deny';

/** A saved answer, as Settings → Browser → Permissions lists it. */
export interface SavedPermission {
  /** The key it is saved under (an origin, "https://example.com") */
  key: string;
  /** "example.com" */
  site: string;
  /** "camera", "microphone", "notifications", "openExternal:mailto", … */
  capability: string;
  /** "Camera", "Open mailto: links" */
  label: string;
  decision: 'allow' | 'deny';
}

export type DownloadStatus = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';

/** One download of the Browser pane (downloads.ts). The list keeps the last 50 across launches, never their contents. */
export interface DownloadState {
  id: string;
  /** The name it is saved under (sanitised and made unique) */
  filename: string;
  /** Where it is saved; '' while an agent's download waits for the user's answer */
  path: string;
  url: string;
  /** "example.com" */
  host: string;
  received: number;
  /** 0 when the server did not say */
  total: number;
  state: DownloadStatus;
  /** When it began (ms since the epoch) */
  startedAt: number;
  /** It began while a browser tool was acting (or within two seconds after): it waits, paused, for Allow or Don't allow */
  byAgent: boolean;
  /** An agent's download the user has not answered yet (the download bar asks) */
  asking: boolean;
  /** The tab it came from (a popup's: the tab that opened it); null when unknown or closed */
  tabId: string | null;
}

export type DownloadAction = 'open' | 'show' | 'cancel' | 'clear' | 'allow' | 'deny';

/** The lists of Settings → Browser that are edited one entry at a time (browser.editList) */
export type BrowserListField = 'alwaysAllowed' | 'sensitive' | 'exempt';

/** The built-in lists Settings → Browser shows beside the user's own (policy.ts), and the default downloads folder. */
export interface BrowserBuiltIns {
  /** Sites that always ask, by kind: 'sign-in' | 'email' | 'financial' | 'payment' | 'vault' */
  sensitive: { pattern: string; kind: string }[];
  exempt: string[];
  /** The Mac's Downloads folder (what an empty downloadsDir means) */
  downloadsDir: string;
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
  /** Where downloads are saved; '' is the Mac's Downloads folder */
  downloadsDir: string;
  /** Links in the chat open in the Browser pane instead of the default browser */
  openChatLinksInPane: boolean;
  /** Sites the agent may use without a card: the keys "Always allow …" saved (example.com, localhost:3000, file:/path) and host patterns */
  alwaysAllowed: string[];
  /** The user's own sensitive sites (host patterns), asked before every acting call, on top of the built-in list */
  sensitive: string[];
  /** The user's own exempt hosts (host patterns, or a folder whose files count), beside localhost and friends */
  exempt: string[];
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
  /**
   * The user's own navigation from the pane's chrome on the active tab: a URL (resolved like the URL bar does),
   * "back", "forward" or "reload". Unlike browser_navigate it is not an agent action (a download it starts just starts).
   */
  'browser.go': (target: string) => string;

  // ---------- Permissions (the bar under the URL bar) ----------
  /** The requests waiting for an answer, every tab's (the bar shows the active tab's first) */
  'browser.permissions': () => PermissionRequestState[];
  /** The bar's answer. Only the window calls it: no tool can answer a permission request. False: no such request (any more) */
  'browser.answerPermission': (id: string, answer: PermissionAnswer) => boolean;
  /** Every saved answer (Allow every time, Don't allow), for Settings → Browser */
  'browser.savedPermissions': () => SavedPermission[];
  /** Forgets saved answers: one site's capability, every capability of a site (no capability), or all (no key) */
  'browser.resetPermissions': (key?: string, capability?: string) => SavedPermission[];

  // ---------- Certificates (the interstitial) ----------
  /** Proceed anyway (unsafe): the tab's host and certificate are let through until the app quits, and the page loads again */
  'browser.certProceed': (tabId: string) => void;
  /** Go back from the interstitial: the page before, or a blank tab */
  'browser.certBack': (tabId: string) => void;

  // ---------- Downloads (the tray and the download bar) ----------
  'browser.downloads': () => DownloadState[];
  /** Open, Show in Finder, Cancel, Clear (one finished entry, or every finished one with id ''), and the download bar's Allow and Don't allow */
  'browser.downloadAction': (id: string, action: DownloadAction) => DownloadState[];

  // ---------- Settings → Browser ----------
  /** A folder dialog for the downloads folder; the chosen path, or null when cancelled (the caller saves it) */
  'browser.chooseDownloadsDir': () => string | null;
  /**
   * Adds or removes one entry of a list, on the main process's own config (an approval card may have added a site
   * while Settings was open: the window's copy is never sent back whole). Returns the list as it is now; refused
   * when a settings.json file sets that list.
   */
  'browser.editList': (field: BrowserListField, op: 'add' | 'remove', value: string) => string[];
  'browser.builtInLists': () => BrowserBuiltIns;
}

export interface BrowserEvents {
  /** The popups open over the pane changed (opened, moved, retitled, closed) */
  'browser:popups': PopupState[];
  /** ⌘L inside a page: the window should focus the URL bar */
  'browser:focus-url': null;
  /** The permission requests waiting for an answer changed */
  'browser:permissions': PermissionRequestState[];
  /** The downloads changed (a new one, progress, done, cleared) */
  'browser:downloads': DownloadState[];
}
