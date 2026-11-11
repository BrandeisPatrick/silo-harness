# Latency: where a run's time goes

## /timing

Type `/timing` after a run. The answer stays in the window; the model never sees it.

```
9m 13s · model 7m 35s (27 turns: waiting 1m 10s, thinking 4m 20s, writing 2m 05s) · tools 52s (33 calls) · safety checks 25s · your approvals 12s · other 9s
Slowest turn: #12, 1m 31s (waiting 1m 02s, thinking 20s, writing 9s, 2 retries) · 18k in, 92% cached · 1.2k out
```

The parts add up to the run's wall time:

- **model**: from each request going out to its reply being complete. *Waiting* is the time before anything streamed (retries and their backoff included), *thinking* the time spent streaming thinking, *writing* the text and tool calls. A model that thinks without streaming it shows that time as waiting.
- **tools**: from the first call of a reply to the last one's end, calls that ran together counted once, less the safety checks and your approvals inside it.
- **safety checks**: Auto mode's check of an action.
- **your approvals**: an approval card waiting for you.
- **other**: the harness itself: the work before each request (pruning, compaction, hooks, building it) and at the start and end of the run.

## Calls that run together

When one reply asks for several tool calls, the read-only ones run at the same time: `read_file`, `grep`, `glob`, `list_directory`, `web_fetch`, and `bash` when the command only reads and the guard has nothing to say about it. Every other call runs alone, after everything before it has ended: edits, writes, other commands, the terminal, the browser, sub-sessions, questions, plans, `web_search` and MCP tools.

- A call is judged after its PreToolUse hook, on the arguments it will run with.
- Each call still gets its own permission decision. Cards and Auto mode's checks come one at a time; a call waiting for one does not hold up the reads beside it.
- Results go back to the model in the order the model asked for them.
- Stop ends every running call; calls that never ran are answered as interrupted.

`toolConcurrency` in settings.json sets how many run at once (1 to 10, default 4); `1` runs every call one after another.

## The timing log

Off by default. Turn it on with `SILO_TIMING=1` in the environment or `"timingLog": true` in settings.json. Each run is one JSON line in `timing/timing.jsonl` in the app's data folder; past 2 MB the file moves to `timing.1.jsonl` and a new one starts.

```
node scripts/timing-report.js ~/Library/Application\ Support/Silo\ Harness/timing/timing.jsonl --last 5 --tools
```

A line holds, per run: the provider's type, the model id's last part, the mode, the wall time and how it ended; per model turn: the harness's steps before the request, when the request went out, the first event, the first thinking, text and tool-call delta, the last event, attempts, retry waits, fallbacks, the finish reason and the token counts; per tool call: the built-in tool's name (an MCP tool is `mcp`), the queue, hooks, each permission question (how it was settled and how long it took, a safety check's result and time, your wait on a card), execution, storing, its wall time, its outcome and how many calls ran alongside it. A value the provider did not report is left out, not set to 0.

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

