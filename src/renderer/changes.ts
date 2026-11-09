// Diff pane: the files changed in this session (oc.changes) as a list, and the selected file's diff.

import type { ChangeDiff, ChangeEntry, ChangesApi } from '../shared/types';
import { basename, dirname, escapeHtml } from './dom.js';
import { lineDiff, numberRows, renderDiff, statHtml, type DiffRow } from './diff.js';
import { icon, type IconName } from './icons.js';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel: string;
  /** Red confirm button, the warning triangle, and Cancel has the focus; otherwise the accent button has it */
  danger?: boolean;
  /** The badge's icon when not danger (default info) */
  icon?: IconName;
  /**
   * A text block between the title and the description, e.g. the line a "#" message adds (labelled with the file,
   * in mono) or the message a rewind returns to
   */
  quote?: { text: string; label?: string; mono?: boolean };
}

export interface ChangesPaneOptions {
  root: HTMLElement;
  list: HTMLElement;
  detail: HTMLElement;
  empty: HTMLElement;
  /** The change tracker, or null when the running app does not have one yet */
  source: () => ChangesApi | null;
  onCount: (count: number) => void;
  onError: (anchor: HTMLElement, message: string) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  cleanError: (err: unknown) => string;
  /** Called after a file was reverted on disk */
  onReverted?: (entry: ChangeEntry) => void;
}

export interface ChangesPane {
  /** Reloads the list (and the selected diff when the pane is visible) */
  refresh(): Promise<void>;
  setVisible(visible: boolean): void;
  /** A changes_updated event: update the count, and refresh soon if visible (showing the pane always refreshes) */
  updated(count: number): void;
  /** Session switched: forget the selection and reload */
  reset(): void;
  count(): number;
}

const STATUS_WORD: Record<ChangeEntry['status'], string> = { added: 'Added', modified: 'Modified', deleted: 'Deleted' };
const MAX_ROWS = 3000;

function linesOf(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

function diffRows(d: ChangeDiff): DiffRow[] {
  if (d.status === 'added') return d.current ? numberRows(linesOf(d.current).map((t) => ({ kind: 'add' as const, text: t })), 1) : [];
  if (d.status === 'deleted') return d.original ? numberRows(linesOf(d.original).map((t) => ({ kind: 'del' as const, text: t })), 1) : [];
  const a = d.original.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const b = d.current.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return numberRows(lineDiff(a, b), 1);
}

export function createChangesPane(o: ChangesPaneOptions): ChangesPane {
  let entries: ChangeEntry[] = [];
  let selected: string | null = null;
  let visible = false;
  let total = 0;
  let unavailable: string | null = null;
  let listToken = 0;
  let diffToken = 0;
  let refreshTimer: number | undefined;
  let busy = false;

  const setCount = (n: number) => {
    total = n;
    o.onCount(n);
  };

  function renderEmpty(): void {
    const note = unavailable ? `<p class="changes-note">${escapeHtml(unavailable)}</p>` : '';
    o.empty.innerHTML = `<span class="changes-empty-icon">${icon('file-diff', 20)}</span><p>No changes yet</p>${note}`;
  }

  function renderList(): void {
    const empty = !entries.length;
    o.root.classList.toggle('is-empty', empty);
    o.empty.hidden = !empty;
    o.list.hidden = empty;
    o.detail.hidden = empty;
    if (empty) {
      renderEmpty();
      o.list.innerHTML = '';
      o.detail.innerHTML = '';
      return;
    }
    const head = `<div class="change-list-head">${entries.length} changed file${entries.length === 1 ? '' : 's'}</div>`;
    const rows = entries
      .map((e) => {
        const dir = dirname(e.relPath).replace(/\/$/, '');
        const active = e.path === selected;
        const stat = e.additions || e.deletions ? statHtml(e.additions, e.deletions) : '';
        return (
          `<button type="button" class="change-item ${e.status}${active ? ' active' : ''}" role="option" aria-selected="${active}" data-path="${escapeHtml(e.path)}" title="${escapeHtml(
            `${e.relPath} · ${STATUS_WORD[e.status]}${e.source === 'git' ? ' (seen by git)' : ''}`,
          )}">` +
          `<span class="change-dot" aria-hidden="true"></span>` +
          `<span class="change-name"><span class="change-base">${escapeHtml(basename(e.relPath))}</span>${dir ? `<span class="change-dir">${escapeHtml(dir)}</span>` : ''}</span>` +
          (e.source === 'git' ? '<span class="change-tag">git</span>' : '') +
          (stat ? `<span class="change-stat">${stat}</span>` : '') +
          `</button>`
        );
      })
      .join('');
    o.list.innerHTML = head + rows;
  }

  function detailHead(e: ChangeEntry): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'change-actions';
    actions.innerHTML =
      `<button type="button" id="change-revert" class="btn sm" data-tip="Restore the original">${icon('undo', 14)}<span>Revert</span></button>` +
      `<button type="button" id="change-open" class="btn sm" data-tip="Open with the default app"${e.status === 'deleted' ? ' disabled' : ''}>${icon('external-link', 14)}<span>Open in editor</span></button>`;
    actions.querySelector<HTMLButtonElement>('#change-revert')!.onclick = (ev) => void revert(e, ev.currentTarget as HTMLElement);
    actions.querySelector<HTMLButtonElement>('#change-open')!.onclick = (ev) => void openInEditor(e, ev.currentTarget as HTMLElement);
    return actions;
  }

  function kindTag(e: ChangeEntry): string {
    return e.status === 'modified' ? '' : `<span class="change-kind ${e.status}">${STATUS_WORD[e.status]}</span>`;
  }

  /** Header-only diff shell with a message body (loading, binary, errors). */
  function shell(e: ChangeEntry, message: string, cls = ''): HTMLElement {
    const el = renderDiff(e.relPath, [], { className: 'fill' });
    const stat = el.querySelector('.diff-stat')!;
    stat.innerHTML = e.additions || e.deletions ? statHtml(e.additions, e.deletions) : '';
    stat.insertAdjacentHTML('beforebegin', kindTag(e));
    el.querySelector('.diff-head')!.appendChild(detailHead(e));
    el.querySelector('.diff-body')!.innerHTML = `<div class="diff-note${cls ? ` ${cls}` : ''}">${message}</div>`;
    return el;
  }

  async function loadDiff(): Promise<void> {
    const e = entries.find((x) => x.path === selected);
    const token = ++diffToken;
    if (!e) {
      o.detail.innerHTML = '';
      return;
    }
    const api = o.source();
    if (!api) return;
    // Keep the old diff on screen while a refresh of the same file loads; show a placeholder for a new file.
    if (o.detail.dataset.path !== e.path) {
      o.detail.dataset.path = e.path;
      o.detail.replaceChildren(shell(e, '<span class="spinner sm"></span><span>Loading diff…</span>'));
    }
    let d: ChangeDiff;
    try {
      d = await api.diff(e.path);
    } catch (err) {
      if (token !== diffToken) return;
      o.detail.replaceChildren(shell(e, `${icon('circle-alert', 14)}<span>Couldn't load the diff: ${escapeHtml(o.cleanError(err))}</span>`, 'error'));
      return;
    }
    if (token !== diffToken || selected !== e.path) return;
    const body = o.detail.querySelector('.diff-body');
    const scroll = o.detail.dataset.path === e.path && body ? body.scrollTop : 0;
    let el: HTMLElement;
    if (d.binary) el = shell(e, `${icon('info', 14)}<span>Binary file, no text diff</span>`);
    else {
      const rows = diffRows(d);
      const changed = rows.some((r) => r.kind !== 'ctx');
      if (!rows.length || (!changed && d.status === 'modified')) {
        el = shell(e, `${icon('info', 14)}<span>${!rows.length ? 'Empty file.' : 'Only whitespace or line endings changed.'}</span>`);
      } else {
        el = renderDiff(e.relPath, rows, { className: 'fill', context: d.status === 'modified' ? 3 : undefined, limit: MAX_ROWS });
        el.querySelector('.diff-stat')!.insertAdjacentHTML('beforebegin', kindTag(e));
        el.querySelector('.diff-head')!.appendChild(detailHead(e));
      }
    }
    o.detail.dataset.path = e.path;
    o.detail.replaceChildren(el);
    const nb = el.querySelector('.diff-body');
    if (nb && scroll) nb.scrollTop = scroll;
  }

  async function refresh(): Promise<void> {
    const api = o.source();
    const token = ++listToken;
    if (!api) {
      unavailable = 'Restart Silo Harness to turn on change tracking.';
      entries = [];
      setCount(0);
      renderList();
      return;
    }
    let list: ChangeEntry[];
    try {
      list = await api.list();
    } catch (err) {
      if (token !== listToken) return;
      unavailable = `Couldn't list changes: ${o.cleanError(err)}`;
      entries = [];
      setCount(0);
      renderList();
      return;
    }
    if (token !== listToken) return;
    unavailable = null;
    applyList(Array.isArray(list) ? list : []);
  }

  function applyList(list: ChangeEntry[], preferIndex?: number): void {
    entries = list;
    setCount(list.length);
    if (!list.some((e) => e.path === selected)) {
      selected = list.length ? list[Math.max(0, Math.min(preferIndex ?? 0, list.length - 1))].path : null;
    }
    renderList();
    if (visible) void loadDiff();
    else o.detail.dataset.path = '';
  }

  function select(path: string, focus = false): void {
    if (path === selected) return;
    selected = path;
    o.list.querySelectorAll<HTMLElement>('.change-item').forEach((el) => {
      const on = el.dataset.path === path;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on && focus) {
        el.focus();
        el.scrollIntoView({ block: 'nearest' });
      }
    });
    void loadDiff();
  }

  async function revert(e: ChangeEntry, anchor: HTMLElement): Promise<void> {
    if (busy) return;
    const ok = await o.confirm({
      title: `Revert ${e.relPath}?`,
      description: e.status === 'added' ? 'This deletes the new file and cannot be undone.' : 'This restores the original and cannot be undone.',
      confirmLabel: 'Revert',
      danger: true,
    });
    if (!ok) return;
    const api = o.source();
    if (!api) return;
    busy = true;
    const index = entries.findIndex((x) => x.path === e.path);
    try {
      const list = await api.revert(e.path);
      if (selected === e.path) selected = null;
      o.onReverted?.(e);
      ++listToken;
      applyList(Array.isArray(list) ? list : [], index);
    } catch (err) {
      o.onError(document.getElementById('change-revert') ?? anchor, `Couldn't revert: ${o.cleanError(err)}`);
    } finally {
      busy = false;
    }
  }

  async function openInEditor(e: ChangeEntry, anchor: HTMLElement): Promise<void> {
    const api = o.source();
    try {
      if (!api || typeof api.openInEditor !== 'function') throw new Error('No handler registered');
      await api.openInEditor(e.path);
    } catch (err) {
      o.onError(anchor, `Couldn't open the file: ${o.cleanError(err)}`);
    }
  }

  o.list.addEventListener('click', (ev) => {
    const item = (ev.target as HTMLElement).closest<HTMLElement>('.change-item');
    if (item?.dataset.path) select(item.dataset.path);
  });
  o.list.addEventListener('keydown', (ev) => {
    const items = [...o.list.querySelectorAll<HTMLElement>('.change-item')];
    if (!items.length) return;
    const at = items.findIndex((el) => el.dataset.path === selected);
    let next = -1;
    if (ev.key === 'ArrowDown') next = Math.min(items.length - 1, at + 1);
    else if (ev.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = items.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    select(items[next].dataset.path!, true);
    items[next].focus();
  });

  renderEmpty();

  return {
    refresh,
    setVisible(v: boolean) {
      if (v === visible) return;
      visible = v;
      if (v) void refresh();
    },
    updated(count: number) {
      if (Number.isFinite(count)) setCount(count);
      if (!visible) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refresh(), 120);
    },
    reset() {
      selected = null;
      o.detail.dataset.path = '';
      void refresh();
    },
    count: () => total,
  };
}

/** An in-memory change source for the debug hook (screenshots without a live change tracker). */
export function mockChangesSource(list: ChangeEntry[], diffs: Record<string, Partial<ChangeDiff>> = {}): ChangesApi {
  let items = [...list];
  return {
    list: async () => items,
    diff: async (path: string) => {
      const e = items.find((x) => x.path === path);
      if (!e) throw new Error(`Not a changed file: ${path}`);
      return { ...e, original: '', current: '', ...diffs[path] };
    },
    revert: async (path: string) => {
      items = items.filter((x) => x.path !== path);
      return items;
    },
    openInEditor: async () => undefined,
  };
}
