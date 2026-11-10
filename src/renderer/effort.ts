// The effort pill under the chat bar, right after the model: the reasoning effort of the provider in use and its
// menu of the levels the model takes. Hidden where the model or the service takes no effort setting. The main process
// works out the levels (agent/effort.ts) and sends them with the provider (ProviderView.effort); a choice is stored on
// the provider entry (providers.setEffort) and applies from the next model request.

import type { AppConfig, EffortLevel, SiloHarnessApi } from '../shared/types';
import { bus } from './bus.js';
import { escapeHtml } from './dom.js';
import { closeMenu, menuAnchoredTo, openMenu, type MenuItem } from './popover.js';
import { activeProvider } from './provider-view.js';
import { rpc } from './rpc.js';

export const EFFORT_LABELS: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export interface EffortPillDeps {
  btn: HTMLButtonElement;
  /** The menu stays inside this element */
  boundary: HTMLElement;
  api: Pick<SiloHarnessApi, 'getConfig'>;
  config(): AppConfig;
  setConfig(next: AppConfig): void;
  focusComposer(): void;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
}

export function createEffortPill({ btn, boundary, api, config, setConfig, focusComposer, showError, cleanError }: EffortPillDeps) {
  function render(cfg: AppConfig = config()): void {
    // Before the window has its config: nothing to show yet
    const info = cfg ? activeProvider(cfg).effort : undefined;
    btn.hidden = !info;
    if (!info) {
      if (menuAnchoredTo(btn)) closeMenu();
      return;
    }
    const level = info.chosen ?? info.default;
    const text = level ? EFFORT_LABELS[level] : 'Default';
    btn.innerHTML = `<span class="foot-label">${escapeHtml(text)}</span>`;
    btn.setAttribute('aria-label', `Effort: ${text}`);
  }

  async function choose(level: EffortLevel | null): Promise<void> {
    const name = activeProvider(config()).name;
    try {
      await rpc('providers.setEffort', name, level);
      setConfig(await api.getConfig());
    } catch (err) {
      showError(btn, `Couldn't change the effort: ${cleanError(err)}`);
      return;
    }
    render();
    focusComposer();
  }

  btn.onclick = () => {
    if (menuAnchoredTo(btn)) return closeMenu();
    const info = activeProvider(config()).effort;
    if (!info) return;
    const current = info.chosen ?? info.default;
    const pick = (level: EffortLevel | null) => () => void (level === info.chosen ? focusComposer() : choose(level));
    const items: MenuItem[] = [];
    // Where the model's default is unknown (OpenAI-compatible services), "Default" sends nothing
    if (!info.default) items.push({ label: 'Default', checked: current === null, onSelect: pick(null) });
    for (const l of info.levels) items.push({ label: EFFORT_LABELS[l], checked: l === current, ...(l === info.default ? { hint: 'default' } : {}), onSelect: pick(l) });
    openMenu([{ label: 'Effort', items }], { anchor: btn, placement: 'top-start', boundary, minWidth: 180 });
  };

  bus.on('config', (cfg) => render(cfg));
  render();
  return { render };
}
