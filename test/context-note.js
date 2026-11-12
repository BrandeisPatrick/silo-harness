// The session's context note (agent/prompt.ts contextNote): what changes during a session (the mode, the folder and
// date, the session's name and parent) is an appended user-role note, so the system prompt stays byte for byte the
// same and a provider's prompt cache keeps it. One note per change, none per turn, a note again after a compaction,
// and every request's messages a prefix of the next one's.
// Run: node test/context-note.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { createApp } = dist('app.js');
const { setupSubagents } = dist('subagents.js');
const { Agent } = dist('agent.js');
const { toTranscript } = dist('sessions.js');
const { ArtifactStore } = dist('artifacts.js');
const C = dist('compact.js');
const P = dist('agent/prompt.js');
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-context-note-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  let config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: project, permissionMode: 'ask', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [], toolSet: 'all',
  };
  const app = createApp({
    userData: tmp,
    appRoot: projectDir,
    loadConfig: () => config,
    saveConfig: (c) => (config = c),
    browser: () => null,
    artifacts: new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }),
  });
  // The session-name section is a per-session one: it lives in the note
  setupSubagents(app);
  const store = app.store;
  const session = store.create();
  const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], () => {}, undefined, undefined, undefined, {
    session,
    app,
    tools: () => app.tools.list(),
    prompt: (info) => app.promptFor(info),
  });
  const streams = () => state.requests.filter((r) => r.url === '/v1/chat/completions' && r.payload.stream).map((r) => r.payload);
  const notesIn = (msgs) => msgs.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(C.CONTEXT_NOTE_PREFIX));
  const turn = async (text, reply = { content: 'ok' }) => {
    state.replies.push(reply);
    await agent.run(text);
  };

  // ---- 1: the first call gets the note, after the message; later turns add none ----
  await turn('one');
  await turn('two', { content: '', toolCalls: [{ id: 'c1', name: 'list_directory', args: { path: '.' } }] });
  state.replies.push({ content: 'listed' });
  await turn('three');
  const reqs = streams();
  const system = reqs.map((p) => p.messages[0].content);
  check('1: the first request: system, the note, then the message (stored after it)', reqs[0].messages.map((m) => m.role).join() === 'system,user,user' && C.isContextNote(reqs[0].messages[1]) && reqs[0].messages[2].content === 'one' && notesIn(reqs[0].messages).length === 1 && C.isContextNote(session.messages[1]));
  check('1: the note says where and when, and what the session is named', /Working directory: /.test(notesIn(reqs[0].messages)[0].content) && /Today: \d{4}-\d{2}-\d{2}/.test(notesIn(reqs[0].messages)[0].content) && /This session is named/.test(notesIn(reqs[0].messages)[0].content));
  check('1: the system prompt has none of it', !/Working directory:|Today:|This session is named/.test(system[0]));
  check('1: no note per turn or per call: still one after three runs and a tool loop', notesIn(session.messages).length === 1 && reqs.length === 4, reqs.length);
  check('1: the transcript does not show the note', toTranscript(session).filter((i) => i.role === 'user').map((i) => i.text).join() === 'one,two,three');

  // ---- 2: a mode switch, leaving the mode, a rename and a new day: one note each, the system prompt unchanged ----
  config = { ...config, permissionMode: 'auto' };
  await turn('in auto');
  config = { ...config, permissionMode: 'ask' };
  await turn('back in ask');
  store.rename(session.id, 'Renamed session');
  await turn('after the rename');
  const RealDate = Date;
  const tomorrow = new RealDate(RealDate.now() + 86_400_000);
  global.Date = class extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [tomorrow.getTime()]));
    }
    static now() {
      return tomorrow.getTime();
    }
  };
  await turn('the next day');
  await turn('nothing changed');
  // (back to the real date after the checks below, which is a change of its own)
  const all = streams();
  const notes = notesIn(session.messages).map((m) => m.content);
  check('2: one note per change: auto, back to ask, the rename, the new day', notes.length === 5, notes.map((n) => P.contextNoteState(n).replace(/Working directory: .*\n/, '').slice(0, 90)));
  check('2: the Auto mode note has its paragraph', /AUTO MODE: /.test(notes[1]) && /Blocked by Auto mode/.test(notes[1]));
  check('2: leaving Auto mode is said in so many words', notes[2].includes(P.AUTO_ENDED) && !/AUTO MODE: /.test(notes[2]), notes[2]);
  check('2: the rename note has the new name, and no "is over" line again', /named "Renamed session"/.test(notes[3]) && !notes[3].includes(P.AUTO_ENDED));
  check('2: the new day note has tomorrow\'s date', notes[4].includes(`Today: ${tomorrow.toISOString().slice(0, 10)}`));
  check('2: the system prompt is byte-identical across the mode switch, the rename and the date change', all.every((p) => p.messages[0].content === system[0]), [...new Set(all.map((p) => p.messages[0].content.length))]);
  // Append-only: every request's messages are the start of the next one's, byte for byte
  const prefixOk = all.every((p, i) => i === 0 || JSON.stringify(all[i - 1].messages) === JSON.stringify(p.messages.slice(0, all[i - 1].messages.length)));
  check('2: every request is the one before plus what was appended', prefixOk);
  global.Date = RealDate;
  // In auto mode the tools are the same; plan mode changes them (accepted), which the system prompt does not follow
  config = { ...config, permissionMode: 'plan' };
  await turn('plan it', { content: 'a plan' });
  config = { ...config, permissionMode: 'ask' };
  await turn('build it');
  const planNotes = notesIn(session.messages).map((m) => m.content).slice(-2);
  check('2: plan mode and its end, each a note', /PLAN MODE: /.test(planNotes[0]) && planNotes[1].includes(P.PLAN_ENDED), planNotes.map((n) => n.slice(0, 80)));
  check('2: the system prompt stays the same in plan mode too', streams().every((p) => p.messages[0].content === system[0]));

  // ---- 3: pure helpers ----
  const st = P.sessionContext({ ...config, permissionMode: 'plan' }, { shared: '', session: 'Named X.' });
  const n1 = P.contextNote(st);
  check('3: contextNote of the same state is null', P.contextNote(st, n1) === null);
  check('3: contextNoteState reads the state back, also past an "is over" line', P.contextNoteState(n1) === st && P.contextNoteState(P.contextNote('x', n1)) === 'x');
  check('3: a session with a tool set of its own has no mode in its note', !/AUTO MODE/.test(P.sessionContext({ ...config, permissionMode: 'auto' }, '', true)));
  check('3: notes are synthetic: not a user turn, never the request to keep', C.isSyntheticUser({ role: 'user', content: n1 }) && C.lastUserIndex([{ role: 'user', content: 'real' }, { role: 'user', content: n1 }]) === 0);

  // ---- 4: a note again after a compaction folds it away ----
  state.summary = '## 1. Request and intent\nShort brief of everything so far.';
  const r = await agent.compactNow();
  // The kept tail (the last request onward) keeps the newest note when it is in it; a fold of everything takes it
  const keptNotes = notesIn(session.messages).length;
  check('4: the compaction folded the older notes', r.ok && notesIn(session.compactions[0].folded).length >= 5 && keptNotes <= 1, r);
  await turn('after the fold');
  const last = streams().pop();
  check('4: the next request has exactly one note, the current one', C.isContextNote(last.messages[1]) && C.isCompactPreamble(last.messages[2]) && notesIn(last.messages).length === 1 && P.contextNoteState(notesIn(last.messages)[0].content) === P.sessionContext(config, { shared: '', session: app.promptFor({ cwd: project, mode: 'ask', sessionId: session.id, part: 'session' }) }), last.messages.map((m) => String(m.content).slice(0, 24)));
  // A /compact that folds the whole conversation takes the note too: it comes back before the next call
  session.messages.splice(0, session.messages.length, ...session.messages.filter((m) => !C.isContextNote(m)));
  check('4: (without a note in the kept part)', notesIn(session.messages).length === 0);
  await turn('no note left');
  check('4: a note comes back when none is left', notesIn(streams().pop().messages).length === 1);
  check('4: …and the same system prompt', last.messages[0].content === system[0]);
  check('4: the summariser was not given the notes', !state.requests.some((q) => !q.payload.stream && /\[Session context\]/.test(JSON.stringify(q.payload.messages))));

  // ---- 5: the context breakdown still counts the note with the system prompt ----
  const bd = agent.contextBreakdown();
  const sys = bd.slices.find((s) => s.key === 'system');
  check('5: the breakdown counts the note with the system prompt', sys.tokens > 0 && Math.abs(bd.slices.reduce((a, b) => a + b.tokens, 0) - bd.limit) <= 1, sys);

  // ---- 6: the base prompt asks for short updates while working; a session with its own tools is not asked ----
  const UPDATES = '- Say what you are doing as you work: one short sentence before your first call, then one whenever you find something that matters, change approach or hit a problem (what you found, what you do next). Not before every call, and never repeat an update.';
  const basePrompt = P.systemPrompt(config, [], null);
  check('6: the base prompt carries the updates bullet, right after "Keep going…"', basePrompt.includes(UPDATES) && /- Keep going until the task is complete[^\n]*\n- Say what you are doing as you work:/.test(basePrompt));
  check('6: it is in the base prompt the model got', system[0].includes(UPDATES));
  const ownPrompt = P.systemPrompt(config, [], null, '', ['remember', 'recall']);
  check('6: a session with its own tool set is not asked for it', !ownPrompt.includes('Say what you are doing') && P.systemPromptParts(config, [], null, '', ['remember']).base.indexOf('Say what you are doing') < 0);

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
