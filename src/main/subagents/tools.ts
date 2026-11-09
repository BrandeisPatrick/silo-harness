// The model's side: start sub-sessions, message other sessions, find, list and read them, merge a finished one, and
// rename this session.

import type { Tool, ToolContext, ToolResult } from '../tools/types';
import { SubagentError, type Subagents } from './service';

async function guarded(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SubagentError) return { content: `Error: ${err.message}` };
    throw err;
  }
}

export function subagentTools(svc: Subagents): Tool[] {
  const spawn: Tool = {
    name: 'session_spawn',
    description:
      'Start a sub-session: a separate agent session in the same folder that works on a piece of the job in the background, side by side with this one, and shows under this session in the sidebar. Returns at once; the sub-session reports here by itself each time it finishes a turn, so do not wait or poll. ' +
      'The sub-session knows nothing of this conversation: `prompt` is its whole brief. Make it self-contained: the goal, the files or area to work on, what done looks like, and what to report back. ' +
      'Use it for independent pieces of work that can run in parallel, or a side investigation that should not fill this conversation. Limits: at most 4 running and 12 in all per session; a sub-session of a sub-session cannot start more.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the sidebar, a few words' },
        prompt: { type: 'string', description: 'The complete, self-contained brief for the sub-session' },
      },
      required: ['title', 'prompt'],
    },
    run: (args: { title?: unknown; prompt?: unknown }, ctx: ToolContext) =>
      guarded(async () => {
        const title = String(args?.title ?? '').trim();
        const prompt = String(args?.prompt ?? '').trim();
        if (!title) throw new SubagentError('give the sub-session a title.');
        if (!prompt) throw new SubagentError('give the sub-session a prompt: its whole, self-contained brief.');
        // Check the limits first, so the user is never asked about a sub-session that cannot start
        svc.checkSpawn(ctx.sessionId);
        const ok = await ctx.approve('session_spawn', `Start sub-session "${title}"\n\n${prompt}`, undefined, { custom: true });
        if (!ok.ok) return { content: `Not started: ${ok.message}` };
        const meta = svc.spawn(ctx.sessionId, { title, prompt });
        return { content: `Started sub-session "${meta.title}" (id ${meta.id}). It runs in the background and will report here when it finishes a turn; carry on with other work meanwhile.` };
      }),
  };

  const send: Tool = {
    name: 'session_send',
    description:
      'Send a message to another session, named by its id or its name (written loosely: case, quotes, punctuation, the start of the name or a small typo are fine). It starts a turn there, or waits behind the turn in progress (or, while its plan waits for the user, until the plan is decided). The receiver sees it as a request from you, not from the user. ' +
      'Use it to answer or steer one of your sub-sessions, to tell your parent session something it needs before you finish, or to ask another session for something. Messages to your parent and your own sub-sessions go without asking; a message to any other session needs the user\'s approval. ' +
      'The reply does not come back by itself (a sub-session\'s report does): read it later with session_read.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The session id, or its name' },
        message: { type: 'string', description: 'What to say; the receiving session sees who sent it' },
      },
      required: ['to', 'message'],
    },
    run: (args: { to?: unknown; message?: unknown }, ctx: ToolContext) =>
      guarded(async () => {
        const target = svc.resolve(String(args?.to ?? ''), { from: ctx.sessionId });
        const message = String(args?.message ?? '').trim();
        if (!message) throw new SubagentError('the message is empty.');
        if (target.id === ctx.sessionId) throw new SubagentError('that is this session.');
        const rule = svc.messageRule(ctx.sessionId, target);
        if (rule.kind === 'refuse') return { content: `Not sent: ${rule.message}` };
        if (rule.kind === 'ask') {
          // Words put into a conversation this model was never part of: the user decides, once or for this target
          const ok = await ctx.approve('session_send', `Send to session "${target.title}" (${target.id}):\n\n${message}`, undefined, {
            custom: true,
            sessionKey: `session_send:${target.id}`,
            sessionLabel: `Allow messages to "${target.title}" for this session`,
          });
          if (!ok.ok) return { content: `Not sent: ${ok.message}` };
        }
        const r = svc.message(ctx.sessionId, target.id, message);
        if (!r.ok) return { content: `Error: ${r.error ?? 'the message could not be delivered.'}` };
        const how = r.held
          ? 'its plan waits for the user, so the message is held until the user decides the plan'
          : r.queued
            ? 'it is busy, so the message waits behind its current step'
            : 'it started a run on it';
        const reply = svc.isChild(ctx.sessionId, target)
          ? 'It is your sub-session, so its report comes back here by itself when it finishes the turn.'
          : `Its reply does not come back by itself: read it later with session_read ${target.id} or session_list, or it may answer with session_send.`;
        return { content: `Delivered to "${target.title}" (${target.id}): ${how}. ${reply}` };
      }),
  };

  const list: Tool = {
    name: 'session_list',
    description:
      'List sessions: id, name, relation, state (running, waiting for the user, idle, merged), folder, last activity and the first line of the last reply. ' +
      'Without a query: the sessions related to this one (parent, sub-sessions, forks), then the most recent others. With a query: the sessions whose id or name matches it, out of every session, best match first; use it to find a session the user names.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'A session name (or part of it, or an id) to search every session for' } } },
    readOnly: true,
    run: (args: { query?: unknown }, ctx: ToolContext) =>
      guarded(() => {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        return { content: query ? svc.searchText(ctx.sessionId, query) : svc.listText(ctx.sessionId) };
      }),
  };

  const read: Tool = {
    name: 'session_read',
    description: 'Read the last messages of another session (a sub-session, a fork, the parent, …) as text; tool results are cut short. This is how you look at what a sub-session did in detail.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The session id, or its name' },
        last: { type: 'number', description: 'How many of its last messages, default 6, at most 30' },
      },
      required: ['id'],
    },
    readOnly: true,
    run: (args: { id?: unknown; last?: unknown }, ctx: ToolContext) =>
      guarded(() => ({ content: svc.readText(svc.resolve(String(args?.id ?? ''), { from: ctx.sessionId }).id, args?.last === undefined ? 6 : Number(args.last)) })),
  };

  const merge: Tool = {
    name: 'session_merge',
    description:
      'Merge a finished sub-session or fork of this session into this one: a summary of what it did (for a fork: since it split off) comes back as the result, and it is marked merged. Merge one before relying on its result. ' +
      'Only the conversation is merged: file changes need no merging, since all sessions work in the same folder (this is not a git merge). Refused while it is running or when it was merged already.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The sub-session or fork, by id or name' } }, required: ['id'] },
    run: (args: { id?: unknown }, ctx: ToolContext) =>
      guarded(async () => {
        const ref = String(args?.id ?? '');
        const related = [...svc.children(ctx.sessionId), ...svc.forks(ctx.sessionId)];
        let id: string;
        try {
          id = svc.resolve(ref, { among: related, from: ctx.sessionId }).id;
        } catch {
          id = svc.resolve(ref, { from: ctx.sessionId }).id; // not related: let the merge say why it is refused
        }
        const r = await svc.mergeFull(ctx.sessionId, id, { viaTool: true });
        if (!r.ok) return { content: `Error: ${r.error}` };
        return { content: r.text ?? '' };
      }),
  };

  const rename: Tool = {
    name: 'session_rename',
    description:
      'Rename this session (only this one), when the user asks to call it something. The name shows in the sidebar and the title bar, generated titles no longer replace it, and other sessions can find this one by it. Needs no approval.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'The new name, a few words' } }, required: ['name'] },
    // Not a change to the project: plan mode offers it too
    readOnly: true,
    run: (args: { name?: unknown }, ctx: ToolContext) =>
      guarded(() => {
        const { session, namesakes } = svc.rename(ctx.sessionId, String(args?.name ?? ''));
        const warn = svc.namesakeWarning(namesakes);
        return { content: `Renamed this session to "${session.title}" (id ${session.id}).${warn ? ` ${warn}` : ' Other sessions can find it by that name.'}` };
      }),
  };

  return [spawn, send, list, read, merge, rename];
}
