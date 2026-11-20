const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notebox = require('../src/index.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notebox-'));
let t = 1000;
notebox.setClock(() => ++t);

test('every word must match, title or body, any case', () => {
  const nb = notebox.open(tmp());
  const u = nb.users.create('Ada');
  const a = nb.notes.create(u.id, { title: 'Bread recipe', body: 'flour, water, salt' });
  nb.notes.create(u.id, { title: 'Cake', body: 'flour, sugar' });
  assert.deepStrictEqual(nb.search('FLOUR salt').map((n) => n.id), [a.id]);
  assert.strictEqual(nb.search('flour').length, 2);
  assert.deepStrictEqual(nb.search('  '), []);
});
