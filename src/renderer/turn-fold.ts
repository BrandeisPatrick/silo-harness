// The header over a turn's working process, and the fold. A turn that makes a tool call gets one quiet line at the top
// of its output, "Working for 18s" while it runs and "Worked for 53s" after, with a hairline under it. When the turn
// ends with an answer the process (interim replies, thinking, tool groups and rows) is hidden and the line is the
// button that shows it again; the answer, cards, images, notices and anything still waiting for the user stay. With
// Tool activity set to Every call nothing folds by itself; the line still toggles. What counts as process is in
// turn-fold-model.ts. The transcript stays flat: the nodes are hidden with a class, never moved.

import type { AppConfig } from '../shared/types';
import { icon } from './icons.js';
import { foldsWhenDone, headText, nodeKind, turnShape, type TurnShape } from './turn-fold-model.js';

export interface TurnFoldDeps {
  messages: HTMLElement;
  config(): AppConfig | undefined;
}

interface Head {
  el: HTMLElement;
  btn: HTMLButtonElement;
  label: HTMLElement;
  /** Counting: when the turn began (the header ticks) */
  liveSince?: number;
  /** How long the turn worked, once it is over (undefined: not known, "Worked") */
  workedMs?: number;
  folded: boolean;
}

const HIDDEN = 'turn-hidden';

export function createTurnFold({ messages: messagesEl, config }: TurnFoldDeps) {
  const heads = new WeakMap<HTMLElement, Head>();
  /** A stored transcript is being drawn: its turns are over */
  let rendering = false;
  let running = false;
  /** When the turn going on now began */
  let liveStart = 0;
  let timer: number | undefined;

  const summaryMode = () => (config()?.toolActivity ?? 'summary') !== 'all';
  const isUser = (n: Element) => n.classList.contains('msg') && n.classList.contains('user');

  /** The header of the turn `node` is in, or where it would go: right after the turn's user message. */
  function locate(node: Element): { head: Head | null; after: Element | null } {
    for (let n = node.previousElementSibling; n; n = n.previousElementSibling) {
      if (n.classList.contains('turn-head')) return { head: heads.get(n as HTMLElement) ?? null, after: n.previousElementSibling };
      if (isUser(n)) return { head: null, after: n };
    }
    return { head: null, after: null };
  }

  /** The nodes after a header, up to the next user message */
  function nodesOf(head: Head): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (let n = head.el.nextElementSibling; n && !isUser(n); n = n.nextElementSibling) out.push(n as HTMLElement);
    return out;
  }

  function shapeOf(nodes: HTMLElement[]): TurnShape {
    return turnShape(nodes.map((n) => nodeKind([...n.classList])));
  }

  function allHeads(): Head[] {
    return [...messagesEl.querySelectorAll<HTMLElement>(':scope > .turn-head')].map((el) => heads.get(el)).filter((h): h is Head => Boolean(h));
  }

  function draw(h: Head): void {
    const live = h.liveSince !== undefined;
    h.label.textContent = headText(live, live ? Date.now() - h.liveSince! : h.workedMs);
    h.el.classList.toggle('live', live);
    h.btn.disabled = live;
    h.btn.setAttribute('aria-expanded', String(!h.folded));
    h.el.classList.toggle('folded', h.folded);
  }

  /** Hides or shows the turn's process to match the header. */
  function apply(h: Head): void {
    const nodes = nodesOf(h);
    const shape = shapeOf(nodes);
    nodes.forEach((n, i) => n.classList.toggle(HIDDEN, h.folded && shape.process[i]));
    draw(h);
  }

  function tick(): void {
    const live = allHeads().filter((h) => h.liveSince !== undefined);
    for (const h of live) draw(h);
    if (!live.length && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  }

  function startTicking(): void {
    if (timer === undefined) timer = window.setInterval(tick, 1000);
  }

  function createHead(after: Element | null, before: Element): Head {
    const el = document.createElement('div');
    el.className = 'turn-head';
    el.innerHTML = `<button type="button" class="turn-head-btn" aria-expanded="true"><span class="turn-head-label"></span><span class="turn-head-chevron">${icon('chevron-right')}</span></button>`;
    const btn = el.querySelector<HTMLButtonElement>('button')!;
    const h: Head = { el, btn, label: el.querySelector<HTMLElement>('.turn-head-label')!, folded: false };
    heads.set(el, h);
    btn.addEventListener('click', () => {
      if (h.liveSince !== undefined) return;
      h.folded = !h.folded;
      apply(h);
    });
    if (after) after.after(el);
    else messagesEl.insertBefore(el, before);
    return h;
  }

  /** Ends a counting header: it says how long the turn worked, and folds when the turn ended with an answer. */
  function finish(h: Head, reason: string | undefined, anchor = true): void {
    if (h.liveSince === undefined) return;
    h.workedMs = Date.now() - h.liveSince;
    h.liveSince = undefined;
    const fold = foldsWhenDone(shapeOf(nodesOf(h)), summaryMode(), reason);
    if (fold && anchor) foldKeepingPlace(h);
    else {
      h.folded = fold;
      apply(h);
    }
  }

  /**
   * Folds a turn that just ended. The transcript gets shorter above the answer: the scroll moves by as much, so the
   * answer stays where the reader has it.
   */
  function foldKeepingPlace(h: Head): void {
    const nodes = nodesOf(h);
    const shape = shapeOf(nodes);
    const answer = nodes.find((n, i) => !shape.process[i] && nodeKind([...n.classList]) === 'text') ?? nodes[nodes.length - 1];
    const before = answer?.getBoundingClientRect().top;
    h.folded = true;
    apply(h);
    if (answer && before !== undefined) messagesEl.scrollTop += answer.getBoundingClientRect().top - before;
  }

  return {
    /**
     * A node went into the transcript (transcript.ts addNode). A call gives its turn the header; anything added to a
     * folded turn takes the fold.
     */
    nodeAdded(el: HTMLElement): void {
      const kind = nodeKind([...el.classList]);
      // A kept node is never hidden, and a user message starts a turn of its own
      if (kind === 'keep' || isUser(el)) return;
      const { head, after } = locate(el);
      if (head) {
        if (head.folded) apply(head);
        return;
      }
      if (kind !== 'call' || el.hidden) return;
      // The first call of the turn: the header goes over everything the turn has shown so far
      const first = after ? after.nextElementSibling : messagesEl.querySelector(':scope > :not(#empty-state)');
      const h = createHead(after, (first as Element | null) ?? el);
      if (running && !rendering) {
        h.liveSince = liveStart || Date.now();
        startTicking();
      } else {
        const user = after && isUser(after) ? (after as HTMLElement) : null;
        const ms = user?.dataset.worked !== undefined ? Number(user.dataset.worked) : NaN;
        h.workedMs = Number.isFinite(ms) ? ms : undefined;
      }
      apply(h);
    },
    /** A stored transcript is drawn (true) or done (false): every turn in it is over and folds as it should. */
    rendering(v: boolean): void {
      rendering = v;
      if (v) return;
      for (const h of allHeads()) {
        h.folded = foldsWhenDone(shapeOf(nodesOf(h)), summaryMode());
        apply(h);
      }
    },
    /**
     * The session on screen started or stopped running. `joined`: a run already going in a session just brought on
     * screen, whose turn going on began at `turnStartedAt` (or with the run); its header counts on and opens.
     */
    setRunning(v: boolean, startedAt = Date.now(), turnStartedAt?: number, joined = false): void {
      running = v;
      if (!v) return;
      liveStart = Math.max(startedAt, turnStartedAt ?? 0);
      if (!joined) return;
      // The last header belongs to the turn going on when no user message follows it
      const last = allHeads().pop();
      if (!last || last.liveSince !== undefined) return;
      for (let n = last.el.nextElementSibling; n; n = n.nextElementSibling) if (isUser(n)) return;
      last.liveSince = liveStart;
      last.folded = false;
      apply(last);
      startTicking();
    },
    /** A user message came in while the run goes on: the turn before it is over, the next one starts now. */
    turnStarted(): void {
      if (!running) return;
      liveStart = Date.now();
      for (const h of allHeads()) finish(h, 'done', false);
    },
    /** The run ended (run_end's reason): the counting header stops and its turn folds when it ended with an answer. */
    runEnded(reason: string | undefined): void {
      running = false;
      for (const h of allHeads()) finish(h, reason);
      tick();
    },
    /** Tool activity changed: each finished turn takes the fold its setting gives it. */
    refold(): void {
      for (const h of allHeads()) {
        if (h.liveSince !== undefined) continue;
        h.folded = foldsWhenDone(shapeOf(nodesOf(h)), summaryMode());
        apply(h);
      }
    },
    /** The transcript was cleared (whether a run goes on is set again by setRunning) */
    reset(): void {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    },
  };
}
