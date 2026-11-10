# The browser: where it stands, and a spec in three phases

Companion to [research.md](research.md), which surveys how other harnesses do this and ends with a ranked list of what to match. This document is the plan. Nothing in it is built; the user reviews it first.

Contents: [1. Our browser today](#1-our-browser-today) · [2. Principles and threat model](#2-principles-and-threat-model) · [3. Phase 1: the essentials](#3-phase-1-the-essentials) · [4. Phase 2: a password manager](#4-phase-2-a-password-manager) · [5. Phase 3: the rest](#5-phase-3-the-rest) · [6. Decisions for the user](#6-decisions-for-the-user) · [7. Testing approach shared by every phase](#7-testing-approach-shared-by-every-phase)

Marks: **[decision]** needs the user's call before building; **[verify]** a fact we should confirm on a real build before relying on it.

---

## 1. Our browser today

Read on branch `next` at 615fb1d. Files: `src/main/browser.ts` (`BrowserController`), `src/main/tools/browser.ts` (the `browser_*` tools), `src/main/ipc.ts` (the `browser:*` channels), `src/preload.ts` (`oc.browser`), `src/renderer/renderer.ts` (the side pane and the URL bar; on `cleanup` the same code lives in `src/renderer/side-pane.ts`), `src/renderer/index.html` (`#browser-pane`), `src/shared/types.ts` (`BrowserState`, `oc.browser`), `src/main/agent.ts` (where tool calls run), `test/live/rig.js`.

### What we have

| Area | What exists | Where |
|---|---|---|
| Hosting | One `WebContentsView` with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, added to the window's `contentView`; the renderer reports its slot's bounds and visibility over `browser:bounds` / `browser:visible`, and hides it while a dialog, a page (Scheduled, Dreaming) or another pane tab is on screen | `BrowserController` constructor, `setBounds`, `setVisible`; renderer `reportBounds`, `syncBrowserView` |
| Session | **None chosen**: the view uses Electron's default session, the same one the app's own renderer, the `artifact://` pages and the mod pages run in. Cookies persist across restarts because the default session is on disk under `userData` | `new WebContentsView({ webPreferences })` with no `partition` |
| User agent | ` Electron/x` and the app's own token stripped, so pages see a plain Chrome UA | constructor, `setUserAgent` |
| Popups | `setWindowOpenHandler` denies every popup and loads its URL in the same view | constructor |
| Navigation | URL bar (`#url`), back, forward, reload, "Open in browser" (`shell.openExternal`, http/https/file only), title and loading state; a bare phrase becomes a DuckDuckGo search; relative paths resolve against the current page | `navigate`, `state`, `emitState`; renderer `applyBrowserState`; `ipc.ts` `browser:open-external` |
| Agent perception | `browser_read_page` (a DOM walk that tags visible interactive elements `[ref_N]` with a `data-oc-ref` attribute; `filter=all` adds headings and text), `browser_find`, `browser_get_text` (`main`/`article` first), `browser_screenshot` (`capturePage` → PNG in `temp/silo-harness-screenshots`, shown to the user, sent to the model only with `sendScreenshotsToModel`), `browser_eval` (`executeJavaScript` in the main world) | `readPageScript`, `readPage`, `find`, `getText`, `screenshot`, `evaluate` |
| Agent action | `browser_click` by visible text (`findRef`: exact > prefix > substring, errors list candidates), by ref or by coordinates, with a blue flash on the element; `browser_type` into a field by label/placeholder or ref (`insertText`, optional clear and Enter); `browser_press_key`; `browser_scroll`; `browser_wait_for` (text or selector, 200 ms polling); `browser_navigate` | `click`, `clickAt`, `type`, `pressKey`, `scroll`, `waitFor` |
| Multi-session rule | The pane belongs to the session on screen; a background session's `browser_*` call gets `BROWSER_BACKGROUND` | `agent.ts` `execTool`, `test/runtime.js` check 6 |
| Artifacts | `create_artifact` navigates the pane to `artifact://view/...` and brings the Browser tab forward | `agent.ts` ~1411, renderer |
| Hooks | `PreToolUse`/`PostToolUse` fire for `browser_*` with the tool's own name and arguments; a hook can `deny`, `ask` or `allow` | `agent.ts` `execTool`; `docs/hooks.md` |
| Live tests | The rig drives the renderer over CDP; the browser view is another CDP target, not yet used; `browser_screenshot` fails in the hidden test window (backlog #28) | `test/live/rig.js`, `docs/ux-backlog.md` |

### What is missing, against the research's ranked list

| # | Gap | Detail |
|---|---|---|
| 1 | **No approval for any browser action.** | None of the `browser_*` tools calls `ctx.approve`; in Ask mode the agent can navigate, click, type and run JavaScript on any site without a card. Only a hook can gate it. Every in-app browser in the research asks per site. |
| 2 | **Password values reach the model.** | `readPageScript`'s `label()` includes `el.value` for every `input`, password fields included: if the user has typed a password in the pane, `browser_read_page` and `browser_find` put it in the tool result, the transcript (`sessions/<id>.json`), hook payloads (`tool_response`), the history search index, the Markdown export and the remote page. `browser_eval` can read any field, `document.cookie` and `localStorage` outright. `browser_type` echoes the typed text (`Typed "…"`). Nothing is redacted. |
| 3 | **Shared default session.** | Signed-in cookies live in the same session as the app UI, artifacts (model-written HTML) and mods. Same-origin policy keeps them apart in the renderer, but the jar, cache and permissions are shared, there is no "Keep cookies" or "Clear browsing data", and a partition rename later would log the user out. |
| 4 | **Permission requests are auto-granted.** | No `setPermissionRequestHandler`: Electron approves camera, microphone, notifications, clipboard-read and the rest for any page the agent visits. |
| 5 | **Certificate errors have no UI.** | No `certificate-error` handler; the load fails with Chromium's plain error page and no explanation or per-host "proceed". |
| 6 | **Popups and OAuth.** | The popup's URL replaces the page, so `window.opener`/`postMessage` sign-in flows (Google's popup flow, many SSO widgets) cannot report back. Redirect-style flows work by accident. Google's "This browser or app may not be secure" against our stripped UA is **[verify]**. |
| 7 | **No tabs.** | One page at a time; an agent that opens a second site loses the first; artifacts take over the page the user was reading. |
| 8 | **Downloads and uploads.** | No `will-download` handler: Electron shows a save dialog with no progress, no list, no cancel and no agent awareness. Uploads use the native picker, which the agent cannot drive (fine) but the agent has no way to attach a file at all. |
| 9 | **Find, zoom, print, PDF, DevTools, context menu, history.** | None. Right-click does nothing; ⌘F is taken by session search. The View menu's zoom roles may act on the focused view **[verify]**. |
| 10 | **No sensitive-site awareness, no "never" list.** | The system prompt says pages are untrusted; nothing stops the agent on a bank, a mail client or a login page, and nothing refuses purchases or account creation. |
| 11 | **No password manager, no autofill, no passkeys.** | Electron has none built in; we add none. `configureWebAuthn` is never called, so `isUserVerifyingPlatformAuthenticatorAvailable()` is false and passkey prompts fail. |
| 12 | **No tracker or ad blocking, no Safe Browsing.** | Electron ships without Safe Browsing; we add no filtering. |

Things we do well that the research confirms are the right call: a real embedded Chromium the user and the agent share (as Claude Code and Codex do), accessibility-style outlines with refs as the primary perception (as Playwright MCP, Chrome DevTools MCP and Anthropic's API tool do), screenshots opt-in to the model, the "act by visible text" affordance, the flash on the element the agent is about to touch, and the foreground-session rule.

---

## 2. Principles and threat model

**Principles.**
1. The pane is the user's browser first. Sign-ins, cookies, saved passwords and downloads belong to the user; the agent is a guest that acts with permission and sees only what a page would show a stranger with the same session.
2. Credentials never pass through the model, the transcript, hooks, mods or the remote page. If a fill cannot be done without the model seeing the value, it is not done.
3. Secure by default, plain to override: permissions denied until asked, certificates enforced, agent actions approved per site, with one switch each in Settings → Browser.
4. Main process owns everything that matters. The renderer draws bars and cards; it never holds a password, a cookie or a permission decision.
5. Every phase ships on its own and is tested headless and live.

**Who we defend against.**

| Actor | Can do today | Wants |
|---|---|---|
| The model (through tools) | Read any page in the pane, run JavaScript, type anything, navigate anywhere, in any mode | Credentials, cookies, tokens, personal data on logged-in pages; to act where it should not (buy, delete, send) |
| A page (prompt injection) | Put text in the page that the model reads as instructions | Make the model exfiltrate data, click, pay, navigate to its site, or ask the user for a fill |
| A page (phishing) | Look like another site | Trigger a fill of another origin's credential |
| Hooks and mods | Hooks receive `tool_input` and `tool_response`; mods see events the host forwards (no browser API today) | Anything a tool result contains |
| The transcript, history, export, Dreaming, remote page | Store and search every tool result; `history_read` reads them; the remote page shows them (images withheld) | Anything a tool result contains |
| Another local process or a disk copy | Read `userData` | The password store, cookies |
| Another session | A background session's browser calls are refused | To use the foreground user's logins |

**Mitigations, by layer** (each phase names which it adds):
- *Store*: passwords encrypted with `safeStorage` (Keychain-backed), never written in plain text, never logged.
- *Fill*: only on a user gesture in the pane, only for the exact origin saved, performed by the main process, invisible to the model.
- *Tool results*: a redaction pass over every `browser_*` result and image before it reaches the model, the transcript, hooks or the remote page: password-field values, known saved secrets, one-time codes.
- *Approval*: per-site cards for agent actions; a "never" list the agent cannot cross; sensitive-site categories that always ask.
- *Isolation*: own session partition; permissions and certificates decided by the user; the agent cannot answer prompts or dialogs.
- *Prompt injection*: page content is data (system prompt already says so); the approval card shows the model's stated reason next to the action so the user sees a mismatch; the agent cannot request a fill at all (Phase 2 default) or only through a card the user confirms (Phase 2 option).

---

## 3. Phase 1: the essentials

Goal: a browser you can trust to sign in with, that the agent cannot abuse by default. Ship as 0.10.

### 3.1 Scope

| Item | Research basis |
|---|---|
| Own persistent partition, Keep cookies, Clear browsing data | §5, §6, rank 2 |
| Tabs | §4, §5, rank 5 |
| Popups as tabs or real child windows (OAuth) | §3 Min/Ferdium, §6, rank 5 |
| Downloads: list, sanitised names, agent gate | §2 Playwright MCP, §4 Claude in Chrome, §5 Codex, rank 7 |
| Permission prompts | §3 Min/Ferdium, §6, rank 3 |
| Certificate errors | §3 Ferdium, §6, rank 3 |
| Find in page, zoom, context menu, print/PDF, DevTools | §3 Min, rank 9 |
| Per-site approval for agent actions, "never" list, sensitive sites | §4 Claude Code pane, §1 Kilo, rank 1 |
| Redaction of password-field values and typed-text echoes | §2, rank 4 (the Phase 2 store extends it) |

### 3.2 Design

**Main process.** `src/main/browser.ts` splits into a folder `src/main/browser/`:

- `controller.ts`: `BrowserController` becomes the owner of **tabs**. Each tab is `{ id, view: WebContentsView, title, url, favicon, loading, muted }`; one is active and attached to `win.contentView`, the others are detached but alive (`removeChildView`/`addChildView` on switch; cheaper than toggling bounds). `state()` returns `{ tabs: TabState[], activeId }`. Every existing tool method takes an optional `tabId` and defaults to the active tab. New: `newTab(url?)`, `closeTab(id)`, `activate(id)`, `listTabs()`.
- `session.ts`: `browserSession()` returns `session.fromPartition('persist:browser')`. Set once: user agent (today's rule), `setPermissionRequestHandler`, `setPermissionCheckHandler`, `on('will-download')`, `setSpellCheckerEnabled(true)`. "Keep cookies" is a config field `browser.keepCookies` (default **on** **[decision 1]**); when off, `clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] })` runs at quit. "Clear browsing data" is the same call on demand plus `clearCache()` and `clearAuthCache()`. Migration: the first run after the change tells the user once, in a notice in the pane, that sign-ins start fresh because the browser now has its own profile.
- `popups.ts`: `setWindowOpenHandler` per tab. `disposition` `foreground-tab`/`background-tab` or a plain `_blank` with no `features` → `newTab(url)` and `deny`. Otherwise (a sized popup, the OAuth case) → `{ action: 'allow', createWindow }`, where `createWindow` makes a `WebContentsView` in the **same partition**, shown as a floating child over the pane (centred, 480×640 default or the requested size, with its own small title bar: title, URL host, close) so `window.opener` and `postMessage` keep working; when the popup closes or navigates to `about:blank`, it is removed. Popups that fail a size/count sanity check (more than 3 open, or opened without a user gesture: `webContents` `window-open` gives `referrer` and the handler runs after the gesture check Chromium applies) are denied and noted in the tab's bar ("A popup was blocked. Show"). Min does the same split [source](https://raw.githubusercontent.com/minbrowser/min/master/main/viewManager.js).
- `downloads.ts`: `will-download` → `item.setSavePath(unique(path.join(downloadsDir, sanitize(item.getFilename()))))` where `downloadsDir` is `~/Downloads` **[decision 4]**; sanitise like Playwright MCP ("Do not trust web names"): strip path separators and control characters, cap length, add a counter on collision. State per download `{ id, filename, url, host, received, total, state, path }` is pushed to the renderer (`browser:downloads`). Agent-initiated downloads (a click within 2 s of a `browser_click`/`browser_press_key`, tracked by a timestamp on the controller) need the per-site approval of 3.2 "Approvals" with the download named; user-initiated ones just start. The list offers Show in Finder, Open, Cancel, Clear.
- `permissions.ts`: policy table + store `userData/browser/permissions.json` `{ [origin]: { [permission]: 'allow' | 'deny' } }`. Request handler: `fullscreen`, `clipboard-sanitized-write`, `pointerLock` → allow; `geolocation` → deny (no Google API key, as Min notes); `media`, `notifications`, `clipboard-read`, `display-capture`, `idle-detection`, `midi`, `openExternal` → look up the origin, otherwise show the **permission card** in the pane and store the answer if the user ticks "Remember". Everything else → deny. Requests from a tab that is not active are deferred until it is (Wexond dropped them; deferring is kinder). The agent cannot answer: the IPC that resolves a card carries a nonce the renderer got from main, and the tool layer has no path to it. `setDevicePermissionHandler` → deny (no USB/HID/serial).
- `certificates.ts`: `app.on('certificate-error')` for `webContents` that belong to the browser session: `preventDefault()`, show an **interstitial** page from our own scheme (`silo-browser://cert-error?host=…&code=…`) in the tab with the host, the error code in plain words and a grey "Go back" (primary) and a "Proceed anyway (unsafe)" (text button) that remembers the host and fingerprint for this app run only; `callback(true)` only for a remembered pair; everything else `callback(false)`. The agent's `browser_navigate` result says "The certificate for host is not valid (code). Only the user can proceed." and no tool can proceed. Ferdium's self-signed folder is the closest precedent; Wexond's accept-everything is the anti-pattern.
- `find.ts`, `zoom.ts`: `findInPage` with `found-in-page` → `{ matches, activeMatchOrdinal }` to the renderer; `stopFindInPage('clearSelection')` on close. Zoom: `setZoomLevel` per origin, stored in `userData/browser/zoom.json`, shown as a chip in the URL pill when not 100 %; ⌘+ / ⌘− / ⌘0 when the pane has focus (the View menu roles are left as they are **[verify]** that they do not double-apply).
- `context-menu.ts`: `context-menu` event → a native `Menu` with Back / Forward / Reload, Copy / Paste / Select all (editable), Copy link, Open link in new tab, Save image as…, Search DuckDuckGo for "…", Inspect element (`inspectElement(x, y)`), Print… (`print()`), Save as PDF… (`printToPDF` → save dialog).
- `approvals.ts` (agent side): see below.
- `redact.ts`: pure functions, unit-testable. `redactOutline(text, secrets)`, `redactValues(result, pageSecrets)`. Phase 1 adds, inside every in-page script, collection of the values of `input[type=password]`, `input[autocomplete="one-time-code"]`, `input[autocomplete^="cc-"]`, and the outline shows `"•••"` for those fields; `browser_eval`'s wrapper gathers the same values in the page and replaces any occurrence in the stringified result with `[redacted]`; `browser_type`'s echo becomes `Typed 12 characters into textbox 'Password'` when the target is one of those fields (and Phase 1 already **refuses** to type into a password field: see "Never" below). `browser_screenshot` is refused while a non-empty password or one-time-code field is in the viewport, with the message "The page shows a credential field with content; ask the user to finish signing in." (Operator's takeover rule).

**Approvals (agent actions).** A new `ctx.approve` call inside the browser tools, through the existing approval card and scopes, keyed on the site:

- *What counts as an action*: `browser_navigate` to a new site, `browser_click`, `browser_type`, `browser_press_key`, `browser_eval`, and the agent's tab/download operations. Reading (`read_page`, `find`, `get_text`, `wait_for`, `scroll`, `screenshot`) is free once the site is approved for the session or always.
- *Site*: the registrable domain plus subdomain, i.e. `accounts.example.com` and `www.example.com` are separate, as Claude Code does ("Each site needs its own approval, including subdomains").
- *Scopes*: **Allow once**, **Allow this session**, **Always allow** (saved in `userData/browser/sites.json`), **Deny**. Settings → Browser lists Always-allowed sites with Remove.
- *Exempt*: `localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`, `file:` and `artifact:` pages; a user-provided list.
- *Modes*: Ask mode asks; Auto mode asks only for the "sensitive" list and the first visit to a new site **[decision 3]** (now: in Auto mode the safety check decides those, a new site and page script included, and asks the user when unsure; purchases and accounts always ask the user; the other modes ask); Bypass asks for nothing but the "never" list still holds; Plan mode allows reading tools only (today's `readOnly` flag: `browser_navigate`, `read_page`, `find`, `get_text`, `wait_for`, `scroll`, `screenshot` become `readOnly: true`).
- *Cross-origin navigation*: a click that lands on another site triggers the check again before the next action, closing the redirect hole Cursor's docs admit to and Kilo's gate covers.
- *Sensitive sites*: a built-in list of categories by hostname pattern (banks and brokers, payment processors, webmail, identity providers: `accounts.google.com`, `login.microsoftonline.com`, `appleid.apple.com`, `github.com/login`, …) that always ask, in every mode except Bypass, and show an amber note on the card ("This looks like a sign-in or financial site"). The user can add and remove entries in Settings → Browser.
- *Never list* (no card, the tool returns a refusal the model can act on): typing into a password or one-time-code field ("Ask the user to sign in in the pane"), answering a permission card, proceeding past a certificate error, submitting a form whose action URL is on a payment processor pattern **[decision 3]**, downloading an executable type (`.dmg`, `.pkg`, `.app`, `.sh`, `.command`) without the user's explicit "Allow once".
- *Card text*: `browser_click` shows `Click "Sign in" on accounts.example.com`; `browser_type` shows the field and the text (truncated; never for credential fields); `browser_eval` shows the code; the model's `reason` (we add an optional `reason` parameter to every acting tool and ask for it in the system prompt) is shown under it in grey, so an injected instruction stands out.

**IPC and preload.** `oc.browser` gains `tabs()`, `newTab(url?)`, `closeTab(id)`, `activate(id)`, `onTabs(cb)`, `find(text, {forward, matchCase})`, `stopFind()`, `onFound(cb)`, `zoom(delta | 'reset')`, `downloads()`, `onDownloads(cb)`, `downloadAction(id, 'open' | 'show' | 'cancel' | 'clear')`, `answerPermission(nonce, allow, remember)`, `certProceed(nonce)`, `clearBrowsingData()`. Channel names `browser:tabs`, `browser:tab-new`, …, `browser:permission-request` (main → renderer), `browser:permission-answer` (renderer → main, with nonce). `BrowserState` becomes `{ tabs, activeId }` plus the active tab's fields for compatibility with `applyBrowserState`.

**Agent tools.** New: `browser_tabs` (`action: list | new | select | close`, `url?`, `tab_id?`), `browser_download_list` (names, sizes, paths; the model never gets file contents through it). Changed: every acting tool gets `reason?: string` and goes through the approval; `browser_type` refuses credential fields; `browser_screenshot` refuses with a filled credential field in view; `browser_eval` is redacted. System prompt line: "Never type a password or a code into a page; ask the user to sign in in the pane. Each site needs the user's approval before you act on it; say why in `reason`."

**Data on disk.** `userData/Partitions/browser/` (Electron's own, cookies and storage), `userData/browser/permissions.json`, `userData/browser/sites.json`, `userData/browser/zoom.json`, `userData/browser/downloads.json` (the list, without contents).

### 3.3 UI, in the app's style

White and grey, no colour except blue where it carries meaning (a focused control, a link) and amber for attention. Type from the existing scale: `--fs-ui`/`--lh-ui` 14/20 for tabs, bars and buttons; `--fs-small` 13/18 for the URL field and notes; `--fs-micro` 12/16 for chips and counts. Radii `--r-control` and `--r-card`. All of it in `src/renderer/side-pane.ts` (or its part of `renderer.ts` on `next`) and `styles.css`.

- **Tab strip**: a 32 px row under the pane tabs (Browser · Diff · Terminal): favicon 16 px, title in `--fs-ui` ellipsised, a × on hover, a + at the end; the active tab has `--bg-000` and a hairline on three sides, others `--bg-200`; overflow scrolls horizontally with the wheel, no arrows. ⌘T is taken (terminal tab), so ⌘⇧N opens a browser tab when the pane has focus **[decision 2]**; ⌘W closes the active browser tab when the pane has focus. A middle click closes.
- **URL pill**: as today, plus a zoom chip (`120%`) at the right that resets on click, and a lock/plain icon at the left: a grey lock for valid HTTPS, "Not secure" in `--fs-micro` grey text for HTTP, an amber triangle for a proceeded-anyway certificate.
- **Permission card**: a 44 px bar that slides down under the URL bar, `--bg-100` with a hairline: "example.com wants to use your camera and microphone" in `--fs-ui`, a "Remember for this site" checkbox in `--fs-small`, then **Block** (grey, primary position) and **Allow** (ghost). Same component for notifications and clipboard. Nothing in the page is covered; the bar is part of the pane chrome, not the WebContentsView, so it never appears in `browser_screenshot`.
- **Approval card**: the existing one in the transcript with the new texts and the amber note for sensitive sites.
- **Certificate interstitial**: a full-tab page in `--bg-100`: an outlined triangle, "This connection is not private" in `--fs-head`, the host and the code's meaning in `--fs-body`, **Go back** (primary) and "Proceed anyway (unsafe)" as a text link in `--text-400`.
- **Find bar**: a 36 px bar at the top right inside the pane, 320 px wide, with the field, "3 of 12" in `--fs-micro`, ↑ ↓ and ×; Enter next, ⇧Enter previous, Esc closes; matches use Chromium's own highlighting. ⌘F while the browser view has focus opens it (the composer's ⌘F still searches sessions).
- **Downloads**: a tray button in the browser bar (down-arrow icon with a progress ring while something downloads and a dot when a download finished since it was last opened) opening a popover list: filename, host, size or progress bar, Show in Finder / Open / Cancel; "Clear" at the bottom.
- **Popup window**: a floating card above the pane, `--bg-000`, 1 px border, 12 px radius, a 32 px title bar with favicon, title and the host in grey, a × at the right; draggable by the title bar; sized as requested, clamped to the pane.
- **Blocked popup note**: a one-line strip under the URL bar, "A popup was blocked · Show", that fades after the next navigation.
- **Settings → Browser** (a new settings section): Keep cookies after quitting (switch), Clear browsing data (button with a confirm), Downloads folder (path with Change), Sites the agent may always act on (list with Remove), Sites that always ask (editable list), Permissions (per-site list with Reset), Zoom resets (button), Open links from the chat in the pane (switch, as Claude Code offers).
- **Context menu**: native.

### 3.4 Tests

Headless (`npm test`, node, no Electron), new files under `test/`:
- `browser-redact.js`: outline lines with password, one-time-code and card fields show `•••`; `redactValues` removes every occurrence of the given values from strings, arrays and nested JSON; the typed-text echo for a credential field has no text.
- `browser-approvals.js`: site keys (`a.example.com` ≠ `example.com`), exempt hosts, the sensitive list, the never list (password field, executable download), scopes once/session/always, cross-origin re-check, plan mode read-only set.
- `browser-downloads.js`: `sanitize` strips `../`, separators, control characters, caps length; `unique` adds counters.
- `browser-permissions.js`: policy table (auto-allow, deny, ask), store round trip, deferral for inactive tabs.
- `browser-popups.js`: the disposition rules (tab vs popup vs deny) as a pure function over `{ url, disposition, features, referrer, gesture, openCount }`.
- `runtime.js` gains checks that `browser_click` asks in Ask mode, is refused in a background session (existing), and is allowed on localhost without a card.

Live (`test/live/`, through `rig.js`):
- Add to the rig `app.browserTarget(tabIndex)`: find the CDP target whose URL is the tab's and attach a second socket, so a test can `evaluate` inside the page. Add `test/support/site.js`: a local HTTP server serving fixtures (`login.html` with a password field, `popup.html` with a `window.open` + `postMessage` flow, `download.html`, `permissions.html` that calls `getUserMedia`, `redirect.html` to a second port that stands in for another site), plus an HTTPS variant with a fixture self-signed certificate in `test/live/fixtures/`.
- `browser-tabs.js`: new tab, switch, close, state events, the agent's `browser_tabs` (mock model).
- `browser-oauth.js`: the popup flow completes and the opener receives the message; a popup becomes a tab when it is a plain link.
- `browser-permissions.js`: `getUserMedia` shows the card; Block resolves the promise with `NotAllowedError`; Remember persists across relaunch (`kill`/`relaunch`); an agent tool cannot answer (there is no tool; the check is that the nonce path is renderer-only).
- `browser-cert.js`: the HTTPS fixture shows the interstitial; the agent's navigate result says so; Proceed works once per run.
- `browser-downloads.js`: a user click downloads to the fixture folder with a sanitised name; the agent's click asks first (mock model emits the click; the card appears).
- `browser-approvals.js`: mock-model run on the fixture site: the first `browser_click` shows the card with the reason; Allow this session suppresses the next; the redirect fixture asks again; `browser_type` into the password field returns the refusal and the password store of the transcript file contains no such value.
- `browser-redaction.js`: type a password into the fixture by hand (CDP into the page), run `browser_read_page`, `browser_find`, `browser_get_text`, `browser_eval('document.querySelector("input[type=password]").value')`, then grep the session JSON, the rig's hook log (a PostToolUse hook writing `tool_response` to a file), the history search, the export and the remote page's transcript JSON for the value: zero hits. `browser_screenshot` is refused while the field is filled.
- `browser-find-zoom.js`: find counts and navigation; zoom persists per origin across relaunch.
- The existing `look-*` pictures gain the tab strip, the permission bar, the find bar, the downloads popover and the interstitial, light and dark.

### 3.5 Risks and open questions

- Moving to `persist:browser` logs everyone out once. Alternative: keep the default session and accept the sharing. Recommendation: move now, before Phase 2 stores anything **[decision 1]**.
- Detached `WebContentsView`s keep rendering and consuming memory; cap tabs (12?) and throttle background ones (`backgroundThrottling` is already on). **[verify]** memory per idle tab on a real build.
- Popup-as-floating-card: `createWindow` must return a `WebContents`; Min's implementation is the reference. Sites that expect the popup to be a top-level window (`window.outerWidth`, `screenX`) may misbehave **[verify]** with Google, Microsoft and GitHub OAuth.
- Google sign-in: our stripped UA may or may not pass. Options if it fails: (a) Ferdium's version-stripped UA on `accounts.google.com`, which Google's policy forbids; (b) "Sign in with your default browser, then import cookies for this site" like Cowork; (c) do nothing and document it. **[decision 5]**
- Approval fatigue: the cards must stay short; "Allow this session" is the escape hatch. If users turn Ask mode off because of the browser, we have lost. Watch the live `regression.js` timings.
- `browser_eval` is the hardest tool to make safe; redaction catches values the page holds in inputs, not tokens in `localStorage`. Option: require the site approval scope "always" for `browser_eval`, or drop it from the default tool set behind a setting **[decision 10]**.
- The sensitive-site list is ours to maintain; Anthropic's list is not public. Keep it short and editable.

---

## 4. Phase 2: a password manager

Goal: people save and fill passwords in the pane the way they would in Chrome, with the macOS Keychain behind the encryption, and the agent cannot get at them. Ship as 0.11; the items are in priority order and each can ship alone.

### 4.1 Item 1: the store and the fill

**Store.** `src/main/browser/passwords/store.ts`. One file `userData/browser/passwords.bin`: the JSON `{ version: 1, entries: Entry[] }` encrypted as a whole with `safeStorage.encryptStringAsync` (the async API; the sync one is removed in Electron 46) and re-encrypted when `decryptStringAsync` returns `shouldReEncrypt`. `Entry = { id, origin, username, password, note?, created, updated, lastUsed, neverSaveHere? }`. `origin` is the exact origin the credential was saved on (`https://accounts.example.com`), plus a derived `site` (registrable domain) for the Settings list. Writes are atomic (temp file + rename), with one `.bak`. If `isAsyncEncryptionAvailable()` is false, the feature shows "Passwords need the Keychain, which is not available" and stays off; no plain-text fallback, ever (Min skips this check; we do not). The decrypted entries live in main-process memory only while the app runs; the renderer gets `{ id, origin, username }` lists and never a password, except the reveal flow below. Nothing about the store is reachable from `ToolContext`.

**Match.** `match(entries, pageOrigin)`: exact origin first; then same registrable domain **and** same scheme **[decision 6]** (Chrome fills `www.` ↔ apex; it does not fill `http` with an `https` credential); never across registrable domains; never in a cross-origin iframe (the fill script runs in the main frame only, and the field's frame must be the main frame); never on a page with a proceeded-past certificate error.

**Fill trigger.** A preload for the browser partition (`src/preload-browser.ts`, `contextIsolation: true`, no Node) that: detects login forms (`input[type=password]` plus the nearest preceding text/email input, or `autocomplete=username`), draws a 16 px key icon inside the username and password fields (an absolutely positioned element with a reserved `data-oc-*` attribute and a shadow root so page CSS cannot restyle it), and on **click** sends `browser:password-fill-request` with a one-time nonce the preload got from main at page load. ⌘⇧L (when the view has focus) sends the same. Nothing fills on load or focus. Main checks the nonce, the tab is active, the window is focused, and the gesture was within 2 s (the preload includes `performance.now()` of the click and main compares with the request time); then looks up matches. One match → main sets the values by `webContents.insertText` into the focused field after focusing each field through a trusted `sendInputEvent` click at the field's rect (so the page's `input` events fire as with real typing; `executeJavaScript` assignment is the fallback for frameworks that need `value` setters). Several → the renderer shows a **picker** in the pane chrome (not in the page, so it never appears in a screenshot) listing usernames; the chosen id goes back with the nonce. The agent's tools cannot send `browser:password-fill-request`: the channel is handled only for the browser preload's `sender`.

**Reveal and export.** Settings → Passwords lists `site · username · ••••••••`; "Reveal" and "Copy password" call `systemPreferences.promptTouchID('reveal the password for example.com')` when `canPromptTouchID()` is true; the decrypted value goes to the renderer for 30 s or to the clipboard (cleared after 60 s). Export (CSV, Chrome's column layout) asks Touch ID and then a save dialog. On Macs without Touch ID, Electron has no API to verify the login password **[decision 7]**: options are (a) an app passphrase set in Settings → Passwords, hashed with scrypt and required for reveal/export/import; (b) no reveal without Touch ID, only fill; (c) a tiny native helper (`security`/LocalAuthentication via a Swift tool in `bin/`) that prompts for the login password. Recommendation: (a) now, (c) later. Touch ID here is a gate, not a key: the data is protected by the Keychain-held safeStorage key, and the gate stops someone at an unlocked Mac. Binding the Keychain item to `kSecAccessControlUserPresence` would need native code; noted as later work.

**UI.** Key icon: a 16 px grey outline key, `currentColor` at `--text-400`, 8 px from the field's right edge; hover `--text-100`. Picker: a 240 px popover under the URL bar, rows in `--fs-ui` with username and the origin in `--fs-micro` grey, arrow keys and Enter. Settings → Passwords: a searchable list (site favicon, site, username, dots), a row expands to Reveal / Copy / Edit / Delete, buttons Import… / Export… / "Sites never saved" at the top; the Touch ID prompt is the system's.

### 4.2 Item 2: never readable by the agent, mods, hooks, transcript or history

This is a set of properties, each with a test, building on Phase 1's redaction:

| Property | How |
|---|---|
| No tool returns a saved password | `redact.ts` gains `knownSecrets()`: the set of all saved passwords (and, Phase 3, card numbers), applied to every `browser_*` result string with `scrubSecrets`-style replacement (`providers.ts` already does this for API keys) → `[redacted]`. Applied in `execTool` for every tool, not only browser ones, so a `bash cat` of an exported CSV is scrubbed too. |
| No field value reaches the model | Phase 1's in-page collection of credential-field values, now also `input[autocomplete=username]` on pages where a fill happened in the last 60 s (so the agent cannot read back which account was used; the username is visible after login anyway, so this is **[decision 6]**: default off). |
| No screenshot while a credential is on screen | Phase 1's refusal, plus: `browser_screenshot` is refused for 5 s after a fill. |
| The agent cannot fill, request a fill, or see that a fill happened | No tool exists; `browser_type` refuses credential fields; the fill is not a tool event, so no `tool_end`, no hook, no transcript line. **Option [decision 8]**: a `browser_request_signin` tool that only shows a card "The agent asks you to sign in to example.com. Fill with alice@…?" with Fill / Dismiss; the fill is still the user's click. The model gets back "The user was asked" and nothing else. |
| Mods | Mods have no browser API today; keep it so. The mods protocol's events never carry tool results for `browser_*`; if a future mod API exposes the pane, it exposes only `{ url, title }`. |
| Hooks | `tool_response` and `tool_input` pass through the same scrub before `fireHook`. A `PreToolUse` `updatedInput` that contains a known secret is rejected. |
| Transcript, history, export, Dreaming, remote | Results are scrubbed before `store.append`; the history search indexes the scrubbed text; `history_read` reads the scrubbed store; the export is of the scrubbed store; the remote page already withholds images. Dreaming's prompt already forbids copying secrets; it only ever sees scrubbed text. |
| The renderer never holds passwords | Only the reveal flow sends one, for 30 s, into a single element with `user-select` on and no logging; the renderer's `console-message` relay never prints it because it never logs it. |
| Disk | `passwords.bin` only; `chmod 600`; never in a crash dump (Electron's crash reporter is off in this app). The `.bak` is encrypted too. |
| Logs | `console.warn` calls in the store log ids and origins, never usernames or values. |

### 4.3 Item 3: save and update prompts, import, Settings

**Capture.** The browser preload watches form submits (`submit` event, clicks on `button[type=submit]`/`input[type=submit]`, and a patched `HTMLFormElement.prototype.submit`, as Min does) and, on navigation after a submit where a password field had a value, sends `{ origin, username, passwordLength, nonce }` to main together with the value through the same gesture-nonce channel. Main holds it in memory and the renderer shows the **save bar** under the URL bar: "Save password for example.com? alice@… ••••••••" with **Save** (primary), **Not now**, **Never for this site**. If an entry exists for the origin and username with a different password: "Update password for alice@…?" with **Update** / **Not now**. The bar disappears after 30 s or on the next navigation. The pending value is dropped with it. Never shown on `localhost`/`*.test` by default (dev credentials are noise; a Settings switch flips it).

**Import.** CSV in Chrome's layout (`name,url,username,password,note`), Safari/Passwords-app exports (`Title,URL,Username,Password,Notes,OTPAuth`), 1Password and Bitwarden CSVs (header sniffing); the parser is a small hand-written one (`test/` fixtures for quoting and BOMs). Import asks Touch ID (or the passphrase), shows a preview with counts (new, updated, skipped), then merges. Direct Chrome import (its `Login Data` SQLite plus the "Chrome Safe Storage" Keychain key, which macOS asks the user to allow) is feasible with `node:sqlite` but invasive; Safari's store is not readable; so **CSV first [decision 9]**, Chrome direct as a later option. The Phase 1 "Clear browsing data" leaves passwords alone; Settings → Passwords has its own "Delete all passwords" with Touch ID.

**Settings → Passwords** as described in 4.1, plus switches: "Offer to save passwords" (default on), "Also on localhost" (off), and the "Sites never saved" list.

### 4.4 Item 4: existing managers

**Bitwarden and 1Password through their CLIs**, read-only, as providers behind the same key icon, following Min's code, which is the only shipped implementation found: `bw` (`login --apikey` with client id/secret the user pastes once into a Keychain-stored field, `unlock`, `sync`, `list items --url <origin> --session`), and `op` (`signin --raw`, `item list --categories login`, `item get`; version ≥ 2.2 checked at setup). The provider is chosen in Settings → Passwords ("Built-in", "Bitwarden (bw)", "1Password (op)"); unlock is asked in a pane card when a lookup needs it; the session token lives in main-process memory for the CLI's own timeout. The CLI's stdout is parsed and discarded; nothing of it reaches any tool. Save prompts are built-in only (as in Min). 1Password's CLI "n" to app integration means no Touch ID through the desktop app; its own biometric unlock requires the signed-browser trust that we do not have.

**Extensions**: not in this phase. electron-chrome-extensions could load the Bitwarden MV3 extension and even speak native messaging, but no report shows a password-manager extension working under it, 1Password refuses unsigned browsers for app integration, and the extension UI would have to be rendered by us. Revisit if the CLI route disappoints.

### 4.5 Item 5: passkeys

Electron 45 can serve WebAuthn with a Touch ID (Secure Enclave) authenticator through `app.configureWebAuthn({ touchID: { keychainAccessGroup: '<TEAM_ID>.dev.siloharness.app', promptReason: 'sign in to $1' } })`, with the `select-webauthn-account` session event for the account picker. Requirements: the access group in the `keychain-access-groups` entitlement and therefore a **Developer ID signature** (our build is ad-hoc, `scripts/adhoc-sign.js`, `-c.mac.identity=null`); credentials are device-bound (no iCloud sync) and sites see a platform authenticator. iCloud Keychain passkeys (`platformPasskeys: true`) only work for domains the app owner controls (associated domains + AASA), so they are not for a general browser. Plan: once the app is signed **[decision 11]**, call `configureWebAuthn` at startup, render the account picker as a pane card, and document that passkeys made here live on this Mac. Until then, show "Passkeys need a signed build" in Settings → Passwords and nothing else.

### 4.6 Tests

Headless:
- `passwords-store.js`: round trip with a fake cipher injected (`{ encrypt, decrypt }`), `shouldReEncrypt` rewrite, atomic write and `.bak`, refusal when encryption is unavailable, `chmod 600`.
- `passwords-match.js`: exact origin, same-site rules, scheme rule, never across registrable domains, cert-error exclusion.
- `passwords-csv.js`: Chrome, Safari, 1Password, Bitwarden fixtures; quoting; BOM; merge counts.
- `browser-redact.js` gains `knownSecrets` scrubbing across tool results of every tool, hook payloads, `updatedInput` rejection.
- `passwords-gesture.js`: nonce issue/consume, the 2 s window, inactive-tab refusal, a second use of a nonce refused.

Live:
- `passwords-fill.js`: on the fixture login page, click the key icon via the page target → the fields are filled (checked from inside the page), the form submits; the picker appears with two saved accounts; nothing fills on load.
- `passwords-save.js`: submit a new login → the save bar; Save → entry present (through the Settings page); submit with a changed password → Update bar; Never → no bar next time; relaunch keeps the store.
- `passwords-agent.js` (the security test, mock model scripted to try everything): with a saved password for the fixture origin, the model calls `browser_read_page`, `browser_find`, `browser_get_text`, `browser_eval` on `.value`, `document.cookie`, `browser_type` into the password field, `browser_screenshot` after the user's fill, `bash cat` of an exported CSV, `history_read`, and a PostToolUse hook logs every `tool_response`: assert the password string appears in none of: tool results, the session JSON, the hook log, the history search, the export, the remote transcript, the renderer console. Assert `browser_type` and `browser_screenshot` returned the refusals.
- `passwords-reveal.js`: cannot drive Touch ID; with `SILO_HARNESS_LIVE_TEST` the gate is the passphrase path, so the test sets a passphrase and checks reveal and export; a manual checklist covers Touch ID.
- `passwords-cli.js`: a fake `bw` and `op` on `PATH` (shell scripts in `test/live/fixtures/`) returning canned JSON; lookups through the key icon fill; no CLI output in any tool result.
- Pictures: key icon, picker, save bar, Settings → Passwords, light and dark.

### 4.7 Risks and open questions

- **Code signing.** safeStorage's Keychain item is tied to the signature; an ad-hoc-signed app may prompt "Silo Harness wants to use your confidential information" on each rebuild, and a changed signature can make the stored key unreadable, which would make `passwords.bin` undecryptable. Mitigation: keep an export reminder, and move to a Developer ID signature (also needed for passkeys and 1Password trust) **[decision 11]**. **[verify]** the Keychain behaviour of the current ad-hoc build across two builds.
- **Fill fidelity.** Frameworks that need real key events versus `value` setters; two-step logins (username page, then password page); fields inside shadow DOM; iframes (we refuse). Expect a list of known-good sites and fixes over time.
- **Phishing**: the match is by exact origin or same registrable domain; the picker shows the origin; no fill on cert-error pages. IDN look-alikes are shown punycode in the picker.
- **A compromised renderer** (an XSS in the app's own page) could send `browser:password-fill-request` if the channel were open to it; the sender check limits it to the browser preload's frame. The reveal flow is the exception and is gated by Touch ID or the passphrase.
- **The model asking the user to sign in** is itself an injection vector ("to continue, sign in to this page"); the picker shows the origin so a look-alike stands out, and the sensitive-site card already asks on identity providers. The optional `browser_request_signin` tool makes the ask visible and auditable; without it the model asks in prose.
- **Dreaming and history tools** see scrubbed text, but a page that displays a secret in plain text (a recovery code page) is not covered by the known-secrets scrub; the screenshot refusal does not fire on text. Document it; consider a "sensitive page" button the user can press to blind the agent to the current tab.

---

## 5. Phase 3: the rest

Each item ships alone; order by the research's ranking.

1. **Addresses and cards (autofill).** Same store file, `kind: 'address' | 'card'`; the card number and CVC encrypted like passwords and added to `knownSecrets`; fill through the key icon on forms with `autocomplete` address/`cc-*` fields, mapping by `autocomplete` tokens and name/label heuristics; CVC never stored (Chrome's rule). Settings → Payment and addresses. Tests mirror 4.6. **[decision 12]** whether cards are wanted at all; the agent cannot buy (never list), so this is for the user's own checkouts.
2. **Tracker and ad blocking.** `@ghostery/adblocker-electron` (the maintained successor of what Wexond used) on the browser session with EasyList + EasyPrivacy, lists cached in `userData/browser/adblock/` and refreshed weekly; a shield chip in the URL pill with a count and a per-site off switch; default on **[decision 13]**; Settings → Browser → Blocking. Test: a fixture page loading a known tracker host is blocked; the per-site switch unblocks.
3. **Cookie import from the user's browser, per site**, as Cowork does (Chrome: `Cookies` SQLite + the Chrome Safe Storage key via the Keychain prompt; Firefox: `cookies.sqlite`; Safari: not readable). A picker that leaves banking, email and SSO unchecked by default. This is also the honest answer to Google sign-in if the UA route fails **[decision 5]**.
4. **Reader mode and page-to-Markdown for the agent**: `browser_get_text` already prefers `main`; add Readability-style extraction and a reader view for the user (Min has one).
5. **DevTools for the agent**: console messages (`console-message` buffered per tab, a `browser_console` tool) and network summaries (`webRequest` listeners, `browser_network` with URL, status, type, no bodies), as Playwright MCP, Chrome DevTools MCP, Cursor and Claude in Chrome offer. Bodies never, so cookies and tokens in responses stay out of the model.
6. **Element picker** (⌘⇧S in Claude Code, "Send element" in Windsurf): the user clicks an element in the pane and its outline line and a cropped screenshot go into the composer as an attachment.
7. **Dev-server preview**: a `browser_preview` that reads `.claude/launch.json`-style config (we could read Claude Code's own file), starts the command in a terminal tab and opens the port in a browser tab.
8. **Viewport emulation** (`browser_resize` / `enableDeviceEmulation`) for responsive checks, and a "mobile" preset.
9. **Extensions** via electron-chrome-extensions, only if a concrete need appears; the web store installer is out of scope.
10. **Sync** of passwords across Macs: not planned; export/import covers it. iCloud Keychain sync of custom items needs native code and entitlements.

---

## 6. Decisions for the user

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Own partition and "Keep cookies" default | Move to `persist:browser` now (one-time logout) vs keep the default session; keep cookies on vs off by default | Move now; on by default (Claude Code: the user's choice; Cowork: on) |
| 2 | Tabs: shortcut and cap | ⌘⇧N for a new browser tab (⌘T is the terminal's) vs rebinding ⌘T by focus; cap at 12 vs none | ⌘⇧N; cap 12 with a notice |
| 3 | Approval policy in Auto mode and the "never" list | Auto asks only for sensitive sites and first visits vs asks for every new site; payments in the never list vs only the sensitive list | First visit + sensitive; payments in the never list (Claude Code: "won't purchase items") |
| 4 | Downloads folder and agent downloads | `~/Downloads` vs the project folder vs `userData`; agent downloads need Allow once vs allowed on approved sites | `~/Downloads`; Allow once per download (Claude in Chrome asks every time) |
| 5 | Google sign-in if our UA is refused | Ferdium-style UA tweak on `accounts.google.com` (against Google's policy) vs cookie import from the user's browser (Phase 3.3) vs document the limit | Cookie import; no UA lie |
| 6 | Match and redaction strictness | Fill on same registrable domain + same scheme vs exact origin only; hide usernames from the agent after a fill vs not | Same site + same scheme; usernames visible (they are on the page anyway) |
| 7 | Reveal/export gate without Touch ID | App passphrase vs fill-only vs native helper for the login password | Passphrase now, native helper later |
| 8 | May the agent *ask* for a fill? | No tool at all vs `browser_request_signin` that only shows a card | Ship without; add the tool in a point release if the prose asks get in the way |
| 9 | Import sources | CSV only vs CSV + direct Chrome import | CSV first |
| 10 | `browser_eval` | Keep with redaction vs require the "always" site scope vs off by default | Keep with redaction, but require per-call approval in Ask mode even on approved sites (it is the one tool that reads anything) |
| 11 | Code signing with a Developer ID | Needed for passkeys, stable safeStorage across builds, and 1Password trust; costs the developer programme fee and a notarisation step in `scripts/` | Do it before Phase 2 ships |
| 12 | Cards in Phase 3 | Addresses only vs addresses and cards | Addresses first; cards if asked |
| 13 | Blocking default | On vs off | On, with the per-site switch |

---

## 7. Testing approach shared by every phase

- **Pure modules first.** Everything that can be a function of plain data (`redact.ts`, `approvals.ts`, `permissions.ts` policy, `downloads.ts` naming, `popups.ts` rules, `passwords/match.ts`, `passwords/csv.ts`, `passwords/store.ts` with an injected cipher) lives in `src/main/browser/` without an Electron import, so `node test/run.js` covers it in milliseconds.
- **The rig grows two helpers**: `app.browserTarget(i)` to attach to a browser tab's CDP target, and `test/support/site.js` for fixture pages over HTTP and HTTPS. The mock model (`test/support/mock-model.js`) scripts the agent's tool calls, so the security tests do not need the API; the live API variant (`ANTHROPIC_API_KEY`) runs `regression.js`-style checks that the model actually asks the user to sign in instead of typing.
- **The security property is a grep.** For every phase the live test that matters most plants a known secret, drives every path (tools, hooks, history, export, remote, console) and asserts zero occurrences. It runs in `test/live/run.js` by default.
- **Pictures.** Every new piece of chrome gets a light and a dark capture in the `look-*` scripts, at the measured type sizes, so the reviewer sees it before it ships.
- **Manual checklist** (in `docs/browser/checklist.md`, written with Phase 1): Google, Microsoft, GitHub and Apple sign-in through the popup and redirect flows; a bank's login page shows the sensitive card; Touch ID reveal; a passkey registration and login on webauthn.io once signed.
