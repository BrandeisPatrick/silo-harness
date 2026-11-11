// Mods, main-process half: the registry of installed mods, serving their pages on mod://, the lock-down of mod
// frames, the bridge their pages call through the window, and what the agent gets for writing them.
// The core calls setupMods(app) once, after Electron is ready. createMods holds everything that does not need
// Electron itself, so the headless tests can drive it with a fake App.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dialog, protocol, shell } from 'electron';
import type { App } from './app';
import type { LookKind, ModCaller, ModInfo, ModLayout, ModLookTarget, ModPermission, ModSeat, ModsConfig } from '../shared/mods';
import type { AppConfig } from '../shared/types';
import { configDir, projectConfigDir } from './paths';
import { loadSkills } from './skills';
import { ModRegistry } from './mods/registry';
import { LOOK_KINDS, hasFeatureParts, hasLookParts, inUseKinds, isPartOf, lookPartsOf, needsStylesApproval, settingFits, splitRef } from './mods/manifest';
import { MOD_SCHEME, MOD_SCHEME_PRIVILEGES, resolveModUrl, type ServeContext } from './mods/serve';
import { ModStorage } from './mods/storage';
import { SkillUsageTracker } from './mods/skill-usage';
import { ModBridgeHandler, holds } from './mods/bridge';
import { publicConfig } from './mods/public-config';
import { ModCommands, modCheckTool, modsPrompt } from './mods/assist';
import { ManageError, createMod, customiseMod, installMod } from './mods/manage';
import { installModLockdown } from './mods/lockdown';
import { MOD_EVENT_PERMISSIONS, MOD_LOOK_TARGETS, MOD_METHOD_PERMISSIONS } from './mods/permissions';
import { LOOK_ROOTS, PREVIEW_ROOTS, modUrlRewriter, scopeCss } from './mods/css';
import { MOD_HOOK_TIMEOUT_MS, type HookEngine, type ModHookReply, type ModHookSet } from './hooks/engine';

export { MOD_SCHEME, MOD_SCHEME_PRIVILEGES };
export { MOD_METHOD_PERMISSIONS } from './mods/permissions';

const STYLE_MAX_BYTES = 500 * 1024;
const REPORT_MAX_CHARS = 2000;
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

/** What the mods code needs from the desktop (Electron in the app; fakes in tests). */
export interface ModsHost {
  /** Moves a folder to the Trash */
  trash(dir: string): Promise<void>;
  reveal(dir: string): void;
  /** The picture the user picked, or null */
  chooseImage(): Promise<string | null>;
}

export interface ModsController {
  registry: ModRegistry;
  storage: ModStorage;
  usage: SkillUsageTracker;
  bridge: ModBridgeHandler;
  commands: ModCommands;
  /** Where mod:// finds things; for the protocol handler */
  serve: ServeContext;
  /** Pushes an event to one mod's views (or every on mod holding the event's permission when `mod` is absent) */
  emit(mod: string | undefined, name: string, data: unknown): void;
  close(): void;
}

function electronHost(app: App): ModsHost {
  return {
    trash: (dir) => shell.trashItem(dir),
    reveal: (dir) => shell.showItemInFolder(path.join(dir, 'mod.json')),
    async chooseImage() {
      const win = app.window();
      const opts: Electron.OpenDialogOptions = { title: 'Choose a background picture', properties: ['openFile'], filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }] };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every region with the app's own look */
export const noLooks = (): Record<ModLookTarget, string | null> => ({ conversation: null, composer: null });

export { splitRef };

const KIND_WORDS: Record<LookKind, string> = { background: 'background', composer: 'chat bar look', conversation: 'conversation look' };

/** Puts one kind's look in use in a layout (being changed): null is Default, "image" the user's picture for the background. */
export function applyUse(layout: ModLayout, kind: LookKind, ref: string | null): void {
  if (kind === 'background') {
    if (ref === null) {
      layout.background = null;
      layout.backgroundImage = null;
    } else layout.background = ref === 'image' ? null : ref;
  } else layout.looks = { ...noLooks(), ...layout.looks, [kind]: ref };
}

/**
 * Forgets what the config holds for a mod whose folder is gone: its grant, its approval, its settings, and its looks
 * in use (the background, a region's look), which go back to Default.
 */
export function forgetMod(c: ModsConfig, key: string): void {
  delete c.enabled[key];
  delete c.approved![key];
  delete c.settings[key];
  const ofMod = (ref: string | null | undefined): boolean => !!ref && splitRef(ref)?.key === key;
  const l = c.layout;
  if (ofMod(l.background)) l.background = null;
  for (const t of MOD_LOOK_TARGETS) if (ofMod(l.looks?.[t])) applyUse(l, t, null);
}

/** A copy of the mods section to change (never the live one). */
function cloneMods(m: ModsConfig): ModsConfig {
  return {
    enabled: { ...(m.enabled ?? {}) },
    disabledBundled: [...(m.disabledBundled ?? [])],
    approved: { ...(m.approved ?? {}) },
    settings: { ...(m.settings ?? {}) },
    layout: { ...m.layout, collapsed: [...(m.layout?.collapsed ?? [])], closedTabs: [...(m.layout?.closedTabs ?? [])], looks: { ...noLooks(), ...(m.layout?.looks ?? {}) } },
    safeMode: !!m.safeMode,
  };
}

export function createMods(app: App, host: ModsHost = electronHost(app)): ModsController {
  const userRoot = () => path.join(configDir(), 'mods');
  const backgroundsDir = path.join(app.userData, 'backgrounds');
  const mods = () => app.config().mods;

  // Late-bound so the registry's first scan can run before the rest exists.
  let ctl: ModsController | null = null;
  const registry = new ModRegistry({
    bundledRoot: path.join(app.appRoot, 'mods'),
    userRoot,
    projectDir: () => app.config().workingDirectory,
    projectRoot: (dir) => path.join(projectConfigDir(dir), 'mods'),
    mods,
    onChange: (list) => {
      app.push('mods:changed', list);
      if (!ctl) return;
      ctl.commands.sync(list);
      for (const key of [...new Set(list.filter((m) => m.state !== 'on').map((m) => m.key))]) ctl.bridge.cancelAll(key);
    },
    onOffer: (info) => app.push('mods:offer', info),
  });

  const emit = (mod: string | undefined, name: string, data: unknown) => {
    if (mod) return app.push('mods:event', { mod, name, data });
    const need = (MOD_EVENT_PERMISSIONS[name] ?? null) as ModPermission | null;
    // Events that need a permission go to each mod that holds it, so a view never receives what it may not see.
    if (!need) return app.push('mods:event', { name, data });
    for (const m of registry.list()) if (holds(m, need)) app.push('mods:event', { mod: m.key, name, data });
  };

  const storage = new ModStorage(path.join(app.userData, 'mods-data'));
  const usage = new SkillUsageTracker({
    file: path.join(app.userData, 'skill-usage.json'),
    skillNames: () => loadSkills(app.config().workingDirectory, app.appRoot).map((s) => s.name),
    onUsed: (name) => emit(undefined, 'skills.used', { name }),
  });
  const bridge = new ModBridgeHandler({ app, registry, storage, usage, emit: (mod, name, data) => emit(mod, name, data), previewable: (m) => previewable(m) });
  const commands = new ModCommands(
    (cmd) => app.commands.register(cmd),
    (mod, data) => emit(mod, 'command', data),
  );
  /**
   * A mod whose looks Settings may preview before they are used: valid, with looks, not waiting for a new approval,
   * and not a user or project mod in safe mode. Its files are served and its preview frames answered, with only
   * what it was granted (nothing, before its first Use).
   */
  const previewable = (m: ModInfo): boolean => !!m.manifest && hasLookParts(m.manifest) && m.state !== 'invalid' && m.state !== 'paused' && !(app.config().mods.safeMode && m.scope !== 'bundled');
  const serve: ServeContext = {
    lookup: (label) => {
      const m = registry.byLabel(label);
      return m && (m.state === 'on' || m.approved || previewable(m)) ? { dir: m.dir, network: m.granted.includes('network') } : null;
    },
    harnessDir: path.join(app.appRoot, 'modkit'),
    backgroundsDir,
  };
  const disposers: (() => void)[] = [];

  // ---------- Config ----------

  const change = (fn: (m: ModsConfig, cfg: AppConfig) => void): AppConfig =>
    app.updateConfig((cur) => {
      const next = cloneMods(cur.mods);
      fn(next, cur);
      return { ...cur, mods: next };
    });

  const must = (key: unknown): ModInfo => {
    const m = registry.get(String(key));
    if (!m) throw new Error(`No mod ${String(key)}.`);
    return m;
  };

  disposers.push(
    app.onConfig((next, prev) => {
      if (next.workingDirectory !== prev.workingDirectory) {
        registry.rewatch();
        registry.scan();
      } else if (JSON.stringify(next.mods) !== JSON.stringify(prev.mods)) registry.recompute();
      const cwd = app.runtime.list().find((m) => m.id === app.runtime.foregroundId())?.cwd;
      const a = publicConfig(next, cwd);
      if (JSON.stringify(a) !== JSON.stringify(publicConfig(prev, cwd))) emit(undefined, 'config.changed', a);
    }),
  );

  // ---------- What the window calls ----------

  const h = app.rpc.handle.bind(app.rpc);
  disposers.push(
    h('mods.list', () => registry.list()),
    h('mods.permissions', () => ({ methods: { ...MOD_METHOD_PERMISSIONS }, events: { ...MOD_EVENT_PERMISSIONS } })),
    h('mods.setEnabled', (key, on) => {
      const m = must(key);
      if (on && !m.manifest) throw new Error(`${m.id} has no valid mod.json, so it cannot be turned on. ${m.problems[0]?.message ?? ''}`.trim());
      change((c) => {
        if (m.manifest && !hasFeatureParts(m.manifest) && hasLookParts(m.manifest)) {
          // Only looks: no switch. On means used (approved, for a mod of yours or a project's), off back to Default.
          if (on) {
            if (m.scope !== 'bundled') c.approved![m.key] = { permissions: [...(m.manifest.permissions ?? [])], at: Date.now() };
            if (!inUseKinds(m.key, m.manifest, c.layout).length) {
              const parts = lookPartsOf(m.key, m.manifest);
              for (const k of LOOK_KINDS) if (parts[k]) applyUse(c.layout, k, parts[k]);
            }
          } else for (const k of inUseKinds(m.key, m.manifest, c.layout)) applyUse(c.layout, k, null);
          // What a switch of 0.8.0 left behind means nothing now
          delete c.enabled[m.key];
          if (m.scope === 'bundled') c.disabledBundled = c.disabledBundled.filter((id) => id !== m.id);
        } else if (m.scope === 'bundled') {
          c.disabledBundled = c.disabledBundled.filter((id) => id !== m.id);
          if (!on) c.disabledBundled.push(m.id);
        } else if (on) {
          // Turning on grants exactly what the manifest asks for now (which also resumes a paused mod).
          c.enabled[m.key] = { permissions: [...(m.manifest!.permissions ?? [])], styles: needsStylesApproval(m.manifest), at: Date.now() };
        } else delete c.enabled[m.key];
      });
      registry.recompute();
      registry.markOffered();
      return registry.list();
    }),
    h('mods.use', (patch, opts) => {
      if (!isObj(patch)) throw new Error('mods.use needs the looks to use, e.g. { "conversation": "<mod key>/<look id>" } (null for Default).');
      const approve = isObj(opts) && opts.approve === true;
      const cfg = app.config().mods;
      const next: [LookKind, string | null][] = [];
      const approving = new Map<string, ModInfo>();
      for (const [kind, ref] of Object.entries(patch)) {
        // A kind this app does not know is ignored, like an unknown field.
        if (!(LOOK_KINDS as readonly string[]).includes(kind)) continue;
        const k = kind as LookKind;
        if (ref === null) {
          next.push([k, null]);
          continue;
        }
        if (typeof ref !== 'string' || !ref) throw new Error(`${kind} must be what to use ("<mod key>/<id>") or null for Default.`);
        if (k === 'background' && ref === 'image') {
          if (!cfg.layout.backgroundImage) throw new Error('There is no picture of yours to use; choose one first.');
          next.push([k, ref]);
          continue;
        }
        const owner = splitRef(ref)?.key;
        const m = owner ? registry.get(owner) : undefined;
        if (!m || !m.manifest || !isPartOf(k, ref, m.key, m.manifest)) throw new Error(`${ref} is not a ${KIND_WORDS[k]} of an installed mod.`);
        if (!m.approved) {
          if (m.scope !== 'bundled' && cfg.safeMode) throw new Error('Safe mode is on: the looks of your mods and of a project stay off until you leave it.');
          if (!approve) throw new Error(`${m.manifest.name} has not been approved yet: its first Use asks first (pass { approve: true } once the user agreed).`);
          approving.set(m.key, m);
        }
        next.push([k, ref]);
      }
      change((c) => {
        for (const m of approving.values()) c.approved![m.key] = { permissions: [...(m.manifest!.permissions ?? [])], at: Date.now() };
        for (const [k, ref] of next) applyUse(c.layout, k, ref);
      });
      registry.recompute();
      registry.markOffered();
      return registry.list();
    }),
    h('mods.previewCss', (input) => {
      if (!isObj(input)) throw new Error('mods.previewCss needs { kind, ref }.');
      const kind = input.kind;
      const ref = String(input.ref ?? '');
      if (kind !== 'conversation' && kind !== 'composer') throw new Error('kind must be conversation or composer.');
      const at = splitRef(ref);
      const m = at ? registry.get(at.key) : undefined;
      const look = m?.manifest?.contributes?.looks?.find((l) => l.id === at!.id && l.target === kind);
      if (!m || !look) throw new Error(`${ref} is not a ${KIND_WORDS[kind]} of an installed mod.`);
      return { css: look.styles.map((rel) => scopeCss(readStyle(m, rel) ?? '', PREVIEW_ROOTS[kind], { url: modUrlRewriter(m.origin, rel), prefix: m.id })).join('\n') };
    }),
    h('mods.setSetting', (key, setting, value) => {
      const m = must(key);
      const field = m.manifest?.contributes?.settings?.find((f) => f.key === setting);
      if (!field) throw new Error(`${m.id} has no setting ${String(setting)}.`);
      if (!settingFits(field, value)) {
        const want = field.type === 'select' ? `one of ${field.options.join(', ')}` : field.type === 'number' ? `a number${field.min !== undefined ? ` from ${field.min}` : ''}${field.max !== undefined ? ` to ${field.max}` : ''}` : `a ${field.type}`;
        throw new Error(`${field.key}: must be ${want}.`);
      }
      change((c) => {
        c.settings[m.key] = { ...(c.settings[m.key] ?? {}), [field.key]: value };
      });
      registry.recompute();
      const after = registry.get(m.key);
      if (after) emit(m.key, 'settings.changed', after.settings);
      return registry.list();
    }),
    h('mods.setLayout', (patch) => {
      const layout = checkLayout(patch, backgroundsDir);
      return change((c) => {
        // looks is merged region by region: { looks: { conversation: … } } leaves the chat bar's look as it is.
        c.layout = { ...c.layout, ...layout, looks: { ...noLooks(), ...c.layout.looks, ...(layout.looks ?? {}) } };
      }).mods.layout;
    }),
    h('mods.setSafeMode', (on) => {
      change((c) => {
        c.safeMode = !!on;
      });
      registry.recompute();
      registry.markOffered();
      return registry.list();
    }),
    h('mods.reload', () => registry.scan()),
    h('mods.customise', (key) => {
      const m = must(key);
      if (m.scope !== 'bundled') throw new Error(`${m.id} is not a bundled mod; edit its folder directly (${m.dir}).`);
      customiseMod(m.dir, userRoot(), m.id);
      // The copy replaces a panel the user had on, so it starts on with the same grant rather than vanishing; its
      // looks are the bundled ones as they were, so they stay usable (and in use) without asking.
      if (m.manifest && ((m.state === 'on' && hasFeatureParts(m.manifest)) || hasLookParts(m.manifest))) {
        change((c) => {
          if (m.state === 'on' && hasFeatureParts(m.manifest)) c.enabled[m.id] = { permissions: [...(m.manifest!.permissions ?? [])], styles: needsStylesApproval(m.manifest), at: Date.now() };
          if (hasLookParts(m.manifest)) c.approved![m.id] = { permissions: [...(m.manifest!.permissions ?? [])], at: Date.now() };
        });
      }
      registry.scan();
      registry.markOffered();
      return registry.list();
    }),
    h('mods.create', (input) => {
      if (!isObj(input)) throw new Error('mods.create needs { id, name, seat, scope }.');
      const scope = input.scope === 'project' ? 'project' : 'user';
      const root = scope === 'project' ? path.join(projectConfigDir(app.config().workingDirectory), 'mods') : userRoot();
      const id = String(input.id ?? '');
      if (registry.list().some((m) => m.id === id && (m.scope === scope || (scope === 'user' && m.scope === 'bundled')))) throw new ManageError(`A mod with the id "${id}" already exists.`);
      createMod(root, { id, name: input.name, seat: input.seat as ModSeat, look: input.look as ModLookTarget | undefined });
      registry.scan();
      const made = registry.list().find((m) => m.id === id && m.scope === scope);
      if (!made) throw new Error('The starter mod was written but could not be read back.');
      return made;
    }),
    h('mods.install', async (source) => {
      const taken = (id: string) => registry.list().some((m) => m.id === id && (m.scope === 'user' || m.scope === 'bundled'));
      const dir = await installMod(userRoot(), String(source ?? ''), taken);
      registry.scan();
      const made = registry.list().find((m) => m.dir === dir);
      if (!made) throw new Error('The mod was installed but could not be read back.');
      return made;
    }),
    h('mods.remove', async (key) => {
      const m = must(key);
      if (m.scope !== 'user') throw new Error(m.scope === 'bundled' ? 'Bundled mods cannot be removed; turn it off instead.' : `Project mods belong to the project; delete ${m.dir} there.`);
      await host.trash(m.dir);
      change((c) => {
        delete c.enabled[m.key];
        delete c.approved![m.key];
        delete c.settings[m.key];
        // Its looks in use go back to Default (a bundled mod it replaced is not picked in its place)
        for (const k of inUseKinds(m.key, m.manifest, c.layout)) applyUse(c.layout, k, null);
      });
      registry.scan();
      return registry.list();
    }),
    h('mods.removeAll', async () => {
      // Every folder in the user root goes, listed or not (a folder of yours without a usable mod.json is yours too);
      // dotfolders (an install's staging folder) are skipped as the scanner skips them. Never the bundled or a
      // project's folders. The user mod key is the folder name.
      const root = userRoot();
      let names: string[] = [];
      try {
        names = fs.readdirSync(root);
      } catch {
        names = [];
      }
      const removed: string[] = [];
      for (const name of names.sort()) {
        if (name.startsWith('.')) continue;
        const dir = path.join(root, name);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        await host.trash(dir);
        removed.push(name);
      }
      if (removed.length) {
        change((c) => {
          for (const key of removed) forgetMod(c, key);
        });
      }
      registry.scan();
      return { removed, mods: registry.list() };
    }),
    h('mods.reveal', (key) => host.reveal(must(key).dir)),
    h('mods.chooseBackgroundImage', async () => {
      const picked = await host.chooseImage();
      if (!picked) return app.config().mods.layout;
      const ext = path.extname(picked).toLowerCase().replace('.', '');
      if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error('Choose a PNG, JPEG, WebP or GIF picture.');
      fs.mkdirSync(backgroundsDir, { recursive: true });
      const name = `${Date.now()}-${path.basename(picked, path.extname(picked)).replace(/[^\w-]+/g, '_').slice(0, 60) || 'background'}.${ext}`;
      const dest = path.join(backgroundsDir, name);
      fs.copyFileSync(picked, dest);
      return change((c) => {
        c.layout.backgroundImage = dest;
        c.layout.background = null;
      }).mods.layout;
    }),
    h('mods.call', (caller, method, params) => bridge.call(caller, method, params)),
    h('mods.report', (caller: ModCaller, problem) => {
      const m = registry.get(String(caller?.mod));
      if (!m || !isObj(problem)) return;
      const message = String(problem.message ?? 'Unknown error').slice(0, REPORT_MAX_CHARS);
      const stack = typeof problem.stack === 'string' ? problem.stack.split('\n').slice(0, 6).join('\n').slice(0, REPORT_MAX_CHARS) : '';
      registry.report(m.key, { message: stack && !stack.includes(message) ? `${message}\n${stack}` : stack || message, view: typeof caller.view === 'string' ? caller.view : undefined, at: Date.now() });
    }),
    h('mods.looks', () => activeLooks()),
  );

  // ---------- Styles and looks ----------

  /** A CSS file of a mod that is served (on, its looks approved, or previewable), as text (null when it is not there any more) */
  function readStyle(m: ModInfo, rel: string): string | null {
    const r = resolveModUrl(`${m.origin}/${rel.split('/').map(encodeURIComponent).join('/')}`, serve);
    if (!r.file) return null;
    try {
      return fs.readFileSync(r.file).subarray(0, STYLE_MAX_BYTES).toString('utf8');
    } catch {
      return null; // gone since the scan
    }
  }

  /** The look the layout names for each region, when its mod's looks may apply and it has that look for that region, scoped to the region. */
  function activeLooks(): { target: ModLookTarget; ref: string; mod: string; css: string }[] {
    const chosen = app.config().mods.layout.looks ?? noLooks();
    const out: { target: ModLookTarget; ref: string; mod: string; css: string }[] = [];
    for (const target of MOD_LOOK_TARGETS) {
      const ref = chosen[target];
      const at = ref ? splitRef(ref) : null;
      const m = at ? registry.get(at.key) : undefined;
      const look = m?.approved ? m.manifest?.contributes?.looks?.find((l) => l.id === at!.id && l.target === target) : undefined;
      if (!m || !look || !ref) continue;
      const parts: string[] = [];
      for (const rel of look.styles) {
        const css = readStyle(m, rel);
        if (css !== null) parts.push(`/* ${m.id}/${rel} */\n${scopeCss(css, LOOK_ROOTS[target], { url: modUrlRewriter(m.origin, rel), prefix: m.id })}`);
      }
      out.push({ target, ref, mod: m.key, css: parts.join('\n') });
    }
    return out;
  }

  // ---------- Hooks: mods with the hooks permission handle the events their manifest lists ----------

  const pendingHooks = new Map<string, (reply: ModHookReply) => void>();
  /** The on mods that handle hooks, in list order */
  const hookMods = (): ModHookSet[] =>
    registry
      .list()
      .filter((m) => m.state === 'on' && m.granted.includes('hooks') && m.manifest?.contributes?.hooks?.length)
      .map((m) => ({ key: m.key, name: m.manifest?.name ?? m.id, events: m.manifest!.contributes!.hooks!.map((h) => ({ event: h.event, timeoutMs: h.timeout ? h.timeout * 1000 : MOD_HOOK_TIMEOUT_MS })) }));
  /** Asks the window to hand the hook to the mod's views; a view that does not answer in time is skipped. */
  const runModHook = (mod: string, event: ModHookSet['events'][number]['event'], input: Record<string, unknown>, timeoutMs: number): Promise<ModHookReply> =>
    new Promise((resolve) => {
      if (!app.window()) return resolve({ skipped: 'the window is not open, so its views are not loaded' });
      const id = randomUUID();
      const timer = setTimeout(() => {
        pendingHooks.delete(id);
        resolve({ skipped: `did not answer within ${Math.round(timeoutMs / 100) / 10} s` });
      }, timeoutMs);
      pendingHooks.set(id, (reply) => {
        clearTimeout(timer);
        pendingHooks.delete(id);
        resolve(reply);
      });
      app.push('mods:hook', { id, mod, event, input, timeoutMs });
    });
  const engine = app.service<HookEngine>('hooks');
  if (engine) disposers.push(engine.attachMods(hookMods, runModHook));
  disposers.push(
    h('mods.hookResult', (id, reply) => {
      const done = pendingHooks.get(String(id));
      if (!done) return;
      const r = isObj(reply) ? reply : {};
      done({ result: r.result, ...(typeof r.error === 'string' ? { error: r.error.slice(0, REPORT_MAX_CHARS) } : {}), ...(typeof r.skipped === 'string' ? { skipped: r.skipped.slice(0, 300) } : {}) });
    }),
    () => {
      for (const done of [...pendingHooks.values()]) done({ skipped: 'the mods were closed' });
    },
  );

  // ---------- For the agent ----------

  disposers.push(app.tools.register({ ...modCheckTool(registry, () => app.config().mods.layout), optional: true, group: 'mods' }));
  disposers.push(app.prompt.add('mods', () => modsPrompt(registry.list()), { optional: true, group: 'mods' }));
  disposers.push(app.provide('skill-usage', usage));
  disposers.push(app.events.on((sessionId, ev) => usage.handle(sessionId, ev)));

  ctl = {
    registry,
    storage,
    usage,
    bridge,
    commands,
    serve,
    emit,
    close() {
      registry.close();
      bridge.cancelAll();
      commands.dispose();
      storage.flush();
      usage.flush();
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch {
          /* already gone */
        }
      }
    },
  };
  registry.scan();
  migrateLooks();
  commands.sync(registry.list());
  registry.watch();
  app.onQuit(() => ctl?.close());
  return ctl;

  /**
   * A profile from before 0.10 (no `approved` yet): looks had switches then. It keeps what it showed: the background
   * and looks chosen stay in use when their mod was on (a choice whose mod was off showed nothing, so it goes), and a
   * look mod of yours that was on counts as approved.
   */
  function migrateLooks(): void {
    const cur = app.config().mods;
    if (cur.approved !== undefined) return;
    const list = registry.list();
    const wasOn = (m: ModInfo): boolean => {
      const man = m.manifest;
      if (!man) return false;
      const restyles = !!man.contributes?.looks?.length;
      if (m.scope === 'bundled') return restyles ? !!cur.enabled?.[m.key] : !(cur.disabledBundled ?? []).includes(m.id);
      const g = cur.enabled?.[m.key];
      return !!g && Array.isArray(g.permissions) && (man.permissions ?? []).every((p) => g.permissions.includes(p)) && (!needsStylesApproval(man) || !!g.styles);
    };
    // A choice of a mod this folder does not list (another project's) is kept as it was
    const showed = (ref: string | null): boolean => {
      const at = ref ? splitRef(ref) : null;
      const m = at ? list.find((x) => x.key === at.key) : undefined;
      return !m || wasOn(m);
    };
    change((c) => {
      for (const m of list) {
        if (!m.manifest || !hasLookParts(m.manifest)) continue;
        const g = cur.enabled?.[m.key];
        if (m.scope !== 'bundled' && g && wasOn(m)) c.approved![m.key] = { permissions: [...g.permissions], at: Number(g.at) || Date.now() };
        if (!hasFeatureParts(m.manifest)) {
          delete c.enabled[m.key];
          if (m.scope === 'bundled') c.disabledBundled = c.disabledBundled.filter((id) => id !== m.id);
        }
      }
      for (const t of MOD_LOOK_TARGETS) if (c.layout.looks[t] && !showed(c.layout.looks[t])) c.layout.looks[t] = null;
      if (c.layout.background && !showed(c.layout.background)) c.layout.background = null;
    });
    registry.recompute();
  }
}

/** Validates a layout patch from the window (unknown fields are dropped). */
export function checkLayout(patch: unknown, backgroundsDir: string): Partial<ModLayout> {
  if (!isObj(patch)) throw new Error('The layout change must be an object.');
  const out: Partial<ModLayout> = {};
  if ('railOpen' in patch) out.railOpen = !!patch.railOpen;
  if ('railWidth' in patch) {
    const w = Number(patch.railWidth);
    if (!Number.isFinite(w)) throw new Error('railWidth must be a number.');
    out.railWidth = Math.round(Math.min(480, Math.max(240, w)));
  }
  if ('collapsed' in patch) {
    if (!Array.isArray(patch.collapsed) || patch.collapsed.some((c) => typeof c !== 'string')) throw new Error('collapsed must be a list of "<mod key>/<view id>".');
    out.collapsed = [...new Set(patch.collapsed as string[])].slice(0, 500);
  }
  if ('closedTabs' in patch) {
    if (!Array.isArray(patch.closedTabs) || patch.closedTabs.some((c) => typeof c !== 'string')) throw new Error('closedTabs must be a list of "<mod key>/<view id>".');
    out.closedTabs = [...new Set(patch.closedTabs as string[])].slice(0, 500);
  }
  if ('background' in patch) {
    if (patch.background !== null && typeof patch.background !== 'string') throw new Error('background must be "<mod key>/<view id>" or null.');
    out.background = patch.background as string | null;
  }
  if ('backgroundImage' in patch) {
    const p = patch.backgroundImage;
    // Only a picture chooseBackgroundImage copied in (the window cannot point the app at an arbitrary file).
    if (p !== null && (typeof p !== 'string' || path.dirname(path.resolve(p)) !== path.resolve(backgroundsDir) || !fs.existsSync(p))) throw new Error('backgroundImage must be null or a picture chosen with chooseBackgroundImage.');
    out.backgroundImage = p as string | null;
  }
  if ('looks' in patch) {
    const l = patch.looks;
    if (!isObj(l)) throw new Error('looks must be an object, e.g. { "conversation": "<mod key>/<look id>" }.');
    const looks: Partial<Record<ModLookTarget, string | null>> = {};
    for (const [target, ref] of Object.entries(l)) {
      // A region this app does not know is ignored, like an unknown field.
      if (!(MOD_LOOK_TARGETS as readonly string[]).includes(target)) continue;
      if (ref !== null && (typeof ref !== 'string' || !splitRef(ref))) throw new Error(`looks.${target} must be "<mod key>/<look id>" or null.`);
      looks[target as ModLookTarget] = ref as string | null;
    }
    out.looks = looks as Record<ModLookTarget, string | null>;
  }
  if ('backgroundDim' in patch) {
    const d = Number(patch.backgroundDim);
    if (!Number.isFinite(d)) throw new Error('backgroundDim must be a number from 0 to 1.');
    out.backgroundDim = Math.min(1, Math.max(0, d));
  }
  return out;
}

/** Serves mod:// from `ctx` (registered with protocol.handle). Exported for the live test. */
export async function serveModRequest(req: Request, ctx: ServeContext): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });
  const r = resolveModUrl(req.url, ctx);
  if (r.status !== 200 || !r.file) return new Response('Not found', { status: r.status, headers: r.headers });
  try {
    const body = req.method === 'HEAD' ? null : await fs.promises.readFile(r.file);
    return new Response(body, { status: 200, headers: r.headers });
  } catch {
    return new Response('Not found', { status: 404, headers: r.headers });
  }
}

/** Called once by the core after Electron is ready. */
export function setupMods(app: App): ModsController {
  const ctl = createMods(app);
  protocol.handle(MOD_SCHEME, (req) => serveModRequest(req, ctl.serve));
  const unlock = installModLockdown({
    windows: () => [app.window()],
    networkAllowed: (label) => !!ctl.serve.lookup(label)?.network,
  });
  app.onQuit(() => {
    unlock();
    protocol.unhandle(MOD_SCHEME);
  });
  return ctl;
}
