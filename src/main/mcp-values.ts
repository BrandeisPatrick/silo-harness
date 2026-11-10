// What of an MCP server's config the window may see, and the values kept on this Mac for a project's servers: env
// and header values are never sent to the window (they become ${VAR} references), and a value typed for a project
// server stays in the app's settings while its .mcp.json gets the reference.

import type { McpServerConfig } from '../shared/types';

export const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
/** A value that is nothing but one ${VAR} reference */
export const ONLY_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/;

/** The variable a header's value is kept in: MCP server "files" + header "X-Api-Key" → FILES_X_API_KEY. */
export function headerVarName(server: string, header: string): string {
  return `${server}_${header}`.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().replace(/^(?=\d)/, '_') || 'MCP_HEADER';
}

/**
 * A config as the window may see and copy it: every env and header value that is not already a ${VAR} reference is
 * written as one (env: its own name; a header: headerVarName), so no secret leaves the main process.
 */
export function maskedConfig(name: string, c: McpServerConfig): McpServerConfig {
  const copy = structuredClone(c) as McpServerConfig & { env?: Record<string, string>; headers?: Record<string, string> };
  if (copy.env) copy.env = Object.fromEntries(Object.entries(copy.env).map(([k, v]) => [k, ONLY_REF.test(String(v)) ? String(v) : `\${${k}}`]));
  if (copy.headers) copy.headers = Object.fromEntries(Object.entries(copy.headers).map(([k, v]) => [k, ONLY_REF.test(String(v)) ? String(v) : `\${${headerVarName(name, k)}}`]));
  return copy;
}

