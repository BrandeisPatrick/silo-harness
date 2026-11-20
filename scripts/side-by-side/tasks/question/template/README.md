# relaybox

Delivers queued webhook events to subscribers. Each event goes to its subscriber's URL; a delivery that fails is
tried again later, with a growing wait, until it succeeds or relaybox gives up on it.

    const { createRelay } = require('relaybox');
    const relay = createRelay({ send: async (url, body) => ({ status: 200 }) });
    relay.enqueue({ url: 'https://hooks.example.invalid/a', body: { hello: 1 } });
    await relay.drain();

Run the tests with `npm test`.
