import type {
  AgentEvent,
  AppConfig,
  ArtifactInfo,
  BrowserState,
  ChangeDiff,
  ChangeEntry,
  ChangesApi,
  CommandInfo,
  CommandResult,
  CompactionInfo,
  ContextInfo,
  FileHit,
  ImageAttachment,
  LiveState,
  McpApi,
  McpServerInfo,
  MessageOrigin,
  ModelCapabilities,
  SiloHarnessApi,
  PermissionMode,
  PlanInfo,
  ProjectRules,
  QuestionAnswer,
  QueuedMessage,
  RewindResult,
  RulesApi,
  SendResult,
  SessionMeta,
  SessionStatus,
  SkillInfo,
  TaskItem,
  TerminalApi,
  TerminalTabInfo,
  TranscriptItem,
} from '../shared/types';
import { brandMark, hydrateIcons, icon, isIconName, type IconName } from './icons.js';
import { basename, copyWithFeedback, escapeHtml, formatCount, isTextField, writeClipboard } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { lineDiff, numberRows, parseEditPreview, renderDiff, setDiffBaseDir, statHtml } from './diff.js';
import { highlight } from './highlight.js';
import { approvalTitle, asArgs, createToolCard, displayPath, editStartLine, fileLines, forgetFile, linkPath, mcpParts, resetFileCache, setToolCwd, statusVerb, type ToolCard } from './tools.js';
import { closeMenu, initTooltips, isMenuOpen, menuAnchoredTo, openMenu, type MenuItem, type MenuSection } from './popover.js';
import { createQuestionCard } from './questions.js';
import { MODE_CHIP_CLASSES, MODE_CYCLE, MODES, modeOf, nextMode } from './modes.js';
import { createPlanCard, type PlanCard, type PlanDecision } from './plan.js';
import { createChangesPane, mockChangesSource, type ConfirmOptions } from './changes.js';
import { createTerminalPane, mockTerminalSource, type MockTerminalSource } from './terminal.js';
import { attachmentLabel, createAttachmentTray, dataUrlToBlob, imageType, type AddResult, type ImageInput } from './attachments.js';
import { createArtifactCard, type ArtifactAction, type ArtifactCard } from './artifacts.js';
import { createQueueList } from './queue.js';
import { createCompactionDivider, createContextMeter, normalizeContext } from './context.js';
import { createMcpPanel, mcpCardHtml, mockMcpSource, type MockMcpSource } from './mcp.js';
import { appendWithMentions, createMentionPicker, normalizeMention } from './mentions.js';
import { createRulesPanel, mockRulesSource } from './rules.js';
import { cleanTasks, createTaskList } from './tasks.js';
import { createSidebar, type SidebarView } from './sidebar.js';
import { createComposerHistory, createDoublePress, createInstructionFiles, memoryText, oneLine } from './composer.js';
import { createRecentRow, dirName, recentChoices } from './recent.js';
import {
  cleanChecks,
  createSetupStrip,
  hasModel,
  isHomeFolder,
  isLocalOllama,
  ollamaAddress,
  ollamaServeCommand,
  pullCommand,
  type SetupChecks,
  type SetupId,
  type SetupLine,
} from './setup.js';
import type { SettingsInfo } from '../shared/settings-info';
import type { Schedule } from '../shared/schedules';
import { bus } from './bus.js';
import { onPush, rpc } from './rpc.js';
import { setTranscriptSink, transcriptItemRenderer, type ExtraTranscriptItem } from './transcript-items.js';
import { PROPOSAL_TOOLS, proposalEnded, setupDreamingView } from './dreaming.js';
import { createModsHost, type ModPaneTabs } from './mods-host.js';
import { createSettingsPage } from './settings-page.js';
import { createPages, navOf, type PageRoute, type PagesView } from './pages.js';
import { createScheduledPage } from './scheduled-page.js';
import { createDreamingPage } from './dreaming-page.js';
import { agentApproval, setNameLookup } from './tool-labels.js';
import { unframe } from './origin.js';
import { activityWords } from './tool-activity.js';
import { tilde } from './home.js';
import { activeProvider, allProviders, usesOllama } from './provider-view.js';

declare global {
  interface Window {
    oc: SiloHarnessApi;
    __oc_debug?: {
      /**
       * A user bubble, optionally with images (data: URLs), the mentioned paths a reloaded transcript would carry and
       * the checkpoint index (turn) that gives it a Rewind action (clicking it really rewinds the current session)
       */
      user(text: string, images?: string[], mentions?: string[], turn?: number): void;
      /** Shows the task list card with these tasks (an empty list or null hides it); nothing reaches the main process */
      tasks(tasks: TaskItem[] | null): void;
      renderMarkdown(md: string): void;
      emit(ev: AgentEvent): void;
      /** Feeds the Diff pane from memory instead of oc.changes (pass null to go back to the real tracker) */
      mockChanges(list: ChangeEntry[] | null, diffs?: Record<string, Partial<ChangeDiff>>): void;
      terminal: {
        /** A terminal tab's text (scrollback and screen, wrapped rows joined); the active tab by default */
        screen(id?: string): string;
        /** The terminal tabs in strip order */
        tabs(): TerminalTabInfo[];
        /** true: an in-memory fake shell instead of oc.terminal (echo, pwd, cd, ls, clear, colors, sleep N, exit); false: the real one again */
        mock(on: boolean): void;
        /** Types into a tab as the user would (the active tab by default), e.g. "echo hi\r" */
        input(text: string, id?: string): void;
      };
      /** Adds an image to the composer through the same pipeline as paste, drop and the picker */
      attach(dataUrl: string, name?: string): Promise<ImageAttachment>;
      /** The composer's attachments, in order */
      attachments(): ImageAttachment[];
      /** Messages waiting in the queue, oldest first */
      queue(): QueuedMessage[];
      mcp: {
        /** Settings → MCP servers (and /mcp) show these servers from memory instead of oc.mcp; actions change only that copy. null goes back to oc.mcp */
        mock(servers: McpServerInfo[] | null): void;
      };
      /** Sets the context meter directly (null hides it) */
      context(info: ContextInfo | null): void;
      files: {
        /** The @ picker shows these hits (whatever the query, up to its limit) instead of asking oc.files.search; null goes back to it */
        mock(hits: FileHit[] | null): void;
      };
      rules: {
        /** Settings → Permissions shows these rules from memory instead of oc.rules; removing one changes only that copy. null goes back to oc.rules */
        mock(rules: ProjectRules | null): void;
      };
      /**
       * Renders the welcome screen's setup strip from these checks (true = fine; a key left out counts as fine)
       * instead of the real ones, which stop re-checking meanwhile; null goes back to the real checks
       */
      setup(checks: Partial<SetupChecks> | null): void;
      /**
       * Renders the welcome screen's Recent projects row from these folders instead of config.recentDirs (the current
       * working directory is still left out; clicking a chip really switches to it); null goes back to config.recentDirs
       */
      recent(dirs: string[] | null): void;
    };
  }
}

const oc = window.oc;
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

hydrateIcons();

const shell = document.querySelector<HTMLElement>('.shell')!;
const contentEl = document.querySelector<HTMLElement>('.content')!;
const transcriptWrap = document.querySelector<HTMLElement>('.transcript-wrap')!;
const messagesEl = $('messages');
const emptyState = $('empty-state');
const inputEl = $<HTMLTextAreaElement>('input');
const sendBtn = $<HTMLButtonElement>('send-btn');
const stopBtn = $<HTMLButtonElement>('stop-btn');
const statusLine = $('status-line');
const statusText = $('status-text');
const statusTime = $('status-time');
const statusTokens = $('status-tokens');
const modeBtn = $<HTMLButtonElement>('mode-btn');
const modelBtn = $<HTMLButtonElement>('model-btn');
const cwdBtn = $<HTMLButtonElement>('cwd-btn');
const cwdLabel = $('cwd-label');
const sessionTitle = $('session-title');
const newSessionBtn = $<HTMLButtonElement>('new-session-btn');
const slashMenu = $('slash-menu');
const mentionMenu = $('mention-menu');
const settingsDialog = $<HTMLDialogElement>('settings');
const shortcutsDialog = $<HTMLDialogElement>('shortcuts');
const sidePane = $('side-pane');
const browserPane = $('browser-pane');
const diffPane = $('diff-pane');
const paneTabBrowser = $<HTMLButtonElement>('pane-tab-browser');
const paneTabDiff = $<HTMLButtonElement>('pane-tab-diff');
const diffToggle = $<HTMLButtonElement>('diff-toggle');
const diffCountBadges = [$('diff-count'), $('pane-diff-count')];
const terminalPaneEl = $('terminal-pane');
const paneTabTerminal = $<HTMLButtonElement>('pane-tab-terminal');
const terminalToggle = $<HTMLButtonElement>('terminal-toggle');
const terminalBusyDots = [$('terminal-busy'), $('pane-terminal-busy')];
const browsingPill = $('browsing-pill');
const confirmDialog = $<HTMLDialogElement>('confirm-dialog');
const statusHint = $('status-hint');
const browserView = $('browser-view');
const urlEl = $<HTMLInputElement>('url');
const backBtn = $<HTMLButtonElement>('back-btn');
const fwdBtn = $<HTMLButtonElement>('fwd-btn');
const reloadBtn = $<HTMLButtonElement>('reload-btn');
const openExternalBtn = $<HTMLButtonElement>('open-external-btn');
const browserTitle = $('browser-title');
const browserToggle = $<HTMLButtonElement>('browser-toggle');
const resizer = $('pane-resizer');
const placeholder = browserView.querySelector<HTMLElement>('.browser-placeholder');
const attachBtn = $<HTMLButtonElement>('attach-btn');
const attachInput = $<HTMLInputElement>('attach-input');
const attachNote = $('attach-note');
const queueEl = $('queue');
const taskListEl = $('task-list');
const lightbox = $<HTMLDialogElement>('lightbox');
const lightboxImg = $<HTMLImageElement>('lightbox-img');
const lightboxCaption = $('lightbox-caption');
const contextMeterBtn = $<HTMLButtonElement>('context-meter');
const setupEl = $('setup-strip');
const statusFlash = $('status-flash');

$('empty-mark').innerHTML = brandMark(40);

let config: AppConfig;
let running = false;
let runStartedAt = 0;
let timer: number | undefined;
/** The session on screen. Other sessions may be running too: their events only update `statuses`. */
let currentSessionId = '';
let sessions: SessionMeta[] = [];
/** Per session: running, waiting for the user, unread (from the session list, kept current by every session's events) */
const statuses = new Map<string, SessionStatus>();
const toolCards = new Map<string, ToolCard>();
let lastToolCard: ToolCard | null = null;
let pendingApproval: {
  id: string;
  el: HTMLElement;
  name: string;
  cancel: (reason: string) => void;
  allow: () => void;
  resolved: (ok: boolean, scope: 'once' | 'session' | 'project') => void;
  dispose: () => void;
} | null = null;
/** The ask_user card waiting for an answer, if any */
let pendingQuestion: { id: string; el: HTMLElement; cancel: () => void; dispose: () => void } | null = null;
let stick = true;
let runOutputTokens = 0;
/** From a confirmed Rewind until the transcript is back: sending and other rewinds wait */
let rewinding = false;
/** Bumped by every tasks_updated event (and the debug hook), so a session read that started earlier cannot overwrite the list */
let tasksEpoch = 0;
/** Bumped by every turn sync and every re-render, so a transcript read that started earlier is dropped */
let turnSync = 0;
/** Paths picked from the @ menu in this window: their tokens become chips in the bubbles sent from here (even @Makefile) */
const pickedPaths = new Set<string>();
/** When "Start Ollama" ran `ollama serve` (ms), until Ollama answers or the wait runs out; 0 otherwise */
let ollamaStartedAt = 0;

const tray = createAttachmentTray({
  root: $('attachments'),
  onChange: () => {
    updateSendButton();
    if (statusState === 'plan-wait') statusHint.hidden = composerHasContent();
    void refreshVisionNote();
  },
  onPreview: (a) => openLightbox(a.dataUrl, a.name, attachmentLabel(a)),
  onFocusComposer: () => inputEl.focus(),
});

const queueList = createQueueList({
  root: queueEl,
  unqueue: async (msg, button) => {
    try {
      if (typeof oc.unqueue !== 'function') throw new Error('No handler registered');
      if (await oc.unqueue(msg.id)) return true;
      showInlineError(button, 'Already handed to the agent, so it can no longer be removed.');
    } catch (err) {
      showInlineError(button, `Couldn't remove the message: ${cleanError(err)}`);
    }
    return false;
  },
  onChange: () => syncQueueHeight(),
});

/** The agent's task list, a card that is always last in the conversation (tasks_updated, SessionMeta.tasks) */
const taskList = createTaskList({ root: taskListEl, home: messagesEl, after: emptyState, onChange: () => scrollToBottom() });

/** A task list from an event or the debug hook. */
function showTasks(tasks: unknown): void {
  tasksEpoch++;
  taskList.set(cleanTasks(tasks));
}

/** The current session's task list from its meta (on load and after switching), unless an event came in since `epoch`. */
function showSessionTasks(meta: SessionMeta | null | undefined, epoch: number): void {
  if (!meta || meta.id !== currentSessionId || epoch !== tasksEpoch) return;
  taskList.set(cleanTasks(meta.tasks));
}

/** True when the composer has text, images or images still being processed. */
function composerHasContent(): boolean {
  return Boolean(inputEl.value.trim()) || tray.items().length > 0 || tray.pending() > 0;
}

/** Nothing typed and nothing attached (keys like y/n/Enter then go to an approval or plan card). */
function composerEmpty(): boolean {
  return !inputEl.value && tray.items().length === 0 && tray.pending() === 0;
}

// ---------- Errors shown next to the control that failed ----------

function cleanError(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:Error:\s*)+/, '');
  if (/No handler registered/.test(msg)) return 'this needs the updated app. Restart Silo Harness and try again.';
  return msg;
}

let inlineError: HTMLElement | null = null;
let inlineErrorTimer: number | undefined;
function showInlineError(anchor: HTMLElement, message: string): void {
  inlineError?.remove();
  window.clearTimeout(inlineErrorTimer);
  const el = document.createElement('div');
  el.className = 'inline-error';
  el.setAttribute('role', 'alert');
  el.innerHTML = `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>`;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w));
  let top = r.bottom + 6;
  const view = browserViewRect();
  if (top + hgt > window.innerHeight - 8 || (view && left < view.right && left + w > view.left && top < view.bottom && top + hgt > view.top)) top = r.top - 6 - hgt;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, top))}px`;
  inlineError = el;
  inlineErrorTimer = window.setTimeout(() => {
    el.remove();
    if (inlineError === el) inlineError = null;
  }, 5000);
}

function dialogOpen(): boolean {
  return settingsDialog.open || shortcutsDialog.open || confirmDialog.open || lightbox.open;
}

/** A page (Scheduled tasks, Dreaming) is in the main column in place of the session */
function pageOpen(): boolean {
  return shell.classList.contains('page-open');
}

function browserViewRect(): DOMRect | null {
  if (shell.classList.contains('browser-hidden') || dialogOpen() || pageOpen()) return null;
  return browserView.getBoundingClientRect();
}

initTooltips(browserViewRect);

// ---------- Transcript ----------

const jumpBtn = $<HTMLButtonElement>('jump-latest');
function showJump(v: boolean): void {
  jumpBtn.hidden = !v;
}
jumpBtn.onclick = () => scrollToBottom(true);

messagesEl.addEventListener(
  'scroll',
  () => {
    stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 64;
    if (stick) showJump(false);
  },
  { passive: true },
);

/** Follows new content while the user is at the bottom; otherwise offers a "Jump to latest" pill instead of yanking the view. */
function scrollToBottom(force = false): void {
  if (force) stick = true;
  if (stick) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    showJump(false);
  } else if (messagesEl.scrollHeight > messagesEl.clientHeight) showJump(true);
}

function addNode(el: HTMLElement): void {
  emptyState.hidden = true;
  el.classList.add('fade-in');
  messagesEl.appendChild(el);
  if (!foldable(el)) endLiveRun();
  scrollToBottom();
}

/** An image shown in a user bubble: a data: URL, plus what is known about it (live sends know more than a reloaded transcript). */
interface BubbleImage {
  src: string;
  name?: string;
  width?: number;
  height?: number;
  /** Shown under the image in the lightbox */
  caption?: string;
}

function bubbleImage(a: ImageAttachment): BubbleImage {
  return { src: a.dataUrl, name: a.name, width: a.width, height: a.height, caption: attachmentLabel(a) };
}

/** What each user bubble was sent with: Copy copies it, and live bubbles are matched to transcript items by it. */
const userTextByMessage = new WeakMap<HTMLElement, string>();

interface UserMessageOptions {
  /** The message's checkpoint (TranscriptItem.turn): the bubble gets a Rewind action */
  turn?: number;
  /** A command handled here (/compact, /mcp, …) or a message the main process did not take: no transcript item matches it */
  local?: boolean;
  /** Where the message came from when it was not typed here ("from schedule", …), shown above the bubble */
  originLabel?: string;
  /** The text was written by a model (another session's report or message, a merged summary): drawn as Markdown */
  markdown?: boolean;
  /** A long message the app put together (a dream's digest): drawn shut, opened with "Show all" */
  folded?: boolean;
}

const REWIND_BUTTON = `<button type="button" class="icon-btn sm msg-rewind" aria-label="Rewind to this message" data-tip="Rewind">${icon('rotate-ccw', 14)}</button>`;

/** Gives a user bubble its checkpoint and the Rewind action, or takes both away (undefined). */
function setTurn(msg: HTMLElement, turn: number | undefined): void {
  const actions = msg.querySelector<HTMLElement>(':scope > .msg-actions');
  const btn = actions?.querySelector<HTMLElement>('.msg-rewind');
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    delete msg.dataset.turn;
    btn?.remove();
    return;
  }
  msg.dataset.turn = String(turn);
  if (!btn) actions?.insertAdjacentHTML('beforeend', REWIND_BUTTON);
}

function turnOf(msg: HTMLElement): number | null {
  const v = msg.dataset.turn;
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * A user bubble. @path tokens become chips: with `mentions` (a reloaded transcript item) exactly the paths whose
 * contents went to the model, otherwise tokens that look like paths and paths picked from the @ menu. Hovering (or
 * focusing) it shows Copy and, once it has a checkpoint, Rewind.
 */
function addUserMessage(text: string, images: BubbleImage[] = [], mentions?: string[] | null, opts: UserMessageOptions = {}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const shown = images.filter((im) => im && typeof im.src === 'string' && im.src);
  if (shown.length) {
    bubble.classList.add('has-images');
    if (!text) bubble.classList.add('images-only');
    const grid = document.createElement('div');
    grid.className = `bubble-images${shown.length > 1 ? ' multi' : ''}`;
    shown.forEach((im, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bubble-image';
      b.setAttribute('aria-label', `Open ${im.name || `image ${i + 1}`}`);
      const img = document.createElement('img');
      img.alt = im.name || 'Attached image';
      img.draggable = false;
      if (im.width && im.height) {
        img.width = im.width;
        img.height = im.height;
      }
      img.addEventListener('load', () => scrollToBottom(), { once: true });
      img.src = im.src;
      b.appendChild(img);
      b.onclick = () => openLightbox(im.src, im.name, im.caption);
      grid.appendChild(b);
    });
    bubble.appendChild(grid);
  }
  if (text && opts.markdown) {
    bubble.classList.add('rich');
    bubble.insertAdjacentHTML('beforeend', `<div class="md">${renderMarkdown(text)}</div>`);
    if (opts.folded) {
      bubble.classList.add('folded');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'link-btn bubble-more';
      more.textContent = 'Show all';
      more.onclick = () => {
        const shut = bubble.classList.toggle('folded');
        more.textContent = shut ? 'Show all' : 'Show less';
      };
      bubble.appendChild(more);
    }
  } else if (text) appendWithMentions(bubble, text, { mentions: Array.isArray(mentions) ? mentions : null, known: pickedPaths, cwd: config?.workingDirectory ?? '' });
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  // An images-only message has no text to copy (the row stays empty, and hidden, unless it gets Rewind)
  if (text) actions.innerHTML = `<button type="button" class="icon-btn sm msg-copy" aria-label="Copy message" data-tip="Copy">${icon('copy', 14)}</button>`;
  if (opts.originLabel) {
    const label = document.createElement('div');
    label.className = 'msg-origin';
    el.classList.add('has-origin');
    label.textContent = opts.originLabel;
    el.appendChild(label);
  }
  el.append(bubble, actions);
  userTextByMessage.set(el, text);
  if (opts.local) el.dataset.local = 'true';
  setTurn(el, opts.turn);
  addNode(el);
  scrollToBottom(true);
  return el;
}

function addSystemMessage(text: string, kind: 'info' | 'error' | 'notice' = 'info'): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg system${kind === 'info' ? '' : ` ${kind}`}`;
  // Line breaks kept: /sessions, /merge and a name that fits several sessions answer with one session per line
  el.innerHTML = `${icon(kind === 'error' ? 'circle-alert' : 'info', kind === 'error' ? 16 : 14)}<span>${escapeHtml(text).replace(/\n/g, '<br>')}</span>`;
  addNode(el);
  return el;
}

/** A left-aligned notice card rendered from Markdown (used for /skills). */
function addNoticeCard(markdown: string): void {
  const el = document.createElement('div');
  el.className = 'msg system notice card';
  el.innerHTML = `<div class="md">${renderMarkdown(markdown)}</div>`;
  addNode(el);
}

/** The divider where earlier messages were folded into a summary (live compact_end, or a reloaded transcript). */
function addCompaction(info: CompactionInfo): void {
  if (!info || typeof info !== 'object') return;
  endAssistant();
  finishThinking();
  addNode(createCompactionDivider(info));
}

// Assistant text streams into one message; rendering is batched to one Markdown pass per frame.
const rawByMessage = new WeakMap<HTMLElement, string>();

/** A reply's Markdown source: what its Copy button (and ⌘⇧C for the last reply) copies. */
function assistantText(msg: HTMLElement): string {
  return rawByMessage.get(msg) ?? msg.querySelector('.md')?.textContent ?? '';
}
let currentAssistant: { el: HTMLElement; md: HTMLElement; raw: string } | null = null;
let renderQueued = false;

function ensureAssistant(): { el: HTMLElement; md: HTMLElement; raw: string } {
  if (!currentAssistant) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    const md = document.createElement('div');
    md.className = 'md';
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `<button type="button" class="icon-btn sm msg-copy" aria-label="Copy message" data-tip="Copy">${icon('copy', 14)}</button>`;
    el.append(md, actions);
    currentAssistant = { el, md, raw: '' };
    addNode(el);
  }
  return currentAssistant;
}

/**
 * Streaming text is re-rendered at most every STREAM_RENDER_MS (about ten times a second), not on every animation
 * frame: the whole reply goes through the Markdown renderer each time, and a local model's token rate makes a
 * per-frame render pure CPU and GPU waste the reader cannot see.
 */
const STREAM_RENDER_MS = 90;
let lastAssistantRender = 0;

function flushAssistant(): void {
  renderQueued = false;
  if (!currentAssistant) return;
  lastAssistantRender = performance.now();
  currentAssistant.md.innerHTML = renderMarkdown(currentAssistant.raw);
  scrollToBottom();
}

function appendAssistantText(delta: string): void {
  const a = ensureAssistant();
  a.raw += delta;
  rawByMessage.set(a.el, a.raw);
  if (renderQueued) return;
  renderQueued = true;
  // A long reply costs more per render (every code block is highlighted again), so the interval grows with it.
  const interval = STREAM_RENDER_MS + Math.min(400, a.raw.length / 40);
  const wait = Math.max(0, interval - (performance.now() - lastAssistantRender));
  window.setTimeout(() => requestAnimationFrame(flushAssistant), wait);
}

function endAssistant(): void {
  if (currentAssistant) {
    currentAssistant.md.innerHTML = renderMarkdown(currentAssistant.raw);
    scrollToBottom();
  }
  currentAssistant = null;
}

/** A path in a tool row or an approval card (.path-link): opens it with the system's editor, as the Diff pane does. */
async function openPath(path: string, anchor: HTMLElement): Promise<void> {
  if (!path) return;
  try {
    if (typeof oc.changes?.openInEditor !== 'function') throw new Error('No handler registered');
    await oc.changes.openInEditor(path);
  } catch (err) {
    showInlineError(anchor, `Couldn't open ${basename(path) || path}: ${cleanError(err)}`);
  }
}

messagesEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const pathLink = t.closest<HTMLElement>('.path-link');
  if (pathLink) {
    // In a row's summary the click opens the file, not the row
    e.preventDefault();
    void openPath(pathLink.dataset.path ?? '', pathLink);
    return;
  }
  const codeCopy = t.closest<HTMLElement>('.code-copy');
  if (codeCopy) {
    const code = codeCopy.closest('.code-block')?.querySelector('code');
    if (code) void copyWithFeedback(codeCopy, code.textContent ?? '');
    return;
  }
  const msgCopy = t.closest<HTMLElement>('.msg-copy');
  if (msgCopy) {
    const msg = msgCopy.closest<HTMLElement>('.msg.assistant, .msg.user');
    if (msg?.classList.contains('user')) void copyWithFeedback(msgCopy, userTextByMessage.get(msg) ?? msg.querySelector('.bubble')?.textContent ?? '');
    else if (msg) void copyWithFeedback(msgCopy, assistantText(msg));
    return;
  }
  const rewindBtn = t.closest<HTMLElement>('.msg-rewind');
  if (rewindBtn) {
    const msg = rewindBtn.closest<HTMLElement>('.msg.user');
    if (msg) void rewindTo(msg, rewindBtn);
    return;
  }
  const outCopy = t.closest<HTMLElement>('.out-copy');
  if (outCopy) {
    e.preventDefault();
    const pre = outCopy.parentElement?.querySelector('pre');
    if (pre) void copyWithFeedback(outCopy, pre.textContent ?? '');
    return;
  }
  const image = t.closest<HTMLImageElement>('img.shot[data-lightbox]');
  if (image) openLightbox(image.src, image.alt);
});

// Thinking: "Thinking…" while it streams, then "Thought for 12s".
let currentThinking: { el: HTMLDetailsElement; label: HTMLElement; body: HTMLElement; raw: string; startedAt: number } | null = null;

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function appendThinking(delta: string): void {
  if (!currentThinking) {
    endAssistant();
    const el = document.createElement('details');
    el.className = 'thinking live';
    el.innerHTML =
      `<summary><span class="tool-chevron">${icon('chevron-right')}</span><span class="think-icon">${icon('lightbulb')}</span>` +
      `<span class="think-label">Thinking<span class="ellipsis"><i>.</i><i>.</i><i>.</i></span></span></summary><div class="body"></div>`;
    currentThinking = { el, label: el.querySelector('.think-label')!, body: el.querySelector('.body')!, raw: '', startedAt: Date.now() };
    addNode(el);
  }
  currentThinking.raw += delta;
  thinkPending += delta;
  if (thinkQueued) return;
  thinkQueued = true;
  window.setTimeout(() => requestAnimationFrame(flushThinking), STREAM_RENDER_MS);
}

// Thinking arrives token by token; the text is appended in batches so the block is not rebuilt and re-laid-out per token.
let thinkPending = '';
let thinkQueued = false;

function flushThinking(): void {
  thinkQueued = false;
  if (!currentThinking || !thinkPending) {
    thinkPending = '';
    return;
  }
  currentThinking.body.appendChild(document.createTextNode(thinkPending));
  thinkPending = '';
  if (currentThinking.el.open) currentThinking.body.scrollTop = currentThinking.body.scrollHeight;
  scrollToBottom();
}

function finishThinking(): void {
  if (!currentThinking) return;
  if (thinkPending) {
    currentThinking.body.appendChild(document.createTextNode(thinkPending));
    thinkPending = '';
  }
  if (!currentThinking.raw.trim()) {
    // Some models open and close an empty think block; there is nothing to show.
    currentThinking.el.remove();
    currentThinking = null;
    return;
  }
  currentThinking.el.classList.remove('live');
  currentThinking.label.textContent = `Thought for ${seconds(Date.now() - currentThinking.startedAt)}`;
  currentThinking = null;
}

// Tool rows, and the runs of them that fold into one line. With Tool activity set to Summary (the default) every run of
// calls in a turn, a single call included, is one quiet `.tool-group` line ("Ran a command", "Read 3 files, ran 2
// commands  +49 −2"), with the thinking between the calls inside it; opened, it shows the rows (a lone row opens with
// it). With Every call only runs of three or more reads, searches, listings and MCP calls fold, as they always did. A
// run is whatever stands between two other things (a reply, a waiting approval or question card, a plan, an image, a
// notice), so a stored session folds the same way. An answered approval leaves no line of its own: the call's row
// says what was decided.
const cardByEl = new WeakMap<HTMLElement, ToolCard>();

function summaryMode(): boolean {
  return (config?.toolActivity ?? 'summary') !== 'all';
}

/** Whether a top-level node can be part of a run of calls */
function foldable(n: Element): boolean {
  const c = n.classList;
  if (c.contains('tool-group') || c.contains('thinking')) return true;
  if (c.contains('tool')) return summaryMode() || c.contains('groupable');
  // An approval belongs with its call once it is decided; while it waits it stays in the open, under the run
  return summaryMode() && c.contains('approval') && c.contains('done');
}

function groupCards(group: Element): ToolCard[] {
  return [...group.querySelectorAll<HTMLElement>(':scope > .group-body > .tool')].filter((el) => !el.hidden).map((el) => cardByEl.get(el)).filter((c): c is ToolCard => Boolean(c));
}

/** The group is the run of the turn going on now: nothing but thinking, approval cards or hidden rows came after it */
function liveGroup(group: Element): boolean {
  if (!running || !summaryMode()) return false;
  for (let n = group.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.classList.contains('thinking') || n.classList.contains('approval') || n.classList.contains('question-card') || ((n as HTMLElement).hidden && n.classList.contains('tool'))) continue;
    return false;
  }
  return true;
}

function updateGroup(group: Element | null): void {
  if (!group) return;
  const cards = groupCards(group);
  const live = liveGroup(group);
  const verb = group.querySelector<HTMLElement>(':scope > summary > .group-verb')!;
  const arg = group.querySelector<HTMLElement>(':scope > summary > .group-arg')!;
  const words = activityWords(
    cards.map((c) => ({
      name: c.name,
      path: typeof c.args.path === 'string' ? c.args.path : undefined,
      created: c.created,
      url: typeof c.args.url === 'string' ? c.args.url : undefined,
      denied: c.outcome === 'denied',
    })),
  );
  // While the run goes on, the line reads like the row of the call in flight; once it is over, what the run did
  const now = live ? (cards.filter((c) => c.running).pop() ?? cards[cards.length - 1]) : undefined;
  if (now) {
    const rowVerb = now.el.querySelector<HTMLElement>(':scope > summary > .tool-verb');
    const rowArg = now.el.querySelector<HTMLElement>(':scope > summary > .tool-arg');
    verb.textContent = rowVerb?.textContent ?? '';
    verb.classList.toggle('mono', Boolean(rowVerb?.classList.contains('mono')));
    arg.textContent = rowArg?.textContent ?? '';
    arg.classList.toggle('mono', Boolean(rowArg?.classList.contains('mono')));
  } else {
    verb.textContent = words.text;
    verb.classList.remove('mono');
    arg.textContent = '';
  }
  group.classList.toggle('live', live);
  // One icon the calls share (a run of commands, of MCP calls), otherwise the files
  const icons = new Set(cards.map((c) => c.el.dataset.icon ?? ''));
  const kind: IconName = icons.size === 1 && isIconName([...icons][0]) ? ([...icons][0] as IconName) : 'files';
  const groupIcon = group.querySelector<HTMLElement>(':scope > summary > .group-icon')!;
  if ((groupIcon.dataset.kind ?? 'files') !== kind) {
    groupIcon.dataset.kind = kind;
    groupIcon.innerHTML = icon(kind);
  }
  const busy = live || (!summaryMode() && cards.some((c) => c.running));
  const failed = cards.filter((c) => c.outcome === 'failed').length;
  // A folded run says "N failed" in red on its right; a group of reads (Every call) marks its icon, as it always did
  groupIcon.className = `group-icon${busy ? ' spin' : failed && !summaryMode() ? ' err' : ''}`;
  // On the right: the lines edits and writes added and removed, then what failed and what was denied
  let added = 0;
  let removed = 0;
  for (const c of cards) {
    added += c.diff?.added ?? 0;
    removed += c.diff?.removed ?? 0;
  }
  const meta: string[] = [];
  if (added || removed) meta.push(`<span class="group-stat">${statHtml(added, removed)}</span>`);
  if (failed) meta.push(`<span class="group-failed meta-err">${failed} failed</span>`);
  if (words.denied) meta.push(`<span class="group-denied">${words.denied} denied</span>`);
  group.querySelector(':scope > summary > .group-meta')!.innerHTML = meta.join(' ');
  const summary = group.querySelector<HTMLElement>(':scope > summary')!;
  summary.setAttribute('aria-label', [now ? `${verb.textContent} ${arg.textContent}`.trim() : words.text, ...meta.map((m) => m.replace(/<[^>]+>/g, ''))].join(', '));
}

function createGroup(): HTMLDetailsElement {
  const group = document.createElement('details');
  group.className = 'tool-group';
  // A line that stands for one call opens straight to that call's details
  group.addEventListener('toggle', () => {
    if (!group.open) return;
    const cards = groupCards(group);
    if (cards.length === 1) cards[0].el.open = true;
  });
  group.innerHTML =
    `<summary><span class="tool-chevron">${icon('chevron-right')}</span><span class="group-icon">${icon('files')}</span>` +
    `<span class="tool-verb group-verb"></span><span class="tool-arg group-arg"></span><span class="tool-meta group-meta"></span></summary><div class="group-body"></div>`;
  return group;
}

/** Puts `nodes` in this order right after `after` (or first in `parent`), moving only those that are not there yet. */
function placeAfter(parent: Element, after: Element | null, nodes: Element[]): void {
  let cursor = after;
  for (const n of nodes) {
    const next = cursor ? cursor.nextElementSibling : parent.firstElementChild;
    if (next !== n) {
      if (cursor) cursor.after(n);
      else parent.prepend(n);
    }
    cursor = n;
  }
}

/**
 * Makes the run of calls around `anchor` (a row, a decided approval, a group, a thinking block) look as it should:
 * one group from its first call to its last call or approval when it has enough calls, the rows in the open when it
 * has not. Thinking before the first call and after the last stays outside. Only what is out of place moves.
 */
function settleRun(anchor: Element): void {
  const top = anchor.parentElement?.classList.contains('group-body') ? anchor.closest('.tool-group')! : anchor;
  if (top.parentElement !== messagesEl || !foldable(top)) return;
  let first = top;
  let last = top;
  while (first.previousElementSibling && foldable(first.previousElementSibling)) first = first.previousElementSibling;
  while (last.nextElementSibling && foldable(last.nextElementSibling)) last = last.nextElementSibling;
  const tops: Element[] = [];
  for (let n: Element | null = first; n; n = n === last ? null : n.nextElementSibling) tops.push(n);
  const groups = tops.filter((n) => n.classList.contains('tool-group'));
  const items = tops.flatMap((n) => (n.classList.contains('tool-group') ? [...n.querySelector(':scope > .group-body')!.children] : [n]));
  const before = first.previousElementSibling;
  const isCall = (n: Element) => n.classList.contains('tool');
  const from = items.findIndex(isCall);
  let to = -1;
  items.forEach((n, i) => {
    if (isCall(n) || n.classList.contains('approval')) to = i;
  });
  const calls = items.filter((n) => isCall(n) && !(n as HTMLElement).hidden).length;
  if (from < 0 || calls < (summaryMode() ? 1 : 3)) {
    placeAfter(messagesEl, before, items);
    for (const g of groups) g.remove();
    return;
  }
  const group = groups[0] ?? createGroup();
  placeAfter(messagesEl, before, [...items.slice(0, from), group, ...items.slice(to + 1)]);
  placeAfter(group.querySelector(':scope > .group-body')!, null, items.slice(from, to + 1));
  for (const g of groups.slice(1)) g.remove();
  updateGroup(group);
}

/** Folds the whole conversation again (the setting changed): every group opens up, then each run settles. */
function refoldAll(): void {
  for (const g of [...messagesEl.querySelectorAll<HTMLElement>(':scope > .tool-group')]) {
    const body = g.querySelector(':scope > .group-body')!;
    g.replaceWith(...body.children);
  }
  for (const n of [...messagesEl.children]) if (n.isConnected && n.parentElement === messagesEl && (n.classList.contains('tool') || n.classList.contains('approval'))) settleRun(n);
}

/** Something that is not part of a run went into the transcript: the run before it is over, its line says what it did. */
function endLiveRun(): void {
  for (const g of messagesEl.querySelectorAll(':scope > .tool-group.live')) updateGroup(g);
}

function addToolCard(name: string, args: unknown, id?: string): ToolCard {
  endAssistant();
  finishThinking();
  const card = createToolCard(name, args);
  if (id) toolCards.set(id, card);
  cardByEl.set(card.el, card);
  lastToolCard = card;
  addNode(card.el);
  settleRun(card.el);
  return card;
}

function finishToolCard(ev: { id?: string; name: string; result: string; ok: boolean; image?: string; durationMs?: number }, known?: ToolCard): void {
  const card = known ?? (ev.id ? toolCards.get(ev.id) : undefined);
  if (!card) return;
  const group = card.el.closest('.tool-group');
  card.finish({ result: ev.result, ok: ev.ok, image: ev.image, durationMs: ev.durationMs });
  if (ev.id) toolCards.delete(ev.id);
  // A row can leave (a shown image) or come out of hiding (an image that could not be shown): the run settles again
  if (card.el.isConnected) settleRun(card.el);
  else if (group?.isConnected) settleRun(group);
  scrollToBottom();
}

// Approval card, as Claude Code draws it: the question as the title in a header band; what the call does (its own
// description) and why it stopped to ask in muted text; the command or the change; Deny and "Allow once ⌘↵" on the
// right, with ⌄ for the wider scopes. ⌘↵ allows once, Esc denies, A and P pick the scopes. Once decided the card goes
// and the call's own row says what was decided (a call without a row keeps a one-line decided card).
let promptSeq = 0;

/**
 * Why a card asks although the mode would have run it: "Auto mode stopped to ask: it pushes to a remote." A card
 * without wider scopes (a tool's own question, a PreToolUse hook's "ask") says its reason as it was written.
 */
function stopNote(mode: PermissionMode, reason: string, custom = false): string {
  if (custom) return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? '' : '.'}`;
  const why = reason === 'destructive MCP tool' ? 'it can change or delete data' : /^[a-z-]+s\b/.test(reason) ? `it ${reason}` : reason;
  return `${mode === 'auto' ? 'Auto mode stopped to ask' : 'Flagged as risky'}: ${why}.`;
}

/** The words a call's row shows for an approval's answer */
function decisionWords(ok: boolean, kind: 'once' | 'session' | 'project', alwaysLabel: string, projectLabel: string): string {
  if (!ok) return 'Denied';
  if (kind === 'session') return alwaysLabel.replace(/^Allow\b/, 'Allowed');
  if (kind === 'project') return projectLabel.replace(/^Always allow\b/, 'Always allowed');
  return 'Allowed once';
}

function addApprovalCard(ev: Extract<AgentEvent, { type: 'approval_request' }>, synthetic = false): void {
  endAssistant();
  finishThinking();
  pendingApproval?.cancel('Superseded');
  const card = lastToolCard && lastToolCard.running && lastToolCard.name === ev.name ? lastToolCard : null;
  const el = document.createElement('div');
  const reason = typeof ev.reason === 'string' ? ev.reason.trim() : '';
  el.className = 'approval prompt-card' + (reason ? ' flagged' : '');
  const uid = `prompt-${++promptSeq}`;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-labelledby', `${uid}-title`);
  const mcp = mcpParts(ev.name);
  // A tool's own question (sub-sessions, messages, schedules): its wording comes from the detail the main process sent
  const agent = mcp ? null : agentApproval(ev.name, ev.detail);
  if (agent) card?.noteApproval(ev.detail);
  if (mcp) el.classList.add('mcp');
  el.innerHTML = `<div class="prompt-head"><div class="title" id="${uid}-title">${escapeHtml(approvalTitle(ev.name, ev.detail, card?.args))}</div></div>`;
  const body = document.createElement('div');
  body.className = 'approval-body prompt-body';
  body.id = `${uid}-body`;
  // What the call does in its own words (a command's description), then why it asks when the mode would not have
  const said = typeof card?.args.description === 'string' ? card.args.description.replace(/\s+/g, ' ').trim() : '';
  if (said) body.insertAdjacentHTML('beforeend', `<p class="prompt-text">${escapeHtml(said)}</p>`);
  const custom = typeof ev.alwaysLabel === 'string' && !ev.alwaysLabel.trim() && typeof ev.projectLabel === 'string' && !ev.projectLabel.trim();
  if (reason) body.insertAdjacentHTML('beforeend', `<p class="prompt-text prompt-note">${escapeHtml(stopNote(ev.mode, reason, custom))}</p>`);
  if (said || reason) el.setAttribute('aria-describedby', body.id);
  let subject = ev.name;
  /** The decided line (a call without a row) names the action in words rather than a tool name or a path */
  let prose = false;
  if (agent) {
    subject = agent.subject;
    prose = true;
    const pre = document.createElement('pre');
    pre.className = 'args prose';
    pre.textContent = ev.detail;
    body.appendChild(pre);
  } else if (mcp) {
    // The arguments, pretty-printed by the main process, in the same mono block as a command.
    subject = `${mcp.tool} · ${mcp.server}`;
    const json = typeof ev.detail === 'string' ? ev.detail.trim() : '';
    body.insertAdjacentHTML('beforeend', json && json !== '{}' ? `<div class="cmd json"><code>${highlight(json, 'json')}</code></div>` : '<div class="tool-note">No arguments</div>');
  } else if (ev.name === 'bash' || ev.name === 'terminal_run') {
    subject = ev.detail.split('\n')[0];
    body.insertAdjacentHTML('beforeend', `<div class="cmd"><span class="cmd-prompt">$</span><code>${highlight(ev.detail, 'sh')}</code></div>`);
  } else if (ev.name === 'edit_file' && parseEditPreview(ev.detail)) {
    const p = parseEditPreview(ev.detail)!;
    subject = basename(p.path);
    let rows = lineDiff(p.oldText, p.newText);
    const at = editStartLine(p.path, p.oldText);
    if (at !== undefined) rows = numberRows(rows, at);
    const diff = renderDiff(displayPath(p.path), rows);
    // The file's path opens it in the editor, as in the tool rows
    linkPath(diff.querySelector<HTMLElement>('.diff-head .path'), p.path);
    body.appendChild(diff);
  } else if (ev.name === 'write_file' && card && typeof card.args.content === 'string') {
    const path = typeof card.args.path === 'string' ? card.args.path : ev.detail.split('\n')[0];
    subject = basename(path);
    const file = ev.detail.split('\n')[0] || path;
    const diff = renderDiff(displayPath(file), numberRows(fileLines(card.args.content).map((t) => ({ kind: 'add' as const, text: t })), 1));
    linkPath(diff.querySelector<HTMLElement>('.diff-head .path'), file);
    body.appendChild(diff);
  } else {
    if (ev.name === 'write_file') subject = basename(ev.detail.split('\n')[0]);
    const pre = document.createElement('pre');
    pre.className = 'args';
    pre.textContent = ev.name === 'write_file' || ev.name === 'edit_file' ? ev.detail.replace(/^[^\n]+/, (line) => displayPath(line)) : ev.detail;
    body.appendChild(pre);
  }

  // An empty label (a tool's own question) means the card has no such answer: only Allow once and Deny.
  const noAlways = typeof ev.alwaysLabel === 'string' && !ev.alwaysLabel.trim();
  const noProject = typeof ev.projectLabel === 'string' && !ev.projectLabel.trim();
  const alwaysLabel = typeof ev.alwaysLabel === 'string' && ev.alwaysLabel.trim() ? ev.alwaysLabel.trim() : 'Allow for this session';
  const projectLabel = typeof ev.projectLabel === 'string' && ev.projectLabel.trim() ? ev.projectLabel.trim() : 'Always allow in this project';
  /** once: this action only; session: "allow … for this session"; project: saved for the working directory */
  type Answer = 'once' | 'session' | 'project';
  const scopes: { label: string; key: string; kind: Answer }[] = [];
  if (!noAlways) scopes.push({ label: alwaysLabel, key: 'A', kind: 'session' });
  if (!noProject) scopes.push({ label: projectLabel, key: 'P', kind: 'project' });

  const foot = document.createElement('div');
  foot.className = 'row prompt-foot';
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'btn deny';
  deny.textContent = 'Deny';
  deny.setAttribute('aria-keyshortcuts', 'Escape');
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'btn primary allow';
  allow.innerHTML = '<span>Allow once</span><span class="keys" aria-hidden="true"><kbd>⌘</kbd><kbd>↵</kbd></span>';
  allow.setAttribute('aria-label', 'Allow once');
  allow.setAttribute('aria-keyshortcuts', 'Meta+Enter');
  const split = document.createElement('div');
  split.className = 'split-btn';
  split.append(allow);
  let more: HTMLButtonElement | null = null;
  if (scopes.length) {
    more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn primary more';
    more.innerHTML = icon('chevron-down', 14);
    more.setAttribute('aria-label', 'More ways to allow');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    split.append(more);
  }
  const main = document.createElement('div');
  main.className = 'row-main';
  main.append(deny, split);
  foot.append(main);
  el.append(body, foot);

  let settled = false;
  /** The card goes; the call's row keeps the outcome. Without a row the card folds to a decided line instead. */
  const settle = (text: string, ok: boolean, note = true) => {
    document.removeEventListener('keydown', onKey, true);
    if (more && menuAnchoredTo(more)) closeMenu();
    if (pendingApproval?.el === el) pendingApproval = null;
    const row = card && card.el.isConnected ? card : null;
    if (row) {
      if (note) row.noteDecision(text, ok);
      el.remove();
      settleRun(row.el);
      return;
    }
    el.classList.add('done');
    el.removeAttribute('role');
    el.innerHTML = `<div class="decided"><span class="${ok ? 'ok' : 'no'}">${icon(ok ? 'check' : 'x')}</span><span>${escapeHtml(text)}</span>${
      subject ? `<span>·</span>${prose ? `<span class="subject">${escapeHtml(subject)}</span>` : `<code>${escapeHtml(subject)}</code>`}` : ''
    }</div>`;
    // The decided line belongs with the call it answered: it folds into the run with it
    settleRun(el);
  };
  const decide = async (ok: boolean, answer: Answer = 'once') => {
    if (settled) return;
    settled = true;
    const kind: Answer = ok ? answer : 'once';
    settle(decisionWords(ok, kind, alwaysLabel, projectLabel), ok);
    if (running) setStatusText(baseVerb());
    if (synthetic) return;
    const before = currentMode();
    try {
      const next = kind === 'project' ? await oc.respondApproval(ev.id, true, true, 'project') : await oc.respondApproval(ev.id, ok, kind === 'session');
      if (next && typeof next === 'object' && 'permissionMode' in next) config = next;
      else if (kind !== 'once') config = await oc.getConfig();
    } catch (err) {
      addSystemMessage(`Couldn't send your answer: ${cleanError(err)}`, 'error');
      return;
    }
    applyConfigToUi();
    announceMode(before);
    // The new rule shows in Settings → Permissions.
    if (kind === 'project') void rulesPanel.refresh();
  };
  const openScopes = () => {
    if (!more || settled) return;
    if (menuAnchoredTo(more)) return closeMenu();
    openMenu([{ items: scopes.map((sc) => ({ label: sc.label, hint: sc.key, onSelect: () => void decide(true, sc.kind) })) }], {
      anchor: more,
      placement: 'bottom-end',
      className: 'scope-menu',
      minWidth: 240,
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing || e.altKey || settled) return;
    const k = e.key;
    const menu = more !== null && menuAnchoredTo(more);
    if ((dialogOpen() || isMenuOpen()) && !menu) return;
    // ⌘↵ (Ctrl+↵ too) allows once from anywhere, the composer included
    if (k === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      void decide(true);
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    // Plain keys only where they type nothing: not in a field with text (the empty composer is fine)
    const t = e.target as HTMLElement;
    if (isTextField(t) && !(t === inputEl && composerEmpty())) return;
    let action: (() => void) | null = null;
    if (k === 'Escape' && !menu) action = () => void decide(false);
    else if ((k === 'a' || k === 'A') && !noAlways) action = () => void decide(true, 'session');
    else if ((k === 'p' || k === 'P') && !noProject) action = () => void decide(true, 'project');
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  };
  document.addEventListener('keydown', onKey, true);
  pendingApproval = {
    id: ev.id,
    el,
    name: ev.name,
    cancel: (why: string) => {
      if (settled) return;
      settled = true;
      // The row says it itself (interrupted); only a call without a row keeps the word
      settle(why, false, false);
    },
    allow: () => void decide(true),
    // Answered elsewhere (the phone): the card goes the same way, nothing is sent back
    resolved: (ok: boolean, scope: Answer) => {
      if (settled) return;
      settled = true;
      settle(decisionWords(ok, ok ? scope : 'once', alwaysLabel, projectLabel), ok);
      if (running) setStatusText(baseVerb());
    },
    // The card left the screen with its session (a switch): it stays unanswered for when the session comes back.
    dispose: () => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      if (pendingApproval?.el === el) pendingApproval = null;
    },
  };
  allow.onclick = () => void decide(true);
  deny.onclick = () => void decide(false);
  if (more) more.onclick = openScopes;
  addNode(el);
  scrollToBottom(true);
}

// Question card (ask_user): the approval card's frame around the questions. The run waits for it like an approval:
// ⌘↵ goes on (Next, then Submit), Esc skips, 1–4 pick an option. Answered, it goes, and the call's row (in Summary
// the line "Asked a question") holds the answers.
function addQuestionCard(ev: Extract<AgentEvent, { type: 'question_request' }>, synthetic = false): void {
  const questions = Array.isArray(ev.questions) ? ev.questions.filter((q) => q && typeof q === 'object' && Array.isArray(q.options)) : [];
  if (!questions.length) return;
  endAssistant();
  finishThinking();
  pendingQuestion?.dispose();
  const row = lastToolCard && lastToolCard.running && lastToolCard.name === 'ask_user' ? lastToolCard : null;
  let settled = false;
  const close = () => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKey, true);
    if (pendingQuestion?.el === card.el) pendingQuestion = null;
    const hadFocus = card.el.contains(document.activeElement);
    card.el.remove();
    if (row?.el.isConnected) settleRun(row.el);
    if (running) setStatusText(baseVerb());
    if (hadFocus && !dialogOpen()) inputEl.focus();
  };
  const send = (answers: QuestionAnswer[] | null) => {
    if (settled) return;
    close();
    if (synthetic) return;
    oc.respondQuestion(ev.id, answers).catch((err: unknown) => addSystemMessage(`Couldn't send your answer: ${cleanError(err)}`, 'error'));
  };
  const card = createQuestionCard({ uid: `prompt-${++promptSeq}`, questions, onSubmit: (a) => send(a), onSkip: () => send(null) });
  const onKey = (e: KeyboardEvent) => {
    if (settled || e.isComposing || e.altKey || dialogOpen() || isMenuOpen()) return;
    // ⌘↵ (Ctrl+↵ too): the next question, or send the answers
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      card.next();
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const t = e.target as HTMLElement;
    const inCard = card.el.contains(t);
    const typing = !inCard && isTextField(t) && !(t === inputEl && composerEmpty());
    if (e.key === 'Escape') {
      // Skips the questions instead of stopping the run (not while the user types elsewhere)
      if (typing) return;
      e.preventDefault();
      e.stopPropagation();
      card.skip();
      return;
    }
    if (inCard || typing) return;
    if (card.key(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener('keydown', onKey, true);
  pendingQuestion = {
    id: ev.id,
    el: card.el,
    cancel: close,
    // The card left the screen with its session (a switch): it stays unanswered for when the session comes back.
    dispose: () => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      if (pendingQuestion?.el === card.el) pendingQuestion = null;
    },
  };
  addNode(card.el);
  scrollToBottom(true);
  // The keyboard moves into the card unless the user is typing a message
  const active = document.activeElement;
  if (!synthetic && (active === document.body || active === null || (active === inputEl && composerEmpty()))) card.focus();
}

// Plan cards: the newest proposed plan has the buttons; Enter builds and Esc keeps planning while it is the last card.
const KEEP_PLACEHOLDER = 'Tell Silo Harness what to change in the plan…';
const DEFAULT_PLACEHOLDER = inputEl.placeholder;
const RUNNING_PLACEHOLDER = '↵ queues a message for the agent’s next step, esc stops the run';
/** The placeholder while no run is going (the default, or the "keep planning" prompt) */
let basePlaceholder = DEFAULT_PLACEHOLDER;

function setBasePlaceholder(text: string): void {
  basePlaceholder = text;
  syncPlaceholder();
}

function syncPlaceholder(): void {
  inputEl.placeholder = running ? RUNNING_PLACEHOLDER : basePlaceholder;
}
const planCards = new Map<string, PlanCard>();
let activePlan: PlanCard | null = null;

function addPlanCard(plan: PlanInfo, opts: { synthetic?: boolean; interactive?: boolean } = {}): PlanCard | null {
  if (!plan || typeof plan !== 'object' || !plan.id) return null;
  endAssistant();
  finishThinking();
  const existing = planCards.get(plan.id);
  if (existing) {
    existing.update(plan);
    return existing;
  }
  const interactive = opts.interactive ?? plan.status === 'proposed';
  if (interactive) activePlan?.retire();
  const card = createPlanCard(plan, {
    interactive,
    respond: (c, decision, btn) => respondPlan(c, decision, btn, Boolean(opts.synthetic)),
    modeLabel: (d) => MODES[d === 'build-acceptEdits' ? 'acceptEdits' : 'ask'].label,
  });
  planCards.set(plan.id, card);
  if (interactive) activePlan = card;
  addNode(card.el);
  return card;
}

async function respondPlan(card: PlanCard, decision: PlanDecision, btn: HTMLElement, synthetic: boolean): Promise<boolean> {
  if (!synthetic) {
    try {
      if (typeof oc.plan?.respond !== 'function') throw new Error('No handler registered');
      await oc.plan.respond(card.plan.id, decision);
    } catch (err) {
      showInlineError(btn, `Couldn't ${decision === 'keep' ? 'send the plan back' : 'start building'}: ${cleanError(err)}`);
      return false;
    }
  }
  if (card === activePlan && (statusState === 'plan-ready' || statusState === 'plan-wait')) setStatus('off');
  if (decision === 'keep') {
    setBasePlaceholder(KEEP_PLACEHOLDER);
    if (!dialogOpen()) inputEl.focus();
  } else if (!synthetic && card.plan.kind !== 'dream') {
    // A dream's plan builds nothing: approving it applied its suggestions, and the mode stays as it was
    const before = currentMode();
    try {
      config = await oc.getConfig();
      applyConfigToUi();
    } catch {
      /* the chip catches up on the next config read */
    }
    if (currentMode() === 'plan' && before === 'plan') {
      // An older main process does not switch modes itself.
      showInlineError(modeBtn, 'Still in Plan mode: switch the mode to let Silo Harness make changes.');
    }
  }
  return true;
}

// Artifact cards: one per artifact id; an update refreshes the existing card in place.
const artifactCards = new Map<string, ArtifactCard>();

function addArtifactCard(info: ArtifactInfo, opts: { updated?: boolean } = {}): ArtifactCard | null {
  if (!info || typeof info !== 'object' || !info.id) return null;
  const existing = artifactCards.get(info.id);
  if (existing) {
    const newer = Number(info.version) > Number(existing.info.version);
    existing.update(info, newer || Boolean(opts.updated));
    return existing;
  }
  endAssistant();
  finishThinking();
  const card = createArtifactCard(info, { act: artifactAction, updated: Boolean(opts.updated) || Number(info.version) > 1 });
  artifactCards.set(info.id, card);
  addNode(card.el);
  return card;
}

const ARTIFACT_VERBS: Record<ArtifactAction, string> = { open: 'open', saveAs: 'save', reveal: 'reveal' };

async function artifactAction(card: ArtifactCard, action: ArtifactAction, button: HTMLButtonElement): Promise<string | boolean> {
  const api = oc.artifacts;
  try {
    if (!api || typeof api[action] !== 'function') throw new Error('No handler registered');
    if (action === 'open') {
      await api.open(card.info.id);
      showPaneTab('browser');
      return true;
    }
    if (action === 'saveAs') {
      const saved = await api.saveAs(card.info.id);
      if (!saved) return false;
      button.dataset.tip = `Saved to ${saved}`;
      return 'Saved';
    }
    await api.reveal(card.info.id);
    return true;
  } catch (err) {
    showInlineError(button, `Couldn't ${ARTIFACT_VERBS[action]} the artifact: ${cleanError(err)}`);
    return false;
  }
}

/** True when nothing but quiet notices follows the card in the transcript. */
function isLastCard(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.matches('.msg.user, .msg.assistant, .tool, .tool-group, .approval, .question-card, .plan-card, .artifact-card, .thinking')) return false;
  }
  return true;
}

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    if (!activePlan?.pending() || running || pendingApproval) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
    if (dialogOpen() || isMenuOpen() || !slashMenu.hidden || titleEditing) return;
    const t = e.target as HTMLElement;
    if (isTextField(t) && !(t === inputEl && composerEmpty())) return;
    if (composerHasContent()) return;
    if (e.key === 'Enter' && (t instanceof HTMLButtonElement || t.closest('[role="tab"]'))) return;
    if (!isLastCard(activePlan.el)) return;
    e.preventDefault();
    e.stopPropagation();
    void activePlan.decide(e.key === 'Enter' ? 'build-ask' : 'keep');
  },
  true,
);

function clearMessages(): void {
  pendingApproval?.dispose();
  pendingQuestion?.dispose();
  showJump(false);
  messagesEl.querySelectorAll(':scope > :not(#empty-state)').forEach((n) => n.remove());
  emptyState.hidden = false;
  currentAssistant = null;
  currentThinking = null;
  thinkPending = '';
  lastToolCard = null;
  toolCards.clear();
  hiddenTools.clear();
  planCards.clear();
  artifactCards.clear();
  activePlan = null;
  turnSync++;
  // ⌘↑ walks the messages on screen: a walk through the previous session's is over
  composerHistory.reset();
  setBasePlaceholder(DEFAULT_PLACEHOLDER);
  if (statusState !== 'run') setStatus('off');
  clearBrowsing();
  resetFileCache();
  stick = true;
}

function renderTranscript(items: TranscriptItem[]): void {
  clearMessages();
  // Only the newest plan can still be decided, and only if nothing was said after it.
  let lastPlan = -1;
  let lastUser = -1;
  items.forEach((item, i) => {
    if (item.role === 'plan') lastPlan = i;
    else if (item.role === 'user') lastUser = i;
  });
  items.forEach((item, i) => {
    if (item.role === 'user') {
      const images = Array.isArray(item.images) ? item.images.filter((src): src is string => typeof src === 'string' && Boolean(src)) : [];
      const shown = unframe(item.origin, item.text ?? '');
      addUserMessage(shown.text, images.map((src) => ({ src })), Array.isArray(item.mentions) ? item.mentions : null, { turn: item.turn, originLabel: item.origin ? originLabel(item.origin, item.from, shown.note) : undefined, markdown: writtenByModel(item.origin), folded: item.origin === 'dream' });
    } else if (item.role === 'assistant') {
      appendAssistantText(item.text);
      endAssistant();
    } else if (item.role === 'plan') {
      addPlanCard(item.plan, { interactive: i === lastPlan && i > lastUser && item.plan?.status === 'proposed' });
    } else if (item.role === 'artifact') {
      addArtifactCard(item.artifact);
    } else if (item.role === 'compaction') {
      addCompaction(item.compaction);
    } else if (item.role === 'tool') {
      if (item.name === 'submit_plan' && item.ok) return;
      const card = addToolCard(item.name, item.args);
      finishToolCard({ name: item.name, result: item.result, ok: item.ok }, card);
    } else {
      // A role a feature registered (transcript-items.ts)
      const extra = item as unknown as ExtraTranscriptItem;
      const el = transcriptItemRenderer(extra.role)?.(extra);
      if (el) appendExtraNode(el);
    }
  });
  scrollToBottom(true);
}

/** A feature's transcript row: after the streaming reply and the thinking block are closed. */
function appendExtraNode(el: HTMLElement): void {
  endAssistant();
  finishThinking();
  addNode(el);
}
setTranscriptSink(appendExtraNode);

/** A message another session sent, a summary a merge wrote, or a dream's digest: written for a model, as Markdown. */
function writtenByModel(origin: MessageOrigin | undefined): boolean {
  return origin === 'session' || origin === 'command' || origin === 'dream';
}

/**
 * "from schedule", "from session Fix the tests", … for a user message that was not typed here. `note` is what the
 * message's frame said about the sender (a sub-session "finished a turn", "was stopped").
 */
function originLabel(origin: MessageOrigin, from?: string, note?: string): string | undefined {
  if (origin === 'user' || origin === 'queue') return undefined;
  if (origin === 'session') {
    const title = from ? sessions.find((m) => m.id === from)?.title : undefined;
    return `from session ${title ?? from ?? 'another session'}${note ? ` · ${note}` : ''}`;
  }
  if (origin === 'mod') return from ? `from mod ${from}` : 'from a mod';
  if (origin === 'schedule') return from ? `scheduled: ${from}` : 'scheduled';
  if (origin === 'remote') return 'from remote control';
  if (origin === 'dream') return 'dreaming · what the dream read';
  // A slash command put this into the conversation; with a session behind it, it is that session's merged summary.
  if (origin === 'command') {
    const title = from ? sessions.find((m) => m.id === from)?.title : undefined;
    return title ? `merged from ${title}` : from ? 'merged' : 'from a command';
  }
  return `from ${origin}`;
}

// ---------- Rewind: user bubbles carry their checkpoint (turn); Rewind goes back to it ----------

const REWIND_DESCRIPTION =
  'Files the agent wrote or edited after it go back to how they were, the later messages are removed, and the message returns to the composer. Changes made by commands are not undone.';

const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * Gives the bubbles on screen their checkpoints from the transcript the main process holds: the newest transcript
 * message goes to the newest bubble with the same text, and so on backwards. Bubbles without a match (and commands
 * handled here) get none.
 */
function applyTurns(items: TranscriptItem[]): void {
  const users = items.filter((it): it is Extract<TranscriptItem, { role: 'user' }> => it?.role === 'user');
  const bubbles = [...messagesEl.querySelectorAll<HTMLElement>(':scope > .msg.user:not([data-local])')];
  const turns = new Map<HTMLElement, number | undefined>();
  let end = bubbles.length - 1;
  for (let i = users.length - 1; i >= 0 && end >= 0; i--) {
    const text = typeof users[i].text === 'string' ? users[i].text : '';
    let j = end;
    while (j >= 0 && !sameText(userTextByMessage.get(bubbles[j]) ?? '', text)) j--;
    if (j < 0) continue;
    turns.set(bubbles[j], users[i].turn);
    end = j - 1;
  }
  for (const el of messagesEl.querySelectorAll<HTMLElement>(':scope > .msg.user')) setTurn(el, turns.get(el));
}

/** After a run (or a fork): the bubbles learn their checkpoints from the transcript, read back from the main process. */
async function syncTurns(): Promise<void> {
  const my = ++turnSync;
  const id = currentSessionId;
  if (!id || running) return;
  let items: TranscriptItem[];
  try {
    // Read without bringing it on screen: the user may switch away while this is in flight.
    items = await rpc('sessions.transcript', id);
  } catch {
    return; // a new run started meanwhile; its end syncs again
  }
  if (my !== turnSync || id !== currentSessionId || running || rewinding || !Array.isArray(items)) return;
  applyTurns(items);
}

/** A compaction folded the conversation: none of the earlier messages can be rewound to any more. */
function clearTurns(): void {
  turnSync++;
  for (const el of messagesEl.querySelectorAll<HTMLElement>(':scope > .msg.user[data-turn]')) setTurn(el, undefined);
}

/** Rewind waits for an idle agent: its buttons are hidden during a run, a compaction or another rewind. */
function syncBusyUi(): void {
  shell.classList.toggle('rewind-off', running || compacting !== null || rewinding);
  taskList.setRunning(running);
}

function setRewinding(v: boolean): void {
  rewinding = v;
  syncBusyUi();
}

/** "Rewound · 2 files restored · 1 removed", and the paths for its tooltip. */
function rewindNotice(res: RewindResult): { text: string; tip: string } {
  const paths = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && Boolean(p)) : []);
  const restored = paths(res.restored);
  const removed = paths(res.deleted);
  const skipped = paths(res.skipped);
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (restored.length) parts.push(`${files(restored.length)} restored`);
  if (removed.length) parts.push(parts.length ? `${removed.length} removed` : `${files(removed.length)} removed`);
  if (skipped.length) parts.push(parts.length ? `${skipped.length} could not be restored` : `${files(skipped.length)} could not be restored`);
  const list = (label: string, a: string[]) => (a.length ? `${label}: ${a.slice(0, 8).join(', ')}${a.length > 8 ? ` and ${a.length - 8} more` : ''}` : '');
  return {
    text: `Rewound · ${parts.length ? parts.join(' · ') : 'no files changed'}`,
    tip: [list('Restored', restored), list('Removed', removed), list('Not restored', skipped)].filter(Boolean).join('\n'),
  };
}

/** The rewound message's images go back into the composer with its text. */
async function restoreImages(srcs: string[]): Promise<void> {
  const inputs: ImageInput[] = [];
  srcs.forEach((src, i) => {
    try {
      inputs.push({ blob: dataUrlToBlob(src), name: srcs.length > 1 ? `Image ${i + 1}` : 'Image' });
    } catch {
      /* not a data: URL the tray can read */
    }
  });
  if (inputs.length) await attachImages(inputs);
}

/** The message a rewind goes back to, quoted in the confirmation: its text (a long one cut short), or its images. */
function rewindQuote(msg: HTMLElement): { text: string } | undefined {
  const text = (userTextByMessage.get(msg) ?? '').trim();
  if (text) return { text: text.length > 280 ? `${text.slice(0, 280).trimEnd()}…` : text };
  const images = msg.querySelectorAll('.bubble-image').length;
  return images ? { text: `${images} image${images === 1 ? '' : 's'}` } : undefined;
}

/** Esc Esc: the rewind confirmation for the newest message that has a checkpoint (nothing happens without one). */
function rewindLatest(): void {
  const msg = [...messagesEl.querySelectorAll<HTMLElement>(':scope > .msg.user[data-turn]')].pop();
  if (!msg) return;
  msg.scrollIntoView({ block: 'nearest' });
  void rewindTo(msg, sendBtn);
}

/**
 * The bubble's Rewind (and Esc Esc): confirm, rewind the session to the message's checkpoint, and hand the message
 * back to the composer. `button` is where a "has to wait" error shows.
 */
async function rewindTo(msg: HTMLElement, button: HTMLElement): Promise<void> {
  const turn = turnOf(msg);
  if (turn === null || rewinding) return;
  const busy = () => {
    if (!running && !compacting) return false;
    showInlineError(button.isConnected && button.offsetParent ? button : sendBtn, running ? 'Rewinding has to wait for the run to finish (or stop it with Esc).' : 'Rewinding has to wait for the compaction to finish.');
    return true;
  };
  if (busy()) return;
  if (typeof oc.sessions?.rewind !== 'function') {
    addSystemMessage('Rewinding needs the updated app. Restart Silo Harness and try again.', 'error');
    return;
  }
  const ok = await confirmAction({ title: 'Rewind to this message?', quote: rewindQuote(msg), description: REWIND_DESCRIPTION, confirmLabel: 'Rewind', danger: true });
  if (!ok || rewinding || !msg.isConnected || busy()) return;
  const images = [...msg.querySelectorAll<HTMLImageElement>('.bubble-image img')].map((img) => img.getAttribute('src') ?? '').filter((src) => src.startsWith('data:image/'));
  setRewinding(true);
  let res: RewindResult;
  try {
    res = await oc.sessions.rewind(turn);
    if (!res || typeof res !== 'object' || !Array.isArray(res.transcript)) throw new Error('The app did not answer.');
  } catch (err) {
    setRewinding(false);
    addSystemMessage(`Couldn't rewind: ${cleanError(err)}`, 'error');
    return;
  }
  setRewinding(false);
  renderTranscript(res.transcript);
  if (res.session && typeof res.session === 'object' && res.session.id === currentSessionId) showTasks(res.session.tasks);
  const notice = rewindNotice(res);
  const note = addSystemMessage(notice.text, 'notice');
  if (notice.tip) note.querySelector('span')?.setAttribute('data-tip', notice.tip);
  // The message comes back into the composer (after anything already typed there), caret at the end.
  restoreComposerText(typeof res.text === 'string' ? res.text : '');
  if (images.length) void restoreImages(images);
  if (!dialogOpen()) inputEl.focus();
  void refreshSessions();
  void changesPane.refresh();
  void refreshContext();
}

// ---------- Run state ----------

/**
 * The chat bar's action: the return glyph, muted with nothing to send and in the text colour once there is; while a
 * run is going and the field is empty it is the stop square, and with something typed it queues the message.
 */
type SendFace = 'send' | 'queue' | 'stop';
let sendFace: SendFace | null = null;
function updateSendButton(): void {
  const content = composerHasContent();
  const face: SendFace = running ? (content ? 'queue' : 'stop') : 'send';
  sendBtn.disabled = face === 'send' && !content;
  sendBtn.classList.toggle('ready', content);
  if (sendFace === face) return;
  sendFace = face;
  sendBtn.innerHTML = icon(face === 'stop' ? 'stop' : 'corner-down-left');
  sendBtn.classList.toggle('stop', face === 'stop');
  const label = face === 'stop' ? 'Stop' : face === 'queue' ? 'Queue for the next step' : 'Send';
  sendBtn.setAttribute('aria-label', label);
  sendBtn.dataset.tip = label;
  sendBtn.dataset.tipKbd = face === 'stop' ? 'esc' : '↵';
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// The status line: the run (spinner, verb, elapsed, tokens, esc) or, after a plan, a quiet line with the keys.
type StatusState = 'off' | 'run' | 'plan-ready' | 'plan-wait';
let statusState: StatusState = 'off';
let statusTimer: number | undefined;

function setStatus(state: StatusState, text?: string): void {
  statusState = state;
  window.clearTimeout(statusTimer);
  statusLine.hidden = state === 'off';
  statusLine.classList.toggle('idle', state !== 'run');
  statusHint.hidden = state !== 'plan-wait' || composerHasContent();
  if (text !== undefined) statusText.textContent = text;
}

function setStatusText(text: string): void {
  if (statusState === 'run' && statusText.textContent !== text) statusText.textContent = text;
}

/** "Working…", or "Planning…" in plan mode */
function baseVerb(): string {
  return currentMode() === 'plan' ? 'Planning…' : 'Working…';
}

function showPlanReady(): void {
  setStatus('plan-ready', 'Plan ready for review');
  statusTimer = window.setTimeout(() => {
    if (statusState !== 'plan-ready') return;
    if (activePlan?.pending() && isLastCard(activePlan.el)) setStatus('plan-wait', 'Waiting for plan approval');
    else setStatus('off');
  }, 2500);
}

/** Ends the plan status line once the plan was decided elsewhere. */
function syncPlanStatus(): void {
  if ((statusState === 'plan-ready' || statusState === 'plan-wait') && !activePlan?.pending()) setStatus('off');
}

/**
 * Spinners rotate through one 8-per-second timer and a CSS variable instead of CSS animations: Chromium ticks a
 * running animation on every frame whether or not it changes, which costs a few percent of CPU for the whole run.
 */
let spinTimer: number | undefined;
let spinStep = 0;
function syncSpin(): void {
  const want = (running || compacting !== null || ollamaStartedAt > 0) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (want && spinTimer === undefined) {
    spinTimer = window.setInterval(() => {
      spinStep = (spinStep + 1) % 12;
      // Set on each spinner, never on the document: a root-level change recalculates styles for the whole transcript.
      const deg = `${spinStep * 30}deg`;
      document.querySelectorAll<HTMLElement>('.spinner, .tool-status.spin, .group-icon.spin').forEach((el) => el.style.setProperty('--spin', deg));
    }, 125);
  } else if (!want && spinTimer !== undefined) {
    window.clearInterval(spinTimer);
    spinTimer = undefined;
  }
}

/** The session on screen started or stopped running; `startedAt` is when a run this window joined late began. */
function setRunning(v: boolean, startedAt = Date.now()): void {
  running = v;
  updateSendButton();
  syncPlaceholder();
  syncBusyUi();
  syncSpin();
  if (currentSessionId) statuses.set(currentSessionId, { ...statusOf(currentSessionId), running: v });
  // The last run of calls is live while a run goes on (a session brought on screen mid-run, too)
  updateGroup([...messagesEl.querySelectorAll(':scope > .tool-group')].pop() ?? null);
  if (v) {
    runStartedAt = startedAt;
    setStatus('run', baseVerb());
    statusTime.textContent = elapsed(Date.now() - runStartedAt);
    statusTokens.hidden = true;
    runOutputTokens = 0;
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      statusTime.textContent = elapsed(Date.now() - runStartedAt);
    }, 1000);
  } else {
    if (statusState === 'run') setStatus('off');
    if (timer) {
      window.clearInterval(timer);
      timer = undefined;
    }
  }
  void refreshSessions();
}

// ---------- Compaction: the status line while the conversation is summarised, /compact and "Compact now" ----------

const COMPACTING_TEXT = 'Compacting context…';
/**
 * A compaction in progress. standalone: started outside a run (/compact, "Compact now"), so the status line is
 * shown for it alone (with its own elapsed time and the stop button, since abort cancels it) without counting as
 * a run. Otherwise it is an auto-compaction inside a run, which only swaps the status text until it ends.
 */
let compacting: { reason: 'auto' | 'manual'; standalone: boolean; prevText: string } | null = null;
/** Set when a compact_end with an error arrives, so oc.compact()'s own error is not shown a second time */
let compactErrorShown = false;

function startCompaction(reason: 'auto' | 'manual'): void {
  if (running) {
    const prev = statusText.textContent ?? '';
    compacting = { reason, standalone: false, prevText: prev && prev !== COMPACTING_TEXT ? prev : baseVerb() };
    setStatusText(COMPACTING_TEXT);
  } else {
    compacting = { reason, standalone: true, prevText: '' };
    runStartedAt = Date.now();
    setStatus('run', COMPACTING_TEXT);
    statusTime.textContent = '0s';
    statusTokens.hidden = true;
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      statusTime.textContent = elapsed(Date.now() - runStartedAt);
    }, 1000);
  }
  statusLine.classList.add('compacting');
  syncBusyUi();
  syncSpin();
}

function endCompaction(): void {
  const c = compacting;
  compacting = null;
  statusLine.classList.remove('compacting');
  syncBusyUi();
  syncSpin();
  if (!c) return;
  if (running) {
    // The previous verb comes back (the next event of the run replaces it as usual).
    if (statusText.textContent === COMPACTING_TEXT) setStatusText(c.prevText || baseVerb());
    return;
  }
  if (statusState === 'run') setStatus('off');
  if (timer) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

/** /compact and the context meter's "Compact now": failures show as an error notice in the transcript. */
async function compactNow(focus?: string): Promise<void> {
  if (typeof oc.compact !== 'function') {
    addSystemMessage('Compacting needs the updated app. Restart Silo Harness and try again.', 'error');
    return;
  }
  compactErrorShown = false;
  let res: { ok: boolean; error?: string };
  try {
    const r = await oc.compact(focus || undefined);
    res = r && typeof r === 'object' ? r : { ok: false, error: 'The app did not answer.' };
  } catch (err) {
    res = { ok: false, error: cleanError(err) };
  }
  if (!res.ok && !compactErrorShown) addSystemMessage(res.error || "Couldn't compact the conversation.", 'error');
}

/** The context meter: from 'context' events, oc.context() after a reload or session switch, and the debug hook. */
const contextMeter = createContextMeter({
  button: contextMeterBtn,
  boundary: transcriptWrap,
  busy: () => running || compacting !== null,
  compact: () => void compactNow(),
  openSettings: () => openSettings(config?.provider === 'portkey' ? 'portkey-contextWindow' : config?.provider === 'ollama' ? 'ollama-numCtx' : 'provider'),
});

async function refreshContext(): Promise<void> {
  if (typeof oc.context !== 'function') return;
  try {
    contextMeter.set(normalizeContext(await oc.context()));
  } catch {
    /* no session yet, or an older app: the meter waits for a context event */
  }
}

/** The context window the status line's token counter compares against. */
function contextLimit(): number {
  const known = contextMeter.get()?.limit;
  if (known) return known;
  if (!config) return 0;
  return Number(activeProvider(config).contextWindow) || 0;
}

/** True from Enter until the main process has answered, so a double Enter cannot send twice. */
let sending = false;

async function send(): Promise<void> {
  if (sending || rewinding || !composerHasContent()) return;
  sending = true;
  try {
    // Images still being scaled down go along once they are ready.
    if (tray.pending()) await tray.idle();
    await sendComposer();
  } finally {
    sending = false;
    updateSendButton();
  }
}

async function sendToAgent(text: string, images: ImageAttachment[]): Promise<SendResult> {
  try {
    const res = await oc.send(text, images.length ? images : undefined);
    return res && typeof res === 'object' ? res : { ok: false, error: 'The app did not answer.' };
  } catch (err) {
    return { ok: false, error: cleanError(err) };
  }
}

/** Puts text back into the composer, on a new line after anything already typed. */
function restoreComposerText(text: string): void {
  if (!text) return;
  mentionPicker.close();
  const current = inputEl.value.replace(/\s+$/, '');
  inputEl.value = current ? `${current}\n${text}` : text;
  const end = inputEl.value.length;
  inputEl.setSelectionRange(end, end);
  autosize();
}

/** Messages that did not reach the agent go back into the composer, text and images. */
function returnToComposer(messages: QueuedMessage[]): void {
  let left = 0;
  for (const m of messages) {
    restoreComposerText(typeof m.text === 'string' ? m.text : '');
    if (Array.isArray(m.attachments) && m.attachments.length) left += tray.restore(m.attachments);
  }
  if (left) showInlineError(attachBtn, `${left} image${left === 1 ? '' : 's'} did not fit: a message can have up to 8.`);
  // Focus comes to the composer unless the user is typing somewhere else (a terminal, the search field, the URL bar).
  const active = document.activeElement;
  if (!dialogOpen() && !titleEditing && (active === inputEl || !isTextField(active))) inputEl.focus();
}

/** While a run is in progress the message waits in the queue until the agent's next step. */
async function queueMessage(text: string, images: ImageAttachment[]): Promise<void> {
  const res = await sendToAgent(text, images);
  const sent = images.map((a) => a.id);
  if (res.ok && res.queued && res.id) {
    queueList.add({ id: res.id, text, attachments: images, createdAt: Date.now() });
    tray.clear(sent);
  } else if (res.ok) {
    // The run ended in the meantime, so the message started a new one.
    endAssistant();
    addUserMessage(text, images.map(bubbleImage));
    tray.clear(sent);
  } else {
    restoreComposerText(text);
    showInlineError(sendBtn, `Couldn't queue the message: ${res.error ?? 'unknown error'}`);
  }
}

// ---------- "#": a line for the project's instructions file ----------

/** Which instructions file "#" lines went to, per working directory (what the confirmation names) */
const instructionFiles = createInstructionFiles();

/**
 * A composer message starting with "#" is not sent to the model (nor queued during a run): after a confirmation its
 * text, without the "#", is appended to the project's instructions file. The composer keeps the text until it was
 * added; attached images are not part of it and stay in the composer.
 */
async function addToInstructions(memory: string): Promise<void> {
  hideSlashMenu();
  mentionPicker.close();
  const api = oc.instructions;
  if (!api || typeof api.append !== 'function') {
    addSystemMessage("Adding to the project's instructions needs the updated app. Restart Silo Harness and try again.", 'error');
    return;
  }
  const typed = inputEl.value;
  const cwd = config.workingDirectory;
  const file = instructionFiles.get(cwd);
  const images = tray.items().length;
  const imageNote = images
    ? ` ${images === 1 ? 'The attached image is' : `The ${images} attached images are`} not added; ${images === 1 ? 'it stays' : 'they stay'} in the composer.`
    : '';
  const ok = await confirmAction({
    title: "Add to the project's instructions?",
    quote: { label: file, text: `- ${oneLine(memory)}`, mono: true },
    description: `Silo Harness reads ${file} at the start of every run in this project.${imageNote}`,
    confirmLabel: 'Add',
    icon: 'file-plus',
  });
  if (!ok) {
    if (!dialogOpen()) inputEl.focus();
    return;
  }
  let res: { path: string; label: string } | null;
  try {
    res = await api.append(memory);
  } catch (err) {
    addSystemMessage(`Couldn't add to ${file}: ${cleanError(err)}`, 'error');
    return;
  }
  const label = res && typeof res.label === 'string' && res.label.trim() ? res.label.trim() : file;
  instructionFiles.set(cwd, label);
  // The text leaves the composer (unless something else was put there meanwhile); the images stay.
  if (inputEl.value === typed) {
    inputEl.value = '';
    autosize();
    if (statusState === 'plan-wait') statusHint.hidden = composerHasContent();
  }
  const left = tray.items().length;
  const imagesLeft = left ? ` · ${left === 1 ? 'the image was' : `${left} images were`} not added and ${left === 1 ? 'stays' : 'stay'} in the composer` : '';
  const note = addSystemMessage(`Added to ${label}${imagesLeft}`, 'notice');
  if (res && typeof res.path === 'string' && res.path) note.querySelector('span')?.setAttribute('data-tip', res.path);
  if (!dialogOpen()) inputEl.focus();
}

async function sendComposer(): Promise<void> {
  // "#…" goes to the project's instructions, never to the model
  const memory = memoryText(inputEl.value);
  if (memory !== null) return addToInstructions(memory);
  const text = inputEl.value.trim();
  const images = tray.items();
  if (!text && !images.length) return;
  inputEl.value = '';
  autosize();
  hideSlashMenu();
  mentionPicker.close();
  const compactCmd = images.length ? null : /^\/compact(?:\s+([\s\S]*))?$/.exec(text);
  if (compactCmd) {
    if (running || compacting) {
      // Not sent anywhere: it goes back into the composer for after the run.
      restoreComposerText(text);
      showInlineError(sendBtn, running ? 'Compacting has to wait for the run to finish (or stop it with Esc).' : 'The conversation is already being compacted.');
      return;
    }
    endAssistant();
    addUserMessage(text, [], null, { local: true });
    await compactNow(compactCmd[1]?.trim());
    return;
  }
  if (!images.length && text === '/mcp') {
    endAssistant();
    addUserMessage(text, [], null, { local: true });
    await addMcpCard();
    return;
  }
  if (!images.length && (text === '/skills' || text === '/help')) {
    endAssistant();
    addUserMessage(text, [], null, { local: true });
    const list = await oc.skills.list();
    addNoticeCard(
      list.length
        ? `**Skills**\n\n${list.map((sk) => `- \`/${sk.name}\` ${sk.description || 'No description'} *(${sk.source})*`).join('\n')}`
        : 'No skills found. Add a folder with a `SKILL.md` under `.silo-harness/skills` in your project or `~/.silo-harness/skills`.',
    );
    return;
  }
  const cmd = images.length ? null : /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (cmd && !commandSend) {
    const registered = await registeredCommand(cmd[1]);
    if (registered) {
      endAssistant();
      addUserMessage(text, [], null, { local: true });
      await runCommand(registered, cmd[2]?.trim() ?? '');
      return;
    }
  }
  if (running) return queueMessage(text, images);
  // Replying instead of approving sends the plan back, with this message as the feedback (as in Claude Code).
  if (activePlan?.pending()) await activePlan.decide('keep');
  setBasePlaceholder(DEFAULT_PLACEHOLDER);
  if (statusState !== 'run') setStatus('off');
  const bubble = addUserMessage(text, images.map(bubbleImage));
  endAssistant();
  const res = await sendToAgent(text, images);
  const sent = images.map((a) => a.id);
  if (res.ok && res.queued && res.id) {
    // A run was already going (e.g. this window was reloaded during one): the message waits in the queue instead.
    bubble.remove();
    if (!messagesEl.querySelector(':scope > :not(#empty-state)')) emptyState.hidden = false;
    queueList.add({ id: res.id, text, attachments: images, createdAt: Date.now() });
    tray.clear(sent);
  } else if (res.ok) tray.clear(sent);
  else {
    // Not in the conversation, so there is nothing to rewind to
    bubble.dataset.local = 'true';
    addSystemMessage(res.error ?? 'Could not start the run.', 'error');
  }
}

// ---------- Registered slash commands (app.commands in the main process) ----------

/** Set while a command's `send` text goes out, so it is sent as a message and never run as a command again */
let commandSend = false;

async function registeredCommands(): Promise<CommandInfo[]> {
  try {
    const list = await rpc('commands.list');
    return Array.isArray(list) ? list.filter((c) => c && typeof c.name === 'string') : [];
  } catch {
    return [];
  }
}

async function registeredCommand(name: string): Promise<CommandInfo | undefined> {
  return (await registeredCommands()).find((c) => c.name === name);
}

/** Runs a registered command and applies what it asks for: a notice or error row, composer text, the title edit, a message to send. */
async function runCommand(cmd: CommandInfo, args: string): Promise<void> {
  let res: CommandResult;
  try {
    res = (await rpc('commands.run', cmd.name, args)) ?? {};
  } catch (err) {
    res = { error: cleanError(err) };
  }
  if (typeof res.notice === 'string' && res.notice) addSystemMessage(res.notice, 'notice');
  if (typeof res.error === 'string' && res.error) addSystemMessage(res.error, 'error');
  if (typeof res.insert === 'string' && res.insert) {
    restoreComposerText(res.insert);
    if (!dialogOpen()) inputEl.focus();
  }
  if (res.editTitle === true) startTitleEdit();
  if (typeof res.send === 'string' && res.send.trim()) {
    const typed = inputEl.value;
    inputEl.value = res.send;
    commandSend = true;
    try {
      await sendComposer();
    } finally {
      commandSend = false;
    }
    // Whatever was in the composer before stays there.
    if (typed && !inputEl.value) restoreComposerText(typed);
  }
}

// Browser tools: an "Agent is browsing" pill while one runs, and the Browser tab comes forward.
const browsingTools = new Set<string>();
function clearBrowsing(): void {
  browsingTools.clear();
  browsingPill.hidden = true;
}

/** Tool calls that do not get a row (the plan and artifacts arrive as cards instead), with their arguments. */
const hiddenTools = new Map<string, unknown>();
const CARD_TOOLS = new Set(['submit_plan', 'create_artifact', ...PROPOSAL_TOOLS]);

function handleEvent(ev: AgentEvent, synthetic = false): void {
  switch (ev.type) {
    case 'run_start':
      setRunning(true);
      break;
    case 'user_message': {
      // A message typed here (or queued from here) already has its bubble; one from elsewhere gets one now, labelled.
      const shown = unframe(ev.origin, String(ev.text ?? ''));
      const label = originLabel(ev.origin, ev.from, shown.note);
      if (!label) break;
      finishThinking();
      endAssistant();
      addUserMessage(shown.text, [], null, { turn: ev.turn, originLabel: label, markdown: writtenByModel(ev.origin), folded: ev.origin === 'dream' });
      break;
    }
    case 'thinking_delta':
      setStatusText('Thinking…');
      appendThinking(ev.text);
      break;
    case 'thinking_done':
      finishThinking();
      break;
    case 'text_delta':
      setStatusText(currentMode() === 'plan' ? 'Planning…' : 'Responding…');
      finishThinking();
      appendAssistantText(ev.text);
      break;
    case 'text_done':
      endAssistant();
      break;
    case 'tool_start': {
      const id = ev.id ?? ev.name;
      if (CARD_TOOLS.has(ev.name)) {
        hiddenTools.set(id, ev.args);
        setStatusText(ev.name === 'submit_plan' ? 'Writing the plan…' : statusVerb(ev.name));
        break;
      }
      setStatusText(statusVerb(ev.name));
      if (ev.name.startsWith('browser_')) {
        browsingTools.add(id);
        browsingPill.hidden = false;
        if (paneVisible && paneTab !== 'browser') showPaneTab('browser');
      } else if (ev.name.startsWith('terminal_')) {
        // Same rule as the browser: a visible pane comes to the Terminal tab (without opening a shell of its own;
        // terminal_run opens the agent's tab); a hidden pane stays hidden.
        if (paneVisible && paneTab !== 'terminal') {
          terminalPane.holdAutoOpen();
          showPaneTab('terminal');
        }
        const tabId = asArgs(ev.args).tab_id;
        if (typeof tabId === 'string' || typeof tabId === 'number') terminalPane.select(String(tabId).trim());
      }
      addToolCard(ev.name, ev.args, ev.id);
      break;
    }
    case 'tool_end': {
      const id = ev.id ?? ev.name;
      if (hiddenTools.has(id)) {
        const args = hiddenTools.get(id);
        hiddenTools.delete(id);
        // A plan or artifact that could not be made is shown as a failed row, so the error is visible.
        const failed = !ev.ok || (ev.name === 'create_artifact' && /^\s*Error\b/.test(String(ev.result ?? '')));
        if (failed) finishToolCard({ ...ev, ok: false, id: undefined }, addToolCard(ev.name, args));
        // A dream's proposal is its card (dreaming.ts)
        else if (PROPOSAL_TOOLS.includes(ev.name) && !proposalEnded(ev.name, String(ev.result ?? ''), true)) finishToolCard({ ...ev, id: undefined }, addToolCard(ev.name, args));
        if (ev.name !== 'submit_plan') setStatusText(baseVerb());
        break;
      }
      if (browsingTools.delete(id)) browsingPill.hidden = browsingTools.size === 0;
      finishToolCard(ev);
      setStatusText(baseVerb());
      break;
    }
    case 'usage': {
      const prompt = Number(ev.promptTokens) || 0;
      const completion = Number(ev.completionTokens) || 0;
      runOutputTokens += completion;
      const context = prompt + completion;
      const limit = contextLimit();
      statusTokens.textContent = `${formatCount(context)} tokens`;
      statusTokens.dataset.tip = `Context ${formatCount(context)}${limit ? ` of ${formatCount(limit)}` : ''} · Output ${formatCount(runOutputTokens)} this run`;
      statusTokens.classList.toggle('near-limit', limit > 0 && context / limit >= 0.85);
      statusTokens.hidden = !running;
      break;
    }
    case 'hook_status':
      // A hook's statusMessage while it runs (one line; the status text never wraps)
      setStatusText(typeof ev.text === 'string' && ev.text.trim() ? ev.text.replace(/\s+/g, ' ').trim().slice(0, 120) : baseVerb());
      break;
    case 'approval_request':
      setStatusText('Waiting for approval');
      addApprovalCard(ev, synthetic);
      break;
    case 'question_request':
      setStatusText('Waiting for your answer');
      addQuestionCard(ev, synthetic);
      break;
    case 'question_resolved':
      // Answered here, on the phone, or ended by a stop: the card goes; the call's row shows the answers
      if (pendingQuestion?.id === ev.id) pendingQuestion.cancel();
      break;
    case 'approval_resolved':
      // Answered on the phone (or ended by a stop): the card on screen goes as if it had been answered here
      if (pendingApproval?.id === ev.id) {
        if (ev.interrupted) pendingApproval.cancel('Interrupted');
        else pendingApproval.resolved(ev.ok, ev.scope);
      }
      break;
    case 'plan_proposed':
      setStatusText('Plan ready for review');
      addPlanCard(ev.plan, { synthetic });
      scrollToBottom(true);
      if (!running) showPlanReady();
      break;
    case 'changes_updated':
      changesPane.updated(Number(ev.count));
      break;
    case 'context':
      contextMeter.set(normalizeContext(ev.context));
      break;
    case 'compact_start':
      startCompaction(ev.reason === 'auto' ? 'auto' : 'manual');
      break;
    case 'compact_end':
      endCompaction();
      if (ev.compaction && typeof ev.compaction === 'object') {
        addCompaction(ev.compaction);
        // Checkpoints in the folded part are gone and the kept ones were renumbered: read them back (a run does at its end).
        clearTurns();
        void syncTurns();
      } else if (ev.error) {
        compactErrorShown = true;
        addSystemMessage(String(ev.error), 'error');
      }
      break;
    case 'queue_delivered': {
      const msg = queueList.remove(ev.id);
      if (msg) {
        finishThinking();
        endAssistant();
        addUserMessage(msg.text ?? '', (Array.isArray(msg.attachments) ? msg.attachments : []).map(bubbleImage));
      }
      break;
    }
    case 'queue_dropped': {
      const msg = queueList.remove(ev.id);
      if (msg) returnToComposer([msg]);
      break;
    }
    case 'tasks_updated':
      showTasks(ev.tasks);
      break;
    case 'artifact':
      if (!ev.artifact?.id) break;
      addArtifactCard(ev.artifact, { updated: ev.action === 'updated' });
      // The main process has already shown the artifact in the browser view; bring the Browser tab forward.
      showPaneTab('browser');
      break;
    case 'error':
      addSystemMessage(ev.message, ev.kind === 'notice' ? 'notice' : 'error');
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|Could not reach|network/i.test(ev.message)) void checkConnection();
      break;
    case 'session_changed':
      onSessionChanged(ev.session);
      break;
    case 'run_end':
      finishThinking();
      endAssistant();
      pendingApproval?.cancel('Interrupted');
      pendingQuestion?.cancel();
      // An auto-compaction belongs to the run; its compact_end (if one still comes) only adds the divider or error.
      if (compacting && !compacting.standalone) {
        compacting = null;
        statusLine.classList.remove('compacting');
      }
      setRunning(false);
      endLiveRun();
      for (const card of toolCards.values()) {
        card.interrupt();
        settleRun(card.el);
      }
      toolCards.clear();
      hiddenTools.clear();
      clearBrowsing();
      if (ev.reason === 'aborted') addSystemMessage('Interrupted.');
      if (ev.reason === 'max_turns') addSystemMessage('Stopped: reached the max tool turns limit (raise it in Settings).');
      if (ev.reason === 'plan') showPlanReady();
      {
        // Queued messages normally come back through queue_dropped before this; anything still listed goes back too.
        const left = queueList.clear();
        if (left.length) returnToComposer(left);
      }
      if (!dialogOpen() && !titleEditing && !isTextField(document.activeElement)) inputEl.focus();
      // The messages of this run now have checkpoints (a debug run_end renders only)
      if (!synthetic) void syncTurns();
      break;
  }
}
/** Set from a switch's transcript until its LiveState is applied: the session's events wait here meanwhile */
let syncing: { id: string; buffer: AgentEvent[] } | null = null;

function statusOf(id: string): SessionStatus {
  return statuses.get(id) ?? sessions.find((m) => m.id === id)?.status ?? { running: false };
}

/** Keeps the sidebar's status of a session current from its events (the main process's next list push confirms it). */
function trackStatus(id: string, ev: AgentEvent, onScreen: boolean): void {
  const before = statusOf(id);
  let next: SessionStatus | null = null;
  if (ev.type === 'run_start') next = { running: true, unread: onScreen ? undefined : before.unread };
  else if (ev.type === 'run_end') next = { running: false, attention: ev.reason === 'plan' ? 'plan' : undefined, unread: onScreen ? undefined : true };
  else if (ev.type === 'approval_request') next = { ...before, attention: 'approval' };
  else if (ev.type === 'approval_resolved' && before.attention === 'approval') next = { ...before, attention: undefined };
  else if (ev.type === 'question_request') next = { ...before, attention: before.attention === 'approval' ? 'approval' : 'question' };
  else if (ev.type === 'question_resolved' && before.attention === 'question') next = { ...before, attention: undefined };
  if (!next) return;
  statuses.set(id, next);
  renderSessionList();
}

oc.onAgentEvent((ev, sessionId) => {
  const id = typeof sessionId === 'string' && sessionId ? sessionId : currentSessionId;
  const onScreen = id === currentSessionId;
  bus.emit('agent-event', ev, id, onScreen);
  trackStatus(id, ev, onScreen);
  if (syncing && syncing.id === id) {
    syncing.buffer.push(ev);
    return;
  }
  if (onScreen) handleEvent(ev);
  else if (ev.type === 'session_changed') onSessionChanged(ev.session);
});

// ---------- Composer ----------

// @ file mentions: the picker searches the working directory (oc.files.search, or the debug mock).
let debugFiles: FileHit[] | null = null;

function searchFiles(query: string, limit: number): Promise<FileHit[]> | null {
  if (debugFiles) return Promise.resolve(debugFiles.slice(0, limit));
  const api = oc.files;
  return api && typeof api.search === 'function' ? api.search(query, limit) : null;
}

const mentionPicker = createMentionPicker({
  input: inputEl,
  menu: mentionMenu,
  search: searchFiles,
  // Only one menu at a time above the composer.
  onOpen: () => hideSlashMenu(),
  onInsert: (hit) => pickedPaths.add(normalizeMention(hit.path)),
});

function autosize(): void {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(240, Math.max(44, inputEl.scrollHeight))}px`;
  updateSendButton();
}

// The bar is as tall as its text: a change of width (a pane opened or closed, the window resized) can rewrap it.
{
  let width = 0;
  new ResizeObserver(() => {
    if (inputEl.clientWidth === width) return;
    width = inputEl.clientWidth;
    autosize();
  }).observe(inputEl);
}

/** ⌘↑ / ⌘↓: the messages sent in this session (the user bubbles on screen), newest first, then back to the draft */
const composerHistory = createComposerHistory({
  input: inputEl,
  entries: () => [...messagesEl.querySelectorAll<HTMLElement>(':scope > .msg.user')].map((el) => userTextByMessage.get(el) ?? ''),
  onRecall: () => {
    hideSlashMenu();
    mentionPicker.close();
    autosize();
    if (statusState === 'plan-wait') statusHint.hidden = composerHasContent();
  },
});

sendBtn.onclick = () => (running && !composerHasContent() ? void oc.abort() : void send());
stopBtn.onclick = () => void oc.abort();
$('composer').addEventListener('mousedown', (e) => {
  const t = e.target as HTMLElement;
  if (t === e.currentTarget || t.classList.contains('composer-row') || t.id === 'attachments') {
    e.preventDefault();
    inputEl.focus();
  }
});
inputEl.addEventListener('input', () => {
  autosize();
  mentionPicker.sync();
  void updateSlashMenu();
  if (statusState === 'plan-wait') statusHint.hidden = composerHasContent();
});
inputEl.addEventListener('blur', () =>
  setTimeout(() => {
    hideSlashMenu();
    if (document.activeElement !== inputEl) mentionPicker.close();
  }, 150),
);
// The picker follows the caret within its token and closes once the caret leaves it.
const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
inputEl.addEventListener('keyup', (e) => {
  if (CARET_KEYS.has(e.key)) mentionPicker.follow();
});
inputEl.addEventListener('click', () => mentionPicker.follow());
inputEl.addEventListener('keydown', (e) => {
  // ↑ ↓ ↵ Tab Esc go to the @ picker while it shows rows; otherwise Enter sends as usual.
  if (mentionPicker.handleKey(e)) return;
  // ⌘↑ / ⌘↓ on the first / last line walk the sent messages (also while the slash menu shows)
  if (composerHistory.handleKey(e)) return;
  if (!slashMenu.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSlashSelection(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      acceptSlashSelection();
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      hideSlashMenu();
      return;
    }
  }
  if (e.key === '?' && composerEmpty() && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    openShortcuts();
    return;
  }
  if (e.key === 'Backspace' && !inputEl.value && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
    const items = tray.items();
    if (items.length) {
      e.preventDefault();
      tray.remove(items[items.length - 1].id);
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
});

// ---------- Image attachments: paste, drop (below) and the paperclip ----------

/** Adds images to the composer; problems show next to the paperclip. */
async function attachImages(inputs: ImageInput[]): Promise<AddResult> {
  const res = await tray.add(inputs);
  if (res.errors.length) showInlineError(attachBtn, res.errors.length > 1 ? `${res.errors[0]} (+${res.errors.length - 1} more)` : res.errors[0]);
  return res;
}

/** Chrome names a raw clipboard bitmap "image.png"; files copied in Finder keep their own names. */
function pastedName(file: File): string {
  const name = file.name.trim();
  return !name || /^image\.(?:png|jpe?g|gif|webp)$/i.test(name) ? 'Pasted image' : name;
}

function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  let files = [...data.files];
  if (!files.length) {
    files = [...data.items]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
  }
  return files.filter((f) => imageType(f) !== '');
}

inputEl.addEventListener('paste', (e) => {
  const images = clipboardImages(e.clipboardData);
  if (!images.length) return;
  e.preventDefault();
  void attachImages(images.map((f) => ({ blob: f, name: pastedName(f) })));
});

attachBtn.onclick = () => attachInput.click();
attachInput.addEventListener('change', () => {
  const files = [...(attachInput.files ?? [])];
  attachInput.value = '';
  if (files.length) void attachImages(files.map((f) => ({ blob: f, name: f.name || 'Image' })));
  inputEl.focus();
});

// The vision note: shown while images are attached and the configured model cannot see them.
const capsCache = new Map<string, ModelCapabilities>();
const capsInFlight = new Map<string, Promise<ModelCapabilities | null>>();
let visionCheck = 0;

function currentModel(): string {
  return activeProvider(config).model;
}

function fetchCapabilities(key: string): Promise<ModelCapabilities | null> {
  let p = capsInFlight.get(key);
  if (!p) {
    p = (async () => {
      try {
        if (typeof oc.modelCapabilities !== 'function') return null;
        const caps = await oc.modelCapabilities();
        if (!caps || typeof caps !== 'object') return null;
        // Filed under the model the answer is about (the config may have changed meanwhile).
        capsCache.set(caps.provider && caps.model ? `${caps.provider}|${caps.model}` : key, caps);
        return caps;
      } catch {
        return null; // not cached: asked again next time
      } finally {
        capsInFlight.delete(key);
      }
    })();
    capsInFlight.set(key, p);
  }
  return p;
}

async function refreshVisionNote(): Promise<void> {
  const my = ++visionCheck;
  if (!config || (!tray.items().length && !tray.pending())) {
    attachNote.hidden = true;
    return;
  }
  const key = `${config.provider}|${currentModel()}`;
  const caps = capsCache.get(key) ?? (await fetchCapabilities(key));
  if (my !== visionCheck) return;
  if (caps?.vision !== false || `${config.provider}|${currentModel()}` !== key) {
    attachNote.hidden = true;
    return;
  }
  const model = caps.model || currentModel() || 'This model';
  attachNote.innerHTML =
    `${icon('triangle-alert', 14)}<span>${escapeHtml(model)} can't see images. Switch to a vision model such as llava, qwen2.5vl or gemma3 in ` +
    `<button type="button" class="link-btn">Settings</button>.</span>`;
  attachNote.querySelector<HTMLButtonElement>('.link-btn')!.onclick = () => openSettings();
  attachNote.hidden = false;
}

// ---------- Image lightbox ----------

function openLightbox(src: string, name?: string, caption?: string): void {
  if (!src || dialogOpen()) return;
  closeMenu();
  lightboxImg.src = src;
  lightboxImg.alt = name || 'Attached image';
  lightboxCaption.textContent = caption || name || '';
  lightboxCaption.hidden = !lightboxCaption.textContent;
  oc.browser.setVisible(false);
  lightbox.showModal();
  lightbox.focus({ preventScroll: true });
}
$('lightbox-close').onclick = () => lightbox.close();
// A click anywhere but on the image closes it (the backdrop counts as the dialog itself).
lightbox.addEventListener('click', (e) => {
  if (e.target !== lightboxImg) lightbox.close();
});
lightbox.addEventListener('close', () => {
  lightboxImg.removeAttribute('src');
  syncBrowserView();
});

// ---------- Queue ----------

/** The queue floats above the status line; the transcript leaves room for it so the last message stays visible. */
function syncQueueHeight(): void {
  const h = queueEl.hidden ? 0 : Math.ceil(queueEl.getBoundingClientRect().height);
  transcriptWrap.style.setProperty('--queue-h', `${h}px`);
  if (stick) scrollToBottom();
}
new ResizeObserver(() => syncQueueHeight()).observe(queueEl);

/** ⌘F: the sidebar's Search row turns into the field (the sidebar opens first when collapsed). */
function focusSearch(): void {
  sidebarView?.openSearch();
}

// Esc Esc between runs opens the rewind confirmation. Every Esc is seen here first; only the ones that reach the
// shortcut handler below unused count, so an Esc that closed a menu or answered a card in between breaks the pair.
const escEsc = createDoublePress(600);
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape') escEsc.saw(e.timeStamp);
    else if (e.key !== 'Shift' && e.key !== 'Meta' && e.key !== 'Control' && e.key !== 'Alt') escEsc.reset();
  },
  true,
);

/** An Esc that can be half of Esc Esc: a plain press, nothing running, no dialog or menu open, no card waiting for an answer. */
function escCounts(e: KeyboardEvent): boolean {
  return (
    !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing && !e.defaultPrevented &&
    !running && compacting === null && !rewinding && !pendingApproval && !pendingQuestion && !titleEditing && !dialogOpen() && !isMenuOpen() && !pageOpen()
  );
}

// ⌘⇧C copies the last reply's Markdown (what its Copy button copies) and says so in the status area.
let flashTimer: number | undefined;

/** A short tooltip in the status area above the composer (#status-flash, also announced to screen readers). */
function flashStatus(text: string, iconName: IconName = 'check'): void {
  statusFlash.innerHTML = `${icon(iconName, 14)}<span>${escapeHtml(text)}</span>`;
  statusFlash.classList.add('show');
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => statusFlash.classList.remove('show'), 1200);
}

async function copyLastReply(): Promise<void> {
  const msg = [...messagesEl.querySelectorAll<HTMLElement>(':scope > .msg.assistant')].pop();
  const text = msg ? assistantText(msg) : '';
  if (!text.trim()) return flashStatus('No reply to copy yet', 'info');
  if (await writeClipboard(text)) flashStatus('Copied');
  else flashStatus("Couldn't copy the reply", 'circle-alert');
}

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  // In a terminal, Esc and Ctrl combinations belong to the shell (xterm sends them on); ⌘ shortcuts still work.
  const inTerminal = terminalPane.hasFocus();
  if (inTerminal && (e.key === 'Escape' || (e.ctrlKey && !e.metaKey))) return;
  // On a page the session is not on screen: Esc does not stop its run
  if (e.key === 'Escape' && (running || compacting?.standalone) && !pendingApproval && !pendingQuestion && !isMenuOpen() && !dialogOpen() && !pageOpen()) {
    void oc.abort();
  } else if (e.key === 'Escape') {
    if (escCounts(e) && escEsc.counts()) {
      e.preventDefault();
      rewindLatest();
    }
  } else if (e.key === 'Tab' && e.shiftKey && document.activeElement === inputEl) {
    e.preventDefault();
    void toggleMode();
  } else if (e.key === 'F2' && !meta) {
    if (pageOpen()) return;
    e.preventDefault();
    startTitleEdit();
  } else if (!meta) {
    return;
  } else if (k === 'n' && !e.shiftKey) {
    e.preventDefault();
    void newSession();
  } else if (k === 'b' && !e.shiftKey) {
    e.preventDefault();
    toggleSidebar();
  } else if (k === 'b' && e.shiftKey) {
    e.preventDefault();
    togglePane('browser');
  } else if (k === 'c' && e.shiftKey) {
    if (dialogOpen()) return;
    e.preventDefault();
    void copyLastReply();
  } else if (k === 'd' && e.shiftKey) {
    e.preventDefault();
    togglePane('diff');
  } else if (k === 't' && e.shiftKey) {
    e.preventDefault();
    toggleTerminal();
  } else if (k === 't') {
    e.preventDefault();
    openNewTerminal();
  } else if (e.key === ',') {
    e.preventDefault();
    openSettings();
  } else if (e.key === '/' || e.key === '?') {
    e.preventDefault();
    openShortcuts();
  } else if (k === 'k') {
    e.preventDefault();
    if (inTerminal) terminalPane.clearActive();
    else {
      closeMenu();
      inputEl.focus();
    }
  } else if (k === 'f' && !e.shiftKey) {
    e.preventDefault();
    focusSearch();
  }
});

function currentMode(): PermissionMode {
  return modeOf(config);
}

/** Posts the "Permission mode: …" notice when the mode differs from `before`. */
function announceMode(before: PermissionMode): void {
  const now = currentMode();
  if (now === before) return;
  if (now !== 'plan' && basePlaceholder === KEEP_PLACEHOLDER) setBasePlaceholder(DEFAULT_PLACEHOLDER);
  addSystemMessage(`Permission mode: ${MODES[now].label}. ${MODES[now].hint}.`, 'notice');
}

async function setMode(mode: PermissionMode): Promise<void> {
  const before = currentMode();
  try {
    config = await oc.setConfig({ ...config, permissionMode: mode, autoApprove: mode === 'bypass' });
  } catch (err) {
    showInlineError(modeBtn, `Couldn't change the mode: ${cleanError(err)}`);
    return;
  }
  applyConfigToUi();
  if (currentMode() !== mode) showInlineError(modeBtn, `${MODES[mode].label} needs the updated app. Restart Silo Harness and try again.`);
  if (currentMode() === 'bypass') pendingApproval?.allow();
  announceMode(before);
}

async function toggleMode(): Promise<void> {
  await setMode(nextMode(currentMode()));
}

modeBtn.onclick = () => {
  if (menuAnchoredTo(modeBtn)) return closeMenu();
  const mode = currentMode();
  const item = (m: PermissionMode): MenuItem => {
    const info = MODES[m];
    return {
      label: info.label,
      description: info.desc,
      icon: info.icon,
      // Neutral icons, as Claude Code's menus; Bypass keeps its red words
      danger: m === 'bypass',
      checked: m === mode,
      onSelect: () => {
        inputEl.focus();
        if (m !== currentMode()) void setMode(m);
      },
    };
  };
  openMenu([{ label: 'Permission mode', items: MODE_CYCLE.map(item) }, { items: [item('bypass')] }], {
    anchor: modeBtn,
    placement: 'top-start',
    boundary: transcriptWrap,
    minWidth: 300,
    className: 'mode-menu',
    footer: '<kbd>⇧</kbd><kbd>Tab</kbd><span>cycles every mode except Bypass</span>',
  });
};

async function setModel(model: string, name = activeProvider(config).name): Promise<void> {
  try {
    await rpc('providers.setModel', name, model);
    config = await oc.getConfig();
  } catch (err) {
    // An older main process (no such method): only the Ollama block's model could be chosen here
    if (!/No handler registered|Unknown (?:RPC )?method/i.test(String((err as Error)?.message ?? err))) {
      showInlineError(modelBtn, `Couldn't choose ${model}: ${cleanError(err)}`);
      return;
    }
    config = await oc.setConfig({ ...config, ollama: { ...config.ollama, model } });
  }
  applyConfigToUi();
  inputEl.focus();
  void refreshContext();
}

/** Makes another provider the one in use (from the model menu). */
async function useProvider(name: string): Promise<void> {
  config = await oc.setConfig({ ...config, provider: name });
  applyConfigToUi();
  inputEl.focus();
  void refreshContext();
}

modelBtn.onclick = async () => {
  if (menuAnchoredTo(modelBtn)) return closeMenu();
  const settingsItem: MenuItem = { label: 'Settings…', icon: 'settings', hint: '⌘,', onSelect: () => openSettings('provider') };
  const opts = { anchor: modelBtn, placement: 'top-start' as const, boundary: transcriptWrap, minWidth: 260 };
  const active = activeProvider(config);
  const current = active.model;
  // The other providers that could be used as they are
  const others = allProviders(config).filter((p) => p.name !== active.name && !p.error);
  const switchSection = (): MenuSection[] => (others.length ? [{ label: 'Provider', items: others.map((p) => ({ label: p.label, hint: p.model, onSelect: () => void useProvider(p.name) })) }] : []);
  const section = (models: string[], note?: string): MenuSection => ({
    label: active.label,
    items: models.map((m) => ({ label: m, checked: m === current, onSelect: () => void (m === current ? inputEl.focus() : setModel(m, active.name)) })),
    note,
  });
  const sections = (models: string[], note?: string) => [section(models, note), ...switchSection(), { items: [settingsItem] }];
  const own = [...new Set([...(current ? [current] : []), ...active.models])];
  const menu = openMenu(sections(own, active.type === 'ollama' ? 'Loading models…' : active.models.length ? undefined : 'Loading models…'), opts);
  try {
    const models = active.type === 'ollama' ? await oc.listOllamaModels() : await rpc('providers.models', active.name);
    if (!menuAnchoredTo(modelBtn)) return;
    const list = [...new Set([...(current ? [current] : []), ...models])];
    const none = active.type === 'ollama' ? 'No local models. Try: ollama pull qwen3:8b' : 'The service listed no models.';
    menu.update(sections(list, models.length ? undefined : none));
  } catch {
    if (!menuAnchoredTo(modelBtn)) return;
    const note = active.type === 'ollama' ? 'Could not reach Ollama. Is it running? Start it with: ollama serve' : active.error ?? (own.length ? undefined : 'This service does not list its models; set one in Settings.');
    menu.update(sections(own, note));
  }
};

// ---------- Header / config ----------

/** "~/Documents/silo-harness"; long paths keep the root and the last two folders: "~/…/audit/playground". */
function shortPath(p: string): string {
  const home = tilde(p);
  if (home.length <= 40) return home;
  const parts = home.split('/');
  return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-2).join('/')}` : home;
}

let lastToolActivity: boolean | undefined;

function applyConfigToUi(): void {
  const active = activeProvider(config);
  const model = active.model;
  // Under the chat bar: the model in the text colour, then a muted word when there is one worth saying
  const sub = config.provider === 'ollama' && config.ollama.think === 'on' ? 'Thinking' : '';
  modelBtn.innerHTML = `<span class="foot-label">${escapeHtml(model || 'Choose a model')}</span>${sub ? `<span class="foot-sub">${sub}</span>` : ''}`;
  modelBtn.dataset.tip = `${active.label} · ${active.baseURL}`;
  modelBtn.dataset.provider = active.name;
  const mode = currentMode();
  const info = MODES[mode];
  modeBtn.innerHTML = `<span class="foot-label">${escapeHtml(info.short)}</span>`;
  modeBtn.dataset.tip = `${info.label}: ${info.desc}`;
  modeBtn.dataset.mode = mode;
  modeBtn.setAttribute('aria-label', `Permission mode: ${info.label}`);
  for (const c of MODE_CHIP_CLASSES) modeBtn.classList.toggle(c, c === info.chipClass);
  cwdLabel.textContent = shortPath(config.workingDirectory);
  cwdBtn.dataset.tip = `${config.workingDirectory} · click to change`;
  setToolCwd(config.workingDirectory);
  setDiffBaseDir(config.workingDirectory);
  renderRecent();
  document.documentElement.dataset.theme = config.theme === 'system' ? '' : config.theme;
  // Tool activity: Summary or Every call; the conversation on screen folds again when it changes
  if (lastToolActivity !== undefined && lastToolActivity !== summaryMode()) refoldAll();
  lastToolActivity = summaryMode();
  const connKey = `${config.provider}|${active.baseURL}|${active.model}|${active.error ?? ''}`;
  if (connKey !== lastConnKey) {
    lastConnKey = connKey;
    void checkConnection();
  }
  // The folder line follows the working directory; the provider decides which lines can show at all.
  syncConnection();
  void refreshVisionNote();
  bus.emit('config', config);
}

/**
 * The main process changed the config (another feature, a folder that followed a session, an approval that switched
 * the mode): the window follows the way a Settings save does.
 */
onPush('config:changed', (next) => {
  if (!next || typeof next !== 'object') return;
  const prev = config;
  config = next;
  applyConfigToUi();
  if (prev && prev.workingDirectory !== next.workingDirectory) void changesPane.refresh();
  void refreshContext();
});

// ---------- Provider connection: the banner above the composer and the welcome screen's setup strip ----------

const connBanner = $('conn-banner');
const connText = $('conn-text');
let lastConnKey = '';
let connCheck = 0;
/** What the last finished check found about Ollama (null before the first one, and with Portkey) */
let ollamaHealth: { reachable: boolean; models: string[] } | null = null;
/** The banner's text while Ollama is unreachable or the configured model is missing; null when fine */
let connProblem: string | null = null;

/**
 * Asks Ollama for its models. Unreachable, or the configured model not downloaded: a banner above the composer
 * (silent otherwise). The same answer drives the setup strip, which takes the banner's place on the welcome screen.
 */
async function checkConnection(): Promise<void> {
  const my = ++connCheck;
  if (!usesOllama(config)) {
    ollamaHealth = null;
    connProblem = null;
    syncConnection();
    return;
  }
  let models: string[] | null;
  try {
    const list = await oc.listOllamaModels();
    models = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    models = null;
  }
  if (my !== connCheck) return;
  const m = activeProvider(config).model;
  if (models) {
    ollamaHealth = { reachable: true, models };
    connProblem = m && models.length && !hasModel(models, m) ? `Ollama is running, but ${m} is not downloaded. Run: ollama pull ${m}` : null;
  } else {
    ollamaHealth = { reachable: false, models: [] };
    connProblem = `Can't reach Ollama at ${activeProvider(config).baseURL.replace(/\/v1\/?$/, '')}. Start it with "ollama serve", then retry.`;
  }
  syncConnection();
}
$('conn-retry').onclick = () => void checkConnection();
$('conn-settings').onclick = () => openSettings();

/** How long "Start Ollama" waits for Ollama to answer before the line offers the button again */
const START_WAIT_MS = 20_000;
/** The last "Start Ollama" ran out of time without an answer */
let ollamaStartFailed = false;
/** The debug hook's checks, shown instead of the real ones */
let debugSetup: SetupChecks | null = null;
let setupTimer: number | undefined;

const setupStrip = createSetupStrip({
  root: setupEl,
  onAction: (id, button) => void setupAction(id, button),
});

/** Which checks pass: the debug hook's, or the real ones (unknown counts as fine, so nothing flashes before the first answer). */
function setupChecks(): SetupChecks {
  if (debugSetup) return debugSetup;
  const folder = !isHomeFolder(config.workingDirectory);
  const h = usesOllama(config) ? ollamaHealth : null;
  return { ollama: !h || h.reachable, model: !h || !h.reachable || hasModel(h.models, activeProvider(config).model), folder };
}

function ollamaLine(): SetupLine {
  const base = activeProvider(config).baseURL;
  const address = ollamaAddress(base);
  // Ollama on another machine cannot be started from here: the fix is the address.
  if (!isLocalOllama(base)) return { id: 'ollama', icon: 'server', title: "Can't reach Ollama", detail: address, action: 'Open settings', actionTip: 'Check the Ollama address' };
  if (ollamaStartedAt) return { id: 'ollama', icon: 'server', title: 'Starting Ollama…', detail: address, action: 'Starting…', busy: true };
  const command = ollamaServeCommand(base);
  const title = ollamaStartFailed ? "Ollama isn't answering yet" : "Ollama isn't running";
  const detail = ollamaStartFailed ? 'see the Terminal tab' : address;
  // Without the app's terminal the line shows the command to run instead.
  if (!terminalSource()) return { id: 'ollama', icon: 'server', title, detail, action: 'Start Ollama', command, commandNote: 'Run it in a terminal; this line goes away once Ollama answers.' };
  return { id: 'ollama', icon: 'server', title, detail, action: 'Start Ollama', actionTip: `Runs ${command} in a new terminal tab` };
}

function modelLine(): SetupLine {
  const model = activeProvider(config).model.trim();
  const models = ollamaHealth?.reachable ? ollamaHealth.models : [];
  if (!model && models.length) {
    return { id: 'model', icon: 'download', title: 'No model selected', detail: `${models.length} downloaded`, action: 'Choose model', actionTip: 'Pick one of your downloaded models' };
  }
  return {
    id: 'model',
    icon: 'download',
    title: model ? `${model} isn't downloaded` : 'No model downloaded yet',
    action: 'Pull a model',
    command: pullCommand(model),
    commandNote: 'Run it in a terminal; this line goes away once the download is done.',
  };
}

/** The strip's lines: Ollama and the model only with the Ollama provider, the folder line with either. */
function setupLines(): SetupLine[] {
  const checks = setupChecks();
  const lines: SetupLine[] = [];
  const active = activeProvider(config);
  if (active.type === 'ollama') {
    if (!checks.ollama) lines.push(ollamaLine());
    if (!checks.model) lines.push(modelLine());
  } else if (active.error && !debugSetup) {
    // Any other provider: what stands in the way (no key, no model), with Settings at hand
    lines.push({ id: 'provider', icon: active.key === 'missing' ? 'plug' : 'settings', title: active.key === 'missing' ? `${active.label} needs a key` : `No model set for ${active.label}`, detail: active.key === 'missing' ? active.keySource : undefined, action: 'Open settings', actionTip: active.error });
  }
  if (!checks.folder) lines.push({ id: 'folder', icon: 'folder', title: 'Working in your home folder', action: 'Choose folder', actionTip: 'Choose the project folder Silo Harness works in' });
  return lines;
}

/** After a check, a config change, the welcome screen showing or hiding, or the debug hook: the strip, the banner, the next check. */
function syncConnection(): void {
  if (!config) return;
  if (ollamaStartedAt) {
    const answered = !usesOllama(config) || ollamaHealth?.reachable === true;
    if (answered || Date.now() - ollamaStartedAt > START_WAIT_MS) {
      ollamaStartFailed = !answered;
      ollamaStartedAt = 0;
      syncSpin();
    }
  }
  if (ollamaHealth?.reachable) ollamaStartFailed = false;
  setupStrip.render(setupLines());
  // On the welcome screen the strip says it with a fix at hand; the banner returns once the conversation starts.
  const covered = !emptyState.hidden && setupStrip.lines().some((id) => id !== 'folder');
  connText.textContent = connProblem ?? '';
  connBanner.hidden = !connProblem || covered;
  scheduleSetupCheck();
}

/** While the welcome screen shows an Ollama line, Ollama is asked again (every 5s, every second while it starts), so the line goes once fixed. */
function scheduleSetupCheck(): void {
  window.clearTimeout(setupTimer);
  setupTimer = undefined;
  const watching = !debugSetup && usesOllama(config) && !emptyState.hidden && setupStrip.lines().some((id) => id !== 'folder');
  if (!watching && !ollamaStartedAt) return;
  setupTimer = window.setTimeout(
    () => {
      setupTimer = undefined;
      if (ollamaStartedAt || document.visibilityState === 'visible') void checkConnection();
      else scheduleSetupCheck();
    },
    ollamaStartedAt ? 1000 : 5000,
  );
}
// The welcome screen shows or hides (addNode sets hidden on every new node, so only real changes count).
let welcomeShown = !emptyState.hidden;
new MutationObserver(() => {
  if (welcomeShown === !emptyState.hidden) return;
  welcomeShown = !emptyState.hidden;
  syncConnection();
}).observe(emptyState, { attributes: true, attributeFilter: ['hidden'] });
// Back from a terminal where Ollama was started or a model pulled: check right away.
window.addEventListener('focus', () => {
  if (!config || debugSetup || !usesOllama(config) || emptyState.hidden) return;
  if (setupStrip.lines().some((id) => id !== 'folder')) void checkConnection();
});

async function setupAction(id: SetupId, button: HTMLButtonElement): Promise<void> {
  if (id === 'folder') {
    if ((await chooseFolder()) && !dialogOpen()) inputEl.focus();
  } else if (id === 'model') {
    // "Choose model" (a pull shows its command instead): the model chip's menu
    modelBtn.click();
  } else if (id === 'provider') openSettings('provider');
  else if (!isLocalOllama(activeProvider(config).baseURL)) openSettings(config.provider === 'ollama' ? 'ollama-baseURL' : 'provider');
  else await startOllama(button);
}

/** "Start Ollama": `ollama serve` in a new terminal tab (the Terminal pane comes forward), then Ollama is asked every second until it answers. */
async function startOllama(button: HTMLButtonElement): Promise<void> {
  const term = terminalSource();
  if (!term || ollamaStartedAt) return;
  const command = ollamaServeCommand(activeProvider(config).baseURL);
  showPaneTab('terminal');
  const id = await terminalPane.newTab();
  if (!id) {
    showInlineError(button, `Couldn't open a terminal. Run ${command} yourself, then come back.`);
    return;
  }
  try {
    term.write(id, `${command}\r`);
  } catch (err) {
    showInlineError(button, `Couldn't start Ollama: ${cleanError(err)}`);
    return;
  }
  ollamaStartedAt = Date.now();
  ollamaStartFailed = false;
  syncSpin();
  syncConnection();
}

/**
 * After the working directory changed (the picker, a recent project): the top bar, the setup strip and the recent
 * row follow. In an empty session they show the change; a notice would replace the welcome screen.
 */
function folderChanged(dir: string): void {
  applyConfigToUi();
  if (emptyState.hidden) addSystemMessage(`Working directory set to ${dir}`, 'notice');
}

/** The working-directory picker (the top bar's folder and the setup strip's "Choose folder"). */
async function chooseFolder(): Promise<boolean> {
  let dir: string | null;
  try {
    dir = await oc.chooseDirectory();
  } catch (err) {
    showInlineError(cwdBtn, `Couldn't change the folder: ${cleanError(err)}`);
    return false;
  }
  if (!dir) return false;
  config = await oc.getConfig();
  folderChanged(dir);
  return true;
}
cwdBtn.onclick = () => void chooseFolder();

// ---------- Recent projects: the welcome screen's row of folders used before (AppConfig.recentDirs) ----------

/** The debug hook's folders, shown instead of config.recentDirs */
let debugRecent: string[] | null = null;

const recentRow = createRecentRow({ root: $('recent-dirs'), onPick: (dir, chip) => switchFolder(dir, chip) });

/** The row: config.recentDirs (or the debug hook's folders) without the current working directory; hidden when empty. */
function renderRecent(): void {
  if (!config) return;
  recentRow.render(recentChoices(debugRecent ?? config.recentDirs, config.workingDirectory));
}

/**
 * A recent project's chip: the working directory switches to it the way the picker does (setConfig, then the same
 * refresh; no notice in an empty session). The main process puts the folder it switched to first in recentDirs and
 * drops folders that no longer exist, so when it is not first the folder is gone: the previous one comes back.
 */
async function switchFolder(dir: string, chip: HTMLButtonElement): Promise<void> {
  const prev = config.workingDirectory;
  if (dir === prev) return;
  let next: AppConfig;
  try {
    next = await oc.setConfig({ ...config, workingDirectory: dir });
  } catch (err) {
    showInlineError(chip, `Couldn't switch to ${dirName(dir)}: ${cleanError(err)}`);
    return;
  }
  if (Array.isArray(next?.recentDirs) && next.recentDirs[0] !== dir) {
    showInlineError(chip, `Can't find ${shortPath(dir)}. It may have been moved or deleted.`);
    try {
      next = await oc.setConfig({ ...next, workingDirectory: prev });
    } catch {
      /* the top bar shows where the agent works now */
    }
    config = next;
    applyConfigToUi();
    return;
  }
  config = next;
  folderChanged(dir);
  // The picker's change reaches the context meter through a context event; this one asks
  void refreshContext();
  // The chip is gone (it is the working directory now): on to the first message, as after "Choose folder"
  if (!dialogOpen()) inputEl.focus();
}

/** Keeps the native browser view glued to its slot while something animates the layout. */
function trackBounds(ms: number): void {
  const end = performance.now() + ms;
  const step = () => {
    reportBounds();
    if (performance.now() < end) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function toggleSidebar(): void {
  shell.classList.toggle('sidebar-collapsed');
  try {
    localStorage.setItem('sidebar', shell.classList.contains('sidebar-collapsed') ? 'collapsed' : 'open');
  } catch {
    /* ignore */
  }
  trackBounds(260);
}
$('sidebar-toggle').onclick = toggleSidebar;


// Inline title editing (click or F2; Enter saves, Escape cancels)
let titleEditing = false;

function setTitle(text: string): void {
  if (!titleEditing) sessionTitle.textContent = text;
  document.title = text && text !== 'New session' ? `${text} — Silo Harness` : 'Silo Harness';
}

async function renameSession(id: string, title: string, anchor: HTMLElement): Promise<boolean> {
  try {
    if (typeof oc.sessions.rename !== 'function') throw new Error('No handler registered');
    const meta = await oc.sessions.rename(id, title);
    const i = sessions.findIndex((s) => s.id === id);
    if (i >= 0) sessions[i] = meta;
    if (id === currentSessionId) setTitle(meta.title);
    renderSessionList();
    return true;
  } catch (err) {
    showInlineError(anchor, `Couldn't rename: ${cleanError(err)}`);
    return false;
  }
}

function startTitleEdit(): void {
  if (titleEditing || !currentSessionId) return;
  titleEditing = true;
  const original = sessionTitle.textContent ?? '';
  sessionTitle.contentEditable = 'plaintext-only';
  sessionTitle.classList.add('editing');
  sessionTitle.focus();
  const range = document.createRange();
  range.selectNodeContents(sessionTitle);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const finish = async (save: boolean) => {
    if (!titleEditing) return;
    titleEditing = false;
    sessionTitle.removeEventListener('keydown', onKey);
    sessionTitle.removeEventListener('blur', onBlur);
    sessionTitle.contentEditable = 'false';
    sessionTitle.classList.remove('editing');
    sessionTitle.scrollLeft = 0;
    const next = (sessionTitle.textContent ?? '').replace(/\s+/g, ' ').trim();
    sessionTitle.textContent = original;
    if (!save || !next || next === original) return;
    sessionTitle.textContent = next;
    const ok = await renameSession(currentSessionId, next, sessionTitle);
    if (!ok) sessionTitle.textContent = original;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void finish(true);
      inputEl.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void finish(false);
      inputEl.focus();
    }
  };
  const onBlur = () => void finish(true);
  sessionTitle.addEventListener('keydown', onKey);
  sessionTitle.addEventListener('blur', onBlur);
}
sessionTitle.addEventListener('click', () => startTitleEdit());
sessionTitle.addEventListener('keydown', (e) => {
  if (!titleEditing && e.key === 'Enter') {
    e.preventDefault();
    startTitleEdit();
  }
});

// ---------- Sessions ----------

/** The sidebar's list (sidebar.ts); set up under // [feature:sidebar]. */
let sidebarView: SidebarView | null = null;
/** The pages in the main column (pages.ts); set up under // [feature:pages]. */
let pagesView: PagesView | null = null;

function renderSessionList(): void {
  sidebarView?.render();
}

/** Re-reads the session list; returns the meta of the session on screen. */
async function refreshSessions(): Promise<SessionMeta | null> {
  const [list, current] = await Promise.all([oc.sessions.list(), oc.sessions.current()]);
  applySessionList(list, current);
  return sessions.find((m) => m.id === currentSessionId) ?? null;
}

/**
 * Takes a session list from the main process (a refresh or a 'sessions:changed' push). The session on screen stays
 * the one this window shows (a list that was read before a switch must not switch back); `current` only seeds it at
 * start-up and stands in for it while it has no messages yet (the store lists those only once they have some).
 */
function applySessionList(list: SessionMeta[], current?: SessionMeta | null): void {
  if (!Array.isArray(list)) return;
  if (!currentSessionId && current) currentSessionId = current.id;
  const mine = list.find((m) => m.id === currentSessionId) ?? (current?.id === currentSessionId ? current : sessions.find((m) => m.id === currentSessionId));
  sessions = mine && !list.some((m) => m.id === mine.id) ? [mine, ...list] : list;
  statuses.clear();
  for (const m of sessions) if (m.status) statuses.set(m.id, { ...m.status });
  // The window knows best whether the session on screen runs (its own events), and it is being read.
  if (currentSessionId) statuses.set(currentSessionId, { ...statusOf(currentSessionId), running, unread: undefined });
  if (mine) {
    setTitle(mine.title);
    applySessionPlan(mine);
  }
  renderSessionList();
  bus.emit('sessions', sessions);
}

/** The session's newest plan may have been decided in the main process (e.g. by a build run): update its card. */
function applySessionPlan(meta: SessionMeta): void {
  if (meta.id !== currentSessionId || !meta.plan?.id) return;
  planCards.get(meta.plan.id)?.update(meta.plan);
  syncPlanStatus();
}

function onSessionChanged(meta: SessionMeta): void {
  const i = sessions.findIndex((s) => s.id === meta.id);
  if (i >= 0) sessions[i] = { ...sessions[i], ...meta };
  if (meta.id === currentSessionId) setTitle(meta.title);
  renderSessionList();
  applySessionPlan(meta);
  void refreshSessions();
}

/** Bumped by every showSession, so the slower of two quick switches gives way */
let showSeq = 0;

/**
 * Brings a session on screen, running or not: its transcript, then what is in flight (LiveState: the streaming reply,
 * running tools, waiting approval cards, the queue, the status line), then the events that arrived in between.
 * The main process takes the transcript and the live state at the same moment and sends every later event after its
 * reply, so the result is what a window that had watched from the start would show.
 */
async function showSession(id: string): Promise<boolean> {
  const my = ++showSeq;
  const epoch = tasksEpoch;
  let items: TranscriptItem[];
  try {
    items = await oc.sessions.switch(id);
  } catch (err) {
    if (my === showSeq) addSystemMessage(cleanError(err), 'error');
    return false;
  }
  if (my !== showSeq) return false;
  syncing = { id, buffer: [] };
  currentSessionId = id;
  statuses.set(id, { ...statusOf(id), unread: undefined });
  // What belonged to the session shown before: its compaction status and queue rows go with it.
  if (compacting) {
    compacting = null;
    statusLine.classList.remove('compacting');
  }
  queueList.clear();
  renderTranscript(items);
  let live: LiveState | null = null;
  try {
    live = await rpc('sessions.live', id);
  } catch {
    /* an older main process: the session shows as idle */
  }
  if (my !== showSeq) return false;
  const buffered = syncing?.id === id ? syncing.buffer : [];
  syncing = null;
  applyLive(live);
  for (const ev of buffered) handleEvent(ev);
  showSessionTasks(await refreshSessions(), epoch);
  if (my !== showSeq) return false;
  changesPane.reset();
  void refreshContext();
  scrollToBottom(true);
  bus.emit('session-shown', id);
  return true;
}

/** Shows what is in flight in the session just rendered, through the same paths its events take. */
function applyLive(live: LiveState | null): void {
  const on = Boolean(live?.running);
  if (on !== running || on) setRunning(on, live?.startedAt ?? Date.now());
  if (!live || !on) {
    syncPlanStatus();
    return;
  }
  // Queued messages from elsewhere (a schedule, another session) get their bubble when delivered (user_message).
  for (const m of live.queue ?? []) if (!m.origin || m.origin === 'user' || m.origin === 'queue') queueList.add(m);
  for (const t of live.tools ?? []) handleEvent({ type: 'tool_start', id: t.id, name: t.name, args: t.args });
  for (const a of live.approvals ?? []) handleEvent(a);
  for (const q of live.questions ?? []) handleEvent(q);
  if (live.thinking) handleEvent({ type: 'thinking_delta', text: live.thinking });
  if (live.text) handleEvent({ type: 'text_delta', text: live.text });
}

async function switchSession(id: string): Promise<void> {
  if (id === currentSessionId) return;
  await showSession(id);
}

async function newSession(): Promise<void> {
  let meta: SessionMeta;
  try {
    meta = await oc.sessions.create();
  } catch (err) {
    addSystemMessage(cleanError(err), 'error');
    return;
  }
  await showSession(meta.id);
  inputEl.focus();
}
newSessionBtn.onclick = () => void newSession();

async function deleteSession(id: string): Promise<void> {
  if (statusOf(id).running) return;
  const meta = id === currentSessionId ? await oc.sessions.current() : sessions.find((s) => s.id === id);
  if (meta?.messageCount && !window.confirm(`Delete "${meta.title}"? This cannot be undone.`)) return;
  try {
    const wasCurrent = id === currentSessionId;
    const next = await oc.sessions.delete(id);
    if (wasCurrent) await showSession(next.id);
    else await refreshSessions();
  } catch (err) {
    addSystemMessage(cleanError(err), 'error');
  }
}

async function forkSession(id: string): Promise<void> {
  if (statusOf(id).running) return;
  try {
    const source = sessions.find((s) => s.id === id);
    const fork = await oc.sessions.fork(id);
    await showSession(fork.id);
    addSystemMessage(`Forked "${source?.title ?? 'session'}". You are now in the fork; the original is unchanged.`, 'notice');
  } catch (err) {
    addSystemMessage(cleanError(err), 'error');
  }
}

// The main process keeps the list current for every session (status changes, new and removed sessions).
onPush('sessions:changed', (list) => applySessionList(list));
// A notification was clicked: its session comes on screen.
onPush('sessions:show', (id) => {
  if (typeof id === 'string' && id && id !== currentSessionId) void showSession(id);
});

// ---------- Slash menu (skills) ----------

const BUILTINS: SkillInfo[] = [
  { name: 'skills', description: 'List available skills', path: '', source: 'bundled' },
  { name: 'compact', description: 'Summarise the conversation to free context', path: '', source: 'bundled' },
  { name: 'mcp', description: 'Show MCP servers and their tools', path: '', source: 'bundled' },
];
let slashItems: SkillInfo[] = [];
let slashIndex = 0;

function hideSlashMenu(): void {
  slashMenu.hidden = true;
  slashMenu.innerHTML = '';
  slashItems = [];
}

async function updateSlashMenu(): Promise<void> {
  const value = inputEl.value;
  const m = /^\/([\w-]*)$/.exec(value);
  if (!m) return hideSlashMenu();
  const prefix = m[1].toLowerCase();
  const [allSkills, registered] = await Promise.all([oc.skills.list(), registeredCommands()]);
  const skills = allSkills.filter((sk) => sk.name.toLowerCase().startsWith(prefix));
  if (inputEl.value !== value) return;
  // The window's own commands first, then the app's registered ones (app.commands), tagged with where they come from.
  const extra: SkillInfo[] = registered
    .filter((c) => c.name.toLowerCase().startsWith(prefix) && !BUILTINS.some((b) => b.name === c.name))
    .map((c) => ({ name: c.name, description: c.argsHint ? `${c.argsHint} · ${c.description}` : c.description, path: '', source: c.source === 'mod' ? 'user' : 'bundled', tag: c.source === 'mod' ? 'mod' : 'command' }) as SkillInfo & { tag: string });
  const commands = [...BUILTINS.filter((sk) => sk.name.startsWith(prefix)), ...extra];
  slashItems = [...skills, ...commands];
  if (!slashItems.length) return hideSlashMenu();
  slashIndex = 0;
  slashMenu.innerHTML = '';
  const scroll = document.createElement('div');
  scroll.className = 'slash-scroll';
  const section = (label: string, list: SkillInfo[], offset: number, builtin: boolean) => {
    if (!list.length) return;
    scroll.insertAdjacentHTML('beforeend', `<div class="slash-label">${label}</div>`);
    list.forEach((sk, k) => {
      const i = offset + k;
      const row = document.createElement('div');
      row.className = 'slash-item' + (i === slashIndex ? ' active' : '');
      row.setAttribute('role', 'option');
      const tag = (sk as SkillInfo & { tag?: string }).tag;
      row.innerHTML = `<span class="name">/${escapeHtml(sk.name)}</span><span class="desc">${escapeHtml(sk.description)}</span><span class="src">${tag ? escapeHtml(tag) : builtin ? 'command' : escapeHtml(sk.source)}</span>`;
      row.onmousedown = (e) => {
        e.preventDefault();
        slashIndex = i;
        acceptSlashSelection();
      };
      row.onmousemove = () => {
        if (slashIndex !== i) {
          slashIndex = i;
          highlightSlash();
        }
      };
      scroll.appendChild(row);
    });
  };
  section('Skills', skills, 0, false);
  section('Commands', commands, skills.length, true);
  slashMenu.appendChild(scroll);
  slashMenu.insertAdjacentHTML('beforeend', '<div class="slash-foot"><span><kbd>↵</kbd><kbd>tab</kbd> insert</span><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>esc</kbd> close</span></div>');
  mentionPicker.close();
  slashMenu.hidden = false;
}

function highlightSlash(): void {
  slashMenu.querySelectorAll('.slash-item').forEach((el, i) => el.classList.toggle('active', i === slashIndex));
  slashMenu.querySelectorAll('.slash-item')[slashIndex]?.scrollIntoView({ block: 'nearest' });
}

function moveSlashSelection(delta: number): void {
  if (!slashItems.length) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  highlightSlash();
}

function acceptSlashSelection(): void {
  const sk = slashItems[slashIndex];
  if (!sk) return;
  inputEl.value = `/${sk.name} `;
  hideSlashMenu();
  autosize();
  inputEl.focus();
}

// ---------- Side pane: Browser, Diff and Terminal tabs, then the mods' tabs ----------

/** A built-in tab, or a mod's tab view as 'mod:<mod key>/<view id>' (mods-host.ts makes those). */
type PaneTab = 'browser' | 'diff' | 'terminal' | `mod:${string}`;
let paneVisible = true;
let paneTab: PaneTab = 'browser';
const PANE_TABS: readonly (readonly [PaneTab, HTMLButtonElement])[] = [
  ['browser', paneTabBrowser],
  ['diff', paneTabDiff],
  ['terminal', paneTabTerminal],
];
/** The mod tabs, once the mod host is up (feature wiring below) */
let paneMods: ModPaneTabs | null = null;
/** A mod tab that was in front at the last quit: it comes back once its mod has loaded, unless another tab was chosen first */
let pendingModTab: PaneTab | null = null;
try {
  const saved = localStorage.getItem('paneTab');
  if (saved?.startsWith('mod:')) pendingModTab = saved as PaneTab;
} catch {
  /* ignore */
}

const modTabKey = (tab: PaneTab): string | null => (tab.startsWith('mod:') ? tab.slice(4) : null);

/** Every tab in strip order with its button: the built-in ones, then the mods'. */
function paneTabList(): (readonly [PaneTab, HTMLButtonElement])[] {
  return [...PANE_TABS, ...(paneMods?.buttons() ?? []).map(({ key, el }) => [`mod:${key}` as PaneTab, el] as const)];
}

function browserShown(): boolean {
  return paneVisible && paneTab === 'browser' && !pageOpen();
}

/** What was last sent to the native browser view (for the live checks: __oc_debug.mods.browser()) */
const browserSent = { bounds: null as { x: number; y: number; width: number; height: number } | null, visible: false };

function reportBounds(): void {
  if (shell.classList.contains('browser-hidden') || pageOpen()) return;
  const r = browserView.getBoundingClientRect();
  browserSent.bounds = { x: r.left, y: r.top, width: r.width, height: r.height };
  oc.browser.setBounds(browserSent.bounds);
}
new ResizeObserver(reportBounds).observe(browserView);

function setBrowserVisible(v: boolean): void {
  browserSent.visible = v;
  oc.browser.setVisible(v);
}

/** The native browser view floats above the page: it is shown only while its tab is on screen and no dialog is open. */
function syncBrowserView(): void {
  if (browserShown() && !dialogOpen()) {
    reportBounds();
    setBrowserVisible(true);
    requestAnimationFrame(reportBounds);
  } else setBrowserVisible(false);
}

// A dialog's own 'close' event is delivered with the next painted frame, and a window that is hidden or covered
// may not paint one for a long time: the view it hid would stay hidden. The attribute change is reported at once.
for (const d of [settingsDialog, shortcutsDialog, confirmDialog, lightbox]) {
  new MutationObserver(() => {
    if (!d.open) syncBrowserView();
  }).observe(d, { attributes: true, attributeFilter: ['open'] });
}

function applyPane(persist = true): void {
  // A mod tab whose mod went off or away: back to the Browser.
  if (modTabKey(paneTab) && !paneMods?.has(modTabKey(paneTab)!)) paneTab = 'browser';
  const showBrowser = browserShown();
  const showDiff = paneVisible && paneTab === 'diff';
  const showTerminal = paneVisible && paneTab === 'terminal';
  if (!showBrowser) setBrowserVisible(false);
  // Focus would be lost with a hidden terminal: hand it back to the composer.
  if (!showTerminal && terminalPaneEl.contains(document.activeElement)) inputEl.focus();
  shell.classList.toggle('pane-hidden', !paneVisible);
  shell.classList.toggle('browser-hidden', !showBrowser);
  browserPane.hidden = paneTab !== 'browser';
  diffPane.hidden = paneTab !== 'diff';
  terminalPaneEl.hidden = paneTab !== 'terminal';
  for (const [tab, el] of PANE_TABS) {
    el.classList.toggle('active', paneTab === tab);
    el.setAttribute('aria-selected', String(paneTab === tab));
    el.tabIndex = paneTab === tab ? 0 : -1;
  }
  paneMods?.apply(modTabKey(paneTab), paneVisible);
  browserToggle.classList.toggle('active', showBrowser);
  browserToggle.setAttribute('aria-pressed', String(showBrowser));
  diffToggle.classList.toggle('active', showDiff);
  diffToggle.setAttribute('aria-pressed', String(showDiff));
  terminalToggle.classList.toggle('active', showTerminal);
  terminalToggle.setAttribute('aria-pressed', String(showTerminal));
  changesPane.setVisible(showDiff);
  terminalPane.setVisible(showTerminal);
  if (showBrowser) syncBrowserView();
  if (persist) {
    try {
      localStorage.setItem('pane', paneVisible ? 'shown' : 'hidden');
      localStorage.setItem('paneTab', paneTab);
    } catch {
      /* ignore */
    }
  }
}

/** The top-bar toggles: show the pane on that tab, or hide it when that tab is already showing. */
function togglePane(tab: PaneTab): void {
  pendingModTab = null;
  if (paneVisible && paneTab === tab) paneVisible = false;
  else {
    paneVisible = true;
    paneTab = tab;
  }
  applyPane();
}

function showPaneTab(tab: PaneTab): void {
  pendingModTab = null;
  if (paneVisible && paneTab === tab) return;
  if (modTabKey(tab) && !paneMods?.has(modTabKey(tab)!)) return;
  paneVisible = true;
  paneTab = tab;
  applyPane();
}

/** The mod tabs changed: a tab remembered from the last run comes back once it exists; a vanished one falls back. */
function paneTabsChanged(): void {
  const key = pendingModTab ? modTabKey(pendingModTab) : null;
  if (key && paneMods?.has(key)) {
    paneTab = pendingModTab!;
    pendingModTab = null;
  }
  applyPane(false);
}

/** The rail between the transcript and the pane opened, closed or was resized. */
function paneLayoutChanged(): void {
  const stored = sidePane.style.getPropertyValue('--browser-w');
  if (stored) setBrowserWidth(parseFloat(stored));
  reportBounds();
  requestAnimationFrame(reportBounds);
}

browserToggle.onclick = () => togglePane('browser');
diffToggle.onclick = () => togglePane('diff');
terminalToggle.onclick = () => toggleTerminal();
paneTabBrowser.onclick = () => showPaneTab('browser');
paneTabDiff.onclick = () => showPaneTab('diff');
paneTabTerminal.onclick = () => showPaneTab('terminal');
$('pane-close').onclick = () => {
  paneVisible = false;
  applyPane();
};
// ←/→ move between the pane tabs (the mods' ones too), wrapping around.
sidePane.querySelector('.pane-tabs')!.addEventListener('keydown', (e) => {
  const ke = e as KeyboardEvent;
  if ((ke.key !== 'ArrowLeft' && ke.key !== 'ArrowRight') || !(ke.target as HTMLElement).matches('[role="tab"]')) return;
  ke.preventDefault();
  const list = paneTabList();
  const at = Math.max(0, list.findIndex(([tab]) => tab === paneTab));
  const [next, nextEl] = list[(at + (ke.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
  showPaneTab(next);
  nextEl.focus();
});

// Diff tab
let debugChanges: ChangesApi | null = null;

function changesSource(): ChangesApi | null {
  if (debugChanges) return debugChanges;
  const api = oc.changes;
  return api && typeof api.list === 'function' && typeof api.diff === 'function' ? api : null;
}

function setChangeCount(n: number): void {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  for (const badge of diffCountBadges) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  const files = `${count} changed file${count === 1 ? '' : 's'}`;
  diffToggle.dataset.tip = count ? `Toggle diff · ${files}` : 'Toggle diff';
  paneTabDiff.setAttribute('aria-label', count ? `Diff, ${files}` : 'Diff');
}

/**
 * A small in-app confirmation (the native browser view is hidden while it is open). Danger: the warning badge, a red
 * button and the focus on Cancel; otherwise the accent badge with `icon` and the focus on the button.
 */
function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  if (confirmDialog.open) return Promise.resolve(false);
  closeMenu();
  $('confirm-title').textContent = opts.title;
  const badge = confirmDialog.querySelector<HTMLElement>('.confirm-icon');
  if (badge) {
    badge.innerHTML = icon(opts.danger ? 'triangle-alert' : (opts.icon ?? 'info'));
    badge.classList.toggle('tone-accent', !opts.danger);
  }
  const quote = opts.quote && opts.quote.text ? opts.quote : null;
  const quoteEl = $('confirm-quote');
  const quoteLabel = $('confirm-quote-label');
  const quoteText = $('confirm-quote-text');
  quoteEl.hidden = !quote;
  quoteEl.classList.toggle('mono', Boolean(quote?.mono));
  quoteLabel.innerHTML = quote?.label ? `${icon('file-text', 14)}<span>${escapeHtml(quote.label)}</span>` : '';
  quoteLabel.hidden = !quote?.label;
  quoteText.textContent = quote?.text ?? '';
  quoteText.scrollTop = 0;
  const desc = $('confirm-desc');
  desc.textContent = opts.description ?? '';
  desc.hidden = !opts.description;
  const ok = $<HTMLButtonElement>('confirm-ok');
  const cancel = $<HTMLButtonElement>('confirm-cancel');
  ok.textContent = opts.confirmLabel;
  ok.className = `btn ${opts.danger ? 'danger' : 'primary'}`;
  oc.browser.setVisible(false);
  confirmDialog.showModal();
  (opts.danger ? cancel : ok).focus();
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      ok.onclick = null;
      cancel.onclick = null;
      confirmDialog.removeEventListener('close', onClose);
      if (confirmDialog.open) confirmDialog.close();
      resolve(value);
    };
    // Only a close of this confirmation counts. A dialog's 'close' event arrives with the next painted frame, so the
    // one from the confirmation before this can still be on its way (always in a hidden or covered window, and when
    // one confirmation follows another at once): it finds the dialog open again and must not cancel it.
    const onClose = () => {
      if (!confirmDialog.open) finish(false);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    confirmDialog.addEventListener('close', onClose);
  });
}
confirmDialog.addEventListener('close', syncBrowserView);
confirmDialog.addEventListener('click', (e) => {
  if (e.target === confirmDialog) confirmDialog.close();
});

const changesPane = createChangesPane({
  root: diffPane,
  list: $('change-list'),
  detail: $('change-detail'),
  empty: $('changes-empty'),
  source: changesSource,
  onCount: setChangeCount,
  onError: showInlineError,
  confirm: confirmAction,
  cleanError,
  onReverted: (entry) => forgetFile(entry.path),
});

// Terminal tab
let debugTerminal: MockTerminalSource | null = null;

function terminalSource(): TerminalApi | null {
  if (debugTerminal) return debugTerminal;
  const api = oc.terminal;
  return api && typeof api.list === 'function' && typeof api.create === 'function' && typeof api.onData === 'function' && typeof api.onTabs === 'function' ? api : null;
}

function setTerminalBusy(n: number): void {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  for (const dot of terminalBusyDots) dot.hidden = count === 0;
  terminalToggle.dataset.tip = count ? `Toggle terminal · ${count} running` : 'Toggle terminal';
  paneTabTerminal.setAttribute('aria-label', count ? `Terminal, ${count} running` : 'Terminal');
}

/** A link clicked in a terminal opens in the Browser pane. */
function openTerminalLink(url: string): void {
  showPaneTab('browser');
  void oc.browser.navigate(url).catch((err: unknown) => showInlineError(paneTabBrowser, `Couldn't open the link: ${cleanError(err)}`));
}

const terminalPane = createTerminalPane({
  root: terminalPaneEl,
  strip: $('terminal-tabs'),
  newButton: $<HTMLButtonElement>('terminal-new'),
  host: $('terminal-host'),
  empty: $('terminal-empty'),
  source: terminalSource,
  onBusy: setTerminalBusy,
  onOpenUrl: openTerminalLink,
  onError: showInlineError,
  cleanError,
});

/** ⌘⇧T and the top-bar toggle: show the terminal with the cursor in it, or hide it. */
function toggleTerminal(): void {
  togglePane('terminal');
  if (paneVisible && paneTab === 'terminal') terminalPane.focus();
}

/** ⌘T: a new shell tab (the Terminal pane is shown first). */
function openNewTerminal(): void {
  showPaneTab('terminal');
  void terminalPane.newTab();
}

const BROWSER_MIN = 360;
const TRANSCRIPT_MIN = 320;
function clampBrowserWidth(px: number): number {
  // The mods' rail sits between the transcript and the pane: what it takes is not the pane's to have.
  const rail = document.getElementById('mod-rail');
  const railW = rail && !rail.hidden ? rail.offsetWidth : 0;
  return Math.round(Math.max(BROWSER_MIN, Math.min(px, contentEl.clientWidth - TRANSCRIPT_MIN - resizer.offsetWidth - railW)));
}
function setBrowserWidth(px: number | null): void {
  if (px === null) sidePane.style.removeProperty('--browser-w');
  else sidePane.style.setProperty('--browser-w', `${clampBrowserWidth(px)}px`);
}
window.addEventListener('resize', () => {
  const stored = sidePane.style.getPropertyValue('--browser-w');
  if (stored) setBrowserWidth(parseFloat(stored));
  reportBounds();
});

resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('dragging');
  document.body.classList.add('resizing');
  const startX = e.clientX;
  const startW = sidePane.getBoundingClientRect().width;
  const move = (ev: PointerEvent) => {
    setBrowserWidth(startW + (startX - ev.clientX));
    reportBounds();
  };
  const up = (ev: PointerEvent) => {
    if (resizer.hasPointerCapture(ev.pointerId)) resizer.releasePointerCapture(ev.pointerId);
    resizer.removeEventListener('pointermove', move);
    resizer.removeEventListener('pointerup', up);
    resizer.removeEventListener('pointercancel', up);
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    reportBounds();
    try {
      localStorage.setItem('browserWidth', String(Math.round(sidePane.getBoundingClientRect().width)));
    } catch {
      /* ignore */
    }
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up);
  resizer.addEventListener('pointercancel', up);
});
resizer.addEventListener('dblclick', () => {
  setBrowserWidth(null);
  try {
    localStorage.removeItem('browserWidth');
  } catch {
    /* ignore */
  }
  requestAnimationFrame(reportBounds);
});

function applyBrowserState(s: BrowserState): void {
  const blank = !s.url || s.url === 'about:blank';
  if (document.activeElement !== urlEl) urlEl.value = blank ? '' : s.url;
  browserTitle.textContent = s.title && s.title !== s.url ? s.title : s.loading && !blank ? 'Loading…' : '';
  backBtn.disabled = !s.canGoBack;
  fwdBtn.disabled = !s.canGoForward;
  openExternalBtn.disabled = blank;
  browserPane.classList.toggle('loading', s.loading);
  if (placeholder) placeholder.hidden = !blank;
}
oc.browser.onState(applyBrowserState);
urlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void oc.browser.navigate(urlEl.value);
    urlEl.blur();
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    urlEl.blur();
    void oc.browser.state().then(applyBrowserState);
  }
});
urlEl.addEventListener('focus', () => urlEl.select());
document.querySelector('.url-pill')!.addEventListener('mousedown', (e) => {
  if (e.target !== urlEl) {
    e.preventDefault();
    urlEl.focus();
  }
});
backBtn.onclick = () => void oc.browser.back();
fwdBtn.onclick = () => void oc.browser.forward();
reloadBtn.onclick = () => void oc.browser.reload();
openExternalBtn.onclick = async () => {
  try {
    if (typeof oc.browser.openExternal !== 'function') throw new Error('No handler registered');
    await oc.browser.openExternal();
  } catch (err) {
    showInlineError(openExternalBtn, `Couldn't open the page: ${cleanError(err)}`);
  }
};

// ---------- Settings ----------

// The page itself is src/renderer/settings-page.ts; its hookup is under [feature:settings] below.

// ---------- MCP servers (Settings section and /mcp) ----------

let debugMcp: MockMcpSource | null = null;
let mcpUnsubscribe: (() => void) | null = null;

function mcpSource(): McpApi | null {
  if (debugMcp) return debugMcp;
  const api = oc.mcp;
  return api && typeof api.list === 'function' ? api : null;
}

/**
 * mcpServers, mcpTrusted, allowRules and recentDirs are managed by the main process: keep this window's copy current
 * so saving Settings (or any other setConfig) passes them through unchanged.
 */
async function syncOwnedConfig(): Promise<void> {
  try {
    const latest = await oc.getConfig();
    if (latest && typeof latest === 'object') {
      config = {
        ...config,
        mcpServers: latest.mcpServers ?? config.mcpServers,
        mcpTrusted: latest.mcpTrusted ?? config.mcpTrusted,
        allowRules: latest.allowRules ?? config.allowRules,
        recentDirs: latest.recentDirs ?? config.recentDirs,
      };
    }
  } catch {
    /* the next full read catches up */
  }
}

const mcpPanel = createMcpPanel({
  els: {
    list: $('mcp-list'),
    status: $('mcp-status'),
    name: $<HTMLInputElement>('mcp-name'),
    nameLabel: $('mcp-name-label'),
    spec: $<HTMLTextAreaElement>('mcp-spec'),
    env: $<HTMLTextAreaElement>('mcp-env'),
    scope: $<HTMLSelectElement>('mcp-scope'),
    add: $<HTMLButtonElement>('mcp-add-btn'),
    error: $('mcp-add-error'),
  },
  source: mcpSource,
  confirm: confirmAction,
  cleanError,
  onMutated: () => void syncOwnedConfig(),
  projectDir: () => config?.workingDirectory ?? '',
});

/** Follows the list the source pushes whenever a server's status or tools change (oc.mcp, or the debug mock). */
function subscribeMcp(): void {
  mcpUnsubscribe?.();
  mcpUnsubscribe = null;
  const api = mcpSource();
  if (!api || typeof api.onServers !== 'function') return;
  try {
    const off = api.onServers((list) => {
      mcpPanel.render(list);
      if (!debugMcp) void syncOwnedConfig();
    });
    mcpUnsubscribe = typeof off === 'function' ? off : null;
  } catch {
    /* an older app without the event */
  }
}

/** /mcp: the servers with their status and tool names (or how to add one), and a way into Settings. */
async function addMcpCard(): Promise<void> {
  const api = mcpSource();
  let servers: McpServerInfo[] = mcpPanel.servers();
  let note: string | undefined;
  if (!api) note = 'MCP servers need the updated app. Restart Silo Harness and try again.';
  else {
    try {
      servers = await api.list();
      mcpPanel.render(servers);
    } catch (err) {
      note = `Couldn't load the servers: ${cleanError(err)}`;
    }
  }
  const el = document.createElement('div');
  el.className = 'msg system notice card mcp-card';
  el.innerHTML = `${mcpCardHtml(servers, note)}<div class="mcp-card-foot"><button type="button" class="link-btn mcp-manage">Manage in Settings…</button></div>`;
  el.querySelector<HTMLButtonElement>('.mcp-manage')!.onclick = () => openSettings('mcp-section');
  addNode(el);
}

// ---------- Permissions: "Always allow … in this project" rules (Settings section) ----------

let debugRules: RulesApi | null = null;

function rulesSource(): RulesApi | null {
  if (debugRules) return debugRules;
  const api = oc.rules;
  return api && typeof api.list === 'function' ? api : null;
}

const rulesSection = $('rules-section');
const rulesPanel = createRulesPanel({
  els: {
    cwd: $('rules-cwd'),
    list: $('rules-list'),
    programs: $('rules-programs'),
    reasons: $('rules-reasons'),
    mcp: $('rules-mcp'),
    edits: $('rules-edits'),
    empty: rulesSection.querySelector<HTMLElement>('.rules-empty')!,
    status: $('rules-status'),
  },
  source: rulesSource,
  cleanError,
  onMutated: () => {
    if (!debugRules) void syncOwnedConfig();
  },
  projectDir: () => config?.workingDirectory ?? '',
});

// ---------- Shortcuts sheet ----------

/** Label, keys, and an alternative (shown as "⌘↑ / ⌘↓") */
const SHORTCUTS: [string, string[], string[]?][] = [
  ['New session', ['⌘', 'N']],
  ['Toggle sidebar', ['⌘', 'B']],
  ['Toggle browser', ['⌘', '⇧', 'B']],
  ['Toggle diff', ['⌘', '⇧', 'D']],
  ['Toggle terminal', ['⌘', '⇧', 'T']],
  ['Toggle the mods rail', ['⌘', '⇧', 'E']],
  ['New terminal tab', ['⌘', 'T']],
  ['Settings', ['⌘', ',']],
  ['Cycle permission mode', ['⇧', 'Tab']],
  ['Stop the run', ['Esc']],
  ['Allow once, or submit the answers', ['⌘', '↵']],
  ['Deny, or skip the questions (while a card waits)', ['Esc']],
  ['Allow for the session or in the project', ['A'], ['P']],
  ['Rewind to your last message', ['Esc', 'Esc']],
  ['Focus the composer', ['⌘', 'K']],
  ['Clear the terminal (in a terminal)', ['⌘', 'K']],
  ['Search sessions', ['⌘', 'F']],
  ['Rename session', ['F2']],
  ['New line in the composer', ['⇧', '↵']],
  ['Previous or next message you sent', ['⌘', '↑'], ['⌘', '↓']],
  ['Copy the last reply', ['⌘', '⇧', 'C']],
  ['Mention a file', ['@']],
  ["Add to the project's instructions", ['#']],
  ['Keyboard shortcuts', ['⌘', '/']],
];
const kbds = (keys: string[]) => keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('');
$('shortcut-list').innerHTML = SHORTCUTS.map(
  ([label, keys, alt]) => `<dt>${escapeHtml(label)}</dt><dd>${kbds(keys)}${alt ? `<span class="kbd-sep">/</span>${kbds(alt)}` : ''}</dd>`,
).join('');

function openShortcuts(): void {
  if (dialogOpen()) return;
  closeMenu();
  oc.browser.setVisible(false);
  shortcutsDialog.showModal();
  shortcutsDialog.focus({ preventScroll: true });
}
$('shortcuts-btn').onclick = openShortcuts;
$('shortcuts-close').onclick = () => shortcutsDialog.close();
shortcutsDialog.addEventListener('click', (e) => {
  if (e.target === shortcutsDialog) shortcutsDialog.close();
});
shortcutsDialog.addEventListener('close', () => {
  syncBrowserView();
  inputEl.focus();
});

// ---------- Debug hook (renders into the UI only; nothing reaches the main process) ----------

window.__oc_debug = {
  user(text: string, images?: string[], mentions?: string[], turn?: number) {
    addUserMessage(text, Array.isArray(images) ? images.map((src) => ({ src })) : [], Array.isArray(mentions) ? mentions : null, {
      turn: typeof turn === 'number' ? turn : undefined,
    });
  },
  tasks(tasks: TaskItem[] | null) {
    showTasks(Array.isArray(tasks) ? tasks : []);
  },
  renderMarkdown(md: string) {
    endAssistant();
    appendAssistantText(md);
    endAssistant();
  },
  emit(ev: AgentEvent) {
    handleEvent(ev, true);
  },
  mockChanges(list: ChangeEntry[] | null, diffs: Record<string, Partial<ChangeDiff>> = {}) {
    debugChanges = list ? mockChangesSource(list, diffs) : null;
    changesPane.reset();
  },
  terminal: {
    screen: (id?: string) => terminalPane.screenText(id),
    tabs: () => terminalPane.tabs(),
    mock(on: boolean) {
      debugTerminal?.dispose();
      debugTerminal = on ? mockTerminalSource(config?.workingDirectory || undefined) : null;
      terminalPane.reset();
    },
    input: (text: string, id?: string) => terminalPane.input(text, id),
  },
  async attach(dataUrl: string, name?: string): Promise<ImageAttachment> {
    let blob: Blob;
    try {
      blob = dataUrlToBlob(String(dataUrl));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showInlineError(attachBtn, message);
      throw new Error(message);
    }
    const res = await attachImages([{ blob, name: name || 'Pasted image' }]);
    if (!res.added.length) throw new Error(res.errors[0] ?? 'The image was not attached.');
    return res.added[0];
  },
  attachments: () => tray.items(),
  queue: () => queueList.items(),
  mcp: {
    mock(servers: McpServerInfo[] | null) {
      debugMcp?.dispose();
      debugMcp = Array.isArray(servers) ? mockMcpSource(servers) : null;
      subscribeMcp();
      void mcpPanel.refresh();
    },
  },
  context(info: ContextInfo | null) {
    contextMeter.set(info ? normalizeContext(info) : null);
  },
  files: {
    mock(hits: FileHit[] | null) {
      debugFiles = Array.isArray(hits) ? hits.slice() : null;
      // A token already at the caret is searched again from the new source.
      mentionPicker.close();
      if (document.activeElement === inputEl) mentionPicker.sync();
    },
  },
  rules: {
    mock(rules: ProjectRules | null) {
      debugRules = rules && typeof rules === 'object' ? mockRulesSource(rules, config?.workingDirectory ?? '') : null;
      void rulesPanel.refresh();
    },
  },
  setup(checks: Partial<SetupChecks> | null) {
    debugSetup = checks && typeof checks === 'object' ? cleanChecks(checks) : null;
    syncConnection();
    // Back to the real checks: ask Ollama again now
    if (!debugSetup && config) void checkConnection();
  },
  recent(dirs: string[] | null) {
    debugRecent = Array.isArray(dirs) ? dirs.slice() : null;
    renderRecent();
  },
};

// ---------- Feature wiring: each feature keeps its code in its own module, only the hookup lives here ----------

// [feature:mods]
// The mod host: the rail, mod tabs, the composer strip, backgrounds, injected styles and the bridge (mods-host.ts).
paneMods = createModsHost({
  currentSessionId: () => currentSessionId,
  sessions: () => sessions,
  config: () => config,
  running: () => running,
  toast: (text, kind) => flashStatus(text, kind === 'error' ? 'circle-alert' : 'info'),
  insertText: (text) => insertAtCursor(text),
  openSettings: (section, opts) => openSettings(section, opts),
  switchSession,
  newSession,
  openPage: (page, opts) => (page === 'scheduled' && opts?.form === 'new' ? openTaskForm() : openPage({ page })),
  openLightbox,
  showPane: (tab) => showPaneTab(tab as PaneTab),
  paneTabsChanged,
  paneLayoutChanged,
  syncBrowserView,
  browserDebug: () => ({ ...browserSent, bounds: browserSent.bounds && { ...browserSent.bounds }, element: (() => { const r = browserView.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })(), tab: paneTab, paneVisible, dialog: dialogOpen() }),
}).pane;

// [feature:pages]
// Scheduled tasks and Dreaming: pages in the main column (pages.ts), each a list and a page per task or project.
const scheduledPage = createScheduledPage({
  sessions: () => sessions,
  status: statusOf,
  openSession: (id) => void openFromPage(id),
  currentSessionId: () => currentSessionId,
  config: () => config,
  confirm: confirmAction,
  cleanError,
  showError: showInlineError,
});
const dreamingPage = createDreamingPage({
  sessions: () => sessions,
  openSession: (id) => void openFromPage(id),
  cleanError,
  showError: showInlineError,
});
pagesView = createPages({
  shell,
  main: document.querySelector<HTMLElement>('.main')!,
  topbar: document.querySelector<HTMLElement>('.topbar')!,
  changed: (open) => {
    closeMenu();
    if (open) setBrowserVisible(false);
    else {
      // The column comes back: the pane, the rail and the native browser view take their places again
      paneLayoutChanged();
      syncBrowserView();
    }
    renderSessionList();
  },
  render: (route, root, host) => (route.page === 'scheduled' || route.page === 'task' ? scheduledPage.render(route, root, host) : dreamingPage.render(route, root, host)),
});

/** Opens a page in the main column (Scheduled tasks, a task, Dreaming, a project) */
function openPage(route: PageRoute): void {
  if (confirmDialog.open) return;
  if (settingsDialog.open) settingsDialog.close();
  if (shortcutsDialog.open) shortcutsDialog.close();
  pagesView?.open(route);
}

/** The New task form, on the Scheduled tasks page */
function openTaskForm(opts: { template?: string; edit?: string } = {}): void {
  const cur = pagesView?.current();
  if (cur?.page !== 'scheduled' && cur?.page !== 'task') openPage({ page: 'scheduled' });
  scheduledPage.openForm(opts);
}

/** A session chosen on a page or in the sidebar: the chat view comes back with it */
async function openFromPage(id: string): Promise<void> {
  if (pagesView?.isOpen() && id === currentSessionId) {
    pagesView.close();
    inputEl.focus();
    return;
  }
  await switchSession(id);
}

Object.assign(window.__oc_debug!, {
  pages: {
    state: () => pagesView?.debug.state(),
    open: (route: PageRoute) => openPage(route),
    close: () => pagesView?.close(),
    back: () => pagesView?.back(),
    form: (opts?: { template?: string; edit?: string }) => openTaskForm(opts),
    scheduled: () => scheduledPage.debug.state(),
    dreaming: () => dreamingPage.debug.state(),
  },
});

// [feature:settings]
const settingsPage = createSettingsPage({
  dialog: settingsDialog,
  config: () => config,
  adoptConfig: (next) => {
    const prev = config;
    config = next;
    applyConfigToUi();
    if (prev && prev.workingDirectory !== next.workingDirectory) void changesPane.refresh();
    void refreshContext();
  },
  mcpPanel,
  rulesPanel,
  confirm: confirmAction,
  cleanError,
  chooseFolder,
  openShortcuts,
  currentSessionId: () => currentSessionId,
  openSession: (id) => void switchSession(id),
  openPage: (target) => (target === 'scheduled:new' ? openTaskForm() : openPage({ page: target })),
  sessionTitle: (id) => sessions.find((s) => s.id === id)?.title,
  beforeOpen: () => {
    if (confirmDialog.open) return false;
    closeMenu();
    if (shortcutsDialog.open) shortcutsDialog.close();
    oc.browser.setVisible(false);
    return true;
  },
  afterClose: syncBrowserView,
});
/**
 * Opens Settings at the section last open, or at `section`: a section id ("mods"), a section and a tab ("mods" with
 * { tab: 'backgrounds' }, or "mods:backgrounds"), or the id of a field on the page ("ollama-baseURL", "mcp-section").
 */
function openSettings(section?: string, opts?: { tab?: string }): void {
  // Scheduled and Dreaming were sections of Settings; they are pages now
  if (section === 'scheduled' || section === 'dreaming') return openPage({ page: section });
  settingsPage.open(typeof section === 'string' ? section : undefined, opts && typeof opts === 'object' ? opts : undefined);
}
$('settings-btn').onclick = () => openSettings();
(window.__oc_debug as unknown as Record<string, unknown>).settings = settingsPage.debug;

// A project's settings.json is never applied without the user's say-so. Say once that it is waiting, and where to
// review it, the way a project's MCP servers are announced.
const settingsNoticed = new Set<string>();
function noticeProjectSettings(info: SettingsInfo | null | undefined): void {
  const f = info?.files?.find((x) => x.scope === 'project');
  if (!f || !f.exists || f.trusted || f.error || !f.keys.length) return;
  const key = `${f.path}|${f.changed ? 'changed' : 'new'}|${f.keys.join(',')}`;
  if (settingsNoticed.has(key)) return;
  settingsNoticed.add(key);
  const env = f.keys.filter((k) => k.startsWith('env.')).length;
  const fields = f.keys.filter((k) => !k.startsWith('env.'));
  const hooks = f.hookCommands?.length ? 'hooks that run commands' : '';
  const plain = fields.filter((k) => !k.startsWith('hooks.'));
  const sets = [plain.slice(0, 4).join(', ') + (plain.length > 4 ? ` and ${plain.length - 4} more` : ''), hooks, env ? `${env} environment variable${env === 1 ? '' : 's'}` : ''].filter(Boolean).join(', plus ');
  addSystemMessage(
    f.changed
      ? `This project's settings.json changed since you approved it (it sets ${sets}), so it is no longer applied. Review it in Settings → Configuration files.`
      : `This project has a settings.json that sets ${sets}. It is not applied until you approve it: Settings → Configuration files.`,
    'notice',
  );
}
onPush('settings:changed', noticeProjectSettings);
void rpc('settings.info')
  .then(noticeProjectSettings)
  .catch(() => undefined);

// [feature:sidebar]
sidebarView = createSidebar({
  root: $('sidebar'),
  sessions: () => sessions,
  // While a page is open no session is on screen: none shows selected
  currentId: () => (pagesView?.isOpen() ? '' : currentSessionId),
  status: statusOf,
  open: async (id) => openFromPage(id),
  openPage: (page) => openPage({ page }),
  page: () => {
    const r = pagesView?.current();
    return r ? navOf(r) : null;
  },
  fork: forkSession,
  remove: deleteSession,
  rename: renameSession,
  refresh: refreshSessions,
  openSettings,
  confirm: confirmAction,
  showError: showInlineError,
  cleanError,
  flash: (text) => flashStatus(text),
  focusComposer: () => inputEl.focus(),
  expand: () => {
    if (shell.classList.contains('sidebar-collapsed')) toggleSidebar();
  },
});
Object.assign(window.__oc_debug!, { sidebar: sidebarView.debug });

// [feature:tasks]

// [feature:images]
import { setupImageView } from './images.js';
setupImageView({ messages: messagesEl, openLightbox, showError: showInlineError });

// [feature:history]

// [feature:schedules]
// Schedule names by id, so a tool row that names a schedule by its id shows its name (tool-labels.ts)
const scheduleNames = new Map<string, string>();
const keepScheduleNames = (list: Schedule[]) => {
  scheduleNames.clear();
  for (const s of list ?? []) scheduleNames.set(s.id, s.name);
};
onPush('schedules:changed', keepScheduleNames);
void rpc('schedules.list').then(keepScheduleNames, () => undefined);
setNameLookup({
  session: (ref) => sessions.find((s) => s.id === ref)?.title,
  schedule: (id) => scheduleNames.get(id),
});

// [feature:subagents]

// [feature:remote]

// [feature:dreaming]
// Proposal cards in a dream's transcript and on the Dreaming page; the sidebar row is in sidebar.ts, the page in dreaming-page.ts
setupDreamingView({
  openSession: (id) => void switchSession(id),
  sessionTitle: (id) => sessions.find((s) => s.id === id)?.title,
  showError: showInlineError,
  cleanError,
});

// ---------- Init ----------

subscribeMcp();
void mcpPanel.refresh();

(async () => {
  config = await oc.getConfig();
  applyConfigToUi();
  try {
    if (localStorage.getItem('sidebar') === 'collapsed') shell.classList.add('sidebar-collapsed');
    // 'browser' is the key older builds used for the pane's visibility
    const pane = localStorage.getItem('pane') ?? localStorage.getItem('browser');
    paneVisible = pane !== 'hidden';
    const savedTab = localStorage.getItem('paneTab');
    paneTab = savedTab === 'diff' || savedTab === 'terminal' ? savedTab : 'browser';
    const w = Number(localStorage.getItem('browserWidth'));
    if (w > 0) setBrowserWidth(w);
  } catch {
    /* ignore */
  }
  applyPane(false);
  // After a reload the main process still holds the session on screen, possibly mid-run: show it as it stands
  // (its transcript, what is in flight and its queue).
  try {
    const current = await oc.sessions.current();
    if (current?.id) await showSession(current.id);
    else await refreshSessions();
  } catch (err) {
    addSystemMessage(cleanError(err), 'error');
  }
  void changesPane.refresh();
  reportBounds();
  autosize();
  applyBrowserState(await oc.browser.state());
  inputEl.focus();
})();

// ---------- Drop files: images are attached, other files insert their paths ----------

const composerEl = $('composer');
function insertAtCursor(text: string): void {
  mentionPicker.close();
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? start;
  const before = inputEl.value.slice(0, start);
  const sep = before && !/\s$/.test(before) ? ' ' : '';
  inputEl.value = before + sep + text + inputEl.value.slice(end);
  const pos = (before + sep + text).length;
  inputEl.setSelectionRange(pos, pos);
  inputEl.focus();
  autosize();
  updateSendButton();
}
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  composerEl.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) composerEl.classList.remove('dragging');
});
document.addEventListener('drop', (e) => {
  composerEl.classList.remove('dragging');
  // The chat bar is not on screen under a page
  if (pageOpen()) {
    if (e.dataTransfer?.files?.length) e.preventDefault();
    return;
  }
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  e.preventDefault();
  const images = [...files].filter((f) => imageType(f) !== '');
  if (images.length) {
    void attachImages(images.map((f) => ({ blob: f, name: f.name || 'Image' })));
    if (!dialogOpen()) inputEl.focus();
  }
  const paths = [...files]
    .filter((f) => imageType(f) === '')
    .map((f) => {
      try {
        return oc.pathForFile(f);
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p));
  if (paths.length) insertAtCursor(paths.join(' ') + ' ');
});

// ---------- Empty-state suggestions ----------

const SUGGESTIONS = [
  'Explain what this project does and how it is organised',
  'Find the failing tests, fix them, and run the suite again',
  'Open https://example.com in the browser and summarise the page',
];
const suggestionsEl = $('empty-suggestions');
suggestionsEl.innerHTML = SUGGESTIONS.map((s) => `<button type="button" class="suggestion">${escapeHtml(s)}</button>`).join('');
suggestionsEl.querySelectorAll<HTMLButtonElement>('.suggestion').forEach((b, i) => {
  b.onclick = () => {
    mentionPicker.close();
    inputEl.value = SUGGESTIONS[i];
    autosize();
    updateSendButton();
    inputEl.focus();
  };
});

export {};
