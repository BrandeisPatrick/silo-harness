# What Silo Harness touches on your Mac

The rule: macOS asks you for access only when something you started needs it. The app itself asks for nothing at launch except its own folder in Documents.

## Files

| Where | What |
| --- | --- |
| `~/Documents/Silo` | The default working folder, made at launch. Pick another under Settings → General or in the folder menu. |
| `~/.silo-harness` | Your `settings.json`, instructions, skills and mods. |
| `~/Library/Application Support/Silo Harness` | Settings made in the app, sessions, the trash, terminal logs, artifacts, browser data, saved site answers and MCP sign-ins (`mcp-auth.json`, readable by you only). |
| The system temp folder, `silo-harness/` | Oversized MCP results, removed after a day. |

Sessions read and write in the working folder. Anything outside it follows the permission mode, and secret paths (keys, `.env`, other apps' data) always ask.

## When macOS can ask

| Prompt | What causes it |
| --- | --- |
| Documents | The first launch, for `~/Documents/Silo`. |
| Desktop, Downloads, a removable or network disk | A session or command works with files there. |
| Local network | You point the app at something on your network: a model server, an MCP server, a local page, a SearXNG instance, or remote control from your phone. |
| Camera, microphone, location | A page in the Browser pane asks, and you allow it on the bar first. Or a command run in a session uses them. |
| Notifications | The first time a run finishes or needs approval (Settings → General → Notifications). |
| Control another app | A command run in a session uses AppleScript. |
| Bluetooth | Only a command run in a session. Pages in the Browser pane are refused USB, HID, serial and Bluetooth devices. |

Each prompt says in a sentence why it appeared.

## Never asked

Contacts, Calendars, Reminders, Photos, Accessibility, Screen Recording, Full Disk Access and the keychain. The app has no code that uses them, and no login item, global shortcut or default-app registration.

## Network

| Connection | When |
| --- | --- |
| Your model provider | Every request you send. |
| GitHub, once a day | The update check in the packaged app. Off under Settings → General → Check for updates. |
| Public websites | `web_fetch`, `web_search` and the Browser pane, each behind the site approval. See [web.md](web.md). |
| MCP servers | The ones you add. See [mcp.md](mcp.md). |
| Your phone | Remote control, off until you turn it on. It listens on your network only then. |

There is no telemetry and no account.

## Removing it

- Sessions: Settings → History → Delete all sessions.
- Mods: Settings → Mods → Delete all custom mods.
- MCP sign-ins: Sign out on each server under Settings → MCP servers.
- Everything: quit, then move the two folders above and the app to the Trash.
