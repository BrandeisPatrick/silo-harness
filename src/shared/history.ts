// The history log: an append-only record of everything that happens in a session, kept beside the session file.
// Nothing in it is ever rewritten: a rewind, a compaction or a delete adds a record instead of removing one.
// Types only.

import type { SessionMeta } from './types';

/**
 * One line of <userData>/history/<sessionId>.jsonl.
 *
 * Conversation records (the model's view can be rebuilt from these alone):
 *   message.append    { index, message }            a message was added at `index` (the exact chat message)
 *   messages.truncate { length, removed }            a rewind cut the conversation back to `length` messages
 *   messages.replace  { reason, messages, removed }  a compaction or a prune replaced the conversation
 *   snapshot          { messages }                   the session file was saved with this many messages
 *
 * Everything else is context for people and tools:
 *   session.created { title, cwd, origin, parentId?, forkedFrom?, seedLength? } · session.renamed { title }
 *   session.deleted {} · session.restored {} · session.merged { from, title }
 *   run.start { origin } · run.end { reason, text? } · request { provider, model, tools: string[], promptHash }
 *   system.prompt { hash, text }  (once per distinct prompt)
 *   thinking { text, ms } · tool.start { id, name, args } · tool.end { id, name, ok, durationMs, chars }
 *   usage { promptTokens, completionTokens } · approval.request { id, name, detail, reason? } · approval.resolved { id, ok, scope }
 *   plan { id, title, status } · artifact { id, title, kind, version } · image { id, name } · tasks { tasks }
 *   compaction { id, reason, tokensBefore, tokensAfter, summary } · notice { message } · error { message }
 */
export interface HistoryRecord {
  v: 1;
  /** Position in this session's log, from 1 */
  seq: number;
  /** Unix ms */
  t: number;
  type: string;
  data: unknown;
}

/** One match of a search across every conversation. */
export interface SearchHit {
  sessionId: string;
  title: string;
  updatedAt: number;
  /** Where the match is: the session's title, a user or assistant message, or a tool call / result */
  role: 'title' | 'user' | 'assistant' | 'tool';
  /** About 160 characters around the first match */
  snippet: string;
  /** Offsets of the match inside `snippet` */
  matchStart: number;
  matchEnd: number;
  /** How many matches the session has in all */
  count: number;
  /** The match is in messages a compaction folded away or a rewind removed (still in the history) */
  archived?: boolean;
  /** The session is in the trash */
  trashed?: boolean;
}

/** A deleted session, kept until its purge date. */
export interface TrashEntry {
  id: string;
  title: string;
  deletedAt: number;
  /** When it will be removed for good */
  purgeAt: number;
  messageCount: number;
  bytes: number;
}

export interface HistoryStats {
  sessions: number;
  /** Bytes of session files, logs and artifacts */
  bytes: number;
  trash: number;
  trashBytes: number;
  /** The history folder */
  dir: string;
}

export interface HistoryRpc {
  /** Case-insensitive; every word must match. Newest sessions first, one hit per session. */
  'history.search': (query: string, opts?: { limit?: number; includeTrash?: boolean }) => SearchHit[];
  /** Asks where to save, writes the file, returns its path (null when cancelled) */
  'history.export': (sessionId: string, format: 'markdown' | 'json' | 'jsonl') => string | null;
  'history.trash': () => TrashEntry[];
  /** Brings a deleted session back */
  'history.restore': (id: string) => SessionMeta;
  /** Removes one trashed session for good, or all of them */
  'history.purge': (id?: string) => TrashEntry[];
  /**
   * Deletes every session the way one is deleted: running sessions are stopped first, each goes to the trash (or
   * away at once when historyTrashDays is 0), and a fresh empty session is made and brought on screen
   * (sessions:show). `deleted` counts the sessions that had messages.
   */
  'history.deleteAll': () => { deleted: number; session: SessionMeta };
  'history.stats': () => HistoryStats;
  /** Shows the history folder (or one session's log) in Finder */
  'history.reveal': (sessionId?: string) => void;
}
