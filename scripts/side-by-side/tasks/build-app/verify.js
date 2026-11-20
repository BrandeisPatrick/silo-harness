#!/usr/bin/env node
// build-app: runs the built pantrylog CLI against each requirement of SPEC.md (one hard check each, every one in a
// fresh folder of its own), then checks that tests exist and pass.
//   node verify.js <projectDir> [finalMessageFile]
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const u = require('../../lib/verify-util.js');

const { projectDir } = u.args();
const cli = path.join(projectDir, 'bin', 'pantrylog.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-pantrylog-'));
let n = 0;

/** A fresh working folder, with these items in pantry.json (or this raw text, or no file). */
function folder(items) {
  const dir = path.join(scratch, String(++n));
  fs.mkdirSync(dir);
  if (typeof items === 'string') fs.writeFileSync(path.join(dir, 'pantry.json'), items);
  else if (items) fs.writeFileSync(path.join(dir, 'pantry.json'), JSON.stringify({ items }, null, 2));
  return dir;
}
const run = (dir, ...args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
};
const raw = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, 'pantry.json'), 'utf8');
  } catch {
    return null;
  }
};
const items = (dir) => {
  try {
    return JSON.parse(raw(dir)).items.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit }));
  } catch {
    return null;
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A check that throws counts as false. */
const check = (f) => {
  try {
    return Boolean(f());
  } catch {
    return false;
  }
};

const hard = {};
hard.r1_entryPoint = check(() => fs.existsSync(cli) && /node --test/.test(JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).scripts.test));
hard.r2_dataFile = check(() => {
  const d = folder();
  const listed = run(d, 'list');
  if (listed.status !== 0 || raw(d) !== null) return false;
  return run(d, 'add', 'rice', '2', 'kg').status === 0 && same(items(d), [{ name: 'rice', qty: 2, unit: 'kg' }]);
});
hard.r3_add = check(() => {
  const d = folder();
  const a = run(d, 'add', 'Rice', '2', 'kg');
  const b = run(d, 'add', 'rice', '3');
  const c = run(d, 'add', 'beans', '4');
  return (
    a.status === 0 && a.out === 'Added 2 kg of Rice (now 2)' &&
    b.status === 0 && b.out === 'Added 3 kg of Rice (now 5)' &&
    c.status === 0 && c.out === 'Added 4 pcs of beans (now 4)' &&
    same(items(d).sort((x, y) => x.name.localeCompare(y.name)), [{ name: 'beans', qty: 4, unit: 'pcs' }, { name: 'Rice', qty: 5, unit: 'kg' }])
  );
});
hard.r4_use = check(() => {
  const d = folder([{ name: 'rice', qty: 5, unit: 'kg' }, { name: 'oats', qty: 1, unit: 'bag' }]);
  const a = run(d, 'use', 'RICE', '2');
  const okA = a.status === 0 && a.out === 'Used 2 kg of rice (3 left)' && same(items(d).find((i) => i.name === 'rice'), { name: 'rice', qty: 3, unit: 'kg' });
  const b = run(d, 'use', 'oats', '1');
  return okA && b.status === 0 && b.out === 'Used 1 bag of oats (0 left)' && !items(d).some((i) => i.name === 'oats');
});
hard.r5_notEnough = check(() => {
  const d = folder([{ name: 'rice', qty: 3, unit: 'kg' }]);
  const before = raw(d);
  const r = run(d, 'use', 'rice', '9');
  return r.status === 4 && r.err.includes('Error: only 3 kg of rice left') && raw(d) === before;
});
hard.r6_unknownItem = check(() => {
  const d = folder([{ name: 'rice', qty: 3, unit: 'kg' }]);
  const a = run(d, 'use', 'flour', '1');
  const b = run(d, 'remove', 'flour');
  return a.status === 3 && a.err.includes('Error: no item named flour') && b.status === 3 && b.err.includes('Error: no item named flour');
});
hard.r7_quantities = check(() =>
  ['0', '-1', '2.5', 'two'].every((q) => {
    const d = folder([{ name: 'rice', qty: 3, unit: 'kg' }]);
    const before = raw(d);
    const a = run(d, 'add', 'rice', q);
    const b = run(d, 'use', 'rice', q);
    const msg = 'Error: quantity must be a positive whole number';
    return a.status === 2 && a.err.includes(msg) && b.status === 2 && b.err.includes(msg) && raw(d) === before;
  }),
);
hard.r8_remove = check(() => {
  const d = folder([{ name: 'rice', qty: 3, unit: 'kg' }, { name: 'tea', qty: 1, unit: 'box' }]);
  const r = run(d, 'remove', 'rice');
  return r.status === 0 && r.out === 'Removed rice' && same(items(d), [{ name: 'tea', qty: 1, unit: 'box' }]);
});
hard.r9_list = check(() => {
  const d = folder([{ name: 'tea', qty: 1, unit: 'box' }, { name: 'beans', qty: 4, unit: 'pcs' }]);
  const a = run(d, 'list');
  const j = run(d, 'list', '--json');
  const e = run(folder(), 'list');
  return (
    a.status === 0 && a.out === 'beans: 4 pcs\ntea: 1 box' &&
    j.status === 0 && same(JSON.parse(j.out).map((i) => ({ name: i.name, qty: i.qty, unit: i.unit })), [{ name: 'beans', qty: 4, unit: 'pcs' }, { name: 'tea', qty: 1, unit: 'box' }]) &&
    e.status === 0 && e.out === 'Pantry is empty'
  );
});
hard.r10_low = check(() => {
  const d = folder([{ name: 'tea', qty: 1, unit: 'box' }, { name: 'rice', qty: 5, unit: 'kg' }, { name: 'beans', qty: 2, unit: 'pcs' }]);
  const a = run(d, 'low');
  const b = run(d, 'low', '5');
  const c = run(d, 'low', '0');
  return a.status === 0 && a.out === 'beans: 2 pcs\ntea: 1 box' && b.out === 'beans: 2 pcs\nrice: 5 kg\ntea: 1 box' && c.status === 0 && c.out === 'Nothing is running low';
});
const commands = ['add', 'use', 'remove', 'list', 'low'];
let helpText = '';
hard.r11_helpAndMistakes = check(() => {
  const d = folder();
  const h = run(d, '--help');
  const h2 = run(d, 'help');
  helpText = h.out;
  const none = run(d);
  const bad = run(d, 'bogus');
  const missing = run(d, 'add', 'rice');
  return (
    h.status === 0 && commands.every((c) => h.out.includes(c)) && h2.status === 0 && h2.out.includes('remove') &&
    none.status === 1 && none.err.length > 0 && bad.status === 1 && bad.err.length > 0 &&
    missing.status === 2 && missing.err.startsWith('Error:') && raw(d) === null
  );
});
hard.r12_brokenFile = check(() => {
  const d = folder('{ "items": [ oops');
  const a = run(d, 'list');
  const b = run(d, 'add', 'rice', '1');
  const msg = 'Error: pantry.json is not valid JSON';
  return a.status === 5 && a.err.includes(msg) && b.status === 5 && b.err.includes(msg) && raw(d) === '{ "items": [ oops';
});
hard.testsExist = u.countTests(projectDir) >= 3;
hard.testsPass = hard.testsExist && u.runTests(projectDir).ok;

const sources = u.listFiles(projectDir).filter((f) => /\.[cm]?js$/.test(f) && !/(^|\/)test\/|\.test\.[cm]?js$/.test(f));
let readme = '';
for (const f of u.listFiles(projectDir)) if (/^readme(\.md)?$/i.test(f)) readme = fs.readFileSync(path.join(projectDir, f), 'utf8');
fs.rmSync(scratch, { recursive: true, force: true });

u.finish(hard, {
  moreThanOneSourceFile: sources.length > 1,
  usageNamesEveryCommand: commands.every((c) => readme.includes(c)) || commands.every((c) => helpText.includes(c)),
  hasReadme: readme.length > 0,
});
