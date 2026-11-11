// Building blocks of the settings page: a row (title, description, one control at the right), the controls it holds,
// and the row's feedback (an inline problem, the "Saved" tick, the "Set in settings.json" pill).

import { escapeHtml, h } from '../dom.js';
import { icon, type IconName } from '../icons.js';
import { tilde } from '../home.js';

export interface RowOptions {
  /** Unique on the page; the row is #sp-row-<id> */
  id: string;
  title: string;
  desc?: string;
  /** Extra words the search finds the row by */
  keywords?: string;
  /** The config field it edits ("portkey.model"): a settings.json file can own it */
  field?: string;
  /** A small outlined qualifier after the title ("Local only") */
  pill?: string;
  /** The control goes under the text, full width (a multi-line field, a list) */
  full?: boolean;
}

export interface Row {
  el: HTMLElement;
  titleId: string;
  descEl: HTMLElement;
  control: HTMLElement;
  setDesc(text: string): void;
  /** Shows a problem under the row (null clears it) */
  problem(message: string | null): void;
  saved(): void;
}

let uid = 0;

export function row(opts: RowOptions, control?: HTMLElement | null): Row {
  const titleId = `sp-t-${opts.id}`;
  const descId = `sp-d-${opts.id}`;
  const el = h('div', { class: `sp-row${opts.full ? ' full' : ''}`, id: `sp-row-${opts.id}`, 'data-row': opts.id });
  if (opts.field) el.dataset.field = opts.field;
  el.dataset.search = [opts.title, opts.desc ?? '', opts.keywords ?? '', opts.pill ?? ''].join(' ');
  const title = h('div', { class: 'sp-row-title' }, h('span', { id: titleId, class: 'sp-row-name' }, opts.title));
  if (opts.pill) title.append(h('span', { class: 'sp-pill' }, opts.pill));
  const descEl = h('div', { class: 'sp-row-desc', id: descId });
  if (opts.desc) descEl.textContent = opts.desc;
  else descEl.hidden = true;
  const problemEl = h('div', { class: 'sp-problem', role: 'alert', hidden: true });
  const text = h('div', { class: 'sp-row-text' }, title, descEl, problemEl);
  const savedEl = h('span', { class: 'sp-saved', 'aria-hidden': 'true', html: `${icon('check', 12)}<span>Saved</span>` });
  const ctl = h('div', { class: 'sp-row-control' }, savedEl);
  if (control) ctl.append(control);
  el.append(text, ctl);
  if (control) labelControls(control, titleId, descId);
  let savedTimer = 0;
  return {
    el,
    titleId,
    descEl,
    control: ctl,
    setDesc(t) {
      descEl.textContent = t;
      descEl.hidden = !t;
      el.dataset.search = [opts.title, t, opts.keywords ?? '', opts.pill ?? ''].join(' ');
    },
    problem(message) {
      problemEl.hidden = !message;
      problemEl.innerHTML = message ? `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>` : '';
      el.classList.toggle('invalid', Boolean(message));
      ctl.querySelectorAll<HTMLElement>('input:not([type=checkbox]):not([type=radio]), textarea').forEach((f) => (message ? f.setAttribute('aria-invalid', 'true') : f.removeAttribute('aria-invalid')));
      if (message) {
        const fieldEl = ctl.querySelector<HTMLElement>('input, textarea');
        if (fieldEl) fieldEl.setAttribute('aria-errormessage', (problemEl.id ||= `sp-p-${opts.id}`));
      }
    },
    saved() {
      window.clearTimeout(savedTimer);
      savedEl.classList.add('show');
      savedTimer = window.setTimeout(() => savedEl.classList.remove('show'), 1600);
    },
  };
}

/** Gives every control in `root` the row's title as its name and the description as its description. */
export function labelControls(root: HTMLElement, titleId: string, descId: string): void {
  const controls = root.matches('input, select, textarea, button, [role=radiogroup]') ? [root] : [...root.querySelectorAll<HTMLElement>('input, select, textarea, [role=radiogroup]')];
  for (const c of controls) {
    if (c.closest('[role=radiogroup]') && c !== c.closest('[role=radiogroup]')) continue;
    if (!c.hasAttribute('aria-label') && !c.hasAttribute('aria-labelledby')) c.setAttribute('aria-labelledby', titleId);
    if (!c.hasAttribute('aria-describedby')) c.setAttribute('aria-describedby', descId);
  }
}

export function sectionTitle(text: string, id?: string): HTMLElement {
  return h('h3', { class: 'sp-title', id }, text);
}

export function groupTitle(text: string): HTMLElement {
  return h('h4', { class: 'sp-group-title' }, text);
}

/** A run of rows under an optional group title; the search hides a group with no matching row. */
export function group(title: string | null, ...rows: (Row | HTMLElement | null | undefined | false)[]): HTMLElement {
  const g = h('div', { class: 'sp-group' });
  if (title) g.append(groupTitle(title));
  for (const r of rows) if (r) g.append(r instanceof HTMLElement ? r : r.el);
  return g;
}

export function note(text: string, cls = ''): HTMLElement {
  return h('p', { class: `sp-note${cls ? ` ${cls}` : ''}` }, text);
}

// ---------- Controls ----------

export function switchControl(checked: boolean, onChange: (on: boolean, input: HTMLInputElement) => void): HTMLInputElement {
  const input = h('input', { type: 'checkbox', class: 'switch', role: 'switch' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked, input));
  return input;
}

export interface Choice<T extends string | number> {
  value: T;
  label: string;
}

let groupSeq = 0;

/** A two- or three-way segmented control (radio buttons). */
export function segmented<T extends string | number>(choices: Choice<T>[], value: T, onChange: (v: T) => void): HTMLElement & { set(v: T): void; disable(on: boolean): void } {
  const name = `sp-seg-${++groupSeq}`;
  const root = h('div', { class: 'segmented sp-seg', role: 'radiogroup' }) as unknown as HTMLElement & { set(v: T): void; disable(on: boolean): void };
  const inputs: HTMLInputElement[] = [];
  for (const c of choices) {
    const input = h('input', { type: 'radio', name, value: String(c.value) });
    input.checked = c.value === value;
    input.addEventListener('change', () => {
      if (input.checked) onChange(c.value);
    });
    inputs.push(input);
    root.append(h('label', {}, input, h('span', {}, c.label)));
  }
  root.set = (v) => inputs.forEach((i, n) => (i.checked = choices[n].value === v));
  root.disable = (on) => inputs.forEach((i) => (i.disabled = on));
  return root;
}

/** A select with the app's chevron. */
export function selectControl<T extends string | number>(choices: Choice<T>[], value: T, onChange: (v: T) => void, width = 220): HTMLElement & { select: HTMLSelectElement; set(v: T): void } {
  const select = h('select', {});
  for (const c of choices) select.append(h('option', { value: String(c.value) }, c.label));
  select.value = String(value);
  select.addEventListener('change', () => {
    const c = choices.find((x) => String(x.value) === select.value);
    if (c) onChange(c.value);
  });
  const wrap = h('span', { class: 'select sp-select', style: `width:${width}px` }, select, h('span', { class: 'select-chev', html: icon('chevron-down', 14) })) as unknown as HTMLElement & {
    select: HTMLSelectElement;
    set(v: T): void;
  };
  wrap.select = select;
  wrap.set = (v) => (select.value = String(v));
  return wrap;
}

export interface TextOptions {
  value: string;
  placeholder?: string;
  /** password: masked, with a show/hide button */
  type?: 'text' | 'password' | 'number';
  width?: number;
  mono?: boolean;
  id?: string;
  multiline?: boolean;
  /** Called when the value is committed (Enter, ⌘Enter in a multi-line field, or leaving it) and differs from the last one */
  onCommit: (text: string) => void | Promise<void>;
}

export type TextControl = HTMLElement & { input: HTMLInputElement | HTMLTextAreaElement; set(v: string): void; committed(v: string): void };

/** A text field that commits on Enter or blur; Escape inside it puts the last committed value back. */
export function textControl(opts: TextOptions): TextControl {
  const multiline = Boolean(opts.multiline);
  const input = multiline ? h('textarea', { rows: 4 }) : h('input', { type: opts.type === 'password' ? 'password' : 'text', spellcheck: 'false', autocomplete: 'off' });
  if (opts.type === 'number') input.setAttribute('inputmode', 'numeric');
  if (opts.id) input.id = opts.id;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.className = `sp-input${opts.mono ? ' mono' : ''}`;
  input.value = opts.value;
  let last = opts.value;
  const commit = () => {
    if (input.value === last) return;
    void opts.onCommit(input.value);
  };
  input.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && (!multiline || ke.metaKey || ke.ctrlKey)) {
      e.preventDefault();
      commit();
    } else if (ke.key === 'Escape' && input.value !== last) {
      // The first Escape undoes the edit; the next one closes the page.
      e.preventDefault();
      e.stopPropagation();
      input.value = last;
      void opts.onCommit(last);
    }
  });
  input.addEventListener('blur', commit);
  const wrap = h('span', { class: `sp-text${multiline ? ' multiline' : ''}`, style: multiline ? '' : `width:${opts.width ?? 220}px` }, input) as unknown as TextControl;
  if (opts.type === 'password') {
    const eye = h('button', { type: 'button', class: 'sp-eye', 'aria-label': 'Show', title: 'Show', html: icon('eye', 14) });
    eye.addEventListener('click', () => {
      const show = (input as HTMLInputElement).type === 'password';
      (input as HTMLInputElement).type = show ? 'text' : 'password';
      eye.innerHTML = icon(show ? 'eye-off' : 'eye', 14);
      eye.setAttribute('aria-label', show ? 'Hide' : 'Show');
      eye.title = show ? 'Hide' : 'Show';
    });
    wrap.classList.add('has-eye');
    wrap.append(eye);
  }
  wrap.input = input;
  wrap.set = (v) => {
    input.value = v;
    last = v;
  };
  wrap.committed = (v) => (last = v);
  return wrap;
}

export function button(label: string, onClick: (btn: HTMLButtonElement) => void, opts: { icon?: IconName; danger?: boolean; primary?: boolean; small?: boolean; aria?: string } = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', class: `btn${opts.small !== false ? ' sm' : ''}${opts.primary ? ' primary' : ''}${opts.danger ? ' sp-danger' : ''}`, 'aria-label': opts.aria });
  b.innerHTML = `${opts.icon ? icon(opts.icon, 14) : ''}<span>${escapeHtml(label)}</span>`;
  b.addEventListener('click', () => onClick(b));
  return b;
}

export function iconButton(name: IconName, label: string, onClick: (btn: HTMLButtonElement) => void): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'icon-btn sm sp-icon-btn', 'aria-label': label, title: label, html: icon(name, 14) });
  b.addEventListener('click', () => onClick(b));
  return b;
}

export interface MenuItem {
  label: string;
  icon: IconName;
  danger?: boolean;
  run: () => void;
}

/** A small menu under a button, inside the page (the window's menus sit under the Settings dialog). */
export function dropdown(btn: HTMLButtonElement, wrap: HTMLElement, items: () => MenuItem[]): void {
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

/** A "New ⌄" button with its menu (`items` is read each time it opens); `wrap` goes in the page. */
export function newMenu(items: () => MenuItem[], cls?: string): { wrap: HTMLElement; btn: HTMLButtonElement } {
  const wrap = h('span', { class: 'sp-menu-wrap' });
  const btn = button('New', () => {}, { icon: 'plus' });
  btn.insertAdjacentHTML('beforeend', icon('chevron-down', 12));
  if (cls) btn.classList.add(cls);
  wrap.append(btn);
  dropdown(btn, wrap, items);
  return { wrap, btn };
}

export function actions(...items: (HTMLElement | null | false | undefined)[]): HTMLElement {
  const el = h('div', { class: 'sp-actions' });
  for (const i of items) if (i) el.append(i);
  return el;
}

export function chip(label: string, tone: 'neutral' | 'warn' | 'danger' | 'ok' = 'neutral'): HTMLElement {
  return h('span', { class: `sp-chip ${tone}` }, label);
}

/** "~/Documents/x" for a path under the home folder. */
export function tildePath(p: string): string {
  return tilde(String(p ?? ''));
}

/** Runs an action with the button busy; a failure shows under the row (or is returned). */
export async function busy<T>(btn: HTMLButtonElement | null, fn: () => Promise<T>): Promise<T> {
  if (btn) {
    btn.disabled = true;
    btn.classList.add('busy');
  }
  try {
    return await fn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }
}

export function nextId(prefix: string): string {
  return `${prefix}-${++uid}`;
}
