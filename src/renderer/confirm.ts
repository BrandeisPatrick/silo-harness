// The in-app confirmation dialog (Rewind, Revert, "Add to the project's instructions", …): one question at a time,
// answered with a promise.

import type { ConfirmOptions } from './changes.js';
import { byId, escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { closeMenu } from './popover.js';

export interface ConfirmDeps {
  dialog: HTMLDialogElement;
  /** The native browser view floats above the page; it is hidden while the dialog is open */
  hideBrowser(): void;
  /** The dialog closed: the browser view comes back */
  afterClose(): void;
}

export function createConfirmDialog({ dialog: confirmDialog, hideBrowser, afterClose }: ConfirmDeps): { confirmAction(opts: ConfirmOptions): Promise<boolean> } {
  /**
   * A small in-app confirmation (the native browser view is hidden while it is open). Danger: the warning badge, a red
   * button and the focus on Cancel; otherwise the accent badge with `icon` and the focus on the button.
   */
  function confirmAction(opts: ConfirmOptions): Promise<boolean> {
    if (confirmDialog.open) return Promise.resolve(false);
    closeMenu();
    byId('confirm-title').textContent = opts.title;
    const badge = confirmDialog.querySelector<HTMLElement>('.confirm-icon');
    if (badge) {
      badge.innerHTML = icon(opts.danger ? 'triangle-alert' : (opts.icon ?? 'info'));
      badge.classList.toggle('tone-accent', !opts.danger);
    }
    const quote = opts.quote && opts.quote.text ? opts.quote : null;
    const quoteEl = byId('confirm-quote');
    const quoteLabel = byId('confirm-quote-label');
    const quoteText = byId('confirm-quote-text');
    quoteEl.hidden = !quote;
    quoteEl.classList.toggle('mono', Boolean(quote?.mono));
    quoteLabel.innerHTML = quote?.label ? `${icon('file-text', 14)}<span>${escapeHtml(quote.label)}</span>` : '';
    quoteLabel.hidden = !quote?.label;
    quoteText.textContent = quote?.text ?? '';
    quoteText.scrollTop = 0;
    const desc = byId('confirm-desc');
    desc.textContent = opts.description ?? '';
    desc.hidden = !opts.description;
    const ok = byId<HTMLButtonElement>('confirm-ok');
    const cancel = byId<HTMLButtonElement>('confirm-cancel');
    ok.textContent = opts.confirmLabel;
    ok.className = `btn ${opts.danger ? 'danger' : 'primary'}`;
    hideBrowser();
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
  confirmDialog.addEventListener('close', afterClose);
  confirmDialog.addEventListener('click', (e) => {
    if (e.target === confirmDialog) confirmDialog.close();
  });

  return { confirmAction };
}
