import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { ContextBreakdown, ContextSlice } from '../shared/context';
import type { AgentEvent, AppConfig, ApprovalScope, ArtifactInfo, CheckVerdictWord, CompactionInfo, ContextInfo, ImageAttachment, MessageOrigin, PermissionMode, PlanInfo, QuestionAnswer, QueuedMessage, TaskItem, UserQuestion } from '../shared/types';
import { expandMentions } from './mentions';
import { effortOf, isOllama, makeClient, modelCapabilities, ollamaOf, resolveProvider } from './providers';
import { contextSize, ollamaComplete, type ToolCall, type Usage } from './ollama';
import { allGroupsUpFront, contextLimit, essentialToolsOnly } from './context-window';
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
  isContextNote,
  isSyntheticUser,
  lastContextNote,
  lastUserIndex,
  pruneMessages,
  scaleTo,
  summaryBudgetChars,
  summaryMaxTokens,
  summaryRequest,
  type PruneOptions,
} from './compact';
import { allTools, builtInToolNames, toSpec, type ApprovalResult, type ApproveOptions, type BrowserApproval, type SandboxPlan, type Tool, type ToolContext, type ToolResult } from './tools';
import { runShell } from './tools/shell';
import { deniedPorts, outputLines, probeSandbox, profileFor, realish, sandboxableFolder, sandboxHostNow, sandboxSettings } from './sandbox';
import { truncate } from './tools/types';
import { FOLDED_GROUPS_HEADING, GROUP_GUIDANCE, LOAD_TOOLS, TOOL_GROUPS, cleanGroups, groupsForMessage, isMcpGroup, isToolGroup, loadToolsTool, mcpGroupsForMessage, requestedGroups, type GroupId, type McpGroup } from './tools/groups';
import { cleanAnswers } from './tools/ask-user';
import type { BrowserController } from './browser';
import { expandSlashCommand, type Skill } from './skills';
import { clip, latestPlan, shownUserCount, toMeta, turnSnapshot, type Msg, type Session, type SessionStore, type Turn } from './sessions';
import { generateTitle, titlePrompt } from './titles';
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
import { contextNote, ESSENTIAL_NOTE, sessionContext, systemPrompt, systemPromptParts, userMessage, type PromptExtra } from './agent/prompt';
import { batchMarks, CACHE_EXPECT_MIN_TOKENS, CACHE_MISSES_TO_FALLBACK, CACHE_TTL_MS, COLD_BATCH_FROM, modelMessages, PRUNE_BUDGET, pruneSaving, resultsToPrune } from './agent/context-view';
import { errorMessage, providerErrorMessage } from './agent/errors';
import { complete, noToolsNotice, uniqueCallIds, usageOf, type CompletionHost, type RawUsage, type Reply } from './agent/complete';
import { callSource, chargeSession, type CallSource } from './cost';
import { isNativeAnthropic, THINKING_KEY } from './agent/anthropic';
import { CONTINUE_TEXT, CUT_CALL_TEXT, isCompleteJson, MAX_CONTINUATIONS, REFUSAL_NOTICE, REPEAT_STOP, REPEAT_STOP_NOTICE, REPEAT_WARN, REPEAT_WARNING, RepeatWatch } from './agent/turn-guards';
import { approvalLabels, CHECKED_BROWSER_CARDS, decideApproval, DENIED, type ApprovalDecision, type AutoLevel } from './agent/permissions';
import { answerText, forCheck, LearnedStore } from './agent/learned';
import { CLASSIFIER_TIMEOUT_MS, candidateRefused, classifierRequest, classifierTarget, isConnectionError, isModelRefusal, parseVerdict, runClassifier, type BrowserFacts, type ClassifiedAction, type ClassifierTarget, type Verdict } from './agent/classifier';
import { actionKey, actionLine, allowedNote, blockedResult, PAUSE_IN_A_ROW, PAUSE_TOTAL, UNAVAILABLE_REASON } from './agent/auto-rules';
import type { AutoBlock } from '../shared/auto-mode';
import { guardCommand, isReadOnlyCall, isReadOnlyCommand, judgedCommand } from './guard';
import { BASH_TOOLS, compileRules, deniedByRule, EDIT_TOOLS, ruleVerdict } from './agent/rules';
import { concurrencyLimit, runSchedule } from './agent/schedule';
import { RunTimer, setBuiltInToolNames, shortId, TimingLog, timingLogOn, type Finish, type Outcome, type PermissionPath, type PermissionProbe, type RunRecord, type ToolTimer, type TurnTimer } from './agent/perf';

// The tool names a timing record keeps (agent/perf.ts): the built-in ones
setBuiltInToolNames(builtInToolNames());

// The window size facts live in context-window.ts; re-exported because test/*.js loads them from here.
export { contextLimit, essentialToolsOnly } from './context-window';

/** The user turn that starts the build after a plan is approved. */
export const PLAN_APPROVED_TEXT = 'Plan approved. Implement it now, step by step. When done, summarise what changed.';

const SUMMARY_TIMEOUT_MS = 240_000;
/** How many times Stop hooks may send one run back to work (a hook that keeps blocking is stopped here) */
const MAX_STOP_CONTINUES = 8;
const MIN_COMPACT_MESSAGES = 2;

const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'terminal_run']);

/**
 * What answering an approval card changes besides the pending call: a mode switch, or a rule to save for the project
 * (kind 'site': a site's origin for AppConfig.browser.alwaysAllowed, saved on this Mac rather than for the project).
 */
export interface ApprovalOutcome {
  setMode?: PermissionMode;
  rule?: { kind: 'program' | 'reason' | 'edits' | 'mcp' | 'site'; values: string[] };
}

interface PendingApproval {
  resolve: (r: ApprovalResult) => void;
  name: string;
  programs: string[];
  reason: string | null;
  /** A tool's own question (ApproveOptions.custom): no "always" answers, except its own "for this session" one (sessionKey) */
  custom?: boolean;
  /** ApproveOptions.sessionKey: what "for this session" allows on a custom card */
  sessionKey?: string;
  /** A browser tool's card: what its answer allows (the site, or the sign-in page) */
  browser?: BrowserApproval;
  /** What Auto mode learns from the answer (agent/learned.ts): the tool, its target and the card's line */
  learn: { tool: string; key: string; line: string };
}

/** Browser cards a PreToolUse hook's "allow" does not skip: money and accounts are the user's, as in bypass mode. */
const USER_ONLY_CARDS = new Set(['purchase', 'account']);

/** What an answer concerned, for what Auto mode learns: the site, the MCP server, the programs, a tool's own key. */
function learnKey(name: string, programs: string[], browser?: BrowserApproval, sessionKey?: string): string {
  if (browser) return browser.site.origin;
  if (name.startsWith('mcp__')) return programs[0] ?? '';
  if (name === 'bash' || name === 'terminal_run') return programs.join(', ');
  return sessionKey ?? '';
}

/**
 * What a browser action Allow on its Auto mode block lets through once: the tool, the card, the site and the card's
 * first line. A page script also by its code: the Allow covers the script that was blocked, not another on that site.
 */
function browserActionKey(name: string, detail: string, b: BrowserApproval): string {
  const code = b.card === 'eval' ? (b.check?.code ?? '') : '';
  return actionKey(name, [b.card, b.site.origin, detail.split('\n')[0] ?? '', code].join('\u0000'));
}

/** What Auto mode's check is told about a browser card (classifier.ts): never the page's text or the model's reason. */
function browserFacts(detail: string, b: BrowserApproval): BrowserFacts {
  const kind = b.check?.kind === 'eval' || b.card === 'eval' ? 'page script' : b.check?.kind === 'act' || b.card === 'sensitive' ? 'act' : 'read';
  return {
    card: b.card,
    kind,
    site: b.site.display,
    siteKey: b.site.origin,
    ...(b.check?.url ? { url: b.check.url } : {}),
    ...(b.note ? { note: b.note } : {}),
    ...(b.reason ? { flag: b.reason } : {}),
    what: detail.split('\n')[0] ?? '',
    ...(b.check?.code !== undefined ? { code: b.check.code } : {}),
  };
}

/** What a call stopped while it waited gets back. */
const INTERRUPTED = 'Tool call was interrupted before it produced a result.';

/** Auto mode's state in one session (in memory: a new app session starts it afresh). */
interface AutoState {
  /** Blocks since the check last allowed an action, and in all */
  inARow: number;
  total: number;
  /** Too many blocks: actions that need the check show the approval card for the rest of the session */
  paused: boolean;
  /** The check's model answered at least once (so a later failure to reach it blocks instead of falling back) */
  reached: boolean;
  /** The check's model could not be reached before it ever answered: the rule guard decides until the next run */
  unavailable: boolean;
  /** The one-line notices already shown in this session */
  noticed: Set<string>;
}

/** The call an approval belongs to (its id and arguments), when it comes from a tool call, and its timing. */
interface CallRef {
  id: string;
  args: unknown;
  timing?: ToolTimer;
}

/** A shell result that ran out of time (tools/shell.ts), for a timing record's outcome. */
const TIMED_OUT = /killed \(timeout after \d+ ms\)/;

/** The built-in tools (the reads below are shared only when the tool is the built-in one, not a registered namesake) */
const BUILT_IN_TOOLS: ReadonlySet<Tool> = new Set([...allTools('ask'), ...allTools('plan'), ...allTools('ask', true), ...allTools('plan', true)]);
/** Built-in tools that only read, safe to run alongside each other (Agent.shareable; bash is judged per command) */
const SHARED_READS = new Set(['read_file', 'grep', 'glob', 'list_directory', 'web_fetch']);

/** A tool call ready to run (Agent.prepareTool): its final arguments, its run, and what it gets when a stop comes first. */
interface PreparedTool {
  args: unknown;
  finish(): Promise<ToolResult>;
  skip(): ToolResult;
}

/** A call's result as the run loop stores it; `quiet`: a load_tools result or a cut call, stored as it is. */
interface CallResult {
  result: ToolResult;
  quiet?: boolean;
}

/** A call's arguments as the model sent them, or null when they are not JSON. */
function parseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
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
  /** Extra system-prompt text (app.prompt sections, already joined): those every session shares, or (part 'session') this session's own */
  prompt?: (info: { cwd: string; mode: PermissionMode; sessionId: string; essential?: boolean; restricted?: boolean; part?: 'shared' | 'session'; groups?: readonly string[]; onlyGroup?: string }) => string;
  /** The hook engine (default: the app's 'hooks' service; none in bare tests) */
  hooks?: HookEngine | null;
  /** The clock for the cache bookkeeping (default Date.now; tests pass their own) */
  now?: () => number;
  /** Where Auto mode keeps what it learns from the user's answers (default: the app's 'auto-learned' service; none in bare tests) */
  learned?: LearnedStore | null;
}

/**
 * What a session has seen of the provider's prompt cache, in memory only (a reloaded session starts from the provider
 * type's assumption). `lastAt` is when the last main model call answered; `storedAt` the stored session's last activity
 * when this process first ran it.
 */
interface CacheSeen {
  caching: boolean;
  misses: number;
  lastAt?: number;
  storedAt?: number;
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
  /** Per session: browser sites (policy.ts Site.key) the user allowed for the rest of the session, or always. */
  private allowedSites = new Map<string, Set<string>>();
  /** Per session: sign-in pages (signInPageKey) the user allowed an act on; their password field asks no more. */
  private signInPages = new Map<string, Set<string>>();
  /** Per session: custom actions (ApproveOptions.sessionKey, e.g. messages to one session) the user allowed for the rest of the session. */
  private allowedCustom = new Map<string, Set<string>>();
  /** Per session: Auto mode's counters and pause (see AutoState) */
  private autoStates = new Map<string, AutoState>();
  /** Per session: the actions Auto mode blocked in this app session, by call id, with the key Allow lets through once */
  private autoBlocks = new Map<string, Map<string, { block: AutoBlock; key: string; learn: { tool: string; key: string; line: string } }>>();
  /** Per session: blocked actions the user allowed (actionKey); each runs once without the check */
  private autoAllowed = new Map<string, Set<string>>();
  /** Per session: notes for the model (an allowed block) waiting for the run's next model call */
  private autoNotes = new Map<string, string[]>();
  /** Sessions whose shell sandbox profile failed (sandbox-exec refused it): their commands are decided as without it */
  private sandboxOff = new Set<string>();
  /** Per session and profile: what the login profile prints in the sandbox with no command (ignored when looking for a block) */
  private sandboxBaselines = new Map<string, Promise<string[]>>();
  /** Tokens the tool specs take on every request (measured at the start of each run). */
  private specTokens = 2500;
  /** Usage of the most recent model call, for the context estimate. */
  private lastUsage: Usage | null = null;
  /** The model and API of the run's (or /compact's) own calls, which their usage is charged to (cost.ts) */
  private costSource: CallSource | null = null;
  /** Per session: whether its provider was seen caching (cachesPrefix, noteCache) */
  private cacheSeen = new Map<string, CacheSeen>();
  /** When the current main model call was sent */
  private requestAt = 0;
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
  /** When this run began, and the turn whose working time is being counted (its key in Session.turnTimes) */
  private runStartedAt = 0;
  private turnClock: { at: number; startedAt: number } | null = null;
  running = false;
  /** True while /compact runs outside a run (stop() cancels it). */
  compacting = false;
  /** SessionStart fired for this session in this app session (SessionEnd fires only then) */
  private sessionStarted = false;
  /** A hook said continue: false; the run stops after the current step */
  private hookStop: string | null = null;
  /** Calls whose arguments hold a secret, by call id: the arguments as stored and shown (see Tool.shownArgs) */
  private shownArgs = new Map<string, Record<string, unknown>>();
  /** Timing (agent/perf.ts): this session's short random id, the run being timed, its current turn, the last run's record */
  private readonly timingId = shortId();
  private runTimer: RunTimer | null = null;
  private turnTimer: TurnTimer | null = null;
  private lastRun: RunRecord | null = null;
  private static timingLogs = new Map<string, TimingLog>();
  /** One approval card or safety check at a time (inLane) */
  private lane: Promise<void> = Promise.resolve();

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
  /** A queued message the user chose to send now (sendNow): the run is being cut, and this message starts the next */
  private sendingNow: QueuedMessage | null = null;
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

  /**
   * The app's prompt sections: those every session shares, and this session's own (its name, its parent), which go at
   * the end of the prompt so that its start stays the same from session to session.
   */
  private promptExtra(cfg: AppConfig): PromptExtra {
    if (!this.opts.prompt) return { shared: '', session: '' };
    try {
      const base = { cwd: cfg.workingDirectory, mode: cfg.permissionMode, sessionId: this.session.id };
      const restricted = Boolean(this.ownTools());
      const essential = !restricted && essentialToolsOnly(cfg);
      // A tool group's sections come with its load, not in the system prompt (unless every group is offered up front)
      const groups = allGroupsUpFront(cfg) ? {} : { groups: [] };
      const info = restricted ? { ...base, restricted } : { ...base, essential, ...groups };
      const text = this.opts.prompt({ ...info, part: 'shared' });
      const session = this.opts.prompt({ ...info, part: 'session' });
      const shared = essential ? `${text}${text ? '\n\n' : ''}${ESSENTIAL_NOTE}` : text;
      // A prompt function that does not know parts returns everything both times: keep it once
      return { shared, session: session === text ? '' : session };
    } catch (err) {
      console.warn('[agent] a prompt section failed:', errorMessage(err));
      return { shared: '', session: '' };
    }
  }

  private prompt(cfg: AppConfig, skills: Skill[]): string {
    return systemPrompt(cfg, skills, this.mcp, this.promptExtra(cfg), this.ownToolNames(cfg), this.promptGroups(cfg));
  }

  /** What this session's context note says now (agent/prompt.ts sessionContext). */
  private contextState(cfg: AppConfig): string {
    return sessionContext(cfg, this.promptExtra(cfg), Boolean(this.ownTools()));
  }

  /**
   * Before a model call: appends a context note when what it says (the mode, folder, date, the session's name and
   * parent) differs from the newest one in the conversation, which is the case on the first call, after a change, and
   * after a compaction or a rewind took the last one away. Earlier notes stay as they are, so the prefix does too.
   */
  private addContextNote(cfg: AppConfig): void {
    const note = contextNote(this.contextState(cfg), lastContextNote(this.session.messages));
    if (note) this.store.append(this.session, { role: 'user', content: note });
  }

  /** The groups the prompt names as loadable (undefined: every group is offered up front, or none is a group here). */
  private promptGroups(cfg: AppConfig): GroupId[] | undefined {
    if (this.ownTools() || allGroupsUpFront(cfg)) return undefined;
    return this.loadableGroups(cfg);
  }

  /** The names of the tools a session with a tool set of its own really has (those it names that exist). */
  private ownToolNames(cfg: AppConfig): string[] | undefined {
    return this.ownTools() ? this.toolsFor(cfg).map((t) => t.name) : undefined;
  }

  /**
   * The tools a run in this mode may use: built-in, registered and MCP ones (plan mode: the read-only ones), without
   * the optional ones when the tool set is trimmed. A session with a tool set of its own gets exactly the built-in and
   * registered tools it names, in every mode, and never an MCP tool; scoped tools are offered to no other session.
   * Of these, a request offers those of the tool groups the session has loaded (toolsFor).
   */
  private toolPool(cfg: AppConfig): Tool[] {
    const registered = this.opts.tools?.() ?? [];
    const own = this.ownTools();
    if (own) {
      const sb = this.sandboxOffered(cfg);
      const pool = [...allTools('ask', sb), ...allTools('plan', sb), ...registered];
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
    return [...allTools(cfg.permissionMode, this.sandboxOffered(cfg)), ...(plan ? extraTools.filter((t) => t.readOnly) : extraTools), ...(plan ? mcpTools.filter((t) => t.mcp?.readOnly) : mcpTools)];
  }

  /** The tool groups this session has loaded (Session.toolGroups), in the order it loaded them. */
  private loadedGroups(): GroupId[] {
    return cleanGroups(this.session.toolGroups ?? []);
  }

  /**
   * A tool's group, when it is one the tool may belong to: an MCP tool only its own server's (mcp:…), any other tool
   * only a built-in group. So no tool can load, or be loaded with, a server it does not come from.
   */
  private groupOf(t: Tool): GroupId | undefined {
    const g = t.group;
    if (!g) return undefined;
    return t.mcp ? (isMcpGroup(g) ? g : undefined) : isToolGroup(g) ? g : undefined;
  }

  /**
   * The groups this session loads when it needs them, loaded yet or not: those with tools in the pool, in their fixed
   * order. None when every group is offered up front (AppConfig.toolSet 'all') or the session has a tool set of its own.
   */
  private loadableGroups(cfg: AppConfig, pool: Tool[] = this.toolPool(cfg)): GroupId[] {
    if (this.ownTools() || allGroupsUpFront(cfg)) return [];
    const out: GroupId[] = TOOL_GROUPS.filter((g) => pool.some((t) => this.groupOf(t) === g));
    // Then each MCP server with tools in the pool (connected, and in plan mode with a read-only tool), in its order
    for (const t of pool) {
      const g = this.groupOf(t);
      if (g && isMcpGroup(g) && !out.includes(g)) out.push(g);
    }
    return out;
  }

  /**
   * The tools a request offers, append-only for prompt caching: the core tools of the pool with load_tools after the
   * built-in ones (its definition the same all session long), then each loaded group's tools in the order the session
   * loaded them. A load adds at the end; nothing else changes the list. On Anthropic's native path every loadable
   * group's tools come after load_tools from the first request, in the groups' fixed order, loaded or not: that path
   * sends them deferred and a load references them (agent/anthropic.ts), so the list never changes at all.
   */
  private toolsFor(cfg: AppConfig): Tool[] {
    const pool = this.toolPool(cfg);
    const loadable = this.loadableGroups(cfg, pool);
    if (!loadable.length) return pool;
    const offered = pool.filter((t) => !this.groupOf(t));
    const builtIn = new Set(allTools(cfg.permissionMode, this.sandboxOffered(cfg)));
    let at = 0;
    offered.forEach((t, i) => {
      if (builtIn.has(t)) at = i + 1;
    });
    offered.splice(at, 0, loadToolsTool(loadable));
    const groups = this.defersGroups(cfg) ? loadable : this.loadedGroups().filter((g) => loadable.includes(g));
    for (const g of groups) offered.push(...pool.filter((t) => this.groupOf(t) === g));
    return offered;
  }

  /** Anthropic's native path, which sends the groups' tools deferred from the first request (see toolsFor). */
  private defersGroups(cfg: AppConfig): boolean {
    try {
      return isNativeAnthropic(resolveProvider(cfg));
    } catch {
      return false;
    }
  }

  /**
   * Loads tool groups into this session: their tools are offered from the next request on, for the rest of the
   * session (saved with it), after those it had. Returns those that were not loaded before; groups the session cannot
   * use are left out.
   */
  private loadGroups(cfg: AppConfig, groups: readonly GroupId[], pool: Tool[] = this.toolPool(cfg)): GroupId[] {
    const loadable = this.loadableGroups(cfg, pool);
    const loaded = this.loadedGroups();
    const fresh = cleanGroups(groups).filter((g) => loadable.includes(g) && !loaded.includes(g));
    if (fresh.length) this.session.toolGroups = [...loaded, ...fresh];
    return fresh;
  }

  /**
   * What a group's load tells the model: its tools, and what it needs to know about them (the browser's rules, the
   * registered prompt sections of the group), which a system prompt that never changes cannot carry.
   */
  private groupLoadText(cfg: AppConfig, group: GroupId, pool: Tool[]): string {
    const names = pool.filter((t) => this.groupOf(t) === group).map((t) => t.name);
    const parts = [`Loaded ${group}: ${names.join(', ')}.`];
    // An MCP server's load says nothing of its own: its tools' descriptions are the server's text, in their definitions
    if (isMcpGroup(group)) return parts[0];
    if (GROUP_GUIDANCE[group]) parts.push(GROUP_GUIDANCE[group]!);
    if (this.opts.prompt) {
      try {
        const own = this.opts.prompt({ cwd: cfg.workingDirectory, mode: cfg.permissionMode, sessionId: this.session.id, essential: essentialToolsOnly(cfg), onlyGroup: group });
        if (own.trim()) parts.push(own.trim());
      } catch (err) {
        console.warn('[agent] a prompt section failed:', errorMessage(err));
      }
    }
    return parts.join('\n');
  }

  /** A load_tools call the agent makes itself, for a load the model did not ask for (see loadForCalls, run). */
  private syntheticLoad(groups: GroupId[]): ToolCall {
    return { id: `call_load_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: LOAD_TOOLS, arguments: JSON.stringify({ groups }) } };
  }

  /**
   * Before a reply's calls run: loads the groups they ask for (load_tools) and those they need (a tool called by name
   * before its group was loaded: an old session, a model that knows the name), which then runs as usual. Returns
   * load_tools' results by call id, and the groups loaded for calls by name, which get a load_tools call of the
   * agent's own (so their result, like every load's, is in the conversation). The run loop stores the results
   * without a tool row, an approval or hooks.
   */
  private loadForCalls(calls: ToolCall[], cfg: AppConfig): { results: Map<string, string>; implied: GroupId[] } {
    const results = new Map<string, string>();
    const implied: GroupId[] = [];
    if (this.ownTools()) return { results, implied };
    const pool = this.toolPool(cfg);
    for (const call of calls) {
      if (call.function.name !== LOAD_TOOLS) continue;
      let args: unknown = call.function.arguments;
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* a bare list of names is read as it is */
      }
      results.set(call.id, this.loadToolsResult(cfg, pool, requestedGroups(args)));
    }
    for (const call of calls) {
      const hit = call.function.name === LOAD_TOOLS ? undefined : pool.find((t) => t.name === call.function.name);
      const group = hit && this.groupOf(hit);
      if (group) implied.push(...this.loadGroups(cfg, [group], pool));
    }
    return { results, implied };
  }

  /** What a load_tools call gets back: each group it loaded with its tools and guidance, and any it could not load. */
  private loadToolsResult(cfg: AppConfig, pool: Tool[], asked: string[]): string {
    const known = this.loadableGroups(cfg, pool);
    if (!asked.length) return `Error: name the groups to load (${known.join(', ') || 'none here'}).`;
    const out: string[] = [];
    const had: string[] = [];
    const missing: string[] = [];
    const servers: string[] = [];
    for (const asked1 of asked) {
      // A server may be named without its "mcp:" when no built-in group has that name
      const name = !isToolGroup(asked1) && !asked1.startsWith('mcp:') && known.includes(`mcp:${asked1}` as McpGroup) ? `mcp:${asked1}` : asked1;
      if (!known.includes(name as GroupId)) (name.startsWith('mcp:') ? servers : missing).push(clip(name, 70));
      else if (this.loadGroups(cfg, [name as GroupId], pool).length) out.push(this.groupLoadText(cfg, name as GroupId, pool));
      else had.push(name);
    }
    if (had.length) out.push(`Already loaded: ${had.join(', ')}.`);
    // An MCP server that is off, not trusted, signed out or not connected has nothing to load: said plainly, no guess
    const plan = cfg.permissionMode === 'plan';
    for (const s of servers) out.push(`${out.length ? '' : 'Error: '}${s} is not an MCP server with tools to load here${plan ? ' in plan mode' : ''}.`);
    if (missing.length) out.push(`${out.length ? 'Not' : 'Error: not'} a tool group here: ${missing.join(', ')}. The groups are ${known.join(', ') || 'none'}.`);
    return out.join('\n\n');
  }

  /**
   * For a compaction brief: what the loads of the groups still loaded told the model, when those loads are in the
   * part being folded (their results would be lost with it, the tools would not).
   */
  private foldedGroupsText(cfg: AppConfig, kept: Msg[]): string {
    if (this.ownTools()) return '';
    const inKept = new Set<string>();
    for (const m of kept) {
      if (m.role !== 'assistant') continue;
      for (const c of m.tool_calls ?? []) {
        if (c.type !== 'function' || c.function.name !== LOAD_TOOLS) continue;
        try {
          for (const g of requestedGroups(JSON.parse(c.function.arguments || '{}'))) inKept.add(g);
        } catch {
          /* not a list: nothing kept */
        }
      }
    }
    const pool = this.toolPool(cfg);
    const groups = this.loadedGroups().filter((g) => !inKept.has(g) && pool.some((t) => this.groupOf(t) === g));
    return groups.length ? `${FOLDED_GROUPS_HEADING}\n${groups.map((g) => this.groupLoadText(cfg, g, pool)).join('\n\n')}` : '';
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
    // The user's own answer (a click in the window or on the phone): Auto mode learns from it
    this.learnAnswer(p.learn, ok ? 'allow' : 'deny');
    const out: ApprovalOutcome = {};
    // A tool's own question has no wider answer, except the "for this session" one its key offers (never a project rule)
    const keep = p.custom && ok && always && !!p.sessionKey;
    if (keep) this.sessionSet(this.allowedCustom).add(p.sessionKey!);
    if (p.custom) always = false;
    if (p.browser) {
      // A site card's "for this session" allows the site for the session; "Always" also saves it for this Mac (the
      // caller adds it to the browser's always-allowed list). An allowed act on a sign-in page stops its password
      // field from asking again this session.
      const b = p.browser;
      if (ok && b.card === 'sensitive' && b.page) this.sessionSet(this.signInPages).add(b.page);
      if (ok && always && b.card === 'site' && b.site.origin) {
        this.sessionSet(this.allowedSites).add(b.site.origin);
        if (scope === 'project') out.rule = { kind: 'site', values: [b.site.origin] };
      }
      p.resolve(ok ? { ok: true } : { ok: false, message: DENIED });
      this.emit({ type: 'approval_resolved', id, ok, scope: ok && always ? scope : 'once' });
      return out;
    }
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
    this.emit({ type: 'approval_resolved', id, ok, scope: keep ? 'session' : ok && always ? scope : 'once' });
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

  /** True when Plan mode refuses the call whatever is answered: an edit, or a command that is not read-only. */
  private planRefuses(name: string, args: unknown): boolean {
    if (this.sessionConfig().permissionMode !== 'plan') return false;
    if (EDIT_TOOLS.has(name)) return true;
    if (!BASH_TOOLS.has(name)) return false;
    // (bash's path is judged as `cd <path> && <command>`, as its card shows it)
    const command = judgedCommand(name, args, this.sessionConfig().workingDirectory);
    return command === null || !isReadOnlyCall(name, command);
  }

  /**
   * Decides, per permission mode, whether an action runs, asks, or is refused (the rules are in agent/permissions.ts).
   * `hookAllowed`: a PreToolUse hook allowed the call, so no card is shown and no check runs (what the mode refuses
   * outright, plan mode's edits, stays refused, and a browser purchase or account card still asks, as it does in
   * bypass mode). 'rule': the user allowed the call on an ask rule's card, which skips the same cards but no browser
   * card. In Auto mode what the rules do not settle goes to the safety check (autoCheck); `call` is the tool
   * call it belongs to.
   */
  private requestApproval(name: string, detail: string, target?: string, opts: ApproveOptions = {}, hookAllowed: boolean | 'rule' = false, call?: CallRef): Promise<ApprovalResult> {
    const cfg = this.sessionConfig();
    // The shell sandbox's probe runs once per app, before the first bash call it may apply to is decided
    if (name === 'bash' && sandboxSettings(cfg.sandbox).enabled && sandboxHostNow() === undefined) return probeSandbox().then(() => this.requestApproval(name, detail, target, opts, hookAllowed, call));
    const mode = cfg.permissionMode;
    const cwd = cfg.workingDirectory;
    const st = this.autoState();
    // Timing: how the question was settled (agent/perf.ts). `before`: an answer the user gave earlier this session decided it
    const probe = call?.timing?.permission();
    let before = false;
    const seen = (yes: boolean) => {
      if (yes) before = true;
      return yes;
    };
    // (sandbox: whether this call may run in the shell sandbox; agent/permissions.ts decides when it does)
    const decide = (auto: AutoLevel, sandbox = name === 'bash' && this.sandboxOn(cfg)) =>
      decideApproval(name, detail, target, opts, {
        mode,
        auto,
        sandbox,
        loopback: sandboxSettings(cfg.sandbox).loopback,
        cwd,
        rules: cfg.allowRules?.[cwd],
        global: cfg.permissions,
        mcp: () => this.mcp?.lookup(name),
        allowed: {
          mcp: (server) => seen(this.sessionSet(this.mcpAllowed).has(server)),
          reason: (reason) => seen(this.sessionSet(this.allowedReasons).has(reason)),
          program: (program) => seen(this.sessionSet(this.allowedPrograms).has(program)),
          custom: (key) => seen(this.sessionSet(this.allowedCustom).has(key)),
        },
      });
    const done = (path: PermissionPath, r: ApprovalResult): ApprovalResult => {
      probe?.settle(path, r.ok);
      return r;
    };
    const allowedPath = (): PermissionPath => (before ? 'allowed_before' : mode !== 'bypass' && (name === 'bash' || name === 'terminal_run') && isReadOnlyCall(name, detail) ? 'read_only' : 'rule');
    const settle = async (d: ApprovalDecision): Promise<ApprovalResult> => {
      if (d.kind === 'refuse') return done('refused', { ok: false, message: d.message });
      if (d.kind === 'sandbox') {
        const plan = this.sandboxPlan(cfg, d.readOnly);
        // (a profile that cannot be built: decided again as without the sandbox)
        return plan ? done('sandbox', { ok: true, sandbox: plan }) : settle(decide(level(), false));
      }
      if (d.kind !== 'ask') return done(allowedPath(), { ok: true });
      const session = d.custom && opts.sessionKey && opts.sessionLabel ? { key: opts.sessionKey, label: opts.sessionLabel } : undefined;
      return done('card', await this.ask(name, detail, mode, d.reason, d.programs, d.custom, opts.browser, session, probe, call?.id));
    };
    const onceKey = opts.browser ? (CHECKED_BROWSER_CARDS.has(opts.browser.card) ? browserActionKey(name, detail, opts.browser) : null) : opts.custom ? null : actionKey(name, detail);
    // What the rules settle at once (run, refuse, a hook's allow, a blocked action the user allowed), or null when a
    // card or the safety check must decide
    const atOnce = (decision: ApprovalDecision): Promise<ApprovalResult> | null => {
      if (decision.kind === 'refuse' || decision.kind === 'allow') return settle(decision);
      // A firm card (a write to the file that holds the permission rules) is the user's alone: no hook, no earlier Allow
      if (decision.kind === 'ask' && decision.firm) return null;
      // (an Allow on an ask rule's card does not answer a browser card: site approvals stay the browser's)
      if (hookAllowed && !(hookAllowed === 'rule' && opts.browser) && !USER_ONLY_CARDS.has(opts.browser?.card ?? '')) return Promise.resolve(done('hook', { ok: true }));
      // An action Auto mode blocked and the user then allowed runs once, without the check or a card (a browser action
      // by its card, site and first line, a page script also by its code: the model's reason under it may differ on the retry)
      if (onceKey && this.sessionSet(this.autoAllowed).delete(onceKey)) return Promise.resolve(done('allowed_before', { ok: true }));
      // The shell sandbox needs no card and no check (a hook's allow and an Allow after a block run outside, above)
      if (decision.kind === 'sandbox') return settle(decision);
      return null;
    };
    const level = (): AutoLevel => (mode !== 'auto' ? 'guard' : st.paused ? 'paused' : st.unavailable ? 'guard' : 'check');
    const first = atOnce(decide(level()));
    if (first) return first;
    // A card or the check: one at a time across calls that run together, each decided again when its turn comes, so
    // an answer given meanwhile ("for this session"), a pause or a block count weighs as it would one call at a time
    return this.inLane(async () => {
      if (this.abortController?.signal.aborted) return done('card', { ok: false, message: INTERRUPTED });
      before = false;
      const decision = decide(level());
      const now = atOnce(decision);
      if (now) return now;
      if (decision.kind !== 'classify') return settle(decision);
      const checker = classifierTarget(cfg);
      if (!checker) {
        // No model can run the check: the rule guard and its cards, as before Auto mode had a check
        this.autoNotice('model', "No model for Auto mode's check: risky actions ask instead.");
        return settle(decide('guard'));
      }
      const action: ClassifiedAction = { name, detail, args: call?.args, callId: call?.id, ...(opts.browser ? { browser: browserFacts(detail, opts.browser) } : {}), ...(opts.sandboxBlock ? { sandbox: { line: opts.sandboxBlock.line } } : {}) };
      const r = await this.autoCheck(checker, cfg, action, () => settle(decide('guard')), { key: onceKey ?? actionKey(name, detail), browser: opts.browser }, probe);
      return probe ? done('check', r) : r;
    });
  }

  // ---------- The shell sandbox ----------

  /** bash says it runs in the sandbox (and takes outside: true) while the setting is on and the probe has not failed */
  private sandboxOffered(cfg: AppConfig): boolean {
    if (!sandboxSettings(cfg.sandbox).enabled || process.platform !== 'darwin') return false;
    void probeSandbox();
    return sandboxHostNow() !== null;
  }

  /** The sandbox can run this session's bash calls: on in the user's settings, the probe worked, the profile has not failed this session, and the folder can be sandboxed. */
  private sandboxOn(cfg: AppConfig): boolean {
    if (!sandboxSettings(cfg.sandbox).enabled || !sandboxHostNow() || this.sandboxOff.has(this.session.id)) return false;
    return sandboxableFolder(realish(cfg.workingDirectory));
  }

  /** How an allowed bash call runs in the sandbox (tools/shell.ts), or null when its profile cannot be built. */
  private sandboxPlan(cfg: AppConfig, readOnly: boolean): SandboxPlan | null {
    const host = sandboxHostNow();
    if (!host) return null;
    let live: number | null = null;
    try {
      live = this.opts.app?.service<{ status(): { port: number | null } }>('remote')?.status().port ?? null;
    } catch {
      live = null;
    }
    const cwd = cfg.workingDirectory;
    const profile = profileFor({ cwd, settings: sandboxSettings(cfg.sandbox), host, readOnly, deniedPorts: deniedPorts(cfg, [cfg.remote?.port, live]) });
    if (!profile) return null;
    const sessionId = this.session.id;
    const key = `${sessionId}\u0000${profile.text}\u0000${JSON.stringify(profile.params)}`;
    return {
      profile,
      readOnly,
      baseline: () => {
        let b = this.sandboxBaselines.get(key);
        if (!b) {
          b = runShell('true', cwd, { timeout: 15_000, sandbox: profile }).then((r) => outputLines(r.stdout, r.stderr));
          this.sandboxBaselines.set(key, b);
        }
        return b;
      },
      broken: () => {
        this.sandboxOff.add(sessionId);
        console.warn('[sandbox] sandbox-exec refused the profile: commands in this session are checked as without the sandbox');
        if (this.session.id === sessionId) this.autoNotice('sandbox', 'The shell sandbox does not work here: commands are checked as without it.');
      },
    };
  }

  // ---------- Auto mode ----------

  private autoState(): AutoState {
    let st = this.autoStates.get(this.session.id);
    if (!st) {
      st = { inARow: 0, total: 0, paused: false, reached: false, unavailable: false, noticed: new Set() };
      this.autoStates.set(this.session.id, st);
    }
    return st;
  }

  /** A one-line notice, once per session for each kind. */
  private autoNotice(kind: string, message: string): void {
    const st = this.autoState();
    if (st.noticed.has(kind)) return;
    st.noticed.add(kind);
    this.emit({ type: 'error', kind: 'notice', message });
  }

  /**
   * Auto mode's safety check on one action: allowed, it runs; blocked, the agent reads why (and the window shows the
   * quiet line). Fails closed: an error, a timeout or an answer that is not one blocks. Only when the model cannot be
   * reached before it ever answered does the session fall back to the rule guard (`fallback`) until its next run.
   * A browser action (`on.browser`) has a third answer, ask, which shows its card (`fallback`) without counting toward
   * the pause, and a check that fails shows the card too: it is never allowed because the check could not run. An
   * allowed site card allows the site for the session, as the user's "for this session" does; an act on a sensitive
   * page and page script are checked each time. `on.key` is what the user's Allow on a block lets through once.
   */
  private async autoCheck(checker: ClassifierTarget, cfg: AppConfig, action: ClassifiedAction, fallback: () => Promise<ApprovalResult>, on: { key: string; browser?: BrowserApproval }, probe?: PermissionProbe): Promise<ApprovalResult> {
    const st = this.autoState();
    const signal = this.abortController?.signal;
    const browser = on.browser;
    let verdict: Verdict | null = null;
    const checkAt = Date.now();
    probe?.checkStarted();
    // The window shows the call as being checked (not as running) until the verdict; the history log keeps the end
    const callId = action.callId;
    this.emit({ type: 'check_status', ...(callId ? { id: callId } : {}), running: true });
    const checked = (said: CheckVerdictWord, timedOut = false) =>
      this.emit({ type: 'check_status', ...(callId ? { id: callId } : {}), running: false, ms: Math.max(0, Date.now() - checkAt), verdict: said, ...(timedOut ? { timedOut: true } : {}) });
    try {
      const ask = (t: ClassifierTarget) => runClassifier(t, classifierRequest(this.session, cfg, action, this.learnedLines(cfg)), signal, undefined, (usage) => this.charge(callSource(t.cfg), usage));
      let raw: string;
      try {
        raw = await ask(checker);
      } catch (err) {
        // The faster default model is one this key may not use, or is not there: the session's own model checks
        // instead, now and until the app restarts. Nothing is allowed without a verdict either way.
        if (!checker.candidate || !isModelRefusal(err) || signal?.aborted) throw err;
        candidateRefused.add(checker.candidate);
        const own = classifierTarget(cfg);
        if (!own || own.candidate) throw err;
        console.warn(`[auto] ${checker.label} is not available to this key; the check runs on ${own.label}`);
        raw = await ask(own);
      }
      st.reached = true;
      verdict = parseVerdict(raw, { ask: !!browser });
      probe?.checkEnded(verdict?.decision ?? 'error');
      checked(signal?.aborted ? 'stopped' : (verdict?.decision ?? 'error'));
      if (!verdict) console.warn('[auto] the safety check gave no decision:', raw.slice(0, 200));
    } catch (err) {
      const timedOut = !signal?.aborted && ((err as { name?: string })?.name === 'TimeoutError' || Date.now() - checkAt >= CLASSIFIER_TIMEOUT_MS - 250);
      probe?.checkEnded('error', timedOut);
      checked(signal?.aborted ? 'stopped' : 'error', timedOut);
      if (signal?.aborted) return { ok: false, message: INTERRUPTED };
      if (!isConnectionError(err)) st.reached = true;
      else if (!st.reached) {
        st.unavailable = true;
        this.autoNotice('reach', `Auto mode's check could not reach ${checker.label}: risky actions ask instead.`);
        return fallback();
      }
      console.warn('[auto] the safety check failed:', errorMessage(err));
    }
    if (signal?.aborted) return { ok: false, message: INTERRUPTED };
    if (verdict?.decision === 'allow') {
      st.inARow = 0;
      if (browser?.card === 'site' && browser.site.origin) this.sessionSet(this.allowedSites).add(browser.site.origin);
      return { ok: true };
    }
    // A browser action the check left to the user, or could not decide: the card, as without the check
    if (browser && verdict?.decision !== 'block') return fallback();
    return this.autoBlock(action, verdict?.reason || UNAVAILABLE_REASON, on.key);
  }

  /** Where Auto mode's answers are kept: the option, else the app's service (none in bare tests). */
  private learnedStore(): LearnedStore | null {
    if (this.opts.learned !== undefined) return this.opts.learned;
    return this.opts.app?.service<LearnedStore>('auto-learned') ?? null;
  }

  /** Records the user's answer, unless learning is off (Settings → Permissions → Auto mode). Only the user's clicks reach here. */
  private learnAnswer(learn: { tool: string; key: string; line: string } | undefined, decision: 'allow' | 'deny'): void {
    if (!learn || this.getConfig().autoMode?.learn === false) return;
    try {
      this.learnedStore()?.record({ ...learn, decision });
    } catch (err) {
      console.warn('[auto] could not record the answer:', errorMessage(err));
    }
  }

  /** The user's earlier answers the check is given, one line each (none while learning is off). */
  private learnedLines(cfg: AppConfig): string[] {
    if (cfg.autoMode?.learn === false) return [];
    try {
      return forCheck(this.learnedStore()?.all() ?? []).map(answerText);
    } catch {
      return [];
    }
  }

  /** Records a block, tells the window, pauses Auto mode after too many, and returns what the agent reads. */
  private autoBlock(action: ClassifiedAction, reason: string, key = actionKey(action.name, action.detail)): ApprovalResult {
    const st = this.autoState();
    st.inARow++;
    st.total++;
    const id = action.callId || `block_${randomUUID()}`;
    const block: AutoBlock = { id, sessionId: this.session.id, name: action.name, what: actionLine(action.name, action.args, action.detail), reason, at: Date.now() };
    this.sessionMap(this.autoBlocks).set(id, { block, key, learn: { tool: action.name, key: action.browser ? action.browser.siteKey ?? action.browser.site : '', line: block.what } });
    this.emit({ type: 'auto_blocked', block: { ...block } });
    if (!st.paused && (st.inARow >= PAUSE_IN_A_ROW || st.total >= PAUSE_TOTAL)) {
      st.paused = true;
      this.autoNotice('paused', st.inARow >= PAUSE_IN_A_ROW ? `Auto mode paused after ${PAUSE_IN_A_ROW} blocks in a row: actions ask again.` : `Auto mode paused after ${PAUSE_TOTAL} blocks: actions ask again.`);
    }
    return { ok: false, message: blockedResult(reason) };
  }

  /**
   * Allows an action Auto mode blocked in this session: it runs once, without the check, when the agent tries it again,
   * and the agent is told it may (before its next model call, or at the start of the next run). False when the block
   * is not one of this app session's.
   */
  allowBlocked(id: string): { ok: boolean; error?: string } {
    const rec = this.autoBlocks.get(this.session.id)?.get(id);
    if (!rec) return { ok: false, error: 'This block is from before the app started; ask the agent to try again.' };
    if (rec.block.allowed) return { ok: true };
    rec.block.allowed = true;
    this.sessionSet(this.autoAllowed).add(rec.key);
    this.learnAnswer(rec.learn, 'allow');
    // The user's Allow ends a run of blocks, as an action the check allows does
    this.autoState().inARow = 0;
    const note = allowedNote(rec.block.what);
    if (this.running || this.compacting) this.sessionList(this.autoNotes).push(note);
    else {
      this.store.append(this.session, { role: 'user', content: note });
      this.store.save(this.session, false);
    }
    this.emit({ type: 'auto_allowed', id });
    return { ok: true };
  }

  /** The notes about allowed blocks, into the conversation before the next model call. */
  private flushAutoNotes(): void {
    const notes = this.autoNotes.get(this.session.id);
    if (!notes?.length) return;
    this.autoNotes.delete(this.session.id);
    for (const content of notes) this.store.append(this.session, { role: 'user', content });
  }

  private sessionMap<V>(map: Map<string, Map<string, V>>): Map<string, V> {
    let m = map.get(this.session.id);
    if (!m) {
      m = new Map();
      map.set(this.session.id, m);
    }
    return m;
  }

  private sessionList<V>(map: Map<string, V[]>): V[] {
    let l = map.get(this.session.id);
    if (!l) {
      l = [];
      map.set(this.session.id, l);
    }
    return l;
  }

  /**
   * Shows an approval card and waits for its answer. A custom card has Allow once and Deny, plus `session.label` when
   * the tool offers a "for this session" answer for its key.
   */
  private ask(name: string, detail: string, mode: PermissionMode, reason: string | null, programs: string[], custom = false, browser?: BrowserApproval, session?: { key: string; label: string }, probe?: PermissionProbe, callId?: string): Promise<ApprovalResult> {
    const id = randomUUID();
    const learn = { tool: name, key: learnKey(name, programs, browser, session?.key), line: actionLine(name, undefined, detail) };
    this.notifyHook('permission_prompt', `Silo Harness needs your permission to use ${claudeToolName(name)}`);
    // A browser card names its kind and site for the renderer's wording, and carries the amber note
    const extra = browser ? { ...(browser.note ? { note: browser.note } : {}), browser: { card: browser.card, site: browser.site.display } } : {};
    // The call the card belongs to, so the window puts it on that call's row when several run
    const owner = callId ? { callId } : {};
    probe?.cardShown();
    const answered = (resolve: (r: ApprovalResult) => void) => (r: ApprovalResult) => {
      probe?.cardAnswered();
      resolve(r);
    };
    if (custom) {
      // Allow and Deny (and the tool's own "for this session" answer): the renderer hides the buttons whose label is empty.
      return new Promise((resolve) => {
        this.pendingApprovals.set(id, { resolve: answered(resolve), name, programs, reason, custom: true, browser, learn, ...(session ? { sessionKey: session.key } : {}) });
        this.emit({ type: 'approval_request', id, name, detail, mode, ...(reason ? { reason } : {}), alwaysLabel: session?.label ?? '', projectLabel: '', ...extra, ...owner });
      });
    }
    const { alwaysLabel, projectLabel } = approvalLabels(name, reason, programs, browser?.card === 'site' ? browser.site : undefined);
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, { resolve: answered(resolve), name, programs, reason, browser, learn });
      this.emit({ type: 'approval_request', id, name, detail, mode, reason: reason ?? undefined, alwaysLabel, projectLabel, ...extra, ...owner });
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
      this.emit({ type: 'error', kind: 'notice', message: `A ${event} hook kept blocking, so the run ended after ${MAX_STOP_CONTINUES} more rounds.` });
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
   * dropped and the reason shown); its context follows the message as a note. The hook sees where the message came from
   * (silo_origin) and, for one from another session, which session sent it (silo_from_session).
   */
  private async promptHooks(text: string, origin: MessageOrigin, from?: string): Promise<{ ok: boolean; context: string[] }> {
    const fields: Record<string, unknown> = { prompt: text, silo_origin: origin };
    if (origin === 'session') fields.silo_from_session = { id: from ?? null, title: (from && this.store.get(from)?.title) || null };
    const out = await this.fireHook('UserPromptSubmit', fields);
    if (!out) return { ok: true, context: [] };
    if (out.block) {
      this.emit({ type: 'error', kind: 'notice', message: `A UserPromptSubmit hook blocked this message: ${plainReason(out.block)}` });
      return { ok: false, context: [] };
    }
    return { ok: true, context: out.context };
  }

  async run(userText: string, attachments: ImageAttachment[] = [], opts: SendOptions = {}): Promise<void> {
    if (this.running) throw new Error('A run is already in progress.');
    return this.startRun(userText, attachments, opts);
  }

  /**
   * The run itself. `queuedId`: the run starts from the queued message of that id (sendNow), which leaves the queue
   * on screen through queue_delivered once its hooks accepted it, or goes back to the composer (queue_dropped). Such a
   * run keeps the rest of the queue until after its first model call.
   */
  private async startRun(userText: string, attachments: ImageAttachment[], opts: SendOptions, queuedId?: string): Promise<void> {
    this.running = true;
    this.planSubmitted = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    // A session from before folders were per session adopts the app's folder the first time it runs.
    if (!this.session.cwd) this.session.cwd = this.getConfig().workingDirectory;
    this.runCwd = this.session.cwd;
    this.cacheState(); // before the run touches the session, so a reloaded one keeps its last activity time
    const cfg = this.sessionConfig();
    let reason: 'done' | 'aborted' | 'max_turns' | 'error' | 'plan' | 'loop' = 'done';
    let lastText = '';
    // Where the run's time goes (agent/perf.ts): always kept in memory, written to a file only when asked for
    // How many read-only calls of one reply may run together (AppConfig.toolConcurrency; 1: one at a time)
    const limit = concurrencyLimit(cfg.toolConcurrency);
    const timer = new RunTimer({ session: this.timingId, mode: cfg.permissionMode, limit });
    this.runTimer = timer;
    this.turnTimer = null;

    const skills = this.getSkills(cfg.workingDirectory);
    const { content } = expandSlashCommand(expandMentions(userText, cfg.workingDirectory).content, skills);
    this.repairTail(); // a session saved mid-run (rename, generated title) and then quit may end in unanswered tool calls
    const origin = opts.origin ?? 'user';
    this.hookStop = null;
    // Hooks: SessionStart the first time this session runs, then UserPromptSubmit, which may drop the message. Without
    // any, nothing here waits, so the message is in the conversation by the time send() returns.
    const early = (!this.sessionStarted && this.hasHooks('SessionStart')) || this.hasHooks('UserPromptSubmit');
    let accepted: { ok: boolean; context: string[] } = { ok: true, context: [] };
    this.runStartedAt = Date.now();
    this.turnClock = null;
    if (early) {
      this.emit({ type: 'run_start', timing: timer.id });
      await this.startSessionHooks();
      accepted = await this.promptHooks(userText, origin, opts.from);
      if (!accepted.ok || signal.aborted) {
        // A message sent from the queue goes back to the composer as a refused queued one does
        if (queuedId) this.emit({ type: 'queue_dropped', id: queuedId });
        const next = this.takeSendingNow();
        this.abortController = null;
        this.runCwd = null;
        this.runTimer = null;
        if (!next) {
          this.running = false;
          this.dropQueue();
        }
        const ended = signal.aborted ? 'aborted' : 'done';
        this.emit(next ? { type: 'run_end', reason: ended, continued: true } : { type: 'run_end', reason: ended });
        if (next) this.continueWith(next);
        return;
      }
    } else this.sessionStarted = true;
    this.startTurn(userText, origin, opts.from);
    this.store.append(this.session, userMessage(content, attachments));
    this.addHookNote('UserPromptSubmit', accepted.context);
    this.autoCompactFailed = false;
    this.compactedAt = -1;
    this.stuckAt = -1;
    // Auto mode's check gets another chance to reach its model with each run
    this.autoState().unavailable = false;
    if (!early) this.emit({ type: 'run_start', timing: timer.id });
    // The queued row leaves the queue and becomes the message's bubble, as a delivered queued message does
    if (queuedId) this.emit({ type: 'queue_delivered', id: queuedId });
    this.emitUserMessage(userText, attachments.length, origin, opts.from);
    // Saved now, not only at the end: the session gets its title from this message at once, so a sidebar with
    // several running sessions does not show several "New session" rows.
    this.store.save(this.session);
    this.emit({ type: 'session_changed', session: toMeta(this.session) });

    try {
      const { client, model, maxOutput, native } = isOllama(cfg) ? { client: null, model: ollamaOf(cfg).model, maxOutput: undefined, native: undefined } : makeClient(cfg);
      this.maxOutput = maxOutput;
      if (!model) throw new Error('No model selected. Open Settings and pick one.');
      this.costSource = callSource(cfg, model);
      timer.setModel(this.providerType(cfg), model);
      // A message that clearly needs a tool group (a web page to open) loads it now, which saves the model a step; the
      // load is a load_tools call of the agent's own right after the message, so what it tells is in the conversation.
      // A message from another session is answered with session_send, so it loads the sessions group.
      const wanted: GroupId[] = groupsForMessage(userText);
      // …and a message that names an MCP server (a whole word) loads that server's tools
      if (this.mcp && !this.ownTools() && !allGroupsUpFront(cfg)) wanted.push(...mcpGroupsForMessage(userText, this.mcp.loadable()));
      if (origin === 'session' && !wanted.includes('sessions')) wanted.push('sessions');
      const early = this.ownTools() ? [] : this.loadGroups(cfg, wanted);
      if (early.length) {
        // The note first, so it sits with the message (the model gets it before the message) and not after the load
        this.addContextNote(cfg);
        const load = this.syntheticLoad(early);
        const pool = this.toolPool(cfg);
        this.store.append(this.session, { role: 'assistant', content: '', tool_calls: [load] });
        this.store.append(this.session, { role: 'tool', tool_call_id: load.id, content: early.map((g) => this.groupLoadText(cfg, g, pool)).join('\n\n') });
      }
      let tools = this.toolsFor(cfg);
      let specs = tools.map(toSpec);
      this.specTokens = estimateSpecTokens(specs);
      this.emitContext();
      const groupsKey = () => (this.session.toolGroups ?? []).join(',');
      // A model that cannot take tools (e.g. a vision-only Ollama model) still works as a plain chat.
      let toolless = false;
      if (!client) {
        const key = `${ollamaOf(cfg).baseURL}|${model}`;
        if (!this.toolSupport.has(key)) {
          const caps = await modelCapabilities(cfg).catch(() => null);
          if (caps && caps.tools !== null) this.toolSupport.set(key, caps.tools);
        }
        if (this.toolSupport.get(key) === false) {
          toolless = true;
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
        sitesAllowed: () => this.sessionSet(this.allowedSites),
        signInPagesAllowed: () => this.sessionSet(this.signInPages),
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
      /** Replies cut at the output limit that the model was asked to continue, since the last user message */
      let continuations = 0;
      /** The newest tool calls, to stop one made again and again with the same result */
      const repeats = new RepeatWatch();
      for (let turn = 0; ; turn++) {
        if (turn >= cfg.maxTurns) {
          reason = 'max_turns';
          break;
        }
        if (signal.aborted) {
          reason = 'aborted';
          break;
        }
        // The harness's work before the request, step by step (agent/perf.ts PreStep)
        const tt = timer.turn();
        this.turnTimer = tt;
        this.flushAutoNotes();
        tt.step('notes');
        // A run started by "Send now" leaves the rest of the queue for after its first model call
        if (this.queued.length && (turn > 0 || !queuedId) && (await this.drainQueue(skills))) continuations = 0;
        tt.step('queue');
        await this.autoCompactIfNeeded(cfg, client, model, signal);
        tt.step('prune_compact');
        if (signal.aborted) {
          reason = 'aborted';
          break;
        }
        this.addContextNote(cfg);
        tt.step('context_note');
        const history: Msg[] = [{ role: 'system', content: this.prompt(cfg, skills) }, ...this.modelView()];
        const activeSpecs = toolless ? [] : specs;
        this.lastUsage = null;
        this.requestAt = this.now();
        tt.step('build');
        let reply: Reply;
        try {
          try {
            reply = await complete(this.completionHost(), cfg, client, model, history, activeSpecs, signal, turn, native);
          } catch (err) {
            // The provider says the request does not fit: compact and try this call once more instead of ending the run.
            if (signal.aborted || cfg.autoCompact === false || !isContextLengthError(err)) throw err;
            tt.fallback('compacted');
            await this.compact('auto', undefined, signal, cfg, client, model, { force: true });
            if (signal.aborted) {
              tt.end('aborted');
              reason = 'aborted';
              break;
            }
            this.lastUsage = null;
            this.requestAt = this.now();
            this.addContextNote(cfg);
            reply = await complete(this.completionHost(), cfg, client, model, [{ role: 'system', content: this.prompt(cfg, skills) }, ...this.modelView()], activeSpecs, signal, turn, native);
          }
        } catch (err) {
          tt.end(signal.aborted ? 'aborted' : 'error');
          throw err;
        }
        tt.end(this.finishOf(reply), reply.toolCalls.length);
        // Also where the provider reports no usage (noteCache never runs): a pause is measured from this reply
        this.cacheState().lastAt = this.now();
        const { text } = reply;
        // Ids unique within the session, so each result stays with its own call (Ollama reuses them across runs)
        const toolCalls = uniqueCallIds(reply.toolCalls, this.session.messages);
        this.emit({ type: 'thinking_done' });

        // The model declined (Anthropic stop_reason "refusal"): what it wrote stays, one notice, and the run ends
        if (reply.refused) {
          if (text.trim()) {
            const said: Msg = { role: 'assistant', content: text };
            if (reply.thinking?.length) (said as unknown as Record<string, unknown>)[THINKING_KEY] = reply.thinking;
            this.store.append(this.session, said);
            lastText = text;
            this.markPrompt();
            this.emit({ type: 'text_done' });
          }
          this.emit({ type: 'assistant_message', text, toolCalls: 0 });
          this.emit({ type: 'error', kind: 'notice', message: REFUSAL_NOTICE });
          break;
        }

        if (!text.trim() && !toolCalls.length && !reply.cut) {
          // Small models sometimes return nothing after a tool result. Nudge once, then give up.
          if (!nudged) {
            nudged = true;
            this.store.append(this.session, { role: 'user', content: 'You returned an empty response. If the task is complete, summarize the result. If a tool failed, fix the problem and continue.' });
            continue;
          }
        }
        // Tool groups the calls load (load_tools) or need (a tool of a group not loaded yet): offered from here on
        const groupsBefore = groupsKey();
        const loads = this.loadForCalls(toolCalls, cfg);
        if (groupsKey() !== groupsBefore) {
          tools = this.toolsFor(cfg);
          specs = tools.map(toSpec);
          this.specTokens = estimateSpecTokens(specs);
        }
        // A group loaded for a call by name gets a load_tools call of the agent's own, first in the reply
        const implied = loads.implied.length ? this.syntheticLoad(loads.implied) : null;
        if (implied) {
          const pool = this.toolPool(cfg);
          loads.results.set(implied.id, loads.implied.map((g) => this.groupLoadText(cfg, g, pool)).join('\n\n'));
        }
        const assistant: Msg = { role: 'assistant', content: text };
        // The native Anthropic path's thinking goes back with the reply, on that path only (agent/anthropic.ts)
        if (reply.thinking?.length) (assistant as unknown as Record<string, unknown>)[THINKING_KEY] = reply.thinking;
        if (toolCalls.length) assistant.tool_calls = [...(implied ? [implied] : []), ...(await this.storedCalls(toolCalls, tools, ctx))];
        this.store.append(this.session, assistant);
        if (implied) this.store.append(this.session, { role: 'tool', tool_call_id: implied.id, content: loads.results.get(implied.id)! });
        if (text.trim()) lastText = text;
        this.markPrompt();
        if (text) this.emit({ type: 'text_done' });
        this.emit({ type: 'assistant_message', text, toolCalls: toolCalls.length });
        // Cut at the output limit with no call: asked once to go on (twice at most per user message)
        if (!toolCalls.length && reply.cut && continuations < MAX_CONTINUATIONS && !signal.aborted && !this.hookStop) {
          continuations++;
          this.store.append(this.session, { role: 'user', content: CONTINUE_TEXT });
          continue;
        }
        if (!toolCalls.length) {
          // A message queued during the run keeps it going instead of ending it.
          if (this.queued.length && !signal.aborted && (await this.drainQueue(skills))) {
            continuations = 0;
            continue;
          }
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

        let looping = false;
        // The reply's calls (agent/schedule.ts): read-only ones together, up to toolConcurrency at a time, every other
        // one alone; each prepared in call order and judged on its final arguments; results stored in call order.
        const timers = new Map<number, ToolTimer>();
        await runSchedule<ToolCall, PreparedTool, CallResult>(toolCalls, limit, {
          candidate: (call) => loads.results.has(call.id) || (!!reply.cut && !isCompleteJson(call.function.arguments)) || this.shareable(call.function.name, parseArgs(call.function.arguments), tools, ctx.cwd),
          prepare: async (call, i) => {
            // load_tools was run above: its result goes in quietly, without a tool row, an approval or hooks
            const loaded = loads.results.get(call.id);
            if (loaded !== undefined) return { done: { result: { content: loaded }, quiet: true } };
            // Arguments cut off at the output limit: not run; the result says how to send it instead
            if (reply.cut && !isCompleteJson(call.function.arguments)) {
              this.emit({ type: 'tool_start', id: call.id, name: call.function.name, args: call.function.arguments });
              this.emit({ type: 'tool_end', id: call.id, name: call.function.name, result: CUT_CALL_TEXT, ok: false, durationMs: 0 });
              return { done: { result: { content: CUT_CALL_TEXT }, quiet: true } };
            }
            const timing = tt.tool(call.function.name, 0);
            timers.set(i, timing);
            const p = await this.prepareTool(call, tools, ctx, timing);
            if ('result' in p) return { done: { result: p.result } };
            return { ready: p, share: this.shareable(call.function.name, p.args, tools, ctx.cwd) };
          },
          run: async (p, _call, i, group) => {
            timers.get(i)?.setGroup(group);
            return { result: await p.finish() };
          },
          skip: (p) => ({ result: p.skip() }),
          failed: (call, i, err) => {
            const content = `Error: ${errorMessage(err)}`;
            this.emit({ type: 'tool_end', id: call.id, name: call.function.name, result: content, ok: false, durationMs: 0 });
            timers.get(i)?.done('failed');
            return { result: { content } };
          },
          commit: (call, i, { result, quiet }) => {
            if (quiet) {
              this.store.append(this.session, { role: 'tool', tool_call_id: call.id, content: result.content });
              return;
            }
            // The same call with the same result again and again: a line on the result, then the run ends
            const same = repeats.add(call.function.name, call.function.arguments, result.content);
            if (same >= REPEAT_WARN) result.content = `${result.content}\n${REPEAT_WARNING}`;
            if (same >= REPEAT_STOP) looping = true;
            const storeAt = performance.now();
            this.store.append(this.session, { role: 'tool', tool_call_id: call.id, content: result.content });
            timers.get(i)?.stored(performance.now() - storeAt);
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
          },
          stopped: () => signal.aborted || !!this.hookStop || looping,
          group: (g, size, wallMs) => tt.group(g, size, wallMs),
        });
        if (looping) {
          reason = 'loop';
          this.emit({ type: 'error', kind: 'notice', message: REPEAT_STOP_NOTICE });
          break;
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
      this.stopTurnClock();
      this.currentTurn = null;
      this.shownArgs.clear();
      this.repairTail();
      this.store.save(this.session);
      this.finishTiming(timer, reason);
      // "Send now": the session stays running (no other send can start a run, the queue stays) into the next run
      const next = this.takeSendingNow();
      this.abortController = null;
      this.runCwd = null;
      if (!next) {
        this.running = false;
        this.dropQueue();
      }
      this.emit({ type: 'session_changed', session: toMeta(this.session) });
      const end: AgentEvent = { type: 'run_end', reason, ...(lastText ? { text: lastText } : {}), ...(next ? { continued: true } : {}) };
      this.emit(end);
      if (next) this.continueWith(next);
      else {
        if (reason !== 'aborted' && !this.windowFocused()) this.notifyHook('idle_prompt', 'Silo Harness is waiting for your input');
        if (reason === 'done' || reason === 'max_turns' || reason === 'plan' || reason === 'loop') {
          this.generateSessionTitle(this.session).catch((err: unknown) => console.warn('[agent] title generation failed:', errorMessage(err)));
        }
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
    // What the model is sent (agent/context-view.ts), which can be less than the session keeps
    const sent = this.modelView();
    if (mark && mark.at <= s.messages.length) tokens = mark.tokens + estimateTokens(sent.slice(mark.at));
    else tokens = Math.round((estimateTokens([{ role: 'system', content: this.prompt(cfg, this.getSkills(cfg.workingDirectory)) }, ...sent]) + this.specTokens) * this.estimateScale);
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
    const parts = systemPromptParts(cfg, this.getSkills(cfg.workingDirectory), this.mcp, this.promptExtra(cfg), this.ownToolNames(cfg), this.promptGroups(cfg));
    const noTools = isOllama(cfg) && this.toolSupport.get(`${ollamaOf(cfg).baseURL}|${ollamaOf(cfg).model}`) === false;
    // The groups' tools the native path sends deferred take no room until a load brings them in
    const loaded = new Set(this.loadedGroups());
    const tools = noTools ? [] : this.toolsFor(cfg).filter((t) => !t.group || loaded.has(t.group) || allGroupsUpFront(cfg) || !!this.ownTools());
    const byServer = new Map<string, Tool[]>();
    for (const t of tools) if (t.mcp) byServer.set(t.mcp.server, [...(byServer.get(t.mcp.server) ?? []), t]);
    let summary = 0;
    let said = 0;
    let toolTokens = 0;
    // The context notes carry what used to be the end of the system prompt, and are counted with it
    let notes = 0;
    for (const m of s.messages) {
      if (isContextNote(m)) notes += estimateMessageTokens(m);
      else if (isCompactPreamble(m)) summary += estimateMessageTokens(m);
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
      { key: 'system', label: 'System prompt', tokens: chars(parts.base + parts.sections + parts.mcp + parts.userExtra) + 2 + (notes || chars(this.contextState(cfg))) },
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
    // The share of the last request's input its provider read from the prompt cache, when it said
    if (reported && mark.cacheRead !== undefined && mark.tokens > 0) out.cached = Math.min(1, mark.cacheRead / mark.tokens);
    if (last) out.lastCompaction = { at: last.createdAt, reason: last.reason, tokensBefore: last.tokensBefore, tokensAfter: last.tokensAfter };
    return out;
  }

  /** Records what the last model call cost as the base of the context estimate (the reply is now part of the history). */
  private markPrompt(): void {
    const u = this.lastUsage;
    if (!u || !u.promptTokens) return;
    const s = this.session;
    s.lastPrompt = { tokens: u.promptTokens + u.completionTokens, at: s.messages.length };
    // What the provider read from its prompt cache, for the meter's detail (only when it reports it)
    if (u.cacheReadTokens !== undefined) s.lastPrompt.cacheRead = Math.min(u.cacheReadTokens, u.promptTokens);
    const estimated = this.baseTokens(this.sessionConfig()) + estimateTokens(this.modelView());
    if (estimated > 0) this.estimateScale = Math.min(2, Math.max(0.67, s.lastPrompt.tokens / estimated));
    this.emitContext();
  }

  private reportUsage(usage: Usage): void {
    this.lastUsage = usage;
    this.noteCache(usage);
    this.turnTimer?.usage(usage);
    this.emit({ type: 'usage', ...usage });
    this.charge(this.costSource, usage);
  }

  /**
   * Counts one model call toward the session's cost (cost.ts) and tells the window the new total. Every kind of call
   * the session makes comes here: its turns, Auto mode's checks, the title, a compaction summary.
   */
  private charge(src: CallSource | null, usage: Usage): void {
    if (!src) return;
    const s = this.session;
    const ev = chargeSession(s, src, usage, this.getConfig());
    if (this.store.get(s.id) === s) this.emit(ev);
  }

  /** What a model call (agent/complete.ts) may use of this agent. */
  private completionHost(): CompletionHost {
    const tt = this.turnTimer;
    return {
      emit: (ev) => {
        tt?.observe(ev.type);
        this.emit(ev);
      },
      reportUsage: (usage) => this.reportUsage(usage),
      noStreamUsage: this.noStreamUsage,
      toolSupport: this.toolSupport,
      maxOutput: () => this.maxOutput,
      thinking: this.sessionThinking(),
      cacheKey: this.session.id,
      ...(tt ? { timing: tt } : {}),
      // Read at each request, so a change during a run applies from the next one
      effort: (provider) => effortOf(this.getConfig(), provider),
    };
  }

  // ---------- Timing (agent/perf.ts) ----------

  /** The last finished run's timing record in this session (in memory; /timing reads it). */
  lastTiming(): RunRecord | null {
    return this.lastRun;
  }

  /** The provider's type for a timing record (never its name, URL or key). */
  private providerType(cfg: AppConfig): string {
    if (isOllama(cfg)) return 'ollama';
    try {
      return resolveProvider(cfg).type;
    } catch {
      return 'other';
    }
  }

  /** How a reply ended, for its turn's record. */
  private finishOf(reply: Reply): Finish {
    if (reply.refused) return 'refusal';
    if (reply.cut) return 'length';
    return reply.toolCalls.length ? 'tool_use' : 'stop';
  }

  /** Sums the run up, keeps it for /timing and, when the log is on, appends it to the profile's timing log. */
  private finishTiming(timer: RunTimer, reason: string): void {
    try {
      const record = timer.finish(reason);
      this.lastRun = record;
      const dir = this.opts.app?.userData;
      if (dir && timingLogOn(this.getConfig())) {
        const at = path.join(dir, 'timing');
        let log = Agent.timingLogs.get(at);
        if (!log) Agent.timingLogs.set(at, (log = new TimingLog(at)));
        void log.append(record);
      }
    } catch (err) {
      console.warn('[timing] could not record the run:', errorMessage(err));
    } finally {
      if (this.runTimer === timer) this.runTimer = null;
      this.turnTimer = null;
    }
  }

  /** Per session: where the native path stopped sending kept thinking (agent/anthropic.ts completeAnthropic). */
  private nativeThinking = new Map<string, { stripBefore: number }>();
  private sessionThinking(): { stripBefore: number } {
    let t = this.nativeThinking.get(this.session.id);
    if (!t) this.nativeThinking.set(this.session.id, (t = { stripBefore: 0 }));
    return t;
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
    const tokens = this.contextInfo().tokens;
    // Where the provider caches the prefix, old output is set aside in batches (a change to it is paid for); elsewhere
    // as before: a little more past PRUNE_BUDGET, and in the stored messages past 60% of the window
    if (cfg.pruneToolResults !== false) {
      if (this.cachesPrefix(cfg)) this.pruneInBatches(limit);
      else if (tokens >= limit * PRUNE_THRESHOLD) this.prune(PRUNE_NORMAL, true);
      else if (tokens >= PRUNE_BUDGET) this.pruneForModel();
    }
    if (this.contextInfo().tokens < limit * threshold) return;
    const base = this.baseTokens(cfg);
    if (base >= limit * threshold) {
      // Folding the conversation cannot help when the prompt and tools alone fill the window.
      if (!this.smallWindowNoticed.has(s.id)) {
        this.smallWindowNoticed.add(s.id);
        this.emit({ type: 'error', kind: 'notice', message: `Can't compact: the prompt and tools fill ${Math.round(base / 1000)}k of the ${Math.round(limit / 1000)}k context. Raise it in Settings or remove MCP servers.` });
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
      this.costSource = callSource(cfg, model);
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

  /** The stored conversation as the model is sent it (agent/context-view.ts): long output cut, old screenshots left out. */
  private modelView(): Msg[] {
    return modelMessages(this.session.messages, new Set(this.session.prunedResults ?? []), { batchShots: this.cachesPrefix(this.sessionConfig()) });
  }

  /**
   * Whether the provider in use caches a request's prefix, so that changing an earlier message costs a cache write of
   * everything after it: every provider but Ollama and a local LM Studio (which keep the old way of pruning), unless
   * this session has seen it not cache (noteCache).
   */
  private cachesPrefix(cfg: AppConfig): boolean {
    try {
      const type = resolveProvider(cfg).type;
      return type !== 'ollama' && type !== 'lmstudio' && this.cacheState().caching;
    } catch {
      return false;
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private cacheState(): CacheSeen {
    let st = this.cacheSeen.get(this.session.id);
    if (!st) {
      st = { caching: true, misses: 0, storedAt: this.session.messages.length ? this.session.updatedAt : undefined };
      this.cacheSeen.set(this.session.id, st);
    }
    return st;
  }

  /**
   * After each main model call: a reported cache read or write means the provider caches. A request that should have
   * read the cache (sent within CACHE_TTL_MS of the last reply, a prompt of CACHE_EXPECT_MIN_TOKENS or more) and reports
   * neither is a miss; CACHE_MISSES_TO_FALLBACK in a row and the session prunes the uncached way until a read or write.
   */
  private noteCache(usage: Usage): void {
    const st = this.cacheState();
    const warm = st.lastAt !== undefined && this.requestAt - st.lastAt < CACHE_TTL_MS && usage.promptTokens >= CACHE_EXPECT_MIN_TOKENS;
    if ((usage.cacheReadTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0) {
      st.caching = true;
      st.misses = 0;
    } else if (warm && ++st.misses >= CACHE_MISSES_TO_FALLBACK) st.caching = false;
    st.lastAt = this.now();
  }

  /**
   * Where the prefix is cached: nothing until the view reaches the high-water mark, then old output set aside, oldest
   * first, until it is down to the low-water mark (context-view.ts batchMarks). Between batches the view, and so the
   * cached prefix, stays the same. After a pause longer than the cache lasts, the next request writes the whole
   * conversation anyway, so a batch then starts at COLD_BATCH_FROM of the way from the low mark to the high one.
   */
  private pruneInBatches(limit: number): void {
    const { high, low } = batchMarks(limit, PRUNE_THRESHOLD);
    let tokens = this.contextInfo().tokens;
    const st = this.cacheState();
    const last = st.lastAt ?? st.storedAt;
    const cold = last !== undefined && this.now() - last > CACHE_TTL_MS;
    if (tokens < (cold ? low + (high - low) * COLD_BATCH_FROM : high)) return;
    const s = this.session;
    const already = new Set(s.prunedResults ?? []);
    // resultsToPrune lists the newest first
    const candidates = resultsToPrune(s.messages, already, (m) => m.role === 'user' && !isSyntheticUser(m)).reverse();
    const byId = new Map<string, Msg>();
    for (const m of s.messages) if (m.role === 'tool') byId.set(m.tool_call_id, m);
    const chosen: string[] = [];
    for (const id of candidates) {
      if (tokens <= low) break;
      chosen.push(id);
      tokens -= pruneSaving(byId.get(id)?.content) * this.estimateScale;
    }
    this.pruneForModel(chosen);
  }

  /**
   * Past PRUNE_BUDGET tokens, long before a large window would prune, old tool output is set aside in what the model is
   * sent (only its start and end go with each later request). The session keeps it whole, so the tool rows still show
   * all of it, and an output once set aside stays so: the requests keep the same prefix until the next time.
   */
  private pruneForModel(chosen?: string[]): void {
    const s = this.session;
    const already = new Set(s.prunedResults ?? []);
    const ids = chosen ?? resultsToPrune(s.messages, already, (m) => m.role === 'user' && !isSyntheticUser(m));
    if (!ids.length) return;
    const before = estimateTokens(this.modelView());
    s.prunedResults = [...already, ...ids];
    const after = estimateTokens(this.modelView());
    // The reported size of the last request covered the output now set aside.
    const mark = s.lastPrompt;
    if (mark) mark.tokens = Math.max(0, Math.round(mark.tokens - (before - after) * this.estimateScale));
    this.store.save(s, false);
    this.emitContext();
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
          this.emit({ type: 'error', kind: 'notice', message: `Cleared ${formatTokens(cleared)} tokens of old tool output in this turn.` });
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
        const brief = compactedPreamble(summary, filesTouched(folded), this.requestToCarry(folded), this.foldedGroupsText(cfg, s.messages.slice(cut)));
        if (estimateMessageTokens({ role: 'user', content: brief }) >= estimateTokens(folded)) throw new Error('The summary was not smaller than the messages.');
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
    const why = trySummary && error ? `Couldn't summarise: ${error.replace(/\.$/, '')}` : this.autoCompactFailed ? "Couldn't summarise earlier in this run" : 'Nothing to summarise';
    const hard = cfg.pruneToolResults !== false ? this.prune(PRUNE_HARD, false) : 0;
    if (hard > 0 && !over()) {
      this.emit({ type: 'error', kind: 'notice', message: `${why}. Cleared ${formatTokens(hard)} more tokens of old tool output instead.` });
      return { ok: true };
    }
    let dropAt = this.cutFor(tail, limit);
    if (!dropAt) dropAt = findCut(s.messages, tail, { insideTurn: true });
    const dropped = s.messages.slice(0, dropAt);
    const count = dropped.filter((m) => !isCompactPreamble(m) && !isContextNote(m)).length;
    const note = droppedPreamble(count, filesTouched(dropped), this.requestToCarry(dropped), this.foldedGroupsText(cfg, s.messages.slice(dropAt)));
    if (!dropAt || estimateMessageTokens({ role: 'user', content: note }) >= estimateTokens(dropped)) {
      // Told once until the conversation has grown: every turn of the run would end up here again.
      if (this.stuckAt < 0 || s.messages.length >= this.stuckAt + 4) {
        this.stuckAt = s.messages.length;
        this.emit({ type: 'error', kind: 'notice', message: `${why}. The next request may not fit, so raise the context size or start a new session.` });
      }
      return { ok: false, error: error ?? 'Nothing to compact yet.' };
    }
    const folded = dropped;
    const info = this.fold(dropAt, note, `${count} earlier message${count === 1 ? ' was' : 's were'} dropped because a summary could not be produced.`, { reason, before, pruned: pruned + hard, stage: 'dropped' });
    this.emit({ type: 'error', kind: 'notice', message: `${why}. Dropped the ${count} oldest message${count === 1 ? '' : 's'}.` });
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
      messages: folded.filter((m) => !isCompactPreamble(m) && !isContextNote(m)).length,
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
            onUsage: (usage) => this.charge(callSource(cfg, model), usage),
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
      if (res.usage) this.charge(callSource(cfg, model), usageOf(res.usage as RawUsage));
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
      const accepted = await this.promptHooks(m.text, m.origin ?? 'queue', m.from);
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

  /**
   * "Send now" on the queued message `id`: cuts the current step short exactly as stop() does (a running command is
   * stopped, a waiting card closes as interrupted, a retry wait ends) and, when the run has ended (its tail repaired
   * and saved), starts the next run with this message. The rest of the queue stays queued. False when the message is
   * not queued here any more, or another message is already on its way this way.
   */
  sendNow(id: string): boolean {
    if (!this.running || this.sendingNow) return false;
    const i = this.queued.findIndex((m) => m.id === id);
    if (i < 0) return false;
    this.sendingNow = this.queued.splice(i, 1)[0];
    this.stop();
    return true;
  }

  private takeSendingNow(): QueuedMessage | null {
    const m = this.sendingNow;
    this.sendingNow = null;
    return m;
  }

  /** Starts the run of a message sent with sendNow; called while `running` is still true, so nothing comes between. */
  private continueWith(m: QueuedMessage): void {
    this.startRun(m.text, m.attachments, { origin: m.origin ?? 'queue', ...(m.from ? { from: m.from } : {}) }, m.id).catch((err: unknown) => console.error('[agent] run failed', err));
  }

  /** The run ended with messages still queued: hand them back to the renderer. */
  private dropQueue(): void {
    const left = this.queued.splice(0);
    for (const m of left) this.emit({ type: 'queue_dropped', id: m.id });
  }

  /** user_message for the message just added; `turn` is its checkpoint. */
  private emitUserMessage(text: string, images: number, origin: MessageOrigin, from?: string): void {
    // The turn before (a message delivered during the run) has ended; this one starts (the run's first: when the run did)
    const first = !this.turnClock;
    this.stopTurnClock();
    this.turnClock = { at: shownUserCount(this.session) - 1, startedAt: first ? this.runStartedAt || Date.now() : Date.now() };
    const turns = this.session.turns ?? [];
    const ev: Extract<AgentEvent, { type: 'user_message' }> = { type: 'user_message', text, images, origin };
    if (turns.length) ev.turn = turns.length - 1;
    if (from) ev.from = from;
    this.emit(ev);
  }

  /** Records how long the turn being counted worked (Session.turnTimes; the window's "Worked for 53s"). */
  private stopTurnClock(): void {
    const c = this.turnClock;
    this.turnClock = null;
    if (!c || c.at < 0) return;
    (this.session.turnTimes ??= {})[c.at] = Math.max(0, Date.now() - c.startedAt);
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
    const title = await generateTitle(cfg, prompt, (usage) => {
      if (session === this.session) this.charge(callSource(cfg), usage);
    });
    // The user may have renamed or deleted the session, or turned the feature off, while the model answered.
    if (!title || title === session.title || session.titleLocked) return;
    if (this.store.get(session.id) !== session || !this.getConfig().autoTitles) return;
    session.title = title;
    session.titleLocked = true;
    this.store.save(session, false);
    this.emit({ type: 'session_changed', session: toMeta(session) });
  }

  /**
   * The tool calls as the transcript keeps them. A tool may hide an argument that holds a secret (browser_type's text
   * for a password field): the stored call, the tool row and hooks get that version, the call runs on the real one.
   */
  private async storedCalls(calls: ToolCall[], tools: Tool[], ctx: ToolContext): Promise<ToolCall[]> {
    const out: ToolCall[] = [];
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.function.name);
      let shown: Record<string, unknown> | null = null;
      if (tool?.shownArgs) {
        try {
          shown = await tool.shownArgs(JSON.parse(call.function.arguments || '{}'), ctx);
        } catch {
          shown = null;
        }
      }
      if (!shown) {
        out.push(call);
        continue;
      }
      this.shownArgs.set(call.id, shown);
      out.push({ ...call, function: { ...call.function, arguments: JSON.stringify(shown) } });
    }
    return out;
  }

  /**
   * Whether a call may run alongside the other reads of its reply (agent/schedule.ts), judged on `args` (after the
   * PreToolUse hook, which may have rewritten them): the built-in file reads; web_fetch (every call fetches on its own,
   * its page cache is changed only between awaits, and each site question is its own card); bash only for a
   * command the guard reads as read-only and has nothing to say about. Everything else runs alone: writes, any other
   * command, the terminal, the browser, sub-sessions, questions, plans, MCP tools (a server may not take two calls at
   * once), web_search (its own card and a provider's rate limit), and anything this cannot tell.
   */
  private shareable(name: string, args: unknown, tools: Tool[], cwd: string): boolean {
    const tool = tools.find((t) => t.name === name);
    if (!tool || tool.mcp || !BUILT_IN_TOOLS.has(tool)) return false;
    if (SHARED_READS.has(name)) return true;
    if (name !== 'bash') return false;
    const command = judgedCommand(name, args, cwd);
    if (command === null || !command.trim()) return false;
    try {
      return isReadOnlyCommand(command.trim()) && guardCommand(command.trim(), cwd) === null;
    } catch {
      return false;
    }
  }

  /**
   * A call's first part, in call order: its arguments, the early exits (not JSON, the browser of a session not on
   * screen, an unknown tool), the PreToolUse hook (which may rewrite the arguments, block, deny, ask or allow) and
   * tool_start. Returns the result of an early exit, or the call ready to run: its final arguments, `finish` (approval,
   * the tool, PostToolUse, tool_end) and `skip` (a stop came before it ran).
   */
  private async prepareTool(call: ToolCall, tools: Tool[], ctx: ToolContext, timing?: ToolTimer): Promise<{ result: ToolResult } | PreparedTool> {
    const name = call.function.name;
    // The call's timing ends with how it ended (agent/perf.ts Outcome); an early exit ends it as failed or blocked
    const end = (r: ToolResult, outcome: Outcome): { result: ToolResult } => {
      timing?.done(outcome);
      return { result: r };
    };
    let args: unknown = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      this.emit({ type: 'tool_start', id: call.id, name, args: call.function.arguments });
      const content = `Error: arguments for ${name} were not valid JSON: ${truncate(call.function.arguments, 500)}`;
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: 0 });
      return end({ content }, 'failed');
    }
    // Arguments that hold a secret (Tool.shownArgs) reach the tool row and hooks hidden; the tool gets the real ones.
    let shown = this.shownArgs.get(call.id);
    this.shownArgs.delete(call.id);
    const hiddenKeys = (): string[] => (shown ? Object.keys(shown).filter((k) => JSON.stringify(shown![k]) !== JSON.stringify((args as Record<string, unknown>)?.[k])) : []);
    let hidden = hiddenKeys();
    const visible = (a: unknown): unknown => {
      if (!hidden.length || !a || typeof a !== 'object') return a;
      const o = { ...(a as Record<string, unknown>) };
      for (const k of hidden) if (k in o) o[k] = shown![k];
      return o;
    };
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      this.emit({ type: 'tool_start', id: call.id, name, args: visible(args) });
      const content = `Error: unknown tool "${name}". Available tools: ${tools.map((t) => t.name).join(', ')}`;
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: 0 });
      return end({ content }, 'failed');
    }

    // PreToolUse: before the tool's own approval check. deny refuses the call, ask forces the card, allow skips it,
    // updatedInput replaces the arguments.
    const claudeName = claudeToolName(name);
    const names = toolMatchNames(name);
    const toolInput = () => claudeToolInput(name, visible(args), ctx.cwd);
    const hookFields = () => ({ tool_name: claudeName, tool_input: toolInput(), tool_use_id: call.id, silo_tool_name: name, silo_tool_input: visible(args) });
    const preAt = performance.now();
    const pre = await this.fireHook('PreToolUse', hookFields(), { match: names, tool: { names, input: toolInput() }, signal: ctx.signal });
    timing?.preHook(performance.now() - preAt);
    if (pre?.updatedInput && !pre.block && pre.permission !== 'deny') {
      const real = args as Record<string, unknown>;
      args = nativeToolInput(name, pre.updatedInput);
      // A hook that hands the hidden value back as it saw it (•••) keeps the real one
      if (hidden.length && args && typeof args === 'object') {
        const o = args as Record<string, unknown>;
        for (const k of hidden) if (JSON.stringify(o[k]) === JSON.stringify(shown![k])) o[k] = real?.[k];
      }
      hidden = hiddenKeys();
    }
    this.emit({ type: 'tool_start', id: call.id, name, args: visible(args) });
    if (pre?.block || pre?.permission === 'deny') {
      const content = pre.block ?? `PreToolUse:${claudeName} hook denied this tool call${pre.permissionReason ? `: ${pre.permissionReason}` : '.'}`;
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: 0 });
      this.emit({ type: 'error', kind: 'notice', message: `A PreToolUse hook blocked ${name}: ${pre.block ? plainReason(content) : pre.permissionReason || 'denied'}` });
      return end({ content }, 'blocked');
    }
    const hookContext = pre?.context ?? [];
    let hookApproval: HookApproval = pre?.permission === 'allow' ? 'allow' : pre?.permission === 'ask' ? 'ask' : null;
    let askReason = pre?.permissionReason || 'a PreToolUse hook asks you to confirm this call';
    // The card came from an ask rule, not a hook: its Allow does not stand in for a browser card
    let byRule = false;
    // Permission rules (agent/rules.ts), after the hook and whatever it said: a deny rule refuses in every mode, Bypass
    // included; an ask rule shows a card in every mode (but where Plan mode refuses the call anyway). A hook's allow
    // beats neither.
    const scfg = this.sessionConfig();
    const verdict = ruleVerdict(compileRules(scfg.allowRules?.[ctx.cwd], scfg.permissions), name, args, ctx.cwd, name.startsWith('mcp__') ? this.mcp?.lookup(name)?.server : undefined);
    if (verdict?.list === 'deny') {
      const content = deniedByRule(verdict.rule);
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: 0 });
      return end({ content }, 'blocked');
    }
    if (verdict?.list === 'ask' && !this.planRefuses(name, args)) {
      hookApproval = 'ask';
      byRule = pre?.permission !== 'ask';
      askReason = `it matches your ask rule ${verdict.rule}`;
    }
    if (hookApproval === 'ask') {
      // The card comes up whatever the mode says; once answered, the tool's own check asks no more. One card at a
      // time: it waits for the cards of calls still running before it.
      const input = toolInput();
      const what = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : truncate(JSON.stringify(args ?? {}), 800);
      const probe = timing?.permission();
      const answer = await this.inLane(() => (ctx.signal?.aborted ? Promise.resolve<ApprovalResult>({ ok: false, message: INTERRUPTED }) : this.ask(name, what, this.getConfig().permissionMode, askReason, [], true, undefined, undefined, probe, call.id)));
      probe?.settle('hook', answer.ok);
      if (!answer.ok) {
        this.emit({ type: 'tool_end', id: call.id, name, result: answer.message, ok: false, durationMs: 0 });
        return end({ content: answer.message }, ctx.signal?.aborted ? 'stopped' : 'denied');
      }
      hookApproval = 'allow';
    }
    timing?.ready();

    const finish = async (): Promise<ToolResult> => {
      // durationMs covers the tool's own work: time spent waiting on an approval card is left out.
      let waited = 0;
      const timedCtx: ToolContext = {
        ...ctx,
        approve: async (toolName, detail, target, approveOpts) => {
          const askedAt = Date.now();
          try {
            return await this.requestApproval(toolName, detail, target, approveOpts, hookApproval === 'allow' ? (byRule ? 'rule' : true) : false, { id: call.id, args: visible(args), timing });
          } finally {
            waited += Date.now() - askedAt;
          }
        },
      };
      // ask_user's question card: the user's wait is its own number in the timing record, not tool time (agent/perf.ts)
      const ask = ctx.askUser;
      if (ask && timing) {
        timedCtx.askUser = async (questions) => {
          const probe = timing.permission();
          probe.cardShown();
          try {
            return await ask(questions);
          } finally {
            probe.cardAnswered();
            probe.settle('question', true);
          }
        };
      }
      const started = Date.now();
      const elapsed = () => Math.max(0, Date.now() - started - waited);
      let result: ToolResult;
      timing?.started();
      try {
        result = await tool.run(args, timedCtx);
        result.content = truncate(result.content);
      } catch (err) {
        result = { content: `Error: ${errorMessage(err)}` };
      }
      timing?.ran();
      const durationMs = elapsed();
      // The same rule the saved transcript applies when it is shown again (sessions.ts).
      const ok = !FAILED_RESULT.test(result.content);
      if (result.hiddenArgs && !hidden.length) {
        // The call found a secret the look before it missed (the field turned into a password field meanwhile): hide it
        // in the stored call too, which is this same object, and from the PostToolUse hooks.
        shown = result.hiddenArgs;
        hidden = hiddenKeys();
        call.function.arguments = JSON.stringify(visible(args));
      }

      // PostToolUse / PostToolUseFailure: what they say reaches the model with the result.
      const extra: string[] = hookContext.length ? [`${HOOK_NOTE_PREFIX}context: PreToolUse]\n${hookContext.join('\n\n')}`] : [];
      const interrupted = result.content.startsWith('Tool call was interrupted') || !!ctx.signal?.aborted;
      const outcome: Outcome = this.outcomeOf(ok, interrupted, result.content, timing);
      const postAt = performance.now();
      const post = ok
        ? await this.fireHook('PostToolUse', { ...hookFields(), tool_response: result.content }, { match: names, tool: { names, input: toolInput() } })
        : await this.fireHook('PostToolUseFailure', { ...hookFields(), error: result.content, is_interrupt: interrupted }, { match: names, tool: { names, input: toolInput() } });
      timing?.postHook(performance.now() - postAt);
      const event = ok ? 'PostToolUse' : 'PostToolUseFailure';
      if (post?.block) {
        extra.push(post.block);
        this.emit({ type: 'error', kind: 'notice', message: `A ${event} hook flagged ${name}: ${plainReason(post.block)}` });
      }
      if (post?.context.length) extra.push(`${HOOK_NOTE_PREFIX}context: ${event}]\n${post.context.join('\n\n')}`);
      if (extra.length) result = { ...result, content: `${result.content}\n\n${extra.join('\n\n')}` };
      this.emit({ type: 'tool_end', id: call.id, name, result: result.content, ok, image: result.image, durationMs });
      timing?.done(outcome);
      return result;
    };
    // A stop came before the call could run: its row ends, and the model reads that it did not run
    const skip = (): ToolResult => {
      this.emit({ type: 'tool_end', id: call.id, name, result: INTERRUPTED, ok: false, durationMs: 0 });
      timing?.done('stopped');
      return { content: INTERRUPTED };
    };
    return { args, finish, skip };
  }

  /**
   * One approval card or safety check at a time, across the calls of a reply that run together: `fn` starts once the
   * one before it has ended. A call that needs neither never waits here.
   */
  private inLane<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lane.then(fn);
    this.lane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** How a call that ran ended, for its timing record: read from its permission answers and its result (not kept). */
  private outcomeOf(ok: boolean, interrupted: boolean, content: string, timing?: ToolTimer): Outcome {
    if (interrupted) return 'stopped';
    const refused = timing?.span.permission.find((p) => !p.ok);
    if (refused) return refused.check === 'block' || refused.check === 'error' ? 'blocked' : 'denied';
    if (TIMED_OUT.test(content)) return 'timed_out';
    return ok ? 'ok' : 'failed';
  }
}
