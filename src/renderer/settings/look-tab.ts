// One look tab of Settings → Mods (Background, Chat bar, Conversation, Theme). At the top, a preview of what is in
// use, or of the version being tried; under it the version's name and source with "In use", or Use and Back to
// current; its mod's own settings (and Dim on Background); then every version as a card, Default first, then the
// built-in ones, yours and the project's. A click on a card previews it; Use applies it, asking first the first time
// a look of yours or a project's is used (the only approval a look needs). New ⌄ asks the agent for one or writes a
// starter from a template, which shows in the grid previewed, not applied. Nothing here has a switch.

import type { LookKind, ModInfo, ModLayout, ModSettingField } from '../../shared/mods';
import type { ModPreviews, BackgroundPreview } from '../mods-host.js';
import { escapeHtml, h } from '../dom.js';
import { icon, type IconName } from '../icons.js';
import { modeOf } from '../modes.js';
import { looksUsable } from '../mods/logic.js';
import { lookInUse, lookSetPatch, lookSets, lookVersions, needsApproval, setInUse, useSheet, type LookTabInfo, type LookVersion, type NewModKind } from './model.js';
import { createLookPreview, type LookPreview, type PreviewState } from './look-preview.js';
import { button, chip, row, type Row } from './ui.js';
import type { Ctx } from './ctx.js';

export interface LookTabDeps {
  ctx: Ctx;
  info: LookTabInfo;
  previews: () => ModPreviews | null;
  mods(): ModInfo[];
  /** The section's list follows a list the main process returned (and everything re-renders) */
  adoptMods(list: ModInfo[]): void;
  /** The last picture of yours (Background), kept while the app runs */
  picture(): string | null;
  /** A row for one of a mod's settings (shared with the Mods tab's cards) */
  settingRow(m: ModInfo, f: ModSettingField, prefix: string, pill?: string): HTMLElement;
  /** The Dim row (Background only) */
  dimRow?: Row;
  /** The New form of the section, shown in `slot`, preset to `kind`; `made` gets the mod it wrote */
  openCreate(kind: NewModKind, slot: HTMLElement, made: (m: ModInfo) => void): void;
  /** The Install form of the section, shown in `slot` */
  openInstall(slot: HTMLElement): void;
  chooseImage(): Promise<void>;
  /** A look's or a theme's CSS for the previews (cached by the section) */
  css(kind: 'theme' | 'composer' | 'conversation', ref: string, rev: string): Promise<string>;
  reveal(m: ModInfo): void;
  customise(m: ModInfo): Promise<void>;
  remove(m: ModInfo): Promise<void>;
}

export interface LookTab {
  /** The tab's head: preview, its line, settings, the grid */
  el: HTMLElement;
  /** The mods or the layout changed */
  render(): void;
  /** Shows a version in the preview ("<mod key>/<id>", a theme's key, "image", null for Default), or what is in use (undefined) */
  preview(ref: string | null | undefined): void;
  /** The tab came on screen or went (live backgrounds run only while it shows) */
  shown(on: boolean): void;
  /** Settings closed */
  closed(): void;
  /** Background: Dim as its slider moves, shown in the preview before it is saved */
  dim(value: number): void;
  /** For __oc_debug.settings.looks() */
  state(): { kind: LookKind; current: string | null; shown: string | null; previewing: boolean; versions: (string | null)[]; ready: boolean };
}

/** A small menu under a button, inside the page (the window's menus sit under the Settings dialog). */
function dropdown(btn: HTMLButtonElement, wrap: HTMLElement, items: () => { label: string; icon: IconName; danger?: boolean; run: () => void }[]): void {
  let menu: HTMLElement | null = null;
  const close = () => {
    menu?.remove();
    menu = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: Event) => {
    if (menu && !menu.contains(e.target as Node) && e.target !== btn && !btn.contains(e.target as Node)) close();
  };
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => {
    if (menu) return close();
    menu = h('div', { class: 'sp-menu', role: 'menu' });
    for (const it of items()) {
      const b = h('button', { type: 'button', class: `sp-menu-item${it.danger ? ' danger' : ''}`, role: 'menuitem', html: `${icon(it.icon, 14)}<span>${escapeHtml(it.label)}</span>` });
      b.addEventListener('click', () => {
        close();
        it.run();
      });
      menu.append(b);
    }
    menu.addEventListener('keydown', (e) => {
      const list = [...menu!.querySelectorAll<HTMLButtonElement>('.sp-menu-item')];
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        btn.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
      }
    });
    wrap.append(menu);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    menu.querySelector<HTMLButtonElement>('.sp-menu-item')?.focus();
  });
}

export function lookTab(d: LookTabDeps): LookTab {
  const { ctx, info } = d;
  const kind = info.kind;
  /** The version in the preview when it is not the one in use (undefined: the one in use) */
  let previewRef: string | null | undefined;
  let visible = false;

  // ---------- The preview pane ----------

  const pane = h('div', { class: 'sp-look-pane sp-only-browse' });
  const big: LookPreview = createLookPreview(kind, { label: `Preview of the ${info.noun}` });
  pane.append(big.el);
  let paneFrame: { ref: string; frame: BackgroundPreview } | null = null;

  // ---------- Its line: name and source, In use or Use / Back to current ----------

  const head = row({ id: info.row, title: 'Default', desc: '', keywords: `${info.noun} ${info.title} look use preview in use mod ${kind === 'background' ? 'wallpaper picture image' : kind === 'theme' ? 'theme colours colors styles' : kind === 'composer' ? 'composer input message box chat bar' : 'transcript messages chat'}` });
  head.el.classList.add('sp-look-current');
  const acts = h('span', { class: 'sp-control-group sp-look-acts' });
  head.control.append(acts);
  const settingsBox = h('div', { class: 'sp-mod-settings sp-pick-settings' });

  // ---------- The grid of versions ----------

  const newWrap = h('span', { class: 'sp-menu-wrap' });
  const newBtn = button('New', () => {}, { icon: 'plus' });
  newBtn.insertAdjacentHTML('beforeend', icon('chevron-down', 12));
  newBtn.classList.add('sp-look-new');
  newWrap.append(newBtn);
  const installBtn = button('Install…', () => d.openInstall(formSlot), { icon: 'download' });
  const gridHead = h('div', { class: 'sp-look-grid-head sp-only-browse' }, h('span', { class: 'sp-look-grid-title' }, 'Versions'), h('span', { class: 'spacer' }), installBtn, newWrap);
  const formSlot = h('div', { class: 'sp-look-form-slot sp-only-browse' });
  const grid = h('div', { class: 'sp-look-grid sp-only-browse', role: 'list', 'aria-label': `${info.title} versions` });
  dropdown(newBtn, newWrap, () => [
    { label: 'Ask the agent…', icon: 'sparkles', run: () => ctx.askAgent(info.prompt) },
    {
      label: 'From a template…',
      icon: 'file-plus',
      run: () =>
        d.openCreate(kind === 'background' ? 'background' : kind === 'theme' ? 'theme' : `look:${kind}`, formSlot, (m) => {
          const set = lookSets([m], 1)[0];
          const ref = set?.[kind] ?? null;
          if (ref) preview(ref);
        }),
    },
    ...(kind === 'background' ? [{ label: 'Your picture…', icon: 'image' as IconName, run: () => void d.chooseImage() }] : []),
  ]);

  const el = h('div', { class: 'sp-group sp-tab-head sp-look-tab', 'data-subtab': info.tab, 'data-kind': kind }, pane, head.el, settingsBox);
  if (d.dimRow) el.append(d.dimRow.el);
  el.append(gridHead, formSlot, grid);

  // ---------- State ----------

  const layout = (): ModLayout | null => ctx.config().mods?.layout ?? null;
  const current = () => lookInUse(layout(), kind);
  const versions = () => lookVersions(d.mods(), kind, d.picture());
  const shownRef = () => (previewRef === undefined ? current() : previewRef);
  const versionOf = (ref: string | null) => versions().find((v) => v.ref === ref) ?? null;
  const modOf = (key: string) => d.mods().find((m) => m.key === key);
  const fresh = (v: LookVersion | null) => (v?.mod ? (modOf(v.mod.key) ?? v.mod) : null);

  /** The theme the previews are dressed in: the one in use (when it applies), or on the Theme tab the version itself */
  const themeRefFor = (v: LookVersion | null): string | null => {
    if (kind === 'theme') return v?.ref ?? null;
    const t = layout()?.theme ?? null;
    const m = t ? modOf(t) : undefined;
    return m && looksUsable(m) ? t : null;
  };

  async function stateFor(v: LookVersion | null, frame: BackgroundPreview | null): Promise<PreviewState> {
    const m = fresh(v);
    const themeRef = themeRefFor(v);
    const themeMod = themeRef ? modOf(themeRef) : undefined;
    const themeCss = themeRef && themeMod ? await d.css('theme', themeRef, themeMod.rev).catch(() => '') : '';
    const st: PreviewState = { themeCss, mode: modeOf(ctx.config()) };
    if ((kind === 'composer' || kind === 'conversation') && v?.ref && m) {
      st.lookCss = await d.css(kind, v.ref, m.rev).catch(() => '');
      st.lookRef = v.ref;
      st.settings = m.settings;
    }
    if (kind === 'background') {
      st.dim = layout()?.backgroundDim ?? 0.82;
      if (v?.ref === 'image') {
        const p = d.picture();
        st.backdrop = p ? { image: `mod://app.background/${encodeURIComponent(p.split(/[\\/]/).pop() ?? '')}` } : null;
      } else if (v?.ref && frame) st.backdrop = { view: frame.el };
      else st.backdrop = null;
    }
    return st;
  }

  // ---------- Rendering ----------

  let paneSeq = 0;
  async function renderPane(): Promise<void> {
    const my = ++paneSeq;
    const ref = shownRef();
    const v = versionOf(ref);
    // The live background in the pane: one frame for the version shown, made again when it changes
    if (kind === 'background') {
      if (paneFrame && (paneFrame.ref !== ref || !visible)) {
        paneFrame.frame.dispose();
        paneFrame = null;
      }
      if (!paneFrame && visible && v?.mod && ref && ref !== 'image') {
        const f = d.previews()?.background(ref) ?? null;
        if (f) paneFrame = { ref, frame: f };
      }
    }
    const st = await stateFor(v, paneFrame?.frame ?? null);
    if (my !== paneSeq) return;
    big.set(st);
    big.el.setAttribute('aria-label', `Preview of ${v ? (v.ref ? `${v.title} (${v.source})` : 'Default') : 'Default'}`);
  }

  function renderHead(): void {
    const cur = current();
    const ref = shownRef();
    const v = versionOf(ref);
    const m = fresh(v);
    const inUse = ref === cur;
    const nameEl = head.el.querySelector<HTMLElement>('.sp-row-name')!;
    nameEl.textContent = v ? v.title : ref ? `${ref} (not installed)` : 'Default';
    head.el.querySelectorAll('.sp-row-title .sp-chip').forEach((c) => c.remove());
    const title = head.el.querySelector('.sp-row-title')!;
    if (inUse && m?.state === 'paused') title.append(chip('Paused: asks for more', 'warn'));
    else if (inUse) title.append(chip('In use', 'ok'));
    else title.append(chip('Preview', 'neutral'));
    const desc = [v?.source ?? '', v?.description ?? ''].filter(Boolean).join(' · ');
    head.setDesc(desc);
    head.el.dataset.search = [info.title, info.noun, v?.title ?? '', desc, 'look use preview in use'].join(' ');
    const problems = m?.problems.filter((p) => !p.warning) ?? [];
    head.problem(problems.length ? `${m!.manifest?.name ?? m!.id} has a problem: ${problems[problems.length - 1].message.split('\n')[0]}` : null);

    acts.innerHTML = '';
    const set = m ? lookSets([m])[0] : undefined;
    if (!inUse) acts.append(button('Back to current', () => preview(undefined), { aria: 'Back to what is in use' }));
    if (set && !setInUse(set, layout())) acts.append(button('Use the set', (b) => void use(ref, b, true), { aria: `Use the set of ${set.name}` }));
    if (!inUse || m?.state === 'paused') {
      const u = button(m?.state === 'paused' ? 'Allow and use' : 'Use', (b) => void use(ref, b), { primary: true, aria: `Use ${v?.title ?? 'Default'}` });
      u.classList.add('sp-look-use');
      acts.append(u);
    }
    if (m) {
      const moreWrap = h('span', { class: 'sp-menu-wrap' });
      const more = h('button', { type: 'button', class: 'icon-btn sm sp-icon-btn sp-look-more', 'aria-label': `More for ${m.manifest?.name ?? m.id}`, title: 'More', html: icon('more', 14) });
      moreWrap.append(more);
      dropdown(more, moreWrap, () => [
        { label: 'Show files', icon: 'folder', run: () => d.reveal(m) },
        ...(m.scope === 'bundled' ? [{ label: 'Customise', icon: 'copy' as IconName, run: () => void d.customise(m) }] : []),
        ...(m.scope === 'user' ? [{ label: 'Remove…', icon: 'trash' as IconName, danger: true, run: () => void d.remove(m) }] : []),
      ]);
      acts.append(moreWrap);
    }

    // The settings of the version's mod (they apply wherever the mod's looks are in use)
    const fields = m?.manifest?.contributes?.settings ?? [];
    const sig = m && fields.length ? `${m.key}|${m.rev}|${JSON.stringify(m.settings)}` : '';
    if (settingsBox.dataset.sig !== sig && !(settingsBox.contains(document.activeElement) && (document.activeElement as HTMLElement).matches('input:not([type=checkbox]), textarea'))) {
      settingsBox.dataset.sig = sig;
      settingsBox.innerHTML = '';
      if (m) for (const f of fields) settingsBox.append(d.settingRow(m, f, `pick-${info.tab}`, m.manifest?.name ?? m.id));
    }
    if (d.dimRow) {
      const on = !!ref;
      d.dimRow.el.classList.toggle('sp-off', !on);
      d.dimRow.el.querySelector<HTMLInputElement>('input[type=range]')!.disabled = !on;
    }
  }

  /** The cards, each with a small preview; rebuilt when the versions or what is in use change. */
  let gridSig = '';
  const cards = new Map<string, { el: HTMLButtonElement; preview: LookPreview | null; frame: BackgroundPreview | null; timer?: number }>();
  const cardKey = (ref: string | null) => ref ?? '';

  function renderGrid(): void {
    const list = versions();
    const cur = current();
    const shown = shownRef();
    const themeSig = kind === 'theme' ? '' : `${themeRefFor(null)}|${modOf(themeRefFor(null) ?? '')?.rev ?? ''}`;
    const sig = JSON.stringify([list.map((v) => [v.ref, v.title, v.source, v.preview ?? '', fresh(v)?.rev ?? '', JSON.stringify(fresh(v)?.settings ?? {})]), themeSig, document.documentElement.dataset.theme ?? '', visible]);
    if (sig !== gridSig) {
      gridSig = sig;
      for (const c of cards.values()) disposeCard(c);
      cards.clear();
      grid.innerHTML = '';
      for (const v of list) grid.append(card(v));
    }
    for (const [key, c] of cards) {
      c.el.classList.toggle('current', key === cardKey(cur));
      c.el.classList.toggle('selected', key === cardKey(shown));
      c.el.setAttribute('aria-pressed', String(key === cardKey(shown)));
      const badge = c.el.querySelector<HTMLElement>('.sp-look-badge')!;
      badge.hidden = key !== cardKey(cur);
    }
  }

  function disposeCard(c: { preview: LookPreview | null; frame: BackgroundPreview | null; timer?: number }): void {
    window.clearTimeout(c.timer);
    c.frame?.dispose();
    c.preview?.dispose();
  }

  function card(v: LookVersion): HTMLButtonElement {
    const m = fresh(v);
    const b = h('button', { type: 'button', class: 'sp-look-card', role: 'listitem', 'data-ref': cardKey(v.ref), 'aria-label': `${v.title}, ${v.source}` });
    const thumb = h('span', { class: 'sp-look-thumb' });
    const entry: { el: HTMLButtonElement; preview: LookPreview | null; frame: BackgroundPreview | null; timer?: number } = { el: b, preview: null, frame: null };
    if (v.preview && m) {
      // The manifest's own picture of it
      const img = h('img', { src: `${m.origin}/${v.preview.split('/').map(encodeURIComponent).join('/')}`, alt: '', draggable: 'false' });
      thumb.append(img);
      thumb.classList.add('picture');
    } else {
      const p = createLookPreview(kind, { card: true });
      entry.preview = p;
      thumb.append(p.el);
      if (kind === 'background' && v.mod && v.ref && v.ref !== 'image' && visible) {
        // A live background, drawn for a moment and then held still (it pauses when told it is not visible)
        entry.frame = d.previews()?.background(v.ref) ?? null;
        if (entry.frame) {
          const f = entry.frame;
          entry.timer = window.setTimeout(() => f.setVisible(false), 1800);
        }
      }
      void stateFor(v, entry.frame).then((st) => p.set(st));
    }
    const badge = h('span', { class: 'sp-look-badge', hidden: true }, 'In use');
    const asks = m && needsApproval(m) ? h('span', { class: 'sp-look-asks', title: 'Asks before first use', 'aria-label': 'asks before first use', html: icon('shield-check', 12) }) : null;
    b.append(thumb, h('span', { class: 'sp-look-name' }, v.title, ...(asks ? [asks] : [])), h('span', { class: 'sp-look-source' }, v.source), badge);
    b.addEventListener('click', () => preview(v.ref === current() ? undefined : v.ref));
    b.addEventListener('dblclick', () => void use(v.ref, null));
    cards.set(cardKey(v.ref), entry);
    return b;
  }

  function render(): void {
    // Back to what is in use when the version previewed went away, or became the one in use
    if (previewRef !== undefined && (previewRef === current() || !versionOf(previewRef))) previewRef = undefined;
    renderHead();
    renderGrid();
    void renderPane();
  }

  function preview(ref: string | null | undefined): void {
    previewRef = ref === undefined || ref === current() ? undefined : ref;
    render();
  }

  // ---------- Use ----------

  async function use(ref: string | null, btn: HTMLButtonElement | null, whole = false): Promise<void> {
    const v = versionOf(ref);
    const m = fresh(v);
    const set = whole && m ? lookSets([m])[0] : undefined;
    const patch = set ? lookSetPatch(set) : { [kind]: ref };
    let approve = false;
    if (m && (needsApproval(m) || m.state === 'paused')) {
      const sheet = useSheet(m, kind);
      const ok = await ctx.confirm({
        title: sheet.title,
        icon: 'palette',
        quote: { label: sheet.lines.length ? 'Its pages will be able to' : 'Its pages ask for nothing', text: sheet.lines.length ? sheet.lines.map((l) => `•  ${l}`).join('\n') : 'It only draws its own look.' },
        description: sheet.warnings.join(' '),
        confirmLabel: 'Use',
      });
      if (!ok) return;
      approve = true;
    }
    if (btn) btn.disabled = true;
    try {
      const list = await ctx.call('mods.use', patch, approve ? { approve: true } : undefined);
      head.problem(null);
      head.saved();
      d.adoptMods(list);
    } catch (err) {
      head.problem(`Couldn't use it: ${ctx.cleanError(err)}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  return {
    el,
    render,
    preview,
    shown(on) {
      if (visible === on) return;
      visible = on;
      gridSig = '';
      if (on) render();
      else {
        paneFrame?.frame.dispose();
        paneFrame = null;
        for (const c of cards.values()) disposeCard(c);
        cards.clear();
        grid.innerHTML = '';
        void renderPane();
      }
    },
    closed() {
      previewRef = undefined;
      this.shown(false);
    },
    dim(value) {
      big.setDim(value);
    },
    state: () => ({
      kind,
      current: current(),
      shown: shownRef(),
      previewing: previewRef !== undefined,
      versions: versions().map((v) => v.ref),
      ready: true,
    }),
  };
}
