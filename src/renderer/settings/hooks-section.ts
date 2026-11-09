// Settings → Hooks: the hooks in effect (from the settings files and from mods), grouped by event, and the runs of
// this app session. Hooks are defined in settings.json (docs/hooks.md); this page only shows them.

import type { HookEntryInfo, HookRunInfo, HooksInfo } from '../../shared/hooks';
import { h } from '../dom.js';
import { onPush } from '../rpc.js';
import { button, chip, group, note, row, sectionTitle, tildePath } from './ui.js';
import { hookEntryLine, hookRunLine, HOOK_EVENT_ORDER } from './model.js';
import type { Ctx, Section } from './ctx.js';

export function hooksSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Hooks'));
  const inEffect = h('div', { class: 'sp-hooks' });
  const runsEl = h('div', { class: 'sp-hook-runs' });
  const openRow = row(
    { id: 'hooks-open', title: 'Add or change hooks', desc: 'Edit "hooks" in your settings.json.', keywords: 'settings.json edit add hook command PreToolUse PostToolUse Stop' },
    button('Open settings.json', () => void ctx.call('settings.open', 'user').catch((err) => openRow.problem(ctx.cleanError(err))), { icon: 'file' }),
  );
  el.append(inEffect, group(null, openRow), runsEl);

  function hookRow(e: HookEntryInfo, i: number) {
    const r = row({ id: `hook-${e.event}-${i}`, title: e.command, desc: hookEntryLine(e, tildePath), keywords: `hook ${e.event} ${e.matcher} ${e.type} ${e.sourceLabel}` });
    r.el.classList.add('sp-hook');
    r.el.querySelector('.sp-row-name')?.classList.add('sp-hook-cmd');
    r.el.querySelector('.sp-row-title')?.append(chip(e.source === 'mod' ? 'Mod' : e.source === 'project' ? 'Project' : 'Yours', e.source === 'project' ? 'warn' : 'neutral'));
    if (e.source !== 'mod') r.descEl.title = e.sourceLabel;
    return r;
  }

  function runRow(run: HookRunInfo) {
    const r = row({ id: `hook-run-${run.id}`, title: `${run.event}${run.target ? ` · ${run.target}` : ''}`, desc: hookRunLine(run), keywords: `hook run ${run.event} ${run.target} ${run.decision}` });
    r.el.classList.add('sp-hook-run');
    const bad = run.decision === 'error' || run.decision === 'timeout' || run.decision === 'skipped';
    const tone = run.decision === 'deny' || run.decision === 'block' ? 'warn' : bad ? 'danger' : run.decision ? 'ok' : 'neutral';
    r.el.querySelector('.sp-row-title')?.append(chip(run.decision || 'no decision', tone));
    return r;
  }

  function render(info: HooksInfo): void {
    inEffect.innerHTML = '';
    if (info.disabled) inEffect.append(note('disableAllHooks is set, so only mod hooks run.', 'sp-inline-status error'));
    const byEvent = new Map<string, HookEntryInfo[]>();
    for (const e of info.hooks) byEvent.set(e.event, [...(byEvent.get(e.event) ?? []), e]);
    if (!info.hooks.length) inEffect.append(group('In effect', row({ id: 'hooks-none', title: 'No hooks', keywords: 'hooks none empty' })));
    for (const event of HOOK_EVENT_ORDER) {
      const list = byEvent.get(event);
      if (list?.length) inEffect.append(group(event, ...list.map((e, i) => hookRow(e, i))));
    }
    if (info.problems.length) {
      const p = row({ id: 'hooks-problems', title: 'Skipped', desc: '', keywords: 'invalid error skipped problem' });
      p.descEl.hidden = false;
      p.descEl.append(h('ul', { class: 'sp-detail-list' }, ...info.problems.map((x) => h('li', { title: x.file }, h('code', {}, x.key), `: ${x.message}`))));
      inEffect.append(group(null, p));
    }
    runsEl.innerHTML = '';
    const clear = button('Clear', async (b) => {
      b.disabled = true;
      try {
        render(await ctx.call('hooks.clearRuns'));
      } catch (err) {
        clearRow.problem(ctx.cleanError(err));
        b.disabled = false;
      }
    }, { icon: 'trash' });
    clear.disabled = !info.runs.length;
    const clearRow = row({ id: 'hooks-runs', title: 'Recent runs', desc: info.runs.length ? `${info.runs.length} since launch, newest first.` : 'None since launch.', keywords: 'hooks runs log history clear exit code' }, clear);
    const runs = [...info.runs].reverse().slice(0, 50);
    runsEl.append(group('Recent runs', clearRow, ...runs.map(runRow)));
    ctx.refreshSearch();
  }

  async function load(): Promise<'ok' | 'absent'> {
    try {
      render(await ctx.call('hooks.info'));
    } catch (err) {
      if (ctx.isUnknown(err)) return 'absent';
      inEffect.innerHTML = '';
      inEffect.append(note(`Couldn't read the hooks: ${ctx.cleanError(err)}`, 'error'));
    }
    return 'ok';
  }

  onPush('hooks:changed', (info) => {
    if (info && typeof info === 'object' && Array.isArray(info.hooks) && el.isConnected) render(info);
  });
  // A file changed on disk or was trusted: the hooks in effect may have too.
  onPush('settings:changed', () => {
    if (el.isConnected) void load();
  });

  return { id: 'hooks', el, load };
}
