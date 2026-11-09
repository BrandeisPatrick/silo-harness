// The chips around the composer and under it: the permission mode and its menu, the model and its menu (with the
// other providers that could be used as they are), the folder chip's label, and applyConfigToUi, which makes the
// window follow the config whenever it changed (a Settings save, a chip, the main process).

import type { AppConfig, PermissionMode, SiloHarnessApi } from '../shared/types';
import { bus } from './bus.js';
import { setDiffBaseDir } from './diff.js';
import { byId, escapeHtml } from './dom.js';
import { shortPath } from './home.js';
import { MODE_CHIP_CLASSES, MODE_CYCLE, MODES, modeOf, nextMode } from './modes.js';
import { closeMenu, menuAnchoredTo, openMenu, type MenuItem, type MenuSection } from './popover.js';
import { activeProvider, allProviders } from './provider-view.js';
import { onPush, rpc } from './rpc.js';
import { setToolCwd } from './tools.js';

export interface HeaderDeps {
  modeBtn: HTMLButtonElement;
  modelBtn: HTMLButtonElement;
  cwdBtn: HTMLButtonElement;
  /** The menus stay inside this element */
  boundary: HTMLElement;
  api: Pick<SiloHarnessApi, 'setConfig' | 'getConfig' | 'listOllamaModels'>;
  /** The window's config, and where a config read or written here is kept */
  config(): AppConfig;
  setConfig(next: AppConfig): void;
  /** Leaving plan mode: the "keep planning" placeholder goes back to the default */
  leavePlanPlaceholder(): void;
  /** The mode became Bypass: a waiting approval card goes through */
  allowPendingApproval(): void;
  /** The parts of the window that follow the config (connection.ts, tool-groups.ts, the composer's vision note) */
  renderRecent(): void;
  connectionChanged(): void;
  summaryMode(): boolean;
  refoldAll(): void;
  refreshVisionNote(): Promise<void>;
  refreshChanges(): Promise<unknown>;
  refreshContext(): Promise<void>;
  openSettings(section?: string): void;
  focusComposer(): void;
  notice(text: string, kind: 'notice'): void;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
}

export function createHeader({ modeBtn, modelBtn, cwdBtn, boundary: transcriptWrap, api, config, setConfig, leavePlanPlaceholder, allowPendingApproval, renderRecent, connectionChanged, summaryMode, refoldAll, refreshVisionNote, refreshChanges, refreshContext, openSettings, focusComposer, notice, showError, cleanError }: HeaderDeps) {
  const cwdLabel = byId('cwd-label');

  function currentMode(): PermissionMode {
    return modeOf(config());
  }

  /** Posts the "Permission mode: …" notice when the mode differs from `before`. */
  function announceMode(before: PermissionMode): void {
    const now = currentMode();
    if (now === before) return;
    if (now !== 'plan') leavePlanPlaceholder();
    notice(`Permission mode: ${MODES[now].label}. ${MODES[now].desc}.`, 'notice');
  }

  async function setMode(mode: PermissionMode): Promise<void> {
    const before = currentMode();
    try {
      setConfig(await api.setConfig({ ...config(), permissionMode: mode, autoApprove: mode === 'bypass' }));
    } catch (err) {
      showError(modeBtn, `Couldn't change the mode: ${cleanError(err)}`);
      return;
    }
    applyConfigToUi();
    if (currentMode() !== mode) showError(modeBtn, `${MODES[mode].label} needs the updated app. Restart Silo Harness.`);
    if (currentMode() === 'bypass') allowPendingApproval();
    announceMode(before);
  }

  async function toggleMode(): Promise<void> {
    await setMode(nextMode(currentMode()));
  }

  modeBtn.onclick = () => {
    if (menuAnchoredTo(modeBtn)) return closeMenu();
    const mode = currentMode();
    const item = (m: PermissionMode): MenuItem => {
      const info = MODES[m];
      return {
        label: info.label,
        description: info.desc,
        icon: info.icon,
        // Neutral icons, as Claude Code's menus; Bypass keeps its red words
        danger: m === 'bypass',
        checked: m === mode,
        onSelect: () => {
          focusComposer();
          if (m !== currentMode()) void setMode(m);
        },
      };
    };
    openMenu([{ label: 'Permission mode', items: MODE_CYCLE.map(item) }, { items: [item('bypass')] }], {
      anchor: modeBtn,
      placement: 'top-start',
      boundary: transcriptWrap,
      minWidth: 300,
      className: 'mode-menu',
      footer: '<kbd>⇧</kbd><kbd>Tab</kbd><span>cycles every mode except Bypass</span>',
    });
  };

  async function setModel(model: string, name = activeProvider(config()).name): Promise<void> {
    try {
      await rpc('providers.setModel', name, model);
      setConfig(await api.getConfig());
    } catch (err) {
      // An older main process (no such method): only the Ollama block's model could be chosen here
      if (!/No handler registered|Unknown (?:RPC )?method/i.test(String((err as Error)?.message ?? err))) {
        showError(modelBtn, `Couldn't choose ${model}: ${cleanError(err)}`);
        return;
      }
      setConfig(await api.setConfig({ ...config(), ollama: { ...config().ollama, model } }));
    }
    applyConfigToUi();
    focusComposer();
    void refreshContext();
  }

  /** Makes another provider the one in use (from the model menu). */
  async function useProvider(name: string): Promise<void> {
    setConfig(await api.setConfig({ ...config(), provider: name }));
    applyConfigToUi();
    focusComposer();
    void refreshContext();
  }

  modelBtn.onclick = async () => {
    if (menuAnchoredTo(modelBtn)) return closeMenu();
    const settingsItem: MenuItem = { label: 'Settings…', icon: 'settings', hint: '⌘,', onSelect: () => openSettings('provider') };
    const opts = { anchor: modelBtn, placement: 'top-start' as const, boundary: transcriptWrap, minWidth: 260 };
    const active = activeProvider(config());
    const current = active.model;
    // The other providers that could be used as they are
    const others = allProviders(config()).filter((p) => p.name !== active.name && !p.error);
    const switchSection = (): MenuSection[] => (others.length ? [{ label: 'Provider', items: others.map((p) => ({ label: p.label, hint: p.model, onSelect: () => void useProvider(p.name) })) }] : []);
    const section = (models: string[], note?: string): MenuSection => ({
      label: active.label,
      items: models.map((m) => ({ label: m, checked: m === current, onSelect: () => void (m === current ? focusComposer() : setModel(m, active.name)) })),
      note,
    });
    const sections = (models: string[], note?: string) => [section(models, note), ...switchSection(), { items: [settingsItem] }];
    const own = [...new Set([...(current ? [current] : []), ...active.models])];
    const menu = openMenu(sections(own, active.type === 'ollama' ? 'Loading models…' : active.models.length ? undefined : 'Loading models…'), opts);
    try {
      const models = active.type === 'ollama' ? await api.listOllamaModels() : await rpc('providers.models', active.name);
      if (!menuAnchoredTo(modelBtn)) return;
      const list = [...new Set([...(current ? [current] : []), ...models])];
      const none = active.type === 'ollama' ? 'No local models. Try: ollama pull qwen3:8b' : 'The service listed no models.';
      menu.update(sections(list, models.length ? undefined : none));
    } catch {
      if (!menuAnchoredTo(modelBtn)) return;
      const note = active.type === 'ollama' ? 'Could not reach Ollama. Start it with: ollama serve' : active.error ?? (own.length ? undefined : 'This service lists no models. Set one in Settings.');
      menu.update(sections(own, note));
    }
  };

  // ---------- The window follows the config() ----------

  let lastToolActivity: boolean | undefined;

  function applyConfigToUi(): void {
    const active = activeProvider(config());
    const model = active.model;
    // Under the chat bar: the model in the text colour, then a muted word when there is one worth saying
    const sub = config().provider === 'ollama' && config().ollama.think === 'on' ? 'Thinking' : '';
    modelBtn.innerHTML = `<span class="foot-label">${escapeHtml(model || 'Choose a model')}</span>${sub ? `<span class="foot-sub">${sub}</span>` : ''}`;
    modelBtn.dataset.tip = `${active.label} · ${active.baseURL}`;
    modelBtn.dataset.provider = active.name;
    const mode = currentMode();
    const info = MODES[mode];
    modeBtn.innerHTML = `<span class="foot-label">${escapeHtml(info.short)}</span>`;
    modeBtn.dataset.tip = `${info.label}: ${info.desc}`;
    modeBtn.dataset.mode = mode;
    modeBtn.setAttribute('aria-label', `Permission mode: ${info.label}`);
    for (const c of MODE_CHIP_CLASSES) modeBtn.classList.toggle(c, c === info.chipClass);
    cwdLabel.textContent = shortPath(config().workingDirectory);
    cwdBtn.dataset.tip = `${config().workingDirectory} · click to change`;
    setToolCwd(config().workingDirectory);
    setDiffBaseDir(config().workingDirectory);
    renderRecent();
    document.documentElement.dataset.theme = config().theme === 'system' ? '' : config().theme;
    // Tool activity: Summary or Every call; the conversation on screen folds again when it changes
    if (lastToolActivity !== undefined && lastToolActivity !== summaryMode()) refoldAll();
    lastToolActivity = summaryMode();
    // A provider change asks Ollama again; the strip and the banner follow the config() either way
    connectionChanged();
    void refreshVisionNote();
    bus.emit('config', config());
  }

  /**
   * The main process changed the config() (another feature, a folder that followed a session, an approval that switched
   * the mode): the window follows the way a Settings save does.
   */
  onPush('config:changed', (next) => {
    if (!next || typeof next !== 'object') return;
    const prev = config();
    setConfig(next);
    applyConfigToUi();
    if (prev && prev.workingDirectory !== next.workingDirectory) void refreshChanges();
    void refreshContext();
  });

  return { currentMode, announceMode, setMode, toggleMode, applyConfigToUi };
}
