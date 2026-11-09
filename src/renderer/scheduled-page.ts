// The Scheduled tasks pages: the list (Yours | Templates, search, filter, sort, New task), a task's own page (Run now,
// Active, its History of runs, each opening its session, and what it does, where and how), and the New / Edit task
// dialog. The data is the schedules service's (schedules.*); the pure words are in pages-model.ts.

import type { AppConfig, SessionMeta, SessionStatus } from '../shared/types';
import type { Schedule, ScheduleInput, SchedulePatch } from '../shared/schedules';
import type { ConfirmOptions } from './changes.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { onPush, rpc } from './rpc.js';
import { bus } from './bus.js';
import { tilde } from './home.js';
import { MODES } from './modes.js';
import { openMenu } from './popover.js';
import { formatWhenAt } from './settings/model.js';
import { banner, choiceMenu, keepFocus, pageHead, pageTabs, toolIcon, type PageHandle, type PageHost, type PageRoute } from './pages.js';
import {
  DAY_NAMES,
  RHYTHM_KINDS,
  RUN_WORDS,
  TASK_FILTERS,
  TASK_SORTS,
  TEMPLATES,
  folderName,
  fullRhythm,
  nextRunWords,
  rhythmToWhen,
  rhythmWords,
  runState,
  shownTasks,
  targetWords,
  taskFooter,
  taskRuns,
  taskState,
  whenToRhythm,
  type Rhythm,
  type RhythmKind,
  type RunState,
  type TaskFilter,
  type TaskSort,
  type TaskTemplate,
} from './pages-model.js';

export interface ScheduledDeps {
  sessions(): SessionMeta[];
  status(id: string): SessionStatus;
  /** Brings a session on screen in the chat view (the page closes) */
  openSession(id: string): void;
  currentSessionId(): string;
  config(): AppConfig;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  cleanError(err: unknown): string;
  showError(anchor: HTMLElement, message: string): void;
}

export interface ScheduledPage {
  render(route: PageRoute, root: HTMLElement, host: PageHost): PageHandle | null;
  /** The New task dialog, empty, from a template, or editing a task */
  openForm(opts?: { template?: string; edit?: string }): void;
  /** Whether the feature is in this build (null until the first answer) */
  present(): boolean | null;
  debug: { state(): unknown };
}

const BANNER = 'Scheduled tasks run only while Silo Harness is open and your Mac is awake. A run missed while it was closed or asleep happens once when it is back, if it was due less than a day before.';
const PREFS_KEY = 'pages.scheduled';

/** A schedule error from the main process without its code ("bad_time: …" → "…") */
const plain = (msg: string) => {
  const m = msg.replace(/^[a-z_]+: /, '');
  return m.charAt(0).toUpperCase() + m.slice(1);
};

function readPrefs(): { filter: TaskFilter; sort: TaskSort } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as { filter?: string; sort?: string };
    return { filter: TASK_FILTERS.some((f) => f.value === p.filter) ? (p.filter as TaskFilter) : 'all', sort: TASK_SORTS.some((s) => s.value === p.sort) ? (p.sort as TaskSort) : 'next' };
  } catch {
    return { filter: 'all', sort: 'next' };
  }
}

export function createScheduledPage(d: ScheduledDeps): ScheduledPage {
  let tasks: Schedule[] | null = null;
  let absent: boolean | null = null;
  const prefs = readPrefs();
  let filter: TaskFilter = prefs.filter;
  let sort: TaskSort = prefs.sort;
  let query = '';
  let searchOpen = false;
  /** The mounted page, re-rendered when its data changes */
  let mounted: { route: PageRoute; update(): void } | null = null;
  let pendingForm: { template?: string; edit?: string } | null = null;

  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ filter, sort }));
    } catch {
      /* not remembered */
    }
  };

  const adopt = (list: Schedule[] | null | undefined) => {
    if (!Array.isArray(list)) return;
    tasks = list;
    absent = false;
    mounted?.update();
  };
  const load = async () => {
    try {
      adopt(await rpc('schedules.list'));
    } catch (err) {
      absent = /Unknown RPC method|No handler registered/i.test(String(err instanceof Error ? err.message : err));
      tasks = tasks ?? [];
      mounted?.update();
    }
  };
  onPush('schedules:changed', adopt);
  // Run rows follow their sessions (running, waiting for you, a new title)
  bus.on('sessions', () => {
    if (mounted?.route.page === 'task') mounted.update();
  });
  void load();

  const sessionTitle = (id: string) => d.sessions().find((s) => s.id === id)?.title;

  // ---------- The list ----------

  function renderList(route: Extract<PageRoute, { page: 'scheduled' }>, root: HTMLElement, host: PageHost): PageHandle {
    let tab: 'yours' | 'templates' = route.tab ?? 'yours';
    const col = h('div', { class: 'pg-col pg-list', 'data-list': 'scheduled' });
    root.append(col);

    function draw(): void {
      col.innerHTML = '';
      col.append(pageHead('Scheduled tasks'));
      const tabs = pageTabs('Scheduled tasks', [{ value: 'yours', label: 'Yours' }, { value: 'templates', label: 'Templates' }], tab, (v) => {
        tab = v;
        keepFocus(col, draw);
        col.querySelector<HTMLElement>(`.pg-tab[data-tab="${v}"]`)?.focus();
      });
      const tools = h('div', { class: 'pg-tools' });
      if (tab === 'yours') {
        if (searchOpen) {
          const field = h('input', { type: 'search', class: 'pg-search-input', id: 'task-search', placeholder: 'Search tasks', 'aria-label': 'Search tasks', spellcheck: 'false', autocomplete: 'off', value: query }) as HTMLInputElement;
          field.addEventListener('input', () => {
            query = field.value;
            drawGrid();
          });
          field.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            query = '';
            searchOpen = false;
            draw();
            col.querySelector<HTMLElement>('#task-search-btn')?.focus();
          });
          field.addEventListener('blur', () =>
            setTimeout(() => {
              if (!query && searchOpen && field.isConnected && !col.contains(document.activeElement)) {
                searchOpen = false;
                draw();
              }
            }, 0),
          );
          tools.append(h('label', { class: 'pg-search' }, h('span', { class: 'pg-search-icon', html: icon('search', 14) }), field));
        } else
          tools.append(
            toolIcon('search', 'Search tasks', () => {
              searchOpen = true;
              draw();
              col.querySelector<HTMLInputElement>('#task-search')?.focus();
            }, { id: 'task-search-btn' }),
          );
        tools.append(
          toolIcon('filter', `Filter: ${TASK_FILTERS.find((f) => f.value === filter)!.label}`, (b) => choiceMenu(b, 'Show', TASK_FILTERS, filter, (v) => {
            filter = v;
            savePrefs();
            keepFocus(col, draw);
          }), { on: filter !== 'all', menu: true, id: 'task-filter' }),
          toolIcon('sort', `Sort: ${TASK_SORTS.find((s) => s.value === sort)!.label}`, (b) => choiceMenu(b, 'Sort by', TASK_SORTS, sort, (v) => {
            sort = v;
            savePrefs();
            keepFocus(col, draw);
          }), { on: sort !== 'next', menu: true, id: 'task-sort' }),
        );
      }
      const newBtn = h('button', { type: 'button', class: 'btn sm primary pg-new', id: 'task-new', 'aria-haspopup': 'menu', 'data-focus': 'task-new' }, h('span', {}, 'New task'), h('span', { class: 'pg-new-chev', html: icon('chevron-down', 12) }));
      newBtn.addEventListener('click', () => {
        newBtn.setAttribute('aria-expanded', 'true');
        openMenu(
          [
            {
              items: [
                { label: 'New task', icon: 'plus', onSelect: () => openForm({}) },
                {
                  label: 'From a template',
                  icon: 'file-text',
                  onSelect: () => {
                    if (tab !== 'templates') {
                      tab = 'templates';
                      draw();
                    }
                    col.querySelector<HTMLElement>('.template-card')?.focus();
                  },
                },
              ],
            },
          ],
          { anchor: newBtn, placement: 'bottom-end', minWidth: 180, onClose: () => newBtn.setAttribute('aria-expanded', 'false') },
        );
      });
      tools.append(newBtn);
      col.append(h('div', { class: 'pg-toolbar' }, tabs, h('span', { class: 'spacer' }), tools));
      col.append(banner(BANNER, { id: 'scheduled-banner' }));
      const body = h('div', { class: 'pg-body', id: 'scheduled-body', role: 'tabpanel', 'aria-label': tab === 'yours' ? 'Your tasks' : 'Templates' });
      col.append(body);
      drawGrid();
    }

    function drawGrid(): void {
      const body = col.querySelector<HTMLElement>('#scheduled-body');
      if (!body) return;
      keepFocus(body, () => {
        body.innerHTML = '';
        if (tab === 'templates') {
          body.append(h('p', { class: 'pg-lead' }, 'Starting points: open one, change what you like, and create it.'));
          const grid = h('ul', { class: 'pg-grid', 'aria-label': 'Templates' });
          for (const t of TEMPLATES) grid.append(h('li', {}, templateCard(t)));
          body.append(grid);
          return;
        }
        if (tasks === null) {
          body.append(h('p', { class: 'pg-lead' }, 'Loading…'));
          return;
        }
        if (!tasks.length) {
          body.append(emptyState());
          return;
        }
        const shown = shownTasks(tasks, { query, filter, sort });
        if (!shown.length) {
          const clear = h('button', { type: 'button', class: 'link-btn' }, 'Show every task');
          clear.addEventListener('click', () => {
            query = '';
            searchOpen = false;
            filter = 'all';
            savePrefs();
            draw();
          });
          body.append(h('div', { class: 'pg-none' }, h('p', {}, query ? `No task matches “${query.trim()}”${filter !== 'all' ? ` among the ${filter} ones` : ''}.` : `No ${filter} tasks.`), clear));
          return;
        }
        const grid = h('ul', { class: 'pg-grid', 'aria-label': 'Your tasks' });
        for (const s of shown) grid.append(h('li', {}, taskCard(s, host)));
        body.append(grid);
      });
    }

    function emptyState(): HTMLElement {
      const create = h('button', { type: 'button', class: 'btn primary', id: 'task-empty-new' }, h('span', { html: icon('plus', 14) }), h('span', {}, 'New task'));
      create.addEventListener('click', () => openForm({}));
      const browse = h('button', { type: 'button', class: 'btn' }, 'Browse templates');
      browse.addEventListener('click', () => {
        tab = 'templates';
        draw();
        col.querySelector<HTMLElement>('.pg-card')?.focus();
      });
      return h(
        'div',
        { class: 'pg-empty', id: 'scheduled-empty' },
        h('span', { class: 'pg-empty-icon', html: icon('clock', 20) }),
        h('h2', { class: 'pg-empty-title' }, 'No scheduled tasks yet'),
        h('p', { class: 'pg-empty-text' }, 'A task sends a prompt on a rhythm, every morning, every Friday or once next week, and each run is a session you can open and keep talking in. You can also ask the agent in any session: “every weekday at 9, summarise the open pull requests”.'),
        h('div', { class: 'pg-empty-actions' }, create, browse),
      );
    }

    draw();
    mounted = { route, update: () => drawGrid() };
    return {
      route: () => ({ page: 'scheduled', tab }),
      dispose: () => {
        if (mounted?.route === route) mounted = null;
      },
    };
  }

  function taskCard(s: Schedule, host: PageHost): HTMLElement {
    const st = taskState(s);
    const foot = taskFooter(s);
    const b = h(
      'button',
      { type: 'button', class: `pg-card task-card state-${st}`, 'data-task': s.id, 'data-focus': `task:${s.id}`, 'aria-label': `${s.name}, ${targetWords(s)}, ${foot}` },
      h('span', { class: 'pg-card-head' }, h('span', { class: 'pg-card-title' }, s.name), h('span', { class: 'pg-chip' }, targetWords(s))),
      h('span', { class: 'pg-card-text' }, s.prompt),
      h('span', { class: 'pg-card-foot' }, st === 'running' ? h('span', { class: 'spinner sm pg-card-spin', 'aria-hidden': 'true' }) : null, h('span', {}, foot)),
    );
    b.title = s.prompt.length > 200 ? `${s.prompt.slice(0, 200)}…` : s.prompt;
    b.addEventListener('click', () => host.open({ page: 'task', id: s.id }));
    return b;
  }

  function templateCard(t: TaskTemplate): HTMLElement {
    const when = rhythmToWhen(fullRhythm(t.rhythm));
    const words = when.ok ? rhythmLine(t.rhythm) : '';
    const b = h(
      'button',
      { type: 'button', class: 'pg-card template-card', 'data-template': t.id, 'data-focus': `tpl:${t.id}`, 'aria-label': `${t.name}, ${words}. Opens the New task form` },
      h('span', { class: 'pg-card-head' }, h('span', { class: 'pg-card-title' }, t.name), h('span', { class: 'pg-chip' }, 'New session')),
      h('span', { class: 'pg-card-text' }, t.prompt),
      h('span', { class: 'pg-card-foot' }, h('span', {}, `Template · ${words}`)),
    );
    b.addEventListener('click', () => openForm({ template: t.id }));
    return b;
  }

  // ---------- A task's page ----------

  function renderTask(route: Extract<PageRoute, { page: 'task' }>, root: HTMLElement, host: PageHost): PageHandle {
    const col = h('div', { class: 'pg-col pg-detail-page', 'data-task-page': route.id });
    root.append(col);
    let prompt = false;
    const handle: PageHandle = {};
    const find = () => tasks?.find((x) => x.id === route.id) ?? null;

    const menu = () => {
      const s = find();
      if (!s) return [];
      return [
        { items: [{ label: 'Edit', icon: 'pencil' as const, onSelect: () => openForm({ edit: s.id }) }, { label: 'Run now', icon: 'play' as const, disabled: s.lastStatus === 'running', onSelect: () => void runNow(s, null) }] },
        { items: [{ label: 'Delete', icon: 'trash' as const, danger: true, onSelect: () => void remove(s, host) }] },
      ];
    };

    function draw(): void {
      const s = find();
      keepFocus(col, () => {
        col.innerHTML = '';
        if (!s) {
          handle.crumbs = { parent: { label: 'Scheduled tasks', route: { page: 'scheduled' } }, title: 'Not found' };
          const back = h('button', { type: 'button', class: 'link-btn' }, 'Back to Scheduled tasks');
          back.addEventListener('click', () => host.open({ page: 'scheduled' }, { replace: true }));
          col.append(pageHead(tasks === null ? 'Loading…' : 'This task is gone'));
          if (tasks !== null) col.append(h('p', { class: 'pg-lead' }, 'It was deleted. The sessions its runs made are still in the sidebar.'), back);
          host.syncCrumbs();
          return;
        }
        handle.crumbs = { parent: { label: 'Scheduled tasks', route: { page: 'scheduled' } }, title: s.name, menu };
        const st = taskState(s);
        const run = h('button', { type: 'button', class: 'btn sm', id: 'task-run-now', 'data-focus': 'run-now', disabled: st === 'running' }, h('span', { html: icon('play', 14) }), h('span', {}, 'Run now'));
        run.addEventListener('click', () => void runNow(s, run));
        const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: 'task-active', 'data-focus': 'active', 'aria-label': 'Active', 'aria-describedby': 'page-sub' }) as HTMLInputElement;
        sw.checked = s.enabled;
        // A one-shot whose time has passed cannot come back on
        const dead = s.when.kind === 'at' && !(Date.parse(s.when.at) > Date.now());
        if (dead && !s.enabled) {
          sw.disabled = true;
          sw.title = 'Its time has passed: edit it to give it a new one';
        }
        sw.addEventListener('change', () => void setActive(s, sw));
        const actions = h('div', { class: 'pg-head-actions' }, run, h('label', { class: 'pg-switch', for: 'task-active' }, h('span', { class: 'pg-switch-label' }, 'Active'), sw));
        col.append(pageHead(s.name, { chip: targetWords(s), sub: nextRunWords(s), actions }));
        col.append(h('hr', { class: 'pg-rule' }));
        const main = h('section', { class: 'pg-main', 'aria-labelledby': 'task-history-title' }, h('h2', { class: 'pg-h2', id: 'task-history-title' }, 'History'));
        const runs = taskRuns(s);
        if (!runs.length) main.append(h('div', { class: 'pg-nothing', id: 'task-no-runs' }, 'No runs yet'));
        else {
          const seen = new Set<string>();
          const list = h('ul', { class: 'pg-rows', id: 'task-runs', 'aria-label': 'Runs, newest first' });
          runs.forEach((r, i) => {
            const latest = !seen.has(r.sessionId);
            seen.add(r.sessionId);
            list.append(h('li', {}, runRow(r, i, latest)));
          });
          main.append(list);
          if (s.history && s.runs > s.history.length) main.append(h('p', { class: 'pg-note' }, `The last ${s.history.length} of ${s.runs} runs.`));
        }
        const side = h('aside', { class: 'pg-side', 'aria-label': 'About this task' });
        const instr = h('p', { class: `pg-prompt${prompt ? ' open' : ''}`, id: 'task-prompt-text' }, s.prompt);
        const instrSec = sideSection('Instructions', instr);
        if (s.prompt.length > 220 || s.prompt.split('\n').length > 5) {
          const more = h('button', { type: 'button', class: 'link-btn pg-more', 'data-focus': 'prompt-more', 'aria-expanded': String(prompt), 'aria-controls': 'task-prompt-text' }, prompt ? 'Show less' : 'Show all');
          more.addEventListener('click', () => {
            prompt = !prompt;
            draw();
          });
          instrSec.append(more);
        }
        side.append(instrSec);
        side.append(sideSection('Project', h('div', { class: 'pg-folder', title: s.cwd }, h('span', { class: 'pg-folder-icon', html: icon('folder', 14) }), h('span', { class: 'pg-folder-name' }, folderName(s.cwd))), h('p', { class: 'pg-side-note' }, tilde(s.cwd))));
        side.append(sideSection('Runs', h('p', { class: 'pg-side-text', id: 'task-rhythm-words' }, rhythmWords(s)), h('p', { class: 'pg-side-note' }, s.createdBy === 'agent' ? 'Made by the agent, with your approval.' : `Made ${formatWhenAt(s.createdAt).replace(/^(Today|Yesterday)/, (m) => m.toLowerCase())}.`)));
        const where = h('div', { class: 'pg-side-text' });
        if (s.target === 'session' && s.sessionId) {
          const t = sessionTitle(s.sessionId);
          where.append('Continues ');
          if (t) {
            const a = h('button', { type: 'button', class: 'link-btn pg-inline-link', 'data-session': s.sessionId }, t);
            a.addEventListener('click', () => d.openSession(s.sessionId!));
            where.append(a);
          } else where.append('a session that was deleted');
        } else where.append('Each run starts a new session, listed in the sidebar with ', h('span', { class: 'pg-inline-icon', 'aria-label': 'a lightning bolt', html: icon('zap', 12) }), ' in front of its title.');
        side.append(sideSection('Each run', where));
        const mode = MODES[d.config()?.permissionMode ?? 'ask'] ?? MODES.ask;
        side.append(sideSection('Permissions', h('div', { class: 'pg-mode' }, h('span', { class: 'pg-mode-icon', html: icon(mode.icon, 14) }), h('span', {}, mode.label)), h('p', { class: 'pg-side-note' }, `${mode.desc}. Runs use the permission mode in the chat bar; a run that needs your approval waits for you in its session.`)));
        col.append(h('div', { class: 'pg-detail' }, main, side));
      });
      host.syncCrumbs();
    }

    function runRow(r: NonNullable<Schedule['history']>[number], i: number, latest: boolean): HTMLElement {
      const meta = d.sessions().find((x) => x.id === r.sessionId);
      const state: RunState = runState(r, latest, meta ? d.status(r.sessionId) : undefined);
      const glyph: Record<RunState, string> = {
        running: '<span class="spinner sm" aria-hidden="true"></span>',
        waiting: '<span class="pg-dot attention" aria-hidden="true"></span>',
        done: icon('circle-check', 14),
        failed: icon('circle-alert', 14),
        stopped: icon('circle-dashed', 14),
      };
      const title = meta?.title ?? 'A deleted session';
      const when = `${formatWhenAt(r.at)}${r.continued ? ' · continued' : ''}`;
      const b = h(
        'button',
        { type: 'button', class: `pg-row run-row ${state}`, 'data-session': r.sessionId, 'data-focus': `run:${i}`, 'data-state': state, disabled: !meta, 'aria-label': `${title}, ${when}, ${RUN_WORDS[state]}${meta ? '' : ', its session was deleted'}` },
        h('span', { class: `pg-row-glyph ${state}`, html: glyph[state] }),
        h('span', { class: 'pg-row-text' }, h('span', { class: 'pg-row-title' }, title), h('span', { class: 'pg-row-meta' }, when)),
        h('span', { class: `pg-row-state ${state}` }, RUN_WORDS[state]),
      );
      if (r.error) b.title = r.error;
      b.addEventListener('click', () => d.openSession(r.sessionId));
      return b;
    }

    draw();
    mounted = { route, update: draw };
    handle.dispose = () => {
      if (mounted?.route === route) mounted = null;
    };
    return handle;
  }

  function sideSection(title: string, ...body: (Node | null)[]): HTMLElement {
    return h('section', { class: 'pg-side-sec' }, h('h3', { class: 'pg-h3' }, title), ...body);
  }

  async function runNow(s: Schedule, btn: HTMLButtonElement | null): Promise<void> {
    if (btn) btn.disabled = true;
    try {
      await rpc('schedules.runNow', s.id);
      adopt(await rpc('schedules.list'));
    } catch (err) {
      d.showError(btn ?? document.querySelector<HTMLElement>('#page-title') ?? document.body, `Couldn't run it: ${plain(d.cleanError(err))}`);
      if (btn) btn.disabled = false;
    }
  }

  async function setActive(s: Schedule, sw: HTMLInputElement): Promise<void> {
    const on = sw.checked;
    sw.disabled = true;
    try {
      await rpc('schedules.update', s.id, { enabled: on });
      adopt(await rpc('schedules.list'));
    } catch (err) {
      sw.checked = !on;
      d.showError(sw, `Couldn't ${on ? 'turn it on' : 'pause it'}: ${plain(d.cleanError(err))}`);
    } finally {
      sw.disabled = false;
    }
  }

  async function remove(s: Schedule, host: PageHost): Promise<void> {
    const ok = await d.confirm({ title: `Delete “${s.name}”?`, description: 'It will not run again. The sessions its runs made stay in the sidebar.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      adopt(await rpc('schedules.remove', s.id));
      host.open({ page: 'scheduled' }, { replace: true });
    } catch (err) {
      d.showError(document.querySelector<HTMLElement>('#page-title') ?? document.body, `Couldn't delete it: ${plain(d.cleanError(err))}`);
    }
  }

  // ---------- The New / Edit task dialog ----------

  let dialog: HTMLDialogElement | null = null;

  function folderChoices(selected: string): string[] {
    const cfg = d.config();
    const out: string[] = [];
    const add = (p: string | undefined) => {
      if (p && !out.includes(p)) out.push(p);
    };
    add(selected);
    add(cfg?.workingDirectory);
    for (const p of cfg?.recentDirs ?? []) add(p);
    for (const m of [...d.sessions()].sort((a, b) => b.updatedAt - a.updatedAt)) if (m.origin !== 'dream') add(m.cwd);
    return out.slice(0, 12);
  }

  function openForm(opts: { template?: string; edit?: string } = {}): void {
    const edit = opts.edit ? tasks?.find((x) => x.id === opts.edit) : undefined;
    const tpl = opts.template ? TEMPLATES.find((t) => t.id === opts.template) : undefined;
    dialog?.remove();
    const dlg = h('dialog', { class: 'dialog task-dialog', id: 'task-dialog', 'aria-labelledby': 'task-dialog-title' }) as HTMLDialogElement;
    dialog = dlg;
    const form = h('form', { method: 'dialog', novalidate: true });
    dlg.append(form);
    const title = edit ? `Edit “${edit.name}”` : tpl ? `New task from “${tpl.name}”` : 'New task';
    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', html: icon('x', 16) });
    close.addEventListener('click', () => dlg.close());
    form.append(h('header', { class: 'dialog-head' }, h('h2', { id: 'task-dialog-title' }, title), close));

    const body = h('div', { class: 'dialog-body task-form' });
    form.append(body);
    const field = (label: string, forId: string, control: HTMLElement, hint?: string) =>
      h('div', { class: 'field task-field' }, h('label', { class: 'field-label', for: forId }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);

    const name = h('input', { id: 'task-name', type: 'text', placeholder: 'Morning summary', maxlength: '80', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    name.value = edit?.name ?? tpl?.name ?? '';
    const prompt = h('textarea', { id: 'task-prompt', rows: '5', placeholder: 'Summarise what changed in the repo since yesterday…', maxlength: '8000' }) as HTMLTextAreaElement;
    prompt.value = edit?.prompt ?? tpl?.prompt ?? '';
    body.append(field('Name', 'task-name', name), field('Instructions', 'task-prompt', prompt, 'What each run is asked to do, as you would type it in a session.'));

    // Folder
    const folder = h('select', { id: 'task-folder' }) as HTMLSelectElement;
    const fillFolders = (sel: string) => {
      folder.innerHTML = '';
      for (const p of folderChoices(sel)) folder.append(h('option', { value: p }, `${folderName(p)} — ${tilde(p)}`));
      folder.append(h('option', { value: '__choose' }, 'Choose another folder…'));
      folder.value = sel;
    };
    let folderNow = edit?.cwd ?? d.config()?.workingDirectory ?? '';
    fillFolders(folderNow);
    folder.addEventListener('change', async () => {
      if (folder.value !== '__choose') {
        folderNow = folder.value;
        return;
      }
      let picked: string | null = null;
      try {
        picked = await rpc('schedules.chooseFolder', folderNow);
      } catch (err) {
        setProblem(`Couldn't open the folder picker: ${d.cleanError(err)}`);
      }
      if (picked) folderNow = picked;
      fillFolders(folderNow);
    });
    const folderWrap = h('span', { class: 'select' }, folder, h('span', { class: 'select-chev', html: icon('chevron-down', 14) }));
    body.append(field('Folder', 'task-folder', folderWrap, edit ? 'Where its runs work. Changing it applies to the next run.' : 'Where its runs work: their working directory, project instructions and rules.'));
    if (edit) folder.disabled = true;

    // Rhythm
    let rhythm = fullRhythm(edit ? whenToRhythm(edit.when) : tpl ? tpl.rhythm : { kind: 'daily' });
    const kind = h('select', { id: 'task-rhythm' }) as HTMLSelectElement;
    for (const k of RHYTHM_KINDS) kind.append(h('option', { value: k.value }, k.label));
    kind.value = rhythm.kind;
    const kindWrap = h('span', { class: 'select' }, kind, h('span', { class: 'select-chev', html: icon('chevron-down', 14) }));
    const detail = h('div', { class: 'task-rhythm-detail', id: 'task-rhythm-detail' });
    const preview = h('p', { class: 'hint task-preview', id: 'task-preview', 'aria-live': 'polite' });
    let previewSeq = 0;
    const input = (attrs: Record<string, string>, value: string | number, on: (v: string) => void) => {
      const el = h('input', attrs) as HTMLInputElement;
      el.value = String(value);
      el.addEventListener('input', () => {
        on(el.value);
        void syncPreview();
      });
      return el;
    };
    const select = (id: string, label: string, choices: [string, string][], value: string, on: (v: string) => void) => {
      const el = h('select', { id, 'aria-label': label }) as HTMLSelectElement;
      for (const [v, l] of choices) el.append(h('option', { value: v }, l));
      el.value = value;
      el.addEventListener('change', () => {
        on(el.value);
        void syncPreview();
      });
      return h('span', { class: 'select' }, el, h('span', { class: 'select-chev', html: icon('chevron-down', 14) }));
    };
    const word = (t: string) => h('span', { class: 'task-word' }, t);
    const time = () => input({ id: 'task-time', type: 'time', 'aria-label': 'Time', class: 'task-time' }, rhythm.time, (v) => (rhythm.time = v));
    function drawDetail(): void {
      detail.innerHTML = '';
      switch (rhythm.kind) {
        case 'once':
          detail.append(word('On'), input({ id: 'task-at', type: 'datetime-local', 'aria-label': 'Date and time', class: 'task-at' }, rhythm.at, (v) => (rhythm.at = v)));
          break;
        case 'hourly':
          detail.append(word('At'), input({ id: 'task-minute', type: 'number', min: '0', max: '59', 'aria-label': 'Minutes past the hour', class: 'task-num' }, rhythm.minute, (v) => (rhythm.minute = Number(v))), word('minutes past the hour'));
          break;
        case 'interval':
          detail.append(
            word('Every'),
            input({ id: 'task-every', type: 'number', min: '1', 'aria-label': 'How many', class: 'task-num' }, rhythm.every, (v) => (rhythm.every = Number(v))),
            select('task-unit', 'Unit', [['minutes', 'minutes'], ['hours', 'hours'], ['days', 'days']], rhythm.unit, (v) => (rhythm.unit = v as 'minutes' | 'hours' | 'days')),
          );
          break;
        case 'daily':
        case 'weekdays':
          detail.append(word('At'), time());
          break;
        case 'weekly':
          detail.append(word('On'), select('task-day', 'Day of the week', DAY_NAMES.map((n, i) => [String(i), n]), String(rhythm.day), (v) => (rhythm.day = Number(v))), word('at'), time());
          break;
        case 'monthly':
          detail.append(word('On day'), input({ id: 'task-date', type: 'number', min: '1', max: '28', 'aria-label': 'Day of the month', class: 'task-num' }, rhythm.date, (v) => (rhythm.date = Number(v))), word('at'), time());
          break;
        case 'cron':
          detail.append(input({ id: 'task-cron', type: 'text', class: 'mono task-cron', spellcheck: 'false', 'aria-label': 'Cron rhythm', placeholder: '0 9 * * 1-5' }, rhythm.cron, (v) => (rhythm.cron = v)), word('minute hour day month weekday, local time'));
          break;
      }
    }
    kind.addEventListener('change', () => {
      rhythm.kind = kind.value as RhythmKind;
      drawDetail();
      void syncPreview();
    });
    async function syncPreview(): Promise<boolean> {
      const my = ++previewSeq;
      const w = rhythmToWhen(rhythm);
      if (!w.ok) {
        preview.textContent = w.error;
        preview.classList.add('bad');
        return false;
      }
      try {
        const p = await rpc('schedules.preview', w.value);
        if (my !== previewSeq) return true;
        preview.classList.remove('bad');
        preview.textContent = `${rhythmWords(p)}${p.nextRunAt ? ` · first run ${formatWhenAt(p.nextRunAt).replace(/^(Today|Tomorrow)/, (m) => m.toLowerCase())}` : ''}`;
        return true;
      } catch (err) {
        if (my !== previewSeq) return false;
        preview.textContent = plain(d.cleanError(err));
        preview.classList.add('bad');
        return false;
      }
    }
    drawDetail();
    body.append(h('div', { class: 'field task-field' }, h('label', { class: 'field-label', for: 'task-rhythm' }, 'Schedule'), h('div', { class: 'task-rhythm' }, kindWrap, detail), preview));

    // Each run: a new session, or a session it continues
    let target: 'new' | 'session' = edit?.target ?? 'new';
    const radio = (value: 'new' | 'session', label: string) => {
      const r = h('input', { type: 'radio', name: 'task-target', value, id: `task-target-${value}` }) as HTMLInputElement;
      r.checked = target === value;
      r.addEventListener('change', () => {
        if (!r.checked) return;
        target = value;
        sessionField.hidden = value !== 'session';
      });
      return h('label', {}, r, h('span', {}, label));
    };
    const seg = h('div', { class: 'segmented task-target', role: 'radiogroup', 'aria-label': 'Each run' }, radio('new', 'Starts a new session'), radio('session', 'Continues a session'));
    const sessionSel = h('select', { id: 'task-session', 'aria-label': 'The session it continues' }) as HTMLSelectElement;
    const candidates = [...d.sessions()].filter((m) => m.origin !== 'dream').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
    const want = edit?.sessionId ?? d.currentSessionId();
    if (want && !candidates.some((m) => m.id === want)) {
      const m = d.sessions().find((x) => x.id === want);
      if (m) candidates.unshift(m);
    }
    for (const m of candidates) sessionSel.append(h('option', { value: m.id }, `${m.title}${m.cwd ? ` — ${folderName(m.cwd)}` : ''}`));
    if (want && candidates.some((m) => m.id === want)) sessionSel.value = want;
    const sessionField = h('div', { class: 'task-session' }, h('span', { class: 'select' }, sessionSel, h('span', { class: 'select-chev', html: icon('chevron-down', 14) })), h('p', { class: 'hint' }, 'Each run arrives there as a follow-up, after whatever is running in it.'));
    sessionField.hidden = target !== 'session';
    body.append(h('div', { class: 'field task-field' }, h('span', { class: 'field-label', id: 'task-target-label' }, 'Each run'), seg, sessionField));

    const mode = MODES[d.config()?.permissionMode ?? 'ask'] ?? MODES.ask;
    body.append(h('p', { class: 'hint task-mode' }, h('span', { class: 'task-mode-icon', html: icon(mode.icon, 14) }), h('span', {}, `Runs use the permission mode in the chat bar, now ${mode.label}: ${mode.desc.charAt(0).toLowerCase()}${mode.desc.slice(1)}.`)));

    const problem = h('div', { class: 'task-problem', id: 'task-problem', role: 'alert', hidden: true });
    const setProblem = (m: string | null) => {
      problem.hidden = !m;
      problem.innerHTML = m ? icon('circle-alert', 14) : '';
      if (m) problem.append(h('span', {}, m));
    };
    const cancel = h('button', { type: 'button', class: 'btn', id: 'task-cancel' }, 'Cancel');
    cancel.addEventListener('click', () => dlg.close());
    const save = h('button', { type: 'submit', class: 'btn primary', id: 'task-save' }, edit ? 'Save' : 'Create task');
    form.append(h('footer', { class: 'dialog-foot' }, problem, h('span', { class: 'spacer' }), cancel, save));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setProblem(null);
      const n = name.value.replace(/\s+/g, ' ').trim();
      const p = prompt.value.trim();
      if (!n) {
        setProblem('Give the task a name.');
        name.focus();
        return;
      }
      if (!p) {
        setProblem('Write what each run should do.');
        prompt.focus();
        return;
      }
      const w = rhythmToWhen(rhythm);
      if (!w.ok) {
        setProblem(w.error);
        detail.querySelector<HTMLElement>('input, select')?.focus();
        return;
      }
      if (target === 'session' && !sessionSel.value) {
        setProblem('Pick the session it continues, or let each run start a new one.');
        return;
      }
      save.disabled = true;
      try {
        let saved: Schedule;
        if (edit) {
          const patch: SchedulePatch = { name: n, prompt: p, when: w.value, target, ...(target === 'session' ? { sessionId: sessionSel.value } : {}) };
          saved = await rpc('schedules.update', edit.id, patch);
        } else {
          const input: ScheduleInput = { name: n, prompt: p, when: w.value, target, cwd: folderNow || undefined, ...(target === 'session' ? { sessionId: sessionSel.value } : {}) };
          saved = await rpc('schedules.create', input);
        }
        adopt(await rpc('schedules.list'));
        dlg.close();
        onSaved?.(saved);
      } catch (err) {
        setProblem(plain(d.cleanError(err)));
      } finally {
        save.disabled = false;
      }
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (dialog === dlg) dialog = null;
    });
    document.body.append(dlg);
    dlg.showModal();
    void syncPreview();
    name.focus();
    if (tpl) name.select();
  }

  /** After a create from the list, the new task's page opens */
  let onSaved: ((s: Schedule) => void) | null = null;
  let hostRef: PageHost | null = null;

  return {
    render(route, root, host) {
      hostRef = host;
      // A task created from the list: its new card takes the focus
      onSaved = (s) => {
        const cur = host.current();
        if (cur?.page !== 'scheduled') return;
        if (cur.tab === 'templates') host.open({ page: 'scheduled', tab: 'yours' }, { replace: true });
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`.task-card[data-task="${CSS.escape(s.id)}"]`)?.focus());
      };
      if (absent) return null;
      const handle = route.page === 'scheduled' ? renderList(route, root, host) : route.page === 'task' ? renderTask(route, root, host) : null;
      if (handle && pendingForm) {
        const f = pendingForm;
        pendingForm = null;
        queueMicrotask(() => openForm(f));
      }
      return handle;
    },
    openForm(opts = {}) {
      if (!hostRef?.isOpen() || (hostRef.current()?.page !== 'scheduled' && hostRef.current()?.page !== 'task')) {
        pendingForm = opts;
        return;
      }
      openForm(opts);
    },
    present: () => (absent === null ? null : !absent),
    debug: {
      state: () => ({ tasks: tasks?.length ?? null, filter, sort, query, searchOpen, dialog: dialog?.open ?? false }),
    },
  };
}

/** "Every day at 02:00" for a template's rhythm, without asking the main process */
function rhythmLine(r: Rhythm): string {
  const f = fullRhythm(r);
  switch (f.kind) {
    case 'daily':
      return `Every day at ${f.time}`;
    case 'weekdays':
      return `Weekdays at ${f.time}`;
    case 'weekly':
      return `${DAY_NAMES[f.day]}s at ${f.time}`;
    case 'monthly':
      return `Monthly on day ${f.date} at ${f.time}`;
    case 'hourly':
      return `Every hour at :${String(f.minute).padStart(2, '0')}`;
    case 'interval':
      return `Every ${f.every} ${f.unit}`;
    case 'once':
      return 'Once';
    default:
      return f.cron;
  }
}
