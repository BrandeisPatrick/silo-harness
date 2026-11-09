// The transcript's own rendering: following new content, user and system bubbles, the streaming reply (rendered
// as Markdown a few times a second) and the thinking block, and what a click in the transcript does. The cards
// (tool rows, approvals, plans, artifacts) are drawn by their own modules and appended through addNode; a finished
// reply tells replyEnded, which puts the pull request and document cards it names under it (chat-cards.ts).

import type { ChangesApi, CompactionInfo, ImageAttachment } from '../shared/types';
import { attachmentLabel } from './attachments.js';
import { createCompactionDivider } from './context.js';
import { basename, byId, copyWithFeedback, escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { appendWithMentions } from './mentions.js';

export interface TranscriptDeps {
  messages: HTMLElement;
  /** The welcome screen, hidden once the transcript has a node */
  emptyState: HTMLElement;
  /** The working directory @path chips are resolved against */
  workingDirectory(): string;
  /** Paths picked from the @ menu in this window: their tokens become chips */
  pickedPaths: Set<string>;
  /** oc.changes, read when a path is opened (an older main process may lack it) */
  changesApi(): ChangesApi | undefined;
  openLightbox(src: string, name?: string, caption?: string): void;
  /** A bubble's Rewind button (rewind lives in renderer.ts) */
  rewindTo(msg: HTMLElement, button: HTMLElement): Promise<void>;
  /** Whether a node can be part of a run of calls, and the end of the live run (tool-groups.ts, set up after this) */
  foldable(el: Element): boolean;
  endLiveRun(): void;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
  /** A reply was finished, with its Markdown source: the cards it names go under it (chat-cards.ts) */
  replyEnded?(msg: HTMLElement, raw: string): void;
}

export function createTranscript({ messages: messagesEl, emptyState, workingDirectory, pickedPaths, changesApi, openLightbox, rewindTo, foldable, endLiveRun, showError, cleanError, replyEnded }: TranscriptDeps) {
  /** Whether the view follows new content (the user is at the bottom) */
  let stick = true;
  const jumpBtn = byId<HTMLButtonElement>('jump-latest');
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
    } else if (text) appendWithMentions(bubble, text, { mentions: Array.isArray(mentions) ? mentions : null, known: pickedPaths, cwd: workingDirectory() });
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

  /**
   * A user message a feature draws in a shape of its own (a message from another session is one quiet line): a user
   * message all the same, so Copy, Rewind and the matching to transcript items work as for a bubble. `el` holds its
   * own .msg-actions row (Copy; Rewind is added with the checkpoint).
   */
  function addUserRow(el: HTMLElement, text: string, turn?: number): HTMLElement {
    el.classList.add('msg', 'user');
    userTextByMessage.set(el, text);
    setTurn(el, turn);
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
    const ended = currentAssistant;
    currentAssistant = null;
    if (!ended) return;
    ended.md.innerHTML = renderMarkdown(ended.raw);
    scrollToBottom();
    replyEnded?.(ended.el, ended.raw);
  }

  /** A path in a tool row or an approval card (.path-link): opens it with the system's editor, as the Diff pane does. */
  async function openPath(path: string, anchor: HTMLElement): Promise<void> {
    if (!path) return;
    try {
      const api = changesApi();
      if (typeof api?.openInEditor !== 'function') throw new Error('No handler registered');
      await api.openInEditor(path);
    } catch (err) {
      showError(anchor, `Couldn't open ${basename(path) || path}: ${cleanError(err)}`);
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

  return {
    scrollToBottom,
    showJump,
    addNode,
    bubbleImage,
    /** What a user bubble was sent with */
    userText: (msg: HTMLElement) => userTextByMessage.get(msg),
    setTurn,
    turnOf,
    addUserMessage,
    addUserRow,
    addSystemMessage,
    addNoticeCard,
    addCompaction,
    assistantText,
    appendAssistantText,
    endAssistant,
    appendThinking,
    finishThinking,
    /** The user is at the bottom: the view follows new content */
    atBottom: () => stick,
    /** The transcript was cleared: nothing streams, and the view follows again */
    reset: () => {
      currentAssistant = null;
      currentThinking = null;
      thinkPending = '';
      stick = true;
    },
  };
}
