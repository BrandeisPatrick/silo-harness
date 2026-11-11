// Concurrent sessions: the SessionRuntime and the App's seams, headless, against the mock model (replies are matched
// to their session by a tag in the session's first message, and delayed per reply). Run: node test/runtime.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { MAX_RUNNING } = require(path.join(projectDir, 'dist/main/runtime.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { rewindSession, toTranscript } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-runtime-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const dirA = path.join(tmp, 'project-a');
  const dirB = path.join(tmp, 'project-b');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  const base = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: dirA, permissionMode: 'bypass', autoApprove: true, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  const saved = [];
  const navigated = [];
  /** Each session's own tabs: the runtime asks for them by session id */
  const browserFor = [];
  const browser = (sessionId) => ({ navigate: async (url) => { navigated.push(url); browserFor.push(sessionId); return `Now at ${url}`; } });
  const app = createApp({
    userData: tmp,
    appRoot: projectDir,
    loadConfig: () => base,
    saveConfig: (c) => saved.push(c),
    browser,
    artifacts: new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }),
  });
  const rt = app.runtime;
  let events = [];
  app.events.on((sid, ev) => events.push({ sid, ev }));
  const of = (sid, type) => events.filter((e) => e.sid === sid && (!type || e.ev.type === type)).map((e) => e.ev);
  let callId = 0;
  const call = (name, args) => ({ id: `c${++callId}`, name, args });
  /** Matches the requests of the session whose first message carries `tag`. */
  const forTag = (tag) => (payload) => {
    const first = (payload.messages || []).find((m) => m.role === 'user' && !String(m.content).startsWith('[Session context]'));
    return typeof first?.content === 'string' && first.content.includes(tag);
  };
  const reply = (tag, r) => state.replies.push({ ...r, when: forTag(tag) });
  const idle = (id) => waitFor(() => !rt.isRunning(id), 15000, `session ${id} to finish`);

  // ---- 1: two sessions run at once; events carry their session ----
  const A = rt.foregroundId();
  const B = rt.create({ cwd: dirB }).id;
  reply('[A1]', { content: 'reply from A', delayMs: 500 });
  reply('[B1]', { content: 'reply from B', delayMs: 50 });
  let r = rt.send(A, 'hello [A1]');
  check('1: send starts a run in A', r.ok && !r.queued, r);
  r = rt.send(B, 'hello [B1]');
  check('1: send in idle B starts a second run while A runs', r.ok && !r.queued && rt.running().length === 2, r);
  check('1: both report running', rt.isRunning(A) && rt.isRunning(B) && rt.status(A).running && rt.status(B).running);
  await idle(B);
  check('1: B finished while A still runs', !rt.isRunning(B) && rt.isRunning(A));
  await idle(A);
  check('1: A finished', !rt.isRunning(A));
  check('1: A events carry only A text', of(A, 'assistant_message').map((e) => e.text).join() === 'reply from A' && of(A, 'text_delta').every((e) => !e.text.includes('B')));
  check('1: B events carry only B text', of(B, 'assistant_message').map((e) => e.text).join() === 'reply from B');
  const firstEnd = events.findIndex((e) => e.ev.type === 'run_end');
  check('1: both runs started before either ended', events.filter((e, i) => e.ev.type === 'run_start' && i < firstEnd).length === 2);
  check('1: run_end.text is the last assistant text', of(A, 'run_end')[0].text === 'reply from A' && of(B, 'run_end')[0].text === 'reply from B');
  check('1: B ended off screen: unread, A on screen: not', rt.status(B).unread === true && !rt.status(A).unread && rt.get(B).unread === true);
  check('1: list() carries status', rt.list().find((m) => m.id === B)?.status?.unread === true);

  // ---- 2: user_message / assistant_message ----
  const um = of(A, 'user_message')[0];
  check('2: user_message for a typed message', um && um.text === 'hello [A1]' && um.origin === 'user' && um.images === 0 && um.turn === 0, um);
  check('2: assistant_message with the tool-call count', of(A, 'assistant_message')[0].toolCalls === 0);
  events = [];
  reply('[A1]', { content: 'scheduled ok' });
  rt.send(A, 'from the schedule', [], { origin: 'schedule', from: 'nightly' });
  await idle(A);
  const sm = of(A, 'user_message')[0];
  check('2: user_message keeps origin and from', sm.origin === 'schedule' && sm.from === 'nightly', sm);
  const tItem = toTranscript(rt.get(A)).filter((i) => i.role === 'user').pop();
  check('2: the transcript item keeps the origin', tItem.origin === 'schedule' && tItem.from === 'nightly', tItem);

  // ---- 3: switching the foreground mid-run, and the folder invariant ----
  events = [];
  reply('[A1]', { content: 'slow A', delayMs: 400 });
  rt.send(A, 'again');
  rt.setForeground(B);
  check('3: B on screen while A runs', rt.foregroundId() === B && rt.isRunning(A));
  check('3: B read on opening', !rt.status(B).unread && !rt.get(B).unread);
  check('3: the app folder follows the session on screen', app.config().workingDirectory === dirB, app.config().workingDirectory);
  check('3: and goes first in the recent folders', app.config().recentDirs[0] === dirB);
  await idle(A);
  check('3: A finished in the background and is unread', rt.status(A).unread === true && of(A, 'run_end').length === 1);
  rt.setForeground(A);
  check('3: back on A: read, folder back to A', !rt.status(A).unread && app.config().workingDirectory === dirA);

  // ---- 4: live() while streaming, during a tool call, and during a pending approval ----
  events = [];
  reply('[A1]', { chunks: ['Hel', 'lo ', 'wor', 'ld'], chunkDelayMs: 150 });
  rt.send(A, 'stream please');
  await waitFor(() => rt.live(A).text.length >= 3, 3000, 'streamed text');
  let live = rt.live(A);
  check('4: live during streaming: partial text, running, startedAt', live.running && 'Hello world'.startsWith(live.text) && live.text.length < 11 && live.startedAt > 0 && live.tools.length === 0, live);
  await idle(A);
  check('4: live of an idle session is empty', JSON.stringify(rt.live(A)) === JSON.stringify({ running: false, text: '', thinking: '', tools: [], approvals: [], questions: [], queue: [] }));

  const toolCall = call('bash', { command: 'sleep 0.8; echo slept' });
  reply('[A1]', { toolCalls: [toolCall] });
  reply('[A1]', { content: 'after the tool' });
  rt.send(A, 'run a tool');
  await waitFor(() => rt.live(A).tools.length === 1, 3000, 'a running tool');
  live = rt.live(A);
  check('4: live during a tool call lists it', live.tools[0].id === toolCall.id && live.tools[0].name === 'bash' && live.text === '', live);
  const running = toTranscript(rt.get(A), { running: true });
  const plain = toTranscript(rt.get(A));
  check('4: a running session\'s transcript leaves the in-flight call out', !running.some((i) => i.role === 'tool' && i.result === '(no result)') && plain.some((i) => i.role === 'tool' && i.result === '(no result)'));
  await idle(A);

  app.updateConfig({ permissionMode: 'ask' });
  const askCall = call('bash', { command: 'echo asked' });
  reply('[A1]', { toolCalls: [askCall] });
  reply('[A1]', { content: 'approved run done' });
  rt.send(A, 'needs approval');
  await waitFor(() => rt.live(A).approvals.length === 1, 3000, 'an approval card');
  live = rt.live(A);
  check('4: live during an approval: the card and its tool', live.approvals[0].name === 'bash' && live.tools.length === 1 && rt.status(A).attention === 'approval', live);
  // A switch takes the transcript and the live state together; sessions.live hands that snapshot out
  app.showSession(A);
  const snap = await app.invokeRpc('sessions.live', [A]);
  check('4: sessions.live after a switch returns the snapshot', snap.approvals.length === 1 && snap.running);
  const apId = live.approvals[0].id;
  check('4: respondApproval answers it', rt.respondApproval(apId, true, false) === true && rt.respondApproval(apId, true) === false);
  await idle(A);
  const res = of(A, 'approval_resolved')[0];
  check('4: approval_resolved event', res && res.id === apId && res.ok === true && res.scope === 'once', res);
  check('4: no attention after the answer', !rt.status(A).attention);

  // ---- 5: an approval answered for a background session reaches its agent; rules go to its folder ----
  events = [];
  const C = rt.create({ cwd: dirB }).id;
  reply('[A1]', { toolCalls: [call('bash', { command: 'echo fromA' })] });
  reply('[A1]', { content: 'A approved' });
  reply('[C1]', { toolCalls: [call('bash', { command: 'git status' })] });
  reply('[C1]', { content: 'C approved' });
  rt.send(A, 'ask too');
  rt.send(C, 'hello [C1]');
  await waitFor(() => rt.live(A).approvals.length && rt.live(C).approvals.length, 3000, 'two approval cards');
  const cCard = rt.live(C).approvals[0];
  rt.respondApproval(cCard.id, true, true, 'project');
  await idle(C);
  check('5: the background session went on, the other still waits', !rt.isRunning(C) && rt.isRunning(A) && rt.live(A).approvals.length === 1);
  check('5: the project rule went to C\'s folder, not the one on screen', app.config().allowRules[dirB]?.allow?.includes('Bash(git:*)') && !app.config().allowRules[dirA], app.config().allowRules);
  check('5: approval_resolved scope project', of(C, 'approval_resolved')[0].scope === 'project');
  rt.respondApproval(rt.live(A).approvals[0].id, false);
  await idle(A);
  check('5: a denied card is reported', of(A, 'approval_resolved').some((e) => e.ok === false));
  app.updateConfig({ permissionMode: 'bypass' });

  // ---- 6: a background session browses in its own tabs; the foreground one in its own ----
  events = [];
  navigated.length = 0;
  reply('[C1]', { toolCalls: [call('browser_navigate', { url: 'https://example.com' })] });
  reply('[C1]', { content: 'browsed behind' });
  rt.send(C, 'browse');
  await idle(C);
  const bEnd = of(C, 'tool_end')[0];
  check("6: a background session's browser call reaches its own tabs", bEnd && bEnd.ok && navigated[0] === 'https://example.com' && browserFor[0] === C, { bEnd, browserFor });
  reply('[A1]', { toolCalls: [call('browser_navigate', { url: 'https://example.com' })] });
  reply('[A1]', { content: 'browsed' });
  rt.send(A, 'browse here');
  await idle(A);
  check('6: the session on screen browses in its own', navigated[1] === 'https://example.com' && browserFor[1] === A && of(A, 'tool_end')[0].ok, browserFor);
  // create_artifact from the background stores it without navigating
  navigated.length = 0;
  reply('[C1]', { toolCalls: [call('create_artifact', { title: 'Note', kind: 'markdown', content: '# hi' })] });
  reply('[C1]', { content: 'made' });
  rt.send(C, 'artifact');
  await idle(C);
  check('6: a background artifact is stored without navigating', of(C, 'artifact').length === 1 && navigated.length === 0 && Object.keys(rt.get(C).artifacts || {}).length === 1);

  // ---- 7: per-session queues ----
  events = [];
  reply('[A1]', { content: 'A long', delayMs: 500 });
  reply('[A1]', { content: 'A queued answer' });
  reply('[C1]', { content: 'C quick' });
  rt.send(A, 'long one');
  const q = rt.send(A, 'queued for A');
  const c2 = rt.send(C, 'not queued');
  check('7: a send to a running session queues', q.ok && q.queued && q.id);
  check('7: a send to another idle session runs', c2.ok && !c2.queued);
  check('7: the queue belongs to A', rt.live(A).queue.length === 1 && rt.live(A).queue[0].text === 'queued for A' && rt.live(C).queue.length === 0);
  await idle(A);
  await idle(C);
  check('7: the queued message was delivered in A (origin queue)', of(A, 'queue_delivered')[0]?.id === q.id && of(A, 'user_message').some((e) => e.origin === 'queue' && e.text === 'queued for A'));

  // ---- 8: per-session folders ----
  events = [];
  check('8: A on screen in A\'s folder', rt.foregroundId() === A && app.config().workingDirectory === dirA);
  reply('[C1]', { toolCalls: [call('bash', { command: 'pwd' })] });
  reply('[C1]', { content: 'C pwd' });
  rt.send(C, 'where');
  await idle(C);
  const pwd = of(C, 'tool_end')[0]?.result || '';
  check('8: a tool in C runs in C\'s folder while A is on screen', fs.realpathSync(pwd.trim().split('\n')[0]) === fs.realpathSync(dirB), pwd);
  check('8: the app folder stayed on A', app.config().workingDirectory === dirA);
  const reqC = state.requests.filter((q) => forTag('[C1]')(q.payload)).pop().payload.messages;
  const noteC = reqC.filter((m) => m.role === 'user' && String(m.content).startsWith('[Session context]')).pop()?.content ?? '';
  check('8: C\'s context note names its folder, and its system prompt does not change with it', noteC.includes(`Working directory: ${dirB}`) && !reqC[0].content.includes('Working directory:'));
  // A folder change from the UI moves the on-screen session
  app.updateConfig({ workingDirectory: dirB });
  check('8: changing the folder moves the session on screen', rt.get(A).cwd === dirB);
  app.updateConfig({ workingDirectory: dirA });
  // A session stored before folders were per session adopts the current folder when opened
  const old = rt.create({}).id;
  delete rt.get(old).cwd;
  rt.setForeground(old);
  check('8: a session without a folder adopts the current one', rt.get(old).cwd === dirA);
  rt.setForeground(A);

  // ---- 9: the mutation hook ----
  const ops = [];
  const offMut = app.store.onMutation((s, op) => ops.push({ id: s.id, kind: op.kind, op }));
  reply('[A1]', { content: 'mutation reply' });
  rt.send(A, 'mutate');
  await idle(A);
  check('9: appends seen with their index', ops.filter((o) => o.kind === 'append' && o.id === A).length === 2 && ops.find((o) => o.kind === 'append').op.index === rt.get(A).messages.length - 2);
  check('9: the run end save seen', ops.some((o) => o.kind === 'save' && o.id === A));
  const sA = rt.get(A);
  const before = sA.messages.length;
  rewindSession(sA, dirA, sA.turns.length - 1, app.store);
  const tr = ops.find((o) => o.kind === 'truncate');
  check('9: a rewind truncates through the store', tr && tr.op.length === sA.messages.length && tr.op.removed.length === before - sA.messages.length && tr.op.removed.length === 2, tr && tr.op);
  state.summary = 'A summary of the conversation so far, long enough to be accepted by the cleaner.';
  // (compacted in C: replies are matched by a session's first message, which a compaction replaces)
  const cr = await rt.agentFor(C).compactNow();
  const rp = ops.find((o) => o.kind === 'replace');
  // Changed on purpose: a compaction keeps the last turn after the brief.
  check('9: a compaction replaces through the store', cr.ok && rp && rp.op.reason === 'compaction' && rp.op.messages[0].content.startsWith('[Context compacted]') && rp.op.messages.length < rp.op.removed.length + 1 && rp.op.removed.length > 1, cr);
  const fork = app.store.fork(A);
  const fo = ops.find((o) => o.kind === 'fork');
  check('9: fork fires on the new session with the seed length', fo && fo.id === fork.id && fo.op.from === A && fo.op.seedLength === sA.messages.length && fork.seedLength === sA.messages.length);
  app.store.rename(fork.id, 'Renamed');
  app.store.delete(fork.id);
  check('9: rename and delete seen', ops.some((o) => o.kind === 'rename' && o.op.title === 'Renamed') && ops.some((o) => o.kind === 'delete' && o.id === fork.id));
  const made = rt.create({}).id;
  check('9: create seen', ops.some((o) => o.kind === 'create' && o.id === made));
  offMut();

  // ---- 10: registered tool, prompt section and command, and their disposers ----
  events = [];
  let ctxSeen = null;
  const offTool = app.tools.register({
    name: 'probe', description: 'A test tool', parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      ctxSeen = { sessionId: ctx.sessionId, fg: ctx.foreground(), hasApp: ctx.app === app };
      const ok = await ctx.approve('probe', 'Run the probe?', undefined, { custom: true });
      return { content: ok.ok ? 'probe ran' : ok.message };
    },
  });
  const offPrompt = app.prompt.add('test-section', (info) => `SECTION for ${info.sessionId} in ${info.cwd}`);
  app.prompt.add('empty-section', () => '');
  state.requests.length = 0;
  reply('[A1]', { toolCalls: [call('probe', {})] });
  reply('[A1]', { content: 'probed' });
  rt.send(A, 'probe it');
  await idle(A);
  const req = state.requests.filter((q) => q.payload.stream)[0].payload;
  check('10: the registered tool is offered', req.tools.some((t) => t.function.name === 'probe'));
  check('10: the prompt section is in the system prompt', req.messages[0].content.includes(`SECTION for ${A} in ${dirA}`) && !/\n\n\n/.test(req.messages[0].content));
  check('10: the tool ran with the session context', of(A, 'tool_end')[0].result === 'probe ran' && ctxSeen.sessionId === A && ctxSeen.fg === true && ctxSeen.hasApp, ctxSeen);
  // ask mode: a custom approval asks with only Allow and Deny
  app.updateConfig({ permissionMode: 'ask' });
  events = [];
  reply('[A1]', { toolCalls: [call('probe', {})] });
  reply('[A1]', { content: 'probed again' });
  rt.send(A, 'probe ask');
  await waitFor(() => rt.live(A).approvals.length === 1, 3000, 'the custom card');
  const custom = rt.live(A).approvals[0];
  check('10: a custom approval card has no "always" answers', custom.alwaysLabel === '' && custom.projectLabel === '' && custom.name === 'probe');
  rt.respondApproval(custom.id, true, true, 'project');
  await idle(A);
  check('10: answering it ran the tool, and no rule was saved for it', of(A, 'tool_end')[0].result === 'probe ran' && of(A, 'approval_resolved')[0].scope === 'once');
  // plan mode: a registered tool that is not read-only is not offered; a custom approval would be refused
  app.updateConfig({ permissionMode: 'plan' });
  state.requests.length = 0;
  reply('[A1]', { content: 'planning' });
  rt.send(A, 'plan');
  await idle(A);
  check('10: plan mode leaves out a registered tool that is not read-only', !state.requests[0].payload.tools.some((t) => t.function.name === 'probe'));
  app.updateConfig({ permissionMode: 'bypass' });
  offTool();
  offPrompt();
  state.requests.length = 0;
  reply('[A1]', { content: 'plain' });
  rt.send(A, 'after dispose');
  await idle(A);
  check('10: disposers remove the tool and the section', !state.requests[0].payload.tools.some((t) => t.function.name === 'probe') && !state.requests[0].payload.messages[0].content.includes('SECTION for'));

  const offCmd = app.commands.register({ name: 'greet', description: 'Says hi', source: 'app', argsHint: '<name>', run: (args, ctx) => ({ notice: `hi ${args} from ${ctx.sessionId}`, send: 'sent text' }) });
  const list = await app.invokeRpc('commands.list', []);
  check('10: commands.list lists it without run', list.length === 1 && list[0].name === 'greet' && list[0].argsHint === '<name>' && list[0].run === undefined);
  const out = await app.invokeRpc('commands.run', ['greet', 'Ann']);
  check('10: commands.run runs it on the session on screen', out.notice === `hi Ann from ${A}` && out.send === 'sent text', out);
  app.commands.register({ name: 'boom', description: 'throws', source: 'mod', run: () => { throw new Error('kaput'); } });
  check('10: a failing command returns its error', (await app.invokeRpc('commands.run', ['boom', ''])).error === 'kaput');
  offCmd();
  check('10: the command disposer removes it', (await app.invokeRpc('commands.list', [])).every((c) => c.name !== 'greet') && /Unknown command/.test((await app.invokeRpc('commands.run', ['greet', ''])).error));
  let threw = '';
  try { await app.invokeRpc('no.such.method', []); } catch (e) { threw = e.message; }
  check('10: an unknown RPC method rejects', /Unknown RPC method/.test(threw));
  const offRpc = app.rpc.handle('test.echo', (x) => x);
  check('10: a registered RPC method answers', (await app.invokeRpc('test.echo', [7])) === 7);
  offRpc();
  const offSvc = app.provide('svc', { n: 1 });
  check('10: services', app.service('svc').n === 1);
  offSvc();
  check('10: service disposer', app.service('svc') === undefined);
  const seen = [];
  const offCfg = app.onConfig((next, prev) => seen.push([prev.maxTurns, next.maxTurns]));
  app.updateConfig((c) => ({ ...c, maxTurns: 13 }));
  offCfg();
  app.updateConfig({ maxTurns: 12 });
  check('10: onConfig and updateConfig (function form), saved each time', seen.length === 1 && seen[0][1] === 13 && saved.at(-1).maxTurns === 12);
  const quits = [];
  app.onQuit(() => quits.push(1));
  app.onQuit(async () => { await sleep(10); quits.push(2); });
  await app.runQuit();
  check('10: quit handlers run last registered first', quits.join() === '2,1');

  // ---- 11: the cap on running sessions ----
  const ids = [];
  for (let i = 0; i < MAX_RUNNING + 1; i++) ids.push(rt.create({}).id);
  ids.forEach((id, i) => reply(`[CAP${i}]`, { content: `cap ${i}`, delayMs: 300 }));
  const results = ids.map((id, i) => rt.send(id, `cap [CAP${i}]`));
  check(`11: at most ${MAX_RUNNING} sessions run at once`, results.slice(0, MAX_RUNNING).every((x) => x.ok) && !results[MAX_RUNNING].ok && /already running/.test(results[MAX_RUNNING].error), results[MAX_RUNNING]);
  await Promise.all(ids.slice(0, MAX_RUNNING).map(idle));
  state.replies.length = 0;
  rt.stopAll();

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
