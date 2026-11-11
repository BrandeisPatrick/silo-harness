// /report: a numbers-only report of the session on screen (history/report.ts), read from its history log, as a card in
// the window. It answers locally and is never sent to the model; scripts/session-report.js prints the same report for
// a log file outside the app.
import type { App } from './app';
import type { HistoryService } from './services';
import { sessionReport } from './history/report';

export const NO_REPORT = 'No history for this session yet.';

export function setupReport(app: App): void {
  app.commands.register({
    name: 'report',
    description: "Where this session's time went, numbers only (safe to share)",
    source: 'app',
    run: (_args, { sessionId }) => {
      const history = app.service<HistoryService>('history');
      const records = sessionId && history ? history.read(sessionId) : [];
      if (!records.length) return { notice: NO_REPORT };
      return { card: sessionReport(records, { now: Date.now() }) };
    },
  });
}
