// Search across every conversation: titles, user and assistant text, tool calls and results, and the messages
// compactions folded away. It runs over the sessions in memory; the lower-cased text of each session is cached
// and dropped whenever that session changes (the service calls drop() from its mutation listener).

import type { SearchHit } from '../../shared/history';
import { displayText, type Msg, type Session } from '../sessions';
import { isCompactPreamble, isContextNote } from '../compact';

type Role = 'user' | 'assistant' | 'tool';

interface Entry {
  role: Role;
  text: string;
  lower: string;
  archived: boolean;
}

const SNIPPET = 160;
export const DEFAULT_LIMIT = 30;

/** The searchable texts of a list of messages, in order. */
function entriesOf(messages: Msg[], archived: boolean, out: Entry[]): void {
  const add = (role: Role, text: string) => {
    if (text && text.trim()) out.push({ role, text, lower: text.toLowerCase(), archived });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      if (isCompactPreamble(m) || isContextNote(m)) continue; // the summary stands in for messages that are searched themselves
      add('user', displayText(m.content));
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') add('assistant', m.content);
      for (const call of m.tool_calls ?? []) if (call.type === 'function') add('tool', `${call.function.name} ${call.function.arguments}`);
    } else if (m.role === 'tool') {
      add('tool', typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    }
  }
}

export function sessionEntries(s: Session): Entry[] {
  const out: Entry[] = [];
  for (const c of s.compactions ?? []) entriesOf(c.folded ?? [], true, out);
  entriesOf(s.messages, false, out);
  return out;
}

/** The words of a query, lower-cased; empty when there is nothing to search for. */
export function queryWords(query: string): string[] {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** A snippet of about SNIPPET characters around the first match of any word, with the match's offsets in it. */
export function makeSnippet(text: string, lower: string, words: string[]): { snippet: string; matchStart: number; matchEnd: number } {
  let at = -1;
  let len = 0;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = w.length;
    }
  }
  if (at < 0) at = 0;
  // A lower-cased string can differ in length from the original for a few characters; offsets are clamped then.
  const before = Math.max(0, Math.floor((SNIPPET - len) / 3));
  let start = Math.max(0, at - before);
  const end = Math.min(text.length, start + SNIPPET);
  start = Math.max(0, Math.min(start, end - SNIPPET));
  // Whitespace becomes plain spaces one for one, so the offsets stay right.
  let snippet = text.slice(start, end).replace(/\s/g, ' ');
  let matchStart = at - start;
  if (start > 0) {
    snippet = '…' + snippet;
    matchStart += 1;
  }
  if (end < text.length) snippet += '…';
  matchStart = Math.max(0, Math.min(matchStart, snippet.length));
  return { snippet, matchStart, matchEnd: Math.min(snippet.length, matchStart + len) };
}

export class SearchIndex {
  private readonly cache = new Map<string, { session: Session; entries: Entry[] }>();

  /** Forgets a session's cached text (it changed, or is gone). */
  drop(id: string): void {
    this.cache.delete(id);
  }

  clear(): void {
    this.cache.clear();
  }

  /** Whether a session's text is cached (for tests). */
  cached(id: string): boolean {
    return this.cache.has(id);
  }

  private entries(s: Session, key: string): Entry[] {
    const hit = this.cache.get(key);
    if (hit && hit.session === s) return hit.entries;
    const entries = sessionEntries(s);
    this.cache.set(key, { session: s, entries });
    return entries;
  }

  /** The best hit of one session, or null. `key` separates live sessions from trashed copies in the cache. */
  match(s: Session, words: string[], key = s.id): Omit<SearchHit, 'trashed'> | null {
    if (!words.length) return null;
    const title = s.title || '';
    const titleLower = title.toLowerCase();
    const titleHit = words.every((w) => titleLower.includes(w));
    let count = titleHit ? 1 : 0;
    let best: Entry | null = null;
    for (const e of this.entries(s, key)) {
      if (!words.every((w) => e.lower.includes(w))) continue;
      count++;
      best = e; // later entries are more recent: the last match wins
    }
    if (!titleHit && !best) return null;
    const base = { sessionId: s.id, title, updatedAt: s.updatedAt, count };
    if (titleHit) return { ...base, role: 'title', ...makeSnippet(title, titleLower, words) };
    const e = best!;
    const hit: Omit<SearchHit, 'trashed'> = { ...base, role: e.role, ...makeSnippet(e.text, e.lower, words) };
    if (e.archived) hit.archived = true;
    return hit;
  }
}
