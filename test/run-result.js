// What the history log answers about a run, as Claude Code's log does (headless, the real App against the mock model,
// Auto mode with a check model of its own and user prices): run.start names the model, the provider's label, the
// mode, the sandbox and the app's version; every counted model call has a usage record (the agent's turns, the safety
// check, the title, a compaction summary) with its model, what it was for, how long it took and its dollars; run.end's
// result holds the run's times and counts and totals equal to the sum of its usage records; /report's token line stays
// about the turns, gains one line for the checks, and a Cost line equal to the window's figure only when every price
// is known. Also the two prompt texts: the bash tool's (plain and sandboxed) and the system prompt's closing rule.
// Run: node test/run-result.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { createApp } = dist('app.js');
const { createHistory } = dist('history/service.js');
const { ArtifactStore } = dist('artifacts.js');
const { sessionReport } = dist('history/report.js');
const { replayConversation } = dist('history/replay.js');
const C = dist('cost.js');
const Perf = dist('agent/perf.js');
const { builtInToolNames } = dist('tools/index.js');
const { bash, sandboxBash } = dist('tools/shell.js');
const P = dist('agent/prompt.js');
const { startMock, classifierReply } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

Perf.setBuiltInToolNames(builtInToolNames());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sumOf = (list, f) => list.reduce((a, x) => a + f(x), 0);

(async () => {
  const mock = await startMock();
  const { state } = mock;
  state.summary = 'The user asked for a file; the agent made it. Nothing else is pending.';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-run-result-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  const mockUrl = `http://127.0.0.1:${mock.port}/v1`;
  // Prices large enough that the figures are dollars, not "<$0.01"
  let cfg = {
    provider: 'portkey',
    ollama: { baseURL: 'http://127.0.0.1:1', model: 'm', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: mockUrl, apiKey: 'test', model: 'mock-model', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    providers: {},
    workingDirectory: project, permissionMode: 'auto', autoApprove: false, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: true,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, pruneToolResults: false, notifications: false, allowRules: {}, recentDirs: [], historyTrashDays: 30,
    autoMode: { environment: '', allow: [], model: 'check-model' },
    prices: { 'mock-model': { input: 1000, output: 5000 }, 'check-model': { input: 2000, output: 10000 } },
  };
  const userData = path.join(tmp, 'ud');
  const app = createApp({
    userData,
    appRoot: projectDir,
    loadConfig: () => cfg,
    saveConfig: (c) => (cfg = c),
    artifacts: new ArtifactStore({ root: path.join(userData, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }),
  });
  const sent = [];
  app.setWindow({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } });
  const history = createHistory(app, { noticeDelayMs: 5 });
  const rt = app.runtime;
  const recordsOf = (id) => history.log.read(id);
  const usd = (prompt, completion, p) => (prompt * p.input + completion * p.output) / 1e6;
  const TURN = usd(300, 30, cfg.prices['mock-model']);
  const CHECK = usd(200, 20, cfg.prices['check-model']);
  const TITLE = usd(200, 20, cfg.prices['mock-model']);
  const SUMMARY = usd(400, 120, cfg.prices['mock-model']);

  // ---------- 1: a run with a checked call, then its title and a compaction ----------
  const A = rt.foregroundId();
  state.replies.push({ content: 'Making it.', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'touch made.txt' } }] });
  state.replies.push(classifierReply('allow', '[Local Work] makes a file'));
  state.replies.push({ content: 'Made made.txt.' });
  state.replies.push({ nonStream: true, content: 'Make A File', when: (p) => JSON.stringify(p.messages ?? []).includes('You name chat sessions') });
  rt.send(A, 'make a file please');
  await waitFor(() => !rt.isRunning(A) && rt.get(A).title === 'Make A File', 5000, 'the run and its title');
  const compacted = await rt.agentFor(A).compactNow();
  check('1: the compaction ran', compacted.ok, compacted);
  const recs = recordsOf(A);
  const start = recs.find((r) => r.type === 'run.start');
  const end = recs.find((r) => r.type === 'run.end');
  const endAt = recs.indexOf(end);
  const usage = recs.filter((r) => r.type === 'usage');
  const inRun = usage.filter((u) => recs.indexOf(u) < endAt);

  check('1: run.start: the model, the provider\'s label, the mode, the sandbox, the app\'s version', start.data.origin === 'user' && start.data.model === 'mock-model' && typeof start.data.provider === 'string' && start.data.provider.length > 0 && start.data.mode === 'auto' && start.data.sandbox === false && start.data.app === require(path.join(projectDir, 'package.json')).version, start.data);
  check('1: a usage record for every counted call, in order: turn, check, turn, then the title and the compaction', same(usage.map((u) => u.data.for), ['turn', 'check', 'turn', 'title', 'compaction']), usage.map((u) => u.data));
  const checkUse = usage.find((u) => u.data.for === 'check');
  check('1: the check\'s usage record: its own model, its tokens, its time and its dollars', checkUse.data.model === 'check-model' && checkUse.data.promptTokens === 200 && checkUse.data.completionTokens === 20 && Number.isInteger(checkUse.data.ms) && near(checkUse.data.usd, CHECK), checkUse.data);
  check('1: …and it comes right before the check record', recs[recs.indexOf(checkUse) + 1]?.type === 'check');
  check('1: the turns\', title\'s and compaction\'s records: the session model, a time, their dollars', usage.filter((u) => u.data.for !== 'check').every((u) => u.data.model === 'mock-model' && Number.isInteger(u.data.ms) && u.data.ms >= 0) && near(usage[0].data.usd, TURN) && near(usage[3].data.usd, TITLE) && near(usage[4].data.usd, SUMMARY), usage.map((u) => u.data));
  check('1: the title and the compaction come after run.end (not the run\'s calls)', inRun.length === 3);

  const res = end.data.result;
  check('1: run.end\'s result: times and counts', res && res.wallMs > 0 && typeof res.modelMs === 'number' && typeof res.toolMs === 'number' && typeof res.checkMs === 'number' && res.waitMs === 0 && res.modelCalls === 2 && res.toolCalls === 1 && res.checks === 1 && res.blocked === 0 && res.retries === 0, res);
  const want = {
    input: sumOf(inRun, (u) => u.data.promptTokens - (u.data.cacheReadTokens ?? 0) - (u.data.cacheWriteTokens ?? 0)),
    output: sumOf(inRun, (u) => u.data.completionTokens),
    cacheRead: sumOf(inRun, (u) => u.data.cacheReadTokens ?? 0),
    cacheWrite: sumOf(inRun, (u) => u.data.cacheWriteTokens ?? 0),
  };
  check('1: result.tokens is the sum of the run\'s usage records, the check\'s included', same(res.tokens, want) && want.input === 800 && want.output === 80, { tokens: res.tokens, want });
  const per = (model) => inRun.filter((u) => u.data.model === model);
  check('1: result.byModel: calls, tokens and dollars per model, from the same records', res.byModel['mock-model'].calls === per('mock-model').length && res.byModel['check-model'].calls === 1 && res.byModel['mock-model'].input === 600 && res.byModel['check-model'].output === 20 && near(res.byModel['mock-model'].usd, sumOf(per('mock-model'), (u) => u.data.usd)) && near(res.byModel['check-model'].usd, CHECK), res.byModel);
  check('1: result.usd is the sum of the run\'s usage records\' dollars', near(res.usd, sumOf(inRun, (u) => u.data.usd)) && near(res.usd, 2 * TURN + CHECK), res.usd);
  check('1: nothing but numbers, model ids, the label, the mode and booleans in the new fields', !JSON.stringify([start.data, end.data.result, usage.map((u) => u.data)]).match(/touch|made\.txt|make a file|Make A File|127\.0\.0\.1/));
  check('1: the log still replays to the session', same(replayConversation(recs).messages, rt.get(A).messages));

  // /report: the turns' token line as before, one line for the checks, the Cost line equal to the window's figure
  const report = sessionReport(recs);
  const windowLabel = C.costEvent(rt.get(A).cost, cfg.prices).label;
  const lastCost = sent.map((m) => m.find((x) => x && typeof x === 'object' && x.type === 'cost')).filter(Boolean).pop();
  check('1: /report: "Tokens per model call" counts the two turns only', /\*\*Tokens per model call\*\* 2 calls\n- input: 300 min, 300 median, 300 max, 600 total/.test(report), report.match(/\*\*Tokens[\s\S]*?\n\n/)?.[0]);
  check('1: …and one line for the check\'s tokens', /\n- safety checks: 1 call, 200 in, 20 out\n/.test(report), report);
  check('1: …and "Model calls" counts the turns only', /\*\*Model calls\*\* 2,/.test(report), report.match(/\*\*Model calls\*\*.*/)?.[0]);
  check('1: the Cost line is the window\'s figure', windowLabel === '$2.80' && report.includes(`\n**Cost** ${windowLabel}, estimated from list prices`) && (!lastCost || lastCost.label === windowLabel), { windowLabel, lastCost, report: report.match(/\*\*Cost\*\*.*/)?.[0] });

  // ---------- 2: an unpriced check model and a blocked call: no dollars where a price is missing ----------
  delete cfg.prices['check-model'];
  const B = rt.create({}).id;
  rt.setForeground(B);
  state.replies.push({ content: 'Removing it.', toolCalls: [{ id: 'c2', name: 'bash', args: { command: 'rm -rf ~/Documents' } }] });
  state.replies.push(classifierReply('block', '[Destructive] deletes the user\'s documents'));
  state.replies.push({ content: 'That was blocked, so nothing was removed.' });
  rt.send(B, 'clean up');
  await waitFor(() => !rt.isRunning(B), 5000, 'run 2');
  const recsB = recordsOf(B);
  const resB = recsB.find((r) => r.type === 'run.end').data.result;
  const useB = recsB.filter((r) => r.type === 'usage');
  check('2: the check on an unpriced model: its usage record has no dollars', useB.some((u) => u.data.for === 'check' && u.data.model === 'check-model' && !('usd' in u.data)), useB.map((u) => u.data));
  check('2: result: the blocked call counted, no total dollars, the priced model keeps its own', resB.checks === 1 && resB.blocked === 1 && !('usd' in resB) && !('usd' in resB.byModel['check-model']) && near(resB.byModel['mock-model'].usd, 2 * TURN), resB);
  const reportB = sessionReport(recsB);
  check('2: no Cost line when a price is missing (the window shows none either)', !/\*\*Cost\*\*/.test(reportB) && C.costEvent(rt.get(B).cost, cfg.prices).label === undefined, reportB);

  // ---------- 3: the prompt texts ----------
  for (const [name, tool] of [['plain', bash], ['sandboxed', sandboxBash]]) {
    check(`3: the bash tool (${name}) says a call starts in the working directory, so no cd to it, and path starts it elsewhere`, /It starts in the working directory, so no need to cd there; path starts it in another folder\./.test(tool.description) && tool.parameters.properties.path, tool.description);
  }
  const base = P.systemPrompt(cfg, [], null);
  check('3: the closing rule: run the tests after the last change, then a short close that leads with the result', base.includes("- Keep going until the task is done, and after your last change run the tests or the command that shows it works. Then close briefly: the result first, what changed and how you checked it, anything not done or not checked; plain sentences, a few bullets, headings only if long. Do not ask questions you can answer with a tool.") && !base.includes('finish with a short summary of what you did'), base.match(/- Keep going[^\n]*/)?.[0]);

  history.dispose();
  mock.server?.close?.();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
