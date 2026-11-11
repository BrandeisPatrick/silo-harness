// Auto mode's safety check: the actions it blocked, as the window, Settings and the phone see them, and what the
// window asks the main process about them (src/main/auto-blocks.ts). Types only.

/** An action Auto mode's safety check blocked (AgentEvent auto_blocked, TranscriptItem auto_blocked). */
export interface AutoBlock {
  /** The tool call's id: unique within its session */
  id: string;
  sessionId: string;
  /** The tool: bash, terminal_run, write_file, edit_file, an MCP tool */
  name: string;
  /** What it would have done, on one line: the command, the file, the MCP tool */
  what: string;
  /** The check's reason, its category first: "[Destructive Git] force-pushes over remote history" */
  reason: string;
  /** When it was blocked (0 when only the stored transcript knows it) */
  at: number;
  /** The user allowed it since: it runs once when the agent tries it again */
  allowed?: boolean;
}

/** A row of Settings → Permissions → Recently blocked. */
export interface RecentBlock extends AutoBlock {
  sessionTitle: string;
}

/** An answer of the user's that Auto mode learned from (src/main/agent/learned.ts), as Settings lists it. */
export interface LearnedAnswer {
  id: string;
  /** The tool: bash, browser_navigate, an MCP tool */
  tool: string;
  /** What it concerned: a site, the programs, a file, a server ('' when nothing more than the line) */
  key: string;
  /** The action as its card showed it, on one line */
  line: string;
  decision: 'allow' | 'deny';
  /** How many times the user answered it so */
  count: number;
  /** When last */
  at: number;
}

export interface AutoModeRpc {
  /**
   * The blocks of this app session, newest first: with a session id all of that session's, without one the 20 most
   * recent of every session. A block from before the app started is not listed, and cannot be allowed.
   */
  'auto.blocked': (sessionId?: string) => RecentBlock[];
  /** Allows a blocked action once and tells the agent it may try it again. */
  'auto.allow': (sessionId: string, id: string) => { ok: boolean; error?: string };
  /** What Auto mode learned from the user's answers, oldest first. */
  'auto.learned': () => LearnedAnswer[];
  /** Forgets one learned answer (by id), or all of them (no id); returns what is left. */
  'auto.forget': (id?: string) => LearnedAnswer[];
}
