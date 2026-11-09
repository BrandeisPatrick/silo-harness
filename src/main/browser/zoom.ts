// Zoom per site. ⌘+ / ⌘− / ⌘0 (in the page, in the pane's chrome, or the View menu while a page has the focus) step
// through Chrome's levels, 25 % to 500 %, and the level is kept per site in userData/browser/zoom.json, so a tab that
// lands on that site again (also after a relaunch) gets it back. A site is the page's host, which is how Chromium
// keeps zoom within a run (every tab on a host follows it): a key of our own with the scheme or the port would fight
// that. Only web pages are saved; a local file or an artifact zooms for the run alone. The URL pill shows a chip
// ("125%") while a page is not at 100 %, which resets it on click.
//
// The steps, the keys and the store's file are pure: test/browser-polish.js.

import { app, type MenuItemConstructorOptions, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type ZoomChange = 'in' | 'out' | 'reset';

/** Chrome's zoom levels, in percent. */
export const ZOOM_STEPS: readonly number[] = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

/** Chromium's zoom level for a percentage (each level is 20 % more than the one before: 120 % is level 1). */
export function levelOf(percent: number): number {
  return Math.log(percent / 100) / Math.log(1.2);
}

/** The percentage of a zoom factor (1.25 → 125), as the chip shows it. */
export function percentOf(factor: number): number {
  return Number.isFinite(factor) && factor > 0 ? Math.round(factor * 100) : 100;
}

/**
 * The level after ⌘+ (the next step above the current one), ⌘− (the next step below) or ⌘0 (100). A level between
 * two steps (set by an older build, or a pinch) moves to the nearest step in that direction; the ends stay put.
 */
export function nextZoom(current: number, change: ZoomChange): number {
  if (change === 'reset') return 100;
  const now = Number.isFinite(current) && current > 0 ? current : 100;
  if (change === 'in') return ZOOM_STEPS.find((s) => s > now + 0.5) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((s) => s < now - 0.5) ?? ZOOM_STEPS[0];
}

/** The site a page's zoom is saved under: its host, lower case, for http and https pages; null for any other page. */
export function zoomKey(url: string): string | null {
  try {
    const u = new URL(String(url ?? ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** A zoom.json, well-formed: hosts with a level that is one of the steps and not 100. */
export function cleanZoomFile(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(value);
    if (key && key.length <= 300 && ZOOM_STEPS.includes(n) && n !== 100) out[key.toLowerCase()] = n;
  }
  return out;
}

export function zoomFile(userData: string): string {
  return path.join(userData, 'browser', 'zoom.json');
}

/** The saved levels, read once and written at every change (a crash keeps them). */
export class ZoomStore {
  private levels: Record<string, number>;

  constructor(private readonly file: string) {
    try {
      this.levels = cleanZoomFile(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      this.levels = {};
    }
  }

  /** The level saved for a site, or undefined (100). */
  get(key: string | null): number | undefined {
    return key ? this.levels[key] : undefined;
  }

  /** Saves a site's level; 100 forgets it. */
  set(key: string | null, percent: number): void {
    if (!key) return;
    const before = this.levels[key];
    if (percent === 100 || !ZOOM_STEPS.includes(percent)) delete this.levels[key];
    else this.levels[key] = percent;
    if (this.levels[key] === before) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.levels, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[browser] could not save the zoom levels:', err instanceof Error ? err.message : String(err));
    }
  }

  all(): Record<string, number> {
    return { ...this.levels };
  }
}

let shared: ZoomStore | null = null;

/** The app's store (userData/browser/zoom.json), made on first use. */
export function zoomStore(): ZoomStore {
  return (shared ??= new ZoomStore(zoomFile(app.getPath('userData'))));
}

/** A page's zoom now, in percent. */
export function zoomOf(wc: WebContents): number {
  return wc.isDestroyed() ? 100 : percentOf(wc.getZoomFactor());
}

/** One step on a page of the browser (its host keeps the level). Returns the new level. */
export function stepZoom(wc: WebContents, change: ZoomChange, store: ZoomStore = zoomStore()): number {
  if (wc.isDestroyed()) return 100;
  const next = nextZoom(zoomOf(wc), change);
  wc.setZoomLevel(levelOf(next));
  store.set(zoomKey(wc.getURL()), next);
  return next;
}

/** A page that landed on a site gets the site's saved level (nothing changes for a site without one). */
export function applySavedZoom(wc: WebContents, url: string, store: ZoomStore = zoomStore()): void {
  const saved = store.get(zoomKey(url));
  if (saved === undefined || wc.isDestroyed() || zoomOf(wc) === saved) return;
  wc.setZoomLevel(levelOf(saved));
}

/**
 * The View menu's zoom items. The menu's own zoom roles act on whichever page has the focus, the browser's included,
 * with steps of their own and nothing saved; these send a page of the browser to `browser` (which returns true when
 * the contents were one of its pages), and the app's own window zooms as the roles did. A key pressed inside a page
 * never gets here (the tab takes it first); a menu click does.
 */
export function zoomMenuItems(browser: (wc: WebContents, change: ZoomChange) => boolean, focused: () => WebContents | null): MenuItemConstructorOptions[] {
  const run = (change: ZoomChange) => () => {
    const wc = focused();
    if (!wc || wc.isDestroyed()) return;
    if (browser(wc, change)) return;
    wc.setZoomLevel(change === 'reset' ? 0 : wc.getZoomLevel() + (change === 'in' ? 0.5 : -0.5));
  };
  return [
    { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: run('reset') },
    { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', click: run('in') },
    // ⌘= without Shift, as Chrome takes it
    { label: 'Zoom In', accelerator: 'CommandOrControl+=', visible: false, acceleratorWorksWhenHidden: true, click: run('in') },
    { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: run('out') },
  ];
}
