// The sidebar: navigation rows (New session, Search, Scheduled, Customize, Dreaming; Scheduled and Dreaming open their
// pages in the main column), the sessions as a tree in day groups,
// search across titles and conversations, and the footer (model chip, shortcuts, settings). The logic without the
// DOM is in sidebar-model.ts; renderer.ts keeps the session list, the switch and the actions, and hands them in.

import type { SessionMeta, SessionStatus, AppConfig } from '../shared/types';
import type { SearchHit } from '../shared/history';
import type { ConfirmOptions } from './changes.js';
import { brandMark, icon } from './icons.js';
import { basename, escapeHtml } from './dom.js';
import { closeMenu, menuAnchoredTo, openMenu, type MenuSection } from './popover.js';
import { bus } from './bus.js';
import { activeProvider } from './provider-view.js';
import { onPush, rpc } from './rpc.js';
import { ancestorsOf, groupOf, leadFor, parentOf, shapeResults, shortDate, visibleRows, type Indicator, type Row, type SearchResult } from './sidebar-model.js';

export interface SidebarDeps {
  /** <aside id="sidebar"> */
  root: HTMLElement;
  sessions(): SessionMeta[];
  currentId(): string;
  status(id: string): SessionStatus;
  open(id: string): Promise<unknown>;
  fork(id: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  /** Renames; shows its own error next to `anchor`; true when it worked */
  rename(id: string, title: string, anchor: HTMLElement): Promise<boolean>;
  /** Re-reads the session list */
  refresh(): Promise<unknown>;
  openSettings(section?: string): void;
  /** Opens the Scheduled tasks or the Dreaming page in the main column */
  openPage(page: 'scheduled' | 'dreaming'): void;
  /** The page in the main column, when one is open (its row shows selected) */
  page(): 'scheduled' | 'dreaming' | null;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
  /** A short confirmation in the status area */
  flash(text: string): void;
  focusComposer(): void;
  /** Opens the sidebar when it is collapsed */
  expand(): void;
}

/** Fakes for the debug hook (__oc_debug.sidebar.mock): each key replaces one source; null puts the real one back. */
export interface SidebarMocks {
  /** history.search returns these hits for any query (shaped like the real ones) */
  search?: SearchHit[] | null;
  /** history.export returns this path (null: as if the save was cancelled) */
  export?: string | null;
  /** sessions.merge returns this; a successful one also marks the session merged in the overlay */
  merge?: { ok: boolean; error?: string } | null;
  /** Fields laid over the metas from the main process, by session id (e.g. mergedInto, origin, status) */
  metas?: Record<string, Partial<SessionMeta>> | null;
}

export interface SidebarView {
  /** Re-renders the list (statuses, titles, a new list) */
  render(): void;
  /** Search row → field, focused (⌘F) */
  openSearch(): void;
  /** Inline rename of a row */
  startRename(id: string): void;
  debug: {
    mock(m: SidebarMocks | null): void;
    /** What the list shows: rows in order with their kind, id, depth, indicator, group */
    state(): unknown;
    /** Forgets the remembered collapse state (groups and parents) */
    resetCollapse(): void;
  };
}

const GROUPS_KEY = 'sidebar.groups';
const PARENTS_KEY = 'sidebar.collapsed';
/** Search inside conversations starts at this many characters, after this pause */
const SEARCH_MIN = 2;
const SEARCH_DELAY = 200;

/** A method another feature registers that is not in this build: the control that needs it hides itself. */
function absent(err: unknown): boolean {
  return /Unknown RPC method|No handler registered/i.test(err instanceof Error ? err.message : String(err));
}

/** Probes a method once with a harmless call; true when it exists (any other failure still means it exists). */
async function probe(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (err) {
    return !absent(err);
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the state lasts until the window closes */
  }
}

/** `text` with [start, end) wrapped in <mark>, escaped. */
function highlight(text: string, range: [number, number] | null): string {
  if (!range) return escapeHtml(text);
  const [s, e] = range;
  return `${escapeHtml(text.slice(0, s))}<mark>${escapeHtml(text.slice(s, e))}</mark>${escapeHtml(text.slice(e))}`;
}

function indicatorHtml(ind: Indicator): string {
  if (!ind) return '';
  switch (ind.kind) {
    case 'running':
      return '<span class="trail-meta"><span class="spinner sm" aria-label="Running"></span></span>';
    case 'attention':
      return `<span class="trail-meta" data-tip="${ind.reason === 'plan' ? 'Plan waiting for review' : ind.reason === 'question' ? 'Waiting for your answer' : 'Waiting for your approval'}"><span class="status-dot attention" aria-label="Waiting for you"></span></span>`;
    case 'unread':
      return '<span class="trail-meta" data-tip="Finished while you were away"><span class="status-dot unread" aria-label="Unread"></span></span>';
    case 'family':
      return ind.count
        ? `<span class="trail-meta family${ind.hot ? ' hot' : ''}" data-tip="${ind.count} session${ind.count === 1 ? '' : 's'} inside${ind.hot ? ', one needs a look' : ''}">${icon('git-branch', 14)}<span class="family-count">${ind.count}</span></span>`
        : `<span class="trail-meta family" data-tip="Has forks or sub-sessions">${icon('git-branch', 14)}</span>`;
    case 'fork':
      return `<span class="trail-meta kind" data-tip="Forked session">${icon('git-branch', 14)}</span>`;
    case 'spawn':
      return `<span class="trail-meta kind" data-tip="Sub-session">${icon('sub-session', 14)}</span>`;
    case 'dream':
      return ind.waiting ? '<span class="trail-meta dream" data-tip="Suggestions wait for you"><span class="status-dot attention" aria-label="Waiting for you"></span></span>' : '';
  }
}

/** The mark in front of a title: a scheduled run's lightning, a dream's moon */
function leadHtml(m: SessionMeta): string {
  const lead = leadFor(m);
  if (lead === 'schedule') return `<span class="lead schedule" data-tip="Scheduled run" aria-label="Scheduled run:">${icon('zap', 14)}</span>`;
  if (lead === 'dream') return `<span class="lead dream" data-tip="Dream" aria-label="Dream:">${icon('moon', 14)}</span>`;
  return '';
}

export function createSidebar(d: SidebarDeps): SidebarView {
  const root = d.root;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const list = $<HTMLElement>('#session-list');
  const searchRow = $<HTMLButtonElement>('#search-row');
  const searchField = $<HTMLElement>('#search-field');
  const input = $<HTMLInputElement>('#session-search');
  const clearBtn = $<HTMLButtonElement>('#search-clear');
  const scheduledRow = $<HTMLButtonElement>('#scheduled-row');
  const customizeRow = $<HTMLButtonElement>('#customize-row');
  const dreamingRow = $<HTMLButtonElement>('#dreaming-row');
  const dreamingDot = $<HTMLElement>('#dreaming-dot');
  const modelChip = $<HTMLButtonElement>('#model-chip');
  const modelLabel = $<HTMLElement>('#model-label');
  $<HTMLElement>('#model-mark').innerHTML = brandMark(18);

  // ---------- State ----------
  let groupState = readJson<Record<string, boolean>>(GROUPS_KEY, {});
  if (!groupState || typeof groupState !== 'object' || Array.isArray(groupState)) groupState = {};
  let parentState = new Set<string>(readJson<string[]>(PARENTS_KEY, []).filter((x) => typeof x === 'string'));
  /** "Older" starts collapsed; every other group open, until the user says otherwise */
  const groupCollapsed = (label: string) => (label in groupState ? groupState[label] : label === 'Older');
  const setGroup = (label: string, collapsed: boolean) => {
    groupState[label] = collapsed;
    writeJson(GROUPS_KEY, groupState);
  };
  const setParent = (id: string, collapsed: boolean) => {
    if (collapsed) parentState.add(id);
    else parentState.delete(id);
    writeJson(PARENTS_KEY, [...parentState].slice(-500));
  };

  let mocks: SidebarMocks = {};
  const overlay: Record<string, Partial<SessionMeta>> = {};
  const metas = (): SessionMeta[] => {
    const base = d.sessions();
    const extra = { ...overlay, ...(mocks.metas ?? {}) };
    if (!Object.keys(extra).length) return base;
    return base.map((m) => (extra[m.id] ? { ...m, ...extra[m.id] } : m));
  };
  const statusOf = (id: string): SessionStatus => {
    const fake = mocks.metas?.[id]?.status;
    return fake ? { ...d.status(id), ...fake } : d.status(id);
  };

  /** What the menus and the search can offer (search: null until the first query has been tried) */
  const has = { search: null as boolean | null, export: false, merge: true };
  let rename: { id: string; value: string; fresh: boolean } | null = null;
  let menuFor = '';
  let rows: Row[] = [];
  let results: SearchResult[] = [];

  // Search
  let searchOpen = false;
  let hits: { query: string; hits: SearchHit[] } | null = null;
  let searching = '';
  let searchTimer: number | undefined;
  let searchSeq = 0;
  const query = () => input.value.trim();

  // ---------- Rendering ----------

  const rowKey = (el: Element | null): string | null => (el instanceof HTMLElement && list.contains(el) ? el.dataset.key ?? null : null);
  const byKey = (key: string) => list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  const focusables = () => [...list.querySelectorAll<HTMLElement>('.session-group, .session-item, .search-result')];

  function render(): void {
    syncNav();
    const focusKey = rowKey(document.activeElement);
    list.innerHTML = '';
    if (searchOpen && query()) renderResults();
    else renderTree();
    // Roving focus: one row is in the tab order (the focused one, else the session on screen, else the first).
    const all = focusables();
    const keep = (focusKey && byKey(focusKey)) || list.querySelector<HTMLElement>('.session-item.active') || all[0];
    for (const el of all) el.tabIndex = el === keep ? 0 : -1;
    if (rename) {
      const row = list.querySelector<HTMLElement>(`.session-item[data-id="${CSS.escape(rename.id)}"]`);
      if (row) mountRename(row);
      else rename = null;
    } else if (focusKey) byKey(focusKey)?.focus({ preventScroll: true });
    syncSpin();
  }

  function renderTree(): void {
    const all = metas();
    const currentId = d.currentId();
    rows = visibleRows(all, { currentId, status: statusOf, groupCollapsed, parentCollapsed: (id) => parentState.has(id) });
    const frag = document.createDocumentFragment();
    for (const r of rows) frag.appendChild(r.kind === 'group' ? groupEl(r) : sessionEl(r, currentId));
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = 'Sessions you start appear here.';
      frag.appendChild(empty);
    }
    list.appendChild(frag);
  }

  function groupEl(r: Extract<Row, { kind: 'group' }>): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'session-group' + (r.collapsed ? ' collapsed' : '');
    el.dataset.group = r.label;
    el.dataset.key = `g:${r.label}`;
    el.setAttribute('aria-expanded', String(!r.collapsed));
    el.setAttribute('aria-label', `${r.label}, ${r.sessions} session${r.sessions === 1 ? '' : 's'}${r.collapsed ? ', collapsed' : ''}`);
    el.innerHTML = `<span class="group-label">${escapeHtml(r.label)}</span><span class="group-chev">${icon('chevron-down', 12)}</span>`;
    return el;
  }

  function sessionEl(r: Extract<Row, { kind: 'session' }>, currentId: string): HTMLElement {
    const m = r.meta;
    const st = statusOf(m.id);
    const el = document.createElement('div');
    const active = m.id === currentId;
    el.className =
      'session-item' +
      (active ? ' active' : '') +
      (st.running ? ' running' : '') +
      (r.depth > 0 ? ' nested' : '') +
      (r.children ? ' has-children' : '') +
      (r.collapsed ? ' collapsed' : '') +
      (r.merged ? ' merged' : '') +
      (menuFor === m.id ? ' menu-open' : '');
    el.dataset.id = m.id;
    el.dataset.key = `s:${m.id}`;
    el.dataset.depth = String(r.depth);
    if (r.parentId) el.dataset.parent = r.parentId;
    el.style.setProperty('--indent', String(r.indent));
    el.setAttribute('role', 'button');
    if (active) el.setAttribute('aria-current', 'true');
    if (r.children) el.setAttribute('aria-expanded', String(!r.collapsed));
    let lines = '';
    for (const level of r.rails) lines += `<span class="tree-line rail" style="--level:${level}" aria-hidden="true"></span>`;
    if (r.depth > 0) lines += `<span class="tree-line elbow${r.last ? '' : ' more'}" style="--level:${r.indent}" aria-hidden="true"></span>`;
    const toggle = r.children
      ? `<button type="button" class="tree-toggle" tabindex="-1" aria-label="${r.collapsed ? 'Expand' : 'Collapse'}" data-tip="${r.collapsed ? 'Show' : 'Hide'} ${r.descendants} session${r.descendants === 1 ? '' : 's'}">${icon('chevron-down', 12)}</button>`
      : '';
    el.innerHTML =
      lines +
      leadHtml(m) +
      `<span class="label">${escapeHtml(m.title)}</span>${toggle}` +
      (r.merged ? '<span class="merged-tag" data-tip="Merged into its parent">merged</span>' : '') +
      `<span class="trail">${indicatorHtml(r.indicator)}<button type="button" class="icon-btn sm row-more" tabindex="-1" aria-label="Session actions" aria-haspopup="menu" data-tip="More">${icon('more')}</button></span>`;
    return el;
  }

  function renderResults(): void {
    const q = query();
    const all = metas();
    results = shapeResults(q, all, hits && hits.query === q ? hits.hits : null);
    const currentId = d.currentId();
    const frag = document.createDocumentFragment();
    for (const r of results) {
      const el = document.createElement('div');
      el.className = 'search-result' + (r.id === currentId ? ' active' : '');
      el.dataset.id = r.id;
      el.dataset.key = `r:${r.id}`;
      el.setAttribute('role', 'button');
      el.innerHTML =
        `<span class="result-head"><span class="result-title">${highlight(r.title, r.titleMatch)}</span><span class="result-date">${escapeHtml(shortDate(r.updatedAt))}</span></span>` +
        (r.snippet ? `<span class="result-snippet">${highlight(r.snippet.text, [r.snippet.start, r.snippet.end])}</span>` : '');
      frag.appendChild(el);
    }
    const pending = searching === q && q.length >= SEARCH_MIN;
    if (!results.length && !pending) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = has.search === false || q.length < SEARCH_MIN ? 'No session titles match.' : 'No sessions match.';
      frag.appendChild(empty);
    } else if (pending) {
      const note = document.createElement('div');
      note.className = 'session-empty searching';
      note.textContent = 'Searching conversations…';
      frag.appendChild(note);
    }
    list.appendChild(frag);
  }

  // Sidebar spinners turn on their own variable: the window's spin timer only runs while the session on screen does,
  // and a session running in the background must still look busy.
  let spinTimer: number | undefined;
  let spinStep = 0;
  function syncSpin(): void {
    const want = Boolean(list.querySelector('.session-item.running')) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (want && spinTimer === undefined) {
      spinTimer = window.setInterval(() => {
        spinStep = (spinStep + 1) % 12;
        const deg = `${spinStep * 30}deg`;
        list.querySelectorAll<HTMLElement>('.session-item .spinner').forEach((el) => el.style.setProperty('--side-spin', deg));
      }, 125);
    } else if (!want && spinTimer !== undefined) {
      window.clearInterval(spinTimer);
      spinTimer = undefined;
    }
  }

  // ---------- Inline rename (survives re-renders, e.g. the switch the first click of a double-click starts) ----------

  function mountRename(row: HTMLElement): void {
    if (!rename) return;
    const state = rename;
    const label = row.querySelector('.label');
    if (!label) return;
    row.classList.add('renaming');
    const field = document.createElement('input');
    field.className = 'rename-input';
    field.value = state.value;
    field.setAttribute('aria-label', 'Session title');
    field.spellcheck = false;
    label.replaceWith(field);
    row.querySelector('.trail')?.setAttribute('hidden', '');
    field.focus();
    if (state.fresh) field.select();
    state.fresh = false;
    const done = async (save: boolean) => {
      if (rename !== state) return;
      rename = null;
      const next = field.value.replace(/\s+/g, ' ').trim();
      const before = d.sessions().find((s) => s.id === state.id)?.title ?? '';
      render();
      const fresh = list.querySelector<HTMLElement>(`.session-item[data-id="${CSS.escape(state.id)}"]`);
      fresh?.focus({ preventScroll: true });
      if (save && next && next !== before) await d.rename(state.id, next, fresh ?? list);
    };
    field.addEventListener('input', () => (state.value = field.value));
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        void done(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void done(false);
      }
    });
    field.addEventListener('blur', () =>
      setTimeout(() => {
        if (field.isConnected) void done(true);
      }, 0),
    );
    field.addEventListener('click', (e) => e.stopPropagation());
    field.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  function startRename(id: string): void {
    const meta = d.sessions().find((s) => s.id === id);
    if (!meta) return;
    rename = { id, value: meta.title, fresh: true };
    render();
  }

  // ---------- Row actions ----------

  /** The session a row is nested under, when it is in the list */
  const parentMeta = (m: SessionMeta, all: SessionMeta[]) => {
    const pid = parentOf(m);
    return pid ? all.find((x) => x.id === pid) ?? null : null;
  };

  const rowFor = (id: string) => list.querySelector<HTMLElement>(`.session-item[data-id="${CSS.escape(id)}"]`);

  async function exportSession(m: SessionMeta): Promise<void> {
    try {
      const path = 'export' in mocks ? (mocks.export ?? null) : await rpc('history.export', m.id, 'markdown');
      if (path) d.flash(`Exported ${basename(path)}`);
    } catch (err) {
      d.showError(rowFor(m.id) ?? list, `Couldn't export: ${d.cleanError(err)}`);
    }
  }

  async function mergeSession(m: SessionMeta, into: SessionMeta): Promise<void> {
    const ok = await d.confirm({
      title: `Merge into "${into.title}"?`,
      description: `A summary of what "${m.title}" did since it split off is added to "${into.title}", and this session is marked merged. Both stay in the sidebar.`,
      confirmLabel: 'Merge',
      icon: 'git-merge',
    });
    if (!ok) return;
    let res: { ok: boolean; error?: string } | null = null;
    try {
      res = mocks.merge !== undefined && mocks.merge !== null ? mocks.merge : await rpc('sessions.merge', into.id, m.id);
    } catch (err) {
      d.showError(rowFor(m.id) ?? list, `Couldn't merge: ${d.cleanError(err)}`);
      return;
    }
    if (!res?.ok) {
      d.showError(rowFor(m.id) ?? list, `Couldn't merge: ${res?.error || 'the merge did not happen.'}`);
      return;
    }
    if (mocks.merge) overlay[m.id] = { ...overlay[m.id], mergedInto: into.id };
    await d.refresh();
    render();
  }

  function openRowMenu(m: SessionMeta, anchor: HTMLElement | { x: number; y: number }): void {
    const all = metas();
    const meta = all.find((x) => x.id === m.id) ?? m;
    menuFor = m.id;
    rowFor(m.id)?.classList.add('menu-open');
    // A running session is not forked, merged or deleted (stop it first); any other one can be, whatever else runs.
    const busy = statusOf(m.id).running;
    const parent = parentMeta(meta, all);
    const sections: MenuSection[] = [
      {
        items: [
          { label: 'Rename', icon: 'pencil', hint: 'F2', onSelect: () => startRename(m.id) },
          { label: 'Fork', icon: 'git-branch', disabled: busy, onSelect: () => void d.fork(m.id) },
        ],
      },
    ];
    const more: MenuSection = { items: [] };
    if (has.export || 'export' in mocks) more.items.push({ label: 'Export…', icon: 'file-export', description: 'Markdown', onSelect: () => void exportSession(meta) });
    if ((has.merge || mocks.merge) && parent && !meta.mergedInto) {
      const short = parent.title.length > 28 ? `${parent.title.slice(0, 27)}…` : parent.title;
      more.items.push({ label: `Merge into "${short}"`, icon: 'git-merge', disabled: busy || statusOf(parent.id).running, onSelect: () => void mergeSession(meta, parent) });
    }
    if (more.items.length) sections.push(more);
    sections.push({ items: [{ label: 'Delete', icon: 'trash', danger: true, disabled: busy, onSelect: () => void d.remove(m.id) }] });
    openMenu(sections, {
      anchor,
      placement: 'bottom-start',
      minWidth: 200,
      onClose: () => {
        if (menuFor === m.id) menuFor = '';
        rowFor(m.id)?.classList.remove('menu-open');
      },
    });
  }

  function toggleParent(id: string, collapsed?: boolean): void {
    const next = collapsed ?? !parentState.has(id);
    if (next === parentState.has(id)) return;
    setParent(id, next);
    render();
  }

  function toggleGroup(label: string, collapsed?: boolean): void {
    const next = collapsed ?? !groupCollapsed(label);
    if (next === groupCollapsed(label)) return;
    setGroup(label, next);
    render();
  }

  /** Expands the group and every parent on the way to a session so its row is visible. */
  function reveal(id: string): void {
    const all = metas();
    let changed = false;
    for (const a of ancestorsOf(all, id)) {
      if (parentState.has(a)) {
        setParent(a, false);
        changed = true;
      }
    }
    const g = groupOf(all, id);
    if (g && groupCollapsed(g)) {
      setGroup(g, false);
      changed = true;
    }
    if (changed) render();
  }

  // ---------- Events on the list ----------

  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.rename-input')) return;
    const group = t.closest<HTMLElement>('.session-group');
    if (group) return toggleGroup(group.dataset.group ?? '');
    const result = t.closest<HTMLElement>('.search-result');
    if (result) return void openResult(result.dataset.id ?? '');
    const row = t.closest<HTMLElement>('.session-item');
    if (!row) return;
    const id = row.dataset.id ?? '';
    if (t.closest('.tree-toggle')) {
      e.stopPropagation();
      return toggleParent(id);
    }
    const more = t.closest<HTMLElement>('.row-more');
    if (more) {
      e.stopPropagation();
      if (menuAnchoredTo(more)) return closeMenu();
      const m = metas().find((x) => x.id === id);
      if (m) openRowMenu(m, more);
      return;
    }
    void d.open(id);
  });
  list.addEventListener('dblclick', (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('.session-item');
    if (!row || t.closest('.row-more, .rename-input, .tree-toggle')) return;
    e.preventDefault();
    startRename(row.dataset.id ?? '');
  });
  list.addEventListener('contextmenu', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.session-item');
    if (!row || (e.target as HTMLElement).closest('.rename-input')) return;
    e.preventDefault();
    const m = metas().find((x) => x.id === row.dataset.id);
    if (m) openRowMenu(m, { x: e.clientX, y: e.clientY });
  });
  list.addEventListener('focusin', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.session-group, .session-item, .search-result');
    if (!el) return;
    for (const other of focusables()) other.tabIndex = other === el ? 0 : -1;
  });
  list.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if (!el.matches('.session-group, .session-item, .search-result')) return;
    const all = focusables();
    const i = all.indexOf(el);
    const go = (n: HTMLElement | undefined | null) => {
      if (!n) return;
      e.preventDefault();
      n.focus();
      n.scrollIntoView({ block: 'nearest' });
    };
    const id = el.dataset.id ?? '';
    const isGroup = el.classList.contains('session-group');
    const isParent = el.classList.contains('has-children');
    const collapsed = el.classList.contains('collapsed');
    switch (e.key) {
      case 'ArrowDown':
        return go(all[i + 1]);
      case 'ArrowUp':
        if (i === 0 && searchOpen) {
          e.preventDefault();
          return input.focus();
        }
        return go(all[i - 1]);
      case 'Home':
        return go(all[0]);
      case 'End':
        return go(all[all.length - 1]);
      case 'ArrowLeft':
        e.preventDefault();
        if (isGroup) return toggleGroup(el.dataset.group ?? '', true);
        if (isParent && !collapsed) return toggleParent(id, true);
        if (el.dataset.parent) return go(rowFor(el.dataset.parent));
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (isGroup) return toggleGroup(el.dataset.group ?? '', false);
        if (isParent && collapsed) return toggleParent(id, false);
        if (isParent) return go(all[i + 1]);
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (isGroup) return toggleGroup(el.dataset.group ?? '');
        if (el.classList.contains('search-result')) return void openResult(id);
        return void d.open(id);
      case 'F2':
        if (isGroup || el.classList.contains('search-result')) return;
        e.preventDefault();
        e.stopPropagation();
        return startRename(id);
      case 'ContextMenu': {
        const m = metas().find((x) => x.id === id);
        if (!m || isGroup) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        return openRowMenu(m, { x: r.left + 24, y: r.bottom });
      }
      case 'Escape':
        if (searchOpen) {
          e.preventDefault();
          e.stopPropagation();
          input.focus();
        }
        return;
    }
  });

  // ---------- Search ----------

  function openSearch(): void {
    d.expand();
    if (!searchOpen) {
      searchOpen = true;
      searchRow.hidden = true;
      searchField.hidden = false;
    }
    input.focus();
    input.select();
    render();
  }

  function closeSearch(focusComposer = true): void {
    if (!searchOpen) return;
    searchOpen = false;
    input.value = '';
    hits = null;
    searching = '';
    window.clearTimeout(searchTimer);
    searchField.hidden = true;
    searchRow.hidden = false;
    clearBtn.hidden = true;
    render();
    if (focusComposer) d.focusComposer();
  }

  async function runSearch(q: string): Promise<void> {
    const my = ++searchSeq;
    let found: SearchHit[] = [];
    try {
      if (mocks.search) found = mocks.search.slice();
      else if (has.search !== false) found = await rpc('history.search', q, { limit: 40 });
    } catch (err) {
      if (absent(err)) has.search = false;
    }
    if (my !== searchSeq || query() !== q) return;
    if (!mocks.search && has.search === null) has.search = true;
    hits = { query: q, hits: Array.isArray(found) ? found : [] };
    searching = '';
    render();
  }

  function onQuery(): void {
    const q = query();
    clearBtn.hidden = !input.value;
    window.clearTimeout(searchTimer);
    searchSeq++;
    if (q.length >= SEARCH_MIN && (has.search !== false || mocks.search)) {
      searching = q;
      searchTimer = window.setTimeout(() => void runSearch(q), SEARCH_DELAY);
    } else searching = '';
    render();
  }

  function openResult(id: string): Promise<unknown> | void {
    if (!id) return;
    return d.open(id);
  }

  searchRow.addEventListener('click', () => openSearch());
  input.addEventListener('input', onQuery);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (input.value) {
        input.value = '';
        onQuery();
      } else closeSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = list.querySelector<HTMLElement>('.search-result, .session-group, .session-item');
      first?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = list.querySelector<HTMLElement>('.search-result');
      if (first) void openResult(first.dataset.id ?? '');
    }
  });
  // An empty field gives the row back once the focus leaves the search (not when it moves into the results).
  input.addEventListener('blur', () =>
    setTimeout(() => {
      if (searchOpen && !input.value && !searchField.contains(document.activeElement) && !list.contains(document.activeElement)) closeSearch(false);
    }, 0),
  );
  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    input.value = '';
    onQuery();
    input.focus();
  });

  // ---------- Navigation rows and footer ----------

  scheduledRow.addEventListener('click', () => d.openPage('scheduled'));
  customizeRow.addEventListener('click', () => d.openSettings('mods'));
  dreamingRow.addEventListener('click', () => d.openPage('dreaming'));
  /** The row of the page in the main column shows selected, like a session on screen */
  function syncNav(): void {
    const page = d.page();
    for (const [row, id] of [[scheduledRow, 'scheduled'], [dreamingRow, 'dreaming']] as const) {
      row.classList.toggle('active', page === id);
      if (page === id) row.setAttribute('aria-current', 'page');
      else row.removeAttribute('aria-current');
    }
  }
  /** A quiet dot on the row while a dream's proposals wait for the user */
  const syncDreaming = (s: { waiting?: number } | null | undefined) => {
    const n = Number(s?.waiting) || 0;
    dreamingDot.hidden = n === 0;
    dreamingRow.setAttribute('aria-label', n ? `Dreaming, ${n} suggestion${n === 1 ? '' : 's'} waiting` : 'Dreaming');
    dreamingRow.dataset.tip = n ? `${n} suggestion${n === 1 ? '' : 's'} waiting for you` : '';
    if (!n) delete dreamingRow.dataset.tip;
  };
  onPush('dreaming:changed', syncDreaming);
  modelChip.addEventListener('click', () => d.openSettings('model'));

  const syncModel = (c: AppConfig) => {
    if (!c) return;
    const p = activeProvider(c);
    const text = `${p.model || 'No model'} · ${p.label}`;
    modelLabel.textContent = text;
    modelChip.setAttribute('aria-label', `Model: ${text}. Open model settings`);
    modelChip.dataset.tip = text;
  };
  bus.on('config', syncModel);

  // Rows whose target is not in this build stay hidden.
  void probe(() => rpc('schedules.list')).then((ok) => (scheduledRow.hidden = !ok));
  void probe(() => rpc('mods.list')).then((ok) => (customizeRow.hidden = !ok));
  void rpc('dreaming.get').then(
    (s) => {
      dreamingRow.hidden = false;
      syncDreaming(s);
    },
    (err) => (dreamingRow.hidden = absent(err)),
  );
  void probe(() => rpc('history.stats')).then((ok) => (has.export = ok));

  // A session brought on screen (a fork from the menu, a notification, a search result) is shown where it sits; the
  // first one at start-up is not, so a collapsed family stays collapsed across launches.
  let shown = 0;
  bus.on('session-shown', (id) => {
    if (shown++ > 0) reveal(id);
    else render();
  });

  return {
    render,
    openSearch,
    startRename,
    debug: {
      mock(m: SidebarMocks | null) {
        if (!m) mocks = {};
        else {
          const next: SidebarMocks = { ...mocks };
          for (const k of Object.keys(m) as (keyof SidebarMocks)[]) {
            if (m[k] === null && k !== 'export') delete next[k];
            else (next as Record<string, unknown>)[k] = m[k];
          }
          mocks = next;
        }
        for (const k of Object.keys(overlay)) delete overlay[k];
        hits = null;
        if (searchOpen && query()) onQuery();
        else render();
      },
      state() {
        const out = [...list.querySelectorAll<HTMLElement>('.session-group, .session-item, .search-result, .session-empty')].map((el) => {
          if (el.classList.contains('session-group')) return { kind: 'group', label: el.dataset.group, collapsed: el.classList.contains('collapsed') };
          if (el.classList.contains('session-empty')) return { kind: 'empty', text: el.textContent };
          if (el.classList.contains('search-result'))
            return { kind: 'result', id: el.dataset.id, title: el.querySelector('.result-title')?.textContent, snippet: el.querySelector('.result-snippet')?.textContent ?? null, mark: el.querySelector('mark')?.textContent ?? null };
          return {
            kind: 'session',
            id: el.dataset.id,
            title: el.querySelector('.label')?.textContent,
            depth: Number(el.dataset.depth),
            parent: el.dataset.parent ?? null,
            collapsed: el.classList.contains('collapsed'),
            merged: el.classList.contains('merged'),
            lead: el.querySelector('.lead.schedule') ? 'schedule' : el.querySelector('.lead.dream') ? 'dream' : null,
            indicator: el.querySelector('.trail-meta .spinner') ? 'running' : el.querySelector('.status-dot.attention') ? 'attention' : el.querySelector('.status-dot.unread') ? 'unread' : el.querySelector('.trail-meta.family') ? 'family' : el.querySelector('.trail-meta.kind') ? 'kind' : null,
            count: el.querySelector('.family-count')?.textContent ?? null,
          };
        });
        return { search: searchOpen ? query() : null, has: { ...has }, rows: out };
      },
      resetCollapse() {
        groupState = {};
        parentState = new Set();
        writeJson(GROUPS_KEY, groupState);
        writeJson(PARENTS_KEY, []);
        render();
      },
    },
  };
}
