const { deliver } = require('./deliver.js');
const { decide } = require('./retry.js');
const { backoffDelay } = require('./backoff.js');

/** The queue of events and the loop that delivers them. */
class Queue {
  constructor(send, cfg, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
    this.send = send;
    this.cfg = cfg;
    this.sleep = sleep;
    this.log = log;
    this.pending = [];
    this.delivered = [];
    this.dead = [];
  }

  push(event) {
    this.pending.push({ event, attempt: 0 });
  }

  /** Delivers everything queued; resolves when each event was delivered or given up on. */
  async drain() {
    const workers = Array.from({ length: this.cfg.concurrency }, () => this.work());
    await Promise.all(workers);
  }

  async work() {
    for (let item = this.pending.shift(); item; item = this.pending.shift()) {
      for (;;) {
        item.attempt++;
        try {
          await deliver(this.send, item.event, this.cfg);
          this.delivered.push(item.event);
          break;
        } catch (err) {
          const d = decide(err, item.attempt, this.cfg);
          this.log({ event: item.event.id, attempt: item.attempt, error: err.message, retry: d.retry });
          if (!d.retry) {
            this.dead.push({ event: item.event, reason: d.reason, attempts: item.attempt });
            break;
          }
          await this.sleep(backoffDelay(item.attempt, this.cfg));
        }
      }
    }
  }
}

module.exports = { Queue };
