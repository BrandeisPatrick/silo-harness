// The agent's own retry loop for model calls (agent/complete.ts): which failures are worth another try, how long to
// wait before it, and the loop itself, which a user Stop ends at once. The SDKs' own retries are off (maxRetries: 0 on
// the clients), so the attempts here are all there are, and the user sees each wait on the status line.
// Pure: no Electron, and the clock is injectable (retryTiming) so tests never sleep for real backoff times.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { isContextLengthError } from '../compact';

/** The first try and five retries */
export const MAX_ATTEMPTS = 6;
/** The first wait; each later one doubles */
export const BASE_DELAY_MS = 1000;
/** No backoff wait is longer than this */
export const MAX_DELAY_MS = 30_000;
/** Each backoff wait is moved up or down by up to this share, so many clients do not retry in step */
export const JITTER = 0.2;
/** A provider that asks for a longer wait than this (Retry-After) gets no retry: the user is told when to try again */
export const MAX_RETRY_AFTER_MS = 60_000;
/** A stream with no chunk for this long counts as a dropped connection (not applied to Ollama's native path) */
export const STREAM_IDLE_MS = 300_000;

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
const CONNECTION_TEXT = /fetch failed|socket hang up|\bterminated\b|other side closed|network error|premature close|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT/i;
/** Error types a provider sends in the body (or in a stream's error event, which has no status) for a passing fault */
const BUSY_TYPES = new Set(['overloaded_error', 'rate_limit_error', 'api_error', 'server_error', 'timeout_error']);
/** Out of credit: waiting does not help */
const QUOTA = /insufficient_quota|billing|credit balance/i;
/** Refusals complete.ts answers with a changed request, never by sending the same one again */
const FIELD_REFUSAL = /stream_options|include_usage|cache_control|prompt_cache_key|does not support tools/i;

/** The connection closed (or went silent) before the reply finished: retryable like any dropped connection. */
export class StreamDropped extends Error {
  constructor(message = 'The connection closed before the reply finished.') {
    super(message);
    this.name = 'StreamDropped';
  }
}

/**
 * Every attempt failed, or the provider asked for a wait too long to sit through. `lead` is what the user reads
 * first; providerErrorMessage (agent/errors.ts) puts the provider's own message, scrubbed of keys, after it.
 */
export class RetryGaveUp extends Error {
  constructor(
    readonly lead: string,
    readonly last: unknown,
  ) {
    super(`${lead} ${last instanceof Error ? last.message : String(last)}`);
    this.name = 'RetryGaveUp';
  }
}

type Loose = {
  name?: unknown;
  status?: unknown;
  httpStatus?: unknown;
  code?: unknown;
  type?: unknown;
  message?: unknown;
  headers?: unknown;
  error?: { type?: unknown; code?: unknown; message?: unknown; error?: { type?: unknown } } | null;
  cause?: { code?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
};

/** The HTTP status of a failed call: the SDKs' `status`, or `httpStatus` (Ollama's native path, ollama.ts). */
export function statusOf(err: unknown): number | undefined {
  const e = err as Loose;
  const s = typeof e?.status === 'number' ? e.status : typeof e?.httpStatus === 'number' ? e.httpStatus : undefined;
  return s;
}

/** A response header of a failed call: the SDKs carry a Headers object, a converted error may carry a plain one. */
export function headerOf(err: unknown, name: string): string | undefined {
  const h = (err as Loose)?.headers;
  if (!h || typeof h !== 'object') return undefined;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (k.toLowerCase() === name) return v == null ? undefined : String(v);
  return undefined;
}

function isAbort(err: unknown): boolean {
  const e = err as Loose;
  return err instanceof OpenAI.APIUserAbortError || err instanceof Anthropic.APIUserAbortError || e?.name === 'AbortError';
}

/** The error type a provider put in the body (OpenAI: error.type, Anthropic: error.error.type, converted: error.type). */
function bodyType(err: unknown): string {
  const e = err as Loose;
  return String(e?.error?.type ?? e?.error?.error?.type ?? e?.type ?? '');
}

/** True for a dropped or refused connection: the SDKs' connection errors, a socket code, or the words for one. */
export function isConnectionError(err: unknown): boolean {
  const e = err as Loose;
  if (err instanceof StreamDropped || e?.name === 'StreamDropped') return true;
  if (err instanceof OpenAI.APIConnectionError || err instanceof Anthropic.APIConnectionError) return true;
  if (e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError') return true;
  for (const code of [e?.code, e?.cause?.code, e?.cause?.cause?.code]) if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true;
  return CONNECTION_TEXT.test(String(e?.message ?? '')) || CONNECTION_TEXT.test(String(e?.cause?.message ?? ''));
}

/** True when another try of the same request may succeed: a passing fault of the service or the connection. */
export function isRetryable(err: unknown): boolean {
  if (!err || isAbort(err)) return false;
  if (isContextLengthError(err)) return false;
  const e = err as Loose;
  const message = String(e?.error?.message ?? e?.message ?? '');
  if (QUOTA.test(message) || QUOTA.test(String(e?.code ?? e?.error?.code ?? '')) || QUOTA.test(bodyType(err))) return false;
  if (FIELD_REFUSAL.test(message)) return false;
  const should = headerOf(err, 'x-should-retry');
  if (should === 'false') return false;
  const status = statusOf(err);
  if (status !== undefined) return should === 'true' || RETRY_STATUS.has(status);
  // No status: a stream's error event (its type says what it was) or a connection that failed
  if (BUSY_TYPES.has(bodyType(err))) return true;
  return isConnectionError(err);
}

/** True for a busy or failing service (429, 5xx, 529, or an overloaded / rate-limit error event); false for a connection. */
export function isBusy(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return status === 429 || status >= 500;
  return BUSY_TYPES.has(bodyType(err));
}

/** The wait a Retry-After or retry-after-ms header asks for, in ms; undefined without a usable one. */
export function retryAfterMs(err: unknown, now = Date.now()): number | undefined {
  const ms = headerOf(err, 'retry-after-ms');
  if (ms !== undefined && ms.trim() && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
  const ra = headerOf(err, 'retry-after');
  if (ra === undefined || !ra.trim()) return undefined;
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(ra)) return Number(ra) * 1000;
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * How long to wait after failed attempt number `attempt` (1 for the first try): 1 s doubling to a 30 s cap, ±20%
 * jitter, unless the provider's Retry-After (or retry-after-ms) header names a wait; that wins, and may be longer than
 * MAX_RETRY_AFTER_MS (the loop then gives up instead of waiting).
 */
export function retryDelayMs(attempt: number, err: unknown, random: () => number = Math.random, now = Date.now()): number {
  const asked = retryAfterMs(err, now);
  if (asked !== undefined) return Math.round(asked);
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (random() * 2 - 1) * JITTER;
  return Math.round(Math.min(MAX_DELAY_MS, base * jitter));
}

/** "5 min", "2 h": a long wait in the words of the notice */
export function waitWords(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  return min < 120 ? `${min} min` : `${Math.ceil(min / 60)} h`;
}

/** The status line while waiting: `Connection lost. Retrying in 4 s (2 of 6).` */
export function retryStatusText(err: unknown, delayMs: number, nextAttempt: number): string {
  const what = isBusy(err) ? 'Provider busy.' : 'Connection lost.';
  return `${what} Retrying in ${Math.max(1, Math.ceil(delayMs / 1000))} s (${nextAttempt} of ${MAX_ATTEMPTS}).`;
}

/** A wait that a fired signal ends at once (rejecting with an AbortError). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
    if (signal.aborted) return reject(aborted());
    const done = () => {
      signal.removeEventListener('abort', stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      reject(aborted());
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** The clock of the loop; tests replace its parts (a sleep that returns at once, a fixed random, a short idle limit). */
export const retryTiming = {
  sleep: abortableSleep as (ms: number, signal: AbortSignal) => Promise<void>,
  random: Math.random as () => number,
  now: Date.now as () => number,
  idleMs: STREAM_IDLE_MS,
};

export interface RetryHooks {
  /** Waiting `delayMs` before attempt `next`: the status line says so */
  onWait(text: string, delayMs: number, next: number): void;
  /** The waiting is over (the reply started, or the loop ended): the status line goes back */
  onClear(): void;
}

/**
 * Runs `attempt` until it succeeds, fails in a way another try would not mend, or MAX_ATTEMPTS have failed (then
 * RetryGaveUp, which says so). A user Stop during a wait ends it at once with an AbortError.
 */
export async function withRetries<T>(attempt: (n: number) => Promise<T>, signal: AbortSignal, hooks: RetryHooks): Promise<T> {
  let waiting = false;
  const clear = () => {
    if (!waiting) return;
    waiting = false;
    hooks.onClear();
  };
  try {
    for (let n = 1; ; n++) {
      try {
        return await attempt(n);
      } catch (err) {
        if (signal.aborted || !isRetryable(err)) throw err;
        const delay = retryDelayMs(n, err, retryTiming.random, retryTiming.now());
        if (delay > MAX_RETRY_AFTER_MS) throw new RetryGaveUp(`${statusOf(err) === 429 ? 'Rate limited.' : 'Provider busy.'} Try again in ${waitWords(delay)}.`, err);
        if (n >= MAX_ATTEMPTS) throw new RetryGaveUp(`Could not reach the provider after ${MAX_ATTEMPTS} tries:`, err);
        waiting = true;
        hooks.onWait(retryStatusText(err, delay, n + 1), delay, n + 1);
        await retryTiming.sleep(delay, signal);
      }
    }
  } finally {
    clear();
  }
}

/**
 * A signal for one attempt of a streamed call: aborted with the run's signal, or when no chunk came for
 * retryTiming.idleMs (then `idled()` is true and the caller throws StreamDropped). `touch()` on every chunk.
 */
export function idleWatch(run: AbortSignal, idleMs = retryTiming.idleMs): { signal: AbortSignal; ms: number; touch(): void; idled(): boolean; done(): void } {
  const ctl = new AbortController();
  let idled = false;
  let timer: NodeJS.Timeout | undefined;
  const onRun = () => ctl.abort();
  if (run.aborted) ctl.abort();
  else run.addEventListener('abort', onRun, { once: true });
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      idled = true;
      ctl.abort();
    }, idleMs);
  };
  arm();
  return {
    signal: ctl.signal,
    ms: idleMs,
    touch: arm,
    idled: () => idled && !run.aborted,
    done: () => {
      if (timer) clearTimeout(timer);
      run.removeEventListener('abort', onRun);
    },
  };
}
