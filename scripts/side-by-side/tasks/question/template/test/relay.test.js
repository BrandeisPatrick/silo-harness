const { test } = require('node:test');
const assert = require('node:assert');
const { createRelay } = require('../src/index.js');

test('a delivery that keeps failing ends up dead after the attempts run out', async () => {
  let calls = 0;
  const relay = createRelay({ send: async () => (calls++, { status: 503 }), config: { maxAttempts: 3 }, sleep: async () => {} });
  relay.enqueue({ url: 'u', body: {} });
  await relay.drain();
  assert.strictEqual(calls, 3);
  assert.strictEqual(relay.dead()[0].reason, 'attempts-exhausted');
});

test('a delivery that succeeds is delivered', async () => {
  const relay = createRelay({ send: async () => ({ status: 204 }), sleep: async () => {} });
  relay.enqueue({ url: 'u', body: {} });
  await relay.drain();
  assert.strictEqual(relay.delivered().length, 1);
});
