# Token benchmark

What the harness itself sends to the model, measured on real requests, and what was cut. November 2026, Claude Haiku 5.5. Until
the native path was built, everything went through Anthropic's OpenAI-compatible endpoint (`https://api.anthropic.com/v1`), which
does not cache; [Prompt caching, measured](#prompt-caching-measured) is the native Messages API with caching.

## How it is measured

`scripts/token-bench.js` (documented at its top) starts a local proxy that forwards to the real API and records, per request: the
kind of call (agent turn, Auto mode's safety check, session title, compaction summary), the size of each part of the request
(tool definitions, system prompt, user and assistant history, tool results, images) and the reply's usage. The app runs hidden
through the live rig on a throwaway profile, with its provider pointed at the proxy. The split of a request into parts takes the
provider's `prompt_tokens` as the total: images by their pixel size, the rest shared out by characters (one ratio per request,
2.2 to 2.8 characters per token here). Request headers are never recorded, and the key is replaced in anything written.

- **Tier 1** (the quick check, four fresh sessions in a small fixture project): **Q** "What does this project do?" (bypass), **E**
  an edit plus `npm test` (Auto mode), **B** a local page in the browser, then a screenshot and a follow-up (bypass), **L** six
  turns on one task (Auto mode). Two runs each, to see the noise.
- **Tier 2** (the main target): one Auto-mode session of 19 turns in a copy of this repository at be2ee39 (git archive, about 140K
  lines): how approvals work, a change in `guard.ts` with a plain node test, refinements, a second change in `browser/policy.ts`, a
  lookup across the codebase, git status and diff, the project's website in the browser, a question about something read earlier,
  more reading, a docs edit, and two turns after compaction. Titles on. Context window 180K with the compaction threshold at 0.5,
  so compaction happens at about 90K, under Haiku's 100K price step. The report is per turn, with flags for what cost the most.
- **The path.** By default the app's provider is of type `anthropic` on the proxy, so agent turns and Auto mode's check use the
  native Messages API with the app's own cache marks, and titles and the compaction summary the OpenAI-compatible endpoint, as
  for a user. `--compat` puts everything on the OpenAI-compatible endpoint, as the earlier runs below were.
- **`--native`** (with `--compat`) replays the agent and safety-check requests through the native API afterwards: the
  projection used before the native path existed.

Prices used (Claude Haiku 5.5, USD per million tokens, prompts up to 100K): input 0.10, output 0.50, cache read 0.01, cache write
0.125 for five-minute entries and 0.20 for one-hour entries, from the reply's `usage.cache_creation` split. Above 100K: input
0.50, output 2.50, and the cache prices five times theirs.

```
npm run build
set -a; . /path/to/api.env; set +a
node scripts/token-bench.js --runs 2                   # tier 1, native path
node scripts/token-bench.js --tier 2                   # tier 2, native path
node scripts/token-bench.js --compat --runs 2 --native # the old endpoint, with the replay
```

## What was found

- **Every agent request started with about 11,000 tokens of harness**: tool definitions 8,802 and system prompt 2,209 (measured
  exactly with `max_tokens: 1` requests). In tier 1 that was 89 to 95% of all input.
- **In a working session, old tool output is the cost.** In tier 2, tool results were 61% of the session's 3.66M input tokens. One
  repository-wide `grep` in turn 1 (18.7K tokens) was sent again with 54 requests: 963K tokens, 26% of the whole session. Old
  output was only pruned past 60% of the context window, which a large window (128K by default, 200K or 1M for Claude) reaches
  late or never, so every request carried all earlier output until compaction.
- **The OpenAI-compatible endpoint reports no caching** (no `prompt_tokens_details` at all; identical prefixes seconds apart get
  no discount). The replay projected that caching would cut the cost by 73% (tier 1) and 79% (tier 2). Measured since on the
  native path: 71% and 74 to 76% less than the same build without caching ([below](#prompt-caching-measured)).
- **The prompt prefix was not stable across sessions**: the working directory and date were on the second line, so two sessions
  shared only the first 229 of 6,721 characters. Within a session, tools and prompt were byte-identical except for one change
  when the session got its title (the name line).
- **Auto mode's safety check** sent up to 24 user messages and 40 earlier tool calls with every checked action: its input grew
  from 1.3K to 7.6K tokens per call over tier 2 (25 calls, 115K tokens, 3%).
- Titles are small (100 to 500 tokens, once per session). Compaction happened once in tier 2 (33K in, 2K out).
- Screenshots (when "send screenshots to the model" is on) stayed in every later request until the 60% prune. The rig's hidden
  window cannot capture (`UnknownVizError`), so this was checked in a unit test, not live; a 1440 x 900 screenshot is about 1,600
  tokens per request it rides in.

## What changed, and what each change saved

| Commit | Change | Measured saving |
|---|---|---|
| 25a7e95 | The system prompt puts what differs per project, session and day (working directory, date, mode, instructions files, the session's name) after the fixed instructions. | None on this endpoint, which does not cache. Sessions now share the first 4,325 of 4,597 characters (was 229 of 6,721); in the native replay, tier 1's cache writes fell from 67,370 to 47,723 tokens (-29%, with the smaller prompt below). Providers with automatic prefix caching get the same. |
| edeee56 | The system prompt no longer repeats what the tool descriptions say (terminal, artifacts, browser details, show_image, sub-sessions, schedules, mods). | 2,209 to 1,533 tokens per request (-676, -31% of the prompt). |
| 96e4096 | Tool descriptions drop what their schema or the prompt already says. | 8,802 to 8,515 tokens per request (-287). With the previous: -963 tokens on every agent request (-8.7% of the floor). |
| d281ed6 | The model gets a tool result over 30,000 characters as its start and end (read_file cut after a whole line, with the offset to read on), and only the two newest screenshots. The session keeps everything: the tool rows still show the whole output. | The repository-wide grep went from 18.7K to 12.2K tokens per request that carried it, about 340K tokens over tier 2. Tier 2 with this, the two above and the check below: 3.66M to 3.48M (-5%; the run differs in other ways too). |
| 873e1b8 | Auto mode's check gets the agent's last 15 tool calls (200 characters each) instead of its last 40 (300 each). User messages are unchanged: they are what speaks for the user. | Per call it levels off at about 3.6K tokens instead of growing to 7.6K: 4.6K to 3.0K on average in tier 2 (-35%). |
| 3b894f0 | Past 48K tokens, old tool output (before the last user message, not among the six latest results, over 2,000 characters) is sent as its start and end, as small windows already did at 60%. Kept whole in the session; once set aside it stays so, and `pruneToolResults: false` turns it off. | Tier 2: 3.48M to 2.29M (-34%). Requests stay under about 50K instead of growing to 90K, and the session no longer needs a compaction in 19 turns. |

Tests: `test/context-view.js` (new) covers the cut, the screenshots, the selection and the agent's pruning past the budget; the
unit suites, the typecheck and the live scripts pass (see the report that went with this change).

## Tier 1: before and after (mean of two runs)

| Scenario | Requests before | Input before | Input after | Output before | Output after | Cost before | Cost after |
|---|--:|--:|--:|--:|--:|--:|--:|
| Q | 4.5 | 43,060 | 38,566 | 1,046 | 843 | $0.0048 | $0.0043 |
| E | 6 | 44,235 | 40,666 | 1,077 | 1,280 | $0.0050 | $0.0047 |
| B | 9 | 94,955 | 82,328 | 1,079 | 1,190 | $0.0100 | $0.0088 |
| L | 17 | 174,681 | 162,267 | 2,549 | 2,596 | $0.0187 | $0.0175 |
| **Total** | 36.5 | **356,929** | **323,826** | 5,750 | 5,908 | **$0.0386** | **$0.0353** |

Saving: 33,103 input tokens per run (-9.3%), $0.0033 (-8.5%). Cached tokens: 0 before and after (the endpoint reports none).
Run to run, totals vary by about ±5% (the model takes one request more or less); the first request of each session, the fixed
part plus one short message, went from 11,132 to 10,170 tokens on average and varies by a few tokens.

Baseline split (two runs): tools 68%, system prompt 21%, user 2%, assistant 4%, tool results 5%. Side calls: 10 safety checks and
8 titles, 2% of the input.

## Tier 2: before and after

| | Requests (agent / check / title / compaction) | Input | Output | Cached | Cost |
|---|---|--:|--:|--:|--:|
| Before (be2ee39) | 82 (55 / 25 / 1 / 1) | 3,661,785 | 30,071 | 0 | $0.3812 |
| After the trims, the cut and the check (873e1b8) | 82 (53 / 27 / 1 / 1) | 3,475,334 | 28,070 | 0 | $0.3616 |
| After (3b894f0) | 83 (53 / 29 / 1 / 0) | 2,285,378 | 25,229 | 0 | $0.2412 |

Saving: 1,376,407 input tokens (-37.6%), $0.140 (-36.7%). Both sessions did the work (outcome check: the guard change, the payment
host, both tests passing, the docs line).

Where the input went:

| | Tool definitions | System prompt | History | Tool results | Side calls |
|---|--:|--:|--:|--:|--:|
| Before | 560,944 (15%) | 167,049 (5%) | 547,203 (15%) | 2,238,161 (61%) | 148,428 (4%) |
| After | 524,239 (23%) | 113,900 (5%) | 517,507 (23%) | 1,042,941 (46%) | 86,792 (4%) |

Per turn (all requests of the turn, and the size of its last agent request):

| Turn | Before: requests | Before: input | Before: last request | After: requests | After: input | After: last request |
|--:|--:|--:|--:|--:|--:|--:|
| 1 | 5 | 153,921 | 41,128 | 5 | 132,792 | 33,620 |
| 2 | 3 | 143,786 | 50,459 | 3 | 123,452 | 43,009 |
| 3 | 5 | 283,803 | 56,992 | 4 | 171,051 | 36,113 |
| 4 | 3 | 180,875 | 58,910 | 3 | 116,999 | 37,410 |
| 5 | 3 | 188,834 | 61,130 | 2 | 79,895 | 38,823 |
| 6 | 3 | 187,798 | 63,664 | 2 | 78,900 | 39,853 |
| 7 | 2 | 133,436 | 64,994 | 2 | 84,344 | 41,171 |
| 8 | 5 | 358,320 | 69,582 | 5 | 237,039 | 47,138 |
| 9 | 4 | 296,972 | 72,895 | 3 | 126,159 | 36,859 |
| 10 | 3 | 221,541 | 75,172 | 3 | 113,689 | 39,338 |
| 11 | 1 | 75,439 | 75,439 | 2 | 83,810 | 40,882 |
| 12 | 4 | 336,973 | 81,540 | 4 | 188,717 | 46,691 |
| 13 | 2 | 172,242 | 82,859 | 2 | 99,166 | 48,034 |
| 14 | 2 | 167,750 | 84,524 | 3 | 144,504 | 48,224 |
| 15 | 3 | 273,407 | 88,516 | 3 | 149,150 | 47,271 |
| 16 | 3 | 265,297 | 52,670 (compacted) | 3 | 153,455 | 49,463 |
| 17 | 2 | 113,805 | 53,362 | 2 | 102,689 | 49,458 |
| 18 | 1 | 53,660 | 53,660 | 1 | 49,682 | 49,682 |
| 19 | 1 | 53,926 | 53,926 | 1 | 49,885 | 49,885 |

How the last request of each turn was made up, before (one character is 2,000 tokens: █ tools, ▓ system prompt, ▒ history, ░ tool
results):

```
turn  1  41,128  █████▓░░░░░░░░░░░░░░
turn  4  58,910  █████▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░
turn  8  69,582  █████▓▓▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░
turn 12  81,540  █████▓▓▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░
turn 15  88,516  █████▓▓▒▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
turn 16  52,670  █████▓▓▒▒▒▒▒▒▒▒▒░░░░░░░░░░░   (after the compaction)
turn 19  53,926  █████▓▓▒▒▒▒▒▒▒▒▒░░░░░░░░░░░
```

and after:

```
turn  1  33,620  █████▓░░░░░░░░░░░
turn  4  37,410  █████▓▒▒▒░░░░░░░░░░
turn  8  47,138  █████▓▒▒▒▒▒░░░░░░░░░░░░░
turn 12  46,691  █████▓▒▒▒▒▒▒▒░░░░░░░░░░
turn 15  47,271  █████▓▒▒▒▒▒▒▒▒░░░░░░░░░
turn 19  49,885  █████▓▒▒▒▒▒▒▒▒▒░░░░░░░░░░
```

What cost the most before:

| Tool call | Turn | Size | Requests that carried it | Total input tokens |
|---|--:|--:|--:|--:|
| grep for approval terms across the repository | 1 | 18.7K | 54 | 962,817 |
| read_file src/main/agent/classifier.ts | 2 | 6.4K | 49 | 294,877 |
| read_file src/main/agent/permissions.ts | 1 | 4.1K | 51 | 197,942 |
| a grep for decideApproval and friends in a command | 1 | 2.9K | 52 | 143,627 |

and after, the same grep cost 143,810 tokens over 52 requests: 12.2K for two turns, then its start and end. The price of setting
old output aside showed in turn 11, the question about code read in turn 1: before, the agent answered from the conversation;
after, it looked the function up again with one targeted grep and sed (a 1-2K result and one extra request of about 40K
tokens), and answered correctly. Otherwise files were read again about as often before and after (agent.ts five and seven
times, always in parts with offset and limit; compact.ts two and three times within one turn).

## Prompt caching, measured

The native path (agent turns and Auto mode's check on the Messages API, with cache marks on the tools, the system prompt and the
conversation) and the tool groups sent deferred, measured on fd01575 plus the deferred groups. Tier 1 two runs, tier 2 one run,
on November 10, 2026. Every scenario finished with outcome ok. Raw reports: `report.md` and `results.json` of each run.

### Tier 1 (mean of two runs)

| Scenario | Requests | Input | Uncached | Written (5 min) | Written (1 h) | Read | Read share | Output | Cost |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Q | 5.5 | 25,029 | 84 | 2,721 | 0 | 22,224 | 89% | 1,339 | $0.0012 |
| E | 5 | 16,254 | 449 | 1,792 | 0 | 14,014 | 86% | 602 | $0.0007 |
| B | 8.5 | 58,267 | 116 | 4,386 | 0 | 53,765 | 92% | 1,030 | $0.0016 |
| L | 17.5 | 97,278 | 1,945 | 4,606 | 0 | 90,727 | 93% | 2,440 | $0.0029 |
| **Total** | 36.5 | **196,827** | 2,594 | 13,504 | 0 | **180,730** | **92%** | 5,411 | **$0.0065** |

Against the earlier measurements of the same four scenarios:

| | Input | Cost |
|---|--:|--:|
| Before any cut (be2ee39) | 356,929 | $0.0386 |
| After the cuts, without caching (ddad3b9) | 194,571 | $0.0226 |
| With caching | 196,827 | $0.0065 (-71% against the line above, -83% against the first) |

The input is about the same as without caching: what changed is its price. 92% of it was read from the cache at a tenth of the
input price.

### Tier 2

| | Requests (agent / check / title / compaction) | Input | Uncached | Written (5 min) | Read | Read share | Output | Cost |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| Before any cut (be2ee39) | 82 (55 / 25 / 1 / 1) | 3,661,785 | | | 0 | 0% | 30,071 | $0.3812 |
| After the cuts, without caching (ddad3b9, two runs) | | 2,242,037 and 2,492,289 | | | 0 | 0% | | $0.2364 and $0.2630 |
| With caching | 69 (52 / 16 / 1 / 0) | 3,385,953 | 26,113 | 140,783 | 3,219,057 | 95% | 19,834 | $0.0623 |

The session cost $0.0623, 74% and 76% less than the two runs without caching and 84% less than before any cut. Its input is
larger than without caching: on a provider that caches, old tool output is set aside only once a request reaches 90K tokens, so
requests grew to 89K before the one batch in turn 15 brought them to 55K. Cache reads of that output cost less than the
rewrites that setting it aside earlier would have caused. No compaction happened.

### How it was run

`node scripts/token-bench.js --runs 2` and `node scripts/token-bench.js --tier 2`: the app's provider of type `anthropic` on the
recording proxy, which forwards `/v1/messages` and records the native usage, including `cache_creation`'s split into five-minute
and one-hour writes. Model `claude-haiku-5-5`, thinking off (the native path turns it off where a model allows it).

### Side calls

- **Auto mode's check** (native, its instructions marked for the cache): 16 calls in tier 2, 42,110 tokens in, 16,240 of them
  read from the cache (the 1,015 tokens of instructions each time), $0.0031. What follows the instructions (the user's messages,
  the recent tool calls, the action) changes every call and is paid in full. Tier 1: 4 calls per run, $0.0004 and $0.0005.
- **Titles** stay on the OpenAI-compatible endpoint: one per session, 70 to 122 tokens in, under $0.0001 each.
- **Compaction summary**: none happened in these runs. It stays on the OpenAI-compatible endpoint, so when one happens it is
  paid in full.

### Where the cache is still written

- **At the start of each session**, the new conversation: 166 to 2,782 tokens in a session's first request (the user's message
  and the context note; more when the browser loads from the message). The tools and the system prompt (4,156 tokens, kept an
  hour) were read in every session: they were already cached by runs minutes before. After an hour without use they are written
  once again: 4,156 tokens at 0.20 per million, about $0.0008 (computed from the measured size).
- **New content each step**: every request writes what it adds (the reply, the tool results), five-minute entries.
- **One rebuild in tier 2**, turn 15: old output set aside in one batch (about 38K tokens), and the next request wrote 50,783
  tokens. Before the batch rule, old output was set aside a little more at each new turn past 48K.
- **Loading a group no longer rebuilds**: the browser loaded in turn 10 of tier 2, and one tool list was sent in all 52 agent
  requests. The groups' tools are in every request, deferred, and a load's result references them.

### One run to the next

In tier 1, run 2 of Q made one request more than run 1 (6 against 5): its input was 28,574 against 21,483 (+33%), its cost
$0.0013 against $0.0012 (+14%), because the extra request was nearly all cache reads. The totals of the two runs differed by 11%
in input and 3% in cost ($0.0064 and $0.0066). With caching, a run that takes more steps costs little more.

## Found but not changed

### A native Anthropic path with prompt caching (built since, measured above)

The projection, before it was built: the replay through the Messages API, with breakpoints on the last tool, the system prompt
and the last message:

| | Cost without caching | Cost with caching | Saving |
|---|--:|--:|--:|
| Tier 1, before (two runs) | $0.0768 | $0.0206 | 73% |
| Tier 1, after (two runs) | $0.0703 | $0.0178 | 75% |
| Tier 2, before | $0.3769 | $0.0788 | 79% |
| Tier 2, after | $0.2411 | $0.0770 | 68% |

With caching, nearly the whole prefix of each request is a cache read at a tenth of the price, so the changes above add little on
top: setting old output aside rewrites the middle of the conversation now and then, which costs a cache write each time. On a
native path, raise the 48K budget or turn it off for that provider (cache reads of old output cost less than the writes the
pruning causes); the output cut and the trims still help.

Design, about 300 lines, no new dependency (the bench's `toNative()` is a working prototype of the conversion):
- `src/main/agent/complete.ts`: `completeAnthropic()` next to `completeStreaming()`, picked when the provider is Anthropic's
  native API (a provider type `anthropic`, `x-api-key` and `anthropic-version` headers, base URL without `/v1/chat/completions`).
  It converts the stored OpenAI-shaped history at request time: the system prompt into `system` blocks, a reply's tool calls
  into `tool_use` blocks, consecutive tool results (and a screenshot carrier after them) into one user message of
  `tool_result` blocks, images into base64 `image` blocks; tools into `{ name, description, input_schema }`.
- Breakpoints (at most 4): the last tool; the end of the shared part of the system prompt (after commit 25a7e95 the prompt is
  shared part, then per-project, then per-session: send it as two text blocks and mark the first); the last message (so each
  request reads the previous one's prefix and writes only the new turn).
- Streaming: `message_start` carries `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`;
  `content_block_delta` carries `text_delta` and the tool calls' `input_json_delta`; `message_delta` the output tokens. `Usage`
  gets cache fields, and the context meter counts input plus both cache fields.
- Thinking: Haiku 5.5 thinks by default on the native API (adaptive, effort medium); decide explicitly (effort `low` for most
  turns, or `thinking: { type: "disabled" }`), since thinking tokens are output tokens.
- The safety check's fixed instructions (about 700 tokens, above Haiku's 512-token minimum) can be cached too; titles and the
  summary are one-off and can stay on the OpenAI-compatible path.
- What still breaks the cache: a mode switch (the mode text is in the system prompt), the session's rename (now at the very
  end), a prune event, and the 5-minute lifetime between turns (a user who pauses longer pays one cache write per pause).

### Loading tool groups when they are needed (built since)

Measured exactly, per request: the browser tools 2,305 tokens (12 tools), sub-sessions 1,347 (6), schedules 1,044 (4), terminal
785 (4), mod_check 156; together 5,637 tokens, half of the fixed part, sent with every request whether or not the task needs
them. The twelve core tools take 3,165. Leaving the five groups out until they are needed would save about 5,600 tokens on every
agent request of a session that does not use them: over a third of tier 1's input (Q, E and L use none), and about 200K tokens
(9%) of tier 2 after this change (the browser is needed only from turn 10, and loading it costs one extra request).

It was designed here, then built (see Built, below):
- `Tool.group` (`browser`, `terminal`, `schedules`, `sessions`, `mods`); `Session.toolGroups` lists the loaded ones (copied on fork).
- `toolsFor()` leaves out the tools of groups not loaded and adds `load_tools({ groups })`, whose description lists the groups
  not loaded yet, one line each. Prompt sections that belong to a group (the browser bullet, sub-sessions, schedules, mods) come
  only with it.
- The run loop rebuilds the tool list after a call that loads a group; the prefix changes once per group and session.
- A call to a tool of a group not loaded (an old session, a model that knows the name, the tests' mock model) loads the group and
  runs, so nothing breaks; a user message with an `http(s)` URL loads the browser at once, saving a round trip.
- `load_tools` is internal: no tool row, no approval, left out of the transcript, so the user sees nothing new.
- Cost: one extra request the first time a group is needed (about the size of the request before it).
- Risk: the model has to think of loading a group. Claude Code works this way with its deferred tools; it needs the browser and
  terminal live tests to confirm it with Haiku.

**Built** (560bcf2, then made safe for prompt caching in ddad3b9). As designed, except:
- Cache-safe, for the native path and providers that cache on their own: the tools only grow at the end (the core tools,
  then each group's in the order the session loaded them; nothing unloads or reorders), load_tools' description is the
  same all session long (one line per group, loaded or not), and the system prompt never changes as groups load (it names
  the groups in one line). What a group needs the model to know (the browser's rules, the sub-session guide, the
  schedules and mods sections, the session's name) comes in the load's result, in the conversation; a compaction brief
  repeats it when the load is folded. A load the model did not ask for (a call by name, a message's address) is stored
  as a load_tools call of the agent's own, so it is in the conversation too.
- The up-front rule is narrower than any http(s) address, since a wrong guess costs the browser's 2.3K tokens on every
  later request: an address the message asks to open (`open https://…`) or names with the word browser.
- `toolSet` `auto` no longer drops the optional families under a 32K window (as groups they cost nothing until loaded);
  `all` sends every group up front with the old prompt; `essential` keeps schedules, sub-sessions and mods off.

Measured as above, on e49779d and on ddad3b9 (tier 1 the mean of two runs; no replay):

| Scenario | Input before | Input after | Cost before | Cost after |
|---|--:|--:|--:|--:|
| Q | 43,822 | 17,982 (-59%) | $0.0048 | $0.0022 |
| E | 46,813 | 22,748 (-51%) | $0.0053 | $0.0029 |
| B | 82,710 | 54,400 (-34%) | $0.0088 | $0.0060 |
| L | 153,397 | 99,442 (-35%) | $0.0166 | $0.0115 |
| Tier 1 | 326,742 | 194,571 (-40%) | $0.0356 | $0.0226 (-37%) |
| Tier 2 (W), two runs after | 2,167,572 | 2,242,037 and 2,492,289 | $0.2285 | $0.2364 and $0.2630 |

A session's first request went from about 10,200 tokens (39 tools) to 4,200 (13 tools), and 6,800 with the browser loaded from
the message. The system prompt is now the same in every session but for the folder and date (8 sessions shared 2,293 of 2,405
characters, against 4,325 of 4,532). In tier 2 all 62 agent requests sent one system prompt (two before: the session's title
changed it) and a tool list that grew once, at its end, when the browser loaded. Every scenario finished with outcome ok; B and
W's browser turn ("Open … in the browser") loaded the browser from the message, with no extra request, and read the page. Tier 2
did not get cheaper in these runs: its tool definitions fell from 513K to 297K and 309K tokens (about 4,900 fewer per agent
request), but the agent made 59 and 62 requests instead of 52 and read more (tool results 1.02M against 1.32M and 1.38M); per
agent request its input fell 9% and 6%. One tier 2 run varies that much from the next (an earlier build of the same change
measured 1,988,499, -8%, in 53 requests), so tier 2 needs several runs per side to show a saving of this size. Without the words
open or browser, in a one-off live check, Haiku called load_tools by itself for the terminal and for a web page and then used
them, and the live sub-session test has it load the sessions group.

### Smaller ones

- **The safety check's model.** It runs on the session's model unless `autoMode.model` names another. On Opus 5.5 ($4 per million
  input) each check costs 40 times what it would on Haiku 5.5; a default of the provider's small model would cut it by that.
  Not changed: which model a provider offers is a product decision.
- **The installed-mods list** names all 14 bundled mods, including those that are off (about 150 tokens; since the tool
  groups it is in the mods group's load result, not the system prompt).
- **browser_get_text and browser_read_page** default to 50,000 and 40,000 characters; the 30,000-character cut now bounds them for
  the model.
- **The fixed part is about 4,200 tokens** since the tool groups (10,200 before). After the native path, the next are the core
  tools' descriptions (ask_user and create_artifact take about 750 tokens together) and, once loaded, the browser's.

## What the experiment cost

| Run | Cost |
|---|--:|
| Tier 1 trial (Q only) | $0.004 |
| Tier 1 baseline, two runs, with replay | $0.092 |
| Tier 2 baseline, 80K window (no compaction happened, so the window was raised), with replay | $0.294 |
| Tier 2 baseline, 180K window, with replay | $0.446 |
| Tier 1 after the trims, two runs | $0.076 |
| Tier 2 after the trims, the cut and the check | $0.362 |
| Tier 2 final, with replay | $0.306 |
| Tier 1 final, two runs, with replay | $0.083 |
| Exact token counts of the tool groups and prompt parts | about $0.012 |
| Live test scripts (one pass; not recorded, estimated) | about $0.05 |
| Tool groups: tier 1 (two runs) and tier 2, before, after the first build and after the cache-safe one (tier 2 twice) | $1.097 |
| Tool groups: two live checks of the model loading groups, and the live scripts three times (estimated) | about $0.10 |
| Prompt caching: a tier 1 trial (Q), tier 1 (two runs) and tier 2 | $0.076 |
| Prompt caching: API probes of deferred tools and the live checks (estimated) | about $0.03 |
| **Total** | **about $3.04** |
