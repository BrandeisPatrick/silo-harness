// The next-step card under a turn's final reply (the next_step tool, src/main/tools/next-step.ts): the recap in grey,
// the question, and one or two replies, the first the primary one with its ⌘↵ hint. A click on a reply sends its
// label as the user's next message; ⌘↵ with an empty chat bar picks the first. Once the user sends anything the card
// goes quiet: no buttons, the chosen reply marked. The model writes its reply after the call: the card follows it there. A stored card is always quiet (sessions.ts marks its chosen reply).
// Everything on it is the model's words, drawn as text, never markup. Wired from renderer.ts (setupNextStep).

import type { NextStep } from '../shared/next-step';
import { h } from './dom.js';
import { registerTranscriptItem } from './transcript-items.js';

// The tool checked these already (parseNextStep); the window keeps to them too, without refusing anything
const MAX_RECAP = 300;
const MAX_QUESTION = 100;
const MAX_REPLY = 40;
const RECOMMENDED = /\s*\(recommended\)\s*$/i;
const MAX_REPLIES = 2;

/** Plain text on one line, at most `max` characters. */
function plain(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('');
}

/** A card from a call's arguments (an object or its JSON), or null when it has no recap. */
export function cardOf(args: unknown): NextStep | null {
  let a: Record<string, unknown> = {};
  if (typeof args === 'string') {
    try {
      const v = JSON.parse(args) as unknown;
      if (v && typeof v === 'object') a = v as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (args && typeof args === 'object') a = args as Record<string, unknown>;
  const recap = plain(a.recap, MAX_RECAP);
  if (!recap) return null;
  const question = plain(a.question, MAX_QUESTION);
  const replies = question && Array.isArray(a.replies) ? a.replies.map((r) => plain(typeof r === 'string' ? r.replace(RECOMMENDED, '') : r, MAX_REPLY)).filter(Boolean).slice(0, MAX_REPLIES) : [];
  return { recap, question, replies };
}

interface Deps {
  messages: HTMLElement;
  /** Sends text as the user's next message, through the chat bar's own path */
  send(text: string): void;
  /** True when ⌘↵ may pick the first reply: nothing typed or attached, no dialog or menu open, no run going */
  canPick(e: KeyboardEvent): boolean;
}

/** The card that still has its buttons (the newest live one), if any */
let live: HTMLElement | null = null;

function quiet(card: HTMLElement, chosen?: string): void {
  card.classList.add('quiet');
  if (card === live) live = null;
  const key = chosen?.trim().toLowerCase();
  for (const b of card.querySelectorAll<HTMLButtonElement>('.next-step-reply')) {
    b.disabled = true;
    b.tabIndex = -1;
    const picked = !!key && b.dataset.reply?.toLowerCase() === key;
    b.classList.toggle('chosen', picked);
    if (picked) b.setAttribute('aria-pressed', 'true');
  }
}

/** Puts the card under a reply's words, above its actions row. False when the reply has no actions row. */
function attach(card: HTMLElement, reply: Element): boolean {
  const actions = reply.querySelector(':scope > .msg-actions');
  if (!actions) return false;
  const from = card.parentElement;
  reply.insertBefore(card, actions);
  if (from && from !== reply) from.classList.remove('has-next-step');
  reply.classList.add('has-next-step');
  return true;
}

function cardEl(step: NextStep, interactive: boolean, chosen: string | undefined, deps: Deps): HTMLElement {
  const card = h('div', { class: 'next-step', role: 'group', 'aria-label': 'Next step' }, h('p', { class: 'next-step-recap' }, step.recap));
  if (step.question) card.appendChild(h('p', { class: 'next-step-question' }, step.question));
  if (step.replies.length) {
    const row = h('div', { class: 'next-step-replies' });
    step.replies.forEach((label, i) => {
      const b = h('button', { type: 'button', class: `btn next-step-reply${i === 0 ? ' primary' : ''}`, 'data-reply': label }, h('span', {}, label));
      if (i === 0) b.appendChild(h('span', { class: 'next-step-keys', 'aria-hidden': 'true' }, h('kbd', {}, '⌘'), h('kbd', {}, '↵')));
      b.addEventListener('click', () => {
        if (card !== live) return;
        quiet(card, label);
        deps.send(label);
      });
      row.appendChild(b);
    });
    card.appendChild(row);
  }
  if (interactive && step.replies.length) {
    if (live) quiet(live);
    live = card;
  } else quiet(card, chosen);
  return card;
}

export function setupNextStep(deps: Deps): void {
  registerTranscriptItem('next_step', (item) => {
    const step = item.live === true ? cardOf(item.args) : cardOf((item as { step?: unknown }).step);
    if (!step) return null;
    const chosen = typeof item.chosen === 'string' ? item.chosen : undefined;
    const card = cardEl(step, item.live === true, chosen, deps);
    // Under the reply it closes, above that reply's Copy row; on its own when no reply came right before it. The
    // reply usually comes after the call: the card then moves under it (below).
    const reply = deps.messages.lastElementChild;
    if (!reply?.matches('.msg.assistant') || !attach(card, reply)) return card;
    return null;
  });
  // Anything the user sends after the card (typed, queued, from the phone) quiets it; a reply's label marks that reply
  /** A reply after a card in the same turn (the model calls next_step, then writes its reply): the card goes under it */
  const followReply = (reply: HTMLElement): void => {
    // The nearest card before it in its turn (back to the user's message), on its own or under an earlier reply
    for (let n = reply.previousElementSibling; n && !n.matches('.msg.user'); n = n.previousElementSibling) {
      const card = n.matches('.next-step') ? (n as HTMLElement) : n.querySelector<HTMLElement>(':scope > .next-step');
      if (card) {
        if (reply.isConnected) attach(card, reply);
        return;
      }
    }
  };
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.matches('.msg.user') && live) quiet(live, n.querySelector('.bubble')?.textContent ?? '');
        else if (n.matches('.msg.assistant')) followReply(n);
      }
      for (const n of r.removedNodes) if (n instanceof HTMLElement && live && n.contains(live)) live = null;
    }
  }).observe(deps.messages, { childList: true });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
      const card = live;
      if (!card?.isConnected || !deps.canPick(e)) return;
      const first = card.querySelector<HTMLButtonElement>('.next-step-reply');
      if (!first) return;
      e.preventDefault();
      e.stopPropagation();
      first.click();
    },
    true,
  );
}

export const nextStepDebug = { live: () => live };
