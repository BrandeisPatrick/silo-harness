// MCP servers (the existing panel), History, Appearance, Configuration files and About.

import type { ModInfo } from '../../shared/mods';
import type { AppInfo, SettingsFileInfo, SettingsInfo } from '../../shared/settings-info';
import type { HistoryStats, TrashEntry } from '../../shared/history';
import { formatBytes, h } from '../dom.js';
import { onPush } from '../rpc.js';
import { choiceWords, fileState, MOD_TABS, relativeDays, tabOfKind, TRASH_DAYS, type ModKind } from './model.js';
import { button, chip, group, note, row, sectionTitle, tildePath, type Row } from './ui.js';
import type { Ctx, Section } from './ctx.js';

// ---------- MCP servers ----------

export function mcpSection(_ctx: Ctx, panel: HTMLElement): Section {
  const el = h('section', {}, sectionTitle('MCP servers'));
  const r = row({ id: 'mcp', title: 'Servers', keywords: 'mcp model context protocol server servers tools connector connectors integration integrations add remove connect trust', full: true }, panel);
  r.el.classList.add('sp-panel-row');
  panel.classList.add('sp-embedded');
  el.append(group(null, r));
  return { id: 'mcp', el };
}

// ---------- History ----------

export function historySection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('History'));
  const stored = row({ id: 'history-stats', title: 'Stored', desc: '', keywords: 'disk size storage sessions logs' }, button('Reveal folder', () => void ctx.call('history.reveal').catch((err) => stored.problem(ctx.cleanError(err))), { icon: 'folder' }));
  const keep = ctx.segField({
    id: 'historyTrashDays',
    title: 'Keep deleted sessions for',
    desc: 'Off deletes sessions for good right away.',
    keywords: 'trash retention purge delete days',
    field: 'historyTrashDays',
    choices: TRASH_DAYS,
    read: (v) => TRASH_DAYS.reduce((best, c) => (Math.abs(c.value - Number(v)) < Math.abs(best.value - Number(v)) ? c : best), TRASH_DAYS[2]).value,
  });
  const trashGroup = group('Trash');
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
  const emptyRow = row({ id: 'history-empty', title: 'Empty trash', desc: 'Removes every deleted session for good.', keywords: 'purge delete' }, emptyBtn);

  // Every session goes the way one deleted session goes (the main process does it: history.deleteAll), after a
  // confirmation that says how many there are and where they go. The window then shows a fresh session.
  const deleteAllBtn = button('Delete all sessions', async (b) => {
    const n = stats?.sessions ?? 0;
    const days = Number(ctx.config().historyTrashDays);
    const kept = !Number.isFinite(days) || days > 0;
    const one = n === 1;
    const where = kept
      ? `${one ? 'goes' : 'go'} to the trash, restorable for ${Number.isFinite(days) ? days : 30} days`
      : `${one ? 'is' : 'are'} removed for good, which cannot be undone`;
    const ok = await ctx.confirm({
      title: 'Delete all sessions?',
      description: `${n} session${one ? '' : 's'} ${where}; a running session is stopped first.`,
      confirmLabel: 'Delete all sessions',
      danger: true,
    });
    if (!ok) return;
    b.disabled = true;
    try {
      await ctx.call('history.deleteAll');
      trash = await ctx.call('history.trash');
      await refreshStats();
      render();
      deleteRow.problem(null);
    } catch (err) {
      deleteRow.problem(`Couldn't delete them: ${ctx.cleanError(err)}`);
    } finally {
      b.disabled = !stats?.sessions;
    }
  }, { icon: 'trash', danger: true });
  deleteAllBtn.disabled = true;
  const deleteRow = row(
    { id: 'history-delete-all', title: 'Delete all sessions', desc: 'Moves every session to the trash.', keywords: 'remove everything clear wipe reset erase all sessions conversations' },
    deleteAllBtn,
  );
  el.append(group(null, stored, keep, deleteRow), trashGroup);

  let stats: HistoryStats | null = null;
  let trash: TrashEntry[] = [];

  async function refreshStats(): Promise<void> {
    stats = await ctx.call('history.stats');
    stored.setDesc(`${stats.sessions} session${stats.sessions === 1 ? '' : 's'} · ${formatBytes(stats.bytes)} on disk${stats.trash ? ` · ${stats.trash} in the trash (${formatBytes(stats.trashBytes)})` : ''}`);
    deleteAllBtn.disabled = !stats.sessions;
  }

  function render(): void {
    trashGroup.querySelectorAll('.sp-row, .sp-note').forEach((n) => n.remove());
    if (!trash.length) trashGroup.append(note('The trash is empty.'));
    for (const t of trash) {
      const r: Row = row({ id: `trash-${t.id}`, title: t.title || 'Untitled session', desc: `Deleted ${relativeDays(t.deletedAt)} · removed for good ${relativeDays(t.purgeAt)} · ${t.messageCount} message${t.messageCount === 1 ? '' : 's'}, ${formatBytes(t.bytes)}`, keywords: 'trash deleted session restore' });
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
      trashGroup.append(r.el);
    }
    if (trash.length) trashGroup.append(emptyRow.el);
    ctx.refreshSearch();
  }

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

export function appearanceSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Appearance'));
  const theme = ctx.segField({
    id: 'theme',
    title: 'Colour scheme',
    keywords: 'theme dark light mode colour color appearance scheme',
    field: 'theme',
    choices: [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
  });
  theme.control.querySelector('[role=radiogroup]')!.id = 'theme';

  let mods: ModInfo[] = [];

  // The looks: one short row per kind, showing the one in use and opening its tab in Settings → Mods.
  const kindRow = (kind: Exclude<ModKind, 'general'>, id: string, title: string, keywords: string) => {
    const tab = tabOfKind(kind);
    const open = button('Change…', () => ctx.show('mods', { tab }), { aria: `Change: ${title}, in Settings → Mods → ${MOD_TABS.find((t) => t.id === tab)!.title}` });
    const r = row({ id, title, desc: '', keywords }, open);
    r.el.classList.add('clickable');
    r.el.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button')) ctx.show('mods', { tab });
    });
    return { kind, row: r };
  };
  const kinds = [
    kindRow('background', 'appearance-background', 'Background', 'wallpaper image picture mod backgrounds dim look'),
    kindRow('composer', 'appearance-composer', 'Chat bar', 'look composer input message box style mod'),
    kindRow('conversation', 'appearance-conversation', 'Conversation', 'look transcript messages chat style mod'),
  ];
  const kindGroup = group('Looks', ...kinds.map((k) => k.row));
  el.append(group(null, theme), kindGroup);

  function renderKinds(): void {
    const l = ctx.config().mods?.layout ?? null;
    for (const k of kinds) k.row.setDesc(choiceWords(mods, l, k.kind));
  }

  onPush('mods:changed', (list) => {
    if (!Array.isArray(list)) return;
    mods = list;
    renderKinds();
  });

  return {
    id: 'appearance',
    el,
    sync: () => renderKinds(),
    async load() {
      try {
        mods = await ctx.call('mods.list');
        kindGroup.hidden = false;
      } catch (err) {
        kindGroup.hidden = ctx.isUnknown(err);
      }
      renderKinds();
      return 'ok';
    },
  };
}

// ---------- Configuration files ----------

export function filesSection(ctx: Ctx, onInfo: (info: SettingsInfo | null) => void): Section {
  const el = h('section', {}, sectionTitle('Configuration files'));
  el.append(note('Fields a settings.json file sets are read-only here.', 'sp-intro'));
  const filesEl = h('div', {});
  const reloadRow = row(
    { id: 'files-reload', title: 'Read the files again', desc: 'After you edit a file outside Silo Harness.', keywords: 'reload refresh settings.json' },
    button('Reload', async (b) => {
      b.disabled = true;
      try {
        render(await ctx.call('settings.reload'));
        reloadRow.saved();
      } catch (err) {
        reloadRow.problem(ctx.cleanError(err));
      } finally {
        b.disabled = false;
      }
    }, { icon: 'refresh' }),
  );
  el.append(filesEl, group(null, reloadRow));

  function fileGroup(f: SettingsFileInfo): HTMLElement {
    const project = f.scope === 'project';
    const st = fileState(f);
    const fileRow = row(
      { id: `file-${f.scope}`, title: project ? 'Project settings' : 'Your settings', desc: tildePath(f.path), keywords: 'settings.json file path open reveal' },
      h(
        'span',
        { class: 'sp-control-group' },
        button(f.exists ? 'Open' : 'Create', async () => {
          try {
            await ctx.call('settings.open', f.scope);
          } catch (err) {
            fileRow.problem(ctx.cleanError(err));
          }
        }, { icon: 'external-link', aria: `${f.exists ? 'Open' : 'Create'} ${f.path}` }),
        button('Reveal', async () => {
          try {
            await ctx.call('app.reveal', project ? 'project' : 'configDir');
          } catch (err) {
            fileRow.problem(ctx.cleanError(err));
          }
        }, { icon: 'folder', aria: `Reveal ${f.path}` }),
      ),
    );
    fileRow.descEl.classList.add('sp-path');
    fileRow.descEl.title = f.path;
    fileRow.el.querySelector('.sp-row-title')!.append(chip(st.label, st.tone));
    if (f.error) fileRow.problem(`It is not a JSON object: ${f.error}`);

    const keys = f.keys.filter((k) => !k.startsWith('env.')).map((k) => (k.startsWith('hooks.') ? `${k} (runs commands)` : k));
    const commands = f.hookCommands ?? [];
    const runsWhat = commands.length ? `Its hooks run commands on your Mac: ${commands.slice(0, 3).join('; ')}${commands.length > 3 ? ` and ${commands.length - 3} more` : ''}.` : '';
    const envs = f.keys.filter((k) => k.startsWith('env.')).map((k) => k.slice(4));
    const setsRow = row({ id: `file-${f.scope}-keys`, title: 'What it sets', desc: !f.exists ? 'Nothing.' :[keys.length ? keys.join(', ') : '', envs.length ? `environment: ${envs.join(', ')}` : ''].filter(Boolean).join(' · ') || 'Nothing.', keywords: 'fields' });
    setsRow.descEl.classList.add('sp-mono-list');
    const g = group(project ? 'This project' : 'Yours', fileRow, setsRow);
    if (f.invalid.length) {
      const skipped = row({ id: `file-${f.scope}-invalid`, title: 'Skipped', desc: '', keywords: 'invalid error skipped' });
      skipped.descEl.hidden = false;
      skipped.descEl.append(h('ul', { class: 'sp-detail-list' }, ...f.invalid.map((i) => h('li', {}, h('code', {}, i.key), `: ${i.message}`))));
      g.append(skipped.el);
    }
    if (project && f.exists && !f.error) {
      const trusted = f.trusted && !f.changed;
      const trustRow: Row = row(
        {
          id: 'file-project-trust',
          title: trusted ? 'Applied to this project' : f.changed ? 'Changed since you approved it' : 'Apply this file',
          desc: trusted ? `In effect while this project is open.${commands.length ? ' Its hooks run commands.' : ''}` : `It can change the model, the permission mode and more.${runsWhat ? ` ${runsWhat}` : ''}`,
          keywords: 'trust approve apply project',
        },
        button(trusted ? 'Stop applying' : 'Trust and apply', async (b) => {
          if (!trusted) {
            const ok = await ctx.confirm({ title: 'Apply the project’s settings.json?', description: `${keys.length ? `It sets ${keys.join(', ')} until the file changes.` : 'It applies until the file changes.'}${runsWhat ? ` ${runsWhat}` : ''}`, confirmLabel: 'Trust and apply', icon: 'shield-check' });
            if (!ok) return;
          }
          b.disabled = true;
          try {
            render(await ctx.call('settings.trustProject', !trusted));
          } catch (err) {
            trustRow.problem(ctx.cleanError(err));
            b.disabled = false;
          }
        }, { primary: !trusted, icon: trusted ? undefined : 'shield-check' }),
      );
      g.append(trustRow.el);
    }
    return g;
  }

  function render(info: SettingsInfo): void {
    filesEl.innerHTML = '';
    for (const scope of ['user', 'project'] as const) {
      const f = info.files.find((x) => x.scope === scope);
      if (f) filesEl.append(fileGroup(f));
    }
    onInfo(info);
    ctx.refreshSearch();
  }

  onPush('settings:changed', (info) => {
    if (info && typeof info === 'object' && Array.isArray(info.files)) render(info);
  });

  return {
    id: 'files',
    el,
    async load() {
      try {
        render(await ctx.call('settings.info'));
      } catch (err) {
        onInfo(null);
        if (ctx.isUnknown(err)) return 'absent';
        filesEl.innerHTML = '';
        filesEl.append(note(`Couldn't read the files: ${ctx.cleanError(err)}`, 'error'));
      }
      return 'ok';
    },
  };
}

// ---------- About ----------

export function aboutSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('About'));
  const app = row({ id: 'about-app', title: 'Silo Harness', desc: '', keywords: 'version' });
  const versions = row({ id: 'about-versions', title: 'Runtime', desc: '', keywords: 'electron chrome node version' });
  const reveal = (which: 'userData' | 'configDir', r: () => Row) => button('Reveal', async () => {
    try {
      await ctx.call('app.reveal', which);
    } catch (err) {
      r().problem(ctx.cleanError(err));
    }
  }, { icon: 'folder' });
  const data: Row = row({ id: 'about-data', title: 'Data folder', desc: '', keywords: 'sessions history config.json userdata' }, reveal('userData', () => data));
  const conf: Row = row({ id: 'about-config', title: 'Config folder', desc: '', keywords: 'settings.json skills mods' }, reveal('configDir', () => conf));
  data.descEl.classList.add('sp-path');
  conf.descEl.classList.add('sp-path');
  const keys = row({ id: 'about-shortcuts', title: 'Keyboard shortcuts', keywords: 'keys hotkeys sheet' }, button('Show', () => ctx.openShortcuts(), { icon: 'keyboard' }));
  el.append(group(null, app, versions, data, conf, keys));

  return {
    id: 'about',
    el,
    async load() {
      let info: AppInfo;
      try {
        info = await ctx.call('app.info');
      } catch (err) {
        if (ctx.isUnknown(err)) return 'absent';
        app.problem(ctx.cleanError(err));
        return 'ok';
      }
      app.el.querySelector('.sp-row-name')!.textContent = info.name || 'Silo Harness';
      app.setDesc(`Version ${info.version} · ${info.platform === 'darwin' ? 'macOS' : info.platform} ${info.arch}`);
      versions.setDesc(`Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`);
      data.setDesc(tildePath(info.userData));
      data.descEl.title = info.userData;
      conf.setDesc(tildePath(info.configDir));
      conf.descEl.title = info.configDir;
      return 'ok';
    },
  };
}
