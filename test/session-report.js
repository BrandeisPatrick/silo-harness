// The session report (src/main/history/report.ts, /report, scripts/session-report.js) on made-up history logs: the
// numbers it gives (turns, model calls as the gap before each usage record, tools by tool, waits on the user, safety
// checks, retries, the longest stretches with no record, tokens, compactions); a log written by 0.17.0, without the
// newer records, reads "not recorded" and never crashes; a torn last line, garbage and an open turn are handled; and
// nothing private reaches the output (secrets planted in message text, arguments, commands, paths, URLs, titles,
// tool names, provider and account names, notices, errors and summaries).
// Run: node test/session-report.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { sessionReport } = dist('history/report.js');
const { parseLog } = dist('history/log.js');
const P = dist('agent/perf.js');
const { builtInToolNames } = dist('tools/index.js');
const { setupReport, NO_REPORT } = dist('report-service.js');
const { check, done } = require('./support/check.js');

P.setBuiltInToolNames(builtInToolNames());

const SECRETS = ['sk-ant-SECRET-REPORT', '/Users/jdoe/falcon-secret', 'https://internal.example.com/secret', 'acme-corp', 'Project Falcon', 'jdoe@example.com', 'CMD-SECRET-TOKEN', 'TITLE-SECRET', 'SUMMARY-SECRET', 'NOTICE-SECRET', 'falcon-gateway', 'FILE-SECRET-CONTENT', 'THINK-SECRET', 'QUESTION-SECRET', 'ANSWER-SECRET', 'DETAIL-SECRET'];
const leaks = (text) => SECRETS.filter((s) => text.includes(s));

/** A log as the app writes it: records with seq and t; `skipNew` leaves out what 0.17.0 did not write. */
function makeLog({ skipNew = false, oldFirstRun = false } = {}) {
  const T0 = Date.UTC(2026, 10, 11, 9, 0, 0);
  const recs = [];
  let seq = 0;
  const NEW = new Set(['retry', 'check', 'question.request', 'question.resolved', 'compaction.start']);
  const add = (at, type, data) => {
    if (skipNew && NEW.has(type)) return;
    if (skipNew && type === 'run.start') data = { origin: data.origin };
    recs.push({ v: 1, seq: ++seq, t: T0 + at, type, data });
  };
  add(0, 'session.created', { title: 'TITLE-SECRET Project Falcon', cwd: '/Users/jdoe/falcon-secret', origin: 'user', createdAt: T0 });
  // Turn 1: a command checked by Auto mode, a 5-minute stall and a retry, a write, an MCP call with a card, a question,
  // a compaction
  add(0, 'run.start', oldFirstRun ? { origin: 'user' } : { origin: 'user', timing: 'a1b2c3d4' });
  add(10, 'message.append', { index: 0, message: { role: 'user', content: 'Deploy with sk-ant-SECRET-REPORT to https://internal.example.com/secret' } });
  add(4010, 'usage', { promptTokens: 12000, completionTokens: 300, cacheReadTokens: 0 });
  add(4012, 'message.append', { index: 1, message: { role: 'assistant', content: 'Running.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo CMD-SECRET-TOKEN"}' } }] } });
  add(4015, 'tool.start', { id: 'c1', name: 'bash', args: { command: 'echo CMD-SECRET-TOKEN /Users/jdoe/falcon-secret' } });
  add(6515, 'check', { ms: 2500, verdict: 'allow', timedOut: false });
  add(7715, 'tool.end', { id: 'c1', name: 'bash', ok: true, durationMs: 1200, chars: 40 });
  add(7725, 'message.append', { index: 2, message: { role: 'tool', tool_call_id: 'c1', content: 'CMD-SECRET-TOKEN FILE-SECRET-CONTENT' } });
  add(307725, 'retry', { attempt: 2, waitMs: 1000, ranMs: 300000, kind: 'idle' });
  add(320000, 'usage', { promptTokens: 13000, completionTokens: 5200, cacheReadTokens: 11000 });
  add(320005, 'message.append', { index: 3, message: { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write_file', arguments: '{"path":"/Users/jdoe/falcon-secret/a.txt","content":"FILE-SECRET-CONTENT"}' } }] } });
  add(320010, 'tool.start', { id: 'c2', name: 'write_file', args: { path: '/Users/jdoe/falcon-secret/a.txt', content: 'FILE-SECRET-CONTENT' } });
  add(320040, 'tool.end', { id: 'c2', name: 'write_file', ok: true, durationMs: 30, chars: 20 });
  add(320045, 'message.append', { index: 4, message: { role: 'tool', tool_call_id: 'c2', content: 'Wrote /Users/jdoe/falcon-secret/a.txt' } });
  add(320050, 'tool.start', { id: 'c3', name: 'mcp__acme-corp__deploy', args: { target: 'Project Falcon' }, mcp: { server: 'acme-corp', tool: 'deploy' } });
  add(320060, 'approval.request', { id: 'ap-1', name: 'mcp__acme-corp__deploy', detail: 'DETAIL-SECRET Project Falcon', reason: 'NOTICE-SECRET' });
  add(340060, 'approval.resolved', { id: 'ap-1', ok: true, scope: 'once' });
  add(340560, 'tool.end', { id: 'c3', name: 'mcp__acme-corp__deploy', ok: false, durationMs: 500, chars: 12 });
  add(340565, 'message.append', { index: 5, message: { role: 'tool', tool_call_id: 'c3', content: 'Error: jdoe@example.com' } });
  add(342565, 'usage', { promptTokens: 14000, completionTokens: 200, cacheReadTokens: 13000 });
  add(342570, 'message.append', { index: 6, message: { role: 'assistant', content: '', tool_calls: [{ id: 'c4', type: 'function', function: { name: 'ask_user', arguments: '{"questions":[{"question":"QUESTION-SECRET"}]}' } }] } });
  add(342575, 'tool.start', { id: 'c4', name: 'ask_user', args: { questions: [{ question: 'QUESTION-SECRET' }] } });
  add(342580, 'question.request', { count: 2 });
  add(387580, 'question.resolved', { outcome: 'answered' });
  add(387585, 'tool.end', { id: 'c4', name: 'ask_user', ok: true, durationMs: 45005, chars: 30 });
  add(387590, 'message.append', { index: 7, message: { role: 'tool', tool_call_id: 'c4', content: 'ANSWER-SECRET' } });
  add(387600, 'tool.start', { id: 'c5', name: 'Project Falcon', args: { x: 'sk-ant-SECRET-REPORT' } });
  add(387610, 'tool.end', { id: 'c5', name: 'Project Falcon', ok: false, durationMs: 0, chars: 50 });
  add(387700, 'notice', { message: 'NOTICE-SECRET falcon-gateway' });
  add(387800, 'compaction.start', { reason: 'auto' });
  add(417800, 'compaction', { id: 'k1', reason: 'auto', tokensBefore: 150000, tokensAfter: 20000, summary: 'SUMMARY-SECRET Project Falcon' });
  add(417801, 'messages.replace', { reason: 'compaction', messages: [{ role: 'user', content: 'SUMMARY-SECRET' }], removed: 8 });
  add(425801, 'usage', { promptTokens: 21000, completionTokens: 900, cacheReadTokens: 0 });
  add(425805, 'message.append', { index: 1, message: { role: 'assistant', content: 'Done for Project Falcon.' } });
  add(425806, 'thinking', { text: 'THINK-SECRET', ms: 2000 });
  add(425900, 'snapshot', { messages: [{ role: 'assistant', content: 'Done for Project Falcon.' }] });
  add(426000, 'run.end', { reason: 'done', text: 'Done for Project Falcon.' });
  // Ten minutes away, then turn 2 from the queue, stopped after an error
  add(1026000, 'run.start', { origin: 'queue', timing: 'b2c3d4e5' });
  add(1026010, 'message.append', { index: 2, message: { role: 'user', content: 'jdoe@example.com again' } });
  add(1036010, 'error', { message: 'falcon-gateway refused jdoe@example.com' });
  add(1037010, 'run.end', { reason: 'aborted' });
  add(1037020, 'session.renamed', { title: 'TITLE-SECRET' });
  return recs;
}

(async () => {
  // ---------- 1: a session with every kind of record ----------
  const recs = makeLog();
  const out = sessionReport(recs);
  console.log(out.replace(/^/gm, '    '));
  check('1: nothing private reaches the report', leaks(out).length === 0, leaks(out));
  check('1: it is Markdown with a bold label per section', /^\*\*Session report\*\*/.test(out) && /\n\*\*Model calls\*\*/.test(out) && /\n- /.test(out));
  check('1: two turns, their origins and how they ended, the time away left out', /\*\*Time\*\* 7m 17s working in 2 turns, over 17m 17s/.test(out) && /- turn 1, your message: 7m 06s\n/.test(out) && /- turn 2, queued message: 11s, stopped/.test(out), out.split('\n').slice(2, 5));
  check('1: four model calls, timed from the record before each usage record (a retry inside the call not counted as its start)', /\*\*Model calls\*\* 4, 5m 26s in all, median 6s/.test(out) && /slowest: call 2 5m 12s, call 4 8s, call 1 4s/.test(out), out.match(/\*\*Model calls\*\*.*\n.*/)?.[0]);
  check('1: tools by tool: their own time, slowest first; MCP and unknown names as words; ask_user under the waits', /\*\*Tool calls\*\* 5, 2s of their own work/.test(out) && /- bash: 1, 1s\n/.test(out) && /- MCP tools: 1, 0\.5s, 1 failed/.test(out) && /- ask_user: 1, time under Waiting on you/.test(out) && /- other tools: 1, 0\.0s, 1 failed/.test(out), out.match(/\*\*Tool calls\*\*[\s\S]*?\n\n/)?.[0]);
  check('1: waits on you: the card and the question, from their own records', /\*\*Waiting on you\*\* 1m 05s/.test(out) && /- approval cards: 1, 20s/.test(out) && /- questions: 1, 45s\n/.test(out), out.match(/\*\*Waiting on you\*\*[\s\S]*?\n\n/)?.[0]);
  check('1: safety checks and retries from their records, with the kinds in words', /\*\*Safety checks\*\* 1, 3s in all, slowest 3s\n- allow 1/.test(out) && /\*\*Retries\*\* 1, 1s waiting before them\n- why: no data 1\n- longest failed attempt: 5m 00s \(no data\)/.test(out), out.match(/\*\*Safety checks\*\*[\s\S]*?\n\*\*Longest/)?.[0]);
  check('1: the longest stretch is the stall, with what came before and after in fixed words', /\*\*Longest stretches with no record\*\*\n- 5m 00s in turn 1, 8s in: after tool result, before retry\n/.test(out), out.match(/\*\*Longest[\s\S]*?\n\n/)?.[0]);
  check('1: five stretches at most, inside turns only (not the ten minutes away)', (out.match(/\*\*Longest[\s\S]*?\n\n/)?.[0].match(/\n- /g) || []).length === 5 && !/10m 00s/.test(out));
  check('1: tokens per call: min, median, max, total, and the share read from the cache', /\*\*Tokens per model call\*\* 4 calls\n- input: 12k min, 14k median, 21k max, 60k total, 40% read from cache\n- output: 200 min, 600 median, 5\.2k max, 6\.6k total/.test(out), out.match(/\*\*Tokens[\s\S]*?\n\n/)?.[0]);
  check('1: the compaction with its tokens and its time', /\*\*Compactions\*\* 1\n- 150k → 20k tokens, 30s/.test(out));

  // ---------- 2: a log written by 0.17.0 (no check, retry, question or compaction-start records, no timing id) ----------
  const old = sessionReport(makeLog({ skipNew: true }));
  check('2: a 0.17.0 log: checks and retries read "not recorded"', /\*\*Safety checks\*\* not recorded/.test(old) && /\*\*Retries\*\* not recorded/.test(old), old.match(/\*\*Safety checks\*\*[\s\S]*?\n\*\*Longest/)?.[0]);
  check('2: …the question wait comes from the ask_user call, the compaction has no time', /- questions: 1, 45s \(from the ask_user calls\)/.test(old) && /- 150k → 20k tokens, time not recorded/.test(old));
  check('2: …without the retry record the stall is one model call', /slowest: call 2 5m 12s/.test(old) && /after tool result, before model reply/.test(old));
  check('2: …and nothing private either', leaks(old).length === 0, leaks(old));
  const mixed = sessionReport(makeLog({ oldFirstRun: true }));
  check('2: a session begun before the newer records says in how many turns they were kept', /\*\*Safety checks\*\* 1, 3s in all, slowest 3s \(recorded in 1 of 2 turns\)/.test(mixed), mixed.match(/\*\*Safety checks\*\*.*/)?.[0]);
  const none = sessionReport(makeLog().filter((r) => !['check', 'retry'].includes(r.type)));
  check('2: a newer log with no check or retry says none', /\*\*Safety checks\*\* none\n/.test(none) && /\*\*Retries\*\* none\n/.test(none));

  // ---------- 3: what it tolerates ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-report-'));
  const file = path.join(tmp, 'session-falcon-secret.jsonl');
  const text = recs.map((r) => JSON.stringify(r)).join('\n') + '\n' + JSON.stringify({ v: 1, seq: 999, t: recs[recs.length - 1].t + 5, type: 'notice', data: { message: 'NOTICE-SECRET' } }).slice(0, 40);
  fs.writeFileSync(file, text);
  check('3: a torn last line is skipped', parseLog(text).length === recs.length && sessionReport(parseLog(text)) === out);
  let garbage = '';
  try {
    garbage = [sessionReport(null), sessionReport(undefined), sessionReport([]), sessionReport([1, 'x', null, { type: 5 }, { t: 'x', type: 'usage' }, { t: NaN, type: 'run.start' }, { t: 5, seq: 1, type: 'usage', data: { promptTokens: 'sk-ant-SECRET-REPORT' } }, { t: 6, seq: 2, type: 'tool.end', data: null }, { t: 7, seq: 3, type: 'run.end' }])].join('\n');
  } catch (err) {
    garbage = `THREW ${err && err.message}`;
  }
  check('3: garbage, an empty log and records with missing fields: a report, never a crash', !/THREW/.test(garbage) && /Nothing recorded for this session yet/.test(garbage) && leaks(garbage).length === 0, garbage.slice(0, 300));
  const unsorted = sessionReport([...recs].reverse());
  check('3: records out of order are read in time order', unsorted === out);

  // An open turn (the session is still running): it counts up to now, and the last stretch ends "now"
  const openRecs = makeLog().filter((r) => r.t <= recs.find((x) => x.type === 'retry').t - 1);
  const lastT = openRecs[openRecs.length - 1].t;
  const live = sessionReport(openRecs, { now: lastT + 90_000 });
  check('3: an open turn is in progress, and the silence since its last record is a stretch that ends now', /- turn 1, your message: 1m 38s, in progress/.test(live) && /- 1m 30s in turn 1, 8s in: after tool result, before now \(still running\)/.test(live), live.match(/\*\*Longest[\s\S]*?\n\n/)?.[0]);
  // A run that never ended (the app was killed and the log not recovered) before the next one began
  const killed = sessionReport(makeLog().filter((r) => !(r.type === 'run.end' && r.data.reason === 'done')));
  check('3: a turn with no end before the next one ends at its last record, marked unfinished', /- turn 1, your message: 7m 06s, unfinished/.test(killed), killed.match(/\*\*Time\*\*[\s\S]*?\n\n/)?.[0]);
  // Recovery's "interrupted" end is written when the app starts again: the turn ends at its last record before it
  const late = makeLog();
  const doneAt = late.findIndex((r) => r.type === 'run.end' && r.data.reason === 'done');
  // (written when the app opened again, eight minutes later, before the next turn)
  late[doneAt] = { ...late[doneAt], t: late[doneAt].t + 480_000, data: { reason: 'interrupted' } };
  const recovered = sessionReport(late);
  check('3: an "interrupted" end written at the next start does not stretch the turn', /- turn 1, your message: 7m 06s, app closed/.test(recovered), recovered.match(/\*\*Time\*\*[\s\S]*?\n\n/)?.[0]);

  // ---------- 4: the script and the command ----------
  const r = spawnSync(process.execPath, [path.join(projectDir, 'scripts', 'session-report.js'), file], { encoding: 'utf8' });
  check('4: scripts/session-report.js prints the same report for a log file (torn last line and all)', r.status === 0 && r.stdout === out + '\n', { status: r.status, err: r.stderr.slice(0, 200) });
  check('4: …and nothing private, not even the file name', leaks(r.stdout + r.stderr).length === 0 && !r.stdout.includes('session-falcon'), leaks(r.stdout));
  const usage = spawnSync(process.execPath, [path.join(projectDir, 'scripts', 'session-report.js')], { encoding: 'utf8' });
  const missing = spawnSync(process.execPath, [path.join(projectDir, 'scripts', 'session-report.js'), path.join(tmp, 'nope.jsonl')], { encoding: 'utf8' });
  check('4: without a file it says how to use it; a missing file is an error, not a crash', usage.status === 2 && /Usage/.test(usage.stderr) && missing.status === 1 && /Could not read/.test(missing.stderr) && !/at Object|node:internal/.test(missing.stderr));

  let cmd = null;
  const fakeApp = {
    commands: { register: (c) => (cmd = c) },
    service: (name) => (name === 'history' ? { read: (id) => (id === 'S1' ? recs : []) } : undefined),
  };
  setupReport(fakeApp);
  const res = await cmd.run('', { sessionId: 'S1' });
  check('4: /report is an app command whose answer is a card of the report (it never reaches the model)', cmd.name === 'report' && cmd.source === 'app' && res.card === sessionReport(recs, { now: Date.now() }) && !res.send && !res.insert);
  const empty = await cmd.run('', { sessionId: 'S2' });
  const noService = await (() => {
    let c2 = null;
    setupReport({ commands: { register: (c) => (c2 = c) }, service: () => undefined });
    return c2.run('', { sessionId: 'S1' });
  })();
  check('4: a session with no log yet, or no history service: one short notice', empty.notice === NO_REPORT && noService.notice === NO_REPORT && !empty.card);

  // ---------- 5: what the report keeps is a fixed vocabulary ----------
  // Every word in the output, numbers and the known units aside, comes from the report's own text (no record content)
  const vocab = new Set(
    (
      'session report numbers only no content time working in turns turn over your message queued another phone mod command dream schedule other stopped error plan app closed unfinished in progress turn limit repeated call ' +
      'model calls all median slowest call tool their own work approvals and checks not included under waiting on you approval cards questions none from the ask_user safety allow block ask timed out recorded retries before them why data connection rate limited busy too long longest failed attempt ' +
      'stretches with record after before result reply user start end of notice retry question card answer check save saved session change messages replaced rewind thinking compaction compactions tokens per input output min max total read cache that did finish shown last mcp tools mcp now still running'
    ).split(/\s+/),
  );
  for (const n of builtInToolNames()) vocab.add(n);
  const unknown = [...new Set((out + '\n' + old + '\n' + live).toLowerCase().replace(/\*\*/g, ' ').split(/[^a-z_]+/).filter(Boolean))].filter((w) => !vocab.has(w) && !/^(h|m|s|k)$/.test(w) && w !== 'done');
  check('5: every word of the output is the report\'s own', unknown.length === 0, unknown);

  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
