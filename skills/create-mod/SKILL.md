---
name: create-mod
description: Writes or changes a Silo Harness mod, a folder of mod.json plus HTML or CSS that adds a rail panel, side-pane tab, strip above the composer, hidden hook worker, background, conversation or chat-bar look, or slash command to the app. Use when the user asks to make, change, fix or debug a mod, panel, widget, background, look or custom slash command for Silo Harness.
argument-hint: <what the mod should do>
---
A mod is a folder named by its id, holding `mod.json` and the files it names. A page runs in a sandboxed frame and talks to the app only through the `harness` object; a look's CSS is applied to the app's own page, scoped to its region. Full field tables, the harness API by permission, the kit and the stable look hooks are in `reference.md` in this skill's folder. Read the part you need before writing.

## 1. Pick the kind
| The user wants | Contributes |
| --- | --- |
| a panel beside the chat | a view, `"seat": "rail"` |
| a full tab next to Browser, Diff, Terminal | a view, `"seat": "tab"` (page `height: 100%`, scroll inside) |
| one compact row above the composer | a view, `"seat": "composer"` (up to 120 px) |
| something that reacts to tool calls or prompts, no UI | a view, `"seat": "worker"`, plus `contributes.hooks` and the `hooks` permission |
| an animated or pictured backdrop | a view, `"seat": "background"` (takes no clicks; `pointer` event `{ x, y }`) |
| the conversation or the chat bar to look different | `looks` with `target` `conversation` or `composer` |
| `/something` | `commands`, usually with a view that handles it |

Backgrounds and looks have no switch, one in use per kind. Views (other seats) and commands are behind the mod's switch. There are no themes for the whole app any more: `contributes.styles` is ignored; recolour the conversation or the chat bar with a look (`:scope { --accent: … }`). To change a built-in panel, copy its folder (from `mod_check` with its id) into the user folder under the same id: the copy replaces it.

## 2. Pick the folder
- This project only: `<project>/.silo-harness/mods/<id>/`.
- Every project: `~/.silo-harness/mods/<id>/`.
- Older installs still use `.open-harness` (read when `.silo-harness` does not exist), and `SILO_HARNESS_CONFIG_DIR` can move the user folder. Call `mod_check` with the new id first: for an unknown id it names the real folders.
- `id` = folder name: 2 to 40 lower-case letters, digits and `-`, starting with a letter.
- Each write into a mods folder asks the user, in every mode but Bypass. That is expected; do not work around it.

## 3. Write mod.json
Required: `"protocol": 1`, `id`, `name`, `version` (`major.minor.patch`). Optional: `description`, `author`, `homepage`, `license`, `icon`, `permissions`, `contributes` (`views`, `styles`, `looks`, `commands`, `settings`, `hooks`). Paths are relative to the folder, use `/`, no `..`, no names starting with `.`, and the file must exist. Ask only for the permissions the page calls; a call without one rejects with `code: 'permission'`. Field rules: `reference.md`, "mod.json".

## 4. Write the page or the CSS
Minimal rail panel, `~/.silo-harness/mods/word-count/`:
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
`panel.html`:
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
  harness.on('session.switched', load);
</script>
```
Minimal conversation look (`look.css`, listed as `"looks": [{ "id": "main", "title": "Teal", "target": "conversation", "styles": ["look.css"] }]`):
```css
:scope { --look: #1a9e9e; }
:scope[data-scheme="dark"] { --look: #46d1d1; }
.msg.user .bubble { box-shadow: inset 3px 0 0 var(--look); }
@keyframes teal-chat-pulse { 50% { opacity: 0.5; } }
```

Page rules:
- Load the kit from `/@harness/harness.css` and `/@harness/harness.js`; wait for `harness.ready`. Use its classes and tokens so the panel looks native and follows light and dark.
- No `localStorage`, `sessionStorage`, IndexedDB or cookies: use `harness.storage` (and `harness.storage.session`).
- No `window.open`, `alert`, submitting forms or navigating away. Open links with `harness.ui.openExternal`.
- Offline unless the mod has `network`: no CDNs, web fonts or remote images. Put files in the folder and link them relatively.
- Handle nothing to show (no session, empty transcript, a rejected call) with an `h-empty` line, never a blank panel.
- Reset on `session.switched`; `session.changed` also fires when the title or run state changes.
- Inline `<script>` and `<style>` are fine.

Look rules:
- A look is wrapped in `@scope (#messages)` or `@scope (#chatbar)`: style `:scope` and the stable hooks in `reference.md`, nothing else. Branch on `data-running`, `data-scheme`, `data-mode`, `data-set-<key>` on `:scope`.
- `@import` is removed. `@keyframes` names are global and the app's win: prefix them with the mod id.
- Keep the app's text size and line height; work in light and dark; animate only under `@media (prefers-reduced-motion: no-preference)`.
- Example to copy: `mods/hyperspace` (background, both looks, settings).

## 5. Check with mod_check
`mod_check` is in the `mods` tool group: load it with `load_tools` (`{ "groups": ["mods"] }`) if it is not offered yet. Call it with `{ "id": "<id>" }`. It reports the folder and scope, the state (`on`, `off`, `paused`, `invalid`), every problem in mod.json, warnings, permissions granted and still wanted, the views, looks and commands, the errors its loaded pages threw (latest five; old ones stay listed until the app restarts, so compare times), and a `Next:` line. Without an id it checks every user and project mod.

Fix every problem it lists and call it again until it says `mod.json: valid`. While mod.json is invalid nothing new of the mod loads (the last valid version stays in use). A new mod shows as `off`: that is expected.

## 6. Tell the user how to turn it on
- A mod with views or commands: they turn it on from the card in the chat or in Settings → Mods.
- A look or background: they press Preview on the card (or open Settings → Mods → Background, Chat bar or Conversation), then Use. The first Use of their own look asks for approval once.
- Never edit config files to turn a mod on or apply a look yourself.
- Adding a permission to a mod that is on pauses it until they approve. Adding a look does not; its first Use asks.
- Once on, every save reloads the page (a look reloads in the preview as well).

## 7. Final check
After the last edit, call `mod_check` with the id once more. Done means: `mod.json: valid`, no warnings you did not intend, `Errors its pages reported: none` (when it is on), and you followed its `Next:` line in what you tell the user.
