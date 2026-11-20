const { test } = require('node:test');
const assert = require('node:assert');
const { readingTime } = require('../src/reading-time.js');

test('rounds to whole minutes', () => {
  assert.strictEqual(readingTime(660), '3 min read');
});

test('never less than one minute', () => {
  assert.strictEqual(readingTime(10), '1 min read');
});
