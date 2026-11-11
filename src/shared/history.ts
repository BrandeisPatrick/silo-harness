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
 *   session.deleted {} · session.restored {} · session.merged { from, title } · session.forked { from, seedLength }
 *   run.start { origin, from?, timing? } · run.end { reason, text?, continued? }
 *   thinking { text, ms } · tool.start { id, name, args, mcp? } · tool.end { id, name, ok, durationMs, chars }
 *   usage { promptTokens, completionTokens, cacheReadTokens?, cacheWriteTokens? }
 *   approval.request { id, name, detail, reason? } · approval.resolved { id, ok, scope }
 *   plan { id, title, status } · artifact { id, title, kind, version } · image { id, name } · tasks { tasks }
 *   compaction { id, reason, tokensBefore, tokensAfter, summary } · notice { message } · error { message }
 *
 * Numbers and fixed words only (after 0.17.0; a log written by 0.17.0 or before has none, and no `timing` on run.start):
 *   run.start's timing    the run's id in the timing log (eight hex digits), which ties a timing line to its session
 *   retry                 { attempt, waitMs, ranMs, kind }  a model request is tried again: the attempt coming (2-6),
 *                         the wait before it, how long the failed one ran, why it failed (idle, connection,
 *                         rate_limited, busy, too_long, other)
 *   check                 { ms, verdict, timedOut }  Auto mode's safety check of a call ended (allow, block, ask,
 *                         error, stopped)
 *   question.request      { count }  ask_user's question card is on screen, with this many questions
 *   question.resolved     { outcome }  answered or skipped (a stop skips it)
 *   compaction.start      { reason }  auto or manual; its end is the compaction record (or an error record)
 *
 * No request or system-prompt record is written: what was sent is rebuilt from the conversation records.
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
