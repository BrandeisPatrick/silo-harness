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

  // ---------- Several edits in one call (edits) ----------
  // Applied in order, each to the result of the one before; one that does not match writes nothing and is named; the
  // card shows every change; the rewind snapshot is taken once, before the write.
  const { turnSnapshot, rewindSession } = require(path.join(projectDir, 'dist/main/sessions.js'));
  const { parseEditPreview } = await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(path.join(projectDir, 'dist/renderer/diff.js'), 'utf8').replace(/^import .*$/gm, '')));
  const h = path.join(tmp, 'm.txt');
  const original = 'alpha one\nbeta two\ngamma three\ndelta four\nepsilon five\n';
  const calls = { approve: [], snap: [] };
  const mctx = {
    ...ctx,
    sessionId: 'edit-multi',
    approve: async (name, detail, target) => (calls.approve.push({ name, detail, target }), { ok: true }),
    beforeChange: (f) => calls.snap.push(f),
  };
  // (each scenario as a session of its own: the file is rewritten here, which a session that wrote it would refuse)
  let scenario = 0;
  const reset = (text = original) => {
    mctx.sessionId = `edit-multi-${++scenario}`;
    fs.writeFileSync(h, text);
    calls.approve.length = 0;
    calls.snap.length = 0;
  };

  // order: the second replacement finds what the first made
  reset();
  out = await run(editFile, { path: 'm.txt', edits: [{ old_string: 'beta two', new_string: 'BETA two' }, { old_string: 'BETA two\ngamma', new_string: 'BETA-GAMMA' }, { old_string: 'epsilon', new_string: 'EPSILON' }] }, mctx);
  check('edits: applied in order, each on the result of the one before', fs.readFileSync(h, 'utf8') === 'alpha one\nBETA-GAMMA three\ndelta four\nEPSILON five\n', fs.readFileSync(h, 'utf8'));
  check('edits: the result counts the edits and the replacements', out === `Edited ${h} (3 edits, 3 replacements)`, out);
  check('edits: one approval, for the file, one snapshot before the write', calls.approve.length === 1 && calls.approve[0].name === 'edit_file' && calls.approve[0].target === h && calls.snap.length === 1 && calls.snap[0] === h, calls);
  const card = parseEditPreview(calls.approve[0].detail);
  check('edits: the card shows every change, as the lines they span before and after', card && card.path === h && card.oldText === 'beta two\ngamma three\ndelta four\nepsilon five' && card.newText === 'BETA-GAMMA three\ndelta four\nEPSILON five', card);

  // all or nothing: a later edit that does not match writes nothing, and the error names it
  reset();
  out = await run(editFile, { path: 'm.txt', edits: [{ old_string: 'alpha', new_string: 'ALPHA' }, { old_string: 'zzz not here qqq', new_string: 'x' }, { old_string: 'delta', new_string: 'DELTA' }] }, mctx);
  check('edits: one that does not match: nothing written', fs.readFileSync(h, 'utf8') === original && calls.approve.length === 0 && calls.snap.length === 0, { file: fs.readFileSync(h, 'utf8'), calls });
  check('edits: … the error names it and says nothing was written', /^ERROR: edits\[1\]: old_string was not found in .*m\.txt.*Nothing was written: none of the 3 edits was made\.$/s.test(out), out);
  out = await run(editFile, { path: 'm.txt', edits: [{ old_string: 'one', new_string: '1' }, { old_string: 'o', new_string: '0' }] }, mctx);
  check('edits: an ambiguous one names itself too', /^ERROR: edits\[1\]: old_string occurs \d+ times; make it unique or set replace_all=true/.test(out) && fs.readFileSync(h, 'utf8') === original, out);

  // overlapping: an edit whose text an earlier one replaced no longer matches (nothing written); one that builds on it does
  reset();
  out = await run(editFile, { path: 'm.txt', edits: [{ old_string: 'beta two\ngamma', new_string: 'BG' }, { old_string: 'gamma three', new_string: 'G3' }] }, mctx);
  check('edits: overlapping, the second\'s text was replaced by the first: nothing written, edits[1] named', out.startsWith('ERROR: edits[1]: old_string was not found') && fs.readFileSync(h, 'utf8') === original, out);
  out = await run(editFile, { path: 'm.txt', edits: [{ old_string: 'gamma three', new_string: 'gamma 3' }, { old_string: 'beta two\ngamma 3', new_string: 'beta+gamma' }] }, mctx);
  check('edits: overlapping, the second spans the first\'s result: both made', out === `Edited ${h} (2 edits, 2 replacements)` && fs.readFileSync(h, 'utf8') === 'alpha one\nbeta+gamma\ndelta four\nepsilon five\n', out);

  // replace_all inside the list, a whitespace-tolerant match, the list given as a JSON string
  reset('a = 1;\nb = 1;\nfunction f() {\n    return a;\n}\n');
  out = await run(editFile, { path: 'm.txt', edits: JSON.stringify([{ old_string: '= 1;', new_string: '= 2;', replace_all: true }, { old_string: 'function f() {\n  return a;\n}', new_string: 'const f = () => a;' }]) }, mctx);
  check('edits: replace_all and a loose match in the list (given as JSON text)', fs.readFileSync(h, 'utf8') === 'a = 2;\nb = 2;\nconst f = () => a;\n' && out === `Edited ${h} (2 edits, 3 replacements; edits[1] matched ignoring whitespace at lines 3–5)`, out);

  // the forms: both at once, an empty list, an empty old_string; the single form unchanged
  reset();
  for (const [label, args, want] of [
    ['both forms', { path: 'm.txt', old_string: 'alpha', new_string: 'A', edits: [{ old_string: 'beta', new_string: 'B' }] }, 'ERROR: Give old_string and new_string, or edits, not both.'],
    ['an empty list', { path: 'm.txt', edits: [] }, 'ERROR: edits must be a non-empty list of { old_string, new_string, replace_all? }.'],
    ['an empty old_string', { path: 'm.txt', edits: [{ old_string: 'alpha', new_string: 'A' }, { old_string: '', new_string: 'x' }] }, 'ERROR: edits[1]: old_string must not be empty'],
    ['neither form', { path: 'm.txt' }, 'ERROR: old_string must not be empty'],
  ]) {
    out = await run(editFile, args, mctx);
    check(`edits: ${label} is refused, nothing written`, out === want && fs.readFileSync(h, 'utf8') === original, out);
  }
  out = await run(editFile, { path: 'm.txt', old_string: 'alpha one', new_string: 'ALPHA one' }, mctx);
  const single = parseEditPreview(calls.approve[0]?.detail ?? '');
  check('edits: the single form is as before (its card: the text and its replacement)', out === `Edited ${h} (1 replacement)` && single && single.oldText === 'alpha one' && single.newText === 'ALPHA one', { out, single });
  check('edits: the schema keeps the single form and adds the list', editFile.parameters.required.join() === 'path' && editFile.parameters.properties.edits.type === 'array' && editFile.parameters.properties.old_string && /all or nothing/.test(editFile.parameters.properties.edits.description));

  // rewind: the snapshot taken before the write brings the file back
  reset();
  const turn = { at: 0, createdAt: 1, text: 'edit several places', files: {} };
  out = await run(editFile, { path: 'm.txt', edits: [{ old_string: 'alpha', new_string: 'A' }, { old_string: 'epsilon', new_string: 'E' }] }, { ...mctx, beforeChange: (f) => turnSnapshot(turn, f) });
  check('rewind: the edits were made', out === `Edited ${h} (2 edits, 2 replacements)` && fs.readFileSync(h, 'utf8') !== original);
  const session = { id: 'r', title: 't', createdAt: 0, updatedAt: 0, messages: [{ role: 'user', content: 'edit several places' }, { role: 'assistant', content: 'done' }], turns: [turn] };
  const rw = rewindSession(session, tmp, 0);
  check('rewind: restores the file as it was before all of them', fs.readFileSync(h, 'utf8') === original && rw.restored.join() === 'm.txt', rw);

  // hooks see the list (Claude Code's Edit input with edits)
  const { claudeToolInput, nativeToolInput } = require(path.join(projectDir, 'dist/main/hooks/tools.js'));
  const hookIn = claudeToolInput('edit_file', { path: 'm.txt', edits: [{ old_string: 'a', new_string: 'b' }] }, tmp);
  check('hooks: the edits list reaches a hook, and comes back', hookIn.file_path === h && hookIn.edits.length === 1 && JSON.stringify(nativeToolInput('edit_file', hookIn)) === JSON.stringify({ edits: [{ old_string: 'a', new_string: 'b' }], path: h }), { hookIn, back: nativeToolInput('edit_file', hookIn) });

  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
