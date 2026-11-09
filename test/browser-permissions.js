// The permission bar's policy, headless (src/main/browser/permissions.ts): which requests are free, refused or asked;
// the bar's three answers (this time, every time, Don't allow) and how long each holds; the saved answers' file; a
// request waiting while its tab is in the background; a popup's request belonging to the tab that opened it; and that
// no tool can answer. The same in the real app: test/live/browser-permissions.js.
// Run: npm run build && node test/browser-permissions.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const perms = require(path.join(projectDir, 'dist/main/browser/permissions.js'));
const { check, done } = require('./support/check.js');

const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---------- 1. Words ----------
  check('sites are named by host', perms.siteName('https://www.example.com/a?b') === 'www.example.com' && perms.siteName('http://127.0.0.1:8123/x') === '127.0.0.1:8123');
  check('a local file and an artifact are named as such', perms.siteName('file:///Users/a/page.html') === 'The local file page.html' && perms.siteName('artifact://view/s/a') === 'This artifact');
  check('answers are kept per origin', perms.siteKey('https://example.com/a') === perms.siteKey('https://example.com/b') && perms.siteKey('https://example.com') !== perms.siteKey('https://example.org') && perms.siteKey('https://example.com') !== perms.siteKey('http://example.com'));
  check('camera and microphone are named per request', perms.permissionPhrase('media', { mediaTypes: ['video', 'audio'] }) === 'use your camera and microphone' && perms.permissionPhrase('media', { mediaTypes: ['audio'] }) === 'use your microphone' && perms.permissionPhrase('media', { mediaTypes: ['video'] }) === 'use your camera');
  check('location, notifications and the clipboard have plain names', perms.permissionPhrase('geolocation') === 'know your location' && perms.permissionPhrase('notifications') === 'show notifications' && /clipboard/.test(perms.permissionPhrase('clipboard-read')));
  check('opening another app names the link', perms.permissionPhrase('openExternal', { externalURL: 'mailto:a@b.c' }) === 'open an email link in your mail app' && perms.permissionPhrase('openExternal', { externalURL: 'zoommtg://x' }) === 'open a "zoommtg:" link in another app');
  check('a camera-and-microphone request is two capabilities, a link one per scheme', JSON.stringify(perms.capabilities('media', { mediaTypes: ['video', 'audio'] })) === '["camera","microphone"]' && JSON.stringify(perms.capabilities('openExternal', { externalURL: 'zoommtg://x' })) === '["openExternal:zoommtg"]' && JSON.stringify(perms.capabilities('geolocation-approximate')) === '["geolocation"]');
  check('Settings names the capabilities', perms.capabilityLabel('camera') === 'Camera' && perms.capabilityLabel('notifications') === 'Notifications' && perms.capabilityLabel('openExternal:mailto') === 'Opening mailto: links in other apps' && perms.capabilityLabel('something-new') === 'something-new');

  // ---------- 2. The policy table ----------
  const tab1 = { id: 11, getURL: () => 'https://cam.example/room' };
  const tab2 = { id: 12, getURL: () => 'https://cam.example/other' };
  const tab3 = { id: 13, getURL: () => 'https://other.example/' };
  const popup = { id: 21, getURL: () => 'https://auth.example/popup' };
  const appWindow = { id: 1, getURL: () => 'file:///app/dist/renderer/index.html' };
  const tabs = new Map([[11, 'tab-1'], [12, 'tab-2'], [13, 'tab-3']]);
  const openers = new Map([[21, 11]]);
  const store = perms.memoryStore();
  let pushes = [];
  let ids = 0;
  const policy = perms.createPermissionPolicy({
    isPane: (wc) => !!wc && wc.id !== appWindow.id,
    tabOf: (wc) => (wc ? perms.ownerTabId(wc.id, { tabOf: (id) => tabs.get(id) ?? null, openerOf: (id) => openers.get(id) ?? null }) : null),
    store,
    onPending: (list) => pushes.push(list),
    newId: () => `req-${++ids}`,
  });
  const ask = (wc, permission, details = {}) => {
    let settled = null;
    const p = new Promise((resolve) => policy.request(wc, permission, resolve, { requestingUrl: wc.getURL(), isMainFrame: true, ...details })).then((v) => (settled = v));
    return { p, settled: () => settled };
  };
  const answerLast = (how) => policy.answer(policy.pending().at(-1).id, how);

  check("the app's own window keeps every permission without a question", (await ask(appWindow, 'media', { mediaTypes: ['video', 'audio'] }).p) === true && (await ask(appWindow, 'notifications').p) === true && policy.pending().length === 0);
  check('… and its checks pass as before', policy.check(appWindow, 'notifications', 'file://', {}) === true && policy.check(null, 'media', 'file://', {}) === true);
  check('full screen and clipboard writes are allowed in the pane without a question', (await ask(tab1, 'fullscreen').p) === true && (await ask(tab1, 'clipboard-sanitized-write').p) === true && policy.pending().length === 0);
  check('… and their checks pass', policy.check(tab1, 'clipboard-sanitized-write', 'https://cam.example', {}) === true);
  check('USB, HID and serial devices are refused without a question', (await ask(tab1, 'usb').p) === false && (await ask(tab1, 'hid').p) === false && (await ask(tab1, 'serial').p) === false && policy.pending().length === 0 && policy.check(tab1, 'hid', 'https://cam.example', {}) === false);
  check('an undecided check is no, and never asks', policy.check(tab1, 'media', 'https://cam.example', { mediaType: 'video' }) === false && policy.pending().length === 0 && pushes.length === 0);

  // ---------- 3. The bar's answers ----------
  const c1 = ask(tab1, 'media', { mediaTypes: ['video', 'audio'] });
  const c2 = ask(tab1, 'media', { mediaTypes: ['audio', 'video'] });
  await tick();
  let pending = policy.pending();
  check('a camera request waits on the bar, once even when the page asks twice at once', pending.length === 1 && c1.settled() === null && c2.settled() === null, pending);
  check('… with an id, its tab, the site, the words and the page', pending[0].id === 'req-1' && pending[0].tabId === 'tab-1' && pending[0].site === 'cam.example' && pending[0].phrase === 'use your camera and microphone' && pending[0].permission === 'media' && pending[0].url === 'https://cam.example/room', pending[0]);
  check('… and the window was told', pushes.length === 1 && pushes[0].length === 1 && pushes[0][0].id === 'req-1');
  const plain = perms.createPermissionPolicy({ isPane: () => true, tabOf: () => 't', store: perms.memoryStore(), onPending: () => {} });
  plain.request(tab1, 'notifications', () => {}, {});
  plain.request(tab2, 'midi', () => {}, {});
  const uuids = plain.pending().map((r) => r.id);
  check('the ids are random UUIDs', uuids.length === 2 && uuids[0] !== uuids[1] && uuids.every((u) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u)), uuids);
  plain.dropAll();
  check('an answer to an unknown id, or an unknown answer, does nothing', policy.answer('nope', 'always') === false && policy.answer('req-1', 'yes') === false && policy.pending().length === 1);
  check("Don't allow answers both", policy.answer('req-1', 'deny') === true && (await c1.p) === false && (await c2.p) === false && policy.pending().length === 0);
  check('… is saved for the site, per capability', store.get('https://cam.example', 'camera') === 'deny' && store.get('https://cam.example', 'microphone') === 'deny');
  check('… so the next request is refused without a question, from any tab of the site', (await ask(tab2, 'media', { mediaTypes: ['video'] }).p) === false && policy.pending().length === 0);
  check('… and the check says no', policy.check(tab1, 'media', 'https://cam.example', { mediaType: 'audio' }) === false);

  const n1 = ask(tab1, 'notifications');
  await tick();
  check('Allow every time grants it', answerLast('always') && (await n1.p) === true && store.get('https://cam.example', 'notifications') === 'allow');
  check('… saved: no question from another tab of the site, and the check says yes', (await ask(tab2, 'notifications').p) === true && policy.pending().length === 0 && policy.check(tab2, 'notifications', 'https://cam.example', {}) === true);
  const n3 = ask(tab3, 'notifications');
  await tick();
  check('another site is asked on its own', policy.pending().length === 1 && policy.pending()[0].site === 'other.example');
  answerLast('always');
  await n3.p;

  const m1 = ask(tab3, 'media', { mediaTypes: ['audio'] });
  await tick();
  answerLast('always');
  check('allowing the microphone alone does not allow the camera later', (await m1.p) === true);
  const m2 = ask(tab3, 'media', { mediaTypes: ['video'] });
  await tick();
  check('… the camera is asked for', policy.pending().length === 1 && policy.pending()[0].phrase === 'use your camera');
  answerLast('always');
  check('… and both together need no question now', (await m2.p) === true && (await ask(tab3, 'media', { mediaTypes: ['video', 'audio'] }).p) === true && policy.pending().length === 0);

  const l1 = ask(tab3, 'openExternal', { externalURL: 'mailto:x@y.z' });
  await tick();
  check('a link to another app carries its target', policy.pending()[0]?.target === 'mailto:x@y.z' && policy.pending()[0]?.phrase === 'open an email link in your mail app');
  answerLast('always');
  await l1.p;
  const l2 = ask(tab3, 'openExternal', { externalURL: 'zoommtg://join' });
  await tick();
  check('links that open other apps are asked per scheme', policy.pending().length === 1);
  answerLast('deny');
  check('… and answered per scheme', (await l2.p) === false && (await ask(tab3, 'openExternal', { externalURL: 'mailto:q@r.s' }).p) === true);

  // Allow this time: for that tab, until it leaves the site
  const g1 = ask(tab1, 'geolocation');
  await tick();
  check('Allow this time grants it', answerLast('once') && (await g1.p) === true && store.get('https://cam.example', 'geolocation') === undefined);
  check('… for that tab: no question again, and the check says yes', (await ask(tab1, 'geolocation').p) === true && policy.pending().length === 0 && policy.check(tab1, 'geolocation', 'https://cam.example', {}) === true);
  check('… not for another tab of the site', policy.check(tab2, 'geolocation', 'https://cam.example', {}) === false);
  policy.tabNavigated('tab-1', 'https://cam.example/another-page', 999);
  check('… it holds while the tab stays on the site', policy.check(tab1, 'geolocation', 'https://cam.example', {}) === true);
  policy.tabNavigated('tab-1', 'https://elsewhere.example/', 999);
  policy.tabNavigated('tab-1', 'https://cam.example/room', 999);
  check('… and ends when the tab leaves the site, even when it comes back', policy.check(tab1, 'geolocation', 'https://cam.example', {}) === false);
  const g2 = ask(tab1, 'geolocation');
  await tick();
  check('… so the next request asks again', policy.pending().length === 1 && g2.settled() === null);
  answerLast('deny');
  await g2.p;

  // ---------- 4. A tab in the background, a page that goes, a tab that closes ----------
  const b1 = ask(tab2, 'clipboard-read');
  await tick();
  check('a request from a tab in the background waits for it: the active tab shows no bar', policy.current('tab-1') === null && policy.pending().length === 1 && b1.settled() === null);
  check('… and the tab shows it once it is active', policy.current('tab-2')?.phrase === 'see text and images you copy to the clipboard');
  const b2 = ask(tab1, 'clipboard-read');
  await tick();
  check('each tab shows its own, the oldest first', policy.current('tab-1')?.tabId === 'tab-1' && policy.current('tab-2')?.tabId === 'tab-2' && policy.pending().length === 2);
  policy.answer(policy.current('tab-1').id, 'always');
  check('an answer that settles another tab\'s request settles it too', (await b2.p) === true && (await b1.p) === true && policy.pending().length === 0);

  const d1 = ask(tab2, 'midi');
  const dPopup = ask(popup, 'midi');
  await tick();
  check('a popup\'s request belongs to the tab that opened it', policy.pending().length === 2 && policy.pending()[1].tabId === 'tab-1' && policy.pending()[1].site === 'auth.example', policy.pending());
  policy.tabNavigated('tab-2', 'https://cam.example/next', tab2.id);
  check("a tab's new page takes its old page's question away (refused)", (await d1.p) === false && policy.pending().length === 1);
  policy.tabNavigated('tab-1', 'https://cam.example/next', tab1.id);
  check("… a popup's question stays when its tab navigates", policy.pending().length === 1 && dPopup.settled() === null);
  policy.tabClosed('tab-1');
  check('a tab that closes refuses its questions (its popups\' too)', (await dPopup.p) === false && policy.pending().length === 0);
  const gone = ask(popup, 'idle-detection');
  await tick();
  policy.contentsGone(popup.id);
  check('a page that goes (a popup closing) takes its questions with it (refused)', (await gone.p) === false && policy.pending().length === 0);
  const w1 = ask(tab3, 'idle-detection');
  await tick();
  policy.dropAll();
  check('the window going refuses every question', (await w1.p) === false && policy.pending().length === 0);
  const orphan = { id: 99, getURL: () => 'https://nowhere.example/' };
  check('contents that belong to no tab are refused without a question', (await ask(orphan, 'notifications').p) === false && policy.pending().length === 0);

  // ---------- 5. Whose request: popups ----------
  const owners = new Map([[1, 'tab-a'], [2, 'tab-b']]);
  const openedBy = new Map([[10, 1], [11, 10], [20, 30], [30, 20]]);
  const look = { tabOf: (id) => owners.get(id) ?? null, openerOf: (id) => openedBy.get(id) ?? null };
  check("a tab's own contents are that tab", perms.ownerTabId(2, look) === 'tab-b');
  check('a popup is the tab that opened it', perms.ownerTabId(10, look) === 'tab-a');
  check("a popup's popup too", perms.ownerTabId(11, look) === 'tab-a');
  check('contents with no tab behind them are nobody\'s, and an opener loop ends', perms.ownerTabId(5, look) === null && perms.ownerTabId(20, look) === null);

  // ---------- 6. The saved answers: the file, Settings ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-perms-'));
  const file = perms.permissionsFile(dir);
  check('the file is userData/browser/permissions.json', file === path.join(dir, 'browser', 'permissions.json'));
  let fstore = perms.fileStore(file);
  check('no file yet: an empty store', fstore.entries().length === 0);
  fstore.set('https://a.example', 'camera', 'allow');
  fstore.set('https://a.example', 'microphone', 'deny');
  fstore.set('http://127.0.0.1:8080', 'notifications', 'allow');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('answers are written as { site: { capability: allow | deny } }', JSON.stringify(onDisk) === JSON.stringify({ 'https://a.example': { camera: 'allow', microphone: 'deny' }, 'http://127.0.0.1:8080': { notifications: 'allow' } }), onDisk);
  fstore = perms.fileStore(file);
  check('… and read back by the next launch', fstore.get('https://a.example', 'camera') === 'allow' && fstore.get('https://a.example', 'microphone') === 'deny' && fstore.get('http://127.0.0.1:8080', 'notifications') === 'allow');
  const saved = perms.createPermissionPolicy({ isPane: () => true, tabOf: () => 't', store: fstore, onPending: () => {} });
  const list = saved.saved();
  check('Settings lists them by site, with words', list.length === 3 && list[0].site === '127.0.0.1:8080' && list[0].label === 'Notifications' && list[0].decision === 'allow' && list.some((p) => p.site === 'a.example' && p.label === 'Microphone' && p.decision === 'deny' && p.key === 'https://a.example'), list);
  check('Reset forgets one answer', saved.reset('https://a.example', 'microphone').length === 2 && perms.fileStore(file).get('https://a.example', 'microphone') === undefined);
  check('… or a whole site', saved.reset('https://a.example').length === 1 && !('https://a.example' in JSON.parse(fs.readFileSync(file, 'utf8'))));
  check('… or everything', saved.reset().length === 0 && JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) === '{}');
  fs.writeFileSync(file, '{ not json');
  check('a broken file is an empty store', perms.fileStore(file).entries().length === 0);
  check('only well-formed entries are read', JSON.stringify(perms.cleanStoreData({ 'https://x': { camera: 'allow', mic: 'maybe', n: 1 }, bad: 'allow', list: ['deny'], '': { camera: 'deny' } })) === '{"https://x":{"camera":"allow"}}');
  fs.rmSync(dir, { recursive: true, force: true });

  // ---------- 7. No tool can answer ----------
  // The answers are browser.* RPC methods the window calls; the tools never reach the policy, the store or the proceed set.
  const toolsDir = path.join(projectDir, 'dist/main/tools');
  const reach = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js')).filter((f) => /answerPermission|permissionPolicy|configurePermissions|certProceed|proceeded\.add|downloadAction/.test(fs.readFileSync(path.join(toolsDir, f), 'utf8')));
  check('no tool reaches the permission answers, the certificate override or the download answers', reach.length === 0, reach);

  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
