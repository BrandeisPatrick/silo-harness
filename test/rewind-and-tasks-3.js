// UX tick 2, part 3: checkpoints during runs (incl. queued messages), update_tasks, compaction and forks.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { Agent } = require(path.join(projectDir, 'dist/main/agent.js'));
const { SessionStore, toTranscript, toMeta, rewindSession } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { startMock } = require('./support/mock-model.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ check, done }) => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tick2c-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd);
  const f = (rel) => path.join(cwd, rel);
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  fs.writeFileSync(f('existing.txt'), 'v0');
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const artifacts = new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') });
  const config = {
    provider: 'portkey', ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: cwd, permissionMode: 'bypass', autoApprove: true, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: true, notifications: false, allowRules: {},
  };
  let events = [];
  const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], (ev) => events.push(ev), undefined, artifacts);
  let id = 0;
  const call = (name, args) => ({ id: `c${++id}`, name, args });

  state.replies.push({ toolCalls: [call('write_file', { path: 'new.txt', content: 'n' }), call('edit_file', { path: 'existing.txt', old_string: 'v0', new_string: 'v1' })] });
  state.replies.push({ content: 'done 1' });
  await agent.run('first run');
  let s = agent.session;
  check('run: one checkpoint with the typed text and pre-change contents', s.turns.length === 1 && s.turns[0].at === 0 && s.turns[0].text === 'first run' && s.turns[0].files[f('existing.txt')] === 'v0' && s.turns[0].files[f('new.txt')] === null, s.turns[0]);

  state.delayMs = 300;
  state.replies.push({ toolCalls: [call('edit_file', { path: 'existing.txt', old_string: 'v1', new_string: 'v2' })] });
  state.replies.push({ toolCalls: [call('edit_file', { path: 'existing.txt', old_string: 'v2', new_string: 'v3' })] });
  state.replies.push({ content: 'done 2' });
  const run2 = agent.run('second run');
  await sleep(80);
  agent.enqueue('queued message');
  await run2;
  state.delayMs = 0;
  s = agent.session;
  check('queued message gets its own checkpoint; edits land on the current one', s.turns.length === 3 && s.turns[1].text === 'second run' && s.turns[1].files[f('existing.txt')] === 'v1' && s.turns[2].text === 'queued message' && s.turns[2].files[f('existing.txt')] === 'v2', s.turns.map((t) => [t.at, t.text, Object.keys(t.files).length]));
  check('transcript user items carry turn 0..2', toTranscript(s).filter((i) => i.role === 'user').map((i) => i.turn).join() === '0,1,2');
  const r = rewindSession(s, cwd, 1);
  check('rewind to turn 1 restores v1 and keeps new.txt; text returned', read(f('existing.txt')) === 'v1' && read(f('new.txt')) === 'n' && r.text === 'second run' && s.turns.length === 1 && s.messages.length === 6, [r, s.messages.length]); // the first run's messages and its context note

  events = [];
  state.replies.push({ toolCalls: [call('update_tasks', { tasks: [{ id: 't1', title: 'Read the code', status: 'completed' }, { title: 'Write tests', status: 'in_progress' }, { title: 'Run them', status: 'pending' }] })] });
  state.replies.push({ content: 'ok' });
  await agent.run('plan it');
  const te = events.find((e) => e.type === 'tasks_updated');
  check('update_tasks: event, ids filled in, stored on the session and its meta', te && te.tasks.length === 3 && te.tasks[1].id === 't2' && agent.session.tasks.length === 3 && toMeta(agent.session).tasks[0].status === 'completed', te);
  check('update_tasks: result text', /1 of 3 done/.test(events.find((e) => e.type === 'tool_end').result));
  events = [];
  state.replies.push({ toolCalls: [call('update_tasks', { tasks: [] })] });
  state.replies.push({ content: 'ok' });
  await agent.run('clear');
  check('update_tasks: empty list clears', events.find((e) => e.type === 'tasks_updated').tasks.length === 0 && agent.session.tasks === undefined && toMeta(agent.session).tasks === undefined);
  events = [];
  state.replies.push({ toolCalls: [call('update_tasks', { tasks: 'nope' })] });
  state.replies.push({ content: 'ok' });
  await agent.run('bad');
  check('update_tasks: bad arguments rejected', /^Error:/.test(events.find((e) => e.type === 'tool_end').result) && !events.some((e) => e.type === 'tasks_updated'));

  state.summary = '## Request\nStuff.\n\n## Progress\nDone.\n\n## Current state\nFine.\n\n## Next steps\nNone.';
  const before = agent.session.turns.length;
  const cr = await agent.compactNow();
  // Changed on purpose: the last turn is kept after the brief, and its checkpoint with it (renumbered); earlier ones go.
  check('compaction drops the checkpoints of the folded part and keeps the kept turn\'s', cr.ok && before > 1 && agent.session.turns.length === 1 && agent.session.turns[0].text === 'bad' && agent.session.turns[0].at === 1 && toTranscript(agent.session).filter((i) => i.turn !== undefined).map((i) => i.turn).join() === '0');

  state.replies.push({ toolCalls: [call('update_tasks', { tasks: [{ title: 'A', status: 'pending' }] })] });
  state.replies.push({ content: 'ok' });
  await agent.run('after');
  const forked = store.fork(agent.session.id);
  check('fork copies checkpoints and tasks', forked.turns.length === 2 && forked.tasks.length === 1 && forked.turns !== agent.session.turns);
  state.replies.push({ toolCalls: [call('update_tasks', { tasks: [{ title: 'A', status: 'completed' }, { title: 'B', status: 'in_progress' }] })] });
  state.replies.push({ content: 'ok' });
  await agent.run('more');
  check('a checkpoint remembers the task list at its start', agent.session.turns[2].tasks.length === 1 && agent.session.tasks.length === 2);
  rewindSession(agent.session, cwd, 2);
  check('rewind restores the task list of that point', agent.session.tasks.length === 1 && agent.session.tasks[0].title === 'A' && agent.session.tasks[0].status === 'pending');
  mock.close();
  done();
};
