const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notebox = require('../src/index.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notebox-'));
let t = 1000;
notebox.setClock(() => ++t);

test('notes per user, by name', () => {
  const nb = notebox.open(tmp());
  const bo = nb.users.create('Bo');
  const ada = nb.users.create('Ada');
  nb.notes.create(bo.id, { title: 'x' });
  nb.notes.create(bo.id, { title: 'y' });
  assert.deepStrictEqual(nb.stats.perUser(), [
    { userId: ada.id, name: 'Ada', notes: 0 },
    { userId: bo.id, name: 'Bo', notes: 2 },
  ]);
});
