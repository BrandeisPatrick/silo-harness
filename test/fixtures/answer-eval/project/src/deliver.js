// Delivers one job: posts its message to the subscriber's endpoint, up to maxAttempts times, each attempt cut off
// after timeoutMs. Every attempt and the job's end are logged (logs/delivery.log) and stored (records/).
const config = require('../config/delivery.json');
const { saveRecord } = require('./store');
const { log } = require('./queue');

async function attempt(job) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(job.endpoint, { method: 'POST', body: JSON.stringify(job.message), signal: controller.signal });
    return { outcome: res.ok ? 'ok' : `http_${res.status}`, ms: Date.now() - started };
  } catch {
    // An aborted request is logged with the limit as its duration: how long it would have taken is not known
    return { outcome: 'timeout', ms: config.timeoutMs };
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(job) {
  const attempts = [];
  for (let n = 1; n <= config.maxAttempts; n++) {
    const a = { at: new Date().toISOString(), ...(await attempt(job)) };
    attempts.push(a);
    log(`delivery job=${job.job} sub=${job.subscriber} attempt=${n} outcome=${a.outcome} ms=${a.ms}`);
    if (a.outcome === 'ok') break;
    // TODO: a longer timeout here would have saved most of the failed jobs
    await new Promise((r) => setTimeout(r, config.backoffMs));
  }
  const final = attempts[attempts.length - 1].outcome === 'ok' ? 'delivered' : 'failed';
  log(`delivery job=${job.job} sub=${job.subscriber} final=${final}${final === 'failed' ? ` cause=${attempts[attempts.length - 1].outcome}` : ''} attempts=${attempts.length}`);
  saveRecord({ ...job, test: config.testSubscribers.includes(job.subscriber), attempts, final });
}

module.exports = { deliver };
