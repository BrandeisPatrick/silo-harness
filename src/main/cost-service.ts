// /cost: what the session on screen has cost so far (cost.ts), as a note in the window. It answers locally and is
// never sent to the model.
import type { App } from './app';
import { costNote } from './cost';

export function setupCost(app: App): void {
  app.commands.register({
    name: 'cost',
    description: "The session's tokens and estimated cost",
    source: 'app',
    run: (_args, { sessionId }) => {
      const s = sessionId ? app.runtime.get(sessionId) : undefined;
      return { notice: costNote(s?.cost, app.config().prices) };
    },
  });
}
