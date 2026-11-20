// Helpers the tasks' verify.js scripts share: run the project's tests, compare files with the task's template, read
// the final message, print the one JSON line.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Files under dir (relative paths, sorted), without .git and node_modules. */
function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out.sort();
}

const hash = (file) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
};

/** Files that differ between the template and the project, optionally only under `sub`: added, removed, changed. */
function diffTree(templateDir, projectDir, sub = '') {
  const a = listFiles(path.join(templateDir, sub));
  const b = listFiles(path.join(projectDir, sub));
  const added = b.filter((f) => !a.includes(f));
  const removed = a.filter((f) => !b.includes(f));
  const changed = a.filter((f) => b.includes(f) && hash(path.join(templateDir, sub, f)) !== hash(path.join(projectDir, sub, f)));
  return { added, removed, changed, same: !added.length && !removed.length && !changed.length };
}

/** Runs the project's tests (`node --test`), with a time limit; { ok, out }. */
function runTests(projectDir, extra = []) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['--test', ...extra], { cwd: projectDir, env, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** How many test cases the project's test files declare (calls of test( or it( at the start of a line). */
function countTests(projectDir) {
  let n = 0;
  for (const f of listFiles(projectDir)) {
    if (!/\.test\.[cm]?js$/.test(f)) continue;
    const text = fs.readFileSync(path.join(projectDir, f), 'utf8');
    n += (text.match(/^\s*(?:test|it)\s*\(/gm) || []).length;
  }
  return n;
}

function readFinal(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Sentences (and list items) of a message, for checks that want a fact said in one place. */
function sentences(text) {
  return String(text)
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Prints the result line and exits 0 only when every hard check is true. */
function finish(hard, soft = {}) {
  console.log(JSON.stringify({ hard, soft }));
  process.exit(Object.values(hard).every(Boolean) ? 0 : 1);
}

/** The two arguments every verify.js takes. */
function args() {
  const [projectDir, finalFile] = process.argv.slice(2);
  if (!projectDir) {
    console.error('Usage: node verify.js <projectDir> [finalMessageFile]');
    process.exit(2);
  }
  return { projectDir: path.resolve(projectDir), final: finalFile ? readFinal(finalFile) : '' };
}

module.exports = { listFiles, diffTree, runTests, countTests, readFinal, sentences, finish, args };
