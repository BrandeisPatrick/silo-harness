// Skills and Remote control: sections over a feature's own data rather than the config; and the search-only rows that
// open the Scheduled tasks and Dreaming pages.

import type { SkillInfo } from '../../shared/types';
import type { RemoteStatus } from '../../shared/remote';
import { copyWithFeedback, dirname, h } from '../dom.js';
import { icon } from '../icons.js';
import { onPush } from '../rpc.js';
import { button, card, group, iconButton, note, row, sectionTitle, segmented, switchControl } from './ui.js';
import type { Ctx, Section } from './ctx.js';

// ---------- Skills ----------

/** A skill's description up to the end of its first sentence ('' for none). */
export function firstSentence(text: string): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t;
}

export function skillsSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Skills'));
  // Where skills live: one button, not a paragraph of paths
  const folderBtn = button('Open skills folder', () => void ctx.call('app.reveal', 'skills').catch((err) => folderRow.problem(ctx.cleanError(err))), { icon: 'folder' });
  const folderRow = row({ id: 'skills-folder', title: 'Your skills folder', keywords: 'skills folder path where .claude/skills .agents/skills open reveal', bare: true }, folderBtn);
  folderRow.el.classList.add('sp-toolbar-row');
  const listEl = h('div', {});
  el.append(folderRow.el, listEl);
  const GROUPS: { source: SkillInfo['source']; title: string }[] = [
    { source: 'project', title: 'This project' },
    { source: 'user', title: 'Yours' },
    { source: 'bundled', title: 'Built-in' },
  ];
  const open = new Set<string>();

  function render(skills: SkillInfo[]): void {
    listEl.innerHTML = '';
    for (const g of GROUPS) {
      const items = skills.filter((s) => s.source === g.source);
      if (!items.length) continue;
      const rows: HTMLElement[] = [];
      for (const s of items) {
        const id = `skill-${g.source}-${s.name.replace(/[^a-z0-9-]+/gi, '_')}`;
        const whole = s.description || '';
        // One line: the name and the first sentence of what it does; opening the row shows all of it
        const r = row({ id, title: s.name, desc: firstSentence(whole), keywords: `skill ${g.title} ${whole}` });
        r.el.classList.add('sp-skill');
        r.control.append(
          iconButton('folder', `Reveal ${s.name}`, async () => {
            try {
              await window.oc.changes.openInEditor(dirname(s.path).replace(/\/$/, ''));
            } catch (err) {
              r.problem(`Couldn't show the folder: ${ctx.cleanError(err)}`);
            }
          }),
        );
        r.el.title = s.path;
        const full = h('div', { class: 'sp-skill-full', hidden: !open.has(id) }, whole);
        r.descEl.after(full);
        const toggle = () => {
          const now = !open.has(id);
          if (now) open.add(id);
          else open.delete(id);
          full.hidden = !now;
          r.el.classList.toggle('open', now);
        };
        r.el.classList.toggle('open', open.has(id));
        // Only a description longer than its first sentence has more to show
        if (whole.trim() !== firstSentence(whole)) {
          r.el.classList.add('sp-expandable');
          r.el.querySelector('.sp-row-text')!.addEventListener('click', toggle);
        }
        if (s.problems?.length) {
          r.problem(s.problems.join('\n'));
          r.el.querySelector<HTMLElement>('.sp-problem span')?.style.setProperty('white-space', 'pre-line');
        }
        rows.push(r.el);
      }
      listEl.append(card(g.title, ...rows));
    }
    ctx.refreshSearch();
  }

  return {
    id: 'skills',
    el,
    async load() {
      if (typeof window.oc?.skills?.list !== 'function') return 'absent';
      try {
        render(await window.oc.skills.list());
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
  const onRow = row({ id: 'remote-enabled', title: 'Remote control', desc: 'Use your sessions from a phone.', keywords: 'phone mobile web server access another computer' }, onInput);
  onRow.el.classList.add('clickable');

  const bindSeg = segmented<'localhost' | 'lan'>(
    [
      { value: 'localhost', label: 'This Mac only' },
      { value: 'lan', label: 'This network' },
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
  const bindRow = row({ id: 'remote-bind', title: 'Who can reach it', desc: '', keywords: 'lan localhost network wifi bind devices on this network anyone on your wi-fi with the link' }, bindSeg);

  // The links, one row each, with the password line once (on the first)
  const linksEl = h('div', { class: 'sp-rows' });
  const devicesRow = row({ id: 'remote-clients', title: 'Devices', desc: '', keywords: 'clients phones connected devices' });
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
  // While it is off, the switch is all there is
  const onParts = [bindRow.el, linksEl, devicesRow.el, newLinkRow.el];
  el.append(card(null, onRow, bindRow, linksEl, devicesRow, newLinkRow));

  function render(): void {
    if (!status) return;
    onInput.checked = status.enabled;
    bindSeg.set(status.bind);
    for (const p of onParts) p.hidden = !status.enabled;
    bindRow.setDesc(status.bind === 'lan' ? 'Anyone on your Wi-Fi with the link.' : 'Only a browser on this Mac.');
    linksEl.replaceChildren();
    if (status.running && status.urls.length) {
      status.urls.forEach((u, i) => {
        const host = (() => {
          try {
            return new URL(u).hostname;
          } catch {
            return '';
          }
        })();
        const label = host === 'localhost' || host === '127.0.0.1' ? 'On this Mac' : status!.urls.length > 1 ? 'On the network' : 'Link';
        const copy = h('button', { type: 'button', class: 'btn sm', 'aria-label': `Copy the link ${label}`, html: `${icon('copy', 14)}<span>Copy</span>` });
        copy.addEventListener('click', () => void copyWithFeedback(copy, u));
        const masked = u.replace(/\/r\/[^/]+/, '/r/••••••');
        const r = row({ id: `remote-url-${i}`, title: label, desc: i === 0 ? 'Share it like a password.' : '', keywords: 'link url address copy anyone with a link can read and run your sessions share it like a password' }, h('span', { class: 'sp-control-group' }, h('span', { class: 'sp-link-text', title: 'Copy gives the full link' }, masked), copy));
        linksEl.append(r.el);
      });
    } else if (status.enabled) onRow.problem(status.error ? `Couldn't start: ${status.error}` : null);
    devicesRow.setDesc(status.running ? (status.clients ? `${status.clients} connected now.` : 'None connected.') : 'Starting…');
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
