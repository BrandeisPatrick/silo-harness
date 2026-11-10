// edit_file, headless with a fake ToolContext: the whitespace-tolerant fallback matches only where runs of whitespace
// differ (never "foo bar" for "foobar"), says when it was used, shows the closest lines when nothing matches, and an
// edit refuses a file that changed on disk since the session read it. Run: node test/edit-file.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { readFile, writeFile, editFile, fuzzyFind, fuzzyMatch } = require(path.join(projectDir, 'dist/main/tools/fs.js'));
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Pure matching
  check('fuzzyFind: "foo bar()" does not match "foobar();"', fuzzyFind('foobar();\n', 'foo bar()') === null, fuzzyFind('foobar();\n', 'foo bar()'));
  check('fuzzyFind: "returnx" does not match "return  x"', fuzzyFind('return  x\n', 'returnx') === null, fuzzyFind('return  x\n', 'returnx'));
  check('fuzzyFind: indentation only', fuzzyFind('a\n    if (x) {\n        y();\n    }\nb', 'if (x) {\n  y();\n}') === '    if (x) {\n        y();\n    }');
  check('fuzzyFind: inner runs of whitespace', fuzzyFind('let  x =   1;\n', 'let x = 1;') === 'let  x =   1;');
  check('fuzzyFind: a reflowed line', fuzzyFind('call(a,\n     b);\n', 'call(a, b);') === 'call(a,\n     b);');
  check('fuzzyFind: curly quotes and long dashes', fuzzyFind('say(“hi”) — ok\n', 'say("hi")  - ok') === 'say(“hi”) — ok');
  check('fuzzyFind: two places is ambiguous', fuzzyFind('a  b\nc\na   b\n', 'a b') === 'ambiguous');
  const m = fuzzyMatch('one\ntwo\n  three\n  four\n', 'three\nfour');
  check('fuzzyMatch: says the lines', m && m.startLine === 3 && m.endLine === 4, m);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-edit-'));
  const ctx = { cwd: tmp, sessionId: 'edit-1', approve: async () => ({ ok: true }), beforeChange() {} };
  const run = (tool, args, c = ctx) => tool.run(args, c).then((r) => r.content, (e) => `ERROR: ${e.message}`);
  const f = path.join(tmp, 'a.js');

  fs.writeFileSync(f, 'function foo() {\n    return 1;\n}\nfoobar();\n');
  let out = await run(editFile, { path: 'a.js', old_string: 'foo bar()', new_string: 'x()' });
  check('edit: the squashed-whitespace match now fails', out.startsWith('ERROR: old_string was not found') && fs.readFileSync(f, 'utf8').includes('foobar();'), out);
  check('edit: … and shows the closest lines, numbered', out.includes('The closest lines in the file:') && /4\| foobar\(\);/.test(out) && out.includes('Read the file and copy the text exactly'), out);
  out = await run(editFile, { path: 'a.js', old_string: 'function foo() {\n  return 1;\n}', new_string: 'function foo() {\n    return 2;\n}' });
  check('edit: an indentation-only difference matches and says so', /\(1 replacement; matched ignoring whitespace at lines 1–3\)$/.test(out) && fs.readFileSync(f, 'utf8').includes('return 2;'), out);
  out = await run(editFile, { path: 'a.js', old_string: 'return 2;', new_string: 'return 3;' });
  check('edit: an exact match says nothing more', /\(1 replacement\)$/.test(out), out);
  out = await run(editFile, { path: 'a.js', old_string: 'zzz qqq unrelated', new_string: 'x' });
  check('edit: no hint when no line is close', out.startsWith('ERROR:') && !out.includes('closest lines'), out);

  // Stale reads
  const g = path.join(tmp, 'b.txt');
  fs.writeFileSync(g, 'alpha\nbeta\n');
  out = await run(editFile, { path: 'b.txt', old_string: 'alpha', new_string: 'ALPHA' });
  check('stale: a file never read is not refused', out.startsWith('Edited'), out);
  await run(readFile, { path: 'b.txt' });
  await sleep(20);
  fs.writeFileSync(g, 'ALPHA\nbeta\ngamma by the user\n');
  out = await run(editFile, { path: 'b.txt', old_string: 'beta', new_string: 'BETA' });
  check('stale: a file changed on disk since the read is refused', /changed on disk since you read it; read it again/.test(out) && fs.readFileSync(g, 'utf8').includes('\nbeta\n'), out);
  out = await run(editFile, { path: 'b.txt', old_string: 'beta', new_string: 'BETA' }, { ...ctx, sessionId: 'edit-2' });
  check('stale: another session that never read it is not refused', out.startsWith('Edited'), out);
  await run(readFile, { path: 'b.txt' });
  out = await run(editFile, { path: 'b.txt', old_string: 'gamma', new_string: 'GAMMA' });
  check('stale: after a re-read the edit runs', out.startsWith('Edited'), out);
  out = await run(editFile, { path: 'b.txt', old_string: 'GAMMA', new_string: 'gamma' });
  check("stale: the agent's own edit updates the record", out.startsWith('Edited'), out);
  await run(writeFile, { path: 'b.txt', content: 'new\ncontent\n' });
  out = await run(editFile, { path: 'b.txt', old_string: 'content', new_string: 'CONTENT' });
  check("stale: the agent's own write updates the record", out.startsWith('Edited'), out);

  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
