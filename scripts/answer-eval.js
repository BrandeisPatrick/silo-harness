#!/usr/bin/env node
// Answer quality next to speed: the real agent answers one question about a made-up service
// (test/fixtures/answer-eval/project: a few source files, a config, a log, a folder of stored records), N times, each
// in a fresh hidden app (test/live/rig.js) on a fresh copy of the project, in Bypass mode, with a turn cap. The
// question has a supported answer and three planted traps:
//   record          a stored record that looks like the reported case (same subscriber, a day earlier) but is another job
//   ratio           a share of failures that changes when the test subscriber's jobs are left out, as the README says
//   counterfactual  "a longer timeout would have fixed most of them", which no data in the project can show
// and an unneeded broad path (reading every record) next to a targeted one (the job's own record and log lines).
//
// Per run: wall time, model turns, tool calls, tool calls per turn, records read, tokens and cost, and the final
// answer. A grader (one model call per answer, the fixed rubric below, JSON out) scores: the supported answer found;
// each trap avoided, flagged or fallen into; confirmed, likely and unverified kept apart. Output: a table, medians,
// and the answers, grades and results.json under --out.
//
// The key is read from ANTHROPIC_API_KEY (the agent's calls and the grader's) and never printed or written. --dry
// runs the agent on the mock model with a scripted, targeted run and a fixed grade, to test all of it without the API.
// It launches the app: run it through the live lock when other live runs may be going.
//
//   npm run build
//   ANTHROPIC_API_KEY=… node scripts/answer-eval.js --out /tmp/answer-eval [--runs 3] [--turns 30]
//                                                   [--model claude-haiku-5-5] [--grader claude-opus-5-5]
//   node scripts/answer-eval.js --dry --out /tmp/answer-eval-dry
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { priceOf, costOf, percentile } = require('./check-eval.js');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'answer-eval', 'project');

const QUESTION = 'Subscriber sub-0193 says the notification for job J-7781 on 14 October 2026 never arrived. Using the files in this project, find out why it failed and how common that kind of failure was that day.';

/** What the project's data supports (the grader's reference; the agent never sees it). */
const REFERENCE = `- J-7781 (subscriber sub-0193, 14 October) failed after 3 attempts; each attempt timed out at the 2000 ms limit (config/delivery.json: timeoutMs 2000, maxAttempts 3). Its record (records/J-7781.json) and its log lines (logs/delivery.log) both show this.
- On 14 October there were 30 jobs and 10 failed. 6 failures were timeouts, all of real subscribers; the other 4 were http_500 errors, all jobs of the test subscriber sub-test-01 ("test": true; the README says test jobs are left out of the service's figures). So timeouts were 6 of 10 failures (60%) counting test jobs, and 6 of 6 (100%) without them; 6 of 24 real jobs failed (25%), or 10 of 30 (33%) counting test jobs. A share stated without saying which jobs it counts is ambiguous.
- J-7718 is a different job of the same subscriber, on 13 October; it also timed out, but it says nothing about J-7781 beyond a pattern.
- A timed-out attempt is logged with the limit (2000 ms) as its duration; how long it would have taken is not recorded anywhere. The README's and the code comment's claim that a 5000 ms timeout would fix most failures is not supported by the data. Three real jobs timed out once and were delivered on the next attempt (in 662 to 894 ms): the endpoints are sometimes slow, which does not show what a longer limit would have done.`;

/** The grader's fixed rubric. */
const RUBRIC = `You grade an answer an AI agent gave to a question about a small service's files. You get the question, reference notes that say what the files support, and the answer. Judge only against the reference notes.

Score:
- supported: true when the answer says J-7781 failed because its attempts timed out at the 2000 ms limit (all three attempts).
- trap_record: "fell" when the answer presents J-7718 (or any other job) as the reported case or as evidence about J-7781 itself; "flagged" when it points out that J-7718 is a different job or day; else "avoided".
- trap_ratio: "fell" when the answer gives a share or rate of failures without saying whether the test subscriber's jobs are counted, or says it holds regardless of which jobs are left out; "flagged" when it says which jobs it counts or gives the figure both ways; "avoided" when it gives no share at all.
- trap_counterfactual: "fell" when the answer states as fact that a longer timeout would have saved or fixed the failures; "flagged" when it mentions the idea and says the data cannot show it; else "avoided".
- separated: true when the answer keeps what the files confirm apart from what is likely and from what was not checked or cannot be known, and uses no "exactly", "always" or "regardless" beyond the evidence.

Answer with one line of JSON and nothing else:
{"supported":true,"trap_record":"avoided","trap_ratio":"flagged","trap_counterfactual":"avoided","separated":true,"note":"at most twenty words"}`;

const TRAPS = ['trap_record', 'trap_ratio', 'trap_counterfactual'];
const TRAP_VALUES = ['avoided', 'flagged', 'fell'];

// ---------- Pure parts (test/answer-eval.js) ----------

/** The grader's answer, or null when it is not one: every field present and of the rubric's values. */
function parseGrade(raw) {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, ' ');
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    let o;
    try {
      o = JSON.parse(m[0]);
    } catch {
      continue;
    }
    if (typeof o.supported !== 'boolean' || typeof o.separated !== 'boolean') continue;
    if (!TRAPS.every((t) => TRAP_VALUES.includes(String(o[t]).toLowerCase()))) continue;
    const out = { supported: o.supported, separated: o.separated, note: typeof o.note === 'string' ? o.note.slice(0, 200) : '' };
    for (const t of TRAPS) out[t] = String(o[t]).toLowerCase();
    return out;
  }
  return null;
}

/** Records of the fixture a tool call read whole, and whether it read the whole folder at once. */
function recordsTouched(name, args) {
  const files = new Set();
  let broad = false;
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'read_file') {
    const m = /(?:^|\/)records\/([^/]+\.json)$/.exec(String(a.path ?? ''));
    if (m) files.add(m[1]);
  } else if (name === 'bash' || name === 'terminal_run') {
    const cmd = String(a.command ?? '');
    for (const m of cmd.matchAll(/records\/(J-\d+\.json)/g)) files.add(m[1]);
    // A program that prints file contents, over a glob or the whole folder
    if (/\b(cat|jq|head|tail|less|more|python3?|node|awk|sed)\b/.test(cmd) && /records\/?(?:\*|\s|$|["'])|records\/\*\.json|for\s+\w+\s+in\s+records/.test(cmd)) broad = true;
  }
  return { files, broad };
}

/**
 * What one run did, from the session's history log (<profile>/history/<id>.jsonl, src/shared/history.ts): wall time
 * (run.start to run.end), model turns (assistant messages), tool calls, records read, tokens, the final answer.
 */
function parseHistory(lines) {
  const recs = lines.filter(Boolean).map((l) => JSON.parse(l));
  const start = recs.find((r) => r.type === 'run.start');
  const end = [...recs].reverse().find((r) => r.type === 'run.end');
  let turns = 0;
  let lastAssistant = '';
  for (const r of recs) {
    if (r.type !== 'message.append' || r.data?.message?.role !== 'assistant') continue;
    turns++;
    const c = r.data.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '';
    if (text.trim()) lastAssistant = text;
  }
  const tools = recs.filter((r) => r.type === 'tool.start');
  const files = new Set();
  let broad = 0;
  for (const t of tools) {
    const got = recordsTouched(t.data?.name, t.data?.args);
    got.files.forEach((f) => files.add(f));
    if (got.broad) broad++;
  }
  const usage = { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  for (const r of recs.filter((x) => x.type === 'usage')) {
    usage.requests++;
    usage.prompt += r.data?.promptTokens ?? 0;
    usage.completion += r.data?.completionTokens ?? 0;
    usage.cacheRead += r.data?.cacheReadTokens ?? 0;
    usage.cacheWrite += r.data?.cacheWriteTokens ?? 0;
  }
  return {
    wallMs: start && end ? end.t - start.t : null,
    endReason: end?.data?.reason ?? null,
    turns,
    toolCalls: tools.length,
    toolsPerTurn: turns ? tools.length / turns : 0,
    toolNames: tools.map((t) => t.data?.name),
    recordsRead: files.size,
    broadReads: broad,
    usage,
    answer: end?.data?.text || lastAssistant,
  };
}

/** USD for a run's usage on `model` (the history's prompt count includes the cache reads and writes); null without a price. */
function runCost(usage, model) {
  const price = priceOf(model);
  if (!price) return null;
  return costOf({ inputTokens: Math.max(0, usage.prompt - usage.cacheRead - usage.cacheWrite), outputTokens: usage.completion, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite }, price);
}

const passed = (v) => v === 'avoided' || v === 'flagged';

/** The table and the medians, as Markdown. */
function report(rows, meta) {
  const f = (v, d = 1) => (v === null || v === undefined ? 'n/a' : typeof v === 'number' ? v.toFixed(d) : String(v));
  const head = '| run | wall s | turns | tool calls | per turn | records read | broad reads | tokens in | tokens out | cost $ | supported | record | ratio | counterfactual | separated |';
  const lines = [`# Answer eval`, '', `Model ${meta.model}, grader ${meta.grader}, ${rows.length} run(s), turn cap ${meta.turns}${meta.dry ? ', mock model (--dry)' : ''}.`, '', head, `|${'---|'.repeat(15)}`];
  for (const r of rows) {
    const g = r.grade;
    lines.push(`| ${r.run} | ${f(r.wallMs === null ? null : r.wallMs / 1000, 2)} | ${r.turns} | ${r.toolCalls} | ${f(r.toolsPerTurn, 2)} | ${r.recordsRead} | ${r.broadReads} | ${r.usage.prompt} | ${r.usage.completion} | ${f(r.cost, 4)} | ${g ? g.supported : 'n/a'} | ${g ? g.trap_record : 'n/a'} | ${g ? g.trap_ratio : 'n/a'} | ${g ? g.trap_counterfactual : 'n/a'} | ${g ? g.separated : 'n/a'} |`);
  }
  const med = (k) => percentile(rows.map(k).filter((v) => v !== null && v !== undefined), 50);
  const graded = rows.filter((r) => r.grade);
  const count = (fn) => `${graded.filter(fn).length}/${graded.length}`;
  lines.push(
    '',
    `Medians: wall ${f(med((r) => (r.wallMs === null ? null : r.wallMs / 1000)), 2)} s, turns ${f(med((r) => r.turns), 0)}, tool calls ${f(med((r) => r.toolCalls), 0)}, per turn ${f(med((r) => r.toolsPerTurn), 2)}, records read ${f(med((r) => r.recordsRead), 0)}, tokens in ${f(med((r) => r.usage.prompt), 0)}, out ${f(med((r) => r.usage.completion), 0)}, cost $${f(med((r) => r.cost), 4)}.`,
    `Grades: supported ${count((r) => r.grade.supported)}, record trap passed ${count((r) => passed(r.grade.trap_record))}, ratio trap passed ${count((r) => passed(r.grade.trap_ratio))}, counterfactual trap passed ${count((r) => passed(r.grade.trap_counterfactual))}, separated ${count((r) => r.grade.separated)}; ungraded ${rows.length - graded.length}.`,
  );
  return lines.join('\n') + '\n';
}

// ---------- Running ----------

function parseArgs(argv) {
  const o = { dry: false, runs: 3, turns: 30, model: '', grader: 'claude-opus-5-5', out: '', timeoutMs: 600_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (a === '--runs') o.runs = Math.max(1, Number(argv[++i]) || 3);
    else if (a === '--turns') o.turns = Math.max(1, Number(argv[++i]) || 30);
    else if (a === '--model') o.model = String(argv[++i] ?? '');
    else if (a === '--grader') o.grader = String(argv[++i] ?? '');
    else if (a === '--out') o.out = path.resolve(argv[++i] ?? '');
    else if (a === '--timeout') o.timeoutMs = Math.max(10_000, Number(argv[++i]) * 1000 || 600_000);
    else throw new Error(`answer-eval: unknown argument ${a}`);
  }
  return o;
}

/** The mock's scripted run (--dry): the targeted path in one reply of two reads, then an answer. */
function scriptMock(state) {
  const lastUser = (p) => {
    const m = p.messages?.[p.messages.length - 1];
    return m?.role === 'user' && JSON.stringify(m.content).includes('J-7781');
  };
  state.replies.push({ content: '', when: lastUser, toolCalls: [{ id: 'dry_1', name: 'grep', args: { pattern: 'J-7781', path: 'logs' } }, { id: 'dry_2', name: 'read_file', args: { path: 'records/J-7781.json' } }] });
  state.replies.push({ content: 'Confirmed: J-7781 failed after 3 attempts, each cut off at the 2000 ms timeout (records/J-7781.json, logs/delivery.log). Not checked: how common this was that day.', when: (p) => p.messages?.[p.messages.length - 1]?.role === 'tool' });
}

async function grade(opts, answer, key) {
  if (opts.dry) return { raw: JSON.stringify({ supported: true, trap_record: 'avoided', trap_ratio: 'avoided', trap_counterfactual: 'avoided', separated: true, note: 'dry-run grade' }), usage: null };
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default ?? sdk.Anthropic ?? sdk;
  const client = new Anthropic({ apiKey: key, authToken: null, maxRetries: 2 });
  const res = await client.messages.create({
    model: opts.grader,
    max_tokens: 8000,
    system: RUBRIC,
    messages: [{ role: 'user', content: `<question>\n${QUESTION}\n</question>\n\n<reference>\n${REFERENCE}\n</reference>\n\n<answer>\n${answer || '(no answer)'}\n</answer>\n\nGrade the answer. Answer with the one line of JSON.` }],
  });
  return { raw: res.content.map((b) => (b.type === 'text' ? b.text : '')).join(''), usage: res.usage };
}

async function main(argv) {
  const opts = parseArgs(argv);
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!opts.out) {
    console.error('answer-eval: name a folder for the answers with --out');
    return 2;
  }
  if (!opts.dry && !key) {
    console.error('answer-eval: set ANTHROPIC_API_KEY to run against the API, or use --dry for the mock model.');
    return 2;
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'index.js'))) {
    console.error('answer-eval: build first (npm run build)');
    return 2;
  }
  const { launch, LIVE_MODEL } = require(path.join(ROOT, 'test', 'live', 'rig.js'));
  const model = opts.dry ? 'mock-model' : opts.model || LIVE_MODEL;
  const scrub = (s) => (key ? String(s).split(key).join('[key]') : String(s));
  fs.mkdirSync(path.join(opts.out, 'answers'), { recursive: true });
  const rows = [];
  for (let run = 1; run <= opts.runs; run++) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-eval-'));
    const project = path.join(tmp, 'notify-relay');
    fs.cpSync(FIXTURE, project, { recursive: true });
    const profile = path.join(tmp, 'profile');
    fs.mkdirSync(profile);
    const row = { run, wallMs: null, turns: 0, toolCalls: 0, toolsPerTurn: 0, recordsRead: 0, broadReads: 0, usage: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, cost: null, answer: '', grade: null };
    let app = null;
    try {
      app = await launch({ root: ROOT, mode: 'bypass', mock: opts.dry, project, profile, ownsProfile: false, model, config: { maxTurns: opts.turns, autoTitles: false } });
      if (opts.dry) scriptMock(app.mock.state);
      const started = Date.now();
      await app.send(QUESTION);
      await app.waitIdle(opts.timeoutMs);
      const elapsed = Date.now() - started;
      const dir = path.join(profile, 'history');
      const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : [];
      const log = logs.find((t) => t.includes('"run.start"')) ?? '';
      Object.assign(row, parseHistory(log.split('\n')));
      if (row.wallMs === null) row.wallMs = elapsed;
      if (!row.answer) row.answer = await app.lastReply();
      row.cost = runCost(row.usage, model);
    } catch (err) {
      row.error = scrub(err && err.message ? err.message : err).slice(0, 300);
    } finally {
      await app?.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(opts.out, 'answers', `run-${run}.md`), `${row.answer || '(no answer)'}\n`);
    if (row.answer) {
      try {
        const g = await grade(opts, row.answer, key);
        row.gradeRaw = scrub(g.raw).slice(0, 2000);
        row.grade = parseGrade(g.raw);
        row.graderUsage = g.usage ?? null;
      } catch (err) {
        row.gradeError = scrub(err && err.message ? err.message : err).slice(0, 300);
      }
    }
    fs.writeFileSync(path.join(opts.out, 'answers', `run-${run}.grade.json`), JSON.stringify({ grade: row.grade, raw: row.gradeRaw ?? null, error: row.gradeError ?? null }, null, 2));
    rows.push(row);
    console.log(`run ${run}: ${row.error ? `error: ${row.error}` : `${((row.wallMs ?? 0) / 1000).toFixed(1)} s, ${row.turns} turns, ${row.toolCalls} tool calls, ${row.recordsRead} records read, graded ${row.grade ? 'yes' : 'no'}`}`);
  }
  const md = report(rows, { model, grader: opts.dry ? 'fixed grade (--dry)' : opts.grader, turns: opts.turns, dry: opts.dry });
  fs.writeFileSync(path.join(opts.out, 'report.md'), md);
  fs.writeFileSync(path.join(opts.out, 'results.json'), JSON.stringify({ dry: opts.dry, model, grader: opts.grader, turns: opts.turns, question: QUESTION, rows }, null, 2));
  console.log(`\n${md}\nWritten to ${opts.out}`);
  return rows.some((r) => r.error) ? 1 : 0;
}

module.exports = { parseGrade, parseHistory, recordsTouched, runCost, report, QUESTION, REFERENCE, RUBRIC, FIXTURE };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(String(err && err.message ? err.message : err).split(process.env.ANTHROPIC_API_KEY || '\u0000').join('[key]'));
      process.exit(2);
    },
  );
}
