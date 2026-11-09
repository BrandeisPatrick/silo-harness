// Small DOM helpers shared by the renderer modules.

import { icon } from './icons.js';

/** The element with this id; the window's markup is static, so a missing one is a bug worth throwing for. */
export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

type Attrs = Record<string, string | number | boolean | undefined | null>;

/** Creates an element. String children are inserted as text, never as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

const copyTimers = new WeakMap<HTMLElement, number>();

/**
 * Copies text and flips the button to a check (and "Copied" if it has a text label) for 1.5s.
 * The button's markup is expected to be `icon + optional <span>label</span>`.
 */
export async function copyWithFeedback(btn: HTMLElement, text: string): Promise<void> {
  const ok = await writeClipboard(text);
  if (!ok) return;
  const label = btn.querySelector('span');
  const size = Number(btn.querySelector('svg')?.getAttribute('width')) || 16;
  const prev = copyTimers.get(btn);
  if (prev) window.clearTimeout(prev);
  btn.classList.add('copied');
  btn.querySelector('svg')?.remove();
  btn.insertAdjacentHTML('afterbegin', icon('check', size));
  if (label) label.textContent = 'Copied';
  copyTimers.set(
    btn,
    window.setTimeout(() => {
      btn.classList.remove('copied');
      btn.querySelector('svg')?.remove();
      btn.insertAdjacentHTML('afterbegin', icon('copy', size));
      if (label) label.textContent = 'Copy';
      copyTimers.delete(btn);
    }, 1500),
  );
}

export function basename(p: string): string {
  const clean = p.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i >= 0 ? clean.slice(i + 1) : clean;
}

export function dirname(p: string): string {
  const clean = p.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i > 0 ? clean.slice(0, i + 1) : i === 0 ? '/' : '';
}

/** "14ms", "1.2s", "45s", "2m 05s" */
export function formatDuration(ms: number): string {
  if (ms < 100) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** "842", "12.4k", "124k", "1.2M" */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "512 B", "4.2 KB", "230 KB", "1.6 MB" (1 KB = 1024 bytes) */
export function formatBytes(n: number): string {
  const b = Math.max(0, Math.round(Number(n) || 0));
  if (b < 1000) return `${b} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = b / 1024;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${units[u]}`;
}

export function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(el.type);
  return (el as HTMLElement).isContentEditable === true;
}
