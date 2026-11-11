// The job queue: four workers take jobs in order; log() appends a line to logs/delivery.log.
const fs = require('node:fs');
const path = require('node:path');

const LOG = path.join(__dirname, '..', 'logs', 'delivery.log');
const queue = [];

function log(line, level = 'INFO ') {
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${level} ${line}\n`);
}

function enqueue(job) {
  queue.push(job);
}

async function work(deliver, workers = 4) {
  const run = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await deliver(job);
  };
  await Promise.all(Array.from({ length: workers }, run));
}

module.exports = { enqueue, work, log };
