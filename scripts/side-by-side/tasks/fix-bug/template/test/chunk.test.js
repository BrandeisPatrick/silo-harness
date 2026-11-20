const { test } = require('node:test');
const assert = require('node:assert');
const { chunk } = require('../src/chunk.js');

test('chunk splits into equal parts and a shorter last one', () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunk refuses a size below one', () => {
  assert.throws(() => chunk([1], 0), RangeError);
});
