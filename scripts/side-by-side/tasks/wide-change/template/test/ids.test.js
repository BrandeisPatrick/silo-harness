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
const { nextId } = require('../src/ids.js');

test('ids share one counter across prefixes', () => {
  const store = createStore(tmp());
  assert.strictEqual(nextId(store, 'u'), 'u-1');
  assert.strictEqual(nextId(store, 'n'), 'n-2');
});

test('the counter survives reopening the folder', () => {
  const dir = tmp();
  nextId(createStore(dir), 'u');
  assert.strictEqual(nextId(createStore(dir), 'u'), 'u-2');
});
