// Live check of reads behind a leading cd in Auto mode, in the real window with the mock model scripted: one reply
// with two `cd sub && cat …` calls runs both, together (each one's one-second PostToolUse hook overlaps the other's),
// and the mock model receives no safety-check request; `cd sub && rm …` still goes to the check (here it blocks); the
// bash tool's path runs a read in that folder without the check, its row shows the folder, and a card for a call by
// path shows the folder too; edit_file with a list of edits makes them in one call, its row showing every change.
// Run: npm run build && node test/live/cd-reads.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker } = require('./rig.js');
const { classifierReply, isClassifierRequest } = require('../support/mock-model.js');

const { check, done } = checker();

const userSays = (marker) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  return !!m && m.role === 'user' && JSON.stringify(m.content).includes(marker);
};
const afterTool = (id) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  return !!m && m.role === 'tool' && (payload.messages ?? []).some((x) => x.role === 'tool' && x.tool_call_id === id);
};
const sh = (id, args) => ({ id, name: 'bash', args });

function setUp() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-cd-profile-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-cd-project-'));
  const home = path.join(profile, 'home-config');
  fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
  const log = path.join(profile, 'post-log.jsonl');
  // A Bash call's PostToolUse hook takes a second and logs when it started and ended: two that overlap ran together
  const hook = path.join(home, 'hooks', 'slow.sh');
  fs.writeFileSync(hook, `#!/bin/sh\ninput=$(cat)\nt0=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')\nsleep 1\nt1=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')\nprintf '{"t0":%s,"t1":%s,"input":%s}\\n' "$t0" "$t1" "$input" >> "${log}"\n`);
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hook, timeout: 30 }] }] } }, null, 2));
  fs.mkdirSync(path.join(project, 'sub'));
  fs.writeFileSync(path.join(project, 'sub', 'a.txt'), 'made-up A-MARKER\n');
  fs.writeFileSync(path.join(project, 'sub', 'b.txt'), 'made-up B-MARKER\n');
  return { profile, project, log };
}

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-cd-'));
  fs.mkdirSync(shots, { recursive: true });
  const { profile, project, log } = setUp();
  const sub = path.join(project, 'sub');
  const app = await launch({ mode: 'auto', mock: true, profile, ownsProfile: true, project, config: { theme: 'light' } });
  const { replies, requests } = app.mock.state;
  const checks = () => requests.filter((r) => isClassifierRequest(r.payload)).length;
  const result = (id) => requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';
  const logged = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const rows = () => app.evaluate(`[...document.querySelectorAll('#messages .tool[data-tool="bash"]')].filter((e) => !e.hidden).map((e) => e.querySelector('.tool-arg')?.textContent ?? '')`);
  try {
    if (await app.evaluate(`!document.querySelector('.shell').classList.contains('pane-hidden')`)) await app.click('#pane-toggle').catch(() => undefined);

    // ---------- 1. Two reads behind cd in one reply: both run, together, no check ----------
    const before = checks();
    replies.push({ content: '', toolCalls: [sh('c1', { command: 'cd sub && cat a.txt' }), sh('c2', { command: 'cd sub && cat b.txt' })], when: userSays('Read both') });
    replies.push({ content: 'Read both files.', when: afterTool('c2') });
    const t0 = Date.now();
    await app.send('Read both files in sub');
    await app.waitIdle(30_000);
    const took = Date.now() - t0;
    check('two cd reads: both ran, each its own result', /A-MARKER/.test(result('c1')) && /B-MARKER/.test(result('c2')), { c1: result('c1'), c2: result('c2') });
    check('…the mock model got no safety-check request', checks() === before, { checks: checks(), before });
    const runs = logged().filter((e) => ['c1', 'c2'].includes(e.input.tool_use_id));
    const overlap = runs.length === 2 && Math.max(runs[0].t0, runs[1].t0) < Math.min(runs[0].t1, runs[1].t1);
    check('…together: their one-second hooks overlapped', overlap, { runs: runs.map((e) => [e.input.tool_use_id, e.t0, e.t1]), took });
    check('…no card, no blocked line', !(await app.exists('.approval')) && !(await app.exists('#messages .auto-blocked')));
    const shown1 = await rows();
    check('…two rows, each with its cd', shown1.length === 2 && shown1[0].includes('cd sub && cat a.txt') && shown1[1].includes('cd sub && cat b.txt'), shown1);
    await app.screenshot(path.join(shots, 'cd-reads-1-together.png'));

    // ---------- 2. A change behind cd still goes to the check ----------
    const before2 = checks();
    replies.push({ content: '', toolCalls: [sh('r1', { command: 'cd sub && rm a.txt' })], when: userSays('Remove a') });
    replies.push(classifierReply('block', '[Other] deletes a file the user asked to keep'));
    replies.push({ content: 'Blocked, so I kept it.', when: afterTool('r1') });
    await app.send('Remove a.txt in sub');
    await app.waitIdle(30_000);
    check('cd sub && rm a.txt: went to the check', checks() === before2 + 1, { checks: checks(), before2 });
    check('…blocked: the file is still there, the agent read why', fs.existsSync(path.join(sub, 'a.txt')) && /^Blocked by Auto mode/.test(result('r1')), result('r1'));
    const blocked = await app.evaluate(`[...document.querySelectorAll('#messages .auto-blocked')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`);
    check('…one quiet line naming the command', blocked.length === 1 && blocked[0].includes('cd sub && rm a.txt'), blocked);

    // ---------- 3. The bash tool's path: a read in that folder, no check, the folder on its row ----------
    const before3 = checks();
    replies.push({ content: '', toolCalls: [sh('p1', { command: 'cat b.txt', path: 'sub' })], when: userSays('By path') });
    replies.push({ content: 'Read it.', when: afterTool('p1') });
    await app.send('By path: read b.txt in sub');
    await app.waitIdle(30_000);
    check('path: cat b.txt in sub ran, without the check', /B-MARKER/.test(result('p1')) && checks() === before3, { result: result('p1'), checks: checks(), before3 });
    const shown3 = await rows();
    check('path: its row shows the folder', shown3[shown3.length - 1] === 'cd sub && cat b.txt', shown3);

    // ---------- 4. A card for a call by path shows the folder ----------
    replies.push({ content: '', toolCalls: [sh('s1', { command: 'sudo -n true', path: 'sub' })], when: userSays('Sudo') });
    replies.push({ content: 'Denied, fine.', when: afterTool('s1') });
    await app.send('Sudo in sub');
    await app.waitFor(`Boolean(document.querySelector('.approval:not(.decided)'))`, 15_000, 'the sudo card');
    const cardText = await app.evaluate(`document.querySelector('.approval:not(.decided) .cmd code')?.textContent ?? ''`);
    check('path: the card shows cd <folder> && the command', cardText === `cd '${sub}' && sudo -n true`, cardText);
    await app.screenshot(path.join(shots, 'cd-reads-4-card.png'));
    await app.evaluate(`[...document.querySelectorAll('.approval:not(.decided) button')].find((b) => /^Deny/.test(b.textContent.trim()))?.click()`);
    await app.waitIdle(30_000);
    check('path: denied, the agent was told', /^Not permitted: the user denied/.test(result('s1')), result('s1'));

    // ---------- 5. Several edits in one call: one row, every change in its diff ----------
    fs.writeFileSync(path.join(project, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    replies.push({ content: '', toolCalls: [{ id: 'e1', name: 'edit_file', args: { path: 'notes.txt', edits: [{ old_string: 'two', new_string: 'TWO' }, { old_string: 'five', new_string: 'FIVE' }] } }], when: userSays('Two edits') });
    replies.push({ content: 'Edited.', when: afterTool('e1') });
    await app.send('Two edits to notes.txt');
    await app.waitIdle(30_000);
    check('edits: both made, in one call', fs.readFileSync(path.join(project, 'notes.txt'), 'utf8') === 'one\nTWO\nthree\nfour\nFIVE\n' && /\(2 edits, 2 replacements\)/.test(result('e1')), result('e1'));
    const editRow = await app.evaluate(`(() => { const r = [...document.querySelectorAll('#messages .tool[data-tool="edit_file"]')].pop(); return r ? { meta: r.querySelector('.tool-meta')?.textContent ?? '', lines: [...r.querySelectorAll('.diff .line')].map((l) => l.textContent) } : null; })()`);
    check('edits: the row shows every change (+2 −2)', editRow && editRow.meta.includes('+2') && editRow.meta.includes('−2') && ['two', 'TWO', 'five', 'FIVE'].every((t) => editRow.lines.some((l) => l.endsWith(t))), editRow);
    await app.click('#messages .tool[data-tool="edit_file"] .tool-summary').catch(() => undefined);
    await app.screenshot(path.join(shots, 'cd-reads-5-edits.png'));
  } catch (err) {
    check(`no crash: ${err.message}`, false);
  } finally {
    await app.close();
  }
  // (the exit code says whether a check failed: the runner reads only that)
  process.exit(done() ? 1 : 0);
})();
