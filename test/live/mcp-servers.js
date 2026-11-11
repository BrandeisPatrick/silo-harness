// Live check of MCP servers in the real window. (A) A real stdio server named "acme.docs" (sanitised to acme_docs in
// the model-facing names) with a tool named list__items. Its tools load when needed: the first request has none, the
// scripted mock model loads the server with load_tools (no row for it) and then calls its tools: the approval card names
// the real server and tool with the tool's title beside them, lists flat arguments as keys and values, keeps its
// answers; the rows show titles with the real names inside; the folded line says "Used acme.docs". (B) Settings →
// MCP servers from the debug stand-in: one action per row, the … menu above the Settings dialog, Trust's confirmation
// (focus not on Trust), Show log, the Add form behind its button (Config first, a suggested name, Headers for a URL,
// Escape closes it), a tool's switch, the /mcp card's links, and a failed call's "Sign in" line.
// Run: npm run build && node test/live/mcp-servers.js [root]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');
const TEST_SERVER = path.join(ROOT, 'test', 'support', 'test-mcp-server.js');
const { check, done } = checker();
const js = (v) => JSON.stringify(v);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const lastUserHas = (marker) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  if (!m || m.role !== 'user') return false;
  return (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes(marker);
};
const afterTool = (id) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  return m && m.role === 'tool' && m.tool_call_id === id;
};

async function realServer() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-mcp-'));
  const app = await launch({
    root: ROOT, mock: true, project, size: { width: 1440, height: 900 },
    config: { mcpServers: { 'acme.docs': { command: 'node', args: [TEST_SERVER], env: { OC_PROJECT: ROOT, OC_TEST_ODD: '1' } } } },
  });
  try {
    await app.waitFor(`Boolean(window.__oc_debug)`, 20_000, 'the app');
    await app.waitFor(`oc.mcp.list().then((l) => l.some((s) => s.name === 'acme.docs' && s.status === 'connected'))`, 30_000, 'acme.docs to connect');
    app.mock.state.requests.length = 0;
    app.mock.state.replies.push({ content: '', toolCalls: [{ id: 'call_load', name: 'load_tools', args: { groups: ['mcp:acme_docs'] } }], when: lastUserHas('MCP-LIVE-1') });
    app.mock.state.replies.push({ content: '', toolCalls: [{ id: 'call_add', name: 'mcp__acme_docs__add', args: { a: 2, b: 3 } }], when: afterTool('call_load') });
    app.mock.state.replies.push({ content: '', toolCalls: [{ id: 'call_list', name: 'mcp__acme_docs__list__items', args: {} }], when: afterTool('call_add') });
    app.mock.state.replies.push({ content: 'Done.', when: afterTool('call_list') });
    await app.send('MCP-LIVE-1 add two numbers');
    await app.waitFor(`Boolean(document.querySelector('.approval.mcp'))`, 20_000, 'the approval card');
    const reqs = app.mock.state.requests.filter((r) => r.url === '/v1/chat/completions' && r.payload.stream && !r.payload.messages?.some((m) => m.role === 'system' && /safety check/i.test(String(m.content))));
    const mcpIn = (r) => (r.payload.tools ?? []).filter((t) => t.function.name.startsWith('mcp__acme_docs__')).length;
    const sys = String(reqs[0]?.payload.messages?.[0]?.content ?? '');
    check('load: the first request has no MCP tool, its prompt names the server and its tools', reqs.length >= 2 && mcpIn(reqs[0]) === 0 && /^- mcp:acme_docs \(9 tools\): echo, add, /m.test(sys), { n: reqs.length, first: reqs[0] && mcpIn(reqs[0]) });
    check('load: after load_tools the server\'s tools are sent', mcpIn(reqs[reqs.length - 1]) === 9, reqs.map(mcpIn));
    const card = await app.evaluate(`(() => { const c = document.querySelector('.approval.mcp'); return { title: c.querySelector('.title')?.innerText, sub: c.querySelector('.prompt-sub')?.innerText, keys: [...c.querySelectorAll('.mcp-arg-key')].map((e) => e.innerText), vals: [...c.querySelectorAll('.mcp-arg-value')].map((e) => e.innerText), buttons: [...c.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.innerText.trim()).filter(Boolean) }; })()`);
    check('approval: the heading has the real server and tool names', /^Call add on acme\.docs\?/.test(norm(card.title)), card);
    check("approval: the tool's title is secondary text beside it", card.sub === 'Add numbers', card);
    check('approval: flat arguments as keys and values', js(card.keys) === js(['a', 'b']) && js(card.vals) === js(['2', '3']), card);
    check('approval: the answers are unchanged', card.buttons.includes('Deny') && card.buttons.includes('Allow once') && card.buttons.includes('More ways to allow'), card.buttons);
    await app.evaluate(`[...document.querySelectorAll('.approval.mcp button')].find((b) => (b.getAttribute('aria-label') || b.innerText).trim() === 'More ways to allow').click()`);
    await sleep(200);
    const wider = await app.evaluate(`[...document.querySelectorAll('.popover button, .approval button')].map((b) => b.innerText.trim()).filter((t) => /acme/.test(t))`);
    check('approval: the wider answers name the real server', wider.some((t) => /Allow acme\.docs for this session/.test(t)) && !wider.some((t) => /acme_docs/.test(t)), wider);
    await app.key('Escape');
    await app.evaluate(`[...document.querySelectorAll('.approval.mcp button')].find((b) => (b.getAttribute('aria-label') || b.innerText).trim() === 'Allow once').click()`);
    await app.waitIdle(30_000);
    const rows = await app.evaluate(`[...document.querySelectorAll('#messages details.tool.mcp')].map((r) => ({ tool: r.dataset.tool, verb: r.querySelector('.tool-verb')?.textContent, server: r.querySelector('.tool-server')?.textContent, names: r.querySelector('.tool-mcp-names')?.textContent }))`);
    const add = rows.find((r) => r.tool === 'mcp__acme_docs__add');
    const list = rows.find((r) => r.tool === 'mcp__acme_docs__list__items');
    check('row: the title as its label, the real server in the pill', add && add.verb === 'Add numbers' && add.server === 'acme.docs', rows);
    check('row: the real names once open', add && add.names === 'acme.docs · add', add);
    check('row: a tool with "__" in its name is not split there', list && list.verb === 'list__items' && list.server === 'acme.docs' && list.names === 'acme.docs · list__items', list);
    check('load: no row for load_tools', (await app.count('#messages details.tool[data-tool="load_tools"]')) === 0);
    const fold = await app.evaluate(`[...document.querySelectorAll('#messages details.tool-group > summary .group-verb')].map((e) => e.innerText)`);
    check('the folded line: "Used acme.docs"', fold.includes('Used acme.docs'), fold);
    const errs = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('(A) no renderer errors', errs.length === 0, errs.slice(0, 3));
  } finally {
    await app.close();
  }
}

const SERVERS = [
  { name: 'kanban', scope: 'project', transport: 'stdio', target: 'npx -y @example/kanban-mcp', status: 'blocked', error: 'From .mcp.json. Not started until you trust it.', tools: [], config: {}, vars: [{ name: 'KANBAN_TOKEN', set: true }] },
  {
    name: 'files', scope: 'user', transport: 'stdio', target: 'npx -y @example/files-mcp', status: 'connected', tools: [
      { name: 'read_file', fullName: 'mcp__files__read_file', description: 'Read a file.', readOnly: true, destructive: false, title: 'Read file' },
      { name: 'write_file', fullName: 'mcp__files__write_file', description: 'Write a file.', readOnly: false, destructive: true },
    ], config: { command: 'npx', env: { API_KEY: '${API_KEY}' } }, mockLog: ['files-mcp ready'],
  },
  { name: 'tracker', scope: 'user', transport: 'http', target: 'https://tracker.example.com/mcp', status: 'needs-auth', tools: [], config: {} },
  { name: 'builder', scope: 'user', transport: 'stdio', target: 'uvx example-builder-mcp', status: 'error', error: "The server exited right after starting.\nKeyError: 'BUILDER_TOKEN'", tools: [], config: {} },
];

async function settingsUi() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-mcp-ui-'));
  const app = await launch({ root: ROOT, mock: true, project, size: { width: 1440, height: 900 } });
  const ev = (x) => app.evaluate(x);
  const row = (n) => `#mcp-list .mcp-row[data-name="${n}"]`;
  try {
    await app.waitFor(`Boolean(window.__oc_debug)`, 20_000, 'the app');
    await ev(`window.__oc_debug.mcp.mock(${js(SERVERS)})`);
    await ev(`(() => { document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-mcp').click(); })()`);
    await sleep(400);
    const prim = await ev(`[...document.querySelectorAll('#mcp-list .mcp-row')].map((r) => [r.dataset.name, [...r.querySelectorAll('.mcp-primary')].map((b) => b.innerText.trim()).join('|'), Boolean(r.querySelector('input.switch')), [...r.querySelectorAll('.mcp-status-line > span')].map((x) => x.textContent.trim()).join(' · ')])`);
    check('one action per row, by status', js(prim.map((p) => [p[0], p[1]])) === js([['kanban', 'Trust'], ['files', '2 tools'], ['tracker', 'Sign in'], ['builder', 'Retry']]), prim);
    check('a not-trusted row has no switch; the others have one', prim[0][2] === false && prim.slice(1).every((p) => p[2]), prim);
    check('status lines: words and the one-line reason', /^Not trusted/.test(prim[0][3]) && prim[1][3] === 'Connected' && prim[2][3] === 'Needs sign-in' && /^Failed · Exited: KeyError: 'BUILDER_TOKEN'$/.test(prim[3][3]), prim.map((p) => p[3]));
    check('the scope pill only on the project server', (await app.count('#mcp-list .mcp-scope')) === 1 && (await app.exists(`${row('kanban')} .mcp-scope`)));

    // The … menu, above the Settings dialog
    await app.click(`${row('files')} .mcp-more`);
    await sleep(250);
    const menu = await ev(`(() => { const m = document.querySelector('.popover.mcp-menu'); if (!m) return null; const r = m.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + 12); return { items: [...m.querySelectorAll('button')].map((b) => b.innerText.trim()), onTop: m.contains(top) }; })()`);
    check('menu: Reconnect, Show log, Copy config, then Remove', menu && js(menu.items) === js(['Reconnect', 'Show log', 'Copy config', 'Remove']), menu);
    check('menu: shown above the Settings dialog', menu && menu.onTop, menu);
    await ev(`[...document.querySelectorAll('.popover.mcp-menu button')].find((b) => b.innerText.trim() === 'Show log').click()`);
    await sleep(300);
    check('Show log opens in the row', norm(await app.text(`${row('files')} .mcp-log-text`)) === 'files-mcp ready');
    await app.click(`${row('files')} .mcp-more`);
    await sleep(200);
    await ev(`[...document.querySelectorAll('.popover.mcp-menu button')].find((b) => b.innerText.trim() === 'Copy config').click()`);
    await sleep(200);
    const copied = await ev(`navigator.clipboard.readText().catch(() => null)`);
    check('Copy config: the masked block (or the clipboard is not readable here)', copied === null || (JSON.parse(copied).mcpServers.files.env.API_KEY === '${API_KEY}'), copied);

    // Trust: a confirmation in the row, focus not on Trust
    await app.click(`${row('kanban')} .mcp-primary`);
    await sleep(250);
    const trust = await ev(`(() => { const c = document.querySelector('${row('kanban')} .mcp-confirm'); return c && { lines: [...c.querySelectorAll('li')].map((l) => l.innerText), focus: document.activeElement === c, onTrust: document.activeElement?.classList.contains('mcp-confirm-ok') }; })()`);
    check('Trust: what runs, read-only note, what it reads', trust && trust.lines[0] === 'Runs npx -y @example/kanban-mcp' && trust.lines[1] === 'Read-only tools run without asking.' && trust.lines[2] === 'Reads $KANBAN_TOKEN', trust);
    check('Trust: focus on the confirmation, not on its Trust button', trust && trust.focus && !trust.onTrust, trust);
    await app.click(`${row('kanban')} .mcp-confirm-ok`);
    await app.waitFor(`document.querySelector('${row('kanban')}')?.dataset.status === 'connected'`, 5000, 'kanban trusted').catch(() => false);
    check('Trust confirmed: the server starts', (await ev(`document.querySelector('${row('kanban')}')?.dataset.status`)) === 'connected');

    // A tool's switch (user server)
    await app.click(`${row('files')} .mcp-tools-toggle`);
    const groups = await ev(`[...document.querySelectorAll('${row('files')} .mcp-tools-group')].map((g) => g.innerText)`);
    check('tools: two groups', js(groups) === js(['Read-only · 1', 'Can make changes · 1']), groups);
    await ev(`(() => { const b = document.querySelector('${row('files')} input.switch[data-tool="write_file"]'); b.checked = false; b.dispatchEvent(new Event('change')); })()`);
    await sleep(300);
    check('a tool turned off is listed as off', (await app.exists(`${row('files')} .mcp-tool.off`)) && norm(await app.text(`${row('files')} .mcp-primary`)) === '1 tool');

    // The Add form
    check('the Add form is closed by default', await ev(`document.querySelector('#mcp-add').hidden`));
    await app.click('#mcp-add-open');
    await sleep(150);
    check('Add server opens it with focus on Config', !(await ev(`document.querySelector('#mcp-add').hidden`)) && (await ev(`document.activeElement?.id`)) === 'mcp-spec');
    await app.fill('#mcp-spec', 'https://search.example.com/mcp');
    const url = await ev(`({ name: document.querySelector('#mcp-name').value, understood: document.querySelector('#mcp-understood').innerText, label: document.querySelector('#mcp-env-label').innerText })`);
    check('a URL: name suggested, understood, Headers', url.name === 'search' && url.understood === 'Remote server: search.example.com' && /^Headers/.test(url.label), url);
    await app.fill('#mcp-name', 'mine');
    await app.fill('#mcp-spec', 'npx -y @example/files-mcp');
    check('a name the user typed is kept', (await ev(`document.querySelector('#mcp-name').value`)) === 'mine');
    await app.fill('#mcp-name', 'files');
    await app.click('#mcp-add-btn');
    await sleep(200);
    const dup = await ev(`(() => { const e = document.querySelector('#mcp-add-error'); return { text: e.innerText.trim(), byName: e.previousElementSibling?.querySelector('#mcp-name') !== null || e.previousElementSibling?.contains(document.querySelector('#mcp-name')) }; })()`);
    check('a duplicate: one short line by the name field', dup.text === 'There is already a server named files.' && dup.byName, dup);
    await ev(`(() => { const s = document.querySelector('#mcp-scope'); s.value = 'project'; s.dispatchEvent(new Event('change')); })()`);
    check('project scope: the values line shows', !(await ev(`document.querySelector('#mcp-values-hint').hidden`)));
    await ev(`document.querySelector('#mcp-spec').focus()`);
    await app.key('Escape');
    await sleep(150);
    check('Escape closes the form, Settings stays open', (await ev(`document.querySelector('#mcp-add').hidden`)) && (await ev(`document.querySelector('#settings').open`)));
    await ev(`document.querySelector('#settings').close()`);

    // /mcp and a failed call
    await app.send('/mcp');
    await app.waitFor(`Boolean(document.querySelector('.mcp-card'))`, 5000, 'the /mcp card');
    const cardRows = await ev(`[...document.querySelectorAll('.mcp-card-item')].map((i) => [i.dataset.name, i.querySelector('.mcp-card-status').innerText, i.querySelector('.mcp-card-action')?.innerText ?? ''])`);
    check('/mcp: one line per server, its words and its action', js(cardRows) === js([['kanban', 'Connected · no tools', ''], ['files', 'Connected · 1 tool', ''], ['tracker', 'Needs sign-in', 'Sign in'], ['builder', 'Failed', 'Retry']]), cardRows);
    check('/mcp: no tool chips', (await app.count('.mcp-card code')) === 0);
    await ev(`window.__oc_debug.emit({ type: 'run_start' })`);
    await ev(`window.__oc_debug.emit({ type: 'tool_start', id: 't1', name: 'mcp__tracker__create_issue', args: { title: 'x' }, mcp: { server: 'tracker', tool: 'create_issue' } })`);
    await ev(`window.__oc_debug.emit({ type: 'tool_end', id: 't1', name: 'mcp__tracker__create_issue', result: 'Error: MCP server "tracker" needs sign-in. The user can sign in under Settings → MCP servers.', ok: false, durationMs: 3 })`);
    await ev(`window.__oc_debug.emit({ type: 'run_end', reason: 'done' })`);
    await sleep(300);
    const problem = await ev(`(() => { const r = document.querySelector('details.tool[data-tool="mcp__tracker__create_issue"] .tool-mcp-problem'); return r && r.textContent.replace(/\\s+/g, ' ').trim(); })()`);
    check('a failed call: "tracker needs sign-in" with Sign in', problem === 'tracker needs sign-inSign in', problem);
    const foldFail = await ev(`[...document.querySelectorAll('#messages details.tool-group .group-failed')].map((e) => e.innerText).pop() ?? null`);
    check('…and its folded line says so in place of "1 failed" (or it is a row of its own)', foldFail === null || foldFail === 'tracker needs sign-in', foldFail);
    await ev(`document.querySelector('details.tool[data-tool="mcp__tracker__create_issue"] .tool-mcp-problem button').click()`);
    await app.waitFor(`document.querySelector('${row('tracker')}')?.dataset.status !== 'needs-auth'`, 5000, 'sign-in to start').catch(() => false);
    check('Sign in starts on that click', ['authorizing', 'connecting', 'connected'].includes(await ev(`document.querySelector('${row('tracker')}')?.dataset.status`)));
    const errs = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('(B) no renderer errors', errs.length === 0, errs.slice(0, 3));
  } finally {
    await app.close();
  }
}

(async () => {
  await realServer();
  await settingsUi();
  process.exit(done() ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
