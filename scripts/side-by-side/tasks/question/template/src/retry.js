// Whether a failed delivery is tried again. The queue asks after every failure.

/** Statuses that say "try later": the subscriber is busy or briefly down. */
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Network errors worth another try. */
const RETRY_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']);

/**
 * The decision after a failed attempt: { retry: true } or { retry: false, reason }.
 * `attempt` counts the attempts made so far, the failed one included.
 */
function decide(err, attempt, cfg) {
  if (attempt >= cfg.maxAttempts) return { retry: false, reason: 'attempts-exhausted' };
  if (err.status !== null && err.status !== undefined) {
    return RETRY_STATUSES.has(err.status) ? { retry: true } : { retry: false, reason: `status-${err.status}` };
  }
  if (err.code && RETRY_CODES.has(err.code)) return { retry: true };
  return { retry: false, reason: 'not-retryable' };
}

module.exports = { decide, RETRY_STATUSES, RETRY_CODES };
