// "Send now" on a queued message (Agent.sendNow): the current step is cut the way Stop cuts it (a model call in
// flight, a running command, a waiting approval card, a retry wait), the chosen message starts the next run at once,
// the rest of the queue stays queued until after that run's first model call, UserPromptSubmit hooks still see (and
// may refuse) the message, a message no longer queued is a no-op, and through the runtime the session never counts
// as idle in between (MAX_RUNNING, a send in that instant queues). Run: node test/queue-send-now.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const { ArtifactStore } = dist('artifacts.js');
const { createApp } = dist('app.js');
const { MAX_RUNNING } = dist('runtime.js');
const R = dist('agent/retry.js');
const { startMock } = require('./support/mock-model.js');
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

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-sendnow-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'The colour of the made-up door is teal.');
  const config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 8192, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: cwd, permissionMode: 'bypass', autoApprove: true, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const artifacts = new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') });

  // A fake UserPromptSubmit hook: sees every prompt, refuses one with BLOCKME in it, adds a context line otherwise
  const prompts = [];
  let hooksOn = false;
  const hooks = {
    has: (event) => hooksOn && event === 'UserPromptSubmit',
    fire: async (event, ctx) => {
      prompts.push(ctx.fields.prompt);
      await sleep(20);
      if (String(ctx.fields.prompt).includes('BLOCKME')) return { ran: 1, block: 'Not this one (test).', context: [], notices: [] };
      return { ran: 1, context: ['HOOK-CONTEXT-LINE'], notices: [] };
    },
  };
  // A tool that waits for an approval nobody gives, and one that runs until stopped
  const waitsForApproval = {
    name: 'ask_first', description: 'Asks first', parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const a = await ctx.approve('ask_first', 'do the made-up thing', undefined, { custom: true });
      return { content: a.ok ? 'did it' : a.message };
    },
  };
  let events = [];
  /** Called on each event, with the agent's running flag at that moment */
  let onEvent = null;
  const agent = new Agent(() => config, { navigate: async (u) => u }, store, () => [], (ev) => {
    events.push(ev);
    if (onEvent) onEvent(ev);
  }, undefined, artifacts, undefined, { hooks, tools: () => [waitsForApproval] });

  let id = 0;
  const call = (name, args) => ({ id: `c${++id}`, name, args });
  const isNote = (m) => typeof m.content === 'string' && (m.content.startsWith('[Session context]') || m.content.startsWith('[Hook'));
  const userTexts = (payload) => payload.messages.filter((m) => m.role === 'user' && !isNote(m)).map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('')));
  const lastUser = (payload) => userTexts(payload).pop();
  const streamed = () => state.requests.filter((r) => r.payload.stream);
  const ends = () => events.filter((e) => e.type === 'run_end');
  const idle = () => waitFor(() => !agent.running && ends().some((e) => !e.continued), 10000, 'the agent to be idle');
  const sessionUsers = () => agent.session.messages.filter((m) => m.role === 'user' && !isNote(m)).map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('')));
  const reset = () => {
    events = [];
    state.requests.length = 0;
    state.replies.length = 0;
    onEvent = null;
  };

  // ---- 1: during a model call in flight, with two other messages queued ----
  reset();
  state.replies.push({ content: 'slow reply that never arrives', delayMs: 4000 });
  state.replies.push({ content: 'Answer to the second.' });
  state.replies.push({ content: 'Answer to the first and third.' });
  let runningAtEnd = null;
  let sendDuring = null;
  onEvent = (ev) => {
    if (ev.type === 'run_end' && ev.continued) {
      runningAtEnd = agent.running;
      // A run start in that instant would be refused; a message queues behind the chosen one
      agent.run('should not start').then(() => (sendDuring = 'started'), (err) => (sendDuring = /already in progress/.test(err.message) ? 'refused' : err.message));
    }
  };
  const run1 = agent.run('first task');
  await waitFor(() => streamed().length === 1, 3000, 'the first request');
  const qA = agent.enqueue('queued one');
  const qB = agent.enqueue('queued two');
  const qC = agent.enqueue('queued three');
  const t0 = Date.now();
  check('1: sendNow on a queued message returns true', agent.sendNow(qB.id) === true);
  check('1: a second sendNow while one is on its way returns false', agent.sendNow(qC.id) === false);
  check('1: the chosen message left the queue at once, the others stay in order', JSON.stringify(agent.queue().map((m) => m.id)) === JSON.stringify([qA.id, qC.id]));
  await run1;
  check('1: the cut run ended within a second', Date.now() - t0 < 1000, Date.now() - t0);
  const end1 = ends()[0];
  check('1: its run_end is aborted and continued', end1 && end1.reason === 'aborted' && end1.continued === true, end1);
  check('1: the session was still running at that run_end', runningAtEnd === true && agent.running === true);
  await idle();
  check('1: a run cannot start in that instant (refused: one is in progress)', sendDuring === 'refused', sendDuring);
  const i0 = events.indexOf(end1);
  const after = events.slice(i0 + 1).map((e) => e.type);
  check('1: then run_start, queue_delivered (chosen), user_message', after[0] === 'run_start' && after[1] === 'queue_delivered' && events[i0 + 2].id === qB.id && after[2] === 'user_message', after.slice(0, 4));
  check('1: nothing was dropped back to the composer', !events.some((e) => e.type === 'queue_dropped'));
  const reqs = streamed();
  check('1: the next request ends with the chosen message and has neither of the others', reqs.length === 3 && lastUser(reqs[1].payload) === 'queued two' && !userTexts(reqs[1].payload).includes('queued one') && !userTexts(reqs[1].payload).includes('queued three'), reqs.map((r) => lastUser(r.payload)));
  check('1: the other two are delivered after that step, in order', JSON.stringify(userTexts(reqs[2].payload).slice(-2)) === JSON.stringify(['queued one', 'queued three']));
  check('1: each message delivered once', events.filter((e) => e.type === 'queue_delivered').map((e) => e.id).join() === [qB.id, qA.id, qC.id].join());
  check('1: the session holds each message once, in order', JSON.stringify(sessionUsers()) === JSON.stringify(['first task', 'queued two', 'queued one', 'queued three']), sessionUsers());
  check('1: two run_ends: aborted+continued, then done', ends().length === 2 && ends()[1].reason === 'done' && !ends()[1].continued);
  check('1: idle with an empty queue', !agent.running && agent.queue().length === 0);
  check('1: sendNow of a delivered message resolves false', agent.sendNow(qB.id) === false && agent.sendNow(qA.id) === false);

  // ---- 2: during a running command ----
  reset();
  const slow = call('bash', { command: 'sleep 8; echo slept' });
  state.replies.push({ toolCalls: [slow] });
  state.replies.push({ content: 'Answer after the cut.' });
  const run2 = agent.run('run a slow command');
  await waitFor(() => events.some((e) => e.type === 'tool_start' && e.id === slow.id), 3000, 'the command to start');
  await sleep(150);
  const q2 = agent.enqueue('stop that and do this');
  const t2 = Date.now();
  check('2: sendNow during a command returns true', agent.sendNow(q2.id) === true);
  await run2;
  const toolEnd = events.find((e) => e.type === 'tool_end' && e.id === slow.id);
  check('2: the command was cut within 2 s', Date.now() - t2 < 2000 && toolEnd && /stopped/.test(toolEnd.result), { ms: Date.now() - t2, toolEnd: toolEnd && toolEnd.result });
  await idle();
  const toolMsg = agent.session.messages.find((m) => m.role === 'tool' && m.tool_call_id === slow.id);
  check('2: the cut call has a result in the conversation (tail repaired)', !!toolMsg);
  check('2: the next request ends with the message', lastUser(streamed()[1].payload) === 'stop that and do this');
  const saved = JSON.parse(fs.readFileSync(store.file(agent.session.id), 'utf8'));
  check('2: saved to disk with both turns', JSON.stringify(saved).includes('stop that and do this') && JSON.stringify(saved).includes(slow.id));

  // ---- 3: during a waiting approval card ----
  reset();
  config.permissionMode = 'ask';
  const ask = call('ask_first', {});
  state.replies.push({ toolCalls: [ask] });
  state.replies.push({ content: 'Fine, doing the other thing.' });
  const run3 = agent.run('do the made-up thing');
  await waitFor(() => events.some((e) => e.type === 'approval_request'), 3000, 'an approval card');
  const card = events.find((e) => e.type === 'approval_request');
  const q3 = agent.enqueue('never mind that');
  check('3: sendNow while a card waits returns true', agent.sendNow(q3.id) === true);
  await run3;
  check('3: the card closed as interrupted', events.some((e) => e.type === 'approval_resolved' && e.id === card.id && e.interrupted === true && e.ok === false));
  await idle();
  check('3: the next request ends with the message', lastUser(streamed()[1].payload) === 'never mind that');
  config.permissionMode = 'bypass';

  // ---- 4: during a retry wait after a failed call ----
  reset();
  const realSleep = R.retryTiming.sleep;
  R.retryTiming.sleep = (ms, signal) => R.abortableSleep(20000, signal);
  state.replies.push({ status: 503, error: 'overloaded (mock)' });
  state.replies.push({ content: 'Back again.' });
  const run4 = agent.run('try the busy provider');
  await waitFor(() => events.some((e) => e.type === 'retry_status' && e.text), 3000, 'a retry wait');
  const q4 = agent.enqueue('skip the wait');
  const t4 = Date.now();
  check('4: sendNow during a retry wait returns true', agent.sendNow(q4.id) === true);
  await run4;
  check('4: the wait ended at once', Date.now() - t4 < 1000, Date.now() - t4);
  await idle();
  R.retryTiming.sleep = realSleep;
  check('4: the next request ends with the message, no error shown', lastUser(streamed()[1].payload) === 'skip the wait' && !events.some((e) => e.type === 'error' && e.kind !== 'notice'), events.filter((e) => e.type === 'error'));

  // ---- 5: hooks, @mentions: the message goes through what a typed one does ----
  reset();
  hooksOn = true;
  prompts.length = 0;
  state.replies.push({ content: 'slow', delayMs: 4000 });
  state.replies.push({ content: 'Read it.' });
  const run5 = agent.run('first with hooks');
  await waitFor(() => streamed().length === 1, 3000, 'the request');
  const q5a = agent.enqueue('stays queued');
  const q5 = agent.enqueue('what does @notes.txt say?');
  check('5: sendNow with hooks returns true', agent.sendNow(q5.id) === true);
  await run5;
  await waitFor(() => streamed().length === 2, 3000, 'the second request');
  const msgs5 = streamed()[1].payload.messages;
  const u5 = msgs5.filter((m) => m.role === 'user' && !isNote(m)).pop();
  const u5text = typeof u5.content === 'string' ? u5.content : JSON.stringify(u5.content);
  check('5: UserPromptSubmit saw the message', prompts.includes('what does @notes.txt say?'), prompts);
  check('5: the @mention was expanded', /teal/.test(u5text), u5text.slice(0, 200));
  check('5: the hook context follows it', JSON.stringify(msgs5).includes('HOOK-CONTEXT-LINE'));
  await idle();
  check('5: the other message was delivered after the first step', events.some((e) => e.type === 'queue_delivered' && e.id === q5a.id) && agent.queue().length === 0);

  // ---- 6: a hook refuses the message: it comes back, the rest is handled as at a normal run end ----
  reset();
  prompts.length = 0;
  state.replies.push({ content: 'slow', delayMs: 4000 });
  const run6 = agent.run('first again');
  await waitFor(() => streamed().length === 1, 3000, 'the request');
  const q6a = agent.enqueue('left over');
  const q6 = agent.enqueue('please BLOCKME now');
  check('6: sendNow returns true', agent.sendNow(q6.id) === true);
  await run6;
  await idle();
  const dropped6 = events.filter((e) => e.type === 'queue_dropped').map((e) => e.id);
  check('6: the refused message and the rest go back to the composer', dropped6.join() === [q6.id, q6a.id].join(), dropped6);
  check('6: no model call for it, nothing delivered', streamed().length === 1 && !events.some((e) => e.type === 'queue_delivered'));
  check('6: the second run ended done (not continued), idle, empty queue', ends().length === 2 && ends()[0].continued && ends()[1].reason === 'done' && !ends()[1].continued && !agent.running && agent.queue().length === 0, ends());
  check('6: the refused text is not in the conversation', !sessionUsers().some((t) => t.includes('BLOCKME')));
  hooksOn = false;

  // ---- 7: no longer queued: nothing happens, false ----
  reset();
  check('7: idle agent: false', agent.sendNow('no-such-id') === false);
  state.replies.push({ content: 'slow', delayMs: 1500 });
  const run7 = agent.run('one more');
  await waitFor(() => streamed().length === 1, 3000, 'the request');
  const q7 = agent.enqueue('removed first');
  agent.unqueue(q7.id);
  check('7: removed message: false, run untouched', agent.sendNow(q7.id) === false && agent.running);
  check('7: unknown id: false', agent.sendNow('nope') === false);
  const q7b = agent.enqueue('after the end');
  await run7;
  // The queued message was delivered (a reply without calls keeps the run going for it), so it is gone
  await idle();
  check('7: delivered message: false after the run ended', agent.sendNow(q7b.id) === false && !ends().some((e) => e.continued));

  // ---- 8: through the runtime: MAX_RUNNING does not refuse the handoff; a send in that instant queues ----
  const app = createApp({
    userData: path.join(tmp, 'app'),
    appRoot: projectDir,
    loadConfig: () => config,
    saveConfig: () => {},
    browser: () => ({ navigate: async (u) => u }),
    artifacts,
  });
  const rt = app.runtime;
  const appEvents = [];
  let sentDuring = null;
  let runningCount = null;
  let unreadAtHandoff = null;
  app.events.on((sid, ev) => {
    appEvents.push({ sid, ev });
    if (ev.type === 'run_end' && ev.continued) {
      runningCount = rt.running().length;
      unreadAtHandoff = rt.status(sid).unread === true || rt.get(sid).unread === true;
      sentDuring = rt.send(sid, 'sent in the handoff instant');
    }
  });
  state.requests.length = 0;
  state.replies.length = 0;
  const forTag = (tag) => (p) => (p.messages || []).some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(tag));
  const ids = [];
  for (let i = 0; i < MAX_RUNNING; i++) ids.push(rt.create({ cwd }).id);
  for (let i = 1; i < MAX_RUNNING; i++) state.replies.push({ content: 'busy', delayMs: 2500, when: forTag(`[S${i}]`) });
  state.replies.push({ content: 'slow first', delayMs: 4000, when: (p) => forTag('[S0]')(p) && !forTag('chosen [S0b]')(p) });
  state.replies.push({ content: 'Handled the chosen one.', when: (p) => lastUser(p) === 'chosen [S0b]' });
  state.replies.push({ content: 'Handled the rest.', when: forTag('chosen [S0b]') });
  rt.setForeground(ids[1]);
  for (let i = 0; i < MAX_RUNNING; i++) check(`8: session ${i} starts`, rt.send(ids[i], `work [S${i}]`).ok);
  check(`8: ${MAX_RUNNING} sessions run`, rt.running().length === MAX_RUNNING);
  const s0 = ids[0];
  const qr = rt.send(s0, 'chosen [S0b]');
  const qOther = rt.send(s0, 'other queued [S0c]');
  check('8: both queued', qr.queued && qOther.queued);
  check('8: the runtime finds the queued message and sends it now', rt.findQueued(qr.id)?.sendNow(qr.id) === true);
  await waitFor(() => appEvents.some((e) => e.sid === s0 && e.ev.type === 'run_end' && !e.ev.continued), 10000, 'S0 to finish');
  check('8: at the handoff the session still counted as running (no slot freed)', runningCount === MAX_RUNNING, runningCount);
  check('8: a send in that instant queued behind the chosen message', sentDuring && sentDuring.ok && sentDuring.queued === true, sentDuring);
  const s0Users = (() => {
    const s = rt.get(s0);
    return s.messages.filter((m) => m.role === 'user' && !isNote(m)).map((m) => m.content);
  })();
  check('8: the chosen message ran (not refused by the session limit), then the rest in order', JSON.stringify(s0Users) === JSON.stringify(['work [S0]', 'chosen [S0b]', 'other queued [S0c]', 'sent in the handoff instant']), s0Users);
  check('8: the cut run did not mark the background session unread', unreadAtHandoff === false && appEvents.filter((e) => e.sid === s0 && e.ev.type === 'run_end').length === 2);
  check('8: one user_message per message', appEvents.filter((e) => e.sid === s0 && e.ev.type === 'user_message').length === 4);
  await waitFor(() => rt.running().length === 0, 10000, 'all sessions to finish');
  check('8: S0 idle with an empty queue', !rt.isRunning(s0) && rt.live(s0).queue.length === 0);

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
