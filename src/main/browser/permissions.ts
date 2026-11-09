// What a page in the Browser pane may use: the camera, the microphone, the location, notifications and the rest.
// Electron grants every permission when a session has no handler. The pane has a session of its own
// (persist:browser, see session.ts), and these handlers are set on that one; the app's own window (its pages and the
// mod frames inside it) keeps the default session with no handler, and so every permission, as before. In the pane
// only full screen and writing to the clipboard are allowed without asking; anything else asks the user with a
// native dialog on the main window, and the answer holds for that site and permission until the app quits. The
// agent cannot answer: the dialog is not a tool or a card, and with no window to show it on the request is denied.

import { dialog, type BrowserWindow, type Session, type WebContents } from 'electron';

/** Allowed in the pane without asking. */
export const HARMLESS = new Set(['fullscreen', 'clipboard-sanitized-write']);

/** What the request handler's details carry that matters here (Electron's request and check details). */
export interface PermissionDetails {
  requestingUrl?: string;
  securityOrigin?: string;
  isMainFrame?: boolean;
  mediaTypes?: Array<'video' | 'audio'>;
  mediaType?: 'video' | 'audio' | 'unknown';
  externalURL?: string;
  filePath?: string;
  fileAccessType?: 'writable' | 'readable';
}

/** The site as the dialog names it: the host (and port) of a web page, else what the page is. */
export function siteName(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'This page';
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.host || 'This page';
  if (u.protocol === 'file:') return `The local file ${decodeURIComponent(u.pathname.split('/').pop() || u.pathname)}`;
  if (u.protocol === 'artifact:') return 'This artifact';
  return 'This page';
}

/** The key a decision is remembered under: the origin, or for a page without one (a file) its address. */
export function siteKey(url: string): string {
  try {
    const u = new URL(url);
    if (u.origin && u.origin !== 'null') return u.origin;
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  } catch {
    return url.slice(0, 300);
  }
}

function scheme(url: string | undefined): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url ?? '');
  return m ? m[1].toLowerCase() : '';
}

/**
 * The separate things a request asks for, each remembered on its own: a camera-and-microphone request is two
 * (allowing the microphone later does not also allow the camera), opening a link in another app is one per scheme.
 */
export function capabilities(permission: string, details: PermissionDetails = {}): string[] {
  if (permission === 'media') {
    const types = details.mediaTypes ?? (details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : []);
    const caps = [...new Set(types)].map((t) => (t === 'video' ? 'camera' : 'microphone')).sort();
    return caps.length ? caps : ['camera', 'microphone'];
  }
  if (permission === 'openExternal') return [`openExternal:${scheme(details.externalURL) || '?'}`];
  if (permission === 'geolocation-approximate') return ['geolocation'];
  return [permission];
}

const PHRASES: Record<string, string> = {
  'display-capture': 'see and record your screen',
  geolocation: 'know your location',
  'geolocation-approximate': 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'see text and images you copy to the clipboard',
  'deprecated-sync-clipboard-read': 'see text and images you copy to the clipboard',
  midi: 'use your MIDI devices',
  midiSysex: 'control and reprogram your MIDI devices',
  pointerLock: 'lock and hide your mouse pointer',
  keyboardLock: 'take over your keyboard',
  'idle-detection': 'know when you are using this computer',
  mediaKeySystem: 'play protected content',
  'storage-access': 'use its cookies and site data while it is embedded in another site',
  'top-level-storage-access': 'use its cookies and site data on other sites',
  'window-management': 'manage windows on all your displays',
  'local-fonts': 'use the fonts on your computer',
  hid: 'connect to HID devices',
  serial: 'connect to serial ports',
  usb: 'connect to USB devices',
  sensors: 'use your motion sensors',
  'screen-wake-lock': 'keep your screen on',
  'system-wake-lock': 'keep your computer awake',
  'speaker-selection': 'choose which speakers play its sound',
  'payment-handler': 'install a payment handler',
  'persistent-storage': 'store data on your computer permanently',
  'background-sync': 'sync data in the background',
  'periodic-background-sync': 'sync data in the background',
  'background-fetch': 'download data in the background',
  ar: 'use augmented reality',
  vr: 'use virtual reality',
  'hand-tracking': 'track your hands',
  nfc: 'use NFC devices',
  'local-network': 'connect to devices on your local network',
  'local-network-access': 'connect to devices on your local network',
  'loopback-network': 'connect to services running on your computer',
  'web-app-installation': 'install web apps',
  'web-printing': 'print without asking',
  'automatic-fullscreen': 'go full screen without asking',
  'captured-surface-control': 'scroll and zoom the tabs you share',
  'smart-card': 'use your smart cards',
};

/** What the page wants, as the dialog says it: "use your camera and microphone". */
export function permissionPhrase(permission: string, details: PermissionDetails = {}): string {
  if (permission === 'media') {
    const caps = capabilities(permission, details);
    return `use your ${caps.length === 2 ? 'camera and microphone' : caps[0]}`;
  }
  if (permission === 'openExternal') {
    const s = scheme(details.externalURL);
    return s === 'mailto' ? 'open an email link in your mail app' : s ? `open a "${s}:" link in another app` : 'open a link in another app';
  }
  if (permission === 'fileSystem') {
    const file = details.filePath ? ` ${details.filePath.split('/').pop()}` : ' files';
    return details.fileAccessType === 'writable' ? `save changes to${file}` : `read${file} on your computer`;
  }
  return PHRASES[permission] ?? `use "${permission}"`;
}

type Ask = (win: BrowserWindow, request: { site: string; phrase: string; url: string; permission: string; target?: string }) => Promise<boolean>;

export interface PolicyOptions {
  /** Whether these contents are the Browser pane (everything else is the app's own) */
  isPane(wc: WebContents | null): boolean;
  /** The window the dialog goes on; null denies */
  window(): BrowserWindow | null;
  /** Shows the question; default: the native dialog */
  ask?: Ask;
}

const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

/** The native question, on the main window: Allow or Don't allow (the default, and what Escape answers). */
const nativeAsk: Ask = async (win, { site, phrase, url, target }) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Allow', "Don't allow"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: `${site} wants to ${phrase}`,
    detail: `${target ? `${clip(target)}\n\n` : ''}Asked by ${clip(url)}\n\nSilo Harness remembers your answer for this site until it quits.`,
  });
  return r.response === 0;
};

/**
 * The decisions for one app run: what each site may use, asked once per site and permission. request() and check()
 * have the shapes of Electron's setPermissionRequestHandler and setPermissionCheckHandler callbacks.
 */
export function createPermissionPolicy(opts: PolicyOptions) {
  const ask = opts.ask ?? nativeAsk;
  /** "<site key> <capability>" → the user's answer */
  const answers = new Map<string, boolean>();
  /** Questions on screen, so a page asking twice at once gets one dialog */
  const pending = new Map<string, Promise<boolean>>();

  async function decide(wc: WebContents | null, permission: string, details: PermissionDetails): Promise<boolean> {
    if (!opts.isPane(wc)) return true;
    if (HARMLESS.has(permission)) return true;
    const url = details.requestingUrl || details.securityOrigin || wc?.getURL() || '';
    const site = siteKey(url);
    const keys = capabilities(permission, details).map((c) => `${site} ${c}`);
    if (keys.some((k) => answers.get(k) === false)) return false;
    if (keys.every((k) => answers.get(k) === true)) return true;
    const id = keys.join('|');
    let question = pending.get(id);
    if (!question) {
      const win = opts.window();
      if (!win || win.isDestroyed()) return false;
      question = ask(win, { site: siteName(url), phrase: permissionPhrase(permission, details), url, permission, target: details.externalURL })
        .catch(() => false)
        .then((ok) => {
          for (const k of keys) answers.set(k, ok);
          return ok;
        })
        .finally(() => pending.delete(id));
      pending.set(id, question);
    }
    return question;
  }

  return {
    decide,
    request(wc: WebContents, permission: string, callback: (granted: boolean) => void, details: PermissionDetails): void {
      decide(wc, permission, details ?? {}).then(callback, () => callback(false));
    },
    /** A synchronous check (navigator.permissions.query, Notification.permission): never asks, says what was decided. */
    check(wc: WebContents | null, permission: string, requestingOrigin: string, details: PermissionDetails): boolean {
      if (!opts.isPane(wc)) return true;
      if (HARMLESS.has(permission)) return true;
      const site = siteKey(details?.requestingUrl || requestingOrigin || wc?.getURL() || '');
      const keys = capabilities(permission, details ?? {}).map((c) => `${site} ${c}`);
      return keys.every((k) => answers.get(k) === true);
    },
    /** For the tests: what was answered so far */
    answers,
  };
}

let currentWindow: () => BrowserWindow | null = () => null;
let policy: ReturnType<typeof createPermissionPolicy> | null = null;
const installed = new WeakSet<Session>();

/**
 * Sets the permission handlers on the browser's session, where everything is the pane. Called once at launch
 * (session.ts); the answers given so far stay until the app quits.
 */
export function installPermissionHandlers(ses: Session, win: () => BrowserWindow | null): void {
  currentWindow = win;
  policy ??= createPermissionPolicy({ isPane: () => true, window: () => currentWindow() });
  if (installed.has(ses)) return;
  installed.add(ses);
  const p = policy;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => p.request(wc, permission, callback, details as PermissionDetails));
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => p.check(wc, permission, requestingOrigin, details as PermissionDetails));
}
