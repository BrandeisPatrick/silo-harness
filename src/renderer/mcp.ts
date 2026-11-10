// Settings → MCP servers: the server list (status, scope, target, tools; enable, reconnect, remove) and the
// "Add server" form. Changes go straight to oc.mcp (they are not part of the Settings form's Save).
// Also: the /mcp notice card's markup and an in-memory stand-in for oc.mcp (the debug hook's mock).

import type { McpApi, McpScope, McpServerConfig, McpServerInfo, McpStatus, McpToolInfo } from '../shared/types';
import type { ConfirmOptions } from './changes.js';
import { escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { tilde } from './home.js';
import { noteMcpServers } from './mcp-labels.js';

export const MCP_STATUS_LABEL: Record<McpStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting',
  'needs-auth': 'Sign in needed',
  authorizing: 'Waiting for browser…',
  error: 'Failed to connect',
  disabled: 'Disabled',
  blocked: 'Not enabled for this project',
};

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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Connected · 12 tools", "Connecting…", "Failed to connect", … */
export function mcpStatusText(s: McpServerInfo): string {
  if (s.status === 'connected') return `Connected · ${s.tools.length ? plural(s.tools.length, 'tool') : 'no tools'}${s.hiddenTools?.length ? ` · ${s.hiddenTools.length} off` : ''}`;
  return MCP_STATUS_LABEL[s.status] ?? s.status;
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
}

const slug = (key: string): string => key.replace(/[^A-Za-z0-9_-]+/g, '-');

function shortDir(p: string): string {
  return tilde(p).replace(/\/+$/, '');
}

function toolHtml(t: McpToolInfo): string {
  const desc = typeof t.description === 'string' ? t.description.trim() : '';
  const tags =
    (t.readOnly ? `<span class="mcp-tag ro" title="Read-only: runs without asking">${icon('eye', 12)}<span>read-only</span></span>` : '') +
    (t.destructive ? `<span class="mcp-tag danger" title="Destructive: auto mode asks before running it">destructive</span>` : '');
  return (
    `<div class="mcp-tool" role="listitem"><div class="mcp-tool-head"><code class="mcp-tool-name">${escapeHtml(t.name)}</code>${tags}</div>` +
    (desc ? `<div class="mcp-tool-desc" title="${escapeHtml(desc.length > 1200 ? `${desc.slice(0, 1200)}…` : desc)}">${escapeHtml(desc)}</div>` : '') +
    `</div>`
  );
}

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
  const showAddError = (message: string, focus?: HTMLElement) => {
    els.error.innerHTML = `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>`;
    els.error.hidden = false;
    focus?.focus();
  };
  const hideAddError = () => {
    els.error.hidden = true;
    els.error.textContent = '';
  };

  const syncForm = () => {
    const kind = specKind(els.spec.value);
    const block = kind === 'block';
    els.nameLabel.textContent = block ? 'Name (optional for an mcpServers block)' : 'Name';
    els.name.placeholder = block ? 'Taken from the block' : 'e.g. github';
    els.env.disabled = kind === 'url';
    els.env.placeholder = kind === 'url' ? 'Not used by URL servers' : 'GITHUB_TOKEN=ghp_…\nONE_PER_LINE=value';
    // Stays enabled while adding (keeps keyboard focus); the busy class and the `adding` guard stop a second click.
    els.add.disabled = unavailable;
  };

  const row = (s: McpServerInfo): HTMLElement => {
    const key = mcpKey(s);
    const name = s.name;
    const pending = busy.get(key);
    const on = pending?.enabled ?? (s.status !== 'disabled' && s.status !== 'blocked');
    const tools = s.tools;
    const open = expanded.has(key) && tools.length > 0;
    const toolsId = `mcp-tools-${slug(key)}`;
    const el = document.createElement('div');
    el.className = `mcp-row ${s.status}${busy.has(key) ? ' busy' : ''}${flashKeys.has(key) ? ' flash' : ''}`;
    el.setAttribute('role', 'listitem');
    el.dataset.key = key;
    el.dataset.name = name;
    el.dataset.scope = s.scope;
    el.dataset.status = s.status;

    let state = '';
    const hidden = s.hiddenTools?.length ? `<span class="mcp-state" title="${escapeHtml(`Off: ${s.hiddenTools.join(', ')}`)}">${s.hiddenTools.length} off</span>` : '';
    const authBtn = (cls: string, label: string) => `<button type="button" class="mcp-auth-btn ${cls}" data-focus-key="${escapeHtml(key)}|${cls}">${label}</button>`;
    if (s.status === 'connected') {
      state =
        (s.signedIn ? authBtn('sign-out', 'Sign out') : '') +
        hidden +
        (tools.length
          ? `<button type="button" class="mcp-tools-toggle" aria-expanded="${open}" aria-controls="${toolsId}" data-focus-key="${escapeHtml(key)}|tools"><span>${plural(tools.length, 'tool')}</span>${icon('chevron-down', 14)}</button>`
          : '<span class="mcp-state">No tools</span>');
    } else if (s.status === 'connecting') state = '<span class="mcp-state">Connecting…</span>';
    else if (s.status === 'reconnecting') state = '<span class="mcp-state">Reconnecting</span>';
    else if (s.status === 'needs-auth') state = authBtn('sign-in primary', 'Sign in');
    else if (s.status === 'authorizing') state = '<span class="mcp-state">Waiting for browser…</span>' + authBtn('cancel-sign-in', 'Cancel');
    else if (s.status === 'error') state = '<span class="mcp-state err">Failed</span>';
    else if (s.status === 'disabled') state = '<span class="mcp-state">Disabled</span>';

    const version = s.serverInfo?.version ? `<span class="mcp-version" title="${escapeHtml(`${s.serverInfo.name || name} ${s.serverInfo.version}`)}">v${escapeHtml(String(s.serverInfo.version).replace(/^v/, ''))}</span>` : '';
    const scopeTip = s.scope === 'project' ? "From the project's .mcp.json" : "Stored in Silo Harness's settings on this Mac";
    const target = s.target || (s.transport === 'stdio' ? '' : s.transport);
    const switchTip = s.status === 'blocked' ? `Enable ${name} for this project` : on ? `Disable ${name}` : `Enable ${name}`;
    el.innerHTML =
      `<div class="mcp-main">` +
      `<span class="mcp-dot ${s.status}" role="img" aria-label="${escapeHtml(MCP_STATUS_LABEL[s.status])}" title="${escapeHtml(MCP_STATUS_LABEL[s.status])}"></span>` +
      `<div class="mcp-info"><div class="mcp-line"><span class="mcp-name">${escapeHtml(name)}</span><span class="mcp-scope ${s.scope}" title="${escapeHtml(scopeTip)}">${s.scope}</span>${version}</div>` +
      (target ? `<div class="mcp-target" title="${escapeHtml(target)}">${escapeHtml(target)}</div>` : '') +
      `</div>` +
      state +
      `<label class="mcp-switch" title="${escapeHtml(switchTip)}">${s.status === 'blocked' ? '<span class="mcp-switch-label">Enable</span>' : ''}` +
      `<input type="checkbox" class="switch" ${on ? 'checked' : ''} aria-label="${escapeHtml(s.status === 'blocked' ? `Enable ${name} for this project` : `Enable ${name}`)}" data-focus-key="${escapeHtml(key)}|switch"></label>` +
      `<button type="button" class="icon-btn sm mcp-reconnect" aria-label="${escapeHtml(`Reconnect ${name}`)}" title="Reconnect" data-focus-key="${escapeHtml(key)}|reconnect"${on ? '' : ' disabled'}>${icon('refresh', 14)}</button>` +
      `<button type="button" class="icon-btn sm mcp-remove" aria-label="${escapeHtml(`Remove ${name}`)}" title="Remove" data-focus-key="${escapeHtml(key)}|remove">${icon('trash', 14)}</button>` +
      `</div>`;

    if (s.status === 'error' || ((s.status === 'needs-auth' || s.status === 'reconnecting') && s.error?.trim())) {
      el.insertAdjacentHTML('beforeend', `<div class="mcp-error">${icon('circle-alert', 14)}<span>${escapeHtml(s.error?.trim() || 'Could not connect to the server.')}</span></div>`);
    } else if (s.status === 'blocked') {
      const why = s.error?.trim() || "This server comes from the project's .mcp.json. Turn it on to trust it for this project; it starts then.";
      el.insertAdjacentHTML('beforeend', `<div class="mcp-note">${icon('shield-check', 14)}<span>${escapeHtml(why)}</span></div>`);
    }
    if (tools.length) {
      const list = document.createElement('div');
      list.className = 'mcp-tools';
      list.id = toolsId;
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', `${name} tools`);
      list.hidden = !open;
      list.innerHTML = tools.map(toolHtml).join('');
      el.appendChild(list);
    }

    const sw = el.querySelector<HTMLInputElement>('input.switch')!;
    const reconnect = el.querySelector<HTMLButtonElement>('.mcp-reconnect')!;
    const remove = el.querySelector<HTMLButtonElement>('.mcp-remove')!;
    const toggle = el.querySelector<HTMLButtonElement>('.mcp-tools-toggle');
    // While an action runs the controls stay focusable (a re-render keeps keyboard focus) but do nothing.
    if (busy.has(key)) [sw, reconnect, remove].forEach((c) => c.setAttribute('aria-disabled', 'true'));
    sw.addEventListener('change', () => {
      if (busy.has(key)) {
        sw.checked = !sw.checked;
        return;
      }
      const enabled = sw.checked;
      void act(s, enabled ? 'enable' : 'disable', (api) => api.setEnabled(name, s.scope, enabled), enabled);
    });
    reconnect.onclick = () => void act(s, 'reconnect', (api) => api.reconnect(name, s.scope));
    const authAction = (sel: string, action: 'sign in' | 'cancel sign-in for' | 'sign out of', run: (api: McpApi) => Promise<McpServerInfo[]>) => {
      const b = el.querySelector<HTMLButtonElement>(sel);
      if (b) b.onclick = () => void act(s, action, run);
    };
    authAction('.mcp-auth-btn.sign-in', 'sign in', (api) => api.signIn(name, s.scope));
    authAction('.mcp-auth-btn.cancel-sign-in', 'cancel sign-in for', (api) => api.cancelSignIn(name, s.scope));
    authAction('.mcp-auth-btn.sign-out', 'sign out of', (api) => api.signOut(name, s.scope));
    remove.onclick = async () => {
      if (busy.has(key)) return;
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

  const VERBS: Record<string, string> = { enable: 'enable', disable: 'disable', reconnect: 'reconnect', remove: 'remove', 'sign in': 'sign in to', 'cancel sign-in for': 'cancel sign-in for', 'sign out of': 'sign out of' };

  async function act(s: McpServerInfo, action: 'enable' | 'disable' | 'reconnect' | 'remove' | 'sign in' | 'cancel sign-in for' | 'sign out of', run: (api: McpApi) => Promise<McpServerInfo[]>, enabled?: boolean): Promise<void> {
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
      if (action === 'remove') expanded.delete(key);
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
    const name = els.name.value.trim();
    const spec = els.spec.value.trim();
    const kind = specKind(spec);
    if (kind === 'empty') return showAddError("Paste the server's command line, its URL, or the JSON from its README.", els.spec);
    if (!name && kind !== 'block') return showAddError('Give the server a name.', els.name);
    const parsed = parseEnv(kind === 'url' ? '' : els.env.value);
    if (parsed.error) return showAddError(parsed.error, els.env);
    const api = opts.source();
    if (!api) return showAddError('Adding servers needs the updated app. Restart Silo Harness and try again.');
    const scope: McpScope = els.scope.value === 'project' ? 'project' : 'user';
    const before = new Set(current.map(mcpKey));
    adding = true;
    els.add.classList.add('busy');
    els.add.querySelector('span:last-child')!.textContent = 'Adding…';
    syncForm();
    try {
      const next = await api.add(name, spec, scope, Object.keys(parsed.env).length ? parsed.env : undefined);
      hideAddError();
      hideStatus();
      els.name.value = '';
      els.spec.value = '';
      els.env.value = '';
      const list = cleanServers(next);
      flashKeys = new Set(list.map(mcpKey).filter((k) => !before.has(k)));
      panel.render(list);
      window.setTimeout(() => {
        flashKeys = new Set();
        els.list.querySelectorAll('.mcp-row.flash').forEach((r) => r.classList.remove('flash'));
      }, 1600);
      opts.onMutated?.();
    } catch (err) {
      showAddError(opts.cleanError(err));
    } finally {
      adding = false;
      els.add.classList.remove('busy');
      els.add.querySelector('span:last-child')!.textContent = 'Add server';
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
        els.list.innerHTML =
          `<div class="mcp-empty">${icon('plug', 16)}<p>No MCP servers yet. Add one below with its command line, its URL, or the JSON from its README. ` +
          `A project's <code>.mcp.json</code> (Claude Code's format) is picked up automatically.</p></div>`;
      } else {
        for (const s of current) els.list.appendChild(row(s));
      }
      const keys = new Set(current.map(mcpKey));
      for (const k of [...expanded]) if (!keys.has(k)) expanded.delete(k);
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
    resetMessages() {
      hideStatus();
      hideAddError();
    },
  };
  syncForm();
  return panel;
}

// ---------- /mcp notice card ----------

/** The body of the /mcp card: each server with its status dot and tool names, or how to add one. */
export function mcpCardHtml(servers: McpServerInfo[], note?: string): string {
  const list = cleanServers(servers);
  let html = '<div class="md"><p><strong>MCP servers</strong></p>';
  if (note) html += `<p>${escapeHtml(note)}</p>`;
  if (!list.length) {
    return (
      html +
      `<p>No servers yet. Add one in Settings with its command line, its URL, or the JSON from its README. ` +
      `A project's <code>.mcp.json</code> (Claude Code's format) is picked up automatically.</p></div>`
    );
  }
  html += '</div><ul class="mcp-card-list">';
  for (const s of list) {
    const names = s.tools.map((t) => t.name);
    const shown = names.slice(0, 40);
    let detail = '';
    if (s.status === 'connected' && shown.length) {
      detail = `<div class="mcp-card-tools">${shown.map((n) => `<code>${escapeHtml(n)}</code>`).join('')}${names.length > shown.length ? `<span class="mcp-card-more">+${names.length - shown.length} more</span>` : ''}</div>`;
    } else if ((s.status === 'error' || s.status === 'blocked') && s.error?.trim()) {
      detail = `<div class="mcp-card-note${s.status === 'error' ? ' err' : ''}">${escapeHtml(s.error.trim().split('\n')[0])}</div>`;
    }
    html +=
      `<li class="mcp-card-item" data-name="${escapeHtml(s.name)}" data-status="${s.status}"><div class="mcp-card-head"><span class="mcp-dot ${s.status}" aria-hidden="true"></span>` +
      `<span class="mcp-card-name">${escapeHtml(s.name)}</span><span class="mcp-scope ${s.scope}">${s.scope}</span>` +
      `<span class="mcp-card-status">${escapeHtml(mcpStatusText(s))}</span></div>${detail}</li>`;
  }
  return html + '</ul>';
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
        if (servers.some((x) => x.name === n && x.scope === scope)) throw new Error(`A ${scope} server named "${n}" already exists.`);
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
