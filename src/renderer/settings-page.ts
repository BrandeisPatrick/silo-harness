// The settings page: a large modal with the sections on the left and one section's rows on the right. Every change
// applies at once (no Save): switches, selects and segmented controls write when they change, text fields when they
// are committed and valid. The sections live in src/renderer/settings/; this file is the page around them: the
// navigation, the search, opening at a section or a field, the settings.json read-only fields, and the debug mock
// that stands in for features this build does not have.

import type { AppConfig } from '../shared/types';
import type { RpcMethods } from '../shared/rpc';
import type { AppInfo, SettingsInfo } from '../shared/settings-info';
import type { HistoryStats, TrashEntry } from '../shared/history';
import type { ConfirmOptions } from './changes.js';
import type { McpPanel } from './mcp.js';
import type { RulesPanel } from './rules.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { onPush, rpc } from './rpc.js';
import { bus } from './bus.js';
import { getPath, matchesQuery, patchFor, SECTIONS, sectionForTarget, tabForTarget, isSectionId, type SectionId } from './settings/model.js';
import { row, segmented, selectControl, switchControl, textControl, type Row } from './settings/ui.js';
import type { Call, Ctx, Section } from './settings/ctx.js';
import { contextSection, generalSection, modelSection, permissionsSection } from './settings/config-sections.js';
import { modsSection } from './settings/mods-section.js';
import { pagesSection, remoteSection, skillsSection } from './settings/feature-sections.js';
import { aboutSection, appearanceSection, filesSection, historySection, mcpSection } from './settings/info-sections.js';
import { hooksSection } from './settings/hooks-section.js';

export interface SettingsPageDeps {
  dialog: HTMLDialogElement;
  config(): AppConfig;
  /** The window's copy becomes this config (and everything that follows it updates) */
  adoptConfig(next: AppConfig): void;
  mcpPanel: McpPanel;
  rulesPanel: RulesPanel;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  cleanError(err: unknown): string;
  chooseFolder(): Promise<boolean>;
  openShortcuts(): void;
  currentSessionId(): string;
  /** Brings a session on screen (Settings closes first) */
  openSession(id: string): void;
  /** Opens the Scheduled tasks page (and its New task form) or the Dreaming page; Settings closes first */
  openPage(target: 'scheduled' | 'scheduled:new' | 'dreaming'): void;
  sessionTitle(id: string): string | undefined;
  /** Puts text in the composer (Settings closes first) */
  fillComposer(text: string): void;
  /** Live previews of mod backgrounds for Settings → Mods → Background */
  modPreviews?(): import('./mods-host.js').ModPreviews | null;
  /** Before the page opens (close menus and sheets, hide the browser view); false keeps it closed */
  beforeOpen(): boolean;
  /** After it closed (the browser view may come back) */
  afterClose(): void;
}

/** Fake data for features this build does not have (window.__oc_debug.settings.mock). */
export interface SettingsMock {
  /** settings.info and the rest of the settings.* methods work on this copy */
  info?: SettingsInfo | null;
  app?: AppInfo | null;
  history?: { stats: HistoryStats; trash: TrashEntry[] } | null;
  /** Methods to treat as unknown, to see a section hide itself */
  absent?: string[];
}

export interface SettingsDebug {
  /** Serves settings.*, app.* and history.* from this data instead of the main process (null goes back to it) */
  mock(data: SettingsMock | null): void;
  /** The bridge calls the page made while a mock was set, oldest first */
  calls(): { method: string; args: unknown[] }[];
  /** Which section is open (and the tab of a section that has tabs), the search text, and the sections hidden because their feature is absent */
  state(): { open: boolean; section: SectionId; tab: string | null; query: string; hidden: SectionId[] };
  /** The same as openSettings(target, opts) */
  open(target?: string, opts?: OpenOptions): void;
}

export interface OpenOptions {
  /** A tab of the section: Mods has mods, backgrounds, chat-bar, conversation and themes */
  tab?: string;
  /** On a look tab of Mods: the version to show in its preview ("<mod key>/<id>", a theme's mod key) */
  preview?: string;
}

export interface SettingsPage {
  /**
   * Opens at the section last open, or at `target`: a section id ("mods"), a section and a tab ("mods:backgrounds",
   * or "mods" with { tab: 'backgrounds' }), or the id of an element on the page (its tab comes on screen with it)
   */
  open(target?: string, opts?: OpenOptions): void;
  close(): void;
  readonly debug: SettingsDebug;
}

const LAST_SECTION_KEY = 'settings.section';

interface Binding {
  field: string;
  row: Row;
  set(value: unknown): void;
  /** The controls a settings.json file can lock */
  controls(): (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement)[];
}

export function createSettingsPage(deps: SettingsPageDeps): SettingsPage {
  const { dialog } = deps;
  const navEl = dialog.querySelector<HTMLElement>('#settings-nav')!;
  const searchInput = dialog.querySelector<HTMLInputElement>('#settings-search')!;
  const body = dialog.querySelector<HTMLElement>('#settings-body')!;
  const emptyEl = dialog.querySelector<HTMLElement>('#settings-empty')!;
  const closeBtn = dialog.querySelector<HTMLButtonElement>('#settings-close')!;

  let current: SectionId = 'general';
  try {
    const saved = localStorage.getItem(LAST_SECTION_KEY);
    if (isSectionId(saved)) current = saved;
  } catch {
    /* no storage: start at General */
  }
  let query = '';
  let built = false;
  let sections: Section[] = [];
  const hidden = new Set<SectionId>();
  const navItems = new Map<SectionId, HTMLButtonElement>();
  const bindings: Binding[] = [];
  let owned: SettingsInfo['owned'] = {};
  let ownedFiles: Record<string, string> = {};
  let mock: SettingsMock | null = null;
  const callLog: { method: string; args: unknown[] }[] = [];

  // ---------- The bridge, with the mock in front ----------

  const unknownError = (method: string) => new Error(`Unknown RPC method ${method}`);
  const isUnknown = (err: unknown) => /Unknown RPC method|No handler registered/.test(err instanceof Error ? err.message : String(err));

  const call = (async (method: keyof RpcMethods, ...args: unknown[]) => {
    if (mock) {
      if (mock.absent?.includes(method)) throw unknownError(method);
      const handled = mockCall(method, args);
      if (handled) {
        callLog.push({ method, args });
        return await handled.value;
      }
    }
    return (rpc as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args);
  }) as Call;

  /** The mocked methods; null for a method the mock does not cover (it goes to the main process). */
  function mockCall(method: keyof RpcMethods, args: unknown[]): { value: unknown } | null {
    const m = mock!;
    const ns = method.split('.')[0];
    if (ns === 'settings' && m.info !== undefined) {
      if (!m.info) throw unknownError(method);
      const info = m.info;
      switch (method) {
        case 'settings.info':
        case 'settings.reload':
          return { value: structuredClone(info) };
        case 'settings.trustProject': {
          const trust = Boolean(args[0]);
          for (const f of info.files) {
            if (f.scope !== 'project' || !f.exists || f.error) continue;
            f.trusted = trust;
            f.applied = trust;
            f.changed = false;
            for (const k of f.keys) {
              if (trust) info.owned[k] = 'project';
              else if (info.owned[k] === 'project') delete info.owned[k];
            }
          }
          return { value: structuredClone(info) };
        }
        case 'settings.open':
          return { value: undefined };
      }
    }
    if (ns === 'app' && m.app !== undefined) {
      if (!m.app) throw unknownError(method);
      if (method === 'app.info') return { value: { ...m.app } };
      if (method === 'app.reveal') return { value: undefined };
    }
    if (ns === 'history' && m.history !== undefined) {
      if (!m.history) throw unknownError(method);
      const hist = m.history;
      switch (method) {
        case 'history.stats':
          return { value: { ...hist.stats, trash: hist.trash.length, trashBytes: hist.trash.reduce((n, e) => n + e.bytes, 0) } };
        case 'history.trash':
          return { value: hist.trash.map((e) => ({ ...e })) };
        case 'history.restore': {
          const e = hist.trash.find((x) => x.id === args[0]);
          if (!e) throw new Error('That session is no longer in the trash.');
          hist.trash = hist.trash.filter((x) => x !== e);
          hist.stats.sessions++;
          return { value: { id: e.id, title: e.title, createdAt: e.deletedAt, updatedAt: e.deletedAt, messageCount: e.messageCount } };
        }
        case 'history.purge':
          hist.trash = args[0] ? hist.trash.filter((x) => x.id !== args[0]) : [];
          return { value: hist.trash.map((e) => ({ ...e })) };
        case 'history.reveal':
          return { value: undefined };
      }
    }
    return null;
  }

  // ---------- Saving ----------

  function adopt(next: AppConfig): void {
    if (next && typeof next === 'object') deps.adoptConfig(next);
  }

  async function savePatch(r: Row, patch: Partial<AppConfig>): Promise<boolean> {
    try {
      const next = await window.oc.setConfig(patch as AppConfig);
      adopt(next);
      r.problem(null);
      r.saved();
      return true;
    } catch (err) {
      r.problem(`Couldn't save: ${deps.cleanError(err)}`);
      return false;
    }
  }

  const save = (r: Row, field: string, value: unknown) => (isOwned(field) ? Promise.resolve(false) : savePatch(r, patchFor(field, value)));

  // ---------- Bound fields ----------

  function bind(field: string, r: Row, set: (v: unknown) => void): void {
    bindings.push({ field, row: r, set, controls: () => [...r.control.querySelectorAll<HTMLInputElement>('input, select, textarea, button')] });
  }

  const ctx: Ctx = {
    config: () => deps.config(),
    call,
    isUnknown,
    cleanError: deps.cleanError,
    confirm: deps.confirm,
    save,
    savePatch,
    adopt,
    switchField(o) {
      const read = () => Boolean(getPath(deps.config(), o.field)) !== Boolean(o.invert);
      const input = switchControl(read(), (on) => void save(r, o.field, o.invert ? !on : on).then((ok) => !ok && (input.checked = read())));
      const r = row(o, input);
      r.el.classList.add('clickable');
      bind(o.field, r, (v) => (input.checked = Boolean(v) !== Boolean(o.invert)));
      return r;
    },
    textField(o) {
      const format = o.format ?? ((v: unknown) => (v === undefined || v === null ? '' : String(v)));
      const ctl = textControl({
        value: format(getPath(deps.config(), o.field)),
        placeholder: o.placeholder,
        type: o.type,
        width: o.width,
        mono: o.mono,
        id: o.inputId,
        multiline: o.multiline,
        onCommit: async (text) => {
          const parsed = o.parse(text);
          if (!parsed.ok) {
            r.problem(parsed.error);
            return;
          }
          if (parsed.value === getPath(deps.config(), o.field)) {
            r.problem(null);
            ctl.set(format(parsed.value));
            return;
          }
          if (await save(r, o.field, parsed.value)) ctl.set(format(getPath(deps.config(), o.field)));
        },
      });
      const r = row({ ...o, full: o.full ?? o.multiline }, ctl);
      bind(o.field, r, (v) => {
        if (document.activeElement !== ctl.input && !r.el.classList.contains('invalid')) ctl.set(format(v));
      });
      return r;
    },
    selectField(o) {
      const read = (v: unknown) => (o.read ? o.read(v) : (v as never));
      const ctl = selectControl(o.choices, read(getPath(deps.config(), o.field)), (v) => {
        void save(r, o.field, v).then((ok) => {
          if (ok) o.onSaved?.(v);
          else ctl.set(read(getPath(deps.config(), o.field)));
        });
      }, o.width);
      if (o.inputId) ctl.select.id = o.inputId;
      const r = row(o, ctl);
      bind(o.field, r, (v) => ctl.set(read(v)));
      return r;
    },
    segField(o) {
      const read = (v: unknown) => (o.read ? o.read(v) : (v as never));
      const ctl = segmented(o.choices, read(getPath(deps.config(), o.field)), (v) => {
        void save(r, o.field, v).then((ok) => {
          if (ok) o.onSaved?.(v);
          else ctl.set(read(getPath(deps.config(), o.field)));
        });
      });
      const r = row(o, ctl);
      bind(o.field, r, (v) => ctl.set(read(v)));
      return r;
    },
    show: (id, opts) => {
      clearSearch(false);
      showSection(id);
      if (opts?.tab) sections.find((s) => s.id === id)?.showTab?.(opts.tab);
      if (opts?.row) reveal(document.getElementById(`sp-row-${opts.row}`));
    },
    refreshSearch: () => {
      if (query) applySearch();
    },
    chooseFolder: deps.chooseFolder,
    openShortcuts: () => {
      dialog.close();
      deps.openShortcuts();
    },
    currentSessionId: deps.currentSessionId,
    openSession: (id) => {
      dialog.close();
      deps.openSession(id);
    },
    sessionTitle: (id) => deps.sessionTitle(id),
    askAgent: (text) => {
      dialog.close();
      deps.fillComposer(text);
    },
    modPreviews: () => deps.modPreviews?.() ?? null,
  };

  // ---------- Building ----------

  function build(): void {
    if (built) return;
    built = true;
    sections = [
      generalSection(ctx),
      modelSection(ctx),
      permissionsSection(ctx, document.getElementById('rules-section')!),
      contextSection(ctx),
      modsSection(ctx),
      mcpSection(ctx, document.getElementById('mcp-section')!),
      skillsSection(ctx),
      remoteSection(ctx),
      historySection(ctx),
      appearanceSection(ctx),
      filesSection(ctx, (info) => applyOwned(info)),
      hooksSection(ctx),
      aboutSection(ctx),
    ];
    // First in the page, so a search for Scheduled or Dreaming lists the page above rows that only mention it
    sections.unshift(
      pagesSection((target) => {
        dialog.close();
        deps.openPage(target);
      }),
    );
    for (const s of sections) {
      s.el.classList.add('sp-section');
      s.el.id = `sp-sec-${s.id}`;
      s.el.dataset.section = s.id;
      s.el.setAttribute('role', 'tabpanel');
      s.el.setAttribute('aria-labelledby', `sp-nav-${s.id}`);
      s.el.tabIndex = -1;
      const title = SECTIONS.find((x) => x.id === s.id)!.title;
      for (const r of s.el.querySelectorAll<HTMLElement>('.sp-row')) r.dataset.section = title;
      body.insertBefore(s.el, emptyEl);
    }
    buildNav();
    // A row a section adds later (a mod, a schedule) is searched by the same rules.
    new MutationObserver(() => {
      for (const s of sections) {
        const title = SECTIONS.find((x) => x.id === s.id)!.title;
        for (const r of s.el.querySelectorAll<HTMLElement>('.sp-row:not([data-section])')) r.dataset.section = title;
      }
    }).observe(body, { childList: true, subtree: true });
  }

  function buildNav(): void {
    navEl.innerHTML = '';
    let group = -1;
    for (const s of SECTIONS) {
      if (s.searchOnly) continue;
      if (group !== -1 && s.group !== group) navEl.append(h('div', { class: 'sp-nav-sep', role: 'presentation' }));
      group = s.group;
      const btn = h('button', { type: 'button', class: 'sp-nav-item', id: `sp-nav-${s.id}`, role: 'tab', 'aria-controls': `sp-sec-${s.id}`, 'data-section': s.id });
      btn.innerHTML = `${icon(s.icon)}<span>${s.title}</span>`;
      btn.addEventListener('click', () => {
        clearSearch(false);
        showSection(s.id);
      });
      navItems.set(s.id, btn);
      navEl.append(btn);
    }
    syncNavSeparators();
  }

  /** A separator only between two visible groups. */
  function syncNavSeparators(): void {
    const kids = [...navEl.children] as HTMLElement[];
    let seenItem = false;
    let pendingSep: HTMLElement | null = null;
    for (const k of kids) {
      if (k.classList.contains('sp-nav-sep')) {
        k.hidden = true;
        if (seenItem) pendingSep = k;
      } else if (!k.hidden) {
        if (pendingSep) pendingSep.hidden = false;
        pendingSep = null;
        seenItem = true;
      }
    }
  }

  navEl.addEventListener('keydown', (e) => {
    const items = [...navItems.values()].filter((b) => !b.hidden);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusFirstControl();
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
    clearSearch(false);
    showSection(items[next].dataset.section as SectionId);
  });

  function focusFirstControl(): void {
    const sec = sections.find((s) => s.id === current);
    const el = sec?.el.querySelector<HTMLElement>('.sp-row:not(.provider-off) input:not([disabled]), .sp-row:not(.provider-off) select:not([disabled]), .sp-row:not(.provider-off) textarea:not([disabled]), .sp-row:not(.provider-off) button:not([disabled])');
    (el ?? sec?.el)?.focus();
  }

  // ---------- Sections on screen ----------

  function showSection(id: SectionId): void {
    if (hidden.has(id)) id = 'general';
    current = id;
    try {
      localStorage.setItem(LAST_SECTION_KEY, id);
    } catch {
      /* not remembered */
    }
    for (const s of sections) s.el.classList.toggle('current', s.id === id);
    for (const [sid, btn] of navItems) {
      const on = sid === id && !query;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(sid === id));
      btn.tabIndex = sid === id ? 0 : -1;
    }
    body.scrollTop = 0;
  }

  function setHidden(id: SectionId, hide: boolean): void {
    const s = sections.find((x) => x.id === id);
    if (!s) return;
    if (hide) hidden.add(id);
    else hidden.delete(id);
    s.el.hidden = hide;
    const btn = navItems.get(id);
    if (btn) btn.hidden = hide;
    syncNavSeparators();
    if (hide && current === id) showSection('general');
    if (query) applySearch();
  }

  /** Scrolls a row (or the row holding an element) into view, on its tab, and gives it a brief highlight. */
  function reveal(el: HTMLElement | null): void {
    if (!el) return;
    const owner = el.closest<HTMLElement>('.sp-section')?.dataset.section;
    sections.find((s) => s.id === owner)?.uncover?.(el);
    const r = el.closest<HTMLElement>('.sp-row') ?? el;
    r.closest('.sp-advanced')?.classList.add('open');
    requestAnimationFrame(() => {
      r.scrollIntoView({ block: 'center' });
      r.classList.remove('flash');
      void r.offsetWidth;
      r.classList.add('flash');
      const focusable = el.matches('input, select, textarea, button') ? el : r.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea');
      focusable?.focus({ preventScroll: true });
    });
  }

  // ---------- Search ----------

  function applySearch(): void {
    const searching = query.trim() !== '';
    body.classList.toggle('searching', searching);
    navEl.classList.toggle('searching', searching);
    let any = false;
    for (const s of sections) {
      let hits = 0;
      if (!hidden.has(s.id)) {
        for (const r of s.el.querySelectorAll<HTMLElement>('.sp-row')) {
          const hit = searching && matchesQuery([r.dataset.search, r.dataset.section], query);
          r.classList.toggle('hit', hit);
          if (hit) hits++;
        }
        for (const g of s.el.querySelectorAll<HTMLElement>('.sp-group')) g.classList.toggle('has-hit', Boolean(g.querySelector('.sp-row.hit')));
      }
      s.el.classList.toggle('has-hit', hits > 0);
      navItems.get(s.id)?.classList.toggle('dim', searching && hits === 0);
      navItems.get(s.id)?.classList.toggle('active', !searching && s.id === current);
      any ||= hits > 0;
    }
    emptyEl.hidden = !searching || any;
    if (searching && !any) emptyEl.querySelector('.sp-empty-text')!.textContent = `No settings match “${query.trim()}”.`;
    if (searching) body.scrollTop = 0;
  }

  function clearSearch(restore = true): void {
    if (!query && !searchInput.value) return;
    query = '';
    searchInput.value = '';
    applySearch();
    if (restore) showSection(current);
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    applySearch();
    if (!query) showSection(current);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      navItems.get(current)?.focus();
    } else if (e.key === 'Enter' && query) {
      // Enter goes to the first match: its section (and tab) on screen, its control focused.
      const first = [...body.querySelectorAll<HTMLElement>('.sp-section.has-hit .sp-row.hit')].find((r) => r.offsetParent);
      if (first) {
        e.preventDefault();
        goTo(first);
      }
    }
  });

  /** Chooses a search hit: the search clears and the row comes on screen in its section, on its tab. */
  function goTo(r: HTMLElement): void {
    const owner = r.closest<HTMLElement>('.sp-section');
    if (!owner) return;
    // A row that stands for a page (Scheduled tasks, Dreaming) opens that page
    const page = r.dataset.page;
    if (page === 'scheduled' || page === 'scheduled:new' || page === 'dreaming') {
      clearSearch(false);
      dialog.close();
      deps.openPage(page);
      return;
    }
    clearSearch(false);
    showSection(owner.dataset.section as SectionId);
    reveal(r);
    // Focus now too: reveal() scrolls on the next frame, which a hidden window may not draw
    r.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])')?.focus({ preventScroll: true });
  }

  // A click on a hit (not on its control) while searching chooses it.
  body.addEventListener('click', (e) => {
    if (!query) return;
    const t = e.target as HTMLElement;
    const r = t.closest<HTMLElement>('.sp-row.hit');
    if (!r || t.closest('input, select, textarea, button, a, label, .sp-row-control, .sp-mod-detail')) return;
    goTo(r);
  });

  // ---------- settings.json: fields a file owns are read-only here ----------

  function isOwned(field: string): boolean {
    return ownerOf(field) !== null;
  }

  function ownerOf(field: string): 'user' | 'project' | null {
    const parts = field.split('.');
    for (let i = parts.length; i > 0; i--) {
      const o = owned[parts.slice(0, i).join('.')];
      if (o) return o;
    }
    return null;
  }

  function applyOwned(info: SettingsInfo | null): void {
    owned = info?.owned ?? {};
    ownedFiles = {};
    for (const f of info?.files ?? []) ownedFiles[f.scope] = f.path;
    for (const b of bindings) {
      const owner = ownerOf(b.field);
      for (const c of b.controls()) c.disabled = Boolean(owner);
      b.row.el.classList.toggle('owned', Boolean(owner));
      let pill = b.row.el.querySelector<HTMLButtonElement>('.sp-owned');
      if (owner) {
        if (!pill) {
          pill = h('button', { type: 'button', class: 'sp-owned' }, 'Set in settings.json');
          pill.addEventListener('click', () => ctx.show('files'));
          b.row.el.querySelector('.sp-row-title')!.append(pill);
        }
        const path = ownedFiles[owner] ?? '';
        pill.title = path ? `${path} · open Configuration files` : 'Open Configuration files';
        pill.setAttribute('aria-label', `Set in settings.json${path ? ` (${path})` : ''}: open Configuration files`);
      } else pill?.remove();
    }
  }

  // ---------- Opening and closing ----------

  function sync(): void {
    const cfg = deps.config();
    if (!cfg || !built) return;
    for (const b of bindings) b.set(getPath(cfg, b.field));
    for (const s of sections) s.sync?.(cfg);
  }

  bus.on('config', () => {
    if (dialog.open) sync();
  });

  async function loadAll(): Promise<void> {
    await Promise.all(
      sections.map(async (s) => {
        if (!s.load) return;
        try {
          setHidden(s.id, (await s.load()) === 'absent');
        } catch (err) {
          // A section that failed for another reason stays, with its own message.
          console.warn(`[settings] ${s.id} failed to load:`, err);
        }
      }),
    );
  }

  function open(target?: string, opts?: OpenOptions): void {
    const t = typeof target === 'string' ? target : '';
    if (!dialog.open) {
      if (!deps.beforeOpen()) return;
      build();
      sync();
      deps.mcpPanel.resetMessages();
      deps.rulesPanel.resetMessages();
      clearSearch(false);
      showSection(current);
      dialog.showModal();
      void loadAll();
      void deps.mcpPanel.refresh();
      void deps.rulesPanel.refresh();
      if (!t) searchInput.focus({ preventScroll: true });
    }
    if (!t) return;
    const sec = sectionForTarget(t);
    if (sec) {
      clearSearch(false);
      showSection(sec);
      const tab = (opts && typeof opts.tab === 'string' ? opts.tab : null) ?? tabForTarget(t);
      if (tab) sections.find((s) => s.id === sec)?.showTab?.(tab, typeof opts?.preview === 'string' ? { preview: opts.preview } : undefined);
      navItems.get(sec)?.focus({ preventScroll: true });
      return;
    }
    const el = document.getElementById(t);
    const owner = el?.closest<HTMLElement>('.sp-section');
    if (!el || !owner) return;
    clearSearch(false);
    showSection(owner.dataset.section as SectionId);
    reveal(el);
  }

  closeBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (e) => {
    if (query) {
      e.preventDefault();
      clearSearch();
      searchInput.focus();
    }
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    for (const s of sections) s.closed?.();
    deps.afterClose();
  });

  // The files can change while the page is open (an edit, a trust answer elsewhere).
  onPush('settings:changed', (info) => {
    if (!mock?.info) applyOwned(info);
  });

  return {
    open,
    close: () => dialog.close(),
    debug: {
      mock(data) {
        mock = data && typeof data === 'object' ? structuredClone(data) : null;
        callLog.length = 0;
        if (dialog.open) void loadAll();
      },
      calls: () => callLog.map((c) => ({ method: c.method, args: [...c.args] })),
      state: () => ({ open: dialog.open, section: current, tab: sections.find((s) => s.id === current)?.tab?.() ?? null, query, hidden: [...hidden] }),
      open: (target, opts) => open(target, opts),
    },
  };
}
