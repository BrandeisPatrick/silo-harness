// The Browser pane's own chrome beyond the URL bar: the tab strip (a tab per page with its favicon, title and ×, a +
// at the end), the popups the main process reports (the cards themselves are native views laid over the pane), and
// the one-time note that the browser now keeps a profile of its own. side-pane.ts owns the pane and calls in here.

import type { BrowserState, PopupState, TabState } from '../shared/browser';
import { icon } from './icons.js';
import { onPush, rpc } from './rpc.js';

export interface BrowserPaneDeps {
  /** The tab strip (role="tablist"); one .browser-tab per tab is rendered into it */
  strip: HTMLElement;
  newButton: HTMLButtonElement;
  /** The note under the URL bar and its × */
  note: HTMLElement;
  noteClose: HTMLButtonElement;
  urlField: HTMLInputElement;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
}

/** The host of a page, for a tab without a title ("example.com"); the URL itself for pages without one. */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : url;
  } catch {
    return url;
  }
}

export function createBrowserPane(o: BrowserPaneDeps) {
  let state: BrowserState | null = null;
  let popups: PopupState[] = [];
  const tabEls = new Map<string, HTMLElement>();
  const GLOBE = icon('globe', 16);

  function tabElement(id: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'browser-tab';
    el.dataset.id = id;
    el.setAttribute('role', 'tab');
    el.innerHTML = `<span class="browser-tab-icon" aria-hidden="true">${GLOBE}</span><span class="browser-tab-title"></span><button type="button" class="browser-tab-close" tabindex="-1" aria-label="Close tab" data-tip="Close tab">${icon('x', 14)}</button>`;
    return el;
  }

  function updateTab(el: HTMLElement, t: TabState, isActive: boolean): void {
    const blank = !t.url || t.url === 'about:blank';
    const title = t.title && t.title !== t.url ? t.title : blank ? 'New tab' : t.loading ? 'Loading…' : hostOf(t.url);
    el.classList.toggle('active', isActive);
    el.classList.toggle('loading', t.loading);
    el.setAttribute('aria-selected', String(isActive));
    el.tabIndex = isActive ? 0 : -1;
    const titleEl = el.querySelector<HTMLElement>('.browser-tab-title')!;
    if (titleEl.textContent !== title) titleEl.textContent = title;
    const iconEl = el.querySelector<HTMLElement>('.browser-tab-icon')!;
    const current = iconEl.dataset.favicon ?? '';
    const next = t.favicon ?? '';
    if (current !== next) {
      iconEl.dataset.favicon = next;
      if (next) {
        iconEl.innerHTML = '<img alt="">';
        (iconEl.firstChild as HTMLImageElement).src = next;
      } else iconEl.innerHTML = GLOBE;
    }
    el.setAttribute('aria-label', `${title}${blank ? '' : `, ${t.url}`}`);
    el.dataset.tip = blank ? 'New tab' : t.url;
    el.querySelector('.browser-tab-close')!.setAttribute('aria-label', `Close ${title}`);
  }

  function render(): void {
    const s = state;
    if (!s) return;
    const ids = new Set(s.tabs.map((t) => t.id));
    for (const [id, el] of tabEls) {
      if (ids.has(id)) continue;
      el.remove();
      tabEls.delete(id);
    }
    s.tabs.forEach((t, i) => {
      let el = tabEls.get(t.id);
      if (!el) {
        el = tabElement(t.id);
        tabEls.set(t.id, el);
      }
      updateTab(el, t, t.id === s.activeId);
      const at = o.strip.children.item(i);
      if (at !== el) o.strip.insertBefore(el, at);
    });
    const active = tabEls.get(s.activeId);
    if (active && o.strip.scrollWidth > o.strip.clientWidth) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function applyState(s: BrowserState): void {
    state = s;
    render();
  }

  async function act(anchor: HTMLElement, what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (err) {
      o.showError(anchor, `${what}: ${o.cleanError(err)}`);
    }
  }

  /** The + button and ⌘⇧N: a blank tab, active. */
  function newTab(): Promise<void> {
    return act(o.newButton, "Couldn't open a tab", () => rpc('browser.newTab'));
  }

  function closeTab(id: string): Promise<void> {
    const anchor = tabEls.get(id) ?? o.strip;
    return act(anchor, "Couldn't close the tab", () => rpc('browser.closeTab', id));
  }

  /** ⌘W with the pane focused: the active tab goes (the last one leaves a blank tab). */
  function closeActive(): Promise<void> {
    const id = state?.activeId;
    return id ? closeTab(id) : Promise.resolve();
  }

  function activate(id: string): Promise<void> {
    return act(tabEls.get(id) ?? o.strip, "Couldn't switch tabs", () => rpc('browser.activateTab', id));
  }

  /** ⌘L: the URL bar, its text selected (the field selects on focus). */
  function focusUrl(): void {
    o.urlField.focus();
    o.urlField.select();
  }

  /** The one-time note about the browser's own profile, when the main process says it is due. */
  async function refreshNote(): Promise<void> {
    try {
      o.note.hidden = !(await rpc('browser.profileNote'));
    } catch {
      o.note.hidden = true;
    }
  }
  o.noteClose.onclick = () => {
    o.note.hidden = true;
    void rpc('browser.dismissProfileNote').catch(() => undefined);
  };

  o.newButton.onclick = () => void newTab();
  o.strip.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const tab = target.closest<HTMLElement>('.browser-tab');
    const id = tab?.dataset.id;
    if (!tab || !id) return;
    if (target.closest('.browser-tab-close')) void closeTab(id);
    else void activate(id);
  });
  // Middle-click closes a tab (and must not start autoscroll).
  o.strip.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  o.strip.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.browser-tab');
    if (!tab?.dataset.id) return;
    e.preventDefault();
    void closeTab(tab.dataset.id);
  });
  o.strip.addEventListener('keydown', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.browser-tab');
    const id = tab?.dataset.id;
    const tabs = state?.tabs ?? [];
    if (!tab || !id || !tabs.length || e.metaKey || e.ctrlKey || e.altKey) return;
    const at = tabs.findIndex((t) => t.id === id);
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void activate(id);
      return;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      void closeTab(id);
      return;
    }
    if (next < 0 || at < 0) return;
    e.preventDefault();
    const nextId = tabs[next].id;
    void activate(nextId);
    tabEls.get(nextId)?.focus();
  });
  // A vertical wheel scrolls an overflowing strip sideways (no arrows).
  o.strip.addEventListener(
    'wheel',
    (e) => {
      if (o.strip.scrollWidth <= o.strip.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      o.strip.scrollLeft += e.deltaY;
    },
    { passive: false },
  );

  onPush('browser:popups', (list) => {
    popups = Array.isArray(list) ? list : [];
  });
  onPush('browser:focus-url', () => focusUrl());

  return {
    applyState,
    newTab,
    closeTab,
    closeActive,
    activate,
    focusUrl,
    refreshNote,
    popups: () => popups.map((p) => ({ ...p, bounds: { ...p.bounds } })),
    /** For the live checks: the tabs as drawn and the popups as last reported */
    debug: () => ({
      tabs: (state?.tabs ?? []).map((t) => ({ id: t.id, url: t.url, title: t.title, loading: t.loading, favicon: Boolean(t.favicon), blockedPopups: t.blockedPopups })),
      activeId: state?.activeId ?? '',
      drawn: [...o.strip.querySelectorAll<HTMLElement>('.browser-tab')].map((el) => ({ id: el.dataset.id, title: el.querySelector('.browser-tab-title')?.textContent ?? '', active: el.classList.contains('active') })),
      popups: popups.map((p) => ({ id: p.id, tabId: p.tabId, title: p.title, url: p.url, bounds: { ...p.bounds } })),
      noteShown: !o.note.hidden,
    }),
  };
}
