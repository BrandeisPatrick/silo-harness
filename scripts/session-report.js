#!/usr/bin/env node
// Prints where one session's time went, numbers only, as /report does in the app (src/main/history/report.ts): turns,
// model calls, tool calls by tool, waits on you, safety checks and retries, the longest stretches with no record,
// tokens per call and compactions. No message text, argument, command, path, URL, title or account name can reach
// it, so the output is safe to paste to someone else.
//   node scripts/session-report.js <path to a history .jsonl>
// A session's history log is history/<session id>.jsonl in the app's data folder. Needs a build (npm run build): it
// reads the report from dist/main/history/report.js. A torn last line (the app was killed mid-write) is skipped.
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node scripts/session-report.js <history .jsonl>');
  process.exit(2);
}
const dist = (p) => require(path.join(__dirname, '..', 'dist', 'main', p));
let report;
let parseLog;
try {
  ({ sessionReport: report } = dist('history/report.js'));
  ({ parseLog } = dist('history/log.js'));
  // The built-in tool names the report keeps as they are; any other tool is "mcp" or "other"
  dist('agent/perf.js').setBuiltInToolNames(dist('tools/index.js').builtInToolNames());
} catch (err) {
  console.error(`Build first: npm run build (${err && err.message ? err.message.split('\n')[0] : err})`);
  process.exit(1);
}
let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (err) {
  console.error(`Could not read ${file}: ${err.code || err.message}`);
  process.exit(1);
}
console.log(report(parseLog(text)));
