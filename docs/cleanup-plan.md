# Cleanup plan: reorganise the code, change no behaviour

The code grew over eight releases in two days, built by many agents in parallel. This pass reorganises it so a reader
can find things, with no change in what users, mods (`docs/mods.md`), the `silo` command, the settings and session
files or the phone page see. Every step builds (`npm run build`), type-checks and passes `npm test`; the live suite
(`npm run test:live`, mock model) runs after each group of moves in the window or the agent loop and once at the end.
Each commit is one kind of change (one move, one split, one dedup) with a one-sentence message.

## What the survey found

### Size and shape

| File | Lines | What it mixes |
| --- | ---: | --- |
| `src/renderer/renderer.ts` | 4486 | the transcript, tool rows and their folding, approval and question cards, the composer and its menus, the status line, compaction status, rewind, the side pane (browser, diff, terminal), connection checks and the setup strip, recent projects, sessions, the slash menu, the MCP and rules panels, the shortcuts sheet, the debug hook, feature wiring, init, drag-and-drop, the welcome suggestions |
| `src/renderer/mods-host.ts` | 1922 | one factory, already sectioned (layout, theme, styles, looks, bridge, frames, rail, tabs, strip, workers, hooks, background, previews, seats, menu, events, cards, debug) |
| `src/main/agent.ts` | 1701 | the system prompt, the permission rules and approval cards, the hooks, the run loop, context accounting, the compaction pipeline, the queue, title generation, the model calls (streaming and not), tool execution |
| `src/renderer/styles.css` | 1610 | the app's stylesheet; its class names and tokens are what mods and themes style |
| `src/renderer/terminal.ts` | 1302 | the Terminal pane (one concern) |
| `src/renderer/tools.ts` | 1036 | tool rows (one concern) |

The main process is otherwise in good shape: each feature has a folder (`dreaming/`, `mods/`, `schedules/`,
`subagents/`, `hooks/`, `history/`, `remote/`, `images/`, `tools/`) and a thin `setupX(app)` file beside it, and
features talk through `app.service()` (`services.ts`) and `app.rpc`. The window has the same pattern for its newer
features (`createSidebar`, `createSettingsPage`, `createModsHost`, `createPages`, …); `renderer.ts` is where the older
code stayed.

### Duplicated helpers

- `isRecord` (an object-but-not-array guard) is written three times in the main process: `config.ts`, `settings.ts`,
  `provider-presets.ts`.
- `tilde` (home folder as `~`, by prefix) is written in `tools/terminal.ts` and inline in `terminal.ts`'s `describeTabs`.
- `type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam` is declared in seven main-process files;
  `sessions.ts` already exports it. `ToolCall` and `ToolSpec` are declared in both `agent.ts` and `ollama.ts`
  (`ollama.ts` exports `ToolCall`).
- `type Disposer = () => void` is declared in `app.ts` (exported) and again in `runtime.ts`.
- `escapeHtml` exists in `src/main/artifacts.ts` and `src/renderer/dom.ts`. These stay: they are different processes,
  and `src/shared` is types only (both `tsconfig.json` and `tsconfig.renderer.json` emit `dist/shared/*.js`, with
  different module formats; a runtime module there would be overwritten by whichever compiler ran last).
- `sleep` in `browser.ts` and `delay` in `terminal.ts` are the same one-liner. Left alone: a module for one line is
  more to read than the duplicate.
- In the window, `elapsed` and `seconds` (renderer.ts) and `formatDuration` (dom.ts) format time differently on purpose
  ("0s" vs. a 1s floor, padded seconds); `shortPath` (renderer.ts), `displayPath` (tools.ts) and `displayPath` (diff.ts)
  shorten paths by different rules (header width, working-directory relative with middle truncation, diff headers).
  Merging any of them would change what is shown, so they only move with their modules.

### Dead exports and unused code

Not referenced anywhere (src, test, bin, scripts, mods, modkit, remote, docs), not even in their own file:
`IMAGE_FILE` (`images/store.ts`), `backgroundUrl` (`main/mods.ts`), `MOD_PROTOCOL` (`mods/permissions.ts`),
`resetPreviewSheets` (`settings/look-preview.ts`), `lookTabOfKind` and `parseRequired` (`settings/model.ts`),
`ModEventName`, `ModRpcEvent`, `ModRpcResponse` (`shared/mods.ts`). Other `export`s that only their own file uses
are mostly types on public signatures and stay exported.

### Names from before the renames

Every remaining OpenCoder / OpenAgent / Open Harness / `open-harness` mention is compatibility code: `migrate.ts`
(moving the old folders), `paths.ts` (`.open-harness`, `OPEN_HARNESS_*` variables), `instructions.ts` and `skills.ts`
(the old file and folder names, still read), `terminal.ts` (the old environment variables, set alongside the new
ones for one release), `remote/server.ts` (the old request header from a page loaded before the rename),
`providers-service.ts` (the old command link), `bin/silo.js`, and the mod protocol's host name in
`renderer/mods/logic.ts` (`harness.info.app.name` stays "Open Harness" because protocol 1 shipped with it). The `oc`
prefix (`window.oc`, `__oc_debug`, `data-oc-ref`) and `oa-` temp-folder prefixes are the mod protocol and the live rig's
names. Nothing to rename.

### Leaky boundaries

- `contextLimit`, `essentialToolsOnly` and `FULL_TOOLS_WINDOW` live in `agent.ts` but are facts about the provider
  and the config, imported by `ipc.ts`, `dreaming/service.ts`, `mods/model.ts` and `mods/public-config.ts`, which
  otherwise have no business with the agent loop. They move to `src/main/context-window.ts`; `agent.ts` re-exports
  them because `test/*.js` loads them from `dist/main/agent.js`.
- `runtime.ts` redeclares `Disposer` instead of importing `app.ts`'s.

### Types declared twice between `src/shared` and `src/main`

None by shape. `ToolResult` (renderer `tools.ts` vs. main `tools/types.ts`) and `ModsHost` (renderer vs. main) share
a name for different things on different sides; left as they are.

### Tests

Eleven headless suites build an `ArtifactStore` with the same `rendererDir` expression. A `test/support` helper would
save a line each; low value, done last if there is time.

## What will be done, in order

1. **This plan** (one commit).
2. **Main-process dedups**, one commit each: `isRecord` gets one home (`src/main/json.ts`, next to `env.ts`, no
   dependencies so `bin/silo.js`'s loads stay Electron-free); `tilde` is exported from `terminal.ts` and used by
   `tools/terminal.ts`; the `Msg` alias is imported from `sessions.ts` everywhere; `ToolCall`/`ToolSpec` come from
   `ollama.ts`; `runtime.ts` imports `Disposer`.
3. **Dead exports removed** (one commit).
4. **`contextLimit` and friends move** to `context-window.ts` (one commit), re-exported from `agent.ts`.
5. **`agent.ts` split**, one commit per extraction, each a module under `src/main/agent/` with `agent.ts` keeping the
   `Agent` class and its public surface exactly (`dist/main/agent.js` is loaded by tests and `runtime.ts`):
   - `agent/prompt.ts`: the system prompt and its parts (`systemPrompt`, `systemPromptParts`, `PromptParts`,
     `ESSENTIAL_NOTE`), `userMessage`, `noToolsNotice`, `providerErrorMessage`, `errorMessage`.
   - `agent/complete.ts`: the model calls (`complete`, `completeStreaming`, `completeOnce`, `mergeUsage`) as
     functions over a small host interface (emit, report usage, the no-stream-usage and tool-support memories, maxOutput).
   - `agent/permissions.ts`: the permission rules as a pure decision (`decideApproval`: allow, refuse with a message,
     or ask with a reason and programs) and the wording of the card's labels; `Agent.requestApproval` and `Agent.ask`
     call them. The pending-card bookkeeping stays on the agent (the runtime reaches it).
   - The compaction pipeline (`autoCompactIfNeeded`, `compact`, `prune`, `fold`, `summarize`, `cutFor`,
     `requestToCarry`) and the context accounting stay methods of `Agent`: they read and write a dozen of its private
     fields and interleave store writes with events in an order the tests pin down. Moving them into a collaborator
     would mean threading that state through an interface for no gain in clarity. They are kept together under their
     own heading.
6. **`renderer.ts` split**, one commit per module, following the window's existing pattern (`createX(deps)` factories
   whose top-level statements run when the factory is called, at the same point in `renderer.ts` where the code was, so
   every event listener is registered in the same order as before). Mutable state that several modules read
   (`config`, `running`, `currentSessionId`, `sessions`, `statuses`) stays in `renderer.ts` behind getters. In order:
   - `shortcuts.ts`: the shortcuts sheet.
   - `slash-menu.ts`: the "/" menu.
   - `confirm.ts`: the in-app confirmation dialog.
   - `side-pane.ts`: the Browser, Diff and Terminal tabs, the rail resizer, the URL bar, the native browser view's
     bounds and visibility, the Diff and Terminal panes' creation.
   - `connection.ts`: the Ollama check, the banner, the setup strip's lines and actions, "Start Ollama", the folder
     picker and the recent-projects row.
   - `tool-groups.ts`: tool rows and the runs that fold into one line (`settleRun`, `updateGroup`, `refoldAll`, …).
   - `approvals.ts`: the approval card and the question card.
   - `transcript.ts`: scrolling, user and system bubbles, the streaming reply and thinking block, `renderTranscript`,
     the transcript's click handling, rewind.
   - `status-line.ts`: run state, the status line, spinners, compaction status, the context meter and `compactNow`.
   - `composer-view.ts`: the @ picker, autosize, ⌘↑/⌘↓ history, key handling, image attachments, the vision note, the
     lightbox, the queue height, sending (including "#" lines and local commands) and registered commands.
   - `sessions-view.ts`: the session list, `showSession`, new/delete/fork, title editing.
   - `header.ts`: the mode and model chips and their menus, `applyConfigToUi`, `config:changed`.
   The live suite runs after `side-pane`/`connection`, after `tool-groups`/`approvals`/`transcript`, and after the rest.
   `renderer.ts` is left with the shared state, the debug hook, the feature wiring, init, drag-and-drop and the welcome
   suggestions: the composition root.
7. **Tests**: the `ArtifactStore` helper, if time allows.
8. **`docs/architecture.md`** updated to the new layout (one commit).

## What will not be touched, and why

- `mods-host.ts`: already one factory with clear sections; its surface is the mod protocol, and the mods live suites
  check it closely. Splitting it brings little for the risk.
- `styles.css` and the other stylesheets: class names and tokens are what mods and themes style; reordering rules
  changes the cascade.
- `terminal.ts`, `tools.ts`, `settings/*`: each is one concern.
- The names mods, tests and the command load: `window.oc`, `__oc_debug.*`, every `dist/main/*.js` path a test or
  `bin/silo.js` requires, the files tests read as text (`src/renderer/dreaming.ts`, `tools.ts`, `markdown.ts`,
  `styles.css`), and the tool-definition scan over `src/main/**/*.ts` (`test/tool-labels.js`, `test/tool-activity.js`).
- `src/shared` stays types only (see above).
- Casts (`as unknown as`) over `window` and DOM globals, where the shape really is unknown to the compiler.
- Anything whose behaviour-neutrality is in doubt is left and listed in the report instead.
