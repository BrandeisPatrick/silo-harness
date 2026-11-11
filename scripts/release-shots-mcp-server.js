// A small stdio MCP server for the 0.17.0 release images (scripts/release-shots-0.17.0.js): it plays one made-up
// server, named by SHOTS_MCP_SERVER or else by its own file name (the script copies it into the made-up home as
// tracker.js, docs.js, …). Newline-delimited JSON-RPC with no dependency, so a copy runs from anywhere; the tools
// answer with made-up data. Like test/support/test-mcp-server.js, but with the tools, titles and read-only /
// destructive annotations a real issue tracker or docs server announces. The tracker's tools carry no description:
// with a line of description each, its six tools are taller than the opened list's 320 px and the list scrolls.
const path = require('node:path');

const ro = { readOnlyHint: true };
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

const SERVERS = {
  tracker: {
    version: '2.4.1',
    tools: [
      { name: 'search_issues', title: 'Search issues', inputSchema: obj({ query: str('Words to look for'), state: str('open, closed or all') }, ['query']), annotations: ro },
      { name: 'get_issue', title: 'Get issue', inputSchema: obj({ id: str('Issue key, e.g. API-142') }, ['id']), annotations: ro },
      { name: 'list_projects', title: 'List projects', inputSchema: obj({}), annotations: ro },
      { name: 'create_issue', title: 'Create issue', inputSchema: obj({ project: str('Project key'), title: str('Short summary'), body: str('Description') }, ['project', 'title']), annotations: { readOnlyHint: false, destructiveHint: false } },
      { name: 'add_comment', title: 'Add comment', inputSchema: obj({ id: str('Issue key'), body: str('Comment text') }, ['id', 'body']), annotations: { readOnlyHint: false, destructiveHint: false } },
      { name: 'close_issue', title: 'Close issue', inputSchema: obj({ id: str('Issue key'), reason: str('done or wont_do') }, ['id']), annotations: { readOnlyHint: false, destructiveHint: true } },
    ],
  },
  docs: {
    version: '1.2.0',
    tools: [
      { name: 'search_docs', title: 'Search docs', description: 'Search the project’s documentation.', inputSchema: obj({ query: str('Words to look for') }, ['query']), annotations: ro },
      { name: 'read_page', title: 'Read page', description: 'One page as Markdown.', inputSchema: obj({ path: str('Page path, e.g. guides/rate-limits') }, ['path']), annotations: ro },
      { name: 'list_pages', title: 'List pages', description: 'The pages under a folder.', inputSchema: obj({ folder: str('Folder, default the top') }), annotations: ro },
    ],
  },
  postgres: {
    version: '0.9.3',
    tools: [
      { name: 'query', title: 'Run query', description: 'Run a read-only SQL query.', inputSchema: obj({ sql: str('One SELECT statement'), limit: num('At most this many rows') }, ['sql']), annotations: ro },
      { name: 'list_tables', title: 'List tables', description: 'The tables and their columns.', inputSchema: obj({}), annotations: ro },
    ],
  },
};

const role = process.env.SHOTS_MCP_SERVER || path.basename(process.argv[1] || '', '.js');
const me = SERVERS[role];
if (!me) {
  process.stderr.write(`unknown server "${role}"\n`);
  process.exit(2);
}

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: role, version: me.version } } });
    else if (m.method === 'tools/list') send({ id: m.id, result: { tools: me.tools } });
    else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: `${m.params?.name}: done (made-up data)` }] } });
    else if (m.method === 'ping') send({ id: m.id, result: {} });
    else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
// The app closes stdin when it stops the server: go with it
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`${role} server ready\n`);
