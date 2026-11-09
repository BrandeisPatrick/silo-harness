// Auto mode's blocked actions in the window: the quiet line that stands for a call the safety check blocked ("Auto mode
// blocked git push --force · Allow"), and Settings → Permissions → Recently blocked. Allow lets the action run once when
// the agent tries it again (the agent is told it may). Wired from renderer.ts (setupAutoBlocked) and
// settings/config-sections.ts (recentlyBlocked); the rest arrives through the bus and the transcript item registry.

import type { AutoBlock, RecentBlock } from '../shared/auto-mode';
import { bus } from './bus.js';
import { escapeHtml, h } from './dom.js';
import { icon } from './icons.js';
import { rpc } from './rpc.js';
import type { Ctx } from './settings/ctx.js';
import { button, note, row } from './settings/ui.js';
import { appendTranscriptItem, registerTranscriptItem } from './transcript-items.js';

/** The transcript (#messages): where the call's row is found and hidden. */
let messages: HTMLElement | null = null;

export function setupAutoBlocked(d: { messages: HTMLElement }): void {
  messages = d.messages;
  registerTranscriptItem('auto_blocked', (item) => {
    const b = (item as { block?: AutoBlock }).block;
    if (!b || typeof b.id !== 'string') return null;
    const el = lineEl(b);
    // A live block can be allowed; a stored one only when the main process still knows it (this app session)
    if (item.live === true) setEnd(el, b.allowed ? 'allowed' : 'allow');
    else void known(b.sessionId).then((list) => {
      const k = list.find((x) => x.id === b.id);
      if (k) setEnd(el, k.allowed ? 'allowed' : 'allow');
    });
    return el;
  });
  bus.on('agent-event', (ev, sessionId, onScreen) => {
    if (ev.type === 'auto_blocked' && ev.block && onScreen) {
      // The call's row gives way to the line (its tool_end follows and settles the run around it)
      const row = d.messages.querySelector<HTMLElement>(`.tool[data-call-id="${CSS.escape(ev.block.id)}"]`);
      if (row) row.hidden = true;
      appendTranscriptItem({ role: 'auto_blocked', block: ev.block, live: true });
    } else if (ev.type === 'auto_allowed') {
      for (const el of linesOf(sessionId, ev.id)) setEnd(el, 'allowed');
    }
  });
}

/** The blocks the main process still knows for a session (one lookup for every line of a transcript). */
const lookups = new Map<string, Promise<RecentBlock[]>>();
function known(sessionId: string): Promise<RecentBlock[]> {
  let p = lookups.get(sessionId);
  if (!p) {
    p = rpc('auto.blocked', sessionId).then((l) => (Array.isArray(l) ? l : []), () => []);
    lookups.set(sessionId, p);
    void p.then(() => setTimeout(() => lookups.delete(sessionId), 1000));
  }
  return p;
}

function linesOf(sessionId: string, id: string): HTMLElement[] {
  if (!messages) return [];
  return [...messages.querySelectorAll<HTMLElement>(`.auto-blocked[data-block-id="${CSS.escape(id)}"]`)].filter((el) => el.dataset.sessionId === sessionId);
}

function lineEl(b: AutoBlock): HTMLElement {
  const el = document.createElement('div');
  el.className = 'auto-blocked';
  el.dataset.blockId = b.id;
  el.dataset.sessionId = b.sessionId;
  el.innerHTML =
    `<span class="auto-blocked-icon">${icon('shield-off', 16)}</span>` +
    `<span class="auto-blocked-words" data-tip="${escapeHtml(b.reason)}">Auto mode blocked <span class="auto-blocked-what">${escapeHtml(b.what)}</span></span>` +
    `<span class="auto-blocked-end"></span>`;
  el.setAttribute('aria-label', `Auto mode blocked ${b.what}: ${b.reason}`);
  return el;
}

/** What follows the words: Allow, Allowed, or nothing. */
function setEnd(el: HTMLElement, state: 'allow' | 'allowed' | null): void {
  const end = el.querySelector<HTMLElement>('.auto-blocked-end')!;
  end.replaceChildren();
  el.classList.toggle('allowed', state === 'allowed');
  if (!state) return;
  end.insertAdjacentHTML('beforeend', '<span class="auto-blocked-sep" aria-hidden="true">·</span>');
  if (state === 'allowed') {
    end.insertAdjacentHTML('beforeend', '<span class="auto-blocked-done">Allowed</span>');
    return;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'auto-blocked-allow';
  btn.textContent = 'Allow';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const r = await rpc('auto.allow', el.dataset.sessionId ?? '', el.dataset.blockId ?? '').catch(() => null);
    if (r?.ok) setEnd(el, 'allowed');
    else if (r) setEnd(el, null);
    else btn.disabled = false;
  });
  end.append(btn);
}

// ---------- Settings → Permissions → Recently blocked ----------

/** The list of the latest blocks of every session, each with Allow; refreshed when Settings opens and as blocks come. */
export function recentlyBlocked(ctx: Ctx): { el: HTMLElement; refresh(): Promise<void> } {
  const el = h('div', { class: 'sp-rows auto-blocked-list' });
  let seq = 0;
  async function refresh(): Promise<void> {
    const mine = ++seq;
    let list: RecentBlock[] = [];
    try {
      const got = await ctx.call('auto.blocked');
      list = Array.isArray(got) ? got : [];
    } catch {
      list = [];
    }
    if (mine === seq) render(list);
  }
  function render(list: RecentBlock[]): void {
    el.replaceChildren();
    list.forEach((b, i) => {
      const done = h('span', { class: 'sp-row-desc' }, 'Allowed');
      const r = row(
        { id: `auto-blocked-${i}`, title: b.what, desc: b.sessionTitle ? `${b.reason} · ${b.sessionTitle}` : b.reason, keywords: 'auto mode blocked safety check classifier allow recently' },
        b.allowed
          ? done
          : button('Allow', async (btn) => {
              btn.disabled = true;
              try {
                const res = await ctx.call('auto.allow', b.sessionId, b.id);
                if (res?.ok) btn.replaceWith(done);
                else {
                  r.problem(res?.error ?? 'Could not allow it.');
                  btn.remove();
                }
              } catch (err) {
                r.problem(ctx.cleanError(err));
                btn.disabled = false;
              }
            }, { aria: `Allow ${b.what}` }),
      );
      r.el.querySelector('.sp-row-name')?.classList.add('auto-blocked-what');
      el.append(r.el);
    });
    if (!list.length) el.append(note('Nothing blocked.'));
    ctx.refreshSearch();
  }
  bus.on('agent-event', (ev) => {
    if ((ev.type === 'auto_blocked' || ev.type === 'auto_allowed') && el.closest('dialog')?.open) void refresh();
  });
  return { el, refresh };
}
