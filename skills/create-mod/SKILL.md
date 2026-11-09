---
name: create-mod
description: Write or change an Silo Harness mod (a panel, tab, composer strip, background, theme, a look for the conversation or the chat bar, or a slash command made of mod.json plus HTML or CSS). Load before touching any mod.
---
A mod is a folder named by its id with a `mod.json` and one or more HTML pages. The page runs in a sandboxed frame and talks to the app only through the `harness` object.

## Where to write
- Something for this project only: `<project>/.silo-harness/mods/<id>/` (the working directory's `.silo-harness/mods`).
- A personal mod for every project: `~/.silo-harness/mods/<id>/`.
- The folder name must equal `id`: 2 to 40 lower-case letters, digits and `-`, starting with a letter.

## Complete minimal example
`~/.silo-harness/mods/word-count/mod.json`:
```json
{
  "protocol": 1,
  "id": "word-count",
  "name": "Word count",
  "version": "0.1.0",
  "description": "How much the assistant has written in this session.",
  "permissions": ["session:read"],
  "contributes": {
    "views": [{ "id": "main", "title": "Word count", "entry": "panel.html", "seat": "rail" }]
  }
}
```
`~/.silo-harness/mods/word-count/panel.html`:
```html
<!doctype html>
<link rel="stylesheet" href="/@harness/harness.css">
<div class="h-row"><span class="h-label">Assistant words</span><span class="h-value" id="n">0</span></div>
<div class="h-empty" id="empty" hidden>Nothing written yet.</div>
<script src="/@harness/harness.js"></script>
<script>
  let words = 0;
  const count = (t) => (t.match(/\S+/g) || []).length;
  const show = () => {
    document.getElementById('n').textContent = words.toLocaleString();
    document.getElementById('empty').hidden = words > 0;
  };
  async function load() {
    try {
      const { items } = await harness.session.transcript();
      words = items.filter((i) => i.role === 'assistant').reduce((n, i) => n + count(i.text), 0);
    } catch { words = 0; }
    show();
  }
  harness.ready.then(load);
  harness.on('message.assistant', (m) => { words += count(m.text); show(); });
  harness.on('session.changed', load);
</script>
```

## mod.json fields
Required: `protocol` (1), `id`, `name`, `version` ("0.1.0"). Optional: `description`, `author`, `icon`, `permissions`, `contributes` with:
- `views`: `[{ "id", "title", "entry", "seat", "order"?, "maxHeight"?, "preview"? }]`. `entry` is a relative path to an HTML file in the folder; `preview` (backgrounds only, optional) a picture in the folder for its card in Settings.
- `styles`: `["theme.css"]`, a theme: CSS applied to the app itself (override tokens like `--accent` on `:root`). One theme is in use at a time.
- `looks`: `[{ "id", "title", "target": "conversation"|"composer", "styles": ["look.css"], "preview"? }]`, CSS for one region only (see Looks).
- `commands`: `[{ "name": "words", "description": "…", "view": "main" }]`; the page gets a `command` event `{ name, args }`.
- `settings`: `[{ "key", "type": "boolean"|"string"|"number"|"select", "title", "default", "options"? }]`; read with `harness.settings.get()`.

## Seats
- `rail`: a section in the right rail, sized to content (up to `maxHeight`, default 360).
- `tab`: a full tab in the side pane next to Browser, Diff and Terminal.
- `composer`: one compact row above the composer (up to 120 px).
- `background`: behind the whole window, takes no clicks. The `pointer` event `{ x, y }` (fractions of the window) lets it follow the pointer. A background is a look (see Looks).

## Looks
A look restyles one region, and the user uses it in Settings → Mods → Chat bar or Conversation (one per region). Use a look, not `styles`, when the request is about how the conversation or the chat bar looks. Backgrounds and themes are looks too (tabs Background and Theme).
- Looks have no switch. A new one is not applied: the user previews it (the card in the chat has Preview, which opens its tab with it in the preview) and then uses it (Use on the card or the tab; the first Use of a look of theirs asks for their approval once). The preview reloads as you save.
- The preview draws a sample chat bar or exchange with the same ids and classes as the window, compiled for the preview's region, so a look written against the stable hooks previews exactly as it applies.
- `conversation`: the app wraps the CSS in `@scope (#messages) { … }`; `composer`: in `@scope (#chatbar) { … }`. Selectors reach only that region; `:scope` is its root. Set tokens on `:scope` to retheme the region: `:scope { --accent: #2b9; }`.
- State on the root, no script needed: `data-running="true|false"`, `data-scheme="light|dark"`, `data-mode`, and `data-set-<key>` for each of the mod's `settings` (key in lower case). Branch on them: `:scope[data-running="true"] .tool-status.spin { … }`.
- Rely only on the stable hooks in docs/mods.md (Looks): `.msg.user .bubble`, `.msg.assistant .md`, `.tool`, `.tool-verb`, `.code-block`, `.task-list`, `#composer`, `#input`, `#send-btn`, `#model-btn`, `#mode-btn`, and so on.
- `@keyframes` are moved out of the scope, so their names are global: prefix them with the mod id. `@import` is removed.
- Keep the app's text size and line height; work in light and dark; animate only under `@media (prefers-reduced-motion: no-preference)`.
- `mods/hyperspace` (glow.css, holo.css, cockpit.css) is the full example.

Minimal look (`mod.json` and `look.css`):
```json
{ "protocol": 1, "id": "teal-chat", "name": "Teal chat", "version": "0.1.0",
  "contributes": { "looks": [{ "id": "main", "title": "Teal", "target": "conversation", "styles": ["look.css"] }] } }
```
```css
:scope { --look: #1a9e9e; }
:scope[data-scheme="dark"] { --look: #46d1d1; }
.msg.user .bubble { box-shadow: inset 3px 0 0 var(--look); }
.md :is(h1, h2) { color: var(--look); }
```

## Kit (`/@harness/harness.css`)
Classes: `h-row` (label/value line), `h-label`, `h-value`, `h-muted`, `h-title`, `h-list` + `h-item` (clickable rows), `h-btn` (`.primary`, `.ghost`, `.sm`), `h-input`, `h-switch`, `h-chip`, `h-bar` + `h-bar-seg` (meter), `h-dot`, `h-empty`, `h-spin`, `h-mono`, `h-md` (put `ui.markdown()`'s html in it: chat styling, working Copy buttons and links; `.compact` for the rail).
Tokens: `--bg-000`…`--bg-400`, `--text-100`, `--text-200`, `--text-400`, `--border`, `--border-subtle`, `--accent`, `--danger`, `--success`, `--font`, `--mono`, `--r-control`, `--r-card`. Keep panels compact: 13 px text, 8 px gaps.

## harness calls, by permission
Every call returns a promise; wait for `harness.ready` first. `harness.on(event, fn)` subscribes.
- Always: `ui.theme()`, `ui.setTitle(t)`, `ui.setBadge(v)`, `ui.toast(text, { kind })`, `ui.open(viewId)`, `ui.copy(t)`, `ui.openExternal(url)`, `ui.markdown(text)`, `storage.get(key, fallback)`, `storage.set(key, value)`, `storage.remove(key)`, `storage.keys()`, `storage.session.*` (same, per session), `settings.get()`. Events: `theme.changed`, `settings.changed`, `visibility.changed`, `command`.
- `session:read`: `session.get()` (resolves with `{ id, title, cwd, origin, messageCount, createdAt, updatedAt, running, attention? }`), `session.transcript({ limit })`, `session.tasks()`, `session.plan()`, `session.outputs()`, `session.context()`, `session.related()`, `outputs.open({ kind, id })`. Events: `session.changed`, `run.started`, `run.ended`, `message.user`, `message.assistant`, `message.delta`, `tool.started`, `tool.ended`, `tasks.changed`, `plan.changed`, `outputs.changed`, `context.changed`.
- `session:send`: `session.send(text)`, `composer.insert(text)`.
- `session:control`: `session.stop()`, `session.compact(focus)`, `sessions.open(id)`, `sessions.create()`, `sessions.spawn({ title, prompt })`, `sessions.merge(id)`.
- `sessions:read`: `sessions.list()`, `sessions.search(query, { limit })`.
- `model`: `model.complete({ messages, system, maxTokens, context: 'session' }, onDelta)`, `model.cancel()`.
- `skills:read`: `skills.list()`, `skills.usage({ scope: 'session' | 'all' })`; event `skills.used`.
- `config:read`: `config.get()`; `config:write`: `config.set(patch)` (theme, autoCompact, compactThreshold, keepAwake, notifications, background only).
- `schedules`: `schedules.list()`, `.create(input)`, `.update(id, patch)`, `.remove(id)`, `.runNow(id)`.
- `remote`: `remote.status()`, `remote.start()`, `remote.stop()`.
- `network`: no call; lets the page load and fetch `https:` URLs.

Ask only for the permissions the page uses. A call without its permission rejects with `code: 'permission'`.

## Rules that trip people up
- No `localStorage`, `sessionStorage`, IndexedDB or cookies: use `harness.storage`.
- Link your own files with relative URLs (`style.css`, `img/logo.svg`) and the kit with `/@harness/…`. No `..`, no absolute paths, no files starting with `.`.
- No network without the `network` permission: no CDNs, web fonts or remote images. Inline what you need or put it in the folder.
- No `window.open`, `alert`, forms that submit, or navigating away; the page cannot leave its own origin.
- Handle "nothing to show": no session open, an empty transcript, a call that rejects. Show an `h-empty` line instead of a blank or broken panel.
- Inline `<script>` and `<style>` are fine. Keep everything in one page unless it grows.
- Adding a permission to a mod that is on pauses it until the user approves. Adding a look does not: its first Use asks.
- A look applies only once the user uses it (Settings → Mods → Background, Chat bar, Conversation or Theme, or Use on the card in the chat); it is previewed first. Tell them so.

## The loop
1. Write `mod.json` and the page(s) in the right folder.
2. Call the `mod_check` tool with the id. Fix every problem it lists and call it again until mod.json is valid.
   A mod you just wrote shows in the installed list and in `mod_check` as off until the user turns it on (a look: until they use it); that is expected and does not mean it existed before.
3. Tell the user the mod is ready and that they turn it on from the card in the chat or in Settings → Mods. For a look: they preview it (Preview on the card) and use it (Use). Never edit config files to turn it on or apply it yourself.
4. Once it is on, each save reloads the page. After changes, call `mod_check` again: it also lists errors the page threw.
