// Approval card, as Claude Code draws it: the question as the title in a header band; what the call does (its own
// description) and why it stopped to ask in muted text; the command or the change; Deny and "Allow once ⌘↵" on the
// right, with ⌄ for the wider scopes. ⌘↵ allows once, Esc denies, A and P pick the scopes. Once decided the card goes
// and the call's own row says what was decided (a call without a row keeps a one-line decided card).

import type { AgentEvent, AppConfig, PermissionMode, QuestionAnswer, SiloHarnessApi } from '../shared/types';
import { lineDiff, numberRows, parseEditPreview, renderDiff } from './diff.js';
import { basename, escapeHtml, isTextField } from './dom.js';
import { highlight } from './highlight.js';
import { icon } from './icons.js';
import { closeMenu, isMenuOpen, menuAnchoredTo, openMenu } from './popover.js';
import { createQuestionCard } from './questions.js';
import { agentApproval } from './tool-labels.js';
import { approvalTitle, displayPath, editStartLine, fileLines, linkPath, mcpParts, type ToolCard } from './tools.js';

export interface ApprovalsDeps {
  input: HTMLTextAreaElement;
  api: Pick<SiloHarnessApi, 'respondApproval' | 'respondQuestion' | 'getConfig'>;
  /** Where an answer's mode switch is kept (the window's config) */
  setConfig(next: AppConfig): void;
  running(): boolean;
  currentMode(): PermissionMode;
  /** The row of the call the card belongs to, when it is still running */
  lastCard(): ToolCard | null;
  addNode(el: HTMLElement): void;
  endAssistant(): void;
  finishThinking(): void;
  scrollToBottom(force?: boolean): void;
  /** The run of calls around a row settles again once the card is decided (tool-groups.ts) */
  settleRun(anchor: Element): void;
  setStatusText(text: string): void;
  /** "Working…", or "Planning…" in plan mode */
  baseVerb(): string;
  applyConfigToUi(): void;
  announceMode(before: PermissionMode): void;
  /** A project rule was saved: Settings → Permissions shows it */
  refreshRules(): Promise<unknown>;
  dialogOpen(): boolean;
  /** Nothing typed and nothing attached: plain keys go to the card */
  composerEmpty(): boolean;
  systemMessage(text: string, kind: 'error'): void;
  cleanError(err: unknown): string;
}

export function createApprovals({ input: inputEl, api, setConfig, running, currentMode, lastCard, addNode, endAssistant, finishThinking, scrollToBottom, settleRun, setStatusText, baseVerb, applyConfigToUi, announceMode, refreshRules, dialogOpen, composerEmpty, systemMessage, cleanError }: ApprovalsDeps) {
  /** The approval card waiting for an answer, if any */
  let pendingApproval: {
    id: string;
    el: HTMLElement;
    name: string;
    cancel: (reason: string) => void;
    allow: () => void;
    resolved: (ok: boolean, scope: 'once' | 'session' | 'project') => void;
    dispose: () => void;
  } | null = null;
  /** The ask_user card waiting for an answer, if any */
  let pendingQuestion: { id: string; el: HTMLElement; cancel: () => void; dispose: () => void } | null = null;
  let promptSeq = 0;

  /**
   * Why a card asks although the mode would have run it: "Auto mode stopped to ask: it pushes to a remote." A card
   * without wider scopes (a tool's own question, a PreToolUse hook's "ask") says its reason as it was written.
   */
  function stopNote(mode: PermissionMode, reason: string, custom = false): string {
    if (custom) return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? '' : '.'}`;
    const why = reason === 'destructive MCP tool' ? 'it can change or delete data' : /^[a-z-]+s\b/.test(reason) ? `it ${reason}` : reason;
    return `${mode === 'auto' ? 'Auto mode stopped to ask' : 'Flagged as risky'}: ${why}.`;
  }

  /** The words a call's row shows for an approval's answer */
  function decisionWords(ok: boolean, kind: 'once' | 'session' | 'project', alwaysLabel: string, projectLabel: string): string {
    if (!ok) return 'Denied';
    if (kind === 'session') return alwaysLabel.replace(/^Allow\b/, 'Allowed');
    if (kind === 'project') return projectLabel.replace(/^Always allow\b/, 'Always allowed');
    return 'Allowed once';
  }

  function addApprovalCard(ev: Extract<AgentEvent, { type: 'approval_request' }>, synthetic = false): void {
    endAssistant();
    finishThinking();
    pendingApproval?.cancel('Superseded');
    const lastToolCard = lastCard();
    const card = lastToolCard && lastToolCard.running && lastToolCard.name === ev.name ? lastToolCard : null;
    const el = document.createElement('div');
    const reason = typeof ev.reason === 'string' ? ev.reason.trim() : '';
    el.className = 'approval prompt-card' + (reason ? ' flagged' : '');
    const uid = `prompt-${++promptSeq}`;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-labelledby', `${uid}-title`);
    const mcp = mcpParts(ev.name);
    // A tool's own question (sub-sessions, messages, schedules): its wording comes from the detail the main process sent
    const agent = mcp ? null : agentApproval(ev.name, ev.detail);
    if (agent) card?.noteApproval(ev.detail);
    if (mcp) el.classList.add('mcp');
    el.innerHTML = `<div class="prompt-head"><div class="title" id="${uid}-title">${escapeHtml(approvalTitle(ev.name, ev.detail, card?.args))}</div></div>`;
    const body = document.createElement('div');
    body.className = 'approval-body prompt-body';
    body.id = `${uid}-body`;
    // What the call does in its own words (a command's description), then why it asks when the mode would not have
    const said = typeof card?.args.description === 'string' ? card.args.description.replace(/\s+/g, ' ').trim() : '';
    if (said) body.insertAdjacentHTML('beforeend', `<p class="prompt-text">${escapeHtml(said)}</p>`);
    const custom = typeof ev.alwaysLabel === 'string' && !ev.alwaysLabel.trim() && typeof ev.projectLabel === 'string' && !ev.projectLabel.trim();
    if (reason) body.insertAdjacentHTML('beforeend', `<p class="prompt-text prompt-note">${escapeHtml(stopNote(ev.mode, reason, custom))}</p>`);
    if (said || reason) el.setAttribute('aria-describedby', body.id);
    let subject = ev.name;
    /** The decided line (a call without a row) names the action in words rather than a tool name or a path */
    let prose = false;
    if (agent) {
      subject = agent.subject;
      prose = true;
      const pre = document.createElement('pre');
      pre.className = 'args prose';
      pre.textContent = ev.detail;
      body.appendChild(pre);
    } else if (mcp) {
      // The arguments, pretty-printed by the main process, in the same mono block as a command.
      subject = `${mcp.tool} · ${mcp.server}`;
      const json = typeof ev.detail === 'string' ? ev.detail.trim() : '';
      body.insertAdjacentHTML('beforeend', json && json !== '{}' ? `<div class="cmd json"><code>${highlight(json, 'json')}</code></div>` : '<div class="tool-note">No arguments</div>');
    } else if (ev.name === 'bash' || ev.name === 'terminal_run') {
      subject = ev.detail.split('\n')[0];
      body.insertAdjacentHTML('beforeend', `<div class="cmd"><span class="cmd-prompt">$</span><code>${highlight(ev.detail, 'sh')}</code></div>`);
    } else if (ev.name === 'edit_file' && parseEditPreview(ev.detail)) {
      const p = parseEditPreview(ev.detail)!;
      subject = basename(p.path);
      let rows = lineDiff(p.oldText, p.newText);
      const at = editStartLine(p.path, p.oldText);
      if (at !== undefined) rows = numberRows(rows, at);
      const diff = renderDiff(displayPath(p.path), rows);
      // The file's path opens it in the editor, as in the tool rows
      linkPath(diff.querySelector<HTMLElement>('.diff-head .path'), p.path);
      body.appendChild(diff);
    } else if (ev.name === 'write_file' && card && typeof card.args.content === 'string') {
      const path = typeof card.args.path === 'string' ? card.args.path : ev.detail.split('\n')[0];
      subject = basename(path);
      const file = ev.detail.split('\n')[0] || path;
      const diff = renderDiff(displayPath(file), numberRows(fileLines(card.args.content).map((t) => ({ kind: 'add' as const, text: t })), 1));
      linkPath(diff.querySelector<HTMLElement>('.diff-head .path'), file);
      body.appendChild(diff);
    } else {
      if (ev.name === 'write_file') subject = basename(ev.detail.split('\n')[0]);
      const pre = document.createElement('pre');
      pre.className = 'args';
      pre.textContent = ev.name === 'write_file' || ev.name === 'edit_file' ? ev.detail.replace(/^[^\n]+/, (line) => displayPath(line)) : ev.detail;
      body.appendChild(pre);
    }

    // An empty label (a tool's own question) means the card has no such answer: only Allow once and Deny.
    const noAlways = typeof ev.alwaysLabel === 'string' && !ev.alwaysLabel.trim();
    const noProject = typeof ev.projectLabel === 'string' && !ev.projectLabel.trim();
    const alwaysLabel = typeof ev.alwaysLabel === 'string' && ev.alwaysLabel.trim() ? ev.alwaysLabel.trim() : 'Allow for this session';
    const projectLabel = typeof ev.projectLabel === 'string' && ev.projectLabel.trim() ? ev.projectLabel.trim() : 'Always allow in this project';
    /** once: this action only; session: "allow … for this session"; project: saved for the working directory */
    type Answer = 'once' | 'session' | 'project';
    const scopes: { label: string; key: string; kind: Answer }[] = [];
    if (!noAlways) scopes.push({ label: alwaysLabel, key: 'A', kind: 'session' });
    if (!noProject) scopes.push({ label: projectLabel, key: 'P', kind: 'project' });

    const foot = document.createElement('div');
    foot.className = 'row prompt-foot';
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'btn deny';
    deny.textContent = 'Deny';
    deny.setAttribute('aria-keyshortcuts', 'Escape');
    const allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'btn primary allow';
    allow.innerHTML = '<span>Allow once</span><span class="keys" aria-hidden="true"><kbd>⌘</kbd><kbd>↵</kbd></span>';
    allow.setAttribute('aria-label', 'Allow once');
    allow.setAttribute('aria-keyshortcuts', 'Meta+Enter');
    const split = document.createElement('div');
    split.className = 'split-btn';
    split.append(allow);
    let more: HTMLButtonElement | null = null;
    if (scopes.length) {
      more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn primary more';
      more.innerHTML = icon('chevron-down', 14);
      more.setAttribute('aria-label', 'More ways to allow');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      split.append(more);
    }
    const main = document.createElement('div');
    main.className = 'row-main';
    main.append(deny, split);
    foot.append(main);
    el.append(body, foot);

    let settled = false;
    /** The card goes; the call's row keeps the outcome. Without a row the card folds to a decided line instead. */
    const settle = (text: string, ok: boolean, note = true) => {
      document.removeEventListener('keydown', onKey, true);
      if (more && menuAnchoredTo(more)) closeMenu();
      if (pendingApproval?.el === el) pendingApproval = null;
      const row = card && card.el.isConnected ? card : null;
      if (row) {
        if (note) row.noteDecision(text, ok);
        el.remove();
        settleRun(row.el);
        return;
      }
      el.classList.add('done');
      el.removeAttribute('role');
      el.innerHTML = `<div class="decided"><span class="${ok ? 'ok' : 'no'}">${icon(ok ? 'check' : 'x')}</span><span>${escapeHtml(text)}</span>${
        subject ? `<span>·</span>${prose ? `<span class="subject">${escapeHtml(subject)}</span>` : `<code>${escapeHtml(subject)}</code>`}` : ''
      }</div>`;
      // The decided line belongs with the call it answered: it folds into the run with it
      settleRun(el);
    };
    const decide = async (ok: boolean, answer: Answer = 'once') => {
      if (settled) return;
      settled = true;
      const kind: Answer = ok ? answer : 'once';
      settle(decisionWords(ok, kind, alwaysLabel, projectLabel), ok);
      if (running()) setStatusText(baseVerb());
      if (synthetic) return;
      const before = currentMode();
      try {
        const next = kind === 'project' ? await api.respondApproval(ev.id, true, true, 'project') : await api.respondApproval(ev.id, ok, kind === 'session');
        if (next && typeof next === 'object' && 'permissionMode' in next) setConfig(next);
        else if (kind !== 'once') setConfig(await api.getConfig());
      } catch (err) {
        systemMessage(`Couldn't send your answer: ${cleanError(err)}`, 'error');
        return;
      }
      applyConfigToUi();
      announceMode(before);
      // The new rule shows in Settings → Permissions.
      if (kind === 'project') void refreshRules();
    };
    const openScopes = () => {
      if (!more || settled) return;
      if (menuAnchoredTo(more)) return closeMenu();
      openMenu([{ items: scopes.map((sc) => ({ label: sc.label, hint: sc.key, onSelect: () => void decide(true, sc.kind) })) }], {
        anchor: more,
        placement: 'bottom-end',
        className: 'scope-menu',
        minWidth: 240,
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.altKey || settled) return;
      const k = e.key;
      const menu = more !== null && menuAnchoredTo(more);
      if ((dialogOpen() || isMenuOpen()) && !menu) return;
      // ⌘↵ (Ctrl+↵ too) allows once from anywhere, the composer included
      if (k === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void decide(true);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      // Plain keys only where they type nothing: not in a field with text (the empty composer is fine)
      const t = e.target as HTMLElement;
      if (isTextField(t) && !(t === inputEl && composerEmpty())) return;
      let action: (() => void) | null = null;
      if (k === 'Escape' && !menu) action = () => void decide(false);
      else if ((k === 'a' || k === 'A') && !noAlways) action = () => void decide(true, 'session');
      else if ((k === 'p' || k === 'P') && !noProject) action = () => void decide(true, 'project');
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    document.addEventListener('keydown', onKey, true);
    pendingApproval = {
      id: ev.id,
      el,
      name: ev.name,
      cancel: (why: string) => {
        if (settled) return;
        settled = true;
        // The row says it itself (interrupted); only a call without a row keeps the word
        settle(why, false, false);
      },
      allow: () => void decide(true),
      // Answered elsewhere (the phone): the card goes the same way, nothing is sent back
      resolved: (ok: boolean, scope: Answer) => {
        if (settled) return;
        settled = true;
        settle(decisionWords(ok, ok ? scope : 'once', alwaysLabel, projectLabel), ok);
        if (running()) setStatusText(baseVerb());
      },
      // The card left the screen with its session (a switch): it stays unanswered for when the session comes back.
      dispose: () => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        if (pendingApproval?.el === el) pendingApproval = null;
      },
    };
    allow.onclick = () => void decide(true);
    deny.onclick = () => void decide(false);
    if (more) more.onclick = openScopes;
    addNode(el);
    scrollToBottom(true);
  }

  // Question card (ask_user): the approval card's frame around the questions. The run waits for it like an approval:
  // ⌘↵ goes on (Next, then Submit), Esc skips, 1–4 pick an option. Answered, it goes, and the call's row (in Summary
  // the line "Asked a question") holds the answers.
  function addQuestionCard(ev: Extract<AgentEvent, { type: 'question_request' }>, synthetic = false): void {
    const questions = Array.isArray(ev.questions) ? ev.questions.filter((q) => q && typeof q === 'object' && Array.isArray(q.options)) : [];
    if (!questions.length) return;
    endAssistant();
    finishThinking();
    pendingQuestion?.dispose();
    const lastToolCard = lastCard();
    const row = lastToolCard && lastToolCard.running && lastToolCard.name === 'ask_user' ? lastToolCard : null;
    let settled = false;
    const close = () => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      if (pendingQuestion?.el === card.el) pendingQuestion = null;
      const hadFocus = card.el.contains(document.activeElement);
      card.el.remove();
      if (row?.el.isConnected) settleRun(row.el);
      if (running()) setStatusText(baseVerb());
      if (hadFocus && !dialogOpen()) inputEl.focus();
    };
    const send = (answers: QuestionAnswer[] | null) => {
      if (settled) return;
      close();
      if (synthetic) return;
      api.respondQuestion(ev.id, answers).catch((err: unknown) => systemMessage(`Couldn't send your answer: ${cleanError(err)}`, 'error'));
    };
    const card = createQuestionCard({ uid: `prompt-${++promptSeq}`, questions, onSubmit: (a) => send(a), onSkip: () => send(null) });
    const onKey = (e: KeyboardEvent) => {
      if (settled || e.isComposing || e.altKey || dialogOpen() || isMenuOpen()) return;
      // ⌘↵ (Ctrl+↵ too): the next question, or send the answers
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        card.next();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      const t = e.target as HTMLElement;
      const inCard = card.el.contains(t);
      const typing = !inCard && isTextField(t) && !(t === inputEl && composerEmpty());
      if (e.key === 'Escape') {
        // Skips the questions instead of stopping the run (not while the user types elsewhere)
        if (typing) return;
        e.preventDefault();
        e.stopPropagation();
        card.skip();
        return;
      }
      if (inCard || typing) return;
      if (card.key(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    pendingQuestion = {
      id: ev.id,
      el: card.el,
      cancel: close,
      // The card left the screen with its session (a switch): it stays unanswered for when the session comes back.
      dispose: () => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        if (pendingQuestion?.el === card.el) pendingQuestion = null;
      },
    };
    addNode(card.el);
    scrollToBottom(true);
    // The keyboard moves into the card unless the user is typing a message
    const active = document.activeElement;
    if (!synthetic && (active === document.body || active === null || (active === inputEl && composerEmpty()))) card.focus();
  }

  return {
    addApprovalCard,
    addQuestionCard,
    /** The approval card waiting for an answer */
    pending: () => pendingApproval,
    /** A card (approval or question) waits for the user */
    waiting: () => Boolean(pendingApproval || pendingQuestion),
    /** The mode became Bypass: the waiting approval goes through */
    allowPending: () => pendingApproval?.allow(),
    /** Answered here, on the phone, or ended by a stop: the question card goes */
    questionResolved: (id: string) => {
      if (pendingQuestion?.id === id) pendingQuestion.cancel();
    },
    /** Answered on the phone (or ended by a stop): the approval card goes as if it had been answered here */
    approvalResolved: (ev: Extract<AgentEvent, { type: 'approval_resolved' }>) => {
      if (pendingApproval?.id === ev.id) {
        if (ev.interrupted) pendingApproval.cancel('Interrupted');
        else pendingApproval.resolved(ev.ok, ev.scope);
      }
    },
    /** The run ended: the cards still waiting are cancelled */
    interrupt: () => {
      pendingApproval?.cancel('Interrupted');
      pendingQuestion?.cancel();
    },
    /** The transcript is being cleared (a switch): the cards leave the screen but stay unanswered */
    dispose: () => {
      pendingApproval?.dispose();
      pendingQuestion?.dispose();
    },
  };
}
