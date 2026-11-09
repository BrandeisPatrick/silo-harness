// The generic RPC contract between the window and the main process: oc.rpc(method, …args) calls a handler
// registered with app.rpc.handle, and app.push(channel, payload) reaches oc.onPush(channel, cb). Each feature
// declares its methods and push channels in its own contract file; this file only joins them, so neither preload
// nor index.ts changes when a feature does. Types only.

import type { AppConfig, CommandInfo, CommandResult, LiveState, SessionMeta, TranscriptItem } from './types';
import type { ModsEvents, ModsRpc } from './mods';
import type { ContextRpc } from './context';
import type { HistoryRpc } from './history';
import type { ImagesRpc } from './images';
import type { PowerEvents, PowerRpc, SchedulesEvents, SchedulesRpc } from './schedules';
import type { SubagentsRpc } from './subagents';
import type { RemoteEvents, RemoteRpc } from './remote';
import type { SettingsEvents, SettingsRpc } from './settings-info';
import type { DreamingEvents, DreamingRpc } from './dreaming';
import type { ProvidersRpc } from './providers';
import type { HooksEvents, HooksRpc } from './hooks';
import type { BrowserEvents, BrowserRpc } from './browser';
import type { ChatCardsRpc } from './chat-cards';
import type { AutoModeRpc } from './auto-mode';

export interface CoreRpc {
  'commands.list': () => CommandInfo[];
  'commands.run': (name: string, args: string) => CommandResult;
  'sessions.live': (id: string) => LiveState;
  /** A session's transcript without bringing it on screen (sessions.switch does both) */
  'sessions.transcript': (id: string) => TranscriptItem[];
  /** The folder a session works in when none was chosen (~/Documents/Silo), made again if it is missing */
  'config.defaultWorkDir': () => string;
}

export interface CoreEvents {
  'config:changed': AppConfig;
  'sessions:changed': SessionMeta[];
  /** Bring this session on screen (a notification was clicked; every session was deleted and this is the fresh one) */
  'sessions:show': string;
}

export type RpcMethods = CoreRpc & ModsRpc & ContextRpc & HistoryRpc & ImagesRpc & SchedulesRpc & PowerRpc & SubagentsRpc & RemoteRpc & SettingsRpc & DreamingRpc & ProvidersRpc & HooksRpc & BrowserRpc & ChatCardsRpc & AutoModeRpc;
export type RpcEvents = CoreEvents & ModsEvents & SchedulesEvents & PowerEvents & RemoteEvents & SettingsEvents & DreamingEvents & HooksEvents & BrowserEvents;
