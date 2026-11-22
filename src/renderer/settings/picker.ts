// A picker: a button that looks like a select and opens a list under it. Settings → Models uses it for the provider
// (each with its status dot) and the model (with a search field: filter as you type, the first fifty matches, and what
// was typed when it is no id listed). The list is a popover inside the dialog (the top layer), fixed to the button.

import { escapeHtml, h } from '../dom.js';
import { icon } from '../icons.js';

export type DotTone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface PickItem {
  value: string;
  /** What the list shows (cut by the caller if need be) */
  label: string;
  /** The whole text, on hover */
  title?: string;
  /** A status dot before the label */
  dot?: DotTone;
  /** A muted word after the label */
  note?: string;
}

export interface PickList {
  items: PickItem[];
  /** A muted line at the foot ("Type to narrow 1,240 more") */
  foot?: string;
  /** When there are no items */
  empty?: string;
}

export interface PickerOptions {
  /** The button's id (its row's control) */
  id: string;
  width: number;
  /** Screen readers: what it chooses */
  label: string;
  /** Ids and model names: monospace */
  mono?: boolean;
  /** The list's least width (default 260; a model's list is wider, for long ids) */
  popWidth?: number;
  /** A search field at the top of the list */
  search?: { placeholder: string };
  /** The list, for what is typed ('' without a search field) */
  list: (query: string) => PickList;
  onPick: (value: string) => void;
}

export interface Picker {
  el: HTMLElement;
  button: HTMLButtonElement;
  /** What the button shows */
  show(label: string, opts?: { title?: string; dot?: DotTone; placeholder?: boolean }): void;
  disable(on: boolean): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Asks the list again while it is open (a list of models came) */
  refresh(): void;
}

/** The dot of a status: an SVG circle in the status colour */
export function dot(tone: DotTone): string {
  return `<svg class="sp-dot ${tone}" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>`;
}

export function picker(opts: PickerOptions): Picker {
  const labelEl = h('span', { class: `sp-picker-label${opts.mono ? ' mono' : ''}` });
  const dotEl = h('span', { class: 'sp-picker-dot', hidden: true });
  const button = h('button', { type: 'button', class: 'sp-picker-btn', id: opts.id, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': opts.label }, dotEl, labelEl, h('span', { class: 'sp-picker-chev', html: icon('chevron-down', 14) }));
  const el = h('span', { class: 'sp-picker', style: `width:${opts.width}px` }, button);

  let pop: HTMLElement | null = null;
  let input: HTMLInputElement | null = null;
  let listEl: HTMLElement | null = null;
  let items: PickItem[] = [];
  let active = 0;
  let query = '';

  const onOutside = (e: Event) => {
    if (!pop) return;
    const t = e.target as Node;
    if (pop.contains(t) || button.contains(t)) return;
    close();
  };
  const onScroll = (e: Event) => {
    if (pop && !pop.contains(e.target as Node)) close();
  };

  function place(): void {
    if (!pop) return;
    const r = button.getBoundingClientRect();
    // Placed in the dialog's box (absolute), so it opens upward when the dialog has no room below the button
    const host = pop.offsetParent instanceof HTMLElement ? pop.offsetParent.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const below = host.bottom - r.bottom;
    const above = r.top - host.top;
    const height = Math.min(pop.scrollHeight, 340);
    const up = below < height + 16 && above > below;
    // As wide as the button, or wider for long ids, kept inside the dialog
    const width = Math.max(r.width, opts.popWidth ?? 260);
    const right = host.right;
    pop.style.left = `${Math.min(r.left, right - width - 8) - host.left}px`;
    pop.style.top = up ? `${r.top - host.top - height - 4}px` : `${r.bottom - host.top + 4}px`;
    pop.style.width = `${width}px`;
  }

  function render(): void {
    if (!listEl) return;
    const out = opts.list(query);
    items = out.items;
    if (active >= items.length) active = Math.max(0, items.length - 1);
    listEl.replaceChildren(
      ...items.map((it, i) => {
        const opt = h('div', { class: `sp-picker-item${i === active ? ' active' : ''}`, role: 'option', id: `${opts.id}-opt-${i}`, 'aria-selected': String(i === active), title: it.title ?? it.label });
        opt.innerHTML = `${it.dot ? dot(it.dot) : ''}<span class="sp-picker-text${opts.mono ? ' mono' : ''}">${escapeHtml(it.label)}</span>${it.note ? `<span class="sp-picker-note">${escapeHtml(it.note)}</span>` : ''}`;
        opt.addEventListener('mousedown', (e) => e.preventDefault());
        opt.addEventListener('click', () => pick(i));
        opt.addEventListener('mousemove', () => {
          if (active !== i) {
            active = i;
            mark();
          }
        });
        return opt;
      }),
      ...(!items.length && out.empty ? [h('div', { class: 'sp-picker-empty' }, out.empty)] : []),
      ...(out.foot ? [h('div', { class: 'sp-picker-foot' }, out.foot)] : []),
    );
    mark();
    place();
  }

  function mark(): void {
    if (!listEl) return;
    listEl.querySelectorAll<HTMLElement>('.sp-picker-item').forEach((o, i) => {
      o.classList.toggle('active', i === active);
      o.setAttribute('aria-selected', String(i === active));
      if (i === active) o.scrollIntoView({ block: 'nearest' });
    });
    (input ?? button).setAttribute('aria-activedescendant', items.length ? `${opts.id}-opt-${active}` : '');
  }

  function pick(i: number): void {
    const it = items[i];
    if (!it) return;
    close();
    button.focus({ preventScroll: true });
    opts.onPick(it.value);
  }

  function onKey(e: KeyboardEvent): void {
    if (!pop) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      // The list closes, not the dialog
      e.preventDefault();
      e.stopPropagation();
      close();
      button.focus({ preventScroll: true });
    } else if (e.key === 'Tab') close();
  }

  function open(): void {
    if (pop || button.disabled) return;
    const host = button.closest('dialog') ?? document.body;
    query = '';
    active = 0;
    listEl = h('div', { class: 'sp-picker-list', role: 'listbox', id: `${opts.id}-list`, 'aria-label': opts.label });
    pop = h('div', { class: 'sp-picker-pop' });
    if (opts.search) {
      input = h('input', { type: 'text', class: 'sp-input mono sp-picker-search', placeholder: opts.search.placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': opts.search.placeholder, 'aria-controls': listEl.id, role: 'combobox', 'aria-expanded': 'true' });
      input.addEventListener('input', () => {
        query = input!.value;
        active = 0;
        render();
      });
      input.addEventListener('keydown', onKey);
      pop.append(input);
    }
    pop.append(listEl);
    host.append(pop);
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', listEl.id);
    render();
    (input ?? button).focus({ preventScroll: true });
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
  }

  function close(): void {
    if (!pop) return;
    pop.remove();
    pop = null;
    input = null;
    listEl = null;
    button.setAttribute('aria-expanded', 'false');
    button.removeAttribute('aria-activedescendant');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
  }

  button.addEventListener('click', () => (pop ? close() : open()));
  button.addEventListener('keydown', (e) => {
    if (!pop && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      open();
    } else onKey(e);
  });

  return {
    el,
    button,
    show(label, o = {}) {
      labelEl.textContent = label;
      labelEl.classList.toggle('placeholder', Boolean(o.placeholder));
      button.title = o.title ?? label;
      dotEl.hidden = !o.dot;
      dotEl.innerHTML = o.dot ? dot(o.dot) : '';
    },
    disable(on) {
      button.disabled = on;
      if (on) close();
    },
    open,
    close,
    isOpen: () => pop !== null,
    refresh: () => render(),
  };
}
