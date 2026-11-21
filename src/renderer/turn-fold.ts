// The header over a turn's working process, and the fold. A turn that makes a tool call gets one quiet line at the top
// of its output, "Working for 18s" while it runs and "Worked for 53s" after, with a hairline under it. When the turn
// ends with an answer the process (interim replies, thinking, tool groups and rows) is hidden and the line is the
// button that shows it again; the answer, cards, images, notices and anything still waiting for the user stay. With
// Tool activity set to Every call nothing folds by itself; the line still toggles. What counts as process is in
// turn-fold-model.ts. The transcript stays flat: the nodes are hidden with a class, never moved.

import type { AppConfig } from '../shared/types';
import { icon } from './icons.js';
import { activityWords, type ActivityCall } from './tool-activity.js';
import { foldLine, foldWords, foldsWhenDone, nodeKind, turnShape, type TurnShape } from './turn-fold-model.js';

export interface TurnFoldDeps {
  messages: HTMLElement;
  config(): AppConfig | undefined;
}

interface Head {
  el: HTMLElement;
  btn: HTMLButtonElement;
  label: HTMLElement;
  /** What the turn did, in words ("Ran 3 commands, read 2 files"), once it is over */
  words: string;
  /** The calls Auto mode blocked in the turn (their rows fold with the rest) */
  blocked: number;
  /** Counting: when the turn began (the header ticks) */
  liveSince?: number;
  /** How long the turn worked, once it is over (undefined: not known, "Worked") */
  workedMs?: number;
  folded: boolean;
}

const HIDDEN = 'turn-hidden';

/** The calls a turn made, as the fold line counts them: rows, the rows inside its groups, messages it sent */
function callsOf(nodes: HTMLElement[]): ActivityCall[] {
  const rows = nodes.flatMap((n) => {
    if (n.hidden) return [];
    if (n.classList.contains('tool-group')) return [...n.querySelectorAll<HTMLElement>(':scope > .group-body > :is(.tool, .session-msg.sent)')];
    return n.classList.contains('tool') || (n.classList.contains('session-msg') && n.classList.contains('sent')) ? [n] : [];
  });
  return rows
    .filter((r) => !r.hidden && r.dataset.tool)
    .map((r) => ({ name: r.dataset.tool!, path: r.dataset.path, url: r.dataset.url, created: r.dataset.created === 'true', denied: r.classList.contains('denied'), server: r.dataset.server }));
}

export function createTurnFold({ messages: messagesEl, config }: TurnFoldDeps) {
  const heads = new WeakMap<HTMLElement, Head>();
  /** A stored transcript is being drawn: its turns are over */
  let rendering = false;
  let running = false;
  /** When the turn going on now began */
  let liveStart = 0;
  let timer: number | undefined;

  const summaryMode = () => (config()?.toolActivity ?? 'summary') !== 'all';

  // Runs of calls fold into groups by moving nodes (tool-groups.ts), not through nodeAdded: the cards' marks and the
  // words follow the transcript's children, at most once a frame
  let pending = 0;
  new MutationObserver(() => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      for (const h of allHeads()) apply(h);
    });
  }).observe(messagesEl, { childList: true });
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
    const line = foldLine(live, live ? Date.now() - h.liveSince! : h.workedMs, h.words, h.blocked);
    // "Ran 3 commands, read 2 files · 1 blocked · 2m 10s"; with nothing to name, "Worked for 2m 10s · 1 blocked"
    const parts: HTMLElement[] = [];
    const part = (text: string, cls = '') => {
      if (!text) return;
      const el = document.createElement('span');
      if (cls) el.className = cls;
      el.textContent = text;
      parts.push(el);
    };
    if (line.words) {
      part(line.words, 'turn-head-words');
      part(line.blocked, 'turn-head-blocked');
      part(line.time, 'turn-head-time');
    } else {
      part(line.time, 'turn-head-time');
      part(line.blocked, 'turn-head-blocked');
    }
    const want = parts.map((p) => `${p.className}:${p.textContent}`).join('|');
    if (h.label.dataset.parts !== want) {
      h.label.dataset.parts = want;
      h.label.replaceChildren(...parts.flatMap((p, i) => (i ? [document.createTextNode(' · '), p] : [p])));
    }
    h.el.classList.toggle('live', live);
    h.btn.disabled = live;
    h.btn.setAttribute('aria-expanded', String(!h.folded));
    h.el.classList.toggle('folded', h.folded);
  }

  /** Shows a group's calls as rows of their own (opening it without its line), or gives the group its line back. */
  function flatten(g: HTMLDetailsElement, on: boolean): void {
    if (g.classList.contains('flat') === on) return;
    g.classList.toggle('flat', on);
    if (on) {
      if (!g.open) {
        g.dataset.flatOpened = 'true';
        g.open = true;
      }
    } else if (g.dataset.flatOpened) {
      delete g.dataset.flatOpened;
      g.open = false;
    }
  }

  /** Hides or shows the turn's process to match the header. */
  function apply(h: Head): void {
    const nodes = nodesOf(h);
    const shape = shapeOf(nodes);
    nodes.forEach((n, i) => {
      const hide = h.folded && shape.process[i];
      // A row shown again by unfolding is not new: it does not fade in a second time (a fade would restart here)
      if (!hide && n.classList.contains(HIDDEN)) n.classList.remove('fade-in');
      n.classList.toggle(HIDDEN, hide);
    });
    h.blocked = nodes.filter((n) => n.classList.contains('auto-blocked')).length;
    h.words = foldWords(activityWords(callsOf(nodes)).phrases);
    // Unfolded, the process sits in one card: each run of it (between kept nodes) is marked, with its ends
    const act = nodes.map((n, i) => shape.process[i] && !n.hidden);
    const shown = nodes.map((n) => !n.hidden);
    let any = false;
    nodes.forEach((n, i) => {
      const on = act[i];
      any ||= on;
      let prev = i - 1;
      while (prev >= 0 && !shown[prev]) prev--;
      let next = i + 1;
      while (next < nodes.length && !shown[next]) next++;
      n.classList.toggle('turn-act', on);
      n.classList.toggle('turn-act-first', on && !(prev >= 0 && act[prev]));
      n.classList.toggle('turn-act-last', on && !(next < nodes.length && act[next]));
    });
    h.el.classList.toggle('has-card', any && !h.folded);
    // A finished turn whose activity is one group: unfolded, the card's rows are that group's calls themselves (its
    // line would only repeat the header's words). Several groups (text between them) keep their lines; so does a
    // turn still running.
    const groups = nodes.filter((n, i) => act[i] && n.classList.contains('tool-group'));
    for (const g of nodes.filter((n) => n.classList.contains('tool-group'))) flatten(g as HTMLDetailsElement, g === groups[0] && groups.length === 1 && !h.folded && h.liveSince === undefined && !g.classList.contains('live'));
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
    const h: Head = { el, btn, label: el.querySelector<HTMLElement>('.turn-head-label')!, words: '', blocked: 0, folded: false };
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
        apply(head);
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
