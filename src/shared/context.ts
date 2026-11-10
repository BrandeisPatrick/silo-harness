// What fills the context window, for the Context panel and the context meter. Types only.

/**
 * system: the app's own instructions. instructions: SILOHARNESS.md / AGENTS.md / CLAUDE.md files. skills: the skill list.
 * tools: built-in tool definitions. mcpTools: MCP tool definitions. summary: the brief a compaction left.
 * messages: what the user and the assistant wrote. toolResults: tool calls and their output.
 * reserve: the part of the window kept free so a compaction can still run. free: the rest.
 */
export type ContextSliceKey = 'system' | 'instructions' | 'skills' | 'tools' | 'mcpTools' | 'summary' | 'messages' | 'toolResults' | 'reserve' | 'free';

export interface ContextSlice {
  key: ContextSliceKey;
  /** "System prompt", "Messages", … */
  label: string;
  tokens: number;
  /** What is behind the number when that helps: one entry per instructions file, MCP server or skill source */
  items?: { label: string; tokens: number }[];
}

export interface ContextBreakdown {
  /** Tokens in use: every slice except reserve and free */
  tokens: number;
  /** The window */
  limit: number;
  /** Fraction of the window at which a run compacts on its own */
  threshold: number;
  autoCompact: boolean;
  /** reported: scaled to the last request's real token count. estimated: about four characters per token. */
  basis: 'reported' | 'estimated';
  /** In display order; the token counts add up to `limit` */
  slices: ContextSlice[];
  /** Messages in the live conversation */
  messages: number;
  /** Whether compacting now could free anything (false while a run is going or when the conversation is too short) */
  compactable: boolean;
  compactions: number;
  /** Of the last request's input, the share the provider read from its prompt cache (only when it reports it) */
  cached?: number;
  lastCompaction?: { at: number; reason: 'auto' | 'manual'; tokensBefore: number; tokensAfter: number };
  updatedAt: number;
}

export interface ContextRpc {
  /** The breakdown for a session (default: the one on screen) */
  'context.breakdown': (sessionId?: string) => ContextBreakdown;
}
