// The main process entry: build the App, register the core IPC, run the feature setups, open the window.
// Features never edit this file; they get `app` in their setup function (see docs/architecture.md).
// First: carry over the folders of the app's older names, before any other module reads them.
import './carry-over';
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, net, Notification, protocol, webContents } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { AgentEvent, McpServerInfo } from '../shared/types';
import { McpManager, PROJECT_FILE } from './mcp';
import { ARTIFACT_SCHEME, ArtifactStore } from './artifacts';
import { loadConfig, saveConfig } from './config';
import { BrowserController, browserSession, openChatLink, setupBrowser, zoomMenuItems } from './browser';
import { TerminalManager } from './terminal';
import { createApp, type AppHost } from './app';
import { registerCoreIpc } from './ipc';
import { setupSettings } from './settings-service';
import { setupChatCards } from './chat-cards';
import { setupHooks } from './hooks';
import { setupHistory } from './history';
import { setupContext } from './context-service';
import { setupImages } from './images';
import { MOD_SCHEME, MOD_SCHEME_PRIVILEGES, setupMods } from './mods';
import { setupSchedules } from './schedules';
import { setupSubagents } from './subagents';
import { setupRemote } from './remote';
import { setupPower } from './power';
import { setupDreaming } from './dreaming';
import { setupProviders } from './providers-service';

let host: AppHost | null = null;
let win: BrowserWindow | null = null;
let browser: BrowserController | null = null;
/** Blocked project MCP servers the user was told about, as "<cwd>:<name>" */
const notifiedBlocked = new Set<string>();

const APP_NAME = 'Silo Harness';
// Packaged builds keep build/icon.png outside the asar (see asarUnpack) so native APIs can read it.
const ICON_PATH = path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'build', 'icon.png');

/** Brand the process: Dock icon, menu-bar name and About panel (packaged builds get these from Info.plist). */
function applyBranding(): void {
  app.setName(APP_NAME);
  const icon = nativeImage.createFromPath(ICON_PATH);
  if (process.platform === 'darwin' && !icon.isEmpty()) app.dock?.setIcon(icon);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    iconPath: ICON_PATH,
    credits: 'Open-source agentic coding assistant with a built-in browser. Runs on Ollama or Portkey.',
  });
}

/** Whether the window's chrome is dark: the theme setting, or the system's when it follows that. */
function darkChrome(): boolean {
  const theme = host?.config().theme;
  return theme === 'dark' || (theme !== 'light' && nativeTheme.shouldUseDarkColors);
}

/** Window chrome colour before the renderer paints; matches the renderer's --bg tokens so launch does not flash. */
function windowBackground(): string {
  return darkChrome() ? '#262624' : '#faf9f5';
}

/**
 * Live tests (test/live) drive the real app over the DevTools protocol. With SILO_HARNESS_LIVE_TEST set the window is
 * never shown and the app keeps out of the Dock, so a test run does not take over the screen; it still lays out and
 * paints, which is what screenshots need.
 */
const LIVE_TEST = Boolean(process.env.SILO_HARNESS_LIVE_TEST);

function createWindow(): void {
  const icon = nativeImage.createFromPath(ICON_PATH);
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 15 },
    backgroundColor: windowBackground(),
    icon,
    show: !LIVE_TEST,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !LIVE_TEST,
    },
  });
  // A link in the chat: the default browser, or a tab of the pane when Settings → Browser says so (browser/feature.ts)
  win.webContents.setWindowOpenHandler(({ url }) => {
    openChatLink(host!, browser, url);
    return { action: 'deny' };
  });
  win.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event as unknown as { level: string; message: string; lineNumber: number; sourceId: string };
    if (level === 'error' || level === 'warning' || process.argv.includes('--dev')) console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const w = win;
  const a = host!;
  a.setWindow(w);
  browser = new BrowserController(w, {
    onState: (state) => {
      if (!w.isDestroyed()) w.webContents.send('browser:state', state);
    },
    onPopups: (popups) => a.push('browser:popups', popups),
    onFocusUrl: () => a.push('browser:focus-url', null),
    onFindOpen: () => a.push('browser:find-open', null),
    onFound: (result) => a.push('browser:found', result),
    dark: darkChrome,
  });
  const servers = a.mcp;
  const term = a.terminal!;
  const onServers = (list: McpServerInfo[]) => {
    if (w.isDestroyed()) return;
    w.webContents.send('mcp:servers', list);
    // Project servers never run until the user enables them: say so once per server.
    const cwd = a.config().workingDirectory;
    const fresh = list.filter((s) => s.status === 'blocked' && !notifiedBlocked.has(`${cwd}:${s.name}`));
    if (!fresh.length || w.webContents.isLoading()) return;
    for (const s of fresh) notifiedBlocked.add(`${cwd}:${s.name}`);
    const names = fresh.map((s) => s.name).join(', ');
    const ev: AgentEvent = { type: 'error', kind: 'notice', message: `This project's ${PROJECT_FILE} adds ${fresh.length === 1 ? 'an MCP server' : 'MCP servers'}, off until you enable ${fresh.length === 1 ? 'it' : 'them'} in Settings → MCP servers: ${names}.` };
    w.webContents.send('agent:event', ev, a.runtime.foregroundId());
  };
  servers?.on('servers', onServers);
  if (servers) w.webContents.once('did-finish-load', () => onServers(servers.list()));
  const onTermData = (id: string, data: string) => {
    if (!w.isDestroyed()) w.webContents.send('terminal:data', id, data);
  };
  const onTermTabs = (tabs: unknown) => {
    if (!w.isDestroyed()) w.webContents.send('terminal:tabs', tabs);
  };
  term.on('data', onTermData);
  term.on('tabs', onTermTabs);
  w.on('closed', () => {
    term.off('data', onTermData);
    term.off('tabs', onTermTabs);
    servers?.off('servers', onServers);
    a.runtime.stopAll();
    a.setWindow(null);
    win = null;
    browser = null;
  });
}

/** The Dock badge: how many sessions wait for the user (an approval card, a question card or a proposed plan). */
function updateBadge(a: AppHost): void {
  if (process.platform !== 'darwin') return;
  const waiting = a.runtime.list().filter((m) => m.status?.attention).length;
  app.dock?.setBadge(waiting ? String(waiting) : '');
}

/**
 * A macOS notification (and a Dock bounce) when a run ends or waits for approval while the window is in the
 * background or the session is not the one on screen. Clicking it brings that session to the front.
 */
function notify(a: AppHost, sessionId: string, ev: AgentEvent): void {
  const w = a.window();
  if (!w || !a.config().notifications || !Notification.isSupported()) return;
  // A dream says for itself when it has something for the user (dreaming.ts), not every time it ends
  if (a.store.get(sessionId)?.origin === 'dream') return;
  const onScreen = sessionId === a.runtime.foregroundId();
  if (w.isFocused() && onScreen) return;
  const name = a.store.get(sessionId)?.title || 'New session';
  let title: string;
  let body: string;
  if (ev.type === 'run_end') {
    if (ev.reason === 'aborted') return;
    title = ev.reason === 'error' ? `${APP_NAME} hit an error` : ev.reason === 'plan' ? `${APP_NAME} has a plan for you` : ev.reason === 'max_turns' ? `${APP_NAME} stopped at the turn limit` : `${APP_NAME} finished`;
    body = name;
  } else if (ev.type === 'approval_request') {
    title = `${APP_NAME} needs your approval`;
    body = `${name}: ${ev.detail.split('\n')[0].slice(0, 120)}`;
  } else if (ev.type === 'question_request') {
    title = `${APP_NAME} has a question for you`;
    body = `${name}: ${(ev.questions[0]?.question ?? '').slice(0, 120)}`;
  } else return;
  try {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => {
      const cur = a.window();
      if (!cur) return;
      cur.show();
      cur.focus();
      if (a.store.get(sessionId) && sessionId !== a.runtime.foregroundId()) a.push('sessions:show', sessionId);
    });
    n.show();
    app.dock?.bounce('informational');
  } catch (err) {
    console.warn('[notify] failed:', err);
  }
}

/** The core: config, sessions, runtime, terminal, artifacts and MCP servers, all reached through the App. */
function buildApp(): AppHost {
  const userData = app.getPath('userData');
  const a = createApp({
    userData,
    appRoot: app.getAppPath(),
    loadConfig,
    saveConfig,
    browser: () => browser,
    terminal: new TerminalManager({ dataDir: userData, cwd: () => host?.config().workingDirectory ?? userData }),
    artifacts: new ArtifactStore({ root: path.join(userData, 'artifacts'), rendererDir: path.join(__dirname, '..', 'renderer') }),
    mcp: (self) =>
      new McpManager({
        getConfig: () => self.config(),
        saveConfig: (patch) => void self.updateConfig(patch),
        cwd: () => self.config().workingDirectory,
        version: app.getVersion(),
      }),
  });
  a.events.on((sessionId, ev) => notify(a, sessionId, ev));
  a.runtime.onStatus(() => updateBadge(a));
  void a.mcp?.reload().catch((err: unknown) => console.warn('[mcp] reload failed:', err));
  return a;
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      // The View menu's own items, but zoom of our own: a role zooms whichever page has the focus, the Browser pane's
      // included, with steps of its own and nothing kept. A page of the browser zooms as ⌘+ in it does (per site);
      // the app's window zooms as before.
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          ...zoomMenuItems((wc, change) => browser?.zoomContents(wc, change) ?? false, () => webContents.getFocusedWebContents() ?? win?.webContents ?? null),
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

app.setName(APP_NAME);
// Artifacts are served on their own scheme so the viewer can load the app's modules like a normal page.
// Mod pages get a scheme of their own, one origin per mod (see mods/serve.ts). Both must be registered here, before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: MOD_SCHEME, privileges: MOD_SCHEME_PRIVILEGES },
]);

app.whenReady().then(() => {
  if (LIVE_TEST) app.dock?.hide();
  applyBranding();
  host = buildApp();
  const a = host;
  const serveArtifact = async (req: Request): Promise<Response> => {
    const r = a.artifacts?.resolve(req.url);
    if (!r) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (r.kind === 'page') return new Response(r.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return net.fetch(pathToFileURL(r.path).href);
  };
  protocol.handle(ARTIFACT_SCHEME, serveArtifact);
  // The Browser pane has a session of its own (persist:browser): artifacts must be served there too.
  browserSession().protocol.handle(ARTIFACT_SCHEME, serveArtifact);
  buildMenu();
  registerCoreIpc(a, { browser: () => browser });
  // The features, in this order. Each keeps its code in its own file and never needs to edit this one.
  setupSettings(a);
  setupHooks(a);
  setupHistory(a);
  setupContext(a);
  setupImages(a);
  setupMods(a);
  setupSchedules(a);
  setupSubagents(a);
  setupRemote(a);
  setupPower(a);
  setupDreaming(a);
  setupProviders(a);
  setupBrowser(a, () => browser);
  setupChatCards(a, () => browser);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

/** Quit: stop every run, run the features' quit handlers (last registered first), then close terminals and MCP servers. */
let quitting = false;
app.on('before-quit', (e) => {
  const a = host;
  if (!a || quitting) return;
  quitting = true;
  e.preventDefault();
  a.runtime.stopAll();
  void a.runQuit().finally(() => {
    a.terminal?.closeAll();
    void a.mcp?.close();
    app.quit();
  });
});
