// Live: Settings → History → Delete all sessions and Settings → Mods → Delete all custom mods in the real window,
// through the rig, on a throwaway profile with the mock model (no key needed). Three sessions (one running) and two
// mods of yours (a panel turned on, a theme in use) are made; each row is clicked, its confirmation read and
// confirmed, and the result checked: the sidebar, the fresh session, the trash, the stats and the search; the folders
// gone, the rail, the config and the Mods grid. The mod folders go to the macOS Trash, the real one, since that is
// what the row does; they are two tiny folders of the throwaway profile.
// Run: npm run build && node test/live/settings-delete.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const js = (v) => JSON.stringify(v);
const TINT = '#2b6cb0';

function writeMod(root, id, manifest, files) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), js({ protocol: 1, id, version: '0.1.0', ...manifest }));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
}
const page = (body) => `<!doctype html>\n<link rel="stylesheet" href="/@harness/harness.css">\n${body}\n<script src="/@harness/harness.js"></script>`;

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-profile-'));
  const userMods = path.join(profile, 'home-config', 'mods');
  writeMod(userMods, 'hello', { name: 'Hello', contributes: { views: [{ id: 'main', title: 'Hello', entry: 'panel.html', seat: 'rail', order: 15 }] } }, { 'panel.html': page('<div class="h-row"><span class="h-label">Hello</span></div>') });
  writeMod(userMods, 'tint', { name: 'Tint', contributes: { styles: ['theme.css'] } }, { 'theme.css': `:root { --accent: ${TINT}; }` });

  const app = await launch({ profile, mock: true, mode: 'bypass', config: { theme: 'light' } });
  const ev = app.evaluate;
  const rpc = (m, ...a) => ev(`window.oc.rpc(${js(m)}, ...${js(a)})`);
  const cfg = () => ev('window.oc.getConfig()');
  const current = () => ev('window.oc.sessions.current()');
  const openSettings = async (section) => {
    await ev(`window.__oc_debug.settings.open(${js(section)})`);
    await sleep(500);
  };
  const closeSettings = async () => {
    await ev(`document.querySelector('#settings').open && document.querySelector('#settings-close').click()`);
    await sleep(300);
  };
  const settingsOpen = () => ev(`document.querySelector('#settings').open`);
  const confirmOpen = () => ev(`document.querySelector('#confirm-dialog').open`);
  const confirmText = () => app.text('#confirm-dialog');
  const enabled = (selector) => ev(`(() => { const b = document.querySelector(${js(selector)}); return Boolean(b && b.offsetParent && !b.disabled); })()`);
  const disabled = (selector) => ev(`(() => { const b = document.querySelector(${js(selector)}); return Boolean(b && b.disabled); })()`);
  const accent = () => ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  // In the hidden window a capture right after Settings changed can come back stale: a tiny capture first draws a fresh frame.
  const shotOf = async (name, selector) => {
    await app.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
    return app.screenshotOf(path.join(shots, `${name}.png`), selector);
  };
  const newSession = async () => {
    const before = (await current()).id;
    await app.click('#new-session-btn');
    await app.waitFor(`window.oc.sessions.current().then((m) => m.id !== ${js(before)})`, 5000, 'a new session');
    await sleep(200);
  };
  try {
    // ---------- Sessions: two that finished, one that is running ----------
    await app.send('First session says hello');
    await app.waitIdle();
    await newSession();
    await app.send('Second session is about copper kettles');
    await app.waitIdle();
    await newSession();
    app.mock.state.replies.push({ content: 'a slow reply', delayMs: 60_000 });
    await app.send('Third session takes its time');
    await app.waitFor(`(() => { const s = document.querySelector('#status-line'); return Boolean(s && !s.hidden); })()`, 10_000, 'the run to start');
    const third = (await current()).id;
    await app.waitFor(`window.oc.sessions.list().then((l) => l.length === 3)`, 10_000, 'three listed sessions');
    const list0 = await ev('window.oc.sessions.list()');
    check('three sessions are listed, one running', list0.length === 3 && list0.filter((m) => m.status && m.status.running).length === 1, list0.map((m) => [m.title, m.status]));
    check('the sidebar shows the three', (await app.count('.session-item')) === 3 && (await app.exists('.session-item.running')));

    // ---------- Mods: a panel of yours turned on, a theme of yours in use ----------
    await app.waitFor(`window.oc.rpc('mods.list').then((l) => l.some((m) => m.key === 'hello') && l.some((m) => m.key === 'tint'))`, 10_000, 'the mods of yours to be listed');
    await rpc('mods.setEnabled', 'hello', true);
    await app.waitFor(`window.__oc_debug.mods.views().some((v) => v.key === 'hello/main' && v.hello)`, 10_000, 'the Hello panel in the rail');
    await rpc('mods.use', { theme: 'tint' }, { approve: true });
    await app.waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === ${js(TINT)}`, 5000, 'the theme to apply');
    check('the Hello panel is in the rail and the Tint theme applies', (await ev(`window.__oc_debug.mods.views().some((v) => v.key === 'hello/main')`)) && (await accent()) === TINT);

    // ---------- Settings → History → Delete all sessions ----------
    await openSettings('history');
    await app.waitFor(`(() => { const b = document.querySelector('#sp-row-history-delete-all button'); return Boolean(b && !b.disabled); })()`, 5000, 'the Delete all sessions button');
    const storedBefore = await app.text('#sp-row-history-stats .sp-row-desc');
    check('Stored says three sessions', /^3 sessions/.test(storedBefore || ''), storedBefore);
    await shotOf('delete-1-history', '#settings');
    await app.click('#sp-row-history-delete-all button');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000, 'the confirmation');
    const text1 = (await confirmText()) || '';
    check('the confirmation says how many there are, where they go and that running ones are stopped', /Delete all sessions\?/.test(text1) && /3 sessions/.test(text1) && /trash/.test(text1) && /30 days/.test(text1) && /running session is stopped/i.test(text1), text1);
    await app.screenshot(path.join(shots, 'delete-2-confirm-sessions.png'));
    await app.click('#confirm-ok');
    await app.waitFor(`window.oc.sessions.list().then((l) => l.length === 0)`, 10_000, 'the sessions to go');
    await app.waitFor(`window.oc.sessions.current().then((m) => m.id !== ${js(third)} && m.messageCount === 0)`, 10_000, 'a fresh session');
    const fresh = await current();
    await app.waitFor(`document.querySelector('.session-item.active')?.dataset.id === ${js(fresh.id)}`, 10_000, 'the fresh session in the sidebar');
    await sleep(300);
    const rows = await ev(`[...document.querySelectorAll('.session-item')].map((e) => e.dataset.id)`);
    check('the sidebar lists only the fresh session', rows.length === 1 && rows[0] === fresh.id, rows);
    check('the conversation is empty', await ev(`!document.querySelector('#empty-state').hidden && document.querySelectorAll('#messages .msg').length === 0`));
    check('nothing runs any more', await ev(`document.querySelector('#status-line').hidden && !document.querySelector('.session-item.running')`));
    const trash = await rpc('history.trash');
    check('the three sessions are in the trash, the running one too', trash.length === 3 && trash.some((e) => /takes its time/.test(e.title)) && trash.every((e) => e.messageCount >= 1), trash.map((e) => [e.title, e.messageCount]));
    const stats = await rpc('history.stats');
    check('the stats agree', stats.sessions === 0 && stats.trash === 3, stats);
    const hits = await rpc('history.search', 'copper kettles', { includeTrash: true });
    const liveHits = await rpc('history.search', 'copper kettles');
    check('search finds them only in the trash', hits.length === 1 && hits[0].trashed === true && liveHits.length === 0, { hits, liveHits });
    const storedAfter = (await app.text('#sp-row-history-stats .sp-row-desc')) || '';
    check('Settings stayed open; Stored says none and three in the trash, with their rows', (await settingsOpen()) && /^0 sessions .* 3 in the trash/.test(storedAfter) && (await app.count('#sp-sec-history [id^="sp-row-trash-"]')) === 3, storedAfter);
    check('the button is disabled with nothing left to delete', await disabled('#sp-row-history-delete-all button'));
    await shotOf('delete-3-after-sessions', '#settings');

    // ---------- With Keep deleted sessions for Off: removed at once ----------
    await app.click('#sp-row-historyTrashDays input[value="0"]');
    await app.waitFor(`window.oc.getConfig().then((c) => c.historyTrashDays === 0)`, 5000, 'Off to save');
    await closeSettings();
    await app.send('Fourth session is gone at once');
    await app.waitIdle();
    const fourth = (await current()).id;
    await openSettings('history');
    await app.waitFor(`(() => { const b = document.querySelector('#sp-row-history-delete-all button'); return Boolean(b && !b.disabled); })()`, 5000, 'the button again');
    await app.click('#sp-row-history-delete-all button');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000, 'the confirmation');
    const text2 = (await confirmText()) || '';
    check('with Off the confirmation says it is for good', /1 session /.test(text2) && /removed for good/.test(text2) && /cannot be undone/.test(text2), text2);
    await app.click('#confirm-ok');
    await app.waitFor(`window.oc.sessions.current().then((m) => m.id !== ${js(fourth)})`, 10_000, 'another fresh session');
    await sleep(300);
    check('it is not in the trash and its files are gone', (await rpc('history.trash')).length === 3 && !fs.existsSync(path.join(profile, 'sessions', `${fourth}.json`)) && !fs.existsSync(path.join(profile, 'history', `${fourth}.jsonl`)) && !fs.existsSync(path.join(profile, 'trash', fourth)));

    // ---------- Settings → Mods → Delete all custom mods ----------
    await openSettings('mods');
    await app.waitFor(`(() => { const b = document.querySelector('#sp-row-mods-remove-all button'); return Boolean(b && b.offsetParent && !b.disabled); })()`, 5000, 'the Delete all custom mods button');
    const rowDesc = (await app.text('#sp-row-mods-remove-all .sp-row-desc')) || '';
    check('the Hello card is under Yours and the row counts the two mods in the profile folder', (await app.exists('#sp-row-mod-hello')) && /your 2 mods/.test(rowDesc) && rowDesc.includes('home-config/mods'), rowDesc);
    await ev(`document.querySelector('#sp-row-mods-remove-all').scrollIntoView({ block: 'center' })`);
    await shotOf('delete-4-mods', '#settings');
    await app.click('#sp-row-mods-remove-all button');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 3000, 'the confirmation');
    const text3 = (await confirmText()) || '';
    check('the confirmation names them', /Delete all custom mods\?/.test(text3) && /Hello/.test(text3) && /Tint/.test(text3) && /2 mods/.test(text3) && /Trash/.test(text3) && /back to Default/.test(text3), text3);
    await app.screenshot(path.join(shots, 'delete-5-confirm-mods.png'));
    await app.click('#confirm-ok');
    await app.waitFor(`window.oc.rpc('mods.list').then((l) => !l.some((m) => m.scope === 'user'))`, 10_000, 'the mods of yours to go');
    await app.waitFor(`!window.__oc_debug.mods.views().some((v) => v.key === 'hello/main')`, 10_000, 'the Hello panel to leave the rail');
    await app.waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() !== ${js(TINT)}`, 5000, 'the theme to go');
    await sleep(300);
    check('the folders are gone from the profile', !fs.existsSync(path.join(userMods, 'hello')) && !fs.existsSync(path.join(userMods, 'tint')), fs.existsSync(userMods) ? fs.readdirSync(userMods) : 'no folder');
    const mcfg = (await cfg()).mods;
    check('the config forgot them and the theme is Default', !mcfg.enabled.hello && !(mcfg.approved || {}).tint && mcfg.layout.theme === null, { enabled: Object.keys(mcfg.enabled), approved: Object.keys(mcfg.approved || {}), theme: mcfg.layout.theme });
    check('the rail has no Hello panel and the accent is the app’s own', !(await ev(`window.__oc_debug.mods.views().some((v) => v.key === 'hello/main')`)) && (await accent()) !== TINT, await accent());
    const status = (await app.text('#sp-modpanel > .sp-inline-status')) || '';
    check('the Mods grid has no card of yours and the status says what happened', !(await app.exists('#sp-row-mod-hello')) && /Moved 2 mods to the Trash/.test(status), status);
    check('the button is disabled with nothing left to delete', (await disabled('#sp-row-mods-remove-all button')) && !(await enabled('#sp-row-mods-remove-all button')));
    await ev(`document.querySelector('#sp-row-mods-remove-all').scrollIntoView({ block: 'center' })`);
    await shotOf('delete-6-after-mods', '#settings');
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await app.close();
  }
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
