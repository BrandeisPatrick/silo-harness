// What a server's row in Settings → MCP servers (and the /mcp card) says and offers, by status: one set of words, one
// colour per meaning, one primary action, the rest in a menu, a one-line reason, and what trusting a project server
// lets it do. Pure and types only, so test/mcp-ui.js loads it as is; mcp.ts draws it.

import type { McpServerInfo, McpStatus, McpToolInfo } from '../shared/types';

/** The words for each status, used by the row, the /mcp card and the docs */
export const STATUS_WORDS: Record<McpStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  'needs-auth': 'Needs sign-in',
  authorizing: 'Signing in…',
  error: 'Failed',
  disabled: 'Off',
  blocked: 'Not trusted',
};

/** One colour per meaning: ok (green), attention (amber: it needs you), failed (red), off (grey), quiet (in progress) */
export type StatusTone = 'ok' | 'attention' | 'failed' | 'off' | 'quiet';

export function statusTone(status: McpStatus): StatusTone {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'needs-auth':
    case 'blocked':
      return 'attention';
    case 'error':
      return 'failed';
    case 'disabled':
      return 'off';
    default:
      return 'quiet';
  }
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Connected · 5 tools", "Failed", "Off" …: the status words, with the count for a connected server. */
export function statusText(s: Pick<McpServerInfo, 'status' | 'tools'>): string {
  if (s.status === 'connected') return `Connected · ${s.tools.length ? plural(s.tools.length, 'tool') : 'no tools'}`;
  return STATUS_WORDS[s.status] ?? STATUS_WORDS.error;
}

const MAX_REASON = 160;
// A string, so the compiler cannot turn the escapes into the characters themselves (U+2028 would end the line)
const INVISIBLE = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]', 'g');

/** Untrusted text for one line: invisible and bidi characters shown escaped, whitespace runs to one space, capped. */
export function safeLine(text: unknown, max = MAX_REASON): string {
  if (typeof text !== 'string') return '';
  const flat = text.replace(INVISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Untrusted text kept as lines (a log): invisible characters escaped in each line, each capped. */
export function safeLines(lines: unknown, max = 300): string[] {
  return Array.isArray(lines) ? lines.filter((l): l is string => typeof l === 'string').map((l) => safeLine(l, max)).filter(Boolean) : [];
}

const BOILERPLATE = /^(The server exited right after starting\.|The server exited)$/i;

/**
 * The one line that says why: for a local server that exited, the last non-empty line of what it printed (where a
 * traceback ends with the reason); otherwise the first line. Empty when there is nothing to say.
 */
export function reasonLine(s: Pick<McpServerInfo, 'status' | 'error' | 'transport'>): string {
  const text = typeof s.error === 'string' ? s.error.trim() : '';
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (s.transport === 'stdio' && lines.length > 1) {
    const last = lines[lines.length - 1];
    return safeLine(BOILERPLATE.test(lines[0]) ? `Exited: ${last}` : last);
  }
  // "The server exited: a · b. It restarts on the next tool call." keeps its first sentence part
  return safeLine(lines[0]);
}

export type PrimaryKind = 'sign-in' | 'cancel' | 'retry' | 'trust' | 'tools';

/** The one action a row offers before its switch, chosen by status; null when there is none. */
export function primaryAction(s: Pick<McpServerInfo, 'status' | 'tools' | 'offTools'>): { kind: PrimaryKind; label: string } | null {
  switch (s.status) {
    case 'needs-auth':
      return { kind: 'sign-in', label: 'Sign in' };
    case 'authorizing':
      return { kind: 'cancel', label: 'Cancel' };
    case 'error':
      return { kind: 'retry', label: 'Retry' };
    case 'blocked':
      return { kind: 'trust', label: 'Trust' };
    case 'connected':
      return s.tools.length || s.offTools?.length ? { kind: 'tools', label: plural(s.tools.length, 'tool') } : null;
    default:
      return null;
  }
}

export type MenuKind = 'reconnect' | 'sign-out' | 'log' | 'copy' | 'remove';

/** The row's … menu, in order; Remove is always last (the menu sets it apart). */
export function menuActions(s: Pick<McpServerInfo, 'status' | 'transport' | 'signedIn'>): MenuKind[] {
  const out: MenuKind[] = [];
  if (!['disabled', 'blocked', 'needs-auth', 'authorizing'].includes(s.status)) out.push('reconnect');
  if (s.signedIn) out.push('sign-out');
  if (s.transport === 'stdio') out.push('log');
  out.push('copy', 'remove');
  return out;
}

export const MENU_LABELS: Record<MenuKind, string> = { reconnect: 'Reconnect', 'sign-out': 'Sign out', log: 'Show log', copy: 'Copy config', remove: 'Remove' };

/** Whether the row has its on/off switch (a project server nobody trusted has only Trust). */
export function hasSwitch(s: Pick<McpServerInfo, 'status'>): boolean {
  return s.status !== 'blocked';
}

/** The host of a URL, for "Connects to …"; the text itself when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * What trusting a project server lets it do, line by line: what runs (the whole command line, or the host it connects
 * to), that its read-only tools run without asking, and which variables it reads and where they go.
 */
export function trustLines(s: Pick<McpServerInfo, 'transport' | 'target' | 'vars'>): string[] {
  const lines = [s.transport === 'stdio' ? `Runs ${safeLine(s.target, 400)}` : `Connects to ${safeLine(hostOf(s.target), 200)}`, 'Read-only tools run without asking.'];
  const sends = new Map<string, string[]>();
  const reads: string[] = [];
  for (const v of s.vars ?? []) {
    if (!v || typeof v.name !== 'string') continue;
    if (v.to) sends.set(v.to, [...(sends.get(v.to) ?? []), `$${v.name}`]);
    else if (!reads.includes(`$${v.name}`)) reads.push(`$${v.name}`);
  }
  for (const [to, names] of sends) lines.push(`Sends ${[...new Set(names)].join(', ')} to ${safeLine(to, 200)}`);
  if (reads.length) lines.push(`Reads ${reads.join(', ')}`);
  return lines;
}

/** "Not set: $A, $B" for variables the config uses that have no value; '' when all are set. */
export function unsetText(s: Pick<McpServerInfo, 'unset' | 'status'>): string {
  const names = (s.unset ?? []).filter((n) => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  if (!names.length || s.status === 'disabled' || s.status === 'blocked') return '';
  return `Not set: ${names.map((n) => `$${n}`).join(', ')}`;
}

/** The config to copy: the masked one from the main process, as an mcpServers block. */
export function copyText(s: Pick<McpServerInfo, 'name' | 'config'>): string {
  return JSON.stringify({ mcpServers: { [s.name]: s.config } }, null, 2);
}

/** The server's own title and version, dim beside the name ("Example Docs 2025.10.2", "v1.4.0"); '' when neither. */
export function serverSubtitle(s: Pick<McpServerInfo, 'name' | 'serverInfo'>): string {
  const title = safeLine(s.serverInfo?.title, 60);
  const raw = safeLine(s.serverInfo?.version, 24).replace(/^v/i, '');
  const version = raw ? (title ? raw : `v${raw}`) : '';
  return [title && title !== s.name ? title : '', version].filter(Boolean).join(' ');
}

/** A tool as the opened list shows it: its title (else its name), the real name beside it when the two differ */
export interface ToolEntry {
  name: string;
  title: string;
  /** Show the real name beside the title (they differ) */
  showName: boolean;
  description: string;
  destructive: boolean;
  off: boolean;
}

/** The opened tools list: "Read-only" and "Can make changes", each with its tools; off tools are listed, marked off. */
export function toolGroups(s: Pick<McpServerInfo, 'tools' | 'offTools'>): { label: string; tools: ToolEntry[] }[] {
  const entry = (t: McpToolInfo, off: boolean): ToolEntry => {
    const title = safeLine(t.title, 64) || safeLine(t.name, 128);
    return { name: safeLine(t.name, 128), title, showName: title !== safeLine(t.name, 128), description: typeof t.description === 'string' ? t.description.trim() : '', destructive: !!t.destructive, off };
  };
  const all = [...(s.tools ?? []).map((t) => [t, false] as const), ...(s.offTools ?? []).map((t) => [t, true] as const)].filter(([t]) => t && typeof t.name === 'string');
  const ro = all.filter(([t]) => t.readOnly).map(([t, off]) => entry(t, off));
  const rw = all.filter(([t]) => !t.readOnly).map(([t, off]) => entry(t, off));
  return [
    { label: `Read-only · ${ro.length}`, tools: ro },
    { label: `Can make changes · ${rw.length}`, tools: rw },
  ].filter((g) => g.tools.length);
}
