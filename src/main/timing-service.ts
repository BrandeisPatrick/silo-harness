// /timing: where the last run of the session on screen spent its time (agent/perf.ts), as a note in the window. It
// answers locally and is never sent to the model.
import type { App } from './app';
import { formatRun } from './agent/perf';

export const NO_TIMING = 'No finished run in this session yet.';

export function setupTiming(app: App): void {
  app.commands.register({
    name: 'timing',
    description: 'Where the last run spent its time',
    source: 'app',
    run: (_args, { sessionId }) => {
      if (!sessionId || !app.runtime.get(sessionId)) return { notice: NO_TIMING };
      const record = app.runtime.agentFor(sessionId).lastTiming();
      return { notice: record ? formatRun(record) : NO_TIMING };
    },
  });
}
