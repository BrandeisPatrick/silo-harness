// The real names behind an MCP tool's model-facing name, for rows, folded lines and approval cards. The model calls
// mcp__<server>__<tool>, which is sanitised ("acme.docs" → "acme_docs"), may be shortened and cannot be split back when
// a name has "__" in it; the main process sends the real names with tool_start and approval_request, and the server
// list knows them too. Parsing the model-facing name is the fallback, for sessions stored before either.
// Types only, so the unit tests load this file as is.

import type { McpCallNames, McpServerInfo } from '../shared/types';

const MAX_NAME = 128;
const MAX_TITLE = 64;
/** Model-facing name → real names, from events and the server list */
const known = new Map<string, McpCallNames>();

/** Control, bidi and other invisible format characters, shown escaped as \u{…} rather than acted on. */
// A string, so the compiler cannot turn the escapes into the characters themselves (U+2028 would end the line)
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]', 'g');

/** One line of untrusted text for a label: invisible characters escaped, whitespace runs to one space, capped. */
export function oneLine(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/[\r\n\t]+/g, ' ').replace(INVISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`).replace(/ {2,}/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clean(n: unknown): McpCallNames | null {
  if (!n || typeof n !== 'object') return null;
  const o = n as Record<string, unknown>;
  const server = oneLine(o.server, MAX_NAME);
  const tool = oneLine(o.tool, MAX_NAME);
  if (!server || !tool) return null;
  const title = oneLine(o.title, MAX_TITLE);
  return title ? { server, tool, title } : { server, tool };
}

/** Records the names an event carried for a model-facing name. */
export function rememberMcpNames(fullName: string, names: unknown): void {
  const c = clean(names);
  if (c && typeof fullName === 'string' && fullName.startsWith('mcp__')) known.set(fullName, c);
}

/** Records every tool of the current server list (called whenever the list is rendered). */
export function noteMcpServers(servers: readonly McpServerInfo[]): void {
  for (const s of servers) {
    for (const t of s.tools ?? []) {
      if (t && typeof t.fullName === 'string' && t.fullName) rememberMcpNames(t.fullName, { server: s.name, tool: t.name, title: t.title });
    }
  }
}

/** The real names for a model-facing name: what was recorded, else the name parsed; null for a built-in tool. */
export function mcpNames(fullName: string): McpCallNames | null {
  if (typeof fullName !== 'string' || !fullName.startsWith('mcp__')) return null;
  const hit = known.get(fullName);
  if (hit) return hit;
  const m = /^mcp__(.+?)__(.+)$/.exec(fullName);
  return m ? { server: m[1], tool: m[2] } : null;
}

/** For tests: forget everything recorded. */
export function resetMcpNames(): void {
  known.clear();
}
