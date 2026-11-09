// Settings → History → Delete all sessions, headless: the real App (store, runtime, agents) with the history service
// against the mock model, in temp folders. Every session goes the way one deleted session goes: into the trash for
// historyTrashDays days (removed at once with 0), a running session stopped first, and a fresh empty session made
// and brought on screen. Run: node test/history-delete-all.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { createHistory } = require(path.join(projectDir, 'dist/main/history/service.js'));
const { parseLog } = require(path.join(projectDir, 'dist/main/history/log.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
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

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-delete-all-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  const baseConfig = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock-model', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: project, permissionMode: 'bypass', autoApprove: false, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, pruneToolResults: false, notifications: false, allowRules: {}, recentDirs: [], historyTrashDays: 30,
  };

  /** One app with history on a user-data folder, a fake window that records what is sent to it, and a fixed clock. */
  const clock = { now: Date.parse('2026-03-01T12:00:00Z') };
  function open(userData) {
    let cfg = { ...baseConfig };
    const app = createApp({
      userData,
      appRoot: projectDir,
      loadConfig: () => cfg,
      saveConfig: (c) => (cfg = c),
      artifacts: new ArtifactStore({ root: path.join(userData, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }),
    });
    const sent = [];
    app.setWindow({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } });
    const history = createHistory(app, { now: () => clock.now, noticeDelayMs: 5 });
    return { app, history, sent, rt: app.runtime, store: app.store };
  }
  const close = (h) => h.history.dispose();
  const deleteAll = (h) => h.app.invokeRpc('history.deleteAll', []);

  // ---- 1: three sessions with messages (one running) and the empty one on screen; the trash keeps the three ----
  const ud1 = path.join(tmp, 'ud1');
  let h = open(ud1);
  const mk = (title, n = 2) => {
    const s = h.store.create({ title });
    for (let i = 0; i < n; i++) h.store.append(s, { role: i % 2 ? 'assistant' : 'user', content: `${title} message ${i}` });
    h.store.save(s);
    return s;
  };
  const B = mk('Blue whale', 2);
  // Re-open with B marked as recovered after a crash: the delete must forget that too.
  close(h);
  fs.writeFileSync(path.join(ud1, 'history', 'recovered.json'), JSON.stringify([B.id]));
  h = open(ud1);
  check('1: the re-opened app has B in its recovered list', h.history.recovered().join() === B.id && h.store.list().length === 1);
  const fresh0 = h.rt.foregroundId();
  const C = mk('Copper kettle', 4);
  const cArt = h.app.artifacts.dirFor(C.id);
  fs.mkdirSync(path.join(cArt, 'images'), { recursive: true });
  fs.writeFileSync(path.join(cArt, 'images', 'pic.png'), 'PNGDATA');
  // D runs: the mock holds its reply back, so the run is in progress when everything is deleted.
  const D = h.store.create({ title: 'Running one' });
  state.replies.push({ content: 'a slow reply', delayMs: 30_000 });
  h.rt.send(D.id, 'take your time');
  await waitFor(() => h.rt.isRunning(D.id) && fs.existsSync(h.store.file(D.id)), 5000, 'the run to start and save its user message');
  check('1: before: three listed sessions, one running, and the empty one on screen', h.store.list().length === 3 && h.rt.running().join() === D.id && h.store.get(fresh0).messages.length === 0, h.store.list().map((m) => m.title));

  const t0 = Date.now();
  const r = await deleteAll(h);
  const took = Date.now() - t0;
  const olds = [fresh0, B.id, C.id, D.id];
  check('1: deleteAll reports the three sessions with messages', r.deleted === 3, r.deleted);
  check('1: … and a fresh empty session, now on screen', r.session && !olds.includes(r.session.id) && r.session.messageCount === 0 && h.rt.foregroundId() === r.session.id, r.session);
  check('1: the store holds only the fresh session, and lists none', h.store.all().length === 1 && h.store.all()[0].id === r.session.id && h.store.list().length === 0, h.store.all().map((s) => s.title));
  check('1: the running session was stopped, and the delete did not wait for the mock', !h.rt.isRunning(D.id) && h.rt.running().length === 0 && took < 5000, `${took} ms`);
  const trash = h.history.trashList();
  check('1: the three are in the trash; the empty one is not', trash.map((e) => e.id).sort().join() === [B.id, C.id, D.id].sort().join(), trash.map((e) => e.title));
  check('1: … with the purge date of the period', trash.every((e) => e.deletedAt === clock.now && e.purgeAt === clock.now + 30 * DAY));
  const tdir = (id) => path.join(ud1, 'trash', id);
  check('1: each entry holds the session, its log and its meta', [B, C, D].every((s) => ['session.json', 'history.jsonl', 'meta.json'].every((f) => fs.existsSync(path.join(tdir(s.id), f)))));
  check("1: C's artifacts went with it", fs.readFileSync(path.join(tdir(C.id), 'artifacts', 'images', 'pic.png'), 'utf8') === 'PNGDATA' && !fs.existsSync(cArt));
  check('1: nothing is left in place', fs.readdirSync(path.join(ud1, 'sessions')).filter((f) => f.endsWith('.json')).length === 0 && [B, C, D].every((s) => !h.history.log.exists(s.id)));
  const dLog = parseLog(fs.readFileSync(path.join(tdir(D.id), 'history.jsonl'), 'utf8'));
  const dTypes = dLog.map((x) => x.type);
  const dEnd = dLog.find((x) => x.type === 'run.end');
  check("1: the running session's log has its run ended (aborted) before the delete", dTypes.includes('run.start') && dEnd && dEnd.data.reason === 'aborted' && dTypes.indexOf('run.end') < dTypes.indexOf('session.deleted') && dTypes[dTypes.length - 1] === 'session.deleted', dTypes.join(' '));
  const dSaved = JSON.parse(fs.readFileSync(path.join(tdir(D.id), 'session.json'), 'utf8'));
  check('1: … with its user message kept', dSaved.messages.length >= 1 && /take your time/.test(JSON.stringify(dSaved.messages[0])), dSaved.messages.length);
  const shows = h.sent.filter((a) => a[0] === 'rpc:push' && a[1] === 'sessions:show').map((a) => a[2]);
  check('1: the window is told to show the fresh session', shows.join() === r.session.id, shows);
  const stats = await h.app.invokeRpc('history.stats', []);
  check('1: history.stats agrees', stats.sessions === 0 && stats.trash === 3, stats);
  const live = h.history.search('message');
  const trashed = h.history.search('message', { includeTrash: true });
  check('1: search finds nothing live, and the two in the trash when asked', live.length === 0 && trashed.length === 2 && trashed.every((x) => x.trashed === true), { live: live.length, trashed: trashed.map((x) => x.title) });
  check('1: the recovered list forgot B', h.history.recovered().length === 0 && !fs.existsSync(path.join(ud1, 'history', 'recovered.json')));
  const r2 = await deleteAll(h);
  check('1: deleting again deletes nothing and makes another fresh session', r2.deleted === 0 && r2.session.id !== r.session.id && h.store.all().length === 1 && h.store.all()[0].id === r2.session.id && h.history.trashList().length === 3, r2);

  // ---- 2: with historyTrashDays 0 everything is removed at once ----
  h.app.updateConfig({ historyTrashDays: 0 });
  const E = mk('Ephemeral', 2);
  const eArt = h.app.artifacts.dirFor(E.id);
  fs.mkdirSync(eArt, { recursive: true });
  fs.writeFileSync(path.join(eArt, 'a.html'), '<p>x</p>');
  const r3 = await deleteAll(h);
  check('2: with historyTrashDays 0 the session, its log and its artifacts are removed at once, not trashed', r3.deleted === 1 && h.history.trashList().length === 3 && !fs.existsSync(h.store.file(E.id)) && !h.history.log.exists(E.id) && !fs.existsSync(eArt) && !fs.existsSync(path.join(ud1, 'trash', E.id)), r3);

  // ---- 3: a deleted session stays deleted, even when a run that was stopped is still ending ----
  const G = mk('Ghost', 2);
  h.store.delete(G.id);
  h.store.save(G);
  check('3: saving a deleted session writes nothing', !fs.existsSync(h.store.file(G.id)) && !h.store.get(G.id));
  const K = h.store.create({ title: 'Killed mid-run' });
  state.replies.push({ content: 'slow', delayMs: 30_000 });
  let kEnded = false;
  const off = h.app.events.on((id, ev) => {
    if (id === K.id && ev.type === 'run_end') kEnded = true;
  });
  h.rt.send(K.id, 'hold on');
  await waitFor(() => h.rt.isRunning(K.id) && fs.existsSync(h.store.file(K.id)), 5000, 'K to run');
  // The single-delete path (stop, forget, delete) without waiting for the run to end: its last save must not bring the file back.
  h.rt.forget(K.id);
  h.store.delete(K.id);
  await waitFor(() => kEnded, 5000, "K's run to end");
  off();
  await sleep(50);
  check('3: a run ending after its session was deleted does not bring the file back', !fs.existsSync(h.store.file(K.id)) && !h.store.get(K.id));

  // ---- 4: after a restart nothing is listed and the trash still holds the three ----
  close(h);
  h = open(ud1);
  check('4: after a restart no session is listed and the trash still holds the three', h.store.list().length === 0 && h.history.trashList().length === 3, h.history.trashList().map((e) => e.title));
  close(h);

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
