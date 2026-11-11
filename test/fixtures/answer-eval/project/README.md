# notify-relay

A small made-up service that delivers notification webhooks to subscribers. A job is queued for each event; the
worker posts it to the subscriber's endpoint and retries on a timeout or an error.

- `config/delivery.json`: the timeout per attempt, the number of attempts and the pause between them.
- `src/`: the worker (`deliver.js`), the queue (`queue.js`) and the record store (`store.js`).
- `logs/delivery.log`: one line per attempt and one line per finished job.
- `records/`: one JSON record per job: its subscriber, its attempts and how it ended. Jobs of the test subscriber
  (`sub-test-01`) are marked `"test": true`; they exercise error handling and are left out of the service's figures.

## Known issues

Most failed deliveries are timeouts. Raising `timeoutMs` to 5000 would fix most of them.
