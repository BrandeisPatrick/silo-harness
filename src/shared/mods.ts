// The mod protocol's types: the manifest, what the app knows about an installed mod, and the bridge between a mod
// page and the app. docs/mods.md is the reference for authors; this file is the same contract for the code.
// Types only (like every file in src/shared): it is compiled for both the main process and the renderer.

import type { PermissionMode, PlanInfo, SendResult, SessionOrigin, SkillInfo, TaskItem } from './types';
import type { ContextBreakdown } from './context';
import type { Schedule, ScheduleInput, SchedulePatch } from './schedules';
import type { RemoteStatus } from './remote';
import type { SearchHit } from './history';
import type { HookEvent } from './hooks';

export type ModProtocolVersion = 1;

/** bundled: ships in the app's mods/ folder. user: <configDir>/mods. project: <project>/.silo-harness/mods. */
export type ModScope = 'bundled' | 'user' | 'project';

export type ModPermission =
  | 'session:read'
  | 'session:send'
  | 'session:control'
  | 'sessions:read'
  | 'model'
  | 'skills:read'
  | 'config:read'
  | 'config:write'
  | 'schedules'
  | 'remote'
  | 'network'
  | 'hooks';

/**
 * rail: a section in the right-hand rail. tab: a tab in the side pane. composer: a strip above the composer.
 * background: behind the window. worker: no place in the window, a hidden page loaded while the mod is on (for hooks).
 */
export type ModSeat = 'rail' | 'tab' | 'composer' | 'background' | 'worker';

/** An event a mod handles (contributes.hooks), and how long its handler may take (seconds; default 10) */
export interface ModHookContribution {
  event: HookEvent;
  timeout?: number;
}

export interface ModViewManifest {
  /** Unique within the mod */
  id: string;
  title: string;
  /** An HTML file in the mod's folder */
  entry: string;
  seat: ModSeat;
  /** rail: sections sort by this, lower first (default 100) */
  order?: number;
  /** rail: the tallest the section grows before it scrolls (default 360) */
  maxHeight?: number;
  /** A built-in icon name or an SVG file in the mod (default: the mod's icon) */
  icon?: string;
  /** background: a picture of it (PNG, JPEG, WebP, GIF or SVG in the mod) for its card in Settings → Mods → Background */
  preview?: string;
}

/** The region a look restyles: conversation is the transcript (#messages), composer the chat bar (#chatbar). */
export type ModLookTarget = 'conversation' | 'composer';

/** A stylesheet that restyles one region of the window; the app scopes it so it cannot reach outside that region. */
export interface ModLookManifest {
  /** Unique within the mod */
  id: string;
  title: string;
  target: ModLookTarget;
  /** CSS files in the mod, applied in order inside the region's scope */
  styles: string[];
  description?: string;
  /** A picture of it (PNG, JPEG, WebP, GIF or SVG in the mod) for its card in Settings; without one the card draws a sample */
  preview?: string;
}

/**
 * The four kinds of look, each with a tab of its own in Settings → Mods and one in use at a time: a background view,
 * a chat bar look, a conversation look, a theme (a mod's styles). A look has no switch: it is available once installed.
 */
export type LookKind = 'background' | 'composer' | 'conversation' | 'theme';

export interface ModCommandManifest {
  /** Without the slash; lower-case letters, digits and - */
  name: string;
  description: string;
  /** A view to bring to the front when the command runs */
  view?: string;
}

export type ModSettingField =
  | { key: string; type: 'boolean'; title: string; description?: string; default?: boolean }
  | { key: string; type: 'string'; title: string; description?: string; default?: string; placeholder?: string }
  | { key: string; type: 'number'; title: string; description?: string; default?: number; min?: number; max?: number; step?: number }
  | { key: string; type: 'select'; title: string; description?: string; default?: string; options: string[] };

/** mod.json */
export interface ModManifest {
  protocol: ModProtocolVersion;
  /** ^[a-z][a-z0-9-]{1,39}$ and equal to the folder name */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  icon?: string;
  permissions?: ModPermission[];
  contributes?: {
    views?: ModViewManifest[];
    /** CSS files applied to the app's own page */
    styles?: string[];
    /** Stylesheets for one region each (the conversation, the chat bar); one look per region is active */
    looks?: ModLookManifest[];
    commands?: ModCommandManifest[];
    settings?: ModSettingField[];
    /** Hook events its views handle (needs the hooks permission) */
    hooks?: ModHookContribution[];
  };
}

export interface ModProblem {
  /** manifest: mod.json is missing, unreadable or invalid. file: something it names does not exist. runtime: a page threw. */
  kind: 'manifest' | 'file' | 'runtime';
  message: string;
  /** Only a warning: the part it names is ignored and the rest of the mod loads (a look target this app does not know) */
  warning?: boolean;
  /** runtime: the view that reported it */
  view?: string;
  at?: number;
}

/**
 * on: loaded. off: the user has not turned it on (or turned it off). paused: it was on, then its manifest asked for
 * more than was granted (a permission) and it waits for approval. invalid: no usable manifest.
 * A mod that is only looks (no panel, tab, strip, worker or command) has no switch: it is on while one of its looks is
 * in use and approved, paused while one is in use and it asks for more than was approved, and off otherwise.
 */
export type ModState = 'on' | 'off' | 'paused' | 'invalid';

/** One installed mod, as Settings and the host see it. */
export interface ModInfo {
  /** Stable handle across scopes: "<id>" for bundled and user mods, "<id>@<project folder>" for project mods */
  key: string;
  id: string;
  scope: ModScope;
  /** Absolute folder */
  dir: string;
  /** The last manifest that validated (null when there never was one) */
  manifest: ModManifest | null;
  state: ModState;
  /** What the user granted when turning it on */
  granted: ModPermission[];
  /** Asked for by the manifest and not granted: what turning it on (or resuming it) would add */
  wants: ModPermission[];
  /** True when the manifest contributes styles, looks or a background that were not part of what was approved */
  wantsStyles: boolean;
  /**
   * Its looks (backgrounds, chat bar and conversation looks, its theme) can be used without asking: a bundled mod, or
   * one the user approved at a first Use and that asks for nothing new since. False in safe mode for user and project mods.
   */
  approved?: boolean;
  /** The kinds of look of this mod in use right now (whether or not they apply: see `approved`) */
  inUse?: LookKind[];
  problems: ModProblem[];
  /** Changes whenever a file of the mod changes; views reload when it does */
  rev: string;
  /** The origin its pages are served from, e.g. "mod://word-count.user" */
  origin: string;
  /** A user mod that hides a bundled one with the same id */
  overrides?: boolean;
  /** Values of its settings (defaults filled in) */
  settings: Record<string, unknown>;
}

/** How the rail, the tabs and the background are arranged; stored in the config. */
export interface ModLayout {
  /** Whether the right-hand rail is showing */
  railOpen: boolean;
  /** Rail width in px */
  railWidth: number;
  /** "<mod key>/<view id>" of rail sections the user collapsed */
  collapsed: string[];
  /** "<mod key>/<view id>" of side-pane tabs the user closed: out of the tab strip until shown again from the ⋯ menu */
  closedTabs?: string[];
  /** "<mod key>/<view id>" of the active background, or null */
  background: string | null;
  /** A picture of the user's own as the background (absolute path), used when `background` is null */
  backgroundImage: string | null;
  /** 0 to 1: how strongly the app's surfaces cover the background */
  backgroundDim: number;
  /** The active look per region: "<mod key>/<look id>", or null for the app's own look */
  looks: Record<ModLookTarget, string | null>;
  /**
   * The theme in use: the key of a mod with styles, or null for the app's own. One at a time. Missing in a profile
   * from 0.8.0 or before, which the mods code migrates on start (the last theme that was on, in apply order).
   */
  theme?: string | null;
}

/** The part of the config that belongs to mods (AppConfig.mods). */
export interface ModsConfig {
  /**
   * By mod key: what was granted when its switch was turned on (a mod with a panel, a tab, a strip, a worker or a
   * command). A missing entry means off (bundled mods: on with their manifest's permissions).
   */
  enabled: Record<string, { permissions: ModPermission[]; styles: boolean; at: number }>;
  /** By mod key: the approval given at the first Use of a look of a user or project mod (bundled looks need none) */
  approved?: Record<string, { permissions: ModPermission[]; at: number }>;
  /** Bundled mod ids the user turned off */
  disabledBundled: string[];
  /** By mod key */
  settings: Record<string, Record<string, unknown>>;
  layout: ModLayout;
  /** Every user and project mod is off while this is set */
  safeMode: boolean;
}

// ---------- What a mod page sees ----------

export interface ModTheme {
  scheme: 'light' | 'dark';
  /** The app's design tokens as they are right now (--bg-100: "#faf9f5", …), including a theme mod's changes */
  tokens: Record<string, string>;
}

export interface ModHello {
  protocol: ModProtocolVersion;
  mod: { id: string; name: string; version: string; scope: ModScope };
  view: { id: string; seat: ModSeat; title: string };
  app: { name: string; version: string };
  granted: ModPermission[];
  theme: ModTheme;
  settings: Record<string, unknown>;
  visible: boolean;
}

/** A session as mods see it. */
export interface ModSession {
  id: string;
  title: string;
  cwd: string;
  origin: SessionOrigin;
  parentId?: string;
  forkedFrom?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  running: boolean;
  attention?: 'approval' | 'question' | 'plan';
}

export interface ModTranscriptItem {
  role: 'user' | 'assistant' | 'tool' | 'plan' | 'artifact' | 'image' | 'compaction';
  /** The message text, the tool's result, the plan's Markdown, the artifact's or image's title, or the compaction summary (long texts are cut) */
  text: string;
  /** tool: the tool's name */
  name?: string;
  /** tool: its arguments as JSON text */
  args?: string;
  ok?: boolean;
  /** user: how many images were attached (the images themselves are not passed to mods) */
  images?: number;
}

export interface OutputItem {
  kind: 'artifact' | 'image' | 'file';
  id: string;
  title: string;
  /** "HTML · v2", "PNG · 1280×720", "+12 −3" */
  detail: string;
  updatedAt: number;
}

/** The settings a mod may read. Never contains keys or other secrets. */
export interface PublicConfig {
  provider: string;
  model: string;
  /** The folder of the session on screen */
  workingDirectory: string;
  /** The user's home folder, for showing paths as ~/… */
  home: string;
  permissionMode: PermissionMode;
  theme: 'system' | 'light' | 'dark';
  autoCompact: boolean;
  compactThreshold: number;
  keepAwake: 'off' | 'running' | 'always';
  notifications: boolean;
  /** "<mod key>/<view id>", "image" for the user's own picture, or null */
  background: string | null;
  contextLimit: number;
}

/** What config.set accepts from a mod. */
export type PublicConfigPatch = Partial<Pick<PublicConfig, 'theme' | 'autoCompact' | 'compactThreshold' | 'keepAwake' | 'notifications' | 'background'>>;

export interface SkillUsage {
  name: string;
  count: number;
  lastUsedAt: number;
}

export interface ModelRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  system?: string;
  /** At most 4000 (default 1000) */
  maxTokens?: number;
  /** session: the open session's conversation goes in front of `messages`, read-only */
  context?: 'none' | 'session';
  /** Chosen by the page; deltas and cancel refer to it */
  requestId?: string;
}

/**
 * Every bridge method: params → result. A method is `namespace.name`; the permission each needs is in
 * MOD_METHOD_PERMISSIONS (main process) and in docs/mods.md.
 */
export interface ModBridge {
  hello: (p: { protocol: number }) => ModHello;
  'events.subscribe': (p: { events: string[] }) => void;
  'events.unsubscribe': (p: { events: string[] }) => void;
  /** The view handles these hook events (the host then sends it "hook" requests) */
  'hooks.subscribe': (p: { events: string[] }) => void;
  'hooks.unsubscribe': (p: { events: string[] }) => void;
  'log.error': (p: { message: string; stack?: string }) => void;

  'ui.theme': () => ModTheme;
  'ui.resize': (p: { height: number }) => void;
  'ui.setTitle': (p: { title: string }) => void;
  'ui.setBadge': (p: { badge: string | number | null }) => void;
  'ui.toast': (p: { text: string; kind?: 'info' | 'error' }) => void;
  'ui.open': (p: { view?: string }) => void;
  'ui.copy': (p: { text: string }) => boolean;
  'ui.openExternal': (p: { url: string }) => void;
  'ui.markdown': (p: { text: string }) => { html: string };
  /** Opens Settings at a section (default "general") */
  'ui.openSettings': (p: { section?: string }) => void;
  /** Opens the Scheduled tasks or the Dreaming page in the main column; form "new": the New task form on Scheduled tasks */
  'ui.openPage': (p: { page: 'scheduled' | 'dreaming'; form?: 'new' }) => void;

  'storage.get': (p: { key: string; scope?: 'mod' | 'session' }) => { value: unknown };
  'storage.set': (p: { key: string; value: unknown; scope?: 'mod' | 'session' }) => void;
  'storage.remove': (p: { key: string; scope?: 'mod' | 'session' }) => void;
  'storage.keys': (p: { scope?: 'mod' | 'session' }) => { keys: string[] };
  'settings.get': () => Record<string, unknown>;

  'session.get': () => ModSession;
  'session.transcript': (p: { limit?: number }) => { items: ModTranscriptItem[] };
  'session.tasks': () => { tasks: TaskItem[] };
  'session.plan': () => { plan: PlanInfo | null };
  'session.outputs': () => { outputs: OutputItem[] };
  'session.context': () => ContextBreakdown;
  'session.related': () => { parent: ModSession | null; children: ModSession[]; forks: ModSession[] };
  'outputs.open': (p: { kind: OutputItem['kind']; id: string }) => void;

  'session.send': (p: { text: string }) => SendResult;
  'composer.insert': (p: { text: string }) => void;

  'session.stop': () => void;
  'session.compact': (p: { focus?: string }) => { ok: boolean; error?: string };
  'sessions.open': (p: { id: string }) => void;
  'sessions.create': () => ModSession;
  'sessions.spawn': (p: { title: string; prompt: string }) => ModSession;
  'sessions.merge': (p: { id: string }) => { ok: boolean; error?: string };

  'sessions.list': () => { sessions: ModSession[] };
  'sessions.search': (p: { query: string; limit?: number }) => { hits: SearchHit[] };

  /** After model.cancel the call still resolves, with what had arrived and `stopped: true` */
  'model.complete': (p: ModelRequest) => { text: string; usage?: { promptTokens: number; completionTokens: number }; stopped?: boolean };
  'model.cancel': (p: { requestId?: string }) => void;

  'skills.list': () => { skills: SkillInfo[] };
  'skills.usage': (p: { scope: 'session' | 'all' }) => { items: SkillUsage[] };

  'config.get': () => PublicConfig;
  'config.set': (p: { patch: PublicConfigPatch }) => PublicConfig;
  /** The git repository of the session's folder: its root, "owner/name" from the origin remote, the branch */
  'project.git': () => { root: string | null; repository: string | null; branch: string | null };

  'schedules.list': () => { schedules: Schedule[] };
  'schedules.create': (p: { input: ScheduleInput }) => Schedule;
  'schedules.update': (p: { id: string; patch: SchedulePatch }) => Schedule;
  'schedules.remove': (p: { id: string }) => void;
  'schedules.runNow': (p: { id: string }) => void;

  'remote.status': () => RemoteStatus;
  'remote.start': () => RemoteStatus;
  'remote.stop': () => RemoteStatus;
}

export type ModMethod = keyof ModBridge;

/** Events the app sends to a view that subscribed (and has the permission). */
export interface ModEvents {
  'theme.changed': ModTheme;
  'settings.changed': Record<string, unknown>;
  /** Background views only: where the pointer is, as fractions of the window (0 to 1), at most 30 times a second */
  pointer: { x: number; y: number };
  'visibility.changed': { visible: boolean };
  command: { name: string; args: string };
  /** Another session came on screen. Needs no permission (it carries only the id), so any view can reset itself. */
  'session.switched': { id: string };

  /** The session on screen changed: its title, its state, or which session it is */
  'session.changed': ModSession;
  /** A sub-session, fork or the parent of the session on screen changed state: read session.related() again */
  'related.changed': Record<string, never>;
  'run.started': { sessionId: string };
  'run.ended': { sessionId: string; reason: string; text?: string };
  'message.user': { text: string; origin: string };
  'message.assistant': { text: string };
  'message.delta': { text: string };
  'tool.started': { id: string; name: string; args: unknown };
  'tool.ended': { id: string; name: string; ok: boolean; durationMs?: number };
  'tasks.changed': { tasks: TaskItem[] };
  'plan.changed': { plan: PlanInfo | null };
  'outputs.changed': Record<string, never>;
  'context.changed': { tokens: number; limit: number };

  'model.delta': { requestId: string; text: string };
  'skills.used': { name: string };
  'config.changed': PublicConfig;
  'schedules.changed': { schedules: Schedule[] };
  'remote.changed': RemoteStatus;
}

export type ModEventName = keyof ModEvents;

/** JSON-RPC 2.0 over postMessage */
export interface ModRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}
export interface ModRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export interface ModRpcEvent {
  jsonrpc: '2.0';
  method: 'event';
  params: { name: string; data: unknown };
}

// ---------- Between the window and the main process ----------

/** What the main process needs to know about the frame a request came from; the renderer fills it in from the iframe, never from the message. */
export interface ModCaller {
  /** ModInfo.key */
  mod: string;
  view: string;
  /** A preview in Settings (a background shown before it is used): answered with what the mod was granted, if anything */
  preview?: boolean;
}

/**
 * A bridge call the renderer cannot answer by itself is forwarded with mods.call. Main checks the permission again
 * and either answers or returns { error }. The ui.*, composer.* and events.* methods are the renderer's own.
 */
export interface ModsRpc {
  'mods.list': () => ModInfo[];
  /** The permission each bridge method and each event needs (null: always available), so the window enforces the same table as the main process */
  'mods.permissions': () => { methods: Record<string, ModPermission | null>; events: Record<string, ModPermission | null> };
  /**
   * Turns a mod on with the permissions its manifest asks for right now (also resumes a paused one), or off. For a mod
   * that is only looks it means using it (its first look of each kind, unless one is in use already) or going back to
   * Default for the kinds it is in use for.
   */
  'mods.setEnabled': (key: string, on: boolean) => ModInfo[];
  /**
   * Puts looks in use, one per kind: "<mod key>/<look id>" (conversation, composer), "<mod key>/<view id>" or "image"
   * (background: the user's picture), "<mod key>" (theme), or null for Default. A user or project mod not approved
   * yet is refused unless `approve` is set, which records the approval (the Use confirmation was shown).
   */
  'mods.use': (patch: Partial<Record<LookKind, string | null>>, opts?: { approve?: boolean }) => ModInfo[];
  /** A look's or a theme's CSS compiled for the previews in Settings (scoped to their own root, never the window's) */
  'mods.previewCss': (input: { kind: 'theme' | ModLookTarget; ref: string }) => { css: string };
  'mods.setSetting': (key: string, setting: string, value: unknown) => ModInfo[];
  'mods.setLayout': (patch: Partial<ModLayout>) => ModLayout;
  'mods.setSafeMode': (on: boolean) => ModInfo[];
  /** Re-reads every mod folder now */
  'mods.reload': () => ModInfo[];
  /** Copies a bundled mod into the user folder so it can be edited; returns the new list */
  'mods.customise': (key: string) => ModInfo[];
  /** Writes a starter mod into the user folder (or the project's) and returns it: a view in `seat`, or a look for `look` */
  'mods.create': (input: { id: string; name: string; seat?: ModSeat; look?: ModLookTarget; theme?: boolean; scope: 'user' | 'project' }) => ModInfo;
  /** Installs from a folder (copied) or a Git URL (cloned) into the user folder */
  'mods.install': (source: string) => ModInfo;
  /** Moves a user mod's folder to the Trash */
  'mods.remove': (key: string) => ModInfo[];
  'mods.reveal': (key: string) => void;
  /** Lets the user pick a picture for the background; returns the layout (unchanged when cancelled) */
  'mods.chooseBackgroundImage': () => ModLayout;
  /** A bridge call from a mod page */
  'mods.call': (caller: ModCaller, method: string, params: unknown) => { result?: unknown; error?: { code: number; message: string; data?: unknown } };
  /** A page reported an uncaught error */
  'mods.report': (caller: ModCaller, problem: { message: string; stack?: string }) => void;
  /** The CSS text of the theme in use (none, or one) */
  'mods.styles': () => { key: string; css: string }[];
  /** The active look of each region (its mod on, chosen in the layout), already scoped to the region */
  'mods.looks': () => { target: ModLookTarget; ref: string; mod: string; css: string }[];
}

export interface ModsEvents {
  /** The list changed: a mod appeared, went away, was edited, turned on or off */
  'mods:changed': ModInfo[];
  /** An event for mod views, already filtered by permission: the renderer hands it to the views of `mod` that subscribed (all mods when `mod` is absent) */
  'mods:event': { mod?: string; name: string; data: unknown };
  /** A mod the user has not turned on (or a look not in use) appeared or wants more than it has: show the card */
  'mods:offer': ModInfo;
}
