// The provider connection and the welcome screen's setup strip: whether Ollama answers and has the configured
// model, the banner above the composer when it does not, the strip's lines with their fixes ("Start Ollama", "Choose
// folder", …), the working-directory picker and the recent-projects row.

import type { AppConfig, SiloHarnessApi } from '../shared/types';
import { byId } from './dom.js';
import { shortPath } from './home.js';
import { activeProvider, usesOllama } from './provider-view.js';
import { createRecentRow, dirName, recentChoices } from './recent.js';
import { cleanChecks, createSetupStrip, hasModel, isHomeFolder, isLocalOllama, ollamaAddress, ollamaServeCommand, pullCommand, type SetupChecks, type SetupId, type SetupLine } from './setup.js';
import type { createTerminalPane } from './terminal.js';

export interface ConnectionDeps {
  /** The window's config, and where a config read or written here is kept */
  config(): AppConfig;
  setConfig(next: AppConfig): void;
  api: Pick<SiloHarnessApi, 'listOllamaModels' | 'chooseDirectory' | 'getConfig' | 'setConfig'>;
  /** The welcome screen (hidden once the conversation has a node) */
  emptyState: HTMLElement;
  /** The top bar's folder chip: its click opens the picker, and errors about the folder show next to it */
  cwdBtn: HTMLButtonElement;
  /** The model chip: "Choose model" opens its menu */
  modelBtn: HTMLButtonElement;
  /** The Terminal pane, where "Start Ollama" runs `ollama serve` */
  terminalPane(): Pick<ReturnType<typeof createTerminalPane>, 'newTab'>;
  terminalSource(): { write(id: string, data: string): void } | null;
  showPaneTab(tab: 'terminal'): void;
  openSettings(section?: string): void;
  dialogOpen(): boolean;
  focusComposer(): void;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
  /** A quiet notice in the transcript */
  notice(text: string): void;
  /** The config changed here: the top bar, the strip and the recent row follow */
  applyConfigToUi(): void;
  refreshContext(): Promise<void>;
  /** The spinners follow "Starting Ollama…" */
  syncSpin(): void;
}

export function createConnection({ config, setConfig, api, emptyState, cwdBtn, modelBtn, terminalPane, terminalSource, showPaneTab, openSettings, dialogOpen, focusComposer, showError, cleanError, notice, applyConfigToUi, refreshContext, syncSpin }: ConnectionDeps) {
  /** When "Start Ollama" ran `ollama serve` (ms), until Ollama answers or the wait runs out; 0 otherwise */
  let ollamaStartedAt = 0;
  const connBanner = byId('conn-banner');
  const connText = byId('conn-text');
  let lastConnKey = '';
  let connCheck = 0;
  /** What the last finished check found about Ollama (null before the first one, and with Portkey) */
  let ollamaHealth: { reachable: boolean; models: string[] } | null = null;
  /** The banner's text while Ollama is unreachable or the configured model is missing; null when fine */
  let connProblem: string | null = null;

  /**
   * Asks Ollama for its models. Unreachable, or the configured model not downloaded: a banner above the composer
   * (silent otherwise). The same answer drives the setup strip, which takes the banner's place on the welcome screen.
   */
  async function checkConnection(): Promise<void> {
    const my = ++connCheck;
    if (!usesOllama(config())) {
      ollamaHealth = null;
      connProblem = null;
      syncConnection();
      return;
    }
    let models: string[] | null;
    try {
      const list = await api.listOllamaModels();
      models = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      models = null;
    }
    if (my !== connCheck) return;
    const m = activeProvider(config()).model;
    if (models) {
      ollamaHealth = { reachable: true, models };
      connProblem = m && models.length && !hasModel(models, m) ? `Ollama is running, but ${m} is not downloaded. Run: ollama pull ${m}` : null;
    } else {
      ollamaHealth = { reachable: false, models: [] };
      connProblem = `Can't reach Ollama at ${activeProvider(config()).baseURL.replace(/\/v1\/?$/, '')}. Start it with "ollama serve", then retry.`;
    }
    syncConnection();
  }
  byId('conn-retry').onclick = () => void checkConnection();
  byId('conn-settings').onclick = () => openSettings();

  /** How long "Start Ollama" waits for Ollama to answer before the line offers the button again */
  const START_WAIT_MS = 20_000;
  /** The last "Start Ollama" ran out of time without an answer */
  let ollamaStartFailed = false;
  /** The debug hook's checks, shown instead of the real ones */
  let debugSetup: SetupChecks | null = null;
  let setupTimer: number | undefined;

  const setupStrip = createSetupStrip({
    root: byId('setup-strip'),
    onAction: (id, button) => void setupAction(id, button),
  });

  /** Which checks pass: the debug hook's, or the real ones (unknown counts as fine, so nothing flashes before the first answer). */
  function setupChecks(): SetupChecks {
    if (debugSetup) return debugSetup;
    const folder = !isHomeFolder(config().workingDirectory);
    const h = usesOllama(config()) ? ollamaHealth : null;
    return { ollama: !h || h.reachable, model: !h || !h.reachable || hasModel(h.models, activeProvider(config()).model), folder };
  }

  function ollamaLine(): SetupLine {
    const base = activeProvider(config()).baseURL;
    const address = ollamaAddress(base);
    // Ollama on another machine cannot be started from here: the fix is the address.
    if (!isLocalOllama(base)) return { id: 'ollama', icon: 'server', title: "Can't reach Ollama", detail: address, action: 'Open settings', actionTip: 'Check the Ollama address' };
    if (ollamaStartedAt) return { id: 'ollama', icon: 'server', title: 'Starting Ollama…', detail: address, action: 'Starting…', busy: true };
    const command = ollamaServeCommand(base);
    const title = ollamaStartFailed ? "Ollama isn't answering yet" : "Ollama isn't running";
    const detail = ollamaStartFailed ? 'see the Terminal tab' : address;
    // Without the app's terminal the line shows the command to run instead.
    if (!terminalSource()) return { id: 'ollama', icon: 'server', title, detail, action: 'Start Ollama', command, commandNote: 'Run it in a terminal; this line goes away once Ollama answers.' };
    return { id: 'ollama', icon: 'server', title, detail, action: 'Start Ollama', actionTip: `Runs ${command} in a new terminal tab` };
  }

  function modelLine(): SetupLine {
    const model = activeProvider(config()).model.trim();
    const models = ollamaHealth?.reachable ? ollamaHealth.models : [];
    if (!model && models.length) {
      return { id: 'model', icon: 'download', title: 'No model selected', detail: `${models.length} downloaded`, action: 'Choose model', actionTip: 'Pick one of your downloaded models' };
    }
    return {
      id: 'model',
      icon: 'download',
      title: model ? `${model} isn't downloaded` : 'No model downloaded yet',
      action: 'Pull a model',
      command: pullCommand(model),
      commandNote: 'Run it in a terminal; this line goes away once the download is done.',
    };
  }

  /** The strip's lines: Ollama and the model only with the Ollama provider, the folder line with either. */
  function setupLines(): SetupLine[] {
    const checks = setupChecks();
    const lines: SetupLine[] = [];
    const active = activeProvider(config());
    if (active.type === 'ollama') {
      if (!checks.ollama) lines.push(ollamaLine());
      if (!checks.model) lines.push(modelLine());
    } else if (active.error && !debugSetup) {
      // Any other provider: what stands in the way (no key, no model), with Settings at hand
      lines.push({ id: 'provider', icon: active.key === 'missing' ? 'plug' : 'settings', title: active.key === 'missing' ? `${active.label} needs a key` : `No model set for ${active.label}`, detail: active.key === 'missing' ? active.keySource : undefined, action: 'Open settings', actionTip: active.error });
    }
    if (!checks.folder) lines.push({ id: 'folder', icon: 'folder', title: 'Working in your home folder', action: 'Choose folder', actionTip: 'Choose the project folder Silo Harness works in' });
    return lines;
  }

  /** After a check, a config() change, the welcome screen showing or hiding, or the debug hook: the strip, the banner, the next check. */
  function syncConnection(): void {
    if (!config()) return;
    if (ollamaStartedAt) {
      const answered = !usesOllama(config()) || ollamaHealth?.reachable === true;
      if (answered || Date.now() - ollamaStartedAt > START_WAIT_MS) {
        ollamaStartFailed = !answered;
        ollamaStartedAt = 0;
        syncSpin();
      }
    }
    if (ollamaHealth?.reachable) ollamaStartFailed = false;
    setupStrip.render(setupLines());
    // On the welcome screen the strip says it with a fix at hand; the banner returns once the conversation starts.
    const covered = !emptyState.hidden && setupStrip.lines().some((id) => id !== 'folder');
    connText.textContent = connProblem ?? '';
    connBanner.hidden = !connProblem || covered;
    scheduleSetupCheck();
  }

  /** While the welcome screen shows an Ollama line, Ollama is asked again (every 5s, every second while it starts), so the line goes once fixed. */
  function scheduleSetupCheck(): void {
    window.clearTimeout(setupTimer);
    setupTimer = undefined;
    const watching = !debugSetup && usesOllama(config()) && !emptyState.hidden && setupStrip.lines().some((id) => id !== 'folder');
    if (!watching && !ollamaStartedAt) return;
    setupTimer = window.setTimeout(
      () => {
        setupTimer = undefined;
        if (ollamaStartedAt || document.visibilityState === 'visible') void checkConnection();
        else scheduleSetupCheck();
      },
      ollamaStartedAt ? 1000 : 5000,
    );
  }
  // The welcome screen shows or hides (addNode sets hidden on every new node, so only real changes count).
  let welcomeShown = !emptyState.hidden;
  new MutationObserver(() => {
    if (welcomeShown === !emptyState.hidden) return;
    welcomeShown = !emptyState.hidden;
    syncConnection();
  }).observe(emptyState, { attributes: true, attributeFilter: ['hidden'] });
  // Back from a terminal where Ollama was started or a model pulled: check right away.
  window.addEventListener('focus', () => {
    if (!config() || debugSetup || !usesOllama(config()) || emptyState.hidden) return;
    if (setupStrip.lines().some((id) => id !== 'folder')) void checkConnection();
  });

  async function setupAction(id: SetupId, button: HTMLButtonElement): Promise<void> {
    if (id === 'folder') {
      if ((await chooseFolder()) && !dialogOpen()) focusComposer();
    } else if (id === 'model') {
      // "Choose model" (a pull shows its command instead): the model chip's menu
      modelBtn.click();
    } else if (id === 'provider') openSettings('provider');
    else if (!isLocalOllama(activeProvider(config()).baseURL)) openSettings(config().provider === 'ollama' ? 'ollama-baseURL' : 'provider');
    else await startOllama(button);
  }

  /** "Start Ollama": `ollama serve` in a new terminal tab (the Terminal pane comes forward), then Ollama is asked every second until it answers. */
  async function startOllama(button: HTMLButtonElement): Promise<void> {
    const term = terminalSource();
    if (!term || ollamaStartedAt) return;
    const command = ollamaServeCommand(activeProvider(config()).baseURL);
    showPaneTab('terminal');
    const id = await terminalPane().newTab();
    if (!id) {
      showError(button, `Couldn't open a terminal. Run ${command} yourself, then come back.`);
      return;
    }
    try {
      term.write(id, `${command}\r`);
    } catch (err) {
      showError(button, `Couldn't start Ollama: ${cleanError(err)}`);
      return;
    }
    ollamaStartedAt = Date.now();
    ollamaStartFailed = false;
    syncSpin();
    syncConnection();
  }

  /**
   * After the working directory changed (the picker, a recent project): the top bar, the setup strip and the recent
   * row follow. In an empty session they show the change; a notice would replace the welcome screen.
   */
  function folderChanged(dir: string): void {
    applyConfigToUi();
    if (emptyState.hidden) notice(`Working directory set to ${dir}`);
  }

  /** The working-directory picker (the top bar's folder and the setup strip's "Choose folder"). */
  async function chooseFolder(): Promise<boolean> {
    let dir: string | null;
    try {
      dir = await api.chooseDirectory();
    } catch (err) {
      showError(cwdBtn, `Couldn't change the folder: ${cleanError(err)}`);
      return false;
    }
    if (!dir) return false;
    setConfig(await api.getConfig());
    folderChanged(dir);
    return true;
  }
  cwdBtn.onclick = () => void chooseFolder();

  // ---------- Recent projects: the welcome screen's row of folders used before (AppConfig.recentDirs) ----------

  /** The debug hook's folders, shown instead of config().recentDirs */
  let debugRecent: string[] | null = null;

  const recentRow = createRecentRow({ root: byId('recent-dirs'), onPick: (dir, chip) => switchFolder(dir, chip) });

  /** The row: config().recentDirs (or the debug hook's folders) without the current working directory; hidden when empty. */
  function renderRecent(): void {
    if (!config()) return;
    recentRow.render(recentChoices(debugRecent ?? config().recentDirs, config().workingDirectory));
  }

  /**
   * A recent project's chip: the working directory switches to it the way the picker does (setConfig, then the same
   * refresh; no notice in an empty session). The main process puts the folder it switched to first in recentDirs and
   * drops folders that no longer exist, so when it is not first the folder is gone: the previous one comes back.
   */
  async function switchFolder(dir: string, chip: HTMLButtonElement): Promise<void> {
    const prev = config().workingDirectory;
    if (dir === prev) return;
    let next: AppConfig;
    try {
      next = await api.setConfig({ ...config(), workingDirectory: dir });
    } catch (err) {
      showError(chip, `Couldn't switch to ${dirName(dir)}: ${cleanError(err)}`);
      return;
    }
    if (Array.isArray(next?.recentDirs) && next.recentDirs[0] !== dir) {
      showError(chip, `Can't find ${shortPath(dir)}. It may have been moved or deleted.`);
      try {
        next = await api.setConfig({ ...next, workingDirectory: prev });
      } catch {
        /* the top bar shows where the agent works now */
      }
      setConfig(next);
      applyConfigToUi();
      return;
    }
    setConfig(next);
    folderChanged(dir);
    // The picker's change reaches the context meter through a context event; this one asks
    void refreshContext();
    // The chip is gone (it is the working directory now): on to the first message, as after "Choose folder"
    if (!dialogOpen()) focusComposer();
  }

  /** After applyConfigToUi: a changed provider, address or model is checked again; the strip and the banner follow the config either way. */
  function configApplied(): void {
    const cfg = config();
    const active = activeProvider(cfg);
    const connKey = `${cfg.provider}|${active.baseURL}|${active.model}|${active.error ?? ''}`;
    if (connKey !== lastConnKey) {
      lastConnKey = connKey;
      void checkConnection();
    }
    // The folder line follows the working directory; the provider decides which lines can show at all.
    syncConnection();
  }

  return {
    checkConnection,
    configApplied,
    renderRecent,
    chooseFolder,
    /** "Start Ollama" ran and Ollama has not answered yet */
    startingOllama: () => ollamaStartedAt > 0,
    /** The debug hook: the strip from these checks instead of the real ones (null: the real ones again) */
    mockSetup: (checks: Partial<SetupChecks> | null) => {
      debugSetup = checks && typeof checks === 'object' ? cleanChecks(checks) : null;
      syncConnection();
      // Back to the real checks: ask Ollama again now
      if (!debugSetup && config()) void checkConnection();
    },
    /** The debug hook: the recent row from these folders instead of config.recentDirs (null: the config's again) */
    mockRecent: (dirs: string[] | null) => {
      debugRecent = Array.isArray(dirs) ? dirs.slice() : null;
      renderRecent();
    },
  };
}
