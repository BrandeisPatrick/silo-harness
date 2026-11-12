// What the window is told while a model request streams (agent/complete.ts, agent/anthropic.ts), so a long step does
// not look like a stuck one:
//   input_progress  the model is writing a tool call's input: the tool's name and the characters so far, as soon as the
//                   name is known and then at most once every PROGRESS_EVERY_MS
//   stream_idle     no content (thinking, text, a tool call's input) for SILENCE_MS or more; the window counts up from
//                   there until content comes again or the attempt ends (then ms: null)
// Keep-alive data from the provider is not content: it only says the connection is open, which the window reads as
// "still connected" instead of the time at which a silent stream is dropped. Nothing here changes the request: the
// idle limit, the retries and the timeouts stay agent/retry.ts's.
//
// Numbers and the tool's name only, never its input. Pure apart from the timer; the clock is injectable.

import type { AgentEvent } from '../../shared/types';

/** At most one input_progress per this many ms (the first one for a call goes out at once) */
export const PROGRESS_EVERY_MS = 1000;
/** A silence this long with no content is shown */
export const SILENCE_MS = 30_000;
/** Once a silence is shown, how often it is looked at again (keep-alive data starting or stopping) */
export const RECHECK_MS = 5000;
/** The limits in use; tests shorten them (as agent/retry.ts retryTiming), nothing else changes them */
export const progressTiming = { everyMs: PROGRESS_EVERY_MS, silenceMs: SILENCE_MS, recheckMs: RECHECK_MS };

/** What the stream paths tell about a request as it streams (CompletionHost.activity). */
export interface StreamProgress {
  /** Any event or chunk from the provider, keep-alive data included */
  event(): void;
  /** Content that is not text or thinking (those come through the host's emit): a thinking signature, a block's start */
  content(): void;
  /** This attempt's stream is dropped after `ms` with no data at all (agent/retry.ts idleWatch); undefined: never */
  dropAfter(ms: number | undefined): void;
  /** A tool call's input grew: call `index` of the reply, its name (empty until known), `added` characters */
  toolInput(index: number, name: string, added: number): void;
}

export interface ActivityClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: ActivityClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    // Never what keeps the process alive
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** One model call's activity: start() at each attempt, stop() when it ends. */
export class StreamActivity implements StreamProgress {
  private live = false;
  private lastContentAt = 0;
  private lastEventAt = 0;
  private dropMs: number | undefined;
  private timer: unknown = null;
  /** The silence on screen, and whether it said keep-alive data was arriving */
  private shown: { pings: boolean } | null = null;
  private calls = new Map<number, { name: string; chars: number }>();
  private lastProgressAt = -Infinity;
  private lastProgressCall = -1;

  constructor(
    private readonly emit: (ev: AgentEvent) => void,
    private readonly clock: ActivityClock = realClock,
    private readonly silenceMs = progressTiming.silenceMs,
    private readonly everyMs = progressTiming.everyMs,
    private readonly recheckMs = progressTiming.recheckMs,
  ) {}

  /** An attempt went out: the silence counts from now. */
  start(): void {
    this.stop();
    const t = this.clock.now();
    this.live = true;
    this.lastContentAt = this.lastEventAt = t;
    this.dropMs = undefined;
    this.calls.clear();
    this.lastProgressAt = -Infinity;
    this.lastProgressCall = -1;
    this.arm(this.silenceMs);
  }

  dropAfter(ms: number | undefined): void {
    this.dropMs = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
  }

  event(): void {
    if (this.live) this.lastEventAt = this.clock.now();
  }

  content(): void {
    if (!this.live) return;
    const t = this.clock.now();
    this.lastContentAt = t;
    if (t > this.lastEventAt) this.lastEventAt = t;
    this.clearShown();
  }

  toolInput(index: number, name: string, added: number): void {
    if (!this.live) return;
    this.content();
    let call = this.calls.get(index);
    if (!call) this.calls.set(index, (call = { name: '', chars: 0 }));
    if (typeof name === 'string' && name) call.name = name;
    if (typeof added === 'number' && Number.isFinite(added) && added > 0) call.chars += added;
    if (!call.name) return;
    const t = this.clock.now();
    if (index === this.lastProgressCall && t - this.lastProgressAt < this.everyMs) return;
    this.lastProgressAt = t;
    this.lastProgressCall = index;
    this.emit({ type: 'input_progress', name: call.name, chars: call.chars });
  }

  /** The attempt ended (answered, failed or stopped): a silence on screen is cleared. */
  stop(): void {
    this.live = false;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.clearShown();
  }

  private clearShown(): void {
    if (!this.shown) return;
    this.shown = null;
    this.emit({ type: 'stream_idle', ms: null });
  }

  private arm(delay: number): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => this.look(), Math.max(0, delay));
  }

  private look(): void {
    this.timer = null;
    if (!this.live) return;
    const t = this.clock.now();
    const silent = t - this.lastContentAt;
    if (silent < this.silenceMs) return this.arm(this.lastContentAt + this.silenceMs - t);
    // Keep-alive data is arriving: some came after the last content, within half the silence limit (one early event
    // with no content, such as the reply's start, is not a stream of keep-alive data)
    const pings = this.lastEventAt > this.lastContentAt && t - this.lastEventAt < this.silenceMs / 2;
    if (!this.shown || this.shown.pings !== pings) {
      this.shown = { pings };
      this.emit({ type: 'stream_idle', ms: silent, ...(this.dropMs !== undefined ? { dropMs: this.dropMs } : {}), ...(pings ? { pings: true } : {}) });
    }
    this.arm(this.recheckMs);
  }
}
