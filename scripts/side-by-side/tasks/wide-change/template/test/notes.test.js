const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notebox = require('../src/index.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notebox-'));
let t = 1000;
notebox.setClock(() => ++t);

test('create a note with cleaned tags', () => {
  const nb = notebox.open(tmp());
  const u = nb.users.create('Ada');
  const n = nb.notes.create(u.id, { title: 'Groceries', body: 'eggs', tags: ['Home Ideas', 'home ideas', 'Work'] });
  assert.deepStrictEqual(n.tags, ['home-ideas', 'work']);
  assert.deepStrictEqual(nb.notes.get(n.id), n);
});

test('notes of a user, oldest first', () => {
  const nb = notebox.open(tmp());
  const u = nb.users.create('Ada');
  const v = nb.users.create('Bo');
  const a = nb.notes.create(u.id, { title: 'one' });
  nb.notes.create(v.id, { title: 'other' });
  const b = nb.notes.create(u.id, { title: 'two' });
  assert.deepStrictEqual(nb.notes.listByUser(u.id).map((n) => n.id), [a.id, b.id]);
});

test('update and remove', () => {
  const nb = notebox.open(tmp());
  const u = nb.users.create('Ada');
  const n = nb.notes.create(u.id, { title: 'one' });
  const changed = nb.notes.update(n.id, { title: 'uno', tags: ['x'] });
  assert.strictEqual(changed.title, 'uno');
  assert.ok(changed.updatedAt > n.updatedAt);
  assert.strictEqual(nb.notes.remove(n.id), true);
  assert.throws(() => nb.notes.get(n.id), notebox.NotFoundError);
});

test('a note needs a user that exists and a title', () => {
  const nb = notebox.open(tmp());
  assert.throws(() => nb.notes.create('u-9', { title: 'x' }), notebox.NotFoundError);
  const u = nb.users.create('Ada');
  assert.throws(() => nb.notes.create(u.id, { title: ' ' }), notebox.ValidationError);
});
