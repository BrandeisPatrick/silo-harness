# Hooks

Hooks run a shell command, call an HTTP endpoint or ask a mod at fixed points of the agent's work: before a tool call (and block it), after one, when you send a message, when a run ends, around a compaction, when a session starts and ends. They are written under `"hooks"` in `settings.json`, in the same format as [Claude Code's hooks](https://code.claude.com/docs/en/hooks), so the hooks you already have work as they are.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "if": "Bash(rm *)", "command": "~/.claude/hooks/block-rm.sh", "timeout": 60 }] }
    ]
  }
}
```

Settings → Hooks lists the hooks in effect, grouped by event (with each one's matcher, type, command and the file or mod it comes from) and the runs of this app session (the event, the tool, the exit code or decision, the time it took and the first line of stderr). The app has no `/hooks` editor: edit the file, and the next event uses it.

## Where hooks come from

| Source | When it runs |
| --- | --- |
| `~/.silo-harness/settings.json` | always |
| `<project>/.silo-harness/settings.json` | only once you trust the file in Settings → Configuration files (the page and the chat notice say the file defines hooks that run commands); an edit withdraws the trust |
| a mod with the `hooks` permission | while the mod is on (see [mods.md](mods.md#hooks)) |

Hooks from several places all run; the same handler defined in both files runs once. `"disableAllHooks": true` in a file turns off every hook from the settings files (a mod's still run; turn the mod off for that). Hooks of a project are those of the session's own folder.

## Events

| Event | When | Matcher filters | Can block |
| --- | --- | --- | --- |
| `SessionStart` | the first run of a session in this app session: `startup` for a new session, `resume` for one with messages | `startup`, `resume` | no; stdout and `additionalContext` are context for the model |
| `UserPromptSubmit` | a message is accepted (typed, queued, from a schedule, a mod or another session), before the model sees it | none | yes: the message is dropped and the reason shown; stdout and `additionalContext` follow it as context |
| `PreToolUse` | before a tool call, before the app's own approval check | the tool name | yes: `deny` refuses, `ask` forces the approval card, `allow` skips it; `updatedInput` replaces the arguments |
| `PostToolUse` | after a tool call that succeeded | the tool name | the tool already ran: a block's reason and `additionalContext` reach the model with the result |
| `PostToolUseFailure` | after a tool call that failed (its result starts with `Error:`, `Not permitted` …) | the tool name | as PostToolUse |
| `Notification` | `permission_prompt` when an approval card waits; `idle_prompt` when a run ends while the window is in the background | the type | no |
| `Stop` | a run ended with the model's answer | none | yes: the reason is sent to the model and the run goes on |
| `SubagentStop` | a sub-session's run ended (instead of `Stop`) | `sub-session` | yes, as Stop |
| `PreCompact` | before the conversation is summarised | `manual`, `auto` | yes: that compaction is skipped; stdout is instructions for the summary |
| `PostCompact` | after a summary replaced the earlier messages | `manual`, `auto` | no |
| `SessionEnd` | a session is deleted, or the app quits | `other`, and `deleted` or `quit` | no; all SessionEnd hooks share 1.5 s (a longer `timeout` raises it, up to 60 s) |

Claude Code's other events (`PermissionRequest`, `SubagentStart`, `FileChanged`, …) are not fired; a file that names one gets a problem line in Settings and the rest applies.

## The format

`"hooks"` maps an event to a list of matcher groups; each group has an optional `matcher` and a list of handlers.

- **Matchers** are Claude Code's: `"*"`, `""` or none match everything; only letters, digits, `_`, `-`, spaces, `,` and `|` is a name or a list of names (`"Edit|Write"`, `"Edit, Write"`); anything else is an unanchored JavaScript regular expression (`"mcp__memory__.*"`, `"^Edit$"`). On events without matcher support a matcher is ignored.
- **`if`** (tool events only) is one permission rule: `"Bash(git *)"` runs when any subcommand of the command matches `git *` (leading `VAR=value` is ignored, commands inside `$( )` and backticks count, a pattern naming more than the program runs on any `$( )`, backtick or `$VAR`, and a command that cannot be read runs the hook); `"Edit(*.ts)"` matches TypeScript files in any folder, `"Edit(src/**)"` the `src` folder of the session's folder, `"Read(//etc/**)"` an absolute path, `"Read(~/x/*)"` one under your home. On any other event a handler with `if` never runs.
- **Handlers:**

| Field | | |
| --- | --- | --- |
| `type` | required | `"command"` or `"http"`. `"mcp_tool"`, `"prompt"` and `"agent"` are reported as unsupported and skipped |
| `command` | command | run with `sh -c`; with `args`, the program to start directly, with no shell (`${CLAUDE_PROJECT_DIR}` is filled in) |
| `args` | | exec form: the arguments, as they are |
| `url` | http | POSTed the input; `headers` may use `$VAR` from `allowedEnvVars` only |
| `timeout` | | seconds (default 600; 30 on UserPromptSubmit). A hook past it is stopped and decides nothing |
| `async` | | run in the background; nothing waits for its decision (its run is still listed) |
| `onFailure` | | `"block"`: a hook that fails, times out or cannot start blocks the action (not on Stop and SubagentStop) |
| `statusMessage` | | said in the status line while the hook runs |

`shell` is accepted (shell-form commands always run with `sh`); `asyncRewake` is read as `async`; `once` is ignored, as in Claude Code's settings files.

## Input

A command reads one JSON object on stdin; an HTTP hook gets it as the POST body. Every event has:

```json
{ "session_id": "…", "transcript_path": "~/Library/Application Support/Silo Harness/sessions/<id>.json", "cwd": "/the/session/folder", "permission_mode": "default", "hook_event_name": "PreToolUse" }
```

`permission_mode` is Claude Code's name for the mode: `default` (Ask), `acceptEdits`, `auto`, `plan`, `bypassPermissions` (Bypass). `transcript_path` is the session's file, which may lag the conversation by a moment. The event's own fields: `tool_name`, `tool_input`, `tool_use_id` (tool events), `tool_response` (PostToolUse: the result text), `error` and `is_interrupt` (PostToolUseFailure), `prompt` (UserPromptSubmit), `source` (SessionStart), `reason` (SessionEnd: `other`, with `silo_reason` `deleted` or `quit`), `message`, `notification_type` and `title` (Notification), `stop_hook_active` and `last_assistant_message` (Stop, SubagentStop; SubagentStop also `agent_id`, `agent_type` `"sub-session"` and `agent_transcript_path`, with the parent session as `session_id`), `trigger` and `custom_instructions` (PreCompact), `trigger` and `compact_summary` (PostCompact).

The hook runs in the session's folder with the app's environment plus `CLAUDE_PROJECT_DIR` and `SILO_PROJECT_DIR` (both the session's folder).

### Tool names

Where this app's tool is the same thing as one of Claude Code's, a hook sees Claude Code's name and input shape, so `jq -r .tool_input.command` and `"matcher": "Edit|Write"` work unchanged. `silo_tool_name` and `silo_tool_input` always carry this app's own. A matcher or an `if` rule may use either name.

| This app | `tool_name` | `tool_input` |
| --- | --- | --- |
| `bash` | `Bash` | `command`, `timeout`, `description` |
| `read_file` | `Read` | `file_path` (absolute), `offset`, `limit` |
| `write_file` | `Write` | `file_path`, `content` |
| `edit_file` | `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
| `glob` | `Glob` | `pattern`, `path` |
| `grep` | `Grep` | `pattern`, `path`, `glob`, `-i` |
| `list_directory` | `LS` | `path` |
| `update_tasks` | `TodoWrite` | `todos` (`content`, `status`, `id`) |
| `submit_plan` | `ExitPlanMode` | `plan`, `title` |
| `skill` | `Skill` | `skill` |
| `ask_user` | `AskUserQuestion` | `questions` (`question`, `header`, `options` with `label` and `description`, `multiSelect`) |
| `mcp__<server>__<tool>` | the same | the tool's arguments |
| anything else (`terminal_run`, `browser_*`, `create_artifact`, …) | its own name | its arguments |

`terminal_run` (a command in the Terminal pane) also answers to a `Bash` matcher and to `Bash(…)` rules, with its `command` in `tool_input`, so a Bash policy hook covers it too.

The browser tools keep their own names and arguments. `browser_tabs` lists and switches the pane's tabs (`action`: `list`, `new`, `select` or `close`, with `url`, `tab_id` and `background`); every other browser tool acts on the active tab. The tools that can need an approval (`browser_navigate`, `browser_click`, `browser_type`, `browser_press_key`, `browser_eval`, `browser_tabs`) take an optional `reason`, the model's one sentence on why, which the approval card shows; a hook sees it in `tool_input` like any argument, and an `updatedInput` may change or drop it. A PreToolUse hook that allows a call skips the browser's site, sensitive-site and JavaScript cards, but never a purchase or account card, and never a refusal (a credential field, a CAPTCHA, a scheme the browser does not open).

Credentials never reach a hook. When `browser_type` types into a password, one-time code or card field, its `text` reads `•••` in `tool_input` (as it does in the transcript); an `updatedInput` that hands `•••` back keeps the real text. In `tool_response`, the value of such a field reads `•••` in every browser tool's result.

## Output

| Stdout | Exit 0 | Exit 2 | Another code |
| --- | --- | --- | --- |
| one JSON object that fits the schema | its fields apply | blocks; the fields are read but cannot undo the block | the fields alone decide (with `onFailure: "block"`, a failure) |
| JSON that does not parse or fit | a non-blocking error | blocks, with stderr as the reason | a non-blocking error |
| plain text or nothing | nothing, except on UserPromptSubmit and SessionStart (context) and PreCompact (summary instructions) | blocks, with stderr as the reason | a non-blocking error with the first line of stderr |

A block on a tool call reaches the model as Claude Code words it: `PreToolUse:Bash hook error: [<command>]: <stderr>`. A non-blocking error, a block and a hook's `systemMessage` each leave a quiet notice in the conversation. An HTTP hook's 2xx body is its stdout; another status is a non-blocking error.

JSON fields: `continue` (`false` ends the run after the current step; `stopReason` is shown), `stopReason`, `suppressOutput` (accepted), `systemMessage` (a notice), `decision: "block"` with `reason` (PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SubagentStop), and `hookSpecificOutput` with `permissionDecision` (`allow`, `deny`, `ask`), `permissionDecisionReason` and `updatedInput` (PreToolUse; the older `decision: "approve"`/`"block"` is read as allow/deny) and `additionalContext` (PreToolUse, PostToolUse, UserPromptSubmit, SessionStart).

The hooks of one event run in parallel, each within its own timeout. Their decisions merge: `deny` wins over `ask`, which wins over `allow`; any block blocks; context is joined in order. `allow` skips the approval card, but what the mode refuses outright (edits in Plan mode) stays refused. `ask` shows the card in every mode, Bypass included, with the hook's reason on it. A hook that says nothing leaves the usual approval rules in charge: staying silent does not approve.

**Stop.** A block sends the run back to the model with the reason as a note, and Stop fires again when it ends, with `stop_hook_active: true`. An exit code 2 sends a run back once; after that only a JSON `"decision": "block"` does, so a script that checks `stop_hook_active` decides for itself, and no run is sent back more than 8 times.

## Examples

Block `rm` in Bash:

```sh
#!/bin/sh
# ~/.silo-harness/hooks/block-rm.sh, with "if": "Bash(rm *)"
echo 'Blocked: rm commands are not allowed' >&2
exit 2
```

Log every Bash call:

```json
{ "hooks": { "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "cat >> ~/bash-log.jsonl; echo >> ~/bash-log.jsonl", "statusMessage": "Logging the call…" }] }] } }
```

Add context to every prompt:

```json
{ "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "echo \"Today is $(date +%A).\"" }] }] } }
```

Keep going until the tests pass:

```sh
#!/bin/sh
input=$(cat)
case "$input" in *'"stop_hook_active":true'*) exit 0;; esac
npm test >/dev/null 2>&1 || { echo 'The tests fail; fix them before you stop.' >&2; exit 2; }
```

## Differences from Claude Code

- Events not fired: `Setup`, `UserPromptExpansion`, `PermissionRequest`, `PermissionDenied`, `PostToolBatch`, `MessageDisplay`, `SubagentStart`, `TaskCreated`, `TaskCompleted`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`.
- Handler types not run: `mcp_tool`, `prompt`, `agent`.
- `SessionStart` fires at a session's first run in this app session (not when the window opens on it), with `startup` or `resume` only; `SessionEnd`'s reason is always `other`.
- `Notification` has `permission_prompt` and `idle_prompt` only, and fires whatever the Notifications setting says.
- `tool_response` is the tool's result text, not a structured object.
- No `/hooks` menu, no managed settings, no `allowedHttpHookUrls`; hooks in skills and agent files are not read; `terminalSequence`, `asyncRewake`'s wake-up and `once` are not supported; an async hook's output is recorded but not delivered to the model.
- Shell-form commands run with `/bin/sh -c`; there is no PowerShell.
- A Stop hook's exit code 2 sends a run back once per run (see Stop above).
- Additions: the `silo_tool_name`, `silo_tool_input` and `silo_reason` fields, `SILO_PROJECT_DIR`, and mods as a hook source.
