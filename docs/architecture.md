# Architecture: the App, the session runtime and the seams

Feature code lives in its own files; `index.ts`, `preload.ts` and the core of `renderer.ts` need no edits for a feature.

## Main process

```
index.ts       buildApp() → registerCoreIpc(app) → setupSettings … setupPower(app) → createWindow()
app.ts         AppHost implements App: config, store, runtime, event bus, RPC registry, registries, services, quit
runtime.ts     SessionRuntime: one Agent per session, concurrent runs, foreground, LiveState, SessionStatus
ipc.ts         the existing typed channels (window.oc.*) + the generic 'rpc' channel
agent.ts       Agent: one run loop bound to one session for its life (approvals, hooks, context accounting, compaction, tool execution)
agent/         prompt.ts (the system prompt and its parts), complete.ts (one model call, streamed or not, and its fallbacks),
               permissions.ts (the permission rules as a pure decision, and the card's labels), errors.ts (what a run's errors say),
               classifier.ts (Auto mode's safety check: its instructions, what it reads, its model, its answer),
               auto-rules.ts (what always asks in Auto mode, protected paths, the words of a block),
               learned.ts (the user's answers on cards, which the check reads as earlier decisions),
               schedule.ts (which calls of one reply run together: read-only ones, the rest alone, results in call order),
               perf.ts (where a run's time goes: numbers per run, turn and tool call, the /timing note, the timing log)
timing-service.ts  /timing, the last run's breakdown as a local note
auto-blocks.ts the blocks of this app session: Allow, Settings → Permissions → Recently blocked, the auto.* RPCs;
               the learned answers' store (auto-learned.json) and Settings → Permissions → Auto mode
context-window.ts  contextLimit, essentialToolsOnly, allGroupsUpFront, FULL_TOOLS_WINDOW: facts about the provider and the config (agent.ts re-exports some)
sessions.ts    Session, SessionStore (the only place messages change), toMeta, toTranscript, rewindSession, the Msg alias
json.ts        isRecord, the guard config.ts, settings.ts and provider-presets.ts share (no dependencies, like env.ts)
browser/       the Browser pane's main-process side (below)
tools/browser.ts  the browser_* tools and their guard (below)
tools/groups.ts   the tool groups loaded when needed, load_tools, and the groups a message clearly needs (below)
```

## The browser (src/main/browser/, tools/browser.ts)

```
index.ts         what the rest of the app imports: BrowserController, SessionTabs, setupBrowser, openChatLink, browserSession, zoomMenuItems
session-tabs.ts  SessionTabs: a BrowserController per session, made on first use; the pane shows the session in front's,
                 the others are parked (views off the window at the pane's size); deleting a session closes its tabs
controller.ts    BrowserController: one session's tabs (MAX_TABS 12; one active, the others hidden), the active view's bounds,
                 what that session's browser_* tools do on its active tab, the agent's action stamps (acting()), find, zoom, the context menu's
                 actions, DevTools, the blocked-popup strip, a popup's tab (tabIdOf), the certificate interstitial's state
tab.ts           BrowserTab: one WebContentsView in persist:browser, its TabState, the shortcuts pressed in the page
                 (shortcutOf: ⌘⇧N ⌘W ⌘L ⌘F ⌘+ ⌘− ⌘0 ⌥⌘I, taken in before-input-event so neither the page nor the menu sees them)
page-scripts.ts  the scripts run in the page: the outline with refs, text, find, wait, scroll, click targets, credential checks
safety.ts        credential fields (credentialKind) and their redaction; the prelude in the page's own isolated world
                 (SAFETY_WORLD), out of reach of the page and of browser_eval
policy.ts        pure: sites (siteOf), exempt hosts, sensitive sites, navigationRule, siteDecision, the eval guard, clickRule
                 (CAPTCHA, purchase, account), typeRule/keyRule (CREDENTIAL_REFUSAL), the card's words
session.ts       the persist:browser profile: user agent, spell checker, the cookie migration and its one-time note, Keep
                 cookies, Clear browsing data
popups.ts        window.open and target=_blank: a tab, a background tab, a floating card (createWindow keeps the opener),
                 or blocked (a fourth popup); the card's bar (popup-bar-preload.ts)
permissions.ts   the permission bar's policy and store (userData/browser/permissions.json), requests per tab, USB/HID/serial refused
certificates.ts  certificate errors: the tab's interstitial state, Proceed for this run (host + fingerprint), the pill's security
downloads.ts     will-download: sanitised unique names, the list (userData/browser/downloads.json), the agent's downloads paused for the bar
find.ts          find in page: findStep (new search or next/previous), PageFinder over findInPage / found-in-page, "3 of 12"
zoom.ts          zoom per site: Chrome's steps, the store (userData/browser/zoom.json, by host), applySavedZoom, the View menu's items
context-menu.ts  contextMenuTemplate(params, state), pure; the native menu (not popped up in the live tests: lastContextMenu)
feature.ts       setupBrowser(app): the browser.* RPC methods and pushes (shared/browser.ts), the safety wiring, quit;
                 openChatLink (the main window's window-open handler: the pane or the default browser)
```

`tools/browser.ts` is the guard every browser tool passes before it runs: `credentialCheck` (a password, code or card
field away from an exempt host is refused before anything is typed), `siteCheck` (the site card, the sensitive and sign-in
cards, browser_eval's card, refused schemes and plan mode, all from `policy.siteDecision` through `ctx.approve` with
`browser: { card, site }`), and for browser_click `clickCheck` (CAPTCHA refused, purchase and account cards). browser_type
also has the controller ask the page again after its own click (`allowSecret` only on an exempt host). Results and errors
have the page's credential values replaced with `•••`. The window's side: `browser-pane.ts` (the page tabs in the pane's strip, the popups'
state, the profile note, the zoom chip, the blocked-popup strip), `browser-bars.ts` (the permission and download bars, the
certificate interstitial, the lock in the URL pill, the downloads tray), `browser-find.ts` (the find bar), all created by
`side-pane.ts`; `settings/browser-section.ts` is Settings → Browser. None of them can answer a bar for the agent: the
answers are RPC methods only the window calls.

Feature setups, in this order, before the window opens: `setupSettings` (settings-service.ts), `setupHistory` (history.ts),
`setupContext` (context-service.ts), `setupImages`, `setupMods`, `setupSchedules`, `setupSubagents`, `setupRemote`,
`setupPower`, `setupDreaming`, `setupProviders` (providers-service.ts), `setupBrowser` (browser/feature.ts), `setupChatCards`
(chat-cards.ts) (each in its own file).

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
  readonly prompt: { add(id: string, section: (info: { cwd: string; mode: PermissionMode; sessionId: string }) => string, opts?: { optional?: boolean; restricted?: boolean; perSession?: boolean; group?: ToolGroup }): Disposer };
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
  explains it with `{ optional: true }`. Both are left out altogether when the user chose the essential tools
  (`AppConfig.toolSet: 'essential'`, `essentialToolsOnly` in context-window.ts), and the model is told what is off.
  The scheduling, session and mod tools are registered this way. (`auto` used to do the same under a 32k-token window;
  as tool groups, below, they cost nothing until loaded.)
- **Tool groups** (tools/groups.ts): `Tool.group` puts a tool in one of five groups, `browser`, `terminal`, `sessions`,
  `schedules` and `mods` (the browser and terminal tools say so themselves; the features register theirs with it), and
  `{ group }` does the same for a prompt section. Every tool definition goes with every request, and these took about
  half of the fixed part of each one, so the agent splits what a session may use (`toolPool`: mode, trimming, a tool
  set of its own) from what a request offers (`toolsFor`). It is built so that a provider's prompt cache keeps working:
  - The tools only grow at the end: the pool's core tools with `load_tools` after the built-in ones, then each loaded
    group's tools in the order the session loaded them (`Session.toolGroups` keeps that order). Nothing is unloaded or
    reordered; a load changes the list once.
  - `load_tools`'s definition never changes in a session: one line per group the session can load (≤250 characters),
    loaded or not, and an enum of them.
  - The system prompt never changes as groups load: it names the groups in one line, and the browser's rules, the
    Terminal pane and a group's registered sections are not in it. They come in the load's result (`groupLoadText`:
    `GROUP_GUIDANCE` for the built-in groups, `promptFor({ onlyGroup })` for the registered ones), in the conversation.
  - A loaded group stays loaded: saved with the session, copied on fork, untouched by compaction and rewinds. When a
    compaction folds a load's result, the brief repeats it (`foldedGroupsText`, a section of `compactedPreamble`).
  A group is loaded by `load_tools`, by a call to one of its tools by name (before the reply's calls are stored, so
  `shownArgs` and hooks see the tool; the agent stores a `load_tools` call of its own first in that reply, with the
  load's result, then the call runs as usual), or before the first request by a message that clearly needs it
  (`groupsForMessage`: a web address it asks to open, or one named with the word browser; other sessions or this one's
  name; any message from another session loads `sessions`; again a `load_tools` call of the agent's own, right after
  the message and its context note). `load_tools` is the agent's own: it runs before the reply's other calls,
  without a tool row, an approval or hooks; `toTranscript`, the export and Auto mode's check leave its calls out.
  `toolSet: 'all'` (`allGroupsUpFront`) offers every group from the first request, with the browser's rules, the
  Terminal pane and every section in the system prompt, and no `load_tools`; a session with a tool set of its own has
  no groups. The context meter's "Tool definitions" is what the request offers. A native Anthropic path could send
  every group's tools from the first request marked `defer_loading` (the pool, in the same order) and have `load_tools`
  return `tool_reference` blocks, with the cache breakpoint on the last core tool; the groups are described in one
  place for that.
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
stopped before delivery the message is dropped (`queue_dropped`), so the sender decides whether to resend (a message
from another session is held instead: see Messages between sessions).
Status: `running`; `attention` 'approval' while an approval card waits, 'question' while an ask_user card waits,
'plan' after a run ended with an undecided plan;
`unread` (stored on the session) when a run ended off screen or a message from another session reached it there, cleared by `setForeground`. Shared resources: the
browser's tabs are per session (a background session's `browser_*` calls act on its own tabs, out of sight; a background
artifact is stored without navigating). Terminal tabs and MCP servers are shared.

## Agent, tools, store

- `new Agent(getConfig, browser, store, getSkills(cwd), emit, terminal?, artifacts?, mcp?, opts?: { session?, app?, foreground?, tools?, prompt? })`.
  `run(text, attachments?, { origin?, from? })`, `enqueue(text, attachments?, { origin?, from? })`, `cwd()`.
- Events added: `user_message { text, images, origin, turn?, from? }` after each user message enters the
  conversation, `assistant_message { text, toolCalls }`, `approval_resolved { id, ok, scope }`, `run_end.text`.
- `ToolContext` adds `sessionId`, `app?`, `foreground()`, and `approve(name, detail, target?, { custom?, alwaysAsk?, sessionKey?, sessionLabel? })`:
  a custom approval is refused in plan mode, asks in ask/acceptEdits/auto, runs in bypass unless `alwaysAsk`; its
  card has only Allow and Deny (`alwaysLabel`/`projectLabel` are ''), unless it has a `sessionKey`: then `alwaysLabel`
  is its `sessionLabel`, "for this session" records the key on the agent, and a later call with that key runs without
  a card (never a project rule; plan mode still refuses).
- A tool whose arguments can hold a secret has `shownArgs(args, ctx)`: asked before the assistant message is stored, it
  gives the arguments the transcript, the tool row and hooks get (browser_type's text into a password field is
  `•••`); the call runs on the real ones. A call that finds a secret only while it runs returns `hiddenArgs`, and the
  stored call is hidden then (the history log's copy of the message, written before, keeps the text).
- `SessionStore.append(s, msg)`, `truncate(s, length)`, `replaceAll(s, msgs, reason)` are the only writes to
  `session.messages`. `onMutation(cb: (session, op: SessionMutation) => void)` also reports `save`, `create`,
  `fork { from, seedLength }`, `rename { title }` and `delete` (before the file goes). Compaction uses reason 'compaction'.
- `Session` has `cwd`, `parentId`, `origin`, `unread`, `seedLength`; checkpoints (`Turn`) keep a message's `origin`/`from`,
  which `toTranscript` puts on the user item. `toTranscript(s, { running })` leaves out tool calls still in flight.

## Messages between sessions (src/main/subagents/, src/renderer/session-messages.ts)

`session_send`, `/send` and `sessions.message` go through `Subagents.message()`: one head line frames the text,
`[Message from session "<title>" (<id>), your <relation>. Not from the user: … reply with session_send to <id>.]`
(`messageHead`; one line with no `]` inside, which `origin.ts`, `remote/app.js` and `test/origin.js` rely on), then
`runtime.send(…, { origin: 'session', from })` starts a run or queues it for the next turn boundary (through
UserPromptSubmit, which sees `silo_origin`/`silo_from_session`). Parent and own sub-sessions need no approval
(`closeKin`); any other target asks with `sessionKey: 'session_send:<id>'`; a session with a schedule or a dream in its
parent chain (`unattended`) is refused anything but its kin, without a card. While the receiver's plan waits
(`attention === 'plan'`) messages and sub-session reports are held in memory, in order, and handed over on the tick
after `onStatus` says it no longer waits (so a build run starts first); a message still queued when a run ends is held
again rather than dropped; a deleted session's go with it. The prompt section `session-messages` (not optional) is
there once the session has a turn with origin 'session' or is a sub-session. The runtime sets `unread` on an off-screen
session as soon as such a message reaches it. In the window an item or event with origin 'session' is a
`.msg.user.session-msg` line (`transcript.addUserRow` keeps Copy, Rewind and the matching to transcript items), and a
`session_send` call is a line of its own (`ownRow` in tool-groups.ts: a ToolCard that is not a `.tool`, so it never folds).

## RPC (src/shared/rpc.ts) and preload

`oc.rpc(method, ...args)` → one `ipcMain.handle('rpc')` → `app.rpc.handle` registry (unknown names reject).
`app.push(channel, payload)` → one `'rpc:push'` channel → `oc.onPush(channel, cb)`. Features extend
`RpcMethods = CoreRpc & …` and `RpcEvents = CoreEvents & …` in rpc.ts. Core methods: `commands.list`,
`commands.run(name, args)`, `sessions.live(id)`, `sessions.transcript(id)`. Core pushes: `config:changed`,
`sessions:changed` (the list with statuses), `sessions:show` (a notification was clicked, or every session was deleted and this is the fresh one).

`sessions:switch` takes the transcript and the LiveState at the same instant (after flushing that session's
pending deltas); the next `sessions.live(id)` returns that snapshot, and every later event reaches the window
after the switch reply. The renderer buffers the session's events between the two replies and replays them.

## Renderer modules

`renderer.ts` is the composition root: the window's config, the error shown next to a control, the debug hook
(`window.__oc_debug`), the feature wiring, init, drag-and-drop and the welcome suggestions, plus the parts that reach
into everything (the composer and sending, the "#" line, registered commands, `handleEvent`, rewind, the keyboard
shortcuts, the MCP and rules panels). Everything else is a module made with a `createX(deps)` factory, called at the
point in `renderer.ts` where its code stood (so every listener is registered in the same order), and reached through
what the factory returns. Mutable state several modules read stays behind accessors (`running()`, `compacting()`,
`statusState()`, `currentSessionId()`, `sessions()`, `titleEditing()`).

```
transcript.ts     following new content, user and system bubbles, the streaming reply and the thinking block, the transcript's clicks
chat-cards.ts     the pull request and document cards under a reply (what a reply names, and what the calls before it made); the
                  rules and words in chat-cards-model.ts (checked headless by test/chat-cards.js); `gh pr view` through the
                  RPC `cards.pullRequest` (src/main/chat-cards.ts and chat-cards/, contract src/shared/chat-cards.ts)
file-card.ts      the compact card of a file (tile, title, "Document · MD"), for documents and artifacts (artifacts.ts)
tool-groups.ts    tool rows and the runs that fold into one line (settleRun, updateGroup, refoldAll); the rows still running
session-messages.ts  "Received message from …" and "Messaged …" lines, the other session's name linked
approvals.ts      the approval card and the question card, and which one waits
status-line.ts    run state, the status line, the spinners' one timer, compaction status, /compact, the context meter
side-pane.ts      the pane's one strip (page tabs, and Diff, Terminal and the mods' panes as tabs), the pane toggle, the resizer, the URL bar, the native browser view's bounds
strip-fit.ts      how the strip shares its width: natural widths, shorter titles, icon-only tools, icon-only pages (pure; test/strip-fit.js)
browser-pane.ts   the browser's page tabs, popups, profile note, zoom chip and blocked-popup strip
new-tab-page.ts   a blank tab's page: the tools the strip can open
terminal.ts       the Terminal pane: an xterm per shell tab, and their own row of tabs, shown only while there are two or more
browser-bars.ts   the permission and download bars, the certificate interstitial, the URL pill's lock, the downloads tray
browser-find.ts   the find bar under the URL bar
settings/browser-section.ts  Settings → Browser
connection.ts     the Ollama check and banner, the setup strip and its actions ("Start Ollama"), the folder picker, the recent-projects row
sessions-view.ts  the session list and statuses, the session on screen (showSession), new/delete/fork, title editing
header.ts         the mode and model chips and their menus, applyConfigToUi, config:changed
slash-menu.ts     the "/" menu;  confirm.ts  the in-app confirmation;  shortcuts.ts  the shortcuts sheet
```

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
  (spinner, `.status-dot.attention`, `.status-dot.unread` inside `.trail`) through `sessions-view.ts`. `showSession(id)`
  (sessions-view.ts) renders transcript + LiveState. Hook a feature up under its marker in the "Feature wiring" block above `// ---------- Init ----------`
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
