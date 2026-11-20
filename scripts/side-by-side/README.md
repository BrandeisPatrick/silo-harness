# Side by side

Runs the same small coding task in Claude Code (headless) and in Silo Harness, saves each run's logs and outcome, and
prints them next to each other: did it pass, how long it took, model and tool calls, tokens, safety checks, how it
finished, and its final message. It is how we measure the gap in how the two finish a task and what they log.

Six made-up tasks live in `tasks/<id>/` (`template/`, `prompt.txt`, `task.json`, `verify.js`): four short ones
(`fix-bug`, `add-feature`, `question`, `partly-blocked`) and two long ones (`build-app`, `wide-change`, 25 to 60 tool
calls; their time limit defaults to the 25 minutes in task.json, otherwise 10, and `--timeout <minutes>` sets it). Each run works on a fresh copy of the template, a git repository with
one commit, under the output folder you give. Never point it at a folder inside the repository.

    node scripts/side-by-side/run-claude.js <task> <outDir> [--model id]                    # claude -p, Auto mode
    npm run build && node scripts/side-by-side/run-silo.js <task> <outDir> [--model id] [--sandbox on|off]
    node scripts/side-by-side/compare.js <outDir>                                            # tables, compare.md, compare.json, log-fields.md

`run-silo.js` needs `ANTHROPIC_API_KEY` (or `SILO_HARNESS_LIVE_ANT=1`) for a real model, as the live tests do;
`--mock` runs the mock model instead. `run-claude.js --parse-only <events.jsonl>` rebuilds a summary from a saved
event stream without running `claude`, and `run-silo.js <task> --parse-only <runDir>` rebuilds a Silo run's summary
from its saved logs. A Silo run that shows a question or approval card is ended there (`stoppedOn` in the summary). Both default to `claude-haiku-5-5`. Each run folder holds `summary.json` (the
same shape for every runner), `final.txt`, `verify.json` and the raw logs.
