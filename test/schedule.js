// The order of a reply's tool calls (src/main/agent/schedule.ts, Agent.prepareTool/shareable): a run of read-only
// calls together and up to the limit, every other call alone; results stored in call order; each call keeps its own
// permission decision, with cards and safety checks one at a time; a stop in a group ends all of it and the history
// stays valid (repairTail); limit 1 is the old loop exactly. Reads are slowed down here by wrapping the built-in tools.
// Run: node test/schedule.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const S = dist('agent/schedule.js');
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const fsTools = dist('tools/fs.js');
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Drives runSchedule with fakes: each item { share, ms, fail, done }; returns the log of starts, ends and commits. */
async function drive(items, limit, opts = {}) {
  const log = [];
  let inFlight = 0;
  let peak = 0;
  let stop = false;
  const groups = [];
  await S.runSchedule(items, limit, {
    candidate: (it) => it.share !== false && it.candidate !== false,
    prepare: async (it, i) => {
      log.push(`p${i}`);
      if (it.done) return { done: `early${i}` };
      return { ready: it, share: !!it.share };
    },
    run: async (it, _x, i, g) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      log.push(`s${i}`);
      await sleep(it.ms ?? 10);
      inFlight--;
      log.push(`e${i}`);
      if (it.fail) throw new Error('boom');
      return `r${i}:g${g}`;
    },
    skip: (_it, _x, i) => `skipped${i}`,
    failed: (_it, i) => `failed${i}`,
    commit: (_it, i, r) => {
      log.push(`c${i}=${r}`);
      if (opts.stopAt === i) stop = true;
    },
    stopped: () => stop,
    group: (g, size) => groups.push(`${g}:${size}`),
  });
  return { log, peak, groups, commits: log.filter((x) => x.startsWith('c')) };
}

const idx = (log, x) => log.indexOf(x);

(async () => {
  // ---------- 1: the pure table ----------
  check('1: planGroups: runs of shared calls are one group, the rest alone', JSON.stringify(S.planGroups([true, true, false, true, false, false, true, true, true], 4)) === JSON.stringify([[0, 1], [2], [3], [4], [5], [6, 7, 8]]));
  check('1: planGroups: limit 1 makes every call its own group', JSON.stringify(S.planGroups([true, true, true], 1)) === JSON.stringify([[0], [1], [2]]));
  check('1: the limit: default 4, 1 turns it off, at most 10, junk is the default', S.concurrencyLimit(undefined) === 4 && S.concurrencyLimit(1) === 1 && S.concurrencyLimit(25) === 10 && S.concurrencyLimit(0) === 4 && S.concurrencyLimit(2.5) === 4 && S.concurrencyLimit('3') === 4);
  {
    const r = await drive([{ share: true, ms: 120 }, { share: true, ms: 20 }, { share: true, ms: 60 }], 4);
    check('1: three shared calls start together; the slowest first finishes last; committed in call order', idx(r.log, 's2') < idx(r.log, 'e1') && r.commits.join() === 'c0=r0:g1,c1=r1:g1,c2=r2:g1' && r.groups.join() === '1:3', r.log);
  }
  {
    const r = await drive([{ share: true, ms: 50 }, { share: false, ms: 10 }, { share: true, ms: 10 }, { share: true, ms: 10 }], 4);
    check('1: a barrier starts after everything before it ended, and nothing after it starts before it ends', idx(r.log, 'p1') > idx(r.log, 'e0') && idx(r.log, 'p2') > idx(r.log, 'e1') && r.commits.join() === 'c0=r0:g1,c1=r1:g2,c2=r2:g3,c3=r3:g3' && r.groups.join() === '1:1,2:1,3:2', r.log);
  }
  {
    // Prepared as shareable but judged a barrier on its final arguments (a hook rewrote it)
    const r = await drive([{ share: true, ms: 60 }, { candidate: true, share: false, ms: 10 }, { share: true, ms: 10 }], 4);
    check('1: a call judged a barrier after preparing waits for the group, and runs alone', idx(r.log, 's1') > idx(r.log, 'e0') && idx(r.log, 's2') > idx(r.log, 'e1'), r.log);
  }
  {
    const r = await drive(Array.from({ length: 7 }, () => ({ share: true, ms: 30 })), 3);
    check('1: never more than the limit at once', r.peak === 3 && r.commits.length === 7, r.peak);
  }
  {
    const r = await drive([{ share: true, ms: 30 }, { share: true, ms: 10, fail: true }, { share: true, ms: 40 }], 4);
    check('1: one failed call does not end its siblings', r.commits.join() === 'c0=r0:g1,c1=failed1,c2=r2:g1', r.commits);
  }
  {
    const r = await drive([{ share: true, ms: 10 }, { share: true, ms: 60 }, { share: true, ms: 60 }, { share: true, ms: 10 }, { share: false, ms: 10 }], 3, { stopAt: 0 });
    check('1: a stop: nothing new starts, what runs finishes and is committed, the rest is never prepared', r.commits.join() === 'c0=r0:g1,c1=r1:g1,c2=r2:g1' && !r.log.includes('p3') && !r.log.includes('p4'), r.log);
  }
  {
    const r = await drive([{ share: true, ms: 10, done: true }, { share: true, ms: 10 }], 4);
    check('1: an early exit is committed in its place', r.commits.join() === 'c0=early0,c1=r1:g1', r.commits);
  }
  {
    const r = await drive([{ share: true, ms: 40 }, { share: true, ms: 10 }, { share: false, ms: 10 }], 1);
    check('1: limit 1 is one call at a time, each prepared after the one before ended', r.log.join() === 'p0,s0,e0,c0=r0:g1,p1,s1,e1,c1=r1:g2,p2,s2,e2,c2=r2:g3', r.log);
  }

  // ---------- 2: the agent ----------
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-schedule-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(proj);
  for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(proj, `${n}.txt`), `content ${n}\n`);
  fs.writeFileSync(path.join(proj, '.env'), 'TOKEN=made-up\n');
  fs.writeFileSync(path.join(proj, 'k.pem'), 'made-up\n');
  // read_file sleeps for `delay_ms` (its own argument, which the real tool ignores) and ends early on a stop
  const realRead = fsTools.readFile.run;
  let readsRunning = 0;
  let readsPeak = 0;
  fsTools.readFile.run = async (args, ctx) => {
    readsRunning++;
    readsPeak = Math.max(readsPeak, readsRunning);
    try {
      if (args.delay_ms) await sleep(args.delay_ms, ctx.signal);
      if (ctx.signal?.aborted) return { content: 'Tool call was interrupted before it produced a result.' };
      return await realRead(args, ctx);
    } finally {
      readsRunning--;
    }
  };
  let config = {
    provider: 'portkey',
    ollama: { baseURL: 'http://127.0.0.1:1', model: 'm', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'k', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: proj, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {},
  };
  const store = new SessionStore(path.join(tmp, 'sessions'));
  let events = [];
  let hooks = null;
  const agent = new Agent(() => config, { navigate: async () => '' }, store, () => [], (ev) => {
    events.push({ ...ev, t: performance.now() });
    // Answer cards on their own, after a moment, when a test asks to
    if (ev.type === 'approval_request' && autoAnswer) setTimeout(() => agent.resolveApproval(ev.id, autoAnswer === 'allow'), 60);
  }, undefined, undefined, undefined, { hooks: { has: (ev) => !!hooks?.[ev], fire: async (ev, ctx) => hooks[ev](ctx) } });
  let autoAnswer = null;
  const read = (id, file, ms) => ({ id, name: 'read_file', args: { path: file, delay_ms: ms } });
  const fresh = () => {
    events = [];
    state.requests.length = 0;
    state.replies.length = 0;
    agent.session = store.create();
  };
  const ev = (type) => events.filter((e) => e.type === type);
  const toolMsgs = () => agent.session.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  const resultOf = (id) => agent.session.messages.find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';

  // Three slow reads
  fresh();
  state.replies.push({ content: '', toolCalls: [read('r1', 'a.txt', 300), read('r2', 'b.txt', 100), read('r3', 'c.txt', 200)] }, { content: 'Read them.' });
  let t0 = performance.now();
  await agent.run('Read a, b and c');
  const together = performance.now() - t0;
  check('2: three slow reads (300, 100, 200 ms) take about the longest, not the sum', together < 520 && readsPeak === 3, { ms: Math.round(together), readsPeak });
  check('2: …their results are stored in call order, each with its own content', toolMsgs().join() === 'r1,r2,r3' && /content a/.test(resultOf('r1')) && /content b/.test(resultOf('r2')) && /content c/.test(resultOf('r3')));
  const req = state.requests[state.requests.length - 1].payload.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  check('2: …and sent back to the model in call order', req.join() === 'r1,r2,r3', req);
  const order = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end').map((e) => `${e.type === 'tool_start' ? 's' : 'e'}:${e.id}`);
  check('2: …the rows start together and end as they finish', order.join() === 's:r1,s:r2,s:r3,e:r2,e:r3,e:r1', order);
  check('2: …the timing record says three ran together in one group', agent.lastTiming().tools.every((t) => t.alongside === 2 && t.group === 1) && agent.lastTiming().groups.length === 1 && agent.lastTiming().limit === 4, agent.lastTiming().tools.map((t) => [t.group, t.alongside]));

  // The same with toolConcurrency 1: exactly the old order
  config = { ...config, toolConcurrency: 1 };
  fresh();
  readsPeak = 0;
  state.replies.push({ content: '', toolCalls: [read('s1', 'a.txt', 300), read('s2', 'b.txt', 100), read('s3', 'c.txt', 200)] }, { content: 'Read them.' });
  t0 = performance.now();
  await agent.run('Read a, b and c');
  const serial = performance.now() - t0;
  const order1 = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end').map((e) => `${e.type === 'tool_start' ? 's' : 'e'}:${e.id}`);
  check('2: limit 1: one after another, as before', serial >= 600 && readsPeak === 1 && order1.join() === 's:s1,e:s1,s:s2,e:s2,s:s3,e:s3' && toolMsgs().join() === 's1,s2,s3', { ms: Math.round(serial), order1 });
  config = { ...config, toolConcurrency: undefined };

  // An edit between reads is a barrier; the read after it sees the edit
  fresh();
  state.replies.push(
    {
      content: '',
      toolCalls: [read('e1', 'a.txt', 200), read('e2', 'b.txt', 50), { id: 'e3', name: 'edit_file', args: { path: 'a.txt', old_string: 'content a', new_string: 'edited a' } }, read('e4', 'a.txt', 10), read('e5', 'd.txt', 10)],
    },
    { content: 'Edited.' },
  );
  await agent.run('Edit a');
  const at = (type, id) => events.find((e) => e.type === type && e.id === id)?.t ?? NaN;
  check('2: the edit starts after both reads before it ended', at('tool_start', 'e3') >= at('tool_end', 'e1') && at('tool_start', 'e3') >= at('tool_end', 'e2'), { s3: at('tool_start', 'e3'), e1: at('tool_end', 'e1') });
  check('2: the reads after it start after it ended, and see the edit', at('tool_start', 'e4') >= at('tool_end', 'e3') && /edited a/.test(resultOf('e4')) && toolMsgs().join() === 'e1,e2,e3,e4,e5', resultOf('e4'));
  check('2: …groups: the two reads, the edit, the two reads', agent.lastTiming().groups.map((g) => g.size).join() === '2,1,2', agent.lastTiming().groups);

  // bash: a read-only command shares; a writing one, and one the guard flags, are barriers
  const A = agent;
  const tools = A.toolsFor ? null : null;
  void tools;
  const share = (cmd) => A.shareable('bash', { command: cmd }, A.toolPool(config), proj);
  check('2: bash shares only a read-only command the guard has nothing against', share('cat a.txt') && share('ls -la') && !share('echo x > a.txt') && !share('rm a.txt') && !share('cat ~/.ssh/id_rsa') && !share('git push') && !share('') && !share('cat $(echo a.txt)'));
  const sh = (name, args = {}) => A.shareable(name, args, A.toolPool(config), proj);
  check('2: the reads and web_fetch share; edits, writes, the terminal, the browser, questions, plans, web_search, MCP do not', sh('read_file') && sh('grep') && sh('glob') && sh('list_directory') && sh('web_fetch') && !sh('write_file') && !sh('edit_file') && !sh('terminal_run') && !sh('browser_navigate') && !sh('ask_user') && !sh('update_tasks') && !sh('web_search') && !sh('mcp__x__read') && !sh('nope'));

  // A PreToolUse hook that rewrites a read-only command into a writing one: judged on the final arguments
  fresh();
  hooks = {
    PreToolUse: async (ctx) => (ctx.fields.tool_use_id === 'h2' ? { ran: 1, context: [], notices: [], updatedInput: { command: `echo hooked > ${path.join(proj, 'hooked.txt')}` } } : { ran: 1, context: [], notices: [] }),
  };
  state.replies.push({ content: '', toolCalls: [read('h1', 'a.txt', 200), { id: 'h2', name: 'bash', args: { command: 'ls' } }, read('h3', 'b.txt', 10)] }, { content: 'Ok.' });
  await agent.run('Hooked');
  check('2: a hook turned a read into a write: it waits for the read before it and holds the read after it', at('tool_start', 'h2') <= at('tool_end', 'h1') /* its row starts when prepared */ && events.find((e) => e.type === 'tool_end' && e.id === 'h2').t >= at('tool_end', 'h1') && at('tool_start', 'h3') >= at('tool_end', 'h2') && fs.existsSync(path.join(proj, 'hooked.txt')), order);
  hooks = null;

  // One failed read does not cancel the others
  fresh();
  state.replies.push({ content: '', toolCalls: [read('f1', 'a.txt', 100), read('f2', 'missing.txt', 10), read('f3', 'b.txt', 50)] }, { content: 'Ok.' });
  await agent.run('Some fail');
  check('2: a failed read does not end its siblings', /^Error/.test(resultOf('f2')) && /content b/.test(resultOf('f3')) && /edited a|content a/.test(resultOf('f1')), [resultOf('f1'), resultOf('f2'), resultOf('f3')].map((x) => x.slice(0, 30)));

  // Stop in the middle of a group: all of it ends, every call gets a result, the next message works
  fresh();
  config = { ...config, toolConcurrency: 2 };
  state.replies.push({ content: '', toolCalls: [read('x1', 'a.txt', 3000), read('x2', 'b.txt', 3000), read('x3', 'c.txt', 3000)] });
  t0 = performance.now();
  const stopped = agent.run('Long reads');
  await sleep(200);
  agent.stop();
  await stopped;
  const tookStop = performance.now() - t0;
  check('2: Stop during a group ends it at once', tookStop < 1000 && ev('run_end')[0]?.reason === 'aborted', { ms: Math.round(tookStop), end: ev('run_end')[0] });
  check('2: …every call has a result, in call order, the one that never started included (repairTail)', toolMsgs().join() === 'x1,x2,x3' && agent.session.messages.filter((m) => m.role === 'tool').every((m) => /interrupted/.test(m.content)), agent.session.messages.filter((m) => m.role === 'tool').map((m) => m.content.slice(0, 40)));
  check('2: …no row is left running', ev('tool_start').every((s) => ev('tool_end').some((e) => e.id === s.id)), ev('tool_start').map((e) => e.id));
  const timedStop = agent.lastTiming();
  check('2: …the timing record says stopped', timedStop.end === 'aborted' && timedStop.tools.every((t) => t.outcome === 'stopped'), timedStop.tools.map((t) => t.outcome));
  config = { ...config, toolConcurrency: undefined };
  state.replies.length = 0;
  state.replies.push({ content: 'Back.' });
  events = [];
  await agent.run('Next message');
  const next = state.requests[state.requests.length - 1].payload.messages;
  const calls = next.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
  const answered = next.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  check('2: …the next message works and its request answers every call', ev('run_end')[0]?.reason === 'done' && calls.join() === answered.join() && calls.length === 3, { calls, answered });

  // Two calls that each need a card (ask mode, secret reads): one card at a time, each decided on its own
  config = { ...config, permissionMode: 'ask' };
  fresh();
  autoAnswer = 'allow';
  state.replies.push({ content: '', toolCalls: [read('k1', '.env', 10), read('k2', 'k.pem', 10), read('k3', 'b.txt', 300)] }, { content: 'Ok.' });
  await agent.run('Secrets');
  const reqs = ev('approval_request');
  const resolved = ev('approval_resolved');
  check('2: two cards, one after the other: the second shows after the first was answered', reqs.length === 2 && resolved.length === 2 && reqs[1].t >= resolved[0].t, reqs.map((r) => r.t - reqs[0].t));
  check('2: …each card names its own call', reqs[0].callId === 'k1' && reqs[1].callId === 'k2' && /\.env$/.test(reqs[0].detail) && /k\.pem$/.test(reqs[1].detail), reqs.map((r) => [r.callId, r.detail.slice(-6)]));
  check('2: …a call waiting for a card does not hold up the read beside it', at('tool_end', 'k3') - at('tool_start', 'k3') < 450 && /content b/.test(resultOf('k3')), at('tool_end', 'k3') - at('tool_start', 'k3'));
  check('2: …the timing record has each card and its wait', agent.lastTiming().tools.filter((t) => t.permission[0]?.path === 'card').length === 2 && agent.lastTiming().summary.approvalsMs >= 100, agent.lastTiming().tools.map((t) => t.permission));
  // A card answered "for this session" lets the next one of the same kind through without a second card
  fresh();
  autoAnswer = null;
  state.replies.push({ content: '', toolCalls: [read('m1', '.env', 10), read('m2', 'k.pem', 10)] }, { content: 'Ok.' });
  const runM = agent.run('Secrets again');
  for (let i = 0; i < 100 && !ev('approval_request').length; i++) await sleep(10);
  agent.resolveApproval(ev('approval_request')[0].id, true, true, 'session');
  await runM;
  check('2: "for this session" on the first card: the second call asks no more (decided when its turn came)', ev('approval_request').length === 1 && /made-up/.test(resultOf('m1')) && /made-up/.test(resultOf('m2')), ev('approval_request').length);
  // Denied
  fresh();
  autoAnswer = 'deny';
  state.replies.push({ content: '', toolCalls: [read('d1', 'x.pem', 10), read('d2', 'a.txt', 10)] }, { content: 'Ok.' });
  fs.writeFileSync(path.join(proj, 'x.pem'), 'made-up\n');
  await agent.run('Denied');
  check('2: a denied call does not run; the read beside it does', /Not permitted|denied/i.test(resultOf('d1')) && /content a|edited a/.test(resultOf('d2')) && agent.lastTiming().tools[0].outcome === 'denied', [resultOf('d1').slice(0, 40), agent.lastTiming().tools[0].outcome]);
  autoAnswer = null;

  // Auto mode: a blocked call in a group; checks one at a time; the counts as one at a time
  config = { ...config, permissionMode: 'auto', autoMode: { environment: '', allow: [], model: '' } };
  fresh();
  state.classifierDefault = { decision: 'block', reason: '[Secrets] reads a key (made-up)' };
  state.replies.push({ content: '', toolCalls: [read('b1', 'k.pem', 10), read('b2', 'a.txt', 200), read('b3', '.env', 10)] }, { content: 'Ok.' });
  await agent.run('Auto');
  const blocks = ev('auto_blocked');
  check('2: Auto mode: both secret reads go to the check and are blocked; the plain read runs', blocks.length === 2 && /^Blocked by Auto mode/.test(resultOf('b1')) && /^Blocked by Auto mode/.test(resultOf('b3')) && /content a|edited a/.test(resultOf('b2')), blocks.map((b) => b.block.id));
  const checks = state.requests.filter((r) => !r.payload.stream && r.url === '/v1/chat/completions');
  check('2: …two checks were made, one per call', checks.length === 2, checks.length);
  const st = agent.autoStates.get(agent.session.id);
  check('2: …the block counts are the same as one at a time (2 in a row, 2 in all)', st.inARow === 2 && st.total === 2 && !st.paused, st);
  check('2: …the timing record has two checks, both blocks', agent.lastTiming().tools.filter((t) => t.permission[0]?.check === 'block' && t.outcome === 'blocked').length === 2 && agent.lastTiming().summary.checksMs > 0, agent.lastTiming().tools.map((t) => t.permission));
  delete state.classifierDefault;

  fsTools.readFile.run = realRead;
  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
