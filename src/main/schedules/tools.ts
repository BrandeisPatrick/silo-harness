// The model's side of schedules: create, list, update, delete. Creating (and re-timing) goes through a custom
// approval with alwaysAsk, because a schedule outlives the conversation: the user sees every one, in every mode.

import type { Schedule, ScheduleInput, ScheduleWhen } from '../../shared/schedules';
import type { Tool, ToolContext, ToolResult } from '../tools/types';
import { ScheduleError } from './errors';
import type { InternalPatch, Scheduler } from './service';
import { formatLocal } from './when';

const MINUTE = 60_000;

const whenProps = {
  in_minutes: { type: 'number', description: 'Run once, this many minutes from now' },
  at: { type: 'string', description: 'Run once at this ISO date-time with an offset, e.g. "2026-11-06T09:00:00-05:00"' },
  every_minutes: { type: 'number', description: 'Run repeatedly, every this many minutes (at least 5)' },
  cron: { type: 'string', description: 'Run on a five-field cron rhythm in local time (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5"' },
};

/** The same fields without their descriptions, for schedule_update: schedule_create's say what they mean. */
const bareWhenProps = { in_minutes: { type: 'number' }, at: { type: 'string' }, every_minutes: { type: 'number' }, cron: { type: 'string' } };

/** Reads the rhythm arguments; undefined when none is given. Exactly one is allowed. */
function whenFrom(args: Record<string, unknown>, now: number): ScheduleWhen | undefined {
  const given = (['in_minutes', 'at', 'every_minutes', 'cron'] as const).filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== '');
  if (!given.length) return undefined;
  if (given.length > 1) throw new ScheduleError('bad_time', `give exactly one of in_minutes, at, every_minutes or cron (got ${given.join(', ')}).`);
  const k = given[0];
  if (k === 'in_minutes') {
    const n = Number(args.in_minutes);
    if (!Number.isFinite(n)) throw new ScheduleError('bad_time', `in_minutes must be a number, not ${JSON.stringify(args.in_minutes)}.`);
    if (n <= 0) throw new ScheduleError('not_future', `in_minutes must be more than 0 (got ${n}).`);
    return { kind: 'at', at: new Date(now + Math.round(n * MINUTE)).toISOString() };
  }
  if (k === 'at') return { kind: 'at', at: String(args.at) };
  if (k === 'every_minutes') return { kind: 'every', minutes: Number(args.every_minutes) };
  return { kind: 'cron', expr: String(args.cron) };
}

function targetFrom(raw: unknown): 'new' | 'session' | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (raw === 'new_session') return 'new';
  if (raw === 'this_session') return 'session';
  throw new ScheduleError('bad_input', `target must be "new_session" or "this_session", not ${JSON.stringify(raw)}.`);
}

function whereWords(target: 'new' | 'session', cwd: string): string {
  return target === 'new' ? `a new session each time, in ${cwd}` : 'this session, as a follow-up message';
}

function lastWords(s: Schedule): string {
  if (!s.lastStatus) return 'not run yet';
  return `${s.lastStatus}${s.lastSessionId ? ` (session ${s.lastSessionId})` : ''}`;
}

function nextWords(s: Schedule, now: number): string {
  if (!s.enabled) return 'disabled';
  return s.nextRunAt === null ? 'none' : formatLocal(s.nextRunAt, now);
}

export function scheduleLine(s: Schedule, now: number): string {
  return `${s.id}  "${s.name}"  ${s.describe}  next: ${nextWords(s, now)}  last: ${lastWords(s)}`;
}

/** Turns a validation failure into text the model can act on; anything else is a real error. */
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ScheduleError) return { content: `Error: ${err.message}` };
    throw err;
  }
}

export function scheduleTools(svc: Scheduler, now: () => number): Tool[] {
  const create: Tool = {
    name: 'schedule_create',
    description:
      'Schedule a prompt to run later or regularly while the app is open: once (in_minutes or at), every N minutes, or on a cron rhythm. Give exactly one of in_minutes, at, every_minutes, cron. The user approves each schedule before it is saved. Write the prompt so it stands on its own: the run may happen in a new session that has none of this conversation.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name, at most 80 characters' },
        prompt: { type: 'string', description: 'What to do on each run (at most 8000 characters)' },
        ...whenProps,
        target: {
          type: 'string',
          enum: ['new_session', 'this_session'],
          description: 'Where each run happens. Default: this session for a one-off, a new session for a recurring schedule',
        },
      },
      required: ['name', 'prompt'],
    },
    run: (args: Record<string, unknown>, ctx: ToolContext) =>
      guarded(async () => {
        const t = now();
        const when = whenFrom(args, t);
        if (!when) throw new ScheduleError('bad_time', 'say when: give one of in_minutes, at, every_minutes or cron.');
        const preview = svc.preview(when);
        const target = targetFrom(args.target) ?? (when.kind === 'at' ? 'session' : 'new');
        if (target === 'session' && !ctx.sessionId) throw new ScheduleError('bad_input', 'this_session is not available here; use target "new_session".');
        const name = String(args.name ?? '').trim();
        const prompt = String(args.prompt ?? '').trim();
        const input: ScheduleInput = { name, prompt, when: preview.when, target, sessionId: target === 'session' ? ctx.sessionId : undefined, cwd: ctx.cwd };
        // Validate everything (limits, lengths) before the card, so the user is never asked about something that cannot be stored
        const probe = svc.checkCreate(input, 'agent');
        const detail = [
          `Create schedule "${probe.name}"`,
          `When: ${preview.describe}${preview.nextRunAt !== null ? ` (first run ${formatLocal(preview.nextRunAt, t)})` : ''}`,
          `Runs in: ${whereWords(target, ctx.cwd)}`,
          'Prompt:',
          prompt,
        ].join('\n');
        const ok = await ctx.approve('schedule_create', detail, undefined, { custom: true, alwaysAsk: true });
        if (!ok.ok) return { content: `Not scheduled: ${ok.message}` };
        // "In 10 minutes" counts from the approval, not from the request: the card may wait a while
        if (args.in_minutes !== undefined) input.when = whenFrom(args, now())!;
        const s = svc.createWith(input, 'agent', ctx.sessionId);
        return {
          content: `Scheduled "${s.name}" (id ${s.id}): ${s.describe}; next run ${s.nextRunAt !== null ? formatLocal(s.nextRunAt, now()) : 'none'}, in ${whereWords(s.target, s.cwd)}.`,
        };
      }),
  };

  const list: Tool = {
    name: 'schedule_list',
    description: 'List the scheduled tasks: id, name, rhythm, next run (local time) and the result of the last run.',
    parameters: { type: 'object', properties: {} },
    readOnly: true,
    run: () =>
      guarded(async () => {
        const all = svc.list();
        if (!all.length) return { content: 'No schedules.' };
        const t = now();
        return { content: `${all.length} schedule${all.length === 1 ? '' : 's'}:\n${all.map((s) => scheduleLine(s, t)).join('\n')}` };
      }),
  };

  const update: Tool = {
    name: 'schedule_update',
    description:
      'Change a schedule by id: its name, prompt, rhythm (one of in_minutes, at, every_minutes, cron, as in schedule_create), target, or enable/disable it. Every change except disabling is approved by the user.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        prompt: { type: 'string' },
        ...bareWhenProps,
        target: { type: 'string', enum: ['new_session', 'this_session'] },
        enabled: { type: 'boolean' },
      },
      required: ['id'],
    },
    run: (args: Record<string, unknown>, ctx: ToolContext) =>
      guarded(async () => {
        const id = String(args.id ?? '');
        const before = svc.get(id);
        if (!before) throw new ScheduleError('not_found', `no schedule with id "${id}". schedule_list shows the ids.`);
        const t = now();
        const patch: InternalPatch = {};
        if (args.name !== undefined) patch.name = String(args.name);
        if (args.prompt !== undefined) patch.prompt = String(args.prompt);
        const when = whenFrom(args, t);
        if (when) patch.when = svc.preview(when).when;
        const target = targetFrom(args.target);
        if (target) {
          patch.target = target;
          if (target === 'session') {
            if (!ctx.sessionId) throw new ScheduleError('bad_input', 'this_session is not available here; use target "new_session".');
            patch.sessionId = ctx.sessionId;
          }
        }
        if (args.enabled !== undefined) patch.enabled = args.enabled === true || args.enabled === 'true';
        const keys = Object.keys(patch);
        if (!keys.length) return { content: 'Nothing to change: give name, prompt, a rhythm, target or enabled.' };
        // Turning a schedule off can only make it do less, so it needs no card
        svc.checkUpdate(id, patch);
        if (!(keys.length === 1 && patch.enabled === false)) {
          const lines = [`Change schedule "${before.name}" (${before.id})`];
          if (patch.name !== undefined) lines.push(`Name: ${patch.name}`);
          if (when) lines.push(`When: ${svc.preview(when).describe} (was ${before.describe})`);
          if (patch.target) lines.push(`Runs in: ${whereWords(patch.target, before.cwd)}`);
          if (patch.enabled !== undefined) lines.push(patch.enabled ? 'Enable it' : 'Disable it');
          lines.push('Prompt:', patch.prompt ?? before.prompt);
          const ok = await ctx.approve('schedule_update', lines.join('\n'), undefined, { custom: true, alwaysAsk: true });
          if (!ok.ok) return { content: `Not changed: ${ok.message}` };
        }
        const s = svc.updateWith(id, patch);
        return { content: `Updated: ${scheduleLine(s, now())}` };
      }),
  };

  const remove: Tool = {
    name: 'schedule_delete',
    description: 'Delete a schedule by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (args: Record<string, unknown>) =>
      guarded(async () => {
        const id = String(args.id ?? '');
        const s = svc.get(id);
        svc.remove(id);
        return { content: `Deleted schedule "${s?.name ?? id}" (${id}).` };
      }),
  };

  return [create, list, update, remove];
}
