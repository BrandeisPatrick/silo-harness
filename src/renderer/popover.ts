// Popover menus (mode chip, model chip, session "…" and context menus) and hover tooltips.

import { escapeHtml } from './dom.js';
import { icon, type IconName } from './icons.js';

export interface MenuItem {
  label: string;
  description?: string;
  icon?: IconName;
  checked?: boolean;
  danger?: boolean;
  /** Tints the icon (e.g. the permission mode colours) */
  tone?: 'accent' | 'success' | 'danger';
  disabled?: boolean;
  /** Right-aligned hint, e.g. a shortcut */
  hint?: string;
  onSelect?: () => void;
}

export interface MenuSection {
  label?: string;
  items: MenuItem[];
  /** Muted line shown under the items (e.g. "Loading models…", an error) */
  note?: string;
}

export interface MenuOptions {
  anchor: HTMLElement | { x: number; y: number };
  placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
  /** Keep the menu horizontally inside this element (e.g. so it never slides under the native browser view) */
  boundary?: HTMLElement;
  minWidth?: number;
  className?: string;
  /** Markup shown above the first section (e.g. the context meter's numbers); not focusable */
  header?: string;
  footer?: string;
  onClose?: () => void;
}

export interface MenuHandle {
  el: HTMLElement;
  update(sections: MenuSection[]): void;
  /** Replaces the header markup in place (the items, selection and position stay) */
  setHeader(html: string): void;
  close(): void;
}

let open: { handle: MenuHandle; opts: MenuOptions; cleanup: () => void } | null = null;

export function isMenuOpen(): boolean {
  return open !== null;
}

export function closeMenu(): void {
  open?.handle.close();
}

/** The menu currently anchored to `el`, if any. */
export function menuAnchoredTo(el: HTMLElement): boolean {
  return open !== null && open.opts.anchor === el;
}

export function openMenu(sections: MenuSection[], opts: MenuOptions): MenuHandle {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'popover' + (opts.className ? ` ${opts.className}` : '');
  el.setAttribute('role', 'menu');
  el.tabIndex = -1;
  if (opts.minWidth) el.style.minWidth = `${opts.minWidth}px`;
  let items: { btn: HTMLButtonElement; item: MenuItem }[] = [];
  let active = -1;
  const previousFocus = document.activeElement as HTMLElement | null;

  const setActive = (i: number) => {
    active = i;
    items.forEach((it, k) => it.btn.classList.toggle('active', k === i));
    items[i]?.btn.scrollIntoView({ block: 'nearest' });
  };

  const render = (secs: MenuSection[]) => {
    el.innerHTML = '';
    items = [];
    if (opts.header) el.insertAdjacentHTML('beforeend', `<div class="pop-head">${opts.header}</div>`);
    secs.forEach((sec, si) => {
      if (si > 0 || opts.header) el.insertAdjacentHTML('beforeend', '<div class="pop-sep" role="separator"></div>');
      if (sec.label) el.insertAdjacentHTML('beforeend', `<div class="pop-label">${escapeHtml(sec.label)}</div>`);
      for (const item of sec.items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pop-item' + (item.danger ? ' danger' : '') + (item.checked ? ' checked' : '') + (item.tone ? ` tone-${item.tone}` : '');
        btn.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
        if (item.checked !== undefined) btn.setAttribute('aria-checked', String(item.checked));
        btn.disabled = Boolean(item.disabled);
        btn.innerHTML =
          (item.icon ? `<span class="pop-icon">${icon(item.icon)}</span>` : '') +
          `<span class="pop-text"><span class="pop-title">${escapeHtml(item.label)}</span>${item.description ? `<span class="pop-desc">${escapeHtml(item.description)}</span>` : ''}</span>` +
          (item.hint ? `<span class="pop-hint">${escapeHtml(item.hint)}</span>` : '') +
          (item.checked ? `<span class="pop-check">${icon('check')}</span>` : '');
        const index = items.length;
        btn.addEventListener('mousemove', () => {
          if (active !== index && !btn.disabled) setActive(index);
        });
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          if (btn.disabled) return;
          handle.close();
          item.onSelect?.();
        });
        el.appendChild(btn);
        items.push({ btn, item });
      }
      if (sec.note) el.insertAdjacentHTML('beforeend', `<div class="pop-note">${escapeHtml(sec.note)}</div>`);
    });
    if (opts.footer) el.insertAdjacentHTML('beforeend', `<div class="pop-foot">${opts.footer}</div>`);
    const checked = items.findIndex((it) => it.item.checked && !it.item.disabled);
    setActive(checked >= 0 ? checked : -1);
  };

  const position = () => {
    const placement = opts.placement ?? 'bottom-start';
    // Measured at its natural height; a menu taller than the room it gets is capped to that room and scrolls (a
    // provider listing dozens of models used to flip below the model chip, off the bottom of the window)
    el.style.maxHeight = '';
    const w = el.offsetWidth;
    let hgt = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bound = opts.boundary?.getBoundingClientRect() ?? new DOMRect(0, 0, vw, vh);
    const cap = (room: number) => {
      if (hgt <= room) return;
      hgt = Math.max(0, room);
      el.style.maxHeight = `${Math.floor(hgt)}px`;
    };
    let left: number;
    let top: number;
    if ('x' in opts.anchor) {
      left = opts.anchor.x;
      top = opts.anchor.y;
      if (top + hgt > vh - 8) top = Math.max(8, top - hgt);
      cap(vh - 8 - top);
    } else {
      const r = opts.anchor.getBoundingClientRect();
      left = placement.endsWith('end') ? r.right - w : r.left;
      const roomAbove = r.top - 6 - 8;
      const roomBelow = vh - 8 - (r.bottom + 6);
      // The side asked for when the menu fits there, else the other side when it fits there, else the roomier one
      const preferAbove = placement.startsWith('top');
      const fitsFirst = hgt <= (preferAbove ? roomAbove : roomBelow);
      const fitsOther = hgt <= (preferAbove ? roomBelow : roomAbove);
      const above = fitsFirst ? preferAbove : fitsOther ? !preferAbove : roomAbove >= roomBelow;
      cap(above ? roomAbove : roomBelow);
      top = above ? r.top - 6 - hgt : r.bottom + 6;
    }
    const minLeft = Math.max(8, bound.left + 8);
    const maxLeft = Math.min(vw - 8, bound.right - 8) - w;
    left = Math.max(minLeft, Math.min(left, maxLeft));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handle.close(true);
      return;
    }
    if (e.key === 'Tab') {
      handle.close();
      return;
    }
    const enabled = items.map((it, k) => (it.btn.disabled ? -1 : k)).filter((k) => k >= 0);
    if (!enabled.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const pos = enabled.indexOf(active);
      const next = e.key === 'ArrowDown' ? enabled[(pos + 1) % enabled.length] : enabled[(pos - 1 + enabled.length) % enabled.length];
      setActive(pos < 0 ? enabled[e.key === 'ArrowDown' ? 0 : enabled.length - 1] : next);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? enabled[0] : enabled[enabled.length - 1]);
    } else if ((e.key === 'Enter' || e.key === ' ') && active >= 0) {
      e.preventDefault();
      e.stopPropagation();
      items[active].btn.click();
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (el.contains(t)) return;
    if (!('x' in opts.anchor) && opts.anchor.contains(t)) return;
    handle.close();
  };
  const onResize = () => handle.close();

  const handle: MenuHandle & { close(restoreFocus?: boolean): void } = {
    el,
    update(secs: MenuSection[]) {
      render(secs);
      position();
    },
    setHeader(html: string) {
      opts.header = html;
      const head = el.querySelector<HTMLElement>(':scope > .pop-head');
      if (head) head.innerHTML = html;
    },
    close(restoreFocus = false) {
      if (!open || open.handle !== handle) return;
      open.cleanup();
      open = null;
      el.remove();
      if (!('x' in opts.anchor)) opts.anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && previousFocus && document.contains(previousFocus)) previousFocus.focus();
      opts.onClose?.();
    },
  };

  render(sections);
  // A menu opened from inside a modal dialog (Settings) lives in that dialog (what is outside a modal dialog is inert:
  // it could not be clicked) and goes to the top layer too, or it would sit behind the dialog
  const dialog = 'x' in opts.anchor ? null : opts.anchor.closest<HTMLDialogElement>('dialog[open]');
  (dialog ?? document.body).appendChild(el);
  if (dialog && typeof el.showPopover === 'function') {
    el.setAttribute('popover', 'manual');
    try {
      el.showPopover();
    } catch {
      /* stays in the page */
    }
  }
  if (!('x' in opts.anchor)) opts.anchor.setAttribute('aria-expanded', 'true');
  position();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', onResize);
  open = {
    handle,
    opts,
    cleanup: () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
    },
  };
  el.focus({ preventScroll: true });
  return handle;
}

// ---------- Tooltips ----------

let tipEl: HTMLElement | null = null;
let tipTarget: HTMLElement | null = null;
let tipTimer: number | undefined;
let lastHidden = 0;

function hideTip(): void {
  window.clearTimeout(tipTimer);
  if (tipEl && tipTarget) lastHidden = Date.now();
  tipTarget = null;
  tipEl?.classList.remove('show');
}

function showTip(target: HTMLElement, avoid: () => DOMRect | null): void {
  const text = target.dataset.tip;
  if (!text || !document.contains(target)) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  const kbd = target.dataset.tipKbd;
  // Long tips (a queued message's full text) wrap instead of running off the screen.
  tipEl.classList.toggle('wrap', text.length > 64 || text.includes('\n'));
  tipEl.innerHTML = `<span>${escapeHtml(text)}</span>${kbd ? kbd.split(' ').map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('') : ''}`;
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const hgt = tipEl.offsetHeight;
  let left = Math.round(r.left + r.width / 2 - w / 2);
  left = Math.max(8, Math.min(left, window.innerWidth - 8 - w));
  let top = r.bottom + 6;
  const blocked = avoid();
  const overlaps = (t: number) => blocked !== null && left < blocked.right && left + w > blocked.left && t < blocked.bottom && t + hgt > blocked.top;
  if (top + hgt > window.innerHeight - 8 || overlaps(top)) top = r.top - 6 - hgt;
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${Math.round(top)}px`;
  tipEl.classList.add('show');
}

/** Hover/focus tooltips for every element with data-tip (and optional data-tip-kbd="⌘ B"). */
export function initTooltips(avoid: () => DOMRect | null): void {
  document.addEventListener('pointerover', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    if (target === tipTarget) return;
    hideTip();
    if (!target || target.matches('[aria-expanded="true"]')) return;
    tipTarget = target;
    const warm = Date.now() - lastHidden < 400;
    tipTimer = window.setTimeout(() => showTip(target, avoid), warm ? 0 : 450);
  });
  document.addEventListener('pointerout', (e) => {
    if (!tipTarget) return;
    const to = e.relatedTarget as Node | null;
    if (to && tipTarget.contains(to)) return;
    hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const target = e.target as HTMLElement;
    if (target.dataset?.tip && target.matches(':focus-visible')) {
      hideTip();
      tipTarget = target;
      showTip(target, avoid);
    }
  });
  document.addEventListener('focusout', hideTip);
  window.addEventListener('pointerdown', hideTip, true);
  window.addEventListener('keydown', hideTip, true);
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);
}
