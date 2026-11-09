// A stand-in for the App container (src/main/app.ts) for headless suites: a real SessionStore in a temp folder,
// a config with updateConfig/onConfig, an event emitter, a runtime that records every call, and push/rpc recorders.
// Only what the remote feature uses is filled in; the rest throws so a suite notices when it reaches further.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fakeApp(projectDir, opts = {}) {
  const { SessionStore, toMeta } = require(path.join(projectDir, 'dist/main/sessions.js'));
  const userData = opts.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-remote-'));
  const store = new SessionStore(path.join(userData, 'sessions'));
  let config = {
    provider: 'portkey',
    ollama: { baseURL: 'http://localhost:11434/v1', model: 'qwen3:8b', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: 'https://gateway.example.com/v1', apiKey: 'pk-SECRET-KEY', model: '@anthropic/claude-sonnet-5', virtualKey: 'vk-SECRET', provider: '', providerApiKey: 'sk-SECRET-UPSTREAM', configId: '', contextWindow: 200000 },
    workingDirectory: '/Users/someone/project',
    permissionMode: 'ask',
    autoApprove: false,
    maxTurns: 40,
    allowRules: { '/Users/someone/project': { programs: ['git'] } },
    remote: { enabled: false, bind: 'localhost', port: 0, ...(opts.remote || {}) },
  };
  const configSubs = new Set();
  const eventSubs = new Set();
  const handlers = {};
  const services = {};
  const quit = [];
  const pushes = [];
  const calls = [];
  const status = new Map(); // id -> SessionStatus
  const live = new Map(); // id -> LiveState
  let foreground = null;

  const emptyLive = () => ({ running: false, text: '', thinking: '', tools: [], approvals: [], queue: [] });
  const runtime = {
    foregroundId: () => foreground,
    setForeground: (id) => ((foreground = id), store.get(id)),
    create: (o = {}) => {
      calls.push(['create', o]);
      const s = store.create();
      if (o.foreground !== false) foreground = s.id;
      return s;
    },
    send: (id, text, attachments, o) => {
      calls.push(['send', id, text, attachments, o]);
      return opts.onSend ? opts.onSend(id, text, attachments, o) : { ok: true };
    },
    stop: (id) => {
      calls.push(['stop', id]);
      if (opts.onStop) opts.onStop(id);
    },
    isRunning: (id) => !!status.get(id)?.running,
    running: () => [...status].filter(([, s]) => s.running).map(([id]) => id),
    status: (id) => status.get(id) || { running: false },
    live: (id) => live.get(id) || emptyLive(),
    list: () => store.list().map((m) => ({ ...m, status: status.get(m.id) || { running: false } })),
    respondApproval: (id, ok, always, scope) => {
      calls.push(['respondApproval', id, ok, always, scope]);
      return opts.onApproval ? opts.onApproval(id, ok, always, scope) : id !== 'gone';
    },
    allowBlocked: (sessionId, id) => {
      calls.push(['allowBlocked', sessionId, id]);
      return id === 'gone' ? { ok: false, error: 'This block is from before the app started; ask the agent to try again.' } : { ok: true };
    },
    respondQuestion: (id, answers) => {
      calls.push(['respondQuestion', id, answers]);
      return id !== 'gone';
    },
    respondPlan: (sessionId, planId, decision) => {
      calls.push(['respondPlan', sessionId, planId, decision]);
      if (opts.onPlan) opts.onPlan(sessionId, planId, decision);
    },
    agentFor: () => {
      throw new Error('fake: agentFor');
    },
  };

  const app = {
    userData,
    appRoot: projectDir,
    config: () => config,
    updateConfig(change) {
      const prev = config;
      config = typeof change === 'function' ? change(config) : { ...config, ...change };
      for (const cb of configSubs) cb(config, prev);
      return config;
    },
    onConfig(cb) {
      configSubs.add(cb);
      return () => configSubs.delete(cb);
    },
    window: () => null,
    push: (channel, payload) => pushes.push([channel, payload]),
    rpc: {
      handle(method, fn) {
        handlers[method] = fn;
        return () => delete handlers[method];
      },
    },
    store,
    runtime,
    events: {
      on(cb) {
        eventSubs.add(cb);
        return () => eventSubs.delete(cb);
      },
    },
    tools: { register: () => () => {}, list: () => [] },
    prompt: { add: () => () => {} },
    commands: { register: () => () => {}, list: () => [] },
    provide(name, service) {
      services[name] = service;
      return () => delete services[name];
    },
    service: (name) => services[name],
    onQuit: (fn) => quit.unshift(fn),
  };

  return {
    app,
    handlers,
    services,
    pushes,
    calls,
    status,
    live,
    toMeta,
    emit: (sessionId, ev) => {
      for (const cb of eventSubs) cb(sessionId, ev);
    },
    setForeground: (id) => (foreground = id),
    quit: async () => {
      for (const fn of quit) await fn();
    },
  };
}

module.exports = { fakeApp };
