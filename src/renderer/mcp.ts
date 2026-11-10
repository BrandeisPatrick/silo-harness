// Settings → MCP servers: the server list (status, scope, target, tools; enable, reconnect, remove) and the
// "Add server" form. Changes go straight to oc.mcp (they are not part of the Settings form's Save).
// Also: the /mcp notice card's markup and an in-memory stand-in for oc.mcp (the debug hook's mock).

import type { McpApi, McpScope, McpServerConfig, McpServerInfo, McpStatus, McpToolInfo } from '../shared/types';
import type { ConfirmOptions } from './changes.js';
import { escapeHtml } from './dom.js';
import { icon, type IconName } from './icons.js';
import { tilde } from './home.js';
import { noteMcpServers } from './mcp-labels.js';
import { parseHeaders, suggestName, understood, toolGroups, type ToolEntry, hasSwitch, MENU_LABELS, menuActions, primaryAction, reasonLine, safeLines, serverSubtitle, STATUS_WORDS, statusText, statusTone, trustLines, unsetText, copyText, plural, type MenuKind } from './mcp-model.js';
import { openMenu, type MenuItem } from './popover.js';

/** The status words (mcp-model.ts), kept under the old name for the debug hook and tests */
export const MCP_STATUS_LABEL = STATUS_WORDS;

const STATUSES = new Set<string>(Object.keys(MCP_STATUS_LABEL));

export function mcpKey(s: Pick<McpServerInfo, 'name' | 'scope'>): string {
  return `${s.scope}:${s.name}`;
}

/** Drops malformed entries and fills optional fields, so rendering never trips over a partial object. */
export function cleanServers(list: unknown): McpServerInfo[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is McpServerInfo => !!s && typeof s === 'object' && typeof (s as McpServerInfo).name === 'string' && (s as McpServerInfo).name !== '')
    .map((s) => ({
      ...s,
      scope: s.scope === 'project' ? 'project' : 'user',
      status: STATUSES.has(s.status) ? s.status : 'error',
      target: typeof s.target === 'string' ? s.target : '',
      tools: Array.isArray(s.tools) ? s.tools.filter((t) => t && typeof t.name === 'string') : [],
      hiddenTools: Array.isArray(s.hiddenTools) ? s.hiddenTools.filter((t) => typeof t === 'string') : undefined,
    }));
}

/** "Connected · 12 tools", "Connecting…", "Failed", … */
export function mcpStatusText(s: McpServerInfo): string {
  return statusText(s);
}

/** KEY=value per line (blank lines and # comments are skipped; "export " and surrounding quotes are allowed). */
export function parseEnv(text: string): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) return { env, error: `Environment line ${i + 1} should look like KEY=value.` };
    let value = m[2];
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    env[m[1]] = value;
  }
  return { env };
}

export type SpecKind = 'empty' | 'url' | 'block' | 'json' | 'command';

/** What the Config field holds: a URL, a whole {"mcpServers": …} block, another JSON snippet, or a command line. */
export function specKind(spec: string): SpecKind {
  const s = spec.trim();
  if (!s) return 'empty';
  if (/^https?:\/\//i.test(s)) return 'url';
  if (s.startsWith('{') || s.startsWith('"')) return /"mcpServers"\s*:/.test(s) ? 'block' : 'json';
  return 'command';
}

// ---------- The Settings section ----------

export interface McpPanelElements {
  /** #mcp-list */
  list: HTMLElement;
  /** #mcp-status: why an action on a row failed */
  status: HTMLElement;
  name: HTMLInputElement;
  /** The Name field's label text (says "optional" for an mcpServers block) */
  nameLabel: HTMLElement;
  spec: HTMLTextAreaElement;
  env: HTMLTextAreaElement;
  scope: HTMLSelectElement;
  add: HTMLButtonElement;
  /** #mcp-add-error */
  error: HTMLElement;
}

export interface McpPanelOptions {
  els: McpPanelElements;
  /** oc.mcp, the debug mock, or null when the running app has no MCP support */
  source: () => McpApi | null;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  cleanError: (err: unknown) => string;
  /** The user added, removed or switched a server (the app re-reads its config) */
  onMutated?: () => void;
  /** The working directory (where a project's .mcp.json lives), for the remove confirmation */
  projectDir: () => string;
}

export interface McpPanel {
  /** Shows this list (from oc.mcp.onServers or an action's result) */
  render(servers: McpServerInfo[]): void;
  /** Reloads the list from the source; null when that failed */
  refresh(): Promise<McpServerInfo[] | null>;
  servers(): McpServerInfo[];
  /** Clears the messages left from last time (Settings opened again) */
  resetMessages(): void;
  /** Scrolls to a server's row and focuses it; with `trust`, its Trust confirmation opens */
  showRow(key: string, trust?: boolean): void;
}

const slug = (key: string): string => key.replace(/[^A-Za-z0-9_-]+/g, '-');

function shortDir(p: string): string {
  return tilde(p).replace(/\/+$/, '');
}

function toolHtml(t: ToolEntry, key: string, switchable: boolean): string {
  const desc = t.description;
  const sw = switchable
    ? `<label class="mcp-tool-switch" title="${escapeHtml(t.off ? `Turn ${t.name} on` : `Turn ${t.name} off`)}"><input type="checkbox" class="switch sm" data-tool="${escapeHtml(t.name)}" ${t.off ? '' : 'checked'} aria-label="${escapeHtml(`${t.title} on`)}" data-focus-key="${escapeHtml(`${key}|tool|${t.name}`)}"></label>`
    : '';
  return (
    `<div class="mcp-tool${t.off ? ' off' : ''}" role="listitem"><div class="mcp-tool-text"><div class="mcp-tool-head"><span class="mcp-tool-title">${escapeHtml(t.title)}</span>` +
    (t.showName ? `<code class="mcp-tool-name">${escapeHtml(t.name)}</code>` : '') +
    (t.destructive ? `<span class="mcp-tag danger" title="Destructive: auto mode asks before running it">destructive</span>` : '') +
    (t.off ? '<span class="mcp-tool-off">off</span>' : '') +
    `</div>` +
    (desc ? `<div class="mcp-tool-desc" title="${escapeHtml(desc.length > 1200 ? `${desc.slice(0, 1200)}…` : desc)}">${escapeHtml(desc)}</div>` : '') +
    `</div>${sw}</div>`
  );
}

const MENU_ICONS: Record<MenuKind, IconName> = { reconnect: 'refresh', 'sign-out': 'x', log: 'terminal', copy: 'copy', remove: 'trash' };

export function createMcpPanel(opts: McpPanelOptions): McpPanel {
  const { els } = opts;
  /** Rows whose tool list is open, by scope:name (kept across re-renders) */
  const expanded = new Set<string>();
  /** Rows with an action in flight; for enable/disable, the state the switch shows meanwhile */
  const busy = new Map<string, { enabled?: boolean }>();
  let current: McpServerInfo[] = [];
  let unavailable = false;
  let adding = false;
  let flashKeys = new Set<string>();

  const showStatus = (message: string) => {
    els.status.innerHTML = `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>`;
    els.status.hidden = false;
  };
  const hideStatus = () => {
    els.status.hidden = true;
    els.status.textContent = '';
  };
  // The form's other parts, found by id (the panel's hookup in renderer.ts names only the original ones)
  const form = {
    root: document.getElementById('mcp-add'),
    open: document.getElementById('mcp-add-open') as HTMLButtonElement | null,
    cancel: document.getElementById('mcp-add-cancel') as HTMLButtonElement | null,
    understood: document.getElementById('mcp-understood'),
    envLabel: document.getElementById('mcp-env-label'),
    valuesHint: document.getElementById('mcp-values-hint'),
  };
  const errorHome = { parent: els.error.parentElement, next: els.error.nextSibling };
  /** An error sits under the field it is about (or in the form's foot) */
  const showAddError = (message: string, focus?: HTMLElement) => {
    els.error.innerHTML = `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>`;
    const inField = focus?.closest('.field');
    // A field in the two-column row (Name, Scope): the line goes under that row, not into it
    const field = inField?.parentElement?.classList.contains('field-grid') ? inField.parentElement : inField;
    if (field) field.after(els.error);
    else if (errorHome.parent) errorHome.parent.insertBefore(els.error, errorHome.next);
    els.error.classList.toggle('by-field', !!field);
    els.error.hidden = false;
    focus?.focus();
  };
  const hideAddError = () => {
    els.error.hidden = true;
    els.error.textContent = '';
  };
  /** The name the form filled in last (a name the user typed is never replaced) */
  let suggested = '';
  const formOpen = () => !!form.root && !form.root.hidden;
  const setFormOpen = (open: boolean, focus = true) => {
    if (!form.root) return;
    form.root.hidden = !open;
    form.open?.setAttribute('aria-expanded', String(open));
    if (open && focus) els.spec.focus();
    if (!open) {
      hideAddError();
      if (focus) form.open?.focus();
    }
  };

  const syncForm = () => {
    const kind = specKind(els.spec.value);
    const block = kind === 'block';
    const url = kind === 'url' || (kind === 'json' && /"url"\s*:/.test(els.spec.value));
    els.nameLabel.textContent = block ? 'Name (from the block)' : 'Name';
    els.name.placeholder = block ? 'Taken from the block' : 'e.g. github';
    els.name.disabled = block;
    // A URL takes headers ("Name: value"), a command takes environment variables ("KEY=value")
    if (form.envLabel) form.envLabel.innerHTML = url ? 'Headers <span class="field-opt">· Name: value per line</span>' : 'Environment <span class="field-opt">· KEY=value per line</span>';
    els.env.placeholder = url ? 'Authorization: Bearer …' : 'GITHUB_TOKEN=ghp_…';
    els.env.setAttribute('aria-label', url ? 'Headers' : 'Environment');
    if (form.understood) form.understood.textContent = understood(els.spec.value);
    if (form.valuesHint) form.valuesHint.hidden = els.scope.value !== 'project';
    const next = block ? '' : suggestName(els.spec.value);
    if (!els.name.value.trim() || els.name.value === suggested) {
      els.name.value = next;
      suggested = next;
    }
    // Stays enabled while adding (keeps keyboard focus); the busy class and the `adding` guard stop a second click.
    els.add.disabled = unavailable;
  };

  /** Rows whose Trust confirmation or log is open, by scope:name */
  const confirming = new Set<string>();
  const logs = new Map<string, string[] | 'loading' | 'unavailable'>();
  /** A row whose config was just copied: its status line says so for a moment */
  let copiedKey = '';

  const row = (s: McpServerInfo): HTMLElement => {
    const key = mcpKey(s);
    const name = s.name;
    const fk = escapeHtml(key);
    const pending = busy.get(key);
    const on = pending?.enabled ?? (s.status !== 'disabled' && s.status !== 'blocked');
    const tools = s.tools;
    const listed = tools.length + (s.offTools?.length ?? 0);
    const open = expanded.has(key) && listed > 0;
    const toolsId = `mcp-tools-${slug(key)}`;
    const tone = statusTone(s.status);
    const el = document.createElement('div');
    el.className = `mcp-row ${s.status} tone-${tone}${busy.has(key) ? ' busy' : ''}${flashKeys.has(key) ? ' flash' : ''}`;
    el.setAttribute('role', 'listitem');
    el.dataset.key = key;
    el.dataset.name = name;
    el.dataset.scope = s.scope;
    el.dataset.status = s.status;

    const words = STATUS_WORDS[s.status];
    const primary = primaryAction(s);
    let primaryHtml = '';
    if (primary?.kind === 'tools') {
      primaryHtml = `<button type="button" class="btn sm mcp-primary mcp-tools-toggle" aria-expanded="${open}" aria-controls="${toolsId}" data-focus-key="${fk}|tools"><span>${escapeHtml(primary.label)}</span>${icon('chevron-down', 14)}</button>`;
    } else if (primary) {
      const extra = primary.kind === 'trust' ? ` aria-expanded="${confirming.has(key)}"` : '';
      primaryHtml = `<button type="button" class="btn sm mcp-primary" data-action="${primary.kind}" data-focus-key="${fk}|${primary.kind}"${extra}>${escapeHtml(primary.label)}</button>`;
    }
    const reason = s.status === 'error' || s.status === 'reconnecting' || s.status === 'needs-auth' || (s.status === 'blocked' && s.error) ? reasonLine(s) : '';
    const unset = unsetText(s);
    const copied = copiedKey === key;
    const statusHtml =
      `<span class="mcp-words">${escapeHtml(copied ? 'Config copied' : words)}</span>` +
      (!copied && reason ? `<span class="mcp-reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>` : '') +
      (!copied && unset ? `<span class="mcp-unset">${escapeHtml(unset)}</span>` : '');
    const sub = serverSubtitle(s);
    const pill = s.scope === 'project' ? `<span class="mcp-scope project" title="${escapeHtml(`${shortDir(opts.projectDir()) || 'This project'}/.mcp.json`)}">project</span>` : '';
    const target = s.target || (s.transport === 'stdio' ? '' : s.transport);
    const initial = (Array.from(name)[0] ?? '?').toUpperCase();
    el.innerHTML =
      `<div class="mcp-main">` +
      `<span class="mcp-tile" aria-hidden="true">${escapeHtml(initial)}<span class="mcp-dot ${s.status}"></span></span>` +
      `<div class="mcp-info"><div class="mcp-line"><span class="mcp-name">${escapeHtml(name)}</span>${pill}${sub ? `<span class="mcp-sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</span>` : ''}</div>` +
      (target ? `<div class="mcp-target" title="${escapeHtml(target)}">${escapeHtml(target)}</div>` : '') +
      `<div class="mcp-status-line tone-${tone}" role="status">${statusHtml}</div>` +
      `</div>` +
      primaryHtml +
      (hasSwitch(s)
        ? `<label class="mcp-switch" title="${escapeHtml(on ? `Turn ${name} off` : `Turn ${name} on`)}"><input type="checkbox" class="switch" ${on ? 'checked' : ''} aria-label="${escapeHtml(`${name} on`)}" data-focus-key="${fk}|switch"></label>`
        : '<span class="mcp-switch-space" aria-hidden="true"></span>') +
      `<button type="button" class="icon-btn sm mcp-more" aria-label="${escapeHtml(`More for ${name}`)}" aria-haspopup="menu" title="More" data-focus-key="${fk}|more">${icon('more', 16)}</button>` +
      `</div>`;

    if (confirming.has(key) && s.status === 'blocked') {
      const box = document.createElement('div');
      box.className = 'mcp-confirm';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', `Trust ${name}?`);
      box.tabIndex = -1;
      box.innerHTML =
        `<ul class="mcp-confirm-lines">${trustLines(s).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` +
        `<div class="mcp-confirm-foot"><button type="button" class="btn sm mcp-confirm-cancel" data-focus-key="${fk}|confirm-cancel">Cancel</button>` +
        `<button type="button" class="btn sm primary mcp-confirm-ok" data-focus-key="${fk}|confirm-ok">Trust</button></div>`;
      el.appendChild(box);
    }
    const log = logs.get(key);
    if (log) {
      const box = document.createElement('div');
      box.className = 'mcp-log';
      const pre = document.createElement('pre');
      pre.className = 'mcp-log-text';
      pre.textContent = log === 'loading' ? 'Loading…' : log === 'unavailable' ? 'The log needs the updated app.' : log.length ? log.join('\n') : 'Nothing printed yet.';
      box.appendChild(pre);
      el.appendChild(box);
    }
    if (listed) {
      const list = document.createElement('div');
      list.className = 'mcp-tools';
      list.id = toolsId;
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', `${name} tools`);
      list.hidden = !open;
      // A user server's tools have a switch each (it writes disabledTools); a project server's file is shared: read-only here
      const switchable = s.scope === 'user' && typeof opts.source()?.setToolEnabled === 'function';
      const offCount = s.offTools?.length ?? s.hiddenTools?.length ?? 0;
      list.innerHTML =
        (offCount && !s.offTools?.length ? `<div class="mcp-tools-head">${escapeHtml(`${offCount} off`)}</div>` : '') +
        toolGroups(s)
          .map((g) => `<div class="mcp-tools-group" role="presentation">${escapeHtml(g.label)}</div>` + g.tools.map((t) => toolHtml(t, key, switchable)).join(''))
          .join('');
      el.appendChild(list);
      list.querySelectorAll<HTMLInputElement>('input.switch[data-tool]').forEach((box) => {
        box.addEventListener('change', () => {
          const tool = box.dataset.tool ?? '';
          if (busy.has(key) || !tool) {
            box.checked = !box.checked;
            return;
          }
          void act(s, box.checked ? 'enable a tool of' : 'turn off a tool of', (api) => api.setToolEnabled!(name, s.scope, tool, box.checked));
        });
      });
    }

    const sw = el.querySelector<HTMLInputElement>('input.switch');
    const more = el.querySelector<HTMLButtonElement>('.mcp-more')!;
    const toggle = el.querySelector<HTMLButtonElement>('.mcp-tools-toggle');
    // While an action runs the controls stay focusable (a re-render keeps keyboard focus) but do nothing.
    if (busy.has(key)) [sw, more].forEach((c) => c?.setAttribute('aria-disabled', 'true'));
    sw?.addEventListener('change', () => {
      if (busy.has(key)) {
        sw.checked = !sw.checked;
        return;
      }
      const enabled = sw.checked;
      void act(s, enabled ? 'enable' : 'disable', (api) => api.setEnabled(name, s.scope, enabled), enabled);
    });
    const primaryBtn = el.querySelector<HTMLButtonElement>('.mcp-primary[data-action]');
    if (primaryBtn) {
      primaryBtn.onclick = () => {
        if (busy.has(key)) return;
        switch (primaryBtn.dataset.action) {
          case 'sign-in':
            return void act(s, 'sign in', (api) => api.signIn(name, s.scope));
          case 'cancel':
            return void act(s, 'cancel sign-in for', (api) => api.cancelSignIn(name, s.scope));
          case 'retry':
            return void act(s, 'reconnect', (api) => api.reconnect(name, s.scope));
          case 'trust':
            if (confirming.has(key)) confirming.delete(key);
            else confirming.add(key);
            panel.render(current);
            // The confirmation takes focus as a whole, not its Trust button
            if (confirming.has(key)) els.list.querySelector<HTMLElement>(`.mcp-row[data-key="${CSS.escape(key)}"] .mcp-confirm`)?.focus();
            return;
        }
      };
    }
    el.querySelector<HTMLButtonElement>('.mcp-confirm-cancel')?.addEventListener('click', () => {
      confirming.delete(key);
      panel.render(current);
      els.list.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(`${key}|trust`)}"]`)?.focus();
    });
    el.querySelector<HTMLButtonElement>('.mcp-confirm-ok')?.addEventListener('click', () => {
      confirming.delete(key);
      void act(s, 'enable', (api) => api.setEnabled(name, s.scope, true), true);
    });
    el.querySelector<HTMLElement>('.mcp-confirm')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        confirming.delete(key);
        panel.render(current);
      }
    });
    more.onclick = () => {
      if (busy.has(key)) return;
      const kinds = menuActions(s);
      const item = (k: MenuKind): MenuItem => ({
        label: k === 'log' && logs.has(key) ? 'Hide log' : MENU_LABELS[k],
        icon: MENU_ICONS[k],
        danger: k === 'remove',
        onSelect: () => void menuAction(s, k),
      });
      openMenu(
        [{ items: kinds.filter((k) => k !== 'remove').map(item) }, { items: kinds.filter((k) => k === 'remove').map(item) }],
        { anchor: more, placement: 'bottom-end', className: 'mcp-menu', minWidth: 160 },
      );
    };
    if (toggle) {
      toggle.onclick = () => {
        const listEl = el.querySelector<HTMLElement>('.mcp-tools');
        if (!listEl) return;
        const show = listEl.hidden;
        listEl.hidden = !show;
        toggle.setAttribute('aria-expanded', String(show));
        if (show) expanded.add(key);
        else expanded.delete(key);
      };
    }
    return el;
  };

  async function menuAction(s: McpServerInfo, k: MenuKind): Promise<void> {
    const key = mcpKey(s);
    const name = s.name;
    const focusMore = () => els.list.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(`${key}|more`)}"]`)?.focus();
    switch (k) {
      case 'reconnect':
        return act(s, 'reconnect', (api) => api.reconnect(name, s.scope));
      case 'sign-out':
        return act(s, 'sign out of', (api) => api.signOut(name, s.scope));
      case 'copy':
        try {
          await navigator.clipboard.writeText(copyText(s));
          copiedKey = key;
          panel.render(current);
          window.setTimeout(() => {
            if (copiedKey !== key) return;
            copiedKey = '';
            panel.render(current);
          }, 1600);
        } catch (err) {
          showStatus(`Couldn't copy the config of ${name}: ${opts.cleanError(err)}`);
        }
        focusMore();
        return;
      case 'log': {
        if (logs.has(key)) {
          logs.delete(key);
          panel.render(current);
          focusMore();
          return;
        }
        const api = opts.source();
        if (!api || typeof api.log !== 'function') {
          logs.set(key, 'unavailable');
          panel.render(current);
          return;
        }
        logs.set(key, 'loading');
        panel.render(current);
        try {
          const lines = safeLines(await api.log(name, s.scope));
          if (logs.has(key)) logs.set(key, lines);
        } catch (err) {
          logs.delete(key);
          showStatus(`Couldn't read the log of ${name}: ${opts.cleanError(err)}`);
        }
        panel.render(current);
        focusMore();
        return;
      }
      case 'remove': {
        const dir = opts.projectDir();
        const ok = await opts.confirm({
          title: `Remove ${name}?`,
          description:
            s.scope === 'project'
              ? `This edits the project's .mcp.json${dir ? ` (${shortDir(dir)}/.mcp.json)` : ''}: the server is deleted from the file, for everyone who uses it.`
              : "Silo Harness disconnects it and deletes it from this Mac's settings.",
          confirmLabel: 'Remove',
          danger: true,
        });
        if (ok) await act(s, 'remove', (api) => api.remove(name, s.scope));
        return;
      }
    }
  }

  const VERBS: Record<string, string> = { 'enable a tool of': 'turn on a tool of', 'turn off a tool of': 'turn off a tool of', enable: 'enable', disable: 'disable', reconnect: 'reconnect', remove: 'remove', 'sign in': 'sign in to', 'cancel sign-in for': 'cancel sign-in for', 'sign out of': 'sign out of' };

  async function act(s: McpServerInfo, action: 'enable' | 'disable' | 'reconnect' | 'remove' | 'sign in' | 'cancel sign-in for' | 'sign out of' | 'enable a tool of' | 'turn off a tool of', run: (api: McpApi) => Promise<McpServerInfo[]>, enabled?: boolean): Promise<void> {
    const key = mcpKey(s);
    if (busy.has(key)) return;
    const api = opts.source();
    if (!api) {
      showStatus(`Couldn't ${VERBS[action]} ${s.name}: this needs the updated app. Restart Silo Harness and try again.`);
      panel.render(current);
      return;
    }
    busy.set(key, { enabled });
    panel.render(current);
    try {
      const next = await run(api);
      busy.delete(key);
      hideStatus();
      if (action === 'remove') {
        expanded.delete(key);
        logs.delete(key);
        confirming.delete(key);
      }
      panel.render(Array.isArray(next) ? next : current);
      opts.onMutated?.();
    } catch (err) {
      busy.delete(key);
      panel.render(current);
      showStatus(`Couldn't ${VERBS[action]} ${s.name}: ${opts.cleanError(err)}`);
    }
  }

  async function add(): Promise<void> {
    if (adding) return;
    const spec = els.spec.value.trim();
    const kind = specKind(spec);
    const name = kind === 'block' ? '' : els.name.value.trim();
    if (kind === 'empty') return showAddError('Paste a command, a URL or JSON.', els.spec);
    if (kind === 'json') {
      try {
        JSON.parse(spec);
      } catch {
        return showAddError("That JSON doesn't parse.", els.spec);
      }
    }
    if (!name && kind !== 'block') return showAddError('Give it a name.', els.name);
    if (name && !/^[\w.-]{1,64}$/.test(name)) return showAddError('Letters, digits, ".", "-" and "_" only.', els.name);
    const isUrl = kind === 'url' || (kind === 'json' && /"url"\s*:/.test(spec));
    const parsed = isUrl ? { env: {}, error: undefined } : parseEnv(els.env.value);
    if (parsed.error) return showAddError(parsed.error, els.env);
    const parsedHeaders = isUrl ? parseHeaders(els.env.value) : { headers: {}, error: undefined };
    if (parsedHeaders.error) return showAddError(parsedHeaders.error, els.env);
    if (current.some((x) => x.name === name && x.scope === (els.scope.value === 'project' ? 'project' : 'user'))) return showAddError(`There is already a server named ${name}.`, els.name);
    const api = opts.source();
    if (!api) return showAddError('Adding servers needs the updated app. Restart Silo Harness and try again.');
    const scope: McpScope = els.scope.value === 'project' ? 'project' : 'user';
    const before = new Set(current.map(mcpKey));
    adding = true;
    els.add.classList.add('busy');
    els.add.querySelector('span:last-child')!.textContent = 'Adding…';
    syncForm();
    try {
      const next = await api.add(name, spec, scope, Object.keys(parsed.env).length ? parsed.env : undefined, Object.keys(parsedHeaders.headers).length ? parsedHeaders.headers : undefined);
      hideAddError();
      hideStatus();
      els.name.value = '';
      suggested = '';
      els.spec.value = '';
      els.env.value = '';
      setFormOpen(false, false);
      const list = cleanServers(next);
      flashKeys = new Set(list.map(mcpKey).filter((k) => !before.has(k)));
      panel.render(list);
      window.setTimeout(() => {
        flashKeys = new Set();
        els.list.querySelectorAll('.mcp-row.flash').forEach((r) => r.classList.remove('flash'));
      }, 1600);
      opts.onMutated?.();
    } catch (err) {
      const msg = opts.cleanError(err);
      // An error about the name or the config sits under that field
      showAddError(msg, /named|name/i.test(msg) ? els.name : /secret|Environment|env/i.test(msg) ? els.env : /JSON|command|url|mcpServers|transport|args/i.test(msg) ? els.spec : undefined);
    } finally {
      adding = false;
      els.add.classList.remove('busy');
      els.add.querySelector('span:last-child')!.textContent = 'Add';
      syncForm();
    }
  }

  els.add.addEventListener('click', () => void add());
  // Enter in the name field adds instead of submitting the Settings form; ⌘↵ adds from the text areas.
  els.name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void add();
    }
  });
  for (const ta of [els.spec, els.env]) {
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
        e.preventDefault();
        void add();
      }
    });
  }
  els.spec.addEventListener('input', () => {
    syncForm();
    if (!els.error.hidden) hideAddError();
  });
  els.scope.addEventListener('change', () => syncForm());
  els.env.addEventListener('input', () => {
    if (!els.error.hidden) hideAddError();
  });
  form.open?.addEventListener('click', () => setFormOpen(!formOpen()));
  form.cancel?.addEventListener('click', () => setFormOpen(false));
  form.root?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation(); // the form closes, not Settings
      setFormOpen(false);
    }
  });
  els.name.addEventListener('input', () => {
    if (!els.error.hidden) hideAddError();
  });

  const panel: McpPanel = {
    render(servers: McpServerInfo[]) {
      current = cleanServers(servers);
      noteMcpServers(current);
      const active = document.activeElement as HTMLElement | null;
      const focusKey = active && els.list.contains(active) ? active.dataset.focusKey : undefined;
      els.list.innerHTML = '';
      els.list.classList.toggle('is-empty', !current.length);
      if (unavailable) {
        els.list.innerHTML = `<div class="mcp-empty">${icon('plug', 16)}<p>MCP servers need the updated app. Restart Silo Harness and try again.</p></div>`;
      } else if (!current.length) {
        els.list.innerHTML = `<div class="mcp-empty">${icon('plug', 16)}<p>No servers yet.</p></div>`;
      } else {
        for (const s of current) els.list.appendChild(row(s));
      }
      const keys = new Set(current.map(mcpKey));
      for (const k of [...expanded]) if (!keys.has(k)) expanded.delete(k);
      for (const k of [...logs.keys()]) if (!keys.has(k)) logs.delete(k);
      for (const k of [...confirming]) if (!keys.has(k) || current.find((x) => mcpKey(x) === k)?.status !== 'blocked') confirming.delete(k);
      if (focusKey) els.list.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
      syncForm();
    },
    async refresh() {
      const api = opts.source();
      unavailable = !api;
      if (!api) {
        panel.render([]);
        return null;
      }
      try {
        const list = cleanServers(await api.list());
        panel.render(list);
        return list;
      } catch (err) {
        panel.render(current);
        showStatus(`Couldn't load the MCP servers: ${opts.cleanError(err)}`);
        return null;
      }
    },
    servers: () => current,
    showRow(key: string, trust = false) {
      const s = current.find((x) => mcpKey(x) === key);
      if (!s) return;
      if (trust && s.status === 'blocked') confirming.add(key);
      panel.render(current);
      const el = els.list.querySelector<HTMLElement>(`.mcp-row[data-key="${CSS.escape(key)}"]`);
      el?.scrollIntoView({ block: 'center' });
      (el?.querySelector<HTMLElement>('.mcp-confirm') ?? el?.querySelector<HTMLElement>('.mcp-primary, .mcp-more'))?.focus();
    },
    resetMessages() {
      hideStatus();
      hideAddError();
    },
  };
  syncForm();
  return panel;
}

// ---------- /mcp notice card ----------

/**
 * The body of the /mcp card: one line per server (dot, name, status words with the count, and its action as a link:
 * Sign in, Retry, or Trust, which opens Settings at that row), or how to add one. The links send an "mcp-action"
 * event (see installMcpActions).
 */
export function mcpCardHtml(servers: McpServerInfo[], note?: string): string {
  const list = cleanServers(servers);
  let html = '<div class="md"><p><strong>MCP servers</strong></p>';
  if (note) html += `<p>${escapeHtml(note)}</p>`;
  if (!list.length) return html + '<p>No servers yet. Add one in Settings → MCP servers.</p></div>';
  html += '</div><ul class="mcp-card-list">';
  for (const s of list) {
    const p = primaryAction(s);
    const action = p && p.kind !== 'tools' ? (p.kind === 'cancel' ? null : p) : null;
    const link = action
      ? `<button type="button" class="link-btn mcp-card-action" data-action="${action.kind}" data-name="${escapeHtml(s.name)}" data-scope="${s.scope}">${escapeHtml(action.label)}</button>`
      : '';
    html +=
      `<li class="mcp-card-item" data-name="${escapeHtml(s.name)}" data-status="${s.status}"><span class="mcp-dot ${s.status}" aria-hidden="true"></span>` +
      `<span class="mcp-card-name">${escapeHtml(s.name)}</span>${s.scope === 'project' ? '<span class="mcp-scope project">project</span>' : ''}` +
      `<span class="mcp-card-status tone-${statusTone(s.status)}">${escapeHtml(statusText(s))}</span>${link}</li>`;
  }
  return html + '</ul>';
}

export interface McpActionsOptions {
  source: () => McpApi | null;
  servers: () => McpServerInfo[];
  /** Opens Settings at MCP servers */
  openSettings: () => void;
  panel: McpPanel;
  cleanError: (err: unknown) => string;
  /** Where a failure is said (the row's own line stays as it was) */
  notify: (message: string) => void;
}

/**
 * Answers the "mcp-action" events of the /mcp card's links and of a failed call's row: Sign in and Retry act on the
 * server (only on that click), Trust and "Open MCP servers" open Settings at the row (Trust with its confirmation open).
 */
export function installMcpActions(root: HTMLElement | Document, o: McpActionsOptions): void {
  const handle = async (ev: Event) => {
    const d = (ev as CustomEvent).detail as { action?: string; server?: string; scope?: string } | undefined;
    const name = typeof d?.server === 'string' ? d.server : '';
    if (!name) return;
    const find = () => o.servers().find((x) => x.name === name && (!d?.scope || x.scope === d.scope)) ?? o.servers().find((x) => x.name === name);
    if (!find()) await o.panel.refresh();
    const s = find();
    const api = o.source();
    try {
      if (d?.action === 'sign-in' && s && api && s.status === 'needs-auth') await api.signIn(s.name, s.scope);
      else if (d?.action === 'retry' && s && api) await api.reconnect(s.name, s.scope);
      else {
        o.openSettings();
        // After Settings has opened and re-read the list
        if (s) window.setTimeout(() => o.panel.showRow(mcpKey(s), d?.action === 'trust'), 250);
      }
    } catch (err) {
      o.notify(`Couldn't ${d?.action === 'retry' ? 'reconnect' : 'sign in to'} ${name}: ${o.cleanError(err)}`);
    }
  };
  root.addEventListener('mcp-action', (ev) => void handle(ev));
  // The /mcp card's links
  root.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest?.<HTMLButtonElement>('.mcp-card-action');
    if (!btn) return;
    btn.dispatchEvent(new CustomEvent('mcp-action', { bubbles: true, detail: { action: btn.dataset.action, server: btn.dataset.name, scope: btn.dataset.scope } }));
  });
}

// ---------- In-memory stand-in for oc.mcp (debug hook) ----------

export interface MockMcpSource extends McpApi {
  dispose(): void;
}

function mockServerFrom(name: string, config: McpServerConfig, scope: McpScope): McpServerInfo {
  const url = 'url' in config ? config.url : '';
  const transport: McpServerInfo['transport'] = 'url' in config ? (config.type === 'sse' ? 'sse' : 'http') : 'stdio';
  const target = url || ['command' in config ? config.command : '', ...('args' in config && Array.isArray(config.args) ? config.args : [])].filter(Boolean).join(' ');
  return { name, scope, transport, target, status: 'connecting', tools: [], config };
}

/** Serves the given servers from memory: enabling, reconnecting, adding and removing change only this copy. */
export function mockMcpSource(initial: McpServerInfo[]): MockMcpSource {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  let servers = cleanServers(clone(initial));
  const listeners = new Set<(servers: McpServerInfo[]) => void>();
  const timers = new Set<number>();
  const emit = () => {
    for (const cb of listeners) cb(clone(servers));
  };
  const later = (fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  const find = (name: string, scope: McpScope) => {
    const s = servers.find((x) => x.name === name && x.scope === scope);
    if (!s) throw new Error(`There is no ${scope} server named "${name}".`);
    return s;
  };
  const connect = (s: McpServerInfo) => {
    s.status = 'connecting';
    delete s.error;
    later(() => {
      if (s.status !== 'connecting' || !servers.includes(s)) return;
      s.status = 'connected';
      emit();
    }, 500);
  };
  const done = () => {
    emit();
    return clone(servers);
  };
  return {
    list: async () => clone(servers),
    async add(name: string, spec: string, scope: McpScope) {
      const kind = specKind(spec);
      const entries: [string, McpServerConfig][] = [];
      if (kind === 'block' || kind === 'json') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(spec);
        } catch {
          throw new Error("The config isn't valid JSON.");
        }
        const obj = parsed as Record<string, unknown>;
        if (kind === 'block') {
          const block = obj.mcpServers;
          if (!block || typeof block !== 'object') throw new Error('The mcpServers block is empty.');
          for (const [n, c] of Object.entries(block as Record<string, McpServerConfig>)) entries.push([n, c]);
        } else entries.push([name, obj as unknown as McpServerConfig]);
      } else if (kind === 'url') entries.push([name, { type: 'http', url: spec.trim() }]);
      else {
        const [command, ...args] = spec.trim().split(/\s+/);
        entries.push([name, { command, args }]);
      }
      if (!entries.length) throw new Error('Nothing to add.');
      for (const [n] of entries) {
        if (!n.trim()) throw new Error('Give the server a name.');
        if (servers.some((x) => x.name === n && x.scope === scope)) throw new Error(`There is already a server named ${n}.`);
      }
      for (const [n, c] of entries) {
        const s = mockServerFrom(n.trim(), c, scope);
        servers.push(s);
        connect(s);
      }
      return done();
    },
    async remove(name: string, scope: McpScope) {
      const s = find(name, scope);
      servers = servers.filter((x) => x !== s);
      return done();
    },
    async setEnabled(name: string, scope: McpScope, enabled: boolean) {
      const s = find(name, scope);
      if (enabled) connect(s);
      else {
        s.status = scope === 'project' ? 'blocked' : 'disabled';
        delete s.error;
      }
      return done();
    },
    async reconnect(name: string, scope: McpScope) {
      connect(find(name, scope));
      return done();
    },
    async signIn(name: string, scope: McpScope) {
      const s = find(name, scope);
      s.status = 'authorizing';
      later(() => {
        if (s.status !== 'authorizing') return;
        s.signedIn = true;
        connect(s);
        emit();
      }, 1500);
      return done();
    },
    async cancelSignIn(name: string, scope: McpScope) {
      const s = find(name, scope);
      if (s.status === 'authorizing') s.status = 'needs-auth';
      return done();
    },
    async signOut(name: string, scope: McpScope) {
      const s = find(name, scope);
      delete s.signedIn;
      s.status = 'needs-auth';
      return done();
    },
    async setToolEnabled(name: string, scope: McpScope, tool: string, enabled: boolean) {
      const s = find(name, scope);
      const on = s.tools.find((t) => t.name === tool);
      const off = (s.offTools ?? []).find((t) => t.name === tool);
      if (!enabled && on) {
        s.tools = s.tools.filter((t) => t !== on);
        s.offTools = [...(s.offTools ?? []), on];
      } else if (enabled && off) {
        s.offTools = (s.offTools ?? []).filter((t) => t !== off);
        s.tools = [...s.tools, off];
      }
      s.hiddenTools = (s.offTools ?? []).map((t) => t.name);
      return done();
    },
    async log(name: string, scope: McpScope) {
      const s = find(name, scope) as McpServerInfo & { mockLog?: unknown };
      return Array.isArray(s.mockLog) ? s.mockLog.filter((l): l is string => typeof l === 'string') : [];
    },
    onServers(cb: (servers: McpServerInfo[]) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      for (const t of timers) window.clearTimeout(t);
      timers.clear();
      listeners.clear();
    },
  };
}
