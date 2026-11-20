#!/usr/bin/env node
// Reads every summary.json under an output folder and prints, per task, one table with a column per runner, then
// the final messages one after another. Also writes, in that folder:
//   compare.md    the same tables and messages
//   compare.json  the numbers behind them
//   log-fields.md for each log source (Claude Code's event stream, Silo's history log, Silo's timing log) the record
//                 kinds it holds and the field names each carries, names only, no values
//   node scripts/side-by-side/compare.js <outDir>
const fs = require('node:fs');
const path = require('node:path');
const { TASK_IDS, KIND_NAMES } = require('./lib/common.js');

const RUNNER_ORDER = ['claude', 'silo', 'silo-sandbox'];

function findFiles(dir, name, depth = 3, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) out.push(p);
    else if (e.isDirectory() && depth > 0 && e.name !== 'project' && e.name !== '.git' && e.name !== 'node_modules') findFiles(p, name, depth - 1, out);
  }
  return out;
}

const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// ---------- Table rows ----------

const secs = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '-');
const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '-');
const yn = (b) => (b === true ? 'yes' : b === false ? 'no' : '-');
const list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : '-');

/** [label, value(summary)] rows of the per-task table. */
const ROWS = [
  ['outcome', (s) => (s.verify && s.verify.ok ? 'PASS' : 'FAIL')],
  ['hard checks', (s) => checkLine(s.verify && s.verify.hard)],
  ['soft checks', (s) => checkLine(s.verify && s.verify.soft)],
  ['model', (s) => s.model || '-'],
  ['wall time', (s) => secs(s.wallMs)],
  ['wall time in its log', (s) => secs(s.log && s.log.logWallMs)],
  ['model calls', (s) => num(s.modelCalls)],
  ['tool calls', (s) => num(s.tools && s.tools.total)],
  ...KIND_NAMES.map((k) => [`  ${k}`, (s) => num(s.tools && s.tools.byKind[k])]),
  ['tools by name', (s) => Object.entries((s.tools && s.tools.byName) || {}).map(([n, c]) => `${n} ${c}`).join(', ') || '-'],
  ['tokens in (uncached)', (s) => num(s.tokens && s.tokens.in)],
  ['tokens out', (s) => num(s.tokens && s.tokens.out)],
  ['cache read', (s) => num(s.tokens && s.tokens.cacheRead)],
  ['cache write', (s) => num(s.tokens && s.tokens.cacheWrite)],
  ['cost', (s) => (typeof s.costUsd === 'number' ? `$${s.costUsd.toFixed(4)}` : '-')],
  ['safety checks run', (s) => num(s.checks && s.checks.checksRun)],
  ['blocks', (s) => num(s.checks && s.checks.blocks)],
  ['ran sandboxed', (s) => num(s.checks && s.checks.sandboxed)],
  ['sandbox blocks / reruns', (s) => (s.checks && typeof s.checks.sandboxBlocked === 'number' ? `${s.checks.sandboxBlocked} / ${s.checks.sandboxReruns}` : '-')],
  ['ran tests after last edit', (s) => yn(s.finish && s.finish.ranTestsAfterLastEdit)],
  ['ran tests at all', (s) => yn(s.finish && s.finish.ranTestsAtAll)],
  ['final: words / lines', (s) => (s.finish ? `${s.finish.finalWords} / ${s.finish.finalLines}` : '-')],
  ['final: chars', (s) => num(s.finish && s.finish.finalChars)],
  ['final: heading', (s) => yn(s.finish && s.finish.hasHeading)],
  ['final: bullets', (s) => num(s.finish && s.finish.bullets)],
  ['final: code block', (s) => yn(s.finish && s.finish.hasCodeBlock)],
  ['final: ends with a question', (s) => yn(s.finish && s.finish.endsWithQuestion)],
  ['final: mentions tests', (s) => yn(s.finish && s.finish.mentionsTests)],
  ['new files', (s) => list(s.finish && s.finish.newFiles)],
  ['changed files', (s) => list(s.finish && s.finish.changedFiles)],
];

function checkLine(checks) {
  if (!checks) return '-';
  const all = Object.entries(checks);
  const failed = all.filter(([, v]) => !v).map(([k]) => k);
  return `${all.length - failed.length}/${all.length}${failed.length ? ` (no: ${failed.join(', ')})` : ''}`;
}

function textTable(header, rows) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const mdCell = (v) => String(v).replace(/\|/g, '\\|');
function mdTable(header, rows) {
  return [`| ${header.map(mdCell).join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n');
}

// ---------- Log fields ----------

/** Collapsed map keys: model ids under these keys are data, not field names. */
const MAP_KEYS = new Set(['modelUsage', 'model_usage_since_last_result']);
/** Keys that are ids (a tool call's, a message's, a uuid): data, shown as <id>. */
const ID_KEY = /^(?:toolu_|call_|msg_|req_)|^[0-9a-f]{8}-[0-9a-f]{4}-/;

/** Dotted field paths of a value, arrays as [], up to `depth` levels. */
function fieldPaths(v, prefix, depth, out) {
  if (depth < 0 || v === null || typeof v !== 'object') return out;
  if (Array.isArray(v)) {
    for (const x of v) if (x && typeof x === 'object') fieldPaths(x, `${prefix}[]`, depth, out);
    return out;
  }
  const last = prefix.split('.').pop();
  for (const [k, x] of Object.entries(v)) {
    const name = MAP_KEYS.has(last) ? '<model>' : ID_KEY.test(k) ? '<id>' : k;
    const p = prefix ? `${prefix}.${name}` : name;
    out.add(p);
    fieldPaths(x, p, depth - 1, out);
  }
  return out;
}

/** kind -> { count, fields: Set } for a list of records and a function that names a record's kind. */
function collect(records, kindOf, depth) {
  const kinds = new Map();
  for (const r of records) {
    const k = kindOf(r);
    if (!kinds.has(k)) kinds.set(k, { count: 0, fields: new Set() });
    const e = kinds.get(k);
    e.count++;
    fieldPaths(r, '', depth, e.fields);
  }
  return kinds;
}

const claudeKind = (e) => {
  let k = e.type || '?';
  if (e.subtype) k += `/${e.subtype}`;
  const blocks = e.message && Array.isArray(e.message.content) ? [...new Set(e.message.content.map((b) => b.type))] : [];
  if (blocks.length) k += ` (${blocks.join(', ')})`;
  return k;
};

/** The timing log's runs, split into the run and its parts, so each part's fields are listed on their own. */
function timingParts(runs) {
  const parts = [];
  for (const r of runs) {
    const top = {};
    for (const [k, v] of Object.entries(r)) if (!['turns', 'tools', 'groups', 'summary'].includes(k)) top[k] = v;
    parts.push({ kind: 'run', rec: top });
    for (const t of r.turns || []) parts.push({ kind: 'run.turns[] (a model call)', rec: t });
    for (const t of r.tools || []) parts.push({ kind: 'run.tools[] (a tool call)', rec: t });
    for (const g of r.groups || []) parts.push({ kind: 'run.groups[] (calls run together)', rec: g });
    if (r.summary) parts.push({ kind: 'run.summary', rec: r.summary });
  }
  return parts;
}

/** Questions a log can answer, as field paths that must be there in some record. */
const QUESTIONS = [
  ['tokens per model call', { claude: ['message.usage.input_tokens'], history: ['data.promptTokens'], timing: ['promptTokens'] }],
  ['cache reads and writes', { claude: ['usage.cache_read_input_tokens'], history: ['data.cacheReadTokens'], timing: ['cacheReadTokens'] }],
  ['how long each model call took', { claude: ['duration_api_ms (total only)'], history: [], timing: ['endMs'] }],
  ['time to first token', { claude: ['ttft_ms (first call only)'], history: [], timing: ['firstEventMs'] }],
  ['how long each tool call took', { claude: ['timestamp (tool_use to tool_result)'], history: ['data.durationMs'], timing: ['wallMs', 'execMs'] }],
  ['tool arguments (commands, paths)', { claude: ['message.content[].input'], history: ['data.args'], timing: [] }],
  ['safety check verdicts', { claude: ['tool_result_meta[].permission_decision.decision'], history: ['data.verdict'], timing: ['permission[].check'] }],
  ['how long the safety checks took', { claude: [], history: ['data.ms'], timing: ['permission[].checkMs'] }],
  ['commands that ran sandboxed', { claude: [], timing: ['sandbox', 'sandboxed'], history: ['data.sandbox'] }],
  ['retries of a model call', { claude: [], history: ['data.attempt'], timing: ['retryWaits', 'retries'] }],
  ['cost in dollars', { claude: ['total_cost_usd'], history: [], timing: [] }],
  ['the text of messages', { claude: ['message.content[].text'], history: ['data.message.content'], timing: [] }],
];

function logFields(outDir) {
  const sources = [];
  const claudeFiles = findFiles(outDir, 'events.jsonl');
  const historyFiles = findFiles(outDir, 'history.jsonl');
  const timingFiles = findFiles(outDir, 'timing.jsonl');
  const claude = collect(claudeFiles.flatMap(readJsonl), claudeKind, 3);
  const history = collect(historyFiles.flatMap(readJsonl), (r) => r.type || '?', 4);
  const parts = timingParts(timingFiles.flatMap(readJsonl));
  const timing = new Map();
  for (const { kind, rec } of parts) {
    if (!timing.has(kind)) timing.set(kind, { count: 0, fields: new Set() });
    const e = timing.get(kind);
    e.count++;
    fieldPaths(rec, '', 2, e.fields);
  }
  sources.push({ id: 'claude', title: "Claude Code's event stream (events.jsonl, --output-format stream-json --verbose)", files: claudeFiles.length, kinds: claude });
  sources.push({ id: 'history', title: "Silo Harness's history log (history/<session>.jsonl in the profile; copied as history.jsonl)", files: historyFiles.length, kinds: history });
  sources.push({ id: 'timing', title: "Silo Harness's timing log (timing/timing.jsonl in the profile; this session's runs copied as timing.jsonl)", files: timingFiles.length, kinds: timing });

  const md = ['# Log fields', '', 'Record kinds and the field names each carries (names only, no values), from the logs under this folder. Nested fields are dotted; `[]` is an array of objects. Model ids used as map keys show as `<model>`, tool-call and message ids as `<id>`.', ''];
  const all = {};
  for (const s of sources) {
    all[s.id] = new Set();
    md.push(`## ${s.title}`, '', `${s.files} file(s), ${s.kinds.size} record kind(s).`, '');
    for (const [kind, e] of [...s.kinds.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      md.push(`- **${kind}** (${e.count}): ${[...e.fields].sort().map((f) => `\`${f}\``).join(', ')}`);
      for (const f of e.fields) all[s.id].add(f);
    }
    md.push('');
  }
  md.push('## Which log answers what', '', 'A field that answers it is there in at least one record of these runs (a blank: no field for it was seen).', '');
  const has = (id, f) => [...all[id]].some((x) => x === f || x.endsWith(`.${f}`));
  const rows = QUESTIONS.map(([q, by]) => [
    q,
    ...['claude', 'history', 'timing'].map((id) => {
      const hit = (by[id] || []).find((f) => has(id, f.replace(/ \(.*\)$/, '')));
      return hit ? `\`${hit}\`` : '';
    }),
  ]);
  md.push(mdTable(['question', 'Claude Code events', 'Silo history', 'Silo timing'], rows), '');
  return md.join('\n');
}

// ---------- Main ----------

function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('Usage: node scripts/side-by-side/compare.js <outDir>');
    process.exit(2);
  }
  const files = findFiles(path.resolve(outDir), 'summary.json');
  if (!files.length) {
    console.error(`No summary.json under ${outDir}`);
    process.exit(1);
  }
  const byTask = new Map();
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    s._final = (() => {
      try {
        return fs.readFileSync(path.join(path.dirname(f), 'final.txt'), 'utf8');
      } catch {
        return '';
      }
    })();
    if (!byTask.has(s.task)) byTask.set(s.task, []);
    byTask.get(s.task).push(s);
  }
  const order = (r) => (RUNNER_ORDER.includes(r) ? RUNNER_ORDER.indexOf(r) : 99);
  const tasks = [...byTask.keys()].sort((a, b) => (TASK_IDS.indexOf(a) + 1 || 99) - (TASK_IDS.indexOf(b) + 1 || 99) || a.localeCompare(b));

  const text = [];
  const md = ['# Side by side', '', `From ${files.length} run(s) under \`${path.resolve(outDir)}\`. Wall time is measured outside each harness (claude: spawn to exit; Silo: message sent to idle); "in its log" is the harness's own figure. Tokens in are uncached input; Silo's cost and checks include Auto mode's check calls.`, ''];
  const json = { outDir: path.resolve(outDir), tasks: {} };
  for (const task of tasks) {
    const runs = byTask.get(task).sort((a, b) => order(a.runner) - order(b.runner) || a.runner.localeCompare(b.runner));
    const header = ['', ...runs.map((r) => r.runner)];
    const rows = ROWS.map(([label, f]) => [label, ...runs.map((r) => f(r))]);
    text.push(`=== ${task} ===`, textTable(header, rows), '');
    md.push(`## ${task}`, '', mdTable(header, rows), '', '### Final messages', '');
    for (const r of runs) {
      const fin = r._final.trim() || '(no final message)';
      text.push(`--- ${task} / ${r.runner}: final message ---`, fin, '');
      md.push(`#### ${r.runner}`, '', fin.split('\n').map((l) => `> ${l}`).join('\n'), '');
    }
    json.tasks[task] = Object.fromEntries(
      runs.map((r) => {
        const { steps, _final, ...rest } = r;
        return [r.runner, { ...rest, steps: steps.length, final: _final }];
      }),
    );
  }
  console.log(text.join('\n'));
  const dir = path.resolve(outDir);
  fs.writeFileSync(path.join(dir, 'compare.md'), md.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'compare.json'), JSON.stringify(json, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'log-fields.md'), logFields(dir) + '\n');
  console.log(`Wrote compare.md, compare.json and log-fields.md in ${dir}`);
}

main();
