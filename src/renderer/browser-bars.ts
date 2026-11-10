// The Browser pane's safety chrome, drawn by the window (never by the page, so none of it is in browser_screenshot):
// the bars under the URL bar (a page asking for the camera or notifications, Chrome's three answers; a download the
// agent started, Allow or Don't allow), the interstitial over the view's slot when the active tab stopped at a
// certificate error, the mark at the left of the URL pill (a lock, "Not secure", the amber triangle), and the
// downloads tray at the right of the browser bar with its popover list. The bars sit in the pane's column above the
// view's slot, so the slot (and the native view glued to it) shrinks while one shows. The popover would sit under the
// native view, which paints above the window's page: while it is open the view is hidden, as for a dialog.
// side-pane.ts creates this and feeds it the browser state.

import type { BrowserState, DownloadAction, DownloadState, PermissionAnswer, PermissionRequestState, TabState } from '../shared/browser';
import { formatBytes, h } from './dom.js';
import { icon, type IconName } from './icons.js';
import { onPush, rpc } from './rpc.js';

export interface BrowserBarsDeps {
  /** Where the bars go: between the URL bar (and its note) and the view's slot */
  bars: HTMLElement;
  /** The interstitial, inside the view's slot */
  interstitial: HTMLElement;
  /** The mark at the left of the URL pill */
  urlIcon: HTMLElement;
  trayButton: HTMLButtonElement;
  tray: HTMLElement;
  /** The tray's popover opened or closed: the native view must hide under it, and come back */
  onOverlay(open: boolean): void;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
}

const LOCK = '<svg class="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.25" y="7" width="9.5" height="6.75" rx="1.5"/><path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7"/></svg>';

const PERMISSION_ICONS: Record<string, IconName> = { media: 'camera', notifications: 'message', 'clipboard-read': 'clipboard', openExternal: 'external-link', 'display-capture': 'panel-right', fileSystem: 'folder' };

/** "The agent started a download: report.pdf (1.2 MB) from example.com"; "A page started …" when no browser tool was acting */
export function agentDownloadSentence(d: Pick<DownloadState, 'filename' | 'total' | 'host' | 'fromPage'>): string {
  return `${d.fromPage ? 'A page' : 'The agent'} started a download: ${d.filename}${d.total > 0 ? ` (${formatBytes(d.total)})` : ''}${d.host ? ` from ${d.host}` : ''}`;
}

/** The second line of a download in the tray. */
function downloadMeta(d: DownloadState): string {
  const where = d.host || 'this page';
  if (d.asking) return `${where} · Waiting for your answer`;
  switch (d.state) {
    case 'completed':
      return `${where} · ${formatBytes(d.total || d.received)}`;
    case 'progressing':
    case 'paused':
      return `${where} · ${d.total > 0 ? `${formatBytes(d.received)} of ${formatBytes(d.total)}` : formatBytes(d.received)}${d.state === 'paused' ? ' · Paused' : ''}`;
    case 'cancelled':
      return `${where} · Cancelled`;
    default:
      return `${where} · Failed`;
  }
}

export function createBrowserBars(o: BrowserBarsDeps) {
  let state: BrowserState | null = null;
  let requests: PermissionRequestState[] = [];
  let downloads: DownloadState[] = [];
  let trayOpen = false;
  /** A download finished since the tray was last opened (the dot on the tray button) */
  let unseen = false;
  const finished = new Set<string>();
  /** The first list has arrived (what it held does not count as newly finished) */
  let seeded = false;

  const activeTab = (): TabState | null => state?.tabs.find((t) => t.id === state!.activeId) ?? null;

  // ---------- The bars ----------

  function barElement(kind: 'permission' | 'download', id: string, iconName: IconName, text: string, answers: { label: string; value: string; primary?: boolean }[]): HTMLElement {
    const el = h('div', { class: `browser-ask ${kind}`, role: 'region', 'aria-label': kind === 'permission' ? 'Permission request' : 'Download request', 'data-kind': kind, 'data-id': id });
    const textEl = h('span', { class: 'browser-ask-text', title: text }, text);
    const actions = h('span', { class: 'browser-ask-actions' });
    for (const a of answers) {
      const b = h('button', { type: 'button', class: `browser-ask-btn${a.primary ? ' primary' : ''}`, 'data-answer': a.value }, a.label);
      actions.append(b);
    }
    // The icon stays with the sentence; when both and the answers do not fit in one row, the answers go under them.
    el.append(h('span', { class: 'browser-ask-main' }, h('span', { class: 'browser-ask-icon', 'aria-hidden': 'true', html: icon(iconName, 16) }), textEl), actions);
    return el;
  }

  /** The bars of the active tab: its oldest permission request, then a download of the agent's waiting for an answer. */
  function renderBars(): void {
    const tab = activeTab();
    const tabIds = new Set((state?.tabs ?? []).map((t) => t.id));
    const req = tab ? requests.find((r) => r.tabId === tab.id) : undefined;
    const dl = downloads.find((d) => d.asking && (d.tabId === tab?.id || !d.tabId || !tabIds.has(d.tabId)));
    const want: { key: string; make: () => HTMLElement }[] = [];
    if (req) {
      const text = `${req.site} wants to ${req.phrase}`;
      want.push({
        key: `permission:${req.id}`,
        make: () =>
          barElement('permission', req.id, PERMISSION_ICONS[req.permission] ?? 'info', text, [
            { label: 'Allow this time', value: 'once' },
            { label: 'Allow every time', value: 'always' },
            { label: "Don't allow", value: 'deny', primary: true },
          ]),
      });
    }
    if (dl) {
      want.push({
        key: `download:${dl.id}`,
        make: () =>
          barElement('download', dl.id, 'download', agentDownloadSentence(dl), [
            { label: 'Allow', value: 'allow' },
            { label: "Don't allow", value: 'deny', primary: true },
          ]),
      });
    }
    // Keep a bar that is still wanted (its focus stays); replace the rest.
    const keys = want.map((w) => w.key);
    for (const el of [...o.bars.children] as HTMLElement[]) if (!keys.includes(`${el.dataset.kind}:${el.dataset.id}`)) el.remove();
    want.forEach((w, i) => {
      let el = o.bars.querySelector<HTMLElement>(`[data-kind="${w.key.split(':')[0]}"][data-id="${CSS.escape(w.key.slice(w.key.indexOf(':') + 1))}"]`);
      if (!el) el = w.make();
      const at = o.bars.children.item(i);
      if (at !== el) o.bars.insertBefore(el, at);
    });
    // The download bar's size arrives after it begins
    if (dl) {
      const textEl = o.bars.querySelector<HTMLElement>('.browser-ask.download .browser-ask-text');
      const text = agentDownloadSentence(dl);
      if (textEl && textEl.textContent !== text) {
        textEl.textContent = text;
        textEl.title = text;
      }
    }
    o.bars.hidden = want.length === 0;
  }

  async function answer(bar: HTMLElement, value: string): Promise<void> {
    const id = bar.dataset.id ?? '';
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (bar.dataset.kind === 'permission') {
        await rpc('browser.answerPermission', id, value as PermissionAnswer);
        requests = requests.filter((r) => r.id !== id);
      } else {
        downloads = await rpc('browser.downloadAction', id, value as DownloadAction);
      }
      renderBars();
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      o.showError(bar, `Couldn't answer: ${o.cleanError(err)}`);
    }
  }

  o.bars.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-answer]');
    const bar = btn?.closest<HTMLElement>('.browser-ask');
    if (btn && bar) void answer(bar, btn.dataset.answer!);
  });
  // Escape answers Don't allow while a bar has the focus.
  o.bars.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const bar = (e.target as HTMLElement).closest<HTMLElement>('.browser-ask');
    if (!bar) return;
    e.preventDefault();
    e.stopPropagation();
    void answer(bar, 'deny');
  });

  // ---------- The interstitial ----------

  const ix = {
    host: h('strong', {}),
    reason: h('span', {}),
    code: h('p', { class: 'ix-code' }),
    back: h('button', { type: 'button', class: 'btn primary ix-back' }, 'Go back'),
    proceed: h('button', { type: 'button', class: 'ix-proceed' }, 'Proceed anyway (unsafe)'),
  };
  o.interstitial.replaceChildren(
    h(
      'div',
      { class: 'ix-body' },
      h('span', { class: 'ix-icon', 'aria-hidden': 'true', html: icon('triangle-alert', 32) }),
      h('h2', { class: 'ix-title' }, 'This connection is not private'),
      h('p', { class: 'ix-text' }, ix.host, ' may not be the site it says it is. ', ix.reason),
      ix.code,
      h('div', { class: 'ix-actions' }, ix.back),
      ix.proceed,
    ),
  );
  const certAct = async (btn: HTMLElement, method: 'browser.certBack' | 'browser.certProceed') => {
    const tab = activeTab();
    if (!tab?.certError) return;
    try {
      await rpc(method, tab.id);
    } catch (err) {
      o.showError(btn, `Couldn't do that: ${o.cleanError(err)}`);
    }
  };
  ix.back.addEventListener('click', () => void certAct(ix.back, 'browser.certBack'));
  ix.proceed.addEventListener('click', () => void certAct(ix.proceed, 'browser.certProceed'));

  function renderInterstitial(): void {
    const e = activeTab()?.certError ?? null;
    o.interstitial.hidden = !e;
    if (!e) return;
    ix.host.textContent = e.host || 'This site';
    ix.reason.textContent = `${e.reason}.`;
    ix.code.textContent = e.reason === e.code ? '' : e.code;
    ix.code.hidden = !ix.code.textContent;
  }

  // ---------- The URL pill's mark ----------

  let shownSecurity = '';
  function renderSecurity(): void {
    const tab = activeTab();
    const sec = tab && !tab.certError ? tab.security : 'none';
    if (sec === shownSecurity) return;
    shownSecurity = sec;
    o.urlIcon.dataset.security = sec;
    o.urlIcon.classList.toggle('text', sec === 'insecure');
    if (sec === 'secure') {
      o.urlIcon.innerHTML = LOCK;
      o.urlIcon.dataset.tip = 'Secure connection';
      o.urlIcon.setAttribute('aria-label', 'Secure connection');
    } else if (sec === 'insecure') {
      o.urlIcon.textContent = 'Not secure';
      o.urlIcon.dataset.tip = 'Connection is not secure';
      o.urlIcon.setAttribute('aria-label', 'Not secure');
    } else if (sec === 'proceeded') {
      o.urlIcon.innerHTML = icon('triangle-alert', 14);
      o.urlIcon.dataset.tip = 'Invalid certificate, you proceeded';
      o.urlIcon.setAttribute('aria-label', 'Certificate not valid');
    } else {
      o.urlIcon.innerHTML = icon('globe', 14);
      delete o.urlIcon.dataset.tip;
      o.urlIcon.removeAttribute('aria-label');
    }
    o.urlIcon.setAttribute('role', sec === 'none' ? 'presentation' : 'img');
  }

  // ---------- The downloads tray ----------

  const RING_R = 12;
  const RING_C = 2 * Math.PI * RING_R;
  o.trayButton.innerHTML = `${icon('download', 16)}<svg class="tray-ring" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><circle class="tray-ring-track" cx="14" cy="14" r="${RING_R}"/><circle class="tray-ring-fill" cx="14" cy="14" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/></svg><span class="busy-dot tray-dot" hidden></span>`;
  const ring = o.trayButton.querySelector<SVGElement>('.tray-ring')!;
  const ringFill = o.trayButton.querySelector<SVGCircleElement>('.tray-ring-fill')!;
  const dot = o.trayButton.querySelector<HTMLElement>('.tray-dot')!;

  function renderTrayButton(): void {
    o.trayButton.hidden = downloads.length === 0;
    const running = downloads.filter((d) => (d.state === 'progressing' || d.state === 'paused') && !d.asking);
    ring.classList.toggle('show', running.length > 0);
    const total = running.reduce((n, d) => n + d.total, 0);
    const known = running.length > 0 && running.every((d) => d.total > 0);
    ring.classList.toggle('indeterminate', running.length > 0 && !known);
    const frac = known && total > 0 ? Math.min(1, running.reduce((n, d) => n + d.received, 0) / total) : 0.25;
    ringFill.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(2));
    dot.hidden = !unseen || trayOpen;
    const label = running.length ? `Downloads, ${running.length} in progress` : unseen ? 'Downloads, new finished download' : 'Downloads';
    o.trayButton.setAttribute('aria-label', label);
    o.trayButton.setAttribute('aria-expanded', String(trayOpen));
  }

  function actionButton(name: IconName, label: string, action: DownloadAction, id: string): HTMLButtonElement {
    return h('button', { type: 'button', class: 'icon-btn sm dl-act', 'aria-label': label, 'data-tip': label, 'data-action': action, 'data-id': id, html: icon(name, 14) });
  }

  function renderTray(): void {
    const list = h('div', { class: 'dl-list', role: 'list' });
    for (const d of downloads) {
      const item = h('div', { class: `dl-item ${d.state}${d.asking ? ' asking' : ''}`, role: 'listitem', 'data-id': d.id });
      const text = h('div', { class: 'dl-text' }, h('div', { class: 'dl-name', title: d.path || d.filename }, d.filename), h('div', { class: 'dl-meta' }, downloadMeta(d)));
      if ((d.state === 'progressing' || d.state === 'paused') && !d.asking) {
        const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
        const bar = h('div', { class: `dl-progress${d.total > 0 ? '' : ' indeterminate'}`, role: 'progressbar', 'aria-label': `${d.filename} progress`, 'aria-valuemin': '0', 'aria-valuemax': '100', ...(d.total > 0 ? { 'aria-valuenow': String(pct) } : {}) }, h('span', { style: `width:${d.total > 0 ? pct : 30}%` }));
        text.append(bar);
      }
      const actions = h('div', { class: 'dl-actions' });
      if (d.state === 'completed' && d.path) actions.append(actionButton('external-link', 'Open', 'open', d.id), actionButton('folder', 'Show in Finder', 'show', d.id));
      if (d.state === 'progressing' || d.state === 'paused' || d.asking) actions.append(actionButton('x', 'Cancel', 'cancel', d.id));
      item.append(h('span', { class: 'dl-icon', 'aria-hidden': 'true', html: icon('file', 16) }), text, actions);
      list.append(item);
    }
    const finishedAny = downloads.some((d) => d.state !== 'progressing' && d.state !== 'paused' && !d.asking);
    const clear = h('button', { type: 'button', class: 'dl-clear', disabled: !finishedAny }, 'Clear');
    o.tray.replaceChildren(h('div', { class: 'pop-label' }, 'Downloads'), downloads.length ? list : h('div', { class: 'pop-note' }, 'No downloads.'), h('div', { class: 'dl-foot' }, clear));
  }

  function placeTray(): void {
    const r = o.trayButton.getBoundingClientRect();
    o.tray.style.top = `${Math.round(r.bottom + 6)}px`;
    o.tray.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }

  function openTray(): void {
    if (trayOpen) return;
    trayOpen = true;
    unseen = false;
    renderTray();
    o.tray.hidden = false;
    placeTray();
    o.onOverlay(true);
    renderTrayButton();
    o.tray.focus({ preventScroll: true });
  }

  function closeTray(refocus = false): void {
    if (!trayOpen) return;
    trayOpen = false;
    o.tray.hidden = true;
    o.onOverlay(false);
    renderTrayButton();
    if (refocus) o.trayButton.focus();
  }

  o.trayButton.addEventListener('click', () => (trayOpen ? closeTray() : openTray()));
  o.tray.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeTray(true);
  });
  document.addEventListener('mousedown', (e) => {
    if (!trayOpen) return;
    const t = e.target as Node;
    if (!o.tray.contains(t) && !o.trayButton.contains(t)) closeTray();
  });
  window.addEventListener('resize', () => trayOpen && placeTray());
  o.tray.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.dl-clear')) {
      try {
        setDownloads(await rpc('browser.downloadAction', '', 'clear'));
      } catch (err) {
        o.showError(target, `Couldn't clear the list: ${o.cleanError(err)}`);
      }
      return;
    }
    const btn = target.closest<HTMLButtonElement>('button[data-action]');
    if (!btn) return;
    try {
      setDownloads(await rpc('browser.downloadAction', btn.dataset.id!, btn.dataset.action as DownloadAction));
    } catch (err) {
      o.showError(btn, o.cleanError(err));
    }
  });

  function setDownloads(list: DownloadState[]): void {
    const next = Array.isArray(list) ? list : [];
    for (const d of next) {
      if (d.state === 'completed' && !finished.has(d.id)) {
        // A download that finishes while the tray is closed gets the dot (not the ones the list held at start-up)
        if (seeded && !trayOpen) unseen = true;
        finished.add(d.id);
      }
    }
    downloads = next;
    renderBars();
    renderTrayButton();
    if (trayOpen) {
      if (downloads.length) renderTray();
      else closeTray();
    }
  }

  // ---------- State ----------

  onPush('browser:permissions', (list) => {
    requests = Array.isArray(list) ? list : [];
    renderBars();
  });
  onPush('browser:downloads', (list) => setDownloads(list));
  void Promise.all([rpc('browser.permissions').catch(() => [] as PermissionRequestState[]), rpc('browser.downloads').catch(() => [] as DownloadState[])]).then(([perms, dls]) => {
    requests = perms;
    setDownloads(dls);
    seeded = true;
    renderBars();
  });

  function applyState(s: BrowserState): void {
    state = s;
    renderBars();
    renderInterstitial();
    renderSecurity();
  }

  return {
    applyState,
    /** The tray's popover is open (the native view hides under it) */
    overlayOpen: () => trayOpen,
    closeTray: () => closeTray(),
    /** For the live checks: what the bars, the interstitial, the pill and the tray show */
    debug: () => ({
      bars: [...o.bars.querySelectorAll<HTMLElement>('.browser-ask')].map((b) => ({ kind: b.dataset.kind ?? '', id: b.dataset.id ?? '', text: b.querySelector('.browser-ask-text')?.textContent ?? '', buttons: [...b.querySelectorAll('button')].map((x) => x.textContent ?? ''), height: b.getBoundingClientRect().height })),
      requests: requests.map((r) => ({ ...r })),
      interstitial: o.interstitial.hidden ? null : { title: o.interstitial.querySelector('.ix-title')?.textContent ?? '', text: o.interstitial.querySelector('.ix-text')?.textContent ?? '', code: ix.code.textContent ?? '', buttons: [...o.interstitial.querySelectorAll('button')].map((x) => x.textContent ?? '') },
      security: o.urlIcon.dataset.security ?? 'none',
      securityText: o.urlIcon.textContent ?? '',
      tray: { shown: !o.trayButton.hidden, open: trayOpen, dot: !dot.hidden, ring: ring.classList.contains('show'), items: trayOpen ? [...o.tray.querySelectorAll<HTMLElement>('.dl-item')].map((el) => ({ id: el.dataset.id ?? '', name: el.querySelector('.dl-name')?.textContent ?? '', meta: el.querySelector('.dl-meta')?.textContent ?? '' })) : [] },
      downloads: downloads.map((d) => ({ ...d })),
    }),
  };
}
