// Terminal pane: the app's shell tabs (oc.terminal) shown with xterm.js, under a tab strip like the Claude desktop
// app's terminal. Tabs live in the main process and outlive renderer reloads: each gets an xterm here that replays
// the tab's history and then follows its output. Only the active tab's xterm is on screen.

import type { IDisposable, ITheme, Terminal as XTerm } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { WebLinksAddon } from '@xterm/addon-web-links';
import type { TerminalApi, TerminalTabInfo } from '../shared/types';
import { escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { tilde } from './home.js';

export interface TerminalPaneOptions {
  /** #terminal-pane: holds the strip, the host and the empty state */
  root: HTMLElement;
  /** The tab strip (role="tablist"); the pane renders one .term-tab per shell tab into it */
  strip: HTMLElement;
  /** The "+" button after the strip */
  newButton: HTMLButtonElement;
  /** Where the xterms mount (one .term-view per tab) */
  host: HTMLElement;
  /** Unavailable, error and "no terminals" states */
  empty: HTMLElement;
  /** The terminal backend, or null when the running app does not have one yet */
  source: () => TerminalApi | null;
  /** Number of tabs with a command running, whenever it changes */
  onBusy: (count: number) => void;
  /** A link was clicked in a terminal (http and https only) */
  onOpenUrl: (url: string) => void;
  onError: (anchor: HTMLElement, message: string) => void;
  cleanError: (err: unknown) => string;
}

export interface TerminalPane {
  /** The pane is on screen: xterms are created for the tabs and fitted, and a first tab opens when there is none */
  setVisible(visible: boolean): void;
  /** Opens a new shell tab and focuses it; resolves to its id (null when no shell could be started) */
  newTab(): Promise<string | null>;
  /** Focuses the active terminal, or the tab this pane is about to open */
  focus(): void;
  /** True while an xterm in this pane has keyboard focus */
  hasFocus(): boolean;
  /** Shows a tab without moving focus; ignored while the user is typing in another terminal */
  select(id: string): void;
  /** The pane is about to be shown for an agent tool: do not open a shell of its own (the agent opens its tab) */
  holdAutoOpen(): void;
  /** Clears the active terminal's screen and scrollback (⌘K) */
  clearActive(): void;
  closeActive(): void;
  /** Sends text to a tab as if it was typed (the active tab by default); for the debug hook */
  input(text: string, id?: string): void;
  /** A tab's buffer as text, scrollback included, wrapped rows joined (the active tab by default; '' without an xterm) */
  screenText(id?: string): string;
  /** The tabs in strip order */
  tabs(): TerminalTabInfo[];
  activeId(): string | null;
  busyCount(): number;
  /** Re-reads the colour tokens; theme changes are also picked up on their own */
  setTheme(): void;
  /** The source changed (debug mock on or off): drop every xterm and load the tabs again */
  reset(): void;
}

interface Size {
  cols: number;
  rows: number;
}

interface View {
  id: string;
  term: XTerm;
  fit: FitAddon;
  /** .term-view: the xterm's parent, sized by the host (FitAddon measures it) */
  el: HTMLElement;
  /** The history was written; output that arrives before that is queued */
  ready: boolean;
  queue: string[];
  /** While old output is parsed, answers xterm generates (device attributes, cursor reports) must not reach the shell */
  replaying: boolean;
  exitShown: boolean;
  replacing: boolean;
  /** Size last sent to the backend (null: unknown, send after the first fit) */
  sent: Size | null;
  resizeTimer: number | undefined;
  disposables: IDisposable[];
}

/** A pending "focus the terminal" request; `forNew` ones belong to the createTab call that made them. */
interface FocusTicket {
  from: Element | null;
  until: number;
  forNew: boolean;
}

interface XtermLib {
  Terminal: typeof XTerm;
  FitAddon: typeof FitAddon;
  WebLinksAddon: typeof WebLinksAddon | undefined;
}

const FONT_FAMILY = '"SF Mono", SFMono-Regular, Menlo, Monaco, monospace';
const FONT_SIZE = 12;
const LINE_HEIGHT = 1.3;
/** xterm's vertical scrollbar width (FitAddon leaves room for it) */
const SCROLLBAR_WIDTH = 14;
/** The pty learns about a new size once it settles (dragging the pane edge); xterm itself refits every frame */
const RESIZE_DELAY = 80;
const ACTIVE_KEY = 'terminalTab';

type AnsiPalette = Required<
  Pick<
    ITheme,
    | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
    | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'
  >
>;

// Muted ANSI colours tuned to the app's warm neutrals. Every colour programs use for text on the default
// background has at least 4.5:1 contrast on --bg-100 (light #faf9f5, dark #262624). The background tones
// (white and bright white in light mode, black in dark mode) stay true to their role so "white on red" labels
// and black panels look right; xterm's minimumContrastRatio lifts them to 4.5:1 when they are used as text.
const LIGHT_ANSI: AnsiPalette = {
  black: '#2e2d2a', // 13.1:1
  red: '#b0372d', // 5.8
  green: '#3b7326', // 5.4
  yellow: '#7f6200', // 5.5
  blue: '#2c63a1', // 5.9
  magenta: '#943a82', // 6.3
  cyan: '#1e6e70', // 5.7
  white: '#d3d1c7',
  brightBlack: '#6e6d67', // 4.9
  brightRed: '#bf4532', // 4.9
  brightGreen: '#2f7a3c', // 5.0
  brightYellow: '#8a6b00', // 4.8
  brightBlue: '#3069b0', // 5.3
  brightMagenta: '#a64393', // 5.2
  brightCyan: '#18767a', // 5.1
  brightWhite: '#ffffff',
};
const DARK_ANSI: AnsiPalette = {
  black: '#141413',
  red: '#e8716a', // 5.1
  green: '#93bf6e', // 7.2
  yellow: '#d6b05c', // 7.4
  blue: '#7fa5d8', // 6.0
  magenta: '#c78ac2', // 5.7
  cyan: '#6db5ad', // 6.4
  white: '#c2c0b6', // 8.3
  brightBlack: '#9c9a92', // 5.4
  brightRed: '#f38a80', // 6.3
  brightGreen: '#a9d287', // 8.9
  brightYellow: '#e6c374', // 9.0
  brightBlue: '#97b9e6', // 7.5
  brightMagenta: '#d8a1d3', // 7.2
  brightCyan: '#86c9c1', // 8.0
  brightWhite: '#faf9f5', // 14.4
};

function xtermLib(): XtermLib | null {
  const Terminal = window.Terminal;
  const Fit = window.FitAddon?.FitAddon;
  if (typeof Terminal !== 'function' || typeof Fit !== 'function') return null;
  return { Terminal, FitAddon: Fit, WebLinksAddon: window.WebLinksAddon?.WebLinksAddon };
}

function isDarkTheme(): boolean {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** A #rrggbb colour at the given opacity (anything else falls back to the light theme's blue). */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  const n = parseInt(m ? m[1] : '1f66c4', 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** xterm's theme from the app's colour tokens. */
function readTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const dark = isDarkTheme();
  const token = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  const background = token('--bg-100', dark ? '#181818' : '#ffffff');
  const foreground = token('--text-100', dark ? '#f0f0f0' : '#191919');
  // The selection is blue, like the app's; the cursor is the text colour
  const accent = token('--accent', dark ? '#6b9bf0' : '#1f66c4');
  const thumb = token('--scroll-thumb', dark ? 'rgba(161, 161, 161, 0.35)' : 'rgba(102, 102, 102, 0.35)');
  const thumbHover = token('--scroll-thumb-hover', dark ? 'rgba(161, 161, 161, 0.55)' : 'rgba(102, 102, 102, 0.55)');
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: withAlpha(accent, dark ? 0.32 : 0.25),
    selectionInactiveBackground: withAlpha(accent, dark ? 0.18 : 0.14),
    scrollbarSliderBackground: thumb,
    scrollbarSliderHoverBackground: thumbHover,
    scrollbarSliderActiveBackground: thumbHover,
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
  };
}

const domId = (id: string): string => id.replace(/[^\w-]/g, '_');

function storedActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function storeActive(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
}

/** A cell of the terminal font, for sizing a tab before any xterm exists (rounded the way xterm's DOM renderer does). */
function measureCell(): { width: number; height: number } | null {
  try {
    const ctx = new OffscreenCanvas(16, 16).getContext('2d');
    if (!ctx) return null;
    ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    const m = ctx.measureText('W');
    const dpr = window.devicePixelRatio || 1;
    const height = Math.floor(Math.ceil((m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) * dpr) * LINE_HEIGHT) / dpr;
    return m.width > 0 && height > 0 ? { width: m.width, height } : null;
  } catch {
    return null;
  }
}

/**
 * The history the backend returned plus output that arrived while it loaded, without repeating what the history
 * already holds. Output sent before the history reply travels on the same IPC channel ahead of it, so it is normally
 * the end of the history; only chunks the history does not end with are appended.
 */
export function mergeReplay(history: string, queued: string[]): string {
  for (let k = queued.length; k > 0; k--) {
    const head = queued.slice(0, k).join('');
    if (history.endsWith(head)) return history + queued.slice(k).join('');
  }
  return history + queued.join('');
}

export function createTerminalPane(o: TerminalPaneOptions): TerminalPane {
  let api: TerminalApi | null = null;
  let unsubscribe: Array<() => void> = [];
  /** Bumped whenever the source is (re)connected; async results from an older source are dropped */
  let generation = 0;
  const infos = new Map<string, TerminalTabInfo>();
  /** Tab ids in strip order */
  let order: string[] = [];
  const views = new Map<string, View>();
  const tabEls = new Map<string, HTMLElement>();
  /** Sizes tabs were created with, until their view exists */
  const createdSizes = new Map<string, Size>();
  let active: string | null = null;
  let visible = false;
  /** A tab list arrived (from list() or a tabs event) */
  let loaded = false;
  /** The first list was applied; tabs that appear later are new */
  let seeded = false;
  let tabsSeq = 0;
  let creating = 0;
  let failure: { message: string; retry: 'load' | 'create' } | null = null;
  let focusWanted: FocusTicket | null = null;
  let theme = readTheme();
  let themeKey = JSON.stringify(theme);
  let lastBusy = -1;
  let lastSize: Size | null = null;
  let emptyKey = '';
  let fitQueued = false;
  /** Skip the next auto-open (the pane was shown for an agent tool) */
  let autoOpenHeld = false;

  // ---------- Source ----------

  function connect(): void {
    generation++;
    for (const off of unsubscribe) off();
    unsubscribe = [];
    for (const id of [...views.keys()]) disposeView(id);
    for (const el of tabEls.values()) el.remove();
    tabEls.clear();
    infos.clear();
    createdSizes.clear();
    order = [];
    active = null;
    loaded = false;
    seeded = false;
    creating = 0;
    failure = null;
    focusWanted = null;
    emptyKey = '';
    api = o.source();
    const a = api;
    if (a) {
      const offData = a.onData((id, data) => {
        if (a === api) onData(id, data);
      });
      const offTabs = a.onTabs((list) => {
        if (a !== api) return;
        tabsSeq++;
        loaded = true;
        applyTabs(Array.isArray(list) ? list : []);
      });
      for (const off of [offData, offTabs]) if (typeof off === 'function') unsubscribe.push(off);
      void load();
    }
    render();
    reportBusy();
  }

  async function load(): Promise<void> {
    const a = api;
    if (!a) return;
    const gen = generation;
    const seq = tabsSeq;
    if (failure?.retry === 'load') {
      failure = null;
      render();
    }
    let list: TerminalTabInfo[];
    try {
      list = await a.list();
    } catch (err) {
      if (gen !== generation) return;
      loaded = true;
      failure = { message: `Couldn't load the terminals: ${o.cleanError(err)}`, retry: 'load' };
      render();
      return;
    }
    if (gen !== generation) return;
    loaded = true;
    // A tabs event that arrived in the meantime is newer than this list.
    if (seq === tabsSeq) applyTabs(Array.isArray(list) ? list : []);
    else render();
    maybeAutoOpen();
  }

  function onData(id: string, data: string): void {
    const v = views.get(id);
    if (!v || typeof data !== 'string' || !data) return;
    if (v.ready) v.term.write(data);
    else v.queue.push(data);
  }

  /** Reconciles with the backend's tab list: views, the active tab, the strip, exit lines and the busy count. */
  function applyTabs(list: TerminalTabInfo[]): void {
    const prevOrder = order;
    const prevActive = active;
    const typing = hasFocus();
    infos.clear();
    for (const t of list) if (t && typeof t.id === 'string' && !infos.has(t.id)) infos.set(t.id, { ...t });
    order = prevOrder.filter((id) => infos.has(id));
    const fresh: string[] = [];
    for (const id of infos.keys()) {
      if (order.includes(id)) continue;
      order.push(id);
      fresh.push(id);
    }
    for (const id of [...views.keys()]) if (!infos.has(id)) disposeView(id);
    for (const id of [...createdSizes.keys()]) if (!infos.has(id)) createdSizes.delete(id);

    let next = prevActive && infos.has(prevActive) ? prevActive : null;
    if (!seeded) {
      const stored = storedActive();
      next = stored && infos.has(stored) ? stored : (order[order.length - 1] ?? null);
    } else {
      // A tab the agent opened comes forward, unless the user is typing in another one. (Tabs this pane opens are
      // activated when create() returns.)
      const pick = fresh.filter((id) => infos.get(id)?.agent).pop();
      if (pick && !(typing && next)) next = pick;
    }
    if (!next && order.length) next = neighbour(prevOrder, prevActive) ?? order[order.length - 1];
    seeded = true;
    setActive(next);
    if (visible) ensureViews();
    for (const v of views.values()) syncExit(v);
    showActive();
    renderStrip();
    render();
    reportBusy();
    if (active && views.has(active)) fulfilFocus(null);
  }

  /** The tab that takes over when `gone` (which was active) disappears: the one to its right, else to its left. */
  function neighbour(prev: string[], gone: string | null): string | null {
    const at = gone ? prev.indexOf(gone) : -1;
    if (at < 0) return null;
    for (let i = at + 1; i < prev.length; i++) if (infos.has(prev[i])) return prev[i];
    for (let i = at - 1; i >= 0; i--) if (infos.has(prev[i])) return prev[i];
    return null;
  }

  function setActive(id: string | null): void {
    active = id;
    if (id) storeActive(id);
  }

  /** Makes a tab the active one (explicitly: a click, the keyboard, a tab this pane opened). */
  function activate(id: string, focusTerminal: boolean): void {
    if (!infos.has(id)) return;
    setActive(id);
    if (visible) ensureViews();
    showActive();
    renderStrip();
    tabEls.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focusTerminal) focusActive();
  }

  function activeView(): View | undefined {
    return active ? views.get(active) : undefined;
  }

  // ---------- Views (one xterm per tab) ----------

  function ensureViews(): void {
    if (!api || !xtermLib()) return;
    for (const id of order) if (!views.has(id)) createView(id);
  }

  function createView(id: string): void {
    const lib = xtermLib();
    const a = api;
    if (!lib || !a) return;
    const el = document.createElement('div');
    el.className = 'term-view';
    el.id = `term-view-${domId(id)}`;
    el.setAttribute('role', 'tabpanel');
    el.setAttribute('aria-labelledby', `term-tab-${domId(id)}`);
    el.hidden = id !== active;
    o.host.appendChild(el);
    const term = new lib.Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      minimumContrastRatio: 4.5,
      theme,
      // OSC 8 hyperlinks (ls --hyperlink, compilers): http(s) only, opened in the Browser pane
      linkHandler: { activate: (ev, text) => openLink(ev, text), allowNonHttpProtocols: false },
    });
    const fit = new lib.FitAddon();
    term.loadAddon(fit);
    if (lib.WebLinksAddon) term.loadAddon(new lib.WebLinksAddon((ev, uri) => openLink(ev, uri)));
    const v: View = {
      id,
      term,
      fit,
      el,
      ready: false,
      queue: [],
      replaying: false,
      exitShown: false,
      replacing: false,
      sent: createdSizes.get(id) ?? null,
      resizeTimer: undefined,
      disposables: [],
    };
    createdSizes.delete(id);
    views.set(id, v);
    term.open(el);
    v.disposables.push(
      term.onData((data) => handleInput(v, data)),
      term.onResize(() => scheduleResize(v)),
    );
    if (id === active) fitView(v);
    else if (lastSize) sizeTo(v, lastSize);
    void replay(v, a);
  }

  async function replay(v: View, a: TerminalApi): Promise<void> {
    let history = '';
    try {
      history = String((await a.history(v.id)) ?? '');
    } catch {
      /* the tab is gone or the backend keeps no history: start from what arrives next */
    }
    if (views.get(v.id) !== v) return;
    const data = mergeReplay(history, v.queue);
    v.queue = [];
    v.ready = true;
    if (data) {
      v.replaying = true;
      v.term.write(data, () => {
        v.replaying = false;
      });
    }
    syncExit(v);
  }

  function disposeView(id: string): void {
    const v = views.get(id);
    if (!v) return;
    views.delete(id);
    window.clearTimeout(v.resizeTimer);
    for (const d of v.disposables) d.dispose();
    try {
      v.term.dispose();
    } catch {
      /* already disposed */
    }
    v.el.remove();
  }

  function handleInput(v: View, data: string): void {
    if (v.replaying || views.get(v.id) !== v) return;
    if (infos.get(v.id)?.exitCode !== undefined) {
      if (data.includes('\r')) void replaceExited(v);
      return;
    }
    api?.write(v.id, data);
  }

  /** Writes the "[Process exited with code N]" line once the shell has ended (after the history replay). */
  function syncExit(v: View): void {
    const code = infos.get(v.id)?.exitCode;
    if (!v.ready || v.exitShown || code === undefined) return;
    v.exitShown = true;
    v.term.write('', () => {
      if (views.get(v.id) !== v) return;
      const lineStart = v.term.buffer.active.cursorX === 0;
      // reset attributes, a dim line, then hide the cursor: nothing runs here any more
      v.term.write(`\x1b[0m${lineStart ? '' : '\r\n'}\x1b[90m[Process exited with code ${code}] Press Enter for a new shell.\x1b[0m\x1b[?25l`);
    });
  }

  function openLink(ev: MouseEvent, uri: string): void {
    ev.preventDefault();
    if (/^https?:\/\//i.test(uri)) o.onOpenUrl(uri);
  }

  // ---------- Size ----------

  function hostPadding(): { x: number; y: number } {
    const cs = getComputedStyle(o.host);
    const px = (v: string) => parseFloat(v) || 0;
    return { x: px(cs.paddingLeft) + px(cs.paddingRight), y: px(cs.paddingTop) + px(cs.paddingBottom) };
  }

  /** Fits the xterm to the host; xterm's resize event then tells the backend (once the size settles). */
  function fitView(v: View): void {
    if (!visible || v.el.hidden || !v.el.isConnected) return;
    // A pane that is collapsing or not laid out yet would propose a 2-column terminal.
    if (o.host.clientWidth < 80 || o.host.clientHeight < 40) return;
    let size: Size | undefined;
    try {
      size = v.fit.proposeDimensions();
    } catch {
      return;
    }
    if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows) || size.cols < 2 || size.rows < 1) return;
    lastSize = { cols: size.cols, rows: size.rows };
    if (size.cols !== v.term.cols || size.rows !== v.term.rows) v.fit.fit();
    else if (!v.sent) scheduleResize(v);
  }

  /** Hidden xterms cannot be measured, but every view has the host's size: give them the active one's. */
  function sizeTo(v: View, size: Size): void {
    if (v.term.cols !== size.cols || v.term.rows !== size.rows) v.term.resize(size.cols, size.rows);
    else if (!v.sent) scheduleResize(v);
  }

  function queueFit(): void {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      const v = activeView();
      if (v) fitView(v);
      if (!lastSize) return;
      for (const other of views.values()) if (other !== v) sizeTo(other, lastSize);
    });
  }

  /** Debounced, also the first time: a tab this pane is opening learns its creation size from create() meanwhile. */
  function scheduleResize(v: View): void {
    window.clearTimeout(v.resizeTimer);
    v.resizeTimer = window.setTimeout(() => sendResize(v), RESIZE_DELAY);
  }

  function sendResize(v: View): void {
    window.clearTimeout(v.resizeTimer);
    const a = api;
    if (!a || views.get(v.id) !== v || infos.get(v.id)?.exitCode !== undefined) return;
    const cols = v.term.cols;
    const rows = v.term.rows;
    if (v.sent && v.sent.cols === cols && v.sent.rows === rows) return;
    v.sent = { cols, rows };
    a.resize(v.id, cols, rows);
  }

  /** The size a new tab should start with: what the active terminal fits, else an estimate from the host. */
  function newTabSize(): Size {
    const v = activeView();
    if (v && visible && !v.el.hidden) {
      try {
        const d = v.fit.proposeDimensions();
        if (d && Number.isFinite(d.cols) && Number.isFinite(d.rows) && d.cols >= 2 && d.rows >= 1) return { cols: d.cols, rows: d.rows };
      } catch {
        /* fall through */
      }
    }
    if (lastSize) return lastSize;
    const cell = measureCell();
    const pad = hostPadding();
    const width = o.host.clientWidth - pad.x - SCROLLBAR_WIDTH;
    const height = o.host.clientHeight - pad.y;
    if (cell && width > 0 && height > 0) return { cols: Math.max(20, Math.floor(width / cell.width)), rows: Math.max(5, Math.floor(height / cell.height)) };
    return { cols: 80, rows: 24 };
  }

  // ---------- Opening and closing tabs ----------

  async function createTab(opts: { focus: boolean; index?: number }): Promise<string | null> {
    const a = api;
    if (!a || !xtermLib()) {
      render();
      return null;
    }
    const gen = generation;
    creating++;
    const ticket = opts.focus ? requestFocus(true) : null;
    if (failure?.retry === 'create') failure = null;
    render();
    // Measured after render(): the host is hidden while the empty state shows.
    const size = newTabSize();
    let info: TerminalTabInfo | undefined;
    let error: unknown = null;
    try {
      info = await a.create(size.cols, size.rows);
    } catch (err) {
      error = err;
    }
    if (gen !== generation) return null;
    creating--;
    if (error !== null || !info || typeof info.id !== 'string') {
      const message = `Couldn't start a shell: ${error !== null ? o.cleanError(error) : 'the app returned no tab'}`;
      if (ticket && focusWanted === ticket) focusWanted = null;
      if (order.length) o.onError(o.newButton, message);
      else failure = { message, retry: 'create' };
      render();
      return null;
    }
    if (!infos.has(info.id)) {
      // The tabs event has not arrived yet: show the tab now; the event confirms it.
      infos.set(info.id, { ...info });
      order.push(info.id);
      seeded = true;
    }
    const v = views.get(info.id);
    if (v) v.sent ??= size;
    else createdSizes.set(info.id, size);
    if (opts.index !== undefined) moveTab(info.id, opts.index);
    activate(info.id, false);
    render();
    reportBusy();
    // Its own request, or (auto-open) a focus() that came before any tab existed.
    fulfilFocus(ticket);
    return info.id;
  }

  function moveTab(id: string, index: number): void {
    const from = order.indexOf(id);
    if (from < 0) return;
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(index, order.length)), 0, id);
  }

  async function closeTab(id: string, anchor: HTMLElement | null): Promise<void> {
    const a = api;
    if (!a || !infos.has(id)) return;
    const hadFocus = o.root.contains(document.activeElement);
    // Keyboard users closing from the strip stay in the strip; otherwise the next terminal gets the cursor.
    const onStripTab = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('term-tab');
    try {
      await a.close(id);
    } catch (err) {
      o.onError(anchor?.isConnected ? anchor : o.newButton, `Couldn't close the terminal: ${o.cleanError(err)}`);
      return;
    }
    if (a !== api) return;
    // Normally the tabs event already removed it.
    if (infos.has(id)) applyTabs(order.filter((x) => x !== id).map((x) => infos.get(x)!));
    const now = document.activeElement;
    if (hadFocus && (!now || now === document.body || o.root.contains(now))) {
      const tab = active ? tabEls.get(active) : undefined;
      if (onStripTab && tab) tab.focus();
      else if (!focusActive()) o.newButton.focus();
    }
  }

  /** Enter in an exited terminal: a fresh shell takes its place in the strip. */
  async function replaceExited(v: View): Promise<void> {
    if (v.replacing) return;
    v.replacing = true;
    const at = order.indexOf(v.id);
    const id = await createTab({ focus: true, index: at < 0 ? undefined : at });
    if (!id) {
      v.replacing = false;
      return;
    }
    await closeTab(v.id, null);
  }

  function maybeAutoOpen(): void {
    if (!visible || !loaded) return;
    if (autoOpenHeld) {
      autoOpenHeld = false;
      return;
    }
    if (!api || !xtermLib() || failure || creating > 0 || order.length) return;
    void createTab({ focus: false });
  }

  // ---------- Focus ----------

  function hasFocus(): boolean {
    const el = document.activeElement;
    return el instanceof HTMLTextAreaElement && el.classList.contains('xterm-helper-textarea') && o.host.contains(el);
  }

  function focusActive(): boolean {
    const v = activeView();
    if (!v || !visible || v.el.hidden) return false;
    v.term.focus();
    return true;
  }

  /** Focus goes to the terminal once it exists, unless the user puts it somewhere else first. */
  function requestFocus(forNew: boolean): FocusTicket {
    focusWanted = { from: document.activeElement, until: Date.now() + 4000, forNew };
    return focusWanted;
  }

  /** `ticket`: the createTab call whose tab is now active; null: a view appeared (serves focus() requests only). */
  function fulfilFocus(ticket: FocusTicket | null): void {
    const want = focusWanted;
    if (!want || (ticket ? want !== ticket : want.forNew)) return;
    focusWanted = null;
    if (Date.now() > want.until) return;
    const now = document.activeElement;
    if (now !== want.from && now !== document.body && !o.root.contains(now)) return;
    focusActive();
  }

  // ---------- Strip ----------

  function tabElement(id: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'term-tab';
    el.id = `term-tab-${domId(id)}`;
    el.dataset.id = id;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-controls', `term-view-${domId(id)}`);
    el.innerHTML =
      `<span class="term-tab-agent" aria-hidden="true" hidden>${icon('sparkles', 12)}</span><span class="busy-dot" aria-hidden="true" hidden></span><span class="term-tab-title"></span>` +
      `<button type="button" class="term-tab-close" tabindex="-1" aria-label="Close terminal" data-tip="Close terminal">${icon('x', 14)}</button>`;
    return el;
  }

  function updateTab(el: HTMLElement, info: TerminalTabInfo, isActive: boolean): void {
    const exited = info.exitCode !== undefined;
    const busy = Boolean(info.running) && !exited;
    const title = info.title || info.shell || 'shell';
    el.classList.toggle('active', isActive);
    el.classList.toggle('exited', exited);
    el.setAttribute('aria-selected', String(isActive));
    el.tabIndex = isActive ? 0 : -1;
    const titleEl = el.querySelector<HTMLElement>('.term-tab-title')!;
    if (titleEl.textContent !== title) titleEl.textContent = title;
    el.querySelector<HTMLElement>('.busy-dot')!.hidden = !busy;
    el.querySelector<HTMLElement>('.term-tab-agent')!.hidden = !info.agent;
    const state = exited ? `exited with code ${info.exitCode}` : busy ? `running ${info.running}` : 'idle';
    el.setAttribute('aria-label', `${title}, ${state}`);
    el.dataset.tip = [busy ? info.running : title, tilde(info.cwd), exited ? `exited (${info.exitCode})` : '', info.agent ? 'opened by Silo Harness' : '']
      .filter(Boolean)
      .join(' · ');
    el.querySelector('.term-tab-close')!.setAttribute('aria-label', `Close ${title}`);
  }

  function renderStrip(): void {
    for (const [id, el] of tabEls) {
      if (infos.has(id)) continue;
      el.remove();
      tabEls.delete(id);
    }
    order.forEach((id, i) => {
      const info = infos.get(id);
      if (!info) return;
      let el = tabEls.get(id);
      if (!el) {
        el = tabElement(id);
        tabEls.set(id, el);
      }
      updateTab(el, info, id === active);
      const at = o.strip.children.item(i);
      if (at !== el) o.strip.insertBefore(el, at);
    });
  }

  function showActive(): void {
    for (const v of views.values()) {
      const show = v.id === active;
      if (v.el.hidden === show) v.el.hidden = !show;
    }
    const v = activeView();
    if (v) fitView(v);
  }

  // ---------- Empty, unavailable and error states ----------

  function render(): void {
    const unavailable = !api
      ? 'Restart Silo Harness to turn on the terminal.'
      : !xtermLib()
        ? "Couldn't load xterm.js. Run npm run build, then restart."
        : null;
    const failed = !unavailable && failure && !order.length ? failure : null;
    const none = !unavailable && !failed && loaded && !order.length && creating === 0;
    const empty = Boolean(unavailable || failed || none);
    o.root.classList.toggle('is-unavailable', Boolean(unavailable));
    o.root.classList.toggle('is-empty', empty);
    o.empty.hidden = !empty;
    o.host.hidden = empty;
    o.newButton.disabled = Boolean(unavailable);
    const key = unavailable ? `unavailable:${unavailable}` : failed ? `failed:${failed.message}` : none ? 'none' : '';
    if (key === emptyKey) return;
    emptyKey = key;
    if (unavailable) {
      o.empty.innerHTML = `<span class="term-empty-icon">${icon('terminal', 20)}</span><p>${escapeHtml(unavailable)}</p>`;
    } else if (failed) {
      o.empty.innerHTML =
        `<span class="term-empty-icon">${icon('circle-alert', 20)}</span><p>${escapeHtml(failed.message)}</p>` +
        `<button type="button" class="btn sm" data-action="retry">${icon('refresh', 14)}<span>Retry</span></button>`;
    } else if (none) {
      o.empty.innerHTML =
        `<span class="term-empty-icon">${icon('terminal', 20)}</span><p>No terminals open</p>` +
        `<button type="button" class="btn sm" data-action="new">${icon('plus', 14)}<span>New terminal</span><kbd>⌘</kbd><kbd>T</kbd></button>`;
    } else o.empty.innerHTML = '';
  }

  function busyCount(): number {
    let n = 0;
    for (const t of infos.values()) if (t.running && t.exitCode === undefined) n++;
    return n;
  }

  function reportBusy(): void {
    const n = busyCount();
    if (n === lastBusy) return;
    lastBusy = n;
    o.onBusy(n);
  }

  // ---------- Theme ----------

  function applyTheme(): void {
    const next = readTheme();
    const key = JSON.stringify(next);
    if (key === themeKey) return;
    theme = next;
    themeKey = key;
    for (const v of views.values()) v.term.options.theme = theme;
  }

  // The app sets data-theme from Settings ("", "light", "dark"); "" follows the system.
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  // ---------- Events ----------

  new ResizeObserver(queueFit).observe(o.host);

  o.newButton.addEventListener('click', () => void createTab({ focus: true }));

  o.empty.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'new') void createTab({ focus: true });
    else if (action === 'retry') {
      if (failure?.retry === 'load') void load().then(() => (visible ? focusActive() : undefined));
      else void createTab({ focus: true });
    }
  });

  // Clicks in the padding around the terminal focus it too.
  o.host.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.xterm')) return;
    e.preventDefault();
    focusActive();
  });

  o.strip.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const tab = target.closest<HTMLElement>('.term-tab');
    const id = tab?.dataset.id;
    if (!tab || !id) return;
    if (target.closest('.term-tab-close')) void closeTab(id, tab);
    else activate(id, true);
  });
  // Middle-click closes a tab (and must not start autoscroll).
  o.strip.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  o.strip.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.term-tab');
    if (!tab?.dataset.id) return;
    e.preventDefault();
    void closeTab(tab.dataset.id, tab);
  });
  o.strip.addEventListener('keydown', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.term-tab');
    const id = tab?.dataset.id;
    if (!tab || !id || e.metaKey || e.ctrlKey || e.altKey) return;
    const at = order.indexOf(id);
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % order.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + order.length) % order.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = order.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(id, true);
      return;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      void closeTab(id, tab);
      return;
    }
    if (next < 0 || at < 0) return;
    e.preventDefault();
    const nextId = order[next];
    activate(nextId, false);
    tabEls.get(nextId)?.focus();
  });
  // A vertical wheel scrolls an overflowing strip sideways.
  o.strip.addEventListener(
    'wheel',
    (e) => {
      if (o.strip.scrollWidth <= o.strip.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      o.strip.scrollLeft += e.deltaY;
    },
    { passive: false },
  );

  connect();

  return {
    setVisible(v: boolean) {
      if (v === visible) return;
      visible = v;
      if (!v) {
        focusWanted = null;
        autoOpenHeld = false;
        return;
      }
      ensureViews();
      showActive();
      render();
      // Deferred so that ⌘T (show the pane, then open a tab) does not open two.
      queueMicrotask(maybeAutoOpen);
    },
    newTab() {
      return createTab({ focus: true });
    },
    focus() {
      if (!focusActive()) requestFocus(false);
    },
    hasFocus,
    select(id: string) {
      if (!infos.has(id) || id === active || hasFocus()) return;
      activate(id, false);
    },
    holdAutoOpen() {
      if (!visible) autoOpenHeld = true;
    },
    clearActive() {
      activeView()?.term.clear();
    },
    closeActive() {
      if (active) void closeTab(active, tabEls.get(active) ?? null);
    },
    input(text: string, id?: string) {
      const v = views.get(id ?? active ?? '');
      if (v && typeof text === 'string') v.term.input(text);
    },
    screenText(id?: string) {
      const v = views.get(id ?? active ?? '');
      if (!v) return '';
      const buf = v.term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        // keep trailing spaces of a row that wraps onto the next one
        const text = line.translateToString(!buf.getLine(y + 1)?.isWrapped);
        if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
        else lines.push(text);
      }
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return lines.join('\n');
    },
    tabs: () => order.map((id) => ({ ...infos.get(id)! })),
    activeId: () => active,
    busyCount,
    setTheme: applyTheme,
    reset() {
      connect();
      if (visible) queueMicrotask(maybeAutoOpen);
    },
  };
}

// ---------- In-memory shell for the debug hook ----------

export type MockTerminalSource = TerminalApi & {
  /** Opens a tab the way terminal_run does without tab_id (agent: true) and types the command; returns the tab id */
  runAsAgent(command: string): string;
  dispose(): void;
};

/**
 * A fake TerminalApi for screenshots and tests without a pty: a zsh-like prompt that echoes what is typed and runs
 * echo, pwd, cd, ls, clear, colors (the palette), sleep N (a running command; Ctrl-C stops it), true, false and
 * exit [code]. Events reach listeners on later tasks and in order, like IPC messages.
 */
export function mockTerminalSource(cwd = '/Users/you/project'): MockTerminalSource {
  interface Fake {
    info: TerminalTabInfo;
    out: string;
    line: string;
    timer: number | undefined;
  }
  const tabs = new Map<string, Fake>();
  const dataListeners = new Set<(id: string, data: string) => void>();
  const tabListeners = new Set<(tabs: TerminalTabInfo[]) => void>();
  const timers = new Set<number>();
  let seq = 0;
  let disposed = false;

  const later = (fn: () => void, ms = 0): number => {
    const t = window.setTimeout(() => {
      timers.delete(t);
      if (!disposed) fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const snapshot = (): TerminalTabInfo[] => [...tabs.values()].map((t) => ({ ...t.info }));
  const emitTabs = (): void => {
    const list = snapshot();
    later(() => tabListeners.forEach((cb) => cb(list)));
  };
  const print = (t: Fake, s: string): void => {
    t.out = (t.out + s).slice(-256 * 1024);
    const id = t.info.id;
    later(() => dataListeners.forEach((cb) => cb(id, s)));
  };
  const folder = (p: string): string => (p === '/' ? '/' : p.replace(/\/+$/, '').split('/').pop() || '/');
  const prompt = (t: Fake): void => print(t, `\x1b[36m${folder(t.info.cwd)}\x1b[0m % `);
  const setRunning = (t: Fake, command: string | undefined): void => {
    t.info.running = command;
    t.info.title = command ? (command.trim().split(/\s+/)[0] ?? t.info.shell) : t.info.shell;
    emitTabs();
  };
  const exit = (t: Fake, code: number): void => {
    window.clearTimeout(t.timer);
    t.info.exitCode = code;
    t.info.running = undefined;
    t.info.title = t.info.shell;
    emitTabs();
  };

  /** Shell words: whitespace-separated, with '…' and "…" quoting and backslash escapes. */
  function words(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quote = '';
    let any = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = '';
        else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
        else cur += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        any = true;
      } else if (ch === '\\' && i + 1 < line.length) {
        cur += line[++i];
        any = true;
      } else if (/\s/.test(ch)) {
        if (cur || any) out.push(cur);
        cur = '';
        any = false;
      } else cur += ch;
    }
    if (cur || any) out.push(cur);
    return out;
  }

  function colorTable(): string {
    const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
    const row = (base: number) => names.map((n, i) => `\x1b[${base + i}m${n.padEnd(8)}\x1b[0m`).join('');
    const blocks = names.map((_, i) => `\x1b[${40 + i}m  \x1b[0m`).join('') + ' ' + names.map((_, i) => `\x1b[${100 + i}m  \x1b[0m`).join('');
    return (
      `${row(30)}\r\n${row(90)}\r\n${blocks}\r\n` +
      `\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m \x1b[7minverse\x1b[0m \x1b[30;42m PASS \x1b[0m \x1b[37;41m FAIL \x1b[0m\r\n`
    );
  }

  function run(t: Fake, line: string): void {
    const argv = words(line);
    const cmd = argv[0] ?? '';
    const args = argv.slice(1);
    switch (cmd) {
      case '':
      case 'true':
      case 'false':
        break;
      case 'echo':
        print(t, `${args.join(' ')}\r\n`);
        break;
      case 'pwd':
        print(t, `${t.info.cwd}\r\n`);
        break;
      case 'cd': {
        const to = args[0] ?? '~';
        let next = to === '~' ? cwd : to.startsWith('/') ? to : `${t.info.cwd.replace(/\/+$/, '')}/${to}`;
        const parts: string[] = [];
        for (const p of next.split('/')) {
          if (!p || p === '.') continue;
          if (p === '..') parts.pop();
          else parts.push(p);
        }
        next = `/${parts.join('/')}`;
        t.info.cwd = next;
        emitTabs();
        break;
      }
      case 'ls':
        print(t, `\x1b[1;34mnode_modules\x1b[0m  package.json  README.md  \x1b[1;34msrc\x1b[0m\r\n`);
        break;
      case 'clear':
        print(t, '\x1b[H\x1b[2J\x1b[3J');
        break;
      case 'colors':
        print(t, colorTable());
        break;
      case 'exit':
        exit(t, Number(args[0]) || 0);
        return;
      case 'sleep': {
        const secs = Math.min(60, Math.max(0, Number(args[0]) || 1));
        setRunning(t, line.trim());
        t.timer = later(() => {
          setRunning(t, undefined);
          prompt(t);
        }, secs * 1000);
        return;
      }
      default:
        print(t, `zsh: command not found: ${cmd}\r\n`);
    }
    prompt(t);
  }

  /** Index of the last character of the escape sequence that starts at `i`. */
  function escapeEnd(s: string, i: number): number {
    if (s[i + 1] === '[') {
      let j = i + 2;
      while (j < s.length && !/[@-~]/.test(s[j])) j++;
      return j;
    }
    return Math.min(s.length - 1, i + (s[i + 1] === 'O' ? 2 : 1));
  }

  function input(t: Fake, data: string): void {
    for (let i = 0; i < data.length; i++) {
      if (t.info.exitCode !== undefined) return;
      const ch = data[i];
      if (ch === '\x1b') {
        i = escapeEnd(data, i);
        continue;
      }
      if (t.info.running) {
        if (ch === '\x03') {
          window.clearTimeout(t.timer);
          print(t, '^C\r\n');
          setRunning(t, undefined);
          prompt(t);
        }
        continue;
      }
      if (ch === '\r') {
        print(t, '\r\n');
        const line = t.line;
        t.line = '';
        run(t, line);
      } else if (ch === '\x7f' || ch === '\b') {
        if (!t.line) continue;
        t.line = t.line.slice(0, -1);
        print(t, '\b \b');
      } else if (ch === '\x03') {
        t.line = '';
        print(t, '^C\r\n');
        prompt(t);
      } else if (ch === '\x04') {
        if (!t.line) exit(t, 0);
      } else if (ch === '\x0c') {
        print(t, '\x1b[H\x1b[2J');
        prompt(t);
        print(t, t.line);
      } else if (ch === '\x15') {
        print(t, '\b \b'.repeat(t.line.length));
        t.line = '';
      } else if (ch >= ' ') {
        t.line += ch;
        print(t, ch);
      }
    }
  }

  function open(agent: boolean, command?: string): Fake {
    const id = `tab-${++seq}`;
    const t: Fake = { info: { id, title: 'zsh', cwd, shell: 'zsh', pid: 40000 + seq, agent, createdAt: Date.now() }, out: '', line: '', timer: undefined };
    tabs.set(id, t);
    emitTabs();
    later(() => {
      if (tabs.get(id) !== t) return;
      prompt(t);
      if (command) input(t, `${command}\r`);
    }, 40);
    return t;
  }

  return {
    list: () =>
      new Promise((resolve) => {
        const list = snapshot();
        later(() => resolve(list));
      }),
    create: () =>
      new Promise((resolve) => {
        const info = { ...open(false).info };
        later(() => resolve(info));
      }),
    runAsAgent: (command: string) => open(true, command).info.id,
    history: (id: string) =>
      new Promise((resolve) => {
        const out = tabs.get(id)?.out ?? '';
        later(() => resolve(out));
      }),
    write: (id: string, data: string) => {
      const t = tabs.get(id);
      if (t) input(t, String(data));
    },
    resize: () => undefined,
    close: (id: string) =>
      new Promise((resolve) => {
        const t = tabs.get(id);
        if (t) {
          window.clearTimeout(t.timer);
          tabs.delete(id);
          emitTabs();
        }
        later(() => resolve());
      }),
    onData: (cb) => {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    onTabs: (cb) => {
      tabListeners.add(cb);
      return () => {
        tabListeners.delete(cb);
      };
    },
    dispose: () => {
      disposed = true;
      for (const t of timers) window.clearTimeout(t);
      timers.clear();
      dataListeners.clear();
      tabListeners.clear();
    },
  };
}
