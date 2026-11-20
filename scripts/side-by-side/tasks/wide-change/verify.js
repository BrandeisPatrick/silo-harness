#!/usr/bin/env node
// wide-change: the project's tests pass; the public API, called the new way (with await), returns promises and the
// right values; and no synchronous fs call is left in src.
//   node verify.js <projectDir> [finalMessageFile]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const u = require('../../lib/verify-util.js');

const { projectDir } = u.args();
const template = path.join(__dirname, 'template');
const SYNC = /\b(?:readFileSync|writeFileSync|appendFileSync|existsSync|mkdirSync|readdirSync|renameSync|unlinkSync|statSync|lstatSync|rmSync|accessSync|openSync|copyFileSync)\b/;

const thenable = (v) => Boolean(v) && typeof v.then === 'function';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejectsWith = async (f, name) => {
  try {
    await f();
    return false;
  } catch (err) {
    return Boolean(err) && err.name === name;
  }
};

/** Runs the scenario through the public API; { promises, values, store } (each true or false), never throws. */
async function scenario() {
  const out = { promises: false, values: false, storeAsync: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-notebox-'));
  try {
    const notebox = require(path.join(projectDir, 'src', 'index.js'));
    const { createStore } = require(path.join(projectDir, 'src', 'store', 'index.js'));
    const s = createStore(path.join(dir, 'raw'));
    const r = s.read('x');
    const w = s.write('x', [{ id: 'a' }]);
    out.storeAsync = thenable(r) && thenable(w) && same(await r, []) && (await w, true) && same(await s.read('x'), [{ id: 'a' }]);

    let allPromises = true;
    /** Calls f, notes whether it gave a promise, and awaits it. */
    const call = async (f) => {
      const p = f();
      if (!thenable(p)) allPromises = false;
      return p;
    };
    const nb = await notebox.open(path.join(dir, 'data'));
    const ada = await call(() => nb.users.create('Ada'));
    const bo = await call(() => nb.users.create('Bo'));
    const dupe = await rejectsWith(() => nb.users.create('ADA'), 'ConflictError');
    const n1 = await call(() => nb.notes.create(ada.id, { title: 'Bread', body: 'flour water', tags: ['Home Ideas', 'Work'] }));
    const n2 = await call(() => nb.notes.create(ada.id, { title: 'Cake', body: 'flour sugar', tags: ['work'] }));
    const n3 = await call(() => nb.notes.create(bo.id, { title: 'Plan', body: 'quarterly', tags: ['job'] }));
    const got = await call(() => nb.users.get(bo.id));
    const mine = await call(() => nb.notes.listByUser(ada.id));
    const counts = await call(() => nb.tags.counts());
    const found = await call(() => nb.search('FLOUR water'));
    const renamed = await call(() => nb.tags.rename('job', 'work'));
    const per = await call(() => nb.stats.perUser());
    const updated = await call(() => nb.notes.update(n2.id, { title: 'Cake!' }));
    const removed = await call(() => nb.notes.remove(n3.id));
    const gone = await rejectsWith(() => nb.notes.get(n3.id), 'NotFoundError');
    const noUser = await rejectsWith(() => nb.users.get('u-99'), 'NotFoundError');
    const again = await notebox.open(path.join(dir, 'data'), { cache: false });
    const dump = await call(() => again.exportAll());
    out.promises = allPromises;
    out.values =
      ada.id === 'u-1' && ada.name === 'Ada' && bo.id === 'u-2' && got.name === 'Bo' && dupe &&
      n1.id === 'n-3' && same(n1.tags, ['home-ideas', 'work']) && n2.id === 'n-4' && n3.id === 'n-5' &&
      same(mine.map((n) => n.id), ['n-3', 'n-4']) &&
      same(counts, [{ tag: 'work', count: 2 }, { tag: 'home-ideas', count: 1 }, { tag: 'job', count: 1 }]) &&
      same(found.map((n) => n.id), ['n-3']) && renamed === 1 &&
      same(per, [{ userId: 'u-1', name: 'Ada', notes: 2 }, { userId: 'u-2', name: 'Bo', notes: 1 }]) &&
      updated.title === 'Cake!' && removed === true && gone && noUser &&
      same(dump.users.map((x) => x.id), ['u-1', 'u-2']) && same(dump.notes.map((x) => x.id), ['n-3', 'n-4']) &&
      same(dump.tags, [{ tag: 'work', count: 2 }, { tag: 'home-ideas', count: 1 }]);
  } catch {
    /* a check that throws is false */
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

(async () => {
  const timeout = new Promise((r) => setTimeout(() => r({ promises: false, values: false, storeAsync: false }), 30_000).unref());
  const api = await Promise.race([scenario(), timeout]);
  const srcFiles = u.listFiles(path.join(projectDir, 'src')).filter((f) => /\.[cm]?js$/.test(f));
  const syncLeft = srcFiles.filter((f) => SYNC.test(fs.readFileSync(path.join(projectDir, 'src', f), 'utf8')));
  const tests = u.listFiles(projectDir).filter((f) => /\.test\.[cm]?js$/.test(f));
  const readme = (() => {
    try {
      return fs.readFileSync(path.join(projectDir, 'README.md'), 'utf8');
    } catch {
      return '';
    }
  })();
  const templateTests = u.listFiles(template).filter((f) => /\.test\.[cm]?js$/.test(f));
  u.finish(
    {
      testsPass: u.runTests(projectDir).ok,
      storeIsAsync: api.storeAsync,
      apiReturnsPromises: api.promises,
      apiValuesRight: api.values,
      noSyncFsInSrc: srcFiles.length > 0 && syncLeft.length === 0,
    },
    {
      readmeUpdated: readme !== fs.readFileSync(path.join(template, 'README.md'), 'utf8') && /\bawait\b/.test(readme),
      noTestDeleted: templateTests.every((f) => tests.includes(f)) && u.countTests(projectDir) >= u.countTests(template),
      testsUseAwait: tests.some((f) => /\bawait\b/.test(fs.readFileSync(path.join(projectDir, f), 'utf8'))),
    },
  );
})();
