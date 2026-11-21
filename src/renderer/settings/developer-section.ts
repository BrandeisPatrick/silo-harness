// Settings → Developer: the settings.json files (what each sets, opening and trusting them), the hooks in effect and
// their recent runs, this Mac (the command-line tool, the data and config folders, the runtime), and Reset: deleting
// every session, every mod of yours, the app's saved settings, or everything (full-reset.ts).
//
// Configuration files, Hooks and About were pages of their own; their old targets land here (model.ts LEGACY_SECTIONS).

import type { CliStatus } from '../../shared/providers';
import type { HookEntryInfo, HookRunInfo, HooksInfo } from '../../shared/hooks';
import type { HistoryStats } from '../../shared/history';
import type { ModInfo } from '../../shared/mods';
import type { AppInfo, SettingsFileInfo, SettingsInfo } from '../../shared/settings-info';
import { h } from '../dom.js';
import { onPush } from '../rpc.js';
import { fileState, hookEntryLine, hookRunLine, HOOK_EVENT_ORDER } from './model.js';
import { actions, button, card, cardAction, chip, iconButton, note, pathDesc, row, sectionTitle, tildePath, type CardEl, type Row } from './ui.js';
import type { Ctx, Section } from './ctx.js';
import { resetRows } from './full-reset.js';

export interface DeveloperDeps {
  /** The files and the fields they own (the page shows those fields read-only, with a lock) */
  onInfo(info: SettingsInfo | null): void;
  /** The app's version, for the line under the navigation */
  onVersion(version: string): void;
}

export function developerSection(ctx: Ctx, deps: DeveloperDeps): Section {
  const el = h('section', {}, sectionTitle('Developer'));
  const files = filesCard(ctx, deps.onInfo);
  const hooks = hooksCard(ctx);
  const mac = macCard(ctx);
  const reset = resetCard(ctx);
  el.append(files.card, hooks.card, mac.card, reset.card);
  return {
    id: 'developer',
    el,
    async load() {
      const [, , info] = await Promise.all([files.load(), hooks.load(), mac.load(), reset.load()]);
      if (info) deps.onVersion(info.version);
      return 'ok';
    },
  };
}

// ---------- Configuration files ----------

function filesCard(ctx: Ctx, onInfo: (info: SettingsInfo | null) => void): { card: CardEl; load(): Promise<void> } {
  const c = card('Configuration files');
  const reload = iconButton('refresh', 'Read the files again', async (b) => {
    b.disabled = true;
    b.classList.add('spinning');
    try {
      render(await ctx.call('settings.reload'));
    } catch (err) {
      showError(ctx.cleanError(err));
    } finally {
      b.disabled = false;
      b.classList.remove('spinning');
    }
  });
  reload.id = 'files-reload';
  cardAction(c, reload);

  function showError(message: string): void {
    c.body.replaceChildren(note(`Couldn't read the files: ${message}`, 'error'));
  }

  function fileRows(f: SettingsFileInfo): HTMLElement[] {
    const project = f.scope === 'project';
    const st = fileState(f);
    const keys = f.keys.filter((k) => !k.startsWith('env.')).map((k) => (k.startsWith('hooks.') ? `${k} (runs commands)` : k));
    const envs = f.keys.filter((k) => k.startsWith('env.')).map((k) => k.slice(4));
    const sets = [keys.join(', '), envs.length ? `environment: ${envs.join(', ')}` : ''].filter(Boolean).join(' · ');
    const fileRow: Row = row(
      {
        id: `file-${f.scope}`,
        title: project ? 'Project settings' : 'Your settings',
        desc: '',
        // The old Configuration files page's words: "What it sets", "Read the files again"
        keywords: `settings.json file path open reveal configuration files what it sets fields read the files again reload refresh after you edit a file ${sets}`,
      },
      actions(
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
    pathDesc(fileRow, f.path);
    fileRow.el.querySelector('.sp-row-title')!.append(chip(st.label, st.tone));
    // One muted line: the keys it sets (none: no line)
    if (f.exists && sets) {
      const meta = h('div', { class: 'sp-row-meta', title: sets }, sets);
      fileRow.descEl.after(meta);
    }
    if (f.error) fileRow.problem(`It is not a JSON object: ${f.error}`);
    else if (f.invalid.length) fileRow.problem(`Skipped: ${f.invalid.map((i) => `${i.key}: ${i.message}`).join('; ')}`);
    const out = [fileRow.el];

    const commands = f.hookCommands ?? [];
    if (project && f.exists && !f.error) {
      const runsWhat = commands.length ? `Its hooks run commands on your Mac: ${commands.slice(0, 3).join('; ')}${commands.length > 3 ? ` and ${commands.length - 3} more` : ''}.` : '';
      const trusted = f.trusted && !f.changed;
      const trustRow: Row = row(
        {
          id: 'file-project-trust',
          title: trusted ? 'Applied to this project' : f.changed ? 'Changed since you approved' : 'Apply this file',
          desc: trusted ? (commands.length ? 'In effect here; its hooks run commands.' : 'In effect while this project is open.') : 'It can change the model and mode.',
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
      out.push(trustRow.el);
    }
    return out;
  }

  function render(info: SettingsInfo): void {
    c.body.replaceChildren();
    for (const scope of ['user', 'project'] as const) {
      const f = info.files.find((x) => x.scope === scope);
      if (f) c.body.append(...fileRows(f));
    }
    onInfo(info);
    ctx.refreshSearch();
  }

  onPush('settings:changed', (info) => {
    if (info && typeof info === 'object' && Array.isArray(info.files)) render(info);
  });

  return {
    card: c,
    async load() {
      try {
        c.hidden = false;
        render(await ctx.call('settings.info'));
      } catch (err) {
        onInfo(null);
        if (ctx.isUnknown(err)) c.hidden = true;
        else showError(ctx.cleanError(err));
      }
    },
  };
}

// ---------- Hooks ----------

function hooksCard(ctx: Ctx): { card: HTMLElement; load(): Promise<void> } {
  const c = card('Hooks');
  const runsCard = card('Recent hook runs');
  const wrap = h('div', { class: 'sp-hooks-wrap' }, c, runsCard);
  const openRow = row(
    { id: 'hooks-open', title: 'Edit hooks', desc: 'In your settings.json.', keywords: 'hooks settings.json edit add change hook command PreToolUse PostToolUse Stop no hooks in effect' },
    button('Open settings.json', () => void ctx.call('settings.open', 'user').catch((err) => openRow.problem(ctx.cleanError(err))), { icon: 'file' }),
  );

  function hookRow(e: HookEntryInfo, i: number): HTMLElement {
    const line = hookEntryLine(e, tildePath);
    const r = row({ id: `hook-${e.event}-${i}`, title: e.command, desc: `${e.event} · ${line}`, keywords: `hook ${e.event} ${e.matcher} ${e.type} ${e.sourceLabel}` });
    r.el.classList.add('sp-hook');
    r.el.querySelector('.sp-row-name')?.classList.add('sp-hook-cmd');
    r.el.querySelector('.sp-row-title')?.append(chip(e.source === 'mod' ? 'Mod' : e.source === 'project' ? 'Project' : 'Yours', e.source === 'project' ? 'warn' : 'neutral'));
    r.descEl.title = `${e.event} · ${line}`;
    return r.el;
  }

  function runRow(run: HookRunInfo): HTMLElement {
    const r = row({ id: `hook-run-${run.id}`, title: `${run.event}${run.target ? ` · ${run.target}` : ''}`, desc: hookRunLine(run), keywords: `hook run ${run.event} ${run.target} ${run.decision} recent runs log history exit code` });
    r.el.classList.add('sp-hook-run');
    r.descEl.title = hookRunLine(run);
    const bad = run.decision === 'error' || run.decision === 'timeout' || run.decision === 'skipped';
    const tone = run.decision === 'deny' || run.decision === 'block' ? 'warn' : bad ? 'danger' : run.decision ? 'ok' : 'neutral';
    r.el.querySelector('.sp-row-title')?.append(chip(run.decision || 'no decision', tone));
    return r.el;
  }

  const clear = iconButton('trash', 'Clear the runs', async (b) => {
    b.disabled = true;
    try {
      render(await ctx.call('hooks.clearRuns'));
    } catch (err) {
      openRow.problem(ctx.cleanError(err));
    } finally {
      b.disabled = false;
    }
  });
  cardAction(runsCard, clear);

  function render(info: HooksInfo): void {
    c.body.replaceChildren();
    if (info.disabled) c.body.append(note('disableAllHooks is set, so only mod hooks run.', 'error'));
    for (const event of HOOK_EVENT_ORDER) info.hooks.filter((e) => e.event === event).forEach((e, i) => c.body.append(hookRow(e, i)));
    if (info.problems.length) {
      const p = row({ id: 'hooks-problems', title: 'Skipped', desc: '', keywords: 'invalid error skipped problem' });
      p.problem(info.problems.map((x) => `${x.key}: ${x.message}`).join('; '));
      c.body.append(p.el);
    }
    c.body.append(openRow.el);
    // Recent runs: only when there are any
    const runs = [...info.runs].reverse().slice(0, 50);
    runsCard.body.replaceChildren(...runs.map(runRow));
    runsCard.hidden = !runs.length;
    ctx.refreshSearch();
  }

  onPush('hooks:changed', (info) => {
    if (info && typeof info === 'object' && Array.isArray(info.hooks) && wrap.isConnected) render(info);
  });
  // A file changed on disk or was trusted: the hooks in effect may have too.
  onPush('settings:changed', () => {
    if (wrap.isConnected) void load();
  });

  async function load(): Promise<void> {
    try {
      wrap.hidden = false;
      render(await ctx.call('hooks.info'));
    } catch (err) {
      if (ctx.isUnknown(err)) wrap.hidden = true;
      else {
        c.body.replaceChildren(note(`Couldn't read the hooks: ${ctx.cleanError(err)}`, 'error'), openRow.el);
        runsCard.hidden = true;
      }
    }
  }

  return { card: wrap, load };
}

// ---------- This Mac ----------

function macCard(ctx: Ctx): { card: CardEl; load(): Promise<AppInfo | null> } {
  // The command-line tool: a link on the PATH to the bundled `silo`
  const cliInstall = button('Install', () => void cliAction('cli.install', cliInstall), { icon: 'terminal' });
  const cliRemove = button('Remove', () => void cliAction('cli.uninstall', cliRemove));
  const cli = row({ id: 'cli', title: 'Command line tool', desc: '', keywords: 'cli command terminal shell silo open-harness path install agent claude code provider link about' }, actions(cliInstall, cliRemove));
  const showCli = (st: CliStatus | null) => {
    if (!st) {
      cli.el.hidden = true;
      return;
    }
    cli.el.hidden = false;
    const dir = tildePath(st.link.replace(/\/silo$/, ''));
    cli.setDesc(!st.available ? 'Not in this copy of the app.' : st.installed ? `Linked as ${tildePath(st.link)}` : `Links silo in ${dir}`);
    cli.descEl.title = st.command;
    cli.problem(st.conflict ? st.conflict : st.installed && !st.onPath ? `${dir} is not on your PATH; add it in your shell profile.` : null);
    cliInstall.hidden = st.installed;
    cliInstall.disabled = !st.available || Boolean(st.conflict);
    cliRemove.hidden = !st.installed;
  };
  async function cliAction(method: 'cli.install' | 'cli.uninstall', btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      showCli(await ctx.call(method));
      cli.saved();
    } catch (err) {
      cli.problem(ctx.cleanError(err));
    } finally {
      btn.disabled = false;
    }
  }

  const reveal = (which: 'userData' | 'configDir', r: () => Row) =>
    button('Reveal', async () => {
      try {
        await ctx.call('app.reveal', which);
      } catch (err) {
        r().problem(ctx.cleanError(err));
      }
    }, { icon: 'folder' });
  const data: Row = row({ id: 'about-data', title: 'Data folder', desc: '', keywords: 'sessions history config.json userdata about' }, reveal('userData', () => data));
  const conf: Row = row({ id: 'about-config', title: 'Config folder', desc: '', keywords: 'settings.json skills mods about' }, reveal('configDir', () => conf));
  const runtime = row({ id: 'about-versions', title: 'Runtime', desc: '', keywords: 'electron chrome node version about silo harness macos' });
  runtime.el.classList.add('sp-muted-row');
  const c = card('This Mac', cli, data, conf, runtime);

  return {
    card: c,
    async load() {
      try {
        showCli(await ctx.call('cli.status'));
      } catch {
        showCli(null);
      }
      let info: AppInfo;
      try {
        info = await ctx.call('app.info');
      } catch (err) {
        data.el.hidden = conf.el.hidden = runtime.el.hidden = ctx.isUnknown(err);
        if (!ctx.isUnknown(err)) data.problem(ctx.cleanError(err));
        return null;
      }
      data.el.hidden = conf.el.hidden = runtime.el.hidden = false;
      pathDesc(data, info.userData);
      pathDesc(conf, info.configDir);
      runtime.setDesc(`Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`);
      runtime.descEl.title = `${info.name} ${info.version} · ${info.platform === 'darwin' ? 'macOS' : info.platform} ${info.arch}`;
      return info;
    },
  };
}

// ---------- Reset ----------

function resetCard(ctx: Ctx): { card: CardEl; load(): Promise<void> } {
  let stats: HistoryStats | null = null;
  let mods: ModInfo[] = [];

  // Every session goes the way one deleted session goes (history.deleteAll), after a confirmation that says how many
  // there are and where they go; the window then shows a fresh session.
  const sessionsBtn = button('Delete…', async (b) => {
    const n = stats?.sessions ?? 0;
    const days = Number(ctx.config().historyTrashDays);
    const kept = !Number.isFinite(days) || days > 0;
    const one = n === 1;
    const where = kept ? `${one ? 'goes' : 'go'} to the trash, restorable for ${Number.isFinite(days) ? days : 30} days` : `${one ? 'is' : 'are'} removed for good, which cannot be undone`;
    const ok = await ctx.confirm({ title: 'Delete all sessions?', description: `${n} session${one ? '' : 's'} ${where}; a running session is stopped first.`, confirmLabel: 'Delete all sessions', danger: true });
    if (!ok) return;
    b.disabled = true;
    try {
      await ctx.call('history.deleteAll');
      sessionsRow.problem(null);
      sessionsRow.saved();
      await refresh();
    } catch (err) {
      sessionsRow.problem(`Couldn't delete them: ${ctx.cleanError(err)}`);
    } finally {
      b.disabled = !stats?.sessions;
    }
  }, { danger: true, aria: 'Delete all sessions' });
  const sessionsRow = row({ id: 'reset-sessions', title: 'Delete all sessions', desc: 'Moves every session to the trash.', keywords: 'history remove everything clear wipe reset erase all sessions conversations delete' }, sessionsBtn);

  // Every folder in your mods folder goes to the Trash (mods.removeAll)
  const modsBtn = button('Delete…', async (b) => {
    const mine = mods.filter((m) => m.scope === 'user');
    if (!mine.length) return;
    const names = mine.map((m) => m.manifest?.name ?? m.id);
    const listed = names.length > 6 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const one = mine.length === 1;
    const inUse = mine.some((m) => m.inUse?.length);
    const ok = await ctx.confirm({
      title: 'Delete all custom mods?',
      description: `${one ? listed : `Your ${mine.length} mods, ${listed},`} move${one ? 's' : ''} to the Trash and ${one ? 'its' : 'their'} settings and permissions are forgotten${inUse ? '; looks in use go back to Default' : ''}.`,
      confirmLabel: 'Move to Trash',
      danger: true,
    });
    if (!ok) return;
    b.disabled = true;
    try {
      const r = await ctx.call('mods.removeAll');
      mods = r.mods;
      modsRow.problem(null);
      modsRow.saved();
      renderCounts();
    } catch (err) {
      modsRow.problem(`Couldn't delete them: ${ctx.cleanError(err)}`);
      b.disabled = false;
    }
  }, { danger: true, aria: 'Delete all custom mods' });
  const modsRow = row({ id: 'reset-mods', title: 'Delete all custom mods', desc: 'Moves your mods to the Trash.', keywords: 'remove everything clear wipe reset erase uninstall yours user mods folder trash delete all custom mods' }, modsBtn);

  function renderCounts(): void {
    const n = stats?.sessions ?? 0;
    sessionsBtn.disabled = !n;
    sessionsRow.setDesc(n ? `Moves ${n === 1 ? 'one session' : `all ${n} sessions`} to the trash.` : 'Moves every session to the trash.');
    const mine = mods.filter((m) => m.scope === 'user').length;
    modsBtn.disabled = !mine;
    modsRow.setDesc(mine ? `Moves ${mine === 1 ? 'your mod' : `your ${mine} mods`} to the Trash.` : 'Moves your mods to the Trash.');
  }

  async function refresh(): Promise<void> {
    try {
      stats = await ctx.call('history.stats');
      sessionsRow.el.hidden = false;
    } catch (err) {
      stats = null;
      sessionsRow.el.hidden = ctx.isUnknown(err);
    }
    try {
      mods = await ctx.call('mods.list');
      modsRow.el.hidden = false;
    } catch (err) {
      mods = [];
      modsRow.el.hidden = ctx.isUnknown(err);
    }
    renderCounts();
  }
  onPush('mods:changed', (list) => {
    if (!Array.isArray(list)) return;
    mods = list;
    renderCounts();
  });

  const c = card('Reset', sessionsRow, modsRow, ...resetRows(ctx));
  c.classList.add('sp-danger-card');
  return { card: c, load: refresh };
}
