# Reference

## Permission modes

| Mode | Behaviour |
| --- | --- |
| Ask | Commands, writes and edits show an approval card (default) |
| Accept edits | Edits inside the project run; commands ask |
| Auto | Everything runs except what the guard flags: sudo, destructive git, pushes, writes outside the project, piping downloads into a shell, publishing, cloud or macOS settings changes, secrets |
| Plan | Read-only exploration ending in a plan card you approve |
| Bypass | Everything runs |

## Approval cards

An action that needs your OK waits on a card, as in Claude Code: the question as its title ("Allow Silo Harness to run this command?"), then in muted text what the call does in its own words (a command's description, when the model gave one) and why it asks when the mode would not have (in Auto, "Auto mode stopped to ask: it pushes to a remote."; for a hook, the hook's reason), then the command or the change. At the bottom right: **Deny** and **Allow once ⌘↵**, with **⌄** for the wider answers, "Allow … for this session" (`A`) and "Always allow … in this project" (`P`), which cover a program, a flagged reason, an MCP server or edits. A tool's own question (a sub-session, a message to another session, a schedule) and a hook's "ask" have Allow once and Deny only.

Keys while a card waits: `⌘↵` allows once (also from the chat bar while you type), `Esc` denies (instead of stopping the run), `A` and `P` pick the scopes when the chat bar is empty or the ⌄ menu is open. Once answered the card goes; the call's row keeps the answer ("Allowed once", "Allowed git for this session", "Denied") at the top of its details.

Saved rules: Settings → Permissions. One thing asks in every mode, Bypass included: a schedule the agent wants to create or re-time, because it outlives the conversation.

## Questions

When a choice is genuinely yours (a preference, an unclear requirement, which of several approaches), the agent asks with `ask_user`, in every mode, Plan included, without an approval. The run waits on a card in the approval card's frame: the question as its title with its short header as a chip ("1 of 3" when there are several, shown one at a time with Next and Back), the 2–4 options as rows with a radio button, or a checkbox when more than one can apply, and **Other**, a field for your own words. Click anywhere on a row, or press `1`–`4`; `↑` `↓` move between rows; **Submit ⌘↵** sends the answers, **Skip** or `Esc` tells the agent "The user skipped the question." The status line says "Waiting for your answer", and the sidebar, the Dock badge and a notification say a session waits for you. The agent reads each question's header with the option you picked or what you typed. Answered, the card folds to one line, "Asked a question", with the answers inside. On the phone page a question with one answer per question is a set of buttons; anything more says to answer in the app.

## Keyboard

`⌘N` new session · `⌘[` back a page (Scheduled tasks, Dreaming) · `⌘B` sidebar · `⌘⇧E` mods rail · `⌘⇧B` browser · `⌘⇧D` diff · `⌘⇧T` terminal · `⌘T` terminal tab · `⌘K` focus composer · `⌘F` search · `⌘,` settings · `F2` rename · `Esc` stop · `Esc Esc` rewind to your last message · `⌘↑` `⌘↓` previous prompts · `⌘⇧C` copy last reply · `⇧Tab` cycle mode · `⌘/` shortcuts. While a card waits: `⌘↵` allow once or submit, `Esc` deny or skip, `A` `P` the wider scopes, `1`–`4` pick an answer.

## Slash commands

| Command | |
| --- | --- |
| `/<skill> [text]` | Run a skill; `/skills` lists them |
| `/compact [focus]` | Compact the conversation now; the focus says what the brief must keep |
| `/mcp` | MCP servers and their tools |
| `/spawn <task>` | Start a sub-session on that task |
| `/merge [name or id]` | Bring a finished sub-session or fork into this session |
| `/sessions [name]` | This session's parent, sub-sessions and forks; with a name, every session that matches it |
| `/send <name or id>: <message>` | Send a message to another session |
| `/rename [new name]` | Rename this session; alone, it makes the title in the top bar editable |
| `/schedules` | The scheduled tasks and their next run |
| `/dream` | Dream now about this session's project (see Dreaming) |
| a mod's commands | Listed in the menu with the mod's name |

A message starting with `#` is added to the project's instructions file after a confirmation (and recorded in the session's history log, where a dream sees it).

## Tools

| Tool | Purpose |
| --- | --- |
| `read_file` `write_file` `edit_file` `list_directory` `glob` `grep` | Files |
| `bash` | Shell command in the session's folder, with an optional short description of what it does (shown on its approval card); stopping the run stops the command and what it started |
| `terminal_run` `terminal_read` `terminal_list` `terminal_stop` | Terminal pane tabs |
| `browser_*` | Built-in browser: navigate, click and type by visible text, read, wait, screenshot, eval |
| `show_image` | Put an image (a screenshot, a chart, a picture in the project) inline in the reply |
| `create_artifact` | HTML, SVG, Markdown or code shown in the browser pane |
| `update_tasks` | The task list card |
| `ask_user` | Ask you one to four multiple-choice questions and wait for the answers (see Questions) |
| `skill` | Load a skill |
| `submit_plan` | Plan mode: hand the plan to you |
| `schedule_create` `schedule_list` `schedule_update` `schedule_delete` | Scheduled tasks |
| `session_spawn` `session_send` `session_list` `session_read` `session_merge` | Sub-sessions and messages between sessions; `session_list` with a `query` finds sessions by name |
| `session_rename` | Rename this session when you ask (no approval; the title is locked like a manual rename) |
| `mod_check` | What is wrong with a mod the agent is writing |
| `history_read` `history_search` `propose_skill` `propose_memory` `propose_mod` `withdraw_proposal` | A dream's session only (see Dreaming); no other session is offered them |
| `mcp__<server>__<tool>` | MCP server tools |

In the conversation each run of calls in a turn is one quiet line that says what it did, in the order it did it ("Read 3 files, ran 2 commands, edited a file"), with the lines that edits and writes added and removed and how many calls failed or were denied on its right; click it, or focus it and press Enter, to see the rows. A single call is one line too ("Ran a command", "Read a file", "Edited a file +3 −1"), which opens straight to that call's details; a call you or a hook denied reads "Denied a command". While the turn runs the line names the call in flight. A waiting approval or question card stays in the open under the line; once answered it goes, and the call's row keeps the answer. Settings → General → Tool activity (`toolActivity`: `summary`, the default, or `all`) shows every call as its own row instead, still without a separate line for an answered card.

Every tool is described to the model in every request. With a context window under 32k tokens the scheduling, session and mod tools are left out and the model is told so; Settings → Context → "Tools offered to the model" (`toolSet`: `auto`, `all`, `essential`) decides.

## Sessions

- Several sessions run at once (six at most). Switch freely: a running session keeps going off screen, and the sidebar shows a spinner while it runs, a dot when it waits for you, and a blue dot when it finished unseen.
- Each session has its own folder; the app's folder follows the session on screen. Project MCP servers and the project `settings.json` follow the folder on screen, not each background session's.
- The built-in browser belongs to the session on screen. A background session's browser call is refused with a message the model can act on.
- **Forks** copy a conversation and continue on their own. **Sub-sessions** are started by the agent (`session_spawn`) or by `/spawn`; they run in the background, sit under their parent in the sidebar, and report back when they finish a turn. **Merge** summarises what a sub-session or fork did since it split off and adds that to the parent; files need no merging, since sessions share the folder.
- Nesting stops at two levels; a session may have four sub-sessions running and twelve in all.
- **Names.** Rename a session in the sidebar (F2, double-click, the menu), in the top bar, with `/rename`, or by asking the agent ("call this session deploy fix"). From any other session you can then name it in plain words ("read the session called deploy fix"): every command and tool that takes a session accepts its name or id. Lookup searches every session not in the trash and tries, in order: the exact id; the start of an id (6 characters or more); the name ignoring case, quotes, punctuation and spacing (`tcg fork`, `"TCG (fork)"` and `tcg-fork` all find `tcg (fork)`); the start of a name; a name holding every word; a small misspelling. When several sessions fit, a related one (parent, sub-session, fork) wins; otherwise the answer lists them with id, folder and last activity, and with no match at all it lists the closest names. Two sessions may share a name; the rename then says that lookup by it is ambiguous.

## Scheduled tasks

A prompt that runs once at a time, every N minutes (five at least), or on a five-field cron rhythm in local time. Each run gets a session of its own, or is delivered into an existing session as a follow-up. You can also ask the agent: every schedule it creates or re-times shows you an approval card first.

- **The page.** Scheduled in the sidebar opens the Scheduled tasks page in the main column, in place of the session (the row shows selected; choosing a session in the sidebar brings the chat back, and `⌘[` goes back a page). **Yours** shows each task as a card: its name, where a run goes (New session or Same session), the prompt, and its state with its rhythm ("Active · Weekdays at 08:30", "Paused · …", "Done · Once on …"). Search looks through names and prompts; the filter shows All, Active or Paused; the sort is by next run, name or last run. **Templates** has starter tasks (a nightly dependency audit, a weekly changelog draft, a morning summary, a daily test run, a weekly TODO sweep); each opens the New task form filled in.
- **New task ⌄** (New task, or From a template) opens the form: name, instructions, the folder the runs work in, the schedule (once at a date and time, every hour at a minute, every N minutes, hours or days, every day, weekdays, every week on a day, every month on a day up to the 28th, or a custom cron rhythm) with the first run previewed, and whether each run starts a new session or continues one you pick. Runs use the permission mode in the chat bar; one that needs your approval waits for you in its session like any other.
- **A task's page** (click its card): the breadcrumb "Scheduled tasks / name ⌄" (the menu has Edit, Run now and Delete, which asks first), the next run, **Run now** and the **Active** switch (pause and resume); then **History**, every run newest first (the last 100): the session it made or continued, when, and running, waiting for you, done, failed or stopped; a row opens that session in the chat view, where you can keep talking in it. Beside it: the instructions, the project folder, the rhythm, where each run goes and the permission mode.
- **In the sidebar** a run's session is an ordinary session, listed by date with the rest, with a lightning bolt in front of its title and the usual running, waiting and unread marks at the end.
- **When they run.** Only while Silo Harness is open and the Mac awake (Keep awake can hold off sleep). A run missed while it was closed or asleep happens once when it is back, if it was due less than a day before, never as a backlog; an older one is marked missed.
- The side pane's Scheduled tab lists the tasks too; its New button opens the same form and Open page opens the page. Settings no longer has a Scheduled section; a search there for it finds a row that opens the page.

## Dreaming

A dream is a background session that reads what happened in recent sessions and proposes skills (a procedure you asked for more than once), mods (a view or status you keep asking for) and memory (preferences, corrections and facts, as lines in an instructions file). Dreaming in the sidebar opens its page, laid out like Scheduled tasks.

- **When.** Off until you turn on "Dream every day"; then once a day at the time you pick (default 03:00, local time). A daily dream missed while the app was closed runs once after the next launch, unless a dream ran in the last 20 hours. By hand: **Run a dream ⌄** on the Dreaming page (every project with new activity, or one you pick; it turns into Stop the dream while one runs), **Run a dream now** on a project's page, or `/dream` for the current session's project. One dream run at a time.
- **What it reads.** One dream per project folder with activity since that project's last dream (dream sessions, the trash and sessions without a message of yours are left out), most recently active first, at most five per run. Its first message is a digest the app builds from the history log: for each session its id, title, date and origin, then each of your messages and each final reply, clipped, the tool activity in a few words with failures and denied approvals, and the `#` memory lines; plus the skills, mods and instructions files that exist. It is sized to 40% of the context window, oldest first; what does not fit waits, and the project's cursor moves only past what the dream read (and only when it ended without an error).
- **What it can do.** Read: `read_file`, `glob`, `grep`, `list_directory`, `session_list`, `session_read`, `history_read` (any part of one session, tool results cut short) and `history_search` (every session's text). Propose: `propose_skill`, `propose_memory`, `propose_mod` (only those for what Look for has on), `withdraw_proposal`. Nothing else, in any permission mode: no shell, no edits, no browser, no MCP tools, no sub-sessions, no schedules. Every proposal carries why and the sessions it is based on (ids that must exist).
- **Modes.** Approve (default): the dream finishes, then each proposal waits for Apply or Dismiss. Auto: a proposal is applied when it is made. Plan: nothing is applied; at the end the proposals become one plan in the dream's session (a "Dream plan" card, Apply all or Keep planning); approving it applies them all without another model call, and an answer in the session lets the dream withdraw or replace proposals and make a new plan.
- **Applying.** The app writes, never the model: a skill becomes `<project>/.silo-harness/skills/<name>/SKILL.md` or `~/.silo-harness/skills/<name>/SKILL.md`; memory lines go into the project's instructions file (the first of `SILOHARNESS.md`, `OPENHARNESS.md`, `OPENAGENT.md`, `OPENCODER.md`, `AGENTS.md`, `CLAUDE.md`, else a new `SILOHARNESS.md`) or `~/.silo-harness/SILOHARNESS.md` (`OPENHARNESS.md` there when only that one exists); a mod's folder is written to `<project>/.silo-harness/mods/<id>/` or `~/.silo-harness/mods/<id>/`, checked like every mod first, and stays off until you turn it on. Nothing else can be written. A proposal that changes an existing skill, mod or memory line must say so (and shows the difference); Apply refuses when the file changed since it was proposed. Revert puts back what was replaced (a file or folder as it was; memory line by line if you edited the file since). A proposal that holds what looks like a key, token or password, or a key from your settings, is refused.
- **The page.** **Projects** shows a card for each project that has dreams or that the next dream reads: its name, the mode, its last dream's closing report (or what it suggested), and the daily dream with what waits ("Daily at 03:00 · 2 suggestions waiting", "Off · last dream Nov 6", "… · 3 sessions to read"), with search, a filter (All, Waiting for you, Not dreamed yet) and a sort (last dream, name, latest activity). **Suggestions** lists every proposal that waits, by dream, as the cards a dream's session shows, with Apply, Dismiss and Apply all. The banner says whether the daily dream is on (Turn on; Change) and that a dream sends parts of your past sessions to the model; the gear opens the settings: the daily dream and its time, the mode, and what to look for (Skills, Mods, Memory). These apply to every project.
- **A project's page** (click its card): the breadcrumb "Dreaming / project ⌄", **Run a dream now**, then **History**, each dream newest first: when, how it started, its mode, how many sessions it read, and its state (running, waiting for you with the count, plan ready, applied, nothing to suggest, failed with the reason); a row opens the dream's session, where each proposal is a card with Apply, Dismiss or Revert. Beside it, the same settings, the project folder and a word on privacy and cost.
- **In the sidebar** a dream's session is listed only while it waits for you or is on screen, with a moon in front of its title and the waiting dot at the end; it stays in history, search and the trash like any session. The Dreaming row has a dot while suggestions wait. A daily dream that leaves proposals waiting sends a notification (when notifications are on). Settings no longer has a Dreaming section; a search there for it finds rows that open the page.
- A dream sends parts of your past conversations to the configured model and uses tokens.

## Mods

Panels in the right-hand rail, tabs beside the Browser, a strip above the composer, backgrounds, themes and slash commands are mods: folders of web files that run sandboxed and reload when a file is saved. The built-in ones (Environment, Context, Tasks, Plan, Outputs, Sub-sessions, Skills, Side chat, Scheduled) are written against the same protocol as yours. Settings → Mods has a tab per kind: Mods, Background, Chat bar, Conversation and Theme. The Mods tab lists what adds something (panels, tabs, strips, commands), each with its switch. The other four are looks, which have no switch: each tab shows the one in use in a preview, lets you click another version to try it there first, and Use applies it, one per kind (Default first; the background with your own picture and Dim). The first Use of a look of yours or of a project's asks for your approval, once. Settings → Appearance shows each look in use, with a row that opens its tab. Ask the agent to build one, or see [mods.md](mods.md). `node modkit/playground/serve.js` hosts mods outside the app while you work on them.

## History

- Every message, tool call, approval, plan and error is appended to `history/<session>.jsonl` in the data folder as it happens, and never rewritten: a rewind or a compaction adds a record. After a crash or a force-quit the session is restored from it, with a notice.
- Deleting a session moves it to a trash for 30 days (Settings → History: restore, delete now, change the period).
- Settings → History → **Delete all sessions** deletes every session at once, each the way a single delete does: into the trash for the period set there, or away at once when it is Off. Running sessions are stopped first, and the window opens on a fresh session.
- Search in the sidebar looks through titles, messages, tool calls and what compactions folded away.
- A session's menu exports it as Markdown; `history.export` also writes JSON or the raw log.

## Context and compaction

Near the limit (`compactThreshold`, 80% by default) old tool output is shortened first, which often is enough. Otherwise the older part of the conversation is summarised into a brief and the recent part is kept word for word; the brief carries your latest request verbatim and lists the files touched. A summary that would not be smaller is not used, and the session is never left over the limit. `/compact [focus]` does the same on demand. The Context panel shows what fills the window, slice by slice.

## Remote control

Settings → Remote control turns on a small web page, served by the app, for following and steering sessions from another device: read along live, send messages, stop a run, answer approval cards and plans. It is off until you turn it on, listens on this Mac only or on your network as you choose, and its links carry a long random token that you can replace. The remote cannot change settings, the permission mode, mods, schedules or trust, cannot save a project rule, and never receives a key. It is plain HTTP: use it on a network you trust.

## Providers

- **Ollama** (default): native `/api/chat` with `num_ctx`, thinking control and capability detection.
- **Gateway fields** (the `portkey` block) = any OpenAI-compatible endpoint, Portkey's by default. The window calls it Portkey for Portkey's own address and Gateway for any other.
- **Named providers**: any number of entries in `"providers"` of `settings.json` (or `config.json`), each of a type that knows its base URL, key variable and headers: `openrouter`, `portkey`, `openai`, `anthropic`, `groq`, `deepseek`, `together`, `ollama`, `lmstudio`, and `openai-compatible` for anything else. `"provider"` picks one by name. Settings → Model chooses among all of them and their models; the model button under the chat bar lists the provider's models and the other usable providers.
- **The command line**: `silo` (in the app at `Contents/Resources/bin/silo`; Settings → General → Command line tool links it into `~/.local/bin`) adds, selects and tests providers and sets the other fields, for you or for a coding agent: `silo provider add openrouter --type openrouter --model … --use`, then `silo provider test`.
- All of it, with the shortest working example for each service, the field reference and the steps for coding agents: [configure.md](configure.md). Schema: [settings.schema.json](settings.schema.json).

## Configuration

Settings is the place for all of it. On disk:

- Data folder `~/Library/Application Support/Silo Harness/`: `config.json`, `sessions/`, `history/`, `trash/`, `artifacts/` (with each session's images), `schedules.json`, `dreaming.json` (the dreams, their proposals, what applying replaced, the per-project cursors), mod storage.
- Config folder `~/.silo-harness/` (or `SILO_HARNESS_CONFIG_DIR`): `settings.json`, `skills/`, `mods/`, `SILOHARNESS.md`.
- Before the app was renamed these were `~/Library/Application Support/Open Harness/`, `~/.open-harness/` (with `OPEN_HARNESS_CONFIG_DIR` and `OPENHARNESS.md`) and a project's `.open-harness/`. The first launch moves the two folders in your home and leaves a link at `~/.open-harness`; the old names in a project, the old file names and the old variables are still read when the new ones are absent.
- In a project: `.silo-harness/settings.json`, `.silo-harness/skills/`, `.silo-harness/mods/`, `.mcp.json`, and an instructions file (`SILOHARNESS.md`, `AGENTS.md` or `CLAUDE.md`).

A project's `.mcp.json` servers, its mods and its `settings.json` all stay off until you turn them on (a look of a project's applies only once you use it and approve it).

### settings.json

For providers and the command line, [configure.md](configure.md) supersedes this section.

`~/.silo-harness/settings.json`, then `<project>/.silo-harness/settings.json`, layer over `config.json`. Precedence: defaults < `config.json` < user < project.

```json
{
  "env": { "PORTKEY_API_KEY": "…" },
  "provider": "portkey",
  "portkey": { "baseURL": "https://gateway.example.com/v1", "model": "@vertex/gemini-2.5-pro", "contextWindow": 200000 }
}
```

- Settable: `provider`, `providers` (named providers, see [configure.md](configure.md)), `ollama.*`, `portkey.*`, `dreaming.*` (`daily`, `time` as `"HH:MM"`, `mode`: `auto`, `approve` or `plan`, and `skills`, `mods`, `memory`), `permissionMode`, `maxTurns`, `sendScreenshotsToModel`, `systemPromptExtra`, `theme`, `autoTitles`, `autoCompact`, `compactThreshold`, `pruneToolResults`, `toolSet`, `toolActivity`, `notifications`, `keepAwake`, `historyTrashDays`, `env`, `hooks` and `disableAllHooks` (see [hooks.md](hooks.md)). `workingDirectory` in the user file is the folder the app opens in. An unknown key or a value of the wrong type is skipped and reported in Settings → Configuration files; the rest of the file applies.
- `env` is applied to the process environment, so a key can live there instead of in `config.json` (`PORTKEY_API_KEY` is a fallback for the gateway key). `${VAR}` and `${VAR:-default}` are expanded in every string. Variables a file set are put back when the file stops applying.
- **A project's file needs your approval.** Until you trust it in Settings → Configuration files nothing in it applies, and an edit withdraws the approval. A notice in the chat tells you one is waiting.
- **A project's file never carries, chooses or redirects a key**: `apiKey`, `apiKeyEnv`, `portkey.apiKey`, `portkey.providerApiKey`, `portkey.baseURL`, and `env` variables whose names end in `KEY`, `TOKEN`, `SECRET` or `PASSWORD` are ignored there with a problem line; an entry for a service that takes a key may not set its own `baseURL` (it is skipped whole), and a header may not hold a `${VAR}`. The type's usual variable is used, `portkey.model`, `virtualKey`, `provider` and `configId` still apply, and `ollama` or `lmstudio` may have an address. For a provider with another variable or address, define it in your own file and select it from the project with `"provider"`.
- `"$schema": "https://brandeispatrick.github.io/silo-harness/settings.schema.json"` gives an editor completion and checks.
- A field a file sets is read-only in Settings and is never written to `config.json`. Changes made while the app runs (the mode chip, the model chip) last until the files are read again.
- The files are read again when they change, when the folder changes, and when trust changes.

### Hooks

Commands and HTTP endpoints that run before and after the agent acts, written under `"hooks"` in either settings.json in Claude Code's format (a project's only once you trust its file), and mods with the `hooks` permission. Fired: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `PostCompact`, `SessionEnd`. A PreToolUse hook can deny a tool call, force or skip the approval card, or rewrite its arguments; a Stop hook can send the run back to work. Tool names are Claude Code's where the tool is the same (`bash` is `Bash`, `read_file` is `Read`, …). Settings → Hooks lists the hooks in effect and the recent runs. The whole story, and what differs from Claude Code: [hooks.md](hooks.md).

## Keep awake

Settings → General: Off, While running (the default: system sleep is held off while a session runs; the display may still sleep), or Always.

## Security

The agent runs with your permissions: keep approvals on for untrusted tasks. Pages it reads are untrusted input. MCP servers are child processes with your permissions. `@` mentions send the file to the model. The built-in browser is a normal Chromium profile. What a repository brings with it (MCP servers, a settings file, mods) is never applied without you turning it on. Mods run in sandboxed frames with the permissions you grant, cannot reach the network without the `network` permission, and can never answer an approval card or change the permission mode; a mod that contributes styles restyles the app itself, so treat it like a theme from someone you trust. Remote control exposes sessions to whoever holds the link.
