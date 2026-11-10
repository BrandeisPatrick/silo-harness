// The file tools, headless with a fake ToolContext: reads of secret paths ask through ctx.approve (read_file,
// list_directory, grep, glob) and ordinary ones do not; grep and glob leave secret files inside a tree out.
// Run: node test/fs-tools.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { readFile, listDirectory, grep, glob } = require(path.join(projectDir, 'dist/main/tools/fs.js'));
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

  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
