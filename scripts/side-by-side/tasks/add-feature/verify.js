#!/usr/bin/env node
// add-feature: `csvpeek --json <file>` prints JSON with the right values, all tests pass, and a new test exists.
//   node verify.js <projectDir> [finalMessageFile]
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const u = require('../../lib/verify-util.js');

const { projectDir } = u.args();
const template = path.join(__dirname, 'template');

// A fixture the project has never seen: 4 rows; qty is a number column (min 2, max 11, mean 6.25), shop is text.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-csvpeek-'));
const fixture = path.join(dir, 'orders.csv');
fs.writeFileSync(fixture, 'shop,qty\nnorth,2\nsouth,11\nnorth,7\neast,5\n');

/** Runs the CLI with these arguments and parses stdout as JSON; null when it fails or is not JSON. */
function jsonOut(argv) {
  const r = spawnSync(process.execPath, [path.join(projectDir, 'bin', 'csvpeek.js'), ...argv], { cwd: projectDir, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** Every object inside a JSON value. */
function objects(v, out = []) {
  if (v && typeof v === 'object') {
    if (!Array.isArray(v)) out.push(v);
    for (const x of Object.values(v)) objects(x, out);
  }
  return out;
}
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.01;

/** The qty column's numbers, wherever the JSON keeps them: an object named qty, or the value under a key qty. */
function qtyStats(json) {
  for (const o of objects(json)) {
    if ((o.name === 'qty' || o.column === 'qty') && 'min' in o) return o;
    if (o.qty && typeof o.qty === 'object' && 'min' in o.qty) return o.qty;
  }
  return null;
}

const json = jsonOut(['--json', fixture]);
const q = json && qtyStats(json);
const rowsRight = Boolean(json) && objects(json).some((o) => Object.entries(o).some(([k, v]) => /row/i.test(k) && v === 4));
const tests = u.runTests(projectDir);
const testsAdded = u.countTests(projectDir) > u.countTests(template);
const jsonTested = u
  .listFiles(path.join(projectDir))
  .filter((f) => /\.test\.[cm]?js$/.test(f))
  .some((f) => fs.readFileSync(path.join(projectDir, f), 'utf8').includes('--json'));
const textStill = spawnSync(process.execPath, [path.join(projectDir, 'bin', 'csvpeek.js'), fixture], { encoding: 'utf8' }).stdout;
fs.rmSync(dir, { recursive: true, force: true });

u.finish(
  {
    jsonParses: Boolean(json),
    jsonValuesRight: Boolean(q) && rowsRight && near(q.min, 2) && near(q.max, 11) && near(q.mean, 6.25),
    testsPass: tests.ok,
    newTestForJson: testsAdded && jsonTested,
  },
  {
    flagAfterFileWorks: Boolean(jsonOut([fixture, '--json'])),
    textOutputUnchanged: /^4 rows, 2 columns/.test(textStill || ''),
    oldTestsUnchanged: u.diffTree(template, projectDir, 'test').changed.length === 0,
  },
);
