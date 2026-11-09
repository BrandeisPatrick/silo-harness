// What a page in the Browser pane may use: the camera, the microphone, the location, notifications and the rest.
// Electron grants every permission when a session has no handler. The pane has a session of its own
// (persist:browser, see session.ts), and these handlers are set on that one; the app's own window (its pages and the
// mod frames inside it) keeps the default session with no handler, and so every permission, as before.
//
// In the pane, full screen and writing to the clipboard are allowed without asking, USB, HID and serial devices are
// refused, and anything else asks the user on the permission bar under the URL bar, Chrome's way: "Allow this time"
// (for that tab, until it leaves the site), "Allow every time" and "Don't allow" (both saved per site and capability
// in userData/browser/permissions.json; Settings → Browser resets them). A request belongs to a tab (a popup's to the
// tab that opened it) and waits while its tab is in the background. The bar answers through an RPC with the request's
// random id, which only the window is given: no tool can answer.
//
// The policy itself (createPermissionPolicy) is pure: test/browser-permissions.js drives it without Electron.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, Session, WebContents } from 'electron';
import type { PermissionAnswer, PermissionRequestState, SavedPermission } from '../../shared/browser';

/** Allowed in the pane without asking. */
export const HARMLESS = new Set(['fullscreen', 'clipboard-sanitized-write']);

/** Devices the pane never connects to: the device handler says no, and so do the request and check handlers. */
export const DEVICES = new Set(['usb', 'hid', 'serial']);

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

/** The site as the bar names it: the host (and port) of a web page, else what the page is. */
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

/** What the page wants, as the bar says it: "use your camera and microphone". */
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

const LABELS: Record<string, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  notifications: 'Notifications',
  geolocation: 'Location',
  'display-capture': 'Screen recording',
  'clipboard-read': 'Reading the clipboard',
  'deprecated-sync-clipboard-read': 'Reading the clipboard',
  midi: 'MIDI devices',
  midiSysex: 'Reprogramming MIDI devices',
  pointerLock: 'Hiding the pointer',
  keyboardLock: 'Taking over the keyboard',
  'idle-detection': 'Knowing when you are away',
  fileSystem: 'Files on this Mac',
  'window-management': 'Window management',
  'local-fonts': 'Your fonts',
  'storage-access': 'Its cookies on other sites',
  'top-level-storage-access': 'Its cookies on other sites',
  sensors: 'Motion sensors',
  'screen-wake-lock': 'Keeping the screen on',
};

/** A capability as Settings → Browser → Permissions names it: "Camera", "Open mailto: links". */
export function capabilityLabel(capability: string): string {
  if (capability.startsWith('openExternal:')) {
    const s = capability.slice('openExternal:'.length);
    return s && s !== '?' ? `Opening ${s}: links in other apps` : 'Opening links in other apps';
  }
  return LABELS[capability] ?? capability;
}

// ---------- The saved answers ----------

export type Decision = 'allow' | 'deny';
/** The file's shape: { [site key]: { [capability]: 'allow' | 'deny' } } */
export type StoreData = Record<string, Record<string, Decision>>;

export interface PermissionStore {
  get(key: string, capability: string): Decision | undefined;
  set(key: string, capability: string, decision: Decision): void;
  /** One capability of a site, every capability of a site (no capability), or everything (no key) */
  remove(key?: string, capability?: string): void;
  entries(): { key: string; capability: string; decision: Decision }[];
}

/** Only the well-formed entries of what a file held. */
export function cleanStoreData(raw: unknown): StoreData {
  const out: StoreData = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, caps] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !caps || typeof caps !== 'object' || Array.isArray(caps)) continue;
    for (const [cap, d] of Object.entries(caps as Record<string, unknown>)) {
      if (cap && (d === 'allow' || d === 'deny')) (out[key] ??= {})[cap] = d;
    }
  }
  return out;
}

/** A store in memory; `persist` is told after every change. */
export function memoryStore(initial: StoreData = {}, persist?: (data: StoreData) => void): PermissionStore & { data(): StoreData } {
  const data = cleanStoreData(initial);
  const changed = () => persist?.(data);
  return {
    get: (key, cap) => data[key]?.[cap],
    set(key, cap, decision) {
      if (data[key]?.[cap] === decision) return;
      (data[key] ??= {})[cap] = decision;
      changed();
    },
    remove(key, cap) {
      if (key === undefined) {
        for (const k of Object.keys(data)) delete data[k];
      } else if (cap === undefined) delete data[key];
      else if (data[key]) {
        delete data[key][cap];
        if (!Object.keys(data[key]).length) delete data[key];
      }
      changed();
    },
    entries: () => Object.entries(data).flatMap(([key, caps]) => Object.entries(caps).map(([capability, decision]) => ({ key, capability, decision }))),
    data: () => JSON.parse(JSON.stringify(data)) as StoreData,
  };
}

export function permissionsFile(userData: string): string {
  return path.join(userData, 'browser', 'permissions.json');
}

/** The store in `file`, read now (a missing or broken file is an empty store) and written after every change. */
export function fileStore(file: string): PermissionStore & { data(): StoreData } {
  let initial: StoreData = {};
  try {
    initial = cleanStoreData(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    /* none yet */
  }
  return memoryStore(initial, (data) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('[browser] could not save the permission answers:', err instanceof Error ? err.message : String(err));
    }
  });
}

// ---------- Whose request it is ----------

/**
 * The tab a page's contents belong to: a tab's own contents are that tab; a popup's are the tab that opened it,
 * following openers up (a popup a popup opened). null when no tab is found within a few steps.
 */
export function ownerTabId(id: number, look: { tabOf(id: number): string | null; openerOf(id: number): number | null }, depth = 8): string | null {
  let cur: number | null = id;
  const seen = new Set<number>();
  for (let i = 0; cur !== null && i <= depth && !seen.has(cur); i++) {
    seen.add(cur);
    const tab = look.tabOf(cur);
    if (tab) return tab;
    cur = look.openerOf(cur);
  }
  return null;
}

// ---------- The policy ----------

/** The parts of a WebContents the policy reads. */
export interface Contents {
  id: number;
  getURL(): string;
}

export interface PolicyOptions {
  /** Whether these contents are the Browser pane (everything else is the app's own) */
  isPane(wc: Contents | null): boolean;
  /** The tab a page belongs to (a popup's: the tab that opened it); null: there is no tab to ask on, so no */
  tabOf(wc: Contents | null): string | null;
  store: PermissionStore;
  /** The requests waiting for an answer changed (pushed to the window) */
  onPending(list: PermissionRequestState[]): void;
  /** The request ids (default: random UUIDs) */
  newId?(): string;
}

interface Pending {
  state: PermissionRequestState;
  /** The site key and the capabilities the answer is saved under */
  key: string;
  caps: string[];
  /** The contents that asked (a tab's own page, or a popup's) */
  contentsId: number;
  waiters: ((granted: boolean) => void)[];
}

/**
 * The decisions for the pane: what each site may use. request() and check() have the shapes of Electron's
 * setPermissionRequestHandler and setPermissionCheckHandler callbacks; answer() is the bar's.
 */
export function createPermissionPolicy(opts: PolicyOptions) {
  const newId = opts.newId ?? (() => randomUUID());
  const pending: Pending[] = [];
  /** "Allow this time": per tab, the site it was given on and what it covers */
  const once = new Map<string, { key: string; caps: Set<string> }[]>();

  const list = (): PermissionRequestState[] => pending.map((p) => ({ ...p.state }));
  const emit = () => opts.onPending(list());

  const onceHas = (tabId: string, key: string, cap: string) => (once.get(tabId) ?? []).some((g) => g.key === key && g.caps.has(cap));

  /** true or false when the store (or a "this time" answer) decides it, null when the user has to be asked */
  function decided(tabId: string, key: string, caps: string[]): boolean | null {
    if (caps.some((c) => opts.store.get(key, c) === 'deny')) return false;
    if (caps.every((c) => opts.store.get(key, c) === 'allow' || onceHas(tabId, key, c))) return true;
    return null;
  }

  function settle(p: Pending, granted: boolean): void {
    const at = pending.indexOf(p);
    if (at >= 0) pending.splice(at, 1);
    for (const w of p.waiters) w(granted);
    p.waiters = [];
  }

  /** After an answer: the requests it decides too (the same site asking from another tab) go with it. */
  function resolveDecided(): void {
    for (const p of [...pending]) {
      const d = decided(p.state.tabId, p.key, p.caps);
      if (d !== null) settle(p, d);
    }
  }

  function decide(wc: Contents | null, permission: string, details: PermissionDetails = {}): Promise<boolean> {
    if (!opts.isPane(wc)) return Promise.resolve(true);
    if (HARMLESS.has(permission)) return Promise.resolve(true);
    if (DEVICES.has(permission)) return Promise.resolve(false);
    const tabId = opts.tabOf(wc);
    if (!tabId || !wc) return Promise.resolve(false);
    const url = details.requestingUrl || details.securityOrigin || wc.getURL() || '';
    const key = siteKey(url);
    const caps = capabilities(permission, details);
    const d = decided(tabId, key, caps);
    if (d !== null) return Promise.resolve(d);
    // The same question from the same page while it is on the bar: one bar, one answer for both.
    const same = pending.find((p) => p.state.tabId === tabId && p.key === key && p.caps.join(',') === caps.join(','));
    if (same) return new Promise((resolve) => same.waiters.push(resolve));
    return new Promise((resolve) => {
      const state: PermissionRequestState = { id: newId(), tabId, site: siteName(url), phrase: permissionPhrase(permission, details), permission, url };
      if (details.externalURL) state.target = details.externalURL;
      pending.push({ state, key, caps, contentsId: wc.id, waiters: [resolve] });
      emit();
    });
  }

  /** A synchronous check (navigator.permissions.query, Notification.permission): never asks, says what was decided. */
  function check(wc: Contents | null, permission: string, requestingOrigin: string, details: PermissionDetails = {}): boolean {
    if (!opts.isPane(wc)) return true;
    if (HARMLESS.has(permission)) return true;
    if (DEVICES.has(permission)) return false;
    const tabId = opts.tabOf(wc);
    if (!tabId) return false;
    const key = siteKey(details?.requestingUrl || requestingOrigin || wc?.getURL() || '');
    return decided(tabId, key, capabilities(permission, details ?? {})) === true;
  }

  /** The bar's answer. False when there is no such request (answered already, or its page went). */
  function answer(id: string, how: PermissionAnswer): boolean {
    const p = pending.find((q) => q.state.id === id);
    if (!p || (how !== 'once' && how !== 'always' && how !== 'deny')) return false;
    if (how === 'once') {
      const grants = once.get(p.state.tabId) ?? [];
      let g = grants.find((x) => x.key === p.key);
      if (!g) grants.push((g = { key: p.key, caps: new Set() }));
      for (const c of p.caps) g.caps.add(c);
      once.set(p.state.tabId, grants);
    } else for (const c of p.caps) opts.store.set(p.key, c, how === 'always' ? 'allow' : 'deny');
    settle(p, how !== 'deny');
    resolveDecided();
    emit();
    return true;
  }

  /**
   * A tab's page changed (a main-frame navigation): "Allow this time" ends when it leaves the site, and the questions
   * its old page asked go (the page that would get the answer is gone; a popup's stay).
   */
  function tabNavigated(tabId: string, url: string, contentsId?: number): void {
    const key = siteKey(url);
    const grants = once.get(tabId);
    if (grants) {
      const kept = grants.filter((g) => g.key === key);
      if (kept.length) once.set(tabId, kept);
      else once.delete(tabId);
    }
    const gone = pending.filter((p) => p.state.tabId === tabId && contentsId !== undefined && p.contentsId === contentsId);
    for (const p of gone) settle(p, false);
    if (gone.length) emit();
  }

  /** A tab closed: its questions are refused and its "this time" answers forgotten. */
  function tabClosed(tabId: string): void {
    once.delete(tabId);
    const gone = pending.filter((p) => p.state.tabId === tabId);
    for (const p of gone) settle(p, false);
    if (gone.length) emit();
  }

  /** A page's contents went (a popup closed, a tab's page was destroyed): its questions are refused. */
  function contentsGone(contentsId: number): void {
    const gone = pending.filter((p) => p.contentsId === contentsId);
    for (const p of gone) settle(p, false);
    if (gone.length) emit();
  }

  /** The window went: every question is refused. */
  function dropAll(): void {
    if (!pending.length) return;
    for (const p of [...pending]) settle(p, false);
    emit();
  }

  function saved(): SavedPermission[] {
    return opts.store
      .entries()
      .map(({ key, capability, decision }) => ({ key, site: siteName(key), capability, label: capabilityLabel(capability), decision }))
      .sort((a, b) => a.site.localeCompare(b.site) || a.label.localeCompare(b.label));
  }

  return {
    decide,
    request(wc: Contents | null, permission: string, callback: (granted: boolean) => void, details: PermissionDetails): void {
      decide(wc, permission, details ?? {}).then(callback, () => callback(false));
    },
    check,
    answer,
    /** Every tab's waiting requests, oldest first */
    pending: list,
    /** What the bar shows when `activeTabId` is on screen: that tab's oldest request (the others wait) */
    current(activeTabId: string | null): PermissionRequestState | null {
      const p = pending.find((q) => q.state.tabId === activeTabId);
      return p ? { ...p.state } : null;
    },
    tabNavigated,
    tabClosed,
    contentsGone,
    dropAll,
    saved,
    reset(key?: string, capability?: string): SavedPermission[] {
      opts.store.remove(key, capability);
      return saved();
    },
  };
}

export type PermissionPolicy = ReturnType<typeof createPermissionPolicy>;

// ---------- Electron ----------

/** What the feature (feature.ts) gives the handlers: the window's tabs, the store and where the requests go. */
export interface PermissionHost {
  tabOf(wc: WebContents | null): string | null;
  store: PermissionStore;
  onPending(list: PermissionRequestState[]): void;
}

let host: PermissionHost | null = null;
let policy: PermissionPolicy | null = null;
const installed = new WeakSet<Session>();

/**
 * Connects the handlers to the window's tabs and the saved answers (feature.ts, at launch). Until then every request
 * that would ask is refused: there is no bar to ask on.
 */
export function configurePermissions(h: PermissionHost): PermissionPolicy {
  host = h;
  policy = createPermissionPolicy({
    isPane: () => true,
    tabOf: (wc) => host?.tabOf(wc as WebContents | null) ?? null,
    store: h.store,
    onPending: (list) => host?.onPending(list),
  });
  return policy;
}

export function permissionPolicy(): PermissionPolicy | null {
  return policy;
}

/**
 * Sets the permission handlers on the browser's session, where everything is the pane (session.ts, once at launch).
 * `_window` is kept for that caller; the bar lives in the window's own page now.
 */
export function installPermissionHandlers(ses: Session, _window?: () => BrowserWindow | null): void {
  if (installed.has(ses)) return;
  installed.add(ses);
  const watched = new WeakSet<WebContents>();
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!policy) return callback(HARMLESS.has(permission));
    // A question whose page goes (a popup that closes) is refused rather than left on the bar.
    if (wc && !watched.has(wc)) {
      watched.add(wc);
      const id = wc.id;
      wc.once('destroyed', () => policy?.contentsGone(id));
    }
    policy.request(wc, permission, callback, details as PermissionDetails);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => (policy ? policy.check(wc, permission, requestingOrigin, details as PermissionDetails) : HARMLESS.has(permission)));
  // No USB, HID or serial device for a page in the pane: no permission, and the pickers are cancelled.
  ses.setDevicePermissionHandler(() => false);
  ses.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback(null);
  });
  ses.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  ses.on('select-serial-port', (event, _ports, _wc, callback) => {
    event.preventDefault();
    callback('');
  });
}
