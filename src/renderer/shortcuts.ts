// The keyboard shortcuts sheet (⌘/ and the top bar's keyboard button): the list of shortcuts and the dialog around it.

import { byId, escapeHtml } from './dom.js';
import { closeMenu } from './popover.js';

/** Label, keys, and an alternative (shown as "⌘↑ / ⌘↓") */
const SHORTCUTS: [string, string[], string[]?][] = [
  ['New session', ['⌘', 'N']],
  ['Toggle sidebar', ['⌘', 'B']],
  ['Toggle browser', ['⌘', '⇧', 'B']],
  ['Toggle diff', ['⌘', '⇧', 'D']],
  ['Toggle terminal', ['⌘', '⇧', 'T']],
  ['Toggle the mods rail', ['⌘', '⇧', 'E']],
  ['New terminal tab', ['⌘', 'T']],
  ['New browser tab (in the browser)', ['⌘', '⇧', 'N']],
  ['Close the browser tab (in the browser)', ['⌘', 'W']],
  ['Focus the address bar (in the browser)', ['⌘', 'L']],
  ['Settings', ['⌘', ',']],
  ['Cycle permission mode', ['⇧', 'Tab']],
  ['Stop the run', ['Esc']],
  ['Allow once, or submit the answers', ['⌘', '↵']],
  ['Deny, or skip the questions (while a card waits)', ['Esc']],
  ['Allow for the session or in the project', ['A'], ['P']],
  ['Rewind to your last message', ['Esc', 'Esc']],
  ['Focus the composer', ['⌘', 'K']],
  ['Clear the terminal (in a terminal)', ['⌘', 'K']],
  ['Search sessions', ['⌘', 'F']],
  ['Back a page (Scheduled tasks, Dreaming)', ['⌘', '[']],
  ['Rename session', ['F2']],
  ['New line in the composer', ['⇧', '↵']],
  ['Previous or next message you sent', ['⌘', '↑'], ['⌘', '↓']],
  ['Copy the last reply', ['⌘', '⇧', 'C']],
  ['Mention a file', ['@']],
  ["Add to the project's instructions", ['#']],
  ['Keyboard shortcuts', ['⌘', '/']],
];
export interface ShortcutsDeps {
  dialog: HTMLDialogElement;
  /** Another dialog is open: the sheet does not open over it */
  dialogOpen(): boolean;
  /** The native browser view floats above the page; it is hidden while the sheet is open */
  hideBrowser(): void;
  /** The sheet closed: the browser view comes back and the composer takes the focus */
  afterClose(): void;
}

export function createShortcutsSheet({ dialog: shortcutsDialog, dialogOpen, hideBrowser, afterClose }: ShortcutsDeps): { openShortcuts(): void } {
  const kbds = (keys: string[]) => keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('');
  byId('shortcut-list').innerHTML = SHORTCUTS.map(
    ([label, keys, alt]) => `<dt>${escapeHtml(label)}</dt><dd>${kbds(keys)}${alt ? `<span class="kbd-sep">/</span>${kbds(alt)}` : ''}</dd>`,
  ).join('');

  function openShortcuts(): void {
    if (dialogOpen()) return;
    closeMenu();
    hideBrowser();
    shortcutsDialog.showModal();
    shortcutsDialog.focus({ preventScroll: true });
  }
  byId('shortcuts-btn').onclick = openShortcuts;
  byId('shortcuts-close').onclick = () => shortcutsDialog.close();
  shortcutsDialog.addEventListener('click', (e) => {
    if (e.target === shortcutsDialog) shortcutsDialog.close();
  });
  shortcutsDialog.addEventListener('close', afterClose);

  return { openShortcuts };
}
