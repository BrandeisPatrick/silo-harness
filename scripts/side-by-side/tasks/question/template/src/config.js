// Settings, with defaults. RELAYBOX_* environment variables override them when the relay is created.

const DEFAULTS = {
  /** Deliveries tried per event, the first one included, before it is given up on */
  maxAttempts: 6,
  /** The wait before the first retry; each later one doubles, up to maxDelayMs */
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  /** How long one delivery may take before it counts as failed */
  timeoutMs: 10_000,
  /** Deliveries in flight at once */
  concurrency: 4,
};

function loadConfig(overrides = {}, env = process.env) {
  const cfg = { ...DEFAULTS, ...overrides };
  if (env.RELAYBOX_MAX_ATTEMPTS) cfg.maxAttempts = Number(env.RELAYBOX_MAX_ATTEMPTS);
  if (env.RELAYBOX_CONCURRENCY) cfg.concurrency = Number(env.RELAYBOX_CONCURRENCY);
  return cfg;
}

module.exports = { DEFAULTS, loadConfig };
