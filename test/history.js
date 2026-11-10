// The history log, crash recovery, the trash, search and export, headless: the real App (store, runtime, agents)
// against the mock model, temp folders. Run: node test/history.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { createHistory, RECOVERED_NOTICE } = require(path.join(projectDir, 'dist/main/history/service.js'));
const { replayConversation, missingToolResults, INTERRUPTED_RESULT } = require(path.join(projectDir, 'dist/main/history/replay.js'));
const { parseLog } = require(path.join(projectDir, 'dist/main/history/log.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { rewindSession } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

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
const DAY = 24 * 60 * 60 * 1000;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-history-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  const baseConfig = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock-model', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: project, permissionMode: 'ask', autoApprove: false, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, pruneToolResults: false, notifications: false, allowRules: {}, recentDirs: [], historyTrashDays: 30,
  };

  /** One app with history on a user-data folder; `clock` is shared so tests can move time. */
  const clock = { now: Date.now() };
  const opened = [];
  function open(userData, extra = {}) {
    let cfg = { ...baseConfig, ...(extra.config || {}) };
    const app = createApp({
      userData,
      appRoot: projectDir,
      loadConfig: () => cfg,
      saveConfig: (c) => (cfg = c),
      artifacts: new ArtifactStore({ root: path.join(userData, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }),
    });
    const sent = [];
    app.setWindow({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } });
    const history = createHistory(app, { now: () => clock.now, noticeDelayMs: 5, chooseExportPath: extra.choose });
    const h = { app, history, sent, rt: app.runtime, store: app.store };
    opened.push(h);
    return h;
  }
  const close = (h) => h.history.dispose();
  const recordsOf = (h, id) => h.history.log.read(id);
  const typesOf = (recs) => recs.map((r) => r.type);
  let callId = 0;
  const call = (name, args) => ({ id: `c${++callId}`, name, args });

  // ---- 1: a scripted run produces exactly the expected records; seq is contiguous and continues after a re-open ----
  const ud1 = path.join(tmp, 'ud1');
  let h = open(ud1);
  const A = h.rt.foregroundId();
  check('1: an empty session has no log yet', !h.history.log.exists(A));
  const bash = call('bash', { command: 'echo logged' });
  state.replies.push({ content: 'Running it.', toolCalls: [bash] });
  state.replies.push({ content: 'It printed logged.' });
  h.rt.send(A, 'first turn');
  await waitFor(() => h.rt.live(A).approvals.length === 1, 5000, 'the approval card');
  h.rt.respondApproval(h.rt.live(A).approvals[0].id, true, false);
  await waitFor(() => !h.rt.isRunning(A), 5000, 'run 1');
  state.replies.push({ content: 'Second answer.' });
  h.rt.send(A, 'second turn');
  await waitFor(() => !h.rt.isRunning(A), 5000, 'run 2');
  let recs = recordsOf(h, A);
  const expected = [
    'session.created',
    // the user's message, then (the first time) the session's context note before the model call
    'message.append', 'run.start', 'snapshot', 'message.append', 'usage', 'message.append', 'tool.start', 'approval.request', 'approval.resolved', 'tool.end', 'message.append', 'usage', 'message.append', 'snapshot', 'run.end',
    'message.append', 'run.start', 'snapshot', 'usage', 'message.append', 'snapshot', 'run.end',
  ];
  check('1: the record types of two runs (tool call with approval) are exactly as expected', same(typesOf(recs), expected), typesOf(recs).join(' '));
  check('1: seq is contiguous from 1', recs.every((r, i) => r.seq === i + 1 && r.v === 1 && typeof r.t === 'number'));
  const runStart = recs.find((r) => r.type === 'run.start');
  check('1: run.start carries the origin', runStart.data.origin === 'user', runStart.data);
  const toolEnd = recs.find((r) => r.type === 'tool.end');
  check('1: tool.end has ok, durationMs and the result length, not the text', toolEnd.data.ok === true && typeof toolEnd.data.durationMs === 'number' && toolEnd.data.chars === h.store.get(A).messages[3].content.length && !('result' in toolEnd.data), toolEnd.data);
  check('1: approval records', recs.find((r) => r.type === 'approval.request').data.name === 'bash' && recs.find((r) => r.type === 'approval.resolved').data.ok === true);
  check('1: run.end has the reason and the text', same(recs.filter((r) => r.type === 'run.end').map((r) => r.data), [{ reason: 'done', text: 'It printed logged.' }, { reason: 'done', text: 'Second answer.' }]));
  check('1: the log replays to the session exactly', same(replayConversation(recs).messages, h.store.get(A).messages));
  // Thinking, notices and the other event records, through the runtime's own dispatch
  const dispatch = (id, ev) => h.rt['dispatch'](id, ev);
  dispatch(A, { type: 'thinking_delta', text: 'hmm ' });
  clock.now += 40;
  dispatch(A, { type: 'thinking_delta', text: 'yes' });
  dispatch(A, { type: 'text_delta', text: 'not logged' });
  dispatch(A, { type: 'context', context: { tokens: 1, limit: 2 } });
  dispatch(A, { type: 'thinking_done' });
  dispatch(A, { type: 'error', kind: 'notice', message: 'a notice' });
  dispatch(A, { type: 'error', message: 'an error' });
  dispatch(A, { type: 'plan_proposed', plan: { id: 'p1', title: 'Plan', markdown: 'x', status: 'proposed', createdAt: 1 } });
  dispatch(A, { type: 'tasks_updated', tasks: [{ id: 't1', title: 'task', status: 'pending' }] });
  dispatch(A, { type: 'compact_end', compaction: { id: 'k1', createdAt: 1, reason: 'manual', tokensBefore: 10, tokensAfter: 2, summary: 'S', messages: 3 } });
  recs = recordsOf(h, A);
  const tail = recs.slice(expected.length);
  check('1: thinking is one record with the text and its duration; deltas and context are not logged', same(typesOf(tail), ['thinking', 'notice', 'error', 'plan', 'tasks', 'compaction']) && tail[0].data.text === 'hmm yes' && tail[0].data.ms === 40, tail.map((r) => [r.type, r.data]));
  h.history.record(A, 'session.merged', { from: 'x', title: 'Other' });
  const lastSeq = recordsOf(h, A).pop().seq;
  close(h);
  h = open(ud1);
  h.store.rename(A, 'Renamed after restart');
  recs = recordsOf(h, A);
  check('1: seq continues after the store is re-opened', recs.slice(-2).map((r) => r.seq).join() === `${lastSeq + 1},${lastSeq + 2}` && same(typesOf(recs.slice(-2)), ['session.renamed', 'snapshot']), recs.slice(-3).map((r) => [r.seq, r.type]));
  check('1: the re-opened app recovered nothing', h.history.recovered().length === 0);
  check('1: the service is provided', h.app.service('history') === h.history);
  close(h);

  // ---- 2: a rewind and a compaction leave every message in the log; replay reproduces the session ----
  const ud2 = path.join(tmp, 'ud2');
  h = open(ud2, { config: { permissionMode: 'bypass' } });
  const B = h.rt.foregroundId();
  // Long enough that a brief is smaller than what it folds: compaction refuses a summary that saves nothing.
  const filler = ' ' + 'The quick brown fox jumps over the lazy dog. '.repeat(40);
  for (const n of [1, 2, 3, 4]) {
    state.replies.push({ content: `answer ${n}${filler}` });
    h.rt.send(B, `question ${n}${filler}`);
    await waitFor(() => !h.rt.isRunning(B), 5000, `run ${n}`);
  }
  const before = structuredClone(h.store.get(B).messages);
  rewindSession(h.store.get(B), project, 2, h.store); // back to before "question 3"
  h.store.save(h.store.get(B), false);
  check('2: the rewind cut the session', h.store.get(B).messages.length === 5);
  state.summary = '## Request\nSUMMARY OF Q1 Q2, a brief that is long enough to be used.';
  const r2 = await h.rt.agentFor(B).compactNow();
  check('2: the compaction ran', r2.ok, r2);
  recs = recordsOf(h, B);
  const appended = recs.filter((r) => r.type === 'message.append').map((r) => r.data.message);
  check('2: every original message is still in the log after rewind + compaction', before.every((m) => appended.some((a) => same(a, m))));
  const trunc = recs.find((r) => r.type === 'messages.truncate');
  check('2: the truncate record holds the length and the count removed', trunc && trunc.data.length === 5 && trunc.data.removed === 4, trunc && trunc.data);
  const repl = recs.find((r) => r.type === 'messages.replace');
  // A compaction folds the older part into a brief and keeps the last request onward word for word.
  const kept = repl ? repl.data.messages.slice(1) : [];
  check('2: the replace record holds the reason, the new messages (the brief, then the kept tail) and the count removed', repl && repl.data.reason === 'compaction' && repl.data.removed === 5 && String(repl.data.messages[0].content).startsWith('[Context compacted]') && kept.length >= 1 && kept.every((m) => before.some((b) => same(b, m))), repl && { ...repl.data, messages: repl.data.messages.length });
  check('2: replaying the log from nothing reproduces the current messages exactly', same(replayConversation(recs).messages, h.store.get(B).messages));
  // A replace with any other reason (the compaction engineer's 'prune') is logged and replayed the same way
  const pruned = h.store.get(B).messages.map((m) => ({ ...m }));
  h.store.replaceAll(h.store.get(B), [...pruned, { role: 'user', content: 'after prune' }], 'prune');
  h.store.save(h.store.get(B), false);
  check('2: a prune replace replays too', same(replayConversation(recordsOf(h, B)).messages, h.store.get(B).messages) && recordsOf(h, B).some((r) => r.type === 'messages.replace' && r.data.reason === 'prune'));
  // A fork's log carries its seed, so it replays on its own
  const fork = h.store.fork(B);
  check('2: a fork logs created, forked and its seed', same(typesOf(recordsOf(h, fork.id)), ['session.created', 'session.forked', 'messages.replace', 'snapshot']) && recordsOf(h, fork.id)[1].data.from === B && same(replayConversation(recordsOf(h, fork.id)).messages, fork.messages));
  close(h);

  // A session from before the log existed gets a baseline the first time it changes
  const ud2b = path.join(tmp, 'ud2b');
  fs.mkdirSync(path.join(ud2b, 'sessions'), { recursive: true });
  const old = { id: 'old-session', title: 'Old one', createdAt: 1000, updatedAt: 2000, messages: [{ role: 'user', content: 'old q' }, { role: 'assistant', content: 'old a' }] };
  fs.writeFileSync(path.join(ud2b, 'sessions', 'old-session.json'), JSON.stringify(old));
  h = open(ud2b);
  h.store.append(h.store.get('old-session'), { role: 'user', content: 'new q' });
  recs = recordsOf(h, 'old-session');
  check('2: a pre-log session starts its log with a baseline, then the append', same(typesOf(recs), ['session.created', 'messages.replace', 'message.append']) && recs[1].data.reason === 'baseline' && recs[1].data.messages.length === 2 && same(replayConversation(recs).messages, h.store.get('old-session').messages));
  close(h);

  // ---- 3: crash recovery at each interesting point ----
  const ud3 = path.join(tmp, 'ud3');
  h = open(ud3, { config: { permissionMode: 'bypass' } });
  const C = h.rt.foregroundId();
  const t1 = call('bash', { command: 'echo one' });
  state.replies.push({ content: 'Calling.', toolCalls: [t1] });
  state.replies.push({ content: 'All done.' });
  h.rt.send(C, 'crash me');
  await waitFor(() => !h.rt.isRunning(C), 5000, 'the crash run');
  const full = recordsOf(h, C);
  const fullLines = fs.readFileSync(h.history.log.file(C), 'utf8').split('\n').filter(Boolean);
  const sessionFinal = structuredClone(h.store.get(C));
  close(h);
  const idxOf = (pred, from = 0) => full.findIndex((r, i) => i >= from && pred(r));
  const userAt = idxOf((r) => r.type === 'message.append');
  const toolStartAt = idxOf((r) => r.type === 'tool.start');
  const toolResultAt = idxOf((r) => r.type === 'message.append' && r.data.message.role === 'tool');
  const lastAssistantAt = idxOf((r) => r.type === 'message.append' && r.data.message.role === 'assistant' && !r.data.message.tool_calls);
  const cuts = [
    { name: 'after the user message', keep: userAt + 1 },
    { name: 'after the save at run start', keep: userAt + 3 },
    { name: 'mid tool call', keep: toolStartAt + 1 },
    { name: 'after a tool result', keep: toolResultAt + 1 },
    { name: 'after the last assistant message', keep: lastAssistantAt + 1 },
    { name: 'with a torn last line', keep: toolStartAt + 1, torn: true },
  ];
  for (const cut of cuts) {
    const ud = path.join(tmp, `crash-${cut.name.replace(/\W+/g, '-')}`);
    fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(ud, 'history'), { recursive: true });
    const kept = full.slice(0, cut.keep);
    // The session file is what the last snapshot before the cut wrote.
    let snapAt = -1;
    kept.forEach((r, i) => r.type === 'snapshot' && (snapAt = i));
    const fileMsgs = snapAt >= 0 ? replayConversation(kept.slice(0, snapAt + 1)).messages : null;
    if (fileMsgs) fs.writeFileSync(path.join(ud, 'sessions', `${C}.json`), JSON.stringify({ ...sessionFinal, messages: fileMsgs }));
    let text = fullLines.slice(0, cut.keep).join('\n') + '\n';
    if (cut.torn) text += fullLines[cut.keep].slice(0, 25);
    fs.writeFileSync(path.join(ud, 'history', `${C}.jsonl`), text);
    const logged = replayConversation(kept).messages;
    const h1 = open(ud);
    const s1 = h1.store.get(C);
    const msgs1 = s1 ? structuredClone(s1.messages) : [];
    const tag = `3 (${cut.name})`;
    check(`${tag}: the session has every logged message, in order, without duplicates`, msgs1.length >= logged.length && same(msgs1.slice(0, logged.length), logged) && msgs1.slice(logged.length).every((m) => m.role === 'tool' && m.content === INTERRUPTED_RESULT), { logged: logged.length, now: msgs1.length });
    check(`${tag}: the tail is well formed`, missingToolResults(msgs1).length === 0);
    const r1 = recordsOf(h1, C);
    const openRun = kept.some((r) => r.type === 'run.start') && !kept.some((r) => r.type === 'run.end');
    check(`${tag}: an unfinished run is closed as interrupted`, !openRun || r1.some((r) => r.type === 'run.end' && r.data.reason === 'interrupted'));
    check(`${tag}: the log still replays to the session`, same(replayConversation(r1).messages, msgs1));
    check(`${tag}: seq stays contiguous${cut.torn ? ' past the torn line' : ''}`, r1.every((r, i) => r.seq === i + 1), r1.map((r) => r.seq).join());
    check(`${tag}: it is remembered as recovered`, h1.history.recovered().includes(C) === openRun || !openRun);
    const logBytes = fs.statSync(h1.history.log.file(C)).size;
    close(h1);
    const h2 = open(ud);
    check(`${tag}: a second re-open changes nothing`, same(h2.store.get(C).messages, msgs1) && fs.statSync(h2.history.log.file(C)).size === logBytes);
    if (cut.name === 'mid tool call') {
      // The notice: shown once, the next time the session comes on screen
      h2.rt.setForeground(C);
      await sleep(30);
      const notices = h2.sent.filter(([ch, ev, id]) => ch === 'agent:event' && ev.type === 'error' && ev.kind === 'notice' && ev.message === RECOVERED_NOTICE && id === C);
      check('3: the recovered session gets the notice when it is opened', notices.length === 1);
      h2.rt.setForeground(h2.rt.create().id);
      h2.rt.setForeground(C);
      await sleep(30);
      check('3: only once', h2.sent.filter(([, ev]) => ev && ev.message === RECOVERED_NOTICE).length === 1 && !h2.history.recovered().includes(C));
      // The recovered session takes a follow-up normally
      state.replies.push({ content: 'Follow-up works.' });
      h2.rt.send(C, 'follow up');
      await waitFor(() => !h2.rt.isRunning(C), 5000, 'the follow-up');
      check('3: a follow-up after recovery runs', h2.store.get(C).messages.at(-1).content === 'Follow-up works.' && same(replayConversation(recordsOf(h2, C)).messages, h2.store.get(C).messages));
    }
    close(h2);
  }

  // A log and no session file: the session is recreated
  {
    const ud = path.join(tmp, 'crash-no-file');
    fs.mkdirSync(path.join(ud, 'history'), { recursive: true });
    fs.writeFileSync(path.join(ud, 'history', `${C}.jsonl`), fullLines.join('\n') + '\n');
    const h1 = open(ud);
    const s1 = h1.store.get(C);
    check('3: a session with a log and no session file is recreated with all its messages', s1 && same(s1.messages, sessionFinal.messages) && fs.existsSync(path.join(ud, 'sessions', `${C}.json`)), s1 && s1.messages.length);
    check('3: …with its title and folder, listed', s1 && s1.title === sessionFinal.title && s1.cwd === sessionFinal.cwd && h1.store.list().some((m) => m.id === C), s1 && [s1.title, s1.cwd]);
    close(h1);
    const h2 = open(ud);
    check('3: recreating is idempotent', same(h2.store.get(C).messages, sessionFinal.messages));
    close(h2);
  }

  // ---- 4: trash, restore, purge, retention ----
  const ud4 = path.join(tmp, 'ud4');
  h = open(ud4, { config: { permissionMode: 'bypass' } });
  const mk = (title, n = 2) => {
    const s = h.store.create({ title });
    for (let i = 0; i < n; i++) h.store.append(s, { role: i % 2 ? 'assistant' : 'user', content: `${title} message ${i}` });
    h.store.save(s);
    return s;
  };
  const D = mk('Doomed session', 3);
  const artDir = path.join(ud4, 'artifacts', D.id);
  fs.mkdirSync(path.join(artDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(artDir, 'images', 'pic.png'), 'PNGDATA');
  clock.now = Date.parse('2026-01-01T00:00:00Z');
  h.rt.forget(D.id);
  h.store.delete(D.id);
  h.app.artifacts.remove(D.id); // what the core's delete path does next
  const tdir = path.join(ud4, 'trash', D.id);
  check('4: delete moves the session, its log and its artifacts to the trash', fs.existsSync(path.join(tdir, 'session.json')) && fs.existsSync(path.join(tdir, 'history.jsonl')) && fs.readFileSync(path.join(tdir, 'artifacts', 'images', 'pic.png'), 'utf8') === 'PNGDATA');
  check('4: …and nothing is left in place', !fs.existsSync(path.join(ud4, 'sessions', `${D.id}.json`)) && !h.history.log.exists(D.id) && !fs.existsSync(artDir) && !h.store.get(D.id));
  const meta = JSON.parse(fs.readFileSync(path.join(tdir, 'meta.json'), 'utf8'));
  check('4: meta.json has deletedAt, the title and the message count', meta.deletedAt === clock.now && meta.title === 'Doomed session' && meta.messageCount === 3, meta);
  let list = await h.app.invokeRpc('history.trash', []);
  check('4: history.trash lists it with its purge date and size', list.length === 1 && list[0].id === D.id && list[0].purgeAt === clock.now + 30 * DAY && list[0].bytes > 0, list);
  check('4: the log ends with session.deleted', typesOf(parseLog(fs.readFileSync(path.join(tdir, 'history.jsonl'), 'utf8'))).pop() === 'session.deleted');
  h.sent.length = 0;
  const restored = await h.app.invokeRpc('history.restore', [D.id]);
  await sleep(60);
  check('4: restore brings it back into the store with its messages', restored.id === D.id && h.store.get(D.id)?.messages.length === 3 && h.store.list().some((m) => m.id === D.id));
  check('4: …its files are back and the trash entry is gone', fs.existsSync(path.join(ud4, 'sessions', `${D.id}.json`)) && fs.existsSync(path.join(artDir, 'images', 'pic.png')) && !fs.existsSync(tdir));
  check('4: …sessions:changed is pushed with it', h.sent.some(([ch, channel, payload]) => ch === 'rpc:push' && channel === 'sessions:changed' && payload.some((m) => m.id === D.id)));
  recs = recordsOf(h, D.id);
  check('4: …the log continues with session.restored and a snapshot', same(typesOf(recs).slice(-3), ['session.deleted', 'session.restored', 'snapshot']) && recs.every((r, i) => r.seq === i + 1));
  let threw = false;
  try {
    await h.app.invokeRpc('history.restore', [D.id]);
  } catch {
    threw = true;
  }
  check('4: restoring a live session is refused', threw);
  // Purge one, purge all
  const E = mk('Purge me');
  const F = mk('Purge me too');
  h.store.delete(E.id);
  h.store.delete(F.id);
  check('4: two in the trash', (await h.app.invokeRpc('history.trash', [])).length === 2);
  list = await h.app.invokeRpc('history.purge', [E.id]);
  check('4: purge(id) removes one for good', list.length === 1 && list[0].id === F.id && !fs.existsSync(path.join(ud4, 'trash', E.id)));
  list = await h.app.invokeRpc('history.purge', []);
  check('4: purge() removes all', list.length === 0);
  // Retention with an injected clock
  const G = mk('Old trash');
  h.store.delete(G.id);
  clock.now += 29 * DAY;
  check('4: the sweep keeps an entry younger than historyTrashDays', h.history.sweep().length === 0 && h.history.trashList().length === 1);
  clock.now += 2 * DAY;
  check('4: the sweep removes it once it is older', same(h.history.sweep(), [G.id]) && h.history.trashList().length === 0);
  const H = mk('Swept at start-up');
  h.store.delete(H.id);
  close(h);
  clock.now += 31 * DAY;
  h = open(ud4);
  check('4: entries past their date are purged at start-up', h.history.trashList().length === 0 && !fs.existsSync(path.join(ud4, 'trash', H.id)));
  // historyTrashDays 0: removed at once
  h.app.updateConfig({ historyTrashDays: 0 });
  const I = mk('Gone at once');
  fs.mkdirSync(path.join(ud4, 'artifacts', I.id), { recursive: true });
  h.store.delete(I.id);
  check('4: with historyTrashDays 0 a delete removes everything at once', !fs.existsSync(path.join(ud4, 'trash', I.id)) && !h.history.log.exists(I.id) && !fs.existsSync(path.join(ud4, 'artifacts', I.id)) && !fs.existsSync(path.join(ud4, 'sessions', `${I.id}.json`)));
  const stats = await h.app.invokeRpc('history.stats', []);
  check('4: history.stats', stats.sessions === h.store.list().length && stats.bytes > 0 && stats.trash === 0 && stats.trashBytes === 0 && stats.dir === path.join(ud4, 'history'), stats);
  close(h);

  // ---- 5: search ----
  const ud5 = path.join(tmp, 'ud5');
  h = open(ud5);
  clock.now = Date.now();
  const add = (title, msgs, at) => {
    const s = h.store.create({ title });
    for (const m of msgs) h.store.append(s, m);
    clock.now = at;
    h.store.save(s);
    s.updatedAt = at;
    return s;
  };
  const t0 = Date.parse('2026-06-01T00:00:00Z');
  const S1 = add('Refactor the parser', [{ role: 'user', content: 'Please look at tokenizer edge cases' }, { role: 'assistant', content: 'The tokenizer drops a trailing quote.' }], t0 + 1000);
  const S2 = add('Database work', [
    { role: 'user', content: 'Migrate the users table' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'q1', type: 'function', function: { name: 'bash', arguments: '{"command":"psql -c \\"ALTER TABLE users\\""}' } }] },
    { role: 'tool', tool_call_id: 'q1', content: 'ALTER TABLE ok' },
    { role: 'assistant', content: 'Migrated the users table; the tokenizer is not involved.' },
  ], t0 + 2000);
  const S3 = add('Compacted one', [{ role: 'user', content: '[Context compacted]\nsummary' }], t0 + 3000);
  S3.compactions = [{ id: 'k', createdAt: 1, reason: 'manual', tokensBefore: 1, tokensAfter: 1, summary: 'summary', messages: 2, folded: [{ role: 'user', content: 'An ancient question about zebras' }, { role: 'assistant', content: 'Zebras have stripes.' }] }];
  h.store.save(S3, false);
  const search = (q, o) => h.app.invokeRpc('history.search', [q, o]);
  let hits = await search('PARSER');
  check('5: a title match, case-insensitive', hits.length === 1 && hits[0].sessionId === S1.id && hits[0].role === 'title' && hits[0].snippet.slice(hits[0].matchStart, hits[0].matchEnd) === 'parser', hits);
  hits = await search('tokenizer');
  check('5: one hit per session, newest first', same(hits.map((x) => x.sessionId), [S2.id, S1.id]), hits.map((x) => x.title));
  check('5: the most recent matching message is the hit, with the count', hits[1].role === 'assistant' && /trailing quote/.test(hits[1].snippet) && hits[1].count === 2, hits[1]);
  hits = await search('alter users');
  check('5: multi-word: every word in the same message (a tool call or result)', hits.length === 1 && hits[0].sessionId === S2.id && hits[0].role === 'tool', hits);
  hits = await search('migrate tokenizer');
  check('5: words in different messages do not match', hits.length === 1 && hits[0].role === 'assistant' && /Migrated/.test(hits[0].snippet), hits);
  hits = await search('zebras');
  check('5: folded messages are searched and marked archived', hits.length === 1 && hits[0].sessionId === S3.id && hits[0].archived === true && hits[0].count === 2, hits);
  check('5: no match, empty query', (await search('nothing-like-this')).length === 0 && (await search('   ')).length === 0);
  const long = 'x'.repeat(300) + ' NEEDLE ' + 'y'.repeat(300);
  add('Long one', [{ role: 'user', content: long }], t0 + 4000);
  hits = await search('needle');
  const sn = hits[0];
  check('5: the snippet is about 160 characters around the match, with the offsets', sn.snippet.length <= 164 && sn.snippet.length >= 150 && sn.snippet.startsWith('…') && sn.snippet.endsWith('…') && sn.snippet.slice(sn.matchStart, sn.matchEnd) === 'NEEDLE', [sn.snippet.length, sn.matchStart, sn.matchEnd]);
  for (let i = 0; i < 40; i++) add(`Common ${i}`, [{ role: 'user', content: 'common words here' }], t0 + 5000 + i);
  check('5: the default limit is 30, and limit is honoured', (await search('common')).length === 30 && (await search('common', { limit: 5 })).length === 5);
  // The cache: filled by a query, dropped when the session changes
  await search('tokenizer');
  check('5: a query fills the per-session cache', h.history.index.cached(S1.id));
  h.store.append(S1, { role: 'user', content: 'a brand new platypus' });
  check('5: a change drops that session\'s cache', !h.history.index.cached(S1.id) && h.history.index.cached(S2.id));
  hits = await search('platypus');
  check('5: and the next query sees the change', hits.length === 1 && hits[0].sessionId === S1.id);
  // The trash flag
  h.store.delete(S2.id);
  check('5: a trashed session is not found by default', (await search('alter users')).length === 0);
  hits = await search('alter users', { includeTrash: true });
  check('5: includeTrash finds it, marked trashed', hits.length === 1 && hits[0].sessionId === S2.id && hits[0].trashed === true, hits);
  close(h);

  // Timing: 300 sessions of 200 messages, written as session files (as if from an earlier run)
  const ud6 = path.join(tmp, 'ud6');
  fs.mkdirSync(path.join(ud6, 'sessions'), { recursive: true });
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november'];
  for (let i = 0; i < 300; i++) {
    const messages = [];
    for (let j = 0; j < 200; j++) {
      const text = `Message ${j} of session ${i}: ${words[(i * 7 + j) % words.length]} ${words[(i + j * 3) % words.length]} with some filler text so that each message is about the length of a real one, maybe a little shorter.`;
      if (j % 4 === 1) messages.push({ role: 'assistant', content: text, tool_calls: [{ id: `t${j}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/file${j}.ts` }) } }] });
      else if (j % 4 === 2) messages.push({ role: 'tool', tool_call_id: `t${j - 1}`, content: text.repeat(3) });
      else messages.push({ role: j % 4 === 0 ? 'user' : 'assistant', content: text });
    }
    fs.writeFileSync(path.join(ud6, 'sessions', `s${i}.json`), JSON.stringify({ id: `s${i}`, title: `Synthetic ${i}`, createdAt: i, updatedAt: 1000 + i, messages }));
  }
  h = open(ud6);
  let tq = process.hrtime.bigint();
  hits = h.history.search('juliet filler');
  const cold = Number(process.hrtime.bigint() - tq) / 1e6;
  tq = process.hrtime.bigint();
  const hits2 = h.history.search('juliet filler');
  const warm = Number(process.hrtime.bigint() - tq) / 1e6;
  tq = process.hrtime.bigint();
  h.history.search('november session 299');
  const warm2 = Number(process.hrtime.bigint() - tq) / 1e6;
  console.log(`timing: 300 sessions x 200 messages: cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms, warm (other query) ${warm2.toFixed(1)} ms`);
  check('5: the timing query finds hits (one per session, limit 30)', hits.length === 30 && same(hits, hits2), hits.length);
  check('5: a warm query over 300 x 200 messages stays fast (< 100 ms)', warm < 100 && warm2 < 100, { cold, warm, warm2 });
  close(h);

  // ---- 6: export ----
  const ud7 = path.join(tmp, 'ud7');
  const outDir = path.join(tmp, 'exports');
  fs.mkdirSync(outDir);
  let choice = (name) => path.join(outDir, name);
  h = open(ud7, { choose: (name, format) => choice(name, format), config: { permissionMode: 'bypass' } });
  const X = h.rt.foregroundId();
  const tx = call('bash', { command: 'echo exported' });
  state.replies.push({ content: 'Let me run it.', toolCalls: [tx] });
  state.replies.push({ content: 'Exported fine.' });
  h.rt.send(X, 'export test question');
  await waitFor(() => !h.rt.isRunning(X), 5000, 'the export run');
  const xs = h.store.get(X);
  xs.compactions = [{ id: 'k', createdAt: 1, reason: 'auto', tokensBefore: 9, tokensAfter: 1, summary: 'THE SUMMARY', messages: 1, folded: [{ role: 'user', content: [{ type: 'text', text: 'folded question' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }];
  h.store.save(xs, false);
  const md = await h.app.invokeRpc('history.export', [X, 'markdown']);
  const mdText = fs.readFileSync(md, 'utf8');
  check('6: markdown: written where chosen, .md', md.endsWith('.md') && path.dirname(md) === outDir, md);
  check('6: markdown: title, folder, model, user, assistant, tool call with its result, compaction with summary, folded messages, [image]', [`# ${xs.title}`, `Folder: ${project}`, 'Model: mock-model', '## User', 'export test question', '## Assistant', 'Exported fine.', '### Tool: bash', 'echo exported', 'Result:', 'exported', 'Context compacted', 'THE SUMMARY', 'folded question', '[image]'].every((s) => mdText.includes(s)) && mdText.indexOf('folded question') < mdText.indexOf('THE SUMMARY') && mdText.indexOf('THE SUMMARY') < mdText.indexOf('## User\n\nexport test question') && !mdText.includes('base64'), mdText.slice(0, 600));
  const js = await h.app.invokeRpc('history.export', [X, 'json']);
  check('6: json: the session object as stored', js.endsWith('.json') && same(JSON.parse(fs.readFileSync(js, 'utf8')), JSON.parse(fs.readFileSync(path.join(ud7, 'sessions', `${X}.json`), 'utf8'))));
  const jl = await h.app.invokeRpc('history.export', [X, 'jsonl']);
  check('6: jsonl: the raw log', jl.endsWith('.jsonl') && fs.readFileSync(jl, 'utf8') === fs.readFileSync(h.history.log.file(X), 'utf8'));
  choice = () => null;
  check('6: a cancelled export returns null', (await h.app.invokeRpc('history.export', [X, 'markdown'])) === null);
  close(h);

  for (const o of opened) o.history.dispose();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
