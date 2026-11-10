# Releasing

## Version numbers

A version is `MAJOR.MINOR.PATCH`, tagged `vMAJOR.MINOR.PATCH`. The question that picks the number is what someone who uses the app, or writes mods for it, will notice.

Before 1.0.0, which is where the project is now:

| Bump | When | Example |
| --- | --- | --- |
| Minor (`0.2.0` → `0.3.0`) | Anything a user notices that is not a fix: a feature, a change to how the app looks or behaves, an addition to the mod protocol, a bundled mod added or removed, a setting, command or tool added. Also any release that moves or converts the user's data | session names, a new type scale, look mods |
| Patch (`0.3.0` → `0.3.1`) | Fixes only: the app now does what the previous release said it did. No new setting, command, tool or look | a crash, a wrong label, a test-only change |

1.0.0 is the release where three promises start: mods written for protocol 1 keep working through every 1.x, sessions and settings written by one 1.x open in the next, and the build is signed and notarized. From then on:

| Bump | When |
| --- | --- |
| Major | Someone has to change something to keep working: the mod protocol drops or redefines a part (its own number goes up, see below), or data cannot be carried over |
| Minor | Features and visible changes that break nothing |
| Patch | Fixes only |

The mod protocol has its own number, the `"protocol": 1` in every `mod.json`. Adding to the protocol (a field, a seat, an event, a permission) keeps that number, because an older app ignores what it does not know; [mods.md](mods.md) says which app version added each part. Only a change that breaks existing mods raises it.

Work that is merged but not released sits under `## Unreleased` at the top of [CHANGELOG.md](../CHANGELOG.md). A release renames that heading to `## X.Y.Z — YYYY-MM-DD`. If the section has only fixes it is a patch; otherwise a minor.

## Release notes

The changelog section is the release notes (`scripts/release-notes.js` serves its images from the release commit and adds Install and the Full changelog link), so every section has the same shape.

1. **A summary line** right under the heading: one sentence of at most 30 words saying what the release is about.
2. **Sections in this order**, each only when it has something, and no others:

| Section | What goes in it |
| --- | --- |
| `### Highlights` | Minor releases only: the one to three changes the release is about. A highlight may show one image (rule 4). |
| `### New` | Things you can now do. |
| `### Improved` | Existing features that work better or look different. |
| `### Fixed` | What was wrong and works now. |
| `### Security` | Permissions, credentials, what the agent may or may not do. |
| `### For developers` | Mods, hooks, settings keys, the command line, tools the model sees. |
| `### Upgrade notes` | Anything the user has to do, or data that moves on first launch. |
| `### Known issues` | What does not work yet. |

3. **One bullet per change, one pattern:** a bold label of two to four words ending in a full stop, then one plain sentence of at most 25 words, present tense. Say what the user gets, not how it is built or what it was like before. `code` only for what you type; names in the app in quotes. Detail belongs in the docs, linked at the end of the bullet when it helps.

4. **An image for a highlight that is easier to see than to read:** a new screen, or a number such as tokens saved. Put it on its own line under the bullet, indented two spaces, with alt text saying what it shows: `![Cost of one session before and after](docs/releases/X.Y.Z/name.png)`. One per highlight, 1600 px wide, readable at half that, and committed under `docs/releases/X.Y.Z/`. A figure's numbers come from a measurement in the repository, linked from the bullet. A release whose highlights have no image gets the README's hero screenshot under its summary line instead.

Example:

```
## 0.11.1 — 2026-11-09

Fixes tool results being shown with the wrong tool call when using Ollama models.

### Fixed

- **Tool results with Ollama.** Each result now stays with the call that produced it, including in sessions saved before this release.
```

## Making a release

Development happens on `next`; `main` is what was released.

1. On `next`, rename `## Unreleased` in CHANGELOG.md to `## X.Y.Z — YYYY-MM-DD`, check the section against [Release notes](#release-notes), and set the version: `npm version X.Y.Z --no-git-tag-version`. If the window changed, redo the screenshots (`npm run build && node scripts/readme-shots.js && node scripts/readme-shots.js --dark && node scripts/looks-shot.js && node scripts/tool-activity-shot.js && node scripts/dreaming-shot.js`) and look at them: the README uses the light ones, the website both. The website is `docs/index.html`, served by GitHub Pages from the `/docs` folder of `main`, so it changes when a release is merged.
2. Check the code: `npm run typecheck`, `npm test`, and `npm run test:live` with `ANTHROPIC_API_KEY` set, so the live scripts run against a real model.
3. Build what will ship: `npm run dist` (a DMG and a zip in `release/`). Unpack the zip and run the live scripts against that app (`SILO_HARNESS_LIVE_APP=<path to the binary inside the .app> npm run test:live`), and at least `smoke` against the copy in the mounted DMG.
4. Push `next` and open the pull request into `main`.
5. Draft the release from the commit the files were built from: `node scripts/release-notes.js X.Y.Z notes.md`, then `gh release create vX.Y.Z --draft --target <commit> --title "Silo Harness X.Y.Z" --notes-file notes.md release/Silo-Harness-X.Y.Z-arm64.dmg release/Silo-Harness-X.Y.Z-arm64.zip`.
6. Merge the pull request with a merge commit, so the tagged commit is part of `main`, and publish the draft; publishing creates the tag. Check the release page and both downloads signed out, and that the checksums GitHub shows are the ones in the notes.

The build is ad-hoc signed and not notarized, so the notes carry the "Open Anyway" instruction until that changes.
