import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { ContextBreakdown, ContextSlice } from '../shared/context';
import type { AgentEvent, AppConfig, ApprovalScope, ArtifactInfo, CompactionInfo, ContextInfo, ImageAttachment, MessageOrigin, PermissionMode, PlanInfo, QuestionAnswer, QueuedMessage, TaskItem, UserQuestion } from '../shared/types';
import { expandMentions } from './mentions';
import { isOllama, makeClient, modelCapabilities, ollamaOf, plainError, resolveProvider, scrubSecrets } from './providers';
import { contextSize, ollamaChat, ollamaComplete, type ToolCall, type ToolSpec, type Usage } from './ollama';
import { contextLimit, essentialToolsOnly } from './context-window';
import { McpManager } from './mcp';
import {
  PRUNE_HARD,
  PRUNE_NORMAL,
  PRUNE_THRESHOLD,
  TAIL_FRACTION,
  carriedRequest,
  cleanSummary,
  compactThreshold,
  compactedPreamble,
  droppedPreamble,
  estimateMessageTokens,
  estimateSpecTokens,
  estimateTokens,
  filesTouched,
  findCut,
  formatTokens,
  isCompactPreamble,
  isContextLengthError,
  isSyntheticUser,
  lastUserIndex,
  pruneMessages,
  scaleTo,
  summaryBudgetChars,
  summaryMaxTokens,
  summaryRequest,
  type PruneOptions,
} from './compact';
import { instructionsPrompt, loadInstructions } from './instructions';
import { allTools, toSpec, type ApprovalResult, type ApproveOptions, type Tool, type ToolContext, type ToolResult } from './tools';
import { truncate } from './tools/types';
import { cleanAnswers } from './tools/ask-user';
import type { BrowserController } from './browser';
import { expandSlashCommand, type Skill } from './skills';
import { clip, latestPlan, toMeta, turnSnapshot, type Msg, type Session, type SessionStore, type Turn } from './sessions';
import { generateTitle, titlePrompt } from './titles';
import { guardCommand, guardWrite, isReadOnlyCommand, programsOf } from './guard';
import { TerminalManager } from './terminal';
import { ArtifactStore, type ArtifactInput } from './artifacts';
import os from 'node:os';
import path from 'node:path';
import { listChanges, snapshotBeforeChange } from './changes';
import type { App } from './app';
import { FAILED_RESULT, HOOK_NOTE_PREFIX } from './compact';
import type { HookEvent } from '../shared/hooks';
import type { FireContext, HookEngine, HookOutcome } from './hooks/engine';
import { claudeToolInput, claudeToolName, nativeToolInput, toolMatchNames } from './hooks/tools';

// The window size facts live in context-window.ts; re-exported because test/*.js loads them from here.
export { contextLimit, essentialToolsOnly, FULL_TOOLS_WINDOW } from './context-window';

/** The user turn that starts the build after a plan is approved. */
export const PLAN_APPROVED_TEXT = 'Plan approved. Implement it now, step by step. When done, summarise what changed.';

const DENIED = 'Not permitted: the user denied this action. Do not retry it; explain what you would have done and continue or stop.';
const PLAN_EDIT_BLOCKED = 'Not permitted in plan mode: describe this step in your plan instead.';
const PLAN_CMD_BLOCKED = 'Not permitted in plan mode: only read-only commands (ls, cat, grep, git status/log/diff …) run while planning. Describe this step in your plan instead.';
const PLAN_MCP_BLOCKED = 'Not permitted in plan mode: this MCP tool is not marked read-only. Describe this step in your plan instead.';
const PLAN_CUSTOM_BLOCKED = 'Not permitted in plan mode: this action needs the user\'s approval, which plan mode does not ask for. Describe this step in your plan instead.';
/** What a browser_* call from a session that is not on screen gets back (the pane belongs to the session on screen). */
export const BROWSER_BACKGROUND = 'Error: the built-in browser is only available while this session is on screen, and the user is looking at another session. Continue without the browser (use bash with curl for plain pages), or say that the user should open this session to let you browse.';
const SUMMARY_TIMEOUT_MS = 240_000;
/** How many times Stop hooks may send one run back to work (a hook that keeps blocking is stopped here) */
const MAX_STOP_CONTINUES = 8;
const MIN_COMPACT_MESSAGES = 2;

const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'terminal_run']);

/** Tells the model what is missing, so it can say so instead of improvising. */
const ESSENTIAL_NOTE =
  'To save context for this model\'s small window, the tools for scheduled tasks, sub-sessions and writing mods are turned off. If the user asks for one of those, say that all tools can be turned on in Settings → Context ("Tools offered to the model").';

/** The system prompt in the pieces the context breakdown counts separately; joined in this order they are the prompt. */
interface PromptParts {
  base: string;
  skills: string;
  mcp: string;
  mode: string;
  userExtra: string;
  /** One chunk per instructions file */
  instructions: { label: string; text: string }[];
  sections: string;
}

/**
 * `cfg.workingDirectory` is the session's folder here (see Agent.sessionConfig). `extra` is the app's registered
 * sections. `own`: the session has a tool set of its own (Session.tools), named here instead of the usual ones.
 */
function systemPrompt(cfg: AppConfig, skills: Skill[], mcp: McpManager | null, extra = '', own?: string[]): string {
  const p = systemPromptParts(cfg, skills, mcp, extra, own);
  return p.base + p.skills + p.mcp + p.mode + p.userExtra + p.instructions.map((i) => i.text).join('') + p.sections;
}

/**
 * A session with a tool set of its own (a dream) is told what it has and nothing about the shell, the browser, the
 * permission mode, MCP servers or skills it cannot use; its sections (`extra`) say what it is for. The instructions
 * files are left out too: what such a session needs of them, its first message carries.
 */
function ownToolsPromptParts(cfg: AppConfig, extra: string, own: string[]): PromptParts {
  const base = `You are Silo Harness, running on the user's Mac.
Working directory: ${cfg.workingDirectory}
Today: ${new Date().toISOString().slice(0, 10)}

In this session you have only these tools: ${own.join(', ')}. You cannot run commands, change files, browse or start other sessions; do not say that you did.`;
  const userExtra = cfg.systemPromptExtra ? `\n\n${cfg.systemPromptExtra}` : '';
  const sections = extra.trim() ? `\n\n${extra.trim()}` : '';
  return { base, skills: '', mcp: '', mode: '', userExtra, instructions: [], sections };
}

function systemPromptParts(cfg: AppConfig, skills: Skill[], mcp: McpManager | null, extra = '', own?: string[]): PromptParts {
  if (own) return ownToolsPromptParts(cfg, extra, own);
  const base = `You are Silo Harness, an autonomous coding agent running on the user's Mac.
Working directory: ${cfg.workingDirectory}
Today: ${new Date().toISOString().slice(0, 10)}

You have tools for the filesystem (read_file, write_file, edit_file, list_directory, glob, grep), a shell (bash), a built-in browser pane that the user can see next to the chat (browser_* tools), the Terminal pane next to the chat (terminal_* tools), and create_artifact for deliverables shown in the browser pane.

How to work:
- Act with tools instead of guessing. Explore with glob/grep/read_file before editing. Read a file before you edit it, and prefer edit_file for targeted changes.
- Use bash for builds, tests and git. Commands must be non-interactive.
- Terminal pane: terminal_run types a command into a shell tab the user can see and keeps it running (dev servers, watchers, anything they should watch or take over); terminal_read shows what a tab prints later or what the user ran there; terminal_list and terminal_stop manage the tabs. Prefer bash for one-off commands.
- Artifacts: when the result is something to look at or hand over rather than a project file (a web page or small app, an SVG diagram, a report or document in Markdown, a standalone code sample), call create_artifact with the complete content; it opens in the Browser pane. Update it by calling create_artifact again with its id and the full new content. Images the user attaches to a message are visible to you if the model supports vision; describe or use them as asked. Never append "/think", "/no_think" or similar switches to commands, file contents or tool arguments.
- Browser: browser_navigate to a URL, then act by visible text: browser_click with text ("Sign in") and browser_type with field (the field's label or placeholder). When text is ambiguous, browser_read_page lists elements with refs (ref_N) you can pass instead; refs change after navigation, so read the page again after it changes. Use browser_get_text to read article-style pages, browser_wait_for when a page needs a moment to update, and browser_screenshot when layout matters.
- Keep going until the task is complete, then finish with a short summary of what you did and what you found. Do not ask questions you can answer with a tool.
- If a tool reports that an action was not permitted, do not retry it; explain what you would have done and continue with what you can do.
- Skills: a <skill> block in a user message holds instructions for that request; follow them. Only load a skill with the skill tool when the user invoked it with /name or the task clearly matches its description, never as a substitute for finishing the task.
- Mentions: when the user writes @path, that file's contents (or a folder's listing) follow their message in a <file> block; treat it as the current contents of that file and do not read it again unless the block says it was cut short.
- Tasks: for work with several steps, keep a short task list with update_tasks (the whole list each time, one item in_progress) so the user can follow along; skip it for quick answers.`;
  const skillList = skills.length
    ? `\n\nAvailable skills:\n${skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n')}`
    : '';
  let modeText = '';
  if (cfg.permissionMode === 'plan') {
    modeText = `\n\nPLAN MODE: you are planning, not building. Explore with read_file, glob, grep, list_directory, read-only shell commands (ls, cat, git status/log/diff …) and the browser. Do not change files and do not run commands that change anything; write_file and edit_file are unavailable. When you understand the task, call submit_plan exactly once with a concise Markdown plan: the goal, numbered steps naming the files to touch, how to verify, and open questions. Then stop; the user decides whether to build it.`;
  } else if (cfg.permissionMode === 'auto') {
    modeText = `\n\nYou run with automatic approval. A few risky actions (sudo, destructive git, writes outside the working directory, publishing, …) are paused for the user to review.`;
  }
  const servers = mcp?.describe() ?? '';
  const mcpText = servers
    ? `\n\nMCP servers provide extra tools named mcp__<server>__<tool> (their descriptions say what they do). Use them when they fit the task; the user approves calls that can change something.\n${servers}`
    : '';
  const userExtra = cfg.systemPromptExtra ? `\n\n${cfg.systemPromptExtra}` : '';
  const instructions = loadInstructions(cfg.workingDirectory).map((f) => ({ label: f.label, text: instructionsPrompt([f]) }));
  const sections = extra.trim() ? `\n\n${extra.trim()}` : '';
  return { base, skills: skillList, mcp: mcpText, mode: modeText, userExtra, instructions, sections };
}

/** A user message: plain text, or text plus image parts when images are attached. */
function userMessage(text: string, attachments: ImageAttachment[]): Msg {
  if (!attachments.length) return { role: 'user', content: text };
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const a of attachments) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
  return { role: 'user', content: parts };
}

function noToolsNotice(model: string): string {
  return `${model} does not support tools, so this run is a plain chat: it can see your message and images but cannot read files, run commands or browse.`;
}

/**
 * What a run's error says: a service's refusal or an unreachable address in plain words, naming the provider and
 * what to check (plainError); anything else as it is. Never with a key.
 */
function providerErrorMessage(err: unknown, cfg: AppConfig): string {
  const e = err as { status?: unknown; name?: unknown };
  const fromService = typeof e?.status === 'number' || e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError';
  if (!fromService || isContextLengthError(err)) return errorMessage(err);
  try {
    return plainError(err, resolveProvider(cfg));
  } catch {
    return errorMessage(err);
  }
}

/** An error's message, with any key the providers resolved taken out (a service's error may quote it). */
function errorMessage(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : String(err));
}

/** Folds one chunk's usage into the running counts (gateways may repeat or split the counts across chunks). */
function mergeUsage(prev: Usage | null, u: { prompt_tokens?: number; completion_tokens?: number }): Usage {
  return {
    promptTokens: Math.max(prev?.promptTokens ?? 0, Number(u.prompt_tokens) || 0),
    completionTokens: Math.max(prev?.completionTokens ?? 0, Number(u.completion_tokens) || 0),
  };
}

/** What answering an approval card changes besides the pending call: a mode switch, or a rule to save for the project. */
export interface ApprovalOutcome {
  setMode?: PermissionMode;
  rule?: { kind: 'program' | 'reason' | 'edits' | 'mcp'; values: string[] };
}

interface PendingApproval {
  resolve: (r: ApprovalResult) => void;
  name: string;
  programs: string[];
  reason: string | null;
  /** A tool's own question (ApproveOptions.custom): no "always" answers */
  custom?: boolean;
}

/** How a run's user message was sent (Agent.run, Agent.enqueue). */
export interface SendOptions {
  /** Default 'user' for run and 'queue' for enqueue */
  origin?: MessageOrigin;
  /** Who delivered it: the sending session's id, the schedule's or mod's name */
  from?: string;
}

/** The final, optional constructor argument; the runtime passes all of it, bare tests none. */
export interface AgentOptions {
  /** The session this agent is bound to (default: a new one from the store) */
  session?: Session;
  /** The app's seams, handed to tools as ToolContext.app */
  app?: App;
  /** True while this agent's session is on screen (default: always) */
  foreground?: () => boolean;
  /** Extra tools offered next to the built-in and MCP ones (app.tools) */
  tools?: () => Tool[];
  /** Extra system-prompt text (app.prompt sections, already joined) */
  prompt?: (info: { cwd: string; mode: PermissionMode; sessionId: string; essential?: boolean; restricted?: boolean }) => string;
  /** The hook engine (default: the app's 'hooks' service; none in bare tests) */
  hooks?: HookEngine | null;
}

/** A hook's block reason for a notice: without the "<Event> hook error: [<command>]: " prefix the model reads. */
function plainReason(s: string): string {
  return s.replace(/^\S+ hook (?:error|feedback): \[[^\]]*\]: /gm, '');
}

/** What a PreToolUse hook decided about the approval card: skip it, or show it whatever the mode says. */
type HookApproval = 'allow' | 'ask' | null;

export class Agent {
  session: Session;
  private abortController: AbortController | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  /** ask_user cards waiting for the user's answers */
  private pendingQuestions = new Map<string, { resolve: (answers: QuestionAnswer[] | null) => void; questions: UserQuestion[] }>();
  /** Per session: programs ("git", "npm") the user allowed for the rest of the session. */
  private allowedPrograms = new Map<string, Set<string>>();
  /** Per session: guard reasons ("uses sudo") the user allowed for the rest of the session. */
  private allowedReasons = new Map<string, Set<string>>();
  /** Set by submit_plan during a run so the loop ends with reason 'plan'. */
  private planSubmitted = false;
  /** Sessions whose title generation has started: one attempt per session, never two at once. */
  private titleAttempts = new Set<string>();
  /** base URL + model pairs that rejected stream_options; they stream without usage. */
  private noStreamUsage = new Set<string>();
  /** Ollama base URL + model → whether the model accepts tools (vision-only models do not); unknown until checked */
  private toolSupport = new Map<string, boolean>();
  /** max_tokens for the provider in use, when its entry sets maxOutput (set as each run or compaction starts) */
  private maxOutput: number | undefined;
  /** Per session: MCP servers the user allowed for the rest of the session. */
  private mcpAllowed = new Map<string, Set<string>>();
  /** Tokens the tool specs take on every request (measured at the start of each run). */
  private specTokens = 2500;
  /** Usage of the most recent model call, for the context estimate. */
  private lastUsage: Usage | null = null;
  /**
   * Reported over estimated size of the last request: models count tool schemas and the like differently than four
   * characters per token, so an estimate (after a prune or a fold, before the next reply) is scaled by it.
   */
  private estimateScale = 1;
  /** Set when an automatic compaction failed during this run, so it is not retried every turn. */
  private autoCompactFailed = false;
  /** Message count right after the last compaction of this run: no second one until the conversation grew again */
  private compactedAt = -1;
  /** Message count when this run was told that nothing could be dropped: not repeated until the conversation grew */
  private stuckAt = -1;
  /** Sessions told that the window is too small for the prompt and tools (once each) */
  private smallWindowNoticed = new Set<string>();
  /** The checkpoint that file changes are recorded on during a run (the latest user message) */
  private currentTurn: Turn | null = null;
  running = false;
  /** True while /compact runs outside a run (stop() cancels it). */
  compacting = false;
  /** SessionStart fired for this session in this app session (SessionEnd fires only then) */
  private sessionStarted = false;
  /** A hook said continue: false; the run stops after the current step */
  private hookStop: string | null = null;

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly browser: BrowserController,
    private readonly store: SessionStore,
    private readonly getSkills: (cwd: string) => Skill[],
    private readonly emit: (ev: AgentEvent) => void,
    terminal?: TerminalManager,
    artifacts?: ArtifactStore,
    mcp?: McpManager,
    opts: AgentOptions = {},
  ) {
    this.session = opts.session ?? store.create();
    this.opts = opts;
    this.mcp = mcp ?? null;
    this.terminal = terminal ?? new TerminalManager({ dataDir: path.join(os.tmpdir(), 'silo-harness'), cwd: () => this.getConfig().workingDirectory });
    this.artifacts = artifacts ?? new ArtifactStore({ root: path.join(os.tmpdir(), 'silo-harness', 'artifacts'), rendererDir: path.join(__dirname, '..', 'renderer') });
  }

  /** The Terminal pane's tabs, shared with the window's IPC handlers */
  readonly terminal: TerminalManager;
  /** Artifact files per session, shared with the window's IPC handlers and the artifact:// protocol */
  readonly artifacts: ArtifactStore;
  /** MCP servers whose tools join the built-in ones (null in tests without any) */
  readonly mcp: McpManager | null;
  /** Messages sent while a run was in progress; delivered before the model's next turn */
  private queued: QueuedMessage[] = [];
  private readonly opts: AgentOptions;
  /** The folder of the run in progress: a folder change while it runs applies from the next run on */
  private runCwd: string | null = null;

  /** The folder this agent works in: the run's, else the session's, else the app's (a session without one adopts it when it runs). */
  cwd(): string {
    return this.runCwd ?? this.session.cwd ?? this.getConfig().workingDirectory;
  }

  /** The app's config with the session's folder as the working directory, which is all the agent reads it for. */
  private sessionConfig(): AppConfig {
    const cfg = this.getConfig();
    const cwd = this.cwd();
    return cwd === cfg.workingDirectory ? cfg : { ...cfg, workingDirectory: cwd };
  }

  private isForeground(): boolean {
    return this.opts.foreground ? this.opts.foreground() : true;
  }

  /** The tool names this session is limited to (Session.tools), or undefined for the usual tools. */
  private ownTools(): string[] | undefined {
    const own = this.session.tools;
    return Array.isArray(own) ? own.filter((n) => typeof n === 'string') : undefined;
  }

  private promptExtra(cfg: AppConfig): string {
    if (!this.opts.prompt) return '';
    try {
      if (this.ownTools()) return this.opts.prompt({ cwd: cfg.workingDirectory, mode: cfg.permissionMode, sessionId: this.session.id, restricted: true });
      const essential = essentialToolsOnly(cfg);
      const text = this.opts.prompt({ cwd: cfg.workingDirectory, mode: cfg.permissionMode, sessionId: this.session.id, essential });
      return essential ? `${text}${text ? '\n\n' : ''}${ESSENTIAL_NOTE}` : text;
    } catch (err) {
      console.warn('[agent] a prompt section failed:', errorMessage(err));
      return '';
    }
  }

  private prompt(cfg: AppConfig, skills: Skill[]): string {
    return systemPrompt(cfg, skills, this.mcp, this.promptExtra(cfg), this.ownToolNames(cfg));
  }

  /** The names of the tools a session with a tool set of its own really has (those it names that exist). */
  private ownToolNames(cfg: AppConfig): string[] | undefined {
    return this.ownTools() ? this.toolsFor(cfg).map((t) => t.name) : undefined;
  }

  /**
   * The tools a run in this mode offers: built-in, registered and MCP ones (plan mode: the read-only ones). A session
   * with a tool set of its own gets exactly the built-in and registered tools it names, in every mode, and never an
   * MCP tool; scoped tools are offered to no other session.
   */
  private toolsFor(cfg: AppConfig): Tool[] {
    const registered = this.opts.tools?.() ?? [];
    const own = this.ownTools();
    if (own) {
      const pool = [...allTools('ask'), ...allTools('plan'), ...registered];
      const out: Tool[] = [];
      for (const name of own) {
        const t = pool.find((x) => x.name === name && !x.mcp);
        if (t && !out.includes(t)) out.push(t);
      }
      return out;
    }
    const mcpTools = this.mcp?.tools() ?? [];
    const plan = cfg.permissionMode === 'plan';
    const essential = essentialToolsOnly(cfg);
    const extraTools = registered.filter((t) => !t.scoped && !(essential && t.optional));
    return [...allTools(cfg.permissionMode), ...(plan ? extraTools.filter((t) => t.readOnly) : extraTools), ...(plan ? mcpTools.filter((t) => t.mcp?.readOnly) : mcpTools)];
  }

  /** True while the approval card `id` is waiting for this agent. */
  hasApproval(id: string): boolean {
    return this.pendingApprovals.has(id);
  }

  /** True while the message `id` waits in this agent's queue. */
  hasQueued(id: string): boolean {
    return this.queued.some((m) => m.id === id);
  }

  stop(): void {
    this.abortController?.abort();
    this.dropQuestions();
    const pending = [...this.pendingApprovals.entries()];
    this.pendingApprovals.clear();
    for (const [id, p] of pending) {
      p.resolve({ ok: false, message: 'Tool call was interrupted before it produced a result.' });
      this.emit({ type: 'approval_resolved', id, ok: false, scope: 'once', interrupted: true });
    }
  }

  /**
   * Answers an approval card. With `always`, the user does not want to be asked again this session for this kind of
   * action: a flagged reason or a command's programs are allow-listed; for edits in ask mode the caller switches the
   * mode to acceptEdits (returned as `setMode`).
   */
  resolveApproval(id: string, ok: boolean, always = false, scope: ApprovalScope = 'session'): ApprovalOutcome {
    const p = this.pendingApprovals.get(id);
    if (!p) return {};
    this.pendingApprovals.delete(id);
    const out: ApprovalOutcome = {};
    if (p.custom) always = false;
    if (ok && always) {
      const isMcp = p.name.startsWith('mcp__') && !!p.programs[0];
      const isCmd = p.name === 'bash' || p.name === 'terminal_run';
      const isEdit = p.name === 'write_file' || p.name === 'edit_file';
      // The session sets cover the rest of this run either way; a project rule is persisted by the caller as well.
      if (isMcp) this.sessionSet(this.mcpAllowed).add(p.programs[0]);
      else if (p.reason) this.sessionSet(this.allowedReasons).add(p.reason);
      else if (isCmd) for (const prog of p.programs) this.sessionSet(this.allowedPrograms).add(prog);
      if (scope === 'project') {
        if (isMcp) out.rule = { kind: 'mcp', values: [p.programs[0]] };
        else if (p.reason) out.rule = { kind: 'reason', values: [p.reason] };
        else if (isCmd) out.rule = { kind: 'program', values: p.programs };
        else if (isEdit) out.rule = { kind: 'edits', values: [] };
      } else if (isEdit && this.getConfig().permissionMode === 'ask') out.setMode = 'acceptEdits';
    }
    p.resolve(ok ? { ok: true } : { ok: false, message: DENIED });
    this.emit({ type: 'approval_resolved', id, ok, scope: ok && always ? scope : 'once' });
    return out;
  }

  /** True while the question card `id` (ask_user) is waiting for this agent. */
  hasQuestion(id: string): boolean {
    return this.pendingQuestions.has(id);
  }

  /** Answers a question card, one answer per question; null skips it. False when no such card waits. */
  resolveQuestion(id: string, answers: unknown): boolean {
    const p = this.pendingQuestions.get(id);
    if (!p) return false;
    this.pendingQuestions.delete(id);
    const clean = answers === null ? null : cleanAnswers(p.questions, answers);
    p.resolve(clean);
    this.emit(clean ? { type: 'question_resolved', id, answers: clean } : { type: 'question_resolved', id, skipped: true });
    return true;
  }

  /** ask_user: shows the questions on a card and waits, as an approval does, until they are answered or skipped. */
  private askUser(questions: UserQuestion[]): Promise<QuestionAnswer[] | null> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pendingQuestions.set(id, { resolve, questions });
      this.emit({ type: 'question_request', id, questions });
    });
  }

  /** A stop ends the questions still waiting, unanswered (the tool reports the interruption). */
  private dropQuestions(): void {
    const pending = [...this.pendingQuestions.entries()];
    this.pendingQuestions.clear();
    for (const [id, p] of pending) {
      p.resolve(null);
      this.emit({ type: 'question_resolved', id, skipped: true });
    }
  }

  private sessionSet(map: Map<string, Set<string>>): Set<string> {
    let s = map.get(this.session.id);
    if (!s) {
      s = new Set();
      map.set(this.session.id, s);
    }
    return s;
  }

  /**
   * Decides, per permission mode, whether an action runs, asks, or is refused. `hookAllowed`: a PreToolUse hook allowed
   * the call, so no card is shown (what the mode refuses outright, plan mode's edits, stays refused).
   */
  private requestApproval(name: string, detail: string, target?: string, opts: ApproveOptions = {}, hookAllowed = false): Promise<ApprovalResult> {
    const cfg = this.sessionConfig();
    const mode = cfg.permissionMode;
    const cwd = cfg.workingDirectory;
    const isEdit = name === 'write_file' || name === 'edit_file';
    const isCmd = name === 'bash' || name === 'terminal_run';
    const allow = Promise.resolve<ApprovalResult>({ ok: true });
    const refuse = (message: string) => Promise.resolve<ApprovalResult>({ ok: false, message });
    const ask = (...a: Parameters<Agent['ask']>) => (hookAllowed ? allow : this.ask(...a));
    if (opts.custom) {
      if (mode === 'plan') return refuse(PLAN_CUSTOM_BLOCKED);
      if (mode === 'bypass' && !opts.alwaysAsk) return allow;
      return ask(name, detail, mode, null, [], true);
    }
    if (mode === 'bypass') return allow;
    const rules = cfg.allowRules?.[cwd];
    const ref = this.mcp?.lookup(name);
    if (ref) {
      // MCP tools: read-only ones run everywhere; the rest ask once per server (auto mode asks only for destructive ones).
      if (mode === 'plan') return ref.readOnly ? allow : refuse(PLAN_MCP_BLOCKED);
      if (ref.readOnly || this.sessionSet(this.mcpAllowed).has(ref.server) || rules?.mcp?.includes(ref.server)) return allow;
      if (mode === 'auto') return ref.destructive ? ask(name, detail, mode, 'destructive MCP tool', [ref.server]) : allow;
      return ask(name, detail, mode, null, [ref.server]);
    }
    if (mode === 'plan') {
      if (isEdit) return refuse(PLAN_EDIT_BLOCKED);
      if (isCmd) return isReadOnlyCommand(detail) ? allow : refuse(PLAN_CMD_BLOCKED);
      return allow;
    }
    if (!isEdit && !isCmd) return allow;
    const reason = isCmd ? guardCommand(detail, cwd) : target ? guardWrite(target, cwd) : null;
    const programs = isCmd ? programsOf(detail) : [];
    if (reason && !this.sessionSet(this.allowedReasons).has(reason) && !rules?.reasons?.includes(reason)) return ask(name, detail, mode, reason, programs);
    if (mode === 'auto') return allow;
    if (isEdit && (mode === 'acceptEdits' || rules?.edits)) return allow;
    if (isCmd && programs.length && programs.every((p) => this.sessionSet(this.allowedPrograms).has(p) || rules?.programs?.includes(p))) return allow;
    return ask(name, detail, mode, null, programs);
  }

  private ask(name: string, detail: string, mode: PermissionMode, reason: string | null, programs: string[], custom = false): Promise<ApprovalResult> {
    const id = randomUUID();
    this.notifyHook('permission_prompt', `Silo Harness needs your permission to use ${claudeToolName(name)}`);
    if (custom) {
      // Only Allow and Deny: the renderer hides the buttons whose label is empty.
      return new Promise((resolve) => {
        this.pendingApprovals.set(id, { resolve, name, programs, reason, custom: true });
        this.emit({ type: 'approval_request', id, name, detail, mode, ...(reason ? { reason } : {}), alwaysLabel: '', projectLabel: '' });
      });
    }
    const what = name.startsWith('mcp__')
      ? programs[0] ?? 'this server'
      : reason
      ? 'this kind of action'
      : name === 'bash' || name === 'terminal_run'
        ? programs.join(', ') || 'this command'
        : 'edits';
    const alwaysLabel = `Allow ${what} for this session`;
    const projectLabel = `Always allow ${what} in this project`;
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, { resolve, name, programs, reason });
      this.emit({ type: 'approval_request', id, name, detail, mode, reason: reason ?? undefined, alwaysLabel, projectLabel });
    });
  }

  /** submit_plan: store the plan on the session, tell the renderer, and end the run after this turn. */
  private submitPlan(title: string, markdown: string): PlanInfo {
    const plan: PlanInfo = { id: randomUUID(), title: clip(title.trim() || 'Plan', 80), markdown: markdown.trim(), status: 'proposed', createdAt: Date.now() };
    this.session.plans ??= {};
    this.session.plans[plan.id] = plan;
    this.planSubmitted = true;
    this.emit({ type: 'plan_proposed', plan });
    return plan;
  }

  /** Marks the current session's plan approved (build) or rejected (keep planning). The caller changes the mode and starts the build. */
  respondPlan(id: string, decision: 'build-ask' | 'build-acceptEdits' | 'keep'): PlanInfo {
    const plan = this.session.plans?.[id];
    if (!plan) throw new Error('No such plan in this conversation.');
    if (plan.status !== 'proposed') throw new Error('This plan was already decided.');
    plan.status = decision === 'keep' ? 'rejected' : 'approved';
    this.store.save(this.session, false);
    return plan;
  }

  /** Recomputes the changed-file count in the background and tells the renderer. */
  notifyChanges(): void {
    const session = this.session;
    listChanges(session, this.cwd())
      .then((list) => this.emit({ type: 'changes_updated', count: list.length }))
      .catch((err: unknown) => console.warn('[changes] listing failed:', errorMessage(err)));
  }

  // ---------- Hooks ----------

  private hookEngine(): HookEngine | null {
    if (this.opts.hooks !== undefined) return this.opts.hooks;
    const app = this.opts.app;
    return app && typeof app.service === 'function' ? (app.service<HookEngine>('hooks') ?? null) : null;
  }

  /** Whether any hook could fire for the event in this session's folder. */
  private hasHooks(event: HookEvent): boolean {
    try {
      return !!this.hookEngine()?.has(event, this.cwd());
    } catch {
      return false;
    }
  }

  /**
   * Runs the hooks of one event for this session, when there are any. Their messages and non-blocking errors become
   * quiet notices; a handler's statusMessage shows in the status line while it runs.
   */
  private async fireHook(event: HookEvent, fields: Record<string, unknown>, opts: Pick<FireContext, 'match' | 'tool' | 'signal' | 'budgetMs'> & { sessionId?: string; transcriptPath?: string } = {}): Promise<HookOutcome | null> {
    const engine = this.hookEngine();
    const cwd = this.cwd();
    if (!engine) return null;
    try {
      if (!engine.has(event, cwd)) return null;
      const { sessionId, transcriptPath, ...rest } = opts;
      const out = await engine.fire(event, {
        sessionId: sessionId ?? this.session.id,
        cwd,
        projectDir: cwd,
        transcriptPath: transcriptPath ?? this.store.file(this.session.id),
        permissionMode: this.getConfig().permissionMode,
        fields,
        ...rest,
        status: (text) => this.emit({ type: 'hook_status', text }),
      });
      for (const n of out.notices) this.emit({ type: 'error', kind: 'notice', message: n });
      if (out.stop) this.hookStop = out.stop.reason || `A ${event} hook stopped the run.`;
      return out;
    } catch (err) {
      console.warn(`[hooks] ${event} failed:`, errorMessage(err));
      return null;
    }
  }

  private windowFocused(): boolean {
    try {
      const w = this.opts.app?.window();
      return !!w && w.isFocused();
    } catch {
      return false;
    }
  }

  /**
   * Stop at the end of a run (SubagentStop for a sub-session, with the parent's session as the hook's own). Returns
   * the reason to keep working when a hook blocked the stop, else null. Exit code 2 sends the run back once; after
   * that (stop_hook_active true) only a JSON decision "block" does, and never more than MAX_STOP_CONTINUES times.
   */
  private async stopHooks(last: string, continues: number): Promise<string | null> {
    const active = continues > 0;
    const parent = this.session.parentId;
    const fields: Record<string, unknown> = { stop_hook_active: active, last_assistant_message: last };
    const out = parent
      ? await this.fireHook('SubagentStop', { ...fields, agent_id: this.session.id, agent_type: 'sub-session', agent_transcript_path: this.store.file(this.session.id) }, { match: ['sub-session'], sessionId: parent, transcriptPath: this.store.file(parent) })
      : await this.fireHook('Stop', fields);
    if (!out?.block) return null;
    const event = parent ? 'SubagentStop' : 'Stop';
    if (continues >= MAX_STOP_CONTINUES) {
      this.emit({ type: 'error', kind: 'notice', message: `A ${event} hook kept blocking the end of the run; it was let end after ${MAX_STOP_CONTINUES} more rounds.` });
      return null;
    }
    if (active && !out.jsonBlock) return null;
    this.emit({ type: 'error', kind: 'notice', message: `A ${event} hook sent the model back to work: ${plainReason(out.block)}` });
    return out.block;
  }

  /** A Notification hook, not waited for: permission_prompt when an approval card waits, idle_prompt when a run ends unseen. */
  private notifyHook(type: 'permission_prompt' | 'idle_prompt', message: string): void {
    void this.fireHook('Notification', { message, notification_type: type, title: 'Silo Harness' }, { match: [type] });
  }

  /** A hook's context for the model: a user-role note the transcript does not show. */
  private addHookNote(event: HookEvent, lines: string[], what = 'context'): void {
    const text = lines.map((l) => l.trim()).filter(Boolean).join('\n\n');
    if (text) this.store.append(this.session, { role: 'user', content: `${HOOK_NOTE_PREFIX}${what}: ${event}]\n${text}` });
  }

  /** SessionStart, once per session in this app session: startup for a new session, resume for one that has messages. */
  private async startSessionHooks(): Promise<void> {
    if (this.sessionStarted) return;
    this.sessionStarted = true;
    const source = this.session.messages.length ? 'resume' : 'startup';
    const out = await this.fireHook('SessionStart', { source }, { match: [source] });
    if (out?.context.length) this.addHookNote('SessionStart', out.context);
    if (out?.block) this.emit({ type: 'error', kind: 'notice', message: out.block });
  }

  /** SessionEnd: the session was closed or the app quits. Only for a session whose SessionStart fired. */
  async endSession(reason: 'deleted' | 'quit'): Promise<void> {
    if (!this.sessionStarted) return;
    this.sessionStarted = false;
    await this.fireHook('SessionEnd', { reason: 'other', silo_reason: reason }, { match: ['other', reason] });
  }

  /**
   * UserPromptSubmit for a message about to enter the conversation. Returns false when a hook blocked it (the message is
   * dropped and the reason shown); its context follows the message as a note.
   */
  private async promptHooks(text: string): Promise<{ ok: boolean; context: string[] }> {
    const out = await this.fireHook('UserPromptSubmit', { prompt: text });
    if (!out) return { ok: true, context: [] };
    if (out.block) {
      this.emit({ type: 'error', kind: 'notice', message: `A UserPromptSubmit hook blocked this message, so it was not sent: ${plainReason(out.block)}` });
      return { ok: false, context: [] };
    }
    return { ok: true, context: out.context };
  }

  async run(userText: string, attachments: ImageAttachment[] = [], opts: SendOptions = {}): Promise<void> {
    if (this.running) throw new Error('A run is already in progress.');
    this.running = true;
    this.planSubmitted = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    // A session from before folders were per session adopts the app's folder the first time it runs.
    if (!this.session.cwd) this.session.cwd = this.getConfig().workingDirectory;
    this.runCwd = this.session.cwd;
    const cfg = this.sessionConfig();
    let reason: 'done' | 'aborted' | 'max_turns' | 'error' | 'plan' = 'done';
    let lastText = '';

    const skills = this.getSkills(cfg.workingDirectory);
    const { content } = expandSlashCommand(expandMentions(userText, cfg.workingDirectory).content, skills);
    this.repairTail(); // a session saved mid-run (rename, generated title) and then quit may end in unanswered tool calls
    const origin = opts.origin ?? 'user';
    this.hookStop = null;
    // Hooks: SessionStart the first time this session runs, then UserPromptSubmit, which may drop the message. Without
    // any, nothing here waits, so the message is in the conversation by the time send() returns.
    const early = (!this.sessionStarted && this.hasHooks('SessionStart')) || this.hasHooks('UserPromptSubmit');
    let accepted: { ok: boolean; context: string[] } = { ok: true, context: [] };
    if (early) {
      this.emit({ type: 'run_start' });
      await this.startSessionHooks();
      accepted = await this.promptHooks(userText);
      if (!accepted.ok || signal.aborted) {
        this.running = false;
        this.abortController = null;
        this.runCwd = null;
        this.dropQueue();
        this.emit({ type: 'run_end', reason: signal.aborted ? 'aborted' : 'done' });
        return;
      }
    } else this.sessionStarted = true;
    this.startTurn(userText, origin, opts.from);
    this.store.append(this.session, userMessage(content, attachments));
    this.addHookNote('UserPromptSubmit', accepted.context);
    this.autoCompactFailed = false;
    this.compactedAt = -1;
    this.stuckAt = -1;
    if (!early) this.emit({ type: 'run_start' });
    this.emitUserMessage(userText, attachments.length, origin, opts.from);
    // Saved now, not only at the end: the session gets its title from this message at once, so a sidebar with
    // several running sessions does not show several "New session" rows.
    this.store.save(this.session);
    this.emit({ type: 'session_changed', session: toMeta(this.session) });

    try {
      const { client, model, maxOutput } = isOllama(cfg) ? { client: null, model: ollamaOf(cfg).model, maxOutput: undefined } : makeClient(cfg);
      this.maxOutput = maxOutput;
      if (!model) throw new Error('No model selected. Open Settings and pick one.');
      const tools = this.toolsFor(cfg);
      const specs = tools.map(toSpec);
      this.specTokens = estimateSpecTokens(specs);
      this.emitContext();
      // A model that cannot take tools (e.g. a vision-only Ollama model) still works as a plain chat.
      let activeSpecs = specs;
      if (!client) {
        const key = `${ollamaOf(cfg).baseURL}|${model}`;
        if (!this.toolSupport.has(key)) {
          const caps = await modelCapabilities(cfg).catch(() => null);
          if (caps && caps.tools !== null) this.toolSupport.set(key, caps.tools);
        }
        if (this.toolSupport.get(key) === false) {
          activeSpecs = [];
          this.emit({ type: 'error', kind: 'notice', message: noToolsNotice(model) });
        }
      }
      const ctx: ToolContext = {
        cwd: cfg.workingDirectory,
        sessionId: this.session.id,
        app: this.opts.app,
        foreground: () => this.isForeground(),
        config: cfg,
        mode: cfg.permissionMode,
        browser: this.browser,
        skills,
        terminal: this.terminal,
        approve: (name, detail, target, approveOpts) => this.requestApproval(name, detail, target, approveOpts),
        beforeChange: (abs) => {
          snapshotBeforeChange(this.session, abs);
          if (this.currentTurn) turnSnapshot(this.currentTurn, abs);
        },
        setTasks: (tasks) => this.setTasks(tasks),
        submitPlan: (title, markdown) => this.submitPlan(title, markdown),
        saveArtifact: (input) => this.saveArtifact(input),
        askUser: (questions) => this.askUser(questions),
        signal,
      };

      let nudged = false;
      /** Times a Stop hook sent this run back to work */
      let stopContinues = 0;
      for (let turn = 0; ; turn++) {
        if (turn >= cfg.maxTurns) {
          reason = 'max_turns';
          break;
        }
        if (signal.aborted) {
          reason = 'aborted';
          break;
        }
        if (this.queued.length) await this.drainQueue(skills);
        await this.autoCompactIfNeeded(cfg, client, model, signal);
        if (signal.aborted) {
          reason = 'aborted';
          break;
        }
        const history: Msg[] = [{ role: 'system', content: this.prompt(cfg, skills) }, ...this.session.messages];
        this.lastUsage = null;
        let reply: { text: string; toolCalls: ToolCall[] };
        try {
          reply = await this.complete(cfg, client, model, history, activeSpecs, signal, turn);
        } catch (err) {
          // The provider says the request does not fit: compact and try this call once more instead of ending the run.
          if (signal.aborted || cfg.autoCompact === false || !isContextLengthError(err)) throw err;
          await this.compact('auto', undefined, signal, cfg, client, model, { force: true });
          if (signal.aborted) {
            reason = 'aborted';
            break;
          }
          this.lastUsage = null;
          reply = await this.complete(cfg, client, model, [{ role: 'system', content: this.prompt(cfg, skills) }, ...this.session.messages], activeSpecs, signal, turn);
        }
        const { text, toolCalls } = reply;
        this.emit({ type: 'thinking_done' });

        if (!text.trim() && !toolCalls.length) {
          // Small models sometimes return nothing after a tool result. Nudge once, then give up.
          if (!nudged) {
            nudged = true;
            this.store.append(this.session, { role: 'user', content: 'You returned an empty response. If the task is complete, summarize the result. If a tool failed, fix the problem and continue.' });
            continue;
          }
        }
        const assistant: Msg = { role: 'assistant', content: text };
        if (toolCalls.length) assistant.tool_calls = toolCalls;
        this.store.append(this.session, assistant);
        if (text.trim()) lastText = text;
        this.markPrompt();
        if (text) this.emit({ type: 'text_done' });
        this.emit({ type: 'assistant_message', text, toolCalls: toolCalls.length });
        if (!toolCalls.length) {
          // A message queued during the run keeps it going instead of ending it.
          if (this.queued.length && (await this.drainQueue(skills))) continue;
          if (this.hookStop || signal.aborted) break;
          // Stop hooks may send the model back to work with a reason.
          const more = await this.stopHooks(lastText, stopContinues);
          if (more && !signal.aborted && !this.hookStop) {
            stopContinues++;
            this.addHookNote(this.session.parentId ? 'SubagentStop' : 'Stop', [more], 'feedback');
            continue;
          }
          break;
        }

        for (const call of toolCalls) {
          if (signal.aborted || this.hookStop) break;
          const result = await this.execTool(call, tools, ctx);
          this.store.append(this.session, { role: 'tool', tool_call_id: call.id, content: result.content });
          const used = tools.find((t) => t.name === call.function.name);
          if (CHANGING_TOOLS.has(call.function.name) || (used?.mcp && !used.mcp.readOnly)) this.notifyChanges();
          if (result.image && cfg.sendScreenshotsToModel) {
            this.store.append(this.session, {
              role: 'user',
              content: [
                { type: 'text', text: `[Screenshot returned by ${call.function.name}]` },
                { type: 'image_url', image_url: { url: result.image } },
              ],
            });
          }
        }
        if (this.planSubmitted) {
          reason = 'plan';
          break;
        }
        if (this.hookStop) break;
      }
      if (this.hookStop) this.emit({ type: 'error', kind: 'notice', message: `Stopped by a hook: ${this.hookStop}` });
    } catch (err) {
      if (signal.aborted) reason = 'aborted';
      else {
        reason = 'error';
        this.emit({ type: 'error', message: providerErrorMessage(err, cfg) });
      }
    } finally {
      this.currentTurn = null;
      this.repairTail();
      this.store.save(this.session);
      this.running = false;
      this.abortController = null;
      this.runCwd = null;
      this.dropQueue();
      this.emit({ type: 'session_changed', session: toMeta(this.session) });
      this.emit(lastText ? { type: 'run_end', reason, text: lastText } : { type: 'run_end', reason });
      if (reason !== 'aborted' && !this.windowFocused()) this.notifyHook('idle_prompt', 'Silo Harness is waiting for your input');
      if (reason === 'done' || reason === 'max_turns' || reason === 'plan') {
        this.generateSessionTitle(this.session).catch((err: unknown) => console.warn('[agent] title generation failed:', errorMessage(err)));
      }
    }
  }

  // ---------- Context window ----------

  /** Where the next request stands against the context window. */
  contextInfo(): ContextInfo {
    const cfg = this.sessionConfig();
    const limit = contextLimit(cfg);
    const s = this.session;
    const mark = s.lastPrompt;
    let tokens: number;
    if (mark && mark.at <= s.messages.length) tokens = mark.tokens + estimateTokens(s.messages.slice(mark.at));
    else tokens = Math.round((estimateTokens([{ role: 'system', content: this.prompt(cfg, this.getSkills(cfg.workingDirectory)) }, ...s.messages]) + this.specTokens) * this.estimateScale);
    return { tokens, limit, threshold: compactThreshold(cfg), autoCompact: cfg.autoCompact !== false };
  }

  emitContext(): void {
    this.emit({ type: 'context', context: this.contextInfo() });
  }

  /**
   * What fills the context window, slice by slice (the slices add up to the window). With a reported token count
   * from the last request the estimates are scaled so their total matches it.
   */
  contextBreakdown(): ContextBreakdown {
    const cfg = this.sessionConfig();
    const s = this.session;
    const limit = contextLimit(cfg);
    const threshold = compactThreshold(cfg);
    const chars = (t: string) => (t ? Math.ceil(t.length / 4) : 0);
    const parts = systemPromptParts(cfg, this.getSkills(cfg.workingDirectory), this.mcp, this.promptExtra(cfg), this.ownToolNames(cfg));
    const noTools = isOllama(cfg) && this.toolSupport.get(`${ollamaOf(cfg).baseURL}|${ollamaOf(cfg).model}`) === false;
    const tools = noTools ? [] : this.toolsFor(cfg);
    const byServer = new Map<string, Tool[]>();
    for (const t of tools) if (t.mcp) byServer.set(t.mcp.server, [...(byServer.get(t.mcp.server) ?? []), t]);
    let summary = 0;
    let said = 0;
    let toolTokens = 0;
    for (const m of s.messages) {
      if (isCompactPreamble(m)) summary += estimateMessageTokens(m);
      else if (m.role === 'tool' || isSyntheticUser(m)) toolTokens += estimateMessageTokens(m);
      else if (m.role === 'assistant' && m.tool_calls?.length) {
        const total = estimateMessageTokens(m);
        const own = estimateMessageTokens({ role: 'assistant', content: m.content ?? '' } as Msg);
        said += own;
        toolTokens += total - own;
      } else said += estimateMessageTokens(m);
    }
    const instr = parts.instructions.map((i) => ({ label: i.label, tokens: chars(i.text) }));
    const mcpItems = [...byServer].map(([server, list]) => ({ label: server, tokens: estimateSpecTokens(list.map(toSpec)) }));
    const skillItems = parts.skills ? [{ label: 'Skills list', tokens: chars(parts.skills) }] : [];
    const used: ContextSlice[] = [
      { key: 'system', label: 'System prompt', tokens: chars(parts.base + parts.mcp + parts.mode + parts.userExtra + parts.sections) + 2 },
      { key: 'instructions', label: 'Instructions files', tokens: instr.reduce((a, b) => a + b.tokens, 0), items: instr },
      { key: 'skills', label: 'Skills', tokens: chars(parts.skills), items: skillItems },
      { key: 'tools', label: 'Tool definitions', tokens: estimateSpecTokens(tools.filter((t) => !t.mcp).map(toSpec)) },
      { key: 'mcpTools', label: 'MCP tools', tokens: mcpItems.reduce((a, b) => a + b.tokens, 0), items: mcpItems },
      { key: 'summary', label: 'Compaction brief', tokens: summary },
      { key: 'messages', label: 'Messages', tokens: said },
      { key: 'toolResults', label: 'Tool calls and results', tokens: toolTokens },
    ];
    const estimated = used.reduce((a, b) => a + b.tokens, 0);
    const mark = s.lastPrompt;
    const reported = !!mark && mark.at <= s.messages.length && mark.tokens > 0;
    const total = reported ? this.contextInfo().tokens : estimated;
    // The slices fill the window exactly: in use (capped at the window), the reserve above the threshold, and free.
    const fit = Math.min(total, limit);
    const scaled = scaleTo(used.map((x) => x.tokens), fit);
    used.forEach((x, i) => {
      x.tokens = scaled[i];
      if (x.items?.length) {
        const inner = scaleTo(x.items.map((it) => it.tokens), x.tokens);
        x.items = x.items.map((it, k) => ({ ...it, tokens: inner[k] }));
      }
      if (!x.items?.length) delete x.items;
    });
    const reserve = Math.max(0, Math.min(limit - fit, Math.round(limit * (1 - threshold))));
    const slices: ContextSlice[] = [
      ...used.filter((x) => x.tokens > 0 || x.key === 'system' || x.key === 'messages'),
      { key: 'reserve', label: 'Reserved for compaction', tokens: reserve },
      { key: 'free', label: 'Free', tokens: limit - fit - reserve },
    ];
    const busy = this.running || this.compacting;
    const foldable = findCut(s.messages, limit * TAIL_FRACTION) > 0 || pruneMessages(s.messages).results + pruneMessages(s.messages).images > 0;
    const out: ContextBreakdown = {
      tokens: Math.round(total),
      limit,
      threshold,
      autoCompact: cfg.autoCompact !== false,
      basis: reported ? 'reported' : 'estimated',
      slices,
      messages: s.messages.length,
      compactable: !busy && s.messages.length >= MIN_COMPACT_MESSAGES && foldable,
      compactions: s.compactions?.length ?? 0,
      updatedAt: Date.now(),
    };
    const last = s.compactions?.[s.compactions.length - 1];
    if (last) out.lastCompaction = { at: last.createdAt, reason: last.reason, tokensBefore: last.tokensBefore, tokensAfter: last.tokensAfter };
    return out;
  }

  /** Records what the last model call cost as the base of the context estimate (the reply is now part of the history). */
  private markPrompt(): void {
    const u = this.lastUsage;
    if (!u || !u.promptTokens) return;
    const s = this.session;
    s.lastPrompt = { tokens: u.promptTokens + u.completionTokens, at: s.messages.length };
    const estimated = this.baseTokens(this.sessionConfig()) + estimateTokens(s.messages);
    if (estimated > 0) this.estimateScale = Math.min(2, Math.max(0.67, s.lastPrompt.tokens / estimated));
    this.emitContext();
  }

  private reportUsage(usage: Usage): void {
    this.lastUsage = usage;
    this.emit({ type: 'usage', ...usage });
  }

  /** What every request costs before any conversation: the system prompt and the tool definitions. */
  private baseTokens(cfg: AppConfig): number {
    return estimateTokens([{ role: 'system', content: this.prompt(cfg, this.getSkills(cfg.workingDirectory)) }]) + this.specTokens;
  }

  /**
   * Before each model call: prune old tool output past 60% of the window, and compact past the threshold when
   * pruning was not enough.
   */
  private async autoCompactIfNeeded(cfg: AppConfig, client: OpenAI | null, model: string, signal: AbortSignal): Promise<void> {
    const s = this.session;
    if (cfg.autoCompact === false || s.messages.length < MIN_COMPACT_MESSAGES) return;
    const limit = contextLimit(cfg);
    const threshold = compactThreshold(cfg);
    if (this.contextInfo().tokens >= limit * PRUNE_THRESHOLD && cfg.pruneToolResults !== false) this.prune(PRUNE_NORMAL, true);
    if (this.contextInfo().tokens < limit * threshold) return;
    const base = this.baseTokens(cfg);
    if (base >= limit * threshold) {
      // Folding the conversation cannot help when the prompt and tools alone fill the window.
      if (!this.smallWindowNoticed.has(s.id)) {
        this.smallWindowNoticed.add(s.id);
        this.emit({ type: 'error', kind: 'notice', message: `The system prompt and tool definitions take about ${Math.round(base / 1000)}k of the ${Math.round(limit / 1000)}k-token context window, so the conversation cannot be compacted. Raise the context size in Settings or disconnect MCP servers you do not need.` });
      }
      return;
    }
    await this.compact('auto', undefined, signal, cfg, client, model);
  }

  /** /compact between runs. Resolves with ok=false and a reason when nothing happened. */
  async compactNow(focus?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.running || this.compacting) return { ok: false, error: 'Wait for the current run to finish, then compact.' };
    if (this.session.messages.length < MIN_COMPACT_MESSAGES) return { ok: false, error: 'Nothing to compact yet.' };
    const cfg = this.sessionConfig();
    this.compacting = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    try {
      const { client, model, maxOutput } = isOllama(cfg) ? { client: null, model: ollamaOf(cfg).model, maxOutput: undefined } : makeClient(cfg);
      this.maxOutput = maxOutput;
      if (!model) throw new Error('No model selected. Open Settings and pick one.');
      const r = await this.compact('manual', focus, signal, cfg, client, model);
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'The summary could not be produced.' };
    } catch (err) {
      const message = errorMessage(err);
      this.emit({ type: 'compact_end', error: message });
      return { ok: false, error: message };
    } finally {
      this.compacting = false;
      this.abortController = null;
      this.emit({ type: 'session_changed', session: toMeta(this.session) });
    }
  }

  /**
   * Shortens old tool output (and old images) in place, through the store with reason 'prune'. Returns the tokens
   * saved; with `notice` the user sees a quiet note about it.
   */
  private prune(o: PruneOptions, notice: boolean): number {
    const s = this.session;
    const r = pruneMessages(s.messages, o);
    if (!r.results && !r.images) return 0;
    // The reported size of the last request covered the messages that just got shorter.
    const mark = s.lastPrompt;
    if (mark && mark.at <= s.messages.length) mark.tokens = Math.max(0, Math.round(mark.tokens - (estimateTokens(s.messages.slice(0, mark.at)) - estimateTokens(r.messages.slice(0, mark.at))) * this.estimateScale));
    this.store.replaceAll(s, r.messages, 'prune');
    this.store.save(s, false);
    if (notice) {
      const images = r.images ? ` and ${r.images} old image${r.images === 1 ? '' : 's'}` : '';
      this.emit({ type: 'error', kind: 'notice', message: `Cleared ${formatTokens(r.saved)} tokens of old tool output${images} to save context.` });
    }
    this.emitContext();
    return r.saved;
  }

  /**
   * The compaction pipeline: prune, then summarise everything before a verbatim tail. When the summary fails or is
   * not smaller, and the session is over the threshold (or `force`: the provider said the request is too long),
   * prune harder, then drop the oldest messages. Emits compact_start / compact_end around a summary attempt.
   * `ok` is true when the conversation was folded or, failing that, made small enough.
   */
  private async compact(
    reason: 'auto' | 'manual',
    focus: string | undefined,
    signal: AbortSignal,
    cfg: AppConfig,
    client: OpenAI | null,
    model: string,
    opts: { force?: boolean } = {},
  ): Promise<{ ok: boolean; info?: CompactionInfo; error?: string }> {
    const s = this.session;
    const limit = contextLimit(cfg);
    const over = () => opts.force === true || this.contextInfo().tokens >= limit * compactThreshold(cfg);
    const before = this.contextInfo().tokens;
    const pruned = cfg.pruneToolResults !== false ? this.prune(PRUNE_NORMAL, true) : 0;
    const tail = limit * TAIL_FRACTION;
    let cut = this.cutFor(tail, limit);
    // /compact between runs has no request in progress. When nothing precedes the last request (one long turn that
    // has finished), the whole conversation is folded, and the brief carries that request word for word.
    // (With an earlier brief in front there is only that brief to fold, which gains nothing.)
    if (!cut && reason === 'manual' && !this.running && !isCompactPreamble(s.messages[0]) && s.messages.some((m) => m.role === 'assistant')) cut = s.messages.length;
    if (!cut && over()) {
      // The last turn alone is too big. Shortening its older tool output keeps the most (the heads stay) without a
      // model call; only if that is not enough is the start of the turn folded, with the request kept verbatim.
      if (cfg.pruneToolResults !== false) {
        const cleared = this.prune(PRUNE_HARD, false);
        if (cleared > 0 && !over()) {
          this.emit({ type: 'error', kind: 'notice', message: `Cleared ${formatTokens(cleared)} tokens of old tool output in the current turn to stay inside the context window.` });
          return { ok: true };
        }
      }
      cut = findCut(s.messages, tail, { insideTurn: true });
    }
    // A summary failed earlier in this run, or one was just made and the conversation has hardly grown: no new attempt.
    const recent = this.compactedAt >= 0 && s.messages.length < this.compactedAt + 4;
    const trySummary = cut > 0 && !(reason === 'auto' && (this.autoCompactFailed || recent));
    let error: string | undefined;
    if (trySummary) {
      // PreCompact: a hook may block the summary, and what it prints is instructions for it.
      const pre = await this.fireHook('PreCompact', { trigger: reason, custom_instructions: focus ?? '' }, { match: [reason], signal });
      if (pre?.block) {
        const message = `A PreCompact hook blocked the compaction: ${plainReason(pre.block)}`;
        this.emit({ type: 'error', kind: 'notice', message });
        if (reason === 'auto') this.autoCompactFailed = true;
        return { ok: false, error: message };
      }
      const instructions = [focus?.trim(), ...(pre?.context ?? [])].filter(Boolean).join('\n\n') || undefined;
      this.emit({ type: 'compact_start', reason });
      try {
        const folded = s.messages.slice(0, cut);
        const summary = await this.summarize(cfg, client, model, folded, instructions, signal);
        if (signal.aborted) throw new Error('Compaction was stopped.');
        const brief = compactedPreamble(summary, filesTouched(folded), this.requestToCarry(folded));
        if (estimateMessageTokens({ role: 'user', content: brief }) >= estimateTokens(folded)) throw new Error('The summary was not smaller than the messages it would replace.');
        const info = this.fold(cut, brief, summary, { reason, before, pruned, stage: 'summary' });
        await this.fireHook('PostCompact', { trigger: reason, compact_summary: summary }, { match: [reason] });
        return { ok: true, info };
      } catch (err) {
        error = signal.aborted ? 'Compaction was stopped.' : errorMessage(err);
        if (reason === 'auto') this.autoCompactFailed = true;
        if (signal.aborted || !over()) {
          this.emit({ type: 'compact_end', error });
          return { ok: false, error };
        }
        this.emit({ type: 'compact_end' });
      }
    } else if (!cut) error = 'Nothing to compact yet.';
    if (!over()) return pruned > 0 ? { ok: true } : { ok: false, error: error ?? 'Nothing to compact yet.' };
    // Never leave the session over the limit: shorten every old tool result, then drop the oldest messages.
    const why = trySummary && error ? `The summary could not be produced (${error.replace(/\.$/, '')})` : this.autoCompactFailed ? 'A summary could not be produced earlier in this run' : 'Nothing could be summarised';
    const hard = cfg.pruneToolResults !== false ? this.prune(PRUNE_HARD, false) : 0;
    if (hard > 0 && !over()) {
      this.emit({ type: 'error', kind: 'notice', message: `${why}, so old tool output was shortened further instead (${formatTokens(hard)} tokens cleared).` });
      return { ok: true };
    }
    let dropAt = this.cutFor(tail, limit);
    if (!dropAt) dropAt = findCut(s.messages, tail, { insideTurn: true });
    const dropped = s.messages.slice(0, dropAt);
    const count = dropped.filter((m) => !isCompactPreamble(m)).length;
    const note = droppedPreamble(count, filesTouched(dropped), this.requestToCarry(dropped));
    if (!dropAt || estimateMessageTokens({ role: 'user', content: note }) >= estimateTokens(dropped)) {
      // Told once until the conversation has grown: every turn of the run would end up here again.
      if (this.stuckAt < 0 || s.messages.length >= this.stuckAt + 4) {
        this.stuckAt = s.messages.length;
        this.emit({ type: 'error', kind: 'notice', message: `${why}, and nothing older is left to drop: the next request may not fit the context window. Raise the context size in Settings or start a new session.` });
      }
      return { ok: false, error: error ?? 'Nothing to compact yet.' };
    }
    const folded = dropped;
    const info = this.fold(dropAt, note, `${count} earlier message${count === 1 ? ' was' : 's were'} dropped because a summary could not be produced.`, { reason, before, pruned: pruned + hard, stage: 'dropped' });
    this.emit({ type: 'error', kind: 'notice', message: `${why}, so the ${count} oldest message${count === 1 ? ' was' : 's were'} dropped to stay inside the context window.` });
    return { ok: true, info };
  }

  /**
   * The cut for a tail of about `tail` tokens; when that leaves too little before it to be worth a brief (a long
   * answer just before the last request fills the tail), keep only the last request onward instead.
   */
  private cutFor(tail: number, limit: number): number {
    const msgs = this.session.messages;
    const cut = findCut(msgs, tail);
    const least = findCut(msgs, 0);
    if (least > cut && estimateTokens(msgs.slice(0, cut)) < limit * 0.1) return least;
    return cut;
  }

  /**
   * The user's latest request, when `folded` (the start of the conversation) takes it away from the kept part: its
   * text, or the verbatim copy an earlier brief carried. The new brief keeps it word for word.
   */
  private requestToCarry(folded: Msg[]): string | undefined {
    const all = this.session.messages;
    const latest = lastUserIndex(all);
    if (latest >= folded.length) return undefined; // the request is in the kept part
    if (latest >= 0) {
      const c = all[latest].content;
      if (typeof c === 'string') return c;
      return Array.isArray(c) ? c.map((p) => ('text' in p ? p.text : '')).join('\n') : undefined;
    }
    return carriedRequest(folded.find(isCompactPreamble));
  }

  /**
   * Replaces messages[0..cut) by the brief, keeps the rest word for word, shifts the checkpoints that point into the
   * kept part and records the compaction (with the folded messages, so the transcript still shows them).
   */
  private fold(cut: number, brief: string, summary: string, o: { reason: 'auto' | 'manual'; before: number; pruned: number; stage: 'summary' | 'dropped' }): CompactionInfo {
    const s = this.session;
    const folded = s.messages.slice(0, cut);
    const kept = s.messages.slice(cut);
    this.store.replaceAll(s, [{ role: 'user', content: brief }, ...kept], 'compaction');
    s.lastPrompt = undefined;
    // Checkpoints in the kept part move with it (the brief takes index 0); earlier ones cannot be rewound to any more.
    const turns: Turn[] = [];
    for (const t of s.turns ?? []) {
      if (t.at < cut) continue;
      t.at = t.at - cut + 1;
      turns.push(t);
    }
    s.turns = turns;
    if (this.currentTurn && !turns.includes(this.currentTurn)) this.currentTurn = null;
    const info: CompactionInfo = {
      id: randomUUID(),
      createdAt: Date.now(),
      reason: o.reason,
      tokensBefore: o.before,
      tokensAfter: this.contextInfo().tokens,
      summary,
      messages: folded.filter((m) => !isCompactPreamble(m)).length,
      kept: kept.length,
      stage: o.stage,
    };
    if (o.pruned > 0) info.pruned = o.pruned;
    s.compactions ??= [];
    s.compactions.push({ ...info, folded });
    this.compactedAt = s.messages.length;
    this.store.save(s, false);
    this.emit({ type: 'compact_end', compaction: info });
    this.emitContext();
    return info;
  }

  private async summarize(cfg: AppConfig, client: OpenAI | null, model: string, folded: Msg[], focus: string | undefined, signal: AbortSignal): Promise<string> {
    const limit = contextLimit(cfg);
    const plan = latestPlan(this.session);
    // Words, not tokens: about three quarters of a token each; the brief has to stay well under what it replaces.
    const maxWords = Math.round(Math.min(summaryMaxTokens(limit), estimateTokens(folded) * 0.5) * 0.75);
    const extras = { focus, maxWords, tasks: this.session.tasks, plan: plan ? { title: plan.title, status: plan.status } : undefined };
    const maxTokens = summaryMaxTokens(limit);
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(SUMMARY_TIMEOUT_MS)]);
    const ask = async (budget: number): Promise<string> => {
      const messages = summaryRequest(folded, extras, budget);
      if (!client) {
        const call = (think: boolean | undefined) =>
          ollamaComplete({
            baseURL: ollamaOf(cfg).baseURL,
            model,
            messages,
            think,
            // num_ctx matches the agent's requests so Ollama keeps the model loaded as it is.
            options: { num_ctx: contextSize(ollamaOf(cfg).numCtx), num_predict: maxTokens, temperature: 0.2 },
            signal: timeout,
          });
        try {
          return await call(false);
        } catch (err) {
          // Models without a thinking switch reject the think field.
          if (timeout.aborted || !/think/i.test(errorMessage(err))) throw err;
          return await call(undefined);
        }
      }
      const res = await client.chat.completions.create({ model, messages, max_tokens: maxTokens, stream: false }, { signal: timeout, maxRetries: 1 });
      return res.choices?.[0]?.message?.content ?? '';
    };
    const budget = summaryBudgetChars(limit);
    let raw: string;
    try {
      raw = await ask(budget);
    } catch (err) {
      // The summary request itself did not fit (the estimate was off for this model): once more with half the transcript.
      if (timeout.aborted || !isContextLengthError(err)) throw err;
      raw = await ask(Math.floor(budget / 2));
    }
    const summary = cleanSummary(raw);
    if (summary.length < 40) throw new Error('The model returned no usable summary.');
    return summary;
  }

  /** Queues a message while a run is in progress; it is handed to the model before its next turn. */
  enqueue(text: string, attachments: ImageAttachment[] = [], opts: SendOptions = {}): QueuedMessage {
    if (!this.running) throw new Error('No run is in progress; send the message normally.');
    const m: QueuedMessage = { id: randomUUID(), text, attachments, createdAt: Date.now() };
    if (opts.origin && opts.origin !== 'queue' && opts.origin !== 'user') m.origin = opts.origin;
    if (opts.from) m.from = opts.from;
    this.queued.push(m);
    return m;
  }

  unqueue(id: string): boolean {
    const i = this.queued.findIndex((m) => m.id === id);
    if (i < 0) return false;
    this.queued.splice(i, 1);
    return true;
  }

  queue(): QueuedMessage[] {
    return this.queued.map((m) => ({ ...m, attachments: [...m.attachments] }));
  }

  /**
   * Moves queued messages into the conversation (in order), each past the UserPromptSubmit hooks. Returns true when
   * any was delivered.
   */
  private async drainQueue(skills: Skill[]): Promise<boolean> {
    if (!this.queued.length) return false;
    const batch = this.queued.splice(0);
    const cwd = this.cwd();
    let delivered = false;
    for (const m of batch) {
      const accepted = await this.promptHooks(m.text);
      if (!accepted.ok) {
        this.emit({ type: 'queue_dropped', id: m.id });
        continue;
      }
      const { content } = expandSlashCommand(expandMentions(m.text, cwd).content, skills);
      const origin = m.origin ?? 'queue';
      this.startTurn(m.text, origin, m.from);
      this.store.append(this.session, userMessage(content, m.attachments));
      this.addHookNote('UserPromptSubmit', accepted.context);
      this.emit({ type: 'queue_delivered', id: m.id });
      this.emitUserMessage(m.text, m.attachments.length, origin, m.from);
      delivered = true;
    }
    return delivered;
  }

  /** The run ended with messages still queued: hand them back to the renderer. */
  private dropQueue(): void {
    const left = this.queued.splice(0);
    for (const m of left) this.emit({ type: 'queue_dropped', id: m.id });
  }

  /** user_message for the message just added; `turn` is its checkpoint. */
  private emitUserMessage(text: string, images: number, origin: MessageOrigin, from?: string): void {
    const turns = this.session.turns ?? [];
    const ev: Extract<AgentEvent, { type: 'user_message' }> = { type: 'user_message', text, images, origin };
    if (turns.length) ev.turn = turns.length - 1;
    if (from) ev.from = from;
    this.emit(ev);
  }

  /** Opens a checkpoint for the user message about to be pushed; file changes until the next one are recorded on it. */
  private startTurn(text: string, origin: MessageOrigin = 'user', from?: string): void {
    const s = this.session;
    s.turns ??= [];
    const turn: Turn = { at: s.messages.length, createdAt: Date.now(), text, files: {} };
    if (origin !== 'user') turn.origin = origin;
    if (from) turn.from = from;
    if (s.tasks?.length) turn.tasks = structuredClone(s.tasks);
    s.turns.push(turn);
    this.currentTurn = turn;
  }

  /** update_tasks: keep the list on the session and show it. */
  private setTasks(tasks: TaskItem[]): void {
    this.session.tasks = tasks.length ? tasks : undefined;
    this.store.save(this.session, false);
    this.emit({ type: 'tasks_updated', tasks });
  }

  /** create_artifact: store it, tell the renderer, and show it in the browser pane. */
  private saveArtifact(input: ArtifactInput): { info: ArtifactInfo; action: 'created' | 'updated' } {
    const r = this.artifacts.save(this.session, input);
    this.store.save(this.session, false);
    this.emit({ type: 'artifact', artifact: r.info, action: r.action });
    // The pane belongs to the session on screen: a background session's artifact is stored and waits for its card.
    if (!this.isForeground()) return r;
    const b = this.browser as { navigate?: (url: string) => Promise<string> };
    if (typeof b.navigate === 'function') b.navigate(r.info.url).catch((err: unknown) => console.warn('[artifact] could not open in the browser pane:', errorMessage(err)));
    return r;
  }

  /**
   * Make sure every tool call of the last assistant turn has a tool result, so the next request is well-formed.
   * A stop between two calls of the same turn leaves the later ones unanswered.
   */
  private repairTail(): void {
    const msgs = this.session.messages;
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role !== 'assistant') i--;
    const last = msgs[i];
    if (!last || last.role !== 'assistant' || !last.tool_calls?.length) return;
    const answered = new Set(msgs.slice(i + 1).flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : [])));
    for (const call of last.tool_calls) {
      if (!answered.has(call.id)) this.store.append(this.session, { role: 'tool', tool_call_id: call.id, content: 'Tool call was interrupted before it produced a result.' });
    }
  }

  /**
   * Gives the session a short model-generated title after a completed run. The caller does not await it and
   * only logs failures. `session` is the run's session, which may no longer be the current one when this ends.
   */
  private async generateSessionTitle(session: Session): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.autoTitles || session.titleLocked || this.titleAttempts.has(session.id)) return;
    const prompt = titlePrompt(session);
    if (!prompt) return;
    this.titleAttempts.add(session.id);
    const title = await generateTitle(cfg, prompt);
    // The user may have renamed or deleted the session, or turned the feature off, while the model answered.
    if (!title || title === session.title || session.titleLocked) return;
    if (this.store.get(session.id) !== session || !this.getConfig().autoTitles) return;
    session.title = title;
    session.titleLocked = true;
    this.store.save(session, false);
    this.emit({ type: 'session_changed', session: toMeta(session) });
  }

  private async complete(
    cfg: AppConfig,
    client: OpenAI | null,
    model: string,
    history: Msg[],
    specs: ToolSpec[],
    signal: AbortSignal,
    turn: number,
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    if (!client) {
      const ol = ollamaOf(cfg);
      const chat = (tools: ToolSpec[]) =>
        ollamaChat({
          baseURL: ol.baseURL,
          model,
          numCtx: contextSize(ol.numCtx),
          think: ol.think ?? 'auto',
          messages: history,
          tools,
          signal,
          turn,
          onText: (t) => this.emit({ type: 'text_delta', text: t }),
          onThinking: (t) => this.emit({ type: 'thinking_delta', text: t }),
          onWarning: (message) => this.emit({ type: 'error', message }),
          onUsage: (usage) => this.reportUsage(usage),
        });
      try {
        return await chat(specs);
      } catch (err) {
        // An Ollama too old to report capabilities only tells us here: retry once as a plain chat.
        if (!specs.length || signal.aborted || !/does not support tools/i.test(errorMessage(err))) throw err;
        this.toolSupport.set(`${ol.baseURL}|${model}`, false);
        this.emit({ type: 'error', kind: 'notice', message: noToolsNotice(model) });
        return chat([]);
      }
    }
    let emitted = false;
    const onEmit = () => (emitted = true);
    const endpoint = `${client.baseURL}|${model}`;
    for (;;) {
      const includeUsage = !this.noStreamUsage.has(endpoint);
      try {
        return await this.completeStreaming(client, model, history, specs, signal, turn, includeUsage, onEmit);
      } catch (err) {
        if (signal.aborted || emitted || isContextLengthError(err)) throw err;
        // A gateway or provider that rejects stream_options still streams without it.
        if (includeUsage && /stream_options|include_usage/i.test(errorMessage(err))) {
          this.noStreamUsage.add(endpoint);
          continue;
        }
        // Some gateways/models reject streaming with tools; fall back to a single request
        // as long as nothing has been shown to the user yet.
        console.warn('[agent] streaming failed, retrying without streaming:', errorMessage(err));
        return this.completeOnce(client, model, history, specs, signal, turn);
      }
    }
  }

  private async completeStreaming(
    client: OpenAI,
    model: string,
    history: Msg[],
    specs: ToolSpec[],
    signal: AbortSignal,
    turn: number,
    includeUsage: boolean,
    onEmit: () => void,
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const stream = await client.chat.completions.create(
      { model, messages: history, tools: specs, stream: true, stream_options: includeUsage ? { include_usage: true } : undefined, ...(this.maxOutput ? { max_tokens: this.maxOutput } : {}) },
      { signal },
    );
    let text = '';
    const calls: ToolCall[] = [];
    const byId = new Map<string, ToolCall>();
    const byIndex = new Map<number, ToolCall>();
    let usage: Usage | null = null;

    for await (const chunk of stream) {
      // With include_usage the counts arrive on a final chunk whose choices array is empty.
      if (chunk.usage) usage = mergeUsage(usage, chunk.usage);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      const reasoning = (delta as { reasoning_content?: string; reasoning?: string }).reasoning_content ?? (delta as { reasoning?: string }).reasoning;
      if (reasoning) this.emit({ type: 'thinking_delta', text: reasoning });
      if (delta.content) {
        text += delta.content;
        onEmit();
        this.emit({ type: 'text_delta', text: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        let call: ToolCall;
        const known = tc.id ? byId.get(tc.id) : undefined;
        if (known) call = known;
        else if (tc.id) {
          call = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          calls.push(call);
          byId.set(tc.id, call);
          byIndex.set(tc.index ?? calls.length - 1, call);
        } else {
          const existing = byIndex.get(tc.index ?? 0) ?? calls[calls.length - 1];
          if (existing) call = existing;
          else {
            call = { id: '', type: 'function', function: { name: '', arguments: '' } };
            calls.push(call);
            byIndex.set(tc.index ?? 0, call);
          }
        }
        if (tc.function?.name) call.function.name += tc.function.name;
        const args = tc.function?.arguments as unknown;
        if (typeof args === 'string') call.function.arguments += args;
        else if (args && typeof args === 'object') call.function.arguments += JSON.stringify(args);
      }
    }
    calls.forEach((c, i) => {
      if (!c.id) c.id = `call_${turn}_${i}`;
    });
    if (usage) this.reportUsage(usage);
    return { text, toolCalls: calls };
  }

  private async completeOnce(
    client: OpenAI,
    model: string,
    history: Msg[],
    specs: ToolSpec[],
    signal: AbortSignal,
    turn: number,
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const res = await client.chat.completions.create({ model, messages: history, tools: specs, stream: false, ...(this.maxOutput ? { max_tokens: this.maxOutput } : {}) }, { signal });
    if (res.usage) this.reportUsage(mergeUsage(null, res.usage));
    const msg = res.choices?.[0]?.message;
    const text = msg?.content ?? '';
    if (text) this.emit({ type: 'text_delta', text });
    const toolCalls: ToolCall[] = [];
    (msg?.tool_calls ?? []).forEach((tc, i) => {
      if (tc.type !== 'function') return;
      const args = tc.function.arguments as unknown;
      toolCalls.push({
        id: tc.id || `call_${turn}_${i}`,
        type: 'function',
        function: { name: tc.function.name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
      });
    });
    return { text, toolCalls };
  }

  private async execTool(call: ToolCall, tools: Tool[], ctx: ToolContext): Promise<ToolResult> {
    const name = call.function.name;
    let args: unknown = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      this.emit({ type: 'tool_start', id: call.id, name, args: call.function.arguments });
      const content = `Error: arguments for ${name} were not valid JSON: ${truncate(call.function.arguments, 500)}`;
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: 0 });
      return { content };
    }
    if (name.startsWith('browser_') && !this.isForeground()) {
      this.emit({ type: 'tool_start', id: call.id, name, args });
      this.emit({ type: 'tool_end', id: call.id, name, result: BROWSER_BACKGROUND, ok: false, durationMs: 0 });
      return { content: BROWSER_BACKGROUND };
    }
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      this.emit({ type: 'tool_start', id: call.id, name, args });
      const content = `Error: unknown tool "${name}". Available tools: ${tools.map((t) => t.name).join(', ')}`;
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: 0 });
      return { content };
    }

    // PreToolUse: before the tool's own approval check. deny refuses the call, ask forces the card, allow skips it,
    // updatedInput replaces the arguments.
    const claudeName = claudeToolName(name);
    const names = toolMatchNames(name);
    const toolInput = () => claudeToolInput(name, args, ctx.cwd);
    const hookFields = () => ({ tool_name: claudeName, tool_input: toolInput(), tool_use_id: call.id, silo_tool_name: name, silo_tool_input: args });
    const pre = await this.fireHook('PreToolUse', hookFields(), { match: names, tool: { names, input: toolInput() }, signal: ctx.signal });
    if (pre?.updatedInput && !pre.block && pre.permission !== 'deny') args = nativeToolInput(name, pre.updatedInput);
    this.emit({ type: 'tool_start', id: call.id, name, args });
    if (pre?.block || pre?.permission === 'deny') {
      const content = pre.block ?? `PreToolUse:${claudeName} hook denied this tool call${pre.permissionReason ? `: ${pre.permissionReason}` : '.'}`;
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: 0 });
      this.emit({ type: 'error', kind: 'notice', message: `A PreToolUse hook blocked ${name}: ${pre.block ? plainReason(content) : pre.permissionReason || 'denied'}` });
      return { content };
    }
    const hookContext = pre?.context ?? [];
    let hookApproval: HookApproval = pre?.permission === 'allow' ? 'allow' : pre?.permission === 'ask' ? 'ask' : null;
    if (hookApproval === 'ask') {
      // The card comes up whatever the mode says; once answered, the tool's own check asks no more.
      const input = toolInput();
      const what = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : truncate(JSON.stringify(args ?? {}), 800);
      const answer = await this.ask(name, what, this.getConfig().permissionMode, pre?.permissionReason || 'a PreToolUse hook asks you to confirm this call', [], true);
      if (!answer.ok) {
        this.emit({ type: 'tool_end', id: call.id, name, result: answer.message, ok: false, durationMs: 0 });
        return { content: answer.message };
      }
      hookApproval = 'allow';
    }

    // durationMs covers the tool's own work: time spent waiting on an approval card is left out.
    let waited = 0;
    const timedCtx: ToolContext = {
      ...ctx,
      approve: async (toolName, detail, target, approveOpts) => {
        const askedAt = Date.now();
        try {
          return hookApproval === 'allow' ? await this.requestApproval(toolName, detail, target, approveOpts, true) : await ctx.approve(toolName, detail, target, approveOpts);
        } finally {
          waited += Date.now() - askedAt;
        }
      },
    };
    const started = Date.now();
    const elapsed = () => Math.max(0, Date.now() - started - waited);
    let result: ToolResult;
    try {
      result = await tool.run(args, timedCtx);
      result.content = truncate(result.content);
    } catch (err) {
      result = { content: `Error: ${errorMessage(err)}` };
    }
    const durationMs = elapsed();
    // The same rule the saved transcript applies when it is shown again (sessions.ts).
    const ok = !FAILED_RESULT.test(result.content);

    // PostToolUse / PostToolUseFailure: what they say reaches the model with the result.
    const extra: string[] = hookContext.length ? [`${HOOK_NOTE_PREFIX}context: PreToolUse]\n${hookContext.join('\n\n')}`] : [];
    const interrupted = result.content.startsWith('Tool call was interrupted') || !!ctx.signal?.aborted;
    const post = ok
      ? await this.fireHook('PostToolUse', { ...hookFields(), tool_response: result.content }, { match: names, tool: { names, input: toolInput() } })
      : await this.fireHook('PostToolUseFailure', { ...hookFields(), error: result.content, is_interrupt: interrupted }, { match: names, tool: { names, input: toolInput() } });
    const event = ok ? 'PostToolUse' : 'PostToolUseFailure';
    if (post?.block) {
      extra.push(post.block);
      this.emit({ type: 'error', kind: 'notice', message: `A ${event} hook flagged ${name}: ${plainReason(post.block)}` });
    }
    if (post?.context.length) extra.push(`${HOOK_NOTE_PREFIX}context: ${event}]\n${post.context.join('\n\n')}`);
    if (extra.length) result = { ...result, content: `${result.content}\n\n${extra.join('\n\n')}` };
    this.emit({ type: 'tool_end', id: call.id, name, result: result.content, ok, image: result.image, durationMs });
    return result;
  }
}
