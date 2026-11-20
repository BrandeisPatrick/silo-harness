const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notebox = require('../src/index.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notebox-'));
let t = 1000;
notebox.setClock(() => ++t);

test('tag counts, most used first', () => {
  const nb = notebox.open(tmp());
  const u = nb.users.create('Ada');
  nb.notes.create(u.id, { title: 'a', tags: ['work', 'home'] });
  nb.notes.create(u.id, { title: 'b', tags: ['work'] });
  assert.deepStrictEqual(nb.tags.counts(), [{ tag: 'work', count: 2 }, { tag: 'home', count: 1 }]);
});

test('renaming a tag merges it into the other', () => {
  const nb = notebox.open(tmp());
  const u = nb.users.create('Ada');
  nb.notes.create(u.id, { title: 'a', tags: ['job', 'work'] });
  nb.notes.create(u.id, { title: 'b', tags: ['job'] });
  assert.strictEqual(nb.tags.rename('Job', 'work'), 2);
  assert.deepStrictEqual(nb.tags.counts(), [{ tag: 'work', count: 2 }]);
});
