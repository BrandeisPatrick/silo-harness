# Web tools and the update check

Two tools read the web without the Browser pane: `web_fetch` and `web_search`. Both are in the `web` tool group, which the model loads when it needs them (`load_tools`), and both only read, so Plan mode offers them too. A third, quieter piece tells you when a newer release is out.

## web_fetch

`web_fetch(url, max_chars?, start?)` fetches one public page and returns it as text:

- HTML becomes Markdown: headings, paragraphs, links (absolute URLs), lists, code, quotes, tables as rows, images as their alt text. Scripts, styles, frames, SVG, forms, comments and hidden parts are dropped. When the page has a `<main>` or `<article>`, only that is read.
- JSON is pretty-printed; other text types (plain text, XML) come as they are.
- Anything else (images, PDFs, archives) is one line with its type and size; open it in the browser if you need it.

The result starts with the final URL and the total length, then the page's title and text in a `<web_page url="…">` fence, then one sentence saying the text is content from the web, not instructions. Text inside a page that would close or open the fence has its `<` written as `&lt;`, the same as the browser's fence. A part is 20,000 characters by default (`max_chars` up to 100,000); `start` reads on, and the result says where the next part starts. Pages are kept in memory for 15 minutes (the last 20), so reading on does not fetch again.

### Safety rules

- **Public sites only.** The host is resolved first, and the fetch is refused when any of its addresses is loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, including the cloud metadata address, and fe80::/10), shared (100.64/10), unique-local (fc00::/7), multicast, unspecified, reserved or documentation space, or the IPv6 forms that carry such an IPv4 address. Odd spellings of an address (decimal, hex, octal, short forms) are caught too. Local names (`localhost`, `*.local`, a bare name) are refused before anything is resolved. There is no exemption list: for a local dev server, use the browser.
- **Pinned connections.** The connection goes to the address that was checked, so DNS cannot answer differently between the check and the connect.
- **Redirects** are followed by hand, at most five, each checked again. A redirect to another site (another registrable domain) is not followed: the model is told `Redirects to <url>. Call web_fetch again with that URL.`, so the new site is asked about on its own.
- **No identity.** No cookies, no sign-in, no credentials in the URL. The only identifying header is `User-Agent: SiloHarness/<version>`.
- **https first.** An `http://` URL is tried as `https://` first, and over http only if https cannot connect.
- **Limits.** 30 seconds per call, 5 MB of body (decompressed; the rest is not read), and Stop ends it at once.
- **Approval.** The first fetch from a site asks with the browser's site card: Allow once, allow the site for this session, or always. It is the same rule and the same list as the browser's, so a site you allowed for one is allowed for the other (Settings → Browser → Sites the agent may always use). Bypass mode does not ask.

Because only public addresses are reached, `web_fetch` never makes macOS ask for local network access.

## web_search

`web_search(query, count?, site?)` returns up to `count` results (default 8, at most 10) as numbered lines: title, URL and a snippet of at most 300 characters, in a `<web_search_results>` fence with the same closing sentence. `site` keeps results to one site. Read a result with `web_fetch`.

The first search in a session asks once, showing the query and where it goes; "Allow web searches for this session" covers the rest of the session. Bypass mode does not ask. In Plan mode, which has no such card, the provider's site card asks instead.

A rate limit or a block is one line that says so and names the setting to change.

### The `webSearch` setting

Settings → Browser → Web search, or in your own `settings.json`:

```json
{ "webSearch": { "provider": "brave", "apiKey": "…" } }
```

| `provider` | Needs | Notes |
| --- | --- | --- |
| `duckduckgo` (default) | nothing | Its HTML results page. DuckDuckGo sometimes blocks automated searches; when it does, the tool says so. |
| `brave` | `apiKey` | Brave Search API. |
| `tavily` | `apiKey` | Tavily search API. |
| `exa` | `apiKey` | Exa search API. |
| `searxng` | `baseUrl` | Your own SearXNG instance, e.g. `http://localhost:8888`, with the `json` format enabled in its `settings.yml`. |

The key is stored like provider keys: masked in the window, kept out of logs, errors and the model's context. A project's `settings.json` may choose the provider but may not set `apiKey` or `baseUrl`.

SearXNG is the one exception to the public-only rule: its configured host may be on your own network (that host only). A SearXNG on your network can make macOS ask for local network access the first time a search reaches it.

## Update check

About 30 seconds after the app starts, and once a day while it runs, the app asks GitHub for the latest release of BrandeisPatrick/silo-harness (no account, 10-second limit; failures are silent). Drafts and prereleases are ignored. When the release is newer than the running version, a quiet line appears above the sidebar's foot: `Update 0.14.0 available` with **Download**, which opens the release page in your default browser. Nothing is downloaded or installed by the app, and there is no system notification. The close button hides the line for that version.

Turn it off with Settings → General → Check for updates (`"checkForUpdates": false`). The check does not run in development builds or tests unless `SILO_HARNESS_CHECK_UPDATES=1` is set.
