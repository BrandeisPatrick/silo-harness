/** The wait before retry number `retry` (1 for the first retry): doubling from base, capped, with up to 20% jitter. */
function backoffDelay(retry, { baseDelayMs, maxDelayMs }, random = Math.random) {
  const plain = Math.min(maxDelayMs, baseDelayMs * 2 ** (retry - 1));
  return Math.round(plain * (1 - 0.2 * random()));
}

module.exports = { backoffDelay };
