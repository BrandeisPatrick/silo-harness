// The services features offer each other through app.provide(name, service) / app.service<T>(name).
// Types only: a feature that is not installed (or not built yet) is simply absent, so callers check for undefined.

import type { ContextBreakdown } from '../shared/context';
import type { HistoryRecord, SearchHit } from '../shared/history';
import type { ImageInfo } from '../shared/images';
import type { RemoteStatus } from '../shared/remote';
import type { Schedule, ScheduleInput, SchedulePatch } from '../shared/schedules';
import type { RelatedSessions } from '../shared/subagents';
import type { SessionMeta } from '../shared/types';
import type { RecentBlock } from '../shared/auto-mode';

/** app.service<HistoryService>('history') */
export interface HistoryService {
  /** Appends a record to a session's log */
  record(sessionId: string, type: string, data: unknown): void;
  search(query: string, opts?: { limit?: number; includeTrash?: boolean }): SearchHit[];
  /** A session's log, oldest record first (empty when it has none) */
  read(sessionId: string): HistoryRecord[];
}

/** app.service<ImagesService>('images') */
export interface ImagesService {
  /** The images the model showed in a session, oldest first */
  list(sessionId: string): ImageInfo[];
  get(sessionId: string, id: string): ImageInfo | undefined;
}

/** app.service<SchedulesService>('schedules') */
export interface SchedulesService {
  list(): Schedule[];
  /** `by` is who is asking; a schedule the agent creates goes through an approval card before this is called */
  create(input: ScheduleInput, by: 'user' | 'agent'): Schedule;
  update(id: string, patch: SchedulePatch): Schedule;
  remove(id: string): void;
  runNow(id: string): Schedule;
}

/** app.service<RemoteService>('remote') */
export interface RemoteService {
  status(): RemoteStatus;
  start(): Promise<RemoteStatus>;
  stop(): Promise<RemoteStatus>;
}

/** app.service<SubagentsService>('subagents') */
export interface SubagentsService {
  spawn(parentId: string, input: { title: string; prompt: string }): SessionMeta;
  merge(intoId: string, fromId: string): Promise<{ ok: boolean; error?: string }>;
  related(id: string): RelatedSessions;
}

/** app.service<ContextService>('context') */
export interface ContextService {
  /** What fills the context window of a session */
  breakdown(sessionId: string): ContextBreakdown;
}

/** app.service<SkillUsageService>('skill-usage') */
export interface SkillUsageService {
  usage(scope: 'session' | 'all', sessionId?: string): { name: string; count: number; lastUsedAt: number }[];
}

/** app.service<AutoBlocksService>('auto-blocks') */
export interface AutoBlocksService {
  /** A session's blocks of this app session (all of them, newest first), or the 20 newest of every session */
  list(sessionId?: string): RecentBlock[];
  /** Allows a blocked action once (Agent.allowBlocked) */
  allow(sessionId: string, id: string): { ok: boolean; error?: string };
}
