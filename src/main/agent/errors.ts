// What a run's errors say to the user: a provider's refusal in plain words, and never with a key in it.

import type { AppConfig } from '../../shared/types';
import { isContextLengthError } from '../compact';
import { plainError, resolveProvider, scrubSecrets } from '../providers';
import { RetryGaveUp } from './retry';

/**
 * What a run's error says: a service's refusal or an unreachable address in plain words, naming the provider and
 * what to check (plainError); anything else as it is. Never with a key.
 */
export function providerErrorMessage(err: unknown, cfg: AppConfig): string {
  // The retry loop gave up: one sentence that says so, then the provider's own message
  if (err instanceof RetryGaveUp) return `${err.lead} ${providerErrorMessage(err.last, cfg)}`;
  const e = err as { status?: unknown; name?: unknown };
  const fromService = typeof e?.status === 'number' || e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError';
  if (!fromService || isContextLengthError(err)) return errorMessage(err);
  try {
    return plainError(err, resolveProvider(cfg));
  } catch {
    return errorMessage(err);
  }
}

/** An error's message, with any key the providers resolved taken out (a service's error may quote it). */
export function errorMessage(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : String(err));
}
