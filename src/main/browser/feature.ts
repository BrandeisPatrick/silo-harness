// Feature: the Browser pane's main-process side beyond the controller. Sets the browser's own session up at launch
// (session.ts), answers the window's browser.* RPC methods (tabs, popups, the one-time profile note, Clear browsing
// data, the user's own navigation, find in page, zoom, the blocked-popup strip, DevTools) and clears the profile at
// quit when Keep cookies is off. The browser's safety is wired here too: the permission bar's requests and answers
// (permissions.ts), the certificate interstitial (certificates.ts), the downloads with their tray and the agent's
// download bar (downloads.ts), and what Settings → Browser reads. Every answer comes from the window's RPC; no tool
// reaches any of it. openChatLink is the main window's: a link clicked in the chat opens in the pane when Settings →
// Browser says so.

import { app as electronApp, dialog, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import type { BrowserConfig, BrowserListField, DownloadAction, PermissionAnswer } from '../../shared/browser';
import type { App } from '../app';
import { settingsLayer } from '../settings';
import { installCertificateHandler } from './certificates';
import { tabEvents, type BrowserController } from './controller';
import { DownloadManager } from './downloads';
import { configurePermissions, fileStore, permissionsFile } from './permissions';
import { BUILT_IN_EXEMPT, SENSITIVE_PATTERNS } from './policy';
import { browserSession, clearBrowsingData, clearPrivateData, dismissProfileNote, prepareBrowserSession, profileNoteDue } from './session';

const ANSWERS: PermissionAnswer[] = ['once', 'always', 'deny'];
const DOWNLOAD_ACTIONS: DownloadAction[] = ['open', 'show', 'cancel', 'clear', 'allow', 'deny'];
const LISTS: BrowserListField[] = ['alwaysAllowed', 'sensitive', 'exempt'];
const ZOOMS = ['in', 'out', 'reset'] as const;

/**
 * Where a link clicked in the chat goes: the Browser pane when Settings → Browser says so and it is a web page (http
 * or https), else the default browser (and any other scheme, mailto: included, to the app the Mac has for it).
 */
export function chatLinkTarget(url: string, browser: Pick<BrowserConfig, 'openChatLinksInPane'> | undefined): 'pane' | 'external' {
  if (browser?.openChatLinksInPane !== true) return 'external';
  try {
    const u = new URL(String(url ?? ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? 'pane' : 'external';
  } catch {
    return 'external';
  }
}

/**
 * A link clicked in the chat (the main window's window-open handler): in a new tab of the pane, brought forward, as
 * the user's own navigation (no agent stamp, no site card: the cards are for the agent's calls), when chatLinkTarget
 * says so and the pane has room; otherwise the default browser, as before.
 */
export function openChatLink(app: App, controller: BrowserController | null, url: string): void {
  if (chatLinkTarget(url, app.config().browser) === 'pane' && controller?.openLink(url)) {
    app.push('browser:show', null);
    return;
  }
  void shell.openExternal(url).catch((err: unknown) => console.warn('[browser] could not open a link:', err instanceof Error ? err.message : String(err)));
}

/** `list` with `value` added (once, whatever its case) or removed. */
export function editedList(list: readonly string[], op: 'add' | 'remove', value: string): string[] {
  const v = value.trim();
  if (op === 'add') return list.some((x) => x.toLowerCase() === v.toLowerCase()) ? [...list] : [...list, v];
  return list.filter((x) => x !== v);
}

/** The downloads folder: Settings → Browser's (with ~ expanded), else the Mac's Downloads folder. */
export function downloadsDir(configured: string | undefined, fallback: string): string {
  const dir = String(configured ?? '').trim();
  if (!dir) return fallback;
  return path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
}

export function setupBrowser(app: App, controller: () => BrowserController | null): void {
  // The permission bar: requests go to the window, answers come back through browser.answerPermission.
  const permissions = configurePermissions({
    tabOf: (wc) => controller()?.tabIdOf(wc) ?? null,
    store: fileStore(permissionsFile(app.userData)),
    onPending: (list) => app.push('browser:permissions', list),
  });
  tabEvents.navigated.add((tabId, url, contentsId) => permissions.tabNavigated(tabId, url, contentsId));
  tabEvents.closed.add((tabId) => permissions.tabClosed(tabId));

  void prepareBrowserSession({ userData: app.userData, window: () => app.window() });
  const ses = browserSession();

  // Certificate errors in a tab's main frame: the tab shows the interstitial (the default rejection stands).
  installCertificateHandler(electronApp, {
    isBrowser: (wc) => wc.session === ses,
    onError: (wc, error) => controller()?.certificateError(wc, error) ?? false,
  });

  // Downloads: saved without a dialog; the agent's wait for the download bar.
  const downloads = new DownloadManager({
    userData: app.userData,
    dir: () => downloadsDir(app.config().browser?.downloadsDir, electronApp.getPath('downloads')),
    defaultDir: () => electronApp.getPath('downloads'),
    stamps: () => controller()?.stamps() ?? null,
    userStarted: (url) => controller()?.userDownload(url) ?? false,
    tabOf: (wc) => controller()?.tabIdOf(wc) ?? null,
    onChange: (list) => app.push('browser:downloads', list),
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
  });
  downloads.attach(ses);

  const need = (): BrowserController => {
    const c = controller();
    if (!c) throw new Error('The browser pane is not available: the window is closed.');
    return c;
  };
  app.rpc.handle('browser.tabs', () => need().listTabs());
  app.rpc.handle('browser.newTab', (url, opts) => need().newTab(typeof url === 'string' && url.trim() ? url : undefined, { background: Boolean(opts?.background) }));
  app.rpc.handle('browser.closeTab', (id) => need().closeTab(String(id)));
  app.rpc.handle('browser.activateTab', (id) => need().activate(String(id)));
  app.rpc.handle('browser.closePopup', (id) => need().closePopup(String(id)));
  app.rpc.handle('browser.movePopup', (id, x, y) => need().movePopup(String(id), Number(x) || 0, Number(y) || 0));
  app.rpc.handle('browser.go', (target) => need().userNavigate(String(target ?? '')));
  app.rpc.handle('browser.clearBrowsingData', async () => {
    await clearBrowsingData(browserSession());
    controller()?.reloadAll();
  });
  app.rpc.handle('browser.profileNote', () => profileNoteDue(app.userData));
  app.rpc.handle('browser.dismissProfileNote', () => dismissProfileNote(app.userData));

  // ---------- Find, zoom, the blocked-popup strip, DevTools ----------
  app.rpc.handle('browser.find', (text, opts) => need().findInPage(String(text ?? ''), opts?.forward !== false));
  app.rpc.handle('browser.stopFind', (opts) => need().stopFindInPage(opts?.focusPage === true));
  app.rpc.handle('browser.zoom', (change) => {
    if (!ZOOMS.includes(change)) throw new Error(`Unknown zoom ${String(change)}`);
    return need().zoom(change);
  });
  app.rpc.handle('browser.blockedPopup', (tabId, action) => {
    if (action !== 'show' && action !== 'dismiss') throw new Error(`Unknown action ${String(action)}`);
    need().blockedPopup(String(tabId), action);
  });
  app.rpc.handle('browser.devTools', () => need().toggleDevTools());

  // ---------- Browser safety ----------
  app.rpc.handle('browser.permissions', () => permissions.pending());
  app.rpc.handle('browser.answerPermission', (id, answer) => (ANSWERS.includes(answer) ? permissions.answer(String(id), answer) : false));
  app.rpc.handle('browser.savedPermissions', () => permissions.saved());
  app.rpc.handle('browser.resetPermissions', (key, capability) => permissions.reset(typeof key === 'string' && key ? key : undefined, typeof capability === 'string' && capability ? capability : undefined));
  app.rpc.handle('browser.certProceed', (tabId) => need().certProceed(String(tabId)));
  app.rpc.handle('browser.certBack', (tabId) => need().certBack(String(tabId)));
  app.rpc.handle('browser.downloads', () => downloads.list());
  app.rpc.handle('browser.downloadAction', (id, action) => {
    if (!DOWNLOAD_ACTIONS.includes(action)) throw new Error(`Unknown download action ${String(action)}`);
    return downloads.action(String(id ?? ''), action);
  });
  app.rpc.handle('browser.chooseDownloadsDir', async () => {
    const win = app.window();
    const current = downloadsDir(app.config().browser?.downloadsDir, electronApp.getPath('downloads'));
    const opts = { title: 'Downloads folder', buttonLabel: 'Choose', defaultPath: current, properties: ['openDirectory' as const, 'createDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  app.rpc.handle('browser.editList', (field, op, value) => {
    if (!LISTS.includes(field)) throw new Error(`No browser list ${String(field)}`);
    if (op !== 'add' && op !== 'remove') throw new Error(`Unknown list edit ${String(op)}`);
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v || v.length > 300 || /[\r\n]/.test(v)) throw new Error('Not a site.');
    const owner = settingsLayer.info().owned[`browser.${field}`];
    if (owner) throw new Error(`Set in ${owner === 'project' ? "the project's" : 'your'} settings.json; change it there.`);
    const next = app.updateConfig((c) => ({ ...c, browser: { ...c.browser, [field]: editedList(c.browser?.[field] ?? [], op, v) } }));
    return [...next.browser[field]];
  });
  app.rpc.handle('browser.builtInLists', () => ({
    sensitive: SENSITIVE_PATTERNS.map(({ pattern, kind }) => ({ pattern, kind })),
    exempt: [...BUILT_IN_EXEMPT],
    downloadsDir: electronApp.getPath('downloads'),
  }));

  // Keep cookies off: the profile's cookies and site data go when the app quits. The agent's downloads still waiting
  // for an answer are cancelled, and the list is saved.
  app.onQuit(async () => {
    downloads.quit();
    permissions.dropAll();
    if (app.config().browser?.keepCookies === false) await clearPrivateData(browserSession());
  });
}
