// The pure pieces of the Scheduled tasks and Dreaming pages: what a card says, the search, filter and sort of the
// lists, the starter templates, the New task form's rhythm (and back again for Edit), the words for a run and a
// dream project. Nothing here touches the DOM, so the headless suite (test/pages.js) loads the compiled file.

import type { Schedule, ScheduleRun, ScheduleWhen } from '../shared/schedules';
import type { Dream, DreamingConfig, DreamingState, DreamMode, DreamProject } from '../shared/dreaming';
import { formatWhenAt, localToIso, matchesQuery, type Parsed } from './settings/model.js';

// ---------- Words ----------

export const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The last part of a folder path ("shop" for "/Users/me/code/shop"). */
export function folderName(p: string): string {
  const parts = String(p ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] || p || '';
}

/** "Weekdays at 08:40", "Once on Nov 27 at 09:00", "Every 30 minutes" */
export function rhythmWords(s: Pick<Schedule, 'describe'>): string {
  return capitalize(s.describe || '');
}

/** Where each run goes: the chip on a card */
export function targetWords(s: Pick<Schedule, 'target'>): string {
  return s.target === 'session' ? 'Same session' : 'New session';
}

export type TaskState = 'running' | 'active' | 'paused' | 'done';

/** running: a run is going now. active: it will run. paused: turned off, could run again. done: a one-shot that ran (or was missed). */
export function taskState(s: Pick<Schedule, 'enabled' | 'nextRunAt' | 'when' | 'lastStatus' | 'runs'>, now = Date.now()): TaskState {
  if (s.lastStatus === 'running') return 'running';
  if (s.enabled && s.nextRunAt !== null) return 'active';
  if (s.when.kind === 'at') {
    const t = Date.parse(s.when.at);
    if (s.runs > 0 || s.lastStatus === 'missed' || !(t > now)) return 'done';
  }
  return 'paused';
}

export const TASK_STATE_WORDS: Record<TaskState, string> = { running: 'Running now', active: 'Active', paused: 'Paused', done: 'Done' };

/** The card's footer: "Active · Weekdays at 08:40", "Paused · Every day at 02:00", "Done · Once on Nov 27 at 09:00" */
export function taskFooter(s: Schedule, now = Date.now()): string {
  const st = taskState(s, now);
  const word = st === 'done' && s.lastStatus === 'missed' ? 'Missed' : TASK_STATE_WORDS[st];
  return `${word} · ${rhythmWords(s)}`;
}

/** The line under a task's title: when it runs next, or why it will not */
export function nextRunWords(s: Schedule, now = Date.now()): string {
  const st = taskState(s, now);
  if (st === 'running') return s.nextRunAt ? `Running now · next run ${lower(formatWhenAt(s.nextRunAt, now))}` : 'Running now';
  if (s.enabled && s.nextRunAt) return `Next run: ${formatWhenAt(s.nextRunAt, now)}`;
  if (st === 'done') return s.lastStatus === 'missed' ? 'Missed: Silo Harness was closed at the time' : s.lastRunAt ? `Ran ${lower(formatWhenAt(s.lastRunAt, now))}` : 'Will not run again';
  return 'Paused: it will not run until you turn it on';
}

const lower = (s: string) => s.replace(/^(Today|Tomorrow|Yesterday)/, (m) => m.toLowerCase());

// ---------- The list: search, filter, sort ----------

export type TaskFilter = 'all' | 'active' | 'paused';
export type TaskSort = 'next' | 'name' | 'last';

export const TASK_FILTERS: { value: TaskFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
];

export const TASK_SORTS: { value: TaskSort; label: string }[] = [
  { value: 'next', label: 'Next run' },
  { value: 'name', label: 'Name' },
  { value: 'last', label: 'Last run' },
];

/** The tasks a list shows: matching the search (name and prompt), passing the filter, in the order asked for. */
export function shownTasks(list: Schedule[], o: { query?: string; filter?: TaskFilter; sort?: TaskSort; now?: number } = {}): Schedule[] {
  const now = o.now ?? Date.now();
  const q = (o.query ?? '').trim();
  const filter = o.filter ?? 'all';
  const out = list.filter((s) => {
    if (q && !matchesQuery([s.name, s.prompt], q)) return false;
    const st = taskState(s, now);
    if (filter === 'active') return st === 'active' || st === 'running';
    if (filter === 'paused') return st === 'paused';
    return true;
  });
  const byName = (a: Schedule, b: Schedule) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.createdAt - b.createdAt;
  const sort = o.sort ?? 'next';
  if (sort === 'name') return out.sort(byName);
  if (sort === 'last') return out.sort((a, b) => (b.lastRunAt ?? -1) - (a.lastRunAt ?? -1) || byName(a, b));
  // Next run: the soonest first; those that will not run after them, by name
  return out.sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || byName(a, b));
}

// ---------- Templates ----------

export interface TaskTemplate {
  id: string;
  name: string;
  prompt: string;
  rhythm: Rhythm;
}

export const TEMPLATES: TaskTemplate[] = [
  {
    id: 'dependency-audit',
    name: 'Nightly dependency audit',
    prompt: "Check this project's dependencies for known vulnerabilities and for packages that are far behind (npm audit, pnpm audit, pip-audit or cargo audit, whichever the project uses). List what is affected, how serious it is, and the smallest safe upgrade. Do not change any files.",
    rhythm: { kind: 'daily', time: '02:00' },
  },
  {
    id: 'changelog-draft',
    name: 'Weekly changelog draft',
    prompt: 'Draft a changelog entry for what was merged this week: read the git log since last Friday, group the changes under Added, Changed and Fixed in plain words for users, and write the draft to CHANGELOG-draft.md for me to review. Do not commit.',
    rhythm: { kind: 'weekly', day: 5, time: '16:00' },
  },
  {
    id: 'morning-summary',
    name: 'Morning summary',
    prompt: 'Summarise what changed in this repository since yesterday morning: new commits and who made them, new branches, and work in progress. Keep it to a short list and point out anything that looks risky.',
    rhythm: { kind: 'weekdays', time: '08:30' },
  },
  {
    id: 'test-run',
    name: 'Daily test run',
    prompt: 'Run the test suite. If everything passes, say so in one line. If anything fails, list each failing test with its error and the most likely cause. Do not fix anything.',
    rhythm: { kind: 'daily', time: '07:00' },
  },
  {
    id: 'todo-sweep',
    name: 'Weekly TODO sweep',
    prompt: 'Find the TODO, FIXME and HACK comments added in the last seven days (git log -p --since="7 days ago"), and list each with its file, line and the commit that added it.',
    rhythm: { kind: 'weekly', day: 1, time: '09:00' },
  },
];

// ---------- The form's rhythm ----------

export type RhythmKind = 'once' | 'hourly' | 'interval' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron';

/** What the form holds; each kind reads the fields it needs */
export interface Rhythm {
  kind: RhythmKind;
  /** once: a datetime-local value, "2026-11-27T09:00" */
  at?: string;
  /** hourly: the minute past each hour */
  minute?: number;
  /** interval: every `every` `unit` */
  every?: number;
  unit?: 'minutes' | 'hours' | 'days';
  /** daily, weekdays, weekly, monthly: "HH:MM" */
  time?: string;
  /** weekly: 0 Sunday … 6 Saturday */
  day?: number;
  /** monthly: the day of the month, 1–28 */
  date?: number;
  /** cron: five fields */
  cron?: string;
}

export const RHYTHM_KINDS: { value: RhythmKind; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'interval', label: 'Every few minutes, hours or days' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'cron', label: 'Custom (cron)' },
];

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (n: number) => String(n).padStart(2, '0');

function hm(time: string | undefined): Parsed<[number, number]> {
  const m = TIME_RE.exec(String(time ?? '').trim());
  if (!m) return { ok: false, error: 'Pick a time.' };
  return { ok: true, value: [Number(m[1]), Number(m[2])] };
}

/** The ScheduleWhen a form describes; `now` for "in the future". */
export function rhythmToWhen(r: Rhythm, now = Date.now()): Parsed<ScheduleWhen> {
  switch (r.kind) {
    case 'once': {
      const iso = localToIso(r.at ?? '');
      if (!iso.ok) return iso;
      if (new Date(iso.value).getTime() <= now) return { ok: false, error: 'Pick a time in the future.' };
      return { ok: true, value: { kind: 'at', at: iso.value } };
    }
    case 'hourly': {
      const m = Number(r.minute);
      if (!Number.isInteger(m) || m < 0 || m > 59) return { ok: false, error: 'The minute is from 0 to 59.' };
      return { ok: true, value: { kind: 'cron', expr: `${m} * * * *` } };
    }
    case 'interval': {
      const n = Number(r.every);
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'Enter a whole number.' };
      const minutes = n * (r.unit === 'days' ? 1440 : r.unit === 'hours' ? 60 : 1);
      if (minutes < 5) return { ok: false, error: 'A task runs at most every 5 minutes.' };
      if (minutes > 366 * 1440) return { ok: false, error: 'At most a year apart; pick a rhythm with a date instead.' };
      return { ok: true, value: { kind: 'every', minutes } };
    }
    case 'daily':
    case 'weekdays':
    case 'weekly':
    case 'monthly': {
      const t = hm(r.time);
      if (!t.ok) return t;
      const [h, m] = t.value;
      if (r.kind === 'daily') return { ok: true, value: { kind: 'cron', expr: `${m} ${h} * * *` } };
      if (r.kind === 'weekdays') return { ok: true, value: { kind: 'cron', expr: `${m} ${h} * * 1-5` } };
      if (r.kind === 'weekly') {
        const d = Number(r.day);
        if (!Number.isInteger(d) || d < 0 || d > 6) return { ok: false, error: 'Pick a day.' };
        return { ok: true, value: { kind: 'cron', expr: `${m} ${h} * * ${d}` } };
      }
      const date = Number(r.date);
      if (!Number.isInteger(date) || date < 1 || date > 28) return { ok: false, error: 'The day of the month is from 1 to 28, so it runs every month.' };
      return { ok: true, value: { kind: 'cron', expr: `${m} ${h} ${date} * *` } };
    }
    case 'cron': {
      const expr = String(r.cron ?? '').trim().replace(/\s+/g, ' ');
      const fields = expr.split(' ');
      if (fields.length !== 5 || fields.some((f) => !/^[\d*/,\-A-Za-z]+$/.test(f))) return { ok: false, error: 'A cron rhythm has five fields: minute hour day month weekday, like 0 9 * * 1-5.' };
      return { ok: true, value: { kind: 'cron', expr } };
    }
  }
  return { ok: false, error: 'Pick when it runs.' };
}

/** "2026-11-27T09:00" for a moment, in local time (a datetime-local value). */
export function localValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The form for a stored rhythm (Edit); a cron the form has no kind for stays a custom cron. */
export function whenToRhythm(w: ScheduleWhen): Rhythm {
  if (w.kind === 'at') return { kind: 'once', at: localValue(Date.parse(w.at)) };
  if (w.kind === 'every') {
    const n = w.minutes;
    if (n % 1440 === 0) return { kind: 'interval', every: n / 1440, unit: 'days' };
    if (n % 60 === 0) return { kind: 'interval', every: n / 60, unit: 'hours' };
    return { kind: 'interval', every: n, unit: 'minutes' };
  }
  const f = w.expr.trim().split(/\s+/);
  const num = (s: string) => /^\d+$/.test(s);
  if (f.length === 5) {
    const [mi, h, dom, mon, dow] = f;
    if (num(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return { kind: 'hourly', minute: Number(mi) };
    if (num(mi) && num(h) && Number(h) < 24 && Number(mi) < 60) {
      const time = `${pad(Number(h))}:${pad(Number(mi))}`;
      if (dom === '*' && mon === '*' && dow === '*') return { kind: 'daily', time };
      if (dom === '*' && mon === '*' && dow === '1-5') return { kind: 'weekdays', time };
      if (dom === '*' && mon === '*' && /^[0-7]$/.test(dow)) return { kind: 'weekly', day: Number(dow) % 7, time };
      if (num(dom) && Number(dom) >= 1 && Number(dom) <= 28 && mon === '*' && dow === '*') return { kind: 'monthly', date: Number(dom), time };
    }
  }
  return { kind: 'cron', cron: w.expr };
}

/** A form with every field filled in for its kind, from what it has (so switching kinds keeps sensible values). */
export function fullRhythm(r: Partial<Rhythm>, now = Date.now()): Required<Rhythm> {
  const soon = new Date(now + 3_600_000);
  soon.setMinutes(0, 0, 0);
  return {
    kind: r.kind ?? 'daily',
    at: r.at ?? localValue(soon.getTime()),
    minute: r.minute ?? 0,
    every: r.every ?? 30,
    unit: r.unit ?? 'minutes',
    time: r.time ?? '09:00',
    day: r.day ?? 1,
    date: r.date ?? 1,
    cron: r.cron ?? '0 9 * * 1-5',
  };
}

// ---------- A task's runs ----------

export type RunState = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export const RUN_WORDS: Record<RunState, string> = { running: 'Running', waiting: 'Waiting for you', done: 'Done', failed: 'Failed', stopped: 'Stopped' };

/** The runs of a task, newest first; a task from before run history shows its last run alone. */
export function taskRuns(s: Schedule): ScheduleRun[] {
  if (s.history?.length) return [...s.history].reverse();
  if (s.lastSessionId && s.lastRunAt) {
    const st = s.lastStatus === 'ok' ? 'ok' : s.lastStatus === 'running' ? 'running' : s.lastStatus === 'stopped' ? 'stopped' : s.lastStatus === 'error' ? 'error' : null;
    if (st) return [{ at: s.lastRunAt, sessionId: s.lastSessionId, status: st, ...(s.target === 'session' ? { continued: true } : {}) }];
  }
  return [];
}

/**
 * What a run row says. A run still going shows its session's state: running, or waiting for you (an approval, a
 * question or a plan); only the newest run of a session can be the one going.
 */
export function runState(run: ScheduleRun, latestOfSession: boolean, session?: { running?: boolean; attention?: unknown }): RunState {
  if (run.status === 'running' && latestOfSession) {
    if (session?.attention) return 'waiting';
    return 'running';
  }
  if (run.status === 'running') return 'done';
  return run.status === 'ok' ? 'done' : run.status === 'error' ? 'failed' : 'stopped';
}

// ---------- Dreaming ----------

export const MODE_WORDS: Record<DreamMode, string> = { auto: 'Auto', approve: 'Approve', plan: 'Plan' };

export const MODE_LINES: Record<DreamMode, string> = {
  auto: 'Each suggestion is applied as soon as the dream makes it; you can revert it afterwards. New mods still stay off until you turn them on.',
  approve: 'The dream finishes its review, then each suggestion waits for you to apply or dismiss it.',
  plan: 'Nothing is applied: the suggestions become one plan in the dream’s session. Approve it to apply them all, or answer to change it.',
};

const OPEN_STATES = ['waiting', 'planned'];

/** Proposals of a dream that wait for the user (a running dream's do not count yet). */
export function dreamWaiting(d: Dream): number {
  return d.status === 'running' ? 0 : d.proposals.filter((p) => OPEN_STATES.includes(p.state)).length;
}

export interface DreamProjectCard {
  cwd: string;
  name: string;
  /** Its dreams, newest first */
  dreams: Dream[];
  waiting: number;
  /** The next dream reads it (new activity), and how many sessions */
  next: boolean;
  fresh: number;
  lastActivity: number;
  running: boolean;
}

/** One card per project that has dreams or that the next dream reads. */
export function dreamProjects(state: DreamingState | null, projects: DreamProject[] = []): DreamProjectCard[] {
  const by = new Map<string, DreamProjectCard>();
  const card = (cwd: string): DreamProjectCard => {
    let c = by.get(cwd);
    if (!c) by.set(cwd, (c = { cwd, name: folderName(cwd), dreams: [], waiting: 0, next: false, fresh: 0, lastActivity: 0, running: false }));
    return c;
  };
  for (const d of state?.dreams ?? []) {
    const c = card(d.cwd);
    c.dreams.push(d);
    c.waiting += dreamWaiting(d);
    if (d.status === 'running') c.running = true;
  }
  for (const p of projects) {
    if (!p.next && !by.has(p.cwd)) continue;
    const c = card(p.cwd);
    c.next = p.next;
    c.fresh = p.fresh;
    c.lastActivity = p.lastActivity;
  }
  if (state?.running) card(state.running.cwd).running = true;
  for (const c of by.values()) c.dreams.sort((a, b) => b.startedAt - a.startedAt);
  return [...by.values()];
}

export type ProjectFilter = 'all' | 'waiting' | 'new';
export type ProjectSort = 'recent' | 'name' | 'activity';

export const PROJECT_FILTERS: { value: ProjectFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'waiting', label: 'Waiting for you' },
  { value: 'new', label: 'Not dreamed yet' },
];

export const PROJECT_SORTS: { value: ProjectSort; label: string }[] = [
  { value: 'recent', label: 'Last dream' },
  { value: 'name', label: 'Name' },
  { value: 'activity', label: 'Latest activity' },
];

export function shownProjects(list: DreamProjectCard[], o: { query?: string; filter?: ProjectFilter; sort?: ProjectSort } = {}): DreamProjectCard[] {
  const q = (o.query ?? '').trim();
  const out = list.filter((c) => {
    if (q && !matchesQuery([c.name, c.cwd, c.dreams[0]?.summary], q)) return false;
    if (o.filter === 'waiting') return c.waiting > 0;
    if (o.filter === 'new') return c.dreams.length === 0;
    return true;
  });
  const byName = (a: DreamProjectCard, b: DreamProjectCard) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.cwd.localeCompare(b.cwd);
  if (o.sort === 'name') return out.sort(byName);
  if (o.sort === 'activity') return out.sort((a, b) => b.lastActivity - a.lastActivity || byName(a, b));
  return out.sort((a, b) => (b.dreams[0]?.startedAt ?? -1) - (a.dreams[0]?.startedAt ?? -1) || b.lastActivity - a.lastActivity || byName(a, b));
}

/** "Daily at 03:00" or "Off": the daily dream as a card footer starts */
export function dailyWords(cfg: DreamingConfig | undefined): string {
  return cfg?.daily ? `Daily at ${cfg.time}` : 'Off';
}

const shortDay = (ms: number, now: number) => formatWhenAt(ms, now).replace(/ at \d\d:\d\d$/, '');

/** The card footer: "Daily at 03:00 · 2 suggestions waiting", "Off · last dream Nov 6", "Daily at 03:00 · 3 new sessions to read" */
export function projectFooter(c: DreamProjectCard, cfg: DreamingConfig | undefined, now = Date.now()): string {
  const head = dailyWords(cfg);
  if (c.running) return `${head} · dreaming now`;
  if (c.waiting) return `${head} · ${c.waiting} suggestion${c.waiting === 1 ? '' : 's'} waiting`;
  if (c.dreams.length) return `${head} · last dream ${lower(shortDay(c.dreams[0].startedAt, now))}`;
  if (c.next) return `${head} · ${c.fresh} session${c.fresh === 1 ? '' : 's'} to read`;
  return head;
}

/** Two muted lines about the last dream: its own report, else what it left behind. */
export function dreamSummary(d: Dream | undefined): string {
  if (!d) return 'No dream yet. The next one reads its recent sessions and suggests skills, mods and memory.';
  if (d.status === 'running') return 'Dreaming now: reading the recent sessions.';
  if (d.status === 'failed') return `The last dream failed: ${d.error ?? 'unknown error'}`;
  if (d.summary) return d.summary;
  const shown = d.proposals.filter((p) => p.state !== 'withdrawn');
  if (!shown.length) return d.status === 'stopped' ? 'The last dream was stopped before it suggested anything.' : 'The last dream found nothing worth suggesting.';
  return `Suggested ${shown.map((p) => `${p.kind === 'memory' ? 'memory' : `a ${p.kind}`}: “${p.title}”`).join('; ')}.`;
}

export const TRIGGER_WORDS: Record<Dream['trigger'], string> = { daily: 'Daily dream', manual: 'By hand', command: 'With /dream' };
