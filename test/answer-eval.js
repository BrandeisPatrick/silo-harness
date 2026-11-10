// The answer eval's pure parts (scripts/answer-eval.js): the grader's answer parsed (and refused when it is not one),
// the records a tool call reads, a run's figures from a history log, the cost and the report; and the made-up fixture
// holds what the reference notes say.
// Run: node test/answer-eval.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');
const A = require(path.join(projectDir, 'scripts/answer-eval.js'));

// ---------- 1. The grader's answer ----------
const good = '{"supported":true,"trap_record":"flagged","trap_ratio":"Fell","trap_counterfactual":"avoided","separated":false,"note":"ok"}';
const g = A.parseGrade(`Here it is:\n\`\`\`json\n${good}\n\`\`\``);
check('grade: one line of JSON in a fence parses, values lower-cased', g && g.supported === true && g.trap_record === 'flagged' && g.trap_ratio === 'fell' && g.separated === false, g);
check('grade: a field missing is no grade', A.parseGrade('{"supported":true,"trap_record":"avoided","trap_ratio":"avoided","separated":true}') === null);
check('grade: a value outside the rubric is no grade', A.parseGrade('{"supported":true,"trap_record":"maybe","trap_ratio":"avoided","trap_counterfactual":"avoided","separated":true}') === null);
check('grade: a string for a true/false field is no grade', A.parseGrade('{"supported":"yes","trap_record":"avoided","trap_ratio":"avoided","trap_counterfactual":"avoided","separated":true}') === null);
check('grade: no JSON is no grade', A.parseGrade('The answer is good.') === null && A.parseGrade('') === null);
check('grade: the first valid object wins over a broken one', A.parseGrade(`{"supported": tru} ${good}`)?.trap_record === 'flagged');

// ---------- 2. Records read ----------
const t = (name, args) => A.recordsTouched(name, args);
check('records: read_file of one record', [...t('read_file', { path: 'records/J-7781.json' }).files].join() === 'J-7781.json' && !t('read_file', { path: 'records/J-7781.json' }).broad);
check('records: cat of two named records', t('bash', { command: 'cat records/J-7781.json records/J-7718.json' }).files.size === 2);
check('records: cat over a glob is a broad read', t('bash', { command: 'cat records/*.json | head -400' }).broad && t('bash', { command: 'for f in records/*; do jq . "$f"; done' }).broad);
check('records: a grep that lists matches is not a read', !t('bash', { command: 'grep -l timeout records/*.json' }).broad && t('grep', { pattern: 'J-7781', path: 'records' }).files.size === 0);
check('records: other files do not count', t('read_file', { path: 'logs/delivery.log' }).files.size === 0);

// ---------- 3. A run from its history log ----------
const rec = (seq, t, type, data) => JSON.stringify({ v: 1, seq, t, type, data });
const lines = [
  rec(1, 1000, 'run.start', { origin: 'user' }),
  rec(2, 1001, 'message.append', { index: 0, message: { role: 'user', content: 'q' } }),
  rec(3, 2000, 'message.append', { index: 1, message: { role: 'assistant', content: '', tool_calls: [] } }),
  rec(4, 2001, 'usage', { promptTokens: 5000, completionTokens: 100, cacheReadTokens: 4000, cacheWriteTokens: 0 }),
  rec(5, 2002, 'tool.start', { id: 'a', name: 'read_file', args: { path: 'records/J-7781.json' } }),
  rec(6, 2003, 'tool.start', { id: 'b', name: 'bash', args: { command: 'cat records/*.json' } }),
  rec(7, 2004, 'tool.start', { id: 'c', name: 'read_file', args: { path: 'records/J-7781.json' } }),
  rec(8, 4000, 'message.append', { index: 5, message: { role: 'assistant', content: 'Final answer.' } }),
  rec(9, 4001, 'usage', { promptTokens: 6000, completionTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 500 }),
  rec(10, 4500, 'run.end', { reason: 'done', text: 'Final answer.' }),
  '',
];
const h = A.parseHistory(lines);
check('history: wall time, turns, tool calls, per turn', h.wallMs === 3500 && h.turns === 2 && h.toolCalls === 3 && h.toolsPerTurn === 1.5, h);
check('history: distinct records read, broad reads', h.recordsRead === 1 && h.broadReads === 1);
check('history: tokens summed, the answer from run.end', h.usage.prompt === 11000 && h.usage.completion === 400 && h.usage.cacheRead === 9000 && h.usage.cacheWrite === 500 && h.answer === 'Final answer.' && h.endReason === 'done');
const noEnd = A.parseHistory(lines.slice(0, 8));
check('history: no run.end: no wall time, the last assistant text', noEnd.wallMs === null && noEnd.answer === 'Final answer.');
// Haiku 5.5: uncached 1500 at 0.10, reads 9000 at 0.01, writes 500 at 0.125, out 400 at 0.50 (per million)
check('cost: from the history counts, cache split out', Math.abs(A.runCost(h.usage, 'claude-haiku-5-5') - (1500 * 0.1 + 9000 * 0.01 + 500 * 0.125 + 400 * 0.5) / 1e6) < 1e-12 && A.runCost(h.usage, 'mock-model') === null);

// ---------- 4. The report ----------
const rows = [
  { run: 1, wallMs: 3500, turns: 2, toolCalls: 3, toolsPerTurn: 1.5, recordsRead: 1, broadReads: 0, usage: h.usage, cost: 0.001, grade: A.parseGrade(good) },
  { run: 2, wallMs: 5000, turns: 4, toolCalls: 6, toolsPerTurn: 1.5, recordsRead: 36, broadReads: 1, usage: h.usage, cost: 0.002, grade: null },
];
const md = A.report(rows, { model: 'm', grader: 'g', turns: 30 });
check('report: a row per run, medians, grade counts with the ungraded', md.split('\n').filter((l) => /^\| [12] \|/.test(l)).length === 2 && /Medians: wall 3\.50 s/.test(md) && /supported 1\/1/.test(md) && /ratio trap passed 0\/1/.test(md) && /ungraded 1/.test(md), md);

// ---------- 5. The fixture holds what the reference says ----------
const dir = A.FIXTURE;
const records = fs.readdirSync(path.join(dir, 'records')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'records', f), 'utf8')));
const day = records.filter((r) => r.createdAt.startsWith('2026-10-14'));
const failed = day.filter((r) => r.final === 'failed');
const j = records.find((r) => r.job === 'J-7781');
check('fixture: J-7781 failed after three timeouts at the 2000 ms limit', j && j.final === 'failed' && j.attempts.length === 3 && j.attempts.every((a) => a.outcome === 'timeout' && a.ms === 2000) && JSON.parse(fs.readFileSync(path.join(dir, 'config', 'delivery.json'), 'utf8')).timeoutMs === 2000);
check('fixture: 30 jobs on 14 October, 10 failed, 6 by timeout (all real), 4 test jobs by http_500', day.length === 30 && failed.length === 10 && failed.filter((r) => r.cause === 'timeout' && !r.test).length === 6 && failed.filter((r) => r.test && r.cause === 'http_500').length === 4 && day.filter((r) => !r.test).length === 24);
check('fixture: the lookalike is another job of the same subscriber, a day earlier', records.some((r) => r.job === 'J-7718' && r.subscriber === 'sub-0193' && r.createdAt.startsWith('2026-10-13') && r.final === 'failed'));
check('fixture: the log agrees with the records', (fs.readFileSync(path.join(dir, 'logs', 'delivery.log'), 'utf8').match(/final=failed/g) || []).length === records.filter((r) => r.final === 'failed').length);
check('fixture: the reference and the rubric stay out of the project the agent gets', !fs.readdirSync(dir).some((f) => /reference|rubric|truth|expected/i.test(f)) && !JSON.stringify(records).includes('trap'));
check('fixture: hosts are example domains only', records.every((r) => /\.example\.com\//.test(r.endpoint)));

done();
