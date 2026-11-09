// Rows for the agent's own tools beyond files, shell and browser: sub-sessions (session_*), schedules (schedule_*),
// mod_check and submit_plan. What the row says (verb, argument), the summary on its right, the status line while it
// runs, and the approval card's wording, the browser tools' cards included. Pure (no DOM, type imports only), so
// test/tool-labels.js loads it headless; tools.ts and renderer.ts render what it returns.
//
// The wording matches the phone page (remote/): Sub-session, Message, Sessions, Read session, Merge, Rename session, Schedule,
// Schedules, Update schedule, Delete schedule, Check mod.

import type { IconName } from './icons.js';

type Args = Record<string, unknown>;

/** Names the renderer knows for ids: session titles (the sidebar's metas) and schedule names. */
export interface NameLookup {
  session(ref: string): string | undefined;
  schedule(id: string): string | undefined;
}

const lookup: NameLookup = { session: () => undefined, schedule: () => undefined };

export function setNameLookup(l: Partial<NameLookup>): void {
  Object.assign(lookup, l);
}

/** The tools this module labels */
export const AGENT_TOOLS = new Set([
  'session_spawn', 'session_send', 'session_list', 'session_read', 'session_merge', 'session_rename',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'mod_check', 'submit_plan',
  'history_read', 'history_search', 'propose_skill', 'propose_memory', 'propose_mod', 'withdraw_proposal',
]);

const str = (a: Args, k: string): string => (typeof a[k] === 'string' ? (a[k] as string).trim() : typeof a[k] === 'number' ? String(a[k]) : '');
const short = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const quote = (s: string): string => `“${s}”`;

function sessionName(ref: string): string {
  return lookup.session(ref) ?? ref;
}

function scheduleName(id: string): string {
  return lookup.schedule(id) ?? id;
}

// ---------- Rhythms ----------
// The main process words a rhythm (src/main/schedules/when.ts, describeWhen) and that phrase reaches the row twice:
// in the approval card's "When:" line and in schedule_create's result. Until one of them arrives the row words the
// arguments itself, plainly; a cron expression stays as it is.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const every = (n: number, unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);

function onceAt(t: number, now: number): string {
  const d = new Date(t);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? `, ${d.getFullYear()}` : '';
  return `once on ${MONTHS[d.getMonth()]} ${d.getDate()}${year} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "every 2 hours", "once on Nov 6 at 09:00", "cron 0 3 * * *": the rhythm a schedule tool's arguments ask for. */
export function rhythmFromArgs(a: Args, now = Date.now()): string {
  const given = (k: string) => a[k] !== undefined && a[k] !== null && a[k] !== '';
  if (given('every_minutes')) {
    const n = Number(a.every_minutes);
    if (Number.isFinite(n) && n > 0) return n % 1440 === 0 ? every(n / 1440, 'day') : n % 60 === 0 ? every(n / 60, 'hour') : every(Math.round(n), 'minute');
  }
  if (given('in_minutes')) {
    const n = Number(a.in_minutes);
    if (Number.isFinite(n) && n > 0) return onceAt(now + Math.round(n * 60_000), now);
  }
  if (given('at')) {
    const t = Date.parse(String(a.at));
    return Number.isFinite(t) ? onceAt(t, now) : `once at ${String(a.at)}`;
  }
  if (given('cron')) return `cron ${String(a.cron).trim()}`;
  return '';
}

const joinName = (name: string, rhythm: string) => [name, rhythm].filter(Boolean).join(' · ');

// ---------- The row ----------

export interface AgentRow {
  verb: string;
  arg: string;
  icon: IconName;
  mono: boolean;
  /** The argument in full, for its tooltip */
  title?: string;
}

const row = (verb: string, arg: string, icon: IconName, mono = false): AgentRow => {
  const full = arg.replace(/\s+/g, ' ').trim();
  return { verb, arg: short(full, 80), icon, mono, title: full.length > 80 ? full : undefined };
};

/** The row's verb and argument from the call's arguments; null for a tool this module does not label. */
export function agentToolLabel(name: string, a: Args, now = Date.now()): AgentRow | null {
  switch (name) {
    case 'session_spawn': return row('Sub-session', str(a, 'title'), 'sub-session');
    case 'session_send': {
      const to = str(a, 'to');
      return row('Message', to ? `to ${sessionName(to)}` : '', 'message');
    }
    case 'session_list': return row('Sessions', str(a, 'query'), 'list');
    case 'session_read': return row('Read session', sessionName(str(a, 'id')), 'eye');
    case 'session_merge': return row('Merge', sessionName(str(a, 'id')), 'git-merge');
    case 'session_rename': return row('Rename session', str(a, 'name'), 'pencil');
    case 'schedule_create': return row('Schedule', joinName(str(a, 'name'), rhythmFromArgs(a, now)), 'clock');
    case 'schedule_list': return row('Schedules', '', 'clock');
    case 'schedule_update': return row('Update schedule', scheduleName(str(a, 'id')), 'clock');
    case 'schedule_delete': return row('Delete schedule', scheduleName(str(a, 'id')), 'trash');
    case 'mod_check': {
      const id = str(a, 'id');
      return row('Check mod', id || 'all mods', 'puzzle', Boolean(id));
    }
    case 'submit_plan': return row('Plan', str(a, 'title'), 'clipboard');
    // A dream's tools (a proposal that was made is a card; these rows are what was refused, and the reading)
    case 'history_read': return row('Read history', sessionName(str(a, 'session')), 'eye');
    case 'history_search': return row('Search history', str(a, 'query'), 'search');
    case 'propose_skill': return row('Propose skill', str(a, 'name'), 'sparkles');
    case 'propose_memory': {
      const add = Array.isArray(a.add) ? a.add.filter((x): x is string => typeof x === 'string') : [];
      return row('Propose memory', short(add[0] ?? '', 60), 'file-text');
    }
    case 'propose_mod': return row('Propose mod', str(a, 'name') || str(a, 'id'), 'puzzle');
    case 'withdraw_proposal': return row('Withdraw proposal', str(a, 'id'), 'undo');
    default: return null;
  }
}

/**
 * A better argument once the result is in: the result names what the arguments only gave as an id ("to Fix the
 * tests" for a session id), and schedule_create's result words the rhythm as the main process does. null: keep it.
 */
export function agentArgFromResult(name: string, a: Args, result: string): string | null {
  const r = result.trim();
  let m: RegExpExecArray | null;
  switch (name) {
    case 'session_send':
      return (m = /^Delivered to "(.*)" \([^()\n]+\)/.exec(r)) ? `to ${m[1]}` : null;
    case 'session_read':
      return (m = /^Session \S+ "(.*)" \(/.exec(r)) ? m[1] : null;
    case 'session_merge':
      return (m = /^\[Merged from "(.*)"\]/.exec(r)) ? m[1] : null;
    case 'schedule_create':
      return (m = /^Scheduled "(.*)" \(id [^)\n]+\): (.+?); next run /.exec(r)) ? joinName(m[1], m[2]) : null;
    case 'schedule_update':
      // A rename: the row keeps the name it had, the one the user knew the schedule by
      if (a.name !== undefined) return null;
      return (m = /^Updated: \S+\s+"(.*?)"\s{2}/.exec(r)) ? m[1] : null;
    case 'schedule_delete':
      return (m = /^Deleted schedule "(.*)" \(/.exec(r)) ? m[1] : null;
    default:
      return null;
  }
}

/** A better argument from the approval card's detail (the main process's wording), while the call waits on it. */
export function agentArgFromApproval(name: string, detail: string): string | null {
  let m: RegExpExecArray | null;
  switch (name) {
    case 'session_send':
      return (m = /^Send to session "(.*)" \([^()\n]+\):/.exec(detail)) ? `to ${m[1]}` : null;
    case 'schedule_create': {
      const n = /^Create schedule "(.*)"$/m.exec(detail);
      const w = /^When: (.+?)(?: \(first run [^)]*\))?$/m.exec(detail);
      return n ? joinName(n[1], w ? w[1] : '') : null;
    }
    case 'schedule_update':
      return (m = /^Change schedule "(.*)" \([^()\n]+\)$/m.exec(detail)) ? m[1] : null;
    default:
      return null;
  }
}

/** What the agent hands over, shown in the row's body above the result: a brief, a message, a schedule's prompt. */
export function agentBrief(name: string, a: Args): string {
  if (name === 'session_spawn' || name === 'schedule_create' || name === 'schedule_update') return typeof a.prompt === 'string' ? a.prompt.trim() : '';
  if (name === 'session_send') return typeof a.message === 'string' ? a.message.trim() : '';
  return '';
}

// ---------- The summary on the right ----------

/** A tool's own approval came back denied: "Not started: Not permitted: …" (as /^Not permitted/ for the others). */
export function isDeniedResult(r: string): boolean {
  return /^Not (?:started|sent|scheduled|changed): Not permitted/.test(r.trim());
}

export interface AgentMeta {
  text: string;
  err?: boolean;
}

/** The summary for a finished call ("started", "3 sessions", "2 problems"); null for a tool this module does not label. */
export function agentToolMeta(name: string, a: Args, result: string): AgentMeta | null {
  if (!AGENT_TOOLS.has(name)) return null;
  const r = result.trim();
  if (isDeniedResult(r)) return { text: 'denied' };
  if (/^Error\b/.test(r)) return { text: 'error', err: true };
  let m: RegExpExecArray | null;
  switch (name) {
    case 'session_spawn':
      return { text: /^Started sub-session/.test(r) ? 'started' : 'not started' };
    case 'session_send':
      return /^Delivered/.test(r) ? { text: /\bheld until\b/.test(r) ? 'held' : /it is busy/.test(r) ? 'queued' : 'sent' } : { text: 'not sent' };
    case 'session_list': {
      const n = r.split('\n').filter((l) => /^ {2}\S/.test(l)).length;
      if (/^No session matches/m.test(r)) return { text: 'no match' };
      return { text: n ? plural(n, 'session') : 'no other sessions' };
    }
    case 'session_read':
      return (m = /: the last (\d+) messages? of \d+\./.exec(r)) ? { text: plural(Number(m[1]), 'message') } : { text: 'read' };
    case 'session_merge':
      return { text: /^\[Merged from "/.test(r) ? 'merged' : 'not merged' };
    case 'session_rename':
      return /^Renamed/.test(r) ? { text: /ambiguous/.test(r) ? 'renamed, name shared' : 'renamed' } : { text: 'not renamed' };
    case 'schedule_create':
      return { text: /^Scheduled "/.test(r) ? 'created' : 'not created' };
    case 'schedule_list':
      if (/^No schedules/.test(r)) return { text: 'no schedules' };
      return (m = /^(\d+) schedules?:/.exec(r)) ? { text: plural(Number(m[1]), 'schedule') } : { text: 'listed' };
    case 'schedule_update':
      if (/^Nothing to change/.test(r)) return { text: 'no change' };
      return { text: /^Updated:/.test(r) ? 'updated' : 'not updated' };
    case 'schedule_delete':
      return { text: /^Deleted schedule/.test(r) ? 'deleted' : 'not deleted' };
    case 'mod_check': {
      if (/^No mod with the id/.test(r)) return { text: 'not found', err: true };
      if (/^No user or project mods/.test(r)) return { text: 'no mods' };
      let n = 0;
      for (const p of r.matchAll(/^Problems in mod\.json \((\d+)\):/gm)) n += Number(p[1]);
      for (const p of r.matchAll(/^Errors its pages reported \(latest \d+ of (\d+)\):/gm)) n += Number(p[1]);
      return n ? { text: plural(n, 'problem'), err: true } : { text: 'no problems' };
    }
    case 'submit_plan':
      return { text: /^Plan "/.test(r) ? 'submitted' : 'not submitted' };
    case 'history_read':
      return (m = /^Session "[\s\S]*?" \([^)]+\), (\d+) messages:/.exec(r)) ? { text: `${plural(Number(m[1]), 'message')} in all` } : { text: 'read' };
    case 'history_search':
      return /^No session matches/.test(r) ? { text: 'no match' } : { text: plural(r.split('\n').filter(Boolean).length, 'session') };
    case 'propose_skill':
    case 'propose_memory':
    case 'propose_mod':
      return /^Recorded proposal/.test(r) ? { text: /the app applied it/.test(r) ? 'applied' : 'proposed' } : { text: 'not proposed' };
    case 'withdraw_proposal':
      return { text: /^Withdrew/.test(r) ? 'withdrawn' : 'not withdrawn' };
    default:
      return null;
  }
}

/** The status line while it runs */
export function agentStatusVerb(name: string): string | null {
  switch (name) {
    case 'session_spawn': return 'Starting a sub-session…';
    case 'session_send': return 'Sending the message…';
    case 'session_list': return 'Listing sessions…';
    case 'session_read': return 'Reading the session…';
    case 'session_merge': return 'Merging…';
    case 'session_rename': return 'Renaming the session…';
    case 'schedule_create': return 'Scheduling…';
    case 'schedule_list': return 'Listing schedules…';
    case 'schedule_update': return 'Updating the schedule…';
    case 'schedule_delete': return 'Deleting the schedule…';
    case 'mod_check': return 'Checking the mod…';
    case 'submit_plan': return 'Writing the plan…';
    case 'history_read': return 'Reading a session…';
    case 'history_search': return 'Searching the sessions…';
    case 'propose_skill': return 'Proposing a skill…';
    case 'propose_memory': return 'Proposing memory…';
    case 'propose_mod': return 'Proposing a mod…';
    case 'withdraw_proposal': return 'Withdrawing a proposal…';
    default: return null;
  }
}

// ---------- The approval card ----------

export interface AgentApproval {
  /** The card's question */
  title: string;
  /** What the decided line names after "Allowed ·" / "Denied ·" */
  subject: string;
  icon: IconName;
}

/** A browser tool's card as the main process names it (approval_request.browser). */
export interface BrowserCardRef {
  card: 'site' | 'sensitive' | 'eval' | 'purchase' | 'account';
  site: string;
}

/**
 * A browser tool's approval card: its question, and what its decided line names (the site). The site card asks once
 * per site, reading included; the others name what is at stake on a site already allowed.
 */
export function browserApproval(b: BrowserCardRef): AgentApproval {
  const site = (typeof b.site === 'string' && b.site.trim()) || 'this page';
  switch (b.card) {
    case 'sensitive': return { title: 'Act on a sensitive site?', subject: site, icon: 'triangle-alert' };
    case 'eval': return { title: `Run JavaScript on ${site}?`, subject: `JavaScript on ${site}`, icon: 'code' };
    case 'purchase': return { title: 'Make a purchase?', subject: `a purchase on ${site}`, icon: 'globe' };
    case 'account': return { title: 'Create an account?', subject: `an account on ${site}`, icon: 'globe' };
    // A local file is named by its path, which the action under the title already shows in full
    default: return { title: /^[~/]/.test(site) ? 'Let the agent read a local file?' : `Let the agent use ${site}?`, subject: site, icon: 'globe' };
  }
}

/**
 * What a browser card's answer reads as, on the call's row or the decided line: "Allowed once on example.com",
 * "Allowed example.com for this session", "Always allowed example.com", "Denied on example.com".
 */
export function browserDecision(b: BrowserCardRef, ok: boolean, scope: 'once' | 'session' | 'project'): string {
  const site = (typeof b.site === 'string' && b.site.trim()) || 'this page';
  if (!ok) return `Denied on ${site}`;
  if (scope === 'session') return `Allowed ${site} for this session`;
  if (scope === 'project') return `Always allowed ${site}`;
  return `Allowed once on ${site}`;
}

/**
 * The approval card of a tool that asks its own question (ctx.approve with custom), from the detail the main process
 * sent: its first line names the thing ('Start sub-session "…"', 'Create schedule "…"'). null for other tools.
 */
export function agentApproval(name: string, detail: string): AgentApproval | null {
  const first = detail.split('\n')[0] ?? '';
  const named = (re: RegExp) => re.exec(first)?.[1] ?? '';
  switch (name) {
    case 'session_spawn': {
      const t = named(/^Start sub-session "(.*)"$/);
      return { title: t ? `Start the sub-session ${quote(t)}?` : 'Start a sub-session?', subject: t ? `start sub-session ${quote(short(t, 60))}` : 'start a sub-session', icon: 'sub-session' };
    }
    case 'session_send': {
      const t = named(/^Send to session "(.*)" \([^()]+\):$/);
      return { title: t ? `Send a message to ${quote(t)}?` : 'Send a message to another session?', subject: t ? `message ${quote(short(t, 60))}` : 'send a message', icon: 'message' };
    }
    case 'session_merge': {
      return { title: 'Merge this session?', subject: 'merge a session', icon: 'git-merge' };
    }
    case 'schedule_create': {
      const t = named(/^Create schedule "(.*)"$/);
      return { title: t ? `Schedule ${quote(t)}?` : 'Create a schedule?', subject: t ? `schedule ${quote(short(t, 60))}` : 'create a schedule', icon: 'clock' };
    }
    case 'schedule_update': {
      const t = named(/^Change schedule "(.*)" \([^()]+\)$/);
      return { title: t ? `Change the schedule ${quote(t)}?` : 'Change a schedule?', subject: t ? `change schedule ${quote(short(t, 60))}` : 'change a schedule', icon: 'clock' };
    }
    case 'schedule_delete':
      return { title: 'Delete a schedule?', subject: 'delete a schedule', icon: 'trash' };
    default:
      return null;
  }
}
