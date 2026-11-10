// Tool groups on Anthropic's native path (agent/anthropic.ts deferPlan): every group's tools are in the request from
// the first one, deferred; a load's result references them (tool_reference blocks, then its guidance as text), so the
// request's tools never change; an implied load (a group's tool called before its load) references them too; groups a
// compaction folded are sent loaded up front; a model that refuses deferred tools gets the old way for the process.
// Run: node test/deferred-groups.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { Agent } = dist('agent.js');
const { SessionStore } = dist('sessions.js');
const A = dist('agent/anthropic.js');
const G = dist('tools/groups.js');
const { allTools, toSpec } = dist('tools/index.js');
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  // ---- 1: pure ----
  const specs = allTools('ask').map(toSpec);
  check('1: the groups\' tool specs carry their group where JSON does not see it', G.groupOfSpec(specs.find((s) => s.function.name === 'browser_navigate')) === 'browser' && !JSON.stringify(specs).includes('group') && !G.groupOfSpec(specs.find((s) => s.function.name === 'bash')));
  const brief = `[Context compacted]\nBrief.\n\n${G.FOLDED_GROUPS_HEADING}\nLoaded browser: browser_navigate, browser_click.\nBrowser rules…\n\n## Files touched\n- read: a`;
  check('1: the groups a brief says were loaded', same(G.foldedGroups(brief), ['browser']) && same(G.foldedGroups('no heading'), []));
  const plan = A.deferPlan('claude-haiku-5-5', [{ role: 'user', content: brief }, { role: 'user', content: 'go' }], specs);
  check('1: after a fold, the folded group is sent up front, the other deferred', !plan.deferred.has('browser_navigate') && plan.deferred.has('terminal_run') && [...plan.deferred].every((n) => /^(terminal_|web_)/.test(n)), [...plan.deferred]);
  const noGroups = A.deferPlan('claude-haiku-5-5', [{ role: 'user', content: 'q' }], specs.filter((s) => !G.groupOfSpec(s)));
  check('1: no groups, nothing deferred', noGroups.deferred.size === 0);

  // ---- 2: through the agent ----
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-deferred-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  let config = {
    provider: 'claude',
    providers: { claude: { type: 'anthropic', baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'k-test-1234', model: 'claude-haiku-5-5' } },
    ollama: { baseURL: 'http://127.0.0.1:1', model: 'm', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: '', apiKey: '', model: '', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: tmp, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, toolSet: 'auto',
  };
  const store = new SessionStore(path.join(tmp, 'sessions'));
  let events = [];
  const agent = new Agent(() => config, { navigate: async (u) => `Now at ${u}` }, store, () => [], (ev) => events.push(ev), undefined, undefined, undefined, { foreground: () => true });
  const native = () => state.requests.filter((r) => r.url.startsWith('/v1/messages') && r.payload.stream).map((r) => r.payload);
  const reset = () => {
    events = [];
    state.requests.length = 0;
    state.replies.length = 0;
  };
  state.replies.push({ content: 'Hi.' });
  await agent.run('Say hi');
  state.replies.push({ content: '', toolCalls: [{ id: 'toolu_load', name: 'load_tools', args: { groups: ['terminal'] } }] });
  state.replies.push({ content: '', toolCalls: [{ id: 'toolu_list', name: 'terminal_list', args: {} }] });
  state.replies.push({ content: 'Listed.' });
  await agent.run('Load the terminal tools and list the terminals');
  const reqs = native();
  const tools0 = JSON.stringify(reqs[0].tools);
  check('2: four requests, the same tools in every one (a load changes nothing there)', reqs.length === 4 && reqs.every((r) => JSON.stringify(r.tools) === tools0), reqs.length);
  const t0 = reqs[0].tools;
  const deferredNames = t0.filter((t) => t.defer_loading).map((t) => t.name);
  check('2: the groups\' tools are deferred, the core tools and load_tools are not', deferredNames.length > 5 && deferredNames.every((n) => /^(browser_|terminal_|web_)/.test(n)) && deferredNames.includes('web_fetch') && t0.some((t) => t.name === 'load_tools' && !t.defer_loading) && t0.some((t) => t.name === 'bash' && !t.defer_loading), deferredNames);
  check('2: the cache mark on the last tool loaded up front, none on a deferred one', t0.filter((t) => t.cache_control).length === 1 && !t0.find((t) => t.cache_control).defer_loading);
  const afterLoad = reqs[2].messages;
  const loadTurn = afterLoad.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_load'));
  const result = loadTurn.content.find((b) => b.tool_use_id === 'toolu_load');
  const termNames = t0.filter((t) => t.name.startsWith('terminal_')).map((t) => t.name);
  check('2: the load\'s result is the terminal tools\' references, nothing else', Array.isArray(result.content) && result.content.every((b) => b.type === 'tool_reference') && same(result.content.map((b) => b.tool_name), termNames), result.content);
  check('2: …and what the load says follows it as text in the same turn', loadTurn.content.some((b) => b.type === 'text' && /^Loaded terminal: /.test(b.text)) && loadTurn.content[0].type === 'tool_result');
  check('2: the loaded tool ran and the run ended', events.filter((e) => e.type === 'run_end').pop()?.text === 'Listed.' && agent.session.toolGroups.includes('terminal'), [events.filter((e) => e.type === 'run_end'), agent.session.toolGroups]);
  check('2: the stored history is as before (the result is text)', typeof agent.session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'toolu_load').content === 'string');
  // The context breakdown counts only the loaded groups' tools
  const bd = agent.contextBreakdown();
  check('2: the breakdown counts the loaded groups only', bd.slices.find((s) => s.key === 'tools').tokens > 0);

  // ---- 3: an implied load (a group's tool called before its load) ----
  reset();
  state.replies.push({ content: '', toolCalls: [{ id: 'toolu_nav', name: 'browser_navigate', args: { url: 'https://example.com' } }] });
  state.replies.push({ content: 'Opened.' });
  await agent.run('Open https://example.com/ for me');
  const r3 = native();
  check('3: the tools stay the same through an implied load', r3.every((r) => JSON.stringify(r.tools) === tools0));
  const lastReq = r3[r3.length - 1].messages;
  const browserRefs = lastReq.flatMap((m) => (m.role === 'user' ? m.content : [])).filter((b) => b.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c) => c.type === 'tool_reference' && c.tool_name === 'browser_navigate'));
  check('3: the agent\'s own load_tools call references the browser tools', browserRefs.length === 1, browserRefs.length);

  // ---- 4: a model that refuses deferred tools: the old way from then on ----
  reset();
  config = { ...config, providers: { claude: { ...config.providers.claude, model: 'claude-old-model' } } };
  agent.session = store.create();
  state.rejectDeferred = true;
  state.replies.push({ content: '', toolCalls: [{ id: 'toolu_l2', name: 'load_tools', args: { groups: ['browser'] } }] });
  state.replies.push({ content: 'Loaded.' });
  await agent.run('Load the browser');
  const r4 = state.requests.filter((r) => r.url.startsWith('/v1/messages')).map((r) => r.payload);
  check('4: refused once, then sent without deferred tools, and the run goes on', r4.length === 3 && JSON.stringify(r4[0].tools).includes('defer_loading') && !JSON.stringify(r4[1].tools).includes('defer_loading') && events.find((e) => e.type === 'run_end')?.reason === 'done', r4.length);
  check('4: the old way: no group tools before the load, the browser\'s after it, no references', !r4[1].tools.some((t) => t.name.startsWith('browser_')) && r4[2].tools.some((t) => t.name === 'browser_navigate') && !JSON.stringify(r4[2].messages).includes('tool_reference'));
  check('4: remembered for the model', A.deferRefused.has('claude-old-model') && !A.deferRefused.has('claude-haiku-5-5'));
  state.rejectDeferred = false;

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
