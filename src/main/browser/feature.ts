// Feature: the Browser pane's main-process side beyond the controller. Sets the browser's own session up at launch
// (session.ts), answers the window's browser.* RPC methods (tabs, popups, the one-time profile note, Clear browsing
// data) and clears the profile at quit when Keep cookies is off.

import type { App } from '../app';
import type { BrowserController } from './controller';
import { browserSession, clearBrowsingData, clearPrivateData, dismissProfileNote, prepareBrowserSession, profileNoteDue } from './session';

export function setupBrowser(app: App, controller: () => BrowserController | null): void {
  void prepareBrowserSession({ userData: app.userData, window: () => app.window() });
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
  app.rpc.handle('browser.clearBrowsingData', async () => {
    await clearBrowsingData(browserSession());
    controller()?.reloadAll();
  });
  app.rpc.handle('browser.profileNote', () => profileNoteDue(app.userData));
  app.rpc.handle('browser.dismissProfileNote', () => dismissProfileNote(app.userData));
  // Keep cookies off: the profile's cookies and site data go when the app quits.
  app.onQuit(async () => {
    if (app.config().browser?.keepCookies === false) await clearPrivateData(browserSession());
  });
}
