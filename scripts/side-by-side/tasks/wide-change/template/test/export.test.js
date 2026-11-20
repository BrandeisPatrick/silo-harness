const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notebox = require('../src/index.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notebox-'));
let t = 1000;
notebox.setClock(() => ++t);

test('export has users, notes and tags in order', () => {
  const dir = tmp();
  const nb = notebox.open(dir);
  const u = nb.users.create('Ada');
  const n = nb.notes.create(u.id, { title: 'a', tags: ['x'] });
  const out = notebox.open(dir, { cache: false }).exportAll();
  assert.deepStrictEqual(out.users.map((x) => x.id), [u.id]);
  assert.deepStrictEqual(out.notes.map((x) => x.id), [n.id]);
  assert.deepStrictEqual(out.tags, [{ tag: 'x', count: 1 }]);
  assert.strictEqual(notebox.summary(n), 'a [x]');
});
