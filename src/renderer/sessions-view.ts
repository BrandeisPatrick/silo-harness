// The sessions as the window knows them: the list and the statuses the sidebar shows, the session on screen (bringing
// one on screen renders its transcript, then what is in flight, then the events that arrived in between), new, delete
// and fork, and the title editing in the top bar.

import type { AgentEvent, LiveState, PlanInfo, QueuedMessage, SessionMeta, SessionStatus, SiloHarnessApi, TranscriptItem } from '../shared/types';
import { bus } from './bus.js';
import { byId } from './dom.js';
import { onPush, rpc } from './rpc.js';

export interface SessionsViewDeps {
  api: SiloHarnessApi['sessions'];
  input: HTMLTextAreaElement;
  running(): boolean;
  /** Renders the transcript of the session brought on screen (renderer.ts composes the cards) */
  renderTranscript(items: TranscriptItem[]): void;
  /** An event of the session on screen, replayed from its LiveState or from the buffer (renderer.ts) */
  handleEvent(ev: AgentEvent): void;
  setRunning(v: boolean, startedAt?: number): void;
  /** Ends the plan status line once the plan was decided elsewhere */
  syncPlanStatus(): void;
  /** The session's newest plan was decided in the main process: its card follows */
  updatePlanCard(plan: PlanInfo): void;
  /** A compaction of the session shown before goes with it */
  dropCompaction(): void;
  /** The queue rows of the session shown before go with it; the shown session's queued messages come back */
  queue: { clear(): QueuedMessage[]; add(m: QueuedMessage): void };
  /** The task list from the session's meta, unless a tasks_updated event came in since `epoch` */
  tasksEpoch(): number;
  showSessionTasks(meta: SessionMeta | null | undefined, epoch: number): void;
  resetChanges(): void;
  refreshContext(): Promise<void>;
  scrollToBottom(force?: boolean): void;
  /** The sidebar's list and the pages in the main column, set up by the feature wiring after this */
  renderList(): void;
  closePage(): void;
  focusComposer(): void;
  systemMessage(text: string, kind?: 'info' | 'error' | 'notice'): void;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
}

export function createSessionsView({ api, input: inputEl, running, renderTranscript, handleEvent, setRunning, syncPlanStatus, updatePlanCard, dropCompaction, queue, tasksEpoch, showSessionTasks, resetChanges, refreshContext, scrollToBottom, renderList, closePage, focusComposer, systemMessage: addSystemMessage, showError, cleanError }: SessionsViewDeps) {
  const sessionTitle = byId('session-title');
  const newSessionBtn = byId<HTMLButtonElement>('new-session-btn');

  /** The session on screen. Other sessions may be running too: their events only update `statuses`. */
  let currentSessionId = '';
  let sessions: SessionMeta[] = [];
  /** Per session: running, waiting for the user, unread (from the session list, kept current by every session's events) */
  const statuses = new Map<string, SessionStatus>();

  /** Set from a switch's transcript until its LiveState is applied: the session's events wait here meanwhile */
  let syncing: { id: string; buffer: AgentEvent[] } | null = null;

  function statusOf(id: string): SessionStatus {
    return statuses.get(id) ?? sessions.find((m) => m.id === id)?.status ?? { running: false };
  }

  /** Keeps the sidebar's status of a session current from its events (the main process's next list push confirms it). */
  function trackStatus(id: string, ev: AgentEvent, onScreen: boolean): void {
    const before = statusOf(id);
    let next: SessionStatus | null = null;
    if (ev.type === 'run_start') next = { running: true, unread: onScreen ? undefined : before.unread };
    else if (ev.type === 'run_end') next = { running: false, attention: ev.reason === 'plan' ? 'plan' : undefined, unread: onScreen ? undefined : true };
    else if (ev.type === 'approval_request') next = { ...before, attention: 'approval' };
    else if (ev.type === 'approval_resolved' && before.attention === 'approval') next = { ...before, attention: undefined };
    else if (ev.type === 'question_request') next = { ...before, attention: before.attention === 'approval' ? 'approval' : 'question' };
    else if (ev.type === 'question_resolved' && before.attention === 'question') next = { ...before, attention: undefined };
    // A message from another session marks a session that is not on screen at once (the main process stores it)
    else if (ev.type === 'user_message' && ev.origin === 'session' && !onScreen && !before.unread) next = { ...before, unread: true };
    if (!next) return;
    statuses.set(id, next);
    renderSessionList();
  }

  // Inline title editing (click or F2; Enter saves, Escape cancels)
  let titleEditing = false;

  function setTitle(text: string): void {
    if (!titleEditing) sessionTitle.textContent = text;
    document.title = text && text !== 'New session' ? `${text} — Silo Harness` : 'Silo Harness';
  }

  async function renameSession(id: string, title: string, anchor: HTMLElement): Promise<boolean> {
    try {
      if (typeof api.rename !== 'function') throw new Error('No handler registered');
      const meta = await api.rename(id, title);
      const i = sessions.findIndex((s) => s.id === id);
      if (i >= 0) sessions[i] = meta;
      if (id === currentSessionId) setTitle(meta.title);
      renderSessionList();
      return true;
    } catch (err) {
      showError(anchor, `Couldn't rename: ${cleanError(err)}`);
      return false;
    }
  }

  function startTitleEdit(): void {
    if (titleEditing || !currentSessionId) return;
    titleEditing = true;
    const original = sessionTitle.textContent ?? '';
    sessionTitle.contentEditable = 'plaintext-only';
    sessionTitle.classList.add('editing');
    sessionTitle.focus();
    const range = document.createRange();
    range.selectNodeContents(sessionTitle);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const finish = async (save: boolean) => {
      if (!titleEditing) return;
      titleEditing = false;
      sessionTitle.removeEventListener('keydown', onKey);
      sessionTitle.removeEventListener('blur', onBlur);
      sessionTitle.contentEditable = 'false';
      sessionTitle.classList.remove('editing');
      sessionTitle.scrollLeft = 0;
      const next = (sessionTitle.textContent ?? '').replace(/\s+/g, ' ').trim();
      sessionTitle.textContent = original;
      if (!save || !next || next === original) return;
      sessionTitle.textContent = next;
      const ok = await renameSession(currentSessionId, next, sessionTitle);
      if (!ok) sessionTitle.textContent = original;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void finish(true);
        focusComposer();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        void finish(false);
        focusComposer();
      }
    };
    const onBlur = () => void finish(true);
    sessionTitle.addEventListener('keydown', onKey);
    sessionTitle.addEventListener('blur', onBlur);
  }
  sessionTitle.addEventListener('click', () => startTitleEdit());
  sessionTitle.addEventListener('keydown', (e) => {
    if (!titleEditing && e.key === 'Enter') {
      e.preventDefault();
      startTitleEdit();
    }
  });

  // ---------- The list and the session on screen ----------

  function renderSessionList(): void {
    renderList();
  }

  /** Re-reads the session list; returns the meta of the session on screen. */
  async function refreshSessions(): Promise<SessionMeta | null> {
    const [list, current] = await Promise.all([api.list(), api.current()]);
    applySessionList(list, current);
    return sessions.find((m) => m.id === currentSessionId) ?? null;
  }

  /**
   * Takes a session list from the main process (a refresh or a 'sessions:changed' push). The session on screen stays
   * the one this window shows (a list that was read before a switch must not switch back); `current` only seeds it at
   * start-up and stands in for it while it has no messages yet (the store lists those only once they have some).
   */
  function applySessionList(list: SessionMeta[], current?: SessionMeta | null): void {
    if (!Array.isArray(list)) return;
    if (!currentSessionId && current) currentSessionId = current.id;
    const mine = list.find((m) => m.id === currentSessionId) ?? (current?.id === currentSessionId ? current : sessions.find((m) => m.id === currentSessionId));
    sessions = mine && !list.some((m) => m.id === mine.id) ? [mine, ...list] : list;
    statuses.clear();
    for (const m of sessions) if (m.status) statuses.set(m.id, { ...m.status });
    // The window knows best whether the session on screen runs (its own events), and it is being read.
    if (currentSessionId) statuses.set(currentSessionId, { ...statusOf(currentSessionId), running: running(), unread: undefined });
    if (mine) {
      setTitle(mine.title);
      applySessionPlan(mine);
    }
    renderSessionList();
    bus.emit('sessions', sessions);
  }

  /** The session's newest plan may have been decided in the main process (e.g. by a build run): update its card. */
  function applySessionPlan(meta: SessionMeta): void {
    if (meta.id !== currentSessionId || !meta.plan?.id) return;
    updatePlanCard(meta.plan);
    syncPlanStatus();
  }

  function onSessionChanged(meta: SessionMeta): void {
    const i = sessions.findIndex((s) => s.id === meta.id);
    if (i >= 0) sessions[i] = { ...sessions[i], ...meta };
    if (meta.id === currentSessionId) setTitle(meta.title);
    renderSessionList();
    applySessionPlan(meta);
    void refreshSessions();
  }

  /** Bumped by every showSession, so the slower of two quick switches gives way */
  let showSeq = 0;

  /**
   * Brings a session on screen, running or not: its transcript, then what is in flight (LiveState: the streaming reply,
   * running tools, waiting approval cards, the queue, the status line), then the events that arrived in between.
   * The main process takes the transcript and the live state at the same moment and sends every later event after its
   * reply, so the result is what a window that had watched from the start would show.
   */
  async function showSession(id: string): Promise<boolean> {
    const my = ++showSeq;
    const epoch = tasksEpoch();
    let items: TranscriptItem[];
    try {
      items = await api.switch(id);
    } catch (err) {
      if (my === showSeq) addSystemMessage(cleanError(err), 'error');
      return false;
    }
    if (my !== showSeq) return false;
    syncing = { id, buffer: [] };
    currentSessionId = id;
    statuses.set(id, { ...statusOf(id), unread: undefined });
    // What belonged to the session shown before: its compaction status and queue rows go with it.
    dropCompaction();
    queue.clear();
    renderTranscript(items);
    let live: LiveState | null = null;
    try {
      live = await rpc('sessions.live', id);
    } catch {
      /* an older main process: the session shows as idle */
    }
    if (my !== showSeq) return false;
    const buffered = syncing?.id === id ? syncing.buffer : [];
    syncing = null;
    applyLive(live);
    for (const ev of buffered) handleEvent(ev);
    showSessionTasks(await refreshSessions(), epoch);
    if (my !== showSeq) return false;
    resetChanges();
    void refreshContext();
    scrollToBottom(true);
    bus.emit('session-shown', id);
    return true;
  }

  /** Shows what is in flight in the session just rendered, through the same paths its events take. */
  function applyLive(live: LiveState | null): void {
    const on = Boolean(live?.running);
    if (on !== running() || on) setRunning(on, live?.startedAt ?? Date.now());
    if (!live || !on) {
      syncPlanStatus();
      return;
    }
    // Queued messages from elsewhere (a schedule, another session) get their bubble when delivered (user_message).
    for (const m of live.queue ?? []) if (!m.origin || m.origin === 'user' || m.origin === 'queue') queue.add(m);
    for (const t of live.tools ?? []) handleEvent({ type: 'tool_start', id: t.id, name: t.name, args: t.args });
    for (const a of live.approvals ?? []) handleEvent(a);
    for (const q of live.questions ?? []) handleEvent(q);
    if (live.thinking) handleEvent({ type: 'thinking_delta', text: live.thinking });
    if (live.text) handleEvent({ type: 'text_delta', text: live.text });
  }

  async function switchSession(id: string): Promise<void> {
    if (id === currentSessionId) return;
    await showSession(id);
  }

  async function newSession(): Promise<void> {
    let meta: SessionMeta;
    try {
      meta = await api.create();
    } catch (err) {
      addSystemMessage(cleanError(err), 'error');
      return;
    }
    await showSession(meta.id);
    focusComposer();
  }
  newSessionBtn.onclick = () => void newSession();

  async function deleteSession(id: string): Promise<void> {
    if (statusOf(id).running) return;
    const meta = id === currentSessionId ? await api.current() : sessions.find((s) => s.id === id);
    if (meta?.messageCount && !window.confirm(`Delete "${meta.title}"? This cannot be undone.`)) return;
    try {
      const wasCurrent = id === currentSessionId;
      const next = await api.delete(id);
      if (wasCurrent) await showSession(next.id);
      else await refreshSessions();
    } catch (err) {
      addSystemMessage(cleanError(err), 'error');
    }
  }

  async function forkSession(id: string): Promise<void> {
    if (statusOf(id).running) return;
    try {
      const source = sessions.find((s) => s.id === id);
      const fork = await api.fork(id);
      await showSession(fork.id);
      addSystemMessage(`Forked "${source?.title ?? 'session'}". The original is unchanged.`, 'notice');
    } catch (err) {
      addSystemMessage(cleanError(err), 'error');
    }
  }

  // The main process keeps the list current for every session (status changes, new and removed sessions).
  onPush('sessions:changed', (list) => applySessionList(list));
  // A notification was clicked: its session comes on screen.
  onPush('sessions:show', (id) => {
    if (typeof id !== 'string' || !id) return;
    if (id !== currentSessionId) void showSession(id);
    // The session is the one behind a page (Scheduled tasks, Dreaming): the chat view comes back
    else closePage();
  });

  return {
    /** The session on screen */
    currentId: () => currentSessionId,
    /** The session list as last read, the session on screen included */
    list: () => sessions,
    statusOf,
    trackStatus,
    /** The window knows best whether the session on screen runs: its own events say so */
    setRunningStatus: (v: boolean) => {
      if (currentSessionId) statuses.set(currentSessionId, { ...statusOf(currentSessionId), running: v });
    },
    /** True (and kept) while a switch to `id` waits for its LiveState: the event is replayed after it */
    buffer: (id: string, ev: AgentEvent) => {
      if (syncing && syncing.id === id) {
        syncing.buffer.push(ev);
        return true;
      }
      return false;
    },
    titleEditing: () => titleEditing,
    setTitle,
    startTitleEdit,
    renameSession,
    refreshSessions,
    onSessionChanged,
    showSession,
    switchSession,
    newSession,
    deleteSession,
    forkSession,
  };
}
