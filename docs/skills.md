# Skills

A skill is a procedure the agent follows on request: a folder holding `SKILL.md` and, if it needs them, files beside it. This page is the definition. The same format is read by Claude Code, Codex and the `.agents/skills` convention, so a skill written for one of them loads here unchanged.

## The folder

```
review-pr/
  SKILL.md          required: frontmatter, then instructions
  checklist.md      optional: anything the instructions refer to
  scripts/lint.sh
```

The folder name is the skill's name.

## SKILL.md

```markdown
---
name: review-pr
description: Reviews a pull request for bugs, risky changes and missing tests. Use when the user asks to review a PR, a branch or a diff.
argument-hint: <PR number or branch>
---
1. Read the diff with `git diff main...$1`.
2. Check each change against `checklist.md`.
3. Report findings, most severe first.
```

The frontmatter is YAML between two `---` lines at the very top. The Markdown after it is the body: the instructions.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | no | Lower-case letters, digits and single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`), at most 64 characters, equal to the folder name. Missing: the folder name. |
| `description` | yes | What the skill does **and when to use it**, at most 1,024 characters. The model decides from this alone whether to load the skill. |
| `argument-hint` | no | Shown after `/name` in the `/` menu, e.g. `<file>`. Quote it if it starts with `[`. |
| `disable-model-invocation` | no | `true`: only you run it, with `/name`. The model is not told about it and cannot load it. |
| `user-invocable` | no | `false`: left out of the `/` menu. The model can still load it. |

Any other key (`license`, `metadata`, `allowed-tools`, `compatibility`, `model`, …) is accepted and ignored. `allowed-tools` is **not enforced**: a skill runs with the session's tools and permission mode.

The reader understands the YAML that frontmatter uses: `key: value`, single and double quotes, `|` and `>` blocks, a plain value continued on indented lines, `true`/`false`, `[a, b]` and `- item` lists, `#` comments, CRLF line ends and a BOM.

## Where skills are read from

First found wins by name (names compare without case):

1. **The project.** From the session folder up to its git root, nearest folder first; in each folder `.silo-harness/skills`, then `.open-harness`, `.openagent`, `.opencoder` (older names), `.agents/skills`, `.claude/skills`. Without a git root, the session folder only. The walk never reaches the home folder.
2. **Yours.** `~/.silo-harness/skills` (or `SILO_HARNESS_CONFIG_DIR/skills`), the older names, `~/.agents/skills`, `~/.claude/skills`. With `SILO_HARNESS_CONFIG_DIR` set, only that folder.
3. **Built in.** The `skills/` folder that ships with the app.

Claude Code's command files are read too: `.claude/commands/**/*.md` in the project folders above, then `~/.claude/commands`. Each file is a command you run (`/name`, or `/folder:name` for one in a subfolder); the model is not offered it. Its frontmatter is optional; without a `description`, its first line is shown. A skill of the same name wins.

Skills are read when a run starts. A skill written during a session can be loaded straight away: the `skill` tool looks again before it reports an unknown name.

## Running a skill

- **You:** type `/name` and, optionally, arguments: `/review-pr 1234`. The body is added to your message.
- **The model:** the system prompt lists each skill it may load as `name: description` inside `<available_skills>`; it loads one with the `skill` tool when the task matches. Skills with `disable-model-invocation: true` or without a description are left out. The list stays within about 2% of the context window: the longest descriptions are shortened first, and every name stays.

### Arguments

In the body of a skill run with `/name args`:

| Placeholder | Becomes |
| --- | --- |
| `$ARGUMENTS` | Everything after the name |
| `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, … | One argument, counting from 0 |
| `$1` … `$9` | One argument, counting from 1 (as in a shell and Claude Code commands) |

Arguments split on spaces; quotes group (`/fix "two words" b`). A missing argument becomes empty. A body with no placeholder gets `ARGUMENTS: <what you typed>` added at the end.

### Supporting files

`${SKILL_DIR}` (or Claude Code's `${CLAUDE_SKILL_DIR}`) in the body becomes the skill's absolute folder. When the model loads a skill, the result also gives the folder (`Base directory: …`), says that relative paths are relative to it, and lists up to 20 files beside `SKILL.md`. So `see checklist.md` or `run scripts/lint.sh` just work.

## Writing a good skill

- One job per skill.
- The description says what it does and when to use it, in the third person, with the words a user would type.
- The body is ordered steps in the imperative, each one checkable. No filler, no secrets.
- Keep `SKILL.md` under about 200 lines. Move reference tables, long examples and scripts into files beside it and name them by relative path.
- Check it: ask the agent to load it with the `skill` tool, or open Settings → Skills. Both list its problems.

The built-in `create-skill` skill (`/create-skill`) walks the agent through all of this.

## Problems

A skill with problems still loads when it has a body; Settings → Skills and the `skill` tool list them, one line each.

| Message | Meaning | Effect |
| --- | --- | --- |
| `no frontmatter (a --- block at the top)` | The file does not start with `---`. | Loads under the folder name; not offered to the model (no description). |
| `frontmatter could not be read (line N)` | Line N of the file is not valid frontmatter (or `---` is never closed). | The keys that could be read are used. |
| `name "X" must be lower-case letters, digits and hyphens` | The name has capitals, spaces, `_`, or a leading, trailing or double hyphen. | Loads under the folder name. |
| `name is longer than 64 characters` | | Loads under the folder name. |
| `name does not match folder "x"` | `name` differs from the folder. | Loads under `name`. |
| `folder name "X" must be lower-case letters, digits and hyphens` | The name comes from a folder that breaks the name rule. | Loads; rename the folder. |
| `name must be text` | `name` is a list or a map. | Loads under the folder name. |
| `no description` | `description` is missing or empty. | Runs with `/name`; not offered to the model. |
| `description must be text` | `description` is a list or a map. | As `no description`. |
| `description is longer than 1,024 characters` | | Loads; the model's list cuts it at 1,024. |
| `argument-hint must be text` | | The hint is ignored. |
| `disable-model-invocation must be true or false` | Any other value, e.g. `"yes"`. | Treated as `false`. |
| `user-invocable must be true or false` | | Treated as `true`. |
| `no instructions after the frontmatter` | The body is empty. | Listed, but cannot run. |
| `no instructions` | A command file is empty. | Listed, but cannot run. |
