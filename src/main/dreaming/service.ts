// The Dreaming service: picks the projects with new activity, builds each one's digest, runs one dream session at a
// time with a tool set of its own, records what the dream proposes and applies it as the mode says, fires the daily
// dream (and a missed one after a launch), and keeps dreaming.json. Proposals are applied by the app, never the model.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { App, Disposer } from '../app';
import type { HistoryService } from '../services';
import type { Dream, DreamingConfig, DreamingState, DreamMode, DreamProject, DreamProposal, DreamTrigger, ProposalKind } from '../../shared/dreaming';
import { DEFAULT_DREAMING } from './names';
import type { AgentEvent, AppConfig, PlanInfo } from '../../shared/types';
import { contextLimit } from '../context-window';
import { normalizeDreaming } from '../config';
import { instructionsFile, applyProposal, checkMemory, checkMod, checkSkill, DreamError, revertProposal, type Roots } from './apply';
import { buildDigest, DIGEST_SHARE, listMods, sessionTurns, when, type DigestSession, type ExistingThings } from './digest';
import { DreamStore, MAX_DREAMS, type DreamingData } from './store';
import { dreamToolNames } from './tools';
import { configDir, projectConfigDir } from '../paths';
import { loadSkills } from '../skills';
import { toMeta, type Session } from '../sessions';

/** Projects one run dreams about, at most; the rest wait for the next run */
export const MAX_PROJECTS = 5;
/** Proposals a dream may have open at once */
export const MAX_PROPOSALS = 8;
/** A missed daily dream still runs after a launch, unless a dream ran this recently */
export const RECENT_MS = 20 * 60 * 60_000;
/** A daily dream noticed this late is on time; later than this it was missed */
export const ON_TIME_MS = 10 * 60_000;
export const TICK_MS = 30_000;

export interface DreamingOptions {
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  tickMs?: number;
  /** The first check for a missed daily dream, this long after the app started (default 20 s; tests use 0) */
  startDelayMs?: number;
  store?: DreamStore;
  /** A system notification; default Electron's (only when notifications are on and the window is not in front) */
  notify?: (title: string, body: string, onClick: () => void) => void;
}

/** The dreaming settings of a config, whatever the config holds. */
export function dreamingOf(cfg: AppConfig): DreamingConfig {
  return normalizeDreaming((cfg as Partial<AppConfig>).dreaming ?? DEFAULT_DREAMING);
}

/** The latest moment at `time` ("HH:MM", local) that is not after `now`. */
export function latestOccurrence(time: string, now: number): number {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return today <= now ? today : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, h, m).getTime();
}

/** The next moment at `time` after `now`. */
export function nextOccurrence(time: string, now: number): number {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return today > now ? today : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime();
}

const OPEN: DreamProposal['state'][] = ['waiting', 'planned'];

/** Proposals of a dream that wait for the user (a running dream's do not count until it ends). */
export function waitingOf(d: Dream): number {
  return d.status === 'running' ? 0 : d.proposals.filter((p) => OPEN.includes(p.state)).length;
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function electronNotify(app: App): DreamingOptions['notify'] {
  return (title, body, onClick) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Notification } = require('electron') as typeof import('electron');
      const w = app.window();
      if (!w || w.isFocused() || !Notification.isSupported()) return;
      const n = new Notification({ title, body, silent: false });
      n.on('click', onClick);
      n.show();
    } catch (err) {
      console.warn('[dreaming] could not notify:', err);
    }
  };
}

interface Run {
  trigger: DreamTrigger;
  queue: string[];
  current: { dreamId: string; sessionId: string; cwd: string } | null;
  stopped: boolean;
}

export class Dreaming {
  readonly data: DreamingData;
  private readonly store: DreamStore;
  private readonly now: () => number;
  private readonly notify: NonNullable<DreamingOptions['notify']>;
  private run: Run | null = null;
  private readonly disposers: Disposer[] = [];
  /** The last error a dream's run reported, by session */
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly app: App,
    opts: DreamingOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? new DreamStore(path.join(app.userData, 'dreaming.json'));
    this.notify = opts.notify ?? electronNotify(app)!;
    this.data = this.store.load();
    // The app quit (or crashed) during these dreams: what they proposed stays, the cursor did not move
    let changed = false;
    for (const d of this.data.dreams) {
      if (d.status !== 'running') continue;
      d.status = 'stopped';
      d.error = 'The app closed during this dream.';
      d.endedAt = this.now();
      changed = true;
      this.syncSession(d);
    }
    if (changed) this.save();
  }

  config(): DreamingConfig {
    return dreamingOf(this.app.config());
  }

  // ---------- State ----------

  state(): DreamingState {
    const cfg = this.config();
    const cur = this.run?.current;
    return {
      config: cfg,
      running: cur ? { dreamId: cur.dreamId, sessionId: cur.sessionId, cwd: cur.cwd, queued: this.run!.queue.length } : null,
      nextRunAt: cfg.daily ? nextOccurrence(cfg.time, this.now()) : null,
      lastCheck: this.data.lastCheck,
      waiting: this.data.dreams.reduce((n, d) => n + waitingOf(d), 0),
      dreams: structuredClone(this.data.dreams),
    };
  }

  dream(id: string): Dream {
    const d = this.data.dreams.find((x) => x.id === id);
    if (!d) throw new DreamError(`no dream with the id "${id}".`);
    return d;
  }

  dreamOf(sessionId: string): Dream | undefined {
    const s = this.app.store.get(sessionId);
    const id = s?.dream?.id;
    return id ? this.data.dreams.find((d) => d.id === id) : undefined;
  }

  private find(proposalId: string): { dream: Dream; p: DreamProposal } {
    for (const dream of this.data.dreams) {
      const p = dream.proposals.find((x) => x.id === proposalId);
      if (p) return { dream, p };
    }
    throw new DreamError(`no proposal with the id "${proposalId}".`);
  }

  private save(): void {
    if (this.data.dreams.length > MAX_DREAMS) {
      for (const old of this.data.dreams.splice(MAX_DREAMS)) for (const p of old.proposals) delete this.data.replaced[p.id];
    }
    try {
      this.store.save(this.data);
    } catch (err) {
      console.warn('[dreaming] could not save:', err);
    }
  }

  /** Saves, mirrors the dream's waiting count onto its session (the sidebar reads it), and tells the window. */
  private changed(d?: Dream): void {
    if (d) this.syncSession(d);
    this.save();
    this.app.push('dreaming:changed', this.state());
  }

  private syncSession(d: Dream): void {
    const s = this.app.store.get(d.sessionId);
    if (!s?.dream) return;
    const waiting = waitingOf(d);
    if ((s.dream.waiting ?? 0) === waiting) return;
    s.dream.waiting = waiting;
    this.app.store.save(s, false);
    try {
      this.app.runtime.emit(s.id, { type: 'session_changed', session: toMeta(s) });
    } catch {
      /* a runtime without emit (bare tests) */
    }
  }

  private newId(prefix: string): string {
    return `${prefix}_${randomBytes(4).toString('hex')}`;
  }

  roots(cwd: string): Roots {
    return { cwd, configDir: configDir(), appRoot: this.app.appRoot };
  }

  /** Values that must never be copied into a skill or memory: the keys in the settings. */
  private knownSecrets(): string[] {
    const c = this.app.config();
    return [c.portkey?.apiKey, c.portkey?.providerApiKey, c.portkey?.virtualKey, process.env.PORTKEY_API_KEY, process.env.ANTHROPIC_API_KEY].filter((k): k is string => typeof k === 'string' && k.length >= 8);
  }

  // ---------- What to dream about ----------

  /** The sessions a dream may read: not dreams, with a user message, in an existing folder. */
  private candidates(): Session[] {
    return this.app.store.all().filter((s) => s.origin !== 'dream' && s.cwd && s.messages.length > 0 && s.messages.some((m) => m.role === 'user'));
  }

  private records(id: string) {
    return this.app.service<HistoryService>('history')?.read?.(id) ?? [];
  }

  /** The uncovered turns of each session in a project folder, newest activity last. */
  private projectSessions(cwd: string): DigestSession[] {
    const cursor = this.data.cursors[cwd] ?? 0;
    const out: DigestSession[] = [];
    for (const s of this.candidates()) {
      if (s.cwd !== cwd || s.updatedAt <= cursor) continue;
      const turns = sessionTurns(s, this.records(s.id), { running: this.app.runtime.isRunning(s.id) }).filter((t) => t.t > cursor);
      if (turns.length) out.push({ id: s.id, title: s.title, createdAt: s.createdAt, origin: s.origin, turns });
    }
    return out;
  }

  /** Project folders with activity since their last dream, most recently active first, at most MAX_PROJECTS. */
  projects(): string[] {
    const latest = new Map<string, number>();
    for (const s of this.candidates()) {
      const cwd = s.cwd!;
      if (s.updatedAt <= (this.data.cursors[cwd] ?? 0) || !isDir(cwd)) continue;
      latest.set(cwd, Math.max(latest.get(cwd) ?? 0, s.updatedAt));
    }
    const ordered = [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
    return ordered.filter((cwd) => this.projectSessions(cwd).length > 0).slice(0, MAX_PROJECTS);
  }

  /** Every project folder with sessions (not dreams), most recently active first: for the Dreaming page. */
  projectList(): DreamProject[] {
    const by = new Map<string, { fresh: number; lastActivity: number }>();
    for (const s of this.candidates()) {
      const cwd = s.cwd!;
      const e = by.get(cwd) ?? { fresh: 0, lastActivity: 0 };
      if (s.updatedAt > (this.data.cursors[cwd] ?? 0)) e.fresh++;
      e.lastActivity = Math.max(e.lastActivity, s.updatedAt);
      by.set(cwd, e);
    }
    const next = new Set(this.projects());
    return [...by.entries()]
      .filter(([cwd]) => isDir(cwd))
      .sort((a, b) => b[1].lastActivity - a[1].lastActivity)
      .slice(0, 40)
      // A session saved after the dream's last turn is not news: count only those with turns no dream has read
      .map(([cwd, e]) => ({ cwd, fresh: e.fresh ? this.projectSessions(cwd).length : 0, lastActivity: e.lastActivity, next: next.has(cwd) }));
  }

  existing(cwd: string): ExistingThings {
    const r = this.roots(cwd);
    const skills = loadSkills(cwd, this.app.appRoot).map((s) => ({ name: s.name, description: s.description, source: s.source }));
    const mods = listMods({ bundled: path.join(this.app.appRoot, 'mods'), user: path.join(r.configDir, 'mods'), project: path.join(projectConfigDir(cwd), 'mods') });
    const instructions: ExistingThings['instructions'] = (['project', 'user'] as const).map((scope) => {
      const f = instructionsFile(scope, r);
      let text: string | null = null;
      try {
        text = fs.readFileSync(f.path, 'utf8').trim();
      } catch {
        /* none yet */
      }
      return { scope, label: f.label, path: f.path, text };
    });
    return { skills, mods, instructions };
  }

  /** The digest for a project, sized to 40% of the context window the app works with. */
  digest(cwd: string, cfg = this.config()) {
    return buildDigest({
      cwd,
      mode: cfg.mode,
      lookFor: { skills: cfg.skills, mods: cfg.mods, memory: cfg.memory },
      sessions: this.projectSessions(cwd),
      existing: this.existing(cwd),
      budget: Math.floor(contextLimit(this.app.config()) * DIGEST_SHARE),
    });
  }

  // ---------- Running ----------

  running(): boolean {
    return this.run !== null;
  }

  /**
   * Starts a run: one dream per project with new activity (or `cwd` alone), one at a time. Returns how many projects
   * it will dream about (0: nothing new anywhere). Refused while a run is going.
   */
  start(trigger: DreamTrigger, cwd?: string): { projects: string[] } {
    if (this.run) throw new DreamError('a dream is running already; wait for it to end, or stop it.');
    const t = this.now();
    const projects = cwd ? (this.projectSessions(cwd).length && isDir(cwd) ? [cwd] : []) : this.projects();
    // Only a run that dreams counts as one for the missed-dream rule; a look that found nothing does not
    if (projects.length) this.data.lastRunAt = t;
    this.data.lastCheck = { at: t, trigger, found: projects.length };
    if (!projects.length) {
      this.changed();
      return { projects };
    }
    this.run = { trigger, queue: [...projects], current: null, stopped: false };
    this.next();
    return { projects };
  }

  stop(): void {
    const run = this.run;
    if (!run) return;
    run.stopped = true;
    run.queue = [];
    if (run.current) this.app.runtime.stop(run.current.sessionId);
    else this.run = null;
    this.changed();
  }

  /** The next project of the run, or the end of the run. */
  private next(): void {
    const run = this.run;
    if (!run) return;
    while (run.queue.length && !run.stopped) {
      const cwd = run.queue.shift()!;
      if (this.begin(run, cwd)) return;
    }
    this.run = null;
    this.changed();
  }

  /** Starts one dream. False when there was nothing to dream about after all, or it could not start. */
  private begin(run: Run, cwd: string): boolean {
    const cfg = this.config();
    const digest = this.digest(cwd, cfg);
    if (!digest.covered.turns) return false;
    const t = this.now();
    const meta = this.app.runtime.create({ cwd, origin: 'dream', title: `Dream · ${path.basename(cwd) || cwd}`, foreground: false });
    const s = this.app.store.get(meta.id)!;
    const dream: Dream = { id: this.newId('dr'), sessionId: s.id, cwd, trigger: run.trigger, mode: cfg.mode, startedAt: t, status: 'running', covered: digest.covered, proposals: [] };
    // What makes it a dream, on the session itself, so it survives a restart: its tools and its dream
    s.tools = dreamToolNames(cfg);
    s.dream = { id: dream.id, waiting: 0 };
    this.data.dreams.unshift(dream);
    run.current = { dreamId: dream.id, sessionId: s.id, cwd };
    this.changed();
    const r = this.app.runtime.send(s.id, digest.text, [], { origin: 'dream', from: 'dreaming' });
    if (!r.ok) {
      // Nothing ran, so nothing will end it: fail it here and go on with the next project
      dream.status = 'failed';
      dream.error = r.error ?? 'The dream could not start.';
      dream.endedAt = this.now();
      run.current = null;
      this.changed(dream);
      return false;
    }
    return true;
  }

  /** Every event of every session: the end of a dream's run (its first, or one after the user answered in it). */
  onEvent(sessionId: string, ev: AgentEvent): void {
    if (ev.type === 'error' && ev.kind !== 'notice') {
      if (this.app.store.get(sessionId)?.dream) this.errors.set(sessionId, ev.message);
      return;
    }
    if (ev.type === 'run_start') {
      this.errors.delete(sessionId);
      return;
    }
    if (ev.type !== 'run_end') return;
    // Cut by "Send now": the dream's session goes on with the user's message; that run's end counts
    if (ev.continued) return;
    const dream = this.dreamOf(sessionId);
    if (!dream) return;
    const first = dream.status === 'running';
    if (first) {
      dream.endedAt = this.now();
      const report = typeof ev.text === 'string' ? ev.text.replace(/\s+/g, ' ').trim() : '';
      if (report) dream.summary = report.length > 400 ? `${report.slice(0, 399)}…` : report;
      if (ev.reason === 'aborted') dream.status = 'stopped';
      else if (ev.reason === 'error') {
        dream.status = 'failed';
        dream.error = this.errors.get(sessionId) ?? 'The model call failed.';
      } else {
        dream.status = 'done';
        // Only past what the dream really read: a failed or stopped dream leaves it for the next one
        this.data.cursors[dream.cwd] = Math.max(this.data.cursors[dream.cwd] ?? 0, dream.covered.to);
      }
    }
    this.errors.delete(sessionId);
    if (dream.mode === 'plan' && ev.reason !== 'aborted' && ev.reason !== 'error') this.makePlan(dream);
    this.changed(dream);
    if (first && dream.trigger === 'daily' && dream.status === 'done' && waitingOf(dream) > 0 && this.app.config().notifications) {
      const n = waitingOf(dream);
      this.notify(`Silo Harness dreamed about ${path.basename(dream.cwd) || dream.cwd}`, `${n} suggestion${n === 1 ? '' : 's'} wait${n === 1 ? 's' : ''} for you`, () => {
        const w = this.app.window();
        w?.show();
        w?.focus();
        this.app.push('sessions:show', dream.sessionId);
      });
    }
    if (this.run?.current?.dreamId === dream.id) {
      this.run.current = null;
      this.next();
    }
  }

  // ---------- Plan mode ----------

  /** Gathers the planned proposals into one plan on the session (the plan card and its attention state). */
  private makePlan(dream: Dream): void {
    const planned = dream.proposals.filter((p) => p.state === 'planned');
    const s = this.app.store.get(dream.sessionId);
    if (!s || !planned.length) return;
    const latest = dream.planId ? s.plans?.[dream.planId] : undefined;
    if (latest?.status === 'proposed') return;
    const title = `${planned.length} suggestion${planned.length === 1 ? '' : 's'} for ${path.basename(dream.cwd) || dream.cwd}`;
    const markdown = planned.map((p, i) => planEntry(p, i + 1, dream.cwd, (id) => this.app.store.get(id)?.title ?? id)).join('\n\n');
    const plan: PlanInfo = { id: this.newId('plan'), title, markdown, status: 'proposed', createdAt: this.now(), kind: 'dream' };
    s.plans ??= {};
    s.plans[plan.id] = plan;
    dream.planId = plan.id;
    // The plan as a submit_plan call in the conversation, so the transcript shows it after a reload as any plan, and
    // the model sees, when the user answers, which proposals the user is looking at.
    const callId = `call_${plan.id}`;
    this.app.store.append(s, { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify({ title, markdown }) } }] });
    this.app.store.append(s, { role: 'tool', tool_call_id: callId, content: 'The app gathered your proposals into this plan for the user. Approving it applies them; the user may answer instead.' });
    this.app.store.save(s, false);
    try {
      this.app.runtime.emit(s.id, { type: 'plan_proposed', plan });
    } catch {
      /* bare tests */
    }
  }

  /** runtime.respondPlan hands a dream's plan here: approving applies every planned proposal, no model call. */
  claimPlan(sessionId: string, plan: PlanInfo, decision: 'build-ask' | 'build-acceptEdits' | 'keep'): boolean {
    if (plan.kind !== 'dream') return false;
    const dream = this.dreamOf(sessionId);
    if (!dream) return true;
    if (decision !== 'keep') for (const p of dream.proposals) if (p.state === 'planned') this.applyOne(dream, p);
    this.changed(dream);
    return true;
  }

  /** A plan whose proposals were all decided one by one is decided too. */
  private settlePlan(dream: Dream): void {
    if (!dream.planId || dream.proposals.some((p) => p.state === 'planned')) return;
    const s = this.app.store.get(dream.sessionId);
    const plan = s?.plans?.[dream.planId];
    if (!s || !plan || plan.status !== 'proposed') return;
    plan.status = dream.proposals.some((p) => p.state === 'applied') ? 'approved' : 'rejected';
    this.app.store.save(s, false);
    try {
      this.app.runtime.planDecided(s.id);
      this.app.runtime.emit(s.id, { type: 'session_changed', session: toMeta(s) });
    } catch {
      /* bare tests */
    }
  }

  // ---------- Proposals ----------

  /** A proposal from a dream session's tool. Validated; applied at once in Auto mode. */
  propose(sessionId: string, kind: ProposalKind, input: Record<string, unknown>): DreamProposal {
    const dream = this.dreamOf(sessionId);
    if (!dream) throw new DreamError('proposals can only be made in a dream.');
    const s = this.app.store.get(sessionId);
    const tool = { skill: 'propose_skill', memory: 'propose_memory', mod: 'propose_mod' }[kind];
    if (s?.tools && !s.tools.includes(tool)) throw new DreamError(`the user turned ${kind === 'memory' ? 'memory' : `${kind}s`} off for dreams.`);
    const why = String(input.why ?? '').trim();
    if (!why) throw new DreamError('say why, quoting the evidence from the sessions.');
    const ids = (Array.isArray(input.sessions) ? input.sessions : typeof input.sessions === 'string' ? [input.sessions] : []).map((x) => String(x).trim()).filter(Boolean);
    if (!ids.length) throw new DreamError('name the sessions this is based on (their ids, from the digest).');
    const unknown = ids.filter((id) => !this.app.store.get(id) || this.app.store.get(id)?.origin === 'dream');
    if (unknown.length) throw new DreamError(`no session with the id ${unknown.map((u) => `"${u}"`).join(', ')}; use the ids the digest gives.`);
    const replaces = typeof input.replaces === 'string' && input.replaces.trim() ? dream.proposals.find((p) => p.id === input.replaces) : undefined;
    if (typeof input.replaces === 'string' && input.replaces.trim() && !replaces) throw new DreamError(`replaces: no proposal "${input.replaces}" in this dream.`);
    if (replaces && !OPEN.includes(replaces.state) && replaces.state !== 'failed') throw new DreamError(`${replaces.id} was ${replaces.state} already and cannot be replaced.`);
    const open = dream.proposals.filter((p) => (OPEN.includes(p.state) || p.state === 'applied') && p !== replaces).length;
    if (open >= MAX_PROPOSALS) throw new DreamError(`this dream has ${open} proposals already; propose fewer, better ones (withdraw one first).`);
    const r = this.roots(dream.cwd);
    const known = this.knownSecrets();
    const base = { id: this.newId('pr'), dreamId: dream.id, why, sessions: [...new Set(ids)], state: (dream.mode === 'approve' ? 'waiting' : dream.mode === 'plan' ? 'planned' : 'waiting') as DreamProposal['state'], createdAt: this.now() };
    let p: DreamProposal;
    if (kind === 'skill') {
      const name = String(input.name ?? '').trim().toLowerCase();
      if (this.app.commands.list().some((c) => c.name === name)) throw new DreamError(`/${name} is a command of the app already; pick another name for the skill.`);
      p = { ...base, kind, ...checkSkill(input as never, r, loadSkills(dream.cwd, this.app.appRoot), known) };
    }
    else if (kind === 'memory') p = { ...base, kind, ...checkMemory(input as never, r, known) };
    else p = { ...base, kind, ...checkMod(input as never, r, known) };
    // The same change twice in one dream is one proposal
    const twin = dream.proposals.find((x) => x !== replaces && OPEN.includes(x.state) && x.target === p.target && x.kind === p.kind);
    if (twin) throw new DreamError(`${twin.id} proposes a change to ${p.target} already; replace it (replaces "${twin.id}") or leave it.`);
    if (replaces) {
      replaces.state = 'withdrawn';
      replaces.decidedAt = this.now();
    }
    dream.proposals.push(p);
    if (dream.mode === 'auto') this.applyOne(dream, p);
    this.changed(dream);
    return structuredClone(p);
  }

  withdraw(sessionId: string, proposalId: string, reason: string): DreamProposal {
    const dream = this.dreamOf(sessionId);
    if (!dream) throw new DreamError('only a dream can withdraw its proposals.');
    const p = dream.proposals.find((x) => x.id === proposalId.trim());
    if (!p) throw new DreamError(`no proposal "${proposalId}" in this dream.`);
    if (p.state === 'applied') throw new DreamError(`${p.id} was applied already; the user can revert it from its card.`);
    if (!OPEN.includes(p.state) && p.state !== 'failed') throw new DreamError(`${p.id} was ${p.state} already.`);
    p.state = 'withdrawn';
    p.decidedAt = this.now();
    if (reason.trim()) p.error = reason.trim();
    this.settlePlan(dream);
    this.changed(dream);
    return structuredClone(p);
  }

  /** Applies one proposal; a failure is recorded on it (state failed, error) instead of thrown. */
  private applyOne(dream: Dream, p: DreamProposal): boolean {
    try {
      this.data.replaced[p.id] = applyProposal(p, this.roots(dream.cwd));
      p.state = 'applied';
      p.decidedAt = this.now();
      delete p.error;
      return true;
    } catch (err) {
      p.state = 'failed';
      p.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  apply(proposalId: string): Dream {
    const { dream, p } = this.find(proposalId);
    if (!OPEN.includes(p.state) && p.state !== 'failed' && p.state !== 'reverted' && p.state !== 'dismissed') throw new DreamError(`it was ${p.state} already.`);
    const ok = this.applyOne(dream, p);
    this.settlePlan(dream);
    this.changed(dream);
    if (!ok) throw new DreamError(p.error ?? 'it could not be applied.');
    return structuredClone(dream);
  }

  dismiss(proposalId: string): Dream {
    const { dream, p } = this.find(proposalId);
    if (!OPEN.includes(p.state) && p.state !== 'failed') throw new DreamError(`it was ${p.state} already.`);
    p.state = 'dismissed';
    p.decidedAt = this.now();
    this.settlePlan(dream);
    this.changed(dream);
    return structuredClone(dream);
  }

  applyAll(dreamId: string): Dream {
    const dream = this.dream(dreamId);
    const open = dream.proposals.filter((p) => OPEN.includes(p.state));
    if (!open.length) throw new DreamError('nothing in this dream waits to be applied.');
    for (const p of open) this.applyOne(dream, p);
    this.settlePlan(dream);
    this.changed(dream);
    const failed = open.filter((p) => p.state === 'failed');
    if (failed.length) throw new DreamError(`${failed.length} of ${open.length} could not be applied: ${failed[0].error}`);
    return structuredClone(dream);
  }

  revert(proposalId: string): Dream {
    const { dream, p } = this.find(proposalId);
    if (p.state !== 'applied') throw new DreamError('only an applied proposal can be reverted.');
    const rep = this.data.replaced[p.id];
    if (!rep) throw new DreamError('what it replaced was not kept, so it cannot be reverted here.');
    revertProposal(p, rep, this.roots(dream.cwd));
    p.state = 'reverted';
    p.decidedAt = this.now();
    delete this.data.replaced[p.id];
    this.changed(dream);
    return structuredClone(dream);
  }

  // ---------- The daily dream ----------

  /** The daily dream is due (on time, or missed while the app was closed and no dream ran in the last 20 hours). */
  tick(): void {
    const cfg = this.config();
    if (!cfg.daily) return;
    const t = this.now();
    const occ = latestOccurrence(cfg.time, t);
    if (this.data.dailyFor === undefined) {
      // Never handled (turned on in a settings file): from the next time on
      this.data.dailyFor = occ;
      this.save();
      return;
    }
    if (this.data.dailyFor >= occ || this.run) return;
    const missed = t - occ > ON_TIME_MS;
    this.data.dailyFor = occ;
    if (missed && this.data.lastRunAt !== undefined && t - this.data.lastRunAt < RECENT_MS) {
      this.save();
      return;
    }
    try {
      this.start('daily');
    } catch (err) {
      console.warn('[dreaming] the daily dream could not start:', err);
      this.save();
    }
  }

  /** Daily dreaming was turned on or re-timed: it runs from the next time on, not at once for a time already past. */
  onConfig(next: AppConfig, prev: AppConfig): void {
    const a = dreamingOf(next);
    const b = dreamingOf(prev);
    if (a.daily && (!b.daily || a.time !== b.time)) {
      this.data.dailyFor = latestOccurrence(a.time, this.now());
      this.save();
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) this.app.push('dreaming:changed', this.state());
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
  }

  /** Called once by setupDreaming: the event listener, the plan claim, the timer and the first check. */
  attach(opts: DreamingOptions = {}): void {
    this.disposers.push(this.app.events.on((id, ev) => this.onEvent(id, ev)));
    const rt = this.app.runtime as { claimPlans?: (fn: (id: string, plan: PlanInfo, d: 'build-ask' | 'build-acceptEdits' | 'keep') => boolean) => Disposer };
    if (typeof rt.claimPlans === 'function') this.disposers.push(rt.claimPlans((id, plan, d) => this.claimPlan(id, plan, d)));
    this.disposers.push(this.app.onConfig((next, prev) => this.onConfig(next, prev)));
    const setI = opts.setInterval ?? ((fn: () => void, ms: number) => {
      const h = setInterval(fn, ms);
      (h as { unref?: () => void }).unref?.();
      return h;
    });
    const clearI = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
    const handle = setI(() => this.tick(), opts.tickMs ?? TICK_MS);
    this.disposers.push(() => clearI(handle));
    const delay = opts.startDelayMs ?? 20_000;
    if (delay <= 0) this.tick();
    else {
      const first = setTimeout(() => this.tick(), delay);
      first.unref?.();
      this.disposers.push(() => clearTimeout(first));
    }
  }
}

/** A path as the user knows it: inside the project relative to it, under the home folder with ~. */
function shownPath(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** One proposal in a dream's plan. */
function planEntry(p: DreamProposal, n: number, cwd: string, title: (id: string) => string): string {
  const lines = [`### ${n}. ${p.title}`, '', p.why, ''];
  if (p.kind === 'skill') lines.push(`Writes \`${shownPath(p.target, cwd)}\`${p.changesExisting ? ', replacing what is there' : ''}. ${p.description}`);
  else if (p.kind === 'memory') {
    lines.push(`In \`${shownPath(p.target, cwd)}\`:`);
    for (const l of p.remove) lines.push(`- removes: ${l.replace(/^[-*]\s+/, '')}`);
    for (const l of p.add) lines.push(`- adds: ${l.replace(/^[-*]\s+/, '')}`);
  } else lines.push(`Writes the mod folder \`${shownPath(p.target, cwd)}\` (${p.files.length} file${p.files.length === 1 ? '' : 's'}); it stays off until you turn it on.`);
  lines.push('', `From ${p.sessions.map((s) => `“${title(s)}”`).join(', ')}.`);
  return lines.join('\n');
}

export { when, DreamError };
export type { DreamMode };
