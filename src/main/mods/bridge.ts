// mods.call: the bridge calls the window forwards from mod pages. Each call is checked here again, whatever the
// window already checked: the mod must be on, the method must exist and be one main answers, the mod must hold the
// permission, and the params must have the right shape. Errors use the protocol's codes (permissions.ts).

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { App } from '../app';
import type { ContextBreakdown, ContextSlice } from '../../shared/context';
import type { SearchHit } from '../../shared/history';
import type { ModCaller, ModInfo, ModMethod, ModPermission, ModSession, ModTranscriptItem, OutputItem } from '../../shared/mods';
import type { ScheduleInput, SchedulePatch } from '../../shared/schedules';
import type { SessionMeta, TranscriptItem } from '../../shared/types';
import type { ContextService, HistoryService, ImagesService, RemoteService, SchedulesService, SubagentsService } from '../services';
import { formatBytes, kindLabel } from '../artifacts';
import { gitInfo, listChanges } from '../changes';
import { COMPACT_THRESHOLD } from '../compact';
import { loadSkills, toInfo } from '../skills';
import { latestPlan, toMeta, toTranscript, type Session } from '../sessions';
import { MOD_METHOD_PERMISSIONS, ModError, isWindowMethod } from './permissions';
import { ModStorage, StorageError } from './storage';
import { applyPublicPatch, PatchError, publicConfig } from './public-config';
import { buildMessages, checkModelRequest, completeOnce, MODEL_MAX_IN_FLIGHT, ModelCallError } from './model';
import type { ModRegistry } from './registry';
import type { SkillUsageTracker } from './skill-usage';

export const TRANSCRIPT_TEXT_MAX = 20_000;

export type BridgeReply = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

class BridgeError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}
const badParams = (message: string) => new BridgeError(ModError.badParams, message);
const unavailable = (what: string) => new BridgeError(ModError.unavailable, `${what} is not available in this version of the app.`);

// ---------- Param checks ----------

type P = Record<string, unknown>;

function params(p: unknown): P {
  if (p === undefined || p === null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) throw badParams('params: must be an object');
  return p as P;
}

function str(p: P, k: string, opts: { optional?: boolean; max?: number; empty?: boolean } = {}): string | undefined {
  const v = p[k];
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== 'string') throw badParams(`${k}: must be a string`);
  if (!opts.empty && !v.trim()) throw badParams(`${k}: must not be empty`);
  if (opts.max && v.length > opts.max) throw badParams(`${k}: at most ${opts.max} characters`);
  return v;
}

function int(p: P, k: string, min: number, max: number): number | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw badParams(`${k}: must be a number of at least ${min}`);
  return Math.min(max, Math.floor(v));
}

function scopeOf(p: P): 'mod' | 'session' {
  const s = p.scope ?? 'mod';
  if (s !== 'mod' && s !== 'session') throw badParams('scope: must be "mod" or "session"');
  return s;
}

function obj(p: P, k: string): P {
  const v = p[k];
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw badParams(`${k}: must be an object`);
  return v as P;
}

// ---------- Shapes ----------

export function toModSession(m: SessionMeta, cwd: string): ModSession {
  const s: ModSession = {
    id: m.id,
    title: m.title,
    cwd: m.cwd ?? cwd,
    origin: m.origin ?? (m.forkedFrom ? 'fork' : 'user'),
    messageCount: m.messageCount,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    running: !!m.status?.running,
  };
  if (m.parentId) s.parentId = m.parentId;
  if (m.forkedFrom) s.forkedFrom = m.forkedFrom;
  if (m.status?.attention) s.attention = m.status.attention;
  return s;
}

const cut = (s: string, max = TRANSCRIPT_TEXT_MAX) => (s.length > max ? `${s.slice(0, max)} …[${s.length - max} more characters]` : s);

export function toModTranscript(items: TranscriptItem[]): ModTranscriptItem[] {
  return items.map((i): ModTranscriptItem => {
    switch (i.role) {
      case 'user': {
        const item: ModTranscriptItem = { role: 'user', text: cut(i.text) };
        if (i.images?.length) item.images = i.images.length;
        return item;
      }
      case 'assistant':
        return { role: 'assistant', text: cut(i.text) };
      case 'tool':
        return { role: 'tool', text: cut(i.result), name: i.name, args: cut(i.args, 4000), ok: i.ok };
      case 'proposal':
        return { role: 'tool', text: cut(i.result), name: i.name, args: cut(i.args, 4000), ok: true };
      case 'plan':
        return { role: 'plan', text: cut(i.plan.markdown), name: i.plan.title };
      case 'artifact':
        return { role: 'artifact', text: i.artifact.title, name: i.artifact.id };
      case 'image':
        return { role: 'image', text: i.image.caption || i.image.name, name: i.image.id };
      case 'compaction':
        return { role: 'compaction', text: cut(i.compaction.summary) };
      // A call Auto mode's check blocked reads as the call it was, refused
      case 'auto_blocked':
        return { role: 'tool', text: `Blocked by Auto mode: ${i.block.reason}`, name: i.block.name, args: cut(i.block.what, 4000), ok: false };
    }
  });
}

/** A breakdown from the agent's own estimate, for when no context service is installed. */
export function simpleBreakdown(info: { tokens: number; limit: number; threshold: number; autoCompact: boolean }, s: Session | undefined, reported: boolean, running = false): ContextBreakdown {
  const limit = Math.max(1, info.limit);
  const used = Math.min(limit, Math.max(0, Math.round(info.tokens)));
  const reserve = Math.max(0, Math.min(limit - used, Math.round(limit * (1 - (info.threshold || COMPACT_THRESHOLD)))));
  const free = Math.max(0, limit - used - reserve);
  const slices: ContextSlice[] = [
    { key: 'messages', label: 'In use', tokens: used },
    { key: 'reserve', label: 'Reserved for compaction', tokens: reserve },
    { key: 'free', label: 'Free', tokens: free },
  ];
  const last = s?.compactions?.[s.compactions.length - 1];
  const out: ContextBreakdown = {
    tokens: used,
    limit,
    threshold: info.threshold,
    autoCompact: info.autoCompact,
    compactable: !running && (s?.messages.length ?? 0) >= 2,
    basis: reported ? 'reported' : 'estimated',
    slices,
    messages: s?.messages.length ?? 0,
    compactions: s?.compactions?.length ?? 0,
    updatedAt: Date.now(),
  };
  if (last) out.lastCompaction = { at: last.createdAt, reason: last.reason, tokensBefore: last.tokensBefore, tokensAfter: last.tokensAfter };
  return out;
}

// ---------- The bridge ----------

export interface BridgeOptions {
  app: App;
  registry: ModRegistry;
  storage: ModStorage;
  usage: SkillUsageTracker;
  /** model.delta and other per-mod events */
  emit: (mod: string, name: string, data: unknown) => void;
  /** Whether Settings may preview the mod's looks before they are used (its preview frames are answered then) */
  previewable?: (mod: ModInfo) => boolean;
}

export class ModBridgeHandler {
  private calls = new Map<string, Map<string, AbortController>>();

  constructor(private readonly o: BridgeOptions) {}

  private get app(): App {
    return this.o.app;
  }

  async call(caller: unknown, method: unknown, rawParams: unknown): Promise<BridgeReply> {
    try {
      const c = caller as ModCaller | null;
      if (!c || typeof c !== 'object' || typeof c.mod !== 'string') throw badParams('caller: must name the mod');
      const mod = this.o.registry.get(c.mod);
      // A mod that is on, one whose looks may be used (its background in the window), or a preview in Settings
      const live = !!mod && (mod.state === 'on' || mod.approved === true || (c.preview === true && !!this.o.previewable?.(mod)));
      if (!mod || !live) throw new BridgeError(ModError.unavailable, `The mod ${c.mod} is not on.`);
      if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(MOD_METHOD_PERMISSIONS, method)) {
        throw new BridgeError(ModError.unknownMethod, `Unknown method ${String(method)}.`);
      }
      if (isWindowMethod(method)) throw new BridgeError(ModError.unknownMethod, `${method} is handled by the window.`);
      const need = MOD_METHOD_PERMISSIONS[method as ModMethod];
      if (need && !mod.granted.includes(need)) {
        throw new BridgeError(ModError.permission, `${method} needs the ${need} permission; add it to "permissions" in mod.json.`, { permission: need });
      }
      const result = await this.dispatch(mod, method as ModMethod, params(rawParams));
      return { result: result === undefined ? null : result };
    } catch (err) {
      if (err instanceof BridgeError) return { error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } };
      if (err instanceof StorageError) return { error: { code: err.kind === 'params' ? ModError.badParams : ModError.other, message: err.message } };
      if (err instanceof PatchError) return { error: { code: ModError.badParams, message: err.message } };
      if (err instanceof ModelCallError) return { error: { code: err.code, message: err.message } };
      return { error: { code: ModError.other, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  private fg(): string {
    return this.app.runtime.foregroundId();
  }

  private session(): Session | undefined {
    return this.app.store.get(this.fg());
  }

  private meta(id: string): SessionMeta | undefined {
    const listed = this.app.runtime.list().find((m) => m.id === id);
    if (listed) return listed;
    const s = this.app.store.get(id);
    return s ? { ...toMeta(s), status: this.app.runtime.status(id) } : undefined;
  }

  private cwd(): string {
    return this.app.config().workingDirectory;
  }

  private service<T>(name: string, what: string): T {
    const s = this.app.service<T>(name);
    if (!s) throw unavailable(what);
    return s;
  }

  private async dispatch(mod: ModInfo, method: ModMethod, p: P): Promise<unknown> {
    const fg = this.fg();
    switch (method) {
      case 'storage.get':
        return { value: this.o.storage.get(mod.key, scopeOf(p), fg, ModStorage.checkKey(p.key)) };
      case 'storage.set':
        if (!('value' in p)) throw badParams('value: missing');
        return void this.o.storage.set(mod.key, scopeOf(p), fg, ModStorage.checkKey(p.key), p.value);
      case 'storage.remove':
        return void this.o.storage.remove(mod.key, scopeOf(p), fg, ModStorage.checkKey(p.key));
      case 'storage.keys':
        return { keys: this.o.storage.keys(mod.key, scopeOf(p), fg) };
      case 'settings.get':
        return { ...mod.settings };

      case 'session.get': {
        const m = this.meta(fg);
        if (!m) throw new BridgeError(ModError.unavailable, 'No session is open.');
        return toModSession(m, this.cwd());
      }
      case 'session.transcript': {
        const limit = int(p, 'limit', 1, 100_000);
        const s = this.session();
        // Calls still in flight are left out, as in the window: tool.started and tool.ended report them
        const items = s ? toModTranscript(toTranscript(s, { running: this.app.runtime.isRunning(s.id) })) : [];
        return { items: limit ? items.slice(-limit) : items };
      }
      case 'session.tasks':
        return { tasks: (this.session()?.tasks ?? []).map((t) => ({ ...t })) };
      case 'session.plan':
        return { plan: (this.session() && latestPlan(this.session()!)) ?? null };
      case 'session.outputs':
        return { outputs: await this.outputs(fg) };
      case 'session.context': {
        const svc = this.app.service<ContextService>('context');
        if (svc) return svc.breakdown(fg);
        const s = this.session();
        return simpleBreakdown(this.app.runtime.agentFor(fg).contextInfo(), s, !!s?.lastPrompt, this.app.runtime.isRunning(fg));
      }
      case 'session.related': {
        const svc = this.app.service<SubagentsService>('subagents');
        const cwd = this.cwd();
        if (svc) {
          const r = svc.related(fg);
          return { parent: r.parent ? toModSession(r.parent, cwd) : null, children: r.children.map((m) => toModSession(m, cwd)), forks: r.forks.map((m) => toModSession(m, cwd)) };
        }
        const all = this.app.runtime.list();
        const me = this.meta(fg);
        const parent = me?.parentId ? all.find((m) => m.id === me.parentId) : undefined;
        const byAge = (a: SessionMeta, b: SessionMeta) => a.createdAt - b.createdAt;
        return {
          parent: parent ? toModSession(parent, cwd) : null,
          children: all.filter((m) => m.parentId === fg).sort(byAge).map((m) => toModSession(m, cwd)),
          forks: all.filter((m) => m.forkedFrom === fg).sort(byAge).map((m) => toModSession(m, cwd)),
        };
      }

      case 'session.send': {
        const text = str(p, 'text', { max: 100_000 })!;
        return this.app.runtime.send(fg, text, [], { origin: 'mod', from: mod.manifest?.name ?? mod.id });
      }
      case 'session.stop':
        return void this.app.runtime.stop(fg);
      case 'session.compact': {
        const focus = str(p, 'focus', { optional: true, max: 2000, empty: true });
        return this.app.runtime.agentFor(fg).compactNow(focus?.trim() || undefined);
      }
      case 'sessions.spawn': {
        const title = str(p, 'title', { max: 200 })!;
        const prompt = str(p, 'prompt', { max: 100_000 })!;
        const svc = this.service<SubagentsService>('subagents', 'Starting sub-sessions');
        return toModSession(svc.spawn(fg, { title, prompt }), this.cwd());
      }
      case 'sessions.merge': {
        const id = str(p, 'id', { max: 200 })!;
        return this.service<SubagentsService>('subagents', 'Merging sub-sessions').merge(fg, id);
      }

      case 'sessions.list':
        return { sessions: this.app.runtime.list().map((m) => toModSession(m, this.cwd())) };
      case 'sessions.search': {
        const query = str(p, 'query', { max: 500 })!;
        const limit = int(p, 'limit', 1, 200) ?? 20;
        const svc = this.app.service<HistoryService>('history');
        if (svc) return { hits: svc.search(query, { limit }) };
        return { hits: titleSearch(this.app.runtime.list(), query, limit) };
      }

      case 'model.complete':
        return this.complete(mod, p);
      case 'model.cancel': {
        const id = str(p, 'requestId', { optional: true, max: 100 });
        const mine = this.calls.get(mod.key);
        if (mine) for (const [rid, ctrl] of mine) if (!id || rid === id) ctrl.abort();
        return undefined;
      }

      case 'skills.list':
        return { skills: loadSkills(this.cwd(), this.app.appRoot).map(toInfo) };
      case 'skills.usage': {
        const scope = p.scope ?? 'session';
        if (scope !== 'session' && scope !== 'all') throw badParams('scope: must be "session" or "all"');
        return { items: this.o.usage.usage(scope, fg) };
      }

      case 'config.get':
        return publicConfig(this.app.config(), this.meta(fg)?.cwd);
      case 'config.set': {
        const patch = p.patch;
        const list = this.o.registry.list();
        applyPublicPatch(this.app.config(), patch, list); // validate before anything is written
        const next = this.app.updateConfig((cur) => applyPublicPatch(cur, patch, list));
        return publicConfig(next, this.meta(fg)?.cwd);
      }
      case 'project.git':
        return gitInfo(this.meta(fg)?.cwd || this.cwd());

      case 'schedules.list':
        return { schedules: this.service<SchedulesService>('schedules', 'Scheduled tasks').list() };
      case 'schedules.create': {
        const input = obj(p, 'input');
        str(input, 'name', { max: 200 });
        str(input, 'prompt', { max: 100_000 });
        const when = obj(input, 'when');
        if (!['at', 'every', 'cron'].includes(String(when.kind))) throw badParams('input.when.kind: must be "at", "every" or "cron"');
        // The user granted this mod the schedules permission, so it creates as the user would (no approval card).
        return this.service<SchedulesService>('schedules', 'Scheduled tasks').create(input as unknown as ScheduleInput, 'user');
      }
      case 'schedules.update': {
        const id = str(p, 'id', { max: 200 })!;
        const patch = obj(p, 'patch');
        return this.service<SchedulesService>('schedules', 'Scheduled tasks').update(id, patch as SchedulePatch);
      }
      case 'schedules.remove':
        return void this.service<SchedulesService>('schedules', 'Scheduled tasks').remove(str(p, 'id', { max: 200 })!);
      case 'schedules.runNow':
        return void this.service<SchedulesService>('schedules', 'Scheduled tasks').runNow(str(p, 'id', { max: 200 })!);

      case 'remote.status':
        return this.service<RemoteService>('remote', 'Remote control').status();
      case 'remote.start':
        return this.service<RemoteService>('remote', 'Remote control').start();
      case 'remote.stop':
        return this.service<RemoteService>('remote', 'Remote control').stop();

      default:
        throw new BridgeError(ModError.unknownMethod, `Unknown method ${method}.`);
    }
  }

  private async outputs(fg: string): Promise<OutputItem[]> {
    const s = this.session();
    const out: OutputItem[] = [];
    for (const a of Object.values(s?.artifacts ?? {})) {
      out.push({ kind: 'artifact', id: a.id, title: a.title, detail: `${kindLabel(a)} · v${a.version}`, updatedAt: a.updatedAt });
    }
    const images = this.app.service<ImagesService>('images');
    for (const i of images?.list(fg) ?? []) {
      const type = i.mime.replace(/^image\//, '').replace('svg+xml', 'svg').toUpperCase();
      const size = i.width && i.height ? `${i.width}×${i.height}` : formatBytes(i.bytes);
      out.push({ kind: 'image', id: i.id, title: i.caption || i.name, detail: `${type} · ${size}`, updatedAt: i.createdAt });
    }
    if (s) {
      const cwd = this.meta(fg)?.cwd ?? this.cwd();
      const changes = await listChanges(s, cwd).catch(() => []);
      for (const c of changes) {
        let at = 0;
        try {
          at = fs.statSync(c.path).mtimeMs;
        } catch {
          at = s.updatedAt;
        }
        const detail = c.status === 'deleted' ? `deleted · −${c.deletions}` : `+${c.additions} −${c.deletions}`;
        out.push({ kind: 'file', id: c.path, title: c.relPath, detail, updatedAt: Math.round(at) });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async complete(mod: ModInfo, p: P): Promise<unknown> {
    const call = checkModelRequest(p, () => randomUUID());
    if (typeof call === 'string') throw badParams(call);
    const mine = this.calls.get(mod.key) ?? new Map<string, AbortController>();
    if (mine.size >= MODEL_MAX_IN_FLIGHT) throw new BridgeError(ModError.unavailable, `This mod already has ${MODEL_MAX_IN_FLIGHT} model calls running; wait for one to finish or cancel it.`);
    if (mine.has(call.requestId)) throw badParams(`requestId: "${call.requestId}" is already running`);
    const ctrl = new AbortController();
    mine.set(call.requestId, ctrl);
    this.calls.set(mod.key, mine);
    try {
      const cfg = this.app.config();
      const messages = buildMessages(cfg, call, call.context === 'session' ? this.session()?.messages ?? null : null);
      const r = await completeOnce(cfg, messages, call.maxTokens, ctrl.signal, (text) => this.o.emit(mod.key, 'model.delta', { requestId: call.requestId, text }));
      return { text: r.text, ...(r.usage ? { usage: r.usage } : {}), ...(r.stopped ? { stopped: true } : {}) };
    } finally {
      mine.delete(call.requestId);
      if (!mine.size) this.calls.delete(mod.key);
    }
  }

  /** Aborts every model call (a mod went off, or the app quits); with `key`, only that mod's. */
  cancelAll(key?: string): void {
    for (const [k, m] of this.calls) if (!key || k === key) for (const c of m.values()) c.abort();
  }

  inFlight(key: string): number {
    return this.calls.get(key)?.size ?? 0;
  }
}

/** sessions.search without the history service: a case-insensitive match on titles. */
export function titleSearch(list: SessionMeta[], query: string, limit: number): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const m of [...list].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const at = m.title.toLowerCase().indexOf(q);
    if (at < 0) continue;
    hits.push({ sessionId: m.id, title: m.title, updatedAt: m.updatedAt, role: 'title', snippet: m.title, matchStart: at, matchEnd: at + q.length, count: 1 });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Whether a mod holds a permission (for filtering events): it is on, or its looks may be used, and was granted it. */
export function holds(mod: ModInfo, need: ModPermission | null): boolean {
  return (mod.state === 'on' || mod.approved === true) && (!need || mod.granted.includes(need));
}
