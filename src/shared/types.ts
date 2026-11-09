import type { Bounds, BrowserConfig, BrowserState } from './browser';
// Types shared by the main process, preload and renderer.

import type { ModsConfig } from './mods';
import type { ImageInfo } from './images';
import type { DreamingConfig } from './dreaming';
import type { AutoBlock } from './auto-mode';

import type { RpcEvents, RpcMethods } from './rpc';

/**
 * The name of a provider: one of the two built-in ones ('ollama', 'portkey': the `ollama` and `portkey` blocks of the
 * config) or a key of AppConfig.providers.
 */
export type ProviderKind = string;

/** What kind of service a named provider is: each type is a preset with its base URL, key variable and headers. */
export type ProviderType = 'openrouter' | 'portkey' | 'openai' | 'anthropic' | 'groq' | 'deepseek' | 'together' | 'ollama' | 'lmstudio' | 'openai-compatible';

/**
 * A named provider (AppConfig.providers[name], or "providers" in settings.json). Only `type` is required; the rest
 * falls back to the type's preset. See docs/configure.md.
 */
export interface NamedProviderConfig {
  type: ProviderType;
  /** How the window names it (default: the type's name) */
  label?: string;
  /** Overrides the preset's base URL; required for openai-compatible */
  baseURL?: string;
  /** The key itself (allowed in the user's own files only) */
  apiKey?: string;
  /** The environment variable that holds the key (default: the preset's, e.g. OPENROUTER_API_KEY) */
  apiKeyEnv?: string;
  /** The model to run */
  model?: string;
  /** Models to offer in the picker */
  models?: string[];
  /** Extra request headers (`${VAR}` expanded) */
  headers?: Record<string, string>;
  /** The model's context window in tokens (default 128000; Ollama: numCtx) */
  contextWindow?: number;
  /** Most tokens one reply may have (sent as max_tokens); unset: the service's default */
  maxOutput?: number;
  /** portkey: x-portkey-virtual-key */
  virtualKey?: string;
  /** portkey: x-portkey-config */
  config?: string;
  /** portkey: x-portkey-provider */
  provider?: string;
  /** ollama: num_ctx */
  numCtx?: number;
  /** ollama: thinking mode */
  think?: 'auto' | 'on' | 'off';
}

/**
 * A provider as the window sees it: resolved over its preset, with the key reduced to whether it is set. Computed by
 * the main process (providers.ts) and sent with the window's copy of the config (AppConfig.providerView).
 */
export interface ProviderView {
  name: string;
  type: ProviderType;
  label: string;
  /** 'ollama' or 'portkey', the two blocks of config.json */
  builtIn: boolean;
  baseURL: string;
  model: string;
  /** The entry's list of models, for the picker (empty when it has none) */
  models: string[];
  contextWindow: number;
  maxOutput?: number;
  /** none: the service needs no key; set; missing */
  key: 'none' | 'set' | 'missing';
  /** Where the key comes from, for showing: a variable name ("OPENROUTER_API_KEY") or a field ("apiKey") */
  keySource: string;
  /** Names of the extra headers (never their values) */
  headers: string[];
  /** The settings file that defines it, when one does (its fields are read-only in Settings) */
  owner?: 'user' | 'project';
  /** Why it cannot be used as it is (no key, no model, no base URL), in plain words */
  error?: string;
}

export interface ProvidersView {
  /** The provider in use (config.provider), resolved */
  active: ProviderView;
  /** The built-in ones first, then the named ones in file order */
  all: ProviderView[];
}

/**
 * Permission modes, modelled on Claude Code's:
 * - ask: commands, writes and edits show an approval card (default)
 * - acceptEdits: writes and edits inside the working directory run without asking; commands still ask
 * - auto: everything runs, except actions the guard flags (sudo, destructive git, writes outside the
 *   working directory, piping downloads into a shell, …), which show an approval card with the reason
 * - plan: read-only exploration; the model ends by calling submit_plan and the user approves the plan before building
 * - bypass: everything runs without asking (what "auto" used to mean; older settings files are migrated)
 */
export type PermissionMode = 'ask' | 'acceptEdits' | 'auto' | 'plan' | 'bypass';

export interface OllamaConfig {
  /** OpenAI-compatible endpoint, e.g. http://localhost:11434/v1 */
  baseURL: string;
  /** Model tag, e.g. qwen3:8b, llama3.1:8b, devstral */
  model: string;
  /** Context window in tokens passed as num_ctx (Ollama's server default is only 4096) */
  numCtx: number;
  /** Thinking mode for models that support it (qwen3, deepseek-r1, gpt-oss) */
  think: 'auto' | 'on' | 'off';
}

export interface PortkeyConfig {
  /** Gateway endpoint, e.g. https://api.portkey.ai/v1 (or a self-hosted gateway) */
  baseURL: string;
  /** Portkey API key (x-portkey-api-key). Falls back to PORTKEY_API_KEY env var. */
  apiKey: string;
  /** Model id, e.g. @openai/gpt-4o-mini (model catalog) or gpt-4o-mini with a provider/virtual key */
  model: string;
  /** Optional: Portkey virtual key (x-portkey-virtual-key) */
  virtualKey: string;
  /** Optional: provider slug (x-portkey-provider), e.g. openai, anthropic, groq */
  provider: string;
  /** Optional: the upstream provider's own API key, sent as Authorization: Bearer when provider is set */
  providerApiKey: string;
  /** Optional: Portkey config id (x-portkey-config) for routing/fallbacks/caching */
  configId: string;
  /** The model's context window in tokens (the gateway does not report it); drives the context meter and auto-compaction */
  contextWindow: number;
}

/**
 * How an MCP server is reached. The stdio form is what Claude Code's .mcp.json uses, so project files can be shared:
 * { "mcpServers": { "name": { "command": "npx", "args": ["-y", "@scope/server"], "env": { "KEY": "${KEY}" } } } }
 */
export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; disabled?: boolean }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string>; disabled?: boolean };

/** user: stored in the app's settings; project: <workingDirectory>/.mcp.json */
export type McpScope = 'user' | 'project';

export interface McpToolInfo {
  /** The server's own tool name */
  name: string;
  /** The name the model calls it by: mcp__<server>__<tool> (as in Claude Code) */
  fullName: string;
  description: string;
  /** readOnlyHint from the tool's annotations: such tools run without asking in every mode */
  readOnly: boolean;
  /** destructiveHint === true: auto mode pauses for these like it does for risky commands */
  destructive: boolean;
}

/** blocked: a project server that the user has not enabled for this working directory yet (it never starts until then) */
export type McpStatus = 'connecting' | 'connected' | 'error' | 'disabled' | 'blocked';

export interface McpServerInfo {
  name: string;
  scope: McpScope;
  transport: 'stdio' | 'http' | 'sse';
  /** For display: the command line, or the URL */
  target: string;
  status: McpStatus;
  /** For error: what went wrong (connection failure, the last stderr lines); for blocked: how to enable it */
  error?: string;
  /** Empty unless connected */
  tools: McpToolInfo[];
  /** The server's own name and version from the handshake */
  serverInfo?: { name: string; version: string };
  config: McpServerConfig;
}

export interface McpApi {
  list(): Promise<McpServerInfo[]>;
  /**
   * Adds a server and connects it. `spec` is a command line ("npx -y @scope/server --flag"), a URL (http transport),
   * or a JSON snippet: {"command": …}/{"type": "http", "url": …}, or a whole {"mcpServers": {…}} block as servers
   * document them (then every server in it is added and `name` is ignored). `env` is for stdio servers (KEY → value).
   * Rejects with a message when the name is taken, the spec cannot be read, or a project file cannot be written.
   * Returns the new list.
   */
  add(name: string, spec: string, scope: McpScope, env?: Record<string, string>): Promise<McpServerInfo[]>;
  remove(name: string, scope: McpScope): Promise<McpServerInfo[]>;
  /** User servers: the disabled flag. Project servers: enabled=true trusts the server for this working directory (status blocked → connecting). */
  setEnabled(name: string, scope: McpScope, enabled: boolean): Promise<McpServerInfo[]>;
  reconnect(name: string, scope: McpScope): Promise<McpServerInfo[]>;
  /** The full list whenever a server's status or tools change */
  onServers(cb: (servers: McpServerInfo[]) => void): () => void;
}

/** Where the conversation stands against the model's context window. */
export interface ContextInfo {
  /** Tokens the next request is expected to take: the last prompt's size plus an estimate of what was added since */
  tokens: number;
  /** The window in tokens: Ollama's num_ctx, or the Portkey model's configured context window */
  limit: number;
  /** Fraction of the window at which a run compacts on its own (when autoCompact is on) */
  threshold: number;
  autoCompact: boolean;
}

/** One compaction: the earlier messages were replaced by a summary (shown as a divider in the transcript). */
export interface CompactionInfo {
  id: string;
  createdAt: number;
  /** auto: the run compacted on its own near the limit; manual: /compact */
  reason: 'auto' | 'manual';
  tokensBefore: number;
  tokensAfter: number;
  /** The summary that now stands in for the earlier messages (Markdown) */
  summary: string;
  /** How many messages were folded into the summary */
  messages: number;
  /** Messages after the brief that were kept word for word (older compactions kept none) */
  kept?: number;
  /** Tokens of old tool output cleared by pruning just before this compaction */
  pruned?: number;
  /** summary: the folded part was summarised; dropped: no summary could be produced, so it was dropped */
  stage?: 'summary' | 'dropped';
}

export interface AppConfig {
  /** The provider in use: 'ollama', 'portkey' or a name in `providers` */
  provider: ProviderKind;
  ollama: OllamaConfig;
  portkey: PortkeyConfig;
  /** Named providers (OpenRouter, OpenAI, Anthropic, LM Studio, any OpenAI-compatible service, …) */
  providers: Record<string, NamedProviderConfig>;
  /** Only in the window's copy: the providers resolved, keys reduced to set / not set. Never stored. */
  providerView?: ProvidersView;
  workingDirectory: string;
  /** See PermissionMode. Older files with 'readonly' map to 'plan'; older 'auto' maps to 'bypass'. */
  permissionMode: PermissionMode;
  /** Kept in sync with permissionMode === 'bypass' for older settings files */
  autoApprove: boolean;
  maxTurns: number;
  /** Attach browser screenshots to the conversation as images (needs a vision-capable model) */
  sendScreenshotsToModel: boolean;
  systemPromptExtra: string;
  theme: 'system' | 'light' | 'dark';
  /** After a session's first completed run, ask the model for a short title (like Claude Code's generated titles) */
  autoTitles: boolean;
  /** User-scope MCP servers by name (project ones come from <workingDirectory>/.mcp.json) */
  mcpServers: Record<string, McpServerConfig>;
  /** Project .mcp.json servers the user enabled, by working directory */
  mcpTrusted: Record<string, string[]>;
  /** Summarise the conversation on its own when it nears the context window (see ContextInfo.threshold) */
  autoCompact: boolean;
  /** macOS notifications when a run ends or waits for approval while the window is in the background */
  notifications: boolean;
  /** "Always allow … in this project" answers, by working directory (see ProjectRules) */
  allowRules: Record<string, StoredRules>;
  /** Working directories used before, most recent first (at most 8); the welcome screen offers them */
  recentDirs: string[];
  /** Keep the Mac awake: never, while a session is running, or whenever the app is open */
  keepAwake: 'off' | 'running' | 'always';
  /** Fraction of the context window at which a run compacts on its own (0.5 to 0.95) */
  compactThreshold: number;
  /** Before summarising, shorten old tool results the model no longer needs word for word */
  pruneToolResults: boolean;
  /**
   * Which tools the model is offered. Every tool's definition is sent with every request, so a small context window
   * cannot afford them all. essential: files, shell, browser, terminal, tasks, artifacts, images. all: also scheduled
   * tasks, sub-sessions and mod authoring. auto: all when the window is at least 32k tokens, essential below that.
   */
  toolSet: 'auto' | 'all' | 'essential';
  /** The tool calls in the conversation: summary folds each run of two or more into one line, all shows every call as its own row */
  toolActivity: 'summary' | 'all';
  /** Days a deleted session stays in the trash before it is removed for good (0: at once) */
  historyTrashDays: number;
  /** Mods: which are on, their settings, and how the rail and background are arranged */
  mods: ModsConfig;
  /** Remote control: whether it is on, who can reach it (this Mac or the local network) and the port (0: any free one) */
  remote: { enabled: boolean; bind: 'localhost' | 'lan'; port: number };
  /** Project settings.json files the user agreed to apply, by working directory: the SHA-256 of the content that was approved */
  settingsTrusted: Record<string, string>;
  /** Dreaming: once a day at a time (off by default), the mode, and what to look for (see src/shared/dreaming.ts) */
  dreaming: DreamingConfig;
  /** The Browser pane: whether its profile's cookies survive a quit (see src/shared/browser.ts) */
  browser: BrowserConfig;
  /** Auto mode's safety check: what it is told about this Mac, the user's own allow rules, and its model */
  autoMode?: AutoModeConfig;
}

/**
 * AppConfig.autoMode ("autoMode" in your own settings.json; a project's file may not set it). `environment` is free
 * text the check reads ("aisolutions-dev is a dev AWS account"); `allow` plain-language rules it allows; `model` the
 * check's model, "<provider>:<model>" or a model id of the session's provider ('' : the session's own model).
 */
export interface AutoModeConfig {
  environment: string;
  allow: string[];
  model: string;
}

/** What an approval card's "always" answer covers: the rest of this session, or this working directory from now on */
export type ApprovalScope = 'session' | 'project';

/**
 * A browser tool's approval card (approval_request.browser): `site` is the first approval of a site, with "Allow
 * <site> for this session" and "Always allow <site>" (saved on this Mac, not per project); `sensitive` an act on a
 * sign-in, email or financial site; `eval` a browser_eval; `purchase` and `account` a click that buys something or
 * makes an account. All but `site` have Allow and Deny only.
 */
export interface BrowserCardInfo {
  card: 'site' | 'sensitive' | 'eval' | 'purchase' | 'account';
  /** The site as the card names it (example.com, localhost:3000, a file's path with ~) */
  site: string;
}

export interface StoredRules {
  /** Programs (first word of a command: git, npm, …) that run without asking */
  programs?: string[];
  /** Auto-mode guard reasons ("uses sudo") that no longer pause */
  reasons?: string[];
  /** Writes and edits inside the working directory run without asking (like Accept edits, but remembered) */
  edits?: boolean;
  /** MCP servers whose tools run without asking */
  mcp?: string[];
}

/** The saved rules for the current working directory, for Settings */
export interface ProjectRules {
  cwd: string;
  programs: string[];
  reasons: string[];
  edits: boolean;
  mcp: string[];
}

export interface RulesApi {
  list(): Promise<ProjectRules>;
  /** Removes one rule (value is the program, reason or server name; edits needs none). Returns the remaining rules. */
  remove(kind: 'program' | 'reason' | 'edits' | 'mcp', value?: string): Promise<ProjectRules>;
}

/** One entry of the agent's own task list (the update_tasks tool); shown as a checklist card that updates in place */
export interface TaskItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** What a rewind did: the conversation now ends before the chosen message, whose text goes back into the composer */
export interface RewindResult {
  transcript: TranscriptItem[];
  session: SessionMeta;
  /** The rewound message's text, for the composer */
  text: string;
  /** Working-directory-relative paths restored to their content at that point */
  restored: string[];
  /** Files that did not exist at that point and were removed */
  deleted: string[];
  /** Files changed after that point that could not be restored (too large or not text) */
  skipped: string[];
}

/** A file or folder in the working directory, for @-mentions in the composer */
export interface FileHit {
  /** Relative to the working directory, with "/" separators */
  path: string;
  /** Base name */
  name: string;
  /** Parent directory relative to the working directory ('' at the root) */
  dir: string;
  isDir: boolean;
}

export interface InstructionsApi {
  /**
   * Appends a bullet to the project's instructions file (the first of SILOHARNESS.md, OPENHARNESS.md, OPENCODER.md, AGENTS.md, CLAUDE.md
   * in the working directory; SILOHARNESS.md is created when none exists). Returns the file and its short label.
   */
  append(text: string): Promise<{ path: string; label: string }>;
}

export interface FilesApi {
  /** Fuzzy search over the working directory's files and folders (ignores node_modules, .git, build output …); best matches first */
  search(query: string, limit?: number): Promise<FileHit[]>;
}

/** A plan the model proposed in plan mode (via the submit_plan tool). */
export interface PlanInfo {
  id: string;
  title: string;
  /** Markdown body: goals, steps with files, verification, open questions */
  markdown: string;
  status: 'proposed' | 'approved' | 'rejected';
  createdAt: number;
  /** dream: a dream gathered its proposals into this plan; approving it applies them (no build run) */
  kind?: 'dream';
}

export type AgentEvent =
  | { type: 'run_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'text_done' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_done' }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_end'; id: string; name: string; result: string; ok: boolean; image?: string; durationMs?: number }
  /** Token usage of one model call (prompt = input incl. history, completion = generated). Emitted after each call. */
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  /**
   * The agent wants to do something that needs the user's OK. `mode` is the permission mode at the time;
   * `reason` is set when the auto-mode guard paused an action (e.g. "uses sudo"); `alwaysLabel` is the text
   * for the "allow … for this session" button (e.g. "Allow git for this session", "Allow edits for this session").
   * A browser tool's card names its kind and the site in `browser`, and may carry `note`, the amber line ("This looks
   * like a sign-in site"); its detail is the action ("Click "Pay now" on shop.example"), then on a second line the
   * model's reason when it gave one, then for browser_eval a blank line and the code.
   */
  | { type: 'approval_request'; id: string; name: string; detail: string; mode: PermissionMode; reason?: string; alwaysLabel: string; projectLabel: string; note?: string; browser?: BrowserCardInfo }
  /** The model submitted a plan (plan mode). The run ends right after this with reason 'plan'. */
  | { type: 'plan_proposed'; plan: PlanInfo }
  /** Files changed in this session (snapshot or git) may have changed; `count` is the current number of changed files. */
  | { type: 'changes_updated'; count: number }
  /** A message queued during the run was handed to the model (in queue order); the renderer moves it from the queue into the transcript */
  | { type: 'queue_delivered'; id: string }
  /** The run ended before a queued message was delivered; the renderer puts it back into the composer */
  | { type: 'queue_dropped'; id: string }
  /** The model created or updated an artifact; the main process has already navigated the Browser pane to it */
  | { type: 'artifact'; artifact: ArtifactInfo; action: 'created' | 'updated' }
  /** The agent replaced its task list (update_tasks); an empty list clears the card */
  | { type: 'tasks_updated'; tasks: TaskItem[] }
  /** The context estimate changed: after each model call, after a compaction, and when the session or model changes */
  | { type: 'context'; context: ContextInfo }
  /** The conversation is being summarised; the renderer shows "Compacting…" until compact_end */
  | { type: 'compact_start'; reason: 'auto' | 'manual' }
  /** With `compaction` the summary replaced the earlier messages; with `error` nothing changed */
  | { type: 'compact_end'; compaction?: CompactionInfo; error?: string }
  /** kind 'notice' is informational (shown as a note, not an error), e.g. a model that runs without tools */
  | { type: 'error'; message: string; kind?: 'error' | 'notice' }
  | { type: 'session_changed'; session: SessionMeta }
  /** A user-role message entered the conversation (typed, queued, or delivered by a schedule, another session, the remote or a mod) */
  | { type: 'user_message'; text: string; images: number; origin: MessageOrigin; turn?: number; from?: string }
  /** The assistant finished one message: its full text (tool calls follow as tool_start events) */
  | { type: 'assistant_message'; text: string; toolCalls: number }
  /** An approval card was answered (here, on the phone) or, with `interrupted`, ended by a stop */
  | { type: 'approval_resolved'; id: string; ok: boolean; scope: 'once' | 'session' | 'project'; interrupted?: boolean }
  /** ask_user: the model asks the user one to four questions and the run waits for the answers (question:response) */
  | { type: 'question_request'; id: string; questions: UserQuestion[] }
  /** The question card was answered (`answers`, one per question) or skipped; also sent when a stop ends it unanswered */
  | { type: 'question_resolved'; id: string; answers?: QuestionAnswer[]; skipped?: boolean }
  /** The model showed an image with show_image; it appears inline in the reply */
  | { type: 'image'; image: ImageInfo }
  /** A hook with a statusMessage is running (text), or it finished (null): the status line says so meanwhile */
  | { type: 'hook_status'; text: string | null }
  /**
   * Auto mode's safety check blocked the call `block.id` (sent before its tool_end): the agent got the reason as the
   * call's result and goes on; the window shows one quiet line with Allow instead of the call's row.
   */
  | { type: 'auto_blocked'; block: AutoBlock }
  /** The user allowed the blocked call `id` (here, in Settings or on the phone): it runs once when the agent retries it */
  | { type: 'auto_allowed'; id: string }
  /** `text` is the last assistant text of the run, when it had any */
  | { type: 'run_end'; reason: 'done' | 'aborted' | 'max_turns' | 'error' | 'plan'; text?: string };

/** Where a user-role message came from. */
export type MessageOrigin = 'user' | 'queue' | 'schedule' | 'session' | 'remote' | 'mod' | 'command' | 'dream';

/** How a session came to be: started by the user, forked from another, spawned by an agent as a sub-session, or started by a schedule. */
export type SessionOrigin = 'user' | 'fork' | 'spawn' | 'schedule' | 'dream';

/** One question of an ask_user call, as the model asked it (checked by the tool: 1–4 per call, 2–4 options each). */
export interface UserQuestion {
  /** The whole question, e.g. "Which library should the charts use?" */
  question: string;
  /** A short label for it (at most 12 characters), shown as a chip: "Library" */
  header: string;
  options: { label: string; description: string }[];
  /** The user may pick more than one option */
  multiSelect: boolean;
}

/** The user's answer to one question: the labels picked and, under Other, what they typed. */
export interface QuestionAnswer {
  selected: string[];
  other?: string;
}

/** Run-time state of a session (only `unread` is stored). */
export interface SessionStatus {
  running: boolean;
  /** The run is waiting for the user: an approval card, a question card or a proposed plan */
  attention?: 'approval' | 'question' | 'plan';
  /** A run ended while the session was not on screen and it has not been opened since */
  unread?: boolean;
}

/** What is in flight in a running session, so a window that switches to it can show what one that watched from the start would. */
export interface LiveState {
  running: boolean;
  startedAt?: number;
  /** Text of the assistant message being streamed (not yet in the transcript) */
  text: string;
  thinking: string;
  /** Tool calls that have started and not finished */
  tools: { id: string; name: string; args: unknown }[];
  /** Approval cards waiting for an answer */
  approvals: Extract<AgentEvent, { type: 'approval_request' }>[];
  /** Question cards (ask_user) waiting for an answer; missing from an older main process */
  questions?: Extract<AgentEvent, { type: 'question_request' }>[];
  queue: QueuedMessage[];
}

export interface CommandInfo {
  name: string;
  description: string;
  source: 'app' | 'mod';
  /** Shown after the name in the menu, e.g. "<task>" */
  argsHint?: string;
}

/** What running a slash command asks the window to do. */
export interface CommandResult {
  notice?: string;
  error?: string;
  /** Send this text as the user's message */
  send?: string;
  /** Put this text into the composer */
  insert?: string;
  /** Start the inline rename of the session's title in the top bar */
  editTitle?: boolean;
}

// The Browser pane's state shapes live in browser.ts (tabs, popups, the config section); kept here for the imports.
export type { Bounds, BrowserState, TabState, PopupState, BrowserConfig } from './browser';

/** One file changed in the session's working directory. */
export interface ChangeEntry {
  /** Absolute path */
  path: string;
  /** Path relative to the working directory (for display) */
  relPath: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  /** session: snapshot taken before the agent's first write/edit; git: seen in `git status` but not snapshotted (e.g. changed by a command) */
  source: 'session' | 'git';
}

export interface ChangeDiff extends ChangeEntry {
  /** Content before the session's first change ('' for an added file or when git has no base) */
  original: string;
  /** Content now ('' when deleted) */
  current: string;
  /** True when either side is not text; original/current are then empty */
  binary?: boolean;
}

export interface ChangesApi {
  /** Changed files for the current session, session snapshots first then git-only entries, sorted by relPath */
  list(): Promise<ChangeEntry[]>;
  diff(path: string): Promise<ChangeDiff>;
  /** Restore the file to its original content (delete it if it was added). Returns the updated list. */
  revert(path: string): Promise<ChangeEntry[]>;
  /** Open the file with the system's default editor */
  openInEditor(path: string): Promise<void>;
}

export interface PlanApi {
  /**
   * build-ask / build-acceptEdits: mark the plan approved, switch the permission mode accordingly and start a
   * run that implements it. keep: mark it rejected and stay in plan mode so the user can refine it.
   */
  respond(id: string, decision: 'build-ask' | 'build-acceptEdits' | 'keep'): Promise<void>;
}

/** One shell tab in the Terminal pane. Tabs are app-wide (not per session) and outlive renderer reloads. */
export interface TerminalTabInfo {
  /** Short stable id, e.g. "tab-3"; the agent's terminal_* tools take it as tab_id */
  id: string;
  /** Shown on the tab: the running command's program while one runs, else the shell's name */
  title: string;
  /** The shell's current directory as far as it is known (starts as the working directory; zsh reports changes) */
  cwd: string;
  /** Shell binary name, e.g. "zsh" */
  shell: string;
  pid: number;
  /** The command that is running now, when shell integration (zsh) reported it and it has not finished */
  running?: string;
  /** Set once the shell process has ended; the tab stays until it is closed */
  exitCode?: number;
  /** True for tabs the agent opened with terminal_run */
  agent: boolean;
  createdAt: number;
}

export interface TerminalApi {
  list(): Promise<TerminalTabInfo[]>;
  /** Opens a new shell in the working directory with the given size */
  create(cols: number, rows: number): Promise<TerminalTabInfo>;
  /** Raw output the tab produced so far (bounded), to replay into a fresh xterm after a reload or when the pane is first shown */
  history(id: string): Promise<string>;
  /** Keyboard input (xterm's onData) */
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Kills the shell and forgets the tab */
  close(id: string): Promise<void>;
  /** Output from the pty, in order, as it arrives */
  onData(cb: (id: string, data: string) => void): () => void;
  /** The full tab list whenever a tab is created, closed, retitled, starts or finishes a command, or exits */
  onTabs(cb: (tabs: TerminalTabInfo[]) => void): () => void;
}

/** An image attached to a user message (pasted, dropped or picked). The renderer downscales it before sending. */
export interface ImageAttachment {
  /** Renderer-generated id */
  id: string;
  /** File name, or "Pasted image" */
  name: string;
  /** image/png, image/jpeg, image/webp or image/gif */
  mime: string;
  /** data:<mime>;base64,… — at most 1568 px on the long side and 4 MB encoded */
  dataUrl: string;
  width: number;
  height: number;
  /** Bytes of the encoded image */
  size: number;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  /** A run was in progress, so the message was queued; it reaches the model after the current step (see queue_delivered) */
  queued?: boolean;
  /** The queued message's id */
  id?: string;
}

/** A message sent while a run was in progress. It is handed to the model before its next turn. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ImageAttachment[];
  createdAt: number;
  /** Who queued it when it was not typed in the window (a schedule, another session, …); see MessageOrigin */
  origin?: MessageOrigin;
  from?: string;
}

export interface ModelCapabilities {
  provider: ProviderKind;
  model: string;
  /** Whether the model accepts images; null when unknown (Portkey, or an Ollama too old to report capabilities) */
  vision: boolean | null;
  tools: boolean | null;
}

/** What create_artifact can produce. html renders as a page, svg as an image, markdown and code in a styled viewer. */
export type ArtifactKind = 'html' | 'markdown' | 'svg' | 'code';

/** A self-contained deliverable the model made with create_artifact; stored per session and shown in the Browser pane. */
export interface ArtifactInfo {
  /** Stable id the model reuses to update the artifact, e.g. "art-1" */
  id: string;
  sessionId: string;
  title: string;
  kind: ArtifactKind;
  /** For code artifacts: the language label (also used for highlighting) */
  language?: string;
  /** Starts at 1; each update increments it */
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Size of the source in bytes */
  bytes: number;
  /** URL for the Browser pane (artifact://view/<session>/<id>) */
  url: string;
  /** Absolute path of the stored source file */
  path: string;
}

export interface ArtifactsApi {
  /** The current session's artifacts, newest last */
  list(): Promise<ArtifactInfo[]>;
  /** The artifact's source text */
  content(id: string): Promise<string>;
  /** Shows the artifact in the Browser pane (the renderer brings the Browser tab forward) */
  open(id: string): Promise<void>;
  /** Save dialog; returns the chosen path or null */
  saveAs(id: string): Promise<string | null>;
  /** Reveals the stored file in Finder */
  reveal(id: string): Promise<void>;
}

/** The API the preload script exposes to the renderer as window.oc */
export interface SiloHarnessApi {
  /** The user's home folder: what "~" stands for in the paths the window shows */
  homeDir: string;
  getConfig(): Promise<AppConfig>;
  setConfig(cfg: AppConfig): Promise<AppConfig>;
  chooseDirectory(): Promise<string | null>;
  listOllamaModels(): Promise<string[]>;
  /** Absolute path of a File dropped onto the window (Electron's webUtils) */
  pathForFile(file: File): string;
  /**
   * Starts a run with the message (and images). While a run is in progress the message is queued instead and
   * delivered to the model before its next turn; the result then has queued=true and the queue id.
   */
  send(text: string, attachments?: ImageAttachment[]): Promise<SendResult>;
  /** Removes a queued message before it is delivered; false when it was already delivered or unknown */
  unqueue(id: string): Promise<boolean>;
  /** Messages still waiting to be delivered (for restoring the queue after a reload) */
  queue(): Promise<QueuedMessage[]>;
  /** Whether the configured model accepts images and tools (cached per provider+model) */
  modelCapabilities(): Promise<ModelCapabilities>;
  abort(): Promise<void>;
  /**
   * /compact: summarises the conversation so far into a brief and continues from it. `focus` is what the summary
   * should keep in detail. Fails while a run is in progress or when there is nothing to compact.
   */
  compact(focus?: string): Promise<{ ok: boolean; error?: string }>;
  /** The current context estimate (also arrives as 'context' events) */
  context(): Promise<ContextInfo>;
  mcp: McpApi;
  /**
   * ok=false denies. always=true means "and don't ask again for this kind of action": with scope 'session' (default)
   * for the rest of the session (write/edit cards in ask mode switch the mode to acceptEdits; a command's program,
   * a flagged reason or an MCP server is allow-listed); with scope 'project' the rule is saved for the working
   * directory (see RulesApi) and applies from now on. Returns the config.
   */
  respondApproval(id: string, ok: boolean, always?: boolean, scope?: ApprovalScope): Promise<AppConfig>;
  /** Answers a question card (one answer per question); null skips it. False when no session waits on that card any more. */
  respondQuestion(id: string, answers: QuestionAnswer[] | null): Promise<boolean>;
  files: FilesApi;
  rules: RulesApi;
  instructions: InstructionsApi;
  /** Every agent event of every session, tagged with the session it belongs to */
  onAgentEvent(cb: (ev: AgentEvent, sessionId: string) => void): () => void;
  /** Calls a method registered with app.rpc.handle in the main process (see src/shared/rpc.ts); rejects for unknown names */
  rpc<K extends keyof RpcMethods>(method: K, ...args: Parameters<RpcMethods[K]>): Promise<Awaited<ReturnType<RpcMethods[K]>>>;
  /** Follows a push channel the main process sends with app.push */
  onPush<K extends keyof RpcEvents>(channel: K, cb: (payload: RpcEvents[K]) => void): () => void;
  sessions: SessionsApi;
  skills: SkillsApi;
  changes: ChangesApi;
  plan: PlanApi;
  terminal: TerminalApi;
  artifacts: ArtifactsApi;
  browser: {
    setBounds(b: Bounds): void;
    setVisible(v: boolean): void;
    navigate(url: string): Promise<string>;
    back(): Promise<string>;
    forward(): Promise<string>;
    reload(): Promise<void>;
    state(): Promise<BrowserState>;
    onState(cb: (s: BrowserState) => void): () => void;
    /** Open the given URL, or the page currently shown in the pane, in the user's default browser */
    openExternal(url?: string): Promise<void>;
  };
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  forkedFrom?: string;
  messageCount: number;
  /** True once the user renamed the session or the model generated a title; derived titles no longer overwrite it */
  titleLocked?: boolean;
  /** The most recent plan proposed in this session, if any */
  plan?: PlanInfo;
  /** Number of files changed in this session (snapshot-tracked) */
  changedFiles?: number;
  /** Number of artifacts the model created in this session */
  artifacts?: number;
  /** Number of times the session's context was compacted */
  compactions?: number;
  /** The agent's current task list, if it keeps one */
  tasks?: TaskItem[];
  /** The session's own working directory (absolute); older sessions have none until they are opened or run */
  cwd?: string;
  /** The session this one was spawned from */
  parentId?: string;
  origin?: SessionOrigin;
  /** Run-time state; set by the runtime (sessions:list, sessions:changed), not by toMeta */
  status?: SessionStatus;
  /** Set once the session was merged into another (its id) */
  mergedInto?: string;
  /** A dream's session: the dream, and how many of its proposals wait for the user */
  dream?: { id: string; waiting: number };
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: 'project' | 'user' | 'bundled';
}

export type TranscriptItem =
  /**
   * images: data URLs of the attached images, in order; mentions: @-mentioned paths whose contents went to the model;
   * turn: the message's checkpoint index, present when the conversation can be rewound to it (sessions.rewind);
   * origin/from: set when the message was not typed in the window (see MessageOrigin)
   */
  | { role: 'user'; text: string; images?: string[]; mentions?: string[]; turn?: number; origin?: MessageOrigin; from?: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; name: string; args: string; result: string; ok: boolean }
  /** A submit_plan call is shown as a plan card instead of a tool row */
  | { role: 'plan'; plan: PlanInfo }
  /** A create_artifact call is shown as an artifact card instead of a tool row */
  | { role: 'artifact'; artifact: ArtifactInfo }
  /** A divider: everything above it was folded into the summary */
  | { role: 'compaction'; compaction: CompactionInfo }
  /** A show_image call is shown as the image itself instead of a tool row */
  | { role: 'image'; image: ImageInfo }
  /** A dream's propose_* call is shown as its proposal's card (the window has the proposal from dreaming.list) */
  | { role: 'proposal'; proposalId: string; name: string; args: string; result: string }
  /** A call Auto mode's safety check blocked is shown as one quiet line instead of a tool row */
  | { role: 'auto_blocked'; block: AutoBlock };

export interface SessionsApi {
  list(): Promise<SessionMeta[]>;
  current(): Promise<SessionMeta>;
  create(): Promise<SessionMeta>;
  fork(id?: string): Promise<SessionMeta>;
  switch(id: string): Promise<TranscriptItem[]>;
  delete(id: string): Promise<SessionMeta>;
  rename(id: string, title: string): Promise<SessionMeta>;
  /**
   * Rewinds the current session to the checkpoint of a user message (its `turn`): files the agent wrote or edited
   * after it are restored to their content at that point (changes made by commands are not undone), the messages
   * from it on are removed, and its text comes back for the composer. Only between runs.
   */
  rewind(turn: number): Promise<RewindResult>;
}

export interface SkillsApi {
  list(): Promise<SkillInfo[]>;
}
