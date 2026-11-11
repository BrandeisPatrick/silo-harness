// A check against one real, public remote MCP server, through the app's own path: hidden window, throwaway profile,
// mock model, no API key. It adds the server by URL (as Settings → MCP servers → Add server does), waits for it to
// connect, lists its tools, and has the scripted mock model call one read-only tool by name (which loads the server's
// tools); a card, if the call asks, is approved here. It prints the transport, the tool count, the tool called, the
// first 200 characters of its result and the time each step took. It needs the network, so it is not in the live suite.
//   npm run build
//   node scripts/mcp-real-check.js [--url=https://mcp.deepwiki.com/mcp] [--tool=<name> --args='<json>']
// The question it sends is about a public repository (modelcontextprotocol/servers), never anything from this Mac.
// What the server returns is printed as data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, sleep } = require('../test/live/rig.js');

const ROOT = path.join(__dirname, '..');
const opt = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const URL_ARG = opt('url') || 'https://mcp.deepwiki.com/mcp';
const REPO = 'modelcontextprotocol/servers';
// Read-only tools of the servers this was tried with, and what to ask them (all about the public repository)
const KNOWN = {
  read_wiki_structure: { repoName: REPO },
  microsoft_docs_search: { query: `GitHub repository ${REPO} Model Context Protocol servers` },
};

const host = new URL(URL_ARG).hostname;
const NAME = (host.split('.').find((p) => !['mcp', 'www', 'api'].includes(p)) || 'remote').replace(/[^\w.-]/g, '_');
const clipped = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

(async () => {
  const times = {};
  let t = Date.now();
  const lap = (k) => {
    times[k] = Date.now() - t;
    t = Date.now();
  };
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mcp-real-'));
  const app = await launch({ root: ROOT, mock: true, project });
  let code = 0;
  try {
    await app.waitFor(`Boolean(window.__oc_debug)`, 30_000, 'the app');
    lap('launch');
    await app.evaluate(`oc.mcp.add(${JSON.stringify(NAME)}, ${JSON.stringify(URL_ARG)}, 'user')`);
    const settled = `oc.mcp.list().then((l) => { const s = l.find((x) => x.name === ${JSON.stringify(NAME)}); return Boolean(s && !['connecting', 'reconnecting'].includes(s.status)); })`;
    await app.waitFor(settled, 60_000, 'the server to connect or fail');
    const info = await app.evaluate(`oc.mcp.list().then((l) => l.find((x) => x.name === ${JSON.stringify(NAME)}))`);
    lap('connect');
    console.log(`url: ${URL_ARG}`);
    console.log(`transport: ${info.transport}`);
    console.log(`status: ${info.status}${info.error ? ` (${clipped(String(info.error).replace(/\s+/g, ' '), 200)})` : ''}`);
    if (info.status !== 'connected') {
      code = 2;
      return;
    }
    const tools = info.tools ?? [];
    lap('list');
    console.log(`tools: ${tools.length} (${tools.map((x) => `${x.name}${x.readOnly ? ' [read-only]' : ''}`).join(', ')})`);
    const wanted = opt('tool');
    const tool = wanted ? tools.find((x) => x.name === wanted) : tools.find((x) => KNOWN[x.name]);
    if (!tool) {
      console.log('no known read-only tool to call; pass --tool= and --args=');
      code = 3;
      return;
    }
    const args = opt('args') ? JSON.parse(opt('args')) : KNOWN[tool.name];
    const callId = 'call_real_1';
    const last = (p) => p.messages?.[p.messages.length - 1];
    app.mock.state.replies.push({ content: '', toolCalls: [{ id: callId, name: tool.fullName, args }], when: (p) => last(p)?.role === 'user' && JSON.stringify(last(p).content).includes('MCP-REAL') });
    app.mock.state.replies.push({ content: 'Done.', when: (p) => last(p)?.role === 'tool' && last(p).tool_call_id === callId });
    await app.send(`MCP-REAL: what is in the public repository ${REPO}?`);
    // Approve the call's card if it asks (a tool the server did not mark read-only asks in ask mode)
    let card = false;
    const until = Date.now() + 120_000;
    let result = null;
    while (Date.now() < until && result === null) {
      if (!card && (await app.evaluate(`Boolean(document.querySelector('.approval.mcp'))`))) {
        card = true;
        await app.evaluate(`[...document.querySelectorAll('.approval.mcp button')].find((b) => (b.getAttribute('aria-label') || b.innerText).trim() === 'Allow once').click()`);
      }
      const req = app.mock.state.requests.find((r) => r.payload?.messages?.some((m) => m.role === 'tool' && m.tool_call_id === callId));
      if (req) result = String(req.payload.messages.find((m) => m.role === 'tool' && m.tool_call_id === callId).content);
      else await sleep(250);
    }
    lap('call');
    await app.waitIdle(30_000).catch(() => undefined);
    console.log(`tool called: ${tool.name} as ${tool.fullName} ${JSON.stringify(args)} (approval card: ${card ? 'shown, allowed once' : 'none, the tool is read-only'})`);
    console.log(`result (first 200 characters, the server's data): ${result === null ? '(none within 120 s)' : JSON.stringify(result.slice(0, 200))}`);
    if (result === null) code = 4;
  } catch (err) {
    console.log(`error: ${err.message}`);
    code = 1;
  } finally {
    await app.close();
    console.log(`times (ms): ${Object.entries(times).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    process.exit(code);
  }
})();
