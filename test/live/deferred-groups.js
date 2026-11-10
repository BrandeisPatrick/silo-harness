// Live tool groups on the native Anthropic path: a session loads two groups one after the other and calls a tool of
// each; the request's tools never change (the groups' tools are deferred and a load references them), so the call
// after each load reads the whole earlier prefix from the cache. Per-call usage from the session's history log.
// Needs the API.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/deferred-groups.js
const fs = require('node:fs');
const path = require('node:path');
const { launch, checker } = require('./rig.js');

(async () => {
  const { check, done } = checker();
  const app = await launch({ mode: 'bypass' });
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
  /** The names of the tools that ran, from the history log */
  const ran = () => {
    const dir = path.join(app.profile, 'history');
    const out = [];
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        try {
          const r = JSON.parse(line);
          if (r.type === 'tool.end') out.push(`${r.data.name}:${r.data.ok}`);
        } catch {
          /* not a record */
        }
      }
    }
    return out;
  };
  try {
    if (!app.live) throw new Error('This pass needs ANTHROPIC_API_KEY.');
    await app.send('Say hello in three words.');
    await app.waitIdle(120_000);
    record('start');
    await app.send('Call load_tools with groups ["terminal"]. Then call terminal_list. Then say what it returned in one line.');
    await app.waitIdle(120_000);
    record('load terminal');
    await app.send('Call load_tools with groups ["sessions"]. Then call session_list. Then say how many sessions there are in one line.');
    await app.waitIdle(120_000);
    record('load sessions');
    const names = ran();
    check('the model called the loaded tools: terminal_list and session_list ran', names.some((n) => n.startsWith('terminal_list:true')) && names.some((n) => n.startsWith('session_list:true')), names);
    // After each load, the next call reads everything the call before it sent
    let ok = rows.length >= 5;
    for (let i = 1; i < rows.length; i++) if (rows[i].read < rows[i - 1].prompt - 8) ok = false;
    check('every call reads the whole prefix of the call before it from the cache (no rebuild at a load)', ok, rows.map((r) => [r.label, r.prompt, r.write, r.read]));
    console.log('\ncall\twhen\tprompt\tuncached\twrite\tread\toutput');
    rows.forEach((r, i) => console.log(`${i + 1}\t${r.label}\t${r.prompt}\t${r.uncached}\t${r.write}\t${r.read}\t${r.out}`));
  } catch (err) {
    check(`no crash: ${err.message}`, false);
  } finally {
    await app.close();
  }
  done();
})();
