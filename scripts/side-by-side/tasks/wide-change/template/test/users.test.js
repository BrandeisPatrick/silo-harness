const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notebox = require('../src/index.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notebox-'));
let t = 1000;
notebox.setClock(() => ++t);

test('create, get and list users', () => {
  const nb = notebox.open(tmp());
  const bo = nb.users.create('Bo');
  const ada = nb.users.create(' Ada ');
  assert.strictEqual(ada.name, 'Ada');
  assert.deepStrictEqual(nb.users.get(bo.id), bo);
  assert.deepStrictEqual(nb.users.list().map((u) => u.name), ['Ada', 'Bo']);
});

test('names are unique, ignoring case', () => {
  const nb = notebox.open(tmp());
  nb.users.create('Ada');
  assert.throws(() => nb.users.create('ADA'), notebox.ConflictError);
});

test('rename, and a missing user', () => {
  const nb = notebox.open(tmp());
  const u = nb.users.create('Ada');
  assert.strictEqual(nb.users.rename(u.id, 'Ada L').name, 'Ada L');
  assert.throws(() => nb.users.get('u-99'), notebox.NotFoundError);
  assert.throws(() => nb.users.create(''), notebox.ValidationError);
});
