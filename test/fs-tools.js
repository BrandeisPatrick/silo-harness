// The file tools, headless with a fake ToolContext: reads of secret paths ask through ctx.approve (read_file,
// list_directory, grep, glob) and ordinary ones do not; grep and glob leave secret files inside a tree out.
// Run: node test/fs-tools.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
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

  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
