// Find in page: the bar under the URL bar (the page is a native view drawn above the window, so the bar is the pane's
// chrome and its height comes out of the view's slot, as the permission bar's does). ⌘F opens it, from the page (the
// main process pushes browser:find-open) or from the pane's chrome; typing searches as you go, Enter moves to the next
// match, ⇧Enter to the one before, Esc or × closes it and gives the page the focus back. Chromium does the search and
// the highlighting (main: find.ts); the bar shows "3 of 12". It belongs to the tab it searched: a tab switch closes it.
// side-pane.ts creates it.

import type { BrowserState, FindResultState } from '../shared/browser';
import { onPush, rpc } from './rpc.js';

export interface BrowserFindDeps {
  bar: HTMLElement;
  input: HTMLInputElement;
  count: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
}

/** "3 of 12", or "No results" once a search is over with none; '' while nothing is known (main's find.ts has the same). */
export function findLabel(r: Pick<FindResultState, 'matches' | 'active' | 'final'>): string {
  if (r.matches > 0) return `${Math.max(1, r.active)} of ${r.matches}`;
  return r.final ? 'No results' : '';
}

const NONE: Omit<FindResultState, 'tabId'> = { text: '', matches: 0, active: 0, final: false };

export function createBrowserFind(o: BrowserFindDeps) {
  let open = false;
  /** The tab the bar searches (the active one when it opened) */
  let tabId = '';
  let activeId = '';
  let result = { ...NONE };

  function render(): void {
    const text = o.input.value;
    const current = result.text !== '' && result.text === text;
    o.count.textContent = current ? findLabel(result) : '';
    o.count.classList.toggle('none', current && result.final && result.matches === 0);
    const can = current && result.matches > 0;
    o.prev.disabled = !can;
    o.next.disabled = !can;
  }

  function act(promise: Promise<unknown>): void {
    promise.catch((err: unknown) => o.showError(o.input, `Couldn't search the page: ${o.cleanError(err)}`));
  }

  /** A new search for the field's text, or the next (previous) match of the same one. */
  function search(forward = true): void {
    act(rpc('browser.find', o.input.value, { forward }));
  }

  /** ⌘F: the bar opens on the active tab with its field focused and selected (the last text searched again). */
  function openBar(): void {
    if (!open) {
      open = true;
      tabId = activeId;
      o.bar.hidden = false;
      result = { ...NONE };
      render();
      if (o.input.value) search(true);
    }
    o.input.focus();
    o.input.select();
  }

  /** Esc or ×: the search stops and its highlight goes; `focusPage` gives the page the focus back. */
  function closeBar(focusPage: boolean, tell = true): void {
    if (!open) return;
    open = false;
    o.bar.hidden = true;
    result = { ...NONE };
    render();
    if (tell) act(rpc('browser.stopFind', { focusPage }));
  }

  o.input.addEventListener('input', () => {
    result = { ...NONE };
    render();
    search(true);
  });
  o.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (o.input.value) search(!e.shiftKey);
    } else if (e.key === 'Escape') {
      // Esc here closes the bar; it is not the transcript's Esc (stop the run, rewind)
      e.preventDefault();
      e.stopPropagation();
      closeBar(true);
    }
  });
  o.prev.addEventListener('click', () => search(false));
  o.next.addEventListener('click', () => search(true));
  o.close.addEventListener('click', () => closeBar(true));

  onPush('browser:find-open', () => openBar());
  onPush('browser:found', (r) => {
    if (!open || !r) return;
    // Opened before the first state arrived: the bar searched the tab in front, which is the one answering
    if (!tabId) tabId = r.tabId;
    if (r.tabId !== tabId) return;
    // A stopped search (the tab went to a new page) leaves the text in the field and clears the count
    if (r.text && r.text !== o.input.value) return;
    result = { text: r.text, matches: r.matches, active: r.active, final: r.final };
    render();
  });

  function applyState(s: BrowserState): void {
    activeId = s.activeId;
    // The bar belongs to the tab it searched: another tab in front closes it (the main process stopped that search)
    if (open && s.activeId !== tabId) closeBar(false, false);
  }

  return {
    applyState,
    openBar,
    closeBar: () => closeBar(false),
    isOpen: () => open,
    /** For the live checks: what the bar shows */
    debug: () => ({ open, tabId, text: o.input.value, count: o.count.textContent ?? '', focused: document.activeElement === o.input, height: open ? o.bar.getBoundingClientRect().height : 0 }),
  };
}
