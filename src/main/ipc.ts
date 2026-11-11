// The core IPC channels the window's preload calls (window.oc). Everything acts on the session on screen
// (app.runtime.foregroundId()) unless a call names its session or its approval/queue item; the generic 'rpc' channel
// dispatches to the handlers features register with app.rpc.handle.

import { app as electronApp, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, ApprovalScope, Bounds, BrowserState, ImageAttachment, McpScope, McpServerInfo, ModelCapabilities, ProjectRules, StoredRules } from '../shared/types';
import type { AppHost } from './app';
import { ARTIFACT_SCHEME } from './artifacts';
import type { BrowserController } from './browser';
import { diffOf, listChanges, revertChange } from './changes';
import { searchFiles } from './files';
import { appendInstruction } from './instructions';
import { acceptFromWindow, activeModel, listOllamaModels, modelCapabilities, ollamaOf, resolveProvider, windowConfig } from './providers';
import { settingsLayer } from './settings';
import { contextLimit } from './context-window';
import { rewindSession, toMeta, toTranscript } from './sessions';
import { loadSkills, toInfo } from './skills';
import type { HistoryService } from './services';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 8;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Only well-formed, bounded image attachments reach the model. */
export function validateAttachments(raw: unknown): ImageAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('attachments must be a list');
  if (raw.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message.`);
  return raw.map((a, i) => {
    const x = a as Partial<ImageAttachment>;
    const mime = String(x.mime ?? '');
    const dataUrl = String(x.dataUrl ?? '');
    if (!IMAGE_MIMES.has(mime)) throw new Error(`Attachment ${i + 1}: unsupported image type ${mime || '(none)'}.`);
    if (!dataUrl.startsWith(`data:${mime};base64,`)) throw new Error(`Attachment ${i + 1}: not a ${mime} data URL.`);
    if (dataUrl.length > MAX_IMAGE_BYTES * 1.4) throw new Error(`Attachment ${i + 1} is too large (limit 4 MB).`);
    return {
      id: String(x.id ?? `img-${i + 1}`).slice(0, 64),
      name: String(x.name ?? 'image').slice(0, 200),
      mime,
      dataUrl,
      width: Math.max(0, Math.floor(Number(x.width) || 0)),
      height: Math.max(0, Math.floor(Number(x.height) || 0)),
      size: Math.max(0, Math.floor(Number(x.size) || 0)),
    };
  });
}

export interface CoreIpcDeps {
  /** The tabs of the session in front; `create` makes them when it has none */
  browser: (create?: boolean) => BrowserController | null;
  /** The window's pane: its slot and visibility (for every session's tabs) and the state it shows */
  pane: () => { setBounds(b: Bounds): void; setVisible(v: boolean): void; state(): BrowserState } | null;
}

export function registerCoreIpc(app: AppHost, deps: CoreIpcDeps): void {
  const { runtime, store } = app;
  const capabilityCache = new Map<string, ModelCapabilities>();
  const fg = () => runtime.foregroundId();
  const fgAgent = () => runtime.agentFor(fg());
  const fgSession = () => {
    const s = store.get(fg());
    if (!s) throw new Error('No conversation');
    return s;
  };
  const cfg = () => app.config();
  const reloadMcp = () => void app.mcp?.reload().catch((err: unknown) => console.warn('[mcp] reload failed:', err));

  // The generic channel: features register their methods with app.rpc.handle (see src/shared/rpc.ts).
  ipcMain.handle('rpc', (_e, method: string, ...args: unknown[]) => app.invokeRpc(String(method), args));

  // MCP project servers follow the app's folder (the session on screen), and the context meter follows the model.
  // A background session keeps the servers of whatever folder is on screen: a known limit, see app.mcp.
  app.onConfig((next, prev) => {
    if (next.workingDirectory !== prev.workingDirectory) reloadMcp();
    if (
      next.workingDirectory !== prev.workingDirectory || next.provider !== prev.provider || activeModel(next) !== activeModel(prev) || contextLimit(next) !== contextLimit(prev) || next.autoCompact !== prev.autoCompact
    ) {
      fgAgent().emitContext();
    }
  });

  // The window's copy of the config has its keys masked (windowConfig); acceptFromWindow keeps the real ones.
  const forWindow = (c: AppConfig) => windowConfig(c, settingsLayer.info().owned);
  ipcMain.handle('config:get', () => forWindow(cfg()));
  ipcMain.handle('config:set', (_e, sent: AppConfig) =>
    forWindow(app.updateConfig((current) => {
      const next = acceptFromWindow(current, sent ?? ({} as AppConfig));
      // MCP servers, trust, rules, recents, mods and remote control are changed through their own handlers only: a
      // stale copy sent with the rest of the settings must not undo them (or bring back an approval that was withdrawn).
      const merged = {
        ...current,
        ...next,
        ollama: { ...current.ollama, ...next.ollama },
        portkey: { ...current.portkey, ...next.portkey },
        dreaming: { ...current.dreaming, ...next.dreaming },
        browser: { ...current.browser, ...next.browser },
        webSearch: { ...current.webSearch, ...next.webSearch },
        autoMode: { ...current.autoMode, ...next.autoMode } as AppConfig['autoMode'],
        // Named providers change through the files, the command line and providers.setModel only.
        providers: current.providers,
        mcpServers: current.mcpServers,
        mcpTrusted: current.mcpTrusted,
        mcpTrustedEntries: current.mcpTrustedEntries,
        mcpProjectValues: current.mcpProjectValues,
        allowRules: current.allowRules,
        recentDirs: current.recentDirs,
        settingsTrusted: current.settingsTrusted,
        mods: current.mods,
        remote: current.remote,
      };
      // A caller that only flipped the legacy flag still gets the matching mode.
      if (next.permissionMode === undefined && next.autoApprove !== undefined && next.autoApprove !== current.autoApprove) merged.permissionMode = next.autoApprove ? 'bypass' : 'ask';
      return merged;
    })),
  );
  ipcMain.handle('cwd:choose', async () => {
    const win = app.window();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: cfg().workingDirectory });
    if (res.canceled || !res.filePaths[0]) return null;
    return app.updateConfig({ workingDirectory: res.filePaths[0] }).workingDirectory;
  });
  // The Ollama in use (the block, or a named entry of type ollama), else the block's
  ipcMain.handle('models:list', async () => listOllamaModels(ollamaOf(cfg()).baseURL));
  ipcMain.handle('models:capabilities', async () => {
    const c = cfg();
    const r = resolveProvider(c);
    const key = `${r.name}|${r.baseURL}|${r.model}`;
    const cached = capabilityCache.get(key);
    if (cached) return cached;
    const caps = await modelCapabilities(c);
    if (caps.vision !== null) capabilityCache.set(key, caps);
    return caps;
  });

  ipcMain.handle('chat:send', (_e, text: string, attachments?: unknown) => {
    let images: ImageAttachment[];
    try {
      images = validateAttachments(attachments);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return runtime.send(fg(), String(text ?? ''), images, { origin: 'user' });
  });
  ipcMain.handle('chat:unqueue', (_e, id: string) => runtime.findQueued(String(id))?.unqueue(String(id)) ?? false);
  ipcMain.handle('chat:queue', () => fgAgent().queue());
  ipcMain.handle('chat:abort', () => runtime.stop(fg()));
  ipcMain.handle('chat:compact', (_e, focus?: string) => fgAgent().compactNow(String(focus ?? '').trim() || undefined));
  ipcMain.handle('chat:context', () => fgAgent().contextInfo());

  const requireMcp = () => {
    if (!app.mcp) throw new Error('No MCP manager');
    return app.mcp;
  };
  ipcMain.handle('mcp:list', () => app.mcp?.list() ?? []);
  ipcMain.handle('mcp:add', (_e, name: string, spec: string, scope: McpScope, env?: unknown, headers?: unknown) => {
    const cleanEnv: Record<string, string> = {};
    if (env && typeof env === 'object' && !Array.isArray(env)) for (const [k, v] of Object.entries(env as Record<string, unknown>)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) cleanEnv[k] = String(v);
    // Header names are HTTP tokens; a value with a line break is dropped (it could not be sent as one header)
    const cleanHeaders: Record<string, string> = {};
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) && !/[\r\n]/.test(String(v))) cleanHeaders[k] = String(v);
    return requireMcp().add(String(name ?? ''), String(spec ?? ''), scope === 'project' ? 'project' : 'user', cleanEnv, cleanHeaders);
  });
  ipcMain.handle('mcp:remove', (_e, name: string, scope: McpScope) => requireMcp().remove(String(name), scope === 'project' ? 'project' : 'user'));
  ipcMain.handle('mcp:set-enabled', (_e, name: string, scope: McpScope, enabled: boolean) => requireMcp().setEnabled(String(name), scope === 'project' ? 'project' : 'user', Boolean(enabled)));
  ipcMain.handle('mcp:reconnect', (_e, name: string, scope: McpScope) => requireMcp().reconnect(String(name), scope === 'project' ? 'project' : 'user'));
  // Sign-in waits for the browser: the handler returns at once (status "authorizing") and the list follows by push.
  ipcMain.handle('mcp:sign-in', (_e, name: string, scope: McpScope) => {
    const mcp = requireMcp();
    const done = mcp.signIn(String(name), scope === 'project' ? 'project' : 'user');
    done.catch(() => undefined);
    return Promise.race([done, new Promise<McpServerInfo[]>((r) => setImmediate(() => r(mcp.list())))]);
  });
  ipcMain.handle('mcp:cancel-sign-in', (_e, name: string, scope: McpScope) => requireMcp().cancelSignIn(String(name), scope === 'project' ? 'project' : 'user'));
  ipcMain.handle('mcp:set-tool-enabled', (_e, name: string, scope: McpScope, tool: string, enabled: boolean) => requireMcp().setToolEnabled(String(name), scope === 'project' ? 'project' : 'user', String(tool ?? ''), Boolean(enabled)));
  ipcMain.handle('mcp:log', (_e, name: string, scope: McpScope) => requireMcp().log(String(name), scope === 'project' ? 'project' : 'user'));
  ipcMain.handle('mcp:sign-out', (_e, name: string, scope: McpScope) => requireMcp().signOut(String(name), scope === 'project' ? 'project' : 'user'));

  // ---------- Sessions: switching, creating and deleting no longer wait for runs; a running session is not forked, deleted or rewound ----------

  const refuseRunning = (id: string, what: string) => {
    if (runtime.isRunning(id)) throw new Error(`Stop the run first: a running session cannot be ${what}.`);
  };
  ipcMain.handle('sessions:list', () => runtime.list());
  ipcMain.handle('sessions:current', () => runtime.meta(fg()));
  ipcMain.handle('sessions:create', () => {
    const meta = runtime.create({ foreground: true, cwd: cfg().workingDirectory, origin: 'user' });
    runtime.agentFor(meta.id).emitContext();
    return meta;
  });
  ipcMain.handle('sessions:fork', (_e, id?: string) => {
    const sourceId = id ?? fg();
    refuseRunning(sourceId, 'forked');
    const from = store.get(sourceId);
    const fork = store.fork(sourceId);
    if (from && app.artifacts) {
      app.artifacts.copy(from, fork);
      store.save(fork, false);
    }
    runtime.setForeground(fork.id);
    return runtime.meta(fork.id);
  });
  ipcMain.handle('sessions:switch', (_e, id: string) => {
    const items = app.showSession(String(id));
    runtime.agentFor(String(id)).emitContext();
    return items;
  });
  ipcMain.handle('sessions:rewind', (_e, turn: number) => {
    const s = fgSession();
    refuseRunning(s.id, 'rewound');
    const agent = fgAgent();
    if (agent.compacting) throw new Error('Wait for the compaction to finish, then rewind.');
    const out = rewindSession(s, agent.cwd(), Math.floor(Number(turn)), store);
    store.save(s, false);
    agent.notifyChanges();
    agent.emitContext();
    const meta = toMeta(s);
    app.window()?.webContents.send('agent:event', { type: 'session_changed', session: meta }, s.id);
    return { transcript: toTranscript(s), session: meta, ...out };
  });
  ipcMain.handle('sessions:delete', (_e, id: string) => {
    const target = String(id);
    refuseRunning(target, 'deleted');
    runtime.forget(target);
    store.delete(target);
    app.artifacts?.remove(target);
    if (fg() === target || !store.get(fg())) runtime.create({ foreground: true, cwd: cfg().workingDirectory, origin: 'user' });
    return runtime.meta(fg());
  });
  // Allowed during a run: the store hands out the same Session object the agent holds, so the run's own saves keep the new title.
  ipcMain.handle('sessions:rename', (_e, id: string, title: string) => {
    const s = store.rename(String(id), String(title ?? ''));
    const meta = runtime.meta(s.id);
    app.window()?.webContents.send('agent:event', { type: 'session_changed', session: toMeta(s) }, s.id);
    return meta;
  });

  // The app's folder is the folder of the session on screen, so these read it.
  ipcMain.handle('skills:list', () => loadSkills(cfg().workingDirectory, app.appRoot).map(toInfo));
  ipcMain.handle('files:search', (_e, query: string, limit?: number) => searchFiles(cfg().workingDirectory, String(query ?? ''), Number(limit) || 50));
  ipcMain.handle('instructions:append', (_e, text: string) => {
    const added = appendInstruction(cfg().workingDirectory, String(text ?? ''));
    // In the session's log too, so a dream sees what the user asked to remember (and does not propose it again)
    app.service<HistoryService>('history')?.record(fg(), 'memory', { text: String(text ?? '').replace(/\s+/g, ' ').trim(), file: added.path });
    return added;
  });

  const projectRules = (): ProjectRules => {
    const cwd = cfg().workingDirectory;
    const r: StoredRules = cfg().allowRules?.[cwd] ?? {};
    return { cwd, programs: [...(r.programs ?? [])], reasons: [...(r.reasons ?? [])], edits: r.edits === true, mcp: [...(r.mcp ?? [])] };
  };
  ipcMain.handle('rules:list', () => projectRules());
  ipcMain.handle('rules:remove', (_e, kind: string, value?: string) => {
    app.updateConfig((c) => {
      const cwd = c.workingDirectory;
      const r: StoredRules = { ...(c.allowRules?.[cwd] ?? {}) };
      const v = String(value ?? '');
      if (kind === 'program') r.programs = (r.programs ?? []).filter((p) => p !== v);
      else if (kind === 'reason') r.reasons = (r.reasons ?? []).filter((p) => p !== v);
      else if (kind === 'mcp') r.mcp = (r.mcp ?? []).filter((p) => p !== v);
      else if (kind === 'edits') delete r.edits;
      const rules = { ...(c.allowRules ?? {}) };
      if (!r.programs?.length && !r.reasons?.length && !r.mcp?.length && !r.edits) delete rules[cwd];
      else rules[cwd] = r;
      return { ...c, allowRules: rules };
    });
    return projectRules();
  });
  ipcMain.handle('approval:response', (_e, id: string, ok: boolean, always?: boolean, scope?: ApprovalScope) => {
    runtime.respondApproval(String(id), Boolean(ok), Boolean(always), scope === 'project' ? 'project' : 'session');
    return forWindow(cfg());
  });
  ipcMain.handle('question:response', (_e, id: string, answers: unknown) => runtime.respondQuestion(String(id), answers === null ? null : answers));
  ipcMain.handle('plan:respond', (_e, id: string, decision: string) => {
    // The plan is on screen, so it is normally the foreground session's; look further in case the window lags behind.
    const planId = String(id);
    const owner = store.get(fg())?.plans?.[planId] ? fg() : runtime.list().find((m) => store.get(m.id)?.plans?.[planId])?.id ?? fg();
    runtime.respondPlan(owner, planId, decision as 'build-ask' | 'build-acceptEdits' | 'keep');
  });

  const current = () => {
    const s = fgSession();
    return { session: s, cwd: s.cwd ?? cfg().workingDirectory };
  };
  ipcMain.handle('changes:list', () => {
    const { session, cwd } = current();
    return listChanges(session, cwd);
  });
  ipcMain.handle('changes:diff', (_e, p: string) => {
    const { session, cwd } = current();
    return diffOf(session, cwd, String(p));
  });
  ipcMain.handle('changes:revert', async (_e, p: string) => {
    const { session, cwd } = current();
    const list = await revertChange(session, cwd, String(p));
    app.window()?.webContents.send('agent:event', { type: 'changes_updated', count: list.length }, session.id);
    return list;
  });
  ipcMain.handle('changes:open', async (_e, p: string) => {
    const err = await shell.openPath(String(p));
    if (err) throw new Error(err);
  });

  const artifactOf = (id: string) => {
    if (!app.artifacts) throw new Error('No artifact store');
    const info = app.artifacts.get(fgSession(), String(id));
    if (!info) throw new Error(`No artifact ${id} in this conversation.`);
    return info;
  };
  ipcMain.handle('artifacts:list', () => (app.artifacts ? app.artifacts.list(fgSession()) : []));
  ipcMain.handle('artifacts:content', (_e, id: string) => app.artifacts!.content(fgSession(), String(id)));
  ipcMain.handle('artifacts:open', async (_e, id: string) => {
    const info = artifactOf(id);
    await deps.browser(true)?.navigate(info.url);
  });
  ipcMain.handle('artifacts:save-as', async (_e, id: string) => {
    const info = artifactOf(id);
    const win = app.window();
    if (!win) return null;
    const res = await dialog.showSaveDialog(win, { defaultPath: path.join(electronApp.getPath('downloads'), path.basename(info.path)) });
    if (res.canceled || !res.filePath) return null;
    await fs.promises.copyFile(info.path, res.filePath);
    return res.filePath;
  });
  ipcMain.handle('artifacts:reveal', (_e, id: string) => shell.showItemInFolder(artifactOf(id).path));

  const terminal = app.terminal;
  ipcMain.handle('terminal:list', () => terminal?.list() ?? []);
  ipcMain.handle('terminal:create', (_e, cols: number, rows: number) => {
    if (!terminal) throw new Error('No terminal');
    return terminal.create(Number(cols), Number(rows), false);
  });
  ipcMain.handle('terminal:history', (_e, id: string) => terminal?.history(String(id)) ?? '');
  ipcMain.on('terminal:write', (_e, id: string, data: string) => terminal?.write(String(id), String(data)));
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => terminal?.resize(String(id), Number(cols), Number(rows)));
  ipcMain.handle('terminal:close', (_e, id: string) => terminal?.close(String(id)));

  ipcMain.on('browser:bounds', (_e, b: Bounds) => deps.pane()?.setBounds(b));
  ipcMain.on('browser:visible', (_e, v: boolean) => deps.pane()?.setVisible(Boolean(v)));
  ipcMain.handle('browser:navigate', (_e, url: string) => deps.browser(true)?.navigate(String(url)));
  ipcMain.handle('browser:back', () => deps.browser()?.navigate('back'));
  ipcMain.handle('browser:forward', () => deps.browser()?.navigate('forward'));
  ipcMain.handle('browser:reload', () => deps.browser()?.reload());
  ipcMain.handle('browser:state', () => deps.pane()?.state());
  ipcMain.handle('browser:open-external', async (_e, url?: string) => {
    const target = (typeof url === 'string' && url.trim() ? url.trim() : deps.browser()?.state().url) ?? '';
    if (!target || target === 'about:blank') return;
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      console.warn('[browser] not opening an invalid URL externally:', target);
      return;
    }
    if (parsed.protocol === `${ARTIFACT_SCHEME}:`) {
      // An artifact: open the stored file with the default app (a browser for HTML) instead of the viewer URL.
      const r = app.artifacts?.resolve(parsed.href);
      const file = r?.kind === 'file' ? r.path : app.artifacts ? app.artifacts.get(fgSession(), parsed.pathname.split('/').filter(Boolean)[1] ?? '')?.path : undefined;
      if (file) await shell.openPath(file).catch((err: unknown) => console.warn('[artifact] openPath failed:', err));
      return;
    }
    // A local file is shown in the Finder, never opened: a page-made file: tab plus one click must not run anything
    if (parsed.protocol === 'file:') {
      try {
        shell.showItemInFolder(fileURLToPath(parsed.href));
      } catch (err) {
        console.warn('[browser] cannot show that file:', err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      console.warn('[browser] only http and https URLs open externally, not', parsed.protocol);
      return;
    }
    await shell.openExternal(parsed.href).catch((err: unknown) => console.warn('[browser] openExternal failed:', err));
  });
}
