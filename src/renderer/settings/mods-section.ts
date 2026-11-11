// Settings → Mods: a tab strip (Mods, Background, Chat bar, Conversation). The Mods tab lists the mods that add
// something (panels, side-pane tabs, composer strips, workers, slash commands), Built-in / Yours / This project, each
// with its switch, what it asks for, what it adds, its problems and its own settings, and safe mode, New ⌄ (From a
// template…, Install…) and Reload. The other three are the looks (look-tab.ts): no switches, a preview of what is in
// use or of the version tried, Use, and every version as a card. While searching, every card and every tab's rows are
// searched. Follows mods:changed live.

import type { LookKind, ModInfo, ModLookTarget, ModPermission, ModSettingField } from '../../shared/mods';
import { dirname, escapeHtml, h } from '../dom.js';
import { icon, isIconName } from '../icons.js';
import { onPush } from '../rpc.js';
import {
  deriveModId,
  grantSheet,
  isLookOnly,
  isModTab,
  LOOK_TABS,
  LOOK_WORDS,
  lookSets,
  lookTabOf,
  MOD_GROUPS,
  MOD_TABS,
  modChip,
  modIconFile,
  modTabs,
  parseInteger,
  permissionWords,
  SEAT_WORDS,
  validModId,
  type ModTab,
  type NewModKind,
} from './model.js';
import { lookTab, type LookTab } from './look-tab.js';
import { actions, button, chip, group, newMenu, row, sectionTitle, segmented, selectControl, switchControl, textControl, tildePath, type Row } from './ui.js';
import type { Ctx, Section } from './ctx.js';

const NEW_TITLE: Record<NewModKind, string> = { rail: 'New mod', tab: 'New mod', composer: 'New mod', worker: 'New mod', background: 'New background', 'look:composer': 'New chat bar look', 'look:conversation': 'New conversation look' };
const safeKey = (key: string) => key.replace(/[^a-z0-9-]+/gi, '_');

export function modsSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Mods'));

  let mods: ModInfo[] = [];
  const expanded = new Set<string>();
  let pendingRender = false;
  /** The tab on screen; kept while the app runs, so Settings reopens at it */
  let tab: ModTab = 'mods';

  // ---------- Toolbar: New ⌄ (From a template…, Install…), Reload ----------

  const status = h('div', { class: 'sp-inline-status', role: 'status', hidden: true });
  const showStatus = (text: string, error = false) => {
    status.hidden = !text;
    status.classList.toggle('error', error);
    status.innerHTML = text ? `${icon(error ? 'circle-alert' : 'circle-check', 14)}<span>${escapeHtml(text)}</span>` : '';
  };

  const { wrap: newWrap, btn: newBtn } = newMenu(
    () => [
      { label: 'From a template…', icon: 'file-plus', run: () => toggleForm(createForm) },
      { label: 'Install…', icon: 'download', run: () => toggleForm(installForm) },
    ],
    'sp-mods-new',
  );
  const reloadBtn = button('Reload', async (b) => {
    b.disabled = true;
    try {
      mods = await ctx.call('mods.reload');
      renderAll();
      showStatus('Mods reloaded.');
    } catch (err) {
      showStatus(`Couldn't reload: ${ctx.cleanError(err)}`, true);
    } finally {
      b.disabled = false;
    }
  }, { icon: 'refresh' });
  const toolbar = h('div', { class: 'sp-toolbar sp-only-browse' }, newWrap, reloadBtn);

  // Install: a folder or a Git URL
  const installInput = textControl({ value: '', placeholder: '~/Downloads/my-mod or https://github.com/you/mod.git', width: 420, mono: true, onCommit: () => {} });
  installInput.input.setAttribute('aria-label', 'Folder or Git URL');
  const installProblem = h('div', { class: 'sp-problem', role: 'alert', hidden: true });
  const doInstall = async (b: HTMLButtonElement) => {
    const source = installInput.input.value.trim();
    if (!source) return formProblem(installProblem, 'Enter a mod folder or a Git URL.');
    b.disabled = true;
    try {
      const made = await ctx.call('mods.install', source);
      formProblem(installProblem, null);
      installInput.set('');
      closeForms();
      expanded.add(made.key);
      mods = await ctx.call('mods.list');
      renderAll();
      if (isLookOnly(made.manifest)) {
        // A look lands on its tab, previewed there
        const t = LOOK_TABS.find((x) => modTabs(made).includes(x.tab));
        if (t) {
          const set = lookSets([made], 1)[0];
          showTab(t.tab, { preview: set?.[t.kind] ?? undefined });
        }
        lookStatus(`Installed ${made.manifest?.name ?? made.id}.`);
      } else showStatus(`Installed ${made.manifest?.name ?? made.id}. Turn it on to use it.`);
    } catch (err) {
      formProblem(installProblem, ctx.cleanError(err));
    } finally {
      b.disabled = false;
    }
  };
  installInput.input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void doInstall(installGo);
  });
  const installGo = button('Install', (b) => void doInstall(b), { primary: true });
  const installForm = h(
    'div',
    { class: 'sp-form sp-only-browse', hidden: true, role: 'group', 'aria-label': 'Install a mod' },
    h('div', { class: 'sp-form-title' }, 'Install a mod'),
    h('div', { class: 'sp-form-line' }, installInput, installGo, button('Cancel', () => closeForms())),
    installProblem,
  );

  // New mod: name → id, seat, user or project
  let idEdited = false;
  const nameInput = textControl({ value: '', placeholder: 'Word count', width: 220, onCommit: () => {} });
  nameInput.input.setAttribute('aria-label', 'Name of the new mod');
  const idInput = textControl({ value: '', placeholder: 'word-count', width: 180, mono: true, onCommit: () => {} });
  idInput.input.setAttribute('aria-label', 'Id of the new mod');
  nameInput.input.addEventListener('input', () => {
    if (!idEdited) idInput.input.value = deriveModId(nameInput.input.value);
  });
  idInput.input.addEventListener('input', () => (idEdited = idInput.input.value !== ''));
  // A view in a seat or a look for a region ("look:conversation"); preset to the tab's kind
  let seat: NewModKind = 'rail';
  const seatSel = selectControl<NewModKind>(
    [
      { value: 'rail', label: 'Rail panel' },
      { value: 'tab', label: 'Side pane tab' },
      { value: 'composer', label: 'Composer strip' },
      { value: 'background', label: 'Background' },
      { value: 'look:conversation', label: 'Conversation look' },
      { value: 'look:composer', label: 'Chat bar look' },
    ],
    'rail',
    (v) => (seat = v),
    180,
  );
  seatSel.select.setAttribute('aria-label', 'What it adds');
  let scope: 'user' | 'project' = 'user';
  const scopeSeg = segmented<'user' | 'project'>(
    [
      { value: 'user', label: 'Yours' },
      { value: 'project', label: 'This project' },
    ],
    'user',
    (v) => (scope = v),
  );
  scopeSeg.setAttribute('aria-label', 'Where the mod lives');
  const createProblem = h('div', { class: 'sp-problem', role: 'alert', hidden: true });
  /** A look tab that opened the form: the mod it writes shows there, previewed (and Finder does not open) */
  let madeHere: ((m: ModInfo) => void) | null = null;
  const createGo = button('Create', async (b) => {
    const name = nameInput.input.value.trim();
    const id = idInput.input.value.trim() || deriveModId(name);
    if (!name) return formProblem(createProblem, 'Give the mod a name.');
    if (!validModId(id)) return formProblem(createProblem, 'Use 2 to 40 lower-case letters, digits or -, starting with a letter.');
    b.disabled = true;
    try {
      const made = await ctx.call('mods.create', seat.startsWith('look:') ? { id, name, look: seat.slice(5) as ModLookTarget, scope } : { id, name, seat: seat as Exclude<NewModKind, `look:${string}`>, scope });
      formProblem(createProblem, null);
      nameInput.set('');
      idInput.set('');
      idEdited = false;
      const here = madeHere;
      closeForms();
      expanded.add(made.key);
      mods = await ctx.call('mods.list');
      const fresh = mods.find((m) => m.key === made.key) ?? made;
      if (here && isLookOnly(fresh.manifest)) {
        renderAll();
        here(fresh);
        lookStatus(`Created ${name} in ${tildePath(made.dir)}.`);
        return;
      }
      const madeTabs = modTabs(made);
      if (!madeTabs.includes(tab)) showTab(madeTabs[0]);
      renderAll();
      showStatus(isLookOnly(fresh.manifest) ? `Created ${name} in ${tildePath(made.dir)}.` : `Created ${name} in ${tildePath(made.dir)}. Turn it on to use it.`);
      void ctx.call('mods.reveal', made.key).catch(() => {});
    } catch (err) {
      formProblem(createProblem, ctx.cleanError(err));
    } finally {
      b.disabled = false;
    }
  }, { primary: true });
  const field = (label: string, control: HTMLElement) => h('label', { class: 'sp-form-field' }, h('span', { class: 'sp-form-label' }, label), control);
  const createTitle = h('div', { class: 'sp-form-title' }, 'New mod');
  const createForm = h(
    'div',
    { class: 'sp-form sp-only-browse', hidden: true, role: 'group', 'aria-label': 'Create a mod' },
    createTitle,
    h('p', { class: 'sp-form-hint' }, 'Writes a starter mod and opens its folder.'),
    h('div', { class: 'sp-form-grid' }, field('Name', nameInput), field('Id', idInput), field('Adds', seatSel), h('div', { class: 'sp-form-field' }, h('span', { class: 'sp-form-label' }, 'Where'), scopeSeg)),
    h('div', { class: 'sp-form-line end' }, button('Cancel', () => closeForms()), createGo),
    createProblem,
  );

  function formProblem(elp: HTMLElement, message: string | null): void {
    elp.hidden = !message;
    elp.innerHTML = message ? `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>` : '';
  }
  function closeForms(): void {
    installForm.hidden = true;
    createForm.hidden = true;
    newBtn.classList.remove('active');
    madeHere = null;
    // Back under the Mods tab's toolbar, where they live
    if (toolbar.nextElementSibling !== installForm) toolbar.after(installForm, createForm);
  }
  /** Opens a form under the toolbar (one at a time); picking the open one again closes it */
  function toggleForm(form: HTMLElement): void {
    const show = Boolean(form.hidden) || form.parentElement !== panel;
    closeForms();
    if (show && form === createForm) {
      seat = MOD_TABS.find((t) => t.id === tab)!.newKind;
      seatSel.set(seat);
      createTitle.textContent = NEW_TITLE[seat];
    }
    form.hidden = !show;
    newBtn.classList.toggle('active', show);
    if (show) form.querySelector<HTMLElement>('input')?.focus();
  }
  /** The New form in a look tab, preset to its kind; what it writes is handed to `made` */
  function openCreateIn(kind: NewModKind, slot: HTMLElement, made: (m: ModInfo) => void): void {
    closeForms();
    slot.append(createForm);
    seat = kind;
    seatSel.set(kind);
    createTitle.textContent = NEW_TITLE[kind];
    madeHere = made;
    createForm.hidden = false;
    createForm.querySelector<HTMLElement>('input')?.focus();
  }
  function openInstallIn(slot: HTMLElement): void {
    closeForms();
    slot.append(installForm);
    installForm.hidden = false;
    installForm.querySelector<HTMLElement>('input')?.focus();
  }

  // ---------- Safe mode ----------

  const safeInput = switchControl(false, async (on) => {
    try {
      mods = await ctx.call('mods.setSafeMode', on);
      safe.saved();
      safe.problem(null);
      renderAll();
    } catch (err) {
      safeInput.checked = !on;
      safe.problem(`Couldn't change safe mode: ${ctx.cleanError(err)}`);
    }
  });
  const safe = row({ id: 'mods-safe', title: 'Safe mode', desc: 'Turn off every mod that is not built in.', keywords: 'disable all off trouble' }, safeInput);
  safe.el.classList.add('clickable');

  const listEl = h('div', { class: 'sp-mod-list' });

  // ---------- Delete all custom mods: every folder in the user mods folder goes to the Trash (mods.removeAll) ----------

  const removeAllBtn = button('Delete all custom mods', async (b) => {
    const mine = mods.filter((m) => m.scope === 'user');
    if (!mine.length) return;
    const names = mine.map((m) => m.manifest?.name ?? m.id);
    const listed = names.length > 6 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const one = mine.length === 1;
    const inUse = mine.some((m) => m.inUse?.length);
    const ok = await ctx.confirm({
      title: 'Delete all custom mods?',
      description: `${one ? listed : `Your ${mine.length} mods, ${listed},`} move${one ? 's' : ''} to the Trash and ${one ? 'its' : 'their'} settings and permissions are forgotten${inUse ? `; looks in use go back to Default` : ''}.`,
      confirmLabel: 'Move to Trash',
      danger: true,
    });
    if (!ok) return;
    b.disabled = true;
    try {
      const r = await ctx.call('mods.removeAll');
      mods = r.mods;
      for (const key of r.removed) expanded.delete(key);
      removeAllRow.problem(null);
      renderAll();
      showStatus(r.removed.length ? `Moved ${r.removed.length === 1 ? 'one mod' : `${r.removed.length} mods`} to the Trash.` : 'No mods to delete.');
    } catch (err) {
      removeAllRow.problem(`Couldn't delete them: ${ctx.cleanError(err)}`);
      b.disabled = false;
    }
  }, { icon: 'trash', danger: true });
  removeAllBtn.disabled = true;
  const removeAllRow = row({ id: 'mods-remove-all', title: 'Delete all custom mods', desc: '', keywords: 'remove everything clear wipe reset erase uninstall yours user mods folder trash' }, removeAllBtn);
  const removeAllGroup = group(null, removeAllRow);

  /** The row follows the list: how many mods of yours there are and where their folders live */
  function renderRemoveAll(): void {
    const mine = mods.filter((m) => m.scope === 'user');
    removeAllRow.setDesc(mine.length ? `Moves your ${mine.length === 1 ? 'mod' : `${mine.length} mods`} in ${tildePath(dirname(mine[0].dir).replace(/\/$/, ''))} to the Trash.` : 'Moves your mods to the Trash.');
    removeAllBtn.disabled = !mine.length;
  }

  // ---------- The tab strip ----------

  const tabsEl = h('div', { class: 'sp-tabs sp-only-browse', role: 'tablist', 'aria-label': 'Kinds of mod' });
  const tabBtns = new Map<ModTab, HTMLButtonElement>();
  for (const t of MOD_TABS) {
    const b = h('button', { type: 'button', class: 'sp-nav-item sp-tab', id: `sp-modtab-${t.id}`, role: 'tab', 'aria-controls': 'sp-modpanel', 'data-tab': t.id }, h('span', {}, t.title));
    b.addEventListener('click', () => showTab(t.id));
    tabBtns.set(t.id, b);
    tabsEl.append(b);
  }
  tabsEl.addEventListener('keydown', (e) => {
    const ids = MOD_TABS.map((t) => t.id);
    const i = ids.indexOf((document.activeElement as HTMLElement | null)?.dataset.tab as ModTab);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    showTab(ids[next]);
    tabBtns.get(ids[next])!.focus();
  });

  // ---------- Each tab's head: safe mode on the Mods tab, a look tab on the others ----------

  /** The picture of yours last chosen, kept while the app runs (Default forgets it in the layout) */
  let lastImage: string | null = null;
  const dim = h('input', { type: 'range', min: '0', max: '100', step: '5', class: 'sp-range' });
  const dimValue = h('span', { class: 'sp-range-value' });
  // The preview follows the slider as it moves; the window, once it is let go (change)
  dim.addEventListener('input', () => {
    dimValue.textContent = `${dim.value}%`;
    lookTabs.get('backgrounds')?.dim(Number(dim.value) / 100);
  });
  dim.addEventListener('change', async () => {
    try {
      await ctx.call('mods.setLayout', { backgroundDim: Number(dim.value) / 100 });
      dimRow.saved();
      dimRow.problem(null);
    } catch (err) {
      dimRow.problem(`Couldn't save: ${ctx.cleanError(err)}`);
    }
  });
  const dimRow = row({ id: 'background-dim', title: 'Dim', desc: 'How strongly the app’s surfaces cover the background.', keywords: 'opacity translucent background' }, h('span', { class: 'sp-control-group' }, dim, dimValue));

  const lookStatusEl = h('div', { class: 'sp-inline-status sp-look-status', role: 'status', hidden: true });
  const lookStatus = (text: string, error = false) => {
    lookStatusEl.hidden = !text;
    lookStatusEl.classList.toggle('error', error);
    lookStatusEl.innerHTML = text ? `${icon(error ? 'circle-alert' : 'circle-check', 14)}<span>${escapeHtml(text)}</span>` : '';
  };

  /** Each look's preview CSS, by kind, ref and the mod's rev (an edit compiles it again) */
  const cssCache = new Map<string, Promise<string>>();
  const previewCss = (kind: ModLookTarget, ref: string, rev: string): Promise<string> => {
    const k = `${kind}|${ref}|${rev}`;
    let p = cssCache.get(k);
    if (!p) {
      p = ctx.call('mods.previewCss', { kind, ref }).then((r) => r?.css ?? '');
      p.catch(() => cssCache.delete(k));
      if (cssCache.size > 200) cssCache.clear();
      cssCache.set(k, p);
    }
    return p;
  };

  const lookTabs = new Map<ModTab, LookTab>();
  for (const info of LOOK_TABS) {
    lookTabs.set(
      info.tab,
      lookTab({
        ctx,
        info,
        previews: () => ctx.modPreviews?.() ?? null,
        mods: () => mods,
        adoptMods: (list) => {
          mods = list;
          renderAll();
        },
        picture: () => lastImage,
        settingRow: (m, f, prefix, pill) => settingRow(m, f, prefix, pill),
        dimRow: info.kind === 'background' ? dimRow : undefined,
        openCreate: (kind, slot, made) => openCreateIn(kind, slot, made),
        openInstall: (slot) => openInstallIn(slot),
        chooseImage: () => chooseImage(),
        css: (kind, ref, rev) => previewCss(kind, ref, rev),
        reveal: (m) => void ctx.call('mods.reveal', m.key).catch((err) => lookStatus(`Couldn't show the folder: ${ctx.cleanError(err)}`, true)),
        customise: (m) => customise(m, lookStatus),
        remove: async (m) => {
          await removeMod(m, lookStatus);
        },
      }),
    );
  }

  const heads: Record<ModTab, HTMLElement> = {
    mods: group(null, safe),
    backgrounds: lookTabs.get('backgrounds')!.el,
    'chat-bar': lookTabs.get('chat-bar')!.el,
    conversation: lookTabs.get('conversation')!.el,
  };
  for (const [id, head] of Object.entries(heads)) {
    head.classList.add('sp-tab-head');
    head.dataset.subtab = id;
  }
  // One status line, moved under the grid's head of the look tab on screen
  const placeLookStatus = () => {
    const lt = lookTabs.get(tab);
    if (lt) lt.el.querySelector('.sp-look-grid-head')!.after(lookStatusEl);
  };

  let dialogOpen = false;
  const panel = h('div', { id: 'sp-modpanel', role: 'tabpanel' }, ...Object.values(heads), toolbar, installForm, createForm, status, listEl, removeAllGroup);
  el.append(tabsEl, panel);

  function showTab(next: ModTab, opts?: { preview?: string }): void {
    if (!isModTab(next)) return;
    if (next !== tab) {
      closeForms();
      lookStatus('');
    }
    tab = next;
    for (const [id, b] of tabBtns) {
      const on = id === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `sp-modtab-${tab}`);
    for (const [id, head] of Object.entries(heads)) head.classList.toggle('current', id === tab);
    // The Mods tab's toolbar and list belong to it alone (the search still finds the cards from any tab)
    toolbar.classList.toggle('sp-tab-out', tab !== 'mods');
    listEl.classList.toggle('sp-tab-out', tab !== 'mods');
    status.classList.toggle('sp-tab-out', tab !== 'mods');
    removeAllGroup.classList.toggle('sp-tab-out', tab !== 'mods');
    placeLookStatus();
    for (const [t, lt] of lookTabs) lt.shown(dialogOpen && t === tab);
    if (opts?.preview !== undefined) lookTabs.get(tab)?.preview(opts.preview);
    applyTab();
  }

  /** Each group's empty note on the Mods tab. */
  function applyTab(): void {
    for (const grp of listEl.querySelectorAll<HTMLElement>('.sp-group')) {
      const shown = grp.querySelectorAll('.sp-mod').length;
      const emptyNote = grp.querySelector<HTMLElement>('.sp-empty-group');
      if (emptyNote) {
        emptyNote.hidden = shown > 0;
        emptyNote.textContent = 'None yet.';
      }
    }
  }

  // ---------- The list ----------

  function render(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && listEl.contains(active) && (active.matches('input:not([type=checkbox]), textarea'))) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    listEl.innerHTML = '';
    for (const g of MOD_GROUPS) {
      // A mod that is only looks has no card here: its looks are on their tabs
      const items = mods.filter((m) => m.scope === g.scope && !isLookOnly(m.manifest));
      if (!items.length && g.scope !== 'user') continue;
      const grp = group(g.title);
      // Yours always has its group, with a note while none of its mods are of the tab's kind
      if (g.scope === 'user') grp.append(h('p', { class: 'sp-note sp-empty-group' }));
      for (const m of items) grp.append(modRow(m));
      listEl.append(grp);
    }
    renderRemoveAll();
    applyTab();
    ctx.refreshSearch();
    if (active instanceof HTMLElement && active.dataset.focusKey) listEl.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(active.dataset.focusKey)}"]`)?.focus();
  }
  listEl.addEventListener('focusout', () => {
    if (pendingRender) setTimeout(() => pendingRender && render(), 0);
  });

  function renderAll(): void {
    renderLooks();
    render();
  }

  // ---------- The look tabs ----------

  function renderLooks(): void {
    const l = ctx.config().mods?.layout ?? null;
    if (!l) return;
    if (l.backgroundImage) lastImage = l.backgroundImage;
    dim.value = String(Math.round((l.backgroundDim ?? 0.82) * 100));
    dimValue.textContent = `${dim.value}%`;
    for (const lt of lookTabs.values()) lt.render();
  }

  async function chooseImage(): Promise<void> {
    try {
      const before = ctx.config().mods?.layout?.backgroundImage ?? null;
      const l = await ctx.call('mods.chooseBackgroundImage');
      if (l.backgroundImage && l.backgroundImage !== before) {
        lastImage = l.backgroundImage;
        lookStatus('Your picture is behind the window now.');
      }
      renderLooks();
    } catch (err) {
      lookStatus(ctx.cleanError(err), true);
    }
  }

  async function customise(m: ModInfo, say: (text: string, error?: boolean) => void): Promise<void> {
    try {
      mods = await ctx.call('mods.customise', m.key);
      const copy = mods.find((x) => x.id === m.id && x.scope === 'user');
      if (copy) expanded.add(copy.key);
      renderAll();
      say(`Your copy of ${m.manifest?.name ?? m.id} replaces the built-in one.`);
    } catch (err) {
      say(`Couldn't customise: ${ctx.cleanError(err)}`, true);
    }
  }

  async function removeMod(m: ModInfo, say: (text: string, error?: boolean) => void): Promise<boolean> {
    const ok = await ctx.confirm({ title: `Remove ${m.manifest?.name ?? m.id}?`, description: `Its folder moves to the Trash${m.overrides ? ' and the built-in one comes back' : ''}${m.inUse?.length ? '; its looks go back to Default' : ''}.`, confirmLabel: 'Move to Trash', danger: true });
    if (!ok) return false;
    try {
      mods = await ctx.call('mods.remove', m.key);
      expanded.delete(m.key);
      renderAll();
      return true;
    } catch (err) {
      say(`Couldn't remove: ${ctx.cleanError(err)}`, true);
      return false;
    }
  }

  function modIcon(m: ModInfo): string {
    const name = m.manifest?.icon ?? '';
    if (isIconName(name)) return icon(name);
    const file = modIconFile(name);
    if (file) return `<img src="${escapeHtml(`${m.origin}/${file}`)}" alt="" width="16" height="16">`;
    return icon('puzzle');
  }

  function modRow(m: ModInfo): HTMLElement {
    const name = m.manifest?.name ?? m.id;
    const open = expanded.has(m.key);
    const tabs = modTabs(m);
    const r = row({ id: `mod-${safeKey(m.key)}`, title: name, desc: m.manifest?.description ?? (m.problems[0]?.message || ''), keywords: `${m.id} mod ${m.manifest?.author ?? ''} ${tabs.map((t) => MOD_TABS.find((x) => x.id === t)!.title).join(' ')}` });
    r.el.classList.add('sp-mod');
    r.el.dataset.tabs = 'mods';
    r.el.classList.toggle('open', open);
    const titleEl = r.el.querySelector('.sp-row-title')!;
    if (m.manifest?.version) titleEl.append(h('span', { class: 'sp-mod-version' }, m.manifest.version));
    if (m.overrides) titleEl.append(h('span', { class: 'sp-pill' }, 'Customised'));
    const c = modChip(m);
    if (c) titleEl.append(chip(c.label, c.tone));

    const expand = h('button', { type: 'button', class: 'sp-mod-expand', 'aria-expanded': String(open), 'aria-label': `Details of ${name}`, 'data-focus-key': `${m.key}|expand`, html: icon('chevron-right', 14) });
    const iconEl = h('span', { class: 'sp-mod-icon', html: modIcon(m) });
    const text = r.el.querySelector<HTMLElement>('.sp-row-text')!;
    text.before(expand, iconEl);

    const sw = switchControl(m.state === 'on', (on) => void setEnabled(m, on, sw));
    sw.setAttribute('aria-label', `${name}: ${m.state === 'on' ? 'on' : 'off'}`);
    sw.dataset.focusKey = `${m.key}|switch`;
    sw.disabled = m.state === 'invalid';
    r.control.append(sw);

    const detail = h('div', { class: 'sp-mod-detail', hidden: !open });
    if (open) fillDetail(detail, m, r);
    const toggle = () => {
      const now = !expanded.has(m.key);
      if (now) expanded.add(m.key);
      else expanded.delete(m.key);
      r.el.classList.toggle('open', now);
      expand.setAttribute('aria-expanded', String(now));
      detail.hidden = !now;
      if (now && !detail.childElementCount) fillDetail(detail, m, r);
    };
    expand.addEventListener('click', toggle);
    // A click on the row's text opens it too (not on the switch).
    text.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      toggle();
    });
    iconEl.addEventListener('click', toggle);
    r.el.append(detail);
    return r.el;
  }


  async function setEnabled(m: ModInfo, on: boolean, sw: HTMLInputElement): Promise<void> {
    const r = { problem: (msg: string | null) => setRowProblem(sw, msg) };
    if (on && (m.scope !== 'bundled' || m.state === 'paused')) {
      const sheet = grantSheet(m);
      const ok = await ctx.confirm({
        title: sheet.title,
        icon: 'puzzle',
        quote: { label: sheet.lines.length ? 'It will be able to' : 'It asks for nothing', text: sheet.lines.length ? sheet.lines.map((l) => `•  ${l}`).join('\n') : 'It only shows its own views.' },
        description: sheet.warnings.join(' '),
        confirmLabel: m.state === 'paused' ? 'Allow and resume' : 'Turn on',
      });
      if (!ok) {
        sw.checked = false;
        return;
      }
    }
    try {
      mods = await ctx.call('mods.setEnabled', m.key, on);
      r.problem(null);
      renderAll();
    } catch (err) {
      sw.checked = !on;
      r.problem(`Couldn't turn it ${on ? 'on' : 'off'}: ${ctx.cleanError(err)}`);
    }
  }

  function setRowProblem(inside: HTMLElement, message: string | null): void {
    const p = inside.closest('.sp-row')?.querySelector<HTMLElement>('.sp-problem');
    if (!p) return;
    p.hidden = !message;
    p.innerHTML = message ? `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>` : '';
  }

  function fillDetail(d: HTMLElement, m: ModInfo, r: Row): void {
    d.innerHTML = '';
    const block = (title: string, ...children: (Node | string)[]) => h('div', { class: 'sp-detail-block' }, h('div', { class: 'sp-detail-title' }, title), ...children);

    // Where it lives
    d.append(
      block(
        'Where it lives',
        h(
          'div',
          { class: 'sp-detail-line' },
          h('code', { class: 'sp-path', title: m.dir }, tildePath(m.dir)),
          button('Reveal', () => void ctx.call('mods.reveal', m.key).catch((err) => r.problem(ctx.cleanError(err))), { icon: 'folder' }),
        ),
      ),
    );

    // What it adds
    const adds: string[] = [];
    for (const v of m.manifest?.contributes?.views ?? []) adds.push(`${v.title}: ${SEAT_WORDS[v.seat] ?? v.seat}`);
    for (const l of m.manifest?.contributes?.looks ?? []) adds.push(`${l.title}: ${LOOK_WORDS[l.target] ?? l.target}`);
    for (const c of m.manifest?.contributes?.commands ?? []) adds.push(`/${c.name}: ${c.description}`);
    const hooks = m.manifest?.contributes?.hooks ?? [];
    if (hooks.length) adds.push(`Hooks: ${hooks.map((x) => x.event).join(', ')}`);
    d.append(block('What it adds', adds.length ? h('ul', { class: 'sp-detail-list' }, ...adds.map((a) => h('li', {}, a))) : h('p', { class: 'sp-detail-muted' }, 'Nothing yet.')));

    // Permissions
    const asked = [...new Set<ModPermission>([...(m.manifest?.permissions ?? []), ...m.granted, ...m.wants])];
    const permList = h('ul', { class: 'sp-perm-list' });
    for (const p of asked) {
      const wanted = m.wants.includes(p);
      const granted = m.granted.includes(p) || (m.scope === 'bundled' && m.state === 'on' && !wanted);
      const li = h('li', { class: wanted ? 'wanted' : granted ? 'granted' : '' });
      li.innerHTML = `${icon(granted ? 'check' : wanted ? 'circle-alert' : 'circle', 14)}<span>${escapeHtml(permissionWords(p))}</span>${wanted ? '<span class="sp-chip warn">Not granted yet</span>' : ''}`;
      permList.append(li);
    }
    if (m.wantsStyles) permList.append(h('li', { class: '', html: `${icon('circle', 14)}<span>Restyle the app with its looks</span><span class="sp-chip">Asked at first use</span>` }));
    d.append(block('Permissions', asked.length || m.wantsStyles ? permList : h('p', { class: 'sp-detail-muted' }, 'None.')));

    // Problems
    if (m.problems.length) {
      const probs = [...m.problems].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      d.append(
        block(
          'Problems',
          h(
            'ul',
            { class: 'sp-problem-list' },
            ...probs.map((p) => h('li', {}, h('span', { class: 'sp-problem-kind' }, p.kind === 'runtime' ? `Page${p.view ? ` ${p.view}` : ''}` : p.kind === 'file' ? 'Missing file' : p.warning ? 'mod.json (warning)' : 'mod.json'), h('pre', {}, p.message))),
          ),
        ),
      );
    }

    // Its settings
    const fields = m.manifest?.contributes?.settings ?? [];
    if (fields.length) {
      const form = h('div', { class: 'sp-mod-settings' });
      for (const f of fields) form.append(settingRow(m, f));
      d.append(block('Settings', form));
    }

    // Actions
    const meta = [m.manifest?.author && `By ${m.manifest.author}`, m.manifest?.license].filter(Boolean).join(' · ');
    const acts = actions(
      meta ? h('span', { class: 'sp-detail-muted' }, meta) : null,
      h('span', { class: 'spacer' }),
      m.scope === 'bundled'
        ? button('Customise', async (b) => {
            b.disabled = true;
            await customise(m, (text, error) => (error ? r.problem(text) : showStatus(text)));
            b.disabled = false;
          }, { icon: 'copy' })
        : null,
      m.scope === 'user'
        ? button('Remove', async (b) => {
            b.disabled = true;
            await removeMod(m, (text) => r.problem(text));
            b.disabled = false;
          }, { icon: 'trash', danger: true })
        : null,
    );
    d.append(acts);
  }

  /** One of a mod's own settings; `prefix` keeps the ids apart where the same setting shows twice (a card and a picker). */
  function settingRow(m: ModInfo, f: ModSettingField, prefix = '', pill?: string): HTMLElement {
    const value = m.settings[f.key] ?? (f as { default?: unknown }).default;
    const id = `${prefix ? `${prefix}-` : ''}modset-${safeKey(m.key)}-${f.key}`;
    const setValue = async (r: Row, v: unknown): Promise<boolean> => {
      try {
        mods = await ctx.call('mods.setSetting', m.key, f.key, v);
        const next = mods.find((x) => x.key === m.key);
        if (next) m.settings = next.settings;
        r.problem(null);
        r.saved();
        return true;
      } catch (err) {
        r.problem(ctx.cleanError(err));
        return false;
      }
    };
    let r: Row;
    if (f.type === 'boolean') {
      const sw = switchControl(Boolean(value), (on) => void setValue(r, on).then((ok) => !ok && (sw.checked = !on)));
      r = row({ id, title: f.title, desc: f.description, pill }, sw);
      r.el.classList.add('clickable');
    } else if (f.type === 'select') {
      const sel = selectControl(f.options.map((o) => ({ value: o, label: o })), String(value ?? f.options[0] ?? ''), (v) => void setValue(r, v), 180);
      r = row({ id, title: f.title, desc: f.description, pill }, sel);
    } else {
      const ctl = textControl({
        value: value === undefined || value === null ? '' : String(value),
        placeholder: f.type === 'string' ? f.placeholder : undefined,
        type: f.type === 'number' ? 'number' : 'text',
        width: f.type === 'number' ? 120 : 220,
        onCommit: async (text) => {
          let v: unknown = text;
          if (f.type === 'number') {
            const n = Number(String(text).trim());
            if (!String(text).trim() || !Number.isFinite(n)) return r.problem('Enter a number.');
            if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) return r.problem(`Must be${f.min !== undefined ? ` from ${f.min}` : ''}${f.max !== undefined ? ` to ${f.max}` : ''}.`);
            if (f.step === 1 || (f.step === undefined && Number.isInteger(f.min ?? 0) && Number.isInteger(f.max ?? 0) && /^-?\d+$/.test(String(text).trim()))) {
              const p = parseInteger(text, f.min ?? -1e12, f.max ?? 1e12);
              if (!p.ok) return r.problem(p.error);
              v = p.value;
            } else v = n;
          }
          if (await setValue(r, v)) ctl.set(String(v));
        },
      });
      r = row({ id, title: f.title, desc: f.description, pill }, ctl);
    }
    r.el.classList.add('sp-sub-row');
    return r.el;
  }

  onPush('mods:changed', (list) => {
    if (!Array.isArray(list)) return;
    mods = list;
    renderAll();
  });

  showTab(tab);

  // For the live checks: what each look tab shows, and trying a version there
  const dbgHost = (window as unknown as { __oc_debug?: Record<string, unknown> }).__oc_debug;
  if (dbgHost) {
    dbgHost.looks = {
      state: (t: ModTab) => lookTabs.get(t)?.state() ?? null,
      preview: (t: ModTab, ref: string | null | undefined) => lookTabs.get(t)?.preview(ref),
      kindOf: (t: ModTab): LookKind | null => lookTabOf(t)?.kind ?? null,
    };
  }

  return {
    id: 'mods',
    el,
    sync(cfg) {
      safeInput.checked = Boolean(cfg.mods?.safeMode);
      renderLooks();
    },
    tab: () => tab,
    showTab: (t, opts) => {
      if (isModTab(t)) showTab(t, opts);
    },
    uncover(target) {
      const head = target.closest<HTMLElement>('[data-subtab]');
      if (head && isModTab(head.dataset.subtab)) return showTab(head.dataset.subtab);
      const card = target.closest<HTMLElement>('.sp-mod[data-tabs]');
      const tabs = (card?.dataset.tabs ?? '').split(' ').filter(isModTab);
      if (tabs.length && !tabs.includes(tab)) showTab(tabs[0]);
    },
    async load() {
      dialogOpen = true;
      try {
        mods = await ctx.call('mods.list');
      } catch (err) {
        if (ctx.isUnknown(err)) return 'absent';
        showStatus(`Couldn't load the mods: ${ctx.cleanError(err)}`, true);
        return 'ok';
      }
      renderAll();
      for (const [t, lt] of lookTabs) lt.shown(t === tab);
      return 'ok';
    },
    closed() {
      dialogOpen = false;
      closeForms();
      showStatus('');
      lookStatus('');
      for (const lt of lookTabs.values()) lt.closed();
    },
  };
}
