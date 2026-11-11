#!/usr/bin/env node
// Prints where each run in a timing log spent its time, as /timing does in the app (docs/latency.md).
//   node scripts/timing-report.js <timing.jsonl> [--last N] [--tools]
// The log is in the app's data folder, timing/timing.jsonl, when SILO_TIMING=1 or the timingLog setting is on.
// Needs a build (npm run build): it reads the formatting from dist/main/agent/perf.js.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const lastAt = args.indexOf('--last');
const last = lastAt >= 0 ? Math.max(1, Number(args[lastAt + 1]) || 1) : Infinity;
const withTools = args.includes('--tools');
if (!file) {
  console.error('Usage: node scripts/timing-report.js <timing.jsonl> [--last N] [--tools]');
  process.exit(2);
}
let perf;
try {
  perf = require(path.join(__dirname, '..', 'dist', 'main', 'agent', 'perf.js'));
} catch {
  console.error('Build first: npm run build');
  process.exit(1);
}
const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const runs = [];
for (const l of lines) {
  try {
    const r = JSON.parse(l);
    if (r && r.v === 1 && r.summary) runs.push(r);
  } catch {
    /* a line cut off by a crash: skipped */
  }
}
if (!runs.length) {
  console.log('No runs in that file.');
  process.exit(0);
}
const pad = (s, n) => String(s).padEnd(n);
for (const r of runs.slice(-Math.min(last, runs.length))) {
  const when = new Date(r.at).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`${when}  session ${r.session}  run ${r.run}  ${r.provider}/${r.model}  ${r.mode}  limit ${r.limit}  ended ${r.end}`);
  console.log('  ' + perf.formatRun(r).split('\n').join('\n  '));
  if (withTools && r.tools.length) {
    console.log(`  ${pad('turn', 5)}${pad('tool', 16)}${pad('wall', 8)}${pad('exec', 8)}${pad('queue', 8)}${pad('perm', 8)}${pad('path', 16)}${pad('along', 6)}outcome`);
    for (const t of r.tools) {
      const perm = t.permission.reduce((a, p) => a + p.ms, 0);
      const paths = t.permission.map((p) => p.path).join(',') || '-';
      console.log(`  ${pad(t.turn, 5)}${pad(t.name, 16)}${pad(perf.duration(t.wallMs), 8)}${pad(perf.duration(t.execMs), 8)}${pad(perf.duration(t.queueMs), 8)}${pad(perf.duration(perm), 8)}${pad(paths, 16)}${pad(t.alongside, 6)}${t.outcome}`);
    }
  }
  console.log('');
}
