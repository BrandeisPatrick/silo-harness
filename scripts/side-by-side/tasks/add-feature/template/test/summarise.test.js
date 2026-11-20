const { test } = require('node:test');
const assert = require('node:assert');
const { summarise } = require('../src/summarise.js');

test('counts rows and summarises number and text columns', () => {
  const s = summarise('a,b\n1,x\n3,y\n5,x\n');
  assert.strictEqual(s.rows, 3);
  assert.deepStrictEqual(s.columns[0], { name: 'a', type: 'number', min: 1, max: 5, mean: 3 });
  assert.deepStrictEqual(s.columns[1], { name: 'b', type: 'text', distinct: 2 });
});

test('a row with the wrong number of fields is refused', () => {
  assert.throws(() => summarise('a,b\n1\n'), /row 2/);
});
