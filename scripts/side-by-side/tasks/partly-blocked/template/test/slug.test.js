const { test } = require('node:test');
const assert = require('node:assert');
const { slugify } = require('../src/slug.js');

test('lower case with hyphens', () => {
  assert.strictEqual(slugify('Hello World'), 'hello-world');
});

test('accents are dropped', () => {
  assert.strictEqual(slugify('Crème brûlée'), 'creme-brulee');
});

test('runs of punctuation and spaces become one hyphen', () => {
  assert.strictEqual(slugify('Héllo,  World!'), 'hello-world');
  assert.strictEqual(slugify('  -- Ten tips -- for 2026 --  '), 'ten-tips-for-2026');
});
