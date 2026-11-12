// The words of a folded run of tool calls (src/renderer/tool-activity.ts): one phrase per kind of call in the order
// the kinds first appear, with counts ("Read 3 files, ran 2 commands, edited a file"); every tool the app has reads
// as what it did, never "used another tool"; denied calls are counted on their own; past four kinds the line names
// three and says how many more. Also: write_file says whether it created the file, which the line relies on.
// Run: node test/tool-activity.js (after npm run build)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

(async () => {
  // tool-activity.js imports nothing, so its source loads as a data: module (as test/tool-labels.js does)
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/tool-activity.js'), 'utf8');
  const { activityWords, groupSummary, MAX_KINDS } = await import('data:text/javascript,' + encodeURIComponent(src));
  const say = (calls) => groupSummary(calls);

  // ---------- Counts, plurals, order ----------
  check('the example line', say([{ name: 'read_file', path: 'a' }, { name: 'read_file', path: 'b' }, { name: 'read_file', path: 'c' }, 'bash', 'bash', { name: 'edit_file', path: 'a' }]) === 'Read 3 files, ran 2 commands, edited a file', say([{ name: 'read_file', path: 'a' }, { name: 'read_file', path: 'b' }, { name: 'read_file', path: 'c' }, 'bash', 'bash', { name: 'edit_file', path: 'a' }]));
  check('kinds in the order they first appear', say(['bash', { name: 'read_file', path: 'x' }, 'bash']) === 'Ran 2 commands, read a file');
  check('one of a kind reads "a" / "an"', say(['bash', 'show_image', 'session_spawn']) === 'Ran a command, showed an image, started a sub-session');
  check('the same file twice is one file', say([{ name: 'edit_file', path: 'src/a.ts' }, { name: 'edit_file', path: 'src/a.ts' }, { name: 'edit_file', path: 'src/b.ts' }]) === 'Edited 2 files');
  check('reads without a path still count', say(['read_file', 'read_file']) === 'Read 2 files');
  check('grep and glob are searches together', say(['grep', 'glob', 'grep']) === 'Ran 3 searches');
  check('bash and terminal_run are commands together', say(['bash', 'terminal_run']) === 'Ran 2 commands');
  check('writes: created or wrote', say([{ name: 'write_file', path: 'new.js', created: true }, { name: 'write_file', path: 'old.js' }]) === 'Created a file, wrote a file');
  check('two created files', say([{ name: 'write_file', path: 'a', created: true }, { name: 'write_file', path: 'b', created: true }]) === 'Created 2 files');
  check('directories', say(['list_directory']) === 'Listed a directory' && say(['list_directory', 'list_directory']) === 'Listed 2 directories');
  check('the terminal', say(['terminal_read', 'terminal_read', 'terminal_list', 'terminal_stop']) === 'Read the terminal 2 times, listed the terminal tabs, stopped a command');

  // ---------- The browser ----------
  check('pages and web searches', say([{ name: 'browser_navigate', url: 'https://example.com' }, { name: 'browser_navigate', url: 'https://example.com/b' }, { name: 'browser_navigate', url: 'best pizza near me' }]) === 'Opened 2 pages, searched the web');
  check('screenshots and the rest of the browser', say(['browser_click', 'browser_type', 'browser_screenshot', 'browser_scroll']) === 'Used the browser 3 times, took a screenshot');
  check('back and forward are browser steps', say([{ name: 'browser_navigate', url: 'back' }]) === 'Used the browser');

  // ---------- MCP by server, unknown tools ----------
  check('MCP calls by server', say(['mcp__github__search_issues', 'mcp__github__get_issue', 'mcp__linear__list']) === 'Called 2 tools on github, called a tool on linear');
  check('unknown tools', say(['frobnicate']) === 'Used another tool' && say(['frobnicate', 'zap']) === 'Used 2 other tools');

  // ---------- Every tool the app has reads as what it did ----------
  const registered = new Set();
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name !== 'remote') walk(p);
      } else if (p.endsWith('.ts')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/name: '([a-z_]+)',\s*\n\s*description:(?:(?!\bname: ')[\s\S]){0,2000}?\bparameters:/g)) registered.add(m[1]);
      }
    }
  };
  walk(path.join(projectDir, 'src/main'));
  // The browser's tools are named in the main process from a list; tools.ts knows them all
  const toolsTs = fs.readFileSync(path.join(projectDir, 'src/renderer/tools.ts'), 'utf8');
  const known = /const KNOWN_TOOLS = new Set\(\[([\s\S]*?)\]\);/.exec(toolsTs)[1];
  for (const m of known.matchAll(/'([a-z_]+)'/g)) registered.add(m[1]);
  for (const n of ['session_spawn', 'session_send', 'session_list', 'session_read', 'session_merge', 'session_rename', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'mod_check', 'submit_plan']) registered.add(n);
  const generic = [...registered].filter((n) => /other tool/.test(say([n])));
  check(`every tool the app has (${registered.size}) has words of its own`, registered.size > 30 && generic.length === 0, generic);
  const lines = [...registered].sort().map((n) => `${n}: ${say([n])} / ${say([n, n])}`);
  check('one call and two calls read differently for every tool but the files read twice', [...registered].every((n) => say([n]) !== say([n, n])), lines.filter((l) => l.split(': ')[1].split(' / ')[0] === l.split(' / ')[1]));
  console.log(lines.map((l) => '      ' + l).join('\n'));

  // ---------- Denied calls ----------
  const d = activityWords(['bash', { name: 'edit_file', path: 'a', denied: true }, { name: 'read_file', path: 'b' }]);
  check('a denied call is left out of the words and counted', d.text === 'Ran a command, read a file' && d.denied === 1, d);
  const all = activityWords([{ name: 'bash', denied: true }, { name: 'write_file', denied: true }]);
  check('every call denied: the words say so, and nothing is counted twice', all.text === 'Denied 2 calls' && all.denied === 0, all);
  check('one denied call alone names what it was', activityWords([{ name: 'bash', denied: true }]).text === 'Denied a command');
  check('denials of one kind are counted as that kind', activityWords([{ name: 'edit_file', path: 'a', denied: true }, { name: 'edit_file', path: 'b', denied: true }]).text === 'Denied 2 edits');
  check('a denied MCP call names its server; a denied tool of no kind of its own is a call', activityWords([{ name: 'mcp__figma__get_image', denied: true }]).text === 'Denied a call to figma' && activityWords([{ name: 'browser_click', denied: true }]).text === 'Denied a call');
  check('a question reads as one', activityWords(['ask_user']).text === 'Asked a question' && activityWords(['ask_user', 'ask_user']).text === 'Asked 2 questions');

  // ---------- One line: "and N more" ----------
  check(`${MAX_KINDS} kinds are all named`, say(['read_file', 'bash', 'edit_file', 'grep']) === 'Read a file, ran a command, edited a file, ran a search');
  const many = say(['read_file', 'bash', 'edit_file', 'grep', 'skill', 'session_send']);
  check('more kinds: the first three, then how many more', many === 'Read a file, ran a command, edited a file and 3 more', many);
  check('the phrases are all kept for whoever needs them', activityWords(['read_file', 'bash', 'edit_file', 'grep', 'skill']).phrases.length === 5);
  check('nothing at all is an empty line', say([]) === '');

  // ---------- The present tense: the heading of a live run's opened list ----------
  const now = (calls) => groupSummary(calls, { tense: 'present' });
  check('present: one command', now(['bash']) === 'Running a command', now(['bash']));
  check('present: counts every call', now(['bash', 'bash', 'terminal_run']) === 'Running 3 commands', now(['bash', 'bash', 'terminal_run']));
  check('present: kinds in order, same phrases', now([{ name: 'read_file', path: 'a' }, { name: 'read_file', path: 'b' }, 'bash']) === 'Reading 2 files, running a command');
  check('present: the same file twice is one file', now([{ name: 'edit_file', path: 'a' }, { name: 'edit_file', path: 'a' }]) === 'Editing a file');
  check('present: writes, searches, the web, MCP', now([{ name: 'write_file', path: 'n', created: true }, 'grep', 'web_search', { name: 'mcp__docs__find', server: 'docs' }]) === 'Creating a file, running a search, searching the web, calling a tool on docs', now([{ name: 'write_file', path: 'n', created: true }, 'grep', 'web_search', { name: 'mcp__docs__find', server: 'docs' }]));
  check('present: past MAX_KINDS kinds, three named and "and N more"', now(['read_file', 'bash', 'edit_file', 'grep', 'skill']) === 'Reading a file, running a command, editing a file and 2 more');
  check('present: every kind of tool has a present verb', Object.entries({ read_file: 0, edit_file: 0, list_directory: 0, glob: 0, terminal_read: 0, terminal_list: 0, terminal_stop: 0, skill: 0, create_artifact: 0, show_image: 0, update_tasks: 0, ask_user: 0, submit_plan: 0, session_spawn: 0, session_send: 0, session_list: 0, session_read: 0, session_merge: 0, session_rename: 0, schedule_create: 0, schedule_list: 0, schedule_update: 0, schedule_delete: 0, mod_check: 0, history_search: 0, propose_skill: 0, propose_memory: 0, propose_mod: 0, withdraw_proposal: 0, browser_screenshot: 0, web_fetch: 0, browser_click: 0, write_file: 0, unknown_tool: 0 }).every(([n]) => /^[A-Z][a-z]+ing\b/.test(now([n]))), ['read_file', 'withdraw_proposal', 'browser_click', 'unknown_tool', 'write_file'].map((n) => now([n])));
  check('present: a line of denials only stays as it is', now([{ name: 'bash', denied: true }]) === 'Denied a command');
  check('past is still the default', say(['bash']) === 'Ran a command' && groupSummary(['bash'], { tense: 'past' }) === 'Ran a command');

  // ---------- write_file says whether it made the file ----------
  const { writeFile } = require(path.join(projectDir, 'dist/main/tools/fs.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-activity-'));
  const ctx = { cwd: dir, approve: async () => ({ ok: true }), beforeChange: () => {} };
  const first = await writeFile.run({ path: 'a.txt', content: 'one\n' }, ctx);
  const second = await writeFile.run({ path: 'a.txt', content: 'two\n' }, ctx);
  check('a new file: "Created …"', /^Created .*a\.txt \(4 bytes\)$/.test(first.content), first.content);
  check('a file that was there: "Wrote …"', /^Wrote 4 bytes to .*a\.txt$/.test(second.content), second.content);
  fs.rmSync(dir, { recursive: true, force: true });

  done();
})();
