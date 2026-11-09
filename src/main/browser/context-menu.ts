// The page's context menu: a native menu built from what Chromium says was clicked (the context-menu event's params)
// and the tab's history. Spelling suggestions and Add to Dictionary on a misspelled word; Open Link in New Tab and
// Copy Link Address on a link; Open Image in New Tab, Copy Image and Save Image As… on an image; Copy and Search
// DuckDuckGo on a selection; Cut, Copy, Paste, Paste and Match Style and Select All in a field, as its edit flags
// allow; Back, Forward and Reload on the page itself; then Print…, Save as PDF… and Inspect Element. None of it is
// the agent's: it runs only from the user's right click, and nothing here is stamped as an action of the agent.
//
// contextMenuTemplate is pure (test/browser-polish.js). The live checks cannot click a native menu in a hidden window:
// there the menu is built and kept (lastContextMenu) but not popped up.

import { Menu, type MenuItemConstructorOptions } from 'electron';

/** The parts of Electron's ContextMenuParams the menu reads. */
export interface ContextParams {
  x: number;
  y: number;
  linkURL: string;
  srcURL: string;
  /** 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin' */
  mediaType: string;
  selectionText: string;
  isEditable: boolean;
  misspelledWord: string;
  dictionarySuggestions: string[];
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

/** What the tab says beside the params. */
export interface ContextState {
  canGoBack: boolean;
  canGoForward: boolean;
}

/** What an item does (the controller carries it out on the tab). */
export type ContextAction =
  | { do: 'replace'; word: string }
  | { do: 'learn'; word: string }
  | { do: 'back' | 'forward' | 'reload' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll' | 'copyImage' | 'print' | 'savePdf' | 'inspect' }
  | { do: 'openTab'; url: string }
  | { do: 'copyText'; text: string }
  | { do: 'saveImage'; url: string }
  | { do: 'search'; query: string };

export type ContextItem = { type: 'separator' } | { label: string; enabled: boolean; action: ContextAction | null };

const SEARCH_LABEL_MAX = 32;

/** A selection as the search item names it: one line, at most 32 characters. */
export function clipSelection(text: string, max = SEARCH_LABEL_MAX): string {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [...one].length > max ? `${[...one].slice(0, max - 1).join('').trimEnd()}…` : one;
}

/** The address a selection is searched at (the URL bar's search too). */
export function searchUrl(query: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(String(query ?? '').replace(/\s+/g, ' ').trim())}`;
}

/** Pages a tab may open from the menu: not a javascript: link. */
const openable = (url: string): boolean => /^(https?|file|artifact|data|blob):/i.test(String(url ?? '').trim());

/**
 * The menu for one right click, as groups with separators between them: spelling, link, image, selection or the
 * field's editing, the page's own (Back, Forward, Reload, only where nothing more particular was clicked), Print… and
 * Save as PDF…, and Inspect Element. An item that cannot run now is there but disabled (Paste with nothing to paste).
 */
export function contextMenuTemplate(params: ContextParams, state: ContextState): ContextItem[] {
  const p = params;
  const groups: ContextItem[][] = [];
  const item = (label: string, action: ContextAction | null, enabled = true): ContextItem => ({ label, enabled: enabled && action !== null, action });
  const link = String(p.linkURL ?? '');
  const src = String(p.srcURL ?? '');
  const selection = String(p.selectionText ?? '').trim();
  const image = p.mediaType === 'image' && src !== '';
  const flags = p.editFlags ?? { canCut: false, canCopy: false, canPaste: false, canSelectAll: false };

  if (p.isEditable && p.misspelledWord) {
    const word = p.misspelledWord;
    const guesses = (p.dictionarySuggestions ?? []).filter((s) => typeof s === 'string' && s).slice(0, 5);
    groups.push([
      ...(guesses.length ? guesses.map((s) => item(s, { do: 'replace', word: s })) : [item('No Guesses Found', null, false)]),
      item('Add to Dictionary', { do: 'learn', word }),
    ]);
  }
  if (link) {
    groups.push([
      ...(openable(link) ? [item('Open Link in New Tab', { do: 'openTab', url: link })] : []),
      item('Copy Link Address', { do: 'copyText', text: link }),
    ]);
  }
  if (image) {
    groups.push([
      ...(openable(src) ? [item('Open Image in New Tab', { do: 'openTab', url: src })] : []),
      item('Copy Image', { do: 'copyImage' }),
      item('Save Image As…', { do: 'saveImage', url: src }),
    ]);
  }
  const search = selection ? [item(`Search DuckDuckGo for “${clipSelection(selection)}”`, { do: 'search', query: selection })] : [];
  if (p.isEditable) {
    groups.push([
      item('Cut', { do: 'cut' }, flags.canCut),
      item('Copy', { do: 'copy' }, flags.canCopy),
      item('Paste', { do: 'paste' }, flags.canPaste),
      item('Paste and Match Style', { do: 'pasteAndMatchStyle' }, flags.canPaste),
      item('Select All', { do: 'selectAll' }, flags.canSelectAll),
    ]);
    if (search.length) groups.push(search);
  } else if (selection) {
    groups.push([item('Copy', { do: 'copy' }), ...search]);
  }
  if (!link && !image && !selection && !p.isEditable) {
    groups.push([item('Back', { do: 'back' }, state.canGoBack), item('Forward', { do: 'forward' }, state.canGoForward), item('Reload', { do: 'reload' })]);
  }
  groups.push([item('Print…', { do: 'print' }), item('Save as PDF…', { do: 'savePdf' })]);
  groups.push([item('Inspect Element', { do: 'inspect' })]);

  const out: ContextItem[] = [];
  for (const g of groups.filter((x) => x.length)) {
    if (out.length) out.push({ type: 'separator' });
    out.push(...g);
  }
  return out;
}

/** The labels of a template, separators as '-' (what the live checks compare). */
export function menuLabels(items: ContextItem[]): string[] {
  return items.map((i) => ('type' in i ? '-' : i.label));
}

let last: { labels: string[]; enabled: boolean[]; params: { x: number; y: number; linkURL: string; srcURL: string; selectionText: string; isEditable: boolean } } | null = null;

/** The menu the last right click built (for the live checks, which cannot see a native menu). */
export function lastContextMenu(): typeof last {
  return last ? { ...last, labels: [...last.labels], enabled: [...last.enabled], params: { ...last.params } } : null;
}

/** The live checks run the app in a hidden window, where a native menu would wait for a click nobody makes. */
const POPUP = !process.env.SILO_HARNESS_LIVE_TEST;

/** Builds the menu for a right click and shows it at the pointer; `run` carries out the chosen item. */
export function showContextMenu(params: ContextParams, state: ContextState, run: (action: ContextAction) => void, popup: (menu: Menu) => void): void {
  const items = contextMenuTemplate(params, state);
  last = {
    labels: menuLabels(items),
    enabled: items.map((i) => ('type' in i ? false : i.enabled)),
    params: { x: params.x, y: params.y, linkURL: params.linkURL, srcURL: params.srcURL, selectionText: params.selectionText, isEditable: params.isEditable },
  };
  const template: MenuItemConstructorOptions[] = items.map((i) =>
    'type' in i ? { type: 'separator' } : { label: i.label, enabled: i.enabled, click: () => i.action && run(i.action) },
  );
  if (POPUP) popup(Menu.buildFromTemplate(template));
}
