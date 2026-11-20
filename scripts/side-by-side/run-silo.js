#!/usr/bin/env node
// Runs one task in Silo Harness through the hidden-window live rig (test/live/rig.js) and writes the run's files and
// summary.json:
//   node scripts/side-by-side/run-silo.js <taskId> <outDir> [--model id] [--sandbox on|off] [--mock]
// Needs a build first (npm run build). The model is the real API when ANTHROPIC_API_KEY is set (or
// SILO_HARNESS_LIVE_ANT=1), as for the live tests; --mock forces the mock model, scripted for one tool call and a
// closing line, to test the plumbing with no real call. The app runs in Auto mode with a throwaway profile (removed
// at the end) on a fresh copy of the template at <outDir>/<taskId>/<runner>/project, runner `silo` or, with the shell
// sandbox on, `silo-sandbox`. Saved next to it: transcript.json, history.jsonl (the session's history log),
// timing.jsonl (its runs from the timing log), report.txt (what /report shows), final.txt, run.json, app-log.txt,
// verify.json and summary.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('./lib/common.js');

const ROOT = path.join(__dirname, '..', '..');
const TIMEOUT_MS = 10 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readLines = (file) => {
  const out = [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn line */
    }
  }
  return out;
};

/** The mock model's script: one bash call that runs the tests, then a closing line. */
function scriptMock(app) {
  const st = app.mock.state;
  // Auto mode's safety check passes everything
  st.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  st.replies.push({ content: 'Running the tests first.', toolCalls: [{ id: 'call_sbs_1', name: 'bash', args: { command: 'node --test' } }] });
  st.replies.push({ content: 'Ran the tests with `node --test`. This is the mock model, so nothing was fixed.' });
}

/**
 * The summary's numbers from the copied logs. `origin` is when the message was sent (epoch ms); the history log's
 * times are epoch ms of the same clock.
 */
function parseLogs(history, timingRuns, transcript, origin) {
  const steps = [];
  const starts = new Map();
  const usage = [];
  const checkRecs = [];
  const runStarts = [];
  for (const r of history) {
    const d = r.data || {};
    if (r.type === 'run.start') runStarts.push(r);
    else if (r.type === 'usage') usage.push(r);
    else if (r.type === 'check') checkRecs.push(d);
    else if (r.type === 'tool.start') {
      const step = { type: 'tool', name: d.name, kind: c.kindOf(d.name), atMs: r.t - origin, ms: null, ok: null };
      const args = d.args && typeof d.args === 'object' ? d.args : (() => {
        try {
          return JSON.parse(d.args);
        } catch {
          return {};
        }
      })();
      if (step.kind === 'shell' && args.command) step.cmd = c.short(args.command);
      if (step.kind === 'edit' && (args.path || args.file_path)) step.file = String(args.path || args.file_path);
      if (d.mcp) step.mcp = true;
      steps.push(step);
      starts.set(d.id, step);
    } else if (r.type === 'tool.end' && starts.has(d.id)) {
      const step = starts.get(d.id);
      step.ok = d.ok !== false;
      if (typeof d.durationMs === 'number') step.ms = d.durationMs;
    }
  }

  // Model calls: the timing log's turns (when the request went out, how long it took), else the usage records (when
  // each call ended; no duration)
  const turns = [];
  for (const run of timingRuns) for (const t of run.turns || []) if (t.requestAt !== undefined) turns.push({ ...t, abs: run.at + t.requestAt });
  if (turns.length) {
    for (const t of turns) steps.push({ type: 'model', name: '', kind: 'model', atMs: Math.round(t.abs - origin), ms: t.endMs ?? null, ...(t.calls ? { toolCalls: t.calls } : {}) });
  } else {
    for (const u of usage) steps.push({ type: 'model', name: '', kind: 'model', atMs: u.t - origin, ms: null, endOnly: true });
  }
  steps.sort((a, b) => a.atMs - b.atMs || (a.type === 'model' ? -1 : 1));

  // Tokens: the usage records (the agent's own calls); prompt tokens there include cache reads and writes, so `in`
  // is what is left of them, as Claude Code's input_tokens
  const tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const src = usage.length ? usage.map((u) => u.data || {}) : turns.map((t) => ({ promptTokens: t.promptTokens, completionTokens: t.completionTokens, cacheReadTokens: t.cacheReadTokens, cacheWriteTokens: t.cacheWriteTokens }));
  for (const u of src) {
    const read = u.cacheReadTokens || 0;
    const write = u.cacheWriteTokens || 0;
    tokens.in += Math.max(0, (u.promptTokens || 0) - read - write);
    tokens.out += u.completionTokens || 0;
    tokens.cacheRead += read;
    tokens.cacheWrite += write;
  }
  tokens.promptTotal = tokens.in + tokens.cacheRead + tokens.cacheWrite;

  const verdicts = {};
  for (const ch of checkRecs) verdicts[ch.verdict] = (verdicts[ch.verdict] || 0) + 1;
  const sum = (k) => timingRuns.reduce((a, r) => a + ((r.summary && r.summary[k]) || 0), 0);
  const autoBlocked = (transcript || []).filter((i) => i.role === 'auto_blocked').length;
  const checks = {
    checksRun: checkRecs.length,
    checksMs: checkRecs.reduce((a, ch) => a + (ch.ms || 0), 0),
    verdicts,
    blocks: verdicts.block || 0,
    autoBlocked,
    sandboxed: sum('sandboxed'),
    sandboxBlocked: sum('sandboxBlocked'),
    sandboxReruns: sum('sandboxReruns'),
  };

  const runEnds = history.filter((r) => r.type === 'run.end').map((r) => r.data && r.data.reason);
  return {
    steps,
    modelCalls: turns.length || usage.length,
    tokens,
    checks,
    log: {
      source: 'silo history + timing',
      historyRecords: history.length,
      timingRuns: timingRuns.length,
      runs: runStarts.length,
      runEnd: runEnds.join(',') || null,
      logWallMs: timingRuns.length ? sum('wallMs') : null,
      modelMs: timingRuns.length ? sum('modelMs') : null,
      toolsMs: timingRuns.length ? sum('toolsMs') : null,
      checksMs: timingRuns.length ? sum('checksMs') : null,
      otherMs: timingRuns.length ? sum('otherMs') : null,
      retries: timingRuns.length ? sum('retries') : null,
      usageRecords: usage.length,
      stepTimesFrom: 'the message being sent',
    },
  };
}

/** The last assistant message of the turn: the transcript's last assistant item after the last user message. */
function finalMessage(transcript) {
  let out = '';
  for (const i of transcript || []) {
    if (i.role === 'user') out = '';
    else if (i.role === 'assistant' && typeof i.text === 'string' && i.text.trim()) out = i.text;
  }
  return out;
}

async function main() {
  const a = c.parseArgs(process.argv.slice(2), ['mock']);
  const [taskId, outDir] = a._;
  if (!taskId || !outDir) {
    console.error('Usage: node scripts/side-by-side/run-silo.js <taskId> <outDir> [--model id] [--sandbox on|off] [--mock]');
    process.exit(2);
  }
  const sandbox = (a.sandbox || 'off') === 'on';
  if (a.sandbox && !['on', 'off'].includes(a.sandbox)) throw new Error('--sandbox takes on or off');
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'index.js'))) throw new Error('Build first: npm run build');
  const rig = require(path.join(ROOT, 'test', 'live', 'rig.js'));
  const mock = Boolean(a.mock);
  if (!mock && !rig.liveSource()) throw new Error('No model: set ANTHROPIC_API_KEY (or SILO_HARNESS_LIVE_ANT=1) for a real run, or pass --mock');

  const task = c.loadTask(taskId);
  const runner = sandbox ? 'silo-sandbox' : 'silo';
  const { runDir, project } = c.prepareRun(task, outDir, runner);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-silo-profile-'));
  const home = path.join(profile, 'home-config');
  fs.mkdirSync(home, { recursive: true });
  if (sandbox) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ sandbox: { enabled: true } }, null, 2));

  console.log(`${runner}: ${task.id} with ${mock ? 'the mock model' : a.model || rig.LIVE_MODEL} in ${project}`);
  const app = await rig.launch({ mode: 'auto', profile, ownsProfile: true, project, model: a.model, mock, config: { timingLog: true } });
  const model = app.live ? a.model || rig.LIVE_MODEL : 'mock-model';
  const run = { runner, task: task.id, model, mock: !app.live, sandbox, prompt: task.prompt };
  try {
    if (app.mock) scriptMock(app);
    const sessionId = await app.evaluate(`oc.sessions.current().then((m) => m.id)`);
    const busy = `(() => { const s = document.querySelector('#status-line'); return Boolean(s && !s.hidden) || Boolean(document.querySelector('.session-item.running')); })()`;
    run.sentAt = Date.now();
    await app.send(task.prompt);
    await app.waitFor(busy, 15_000, 'the run to start').catch(() => undefined);
    try {
      await app.waitFor(`!(${busy})`, TIMEOUT_MS, 'the run to end');
      run.timedOut = false;
    } catch (err) {
      run.timedOut = true;
      run.error = err.message;
    }
    run.idleAt = Date.now();
    run.wallMs = run.idleAt - run.sentAt;
    run.sessionId = sessionId;
    if (run.timedOut) await app.evaluate(`oc.rpc('sessions.stop', ${JSON.stringify(sessionId)})`).catch(() => undefined);

    // The history log is written as things happen; the timing line at the run's end, off its path: wait for it
    const historyFile = path.join(profile, 'history', `${sessionId}.jsonl`);
    const timingFile = path.join(profile, 'timing', 'timing.jsonl');
    let history = [];
    let timingRuns = [];
    for (const until = Date.now() + 8000; ; ) {
      history = readLines(historyFile);
      const ids = new Set(history.filter((r) => r.type === 'run.start' && r.data && r.data.timing).map((r) => r.data.timing));
      timingRuns = readLines(timingFile).filter((r) => r && r.v === 1 && ids.has(r.run));
      if ((ids.size && timingRuns.length >= ids.size) || Date.now() > until) break;
      await sleep(200);
    }
    if (fs.existsSync(historyFile)) fs.copyFileSync(historyFile, path.join(runDir, 'history.jsonl'));
    fs.writeFileSync(path.join(runDir, 'timing.jsonl'), timingRuns.map((r) => JSON.stringify(r)).join('\n') + (timingRuns.length ? '\n' : ''));
    const transcript = await app.evaluate(`oc.rpc('sessions.transcript', ${JSON.stringify(sessionId)})`);
    fs.writeFileSync(path.join(runDir, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
    const final = finalMessage(transcript);
    fs.writeFileSync(path.join(runDir, 'final.txt'), final);

    // /report's numbers, as scripts/session-report.js prints them
    const dist = (p) => require(path.join(ROOT, 'dist', 'main', p));
    dist('agent/perf.js').setBuiltInToolNames(dist('tools/index.js').builtInToolNames());
    fs.writeFileSync(path.join(runDir, 'report.txt'), dist('history/report.js').sessionReport(dist('history/log.js').parseLog(fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf8') : '')) + '\n');

    // The session's cost as the app works it out (null when a call has no known price, as with the mock model)
    let costUsd = null;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(profile, 'sessions', `${sessionId}.json`), 'utf8'));
      const cfg = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
      const s = dist('cost.js').summarize(saved.cost, cfg.prices);
      if (typeof s.usd === 'number') costUsd = s.usd;
      run.costSummary = s;
    } catch (err) {
      run.costError = err.message;
    }

    fs.writeFileSync(path.join(runDir, 'app-log.txt'), [...app.logs, '', '--- renderer console ---', ...app.console].join('\n') + '\n');
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2) + '\n');

    const parsed = parseLogs(history, timingRuns, transcript, run.sentAt);
    for (const s of parsed.steps) if (s.type === 'model') s.name = model;
    for (const s of parsed.steps) if (s.file && s.file.startsWith(project + path.sep)) s.file = s.file.slice(project.length + 1);
    await app.close();

    const finalFile = path.join(runDir, 'final.txt');
    const verify = c.runVerify(task, project, finalFile);
    fs.writeFileSync(path.join(runDir, 'verify.json'), JSON.stringify(verify, null, 2) + '\n');
    const summary = c.writeSummary(runDir, {
      runner,
      task: task.id,
      model,
      wallMs: run.wallMs,
      verify,
      modelCalls: parsed.modelCalls,
      tokens: parsed.tokens,
      costUsd,
      steps: parsed.steps,
      checks: parsed.checks,
      finish: c.finishFields(final, parsed.steps, project),
      log: { ...parsed.log, wallFrom: 'send to idle', timedOut: run.timedOut, mock: run.mock, sandbox },
    });
    console.log(`${verify.ok ? 'PASS' : 'FAIL'} ${runner} ${task.id}: ${summary.modelCalls} model calls, ${summary.tools.total} tool calls, ${summary.wallMs} ms -> ${path.join(runDir, 'summary.json')}`);
  } catch (err) {
    await app.close();
    throw err;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseLogs, finalMessage };
