// The routes under /r/<token>/api/. This is the whole of what the remote can do: read sessions, send a message,
// stop a run, answer an approval card (never with a project rule) or a question card, allow once an action Auto mode
// blocked, decide a plan, start a session. Nothing here touches settings, the permission mode, trust, mods, schedules
// or files.

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App } from '../app';
import type { PermissionMode, SessionMeta } from '../../shared/types';
import { toTranscript } from '../sessions';
import { activeModel } from '../providers';
import { bool, HttpError, json, readJson, str } from './guard';
import { remoteItem, remoteLive } from './sanitize';
import type { AutoBlocksService } from '../services';

export interface RemoteState {
  app: { name: string; version: string };
  sessions: SessionMeta[];
  foreground: string;
  model: string;
  provider: string;
  permissionMode: PermissionMode;
}

const PLAN_DECISIONS = new Set(['build-ask', 'build-acceptEdits', 'keep']);
const MAX_TEXT = 100_000;

/** The app's name and version from its package.json (App has no accessor for them). Read once. */
function appInfo(appRoot: string): { name: string; version: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { productName?: string; name?: string; version?: string };
    return { name: pkg.productName || pkg.name || 'Silo Harness', version: pkg.version || '' };
  } catch {
    return { name: 'Silo Harness', version: '' };
  }
}

export class Api {
  private info: { name: string; version: string } | null = null;

  /**
   * `sessionsMoved` is called after a request that changes the session list (a new session); `mark` flushes the
   * stream's held-back text of a session and returns the last event number (see EventStream.mark).
   */
  constructor(
    private readonly app: App,
    private readonly hooks: { sessionsMoved: () => void; mark: (sessionId: string) => number },
  ) {}

  /** Answers a request whose path (after /api/) is `route`. False when there is no such route. */
  async handle(route: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = req.method ?? 'GET';
    const get = ['state', 'transcript'];
    const post = ['send', 'stop', 'approve', 'answer', 'allow', 'plan', 'new'];
    if (!get.includes(route) && !post.includes(route)) return false;
    const wanted = get.includes(route) ? 'GET' : 'POST';
    if (method !== wanted) {
      json(res, 405, { error: `Use ${wanted}.` });
      return true;
    }
    if (route === 'state') return json(res, 200, this.state()), true;
    if (route === 'transcript') return json(res, 200, this.transcript(url.searchParams.get('session') ?? '')), true;

    const body = await readJson(req);
    const rt = this.app.runtime;
    switch (route) {
      case 'send': {
        const session = this.known(str(body, 'session'));
        const text = str(body, 'text', { max: MAX_TEXT });
        json(res, 200, rt.send(session, text, [], { origin: 'remote' }));
        break;
      }
      case 'stop':
        rt.stop(this.known(str(body, 'session')));
        json(res, 200, { ok: true });
        break;
      case 'approve': {
        const id = str(body, 'id');
        const ok = bool(body, 'ok');
        const always = bool(body, 'always', false);
        // Scope is fixed: the remote can allow once or for the session, never save a rule for the project.
        const found = rt.respondApproval(id, ok, ok && always, 'session');
        json(res, found ? 200 : 404, found ? { ok: true } : { ok: false, error: 'That request was already answered.' });
        break;
      }
      case 'answer': {
        // A question card (ask_user): one answer per question, or null to skip it. The agent keeps only labels it offered.
        const id = str(body, 'id');
        const answers = Array.isArray(body.answers) ? body.answers.slice(0, 4) : null;
        const found = rt.respondQuestion(id, answers);
        json(res, found ? 200 : 404, found ? { ok: true } : { ok: false, error: 'That question was already answered.' });
        break;
      }
      case 'allow': {
        // An action Auto mode blocked: it runs once when the agent tries it again (as the desktop's Allow)
        const session = this.known(str(body, 'session'));
        const r = rt.allowBlocked(session, str(body, 'id'));
        json(res, r.ok ? 200 : 404, r.ok ? { ok: true } : { ok: false, error: r.error ?? 'That block is no longer known.' });
        break;
      }
      case 'plan': {
        const session = this.known(str(body, 'session'));
        const id = str(body, 'id');
        const decision = str(body, 'decision');
        if (!PLAN_DECISIONS.has(decision)) throw new HttpError(400, '"decision" must be build-ask, build-acceptEdits or keep.');
        rt.respondPlan(session, id, decision as 'build-ask' | 'build-acceptEdits' | 'keep');
        json(res, 200, { ok: true });
        break;
      }
      case 'new': {
        // The runtime hands back the new session's meta, status included.
        const meta = rt.create({ foreground: false });
        this.hooks.sessionsMoved();
        json(res, 200, meta);
        break;
      }
    }
    return true;
  }

  state(): RemoteState {
    const cfg = this.app.config();
    this.info ??= appInfo(this.app.appRoot);
    // Only these fields of the config ever leave the Mac: no keys, URLs, folders or rules.
    return {
      app: this.info,
      sessions: this.app.runtime.list(),
      foreground: this.app.runtime.foregroundId(),
      model: activeModel(cfg),
      provider: cfg.provider,
      permissionMode: cfg.permissionMode,
    };
  }

  transcript(id: string) {
    const s = this.app.store.get(id);
    if (!id || !s) throw new HttpError(404, 'No such session.');
    // Marked first: the snapshot below then holds every event up to `seq` and none after it.
    const seq = this.hooks.mark(id);
    // A run in progress has its tool calls stored before their results: those are in flight, and `live.tools` (or a
    // later tool_start) shows them. Left in, they would show twice, once as a finished "(no result)" row.
    const running = this.app.runtime.isRunning(id);
    // A blocked call's line offers Allow while this app session still knows the block
    const blocks = this.app.service<AutoBlocksService>('auto-blocks')?.list(id) ?? [];
    const items = toTranscript(s, { running }).map((item) => {
      if (item.role !== 'auto_blocked') return remoteItem(item);
      const known = blocks.find((b) => b.id === item.block.id);
      return { role: 'auto_blocked' as const, block: { ...item.block, allowed: known?.allowed === true }, allowable: !!known };
    });
    return { items, live: remoteLive(this.app.runtime.live(id)), seq };
  }

  private known(id: string): string {
    if (!this.app.store.get(id)) throw new HttpError(404, 'No such session.');
    return id;
  }
}
