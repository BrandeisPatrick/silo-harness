---
name: create-skill
description: Writes a new skill or improves an existing one, as a SKILL.md with frontmatter and step-by-step instructions, then loads it to check it. Use when the user asks to make, write, save or fix a skill, turn a procedure into a skill or slash command, or says "remember how to do this".
argument-hint: <what the skill should do>
---
A skill is a folder `<name>/SKILL.md`: YAML frontmatter, then instructions in Markdown, plus any files beside it. `format.md` in this skill's folder has the exact rules and every problem message; read it when a rule below is not enough.

## 1. Find out what the skill is for
- Take the job from the user's words, the conversation, or `$ARGUMENTS`. If the procedure was just done in this session, use the steps that actually worked.
- Settle two things before writing: what the skill does, and when it should trigger (the phrases a user would say). Ask the user only if you cannot infer either one.
- Keep it to one job. If the request holds two, write two skills.
- To change an existing skill, load it with the `skill` tool first; the result gives its folder.

## 2. Choose where it lives
- Default: the project, `<project>/.silo-harness/skills/<name>/`, where `<project>` is the session folder (or its git root when the skill is for the whole repository).
- The user's own, `~/.silo-harness/skills/<name>/`, when it is personal or useful across projects.
- Tell the user which one you chose and why, in one sentence.
- A project skill of the same name hides the user's and the built-in one; pick another name unless replacing it is the point.

## 3. Pick the name
- Lower-case letters, digits and single hyphens, at most 64 characters: `deploy-staging`, `release-notes`.
- A verb or a clear noun phrase. The folder name and `name:` must be the same.
- The user will type it as `/name`, so keep it short.

## 4. Write the description
One or two sentences, at most 1,024 characters, in the third person: what it does, then "Use when …" with the words a user would actually say. The model picks skills from this line alone.

- Good: `Drafts release notes from the commits since the last tag, grouped into New, Improved and Fixed. Use when the user asks for release notes, a changelog entry, or what changed since the last release.`
- Bad: `Release notes helper.` (no trigger, no outcome)

## 5. Write SKILL.md
```markdown
---
name: release-notes
description: Drafts release notes … Use when the user asks for …
argument-hint: <version>
---
1. Find the last tag with `git describe --tags --abbrev=0`.
2. …
```
- Add `argument-hint` when the skill takes input; use `$ARGUMENTS`, `$1`, `$2` in the body where it goes.
- Add `disable-model-invocation: true` only when the skill has side effects the user should start themselves (deploys, sending messages). Add `user-invocable: false` only for background knowledge nobody types.
- The body: numbered steps in the imperative, in working order, each one something you can check was done. Name exact commands, files and tools. Say what "done" looks like.
- No filler, no greetings, no restating the description. No secrets, keys, tokens or personal paths; read them from the environment or ask.
- Keep SKILL.md under about 200 lines. Put long reference material, templates and scripts in files beside it and refer to them by relative path (`see checklist.md`, `run scripts/check.sh`). Use `${SKILL_DIR}` when a command needs the absolute folder.

## 6. Write the files
- Create the folder and write `SKILL.md` and any supporting files.
- Make scripts executable (`chmod +x`) and run each once to see it works.

## 7. Verify
1. Load it: call the `skill` tool with the name. It re-reads the skill folders, so a new skill is found.
2. Read the result: the body must come back whole, the base directory must be the folder you chose, and the files list must show every supporting file.
3. If it lists problems, fix each one and load it again. Repeat until there are none.
4. If the tool says the skill is run by the user only, that is the `disable-model-invocation` you set; it still lists any problems.
5. Read the description once more as the model would: would a user's request for this job match it, and would unrelated requests not?

## 8. Finish
Tell the user, briefly:
- the skill's name and folder;
- how to run it: `/name` (with the argument hint, if any), or just ask for the job in their own words;
- that Settings → Skills lists it.
