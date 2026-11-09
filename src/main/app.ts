// The App: the one object every feature setup receives (see docs/architecture.md). It owns the config, the session
// store and runtime, the event bus, the RPC registry and the registries for tools, prompt sections, slash commands
// and services. No Electron at run time (only its types), so the headless tests can build one.

import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AppConfig, CommandInfo, CommandResult, LiveState, PermissionMode, TranscriptItem } from '../shared/types';
import type { RpcEvents, RpcMethods } from '../shared/rpc';
import type { ArtifactStore } from './artifacts';
import type { BrowserController } from './browser';
import { normalizeConfig, withRecentDir } from './config';
import { defaultWorkDir } from './paths';
import { windowConfig } from './providers';
import { settingsLayer } from './settings';
import type { McpManager } from './mcp';
import { SessionRuntime } from './runtime';
import { SessionStore, toTranscript } from './sessions';
import { loadSkills } from './skills';
import type { TerminalManager } from './terminal';
import type { Tool } from './tools';

export type Disposer = () => void;

/** A slash command that is not a skill (app.commands.register). */
export type Command = CommandInfo & { run(args: string, ctx: { sessionId: string }): CommandResult | Promise<CommandResult> };

export interface App {
  /** Electron's userData folder */
  readonly userData: string;
  /** app.getAppPath(): where the bundled skills/ (and later mods/) live */
  readonly appRoot: string;
  /** The effective config */
  config(): AppConfig;
  /** Applies a change, normalises, saves config.json, then tells subscribers and the window ('config:changed'). Returns the new config. */
  updateConfig(change: Partial<AppConfig> | ((current: AppConfig) => AppConfig)): AppConfig;
  onConfig(cb: (next: AppConfig, prev: AppConfig) => void): Disposer;
  /** The main window, or null */
  window(): BrowserWindow | null;
  /** A push event to the window (oc.onPush); dropped when there is no window */
  push<K extends keyof RpcEvents>(channel: K, payload: RpcEvents[K]): void;
  readonly rpc: { handle<K extends keyof RpcMethods>(method: K, fn: (...args: Parameters<RpcMethods[K]>) => ReturnType<RpcMethods[K]> | Promise<ReturnType<RpcMethods[K]>>): Disposer };
  readonly store: SessionStore;
  readonly runtime: SessionRuntime;
  /** Every agent event of every session, in order */
  readonly events: { on(cb: (sessionId: string, ev: AgentEvent) => void): Disposer };
  /** Extra tools offered to the model next to the built-in and MCP ones */
  readonly tools: { register(tool: Tool): Disposer; list(): Tool[] };
  /** Extra system-prompt sections; an empty string adds nothing */
  /** `optional` sections belong to optional tools and are left out with them (see AppConfig.toolSet). A session with a */
  /** tool set of its own (Session.tools) gets only the sections added with `restricted` (they say what it can do). */
  /** `perSession` sections differ from session to session (its name, its parent): they go at the very end of the */
  /** prompt, so the part every session shares stays the same from its first character (for prompt caching). */
  readonly prompt: { add(id: string, section: (info: { cwd: string; mode: PermissionMode; sessionId: string }) => string, opts?: { optional?: boolean; restricted?: boolean; perSession?: boolean }): Disposer };
  /** Slash commands that are not skills */
  readonly commands: { register(cmd: Command): Disposer; list(): CommandInfo[] };
  /** Named services features expose to each other, e.g. app.service<HistoryService>('history') */
  provide(name: string, service: unknown): Disposer;
  service<T>(name: string): T | undefined;
  /** Runs at quit, last registered first */
  onQuit(fn: () => void | Promise<void>): void;
}

export interface AppOptions {
  userData: string;
  appRoot: string;
  loadConfig: () => AppConfig;
  saveConfig: (cfg: AppConfig) => void;
  /** Default: <userData>/sessions */
  sessionsDir?: string;
  /** The window's browser pane (null while there is no window) */
  browser?: () => BrowserController | null;
  terminal?: TerminalManager;
  artifacts?: ArtifactStore;
  /** Made once the app exists, since the manager reads and saves the config through it */
  mcp?: (app: App) => McpManager | null;
}

type SectionFn = (info: { cwd: string; mode: PermissionMode; sessionId: string }) => string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => unknown;

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Merges runs of text_delta / thinking_delta events into one message every 30 ms. A local model emits a token
 * every few milliseconds; one IPC message and one renderer update per token is wasted work nobody can see.
 * Any other event flushes what is pending first, so the order is kept. flush() sends what is pending now.
 */
export function coalesceDeltas(send: (ev: AgentEvent) => void): { send: (ev: AgentEvent) => void; flush: () => void } {
  let pending: { type: 'text_delta' | 'thinking_delta'; text: string } | null = null;
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      const p = pending;
      pending = null;
      send(p);
    }
  };
  return {
    flush,
    send: (ev) => {
      if (ev.type === 'text_delta' || ev.type === 'thinking_delta') {
        if (pending && pending.type === ev.type) {
          pending.text += ev.text;
          return;
        }
        flush();
        pending = { type: ev.type, text: ev.text };
        timer = setTimeout(flush, 30);
        return;
      }
      flush();
      send(ev);
    },
  };
}

export class AppHost implements App {
  readonly userData: string;
  readonly appRoot: string;
  readonly store: SessionStore;
  readonly runtime: SessionRuntime;
  readonly terminal?: TerminalManager;
  readonly artifacts?: ArtifactStore;
  /** MCP servers. Project servers come from the app's folder (the session on screen), not each session's own. */
  readonly mcp: McpManager | null;
  readonly events: App['events'];
  readonly tools: App['tools'];
  readonly prompt: App['prompt'];
  readonly commands: App['commands'];
  readonly rpc: App['rpc'];

  private cfg: AppConfig;
  private win: BrowserWindow | null = null;
  private readonly saveFn: (cfg: AppConfig) => void;
  private readonly configListeners = new Set<(next: AppConfig, prev: AppConfig) => void>();
  private readonly handlers = new Map<string, AnyFn>();
  private readonly toolList: Tool[] = [];
  private readonly sections = new Map<string, SectionFn>();
  private readonly optionalSections = new Set<string>();
  private readonly restrictedSections = new Set<string>();
  private readonly perSessionSections = new Set<string>();
  private readonly commandMap = new Map<string, Command>();
  private readonly services = new Map<string, unknown>();
  private readonly quitFns: (() => void | Promise<void>)[] = [];
  private readonly windowSinks = new Map<string, ReturnType<typeof coalesceDeltas>>();
  /** The LiveState taken together with a switch's transcript, handed out once by sessions.live (see showSession) */
  private readonly switchLive = new Map<string, LiveState>();
  private listTimer: NodeJS.Timeout | null = null;

  constructor(opts: AppOptions) {
    this.userData = opts.userData;
    this.appRoot = opts.appRoot;
    this.cfg = normalizeConfig(opts.loadConfig());
    this.saveFn = opts.saveConfig;
    this.terminal = opts.terminal;
    this.artifacts = opts.artifacts;
    this.store = new SessionStore(opts.sessionsDir ?? path.join(opts.userData, 'sessions'));

    this.events = { on: (cb) => this.runtime.onEvent(cb) };
    this.tools = {
      register: (tool) => {
        if (!tool || !tool.name) throw new Error('A tool needs a name.');
        if (this.toolList.some((t) => t.name === tool.name)) throw new Error(`A tool named ${tool.name} is already registered.`);
        this.toolList.push(tool);
        return () => {
          const i = this.toolList.indexOf(tool);
          if (i >= 0) this.toolList.splice(i, 1);
        };
      },
      list: () => [...this.toolList],
    };
    this.prompt = {
      add: (id, section, opts) => {
        if (this.sections.has(id)) throw new Error(`A prompt section ${id} is already registered.`);
        this.sections.set(id, section);
        if (opts?.optional) this.optionalSections.add(id);
        if (opts?.restricted) this.restrictedSections.add(id);
        if (opts?.perSession) this.perSessionSections.add(id);
        return () => {
          if (this.sections.get(id) === section) {
            this.sections.delete(id);
            this.optionalSections.delete(id);
            this.restrictedSections.delete(id);
            this.perSessionSections.delete(id);
          }
        };
      },
    };
    this.commands = {
      register: (cmd) => {
        const name = String(cmd?.name ?? '').replace(/^\//, '');
        if (!/^[\w-]+$/.test(name)) throw new Error(`Not a command name: ${cmd?.name}`);
        if (this.commandMap.has(name)) throw new Error(`A command /${name} is already registered.`);
        const entry = { ...cmd, name };
        this.commandMap.set(name, entry);
        return () => {
          if (this.commandMap.get(name) === entry) this.commandMap.delete(name);
        };
      },
      list: () => [...this.commandMap.values()].map(({ name, description, source, argsHint }) => (argsHint ? { name, description, source, argsHint } : { name, description, source })),
    };
    this.rpc = {
      handle: (method, fn) => {
        const name = String(method);
        if (this.handlers.has(name)) throw new Error(`The RPC method ${name} is already handled.`);
        this.handlers.set(name, fn as AnyFn);
        return () => {
          if (this.handlers.get(name) === fn) this.handlers.delete(name);
        };
      },
    };

    this.runtime = new SessionRuntime({
      store: this.store,
      config: () => this.cfg,
      skills: (cwd) => loadSkills(cwd, this.appRoot),
      browser: opts.browser ?? (() => null),
      terminal: opts.terminal,
      artifacts: opts.artifacts,
      mcp: () => this.mcp,
      app: this,
      tools: () => this.tools.list(),
      prompt: (info) => this.promptFor(info),
      updateConfig: (fn) => this.updateConfig(fn),
    });
    this.mcp = opts.mcp?.(this) ?? null;

    // The window: every event, coalesced per session, tagged with its session.
    this.runtime.setSink((id, ev) => this.windowSink(id).send(ev));
    this.runtime.onListChanged(() => this.scheduleListPush());

    // Invariant: config.workingDirectory is the folder of the session on screen.
    this.runtime.onForeground((id) => this.followSession(id));
    this.onConfig((next, prev) => {
      if (next.workingDirectory === prev.workingDirectory) return;
      // The folder was changed from the UI (or followed the session): the session on screen works there from its next run on.
      const s = this.store.get(this.runtime.foregroundId());
      if (s && s.cwd !== next.workingDirectory) {
        s.cwd = next.workingDirectory;
        this.store.save(s, false);
      }
    });

    this.rpc.handle('commands.list', () => this.commands.list());
    this.rpc.handle('commands.run', async (name, args) => {
      const cmd = this.commandMap.get(String(name ?? '').replace(/^\//, ''));
      if (!cmd) return { error: `Unknown command /${name}` };
      try {
        const r = await cmd.run(String(args ?? ''), { sessionId: this.runtime.foregroundId() });
        return r && typeof r === 'object' ? r : {};
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });
    this.rpc.handle('sessions.live', (id) => {
      const key = String(id);
      this.windowSinks.get(key)?.flush();
      const taken = this.switchLive.get(key);
      this.switchLive.delete(key);
      return taken ?? this.runtime.live(key);
    });
    this.rpc.handle('sessions.transcript', (id) => {
      const s = this.store.get(String(id));
      if (!s) throw new Error(`No conversation ${id}`);
      return toTranscript(s, { running: this.runtime.isRunning(s.id) });
    });
    this.rpc.handle('config.defaultWorkDir', () => {
      const dir = defaultWorkDir();
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* switching to it says it is gone */
      }
      return dir;
    });
  }

  // ---------- Config ----------

  config(): AppConfig {
    return this.cfg;
  }

  updateConfig(change: Partial<AppConfig> | ((current: AppConfig) => AppConfig)): AppConfig {
    const prev = this.cfg;
    let next = normalizeConfig(typeof change === 'function' ? change(prev) : { ...prev, ...change });
    // Every folder change puts the new folder first in the recent list (and drops folders that are gone).
    if (next.workingDirectory !== prev.workingDirectory && next.recentDirs === prev.recentDirs) {
      next = { ...next, recentDirs: withRecentDir(prev.recentDirs, next.workingDirectory, prev.workingDirectory) };
    }
    this.cfg = next;
    this.saveFn(next);
    for (const cb of [...this.configListeners]) {
      try {
        cb(next, prev);
      } catch (err) {
        console.warn('[app] a config listener failed:', err);
      }
    }
    // The window's copy: keys masked, the providers resolved (see providers.ts).
    this.push('config:changed', windowConfig(next, settingsLayer.info().owned));
    return next;
  }

  onConfig(cb: (next: AppConfig, prev: AppConfig) => void): Disposer {
    this.configListeners.add(cb);
    return () => this.configListeners.delete(cb);
  }

  /**
   * The app's folder follows the session brought on screen, when that folder still exists. A session without a
   * folder (stored before folders were per session), or whose folder is gone, adopts the current one instead.
   * The settings.json project layer is read at start-up for the folder then current and is not re-read here.
   */
  private followSession(id: string): void {
    const s = this.store.get(id);
    if (!s) return;
    const current = this.cfg.workingDirectory;
    if (!s.cwd || !isDir(s.cwd)) {
      s.cwd = current;
      this.store.save(s, false);
      return;
    }
    if (s.cwd !== current) this.updateConfig({ workingDirectory: s.cwd });
  }

  // ---------- Window ----------

  window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  setWindow(win: BrowserWindow | null): void {
    this.win = win;
  }

  push<K extends keyof RpcEvents>(channel: K, payload: RpcEvents[K]): void {
    const w = this.window();
    if (w) w.webContents.send('rpc:push', channel, payload);
  }

  /** Runs an RPC call from the window. Unknown methods reject. */
  async invokeRpc(method: string, args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(String(method));
    if (!fn) throw new Error(`Unknown RPC method ${method}`);
    return fn(...args);
  }

  private windowSink(id: string): ReturnType<typeof coalesceDeltas> {
    let sink = this.windowSinks.get(id);
    if (!sink) {
      sink = coalesceDeltas((ev) => {
        const w = this.window();
        if (w) w.webContents.send('agent:event', ev, id);
      });
      this.windowSinks.set(id, sink);
    }
    return sink;
  }

  /** The session list changed: one 'sessions:changed' push per burst. */
  private scheduleListPush(): void {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      this.push('sessions:changed', this.runtime.list());
    }, 40);
  }

  /**
   * Brings a session on screen and returns its transcript. The LiveState is taken at the same moment, after the
   * session's pending deltas went out, and kept for the window's sessions.live call that follows: the transcript and
   * the live state then describe the same instant, and every event after it reaches the window after this reply.
   */
  showSession(id: string): TranscriptItem[] {
    const s = this.runtime.setForeground(id);
    this.windowSinks.get(id)?.flush();
    const running = this.runtime.isRunning(id);
    this.switchLive.set(id, this.runtime.live(id));
    return toTranscript(s, { running });
  }

  // ---------- Registries ----------

  /**
   * The registered prompt sections for one request, joined (failures are logged and left out). `restricted`: the
   * session has a tool set of its own, and only the sections written for such sessions apply. `part`: only the sections
   * every session shares, or only the per-session ones; without it all of them, the shared ones first.
   */
  promptFor(info: { cwd: string; mode: PermissionMode; sessionId: string; essential?: boolean; restricted?: boolean; part?: 'shared' | 'session' }): string {
    if (!info.part) return [this.promptFor({ ...info, part: 'shared' }), this.promptFor({ ...info, part: 'session' })].filter(Boolean).join('\n\n');
    const out: string[] = [];
    for (const [id, fn] of this.sections) {
      if (info.restricted ? !this.restrictedSections.has(id) : this.restrictedSections.has(id)) continue;
      if (info.essential && this.optionalSections.has(id)) continue;
      if (this.perSessionSections.has(id) !== (info.part === 'session')) continue;
      try {
        const text = fn(info);
        if (typeof text === 'string' && text.trim()) out.push(text.trim());
      } catch (err) {
        console.warn(`[app] prompt section ${id} failed:`, err);
      }
    }
    return out.join('\n\n');
  }

  provide(name: string, service: unknown): Disposer {
    if (this.services.has(name)) throw new Error(`A service ${name} is already provided.`);
    this.services.set(name, service);
    return () => {
      if (this.services.get(name) === service) this.services.delete(name);
    };
  }

  service<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  onQuit(fn: () => void | Promise<void>): void {
    this.quitFns.push(fn);
  }

  /** Runs the quit handlers, last registered first; each gets `perHandlerMs` before the next one runs. */
  async runQuit(perHandlerMs = 3000): Promise<void> {
    const fns = this.quitFns.splice(0).reverse();
    for (const fn of fns) {
      try {
        await Promise.race([Promise.resolve().then(fn), new Promise((r) => setTimeout(r, perHandlerMs))]);
      } catch (err) {
        console.warn('[app] a quit handler failed:', err);
      }
    }
  }
}

export function createApp(opts: AppOptions): AppHost {
  return new AppHost(opts);
}
