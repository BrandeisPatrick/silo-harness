// Scheduled tasks: prompts sent later, once or on a rhythm, by the user (from the window) or by the agent (through
// its tools, each one approved). Wires the scheduler into the app: service, RPC, tools, prompt section, /schedules.

import type { App } from './app';
import { createScheduler, type Scheduler, type SchedulerOptions } from './schedules/service';
import { scheduleLine, scheduleTools } from './schedules/tools';

export type { Scheduler, SchedulerOptions } from './schedules/service';

const PROMPT_SECTION = [
  '## Schedules',
  'schedule_create runs a prompt later or regularly while the app is open; the user approves every schedule. Runs work in the folder the schedule was made in, under the usual permission mode and rules.',
].join('\n');

/** `opts` is for tests: an injected clock, timer and store. Returns the scheduler (also provided as 'schedules'). */
export function setupSchedules(app: App, opts: SchedulerOptions = {}): Scheduler {
  const now = opts.now ?? Date.now;
  const svc = createScheduler(app, opts);
  app.provide('schedules', svc);

  // From the window: the user is the one asking, so no approval card
  app.rpc.handle('schedules.list', () => svc.list());
  app.rpc.handle('schedules.create', (input) => svc.create(input, 'user'));
  app.rpc.handle('schedules.update', (id, patch) => svc.update(id, patch));
  app.rpc.handle('schedules.remove', (id) => {
    svc.remove(id);
    return svc.list();
  });
  app.rpc.handle('schedules.runNow', (id) => svc.runNow(id));
  app.rpc.handle('schedules.preview', (when) => svc.preview(when));
  app.rpc.handle('schedules.chooseFolder', async (defaultPath) => {
    const win = app.window();
    if (!win) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dialog } = require('electron') as typeof import('electron');
    const start = typeof defaultPath === 'string' && defaultPath ? defaultPath : app.config().workingDirectory;
    const res = await dialog.showOpenDialog(win, { title: 'The folder the task works in', properties: ['openDirectory', 'createDirectory'], defaultPath: start });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  for (const tool of scheduleTools(svc, now)) app.tools.register({ ...tool, optional: true });
  app.prompt.add('schedules', () => PROMPT_SECTION, { optional: true });
  app.commands.register({
    name: 'schedules',
    description: 'List scheduled tasks and when they run next',
    source: 'app',
    run: () => {
      const all = svc.list();
      if (!all.length) return { notice: 'No schedules yet.' };
      const t = now();
      return { notice: `${all.length} schedule${all.length === 1 ? '' : 's'}:\n${all.map((s) => scheduleLine(s, t)).join('\n')}` };
    },
  });
  app.onQuit(() => svc.dispose());
  return svc;
}
