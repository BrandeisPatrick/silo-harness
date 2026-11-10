// Feature: the Browser pane's main-process side beyond the controller. Sets the browser's own session up at launch
// (session.ts), answers the window's browser.* RPC methods (tabs, popups, the one-time profile note, Clear browsing
// data, the user's own navigation, find in page, zoom, the blocked-popup strip, DevTools) and clears the profile at
// quit when Keep cookies is off. The browser's safety is wired here too: the permission bar's requests and answers
// (permissions.ts), the certificate interstitial (certificates.ts), the downloads with their tray and the agent's
// download bar (downloads.ts), and what Settings → Browser reads. Every answer comes from the window's RPC; no tool
// reaches any of it. The window's methods act on the tabs of the session in front (session-tabs.ts); what is the
// window's own (the profile, permissions, certificates, downloads) looks across every session's tabs. openChatLink is
// the main window's: a link clicked in the chat opens in the pane when Settings → Browser says so.

import { app as electronApp, dialog, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import type { BrowserConfig, BrowserListField, DownloadAction, DownloadState, PermissionAnswer } from '../../shared/browser';
import type { App } from '../app';
import { settingsLayer } from '../settings';
import { installCertificateHandler } from './certificates';
import { installChooserHandlers } from './choosers';
import { tabEvents, type BrowserController } from './controller';
import { DownloadManager, type ActingStamps } from './downloads';
import { configurePermissions, fileStore, permissionsFile } from './permissions';
import { remoteServerPorts, setRemotePorts } from './own-ports';
import { BUILT_IN_EXEMPT, SENSITIVE_PATTERNS } from './policy';
import { browserSession, clearBrowsingData, clearPrivateData, dismissProfileNote, prepareBrowserSession, profileNoteDue } from './session';
import type { SessionTabs } from './session-tabs';

/** The window's per-session tab sets (null while there is no window). */
export type Browsers = () => SessionTabs<BrowserController> | null;

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
export function openChatLink(app: App, controller: () => BrowserController | null, url: string): void {
  if (chatLinkTarget(url, app.config().browser) === 'pane' && controller()?.openLink(url)) {
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

/** The agents' acting across every session's tabs: any of them acting makes a download beginning now the agent's. */
export function mergedStamps(list: ActingStamps[]): ActingStamps {
  return { inFlight: list.reduce((n, s) => n + s.inFlight, 0), lastEnd: list.reduce((t, s) => Math.max(t, s.lastEnd), 0) };
}

/**
 * An agent's download that asks, from a tab of a session not on screen, is marked `elsewhere`: its bar waits for that
 * session (the tray still lists it).
 */
export function markElsewhere(list: DownloadState[], background: (tabId: string) => boolean): DownloadState[] {
  return list.map((d) => (d.asking && d.tabId && background(d.tabId) ? { ...d, elsewhere: true } : d));
}

export function setupBrowser(app: App, browsers: Browsers): void {
  const all = (): BrowserController[] => browsers()?.all() ?? [];
  /** The set of the session in front; `create` makes it (the user opened a tab or a page) */
  const controller = (create = false): BrowserController | null => browsers()?.current(create) ?? null;
  const tabIdOf = (wc: Parameters<BrowserController['tabIdOf']>[0]): string | null => {
    for (const c of all()) {
      const id = c.tabIdOf(wc);
      if (id) return id;
    }
    return null;
  };
  /** A tab of a session that is not on screen */
  const background = (tabId: string): boolean => {
    const owner = browsers()?.owner(tabId);
    return Boolean(owner && owner.sessionId !== app.runtime.foregroundId());
  };
  // The permission bar: requests go to the window, answers come back through browser.answerPermission.
  const permissions = configurePermissions({
    tabOf: tabIdOf,
    store: fileStore(permissionsFile(app.userData)),
    onPending: (list) => app.push('browser:permissions', list),
  });
  tabEvents.navigated.add((tabId, url, contentsId) => permissions.tabNavigated(tabId, url, contentsId));
  tabEvents.closed.add((tabId) => permissions.tabClosed(tabId));

  // The agent never opens the app's own remote-control server (its port is read when a browser call is checked)
  setRemotePorts(() => remoteServerPorts(app.userData, app.config().remote?.port));
  void prepareBrowserSession({ userData: app.userData, window: () => app.window() });
  const ses = browserSession();

  // Certificate errors in a tab's main frame: the tab shows the interstitial (the default rejection stands).
  installCertificateHandler(electronApp, {
    isBrowser: (wc) => wc.session === ses,
    onError: (wc, error) => all().some((c) => c.certificateError(wc, error)),
  });

  // No client certificate, Bluetooth device or HTTP sign-in is ever chosen for a page in the pane (choosers.ts)
  installChooserHandlers(electronApp as unknown as Parameters<typeof installChooserHandlers>[0], (wc) => (wc as { session?: unknown }).session === ses);

  // Downloads: saved without a dialog; the agent's wait for the download bar.
  const downloads = new DownloadManager({
    userData: app.userData,
    dir: () => downloadsDir(app.config().browser?.downloadsDir, electronApp.getPath('downloads')),
    defaultDir: () => electronApp.getPath('downloads'),
    stamps: () => (browsers() ? mergedStamps(all().map((c) => c.stamps())) : null),
    userStarted: (url) => all().some((c) => c.userDownload(url)),
    userInputAt: (tabId) => (tabId ? browsers()?.owner(tabId)?.set.userInputAt(tabId) ?? 0 : 0),
    tabOf: tabIdOf,
    onChange: (list) => app.push('browser:downloads', markElsewhere(list, background)),
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
  });
  downloads.attach(ses);
  // Another session came on screen: the agent's download bars of its tabs show, the others' wait.
  app.runtime.onForeground(() => setImmediate(() => app.push('browser:downloads', markElsewhere(downloads.list(), background))));

  /** The set in front; `create` makes it. Without a window: the error the window's call gets. */
  const need = (create = false): BrowserController => {
    if (!browsers()) throw new Error('The browser pane is not available: the window is closed.');
    const c = controller(create);
    if (!c) throw new Error('This session has no tabs.');
    return c;
  };
  app.rpc.handle('browser.tabs', () => controller()?.listTabs() ?? []);
  app.rpc.handle('browser.newTab', (url, opts) => need(true).newTab(typeof url === 'string' && url.trim() ? url : undefined, { background: Boolean(opts?.background) }));
  app.rpc.handle('browser.closeTab', (id) => need().closeTab(String(id)));
  app.rpc.handle('browser.activateTab', (id) => need().activate(String(id)));
  app.rpc.handle('browser.closePopup', (id) => controller()?.closePopup(String(id)));
  app.rpc.handle('browser.movePopup', (id, x, y) => controller()?.movePopup(String(id), Number(x) || 0, Number(y) || 0));
  app.rpc.handle('browser.go', (target) => need(true).userNavigate(String(target ?? '')));
  app.rpc.handle('browser.clearBrowsingData', async () => {
    await clearBrowsingData(browserSession());
    for (const c of all()) c.reloadAll();
  });
  app.rpc.handle('browser.profileNote', () => profileNoteDue(app.userData));
  app.rpc.handle('browser.dismissProfileNote', () => dismissProfileNote(app.userData));

  // ---------- Find, zoom, the blocked-popup strip, DevTools ----------
  app.rpc.handle('browser.find', (text, opts) => controller()?.findInPage(String(text ?? ''), opts?.forward !== false));
  app.rpc.handle('browser.stopFind', (opts) => controller()?.stopFindInPage(opts?.focusPage === true));
  app.rpc.handle('browser.zoom', (change) => {
    if (!ZOOMS.includes(change)) throw new Error(`Unknown zoom ${String(change)}`);
    return controller()?.zoom(change) ?? 100;
  });
  app.rpc.handle('browser.blockedPopup', (tabId, action) => {
    if (action !== 'show' && action !== 'dismiss') throw new Error(`Unknown action ${String(action)}`);
    need().blockedPopup(String(tabId), action);
  });
  app.rpc.handle('browser.devTools', () => controller()?.toggleDevTools());
  // Live tests only: the hidden window's views get no real input, so a test stands in for the user's key press
  if (process.env.SILO_HARNESS_LIVE_TEST) (app.rpc.handle as unknown as (name: string, fn: () => void) => void)('browser.liveTestUserInput', () => controller()?.liveTestUserInput());

  // ---------- Browser safety ----------
  app.rpc.handle('browser.permissions', () => permissions.pending());
  app.rpc.handle('browser.answerPermission', (id, answer) => (ANSWERS.includes(answer) ? permissions.answer(String(id), answer) : false));
  app.rpc.handle('browser.savedPermissions', () => permissions.saved());
  app.rpc.handle('browser.resetPermissions', (key, capability) => permissions.reset(typeof key === 'string' && key ? key : undefined, typeof capability === 'string' && capability ? capability : undefined));
  app.rpc.handle('browser.certProceed', (tabId) => need().certProceed(String(tabId)));
  app.rpc.handle('browser.certBack', (tabId) => need().certBack(String(tabId)));
  app.rpc.handle('browser.downloads', () => markElsewhere(downloads.list(), background));
  app.rpc.handle('browser.downloadAction', (id, action) => {
    if (!DOWNLOAD_ACTIONS.includes(action)) throw new Error(`Unknown download action ${String(action)}`);
    return downloads.action(String(id ?? ''), action).then((list) => markElsewhere(list, background));
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
