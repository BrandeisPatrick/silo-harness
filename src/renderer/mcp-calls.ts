// MCP calls in the conversation: why a call failed when its server is the reason (it needs sign-in, or it is not
// connected), and the words of a folded line over MCP calls ("Used docs and files", "tracker needs sign-in").
// Pure and import-free, so test/mcp-ui.js loads it as is.

export interface McpProblem {
  server: string;
  kind: 'sign-in' | 'down';
}

/**
 * The server problem behind a failed call's result, from the main process's own sentences (main/mcp.ts
 * notConnectedText and the reconnect messages); null for any other failure. The model's text is not changed.
 */
export function mcpProblem(result: string): McpProblem | null {
  if (typeof result !== 'string') return null;
  let m = /MCP server "([\w.-]{1,64})" needs sign-in\./.exec(result);
  if (m) return { server: m[1], kind: 'sign-in' };
  m = /MCP server "([\w.-]{1,64})" (?:is not connected|is reconnecting and did not come back|closed the connection)/.exec(result) ?? /Lost the connection to MCP server "([\w.-]{1,64})"/.exec(result);
  return m ? { server: m[1], kind: 'down' } : null;
}

/** The one line an opened failed row shows: "tracker needs sign-in", "tracker is not connected". */
export function problemText(p: McpProblem): string {
  return p.kind === 'sign-in' ? `${p.server} needs sign-in` : `${p.server} is not connected`;
}

export interface FoldCall {
  /** The real server, for an MCP call */
  server?: string;
  outcome: string;
  problem?: McpProblem | null;
}

/**
 * A folded line over MCP calls from one or two servers: "Used files" / "Used docs and files"; and in place of
 * "1 failed", "tracker needs sign-in" when that is the one failure. Empty fields leave the line as it is.
 */
export function mcpFoldWords(calls: FoldCall[]): { text?: string; failed?: string } {
  if (!calls.length || calls.some((c) => !c.server)) return {};
  const servers = [...new Set(calls.map((c) => c.server!))];
  const out: { text?: string; failed?: string } = {};
  if (servers.length <= 2) out.text = `Used ${servers.sort((a, b) => a.localeCompare(b)).join(' and ')}`;
  const failed = calls.filter((c) => c.outcome === 'failed');
  if (failed.length === 1 && failed[0].problem?.kind === 'sign-in') out.failed = problemText(failed[0].problem);
  return out;
}
