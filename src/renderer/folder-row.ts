// The welcome screen's folder row (#folder-row, under the title): the working folder's path, with the home folder as
// "~" and a long path shortened in the middle (the whole path is the tooltip), and Choose folder, a menu of the Silo
// folder, the recent project folders (AppConfig.recentDirs) and "Choose another folder…", which opens the folder
// dialog. The app decides which folders the menu lists and does the switch (see FolderRowOptions).

import { basename } from './dom.js';
import { icon } from './icons.js';
import { shortPath, tilde } from './home.js';
import { closeMenu, menuAnchoredTo, openMenu } from './popover.js';

/** The contract's limit: the main process keeps at most this many recent folders */
export const MAX_RECENT = 8;

/** "/Users/me/app/" → "/Users/me/app" (the root stays "/") */
export function cleanDir(dir: string): string {
  const d = String(dir ?? '').trim();
  return d.length > 1 ? d.replace(/\/+$/, '') || '/' : d;
}

/**
 * The menu's folders: the Silo folder, then the working folder when it is neither that nor a recent one, then the
 * recent folders. Absolute paths only, no repeats, at most MAX_RECENT recent ones.
 */
export function folderChoices(silo: string, recent: unknown, current: string): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== 'string') return;
    const d = cleanDir(v);
    if (d.startsWith('/') && !out.includes(d)) out.push(d);
  };
  const list = Array.isArray(recent) ? recent.slice(0, MAX_RECENT) : [];
  add(silo);
  if (!list.some((v) => typeof v === 'string' && cleanDir(v) === cleanDir(current))) add(current);
  for (const v of list) add(v);
  return out;
}

export interface FolderRowOptions {
  /** #folder-row */
  root: HTMLElement;
  /** The folders the menu lists, in order */
  choices(): string[];
  /** A folder in the menu was picked: switch to it. The button shows it is busy (and takes no click) until this settles. */
  onPick(dir: string, button: HTMLButtonElement): Promise<void> | void;
  /** "Choose another folder…": the folder dialog */
  onChoose(button: HTMLButtonElement): Promise<void> | void;
}

export interface FolderRow {
  /** Shows this folder as the working folder (none hides the row) */
  render(dir: string): void;
}

export function createFolderRow(o: FolderRowOptions): FolderRow {
  const root = o.root;
  root.innerHTML =
    `<span class="folder-row-icon" aria-hidden="true">${icon('folder', 14)}</span>` +
    `<span class="folder-row-path" id="folder-row-path"><bdi dir="ltr"></bdi></span>` +
    `<button type="button" class="btn sm folder-row-btn" id="folder-row-btn" aria-haspopup="menu" aria-expanded="false">` +
    `<span>Choose folder</span><span class="folder-row-chev" aria-hidden="true">${icon('chevron-down', 12)}</span></button>`;
  const pathEl = root.querySelector<HTMLElement>('.folder-row-path')!;
  const pathText = pathEl.querySelector('bdi')!;
  const button = root.querySelector<HTMLButtonElement>('.folder-row-btn')!;
  let current = '';
  let busy = false;

  const run = async (fn: () => Promise<void> | void) => {
    if (busy) return;
    busy = true;
    button.classList.add('busy');
    button.setAttribute('aria-busy', 'true');
    try {
      await fn();
    } finally {
      busy = false;
      button.classList.remove('busy');
      button.removeAttribute('aria-busy');
    }
  };

  button.addEventListener('click', () => {
    if (busy) return;
    if (menuAnchoredTo(button)) return closeMenu();
    const here = cleanDir(current);
    button.setAttribute('aria-expanded', 'true');
    openMenu(
      [
        { items: o.choices().map((dir) => ({ label: shortPath(dir), icon: 'folder' as const, checked: dir === here, onSelect: () => void run(() => (dir === here ? undefined : o.onPick(dir, button))) })) },
        { items: [{ label: 'Choose another folder…', onSelect: () => void run(() => o.onChoose(button)) }] },
      ],
      { anchor: button, placement: 'bottom-start', minWidth: 240, className: 'folder-menu', onClose: () => button.setAttribute('aria-expanded', 'false') },
    );
  });

  return {
    render(dir: string) {
      current = String(dir ?? '');
      const label = current ? shortPath(current) : '';
      if (pathText.textContent !== label) pathText.textContent = label;
      pathEl.dataset.tip = tilde(current);
      root.hidden = !current;
    },
  };
}

/** A folder's name for messages ("app"; "/" for the root) */
export function dirName(dir: string): string {
  return basename(dir) || dir;
}
