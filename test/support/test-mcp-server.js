// A small stdio MCP server for tests. Env OC_PROJECT points at the project (for the SDK in its node_modules).
const path = require('node:path');
const sdk = (p) => require(path.join((process.env.OC_PROJECT || path.join(__dirname, '..', '..')), 'node_modules/@modelcontextprotocol/sdk/dist/cjs', p));
const { McpServer } = sdk('server/mcp.js');
const { StdioServerTransport } = sdk('server/stdio.js');
const { z } = require(path.join((process.env.OC_PROJECT || path.join(__dirname, '..', '..')), 'node_modules/zod'));
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const server = new McpServer({ name: 'oc-test-server', version: '1.2.3' }, process.env.OC_TEST_INSTRUCTIONS ? { instructions: process.env.OC_TEST_INSTRUCTIONS } : undefined);
server.registerTool('echo', { description: 'Echoes text back', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
server.registerTool('add', { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
server.registerTool('remove_item', { description: 'Removes an item from the list (irreversible)', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } }, async ({ id }) => ({ content: [{ type: 'text', text: `removed ${id}` }] }));
server.registerTool('picture', { description: 'Returns a PNG', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }, { type: 'text', text: 'a 1x1 png' }] }));
server.registerTool('fail', { description: 'Always fails', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }));
server.registerTool('slow', { description: 'Takes a while', inputSchema: { ms: z.number() }, annotations: { readOnlyHint: true } }, async ({ ms }) => { await new Promise((r) => setTimeout(r, ms)); return { content: [{ type: 'text', text: 'slept' }] }; });
server.registerTool('env', { description: 'Reports an env var', inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } }, async ({ name }) => ({ content: [{ type: 'text', text: process.env[name] ?? '(unset)' }] }));
server.registerTool('cwd', { description: 'Reports the working directory', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: process.cwd() }] }));
if (process.env.OC_TEST_EXTRA) {
  // Tools for the robustness checks (off by default so the usual eight stay the usual eight).
  server.registerTool('progress', { description: 'Reports progress while it works', inputSchema: { ms: z.number(), every: z.number() }, annotations: { readOnlyHint: true } }, async ({ ms, every }, extra) => {
    const token = extra._meta?.progressToken;
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, every));
      if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++i } });
    }
    return { content: [{ type: 'text', text: `done after ${i} updates` }] };
  });
  server.registerTool('big', { description: 'Returns a long text', inputSchema: { chars: z.number() }, annotations: { readOnlyHint: true } }, async ({ chars }) => {
    let text = 'BEGIN-';
    for (let i = 0; text.length < chars - 4; i++) text += `line ${i}\n`;
    return { content: [{ type: 'text', text: text.slice(0, chars - 4) + '-END' }] };
  });
  server.registerTool('exit', { description: 'Exits the server', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
    setTimeout(() => process.exit(0), 10);
    return { content: [{ type: 'text', text: 'bye' }] };
  });
  server.registerTool('pid', { description: 'Reports the process id', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: String(process.pid) }] }));
}
if (process.env.OC_TEST_CRASH_IF && require('node:fs').existsSync(process.env.OC_TEST_CRASH_IF)) { process.stderr.write('fatal: marker file present (test)\n'); process.exit(4); }
if (process.env.OC_TEST_CRASH) { process.stderr.write('fatal: refusing to start (test)\n'); process.exit(3); }
process.stderr.write('test server starting\n');
server.connect(new StdioServerTransport());
