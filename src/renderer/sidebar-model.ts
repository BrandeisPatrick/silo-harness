// The sidebar's logic without the DOM: day groups, the session tree, the rows that are visible, which indicator a
// row gets, and search results. sidebar.ts renders what these return; test/sidebar.js runs them headless (the file
// imports types only, so it loads under plain Node).

import type { SessionMeta, SessionStatus } from '../shared/types';
import type { SearchHit } from '../shared/history';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Indentation stops growing after this many levels; deeper sessions line up with the third level. */
export const MAX_INDENT = 3;

/** Days before today that get a group of their own; anything earlier is "Older". */
export const DAY_GROUPS = 6;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Nov 3" (local time); with the year when it is not the year of `now`. */
export function shortDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${d.getFullYear()}`;
}

/**
 * The group a moment belongs to: "Today", one label per calendar day for the six days before ("Nov 3"), else
 * "Older". Calendar days in local time, so a session from 23:59 yesterday is not "Today" and DST changes do not
 * shift a day. A moment in the future (a clock that moved) counts as today.
 */
export function dayGroup(ts: number, now: number = Date.now()): string {
  const today = startOfDay(now);
  if (ts >= today) return 'Today';
  const t = new Date(today);
  for (let i = 1; i <= DAY_GROUPS; i++) {
    const start = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i).getTime();
    if (ts >= start) return shortDate(start, now);
  }
  return 'Older';
}

export interface TreeNode {
  meta: SessionMeta;
  /** The session this one is nested under (null for a root) */
  parent: TreeNode | null;
  /** Oldest first */
  children: TreeNode[];
  depth: number;
  /** Newest updatedAt in this session and everything nested under it */
  activity: number;
  /** How many sessions are nested under this one, at any depth */
  descendants: number;
}

/** The session a meta hangs under: the one it was forked from, else the one it was spawned from. */
export function parentOf(m: SessionMeta): string | undefined {
  return m.forkedFrom || m.parentId || undefined;
}

const byCreated = (a: TreeNode, b: TreeNode) => a.meta.createdAt - b.meta.createdAt || (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0);
const byActivity = (a: TreeNode, b: TreeNode) => b.activity - a.activity || (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0);

/**
 * The session tree: each session under the one it was forked or spawned from, to any depth. A session whose parent
 * is not in the list is a root. Bad data that forms a cycle is cut where it would close (links are made oldest first, so
 * the newest session of the loop becomes a root), so this always ends. Children are oldest first (rows do not jump when a
 * child gets busy); roots (families) newest activity first.
 */
export function buildTree(metas: SessionMeta[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const meta of metas) {
    if (!meta || typeof meta.id !== 'string' || nodes.has(meta.id)) continue;
    nodes.set(meta.id, { meta, parent: null, children: [], depth: 0, activity: Number(meta.updatedAt) || 0, descendants: 0 });
  }
  // Link in creation order so the outcome does not depend on the list's order.
  const ordered = [...nodes.values()].sort(byCreated);
  for (const n of ordered) {
    const pid = parentOf(n.meta);
    const p = pid && pid !== n.meta.id ? nodes.get(pid) : undefined;
    if (!p) continue;
    // Would this link close a loop? Walk up from the parent (only links made so far, so it is finite).
    let up: TreeNode | null = p;
    while (up && up !== n) up = up.parent;
    if (up === n) continue;
    n.parent = p;
    p.children.push(n);
  }
  const roots = ordered.filter((n) => !n.parent);
  const settle = (n: TreeNode, depth: number): void => {
    n.depth = depth;
    n.children.sort(byCreated);
    n.descendants = 0;
    for (const c of n.children) {
      settle(c, depth + 1);
      n.activity = Math.max(n.activity, c.activity);
      n.descendants += 1 + c.descendants;
    }
  };
  for (const r of roots) settle(r, 0);
  return roots.sort(byActivity);
}

export interface Group {
  label: string;
  families: TreeNode[];
}

/** Families into day groups, Today first, then the days before, newest first, then Older. Empty groups are left out. */
export function groupFamilies(roots: TreeNode[], now: number = Date.now()): Group[] {
  const groups = new Map<string, Group>();
  // Roots arrive newest activity first, so groups come out in order too; Older always goes last.
  for (const r of [...roots].sort(byActivity)) {
    const label = dayGroup(r.activity, now);
    let g = groups.get(label);
    if (!g) groups.set(label, (g = { label, families: [] }));
    g.families.push(r);
  }
  const out = [...groups.values()].filter((g) => g.label !== 'Older');
  const older = groups.get('Older');
  if (older) out.push(older);
  return out;
}

/** What the row's right end shows when the row is not hovered (at most one). */
export type Indicator =
  | { kind: 'running' }
  | { kind: 'attention'; reason: 'approval' | 'question' | 'plan' }
  | { kind: 'unread' }
  /** A session with sessions under it; `count` when collapsed; `hot` when a hidden one runs, waits or is unread */
  | { kind: 'family'; count?: number; hot?: boolean }
  | { kind: 'fork' }
  | { kind: 'spawn' }
  /** A dream's session whose proposals (or plan) wait for the user: the attention dot */
  | { kind: 'dream'; waiting: boolean }
  | null;

/** What a row shows in front of its title: a scheduled run's lightning, a dream's moon (null: nothing). */
export type Lead = 'schedule' | 'dream' | null;

export function leadFor(meta: SessionMeta): Lead {
  return meta.origin === 'schedule' ? 'schedule' : meta.origin === 'dream' ? 'dream' : null;
}

/**
 * Priority: running, waiting for the user, unread results (never for the session on screen), then what the session
 * is: a parent (fork glyph, with the count when collapsed), a fork, a sub-session. A scheduled run and a dream say
 * what they are in front of the title (leadFor), so the right end stays for their state.
 */
export function indicatorFor(
  meta: SessionMeta,
  status: SessionStatus | undefined,
  opts: { current?: boolean; children?: number; collapsed?: boolean; hiddenHot?: boolean; nested?: boolean } = {},
): Indicator {
  const st = status ?? meta.status;
  if (st?.running) return { kind: 'running' };
  if (meta.origin === 'dream' && (st?.attention || meta.dream?.waiting)) return { kind: 'dream', waiting: true };
  if (st?.attention) return { kind: 'attention', reason: st.attention };
  if (st?.unread && !opts.current) return { kind: 'unread' };
  if (opts.children) return opts.collapsed ? { kind: 'family', count: opts.children, hot: Boolean(opts.hiddenHot) } : { kind: 'family' };
  // A fork sitting under the session it was forked from needs no mark: its place in the tree already says so.
  if (meta.origin === 'fork' || (meta.forkedFrom && meta.origin !== 'spawn' && meta.origin !== 'schedule' && meta.origin !== 'dream')) return opts.nested ? null : { kind: 'fork' };
  if (meta.origin === 'spawn') return { kind: 'spawn' };
  return null;
}

export type Row =
  | { kind: 'group'; label: string; collapsed: boolean; sessions: number }
  | {
      kind: 'session';
      meta: SessionMeta;
      group: string;
      depth: number;
      /** Indent level, capped at MAX_INDENT */
      indent: number;
      /** Parent's id when nested */
      parentId: string | null;
      /** Last of its siblings (the connector ends here instead of running on) */
      last: boolean;
      /** Indent levels (1-based) where an ancestor's connector runs past this row to a later sibling */
      rails: number[];
      children: number;
      descendants: number;
      collapsed: boolean;
      indicator: Indicator;
      merged: boolean;
    };

export interface VisibleOptions {
  now?: number;
  currentId?: string;
  status?: (id: string) => SessionStatus | undefined;
  /** Is this group label collapsed? (Older defaults to collapsed in the caller's state) */
  groupCollapsed: (label: string) => boolean;
  parentCollapsed: (id: string) => boolean;
}

function hot(n: TreeNode, status: (id: string) => SessionStatus | undefined, currentId: string): boolean {
  for (const c of n.children) {
    const st = status(c.meta.id) ?? c.meta.status;
    if (st?.running || st?.attention || (st?.unread && c.meta.id !== currentId)) return true;
    if (hot(c, status, currentId)) return true;
  }
  return false;
}

/**
 * Whether a session has a row in the list. A dream's session shows only while it waits for the user (its proposals,
 * its plan) or is the one on screen, so nightly dreams do not crowd the list; the Dreaming page lists them all.
 */
export function listed(m: SessionMeta, currentId: string, status?: SessionStatus): boolean {
  if (m.origin !== 'dream' || m.id === currentId) return true;
  const st = status ?? m.status;
  return Boolean(m.dream?.waiting || st?.attention);
}

/** The rows on screen, top to bottom: group labels and the sessions of expanded groups and parents. */
export function visibleRows(metas: SessionMeta[], o: VisibleOptions): Row[] {
  const now = o.now ?? Date.now();
  const status = o.status ?? (() => undefined);
  const currentId = o.currentId ?? '';
  const rows: Row[] = [];
  const shown = metas.filter((m) => !m || listed(m, currentId, status(m.id)));
  for (const g of groupFamilies(buildTree(shown), now)) {
    const collapsed = o.groupCollapsed(g.label);
    rows.push({ kind: 'group', label: g.label, collapsed, sessions: g.families.reduce((n, f) => n + 1 + f.descendants, 0) });
    if (collapsed) continue;
    const visit = (n: TreeNode, last: boolean, rails: number[]) => {
      const isCollapsed = n.children.length > 0 && o.parentCollapsed(n.meta.id);
      rows.push({
        kind: 'session',
        meta: n.meta,
        group: g.label,
        depth: n.depth,
        indent: Math.min(n.depth, MAX_INDENT),
        parentId: n.parent?.meta.id ?? null,
        last,
        rails,
        children: n.children.length,
        descendants: n.descendants,
        collapsed: isCollapsed,
        indicator: indicatorFor(n.meta, status(n.meta.id), {
          current: n.meta.id === currentId,
          children: n.descendants,
          collapsed: isCollapsed,
          hiddenHot: isCollapsed && hot(n, status, currentId),
          nested: n.depth > 0,
        }),
        merged: Boolean(n.meta.mergedInto),
      });
      if (isCollapsed) return;
      // This row's own connector runs on past its children when a later sibling follows.
      const level = Math.min(n.depth, MAX_INDENT);
      const next = n.depth > 0 && !last ? [...new Set([...rails, level])] : rails;
      n.children.forEach((c, i) => visit(c, i === n.children.length - 1, next));
    };
    for (const f of g.families) visit(f, true, []);
  }
  return rows;
}

/** Every ancestor of a session, nearest first (for expanding the path to it). */
export function ancestorsOf(metas: SessionMeta[], id: string): string[] {
  const out: string[] = [];
  const find = (nodes: TreeNode[]): TreeNode | null => {
    for (const n of nodes) {
      if (n.meta.id === id) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return null;
  };
  const roots = buildTree(metas);
  for (let n = find(roots)?.parent ?? null; n; n = n.parent) out.push(n.meta.id);
  return out;
}

/** The group a session's row sits in (its family's newest activity decides). */
export function groupOf(metas: SessionMeta[], id: string, now: number = Date.now()): string | null {
  for (const g of groupFamilies(buildTree(metas), now)) {
    const has = (n: TreeNode): boolean => n.meta.id === id || n.children.some(has);
    if (g.families.some(has)) return g.label;
  }
  return null;
}

// ---------- Search ----------

export interface SearchResult {
  id: string;
  title: string;
  /** Where the query matches the title (to highlight it), if it does */
  titleMatch: [number, number] | null;
  /** A line from inside the conversation, with the match */
  snippet: { text: string; start: number; end: number } | null;
  role: SearchHit['role'];
  updatedAt: number;
  /** Matches in the session in all (from the history search; 0 for a title-only match) */
  count: number;
}

/** The words of a query, lower-cased. */
export function queryWords(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every word in the title (case-insensitive), the rule history.search uses. */
export function titleMatches(title: string, q: string): boolean {
  const words = queryWords(q);
  if (!words.length) return false;
  const t = title.toLowerCase();
  return words.every((w) => t.includes(w));
}

/** Where to highlight in `text`: the whole query when it occurs as typed, else its first word. */
export function matchRange(text: string, q: string): [number, number] | null {
  const t = text.toLowerCase();
  const whole = q.trim().toLowerCase();
  if (!whole) return null;
  let i = t.indexOf(whole);
  if (i >= 0) return [i, i + whole.length];
  const w = queryWords(q)[0];
  i = w ? t.indexOf(w) : -1;
  return i >= 0 ? [i, i + w.length] : null;
}

/** A snippet on one line with its match offsets clamped into it (offsets from elsewhere are not trusted). */
export function cleanSnippet(hit: Pick<SearchHit, 'snippet' | 'matchStart' | 'matchEnd'>): { text: string; start: number; end: number } | null {
  const raw = typeof hit.snippet === 'string' ? hit.snippet : '';
  if (!raw.trim()) return null;
  // Collapse whitespace but keep the offsets pointing at the same characters.
  let text = '';
  let start = -1;
  let end = -1;
  const s = Number.isFinite(hit.matchStart) ? Math.max(0, Math.floor(hit.matchStart)) : 0;
  const e = Number.isFinite(hit.matchEnd) ? Math.max(s, Math.floor(hit.matchEnd)) : s;
  for (let i = 0; i < raw.length; i++) {
    if (i === s) start = text.length;
    if (i === e) end = text.length;
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (text && !text.endsWith(' ')) text += ' ';
    } else text += ch;
  }
  if (start < 0) start = text.length;
  if (end < 0) end = text.length;
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  start = Math.min(Math.max(0, start - lead), trimmed.length);
  end = Math.min(Math.max(start, end - lead), trimmed.length);
  return { text: trimmed, start, end };
}

/**
 * The results for a query: sessions whose title matches come first, newest first, as soon as the user types; matches
 * inside conversations (history.search hits) follow in the order the search returned them. One result per session;
 * a title match gets the snippet of its session's hit when that hit is inside the conversation. Hits for sessions
 * that are not in the list (trashed, or gone since) are left out, since there is nothing to open.
 */
export function shapeResults(query: string, metas: SessionMeta[], hits: SearchHit[] | null | undefined): SearchResult[] {
  if (!queryWords(query).length) return [];
  const known = new Map<string, SessionMeta>();
  for (const m of metas) if (m && typeof m.id === 'string' && !known.has(m.id)) known.set(m.id, m);
  const out: SearchResult[] = [];
  const byId = new Map<string, SearchResult>();
  const titled = [...known.values()].filter((m) => titleMatches(m.title, query)).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const m of titled) {
    const r: SearchResult = { id: m.id, title: m.title, titleMatch: matchRange(m.title, query), snippet: null, role: 'title', updatedAt: m.updatedAt, count: 0 };
    out.push(r);
    byId.set(m.id, r);
  }
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit || typeof hit.sessionId !== 'string' || hit.trashed) continue;
    const m = known.get(hit.sessionId);
    if (!m) continue;
    const snippet = hit.role === 'title' ? null : cleanSnippet(hit);
    const seen = byId.get(m.id);
    if (seen) {
      if (!seen.snippet && snippet) {
        seen.snippet = snippet;
        seen.role = hit.role;
      }
      seen.count = Math.max(seen.count, Number(hit.count) || 0);
      continue;
    }
    const r: SearchResult = {
      id: m.id,
      title: m.title,
      titleMatch: null,
      snippet,
      role: hit.role,
      updatedAt: m.updatedAt,
      count: Number(hit.count) || 0,
    };
    out.push(r);
    byId.set(m.id, r);
  }
  return out;
}
