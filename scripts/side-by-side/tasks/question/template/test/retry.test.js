const { test } = require('node:test');
const assert = require('node:assert');
const { decide } = require('../src/retry.js');
const { DeliveryError } = require('../src/errors.js');
const { DEFAULTS } = require('../src/config.js');

test('a 503 is retried', () => {
  assert.deepStrictEqual(decide(new DeliveryError('x', { status: 503 }), 1, DEFAULTS), { retry: true });
});

test('a 404 is not', () => {
  assert.strictEqual(decide(new DeliveryError('x', { status: 404 }), 1, DEFAULTS).retry, false);
});

test('the last attempt is not retried', () => {
  const d = decide(new DeliveryError('x', { status: 503 }), DEFAULTS.maxAttempts, DEFAULTS);
  assert.deepStrictEqual(d, { retry: false, reason: 'attempts-exhausted' });
});
