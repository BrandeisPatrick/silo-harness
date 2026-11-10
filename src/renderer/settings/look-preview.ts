// The previews of Settings → Mods → Background, Chat bar, Conversation and Theme: a miniature window, a sample chat
// bar or a sample exchange, each drawn in a shadow root of its own. Inside it are the app's own stylesheets (with
// `:root`, `html` and `body` read as the preview's `.lp-root` and `.lp-body`), the theme the preview is dressed in and
// the look it shows, both compiled by the main process for the preview's root (PREVIEW_ROOTS in
// src/main/mods/css.ts). Nothing in a preview reaches the window: its CSS lives in its shadow root and is scoped to
// its own root, the sample's ids (#chatbar, #messages, …) exist only in there, and it takes no input. Nothing of the
// window reaches a preview either, but the tokens it resets and the theme it is given.

import type { LookKind } from '../../shared/mods';
import { escapeHtml } from '../dom.js';
import { icon } from '../icons.js';
import { renderMarkdown } from '../markdown.js';
import { lookAttributes } from '../mods/logic.js';

/** The natural size of each kind of preview, in CSS pixels; it is scaled to the width it is given. */
const SIZES: Record<LookKind, { w: number; h: number }> = {
  background: { w: 1040, h: 650 },
  theme: { w: 1040, h: 650 },
  conversation: { w: 660, h: 470 },
  composer: { w: 820, h: 150 },
};
/** A card's: the chat bar gets room around it (not a sliver), the exchange a narrower column (so it reads larger) */
const CARD_SIZES: Partial<Record<LookKind, { w: number; h: number }>> = {
  composer: { w: 520, h: 210 },
  conversation: { w: 560, h: 400 },
};

export interface PreviewState {
  /** The theme it is dressed in, compiled for .lp-root ('' for the app's own) */
  themeCss: string;
  /** The look it shows (Chat bar, Conversation), compiled for .lp-root #chatbar or #messages ('' for Default) */
  lookCss?: string;
  /** That look's ref and its mod's settings: the attributes a look reacts to (data-look, data-set-…) */
  lookRef?: string | null;
  settings?: Record<string, unknown>;
  /** The permission mode the sample shows (data-mode) */
  mode?: string;
  /**
   * Background: the background itself (a picture's URL, a live view's element, or nothing). It fills the whole stage,
   * undimmed, behind and around the miniature window, and shows through the window's surfaces at `dim`.
   */
  backdrop?: { image?: string; view?: HTMLElement | null } | null;
  /** Background: how much the miniature window's surfaces cover what is behind them (0 to 1), as Dim does in the window */
  dim?: number;
}

export interface LookPreview {
  /** The stage: put it in the page; it keeps the preview's proportions at whatever width it gets */
  el: HTMLElement;
  /** The shadow root (open, for the live checks) */
  root: ShadowRoot;
  set(state: PreviewState): void;
  /** Background: Dim as the slider moves, before it is saved */
  setDim(dim: number): void;
  dispose(): void;
}

// ---------- Stylesheets shared by every preview ----------

let appSheet: CSSStyleSheet | null = null;
let ownSheet: CSSStyleSheet | null = null;
const cssSheets = new Map<string, CSSStyleSheet>();

/** `:root` and `html` as the preview's root, `body` as its page (outside strings and attribute values). */
function rewriteSelector(sel: string): string {
  return sel
    .replace(/:root(?![\w-])/g, '.lp-root')
    .replace(/(^|[\s,>+~(])html(?![\w-])/g, '$1.lp-root')
    .replace(/(^|[\s,>+~(])body(?![\w-])/g, '$1.lp-body');
}

function ruleText(r: CSSRule): string {
  if (r instanceof CSSStyleRule) {
    const nested = r.cssRules?.length ? [...r.cssRules].map(ruleText).join('\n') : '';
    return `${rewriteSelector(r.selectorText)} { ${r.style.cssText} ${nested} }`;
  }
  if (r instanceof CSSMediaRule) return `@media ${r.conditionText} { ${[...r.cssRules].map(ruleText).join('\n')} }`;
  if (r instanceof CSSSupportsRule) return `@supports ${r.conditionText} { ${[...r.cssRules].map(ruleText).join('\n')} }`;
  if (typeof CSSContainerRule !== 'undefined' && r instanceof CSSContainerRule) return `@container ${r.conditionText} { ${[...r.cssRules].map(ruleText).join('\n')} }`;
  if (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule) return `@layer ${r.name} { ${[...r.cssRules].map(ruleText).join('\n')} }`;
  return r.cssText;
}

/** The app's own stylesheets (never a mod's), read once, for every preview. */
function app(): CSSStyleSheet {
  if (appSheet) return appSheet;
  const parts: string[] = [];
  for (const sheet of [...document.styleSheets]) {
    const owner = sheet.ownerNode as HTMLElement | null;
    if (owner && (owner.dataset?.mod !== undefined || owner.dataset?.look !== undefined)) continue;
    if (sheet.href && /xterm\.css/.test(sheet.href)) continue;
    try {
      for (const r of [...sheet.cssRules]) parts.push(ruleText(r));
    } catch {
      /* a sheet we may not read */
    }
  }
  appSheet = new CSSStyleSheet();
  appSheet.replaceSync(parts.join('\n'));
  return appSheet;
}

/** The previews' own rules: the stage, the natural-size root scaled to fit, the samples' layout. */
function own(): CSSStyleSheet {
  if (ownSheet) return ownSheet;
  ownSheet = new CSSStyleSheet();
  ownSheet.replaceSync(`
:host { display: block; position: absolute; inset: 0; overflow: visible; }
.lp-root { position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: hidden; pointer-events: none; user-select: none; }
.lp-root, .lp-root * { transition: none !important; }
.lp-body { position: relative; z-index: 1; width: 100%; height: 100%; overflow: hidden; }
.lp-root.mod-bg, .lp-root.mod-bg > .lp-body { background: transparent !important; }
/* Background: a window floating over the background, which shows around it and through its surfaces */
.lp-root.lp-background { border-radius: 16px; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.1), 0 24px 64px rgba(0, 0, 0, 0.32); }
.lp-root .shell { height: 100%; }
.lp-root .sidebar { --sidebar-w: 236px; }
.lp-root .session-list { padding: 8px 8px 0; }
.lp-root .session-item { cursor: default; }
.lp-root .sidebar-foot, .lp-root .sidebar-toggle { display: none; }
.lp-root .transcript { overflow: hidden; scrollbar-gutter: auto; }
.lp-root.lp-conversation .transcript-wrap, .lp-root.lp-composer .transcript-wrap { height: 100%; min-width: 0; }
.lp-root.lp-conversation .transcript { padding: 24px 0 12px; }
.lp-root.lp-composer .lp-body { display: flex; flex-direction: column; justify-content: center; }
.lp-root.lp-composer .composer-wrap { left: 0; width: min(calc(var(--col) + 34px), calc(100% - 32px)); padding-bottom: 0; }
.lp-root .lp-card { margin: 0 0 16px; }
.lp-root .lp-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0 0; padding: 10px 0 0; border-top: 1px solid var(--border-subtle); font-size: var(--fs-ui); line-height: var(--lh-ui); color: var(--text-200); }
.lp-root .mod-offer-row { margin-top: 12px; }
`);
  return ownSheet;
}

function sheetFor(css: string): CSSStyleSheet | null {
  if (!css) return null;
  let s = cssSheets.get(css);
  if (!s) {
    s = new CSSStyleSheet();
    try {
      s.replaceSync(css);
    } catch {
      s.replaceSync('');
    }
    // A handful of themes and looks: the cache stays small, but never grows without end
    if (cssSheets.size > 60) cssSheets.delete(cssSheets.keys().next().value!);
    cssSheets.set(css, s);
  }
  return s;
}

// ---------- The samples ----------

const ring = (fraction: number) =>
  `<svg class="meter-ring" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle class="meter-track" cx="8" cy="8" r="6"/><circle class="meter-fill" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray="${(fraction * 100).toFixed(1)} 100" transform="rotate(-90 8 8)"/></svg>`;

/** The chat bar: a copy of the window's own (so it is always the same markup), emptied, with the ring showing. */
function chatbarHtml(): string {
  const real = document.getElementById('chatbar');
  if (!real) {
    return `<div class="chatbar" id="chatbar"><div class="composer" id="composer"><div class="composer-row"><button type="button" id="attach-btn" class="icon-btn composer-plus">${icon('plus-lg')}</button><textarea id="input" rows="1" placeholder="Describe a task, / for skills, @ for files"></textarea><button id="send-btn" class="send" disabled>${icon('corner-down-left')}</button></div></div><div class="composer-foot" id="composer-foot"><button id="model-btn" class="foot-btn">Model</button><button id="mode-btn" class="foot-btn">Ask</button><button type="button" id="context-meter" class="foot-btn context-meter">${ring(0.24)}</button></div></div>`;
  }
  const c = real.cloneNode(true) as HTMLElement;
  for (const a of [...c.attributes]) if (a.name.startsWith('data-')) c.removeAttribute(a.name);
  const att = c.querySelector<HTMLElement>('#attachments');
  if (att) {
    att.replaceChildren();
    att.hidden = true;
  }
  c.querySelector<HTMLElement>('#attach-note')?.setAttribute('hidden', '');
  c.querySelector('#attach-input')?.remove();
  c.querySelector('#composer')?.classList.remove('dragging');
  const ta = c.querySelector<HTMLTextAreaElement>('textarea');
  if (ta) {
    ta.textContent = '';
    ta.removeAttribute('style');
    const ph = (real.querySelector<HTMLTextAreaElement>('textarea')?.placeholder ?? '').trim();
    ta.setAttribute('placeholder', ph && !/queue/i.test(ph) ? ph : 'Describe a task, / for skills, @ for files, ⇧Tab to change mode');
  }
  const send = c.querySelector<HTMLButtonElement>('#send-btn');
  if (send) {
    send.classList.remove('stop');
    send.setAttribute('disabled', '');
    send.innerHTML = icon('corner-down-left');
  }
  const meter = c.querySelector<HTMLElement>('#context-meter');
  if (meter && (meter.hidden || !meter.innerHTML.trim())) {
    meter.hidden = false;
    meter.removeAttribute('hidden');
    meter.innerHTML = ring(0.24);
  }
  for (const b of c.querySelectorAll('button, textarea, input')) b.setAttribute('tabindex', '-1');
  return c.outerHTML;
}

const REPLY =
  'Done. `LoginOptions` takes a `backoffMs` now, and each retry waits twice as long as the one before:\n\n' +
  '```ts\nawait sleep(opts.backoffMs * 2 ** attempt);\n```\n\n' +
  '- the default stays **500 ms**\n- the test uses fake timers';

function conversationHtml(): string {
  const task = (status: string, title: string) =>
    `<li class="task-row" data-status="${status}"><span class="task-glyph" aria-hidden="true">${status === 'completed' ? icon('circle-check', 14) : status === 'in_progress' ? `<span class="spinner sm" aria-hidden="true"></span>${icon('arrow-filled', 14)}` : icon('circle', 14)}</span><span class="task-title">${escapeHtml(title)}</span></li>`;
  return (
    `<div class="msg user"><div class="bubble">Make the retry backoff configurable, and keep the login test green.</div></div>` +
    `<details class="tool-group"><summary><span class="tool-chevron">${icon('chevron-right')}</span><span class="group-icon">${icon('files')}</span><span class="tool-verb group-verb">Read 2 files, edited a file</span><span class="tool-arg group-arg"></span><span class="tool-meta group-meta"><span class="group-stat"><span class="git-add">+12</span> <span class="git-del">−3</span></span></span></summary><div class="group-body"></div></details>` +
    `<div class="msg assistant"><div class="md">${renderMarkdown(REPLY)}</div></div>` +
    `<div id="task-list" class="task-list" role="presentation"><ol class="task-rows">${task('completed', 'Take the delay from the options')}${task('in_progress', 'Use fake timers in the login test')}${task('pending', 'Run the suite')}</ol></div>`
  );
}

/** The miniature window: the sidebar's rows, a transcript with a card (a switch, a confirming button), the chat bar. */
function windowHtml(): string {
  const nav = (name: 'plus' | 'search', label: string) => `<div class="nav-row"><span class="nav-icon">${icon(name)}</span><span class="nav-label">${label}</span></div>`;
  const session = (title: string, active = false) => `<div class="session-item${active ? ' active' : ''}"><span class="label">${escapeHtml(title)}</span><span class="trail"></span></div>`;
  const top = (name: 'panel-list' | 'panel-right' | 'more', on = false) => `<span class="icon-btn top-btn${on ? ' active' : ''}">${icon(name)}</span>`;
  return (
    `<div class="shell">` +
    `<aside class="sidebar"><div class="sidebar-top"></div><nav class="sidebar-nav">${nav('plus', 'New session')}${nav('search', 'Search')}</nav>` +
    `<nav class="session-list">${session('Retry backoff', true)}${session('Flaky login test')}${session('Release notes for 1.2')}${session('Dependency updates')}</nav></aside>` +
    `<main class="main"><div class="chat-col"><header class="topbar"><div class="title-block"><div class="session-title">Retry backoff</div><span class="cwd-btn">${icon('folder', 12)}<span>~/code/app</span></span></div><span class="spacer"></span><div class="topbar-actions">${top('panel-list', true)}${top('more')}${top('panel-right')}</div></header>` +
    `<div class="content"><section class="transcript-wrap"><div id="messages" class="transcript">` +
    `<div class="msg user"><div class="bubble">Make the retry backoff configurable.</div></div>` +
    `<div class="msg assistant"><div class="md"><p>Sure. The retry loop in <code>login.ts</code> waits a fixed three seconds; I'll take the delay from the options instead.</p></div></div>` +
    `<div class="mod-offer lp-card"><div class="mod-offer-head"><span class="mod-offer-icon">${icon('puzzle')}</span><div class="mod-offer-heading"><div class="mod-offer-kicker">New mod</div><div class="mod-offer-title">Turn on Word count?</div></div></div>` +
    `<div class="lp-switch-row"><span>Update while streaming</span><input type="checkbox" class="switch" checked tabindex="-1"></div>` +
    `<div class="mod-offer-row"><span class="spacer"></span><button type="button" class="btn" tabindex="-1">Not now</button><button type="button" class="btn primary" tabindex="-1">Turn on</button></div></div>` +
    `</div><div class="composer-wrap">${chatbarHtml()}</div></section></div></div></main></div>`
  );
}

function sampleHtml(kind: LookKind): string {
  if (kind === 'conversation') return `<section class="transcript-wrap"><div id="messages" class="transcript">${conversationHtml()}</div></section>`;
  if (kind === 'composer') return `<div class="composer-wrap">${chatbarHtml()}</div>`;
  return windowHtml();
}

// ---------- A preview ----------

/** The scheme the window is in: the preview's root mirrors data-theme, so a theme's light and dark rules both work. */
function mirrorScheme(root: HTMLElement): void {
  const t = document.documentElement.dataset.theme;
  if (t) root.dataset.theme = t;
  else delete root.dataset.theme;
}

const schemeNow = (): 'light' | 'dark' => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || t === 'light' ? t : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

/**
 * A preview of one kind: `card` for the small one on a version's card (the same drawing, smaller). The stage keeps
 * the natural proportions; the drawing inside is laid out at its natural size and scaled to the stage's width.
 */
export function createLookPreview(kind: LookKind, opts: { card?: boolean; label?: string } = {}): LookPreview {
  const size = (opts.card && CARD_SIZES[kind]) || SIZES[kind];
  const el = document.createElement('div');
  el.className = `lp-stage lp-stage-${kind}${opts.card ? ' lp-stage-card' : ''}`;
  el.style.aspectRatio = `${size.w} / ${size.h}`;
  el.setAttribute('role', 'img');
  if (opts.label) el.setAttribute('aria-label', opts.label);
  // Background: the background fills the stage (in the page, behind the shadow root's host), the window is inset in it
  const backdrop = document.createElement('div');
  backdrop.className = 'lp-stage-backdrop';
  if (kind === 'background') {
    el.classList.add('lp-stage-bg');
    el.append(backdrop);
  }
  const hostEl = document.createElement('div');
  hostEl.className = 'lp-host';
  el.append(hostEl);
  const root = hostEl.attachShadow({ mode: 'open' });
  const lpRoot = document.createElement('div');
  lpRoot.className = `lp-root lp-${kind}`;
  lpRoot.style.width = `${size.w}px`;
  lpRoot.style.height = `${size.h}px`;
  lpRoot.setAttribute('inert', '');
  lpRoot.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div');
  body.className = 'lp-body';
  body.innerHTML = sampleHtml(kind);
  lpRoot.append(body);
  root.append(lpRoot);
  mirrorScheme(lpRoot);

  let state: PreviewState = { themeCss: '' };
  const region = () => (kind === 'composer' || kind === 'conversation' ? body.querySelector<HTMLElement>(kind === 'composer' ? '#chatbar' : '#messages') : null);

  const fit = () => {
    const w = hostEl.clientWidth;
    if (!w) return;
    lpRoot.style.transform = `scale(${w / size.w})`;
  };
  const ro = new ResizeObserver(fit);
  ro.observe(hostEl);
  const mo = new MutationObserver(() => {
    mirrorScheme(lpRoot);
    paintAttrs();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onMedia = () => paintAttrs();
  media.addEventListener('change', onMedia);

  function paintAttrs(): void {
    const r = region();
    if (!r) return;
    for (const a of [...r.attributes]) if (a.name === 'data-look' || a.name === 'data-running' || a.name === 'data-scheme' || a.name === 'data-mode' || a.name.startsWith('data-set-')) r.removeAttribute(a.name);
    if (!state.lookRef || !state.lookCss) return;
    for (const [n, v] of Object.entries(lookAttributes({ ref: state.lookRef, running: false, scheme: schemeNow(), mode: state.mode ?? 'ask', settings: state.settings ?? {} }))) r.setAttribute(n, v);
  }

  function setCover(dim: number): void {
    lpRoot.style.setProperty('--mod-cover', `${Math.round(Math.min(1, Math.max(0, dim)) * 100)}%`);
  }

  function setBackdrop(): void {
    const b = state.backdrop;
    const on = kind === 'background' && !!b && (!!b.image || !!b.view);
    lpRoot.classList.toggle('mod-bg', on);
    if (on) setCover(state.dim ?? 0.82);
    else lpRoot.style.removeProperty('--mod-cover');
    backdrop.style.backgroundImage = on && b!.image ? `url("${b!.image.replace(/"/g, '%22')}")` : '';
    const view = on ? (b!.view ?? null) : null;
    if (view && view.parentNode !== backdrop) backdrop.replaceChildren(view);
    else if (!view && backdrop.firstChild) backdrop.replaceChildren();
  }

  return {
    el,
    root,
    set(next) {
      state = next;
      root.adoptedStyleSheets = [app(), own(), sheetFor(next.themeCss), sheetFor(next.lookCss ?? '')].filter((x): x is CSSStyleSheet => !!x);
      paintAttrs();
      setBackdrop();
      fit();
    },
    setDim(dim) {
      state = { ...state, dim };
      if (lpRoot.classList.contains('mod-bg')) setCover(dim);
    },
    dispose() {
      ro.disconnect();
      mo.disconnect();
      media.removeEventListener('change', onMedia);
      backdrop.replaceChildren();
      el.remove();
    },
  };
}
