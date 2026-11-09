// The settings a mod may see (config:read) and change (config:write). Built field by field from the config so a
// key, token, header or URL with credentials can never slip through, whatever is added to AppConfig later.

import os from 'node:os';
import type { AppConfig } from '../../shared/types';
import type { ModInfo, PublicConfig, PublicConfigPatch } from '../../shared/mods';
import { contextLimit } from '../context-window';
import { activeModel } from '../providers';

const THEMES = ['system', 'light', 'dark'] as const;
const KEEP_AWAKE = ['off', 'running', 'always'] as const;
const PATCH_KEYS = ['theme', 'autoCompact', 'compactThreshold', 'keepAwake', 'notifications', 'background'] as const;

/** A model name without anything that looks like credentials (a Portkey model id is just a name, but be strict) */
function modelName(s: unknown): string {
  return typeof s === 'string' ? s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]*/gi, '').slice(0, 200) : '';
}

/** `sessionCwd`: the folder of the session on screen (the config's working directory when unknown). */
export function publicConfig(cfg: AppConfig, sessionCwd?: string): PublicConfig {
  const layout = cfg.mods?.layout;
  const background = layout?.background ? String(layout.background) : layout?.backgroundImage ? 'image' : null;
  return {
    provider: String(cfg.provider || 'ollama'),
    model: modelName(activeModel(cfg)),
    workingDirectory: String(sessionCwd || cfg.workingDirectory || ''),
    home: os.homedir(),
    permissionMode: cfg.permissionMode,
    theme: (THEMES as readonly string[]).includes(cfg.theme) ? cfg.theme : 'system',
    autoCompact: cfg.autoCompact !== false,
    compactThreshold: Number(cfg.compactThreshold) || 0.8,
    keepAwake: (KEEP_AWAKE as readonly string[]).includes(cfg.keepAwake) ? cfg.keepAwake : 'running',
    notifications: cfg.notifications !== false,
    background,
    contextLimit: contextLimit(cfg),
  };
}

export class PatchError extends Error {}

/**
 * Applies a mod's config.set patch: only the keys of PublicConfigPatch, each validated. `background` is a
 * "<mod key>/<view id>" of an on mod's background view, "image" (the user's own picture, which must be set), or null.
 */
export function applyPublicPatch(cfg: AppConfig, patch: unknown, mods: ModInfo[]): AppConfig {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new PatchError('patch: must be an object, e.g. { "theme": "dark" }');
  const p = patch as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!(PATCH_KEYS as readonly string[]).includes(k)) throw new PatchError(`patch.${k}: a mod cannot change this; it may change ${PATCH_KEYS.join(', ')}`);
  }
  const next: AppConfig = { ...cfg, mods: { ...cfg.mods, layout: { ...cfg.mods.layout } } };
  const q = p as PublicConfigPatch;
  if ('theme' in p) {
    if (!(THEMES as readonly unknown[]).includes(q.theme)) throw new PatchError(`patch.theme: must be one of ${THEMES.join(', ')}`);
    next.theme = q.theme!;
  }
  if ('autoCompact' in p) {
    if (typeof q.autoCompact !== 'boolean') throw new PatchError('patch.autoCompact: must be true or false');
    next.autoCompact = q.autoCompact;
  }
  if ('compactThreshold' in p) {
    const t = q.compactThreshold;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0.5 || t > 0.95) throw new PatchError('patch.compactThreshold: must be a number from 0.5 to 0.95');
    next.compactThreshold = t;
  }
  if ('keepAwake' in p) {
    if (!(KEEP_AWAKE as readonly unknown[]).includes(q.keepAwake)) throw new PatchError(`patch.keepAwake: must be one of ${KEEP_AWAKE.join(', ')}`);
    next.keepAwake = q.keepAwake!;
  }
  if ('notifications' in p) {
    if (typeof q.notifications !== 'boolean') throw new PatchError('patch.notifications: must be true or false');
    next.notifications = q.notifications;
  }
  if ('background' in p) {
    const b = q.background;
    if (b === null) {
      next.mods.layout.background = null;
      next.mods.layout.backgroundImage = null;
    } else if (b === 'image') {
      if (!cfg.mods.layout.backgroundImage) throw new PatchError('patch.background: "image" needs a picture; the user chooses one in Settings → Mods');
      next.mods.layout.background = null;
    } else if (typeof b === 'string' && isBackgroundView(b, mods)) {
      next.mods.layout.background = b;
    } else {
      throw new PatchError('patch.background: must be null, "image", or "<mod key>/<view id>" of a background view whose looks may be used (a bundled mod, or one the user approved)');
    }
  }
  return next;
}

export function isBackgroundView(ref: string, mods: ModInfo[]): boolean {
  const i = ref.lastIndexOf('/');
  if (i <= 0) return false;
  const key = ref.slice(0, i);
  const view = ref.slice(i + 1);
  const m = mods.find((x) => x.key === key);
  return !!m && (m.approved ?? m.state === 'on') && !!m.manifest?.contributes?.views?.some((v) => v.id === view && v.seat === 'background');
}
