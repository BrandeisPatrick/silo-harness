<p align="center"><img src="build/icon.png" width="84" alt=""></p>
<h1 align="center">Silo Harness</h1>
<p align="center"><b>An open-source, Claude Code–style Mac app that runs any model, local or hosted.</b></p>
<p align="center">And it gets better the more you use it: Dreaming turns your past sessions into skills, memory and mods for you to keep, and the agent builds new panels and looks for the app when you ask.</p>
<p align="center">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-Apple%20silicon-lightgrey.svg">
  <a href="https://github.com/BrandeisPatrick/silo-harness/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/BrandeisPatrick/silo-harness?label=download"></a>
</p>
<p align="center"><a href="https://github.com/BrandeisPatrick/silo-harness/releases/latest">Download</a> · <a href="https://brandeispatrick.github.io/silo-harness/">Website</a> · <a href="docs/reference.md">Reference</a></p>
<p align="center"><img src="docs/screenshots/demo.gif" width="820" alt="Silo Harness: the agent adds rate limiting to an API and runs the tests, then builds a panel for the app's rail on request"></p>
<p align="center">If it is useful to you, a ⭐ helps other people find it.</p>

## Try it in a minute

1. [Download the app](https://github.com/BrandeisPatrick/silo-harness/releases/latest) (Apple silicon), drag it into Applications and open it. It isn't notarized yet: the first time, macOS stops it; allow it in System Settings → Privacy & Security → Open Anyway.
2. Give it a model, either way:

   **A hosted model.** Copy an [OpenRouter](https://openrouter.ai/keys) key, then run (the key is read from the clipboard, so it never lands in your shell history):

   ```bash
   pbpaste | "/Applications/Silo Harness.app/Contents/Resources/bin/silo" provider add openrouter --type openrouter --model anthropic/claude-sonnet-4.5 --key-stdin --use
   ```

   **Or fully local**, with no account and nothing leaving your Mac:

   ```bash
   brew install ollama && ollama serve &
   ollama pull qwen3:8b
   ```

The app picks the change up while it runs. Other providers (OpenAI, Anthropic, Portkey, Groq, DeepSeek, Together, LM Studio, any OpenAI-compatible service) are in [configure.md](docs/configure.md); a coding agent can do the setup for you from that page.

## Why

- **Local first.** Runs on `qwen3:8b` through Ollama; nothing leaves your Mac. Built for small context windows: compaction that clears old tool output before it summarises, a context breakdown, and a tool set sized to the model.
- **Made for reading.** One calm column of text on a measured type scale, a chat bar that is a single bar, tool activity folded into one line that opens to the rows. Few boxes, nothing competing with the words.
- **The Claude Code workflow.** Permission modes, approval cards, plan mode, rewind, a task list in the chat, queued messages, `@` file mentions, `#` memory.
- **Sessions side by side.** Several run at once. The agent starts sub-sessions and merges them back; forks and sub-sessions nest in the sidebar; any session finds another by its name; scheduled tasks run on a rhythm; your phone can follow along.
- **Mods.** The rail, the tabs, the look of the conversation and of the chat bar, and the background are mods: sandboxed folders of web files with a documented protocol, reloaded when a file is saved. Ask the agent for one and turn it on.
- **Dreaming.** Once a day, or when you ask, a dream reads your recent sessions and suggests skills, mods and memory lines from what you keep asking for, each with the evidence; you apply or dismiss them.
- **A browser you can sign in with.** Tabs, a profile of its own and sign-in popups. The agent asks before it uses each site (in Auto mode its safety check decides, and asks you when unsure), a purchase or a new account always waits for you, and what you type into a password, code or card field never reaches the agent.
- **Nothing is lost.** An append-only history log survives crashes, rewinds and compactions; deleted sessions go to a trash.
- **See everything.** Tool rows with diffs, images inline in replies, a Diff pane with revert, a real Terminal pane, a built-in browser the agent drives, artifacts beside the chat.
- **Standard extensions.** MCP servers (`.mcp.json`), skills (`SKILL.md`), project instructions (`AGENTS.md` / `CLAUDE.md`), `settings.json`.
- **Small codebase.** Electron + TypeScript, no bundler, no framework.

## From source

```bash
git clone https://github.com/BrandeisPatrick/silo-harness.git && cd silo-harness
npm install && npm start
```

## Features

| | |
| --- | --- |
| <img src="docs/screenshots/tool-activity.png" width="400"> | **Tool activity in one line.** Each run of tool calls folds into a quiet line that says what happened ("Read 3 files, edited 2 files, ran 2 commands"), with the lines added and removed and anything that failed or was denied; click it to see every row. |
| <img src="docs/screenshots/mods.png" width="400"> | **Mods.** Environment, Context, Tasks, Plan, Outputs, Sub-sessions and Skills in the rail; Side chat and Scheduled as tabs. All written against the protocol in [docs/mods.md](docs/mods.md). |
| <img src="docs/screenshots/hyperspace.png" width="400"> | **Looks.** A mod can restyle just the conversation or just the chat bar, and bring a background; Settings → Mods has a tab for each (Backgrounds, Chat bar, Conversation, Themes) to pick one, or a whole set. Hyperspace, a bundled set, jumps to lightspeed while the agent works. |
| <img src="docs/screenshots/sidebar.png" width="400"> | **Sessions.** Several at once, grouped by day, forks and sub-sessions nested under where they came from, search inside conversations. |
| <img src="docs/screenshots/images.png" width="400"> | **Images in replies.** The model shows a screenshot or a chart inline; tool rows carry thumbnails. |
| <img src="docs/screenshots/settings.png" width="400"> | **Settings.** One control per row, applied as you change it, searchable; a Mods section with permissions in plain words. |
| <img src="docs/screenshots/remote.png" width="220"> | **Remote control.** Follow a session and answer its approval cards from your phone. Off until you turn it on. |
| <img src="docs/screenshots/approval.png" width="400"> | **Approvals.** Enter allows, `a` for the session, `p` for the project. Auto mode blocks only risky actions, with a reason. |
| <img src="docs/screenshots/dreaming.png" width="400"> | **Dreaming.** Once a day, or when you ask, a dream reads your recent sessions and suggests skills, memory lines and mods, each quoting your words and linking the sessions it came from. You apply or dismiss each one, and can revert what you applied. |

Also: scheduled tasks, plan mode, rewind, artifacts, skills, MCP servers, compaction, a history log with a trash, vision models, macOS notifications, keep-awake. Details, keys and tools: [docs/reference.md](docs/reference.md). What changed: [CHANGELOG.md](CHANGELOG.md).

## A mod in two files

```json
{ "protocol": 1, "id": "word-count", "name": "Word count", "version": "0.1.0", "permissions": ["session:read"],
  "contributes": { "views": [{ "id": "main", "title": "Word count", "entry": "panel.html", "seat": "rail" }] } }
```

```html
<link rel="stylesheet" href="/@harness/harness.css">
<div class="h-row"><span class="h-label">Assistant words</span><span class="h-value" id="n">0</span></div>
<script src="/@harness/harness.js"></script>
<script>
  let words = 0;
  harness.on('message.assistant', (m) => {
    words += (m.text.match(/\S+/g) || []).length;
    document.getElementById('n').textContent = words;
  });
</script>
```

Put them in `~/.silo-harness/mods/word-count/`, turn the mod on, and the panel is in the rail. Or ask the agent: "make a mod that shows …".

## Develop

```bash
npm run typecheck   # both tsconfigs
npm test            # headless suites (mock model, no Ollama needed)
npm run test:live   # the real app, hidden, on a throwaway profile; set ANTHROPIC_API_KEY to run against the API
npm run package     # the app in release/mac-arm64
```

`src/main` is the agent, the session runtime and the features; `src/renderer` the window; `src/shared` the contracts between them; `mods/` the built-in mods; `modkit/` what mod pages load, and a playground. How it fits together: [docs/architecture.md](docs/architecture.md). Version numbers and the release steps: [docs/releasing.md](docs/releasing.md). MIT.
