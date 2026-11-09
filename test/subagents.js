// Sub-sessions, messages between sessions, reports back and merge, headless: the real App and SessionRuntime with the
// mock model (replies matched to their session by a tag in its first message, delayed per reply).
// Run: node test/subagents.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { setupSubagents } = require(path.join(projectDir, 'dist/main/subagents.js'));
const { toTranscript } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { titleFromTask } = require(path.join(projectDir, 'dist/main/subagents/commands.js'));
const { NOTE_CAP } = require(path.join(projectDir, 'dist/main/subagents/service.js'));
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
  state.summary = '## Asked\nX\n## Result\nSUMMARY-OK';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-subagents-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const dir = path.join(tmp, 'project');
  const other = path.join(tmp, 'other');
  fs.mkdirSync(dir);
  fs.mkdirSync(other);
  const base = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: dir, permissionMode: 'bypass', autoApprove: true, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  const app = createApp({ userData: tmp, appRoot: projectDir, loadConfig: () => base, saveConfig: () => {} });
  const svc = setupSubagents(app, { retryMs: 50 });
  const rt = app.runtime;
  let events = [];
  app.events.on((sid, ev) => events.push({ sid, ev }));
  const of = (sid, type) => events.filter((e) => e.sid === sid && (!type || e.ev.type === type)).map((e) => e.ev);
  let callId = 0;
  const call = (name, args) => ({ id: `c${++callId}`, name, args });
  const firstUser = (payload) => (payload.messages || []).find((m) => m.role === 'user');
  const lastUser = (payload) => [...(payload.messages || [])].reverse().find((m) => m.role === 'user');
  const has = (m, tag) => typeof m?.content === 'string' && m.content.includes(tag);
  const reply = (tag, r) => state.replies.push({ ...r, when: (p) => has(firstUser(p), tag) });
  const replyLast = (tag, r) => state.replies.push({ ...r, when: (p) => has(lastUser(p), tag) });
  const idle = (id) => waitFor(() => !rt.isRunning(id), 15000, `session ${id} to finish`);
  const allIdle = () => waitFor(() => rt.running().length === 0, 20000, 'every session to finish');
  const toolMsgs = (id) => rt.get(id).messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const tool = (name) => app.tools.list().find((t) => t.name === name);
  /** A ToolContext for calling a tool directly; approvals are recorded and answered with `answer`. */
  const ctxFor = (sessionId, answer = { ok: true }) => {
    const asked = [];
    return { asked, ctx: { sessionId, cwd: dir, app, approve: async (...a) => (asked.push(a), answer) } };
  };
  const summaryRequests = () => state.requests.filter((r) => r.url === '/v1/chat/completions' && r.payload.stream === false);
  const notesTo = (id) => of(id, 'user_message').filter((e) => e.origin === 'session' && /^\[Sub-session "/.test(e.text));
  const cmd = (name, args = '') => app.invokeRpc('commands.run', [name, args]);

  // ---- 0: wiring ----
  for (const t of ['session_spawn', 'session_send', 'session_list', 'session_read', 'session_merge']) check(`0: tool ${t} registered`, !!tool(t));
  check('0: list and read are read-only, the others not', tool('session_list').readOnly && tool('session_read').readOnly && !tool('session_spawn').readOnly && !tool('session_merge').readOnly && !tool('session_send').readOnly);
  check('0: spawn description asks for a self-contained brief', /self-contained/.test(tool('session_spawn').description) && /whole brief/.test(tool('session_spawn').description));
  check('0: merge description says files need no merging', /same folder/.test(tool('session_merge').description) && /not a git merge/.test(tool('session_merge').description));
  const names = app.commands.list().map((c) => c.name);
  for (const c of ['spawn', 'merge', 'sessions', 'send']) check(`0: /${c} registered (source app)`, names.includes(c) && app.commands.list().find((x) => x.name === c).source === 'app');
  const service = app.service('subagents');
  check('0: service provided', service && typeof service.spawn === 'function' && typeof service.merge === 'function' && typeof service.related === 'function');
  check('0: prompt section', /## Sub-sessions/.test(app.promptFor({ cwd: dir, mode: 'bypass', sessionId: rt.foregroundId() })));

  // ---- 1: spawn from a tool call; the child runs while the parent goes on; the note wakes the idle parent ----
  const P = rt.foregroundId();
  reply('[P]', { toolCalls: [call('session_spawn', { title: 'Counter', prompt: 'Count the things [C1]' })] });
  reply('[P]', { content: 'spawned it, waiting', delayMs: 250 });
  reply('[C1]', { content: 'child answer: 42 things', delayMs: 700 });
  reply('[P]', { content: 'parent read the note' });
  rt.send(P, 'hello [P]');
  const C = await waitFor(() => rt.list().find((m) => m.parentId === P)?.id, 5000, 'the sub-session');
  const cMeta = rt.meta(C);
  check('1: sub-session meta: parentId, origin spawn, title, same folder', cMeta.parentId === P && cMeta.origin === 'spawn' && cMeta.title === 'Counter' && cMeta.cwd === dir, cMeta);
  await waitFor(() => toolMsgs(P).length === 1, 5000, 'the spawn result');
  check('1: spawn returns at once with id, title and "background"', toolMsgs(P)[0].includes(C) && /"Counter"/.test(toolMsgs(P)[0]) && /background/.test(toolMsgs(P)[0]), toolMsgs(P)[0]);
  check('1: the child runs while the parent run goes on', rt.isRunning(C) && rt.isRunning(P));
  const cu = of(C, 'user_message')[0];
  check('1: the child got the prompt as its first message, from the parent', cu && cu.text === 'Count the things [C1]' && cu.origin === 'session' && cu.from === P, cu);
  check('1: the child is not on screen', rt.foregroundId() === P);
  await waitFor(() => !rt.isRunning(P) && rt.isRunning(C), 5000, 'the parent to finish first');
  check('1: parent idle while the child still runs', true);
  await waitFor(() => notesTo(P).length === 1, 5000, 'the note');
  const note = notesTo(P)[0];
  check('1: note heading with title, id and reason', note.text.startsWith(`[Sub-session "Counter" (${C}) finished a turn: done]`), note.text);
  check('1: note carries the reply and the next steps', /child answer: 42 things/.test(note.text) && /session_read/.test(note.text) && /session_send/.test(note.text) && /session_merge/.test(note.text));
  check('1: note from the child', note.from === C);
  await idle(P);
  check('1: the idle parent continued from the note on its own', of(P, 'assistant_message').some((e) => e.text === 'parent read the note'));
  check('1: one note for one child run', notesTo(P).length === 1);
  check('1: sub-session prompt tells it it reports back', /sub-session of "/.test(app.promptFor({ cwd: dir, mode: 'bypass', sessionId: C })));

  // ---- 2: limits ----
  const G = svc.spawn(C, { title: 'Grandchild', prompt: 'nested [G1]' }).id;
  check('2: a sub-session can spawn (depth 2)', rt.meta(G).parentId === C);
  await allIdle();
  let r = await tool('session_spawn').run({ title: 'x', prompt: 'y' }, ctxFor(G).ctx);
  check('2: depth 3 refused with a clear error', /^Error: .*cannot start sub-sessions/.test(r.content), r.content);
  const Q = rt.create({ cwd: dir }).id;
  for (let i = 0; i < 4; i++) reply(`[Q${i}]`, { content: `q${i}`, delayMs: 1200 });
  for (let i = 0; i < 4; i++) svc.spawn(Q, { title: `Q child ${i}`, prompt: `work [Q${i}]` });
  check('2: four running children', svc.children(Q).filter((s) => rt.isRunning(s.id)).length === 4);
  const qc = ctxFor(Q);
  r = await tool('session_spawn').run({ title: 'fifth', prompt: 'more' }, qc.ctx);
  check('2: a fifth running one refused, before any approval', /^Error: 4 sub-sessions/.test(r.content) && qc.asked.length === 0, r.content);
  await allIdle();
  for (let i = 0; i < 8; i++) {
    const s = app.store.create({ cwd: dir, parentId: Q, origin: 'spawn', title: `old ${i}` });
    app.store.append(s, { role: 'user', content: 'x' });
    app.store.save(s);
  }
  r = await tool('session_spawn').run({ title: 'thirteenth', prompt: 'more' }, ctxFor(Q).ctx);
  check('2: a thirteenth refused (12 in all)', /^Error: .*12 sub-sessions/.test(r.content), r.content);
  let threw = '';
  try {
    svc.spawn(Q, { title: 't', prompt: 'p' });
  } catch (err) {
    threw = err.message;
  }
  check('2: the service refuses the same way', /12 sub-sessions/.test(threw), threw);
  const ac = ctxFor(P);
  reply('[A1]', { content: 'ok' });
  r = await tool('session_spawn').run({ title: 'Asked', prompt: 'brief text [A1]' }, ac.ctx);
  check('2: spawn asks a custom approval with title and brief', ac.asked.length === 1 && ac.asked[0][0] === 'session_spawn' && /Asked/.test(ac.asked[0][1]) && /brief text \[A1\]/.test(ac.asked[0][1]) && ac.asked[0][3]?.custom === true, ac.asked);
  const dc = ctxFor(P, { ok: false, message: 'User denied.' });
  const before = svc.children(P).length;
  r = await tool('session_spawn').run({ title: 'Denied', prompt: 'no' }, dc.ctx);
  check('2: a denied spawn starts nothing', /^Not started/.test(r.content) && svc.children(P).length === before, r.content);
  await allIdle();

  // ---- 3: session_send and its approval rule ----
  const U = rt.create({ cwd: other }).id;
  reply('[U1]', { content: 'u first' });
  rt.send(U, 'unrelated [U1]');
  await idle(U);
  let sc = ctxFor(C);
  r = await tool('session_send').run({ to: P, message: 'hello parent' }, sc.ctx);
  check('3: child → parent: no approval, delivered', sc.asked.length === 0 && /^Delivered/.test(r.content), r.content);
  const toParent = of(P, 'user_message').filter((e) => e.origin === 'session' && e.from === C).pop();
  check('3: the parent sees who wrote, and that it is not the user', toParent && /^\[Message from session "Counter" \([^)]+\), your sub-session\. Not from the user: /.test(toParent.text) && /hello parent/.test(toParent.text), toParent);
  await allIdle();
  sc = ctxFor(P);
  r = await tool('session_send').run({ to: 'Counter', message: 'hello child' }, sc.ctx);
  check('3: parent → child by title: no approval, delivered', sc.asked.length === 0 && /^Delivered/.test(r.content), r.content);
  await allIdle();
  sc = ctxFor(P);
  r = await tool('session_send').run({ to: U, message: 'hello stranger' }, sc.ctx);
  check('3: to an unrelated session: a custom approval', sc.asked.length === 1 && sc.asked[0][0] === 'session_send' && sc.asked[0][3]?.custom === true && /hello stranger/.test(sc.asked[0][1]) && /^Delivered/.test(r.content), { asked: sc.asked, r });
  await allIdle();
  sc = ctxFor(P, { ok: false, message: 'User denied.' });
  const uBefore = of(U, 'user_message').length;
  r = await tool('session_send').run({ to: U, message: 'denied one' }, sc.ctx);
  check('3: denied: not delivered', /^Not sent/.test(r.content) && of(U, 'user_message').length === uBefore, r.content);
  r = await tool('session_send').run({ to: 'no such session', message: 'x' }, ctxFor(P).ctx);
  check('3: unknown target: a clear error', /^Error: No session/.test(r.content), r.content);
  r = await tool('session_send').run({ to: P, message: 'x' }, ctxFor(P).ctx);
  check('3: to itself: refused', /^Error/.test(r.content), r.content);
  // End to end in ask mode: the model's call raises a real approval card
  app.updateConfig({ permissionMode: 'ask' });
  reply('[U1]', { toolCalls: [call('session_send', { to: P, message: 'from U via the model' })] });
  reply('[U1]', { content: 'sent' });
  events = [];
  rt.send(U, 'please send');
  const card = await waitFor(() => of(U, 'approval_request')[0], 5000, 'an approval card');
  check('3: a real approval card for an unrelated target: Allow once, "for this session" for that target, Deny', card.name === 'session_send' && card.alwaysLabel === `Allow messages to "${rt.get(P).title}" for this session` && card.projectLabel === '' && /from U via the model/.test(card.detail), card);
  rt.respondApproval(card.id, true);
  await allIdle();
  check('3: delivered after approval', of(P, 'user_message').some((e) => /from U via the model/.test(e.text) && e.from === U));
  app.updateConfig({ permissionMode: 'bypass' });

  // ---- 4: session_read and session_list ----
  r = await tool('session_read').run({ id: C, last: 2 }, ctxFor(P).ctx);
  check('4: session_read: header and the last messages', r.content.includes(`Session ${C} "Counter"`) && /the last 2 messages of/.test(r.content) && /ASSISTANT:/.test(r.content), r.content);
  r = await tool('session_read').run({ id: C }, ctxFor(P).ctx);
  check('4: session_read default 6', /the last 6 messages/.test(r.content), r.content.slice(0, 200));
  r = await tool('session_read').run({ id: C, last: 500 }, ctxFor(P).ctx);
  check('4: session_read caps at 30', /the last \d+ messages/.test(r.content) && Number(/the last (\d+)/.exec(r.content)[1]) <= 30);
  const big = app.store.create({ cwd: dir, title: 'Big' });
  app.store.append(big, { role: 'assistant', content: '', tool_calls: [{ id: 'b1', type: 'function', function: { name: 'bash', arguments: '{}' } }] });
  app.store.append(big, { role: 'tool', tool_call_id: 'b1', content: 'z'.repeat(5000) });
  app.store.save(big);
  r = await tool('session_read').run({ id: big.id }, ctxFor(P).ctx);
  check('4: tool results cut short', /RESULT OF bash: z+ …\[4500 more characters\]/.test(r.content), r.content.slice(0, 300));
  r = await tool('session_read').run({ id: 'nope' }, ctxFor(P).ctx);
  check('4: session_read of an unknown id: error', /^Error/.test(r.content));
  r = await tool('session_list').run({}, ctxFor(P).ctx);
  check('4: session_list: related first, with relation and state', r.content.indexOf(`${C}  "Counter"  sub-session  idle`) > 0 && r.content.indexOf('Other recent') > r.content.indexOf('Counter'), r.content);
  check('4: session_list: last reply line', new RegExp(`${C}.*last: `).test(r.content));
  check('4: session_list: others listed as other', new RegExp(`${U}  "[^"]*"  other`).test(r.content), r.content);
  r = await tool('session_list').run({}, ctxFor(C).ctx);
  check('4: from the child: the parent and its own sub-session', new RegExp(`${P}  "[^"]*"  parent`).test(r.content) && new RegExp(`${G}  "Grandchild"  sub-session`).test(r.content), r.content);

  // ---- 5: merge a sub-session (through the tool), the marks, the refusals ----
  const pLen = rt.get(P).messages.length;
  const sumBefore = summaryRequests().length;
  r = await tool('session_merge').run({ id: 'Counter' }, ctxFor(P).ctx);
  check('5: merge result: heading and summary', r.content.startsWith('[Merged from "Counter"]') && /SUMMARY-OK/.test(r.content), r.content);
  const sreq = summaryRequests().slice(sumBefore);
  check('5: one summary request with the whole child conversation', sreq.length === 1 && /Count the things \[C1\]/.test(sreq[0].payload.messages[1].content) && /child answer: 42 things/.test(sreq[0].payload.messages[1].content) && /## Files touched/.test(sreq[0].payload.messages[0].content));
  check('5: through the tool the text is not also appended', rt.get(P).messages.length === pLen);
  check('5: marked mergedInto / mergedAt, in the meta too', rt.get(C).mergedInto === P && rt.get(C).mergedAt > 0 && rt.meta(C).mergedInto === P);
  check('5: stored on disk', JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', `${C}.json`), 'utf8')).mergedInto === P);
  r = await tool('session_merge').run({ id: C }, ctxFor(P).ctx);
  check('5: merging again refused', /^Error: .*already merged/.test(r.content), r.content);
  r = await tool('session_read').run({ id: C }, ctxFor(P).ctx);
  check('5: a merged session stays readable, state merged', /\(merged\)/.test(r.content), r.content.slice(0, 120));
  r = await tool('session_merge').run({ id: U }, ctxFor(P).ctx);
  check('5: not a sub-session or fork: refused', /^Error: .*not a sub-session or fork/.test(r.content), r.content);
  reply('[R1]', { content: 'slow', delayMs: 800 });
  const Rn = svc.spawn(P, { title: 'Runner', prompt: 'slow [R1]' }).id;
  r = await tool('session_merge').run({ id: Rn }, ctxFor(P).ctx);
  check('5: refused while the source runs', /still running/.test(r.content), r.content);
  await allIdle();
  // the RPC path refuses while the target runs
  reply('[P]', { content: 'busy parent', delayMs: 600 });
  rt.send(P, 'keep busy');
  let m = await app.invokeRpc('sessions.merge', [P, Rn]);
  check('5: RPC merge refused while the target runs', m.ok === false && /is running/.test(m.error), m);
  await allIdle();

  // ---- 6: merge a fork (only what came after the split), through the RPC ----
  const F = app.store.fork(P);
  const seed = F.seedLength;
  check('6: the fork knows its seed length', seed === rt.get(P).messages.length && F.forkedFrom === P);
  replyLast('[F1]', { content: 'fork did the side quest' });
  rt.send(F.id, 'side quest [F1]');
  await idle(F.id);
  const fsBefore = summaryRequests().length;
  events = [];
  m = await app.invokeRpc('sessions.merge', [P, F.id]);
  check('6: RPC merge of a fork ok', m.ok === true, m);
  const freq = summaryRequests().slice(fsBefore)[0];
  const fall = freq?.payload.messages[1].content ?? '';
  const ftext = fall.split('Transcript:')[1] ?? '';
  check('6: only the part after the split is summarised', /side quest \[F1\]/.test(ftext) && /fork did the side quest/.test(ftext) && !/hello \[P\]/.test(ftext) && !/child answer/.test(ftext), ftext.slice(0, 400));
  check('6: the fork wording', /after it split off/.test(fall));
  const lastP = rt.get(P).messages.at(-1);
  check('6: appended to the target as a user message', lastP.role === 'user' && lastP.content.startsWith(`[Merged from "${F.title}"]`) && /SUMMARY-OK/.test(lastP.content));
  const mu = of(P, 'user_message').pop();
  check('6: a user_message event (origin command) shows it', mu && mu.origin === 'command' && mu.text === lastP.content, mu);
  check('6: no run was started by the merge', !rt.isRunning(P) && of(P, 'run_start').length === 0);
  const tlast = toTranscript(rt.get(P)).filter((i) => i.role === 'user').pop();
  check('6: the transcript keeps it labelled after a reload', tlast.origin === 'command' && tlast.text.startsWith('[Merged from'), tlast);
  check('6: the fork is marked', rt.get(F.id).mergedInto === P);
  const F2 = app.store.fork(P);
  m = await app.invokeRpc('sessions.merge', [P, F2.id]);
  check('6: a fork with nothing new: nothing happens', m.ok === false && /Nothing to merge/.test(m.error) && !rt.get(F2.id).mergedInto, m);
  state.summaryFails = true;
  replyLast('[F3]', { content: 'more' });
  rt.send(F2.id, 'more [F3]');
  await idle(F2.id);
  m = await app.invokeRpc('sessions.merge', [P, F2.id]);
  check('6: a failed summary leaves everything as it was', m.ok === false && /summary/.test(m.error) && !rt.get(F2.id).mergedInto, m);
  state.summaryFails = false;

  // ---- 7: note rules ----
  // a turn the user drove by hand in a sub-session: no note
  reply('[N1]', { content: 'n first' });
  const N = svc.spawn(P, { title: 'Notes', prompt: 'notes [N1]' }).id;
  await allIdle();
  const nNotes = notesTo(P).filter((e) => e.from === N).length;
  check('7: the spawn run reported', nNotes === 1, nNotes);
  reply('[N1]', { content: 'typed reply' });
  rt.send(N, 'typed by the user');
  await allIdle();
  check('7: no note for a turn the user drove', notesTo(P).filter((e) => e.from === N).length === 1);
  // a message from another session starts a run there: it reports
  svc.message(P, N, 'please continue');
  await allIdle();
  check('7: a run started by another session reports', notesTo(P).filter((e) => e.from === N).length === 2);
  // none once merged
  await app.invokeRpc('sessions.merge', [P, N]);
  svc.message(P, N, 'after the merge');
  await allIdle();
  check('7: no note after the merge', notesTo(P).filter((e) => e.from === N).length === 2);
  // the cap
  const R = rt.create({ cwd: dir }).id;
  reply('[R0]', { content: 'r first' });
  rt.send(R, 'root [R0]');
  await idle(R);
  reply('[K1]', { content: 'k first' });
  const K = svc.spawn(R, { title: 'Chatty', prompt: 'chatty [K1]' }).id;
  await allIdle();
  const fire = async () => {
    svc.onEvent(K, { type: 'run_start' });
    svc.onEvent(K, { type: 'user_message', text: 'x', images: 0, origin: 'session' });
    svc.onEvent(K, { type: 'run_end', reason: 'done', text: 'chat' });
    await allIdle();
  };
  for (let i = 1; i < NOTE_CAP; i++) await fire();
  check(`7: ${NOTE_CAP} notes delivered`, notesTo(R).length === NOTE_CAP, notesTo(R).length);
  await fire();
  await fire();
  check('7: then they stop', notesTo(R).length === NOTE_CAP);
  const paused = of(R, 'user_message').filter((e) => /Reports from sub-sessions are paused/.test(e.text));
  check('7: said once in the parent transcript', paused.length === 1 && paused[0].origin === 'command' && /paused/.test(rt.get(R).messages.at(-1).content), paused.length);
  reply('[R0]', { content: 'r typed' });
  rt.send(R, 'the user writes');
  await allIdle();
  await fire();
  check('7: a user message lets them flow again', notesTo(R).length === NOTE_CAP + 1);

  // ---- 8: slash commands ----
  const S = rt.create({ cwd: dir, foreground: true }).id;
  reply('[S0]', { content: 's first' });
  rt.send(S, 'screen [S0]');
  await idle(S);
  let c = await cmd('spawn', '');
  check('8: /spawn without a task: usage', /Usage: \/spawn/.test(c.error), c);
  reply('[S1]', { content: 'spawned by command' });
  c = await cmd('spawn', 'Look into the flaky login test and report [S1]');
  const S1 = svc.children(S)[0];
  check('8: /spawn: a sub-session of the session on screen, titled from the first words', S1 && S1.title === 'Look into the flaky login test' && S1.parentId === S && c.notice === `Started sub-session "${S1.title}". It reports back here.`, { c, title: S1?.title });
  check('8: titleFromTask', titleFromTask('Fix it.') === 'Fix it' && titleFromTask('   ') === 'Sub-session');
  await allIdle();
  c = await cmd('sessions');
  check('8: /sessions lists the related sessions with state', /1 related session:/.test(c.notice) && c.notice.includes(`${S1.id}  "${S1.title}"  sub-session  idle`), c);
  c = await cmd('merge');
  check('8: /merge with one candidate merges it', c.notice === `Merged "${S1.title}" into this session.` && rt.get(S1.id).mergedInto === S, c);
  c = await cmd('merge');
  check('8: /merge with nothing left', /Nothing to merge/.test(c.notice), c);
  reply('[S2]', { content: 'two a' });
  reply('[S3]', { content: 'two b' });
  const s2 = svc.spawn(S, { title: 'Twin', prompt: 'twin a [S2]' }).id;
  const s3 = svc.spawn(S, { title: 'twin', prompt: 'twin b [S3]' }).id;
  await allIdle();
  c = await cmd('merge');
  check('8: /merge with several and no argument lists them with ids', /2 sessions can be merged/.test(c.notice) && c.notice.includes(s2) && c.notice.includes(s3), c);
  c = await cmd('merge', 'TWIN');
  check('8: /merge with an ambiguous title lists both with ids', /"TWIN" fits 2 sessions/.test(c.error) && c.error.includes(s2) && c.error.includes(s3), c);
  c = await cmd('merge', 'nothing like it');
  check('8: /merge with no match', /No sub-session or fork of this session matches/.test(c.error), c);
  c = await cmd('merge', s3);
  check('8: /merge by id', /^Merged "twin"/.test(c.notice) && rt.get(s3).mergedInto === S, c);
  c = await cmd('merge', s3);
  check('8: /merge of a merged one refused', /already merged/.test(c.error), c);
  reply('[S2]', { content: 'twin got it' });
  c = await cmd('send', 'Twin: here is a note');
  check('8: /send delivers', /^Sent to "Twin"/.test(c.notice) && of(s2, 'user_message').some((e) => /here is a note/.test(e.text) && e.from === S), c);
  await allIdle();
  c = await cmd('send', 'no colon here');
  check('8: /send without a colon: usage', /Usage: \/send/.test(c.error), c);
  c = await cmd('send', 'nobody: hi');
  check('8: /send to an unknown session', /^No session matches "nobody"\. Closest names:/.test(c.error), c);
  const colon = rt.create({ cwd: dir, title: 'Plan: v2' }).id;
  reply('[CO]', { content: 'co' });
  rt.send(colon, 'colon [CO]');
  await allIdle();
  c = await cmd('send', 'Plan: v2: hello there');
  check('8: /send to a title with a colon', /^Sent to "Plan: v2"/.test(c.notice) && of(colon, 'user_message').some((e) => /hello there$/.test(e.text)), c);
  await allIdle();
  const lone = rt.create({ cwd: dir, foreground: true }).id;
  c = await cmd('sessions');
  check('8: /sessions with none', /^No related sessions\./.test(c.notice), c);
  rt.setForeground(S);

  // ---- 9: RPC and service ----
  const rel = await app.invokeRpc('sessions.related', [S]);
  check('9: related: children oldest first, with mergedInto', rel.parent === null && rel.children.map((x) => x.id).join() === [S1.id, s2, s3].join() && rel.children[0].mergedInto === S && Array.isArray(rel.forks), rel.children.map((x) => x.title));
  const relC = await app.invokeRpc('sessions.related', [C]);
  check('9: related of a child: its parent', relC.parent?.id === P && relC.children[0]?.id === G);
  const relP = service.related(P);
  check('9: forks listed', relP.forks.map((x) => x.id).includes(F.id));
  reply('[V1]', { content: 'via rpc' });
  const sp = await app.invokeRpc('sessions.spawn', [S, { title: 'Via RPC', prompt: 'rpc [V1]' }]);
  check('9: sessions.spawn returns the meta', sp.parentId === S && sp.origin === 'spawn' && sp.title === 'Via RPC' && sp.status?.running === true, sp);
  await allIdle();
  const msg = await app.invokeRpc('sessions.message', [S, sp.id, 'rpc hello']);
  check('9: sessions.message delivers', msg.ok === true && of(sp.id, 'user_message').some((e) => /rpc hello/.test(e.text)), msg);
  await allIdle();
  const bad = await app.invokeRpc('sessions.message', [S, 'nope', 'x']);
  check('9: sessions.message to an unknown id', bad.ok === false && /No session/.test(bad.error), bad);
  const sm = await service.merge(S, sp.id);
  check('9: service.merge', sm.ok === true && rt.get(sp.id).mergedInto === S, sm);
  let sThrew = '';
  try {
    await app.invokeRpc('sessions.spawn', [S, { title: '', prompt: 'x' }]);
  } catch (err) {
    sThrew = err.message;
  }
  check('9: sessions.spawn without a title rejects', /needs a title/.test(sThrew), sThrew);
  const sv = service.spawn(lone, { title: 'From service', prompt: 'svc [W1]' });
  check('9: service.spawn', sv.parentId === lone);
  await allIdle();

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
