# Architecture: the App, the session runtime and the seams

Feature code lives in its own files; `index.ts`, `preload.ts` and the core of `renderer.ts` need no edits for a feature.

## Main process

```
index.ts       buildApp() → registerCoreIpc(app) → setupSettings … setupPower(app) → createWindow()
app.ts         AppHost implements App: config, store, runtime, event bus, RPC registry, registries, services, quit
runtime.ts     SessionRuntime: one Agent per session, concurrent runs, foreground, LiveState, SessionStatus
ipc.ts         the existing typed channels (window.oc.*) + the generic 'rpc' channel
agent.ts       Agent: one run loop bound to one session for its life
sessions.ts    Session, SessionStore (the only place messages change), toMeta, toTranscript, rewindSession
```

Feature setups, in this order, before the window opens: `setupSettings` (settings-service.ts), `setupHistory` (history.ts),
`setupContext` (context-service.ts), `setupImages`, `setupMods`, `setupSchedules`, `setupSubagents`, `setupRemote`,
`setupPower`, `setupDreaming`, `setupProviders` (providers-service.ts) (each in its own file).

## Providers (src/main/providers.ts, provider-presets.ts)

Every model service resolves to one shape, `ResolvedProvider` (name, type, label, base URL, key, bearer, headers,
model, models, context window, max output, Ollama's num_ctx/think, error), and the rest of the app asks for that:
`resolveProvider(cfg, name?)`, `makeClient(cfg)` (throws the plain error), `isOllama(cfg)` / `ollamaOf(cfg)` (the
native Ollama path, for the `ollama` block or an entry of type ollama), `activeModel(cfg)`, `listModels`,
`testProvider`. `cfg.provider` names `ollama`, `portkey` (the two config.json blocks) or a key of `cfg.providers`.
provider-presets.ts holds the types (base URL, key variable, headers) and `validateProviderEntry`, which the
settings layer, the JSON Schema and the command share; checks.ts holds the field checks, each carrying its schema
(`settingsSchema()` in settings.ts writes docs/settings.schema.json, `npm run schema`).

Keys stay in the main process: `windowConfig(cfg, owned)` is the window's copy (keys and header values masked, the
providers resolved in `providerView`), used by `config:get`/`config:set`/`config:changed`; `acceptFromWindow` puts the
real keys back on the way in and ignores `providers` (changed by the files, the command and `providers.setModel`).
`scrubSecrets` takes every resolved key out of a message; the agent's errors and `plainError` go through it.

`bin/silo.js` (the command, shipped as Contents/Resources/bin/silo and run by the app's Electron in
Node mode) loads dist/main/settings.js, config.js, provider-presets.js and providers.js, none of which load Electron
(config.ts requires it lazily in `configPath()`), and writes only the user's settings.json.

## App (src/main/app.ts)

```ts
export type Disposer = () => void;
export type Command = CommandInfo & { run(args: string, ctx: { sessionId: string }): CommandResult | Promise<CommandResult> };
export interface App {
  readonly userData: string;                       // Electron's userData folder
  readonly appRoot: string;                        // app.getAppPath()
  config(): AppConfig;
  updateConfig(change: Partial<AppConfig> | ((current: AppConfig) => AppConfig)): AppConfig; // normalise, save, onConfig, push 'config:changed'
  onConfig(cb: (next: AppConfig, prev: AppConfig) => void): Disposer;
  window(): BrowserWindow | null;
  push<K extends keyof RpcEvents>(channel: K, payload: RpcEvents[K]): void;   // dropped without a window
  readonly rpc: { handle<K extends keyof RpcMethods>(method: K, fn: (...args: Parameters<RpcMethods[K]>) => ReturnType<RpcMethods[K]> | Promise<ReturnType<RpcMethods[K]>>): Disposer };
  readonly store: SessionStore;
  readonly runtime: SessionRuntime;
  readonly events: { on(cb: (sessionId: string, ev: AgentEvent) => void): Disposer };  // every event of every session, in order
  readonly tools: { register(tool: Tool): Disposer; list(): Tool[] };
  readonly prompt: { add(id: string, section: (info: { cwd: string; mode: PermissionMode; sessionId: string }) => string, opts?: { optional?: boolean; restricted?: boolean }): Disposer };
  readonly commands: { register(cmd: Command): Disposer; list(): CommandInfo[] };
  provide(name: string, service: unknown): Disposer;
  service<T>(name: string): T | undefined;
  onQuit(fn: () => void | Promise<void>): void;   // last registered first, 3 s each, after every run was stopped
}
```

- Registering a name twice (tool, prompt id, command, RPC method, service) throws; a disposer removes only its own entry.
- `updateConfig` puts a new working directory first in `recentDirs`. Folder invariant: `config.workingDirectory`
  is the folder of the session on screen. Bringing a session on screen moves the app there (if the folder still
  exists; otherwise the session adopts the app's folder); changing the folder from the UI moves the session on
  screen. A run keeps the folder it started in. MCP project servers and the settings.json project layer follow the
  app's folder only, not each session's: a known limit.
- Registered tools: `Tool.readOnly` decides whether plan mode offers them. Prompt sections are appended after the
  project instructions; an empty string adds nothing.
- A tool that is not needed for plain coding work is registered with `optional: true`, and the prompt section that
  explains it with `{ optional: true }`. Both are left out of a request when the tool set is trimmed
  (`AppConfig.toolSet`: `auto` trims under a 32k-token window, `all` never, `essential` always; `essentialToolsOnly`
  in agent.ts), and the model is told what is off. The scheduling, session and mod tools are registered this way.
- **A session with a tool set of its own** (`Session.tools`, a list of names; a dream's session): its agent is offered
  exactly the built-in and registered tools it names, in every permission mode, and never an MCP tool; the system prompt
  names those tools instead of describing the shell and the browser, leaves out the mode text, the skills list, MCP and
  the instructions files, and gets only the prompt sections added with `{ restricted: true }` (which no other session
  gets). A tool registered with `scoped: true` is offered to no session whose tool set does not name it.
- `runtime.claimPlans(fn)` lets a feature decide a plan of its own (a dream's, `PlanInfo.kind: 'dream'`): the runtime
  marks the plan decided and, when `fn` returns true, neither switches the permission mode nor starts a build run.
- `AppHost` (the concrete class) adds `invokeRpc`, `showSession`, `promptFor`, `runQuit`, `setWindow`, `mcp`,
  `terminal`, `artifacts`. Features should use `App` only. `createApp(opts)` works without Electron (tests).

## SessionRuntime (src/main/runtime.ts)

```ts
foregroundId(): string;                      setForeground(id): Session;   onForeground(cb: (id, prev) => void): Disposer;
get(id): Session | undefined;                agentFor(id): Agent;          // made on first use, bound for life
create(opts?: { cwd?; parentId?; origin?: SessionOrigin; title?; foreground? }): SessionMeta;
send(id, text, attachments?, opts?: { origin?: MessageOrigin; from?: string }): SendResult; // run, or queue when running
stop(id): void;  stopAll(): void;  isRunning(id): boolean;  running(): string[];   // MAX_RUNNING = 6
status(id): SessionStatus;  live(id): LiveState;  meta(id): SessionMeta;  list(): SessionMeta[];  // metas carry status
respondApproval(id, ok, always?, scope?): boolean;   // finds the agent holding the card; mode switch / project rule for that session's folder
respondPlan(sessionId, planId, decision): void;       // marks the plan; build decisions switch the mode and start the build (unless a claimPlans handler takes it)
claimPlans(fn: (sessionId, plan, decision) => boolean): Disposer;
findApproval(id) / findQueued(id): Agent | undefined;  forget(id): void;  planDecided(id): void;
onEvent(cb: (sessionId, ev) => void): Disposer;  onStatus(cb: (sessionId, status) => void): Disposer;  onListChanged(cb): Disposer;
emit(id, ev): void;                          // an event no run produced (a merge note appended between runs)
```

Every agent emits through the runtime, which notes the event in the session's LiveState/status, hands it to
`onEvent` listeners (= `app.events`), then to the window as `('agent:event', ev, sessionId)`, deltas coalesced every
30 ms per session. `send` with a non-user origin to a running session queues it like a typed message; if the run is
stopped before delivery the message is dropped (`queue_dropped`), so the sender decides whether to resend.
Status: `running`; `attention` 'approval' while an approval card waits, 'question' while an ask_user card waits,
'plan' after a run ended with an undecided plan;
`unread` (stored on the session) when a run ended off screen, cleared by `setForeground`. Shared resources: the
browser pane belongs to the session on screen (a background `browser_*` call gets an error result; a background
artifact is stored without navigating). Terminal tabs and MCP servers are shared.

## Agent, tools, store

- `new Agent(getConfig, browser, store, getSkills(cwd), emit, terminal?, artifacts?, mcp?, opts?: { session?, app?, foreground?, tools?, prompt? })`.
  `run(text, attachments?, { origin?, from? })`, `enqueue(text, attachments?, { origin?, from? })`, `cwd()`.
- Events added: `user_message { text, images, origin, turn?, from? }` after each user message enters the
  conversation, `assistant_message { text, toolCalls }`, `approval_resolved { id, ok, scope }`, `run_end.text`.
- `ToolContext` adds `sessionId`, `app?`, `foreground()`, and `approve(name, detail, target?, { custom?, alwaysAsk? })`:
  a custom approval is refused in plan mode, asks in ask/acceptEdits/auto, runs in bypass unless `alwaysAsk`; its
  card has only Allow and Deny (`alwaysLabel`/`projectLabel` are '').
- `SessionStore.append(s, msg)`, `truncate(s, length)`, `replaceAll(s, msgs, reason)` are the only writes to
  `session.messages`. `onMutation(cb: (session, op: SessionMutation) => void)` also reports `save`, `create`,
  `fork { from, seedLength }`, `rename { title }` and `delete` (before the file goes). Compaction uses reason 'compaction'.
- `Session` has `cwd`, `parentId`, `origin`, `unread`, `seedLength`; checkpoints (`Turn`) keep a message's `origin`/`from`,
  which `toTranscript` puts on the user item. `toTranscript(s, { running })` leaves out tool calls still in flight.

## RPC (src/shared/rpc.ts) and preload

`oc.rpc(method, ...args)` → one `ipcMain.handle('rpc')` → `app.rpc.handle` registry (unknown names reject).
`app.push(channel, payload)` → one `'rpc:push'` channel → `oc.onPush(channel, cb)`. Features extend
`RpcMethods = CoreRpc & …` and `RpcEvents = CoreEvents & …` in rpc.ts. Core methods: `commands.list`,
`commands.run(name, args)`, `sessions.live(id)`, `sessions.transcript(id)`. Core pushes: `config:changed`,
`sessions:changed` (the list with statuses), `sessions:show` (a notification was clicked).

`sessions:switch` takes the transcript and the LiveState at the same instant (after flushing that session's
pending deltas); the next `sessions.live(id)` returns that snapshot, and every later event reaches the window
after the switch reply. The renderer buffers the session's events between the two replies and replays them.

## Renderer seams

- `bus.ts`: `bus.on(name, cb)` / `bus.emit`. Events: `'agent-event' (ev, sessionId, onScreen)` for every event
  before renderer.ts handles it, `'session-shown' (sessionId)` after a switch/new/fork rendered, `'config' (config)`
  whenever the window's copy changes, `'sessions' (metas)` after each list refresh.
- `rpc.ts`: typed `rpc(method, ...args)` and `onPush(channel, cb)`.
- `transcript-items.ts`: `registerTranscriptItem(role, render: (item) => HTMLElement | null)`, used by
  `renderTranscript` for roles it does not know; `appendTranscriptItem(item)` appends one live. Dreaming registers
  `proposal` (a `propose_*` call, `{ role: 'proposal', proposalId, … }` from `toTranscript`), drawn from the dreams the
  window keeps (dreaming.ts).
- `renderer.ts`: events of the session on screen go to `handleEvent` as before; others update the sidebar status
  (spinner, `.status-dot.attention`, `.status-dot.unread` inside `.trail`). `showSession(id)` renders transcript +
  LiveState. Hook a feature up under its marker in the "Feature wiring" block above `// ---------- Init ----------`
  (`// [feature:mods]`, `pages`, `settings`, `sidebar`, `tasks`, `images`, `history`, `schedules`, `subagents`, `remote`, `dreaming`).
- `pages.ts`: pages in the main column in place of the session (`.shell.page-open` hides `.content` and the top bar's
  title and buttons, and the native browser view). A route (`scheduled`, `task`, `dreaming`, `project`) is rendered by
  a page module (scheduled-page.ts, dreaming-page.ts) into `#page-view`, which returns its breadcrumb for the top bar
  (`#page-crumbs`). `'session-shown'` closes the page; `⌘[` goes back. The pure words, filters, templates and the New
  task form's rhythm are in pages-model.ts (checked headless by test/pages.js). Debug: `__oc_debug.pages`.

## Dreaming (src/main/dreaming.ts, src/main/dreaming/)

```
digest.ts   a session's turns from its history log (sessionTurns), the dream's first message (buildDigest), history_read's text
apply.ts    proposals as files: checkSkill / checkMemory / checkMod, applyProposal, revertProposal, the allowed places
tools.ts    history_read, history_search, propose_skill, propose_memory, propose_mod, withdraw_proposal (scoped)
service.ts  Dreaming: projects(), start(trigger, cwd?), one dream at a time, the modes, the plan, tick() for the daily dream
store.ts    dreaming.json (atomic): dreams with proposals, what applying replaced, cursors, the daily mark
names.ts    the defaults and the proposal tool names (src/shared is types only; the window keeps its own copy)
```

A dream is a session with `origin: 'dream'`, `Session.dream = { id, waiting }` (the sidebar reads `SessionMeta.dream`) and
`Session.tools` set to the reading and proposal tools, so it stays a dream after a restart. Services: `app.service<Dreaming>('dreaming')`;
it reads logs through `HistoryService.read`. RPC: `dreaming.get|set|run|stop|list|projects|apply|dismiss|applyAll|revert`, push
`dreaming:changed`. Nothing for mods through the bridge yet.
