// Skills and Remote control: sections over a feature's own data rather than the config; and the search-only rows that
// open the Scheduled tasks and Dreaming pages.

import type { SkillInfo } from '../../shared/types';
import type { RemoteStatus } from '../../shared/remote';
import { copyWithFeedback, dirname, h } from '../dom.js';
import { icon } from '../icons.js';
import { onPush } from '../rpc.js';
import { button, group, note, row, sectionTitle, segmented, switchControl, tildePath, type Row } from './ui.js';
import type { Ctx, Section } from './ctx.js';

// ---------- Skills ----------

export function skillsSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Skills'));
  const where = note('', 'sp-intro');
  const listEl = h('div', {});
  el.append(where, listEl);
  const GROUPS: { source: SkillInfo['source']; title: string }[] = [
    { source: 'project', title: 'This project' },
    { source: 'user', title: 'Yours' },
    { source: 'bundled', title: 'Built-in' },
  ];

  function render(skills: SkillInfo[], configDir: string): void {
    const project = ctx.config().workingDirectory;
    where.textContent = `Skills live in ${tildePath(configDir)}/skills and ${tildePath(project)}/.silo-harness/skills.`;
    listEl.innerHTML = '';
    for (const g of GROUPS) {
      const items = skills.filter((s) => s.source === g.source);
      if (!items.length) continue;
      const grp = group(g.title);
      for (const s of items) {
        const r = row(
          { id: `skill-${g.source}-${s.name.replace(/[^a-z0-9-]+/gi, '_')}`, title: s.name, desc: s.description || 'No description.', keywords: `skill ${g.title}` },
          button('Reveal', async () => {
            try {
              await window.oc.changes.openInEditor(dirname(s.path).replace(/\/$/, ''));
            } catch (err) {
              r.problem(`Couldn't show the folder: ${ctx.cleanError(err)}`);
            }
          }, { icon: 'folder', aria: `Reveal ${s.name}` }),
        );
        r.el.title = s.path;
        grp.append(r.el);
      }
      listEl.append(grp);
    }
    if (!skills.length) listEl.append(note('No skills yet.'));
    ctx.refreshSearch();
  }

  return {
    id: 'skills',
    el,
    async load() {
      if (typeof window.oc?.skills?.list !== 'function') return 'absent';
      let configDir = '~/.silo-harness';
      try {
        configDir = (await ctx.call('app.info')).configDir || configDir;
      } catch {
        /* an older app: the default folder */
      }
      try {
        render(await window.oc.skills.list(), configDir);
      } catch (err) {
        listEl.innerHTML = '';
        listEl.append(note(`Couldn't list the skills: ${ctx.cleanError(err)}`, 'error'));
      }
      return 'ok';
    },
  };
}

// ---------- Pages: Scheduled tasks and Dreaming live on pages of their own; search still finds them ----------

/** Rows only a search shows (the section has no entry in the navigation); choosing one opens its page. */
export function pagesSection(openPage: (target: 'scheduled' | 'scheduled:new' | 'dreaming') => void): Section {
  const el = h('section', {}, sectionTitle('Pages'));
  const link = (id: string, title: string, desc: string, keywords: string, target: 'scheduled' | 'scheduled:new' | 'dreaming') => {
    const open = button('Open', () => openPage(target), { icon: 'arrow-right', aria: `Open: ${title}` });
    const r = row({ id, title, desc, keywords }, open);
    r.el.dataset.page = target;
    r.el.classList.add('clickable');
    return r;
  };
  el.append(
    group(
      null,
      link('page-scheduled', 'Scheduled tasks', 'A page of its own, in the sidebar.', 'scheduled schedule schedules task tasks cron timer recurring repeat hourly daily weekly monthly later automation run prompts rhythm', 'scheduled'),
      link('page-scheduled-new', 'New scheduled task', 'Opens the New task form.', 'create add new scheduled task schedule template form', 'scheduled:new'),
      link('page-dreaming', 'Dreaming', 'A page of its own, in the sidebar.', 'dream dreaming dreams suggestions proposals review reflect learn sessions skills mods memory', 'dreaming'),
      link('page-dreaming-daily', 'Dream every day', 'Set on the Dreaming page.', 'dream daily time night automatic mode auto approve plan skills mods memory look for privacy tokens', 'dreaming'),
    ),
  );
  return { id: 'pages', el };
}

// ---------- Remote control ----------

export function remoteSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Remote control'));
  let status: RemoteStatus | null = null;

  const onInput = switchControl(false, async (on) => {
    try {
      status = await ctx.call(on ? 'remote.start' : 'remote.stop');
      onRow.problem(status.error ?? null);
      if (!status.error) onRow.saved();
      render();
    } catch (err) {
      onInput.checked = !on;
      onRow.problem(`Couldn't turn it ${on ? 'on' : 'off'}: ${ctx.cleanError(err)}`);
    }
  });
  const onRow = row({ id: 'remote-enabled', title: 'Remote control', desc: 'Use your sessions from a phone or another computer.', keywords: 'phone mobile web server access' }, onInput);
  onRow.el.classList.add('clickable');

  const bindSeg = segmented<'localhost' | 'lan'>(
    [
      { value: 'localhost', label: 'This Mac only' },
      { value: 'lan', label: 'Devices on this network' },
    ],
    'localhost',
    async (v) => {
      try {
        status = await ctx.call('remote.configure', { bind: v });
        bindRow.problem(status.error ?? null);
        if (!status.error) bindRow.saved();
        render();
      } catch (err) {
        bindRow.problem(`Couldn't change it: ${ctx.cleanError(err)}`);
        if (status) bindSeg.set(status.bind);
      }
    },
  );
  const bindRow = row({ id: 'remote-bind', title: 'Who can reach it', desc: 'On this network, anyone on your Wi-Fi with the link.', keywords: 'lan localhost network wifi bind' }, bindSeg);

  const linksGroup = group('Links');
  const devicesRow = row({ id: 'remote-clients', title: 'Connected devices', desc: '', keywords: 'clients phones connected' });
  const newLinkRow = row(
    { id: 'remote-newlink', title: 'New link', desc: 'Old links stop working.', keywords: 'token reset revoke access' },
    button('New link', async (b) => {
      const ok = await ctx.confirm({ title: 'Make a new link?', description: 'Old links stop working and connected devices disconnect.', confirmLabel: 'New link', danger: true });
      if (!ok) return;
      b.disabled = true;
      try {
        status = await ctx.call('remote.newLink');
        newLinkRow.problem(null);
        newLinkRow.saved();
        render();
      } catch (err) {
        newLinkRow.problem(`Couldn't make a new link: ${ctx.cleanError(err)}`);
      } finally {
        b.disabled = false;
      }
    }, { icon: 'refresh' }),
  );
  const explain = note(
    'Anyone with a link can read and run your sessions, so share it like a password.',
    'sp-explain',
  );
  el.append(group(null, onRow, bindRow), linksGroup, group('Devices', devicesRow, newLinkRow), explain);

  function render(): void {
    if (!status) return;
    onInput.checked = status.enabled;
    bindSeg.set(status.bind);
    linksGroup.querySelectorAll('.sp-row, .sp-note').forEach((n) => n.remove());
    if (status.running && status.urls.length) {
      status.urls.forEach((u, i) => {
        const host = (() => {
          try {
            return new URL(u).hostname;
          } catch {
            return '';
          }
        })();
        const label = host === 'localhost' || host === '127.0.0.1' ? 'On this Mac' : status!.urls.length > 1 ? `On the network (${host})` : 'Link';
        const copy = h('button', { type: 'button', class: 'btn sm', 'aria-label': `Copy the link ${label}`, html: `${icon('copy', 14)}<span>Copy</span>` });
        copy.addEventListener('click', () => void copyWithFeedback(copy, u));
        const r = row({ id: `remote-url-${i}`, title: label, desc: u.replace(/\/r\/[^/]+/, '/r/••••••'), keywords: 'link url address copy' }, copy);
        r.descEl.classList.add('sp-path');
        r.descEl.title = 'Copies the full link';
        linksGroup.append(r.el);
      });
    } else linksGroup.append(note(status.enabled ? (status.error ? `Couldn't start: ${status.error}` : 'Starting…') : 'Turn it on to get a link.', status.error ? 'error' : ''));
    devicesRow.setDesc(status.running ? (status.clients ? `${status.clients} connected now.` : 'None connected.') : 'Remote control is off.');
    ctx.refreshSearch();
  }

  onPush('remote:changed', (s) => {
    if (!s || typeof s !== 'object') return;
    status = s;
    render();
  });

  return {
    id: 'remote',
    el,
    async load() {
      try {
        status = await ctx.call('remote.status');
      } catch (err) {
        if (ctx.isUnknown(err)) return 'absent';
        onRow.problem(`Couldn't read its state: ${ctx.cleanError(err)}`);
        return 'ok';
      }
      render();
      return 'ok';
    },
  };
}
