import type { AppConfig, ArtifactInfo, PermissionMode, PlanInfo, QuestionAnswer, TaskItem, UserQuestion } from '../../shared/types';
import type { ArtifactInput } from '../artifacts';
import type { BrowserController } from '../browser';
import type { Skill } from '../skills';
import type { TerminalManager } from '../terminal';
import type { App } from '../app';

/** Options for ToolContext.approve. */
export interface ApproveOptions {
  /**
   * A tool's own question rather than one of the built-in kinds (command, edit, MCP call): refused in plan mode,
   * asked in ask, acceptEdits and auto, run without asking in bypass (unless alwaysAsk). The card has only Allow and Deny.
   */
  custom?: boolean;
  /** With custom: ask even in bypass mode */
  alwaysAsk?: boolean;
}

/** Outcome of asking for permission: denied actions carry the message the model should read. */
export type ApprovalResult = { ok: true } | { ok: false; message: string };

export interface ToolContext {
  /** The session's folder (the folder the run started in) */
  cwd: string;
  /** The session the call belongs to */
  sessionId: string;
  /** The app's seams (undefined in bare tests that construct an Agent directly) */
  app?: App;
  /** True while the call's session is the one on screen (the built-in browser belongs to that session) */
  foreground(): boolean;
  config: AppConfig;
  mode: PermissionMode;
  browser: BrowserController;
  skills: Skill[];
  /** The Terminal pane's shell tabs (terminal_* tools) */
  terminal: TerminalManager;
  /**
   * Ask for permission to run a side-effecting action. `detail` is what the user sees (the command, or a preview
   * of the change); `target` is the absolute file path for write/edit tools so the guard can check it.
   */
  approve(toolName: string, detail: string, target?: string, opts?: ApproveOptions): Promise<ApprovalResult>;
  /** Call before changing a file so the Diff pane can show (and revert) the change */
  beforeChange(absPath: string): void;
  /** Plan mode: hand the proposed plan to the user */
  submitPlan(title: string, markdown: string): PlanInfo;
  /** create_artifact: store the artifact on the session and show it in the Browser pane */
  saveArtifact(input: ArtifactInput): { info: ArtifactInfo; action: 'created' | 'updated' };
  /** Aborted when the user stops the run; long tool calls (MCP) should give up on it */
  signal?: AbortSignal;
  /** update_tasks: replace the session's task list and show it */
  setTasks(tasks: TaskItem[]): void;
  /** ask_user: show the questions and wait for the answers, one per question (null: the user skipped them) */
  askUser?(questions: UserQuestion[]): Promise<QuestionAnswer[] | null>;
}

export interface ToolResult {
  content: string;
  /** Optional data: URL of an image (PNG) produced by the tool, e.g. a screenshot */
  image?: string;
  /**
   * The call turned out to hold a secret in its arguments (browser_type into a password field): the arguments as the
   * transcript and the PostToolUse hooks get them instead, with the secret hidden.
   */
  hiddenArgs?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object */
  parameters: Record<string, unknown>;
  /** A tool registered through app.tools is offered in plan mode only when it is read-only */
  readOnly?: boolean;
  /** Not essential: left out when the tool set is trimmed for a small context window (see AppConfig.toolSet) */
  optional?: boolean;
  /** Offered only to a session whose own tool set (Session.tools) names it, never to the others (a dream's tools) */
  scoped?: boolean;
  /** Set for tools an MCP server provides: which server, its own tool name and the annotations the approval rules use */
  mcp?: { server: string; scope: 'user' | 'project'; tool: string; readOnly: boolean; destructive: boolean };
  /**
   * Called before the call is stored or shown: the arguments as the transcript, the tool row and hooks get them when
   * one holds a secret (browser_type's text for a password field), else null. The call itself runs on the real ones.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shownArgs?(args: any, ctx: ToolContext): Promise<Record<string, unknown> | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_OUTPUT = 60_000;

export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} more characters]`;
}
