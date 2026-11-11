// A small stdio MCP server for tests. Env OC_PROJECT points at the project (for the SDK in its node_modules).
const path = require('node:path');
const sdk = (p) => require(path.join((process.env.OC_PROJECT || path.join(__dirname, '..', '..')), 'node_modules/@modelcontextprotocol/sdk/dist/cjs', p));
const { McpServer } = sdk('server/mcp.js');
const { StdioServerTransport } = sdk('server/stdio.js');
const { z } = require(path.join((process.env.OC_PROJECT || path.join(__dirname, '..', '..')), 'node_modules/zod'));
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const server = new McpServer({ name: 'oc-test-server', version: '1.2.3' }, process.env.OC_TEST_INSTRUCTIONS ? { instructions: process.env.OC_TEST_INSTRUCTIONS } : undefined);
server.registerTool('echo', { title: 'Echo text', description: 'Echoes text back', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
server.registerTool('add', { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() }, annotations: { title: 'Add numbers' } }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
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
if (process.env.OC_TEST_BENCH) {
  // Twelve more tools, worded like a real tracker server's, so the usual eight become twenty (the token measurement in
  // docs/token-bench.md). Made-up data only.
  const text = (t) => async () => ({ content: [{ type: 'text', text: t }] });
  const ro = { readOnlyHint: true };
  const state = z.enum(['open', 'closed', 'all']).describe('Filter by state');
  server.registerTool('list_issues', { description: 'List issues in a project, newest first. Use filters to narrow the result; results are paginated.', inputSchema: { project: z.string().describe('Project key, e.g. "WEB"'), state: state.optional(), assignee: z.string().optional().describe('Username of the assignee'), labels: z.array(z.string()).optional().describe('Only issues with all of these labels'), page: z.number().optional().describe('Page number, from 1'), per_page: z.number().optional().describe('Results per page, at most 100') }, annotations: ro }, text('[]'));
  server.registerTool('get_issue', { description: 'Get one issue with its description, labels, assignees and the latest comments.', inputSchema: { project: z.string().describe('Project key'), number: z.number().describe('Issue number') }, annotations: ro }, text('{}'));
  server.registerTool('create_issue', { description: 'Create an issue in a project. Returns the new issue with its number and URL.', inputSchema: { project: z.string().describe('Project key'), title: z.string().describe('Short summary'), body: z.string().optional().describe('Description in Markdown'), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional().describe('Usernames to assign') } }, text('{}'));
  server.registerTool('update_issue', { description: 'Change an issue: its title, description, state, labels or assignees. Fields left out stay as they are.', inputSchema: { project: z.string(), number: z.number(), title: z.string().optional(), body: z.string().optional(), state: z.enum(['open', 'closed']).optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional() } }, text('{}'));
  server.registerTool('add_comment', { description: 'Add a comment to an issue or a pull request.', inputSchema: { project: z.string(), number: z.number().describe('Issue or pull request number'), body: z.string().describe('Comment text in Markdown') } }, text('{}'));
  server.registerTool('list_projects', { description: 'List the projects the signed-in user can see, with their keys and names.', inputSchema: { query: z.string().optional().describe('Filter by name'), page: z.number().optional() }, annotations: ro }, text('[]'));
  server.registerTool('search_code', { description: 'Search code across the repositories of a project. Supports exact phrases in quotes and path: and lang: filters.', inputSchema: { query: z.string().describe('Search query'), project: z.string().optional(), page: z.number().optional(), per_page: z.number().optional() }, annotations: ro }, text('[]'));
  server.registerTool('get_file', { description: 'Get the contents of a file in a repository at a branch, tag or commit.', inputSchema: { repo: z.string().describe('owner/name'), path: z.string().describe('Path in the repository'), ref: z.string().optional().describe('Branch, tag or commit; the default branch if left out') }, annotations: ro }, text(''));
  server.registerTool('list_branches', { description: 'List the branches of a repository with their latest commit.', inputSchema: { repo: z.string().describe('owner/name'), page: z.number().optional() }, annotations: ro }, text('[]'));
  server.registerTool('get_pull_request', { description: 'Get a pull request with its description, status checks, reviews and changed files.', inputSchema: { repo: z.string(), number: z.number() }, annotations: ro }, text('{}'));
  server.registerTool('list_pull_requests', { description: 'List pull requests of a repository.', inputSchema: { repo: z.string(), state: state.optional(), author: z.string().optional(), base: z.string().optional().describe('Base branch'), page: z.number().optional() }, annotations: ro }, text('[]'));
  server.registerTool('get_user', { description: 'Get a user by username: display name, email visibility and team memberships.', inputSchema: { username: z.string() }, annotations: ro }, text('{}'));
}
if (process.env.OC_TEST_ODD) {
  // A tool whose name has "__" in it, for the interface's name checks
  server.registerTool('list__items', { description: 'Lists the items', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'a, b' }] }));
}
if (process.env.OC_TEST_CRASH_IF && require('node:fs').existsSync(process.env.OC_TEST_CRASH_IF)) { process.stderr.write('fatal: marker file present (test)\n'); process.exit(4); }
if (process.env.OC_TEST_CRASH) { process.stderr.write('fatal: refusing to start (test)\n'); process.exit(3); }
process.stderr.write('test server starting\n');
server.connect(new StdioServerTransport());
