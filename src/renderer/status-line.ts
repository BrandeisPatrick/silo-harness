// The status line above the composer: the run (spinner, verb, elapsed time, tokens, esc) or, after a plan, a quiet
// line with the keys; the compaction status while the conversation is summarised (/compact, "Compact now" and the
// automatic one inside a run); a long silence from the model ("No output for 45 s", counting up); the spinners' one
// shared timer; and the context meter.

import type { AppConfig, PermissionMode, SiloHarnessApi } from '../shared/types';
import { createContextMeter, normalizeContext } from './context.js';
import { byId, formatCount } from './dom.js';
import { activeProvider } from './provider-view.js';
import { elapsedText as elapsed } from './turn-fold-model.js';

export interface StatusLineDeps {
  /** The context meter's popover stays inside this element */
  boundary: HTMLElement;
  api: Pick<SiloHarnessApi, 'compact' | 'context'>;
  config(): AppConfig | undefined;
  currentMode(): PermissionMode;
  composerHasContent(): boolean;
  /** The newest plan card still waits for a decision, and nothing but quiet notices follows it */
  planPending(): boolean;
  planIsLast(): boolean;
  /** "Start Ollama" ran and Ollama has not answered yet: the spinners turn for it */
  startingOllama(): boolean;
  /** What follows a run starting or ending (the composer, the rewind buttons, the sidebar's status, the last run of calls) */
  updateSendButton(): void;
  syncPlaceholder(): void;
  syncBusyUi(): void;
  setRunningStatus(v: boolean): void;
  updateLastGroup(): void;
  refreshSessions(): Promise<unknown>;
  openSettings(section?: string): void;
  systemMessage(text: string, kind: 'error'): void;
  cleanError(err: unknown): string;
}

export function createStatusLine({ boundary, api, config, currentMode, composerHasContent, planPending, planIsLast, startingOllama, updateSendButton, syncPlaceholder, syncBusyUi, setRunningStatus, updateLastGroup, refreshSessions, openSettings, systemMessage, cleanError }: StatusLineDeps) {
  const statusLine = byId('status-line');
  const statusText = byId('status-text');
  const statusTime = byId('status-time');
  const statusTokens = byId('status-tokens');
  /** The session's estimated cost, beside the tokens (a 'cost' event; nothing when a model has no price) */
  const statusCost = byId('status-cost');
  let costLabel = '';
  const statusHint = byId('status-hint');

  /** A run is going on in the session on screen */
  let running = false;
  let runStartedAt = 0;
  let timer: number | undefined;
  let runOutputTokens = 0;

  // The status line: the run (spinner, verb, elapsed, tokens, esc) or, after a plan, a quiet line with the keys.
  type StatusState = 'off' | 'run' | 'plan-ready' | 'plan-wait';
  let statusState: StatusState = 'off';
  let statusTimer: number | undefined;

  function setStatus(state: StatusState, text?: string): void {
    statusState = state;
    window.clearTimeout(statusTimer);
    statusLine.hidden = state === 'off';
    statusLine.classList.toggle('idle', state !== 'run');
    statusHint.hidden = state !== 'plan-wait' || composerHasContent();
    if (text !== undefined) statusText.textContent = text;
  }

  function setStatusText(text: string): void {
    // While a silence is shown it keeps the line; the text comes back when it ends
    if (silence) {
      silence.under = text;
      return;
    }
    if (statusState === 'run' && statusText.textContent !== text) statusText.textContent = text;
  }

  // ---------- A long silence from the model (stream_idle, agent/progress.ts) ----------

  /**
   * No content from the model for 30 s or more: the line counts up from `since` until content comes again, with when
   * the connection is tried again (`dropMs`) or, while keep-alive data arrives, that it is still connected. `under` is
   * the text it covers, put back when it ends.
   */
  let silence: { since: number; dropMs?: number; pings: boolean; under: string } | null = null;

  /** "45 s", "2 min 05 s" */
  function silenceTime(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  }

  function silenceText(): string {
    if (!silence) return '';
    const tail = silence.pings ? ' · still connected' : silence.dropMs ? ` · retries at ${Math.max(1, Math.round(silence.dropMs / 60_000))} min` : '';
    return `No output for ${silenceTime(Date.now() - silence.since)}${tail}`;
  }

  function paintSilence(): void {
    if (silence && statusState === 'run') statusText.textContent = silenceText();
  }

  /** A stream_idle event: a silence of `ms` so far, or (null) content came again or the attempt ended. */
  function setSilence(s: { ms: number; dropMs?: number; pings?: boolean } | null): void {
    if (!s) {
      if (!silence) return;
      const under = silence.under;
      silence = null;
      statusLine.classList.remove('silent');
      if (statusState === 'run') statusText.textContent = under || baseVerb();
      return;
    }
    const under = silence?.under ?? statusText.textContent ?? baseVerb();
    silence = { since: Date.now() - Math.max(0, Number(s.ms) || 0), dropMs: typeof s.dropMs === 'number' && s.dropMs > 0 ? s.dropMs : undefined, pings: s.pings === true, under };
    statusLine.classList.add('silent');
    paintSilence();
  }

  /** "Working…", or "Planning…" in plan mode */
  function baseVerb(): string {
    return currentMode() === 'plan' ? 'Planning…' : 'Working…';
  }

  function showPlanReady(): void {
    setStatus('plan-ready', 'Plan ready for review');
    statusTimer = window.setTimeout(() => {
      if (statusState !== 'plan-ready') return;
      if (planPending() && planIsLast()) setStatus('plan-wait', 'Waiting for plan approval');
      else setStatus('off');
    }, 2500);
  }

  /** Ends the plan status line once the plan was decided elsewhere. */
  function syncPlanStatus(): void {
    if ((statusState === 'plan-ready' || statusState === 'plan-wait') && !planPending()) setStatus('off');
  }

  /**
   * Spinners rotate through one 8-per-second timer and a CSS variable instead of CSS animations: Chromium ticks a
   * running animation on every frame whether or not it changes, which costs a few percent of CPU for the whole run.
   */
  let spinTimer: number | undefined;
  let spinStep = 0;
  function syncSpin(): void {
    const want = (running || compacting !== null || startingOllama()) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (want && spinTimer === undefined) {
      spinTimer = window.setInterval(() => {
        spinStep = (spinStep + 1) % 12;
        // Set on each spinner, never on the document: a root-level change recalculates styles for the whole transcript.
        const deg = `${spinStep * 30}deg`;
        document.querySelectorAll<HTMLElement>('.spinner, .tool-status.spin, .group-icon.spin').forEach((el) => el.style.setProperty('--spin', deg));
      }, 125);
    } else if (!want && spinTimer !== undefined) {
      window.clearInterval(spinTimer);
      spinTimer = undefined;
    }
  }

  /** The session on screen started or stopped running; `startedAt` is when a run this window joined late began. */
  function setRunning(v: boolean, startedAt = Date.now()): void {
    running = v;
    updateSendButton();
    syncPlaceholder();
    syncBusyUi();
    syncSpin();
    setRunningStatus(v);
    // The last run of calls is live while a run goes on (a session brought on screen mid-run, too)
    updateLastGroup();
    // A silence belonged to the run before (or to the session that was on screen)
    silence = null;
    statusLine.classList.remove('silent');
    if (v) {
      runStartedAt = startedAt;
      setStatus('run', baseVerb());
      statusTime.textContent = elapsed(Date.now() - runStartedAt);
      statusTokens.hidden = true;
      statusCost.hidden = true;
      costLabel = '';
      runOutputTokens = 0;
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        statusTime.textContent = elapsed(Date.now() - runStartedAt);
        paintSilence();
      }, 1000);
    } else {
      if (statusState === 'run') setStatus('off');
      if (timer) {
        window.clearInterval(timer);
        timer = undefined;
      }
    }
    void refreshSessions();
  }

  // ---------- Compaction: the status line while the conversation is summarised, /compact and "Compact now" ----------

  const COMPACTING_TEXT = 'Compacting context…';
  /**
   * A compaction in progress. standalone: started outside a run (/compact, "Compact now"), so the status line is
   * shown for it alone (with its own elapsed time and the stop button, since abort cancels it) without counting as
   * a run. Otherwise it is an auto-compaction inside a run, which only swaps the status text until it ends.
   */
  let compacting: { reason: 'auto' | 'manual'; standalone: boolean; prevText: string } | null = null;
  /** Set when a compact_end with an error arrives, so oc.compact()'s own error is not shown a second time */
  let compactErrorShown = false;

  function startCompaction(reason: 'auto' | 'manual'): void {
    if (running) {
      const prev = statusText.textContent ?? '';
      compacting = { reason, standalone: false, prevText: prev && prev !== COMPACTING_TEXT ? prev : baseVerb() };
      setStatusText(COMPACTING_TEXT);
    } else {
      compacting = { reason, standalone: true, prevText: '' };
      runStartedAt = Date.now();
      setStatus('run', COMPACTING_TEXT);
      statusTime.textContent = '0s';
      statusTokens.hidden = true;
      statusCost.hidden = true;
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        statusTime.textContent = elapsed(Date.now() - runStartedAt);
      }, 1000);
    }
    statusLine.classList.add('compacting');
    syncBusyUi();
    syncSpin();
  }

  function endCompaction(): void {
    const c = compacting;
    compacting = null;
    statusLine.classList.remove('compacting');
    syncBusyUi();
    syncSpin();
    if (!c) return;
    if (running) {
      // The previous verb comes back (the next event of the run replaces it as usual).
      if (statusText.textContent === COMPACTING_TEXT) setStatusText(c.prevText || baseVerb());
      return;
    }
    if (statusState === 'run') setStatus('off');
    if (timer) {
      window.clearInterval(timer);
      timer = undefined;
    }
  }

  /** /compact and the context meter's "Compact now": failures show as an error notice in the transcript. */
  async function compactNow(focus?: string): Promise<void> {
    if (typeof api.compact !== 'function') {
      systemMessage('Compacting needs the updated app. Restart Silo Harness.', 'error');
      return;
    }
    compactErrorShown = false;
    let res: { ok: boolean; error?: string };
    try {
      const r = await api.compact(focus || undefined);
      res = r && typeof r === 'object' ? r : { ok: false, error: 'The app did not answer.' };
    } catch (err) {
      res = { ok: false, error: cleanError(err) };
    }
    if (!res.ok && !compactErrorShown) systemMessage(res.error || "Couldn't compact the conversation.", 'error');
  }

  /** The context meter: from 'context' events, oc.context() after a reload or session switch, and the debug hook. */
  const contextMeter = createContextMeter({
    button: byId<HTMLButtonElement>('context-meter'),
    boundary,
    busy: () => running || compacting !== null,
    compact: () => void compactNow(),
    openSettings: () => openSettings(config()?.provider === 'portkey' ? 'portkey-contextWindow' : config()?.provider === 'ollama' ? 'ollama-numCtx' : 'provider'),
  });

  async function refreshContext(): Promise<void> {
    if (typeof api.context !== 'function') return;
    try {
      contextMeter.set(normalizeContext(await api.context()));
    } catch {
      /* no session yet, or an older app: the meter waits for a context event */
    }
  }

  /** The context window the status line's token counter compares against. */
  function contextLimit(): number {
    const known = contextMeter.get()?.limit;
    if (known) return known;
    const cfg = config();
    if (!cfg) return 0;
    return Number(activeProvider(cfg).contextWindow) || 0;
  }

  /** A usage event: the token counter (the context so far, and this run's output in its tooltip) */
  function reportUsage(prompt: number, completion: number): void {
    runOutputTokens += completion;
    const context = prompt + completion;
    const limit = contextLimit();
    statusTokens.textContent = `${formatCount(context)} tokens`;
    statusTokens.dataset.tip = `Context ${formatCount(context)}${limit ? ` of ${formatCount(limit)}` : ''} · Output ${formatCount(runOutputTokens)} this run`;
    statusTokens.classList.toggle('near-limit', limit > 0 && context / limit >= 0.85);
    statusTokens.hidden = !running;
    statusCost.hidden = !running || !costLabel;
  }

  /** A cost event: the session's estimate so far ("$0.04"), or none (a model of the session has no price). */
  function reportCost(label: string | undefined): void {
    costLabel = label ?? '';
    statusCost.textContent = costLabel;
    statusCost.hidden = !running || statusTokens.hidden || !costLabel;
  }

  return {
    running: () => running,
    /** The compaction in progress, if any */
    compacting: () => compacting,
    state: () => statusState,
    /** The plan hint under the status line hides while the composer has content */
    syncPlanHint: () => {
      if (statusState === 'plan-wait') statusHint.hidden = composerHasContent();
    },
    setStatus,
    setStatusText,
    /** The verb under a silence, or the line's text */
    statusText: () => silence?.under ?? statusText.textContent ?? '',
    setSilence,
    baseVerb,
    showPlanReady,
    syncPlanStatus,
    syncSpin,
    setRunning,
    startCompaction,
    endCompaction,
    /** The run ended: an auto-compaction belonged to it (its compact_end, if one still comes, only adds the divider or error) */
    dropRunCompaction: () => {
      if (compacting && !compacting.standalone) {
        compacting = null;
        statusLine.classList.remove('compacting');
      }
    },
    /** Another session comes on screen: the compaction status of the one before goes with it */
    dropCompaction: () => {
      if (compacting) {
        compacting = null;
        statusLine.classList.remove('compacting');
      }
    },
    reportUsage,
    reportCost,
    /** A compact_end with an error arrived: compactNow's own error is not shown a second time */
    compactFailed: () => {
      compactErrorShown = true;
    },
    compactNow,
    contextMeter,
    refreshContext,
  };
}
