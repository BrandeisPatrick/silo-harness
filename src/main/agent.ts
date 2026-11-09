import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { ContextBreakdown, ContextSlice } from '../shared/context';
import type { AgentEvent, AppConfig, ApprovalScope, ArtifactInfo, CompactionInfo, ContextInfo, ImageAttachment, MessageOrigin, PermissionMode, PlanInfo, QuestionAnswer, QueuedMessage, TaskItem, UserQuestion } from '../shared/types';
import { expandMentions } from './mentions';
import { isOllama, makeClient, modelCapabilities, ollamaOf } from './providers';
import { contextSize, ollamaComplete, type ToolCall, type Usage } from './ollama';
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
import { allTools, toSpec, type ApprovalResult, type ApproveOptions, type BrowserApproval, type Tool, type ToolContext, type ToolResult } from './tools';
import { truncate } from './tools/types';
import { cleanAnswers } from './tools/ask-user';
import type { BrowserController } from './browser';
import { expandSlashCommand, type Skill } from './skills';
import { clip, latestPlan, toMeta, turnSnapshot, type Msg, type Session, type SessionStore, type Turn } from './sessions';
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
import { ESSENTIAL_NOTE, systemPrompt, systemPromptParts, userMessage, type PromptExtra } from './agent/prompt';
import { errorMessage, providerErrorMessage } from './agent/errors';
import { complete, noToolsNotice, uniqueCallIds, type CompletionHost } from './agent/complete';
import { approvalLabels, decideApproval, DENIED, type ApprovalDecision, type AutoLevel } from './agent/permissions';
import { classifierRequest, classifierTarget, isConnectionError, parseVerdict, runClassifier, type ClassifiedAction, type ClassifierTarget, type Verdict } from './agent/classifier';
import { actionKey, actionLine, allowedNote, blockedResult, PAUSE_IN_A_ROW, PAUSE_TOTAL, UNAVAILABLE_REASON } from './agent/auto-rules';
import type { AutoBlock } from '../shared/auto-mode';

// The window size facts live in context-window.ts; re-exported because test/*.js loads them from here.
export { contextLimit, essentialToolsOnly, FULL_TOOLS_WINDOW } from './context-window';

/** The user turn that starts the build after a plan is approved. */
export const PLAN_APPROVED_TEXT = 'Plan approved. Implement it now, step by step. When done, summarise what changed.';

/** What a browser_* call from a session that is not on screen gets back (the pane belongs to the session on screen). */
export const BROWSER_BACKGROUND = 'Error: the built-in browser is only available while this session is on screen, and the user is looking at another session. Continue without the browser (use bash with curl for plain pages), or say that the user should open this session to let you browse.';
const SUMMARY_TIMEOUT_MS = 240_000;
/** How many times Stop hooks may send one run back to work (a hook that keeps blocking is stopped here) */
const MAX_STOP_CONTINUES = 8;
const MIN_COMPACT_MESSAGES = 2;

const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'terminal_run']);

/**
 * What answering an approval card changes besides the pending call: a mode switch, or a rule to save for the project
 * (kind 'site': a site key for AppConfig.browser.alwaysAllowed, saved on this Mac rather than for the project).
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
}

/** Browser cards a PreToolUse hook's "allow" does not skip: money and accounts are the user's, as in bypass mode. */
const USER_ONLY_CARDS = new Set(['purchase', 'account']);

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

/** The call an approval belongs to (its id and arguments), when it comes from a tool call. */
interface CallRef {
  id: string;
  args: unknown;
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
  prompt?: (info: { cwd: string; mode: PermissionMode; sessionId: string; essential?: boolean; restricted?: boolean; part?: 'shared' | 'session' }) => string;
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
  /** Per session: browser sites (policy.ts Site.key) the user allowed for the rest of the session, or always. */
  private allowedSites = new Map<string, Set<string>>();
  /** Per session: sign-in pages (signInPageKey) the user allowed an act on; their password field asks no more. */
  private signInPages = new Map<string, Set<string>>();
  /** Per session: custom actions (ApproveOptions.sessionKey, e.g. messages to one session) the user allowed for the rest of the session. */
  private allowedCustom = new Map<string, Set<string>>();
  /** Per session: Auto mode's counters and pause (see AutoState) */
  private autoStates = new Map<string, AutoState>();
  /** Per session: the actions Auto mode blocked in this app session, by call id, with the key Allow lets through once */
  private autoBlocks = new Map<string, Map<string, { block: AutoBlock; key: string }>>();
  /** Per session: blocked actions the user allowed (actionKey); each runs once without the check */
  private autoAllowed = new Map<string, Set<string>>();
  /** Per session: notes for the model (an allowed block) waiting for the run's next model call */
  private autoNotes = new Map<string, string[]>();
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
  /** Calls whose arguments hold a secret, by call id: the arguments as stored and shown (see Tool.shownArgs) */
  private shownArgs = new Map<string, Record<string, unknown>>();

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
      const info = restricted ? { ...base, restricted } : { ...base, essential };
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
      if (ok && always && b.card === 'site' && b.site.key) {
        this.sessionSet(this.allowedSites).add(b.site.key);
        if (scope === 'project') out.rule = { kind: 'site', values: [b.site.key] };
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

  /**
   * Decides, per permission mode, whether an action runs, asks, or is refused (the rules are in agent/permissions.ts).
   * `hookAllowed`: a PreToolUse hook allowed the call, so no card is shown and no check runs (what the mode refuses
   * outright, plan mode's edits, stays refused, and a browser purchase or account card still asks, as it does in
   * bypass mode). In Auto mode what the rules do not settle goes to the safety check (autoCheck); `call` is the tool
   * call it belongs to.
   */
  private requestApproval(name: string, detail: string, target?: string, opts: ApproveOptions = {}, hookAllowed = false, call?: CallRef): Promise<ApprovalResult> {
    const cfg = this.sessionConfig();
    const mode = cfg.permissionMode;
    const cwd = cfg.workingDirectory;
    const st = this.autoState();
    const decide = (auto: AutoLevel) =>
      decideApproval(name, detail, target, opts, {
        mode,
        auto,
        cwd,
        rules: cfg.allowRules?.[cwd],
        mcp: () => this.mcp?.lookup(name),
        allowed: {
          mcp: (server) => this.sessionSet(this.mcpAllowed).has(server),
          reason: (reason) => this.sessionSet(this.allowedReasons).has(reason),
          program: (program) => this.sessionSet(this.allowedPrograms).has(program),
          custom: (key) => this.sessionSet(this.allowedCustom).has(key),
        },
      });
    const settle = (d: ApprovalDecision): Promise<ApprovalResult> => {
      if (d.kind === 'refuse') return Promise.resolve({ ok: false, message: d.message });
      if (d.kind !== 'ask') return Promise.resolve({ ok: true });
      const session = d.custom && opts.sessionKey && opts.sessionLabel ? { key: opts.sessionKey, label: opts.sessionLabel } : undefined;
      return this.ask(name, detail, mode, d.reason, d.programs, d.custom, opts.browser, session);
    };
    const decision = decide(mode !== 'auto' ? 'guard' : st.paused ? 'paused' : st.unavailable ? 'guard' : 'check');
    if (decision.kind === 'refuse') return settle(decision);
    if (decision.kind === 'allow' || (hookAllowed && !USER_ONLY_CARDS.has(opts.browser?.card ?? ''))) return Promise.resolve({ ok: true });
    // An action Auto mode blocked and the user then allowed runs once, without the check or a card
    if (!opts.browser && !opts.custom && this.sessionSet(this.autoAllowed).delete(actionKey(name, detail))) return Promise.resolve({ ok: true });
    if (decision.kind !== 'classify') return settle(decision);
    const checker = classifierTarget(cfg);
    if (!checker) {
      // No model can run the check: the rule guard and its cards, as before Auto mode had a check
      this.autoNotice('model', "No model for Auto mode's check: risky actions ask instead.");
      return settle(decide('guard'));
    }
    return this.autoCheck(checker, cfg, { name, detail, args: call?.args, callId: call?.id }, () => settle(decide('guard')));
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
   */
  private async autoCheck(checker: ClassifierTarget, cfg: AppConfig, action: ClassifiedAction, fallback: () => Promise<ApprovalResult>): Promise<ApprovalResult> {
    const st = this.autoState();
    const signal = this.abortController?.signal;
    let verdict: Verdict | null = null;
    try {
      const raw = await runClassifier(checker, classifierRequest(this.session, cfg, action), signal);
      st.reached = true;
      verdict = parseVerdict(raw);
      if (!verdict) console.warn('[auto] the safety check gave no decision:', raw.slice(0, 200));
    } catch (err) {
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
      return { ok: true };
    }
    return this.autoBlock(action, verdict?.reason || UNAVAILABLE_REASON);
  }

  /** Records a block, tells the window, pauses Auto mode after too many, and returns what the agent reads. */
  private autoBlock(action: ClassifiedAction, reason: string): ApprovalResult {
    const st = this.autoState();
    st.inARow++;
    st.total++;
    const id = action.callId || `block_${randomUUID()}`;
    const block: AutoBlock = { id, sessionId: this.session.id, name: action.name, what: actionLine(action.name, action.args, action.detail), reason, at: Date.now() };
    this.sessionMap(this.autoBlocks).set(id, { block, key: actionKey(action.name, action.detail) });
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
  private ask(name: string, detail: string, mode: PermissionMode, reason: string | null, programs: string[], custom = false, browser?: BrowserApproval, session?: { key: string; label: string }): Promise<ApprovalResult> {
    const id = randomUUID();
    this.notifyHook('permission_prompt', `Silo Harness needs your permission to use ${claudeToolName(name)}`);
    // A browser card names its kind and site for the renderer's wording, and carries the amber note
    const extra = browser ? { ...(browser.note ? { note: browser.note } : {}), browser: { card: browser.card, site: browser.site.display } } : {};
    if (custom) {
      // Allow and Deny (and the tool's own "for this session" answer): the renderer hides the buttons whose label is empty.
      return new Promise((resolve) => {
        this.pendingApprovals.set(id, { resolve, name, programs, reason, custom: true, browser, ...(session ? { sessionKey: session.key } : {}) });
        this.emit({ type: 'approval_request', id, name, detail, mode, ...(reason ? { reason } : {}), alwaysLabel: session?.label ?? '', projectLabel: '', ...extra });
      });
    }
    const { alwaysLabel, projectLabel } = approvalLabels(name, reason, programs, browser?.card === 'site' ? browser.site : undefined);
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, { resolve, name, programs, reason, browser });
      this.emit({ type: 'approval_request', id, name, detail, mode, reason: reason ?? undefined, alwaysLabel, projectLabel, ...extra });
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
      accepted = await this.promptHooks(userText, origin, opts.from);
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
    // Auto mode's check gets another chance to reach its model with each run
    this.autoState().unavailable = false;
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
      for (let turn = 0; ; turn++) {
        if (turn >= cfg.maxTurns) {
          reason = 'max_turns';
          break;
        }
        if (signal.aborted) {
          reason = 'aborted';
          break;
        }
        this.flushAutoNotes();
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
          reply = await complete(this.completionHost(), cfg, client, model, history, activeSpecs, signal, turn);
        } catch (err) {
          // The provider says the request does not fit: compact and try this call once more instead of ending the run.
          if (signal.aborted || cfg.autoCompact === false || !isContextLengthError(err)) throw err;
          await this.compact('auto', undefined, signal, cfg, client, model, { force: true });
          if (signal.aborted) {
            reason = 'aborted';
            break;
          }
          this.lastUsage = null;
          reply = await complete(this.completionHost(), cfg, client, model, [{ role: 'system', content: this.prompt(cfg, skills) }, ...this.session.messages], activeSpecs, signal, turn);
        }
        const { text } = reply;
        // Ids unique within the session, so each result stays with its own call (Ollama reuses them across runs)
        const toolCalls = uniqueCallIds(reply.toolCalls, this.session.messages);
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
        if (toolCalls.length) assistant.tool_calls = await this.storedCalls(toolCalls, tools, ctx);
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
      this.shownArgs.clear();
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
      { key: 'system', label: 'System prompt', tokens: chars(parts.base + parts.sections + parts.mcp + parts.userExtra + parts.mode + parts.env + parts.sessionSections) + 2 },
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

  /** What a model call (agent/complete.ts) may use of this agent. */
  private completionHost(): CompletionHost {
    return {
      emit: (ev) => this.emit(ev),
      reportUsage: (usage) => this.reportUsage(usage),
      noStreamUsage: this.noStreamUsage,
      toolSupport: this.toolSupport,
      maxOutput: () => this.maxOutput,
    };
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
        const brief = compactedPreamble(summary, filesTouched(folded), this.requestToCarry(folded));
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
    const count = dropped.filter((m) => !isCompactPreamble(m)).length;
    const note = droppedPreamble(count, filesTouched(dropped), this.requestToCarry(dropped));
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
    if (name.startsWith('browser_') && !this.isForeground()) {
      this.emit({ type: 'tool_start', id: call.id, name, args: visible(args) });
      this.emit({ type: 'tool_end', id: call.id, name, result: BROWSER_BACKGROUND, ok: false, durationMs: 0 });
      return { content: BROWSER_BACKGROUND };
    }
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      this.emit({ type: 'tool_start', id: call.id, name, args: visible(args) });
      const content = `Error: unknown tool "${name}". Available tools: ${tools.map((t) => t.name).join(', ')}`;
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: 0 });
      return { content };
    }

    // PreToolUse: before the tool's own approval check. deny refuses the call, ask forces the card, allow skips it,
    // updatedInput replaces the arguments.
    const claudeName = claudeToolName(name);
    const names = toolMatchNames(name);
    const toolInput = () => claudeToolInput(name, visible(args), ctx.cwd);
    const hookFields = () => ({ tool_name: claudeName, tool_input: toolInput(), tool_use_id: call.id, silo_tool_name: name, silo_tool_input: visible(args) });
    const pre = await this.fireHook('PreToolUse', hookFields(), { match: names, tool: { names, input: toolInput() }, signal: ctx.signal });
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
          return await this.requestApproval(toolName, detail, target, approveOpts, hookApproval === 'allow', { id: call.id, args: visible(args) });
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
