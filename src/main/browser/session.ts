// The browser's own profile: the persist:browser partition every tab and popup is made in, apart from the app's own
// pages, artifacts and mod pages (which keep the default session). Set up once at launch: the user agent, the spell
// checker, the permission handlers, and on the first run with the partition the cookies of the default session
// (where the pane used to live) are copied over, so nobody is signed out, and then cleared there. "Keep cookies"
// (AppConfig.browser.keepCookies, on by default) decides whether the profile's cookies and site data survive a quit;
// "Clear browsing data" clears them, the caches and HTTP auth on demand.

import { session, type BrowserWindow, type Cookie, type CookiesSetDetails, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { installPermissionHandlers } from './permissions';

export const BROWSER_PARTITION = 'persist:browser';

/** The browser's session (made on first use). */
export function browserSession(): Session {
  return session.fromPartition(BROWSER_PARTITION);
}

/** A page sees a plain Chrome: no Electron token and no app token in the user agent. */
export function cleanUserAgent(ua: string): string {
  return ua.replace(/ Electron\/[\d.]+/, '').replace(/ (?:silo|open)-harness\/[\d.]+/i, '');
}

/** What a session cookie's "Keep cookies: off" clears at quit: the jar and the site data a sign-in may live in. */
export const PRIVATE_STORAGES = ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] as const;

/** The parts of a session the migration and the clearing use, so tests can stand them in. */
export interface CookieJar {
  cookies: {
    get(filter: Record<string, unknown>): Promise<Cookie[]>;
    set(details: CookiesSetDetails): Promise<void>;
  };
  clearStorageData(options?: { storages?: string[] }): Promise<void>;
}

/**
 * The cookies.set details that make `c` again in another jar: the url built from `secure`, the domain (leading dot
 * stripped) and the path; a hostOnly cookie is set without `domain` (so it stays host-only); httpOnly,
 * expirationDate (none for a session cookie), sameSite and the value are carried.
 */
export function cookieToSet(c: Cookie): CookiesSetDetails {
  const host = (c.domain ?? '').replace(/^\./, '');
  const cookiePath = c.path && c.path.startsWith('/') ? c.path : '/';
  const details: CookiesSetDetails = {
    url: `${c.secure ? 'https' : 'http'}://${host}${cookiePath}`,
    name: c.name,
    value: c.value,
    path: cookiePath,
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    sameSite: c.sameSite ?? 'unspecified',
  };
  if (!c.hostOnly && host) details.domain = host;
  if (typeof c.expirationDate === 'number' && Number.isFinite(c.expirationDate)) details.expirationDate = c.expirationDate;
  return details;
}

/**
 * Copies every cookie of `from` into `to`, one by one (a cookie that cannot be set is counted and skipped), then
 * clears the cookies of `from`. Returns how many came over and how many did not.
 */
export async function migrateCookies(from: CookieJar, to: CookieJar): Promise<{ copied: number; failed: number }> {
  let copied = 0;
  let failed = 0;
  let all: Cookie[] = [];
  try {
    all = await from.cookies.get({});
  } catch (err) {
    console.warn('[browser] could not read the cookies to migrate:', err instanceof Error ? err.message : String(err));
    return { copied, failed };
  }
  for (const c of all) {
    try {
      await to.cookies.set(cookieToSet(c));
      copied++;
    } catch {
      failed++;
    }
  }
  try {
    await from.clearStorageData({ storages: ['cookies'] });
  } catch (err) {
    console.warn('[browser] could not clear the old cookie jar:', err instanceof Error ? err.message : String(err));
  }
  return { copied, failed };
}

/** The marker written after the migration: userData/browser/profile.json. */
export interface ProfileMarker {
  migrated: true;
  copied: number;
  failed: number;
  /** When, as an ISO date */
  at: string;
  /** The one-time note under the URL bar is still to be shown */
  noteDue: boolean;
}

export function profileMarkerPath(userData: string): string {
  return path.join(userData, 'browser', 'profile.json');
}

export function readProfileMarker(userData: string): ProfileMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(profileMarkerPath(userData), 'utf8')) as Partial<ProfileMarker>;
    if (!raw || raw.migrated !== true) return null;
    return { migrated: true, copied: Number(raw.copied) || 0, failed: Number(raw.failed) || 0, at: String(raw.at ?? ''), noteDue: raw.noteDue === true };
  } catch {
    return null;
  }
}

export function writeProfileMarker(userData: string, marker: ProfileMarker): void {
  const file = profileMarkerPath(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(marker, null, 2));
}

/** Whether the note "The browser now keeps a profile of its own…" is still to be shown. */
export function profileNoteDue(userData: string): boolean {
  return readProfileMarker(userData)?.noteDue === true;
}

export function dismissProfileNote(userData: string): void {
  const m = readProfileMarker(userData);
  if (m && m.noteDue) writeProfileMarker(userData, { ...m, noteDue: false });
}

/**
 * The first run with the partition: the default session's cookies come over, then its jar is cleared. The marker
 * says it happened, and that the note is due when any sign-in came along. Not repeated once the marker exists.
 */
export async function migrateProfileOnce(userData: string, from: CookieJar = session.defaultSession, to: CookieJar = browserSession()): Promise<ProfileMarker | null> {
  if (readProfileMarker(userData)) return null;
  const { copied, failed } = await migrateCookies(from, to);
  const marker: ProfileMarker = { migrated: true, copied, failed, at: new Date().toISOString(), noteDue: copied > 0 };
  writeProfileMarker(userData, marker);
  if (copied || failed) console.log(`[browser] cookies moved to the browser's own profile: ${copied} copied, ${failed} failed`);
  return marker;
}

/** Cookies and site data of the browser's profile (what "Keep cookies: off" clears at quit). */
export function clearPrivateData(ses: CookieJar = browserSession()): Promise<void> {
  return ses.clearStorageData({ storages: [...PRIVATE_STORAGES] });
}

/** Everything the profile holds about sites: the private data, the caches and HTTP auth. */
export async function clearBrowsingData(ses: Session = browserSession()): Promise<void> {
  await clearPrivateData(ses);
  await ses.clearCache();
  await ses.clearAuthCache();
}

let prepared = false;

/**
 * Sets the browser session up, once: the user agent, the spell checker and the permission handlers (the app's own
 * window keeps the default session, which has no handler and so grants everything, as before). Then the cookie
 * migration, awaited by nobody: the first tab is blank, so nothing races it.
 */
export function prepareBrowserSession(opts: { userData: string; window: () => BrowserWindow | null }): Promise<void> {
  const ses = browserSession();
  if (!prepared) {
    prepared = true;
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
    ses.setSpellCheckerEnabled(true);
    installPermissionHandlers(ses, opts.window);
  }
  return migrateProfileOnce(opts.userData).then(
    () => undefined,
    (err: unknown) => console.warn('[browser] the cookie migration failed:', err),
  );
}
