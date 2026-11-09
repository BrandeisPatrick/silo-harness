// The mod host's pure parts: which views go where and in what order, what an agent event means to a mod, what a
// mod may call or hear, the hello a page gets, and the plain-words description of what a mod asks for. Nothing here
// touches the DOM, so test/mods-host.js loads the compiled file under plain Node.

import type { AgentEvent, SessionMeta } from '../../shared/types';
import type { ModHello, ModInfo, ModLayout, ModLookTarget, ModPermission, ModSeat, ModSession, ModTheme, ModViewManifest } from '../../shared/mods';

export const PROTOCOL = 1;
export const RAIL_MIN = 240;
export const RAIL_MAX = 480;
export const RAIL_DEFAULT = 300;
export const RAIL_MAX_HEIGHT_DEFAULT = 360;
export const COMPOSER_MAX_HEIGHT = 120;
export const ORDER_DEFAULT = 100;
/** A page that has not said hello by then gets the "did not start" line */
export const HELLO_TIMEOUT_MS = 5000;

/** JSON-RPC error codes of the protocol (docs/mods.md, "Under the object") */
export const ERR = { unknownMethod: -32601, badParams: -32602, permission: 4003, unavailable: 4004, timeout: 4008, other: 4000 } as const;

export type PermissionTable = Record<string, ModPermission | null>;

/** One view of one mod that is on: what the host builds a frame for. */
export interface ViewRef {
  /** "<mod key>/<view id>": the handle the layout uses (collapsed, background) */
  key: string;
  mod: ModInfo;
  view: ModViewManifest;
}

export const viewKey = (modKey: string, viewId: string): string => `${modKey}/${viewId}`;

/** The views of every mod that is on, for one seat; rail sections sort by `order` (default 100), then title, then key. */
export function viewsFor(mods: readonly ModInfo[], seat: ModSeat): ViewRef[] {
  const out: ViewRef[] = [];
  for (const mod of mods) {
    if (mod.state !== 'on' || !mod.manifest) continue;
    for (const view of mod.manifest.contributes?.views ?? []) {
      if (view && view.seat === seat && typeof view.id === 'string') out.push({ key: viewKey(mod.key, view.id), mod, view });
    }
  }
  const order = (r: ViewRef) => (typeof r.view.order === 'number' && Number.isFinite(r.view.order) ? r.view.order : ORDER_DEFAULT);
  return out.sort((a, b) => order(a) - order(b) || String(a.view.title).localeCompare(String(b.view.title)) || a.key.localeCompare(b.key));
}

/** Whether a mod's looks (its backgrounds, looks and theme) may apply now: bundled, or approved; an older list says it by `state`. */
export function looksUsable(m: Pick<ModInfo, 'state' | 'approved'>): boolean {
  return m.approved ?? m.state === 'on';
}

/** A background view of a mod, by its key ("<mod key>/<view id>"), whatever the mod's state (for a preview). */
export function backgroundRef(mods: readonly ModInfo[], key: string): ViewRef | null {
  const i = key.lastIndexOf('/');
  if (i <= 0) return null;
  const mod = mods.find((m) => m.key === key.slice(0, i));
  const view = mod?.manifest?.contributes?.views?.find((v) => v && v.id === key.slice(i + 1) && v.seat === 'background');
  return mod && view ? { key, mod, view } : null;
}

/** The background view the layout names, when its mod's looks may apply and the view really is a background. */
export function activeBackground(mods: readonly ModInfo[], layout: Pick<ModLayout, 'background'> | null | undefined): ViewRef | null {
  const want = layout?.background;
  if (!want) return null;
  const r = backgroundRef(mods, want);
  return r && r.mod.state !== 'invalid' && looksUsable(r.mod) ? r : null;
}

/** The regions a look can restyle, in the order the host applies them */
export const LOOK_TARGETS: readonly ModLookTarget[] = ['conversation', 'composer'];

/** The look the layout names for a region, when its mod is on and has that look for that region. */
export function activeLook(mods: readonly ModInfo[], layout: Pick<ModLayout, 'looks'> | null | undefined, target: ModLookTarget): { key: string; mod: ModInfo; id: string } | null {
  const ref = layout?.looks?.[target];
  if (!ref) return null;
  const i = ref.lastIndexOf('/');
  if (i <= 0) return null;
  const mod = mods.find((m) => m.key === ref.slice(0, i));
  const id = ref.slice(i + 1);
  if (!mod || mod.state === 'invalid' || !looksUsable(mod) || !mod.manifest?.contributes?.looks?.some((l) => l.id === id && l.target === target)) return null;
  return { key: ref, mod, id };
}

/** An attribute name for a mod setting: "data-set-" and the key in lower case, other characters as "-". */
export function settingAttribute(key: string): string {
  return `data-set-${String(key).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`;
}

/** The attributes a region's root carries while a look is active there (docs/mods.md, Looks: state). */
export function lookAttributes(s: { ref: string; running: boolean; scheme: 'light' | 'dark'; mode: string; settings: Record<string, unknown> }): Record<string, string> {
  const out: Record<string, string> = { 'data-look': s.ref, 'data-running': String(!!s.running), 'data-scheme': s.scheme, 'data-mode': String(s.mode) };
  for (const [k, v] of Object.entries(s.settings ?? {})) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    out[settingAttribute(k)] = String(v).slice(0, 200);
  }
  return out;
}

/** The pointer as fractions of the window, each from 0 to 1, rounded to four places. */
export function pointerFraction(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const f = (v: number, size: number) => Math.round(Math.min(1, Math.max(0, size > 0 ? v / size : 0.5)) * 10000) / 10000;
  return { x: f(x, w), y: f(y, h) };
}

export function clampRailWidth(w: unknown): number {
  const n = Number(w);
  if (!Number.isFinite(n)) return RAIL_DEFAULT;
  return Math.round(Math.min(RAIL_MAX, Math.max(RAIL_MIN, n)));
}

/** The height a frame gets for a reported content height: rail views up to maxHeight, composer views up to 120. */
export function frameHeight(seat: ModSeat, reported: unknown, maxHeight?: number): number {
  const h = Math.max(0, Math.ceil(Number(reported) || 0));
  if (seat === 'rail') return Math.min(h, typeof maxHeight === 'number' && maxHeight > 0 ? maxHeight : RAIL_MAX_HEIGHT_DEFAULT);
  if (seat === 'composer') return Math.min(h, COMPOSER_MAX_HEIGHT);
  return h;
}

/** The collapsed list with `key` added or removed (order kept, no duplicates). */
export function setCollapsed(list: readonly string[], key: string, collapsed: boolean): string[] {
  const rest = list.filter((k) => k !== key);
  return collapsed ? [...rest, key] : rest;
}

/** The permission a method needs, `null` when it needs none, `undefined` when there is no such method. */
export function methodNeeds(table: PermissionTable, method: string): ModPermission | null | undefined {
  return Object.prototype.hasOwnProperty.call(table, method) ? table[method] : undefined;
}

export function holds(mod: Pick<ModInfo, 'state' | 'granted'>, need: ModPermission | null | undefined): boolean {
  return mod.state === 'on' && (!need || mod.granted.includes(need));
}

/** Whether a view of `mod` may receive the event: unknown events are never sent, known ones need their permission. */
export function mayReceive(events: PermissionTable, mod: Pick<ModInfo, 'state' | 'granted'>, name: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(events, name)) return false;
  return holds(mod, events[name]);
}

/** events.subscribe: the first permission missing for the names asked for (unknown names are fine), or null. */
export function subscribeMissing(events: PermissionTable, mod: Pick<ModInfo, 'state' | 'granted'>, names: readonly string[]): ModPermission | null {
  for (const n of names) {
    if (!Object.prototype.hasOwnProperty.call(events, n)) continue;
    const need = events[n];
    if (need && !mod.granted.includes(need)) return need;
  }
  return null;
}

/** Methods the window answers itself; everything else goes to the main process through mods.call. */
export function isWindowMethod(method: string): boolean {
  return (
    method === 'hello' ||
    method === 'events.subscribe' ||
    method === 'events.unsubscribe' ||
    method === 'hooks.subscribe' ||
    method === 'hooks.unsubscribe' ||
    method === 'log.error' ||
    method.startsWith('ui.') ||
    method === 'composer.insert' ||
    method === 'outputs.open' ||
    method === 'sessions.open' ||
    method === 'sessions.create'
  );
}

/**
 * The host's name in the hello (`harness.info.app.name`). It stays "Open Harness", the name protocol 1 shipped with,
 * so a mod that checks it keeps working after the rename to Silo Harness; the version is the app's own.
 */
export const MOD_HOST_NAME = 'Silo Harness';

export function buildHello(mod: ModInfo, view: ModViewManifest, app: { name: string; version: string }, theme: ModTheme, visible: boolean): ModHello {
  const m = mod.manifest;
  return {
    protocol: PROTOCOL,
    mod: { id: mod.id, name: m?.name ?? mod.id, version: m?.version ?? '0.0.0', scope: mod.scope },
    view: { id: view.id, seat: view.seat, title: view.title },
    app: { name: MOD_HOST_NAME, version: app.version },
    granted: [...mod.granted],
    theme: { scheme: theme.scheme, tokens: { ...theme.tokens } },
    settings: { ...(mod.settings ?? {}) },
    visible,
  };
}

/** A session as mods see it (the same shape the main process builds in bridge.ts). */
export function toModSession(m: SessionMeta, cwd: string, running?: boolean): ModSession {
  const s: ModSession = {
    id: m.id,
    title: m.title,
    cwd: m.cwd ?? cwd,
    origin: m.origin ?? (m.forkedFrom ? 'fork' : 'user'),
    messageCount: m.messageCount,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    running: running ?? !!m.status?.running,
  };
  if (m.parentId) s.parentId = m.parentId;
  if (m.forkedFrom) s.forkedFrom = m.forkedFrom;
  if (m.status?.attention) s.attention = m.status.attention;
  return s;
}

/** What a session.changed is about: another one on screen, or a change of its title, state or size. */
export function sessionSignature(s: ModSession | null): string {
  return s ? JSON.stringify([s.id, s.title, s.running, s.attention ?? '', s.messageCount, s.cwd]) : '';
}

/** The state of the sub-sessions, forks and parent of the session on screen; '' when it has none. */
export function relatedSignature(metas: readonly SessionMeta[], currentId: string): string {
  const me = metas.find((m) => m.id === currentId);
  const rel = metas.filter((m) => m.id !== currentId && (m.id === me?.parentId || m.parentId === currentId || m.forkedFrom === currentId));
  if (!rel.length) return '';
  return JSON.stringify(rel.map((m) => [m.id, m.title, !!m.status?.running, m.status?.attention ?? '', m.messageCount, m.mergedInto ?? '', m.updatedAt]).sort());
}

export interface ModEventOut {
  name: string;
  data: unknown;
}

/** The mod events an agent event of the session on screen becomes. */
export function eventsFromAgent(ev: AgentEvent, sessionId: string): ModEventOut[] {
  switch (ev.type) {
    case 'run_start':
      return [{ name: 'run.started', data: { sessionId } }];
    case 'run_end': {
      const data: { sessionId: string; reason: string; text?: string } = { sessionId, reason: ev.reason };
      if (typeof ev.text === 'string') data.text = ev.text;
      return [{ name: 'run.ended', data }];
    }
    case 'user_message':
      return [{ name: 'message.user', data: { text: ev.text, origin: ev.origin } }];
    case 'assistant_message':
      return [{ name: 'message.assistant', data: { text: ev.text } }];
    case 'text_delta':
      return [{ name: 'message.delta', data: { text: ev.text } }];
    case 'tool_start':
      return [{ name: 'tool.started', data: { id: ev.id, name: ev.name, args: ev.args } }];
    case 'tool_end': {
      const data: { id: string; name: string; ok: boolean; durationMs?: number } = { id: ev.id, name: ev.name, ok: ev.ok };
      if (typeof ev.durationMs === 'number') data.durationMs = ev.durationMs;
      return [{ name: 'tool.ended', data }];
    }
    case 'tasks_updated':
      return [{ name: 'tasks.changed', data: { tasks: Array.isArray(ev.tasks) ? ev.tasks.map((t) => ({ ...t })) : [] } }];
    case 'plan_proposed':
      return [{ name: 'plan.changed', data: { plan: ev.plan ?? null } }];
    case 'artifact':
    case 'image':
    case 'changes_updated':
      return [{ name: 'outputs.changed', data: {} }];
    case 'context':
      return ev.context ? [{ name: 'context.changed', data: { tokens: ev.context.tokens, limit: ev.context.limit } }] : [];
    default:
      return [];
  }
}

const PERMISSION_WORDS: Record<ModPermission, string> = {
  'session:read': 'Read the session on screen: its messages, tool calls, tasks, plan, outputs and context use',
  'session:send': 'Send messages as you and fill the composer',
  'session:control': 'Stop a run, compact, open or start sessions, start and merge sub-sessions',
  'sessions:read': 'List and search all your conversations',
  model: 'Call the model (this uses tokens)',
  'skills:read': 'List skills and how often they are used',
  'config:read': 'Read non-secret settings',
  'config:write': 'Change the theme, auto-compact, keep-awake, notifications and background',
  schedules: 'List, create, change and delete scheduled tasks',
  remote: 'See and switch remote control',
  network: 'Reach the internet',
  hooks: "React to the agent's actions before and after they happen, and block them: tool calls, prompts, the end of a turn",
};

export interface AskLine {
  text: string;
  /** Said more prominently: it changes the app itself, or it can send things away */
  strong?: boolean;
}

/** What turning the mod on would grant, in plain words (docs/mods.md, Permissions), plus the two lines that matter most. */
export function askLines(mod: ModInfo): AskLine[] {
  const perms = mod.state === 'paused' && mod.wants.length ? mod.wants : (mod.manifest?.permissions ?? []);
  const lines: AskLine[] = [];
  for (const p of perms) {
    if (p === 'network') continue;
    const text = PERMISSION_WORDS[p];
    // Hooks see every tool call's input (commands, file contents) and can stop it: said as plainly as the network.
    if (p === 'hooks') lines.push({ text: `${text}. It sees what each tool call is given, file contents included.`, strong: true });
    else if (text) lines.push({ text });
  }
  const c = mod.manifest?.contributes;
  const hasStyles = !!c?.styles?.length;
  const hasLooks = !!c?.looks?.length;
  const hasBackground = !!c?.views?.some((v) => v.seat === 'background');
  // A look's approval is asked at its first Use: a mod with a switch says nothing of it here, a mod that is only looks does
  const looksOnly = !(c?.views ?? []).some((v) => v.seat !== 'background') && !(c?.commands ?? []).length;
  if (!looksOnly && (hasStyles || hasLooks || hasBackground)) {
    /* its looks ask when they are first used */
  } else if ((mod.state !== 'paused' || mod.wantsStyles) && (hasStyles || hasBackground)) {
    const what = hasStyles && hasBackground ? 'restyle Silo Harness and draw behind it' : hasStyles ? 'restyle Silo Harness itself' : hasLooks ? 'restyle the conversation or the chat bar and draw behind the window' : 'draw behind the whole window';
    lines.push({ text: `It can ${what}: its stylesheet applies to the app's own page, approval cards included. Use it only if you trust where it came from.`, strong: true });
  } else if ((mod.state !== 'paused' || mod.wantsStyles) && hasLooks) {
    lines.push({ text: 'It can restyle the conversation or the chat bar: its stylesheet applies to the app\'s own page, approval cards in the conversation included. Use it only if you trust where it came from.', strong: true });
  }
  if (perms.includes('network')) {
    const reads = perms.some((p) => p === 'session:read' || p === 'sessions:read');
    lines.push({ text: reads ? 'Reach the internet. Together with reading your sessions, it could send what it reads to a server.' : 'Reach the internet: its pages can load and send data over https.', strong: true });
  }
  if (!lines.length) lines.push({ text: 'Nothing beyond its own panel: no access to your sessions, settings or the network' });
  return lines;
}

/** Where a mod lives, for the card ("~/…" when it is under the home folder). */
export function shortDir(dir: string, home: string): string {
  if (home && (dir === home || dir.startsWith(home.endsWith('/') ? home : `${home}/`))) return `~${dir.slice(home.replace(/\/$/, '').length)}`;
  return dir;
}

export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A manifest icon: a built-in name, or an SVG file of the mod (served from its origin). */
export function iconSource(name: string | undefined, origin: string, isBuiltin: (n: string) => boolean): { builtin: string } | { url: string } | null {
  if (!name || typeof name !== 'string') return null;
  if (isBuiltin(name)) return { builtin: name };
  if (/\.svg$/i.test(name) && !name.includes('..') && !name.startsWith('/') && !/^[a-z]+:/i.test(name)) {
    return { url: `${origin}/${name.split('/').map(encodeURIComponent).join('/')}` };
  }
  return null;
}

/** The URL a view's frame loads; `v` changes with the mod's files so an edit is a fresh load. */
export function frameSrc(mod: Pick<ModInfo, 'origin' | 'rev'>, entry: string): string {
  const path = String(entry).replace(/^\.?\//, '').split('/').map(encodeURIComponent).join('/');
  return `${mod.origin}/${path}?v=${encodeURIComponent(mod.rev)}`;
}

/** What makes a mod's views reload: its files (rev) or what it was granted. */
export function modSignature(mod: ModInfo): string {
  return JSON.stringify([mod.rev, mod.state, [...mod.granted].sort(), mod.origin]);
}

// ---------- Hooks ----------

/** The frames of a mod that registered a handler for `event`, in the order the manifest lists the views. */
export function hookViewOrder<T extends { view: string; hooks: Iterable<string> }>(mod: Pick<ModInfo, 'manifest'>, frames: readonly T[], event: string): T[] {
  const order = (mod.manifest?.contributes?.views ?? []).map((v) => v.id);
  const at = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  return frames.filter((f) => [...f.hooks].includes(event)).sort((a, b) => at(a.view) - at(b.view));
}

/** A hook answer that decides nothing: null, undefined or an empty object (the host then asks the next view). */
export function isEmptyHookResult(r: unknown): boolean {
  return r === null || r === undefined || (typeof r === 'object' && !Array.isArray(r) && Object.keys(r as object).length === 0);
}
