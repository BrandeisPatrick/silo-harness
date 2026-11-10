// Live check of downloads in the real app (hidden, a throwaway profile, the mock model), with browser.downloadsDir
// set to a temp folder: the user's own click on a download link (CDP into the page) saves the file at once under a
// sanitised name (and " (2)" the second time), and the tray at the right of the browser bar lists it; a download the
// agent starts pauses, stays out of the folder and shows the download bar; Allow completes it into the folder; Don't
// allow (a second file) cancels it and nothing is written; the list is kept across launches. The agent's downloads
// start with browser_eval (a click run in the page) and browser_navigate (straight to the file): browser_click sends
// synthetic mouse events, which a hidden window's view never receives. All three are stamped by the same code.
// Run: npm run build && node test/live/browser-downloads.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt } = require('./rig.js');
const { startSite } = require('./support/site.js');

const { check, done } = checker();

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const site = await startSite();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-browser-downloads-'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-downloads-dir-')));
  let app = await launch({ profile, mode: 'bypass', mock: true, config: { browser: { downloadsDir: dir } } });
  const dbg = () => app.evaluate('window.__oc_debug.mods.browser()');
  const list = () => app.evaluate(`oc.rpc('browser.downloads')`);
  const files = () => fs.readdirSync(dir).sort();
  const staging = path.join(profile, 'browser', 'pending-downloads');
  const stagedFiles = () => (fs.existsSync(staging) ? fs.readdirSync(staging, { recursive: true }).filter((f) => fs.statSync(path.join(staging, f)).isFile()) : []);
  const waitList = (fn, what) => app.waitFor(`(async () => { const l = await oc.rpc('browser.downloads'); return (${fn})(l); })()`, 15_000, what);
  // The user's click: their input on the tab (the hidden window's views receive no real input, so the app's live-test
  // hook stands in for the key press), then the click run in the page over CDP with a user gesture
  const userClick = async (ws, id) => {
    await app.evaluate(`oc.rpc('browser.liveTestUserInput')`);
    return evalAt(ws, `(document.getElementById(${JSON.stringify(id)}).click(), true)`);
  };
  const barAnswer = (label) => app.evaluate(`(() => { const b = [...document.querySelectorAll('#browser-bars .browser-ask.download button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);

  try {
    // ---------- The user's own downloads ----------
    // The user's own navigation (the URL bar's path): not an agent action
    await app.evaluate(`oc.rpc('browser.go', ${JSON.stringify(`${site.base}/downloads.html`)})`);
    const ws = await app.pageTarget(`${site.base}/downloads.html`);
    await app.waitFor(`(async () => (await oc.browser.state()).title === 'Downloads')()`, 10_000, 'the downloads page');
    check('setup: the tray button is hidden while there are no downloads', (await dbg()).safety.tray.shown === false);
    await userClick(ws, 'user-file');
    await waitList((l) => l.some((d) => d.state === 'completed'), 'the user\'s download to finish');
    let l = await list();
    check('a user click saves the file at once into the chosen folder, under a sanitised name (no leading dot)', l[0].filename === 'report.txt' && l[0].path === path.join(dir, 'report.txt') && fs.readFileSync(path.join(dir, 'report.txt'), 'utf8') === 'The quarterly report.\n', l[0]);
    check('… not as the agent\'s, and without asking', l[0].byAgent === false && l[0].asking === false && (await dbg()).safety.bars.length === 0, l[0]);
    check('… with its host, size and tab', l[0].host === site.host && l[0].total === 22 && l[0].received === 22 && l[0].tabId === (await dbg()).activeId, l[0]);
    await app.waitFor(`window.__oc_debug.mods.browser().safety.tray.shown`, 5000, 'the tray button');
    let tray = (await dbg()).safety.tray;
    check('the tray button shows at the right of the browser bar, with a dot for the finished download', tray.shown && tray.dot && (await app.evaluate(`document.querySelector('.browser-bar').lastElementChild.previousElementSibling.id`)) === 'downloads-btn', tray);
    await userClick(ws, 'user-file');
    await waitList((l) => l.filter((d) => d.state === 'completed').length === 2, 'the second download');
    check('the same name again is saved as "report (2).txt"', JSON.stringify(files()) === JSON.stringify(['report (2).txt', 'report.txt']), files());

    await app.click('#downloads-btn');
    await app.waitFor(`window.__oc_debug.mods.browser().safety.tray.open`, 5000, 'the tray to open');
    let d = await dbg();
    check('the tray opens a list: newest first, name, host and size', d.safety.tray.items.length === 2 && d.safety.tray.items[0].name === 'report (2).txt' && d.safety.tray.items[1].name === 'report.txt' && d.safety.tray.items[0].meta === `${site.host} · 22 B`, d.safety.tray.items);
    check('… with Open and Show in Finder, and Clear at the bottom', await app.evaluate(`(() => { const item = document.querySelector('#downloads-pop .dl-item'); const acts = [...item.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')); return JSON.stringify(acts) === '["Open","Show in Finder"]' && document.querySelector('#downloads-pop .dl-clear')?.textContent === 'Clear'; })()`));
    check('… the dot goes once it is opened, and the page hides under the popover', !d.safety.tray.dot && d.visible === false, { dot: d.safety.tray.dot, visible: d.visible });
    await app.screenshotOf(path.join(shots, 'downloads-tray.png'), '#side-pane');
    await app.key('Escape');
    await app.waitFor(`!window.__oc_debug.mods.browser().safety.tray.open`, 5000, 'the tray to close');
    check('Escape closes it and the page comes back', (await dbg()).visible === true);

    // ---------- The agent's download: Allow ----------
    let r = await app.callTool('browser_eval', { code: `document.getElementById('agent-file').click(); 'clicked'` });
    check('setup: the agent clicks the link (browser_eval)', /clicked/.test(r ?? ''), r);
    await app.waitFor(`window.__oc_debug.mods.browser().safety.bars.some((b) => b.kind === 'download')`, 10_000, 'the download bar');
    l = await list();
    const agent = l.find((x) => x.url.endsWith('/files/agent-report.txt'));
    check("the agent's download is the agent's, paused and asking", agent && agent.byAgent && !agent.fromPage && agent.asking && agent.state === 'paused' && agent.path === '', agent);
    check('… nothing of it is in the folder', !files().some((f) => f.startsWith('agent-report')), files());
    let bar = (await dbg()).safety.bars.find((b) => b.kind === 'download');
    check('the download bar asks, naming the file, its size and the site', bar && bar.text === `The agent started a download: agent-report.txt (28 B) from ${site.host}` && JSON.stringify(bar.buttons) === JSON.stringify(['Allow', "Don't allow"]), bar);
    await app.screenshotOf(path.join(shots, 'download-bar.png'), '#side-pane');
    check('Allow', await barAnswer('Allow'));
    await waitList((l) => l.some((d) => d.url.endsWith('/agent-report.txt') && d.state === 'completed'), 'the agent\'s download to complete');
    l = await list();
    const allowed = l.find((x) => x.url.endsWith('/files/agent-report.txt'));
    check('… completes it into the folder', allowed.path === path.join(dir, 'agent-report.txt') && fs.readFileSync(allowed.path, 'utf8') === 'A report the agent fetched.\n' && !allowed.asking, allowed);
    check('… the bar goes and nothing is left in the staging folder', (await dbg()).safety.bars.length === 0 && stagedFiles().length === 0, stagedFiles());

    // ---------- The agent's download: Don't allow ----------
    await sleep(2200);
    r = await app.callTool('browser_navigate', { url: `${site.base}/files/agent-notes.txt` });
    await app.waitFor(`window.__oc_debug.mods.browser().safety.bars.some((b) => b.kind === 'download' && /agent-notes/.test(b.text))`, 10_000, 'the second download bar');
    check('a download browser_navigate starts asks too', ((await list()).find((x) => x.url.endsWith('/agent-notes.txt')) ?? {}).asking === true);
    check("Don't allow", await barAnswer("Don't allow"));
    await app.waitFor(`(async () => !(await oc.rpc('browser.downloads')).some((d) => d.url.endsWith('/agent-notes.txt')))()`, 10_000, 'the denied download to go');
    await sleep(500);
    check("… cancels it: nothing is written, in the folder or the staging folder, and it leaves the list", !files().some((f) => f.startsWith('agent-notes')) && stagedFiles().length === 0 && !(await list()).some((x) => x.url.endsWith('/agent-notes.txt')), { files: files(), staged: stagedFiles() });
    check('… and the bar goes', (await dbg()).safety.bars.length === 0);

    // ---------- Kept across launches; Clear ----------
    await app.close();
    app = await app.relaunch();
    l = await list();
    check('the list is kept across launches (names, never contents)', l.length === 3 && l.every((x) => x.state === 'completed') && JSON.stringify(l.map((x) => x.filename)) === JSON.stringify(['agent-report.txt', 'report (2).txt', 'report.txt']), l.map((x) => `${x.filename}:${x.state}`));
    const onDisk = fs.readFileSync(path.join(profile, 'browser', 'downloads.json'), 'utf8');
    check('… downloads.json holds no file contents', !onDisk.includes('quarterly report.') && !onDisk.includes('agent fetched'));
    l = await app.evaluate(`oc.rpc('browser.downloadAction', '', 'clear')`);
    check('Clear empties the list, and the files stay', l.length === 0 && files().length === 3, files());
  } finally {
    await app.close();
    site.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
