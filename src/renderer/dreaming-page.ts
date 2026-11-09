// The Dreaming pages, laid out like Scheduled tasks: the list (Projects | Suggestions, search, filter, sort, the
// settings, Run a dream), and a project's own page (Run a dream now, its History of dreams, each opening the dream's
// session, and the settings beside it). The data is the Dreaming service's (dreaming.*); the proposal cards are the
// ones a dream's session shows (dreaming.ts).

import type { SessionMeta } from '../shared/types';
import type { Dream, DreamingConfig, DreamingState, DreamMode, DreamProject } from '../shared/dreaming';
import { h } from './dom.js';
import { icon } from './icons.js';
import { rpc } from './rpc.js';
import { bus } from './bus.js';
import { tilde } from './home.js';
import { openMenu, type MenuSection } from './popover.js';
import { formatWhenAt } from './settings/model.js';
import { adoptDreaming, dreamingState, dreamStatus, onDreaming, proposalCard, refreshDreaming } from './dreaming.js';
import { banner, choiceMenu, keepFocus, pageHead, pageTabs, toolIcon, type PageHandle, type PageHost, type PageRoute } from './pages.js';
import {
  MODE_LINES,
  MODE_WORDS,
  PROJECT_FILTERS,
  PROJECT_SORTS,
  TRIGGER_WORDS,
  dreamProjects,
  dreamSummary,
  dreamWaiting,
  folderName,
  projectFooter,
  shownProjects,
  type DreamProjectCard,
  type ProjectFilter,
  type ProjectSort,
} from './pages-model.js';

export interface DreamingPageDeps {
  sessions(): SessionMeta[];
  openSession(id: string): void;
  cleanError(err: unknown): string;
  showError(anchor: HTMLElement, message: string): void;
}

export interface DreamingPage {
  render(route: PageRoute, root: HTMLElement, host: PageHost): PageHandle | null;
  present(): boolean | null;
  debug: { state(): unknown };
}

const PRIVACY = 'A dream sends parts of your past sessions to the model you configured, and uses tokens: about as many as a long message, once per project with new activity.';
const lowerDay = (s: string) => s.replace(/^(Today|Tomorrow|Yesterday)/, (m) => m.toLowerCase());

export function createDreamingPage(d: DreamingPageDeps): DreamingPage {
  let absent: boolean | null = null;
  let projects: DreamProject[] = [];
  let query = '';
  let searchOpen = false;
  let filter: ProjectFilter = 'all';
  let sort: ProjectSort = 'recent';
  let mounted: { route: PageRoute; update(): void } | null = null;
  /** A word after Run a dream (nothing new, could not start), until the next change */
  let runNote = '';

  const state = () => dreamingState();
  const cfg = (): DreamingConfig | undefined => state()?.config;

  async function loadProjects(): Promise<void> {
    try {
      projects = await rpc('dreaming.projects');
    } catch {
      projects = [];
    }
    mounted?.update();
  }

  void refreshDreaming().then((s) => {
    absent = !s;
    mounted?.update();
  });
  onDreaming(() => {
    absent = false;
    if (mounted) void loadProjects();
  });
  bus.on('sessions', () => {
    if (mounted?.route.page === 'project') mounted.update();
  });

  // ---------- Settings: the same controls on a project's page and in the settings dialog ----------

  async function setConfig(patch: Partial<DreamingConfig>, anchor: HTMLElement): Promise<boolean> {
    try {
      adoptDreaming(await rpc('dreaming.set', patch));
      return true;
    } catch (err) {
      d.showError(anchor, `Couldn't save: ${d.cleanError(err)}`);
      await refreshDreaming();
      return false;
    }
  }

  function settingsBlocks(prefix: string): HTMLElement[] {
    const c = cfg();
    if (!c) return [];
    const daily = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: `${prefix}-daily`, 'aria-label': 'Dream every day', 'data-focus': `${prefix}-daily` }) as HTMLInputElement;
    daily.checked = c.daily;
    daily.addEventListener('change', () => void setConfig({ daily: daily.checked }, daily));
    const time = h('input', { type: 'time', class: 'pg-time', id: `${prefix}-time`, 'aria-label': 'Time of the daily dream', 'data-focus': `${prefix}-time` }) as HTMLInputElement;
    time.value = c.time;
    time.addEventListener('change', () => {
      if (/^\d{2}:\d{2}$/.test(time.value)) void setConfig({ time: time.value }, time);
    });
    const next = state()?.nextRunAt;
    const dailyNote = c.daily && next ? `Next: ${formatWhenAt(next)}. A dream missed while the app was closed runs once at the next launch.` : 'Off: dreams run only when you start one. When it is on, a dream runs once a day at this time, local time.';
    const dailyBlock = sideSection('Daily dream', h('div', { class: 'pg-control-line' }, h('label', { class: 'pg-switch', for: `${prefix}-daily` }, h('span', { class: 'pg-switch-label' }, 'Every day'), daily), h('span', { class: 'pg-control-at' }, 'at'), time), h('p', { class: 'pg-side-note', id: `${prefix}-daily-note` }, dailyNote));

    const name = `${prefix}-mode`;
    const seg = h('div', { class: 'segmented pg-seg', role: 'radiogroup', 'aria-label': 'Mode' });
    for (const m of ['auto', 'approve', 'plan'] as DreamMode[]) {
      const r = h('input', { type: 'radio', name, value: m, id: `${prefix}-mode-${m}`, 'data-focus': `${prefix}-mode-${m}` }) as HTMLInputElement;
      r.checked = c.mode === m;
      r.addEventListener('change', () => {
        if (r.checked) void setConfig({ mode: m }, seg);
      });
      seg.append(h('label', {}, r, h('span', {}, MODE_WORDS[m])));
    }
    const modeBlock = sideSection('Mode', seg, h('p', { class: 'pg-side-note', id: `${prefix}-mode-note` }, MODE_LINES[c.mode]));

    const kind = (key: 'skills' | 'mods' | 'memory', label: string, note: string) => {
      const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: `${prefix}-${key}`, 'data-focus': `${prefix}-${key}`, 'aria-describedby': `${prefix}-${key}-note` }) as HTMLInputElement;
      sw.checked = c[key];
      sw.addEventListener('change', () => void setConfig({ [key]: sw.checked }, sw));
      return h('div', { class: 'pg-kind' }, h('label', { class: 'pg-switch wide', for: `${prefix}-${key}` }, h('span', { class: 'pg-switch-label' }, label), sw), h('p', { class: 'pg-side-note', id: `${prefix}-${key}-note` }, note));
    };
    const kinds = sideSection(
      'Looks for',
      kind('skills', 'Skills', 'A procedure you asked for more than once, written down so /name runs it.'),
      kind('mods', 'Mods', 'A view or a status you keep asking for, as a small panel. It stays off until you turn it on.'),
      kind('memory', 'Memory', 'Preferences, corrections and facts about a project, as lines in its instructions file.'),
    );
    return [dailyBlock, modeBlock, kinds];
  }

  let settingsDialog: HTMLDialogElement | null = null;
  function openSettings(): void {
    settingsDialog?.remove();
    const dlg = h('dialog', { class: 'dialog dream-settings-dialog', id: 'dream-settings', 'aria-labelledby': 'dream-settings-title' }) as HTMLDialogElement;
    settingsDialog = dlg;
    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', html: icon('x', 16) });
    close.addEventListener('click', () => dlg.close());
    const body = h('div', { class: 'dialog-body pg-settings-body' });
    const fill = () => keepFocus(body, () => {
      body.innerHTML = '';
      body.append(...settingsBlocks('dream-dlg'), h('p', { class: 'pg-side-note pg-privacy' }, `These apply to every project. ${PRIVACY}`));
    });
    fill();
    const off = onDreaming(() => {
      if (dlg.open) fill();
    });
    const done = h('button', { type: 'button', class: 'btn primary' }, 'Done');
    done.addEventListener('click', () => dlg.close());
    dlg.append(h('header', { class: 'dialog-head' }, h('h2', { id: 'dream-settings-title' }, 'Dreaming settings'), close), body, h('footer', { class: 'dialog-foot' }, h('span', { class: 'spacer' }), done));
    dlg.addEventListener('close', () => {
      off();
      dlg.remove();
      if (settingsDialog === dlg) settingsDialog = null;
    });
    document.body.append(dlg);
    dlg.showModal();
    body.querySelector<HTMLElement>('input')?.focus();
  }

  // ---------- Running ----------

  async function run(cwd: string | undefined, anchor: HTMLElement): Promise<void> {
    runNote = '';
    try {
      const s = await rpc('dreaming.run', cwd);
      adoptDreaming(s);
      if (!s.running && s.lastCheck?.found === 0) runNote = cwd ? `Nothing new to dream about in ${folderName(cwd)} since its last dream.` : 'Nothing new to dream about since the last dream.';
    } catch (err) {
      runNote = d.cleanError(err);
    }
    mounted?.update();
    void anchor;
  }

  async function stop(): Promise<void> {
    try {
      adoptDreaming(await rpc('dreaming.stop'));
    } catch {
      await refreshDreaming();
    }
  }

  function runMenu(anchor: HTMLElement): void {
    const fresh = projects.filter((p) => p.fresh > 0);
    const sections: MenuSection[] = [
      { items: [{ label: 'Every project with new activity', icon: 'moon', description: fresh.length ? `${Math.min(fresh.filter((p) => p.next).length || fresh.length, 5)} to read` : 'nothing new anywhere', onSelect: () => void run(undefined, anchor) }] },
    ];
    if (projects.length) {
      sections.push({
        label: 'One project',
        items: projects.slice(0, 8).map((p) => ({
          label: folderName(p.cwd),
          icon: 'folder' as const,
          description: p.fresh ? `${p.fresh} new session${p.fresh === 1 ? '' : 's'}` : 'nothing new',
          disabled: !p.fresh,
          onSelect: () => void run(p.cwd, anchor),
        })),
      });
    }
    anchor.setAttribute('aria-expanded', 'true');
    openMenu(sections, { anchor, placement: 'bottom-end', minWidth: 240, onClose: () => anchor.setAttribute('aria-expanded', 'false') });
  }

  function runButton(): HTMLElement {
    const running = state()?.running;
    if (running) {
      const b = h('button', { type: 'button', class: 'btn sm pg-new', id: 'dream-stop', 'data-focus': 'dream-run' }, h('span', { html: icon('square', 14) }), h('span', {}, 'Stop the dream'));
      b.addEventListener('click', () => void stop());
      return b;
    }
    const b = h('button', { type: 'button', class: 'btn sm primary pg-new', id: 'dream-run', 'aria-haspopup': 'menu', 'data-focus': 'dream-run' }, h('span', {}, 'Run a dream'), h('span', { class: 'pg-new-chev', html: icon('chevron-down', 12) }));
    b.addEventListener('click', () => runMenu(b));
    return b;
  }

  function bannerNow(): HTMLElement {
    const s = state();
    const c = s?.config;
    const parts: string[] = [];
    if (s?.running) parts.push(`Dreaming about ${folderName(s.running.cwd)} now${s.running.queued ? `, then ${s.running.queued} more project${s.running.queued === 1 ? '' : 's'}` : ''}.`);
    let action: HTMLElement | null = null;
    if (c?.daily) {
      parts.push(`The daily dream runs at ${c.time}${s?.nextRunAt ? ` (next: ${lowerDay(formatWhenAt(s.nextRunAt))})` : ''}, over the projects with new activity.`);
      action = h('button', { type: 'button', class: 'link-btn pg-banner-action', id: 'dream-banner-change' }, 'Change');
      action.addEventListener('click', () => openSettings());
    } else {
      parts.push('The daily dream is off until you turn it on; until then a dream runs only when you start one.');
      action = h('button', { type: 'button', class: 'btn sm pg-banner-action', id: 'dream-banner-on' }, 'Turn on');
      action.addEventListener('click', () => void setConfig({ daily: true }, action!));
    }
    parts.push(PRIVACY.replace(/: about as many.*$/, '.'));
    return banner(parts.join(' '), { id: 'dreaming-banner', icon: 'moon', action });
  }

  // ---------- The list ----------

  function renderList(route: Extract<PageRoute, { page: 'dreaming' }>, root: HTMLElement, host: PageHost): PageHandle {
    let tab: 'projects' | 'suggestions' = route.tab ?? 'projects';
    const col = h('div', { class: 'pg-col pg-list', 'data-list': 'dreaming' });
    root.append(col);

    function draw(): void {
      keepFocus(col, () => {
        col.innerHTML = '';
        col.append(pageHead('Dreaming'));
        const waiting = state()?.waiting ?? 0;
        const tabs = pageTabs('Dreaming', [{ value: 'projects', label: 'Projects' }, { value: 'suggestions', label: 'Suggestions', count: waiting }], tab, (v) => {
          tab = v;
          draw();
          col.querySelector<HTMLElement>(`.pg-tab[data-tab="${v}"]`)?.focus();
        });
        const tools = h('div', { class: 'pg-tools' });
        if (tab === 'projects') {
          if (searchOpen) {
            const field = h('input', { type: 'search', class: 'pg-search-input', id: 'dream-search', placeholder: 'Search projects', 'aria-label': 'Search projects', spellcheck: 'false', autocomplete: 'off', value: query }) as HTMLInputElement;
            field.addEventListener('input', () => {
              query = field.value;
              drawBody();
            });
            field.addEventListener('keydown', (e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              query = '';
              searchOpen = false;
              draw();
              col.querySelector<HTMLElement>('#dream-search-btn')?.focus();
            });
            tools.append(h('label', { class: 'pg-search' }, h('span', { class: 'pg-search-icon', html: icon('search', 14) }), field));
          } else
            tools.append(
              toolIcon('search', 'Search projects', () => {
                searchOpen = true;
                draw();
                col.querySelector<HTMLInputElement>('#dream-search')?.focus();
              }, { id: 'dream-search-btn' }),
            );
          tools.append(
            toolIcon('sliders', `Filter: ${PROJECT_FILTERS.find((f) => f.value === filter)!.label}`, (b) => choiceMenu(b, 'Show', PROJECT_FILTERS, filter, (v) => {
              filter = v;
              draw();
            }), { on: filter !== 'all', menu: true, id: 'dream-filter' }),
            toolIcon('list', `Sort: ${PROJECT_SORTS.find((s) => s.value === sort)!.label}`, (b) => choiceMenu(b, 'Sort by', PROJECT_SORTS, sort, (v) => {
              sort = v;
              draw();
            }), { on: sort !== 'recent', menu: true, id: 'dream-sort' }),
          );
        }
        tools.append(toolIcon('settings', 'Dreaming settings', () => openSettings(), { id: 'dream-settings-btn' }), runButton());
        col.append(h('div', { class: 'pg-toolbar' }, tabs, h('span', { class: 'spacer' }), tools));
        col.append(bannerNow());
        if (runNote) col.append(h('p', { class: 'pg-run-note', id: 'dream-run-note', role: 'status' }, runNote));
        col.append(h('div', { class: 'pg-body', id: 'dreaming-body', role: 'tabpanel', 'aria-label': tab === 'projects' ? 'Projects' : 'Suggestions' }));
        drawBody();
      });
    }

    function drawBody(): void {
      const body = col.querySelector<HTMLElement>('#dreaming-body');
      if (!body) return;
      keepFocus(body, () => {
        body.innerHTML = '';
        if (tab === 'suggestions') return void body.append(suggestions());
        const all = dreamProjects(state(), projects);
        if (!all.length) return void body.append(emptyState());
        const shown = shownProjects(all, { query, filter, sort });
        if (!shown.length) {
          const clear = h('button', { type: 'button', class: 'link-btn' }, 'Show every project');
          clear.addEventListener('click', () => {
            query = '';
            searchOpen = false;
            filter = 'all';
            draw();
          });
          body.append(h('div', { class: 'pg-none' }, h('p', {}, query ? `No project matches “${query.trim()}”.` : 'No project is like that now.'), clear));
          return;
        }
        const grid = h('ul', { class: 'pg-grid', 'aria-label': 'Projects' });
        for (const c of shown) grid.append(h('li', {}, projectCard(c, host)));
        body.append(grid);
      });
    }

    function emptyState(): HTMLElement {
      const runB = h('button', { type: 'button', class: 'btn primary', id: 'dream-empty-run' }, h('span', { html: icon('moon', 14) }), h('span', {}, 'Run a dream'));
      runB.addEventListener('click', () => void run(undefined, runB));
      return h(
        'div',
        { class: 'pg-empty', id: 'dreaming-empty' },
        h('span', { class: 'pg-empty-icon', html: icon('moon', 20) }),
        h('h2', { class: 'pg-empty-title' }, 'No dreams yet'),
        h('p', { class: 'pg-empty-text' }, 'A dream reads what happened in your recent sessions of a project and suggests skills, mods and memory that would help the agent work better for you. It reads; it changes nothing by itself unless the mode is Auto. Projects show here once they have sessions to dream about.'),
        h('div', { class: 'pg-empty-actions' }, runB),
      );
    }

    function suggestions(): HTMLElement {
      const box = h('div', { class: 'pg-suggestions', id: 'dream-suggestions' });
      const dreams = (state()?.dreams ?? []).filter((x) => dreamWaiting(x) > 0);
      if (!dreams.length) {
        box.append(h('div', { class: 'pg-nothing' }, 'Nothing waits for you. Suggestions from dreams in Approve or Plan mode wait here until you apply or dismiss them.'));
        return box;
      }
      for (const dr of dreams) {
        const n = dreamWaiting(dr);
        const open = h('button', { type: 'button', class: 'link-btn', 'data-session': dr.sessionId }, 'Open its session');
        open.addEventListener('click', () => d.openSession(dr.sessionId));
        if (!d.sessions().some((m) => m.id === dr.sessionId)) open.disabled = true;
        const head = h('div', { class: 'pg-sugg-head' }, h('div', { class: 'pg-sugg-text' }, h('h2', { class: 'pg-h2' }, folderName(dr.cwd)), h('span', { class: 'pg-row-meta' }, `${formatWhenAt(dr.startedAt)} · ${n} waiting · ${MODE_WORDS[dr.mode]}`)), open);
        if (n > 1) {
          const all = h('button', { type: 'button', class: 'btn sm primary dream-apply-all', 'data-dream': dr.id }, `Apply all ${n}`);
          all.addEventListener('click', async () => {
            all.disabled = true;
            try {
              await rpc('dreaming.applyAll', dr.id);
            } catch (err) {
              d.showError(all, d.cleanError(err));
            } finally {
              all.disabled = false;
              await refreshDreaming();
            }
          });
          head.append(all);
        }
        const group = h('section', { class: 'pg-sugg', 'data-dream': dr.id }, head);
        for (const p of dr.proposals) if (p.state === 'waiting' || p.state === 'planned') group.append(proposalCard(p.id));
        box.append(group);
      }
      return box;
    }

    draw();
    void loadProjects();
    mounted = { route, update: draw };
    return {
      route: () => ({ page: 'dreaming', tab }),
      dispose: () => {
        if (mounted?.route === route) mounted = null;
        runNote = '';
      },
    };
  }

  function projectCard(c: DreamProjectCard, host: PageHost): HTMLElement {
    const conf = cfg();
    const foot = projectFooter(c, conf);
    const mode = MODE_WORDS[conf?.mode ?? 'approve'];
    const b = h(
      'button',
      { type: 'button', class: `pg-card project-card${c.waiting ? ' waiting' : ''}`, 'data-project': c.cwd, 'data-focus': `project:${c.cwd}`, 'aria-label': `${c.name}, ${mode}, ${foot}`, title: tilde(c.cwd) },
      h('span', { class: 'pg-card-head' }, h('span', { class: 'pg-card-title' }, c.name), h('span', { class: 'pg-chip' }, mode)),
      h('span', { class: 'pg-card-text' }, dreamSummary(c.dreams[0])),
      h('span', { class: 'pg-card-foot' }, c.running ? h('span', { class: 'spinner sm pg-card-spin', 'aria-hidden': 'true' }) : c.waiting ? h('span', { class: 'pg-dot attention', 'aria-hidden': 'true' }) : null, h('span', {}, foot)),
    );
    b.addEventListener('click', () => host.open({ page: 'project', cwd: c.cwd }));
    return b;
  }

  // ---------- A project's page ----------

  function renderProject(route: Extract<PageRoute, { page: 'project' }>, root: HTMLElement, host: PageHost): PageHandle {
    const col = h('div', { class: 'pg-col pg-detail-page', 'data-project-page': route.cwd });
    root.append(col);
    const handle: PageHandle = {};
    const name = folderName(route.cwd);
    handle.crumbs = {
      parent: { label: 'Dreaming', route: { page: 'dreaming' } },
      title: name,
      menu: () => [
        {
          items: state()?.running
            ? [{ label: 'Stop the dream', icon: 'square' as const, onSelect: () => void stop() }]
            : [{ label: 'Run a dream now', icon: 'play' as const, onSelect: () => void run(route.cwd, col) }],
        },
        { items: [{ label: 'Dreaming settings…', icon: 'settings' as const, onSelect: () => openSettings() }] },
      ],
    };

    function draw(): void {
      const s = state();
      const c = s?.config;
      const dreams = (s?.dreams ?? []).filter((x) => x.cwd === route.cwd).sort((a, b) => b.startedAt - a.startedAt);
      const info = projects.find((p) => p.cwd === route.cwd);
      keepFocus(col, () => {
        col.innerHTML = '';
        const runningHere = s?.running?.cwd === route.cwd;
        let action: HTMLElement;
        if (s?.running) {
          action = h('button', { type: 'button', class: 'btn sm', id: 'project-stop', 'data-focus': 'project-run' }, h('span', { html: icon('square', 14) }), h('span', {}, runningHere ? 'Stop the dream' : `Stop the dream about ${folderName(s.running.cwd)}`));
          action.addEventListener('click', () => void stop());
        } else {
          action = h('button', { type: 'button', class: 'btn sm', id: 'project-run', 'data-focus': 'project-run' }, h('span', { html: icon('play', 14) }), h('span', {}, 'Run a dream now'));
          action.addEventListener('click', () => void run(route.cwd, action));
        }
        const sub = runningHere ? 'Dreaming now…' : c?.daily && s?.nextRunAt ? `Next dream: ${formatWhenAt(s.nextRunAt)}${info && !info.fresh ? ', if there is something new by then' : ''}` : 'The daily dream is off';
        col.append(pageHead(name, { chip: MODE_WORDS[c?.mode ?? 'approve'], sub, actions: h('div', { class: 'pg-head-actions' }, action) }));
        if (runNote) col.append(h('p', { class: 'pg-run-note', id: 'dream-run-note', role: 'status' }, runNote));
        col.append(h('hr', { class: 'pg-rule' }));
        const main = h('section', { class: 'pg-main', 'aria-labelledby': 'project-history-title' }, h('h2', { class: 'pg-h2', id: 'project-history-title' }, 'History'));
        if (!dreams.length) main.append(h('div', { class: 'pg-nothing', id: 'project-no-dreams' }, info?.fresh ? `No dreams yet. The next one reads ${info.fresh} session${info.fresh === 1 ? '' : 's'}.` : 'No dreams yet'));
        else {
          const list = h('ul', { class: 'pg-rows', id: 'project-dreams', 'aria-label': 'Dreams, newest first' });
          for (const dr of dreams) list.append(h('li', {}, dreamRow(dr)));
          main.append(list);
        }
        const side = h('aside', { class: 'pg-side', 'aria-label': 'Dreaming settings' });
        side.append(h('p', { class: 'pg-side-kicker' }, 'Settings · for every project'));
        side.append(...settingsBlocks('project'));
        side.append(sideSection('Project', h('div', { class: 'pg-folder', title: route.cwd }, h('span', { class: 'pg-folder-icon', html: icon('folder', 14) }), h('span', { class: 'pg-folder-name' }, name)), h('p', { class: 'pg-side-note mono' }, tilde(route.cwd)), info ? h('p', { class: 'pg-side-note' }, info.fresh ? `${info.fresh} session${info.fresh === 1 ? '' : 's'} with activity since its last dream.` : 'Nothing new since its last dream.') : null));
        side.append(sideSection('Privacy', h('p', { class: 'pg-side-note' }, PRIVACY)));
        col.append(h('div', { class: 'pg-detail' }, main, side));
      });
      host.syncCrumbs();
    }

    function dreamRow(dr: Dream): HTMLElement {
      const st = dreamStatus(dr);
      const exists = d.sessions().some((m) => m.id === dr.sessionId);
      const glyph = st.tone === 'run' ? '<span class="spinner sm" aria-hidden="true"></span>' : st.tone === 'wait' ? '<span class="pg-dot attention" aria-hidden="true"></span>' : st.tone === 'bad' ? icon('circle-alert', 14) : st.tone === 'ok' ? icon('circle-check', 14) : icon('moon', 14);
      const tone = st.tone === 'run' ? 'running' : st.tone === 'wait' ? 'waiting' : st.tone === 'bad' ? 'failed' : st.tone === 'ok' ? 'done' : 'quiet';
      const when = formatWhenAt(dr.startedAt);
      const meta = `${TRIGGER_WORDS[dr.trigger] ?? dr.trigger} · ${MODE_WORDS[dr.mode]} · read ${dr.covered.sessions} session${dr.covered.sessions === 1 ? '' : 's'}`;
      const b = h(
        'button',
        { type: 'button', class: `pg-row dream-row ${tone}`, 'data-dream': dr.id, 'data-session': dr.sessionId, 'data-focus': `dream:${dr.id}`, disabled: !exists, 'aria-label': `Dream of ${when}, ${meta}, ${st.text}${exists ? '' : ', its session was deleted'}` },
        h('span', { class: `pg-row-glyph ${tone}`, html: glyph }),
        h('span', { class: 'pg-row-text' }, h('span', { class: 'pg-row-title' }, when), h('span', { class: 'pg-row-meta' }, meta)),
        h('span', { class: `pg-row-state ${tone}`, title: st.text }, st.text),
      );
      b.addEventListener('click', () => d.openSession(dr.sessionId));
      return b;
    }

    draw();
    void loadProjects();
    mounted = { route, update: draw };
    handle.dispose = () => {
      if (mounted?.route === route) mounted = null;
      runNote = '';
    };
    return handle;
  }

  function sideSection(title: string, ...body: (Node | null)[]): HTMLElement {
    return h('section', { class: 'pg-side-sec' }, h('h3', { class: 'pg-h3' }, title), ...body);
  }

  return {
    render(route, root, host) {
      if (absent) return null;
      if (route.page === 'dreaming') return renderList(route, root, host);
      if (route.page === 'project') return renderProject(route, root, host);
      return null;
    },
    present: () => (absent === null ? null : !absent),
    debug: {
      state: () => ({ projects: projects.map((p) => ({ ...p })), cards: dreamProjects(state() as DreamingState | null, projects).map((c) => ({ cwd: c.cwd, dreams: c.dreams.length, waiting: c.waiting, next: c.next })), filter, sort, query, settings: settingsDialog?.open ?? false }),
    },
  };
}
