# UI audit: Silo Harness vs Claude Code desktop (2026-10-28)

Goal: make Silo Harness feel like a sibling of the Claude Code desktop app (Code tab) and, where cheap, better. This document records what was inspected, the reference values, every gap found, and the implementation spec that follows from it.

## Method

- Silo Harness was driven over the Chrome DevTools Protocol through every state (empty, settings, slash menu, browser pane, a real tool-using run with qwen3:8b, expanded tool rows and thinking, an approval card) in light and dark, with 2x detail crops of the composer, sidebar, top bar, approval card and tool rows. Screenshots live in the session scratchpad under `audit/shots/`.
- Reference values come from the design tokens the installed Claude desktop app ships in its main-window stylesheet (read locally, used only for colour, size, radius, weight and font-stack values; no code or fonts were copied). The proprietary Anthropic Sans / Anthropic Serif fonts are not redistributable, so Silo Harness uses the platform equivalents listed below.

## Reference tokens (Claude desktop) and what Silo Harness should use

Fonts (Claude → Silo Harness):

| Role | Claude | Silo Harness |
| --- | --- | --- |
| UI and transcript | Anthropic Sans, fallback ui-sans-serif/system-ui | `-apple-system, BlinkMacSystemFont, "SF Pro Text", ui-sans-serif, system-ui, sans-serif` |
| Display (greeting, empty state) | Anthropic Serif, fallback ui-serif/Georgia | `ui-serif, "New York", Georgia, serif`, weight 500 |
| Code | ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas | same stack |
| Weights | regular 400, medium 500, semibold 580, bold 600 | 400 / 500 / 600 / 600 (never 700) |

Type scale (size/line-height): xs 12/16, sm 14/20, base 16/24, lg 18/28, xl 20/28, 2xl 24/32. The transcript body is sm (14/20); chrome (sidebar, top bar, chips, tool rows) is 13/18 to 14/20; captions and meta are xs (12/16). Silo Harness uses these measured sizes (2026-11-20): reading text (replies, the user's bubble, tool and status lines, the chat bar, session titles) sm 14/20 (`--fs-body`, `--fs-title`), reply headings 16/24 semibold for h1–h2 (`--fs-head`) and 14 semibold below, code 12.5/20 inline and in blocks (`--fs-code`); rows and controls 14/20, secondary 13/18, captions 12/16. Letter-spacing is normal everywhere except uppercase group labels (0.04em).

Colours (hex, converted from the HSL tokens):

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| bg-000 | #ffffff | #30302e | surfaces: composer, cards, popovers, dialog |
| bg-100 | #faf9f5 | #262624 | main background |
| bg-200 | #f5f4ee | #1f1e1d | sidebar, secondary panes |
| bg-300 | #f0eee6 | #141413 | hover fills, user bubble (light), code blocks (dark) |
| bg-400 | #e8e6dc | #000000 | pressed fills, strong dividers |
| text-100 | #141413 | #faf9f5 | primary text |
| text-200 | #3d3d3a | #c2c0b6 | secondary text, chrome |
| text-400 | #73726c | #9c9a92 | muted, placeholders, meta |
| border base | #1f1e1d at 0.15 (subtle 0.08) | #dedcd0 at 0.15 (subtle 0.08) | all hairlines |
| accent | #d97757 | #d97757 | brand, send button, focus |
| accent hover | #c6613f | #e08a6c | |
| danger | #b53333 | #dd5353 | errors, destructive |
| success | #2f7613 | #45931f | ok states |
| git added | #1e9e3c | #32d74b | diff gutters and counts |
| git removed | #cd2054 | #ff2c56 | |
| git modified | #98801f | #ffd014 | |
| diff add fill | success at 0.14 | #32d74b at 0.16 | diff line backgrounds |
| diff del fill | git removed at 0.12 | #ff2c56 at 0.16 | |

Radii: control 6px, card and tool body 8px, popover and dialog 12px, composer 16px, pills 999px. Shadows: sm `0 1px 2px rgba(0,0,0,.05)`; popover `0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1)`; dialog `0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)` (dark: raise alphas to .4/.5). Focus ring: 2px accent at 0.5 outside the control, only for keyboard focus (`:focus-visible`).

## Findings

Severity: H = clearly worse than Claude Code, M = visibly different, L = polish.

Typography and colour

1. (M) Body line-height is 1.55; Claude is 20px on 14px (1.43). Chrome is a mix of 13, 13.5 and 12.5px. Adopt the scale above.
2. (M) Dark surfaces are off-token: surface #2b2a28, surface-2 #333230, muted #9c9992, text #e8e6e1 vs the values above. Light sidebar #f3f1ea vs #f5f4ee. Borders are solid greys instead of alpha hairlines, so they look heavier in dark mode.
3. (M) Headings in the transcript are 15px bold; Claude uses 16/24 semibold with 24px top margin for h1–h2 and 14px semibold for h3+.
4. (L) The empty-state greeting is sans 20px bold; Claude's greeting is a serif display face. Use the display stack at 28px/34px weight 500.

Icons and glyphs

5. (H) Every icon is a Unicode glyph: ☰ ⑂ 🗑 ◫ ↻ ‹ › ▸ ✳ ↑ ■. The trash emoji and the hair-thin fork and chevron glyphs look nothing like Claude's consistent 16px stroke icons. Replace all of them with inline SVG icons (16px, 1.5px stroke, currentColor, round caps), hand-written, with a shared `icon(name)` helper: panel-left, plus, search, settings (gear), trash, git-branch (fork), globe/browser, arrow-up, square (stop), chevron-right, chevron-down, copy, check, refresh, arrow-left, arrow-right, external-link, x, folder, terminal, file-text, pencil, list, search-code (grep), sparkles (skill), eye (read page), mouse-pointer (click), keyboard (type), scroll, camera (screenshot), code (eval), circle-alert (error), info.

Sidebar

6. (M) "+ New session" is a loud full-width accent button; Claude's is a quiet surface button with a plus icon, accent only on hover. The brand label is centred text; Claude keeps the window-control row clean with a sidebar-collapse icon at the right.
7. (M) Session rows have a status dot and a title only. Claude rows show title, a running spinner when active, and hover actions. Add: hover reveals a "…" menu with Rename, Fork, Delete; right-click opens the same menu; double-click renames inline (Enter saves, Escape cancels; uses `oc.sessions.rename`); the row of the running session shows a small spinner instead of the dot; the active row uses bg-000 with a hairline, hover uses bg-300.
8. (L) Group labels ("TODAY") are 11px uppercase; keep uppercase but at 11px/16px, 0.04em, text-400, 12px top padding.
9. (L) The footer is a text button "Settings"; make it an icon + label row (gear + "Settings", `⌘,` hint on the right) and keep it pinned to the bottom.

Top bar

10. (M) Session title is static. Claude lets you rename by clicking the title. Make the title an inline-editable field (click or F2 to edit; Enter saves via `oc.sessions.rename`, Escape cancels); show the generated title when it changes (the `session_changed` event).
11. (M) Fork and delete are bare glyph buttons; browser toggle is "◫ Browser". Use icon buttons with tooltips, and make the browser toggle a labelled icon toggle ("Browser") with an active state that matches Claude's pane toggles (filled bg-300, text-100).
12. (L) The working-directory line is a plain link; prefix it with a folder icon and make the hover state obvious (underline on hover is fine).

Transcript

13. (H) Assistant markdown lacks tables, blockquotes, horizontal rules, nested lists, task lists, `*single-asterisk emphasis*`, strikethrough, and autolinks. Add them to the renderer (keep it a small hand-written parser; no dependencies; escape everything first).
14. (H) Code blocks have no language label, no copy button and no highlighting. Add a header row (language left, Copy button right that flips to "Copied" for 1.5s) and a tiny tokenizer-based highlighter for js/ts/jsx/tsx, python, shell/bash/zsh, json, html/css, go, rust, yaml, markdown fences (keywords, strings, comments, numbers, punctuation only; colours: keyword accent-ish `#c0533a`/`#e39678`, string success, comment text-400, number `#8a6d00`/`#ffd014`). Unknown languages render plain.
15. (M) Assistant messages have no hover actions. Add a hover toolbar at the top-right of each assistant message with Copy (copies the raw markdown).
16. (M) User bubbles: use bg-300 in light and bg-000 in dark, radius 18px with a 4px bottom-right corner, 14/20 text, max-width 85%, no drop shadow. Preserve newlines.
17. (M) The thinking block says "Thought for 357 words". Claude says "Thought for 12s". Time it (from first thinking_delta to thinking_done); while live show "Thinking" with a subtle animated ellipsis; keep the collapsible body in text-400 italic with a 2px left rule; cap height at 240px with inner scroll.
18. (M) Tool rows: the status dot is fine but there is no icon, the expand chevron is a 2px glyph, and the meta only says "N lines". Match Claude: `[chevron] [tool icon] Verb  argument  …  meta`. Meta per tool: read_file "N lines"; write_file "+N lines"; edit_file "+a −b" coloured with the git tokens; bash "exit 0 · N lines" or "exit 1" in danger; grep/glob "N matches"; browser_* "ok"; everything gets a duration ("1.2s") when `tool_end.durationMs` is present. Chevron rotates on open; the summary row is 32px tall with 8px gaps; the body is indented under the icon column.
19. (M) Diffs have no gutter. Render edit_file and write_file as a proper diff: a header strip with the file name (basename bold, directory text-400) and the +/− counts; then rows with a 40px line-number gutter (old and new numbers where applicable), a sign column, and the line text; add/del fills as above; max height 360px then an inner scroll; long lines wrap.
20. (M) Bash rows should show the command in the body in a mono block prefixed by `$`, then the output block; the output block gets a Copy button.
21. (L) Consecutive read_file/glob/grep/list_directory rows (3 or more) should collapse into one group row "Read 4 files" that expands to the individual rows.
22. (L) Fade-in new nodes (opacity 0→1, translateY 2px, 120ms); respect `prefers-reduced-motion`.
23. (M) The approval card copies Claude's wording and keys: title "Allow Silo Harness to run this command?" (or "edit <basename>?", "write <basename>?"), the detail block (for edits show the diff component, not raw text), then buttons right-aligned: Deny (plain), "Allow for this session" (plain), Allow (accent). Keyboard: Enter/y allow, n deny, a allow-for-session; show the keys as `kbd` badges inside the buttons on the right (Claude style), not a "y / n" string on the left. After deciding, collapse the card to a one-line muted summary ("Allowed · ls -la", "Denied") with a check or x icon.
24. (M) The status line while working: spinner + verb ("Working…", "Thinking…", "Running bash…", "Waiting for approval") + elapsed, then on the right the token counter from `usage` events ("12.4k tokens" = prompt+completion of the latest call, with a tooltip showing input/output) and "esc to interrupt" in a kbd badge. Keep the Stop button behaviour. If no usage event arrives, hide the counter.
25. (L) System notices (mode changes, fork notices) should be a quiet centred 12px line with an info icon; errors a danger-tinted row with an alert icon.

Composer

26. (M) Remove the permanent hint line under the composer ("Enter to send …"); Claude shows nothing there. Fold the hints into the textarea placeholder ("Describe a task, / for skills, ⇧Tab to change mode") and the chip tooltips.
27. (M) The mode chip should open a popover menu (click) listing Ask before actions / Auto-approve / Read-only with a one-line description each and the active one checked; Shift+Tab still cycles. The chip shows an icon per mode (shield-check / zap / eye) and keeps the accent (auto) and success (read-only) tints.
28. (M) The model chip should open a popover with the Ollama models from `oc.listOllamaModels()` (current one checked, click switches via `setConfig`), the provider name as a section label, and a last row "Settings…" that opens the dialog. For Portkey show the configured model and the Settings row only.
29. (L) Send button: 32px accent circle with the arrow-up icon; disabled at 0.4 opacity; while running it becomes a text-100 circle with the square icon (stop). The composer border is a hairline; focus-within shows the accent ring (2px at 0.35) instead of a 3px glow.
30. (L) The slash menu: add a section label "Skills" and a right-aligned source tag (project / user / bundled) per row; selected row uses bg-300; show `↵` and `tab` kbd hints in a footer line.

Browser pane

31. (M) The bar needs: back, forward, reload (spinner while loading), the URL pill, an "Open in browser" icon button (`oc.browser.openExternal()`), and a 2px accent progress bar under the bar while `loading`. Show the page title in the pill's placeholder position only when the field is not focused (current behaviour is fine).
32. (M) The pane width is fixed at 48%. Add a 6px drag handle between the transcript and the pane (cursor col-resize, min 360px, persisted in localStorage); call `reportBounds` while dragging.

Settings dialog

33. (M) Fieldsets with legends and default blue radios look like a stock form. Restyle: a 600px dialog with a title row and close button; sections with a 13px semibold heading and a one-line description; labels above inputs at 12px text-400; a segmented control for the provider; inputs 32px tall with 6px radius and hairline borders; native `select` restyled with a chevron; checkbox rows as switches; a sticky footer with Cancel / Save. Add a "Generated titles" switch bound to `config.autoTitles`.
34. (L) The dialog should remember the scroll position and not exceed 86vh; the Portkey section should be hidden (not dimmed) when Ollama is selected, and vice versa, with a small "Show" link if someone wants to pre-fill the other provider.

General

35. (M) Scrollbars are the default 15px macOS legacy bars inside the transcript. Use 8px overlay-style thin scrollbars (`::-webkit-scrollbar` width 8, thumb text-400 at 0.35, hover 0.55, transparent track) everywhere.
36. (L) Keyboard focus is invisible on buttons; add a `:focus-visible` ring.
37. (L) Add a shortcuts sheet (⌘/ or "?" when the composer is empty) listing: ⌘N new session, ⌘B sidebar, ⌘⇧B browser, ⌘, settings, ⇧Tab mode, Esc stop, ⌘K focus composer, ⌘F search sessions.
38. (L) Text selection colour: accent at 0.25.
39. (L) The window background flashes the wrong colour when the theme is set to "system" and the OS switches; the renderer already follows `prefers-color-scheme`, so just make sure `color-scheme` is set on `:root` in both modes (it is) and that the dialog backdrop uses rgba(0,0,0,.4) light / .6 dark.

## Implementation notes for whoever does this

- Keep every element id and class the CDP test scripts rely on: `#input`, `#send-btn`, `#stop-btn`, `#new-session-btn`, `#settings-btn`, `#settings-cancel`, `#settings-form`, `#session-list`, `.session-item` (+ `.active`, `.running`), `#session-title`, `#sidebar-toggle`, `#fork-btn`, `#delete-btn`, `#browser-toggle`, `#mode-btn` (+ classes `auto` / `readonly`), `#model-btn`, `#status-line`, `#status-text`, `#status-time`, `#messages`, `#empty-state`, `.msg.user`, `.msg.assistant`, `.thinking`, `.tool` (+ `.tool-status.ok/.err/.spin`), `.diff .add` / `.diff .del`, `.approval .btn.primary`, `.approval .decided`, `.slash-menu` / `.slash-item.active`, `#url`, `#back-btn`, `#fwd-btn`, `#reload-btn`, `#browser-view`, `#browser-title`. The `data-theme` attribute on `<html>` ("light" / "dark" / "") must keep working.
- No new runtime dependencies. No web fonts. Inline SVG only.
- The renderer is plain TypeScript compiled with `tsc -p tsconfig.renderer.json` into `dist/renderer` and loaded as an ES module; the build copies `index.html` and `styles.css` (update the copy step in `package.json` if files are added).
- Events and APIs available from the main process: `AgentEvent` (see `src/shared/types.ts`), including `usage`, `tool_end.durationMs`; `oc.sessions.rename`; `oc.browser.openExternal`; `config.autoTitles`.
