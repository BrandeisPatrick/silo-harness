// Messages between sessions, as Claude Code desktop shows them: one quiet line each, never a bubble or a tool row.
//
//   Received message from Deploy fix ›     a message, a sub-session's report or its first brief (origin 'session')
//   Messaged Deploy fix ›                  this session's session_send call
//
// The sender's (or receiver's) name is a link that opens that session. A line opens to the message, rendered as
// Markdown; a sent one also says how it was delivered. A received line is still a user message of the transcript
// (.msg.user with its text and checkpoint), so Copy, Rewind and the matching of live messages to transcript items work
// as they do for a bubble. A sent line is the call's ToolCard (tool-groups.ts places it): it is not a .tool, so it
// never folds into a run of calls, and its approval card attaches to it as to any row.

import type { SessionMeta } from '../shared/types';
import { bus } from './bus.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { unframe } from './origin.js';
import { asArgs, type ToolCard, type ToolResult } from './tools.js';

export interface SessionMessagesDeps {
  /** The transcript the lines live in */
  messages: HTMLElement;
  /** The sessions the window knows (the sidebar's list) */
  sessions(): SessionMeta[];
  /** Brings a session on screen */
  openSession(id: string): void;
  /** transcript.ts addUserRow: puts a user message drawn here into the transcript, with its text and checkpoint */
  addUserRow(el: HTMLElement, text: string, turn?: number): HTMLElement;
}

/** session_send's result: `Delivered to "<title>" (<id>): <how>. <what next>` (src/main/subagents/tools.ts) */
const DELIVERED = /^Delivered to "(.*)" \(([^()\n]+)\)(?::\s*([^\n]*))?/;
/** The approval card's detail: `Send to session "<title>" (<id>):` */
const ASKED = /^Send to session "(.*)" \(([^()\n]+)\):/;

export function createSessionMessages({ messages: messagesEl, sessions, openSession, addUserRow }: SessionMessagesDeps) {
  const metaOf = (id: string | undefined): SessionMeta | undefined => (id ? sessions().find((m) => m.id === id) : undefined);

  /**
   * The name in a line: a link to the session while the window knows it, else plain words (`fallback`: the title the
   * frame or the result gave, or "another session"). Names are kept current as the session list changes.
   */
  function nameEl(id: string | undefined, fallback: string): HTMLElement {
    const el = document.createElement('span');
    if (id) el.dataset.session = id;
    el.dataset.fallback = fallback;
    paintName(el);
    return el;
  }

  function paintName(el: HTMLElement): void {
    const meta = metaOf(el.dataset.session);
    const title = meta ? meta.title || 'Untitled session' : el.dataset.fallback || 'another session';
    el.textContent = title;
    if (meta) {
      el.className = 'session-msg-link';
      el.setAttribute('role', 'link');
      el.tabIndex = 0;
      el.title = `Open “${title}”`;
    } else {
      el.className = 'session-msg-name';
      el.removeAttribute('role');
      el.removeAttribute('tabindex');
      el.removeAttribute('title');
    }
  }

  // A renamed session, or one the window learns about only now (a reload renders before the list arrives)
  bus.on('sessions', () => {
    for (const el of messagesEl.querySelectorAll<HTMLElement>('.session-msg [data-fallback]')) paintName(el);
  });

  // The name opens its session; the line around it does not open or shut for that click
  function follow(e: Event): void {
    const link = (e.target as HTMLElement).closest<HTMLElement>('.session-msg-link');
    if (!link || !messagesEl.contains(link)) return;
    e.preventDefault();
    e.stopPropagation();
    const id = link.dataset.session;
    if (id) openSession(id);
  }
  messagesEl.addEventListener('click', follow, true);
  messagesEl.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).classList?.contains('session-msg-link')) follow(e);
  });

  /** A one-line <details>: the words, the chevron after them, and a body that opens under them */
  function lineEl(cls: string): { el: HTMLDetailsElement; words: HTMLElement; body: HTMLElement } {
    const el = document.createElement('details');
    el.className = cls;
    const summary = document.createElement('summary');
    const words = document.createElement('span');
    words.className = 'session-msg-words';
    summary.append(words);
    summary.insertAdjacentHTML('beforeend', `<span class="tool-chevron">${icon('chevron-right')}</span>`);
    const body = document.createElement('div');
    body.className = 'session-msg-body';
    el.append(summary, body);
    return { el, words, body };
  }

  function markdownEl(text: string): HTMLElement {
    const md = document.createElement('div');
    md.className = 'md';
    md.innerHTML = renderMarkdown(text);
    return md;
  }

  /**
   * A message from another session reached this one (a message, a sub-session's report, a sub-session's first brief):
   * "Received message from <sender>", plus what a report said when it was not an ordinary end of a turn.
   */
  function addReceived(raw: string, from?: string, turn?: number): HTMLElement {
    const shown = unframe('session', raw);
    const wrap = document.createElement('div');
    wrap.className = 'session-msg received';
    const { el, words, body } = lineEl('session-msg-line');
    words.append('Received message from ', nameEl(from, shown.sender ?? ''));
    if (shown.note && shown.note !== 'finished a turn') words.append(` · ${shown.note}`);
    body.append(markdownEl(shown.text));
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    if (shown.text) actions.innerHTML = `<button type="button" class="icon-btn sm msg-copy" aria-label="Copy message" data-tip="Copy">${icon('copy', 14)}</button>`;
    wrap.append(el, actions);
    return addUserRow(wrap, shown.text, turn);
  }

  /** session_send's line: "Messaging <to>…", then "Messaged <to>" or "Message to <to> not sent". A ToolCard for tool-groups.ts. */
  function sentCard(rawArgs: unknown): ToolCard {
    const a = asArgs(rawArgs);
    const message = typeof a.message === 'string' ? a.message.trim() : '';
    const given = typeof a.to === 'string' ? a.to.trim() : '';
    // The receiver: an id or a name in the call (the approval card and the result name it exactly)
    const known = metaOf(given) ?? sessions().find((m) => m.title.trim().toLowerCase() === given.toLowerCase());
    let to: { id?: string; title: string } = { id: known?.id, title: known?.title ?? given };
    const { el, words, body } = lineEl('session-msg sent');
    el.dataset.tool = 'session_send';
    let decided: { text: string; ok: boolean } | null = null;

    const paint = (state: 'running' | 'sent' | 'failed', detail = '') => {
      el.dataset.state = state;
      words.textContent = '';
      const name = nameEl(to.id, to.title || 'another session');
      if (state === 'running') words.append('Messaging ', name, '…');
      else if (state === 'sent') words.append('Messaged ', name);
      else words.append('Message to ', name, ' not sent');
      body.textContent = '';
      if (decided) {
        const line = document.createElement('div');
        line.className = `tool-decision ${decided.ok ? 'ok' : 'no'}`;
        line.innerHTML = `${icon(decided.ok ? 'check' : 'x', 14)}<span></span>`;
        line.querySelector('span')!.textContent = decided.text;
        body.append(line);
      }
      if (message) body.append(markdownEl(message));
      if (detail) {
        const note = document.createElement('div');
        note.className = 'session-msg-note';
        note.textContent = detail;
        body.append(note);
      }
    };
    paint('running');

    const card: ToolCard = {
      el,
      name: 'session_send',
      args: a,
      running: true,
      outcome: 'running',
      noteApproval(detail: string) {
        const m = ASKED.exec(String(detail ?? ''));
        if (!m) return;
        to = { id: m[2], title: m[1] };
        if (card.running) paint('running');
      },
      noteDecision(text: string, ok: boolean) {
        decided = { text, ok };
        if (card.running) paint('running');
      },
      finish(res: ToolResult) {
        if (!card.running) return;
        card.running = false;
        const r = String(res.result ?? '').trim();
        const m = DELIVERED.exec(r);
        if (res.ok && m) {
          to = { id: m[2], title: m[1] };
          card.outcome = 'ok';
          // "Delivered: it started a run on it." — the how, without the hints written for the model
          const how = /^[^.]*\.?/.exec(m[3] ?? '')?.[0].trim() ?? '';
          paint('sent', how ? `Delivered: ${how}` : 'Delivered.');
          return;
        }
        const denied = /^Not sent: Not permitted/.test(r);
        card.outcome = denied ? 'denied' : 'failed';
        // A denial the row already says (its card's answer) needs no words written for the model
        const said = denied && decided && !decided.ok && /the user denied/.test(r);
        paint('failed', said ? '' : r.replace(/^(?:Not sent|Error):\s*/, '').replace(/^Not permitted:\s*/, ''));
      },
      interrupt() {
        if (!card.running) return;
        card.running = false;
        card.outcome = 'interrupted';
        paint('failed', 'Interrupted before it was sent.');
      },
    };
    return card;
  }

  return {
    addReceived,
    /** A row of its own for session_send; null for every other tool (tool-groups.ts draws those) */
    ownRow: (name: string, args: unknown): ToolCard | null => (name === 'session_send' ? sentCard(args) : null),
  };
}
