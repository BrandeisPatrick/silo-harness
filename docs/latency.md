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

## The timing log

Off by default. Turn it on with `SILO_TIMING=1` in the environment or `"timingLog": true` in settings.json. Each run is one JSON line in `timing/timing.jsonl` in the app's data folder; past 2 MB the file moves to `timing.1.jsonl` and a new one starts.

```
node scripts/timing-report.js ~/Library/Application\ Support/Silo\ Harness/timing/timing.jsonl --last 5 --tools
```

A line holds, per run: the provider's type, the model id's last part, the mode, the wall time and how it ended; per model turn: the harness's steps before the request, when the request went out, the first event, the first thinking, text and tool-call delta, the last event, attempts, retry waits, fallbacks, the finish reason and the token counts; per tool call: the built-in tool's name (an MCP tool is `mcp`), the queue, hooks, each permission question (how it was settled and how long it took, a safety check's result and time, your wait on a card), execution, storing, its wall time, its outcome and how many calls ran alongside it. A value the provider did not report is left out, not set to 0.

**Never recorded**: prompts, arguments, commands, paths, URLs, output, session titles, account or profile names, base URLs, keys. A session is a short random id. Recording is always on in memory and costs well under a microsecond per streamed event.
