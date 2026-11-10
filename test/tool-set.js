// Which tools a request offers: optional tool families and their prompt sections are dropped with AppConfig.toolSet
// 'essential' and kept with 'auto' and 'all', whatever the window (the families are tool groups now, loaded when
// needed: test/tool-groups.js). Run: node test/tool-set.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { essentialToolsOnly } = require(path.join(projectDir, 'dist/main/agent.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-toolset-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  let config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 16384, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: project, permissionMode: 'bypass', autoApprove: true, maxTurns: 6, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [], toolSet: 'auto',
  };
  const app = createApp({
    userData: tmp,
    appRoot: projectDir,
    loadConfig: () => config,
    saveConfig: (c) => (config = c),
    browser: () => ({ navigate: async () => 'ok' }),
    artifacts: new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }),
  });
  const tool = (name, extra = {}) => ({ name, description: `test tool ${name}`, parameters: { type: 'object', properties: {} }, run: async () => ({ content: 'ok' }), ...extra });
  app.tools.register(tool('always_there'));
  app.tools.register(tool('only_when_room', { optional: true }));
  app.prompt.add('always', () => 'SECTION-ALWAYS');
  app.prompt.add('roomy', () => 'SECTION-OPTIONAL', { optional: true });

  /** One run with this window and setting; returns the tool names and the system prompt the model was sent. */
  async function ask(contextWindow, toolSet) {
    app.updateConfig((c) => ({ ...c, toolSet, portkey: { ...c.portkey, contextWindow } }));
    const before = state.requests.length;
    state.replies.push({ content: 'ok' });
    const s = app.runtime.create({ foreground: false });
    app.runtime.send(s.id, 'hello');
    const until = Date.now() + 5000;
    while (app.runtime.isRunning(s.id) && Date.now() < until) await sleep(15);
    const req = state.requests.slice(before).find((r) => r.url === '/v1/chat/completions' && r.payload.stream);
    return { names: (req?.payload.tools ?? []).map((t) => t.function.name), system: String(req?.payload.messages?.[0]?.content ?? '') };
  }

  // Changed on purpose: the window no longer decides. Below 32k tokens 'auto' used to drop the optional families, since
  // every definition went with every request; as tool groups they cost nothing until a session loads them.
  check('the decision follows the setting alone', essentialToolsOnly({ ...config, toolSet: 'auto', portkey: { ...config.portkey, contextWindow: 16000 } }) === false && essentialToolsOnly({ ...config, toolSet: 'all', portkey: { ...config.portkey, contextWindow: 4096 } }) === false && essentialToolsOnly({ ...config, toolSet: 'essential' }) === true);
  check('a local model with a small num_ctx too', essentialToolsOnly({ ...config, provider: 'ollama', toolSet: 'auto' }) === false);

  const big = await ask(200000, 'auto');
  check('auto with a large window offers every tool', big.names.includes('always_there') && big.names.includes('only_when_room') && big.names.includes('read_file'), big.names);
  check('…and every prompt section, without the note', big.system.includes('SECTION-ALWAYS') && big.system.includes('SECTION-OPTIONAL') && !/turned off/.test(big.system));

  const small = await ask(16000, 'auto');
  // Changed on purpose (see above): a small window under 'auto' keeps them
  check('auto with a small window keeps the optional tools and their sections', small.names.includes('only_when_room') && small.system.includes('SECTION-OPTIONAL') && !/turned off/.test(small.system), small.names);

  const forced = await ask(16000, 'all');
  check('"all" keeps them on a small window', forced.names.includes('only_when_room') && forced.system.includes('SECTION-OPTIONAL') && !/turned off/.test(forced.system), forced.names);

  const trimmed = await ask(200000, 'essential');
  check('"essential" drops them on a large window', !trimmed.names.includes('only_when_room') && trimmed.names.includes('always_there') && !trimmed.system.includes('SECTION-OPTIONAL'), trimmed.names);
  check('…and says what is off', /turned off/.test(trimmed.system) && /Settings/.test(trimmed.system) && trimmed.names.includes('read_file') && trimmed.names.includes('bash'));

  await app.runQuit?.();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
