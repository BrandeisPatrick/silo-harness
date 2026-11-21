// Live check of hooks in the real window, with the mock model scripted to call tools: a PreToolUse command hook that
// blocks rm (a notice in the transcript, the file survives), a PostToolUse hook that appends to a log file (with a
// statusMessage in the status line while it runs), a UserPromptSubmit hook whose stdout reaches the model, a Stop hook
// that sends the run back once, the fixture mod (test/fixtures/hooks-mod) whose worker view asks before every read
// (the approval card appears, even in bypass mode), and Settings → Developer → Hooks listing them and their runs.
// Screenshots (light and dark, scale 2): Settings → Developer → Hooks and the hook notice in the transcript, into $SHOTS.
// Run: npm run build && node test/live/hooks.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-hooks-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const { check, done } = checker();
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'hooks-mod');

/** The last user message that is not a hook's note contains the marker, and nothing came after the model's turn. */
const userAsked = (marker) => (payload) => {
  const msgs = payload.messages ?? [];
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') return false;
  const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') return false;
    if (!text(msgs[i]).startsWith('[Hook ')) return text(msgs[i]).includes(marker);
  }
  return false;
};
const lastHas = (marker) => (payload) => {
  const m = payload.messages?.[payload.messages.length - 1];
  return !!m && JSON.stringify(m.content).includes(marker);
};

function setUp() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-hooks-profile-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-hooks-project-'));
  const home = path.join(profile, 'home-config');
  const hooksDir = path.join(home, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const script = (name, body) => {
    const f = path.join(hooksDir, name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(f, 0o755);
    return f;
  };
  const log = path.join(project, 'hook-log.jsonl');
  const blockRm = script('block-rm.sh', `cat > /dev/null\necho 'Blocked: rm is not allowed in this project' >&2\nexit 2`);
  const logCall = script('log-call.sh', `sleep 1.5\ncat >> "${log}"\necho >> "${log}"`);
  const stopOnce = script('stop-once.sh', `input=$(cat)\ncase "$input" in *'"stop_hook_active":true'*) exit 0;; esac\necho 'Say DONE-AGAIN before you stop' >&2\nexit 2`);
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', if: 'Bash(rm *)', command: blockRm, timeout: 30 }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: logCall, statusMessage: 'Logging the call…' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: "echo 'Hook note: the codename is MARMOT'" }] }],
      Stop: [{ hooks: [{ type: 'command', command: stopOnce }] }],
    },
  };
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.cpSync(FIXTURE, path.join(home, 'mods', 'hooks-mod'), { recursive: true });
  fs.writeFileSync(path.join(project, 'victim.txt'), 'still here\n');
  return { profile, project, log };
}

const notices = (app) => app.evaluate(`[...document.querySelectorAll('#messages .msg.system')].map((e) => e.innerText.trim())`);
const setTheme = (app, scheme) => app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = ${JSON.stringify(scheme)}; await window.oc.setConfig(c); document.documentElement.dataset.theme = ${JSON.stringify(scheme)}; })()`);

(async () => {
  const { profile, project, log } = setUp();
  const app = await launch({
    mock: true,
    mode: 'bypass',
    profile,
    ownsProfile: true,
    project,
    config: { theme: 'light', mods: { enabled: { 'hooks-mod': { permissions: ['hooks'], styles: false, at: 1 } }, disabledBundled: [], settings: {}, safeMode: false } },
  });
  const replies = app.mock.state.replies;
  const requests = app.mock.state.requests;
  try {
    await app.waitFor(`window.__oc_debug && window.__oc_debug.mods && window.__oc_debug.mods.views().some((v) => v.view === 'worker' && v.hello && v.hooks.includes('PreToolUse'))`, 20_000, 'the fixture worker to register its hook');
    const views = await app.evaluate('window.__oc_debug.mods.views()');
    const worker = views.find((v) => v.view === 'worker');
    const panel = views.find((v) => v.view === 'panel');
    check('the worker view is loaded in a hidden frame and registered PreToolUse', worker && worker.seat === 'worker' && worker.hello && !worker.visible && worker.hooks.includes('PreToolUse'), views);
    check('the rail view registered too', panel && panel.hooks.includes('PreToolUse'));
    check('the worker frame has no place in the window', await app.evaluate(`(() => { const w = document.getElementById('mod-workers'); return !!w && w.hidden && w.getBoundingClientRect().height === 0; })()`));

    // 1. PreToolUse blocks rm; the Stop hook sends the run back once
    replies.push({ content: '', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'rm victim.txt' } }], when: userAsked('[rm]') });
    replies.push({ content: 'I could not remove it.', when: (p) => JSON.stringify(p.messages.slice(-1)).includes('hook error') });
    replies.push({ content: 'DONE-AGAIN', when: lastHas('Say DONE-AGAIN') });
    await app.send('Please remove victim.txt [rm]');
    await app.waitIdle(60_000);
    const fileStays = fs.existsSync(path.join(project, 'victim.txt'));
    const toolMsg = requests.flatMap((r) => r.payload.messages ?? []).find((m) => m.role === 'tool' && /hook error/.test(String(m.content)));
    check('PreToolUse: rm is blocked and the file survives', fileStays, fileStays);
    check('PreToolUse: the model reads Claude Code\'s wording', toolMsg && /^PreToolUse:Bash hook error: \[.*block-rm\.sh\]: Blocked: rm is not allowed in this project$/.test(toolMsg.content), toolMsg?.content);
    const n1 = await notices(app);
    check('the transcript shows a quiet notice that a hook blocked the call', n1.some((t) => t === 'A PreToolUse hook blocked bash: Blocked: rm is not allowed in this project'), n1);
    // The blocked call reads as denied: one line "Denied a command"; opened, its row says denied with the hook's words
    const blocked = await app.evaluate(`(() => {
      const row = [...document.querySelectorAll('#messages .tool[data-tool="bash"]')].find((r) => /rm victim\\.txt/.test(r.querySelector('.tool-arg')?.textContent ?? ''));
      const g = row?.closest('.tool-group');
      return row ? { line: g?.querySelector(':scope > summary .group-verb').textContent, meta: row.querySelector('.tool-meta').textContent, body: row.querySelector('.tool-body').textContent, denied: row.classList.contains('denied') } : null;
    })()`).catch(() => null);
    check('the blocked call reads as denied: one line "Denied a command", its row denied with the hook\'s words', blocked && blocked.line === 'Denied a command' && blocked.denied && /^denied/.test(blocked.meta) && /hook error/.test(blocked.body) && /Blocked: rm is not allowed/.test(blocked.body), blocked);
    check('Stop (exit 2) sent the run back once with the reason', requests.some((r) => lastHas('Say DONE-AGAIN')(r.payload)) && n1.some((t) => t === 'A Stop hook sent the model back to work: Say DONE-AGAIN before you stop'), n1);
    check('… and the run ended after that (no second round)', requests.filter((r) => lastHas('Say DONE-AGAIN')(r.payload)).length === 1);
    check('UserPromptSubmit: the hook\'s stdout reached the model', requests.some((r) => JSON.stringify(r.payload.messages).includes('the codename is MARMOT')));
    await app.screenshot(path.join(SHOTS, 'notice-light.png'));
    await setTheme(app, 'dark');
    await sleep(300);
    await app.screenshot(path.join(SHOTS, 'notice-dark.png'));
    await setTheme(app, 'light');

    // 2. PostToolUse appends to a log, with its statusMessage in the status line meanwhile
    replies.push({ content: '', toolCalls: [{ id: 'c2', name: 'bash', args: { command: 'echo hi' } }], when: userAsked('[ls]') });
    replies.push({ content: 'Listed.', when: (p) => p.messages.slice(-1)[0]?.role === 'tool' });
    await app.send('Say hi [ls]');
    const statusSeen = await app.waitFor(`(document.getElementById('status-text')?.textContent || '').includes('Logging the call')`, 15_000, 'the statusMessage').catch(() => false);
    const statusLines = await app.evaluate(`(() => { const t = document.getElementById('status-text'); if (!t) return 0; const r = t.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(t).lineHeight) || 16; return Math.round(r.height / lh); })()`);
    check('the status line says the hook\'s statusMessage while it runs', !!statusSeen);
    check('… on one line', statusLines <= 1, statusLines);
    await app.waitIdle(60_000);
    const logged = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    check('PostToolUse: the hook appended the call to its log file', logged.length === 1 && logged[0].tool_name === 'Bash' && logged[0].tool_input.command === 'echo hi' && /hi/.test(logged[0].tool_response) && logged[0].hook_event_name === 'PostToolUse', logged);
    check('PostToolUse: the blocked rm was never logged (it did not run)', !logged.some((l) => /rm/.test(l.tool_input.command)));

    // 3. The fixture mod's worker asks before every read: the card appears even in bypass mode
    replies.push({ content: '', toolCalls: [{ id: 'c3', name: 'read_file', args: { path: 'victim.txt' } }], when: userAsked('[read]') });
    replies.push({ content: 'It says still here.', when: (p) => p.messages.slice(-1)[0]?.role === 'tool' });
    await app.send('Read victim.txt [read]');
    await app.waitFor(`Boolean(document.querySelector('.approval:not(.decided)'))`, 20_000, 'the approval card');
    const cardText = await app.evaluate(`[...document.querySelectorAll('.approval')].pop().innerText`);
    check('the mod\'s PreToolUse "ask" brings up the approval card (in bypass mode)', /read/i.test(cardText), cardText);
    check('… with the mod\'s reason', /The hooks fixture asks before every read/.test(cardText), cardText);
    await app.approve('allow');
    await app.waitIdle(60_000);
    const readResult = requests.flatMap((r) => r.payload.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content)).find((c) => /still here/.test(c));
    check('once allowed, the read runs', !!readResult, readResult);
    const n3 = await notices(app);
    check('the mod\'s PostToolUse systemMessage is a notice', n3.some((t) => /Hooks fixture saw Read/.test(t)), n3);

    // 4. Settings → Developer → Hooks (the old 'hooks' page id lands there)
    await app.evaluate(`window.__oc_debug.settings.open('hooks')`);
    await app.waitFor(`document.querySelector('#sp-sec-developer.current') && document.querySelectorAll('#sp-sec-developer .sp-hook-run').length > 0 && document.querySelectorAll('#sp-sec-developer .sp-hook').length >= 5`, 10_000, 'the Hooks card');
    const page = await app.evaluate(`(() => {
      const sec = document.querySelector('#sp-sec-developer');
      return { events: [...sec.querySelectorAll('.sp-hook .sp-row-desc')].map((e) => e.textContent.split(' · ')[0]), hooks: [...sec.querySelectorAll('.sp-hook')].map((e) => e.innerText.replace(/\\s+/g, ' ')), runs: [...sec.querySelectorAll('.sp-hook-run')].map((e) => e.innerText.replace(/\\s+/g, ' ')) };
    })()`);
    const ORDER = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'];
    check('Settings → Developer → Hooks lists the hooks in event order, each naming its event', ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].every((g) => page.events.includes(g)) && page.events.every((e, i) => i === 0 || ORDER.indexOf(page.events[i - 1]) <= ORDER.indexOf(e)), page.events);
    check('… each with its matcher, type and file', page.hooks.some((t) => /block-rm\.sh/.test(t) && /matcher Bash/.test(t) && /if Bash\(rm \*\)/.test(t) && /settings\.json/.test(t)), page.hooks);
    check('… and the mod\'s hooks with the mod\'s name as the source', page.hooks.some((t) => /Hooks fixture/.test(t) && /Mod/.test(t)), page.hooks);
    check('the recent runs: event, tool, exit code or decision, duration, first stderr line', page.runs.some((t) => /PreToolUse · Bash/.test(t) && /exit 2/.test(t) && /block/.test(t) && /Blocked: rm is not allowed/.test(t)) && page.runs.some((t) => /PreToolUse · Read/.test(t) && /ask/.test(t)), page.runs.slice(0, 6));
    await app.evaluate(`document.querySelector('#sp-sec-developer .sp-hooks-wrap')?.scrollIntoView({ block: 'start' })`).catch(() => undefined);
    // The dialog fades in: shoot it once it has
    await app.waitFor(`!document.querySelector('#settings').getAnimations({ subtree: true }).some((a) => a.playState === 'running')`, 3000, 'Settings to finish opening').catch(() => undefined);
    await sleep(300);
    await app.screenshot(path.join(SHOTS, 'settings-hooks-light.png'));
    await setTheme(app, 'dark');
    await sleep(400);
    await app.screenshot(path.join(SHOTS, 'settings-hooks-dark.png'));
    await setTheme(app, 'light');
    // The hooks are cards of Developer now: its scroller does not scroll sideways, and no hook or run (long paths)
    // spills out of its card. (A card head's icon button reaches 2 px past the section by design, into the padding.)
    const overflow = await app.evaluate(`(() => { const body = document.querySelector('#settings-body'); const cards = [...document.querySelectorAll('#sp-sec-developer .sp-hooks-wrap .sp-card')]; return { body: body.scrollWidth - body.clientWidth, cards: cards.map((c) => c.scrollWidth - c.clientWidth) }; })()`);
    check('the Hooks cards do not overflow sideways', overflow.body <= 0 && overflow.cards.length === 2 && overflow.cards.every((n) => n <= 0), overflow);
    // Clear: the trash button in the head of the Recent hook runs card
    await app.evaluate(`document.querySelector('.sp-hook-run').closest('.sp-card-group').querySelector('.sp-card-head button[aria-label="Clear the runs"]').click()`);
    await app.waitFor(`document.querySelectorAll('.sp-hook-run').length === 0`, 5_000, 'the runs to clear');
    check('Clear empties the recent runs, and their card hides', await app.evaluate(`[...document.querySelectorAll('#sp-sec-developer .sp-hooks-wrap .sp-card-group')].find((g) => /Recent hook runs/.test(g.querySelector('.sp-card-title')?.textContent || ''))?.hidden === true`));
    const errs = app.console.filter((l) => /^\[(error|exception)\]/.test(l) && !/favicon/.test(l));
    check('no renderer errors', errs.length === 0, errs.slice(0, 3));
  } catch (err) {
    check(`crashed: ${err && err.message}`, false, app.logs.slice(-15).join('\n'));
  } finally {
    await app.close();
  }
  console.log(`screenshots: ${SHOTS}`);
  process.exit(done() ? 1 : 0);
})();
