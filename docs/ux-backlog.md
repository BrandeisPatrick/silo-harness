# UX backlog: closing the gap to Claude Code desktop

What Silo Harness still lacks, or does differently, compared with the Claude Code desktop app's day-to-day experience.
Ordered by how often a user would feel the difference. Items are ticked off as they land; each entry says where.

## Planned releases

Decided with the user on 2026-11-06; the version rule is in [releasing.md](releasing.md).

| Version | What | State |
| --- | --- | --- |
| 0.5.0 | The app in white and grey, like Claude Code: neutral surfaces in both schemes, every button white or grey, blue only where it carries meaning; the warm 0.4.0 palette kept as a "Paper" theme mod. The Mods page with its own tabs (Backgrounds, Chat bar, Conversation, Themes) | released 2026-11-06 |
| 0.6.0 | Named providers (OpenRouter, Portkey, OpenAI, Anthropic, Ollama, LM Studio, any OpenAI-compatible endpoint) set from `settings.json`, with a JSON schema, a guide written for coding agents, and a `silo` command that adds, selects and tests a provider without the window. The release also brings the new name, Silo Harness: the config and data folders move on first launch, and the old folder, file and variable names are still read | released 2026-11-06 |
| 0.7.0 | A liquid glass look (translucent, layered materials in the style of macOS 26) for the app and for the website: a bundled Glass theme mod, off by default, and the same treatment on the website. The user said it is not important, so it waited until 0.5.0 and 0.6.0 were out | released 2026-11-06 |
| 0.8.0 | Closer to Claude Code: hooks in Claude Code's format (settings.json and mods), the permission prompt and an ask_user question card in Claude Code's style, one quiet line per tool call, the rail, footer and status line laid out like Claude Code's | released 2026-11-07 |
| 0.9.0 | Scheduled tasks and Dreaming as pages (cards, a task page with its runs, runs as regular ⚡ sessions); looks previewed and used without switches; the rail and mod tabs open and close like the browser | released 2026-11-09 |
| 0.9.1 | Fixes: credentials typed into the Browser pane hidden from the agent, permission prompts for pages; the renderer and the agent split into modules | released 2026-11-09 |
| 0.10.0 | The Browser pane as a browser: its own profile with sign-ins carried over, tabs, sign-in popups as cards, per-site approval for the agent, sensitive sites, credentials and CAPTCHAs refused, purchases and accounts asking, a permission bar, certificate warnings, downloads, find, zoom, a context menu, Settings → Browser; Delete all sessions and Delete all custom mods | released 2026-11-09 |
| 0.11.0 | Cards in the chat for pull requests (from gh), documents and artifacts, as in Claude Code; messages between sessions as one quiet line in each conversation, with no user authority; the README opens with a demo | released 2026-11-09 |
| 0.11.1 | Fix: tool-call ids unique within a session, results paired with their own call (Ollama reused ids across runs) | released 2026-11-09 |

## Done in earlier rounds

Sessions sidebar (day groups, search, rename, fork, delete, generated titles) · transcript with tool rows, diffs,
thinking blocks, grouped reads · approval cards with keyboard answers and "allow for this session" · permission
modes incl. plan mode with plan cards · Browser, Diff and Terminal panes · image paste, queued messages, artifacts ·
MCP servers · context meter, auto-compaction and `/compact` · project instructions (SILOHARNESS.md / AGENTS.md / CLAUDE.md).

## Backlog

| # | Gap | Why it matters | Status |
| --- | --- | --- | --- |
| 1 | **`@` file mentions** in the composer: typing `@` opens a fuzzy file picker over the working directory; the chosen file's contents go to the model with the message | The most used composer feature in Claude Code; today paths are typed or dropped by hand | done (tick 1) |
| 2 | **"Always allow … for this project"** on approval cards, persisted per working directory, with a Settings list to remove rules | Session-only allows mean re-approving `git`/`npm` every day | done (tick 1) |
| 3 | **System notifications** when a run finishes or waits for approval while the app is in the background (plus a Dock badge) | Long local-model runs are left alone; the desktop app tells you when to come back | done (tick 1) |
| 4 | **Rewind** to an earlier message: restore the files changed since then and reopen that prompt in the composer (Claude Code's checkpoints / `/rewind`) | The way out when a run went wrong | done (tick 2) |
| 5 | **Task list** maintained by the agent (a checklist card that updates in place while it works) | The desktop app pins the agent's plan under its latest message | done (tick 2) |
| 6 | **Message actions on hover**: copy a user message, re-send an edited one | Small, constant friction | done (tick 2) |
| 7 | **`#` memory shortcut**: a message starting with `#` appends to the project's instructions file after confirmation | Claude Code's quick way to teach the project | done (tick 3) |
| 8 | **Keyboard polish**: Esc Esc for rewind, ⌘↑/⌘↓ history in the composer, ⌘⇧C copy last reply | Power-user parity | done (tick 3) |
| 9 | **Welcome and empty states**: recent sessions and project hints on the empty screen, first-run checklist (Ollama running, model pulled, folder chosen) | First five minutes | done (ticks 3–4) |
| 10 | **Transcript details**: collapse long tool output by default with "show more", sticky date dividers, unread marker when returning to a session | Reading long sessions | done (tick 4) |
| 11 | **Diff pane review**: accept/revert per hunk, "open in editor" per line | Reviewing larger changes | later |
| 12 | **Subagents / background tasks** with a Tasks pane | Parallel work; heavy for small local models | done (0.2): sessions run concurrently; sub-sessions with `session_spawn` / `/spawn`, reports back, merge; a Sub-sessions panel |
| 13 | **Mods**: an open protocol for panels, tabs, a composer strip, backgrounds, themes and commands, written and edited live by the agent | The right-hand panel of the desktop app, made extensible | done (0.2): [mods.md](mods.md) |
| 14 | **Sidebar**: navigation rows, day groups, forks and sub-sessions as a tree, unread and waiting marks, search inside conversations | Finding and following many sessions | done (0.2) |
| 15 | **Settings page** with sections, search, changes applied at once | The old form could not hold what the app grew | done (0.2) |
| 16 | **Images in replies** and thumbnails on tool rows | "Here is the screenshot" should show the screenshot | done (0.2) |
| 17 | **History**: append-only log, crash recovery, trash, export | Nothing said in a session should be lost | done (0.2) |
| 18 | **Compaction** that prunes first and keeps the recent turn | Long sessions on small windows | done (0.2) |
| 19 | **Scheduled tasks** the agent can create, **remote control** from a phone, **keep awake** | Work that goes on while you are away | done (0.2) |
| 20 | **Tools loaded on demand**: the model asks for a tool family (schedules, sessions, mods) when it needs it | Today a small window simply goes without them (`toolSet`) | next |
| 21 | **Per-session project context**: MCP servers and the project settings file follow each session's folder, not the one on screen | Background sessions in another project | next |
| 22 | **Mod protocol 2**: tools a mod provides to the model, a background page per mod, seats in the transcript and the status line | Mods that extend the agent, not only the window | next |
| 23 | **History, further**: thinking blocks restored on reload; search over messages a rewind removed | The log already holds both | later |
| 24 | **Remote control over HTTPS**, tried on real phone browsers | Plain HTTP is for networks you trust | later |
| 25 | **Sub-sessions in Auto mode**: decide whether starting one should still ask | Auto runs everything the guard does not flag, yet `session_spawn` shows a card | next |
| 26 | **Many mod tabs**: let the pane's tab strip scroll or fold into a menu | Past icon-only, tabs at the end fall out of view | next |
| 27 | **Provider wording**: "Gateway" instead of "Portkey" for any OpenAI-compatible endpoint; a long model name is cut in the sidebar footer | The label names one product among many | next |
| 28 | **Test rig captures through the main process** (`invalidate` + `capturePage`), and `browser_screenshot` in a hidden window | Screenshots of the hidden test window can be stale or tiled; the built-in browser's screenshot fails there | later |
| 29 | **Browser: real sign-in popups.** Sign in with Google, GitHub and Microsoft through their popups in a packaged build: the card opens, the sign-in completes in the opener, the card goes when the popup closes itself; Google does not refuse our user agent. Fall back to a child window in the same profile for a site that insists on a top-level window | The live suite covers the mechanics with a fixture only (docs/browser/review.md §5) | verify on a real build |
| 30 | **Browser: keys against the menu.** ⌘W in the page and in the pane's chrome closes the tab, never the window (the File menu's Close Window); ⌘+ ⌘− ⌘0 there zoom the page once and not the app; ⌥⌘I opens the page's DevTools, not the app's; ⌘F in the page opens the find bar | Native menu accelerators are not reached by the hidden test window's keys (CDP and sendInputEvent skip the menu) | verify on a real build |
| 31 | **Browser: dark mode** of the popup card's bar and frame, the permission and download bars, the find bar, the blocked-popup strip, the zoom chip and the interstitial | The live checks look at them in light; the popup card's bar is a page of its own, themed when it opens | verify on a real build |
| 32 | **Browser: memory per idle tab**, to settle the cap of 12 (detached views keep rendering, throttled) | A cap set by guess | verify on a real build |
| 33 | **Browser: the grey lock on a real HTTPS site**, "Not secure" on plain HTTP, the amber triangle after Proceed anyway on a real self-signed host | The fixture covers localhost only | verify on a real build |
| 34 | **Browser: the downloads tray's progress ring** on a large file, and an agent's download allowed while it is still in progress (it resumes, then moves into the folder) | Fixture files finish at once | verify on a real build |
| 35 | **Browser: USB, HID and serial refused** with a real device plugged in (WebUSB, WebHID, Web Serial pages) | The handlers are tested headless and with a page, not with a device | verify on a real build |
| 36 | **Browser: the right click and the find bar by hand.** The native context menu's items (Print…, Save as PDF… with its dialog, Inspect Element, Copy Image, Save Image As…), the find bar's highlight in the page, and the focus going back to the page after Esc | A hidden window takes no mouse input and shows no native menu: the live check reads the menu's labels and the find count only | verify on a real build |

Out of scope: hosted features (cloud sessions, remote control), Anthropic-specific fonts and branding, usage billing.

## Tick 3 renderer spec (items 7–9)

Contract: `OpenCoderApi.instructions.append(text)` → `{ path, label }` (main appends a bullet to the project's instructions file, creating `SILOHARNESS.md` when none exists) in `src/shared/types.ts`.

- **`#` memory shortcut**: a composer message that starts with `#` (followed by a space or text) is not sent to the model. Instead the existing confirm dialog asks "Add to the project's instructions?" with the text and the target label (from `oc.instructions.append` the first time it is known, else "SILOHARNESS.md"), OK = "Add". On OK call `oc.instructions.append(text without the leading #)`, then show a system notice "Added to SILOHARNESS.md" (the returned label) and clear the composer; on cancel keep the text. Images attached are ignored for this path (notice says so). While a run is going, `#` messages are still handled this way, not queued.
- **Keyboard**: `Esc` twice within 600 ms while no run is going opens the rewind confirm for the latest user message that has a `turn` (nothing happens when there is none); the single `Esc` keeps its meaning (stop a run, close menus). `⌘↑` / `⌘↓` in the composer when the caret is on the first/last line (or the composer is empty) walk through the session's previous user messages (newest first), restoring the draft when walking past the end; the history comes from the rendered user bubbles. `⌘⇧C` copies the last assistant reply's Markdown source (the same text the Copy button copies) and flashes a short "Copied" tooltip on the status area. Add the three to the shortcuts sheet.
- **Welcome and empty states**: the empty state gains a compact setup strip (`#setup-strip`) above the suggestion chips, shown only when something is missing: Ollama unreachable (reuse the connection check), the configured model not in `listOllamaModels()`, or the working directory still the home folder. Each line has a short action ("Start Ollama", "Pull a model" → shows the `ollama pull qwen3:8b` command with a Copy button, "Choose folder" → the existing cwd picker). It disappears once all three are fine; it is never shown for the Portkey provider except the folder line.
- **Debug hooks**: `__oc_debug.setup({ ollama: boolean, model: boolean, folder: boolean })` renders the strip directly; `null` restores the real checks.

## Tick 4 renderer spec (item 10 and the rest of item 9)

Contract: `AppConfig.recentDirs` (most recent first, at most 8; main maintains it when the working directory changes, and `readSettings()` must pass it through unchanged like `allowRules`).

- **Recent projects on the welcome screen**: under the setup strip and above the suggestion chips, a "Recent projects" row (`#recent-dirs`) with one chip per entry of `config.recentDirs` other than the current working directory (folder name, full path as tooltip, folder icon). Clicking a chip switches the working directory the way the title-bar picker does (`oc.setConfig` with the new `workingDirectory`, then the same UI refresh), without a notice in an empty session. Hidden when there is nothing to show.
- **Click-to-open paths**: in Read / Write / Edit / List tool rows, the path becomes a link-like control (hover underline, pointer; title "Open in editor") that calls `oc.changes.openInEditor(absolutePath)`; the absolute path is the row's `title` or is resolved against the working directory. Approval cards' paths too.
- **Long outputs**: a tool row body longer than 40 lines shows the first 40 with a "Show N more lines" control at the bottom (`.out-more`), which expands it; collapsing again is not needed. Assistant replies are never cut.
- **Debug hooks**: `__oc_debug.recent(dirs | null)` renders the row directly.

## How changes are verified

- `npm test` runs the headless suites in `test/` against the built app: a mock model server (OpenAI-compatible and Ollama-native) and a small stdio MCP server stand in for real services, so the agent loop, the session runtime, tools, approvals, compaction, history, schedules, sub-sessions, mods, remote control and settings are exercised without a model.
- `npm run test:live` drives the real app over the Chrome DevTools Protocol (`test/live/rig.js`): the window stays hidden and uses a throwaway profile and config folder, so it never touches your own. With `ANTHROPIC_API_KEY` set the runs talk to the real API; without it, to the mock model. The scripts type into the composer, answer cards, open Settings, switch sessions, kill the app mid-run and relaunch it, and take screenshots; `window.__oc_debug` offers hooks to render synthetic states.
- `node modkit/playground/serve.js` hosts mods outside the app with a mock behind the bridge, and `modkit/playground/shot.js` screenshots them.

## Tick 2 renderer spec (items 4–6)

Contract: `TaskItem`, the `tasks_updated` event, `SessionMeta.tasks`, `TranscriptItem.turn` and `SessionsApi.rewind` / `RewindResult` in `src/shared/types.ts`.

- **Hover actions on user bubbles** (`.msg.user`): a small action row that appears on hover (and on focus) at the bubble's top-right, like the Copy button on assistant replies: **Copy** (copies the typed text) and, when the item has a `turn`, **Rewind** (icon `rotate-ccw` or `history`). Live messages get their `turn` from the `sessions.current()` message count: the main process assigns one checkpoint per user message, so after a send the renderer can re-read the transcript (`sessions.switch(current.id)` after `run_end`) or keep a counter; simplest is to refresh the transcript items' `turn` values from `oc.sessions.switch(currentId)` once a run ends.
- **Rewind flow**: clicking Rewind opens the existing confirm dialog: title "Rewind to this message?", text "Files the agent wrote or edited after it go back to how they were, the later messages are removed, and the message returns to the composer. Changes made by commands are not undone." On OK call `oc.sessions.rewind(turn)`; re-render the transcript from `result.transcript`, put `result.text` into the composer (focus it, caret at the end), refresh the sessions list and the Diff pane, and add a system notice: "Rewound · N files restored" (plus "· M removed" and "· K could not be restored" when non-zero; "no files changed" when all are zero). Rewind is disabled while a run is in progress (the button is hidden then). Errors from the call show as an error notice.
- **Task list card** (`#task-list`): a card pinned under the transcript, above the status line and the queue, shown when the session has tasks (from `SessionMeta.tasks` on load/switch and from `tasks_updated` events; an empty list hides it). Header "Tasks" with "2 of 5 done" and a chevron to collapse (collapsed state remembered in localStorage); rows with a status glyph (pending: empty circle, in_progress: the app's spinner or a filled arrow, completed: check) and the title; the in-progress row is emphasised; completed rows are dimmed with a strike-through. It updates in place without flicker (keyed by id). Keep it compact: 13px rows, the card's own max height ~220px with scrolling.
- **Debug hooks**: `__oc_debug.tasks(tasks | null)` renders a list directly; `__oc_debug.user(text, images?, mentions?, turn?)` gains a `turn` argument so hover actions can be exercised without a run.
- Not in this tick: Esc Esc for rewind (item 8).
