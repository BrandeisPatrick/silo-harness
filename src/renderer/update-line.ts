// The quiet update line above the sidebar's foot: "Update 0.14.0 available" with Download (the release page, in the
// default browser) and a close button that hides it for that version. The main process checks (src/main/updates.ts);
// this only shows what it found. Nothing here downloads anything.

import type { UpdateState } from '../shared/updates';
import { h } from './dom.js';
import { icon } from './icons.js';
import { onPush, rpc } from './rpc.js';

const DISMISSED_KEY = 'update.dismissed';

function dismissedVersion(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setupUpdateLine(sidebar: HTMLElement): void {
  const foot = sidebar.querySelector<HTMLElement>('.sidebar-foot');
  if (!foot) return;
  const label = h('span', { class: 'update-line-label' });
  const download = h('button', { type: 'button', class: 'link-btn update-line-download' }, 'Download');
  const close = h('button', { type: 'button', class: 'icon-btn sm update-line-close', 'aria-label': 'Dismiss', html: icon('x', 12) });
  const line = h('div', { class: 'update-line', role: 'status', hidden: true }, label, download, close);
  foot.before(line);
  let shown: string | null = null;

  const show = (s: UpdateState | null | undefined) => {
    const v = s?.available?.version ?? null;
    shown = v && v !== dismissedVersion() ? v : null;
    line.hidden = !shown;
    if (shown) label.textContent = `Update ${shown} available`;
  };
  download.addEventListener('click', () => void rpc('updates.open').catch(() => undefined));
  close.addEventListener('click', () => {
    if (!shown) return;
    try {
      localStorage.setItem(DISMISSED_KEY, shown);
    } catch {
      /* no storage: hidden until the next launch */
    }
    shown = null;
    line.hidden = true;
  });
  onPush('updates:changed', show);
  void rpc('updates.state').then(show, () => undefined);
}
