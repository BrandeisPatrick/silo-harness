// The session runtime: one Agent per session, any number of sessions running at once (up to MAX_RUNNING), and the
// one on screen (the foreground) tracked separately from the ones that run. Every agent event passes through here,
// tagged with its session, so the runtime always knows what is in flight in each session (LiveState) and whether it
// needs the user (SessionStatus). No Electron here: the headless tests drive it directly.

import type { AgentEvent, AppConfig, ApprovalScope, ImageAttachment, LiveState, PlanInfo, SendResult, SessionMeta, SessionOrigin, SessionStatus, StoredRules } from '../shared/types';
import { Agent, PLAN_APPROVED_TEXT, type SendOptions } from './agent';
import type { App, Disposer } from './app';
import type { ArtifactStore } from './artifacts';
import type { BrowserController } from './browser';
import type { McpManager } from './mcp';
import { toMeta, type Session, type SessionStore } from './sessions';
import type { Skill } from './skills';
import type { TerminalManager } from './terminal';
import type { Tool } from './tools';

/** How many sessions may run at once. */
export const MAX_RUNNING = 6;

export interface RuntimeOptions {
  store: SessionStore;
  config: () => AppConfig;
  /** The skills of a folder (project ones first) */
  skills: (cwd: string) => Skill[];
  /** The window's browser pane, or null while there is no window */
  browser: () => BrowserController | null;
  terminal?: TerminalManager;
  artifacts?: ArtifactStore;
  /** Read when an agent is made: the manager is created after the app, which it reads its config through */
  mcp?: () => McpManager | null;
  app?: App;
  /** Registered tools (app.tools) */
  tools?: () => Tool[];
  /**
   * Changes the app's config (app.updateConfig). Answering an approval or a plan may switch the permission mode or
   * save a project rule; without it (bare tests) those parts are skipped.
   */
  updateConfig?: (change: (current: AppConfig) => AppConfig) => AppConfig;
  /** Registered prompt sections (app.prompt), joined */
  prompt?: (info: { cwd: string; mode: AppConfig['permissionMode']; sessionId: string; essential?: boolean; restricted?: boolean }) => string;
}

/**
 * Takes over the decision on a plan that is not a build plan (a dream's): returns true when it handled it, and the
 * runtime then neither switches the permission mode nor starts a build run.
 */
export type PlanClaim = (sessionId: string, plan: PlanInfo, decision: 'build-ask' | 'build-acceptEdits' | 'keep') => boolean;

export interface CreateOptions {
  /** Default: the app's folder */
  cwd?: string;
  parentId?: string;
  /** Default 'user' */
  origin?: SessionOrigin;
  /** A fixed title (it is not replaced by a derived or generated one) */
  title?: string;
  /** Bring it on screen */
  foreground?: boolean;
}

/** What the runtime keeps per session about the run in progress (see LiveState). */
interface Live {
  running: boolean;
  startedAt?: number;
  text: string;
  thinking: string;
  tools: Map<string, { id: string; name: string; args: unknown }>;
  approvals: Map<string, Extract<AgentEvent, { type: 'approval_request' }>>;
  /** ask_user cards waiting for an answer */
  questions: Map<string, Extract<AgentEvent, { type: 'question_request' }>>;
  /** The last run ended with a plan the user has not decided on yet */
  planWaiting: boolean;
}

/**
 * The agents get this instead of the window's BrowserController: the window (and with it the controller) can be
 * closed and made again while the agents live on, so every call looks the current one up.
 */
function browserHandle(current: () => BrowserController | null): BrowserController {
  return new Proxy({} as BrowserController, {
    get(_target, key) {
      const b = current();
      if (!b) {
        if (key === 'then') return undefined;
        return () => Promise.reject(new Error('The browser pane is not available: the window is closed.'));
      }
      const v = (b as unknown as Record<PropertyKey, unknown>)[key];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(b) : v;
    },
  });
}

export class SessionRuntime {
  private readonly agents = new Map<string, Agent>();
  private readonly lives = new Map<string, Live>();
  private fg: string;
  private readonly browser: BrowserController;
  private readonly eventListeners = new Set<(sessionId: string, ev: AgentEvent) => void>();
  private readonly statusListeners = new Set<(sessionId: string, status: SessionStatus) => void>();
  private readonly listListeners = new Set<() => void>();
  private readonly foregroundListeners = new Set<(id: string, prev: string) => void>();
  private sink: ((sessionId: string, ev: AgentEvent) => void) | null = null;
  private readonly planClaims = new Set<PlanClaim>();

  constructor(private readonly opts: RuntimeOptions) {
    this.browser = browserHandle(opts.browser);
    this.fg = opts.store.create({ cwd: opts.config().workingDirectory, origin: 'user' }).id;
  }

  get store(): SessionStore {
    return this.opts.store;
  }

  // ---------- Foreground ----------

  /** The session on screen. */
  foregroundId(): string {
    if (!this.opts.store.get(this.fg)) this.fg = this.opts.store.create({ cwd: this.opts.config().workingDirectory, origin: 'user' }).id;
    return this.fg;
  }

  /** Brings a session on screen: it is marked read, and the foreground listeners run (the app moves its folder there). */
  setForeground(id: string): Session {
    const s = this.opts.store.get(id);
    if (!s) throw new Error(`No conversation ${id}`);
    const prev = this.fg;
    this.fg = id;
    if (s.unread) {
      s.unread = false;
      this.opts.store.save(s, false);
      this.statusChanged(id);
    }
    if (prev !== id) for (const cb of [...this.foregroundListeners]) cb(id, prev);
    return s;
  }

  onForeground(cb: (id: string, prev: string) => void): Disposer {
    this.foregroundListeners.add(cb);
    return () => this.foregroundListeners.delete(cb);
  }

  // ---------- Sessions and their agents ----------

  get(id: string): Session | undefined {
    return this.opts.store.get(id);
  }

  /** The agent bound to the session for the rest of its life, made on first use. */
  agentFor(id: string): Agent {
    const known = this.agents.get(id);
    if (known) return known;
    const session = this.opts.store.get(id);
    if (!session) throw new Error(`No conversation ${id}`);
    const o = this.opts;
    const agent = new Agent(o.config, this.browser, o.store, o.skills, (ev) => this.dispatch(id, ev), o.terminal, o.artifacts, o.mcp?.() ?? undefined, {
      session,
      app: o.app,
      foreground: () => this.fg === id,
      tools: o.tools,
      prompt: o.prompt,
    });
    this.agents.set(id, agent);
    return agent;
  }

  /** A new session. It is listed once it has messages (send to it, or bring it on screen). */
  create(opts: CreateOptions = {}): SessionMeta {
    const s = this.opts.store.create({ cwd: opts.cwd ?? this.opts.config().workingDirectory, parentId: opts.parentId, origin: opts.origin ?? 'user', title: opts.title });
    if (opts.foreground) this.setForeground(s.id);
    this.listChanged();
    return this.meta(s.id);
  }

  /** Stops and forgets a deleted session's agent. The caller deletes the session from the store. */
  forget(id: string): void {
    const agent = this.agents.get(id);
    agent?.stop();
    void agent?.endSession('deleted').catch(() => undefined);
    this.agents.delete(id);
    this.lives.delete(id);
    this.listChanged();
  }

  /**
   * Starts a run in the session, or queues the message when the session is running (it reaches the model after the
   * current step). Refused while the session compacts and when MAX_RUNNING sessions already run.
   */
  send(id: string, text: string, attachments: ImageAttachment[] = [], opts: SendOptions = {}): SendResult {
    if (!text.trim() && !attachments.length) return { ok: false, error: 'Nothing to send.' };
    let agent: Agent;
    try {
      agent = this.agentFor(id);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (agent.compacting) return { ok: false, error: 'The context is being compacted; send the message again in a moment.' };
    if (agent.running) {
      const queued = agent.enqueue(text, attachments, { ...opts, origin: opts.origin ?? 'queue' });
      return { ok: true, queued: true, id: queued.id };
    }
    if (this.running().length >= MAX_RUNNING) return { ok: false, error: `${MAX_RUNNING} sessions are already running. Wait for one to finish, or stop one, then send again.` };
    agent.run(text, attachments, opts).catch((err: unknown) => console.error('[agent] run failed', err));
    return { ok: true };
  }

  stop(id: string): void {
    this.agents.get(id)?.stop();
  }

  /** SessionEnd for every session that started in this app session (the app quits); resolves when their hooks are done. */
  async endSessions(reason: 'quit' | 'deleted' = 'quit'): Promise<void> {
    await Promise.all([...this.agents.values()].map((a) => a.endSession(reason).catch(() => undefined)));
  }

  stopAll(): void {
    for (const a of this.agents.values()) a.stop();
  }

  isRunning(id: string): boolean {
    return this.agents.get(id)?.running === true;
  }

  /** Ids of the sessions with a run in progress. */
  running(): string[] {
    return [...this.agents.entries()].filter(([, a]) => a.running).map(([id]) => id);
  }

  status(id: string): SessionStatus {
    const live = this.lives.get(id);
    const running = this.isRunning(id);
    const st: SessionStatus = { running };
    if (live?.approvals.size) st.attention = 'approval';
    else if (live?.questions.size) st.attention = 'question';
    else if (live?.planWaiting && !running) st.attention = 'plan';
    if (this.opts.store.get(id)?.unread) st.unread = true;
    return st;
  }

  /** What is in flight in the session (all empty when it is idle). */
  live(id: string): LiveState {
    const l = this.lives.get(id);
    const agent = this.agents.get(id);
    const running = agent?.running === true;
    if (!l || !running) return { running: false, text: '', thinking: '', tools: [], approvals: [], questions: [], queue: [] };
    return {
      running: true,
      startedAt: l.startedAt,
      text: l.text,
      thinking: l.thinking,
      tools: [...l.tools.values()].map((t) => ({ ...t })),
      approvals: [...l.approvals.values()].map((a) => ({ ...a })),
      questions: [...l.questions.values()].map((q) => ({ ...q })),
      queue: agent?.queue() ?? [],
    };
  }

  meta(id: string): SessionMeta {
    const s = this.opts.store.get(id);
    if (!s) throw new Error(`No conversation ${id}`);
    return { ...toMeta(s), status: this.status(id) };
  }

  /** The stored sessions (those with messages), newest first, with their status. */
  list(): SessionMeta[] {
    return this.opts.store.list().map((m) => ({ ...m, status: this.status(m.id) }));
  }

  /** The agent waiting on the approval card `id`. */
  findApproval(id: string): Agent | undefined {
    for (const a of this.agents.values()) if (a.hasApproval(id)) return a;
    return undefined;
  }

  /** The agent waiting on the question card `id` (ask_user). */
  findQuestion(id: string): Agent | undefined {
    for (const a of this.agents.values()) if (a.hasQuestion(id)) return a;
    return undefined;
  }

  /** Answers a question card, whichever session holds it (null skips it). False when no session waits on it any more. */
  respondQuestion(id: string, answers: unknown): boolean {
    return this.findQuestion(id)?.resolveQuestion(id, answers) ?? false;
  }

  /** The agent holding the queued message `id`. */
  findQueued(id: string): Agent | undefined {
    for (const a of this.agents.values()) if (a.hasQueued(id)) return a;
    return undefined;
  }

  /**
   * Answers an approval card, whichever session holds it, with everything the answer implies (a mode switch, a saved
   * project rule, a browser site always allowed). False when no session has that card any more.
   */
  respondApproval(id: string, ok: boolean, always = false, scope: ApprovalScope = 'session'): boolean {
    const agent = this.findApproval(id);
    if (!agent) return false;
    // The rule belongs to the folder of the session that asked, which need not be the one on screen.
    const cwd = agent.cwd();
    const outcome = agent.resolveApproval(id, ok, always, scope === 'project' ? 'project' : 'session');
    const update = this.opts.updateConfig;
    if (!update) return true;
    if (outcome.setMode) {
      const mode = outcome.setMode;
      update((c) => ({ ...c, permissionMode: mode }));
    }
    const rule = outcome.rule;
    if (rule?.kind === 'site') {
      // "Always allow example.com": saved on this Mac for every project (Settings → Browser lists it), not in allowRules
      update((c) => ({ ...c, browser: { ...c.browser, alwaysAllowed: [...new Set([...(c.browser?.alwaysAllowed ?? []), ...rule.values])] } }));
    } else if (rule) {
      update((c) => {
        const r: StoredRules = { ...(c.allowRules?.[cwd] ?? {}) };
        const add = (list: string[] | undefined) => [...new Set([...(list ?? []), ...rule.values])];
        if (rule.kind === 'program') r.programs = add(r.programs);
        else if (rule.kind === 'reason') r.reasons = add(r.reasons);
        else if (rule.kind === 'mcp') r.mcp = add(r.mcp);
        else if (rule.kind === 'edits') r.edits = true;
        return { ...c, allowRules: { ...(c.allowRules ?? {}), [cwd]: r } };
      });
    }
    return true;
  }

  /**
   * Allows an action Auto mode blocked in a session (Agent.allowBlocked): it runs once when the agent tries it again.
   * Not ok when the session or the block is not known in this app session.
   */
  allowBlocked(sessionId: string, id: string): { ok: boolean; error?: string } {
    const agent = this.agents.get(sessionId);
    if (!agent) return { ok: false, error: 'This block is from before the app started; ask the agent to try again.' };
    return agent.allowBlocked(id);
  }

  /** A feature that decides plans of its own (see PlanClaim). */
  claimPlans(fn: PlanClaim): Disposer {
    this.planClaims.add(fn);
    return () => this.planClaims.delete(fn);
  }

  /**
   * Decides a proposed plan of a session; the build decisions switch the permission mode and start the build run.
   * A plan a feature claims (a dream's) is marked decided here and handed to it instead.
   */
  respondPlan(sessionId: string, planId: string, decision: 'build-ask' | 'build-acceptEdits' | 'keep'): void {
    if (decision !== 'build-ask' && decision !== 'build-acceptEdits' && decision !== 'keep') throw new Error(`Unknown plan decision ${decision}`);
    const agent = this.agentFor(sessionId);
    if (agent.running) throw new Error('Wait for the current run to finish before deciding on the plan.');
    const plan = agent.respondPlan(planId, decision);
    this.planDecided(sessionId);
    for (const claim of [...this.planClaims]) {
      if (!claim(sessionId, plan, decision)) continue;
      const s = this.opts.store.get(sessionId);
      if (s) this.dispatch(sessionId, { type: 'session_changed', session: toMeta(s) });
      return;
    }
    if (decision !== 'keep') this.opts.updateConfig?.((c) => ({ ...c, permissionMode: decision === 'build-ask' ? 'ask' : 'acceptEdits' }));
    const s = this.opts.store.get(sessionId);
    if (s) this.dispatch(sessionId, { type: 'session_changed', session: toMeta(s) });
    if (decision === 'keep') return;
    const r = this.send(sessionId, PLAN_APPROVED_TEXT);
    if (!r.ok) throw new Error(r.error ?? 'Could not start the build.');
  }

  /** The session's proposed plan was decided: it no longer waits for the user. */
  planDecided(id: string): void {
    const l = this.lives.get(id);
    if (!l?.planWaiting) return;
    l.planWaiting = false;
    this.statusChanged(id);
  }

  // ---------- Events ----------

  /** Every event of every session, in order, after the runtime has noted it and before the window gets it. */
  onEvent(cb: (sessionId: string, ev: AgentEvent) => void): Disposer {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** A session's status changed (a run started or ended, it waits for the user or no longer does, it was read). */
  onStatus(cb: (sessionId: string, status: SessionStatus) => void): Disposer {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /** Something the session list shows changed: a status, or a session was made or forgotten. */
  onListChanged(cb: () => void): Disposer {
    this.listListeners.add(cb);
    return () => this.listListeners.delete(cb);
  }

  /** The window: called last for each event (the app coalesces and sends it). */
  setSink(sink: ((sessionId: string, ev: AgentEvent) => void) | null): void {
    this.sink = sink;
  }

  private liveOf(id: string): Live {
    let l = this.lives.get(id);
    if (!l) {
      l = { running: false, text: '', thinking: '', tools: new Map(), approvals: new Map(), questions: new Map(), planWaiting: false };
      this.lives.set(id, l);
    }
    return l;
  }

  /**
   * Puts an event on a session's stream (app.events listeners, the window) when no run of that session produced it:
   * a merge note appended between runs, for example.
   */
  emit(id: string, ev: AgentEvent): void {
    this.dispatch(id, ev);
  }

  /** Notes what the event changes in the session's LiveState and status, then hands it on. */
  private dispatch(id: string, ev: AgentEvent): void {
    const l = this.liveOf(id);
    let status = false;
    switch (ev.type) {
      case 'run_start':
        Object.assign(l, { running: true, startedAt: Date.now(), text: '', thinking: '', planWaiting: false });
        l.tools.clear();
        l.approvals.clear();
        l.questions.clear();
        status = true;
        break;
      case 'user_message': {
        // A message from another session reached a session that is not on screen: the sidebar marks it at once
        const s = ev.origin === 'session' && id !== this.fg ? this.opts.store.get(id) : undefined;
        if (s && !s.unread) {
          s.unread = true;
          this.opts.store.save(s, false);
          status = true;
        }
        break;
      }
      case 'text_delta':
        l.text += ev.text;
        break;
      case 'thinking_delta':
        l.thinking += ev.text;
        break;
      case 'thinking_done':
        // Emitted once the model call is complete: its text is about to become a message (assistant_message) or be
        // dropped (an empty reply), so nothing of it is in flight any more. A finished thought is not kept: the
        // transcript does not store thinking, so a window that switches here sees what a reload would.
        l.text = '';
        l.thinking = '';
        break;
      case 'assistant_message':
        l.text = '';
        l.thinking = '';
        break;
      case 'tool_start':
        l.tools.set(ev.id, { id: ev.id, name: ev.name, args: ev.args });
        break;
      case 'tool_end':
        l.tools.delete(ev.id);
        break;
      case 'approval_request':
        l.approvals.set(ev.id, ev);
        status = true;
        break;
      case 'approval_resolved':
        status = l.approvals.delete(ev.id);
        break;
      case 'question_request':
        l.questions.set(ev.id, ev);
        status = true;
        break;
      case 'question_resolved':
        status = l.questions.delete(ev.id);
        break;
      case 'plan_proposed':
        l.planWaiting = true;
        // A plan put on a session between runs (a dream's) waits for the user from now on
        status = !this.isRunning(id);
        break;
      case 'run_end': {
        Object.assign(l, { running: false, startedAt: undefined, text: '', thinking: '' });
        l.tools.clear();
        l.approvals.clear();
        l.questions.clear();
        if (ev.reason !== 'plan') l.planWaiting = false;
        const s = this.opts.store.get(id);
        if (s && id !== this.fg && !s.unread) {
          s.unread = true;
          this.opts.store.save(s, false);
        }
        status = true;
        break;
      }
    }
    for (const cb of [...this.eventListeners]) {
      try {
        cb(id, ev);
      } catch (err) {
        console.warn('[runtime] an event listener failed:', err);
      }
    }
    this.sink?.(id, ev);
    if (status) this.statusChanged(id);
  }

  private statusChanged(id: string): void {
    const st = this.status(id);
    for (const cb of [...this.statusListeners]) {
      try {
        cb(id, st);
      } catch (err) {
        console.warn('[runtime] a status listener failed:', err);
      }
    }
    this.listChanged();
  }

  private listChanged(): void {
    for (const cb of [...this.listListeners]) {
      try {
        cb();
      } catch (err) {
        console.warn('[runtime] a list listener failed:', err);
      }
    }
  }
}
