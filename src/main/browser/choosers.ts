// The device and identity choosers Chromium would answer by itself for a page in the pane. Electron's defaults are
// not safe there: with no select-client-certificate handler the first certificate in the Keychain is sent to any site
// that asks (Electron's typings: preventDefault "prevents the application from using the first certificate from the
// store"), and Web Bluetooth's chooser picks the first device it finds. So for the pane's pages and popups: no client
// certificate, no Bluetooth device, and HTTP authentication (the login event, which Electron cancels when unhandled)
// cancelled explicitly; a sign-in sheet only the user can answer is a later feature. Other windows keep Electron's
// behaviour. Tests stand in a plain emitter for `app` and the pages' contents.

/** The parts of an Electron event the handlers use. */
interface Prevent {
  preventDefault(): void;
}

/** The app's events the handlers listen to (Electron's `app`, or a test's emitter). */
export interface ChooserApp {
  on(event: 'select-client-certificate', fn: (event: Prevent, wc: unknown, url: string, list: unknown[], callback: (cert?: unknown) => void) => void): unknown;
  on(event: 'login', fn: (event: Prevent, wc: unknown, details: unknown, authInfo: unknown, callback: (username?: string, password?: string) => void) => void): unknown;
  on(event: 'web-contents-created', fn: (event: unknown, wc: ChooserContents) => void): unknown;
}

/** A page's contents, for Web Bluetooth's chooser. */
export interface ChooserContents {
  on(event: 'select-bluetooth-device', fn: (event: Prevent, devices: unknown[], callback: (deviceId: string) => void) => void): unknown;
}

/** Installs the handlers once; `isBrowser` says whether contents are the pane's (a tab or a popup: its session). */
export function installChooserHandlers(app: ChooserApp, isBrowser: (wc: unknown) => boolean): void {
  const ours = (wc: unknown): boolean => {
    try {
      return Boolean(wc) && isBrowser(wc);
    } catch {
      return false;
    }
  };
  app.on('select-client-certificate', (event, wc, _url, _list, callback) => {
    if (!ours(wc)) return;
    event.preventDefault();
    callback();
  });
  app.on('login', (event, wc, _details, _authInfo, callback) => {
    if (!ours(wc)) return;
    event.preventDefault();
    callback();
  });
  app.on('web-contents-created', (_event, wc) => {
    if (!ours(wc)) return;
    wc.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      callback('');
    });
  });
}
