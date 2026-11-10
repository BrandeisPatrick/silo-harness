// The agent's task list (the update_tasks tool, tasks_updated events, SessionMeta.tasks): a card in the conversation,
// always last, under the newest message. No header and no counts: one row per task, to do (a dashed circle), in
// progress (a spinner arc during a run, a paused circle otherwise) or done (a filled tick, muted). Rows are keyed by
// task id and updated in place, so a status change only touches its own row. Also: the rows as a static snapshot,
// for update_tasks rows in the transcript (those keep their own glyphs, see taskGlyph).

import type { TaskItem } from '../shared/types';
import { icon } from './icons.js';

type Status = TaskItem['status'];

const STATUSES = new Set<Status>(['pending', 'in_progress', 'completed']);
const STATUS_LABEL: Record<Status, string> = { pending: 'To do', in_progress: 'In progress', completed: 'Done' };

/** A well-formed list from whatever arrived: items need a title, ids are made unique, unknown statuses count as pending. */
export function cleanTasks(list: unknown): TaskItem[] {
  if (!Array.isArray(list)) return [];
  const out: TaskItem[] = [];
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const t = raw as Record<string, unknown>;
    const title = typeof t.title === 'string' ? t.title.replace(/\s+/g, ' ').trim() : '';
    if (!title) return;
    let id = typeof t.id === 'string' || typeof t.id === 'number' ? String(t.id).trim() : '';
    if (!id) id = `t${i + 1}`;
    while (seen.has(id)) id += '_';
    seen.add(id);
    out.push({ id, title, status: STATUSES.has(t.status as Status) ? (t.status as Status) : 'pending' });
  });
  return out;
}

/** "2 of 5 done" */
export function taskProgress(tasks: TaskItem[]): string {
  return `${tasks.filter((t) => t.status === 'completed').length} of ${tasks.length} done`;
}

/** The snapshot's glyph (update_tasks rows): an empty circle, a filled arrow, or a circle with a tick. */
export function taskGlyph(status: Status): string {
  if (status === 'completed') return icon('circle-check', 14);
  if (status === 'in_progress') return `<span class="spinner sm" aria-hidden="true"></span>${icon('arrow-filled', 14)}`;
  return icon('circle', 14);
}

/**
 * The card's glyph: to do a dashed circle, done a filled circle with a tick. In progress carries two, and tasks.css
 * shows one: the spinner arc while a run goes on (the card is .live), a paused circle otherwise.
 */
export function cardGlyph(status: Status): string {
  if (status === 'completed') return icon('circle-check-filled', 16);
  if (status === 'in_progress') return `<span class="spinner sm" aria-hidden="true"></span>${icon('circle-pause', 16)}`;
  return icon('circle-dashed', 16);
}

type Glyph = (status: Status) => string;

/** `paused`: no run is going on, so a row in progress reads "Paused" */
function fillRow(el: HTMLElement, t: TaskItem, glyph: Glyph, paused = false): void {
  if (el.dataset.status !== t.status) {
    el.dataset.status = t.status;
    el.querySelector('.task-glyph')!.innerHTML = glyph(t.status);
  }
  const title = el.querySelector<HTMLElement>('.task-title')!;
  if (title.textContent !== t.title) {
    title.textContent = t.title;
    title.title = t.title;
  }
  el.setAttribute('aria-label', `${paused && t.status === 'in_progress' ? 'Paused' : STATUS_LABEL[t.status]}: ${t.title}`);
}

function createRow(t: TaskItem, glyph: Glyph, paused = false): HTMLLIElement {
  const el = document.createElement('li');
  el.className = 'task-row';
  el.dataset.id = t.id;
  el.innerHTML = '<span class="task-glyph" aria-hidden="true"></span><span class="task-title"></span>';
  fillRow(el, t, glyph, paused);
  return el;
}

/** The rows as they stood at one update_tasks call (for that call's row in the transcript). */
export function taskSnapshot(tasks: TaskItem[]): HTMLElement {
  const list = document.createElement('ol');
  list.className = 'task-rows task-snapshot';
  for (const t of tasks) list.appendChild(createRow(t, taskGlyph));
  if (!tasks.length) list.innerHTML = '<li class="task-row task-empty">The task list was cleared.</li>';
  return list;
}

export interface TaskListOptions {
  /** #task-list: the card itself (the rows go inside it) */
  root: HTMLElement;
  /**
   * The transcript the card lives in (#messages). The card is a child of it only while it has rows, right after
   * `after` (#empty-state), and tasks.css puts it last with `order`: it shows under the newest message without ever
   * being the node a new one is appended after (code that looks at previousElementSibling, like tool grouping, never
   * meets it). Clearing the transcript removes it; it comes back by itself while it has rows.
   */
  home: HTMLElement;
  after?: HTMLElement | null;
  /** The card was shown, hidden or got other rows (its height may have changed) */
  onChange?: () => void;
}

export interface TaskList {
  /** Shows the list; an empty list (or null) hides the card. Rows are reused by id, so nothing else re-renders. */
  set(tasks: TaskItem[] | null): void;
  /** A run is going on (the card is .live: a row in progress spins) or not (it shows as paused) */
  setRunning(running: boolean): void;
  /** The tasks shown */
  items(): TaskItem[];
}

export function createTaskList(o: TaskListOptions): TaskList {
  const root = o.root;
  root.innerHTML = '<ol class="task-rows" aria-label="Tasks"></ol>';
  const rowsEl = root.querySelector<HTMLElement>('.task-rows')!;
  const rows = new Map<string, HTMLLIElement>();
  let items: TaskItem[] = [];
  let running = false;

  /** In the transcript while there are rows, out of it otherwise (so an empty transcript stays empty). */
  const place = () => {
    if (!items.length) {
      if (root.parentNode) root.remove();
      return;
    }
    if (root.parentNode === o.home) return;
    const after = o.after && o.after.parentNode === o.home ? o.after : null;
    o.home.insertBefore(root, after ? after.nextSibling : o.home.firstChild);
  };
  // Clearing the transcript (a switch, a rewind, a compaction) removes every child but the empty state.
  new MutationObserver(() => {
    if (items.length && root.parentNode !== o.home) {
      place();
      o.onChange?.();
    }
  }).observe(o.home, { childList: true });

  const list: TaskList = {
    set(next: TaskItem[] | null) {
      const wasShown = root.parentNode === o.home && !root.hidden;
      items = cleanTasks(next);
      root.hidden = items.length === 0;
      root.classList.toggle('all-done', items.length > 0 && items.every((t) => t.status === 'completed'));
      // Rows that are gone go; the rest are updated where they are and moved only when the order changed.
      const ids = new Set(items.map((t) => t.id));
      for (const [id, el] of rows) {
        if (ids.has(id)) continue;
        el.remove();
        rows.delete(id);
      }
      let prev: HTMLElement | null = null;
      for (const t of items) {
        let el = rows.get(t.id);
        if (el) fillRow(el, t, cardGlyph, !running);
        else {
          el = createRow(t, cardGlyph, !running);
          // New rows of a card already on screen fade in (once: a row moved later must not replay it); a card that
          // just appeared comes in as one.
          if (wasShown) {
            const row = el;
            row.classList.add('fade-in');
            row.addEventListener('animationend', () => row.classList.remove('fade-in'), { once: true });
          }
          rows.set(t.id, el);
        }
        const want: Element | null = prev ? prev.nextElementSibling : rowsEl.firstElementChild;
        if (want !== el) rowsEl.insertBefore(el, want);
        prev = el;
      }
      if (!wasShown && items.length) root.classList.add('fade-in');
      place();
      o.onChange?.();
    },
    setRunning(next: boolean) {
      if (next === running) return;
      running = next;
      root.classList.toggle('live', running);
      for (const t of items) {
        const el = rows.get(t.id);
        if (el) fillRow(el, t, cardGlyph, !running);
      }
    },
    items: () => items.map((t) => ({ ...t })),
  };

  root.hidden = true;
  root.addEventListener('animationend', (e) => {
    if (e.target === root) root.classList.remove('fade-in');
  });
  place();
  return list;
}

/** The update_tasks row's argument: the task in progress, else "all done" or "cleared" (else nothing; the meta has the count). */
export function taskSummary(tasks: TaskItem[]): string {
  if (!tasks.length) return 'cleared';
  const active = tasks.find((t) => t.status === 'in_progress');
  if (active) return active.title;
  return tasks.every((t) => t.status === 'completed') ? 'all done' : '';
}
