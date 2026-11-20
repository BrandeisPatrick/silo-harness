#!/usr/bin/env node
// Runs one task in Claude Code, headless, and writes the run's files and summary.json:
//   node scripts/side-by-side/run-claude.js <taskId> <outDir> [--model id] [--parse-only <events.jsonl>]
// The project is a fresh copy of the task's template at <outDir>/<taskId>/claude/project (a git repository with one
// commit), and `claude -p` runs in it with Auto mode, no prompts, no customizations, no MCP servers and no saved
// session. Saved next to it: events.jsonl (the stream-json output), stderr.txt, final.txt, run.json (times and exit),
// verify.json and summary.json.
// --parse-only builds the summary from an events file without running claude: in the run folder the file is in when
// that folder has a project/ (a re-parse), else in a new run folder with an untouched copy of the template.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const c = require('./lib/common.js');

const DEFAULT_MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 10 * 60_000;

/** A path relative to the project when it is inside it. */
const relTo = (dir, p) => (dir && p.startsWith(dir + path.sep) ? p.slice(dir.length + 1) : p);

/** Reads a stream-json file into events; lines that do not parse are skipped. */
function readEvents(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn line */
    }
  }
  return out;
}

/**
 * The summary's numbers from Claude Code's event stream. `origin` (epoch ms) is when the run started; without it the
 * first timestamp in the stream stands in.
 */
function parseEvents(events, origin) {
  const ts = (e) => (e.timestamp ? Date.parse(e.timestamp) : NaN);
  const first = events.map(ts).find((t) => !Number.isNaN(t));
  const t0 = origin ?? first ?? 0;
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') || {};
  const result = [...events].reverse().find((e) => e.type === 'result') || null;

  const steps = [];
  const toolSteps = new Map();
  const calls = new Map(); // message id -> { usage }
  let lastText = '';
  let classifierChecks = 0;
  const decisions = {};
  for (const e of events) {
    const sub = Boolean(e.parent_tool_use_id);
    if (e.type === 'assistant' && e.message) {
      const id = e.message.id || `anon-${steps.length}`;
      if (!calls.has(id)) {
        calls.set(id, { usage: e.message.usage, sub });
        steps.push({ type: 'model', name: e.message.model || init.model || '', kind: 'model', atMs: Number.isNaN(ts(e)) ? null : ts(e) - t0, ...(sub ? { sub: true } : {}) });
      } else calls.get(id).usage = e.message.usage || calls.get(id).usage;
      for (const b of e.message.content || []) {
        if (b.type === 'text' && !sub && b.text.trim()) lastText = b.text;
        if (b.type !== 'tool_use') continue;
        const step = { type: 'tool', name: b.name, kind: c.kindOf(b.name), atMs: Number.isNaN(ts(e)) ? null : ts(e) - t0, ms: null, ok: null, ...(sub ? { sub: true } : {}) };
        if (step.kind === 'shell' && b.input && b.input.command) step.cmd = c.short(b.input.command);
        if (step.kind === 'edit' && b.input && (b.input.file_path || b.input.notebook_path)) step.file = relTo(init.cwd, String(b.input.file_path || b.input.notebook_path));
        steps.push(step);
        toolSteps.set(b.id, { step, at: ts(e) });
      }
    } else if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type !== 'tool_result' || !toolSteps.has(b.tool_use_id)) continue;
        const { step, at } = toolSteps.get(b.tool_use_id);
        step.ok = !b.is_error;
        if (!Number.isNaN(ts(e)) && !Number.isNaN(at)) step.ms = ts(e) - at;
      }
      for (const m of e.tool_result_meta || []) {
        const d = m.permission_decision;
        if (!d) continue;
        const key = `${d.decision}/${d.reason_type || d.source || '?'}`;
        decisions[key] = (decisions[key] || 0) + 1;
        if (d.reason_type === 'classifier') classifierChecks++;
      }
    }
  }

  // Tokens: the result's totals when there is one (they include sub-agents), else the sum over distinct messages.
  let tokens;
  if (result && result.usage) {
    const u = result.usage;
    tokens = { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
  } else {
    tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    for (const { usage: u } of calls.values()) {
      if (!u) continue;
      tokens.in += u.input_tokens ?? 0;
      tokens.out += u.output_tokens ?? 0;
      tokens.cacheRead += u.cache_read_input_tokens ?? 0;
      tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
    }
  }
  tokens.promptTotal = tokens.in + tokens.cacheRead + tokens.cacheWrite;

  const denials = result && Array.isArray(result.permission_denials) ? result.permission_denials : [];
  return {
    model: init.model || (result && Object.keys(result.modelUsage || {})[0]) || null,
    final: result && typeof result.result === 'string' ? result.result : lastText,
    steps,
    modelCalls: [...calls.values()].filter((x) => !x.sub).length,
    tokens,
    costUsd: result ? result.total_cost_usd ?? null : null,
    // Claude Code has no separate check record: these are the permission decisions it attached to tool results
    checks: { checksRun: classifierChecks, blocks: denials.length, decisions },
    log: {
      source: 'claude stream-json',
      events: events.length,
      result: result ? result.subtype : null,
      isError: result ? result.is_error : null,
      stopReason: result ? result.stop_reason ?? null : null,
      terminalReason: result ? result.terminal_reason ?? null : null,
      numTurns: result ? result.num_turns ?? null : null,
      logWallMs: result ? result.duration_ms ?? null : null,
      apiMs: result ? result.duration_api_ms ?? null : null,
      ttftMs: result ? result.ttft_ms ?? null : null,
      subAgentSteps: steps.filter((s) => s.sub).length,
      stepTimesFrom: origin ? 'the spawn of claude' : 'the first timestamped event (parse-only)',
      toolsOffered: Array.isArray(init.tools) ? init.tools.length : null,
    },
  };
}

function runClaude(prompt, model, project, runDir) {
  const args = ['-p', prompt, '--model', model, '--permission-mode', 'auto', '--permission-prompts', 'none', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '1'];
  const out = fs.openSync(path.join(runDir, 'events.jsonl'), 'w');
  const err = fs.openSync(path.join(runDir, 'stderr.txt'), 'w');
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', args, { cwd: project, stdio: ['ignore', out, err] });
    } catch (e) {
      resolve({ startedAt, endedAt: Date.now(), exitCode: null, signal: null, timedOut: false, error: e.message });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, TIMEOUT_MS);
    const done = (exitCode, signal, error) => {
      clearTimeout(timer);
      fs.closeSync(out);
      fs.closeSync(err);
      resolve({ startedAt, endedAt: Date.now(), exitCode, signal, timedOut, ...(error ? { error } : {}) });
    };
    child.once('error', (e) => done(null, null, e.message));
    child.once('exit', (code, signal) => done(code, signal));
  });
}

async function main() {
  const a = c.parseArgs(process.argv.slice(2));
  const [taskId, outDir] = a._;
  if (!taskId || (!outDir && !a['parse-only'])) {
    console.error('Usage: node scripts/side-by-side/run-claude.js <taskId> <outDir> [--model id] [--parse-only <events.jsonl>]');
    process.exit(2);
  }
  const task = c.loadTask(taskId);
  let runDir;
  let project;
  let run = null;
  let model = a.model || DEFAULT_MODEL;
  const parseOnly = a['parse-only'] ? path.resolve(a['parse-only']) : null;

  if (parseOnly) {
    const beside = path.dirname(parseOnly);
    if (fs.existsSync(path.join(beside, 'project')) && path.basename(beside) === 'claude' && fs.existsSync(path.join(beside, 'run.json'))) {
      // A re-parse of a real run, in its own folder
      runDir = beside;
      project = path.join(beside, 'project');
      run = JSON.parse(fs.readFileSync(path.join(beside, 'run.json'), 'utf8'));
    } else {
      ({ runDir, project } = c.prepareRun(task, outDir, 'claude'));
      fs.copyFileSync(parseOnly, path.join(runDir, 'events.jsonl'));
      const stderr = path.join(beside, 'claude-stderr.txt');
      if (fs.existsSync(stderr)) fs.copyFileSync(stderr, path.join(runDir, 'stderr.txt'));
    }
  } else {
    ({ runDir, project } = c.prepareRun(task, outDir, 'claude'));
    console.log(`claude: ${task.id} with ${model} in ${project}`);
    run = await runClaude(task.prompt, model, project, runDir);
    run.wallMs = run.endedAt - run.startedAt;
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ ...run, model, prompt: task.prompt }, null, 2) + '\n');
    if (run.error) console.error(`claude did not start: ${run.error}`);
    if (run.timedOut) console.error(`claude ran past ${TIMEOUT_MS / 60_000} minutes and was stopped`);
  }

  const parsed = parseEvents(readEvents(path.join(runDir, 'events.jsonl')), run ? run.startedAt : undefined);
  if (parsed.model) model = parsed.model;
  const finalFile = path.join(runDir, 'final.txt');
  fs.writeFileSync(finalFile, parsed.final || '');
  const verify = c.runVerify(task, project, finalFile);
  fs.writeFileSync(path.join(runDir, 'verify.json'), JSON.stringify(verify, null, 2) + '\n');
  const summary = c.writeSummary(runDir, {
    runner: 'claude',
    task: task.id,
    model,
    wallMs: run ? run.wallMs : parsed.log.logWallMs,
    verify,
    modelCalls: parsed.modelCalls,
    tokens: parsed.tokens,
    costUsd: parsed.costUsd,
    steps: parsed.steps,
    checks: parsed.checks,
    finish: c.finishFields(parsed.final, parsed.steps, project),
    log: { ...parsed.log, wallFrom: run ? 'spawn to exit' : 'result.duration_ms (parse-only)', ...(run ? { exitCode: run.exitCode, timedOut: run.timedOut } : {}), parseOnly: Boolean(parseOnly) },
  });
  console.log(`${verify.ok ? 'PASS' : 'FAIL'} claude ${task.id}: ${summary.modelCalls} model calls, ${summary.tools.total} tool calls, ${summary.wallMs ?? '?'} ms -> ${path.join(runDir, 'summary.json')}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseEvents, readEvents };
