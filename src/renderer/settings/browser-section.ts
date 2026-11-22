// Settings → Browser: the Browser pane's profile (Keep cookies, Clear browsing data), where downloads go, whether the
// chat's links open in the pane, the three lists that decide where the agent acts (sites it may always use, sites
// that always ask, exempt hosts; the built-in ones shown beside the user's own) and the permission answers saved
// from the permission bar. The lists are AppConfig.browser; the answers are the browser's own file, read and reset
// through browser.savedPermissions and browser.resetPermissions. The built-in lists live in the main process
// (policy.ts) and come through browser.builtInLists.

import type { AppConfig } from '../../shared/types';
import type { BrowserBuiltIns, BrowserListField, SavedPermission } from '../../shared/browser';
import { h } from '../dom.js';
import { parseSitePattern, parseText, parseUrl } from './model.js';
import { actions, advanced, button, card, disclosure, note, pathDesc, row, sectionTitle, tildePath, type Choice, type Row } from './ui.js';
import type { Ctx, Section } from './ctx.js';


const KIND_WORDS: Record<string, string> = {
  'sign-in': 'Sign-in pages',
  email: 'Email',
  financial: 'Banks, brokers and wallets',
  payment: 'Payment pages',
  vault: 'Password vaults',
};

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);

export function browserSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Browser'));
  let builtIns: BrowserBuiltIns | null = null;
  const lists = (cfg: AppConfig = ctx.config()) => cfg.browser ?? { keepCookies: true, downloadsDir: '', openChatLinksInPane: false, alwaysAllowed: [], sensitive: [], exempt: [] };

  // ---------- The profile, downloads and links ----------

  const keepCookies = ctx.switchField({
    id: 'browser-keepCookies',
    title: 'Keep cookies after quitting',
    desc: 'Stay signed in between launches.',
    keywords: 'cookies sign in signed session site data profile quit browser pane stay signed in to sites',
    field: 'browser.keepCookies',
  });

  const clearRow = row(
    { id: 'browser-clearData', title: 'Clear browsing data', desc: 'Signs you out of every site.', keywords: 'clear cookies cache history sign out reset browsing data browser pane' },
    button('Clear…', async (b) => {
      const ok = await ctx.confirm({ title: 'Clear browsing data?', description: 'This signs you out of every site and cannot be undone.', confirmLabel: 'Clear', danger: true });
      if (!ok) return;
      b.disabled = true;
      try {
        await ctx.call('browser.clearBrowsingData');
        clearRow.problem(null);
        clearRow.saved();
      } catch (err) {
        clearRow.problem(`Couldn't clear it: ${ctx.cleanError(err)}`);
      } finally {
        b.disabled = false;
      }
    }),
  );

  const changeDir = button('Change…', async (b) => {
    b.disabled = true;
    try {
      const dir = await ctx.call('browser.chooseDownloadsDir');
      if (dir) await ctx.save(dirRow, 'browser.downloadsDir', dir);
    } catch (err) {
      dirRow.problem(`Couldn't choose a folder: ${ctx.cleanError(err)}`);
    } finally {
      b.disabled = false;
    }
  }, { icon: 'folder' });
  const resetDir = button('Reset', () => void ctx.save(dirRow, 'browser.downloadsDir', ''), { aria: 'Use the Downloads folder' });
  const dirRow = row({ id: 'browser-downloadsDir', title: 'Downloads folder', desc: '', keywords: 'downloads download save folder location files directory', field: 'browser.downloadsDir' }, actions(changeDir, resetDir));
  dirRow.descEl.classList.add('sp-path');

  // The main window's window-open handler reads it (browser/feature.ts openChatLink)
  const chatLinks = ctx.switchField({
    id: 'browser-openChatLinksInPane',
    title: 'Open chat links here',
    desc: 'In the Browser pane, not your browser.',
    keywords: 'links chat replies open default browser pane safari chrome open chat links in the browser pane',
    field: 'browser.openChatLinksInPane',
  });

  // ---------- The lists ----------

  /** One editable list: a row per entry with Remove, then one field (its placeholder says what goes in) to add one. */
  function listBlock(o: { id: string; field: BrowserListField; title: string; addTitle: string; addDesc: string; placeholder: string; keywords: string; prefixes?: boolean; folders?: boolean; schemes?: boolean }) {
    const rowsEl = h('div', { class: 'sp-rows' });
    const input = h('input', { type: 'text', class: 'sp-input mono', placeholder: o.placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': o.addTitle, title: o.addDesc });
    const addBtn = button('Add', () => void add(), { icon: 'plus', aria: o.addTitle });
    // The add row shows its field and button only; its words are for the search and screen readers
    const addRow = row({ id: `${o.id}-add`, title: o.addTitle, desc: o.addDesc, keywords: o.keywords, bare: true }, actions(h('span', { class: 'sp-text sp-add-field' }, input), addBtn));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void add();
      }
    });
    input.addEventListener('input', () => addRow.problem(null));
    let shown = '';

    /** One entry added or removed by the main process, on its own config (a site card may have added one meanwhile). */
    async function edit(op: 'add' | 'remove', value: string, at: Row): Promise<boolean> {
      try {
        await ctx.call('browser.editList', o.field, op, value);
        at.problem(null);
        at.saved();
        return true;
      } catch (err) {
        at.problem(`Couldn't save: ${ctx.cleanError(err)}`);
        return false;
      }
    }

    async function add(): Promise<void> {
      const parsed = parseSitePattern(input.value, { prefixes: o.prefixes, folders: o.folders, schemes: o.schemes });
      if (!parsed.ok) {
        addRow.problem(parsed.error);
        return;
      }
      const current = lists()[o.field];
      if (current.some((x) => x.toLowerCase() === parsed.value.toLowerCase())) {
        addRow.problem(`${parsed.value} is already in the list.`);
        return;
      }
      if (await edit('add', parsed.value, addRow)) input.value = '';
    }

    function render(cfg: AppConfig): void {
      const items = lists(cfg)[o.field];
      const key = JSON.stringify(items);
      if (key === shown) return;
      shown = key;
      rowsEl.replaceChildren();
      items.forEach((item, i) => {
        const folder = /^[/~]/.test(item) || item.startsWith('file:');
        const r = row(
          { id: `${o.id}-${i}-${slug(item)}`, title: folder ? tildePath(item.replace(/^file:/, '')) : item, keywords: `${o.keywords} ${item}` },
          button('Remove', () => void edit('remove', item, r), { aria: `Remove ${item}` }),
        );
        if (folder) r.el.title = item;
        rowsEl.append(r.el);
      });
      ctx.refreshSearch();
    }

    return { title: o.title, rowsEl, addRow, render };
  }

  const allowed = listBlock({
    id: 'browser-alwaysAllowed',
    field: 'alwaysAllowed',
    title: 'Sites the agent may always use',
    addTitle: 'Add a site',
    addDesc: 'The agent uses it without asking, unless it is sensitive. Without http:// it covers https only.',
    placeholder: 'Add a site, like example.com',
    keywords: 'always allow allowed sites agent approve approval card trust browser without asking unless it is sensitive http https only',
    schemes: true,
  });

  const sensitive = listBlock({
    id: 'browser-sensitive',
    field: 'sensitive',
    title: 'Sites that always ask',
    addTitle: 'Add a site that always asks',
    addDesc: 'Every action there asks first, except in Bypass.',
    placeholder: 'Add a site, like mybank.example',
    keywords: 'sensitive always ask bank email sign in login financial payment sites agent browser every action asks first bypass',
    prefixes: true,
  });
  // The built-in sites that always ask, folded under their count
  const sensitiveFold = disclosure('Built-in', { cls: 'sp-inner-fold' });
  const builtInSensitive = sensitiveFold.body;

  const exempt = listBlock({
    id: 'browser-exempt',
    field: 'exempt',
    title: 'Exempt hosts',
    addTitle: 'Add an exempt host',
    addDesc: 'Your dev servers; the agent may type test passwords there.',
    placeholder: 'Add a host, like myapp.local:8080',
    keywords: 'exempt localhost development dev server local hosts folder files agent browser test passwords',
    folders: true,
  });
  const builtInExempt = row({ id: 'browser-exempt-builtin', title: 'Built-in', desc: '', keywords: 'exempt localhost 127.0.0.1 local test development any port' });
  builtInExempt.descEl.classList.add('sp-mono-list');

  // ---------- Web search (web_search's backend, AppConfig.webSearch) ----------

  type SearchProvider = NonNullable<NonNullable<AppConfig['webSearch']>['provider']>;
  const SEARCH_PROVIDERS: Choice<SearchProvider>[] = [
    { value: 'duckduckgo', label: 'DuckDuckGo' },
    { value: 'brave', label: 'Brave' },
    { value: 'tavily', label: 'Tavily' },
    { value: 'exa', label: 'Exa' },
    { value: 'searxng', label: 'SearXNG' },
  ];
  const searchProvider = (cfg: AppConfig = ctx.config()): SearchProvider => cfg.webSearch?.provider ?? 'duckduckgo';
  const searchRow = ctx.selectField<SearchProvider>({
    id: 'webSearch-provider',
    title: 'Web search',
    keywords: 'web search provider duckduckgo brave tavily exa searxng web_search',
    field: 'webSearch.provider',
    choices: SEARCH_PROVIDERS,
    read: (v) => (typeof v === 'string' && v ? (v as SearchProvider) : 'duckduckgo'),
    onSaved: () => syncSearch(ctx.config()),
  });
  const searchKey = ctx.textField({ id: 'webSearch-apiKey', inputId: 'webSearch-apiKey', title: 'Search API key', keywords: 'web search key token secret brave tavily exa api', field: 'webSearch.apiKey', type: 'password', placeholder: 'Key', parse: parseText });
  const searchBase = ctx.textField({ id: 'webSearch-baseUrl', inputId: 'webSearch-baseUrl', title: 'SearXNG address', keywords: 'web search searxng url address instance', field: 'webSearch.baseUrl', placeholder: 'http://localhost:8888', mono: true, parse: parseUrl });
  function syncSearch(cfg: AppConfig): void {
    const p = searchProvider(cfg);
    searchKey.el.hidden = !(p === 'brave' || p === 'tavily' || p === 'exa');
    searchBase.el.hidden = p !== 'searxng';
  }

  // ---------- Permissions ----------

  const permsEl = h('div', { class: 'sp-rows' });
  const resetAll = button('Reset all', async (b) => {
    const ok = await ctx.confirm({ title: 'Reset every permission?', description: 'Every site asks again next time.', confirmLabel: 'Reset all' });
    if (!ok) return;
    b.disabled = true;
    try {
      renderPermissions(await ctx.call('browser.resetPermissions'));
      resetAllRow.saved();
    } catch (err) {
      resetAllRow.problem(ctx.cleanError(err));
    } finally {
      b.disabled = false;
    }
  });
  const resetAllRow = row({ id: 'browser-permissions-reset', title: 'Reset all permissions', desc: 'Every site asks again.', keywords: 'reset permissions camera microphone notifications location allow block saved' }, resetAll);
  const permsCard = card('Saved permissions', permsEl, resetAllRow);
  permsCard.hidden = true;

  function renderPermissions(list: SavedPermission[]): void {
    permsEl.replaceChildren();
    list.forEach((p, i) => {
      const r = row(
        { id: `browser-permission-${i}-${slug(p.key + p.capability)}`, title: p.site, desc: `${p.label}: ${p.decision === 'allow' ? 'Allowed' : 'Blocked'}`, keywords: `permission ${p.capability} ${p.label} ${p.decision === 'allow' ? 'allowed allow' : 'blocked block deny'} camera microphone notifications` },
        button('Reset', async (b) => {
          b.disabled = true;
          try {
            renderPermissions(await ctx.call('browser.resetPermissions', p.key, p.capability));
          } catch (err) {
            r.problem(ctx.cleanError(err));
            b.disabled = false;
          }
        }, { aria: `Reset ${p.label} for ${p.site}` }),
      );
      r.el.dataset.permission = `${p.key} ${p.capability}`;
      r.el.title = p.key;
      permsEl.append(r.el);
    });
    resetAllRow.el.hidden = !list.length;
    permsCard.hidden = !list.length;
    ctx.refreshSearch();
  }

  el.append(
    card(null, keepCookies, chatLinks, dirRow, searchRow, searchKey, searchBase, clearRow),
    advanced(
      'browser',
      card(allowed.title, allowed.rowsEl, allowed.addRow),
      card(sensitive.title, sensitive.rowsEl, sensitive.addRow, sensitiveFold),
      card(exempt.title, exempt.rowsEl, exempt.addRow, builtInExempt),
      permsCard,
    ),
  );

  function renderBuiltIns(): void {
    const b = builtIns;
    if (!b) return;
    sensitiveFold.querySelector('.sp-disclosure span')!.textContent = `Built-in (${b.sensitive.length})`;
    builtInSensitive.replaceChildren();
    const kinds = [...new Set(b.sensitive.map((s) => s.kind))];
    for (const kind of kinds) {
      const patterns = b.sensitive.filter((s) => s.kind === kind).map((s) => s.pattern);
      const r = row({ id: `browser-sensitive-builtin-${kind}`, title: KIND_WORDS[kind] ?? kind, desc: patterns.join(', ') + (kind === 'financial' ? ', and any host with the word "bank"' : ''), keywords: `sensitive built-in always ask ${kind} ${patterns.join(' ')}` });
      r.descEl.classList.add('sp-mono-list');
      builtInSensitive.append(r.el);
    }
    builtInExempt.setDesc(`${b.exempt.join(', ')}, any port`);
    builtInExempt.descEl.title = `${b.exempt.join(', ')}, with any port`;
    renderDir(ctx.config());
    ctx.refreshSearch();
  }

  function renderDir(cfg: AppConfig): void {
    const own = lists(cfg).downloadsDir;
    const shown = own || builtIns?.downloadsDir || '';
    if (shown) pathDesc(dirRow, shown);
    else dirRow.setDesc('The Downloads folder');
    resetDir.hidden = !own;
  }

  function sync(cfg: AppConfig): void {
    renderDir(cfg);
    syncSearch(cfg);
    allowed.render(cfg);
    sensitive.render(cfg);
    exempt.render(cfg);
  }

  return {
    id: 'browser',
    el,
    sync,
    async load() {
      try {
        builtIns = await ctx.call('browser.builtInLists');
      } catch (err) {
        if (ctx.isUnknown(err)) return 'absent';
        builtIns = null;
      }
      renderBuiltIns();
      sync(ctx.config());
      try {
        renderPermissions(await ctx.call('browser.savedPermissions'));
      } catch (err) {
        permsCard.hidden = false;
      permsEl.replaceChildren(note(`Couldn't read the saved answers: ${ctx.cleanError(err)}`, 'error'));
      }
      return 'ok';
    },
  };
}
