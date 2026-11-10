// Live prompt caching through the app: a tool loop on the native Anthropic path, then a mode switch and a rename in
// the middle of the session, with each model call's uncached input, cache writes and cache reads read back from the
// session's history log (usage records). Needs the API; the mock model reports no cache.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/prompt-cache.js
const fs = require('node:fs');
const path = require('node:path');
const { launch, checker } = require('./rig.js');

(async () => {
  const { check, done } = checker();
  const app = await launch({ mode: 'bypass' });
  const setMode = (mode) => app.evaluate(`(async () => { const c = await window.oc.getConfig(); await window.oc.setConfig({ ...c, permissionMode: ${JSON.stringify(mode)} }); })()`);
  /** Every usage record of the session so far, from its history log */
  const usage = () => {
    const dir = path.join(app.profile, 'history');
    const out = [];
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        try {
          const r = JSON.parse(line);
          if (r.type === 'usage') out.push(r.data);
        } catch {
          /* not a record */
        }
      }
    }
    return out;
  };
  const rows = [];
  const record = (label) => {
    const all = usage();
    for (const u of all.slice(rows.length)) {
      const read = u.cacheReadTokens ?? 0;
      const write = u.cacheWriteTokens ?? 0;
      rows.push({ label, prompt: u.promptTokens, uncached: u.promptTokens - read - write, write, read, out: u.completionTokens });
    }
  };
  try {
    if (!app.live) throw new Error('This pass needs ANTHROPIC_API_KEY (the mock model reports no cache).');
    fs.writeFileSync(path.join(app.project, 'a.txt'), 'The first code word is heron.\n');
    fs.writeFileSync(path.join(app.project, 'b.txt'), 'The second code word is otter.\n');

    await app.send('Use read_file on a.txt, then read_file on b.txt (one call at a time), then list_directory on ".", then reply with both code words.');
    await app.waitIdle(120_000);
    record('tool loop');
    const loop = rows.filter((r) => r.label === 'tool loop');
    check('a tool loop of at least four model calls', loop.length >= 4, loop.length);
    check('every call after the first reads the cache', loop.slice(1).every((r) => r.read > 0), loop);
    check('the first call writes the prefix to the cache', loop[0].write > 1000, loop[0]);

    await setMode('auto');
    await app.send('Read a.txt again with read_file and repeat the first code word.');
    await app.waitIdle(120_000);
    record('after mode switch');
    const afterMode = rows.filter((r) => r.label === 'after mode switch');
    check('after the switch to Auto mode the first call still reads the whole earlier prefix', afterMode.length >= 1 && afterMode[0].read >= loop[loop.length - 1].read, afterMode);

    await app.click('#session-title');
    await app.evaluate(`(() => { const t = document.querySelector('#session-title'); t.textContent = 'Cache check'; })()`);
    await app.key('Enter');
    await app.waitFor(`document.querySelector('.session-item.active .label')?.innerText === 'Cache check'`, 5000, 'the new title');
    await setMode('bypass');
    await app.send('Read b.txt again with read_file and repeat the second code word.');
    await app.waitIdle(120_000);
    record('after rename + back to bypass');
    const afterRename = rows.filter((r) => r.label === 'after rename + back to bypass');
    check('after the rename (and leaving Auto mode) the first call still reads the earlier prefix', afterRename.length >= 1 && afterRename[0].read >= afterMode[afterMode.length - 1].read, afterRename);
    check('the replies are right', /otter/i.test(await app.lastReply()));
    console.log('\ncall\twhen\tprompt\tuncached\twrite\tread\toutput');
    rows.forEach((r, i) => console.log(`${i + 1}\t${r.label}\t${r.prompt}\t${r.uncached}\t${r.write}\t${r.read}\t${r.out}`));
    const prompt = rows.reduce((a, r) => a + r.prompt, 0);
    const read = rows.reduce((a, r) => a + r.read, 0);
    console.log(`read from cache: ${read} of ${prompt} input tokens (${Math.round((read / prompt) * 100)}%)`);
  } catch (err) {
    check(`no crash: ${err.message}`, false);
  } finally {
    await app.close();
  }
  done();
})();
