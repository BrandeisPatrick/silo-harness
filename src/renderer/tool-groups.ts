// Tool rows, and the runs of them that fold into one line. With Tool activity set to Summary (the default) every run of
// calls in a turn, a single call included, is one quiet `.tool-group` line ("Ran a command", "Read 3 files, ran 2
// commands  +49 −2"), with the thinking between the calls inside it; opened, it shows the rows (a lone row opens with
// it). With Every call only runs of three or more reads, searches, listings and MCP calls fold, as they always did. A
// run is whatever stands between two other things (a reply, a waiting approval or question card, a plan, an image, a
// notice), so a stored session folds the same way. An answered approval leaves no line of its own: the call's row
// says what was decided.

import type { AppConfig } from '../shared/types';
import { statHtml } from './diff.js';
import { icon, isIconName, type IconName } from './icons.js';
import { activityWords } from './tool-activity.js';
import { createToolCard, mcpParts, type ToolCard } from './tools.js';

export interface ToolGroupsDeps {
  /** The transcript the rows and groups live in */
  messages: HTMLElement;
  config(): AppConfig | undefined;
  /** A run is going on in the session on screen: its last run of calls is live */
  running(): boolean;
  /** Appends a node to the transcript (transcript.ts); the streaming reply and the thinking block are closed first */
  addNode(el: HTMLElement): void;
  endAssistant(): void;
  finishThinking(): void;
  scrollToBottom(): void;
  /**
   * A call drawn as a line of its own rather than a tool row (session_send: "Messaged …", session-messages.ts), or
   * null. Its element is not a .tool, so it never folds into a run of calls; the approval card attaches to it as usual.
   */
  ownRow?(name: string, args: unknown): ToolCard | null;
}

export function createToolGroups({ messages: messagesEl, config, running, addNode, endAssistant, finishThinking, scrollToBottom, ownRow }: ToolGroupsDeps) {
  /** The rows of the calls in flight, by call id */
  const toolCards = new Map<string, ToolCard>();
  let lastToolCard: ToolCard | null = null;
  const cardByEl = new WeakMap<HTMLElement, ToolCard>();

  function summaryMode(): boolean {
    return (config()?.toolActivity ?? 'summary') !== 'all';
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
    if (!running() || !summaryMode()) return false;
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
        server: mcpParts(c.name)?.server,
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
    const card = ownRow?.(name, args) ?? createToolCard(name, args);
    if (id) {
      toolCards.set(id, card);
      // A call Auto mode blocks gives way to its line (auto-blocked.ts), which finds the row by it
      card.el.dataset.callId = id;
    }
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

  return {
    summaryMode,
    foldable,
    settleRun,
    refoldAll,
    endLiveRun,
    addToolCard,
    finishToolCard,
    /** The row added last (the approval and question cards attach to it while it runs) */
    lastCard: () => lastToolCard,
    /** The last run of calls is live while a run goes on (a session brought on screen mid-run, too) */
    updateLastGroup: () => updateGroup([...messagesEl.querySelectorAll(':scope > .tool-group')].pop() ?? null),
    /** The run ended: every row still running is marked interrupted and its run settles */
    interruptAll: () => {
      for (const card of toolCards.values()) {
        card.interrupt();
        settleRun(card.el);
      }
      toolCards.clear();
    },
    /** The transcript was cleared */
    reset: () => {
      lastToolCard = null;
      toolCards.clear();
    },
  };
}
