// Session names, headless: the matching (names.ts), the one resolver every session tool and command uses (exact id,
// id prefix, loose name, name prefix, all words, a misspelling; related sessions win a tie), session_list and
// /sessions with a query over every session, and renaming from the conversation (/rename, session_rename).
// The real App and SessionRuntime with the mock model. Run: node test/names.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { setupSubagents } = require(path.join(projectDir, 'dist/main/subagents.js'));
const N = require(path.join(projectDir, 'dist/main/subagents/names.js'));
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
  // ---- 1: the pure parts ----
  check('1: normName folds case, quotes, punctuation and spaces', N.normName('  "TCG  (fork)" ') === 'tcg fork' && N.normName('tcg-fork') === 'tcg fork' && N.normName('Déjà vu!') === 'déjà vu');
  check('1: unquote', N.unquote(' “deploy fix” ') === 'deploy fix' && N.unquote("'x'") === 'x');
  check('1: editDistance: change, insert, swap', N.editDistance('kitten', 'sitten') === 1 && N.editDistance('abc', 'abcd') === 1 && N.editDistance('deplyo', 'deploy') === 1 && N.editDistance('abc', 'xyz', 1) === 2);
  check('1: spelling slack by length', N.spellingSlack('tcg') === 0 && N.spellingSlack('login') === 1 && N.spellingSlack('deploy script') === 2);
  const t = (q, title, id = 'aaaaaaaa-1111') => N.matchTier(q, { id, title });
  check('1: tiers', t('aaaaaaaa-1111', 'x') === 'id' && t('aaaaaa', 'x') === 'id prefix' && t('aaaaa', 'x') === null && t('tcg (fork)', 'tcg (fork)') === 'exact name' && t('TCG fork', 'tcg (fork)') === 'name' && t('"TCG (fork)"', 'tcg (fork)') === 'name' && t('tcg-fork', 'tcg (fork)') === 'name');
  check('1: prefix, all words, spelling', t('deploy scr', 'Deploy script for staging') === 'name prefix' && t('staging deploy', 'Deploy script for staging') === 'all words' && t('deploy scirpt for staging', 'Deploy script for staging') === 'spelling' && t('tgc', 'tcg') === null);
  check('1: ago', N.ago(Date.now() - 5 * 60_000) === '5 min ago' && N.ago(Date.now()) === 'just now' && N.ago(Date.now() - 3 * 86_400_000) === '3 days ago');

  // ---- the app ----
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-names-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const dir = path.join(tmp, 'project');
  const other = path.join(tmp, 'other');
  fs.mkdirSync(dir);
  fs.mkdirSync(other);
  const base = {
    provider: 'portkey',
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: dir, permissionMode: 'bypass', autoApprove: true, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  const app = createApp({ userData: tmp, appRoot: projectDir, loadConfig: () => base, saveConfig: () => {} });
  const svc = setupSubagents(app, { retryMs: 50 });
  const rt = app.runtime;
  const events = [];
  app.events.on((sid, ev) => events.push({ sid, ev }));
  const tool = (name) => app.tools.list().find((x) => x.name === name);
  const ctxFor = (sessionId) => {
    const asked = [];
    return { asked, ctx: { sessionId, cwd: dir, app, approve: async (...a) => (asked.push(a), { ok: true }) } };
  };
  const cmd = (name, args = '') => app.invokeRpc('commands.run', [name, args]);
  const allIdle = () => waitFor(() => rt.running().length === 0, 20000, 'every session to finish');
  let age = 0;
  /** A stored session with one exchange; older the later it is made unless `at` says otherwise. */
  const mk = (title, extra = {}) => {
    const s = app.store.create({ cwd: extra.cwd ?? dir, parentId: extra.parentId, origin: extra.origin, title });
    if (extra.forkedFrom) s.forkedFrom = extra.forkedFrom;
    app.store.append(s, { role: 'user', content: `work on ${title}` });
    app.store.append(s, { role: 'assistant', content: `done with ${title}` });
    app.store.save(s);
    s.updatedAt = extra.at ?? Date.now() - 60_000 * ++age;
    return s;
  };
  const find = (ref, opts) => {
    try {
      return svc.find(ref, opts);
    } catch (err) {
      return { error: err.message };
    }
  };

  // ---- 2: the resolver tiers ----
  const me = mk('caller', { at: Date.now() });
  const tcg = mk('tcg');
  const tcgFork = mk('tcg (fork)', { forkedFrom: tcg.id, origin: 'fork' });
  const deploy = mk('Deploy script for staging', { cwd: other });
  const login = mk('Fix the login flow');
  let r = find(tcgFork.id, { from: me.id });
  check('2: exact id', r.session?.id === tcgFork.id && r.tier === 'id', r);
  r = find(deploy.id.slice(0, 6), { from: me.id });
  check('2: a unique id prefix of 6', r.session?.id === deploy.id && r.tier === 'id prefix', r);
  r = find(deploy.id.slice(0, 5), { from: me.id });
  check('2: 5 characters are not an id prefix', !r.session || r.tier !== 'id prefix', r);
  for (const q of ['tcg fork', '"TCG (fork)"', 'tcg-fork', '  TCG   fork  ', '“tcg (fork)”']) {
    r = find(q, { from: me.id });
    check(`2: "${q}" finds "tcg (fork)"`, r.session?.id === tcgFork.id, r);
  }
  r = find('tcg', { from: me.id });
  check('2: "tcg" is the session called tcg, not the fork (exact beats prefix)', r.session?.id === tcg.id, r);
  r = find('deploy scr', { from: me.id });
  check('2: a unique name prefix', r.session?.id === deploy.id && r.tier === 'name prefix', r);
  r = find('staging deploy', { from: me.id });
  check('2: every word of the query', r.session?.id === deploy.id && r.tier === 'all words', r);
  r = find('fix the lgoin flow', { from: me.id });
  check('2: a close misspelling', r.session?.id === login.id && r.tier === 'spelling', r);
  r = find('Fix the', { from: me.id });
  check('2: the start of a name, unique', r.session?.id === login.id, r);
  const loginB = mk('Fix the login flaw');
  r = find('fix the login flow', { from: me.id });
  check('2: the exact one wins over a misspelling of the other', r.session?.id === login.id && r.tier === 'name', r);
  r = find('fix the login flwo', { from: me.id });
  check('2: two names within the slack: ambiguous, both listed with folder and activity', /fits 2 sessions/.test(r.error) && r.error.includes(login.id) && r.error.includes(loginB.id) && /active \d+ min ago/.test(r.error) && r.error.includes(dir.split(path.sep).pop()), r);
  r = find('quantum widgets', { from: me.id });
  check('2: no match: the closest names', /^No session matches "quantum widgets"\. Closest names:\n {2}\S+ {2}"/.test(r.error) && r.error.split('\n').length === 4, r);
  r = find('', { from: me.id });
  check('2: empty: asks for a name', /Name a session/.test(r.error), r);

  // ---- 3: every session, not only recent or related ones; not the trash ----
  for (let i = 0; i < 14; i++) mk(`filler ${i}`);
  const ancient = mk('archaeology notes', { at: Date.now() - 400 * 86_400_000 });
  r = find('archaeology', { from: me.id });
  check('3: an old unrelated session is found', r.session?.id === ancient.id, r);
  let out = (await tool('session_list').run({}, ctxFor(me.id).ctx)).content;
  check('3: the plain list shows 10 others and points at the query', !out.includes(ancient.id) && /older not shown; session_list with a query/.test(out), out.slice(-200));
  const gone = mk('trashed thing');
  app.store.delete(gone.id);
  r = find('trashed thing', { from: me.id });
  check('3: a deleted session is not found', /^No session matches/.test(r.error), r);
  const fresh = rt.create({ cwd: dir });
  app.store.rename(fresh.id, 'brand new name');
  r = find('brand new name', { from: me.id });
  check('3: an empty session the user named is found', r.session?.id === fresh.id, r);
  const blank = rt.create({ cwd: dir });
  r = find('New session', { from: me.id });
  check('3: an empty unnamed session is not', !r.session || r.session.id !== blank.id, r);

  // ---- 4: ties ----
  const kid = mk('worker', { parentId: me.id, origin: 'spawn' });
  const stranger = mk('worker');
  r = find('worker', { from: me.id });
  check('4: a sub-session beats an unrelated namesake', r.session?.id === kid.id, r);
  r = find('worker', { from: tcg.id });
  check('4: from an unrelated session: ambiguous, related first in the list', /"worker" fits 2 sessions; name one by its id/.test(r.error) && r.error.includes(kid.id) && r.error.includes(stranger.id), r);
  r = find('tcg', { from: tcgFork.id });
  check('4: from the fork, the source by its name', r.session?.id === tcg.id, r);
  const twinA = mk('twin');
  const twinB = mk('twin');
  r = find('twin', { from: twinA.id });
  check('4: this session loses a tie with another one', r.session?.id === twinB.id, r);
  r = find('caller', { from: me.id });
  check('4: alone, this session is still found (the tools then say "that is this session")', r.session?.id === me.id, r);

  // ---- 5: the tools take names ----
  let res = await tool('session_read').run({ id: 'TCG-fork' }, ctxFor(me.id).ctx);
  check('5: session_read by a loose name', res.content.startsWith(`Session ${tcgFork.id} "tcg (fork)"`), res.content.slice(0, 120));
  state.replies.push({ content: 'got it', when: (p) => (p.messages || []).some((m) => typeof m.content === 'string' && m.content.includes('ping from caller')) });
  res = await tool('session_send').run({ to: 'archaeology', message: 'ping from caller' }, ctxFor(me.id).ctx);
  check('5: session_send by part of the name reaches the right session', res.content.startsWith(`Delivered to "archaeology notes" (${ancient.id})`), res.content);
  await allIdle();
  res = await tool('session_send').run({ to: 'worker', message: 'hi' }, ctxFor(tcg.id).ctx);
  check('5: an ambiguous name is an error the model can act on', /^Error: "worker" fits 2 sessions/.test(res.content) && res.content.includes(kid.id), res.content);
  res = await tool('session_send').run({ to: 'quantum widgets', message: 'hi' }, ctxFor(me.id).ctx);
  check('5: no match: an error with the closest names', /^Error: No session matches "quantum widgets"\. Closest names:/.test(res.content), res.content);

  // ---- 6: session_list and /sessions with a query ----
  res = await tool('session_list').run({ query: 'tcg' }, ctxFor(me.id).ctx);
  let lines = res.content.split('\n');
  check('6: session_list query: header, who takes messages, then best first', lines[0] === `This session: ${me.id} "caller"` && /^Messages \(session_send\): /.test(lines[1]) && /^Sessions matching "tcg" \(2\), best first:$/.test(lines[2]) && lines[3].includes(tcg.id) && lines[4].includes(tcgFork.id), res.content);
  check('6: each line: id, name, relation, state, folder, activity', new RegExp(`^ {2}${tcg.id} {2}"tcg" {2}other {2}idle {2}\\S+ {2}active \\d+ min ago {2}last: done with tcg$`).test(lines[3]), lines[3]);
  res = await tool('session_list').run({ query: 'archaeology' }, ctxFor(me.id).ctx);
  check('6: the query reaches sessions the plain list leaves out', res.content.includes(ancient.id), res.content);
  res = await tool('session_list').run({ query: 'worker' }, ctxFor(me.id).ctx);
  lines = res.content.split('\n');
  check('6: related sessions rank first at the same tier', lines[3].includes(kid.id) && / sub-session /.test(lines[3]) && lines[4].includes(stranger.id), res.content);
  res = await tool('session_list').run({ query: 'quantum widgets' }, ctxFor(me.id).ctx);
  check('6: no match: the closest names', /No session matches "quantum widgets"\. Closest names:/.test(res.content), res.content);
  check('6: session_list takes an optional query', tool('session_list').parameters.properties.query?.type === 'string' && !(tool('session_list').parameters.required ?? []).includes('query'));
  rt.setForeground(me.id);
  let c = await cmd('sessions', 'deploy');
  check('6: /sessions <query> lists matches from every session', /Sessions matching "deploy" \(1\)/.test(c.notice) && c.notice.includes(deploy.id) && c.notice.includes(other.split(path.sep).pop()), c);
  c = await cmd('sessions');
  check('6: /sessions alone still lists the related ones', /1 related session:/.test(c.notice) && c.notice.includes(kid.id), c);

  // ---- 7: session_rename ----
  const rn = tool('session_rename');
  check('7: registered, optional, offered in plan mode', rn && rn.optional === true && rn.readOnly === true && rn.parameters.required.includes('name'));
  const before = events.length;
  const rc = ctxFor(me.id);
  res = await rn.run({ name: '  "Release   checklist" ' }, rc.ctx);
  check('7: renames the calling session; the result names it', rt.get(me.id).title === 'Release checklist' && res.content === `Renamed this session to "Release checklist" (id ${me.id}). Other sessions can find it by that name.`, res.content);
  check('7: no approval asked', rc.asked.length === 0);
  check('7: the title is locked like a manual rename, and saved', rt.get(me.id).titleLocked === true && JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', `${me.id}.json`), 'utf8')).title === 'Release checklist');
  check('7: the window hears of it', events.slice(before).some((e) => e.sid === me.id && e.ev.type === 'session_changed' && e.ev.session.title === 'Release checklist'));
  r = find('release checklist', { from: tcg.id });
  check('7: other sessions find it by the new name', r.session?.id === me.id, r);
  res = await rn.run({ name: 'tcg' }, ctxFor(me.id).ctx);
  check('7: a name another session has: allowed, and said', rt.get(me.id).title === 'tcg' && /1 other session is also called that \(.*\), so a lookup by this name is ambiguous/.test(res.content) && res.content.includes(tcg.id), res.content);
  res = await rn.run({ name: '   ' }, ctxFor(me.id).ctx);
  check('7: an empty name is refused', /^Error: A session name cannot be empty/.test(res.content) && rt.get(me.id).title === 'tcg', res.content);
  check('7: only this session: there is no target argument', Object.keys(rn.parameters.properties).join() === 'name');

  // ---- 8: /rename ----
  c = await cmd('rename', 'Payment retries');
  check('8: /rename <name> renames the session on screen', c.notice === 'Renamed this session to "Payment retries".' && rt.get(me.id).title === 'Payment retries' && rt.get(me.id).titleLocked, c);
  c = await cmd('rename', '"Fix the login flow"');
  check('8: /rename to a name in use: done, with the warning', rt.get(me.id).title === 'Fix the login flow' && /also called that/.test(c.notice) && c.notice.includes(login.id), c);
  c = await cmd('rename', '');
  check('8: /rename alone starts the title edit in the window', c.editTitle === true && !c.error && rt.get(me.id).title === 'Fix the login flow', c);
  check('8: /rename registered with a hint', app.commands.list().some((x) => x.name === 'rename' && x.argsHint === '[new name]' && x.source === 'app'));
  check('8: namesakes', svc.namesakes(me.id).map((s) => s.id).join() === login.id);

  // ---- 9: the prompt section names this session ----
  const prompt = () => app.promptFor({ cwd: dir, mode: 'bypass', sessionId: me.id });
  check('9: the prompt says this session\'s name and id', prompt().includes(`This session is named "Fix the login flow" (id ${me.id}).`), prompt().slice(-400));
  check('9: and how to find another by its name', /session_list with a query/.test(prompt()) && /by its name/.test(prompt()) && /session_rename/.test(prompt()));
  await cmd('rename', 'Final name');
  check('9: it follows a rename', prompt().includes('This session is named "Final name"'));

  // ---- 10: an end-to-end turn: the model renames its session through the tool ----
  const E = rt.create({ cwd: dir }).id;
  state.replies.push({ toolCalls: [{ id: 'r1', name: 'session_rename', args: { name: 'Called by the model' } }], when: (p) => JSON.stringify(p.messages).includes('call this session') && !JSON.stringify(p.messages).includes('Renamed this session') });
  state.replies.push({ content: 'Renamed.', when: (p) => JSON.stringify(p.messages).includes('Renamed this session') });
  rt.send(E, 'call this session Called by the model');
  await allIdle();
  check('10: a run renames its session through the tool', rt.get(E).title === 'Called by the model' && rt.get(E).titleLocked === true, rt.get(E).title);

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
