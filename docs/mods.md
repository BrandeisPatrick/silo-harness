# Mods

A mod is a folder of web files that adds something to Silo Harness: a panel in the right-hand rail, a tab beside the Browser, a strip above the composer, a background behind the app, a look for the conversation or the chat bar, a theme, a slash command. The panels the app ships with (Context, Outputs, Tasks, Skills, Side chat, …) are mods written against this same protocol, so anything they do, yours can do.

A mod page is an ordinary HTML page. It runs in a sandboxed frame, talks to the app through one small object (`harness`), and reloads the moment one of its files is saved. That last part is the point: the agent can write a mod for you in the middle of a session, you turn it on (or, for a look, preview it and use it), and from then on every edit shows up live.

Protocol version: **1**.

## A mod in two files

```
~/.silo-harness/mods/word-count/
  mod.json
  panel.html
```

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

```html
<!doctype html>
<link rel="stylesheet" href="/@harness/harness.css">
<div class="h-row"><span class="h-label">Assistant words</span><span class="h-value" id="n">0</span></div>
<script src="/@harness/harness.js"></script>
<script>
  let words = 0;
  const show = () => (document.getElementById('n').textContent = words.toLocaleString());
  const count = (text) => (text.match(/\S+/g) || []).length;
  harness.ready.then(async () => {
    const { items } = await harness.session.transcript();
    words = items.filter((i) => i.role === 'assistant').reduce((n, i) => n + count(i.text), 0);
    show();
  });
  harness.on('message.assistant', (m) => { words += count(m.text); show(); });
  harness.on('session.switched', () => location.reload());
</script>
```

Save the two files, turn the mod on in Settings → Mods (or on the card that appears in the chat), and the panel is in the rail. Edit `panel.html` and it reloads.

## Where mods live

| Scope | Folder | Starts |
| --- | --- | --- |
| bundled | `mods/` inside the app | on (you can turn one off); its looks are available and in use once you choose them |
| user | `~/.silo-harness/mods/<id>/` | off until you turn it on once; its looks are available, and the first Use of one asks first |
| project | `<project>/.silo-harness/mods/<id>/` | off until you turn it on for that project; its looks as yours |

A user mod with the id of a bundled one replaces it, which is how you customise a built-in panel: Settings → Mods → Customise copies it into your folder, and you edit the copy.

The app watches these folders. A new folder with a valid `mod.json` shows up in Settings → Mods right away, and as a card in the chat when a session is open. Nothing behind a switch loads until the mod is on, and no look applies until it is used.

Turning a mod on grants the permissions its manifest lists at that moment. Later edits to its pages reload it without asking again. An edit that adds a permission pauses the mod until you approve the change.

### Mods and looks

Settings → Mods has a tab for each kind, by what the manifest contributes: **Mods**, **Background**, **Chat bar**, **Conversation** and **Theme**.

- **Mods** lists what adds something to the window: views in the rail, the side pane, above the composer or in the `worker` seat, and slash commands. Each has its switch.
- The other four are **looks**: a view in the `background` seat, a look for `composer`, a look for `conversation`, and a theme (`styles`). A look has no switch. It is available as soon as it is installed, and its tab decides which one is in use: one per kind, with Default (none) first.
  - At the top of a look tab is a preview of the look in use: the background behind a miniature window (with Dim under it), a sample chat bar, a sample exchange, or a miniature window in the theme. Under it are the look's name and source, and its mod's settings.
  - Under those is every version of the kind as a card: Default, then the built-in ones, yours and the project's. A click on a card shows that version in the preview, and the window stays as it is. **Use** applies it to the window; **Back to current** shows the one in use again. Using a look puts away the one of its kind that was in use.
  - **New ⌄** asks the agent for one (Settings closes and the composer starts the request) or writes a starter from a template, which shows in the preview, not applied.
  - The first Use of a look of yours or of a project's asks for your approval, once per mod: what its pages may do, and that its stylesheet restyles the app. That approval is the only gate a look has. A bundled look needs none.
- A mod with both kinds keeps its switch in the Mods tab for its views and commands; its looks are on their tabs, and do not depend on the switch.

`openSettings('mods', { tab: 'backgrounds' })` opens a tab, and `{ tab, preview: '<mod key>/<look id>' }` opens it with that version previewed; the tab ids are `mods`, `backgrounds`, `chat-bar`, `conversation` and `themes`.

`Settings → Mods → Safe mode` (on the Mods tab) turns every user and project mod off at once, their looks included.

## mod.json

| Field | | |
| --- | --- | --- |
| `protocol` | required | `1` |
| `id` | required | lower-case letters, digits and `-`, 2 to 40 characters, starting with a letter; the same as the folder name |
| `name` | required | shown in Settings and on panel headers |
| `version` | required | `major.minor.patch` |
| `description` | | one line |
| `author`, `homepage`, `license` | | shown in Settings |
| `icon` | | the name of a built-in icon (`gauge`, `list`, `message`, `clock`, `folder`, `sparkles`, `plug`, `image`, `terminal`, `globe`, `settings`, …) or the path of an SVG file in the mod |
| `permissions` | | what the pages may ask the app for (see Permissions); default none |
| `contributes.views` | | pages and where they sit (see Seats) |
| `contributes.styles` | | CSS files applied to the app itself (themes, a restyled composer) |
| `contributes.looks` | | stylesheets for one region of the window each: the conversation or the chat bar (see Looks) |
| `contributes.commands` | | slash commands |
| `contributes.settings` | | options shown under the mod in Settings |
| `contributes.hooks` | | hook events its views handle, e.g. `["PreToolUse", "Stop"]` or `[{ "event": "PreToolUse", "timeout": 30 }]`; needs the `hooks` permission (see Hooks) |

Unknown fields are ignored, so a mod written for a later protocol still loads with what this version understands. A look for a region this version does not know is left out with a warning (shown in Settings → Mods and by `mod_check`), and the rest of the mod loads.

### Seats

A view is one HTML page in one seat.

```json
{ "id": "main", "title": "Context", "entry": "panel.html", "seat": "rail", "order": 20, "maxHeight": 420 }
```

| Seat | Where | Notes |
| --- | --- | --- |
| `rail` | a section in the right-hand rail, between the chat and the side pane | sized to its content up to `maxHeight` (default 360); `order` sorts sections, lower first (bundled ones use 10 to 90); the user can collapse a section, and opens and closes the rail with the top bar's first icon (⌘⇧E) |
| `tab` | a tab in the side pane's strip, beside the page tabs, Diff and Terminal | fills the pane; it is not sized to its content, so make the page `height: 100%` and scroll inside it (the `--h-inset-*` padding is for rail sections); the tab is in the strip only once opened (from the New tab page, the ⋯ menu, a command or `harness.ui.open`); its × (or Delete) takes it out of the strip and the page keeps running hidden |
| `composer` | a strip directly above the composer | one row, sized to its content up to 120 px |
| `worker` | nowhere: a hidden page, loaded whenever the mod is on | for a mod that handles hooks (or listens to events) without a panel; it is never visible, takes no input and does not report a size. *Added in 0.8.0.* |
| `background` | behind the whole window | takes no clicks, but can follow the pointer (the `pointer` event); a look: one background is in use, chosen in Settings → Mods → Background (with your own picture and Dim); the app's surfaces turn translucent over it |

View fields: `id` (unique in the mod), `title`, `entry` (a file in the mod), `seat`, and optionally `order`, `maxHeight`, `icon`, and for a background `preview` (a PNG, JPEG, WebP, GIF or SVG in the mod: its card's picture in Settings; without one the card shows the background itself, drawn for a moment and then held still).

Reserved for later protocol versions: `transcript` (cards after a turn), `status` (status-line items), `sidebar`.

### Styles

```json
"styles": ["theme.css"]
```

A mod with styles is a theme, a look: its CSS is added to the app's own page while it is the theme in use (one at a time, chosen in Settings → Mods → Theme), so it can change colours, type, spacing and the look of the composer or sidebar. Prefer overriding the design tokens (`--bg-100`, `--text-100`, `--accent`, `--r-composer`, … on `:root`) to restyling individual elements: tokens keep working when the app changes. The bundled themes are the examples to copy: `mods/theme-midnight` (cool blue-black) and `mods/theme-paper` (the warm paper and terracotta of 0.4.0) change only the tokens; `mods/theme-glass` (liquid glass: the sidebar, the side pane, the chat bar, cards, menus and dialogs as frosted layers, with backdrop filters, hairlines and highlights) keeps the app's colours and restyles the surfaces themselves, through the app's own class names, which a bundled theme can rely on because it is kept in step with the app; its own tokens are the `--glass-…` ones, and it changes nothing of the app's but the shadows, the dialog backdrop and three radii. The app's own look is neutral, so a theme brings colour back through the tokens for each role: `--button-fill`, `--button-fill-hover` and `--button-text` (the button that confirms), `--switch-on`, `--spinner`, `--badge-bg` and `--badge-ink` (the icon on a card), `--mark` and `--mark-ink` (the mark beside the model name), `--segment-on` (the selected segment), `--answer-fill` and `--answer-ink` (the answer button of the approval and question cards, inverted by default; Paper and Midnight give it their confirming colour), `--quiet-fill` and `--quiet-fill-hover` (those cards' Deny and Skip, a grey that stays neutral), `--side-hover`, `--side-active` and `--tree-line` (the sidebar's rows). Because a stylesheet can restyle anything, including approval cards, the first Use of a theme of yours or of a project's says so and asks first. Only one theme is in use at a time.

`@import`, `@charset`, `@namespace` and `@page` are removed: a stylesheet cannot pull in another one. A relative `url()` (an image, a font) points at the mod's own files, resolved from the stylesheet's folder; `https:` addresses load only as the app's page allows, which is not at all. Comments are removed too, so do not rely on them surviving.

### Looks

*Added in 0.3 (the release after 0.2.0). An older app ignores `contributes.looks`, so the protocol version stays 1.*

A look is a stylesheet for one region of the window. Unlike `styles`, which apply to the whole page, a look is contained: the app wraps it so that its selectors reach only its region, and only one look per region is in use at a time, chosen in Settings → Mods → Chat bar or Settings → Mods → Conversation.

```json
"looks": [
  { "id": "holo", "title": "Holo terminal", "target": "conversation", "styles": ["holo.css"], "description": "Optional, one line" }
]
```

Look fields: `id` (unique among the mod's looks), `title` (shown in Settings), `target`, `styles` (one or more CSS files in the mod, applied in order), and optionally `description` and `preview` (a PNG, JPEG, WebP, GIF or SVG in the mod: its card's picture in Settings; without one the card draws a sample in the look).

**Previews.** Settings shows a look before it is used: a sample chat bar or a sample exchange, built from the same class names and ids as the window, in a shadow root of its own. The app compiles the look for the preview's region (`.lp-root #chatbar`, `.lp-root #messages`) the way it compiles it for the window, so the same stylesheet works in both and never reaches the window from a preview. A theme is compiled for a miniature window the same way, with `:root` and `html` read as its root and `body` as its page. Write the look against the stable hooks below and it previews as it applies.

| Target | Region | Root |
| --- | --- | --- |
| `conversation` | the transcript: messages, tool rows, cards, code blocks, the task list | `#messages` |
| `composer` | the chat bar: the box you type in, its buttons and the line under it | `#chatbar` |

**Scoping.** The app wraps the look's CSS in `@scope (<root>) { … }`. Inside it, a selector matches only the root and what is inside it, so `.sidebar { … }` or `:root { … }` in a look match nothing. `:scope` is the root itself, and custom properties set on `:scope` cascade through the region only, which is the simple way to retheme one region: `:scope { --accent: #3fd0ff; --bubble: … }`. The at-rules that cannot sit inside `@scope` (`@keyframes`, `@counter-style`, `@font-face`, `@property`, at the top level or inside `@media` or `@supports`) are moved in front of it, into a cascade layer (`@layer mod-looks`). Their names are shared with the whole page, and on a collision the app's own definition wins: a look's `@keyframes spin` or `pulse` never replaces the app's animation of that name, but it does not work for the look either, so give your names a prefix (`@keyframes holo-pulse`). Two of them register something for the whole page and are kept only in the namespace reserved for mods: `@property --mod-<mod id>-…` (an `@property` for one of the app's tokens, such as `--bg-100`, would change how every surface of the app inherits its colour) and an `@font-face` whose `font-family` starts with `mod-<mod id>` (one for a family the app's stack names would replace that font everywhere); any other `@property` or `@font-face` in a look is removed. Themes (`styles`) keep both. `@import` and the other at-rules listed under Styles are removed, and relative `url()`s point at the mod's files, as for styles. A `}` that closes nothing is dropped and an unclosed block is closed, so no stylesheet can end the scope early.

**Containment.** While a conversation look is active, `#messages` has `contain: paint`: whatever the look draws, a fixed-position pseudo-element included, stays inside the transcript's box. The chat bar is not contained (its focus ring and glow sit just outside `#chatbar`), so a chat bar look can still paint over the window; either kind of look asks for the same approval at its first Use as a theme.

**State.** While a look is active, the app keeps these attributes on its region's root, so a look can react without any script:

| Attribute | |
| --- | --- |
| `data-look` | `"<mod key>/<look id>"`, the look that is active |
| `data-running` | `"true"` while a run is in progress in the session on screen, else `"false"` |
| `data-scheme` | `"light"` or `"dark"`, the scheme in effect |
| `data-mode` | the permission mode: `ask`, `acceptEdits`, `auto`, `plan` or `bypass` |
| `data-set-<key>` | one per setting of the mod (`contributes.settings`), with the key in lower case and anything but letters, digits, `_`, `.` and `-` as `-`; the value as text (`"true"`, `"12"`, `"green"`) |

They are removed when the look goes away. A setting is how a look offers a choice: a `select` setting `glow` with options `blue` and `green` is changed in Settings → Mods, and the look branches on `:scope[data-set-glow="green"]`.

**Stable hooks.** A look may rely on the roots, the attributes above, the design tokens listed under The page (and `--font`, `--mono`, `--r-control`, `--r-card`, `--r-composer`), and these class names and ids, which the app keeps from release to release:

| In the conversation (`#messages`) | |
| --- | --- |
| `.msg.user`, `.msg.user .bubble` | a message of yours and its bubble (`.bubble.rich` holds Markdown: a merged summary) |
| `.session-msg.received`, `.session-msg.sent` | a message from another session (also a `.msg.user`) and one this session sent: one line (`summary`, the session's name `.session-msg-link`) that opens to `.session-msg-body` |
| `.msg.assistant`, `.msg.assistant > .md` | a reply and its rendered Markdown; the reply streaming in is `.msg.assistant:last-child` while `data-running` is `"true"` |
| `.md h1` … `.md h6`, `.md p`, `.md ul`, `.md ol`, `.md blockquote`, `.md table`, `.md code`, `.md a` | the parts of rendered Markdown |
| `.code-block`, `.code-head`, `.code-lang`, `.code-copy`, `.code-block pre` | a code block, its header, language label, Copy button and code |
| `.thinking` | the model's thinking (a `<details>`) |
| `.tool`, `.tool > summary`, `.tool-verb`, `.tool-arg`, `.tool-meta`, `.tool-body` | a tool row (a `<details>`), its one line, what it did, on what, the time or size on the right, and what opens under it |
| `.tool-status`, `.tool-status.spin`, `.tool-status.err` | the row's icon: `.spin` while the tool runs, `.err` when it failed |
| `.tool-group` | several rows folded into one (a `<details>` like `.tool`) |
| `.tool-group > summary`, `.group-stat`, `.group-failed`, `.group-denied` | the folded line (`.live` on the group while its calls run), and on its right the lines added and removed, the failed count and the denied count |
| `.turn-head`, `.turn-head-btn`, `.turn-hidden` | the "Working for 18s" / "Worked for 53s" header over a turn's process (`.live` while it runs, `.folded` when folded), and the process nodes it hides |
| `.cmd`, `.out pre` | a command and its output inside a tool row |
| `.approval` | an approval card (restyle with care: it has to stay readable) |
| `.plan-card`, `.task-list`, `.task-row` (`data-status`: `pending`, `in_progress`, `completed`) | a plan, the task list card and its rows |
| `.msg.system` | a notice between messages (`.error` for an error) |

| In the chat bar (`#chatbar`) | |
| --- | --- |
| `#composer` (`.composer`) | the box itself |
| `#input` | the text field |
| `.composer-row` | the row inside the box: the attach button, the field and the send button |
| `#send-btn` (`.send`) | the send button: `:disabled` while there is nothing to send, `.stop` while it stops the run |
| `#attach-btn` (`.composer-plus`), `#attachments`, `.attach-thumb` | the attach button, the attached images (inside the box, above the text) and each thumbnail |
| `#composer-foot` | the quiet row under the box, outside it |
| `.foot-btn`: `#model-btn`, `#mode-btn`, `#context-meter` | its buttons: the model, the permission mode (`.plan`, `.bypass` for those modes) and the context ring |

Anything else in the markup can change between releases. Keep the conversation readable: the app's text size and line height are part of the reading experience, so a look dresses the text rather than shrinking it, and it has to work in the light and the dark scheme.

A minimal look, with a choice in Settings:

```json
{
  "protocol": 1, "id": "teal-chat", "name": "Teal chat", "version": "0.1.0",
  "contributes": {
    "looks": [{ "id": "main", "title": "Teal", "target": "conversation", "styles": ["look.css"] }],
    "settings": [{ "key": "edge", "type": "boolean", "title": "Edge on my messages", "default": true }]
  }
}
```

```css
:scope { --look: #1a9e9e; }
:scope[data-scheme="dark"] { --look: #46d1d1; }
.msg.user .bubble { background: color-mix(in srgb, var(--look) 14%, var(--bubble)); }
:scope[data-set-edge="true"] .msg.user .bubble { box-shadow: inset 3px 0 0 var(--look); }
@keyframes teal-breathe { 50% { opacity: 0.5; } }
:scope[data-running="true"] .tool-status.spin { animation: teal-breathe 1.2s ease-in-out infinite; }
```

**Sets.** A mod that contributes at least two kinds of look (a background, a chat bar look, a conversation look, a theme) is a set: while one of its looks is in the preview, "Use the whole set" next to Use applies all its parts in one choice (its first look of each kind). Kinds it has none of stay as they are. `mods/hyperspace` is the example to copy.

### Commands

```json
"commands": [{ "name": "words", "description": "Show the word count", "view": "main" }]
```

`/words some text` opens the named view (if given) and delivers a `command` event `{ name, args }` to the mod's views.

### Settings

```json
"settings": [
  { "key": "unit", "type": "select", "title": "Count", "options": ["words", "characters"], "default": "words" },
  { "key": "live", "type": "boolean", "title": "Update while streaming", "default": true }
]
```

Types: `boolean`, `string`, `number` (`min`, `max`, `step`), `select` (`options`). The values are in `harness.settings.get()` and a `settings.changed` event follows every change.

## The page

- Loaded from the mod's own origin (`mod://…/`), so relative URLs to its other files work. Several files, images and fonts are fine; so is one self-contained page.
- Sandboxed: scripts run, but the page has no cookies, `localStorage` or IndexedDB (use `harness.storage`), cannot open windows or dialogs, cannot navigate away, and cannot reach the app's page or another mod.
- Offline unless the mod has the `network` permission: without it every request that is not to the mod's own files is blocked, so a mod that can read your session has no way to send it anywhere.
- Inline `<script>` and `<style>` are allowed.

Every mod origin serves the kit under `/@harness/`:

| File | |
| --- | --- |
| `/@harness/harness.js` | the `harness` object (a classic script: `<script src="/@harness/harness.js"></script>`) |
| `/@harness/harness.css` | the app's design tokens for light and dark, a transparent page, and small classes so a panel looks native |

The stylesheet follows the app's theme by itself, including a theme mod's colours. Its classes: `h-row` (a label/value line), `h-label`, `h-value`, `h-muted`, `h-title` (a small heading), `h-list` and `h-item` (clickable rows), `h-btn` (`.primary`, a grey fill for the button that confirms; `.danger`, red text and hairline; `.ghost`; `.sm`), `h-input`, `h-switch`, `h-chip`, `h-bar` with `h-bar-seg` children (a segmented meter), `h-bar-mark` (a tick on the meter), `h-dot` (a colour swatch), `h-chev` (a disclosure chevron), `h-icon` (`.sm`), `h-segmented` (buttons with `aria-pressed`), `h-empty` (an empty state), `h-spin` (a spinner), `h-mono`, and `h-md` (Markdown: put the html of `harness.ui.markdown()` inside an element with this class and it looks like a reply in the chat, with headings, lists, tables, quotes, inline code and code blocks in the app's highlight colours; `.compact` sizes it for a rail section. Inside `h-md`, `harness.js` makes a code block's Copy button copy the block and flip to "Copied", and opens links in the browser with `harness.ui.openExternal`). `h-chip` takes `.accent`, `.success`, `.danger`; `h-btn` also `.icon`. Tokens: `--bg-000 … --bg-400`, `--text-100`, `--text-200`, `--text-400`, `--border`, `--border-subtle`, `--accent` (blue: links, the focus ring, highlights), `--danger`, `--success`, `--warn` (amber, as text), `--attention` (amber, a dot for something waiting), `--switch-on` (a switch that is on), `--button-fill`, `--button-fill-hover`, `--button-text` (the fill and label of `h-btn.primary`, grey in the app's own theme), `--spinner` (the arc of `h-spin`), `--segment-on` (the pressed segment), `--code-bg`, `--code-hover`, `--bubble` (the user's message bubble), `--tok-kw`, `--tok-str`, `--tok-com`, `--tok-num`, `--tok-pun` (syntax colours), `--font`, `--mono`, the type scale `--fs-ui`/`--lh-ui` (14/20 px: rows, buttons, inputs), `--fs-small`/`--lh-small` (13/18: headings in the rail, notes, counts), `--fs-micro`/`--lh-micro` (12/16: captions, badges), `--fs-body`/`--lh-body` (15/21: text to read), `--fs-code`/`--lh-code` (13/20: code), `--fs-title`/`--lh-title` and `--fs-head`/`--lh-head` (headings), `--r-control`, `--r-card`, and `--h-inset-x`, `--h-inset-top`, `--h-inset-bottom` for the page's own padding.

Rail and composer views are sized to their content automatically. Use the app's scale: rows at 14 px on a 32 px pitch (`h-item`), dense rows and tables at 13 px on 24 px, secondary text at 13 px, nothing under 12 px; 8 px gaps, no page padding beyond what `harness.css` gives.

## harness

`harness.ready` resolves once the app has answered the page's hello; until then calls wait (the hello itself never times out; every other call gives up after 30 seconds, except `model.complete`). Every call returns a promise. A failed call rejects with an `Error` whose `code` is `'permission'` (with `.permission` naming it), `'unavailable'`, `'timeout'`, `'unknown-method'`, `'bad-params'` or `'error'`.

`harness.info` is the hello's answer: `{ protocol, mod: { id, name, version, scope }, view: { id, seat, title }, app: { name, version }, granted: [...], theme, settings, visible }`. `app.name` is the app's name, `"Silo Harness"` (it was `"Open Harness"` before 0.6.0: a mod that shows it needs no change, one that compares it should accept both); `app.version` is the app's version.

`harness.on(event, handler)` subscribes and returns a function that unsubscribes. The app only sends events a view has subscribed to. Subscribing to an event the mod has no permission for does nothing (a console warning says so); an unknown event name is accepted and never arrives.

`harness.call(method, params)` sends any bridge method by name, for the rare case the object has no helper for it.

### Always available

| Call | |
| --- | --- |
| `harness.ui.theme()` | `{ scheme: 'light' \| 'dark', tokens }`; event `theme.changed` |
| `harness.ui.resize(height?)` | report the content height (done for you; call it after an animation) |
| `harness.ui.setTitle(text)`, `harness.ui.setBadge(value \| null)` | the view's header title and its badge |
| `harness.ui.toast(text, { kind })` | a short message at the bottom of the window (`info` or `error`) |
| `harness.ui.open(viewId?)` | bring a view of this mod to the front |
| `harness.ui.copy(text)` | copy to the clipboard |
| `harness.ui.openExternal(url)` | open an http(s) link in the default browser |
| `harness.ui.markdown(text)` | `{ html }` rendered the way the chat renders Markdown |
| `harness.ui.openSettings(section?)` | open Settings at a section (`general` when left out; `model`, `permissions`, `context`, `mods`, …); `scheduled` and `dreaming` open their pages |
| `harness.ui.openPage(page, { form }?)` | open the Scheduled tasks (`scheduled`) or the Dreaming (`dreaming`) page in the main column; `{ form: 'new' }` with `scheduled` opens the New task form there |
| `harness.storage.get(key, fallback)`, `.set(key, value)`, `.remove(key)`, `.keys()` | this mod's own JSON storage, kept across sessions; `get` resolves with the value (or `fallback` when nothing is stored), `keys` with an array; `harness.storage.session` is the same per session. A value may be up to 256 KB, a mod's storage 5 MB |
| `harness.settings.get()` | the values of the mod's settings; event `settings.changed` |

Events: `theme.changed`, `settings.changed`, `visibility.changed` `{ visible }`, `command` `{ name, args }`, `pointer` `{ x, y }` (background views only: where the pointer is, as fractions of the window from 0 to 1, at most 30 times a second while it moves over the app's own page, not over another mod's frame; a view in another seat may subscribe, and nothing arrives; added in 0.3), and `session.switched` `{ id }` when another session comes on screen (it carries nothing but the id, so a view without `session:read` can still reset itself). When it arrives, `harness.storage.session` and every `harness.session.*` call already refer to the new session.

### session:read

| Call | Result |
| --- | --- |
| `harness.session.get()` | `{ id, title, cwd, origin, parentId, forkedFrom, messageCount, createdAt, updatedAt, running, attention }` |
| `harness.session.transcript({ limit })` | `{ items }`: `{ role: 'user' \| 'assistant' \| 'tool' \| 'plan' \| 'artifact' \| 'image' \| 'compaction', text, name?, ok? }`, oldest first |
| `harness.session.tasks()` | `{ tasks: [{ id, title, status }] }` |
| `harness.session.plan()` | `{ plan: { id, title, markdown, status } \| null }` |
| `harness.session.outputs()` | `{ outputs: [{ kind: 'artifact' \| 'image' \| 'file', id, title, detail, updatedAt }] }` |
| `harness.session.context()` | `{ tokens, limit, threshold, autoCompact, basis, slices: [{ key, label, tokens, items? }], messages, compactable, compactions, updatedAt }` |
| `harness.session.related()` | `{ parent, children, forks }` (sub-sessions and forks of the session on screen) |
| `harness.outputs.open({ kind, id })` | show an output: an artifact in the Browser, an image in the viewer, a file in the Diff |

Events: `session.changed` (another session came on screen, or this one's title or state changed; reload only when its `id` differs), `related.changed` (a sub-session, fork or the parent changed state), `run.started` `{ sessionId }`, `run.ended` `{ sessionId, reason, text }` (`reason` is `done`, `aborted`, `max_turns`, `error`, `plan` or `loop`), `message.user` `{ text, origin }`, `message.assistant` `{ text }`, `message.delta` `{ text }` (streaming), `message.discarded` (the text streamed since the last `message.assistant` is dropped: the call is tried again), `tool.started` `{ id, name, args }`, `tool.ended` `{ id, name, ok, durationMs }`, `tasks.changed` `{ tasks }`, `plan.changed` `{ plan }`, `outputs.changed`, `context.changed` `{ tokens, limit }`.

"The session" is always the one on screen; the events follow it when the user switches.

### session:send

`harness.session.send(text)` sends a message as the user (queued if a run is in progress). `harness.composer.insert(text)` puts text in the composer instead.

### session:control

`harness.session.stop()`, `harness.session.compact(focus?)`, `harness.sessions.open(id)`, `harness.sessions.create()`, `harness.sessions.spawn({ title, prompt })`, `harness.sessions.merge(id)`.

### sessions:read

`harness.sessions.list()` and `harness.sessions.search(query, { limit })` reach every conversation, not just the one on screen.

### model

`harness.model.complete({ messages, system, maxTokens, context }, onDelta)` → `{ text, usage }`. One reply from the configured model, with no tools. `messages` is `[{ role: 'user' | 'assistant', content }]`; `context: 'session'` puts the open session's conversation in front of them (read-only: nothing is added to the session); `onDelta(text)` receives the reply as it streams. `harness.model.cancel()` stops the call in progress, which then resolves with what had arrived and `stopped: true`. When no key or model is set up the call rejects with `unavailable`; when the provider cannot be reached or refuses, with `error` and the provider's message; after two minutes, with `timeout`. A mod may have two calls in flight. This spends tokens, which the permission says when the mod is turned on.

### skills:read

`harness.skills.list()` → `[{ name, description, path, source }]`. `harness.skills.usage({ scope: 'session' | 'all' })` → `{ items: [{ name, count, lastUsedAt }] }`. Event `skills.used` `{ name }`.

### config:read and config:write

`harness.config.get()` → `{ provider, model, workingDirectory, home, permissionMode, theme, autoCompact, compactThreshold, keepAwake, notifications, background, contextLimit }` (`provider` is the name of the provider in use: `ollama`, `portkey` or the name of a named provider such as `openrouter`; `workingDirectory` is the folder of the session on screen, `home` the user's home folder for showing paths as `~/…`). Keys and other secrets are never included. Event `config.changed`, which is also sent when `workingDirectory` changes because a session in another folder came on screen.

`harness.project.git()` → `{ root, repository, branch }` for the folder of the session on screen: the repository's root folder, `owner/name` from the `origin` remote's URL and the branch checked out, each `null` when it is not known (not a repository, no such remote, a detached HEAD). It needs `config:read`.

`harness.config.set(patch)` changes `theme`, `autoCompact`, `compactThreshold`, `keepAwake`, `notifications` or `background`, and nothing else (any other key is refused as bad params): a mod cannot change the permission mode, the provider, or what is trusted.

### schedules

`harness.schedules.list()`, `.create(input)`, `.update(id, patch)`, `.remove(id)`, `.runNow(id)`; event `schedules.changed`. A schedule with `target: 'session'` and no `sessionId` runs in the session on screen when it is created.

### remote

`harness.remote.status()` → `{ enabled, running, urls, clients }`, `harness.remote.start()`, `harness.remote.stop()`; event `remote.changed`.

### network

No call: with this permission the page may load and fetch `https:` resources.

### hooks

*Added in 0.8.0. An older app ignores `contributes.hooks`, the `hooks` permission and the `worker` seat, so the protocol version stays 1.*

A mod can handle the same hook events as a command in `settings.json` ([hooks.md](hooks.md)): see a tool call before it runs and deny it, ask for the approval card, allow it or rewrite its input; add context to a prompt; keep a turn going. List the events in `contributes.hooks` (Settings shows them, and the app sends no others), ask for the `hooks` permission, and register a handler in a view:

```js
harness.hooks.on('PreToolUse', (input) => {
  if (input.tool_name === 'Bash' && /\brm\b/.test(input.tool_input.command)) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No rm here' } };
  }
}); // returns an off function; harness.hooks.off('PreToolUse') does the same
```

`handler(input)` receives the object a command hook reads on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, … ) and returns, or resolves to, the object a command hook would print, or nothing (no decision). A handler that throws is a non-blocking error. The answers merge with the settings hooks' by the same rule (deny over ask over allow, any block blocks), and Settings → Hooks lists the mod's hooks with its name as their source, and their runs.

The host sends each request to every view of the mod that registered a handler for the event, in the order `contributes.views` lists them, and takes the first answer that is not empty. It waits at most 10 seconds in all (or the entry's `timeout`, up to 600); a mod that does not answer in time is skipped, with a log line and a "skipped" run in Settings → Hooks, and decides nothing. A view only receives requests while it is loaded: a `worker` view always is while the mod is on, a rail section is, a tab only once it was opened. Without the window (the app has no window) mods' hooks are skipped.

## Permissions

| Permission | Lets the mod |
| --- | --- |
| `session:read` | read the session on screen: its messages, tool calls, tasks, plan, outputs and context use |
| `session:send` | send messages as you and fill the composer |
| `session:control` | stop a run, compact, open or start sessions, start and merge sub-sessions |
| `sessions:read` | list and search all your conversations |
| `model` | call the model (uses tokens) |
| `skills:read` | list skills and how often they are used |
| `config:read` | read non-secret settings |
| `config:write` | change the theme, auto-compact, keep-awake, notifications and background |
| `schedules` | list, create, change and delete scheduled tasks |
| `remote` | see and switch remote control |
| `network` | reach the internet |
| `hooks` | react to the agent's actions before and after they happen, and block them: tool calls, prompts, the end of a turn. It sees every tool call's input, file contents included (0.8.0) |

Not available to any mod, whatever it asks for: answering approval cards, changing the permission mode, reading API keys, trusting MCP servers, settings files or other mods, and reading or writing files outside its own folder.

## Under the object: the wire protocol

`harness.js` is a convenience. A page can speak the protocol itself: JSON-RPC 2.0 messages over `window.parent.postMessage`.

```
page → app   { "jsonrpc": "2.0", "id": 1, "method": "hello", "params": { "protocol": 1 } }
app → page   { "jsonrpc": "2.0", "id": 1, "result": { "protocol": 1, "mod": {…}, "view": {…}, "app": {…}, "granted": […], "theme": {…}, "settings": {…}, "visible": true } }

page → app   { "jsonrpc": "2.0", "id": 2, "method": "session.tasks" }
app → page   { "jsonrpc": "2.0", "id": 2, "result": { "tasks": [] } }

page → app   { "jsonrpc": "2.0", "id": 3, "method": "events.subscribe", "params": { "events": ["tasks.changed"] } }
app → page   { "jsonrpc": "2.0", "method": "event", "params": { "name": "tasks.changed", "data": { "tasks": [] } } }
```

Hooks go the other way: the app sends the request and the page answers it.

```
page → app   { "jsonrpc": "2.0", "id": 4, "method": "hooks.subscribe", "params": { "events": ["PreToolUse"] } }
app → page   { "jsonrpc": "2.0", "id": "hook-7", "method": "hook", "params": { "event": "PreToolUse", "input": { "tool_name": "Bash", … } } }
page → app   { "jsonrpc": "2.0", "id": "hook-7", "result": { "hookSpecificOutput": { "permissionDecision": "ask" } } }
```

The answer is `result` (the output object, or `null` for no decision) or `error`. A page that never answers is skipped when the time runs out; `hooks.unsubscribe` takes a registration back. Both need the `hooks` permission.

Method names are the call names above (`ui.setBadge`, `storage.get`, `session.transcript`, `model.complete`, …) with their arguments as a `params` object. Every result is an object or nothing; `harness.js` hands most of them back as they are and unwraps three: `storage.get` (`{ value }`), `storage.keys` (`{ keys }`) and `skills.list` (`{ skills }`). `events.subscribe` for an event the mod has no permission for is refused with `4003`. Errors use `{ "code", "message", "data" }` with these codes: `-32601` unknown method, `-32602` bad params, `4003` permission needed (`data.permission`), `4004` not available right now, `4008` timed out, `4000` anything else. The app identifies the caller by the frame the message came from, never by what the message says.

## Building one with the agent

Ask for it: "make a mod that shows the git branch and how many files changed". The agent loads the `create-mod` skill, writes the folder, and checks it with the `mod_check` tool, which reports manifest problems and any errors the page threw. A card in the chat offers to turn the new mod on; after that the agent's edits reload it as they land, and `mod_check` gives it the page's errors to fix. For a look the card offers **Preview** (its tab in Settings, with it in the preview) and **Use** (the card says what it may do, so using it there is the approval), and the agent's edits show in the preview as they land.

By hand: Settings → Mods → New mod writes a starter folder (a view in the seat you pick, a conversation or chat bar look, or a theme) and opens it; on a look tab, New ⌄ → From a template writes one of that kind and shows it previewed. `mod_check` is also what the Settings page shows under a mod's Problems.

## Installing and sharing

A mod is its folder. Copy it into `~/.silo-harness/mods/`, or use Settings → Mods → Install and give it a folder or a Git URL (the repository is cloned into the mods folder). To share one, publish the folder; adding the `silo-harness-mod` topic on GitHub makes it findable.

## What keeps this safe

- A mod's pages run in sandboxed frames on their own origin, with no access to the app's page, to Node, to your files or to other mods.
- Every request to the app is checked against the permissions you granted that mod. The frame, not the message, says which mod is asking.
- Without `network` a mod cannot make a request or navigate anywhere, so reading your session and sending it somewhere takes two permissions you can see.
- Mods never get the powers listed under Permissions as unavailable. In particular a mod, and therefore an agent that writes mods, cannot approve its own tool calls.
- Mods that came from a project folder, or that the agent wrote, stay off until you turn them on, and their looks apply only once you used one and approved it. Growing a mod's permissions pauses it until you agree.
- Styles are the exception to the sandbox: a stylesheet applies to the app's own page. Treat a theme like a browser theme from someone you trust. A look is scoped to its region, so its selectors cannot reach the rest of the app, but it is still CSS on the app's page and asks for the same approval at its first Use.
- A preview in Settings is not the window: a look or a theme previewed there is compiled for the preview's own root, in a shadow root that takes no input, so trying one before approving it cannot restyle the app. A background previewed before its first Use runs its page with nothing granted.
