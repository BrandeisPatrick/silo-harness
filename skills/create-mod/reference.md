# Mod reference

Checked against `src/main/mods/manifest.ts`, `src/main/mods/permissions.ts`, `src/shared/mods.ts`, `modkit/harness.js` and `modkit/harness.css`. The long-form guide is `docs/mods.md` in the app's repository.

## mod.json

| Field | Rule |
| --- | --- |
| `protocol` | required, `1` |
| `id` | required, `^[a-z][a-z0-9-]{1,39}$`, equal to the folder name |
| `name` | required, non-empty |
| `version` | required, `major.minor.patch`, optional `-pre` or `+build` suffix |
| `description`, `author`, `homepage`, `license` | strings |
| `icon` | a built-in icon name (`gauge`, `list`, `message`, `clock`, `folder`, `sparkles`, `plug`, `image`, `terminal`, `globe`, `settings`, ...) or an `.svg` file in the mod |
| `permissions` | list from the table under Permissions |
| `contributes.views` | `[{ id, title, entry, seat, order?, maxHeight?, icon?, preview? }]` |
| `contributes.styles` | ignored (themes were removed); the mod still loads, with a note |
| `contributes.looks` | `[{ id, title, target, styles, description?, preview? }]` |
| `contributes.commands` | `[{ name, description, view? }]` |
| `contributes.settings` | see Settings |
| `contributes.hooks` | `["PreToolUse", "Stop"]` or `[{ "event": "PreToolUse", "timeout": 30 }]`; needs the `hooks` permission |

Unknown fields are ignored. Every file path: relative, `/`-separated, no `..`, no `.` or empty segment, no part starting with `.`, must exist inside the folder (symlinks may not leave it).

Views:
- `id`: lower-case letters, digits, `-`, up to 40, unique in the mod. `title`: required.
- `entry`: an `.html` or `.htm` file.
- `seat`: `rail`, `tab`, `composer`, `background` or `worker`. `transcript`, `status`, `sidebar` are reserved and rejected.
- `order` (rail, lower first, default 100; bundled use 10 to 90). `maxHeight` (rail, px, default 360). Composer views are capped at 120 px.
- `preview` (background): a `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` or `.svg` for its card in Settings.
- `worker`: a hidden page loaded while the mod is on, for hooks or events without a panel.

Looks:
- `id` as for views, unique among the mod's looks; `title` required.
- `target`: `conversation` (root `#messages`) or `composer` (root `#chatbar`). An unknown target is a warning and that look is skipped.
- `styles`: non-empty list of `.css` files, applied in order.
- `preview`: picture as for backgrounds.

Commands:
- `name`: `^[a-z][a-z0-9-]{0,39}$`, without the slash (a leading `/` is stripped), unique in the mod.
- `description`: required.
- `view`: id of a view of this mod, brought to the front when the command runs.
- `/name args` delivers the `command` event `{ name, args }` to the mod's views. Commands register only while the mod is on; if two mods use one name, the first wins (bundled, then user, then project).

Settings (`contributes.settings`), shown under the mod in Settings → Mods:
- `key`: `^[A-Za-z][\w.-]{0,63}$`, unique. `title`: required. `description`: optional.
- `type`: `boolean` (`default` true or false), `string` (`default`, `placeholder`), `number` (`default`, `min`, `max`, `step` > 0), `select` (`options`: non-empty list of distinct strings; `default` one of them).
- Read with `harness.settings.get()`; `settings.changed` follows each change. Looks read them as `data-set-<key>` (key lower-cased, other characters as `-`).

## Permissions

| Permission | Lets the mod |
| --- | --- |
| `session:read` | read the session on screen: messages, tool calls, tasks, plan, outputs, context |
| `session:send` | send messages as the user, fill the composer |
| `session:control` | stop, compact, open, create, spawn and merge sessions |
| `sessions:read` | list and search all conversations |
| `model` | call the model (spends tokens) |
| `skills:read` | list skills and their usage |
| `config:read` | read non-secret settings and the project's git info |
| `config:write` | change theme, autoCompact, compactThreshold, keepAwake, notifications, background |
| `schedules` | manage scheduled tasks |
| `remote` | see and switch remote control |
| `network` | load and fetch `https:` resources |
| `hooks` | handle hook events (sees every tool call's input) |

No mod can answer approval cards, change the permission mode, read keys, trust MCP servers or other mods, or touch files outside its folder.

## harness API

Every call returns a promise; calls wait for `harness.ready` and time out after 30 s (`model.complete` after two minutes). Errors carry `code`: `permission`, `unavailable`, `timeout`, `unknown-method`, `bad-params`, `error`. `harness.on(event, fn)` returns an unsubscribe function. `harness.info` is the hello: `{ protocol, mod, view, app, granted, theme, settings, visible }`. `harness.call(method, params)` sends any bridge method.

Always available:
- `ui.theme()`, `ui.resize(height?)`, `ui.setTitle(t)`, `ui.setBadge(v | null)`, `ui.toast(text, { kind: 'info' | 'error' })`, `ui.open(viewId?)`, `ui.copy(t)`, `ui.openExternal(url)`, `ui.markdown(text)` → `{ html }`, `ui.openSettings(section?)`, `ui.openPage('scheduled' | 'dreaming', { form: 'new' }?)`.
- `storage.get(key, fallback)`, `storage.set(key, value)`, `storage.remove(key)`, `storage.keys()`; `storage.session.*` the same per session. Up to 256 KB a value, 5 MB a mod.
- `settings.get()`.
- Events: `theme.changed`, `settings.changed`, `visibility.changed` `{ visible }`, `command` `{ name, args }`, `pointer` `{ x, y }` (background views only, fractions of the window), `session.switched` `{ id }`.

`session:read`:
- `session.get()` → `{ id, title, cwd, origin, parentId?, forkedFrom?, messageCount, createdAt, updatedAt, running, attention? }`.
- `session.transcript({ limit })` → `{ items: [{ role, text, name?, args?, ok?, images? }] }`, oldest first; roles `user`, `assistant`, `tool`, `plan`, `artifact`, `image`, `compaction`; long texts are cut.
- `session.tasks()` → `{ tasks }`, `session.plan()` → `{ plan | null }`, `session.outputs()` → `{ outputs }`, `session.context()`, `session.related()` → `{ parent, children, forks }`, `outputs.open({ kind, id })`.
- Events: `session.changed`, `related.changed`, `run.started` `{ sessionId }`, `run.ended` `{ sessionId, reason, text }`, `message.user` `{ text, origin }`, `message.assistant` `{ text }`, `message.delta` `{ text }`, `tool.started` `{ id, name, args }`, `tool.ended` `{ id, name, ok, durationMs }`, `tasks.changed`, `plan.changed`, `outputs.changed`, `context.changed` `{ tokens, limit }`.

`session:send`: `session.send(text)` (queued while a run is going), `composer.insert(text)`.

`session:control`: `session.stop()`, `session.compact(focus?)`, `sessions.open(id)`, `sessions.create()`, `sessions.spawn({ title, prompt })`, `sessions.merge(id)`.

`sessions:read`: `sessions.list()`, `sessions.search(query, { limit })`.

`model`: `model.complete({ messages, system, maxTokens, context: 'session' }, onDelta)` → `{ text, usage, stopped? }` (no tools; `maxTokens` at most 4000, default 1000); `model.cancel()`. Event `model.delta`.

`skills:read`: `skills.list()` → array of `{ name, description, path, source }`; `skills.usage({ scope: 'session' | 'all' })` → `{ items: [{ name, count, lastUsedAt }] }`. Event `skills.used` `{ name }`.

`config:read`: `config.get()` → `{ provider, model, workingDirectory, home, permissionMode, theme, autoCompact, compactThreshold, keepAwake, notifications, background, contextLimit }`; `project.git()` → `{ root, repository, branch }`. Event `config.changed`.

`config:write`: `config.set(patch)` with only `theme`, `autoCompact`, `compactThreshold`, `keepAwake`, `notifications`, `background`.

`schedules`: `schedules.list()`, `.create(input)`, `.update(id, patch)`, `.remove(id)`, `.runNow(id)`. Event `schedules.changed`.

`remote`: `remote.status()`, `remote.start()`, `remote.stop()`. Event `remote.changed`.

`network`: no call.

`hooks`: `harness.hooks.on(event, handler)` returns an off function (`harness.hooks.off(event)` too). `handler(input)` gets what a command hook reads on stdin and returns what it would print, or nothing. List the events in `contributes.hooks`; the default timeout is 10 s, at most 600. Events the app fires: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `PostCompact`, `SessionEnd`. A view receives hook requests only while loaded; use the `worker` seat for one that always is.

## Kit (`/@harness/harness.css`)

Classes: `h-row`, `h-label`, `h-value`, `h-muted`, `h-title`, `h-list` + `h-item`, `h-btn` (`.primary`, `.danger`, `.ghost`, `.sm`, `.icon`), `h-input`, `h-switch` (on `<input type="checkbox">`), `h-chip` (`.accent`, `.success`, `.danger`), `h-bar` + `h-bar-seg`, `h-bar-mark`, `h-dot`, `h-chev`, `h-icon` (`.sm`), `h-segmented` (buttons with `aria-pressed`), `h-empty`, `h-spin`, `h-mono`, `h-md` (holds `ui.markdown()` html with working Copy buttons and links; `.compact` for the rail).

Tokens: `--bg-000` to `--bg-400`, `--text-100`, `--text-200`, `--text-400`, `--border`, `--border-subtle`, `--accent`, `--danger`, `--success`, `--warn`, `--attention`, `--switch-on`, `--button-fill`, `--button-fill-hover`, `--button-text`, `--spinner`, `--segment-on`, `--code-bg`, `--code-hover`, `--bubble`, `--tok-kw`, `--tok-str`, `--tok-com`, `--tok-num`, `--tok-pun`, `--font`, `--mono`, `--r-control`, `--r-card`, `--h-inset-x`, `--h-inset-top`, `--h-inset-bottom`, and the type scale `--fs-ui`/`--lh-ui` (14/20), `--fs-small`/`--lh-small` (13/18), `--fs-micro`/`--lh-micro` (12/16), `--fs-body`/`--lh-body` (15/21), `--fs-code`/`--lh-code` (13/20), `--fs-title`/`--lh-title`, `--fs-head`/`--lh-head`.

Scale: rows 14 px on a 32 px pitch (`h-item`), dense rows 13 px on 24 px, secondary text 13 px, nothing under 12 px; 8 px gaps; no page padding beyond the kit's. Rail and composer views size to their content by themselves; call `ui.resize()` after an animation.

## Looks

Root attributes while active: `data-look` (`"<mod key>/<look id>"`), `data-running` (`"true"`/`"false"`), `data-scheme` (`"light"`/`"dark"`), `data-mode` (`ask`, `acceptEdits`, `auto`, `plan`, `bypass`), `data-set-<key>`.

Hoisted out of the scope into `@layer mod-looks`: `@keyframes`, `@counter-style`, `@font-face`, `@property`. Only `@property --mod-<id>-...` and `@font-face` with a `font-family` starting `mod-<id>` are kept. `@import`, `@charset`, `@namespace`, `@page` and comments are removed; relative `url()` points at the mod's files; `https:` does not load. A stray `}` is dropped and unclosed blocks are closed. `#messages` gets `contain: paint` under a conversation look; the chat bar is not contained.

A mod with two or more kinds of look (background, chat bar, conversation) is a set: "Use the whole set" applies them together.

Stable hooks, conversation (`#messages`):
- `.msg.user`, `.msg.user .bubble` (`.bubble.rich` for Markdown), `.session-msg.received`, `.session-msg.sent`, `.session-msg-link`, `.session-msg-body`
- `.msg.assistant`, `.msg.assistant > .md` (streaming: `.msg.assistant:last-child` while `data-running="true"`)
- `.md h1` to `.md h6`, `.md p`, `.md ul`, `.md ol`, `.md blockquote`, `.md table`, `.md code`, `.md a`
- `.code-block`, `.code-head`, `.code-lang`, `.code-copy`, `.code-block pre`
- `.thinking`
- `.tool`, `.tool > summary`, `.tool-verb`, `.tool-arg`, `.tool-meta`, `.tool-body`, `.tool-status` (`.spin`, `.err`)
- `.tool-group`, `.tool-group > summary` (`.live`), `.group-stat`, `.group-failed`, `.group-denied`
- `.cmd`, `.out pre`
- `.approval` (keep readable)
- `.plan-card`, `.task-list`, `.task-row` (`data-status`: `pending`, `in_progress`, `completed`)
- `.msg.system` (`.error`)

Stable hooks, chat bar (`#chatbar`):
- `#composer` (`.composer`), `#input`, `.composer-row`
- `#send-btn` (`.send`; `:disabled`, `.stop`)
- `#attach-btn` (`.composer-plus`), `#attachments`, `.attach-thumb`
- `#composer-foot`, `.foot-btn`: `#model-btn`, `#mode-btn` (`.plan`, `.bypass`), `#context-meter`

Anything else in the markup can change between releases.

## Scopes and state

| Scope | Folder | Starts |
| --- | --- | --- |
| bundled | `mods/` in the app | on; its looks need no approval |
| user | `~/.silo-harness/mods/<id>/` (or `~/.open-harness/mods` on an install not yet moved; `SILO_HARNESS_CONFIG_DIR` overrides) | off until turned on; first Use of a look asks |
| project | `<project>/.silo-harness/mods/<id>/` (or `<project>/.open-harness/mods` when only that exists) | off until turned on for that project |

A user mod with a bundled mod's id replaces it. States: `on`, `off`, `paused` (asks for more than was granted), `invalid` (no valid manifest yet). Safe mode (Settings → Mods) turns every user and project mod off.
