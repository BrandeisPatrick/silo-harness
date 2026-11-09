// What each bridge method needs, shared by the main process and (through the build) the window-side host.
// src/shared is types only, so the runtime tables live here.

import type { ModLookTarget, ModMethod, ModPermission, ModSeat } from '../../shared/mods';

export const MOD_PROTOCOL = 1;

export const MOD_PERMISSIONS: readonly ModPermission[] = [
  'session:read',
  'session:send',
  'session:control',
  'sessions:read',
  'model',
  'skills:read',
  'config:read',
  'config:write',
  'schedules',
  'remote',
  'network',
  'hooks',
];

export const MOD_SEATS: readonly ModSeat[] = ['rail', 'tab', 'composer', 'background', 'worker'];
/** The regions a look can restyle (docs/mods.md, Looks); a manifest naming another one gets a warning, not an error. */
export const MOD_LOOK_TARGETS: readonly ModLookTarget[] = ['conversation', 'composer'];
/** Seats a later protocol version will define; a manifest naming one gets a clearer message than "unknown". */
export const RESERVED_SEATS: readonly string[] = ['transcript', 'status', 'sidebar'];

/** The permission every bridge method needs; null: always available. */
export const MOD_METHOD_PERMISSIONS: Record<ModMethod, ModPermission | null> = {
  hello: null,
  'events.subscribe': null,
  'events.unsubscribe': null,
  'hooks.subscribe': 'hooks',
  'hooks.unsubscribe': 'hooks',
  'log.error': null,
  'ui.theme': null,
  'ui.resize': null,
  'ui.setTitle': null,
  'ui.setBadge': null,
  'ui.toast': null,
  'ui.open': null,
  'ui.copy': null,
  'ui.openExternal': null,
  'ui.markdown': null,
  'ui.openSettings': null,
  'ui.openPage': null,
  'storage.get': null,
  'storage.set': null,
  'storage.remove': null,
  'storage.keys': null,
  'settings.get': null,

  'session.get': 'session:read',
  'session.transcript': 'session:read',
  'session.tasks': 'session:read',
  'session.plan': 'session:read',
  'session.outputs': 'session:read',
  'session.context': 'session:read',
  'session.related': 'session:read',
  'outputs.open': 'session:read',

  'session.send': 'session:send',
  'composer.insert': 'session:send',

  'session.stop': 'session:control',
  'session.compact': 'session:control',
  'sessions.open': 'session:control',
  'sessions.create': 'session:control',
  'sessions.spawn': 'session:control',
  'sessions.merge': 'session:control',

  'sessions.list': 'sessions:read',
  'sessions.search': 'sessions:read',

  'model.complete': 'model',
  'model.cancel': 'model',

  'skills.list': 'skills:read',
  'skills.usage': 'skills:read',

  'config.get': 'config:read',
  'config.set': 'config:write',
  'project.git': 'config:read',

  'schedules.list': 'schedules',
  'schedules.create': 'schedules',
  'schedules.update': 'schedules',
  'schedules.remove': 'schedules',
  'schedules.runNow': 'schedules',

  'remote.status': 'remote',
  'remote.start': 'remote',
  'remote.stop': 'remote',
};

/** Methods the window answers itself (they need the frame, the DOM or the window's own state); main refuses them. */
export function isWindowMethod(method: string): boolean {
  return (
    method === 'hello' ||
    method === 'events.subscribe' ||
    method === 'events.unsubscribe' ||
    method === 'hooks.subscribe' ||
    method === 'hooks.unsubscribe' ||
    method === 'log.error' ||
    method.startsWith('ui.') ||
    method === 'composer.insert' ||
    method === 'outputs.open' ||
    method === 'sessions.open' ||
    method === 'sessions.create'
  );
}

/** Events that need a permission before a view may receive them (the rest are always available). */
export const MOD_EVENT_PERMISSIONS: Record<string, ModPermission | null> = {
  'theme.changed': null,
  'settings.changed': null,
  pointer: null,
  'visibility.changed': null,
  command: null,
  'session.switched': null,
  'session.changed': 'session:read',
  'related.changed': 'session:read',
  'run.started': 'session:read',
  'run.ended': 'session:read',
  'message.user': 'session:read',
  'message.assistant': 'session:read',
  'message.delta': 'session:read',
  'tool.started': 'session:read',
  'tool.ended': 'session:read',
  'tasks.changed': 'session:read',
  'plan.changed': 'session:read',
  'outputs.changed': 'session:read',
  'context.changed': 'session:read',
  'model.delta': 'model',
  'skills.used': 'skills:read',
  'config.changed': 'config:read',
  'schedules.changed': 'schedules',
  'remote.changed': 'remote',
};

/** JSON-RPC error codes of the protocol (docs/mods.md, "Under the object"). */
export const ModError = {
  unknownMethod: -32601,
  badParams: -32602,
  permission: 4003,
  unavailable: 4004,
  timeout: 4008,
  other: 4000,
} as const;
