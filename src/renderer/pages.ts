// Pages in the main column: Scheduled tasks and Dreaming, each a list and a page per task or project, in place of
// the session on screen (the sidebar stays, its row shows selected). Choosing a session, starting one or a
// notification's session closes the page; ⌘[ goes back a page. The page modules (scheduled-page.ts,
// dreaming-page.ts) fill the column; this file is the host: the route, the top bar's breadcrumb, the history, focus.

import { h } from './dom.js';
import { icon } from './icons.js';
import { bus } from './bus.js';
import { closeMenu, menuAnchoredTo, openMenu, type MenuSection } from './popover.js';

export type PageRoute =
  | { page: 'scheduled'; tab?: 'yours' | 'templates' }
  | { page: 'task'; id: string }
  | { page: 'dreaming'; tab?: 'projects' | 'suggestions' }
  | { page: 'project'; cwd: string };

/** The sidebar row a page belongs to */
export type PageNav = 'scheduled' | 'dreaming';

export const navOf = (r: PageRoute): PageNav => (r.page === 'scheduled' || r.page === 'task' ? 'scheduled' : 'dreaming');

export interface Crumbs {
  /** The list the page belongs to ("Scheduled tasks") */
  parent: { label: string; route: PageRoute };
  title: string;
  /** The ⌄ menu after the title */
  menu?: () => MenuSection[];
}

/** What a page module returns once it rendered a route into the column */
export interface PageHandle {
  crumbs?: Crumbs;
  /** The route on screen changed in place (a tab), for the history */
  route?: () => PageRoute;
  dispose?(): void;
}

export type PageRenderer = (route: PageRoute, root: HTMLElement, host: PageHost) => PageHandle | null;

export interface PageHost {
  open(route: PageRoute, opts?: { replace?: boolean; focus?: boolean }): void;
  close(): void;
  back(): void;
  isOpen(): boolean;
  current(): PageRoute | null;
  /** The breadcrumb changed (a rename): draw it again */
  syncCrumbs(): void;
}

export interface PagesDeps {
  shell: HTMLElement;
  /** <main class="main"> */
  main: HTMLElement;
  topbar: HTMLElement;
  /** The page opened or closed: hide or bring back the native browser view, re-render the sidebar */
  changed(open: boolean): void;
  /** Renders a route; null when the route's feature is absent */
  render: PageRenderer;
}

export interface PagesView extends PageHost {
  debug: { state(): { open: boolean; route: PageRoute | null; history: PageRoute[]; crumbs: { parent: string; title: string } | null } };
}

export function createPages(d: PagesDeps): PagesView {
  const view = h('div', { id: 'page-view', class: 'page-view', role: 'region', 'aria-labelledby': 'page-title', hidden: true });
  d.main.append(view);
  const crumbsEl = h('nav', { id: 'page-crumbs', class: 'page-crumbs', 'aria-label': 'Breadcrumb', hidden: true });
  d.topbar.insertBefore(crumbsEl, d.topbar.querySelector('.spacer'));

  let route: PageRoute | null = null;
  let handle: PageHandle | null = null;
  const history: PageRoute[] = [];

  const same = (a: PageRoute | null, b: PageRoute | null) => JSON.stringify(a) === JSON.stringify(b);

  function drawCrumbs(): void {
    crumbsEl.innerHTML = '';
    const c = handle?.crumbs;
    d.shell.classList.toggle('page-detail', Boolean(c));
    crumbsEl.hidden = !c;
    if (!c) return;
    const parent = h('button', { type: 'button', class: 'crumb-link', 'data-crumb': 'parent' }, c.parent.label);
    parent.addEventListener('click', () => open(c.parent.route));
    const sep = h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/');
    const title = h('span', { class: 'crumb-title', title: c.title }, c.title);
    const cur = h('span', { class: 'crumb-current', 'aria-current': 'page' }, title);
    if (c.menu) {
      const btn = h('button', { type: 'button', class: 'crumb-menu', 'aria-haspopup': 'menu', 'aria-label': `${c.title}: actions`, 'data-tip': 'Actions' }, title, h('span', { class: 'crumb-chev', html: icon('chevron-down', 12) }));
      btn.addEventListener('click', () => {
        if (menuAnchoredTo(btn)) return closeMenu();
        btn.setAttribute('aria-expanded', 'true');
        openMenu(c.menu!(), { anchor: btn, placement: 'bottom-start', minWidth: 200, onClose: () => btn.setAttribute('aria-expanded', 'false') });
      });
      crumbsEl.append(parent, sep, btn);
    } else crumbsEl.append(parent, sep, cur);
  }

  function mount(r: PageRoute, focus: boolean): void {
    handle?.dispose?.();
    handle = null;
    closeMenu();
    view.innerHTML = '';
    view.scrollTop = 0;
    route = r;
    view.dataset.page = r.page;
    handle = d.render(r, view, host);
    if (!handle) {
      // The feature is not in this build
      route = null;
      close();
      return;
    }
    drawCrumbs();
    if (focus) view.querySelector<HTMLElement>('#page-title')?.focus({ preventScroll: true });
  }

  function open(r: PageRoute, opts: { replace?: boolean; focus?: boolean } = {}): void {
    const wasOpen = route !== null;
    const now = handle?.route?.() ?? route;
    if (wasOpen && same(now, r)) return;
    if (wasOpen && now && !opts.replace) history.push(now);
    if (history.length > 30) history.splice(0, history.length - 30);
    if (!wasOpen) {
      d.shell.classList.add('page-open');
      view.hidden = false;
    }
    mount(r, opts.focus !== false);
    if (route) {
      d.shell.dataset.page = navOf(route);
      d.changed(true);
    }
  }

  function close(): void {
    if (!d.shell.classList.contains('page-open')) return;
    handle?.dispose?.();
    handle = null;
    route = null;
    history.length = 0;
    closeMenu();
    view.innerHTML = '';
    view.hidden = true;
    crumbsEl.hidden = true;
    crumbsEl.innerHTML = '';
    d.shell.classList.remove('page-open', 'page-detail');
    delete d.shell.dataset.page;
    d.changed(false);
  }

  function back(): void {
    if (!route) return;
    const prev = history.pop();
    if (prev) {
      mount(prev, true);
      if (route) d.shell.dataset.page = navOf(route);
      d.changed(true);
    } else close();
  }

  // A session coming on screen (chosen in the sidebar, a new one, a notification) takes the column back
  bus.on('session-shown', () => close());

  document.addEventListener('keydown', (e) => {
    if (!route || !(e.metaKey || e.ctrlKey) || e.key !== '[' || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    back();
  });

  const host: PageHost = {
    open,
    close,
    back,
    isOpen: () => route !== null,
    current: () => handle?.route?.() ?? route,
    syncCrumbs: drawCrumbs,
  };

  return {
    ...host,
    debug: {
      state: () => ({
        open: route !== null,
        route: host.current(),
        history: history.map((r) => ({ ...r })),
        crumbs: handle?.crumbs ? { parent: handle.crumbs.parent.label, title: handle.crumbs.title } : null,
      }),
    },
  };
}

// ---------- Shared pieces of the two pages ----------

export interface ToolbarTab<T extends string> {
  value: T;
  label: string;
  /** A count after the label (0: none) */
  count?: number;
}

/** The segmented tabs at the left of a page's toolbar (Yours | Templates); ←/→ move between them. */
export function pageTabs<T extends string>(label: string, tabs: ToolbarTab<T>[], value: T, onChange: (v: T) => void): HTMLElement {
  const el = h('div', { class: 'pg-tabs', role: 'tablist', 'aria-label': label });
  const buttons = tabs.map((t) => {
    const b = h('button', { type: 'button', class: 'pg-tab', role: 'tab', 'aria-selected': String(t.value === value), tabindex: t.value === value ? '0' : '-1', 'data-tab': t.value }, t.label);
    if (t.count) b.append(h('span', { class: 'pg-tab-count', 'aria-label': `, ${t.count} waiting` }, String(t.count)));
    b.addEventListener('click', () => {
      if (t.value !== value) onChange(t.value);
    });
    return b;
  });
  el.append(...buttons);
  el.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    next.focus();
    next.click();
  });
  return el;
}

/** A small icon button of the toolbar (search, filter, sort); `on` marks one whose filter is not the default. */
export function toolIcon(name: Parameters<typeof icon>[0], label: string, onClick: (b: HTMLButtonElement) => void, opts: { on?: boolean; menu?: boolean; id?: string } = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', class: `icon-btn pg-tool${opts.on ? ' on' : ''}`, 'aria-label': label, 'data-tip': label, ...(opts.menu ? { 'aria-haspopup': 'menu' } : {}), ...(opts.id ? { id: opts.id } : {}), html: icon(name, 16) });
  b.addEventListener('click', () => onClick(b));
  return b;
}

/** A menu of choices with a check on the one in force (filter, sort). */
export function choiceMenu<T extends string>(anchor: HTMLElement, label: string, choices: { value: T; label: string }[], value: T, onPick: (v: T) => void): void {
  if (menuAnchoredTo(anchor)) return closeMenu();
  anchor.setAttribute('aria-expanded', 'true');
  openMenu([{ label, items: choices.map((c) => ({ label: c.label, checked: c.value === value, onSelect: () => onPick(c.value) })) }], {
    anchor,
    placement: 'bottom-end',
    minWidth: 180,
    onClose: () => anchor.setAttribute('aria-expanded', 'false'),
  });
}

/** The title block at the top of a page: the serif title, an optional chip, and a muted line under it. */
export function pageHead(title: string, opts: { chip?: string; sub?: string; actions?: HTMLElement | null } = {}): HTMLElement {
  const h1 = h('h1', { id: 'page-title', class: 'pg-title', tabindex: '-1' }, title);
  const titleRow = h('div', { class: 'pg-title-row' }, h1);
  if (opts.chip) titleRow.append(h('span', { class: 'pg-chip pg-title-chip' }, opts.chip));
  const left = h('div', { class: 'pg-head-text' }, titleRow);
  if (opts.sub) left.append(h('p', { class: 'pg-sub', id: 'page-sub' }, opts.sub));
  const head = h('header', { class: 'pg-head' }, left);
  if (opts.actions) head.append(opts.actions);
  return head;
}

/** The info banner across the column */
export function banner(text: string | Node, opts: { icon?: Parameters<typeof icon>[0]; id?: string; action?: HTMLElement | null } = {}): HTMLElement {
  const el = h('div', { class: 'pg-banner', role: 'note', ...(opts.id ? { id: opts.id } : {}) }, h('span', { class: 'pg-banner-icon', html: icon(opts.icon ?? 'info', 16) }), h('span', { class: 'pg-banner-text' }, text));
  if (opts.action) el.append(opts.action);
  return el;
}

/** Re-renders `root` with `fn`, keeping the focus on the element with the same data-focus key (or id). */
export function keepFocus(root: HTMLElement, fn: () => void): void {
  const a = document.activeElement as HTMLElement | null;
  const key = a && root.contains(a) ? a.dataset.focus || (a.id ? `#${a.id}` : '') : '';
  const sel = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement ? [a.selectionStart, a.selectionEnd] : null;
  fn();
  if (!key) return;
  const next = key.startsWith('#') ? root.querySelector<HTMLElement>(`#${CSS.escape(key.slice(1))}`) : root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (sel && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && sel[0] !== null) {
    try {
      next.setSelectionRange(sel[0], sel[1]);
    } catch {
      /* not a text field */
    }
  }
}
