// Popups: what a page's window.open and target="_blank" links become. A link or a featureless window.open becomes a
// tab; a sized window (the OAuth case) becomes a card floating over the pane, made of the contents Electron created
// for the page's own window.open (so window.opener and postMessage work), a 32 px bar of our own above it (favicon,
// title, host, ×, draggable) and a frame with a hairline and 12 px corners; the whole card is native views, since
// the window's page is drawn under the pane's views. A fourth open popup, and a javascript: URL, are refused.

import { ipcMain, View, WebContentsView, type BrowserWindow, type BrowserWindowConstructorOptions, type WebContents, type WindowOpenHandlerResponse } from 'electron';
import path from 'node:path';
import type { Bounds, PopupState } from '../../shared/browser';
import { BROWSER_PARTITION, cleanUserAgent } from './session';
import { faviconAllowed, fetchFavicon, NO_DEVICE_APIS, type BrowserTab } from './tab';

export const MAX_POPUPS = 3;
/** The card's title bar, above the page area */
export const POPUP_BAR = 32;
export const DEFAULT_POPUP_SIZE = { width: 480, height: 640 };
const MIN_POPUP = { width: 240, height: 160 };
const RADIUS = 12;

export type PopupDecision = 'tab' | 'background-tab' | 'popup' | 'deny';

/** "width=400,height=500,popup" → { width: '400', height: '500', popup: '1' } */
export function parseFeatures(features: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(features ?? '').split(/[,\s]+/)) {
    if (!part) continue;
    const [k, v] = part.split('=');
    const key = k.trim().toLowerCase();
    if (key) out[key] = v === undefined ? '1' : v.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** The size a window.open asked for (width/height, or innerWidth/innerHeight); absent fields are left out. */
export function requestedSize(features: string): { width?: number; height?: number } {
  const f = parseFeatures(features);
  const num = (...keys: string[]) => {
    for (const k of keys) {
      const n = Number(f[k]);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
    return undefined;
  };
  const out: { width?: number; height?: number } = {};
  const w = num('width', 'innerwidth');
  const h = num('height', 'innerheight');
  if (w) out.width = w;
  if (h) out.height = h;
  return out;
}

/**
 * What to do with a window a page wants to open: a plain link (foreground-tab) is a tab, a ⌘-click or middle click
 * (background-tab) a background tab, a window.open with a size (new-window with width or height) a popup, one
 * without a size a tab; a fourth popup while three are open and any javascript: URL are refused.
 */
export function popupDecision(d: { disposition: string; features: string; url: string; openPopups: number }): PopupDecision {
  if (/^\s*javascript:/i.test(d.url)) return 'deny';
  if (d.disposition === 'foreground-tab') return 'tab';
  if (d.disposition === 'background-tab') return 'background-tab';
  const size = requestedSize(d.features);
  if (size.width === undefined && size.height === undefined) return 'tab';
  if (d.openPopups >= MAX_POPUPS) return 'deny';
  return 'popup';
}

/**
 * Whether a navigation or a window from `from` to `to` leaves an artifact: page. An artifact the model wrote never
 * sends the tab (or a new one) anywhere else by itself, a link the user clicks included: the blocked-popup strip
 * offers the address instead, so leaving takes the user's own click on Show.
 */
export function leavesArtifact(from: string, to: string): boolean {
  return /^\s*artifact:/i.test(String(from ?? '')) && !/^\s*artifact:/i.test(String(to ?? ''));
}

/**
 * Whether a page may open `url` in a tab of its own (a link with target=_blank, a window.open without a size, the
 * context menu's Open Link in New Tab): web pages and artifacts only. A file:, data:, blob:, javascript: or about:
 * address from a page is refused: loaded from the main process it would skip Chromium's own block, and the agent could
 * then read a local file it was never given.
 */
export function opensInTab(url: string): boolean {
  return /^\s*(https?|artifact):/i.test(String(url ?? ''));
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/**
 * Where a new popup's page area goes: the requested size (default 480×640) clamped to the pane, with its bar, and
 * centred over the pane. The bar sits POPUP_BAR above the returned rectangle. A pane without a size (hidden) places
 * the card at the requested size; it is laid out again when the pane has one.
 */
export function popupBounds(req: { width?: number; height?: number }, pane: Bounds): Bounds {
  const wantW = req.width ?? DEFAULT_POPUP_SIZE.width;
  const wantH = req.height ?? DEFAULT_POPUP_SIZE.height;
  if (pane.width <= 0 || pane.height <= 0) return { x: pane.x, y: pane.y + POPUP_BAR, width: wantW, height: wantH };
  const width = clamp(wantW, Math.min(MIN_POPUP.width, pane.width), pane.width);
  const cardH = clamp(wantH + POPUP_BAR, Math.min(MIN_POPUP.height + POPUP_BAR, pane.height), pane.height);
  const x = pane.x + Math.round((pane.width - width) / 2);
  const barY = pane.y + Math.round((pane.height - cardH) / 2);
  return { x, y: barY + POPUP_BAR, width, height: cardH - POPUP_BAR };
}

/** The page area of a card whose bar's top-left corner is moved to (x, y), kept inside the pane. */
export function movedBounds(current: Bounds, x: number, y: number, pane: Bounds): Bounds {
  const cardH = current.height + POPUP_BAR;
  if (pane.width <= 0 || pane.height <= 0) return { ...current, x, y: y + POPUP_BAR };
  const nx = clamp(Math.round(x), pane.x, Math.max(pane.x, pane.x + pane.width - current.width));
  const ny = clamp(Math.round(y), pane.y, Math.max(pane.y, pane.y + pane.height - cardH));
  return { ...current, x: nx, y: ny + POPUP_BAR };
}

/** The same card after the pane changed: the size clamped again and the card kept inside. */
export function refitBounds(current: Bounds, pane: Bounds): Bounds {
  if (pane.width <= 0 || pane.height <= 0) return current;
  const width = clamp(current.width, Math.min(MIN_POPUP.width, pane.width), pane.width);
  const cardH = clamp(current.height + POPUP_BAR, Math.min(MIN_POPUP.height + POPUP_BAR, pane.height), pane.height);
  return movedBounds({ ...current, width, height: cardH - POPUP_BAR }, current.x, current.y - POPUP_BAR, pane);
}

/** The host of a page, as the bar shows it in grey ("accounts.example.com"); blank for a page without one. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : u.protocol === 'about:' ? '' : u.protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

export interface PopupHost {
  win: BrowserWindow;
  /** The pane's bounds in the window (its size is 0 while the window has none yet) */
  pane(): Bounds;
  /** The pane is on screen (popups hide with it) */
  visible(): boolean;
  /** The window's chrome is dark */
  dark(): boolean;
  /** The list changed (opened, moved, retitled, closed) */
  onChange(): void;
}

interface Popup {
  id: string;
  tabId: string;
  frame: View;
  card: View;
  bar: WebContentsView;
  view: WebContentsView;
  /** The page area, in the window */
  bounds: Bounds;
  title: string;
  url: string;
  favicon: string | null;
  barReady: boolean;
  dragFrom: Bounds | null;
}

const THEMES = {
  light: { bg: '#ffffff', text: '#191919', grey: '#666666', line: 'rgba(0,0,0,0.08)', hover: '#e9e9e9', frame: '#d9d9d9' },
  dark: { bg: '#1d1d1d', text: '#f0f0f0', grey: '#a1a1a1', line: 'rgba(255,255,255,0.08)', hover: '#292929', frame: '#3a3a3a' },
};
const GLOBE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.6 1.65 2.5 3.8 2.5 6s-.9 4.35-2.5 6c-1.6-1.65-2.5-3.8-2.5-6S6.4 3.65 8 2z"/></svg>';
const CROSS = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

/** The bar's page: the app's look in a 32 px strip (favicon or globe, title, host in grey, × at the right). */
export function popupBarHtml(dark: boolean): string {
  const t = dark ? THEMES.dark : THEMES.light;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Popup</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:${t.bg};color:${t.text};font:500 14px/20px -apple-system,BlinkMacSystemFont,"SF Pro Text",ui-sans-serif,system-ui,sans-serif;-webkit-user-select:none;user-select:none;cursor:default}
.bar{display:flex;align-items:center;gap:8px;height:${POPUP_BAR}px;padding:0 6px 0 12px;box-sizing:border-box;border-bottom:1px solid ${t.line}}
.icon{flex:none;width:16px;height:16px;display:inline-flex;color:${t.grey}}
.icon img{width:16px;height:16px;border-radius:3px}
.title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.host{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${t.grey};font-weight:400;font-size:13px;line-height:18px}
.x{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;color:${t.grey}}
.x:hover{background:${t.hover};color:${t.text}}
</style></head><body><div class="bar" id="bar"><span class="icon" id="icon">${GLOBE}</span><span class="title" id="title"></span><span class="host" id="host"></span><button type="button" class="x" id="x" aria-label="Close popup">${CROSS}</button></div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const GLOBE = $('icon').innerHTML;
  window.__update = (s) => {
    $('title').textContent = s.title || '';
    $('host').textContent = s.host || '';
    $('icon').innerHTML = s.favicon ? '<img alt="">' : GLOBE;
    if (s.favicon) $('icon').firstChild.src = s.favicon;
    document.title = s.title || 'Popup';
  };
  $('x').addEventListener('click', () => window.bar.act('close'));
  let drag = null;
  const bar = $('bar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('#x')) return;
    drag = { x: e.screenX, y: e.screenY };
    bar.setPointerCapture(e.pointerId);
    window.bar.act('drag-start');
  });
  bar.addEventListener('pointermove', (e) => { if (drag) window.bar.act('drag', e.screenX - drag.x, e.screenY - drag.y); });
  const end = (e) => { if (!drag) return; drag = null; try { bar.releasePointerCapture(e.pointerId); } catch {} window.bar.act('drag-end'); };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
})();
</script></body></html>`;
}

const BAR_PRELOAD = path.join(__dirname, 'popup-bar-preload.js');
let seq = 0;
let ipcInstalled = false;
const managers = new Set<PopupManager>();

/** The popups of one window's pane. */
export class PopupManager {
  private readonly popups: Popup[] = [];

  constructor(private readonly host: PopupHost) {
    managers.add(this);
    if (!ipcInstalled) {
      ipcInstalled = true;
      ipcMain.on('browser:popup-bar', (e, action: string, dx: number, dy: number) => {
        for (const m of managers) if (m.fromBar(e.sender, String(action), Number(dx) || 0, Number(dy) || 0)) return;
      });
    }
  }

  count(): number {
    return this.popups.length;
  }

  list(): PopupState[] {
    return this.popups.map((p) => ({ id: p.id, tabId: p.tabId, title: p.title, url: p.url, favicon: p.favicon, bounds: { ...p.bounds } }));
  }

  /**
   * The window-open handler of one tab (and of the popups it opens). `openTab` makes a tab for links and plain
   * window.open calls; a sized window becomes a popup card over the pane.
   */
  handlerFor(tab: BrowserTab, openTab: (url: string, background: boolean) => void, openerUrl: () => string = () => tab.webContents.getURL()): (details: { url: string; disposition: string; features: string }) => WindowOpenHandlerResponse {
    return (details) => {
      if (leavesArtifact(openerUrl(), details.url)) {
        tab.blockedPopup(details.url);
        return { action: 'deny' };
      }
      const decision = popupDecision({ disposition: details.disposition, features: details.features, url: details.url, openPopups: this.popups.length });
      // Another scheme is refused and counted on the strip, with no Show: the user can open it some other way if they mean to
      const blank = /^\s*about:blank\s*$/i.test(details.url) || details.url === '';
      if (decision !== 'deny' && !opensInTab(details.url) && !(decision === 'popup' && blank)) {
        tab.blockedPopup();
        return { action: 'deny' };
      }
      if (decision === 'tab' || decision === 'background-tab') {
        openTab(details.url, decision === 'background-tab');
        return { action: 'deny' };
      }
      if (decision === 'deny') {
        if (!/^\s*javascript:/i.test(details.url)) tab.blockedPopup(details.url);
        return { action: 'deny' };
      }
      const size = requestedSize(details.features);
      return {
        action: 'allow',
        createWindow: (options: BrowserWindowConstructorOptions) => this.create(tab, { width: options.width ?? size.width, height: options.height ?? size.height }, options, details.url, openTab),
      };
    };
  }

  /** Makes the card for the contents Electron created for the page's window.open, and returns those contents. */
  private create(tab: BrowserTab, size: { width?: number; height?: number }, options: BrowserWindowConstructorOptions, url: string, openTab: (url: string, background: boolean) => void): WebContents {
    const guest = (options as { webContents?: WebContents }).webContents;
    const prefs = { ...(options.webPreferences ?? {}), sandbox: true, contextIsolation: true, nodeIntegration: false, disableBlinkFeatures: NO_DEVICE_APIS };
    // The contents Electron made carry the opener relation; a fresh view (never seen, kept as a fallback) would not.
    const view = guest && !guest.isDestroyed() ? new WebContentsView({ webContents: guest, webPreferences: prefs }) : new WebContentsView({ webPreferences: { ...prefs, partition: BROWSER_PARTITION } });
    const wc = view.webContents;
    wc.setUserAgent(cleanUserAgent(wc.getUserAgent()));
    const t = this.host.dark() ? THEMES.dark : THEMES.light;
    const frame = new View();
    frame.setBackgroundColor(t.frame);
    frame.setBorderRadius(RADIUS);
    const card = new View();
    card.setBackgroundColor(t.bg);
    card.setBorderRadius(RADIUS - 1);
    const bar = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: BAR_PRELOAD } });
    view.setBorderRadius(RADIUS - 1);
    card.addChildView(bar);
    card.addChildView(view);
    frame.addChildView(card);
    const popup: Popup = {
      id: `popup-${++seq}`,
      tabId: tab.id,
      frame,
      card,
      bar,
      view,
      bounds: popupBounds(size, this.host.pane()),
      title: '',
      url,
      favicon: null,
      barReady: false,
      dragFrom: null,
    };
    this.popups.push(popup);
    this.host.win.contentView.addChildView(frame);
    this.place(popup);
    frame.setVisible(this.host.visible());

    bar.webContents.on('did-finish-load', () => {
      popup.barReady = true;
      this.updateBar(popup);
    });
    void bar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(popupBarHtml(this.host.dark()))}`);
    bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const refresh = () => {
      if (wc.isDestroyed()) return;
      popup.title = wc.getTitle();
      popup.url = wc.getURL() || popup.url;
      this.updateBar(popup);
      this.host.onChange();
    };
    for (const ev of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-stop-loading'] as const) wc.on(ev as 'did-navigate', refresh);
    wc.on('did-navigate', () => {
      popup.favicon = null;
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      const icon = favicons.find((f) => /^(https?|data):/i.test(f));
      if (!icon || !faviconAllowed(icon, wc.getURL())) return;
      void fetchFavicon(icon).then((data) => {
        if (wc.isDestroyed() || !this.popups.includes(popup)) return;
        popup.favicon = data;
        this.updateBar(popup);
        this.host.onChange();
      });
    });
    // A popup that closes itself (window.close()), or whose contents go, is taken down.
    wc.on('destroyed', () => this.remove(popup));
    // A popup opening another window: the same rules as its tab.
    wc.setWindowOpenHandler(this.handlerFor(tab, openTab, () => (wc.isDestroyed() ? '' : wc.getURL())));
    this.host.onChange();
    return wc;
  }

  private updateBar(p: Popup): void {
    if (!p.barReady || p.bar.webContents.isDestroyed()) return;
    const state = { title: p.title, host: hostOf(p.url), favicon: p.favicon };
    p.bar.webContents.executeJavaScript(`window.__update(${JSON.stringify(state)})`).catch(() => undefined);
  }

  /** Puts the frame, the bar and the page where `bounds` (the page area) says. */
  private place(p: Popup): void {
    const b = p.bounds;
    const width = Math.max(1, Math.round(b.width));
    const height = Math.max(1, Math.round(b.height));
    p.frame.setBounds({ x: Math.round(b.x) - 1, y: Math.round(b.y) - POPUP_BAR - 1, width: width + 2, height: height + POPUP_BAR + 2 });
    p.card.setBounds({ x: 1, y: 1, width, height: height + POPUP_BAR });
    p.bar.setBounds({ x: 0, y: 0, width, height: POPUP_BAR });
    p.view.setBounds({ x: 0, y: POPUP_BAR, width, height });
  }

  /** The pane moved, resized, or was shown or hidden: every card follows. */
  layout(): void {
    const pane = this.host.pane();
    const visible = this.host.visible();
    for (const p of this.popups) {
      p.bounds = refitBounds(p.bounds, pane);
      this.place(p);
      p.frame.setVisible(visible);
    }
    if (this.popups.length) this.host.onChange();
  }

  /** The user dragged a card (by its bar) so the bar's corner is at (x, y). */
  move(id: string, x: number, y: number): void {
    const p = this.popups.find((q) => q.id === id);
    if (!p) return;
    p.bounds = movedBounds(p.bounds, x, y, this.host.pane());
    this.place(p);
    this.host.onChange();
  }

  close(id: string): void {
    const p = this.popups.find((q) => q.id === id);
    if (!p) return;
    if (!p.view.webContents.isDestroyed()) p.view.webContents.close();
    else this.remove(p);
  }

  /** The popups a tab opened go with it. */
  closeFor(tabId: string): void {
    for (const p of [...this.popups]) if (p.tabId === tabId) this.close(p.id);
  }

  private remove(p: Popup): void {
    const at = this.popups.indexOf(p);
    if (at < 0) return;
    this.popups.splice(at, 1);
    try {
      this.host.win.contentView.removeChildView(p.frame);
    } catch {
      /* the window is going */
    }
    if (!p.bar.webContents.isDestroyed()) p.bar.webContents.close();
    this.host.onChange();
  }

  /** A message from a card's bar: × or a drag. True when the sender was one of ours. */
  private fromBar(sender: WebContents, action: string, dx: number, dy: number): boolean {
    const p = this.popups.find((q) => !q.bar.webContents.isDestroyed() && q.bar.webContents.id === sender.id);
    if (!p) return false;
    if (action === 'close') this.close(p.id);
    else if (action === 'drag-start') p.dragFrom = { ...p.bounds };
    else if (action === 'drag' && p.dragFrom) this.move(p.id, p.dragFrom.x + dx, p.dragFrom.y - POPUP_BAR + dy);
    else if (action === 'drag-end') p.dragFrom = null;
    return true;
  }
}
