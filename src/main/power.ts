// Keep the Mac awake: hold off system sleep while sessions run ('running') or whenever the app is open ('always').
// 'prevent-app-suspension' lets the display sleep; a long unattended run (a schedule, a big refactor) keeps going.

import type { App } from './app';
import type { PowerStatus } from '../shared/schedules';

/** The part of Electron's powerSaveBlocker this needs; injected in tests */
export interface SleepBlocker {
  start(): number;
  stop(id: number): void;
}

/** Electron's blocker, loaded on first use so this module stays loadable under plain Node */
function electronBlocker(): SleepBlocker {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { powerSaveBlocker } = require('electron') as typeof import('electron');
  return { start: () => powerSaveBlocker.start('prevent-app-suspension'), stop: (id) => powerSaveBlocker.stop(id) };
}

export function setupPower(app: App, opts: { blocker?: SleepBlocker } = {}): void {
  let blocker = opts.blocker;
  let held: number | null = null;
  let quitting = false;
  let mode: PowerStatus['mode'] = app.config().keepAwake ?? 'running';
  const running = new Set(app.runtime.running());
  let last: PowerStatus | null = null;

  const status = (): PowerStatus => ({ mode, active: held !== null });

  function apply(): void {
    const want = !quitting && (mode === 'always' || (mode === 'running' && running.size > 0));
    if (want && held === null) {
      try {
        blocker ??= electronBlocker();
        held = blocker.start();
      } catch (err) {
        console.warn('[power] could not keep the system awake:', err);
      }
    } else if (!want && held !== null) {
      const id = held;
      held = null;
      try {
        blocker!.stop(id);
      } catch (err) {
        console.warn('[power] could not release the sleep blocker:', err);
      }
    }
    const now = status();
    if (!last || last.mode !== now.mode || last.active !== now.active) {
      last = now;
      app.push('power:changed', now);
    }
  }

  app.events.on((sessionId, ev) => {
    if (ev.type === 'run_start') running.add(sessionId);
    else if (ev.type === 'run_end') {
      // Cut by "Send now": the session runs on with the next message, so the Mac stays awake
      if (ev.continued) return;
      running.delete(sessionId);
      // Drop sessions whose end we missed, so a lost event cannot keep the Mac awake for good
      for (const id of running) if (!app.runtime.isRunning(id)) running.delete(id);
    } else return;
    apply();
  });
  app.onConfig((next) => {
    if (next.keepAwake === mode) return;
    mode = next.keepAwake ?? 'running';
    apply();
  });
  app.rpc.handle('power.status', () => status());
  app.onQuit(() => {
    quitting = true;
    apply();
  });
  apply();
}
