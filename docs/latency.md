# Latency: where a run's time goes

## /timing

Type `/timing` after a run. The answer stays in the window; the model never sees it.

```
9m 13s · model 7m 35s (27 turns: waiting 1m 10s, thinking 4m 20s, writing 2m 05s) · tools 52s (33 calls) · safety checks 25s · your approvals 12s · other 9s
Slowest turn: #12, 1m 31s (waiting 1m 02s, thinking 20s, writing 9s, 2 retries) · 18k in, 92% cached · 1.2k out
```

The parts add up to the run's wall time (*your answers* shows when the agent asked you a question):

- **model**: from each request going out to its reply being complete. *Waiting* is the time before anything streamed (retries and their backoff included), *thinking* the time spent streaming thinking, *writing* the text and tool calls. A model that thinks without streaming it shows that time as waiting.
- **tools**: from the first call of a reply to the last one's end, calls that ran together counted once, less the safety checks and your approvals inside it.
- **safety checks**: Auto mode's check of an action.
- **your approvals**: an approval card waiting for you.
- **your answers**: an `ask_user` question card waiting for you.
- **other**: the harness itself: the work before each request (pruning, compaction, hooks, building it) and at the start and end of the run.

## /report

Type `/report` for a report of the whole session on screen, read from its history log. Like `/timing` it stays in the window and the model never sees it. It holds numbers and fixed words only, so you can paste it to someone else:

```
Session report · numbers only, no content

Time 7m 17s working in 2 turns, over 17m 17s
- turn 1, your message: 7m 06s
- turn 2, queued message: 11s, stopped

Model calls 4, 5m 26s in all, median 6s
- slowest: call 2 5m 12s, call 4 8s, call 1 4s

Tool calls 5, 2s of their own work (approvals and checks not included)
- bash: 1, 1s
- MCP tools: 1, 0.5s, 1 failed
- ask_user: 1, time under Waiting on you

Waiting on you 1m 05s
- approval cards: 1, 20s
- questions: 1, 45s

Safety checks 1, 3s in all, slowest 3s
- allow 1

Shell sandbox 6 commands, 5 stayed inside
- blocked: 1, 1 run again outside

Retries 1, 1s waiting before them
- why: no data 1
- longest failed attempt: 5m 00s (no data)

Longest stretches with no record
- 5m 00s in turn 1, 8s in: after tool result, before retry
- 45s in turn 1, 5m 43s in: after question card, before your answer

Tokens per model call 4 calls
- input: 12k min, 14k median, 21k max, 60k total, 40% read from cache
- output: 200 min, 600 median, 5.2k max, 6.6k total

Compactions 1
- 150k → 20k tokens, 30s
```

- **Model calls** are timed as the gap before each `usage` record: from the record before it (a retry inside the call aside) to the reply's token count. That includes the harness's work just before the request and any retries.
- **Tool calls** count each tool's own work; the wait for a card or a safety check is left out. A tool that is not built in shows as `MCP tools` or `other tools`, never by its name.
- **Longest stretches with no record** are the five longest gaps between two records inside a turn, with what came before and after in fixed words. A stretch "before retry" is a model call that failed and was tried again; one that ends "now (still running)" is the turn going on.
- **Shell sandbox** appears only when a command ran in it: how many stayed inside, were blocked, and ran again outside after a check or your Allow.
- **Safety checks** and **Retries** come from records that 0.17.0 did not write yet; for a session from 0.17.0 the report says "not recorded" for them, and takes the question time from the `ask_user` call.

In the window the report is a card; outside the app, `node scripts/session-report.js <history .jsonl>` prints the same report as Markdown for one session's log (`history/<session id>.jsonl` in the app's data folder; needs `npm run build`). A last line torn by a crash is skipped.

What the report reads of the log: each record's type, time and sequence number; a tool's own time, whether it failed and the size of its result; token counts; a tool's name only when it is built in; a message's role; a turn's origin and end reason through a fixed list; and the newer records below. It never reads message text, arguments, commands, paths, URLs, titles, or provider and account names.

## While it runs

The status line says what a long step is doing, so it does not look stuck:

- **"Writing a file… 12 KB"** while the model writes a tool call's input, before the call's row appears ("Writing an edit…", "Writing a command…", or "Preparing a tool call…" for other tools). The size is the input so far, shown from 1 KB, and is updated about once a second.
- **"Checking…"** while Auto mode's safety check decides on a call. The call's row says "Checking…" too: the command has not run yet.
- **"No output for 45 s · retries at 5 min"** when nothing has come from the model for 30 s, counting up. After 5 minutes with no data at all the connection is dropped and the request tried again (see Retries in [reference.md](reference.md#retries)). When the provider sends keep-alive data meanwhile (a chunk with no content) the line says "still connected" instead, since that drop is not coming. Anthropic's pings and a gateway's keep-alive comment lines are dropped by the SDKs before the app sees them, so they neither show nor keep the connection from being dropped. The line clears as soon as content comes.

In a narrow chat column (the rail and a pane open) "to interrupt" and then the token count give way, so the line keeps its room. None of this changes what runs, when a request is retried or how long the app waits.

## Calls that run together

When one reply asks for several tool calls, the read-only ones run at the same time: `read_file`, `grep`, `glob`, `list_directory`, `web_fetch`, and `bash` when the command only reads and the guard has nothing to say about it. Every other call runs alone, after everything before it has ended: edits, writes, other commands, the terminal, the browser, sub-sessions, questions, plans, `web_search` and MCP tools.

- A call is judged after its PreToolUse hook, on the arguments it will run with.
- Each call still gets its own permission decision. Cards and Auto mode's checks come one at a time; a call waiting for one does not hold up the reads beside it.
- Results go back to the model in the order the model asked for them.
- Stop ends every running call; calls that never ran are answered as interrupted.

`toolConcurrency` in settings.json sets how many run at once (1 to 10, default 4); `1` runs every call one after another.

## The timing log

On by default; `"timingLog": false` in settings.json turns it off, and `SILO_TIMING=1` in the environment turns it on whatever the setting says. Each run is one JSON line in `timing/timing.jsonl` in the app's data folder, written when the run ends; past 2 MB the file moves to `timing.1.jsonl` and a new one starts. A run takes about 1 KB per model call with its tools.

The line's `run` is a random id; the session's history log keeps the same id in that run's `run.start` record (`timing`), which is how a timing line is tied to its session without a session id in the timing log.

```
node scripts/timing-report.js ~/Library/Application\ Support/Silo\ Harness/timing/timing.jsonl --last 5 --tools
```

A line holds, per run: the provider's type, the model id's last part, the mode, the wall time and how it ended; per model turn: the harness's steps before the request, when the request went out, the first event, the first thinking, text and tool-call delta, the last event, the longest silence between two content events (`maxGapMs`), attempts, each failed attempt with how long it ran and why (`failedAttempts`: `idle`, `connection`, `rate_limited`, `busy`, `too_long` or `other`), retry waits, fallbacks, the finish reason and the token counts; per tool call: the built-in tool's name (an MCP tool is `mcp`), the queue, hooks, each permission question (how it was settled and how long it took, a safety check's result and time, your wait on a card; an `ask_user` question is kept the same way, as `question`, so its wait is not tool time), execution, storing, its wall time, its outcome and how many calls ran alongside it; for a command in the shell sandbox, `sandbox`: `inside`, `blocked` or `rerun` (its permission question settles as `sandbox`), and the run's summary gains `sandboxed`, `sandboxBlocked` and `sandboxReruns`. A value the provider did not report is left out, not set to 0.

### The newer history records

Besides the timing log, the history log keeps these records, numbers and fixed words only (a log written by 0.17.0 has none of them):

| Record | Fields |
| --- | --- |
| `run.start` | gains `timing`, the run's id in the timing log |
| `retry` | `attempt` (the try coming, 2 to 6), `waitMs` (the wait before it), `ranMs` (how long the failed one ran), `kind` (`idle`, `connection`, `rate_limited`, `busy`, `too_long`, `other`) |
| `check` | `ms`, `verdict` (`allow`, `block`, `ask`, `error`, `stopped`), `timedOut` |
| `question.request` | `count`, the number of questions on the card |
| `question.resolved` | `outcome`: `answered` or `skipped` |
| `compaction.start` | `reason`: `auto` or `manual`; its end is the `compaction` record |
| `tool.end` | gains `sandbox` for a command in the shell sandbox: `inside`, `blocked` or `rerun` |

**Never recorded**: prompts, arguments, commands, paths, URLs, output, session titles, account or profile names, base URLs, keys. A session is a short random id. Recording is always on in memory and costs well under a microsecond per streamed event.

## The benchmark

`npm run build && node scripts/latency-bench.js [--runs 20]` drives the agent with the mock model and made-up files, no window. Tool and model delays are simulated. Each scenario runs with `toolConcurrency` 1 (before) and 4 (after); wall time of the whole run, median / p95 in ms, 20 runs each (Apple Silicon Mac, 2026-11-10):

| Scenario | Before | After | Holds | After, from the timing record (medians) |
| --- | ---: | ---: | :---: | --- |
| A. three reads (300, 100, 200 ms) | 620 / 633 | 316 / 320 | yes | tools 303 |
| B. local read (100 ms) + remote read (400 ms) | 514 / 518 | 415 / 419 | yes | tools 402 |
| C. read, edit, read (reads 200 ms) | 420 / 425 | 419 / 426 | yes | the edit never overlaps a read |
| D. uncertain command in Auto mode, check takes 300 ms and blocks | 316 / 322 | 314 / 319 | yes | safety checks 304 |
| D2. the same, the check answers nonsense | 317 / 321 | 316 / 319 | yes | blocked (fails closed) |
| E. first event at 400 ms, thinking streamed over 500 ms | 1019 / 1022 | 1016 / 1019 | yes | first event 403, thinking 508 |
| F. Stop 200 ms into three 2 s reads | 205 / 206 | 203 / 205 | yes | every call answered |
| G. provider fails once (503), then answers | 1010 / 1014 | 1009 / 1013 | yes | retry wait 1002 |

"Holds" checks each run: results in call order, the edit alone, the check's block kept, a valid history after Stop, the retry counted. Only A and B change: the other scenarios have nothing that may run together.

