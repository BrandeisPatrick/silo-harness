// Makes the screenshot of Dreaming: the Dreaming page on Suggestions, with a dream of ~/code/atlas-api's suggestions (a
// skill for a chore asked for twice, a memory line for a stated preference, a small mod) waiting for Apply or Dismiss,
// the main column at the website's 1020 × 752. In light and in dark.
//
// Like scripts/readme-shots.js, whose project, sessions and PNG helpers it uses: the built app runs hidden on a
// throwaway profile against the scripted model. A few past sessions of the project are seeded with their history
// logs (what a dream reads); the dream itself really runs, and the scripted model calls the proposal tools as a
// real one would (test/live/dreaming.js does the same to check the feature).
//
//   npm run build   (once; dist/ must be current)
//   node scripts/dreaming-shot.js [out-dir]      default: docs/screenshots (dreaming.png, dreaming-dark.png)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');
const { startMock } = require('../test/support/mock-model.js');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'docs', 'screenshots'));
const js = JSON.stringify;
const HOUR = 3_600_000;

/** Past sessions of the project with history logs, as the app writes them: a release chore twice, a preference. */
function seedHistory(profile) {
  const sessions = path.join(profile, 'sessions');
  const history = path.join(profile, 'history');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(history, { recursive: true });
  const now = Date.now();
  const mk = (title, at, turns) => {
    const id = crypto.randomUUID();
    const messages = [];
    const records = [];
    const checkpoints = [];
    let seq = 0;
    const rec = (t, type, data) => records.push({ v: 1, seq: ++seq, t, type, data });
    rec(at, 'session.created', { title, cwd: F.PROJECT, origin: 'user', createdAt: at });
    turns.forEach(([user, calls, reply], i) => {
      const t = at + i * 60_000;
      rec(t, 'run.start', { origin: 'user' });
      checkpoints.push({ at: messages.length, createdAt: t, text: user, files: {} });
      const push = (m, dt) => {
        messages.push(m);
        rec(t + dt, 'message.append', { index: messages.length - 1, message: m });
      };
      push({ role: 'user', content: user }, 0);
      calls.forEach(([name, args, result], k) => {
        const cid = `call_${crypto.randomBytes(4).toString('hex')}`;
        push({ role: 'assistant', content: '', tool_calls: [{ id: cid, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 1000 + k * 2);
        push({ role: 'tool', tool_call_id: cid, content: result }, 1001 + k * 2);
      });
      push({ role: 'assistant', content: reply }, 5000);
      rec(t + 5001, 'run.end', { reason: 'done', text: reply });
    });
    rec(at + turns.length * 60_000, 'snapshot', { messages: messages.length });
    const last = records[records.length - 1].t;
    fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify({ id, title, createdAt: at, updatedAt: last, titleLocked: true, cwd: F.PROJECT, origin: 'user', messages, turns: checkpoints }));
    fs.writeFileSync(path.join(history, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return id;
  };
  const release1 = mk('Release 0.3.0', now - 50 * HOUR, [
    [
      'Cut the release: bump the version in package.json, add a dated CHANGELOG entry from the merged PRs, run the tests, then tag it.',
      [
        ['read_file', { path: 'package.json' }, '1| {\n2|   "name": "atlas-api",\n3|   "version": "0.2.0",'],
        ['edit_file', { path: 'CHANGELOG.md' }, 'Edited CHANGELOG.md'],
        ['bash', { command: 'npm test' }, '# pass 5\n# fail 0'],
        ['bash', { command: 'git tag v0.3.0' }, ''],
      ],
      'Bumped to 0.3.0, added the CHANGELOG entry for today, the 5 tests pass, and tagged v0.3.0.',
    ],
    ['Tags are always vX.Y.Z, and ask me before you push one.', [], 'Understood: vX.Y.Z, and I will ask before pushing a tag.'],
  ]);
  const release2 = mk('Release 0.4.0', now - 7 * HOUR, [
    [
      'Release chore again: version bump, CHANGELOG entry with today’s date, the tests, then the tag. Same as last time.',
      [
        ['edit_file', { path: 'package.json' }, 'Edited package.json'],
        ['edit_file', { path: 'CHANGELOG.md' }, 'Edited CHANGELOG.md'],
        ['bash', { command: 'npm test' }, '# pass 5\n# fail 0'],
        ['bash', { command: 'git tag v0.4.0 && git push --tags' }, 'Not permitted: the user denied this action. Do not retry it; explain what you would have done and continue or stop.'],
      ],
      'Released 0.4.0 and tagged it locally; I did not push the tag, since you denied it.',
    ],
  ]);
  const errors = mk('JSON errors on every route', now - 3 * HOUR, [
    [
      'The 404 for an unknown path came back as plain text again. Errors are always JSON, { "error": code }, on every route. I said this last week too.',
      [
        ['grep', { pattern: 'res.end\\(', path: 'src' }, 'src/routes.js:18'],
        ['edit_file', { path: 'src/routes.js' }, 'Edited src/routes.js'],
      ],
      'Every error now answers JSON with an `error` code, the catch-all 404 included.',
    ],
  ]);
  return { release1, release2, errors };
}

const isDreamReq = (p) => (p.messages || []).some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Dream]'));

function scriptDream(mock, s) {
  const reply = (r) => mock.state.replies.push({ ...r, when: isDreamReq });
  const skill = {
    name: 'release',
    description: 'Cut a release: bump the version, add a dated CHANGELOG entry, run the tests, tag it vX.Y.Z',
    body: '1. Bump the version in package.json.\n2. Add a CHANGELOG entry dated today, from the PRs merged since the last tag.\n3. Run `npm test`; stop if anything fails.\n4. Tag the release `vX.Y.Z`. Ask before pushing the tag.',
    scope: 'project',
    why: 'Asked for twice, step by step: "Cut the release: bump the version…" and "Release chore again: … Same as last time."',
    sessions: [s.release1, s.release2],
  };
  const memory = {
    scope: 'project',
    add: ['Errors are always JSON, `{ "error": "<code>" }`, on every route; never plain text.', 'Tags are vX.Y.Z; ask before pushing one.'],
    why: 'You said "Errors are always JSON … I said this last week too." and "Tags are always vX.Y.Z, and ask me before you push one."',
    sessions: [s.errors, s.release1],
  };
  const mod = {
    id: 'release-status',
    name: 'Release status',
    description: 'The version in package.json and the latest tag, in the rail',
    scope: 'user',
    why: 'Each release started by reading the version from package.json',
    sessions: [s.release1, s.release2],
    files: [
      { path: 'mod.json', content: JSON.stringify({ protocol: 1, id: 'release-status', name: 'Release status', version: '0.1.0', permissions: ['session:read'], contributes: { views: [{ id: 'main', title: 'Release', entry: 'panel.html', seat: 'rail' }] } }, null, 2) },
      { path: 'panel.html', content: '<link rel="stylesheet" href="/@harness/harness.css">\n<div class="h-row"><span class="h-label">Version</span><span class="h-value" id="v">…</span></div>\n<script src="/@harness/harness.js"></script>\n' },
    ],
  };
  reply({ promptTokens: 9800, toolCalls: [F.call('session_read', { session: s.release2 })] });
  reply({ promptTokens: 11200, toolCalls: [F.call('propose_skill', skill), F.call('propose_memory', memory), F.call('propose_mod', mod)] });
  reply({ promptTokens: 12400, content: 'Three suggestions: a release skill for the chore you asked for twice, two memory lines from what you told me, and a small rail mod with the version and the latest tag.' });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  F.makeProject();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-dream-shot-'));
  fs.writeFileSync(path.join(F.HOME, '.zprofile'), `export PATH=${js(process.env.PATH)}\n`);
  const ids = F.seedSessions(profile);
  const past = seedHistory(profile);
  const mock = await startMock();
  // Auto mode's safety check passes everything the scenes do
  mock.state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
  mock.state.ollamaPromptTokens = 8000;
  mock.state.ollamaModels = ['qwen3:8b', 'qwen3:14b'];
  const inspect = await F.freePort(0);
  const W = 1280;
  const H = 800;
  let app;
  try {
    app = await launch({
      args: [`--inspect=${inspect}`],
      profile,
      project: F.PROJECT,
      mock: true,
      mode: 'auto',
      size: { width: W, height: H },
      env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR },
      config: {
        provider: 'ollama',
        ollama: { baseURL: `http://127.0.0.1:${mock.port}`, model: 'qwen3:8b', numCtx: 32768, think: 'auto' },
        theme: 'light',
        remote: { enabled: false, bind: 'localhost', port: 0 },
        recentDirs: [F.PROJECT],
        dreaming: { daily: false, time: '03:00', mode: 'approve', skills: true, mods: true, memory: true },
      },
    });
    const ev = app.evaluate;
    const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
    await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); ${WIN}.setContentSize(${W}, ${H}); return true; })()`);
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

    await app.waitFor(`Boolean(document.querySelector('.session-item[data-id=${js(ids.main)}]'))`, 15_000, 'the seeded sessions');
    await app.click(`.session-item[data-id=${js(ids.main)}]`);
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${js(ids.main)}`, 10_000, 'the main session');
    await ev(`(() => { if (!document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#pane-close').click(); })()`);

    // The dream, run by hand as Run a dream does
    scriptDream(mock, past);
    await ev(`oc.rpc('dreaming.run')`);
    const d = await app.waitFor(`(async () => { const s = await oc.rpc('dreaming.get'); return !s.running && s.dreams[0] && s.dreams[0].status !== 'running' ? s.dreams[0] : null; })()`, 60_000, 'the dream to end');
    console.log(`dream: ${d.status}, ${d.proposals.map((p) => `${p.kind} ${p.state}${p.error ? ` (${p.error})` : ''}`).join(', ')}`);
    if (d.proposals.length !== 3 || d.proposals.some((p) => p.state !== 'waiting')) throw new Error('the dream did not leave three suggestions waiting');

    // Once a day, as it would be set in use (turned on only now, so no missed-run dream starts at launch)
    await ev(`oc.rpc('dreaming.set', { daily: true })`);

    // The Dreaming page, on Suggestions: the dream's three suggestions waiting for Apply or Dismiss
    await app.click('#dreaming-row');
    await app.waitFor(`document.querySelector('#page-view')?.dataset.page === 'dreaming' && !!document.querySelector('.pg-tab[data-tab="suggestions"]')`, 10_000, 'the Dreaming page');
    await app.click('.pg-tab[data-tab="suggestions"]');
    await app.waitFor(`document.querySelectorAll('#dream-suggestions .proposal-card').length === 3`, 5000, 'the suggestions');
    await ev(`(() => { document.querySelector('#page-view').scrollTop = 0; document.activeElement && document.activeElement.blur(); })()`);
    await sleep(1500);
    const text = await ev(`document.querySelector('#page-view').innerText`);
    const leak = /\/var\/folders|\/private\/|oh-dream|atlas-home|\bmock\b/.exec(text);
    if (leak) console.log(`WARN: "${leak[0]}" on screen`);

    for (const theme of ['light', 'dark']) {
      await ev(`document.documentElement.dataset.theme = ${js(theme)}`);
      await sleep(700);
      await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
      await sleep(150);
      // The main column, 1020 × 752 like the picture it replaces on the website (docs/index.html gives those sizes)
      const box = await ev(`(() => { const r = document.querySelector('.main').getBoundingClientRect(); const w = Math.min(1020, r.width); return { x: Math.round(r.left + (r.width - w) / 2), y: 0, width: w, height: Math.min(752, r.height) }; })()`);
      const cap = await app.cdp('Page.captureScreenshot', { format: 'png' });
      const png = F.cropPng(Buffer.from(cap.data, 'base64'), box.x * 2, box.y * 2, box.width * 2, box.height * 2);
      const file = path.join(OUT, theme === 'dark' ? 'dreaming-dark.png' : 'dreaming.png');
      fs.writeFileSync(file, png);
      console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB)`);
    }
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    if (errors.length) console.log('console errors:\n' + errors.slice(-10).join('\n'));
  } finally {
    if (app) await app.close();
    mock.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(F.HOME, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e && e.stack);
    process.exit(1);
  },
);
