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
  /** The call's own short description, when it gave one (bash's `description`): the row in the turn reads it */
  desc?: string;
  /** The whole command or target, as the call sent it (what the opened row shows; `what` is cut to one line) */
  full?: string;
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

/** What Auto mode's safety check runs on now (classifierTarget), for Settings → Models. */
export interface CheckModelInfo {
  /** autoMode.model as set: '' for the default ("Same as the session"), else "<provider>:<model>" or a model id */
  spec: string;
  /** No model can run the check: Auto mode asks with cards instead */
  none: boolean;
  /** The check runs on Claude Haiku 5.5 on its own (a larger Claude model on Anthropic's own API, nothing chosen) */
  automatic: boolean;
  /** The provider's name and label, and the model, when there is one */
  provider?: string;
  providerLabel?: string;
  model?: string;
  /** How many actions "Test as safety check" sends, one request each */
  testCount: number;
}

/** One action of the check test, as the check judged it. */
export interface CheckTestItemResult {
  id: string;
  cat: string;
  label: 'allow' | 'block';
  /** What the action does, on one line (the command, or the tool and its target) */
  action: string;
  /** null: no verdict (an error, or an answer that is not one); it counts as a block */
  verdict: 'allow' | 'block' | null;
  error?: string;
  ms: number;
}

/** The check test's result. */
export interface CheckTestReport {
  /** "Gateway · claude-opus-5-5" */
  model: string;
  /** Actions in the test, and how many were checked (fewer when cancelled) */
  total: number;
  done: number;
  cancelled: boolean;
  /** Judged as labelled (no verdict counts as a block) */
  right: number;
  /** Of the checked actions, how many are labelled block */
  blockLabelled: number;
  /** Labelled block, allowed: the failure that matters */
  falseAllows: { id: string; action: string }[];
  /** Labelled allow, blocked */
  falseBlocks: { id: string; action: string }[];
  /** No verdict: an error, a timeout, an answer that was not one */
  noAnswer: { id: string; action: string; error?: string }[];
  /** null when nothing was checked */
  medianMs: number | null;
}

/** A check test under way. */
export interface CheckTestProgress {
  running: boolean;
  done: number;
  total: number;
}

export interface AutoModeEvents {
  /** The check test's progress (Settings → Models) */
  'auto:check-test': CheckTestProgress;
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
  /** Whether this Mac can run the shell sandbox (the probe, run once per app: sandbox-exec is there and works). */
  'auto.sandbox': () => { available: boolean };
  /** What the safety check runs on now, and how many requests its test sends */
  'auto.checkModel': () => CheckModelInfo;
  /**
   * "Test as safety check": the fixed set of the eval's labelled actions, one request each, through the check's own
   * path on the model it runs on now; progress comes as auto:check-test. Rejects when one is running or no model can
   * run the check. Only ever on a click.
   */
  'auto.checkTest': () => CheckTestReport;
  /** Stops the check test after the request in flight; what was done is scored */
  'auto.checkTestCancel': () => void;
}
