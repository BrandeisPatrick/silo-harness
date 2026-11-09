// Chat cards: a card for each GitHub pull request a reply or a tool result names, and for each document the agent
// wrote, as Claude Code draws them. They go under the reply: what a reply names, plus what the calls since the reply
// before it made or read (a `gh pr create`, a write_file of notes.md), in one block of cards 8px apart. Calls with no
// reply after them get their block when the run ends. The detection and the words are in chat-cards-model.ts; the
// pull request's data comes from the main process (`gh pr view`, src/main/chat-cards.ts), asked again each time the
// card comes back into view, which the main process answers from a copy for up to a minute.

import type { PullRequestInfo, PullRequestRef } from '../shared/chat-cards';
import { diffLabels, filesLabel, PR_STATE_LABEL, prFooter, prMetaLine, replyPullRequests, toolDocument, toolPullRequests, type DocumentRef, type FooterTone } from './chat-cards-model.js';
import { basename } from './dom.js';
import { createFileCard } from './file-card.js';
import { homeDir } from './home.js';
import { icon, type IconName } from './icons.js';
import { rpc } from './rpc.js';

export interface ChatCardsDeps {
  messages: HTMLElement;
  /** The folder relative paths in a tool call are read against (the session's) */
  cwd(): string;
  /** Appends a block at the end of the transcript */
  addNode(el: HTMLElement): void;
  scrollToBottom(): void;
  showPaneTab(tab: 'browser'): void;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
}

/** How often a card on screen asks for its pull request again (the main process keeps an answer as long) */
const REFRESH_MS = 60_000;

const FOOTER_ICON: Record<FooterTone, IconName> = { ok: 'check', bad: 'circle-x', wait: 'circle-dashed', info: 'info' };

function docIcon(label: string): IconName {
  return label === 'HTML' ? 'globe' : label === 'PDF' ? 'file-text' : 'note';
}

export function createChatCards(deps: ChatCardsDeps) {
  /** What the calls since the last reply named, waiting for the next reply (or the run's end) */
  let pendingPrs: PullRequestRef[] = [];
  let pendingDocs: DocumentRef[] = [];
  /** The newest answer for each pull request, so a card drawn again starts with it */
  const known = new Map<string, PullRequestInfo>();
  /** Each pull request card on screen: its URL and when it last asked */
  const cards = new WeakMap<HTMLElement, { ref: PullRequestRef; askedAt: number }>();

  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) if (e.isIntersecting) refresh(e.target as HTMLElement);
          },
          { root: deps.messages },
        )
      : null;

  function addPr(list: PullRequestRef[], ref: PullRequestRef): void {
    if (!list.some((r) => r.url.toLowerCase() === ref.url.toLowerCase())) list.push(ref);
  }

  // ---------- The pull request card ----------

  function renderPr(el: HTMLElement, ref: PullRequestRef, info: PullRequestInfo | undefined): void {
    const found = Boolean(info?.found);
    el.classList.toggle('loading', !info);
    el.classList.toggle('bare', Boolean(info && !found));
    const pill = el.querySelector<HTMLElement>('.pr-pill')!;
    const state = found ? info!.state : undefined;
    pill.hidden = !state;
    if (state) {
      pill.className = `pr-pill ${state}`;
      pill.innerHTML = `${icon(state === 'merged' ? 'git-merge' : 'git-pull-request', 14)}<span>${PR_STATE_LABEL[state]}</span>`;
    }
    el.querySelector('.pr-card-meta')!.textContent = prMetaLine(info ?? { ref }, Date.now());
    const title = el.querySelector<HTMLElement>('.pr-card-title')!;
    title.textContent = found && info!.title ? info!.title : `Pull request #${ref.number}`;
    const stats = el.querySelector<HTMLElement>('.pr-stats')!;
    const files = found && typeof info!.files === 'number' ? info!.files : undefined;
    const diff = found && typeof info!.additions === 'number' && typeof info!.deletions === 'number';
    stats.hidden = files === undefined && !diff;
    const filesEl = stats.querySelector<HTMLElement>('.pr-files')!;
    filesEl.hidden = files === undefined;
    if (files !== undefined) filesEl.textContent = filesLabel(files);
    const diffEl = stats.querySelector<HTMLElement>('.pr-diff')!;
    diffEl.hidden = !diff;
    if (diff) {
      const [add, del] = diffLabels(info!.additions!, info!.deletions!);
      diffEl.querySelector('.pr-add')!.textContent = add;
      diffEl.querySelector('.pr-del')!.textContent = del;
    }
    const foot = el.querySelector<HTMLElement>('.pr-card-foot')!;
    const line = info ? prFooter(info) : null;
    foot.hidden = !line;
    if (line) {
      foot.dataset.tone = line.tone;
      foot.querySelector('.pr-foot-icon')!.innerHTML = icon(FOOTER_ICON[line.tone], 14);
      foot.querySelector('.pr-foot-text')!.textContent = line.text;
    }
    el.setAttribute('aria-label', `${found && info!.title ? info!.title : `Pull request #${ref.number}`}, ${ref.owner}/${ref.repo} #${ref.number}${state ? `, ${PR_STATE_LABEL[state]}` : ''}`);
  }

  function ask(el: HTMLElement): void {
    const c = cards.get(el);
    if (!c) return;
    c.askedAt = Date.now();
    rpc('cards.pullRequest', c.ref.url)
      .then((info) => {
        if (!info || typeof info !== 'object') return;
        known.set(c.ref.url.toLowerCase(), info);
        if (el.isConnected) renderPr(el, c.ref, info);
      })
      .catch((err: unknown) => {
        // An older main process, or a URL it does not take: the card keeps what the URL gives
        const info: PullRequestInfo = { ref: c.ref, found: false, error: deps.cleanError(err), fetchedAt: Date.now() };
        if (el.isConnected) renderPr(el, c.ref, info);
      });
  }

  /** The card came into view: its status is asked again if the last answer is a minute old. */
  function refresh(el: HTMLElement): void {
    const c = cards.get(el);
    if (c && Date.now() - c.askedAt >= REFRESH_MS) ask(el);
  }

  function createPrCard(ref: PullRequestRef): HTMLElement {
    const el = document.createElement('a');
    el.className = 'pr-card';
    el.href = ref.url;
    // A link like any in the chat: the Browser pane or the default browser, as Settings → Browser says
    el.target = '_blank';
    el.rel = 'noreferrer';
    el.dataset.url = ref.url;
    el.title = ref.url;
    el.innerHTML =
      `<div class="pr-card-icon" aria-hidden="true">${icon('repo-browser', 32)}</div>` +
      `<div class="pr-card-head"><span class="pr-pill" hidden></span><span class="pr-card-meta"></span></div>` +
      `<div class="pr-card-body"><span class="pr-card-title"></span>` +
      `<span class="pr-stats" hidden><span class="pr-stat pr-files"></span><span class="pr-stat pr-diff"><span class="pr-add"></span><span class="pr-del"></span></span></span></div>` +
      `<div class="pr-card-foot" hidden><span class="pr-foot-icon"></span><span class="pr-foot-text"></span></div>`;
    cards.set(el, { ref, askedAt: 0 });
    renderPr(el, ref, known.get(ref.url.toLowerCase()));
    ask(el);
    observer?.observe(el);
    return el;
  }

  // ---------- The document card ----------

  function createDocCard(doc: DocumentRef): HTMLElement {
    const name = basename(doc.path) || doc.path;
    const fail = (anchor: HTMLElement, verb: string, err: unknown) => {
      deps.showError(anchor, `Couldn't ${verb} ${name}: ${deps.cleanError(err)}`);
      return false;
    };
    const card = createFileCard({
      className: 'doc-card',
      title: doc.title,
      meta: `Document · ${doc.label}`,
      icon: docIcon(doc.label),
      tooltip: doc.path,
      open: async (el) => {
        try {
          const where = await rpc('cards.openDocument', doc.path);
          if (where === 'pane') deps.showPaneTab('browser');
          return true;
        } catch (err) {
          return fail(el, 'open', err);
        }
      },
      actions: [
        {
          id: 'reveal',
          icon: 'folder',
          label: 'Reveal in Finder',
          run: async (btn) => {
            try {
              await rpc('cards.revealDocument', doc.path);
              return true;
            } catch (err) {
              return fail(btn, 'reveal', err);
            }
          },
        },
        {
          id: 'external',
          icon: 'external-link',
          label: 'Open with the default app',
          run: async (btn) => {
            try {
              await rpc('cards.openDocument', doc.path, { external: true });
              return true;
            } catch (err) {
              return fail(btn, 'open', err);
            }
          },
        },
      ],
    });
    card.el.dataset.path = doc.path;
    return card.el;
  }

  // ---------- Blocks ----------

  function block(prs: PullRequestRef[], docs: DocumentRef[]): HTMLElement {
    const el = document.createElement('div');
    el.className = 'chat-cards';
    for (const ref of prs) el.appendChild(createPrCard(ref));
    for (const doc of docs) el.appendChild(createDocCard(doc));
    return el;
  }

  function take(): { prs: PullRequestRef[]; docs: DocumentRef[] } {
    const out = { prs: pendingPrs, docs: pendingDocs };
    pendingPrs = [];
    pendingDocs = [];
    return out;
  }

  return {
    /**
     * A reply ended (live, or drawn from the transcript): its cards, and those the calls before it were waiting
     * with, go right under it.
     */
    replyEnded(msg: HTMLElement, raw: string): void {
      const { prs, docs } = take();
      for (const ref of replyPullRequests(raw)) addPr(prs, ref);
      if (!prs.length && !docs.length) return;
      const el = block(prs, docs);
      if (msg.isConnected && msg.nextElementSibling) {
        el.classList.add('fade-in');
        msg.after(el);
      } else deps.addNode(el);
      deps.scrollToBottom();
    },
    /** A tool call finished: a pull request or a document it names waits for the next reply. */
    toolEnded(name: string, args: unknown, result: unknown, ok: boolean): void {
      const text = typeof result === 'string' ? result : '';
      for (const ref of toolPullRequests(name, args, text, ok)) addPr(pendingPrs, ref);
      const doc = toolDocument(name, args, text, ok, deps.cwd(), homeDir(deps.cwd()));
      if (doc && !pendingDocs.some((d) => d.path === doc.path)) pendingDocs.push(doc);
    },
    /** The run ended with no reply after the calls: their cards get a block of their own. */
    flush(): void {
      const { prs, docs } = take();
      if (prs.length || docs.length) deps.addNode(block(prs, docs));
    },
    /** The transcript was cleared */
    reset(): void {
      take();
      observer?.disconnect();
    },
    /** Debug: what waits for the next reply */
    pending: () => ({ prs: pendingPrs.map((r) => r.url), docs: pendingDocs.map((d) => d.path) }),
  };
}

export type ChatCards = ReturnType<typeof createChatCards>;
