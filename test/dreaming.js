// Dreaming, headless: the digest (clipping, the budget, oldest first, what is left out, the cursor), choosing the
// projects, each kind of proposal applied, dismissed, reverted and refused, the three modes (approving a plan without
// a model call), the daily time and the missed run, a dream session's tool set, and a restart in the middle of a
// dream. The real App, runtime and history log, with the mock model scripted to call the proposal tools.
// Run: node test/dreaming.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { createHistory } = require(path.join(projectDir, 'dist/main/history/service.js'));
const { setupSubagents } = require(path.join(projectDir, 'dist/main/subagents.js'));
const { setupDreaming, latestOccurrence, nextOccurrence } = require(path.join(projectDir, 'dist/main/dreaming.js'));
const { buildDigest, sessionTurns, CLIP, tokensOf } = require(path.join(projectDir, 'dist/main/dreaming/digest.js'));
const { PROPOSAL_TOOLS, PROPOSAL_ID_RE } = require(path.join(projectDir, 'dist/main/dreaming/names.js'));
const { secretIn, memoryAfter, allowedTarget } = require(path.join(projectDir, 'dist/main/dreaming/apply.js'));
const { normalizeDreaming } = require(path.join(projectDir, 'dist/main/config.js'));
const { parseSkill } = require(path.join(projectDir, 'dist/main/skills.js'));
const { toTranscript } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, what = 'condition') {
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-dreaming-'));
  const home = path.join(tmp, 'home-config');
  process.env.SILO_HARNESS_CONFIG_DIR = home;
  const proj = path.join(tmp, 'shop');
  const other = path.join(tmp, 'blog');
  for (const d of [home, proj, other]) fs.mkdirSync(d, { recursive: true });
  const userData = path.join(tmp, 'data');
  fs.mkdirSync(userData);
  const base = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test-key-not-secret', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 100000 },
    workingDirectory: proj, permissionMode: 'ask', autoApprove: false, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: true, allowRules: {}, recentDirs: [],
    dreaming: { daily: false, time: '03:00', mode: 'approve', skills: true, mods: true, memory: true },
  };
  let clock = Date.now();
  const notes = [];
  const make = () => {
    const app = createApp({ userData, appRoot: projectDir, loadConfig: () => ({ ...base, workingDirectory: proj }), saveConfig: () => {} });
    const history = createHistory(app, { noticeDelayMs: 0 });
    setupSubagents(app, { retryMs: 50 });
    const svc = setupDreaming(app, { now: () => clock, startDelayMs: 0, setInterval: () => 0, clearInterval: () => {}, notify: (t, b) => notes.push([t, b]) });
    return { app, history, svc };
  };
  let { app, svc } = make();
  let rt = app.runtime;
  const pushes = [];
  const origPush = app.push.bind(app);
  app.push = (ch, p) => (pushes.push([ch, p]), origPush(ch, p));
  let n = 0;
  const call = (name, args) => ({ id: `c${++n}`, name, args });
  const firstUser = (p) => (p.messages || []).find((m) => m.role === 'user');
  const isDream = (p) => typeof firstUser(p)?.content === 'string' && firstUser(p).content.startsWith('[Dream]');
  const has = (m, tag) => typeof m?.content === 'string' && m.content.includes(tag);
  const reply = (tag, r) => state.replies.push({ ...r, when: (p) => has(firstUser(p), tag) });
  const dreamReply = (r) => state.replies.push({ ...r, when: isDream });
  const idle = () => waitFor(() => rt.running().length === 0, 15000, 'every session to finish');
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  const tool = (name) => app.tools.list().find((t) => t.name === name);

  // ---- 0: wiring, config ----
  check('0: tools registered and scoped', ['history_read', 'history_search', 'propose_skill', 'propose_memory', 'propose_mod', 'withdraw_proposal'].every((t) => tool(t)?.scoped));
  check('0: /dream registered', app.commands.list().some((c) => c.name === 'dream' && c.source === 'app'));
  check('0: dreaming service provided', app.service('dreaming') === svc);
  check('0: the dream prompt section is not in a normal session', !/## Dreaming/.test(app.promptFor({ cwd: proj, mode: 'ask', sessionId: rt.foregroundId() })));
  check('0: normalizeDreaming fills and checks', JSON.stringify(normalizeDreaming({ time: '3:05', mode: 'nope', daily: 'yes' })) === JSON.stringify({ daily: false, time: '03:05', mode: 'approve', skills: true, mods: true, memory: true }));
  check('0: off by default', app.config().dreaming.daily === false && svc.state().nextRunAt === null);
  check('0: the proposal names the window copies', fs.readFileSync(path.join(projectDir, 'src/renderer/dreaming.ts'), 'utf8').includes(`PROPOSAL_TOOLS = ${JSON.stringify(PROPOSAL_TOOLS).replace(/"/g, "'").replace(/,/g, ', ')}`) && fs.readFileSync(path.join(projectDir, 'src/renderer/dreaming.ts'), 'utf8').includes(String(PROPOSAL_ID_RE)));

  // ---- 1: seed past sessions: the same chore asked twice, a preference, a failure, a denial, another project ----
  const send = async (cwd, text, replies) => {
    const id = rt.create({ cwd }).id;
    for (const r of replies) reply(text.slice(-8), r);
    rt.send(id, text);
    await idle();
    return id;
  };
  clock = Date.now();
  const A = await send(proj, 'Do the release chore: bump the version in package.json, add a CHANGELOG entry, then run npm test [sA]', [
    { toolCalls: [call('read_file', { path: 'package.json' })] },
    { content: 'Bumped to 1.2.0 and added the entry.' },
  ]);
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"shop","version":"1.2.0"}\n');
  const B = await send(proj, 'Release chore again please: bump version, changelog entry, npm test. And use pnpm, never npm, in this repo [sB]', [
    { toolCalls: [call('read_file', { path: 'missing.txt' })] },
    { content: 'Done, released 1.3.0 with pnpm.' },
  ]);
  const C = await send(other, 'Write a draft post about caching [sC]', [{ content: 'Here is the draft.' }]);
  const empty = rt.create({ cwd: proj }).id; // no message: left out
  check('1: seeded three sessions with logs', [A, B, C].every((id) => app.service('history').read(id).length > 3));

  // ---- 2: the digest ----
  const turnsB = sessionTurns(rt.get(B), app.service('history').read(B));
  check('2: a turn per user message, with its reply and tools', turnsB.length === 1 && /pnpm, never npm/.test(turnsB[0].text) && /released 1\.3\.0/.test(turnsB[0].reply) && turnsB[0].tools.read_file === 1, turnsB);
  check('2: a failed call is called out with its error', turnsB[0].failed.length === 1 && turnsB[0].failed[0].what === 'missing.txt' && /ENOENT|no such file/i.test(turnsB[0].failed[0].error), turnsB[0].failed);
  let d = svc.digest(proj);
  check('2: the digest covers both sessions of the project, oldest first', d.covered.sessions === 2 && d.covered.turns === 2 && d.sessionIds[0] === A && d.sessionIds[1] === B, d.covered);
  check('2: it names ids, titles and what was said', d.text.includes(`id ${A}`) && d.text.includes('Release chore again') && d.text.includes('Failed: read_file (missing.txt)'));
  check('2: it starts with the dream frame', d.text.startsWith('[Dream] Silo Harness put this message together'));
  check('2: it lists what exists: skills, mods, instructions', /## What already exists/.test(d.text) && /Skills \(/.test(d.text) && /Mods:/.test(d.text) && /SILOHARNESS\.md \(project\): none yet/.test(d.text), d.text.slice(0, 1500));
  check('2: other projects, dream sessions and empty sessions are left out', !d.text.includes(C) && !d.text.includes(empty));
  // Clipping and the budget, on made-up turns
  const long = 'x'.repeat(5000);
  const mk = (id, t, text) => ({ sessionId: id, t, text, reply: long, tools: { bash: 2 }, failed: [], denied: [{ name: 'bash', what: 'rm -rf build' }], memory: [] });
  const sessions = [
    { id: 's1', title: 'One', createdAt: 1000, turns: [mk('s1', 1000, long), mk('s1', 3000, 'third')] },
    { id: 's2', title: 'Two', createdAt: 2000, turns: [mk('s2', 2000, 'second'), mk('s2', 4000, 'fourth')] },
  ];
  const existing = { skills: [], mods: [], instructions: [] };
  const big = buildDigest({ cwd: '/p', mode: 'approve', lookFor: { skills: true, mods: true, memory: true }, sessions, existing, budget: 100000 });
  check('2: long text is clipped', !big.text.includes('x'.repeat(CLIP.user + 1)) && big.text.includes('x'.repeat(100) + ''), big.text.length);
  check('2: denied approvals are called out', big.text.includes('Denied by the user: bash (rm -rf build)'));
  check('2: everything fits in a big budget', big.covered.turns === 4 && big.covered.left === 0 && big.covered.to === 4000);
  const perTurn = tokensOf(big.text) / 4;
  const small = buildDigest({ cwd: '/p', mode: 'approve', lookFor: { skills: true, mods: true, memory: true }, sessions, existing, budget: tokensOf(big.text) - perTurn * 1.5 });
  check('2: a small budget keeps the oldest turns and leaves the newest', small.covered.turns < 4 && small.covered.left === 4 - small.covered.turns && small.covered.from === 1000 && small.covered.to < 4000, small.covered);
  check('2: what was left is said', /did not fit and wait for the next dream/.test(small.text));
  const tiny = buildDigest({ cwd: '/p', mode: 'approve', lookFor: { skills: true, mods: false, memory: false }, sessions, existing, budget: 10 });
  check('2: at least one turn, whatever the budget; switches named', tiny.covered.turns === 1 && /Look for: skills \(memory and mods turned off/.test(tiny.text), tiny.covered);

  // ---- 3: choosing projects ----
  check('3: both projects with activity, the most recent first', JSON.stringify(svc.projects()) === JSON.stringify([other, proj]), svc.projects());
  const extra = [];
  for (let i = 0; i < 5; i++) {
    const dir = path.join(tmp, `p${i}`);
    fs.mkdirSync(dir);
    extra.push(await send(dir, `hello p${i} [sP${i}]`, [{ content: 'hi' }]));
  }
  check('3: at most five projects per run', svc.projects().length === 5 && !svc.projects().includes(proj), svc.projects());
  for (const id of extra) app.store.delete(id);
  check('3: deleted sessions are left out', JSON.stringify(svc.projects()) === JSON.stringify([other, proj]));
  const plist = svc.projectList();
  check('3: the project list: each folder once, most recent first, with its new sessions and whether the next dream reads it', JSON.stringify(plist.map((x) => x.cwd)) === JSON.stringify([other, proj]) && plist.every((x) => x.next && x.fresh >= 1 && x.lastActivity > 0), plist);

  // ---- 4: Approve mode: the dream proposes, nothing is written before Apply ----
  const skillArgs = { name: 'release-chore', description: 'Bump the version, add a CHANGELOG entry and run the tests', body: '1. Bump the version in package.json\n2. Add a CHANGELOG entry\n3. Run pnpm test', scope: 'project', why: 'Asked twice: "Do the release chore" and "Release chore again please"', sessions: [A, B] };
  const memArgs = { scope: 'project', add: ['Use pnpm, never npm, in this repo'], why: 'The user said "use pnpm, never npm, in this repo"', sessions: [B] };
  const modFiles = [
    { path: 'mod.json', content: JSON.stringify({ protocol: 1, id: 'release-status', name: 'Release status', version: '0.1.0', contributes: { views: [{ id: 'main', title: 'Release', entry: 'panel.html', seat: 'rail' }] } }) },
    { path: 'panel.html', content: '<!doctype html><p>Version</p>' },
  ];
  const modArgs = { id: 'release-status', name: 'Release status', description: 'The version and the last release', scope: 'user', files: modFiles, why: 'The user asked for the version twice', sessions: [A, B] };
  dreamReply({ toolCalls: [call('propose_skill', skillArgs), call('propose_memory', memArgs), call('propose_mod', modArgs)] });
  dreamReply({ toolCalls: [call('bash', { command: 'echo hacked > /tmp/x' }), call('write_file', { path: 'evil.txt', content: 'x' })] });
  dreamReply({ content: 'Proposed a skill, a memory line and a mod.' });
  const before = state.requests.length;
  svc.start('manual', proj);
  check('4: one dream runs at a time', (() => { try { svc.start('manual'); return false; } catch (e) { return /running already/.test(e.message); } })());
  await idle();
  let dream = svc.state().dreams[0];
  const D = dream.sessionId;
  check('4: the dream ended done with three waiting proposals', dream.status === 'done' && dream.proposals.length === 3 && dream.proposals.every((p) => p.state === 'waiting'), dream.proposals.map((p) => [p.kind, p.state, p.error]));
  check('4: its closing report is kept as its summary', dream.summary === 'Proposed a skill, a memory line and a mod.', dream.summary);
  check('4: after the dream, the project has nothing new for the next one', svc.projectList().find((x) => x.cwd === proj)?.next === false);
  const sess = rt.get(D);
  check('4: its session: origin dream, the project folder, its own tool set, the dream id', sess.origin === 'dream' && sess.cwd === proj && Array.isArray(sess.tools) && sess.dream.id === dream.id && rt.meta(D).dream.waiting === 3);
  const dreamReqs = state.requests.slice(before).filter((r) => r.url === '/v1/chat/completions' && isDream(r.payload));
  const offered = dreamReqs[0].payload.tools.map((t) => t.function.name).sort();
  check('4: the model is offered only reading, history and proposal tools', JSON.stringify(offered) === JSON.stringify(['glob', 'grep', 'history_read', 'history_search', 'list_directory', 'propose_memory', 'propose_mod', 'propose_skill', 'read_file', 'session_list', 'session_read', 'withdraw_proposal']), offered);
  const sys = dreamReqs[0].payload.messages[0].content;
  check('4: its system prompt is the dream section, no shell or browser', /## Dreaming/.test(sys) && /only these tools/.test(sys) && !/a shell \(bash\)/.test(sys) && !/## Sub-sessions/.test(sys) && !/## Schedules/.test(sys), sys.slice(0, 600));
  const toolResults = rt.get(D).messages.filter((m) => m.role === 'tool').map((m) => m.content);
  check('4: a shell or edit call in a dream is refused as unknown', toolResults.some((c) => /^Error: unknown tool "bash"/.test(c)) && toolResults.some((c) => /^Error: unknown tool "write_file"/.test(c)) && !fs.existsSync(path.join(proj, 'evil.txt')));
  const skillFile = path.join(proj, '.silo-harness/skills/release-chore/SKILL.md');
  const memFile = path.join(proj, 'SILOHARNESS.md');
  const modDir = path.join(home, 'mods/release-status');
  check('4: nothing was written before Apply', !fs.existsSync(skillFile) && !fs.existsSync(memFile) && !fs.existsSync(modDir));
  check('4: the cursor moved to the last covered turn', svc.data.cursors[proj] === dream.covered.to && dream.covered.to > 0);
  check('4: the project has nothing new now', !svc.projects().includes(proj) && svc.projects().includes(other));
  const tr = toTranscript(rt.get(D));
  const cards = tr.filter((i) => i.role === 'proposal');
  check('4: each proposal is a card in the transcript', cards.length === 3 && cards.every((c) => dream.proposals.some((p) => p.id === c.proposalId)), tr.map((i) => i.role));
  check('4: the first message has origin dream', tr[0].role === 'user' && tr[0].origin === 'dream');
  check('4: a push for the window', pushes.some(([ch, p]) => ch === 'dreaming:changed' && p.waiting === 3));
  check('4: no notification for a dream started by hand', notes.length === 0);
  const [pSkill, pMem, pMod] = dream.proposals;
  check('4: each carries why and its sessions', dream.proposals.every((p) => p.why && p.sessions.length && p.sessions.every((s) => rt.get(s))));

  // Apply, dismiss, revert
  dream = svc.apply(pSkill.id);
  const written = read(skillFile);
  const parsed = parseSkill(written, 'release-chore', skillFile, 'project');
  check('4: Apply writes SKILL.md with the frontmatter the loader reads', parsed.name === 'release-chore' && /CHANGELOG entry and run/.test(parsed.description) && /Run pnpm test/.test(parsed.body), written);
  check('4: applied, and the session waits for two', dream.proposals[0].state === 'applied' && rt.meta(D).dream.waiting === 2);
  dream = svc.dismiss(pMem.id);
  check('4: Dismiss writes nothing', dream.proposals[1].state === 'dismissed' && !fs.existsSync(memFile));
  dream = svc.apply(pMod.id);
  check('4: Apply writes the mod folder', read(path.join(modDir, 'mod.json')) === modFiles[0].content && read(path.join(modDir, 'panel.html')) === modFiles[1].content);
  check('4: a new mod stays off', !app.config().mods?.enabled?.['release-status']);
  dream = svc.revert(pSkill.id);
  check('4: Revert removes a skill that did not exist', !fs.existsSync(skillFile) && !fs.existsSync(path.dirname(skillFile)) && dream.proposals[0].state === 'reverted');
  dream = svc.revert(pMod.id);
  check('4: Revert removes the mod folder', !fs.existsSync(modDir) && dream.proposals[2].state === 'reverted');
  check('4: nothing waits now', rt.meta(D).dream.waiting === 0 && svc.state().waiting === 0);
  let threw = '';
  try {
    svc.revert(pSkill.id);
  } catch (e) {
    threw = e.message;
  }
  check('4: a second revert is refused', /only an applied/.test(threw));

  // ---- 5: refusals, by calling the tools in the dream's session ----
  const ctx = { sessionId: D, cwd: proj, app };
  const run = (name, args) => tool(name).run(args, ctx).then((r) => r.content);
  check('5: a bad skill name (a path) is refused', /^Error: name "..\/evil"/.test(await run('propose_skill', { ...skillArgs, name: '../evil' })));
  check('5: unknown session ids are refused', /^Error: no session with the id "nope"/.test(await run('propose_skill', { ...skillArgs, name: 'other-one', sessions: ['nope'] })));
  check('5: no why is refused', /^Error: say why/.test(await run('propose_memory', { ...memArgs, why: '' })));
  check('5: a secret is refused', /^Error: this seems to contain/.test(await run('propose_memory', { ...memArgs, add: ['The key is sk-ant-abcdefghijklmnopqrstuvwx'] })));
  check('5: a configured key is refused', /^Error: this seems to contain a key from your settings/.test(await run('propose_memory', { ...memArgs, add: ['Gateway login test-key-not-secret'] })));
  check('5: secretIn spots a password URL', secretIn('clone https://bob:hunter2@example.com/x.git') !== null && secretIn('use pnpm') === null);
  check('5: a bad manifest is refused with the problems', /^Error: the mod would not load: .*version/.test(await run('propose_mod', { ...modArgs, id: 'bad-mod', files: [{ path: 'mod.json', content: JSON.stringify({ protocol: 1, id: 'bad-mod', name: 'Bad' }) }] })));
  check('5: a mod file outside the folder is refused', /^Error: file path "..\/..\/x.js" leaves the mod folder/.test(await run('propose_mod', { ...modArgs, id: 'bad-mod', files: [...modFiles, { path: '../../x.js', content: '' }] })));
  check('5: a mod id that is not its folder name is refused', /^Error: the mod would not load: id: "release-status" must equal the folder name "other-mod"/.test(await run('propose_mod', { ...modArgs, id: 'other-mod' })));
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, '---\nname: release-chore\ndescription: old\n---\n\nOld steps\n');
  check('5: an existing skill name without the change flag is refused', /^Error: a skill named "release-chore" exists already/.test(await run('propose_skill', skillArgs)));
  check('5: removing a line the file does not have is refused', /^Error: "nope" is not a line of SILOHARNESS\.md/.test(await run('propose_memory', { scope: 'project', remove: ['nope'], why: 'w', sessions: [B] })));
  check('5: a bundled mod id without the change flag is refused', /exists already \(a built-in one\)/.test(await run('propose_mod', { ...modArgs, id: 'context', files: [{ ...modFiles[0], content: modFiles[0].content.replace(/release-status/g, 'context') }, modFiles[1]] })));
  check('5: a skill named like an app command is refused', /^Error: \/dream is a command of the app/.test(await run('propose_skill', { ...skillArgs, name: 'dream' })));
  check('5: proposals only in a dream', /^Error: proposals can only be made in a dream/.test(await tool('propose_skill').run(skillArgs, { sessionId: A, cwd: proj, app }).then((r) => r.content)));
  // A change to the existing skill, with the flag: it shows what is there and replaces it on Apply; revert puts it back
  const changeRes = await run('propose_skill', { ...skillArgs, changes_existing: true });
  const changeId = PROPOSAL_ID_RE.exec(changeRes)?.[1];
  let pc = svc.state().dreams[0].proposals.find((p) => p.id === changeId);
  check('5: with the flag a change is proposed, with the current file', pc && pc.changesExisting && /Old steps/.test(pc.current) && /^Change skill/.test(pc.title), changeRes);
  svc.apply(changeId);
  check('5: applying it replaces the file', /Run pnpm test/.test(read(skillFile)));
  svc.revert(changeId);
  check('5: reverting it brings the old file back', /Old steps/.test(read(skillFile)));
  // Applying refuses when the target changed since the proposal
  const res2 = await run('propose_skill', { ...skillArgs, changes_existing: true });
  const id2 = PROPOSAL_ID_RE.exec(res2)[1];
  fs.writeFileSync(skillFile, 'edited by hand\n');
  threw = '';
  try {
    svc.apply(id2);
  } catch (e) {
    threw = e.message;
  }
  check('5: Apply refuses when the file changed since it was proposed', /changed since this was proposed/.test(threw) && read(skillFile) === 'edited by hand\n', threw);
  fs.rmSync(path.dirname(skillFile), { recursive: true, force: true });
  // Memory: apply, an edit by hand, revert line by line
  fs.writeFileSync(memFile, '# Notes\n\n- Old fact\n');
  const memRes = await run('propose_memory', { scope: 'project', add: ['Use pnpm, never npm'], remove: ['- Old fact'], why: 'said so', sessions: [B], changes_existing: true });
  const memId = PROPOSAL_ID_RE.exec(memRes)?.[1];
  check('5: memory change proposed (remove needs the flag)', memId && /^Error: removing lines changes/.test(await run('propose_memory', { scope: 'project', remove: ['Old fact'], why: 'w', sessions: [B] })), memRes);
  svc.apply(memId);
  check('5: memory applied: line added, line removed', read(memFile) === '# Notes\n\n- Use pnpm, never npm\n', read(memFile));
  fs.appendFileSync(memFile, '- Added by hand\n');
  svc.revert(memId);
  check('5: memory reverted line by line, the hand edit kept', read(memFile) === '# Notes\n\n- Added by hand\n- Old fact\n', read(memFile));
  check('5: memoryAfter creates a file with a heading', /^# Project instructions/.test(memoryAfter(null, ['- a'], [])));
  // Withdraw and replace
  const w1 = PROPOSAL_ID_RE.exec(await run('propose_memory', { scope: 'user', add: ['Prefers short replies'], why: 'said "keep it short"', sessions: [A] }))[1];
  const w2res = await run('propose_memory', { scope: 'user', add: ['Prefers short, plain replies'], why: 'said "keep it short"', sessions: [A], replaces: w1 });
  const w2 = PROPOSAL_ID_RE.exec(w2res)?.[1];
  let ps = svc.state().dreams[0].proposals;
  check('5: replaces withdraws the old one', ps.find((p) => p.id === w1).state === 'withdrawn' && ps.find((p) => p.id === w2).state === 'waiting', w2res);
  check('5: withdraw_proposal', /^Withdrew/.test(await run('withdraw_proposal', { id: w2 })) && svc.state().dreams[0].proposals.find((p) => p.id === w2).state === 'withdrawn');
  // Apply all
  for (const p of svc.state().dreams[0].proposals) if (p.state === 'waiting') svc.dismiss(p.id);

  // ---- 6: Auto mode: applied when proposed ----
  app.updateConfig({ dreaming: { ...app.config().dreaming, mode: 'auto' } });
  clock += 1000;
  await send(other, 'Another post please, and remember I write in British English [sC2]', [{ content: 'Done.' }]);
  dreamReply({ toolCalls: [call('propose_memory', { scope: 'project', add: ['Write in British English'], why: 'said "remember I write in British English"', sessions: [C] })] });
  dreamReply({ content: 'Applied: added "Write in British English" to SILOHARNESS.md.' });
  svc.start('manual', other);
  await idle();
  dream = svc.state().dreams[0];
  check('6: auto: applied at once', dream.mode === 'auto' && dream.proposals.length === 1 && dream.proposals[0].state === 'applied' && read(path.join(other, 'SILOHARNESS.md')).includes('- Write in British English'), dream.proposals);
  check('6: the reply lists what it did', /Applied:/.test(rt.get(dream.sessionId).messages.at(-1).content));
  check('6: nothing waits', rt.meta(dream.sessionId).dream.waiting === 0);

  // ---- 7: Plan mode: one plan; approving it applies all without a model call ----
  app.updateConfig({ dreaming: { ...app.config().dreaming, mode: 'plan' } });
  clock += 1000;
  const E = await send(proj, 'Release chore once more [sE]', [{ content: 'Done.' }]);
  dreamReply({ toolCalls: [call('propose_skill', { ...skillArgs, sessions: [A, B, E] }), call('propose_memory', { ...memArgs, scope: 'user', add: ['Use pnpm'] })] });
  dreamReply({ content: 'Two suggestions.' });
  svc.start('manual', proj);
  await idle();
  dream = svc.state().dreams[0];
  const P = dream.sessionId;
  check('7: plan: nothing applied, both planned', dream.mode === 'plan' && dream.proposals.every((p) => p.state === 'planned') && !fs.existsSync(skillFile), dream.proposals.map((p) => p.state));
  const plan = rt.get(P).plans?.[dream.planId];
  check('7: one plan on the session, a dream plan, waiting', plan && plan.kind === 'dream' && plan.status === 'proposed' && rt.status(P).attention === 'plan' && /release-chore/.test(plan.markdown), plan);
  check('7: the plan shows in the transcript', toTranscript(rt.get(P)).some((i) => i.role === 'plan' && i.plan.id === plan.id));
  check('7: meta says it waits', rt.meta(P).dream.waiting === 2);
  const reqs = state.requests.length;
  const mode = app.config().permissionMode;
  rt.respondPlan(P, plan.id, 'build-ask');
  await sleep(200);
  dream = svc.state().dreams[0];
  check('7: approving the plan applies them all', dream.proposals.every((p) => p.state === 'applied') && fs.existsSync(skillFile) && read(path.join(home, 'SILOHARNESS.md')).includes('- Use pnpm'), dream.proposals.map((p) => [p.state, p.error]));
  check('7: without a model call or a mode switch', state.requests.length === reqs && !rt.isRunning(P) && app.config().permissionMode === mode);
  check('7: the plan is approved and no longer waits', rt.get(P).plans[plan.id].status === 'approved' && !rt.status(P).attention && rt.meta(P).dream.waiting === 0);
  for (const p of dream.proposals) svc.revert(p.id);
  // Keep planning: the user answers, the dream withdraws one, a new plan follows
  clock += 1000;
  await send(proj, 'Release chore, fourth time [sF]', [{ content: 'Done.' }]);
  dreamReply({ toolCalls: [call('propose_skill', { ...skillArgs, name: 'release-chore-2' }), call('propose_memory', { ...memArgs, scope: 'user', add: ['Likes pnpm'] })] });
  dreamReply({ content: 'Two again.' });
  svc.start('manual', proj);
  await idle();
  dream = svc.state().dreams[0];
  const plan1 = dream.planId;
  rt.respondPlan(dream.sessionId, plan1, 'keep');
  check('7: keep planning: rejected, the proposals stay planned', rt.get(dream.sessionId).plans[plan1].status === 'rejected' && dream.proposals.every((p) => p.state === 'planned'));
  const memPid = dream.proposals[1].id;
  state.replies.push({ when: (p) => isDream(p) && has([...p.messages].reverse().find((m) => m.role === 'user'), 'drop the memory'), toolCalls: [call('withdraw_proposal', { id: memPid })] });
  state.replies.push({ when: (p) => isDream(p) && has([...p.messages].reverse().find((m) => m.role === 'user'), 'drop the memory'), content: 'Dropped it.' });
  rt.send(dream.sessionId, 'drop the memory one');
  await idle();
  dream = svc.state().dreams[0];
  check('7: after the answer: one withdrawn, a new plan with the rest', dream.proposals[1].state === 'withdrawn' && dream.planId !== plan1 && rt.get(dream.sessionId).plans[dream.planId].status === 'proposed' && /release-chore-2/.test(rt.get(dream.sessionId).plans[dream.planId].markdown) && !/Likes pnpm/.test(rt.get(dream.sessionId).plans[dream.planId].markdown));
  const all = svc.applyAll(dream.id);
  check('7: Apply all from the page decides the plan too', all.proposals[0].state === 'applied' && rt.get(dream.sessionId).plans[dream.planId].status === 'approved');
  svc.revert(all.proposals[0].id);

  // ---- 8: the daily time and the missed run ----
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();
  check('8: latest and next occurrence', latestOccurrence('03:00', at(2026, 10, 6, 2, 0)) === at(2026, 10, 5, 3, 0) && latestOccurrence('03:00', at(2026, 10, 6, 3, 0)) === at(2026, 10, 6, 3, 0) && nextOccurrence('03:00', at(2026, 10, 6, 3, 0)) === at(2026, 10, 7, 3, 0));
  app.updateConfig({ dreaming: { ...app.config().dreaming, mode: 'approve' } });
  clock = Date.now() + 2 * 86400000;
  // New activity so there is something to dream about
  await send(proj, 'Release chore, fifth time [sG]', [{ content: 'Done.' }]);
  const dreamsBefore = svc.state().dreams.length;
  const t0 = at(new Date(clock).getFullYear(), new Date(clock).getMonth(), new Date(clock).getDate(), 2, 0) + 86400000; // tomorrow 02:00
  clock = t0;
  app.updateConfig({ dreaming: { ...app.config().dreaming, daily: true, time: '03:00' } });
  svc.tick();
  check('8: turning it on does not dream at once for a time already past', svc.state().dreams.length === dreamsBefore && svc.state().nextRunAt === t0 + 3600000);
  clock = t0 + 3600000 + 30000; // 03:00:30
  dreamReply({ toolCalls: [call('propose_memory', { scope: 'project', add: ['Release from main only'], why: 'five times', sessions: [B] })] });
  dreamReply({ content: 'One.' });
  svc.tick();
  check('8: at the time, the daily dream starts', svc.running() && svc.state().dreams[0].trigger === 'daily');
  await idle();
  check('8: a scheduled dream with proposals waiting notifies', notes.length === 1 && /dreamed about shop/.test(notes[0][0]) && /1 suggestion waits/.test(notes[0][1]), notes);
  svc.tick();
  check('8: once a day', svc.state().dreams.filter((x) => x.trigger === 'daily').length === 1);
  // Missed: the app was closed at 03:00 the next day; at the next launch it runs once, unless one ran in the last 20 h
  await send(proj, 'Release chore, sixth time [sH]', [{ content: 'Done.' }]);
  clock = t0 + 86400000 + 3600000 + 5 * 3600000; // the day after, 08:00
  svc.tick();
  check('8: missed (the app was closed at 03:00), the last dream 29 h ago: it runs once after the launch', svc.running() && svc.state().dreams[0].trigger === 'daily' && svc.state().dreams.filter((x) => x.trigger === 'daily').length === 2);
  dreamReply({ content: 'Nothing worth proposing.' });
  await idle();
  check('8: a dream with nothing to propose is done, nothing waits', svc.state().dreams[0].status === 'done' && svc.state().dreams[0].proposals.length === 0 && rt.meta(svc.state().dreams[0].sessionId).dream.waiting === 0);
  await send(proj, 'Release chore, seventh time [sI]', [{ content: 'Done.' }]);
  clock = t0 + 86400000 + 10 * 3600000; // that day, 12:00: a look by hand that finds nothing new does not count as a dream
  svc.start('manual', other);
  check('8: a run with nothing new makes no session and does not count', !svc.running() && svc.state().lastCheck.found === 0 && svc.data.lastRunAt < clock);
  await send(other, 'One more post [sK]', [{ content: 'Done.' }]);
  dreamReply({ content: 'Nothing worth proposing.' });
  svc.start('manual', other); // a real dream by hand at 12:00
  await idle();
  const nDaily = svc.state().dreams.filter((x) => x.trigger === 'daily').length;
  clock = t0 + 2 * 86400000 + 5 * 3600000; // the next day, 07:00: 03:00 was missed, and a dream ran 19 h ago
  svc.tick();
  check('8: missed while a dream ran in the last 20 hours: skipped, not run later that day', !svc.running() && svc.state().dreams.filter((x) => x.trigger === 'daily').length === nDaily && svc.data.dailyFor === latestOccurrence('03:00', clock));
  clock += 3600000;
  svc.tick();
  check('8: and not on a later tick either', !svc.running());
  app.updateConfig({ dreaming: { ...app.config().dreaming, daily: false } });

  // ---- 9: /dream ----
  const cmd = (args = '') => app.invokeRpc('commands.run', ['dream', args]);
  rt.setForeground(C);
  let r = await cmd();
  check('9: /dream with nothing new says so', /Nothing new to dream about in .*blog/.test(r.notice ?? ''), r);
  rt.setForeground(B);
  dreamReply({ content: 'Nothing worth proposing.' });
  r = await cmd();
  check("9: /dream dreams about the current session's project", /Dreaming about .*shop/.test(r.notice ?? '') && svc.state().dreams[0].trigger === 'command' && svc.state().dreams[0].cwd === proj, r);
  await idle();

  // ---- 10: restart in the middle of a dream ----
  clock += 1000;
  await send(proj, 'Release chore, eighth time [sJ]', [{ content: 'Done.' }]);
  const cursorBefore = svc.data.cursors[proj];
  dreamReply({ toolCalls: [call('propose_memory', { scope: 'project', add: ['Tag releases as vX.Y.Z'], why: 'every time', sessions: [B] })] });
  dreamReply({ content: 'late', delayMs: 4000 });
  svc.start('manual', proj);
  const R = svc.state().dreams[0];
  await waitFor(() => svc.state().dreams[0].proposals.length === 1, 8000, 'the proposal');
  // The app goes away mid-run (no run_end); a new app starts on the same data
  for (const fn of [svc.dispose.bind(svc)]) fn();
  ({ app, svc } = make());
  rt = app.runtime;
  const after = svc.state().dreams.find((x) => x.id === R.id);
  check('10: after a restart the dream is stopped, its proposal kept', after.status === 'stopped' && /closed during/.test(after.error) && after.proposals.length === 1 && after.proposals[0].state === 'waiting', after);
  check('10: the cursor did not move', svc.data.cursors[proj] === cursorBefore);
  check('10: the session is still a dream with its own tools', rt.get(R.sessionId)?.origin === 'dream' && rt.get(R.sessionId).tools.includes('propose_skill') && !rt.get(R.sessionId).tools.includes('bash'));
  check('10: its proposal can still be applied', svc.apply(after.proposals[0].id).proposals[0].state === 'applied' && read(memFile).includes('Tag releases'));
  check('10: the project is offered again', svc.projects().includes(proj));
  // A failed dream (the model errors): failed with the reason, cursor kept
  mock.close();
  const warn = console.warn;
  console.warn = (...a) => (/streaming failed/.test(String(a[0])) ? undefined : warn(...a));
  // The model is gone: the retry loop tries six times; its waits return at once here (agent/retry.ts retryTiming)
  require(path.join(projectDir, 'dist/main/agent/retry.js')).retryTiming.sleep = async () => {};
  svc.start('manual', proj);
  await waitFor(() => svc.state().dreams[0].status !== 'running', 15000, 'the dream to fail');
  check('10: a dream whose model call fails is failed with the reason', svc.state().dreams[0].status === 'failed' && svc.state().dreams[0].error, svc.state().dreams[0].error);
  check('10: and the cursor stays', svc.data.cursors[proj] === cursorBefore);

  const file = path.join(userData, 'dreaming.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('11: state in its own file under userData', saved.version === 1 && Array.isArray(saved.dreams) && typeof saved.cursors[proj] === 'number');
  check('11: no temp files left', !fs.readdirSync(userData).some((f) => f.startsWith('dreaming.json.tmp')));

  // ---- 12: a dream does not write through a link that leaves the project or the config folder ----
  {
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(path.join(elsewhere, 'victim'), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'rc'), 'export A=1\n');
    const linked = path.join(tmp, 'linked-project');
    fs.mkdirSync(path.join(linked, '.silo-harness'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(linked, '.silo-harness', 'mods'));
    fs.symlinkSync(path.join(elsewhere, 'rc'), path.join(linked, 'AGENTS.md'));
    fs.mkdirSync(path.join(linked, 'docs'));
    fs.writeFileSync(path.join(linked, 'docs', 'CLAUDE.md'), '- a line\n');
    fs.symlinkSync(path.join(linked, 'docs', 'CLAUDE.md'), path.join(linked, 'CLAUDE.md'));
    const roots = { cwd: linked, configDir: home, appRoot: projectDir };
    check('12: a mod folder that is a link out of the project is refused', !allowedTarget(path.join(linked, '.silo-harness', 'mods', 'victim'), roots) && !allowedTarget(path.join(linked, '.silo-harness', 'mods', 'new-mod', 'mod.json'), roots));
    check('12: an instructions file that is a link out of the project is refused', !allowedTarget(path.join(linked, 'AGENTS.md'), roots));
    check('12: a link that stays inside the project is fine', allowedTarget(path.join(linked, 'CLAUDE.md'), roots));
    check('12: ordinary targets are allowed, existing or not', allowedTarget(path.join(linked, '.silo-harness', 'skills', 'new-skill', 'SKILL.md'), roots) && allowedTarget(path.join(home, 'skills', 'x', 'SKILL.md'), roots) && allowedTarget(path.join(linked, 'SILOHARNESS.md'), roots));
    check('12: anything else is refused', !allowedTarget(path.join(linked, 'src', 'index.js'), roots) && !allowedTarget(path.join(home, 'settings.json'), roots) && !allowedTarget(path.join(linked, '.silo-harness', 'mods'), roots));
    check('12: the names from before the rename are allowed too', allowedTarget(path.join(linked, '.open-harness', 'skills', 'old', 'SKILL.md'), roots) && allowedTarget(path.join(linked, '.open-harness', 'mods', 'old', 'mod.json'), roots) && allowedTarget(path.join(linked, 'OPENHARNESS.md'), roots) && allowedTarget(path.join(home, 'OPENHARNESS.md'), roots) && allowedTarget(path.join(home, 'SILOHARNESS.md'), roots));
    const { instructionsFile, skillsDir } = require(path.join(projectDir, 'dist/main/dreaming/apply.js'));
    const oldProject = path.join(tmp, 'old-project');
    fs.mkdirSync(path.join(oldProject, '.open-harness', 'skills'), { recursive: true });
    const oldHome = path.join(tmp, 'old-home');
    fs.mkdirSync(oldHome);
    fs.writeFileSync(path.join(oldHome, 'OPENHARNESS.md'), '- old\n');
    const oldRoots = { cwd: oldProject, configDir: oldHome, appRoot: projectDir };
    check('12: a project with only .open-harness gets its skills written there', skillsDir('project', oldRoots) === path.join(oldProject, '.open-harness', 'skills'));
    check('12: a config folder with only OPENHARNESS.md gets its memory written there', instructionsFile('user', oldRoots).path === path.join(oldHome, 'OPENHARNESS.md'));
    check('12: … and a new one gets SILOHARNESS.md', instructionsFile('user', roots).path === path.join(home, 'SILOHARNESS.md') || fs.existsSync(path.join(home, 'OPENHARNESS.md')));
  }
  svc.dispose();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
