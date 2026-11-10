// The context meter under the chat bar (a ring for the tokens used against the model's window, with a popover to compact
// or open Settings) and the compaction divider that marks where earlier messages were folded into a summary.

import type { ContextBreakdown } from '../shared/context';
import type { CompactionInfo, ContextInfo } from '../shared/types';
import { escapeHtml, formatCount } from './dom.js';
import { rpc } from './rpc.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { closeMenu, menuAnchoredTo, openMenu, type MenuHandle, type MenuSection } from './popover.js';

/** Context windows as people say them: 16384 → "16k", 131072 → "128k", 128000 → "128k", 1048576 → "1M". */
export function formatWindow(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  // Round thousands first (128000 is also 125 × 1024), then the power-of-two sizes Ollama uses.
  if (v >= 1000 && v % 1000 === 0) return formatCount(v);
  if (v >= 1_048_576 && v % 1_048_576 === 0) return `${v / 1_048_576}M`;
  if (v >= 1024 && v % 1024 === 0) return `${v / 1024}k`;
  return formatCount(v);
}

/** A context estimate the meter can show (a positive limit), normalised; null otherwise. */
export function normalizeContext(info: unknown): ContextInfo | null {
  if (!info || typeof info !== 'object') return null;
  const c = info as Partial<ContextInfo>;
  const limit = Math.round(Number(c.limit));
  const tokens = Math.max(0, Math.round(Number(c.tokens) || 0));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const threshold = Number(c.threshold);
  return { tokens, limit, threshold: threshold > 0 && threshold <= 1 ? threshold : 0.8, autoCompact: c.autoCompact !== false };
}

export type ContextLevel = 'ok' | 'warn' | 'danger';

/** Rounded percentage used, and its level: neutral below 70%, amber 70–90%, red above 90%. */
export function contextUsage(c: ContextInfo): { pct: number; text: string; level: ContextLevel } {
  const pct = Math.round((c.tokens / c.limit) * 100);
  const text = c.tokens > 0 && pct === 0 ? '<1%' : `${pct}%`;
  return { pct, text, level: pct > 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok' };
}

/** "auto-compacts at 80%" or "auto-compact off" */
function autoText(c: ContextInfo): string {
  return c.autoCompact ? `auto-compacts at ${Math.round(c.threshold * 100)}%` : 'auto-compact off';
}

/** "Context 6.7k of 16k tokens · auto-compacts at 80%" */
export function contextTip(c: ContextInfo): string {
  return `Context ${formatCount(c.tokens)} of ${formatWindow(c.limit)} tokens · ${autoText(c)}`;
}

function ring(fraction: number, size: number): string {
  const fill = Math.max(0, Math.min(100, fraction * 100));
  return (
    `<svg class="meter-ring" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">` +
    `<circle class="meter-track" cx="8" cy="8" r="6"/>` +
    `<circle class="meter-fill" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray="${fill.toFixed(1)} 100" transform="rotate(-90 8 8)"/></svg>`
  );
}

/** The numbers at the top of the meter's popover: percentage, a bar with the auto-compact mark, tokens of window. */
function popoverHeader(c: ContextInfo): string {
  const u = contextUsage(c);
  const fill = Math.max(0, Math.min(100, (c.tokens / c.limit) * 100));
  const mark = c.autoCompact ? `<span class="ctx-mark" style="left: ${(c.threshold * 100).toFixed(1)}%"></span>` : '';
  return (
    `<div class="ctx-head ${u.level}">` +
    `<div class="ctx-row"><span class="ctx-title">Context window</span><span class="ctx-pct">${escapeHtml(u.text)}</span></div>` +
    `<div class="ctx-bar" role="presentation"><span class="ctx-fill" style="width: ${fill.toFixed(1)}%"></span>${mark}</div>` +
    `<div class="ctx-meta">${escapeHtml(`${formatCount(c.tokens)} of ${formatWindow(c.limit)} tokens · ${autoText(c)}`)}</div>` +
    `</div>`
  );
}

/** The breakdown list under the bar: one row per slice (label, tokens), the reserve and free space last. */
export function breakdownList(b: ContextBreakdown | null): string {
  if (!b || !Array.isArray(b.slices) || !b.slices.length) return '';
  const rows = b.slices
    .filter((sl) => sl && Number(sl.tokens) > 0)
    .map((sl) => {
      const muted = sl.key === 'reserve' || sl.key === 'free' ? ' muted' : '';
      const tip = Array.isArray(sl.items) && sl.items.length ? ` title="${escapeHtml(sl.items.map((it) => `${it.label}: ${formatCount(Math.round(it.tokens))}`).join('\n'))}"` : '';
      return `<div class="ctx-slice${muted}"${tip}><span class="ctx-slice-dot" data-key="${escapeHtml(String(sl.key))}"></span><span class="ctx-slice-label">${escapeHtml(sl.label)}</span><span class="ctx-slice-tokens">${escapeHtml(formatCount(Math.round(sl.tokens)))}</span></div>`;
    })
    .join('');
  const cached = b.basis === 'reported' && typeof b.cached === 'number' ? ` · ${Math.round(b.cached * 100)}% cached` : '';
  const basis = b.basis === 'reported' ? `Based on the last request${cached}` : 'Estimated';
  return `<div class="ctx-slices" role="list">${rows}</div><div class="ctx-basis">${escapeHtml(basis)}</div>`;
}

const STYLE_ID = 'compaction-styles';
/** The breakdown rows' styles live with the module (the feature has no stylesheet of its own). */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
.ctx-slices { margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--border-subtle); display: flex; flex-direction: column; }
.ctx-slice { display: flex; align-items: center; gap: 8px; min-height: 24px; font-size: var(--fs-small); line-height: var(--lh-small); color: var(--text-200); }
.ctx-slice.muted { color: var(--text-400); }
.ctx-slice-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--text-400); }
.ctx-slice.muted .ctx-slice-dot { background: transparent; box-shadow: inset 0 0 0 1px var(--text-400); }
.ctx-slice-dot[data-key="messages"], .ctx-slice-dot[data-key="summary"] { background: var(--accent); }
.ctx-slice-dot[data-key="toolResults"] { background: var(--warn); }
.ctx-slice-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-slice-tokens { flex: none; font-variant-numeric: tabular-nums; }
.ctx-basis { margin-top: 8px; font-size: var(--fs-micro); line-height: var(--lh-micro); color: var(--text-400); }
`;
  document.head.appendChild(el);
}

export interface ContextMeterOptions {
  /** #context-meter */
  button: HTMLButtonElement;
  /** The popover stays horizontally inside this element */
  boundary?: HTMLElement;
  /** A run or a compaction is in progress: "Compact now" is disabled */
  busy: () => boolean;
  compact: () => void;
  openSettings: () => void;
}

export interface ContextMeter {
  /** Shows the estimate (null hides the meter) */
  set(info: ContextInfo | null): void;
  get(): ContextInfo | null;
}

export function createContextMeter(o: ContextMeterOptions): ContextMeter {
  const btn = o.button;
  let info: ContextInfo | null = null;
  let menu: MenuHandle | null = null;
  /** The last breakdown for the open popover; dropped when it closes */
  let breakdown: ContextBreakdown | null = null;
  /** False once the main process did not know context.breakdown: the list stays away */
  let breakdownKnown = true;
  let fetchSeq = 0;
  const header = () => (info ? popoverHeader(info) + breakdownList(breakdown) : '');
  const fetchBreakdown = () => {
    if (!breakdownKnown) return;
    const my = ++fetchSeq;
    rpc('context.breakdown')
      .then((b) => {
        if (my !== fetchSeq || !menu || !menuAnchoredTo(btn)) return;
        breakdown = b && typeof b === 'object' && Array.isArray(b.slices) ? b : null;
        // The list makes the popover taller: update() re-renders with the new header and places it again, so it
        // grows upwards from the meter instead of running past the bottom of the window.
        menu.setHeader(header());
        menu.update(sections());
      })
      .catch((err: unknown) => {
        if (/No handler registered|Unknown (?:RPC )?method|unknown method/i.test(String((err as Error)?.message ?? err))) breakdownKnown = false;
      });
  };

  const render = () => {
    if (!info) {
      btn.hidden = true;
      btn.innerHTML = '';
      delete btn.dataset.level;
      if (menuAnchoredTo(btn)) closeMenu();
      return;
    }
    const u = contextUsage(info);
    btn.hidden = false;
    btn.dataset.level = u.level;
    btn.classList.toggle('warn', u.level === 'warn');
    btn.classList.toggle('danger', u.level === 'danger');
    // The ring alone; the percentage is in its tooltip
    btn.innerHTML = ring(info.tokens / info.limit, 12);
    btn.dataset.tip = `${u.text} used · ${contextTip(info)}`;
    btn.setAttribute('aria-label', `Context: ${u.text} used, ${formatCount(info.tokens)} of ${formatWindow(info.limit)} tokens`);
    if (menu && menuAnchoredTo(btn)) {
      menu.setHeader(header());
      fetchBreakdown();
    }
  };

  const sections = (): MenuSection[] => [
    {
      items: [
        { label: 'Compact now', description: 'Summarise the conversation to free context', icon: 'fold', disabled: o.busy(), onSelect: o.compact },
        { label: 'Open settings', icon: 'settings', hint: '⌘,', onSelect: o.openSettings },
      ],
    },
  ];

  btn.addEventListener('click', () => {
    if (menuAnchoredTo(btn)) return closeMenu();
    if (!info) return;
    ensureStyles();
    breakdown = null;
    menu = openMenu(sections(), {
      anchor: btn,
      placement: 'top-start',
      boundary: o.boundary,
      minWidth: 280,
      className: 'context-menu',
      header: header(),
      onClose: () => {
        menu = null;
        breakdown = null;
      },
    });
    fetchBreakdown();
  });

  return {
    set(next: ContextInfo | null) {
      info = next ? normalizeContext(next) : null;
      render();
    },
    get: () => info,
  };
}

// ---------- Compaction divider ----------

/** "Compacted · 14 messages summarised, 6 kept · 21k → 6k tokens" (older compactions kept nothing and say less). */
export function compactionLabel(c: CompactionInfo): string {
  const before = Math.max(0, Math.round(Number(c?.tokensBefore) || 0));
  const after = Math.max(0, Math.round(Number(c?.tokensAfter) || 0));
  const folded = Math.max(0, Math.round(Number(c?.messages) || 0));
  const kept = Math.max(0, Math.round(Number(c?.kept) || 0));
  const verb = c?.stage === 'dropped' ? 'dropped' : 'summarised';
  const what = folded ? `${folded} message${folded === 1 ? '' : 's'} ${verb}${kept ? `, ${kept} kept` : ''}` : '';
  return ['Compacted', what, `${formatCount(before)} → ${formatCount(after)} tokens`].filter(Boolean).join(' · ');
}

/** The divider over a thin rule; the chevron opens the brief (collapsed by default). */
export function createCompactionDivider(c: CompactionInfo): HTMLDetailsElement {
  const el = document.createElement('details');
  el.className = 'compaction';
  if (c?.id) el.dataset.compactionId = String(c.id);
  if (c?.stage) el.dataset.stage = String(c.stage);
  const label = compactionLabel(c);
  const meta: string[] = [c?.reason === 'auto' ? 'Compacted automatically' : 'Compacted with /compact'];
  if (c?.stage === 'dropped') meta.push('no summary, so the oldest messages were dropped');
  const pruned = Math.round(Number(c?.pruned) || 0);
  if (pruned > 0) meta.push(`${formatCount(pruned)} tokens of old tool output cleared`);
  const at = Number(c?.createdAt);
  if (at > 0) meta.push(new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  el.innerHTML =
    `<summary><span class="compaction-rule"></span>` +
    `<span class="compaction-label"><span class="compaction-icon">${icon('fold', 14)}</span><span class="compaction-text">${escapeHtml(label)}</span>` +
    `<span class="compaction-chev">${icon('chevron-down', 14)}</span></span><span class="compaction-rule"></span></summary>` +
    `<div class="compaction-card"><div class="compaction-meta">${escapeHtml(meta.join(' · '))}</div>` +
    `<div class="md compaction-summary">${renderMarkdown(typeof c?.summary === 'string' && c.summary.trim() ? c.summary : '_No summary was kept._')}</div></div>`;
  return el;
}
