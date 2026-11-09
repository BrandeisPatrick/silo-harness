// Sub-sessions and messages between sessions. Types only.
//
// A sub-session is a session an agent (or the user, with /spawn) started from another one to do a piece of work in
// the background. It is a real session: it shows under its parent in the sidebar, can be opened and talked to, and
// tells its parent when it has finished a turn. Merging brings a summary of what it did into the parent.

import type { SendResult, SessionMeta } from './types';

export interface RelatedSessions {
  parent: SessionMeta | null;
  /** Sub-sessions spawned from this one, oldest first */
  children: SessionMeta[];
  /** Sessions forked from this one, oldest first */
  forks: SessionMeta[];
}

export interface SubagentsRpc {
  /** Starts a sub-session of `parentId` with `prompt` as its first message; it runs in the background */
  'sessions.spawn': (parentId: string, input: { title: string; prompt: string }) => SessionMeta;
  /**
   * Brings `fromId` (a sub-session or a fork of `intoId`) into `intoId`: a summary of what it did since it split off is
   * added to `intoId`'s conversation, and `fromId` is marked merged. Fails while either is running.
   */
  'sessions.merge': (intoId: string, fromId: string) => { ok: boolean; error?: string };
  'sessions.related': (id: string) => RelatedSessions;
  /**
   * Delivers a message from one session to another: it starts a run there, queues behind the current one, or (`held`)
   * waits while the receiver's plan waits for the user's decision
   */
  'sessions.message': (fromId: string, toId: string, text: string) => SendResult & { held?: boolean };
}
