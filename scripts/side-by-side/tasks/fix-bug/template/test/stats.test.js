const { test } = require('node:test');
const assert = require('node:assert');
const { mean, median, range } = require('../src/stats.js');

test('mean of a few numbers', () => {
  assert.strictEqual(mean([1, 2, 3, 4]), 2.5);
});

test('median of an odd count is the middle value', () => {
  assert.strictEqual(median([9, 1, 5]), 5);
});

test('median of an even count is the mean of the two middle values', () => {
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(median([10, 40]), 25);
});

test('median leaves its input as it was', () => {
  const input = [3, 1, 2];
  median(input);
  assert.deepStrictEqual(input, [3, 1, 2]);
});

test('range is smallest and largest', () => {
  assert.deepStrictEqual(range([5, -2, 7]), [-2, 7]);
});

test('empty input is refused', () => {
  assert.throws(() => mean([]), TypeError);
});
