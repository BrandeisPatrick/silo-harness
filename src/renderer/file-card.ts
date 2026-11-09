// The compact card of a file in the chat, as Claude Code draws one: a page tile rising from the card's foot with the
// file's icon on it, the title, and "Document · MD" (or "Artifact · HTML") under it. The whole card opens the file;
// its few other actions (Reveal in Finder, Save as…) are small buttons at the right that show on hover and focus.
// Used by the artifact cards (artifacts.ts) and the document cards (chat-cards.ts).

import { escapeHtml } from './dom.js';
import { icon, type IconName } from './icons.js';

export interface FileCardAction {
  id: string;
  icon: IconName;
  /** The tooltip and the accessible name */
  label: string;
  /** Resolves to a short confirmation to show in the tooltip ("Saved"), true when done without one, false otherwise */
  run(button: HTMLButtonElement): Promise<string | boolean>;
}

export interface FileCardParts {
  el: HTMLElement;
  setTitle(title: string): void;
  setMeta(meta: string): void;
  setIcon(name: IconName): void;
  /** The quiet chip before the actions ("Updated"), or none */
  setChip(text: string | null): void;
}

export interface FileCardOptions {
  title: string;
  meta: string;
  icon: IconName;
  /** The tooltip of the whole card (the file's path) */
  tooltip?: string;
  className?: string;
  /** Opening it: the click on the card, Enter or Space */
  open(card: HTMLElement): Promise<boolean> | void;
  actions?: FileCardAction[];
}

export function createFileCard(opts: FileCardOptions): FileCardParts {
  const el = document.createElement('div');
  el.className = `file-card${opts.className ? ` ${opts.className}` : ''}`;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.innerHTML =
    `<span class="file-card-tile" aria-hidden="true"></span>` +
    `<span class="file-card-text"><span class="file-card-title"></span><span class="file-card-meta"></span></span>` +
    `<span class="file-card-chip" hidden></span>` +
    `<span class="file-card-actions">${(opts.actions ?? [])
      .map((a) => `<button type="button" class="icon-btn sm file-card-action" data-action="${escapeHtml(a.id)}" aria-label="${escapeHtml(a.label)}" data-tip="${escapeHtml(a.label)}">${icon(a.icon, 14)}</button>`)
      .join('')}</span>`;
  const tile = el.querySelector<HTMLElement>('.file-card-tile')!;
  const titleEl = el.querySelector<HTMLElement>('.file-card-title')!;
  const metaEl = el.querySelector<HTMLElement>('.file-card-meta')!;
  const chipEl = el.querySelector<HTMLElement>('.file-card-chip')!;
  if (opts.tooltip) el.title = opts.tooltip;

  let opening = false;
  const open = async () => {
    if (opening) return;
    opening = true;
    try {
      await opts.open(el);
    } finally {
      opening = false;
    }
  };
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.file-card-action')) return;
    void open();
  });
  el.addEventListener('keydown', (e) => {
    if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    void open();
  });

  for (const a of opts.actions ?? []) {
    const btn = el.querySelector<HTMLButtonElement>(`.file-card-action[data-action="${CSS.escape(a.id)}"]`)!;
    let reset: number | undefined;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      let res: string | boolean = false;
      try {
        res = await a.run(btn);
      } finally {
        btn.disabled = false;
      }
      if (typeof res === 'string' && res) {
        window.clearTimeout(reset);
        btn.classList.add('done');
        btn.innerHTML = icon('check', 14);
        reset = window.setTimeout(() => {
          btn.classList.remove('done');
          btn.innerHTML = icon(a.icon, 14);
        }, 1500);
      }
    });
  }

  const parts: FileCardParts = {
    el,
    setTitle: (t) => {
      titleEl.textContent = t;
      el.setAttribute('aria-label', `Open ${t}`);
    },
    setMeta: (m) => {
      metaEl.textContent = m;
    },
    setIcon: (name) => {
      tile.innerHTML = icon(name, 14);
    },
    setChip: (text) => {
      chipEl.hidden = !text;
      chipEl.textContent = text ?? '';
    },
  };
  parts.setTitle(opts.title);
  parts.setMeta(opts.meta);
  parts.setIcon(opts.icon);
  return parts;
}
