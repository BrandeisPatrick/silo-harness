// What a counted model call is, as the history log keeps it (cost.ts makes the record, history/service.ts writes it,
// history/report.ts reads it), and how a dollar figure is written. Pure: no runtime imports, so the session report can use it
// outside the app (scripts/session-report.js); the types are in shared/history.ts.

import type { CallPurpose, CallRecord } from '../shared/history';

export type { CallPurpose, CallRecord };
/** What a counted call was for (CallPurpose), every value. */
export const CALL_PURPOSES: readonly CallPurpose[] = ['turn', 'check', 'title', 'compaction', 'merge'];

/** A model id as a log keeps it: the id itself when it looks like one (letters, digits, . _ : / @ -), else "other". */
export function logModelId(model: unknown): string {
  if (typeof model !== 'string') return 'other';
  const m = model.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(m) ? m : 'other';
}

/** "$0.04", "<$0.01" under a cent, "$12.30", "$1,234.50"; "$0.00" for nothing at all (a model priced at zero). */
export function formatUsd(usd: number): string {
  if (!(usd > 0)) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
