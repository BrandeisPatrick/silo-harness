// The fold over a turn's working process: what counts as process and what is the final answer, the header's words
// (src/renderer/turn-fold-model.ts), and the time each turn worked, kept with the session (Session.turnTimes): the
// agent records it per turn, the transcript hands it to the window on the user message, a rewind drops the times of
// the turns it removed, a fork and a compaction keep them, and nothing of it reaches the model.
// Run: node test/turn-fold.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

(async () => {
  // ---------- The pure part (turn-fold-model.js imports nothing, so it loads as a data: module) ----------
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/turn-fold-model.js'), 'utf8');
  const { elapsedText, headText, nodeKind, turnShape, foldsWhenDone } = await import('data:text/javascript,' + encodeURIComponent(src));

  check('time: seconds', elapsedText(0) === '0s' && elapsedText(18_400) === '18s' && elapsedText(59_999) === '59s');
  check('time: minutes as the status line writes them', elapsedText(60_000) === '1m 00s' && elapsedText(65_000) === '1m 05s' && elapsedText(3_725_000) === '62m 05s', elapsedText(65_000));
  check('header while running', headText(true, 18_000) === 'Working for 18s');
  check('header after', headText(false, 53_000) === 'Worked for 53s' && headText(false, 0) === 'Worked for 0s');
  check('header of a stored turn without its time', headText(false, undefined) === 'Worked' && headText(false, NaN) === 'Worked' && headText(false, -1) === 'Worked');

  const k = (cls) => nodeKind(cls.split(' '));
  check('calls: rows, groups, sent messages', k('tool') === 'call' && k('tool groupable mcp') === 'call' && k('tool-group live') === 'call' && k('session-msg sent') === 'call', [k('tool'), k('tool-group'), k('session-msg sent')]);
  check('a call Auto mode blocked stays in sight (its Allow waits for the user)', k('auto-blocked') === 'keep');
  check('replies are text', k('msg assistant') === 'text' && k('msg assistant fade-in') === 'text');
  check('thinking and decided approvals are process', k('thinking') === 'process' && k('approval done') === 'process');
  check('never process: a waiting approval or question, notices, errors, cards, images, plans, compaction, received messages', ['approval', 'question-card prompt-card', 'msg system', 'msg system error', 'msg system notice', 'chat-cards', 'reply-images', 'plan-card', 'compaction', 'session-msg received msg user', 'mod-offer'].every((c) => k(c) === 'keep'), ['approval', 'msg system', 'chat-cards', 'compaction'].map(k));

  // text, call, text, thinking, call, notice, thinking, text (the answer), cards
  let s = turnShape(['text', 'call', 'text', 'process', 'call', 'keep', 'process', 'text', 'keep']);
  check('the answer is the reply after the last call', s.hasCall && s.hasAnswer);
  check('process: interim replies, calls, thinking (also right before the answer); kept: notices, the answer, cards', JSON.stringify(s.process) === JSON.stringify([true, true, true, true, true, false, true, false, false]), s.process);
  s = turnShape(['text', 'call', 'text', 'call']);
  check('a turn that ended on a call has no answer', s.hasCall && !s.hasAnswer && s.process.every(Boolean));
  s = turnShape(['process', 'text']);
  check('a plain reply (thinking then text) makes no call: no header, nothing folds', !s.hasCall && !s.hasAnswer && s.process[0] === true && s.process[1] === false);
  s = turnShape(['call', 'keep', 'keep']);
  check('an interrupted turn ("Interrupted." after a call) has no answer', !s.hasAnswer);
  const full = turnShape(['text', 'call', 'text']);
  check('folds when done with an answer (Summary)', foldsWhenDone(full, true, 'done') && foldsWhenDone(full, true, 'plan') && foldsWhenDone(full, true));
  check('does not fold when interrupted or failed, or with Every call', !foldsWhenDone(full, true, 'aborted') && !foldsWhenDone(full, true, 'error') && !foldsWhenDone(full, true, 'max_turns') && !foldsWhenDone(full, false, 'done'));
  check('does not fold without an answer or a call', !foldsWhenDone(turnShape(['text', 'call']), true, 'done') && !foldsWhenDone(turnShape(['text']), true, 'done'));

  // ---------- The stored time ----------
  const { Agent } = require(path.join(projectDir, 'dist/main/agent.js'));
  const { SessionStore, toTranscript, rewindSession, shownUserCount, pruneTurnTimes } = require(path.join(projectDir, 'dist/main/sessions.js'));
  const { startMock } = require('./support/mock-model.js');
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-turn-fold-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'The code word is falcon.');
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: cwd, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [], toolSet: 'auto',
  };
  const events = [];
  const agent = new Agent(() => config, { navigate: async (u) => u }, store, () => [], (ev) => events.push(ev));
  agent.session = store.create({ cwd });
  const sess = () => agent.session;
  const users = () => toTranscript(sess()).filter((i) => i.role === 'user');

  // Turn 0: a call held back 600 ms, then the answer
  state.replies.push({ content: '', toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'notes.txt' } }], delayMs: 600 });
  state.replies.push({ content: 'The code word is falcon. ' + 'Here is a long explanation of it. '.repeat(200) });
  await agent.run('Read notes.txt');
  const t0 = sess().turnTimes?.[0];
  check('the run recorded how long its turn worked', typeof t0 === 'number' && t0 >= 550 && t0 < 10_000, sess().turnTimes);
  check('the transcript hands the time to the window on the user message', users()[0].worked === t0, users()[0]);

  // Turn 1 and 2 in one run: a message delivered during the run starts a turn of its own
  state.replies.push({ content: '', toolCalls: [{ id: 'r2', name: 'read_file', args: { path: 'notes.txt' } }], delayMs: 500 });
  state.replies.push({ content: 'Read it again.', delayMs: 300 });
  state.replies.push({ content: 'Second answer. ' + 'More words about it. '.repeat(200) });
  const running = agent.run('Read it again');
  await new Promise((r) => setTimeout(r, 150));
  agent.enqueue('And then say goodbye');
  await running;
  const tt = sess().turnTimes ?? {};
  check('two turns of one run: each keyed by its user message', Object.keys(tt).sort().join(',') === '0,1,2' && tt[1] > 0 && tt[2] >= 0, tt);
  check('the transcript lists all three with their times', users().length === 3 && users().every((u, i) => u.worked === tt[i]), users().map((u) => u.worked));
  check('shownUserCount counts the shown user messages', shownUserCount(sess()) === 3);

  // Nothing of it goes to the model
  const sent = JSON.stringify(state.requests.map((r) => r.payload));
  check('no request carries the times', !/turnTimes|"worked"/.test(sent));
  check('the stored messages carry no new field', sess().messages.every((m) => !('worked' in m) && !('turnTimes' in m)));

  // Saved with the session, and kept by a fork
  const saved = JSON.parse(fs.readFileSync(store.file(sess().id), 'utf8'));
  check('saved with the session', JSON.stringify(saved.turnTimes) === JSON.stringify(tt), saved.turnTimes);
  const fork = store.fork(sess().id);
  check('a fork keeps the times (a copy)', JSON.stringify(fork.turnTimes) === JSON.stringify(tt) && fork.turnTimes !== sess().turnTimes);

  // A compaction keeps each turn's time on the same message
  state.summary = '## 1. Request and intent\nRead notes.txt and remember the code word (falcon).\n\n## 8. Next step\n(none)';
  const compacted = await agent.compactNow();
  check('compaction happened', (sess().compactions ?? []).length === 1, compacted);
  check('after a compaction the same user messages have the same times', users().length === 3 && users().every((u, i) => u.worked === tt[i]) && shownUserCount(sess()) === 3, users().map((u) => [u.text, u.worked]));
  state.replies.push({ content: 'Fourth.' });
  await agent.run('One more');
  check('the next turn after a compaction gets the next key', typeof sess().turnTimes?.[3] === 'number' && users()[3].worked === sess().turnTimes[3], sess().turnTimes);

  // A rewind drops the times of the turns it removed
  const live = sess().turns ?? [];
  rewindSession(sess(), cwd, live.length - 1, store);
  check('a rewind drops the time of the removed turn', !('3' in (sess().turnTimes ?? {})) && sess().turnTimes?.[0] === tt[0], sess().turnTimes);
  const bare = { messages: [{ role: 'user', content: 'hi' }], turnTimes: { 0: 5, 1: 6, 7: 8 } };
  pruneTurnTimes(bare);
  check('prune keeps only turns that exist', JSON.stringify(bare.turnTimes) === '{"0":5}', bare.turnTimes);
  const empty = { messages: [], turnTimes: { 0: 1 } };
  pruneTurnTimes(empty);
  check('prune leaves no empty record', !('turnTimes' in empty));

  // An old session without times shows "Worked" alone: its user items have no time
  const old = store.create({ cwd });
  old.messages.push({ role: 'user', content: 'Old question' }, { role: 'assistant', content: 'Old answer' });
  check('an old session: no time on its user items', toTranscript(old).filter((i) => i.role === 'user').every((u) => !('worked' in u)));

  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
