// Visible progress for long steps and the records behind the session report:
//   1  StreamActivity (src/main/agent/progress.ts) on a hand-moved clock: input_progress as soon as a call's name is
//      known and then at most once a second; stream_idle after 30 s with no content, counting from the last content,
//      with the drop time, "pings" while keep-alive data arrives, cleared by content and by the attempt's end
//   2  both stream paths (OpenAI-compatible and Anthropic's native one) against the mock model: a tool call's input
//      written in pieces gives growing input_progress events before its tool_start; a silent stream gives stream_idle
//      and its clearing before the first text; keep-alive data says "pings"; nothing of the input is in the events
//   3  a failed attempt's kind and time: a busy provider and a silent stream (idle), in retry_status and the timing record
//   4  the real app in Auto mode: check_status around the safety check, and the history log's new records (run.start's
//      timing id, check, question.request and .resolved, retry, compaction.start), the timing log on by default and
//      tied to the session by that id, ask_user's wait as its own number, /report on the session; secrets planted in
//      the prompt, the command, the question, the answer, the folder and the title reach none of them
//   5  the phone's stream drops the new events (desktop chrome)
// Run: node test/run-visibility.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { StreamActivity, progressTiming, SILENCE_MS, PROGRESS_EVERY_MS } = dist('agent/progress.js');
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const R = dist('agent/retry.js');
const { createApp } = dist('app.js');
const { createHistory } = dist('history/service.js');
const { ArtifactStore } = dist('artifacts.js');
const { setupReport } = dist('report-service.js');
const { remoteEvent } = dist('remote/sanitize.js');
const { startMock, askUserReply, classifierReply } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Timers on a clock the test moves by hand. */
function handClock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const h = { at: t + ms, fn };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

(async () => {
  // ---------- 1: StreamActivity on a hand-moved clock ----------
  {
    check('1: the limits: a silence shows after 30 s, progress at most once a second', SILENCE_MS === 30_000 && PROGRESS_EVERY_MS === 1000);
    const c = handClock();
    const evs = [];
    const a = new StreamActivity((ev) => evs.push(ev), c);
    a.start();
    a.dropAfter(300_000);
    a.toolInput(0, '', 40);
    check('1: no progress before the call has a name', evs.length === 0);
    a.toolInput(0, 'write_file', 60);
    check('1: the name known: progress at once, with the characters so far, nothing else', evs.length === 1 && JSON.stringify(evs[0]) === JSON.stringify({ type: 'input_progress', name: 'write_file', chars: 100 }), evs);
    c.advance(400);
    a.toolInput(0, '', 5000);
    check('1: within the second: nothing more', evs.length === 1);
    c.advance(600);
    a.toolInput(0, '', 5000);
    check('1: a second later: the size so far', evs.length === 2 && evs[1].chars === 10_100, evs[1]);
    a.toolInput(1, 'bash', 30);
    check('1: the next call of the reply: at once, with its own name and size', evs.length === 3 && evs[2].name === 'bash' && evs[2].chars === 30, evs[2]);
    evs.length = 0;
    c.advance(29_999);
    check('1: 29.999 s after the last content: no silence yet', evs.length === 0, evs);
    c.advance(1);
    check('1: at 30 s: stream_idle with the silence so far and the drop time', evs.length === 1 && evs[0].type === 'stream_idle' && evs[0].ms === 30_000 && evs[0].dropMs === 300_000 && !evs[0].pings, evs);
    c.advance(20_000);
    check('1: it is sent once; the window counts up by itself', evs.length === 1, evs.length);
    a.content();
    check('1: content clears it', evs.length === 2 && evs[1].type === 'stream_idle' && evs[1].ms === null);
    evs.length = 0;
    // Keep-alive data after the last content: the line says the connection is open instead of when it is dropped
    c.advance(20_000);
    a.event();
    c.advance(10_000);
    check('1: keep-alive data during a silence: "pings", the silence still counted from the last content', evs.length === 1 && evs[0].ms === 30_000 && evs[0].pings === true, evs);
    c.advance(5_000);
    check('1: …15 s after the last keep-alive: sent again without pings (the drop may come)', evs.length === 2 && evs[1].ms === 35_000 && !evs[1].pings, evs);
    c.advance(5_000);
    a.event();
    c.advance(5_000);
    check('1: …and with pings when they come again', evs.length === 3 && evs[2].ms === 45_000 && evs[2].pings === true, evs[2]);
    a.stop();
    check('1: the attempt ended: the silence is cleared', evs.length === 4 && evs[3].ms === null);
    c.advance(120_000);
    a.toolInput(0, 'bash', 10);
    a.content();
    check('1: nothing after stop', evs.length === 4, evs.slice(4));
    // One early event without content (the reply's start) is not keep-alive data
    evs.length = 0;
    const e = new StreamActivity((ev) => evs.push(ev), c);
    e.start();
    c.advance(1000);
    e.event();
    c.advance(29_000);
    check('1: one early event without content: not "pings"', evs.length === 1 && evs[0].ms === 30_000 && !evs[0].pings, evs);
    e.stop();
    // A new attempt starts over; without a drop (a non-streamed request, Ollama) no drop time is given
    evs.length = 0;
    const b = new StreamActivity((ev) => evs.push(ev), c);
    b.start();
    c.advance(31_000);
    check('1: a request with no idle limit: stream_idle without dropMs', evs.length === 1 && evs[0].ms === 30_000 && !('dropMs' in evs[0]), evs);
    b.start();
    check('1: a new attempt clears the old one', evs.length === 2 && evs[1].ms === null);
    b.stop();
  }

  // ---------- 2: both stream paths against the mock ----------
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-visibility-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const work = path.join(tmp, 'falcon-secret-dir');
  fs.mkdirSync(work);
  const base = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock-model', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: work, permissionMode: 'bypass', autoApprove: true, maxTurns: 8, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, pruneToolResults: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  const native = { ...base, provider: 'claude', providers: { claude: { type: 'anthropic', baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'sk-test-native', model: 'claude-haiku-5-5', headers: {} } } };
  const runOn = async (config, prompt) => {
    const events = [];
    const store = new SessionStore(path.join(tmp, `sessions-${Math.random().toString(36).slice(2, 8)}`));
    const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], (ev) => events.push(ev));
    await agent.run(prompt);
    return { events, agent };
  };
  const BIG = 'FILE-SECRET-CONTENT '.repeat(2000); // 40 KB
  progressTiming.everyMs = 100;
  for (const [label, config] of [
    ['OpenAI-compatible', base],
    ['native Anthropic', native],
  ]) {
    state.replies.push({ content: '', toolCalls: [{ id: `w-${label.length}`, name: 'write_file', args: { path: 'out.txt', content: BIG } }], argChunks: 20, chunkDelayMs: 25 }, { content: 'Written.' });
    const { events } = await runOn(config, 'Write the file.');
    const prog = events.filter((e) => e.type === 'input_progress');
    const startAt = events.findIndex((e) => e.type === 'tool_start');
    const lastProg = events.lastIndexOf(prog[prog.length - 1]);
    check(`2 ${label}: input_progress while the input is written, with its name, growing in size`, prog.length >= 3 && prog.every((e) => e.name === 'write_file') && prog.every((e, i) => i === 0 || e.chars > prog[i - 1].chars), prog.map((e) => e.chars));
    check(`2 ${label}: …throttled (fewer events than pieces) and all before the call's row`, prog.length < 20 && lastProg < startAt && startAt > 0, { n: prog.length, lastProg, startAt });
    check(`2 ${label}: …only the name and a number: nothing of the input`, prog.every((e) => Object.keys(e).sort().join() === 'chars,name,type') && !JSON.stringify(prog).includes('SECRET'));
    check(`2 ${label}: …the size is the input's, about 40 KB at the end`, prog[prog.length - 1].chars > 20_000 && prog[prog.length - 1].chars <= JSON.stringify({ path: 'out.txt', content: BIG }).length, prog[prog.length - 1].chars);
  }
  progressTiming.everyMs = PROGRESS_EVERY_MS;

  progressTiming.silenceMs = 150;
  progressTiming.recheckMs = 40;
  for (const [label, config] of [
    ['OpenAI-compatible', base],
    ['native Anthropic', native],
  ]) {
    state.replies.push({ content: 'After a pause.', silenceMs: 600 });
    let { events } = await runOn(config, 'Think hard.');
    let idle = events.filter((e) => e.type === 'stream_idle');
    const firstText = events.findIndex((e) => e.type === 'text_delta');
    check(`2 ${label}: a silent stream: stream_idle with the silence so far and the drop limit, then cleared before the text`, idle.length === 2 && idle[0].ms >= 150 && idle[0].dropMs === R.STREAM_IDLE_MS && !idle[0].pings && idle[1].ms === null && events.indexOf(idle[1]) < firstText, idle);
    state.replies.push({ content: 'Still here.', silenceMs: 600, pingMs: 30 });
    ({ events } = await runOn(config, 'Think again.'));
    idle = events.filter((e) => e.type === 'stream_idle');
    if (config === base) check(`2 ${label}: keep-alive data during the silence: "pings" (the drop is not coming)`, idle.length >= 2 && idle[0].pings === true && idle[idle.length - 1].ms === null, idle);
    // The Anthropic SDK drops the API's ping events before the stream reaches us: they neither reset the idle limit
    // nor show, so the line keeps the drop time, which is then the truth
    else check(`2 ${label}: the API's ping events never reach the reader (the SDK drops them): no "pings", the drop time stays`, idle.length >= 2 && idle.every((e) => !e.pings) && idle[0].dropMs === R.STREAM_IDLE_MS && idle[idle.length - 1].ms === null, idle);
  }
  state.replies.push({ content: 'Quick.' });
  const quick = await runOn(base, 'Be quick.');
  check('2: a quick reply: no silence, no progress', !quick.events.some((e) => e.type === 'stream_idle' || e.type === 'input_progress'));
  progressTiming.silenceMs = SILENCE_MS;
  progressTiming.recheckMs = 5000;

  // ---------- 3: failed attempts: their kind and time ----------
  R.retryTiming.sleep = async () => {};
  state.replies.push({ status: 503 }, { content: 'Back.' });
  let r3 = await runOn(base, 'Try.');
  let retry = r3.events.find((e) => e.type === 'retry_status' && e.text);
  let turn = r3.agent.lastTiming().turns[0];
  check('3: a busy provider: retry_status carries the retry in numbers and a fixed word', retry && retry.retry.attempt === 2 && retry.retry.kind === 'busy' && typeof retry.retry.waitMs === 'number' && typeof retry.retry.ranMs === 'number', retry);
  check('3: …and the timing record has the failed attempt with its time and kind', turn.failedAttempts?.length === 1 && turn.failedAttempts[0].kind === 'busy' && turn.failedAttempts[0].ms >= 0 && turn.attempts === 2 && r3.agent.lastTiming().summary.failedAttempts === 1, turn.failedAttempts);
  R.retryTiming.idleMs = 150;
  state.replies.push({ content: 'Never seen.', silenceMs: 500 }, { content: 'Back again.' });
  r3 = await runOn(base, 'Try again.');
  retry = r3.events.find((e) => e.type === 'retry_status' && e.text);
  turn = r3.agent.lastTiming().turns[0];
  check('3: a stream silent past the idle limit: kind "idle", the failed attempt about as long as the limit', retry?.retry.kind === 'idle' && turn.failedAttempts?.[0]?.kind === 'idle' && turn.failedAttempts[0].ms >= 140 && turn.failedAttempts[0].ms < 450, { retry: retry?.retry, failed: turn.failedAttempts });
  R.retryTiming.idleMs = R.STREAM_IDLE_MS;
  check('3: the retry kinds in words: a 429, a 529, a refused connection, a long request, anything else', R.failureKind({ status: 429 }) === 'rate_limited' && R.failureKind({ status: 529 }) === 'busy' && R.failureKind(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })) === 'connection' && R.failureKind(new R.StreamDropped()) === 'connection' && R.failureKind(new R.StreamDropped('x', true)) === 'idle' && R.failureKind(Object.assign(new Error('prompt is too long: 300000 tokens > 200000 maximum'), { status: 400 })) === 'too_long' && R.failureKind({ status: 401 }) === 'other');

  // ---------- 4: the real app in Auto mode: check_status, the history records, the timing log, /report ----------
  const userData = path.join(tmp, 'ud');
  let cfg = { ...base, permissionMode: 'auto', autoApprove: false };
  const app = createApp({ userData, appRoot: projectDir, loadConfig: () => cfg, saveConfig: (c) => (cfg = c), artifacts: new ArtifactStore({ root: path.join(userData, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }) });
  app.setWindow({ isDestroyed: () => false, webContents: { send: () => {} } });
  const history = createHistory(app, { noticeDelayMs: 5 });
  const rt = app.runtime;
  const events = [];
  app.events.on((sid, ev) => events.push(ev));
  const A = rt.foregroundId();
  // A command that is not read-only (a redirect): Auto mode's check decides, after a pause
  state.replies.push(
    { content: 'Writing it.', toolCalls: [{ id: 'b1', name: 'bash', args: { command: 'echo CMD-SECRET-TOKEN > notes.txt' } }] },
    classifierReply('allow', 'part of the task', { delayMs: 150 }),
    askUserReply([{ question: 'QUESTION-SECRET which one?', header: 'Pick', options: [{ label: 'One', description: 'the first' }, { label: 'Two', description: 'the second' }], multiSelect: false }], { id: 'q1' }),
    { status: 503 },
    { content: 'Done with PROMPT-SECRET.' },
  );
  rt.send(A, 'PROMPT-SECRET: write the notes for https://internal.example.com/x');
  const card = await waitFor(() => events.find((e) => e.type === 'question_request'), 8000, 'the question card');
  await sleep(120);
  rt.respondQuestion(card.id, [{ selected: ['Two'], other: 'ANSWER-SECRET' }]);
  await waitFor(() => !rt.isRunning(A), 8000, 'the run');
  const checks = events.filter((e) => e.type === 'check_status');
  check('4: check_status: running before the verdict, then its time and verdict, for the call', checks.length === 2 && checks[0].running === true && checks[0].id === 'b1' && checks[1].running === false && checks[1].id === 'b1' && checks[1].verdict === 'allow' && checks[1].ms >= 140 && !checks[1].timedOut, checks);
  const bashStart = events.findIndex((e) => e.type === 'tool_start' && e.id === 'b1');
  const bashEnd = events.findIndex((e) => e.type === 'tool_end' && e.id === 'b1');
  check('4: …inside the call\'s row (after tool_start, before tool_end)', bashStart >= 0 && events.indexOf(checks[0]) > bashStart && events.indexOf(checks[1]) < bashEnd);
  const recs = history.log.read(A);
  const one = (type) => recs.filter((r) => r.type === type);
  const timing = rt.agentFor(A).lastTiming();
  const runStart = one('run.start')[0];
  check('4: run.start keeps the run\'s timing id, which is the timing record\'s', /^[0-9a-f]{8}$/.test(runStart?.data.timing) && runStart.data.timing === timing.run && runStart.data.origin === 'user', runStart?.data);
  const ck = one('check');
  check('4: a check record: its time, verdict and timeout, nothing else', ck.length === 1 && Object.keys(ck[0].data).sort().join() === 'ms,timedOut,verdict' && ck[0].data.verdict === 'allow' && ck[0].data.ms >= 140 && ck[0].data.timedOut === false, ck.map((r) => r.data));
  const qr = one('question.request');
  const qs = one('question.resolved');
  check('4: question records: how many questions, and answered or skipped', qr.length === 1 && JSON.stringify(qr[0].data) === '{"count":1}' && qs.length === 1 && JSON.stringify(qs[0].data) === '{"outcome":"answered"}' && qs[0].t - qr[0].t >= 100);
  const rr = one('retry');
  check('4: a retry record: the attempt coming, the wait, how long the failed one ran, why', rr.length === 1 && Object.keys(rr[0].data).sort().join() === 'attempt,kind,ranMs,waitMs' && rr[0].data.attempt === 2 && rr[0].data.kind === 'busy', rr.map((r) => r.data));
  const order = recs.map((r) => r.type);
  check('4: the records come in order: check before the command ends, the retry before the last usage', order.indexOf('check') < order.indexOf('tool.end') && order.indexOf('retry') < order.lastIndexOf('usage'));
  const bashTool = timing.tools.find((t) => t.name === 'bash');
  const askTool = timing.tools.find((t) => t.name === 'ask_user');
  const asked = askTool?.permission.find((p) => p.path === 'question');
  check('4: the timing record: the check on the command, the question as its own number, not tool time', bashTool?.permission.some((p) => p.path === 'check' && p.checkMs >= 140 && p.check === 'allow') && asked && asked.humanMs >= 100 && timing.summary.questionsMs >= 100 && askTool.execMs < asked.humanMs, { questionsMs: timing.summary.questionsMs, asked, exec: askTool?.execMs });
  const logFile = path.join(userData, 'timing', 'timing.jsonl');
  await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').trim(), 4000, 'the timing log');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('4: the timing log is written by default, and its line is found by run.start\'s id', lines.some((l) => l.run === runStart.data.timing));
  // The manual compaction: its start is recorded
  state.summary = 'The user asked for notes; they were written, a question was answered, and the provider was busy once.';
  const compacted = await rt.agentFor(A).compactNow();
  const cs = one('compaction.start').length ? one('compaction.start') : history.log.read(A).filter((r) => r.type === 'compaction.start');
  check('4: a compaction\'s start is recorded with its reason, before the compaction', compacted.ok && cs.length === 1 && JSON.stringify(cs[0].data) === '{"reason":"manual"}' && history.log.read(A).findIndex((r) => r.type === 'compaction') > history.log.read(A).findIndex((r) => r.type === 'compaction.start'), { compacted, cs: cs.map((r) => r.data) });
  // /report on the session
  rt.agentFor(A).session.title = 'TITLE-SECRET';
  const reportCmd = (() => {
    let found = null;
    const probe = { commands: { register: (c) => (found = c) }, service: (n) => app.service(n) };
    setupReport(probe);
    return found;
  })();
  const report = (await reportCmd.run('', { sessionId: A })).card;
  console.log(report.replace(/^/gm, '    '));
  check('4: /report reads the log: the check, the retry, the question, the compaction', /\*\*Safety checks\*\* 1, /.test(report) && /- allow 1/.test(report) && /\*\*Retries\*\* 1, /.test(report) && /- why: busy 1/.test(report) && /- questions: 1, /.test(report) && !/\(from the ask_user calls\)/.test(report) && /\*\*Compactions\*\* 1/.test(report), report);
  const SECRETS = ['PROMPT-SECRET', 'CMD-SECRET-TOKEN', 'QUESTION-SECRET', 'ANSWER-SECRET', 'falcon-secret-dir', 'TITLE-SECRET', 'internal.example.com', 'notes.txt'];
  const newRecords = JSON.stringify(history.log.read(A).filter((r) => ['run.start', 'run.end', 'check', 'retry', 'question.request', 'question.resolved', 'compaction.start', 'usage', 'tool.end'].includes(r.type)).map((r) => (r.type === 'run.end' ? { reason: r.data.reason } : r.type === 'tool.end' ? { ok: r.data.ok, durationMs: r.data.durationMs } : r.data)));
  const leaked = (text) => SECRETS.filter((s) => text.includes(s));
  check('4: the planted secrets reach none of the new records, the timing log or the report', leaked(newRecords).length === 0 && leaked(fs.readFileSync(logFile, 'utf8')).length === 0 && leaked(report).length === 0, { records: leaked(newRecords), log: leaked(fs.readFileSync(logFile, 'utf8')), report: leaked(report) });
  check('4: the new history records are numbers and fixed words only', history.log.read(A).filter((r) => ['check', 'retry', 'question.request', 'question.resolved', 'compaction.start'].includes(r.type)).every((r) => Object.values(r.data).every((v) => typeof v === 'number' || typeof v === 'boolean' || ['allow', 'block', 'ask', 'error', 'stopped', 'idle', 'connection', 'rate_limited', 'busy', 'too_long', 'other', 'answered', 'skipped', 'auto', 'manual'].includes(v))));
  // A timingLog of false turns the file off
  app.updateConfig({ timingLog: false });
  const before = fs.readFileSync(logFile, 'utf8').length;
  state.replies.push({ content: 'Quiet.' });
  rt.send(A, 'once more');
  await waitFor(() => !rt.isRunning(A), 8000, 'the quiet run');
  await sleep(100);
  check('4: timingLog false: no line is added', fs.readFileSync(logFile, 'utf8').length === before);
  // Whatever these events carry, the history log keeps only numbers and fixed words of them
  const n0 = history.log.read(A).length;
  rt.emit(A, { type: 'check_status', id: 'PLANTED-ID', running: false, ms: 'sk-ant-PLANTED', verdict: 'Project PLANTED', timedOut: 'yes' });
  rt.emit(A, { type: 'retry_status', text: 'PLANTED text', retry: { attempt: 'x', waitMs: -5, ranMs: 'PLANTED', kind: 'PLANTED-kind' } });
  rt.emit(A, { type: 'question_request', id: 'PLANTED-q', questions: [{ question: 'PLANTED-Q' }, { question: 'PLANTED-Q2' }] });
  rt.emit(A, { type: 'question_resolved', id: 'PLANTED-q', skipped: true });
  rt.emit(A, { type: 'compact_start', reason: 'PLANTED' });
  rt.emit(A, { type: 'input_progress', name: 'PLANTED-tool', chars: 5 });
  rt.emit(A, { type: 'stream_idle', ms: 31000 });
  rt.emit(A, { type: 'run_start', timing: 'PLANTED-timing' });
  rt.emit(A, { type: 'user_message', text: 'PLANTED-U', images: 0, origin: 'user' });
  rt.emit(A, { type: 'run_end', reason: 'done' });
  const planted = history.log.read(A).slice(n0);
  check('4: planted values in the events: none in the records, each field a number or a fixed word', !JSON.stringify(planted).includes('PLANTED') && JSON.stringify(planted.map((r) => [r.type, r.data])) === JSON.stringify([['check', { ms: 0, verdict: 'error', timedOut: false }], ['retry', { attempt: 0, waitMs: 0, ranMs: 0, kind: 'other' }], ['question.request', { count: 2 }], ['question.resolved', { outcome: 'skipped' }], ['compaction.start', { reason: 'auto' }], ['run.start', { origin: 'user' }], ['run.end', { reason: 'done' }]]), planted.map((r) => [r.type, r.data]));
  history.dispose();

  // ---------- 5: the phone ----------
  check('5: the phone\'s stream drops the progress events and keeps the retry line', remoteEvent({ type: 'input_progress', name: 'bash', chars: 10 }) === null && remoteEvent({ type: 'stream_idle', ms: 31000, dropMs: 300000 }) === null && remoteEvent({ type: 'check_status', id: 'x', running: true }) === null && remoteEvent({ type: 'retry_status', text: 'Provider busy.', retry: { attempt: 2, waitMs: 1000, kind: 'busy' } })?.text === 'Provider busy.');

  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
