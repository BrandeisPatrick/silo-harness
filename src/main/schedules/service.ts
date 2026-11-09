// The scheduler: owns the list, fires due schedules on a timer, follows the runs it started through app.events,
// and catches up once on runs missed while the app was closed (or asleep).

import { randomBytes } from 'node:crypto';
import type { App, Disposer } from '../app';
import type { SchedulesService } from '../services';
import type { Schedule, ScheduleInput, SchedulePatch, ScheduleRun, ScheduleWhen } from '../../shared/schedules';
import type { AgentEvent } from '../../shared/types';
import { ScheduleError } from './errors';
import { ScheduleStore } from './store';
import { describeWhen, firstRun, isRecurring, nextAfter, normalizeWhen, occursBetween } from './when';

export const MAX_SCHEDULES = 50;
export const MAX_NAME = 80;
export const MAX_PROMPT = 8000;
/** A run missed by less than this still happens (once); older ones are marked missed */
export const CATCH_UP_MS = 24 * 60 * 60_000;
export const TICK_MS = 15_000;
/** Runs kept on a schedule (its History); older ones drop off, their sessions stay */
export const MAX_HISTORY = 100;

export interface SchedulerOptions {
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  tickMs?: number;
  store?: ScheduleStore;
}

/** Extra fields only the tools set: where a run goes when it moves to the calling session */
export interface InternalPatch extends SchedulePatch {
  sessionId?: string;
}

export interface Scheduler extends SchedulesService {
  /** Checks for due schedules now (the timer calls this) */
  tick(): void;
  get(id: string): Schedule | undefined;
  createWith(input: ScheduleInput, by: 'user' | 'agent', createdInSession?: string): Schedule;
  updateWith(id: string, patch: InternalPatch): Schedule;
  /** A rhythm validated and described, without storing anything (for the approval card) */
  preview(when: ScheduleWhen): { when: ScheduleWhen; describe: string; nextRunAt: number | null };
  /** The schedule an input or a patch would produce; throws what createWith / updateWith would, stores nothing */
  checkCreate(input: ScheduleInput, by: 'user' | 'agent'): Schedule;
  checkUpdate(id: string, patch: InternalPatch): Schedule;
  dispose(): void;
}

const runStatus: Record<Extract<AgentEvent, { type: 'run_end' }>['reason'], Schedule['lastStatus']> = {
  done: 'ok',
  // Plan mode ends a run by proposing a plan for the user: the schedule did its part
  plan: 'ok',
  aborted: 'stopped',
  error: 'error',
  max_turns: 'error',
};

/** The message a run receives: says where it came from so the model does not take it for something just typed. */
export function frameMessage(s: Pick<Schedule, 'name' | 'describe' | 'prompt'>): string {
  return [
    `[Scheduled task "${s.name}" (${s.describe}). This message was sent automatically by a schedule the user approved earlier; the user did not type it just now.]`,
    'Carry out the task below, then end with a short report of what you did and what you found.',
    '',
    s.prompt,
  ].join('\n');
}

function checkText(name: string, prompt: string): { name: string; prompt: string } {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  const p = String(prompt ?? '').trim();
  if (!p) throw new ScheduleError('bad_input', 'prompt is empty: say what the run should do.');
  if (p.length > MAX_PROMPT) throw new ScheduleError('too_long', `the prompt is ${p.length} characters; the limit is ${MAX_PROMPT}.`);
  if (n.length > MAX_NAME) throw new ScheduleError('too_long', `the name is ${n.length} characters; the limit is ${MAX_NAME}.`);
  // A schedule without a name is named after the start of its prompt
  return { name: n || p.replace(/\s+/g, ' ').slice(0, 40), prompt: p };
}

export function createScheduler(app: App, opts: SchedulerOptions = {}): Scheduler {
  const now = opts.now ?? Date.now;
  const store = opts.store ?? new ScheduleStore(`${app.userData}/schedules.json`);
  const list: Schedule[] = store.load();
  /** Schedule id → the session its current run went to; cleared by that session's run_end */
  const inflight = new Map<string, string>();
  const disposers: Disposer[] = [];

  // The app quit (or crashed) during these runs; their outcome is unknown
  for (const s of list) {
    if (s.lastStatus === 'running') s.lastStatus = 'stopped';
    for (const r of s.history ?? []) if (r.status === 'running') r.status = 'stopped';
  }

  const copy = (s: Schedule): Schedule => ({ ...s, when: { ...s.when }, ...(s.history ? { history: s.history.map((r) => ({ ...r })) } : {}) });
  const snapshot = () => list.map(copy);
  const changed = () => {
    try {
      store.save(list);
    } catch (err) {
      console.warn('[schedules] could not save:', err);
    }
    app.push('schedules:changed', snapshot());
  };
  const find = (id: string): Schedule => {
    const s = list.find((x) => x.id === id);
    if (!s) throw new ScheduleError('not_found', `no schedule with id "${id}". schedule_list shows the ids.`);
    return s;
  };
  const newId = () => {
    let id: string;
    do id = `sch_${randomBytes(3).toString('hex')}`;
    while (list.some((s) => s.id === id));
    return id;
  };

  const going = (s: Schedule): boolean => {
    const sid = inflight.get(s.id);
    if (!sid) return false;
    // A run whose end we never heard of (the session was deleted mid-run) must not block the schedule forever
    if (!app.runtime.isRunning(sid)) {
      inflight.delete(s.id);
      return false;
    }
    return true;
  };

  /** Sends one run, or records why it could not (skipped, session gone, send refused) in lastStatus. */
  /** The session the window shows, when there is one. */
  const onScreen = (): string | undefined => {
    try {
      return app.runtime.foregroundId() || undefined;
    } catch {
      return undefined;
    }
  };

  function fire(s: Schedule, at: number): void {
    if (going(s)) {
      s.lastStatus = 'skipped';
      return;
    }
    let sessionId: string;
    if (s.target === 'session') {
      if (!s.sessionId || !app.store.get(s.sessionId)) {
        s.enabled = false;
        s.nextRunAt = null;
        s.lastStatus = 'error';
        return;
      }
      sessionId = s.sessionId;
    } else {
      sessionId = app.runtime.create({ cwd: s.cwd, origin: 'schedule', title: s.name, foreground: false }).id;
    }
    // Recorded before sending: a runtime may emit run_start / run_end while send() is still on the stack
    inflight.set(s.id, sessionId);
    s.lastRunAt = at;
    s.lastSessionId = sessionId;
    s.lastStatus = 'running';
    s.runs += 1;
    const run: ScheduleRun = { at, sessionId, status: 'running', ...(s.target === 'session' ? { continued: true } : {}) };
    s.history = [...(s.history ?? []), run].slice(-MAX_HISTORY);
    const res = app.runtime.send(sessionId, frameMessage(s), [], { origin: 'schedule', from: s.name });
    if (!res.ok) {
      inflight.delete(s.id);
      s.lastStatus = 'error';
      run.status = 'error';
      run.error = res.error ?? 'It could not start.';
      console.warn(`[schedules] "${s.name}" could not start: ${res.error ?? 'unknown error'}`);
    }
  }

  /** Fires (or marks missed) one due schedule and moves its next run on. */
  function handleDue(s: Schedule, t: number): void {
    const due = s.nextRunAt!;
    if (!isRecurring(s.when)) {
      if (t - due < CATCH_UP_MS) fire(s, t);
      else s.lastStatus = 'missed';
      s.enabled = false;
      s.nextRunAt = null;
      return;
    }
    // At most one catch-up run, and only for an occurrence less than a day old
    if (occursBetween(s.when, due, t - CATCH_UP_MS, t)) fire(s, t);
    else s.lastStatus = 'missed';
    if (s.enabled) s.nextRunAt = nextAfter(s.when, due, t);
  }

  function tick(): void {
    const t = now();
    let any = false;
    for (const s of list) {
      if (!s.enabled || s.nextRunAt === null || s.nextRunAt > t) continue;
      handleDue(s, t);
      any = true;
    }
    if (any) changed();
  }

  function onEvent(sessionId: string, ev: AgentEvent): void {
    if (ev.type !== 'run_end') return;
    let any = false;
    for (const [id, sid] of inflight) {
      if (sid !== sessionId) continue;
      inflight.delete(id);
      const s = list.find((x) => x.id === id);
      if (!s) continue;
      s.lastStatus = runStatus[ev.reason] ?? 'error';
      s.lastSessionId = sessionId;
      const run = [...(s.history ?? [])].reverse().find((r) => r.sessionId === sessionId && r.status === 'running');
      if (run) run.status = s.lastStatus === 'ok' ? 'ok' : s.lastStatus === 'stopped' ? 'stopped' : 'error';
      any = true;
    }
    if (any) changed();
  }

  function build(input: ScheduleInput, by: 'user' | 'agent', createdInSession?: string): Schedule {
    const t = now();
    if (list.length >= MAX_SCHEDULES) throw new ScheduleError('too_many', `there are already ${MAX_SCHEDULES} schedules; delete one first.`);
    const { name, prompt } = checkText(input.name, input.prompt);
    const when = normalizeWhen(input.when, t);
    const target = input.target ?? (isRecurring(when) ? 'new' : 'session');
    if (target !== 'new' && target !== 'session') throw new ScheduleError('bad_input', `target must be "new" or "session", not "${target}".`);
    // No session named: the one on screen (a mod without session access, or the window, cannot always name it).
    const sessionId = target === 'session' ? input.sessionId || onScreen() : undefined;
    if (target === 'session' && !sessionId) throw new ScheduleError('bad_input', 'a schedule that runs in an existing session needs that session.');
    const enabled = input.enabled !== false;
    return {
      id: newId(),
      name,
      prompt,
      when,
      target,
      ...(target === 'session' ? { sessionId } : {}),
      cwd: input.cwd || app.config().workingDirectory,
      enabled,
      createdAt: t,
      createdBy: by,
      ...(createdInSession ? { createdInSession } : {}),
      nextRunAt: enabled ? firstRun(when, t) : null,
      runs: 0,
      describe: describeWhen(when, t),
    };
  }

  /** The schedule after a patch, validated; the original is left alone */
  function patched(s: Schedule, patch: InternalPatch): Schedule {
    const t = now();
    const next: Schedule = { ...s, when: { ...s.when } };
    if (patch.name !== undefined || patch.prompt !== undefined) {
      const text = checkText(patch.name ?? s.name, patch.prompt ?? s.prompt);
      next.name = text.name;
      next.prompt = text.prompt;
    }
    if (patch.target !== undefined) {
      if (patch.target !== 'new' && patch.target !== 'session') throw new ScheduleError('bad_input', `target must be "new" or "session", not "${patch.target}".`);
      next.target = patch.target;
    }
    if (patch.sessionId !== undefined) next.sessionId = patch.sessionId;
    if (next.target === 'session' && !next.sessionId) next.sessionId = onScreen();
    if (next.target === 'session' && !next.sessionId) throw new ScheduleError('bad_input', 'a schedule that runs in an existing session needs that session.');
    if (next.target === 'new') delete next.sessionId;
    const whenChanged = patch.when !== undefined;
    if (whenChanged) next.when = normalizeWhen(patch.when!, t);
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    // Re-timing or re-enabling starts the rhythm from now; a one-shot whose time has passed cannot come back
    if (!next.enabled) next.nextRunAt = null;
    else if (whenChanged || !s.enabled || s.nextRunAt === null) {
      if (!whenChanged) normalizeWhen(next.when, t);
      next.nextRunAt = firstRun(next.when, t);
    }
    next.describe = describeWhen(next.when, t);
    return next;
  }

  const svc: Scheduler = {
    list: snapshot,
    get: (id) => {
      const s = list.find((x) => x.id === id);
      return s ? copy(s) : undefined;
    },
    create: (input, by) => svc.createWith(input, by),
    createWith(input, by, createdInSession) {
      const s = build(input, by, createdInSession);
      list.push(s);
      changed();
      return { ...s };
    },
    update: (id, patch) => svc.updateWith(id, patch),
    updateWith(id, patch) {
      const s = find(id);
      const next = patched(s, patch);
      for (const k of Object.keys(s) as (keyof Schedule)[]) if (!(k in next)) delete s[k];
      Object.assign(s, next);
      changed();
      return copy(s);
    },
    checkCreate: (input, by) => build(input, by),
    checkUpdate: (id, patch) => patched(find(id), patch),
    remove(id) {
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) throw new ScheduleError('not_found', `no schedule with id "${id}". schedule_list shows the ids.`);
      list.splice(i, 1);
      inflight.delete(id);
      changed();
    },
    runNow(id) {
      const s = find(id);
      // Out of rhythm: the next scheduled time stays as it was
      fire(s, now());
      changed();
      return copy(s);
    },
    preview(when) {
      const t = now();
      const w = normalizeWhen(when, t);
      return { when: w, describe: describeWhen(w, t), nextRunAt: firstRun(w, t) };
    },
    tick,
    dispose() {
      for (const d of disposers.splice(0)) d();
    },
  };

  disposers.push(app.events.on(onEvent));
  // Catch up on what was missed while the app was closed before the first timer tick
  tick();
  const setI = opts.setInterval ?? ((fn: () => void, ms: number) => {
    const h = setInterval(fn, ms);
    // The timer alone should not keep a process alive (matters for headless tests and quit)
    (h as { unref?: () => void }).unref?.();
    return h;
  });
  const clearI = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = setI(tick, opts.tickMs ?? TICK_MS);
  disposers.push(() => clearI(handle));
  return svc;
}
