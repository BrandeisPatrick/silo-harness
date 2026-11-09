// The welcome screen's setup strip (#setup-strip, above the folder row): what still stands between a fresh install
// and a first run, one line each with its fix. Ollama not answering ("Start Ollama"), the configured model not
// downloaded ("Pull a model" shows the command with a Copy button), another provider without its key or model
// ("Open settings"). Lines are keyed by id and updated in place, so an open command, a focused button or a running
// "Starting…" survive the re-checks. The app decides which lines show (see SetupLine); this module draws them.

import { copyWithFeedback } from './dom.js';
import { icon, type IconName } from './icons.js';

export type SetupId = 'ollama' | 'model' | 'provider';

/** Which checks pass (true = fine): Ollama answers, the configured model is downloaded. */
export interface SetupChecks {
  ollama: boolean;
  model: boolean;
}

/** A partial or malformed object from the debug hook: anything not false counts as fine. */
export function cleanChecks(v: unknown): SetupChecks {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof SetupChecks, unknown>>;
  return { ollama: o.ollama !== false, model: o.model !== false };
}

export interface SetupLine {
  id: SetupId;
  icon: IconName;
  title: string;
  /** Muted text after the title (an address, a count) */
  detail?: string;
  /** The button's label */
  action: string;
  /** The button's tooltip (what it will do) */
  actionTip?: string;
  /** The action is under way: the button shows the spinner and does nothing */
  busy?: boolean;
  /** With a command the button shows or hides it under the line, with a Copy button, instead of calling onAction */
  command?: string;
  /** One muted line under the command */
  commandNote?: string;
}

export interface SetupStripOptions {
  /** #setup-strip */
  root: HTMLElement;
  /** A line's button was clicked (lines without a command) */
  onAction: (id: SetupId, button: HTMLButtonElement) => void;
}

export interface SetupStrip {
  /** Shows these lines in this order (none hides the strip) */
  render(lines: SetupLine[]): void;
  /** The ids of the lines on screen, in order */
  lines(): SetupId[];
}

// ---------- What the checks compare ----------

/** Ollama lists "llama3.1:latest" for a model configured as "llama3.1" (and the other way round). */
export function hasModel(models: string[], model: string): boolean {
  const m = String(model ?? '').trim();
  if (!m) return false;
  return models.some((x) => x === m || x === `${m}:latest` || m === `${x}:latest`);
}

function parseUrl(baseURL: string): URL | null {
  try {
    return new URL(String(baseURL ?? '').trim());
  } catch {
    return null;
  }
}

/** "localhost:11434" for "http://localhost:11434/v1" */
export function ollamaAddress(baseURL: string): string {
  const u = parseUrl(baseURL);
  if (u?.host) return u.host;
  return String(baseURL ?? '').replace(/^[a-z]+:\/\//i, '').replace(/\/v1\/?$/, '').replace(/\/+$/, '') || 'localhost:11434';
}

/** True when Ollama is expected on this Mac, where "Start Ollama" can start it. */
export function isLocalOllama(baseURL: string): boolean {
  const u = parseUrl(baseURL);
  if (!u) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
}

/** "ollama serve", told to listen on the configured port when that is not Ollama's default 11434. */
export function ollamaServeCommand(baseURL: string): string {
  const u = parseUrl(baseURL);
  const port = u ? u.port || (u.protocol === 'https:' ? '443' : '80') : '11434';
  return port === '11434' ? 'ollama serve' : `OLLAMA_HOST=127.0.0.1:${port} ollama serve`;
}

/** The model a fresh install is configured with, pulled when none is set */
export const DEFAULT_MODEL = 'qwen3:8b';

export function pullCommand(model: string): string {
  return `ollama pull ${String(model ?? '').trim() || DEFAULT_MODEL}`;
}

// ---------- The strip ----------

export function createSetupStrip(o: SetupStripOptions): SetupStrip {
  const root = o.root;
  const rows = new Map<SetupId, HTMLElement>();
  /** Lines whose command is shown */
  const open = new Set<SetupId>();
  let current: SetupLine[] = [];

  const lineOf = (id: SetupId) => current.find((l) => l.id === id);

  const fill = (row: HTMLElement, line: SetupLine) => {
    if (row.dataset.icon !== line.icon) {
      row.dataset.icon = line.icon;
      row.querySelector('.setup-icon')!.innerHTML = icon(line.icon, 16);
    }
    const title = row.querySelector<HTMLElement>('.setup-title')!;
    if (title.textContent !== line.title) title.textContent = line.title;
    const detail = row.querySelector<HTMLElement>('.setup-detail')!;
    detail.textContent = line.detail ?? '';
    detail.hidden = !line.detail;
    const btn = row.querySelector<HTMLButtonElement>('.setup-action')!;
    const label = btn.querySelector<HTMLElement>('.setup-action-label')!;
    if (label.textContent !== line.action) label.textContent = line.action;
    btn.classList.toggle('busy', Boolean(line.busy));
    btn.setAttribute('aria-disabled', String(Boolean(line.busy)));
    if (line.actionTip && !line.busy) btn.dataset.tip = line.actionTip;
    else delete btn.dataset.tip;
    const cmd = row.querySelector<HTMLElement>('.setup-cmd')!;
    if (!line.command) open.delete(line.id);
    const shown = Boolean(line.command) && open.has(line.id);
    if (line.command) {
      btn.setAttribute('aria-expanded', String(shown));
      btn.setAttribute('aria-controls', cmd.id);
    } else {
      btn.removeAttribute('aria-expanded');
      btn.removeAttribute('aria-controls');
    }
    cmd.hidden = !shown;
    row.classList.toggle('open', shown);
    const code = cmd.querySelector<HTMLElement>('code')!;
    if (code.textContent !== (line.command ?? '')) code.textContent = line.command ?? '';
    const note = cmd.querySelector<HTMLElement>('.setup-note')!;
    note.textContent = line.commandNote ?? '';
    note.hidden = !line.commandNote;
  };

  const create = (id: SetupId): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'setup-item';
    row.dataset.id = id;
    row.setAttribute('role', 'listitem');
    const cmdId = `setup-cmd-${id}`;
    row.innerHTML =
      `<div class="setup-line">` +
      `<span class="setup-icon" aria-hidden="true"></span>` +
      `<span class="setup-text"><span class="setup-title"></span><span class="setup-detail"></span></span>` +
      `<button type="button" class="btn sm setup-action"><span class="spinner sm" aria-hidden="true"></span><span class="setup-action-label"></span></button>` +
      `</div>` +
      `<div class="setup-cmd" id="${cmdId}" hidden>` +
      `<div class="cmd"><span class="cmd-prompt" aria-hidden="true">$</span><code></code>` +
      `<button type="button" class="setup-copy" aria-label="Copy the command">${icon('copy', 14)}<span>Copy</span></button></div>` +
      `<p class="setup-note"></p></div>`;
    const btn = row.querySelector<HTMLButtonElement>('.setup-action')!;
    btn.addEventListener('click', () => {
      const line = lineOf(id);
      if (!line || line.busy) return;
      if (line.command) {
        if (open.has(id)) open.delete(id);
        else open.add(id);
        fill(row, line);
        return;
      }
      o.onAction(id, btn);
    });
    const copy = row.querySelector<HTMLButtonElement>('.setup-copy')!;
    copy.addEventListener('click', () => {
      const command = lineOf(id)?.command;
      if (!command) return;
      void copyWithFeedback(copy, command);
    });
    return row;
  };

  return {
    render(lines: SetupLine[]) {
      current = lines.slice();
      const ids = new Set(lines.map((l) => l.id));
      for (const [id, row] of rows) {
        if (ids.has(id)) continue;
        row.remove();
        rows.delete(id);
        open.delete(id);
      }
      let prev: HTMLElement | null = null;
      for (const line of lines) {
        let row = rows.get(line.id);
        if (!row) {
          row = create(line.id);
          rows.set(line.id, row);
        }
        fill(row, line);
        const want: Element | null = prev ? prev.nextElementSibling : root.firstElementChild;
        if (want !== row) root.insertBefore(row, want);
        prev = row;
      }
      root.hidden = lines.length === 0;
    },
    lines: () => current.map((l) => l.id),
  };
}
