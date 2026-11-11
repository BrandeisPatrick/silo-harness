// The real server and tool names on an MCP call's events. The model-facing name mcp__<server>__<tool> is sanitised
// ("acme.docs" → "acme_docs"), may be shortened to 64 characters or get a "_2", and a name with "__" in it cannot be
// split back; so tool_start and approval_request carry { server, tool, title? } from the manager for the interface.

import type { AgentEvent } from '../shared/types';
import type { McpManager } from './mcp';

/** The event with `mcp` names added when it is a tool_start or approval_request for an MCP tool the manager knows. */
export function withMcpNames(ev: AgentEvent, mcp: Pick<McpManager, 'names'> | null | undefined): AgentEvent {
  if (!mcp || (ev.type !== 'tool_start' && ev.type !== 'approval_request') || ev.mcp || !ev.name.startsWith('mcp__')) return ev;
  const names = mcp.names(ev.name);
  return names ? { ...ev, mcp: names } : ev;
}
