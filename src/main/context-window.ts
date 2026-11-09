// The configured model's context window and what follows from its size: how many tokens a request may take and
// whether the optional tool families are offered at all. Facts about the provider and the config, read by the agent,
// the window's IPC, dreaming and mods alike.

import type { AppConfig } from '../shared/types';
import { contextSize } from './ollama';
import { ollamaOf, resolveProvider } from './providers';

/** Below this window the optional tool families are left out unless the user asks for all tools. */
export const FULL_TOOLS_WINDOW = 32_000;

/** The context window the configured model has, in tokens. */
export function contextLimit(cfg: AppConfig): number {
  const r = resolveProvider(cfg);
  if (r.type === 'ollama') return contextSize(ollamaOf(cfg).numCtx);
  return Math.max(4096, Number(r.contextWindow) || 128000);
}

/**
 * Whether only the essential tools are offered. Every tool definition is sent with every request: with a 16k window
 * the optional families (scheduled tasks, sub-sessions, mod authoring) would take a fifth of it before a word is said.
 */
export function essentialToolsOnly(cfg: AppConfig): boolean {
  if (cfg.toolSet === 'essential') return true;
  if (cfg.toolSet === 'all') return false;
  return contextLimit(cfg) < FULL_TOOLS_WINDOW;
}
