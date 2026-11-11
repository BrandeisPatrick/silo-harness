// The history service: writes every session's log from the store's mutations and the agent's events, recovers
// sessions after a crash, keeps deleted sessions in the trash, searches every conversation and exports one.
// setupHistory (../history.ts) calls createHistory(app); the tests call it directly with an injected clock and
// export destination.

import { app as electronApp, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, SessionMeta } from '../../shared/types';
import type { HistoryRecord, HistoryStats, SearchHit, TrashEntry } from '../../shared/history';
import type { App, Disposer } from '../app';
import type { HistoryService } from '../services';
import type { Msg, Session, SessionMutation } from '../sessions';
import { pruneTurnTimes } from '../sessions';
import { HistoryLog, safeId } from './log';
import { activeModel } from '../providers';
import { CONVERSATION_TYPES, hasOpenRun, lastSnapshot, missingToolResults, replayConversation } from './replay';
import { DEFAULT_LIMIT, queryWords, SearchIndex } from './search';
import { DAY_MS, sizeOf, Trash } from './trash';
import { sessionMarkdown, type ExportFormat } from './export';

/** The replaceAll reason recovery uses; the log ignores it, since the messages it puts back are already logged. */
export const RECOVERY_REASON = 'recovery';
export const RECOVERED_NOTICE = 'This session was restored after the app closed unexpectedly.';

export interface HistoryOptions {
  /** The clock (records, trash dates, the retention sweep) */
  now?: () => number;
  /** Where an export is written; default: Electron's save dialog. null cancels. */
  chooseExportPath?: (defaultName: string, format: ExportFormat) => string | null | Promise<string | null>;
  /** How often the trash is swept while the app runs (default once a day) */
  sweepEveryMs?: number;
  /** Delay before the "restored" notice is sent after a session is brought on screen (default 60 ms) */
  noticeDelayMs?: number;
}

export interface History extends HistoryService {
  readonly log: HistoryLog;
  readonly trash: Trash;
  readonly index: SearchIndex;
  /** Sessions recovered at start-up whose notice has not been shown yet */
  recovered(): string[];
  /** Runs crash recovery over every log (done once at start-up); returns the ids it changed */
  recover(): string[];
  exportSession(sessionId: string, format: ExportFormat): Promise<string | null>;
  trashList(): TrashEntry[];
  restore(id: string): Session;
  purge(id?: string): TrashEntry[];
  /** Deletes every session the way one is deleted (runs stopped first) and brings a fresh empty one on screen */
  deleteAll(): Promise<{ deleted: number; session: SessionMeta }>;
  /** Removes trash entries older than historyTrashDays; returns their ids */
  sweep(): string[];
  stats(): HistoryStats;
  dispose(): void;
}

type Pending = { t: number; type: string; data: unknown };

export function createHistory(app: App, opts: HistoryOptions = {}): History {
  const now = opts.now ?? Date.now;
  const historyDir = path.join(app.userData, 'history');
  const log = new HistoryLog(historyDir, now);
  const trash = new Trash(path.join(app.userData, 'trash'));
  const index = new SearchIndex();
  const store = app.store;
  const disposers: Disposer[] = [];
  // The core's artifact store when there is one (AppHost); otherwise its default place.
  const artifactsDir = (id: string): string => {
    const host = app as App & { artifacts?: { dirFor(id: string): string } };
    return host.artifacts?.dirFor ? host.artifacts.dirFor(id) : path.join(app.userData, 'artifacts', id);
  };
  const sessionsDir = path.join(app.userData, 'sessions');
  const trashDays = (): number => {
    const d = Number(app.config().historyTrashDays);
    return Number.isFinite(d) ? Math.max(0, d) : 30;
  };

  // ---------- Writing ----------

  /** Records of sessions that have no log yet and no messages (every start makes an empty session; it gets a log only once it is used) */
  const pending = new Map<string, Pending[]>();
  /** run_start waits for the user_message right after it, which carries the origin */
  const pendingRun = new Map<string, number>();
  const thinking = new Map<string, { text: string; started: number }>();

  const hasContent = (id: string) => log.exists(id) || (store.get(id)?.messages.length ?? 0) > 0;

  function write(id: string, type: string, data: unknown, t = now()): void {
    if (!safeId(id)) return;
    const run = pendingRun.get(id);
    if (run !== undefined && type !== 'run.start') {
      pendingRun.delete(id);
      write(id, 'run.start', { origin: 'user' }, run);
    }
    if (!hasContent(id)) {
      // Records of a session the store does not know (deleted, or never existed) are dropped.
      if (!store.get(id)) return;
      const list = pending.get(id) ?? [];
      list.push({ t, type, data });
      pending.set(id, list);
      return;
    }
    try {
      const buffered = pending.get(id);
      if (buffered) {
        pending.delete(id);
        for (const p of buffered) log.append(id, p.type, p.data, p.t);
      }
      log.append(id, type, data, t);
    } catch (err) {
      console.warn(`[history] could not write to the log of ${id}:`, err);
    }
  }

  const createdData = (s: Session, extra: Record<string, unknown> = {}) => {
    const d: Record<string, unknown> = { title: s.title, cwd: s.cwd, origin: s.origin ?? 'user', createdAt: s.createdAt };
    if (s.parentId) d.parentId = s.parentId;
    if (s.forkedFrom) d.forkedFrom = s.forkedFrom;
    if (s.seedLength !== undefined) d.seedLength = s.seedLength;
    return { ...d, ...extra };
  };

  /**
   * A session from before the history log (or whose log was lost) gets a starting point first: a created record and
   * the messages it had before this mutation, so every log can be replayed from nothing.
   */
  function baseline(s: Session, op: SessionMutation): void {
    if (log.exists(s.id) || pending.has(s.id)) return;
    // Also a session made before the history service was set up (the first one, at start-up): its created record.
    let prior: Msg[];
    if (op.kind === 'append') prior = s.messages.slice(0, op.index);
    else if (op.kind === 'truncate') prior = [...s.messages, ...op.removed];
    else if (op.kind === 'replace') prior = op.removed;
    else prior = s.messages;
    write(s.id, 'session.created', prior.length ? createdData(s, { existing: true }) : createdData(s), s.createdAt);
    if (prior.length) write(s.id, 'messages.replace', { reason: 'baseline', messages: prior, removed: 0 });
  }

  function onMutation(s: Session, op: SessionMutation): void {
    switch (op.kind) {
      case 'create':
        write(s.id, 'session.created', createdData(s));
        return;
      case 'fork':
        write(s.id, 'session.created', createdData(s, { forkedFrom: op.from, seedLength: op.seedLength }));
        write(s.id, 'session.forked', { from: op.from, seedLength: op.seedLength });
        // The seed, so the fork's log alone rebuilds its conversation.
        if (s.messages.length) write(s.id, 'messages.replace', { reason: 'fork', messages: s.messages, removed: 0 });
        return;
      case 'delete':
        onDelete(s);
        return;
    }
    baseline(s, op);
    // Images inside user messages stay inline here, as they are in the session file: a known cost, not solved yet.
    if (op.kind === 'append') write(s.id, 'message.append', { index: op.index, message: op.message });
    else if (op.kind === 'truncate') write(s.id, 'messages.truncate', { length: op.length, removed: op.removed.length });
    else if (op.kind === 'replace') write(s.id, 'messages.replace', { reason: op.reason, messages: op.messages, removed: op.removed.length });
    else if (op.kind === 'save') write(s.id, 'snapshot', { messages: op.messages });
    else if (op.kind === 'rename') write(s.id, 'session.renamed', { title: op.title });
  }

  /** Fires before the store removes the session file: move everything into the trash (or remove it with 0 days). */
  function onDelete(s: Session): void {
    const id = s.id;
    pendingRun.delete(id);
    thinking.delete(id);
    const had = log.exists(id) || s.messages.length > 0 || (s.compactions?.length ?? 0) > 0;
    pending.delete(id);
    if (!had) return;
    baseline(s, { kind: 'delete' });
    write(id, 'session.deleted', {});
    log.forget(id);
    try {
      if (trashDays() <= 0) {
        fs.rmSync(log.file(id), { force: true });
        fs.rmSync(artifactsDir(id), { recursive: true, force: true });
        return;
      }
      trash.put(s, { log: log.file(id), artifacts: artifactsDir(id) }, now());
    } catch (err) {
      console.warn(`[history] could not move ${id} to the trash:`, err);
    }
  }

  disposers.push(
    store.onMutation((s, op) => {
      index.drop(s.id);
      if (op.kind === 'replace' && op.reason === RECOVERY_REASON) return;
      try {
        onMutation(s, op);
      } catch (err) {
        console.warn('[history] a mutation could not be recorded:', err);
      }
    }),
  );

  // ---------- The event stream ----------

  function onEvent(id: string, ev: AgentEvent): void {
    switch (ev.type) {
      case 'run_start':
        pendingRun.set(id, now());
        return;
      case 'user_message': {
        const at = pendingRun.get(id);
        if (at === undefined) return;
        pendingRun.delete(id);
        write(id, 'run.start', ev.from ? { origin: ev.origin, from: ev.from } : { origin: ev.origin }, at);
        return;
      }
      case 'run_end':
        write(id, 'run.end', ev.text ? { reason: ev.reason, text: ev.text } : { reason: ev.reason });
        return;
      case 'thinking_delta': {
        const th = thinking.get(id);
        if (th) th.text += ev.text;
        else thinking.set(id, { text: ev.text, started: now() });
        return;
      }
      case 'reply_discarded':
        // A failed model call's thinking is not logged as the reply's
        thinking.delete(id);
        return;
      case 'thinking_done': {
        const th = thinking.get(id);
        thinking.delete(id);
        if (th && th.text) write(id, 'thinking', { text: th.text, ms: now() - th.started });
        return;
      }
      case 'tool_start':
        write(id, 'tool.start', { id: ev.id, name: ev.name, args: ev.args, ...(ev.mcp ? { mcp: ev.mcp } : {}) });
        return;
      case 'tool_end':
        write(id, 'tool.end', { id: ev.id, name: ev.name, ok: ev.ok, durationMs: ev.durationMs, chars: ev.result?.length ?? 0 });
        return;
      case 'usage':
        // The cache counts only when the provider reported them (the token bench reads them from here)
        write(id, 'usage', {
          promptTokens: ev.promptTokens,
          completionTokens: ev.completionTokens,
          ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
          ...(ev.cacheWriteTokens !== undefined ? { cacheWriteTokens: ev.cacheWriteTokens } : {}),
        });
        return;
      case 'approval_request':
        write(id, 'approval.request', ev.reason ? { id: ev.id, name: ev.name, detail: ev.detail, reason: ev.reason } : { id: ev.id, name: ev.name, detail: ev.detail });
        return;
      case 'approval_resolved':
        write(id, 'approval.resolved', { id: ev.id, ok: ev.ok, scope: ev.scope });
        return;
      case 'plan_proposed':
        write(id, 'plan', { id: ev.plan.id, title: ev.plan.title, status: ev.plan.status });
        return;
      case 'artifact':
        write(id, 'artifact', { id: ev.artifact.id, title: ev.artifact.title, kind: ev.artifact.kind, version: ev.artifact.version });
        return;
      case 'image':
        write(id, 'image', { id: ev.image.id, name: ev.image.name });
        return;
      case 'tasks_updated':
        write(id, 'tasks', { tasks: ev.tasks });
        return;
      case 'compact_end':
        if (ev.compaction) {
          const c = ev.compaction;
          write(id, 'compaction', { id: c.id, reason: c.reason, tokensBefore: c.tokensBefore, tokensAfter: c.tokensAfter, summary: c.summary });
        } else if (ev.error) write(id, 'error', { message: `Compaction failed: ${ev.error}` });
        return;
      case 'error':
        write(id, ev.kind === 'notice' ? 'notice' : 'error', { message: ev.message });
        return;
      // Not logged: text_delta, thinking_delta (folded into `thinking`), context, and the events that only mirror
      // what the store's records already hold (user_message, assistant_message, session_changed, queue_*, …).
    }
  }

  disposers.push(
    app.events.on((id, ev) => {
      try {
        onEvent(id, ev);
      } catch (err) {
        console.warn('[history] an event could not be recorded:', err);
      }
    }),
  );

  // ---------- Crash recovery ----------

  const recoveredFile = path.join(historyDir, 'recovered.json');
  const recoveredIds = new Set<string>();
  try {
    for (const id of JSON.parse(fs.readFileSync(recoveredFile, 'utf8')) as string[]) if (safeId(id)) recoveredIds.add(id);
  } catch {
    /* none yet */
  }
  const saveRecovered = () => {
    try {
      if (recoveredIds.size) fs.writeFileSync(recoveredFile, JSON.stringify([...recoveredIds]));
      else fs.rmSync(recoveredFile, { force: true });
    } catch (err) {
      console.warn('[history] could not save the recovered list:', err);
    }
  };

  /** A session object rebuilt from a log whose session file is gone. */
  function rebuildSession(id: string, records: HistoryRecord[]): Session {
    const created = records.find((r) => r.type === 'session.created');
    const d = (created?.data ?? {}) as Record<string, unknown>;
    const renamed = [...records].reverse().find((r) => r.type === 'session.renamed');
    const s: Session = {
      id,
      title: renamed ? String((renamed.data as { title?: unknown }).title ?? 'New session') : typeof d.title === 'string' && d.title ? d.title : 'New session',
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : (created?.t ?? records[0]?.t ?? now()),
      updatedAt: records[records.length - 1]?.t ?? now(),
      messages: [],
    };
    // A title given at creation or by a rename is locked, as the store does; otherwise save() derives one again.
    if (renamed || (typeof d.title === 'string' && d.title && d.title !== 'New session' && !d.existing)) s.titleLocked = true;
    if (typeof d.cwd === 'string') s.cwd = d.cwd;
    if (typeof d.origin === 'string') s.origin = d.origin as Session['origin'];
    if (typeof d.parentId === 'string') s.parentId = d.parentId;
    if (typeof d.forkedFrom === 'string') s.forkedFrom = d.forkedFrom;
    if (typeof d.seedLength === 'number') s.seedLength = d.seedLength;
    return s;
  }

  function recoverOne(id: string): boolean {
    const records = log.read(id);
    if (!records.length) return false;
    let s = store.get(id);
    let changed = false;
    let next: Msg[];
    if (!s) {
      // No session file (never saved, or torn): rebuild it from the log, unless the log ends in a delete.
      const life = [...records].reverse().find((r) => r.type.startsWith('session.'));
      if (life?.type === 'session.deleted') return false;
      next = replayConversation(records).messages;
      if (!next.length) return false;
      s = store.adopt(rebuildSession(id, records));
      changed = true;
    } else {
      // The session file matches the last snapshot; what came after it is replayed onto it.
      const after = records.slice(lastSnapshot(records) + 1).filter((r) => CONVERSATION_TYPES.has(r.type));
      const onFile = replayConversation(after, s.messages);
      next = onFile.messages;
      if (onFile.gap) {
        // The file is behind the log by more than the records after the snapshot: the whole log decides.
        const whole = replayConversation(records);
        if (!whole.gap) next = whole.messages;
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(s.messages)) {
      store.replaceAll(s, next, RECOVERY_REASON);
      changed = true;
    }
    // New messages, so they are logged like any other (the log then still replays to exactly the session).
    const missing = missingToolResults(s.messages);
    for (const m of missing) store.append(s, m);
    const open = hasOpenRun(records);
    if (open) write(id, 'run.end', { reason: 'interrupted' });
    if (!changed && !missing.length && !open) return false;
    if (s.lastPrompt && s.lastPrompt.at > s.messages.length) delete s.lastPrompt;
    if (s.turns) s.turns = s.turns.filter((t) => t.at < s!.messages.length);
    pruneTurnTimes(s);
    store.save(s, false);
    return true;
  }

  function recover(): string[] {
    const out: string[] = [];
    for (const id of log.ids()) {
      try {
        if (recoverOne(id)) out.push(id);
      } catch (err) {
        console.warn(`[history] could not recover ${id}:`, err);
      }
    }
    for (const id of out) recoveredIds.add(id);
    if (out.length) saveRecovered();
    return out;
  }

  // The notice is shown the next time a recovered session comes on screen. It is sent a moment after the switch
  // so it reaches the window after the switch's transcript (the window buffers the session's events until then).
  const noticeDelay = opts.noticeDelayMs ?? 60;
  disposers.push(
    app.runtime.onForeground((id) => {
      if (!recoveredIds.has(id)) return;
      setTimeout(() => {
        const w = app.window();
        if (!w || app.runtime.foregroundId() !== id || !recoveredIds.has(id)) return;
        recoveredIds.delete(id);
        saveRecovered();
        write(id, 'notice', { message: RECOVERED_NOTICE });
        w.webContents.send('agent:event', { type: 'error', kind: 'notice', message: RECOVERED_NOTICE } satisfies AgentEvent, id);
      }, noticeDelay);
    }),
  );

  // ---------- Trash ----------

  const pushList = () => app.push('sessions:changed', app.runtime.list());

  function restore(id: string): Session {
    const key = String(id);
    if (store.get(key)) throw new Error('That session is not deleted.');
    const s = trash.take(key, { log: log.file(key), artifacts: artifactsDir(key) });
    log.forget(key);
    index.drop(`trash:${key}`);
    // The log first, then the store: the store's save adds the snapshot after the restored record.
    log.append(key, 'session.restored', {});
    store.adopt(s);
    pushList();
    return s;
  }

  function sweep(): string[] {
    const gone = trash.sweep(trashDays(), now());
    for (const id of gone) index.drop(`trash:${id}`);
    return gone;
  }

  // ---------- Deleting every session ----------

  /** How long a stopped run is given to end before its session is deleted anyway */
  const STOP_WAIT_MS = 5000;

  /**
   * Every session goes the way one deleted session goes (Settings → History → Delete all sessions): the runtime
   * forgets its agent, the store deletes it (which puts it in the trash, or removes it at once with historyTrashDays
   * 0, through onDelete above) and its artifacts folder goes. Running sessions are stopped first and given a moment
   * to end, since a run's last act is to save its session. Then a fresh empty session is made, brought on screen in
   * the window (sessions:show) and returned. Sessions without messages are deleted too; `deleted` counts the others.
   */
  async function deleteAll(): Promise<{ deleted: number; session: SessionMeta }> {
    const runtime = app.runtime;
    for (const id of runtime.running()) runtime.stop(id);
    const until = Date.now() + STOP_WAIT_MS;
    while (runtime.running().length && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    const host = app as App & { artifacts?: { remove(id: string): void } };
    let deleted = 0;
    let forgotten = false;
    for (const s of store.all()) {
      if (s.messages.length) deleted++;
      runtime.forget(s.id);
      store.delete(s.id);
      host.artifacts?.remove(s.id);
      if (recoveredIds.delete(s.id)) forgotten = true;
    }
    if (forgotten) saveRecovered();
    const fresh = runtime.create({ foreground: true, cwd: app.config().workingDirectory, origin: 'user' });
    app.push('sessions:show', fresh.id);
    return { deleted, session: fresh };
  }

  // ---------- Search ----------

  function search(query: string, o: { limit?: number; includeTrash?: boolean } = {}): SearchHit[] {
    const words = queryWords(query);
    if (!words.length) return [];
    const limit = Math.max(1, Math.floor(Number(o.limit) || DEFAULT_LIMIT));
    const hits: SearchHit[] = [];
    for (const meta of store.list()) {
      const s = store.get(meta.id);
      const hit = s && index.match(s, words);
      if (hit) hits.push(hit);
    }
    if (o.includeTrash) {
      for (const e of trash.list(trashDays())) {
        if (store.get(e.id)) continue;
        const s = trash.session(e.id);
        const hit = s && index.match(s, words, `trash:${e.id}`);
        if (hit) hits.push({ ...hit, trashed: true });
      }
    }
    return hits.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  // ---------- Export, stats ----------

  const defaultChoose = async (name: string, format: ExportFormat): Promise<string | null> => {
    const filters = format === 'markdown' ? [{ name: 'Markdown', extensions: ['md'] }] : format === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'JSON Lines', extensions: ['jsonl'] }];
    const options = { defaultPath: path.join(electronApp.getPath('downloads'), name), filters };
    const w = app.window();
    const r = w ? await dialog.showSaveDialog(w, options) : await dialog.showSaveDialog(options);
    return r.canceled || !r.filePath ? null : r.filePath;
  };
  const choose = opts.chooseExportPath ?? defaultChoose;

  async function exportSession(sessionId: string, format: ExportFormat): Promise<string | null> {
    const id = String(sessionId);
    if (format !== 'markdown' && format !== 'json' && format !== 'jsonl') throw new Error(`Unknown export format ${format}`);
    const live = store.get(id);
    const s = live ?? trash.session(id);
    if (!s) throw new Error(`No conversation ${id}`);
    let content: string;
    if (format === 'markdown') {
      const cfg = app.config();
      const model = activeModel(cfg);
      content = sessionMarkdown(s, { model });
    } else if (format === 'json') content = JSON.stringify(s, null, 2);
    else {
      const file = live ? log.file(id) : path.join(trash.dir, id, 'history.jsonl');
      content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    }
    const base = (s.title || 'session').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'session';
    const dest = await choose(`${base}.${format === 'markdown' ? 'md' : format}`, format);
    if (!dest) return null;
    fs.writeFileSync(dest, content);
    return dest;
  }

  function stats(): HistoryStats {
    const metas = store.list();
    let bytes = sizeOf(historyDir);
    for (const m of metas) bytes += sizeOf(path.join(sessionsDir, `${m.id}.json`)) + sizeOf(artifactsDir(m.id));
    const entries = trash.list(trashDays());
    return { sessions: metas.length, bytes, trash: entries.length, trashBytes: entries.reduce((n, e) => n + e.bytes, 0), dir: historyDir };
  }

  // ---------- Start-up, the service, RPC ----------

  recover();
  sweep();
  const sweepTimer = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      console.warn('[history] the trash sweep failed:', err);
    }
  }, opts.sweepEveryMs ?? DAY_MS);
  sweepTimer.unref?.();

  const service: History = {
    log,
    trash,
    index,
    record: (sessionId, type, data) => write(String(sessionId), String(type), data),
    search,
    read: (sessionId) => log.read(String(sessionId)),
    recovered: () => [...recoveredIds],
    recover,
    exportSession,
    trashList: () => trash.list(trashDays()),
    restore,
    purge: (id) => {
      trash.purge(id);
      if (id === undefined) index.clear();
      else index.drop(`trash:${id}`);
      return trash.list(trashDays());
    },
    deleteAll,
    sweep,
    stats,
    dispose: () => {
      clearInterval(sweepTimer);
      for (const d of disposers.splice(0)) d();
    },
  };

  disposers.push(app.provide('history', service satisfies HistoryService));
  disposers.push(
    app.rpc.handle('history.search', (query, o) => search(String(query ?? ''), o ?? {})),
    app.rpc.handle('history.export', (id, format) => exportSession(id, format)),
    app.rpc.handle('history.trash', () => service.trashList()),
    app.rpc.handle('history.restore', (id) => app.runtime.meta(restore(String(id)).id)),
    app.rpc.handle('history.purge', (id) => service.purge(id === undefined || id === null ? undefined : String(id))),
    app.rpc.handle('history.deleteAll', () => deleteAll()),
    app.rpc.handle('history.stats', () => stats()),
    app.rpc.handle('history.reveal', (id) => {
      const file = id ? log.file(String(id)) : '';
      if (file && fs.existsSync(file)) shell.showItemInFolder(file);
      else void shell.openPath(historyDir);
    }),
  );

  // A quit stops every run first; wait a little for their run.end so a clean quit is never taken for a crash.
  app.onQuit(async () => {
    clearInterval(sweepTimer);
    const until = Date.now() + 2500;
    while (app.runtime.running().length && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  });

  return service;
}
