// Messages sent while a run is in progress wait in a queue above the status line until the agent picks them
// up after its current step (queue_delivered) or the run ends without them (queue_dropped).

import type { QueuedMessage } from '../shared/types';
import { escapeHtml } from './dom.js';
import { icon } from './icons.js';

export interface QueueList {
  /** Shows a row for the message (replaces the row of a message with the same id) */
  add(msg: QueuedMessage): void;
  /** Removes the row and returns the message, if it was queued */
  remove(id: string): QueuedMessage | undefined;
  get(id: string): QueuedMessage | undefined;
  /** Queued messages, oldest first */
  items(): QueuedMessage[];
  /** Removes every row and returns what was left */
  clear(): QueuedMessage[];
}

export interface QueueListOptions {
  /** #queue */
  root: HTMLElement;
  /** The row's ×: asks the main process to drop the message; resolves true when it was removed */
  unqueue: (msg: QueuedMessage, button: HTMLElement) => Promise<boolean>;
  /**
   * The row's "Send now": asks the main process to stop the current step and send this message at once; resolves true
   * when it will (the row then leaves through queue_delivered, or comes back to the composer through queue_dropped)
   */
  sendNow: (msg: QueuedMessage, button: HTMLElement) => Promise<boolean>;
  /** After rows were added or removed */
  onChange: () => void;
}

/** One line of the message for the row; the full text goes in the tooltip (capped so it stays readable). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function createQueueList(opts: QueueListOptions): QueueList {
  const { root } = opts;
  const messages = new Map<string, QueuedMessage>();

  const rowFor = (id: string) => root.querySelector<HTMLElement>(`.queue-item[data-id="${CSS.escape(id)}"]`);

  const sync = () => {
    root.hidden = messages.size === 0;
    opts.onChange();
  };

  const render = (msg: QueuedMessage): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.dataset.id = msg.id;
    el.setAttribute('role', 'listitem');
    const text = typeof msg.text === 'string' ? msg.text : '';
    const images = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
    const imageLabel = `${images} image${images === 1 ? '' : 's'}`;
    const line = oneLine(text);
    const tip = text.trim().length > 1200 ? `${text.trim().slice(0, 1200)}…` : text.trim();
    el.innerHTML =
      `<span class="queue-kicker">Queued</span>` +
      (line ? `<span class="queue-text" data-tip="${escapeHtml(tip)}">${escapeHtml(line)}</span>` : `<span class="queue-text muted">${escapeHtml(imageLabel)}</span>`) +
      (line && images ? `<span class="queue-meta">· ${escapeHtml(imageLabel)}</span>` : '') +
      `<button type="button" class="queue-send-now" aria-label="Send now" data-tip="Stops the current step and sends this message">Send now</button>` +
      `<button type="button" class="icon-btn sm queue-remove" aria-label="Remove from queue" data-tip="Remove from queue">${icon('x', 14)}</button>`;
    el.setAttribute('aria-label', `Queued: ${line || imageLabel}${line && images ? ` · ${imageLabel}` : ''}`);
    const btn = el.querySelector<HTMLButtonElement>('.queue-remove')!;
    btn.onclick = async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      let removed = false;
      try {
        removed = await opts.unqueue(msg, btn);
      } finally {
        btn.disabled = false;
      }
      if (removed) list.remove(msg.id);
    };
    const now = el.querySelector<HTMLButtonElement>('.queue-send-now')!;
    now.onclick = async () => {
      if (now.disabled) return;
      now.disabled = true;
      let sending = false;
      try {
        sending = await opts.sendNow(msg, now);
      } finally {
        // On its way: the button stays off until the row leaves; otherwise it can be tried again
        if (!sending) now.disabled = false;
      }
    };
    return el;
  };

  const list: QueueList = {
    add(msg: QueuedMessage) {
      if (!msg || typeof msg.id !== 'string' || !msg.id) return;
      const row = render(msg);
      const old = rowFor(msg.id);
      if (old) old.replaceWith(row);
      else root.appendChild(row);
      messages.set(msg.id, msg);
      sync();
    },
    remove(id: string) {
      const msg = messages.get(id);
      rowFor(id)?.remove();
      if (!msg) return undefined;
      messages.delete(id);
      sync();
      return msg;
    },
    get: (id: string) => messages.get(id),
    items: () => [...messages.values()],
    clear() {
      const left = [...messages.values()];
      messages.clear();
      root.querySelectorAll('.queue-item').forEach((n) => n.remove());
      sync();
      return left;
    },
  };
  root.hidden = true;
  return list;
}
