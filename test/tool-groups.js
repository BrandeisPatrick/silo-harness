// Tool groups loaded when needed (src/main/tools/groups.ts): the browser, terminal, sessions, schedules and mods tools
// are not offered until the session loads their group, with load_tools or by calling one of its tools by name; a
// loaded group stays with the session (saved, forked, through compaction). What the user sees does not change: no
// row for load_tools. Dreams, plan mode, AppConfig.toolSet, hooks and the context meter keep working.
// Run: node test/tool-groups.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { createApp } = dist('app.js');
const { setupSubagents } = dist('subagents.js');
const { setupSchedules } = dist('schedules.js');
const { Agent } = dist('agent.js');
const { SessionStore, toTranscript } = dist('sessions.js');
const { ArtifactStore } = dist('artifacts.js');
const { HookEngine } = dist('hooks/engine.js');
const { toolCalls: checkedCalls } = dist('agent/classifier.js');
const { sessionMarkdown } = dist('history/export.js');
const { groupsForMessage, requestedGroups } = dist('tools/groups.js');
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const GROUP_TOOLS = /^(browser_|terminal_|session_|schedule_|mod_check$)/;

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-tool-groups-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'notes.txt'), 'hello');
  let config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: project, permissionMode: 'bypass', autoApprove: true, maxTurns: 10, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [], toolSet: 'auto',
  };
  const app = createApp({
    userData: tmp,
    appRoot: projectDir,
    loadConfig: () => config,
    saveConfig: (c) => (config = c),
    browser: () => null,
    artifacts: new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }),
  });
  // The features that register grouped tools and their prompt sections, as index.ts sets them up
  setupSubagents(app);
  setupSchedules(app);
  // A mod-like registration: mod_check in the mods group with its section, and a tool of no group (always offered)
  app.tools.register({ name: 'mod_check', description: 'Check a mod', parameters: { type: 'object', properties: {} }, readOnly: true, optional: true, group: 'mods', run: async () => ({ content: 'mods ok' }) });
  app.prompt.add('mods', () => 'MODS-SECTION', { optional: true, group: 'mods' });
  app.tools.register({ name: 'always_there', description: 'A registered tool of no group', parameters: { type: 'object', properties: {} }, run: async () => ({ content: 'ok' }) });

  // PreToolUse hooks write what they are given to a file: they should see real tool names, never load_tools
  const hookLog = path.join(tmp, 'pre-tool-use.jsonl');
  const hooks = new HookEngine({ settings: () => ({ sets: [{ groups: [{ event: 'PreToolUse', matcher: '', handlers: [{ type: 'command', command: `cat >> '${hookLog}'; echo >> '${hookLog}'` }] }], source: 'user', label: 'settings.json' }], disabled: false }) });

  // The app's own store (the session tools and the session-name section look sessions up there)
  const sessionsDir = path.join(tmp, 'sessions');
  let store = app.store;
  let events = [];
  const agentFor = (session, extra = {}) =>
    new Agent(() => config, { navigate: async (u) => `Now at ${u}` }, store, () => [], (ev) => events.push(ev), undefined, undefined, undefined, {
      session,
      app,
      tools: () => app.tools.list(),
      prompt: (info) => app.promptFor(info),
      hooks,
      ...extra,
    });
  const reset = () => {
    events = [];
    state.requests.length = 0;
    state.replies.length = 0;
  };
  const streams = () => state.requests.filter((r) => r.url === '/v1/chat/completions' && r.payload.stream);
  const names = (req) => (req?.payload.tools ?? []).map((t) => t.function.name);
  const system = (req) => String(req?.payload.messages?.[0]?.content ?? '');
  const loadEnum = (req) => req?.payload.tools?.find((t) => t.function.name === 'load_tools')?.function.parameters.properties.groups.items.enum ?? null;
  let n = 0;
  const call = (name, args) => ({ id: `g${++n}`, name, args });

  // ---- The helpers ----
  check('a message that asks to open a web address loads the browser', groupsForMessage('Open https://example.com and tell me the title').join() === 'browser' && groupsForMessage('visit localhost:3000 please').join() === 'browser');
  check('…as does one that names an address with the browser', groupsForMessage('What does http://127.0.0.1:8080/ show in the browser?').join() === 'browser');
  check('…but not an address the task only mentions', groupsForMessage('Clone https://github.com/a/b and run its tests').length === 0 && groupsForMessage('Open a PR at https://github.com/a/b').length === 0 && groupsForMessage('Open the browser settings file').length === 0);
  check('load_tools arguments are read leniently', requestedGroups({ groups: ['Browser', 'terminal', 'browser'] }).join() === 'browser,terminal' && requestedGroups({ groups: 'sessions, schedules' }).join() === 'sessions,schedules' && requestedGroups({ group: 'mods' }).join() === 'mods' && requestedGroups(['terminal']).join() === 'terminal' && requestedGroups({}).length === 0);

  // ---- A: a fresh session offers the core tools and load_tools, and names the groups ----
  reset();
  const a = agentFor(store.create({ cwd: project }));
  state.replies.push({ content: 'hi' });
  await a.run('hello');
  let req = streams()[0];
  check('A: no tool of a group is offered', !names(req).some((t) => GROUP_TOOLS.test(t)), names(req));
  check('A: the core tools, a registered tool of no group and load_tools are', ['read_file', 'write_file', 'edit_file', 'bash', 'skill', 'create_artifact', 'update_tasks', 'ask_user', 'always_there', 'load_tools'].every((t) => names(req).includes(t)), names(req));
  check('A: load_tools comes after the built-in tools and takes the groups not loaded', names(req).indexOf('load_tools') === names(req).indexOf('ask_user') + 1 && loadEnum(req).join() === 'browser,terminal,sessions,schedules,mods', loadEnum(req));
  check('A: the prompt names each group in one line', /More tools come in groups\. When the task needs one, call load_tools with its name/.test(system(req)) && /^- browser: open and use web pages in the Browser pane$/m.test(system(req)) && /^- mods: /m.test(system(req)), system(req).slice(0, 900));
  check('A: …and leaves out what belongs to a group (browser rules, terminal_run, sub-sessions, schedules, mods, the session name)', !/browser_click|terminal_run|## Sub-sessions|## Schedules|MODS-SECTION|This session is named/.test(system(req)));
  check('A: nothing is loaded yet', !a.session.toolGroups);

  // ---- B: load_tools adds a group for the next request, quietly ----
  reset();
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['terminal'] })] });
  state.replies.push({ toolCalls: [call('terminal_list', {})] });
  state.replies.push({ content: 'no tabs' });
  await a.run('List the terminal tabs');
  let [r1, r2, r3] = streams();
  check('B: the request before the load does not offer the terminal', !names(r1).includes('terminal_list'));
  check('B: the next request does, with the prompt line for it, and the group is off the list', names(r2).includes('terminal_run') && names(r2).includes('terminal_list') && /use terminal_run for what should keep running/.test(system(r2)) && !/^- terminal:/m.test(system(r2)) && loadEnum(r2).join() === 'browser,sessions,schedules,mods', loadEnum(r2));
  const loadResult = r2.payload.messages.find((m) => m.role === 'tool');
  check('B: load_tools answers with the group and its tools', /^Loaded terminal \(terminal_run, terminal_read, terminal_list, terminal_stop\)\.$/.test(loadResult?.content ?? ''), loadResult?.content);
  check('B: the terminal tool then ran as usual', events.some((e) => e.type === 'tool_end' && e.name === 'terminal_list' && e.ok) && names(r3).includes('terminal_list'));
  check('B: no tool row, no approval for load_tools', !events.some((e) => (e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'approval_request') && e.name === 'load_tools'));
  check('B: the session keeps the group', JSON.stringify(a.session.toolGroups) === '["terminal"]');
  let items = toTranscript(a.session);
  check('B: the transcript has no load_tools row, the terminal_list row is there', !items.some((i) => i.role === 'tool' && i.name === 'load_tools') && items.some((i) => i.role === 'tool' && i.name === 'terminal_list'), items.map((i) => i.name || i.role));
  check('B: the export leaves it out too', !/load_tools/.test(sessionMarkdown(a.session)) && /terminal_list/.test(sessionMarkdown(a.session)));
  check("B: Auto mode's check is not told about it", !checkedCalls(a.session).some((c) => c.startsWith('load_tools')) && checkedCalls(a.session).some((c) => c.startsWith('terminal_list')));

  // ---- C: a tool called by name before its group was loaded: the group loads and the call runs ----
  reset();
  fs.rmSync(hookLog, { force: true });
  state.replies.push({ toolCalls: [call('session_list', {}), call('mod_check', {})] });
  state.replies.push({ content: 'done' });
  await a.run('Which sessions are there?');
  [r1, r2] = streams();
  const ends = events.filter((e) => e.type === 'tool_end');
  check('C: both calls ran (no "unknown tool")', ends.length === 2 && ends.every((e) => e.ok) && ends[1].result === 'mods ok', ends.map((e) => e.result.slice(0, 60)));
  check('C: both groups are loaded and offered from the next request, with their sections', JSON.stringify(a.session.toolGroups) === '["terminal","sessions","mods"]' && names(r2).includes('session_spawn') && names(r2).includes('mod_check') && /## Sub-sessions/.test(system(r2)) && /MODS-SECTION/.test(system(r2)) && /This session is named/.test(system(r2)), a.session.toolGroups);
  const hookInputs = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
  check('C: PreToolUse hooks saw the real tool names', hookInputs.map((h) => h.silo_tool_name).join() === 'session_list,mod_check' && hookInputs.every((h) => h.hook_event_name === 'PreToolUse'), hookInputs.map((h) => h.silo_tool_name));
  // load_tools never reaches a hook
  reset();
  fs.rmSync(hookLog, { force: true });
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['schedules', 'nonsense', 'terminal'] })] });
  state.replies.push({ content: 'ok' });
  await a.run('Load the schedules');
  const partial = streams()[1].payload.messages.filter((m) => m.role === 'tool').pop()?.content ?? '';
  check('C: load_tools fires no hook', !fs.existsSync(hookLog) || !/load_tools/.test(fs.readFileSync(hookLog, 'utf8')));
  check('C: a mix of new, loaded and unknown names: each said', /^Loaded schedules \(schedule_create, schedule_list, schedule_update, schedule_delete\)\. Already loaded: terminal\. Not a tool group here: nonsense\. The groups are browser, terminal, sessions, schedules, mods\.$/.test(partial), partial);
  check('C: one group left: load_tools offers only the browser', loadEnum(streams()[1]).join() === 'browser');

  // ---- D: saved, reloaded, forked and compacted, the groups stay ----
  store.save(a.session);
  const id = a.session.id;
  store = new SessionStore(sessionsDir);
  const reloaded = store.get(id);
  check('D: the session file keeps the loaded groups', JSON.stringify(reloaded.toolGroups) === '["terminal","sessions","schedules","mods"]', reloaded.toolGroups);
  const forked = store.fork(id);
  check('D: a fork copies them', JSON.stringify(forked.toolGroups) === JSON.stringify(reloaded.toolGroups) && forked.toolGroups !== reloaded.toolGroups);
  reset();
  const d = agentFor(reloaded);
  state.replies.push({ content: 'still here' });
  await d.run('Are the tools still there?');
  check('D: a reopened session is offered them from its first request', names(streams()[0]).includes('terminal_run') && names(streams()[0]).includes('schedule_create') && !names(streams()[0]).includes('browser_navigate'));
  reset();
  state.summary = '## 1. Request and intent\nTools.\n\n## 6. Pending work\nNone.';
  const compacted = await d.compactNow();
  check('D: the session compacted', compacted.ok && (reloaded.compactions ?? []).length === 1, compacted);
  reset();
  state.replies.push({ content: 'after compaction' });
  await d.run('And now?');
  check('D: …and still offers the groups after it', JSON.stringify(reloaded.toolGroups) === '["terminal","sessions","schedules","mods"]' && names(streams()[0]).includes('terminal_run') && names(streams()[0]).includes('session_spawn'));

  // ---- E: a message that asks to open a page loads the browser before the first request ----
  reset();
  const e = agentFor(store.create({ cwd: project }));
  state.replies.push({ content: 'ok' });
  await e.run('Open https://example.com and tell me its title.');
  req = streams()[0];
  check('E: the first request already offers the browser, with its rules', names(req).includes('browser_navigate') && names(req).includes('browser_click') && /- Browser: act by visible text/.test(system(req)) && JSON.stringify(e.session.toolGroups) === '["browser"]', names(req).filter((t) => t.startsWith('browser_')).length);

  // ---- F: the context meter counts the tools offered (two sessions that have not run: estimates on both) ----
  const toolsSlice = (groups) => {
    const s = store.create({ cwd: project });
    if (groups) s.toolGroups = groups;
    return agentFor(s).contextBreakdown().slices.find((x) => x.key === 'tools').tokens;
  };
  const before = toolsSlice();
  const after = toolsSlice(['browser', 'terminal', 'sessions', 'schedules', 'mods']);
  check('F: "Tool definitions" is the offered tools: smaller before the groups are loaded', before > 1000 && after > before + 2500, { before, after });

  // ---- G: a session with a tool set of its own (a dream) is unchanged ----
  reset();
  const dream = store.create({ cwd: project });
  dream.tools = ['read_file', 'grep', 'terminal_list'];
  const g = agentFor(dream);
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['browser'] })] });
  state.replies.push({ content: 'ok' });
  await g.run('dream');
  req = streams()[0];
  check('G: exactly its own tools, no load_tools, no group lines', names(req).join() === 'read_file,grep,terminal_list' && /only these tools: read_file, grep, terminal_list/.test(system(req)) && !/More tools come in groups/.test(system(req)), names(req));
  const refused = events.find((ev) => ev.type === 'tool_end' && ev.name === 'load_tools');
  check('G: load_tools is an unknown tool there, and nothing loads', refused && /unknown tool "load_tools"/.test(refused.result) && !dream.toolGroups, refused && refused.result);

  // ---- H: plan mode keeps its read-only filter, group by group ----
  reset();
  config = { ...config, permissionMode: 'plan' };
  const h = agentFor(store.create({ cwd: project }));
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['browser', 'sessions'] })] });
  state.replies.push({ content: 'planned' });
  await h.run('Plan something');
  [r1, r2] = streams();
  check('H: plan mode: submit_plan and load_tools, no file changes, no group tools yet', names(r1).includes('submit_plan') && names(r1).includes('load_tools') && !names(r1).includes('write_file') && !names(r1).some((t) => GROUP_TOOLS.test(t)), names(r1));
  check('H: loaded in plan mode, the browser and sessions groups bring only their read-only tools', names(r2).includes('browser_get_text') && !names(r2).includes('browser_click') && !names(r2).includes('browser_type') && names(r2).includes('session_list') && !names(r2).includes('session_spawn') && !names(r2).includes('session_send'), names(r2));
  config = { ...config, permissionMode: 'bypass' };

  // ---- I: AppConfig.toolSet ----
  reset();
  config = { ...config, toolSet: 'all' };
  const i = agentFor(store.create({ cwd: project }));
  state.replies.push({ content: 'ok' });
  await i.run('hello');
  req = streams()[0];
  check('I: "all": every group from the first request, no load_tools, the prompt as before', ['browser_navigate', 'terminal_run', 'session_spawn', 'schedule_create', 'mod_check'].every((t) => names(req).includes(t)) && !names(req).includes('load_tools') && !/More tools come in groups/.test(system(req)) && /- Browser: act by visible text/.test(system(req)) && /## Sub-sessions/.test(system(req)) && /MODS-SECTION/.test(system(req)));
  reset();
  config = { ...config, toolSet: 'essential' };
  const j = agentFor(store.create({ cwd: project }));
  state.replies.push({ toolCalls: [call('load_tools', { groups: ['sessions'] })] });
  state.replies.push({ content: 'ok' });
  await j.run('Start a sub-session');
  [r1, r2] = streams();
  check('I: "essential": the browser and terminal can be loaded, the optional groups cannot', loadEnum(r1).join() === 'browser,terminal' && /turned off/.test(system(r1)), loadEnum(r1));
  const off = r2.payload.messages.filter((m) => m.role === 'tool').pop()?.content ?? '';
  check('I: …loading one of those is an error and loads nothing', /^Error: not a tool group here: sessions\. The groups are browser, terminal\.$/.test(off) && !j.session.toolGroups && !names(r2).includes('session_spawn'), off);
  reset();
  config = { ...config, toolSet: 'auto', portkey: { ...config.portkey, contextWindow: 16000 } };
  const k = agentFor(store.create({ cwd: project }));
  state.replies.push({ content: 'ok' });
  await k.run('hello');
  check('I: "auto" on a small window can load every group (none costs anything until loaded)', loadEnum(streams()[0]).join() === 'browser,terminal,sessions,schedules,mods' && !/turned off/.test(system(streams()[0])), loadEnum(streams()[0]));
  config = { ...config, portkey: { ...config.portkey, contextWindow: 200000 } };

  await app.runQuit?.();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
