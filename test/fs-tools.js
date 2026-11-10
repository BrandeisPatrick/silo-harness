// The file tools, headless with a fake ToolContext: reads of secret paths ask through ctx.approve (read_file,
// list_directory, grep, glob) and ordinary ones do not; grep and glob leave secret files inside a tree out.
// Run: node test/fs-tools.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
// A fake home folder (os.homedir() follows HOME): the walks of "the home folder" below never touch the real one
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-'));
process.env.HOME = fakeHome;
const { decideApproval } = require(path.join(projectDir, 'dist/main/agent/permissions.js'));
const { readFile, listDirectory, grep, glob, findRipgrep, setRipgrep } = require(path.join(projectDir, 'dist/main/tools/fs.js'));
const { check, done } = require('./support/check.js');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-fs-'));
  fs.writeFileSync(path.join(tmp, '.env'), 'TOKEN=secret-value-123\n');
  fs.writeFileSync(path.join(tmp, '.env.example'), 'TOKEN=put-yours-here\n');
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello TOKEN world\n');
  fs.mkdirSync(path.join(tmp, '.ssh'));
  fs.writeFileSync(path.join(tmp, '.ssh', 'id_rsa'), 'TOKEN private key\n');

  const calls = [];
  let answer = { ok: false, message: 'Not permitted: denied.' };
  const ctx = { cwd: tmp, sessionId: 's1', approve: async (...a) => (calls.push(a), answer), beforeChange() {} };
  const run = async (tool, args) => {
    calls.length = 0;
    return (await tool.run(args, ctx)).content;
  };

  let out = await run(readFile, { path: '.env' });
  check('read_file .env asks, with reads-secret tool name and the path', calls.length === 1 && calls[0][0] === 'read_file' && calls[0][2] === path.join(tmp, '.env'), calls);
  check('… and a denial returns its message, not the content', out === 'Not permitted: denied.' && !out.includes('secret-value'), out);
  answer = { ok: true };
  out = await run(readFile, { path: '.env' });
  check('… allowed, it reads', out.includes('secret-value-123'), out);
  answer = { ok: false, message: 'Not permitted: denied.' };
  out = await run(readFile, { path: 'a.txt' });
  check('read_file a.txt does not ask', calls.length === 0 && out.includes('hello'), calls);
  out = await run(readFile, { path: '.env.example' });
  check('read_file .env.example does not ask', calls.length === 0 && out.includes('put-yours-here'), calls);
  out = await run(readFile, { path: '.ssh/id_rsa' });
  check('read_file .ssh/id_rsa asks', calls.length === 1, calls);
  out = await run(listDirectory, { path: '.ssh' });
  check('list_directory .ssh asks', calls.length === 1 && calls[0][0] === 'list_directory', calls);
  out = await run(listDirectory, {});
  check('list_directory of the project does not ask', calls.length === 0 && out.includes('.env'), out);

  out = await run(grep, { pattern: 'TOKEN' });
  check('grep over the tree does not ask and leaves secret files out', calls.length === 0 && out.includes('a.txt') && out.includes('.env.example') && !out.includes('secret-value') && !out.includes('id_rsa'), out);
  out = await run(grep, { pattern: 'TOKEN', path: '.ssh' });
  check('grep rooted at .ssh asks', calls.length === 1 && calls[0][0] === 'grep' && out === 'Not permitted: denied.', out);
  out = await run(glob, { pattern: '**/*' });
  check('glob over the tree does not ask and leaves secret files out', calls.length === 0 && out.includes('a.txt') && out.includes('.env.example') && !/(^|\n)\.env(\n|$)/.test(out) && !out.includes('id_rsa'), out);
  out = await run(glob, { pattern: '*', path: '.ssh' });
  check('glob rooted at .ssh asks', calls.length === 1 && calls[0][0] === 'glob', calls);

  // glob: newest-modified first
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-glob-'));
  const gctx = { ...ctx, cwd: g };
  const now = Date.now() / 1000;
  ['old.ts', 'mid.ts', 'new.ts'].forEach((n, i) => {
    fs.writeFileSync(path.join(g, n), 'x');
    fs.utimesSync(path.join(g, n), now - 300 + i * 100, now - 300 + i * 100);
  });
  out = (await glob.run({ pattern: '*.ts' }, gctx)).content;
  check('glob: newest first', out === 'new.ts\nmid.ts\nold.ts', out);

  // grep: ripgrep when installed (.gitignore honoured), grep otherwise; the same output shape
  fs.mkdirSync(path.join(g, 'ignored'));
  fs.mkdirSync(path.join(g, 'src'));
  fs.writeFileSync(path.join(g, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(path.join(g, 'ignored', 'x.txt'), 'NEEDLE in ignored\n');
  fs.writeFileSync(path.join(g, 'src', 'y.txt'), 'NEEDLE in src\n');
  fs.writeFileSync(path.join(g, '.hidden.txt'), 'NEEDLE hidden\n');
  const rg = findRipgrep();
  setRipgrep(null);
  out = (await grep.run({ pattern: 'NEEDLE' }, gctx)).content;
  check('grep (grep): path:line:text, hidden files searched', /^src\/y\.txt:1:NEEDLE in src$/m.test(out) && out.includes('.hidden.txt:1:'), out);
  out = (await grep.run({ pattern: 'needle', ignore_case: true, include: '*.txt', path: 'src' }, gctx)).content;
  check('grep (grep): ignore_case and include', /src\/y\.txt:1:NEEDLE in src/.test(out), out);
  if (rg) {
    setRipgrep(rg);
    out = (await grep.run({ pattern: 'NEEDLE' }, gctx)).content;
    check('grep (rg): .gitignore honoured, hidden files searched, same shape', /^src\/y\.txt:1:NEEDLE in src$/m.test(out) && out.includes('.hidden.txt:1:') && !out.includes('ignored'), out);
    out = (await grep.run({ pattern: 'needle', ignore_case: true, include: '*.txt', path: 'src' }, gctx)).content;
    check('grep (rg): ignore_case and include', /src\/y\.txt:1:NEEDLE in src/.test(out), out);
    out = (await grep.run({ pattern: 'TOKEN' }, ctx)).content;
    check('grep (rg): secret files left out', out.includes('a.txt') && !out.includes('secret-value'), out);
  } else console.log('skip grep (rg): ripgrep is not installed');
  setRipgrep(undefined);
  fs.rmSync(g, { recursive: true, force: true });

  // grep and glob output is capped where it is made: lines cut at 400 characters, the result at 12,000
  const F = require(path.join(projectDir, 'dist/main/tools/fs.js'));
  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-caps-'));
  const bctx = { ...ctx, cwd: big };
  fs.writeFileSync(path.join(big, 'min.js'), `HIT${'x'.repeat(5000)}\n`);
  out = (await grep.run({ pattern: 'HIT' }, bctx)).content;
  check('grep: a long line is cut at 400 characters and says how many more', out === `min.js:1:HIT${'x'.repeat(400 - 'min.js:1:HIT'.length)}…(${'min.js:1:HIT'.length + 5000 - 400} more characters)`, out.slice(0, 80) + '…' + out.slice(-60));
  fs.writeFileSync(path.join(big, 'many.txt'), Array.from({ length: 200 }, (_, i) => `HIT ${i} ${'y'.repeat(100)}`).join('\n') + '\n');
  out = (await grep.run({ pattern: 'HIT \\d', path: 'many.txt' }, bctx)).content;
  const kept = out.split('\n').filter((l) => /HIT \d/.test(l)).length;
  check('grep: the result stops after a whole line within 12,000 characters, and says how many were left out and how to narrow', out.length <= F.SEARCH_RESULT_CHARS + 100 && kept < 200 && new RegExp(`\\n…\\(${200 - kept} more matches; narrow with a tighter pattern, a path or include\\)$`).test(out) && /HIT \d+ y+$/m.test(out.split('\n')[kept - 1]), { kept, tail: out.slice(-120) });
  fs.writeFileSync(path.join(big, 'lots.txt'), Array.from({ length: 400 }, (_, i) => `HIT ${i}`).join('\n') + '\n');
  out = (await grep.run({ pattern: 'HIT \\d', path: 'lots.txt' }, bctx)).content;
  check('grep: short lines still stop at 300, the note counts the rest', out.split('\n').length === 301 && out.endsWith('\n…(100 more matches; narrow with a tighter pattern, a path or include)'), out.slice(-100));
  for (let i = 0; i < 1100; i++) fs.writeFileSync(path.join(big, `file-with-a-longish-name-${String(i).padStart(4, '0')}.md`), '');
  out = (await glob.run({ pattern: '*.md' }, bctx)).content;
  const names = out.split('\n').filter((l) => l.endsWith('.md'));
  check('glob: within 12,000 characters, whole names, and the note says how many more of the 1,000 found', out.length <= F.SEARCH_RESULT_CHARS + 100 && names.length < 1000 && names.every((n) => /^file-with-a-longish-name-\d{4}\.md$/.test(n)) && out.endsWith(`\n…(${1000 - names.length} more files found before the search stopped at 1000; narrow the pattern or path)`), out.slice(-140));
  for (let i = 0; i < 1100; i++) fs.rmSync(path.join(big, `file-with-a-longish-name-${String(i).padStart(4, '0')}.md`));
  for (let i = 0; i < 1050; i++) fs.writeFileSync(path.join(big, `${i}.md`), '');
  out = (await glob.run({ pattern: '*.md' }, bctx)).content;
  check('glob: short names still stop at 1,000 with the old note', out.split('\n').length === 1001 && out.endsWith('\n…(stopped at 1000 results)'), out.slice(-60));
  fs.rmSync(big, { recursive: true, force: true });

  // grep and glob rooted at the home folder, ~/Library, /, /Users or /Volumes ask "scans the home folder" first
  fs.mkdirSync(path.join(fakeHome, 'projects', 'app'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, 'projects', 'app', 'n.txt'), 'NEEDLE at home\n');
  fs.writeFileSync(path.join(fakeHome, 'notes.txt'), 'NEEDLE notes\n');
  for (const [tool, args, root] of [
    [grep, { pattern: 'x', path: '~' }, fakeHome],
    [grep, { pattern: 'x', path: '~/' }, fakeHome],
    [grep, { pattern: 'x', path: '/' }, '/'],
    [grep, { pattern: 'x', path: '/Users' }, '/Users'],
    [glob, { pattern: '**/*.pdf', path: '~' }, fakeHome],
    [glob, { pattern: '*', path: '/Volumes' }, '/Volumes'],
    [glob, { pattern: '*', path: '~/Library' }, path.join(fakeHome, 'Library')],
  ]) {
    out = await run(tool, args);
    check(`${tool.name} rooted at ${args.path} asks before it walks`, calls.length === 1 && calls[0][0] === tool.name && calls[0][2] === root && out === 'Not permitted: denied.', { calls, out });
  }
  const hctx = { ...ctx, cwd: fakeHome };
  calls.length = 0;
  out = (await grep.run({ pattern: 'NEEDLE' }, hctx)).content;
  check('grep with no path in the home folder asks', calls.length === 1 && calls[0][2] === fakeHome && out === 'Not permitted: denied.', calls);
  calls.length = 0;
  out = (await glob.run({ pattern: '*' }, hctx)).content;
  check('glob with no path in the home folder asks', calls.length === 1 && out === 'Not permitted: denied.', calls);
  out = await run(grep, { pattern: 'NEEDLE', path: '~/projects' });
  check('grep in a named folder under home does not ask', calls.length === 0 && out.includes('n.txt'), out);
  out = await run(glob, { pattern: '*.txt', path: '~/projects/app' });
  check('glob in a named folder under home does not ask', calls.length === 0 && out === 'n.txt', out);
  out = await run(listDirectory, { path: '~' });
  check('list_directory of the home folder does not ask (it lists one level)', calls.length === 0 && out.includes('projects/'), out);
  out = await run(readFile, { path: '~/notes.txt' });
  check('read_file of a file in home does not ask', calls.length === 0 && out.includes('NEEDLE notes'), out);
  answer = { ok: true };
  out = await run(grep, { pattern: 'NEEDLE', path: '~' });
  check('grep at home, allowed, searches', calls.length === 1 && out.includes('notes.txt'), out);
  answer = { ok: false, message: 'Not permitted: denied.' };

  // What the rules decide for that approval, per mode; a secret root keeps "reads secrets"
  const SCAN = 'scans the home folder';
  const none = { mcp: () => false, reason: () => false, program: () => false, custom: () => false };
  const mctx = (mode, over = {}) => ({ mode, auto: 'guard', cwd: tmp, rules: undefined, mcp: () => undefined, allowed: none, ...over });
  const decide = (name, target, c) => decideApproval(name, target, target, {}, c);
  let d;
  for (const name of ['grep', 'glob']) {
    for (const m of ['ask', 'acceptEdits', 'auto', 'plan']) {
      d = decide(name, fakeHome, mctx(m));
      check(`${name} at home: ${m} asks "${SCAN}"`, d.kind === 'ask' && d.reason === SCAN && !d.custom, d);
    }
    d = decide(name, '/', mctx('auto', { auto: 'check' }));
    check(`${name} at /: Auto with the check sends it to the check`, d.kind === 'classify' && d.reason === SCAN, d);
    check(`${name} at home: Bypass runs it`, decide(name, fakeHome, mctx('bypass')).kind === 'allow');
    check(`${name} at home: allowed for the session, it runs`, decide(name, fakeHome, mctx('ask', { allowed: { ...none, reason: (r) => r === SCAN } })).kind === 'allow');
    check(`${name} at home: a saved project rule runs it`, decide(name, fakeHome, mctx('plan', { rules: { reasons: [SCAN] } })).kind === 'allow');
    check(`${name} at home: allowing "reads secrets" does not cover it`, decide(name, fakeHome, mctx('ask', { allowed: { ...none, reason: (r) => r === 'reads secrets' } })).kind === 'ask');
    d = decide(name, path.join(tmp, '.ssh'), mctx('ask'));
    check(`${name} at .ssh: still "reads secrets"`, d.kind === 'ask' && d.reason === 'reads secrets', d);
  }
  d = decide('read_file', path.join(fakeHome, '.ssh/id_rsa'), mctx('ask'));
  check('read_file of a secret: still "reads secrets"', d.kind === 'ask' && d.reason === 'reads secrets', d);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
