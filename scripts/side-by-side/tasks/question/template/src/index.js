const { loadConfig } = require('./config.js');
const { Queue } = require('./queue.js');
const { nextId } = require('./ids.js');

/** A relay: enqueue(event) adds an event, drain() delivers everything queued, dead() lists what was given up on. */
function createRelay({ send, config = {}, sleep, log } = {}) {
  if (typeof send !== 'function') throw new TypeError('send must be a function');
  const queue = new Queue(send, loadConfig(config), { sleep, log });
  return {
    enqueue(event) {
      const withId = { id: nextId(), ...event };
      queue.push(withId);
      return withId.id;
    },
    drain: () => queue.drain(),
    delivered: () => [...queue.delivered],
    dead: () => [...queue.dead],
  };
}

module.exports = { createRelay };
