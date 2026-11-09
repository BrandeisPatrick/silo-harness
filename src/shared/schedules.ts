// Scheduled tasks: prompts that run later or on a rhythm, created by the user or by the agent. Types only.

/**
 * at: once, at an ISO date-time with an offset ("2026-11-06T09:00:00-05:00").
 * every: repeatedly, every `minutes` (at least 5).
 * cron: a five-field cron expression in local time ("0 9 * * 1-5").
 */
export type ScheduleWhen = { kind: 'at'; at: string } | { kind: 'every'; minutes: number } | { kind: 'cron'; expr: string };

/** One run of a schedule: the session it created or continued, and how it went. */
export interface ScheduleRun {
  /** Unix ms when it fired */
  at: number;
  sessionId: string;
  /** running; ok (it ended); error (it failed, or could not start); stopped (by the user, or the app closed during it) */
  status: 'running' | 'ok' | 'error' | 'stopped';
  /** It went into a session that existed already (target 'session') instead of a new one */
  continued?: boolean;
  /** Why it could not start */
  error?: string;
}

export interface Schedule {
  id: string;
  name: string;
  /** What is sent when it fires */
  prompt: string;
  when: ScheduleWhen;
  /** new: every run gets a session of its own. session: it is delivered into `sessionId`, as a follow-up there. */
  target: 'new' | 'session';
  sessionId?: string;
  /** The folder runs work in */
  cwd: string;
  enabled: boolean;
  createdAt: number;
  createdBy: 'user' | 'agent';
  /** The session whose agent created it */
  createdInSession?: string;
  /** Unix ms of the next run; null when it will not run again */
  nextRunAt: number | null;
  lastRunAt?: number;
  /** skipped: the previous run was still going. missed: the app was closed for too long. */
  lastStatus?: 'running' | 'ok' | 'error' | 'stopped' | 'skipped' | 'missed';
  /** The session of the last run */
  lastSessionId?: string;
  runs: number;
  /** The runs that went to a session, oldest first (the last MAX_HISTORY); schedules from before 0.9 have none */
  history?: ScheduleRun[];
  /** "every 30 minutes", "weekdays at 09:00", "once on Nov 6 at 09:00" */
  describe: string;
}

export interface ScheduleInput {
  name: string;
  prompt: string;
  when: ScheduleWhen;
  target?: 'new' | 'session';
  /** With target 'session' and no id: the session on screen */
  sessionId?: string;
  cwd?: string;
  enabled?: boolean;
}

export type SchedulePatch = Partial<Pick<Schedule, 'name' | 'prompt' | 'when' | 'enabled' | 'target' | 'sessionId'>>;

export interface SchedulesRpc {
  'schedules.list': () => Schedule[];
  /** Created from the window, so no approval card: the user is the one asking */
  'schedules.create': (input: ScheduleInput) => Schedule;
  'schedules.update': (id: string, patch: SchedulePatch) => Schedule;
  'schedules.remove': (id: string) => Schedule[];
  /** Fires it now, whatever its time */
  'schedules.runNow': (id: string) => Schedule;
  /** A rhythm checked and described, and its first run from now; nothing is stored (the New task form's preview) */
  'schedules.preview': (when: ScheduleWhen) => { when: ScheduleWhen; describe: string; nextRunAt: number | null };
  /** The folder picker for a task's folder; null when cancelled. Unlike the top bar's, it leaves the working directory alone. */
  'schedules.chooseFolder': (defaultPath?: string) => string | null;
}

export interface SchedulesEvents {
  'schedules:changed': Schedule[];
}

/** Whether the Mac is being kept awake, and why. */
export interface PowerStatus {
  /** The setting: never, while a session is running, or whenever the app is open */
  mode: 'off' | 'running' | 'always';
  /** Sleep is being held off right now */
  active: boolean;
}

export interface PowerRpc {
  'power.status': () => PowerStatus;
}

export interface PowerEvents {
  'power:changed': PowerStatus;
}
