// What run-claude.js and run-silo.js share: the tasks, the project copy, the tool kinds, the finish fields, verify.js
// and summary.json.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERE = path.join(__dirname, '..');
const TASKS = path.join(HERE, 'tasks');

/** The task ids, in the order compare.js prints them. */
const TASK_IDS = ['fix-bug', 'add-feature', 'question', 'partly-blocked'];

function loadTask(id) {
  const dir = path.join(TASKS, String(id || ''));
  if (!id || !fs.existsSync(path.join(dir, 'prompt.txt'))) {
    const known = fs.readdirSync(TASKS).filter((d) => fs.existsSync(path.join(TASKS, d, 'prompt.txt')));
    throw new Error(`Unknown task "${id}". Tasks: ${known.join(', ')}`);
  }
  return {
    id,
    dir,
    template: path.join(dir, 'template'),
    prompt: fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8').trim(),
    meta: JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8')),
  };
}

/** argv → { _: positional[], flag: value | true }; `bools` are flags that take no value. */
function parseArgs(argv, bools = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (bools.includes(a.slice(2))) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

/**
 * <outDir>/<task>/<runner>/, with project/ a fresh copy of the template as a git repository with one commit. Refuses
 * a run folder that is already there: each round goes to a folder of its own.
 */
function prepareRun(task, outDir, runner) {
  const runDir = path.join(path.resolve(outDir), task.id, runner);
  if (fs.existsSync(runDir)) throw new Error(`${runDir} is already there: give each round its own output folder`);
  const project = path.join(runDir, 'project');
  fs.mkdirSync(runDir, { recursive: true });
  fs.cpSync(task.template, project, { recursive: true });
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'template']]) {
    const r = git(project, ...args);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  // The real path: macOS's /tmp is /private/tmp, and both harnesses resolve the working directory
  return { runDir: fs.realpathSync(runDir), project: fs.realpathSync(project) };
}

/** Paths the run created and paths it changed (created, modified or deleted), from git, relative to the project. */
function gitChanges(project) {
  const r = git(project, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  if (r.status !== 0) return { newFiles: [], changedFiles: [] };
  const newFiles = [];
  const changedFiles = [];
  const parts = r.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const file = parts[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the old name follows
    changedFiles.push(file);
    if (code === '??' || code[0] === 'A') newFiles.push(file);
  }
  return { newFiles: newFiles.sort(), changedFiles: changedFiles.sort() };
}

/** A tool's normalised kind: read, search, edit, shell or other. Covers both harnesses' names. */
const KINDS = {
  // Claude Code
  Read: 'read',
  NotebookRead: 'read',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  Monitor: 'shell',
  // Silo Harness
  read_file: 'read',
  list_directory: 'search',
  glob: 'search',
  grep: 'search',
  edit_file: 'edit',
  write_file: 'edit',
  bash: 'shell',
  terminal_run: 'shell',
  terminal_read: 'shell',
};
const kindOf = (name) => KINDS[name] || 'other';
const KIND_NAMES = ['read', 'search', 'edit', 'shell', 'other'];

/** A shell command that runs tests. */
const looksLikeTestRun = (cmd) => /\bnode\s+(?:[^|;&]*\s)?--test\b|\bnode\s+[^|;&]*\.test\.[cm]?js\b|\bnpm\s+(?:run\s+)?t(?:est)?\b|\bnpx\s+(?:jest|vitest|mocha)\b|\b(?:jest|vitest|mocha|pytest)\b/.test(String(cmd || ''));

/** Tool counts by raw name and by kind, from the steps. */
function toolCounts(steps) {
  const byName = {};
  const byKind = Object.fromEntries(KIND_NAMES.map((k) => [k, 0]));
  let total = 0;
  for (const s of steps) {
    if (s.type !== 'tool') continue;
    total++;
    byName[s.name] = (byName[s.name] || 0) + 1;
    byKind[s.kind]++;
  }
  return { total, byName, byKind };
}

/** The finish fields: what the run did last and what its final message looks like. */
function finishFields(final, steps, project) {
  const text = String(final || '');
  const lastEdit = steps.reduce((at, s, i) => (s.type === 'tool' && s.kind === 'edit' ? i : at), -1);
  const testAfter = steps.some((s, i) => i > lastEdit && s.type === 'tool' && s.kind === 'shell' && looksLikeTestRun(s.cmd));
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return {
    // null when the run made no edit through an edit tool (a question, or edits made from the shell)
    ranTestsAfterLastEdit: lastEdit < 0 ? null : testAfter,
    ranTestsAtAll: steps.some((s) => s.type === 'tool' && s.kind === 'shell' && looksLikeTestRun(s.cmd)),
    finalChars: text.length,
    finalWords: words,
    finalLines: text.trim() ? text.trim().split('\n').length : 0,
    hasHeading: /^#{1,6}\s/m.test(text),
    bullets: (text.match(/^\s*(?:[-*+]|\d+[.)])\s+/gm) || []).length,
    hasCodeBlock: /```/.test(text),
    endsWithQuestion: /\?\s*$/.test(text.trim()),
    mentionsTests: /\btests?\b|\btesting\b|node --test|npm test/i.test(text),
    ...gitChanges(project),
  };
}

/** Runs the task's verify.js; { hard, soft, ok } (ok: every hard check true). */
function runVerify(task, project, finalFile) {
  const r = spawnSync(process.execPath, [path.join(task.dir, 'verify.js'), project, finalFile], { encoding: 'utf8', timeout: 180_000 });
  const line = String(r.stdout || '')
    .trim()
    .split('\n')
    .pop();
  try {
    const v = JSON.parse(line);
    return { ok: r.status === 0, hard: v.hard, soft: v.soft };
  } catch {
    return { ok: false, hard: { verifyRan: false }, soft: {}, error: String(r.stderr || r.stdout || '').slice(0, 500) };
  }
}

/** Writes summary.json in the run folder, in the shape every runner shares, and returns it. */
function writeSummary(runDir, s) {
  const summary = {
    runner: s.runner,
    task: s.task,
    model: s.model,
    wallMs: s.wallMs ?? null,
    verify: s.verify,
    modelCalls: s.modelCalls ?? null,
    tokens: s.tokens ?? null,
    costUsd: s.costUsd ?? null,
    tools: toolCounts(s.steps),
    steps: s.steps,
    checks: s.checks ?? null,
    finish: s.finish,
    log: s.log ?? {},
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

const short = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

module.exports = { HERE, TASKS, TASK_IDS, loadTask, parseArgs, prepareRun, gitChanges, kindOf, KIND_NAMES, looksLikeTestRun, toolCounts, finishFields, runVerify, writeSummary, short };
