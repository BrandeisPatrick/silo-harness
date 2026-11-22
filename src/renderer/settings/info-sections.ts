// MCP servers (the existing panel), History and Appearance. Configuration files, Hooks and About are cards of
// Settings → Developer now (developer-section.ts).

import type { HistoryStats, TrashEntry } from '../../shared/history';
import { formatBytes, h } from '../dom.js';
import { relativeDays, TRASH_DAYS } from './model.js';
import { button, card, row, sectionTitle, type Row } from './ui.js';
import type { Ctx, Section } from './ctx.js';
import type { LooksPart } from './mods-section.js';

// ---------- MCP servers ----------

export function mcpSection(_ctx: Ctx, panel: HTMLElement): Section {
  const el = h('section', {}, sectionTitle('MCP servers'));
  const r = row({ id: 'mcp', title: 'Servers', keywords: 'mcp model context protocol server servers tools connector connectors integration integrations add remove connect trust', full: true, bare: true }, panel);
  r.el.classList.add('sp-panel-row');
  panel.classList.add('sp-embedded');
  el.append(card(null, r));
  return { id: 'mcp', el };
}

// ---------- History ----------

export function historySection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('History'));
  const stored = row({ id: 'history-stats', title: 'Stored', desc: '', keywords: 'disk size storage sessions logs' }, button('Reveal', () => void ctx.call('history.reveal').catch((err) => stored.problem(ctx.cleanError(err))), { icon: 'folder', aria: 'Reveal the history folder' }));
  const keep = ctx.segField({
    id: 'historyTrashDays',
    title: 'Keep deleted sessions for',
    desc: 'Off deletes them for good at once.',
    keywords: 'trash retention purge delete days off deletes sessions for good right away',
    field: 'historyTrashDays',
    choices: TRASH_DAYS,
    read: (v) => TRASH_DAYS.reduce((best, c) => (Math.abs(c.value - Number(v)) < Math.abs(best.value - Number(v)) ? c : best), TRASH_DAYS[2]).value,
  });
  // The trash: a card of its own, only while it holds something
  const trashCard = card('Trash');
  trashCard.hidden = true;
  const emptyBtn = button('Empty trash', async (b) => {
    const ok = await ctx.confirm({ title: 'Empty the trash?', description: `${trash.length} deleted session${trash.length === 1 ? ' is' : 's are'} removed for good; this cannot be undone.`, confirmLabel: 'Empty trash', danger: true });
    if (!ok) return;
    b.disabled = true;
    try {
      trash = await ctx.call('history.purge');
      await refreshStats();
      render();
    } catch (err) {
      stored.problem(`Couldn't empty the trash: ${ctx.cleanError(err)}`);
    } finally {
      b.disabled = false;
    }
  }, { icon: 'trash', danger: true });
  const emptyRow = row({ id: 'history-empty', title: 'Empty trash', desc: 'Removes them for good.', keywords: 'purge delete removes every deleted session' }, emptyBtn);
  el.append(card(null, stored, keep), trashCard);

  let stats: HistoryStats | null = null;
  let trash: TrashEntry[] = [];

  async function refreshStats(): Promise<void> {
    stats = await ctx.call('history.stats');
    stored.setDesc(`${stats.sessions} session${stats.sessions === 1 ? '' : 's'} · ${formatBytes(stats.bytes)} on disk`);
  }

  function render(): void {
    trashCard.body.replaceChildren();
    trashCard.hidden = !trash.length;
    for (const t of trash) {
      const r: Row = row({ id: `trash-${t.id}`, title: t.title || 'Untitled session', desc: `Deleted ${relativeDays(t.deletedAt)}, gone ${relativeDays(t.purgeAt)}`, keywords: `trash deleted session restore ${t.messageCount} messages ${formatBytes(t.bytes)}` });
      const restore = button('Restore', async (b) => {
        b.disabled = true;
        try {
          await ctx.call('history.restore', t.id);
          trash = await ctx.call('history.trash');
          await refreshStats();
          render();
        } catch (err) {
          r.problem(`Couldn't restore it: ${ctx.cleanError(err)}`);
          b.disabled = false;
        }
      }, { icon: 'undo' });
      const purge = button('Delete now', async (b) => {
        const ok = await ctx.confirm({ title: `Delete “${t.title || 'Untitled session'}” for good?`, description: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        b.disabled = true;
        try {
          trash = await ctx.call('history.purge', t.id);
          await refreshStats();
          render();
        } catch (err) {
          r.problem(`Couldn't delete it: ${ctx.cleanError(err)}`);
          b.disabled = false;
        }
      });
      r.control.append(h('span', { class: 'sp-control-group' }, restore, purge));
      trashCard.body.append(r.el);
    }
    if (trash.length) trashCard.body.append(emptyRow.el);
    ctx.refreshSearch();
  }

  // Coming on screen again reads the numbers again: Developer → Reset can delete every session while Settings is open
  let shown = false;
  new MutationObserver(() => {
    const now = el.classList.contains('current');
    if (now && !shown) {
      void refreshStats()
        .then(async () => {
          trash = await ctx.call('history.trash');
          render();
        })
        .catch(() => undefined);
    }
    shown = now;
  }).observe(el, { attributes: true, attributeFilter: ['class'] });

  return {
    id: 'history',
    el,
    async load() {
      try {
        await refreshStats();
        trash = await ctx.call('history.trash');
      } catch (err) {
        if (ctx.isUnknown(err)) return 'absent';
        stored.problem(`Couldn't read the history: ${ctx.cleanError(err)}`);
        return 'ok';
      }
      render();
      return 'ok';
    },
  };
}

// ---------- Appearance ----------

type Scheme = 'light' | 'dark' | 'system';

/**
 * A small picture of the window in a colour scheme: a sidebar, a title line and a few lines of text. System is split:
 * light on the left, dark on the right. The colours are the scheme's own (--sp-scheme-* in settings.css), the same in
 * light and dark, since the picture is of the scheme.
 */
function schemePicture(scheme: Scheme): string {
  const win = (t: 'light' | 'dark') => `<rect x="0" y="0" width="96" height="60" fill="var(--sp-scheme-${t}-bg)"/><rect x="0" y="0" width="26" height="60" fill="var(--sp-scheme-${t}-side)"/><rect x="6" y="9" width="14" height="3" rx="1.5" fill="var(--sp-scheme-${t}-ink)"/><rect x="6" y="16" width="11" height="3" rx="1.5" fill="var(--sp-scheme-${t}-ink)"/><rect x="34" y="12" width="40" height="4" rx="2" fill="var(--sp-scheme-${t}-ink)"/><rect x="34" y="21" width="52" height="3" rx="1.5" fill="var(--sp-scheme-${t}-ink)" opacity="0.6"/><rect x="34" y="28" width="46" height="3" rx="1.5" fill="var(--sp-scheme-${t}-ink)" opacity="0.6"/><rect x="34" y="44" width="54" height="9" rx="4.5" fill="var(--sp-scheme-${t}-field)" stroke="var(--sp-scheme-${t}-ink)" stroke-width="0.75"/>`;
  const body = scheme === 'system' ? `<g clip-path="url(#sp-scheme-left)">${win('light')}</g><g clip-path="url(#sp-scheme-right)">${win('dark')}</g>` : win(scheme);
  const clips = scheme === 'system' ? '<defs><clipPath id="sp-scheme-left"><rect x="0" y="0" width="48" height="60"/></clipPath><clipPath id="sp-scheme-right"><rect x="48" y="0" width="48" height="60"/></clipPath></defs>' : '';
  return `<svg class="sp-scheme-pic" viewBox="0 0 96 60" width="96" height="60" aria-hidden="true" focusable="false">${clips}${body}</svg>`;
}

export function appearanceSection(ctx: Ctx, looks: LooksPart): Section {
  const el = h('section', {}, sectionTitle('Appearance'));
  // Three small pictures to pick from; the radios underneath are the same field as before (the theme)
  const theme = ctx.segField<Scheme>({
    id: 'theme',
    title: 'Colour scheme',
    keywords: 'theme dark light mode colour color appearance scheme system',
    field: 'theme',
    choices: [
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
      { value: 'system', label: 'System' },
    ],
  });
  const group = theme.control.querySelector<HTMLElement>('[role=radiogroup]')!;
  group.id = 'theme';
  group.classList.remove('segmented', 'sp-seg');
  group.classList.add('sp-schemes');
  for (const label of group.querySelectorAll('label')) {
    const v = label.querySelector('input')!.value as Scheme;
    label.classList.add('sp-scheme');
    label.querySelector('input')!.after(h('span', { class: 'sp-scheme-frame', html: schemePicture(v) }));
  }
  theme.el.classList.add('sp-theme-row');
  el.append(card(null, theme), looks.el);

  // The live previews of the look tabs run only while this page is on screen
  new MutationObserver(() => looks.visible(el.classList.contains('current'))).observe(el, { attributes: true, attributeFilter: ['class'] });

  return {
    id: 'appearance',
    el,
    sync: () => looks.sync(),
    tab: () => looks.tab(),
    showTab: (t, opts) => looks.showTab(t, opts),
    uncover: (target) => void looks.uncover(target),
  };
}
