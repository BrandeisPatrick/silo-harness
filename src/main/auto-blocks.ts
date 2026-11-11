// The actions Auto mode's safety check blocked in this app session, for the quiet line's Allow in the chat, the phone
// and Settings → Permissions → Recently blocked. Kept in memory: a block from before the app started cannot be allowed.
// Also what Auto mode learned from the user's answers (agent/learned.ts), kept in <userData>/auto-learned.json, for
// the agents (the 'auto-learned' service) and Settings → Permissions → Auto mode (auto.learned, auto.forget).

import path from 'node:path';
import type { AutoBlock, RecentBlock } from '../shared/auto-mode';
import { LearnedStore } from './agent/learned';
import type { App } from './app';
import type { AutoBlocksService } from './services';

/** How many blocks "Recently blocked" lists. */
export const RECENT_BLOCKS = 20;

/** Keeps the blocks from the agents' events and offers them through the 'auto-blocks' service and the auto.* RPCs. */
export function setupAutoBlocks(app: App): AutoBlocksService {
  const bySession = new Map<string, AutoBlock[]>();
  app.runtime.onEvent((sessionId, ev) => {
    if (ev.type === 'auto_blocked') {
      const list = bySession.get(sessionId) ?? [];
      list.unshift({ ...ev.block });
      bySession.set(sessionId, list);
    } else if (ev.type === 'auto_allowed') {
      const b = bySession.get(sessionId)?.find((x) => x.id === ev.id);
      if (b) b.allowed = true;
    }
  });
  const titled = (b: AutoBlock): RecentBlock => ({ ...b, sessionTitle: app.store.get(b.sessionId)?.title ?? '' });
  const service: AutoBlocksService = {
    list(sessionId) {
      if (sessionId) return (bySession.get(sessionId) ?? []).filter(() => app.store.get(sessionId)).map(titled);
      return [...bySession.entries()]
        .filter(([id]) => app.store.get(id))
        .flatMap(([, list]) => list)
        .sort((a, b) => b.at - a.at)
        .slice(0, RECENT_BLOCKS)
        .map(titled);
    },
    allow(sessionId, id) {
      return app.runtime.allowBlocked(String(sessionId ?? ''), String(id ?? ''));
    },
  };
  app.provide('auto-blocks', service);
  app.rpc.handle('auto.blocked', (sessionId?: string) => service.list(typeof sessionId === 'string' && sessionId ? sessionId : undefined));
  app.rpc.handle('auto.allow', (sessionId, id) => service.allow(sessionId, id));
  const learned = new LearnedStore(path.join(app.userData, 'auto-learned.json'));
  app.provide('auto-learned', learned);
  app.rpc.handle('auto.learned', () => learned.all());
  app.rpc.handle('auto.forget', (id?: unknown) => {
    if (typeof id === 'string' && id) learned.remove(id);
    else learned.clear();
    return learned.all();
  });
  return service;
}
