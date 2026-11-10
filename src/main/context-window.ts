// The configured model's context window and what follows from the config: how many tokens a request may take,
// whether the optional tool families are offered at all, and whether the tool groups come up front. Facts about the
// provider and the config, read by the agent, the window's IPC, dreaming and mods alike.

import type { AppConfig } from '../shared/types';
import { contextSize } from './ollama';
import { ollamaOf, resolveProvider } from './providers';

/** The context window the configured model has, in tokens. */
export function contextLimit(cfg: AppConfig): number {
  const r = resolveProvider(cfg);
  if (r.type === 'ollama') return contextSize(ollamaOf(cfg).numCtx);
  return Math.max(4096, Number(r.contextWindow) || 128000);
}

/**
 * Whether the optional tool families (scheduled tasks, sub-sessions, mod authoring) are left out altogether: only when
 * the user chose the essential tools. They used to be left out under a 32k window too, since every definition went
 * with every request; now each is a tool group a session loads only when it needs it, so a small window pays for one
 * only once it is used.
 */
export function essentialToolsOnly(cfg: AppConfig): boolean {
  return cfg.toolSet === 'essential';
}

/**
 * Whether every tool group (tools/groups.ts) is offered from a session's first request, as before groups were loaded
 * when needed: only when the user chose all tools. Otherwise a session gets a group once it needs it.
 */
export function allGroupsUpFront(cfg: AppConfig): boolean {
  return cfg.toolSet === 'all';
}
