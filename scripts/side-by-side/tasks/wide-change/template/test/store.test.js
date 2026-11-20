const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notebox = require('../src/index.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notebox-'));
let t = 1000;
notebox.setClock(() => ++t);

const { createStore } = require('../src/store/index.js');

test('a collection with no file reads as empty', () => {
  const store = createStore(tmp());
  assert.deepStrictEqual(store.read('users'), []);
});

test('what is written is read back, also by a new store on the same folder', () => {
  const dir = tmp();
  createStore(dir).write('things', [{ id: 'a' }]);
  assert.deepStrictEqual(createStore(dir, { cache: false }).read('things'), [{ id: 'a' }]);
  assert.deepStrictEqual(createStore(dir).collections(), ['things']);
});

test('the cache hands out copies', () => {
  const store = createStore(tmp());
  store.write('things', [{ id: 'a' }]);
  store.read('things')[0].id = 'changed';
  assert.strictEqual(store.read('things')[0].id, 'a');
});
