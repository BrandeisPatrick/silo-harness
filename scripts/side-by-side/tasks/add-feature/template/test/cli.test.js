const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const cli = path.join(__dirname, '..', 'bin', 'csvpeek.js');
const example = path.join(__dirname, '..', 'examples', 'plants.csv');

test('prints the text summary', () => {
  const r = spawnSync(process.execPath, [cli, example], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^3 rows, 3 columns/);
  assert.match(r.stdout, /height_cm: min 25, max 180, mean 81\.67/);
});

test('says how to use it when no file is given', () => {
  const r = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /Usage/);
});
