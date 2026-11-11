// Live check of a reply's tool calls running together in the real window, with the mock model scripted: three reads
// whose PostToolUse hook takes a second each finish in about one second and go back in call order; toolConcurrency 1
// takes three; an edit between two reads waits for the first and holds the second; two reads that each need a card
// show the cards one after another, each on its own row; Stop during a group ends all of it and the next message
// works; /timing answers locally; in Auto mode two blocked reads in a group get two quiet lines, the plain read runs.
// Run: npm run build && node test/live/tool-concurrency.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const { check, done } = checker();

const userSays = (marker) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  return !!m && m.role === 'user' && JSON.stringify(m.content).includes(marker);
};
const afterTool = (id) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  return !!m && m.role === 'tool' && (payload.messages ?? []).some((x) => x.role === 'tool' && x.tool_call_id === id);
};
const read = (id, file) => ({ id, name: 'read_file', args: { path: file } });

function setUp() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-conc-profile-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-conc-project-'));
  const home = path.join(profile, 'home-config');
  fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
  const log = path.join(project, 'post-log.jsonl');
  const script = (name, body) => {
    const f = path.join(home, 'hooks', name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(f, 0o755);
    return f;
  };
  // A read's PostToolUse hook takes a second; an edit's logs at once. Each appends its input: the order they ended
  const slow = script('slow.sh', `sleep 1\ncat >> "${log}"\necho >> "${log}"`);
  const quick = script('quick.sh', `cat >> "${log}"\necho >> "${log}"`);
  const settings = { hooks: { PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: slow, timeout: 30 }] }, { matcher: 'Edit', hooks: [{ type: 'command', command: quick, timeout: 30 }] }] } };
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings, null, 2));
  for (const n of ['follow-1', 'follow-2']) fs.writeFileSync(path.join(project, `${n}.txt`), 'made-up\n');
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(project, `${n}.txt`), `made-up ${n}\n`);
  fs.writeFileSync(path.join(project, '.env'), 'TOKEN=made-up\n');
  fs.writeFileSync(path.join(project, 'k.pem'), 'made-up key\n');
  return { profile, project, log };
}

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-conc-'));
  fs.mkdirSync(shots, { recursive: true });
  const { profile, project, log } = setUp();
  const app = await launch({ mock: true, mode: 'ask', profile, ownsProfile: true, project, config: { theme: 'light', allowRules: { [project]: { programs: ['tail'], edits: true } } } });
  const { replies, requests } = app.mock.state;
  const toolIds = () => {
    const last = requests.filter((r) => r.payload.stream).pop();
    return (last?.payload.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  };
  const result = (id) => requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';
  const logged = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).tool_use_id);
  const setConcurrency = (n) => app.evaluate(`(async () => { const c = await window.oc.getConfig(); if (${n === null}) delete c.toolConcurrency; else c.toolConcurrency = ${n}; await window.oc.setConfig(c); return (await window.oc.getConfig()).toolConcurrency ?? null; })()`);
  const timed = async (fn) => {
    const t0 = Date.now();
    await fn();
    return Date.now() - t0;
  };
  try {
    if (await app.evaluate(`!document.querySelector('.shell').classList.contains('pane-hidden')`)) await app.click('#pane-toggle').catch(() => undefined);

    // ---------- 1. Three reads together ----------
    replies.push({ content: '', toolCalls: [read('r1', 'a.txt'), read('r2', 'b.txt'), read('r3', 'c.txt')], when: userSays('Read three') });
    replies.push({ content: 'Read all three.', when: afterTool('r3') });
    const together = await timed(async () => {
      await app.send('Read three files');
      await app.waitIdle(30_000);
    });
    check('three reads with a one-second hook each finish in about one second', together < 2600, `${together} ms`);
    check('…their results went back in call order, each its own', toolIds().join() === 'r1,r2,r3' && /made-up a/.test(result('r1')) && /made-up b/.test(result('r2')) && /made-up c/.test(result('r3')), toolIds());
    check('…three rows, all finished', (await app.evaluate(`document.querySelectorAll('#messages .tool[data-tool="read_file"]').length`)) === 3 && !(await app.exists('#messages .tool .tool-status.spin')));
    await app.screenshot(path.join(shots, 'concurrency-1-three-reads.png'));

    // ---------- 2. /timing: a local note, never sent ----------
    const before = requests.length;
    await app.send('/timing');
    await app.waitFor(`[...document.querySelectorAll('#messages .msg.system')].some((e) => / · model .* · tools /.test(e.innerText))`, 10_000, 'the /timing note');
    const note = await app.evaluate(`[...document.querySelectorAll('#messages .msg.system')].map((e) => e.innerText).filter((t) => / · model /.test(t)).pop()`);
    check('/timing shows the last run: model, tools (3 calls), other, and the slowest turn', /^\S+ · model \S+ \(2 turns: waiting .+, thinking .+, writing .+\) · tools \S+ \(3 calls\) · .*other \S+/.test(note) && /Slowest turn: #\d/.test(note), note);
    check('…and nothing went to the model', requests.length === before);

    // ---------- 3. toolConcurrency 1: one after another ----------
    check('toolConcurrency 1 is taken', (await setConcurrency(1)) === 1);
    replies.push({ content: '', toolCalls: [read('s1', 'a.txt'), read('s2', 'b.txt'), read('s3', 'c.txt')], when: userSays('Read again') });
    replies.push({ content: 'Again.', when: afterTool('s3') });
    fs.rmSync(log, { force: true });
    const serial = await timed(async () => {
      await app.send('Read again, one by one');
      await app.waitIdle(30_000);
    });
    check('…the same three reads take three seconds, ended in call order', serial >= 3000 && logged().join() === 's1,s2,s3', { ms: serial, order: logged() });
    check("…and back to 4", (await setConcurrency(4)) === 4);

    // ---------- 4. An edit between reads is a barrier ----------
    fs.rmSync(log, { force: true });
    replies.push({ content: '', toolCalls: [read('d1', 'a.txt'), { id: 'd2', name: 'edit_file', args: { path: 'a.txt', old_string: 'made-up a', new_string: 'edited a' } }, read('d3', 'a.txt')], when: userSays('Edit between') });
    replies.push({ content: 'Edited.', when: afterTool('d3') });
    await app.send('Edit between two reads');
    await app.waitIdle(30_000);
    check('the edit ended after the read before it, the read after it after the edit', logged().join() === 'd1,d2,d3', logged());
    check('…the read after the edit saw it', /edited a/.test(result('d3')) && /made-up a/.test(result('d1')), result('d3'));
  } catch (err) {
    check(`no crash: ${err.message}`, false);
  }

  try {
    // ---------- 5. Two cards, one at a time, each on its own row ----------
    replies.push({ content: '', toolCalls: [read('k1', '.env'), read('k2', 'k.pem'), read('k3', 'b.txt')], when: userSays('Secrets') });
    replies.push({ content: 'Read the secrets.', when: afterTool('k3') });
    await app.send('Secrets please');
    await app.waitFor(`document.querySelectorAll('.approval:not(.decided)').length > 0`, 15_000, 'the first card');
    await sleep(400);
    const open1 = await app.evaluate(`document.querySelectorAll('.approval:not(.decided)').length`);
    const title1 = await app.evaluate(`document.querySelector('.approval:not(.decided)').innerText`);
    await app.screenshot(path.join(shots, 'concurrency-5-first-card.png'));
    await app.approve('allow');
    await app.waitFor(`[...document.querySelectorAll('.approval:not(.decided)')].some((c) => /k\\.pem/.test(c.innerText))`, 15_000, 'the second card');
    const open2 = await app.evaluate(`document.querySelectorAll('.approval:not(.decided)').length`);
    await app.approve('allow');
    await app.waitIdle(30_000);
    check('two cards, one at a time, in call order', open1 === 1 && open2 === 1 && /\.env/.test(title1), { open1, open2, title1 });
    const decided = await app.evaluate(`['k1', 'k2'].map((id) => (document.querySelector('.tool[data-call-id="' + id + '"] .tool-decision')?.textContent ?? '').trim())`);
    check('…each answer is on its own call\'s row', decided.every((d) => /Allowed/.test(d)), decided);
    check('…both reads ran after their cards', /TOKEN=made-up/.test(result('k1')) && /made-up key/.test(result('k2')) && /made-up b/.test(result('k3')));

    // ---------- 6. Stop during a group ----------
    replies.push({ content: '', toolCalls: [{ id: 'x1', name: 'bash', args: { command: 'tail -f follow-1.txt' } }, { id: 'x2', name: 'bash', args: { command: 'tail -f follow-2.txt' } }, read('x3', 'c.txt')], when: userSays('Follow') });
    await app.send('Follow both files');
    // The commands ask unless the project's rule for tail applies here: cards, one at a time, are answered as they come
    let cards = 0;
    for (const until = Date.now() + 20_000; ; ) {
      if ((await app.evaluate(`document.querySelectorAll('#messages .tool[data-tool="bash"] .tool-status.spin').length`)) === 2 && !(await app.exists('.approval:not(.decided)'))) break;
      if (await app.exists('.approval:not(.decided) .btn')) {
        cards++;
        await app.approve('allow');
      }
      if (Date.now() > until) throw new Error(`both commands never ran: ${JSON.stringify(await app.evaluate(`[...document.querySelectorAll('#messages > *')].slice(-6).map((e) => e.className + ' :: ' + (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 120))`))} ${requests.filter((r) => r.payload.stream).length} requests`);
      await sleep(150);
    }
    console.log(`  (the two commands asked ${cards} card${cards === 1 ? '' : 's'})`);
    await sleep(300);
    const stopAt = Date.now();
    await app.click('#send-btn');
    await app.waitIdle(15_000, false);
    const stopMs = Date.now() - stopAt;
    check('Stop during a group ends all of it', stopMs < 5000 && !(await app.exists('#messages .tool .tool-status.spin')), `${stopMs} ms`);
    replies.push({ content: 'Still here.', when: userSays('After the stop') });
    await app.send('After the stop');
    await app.waitIdle(30_000);
    check('…the next message works, and its request answers every call', /Still here/.test(await app.lastReply()) && ['x1', 'x2', 'x3'].every((id) => toolIds().includes(id)), toolIds());
    const left = require('node:child_process').spawnSync('pgrep', ['-f', 'tail -f follow-[12].txt'], { encoding: 'utf8' }).stdout.trim();
    check('…no tail is left running', left === '', left);
    await app.screenshot(path.join(shots, 'concurrency-6-stopped.png'));
  } catch (err) {
    check(`no crash: ${err.message}`, false);
  } finally {
    await app.close();
  }

  // ---------- 7. Auto mode: two blocked reads in a group ----------
  const project2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-conc-auto-'));
  fs.writeFileSync(path.join(project2, 'a.txt'), 'made-up a\n');
  fs.writeFileSync(path.join(project2, '.env'), 'TOKEN=made-up\n');
  fs.writeFileSync(path.join(project2, 'k.pem'), 'made-up key\n');
  const auto = await launch({ mode: 'auto', mock: true, project: project2 });
  try {
    const st = auto.mock.state;
    st.classifierDefault = { decision: 'block', reason: '[Secrets] reads a key (made-up)' };
    st.replies.push({ content: '', toolCalls: [read('b1', 'k.pem'), read('b2', 'a.txt'), read('b3', '.env')], when: userSays('Auto group') });
    st.replies.push({ content: 'Some were blocked.', when: afterTool('b3') });
    await auto.send('Auto group of reads');
    await auto.waitIdle(30_000);
    const lines = await auto.evaluate(`[...document.querySelectorAll('#messages .auto-blocked')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`);
    const res = (id) => st.requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';
    check('Auto mode: the two secret reads are blocked, one quiet line each, no card', lines.length === 2 && !(await auto.exists('.approval')), lines);
    check('…the plain read beside them ran', /made-up a/.test(res('b2')) && /^Blocked by Auto mode/.test(res('b1')) && /^Blocked by Auto mode/.test(res('b3')));
    await auto.screenshot(path.join(shots, 'concurrency-7-auto.png'));
  } catch (err) {
    check(`no crash (auto): ${err.message}`, false);
  } finally {
    await auto.close();
  }
  process.exit(done() ? 1 : 0);
})();
